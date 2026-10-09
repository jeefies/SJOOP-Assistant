import * as path from 'path';
import { CompilerType, CompileResult, SingleRunResult, TestCase } from '../types';
import { MsvcDriver } from './msvcDriver';
import { MingwDriver } from './mingwDriver';
import { LinuxSshDriver, SshConfig } from './linuxSshDriver';

export interface BatchRunOptions {
  workspaceRoot: string;
  sources: string[];
  outputBaseName: string;
  selectedCompilers: CompilerType[];
  testCases: TestCase[];
  timeoutMs: number;
  strictDiff: boolean;
  normalizeNewlines?: boolean;
  msvcFlags?: string[];
  customVcvars?: string;
  mingwFlags?: string[];
  customGpp?: string;
  sshConfig: SshConfig;
  onProgress?: (msg: string) => void;
}

export interface BatchRunResult {
  compilations: Record<CompilerType, CompileResult | undefined>;
  runs: Record<CompilerType, SingleRunResult[]>;
}

export class CompilerRunner {
  public static async executeBatch(options: BatchRunOptions): Promise<BatchRunResult> {
    const {
      workspaceRoot,
      sources,
      outputBaseName,
      selectedCompilers,
      testCases,
      timeoutMs,
      strictDiff,
      normalizeNewlines = true,
      msvcFlags,
      customVcvars,
      mingwFlags,
      customGpp,
      sshConfig,
      onProgress,
    } = options;

    const result: BatchRunResult = {
      compilations: {
        msvc: undefined,
        mingw: undefined,
        linux: undefined,
      },
      runs: {
        msvc: [],
        mingw: [],
        linux: [],
      },
    };

    const binDir = path.join(workspaceRoot, '.sjoop', 'bin');

    // 1. MSVC Run
    if (selectedCompilers.includes('msvc')) {
      onProgress?.('正在使用 MSVC 编译...');
      const msvcBinDir = path.join(binDir, 'msvc');
      const cRes = await MsvcDriver.compile(sources, msvcBinDir, outputBaseName, msvcFlags, customVcvars);
      result.compilations.msvc = cRes;

      if (cRes.success && cRes.outputBinaryPath) {
        onProgress?.('MSVC 编译成功，正在执行测试点...');
        for (const tc of testCases) {
          if (!tc.enabled) continue;
          const runRes = await MsvcDriver.runTestCase(cRes.outputBinaryPath, tc, timeoutMs, strictDiff, normalizeNewlines);
          result.runs.msvc.push(runRes);
        }
      }
    }

    // 2. MinGW Run
    if (selectedCompilers.includes('mingw')) {
      onProgress?.('正在使用 MinGW g++ 编译...');
      const mingwBinDir = path.join(binDir, 'mingw');
      const cRes = await MingwDriver.compile(sources, mingwBinDir, outputBaseName, mingwFlags, customGpp);
      result.compilations.mingw = cRes;

      if (cRes.success && cRes.outputBinaryPath) {
        onProgress?.('MinGW 编译成功，正在执行测试点...');
        for (const tc of testCases) {
          if (!tc.enabled) continue;
          const runRes = await MingwDriver.runTestCase(cRes.outputBinaryPath, tc, timeoutMs, strictDiff, normalizeNewlines);
          result.runs.mingw.push(runRes);
        }
      }
    }

    // 3. Linux SSH Run
    if (selectedCompilers.includes('linux')) {
      onProgress?.('正在连接 Linux 服务器 (10.80.42.230) 编译并执行...');
      const { compileResult, runResults } = await LinuxSshDriver.compileAndRun(
        sshConfig,
        sources,
        outputBaseName,
        testCases,
        timeoutMs,
        strictDiff,
        normalizeNewlines
      );
      result.compilations.linux = compileResult;
      result.runs.linux = runResults;
    }

    onProgress?.('测试完成！');
    return result;
  }
}
