import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client, ConnectConfig } from 'ssh2';
import * as iconv from 'iconv-lite';
import { CompileResult, SingleRunResult, TestCase } from '../types';
import { compareBytesStrict } from '../judge/byteJudge';

export interface SshConfig {
  host: string;
  port: number;
  studentId: string;
  privateKeyPath?: string;
  passphrase?: string;
  remoteDir: string;
  flags: string[];
}

export class LinuxSshDriver {
  public static findDefaultPrivateKey(): string | null {
    const home = os.homedir();
    const ed25519 = path.join(home, '.ssh', 'id_ed25519');
    if (fs.existsSync(ed25519)) {
      return ed25519;
    }
    const rsa = path.join(home, '.ssh', 'id_rsa');
    if (fs.existsSync(rsa)) {
      return rsa;
    }
    return null;
  }

  private static getConnectConfig(config: SshConfig): ConnectConfig {
    const keyPath = (config.privateKeyPath && fs.existsSync(config.privateKeyPath))
      ? config.privateKeyPath
      : this.findDefaultPrivateKey();

    if (!keyPath || !fs.existsSync(keyPath)) {
      throw new Error(`找不到 SSH 私钥文件 (已尝试 ~/.ssh/id_ed25519)。请在设置中指定。`);
    }

    if (!config.studentId) {
      throw new Error(`未配置学号！请在插件设置中填入学号（用户名格式为 u{学号}）。`);
    }

    const privateKey = fs.readFileSync(keyPath);
    const username = `u${config.studentId.trim().replace(/^u/i, '')}`;

    const connConfig: ConnectConfig = {
      host: config.host || '10.80.42.230',
      port: config.port || 22,
      username,
      privateKey,
      readyTimeout: 7000,
    };

    if (config.passphrase) {
      connConfig.passphrase = config.passphrase;
    }

    return connConfig;
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

      conn.on('ready', () => {
        conn.exec('uname -m && (gcc --version 2>/dev/null || c++ --version 2>/dev/null) | head -n 1', (err, stream) => {
          if (err) {
            conn.end();
            return resolve({ success: true, message: `连接成功 (用户: ${connConfig.username})！但查询信息失败: ${err.message}` });
          }

          let outBuf: Buffer[] = [];
          stream.on('data', (d: Buffer) => outBuf.push(d));
          stream.on('close', () => {
            conn.end();
            if (!finished) {
              finished = true;
              const info = iconv.decode(Buffer.concat(outBuf), 'gb18030').trim().replace(/\r?\n/g, ' | ');
              resolve({
                success: true,
                message: `成功连通 10.80.42.230 (${connConfig.username})！\n服务器信息: ${info || 'Kunpeng 920'}`,
              });
            }
          });
        });
      });

      conn.on('error', (err: any) => {
        conn.end();
        if (!finished) {
          finished = true;
          const msg = err.message || '';
          if (msg.includes('ETIMEDOUT') || msg.includes('ENETUNREACH') || msg.includes('EHOSTUNREACH')) {
            resolve({
              success: false,
              message: `无法连接到 ${connConfig.host}！\n如果是校外环境，请务必先登录同济大学 VPN！`,
            });
          } else if (msg.includes('authentication') || msg.includes('passphrase')) {
            resolve({
              success: false,
              message: `SSH 认证失败: ${msg}。\n请确认学号及私钥/密码是否与交作业网站登记的一致。`,
            });
          } else {
            resolve({ success: false, message: `SSH 连接出错: ${msg}` });
          }
        }
      });

      conn.connect(connConfig);
    });
  }

  public static async compileAndRun(
    config: SshConfig,
    sources: string[],
    outputBaseName: string,
    testCases: TestCase[],
    timeoutMs: number = 5000,
    strictDiff: boolean = true
  ): Promise<{ compileResult: CompileResult; runResults: SingleRunResult[] }> {
    const startTime = Date.now();
    const connConfig = this.getConnectConfig(config);

    return new Promise((resolve) => {
      const conn = new Client();
      let hasError = false;

      conn.on('error', (err: any) => {
        if (!hasError) {
          hasError = true;
          conn.end();
          const msg = err.message || '';
          const errMsg = msg.includes('ETIMEDOUT')
            ? `无法连接到 ${connConfig.host}！请检查校园网/VPN 连接。`
            : `SSH 出错: ${msg}`;
          resolve({
            compileResult: {
              compiler: 'linux',
              success: false,
              timeMs: Date.now() - startTime,
              errorMessage: errMsg,
            },
            runResults: [],
          });
        }
      });

      conn.on('ready', () => {
        conn.sftp(async (sftpErr, sftp) => {
          if (sftpErr) {
            conn.end();
            return resolve({
              compileResult: {
                compiler: 'linux',
                success: false,
                timeMs: Date.now() - startTime,
                errorMessage: `开启 SFTP 失败: ${sftpErr.message}`,
              },
              runResults: [],
            });
          }

          const remoteBase = `${config.remoteDir || '~/sjoop_tmp'}/${outputBaseName}`;
          // 1. Create remote directory
          await new Promise<void>((res) => {
            conn.exec(`mkdir -p "${remoteBase}"`, () => res());
          });

          // 2. Upload source files
          const remoteFileNames: string[] = [];
          for (const localPath of sources) {
            const fileName = path.basename(localPath);
            const remotePath = `${remoteBase}/${fileName}`;
            const fileBuf = fs.readFileSync(localPath);

            await new Promise<void>((uploadRes, uploadRej) => {
              const ws = sftp.createWriteStream(remotePath);
              ws.on('close', () => uploadRes());
              ws.on('error', (e) => uploadRej(e));
              ws.end(fileBuf);
            }).catch(() => {
              // fallback upload command if sftp stream fails
            });

            remoteFileNames.push(fileName);
          }

          // 3. Remote Compile
          const defaultFlags = [
            '-Wall',
            '-std=c++20',
            '-finput-charset=GB18030',
            '-fexec-charset=GB18030',
          ];
          const flags = config.flags && config.flags.length > 0 ? config.flags : defaultFlags;
          const remoteBin = `${remoteBase}/${outputBaseName}_linux`;
          const compileCmd = `cd "${remoteBase}" && c++ ${flags.join(' ')} -o "${remoteBin}" ${remoteFileNames.join(' ')}`;

          conn.exec(compileCmd, (cErr, cStream) => {
            if (cErr) {
              conn.end();
              return resolve({
                compileResult: {
                  compiler: 'linux',
                  success: false,
                  timeMs: Date.now() - startTime,
                  errorMessage: `执行远程编译命令失败: ${cErr.message}`,
                },
                runResults: [],
              });
            }

            let compileStdout: Buffer[] = [];
            let compileStderr: Buffer[] = [];

            cStream.on('data', (d: Buffer) => compileStdout.push(d));
            cStream.stderr.on('data', (d: Buffer) => compileStderr.push(d));

            cStream.on('close', async (code: number) => {
              const compileTimeMs = Date.now() - startTime;
              const outMsg = (
                iconv.decode(Buffer.concat(compileStdout), 'gb18030') +
                '\n' +
                iconv.decode(Buffer.concat(compileStderr), 'gb18030')
              ).trim();

              if (code !== 0) {
                conn.end();
                return resolve({
                  compileResult: {
                    compiler: 'linux',
                    success: false,
                    timeMs: compileTimeMs,
                    errorMessage: outMsg || `Linux c++ 退出码: ${code}`,
                  },
                  runResults: [],
                });
              }

              // 4. Run test cases on remote server
              const runResults: SingleRunResult[] = [];
              for (const tc of testCases) {
                if (!tc.enabled) continue;

                const caseResult = await new Promise<SingleRunResult>((tcRes) => {
                  const tcStart = Date.now();
                  const runCmd = `cd "${remoteBase}" && "${remoteBin}"`;

                  conn.exec(runCmd, (rErr, rStream) => {
                    if (rErr) {
                      return tcRes({
                        testCaseId: tc.id,
                        compiler: 'linux',
                        status: 'RE',
                        timeMs: Date.now() - tcStart,
                        exitCode: -1,
                        stdout: '',
                        stderr: `执行错误: ${rErr.message}`,
                      });
                    }

                    let rStdoutChunks: Buffer[] = [];
                    let rStderrChunks: Buffer[] = [];
                    let isKilled = false;

                    const timer = setTimeout(() => {
                      isKilled = true;
                      rStream.destroy();
                    }, timeoutMs);

                    const inBytes = iconv.encode(tc.input, 'gb18030');
                    const expBytes = iconv.encode(tc.expectedOutput, 'gb18030');

                    rStream.write(inBytes);
                    rStream.end();

                    rStream.on('data', (d: Buffer) => rStdoutChunks.push(d));
                    rStream.stderr.on('data', (d: Buffer) => rStderrChunks.push(d));

                    rStream.on('close', (rCode: number) => {
                      clearTimeout(timer);
                      const tcTime = Date.now() - tcStart;
                      const actBytes = Buffer.concat(rStdoutChunks);
                      const stdStr = iconv.decode(actBytes, 'gb18030');
                      const errStr = iconv.decode(Buffer.concat(rStderrChunks), 'gb18030');

                      if (isKilled) {
                        return tcRes({
                          testCaseId: tc.id,
                          compiler: 'linux',
                          status: 'TLE',
                          timeMs: tcTime,
                          exitCode: -1,
                          stdout: stdStr,
                          stderr: '程序运行超时 (Time Limit Exceeded)',
                        });
                      }

                      if (rCode !== 0) {
                        return tcRes({
                          testCaseId: tc.id,
                          compiler: 'linux',
                          status: 'RE',
                          timeMs: tcTime,
                          exitCode: rCode ?? -1,
                          stdout: stdStr,
                          stderr: errStr || `程序异常退出，退出码: ${rCode}`,
                        });
                      }

                      const diff = compareBytesStrict(actBytes, expBytes, 'gb18030');
                      tcRes({
                        testCaseId: tc.id,
                        compiler: 'linux',
                        status: diff.matched ? 'AC' : 'WA',
                        timeMs: tcTime,
                        exitCode: 0,
                        stdout: stdStr,
                        stderr: errStr,
                        byteDiff: diff,
                      });
                    });
                  });
                });

                runResults.push(caseResult);
              }

              conn.end();
              resolve({
                compileResult: {
                  compiler: 'linux',
                  success: true,
                  timeMs: compileTimeMs,
                  outputBinaryPath: remoteBin,
                },
                runResults,
              });
            });
          });
        });
      });

      conn.connect(connConfig);
    });
  }
}
