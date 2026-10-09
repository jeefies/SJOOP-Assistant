import './mockVscode';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { SidebarWebviewProvider } from '../src/webview/sidebarWebviewProvider';

describe('Webview UI Comprehensive Automated Test Suite (JSDOM)', () => {
  let html: string;
  let provider: SidebarWebviewProvider;

  before(() => {
    provider = new SidebarWebviewProvider({ fsPath: '/mock/uri' } as any);
    html = provider._getHtmlForWebview();
  });

  interface TestEnv {
    dom: JSDOM;
    window: any;
    document: Document;
    postedMessages: any[];
    dispatchMessage: (data: any) => Promise<void>;
    getLastMessage: () => any;
  }

  function createTestEnv(): Promise<TestEnv> {
    return new Promise((resolve) => {
      const postedMessages: any[] = [];
      const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        resources: 'usable',
        beforeParse(win) {
          (win as any).acquireVsCodeApi = () => ({
            postMessage: (msg: any) => {
              postedMessages.push(msg);
            },
          });
        },
      });

      const window = dom.window as any;
      const document = window.document;

      const dispatchMessage = (data: any): Promise<void> => {
        window.postMessage(data, '*');
        return new Promise((r) => setTimeout(r, 25));
      };

      const getLastMessage = () => postedMessages[postedMessages.length - 1];

      setTimeout(() => {
        resolve({ dom, window, document, postedMessages, dispatchMessage, getLastMessage });
      }, 25);
    });
  }

  describe('1. Static HTML Structure & Script Syntax', () => {
    it('should generate complete HTML document with all required UI containers', () => {
      assert.ok(html.includes('<!DOCTYPE html>'), 'Must start with <!DOCTYPE html>');
      assert.ok(html.includes('id="activeFileName"'), 'Missing activeFileName element');
      assert.ok(html.includes('id="systemEncText"'), 'Missing systemEncText element');
      assert.ok(html.includes('id="encodingBadge"'), 'Missing encodingBadge element');
      assert.ok(html.includes('id="btnShowLogs"'), 'Missing btnShowLogs element');
      assert.ok(html.includes('id="btnConvert"'), 'Missing btnConvert element');
      assert.ok(html.includes('id="btnModeSingle"'), 'Missing btnModeSingle element');
      assert.ok(html.includes('id="btnModeMulti"'), 'Missing btnModeMulti element');
      assert.ok(html.includes('id="btnAddSource"'), 'Missing btnAddSource element');
      assert.ok(html.includes('id="sourceFileList"'), 'Missing sourceFileList element');
      assert.ok(html.includes('id="chkMsvc"'), 'Missing chkMsvc input');
      assert.ok(html.includes('id="chkMingw"'), 'Missing chkMingw input');
      assert.ok(html.includes('id="chkLinux"'), 'Missing chkLinux input');
      assert.ok(html.includes('id="txtStudentId"'), 'Missing txtStudentId input');
      assert.ok(html.includes('id="btnTestSSH"'), 'Missing btnTestSSH button');
      assert.ok(html.includes('id="chkNormalizeNewlines"'), 'Missing chkNormalizeNewlines input');
      assert.ok(html.includes('id="btnRunBatch"'), 'Missing btnRunBatch button');
      assert.ok(html.includes('id="caseListContainer"'), 'Missing caseListContainer element');
      assert.ok(html.includes('id="resultCard"'), 'Missing resultCard element');
      assert.ok(html.includes('id="detailModal"'), 'Missing detailModal element');
      assert.ok(html.includes('id="btnCloseModal"'), 'Missing btnCloseModal element');
    });

    it('should pass JavaScript syntax check without template unescape or parsing errors', () => {
      const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
      assert.ok(scriptMatch, 'Must contain a valid <script> tag');
      const scriptContent = scriptMatch[1];
      assert.doesNotThrow(() => {
        new Function('acquireVsCodeApi', scriptContent);
      }, 'Webview inline script contains syntax errors!');
    });
  });

  describe('2. Initial Boot & Handshake', () => {
    it('should post ready message immediately upon load', async () => {
      const env = await createTestEnv();
      assert.ok(env.postedMessages.length >= 1, 'Must post ready message');
      assert.strictEqual(env.postedMessages[0].type, 'ready');
    });

    it('should display fallback state when no active file is open', async () => {
      const env = await createTestEnv();
      await env.dispatchMessage({
        type: 'stateUpdate',
        filePath: null,
        fileName: null,
        systemEncoding: 'CP936 (GBK)',
        encodingInfo: null,
      });

      const activeFileName = env.document.getElementById('activeFileName');
      assert.strictEqual(activeFileName?.textContent, '未打开 C/C++ 文件');

      const badge = env.document.getElementById('encodingBadge');
      assert.strictEqual(badge?.textContent, '无活动文件');

      const alertBox = env.document.getElementById('encodingAlert');
      assert.strictEqual(alertBox?.style.display, 'none');

      const sysText = env.document.getElementById('systemEncText');
      assert.strictEqual(sysText?.textContent, '系统代码页: CP936 (GBK)');
    });
  });

  describe('3. Encoding Guard Card Interactions', () => {
    it('should display green badge and hide alert when file is GB18030', async () => {
      const env = await createTestEnv();
      await env.dispatchMessage({
        type: 'stateUpdate',
        filePath: 'C:\\code\\main.cpp',
        fileName: 'main.cpp',
        systemEncoding: 'CP936 (GBK)',
        encodingInfo: {
          filePath: 'C:\\code\\main.cpp',
          encoding: 'gb18030',
          isTargetEncoding: true,
          hasBom: false,
          systemEncoding: 'CP936 (GBK)',
          message: '编码符合要求',
        },
      });

      const badge = env.document.getElementById('encodingBadge');
      assert.ok(badge?.className.includes('badge-ok'));
      assert.ok(badge?.textContent?.includes('GB18030 ✅'));

      const alertBox = env.document.getElementById('encodingAlert');
      assert.strictEqual(alertBox?.style.display, 'none');
    });

    it('should display warning badge and show alert box when file is UTF-8', async () => {
      const env = await createTestEnv();
      await env.dispatchMessage({
        type: 'stateUpdate',
        filePath: 'C:\\code\\main.cpp',
        fileName: 'main.cpp',
        systemEncoding: 'CP936 (GBK)',
        encodingInfo: {
          filePath: 'C:\\code\\main.cpp',
          encoding: 'utf-8',
          isTargetEncoding: false,
          hasBom: false,
          systemEncoding: 'CP936 (GBK)',
          message: '检测到文件为 UTF-8 编码！',
        },
      });

      const badge = env.document.getElementById('encodingBadge');
      assert.ok(badge?.className.includes('badge-warn'));
      assert.ok(badge?.textContent?.includes('UTF-8 ⚠️'));

      const alertBox = env.document.getElementById('encodingAlert');
      assert.strictEqual(alertBox?.style.display, 'block');
    });

    it('should post convertEncoding when clicking convert button', async () => {
      const env = await createTestEnv();
      const btnConvert = env.document.getElementById('btnConvert') as HTMLButtonElement;
      btnConvert.click();
      assert.strictEqual(env.getLastMessage()?.type, 'convertEncoding');
    });

    it('should post showLogs when clicking log button', async () => {
      const env = await createTestEnv();
      const btnShowLogs = env.document.getElementById('btnShowLogs') as HTMLButtonElement;
      btnShowLogs.click();
      assert.strictEqual(env.getLastMessage()?.type, 'showLogs');
    });
  });

  describe('4. Project Mode & Multi-File List', () => {
    it('should toggle between single-file and multi-file modes via buttons', async () => {
      const env = await createTestEnv();
      const btnSingle = env.document.getElementById('btnModeSingle') as HTMLButtonElement;
      const btnMulti = env.document.getElementById('btnModeMulti') as HTMLButtonElement;
      const multiSection = env.document.getElementById('multiFileSection');

      // Click Multi
      btnMulti.click();
      assert.strictEqual(env.getLastMessage()?.type, 'updateConfig');
      assert.strictEqual(env.getLastMessage()?.projectConfig?.mode, 'multi');
      assert.strictEqual(multiSection?.style.display, 'block');

      // Click Single
      btnSingle.click();
      assert.strictEqual(env.getLastMessage()?.type, 'updateConfig');
      assert.strictEqual(env.getLastMessage()?.projectConfig?.mode, 'single');
      assert.strictEqual(multiSection?.style.display, 'none');
    });

    it('should post addAdditionalFile when clicking add source button', async () => {
      const env = await createTestEnv();
      const btnAdd = env.document.getElementById('btnAddSource') as HTMLButtonElement;
      btnAdd.click();
      assert.strictEqual(env.getLastMessage()?.type, 'addAdditionalFile');
    });

    it('should render additional files with count, tooltip, and remove button', async () => {
      const env = await createTestEnv();
      await env.dispatchMessage({
        type: 'stateUpdate',
        projectConfig: {
          mode: 'multi',
          mainFile: 'C:\\project\\main.cpp',
          additionalFiles: ['C:\\project\\sub1.cpp', 'C:\\project\\header.h'],
        },
      });

      const count = env.document.getElementById('sourceFileCount');
      assert.strictEqual(count?.textContent, '2');

      const ul = env.document.getElementById('sourceFileList');
      assert.strictEqual(ul?.children.length, 2);

      const firstItem = ul?.children[0];
      const span = firstItem?.querySelector('span');
      assert.strictEqual(span?.title, 'C:\\project\\sub1.cpp');
      assert.strictEqual(span?.textContent, 'sub1.cpp');

      // Click remove on first item
      const removeBtn = firstItem?.querySelector('button') as HTMLButtonElement;
      removeBtn.click();
      assert.strictEqual(env.getLastMessage()?.type, 'removeAdditionalFile');
      assert.strictEqual(env.getLastMessage()?.filePath, 'C:\\project\\sub1.cpp');
    });

    it('should seamlessly update header and encoding on activeFileChanged without destroying DOM elements', async () => {
      const env = await createTestEnv();
      await env.dispatchMessage({
        type: 'stateUpdate',
        fileName: 'main.cpp',
        projectConfig: {
          mode: 'multi',
          mainFile: 'C:\\project\\main.cpp',
          additionalFiles: ['C:\\project\\main.cpp', 'C:\\project\\sub.cpp'],
        },
        testCases: [{ id: 'tc1', name: '测试点 1', input: '1 2\n', expectedOutput: '3\n', enabled: true }],
      });

      const ul = env.document.getElementById('sourceFileList') as HTMLUListElement;
      const caseContainer = env.document.getElementById('caseListContainer') as HTMLDivElement;
      const initialUlItem = ul.children[0];
      const initialCaseItem = caseContainer.children[0];

      assert.ok(initialUlItem, 'Source list item should exist');
      assert.ok(initialCaseItem, 'Case item should exist');

      // Now dispatch activeFileChanged (user focused sub.cpp)
      await env.dispatchMessage({
        type: 'activeFileChanged',
        filePath: 'C:\\project\\sub.cpp',
        fileName: 'sub.cpp',
        systemEncoding: 'CP936',
        encodingInfo: { encoding: 'gb18030', isTargetEncoding: true },
      });

      const activeName = env.document.getElementById('activeFileName');
      const badge = env.document.getElementById('encodingBadge');
      assert.strictEqual(activeName?.textContent, 'sub.cpp');
      assert.strictEqual(badge?.textContent, 'GB18030 ✅');

      // Verify DOM identity is preserved (no flashing or recreation)
      assert.strictEqual(ul.children[0], initialUlItem, 'Source list DOM should NOT be recreated');
      assert.strictEqual(caseContainer.children[0], initialCaseItem, 'Case list DOM should NOT be recreated');
    });

    it('should memoize DOM rendering on identical stateUpdate so existing nodes are preserved', async () => {
      const env = await createTestEnv();
      const payload = {
        type: 'stateUpdate',
        projectConfig: {
          mode: 'multi',
          mainFile: 'C:\\project\\main.cpp',
          additionalFiles: ['C:\\project\\main.cpp'],
        },
        testCases: [{ id: 'tc1', name: '测试点 1', input: 'in\n', expectedOutput: 'out\n', enabled: true }],
      };

      await env.dispatchMessage(payload);
      const ul = env.document.getElementById('sourceFileList') as HTMLUListElement;
      const caseContainer = env.document.getElementById('caseListContainer') as HTMLDivElement;
      const savedUlItem = ul.children[0];
      const savedCaseItem = caseContainer.children[0];

      // Dispatch identical stateUpdate
      await env.dispatchMessage(payload);

      assert.strictEqual(ul.children[0], savedUlItem, 'Source item should be memoized without recreation');
      assert.strictEqual(caseContainer.children[0], savedCaseItem, 'Case item should be memoized without recreation');
    });
  });

  describe('5. Compiler Checkboxes & Settings', () => {
    it('should update compilers state and post updateConfig on checkbox change', async () => {
      const env = await createTestEnv();
      const chkMsvc = env.document.getElementById('chkMsvc') as HTMLInputElement;
      const chkMingw = env.document.getElementById('chkMingw') as HTMLInputElement;
      const chkLinux = env.document.getElementById('chkLinux') as HTMLInputElement;

      // Uncheck MSVC
      chkMsvc.checked = false;
      chkMsvc.dispatchEvent(new env.window.Event('change'));
      assert.strictEqual(env.getLastMessage()?.type, 'updateConfig');
      assert.strictEqual(env.getLastMessage()?.compilers?.msvc, false);

      // Check Linux
      chkLinux.checked = true;
      chkLinux.dispatchEvent(new env.window.Event('change'));
      assert.strictEqual(env.getLastMessage()?.type, 'updateConfig');
      assert.strictEqual(env.getLastMessage()?.compilers?.linux, true);
    });

    it('should post openSettings when clicking settings button', async () => {
      const env = await createTestEnv();
      const btnSettings = env.document.getElementById('btnSettings') as HTMLButtonElement;
      btnSettings.click();
      assert.strictEqual(env.getLastMessage()?.type, 'openSettings');
    });

    it('should toggle normalizeNewlines checkbox and post updateNormalizeNewlines', async () => {
      const env = await createTestEnv();
      const chkNormalize = env.document.getElementById('chkNormalizeNewlines') as HTMLInputElement;
      chkNormalize.checked = false;
      chkNormalize.dispatchEvent(new env.window.Event('change'));
      assert.strictEqual(env.getLastMessage()?.type, 'updateNormalizeNewlines');
      assert.strictEqual(env.getLastMessage()?.normalizeNewlines, false);
    });
  });

  describe('6. Student ID & SSH Connectivity Testing', () => {
    it('should update student ID on input and change', async () => {
      const env = await createTestEnv();
      const txtSid = env.document.getElementById('txtStudentId') as HTMLInputElement;
      txtSid.value = '2351234';
      txtSid.dispatchEvent(new env.window.Event('input'));
      assert.strictEqual(env.getLastMessage()?.type, 'updateStudentId');
      assert.strictEqual(env.getLastMessage()?.studentId, '2351234');
    });

    it('should display error prompt and focus when testing SSH without student ID', async () => {
      const env = await createTestEnv();
      const txtSid = env.document.getElementById('txtStudentId') as HTMLInputElement;
      txtSid.value = '';

      const btnTestSSH = env.document.getElementById('btnTestSSH') as HTMLButtonElement;
      btnTestSSH.click();

      const sshStatusArea = env.document.getElementById('sshStatusArea');
      assert.ok(sshStatusArea?.textContent?.includes('请输入学号！'));
      assert.strictEqual(env.getLastMessage()?.type, 'testSSH');
      assert.strictEqual(env.getLastMessage()?.studentId, '');
    });

    it('should show loading indicator and post studentId when testing SSH with valid ID', async () => {
      const env = await createTestEnv();
      const txtSid = env.document.getElementById('txtStudentId') as HTMLInputElement;
      txtSid.value = '2359999';

      const btnTestSSH = env.document.getElementById('btnTestSSH') as HTMLButtonElement;
      btnTestSSH.click();

      const sshStatusArea = env.document.getElementById('sshStatusArea');
      assert.ok(sshStatusArea?.textContent?.includes('正在连接'));
      assert.strictEqual(env.getLastMessage()?.type, 'testSSH');
      assert.strictEqual(env.getLastMessage()?.studentId, '2359999');
    });

    it('should trigger SSH test when pressing Enter in studentId input', async () => {
      const env = await createTestEnv();
      const txtSid = env.document.getElementById('txtStudentId') as HTMLInputElement;
      txtSid.value = '2351111';

      const enterEvent = new env.window.KeyboardEvent('keydown', { key: 'Enter' });
      txtSid.dispatchEvent(enterEvent);

      assert.strictEqual(env.getLastMessage()?.type, 'testSSH');
      assert.strictEqual(env.getLastMessage()?.studentId, '2351111');
    });

    it('should render sshTestStart, sshTestResult success, and error messages', async () => {
      const env = await createTestEnv();
      const sshArea = env.document.getElementById('sshStatusArea');
      const btnSSH = env.document.getElementById('btnTestSSH') as HTMLButtonElement;

      // 1. sshTestStart
      await env.dispatchMessage({ type: 'sshTestStart', message: '正在测试...' });
      assert.strictEqual(btnSSH.disabled, true);
      assert.ok(sshArea?.textContent?.includes('正在测试...'));

      // 2. sshTestResult success
      await env.dispatchMessage({ type: 'sshTestResult', success: true, message: 'SSH 连接正常！' });
      assert.strictEqual(btnSSH.disabled, false);
      assert.ok(sshArea?.textContent?.includes('SSH 连接正常！'));

      // 3. sshTestResult error
      await env.dispatchMessage({ type: 'sshTestResult', success: false, message: '未找到私钥路径' });
      assert.strictEqual(btnSSH.disabled, false);
      assert.ok(sshArea?.textContent?.includes('未找到私钥路径'));
    });
  });

  describe('7. Test Case Management (OI Cases)', () => {
    it('should render existing test cases and handle add, toggle, edit, and delete', async () => {
      const env = await createTestEnv();
      await env.dispatchMessage({
        type: 'stateUpdate',
        testCases: [
          { id: 'c1', name: '样例 1', input: '1 2', expectedOutput: '3', enabled: true },
          { id: 'c2', name: '样例 2', input: '10 20', expectedOutput: '30', enabled: false },
        ],
      });

      const caseCount = env.document.getElementById('caseCount');
      assert.strictEqual(caseCount?.textContent, '2');

      const container = env.document.getElementById('caseListContainer');
      assert.strictEqual(container?.children.length, 2);

      // Check case 1 input values
      const firstBox = container?.children[0];
      const textareas = firstBox?.querySelectorAll('textarea');
      assert.strictEqual(textareas?.[0].value, '1 2');
      assert.strictEqual(textareas?.[1].value, '3');

      // Edit input of case 1
      textareas![0].value = '1 5';
      textareas![0].dispatchEvent(new env.window.Event('change'));
      assert.strictEqual(env.getLastMessage()?.type, 'updateTestCases');
      assert.strictEqual(env.getLastMessage()?.testCases[0].input, '1 5');

      // Edit expectedOutput of case 1
      textareas![1].value = '6';
      textareas![1].dispatchEvent(new env.window.Event('change'));
      assert.strictEqual(env.getLastMessage()?.type, 'updateTestCases');
      assert.strictEqual(env.getLastMessage()?.testCases[0].expectedOutput, '6');

      // Toggle case 2 to enabled
      const secondBox = container?.children[1];
      const chk = secondBox?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      chk.checked = true;
      chk.dispatchEvent(new env.window.Event('change'));
      assert.strictEqual(env.getLastMessage()?.type, 'updateTestCases');
      assert.strictEqual(env.getLastMessage()?.testCases[1].enabled, true);

      // Delete case 2
      const btnDel = secondBox?.querySelector('button') as HTMLButtonElement;
      btnDel.click();
      assert.strictEqual(env.getLastMessage()?.type, 'updateTestCases');
      assert.strictEqual(env.getLastMessage()?.testCases.length, 1);
      assert.strictEqual(container?.children.length, 1);

      // Add a new case
      const btnAddCase = env.document.getElementById('btnAddCase') as HTMLButtonElement;
      btnAddCase.click();
      assert.strictEqual(env.getLastMessage()?.type, 'updateTestCases');
      assert.strictEqual(env.getLastMessage()?.testCases.length, 2);
    });

    it('should safely escape special characters and HTML tags inside test case values', async () => {
      const env = await createTestEnv();
      await env.dispatchMessage({
        type: 'stateUpdate',
        testCases: [
          {
            id: 'xss_case',
            name: '<script>alert(1)</script>',
            input: '</textarea><img src=x onerror=alert(1)>',
            expectedOutput: '<b>OK</b> & "test"',
            enabled: true,
          },
        ],
      });

      const container = env.document.getElementById('caseListContainer');
      const box = container?.children[0];
      const strong = box?.querySelector('strong');
      assert.strictEqual(strong?.textContent, '<script>alert(1)</script>');

      const textareas = box?.querySelectorAll('textarea');
      assert.strictEqual(textareas?.[0].value, '</textarea><img src=x onerror=alert(1)>');
      assert.strictEqual(textareas?.[1].value, '<b>OK</b> & "test"');
    });
  });

  describe('8. Batch Run Lifecycle', () => {
    it('should post runBatch when clicking start button', async () => {
      const env = await createTestEnv();
      const btnRun = env.document.getElementById('btnRunBatch') as HTMLButtonElement;
      btnRun.click();
      assert.strictEqual(env.getLastMessage()?.type, 'runBatch');
    });

    it('should update progress and button state on runStart, runProgress, runError', async () => {
      const env = await createTestEnv();
      const btnRun = env.document.getElementById('btnRunBatch') as HTMLButtonElement;
      const prog = env.document.getElementById('progressText');
      const modal = env.document.getElementById('detailModal');

      // 1. runStart
      modal!.style.display = 'block';
      await env.dispatchMessage({ type: 'runStart' });
      assert.strictEqual(btnRun.disabled, true);
      assert.strictEqual(modal?.style.display, 'none', 'detailModal must be hidden on runStart');
      assert.ok(prog?.textContent?.includes('开始编译'));

      // 2. runProgress
      await env.dispatchMessage({ type: 'runProgress', message: '正在进行 MinGW 编译...' });
      assert.strictEqual(prog?.textContent, '正在进行 MinGW 编译...');

      // 3. runError
      await env.dispatchMessage({ type: 'runError', message: '无法找到编译器可执行程序' });
      assert.strictEqual(btnRun.disabled, false);
      assert.ok(prog?.textContent?.includes('无法找到编译器可执行程序'));
    });
  });

  describe('9. Detailed Results Table & Modal Inspection', () => {
    it('should render all pill statuses (AC, WA, TLE, RE, CE, and disabled compiler dash)', async () => {
      const env = await createTestEnv();
      await env.dispatchMessage({
        type: 'stateUpdate',
        compilers: { msvc: true, mingw: true, linux: false },
        testCases: [
          { id: 'c_ac', name: '通过点', enabled: true },
          { id: 'c_tle', name: '超时点', enabled: true },
          { id: 'c_re', name: '运行时崩溃', enabled: true },
        ],
      });

      await env.dispatchMessage({
        type: 'runComplete',
        result: {
          timestamp: Date.now(),
          compilations: {
            msvc: { compiler: 'msvc', success: true },
            mingw: { compiler: 'mingw', success: true },
          },
          runs: {
            msvc: [
              { compiler: 'msvc', testCaseId: 'c_ac', status: 'AC', timeMs: 15, exitCode: 0 },
              { compiler: 'msvc', testCaseId: 'c_tle', status: 'TLE', timeMs: 5000, exitCode: -1 },
              { compiler: 'msvc', testCaseId: 'c_re', status: 'RE', timeMs: 10, exitCode: 139 },
            ],
          },
        },
      });

      const body = env.document.getElementById('resultBody');
      assert.strictEqual(body?.children.length, 3);

      // Row 1: AC pill, disabled linux has '-'
      const row1 = body?.children[0];
      const pillAc = row1?.querySelector('.pill-ac');
      assert.ok(pillAc?.textContent?.includes('AC (15ms)'));

      // Linux is disabled -> td should contain '-'
      const row1Tds = row1?.querySelectorAll('td');
      assert.strictEqual(row1Tds?.[3].textContent, '-');

      // Row 2: TLE pill
      const row2 = body?.children[1];
      const pillTle = row2?.querySelector('.pill-tle');
      assert.ok(pillTle?.textContent?.includes('TLE (5000ms)'));

      // Row 3: RE pill
      const row3 = body?.children[2];
      const pillRe = row3?.querySelector('.pill-re');
      assert.ok(pillRe?.textContent?.includes('RE (10ms)'));
    });

    it('should open and close modal for CE and WA with detailed diff display', async () => {
      const env = await createTestEnv();
      await env.dispatchMessage({
        type: 'stateUpdate',
        compilers: { msvc: true, mingw: true, linux: false },
        testCases: [
          { id: 'c_diff', name: '测试点 1', enabled: true },
        ],
      });

      await env.dispatchMessage({
        type: 'runComplete',
        result: {
          timestamp: Date.now(),
          compilations: {
            msvc: { compiler: 'msvc', success: false, errorMessage: 'C1083: Cannot open include file' },
            mingw: { compiler: 'mingw', success: true },
          },
          runs: {
            mingw: [
              {
                compiler: 'mingw',
                testCaseId: 'c_diff',
                status: 'WA',
                timeMs: 40,
                exitCode: 0,
                stderr: 'Warning: unused variable',
                byteDiff: {
                  matched: false,
                  offset: 5,
                  expectedByteHex: '0x0A',
                  actualByteHex: '0x0D',
                  message: '在偏移 5 处不匹配: 期望 0x0A, 实际得到 0x0D',
                  expectedContext: 'line1\\n',
                  actualContext: 'line1\\r\\n',
                },
              },
            ],
          },
        },
      });

      const modal = env.document.getElementById('detailModal');
      const modalTitle = env.document.getElementById('modalTitle');
      const modalContent = env.document.getElementById('modalContent');
      const btnClose = env.document.getElementById('btnCloseModal') as HTMLButtonElement;

      // 1. Click CE Pill
      const pillCe = env.document.querySelector('.pill-ce') as HTMLElement;
      pillCe.click();
      assert.strictEqual(modal?.style.display, 'block');
      assert.ok(modalTitle?.textContent?.includes('MSVC 编译错误 (CE)'));
      assert.ok(modalContent?.textContent?.includes('C1083: Cannot open include file'));

      // Close modal
      btnClose.click();
      assert.strictEqual(modal?.style.display, 'none');

      // 2. Click WA Pill
      const pillWa = env.document.querySelector('.pill-wa') as HTMLElement;
      pillWa.click();
      assert.strictEqual(modal?.style.display, 'block');
      assert.ok(modalTitle?.textContent?.includes('MINGW 详情 (WA)'));
      assert.ok(modalContent?.textContent?.includes('在偏移 5 处不匹配'));
      assert.ok(modalContent?.textContent?.includes('Warning: unused variable'));

      // Close modal
      btnClose.click();
      assert.strictEqual(modal?.style.display, 'none');
    });
  });

  describe('10. Error Boundary & Robustness', () => {
    it('should catch runtime UI exceptions through window.onerror and display user-friendly message', async () => {
      const env = await createTestEnv();
      const prog = env.document.getElementById('progressText');

      // Trigger window.onerror
      env.window.onerror('Test error message', 'test.js', 42, 1, new Error('Test'));

      assert.ok(prog?.textContent?.includes('界面异常: Test error message'));
    });
  });
});
