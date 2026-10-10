import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, createPrivateKey, generateKeyPairSync } from 'crypto';
import { PassThrough, Writable } from 'stream';
import { spawnSync } from 'child_process';
import { AddressInfo } from 'net';
import { Client, Server, utils } from 'ssh2';
import { LinuxSshDriver, SshConfig } from '../src/compilers/linuxSshDriver';
import { createHostVerifier, quotePosixArgument, validateHostKeyFingerprint } from '../src/security/sshSecurity';

describe('SSH security regressions', () => {
  let tmpDir: string;
  let keyPath: string;
  let encryptedKeyPath: string;
  let privateKey: string;
  let fingerprint: string;
  let sourcePath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sjoop-ssh-security-'));
    // Test-only credentials are generated here; no key from the user's ~/.ssh is read.
    privateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey;
    keyPath = path.join(tmpDir, 'test-private-key');
    encryptedKeyPath = path.join(tmpDir, 'test-encrypted-key');
    sourcePath = path.join(tmpDir, 'main.cpp');
    fs.writeFileSync(keyPath, privateKey);
    fs.writeFileSync(encryptedKeyPath, createPrivateKey(privateKey).export({
      type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'test-only-passphrase',
    }));
    fs.writeFileSync(sourcePath, 'int main() { return 0; }');
    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Test key did not parse');
    fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = (overrides: Partial<SshConfig> = {}): SshConfig => ({
    host: '127.0.0.1', port: 22, studentId: 'test', privateKeyPath: keyPath,
    hostKeyFingerprint: fingerprint, workspaceRoot: tmpDir, remoteDir: '~/sjoop_tmp', flags: [],
    ...overrides,
  });

  it('rejects missing, noncanonical and malformed pins, and verifies raw host keys', () => {
    for (const pin of [undefined, '', 'MD5:aa:bb', 'SHA256:abc', `SHA256:${'A'.repeat(42)}B`]) {
      assert.throws(() => validateHostKeyFingerprint(pin), /指纹/);
    }
    assert.strictEqual(validateHostKeyFingerprint(`${fingerprint}=`), fingerprint);
    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Test key did not parse');
    assert.strictEqual(createHostVerifier(fingerprint)(parsed.getPublicSSH()), true);
    assert.strictEqual(createHostVerifier(fingerprint)(Buffer.from('another host')), false);
  });

  const withServer = async (run: (port: number, authCount: () => number) => Promise<void>) => {
    let authentications = 0;
    const clients: any[] = [];
    const server = new Server({ hostKeys: [privateKey] });
    server.on('connection', (client) => {
      clients.push(client);
      client.on('error', () => {}); // A rejected host key intentionally closes the handshake.
      client.on('authentication', (ctx) => {
        authentications++;
        if (ctx.method === 'publickey') ctx.accept();
        else ctx.reject(['publickey']);
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (acceptExec) => {
            const stream = acceptExec();
            stream.write('test-platform\ntest-c++\n');
            stream.exit(0);
            stream.end();
          });
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      await run((server.address() as AddressInfo).port, () => authentications);
    } finally {
      clients.forEach((client) => client.end());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  it('accepts only the pinned host during a real SSH handshake and reports the actual address', async () => {
    await withServer(async (port, authCount) => {
      const result = await LinuxSshDriver.testConnection(config({ port }));
      assert.strictEqual(result.success, true, result.message);
      assert.ok(result.message.includes(`127.0.0.1:${port}`), result.message);
      assert.ok(authCount() > 0);
    });
  });

  it('rejects a different real SSH host before sending authentication', async () => {
    await withServer(async (port, authCount) => {
      const otherPin = `SHA256:${createHash('sha256').update('another server').digest('base64').replace(/=+$/, '')}`;
      const result = await LinuxSshDriver.testConnection(config({ port, hostKeyFingerprint: otherPin }));
      assert.strictEqual(result.success, false);
      assert.match(result.message, /verification failed/i);
      assert.strictEqual(authCount(), 0);
    });
  });

  it('authenticates with a test encrypted key and an explicitly supplied passphrase', async () => {
    await withServer(async (port) => {
      const result = await LinuxSshDriver.testConnection(config({
        port, privateKeyPath: encryptedKeyPath, passphrase: 'test-only-passphrase',
      }));
      assert.strictEqual(result.success, true, result.message);
    });
  });

  it('keeps shell metacharacters, spaces, quotes and newlines in a single literal argument', function () {
    const candidates = process.platform === 'win32'
      ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe']
      : ['/bin/sh'];
    const shell = candidates.find((candidate) => fs.existsSync(candidate));
    if (!shell) this.skip();
    const values = ["a b's.cpp", '$(printf injected)', '`printf injected`', '; printf injected', 'line\nnext', '-DNAME="hello world"'];
    const result = spawnSync(shell!, ['-c', `printf '%s\\0' ${values.map(quotePosixArgument).join(' ')}`], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(result.stdout.split('\0').slice(0, -1), values);
  });

  describe('preflight and upload failures', () => {
    const originalConnect = Client.prototype.connect;
    const originalEnd = Client.prototype.end;
    const originalExec = Client.prototype.exec;
    const originalSftp = Client.prototype.sftp;
    let commands: string[];
    let connected: number;
    let uploadError: boolean;
    let mkdirCode: number;
    let uploaded: Buffer[];
    let beforeReady: (() => void) | undefined;

    beforeEach(() => {
      commands = [];
      connected = 0;
      uploadError = false;
      mkdirCode = 0;
      uploaded = [];
      beforeReady = undefined;
      (Client.prototype.connect as any) = function (this: Client) {
        connected++;
        beforeReady?.();
        process.nextTick(() => this.emit('ready'));
        return this;
      };
      (Client.prototype.end as any) = function (this: Client) {
        process.nextTick(() => this.emit('close'));
        return this;
      };
      (Client.prototype.exec as any) = function (this: Client, command: string, callback: any) {
        commands.push(command);
        const stream: any = new PassThrough();
        stream.stderr = new PassThrough();
        callback(null, stream);
        process.nextTick(() => {
          if (command.startsWith('printf ')) stream.emit('data', Buffer.from('/home/utest'));
          const code = command.startsWith('mkdir ') ? mkdirCode : 0;
          if (code) stream.stderr.emit('data', Buffer.from('permission denied'));
          stream.emit('close', code);
        });
        return this;
      };
      (Client.prototype.sftp as any) = function (this: Client, callback: any) {
        process.nextTick(() => callback(null, {
          createWriteStream: () => new Writable({
            write(chunk, _encoding, done) {
              uploaded.push(Buffer.from(chunk));
              done(uploadError ? new Error('SFTP write denied') : undefined);
            },
          }),
        }));
        return this;
      };
    });

    afterEach(() => {
      Client.prototype.connect = originalConnect;
      Client.prototype.end = originalEnd;
      Client.prototype.exec = originalExec;
      Client.prototype.sftp = originalSftp;
      fs.writeFileSync(sourcePath, 'int main() { return 0; }');
    });

    it('never connects when an explicit private key is missing or invalid', async () => {
      for (const privateKeyPath of [undefined, '', path.join(tmpDir, 'missing-key'), tmpDir]) {
        const result = await LinuxSshDriver.testConnection(config({ privateKeyPath }));
        assert.strictEqual(result.success, false);
        assert.match(result.message, /私钥/);
      }
      assert.strictEqual(connected, 0);
    });

    it('never connects without a trusted host fingerprint', async () => {
      const result = await LinuxSshDriver.testConnection(config({ hostKeyFingerprint: undefined }));
      assert.strictEqual(result.success, false);
      assert.strictEqual(connected, 0);
    });

    it('rejects an unsafe source manifest before checking the private key or connecting', async () => {
      const result = await LinuxSshDriver.compileAndRun(config({ privateKeyPath: '' }), [keyPath], 'main', []);
      assert.strictEqual(result.compileResult.success, false);
      assert.match(result.compileResult.errorMessage!, /仅允许上传/);
      assert.strictEqual(connected, 0);
    });

    it('rejects output path traversal before connecting', async () => {
      for (const outputName of ['../escape', '..\\escape', '..', '/tmp/escape']) {
        const result = await LinuxSshDriver.compileAndRun(config(), [sourcePath], outputName, []);
        assert.strictEqual(result.compileResult.success, false);
        assert.match(result.compileResult.errorMessage!, /输出名称/);
      }
      assert.strictEqual(connected, 0);
    });

    it('never uploads the selected private key even when it has a permitted source extension', async () => {
      const disguisedKey = path.join(tmpDir, 'private-key.cpp');
      fs.writeFileSync(disguisedKey, privateKey);
      const result = await LinuxSshDriver.compileAndRun(config({ privateKeyPath: disguisedKey }), [sourcePath, disguisedKey], 'main', []);
      assert.strictEqual(result.compileResult.success, false);
      assert.match(result.compileResult.errorMessage!, /不能将 SSH 私钥/);
      assert.strictEqual(connected, 0);
      assert.deepStrictEqual(uploaded, []);
    });

    it('settles a failed SFTP upload and never starts the compiler', async () => {
      uploadError = true;
      const result = await LinuxSshDriver.compileAndRun(config(), [sourcePath], 'main', []);
      assert.strictEqual(result.compileResult.success, false);
      assert.match(result.compileResult.errorMessage!, /上传 main\.cpp 失败: SFTP write denied/);
      assert.strictEqual(commands.some((command) => command.includes('&& c++ ')), false);
      assert.deepStrictEqual(result.runResults, []);
    });

    it('stops before uploading when remote directory creation fails', async () => {
      mkdirCode = 1;
      const result = await LinuxSshDriver.compileAndRun(config(), [sourcePath], 'main', []);
      assert.strictEqual(result.compileResult.success, false);
      assert.match(result.compileResult.errorMessage!, /创建远程目录失败/);
      assert.deepStrictEqual(uploaded, []);
    });

    it('uploads the validated snapshot without rereading a later changed path', async () => {
      beforeReady = () => fs.writeFileSync(sourcePath, 'changed after preflight');
      const result = await LinuxSshDriver.compileAndRun(config(), [sourcePath], 'main', []);
      assert.strictEqual(result.compileResult.success, true, result.compileResult.errorMessage);
      assert.strictEqual(Buffer.concat(uploaded).toString(), 'int main() { return 0; }');
    });

    it('quotes remote directories, output names and each compiler flag independently', async () => {
      const outputName = "main's $(printf injected)";
      const remoteDir = "/tmp/a b's $(printf injected)";
      const flag = '-DNAME=$(printf injected)';
      const result = await LinuxSshDriver.compileAndRun(config({ remoteDir, flags: [flag] }), [sourcePath], outputName, []);
      assert.strictEqual(result.compileResult.success, true, result.compileResult.errorMessage);
      const remoteBase = path.posix.join(remoteDir, outputName);
      assert.ok(commands.includes(`mkdir -p -- ${quotePosixArgument(remoteBase)}`));
      assert.ok(commands.includes(`cd ${quotePosixArgument(remoteBase)} && c++ ${quotePosixArgument(flag)} '-o' ${quotePosixArgument(path.posix.join(remoteBase, `${outputName}_linux`))} './main.cpp'`));
    });
  });
});
