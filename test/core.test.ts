import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as iconv from 'iconv-lite';
import { detectBufferEncoding, convertFileToGB18030, getSystemEncoding, checkFileEncoding } from '../src/encoding/encodingGuard';
import { compareBytesStrict } from '../src/judge/byteJudge';
import { CaseManager } from '../src/storage/caseManager';
import { MsvcDriver } from '../src/compilers/msvcDriver';
import { MingwDriver } from '../src/compilers/mingwDriver';
import { TestCase } from '../src/types';

describe('SJOOP Core Modules Test Suite', () => {
  const tmpDir = path.join(os.tmpdir(), `sjoop_test_${Date.now()}`);

  before(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Encoding Guard', () => {
    it('should detect pure ASCII buffer correctly', () => {
      const buf = Buffer.from('int main() { return 0; }', 'ascii');
      const res = detectBufferEncoding(buf);
      assert.strictEqual(res.isPureAscii, true);
      assert.strictEqual(res.encoding, 'ascii');
    });

    it('should detect UTF-8 with BOM correctly', () => {
      const buf = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('// 同济大学 OOP 作业', 'utf-8'),
      ]);
      const res = detectBufferEncoding(buf);
      assert.strictEqual(res.hasBom, true);
      assert.strictEqual(res.encoding, 'utf-8-bom');
    });

    it('should detect UTF-8 Chinese characters without BOM', () => {
      const buf = Buffer.from('// 施捷老师的程序设计课程 - UTF-8测试', 'utf-8');
      const res = detectBufferEncoding(buf);
      assert.strictEqual(res.encoding, 'utf-8');
      assert.strictEqual(res.hasBom, false);
    });

    it('should detect GB18030 Chinese characters correctly', () => {
      const buf = iconv.encode('// 施捷老师的程序设计课程 - GB18030测试', 'gb18030');
      const res = detectBufferEncoding(buf);
      assert.strictEqual(res.encoding, 'gb18030');
    });

    it('should convert UTF-8 file to GB18030 in-place', () => {
      const testFile = path.join(tmpDir, 'test_utf8.cpp');
      const originalText = '// 同济大学程序设计\nint main() { return 0; }\n';
      fs.writeFileSync(testFile, originalText, 'utf-8');

      const checkBefore = checkFileEncoding(testFile, 'gb18030');
      assert.strictEqual(checkBefore.isTargetEncoding, false);

      const convRes = convertFileToGB18030(testFile);
      assert.strictEqual(convRes.success, true);

      const checkAfter = checkFileEncoding(testFile, 'gb18030');
      assert.strictEqual(checkAfter.isTargetEncoding, true);

      // Verify file content decoded with gb18030 matches original string
      const raw = fs.readFileSync(testFile);
      const decoded = iconv.decode(raw, 'gb18030');
      assert.strictEqual(decoded, originalText);
    });

    it('should report system encoding', () => {
      const sysEnc = getSystemEncoding();
      assert.ok(sysEnc.length > 0);
    });
  });

  describe('Byte Judge (Strict Byte Comparison)', () => {
    it('should accept identical buffers as AC', () => {
      const buf1 = iconv.encode('5 6 7 1 2 3 4\n', 'gb18030');
      const buf2 = iconv.encode('5 6 7 1 2 3 4\n', 'gb18030');
      const diff = compareBytesStrict(buf1, buf2, 'gb18030');
      assert.strictEqual(diff.matched, true);
      assert.strictEqual(diff.firstDiffOffset, -1);
    });

    it('should accept CRLF vs LF as AC when normalizeNewlines is true', () => {
      const bufActual = Buffer.from('Hello\r\nWorld\r\n', 'ascii');
      const bufExpected = Buffer.from('Hello\nWorld\n', 'ascii');
      const diff = compareBytesStrict(bufActual, bufExpected, 'gb18030', true);
      assert.strictEqual(diff.matched, true);
      assert.ok(diff.message.includes('已自动统一 CRLF 与 LF 换行符'));
    });

    it('should report WA on newline difference when normalizeNewlines is false', () => {
      const bufActual = Buffer.from('Hello\r\n', 'ascii');
      const bufExpected = Buffer.from('Hello\n', 'ascii');
      const diff = compareBytesStrict(bufActual, bufExpected, 'gb18030', false);
      assert.strictEqual(diff.matched, false);
      assert.strictEqual(diff.firstDiffOffset, 5);
      assert.strictEqual(diff.actualByte, 0x0d);
      assert.strictEqual(diff.expectedByte, 0x0a);
    });

    it('should report WA on content difference', () => {
      const bufActual = iconv.encode('结果: 42', 'gb18030');
      const bufExpected = iconv.encode('结果: 43', 'gb18030');
      const diff = compareBytesStrict(bufActual, bufExpected, 'gb18030');
      assert.strictEqual(diff.matched, false);
      assert.ok(diff.message.includes('不匹配'));
    });
  });

  describe('Case Manager (Storage)', () => {
    it('should load fallback test cases if none exist', () => {
      const cases = CaseManager.loadTestCases(tmpDir, 'empty_proj');
      assert.ok(Array.isArray(cases));
      assert.strictEqual(cases.length, 1);
    });

    it('should save and load test cases', () => {
      const sampleCases: TestCase[] = [
        { id: '1', name: '样例1', input: '7 3\n1 2 3 4 5 6 7\n', expectedOutput: '5 6 7 1 2 3 4\n', enabled: true },
        { id: '2', name: '样例2', input: '4 2\n-1 -100 3 99\n', expectedOutput: '3 99 -1 -100\n', enabled: false },
      ];
      CaseManager.saveTestCases(tmpDir, 'hw1', sampleCases);

      const loaded = CaseManager.loadTestCases(tmpDir, 'hw1');
      assert.strictEqual(loaded.length, 2);
      assert.strictEqual(loaded[0].input, sampleCases[0].input);
      assert.strictEqual(loaded[1].enabled, false);
    });

    it('should save and load multi-file project config', () => {
      CaseManager.saveProjectConfig(tmpDir, '4-b16', {
        mode: 'multi',
        mainFile: '4-b16-main.cpp',
        additionalFiles: ['4-b16-sub1.cpp', '4-b16.h'],
      });

      const loaded = CaseManager.loadProjectConfig(tmpDir, '4-b16', '4-b16-main.cpp');
      assert.strictEqual(loaded.mode, 'multi');
      assert.strictEqual(loaded.additionalFiles.length, 2);
    });
  });

  describe('Local Compiler Drivers (Smoke Test)', function () {
    this.timeout(20000);

    it('should locate Visual Studio MSVC vcvars on Windows', () => {
      if (process.platform !== 'win32') return;
      const vcvars = MsvcDriver.findVcvars();
      assert.ok(vcvars !== null, 'vcvars64.bat should be found on this machine');
      assert.ok(fs.existsSync(vcvars!));
    });

    it('should locate MinGW g++ on this machine', () => {
      const gpp = MingwDriver.findGpp();
      assert.ok(gpp !== null, 'g++ should be found on this machine');
      assert.ok(fs.existsSync(gpp!));
    });

    it('should compile and run a GB18030 C++ file using MSVC', async () => {
      if (process.platform !== 'win32') return;
      const cppFile = path.join(tmpDir, 'test_msvc.cpp');
      const cppContent = iconv.encode(
        '#include <iostream>\nusing namespace std;\nint main() {\n  int a, b;\n  if (cin >> a >> b) cout << "求和: " << (a + b) << endl;\n  return 0;\n}\n',
        'gb18030'
      );
      fs.writeFileSync(cppFile, cppContent);

      const compileRes = await MsvcDriver.compile([cppFile], path.join(tmpDir, 'bin_msvc'), 'test_msvc');
      assert.strictEqual(compileRes.success, true, `MSVC compile failed: ${compileRes.errorMessage}`);
      assert.ok(compileRes.outputBinaryPath && fs.existsSync(compileRes.outputBinaryPath));

      const runRes = await MsvcDriver.runTestCase(compileRes.outputBinaryPath, {
        id: '1',
        name: 'test',
        input: '10 20\n',
        expectedOutput: '求和: 30\n',
        enabled: true,
      });

      assert.strictEqual(runRes.status, 'AC', `Expected AC but got ${runRes.status}: diff=${runRes.byteDiff?.message}`);
    });

    it('should compile and run a GB18030 C++ file using MinGW g++', async () => {
      const cppFile = path.join(tmpDir, 'test_mingw.cpp');
      const cppContent = iconv.encode(
        '#include <iostream>\nusing namespace std;\nint main() {\n  int a, b;\n  if (cin >> a >> b) cout << "求和: " << (a + b) << endl;\n  return 0;\n}\n',
        'gb18030'
      );
      fs.writeFileSync(cppFile, cppContent);

      const compileRes = await MingwDriver.compile([cppFile], path.join(tmpDir, 'bin_mingw'), 'test_mingw');
      assert.strictEqual(compileRes.success, true, `MinGW compile failed: ${compileRes.errorMessage}`);
      assert.ok(compileRes.outputBinaryPath && fs.existsSync(compileRes.outputBinaryPath));

      const runRes = await MingwDriver.runTestCase(compileRes.outputBinaryPath, {
        id: '1',
        name: 'test',
        input: '10 20\n',
        expectedOutput: '求和: 30\n',
        enabled: true,
      });

      assert.strictEqual(runRes.status, 'AC', `Expected AC but got ${runRes.status}: diff=${runRes.byteDiff?.message}`);
    });
  });
});
