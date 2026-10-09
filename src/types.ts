export type CompilerType = 'msvc' | 'mingw' | 'linux';

export type JudgeStatus = 'AC' | 'WA' | 'TLE' | 'RE' | 'CE';

export interface TestCase {
  id: string;
  name: string;
  input: string;
  expectedOutput: string;
  enabled: boolean;
}

export interface ByteDiffDetail {
  matched: boolean;
  expectedLength: number;
  actualLength: number;
  firstDiffOffset: number; // -1 if matched
  expectedByte?: number;
  actualByte?: number;
  expectedContext?: string;
  actualContext?: string;
  message: string;
}

export interface SingleRunResult {
  testCaseId: string;
  compiler: CompilerType;
  status: JudgeStatus;
  timeMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  byteDiff?: ByteDiffDetail;
}

export interface CompileResult {
  compiler: CompilerType;
  success: boolean;
  timeMs: number;
  errorMessage?: string;
  outputBinaryPath?: string;
}

export interface ProjectConfig {
  mode: 'single' | 'multi';
  mainFile: string;
  additionalFiles: string[]; // relative or absolute paths to other .cpp / .h
}

export interface EncodingCheckResult {
  filePath: string;
  encoding: string;
  isTargetEncoding: boolean;
  hasBom: boolean;
  systemEncoding: string;
  message?: string;
}

export interface CompilerConfig {
  msvc: {
    enabled: boolean;
    autoDetect: boolean;
    vcvarsPath: string;
    flags: string[];
    foundPath?: string;
  };
  mingw: {
    enabled: boolean;
    autoDetect: boolean;
    gppPath: string;
    flags: string[];
    foundPath?: string;
  };
  linux: {
    enabled: boolean;
    host: string;
    port: number;
    studentId: string;
    privateKeyPath: string;
    passphrase?: string;
    remoteDir: string;
    flags: string[];
  };
}
