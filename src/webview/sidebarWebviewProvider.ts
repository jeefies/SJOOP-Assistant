import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TestCase, ProjectConfig, CompilerType } from '../types';
import { checkFileEncoding, convertFileToGB18030 } from '../encoding/encodingGuard';
import { CaseManager } from '../storage/caseManager';
import { MsvcDriver } from '../compilers/msvcDriver';
import { MingwDriver } from '../compilers/mingwDriver';
import { LinuxSshDriver, SshConfig } from '../compilers/linuxSshDriver';
import { CompilerRunner, BatchRunResult } from '../compilers/runner';

export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sjoop.sidebarView';
  private _view?: vscode.WebviewView;

  private currentFilePath: string | null = null;
  private currentTestCases: TestCase[] = [];
  private currentProjectConfig: ProjectConfig = {
    mode: 'single',
    mainFile: '',
    additionalFiles: [],
  };

  private selectedCompilers: Record<CompilerType, boolean> = {
    msvc: true,
    mingw: true,
    linux: false,
  };

  private lastRunResult: BatchRunResult | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'ready':
          this.refreshState();
          break;
        case 'convertEncoding':
          await this.handleConvertEncoding();
          break;
        case 'updateConfig':
          if (data.projectConfig) {
            this.currentProjectConfig = data.projectConfig;
            this.saveCurrentProjectConfig();
          }
          if (data.compilers) {
            this.selectedCompilers = data.compilers;
          }
          break;
        case 'updateTestCases':
          if (data.testCases) {
            this.currentTestCases = data.testCases;
            this.saveCurrentTestCases();
          }
          break;
        case 'addAdditionalFile':
          await this.handleAddAdditionalFile();
          break;
        case 'removeAdditionalFile':
          this.handleRemoveAdditionalFile(data.filePath);
          break;
        case 'runBatch':
          await this.handleRunBatch();
          break;
        case 'testSSH':
          await this.handleTestSSH();
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'sjoop');
          break;
      }
    });

    // Update on view visibility
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refreshState();
      }
    });
  }

  public setActiveFile(filePath: string | null) {
    this.currentFilePath = filePath;
    this.loadDataForActiveFile();
    this.refreshState();
  }

  private loadDataForActiveFile() {
    if (!this.currentFilePath) {
      this.currentTestCases = [];
      return;
    }

    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(this.currentFilePath);
    const baseName = path.basename(this.currentFilePath, path.extname(this.currentFilePath));

    this.currentTestCases = CaseManager.loadTestCases(wsFolder, baseName);
    this.currentProjectConfig = CaseManager.loadProjectConfig(wsFolder, baseName, this.currentFilePath);
  }

  private saveCurrentTestCases() {
    if (!this.currentFilePath) return;
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(this.currentFilePath);
    const baseName = path.basename(this.currentFilePath, path.extname(this.currentFilePath));
    CaseManager.saveTestCases(wsFolder, baseName, this.currentTestCases);
  }

  private saveCurrentProjectConfig() {
    if (!this.currentFilePath) return;
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(this.currentFilePath);
    const baseName = path.basename(this.currentFilePath, path.extname(this.currentFilePath));
    CaseManager.saveProjectConfig(wsFolder, baseName, this.currentProjectConfig);
  }

  public refreshState() {
    if (!this._view) return;

    const config = vscode.workspace.getConfiguration('sjoop');
    const encodingTarget = config.get<string>('encoding.targetCharset', 'gb18030');
    let encResult = null;

    if (this.currentFilePath && fs.existsSync(this.currentFilePath)) {
      encResult = checkFileEncoding(this.currentFilePath, encodingTarget);
    }

    const msvcPath = config.get<string>('msvc.vcvarsPath') || MsvcDriver.findVcvars();
    const mingwPath = config.get<string>('mingw.gppPath') || MingwDriver.findGpp();
    const studentId = config.get<string>('studentId', '');
    const sshKeyPath = config.get<string>('linux.privateKeyPath') || LinuxSshDriver.findDefaultPrivateKey();

    this._view.webview.postMessage({
      type: 'stateUpdate',
      filePath: this.currentFilePath,
      fileName: this.currentFilePath ? path.basename(this.currentFilePath) : null,
      encodingInfo: encResult,
      compilers: this.selectedCompilers,
      compilerPaths: {
        msvc: msvcPath,
        mingw: mingwPath,
        linuxHost: config.get<string>('linux.host', '10.80.42.230'),
        studentId,
        sshKeyPath,
      },
      projectConfig: this.currentProjectConfig,
      testCases: this.currentTestCases,
      lastRunResult: this.lastRunResult,
    });
  }

  private async handleConvertEncoding() {
    if (!this.currentFilePath) return;
    const res = convertFileToGB18030(this.currentFilePath);
    if (res.success) {
      vscode.window.showInformationMessage(res.message);
      this.refreshState();
    } else {
      vscode.window.showErrorMessage(res.message);
    }
  }

  private async handleAddAdditionalFile() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: '添加为联合编译源文件',
      filters: { 'C/C++ Files': ['cpp', 'c', 'h', 'hpp'] },
    });

    if (uris && uris.length > 0) {
      for (const u of uris) {
        if (!this.currentProjectConfig.additionalFiles.includes(u.fsPath) && u.fsPath !== this.currentFilePath) {
          this.currentProjectConfig.additionalFiles.push(u.fsPath);
        }
      }
      this.saveCurrentProjectConfig();
      this.refreshState();
    }
  }

  private handleRemoveAdditionalFile(fPath: string) {
    this.currentProjectConfig.additionalFiles = this.currentProjectConfig.additionalFiles.filter(
      (p) => p !== fPath
    );
    this.saveCurrentProjectConfig();
    this.refreshState();
  }

  private async handleTestSSH() {
    const config = vscode.workspace.getConfiguration('sjoop');
    const studentId = config.get<string>('studentId', '');

    if (!studentId) {
      const inputId = await vscode.window.showInputBox({
        prompt: '请输入学号 (登录用户名将为 u{学号})',
        placeHolder: '例如: 2554207',
      });
      if (inputId) {
        await config.update('studentId', inputId.trim(), vscode.ConfigurationTarget.Global);
      } else {
        return;
      }
    }

    const updatedConfig = vscode.workspace.getConfiguration('sjoop');
    const sshConf: SshConfig = {
      host: updatedConfig.get<string>('linux.host', '10.80.42.230'),
      port: updatedConfig.get<number>('linux.port', 22),
      studentId: updatedConfig.get<string>('studentId', ''),
      privateKeyPath: updatedConfig.get<string>('linux.privateKeyPath') || undefined,
      remoteDir: updatedConfig.get<string>('linux.remoteDir', '~/sjoop_tmp'),
      flags: updatedConfig.get<string[]>('linux.flags', []),
    };

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在连接 Linux 服务器 (${sshConf.host}:22)...`,
      },
      async () => {
        const res = await LinuxSshDriver.testConnection(sshConf);
        if (res.success) {
          vscode.window.showInformationMessage(res.message);
        } else {
          vscode.window.showErrorMessage(res.message);
        }
      }
    );
  }

  private async handleRunBatch() {
    if (!this.currentFilePath) {
      vscode.window.showWarningMessage('请先在编辑器中打开一个 C/C++ 源文件！');
      return;
    }

    // Auto save all active files before compiling
    await vscode.workspace.saveAll(false);

    const config = vscode.workspace.getConfiguration('sjoop');
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(this.currentFilePath);
    const baseName = path.basename(this.currentFilePath, path.extname(this.currentFilePath));

    // Determine sources
    let sources: string[] = [this.currentFilePath];
    if (this.currentProjectConfig.mode === 'multi') {
      sources = [this.currentFilePath, ...this.currentProjectConfig.additionalFiles.filter(fs.existsSync)];
    }

    // Check student ID if linux compiler selected
    const activeCompilers: CompilerType[] = [];
    if (this.selectedCompilers.msvc) activeCompilers.push('msvc');
    if (this.selectedCompilers.mingw) activeCompilers.push('mingw');
    if (this.selectedCompilers.linux) {
      activeCompilers.push('linux');
      const sId = config.get<string>('studentId', '');
      if (!sId) {
        const inputId = await vscode.window.showInputBox({
          prompt: '检测到选中了 Linux 编译器，请输入学号 (用户名: u{学号})',
          placeHolder: '例如: 2554207',
        });
        if (inputId) {
          await config.update('studentId', inputId.trim(), vscode.ConfigurationTarget.Global);
        } else {
          vscode.window.showErrorMessage('未提供学号，已跳过 Linux 远程编译。');
          activeCompilers.pop();
        }
      }
    }

    if (activeCompilers.length === 0) {
      vscode.window.showWarningMessage('请至少勾选一个编译器！');
      return;
    }

    const updatedConfig = vscode.workspace.getConfiguration('sjoop');
    const sshConf: SshConfig = {
      host: updatedConfig.get<string>('linux.host', '10.80.42.230'),
      port: updatedConfig.get<number>('linux.port', 22),
      studentId: updatedConfig.get<string>('studentId', ''),
      privateKeyPath: updatedConfig.get<string>('linux.privateKeyPath') || undefined,
      remoteDir: updatedConfig.get<string>('linux.remoteDir', '~/sjoop_tmp'),
      flags: updatedConfig.get<string[]>('linux.flags', []),
    };

    this._view?.webview.postMessage({ type: 'runStart' });

    try {
      const batchRes = await CompilerRunner.executeBatch({
        workspaceRoot: wsFolder,
        sources,
        outputBaseName: baseName,
        selectedCompilers: activeCompilers,
        testCases: this.currentTestCases,
        timeoutMs: updatedConfig.get<number>('judge.timeoutMs', 5000),
        strictDiff: updatedConfig.get<boolean>('judge.strictByteDiff', true),
        msvcFlags: updatedConfig.get<string[]>('msvc.flags'),
        customVcvars: updatedConfig.get<string>('msvc.vcvarsPath'),
        mingwFlags: updatedConfig.get<string[]>('mingw.flags'),
        customGpp: updatedConfig.get<string>('mingw.gppPath'),
        sshConfig: sshConf,
        onProgress: (msg) => {
          this._view?.webview.postMessage({ type: 'runProgress', message: msg });
        },
      });

      this.lastRunResult = batchRes;
      this._view?.webview.postMessage({
        type: 'runComplete',
        result: batchRes,
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`运行失败: ${err.message}`);
      this._view?.webview.postMessage({ type: 'runError', message: err.message });
    }
  }

  private _getHtmlForWebview(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SJOOP 助手</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-sideBar-background);
      --border: var(--vscode-widget-border, #454545);
      --badge-ac: #388a34;
      --badge-wa: #e51400;
      --badge-tle: #e2a03f;
      --badge-re: #b13ab8;
      --badge-ce: #6c71c4;
      --btn-primary: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background-color: var(--bg);
      margin: 0;
      padding: 12px;
      box-sizing: border-box;
    }
    h2, h3, h4 { margin: 8px 0; font-weight: 600; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 12px;
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-ok { background: rgba(56, 138, 52, 0.25); color: #4ec9b0; border: 1px solid #388a34; }
    .badge-warn { background: rgba(229, 20, 0, 0.25); color: #f14c4c; border: 1px solid #e51400; }
    .btn {
      background: var(--btn-primary);
      color: var(--btn-fg);
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
      font-size: 12px;
    }
    .btn:hover { background: var(--btn-hover); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
    }
    .btn-small { padding: 3px 8px; font-size: 11px; }
    .btn-full { width: 100%; padding: 8px; font-size: 13px; font-weight: 600; }
    .compiler-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 0;
      border-bottom: 1px dashed rgba(255, 255, 255, 0.08);
    }
    .compiler-item:last-child { border-bottom: none; }
    .toggle-label {
      display: flex;
      align-items: center;
      cursor: pointer;
      font-size: 12px;
    }
    .toggle-label input { margin-right: 6px; }
    .source-list {
      list-style: none;
      padding-left: 0;
      margin: 6px 0;
      max-height: 120px;
      overflow-y: auto;
    }
    .source-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255, 255, 255, 0.04);
      padding: 3px 6px;
      margin-bottom: 4px;
      border-radius: 3px;
      font-size: 11px;
    }
    .case-box {
      border: 1px solid var(--border);
      border-radius: 4px;
      margin-bottom: 8px;
      padding: 8px;
      background: rgba(0,0,0,0.1);
    }
    .case-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    textarea {
      width: 100%;
      height: 48px;
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--border);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      box-sizing: border-box;
      resize: vertical;
      padding: 4px;
    }
    .table-res {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
      margin-top: 8px;
    }
    .table-res th, .table-res td {
      border: 1px solid var(--border);
      padding: 5px;
      text-align: center;
    }
    .pill {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      color: #fff;
      font-weight: bold;
      cursor: pointer;
    }
    .pill-ac { background-color: var(--badge-ac); }
    .pill-wa { background-color: var(--badge-wa); }
    .pill-tle { background-color: var(--badge-tle); }
    .pill-re { background-color: var(--badge-re); }
    .pill-ce { background-color: var(--badge-ce); }
    .modal {
      display: none;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      margin-top: 10px;
      font-size: 11px;
    }
    .diff-block {
      background: #111;
      padding: 6px;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-all;
      font-family: monospace;
      color: #e51400;
    }
  </style>
</head>
<body>
  <!-- Header & Encoding Guard -->
  <div class="card" id="fileHeaderCard">
    <div class="header-bar">
      <div>
        <strong id="activeFileName" style="font-size: 13px;">未打开 C/C++ 文件</strong>
      </div>
      <div id="encodingBadgeContainer">
        <span class="badge badge-warn" id="encodingBadge">未知编码</span>
      </div>
    </div>
    <div id="encodingAlert" style="display:none; font-size: 11px; color: #f14c4c; margin-top: 4px;">
      ⚠️ SJ 课程强制要求 GB18030！
      <button class="btn btn-small" id="btnConvert" style="margin-left: 6px;">一键转为 GB18030</button>
    </div>
    <div style="font-size: 10px; color: #888; margin-top: 4px;" id="systemEncText">系统默认: 检测中...</div>
  </div>

  <!-- Mode & Sources -->
  <div class="card">
    <div class="header-bar">
      <strong>模式选择</strong>
      <div>
        <button class="btn btn-small btn-secondary" id="btnModeSingle">单文件</button>
        <button class="btn btn-small btn-secondary" id="btnModeMulti">多文件</button>
      </div>
    </div>
    <div id="multiFileSection" style="display: none; margin-top: 6px;">
      <div style="font-size: 11px; color: #aaa; margin-bottom: 4px;">联合编译源文件列表:</div>
      <ul class="source-list" id="sourceFileList"></ul>
      <button class="btn btn-small" id="btnAddSource">+ 添加 .cpp / .h 文件</button>
    </div>
  </div>

  <!-- Compilers Selector -->
  <div class="card">
    <div class="header-bar">
      <strong>三编译器选择</strong>
      <button class="btn btn-small btn-secondary" id="btnSettings">⚙️ 设置</button>
    </div>
    <div class="compiler-item">
      <label class="toggle-label">
        <input type="checkbox" id="chkMsvc" checked>
        <strong>MSVC</strong> (Visual Studio 2026)
      </label>
      <span style="font-size: 10px; color: #4ec9b0;" id="msvcStatus">就绪</span>
    </div>
    <div class="compiler-item">
      <label class="toggle-label">
        <input type="checkbox" id="chkMingw" checked>
        <strong>MinGW g++</strong> (小熊猫/GCC 15.2)
      </label>
      <span style="font-size: 10px; color: #4ec9b0;" id="mingwStatus">就绪</span>
    </div>
    <div class="compiler-item">
      <label class="toggle-label">
        <input type="checkbox" id="chkLinux">
        <strong>Linux C++</strong> (10.80.42.230)
      </label>
      <button class="btn btn-small btn-secondary" id="btnTestSSH">测试连通</button>
    </div>
  </div>

  <!-- Action Run Button -->
  <button class="btn btn-full" id="btnRunBatch">🚀 一键编译并运行测试</button>
  <div id="progressText" style="font-size: 11px; color: #4ec9b0; text-align: center; margin: 6px 0; min-height: 16px;"></div>

  <!-- Test Results Matrix -->
  <div class="card" id="resultCard" style="display: none;">
    <strong>测试结果矩阵</strong>
    <table class="table-res" id="resultTable">
      <thead>
        <tr>
          <th>测试点</th>
          <th id="thMsvc">MSVC</th>
          <th id="thMingw">MinGW</th>
          <th id="thLinux">Linux</th>
        </tr>
      </thead>
      <tbody id="resultBody"></tbody>
    </table>
    <!-- Detail Drawer -->
    <div class="modal" id="detailModal">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <strong id="modalTitle">测试点详情</strong>
        <button class="btn btn-small btn-secondary" id="btnCloseModal">关闭</button>
      </div>
      <div id="modalContent"></div>
    </div>
  </div>

  <!-- OI Test Cases Manager -->
  <div class="card">
    <div class="header-bar">
      <strong>测试用例点 (<span id="caseCount">0</span>)</strong>
      <button class="btn btn-small" id="btnAddCase">+ 新增测试点</button>
    </div>
    <div id="caseListContainer"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let state = {
      filePath: null,
      fileName: null,
      encodingInfo: null,
      compilers: { msvc: true, mingw: true, linux: false },
      projectConfig: { mode: 'single', mainFile: '', additionalFiles: [] },
      testCases: [],
      lastRunResult: null,
    };

    // Notify backend ready
    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'stateUpdate':
          state = { ...state, ...msg };
          renderUI();
          break;
        case 'runStart':
          document.getElementById('progressText').innerText = '开始编译任务...';
          document.getElementById('btnRunBatch').disabled = true;
          break;
        case 'runProgress':
          document.getElementById('progressText').innerText = msg.message;
          break;
        case 'runComplete':
          document.getElementById('progressText').innerText = '测试完成！';
          document.getElementById('btnRunBatch').disabled = false;
          state.lastRunResult = msg.result;
          renderResults(msg.result);
          break;
        case 'runError':
          document.getElementById('progressText').innerText = '执行出错: ' + msg.message;
          document.getElementById('btnRunBatch').disabled = false;
          break;
      }
    });

    function renderUI() {
      // 1. Header & Encoding
      document.getElementById('activeFileName').innerText = state.fileName || '未打开 C/C++ 文件';
      if (state.encodingInfo) {
        const badge = document.getElementById('encodingBadge');
        const alertBox = document.getElementById('encodingAlert');
        const sysText = document.getElementById('systemEncText');

        sysText.innerText = '系统代码页: ' + (state.encodingInfo.systemEncoding || 'CP936');

        if (state.encodingInfo.isTargetEncoding) {
          badge.className = 'badge badge-ok';
          badge.innerText = state.encodingInfo.encoding.toUpperCase() + ' ✅';
          alertBox.style.display = 'none';
        } else {
          badge.className = 'badge badge-warn';
          badge.innerText = state.encodingInfo.encoding.toUpperCase() + ' ⚠️';
          alertBox.style.display = 'block';
        }
      }

      // 2. Mode buttons
      const isMulti = state.projectConfig.mode === 'multi';
      document.getElementById('btnModeSingle').className = !isMulti ? 'btn btn-small' : 'btn btn-small btn-secondary';
      document.getElementById('btnModeMulti').className = isMulti ? 'btn btn-small' : 'btn btn-small btn-secondary';
      document.getElementById('multiFileSection').style.display = isMulti ? 'block' : 'none';

      // Source file list
      const ul = document.getElementById('sourceFileList');
      ul.innerHTML = '';
      if (isMulti && state.projectConfig.additionalFiles) {
        state.projectConfig.additionalFiles.forEach(f => {
          const li = document.createElement('li');
          li.className = 'source-item';
          li.innerHTML = '<span>' + f.split(/[\\\\/]/).pop() + '</span><button class="btn btn-small btn-secondary" onclick="removeSource(\\'' + encodeURIComponent(f) + '\\')">移除</button>';
          ul.appendChild(li);
        });
      }

      // 3. Compilers
      document.getElementById('chkMsvc').checked = !!state.compilers.msvc;
      document.getElementById('chkMingw').checked = !!state.compilers.mingw;
      document.getElementById('chkLinux').checked = !!state.compilers.linux;

      // 4. Test Cases
      renderCases();

      // 5. Results if available
      if (state.lastRunResult) {
        renderResults(state.lastRunResult);
      }
    }

    function renderCases() {
      const container = document.getElementById('caseListContainer');
      container.innerHTML = '';
      document.getElementById('caseCount').innerText = state.testCases.length;

      state.testCases.forEach((tc, idx) => {
        const box = document.createElement('div');
        box.className = 'case-box';
        box.innerHTML = \`
          <div class="case-header">
            <label class="toggle-label">
              <input type="checkbox" \${tc.enabled ? 'checked' : ''} onchange="toggleCase('\${tc.id}', this.checked)">
              <strong>\${tc.name || ('测试点 #' + (idx + 1))}</strong>
            </label>
            <button class="btn btn-small btn-secondary" onclick="deleteCase('\${tc.id}')">删除</button>
          </div>
          <div style="font-size: 11px; margin-bottom: 2px;">输入 (stdin):</div>
          <textarea onchange="updateCaseInput('\${tc.id}', this.value)">\${tc.input}</textarea>
          <div style="font-size: 11px; margin: 4px 0 2px 0;">期望输出 (stdout 严格逐字节比对):</div>
          <textarea onchange="updateCaseOutput('\${tc.id}', this.value)">\${tc.expectedOutput}</textarea>
        \`;
        container.appendChild(box);
      });
    }

    function renderResults(result) {
      const card = document.getElementById('resultCard');
      const body = document.getElementById('resultBody');
      body.innerHTML = '';
      card.style.display = 'block';

      state.testCases.forEach(tc => {
        if (!tc.enabled) return;
        const tr = document.createElement('tr');
        tr.innerHTML = '<td><strong>' + (tc.name || tc.id) + '</strong></td>';

        ['msvc', 'mingw', 'linux'].forEach(comp => {
          const runList = result.runs[comp] || [];
          const run = runList.find(r => r.testCaseId === tc.id);
          const compRes = result.compilations[comp];

          let pillHtml = '<span style="color:#666;">-</span>';
          if (state.compilers[comp]) {
            if (compRes && !compRes.success) {
              pillHtml = '<span class="pill pill-ce" onclick="showCeDetail(\\'' + comp + '\\')">CE</span>';
            } else if (run) {
              const cls = 'pill pill-' + run.status.toLowerCase();
              pillHtml = '<span class="' + cls + '" onclick="showRunDetail(\\'' + comp + '\\', \\'' + tc.id + '\\')">' + run.status + ' (' + run.timeMs + 'ms)</span>';
            }
          }
          tr.innerHTML += '<td>' + pillHtml + '</td>';
        });

        body.appendChild(tr);
      });
    }

    // Detail modal helpers
    window.showCeDetail = function(compiler) {
      const modal = document.getElementById('detailModal');
      const title = document.getElementById('modalTitle');
      const content = document.getElementById('modalContent');
      const compRes = state.lastRunResult.compilations[compiler];

      title.innerText = compiler.toUpperCase() + ' 编译错误 (CE)';
      content.innerHTML = '<div class="diff-block" style="color:#f14c4c;">' + escapeHtml(compRes.errorMessage || '未知编译错误') + '</div>';
      modal.style.display = 'block';
    };

    window.showRunDetail = function(compiler, caseId) {
      const modal = document.getElementById('detailModal');
      const title = document.getElementById('modalTitle');
      const content = document.getElementById('modalContent');
      const run = (state.lastRunResult.runs[compiler] || []).find(r => r.testCaseId === caseId);
      const tc = state.testCases.find(c => c.id === caseId);

      if (!run) return;
      title.innerText = (tc ? tc.name : caseId) + ' - ' + compiler.toUpperCase() + ' 详情 (' + run.status + ')';

      let html = '<div style="margin-bottom: 6px;">耗时: ' + run.timeMs + 'ms | 退出码: ' + run.exitCode + '</div>';
      if (run.byteDiff && !run.byteDiff.matched) {
        html += '<div style="color: #f14c4c; font-weight: bold; margin-bottom: 4px;">' + run.byteDiff.message + '</div>';
        html += '<div style="font-size: 10px; margin-bottom: 2px;">期望上下文:</div>';
        html += '<div class="diff-block" style="color: #4ec9b0;">' + escapeHtml(run.byteDiff.expectedContext || '') + '</div>';
        html += '<div style="font-size: 10px; margin: 4px 0 2px 0;">实际得到上下文:</div>';
        html += '<div class="diff-block">' + escapeHtml(run.byteDiff.actualContext || '') + '</div>';
      }
      if (run.stderr) {
        html += '<div style="font-size: 10px; color:#aaa; margin-top: 4px;">标准错误 (stderr):</div>';
        html += '<div class="diff-block" style="color:#e2a03f;">' + escapeHtml(run.stderr) + '</div>';
      }
      content.innerHTML = html;
      modal.style.display = 'block';
    };

    document.getElementById('btnCloseModal').onclick = () => {
      document.getElementById('detailModal').style.display = 'none';
    };

    function escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Event Listeners
    document.getElementById('btnConvert').onclick = () => vscode.postMessage({ type: 'convertEncoding' });
    document.getElementById('btnModeSingle').onclick = () => {
      state.projectConfig.mode = 'single';
      vscode.postMessage({ type: 'updateConfig', projectConfig: state.projectConfig });
      renderUI();
    };
    document.getElementById('btnModeMulti').onclick = () => {
      state.projectConfig.mode = 'multi';
      vscode.postMessage({ type: 'updateConfig', projectConfig: state.projectConfig });
      renderUI();
    };
    document.getElementById('btnAddSource').onclick = () => vscode.postMessage({ type: 'addAdditionalFile' });
    window.removeSource = function(encodedPath) {
      vscode.postMessage({ type: 'removeAdditionalFile', filePath: decodeURIComponent(encodedPath) });
    };

    function updateCompilers() {
      state.compilers.msvc = document.getElementById('chkMsvc').checked;
      state.compilers.mingw = document.getElementById('chkMingw').checked;
      state.compilers.linux = document.getElementById('chkLinux').checked;
      vscode.postMessage({ type: 'updateConfig', compilers: state.compilers });
    }
    document.getElementById('chkMsvc').onchange = updateCompilers;
    document.getElementById('chkMingw').onchange = updateCompilers;
    document.getElementById('chkLinux').onchange = updateCompilers;

    document.getElementById('btnTestSSH').onclick = () => vscode.postMessage({ type: 'testSSH' });
    document.getElementById('btnSettings').onclick = () => vscode.postMessage({ type: 'openSettings' });
    document.getElementById('btnRunBatch').onclick = () => vscode.postMessage({ type: 'runBatch' });

    // Test cases actions
    document.getElementById('btnAddCase').onclick = () => {
      const newId = 'case_' + Date.now();
      state.testCases.push({
        id: newId,
        name: '测试点 #' + (state.testCases.length + 1),
        input: '',
        expectedOutput: '',
        enabled: true,
      });
      vscode.postMessage({ type: 'updateTestCases', testCases: state.testCases });
      renderCases();
    };

    window.toggleCase = function(id, val) {
      const tc = state.testCases.find(c => c.id === id);
      if (tc) {
        tc.enabled = val;
        vscode.postMessage({ type: 'updateTestCases', testCases: state.testCases });
      }
    };

    window.deleteCase = function(id) {
      state.testCases = state.testCases.filter(c => c.id !== id);
      vscode.postMessage({ type: 'updateTestCases', testCases: state.testCases });
      renderCases();
    };

    window.updateCaseInput = function(id, val) {
      const tc = state.testCases.find(c => c.id === id);
      if (tc) {
        tc.input = val;
        vscode.postMessage({ type: 'updateTestCases', testCases: state.testCases });
      }
    };

    window.updateCaseOutput = function(id, val) {
      const tc = state.testCases.find(c => c.id === id);
      if (tc) {
        tc.expectedOutput = val;
        vscode.postMessage({ type: 'updateTestCases', testCases: state.testCases });
      }
    };
  </script>
</body>
</html>`;
  }
}
