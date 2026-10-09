import './mockVscode';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { SidebarWebviewProvider } from '../src/webview/sidebarWebviewProvider';

describe('Webview UI Automated Test Suite (JSDOM)', () => {
  let html: string;
  let provider: SidebarWebviewProvider;

  before(() => {
    provider = new SidebarWebviewProvider({ fsPath: '/mock/uri' } as any);
    html = provider._getHtmlForWebview();
  });

  it('should generate complete HTML document with required UI containers', () => {
    assert.ok(html.includes('<!DOCTYPE html>'), 'Must start with <!DOCTYPE html>');
    assert.ok(html.includes('id="activeFileName"'), 'Missing activeFileName element');
    assert.ok(html.includes('id="systemEncText"'), 'Missing systemEncText element');
    assert.ok(html.includes('id="encodingBadge"'), 'Missing encodingBadge element');
    assert.ok(html.includes('id="btnShowLogs"'), 'Missing btnShowLogs element');
    assert.ok(html.includes('id="btnModeSingle"'), 'Missing btnModeSingle element');
    assert.ok(html.includes('id="btnModeMulti"'), 'Missing btnModeMulti element');
    assert.ok(html.includes('id="btnAddSource"'), 'Missing btnAddSource element');
    assert.ok(html.includes('id="sourceFileList"'), 'Missing sourceFileList element');
    assert.ok(html.includes('id="txtStudentId"'), 'Missing txtStudentId input');
    assert.ok(html.includes('id="btnTestSSH"'), 'Missing btnTestSSH button');
    assert.ok(html.includes('id="btnRunBatch"'), 'Missing btnRunBatch button');
    assert.ok(html.includes('id="caseListContainer"'), 'Missing caseListContainer element');
    assert.ok(html.includes('id="resultCard"'), 'Missing resultCard element');
    assert.ok(html.includes('id="detailModal"'), 'Missing detailModal element');
  });

  it('should pass JavaScript syntax check without template unescape or parsing errors', () => {
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Must contain a valid <script> tag');
    const scriptContent = scriptMatch[1];
    assert.doesNotThrow(() => {
      new Function('acquireVsCodeApi', scriptContent);
    }, 'Webview inline script contains syntax errors!');
  });

  it('should boot in JSDOM, send ready message, and render state updates correctly', (done) => {
    const postedMessages: any[] = [];

    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      resources: 'usable',
      beforeParse(window) {
        (window as any).acquireVsCodeApi = () => ({
          postMessage: (msg: any) => {
            postedMessages.push(msg);
          },
        });
      },
    });

    const window = dom.window;
    const document = window.document;

    // Check ready message was sent immediately on load
    assert.strictEqual(postedMessages.length, 1);
    assert.strictEqual(postedMessages[0].type, 'ready');

    // Simulate backend sending stateUpdate
    window.postMessage(
      {
        type: 'stateUpdate',
        filePath: 'C:\\test\\1.cpp',
        fileName: '1.cpp',
        systemEncoding: 'CP936 (GBK)',
        encodingInfo: {
          filePath: 'C:\\test\\1.cpp',
          encoding: 'gb18030',
          isTargetEncoding: true,
          hasBom: false,
          systemEncoding: 'CP936 (GBK)',
          message: '编码符合要求',
        },
        compilers: { msvc: true, mingw: true, linux: false },
        normalizeNewlines: true,
        compilerPaths: { studentId: '2350000' },
        projectConfig: {
          mode: 'single',
          mainFile: 'C:\\test\\1.cpp',
          additionalFiles: [],
        },
        testCases: [
          {
            id: 'c1',
            name: '测试点 #1',
            input: '1 2\n',
            expectedOutput: '3\n',
            enabled: true,
          },
        ],
        lastRunResult: null,
      },
      '*'
    );

    // Wait for event loop to process postMessage in DOM
    setTimeout(() => {
      try {
        const sysText = document.getElementById('systemEncText');
        assert.ok(sysText, 'systemEncText must exist');
        assert.strictEqual(sysText.textContent, '系统代码页: CP936 (GBK)', 'System encoding must render correctly');

        const activeFile = document.getElementById('activeFileName');
        assert.strictEqual(activeFile?.textContent, '1.cpp');

        const badge = document.getElementById('encodingBadge');
        assert.ok(badge?.className.includes('badge-ok'));
        assert.ok(badge?.textContent?.includes('GB18030'));

        const sidInput = document.getElementById('txtStudentId') as HTMLInputElement;
        assert.strictEqual(sidInput.value, '2350000');

        const caseCount = document.getElementById('caseCount');
        assert.strictEqual(caseCount?.textContent, '1');

        // Test multi-file mode switch
        const btnMulti = document.getElementById('btnModeMulti') as HTMLButtonElement;
        btnMulti.click();
        const lastMsg = postedMessages[postedMessages.length - 1];
        assert.strictEqual(lastMsg.type, 'updateConfig');
        assert.strictEqual(lastMsg.projectConfig.mode, 'multi');

        // Send multi-file state update with additional files
        window.postMessage(
          {
            type: 'stateUpdate',
            projectConfig: {
              mode: 'multi',
              mainFile: 'C:\\test\\1.cpp',
              additionalFiles: ['C:\\test\\2.cpp', 'C:\\test\\helper.h'],
            },
            testCases: [
              {
                id: 'c1',
                name: '测试点 #1',
                input: '1 2\n',
                expectedOutput: '3\n',
                enabled: true,
              },
            ],
          },
          '*'
        );

        setTimeout(() => {
          try {
            const multiSec = document.getElementById('multiFileSection');
            assert.strictEqual(multiSec?.style.display, 'block');

            const sourceList = document.getElementById('sourceFileList');
            assert.strictEqual(sourceList?.children.length, 2, 'Should display 2 additional source files');

            // Click remove on the second file
            const secondItem = sourceList?.children[1];
            const removeBtn = secondItem?.querySelector('button') as HTMLButtonElement;
            assert.ok(removeBtn, 'Remove button must exist');
            removeBtn.click();

            const removeMsg = postedMessages[postedMessages.length - 1];
            assert.strictEqual(removeMsg.type, 'removeAdditionalFile');
            assert.strictEqual(removeMsg.filePath, 'C:\\test\\helper.h');

            // Test SSH button click
            const btnSsh = document.getElementById('btnTestSSH') as HTMLButtonElement;
            btnSsh.click();
            const sshMsg = postedMessages[postedMessages.length - 1];
            assert.strictEqual(sshMsg.type, 'testSSH');
            assert.strictEqual(sshMsg.studentId, '2350000');

            // Test show logs button click
            const btnLogs = document.getElementById('btnShowLogs') as HTMLButtonElement;
            btnLogs.click();
            const logMsg = postedMessages[postedMessages.length - 1];
            assert.strictEqual(logMsg.type, 'showLogs');

            done();
          } catch (err) {
            done(err);
          }
        }, 50);
      } catch (err) {
        done(err);
      }
    }, 50);
  });

  it('should render test run results and detail modal correctly in DOM', (done) => {
    const postedMessages: any[] = [];

    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      resources: 'usable',
      beforeParse(window) {
        (window as any).acquireVsCodeApi = () => ({
          postMessage: (msg: any) => {
            postedMessages.push(msg);
          },
        });
      },
    });

    const window = dom.window;
    const document = window.document;

    // Simulate runComplete message
    window.postMessage(
      {
        type: 'stateUpdate',
        compilers: { msvc: true, mingw: true, linux: false },
        testCases: [
          {
            id: 'case_wa',
            name: '反例测试点',
            input: '1 1\n',
            expectedOutput: '2\n',
            enabled: true,
          },
        ],
      },
      '*'
    );

    setTimeout(() => {
      window.postMessage(
        {
          type: 'runComplete',
          result: {
            timestamp: Date.now(),
            compilations: {
              msvc: { compiler: 'msvc', success: true, compileTimeMs: 120 },
              mingw: { compiler: 'mingw', success: false, compileTimeMs: 90, errorMessage: 'g++: undefined reference to myfunc' },
            },
            runs: {
              msvc: [
                {
                  compiler: 'msvc',
                  testCaseId: 'case_wa',
                  status: 'WA',
                  timeMs: 25,
                  exitCode: 0,
                  stdout: '3\n',
                  stderr: '',
                  byteDiff: {
                    matched: false,
                    offset: 0,
                    expectedByteHex: '0x32',
                    actualByteHex: '0x33',
                    message: '在偏移 0 处不匹配: 期望 0x32 (2), 实际得到 0x33 (3)',
                    expectedContext: '2\n',
                    actualContext: '3\n',
                  },
                },
              ],
            },
          },
        },
        '*'
      );

      setTimeout(() => {
        try {
          const resultCard = document.getElementById('resultCard');
          assert.strictEqual(resultCard?.style.display, 'block');

          const resultBody = document.getElementById('resultBody');
          assert.strictEqual(resultBody?.children.length, 1, 'Should have 1 result row');

          // Check MSVC WA pill
          const msvcPill = resultBody?.querySelector('.pill-wa') as HTMLElement;
          assert.ok(msvcPill, 'Should render pill-wa for MSVC run');
          assert.ok(msvcPill.textContent?.includes('WA'));

          // Click MSVC WA pill -> detail modal should open
          msvcPill.click();

          const detailModal = document.getElementById('detailModal');
          assert.strictEqual(detailModal?.style.display, 'block', 'Detail modal must open on pill click');

          const modalContent = document.getElementById('modalContent');
          assert.ok(modalContent?.textContent?.includes('在偏移 0 处不匹配'), 'Modal content must show diff message');

          // Close modal
          const btnClose = document.getElementById('btnCloseModal') as HTMLButtonElement;
          btnClose.click();
          assert.strictEqual(detailModal?.style.display, 'none', 'Modal should close on close button click');

          // Check MinGW CE pill
          const cePill = resultBody?.querySelector('.pill-ce') as HTMLElement;
          assert.ok(cePill, 'Should render pill-ce for MinGW');
          cePill.click();
          assert.strictEqual(detailModal?.style.display, 'block');
          assert.ok(modalContent?.textContent?.includes('undefined reference'), 'Modal should show compiler error');

          done();
        } catch (err) {
          done(err);
        }
      }, 50);
    }, 50);
  });
});
