import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import * as path from 'node:path'

export function activate(context: vscode.ExtensionContext) {
  const provider = new AgentViewProvider(context.extensionUri)
  // 生态共识（Cline/Roo/Continue/Kilo 同款）：编程式 retain；正确性另由 boot 握手兜底（Task 17）
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ptc-agent.view', provider,
      { webviewOptions: { retainContextWhenHidden: true } }))
}

class AgentViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extUri: vscode.Uri) {}
  public resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { localResourceRoots: [this.extUri, vscode.Uri.joinPath(this.extUri, 'webview-ui/dist')] }
    view.webview.html = this.html(view.webview)
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'webview-ui/dist/index.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'webview-ui/dist/index.css'))
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'webview-ui/media/codicon.css'))
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${codicons}"><link rel="stylesheet" href="${style}">
      </head><body><div id="root"></div>
      <script nonce="${nonce}" src="${script}"></script></body></html>`
  }
}
export function deactivate() {}
