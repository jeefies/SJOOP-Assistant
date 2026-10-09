import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as iconv from 'iconv-lite';
import * as chardet from 'chardet';
import { EncodingCheckResult } from '../types';

let cachedSystemEncoding: string | null = null;

/**
 * Detect default system active code page / encoding on the machine
 */
export function getSystemEncoding(): string {
  if (cachedSystemEncoding) {
    return cachedSystemEncoding;
  }

  if (process.platform === 'win32') {
    try {
      const output = cp.execSync('chcp', { encoding: 'utf-8', timeout: 2000 }).trim();
      // Output format: "活动代码页: 936" or "Active code page: 936"
      const match = output.match(/(\d+)/);
      if (match) {
        const cpNum = match[1];
        if (cpNum === '936') {
          cachedSystemEncoding = 'CP936 (GBK)';
          return cachedSystemEncoding;
        } else if (cpNum === '65001') {
          cachedSystemEncoding = 'CP65001 (UTF-8)';
          return cachedSystemEncoding;
        } else if (cpNum === '54936') {
          cachedSystemEncoding = 'CP54936 (GB18030)';
          return cachedSystemEncoding;
        } else {
          cachedSystemEncoding = `CP${cpNum}`;
          return cachedSystemEncoding;
        }
      }
    } catch {
      // fallback
    }
  }

  const lang = process.env.LANG || process.env.LC_ALL || '';
  if (/gb18030/i.test(lang)) {
    cachedSystemEncoding = 'GB18030';
  } else if (/gbk|cp936/i.test(lang)) {
    cachedSystemEncoding = 'GBK';
  } else if (/utf-?8/i.test(lang)) {
    cachedSystemEncoding = 'UTF-8';
  } else {
    cachedSystemEncoding = 'Unknown (Default: CP936/GBK on Chinese Win)';
  }

  return cachedSystemEncoding;
}

/**
 * Inspect buffer bytes and determine the most likely encoding:
 * 'ascii', 'utf-8-bom', 'utf-8', 'gb18030', or 'unknown'
 */
export function detectBufferEncoding(buf: Buffer): { encoding: string; hasBom: boolean; isPureAscii: boolean } {
  if (buf.length === 0) {
    return { encoding: 'ascii', hasBom: false, isPureAscii: true };
  }

  // 1. Check for UTF-8 BOM: 0xEF 0xBB 0xBF
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8-bom', hasBom: true, isPureAscii: false };
  }

  // 2. Check for UTF-16 BOMs
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) {
      return { encoding: 'utf-16le', hasBom: true, isPureAscii: false };
    }
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      return { encoding: 'utf-16be', hasBom: true, isPureAscii: false };
    }
  }

  // 3. Check if buffer is pure ASCII (all bytes <= 0x7F)
  let isPureAscii = true;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) {
      isPureAscii = false;
      break;
    }
  }

  if (isPureAscii) {
    // Pure ASCII is compatible with both UTF-8 and GB18030
    return { encoding: 'ascii', hasBom: false, isPureAscii: true };
  }

  // 4. Test UTF-8 strict validity
  // In Node.js, if buf is valid UTF-8, Buffer.from(buf.toString('utf-8'), 'utf-8') will strictly match buf.
  const utf8String = buf.toString('utf-8');
  const utf8Reencoded = Buffer.from(utf8String, 'utf-8');
  const isValidUtf8 = utf8Reencoded.equals(buf);

  // 5. Test GB18030 decoding & re-encoding roundtrip
  let isValidGb18030 = false;
  try {
    const gbDecoded = iconv.decode(buf, 'gb18030');
    // If it contains  (U+FFFD), it failed to decode valid GB18030 bytes
    if (!gbDecoded.includes('\ufffd')) {
      const gbReencoded = iconv.encode(gbDecoded, 'gb18030');
      if (gbReencoded.equals(buf)) {
        isValidGb18030 = true;
      }
    }
  } catch {
    isValidGb18030 = false;
  }

  if (isValidUtf8 && !isValidGb18030) {
    return { encoding: 'utf-8', hasBom: false, isPureAscii: false };
  }

  if (isValidGb18030 && !isValidUtf8) {
    return { encoding: 'gb18030', hasBom: false, isPureAscii: false };
  }

  // If both or neither match roundtrip, consult chardet
  const chardetResult = chardet.detect(buf);
  if (chardetResult) {
    const lower = chardetResult.toLowerCase();
    if (lower.includes('gb') || lower.includes('chinese')) {
      return { encoding: 'gb18030', hasBom: false, isPureAscii: false };
    }
    if (lower.includes('utf-8')) {
      return { encoding: 'utf-8', hasBom: false, isPureAscii: false };
    }
  }

  if (isValidGb18030) {
    return { encoding: 'gb18030', hasBom: false, isPureAscii: false };
  }

  return { encoding: isValidUtf8 ? 'utf-8' : 'unknown', hasBom: false, isPureAscii: false };
}

/**
 * Check encoding of a file on disk
 */
export function checkFileEncoding(filePath: string, targetCharset: string = 'gb18030'): EncodingCheckResult {
  const systemEncoding = getSystemEncoding();

  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      encoding: 'not_found',
      isTargetEncoding: false,
      hasBom: false,
      systemEncoding,
      message: '文件不存在',
    };
  }

  try {
    const buf = fs.readFileSync(filePath);
    const { encoding, hasBom, isPureAscii } = detectBufferEncoding(buf);

    const normTarget = targetCharset.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normDetected = encoding.toLowerCase().replace(/[^a-z0-9]/g, '');

    // ASCII is accepted as target compatible
    const isTarget =
      isPureAscii ||
      normDetected === normTarget ||
      (normTarget === 'gb18030' && (normDetected === 'gbk' || normDetected === 'gb2312'));

    let message = '';
    if (isPureAscii) {
      message = '文件仅包含 ASCII 字符，完全兼容 GB18030。';
    } else if (hasBom) {
      message = `检测到 ${encoding.toUpperCase()}（含 BOM），SJ 课程不允许使用 UTF 编码！`;
    } else if (!isTarget) {
      message = `检测到文件为 ${encoding.toUpperCase()} 编码！SJ 课程红线要求必须使用 GB18030 / GBK 编码！`;
    } else {
      message = '文件编码正常（符合 GB18030 要求）。';
    }

    return {
      filePath,
      encoding,
      isTargetEncoding: isTarget,
      hasBom,
      systemEncoding,
      message,
    };
  } catch (err: any) {
    return {
      filePath,
      encoding: 'error',
      isTargetEncoding: false,
      hasBom: false,
      systemEncoding,
      message: `读取失败: ${err.message}`,
    };
  }
}

/**
 * Convert a file to GB18030 encoding in-place
 */
export function convertFileToGB18030(filePath: string): { success: boolean; message: string } {
  if (!fs.existsSync(filePath)) {
    return { success: false, message: '文件不存在' };
  }

  try {
    const buf = fs.readFileSync(filePath);
    const { encoding, hasBom } = detectBufferEncoding(buf);

    let contentString = '';

    if (hasBom && encoding === 'utf-8-bom') {
      contentString = buf.subarray(3).toString('utf-8');
    } else if (encoding.startsWith('utf-16')) {
      contentString = iconv.decode(buf, encoding);
    } else if (encoding === 'utf-8') {
      contentString = buf.toString('utf-8');
    } else if (encoding === 'gb18030' || encoding === 'gbk' || encoding === 'ascii') {
      return { success: true, message: '文件已经是 GB18030 / ASCII 编码，无需转换。' };
    } else {
      // Attempt UTF-8 decoding fallback
      contentString = buf.toString('utf-8');
    }

    // Encode string to GB18030 bytes
    const gbBuf = iconv.encode(contentString, 'gb18030');

    // Write back atomically
    const tempPath = `${filePath}.tmp_${Date.now()}`;
    fs.writeFileSync(tempPath, gbBuf);
    fs.renameSync(tempPath, filePath);

    return { success: true, message: `成功将 ${path.basename(filePath)} 转为 GB18030 编码！` };
  } catch (err: any) {
    return { success: false, message: `转换失败: ${err.message}` };
  }
}
