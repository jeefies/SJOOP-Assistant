const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (request: string) {
  if (request === 'vscode') {
    return {
      window: {
        createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }),
        showInformationMessage: () => Promise.resolve(),
        showWarningMessage: () => Promise.resolve('确认删除'),
        showErrorMessage: () => Promise.resolve(),
        showInputBox: () => Promise.resolve('新项目'),
        showOpenDialog: () => Promise.resolve([]),
        registerWebviewViewProvider: () => ({ dispose: () => {} }),
      },
      workspace: {
        saveAll: () => Promise.resolve(true),
        getConfiguration: () => ({
          get: (key: string, defVal: any) => defVal,
          update: () => Promise.resolve(),
        }),
      },
      commands: {
        executeCommand: () => Promise.resolve(),
      },
      ConfigurationTarget: {
        Global: 1,
      },
      Uri: {
        file: (p: string) => ({ fsPath: p }),
      },
    };
  }
  return origRequire.apply(this, arguments);
};
