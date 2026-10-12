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
        case 'createProject':
          await this.handleCreateProject();
          break;
        case 'switchProject':
          this.handleSwitchProject(data.projectId);
          break;
        case 'renameProject':
          await this.handleRenameProject();
          break;
        case 'deleteProject':
          await this.handleDeleteProject();
          break;
        case 'updateConfig':
          if (data.projectConfig) {
            const oldMode = this.currentProjectConfig.mode;
            this.currentProjectConfig.mode = data.projectConfig.mode;
            if (this.currentProjectConfig.mode === 'multi') {
              const active = CaseManager.getActiveProject();
              if (data.projectConfig.additionalFiles && data.projectConfig.additionalFiles.length > 0) {
                active.files = data.projectConfig.additionalFiles;
                CaseManager.updateProject(active);
              } else if (active.files.length === 0) {
                const current = this.activeEditorPath || this.currentFilePath;
                if (current && fs.existsSync(current)) {
                  active.files.push(current);
                  CaseManager.updateProject(active);
                }
              }
              this.currentProjectConfig.additionalFiles = active.files;
              this.currentProjectConfig.activeProjectId = active.id;
              this.currentTestCases = active.testCases;
              CaseManager.saveProjectConfig('', '', this.currentProjectConfig);
            } else if (oldMode === 'multi' && this.currentProjectConfig.mode === 'single') {
              CaseManager.saveProjectConfig('', '', this.currentProjectConfig);
              this.currentFilePath = this.activeEditorPath || this.currentFilePath;
              this.loadDataForActiveFile();
            } else {
              CaseManager.saveProjectConfig('', '', this.currentProjectConfig);
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
    if (this.activeEditorPath === filePath) {
      return;
    }
    this.activeEditorPath = filePath;

    // 多文件模式下，切换焦点文件绝不重置模式或刷新工程配置！保持多文件项目锁定
    if (this.currentProjectConfig.mode === 'multi') {
      this.notifyActiveFileChanged(filePath);
      return;
    }

    // 单文件模式下，跟随活动编辑器文件切换
    this.currentFilePath = filePath;
    this.loadDataForActiveFile();
    this.refreshState();
  }

  private notifyActiveFileChanged(filePath: string | null) {
    if (!this._view) return;
    const config = vscode.workspace.getConfiguration('sjoop');
    const encodingTarget = config.get<string>('encoding.targetCharset', 'gb18030');
    let encResult = null;
    const fileToCheck = filePath || this.currentProjectConfig.mainFile;
    if (fileToCheck && fs.existsSync(fileToCheck)) {
      encResult = checkFileEncoding(fileToCheck, encodingTarget);
    }
    const systemEncoding = getSystemEncoding();

    this._view.webview.postMessage({
      type: 'activeFileChanged',
      filePath: fileToCheck,
      fileName: fileToCheck ? path.basename(fileToCheck) : null,
      systemEncoding,
      encodingInfo: encResult,
    });
  }

  private loadDataForActiveFile() {
    if (!this.currentFilePath) {
      this.currentTestCases = [];
      return;
    }

    this.currentTestCases = CaseManager.loadSingleFileTestCases(this.currentFilePath);
    this.currentProjectConfig.mode = 'single';
    this.currentProjectConfig.mainFile = this.currentFilePath;
    this.currentProjectConfig.additionalFiles = [];
  }

  private saveCurrentTestCases() {
    if (this.currentProjectConfig.mode === 'multi') {
      const active = CaseManager.getActiveProject();
      active.testCases = this.currentTestCases;
      CaseManager.updateProject(active);
    } else {
      if (this.currentFilePath) {
        CaseManager.saveSingleFileTestCases(this.currentFilePath, this.currentTestCases);
      }
    }
  }

  public refreshState() {
    if (!this._view) return;

    const config = vscode.workspace.getConfiguration('sjoop');
    const encodingTarget = config.get<string>('encoding.targetCharset', 'gb18030');
    let encResult = null;

    if (this.currentProjectConfig.mode === 'multi') {
      const activeProj = CaseManager.getActiveProject();
      const store = CaseManager.getProjectsStore();
      this.currentProjectConfig.activeProjectId = activeProj.id;
      this.currentProjectConfig.projects = store.projects.map((p) => ({ id: p.id, name: p.name }));
      this.currentProjectConfig.additionalFiles = activeProj.files;
      this.currentTestCases = activeProj.testCases;
    }

    // 优先检查当前正在编辑的代码文件编码，没有则检查主文件
    const fileToCheck = this.activeEditorPath || this.currentFilePath;
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

  private async handleCreateProject() {
    const name = await vscode.window.showInputBox({
      prompt: '请输入多文件项目名称',
      placeHolder: '例如: 作业五-面向对象设计',
    });
    if (name && name.trim()) {
      const proj = CaseManager.createProject(name.trim());
      this.currentProjectConfig.mode = 'multi';
      this.currentTestCases = proj.testCases;
      this.refreshState();
      vscode.window.showInformationMessage(`项目 "${proj.name}" 创建成功！`);
    }
  }

  private handleSwitchProject(projectId: string) {
    if (projectId) {
      const proj = CaseManager.setActiveProject(projectId);
      this.currentProjectConfig.mode = 'multi';
      this.currentTestCases = proj.testCases;
      this.refreshState();
    }
  }

  private async handleRenameProject() {
    this.currentProjectConfig.mode = 'multi';
    const active = CaseManager.getActiveProject();
    const newName = await vscode.window.showInputBox({
      prompt: '重命名当前项目',
      value: active.name,
    });
    if (newName && newName.trim()) {
      CaseManager.renameProject(active.id, newName.trim());
      this.refreshState();
      vscode.window.showInformationMessage(`项目已更名为 "${newName.trim()}"`);
    }
  }

  private async handleDeleteProject() {
    this.currentProjectConfig.mode = 'multi';
    const active = CaseManager.getActiveProject();
    const choice = await vscode.window.showWarningMessage(
      `确定要删除项目 "${active.name}" 吗？该项目的联合编译列表与测试用例将一并删除。`,
      { modal: true },
      '确认删除'
    );
    if (choice === '确认删除') {
      CaseManager.deleteProject(active.id);
      const newActive = CaseManager.getActiveProject();
      this.currentTestCases = newActive.testCases;
      this.refreshState();
      vscode.window.showInformationMessage(`项目已删除`);
    }
  }

  private async handleAddAdditionalFile() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: '添加为联合编译源文件',
      filters: { 'C/C++ Files': ['cpp', 'c', 'h', 'hpp'] },
    });

    if (uris && uris.length > 0) {
      const active = CaseManager.getActiveProject();
      if (!active.files) {
        active.files = [];
      }
      const normalize = (p: string) => path.resolve(p).toLowerCase();

      for (const u of uris) {
        const uNorm = normalize(u.fsPath);
        if (!active.files.some((f) => normalize(f) === uNorm)) {
          active.files.push(u.fsPath);
        }
      }
      CaseManager.updateProject(active);
      this.refreshState();
    }
  }

  private handleRemoveAdditionalFile(fPath: string) {
    const active = CaseManager.getActiveProject();
    if (!active.files) return;
    const normalize = (p: string) => path.resolve(p).toLowerCase();
    const targetNorm = normalize(fPath);
    active.files = active.files.filter((p) => normalize(p) !== targetNorm);
    CaseManager.updateProject(active);
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
    let testCasesToRun: TestCase[] = [];

    if (this.currentProjectConfig.mode === 'multi') {
      const activeProj = CaseManager.getActiveProject();
      const allFiles = (activeProj.files || []).filter(fs.existsSync);
      if (allFiles.length === 0) {
        const msg = '多文件模式下请先点击 "+ 添加 .cpp / .h 文件" 添加需要联合编译的文件！';
        vscode.window.showWarningMessage(msg);
        this._view?.webview.postMessage({ type: 'runError', message: msg });
        return;
      }

      const cppFiles = allFiles.filter((f) => /\.(cpp|c|cc|cxx)$/i.test(f));
      if (cppFiles.length === 0) {
        const msg = '多文件列表中未包含任何可编译的 .cpp / .c 源文件！';
        vscode.window.showWarningMessage(msg);
        this._view?.webview.postMessage({ type: 'runError', message: msg });
        return;
      }

      wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(allFiles[0]);
      baseName = path.basename(cppFiles[0], path.extname(cppFiles[0]));
      sources = allFiles;
      testCasesToRun = activeProj.testCases || this.currentTestCases;
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
      testCasesToRun = this.currentTestCases;
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
        testCases: testCasesToRun,
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
      min-height: 42px;
      max-height: 360px;
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--border);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      line-height: 1.4;
      box-sizing: border-box;
      resize: vertical;
      padding: 5px;
      overflow-y: auto;
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
    .pill-run { background-color: #007acc; }
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
    .diff-container {
      margin-top: 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .diff-header {
      background: rgba(255, 255, 255, 0.06);
      padding: 5px 8px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .diff-body {
      background: #111;
      max-height: 250px;
      overflow-y: auto;
      padding: 4px 0;
    }
    .diff-row {
      display: flex;
      padding: 1px 8px;
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.4;
    }
    .diff-row-equal { color: #888; }
    .diff-row-add { background: rgba(56, 138, 52, 0.22); color: #4ec9b0; }
    .diff-row-remove { background: rgba(229, 20, 0, 0.22); color: #f14c4c; }
    .diff-ln {
      width: 28px;
      min-width: 28px;
      color: #666;
      text-align: right;
      margin-right: 8px;
      user-select: none;
    }
    .diff-sign {
      width: 14px;
      min-width: 14px;
      user-select: none;
      font-weight: bold;
    }
    .diff-txt { flex: 1; min-width: 0; }
  </style>
</head>
<body>
  <!-- Mode Selection & File Context -->
  <div class="card" id="modeCard">
    <div class="header-bar">
      <strong>模式选择</strong>
      <div style="display: flex; gap: 6px; align-items: center;">
        <button class="btn btn-small btn-secondary" id="btnModeSingle">单文件</button>
        <button class="btn btn-small btn-secondary" id="btnModeMulti">多文件</button>
        <button class="btn btn-small btn-secondary" id="btnShowLogs" title="打开 SJOOP 运行日志">日志</button>
      </div>
    </div>

    <!-- Single File Section (Shown only in Single-File Mode) -->
    <div id="singleFileSection" style="margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px;">
      <div class="header-bar" style="margin-bottom: 4px;">
        <div>
          <strong id="activeFileName" style="font-size: 13px;">未打开 C/C++ 文件</strong>
        </div>
        <div id="encodingBadgeContainer">
          <span class="badge badge-warn" id="encodingBadge">未知编码</span>
        </div>
      </div>
      <div id="encodingAlert" style="display:none; font-size: 11px; color: #f14c4c; margin-top: 4px;">
        ⚠️ SJ 课程强制要求 GB18030！
        <button class="btn btn-small" id="btnConvert" style="margin-left: 6px;">转为 GB18030</button>
      </div>
      <div style="font-size: 10px; color: #888; margin-top: 4px;" id="systemEncText">系统默认: 检测中...</div>
    </div>

    <!-- Multi File Section (Shown only in Multi-File Mode) -->
    <div id="multiFileSection" style="display: none; margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px;">
      <!-- Project Switcher & Toolbar -->
      <div style="display: flex; gap: 6px; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <div style="display: flex; gap: 6px; align-items: center; flex: 1; min-width: 0;">
          <span style="font-size: 11px; color: #aaa; white-space: nowrap;">项目:</span>
          <select id="selProject" style="flex: 1; min-width: 0; padding: 2px 4px; background: var(--vscode-input-background, #1e1e1e); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--border); border-radius: 3px; font-size: 12px;"></select>
        </div>
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-small btn-secondary" id="btnNewProject" title="新建多文件项目">+ 新建</button>
          <button class="btn btn-small btn-secondary" id="btnRenameProject" title="重命名当前项目">重命名</button>
          <button class="btn btn-small btn-secondary" id="btnDeleteProject" title="删除当前项目" style="color: #f14c4c;">删除</button>
        </div>
      </div>
      <div style="font-size: 11px; color: #aaa; margin-bottom: 4px;">联合编译文件列表 (<span id="sourceFileCount">0</span>):</div>
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
        case 'activeFileChanged':
          state.filePath = msg.filePath;
          state.fileName = msg.fileName;
          state.systemEncoding = msg.systemEncoding;
          state.encodingInfo = msg.encodingInfo;
          renderHeaderOnly();
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
          lastRenderedResultsKey = '';
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

    function renderHeaderOnly() {
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
    }

    let lastRenderedProjectsKey = '';
    function renderProjectsDropdown(projects, activeId) {
      const currentKey = JSON.stringify({ p: projects || [], a: activeId });
      if (currentKey === lastRenderedProjectsKey) {
        return;
      }
      lastRenderedProjectsKey = currentKey;
      const sel = document.getElementById('selProject');
      if (!sel) return;
      sel.innerHTML = '';
      (projects || []).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === activeId) {
          opt.selected = true;
        }
        sel.appendChild(opt);
      });
    }

    let lastRenderedSourcesJson = '';
    function renderSourceList(addFiles) {
      const sourcesJson = JSON.stringify(addFiles || []);
      if (sourcesJson === lastRenderedSourcesJson) {
        return;
      }
      lastRenderedSourcesJson = sourcesJson;
      const ul = document.getElementById('sourceFileList');
      ul.innerHTML = '';
      (addFiles || []).forEach(f => {
        const li = document.createElement('li');
        li.className = 'source-item';
        const span = document.createElement('span');
        span.title = f;
        span.textContent = getBaseName(f) || f;
        const btn = document.createElement('button');
        btn.className = 'btn btn-small btn-secondary';
        btn.textContent = '移除';
        btn.onclick = () => removeSource(f);
        li.appendChild(span);
        li.appendChild(btn);
        ul.appendChild(li);
      });
    }

    function renderUI() {
      // 1. Mode buttons & section visibility
      const isMulti = state.projectConfig && state.projectConfig.mode === 'multi';
      document.getElementById('btnModeSingle').className = !isMulti ? 'btn btn-small' : 'btn btn-small btn-secondary';
      document.getElementById('btnModeMulti').className = isMulti ? 'btn btn-small' : 'btn btn-small btn-secondary';
      document.getElementById('singleFileSection').style.display = isMulti ? 'none' : 'block';
      document.getElementById('multiFileSection').style.display = isMulti ? 'block' : 'none';

      // 2. Header & Encoding
      renderHeaderOnly();

      // 3. Multi-file sources & projects
      if (isMulti) {
        renderProjectsDropdown(state.projectConfig.projects, state.projectConfig.activeProjectId);
        const addFiles = state.projectConfig.additionalFiles || [];
        document.getElementById('sourceFileCount').textContent = addFiles.length;
        renderSourceList(addFiles);
      } else {
        lastRenderedSourcesJson = '';
        lastRenderedProjectsKey = '';
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
      } else {
        document.getElementById('resultCard').style.display = 'none';
        lastRenderedResultsKey = '';
      }
    }

    let lastRenderedCasesJson = '';
    function renderCases() {
      const casesJson = JSON.stringify(state.testCases || []);
      if (casesJson === lastRenderedCasesJson) {
        return;
      }
      lastRenderedCasesJson = casesJson;
      const container = document.getElementById('caseListContainer');
      container.innerHTML = '';
      document.getElementById('caseCount').textContent = (state.testCases || []).length;

      (state.testCases || []).forEach((tc, idx) => {
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
        inArea.oninput = () => autoResizeTextarea(inArea);
        inArea.onchange = (e) => updateCaseInput(tc.id, e.target.value);

        const outLabel = document.createElement('div');
        outLabel.style.fontSize = '11px';
        outLabel.style.margin = '4px 0 2px 0';
        outLabel.textContent = '期望输出 (stdout):';
        const outArea = document.createElement('textarea');
        outArea.value = tc.expectedOutput || '';
        outArea.oninput = () => autoResizeTextarea(outArea);
        outArea.onchange = (e) => updateCaseOutput(tc.id, e.target.value);

        box.appendChild(header);
        box.appendChild(inLabel);
        box.appendChild(inArea);
        box.appendChild(outLabel);
        box.appendChild(outArea);

        container.appendChild(box);
        autoResizeTextarea(inArea);
        autoResizeTextarea(outArea);
      });

      setTimeout(() => {
        container.querySelectorAll('textarea').forEach(autoResizeTextarea);
      }, 0);
    }

    function autoResizeTextarea(el) {
      if (!el) return;
      el.style.height = 'auto';
      const targetHeight = Math.max(42, Math.min(el.scrollHeight + 4, 360));
      el.style.height = targetHeight + 'px';
    }

    let lastRenderedResultsKey = '';
    function renderResults(result) {
      const card = document.getElementById('resultCard');
      if (!result) {
        card.style.display = 'none';
        lastRenderedResultsKey = '';
        return;
      }
      const currentKey = JSON.stringify({
        res: result,
        cases: (state.testCases || []).map(c => ({ id: c.id, name: c.name, enabled: c.enabled })),
        compilers: state.compilers
      });
      if (currentKey === lastRenderedResultsKey && card.style.display === 'block') {
        return;
      }
      lastRenderedResultsKey = currentKey;
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

    // Line-by-line Diff Generator
    function generateLineDiffHtml(expectedStr, actualStr) {
      const expNorm = (expectedStr || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
      const actNorm = (actualStr || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');

      let expLines = expNorm.split('\\n');
      let actLines = actNorm.split('\\n');

      if (expLines.length > 1 && expLines[expLines.length - 1] === '') expLines.pop();
      if (actLines.length > 1 && actLines[actLines.length - 1] === '') actLines.pop();

      const m = expLines.length;
      const n = actLines.length;

      let diff = [];
      if (m * n <= 250000) {
        const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
        for (let i = 0; i < m; i++) {
          for (let j = 0; j < n; j++) {
            if (expLines[i] === actLines[j]) {
              dp[i + 1][j + 1] = dp[i][j] + 1;
            } else {
              dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
          }
        }

        let i = m, j = n;
        while (i > 0 || j > 0) {
          if (i > 0 && j > 0 && expLines[i - 1] === actLines[j - 1]) {
            diff.unshift({ type: 'equal', text: expLines[i - 1], expNum: i, actNum: j });
            i--;
            j--;
          } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.unshift({ type: 'add', text: actLines[j - 1], actNum: j });
            j--;
          } else if (i > 0) {
            diff.unshift({ type: 'remove', text: expLines[i - 1], expNum: i });
            i--;
          }
        }
      } else {
        const maxLen = Math.max(m, n);
        for (let k = 0; k < maxLen; k++) {
          if (k < m && k < n && expLines[k] === actLines[k]) {
            diff.push({ type: 'equal', text: expLines[k], expNum: k + 1, actNum: k + 1 });
          } else {
            if (k < m) diff.push({ type: 'remove', text: expLines[k], expNum: k + 1 });
            if (k < n) diff.push({ type: 'add', text: actLines[k], actNum: k + 1 });
          }
        }
      }

      const diffCount = diff.filter(d => d.type !== 'equal').length;
      let html = '<div class="diff-container">';
      html += '<div class="diff-header"><span><strong>差异对比 (Diff):</strong> ' + (diffCount > 0 ? ('共 ' + diffCount + ' 行不匹配') : '内容一致') + '</span><span style="font-size:10px;"><span style="color:#f14c4c;font-weight:bold;">- 期望</span> / <span style="color:#4ec9b0;font-weight:bold;">+ 实际</span></span></div>';
      html += '<div class="diff-body">';

      diff.forEach(item => {
        const lineNum = item.actNum !== undefined ? item.actNum : item.expNum;
        if (item.type === 'equal') {
          html += '<div class="diff-row diff-row-equal"><span class="diff-ln">' + lineNum + '</span><span class="diff-sign"> </span><span class="diff-txt">' + escapeHtml(item.text) + '</span></div>';
        } else if (item.type === 'add') {
          html += '<div class="diff-row diff-row-add"><span class="diff-ln">' + (item.actNum || '') + '</span><span class="diff-sign">+</span><span class="diff-txt">' + escapeHtml(item.text) + '</span></div>';
        } else if (item.type === 'remove') {
          html += '<div class="diff-row diff-row-remove"><span class="diff-ln">' + (item.expNum || '') + '</span><span class="diff-sign">-</span><span class="diff-txt">' + escapeHtml(item.text) + '</span></div>';
        }
      });

      html += '</div></div>';
      return html;
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

    window.adoptStdout = function(caseId) {
      const tc = state.testCases.find(c => c.id === caseId);
      if (!tc || !state.lastRunResult) return;
      let outVal = null;
      ['msvc', 'mingw', 'linux'].forEach(comp => {
        const run = (state.lastRunResult.runs[comp] || []).find(r => r.testCaseId === caseId);
        if (run && run.stdout !== undefined && outVal === null) {
          outVal = run.stdout;
        }
      });
      if (outVal !== null) {
        tc.expectedOutput = outVal;
        vscode.postMessage({ type: 'updateTestCases', testCases: state.testCases });
        renderCases();
        document.getElementById('detailModal').style.display = 'none';
        setProgressText('已将实际输出设为该点期望输出！', 3000);
      }
    };

    window.copyToClipboard = function(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          setProgressText('已复制到剪贴板！', 2000);
        }).catch(() => {});
      }
    };

    window.showRunDetail = function(compiler, caseId) {
      const modal = document.getElementById('detailModal');
      const title = document.getElementById('modalTitle');
      const content = document.getElementById('modalContent');
      const run = state.lastRunResult && state.lastRunResult.runs && (state.lastRunResult.runs[compiler] || []).find(r => r.testCaseId === caseId);
      const tc = state.testCases.find(c => c.id === caseId);

      if (!run) return;
      title.textContent = (tc ? tc.name : caseId) + ' - ' + compiler.toUpperCase() + ' 详情 (' + run.status + ')';

      let html = '<div style="margin-bottom: 6px; font-size: 11px; color: #aaa;">耗时: ' + run.timeMs + 'ms | 退出码: ' + run.exitCode + '</div>';

      if (run.status === 'RUN') {
        html += '<div style="background: rgba(0, 122, 204, 0.15); border: 1px solid #007acc; padding: 6px; border-radius: 4px; margin-bottom: 8px; color: #569cd6; font-size: 11px;">';
        html += 'ℹ️ 本测试点未设置期望输出，程序正常执行完成，仅给出实际输出 (stdout)。';
        html += '</div>';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 3px;">';
        html += '<strong style="color: #4ec9b0; font-size: 11px;">程序实际输出 (stdout):</strong>';
        html += '<div style="display:flex; gap:4px;">';
        html += '<button id="btnModalAdopt" class="btn btn-small">📋 设为期望输出</button>';
        html += '<button id="btnModalCopy" class="btn btn-small btn-secondary">复制</button>';
        html += '</div>';
        html += '</div>';
        html += '<div class="diff-block" style="color: #eee; max-height: 240px; overflow-y: auto;">' + escapeHtml(run.stdout || '(无输出)') + '</div>';
      } else if (run.status === 'WA') {
        const expText = tc ? tc.expectedOutput : (run.byteDiff && run.byteDiff.expectedContext) || '';
        const actText = run.stdout !== undefined ? run.stdout : (run.byteDiff && run.byteDiff.actualContext) || '';

        // 1. Visual Line Diff
        html += generateLineDiffHtml(expText, actText);

        // 2. Full Actual Output (完整的实际输出，绝不截断！)
        html += '<div style="margin-top: 8px;">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 3px;">';
        html += '<strong style="color: #4ec9b0; font-size: 11px;">完整实际输出 (stdout):</strong>';
        html += '<button id="btnModalCopy" class="btn btn-small btn-secondary">复制输出</button>';
        html += '</div>';
        html += '<div class="diff-block" style="color: #eee; max-height: 160px; overflow-y: auto;">' + escapeHtml(run.stdout || '(无输出)') + '</div>';
        html += '</div>';

        // 3. Full Expected Output
        html += '<div style="margin-top: 6px;">';
        html += '<div style="font-size: 11px; color: #aaa; margin-bottom: 3px;"><strong>完整期望输出:</strong></div>';
        html += '<div class="diff-block" style="color: #bbb; max-height: 120px; overflow-y: auto;">' + escapeHtml((tc ? tc.expectedOutput : '') || '(无)') + '</div>';
        html += '</div>';

        // 4. 底层字节详情（折叠隐藏，避免又臭又长）
        if (run.byteDiff && run.byteDiff.message) {
          html += '<details style="margin-top: 8px; font-size: 10px; color: #888;">';
          html += '<summary style="cursor: pointer;">底层字节偏移数据</summary>';
          html += '<div style="margin-top: 4px; padding: 4px; background: rgba(0,0,0,0.3); border-radius: 3px; color: #aaa;">' + escapeHtml(run.byteDiff.message) + '</div>';
          html += '</details>';
        }
      } else if (run.status === 'AC') {
        html += '<div style="color: #4ec9b0; font-weight: bold; margin-bottom: 6px;">✅ 测试通过，输出与标准答案一致。</div>';
        html += '<div style="font-size: 11px; color: #aaa; margin-bottom: 3px;"><strong>实际输出 (stdout):</strong></div>';
        html += '<div class="diff-block" style="color: #eee; max-height: 180px; overflow-y: auto;">' + escapeHtml(run.stdout || '(无输出)') + '</div>';
      }

      if (run.stderr) {
        html += '<div style="font-size: 10px; color:#aaa; margin-top: 6px;">标准错误 (stderr):</div>';
        html += '<div class="diff-block" style="color:#e2a03f; max-height: 120px; overflow-y: auto;">' + escapeHtml(run.stderr) + '</div>';
      }

      content.innerHTML = html;
      const btnAdopt = document.getElementById('btnModalAdopt');
      if (btnAdopt) {
        btnAdopt.onclick = () => window.adoptStdout(caseId);
      }
      const btnCopy = document.getElementById('btnModalCopy');
      if (btnCopy) {
        btnCopy.onclick = () => window.copyToClipboard(run.stdout || '');
      }
      modal.style.display = 'block';
    };

    document.getElementById('btnCloseModal').onclick = () => {
      document.getElementById('detailModal').style.display = 'none';
    };

    function escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function getBaseName(p) {
      if (!p) return '';
      const backslash = String.fromCharCode(92);
      const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf(backslash));
      return idx >= 0 ? p.slice(idx + 1) : p;
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

    document.getElementById('selProject').onchange = (e) => {
      vscode.postMessage({ type: 'switchProject', projectId: e.target.value });
    };
    document.getElementById('btnNewProject').onclick = () => {
      vscode.postMessage({ type: 'createProject' });
    };
    document.getElementById('btnRenameProject').onclick = () => {
      vscode.postMessage({ type: 'renameProject' });
    };
    document.getElementById('btnDeleteProject').onclick = () => {
      vscode.postMessage({ type: 'deleteProject' });
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
