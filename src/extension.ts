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
  // Task 27 冒烟测试钩子（只读引用，生产无消费者）：src/test/suite 经 globalThis 取运行中的 service
  ;(globalThis as { __ptcAgentServiceRef?: { service: AgentService | null } }).__ptcAgentServiceRef = serviceRef
  const wsRoot = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

  const api: VscodeApi = {
    workspaceFolders: () => wsRoot(),
    globalStoragePath: () => context.globalStorageUri.fsPath,
    fs: {
      readDir: p => fsp.readdir(p),
      readFile: p => fsp.readFile(p, 'utf8'),
      appendFile: (p, s) => fsp.appendFile(p, s, 'utf8'),
      mkdir: async p => { await fsp.mkdir(p, { recursive: true }) },
      writeFile: (p, s) => fsp.writeFile(p, s, 'utf8'),
      deleteFile: p => fsp.rm(p),   // I1：新文件 Reject 时删除工作区文件
      readHead: async (p, bytes) => {
        const fh = await fsp.open(p, 'r')
        try {
          const buf = Buffer.alloc(bytes)
          const { bytesRead } = await fh.read(buf, 0, bytes, 0)
          return buf.subarray(0, bytesRead).toString('utf8')
        } finally { await fh.close() }
      },
      stat: async p => {
        try { const st = await fsp.stat(p); return { mtimeMs: st.mtimeMs, size: st.size } } catch { return null }
      },
    },
    openDiff: async (sessionId, relPath, title) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) return   // 非法会话 id：忽略（防 uri scheme 注入/穿越）
      const root = wsRoot() ?? process.cwd()
      const rel = relPath.replace(/\\/g, '/')
      const abs = path.resolve(root, rel)
      const rootAbs = path.resolve(root)
      if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return   // 相对路径逃逸工作区：忽略
      await openSnapshotDiff(sessionId, rel, abs, title)
    },
    executeCommand: async (command, ...args) => { await vscode.commands.executeCommand(command, ...args) },
    showInputBox: async opts => vscode.window.showInputBox({ prompt: opts.prompt, value: opts.value }),
    showInfoMessage: async msg => { await vscode.window.showInformationMessage(msg) },
    openSimpleBrowser: async url => {
      // Simple Browser 需要带 scheme 的绝对 URI；裸域名补 https://（不做更多校验）
      const uri = vscode.Uri.parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`)
      await vscode.commands.executeCommand('simpleBrowser.api.open', uri)
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
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri, vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui/dist')] }
    // 重开兜底：正常路径由下方 onDidDispose 停旧 service；dispose 事件竞态未达时在此再停一次（防后台烧 token/串写旧 JSONL）
    this.serviceRef.service?.stop('webview re-created')
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
    // view 关闭/重载：中止进行中的回合（LLM 流/工具/worker 不再后台空跑烧 token）
    this.context.subscriptions.push(view.onDidDispose(() => service.stop('webview disposed')))
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui/dist/index.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui/dist/index.css'))
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui/media/codicon.css'))
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${codicons}"><link rel="stylesheet" href="${style}">
      </head><body><div id="root"></div>
      <script nonce="${nonce}" src="${script}"></script></body></html>`
  }
}
export function deactivate(): void {}
