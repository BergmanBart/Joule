/** VS Code shell: runs the Joule server in the extension host and shows the UI in a webview. */
import { join } from 'node:path';
import * as vscode from 'vscode';
import { startServer } from '@joule/server';

let server: Awaited<ReturnType<typeof startServer>> | undefined;
let panel: vscode.WebviewPanel | undefined;

async function open(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal();
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  server ??= await startServer({ port: 0, uiDir: join(context.extensionPath, 'dist', 'ui'), projectDir: folder });
  const url = server.url;

  panel = vscode.window.createWebviewPanel('joule', 'Joule', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  panel.onDidDispose(() => (panel = undefined), null, context.subscriptions);
  // The UI talks to the local server over HTTP + WebSocket, so it runs in an iframe pointing at it.
  panel.webview.html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${url}; style-src 'unsafe-inline';">
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;overflow:hidden;background:#1e1e1e}</style>
</head><body><iframe src="${url}" allow="clipboard-read; clipboard-write"></iframe></body></html>`;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('joule.open', () => open(context)));
}

export async function deactivate() {
  await server?.close();
}
