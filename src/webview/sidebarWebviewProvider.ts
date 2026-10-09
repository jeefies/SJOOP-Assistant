import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TestCase, ProjectConfig, CompilerType } from '../types';
import { checkFileEncoding, convertFileToGB18030, getSystemEncoding } from '../encoding/encodingGuard';
import { CaseManager } from '../storage/caseManager';
import { MsvcDriver } from '../compilers/msvcDriver';
import { MingwDriver } from '../compilers/mingwDriver';
import { LinuxSshDriver, SshConfig } from '../compilers/linuxSshDriver';
import { CompilerRunner, BatchRunResult } from '../compilers/runner';
import { log, showLog, logError } from '../logger';

export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sjoop.sidebarView';
  private _view?: vscode.WebviewView;

  private currentFilePath: string | null = null;
  private activeEditorPath: string | null = null;
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
            const oldMode = this.currentProjectConfig.mode;
            this.currentProjectConfig = data.projectConfig;
            if (!this.currentProjectConfig.additionalFiles) {
              this.currentProjectConfig.additionalFiles = [];
            }
            if (this.currentProjectConfig.mode === 'multi') {
              if (!this.currentProjectConfig.mainFile) {
                this.currentProjectConfig.mainFile = this.activeEditorPath || this.currentFilePath || '';
              }
              this.saveCurrentProjectConfig();
            } else if (oldMode === 'multi' && this.currentProjectConfig.mode === 'single') {
              this.saveCurrentProjectConfig();
              this.currentFilePath = this.activeEditorPath || this.currentFilePath;
              this.loadDataForActiveFile();
            } else {
              this.saveCurrentProjectConfig();
            }
            this.refreshState();
          }
          if (data.compilers) {
            this.selectedCompilers = data.compilers;
          }
          break;
        case 'updateStudentId':
          if (data.studentId !== undefined) {
            try {
              const cfg = vscode.workspace.getConfiguration('sjoop');
              await cfg.update('studentId', data.studentId.trim(), vscode.ConfigurationTarget.Global);
            } catch (e: any) {
              console.warn('保存学号至设置失败:', e);
            }
          }
          break;
        case 'updateNormalizeNewlines':
          if (data.normalizeNewlines !== undefined) {
            try {
              const cfg = vscode.workspace.getConfiguration('sjoop');
              await cfg.update('judge.normalizeNewlines', !!data.normalizeNewlines, vscode.ConfigurationTarget.Global);
            } catch (e: any) {
              console.warn('保存换行符配置失败:', e);
            }
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
          await this.handleTestSSH(data.studentId);
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'sjoop');
          break;
        case 'showLogs':
          showLog();
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refreshState();
      }
    });
  }

  public setActiveFile(filePath: string | null) {
    this.activeEditorPath = filePath;

    // 多文件模式下，切换焦点文件绝不重置模式或刷新工程配置！保持多文件项目锁定
    if (this.currentProjectConfig.mode === 'multi') {
      this.refreshState();
      return;
    }

    // 单文件模式下，跟随活动编辑器文件切换
    this.currentFilePath = filePath;
    this.loadDataForActiveFile();
    this.refreshState();
  }

  private getProjectRootAndBase(): { wsFolder: string; baseName: string } | null {
    const main = (this.currentProjectConfig.mode === 'multi' && this.currentProjectConfig.mainFile)
      ? this.currentProjectConfig.mainFile
      : this.currentFilePath;
    if (!main) return null;
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(main);
    const baseName = path.basename(main, path.extname(main));
    return { wsFolder, baseName };
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
    if (!this.currentProjectConfig.additionalFiles) {
      this.currentProjectConfig.additionalFiles = [];
    }
    if (!this.currentProjectConfig.mainFile) {
      this.currentProjectConfig.mainFile = this.currentFilePath;
    }
  }

  private saveCurrentTestCases() {
    const target = this.getProjectRootAndBase();
    if (!target) return;
    CaseManager.saveTestCases(target.wsFolder, target.baseName, this.currentTestCases);
  }

  private saveCurrentProjectConfig() {
    const target = this.getProjectRootAndBase();
    if (!target) return;
    CaseManager.saveProjectConfig(target.wsFolder, target.baseName, this.currentProjectConfig);
  }

  public refreshState() {
    if (!this._view) return;

    const config = vscode.workspace.getConfiguration('sjoop');
    const encodingTarget = config.get<string>('encoding.targetCharset', 'gb18030');
    let encResult = null;

    // 优先检查当前正在编辑的代码文件编码，没有则检查主文件
    const fileToCheck = this.activeEditorPath || this.currentFilePath || this.currentProjectConfig.mainFile;
    if (fileToCheck && fs.existsSync(fileToCheck)) {
      encResult = checkFileEncoding(fileToCheck, encodingTarget);
    }

    const msvcPath = config.get<string>('msvc.vcvarsPath') || MsvcDriver.findVcvars();
    const mingwPath = config.get<string>('mingw.gppPath') || MingwDriver.findGpp();
    const studentId = config.get<string>('studentId', '');
    const sshKeyPath = config.get<string>('linux.privateKeyPath') || LinuxSshDriver.findDefaultPrivateKey();
    const normalizeNewlines = config.get<boolean>('judge.normalizeNewlines', true);

    const displayFile = fileToCheck;
    const systemEncoding = getSystemEncoding();
    log(`Webview 状态刷新: file=${displayFile || '无'}, sysEnc=${systemEncoding}, targetEncoding=${encodingTarget}`);

    this._view.webview.postMessage({
      type: 'stateUpdate',
      filePath: displayFile,
      fileName: displayFile ? path.basename(displayFile) : null,
      systemEncoding,
      encodingInfo: encResult,
      compilers: this.selectedCompilers,
      normalizeNewlines,
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
    const fileToConvert = this.activeEditorPath || this.currentFilePath || this.currentProjectConfig.mainFile;
    if (!fileToConvert || !fs.existsSync(fileToConvert)) return;
    const res = convertFileToGB18030(fileToConvert);
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
      if (!this.currentProjectConfig.additionalFiles) {
        this.currentProjectConfig.additionalFiles = [];
      }
      const normalize = (p: string) => path.resolve(p).toLowerCase();
      const mainPath = this.currentProjectConfig.mainFile || this.currentFilePath || '';
      const mainNorm = mainPath ? normalize(mainPath) : '';

      for (const u of uris) {
        const uNorm = normalize(u.fsPath);
        if (uNorm !== mainNorm && !this.currentProjectConfig.additionalFiles.some((f) => normalize(f) === uNorm)) {
          this.currentProjectConfig.additionalFiles.push(u.fsPath);
        }
      }
      this.saveCurrentProjectConfig();
      this.refreshState();
    }
  }

  private handleRemoveAdditionalFile(fPath: string) {
    if (!this.currentProjectConfig.additionalFiles) return;
    const normalize = (p: string) => path.resolve(p).toLowerCase();
    const targetNorm = normalize(fPath);
    this.currentProjectConfig.additionalFiles = this.currentProjectConfig.additionalFiles.filter(
      (p) => normalize(p) !== targetNorm
    );
    this.saveCurrentProjectConfig();
    this.refreshState();
  }

  public async handleTestSSH(uiStudentId?: string) {
    try {
      const config = vscode.workspace.getConfiguration('sjoop');
      let studentId = (uiStudentId !== undefined && uiStudentId.trim() !== '')
        ? uiStudentId.trim()
        : config.get<string>('studentId', '').trim();

      // 1. 检查学号配置
      if (!studentId) {
        const msg = '请输入学号！';
        vscode.window.showErrorMessage(msg);
        this._view?.webview.postMessage({
          type: 'sshTestResult',
          success: false,
          message: msg,
        });
        return;
      }

      // 学号输入后持久化保存
      try {
        await config.update('studentId', studentId, vscode.ConfigurationTarget.Global);
      } catch (e: any) {
        console.warn('保存学号至 VS Code 设置失败:', e);
      }

      // 2. 检查 SSH 私钥
      const customKey = (config.get<string>('linux.privateKeyPath') || '').trim();
      const keyPath = (customKey && fs.existsSync(customKey)) ? customKey : LinuxSshDriver.findDefaultPrivateKey();
      if (!keyPath || !fs.existsSync(keyPath)) {
        const msg = '未找到私钥路径，请检查 %HOME%/.ssh 或者在设置中手动定位';
        vscode.window.showErrorMessage(msg);
        this._view?.webview.postMessage({
          type: 'sshTestResult',
          success: false,
          message: msg,
        });
        return;
      }

      // 3. 检查服务器地址
      const host = (config.get<string>('linux.host') || '10.80.42.230').trim();
      const port = config.get<number>('linux.port', 22);
      if (!host) {
        const msg = '未配置 Linux 服务器地址 (默认: 10.80.42.230)';
        vscode.window.showErrorMessage(msg);
        this._view?.webview.postMessage({ type: 'sshTestResult', success: false, message: msg });
        return;
      }

      this._view?.webview.postMessage({
        type: 'sshTestStart',
        message: `正在连接 ${host}:${port} (用户: u${studentId})...`,
      });

      const sshConf: SshConfig = {
        host,
        port,
        studentId,
        privateKeyPath: keyPath,
        remoteDir: config.get<string>('linux.remoteDir', '~/sjoop_tmp'),
        flags: config.get<string[]>('linux.flags', []),
      };

      const res = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `SJOOP: 正在连接 Linux 服务器 (${host}:${port})...`,
        },
        async () => {
          return await LinuxSshDriver.testConnection(sshConf);
        }
      );

      this._view?.webview.postMessage({
        type: 'sshTestResult',
        success: res.success,
        message: res.message,
      });

      if (res.success) {
        vscode.window.showInformationMessage(res.message);
      } else {
        vscode.window.showErrorMessage(res.message);
      }
      this.refreshState();
    } catch (err: any) {
      const errMsg = `SSH 测试失败: ${err.message}`;
      vscode.window.showErrorMessage(errMsg);
      this._view?.webview.postMessage({
        type: 'sshTestResult',
        success: false,
        message: errMsg,
      });
    }
  }

  public async handleRunBatch() {
    // Auto save all active files before compiling
    await vscode.workspace.saveAll(false);

    const config = vscode.workspace.getConfiguration('sjoop');
    let sources: string[] = [];
    let baseName = '';
    let wsFolder = '';

    if (this.currentProjectConfig.mode === 'multi') {
      const main = this.currentProjectConfig.mainFile || this.currentFilePath || this.activeEditorPath;
      if (!main || !fs.existsSync(main)) {
        const msg = '未找到多文件项目的主源文件！请在单文件模式下打开主程序后再切换为多文件模式。';
        vscode.window.showErrorMessage(msg);
        this._view?.webview.postMessage({ type: 'runError', message: msg });
        return;
      }
      wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(main);
      baseName = path.basename(main, path.extname(main));
      const addFiles = (this.currentProjectConfig.additionalFiles || []).filter(fs.existsSync);
      sources = [main, ...addFiles];
    } else {
      const activeFile = this.currentFilePath || this.activeEditorPath;
      if (!activeFile || !fs.existsSync(activeFile)) {
        const msg = '请先在编辑器中打开一个 C/C++ 源文件！';
        vscode.window.showWarningMessage(msg);
        this._view?.webview.postMessage({ type: 'runError', message: msg });
        return;
      }
      wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(activeFile);
      baseName = path.basename(activeFile, path.extname(activeFile));
      sources = [activeFile];
    }

    let studentId = config.get<string>('studentId', '').trim();

    // Check compilers
    const activeCompilers: CompilerType[] = [];
    if (this.selectedCompilers.msvc) activeCompilers.push('msvc');
    if (this.selectedCompilers.mingw) activeCompilers.push('mingw');
    if (this.selectedCompilers.linux) {
      if (!studentId) {
        const msg = '请输入学号！(使用 Linux 远程编译必须配置学号)';
        vscode.window.showErrorMessage(msg);
        this._view?.webview.postMessage({ type: 'runError', message: msg });
        return;
      }
      const customKey = (config.get<string>('linux.privateKeyPath') || '').trim();
      const keyPath = (customKey && fs.existsSync(customKey)) ? customKey : LinuxSshDriver.findDefaultPrivateKey();
      if (!keyPath || !fs.existsSync(keyPath)) {
        const msg = '未找到私钥路径，请检查 %HOME%/.ssh 或者在设置中手动定位';
        vscode.window.showErrorMessage(msg);
        this._view?.webview.postMessage({ type: 'runError', message: msg });
        return;
      }
      activeCompilers.push('linux');
    }

    if (activeCompilers.length === 0) {
      const msg = '请至少勾选一个编译器！';
      vscode.window.showWarningMessage(msg);
      this._view?.webview.postMessage({ type: 'runError', message: msg });
      return;
    }

    const customKey = (config.get<string>('linux.privateKeyPath') || '').trim();
    const keyPath = (customKey && fs.existsSync(customKey)) ? customKey : LinuxSshDriver.findDefaultPrivateKey();

    const sshConf: SshConfig = {
      host: config.get<string>('linux.host', '10.80.42.230'),
      port: config.get<number>('linux.port', 22),
      studentId: studentId,
      privateKeyPath: keyPath || undefined,
      remoteDir: config.get<string>('linux.remoteDir', '~/sjoop_tmp'),
      flags: config.get<string[]>('linux.flags', []),
    };

    const normalizeNewlines = config.get<boolean>('judge.normalizeNewlines', true);
    const stripTrailingNewlines = config.get<boolean>('judge.stripTrailingNewlines', true);
    const strictDiff = config.get<boolean>('judge.strictByteDiff', true);

    this._view?.webview.postMessage({ type: 'runStart' });

    try {
      const batchRes = await CompilerRunner.executeBatch({
        workspaceRoot: wsFolder,
        sources,
        outputBaseName: baseName,
        selectedCompilers: activeCompilers,
        testCases: this.currentTestCases,
        timeoutMs: config.get<number>('judge.timeoutMs', 5000),
        strictDiff,
        normalizeNewlines,
        stripTrailingNewlines,
        msvcFlags: config.get<string[]>('msvc.flags'),
        customVcvars: config.get<string>('msvc.vcvarsPath'),
        mingwFlags: config.get<string[]>('mingw.flags'),
        customGpp: config.get<string>('mingw.gppPath'),
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

  public _getHtmlForWebview(_webview?: vscode.Webview): string {
    let existingStudentId = '';
    try {
      const config = vscode.workspace.getConfiguration('sjoop');
      existingStudentId = (config.get<string>('studentId', '') || '').trim();
    } catch {
      // ignore
    }

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
      padding: 5px 0;
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
      <div id="encodingBadgeContainer" style="display: flex; gap: 6px; align-items: center;">
        <span class="badge badge-warn" id="encodingBadge">未知编码</span>
        <button class="btn btn-small btn-secondary" id="btnShowLogs" title="打开 SJOOP 运行日志">日志</button>
      </div>
    </div>
    <div id="encodingAlert" style="display:none; font-size: 11px; color: #f14c4c; margin-top: 4px;">
      ⚠️ SJ 课程强制要求 GB18030！
      <button class="btn btn-small" id="btnConvert" style="margin-left: 6px;">转为 GB18030</button>
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
      <div style="font-size: 11px; margin-bottom: 6px; padding: 4px 6px; background: rgba(78, 201, 176, 0.12); border-left: 3px solid #4ec9b0; border-radius: 2px;">
        主程序 (main): <strong id="mainFileName" style="color: #4ec9b0;">-</strong>
      </div>
      <div style="font-size: 11px; color: #aaa; margin-bottom: 4px;">联合编译附加源文件 / 头文件 (<span id="sourceFileCount">0</span>):</div>
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
    <!-- Student ID Field -->
    <div style="display:flex; align-items:center; justify-content:space-between; padding: 6px 0; border-top: 1px dashed rgba(255,255,255,0.08); font-size:12px;">
      <span>学号：</span>
      <input type="text" id="txtStudentId" value="${existingStudentId.replace(/"/g, '&quot;')}" style="width: 110px; padding: 3px 6px; background: var(--vscode-input-background, #1e1e1e); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--border); border-radius: 3px;" placeholder="例如: 2554207">
    </div>
    <div id="sshStatusArea" style="font-size: 11px; margin-top: 6px; display: none; padding: 6px; border-radius: 4px; background: rgba(0,0,0,0.25); word-break: break-all; transition: opacity 0.3s ease;"></div>
  </div>

  <!-- Run Options -->
  <div style="margin: 6px 0 8px 0; padding: 0 4px;">
    <label class="toggle-label" style="font-size: 11px;">
      <input type="checkbox" id="chkNormalizeNewlines" checked>
      <strong>统一换行符并去除文末换行 (CRLF/LF 归一化 & 忽略末尾换行)</strong>
    </label>
  </div>

  <!-- Action Run Button -->
  <button class="btn btn-full" id="btnRunBatch">🚀 编译并运行测试</button>
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

    // Error boundary for webview UI debugging
    window.onerror = function(message, source, lineno, colno, error) {
      console.error('SJOOP UI Exception:', message, 'at line', lineno, error);
      const prog = document.getElementById('progressText');
      if (prog) {
        prog.textContent = '界面异常: ' + message;
      }
    };

    let state = {
      filePath: null,
      fileName: null,
      systemEncoding: '检测中...',
      encodingInfo: null,
      compilers: { msvc: true, mingw: true, linux: false },
      normalizeNewlines: true,
      compilerPaths: { studentId: '' },
      projectConfig: { mode: 'single', mainFile: '', additionalFiles: [] },
      testCases: [],
      lastRunResult: null,
    };

    let sshStatusTimer = null;
    function setSshStatus(msg, status, autoClearMs = 6000) {
      const el = document.getElementById('sshStatusArea');
      const btn = document.getElementById('btnTestSSH');
      if (sshStatusTimer) {
        clearTimeout(sshStatusTimer);
        sshStatusTimer = null;
      }
      el.style.opacity = '1';
      el.style.display = 'block';

      if (status === 'loading') {
        el.style.color = '#e2a03f';
        el.textContent = '⏳ ' + msg;
        btn.disabled = true;
      } else if (status === 'success') {
        el.style.color = '#4ec9b0';
        el.textContent = '✅ ' + msg;
        btn.disabled = false;
      } else {
        el.style.color = '#f14c4c';
        el.textContent = '❌ ' + msg;
        btn.disabled = false;
      }

      if (autoClearMs > 0 && status !== 'loading') {
        sshStatusTimer = setTimeout(() => {
          el.style.opacity = '0';
          setTimeout(() => {
            el.style.display = 'none';
            el.textContent = '';
          }, 300);
          sshStatusTimer = null;
        }, autoClearMs);
      }
    }

    let progressTimer = null;
    function setProgressText(msg, autoClearMs = 0) {
      const el = document.getElementById('progressText');
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }
      el.textContent = msg;
      if (autoClearMs > 0 && msg) {
        progressTimer = setTimeout(() => {
          el.textContent = '';
          progressTimer = null;
        }, autoClearMs);
      }
    }

    // Notify backend ready
    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'stateUpdate':
          state = { ...state, ...msg };
          renderUI();
          break;
        case 'sshTestStart':
          setSshStatus(msg.message, 'loading', 0);
          break;
        case 'sshTestResult':
          setSshStatus(msg.message, msg.success ? 'success' : 'error', 6000);
          break;
        case 'runStart':
          // 新测试开始时，自动关闭上次的测试详情弹窗
          document.getElementById('detailModal').style.display = 'none';
          document.getElementById('modalContent').innerHTML = '';
          setProgressText('开始编译任务...', 0);
          document.getElementById('btnRunBatch').disabled = true;
          break;
        case 'runProgress':
          setProgressText(msg.message, 0);
          break;
        case 'runComplete':
          // 测试完成时，关闭旧弹窗并渲染最新结果
          document.getElementById('detailModal').style.display = 'none';
          document.getElementById('modalContent').innerHTML = '';
          setProgressText('测试完成！', 5000);
          document.getElementById('btnRunBatch').disabled = false;
          state.lastRunResult = msg.result;
          renderResults(msg.result);
          break;
        case 'runError':
          setProgressText('执行出错: ' + msg.message, 8000);
          document.getElementById('btnRunBatch').disabled = false;
          break;
      }
    });

    function renderUI() {
      // 1. Header & Encoding
      document.getElementById('activeFileName').textContent = state.fileName || '未打开 C/C++ 文件';

      const sysText = document.getElementById('systemEncText');
      if (sysText) {
        const sysEnc = state.systemEncoding || (state.encodingInfo && state.encodingInfo.systemEncoding) || 'CP936';
        sysText.textContent = '系统代码页: ' + sysEnc;
      }

      const badge = document.getElementById('encodingBadge');
      const alertBox = document.getElementById('encodingAlert');
      if (state.encodingInfo) {
        if (state.encodingInfo.isTargetEncoding) {
          badge.className = 'badge badge-ok';
          badge.textContent = state.encodingInfo.encoding.toUpperCase() + ' ✅';
          alertBox.style.display = 'none';
        } else {
          badge.className = 'badge badge-warn';
          badge.textContent = state.encodingInfo.encoding.toUpperCase() + ' ⚠️';
          alertBox.style.display = 'block';
        }
      } else {
        if (badge) {
          badge.className = 'badge badge-secondary';
          badge.textContent = '无活动文件';
        }
        if (alertBox) {
          alertBox.style.display = 'none';
        }
      }

      // 2. Mode buttons
      const isMulti = state.projectConfig && state.projectConfig.mode === 'multi';
      document.getElementById('btnModeSingle').className = !isMulti ? 'btn btn-small' : 'btn btn-small btn-secondary';
      document.getElementById('btnModeMulti').className = isMulti ? 'btn btn-small' : 'btn btn-small btn-secondary';
      document.getElementById('multiFileSection').style.display = isMulti ? 'block' : 'none';

      if (isMulti) {
        const mainPath = state.projectConfig.mainFile || state.filePath || '';
        document.getElementById('mainFileName').textContent = mainPath ? mainPath.split(/[\\/]/).pop() : '未指定';
        const addFiles = state.projectConfig.additionalFiles || [];
        document.getElementById('sourceFileCount').textContent = addFiles.length;

        // Source file list
        const ul = document.getElementById('sourceFileList');
        ul.innerHTML = '';
        addFiles.forEach(f => {
          const li = document.createElement('li');
          li.className = 'source-item';
          const span = document.createElement('span');
          span.title = f;
          span.textContent = f.split(/[\\/]/).pop() || f;
          const btn = document.createElement('button');
          btn.className = 'btn btn-small btn-secondary';
          btn.textContent = '移除';
          btn.onclick = () => removeSource(f);
          li.appendChild(span);
          li.appendChild(btn);
          ul.appendChild(li);
        });
      }

      // 3. Compilers
      document.getElementById('chkMsvc').checked = !!state.compilers.msvc;
      document.getElementById('chkMingw').checked = !!state.compilers.mingw;
      document.getElementById('chkLinux').checked = !!state.compilers.linux;

      // Student ID
      const sidInput = document.getElementById('txtStudentId');
      if (state.compilerPaths && state.compilerPaths.studentId !== undefined) {
        if (!sidInput.value || document.activeElement !== sidInput) {
          sidInput.value = state.compilerPaths.studentId;
        }
      }

      // Normalize Newlines
      document.getElementById('chkNormalizeNewlines').checked = state.normalizeNewlines !== false;

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
      document.getElementById('caseCount').textContent = state.testCases.length;

      state.testCases.forEach((tc, idx) => {
        const box = document.createElement('div');
        box.className = 'case-box';

        const header = document.createElement('div');
        header.className = 'case-header';

        const label = document.createElement('label');
        label.className = 'toggle-label';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = !!tc.enabled;
        chk.onchange = (e) => toggleCase(tc.id, e.target.checked);
        const nameStrong = document.createElement('strong');
        nameStrong.textContent = tc.name || ('测试点 #' + (idx + 1));
        label.appendChild(chk);
        label.appendChild(nameStrong);

        const btnDel = document.createElement('button');
        btnDel.className = 'btn btn-small btn-secondary';
        btnDel.textContent = '删除';
        btnDel.onclick = () => deleteCase(tc.id);

        header.appendChild(label);
        header.appendChild(btnDel);

        const inLabel = document.createElement('div');
        inLabel.style.fontSize = '11px';
        inLabel.style.marginBottom = '2px';
        inLabel.textContent = '输入 (stdin):';
        const inArea = document.createElement('textarea');
        inArea.value = tc.input || '';
        inArea.onchange = (e) => updateCaseInput(tc.id, e.target.value);

        const outLabel = document.createElement('div');
        outLabel.style.fontSize = '11px';
        outLabel.style.margin = '4px 0 2px 0';
        outLabel.textContent = '期望输出 (stdout):';
        const outArea = document.createElement('textarea');
        outArea.value = tc.expectedOutput || '';
        outArea.onchange = (e) => updateCaseOutput(tc.id, e.target.value);

        box.appendChild(header);
        box.appendChild(inLabel);
        box.appendChild(inArea);
        box.appendChild(outLabel);
        box.appendChild(outArea);

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
        const tdName = document.createElement('td');
        const strong = document.createElement('strong');
        strong.textContent = tc.name || tc.id;
        tdName.appendChild(strong);
        tr.appendChild(tdName);

        ['msvc', 'mingw', 'linux'].forEach(comp => {
          const tdComp = document.createElement('td');
          const runList = (result.runs && result.runs[comp]) || [];
          const run = runList.find(r => r.testCaseId === tc.id);
          const compRes = result.compilations && result.compilations[comp];

          if (state.compilers && state.compilers[comp]) {
            if (compRes && !compRes.success) {
              const pill = document.createElement('span');
              pill.className = 'pill pill-ce';
              pill.textContent = 'CE';
              pill.onclick = () => showCeDetail(comp);
              tdComp.appendChild(pill);
            } else if (run) {
              const pill = document.createElement('span');
              pill.className = 'pill pill-' + run.status.toLowerCase();
              pill.textContent = run.status + ' (' + run.timeMs + 'ms)';
              pill.onclick = () => showRunDetail(comp, tc.id);
              tdComp.appendChild(pill);
            } else {
              tdComp.innerHTML = '<span style="color:#666;">-</span>';
            }
          } else {
            tdComp.innerHTML = '<span style="color:#666;">-</span>';
          }
          tr.appendChild(tdComp);
        });

        body.appendChild(tr);
      });
    }

    // Detail modal helpers
    window.showCeDetail = function(compiler) {
      const modal = document.getElementById('detailModal');
      const title = document.getElementById('modalTitle');
      const content = document.getElementById('modalContent');
      const compRes = state.lastRunResult && state.lastRunResult.compilations && state.lastRunResult.compilations[compiler];

      title.textContent = compiler.toUpperCase() + ' 编译错误 (CE)';
      content.innerHTML = '<div class="diff-block" style="color:#f14c4c;">' + escapeHtml(compRes ? compRes.errorMessage || '未知编译错误' : '无详细报错') + '</div>';
      modal.style.display = 'block';
    };

    window.showRunDetail = function(compiler, caseId) {
      const modal = document.getElementById('detailModal');
      const title = document.getElementById('modalTitle');
      const content = document.getElementById('modalContent');
      const run = state.lastRunResult && state.lastRunResult.runs && (state.lastRunResult.runs[compiler] || []).find(r => r.testCaseId === caseId);
      const tc = state.testCases.find(c => c.id === caseId);

      if (!run) return;
      title.textContent = (tc ? tc.name : caseId) + ' - ' + compiler.toUpperCase() + ' 详情 (' + run.status + ')';

      let html = '<div style="margin-bottom: 6px;">耗时: ' + run.timeMs + 'ms | 退出码: ' + run.exitCode + '</div>';
      if (run.byteDiff && !run.byteDiff.matched) {
        html += '<div style="color: #f14c4c; font-weight: bold; margin-bottom: 4px;">' + escapeHtml(run.byteDiff.message) + '</div>';
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
    document.getElementById('btnShowLogs').onclick = () => vscode.postMessage({ type: 'showLogs' });
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
    window.removeSource = function(targetPath) {
      vscode.postMessage({ type: 'removeAdditionalFile', filePath: targetPath });
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

    const txtSid = document.getElementById('txtStudentId');
    txtSid.oninput = (e) => {
      vscode.postMessage({ type: 'updateStudentId', studentId: e.target.value });
    };
    txtSid.onchange = (e) => {
      vscode.postMessage({ type: 'updateStudentId', studentId: e.target.value });
    };
    txtSid.onkeydown = (e) => {
      if (e.key === 'Enter') {
        document.getElementById('btnTestSSH').click();
      }
    };

    document.getElementById('chkNormalizeNewlines').onchange = (e) => {
      state.normalizeNewlines = e.target.checked;
      vscode.postMessage({ type: 'updateNormalizeNewlines', normalizeNewlines: e.target.checked });
    };

    document.getElementById('btnTestSSH').onclick = () => {
      const sid = (document.getElementById('txtStudentId').value || '').trim();
      if (!sid) {
        setSshStatus('请输入学号！', 'error', 6000);
        document.getElementById('txtStudentId').focus();
        vscode.postMessage({ type: 'testSSH', studentId: '' });
        return;
      }
      setSshStatus('正在连接 Linux 服务器 (10.80.42.230)...', 'loading', 0);
      vscode.postMessage({ type: 'testSSH', studentId: sid });
    };

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
