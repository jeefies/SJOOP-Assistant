const Module = require('module');

export const vscodeMock = {
      window: {
        createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }),
        showInformationMessage: () => Promise.resolve(),
        showWarningMessage: () => Promise.resolve(),
        showErrorMessage: () => Promise.resolve(),
        showInputBox: (_options: any): Promise<string | undefined> => Promise.resolve(undefined),
        withProgress: (_options: any, task: any) => task(),
        registerWebviewViewProvider: () => ({ dispose: () => {} }),
      },
      workspace: {
        isTrusted: true,
        getWorkspaceFolder: () => undefined,
        saveAll: () => Promise.resolve(true),
        getConfiguration: () => ({
          get: (key: string, defVal: any) => defVal,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        }),
      },
      commands: {
        executeCommand: () => Promise.resolve(),
      },
      ConfigurationTarget: {
        Global: 1,
      },
      ProgressLocation: { Notification: 15 },
      Uri: {
        file: (p: string) => ({ fsPath: p }),
      },
    };

const origRequire = Module.prototype.require;
Module.prototype.require = function (request: string) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return origRequire.apply(this, arguments);
};
