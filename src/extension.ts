import * as vscode from 'vscode'
import * as path from 'node:path'
import * as fsp from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { AgentService, type VscodeApi } from './service/agentService'
import { WebviewBridge } from './service/webviewBridge'
import { ConfigStore } from './service/configStore'
import { registerSnapshotContentProvider, openSnapshotDiff } from './service/reviewProvider'
import type { SnapshotTracker } from './service/snapshot'

export function activate(context: vscode.ExtensionContext): void {
  const workerPath = path.join(__dirname, 'worker.js')
  const serviceRef: { service: AgentService | null } = { service: null }
  const wsRoot = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

  const api: VscodeApi = {
    workspaceFolders: () => wsRoot(),
    globalStoragePath: () => context.globalStorageUri.fsPath,
    envLanguage: () => vscode.env.language,
    fs: {
      readDir: p => fsp.readdir(p),
      readFile: p => fsp.readFile(p, 'utf8'),
      appendFile: (p, s) => fsp.appendFile(p, s, 'utf8'),
      mkdir: async p => { await fsp.mkdir(p, { recursive: true }) },
      writeFile: (p, s) => fsp.writeFile(p, s, 'utf8'),
    },
    openDiff: async (sessionId, relPath) => {
      const root = wsRoot() ?? process.cwd()
      await openSnapshotDiff(sessionId, relPath, path.resolve(root, relPath))
    },
  }

  // 快照只读内容提供者：uri → 当前会话 tracker 的快照原文
  context.subscriptions.push(registerSnapshotContentProvider((): SnapshotTracker | undefined => serviceRef.service?.currentTracker ?? undefined))

  const provider = new AgentViewProvider(context, api, serviceRef, workerPath)
  // 生态共识（Cline/Roo/Continue/Kilo 同款）：编程式 retain；正确性另由 boot 握手兜底
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ptc-agent.view', provider,
      { webviewOptions: { retainContextWhenHidden: true } }))
}

class AgentViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: VscodeApi,
    private readonly serviceRef: { service: AgentService | null },
    private readonly workerPath: string,
  ) {}
  public resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { localResourceRoots: [this.context.extensionUri, vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui/dist')] }
    const bridge = new WebviewBridge(view.webview)
    // Thenable → Promise 适配（SecretStorage/Memento 是 Thenable 返回面）
    const config = new ConfigStore(
      {
        store: async (k: string, v: string) => { await this.context.secrets.store(k, v) },
        get: async (k: string) => this.context.secrets.get(k),
        delete: async (k: string) => { await this.context.secrets.delete(k) },
      },
      {
        get: <T,>(k: string, d?: T) => this.context.globalState.get<T>(k, d as T),
        update: async (k: string, v: unknown) => { await this.context.globalState.update(k, v) },
      },
    )
    const service = new AgentService({ config, api: this.api, bridge, workerPath: this.workerPath })
    this.serviceRef.service = service
    bridge.attach(view.webview)
    bridge.onMessage(m => { void service.handleWebviewMessage(m) })
    bridge.onReady(() => { void service.bootSnapshot() })   // ready → 握手 flush + boot 快照
    view.webview.html = this.html(view.webview)
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui/dist/index.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui/dist/index.css'))
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui/media/codicon.css'))
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${codicons}"><link rel="stylesheet" href="${style}">
      </head><body><div id="root"></div>
      <script nonce="${nonce}" src="${script}"></script></body></html>`
  }
}
export function deactivate(): void {}
