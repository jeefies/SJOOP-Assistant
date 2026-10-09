import * as iconv from 'iconv-lite';
import { ByteDiffDetail } from '../types';

/**
 * Normalizes all \r\n and standalone \r to \n in a Buffer.
 * Safe for GB18030/GBK because 0x0D never appears in multi-byte Chinese sequences.
 */
export function normalizeNewlinesBuf(buf: Buffer): Buffer {
  const result: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d) {
      if (i + 1 < buf.length && buf[i + 1] === 0x0a) {
        // Skip 0x0D if followed by 0x0A (turn \r\n into \n)
        continue;
      } else {
        // Standalone \r -> turn into \n
        result.push(0x0a);
      }
    } else {
      result.push(buf[i]);
    }
  }
  return Buffer.from(result);
}

/**
 * Strict byte-by-byte comparison between actual output buffer and expected output buffer.
 * When normalizeNewlines is true, CRLF (\r\n) and LF (\n) differences are unified before byte comparison.
 */
export function compareBytesStrict(
  actualBuf: Buffer,
  expectedBuf: Buffer,
  encoding: string = 'gb18030',
  normalizeNewlines: boolean = true
): ByteDiffDetail {
  const actBuf = normalizeNewlines ? normalizeNewlinesBuf(actualBuf) : actualBuf;
  const expBuf = normalizeNewlines ? normalizeNewlinesBuf(expectedBuf) : expectedBuf;

  if (actBuf.equals(expBuf)) {
    const isNormalized = normalizeNewlines && !actualBuf.equals(expectedBuf);
    return {
      matched: true,
      expectedLength: expBuf.length,
      actualLength: actBuf.length,
      firstDiffOffset: -1,
      message: isNormalized
        ? '输出与标准答案一致 (AC, 已自动统一 CRLF 与 LF 换行符)'
        : '输出与标准答案严格一致 (AC)',
    };
  }

  const minLen = Math.min(actBuf.length, expBuf.length);
  let firstDiffOffset = -1;

  for (let i = 0; i < minLen; i++) {
    if (actBuf[i] !== expBuf[i]) {
      firstDiffOffset = i;
      break;
    }
  }

  if (firstDiffOffset === -1) {
    firstDiffOffset = minLen;
  }

  const expByte = firstDiffOffset < expBuf.length ? expBuf[firstDiffOffset] : undefined;
  const actByte = firstDiffOffset < actBuf.length ? actBuf[firstDiffOffset] : undefined;

  const contextStart = Math.max(0, firstDiffOffset - 15);
  const contextEndExp = Math.min(expBuf.length, firstDiffOffset + 25);
  const contextEndAct = Math.min(actBuf.length, firstDiffOffset + 25);

  const expSlice = expBuf.subarray(contextStart, contextEndExp);
  const actSlice = actBuf.subarray(contextStart, contextEndAct);

  const expDecoded = iconv.decode(expSlice, encoding);
  const actDecoded = iconv.decode(actSlice, encoding);

  const expHex = expByte !== undefined ? `0x${expByte.toString(16).padStart(2, '0').toUpperCase()} (${formatByteChar(expByte)})` : '<EOF>';
  const actHex = actByte !== undefined ? `0x${actByte.toString(16).padStart(2, '0').toUpperCase()} (${formatByteChar(actByte)})` : '<EOF>';

  let msg = `在字节偏移 ${firstDiffOffset} 处不匹配: 期望 ${expHex}, 实际得到 ${actHex}。`;
  if (actBuf.length !== expBuf.length) {
    msg += ` (长度不一致: 期望 ${expBuf.length} 字节, 实际 ${actBuf.length} 字节)`;
  }

  // Helpful hint if raw difference was CRLF
  if (!normalizeNewlines && !actBuf.equals(expBuf)) {
    const testNormalized = normalizeNewlinesBuf(actualBuf).equals(normalizeNewlinesBuf(expectedBuf));
    if (testNormalized) {
      msg += ` [提示: 差异仅为 Windows CRLF (\\r\\n) 与 Linux/样例 LF (\\n) 换行符差异，建议开启换行符归一化]`;
    }
  }

  return {
    matched: false,
    expectedLength: expBuf.length,
    actualLength: actBuf.length,
    firstDiffOffset,
    expectedByte: expByte,
    actualByte: actByte,
    expectedContext: expDecoded,
    actualContext: actDecoded,
    message: msg,
  };
}

function formatByteChar(b: number): string {
  if (b === 0x0a) return '\\n';
  if (b === 0x0d) return '\\r';
  if (b === 0x09) return '\\t';
  if (b === 0x20) return 'Space';
  if (b >= 32 && b <= 126) return String.fromCharCode(b);
  return 'Non-printable';
}
