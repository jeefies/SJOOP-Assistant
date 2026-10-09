import './mockVscode';
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SidebarWebviewProvider } from '../src/webview/sidebarWebviewProvider';
import { CaseManager } from '../src/storage/caseManager';

describe('SidebarWebviewProvider State & Multi-file Retention Suite', () => {
  const tmpDir = path.join(os.tmpdir(), `sjoop_provider_test_${Date.now()}`);
  let provider: SidebarWebviewProvider;
  let postedMessages: any[] = [];
  let messageHandler: ((msg: any) => Promise<void>) | null = null;

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

  function setupProvider(): SidebarWebviewProvider {
    postedMessages = [];
    messageHandler = null;
    const p = new SidebarWebviewProvider({ fsPath: '/mock/uri' } as any);

    const mockWebview: any = {
      options: {},
      html: '',
      postMessage: (msg: any) => {
        postedMessages.push(msg);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (cb: any) => {
        messageHandler = cb;
        return { dispose: () => {} };
      },
    };

    const mockWebviewView: any = {
      visible: true,
      webview: mockWebview,
      onDidChangeVisibility: () => ({ dispose: () => {} }),
    };

    p.resolveWebviewView(mockWebviewView, {} as any, {} as any);
    return p;
  }

  it('should initialize and respond to ready with stateUpdate', async () => {
    provider = setupProvider();
    assert.ok(messageHandler, 'Message handler should be registered');

    await messageHandler!({ type: 'ready' });
    const lastMsg = postedMessages[postedMessages.length - 1];
    assert.strictEqual(lastMsg?.type, 'stateUpdate');
    assert.strictEqual(lastMsg?.projectConfig?.mode, 'single');
  });

  it('should lock multi-file mode and post activeFileChanged on setActiveFile instead of resetting to single', async () => {
    provider = setupProvider();
    const file1 = path.join(tmpDir, '1.cpp');
    const file2 = path.join(tmpDir, '2.cpp');
    fs.writeFileSync(file1, 'int main() {}');
    fs.writeFileSync(file2, 'void helper() {}');

    // 1. Initially set active file 1.cpp in single mode
    provider.setActiveFile(file1);
    let lastMsg = postedMessages[postedMessages.length - 1];
    assert.strictEqual(lastMsg?.type, 'stateUpdate');
    assert.strictEqual(lastMsg?.fileName, '1.cpp');

    // 2. Switch to multi-file mode with [1.cpp, 2.cpp]
    await messageHandler!({
      type: 'updateConfig',
      projectConfig: {
        mode: 'multi',
        mainFile: file1,
        additionalFiles: [file1, file2],
      },
    });

    lastMsg = postedMessages[postedMessages.length - 1];
    assert.strictEqual(lastMsg?.type, 'stateUpdate');
    assert.strictEqual(lastMsg?.projectConfig?.mode, 'multi');
    assert.strictEqual(lastMsg?.projectConfig?.additionalFiles?.length, 2);

    // 3. Switch focus editor to 2.cpp in multi-file mode
    postedMessages = [];
    provider.setActiveFile(file2);

    // CRITICAL: Must post activeFileChanged (lightweight), NOT full stateUpdate!
    assert.strictEqual(postedMessages.length, 1);
    const focusMsg = postedMessages[0];
    assert.strictEqual(focusMsg?.type, 'activeFileChanged');
    assert.strictEqual(focusMsg?.fileName, '2.cpp');

    // 4. Switching focus to null (e.g. blurred or clicked webview) does not reset multi mode
    postedMessages = [];
    provider.setActiveFile(null);
    assert.strictEqual(postedMessages.length, 1);
    assert.strictEqual(postedMessages[0]?.type, 'activeFileChanged');

    // 5. Switching focus back to 1.cpp does not reset multi mode
    postedMessages = [];
    provider.setActiveFile(file1);
    assert.strictEqual(postedMessages.length, 1);
    assert.strictEqual(postedMessages[0]?.type, 'activeFileChanged');
    assert.strictEqual(postedMessages[0]?.fileName, '1.cpp');
  });

  it('should properly persist and restore multi-file project configuration', async () => {
    provider = setupProvider();
    const fileA = path.join(tmpDir, 'projA.cpp');
    const fileB = path.join(tmpDir, 'projB.cpp');
    fs.writeFileSync(fileA, 'int main() {}');
    fs.writeFileSync(fileB, 'int foo() {}');

    provider.setActiveFile(fileA);
    await messageHandler!({
      type: 'updateConfig',
      projectConfig: {
        mode: 'multi',
        mainFile: fileA,
        additionalFiles: [fileA, fileB],
      },
    });

    // Check on disk that .sjoop/projects/projA.json was saved
    const loaded = CaseManager.loadProjectConfig(tmpDir, 'projA', fileA);
    assert.strictEqual(loaded.mode, 'multi');
    assert.strictEqual(loaded.additionalFiles.length, 2);
  });
});
