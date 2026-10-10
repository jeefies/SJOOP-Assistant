import * as fs from 'fs';
import * as path from 'path';

export interface UploadSource {
  /** Canonical local path used to validate and read the file. */
  path: string;
  /** The remote uploader preserves the existing flat directory layout. */
  fileName: string;
  content: Buffer;
}

const sourceExtensions = new Set(['.c', '.cpp', '.cc', '.cxx']);
const uploadExtensions = new Set([...sourceExtensions, '.h', '.hpp', '.hh', '.hxx']);

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireRegularUnlinkedFile(filePath: string, stat: fs.Stats): void {
  if (!stat.isFile()) {
    throw new Error(`上传文件必须是普通文件: ${filePath}`);
  }
  // A hard link can give an outside secret a permitted name inside the workspace.
  if (stat.nlink > 1) {
    throw new Error(`不能上传硬链接文件: ${filePath}`);
  }
}

/**
 * Validate the entire upload manifest before reading any file content or opening SSH.
 * Return immutable upload inputs so the uploader never reopens manifest paths later.
 */
export function validateUploadSources(sources: string[], workspaceRoot: string | undefined): UploadSource[] {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim() || workspaceRoot.includes('\0')) {
    throw new Error('Linux 上传需要一个有效的工作区根目录。');
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('上传文件清单不能为空。');
  }

  const lexicalRoot = path.resolve(workspaceRoot);
  const canonicalRoot = fs.realpathSync(lexicalRoot);
  if (!fs.statSync(canonicalRoot).isDirectory()) {
    throw new Error('Linux 上传的工作区根目录必须是目录。');
  }

  const fileNames = new Set<string>();
  let hasSource = false;
  const validated = Array.from(sources).map((source) => {
    if (typeof source !== 'string' || !source.trim() || source.includes('\0')) {
      throw new Error('上传文件清单包含无效路径。');
    }

    const lexicalPath = path.resolve(lexicalRoot, source);
    if (!isWithin(lexicalRoot, lexicalPath)) {
      throw new Error(`上传文件必须位于当前工作区内: ${source}`);
    }
    const fileName = path.basename(lexicalPath);
    const extension = path.extname(fileName).toLowerCase();
    if (!uploadExtensions.has(extension)) {
      throw new Error(`仅允许上传 C/C++ 源文件和头文件: ${fileName}`);
    }

    const canonicalPath = fs.realpathSync(lexicalPath);
    if (!isWithin(canonicalRoot, canonicalPath)) {
      throw new Error(`上传文件不能通过符号链接离开当前工作区: ${source}`);
    }
    if (fs.lstatSync(lexicalPath).isSymbolicLink()) {
      throw new Error(`不能上传符号链接文件: ${source}`);
    }
    const stat = fs.statSync(canonicalPath);
    requireRegularUnlinkedFile(canonicalPath, stat);

    const remoteName = process.platform === 'win32' ? fileName.toLowerCase() : fileName;
    if (fileNames.has(remoteName)) {
      throw new Error(`上传文件名重复，远程目录无法保留这两个文件: ${fileName}`);
    }
    fileNames.add(remoteName);
    hasSource ||= sourceExtensions.has(extension);
    return { path: canonicalPath, fileName, stat };
  });

  if (!hasSource) {
    throw new Error('上传文件清单必须包含至少一个 C/C++ 源文件。');
  }

  return validated.map((file) => {
    // Read from the checked descriptor, rejecting replacement between validation and open.
    const fd = fs.openSync(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const currentStat = fs.fstatSync(fd);
      requireRegularUnlinkedFile(file.path, currentStat);
      // Windows can report an unavailable device ID (0) for path-based stat.
      const deviceChanged = currentStat.dev !== 0 && file.stat.dev !== 0 && currentStat.dev !== file.stat.dev;
      if (deviceChanged || currentStat.ino !== file.stat.ino
          || !isWithin(canonicalRoot, fs.realpathSync(file.path))) {
        throw new Error(`上传文件在校验后发生变化，请重试: ${file.fileName}`);
      }
      return { path: file.path, fileName: file.fileName, content: fs.readFileSync(fd) };
    } finally {
      fs.closeSync(fd);
    }
  });
}
