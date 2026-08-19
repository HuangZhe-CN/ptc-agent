import * as path from 'node:path'
import type { Protocol, WebviewMessage, UiOp, TimelineEvent, QueuedMessage, FileChangeSummary, SessionPhase, WebviewState } from '../shared/protocol'
import { initialWebviewState } from '../shared/protocol'
import { ConfigStore } from './configStore'
import { WebviewBridge } from './webviewBridge'
import { SessionStore, type SessionStoreDeps } from '../session/store'
import { SnapshotTracker } from './snapshot'
import { AgentLoop } from '../agent/loop'
import { openaiAdapter } from '../protocol/openai'
import { anthropicAdapter } from '../protocol/anthropic'
import { geminiAdapter } from '../protocol/gemini'
import type { ProtocolAdapter, ResolvedProvider, HistoryMessage } from '../protocol/types'
import { CodeRuntime } from '../runtime/codeRuntime'
import { createTools } from '../tools/registry'

const ADAPTERS: Record<Protocol, ProtocolAdapter> = { openai: openaiAdapter, anthropic: anthropicAdapter, gemini: geminiAdapter }

/** VscodeApi.fs：SessionStore 依赖面 + SnapshotTracker 的 writeFile。 */
export interface VscodeFsApi extends SessionStoreDeps {
  writeFile(p: string, s: string): Promise<void>
}

/** vscode 依赖注入面（extension.ts 提供真实现；测试提供假实现）。 */
export interface VscodeApi {
  workspaceFolders(): string | undefined
  globalStoragePath(): string
  envLanguage(): string
  fs: VscodeFsApi
  openDiff(sessionId: string, relPath: string): Promise<void>
}

export interface AgentServiceDeps { config: ConfigStore; api: VscodeApi; bridge: WebviewBridge; workerPath: string }

export class AgentService {
  /** 测试钩子（公开属性）：覆盖真实 AgentLoop 装配；null 时走 defaultLoop。 */
  public loopFactory: ((userText: string, provider: ResolvedProvider, signal: AbortSignal) => Promise<'completed' | 'error' | 'aborted'>) | null = null

  private sessionId: string | null = null
  private events: TimelineEvent[] = []
  private queue: QueuedMessage[] = []
  private title = 'Agent'
  private phase: SessionPhase = 'idle'
  private turnInFlight = false   // 同步占位：防止第一个 await 之前的并发 submit 重入
  private abort: AbortController | null = null
  private store: SessionStore
  private tracker: SnapshotTracker | null = null
  private history: HistoryMessage[] = []
  private idSeq = 0

  constructor(private readonly deps: AgentServiceDeps) {
    const ws = this.deps.api.workspaceFolders() ?? 'no-folder'
    this.store = new SessionStore(path.join(this.deps.api.globalStoragePath(), 'sessions', SessionStore.workspaceHash(ws)), this.deps.api.fs)
  }

  /** 当前会话 tracker（extension 接线 reviewProvider 读取快照原文用）。 */
  get currentTracker(): SnapshotTracker | null { return this.tracker }

  private cwd(): string { return this.deps.api.workspaceFolders() ?? process.cwd() }

  /** UiOp 三路分发：本地状态归约（内存态） + JSONL 持久化（有会话时） + webview 推送。 */
  private emit(ops: UiOp[]): void {
    for (const op of ops) {
      if (op.op === 'append') this.events.push(op.event)
      else if (op.op === 'patch') this.events = this.events.map(e => e.id === op.id ? { ...e, ...op.patch, id: e.id } as TimelineEvent : e)
      else if (op.op === 'phase') this.phase = op.phase
      else if (op.op === 'title') this.title = op.title
      else if (op.op === 'queue') this.queue = op.queue
      else if (op.op === 'clear') { this.events = []; this.queue = [] }
      // 'changes' 不在本地维护：bootSnapshot 一律从 tracker.changes() 取实时值
    }
    const sid = this.sessionId ?? 'none'
    if (this.sessionId) void this.store.append(this.sessionId, { kind: 'ops', ops }).catch(() => {})
    this.deps.bridge.sendOps(sid, ops)
  }

  async bootSnapshot(): Promise<void> {
    const { providers, keyed, active } = await this.deps.config.sanitized()
    const state: WebviewState = {
      ...initialWebviewState(this.deps.api.envLanguage()),
      phase: this.phase, title: this.title, sessionId: this.sessionId,
      events: this.events, queue: this.queue,
      changes: this.tracker ? await this.tracker.changes(this.cwd()).catch(() => [] as FileChangeSummary[]) : [],
      providers, providerKeyed: keyed, active,
      hasSessions: (await this.store.list()).length > 0,
    }
    this.deps.bridge.send({ type: 'snapshot', state })
  }

  async handleWebviewMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'submit': {
        if (this.phase === 'running' || this.turnInFlight) {
          this.queue = [...this.queue, { id: `q${Date.now().toString(36)}-${++this.idSeq}`, text: m.text }]
          this.emit([{ op: 'queue', queue: this.queue }])
          return
        }
        this.turnInFlight = true
        try { await this.runTurn(m.text) } finally { this.turnInFlight = false }
        return
      }
      case 'stop': this.abort?.abort('user stop'); return
      case 'queueEdit': this.queue = this.queue.map(q => q.id === m.id ? { ...q, text: m.text } : q); this.emit([{ op: 'queue', queue: this.queue }]); return
      case 'queueDelete': this.queue = this.queue.filter(q => q.id !== m.id); this.emit([{ op: 'queue', queue: this.queue }]); return
      case 'queueSubmitNow': {
        const item = this.queue.find(q => q.id === m.id)
        if (!item) return
        if (this.phase === 'running' || this.turnInFlight) return   // 运行中不可插队：保留在队列
        this.queue = this.queue.filter(q => q.id !== m.id)
        this.emit([{ op: 'queue', queue: this.queue }])
        this.turnInFlight = true
        try { await this.runTurn(item.text) } finally { this.turnInFlight = false }
        return
      }
      case 'selectModel': await this.deps.config.setActive(m.active); await this.bootSnapshot(); return
      case 'newSession': await this.openSession(null); return
      case 'openSession': await this.openSession(m.sessionId); return
      case 'reviewFile': await this.deps.api.openDiff(this.sessionId ?? '', m.path.replace(/\\/g, '/')); return
      case 'reviewAccept': await this.acceptReject(m.path, 'accept'); return
      case 'reviewReject': await this.acceptReject(m.path, 'reject'); return
      case 'saveProviders': await this.deps.config.saveProviders(m.providers); if (m.active) await this.deps.config.setActive(m.active); await this.bootSnapshot(); return
      case 'saveApiKey': await this.deps.config.saveApiKey(m.providerId, m.apiKey); await this.bootSnapshot(); return
      case 'deleteProvider': await this.deps.config.deleteProvider(m.providerId); await this.bootSnapshot(); return
      case 'rpc': await this.handleRpc(m.reqId, m.method, m.params); return
      case 'ready': await this.bootSnapshot(); return   // 桥内部消化 ready 并经 onReady 触发；直连调用时兜底
    }
  }

  private async acceptReject(rel: string | undefined, action: 'accept' | 'reject'): Promise<void> {
    if (!this.tracker) return
    const cwd = this.cwd()
    if (rel) { if (action === 'accept') await this.tracker.drop(rel); else await this.tracker.restore(rel, cwd) }
    else for (const c of await this.tracker.changes(cwd)) { if (action === 'accept') await this.tracker.drop(c.path); else await this.tracker.restore(c.path, cwd) }
    this.emit([{ op: 'changes', changes: await this.tracker.changes(cwd).catch(() => [] as FileChangeSummary[]) }])
  }

  /** listModels：providerId 可为空串（表单草稿），直接按 params.baseUrl 发请求，key 查不到用空串。
   *  listSessions（Task 26）：本地 JSONL 会话库直读，无需网络/密钥，params 仅作占位。 */
  private async handleRpc(reqId: number, method: 'testProvider' | 'listModels' | 'listSessions', params: { providerId: string; baseUrl?: string; protocol: Protocol }): Promise<void> {
    try {
      if (method === 'listSessions') {
        const metas = await this.store.list()
        this.deps.bridge.send({ type: 'rpcResult', reqId, ok: true, result: metas.map(m => ({ sessionId: m.sessionId, title: m.title, createdAt: m.createdAt })) })
        return
      }
      const key = (await this.deps.config.getApiKey(params.providerId)) ?? ''
      const base = (params.baseUrl ?? '').replace(/\/$/, '')
      let res: Response
      if (params.protocol === 'anthropic') {
        res = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } })
      } else if (params.protocol === 'gemini') {
        res = await fetch(`${base}/models`, { headers: { 'x-goog-api-key': key } })
      } else {
        res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } })
      }
      if (method === 'testProvider') {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        this.deps.bridge.send({ type: 'rpcResult', reqId, ok: true, result: 'ok' })
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { data?: { id: string }[]; models?: { name?: string }[] }
      const ids = (data.data ?? data.models ?? []).map(x => (x as { id?: string }).id ?? ((x as { name?: string }).name ?? '')).filter(s => s !== '').slice(0, 200)
      this.deps.bridge.send({ type: 'rpcResult', reqId, ok: true, result: ids })
    } catch (error: unknown) {
      this.deps.bridge.send({ type: 'rpcResult', reqId, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** reset:false 用于 runTurn 的隐式建会话——保留已在内存中的时间线/队列（否则首轮 await 间隙入队的消息会被清掉）。 */
  private async openSession(sessionId: string | null, opts: { reset?: boolean } = {}): Promise<void> {
    const reset = opts.reset ?? true
    this.sessionId = sessionId ?? `s${Date.now().toString(36)}${(++this.idSeq).toString(36)}`
    this.tracker = new SnapshotTracker(path.join(this.deps.api.globalStoragePath(), 'snapshots', this.sessionId), {
      readFile: p => this.deps.api.fs.readFile(p),
      writeFile: (p, s) => this.deps.api.fs.writeFile(p, s),
      mkdir: p => this.deps.api.fs.mkdir(p),
      exists: async p => { try { await this.deps.api.fs.readFile(p); return true } catch { return false } },
    })
    if (sessionId) {
      // 打开旧会话：回放 JSONL 恢复内存态；不得向旧会话文件追加 clear（会破坏其回放终态）
      const records = await this.store.load(sessionId)
      const replayed = this.store.replayToState(records, this.deps.api.envLanguage())
      this.events = replayed.state.events; this.queue = replayed.state.queue
      this.title = replayed.state.title
      // 中断会话的终态可能是 running/submitting——重放后轮次必然已结束，归一为 completed，否则 submit 永远入队
      this.phase = replayed.state.phase === 'running' || replayed.state.phase === 'submitting' ? 'completed' : replayed.state.phase
      this.history = replayed.history
    } else {
      this.history = []
      if (reset) {
        this.events = []; this.queue = []; this.title = 'Agent'; this.phase = 'idle'
        this.emit([{ op: 'clear' }])   // 新会话（用户显式新建）：本地清空 + 持久化 clear 标记 + 通知 webview
      }
    }
    await this.bootSnapshot()
  }

  private async runTurn(userText: string): Promise<void> {
    const active = await this.deps.config.getActive()
    if (!active) {
      this.emit([
        { op: 'append', event: { id: `cfg${++this.idSeq}`, ts: Date.now(), type: 'error', message: 'No provider/model selected' } },
        { op: 'phase', phase: 'idle' },
      ])
      return
    }
    if (!this.sessionId) await this.openSession(null, { reset: false })
    const providerInfo = (await this.deps.config.getProviders()).find(p => p.id === active.providerId)
    if (!providerInfo) return
    const apiKey = (await this.deps.config.getApiKey(active.providerId)) ?? ''
    const provider: ResolvedProvider = { info: providerInfo, apiKey, modelId: active.modelId, quality: active.quality,
      thinkingMode: await this.deps.config.getThinkingMode(active.providerId, active.modelId) }
    const title = this.title === 'Agent' ? SessionStore.titleOf(userText) : this.title
    const meta = { sessionId: this.sessionId!, title, createdAt: Date.now(), providerId: active.providerId, modelId: active.modelId }
    await this.store.append(this.sessionId!, { kind: 'meta', meta })
    this.emit([{ op: 'title', title }])
    this.abort = new AbortController()
    const run = this.loopFactory
      ? this.loopFactory(userText, provider, this.abort.signal)
      : this.defaultLoop(userText, provider, ADAPTERS[providerInfo.protocol])
    const outcome = await run
    this.abort = null
    if (outcome !== 'aborted') {
      const next = this.queue.shift()
      if (next) { this.emit([{ op: 'queue', queue: this.queue }]); await this.runTurn(next.text) }
    }
  }

  /** 真实 AgentLoop 装配：CodeRuntime + 6 工具 + 快照 tracker + 会话历史。 */
  private async defaultLoop(userText: string, provider: ResolvedProvider, adapter: ProtocolAdapter): Promise<'completed' | 'error' | 'aborted'> {
    const runtime = new CodeRuntime(this.deps.workerPath)
    const tracker = this.tracker
    const loop = new AgentLoop({
      adapter, provider, runtime, tools: createTools(), cwd: this.cwd(), platform: process.platform,
      emit: ops => this.emit(ops),
      onHistory: msg => {
        this.history.push(msg)
        if (this.sessionId) void this.store.append(this.sessionId, { kind: 'history', message: msg }).catch(() => {})
      },
      getHistory: () => [...this.history],
      onProviderThinkingMode: mode => { void this.deps.config.setThinkingMode(provider.info.id, provider.modelId, mode) },
      snapshotTracker: tracker ? {
        beforeEdit: (p, cwd) => tracker.beforeEdit(p, cwd),
        changes: async () => tracker.changes(this.cwd()).catch(() => [] as FileChangeSummary[]),
      } : undefined,
      newEventId: () => `e${++this.idSeq}`,
    })
    try { return await loop.run(userText, this.abort!.signal) }
    finally { await runtime.dispose() }
  }
}
