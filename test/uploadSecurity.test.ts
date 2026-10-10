import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateUploadSources } from '../src/security/uploadSources';

type MutableFs = { -readonly [K in keyof typeof fs]: (typeof fs)[K] };

describe('Linux upload source boundary', () => {
  let tempRoot: string;
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sjoop-upload-security-'));
    workspace = path.join(tempRoot, 'workspace');
    outside = path.join(tempRoot, 'workspace-outside');
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function write(relativePath: string, content = 'int main() { return 0; }'): string {
    const filePath = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('returns snapshots of ordinary source/header files and resolves relative paths from the workspace', () => {
    const main = write('src/main.cpp');
    const header = write('src/example.hpp', '#pragma once');
    const uploads = validateUploadSources(['src/main.cpp', header], workspace);
    assert.deepStrictEqual(uploads.map((file) => file.path), [fs.realpathSync(main), fs.realpathSync(header)]);
    assert.deepStrictEqual(uploads.map((file) => file.fileName), ['main.cpp', 'example.hpp']);
    assert.strictEqual(uploads[0].content.toString(), 'int main() { return 0; }');
    assert.strictEqual(uploads[1].content.toString(), '#pragma once');
    fs.writeFileSync(main, 'changed later');
    assert.strictEqual(uploads[0].content.toString(), 'int main() { return 0; }');
  });

  it('permits all documented C/C++ source and header extensions', () => {
    const names = ['file.c', 'file.cpp', 'file.cc', 'file.cxx', 'file.h', 'file.hpp', 'file.hh', 'file.hxx'];
    names.forEach((name) => write(name));
    assert.strictEqual(validateUploadSources(names, workspace).length, names.length);
  });

  it('accepts matching file identities when Windows path stat has no device ID', () => {
    const main = write('main.cpp');
    const fsModule = require('fs') as MutableFs;
    const originalStat = fsModule.statSync;
    const originalFstat = fsModule.fstatSync;
    fsModule.statSync = ((filePath: fs.PathLike) => {
      const stat = originalStat(filePath);
      stat.dev = 0;
      return stat;
    }) as typeof originalStat;
    fsModule.fstatSync = ((fd: number) => {
      const stat = originalFstat(fd);
      stat.dev = 1234;
      return stat;
    }) as typeof originalFstat;
    try {
      assert.strictEqual(validateUploadSources([main], workspace)[0].content.toString(), 'int main() { return 0; }');
    } finally {
      fsModule.statSync = originalStat;
      fsModule.fstatSync = originalFstat;
    }
  });

  it('requires a workspace directory', () => {
    const main = write('main.cpp');
    for (const root of [undefined, '', ' ', main]) {
      assert.throws(() => validateUploadSources([main], root));
    }
  });

  it('rejects empty and malformed manifests', () => {
    for (const manifest of [[], null, {}, [''], [' '], [null], [12], ['main.cpp\0']]) {
      assert.throws(() => validateUploadSources(manifest as string[], workspace));
    }
    const sparse = [write('main.cpp')];
    sparse.length = 2;
    assert.throws(() => validateUploadSources(sparse, workspace));
  });

  it('rejects outside files even when they have a source extension or share the root prefix', () => {
    const disguisedSecret = path.join(outside, 'secret.cpp');
    fs.writeFileSync(disguisedSecret, 'synthetic outside secret');
    assert.throws(() => validateUploadSources([disguisedSecret], workspace), /工作区/);
  });

  it('rejects relative parent traversal to an outside file', () => {
    fs.writeFileSync(path.join(outside, 'secret.cpp'), 'synthetic outside secret');
    assert.throws(() => validateUploadSources(['../workspace-outside/secret.cpp'], workspace), /工作区/);
  });

  it('rejects a directory symlink or Windows junction that escapes the workspace', () => {
    fs.writeFileSync(path.join(outside, 'secret.cpp'), 'synthetic outside secret');
    const link = path.join(workspace, 'linked');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => validateUploadSources(['linked/secret.cpp'], workspace), /符号链接/);
  });

  it('rejects a source-named hard link to an outside file', () => {
    const secret = path.join(outside, 'synthetic-private-data');
    fs.writeFileSync(secret, 'synthetic outside secret');
    const link = path.join(workspace, 'innocent.cpp');
    fs.linkSync(secret, link);
    assert.throws(() => validateUploadSources([link], workspace), /硬链接/);
  });

  it('rejects directories even when their names end in .cpp', () => {
    fs.mkdirSync(path.join(workspace, 'directory.cpp'));
    assert.throws(() => validateUploadSources(['directory.cpp'], workspace), /普通文件/);
  });

  it('rejects unapproved extensions without silently excluding them', () => {
    const main = write('main.cpp');
    const other = write('credentials.txt', 'synthetic private data');
    assert.throws(() => validateUploadSources([main, other], workspace), /仅允许/);
  });

  it('validates the whole manifest before reading any file content', () => {
    const main = write('main.cpp');
    const other = write('credentials.txt');
    const fsModule = require('fs') as typeof fs;
    const originalRead = fsModule.readFileSync;
    let reads = 0;
    fsModule.readFileSync = ((...args: Parameters<typeof originalRead>) => {
      reads += 1;
      return originalRead(...args);
    }) as typeof originalRead;
    try {
      assert.throws(() => validateUploadSources([main, other], workspace), /仅允许/);
      assert.strictEqual(reads, 0);
    } finally {
      fsModule.readFileSync = originalRead;
    }
  });

  it('rejects a file replaced between validation and opening the descriptor', () => {
    const main = write('main.cpp');
    const fsModule = require('fs') as typeof fs;
    const originalOpen = fsModule.openSync;
    fsModule.openSync = ((...args: Parameters<typeof originalOpen>) => {
      fsModule.openSync = originalOpen;
      fs.renameSync(main, path.join(workspace, 'original.cpp'));
      fs.writeFileSync(main, 'replacement content');
      return originalOpen(...args);
    }) as typeof originalOpen;
    try {
      assert.throws(() => validateUploadSources([main], workspace), /校验后发生变化/);
    } finally {
      fsModule.openSync = originalOpen;
    }
  });

  it('still rejects replacement when the validated device ID is unavailable', () => {
    const main = write('main.cpp');
    const fsModule = require('fs') as MutableFs;
    const originalStat = fsModule.statSync;
    const originalOpen = fsModule.openSync;
    fsModule.statSync = ((filePath: fs.PathLike) => {
      const stat = originalStat(filePath);
      stat.dev = 0;
      return stat;
    }) as typeof originalStat;
    fsModule.openSync = ((...args: Parameters<typeof originalOpen>) => {
      fsModule.openSync = originalOpen;
      fs.renameSync(main, path.join(workspace, 'original.cpp'));
      fs.writeFileSync(main, 'replacement content');
      return originalOpen(...args);
    }) as typeof originalOpen;
    try {
      assert.throws(() => validateUploadSources([main], workspace), /校验后发生变化/);
    } finally {
      fsModule.statSync = originalStat;
      fsModule.openSync = originalOpen;
    }
  });

  it('requires at least one C/C++ source file', () => {
    assert.throws(() => validateUploadSources([write('header.h')], workspace), /至少一个/);
  });

  it('rejects duplicate basenames in the flattened remote upload directory', () => {
    const first = write('one/main.cpp');
    const second = write('two/main.cpp');
    assert.throws(() => validateUploadSources([first, second], workspace), /文件名重复/);
    assert.throws(() => validateUploadSources([first, first], workspace), /文件名重复/);
  });

  it('rejects missing source files', () => {
    assert.throws(() => validateUploadSources(['missing.cpp'], workspace));
  });
});
