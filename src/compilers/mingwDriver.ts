import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as iconv from 'iconv-lite';
import { CompileResult, SingleRunResult, TestCase } from '../types';
import { compareBytesStrict } from '../judge/byteJudge';

export class MingwDriver {
  private static cachedGppPath: string | null = null;

  public static findGpp(): string | null {
    if (this.cachedGppPath && fs.existsSync(this.cachedGppPath)) {
      return this.cachedGppPath;
    }

    const localAppData = process.env.LOCALAPPDATA || '';
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    // Candidate directories for RedPanda-CPP and typical MinGW setups
    const candidates = [
      path.join(progFiles, 'RedPanda-CPP', 'mingw64', 'bin', 'g++.exe'),
      path.join(progFilesX86, 'RedPanda-CPP', 'mingw64', 'bin', 'g++.exe'),
      path.join(localAppData, 'Programs', 'RedPanda-CPP', 'mingw64', 'bin', 'g++.exe'),
      'C:\\RedPanda-CPP\\mingw64\\bin\\g++.exe',
      'D:\\RedPanda-CPP\\mingw64\\bin\\g++.exe',
      'C:\\mingw64\\bin\\g++.exe',
      'C:\\TDM-GCC-64\\bin\\g++.exe',
    ];

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        this.cachedGppPath = cand;
        return cand;
      }
    }

    // Check system PATH
    try {
      const tool = process.platform === 'win32' ? 'where.exe' : 'which';
      const out = cp.execFileSync(tool, ['g++'], { encoding: 'utf-8', timeout: 3000 }).trim();
      const firstLine = out.split(/\r?\n/)[0];
      if (firstLine && fs.existsSync(firstLine)) {
        this.cachedGppPath = firstLine;
        return firstLine;
      }
    } catch {
      // ignore
    }

    return null;
  }

  public static compile(
    sources: string[],
    outputDir: string,
    outputBaseName: string,
    userFlags: string[] = [],
    customGppPath?: string
  ): Promise<CompileResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const gpp = customGppPath && fs.existsSync(customGppPath) ? customGppPath : this.findGpp();

      if (!gpp) {
        return resolve({
          compiler: 'mingw',
          success: false,
          timeMs: Date.now() - startTime,
          errorMessage: '未能找到 MinGW g++ 编译器 (RedPanda-CPP)。请在设置中手动指定 g++.exe 路径。',
        });
      }

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const outExe = path.join(outputDir, `${outputBaseName}_mingw.exe`);
      const defaultFlags = [
        '-Wall',
        '-std=c++20',
        '-finput-charset=GB18030',
        '-fexec-charset=GB18030',
      ];

      const flags = userFlags && userFlags.length > 0 ? userFlags : defaultFlags;
      const args = [
        ...flags,
        '-o', outExe,
        ...sources,
      ];

      const proc = cp.spawn(gpp, args, {
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
            compiler: 'mingw',
            success: true,
            timeMs,
            outputBinaryPath: outExe,
          });
        } else {
          resolve({
            compiler: 'mingw',
            success: false,
            timeMs,
            errorMessage: fullOutput || `g++ 退出码: ${code}`,
          });
        }
      });

      proc.on('error', (err) => {
        resolve({
          compiler: 'mingw',
          success: false,
          timeMs: Date.now() - startTime,
          errorMessage: `启动 g++ 失败: ${err.message}`,
        });
      });
    });
  }

  public static runTestCase(
    binaryPath: string,
    testCase: TestCase,
    timeoutMs: number = 5000,
    strictDiff: boolean = true,
    normalizeNewlines: boolean = true,
    stripTrailingNewlines: boolean = true
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
            compiler: 'mingw',
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
            compiler: 'mingw',
            status: 'RE',
            timeMs,
            exitCode: code ?? -1,
            stdout: stdoutStr,
            stderr: stderrStr || `程序异常退出，退出码: ${code}`,
          });
        }

        const diff = compareBytesStrict(actualBytes, expectedBytes, 'gb18030', normalizeNewlines, stripTrailingNewlines);
        resolve({
          testCaseId: testCase.id,
          compiler: 'mingw',
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
          compiler: 'mingw',
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
