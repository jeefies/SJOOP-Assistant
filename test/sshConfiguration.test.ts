import { vscodeMock } from './mockVscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateKeyPairSync } from 'crypto';
import { createSshConfig } from '../src/security/sshConfiguration';
import { SidebarWebviewProvider } from '../src/webview/sidebarWebviewProvider';
import { LinuxSshDriver } from '../src/compilers/linuxSshDriver';
import { CompilerRunner } from '../src/compilers/runner';

describe('SSH configuration and sidebar security', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sjoop-config-security-'));
  const plainKey = path.join(tmp, 'course.key');
  const encryptedKey = path.join(tmp, 'encrypted.key');
  const source = path.join(tmp, 'main.cpp');
  const passphrase = 'test-only-passphrase';
  const fingerprint = `SHA256:${Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')}`;
  const originalInput = vscodeMock.window.showInputBox;
  const originalConfiguration = vscodeMock.workspace.getConfiguration;
  const originalTestConnection = LinuxSshDriver.testConnection;
  const originalExecuteBatch = CompilerRunner.executeBatch;
  let prompts: any[] = [];

  before(() => {
    fs.writeFileSync(source, 'int main() { return 0; }');
    fs.writeFileSync(plainKey, generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey);
    fs.writeFileSync(encryptedKey, generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey);
  });

  beforeEach(() => {
    prompts = [];
    vscodeMock.workspace.isTrusted = true;
    vscodeMock.window.showInputBox = async (options) => { prompts.push(options); return passphrase; };
  });

  afterEach(() => {
    vscodeMock.window.showInputBox = originalInput;
    vscodeMock.workspace.getConfiguration = originalConfiguration;
    vscodeMock.workspace.isTrusted = true;
    LinuxSshDriver.testConnection = originalTestConnection;
    CompilerRunner.executeBatch = originalExecuteBatch;
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function configuration(overrides: Record<string, unknown> = {}): any {
    const user: Record<string, unknown> = {
      'linux.privateKeyPath': plainKey,
      'linux.hostKeyFingerprint': fingerprint,
      'linux.host': 'course.example.test',
      'linux.port': 2222,
      ...overrides,
    };
    return {
      // A project may supply attacker-controlled settings, but inspect also
      // exposes the trusted user's values independently of those overrides.
      get: (key: string, fallback: unknown) => {
        if (key === 'studentId') return '123456';
        if (key.startsWith('linux.')) return key === 'linux.flags' ? [] : 'project-controlled';
        return fallback;
      },
      inspect: (key: string) => ({ globalValue: user[key], workspaceValue: 'project-controlled' }),
      update: async () => { throw new Error('Must not persist credentials'); },
    };
  }

  it('ignores project overrides of the host, port, key and fingerprint', async () => {
    const result = await createSshConfig(configuration(), '123456', tmp);
    assert.strictEqual(result.host, 'course.example.test');
    assert.strictEqual(result.port, 2222);
    assert.strictEqual(result.privateKeyPath, plainKey);
    assert.strictEqual(result.hostKeyFingerprint, fingerprint);
    assert.strictEqual(result.workspaceRoot, tmp);
    assert.strictEqual(result.passphrase, undefined);
    assert.strictEqual(prompts.length, 0);
  });

  it('passes an encrypted key passphrase only through the native password prompt', async () => {
    const result = await createSshConfig(configuration({ 'linux.privateKeyPath': encryptedKey }), '123456');
    assert.strictEqual(result.passphrase, passphrase);
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].password, true);
    assert.strictEqual(prompts[0].value, undefined);
  });

  it('cancelling the password prompt cancels the connection', async () => {
    vscodeMock.window.showInputBox = async () => undefined;
    await assert.rejects(createSshConfig(configuration({ 'linux.privateKeyPath': encryptedKey }), '123456'), /取消/);
  });

  it('requires an explicit key and configured fingerprint', async () => {
    await assert.rejects(createSshConfig(configuration({ 'linux.privateKeyPath': '' }), '123456'), /私钥/);
    await assert.rejects(createSshConfig(configuration({ 'linux.privateKeyPath': path.join(tmp, 'missing') }), '123456'), /私钥/);
    await assert.rejects(createSshConfig(configuration({ 'linux.hostKeyFingerprint': '' }), '123456'), /指纹/);
    assert.strictEqual(prompts.length, 0);
  });

  it('refuses untrusted workspaces before prompting or connecting', async () => {
    vscodeMock.workspace.isTrusted = false;
    await assert.rejects(createSshConfig(configuration({ 'linux.privateKeyPath': encryptedKey }), '123456'), /信任/);
    assert.strictEqual(prompts.length, 0);
  });

  it('cancels if trust is revoked while the password prompt is open', async () => {
    vscodeMock.window.showInputBox = async () => {
      vscodeMock.workspace.isTrusted = false;
      return passphrase;
    };
    await assert.rejects(createSshConfig(configuration({ 'linux.privateKeyPath': encryptedKey }), '123456'), /信任/);
  });

  it('the sidebar test command passes the encrypted key and emits no passphrase', async () => {
    const cfg = configuration({ 'linux.privateKeyPath': encryptedKey });
    cfg.update = async () => {};
    vscodeMock.workspace.getConfiguration = () => cfg;
    let captured: any;
    LinuxSshDriver.testConnection = async (config) => {
      captured = config;
      return { success: true, message: 'Verified test connection' };
    };
    const provider = new SidebarWebviewProvider({ fsPath: tmp } as any);
    const messages: any[] = [];
    (provider as any)._view = { webview: { postMessage: (message: any) => messages.push(message) } };
    await provider.handleTestSSH('123456');
    assert.strictEqual(captured.passphrase, passphrase);
    assert.strictEqual(captured.hostKeyFingerprint, fingerprint);
    assert.strictEqual(JSON.stringify(messages).includes(passphrase), false);
    assert.strictEqual(JSON.stringify(messages).includes('PRIVATE KEY'), false);
  });

  it('multi-file JSON cannot choose the remote upload root', async () => {
    vscodeMock.workspace.getConfiguration = () => configuration();
    const provider = new SidebarWebviewProvider({ fsPath: tmp } as any);
    (provider as any).currentFilePath = source;
    (provider as any).currentProjectConfig = {
      mode: 'multi', mainFile: 'C:/external/stolen.cpp', additionalFiles: ['C:/external/stolen.cpp'],
    };
    (provider as any).selectedCompilers = { msvc: false, mingw: false, linux: true };
    let captured: any;
    CompilerRunner.executeBatch = async (options) => {
      captured = options;
      return { compilations: { msvc: undefined, mingw: undefined, linux: undefined }, runs: { msvc: [], mingw: [], linux: [] } };
    };
    await provider.handleRunBatch();
    assert.strictEqual(captured.workspaceRoot, tmp);
    assert.strictEqual(captured.sshConfig.workspaceRoot, tmp);
    assert.deepStrictEqual(captured.sources, ['C:/external/stolen.cpp']);
  });

  it('local compiler use does not require or prompt for SSH credentials', async () => {
    vscodeMock.workspace.getConfiguration = () => configuration({ 'linux.privateKeyPath': '', 'linux.hostKeyFingerprint': '' });
    const provider = new SidebarWebviewProvider({ fsPath: tmp } as any);
    (provider as any).currentFilePath = source;
    (provider as any).selectedCompilers = { msvc: true, mingw: false, linux: false };
    let called = false;
    CompilerRunner.executeBatch = async (options) => {
      called = true;
      assert.strictEqual(options.sshConfig, undefined);
      return { compilations: { msvc: undefined, mingw: undefined, linux: undefined }, runs: { msvc: [], mingw: [], linux: [] } };
    };
    await provider.handleRunBatch();
    assert.strictEqual(called, true);
    assert.strictEqual(prompts.length, 0);
  });
});
