import { createHash, timingSafeEqual } from 'crypto';

/** Accept the SHA256 fingerprint printed by OpenSSH, never an unverified first connection. */
export function validateHostKeyFingerprint(value: string | undefined): string {
  const fingerprint = typeof value === 'string' ? value.trim() : '';
  const match = /^SHA256:([A-Za-z0-9+/]{43}=?)$/.exec(fingerprint);
  if (!match) {
    throw new Error('请先配置可信来源提供的 SSH 主机 SHA256 指纹（SHA256:...）。');
  }
  const digest = Buffer.from(match[1], 'base64');
  const canonical = digest.toString('base64').replace(/=+$/, '');
  if (digest.length !== 32 || canonical !== match[1].replace(/=+$/, '')) {
    throw new Error('SSH 主机 SHA256 指纹格式无效，请核对可信来源的指纹。');
  }
  return `SHA256:${canonical}`;
}

export function createHostVerifier(fingerprint: string | undefined): (key: Buffer) => boolean {
  const expected = Buffer.from(validateHostKeyFingerprint(fingerprint).slice(7), 'base64');
  // ssh2 supplies the raw SSH public-key blob when hostHash is not set.
  return (key: Buffer) => Buffer.isBuffer(key) &&
    timingSafeEqual(createHash('sha256').update(key).digest(), expected);
}

/** One argument for a POSIX shell, including embedded quotes and shell metacharacters. */
export function quotePosixArgument(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('远程命令参数包含无效字符。');
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function validateOutputBaseName(value: string): void {
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new Error('输出名称必须是文件名，不能包含目录或路径穿越。');
  }
}
