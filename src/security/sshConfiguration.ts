import * as fs from 'fs';
import * as vscode from 'vscode';
import { utils } from 'ssh2';
import { SshConfig } from '../compilers/linuxSshDriver';
import { validateHostKeyFingerprint } from './sshSecurity';

// Connection identity and credentials must never come from project settings.
export function getUserSshSetting<T>(config: vscode.WorkspaceConfiguration, key: string, fallback: T): T {
  const setting = config.inspect<T>(key);
  return setting?.globalValue ?? setting?.defaultValue ?? fallback;
}

export async function createSshConfig(
  config: vscode.WorkspaceConfiguration,
  studentId: string,
  workspaceRoot?: string
): Promise<SshConfig> {
  if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区，再使用 SSH 连接。');
  const privateKeyPath = getUserSshSetting(config, 'linux.privateKeyPath', '').trim();
  const hostKeyFingerprint = getUserSshSetting(config, 'linux.hostKeyFingerprint', '').trim();
  validateHostKeyFingerprint(hostKeyFingerprint);
  if (!privateKeyPath || !fs.existsSync(privateKeyPath) || !fs.statSync(privateKeyPath).isFile()) {
    throw new Error('请在用户设置中指定有效的 SSH 私钥文件路径；不会自动使用其他密钥。');
  }

  const sshConfig: SshConfig = {
    host: getUserSshSetting(config, 'linux.host', '10.80.42.230').trim(),
    port: getUserSshSetting(config, 'linux.port', 22),
    studentId,
    privateKeyPath,
    hostKeyFingerprint,
    workspaceRoot,
    remoteDir: config.get<string>('linux.remoteDir', '~/sjoop_tmp'),
    flags: config.get<string[]>('linux.flags', []),
  };

  // Detect encrypted OpenSSH/PEM keys using the same parser as the SSH client.
  const parsed = utils.parseKey(fs.readFileSync(privateKeyPath));
  if (parsed instanceof Error) {
    if (!/encrypted.*passphrase/i.test(parsed.message)) {
      throw new Error('SSH 私钥格式无效，请检查指定的私钥文件。');
    }
    const passphrase = await vscode.window.showInputBox({
      title: 'SJOOP: SSH 私钥口令',
      prompt: '输入加密私钥的口令，仅用于本次连接，不会保存到设置或发送到侧栏。',
      password: true,
      ignoreFocusOut: true,
    });
    if (passphrase === undefined) {
      throw new Error('已取消 SSH 连接。');
    }
    sshConfig.passphrase = passphrase;
  }
  if (!vscode.workspace.isTrusted) throw new Error('工作区已不受信任，SSH 连接已取消。');
  return sshConfig;
}
