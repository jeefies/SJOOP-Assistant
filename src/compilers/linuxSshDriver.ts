import * as fs from 'fs';
import * as path from 'path';
import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import * as iconv from 'iconv-lite';
import { CompileResult, SingleRunResult, TestCase } from '../types';
import { compareBytesStrict } from '../judge/byteJudge';
import { createHostVerifier, quotePosixArgument, validateHostKeyFingerprint, validateOutputBaseName } from '../security/sshSecurity';
import { validateUploadSources } from '../security/uploadSources';

export interface SshConfig {
  host: string;
  port: number;
  studentId: string;
  privateKeyPath?: string;
  passphrase?: string;
  hostKeyFingerprint?: string;
  workspaceRoot?: string;
  remoteDir: string;
  flags: string[];
}

interface RemoteCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export class LinuxSshDriver {
  /** Validate security settings before reading a private key or prompting for its passphrase. */
  public static validateConnectionConfig(config: SshConfig): void {
    validateHostKeyFingerprint(config.hostKeyFingerprint);
    if (!config.privateKeyPath || !config.privateKeyPath.trim()) {
      throw new Error('请明确选择本次 SSH 连接使用的私钥文件；不会自动使用默认私钥。');
    }
    if (!fs.existsSync(config.privateKeyPath) || !fs.statSync(config.privateKeyPath).isFile()) {
      throw new Error('指定的私钥文件不存在或不是普通文件，请重新选择；不会改用其他私钥。');
    }
    if (!config.studentId || !config.studentId.trim()) {
      throw new Error('请输入学号！');
    }
  }

  private static getConnectConfig(config: SshConfig): ConnectConfig {
    this.validateConnectionConfig(config);
    const connConfig: ConnectConfig = {
      host: config.host || '10.80.42.230',
      port: config.port || 22,
      username: `u${config.studentId.trim().replace(/^u/i, '')}`,
      privateKey: fs.readFileSync(config.privateKeyPath!),
      // Do not set hostHash: the verifier hashes ssh2's raw public-key blob itself.
      hostVerifier: createHostVerifier(config.hostKeyFingerprint),
      readyTimeout: 6000,
    };
    if (config.passphrase) connConfig.passphrase = config.passphrase;
    return connConfig;
  }

  private static execCommand(conn: Client, command: string): Promise<RemoteCommandResult> {
    return new Promise((resolve, reject) => {
      const onClosed = () => reject(new Error('SSH 连接在远程命令结束前关闭。'));
      conn.once('close', onClosed);
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.removeListener('close', onClosed);
          return reject(err);
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        stream.on('data', (data: Buffer) => stdout.push(data));
        stream.stderr.on('data', (data: Buffer) => stderr.push(data));
        stream.on('error', (error: Error) => {
          conn.removeListener('close', onClosed);
          reject(error);
        });
        stream.once('close', (code: number | undefined) => {
          conn.removeListener('close', onClosed);
          resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? -1 });
        });
      });
    });
  }

  public static testConnection(config: SshConfig): Promise<{ success: boolean; message: string }> {
    return new Promise((resolve) => {
      let connConfig: ConnectConfig;
      try {
        connConfig = this.getConnectConfig(config);
      } catch (err: any) {
        return resolve({ success: false, message: err.message });
      }
      const conn = new Client();
      let finished = false;
      const finish = (result: { success: boolean; message: string }) => {
        if (finished) return;
        finished = true;
        clearTimeout(safetyTimer);
        conn.end();
        resolve(result);
      };
      const address = `${connConfig.host}:${connConfig.port}`;
      const safetyTimer = setTimeout(() => finish({
        success: false,
        message: `连接 ${address} 超时！请检查校园网/同济 VPN 是否已连通。`,
      }), 7000);
      conn.once('ready', () => {
        this.execCommand(conn, 'uname -m && (gcc --version 2>/dev/null || c++ --version 2>/dev/null) | head -n 1')
          .then((result) => {
            const info = iconv.decode(result.stdout, 'gb18030').trim().replace(/\r?\n/g, ' | ');
            finish({
              success: true,
              message: `成功连通 ${address} (${connConfig.username})！\n服务器信息: ${info || '查询信息失败'}`,
            });
          })
          .catch((err: Error) => finish({ success: true, message: `连接 ${address} 成功 (用户: ${connConfig.username})！但查询信息失败: ${err.message}` }));
      });
      conn.on('error', (err: Error) => finish({ success: false, message: `SSH 连接 ${address} 出错: ${err.message}` }));
      conn.once('close', () => finish({ success: false, message: `SSH 连接 ${address} 已关闭。` }));
      try {
        conn.connect(connConfig);
      } catch (err: any) {
        finish({ success: false, message: `SSH 连接 ${address} 启动失败: ${err.message}` });
      }
    });
  }

  private static uploadFile(sftp: SFTPWrapper, conn: Client, remotePath: string, content: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);
      const onClosed = () => reject(new Error('SSH 连接在文件上传结束前关闭。'));
      conn.once('close', onClosed);
      stream.on('error', (err: Error) => {
        conn.removeListener('close', onClosed);
        reject(new Error(`上传 ${path.posix.basename(remotePath)} 失败: ${err.message}`));
      });
      stream.once('close', () => {
        conn.removeListener('close', onClosed);
        resolve();
      });
      stream.end(content);
    });
  }

  private static runTestCase(
    conn: Client, remoteBase: string, remoteBin: string, tc: TestCase, timeoutMs: number,
    normalizeNewlines: boolean, stripTrailingNewlines: boolean
  ): Promise<SingleRunResult> {
    return new Promise((resolve) => {
      const started = Date.now();
      // Every variable value is one quoted shell argument. Source filenames are prefixed with ./ below.
      const command = `cd ${quotePosixArgument(remoteBase)} && { _t0=$(date +%s%N 2>/dev/null || date +%s); ${quotePosixArgument(remoteBin)}; _rc=$?; _t1=$(date +%s%N 2>/dev/null || date +%s); echo "__SJOOP_TIME__:$_t0:$_t1:$_rc" >&2; exit $_rc; }`;
      const failure = (message: string): SingleRunResult => ({
        testCaseId: tc.id, compiler: 'linux', status: 'RE', timeMs: Date.now() - started,
        exitCode: -1, stdout: '', stderr: message,
      });
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onClosed = () => finish(failure('SSH 连接在测试结束前关闭。'));
      const finish = (result: SingleRunResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        conn.removeListener('close', onClosed);
        resolve(result);
      };
      conn.once('close', onClosed);
      conn.exec(command, (err, stream) => {
        if (err) return finish(failure(`执行错误: ${err.message}`));
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let killed = false;
        timer = setTimeout(() => {
          killed = true;
          stream.destroy();
          finish({ ...failure('程序运行超时 (Time Limit Exceeded)'), status: 'TLE', stdout: iconv.decode(Buffer.concat(stdout), 'gb18030') });
        }, timeoutMs);
        stream.on('data', (data: Buffer) => stdout.push(data));
        stream.stderr.on('data', (data: Buffer) => stderr.push(data));
        stream.on('error', (error: Error) => finish(failure(`执行错误: ${error.message}`)));
        stream.once('close', (code: number | undefined) => {
          if (killed) return;
          const actual = Buffer.concat(stdout);
          const output = iconv.decode(actual, 'gb18030');
          const parsed = this.parseExecutionTiming(iconv.decode(Buffer.concat(stderr), 'gb18030'), Date.now() - started, code ?? -1);
          if (parsed.exitCode !== 0) {
            return finish({ ...failure(parsed.stderr || `程序异常退出，退出码: ${parsed.exitCode}`), timeMs: parsed.timeMs, exitCode: parsed.exitCode, stdout: output });
          }
          const diff = compareBytesStrict(actual, iconv.encode(tc.expectedOutput, 'gb18030'), 'gb18030', normalizeNewlines, stripTrailingNewlines);
          finish({ testCaseId: tc.id, compiler: 'linux', status: diff.matched ? 'AC' : 'WA', timeMs: parsed.timeMs, exitCode: 0, stdout: output, stderr: parsed.stderr, byteDiff: diff });
        });
        stream.end(iconv.encode(tc.input, 'gb18030'));
      });
    });
  }

  public static async compileAndRun(
    config: SshConfig, sources: string[], outputBaseName: string, testCases: TestCase[],
    timeoutMs: number = 5000, strictDiff: boolean = true,
    normalizeNewlines: boolean = true, stripTrailingNewlines: boolean = true
  ): Promise<{ compileResult: CompileResult; runResults: SingleRunResult[] }> {
    const startTime = Date.now();
    const failure = (error: any) => ({
      compileResult: { compiler: 'linux' as const, success: false, timeMs: Date.now() - startTime, errorMessage: error.message || String(error) },
      runResults: [] as SingleRunResult[],
    });
    let connConfig: ConnectConfig;
    let uploads: ReturnType<typeof validateUploadSources>;
    try {
      // Snapshot only validated source/header files before accessing the private key or starting SSH.
      uploads = validateUploadSources(sources, config.workspaceRoot);
      validateOutputBaseName(outputBaseName);
      for (const flag of config.flags || []) quotePosixArgument(flag);
      quotePosixArgument(config.remoteDir);
      this.validateConnectionConfig(config);
      const keyPath = fs.realpathSync(config.privateKeyPath!);
      const samePath = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
      if (uploads.some((upload) => samePath(upload.path) === samePath(keyPath))) {
        throw new Error('不能将 SSH 私钥作为源码上传。');
      }
      connConfig = this.getConnectConfig(config);
    } catch (err) {
      return failure(err);
    }
    return new Promise((resolve) => {
      const conn = new Client();
      let finished = false;
      const finish = (result: { compileResult: CompileResult; runResults: SingleRunResult[] }) => {
        if (finished) return;
        finished = true;
        conn.end();
        resolve(result);
      };
      conn.on('error', (err: Error) => finish(failure(new Error(`SSH 连接 ${connConfig.host}:${connConfig.port} 出错: ${err.message}`))));
      conn.once('close', () => finish(failure(new Error('SSH 连接在任务结束前关闭。'))));
      conn.once('ready', () => {
        (async () => {
          const sftp = await new Promise<SFTPWrapper>((res, rej) => {
            const onClosed = () => rej(new Error('SSH 连接在开启 SFTP 前关闭。'));
            conn.once('close', onClosed);
            conn.sftp((err, session) => {
              conn.removeListener('close', onClosed);
              if (err) rej(new Error(`开启 SFTP 失败: ${err.message}`));
              else res(session);
            });
          });
          const homeResult = await this.execCommand(conn, 'printf "%s" "$HOME"');
          const remoteHome = homeResult.stdout.toString().trim();
          if (homeResult.exitCode !== 0 || !remoteHome.startsWith('/')) throw new Error('无法确定远程主目录。');
          let rawDir = (config.remoteDir || '~/sjoop_tmp').trim();
          if (rawDir === '~') rawDir = remoteHome;
          else if (rawDir.startsWith('~/')) rawDir = path.posix.join(remoteHome, rawDir.slice(2));
          else if (!rawDir.startsWith('/')) rawDir = path.posix.join(remoteHome, rawDir);
          const remoteBase = path.posix.join(rawDir, outputBaseName);
          const mkdir = await this.execCommand(conn, `mkdir -p -- ${quotePosixArgument(remoteBase)}`);
          if (mkdir.exitCode !== 0) throw new Error(`创建远程目录失败: ${iconv.decode(mkdir.stderr, 'gb18030').trim() || mkdir.exitCode}`);
          for (const upload of uploads) {
            await this.uploadFile(sftp, conn, path.posix.join(remoteBase, upload.fileName), upload.content);
          }
          const cppFiles = uploads.filter((upload) => /\.(cpp|c|cc|cxx)$/i.test(upload.fileName));
          const defaultFlags = ['-Wall', '-std=c++20', '-finput-charset=GB18030', '-fexec-charset=GB18030'];
          const flags = config.flags && config.flags.length > 0 ? config.flags : defaultFlags;
          const remoteBin = path.posix.join(remoteBase, `${outputBaseName}_linux`);
          const argumentsQuoted = [...flags, '-o', remoteBin, ...cppFiles.map((upload) => `./${upload.fileName}`)].map(quotePosixArgument).join(' ');
          const compiled = await this.execCommand(conn, `cd ${quotePosixArgument(remoteBase)} && c++ ${argumentsQuoted}`);
          const compileTimeMs = Date.now() - startTime;
          if (compiled.exitCode !== 0) {
            const output = `${iconv.decode(compiled.stdout, 'gb18030')}\n${iconv.decode(compiled.stderr, 'gb18030')}`.trim();
            return finish(failure(new Error(output || `Linux c++ 退出码: ${compiled.exitCode}`)));
          }
          const runResults: SingleRunResult[] = [];
          for (const tc of testCases) {
            if (!tc.enabled || finished) continue;
            runResults.push(await this.runTestCase(conn, remoteBase, remoteBin, tc, timeoutMs, normalizeNewlines, stripTrailingNewlines));
          }
          finish({ compileResult: { compiler: 'linux', success: true, timeMs: compileTimeMs, outputBinaryPath: remoteBin }, runResults });
        })().catch((err: Error) => finish(failure(err)));
      });
      try {
        conn.connect(connConfig);
      } catch (err) {
        finish(failure(err));
      }
    });
  }

  /**
   * Parse the remote bash timing sentinel and exit code from stderr.
   * Format: __SJOOP_TIME__:<start_ns_or_s>:<end_ns_or_s>:<exit_code>
   */
  public static parseExecutionTiming(
    rawStderr: string,
    fallbackTimeMs: number,
    fallbackExitCode: number | undefined
  ): { timeMs: number; exitCode: number; stderr: string } {
    const timeRegex = /__SJOOP_TIME__:(\d+):(\d+):(-?\d+)[\r\n]*/;
    const match = rawStderr.match(timeRegex);
    let timeMs = fallbackTimeMs;
    let exitCode = fallbackExitCode ?? 0;

    if (match) {
      try {
        const rawT0 = match[1];
        const rawT1 = match[2];
        const parsedRc = parseInt(match[3], 10);
        if (!isNaN(parsedRc)) {
          exitCode = parsedRc;
        }
        if (rawT0.length >= 19 && rawT1.length >= 19) {
          const diffNs = BigInt(rawT1) - BigInt(rawT0);
          timeMs = Math.max(0, Math.round(Number(diffNs) / 1000000));
        } else {
          const diffS = BigInt(rawT1) - BigInt(rawT0);
          timeMs = Math.max(0, Number(diffS) * 1000);
        }
      } catch {
        // keep fallback
      }
    }

    const cleanStderr = rawStderr.replace(/__SJOOP_TIME__:[^\r\n]*[\r\n]*/g, '').trim();
    return { timeMs, exitCode, stderr: cleanStderr };
  }
}
