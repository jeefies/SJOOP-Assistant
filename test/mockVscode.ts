const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (request: string) {
  if (request === 'vscode') {
    return {
      window: {
        createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }),
        showInformationMessage: () => Promise.resolve(),
        showWarningMessage: (...args: any[]) => {
          if (args.includes('确认删除')) return Promise.resolve('确认删除');
          if (args.includes('授权并转换')) return Promise.resolve('授权并转换');
          const strArgs = args.filter((a) => typeof a === 'string');
          return Promise.resolve(strArgs[strArgs.length - 1]);
        },
        showErrorMessage: () => Promise.resolve(),
        showInputBox: () => Promise.resolve('新项目'),
        showQuickPick: (items: any) => Promise.resolve(Array.isArray(items) ? items[0] : undefined),
        showOpenDialog: () => Promise.resolve([]),
        showTextDocument: (doc: any) => Promise.resolve({ document: doc }),
        registerWebviewViewProvider: () => ({ dispose: () => {} }),
        activeTextEditor: undefined,
      },
      workspace: {
        saveAll: () => Promise.resolve(true),
        openTextDocument: (uri: any) => Promise.resolve({ uri, fileName: typeof uri === 'string' ? uri : uri.fsPath, isDirty: false, save: () => Promise.resolve(true) }),
        getConfiguration: () => ({
          get: (key: string, defVal: any) => defVal,
          update: () => Promise.resolve(),
        }),
        textDocuments: [],
        workspaceFolders: [{ uri: { fsPath: '/mock/workspace' }, name: 'mock' }],
      },
      commands: {
        executeCommand: () => Promise.resolve(),
      },
      ConfigurationTarget: {
        Global: 1,
        Workspace: 2,
        WorkspaceFolder: 3,
      },
      Uri: {
        file: (p: string) => ({ fsPath: p, scheme: 'file' }),
      },
    };
  }
  return origRequire.apply(this, arguments);
};
