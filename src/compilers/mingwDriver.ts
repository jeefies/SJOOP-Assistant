import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as iconv from 'iconv-lite';
import { CompileResult, SingleRunResult, TestCase } from '../types';
import { compareBytesStrict } from '../judge/byteJudge';

export interface GppVersionInfo {
  path: string | null;
  valid: boolean;
  versionLine: string;
  isExpectedVersion: boolean;
  expectedSignature: string;
}

export const EXPECTED_GCC_SIGNATURE = 'gcc version 15.2.0 (MinGW-W64 x86_64-ucrt-posix-seh, built by Brecht Sanders, r6)';

export class MingwDriver {
  public static readonly EXPECTED_GCC_SIGNATURE = EXPECTED_GCC_SIGNATURE;
  private static cachedGppPath: string | null = null;

  public static resolveGppPath(targetPath?: string | null): string | null {
    if (!targetPath) return null;
    let trimmed = targetPath.trim();
    if (!trimmed) return null;
    trimmed = trimmed.replace(/^["'](.*)["']$/, '$1').trim();

    if (!fs.existsSync(trimmed)) {
      if (fs.existsSync(trimmed + '.exe')) {
        return trimmed + '.exe';
      }
      return null;
    }

    try {
      const stat = fs.statSync(trimmed);
      if (stat.isDirectory()) {
        const cand1 = path.join(trimmed, 'g++.exe');
        if (fs.existsSync(cand1)) return cand1;
        const cand2 = path.join(trimmed, 'bin', 'g++.exe');
        if (fs.existsSync(cand2)) return cand2;
        return null;
      }
      return trimmed;
    } catch {
      return null;
    }
  }

  public static findGpp(): string | null {
    if (this.cachedGppPath && fs.existsSync(this.cachedGppPath)) {
      return this.cachedGppPath;
    }

    const localAppData = process.env.LOCALAPPDATA || '';
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const userProfile = process.env.USERPROFILE || '';

    // Candidate directories for RedPanda-CPP and typical MinGW setups
    const candidates = [
      ...(userProfile
        ? [
            path.join(
              userProfile,
              'Documents',
              'OI',
              'ProgramDesign',
              'SBSJ',
              '25262-000002-W0000.开学大礼包',
              'RedPanda-CPP',
              'mingw64',
              'bin',
              'g++.exe'
            ),
          ]
        : []),
      path.join(progFiles, 'RedPanda-CPP', 'mingw64', 'bin', 'g++.exe'),
      path.join(progFilesX86, 'RedPanda-CPP', 'mingw64', 'bin', 'g++.exe'),
      path.join(localAppData, 'Programs', 'RedPanda-CPP', 'mingw64', 'bin', 'g++.exe'),
      'C:\\RedPanda-CPP\\mingw64\\bin\\g++.exe',
      'D:\\RedPanda-CPP\\mingw64\\bin\\g++.exe',
      'C:\\winlibs\\bin\\g++.exe',
      'D:\\winlibs\\bin\\g++.exe',
      'C:\\mingw64\\bin\\g++.exe',
      'C:\\TDM-GCC-64\\bin\\g++.exe',
    ];

    const foundCandidates = candidates.filter((cand) => fs.existsSync(cand));

    // Check system PATH
    try {
      const tool = process.platform === 'win32' ? 'where.exe' : 'which';
      const out = cp.execFileSync(tool, ['g++'], { encoding: 'utf-8', timeout: 3000 }).trim();
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && fs.existsSync(l));
      for (const line of lines) {
        if (!foundCandidates.includes(line)) {
          foundCandidates.push(line);
        }
      }
    } catch {
      // ignore
    }

    // Prefer compiler matching expected GCC 15.2.0 version
    for (const cand of foundCandidates) {
      try {
        const res = cp.spawnSync(cand, ['-v'], { encoding: 'utf-8', timeout: 3000 });
        const out = ((res.stdout || '') + '\n' + (res.stderr || '')).toLowerCase();
        if (out.includes('15.2.0') && out.includes('brecht sanders') && out.includes('ucrt') && out.includes('r6')) {
          this.cachedGppPath = cand;
          return cand;
        }
      } catch {
        // ignore
      }
    }

    if (foundCandidates.length > 0) {
      this.cachedGppPath = foundCandidates[0];
      return foundCandidates[0];
    }

    return null;
  }

  public static checkGppVersion(customGppPath?: string): GppVersionInfo {
    const trimmedCustom = customGppPath?.trim();
    let gpp: string | null = null;

    if (trimmedCustom) {
      gpp = this.resolveGppPath(trimmedCustom);
      if (!gpp) {
        return {
          path: null,
          valid: false,
          versionLine: `指定的路径未找到 g++ 编译器: ${trimmedCustom}`,
          isExpectedVersion: false,
          expectedSignature: EXPECTED_GCC_SIGNATURE,
        };
      }
    } else {
      gpp = this.findGpp();
    }

    if (!gpp || !fs.existsSync(gpp)) {
      return {
        path: null,
        valid: false,
        versionLine: '未找到 g++ 编译器',
        isExpectedVersion: false,
        expectedSignature: EXPECTED_GCC_SIGNATURE,
      };
    }

    try {
      const res = cp.spawnSync(gpp, ['-v'], { encoding: 'utf-8', timeout: 5000 });
      const full = ((res.stdout || '') + '\n' + (res.stderr || '')).trim();

      const lines = full.split(/\r?\n/);
      let versionLine = '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (/gcc\s+(version|版本)/i.test(line)) {
          versionLine = line;
          break;
        }
      }
      if (!versionLine && lines.length > 0) {
        versionLine = lines[lines.length - 1].trim();
      }

      const lower = full.toLowerCase();
      const isExpected = lower.includes('15.2.0') &&
        lower.includes('brecht sanders') &&
        lower.includes('ucrt') &&
        lower.includes('r6');

      return {
        path: gpp,
        valid: true,
        versionLine: versionLine || '未知版本',
        isExpectedVersion: isExpected,
        expectedSignature: EXPECTED_GCC_SIGNATURE,
      };
    } catch (err: any) {
      return {
        path: gpp,
        valid: false,
        versionLine: `获取版本失败: ${err.message}`,
        isExpectedVersion: false,
        expectedSignature: EXPECTED_GCC_SIGNATURE,
      };
    }
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
      const resolvedCustom = customGppPath ? this.resolveGppPath(customGppPath) : null;
      if (customGppPath && !resolvedCustom) {
        return resolve({
          compiler: 'mingw',
          success: false,
          timeMs: Date.now() - startTime,
          errorMessage: `未能找到指定的 MinGW g++ 路径: ${customGppPath}。请检查路径设置（支持输入 bin 目录或 g++.exe 完整路径）。`,
        });
      }
      const gpp = resolvedCustom || this.findGpp();

      if (!gpp) {
        return resolve({
          compiler: 'mingw',
          success: false,
          timeMs: Date.now() - startTime,
          errorMessage: '未能找到 MinGW g++ 编译器 (RedPanda-CPP)。请在设置中手动指定 g++.exe 或 bin 目录路径。',
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

      const cppSources = sources.filter((f) => /\.(cpp|c|cc|cxx)$/i.test(f));
      const filesToCompile = cppSources.length > 0 ? cppSources : sources;
      const includeDirs = [...new Set(sources.map((s) => path.dirname(s)))];
      const includeFlags = includeDirs.map((d) => `-I${d}`);

      const flags = userFlags && userFlags.length > 0 ? userFlags : defaultFlags;
      const args = [
        ...flags,
        ...includeFlags,
        '-o', outExe,
        ...filesToCompile,
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

        const hasExpected = typeof testCase.expectedOutput === 'string' && testCase.expectedOutput.trim() !== '';
        if (!hasExpected) {
          return resolve({
            testCaseId: testCase.id,
            compiler: 'mingw',
            status: 'RUN',
            timeMs,
            exitCode: 0,
            stdout: stdoutStr,
            stderr: stderrStr,
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
