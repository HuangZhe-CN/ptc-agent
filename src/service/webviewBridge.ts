import type { HostMessage, UiOp, WebviewMessage } from '../shared/protocol'

/** webview 发送面（vscode.Webview 的最小结构子集，测试用假对象实现同形）。 */
export interface PostTarget {
  postMessage(m: unknown): Thenable<boolean>
  onDidReceiveMessage(l: (m: unknown) => void): unknown
  onDidDispose(cb: () => void): unknown
}

/** Omit 对联合类型默认不分发（keyof (A|B) 只取公共键），这里显式分发。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** host→webview 消息桥：单调 seq、ready 握手、未 ready 入队、disposed/异常静默守卫。 */
export class WebviewBridge {
  private seq = 0
  private isReady = false
  private disposed = false
  private outbox: HostMessage[] = []
  private lastSnapshot: HostMessage | undefined   // 最后一次全量，重握手时重发
  private handler: ((m: WebviewMessage) => void) | undefined
  private readyHandler: (() => void) | undefined

  constructor(private readonly target: Pick<PostTarget, 'postMessage'>) {}

  /** webview→host 消息处理入口（ready 消息由桥内部消化，不下发）。 */
  onMessage(handler: (m: WebviewMessage) => void): void { this.handler = handler }

  /** webview 握手完成回调（extension 里接 service.bootSnapshot）。 */
  onReady(handler: () => void): void { this.readyHandler = handler }

  /** 挂接消息/销毁监听；view dispose 后置 disposed，新 view 由 resolveWebviewView 重新握手。 */
  attach(target: Pick<PostTarget, 'onDidReceiveMessage'> & Partial<Pick<PostTarget, 'onDidDispose'>>): void {
    target.onDidReceiveMessage((raw: unknown) => {
      const m = raw as WebviewMessage
      if (m && m.type === 'ready') { this.ready(); return }
      if (this.disposed) return
      // 非 WebviewMessage 形状（无字符串 type 字段）直接丢弃，不进 handler
      if (!m || typeof m !== 'object' || typeof (m as { type?: unknown }).type !== 'string') return
      this.handler?.(m)
    })
    target.onDidDispose?.(() => { this.disposed = true; this.isReady = false })   // 新 view → 新 bridge 重新握手
  }

  /** webview 发 ready 后：重发最近 snapshot、flush 队列、触发 onReady。 */
  ready(): void {
    if (this.disposed) return
    this.isReady = true
    if (this.lastSnapshot) this.doSend(this.lastSnapshot)
    for (const m of this.outbox) this.doSend(m)
    this.outbox = []
    this.readyHandler?.()
  }

  send(m: DistributiveOmit<HostMessage, 'seq'>): void {
    const withSeq = { ...m, seq: ++this.seq } as HostMessage
    if (withSeq.type === 'snapshot') this.lastSnapshot = withSeq
    if (!this.isReady) { this.outbox.push(withSeq); return }
    this.doSend(withSeq)
  }

  sendOps(sessionId: string, ops: UiOp[]): void {
    if (ops.length > 0) this.send({ type: 'ops', sessionId, ops })
  }

  private doSend(m: HostMessage): void {
    if (this.disposed) return
    try { void Promise.resolve(this.target.postMessage(m)).catch(() => {}) } catch { /* disposed：丢弃 */ }
  }
}
