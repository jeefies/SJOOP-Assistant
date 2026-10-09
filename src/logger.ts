import * as vscode from 'vscode';

let channel: vscode.OutputChannel | null = null;

export function initLogger(context?: vscode.ExtensionContext): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('SJOOP Assistant');
    if (context) {
      context.subscriptions.push(channel);
    }
  }
  return channel;
}

export function log(msg: string) {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}`;
  if (channel) {
    channel.appendLine(line);
  }
  console.log(line);
}

export function logError(msg: string, err?: any) {
  const ts = new Date().toLocaleTimeString();
  const detail = err ? ` | Error: ${err.stack || err.message || err}` : '';
  const line = `[${ts}] [ERROR] ${msg}${detail}`;
  if (channel) {
    channel.appendLine(line);
  }
  console.error(line);
}

export function showLog() {
  if (channel) {
    channel.show(true);
  }
}
