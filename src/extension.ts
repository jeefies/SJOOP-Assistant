import * as vscode from 'vscode';
import * as path from 'path';
import { SidebarWebviewProvider } from './webview/sidebarWebviewProvider';
import { checkFileEncoding, convertFileToGB18030 } from './encoding/encodingGuard';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.Context) {
  const provider = new SidebarWebviewProvider(context.extensionUri);

  // Register Webview View in secondary sidebar
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarWebviewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Status Bar Item for Encoding
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'sjoop.checkEncoding';
  context.subscriptions.push(statusBarItem);

  // Function to update active editor state
  const updateActiveEditor = (editor?: vscode.TextEditor) => {
    if (!editor || !editor.document) {
      vscode.commands.executeCommand('setContext', 'sjoop.active', false);
      statusBarItem.hide();
      provider.setActiveFile(null);
      return;
    }

    const doc = editor.document;
    const isCpp = doc.languageId === 'cpp' || doc.languageId === 'c' || /\.(cpp|c|h|hpp)$/i.test(doc.fileName);

    vscode.commands.executeCommand('setContext', 'sjoop.active', isCpp);

    if (isCpp && doc.uri.scheme === 'file') {
      const filePath = doc.uri.fsPath;
      provider.setActiveFile(filePath);

      // Update status bar item
      const encCheck = checkFileEncoding(filePath);
      if (encCheck.isTargetEncoding) {
        statusBarItem.text = `$(check) SJOOP: ${encCheck.encoding.toUpperCase()}`;
        statusBarItem.tooltip = `文件编码符合 SJ 课程要求 (${encCheck.encoding.toUpperCase()})。\n点击重新检测。`;
        statusBarItem.backgroundColor = undefined;
      } else {
        statusBarItem.text = `$(alert) SJOOP: ${encCheck.encoding.toUpperCase()} (非GBK)`;
        statusBarItem.tooltip = `警告: SJ 课程强制要求 GB18030 / GBK 编码！\n点击可查看详情或转换。`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      }
      statusBarItem.show();
    } else {
      statusBarItem.hide();
      provider.setActiveFile(null);
    }
  };

  // Listeners
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateActiveEditor),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document === doc) {
        updateActiveEditor(activeEditor);

        const config = vscode.workspace.getConfiguration('sjoop');
        const autoWarn = config.get<boolean>('encoding.autoWarn', true);
        if (autoWarn && (doc.languageId === 'cpp' || doc.languageId === 'c')) {
          const encCheck = checkFileEncoding(doc.fileName);
          if (!encCheck.isTargetEncoding) {
            vscode.window
              .showWarningMessage(
                `[SJOOP 编码告警] 当前文件保存为 ${encCheck.encoding.toUpperCase()}！SJ 课程红线要求必须使用 GB18030。`,
                '一键转为 GB18030'
              )
              .then((sel) => {
                if (sel === '一键转为 GB18030') {
                  vscode.commands.executeCommand('sjoop.convertToGB18030');
                }
              });
          }
        }
      }
    })
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('sjoop.checkEncoding', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        vscode.window.showInformationMessage('请在编辑器中打开一个本地 C/C++ 源文件！');
        return;
      }
      const res = checkFileEncoding(editor.document.fileName);
      if (res.isTargetEncoding) {
        vscode.window.showInformationMessage(`编码检测通过: ${res.encoding.toUpperCase()} (符合 GB18030 要求)`);
      } else {
        vscode.window
          .showWarningMessage(res.message || '文件非 GB18030 编码！', '一键转为 GB18030')
          .then((sel) => {
            if (sel === '一键转为 GB18030') {
              vscode.commands.executeCommand('sjoop.convertToGB18030');
            }
          });
      }
      provider.refreshState();
    }),

    vscode.commands.registerCommand('sjoop.convertToGB18030', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        vscode.window.showErrorMessage('请在编辑器中打开一个本地源文件！');
        return;
      }
      await editor.document.save();
      const res = convertFileToGB18030(editor.document.fileName);
      if (res.success) {
        vscode.window.showInformationMessage(res.message);
      } else {
        vscode.window.showErrorMessage(res.message);
      }
      updateActiveEditor(editor);
    }),

    vscode.commands.registerCommand('sjoop.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'sjoop');
    }),

    vscode.commands.registerCommand('sjoop.buildAndRun', async () => {
      await provider.handleRunBatch();
    }),

    vscode.commands.registerCommand('sjoop.testSSHConnection', async () => {
      await provider.handleTestSSH();
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sjoop')) {
        provider.refreshState();
      }
    })
  );

  // Initialize for current editor
  updateActiveEditor(vscode.window.activeTextEditor);
}

export function deactivate() {}
