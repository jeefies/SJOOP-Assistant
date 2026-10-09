import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as iconv from 'iconv-lite';
import { CompileResult, SingleRunResult, TestCase } from '../types';
import { compareBytesStrict } from '../judge/byteJudge';

export class MsvcDriver {
  private static cachedEnv: NodeJS.ProcessEnv | null = null;
  private static cachedVcvarsPath: string | null = null;

  public static findVcvars(): string | null {
    if (this.cachedVcvarsPath && fs.existsSync(this.cachedVcvarsPath)) {
      return this.cachedVcvarsPath;
    }

    if (process.platform !== 'win32') {
      return null;
    }

    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const vswherePath = path.join(progFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');

    if (fs.existsSync(vswherePath)) {
      try {
        const out = cp.execFileSync(vswherePath, [
          '-latest',
          '-products', '*',
          '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
          '-property', 'installationPath'
        ], { encoding: 'utf-8', timeout: 5000 }).trim();

        if (out) {
          const vcvars64 = path.join(out, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
          if (fs.existsSync(vcvars64)) {
            this.cachedVcvarsPath = vcvars64;
            return vcvars64;
          }
          const vcvarsall = path.join(out, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
          if (fs.existsSync(vcvarsall)) {
            this.cachedVcvarsPath = vcvarsall;
            return vcvarsall;
          }
        }
      } catch {
        // vswhere failed or not available
      }
    }

    // Common fallback paths
    const commonPaths = [
      'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat',
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat',
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\VC\\Auxiliary\\Build\\vcvars64.bat',
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Auxiliary\\Build\\vcvars64.bat',
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        this.cachedVcvarsPath = p;
        return p;
      }
    }

    return null;
  }

  public static getMsvcEnvironment(customVcvarsPath?: string): NodeJS.ProcessEnv | null {
    const vcvars = customVcvarsPath || this.findVcvars();
    if (!vcvars || !fs.existsSync(vcvars)) {
      return null;
    }

    if (this.cachedEnv && this.cachedVcvarsPath === vcvars) {
      return this.cachedEnv;
    }

    try {
      // Execute cmd to call vcvars and dump environment
      const cmd = `call "${vcvars}" x64 >nul 2>&1 && set`;
      const output = cp.execSync(cmd, { shell: 'cmd.exe', encoding: 'utf-8', timeout: 10000 });
      const env: NodeJS.ProcessEnv = { ...process.env };

      for (const line of output.split(/\r?\n/)) {
        const idx = line.indexOf('=');
        if (idx > 0) {
          const key = line.substring(0, idx);
          const val = line.substring(idx + 1);
          env[key] = val;
        }
      }

      this.cachedEnv = env;
      this.cachedVcvarsPath = vcvars;
      return env;
    } catch {
      return null;
    }
  }

  public static compile(
    sources: string[],
    outputDir: string,
    outputBaseName: string,
    userFlags: string[] = [],
    customVcvars?: string
  ): Promise<CompileResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const env = this.getMsvcEnvironment(customVcvars);

      if (!env) {
        return resolve({
          compiler: 'msvc',
          success: false,
          timeMs: Date.now() - startTime,
          errorMessage: '未能找到 MSVC 开发环境 (vcvars64.bat)。请安装 Visual Studio C++ 工具或在插件设置中手动指定路径。',
        });
      }

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const outExe = path.join(outputDir, `${outputBaseName}_msvc.exe`);
      const defaultFlags = [
        '/nologo',
        '/std:c++20',
        '/EHsc',
        '/permissive-',
        '/W3',
        '/MDd',
        '/Od',
        '/D', '_DEBUG',
        '/D', '_CONSOLE',
        '/source-charset:gb18030',
        '/execution-charset:gb18030',
      ];

      const flags = userFlags && userFlags.length > 0 ? userFlags : defaultFlags;
      const args = [
        ...flags,
        `/Fe:${outExe}`,
        `/Fo:${outputDir}\\`,
        ...sources,
      ];

      const proc = cp.spawn('cl.exe', args, {
        env,
        cwd: outputDir,
        shell: false,
      });

      let stdoutChunks: Buffer[] = [];
      let stderrChunks: Buffer[] = [];

      proc.stdout.on('data', (c) => stdoutChunks.push(c));
      proc.stderr.on('data', (c) => stderrChunks.push(c));

      proc.on('close', (code) => {
        const timeMs = Date.now() - startTime;
        const stdout = iconv.decode(Buffer.concat(stdoutChunks), 'gb18030');
        const stderr = iconv.decode(Buffer.concat(stderrChunks), 'gb18030');
        const fullOutput = (stdout + '\n' + stderr).trim();

        if (code === 0 && fs.existsSync(outExe)) {
          resolve({
            compiler: 'msvc',
            success: true,
            timeMs,
            outputBinaryPath: outExe,
          });
        } else {
          resolve({
            compiler: 'msvc',
            success: false,
            timeMs,
            errorMessage: fullOutput || `cl.exe 退出码: ${code}`,
          });
        }
      });

      proc.on('error', (err) => {
        resolve({
          compiler: 'msvc',
          success: false,
          timeMs: Date.now() - startTime,
          errorMessage: `启动 cl.exe 失败: ${err.message}`,
        });
      });
    });
  }

  public static runTestCase(
    binaryPath: string,
    testCase: TestCase,
    timeoutMs: number = 5000,
    strictDiff: boolean = true
  ): Promise<SingleRunResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const inputBytes = iconv.encode(testCase.input, 'gb18030');
      const expectedBytes = iconv.encode(testCase.expectedOutput, 'gb18030');

      const proc = cp.spawn(binaryPath, [], {
        cwd: path.dirname(binaryPath),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdoutChunks: Buffer[] = [];
      let stderrChunks: Buffer[] = [];
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        proc.kill();
      }, timeoutMs);

      proc.stdin.write(inputBytes);
      proc.stdin.end();

      proc.stdout.on('data', (c) => stdoutChunks.push(c));
      proc.stderr.on('data', (c) => stderrChunks.push(c));

      proc.on('close', (code) => {
        clearTimeout(timer);
        const timeMs = Date.now() - startTime;
        const actualBytes = Buffer.concat(stdoutChunks);
        const stdoutStr = iconv.decode(actualBytes, 'gb18030');
        const stderrStr = iconv.decode(Buffer.concat(stderrChunks), 'gb18030');

        if (killed) {
          return resolve({
            testCaseId: testCase.id,
            compiler: 'msvc',
            status: 'TLE',
            timeMs,
            exitCode: -1,
            stdout: stdoutStr,
            stderr: '程序运行超时 (Time Limit Exceeded)',
          });
        }

        if (code !== 0) {
          return resolve({
            testCaseId: testCase.id,
            compiler: 'msvc',
            status: 'RE',
            timeMs,
            exitCode: code ?? -1,
            stdout: stdoutStr,
            stderr: stderrStr || `程序异常退出，退出码: ${code}`,
          });
        }

        const diff = compareBytesStrict(actualBytes, expectedBytes, 'gb18030');
        resolve({
          testCaseId: testCase.id,
          compiler: 'msvc',
          status: diff.matched ? 'AC' : 'WA',
          timeMs,
          exitCode: 0,
          stdout: stdoutStr,
          stderr: stderrStr,
          byteDiff: diff,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          testCaseId: testCase.id,
          compiler: 'msvc',
          status: 'RE',
          timeMs: Date.now() - startTime,
          exitCode: -1,
          stdout: '',
          stderr: `执行错误: ${err.message}`,
        });
      });
    });
  }
}
