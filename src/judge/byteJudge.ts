import * as iconv from 'iconv-lite';
import { ByteDiffDetail, JudgeStatus } from '../types';

/**
 * Strict byte-by-byte comparison between actual output buffer and expected output buffer.
 */
export function compareBytesStrict(
  actualBuf: Buffer,
  expectedBuf: Buffer,
  encoding: string = 'gb18030'
): ByteDiffDetail {
  if (actualBuf.equals(expectedBuf)) {
    return {
      matched: true,
      expectedLength: expectedBuf.length,
      actualLength: actualBuf.length,
      firstDiffOffset: -1,
      message: '输出与标准答案严格一致 (AC)',
    };
  }

  const minLen = Math.min(actualBuf.length, expectedBuf.length);
  let firstDiffOffset = -1;

  for (let i = 0; i < minLen; i++) {
    if (actualBuf[i] !== expectedBuf[i]) {
      firstDiffOffset = i;
      break;
    }
  }

  if (firstDiffOffset === -1) {
    // One buffer is a prefix of the other, differed at minLen
    firstDiffOffset = minLen;
  }

  const expByte = firstDiffOffset < expectedBuf.length ? expectedBuf[firstDiffOffset] : undefined;
  const actByte = firstDiffOffset < actualBuf.length ? actualBuf[firstDiffOffset] : undefined;

  // Generate context strings around the diff offset
  const contextStart = Math.max(0, firstDiffOffset - 15);
  const contextEndExp = Math.min(expectedBuf.length, firstDiffOffset + 25);
  const contextEndAct = Math.min(actualBuf.length, firstDiffOffset + 25);

  const expSlice = expectedBuf.subarray(contextStart, contextEndExp);
  const actSlice = actualBuf.subarray(contextStart, contextEndAct);

  const expDecoded = iconv.decode(expSlice, encoding);
  const actDecoded = iconv.decode(actSlice, encoding);

  const expHex = expByte !== undefined ? `0x${expByte.toString(16).padStart(2, '0').toUpperCase()} (${formatByteChar(expByte)})` : '<EOF>';
  const actHex = actByte !== undefined ? `0x${actByte.toString(16).padStart(2, '0').toUpperCase()} (${formatByteChar(actByte)})` : '<EOF>';

  let msg = `在字节偏移 ${firstDiffOffset} 处不匹配: 期望 ${expHex}, 实际得到 ${actHex}。`;
  if (actualBuf.length !== expectedBuf.length) {
    msg += ` (长度不一致: 期望 ${expectedBuf.length} 字节, 实际 ${actualBuf.length} 字节)`;
  }

  return {
    matched: false,
    expectedLength: expectedBuf.length,
    actualLength: actualBuf.length,
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
