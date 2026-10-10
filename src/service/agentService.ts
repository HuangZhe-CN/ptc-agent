import * as path from 'node:path'
import type { Protocol, WebviewMessage, UiOp, TimelineEvent, QueuedMessage, FileChangeSummary, SessionPhase, WebviewState, ChatImage } from '../shared/protocol'
import { initialWebviewState, PROTOCOL_BANNED_MIME } from '../shared/protocol'
import { t } from '../i18n'
import { ConfigStore } from './configStore'
import { WebviewBridge } from './webviewBridge'
import { SessionStore, SESSION_ID_RE, type SessionStoreDeps, type SessionRecord } from '../session/store'
import { SnapshotTracker } from './snapshot'
import { AgentLoop } from '../agent/loop'
import { openaiAdapter } from '../protocol/openai'
import { anthropicAdapter } from '../protocol/anthropic'
import { geminiAdapter } from '../protocol/gemini'
import type { ProtocolAdapter, ResolvedProvider, HistoryMessage } from '../protocol/types'
import { CodeRuntime } from '../runtime/codeRuntime'
import { createTools } from '../tools/registry'

const ADAPTERS: Record<Protocol, ProtocolAdapter> = { openai: openaiAdapter, anthropic: anthropicAdapter, gemini: geminiAdapter }

/** /compact 的 system 指令：产出将整体替换会话历史的自足摘要。 */
const COMPACT_SYSTEM_PROMPT = [
  'You are a conversation compactor for a coding agent.',
  'You receive the transcript of an ongoing session and produce the summary that will REPLACE the entire conversation history as the only context for all future turns.',
  'Preserve in dense markdown bullets:',
  "- the user's goals, constraints and explicit preferences;",
  '- key decisions made and why;',
  '- every file created or edited (with paths) and notable commands run;',
  '- the current state of the work and what remains unfinished;',
  '- exact next steps.',
  'Output ONLY the summary. Do not add any commentary before or after it.',
].join('\n')

/** 压缩后新历史首条 user 消息的前缀：向模型声明该摘要即此前全部上下文。 */
const COMPACT_PREAMBLE = '[Conversation compacted] The summary below is the context for everything that happened earlier in this session. Continue assisting the user based on it.'

// PROTOCOL_BANNED_MIME（host 起轮兜底过滤用）来自 shared/protocol 单一事实来源——
// 排队消息 drain/立即发送时协议可能已切换，仅靠 webview 提交瞬间的过滤会漏（如切到 Gemini 后 GIF 致整轮 400）

/** VscodeApi.fs：SessionStore 依赖面 + SnapshotTracker 的 writeFile/deleteFile。 */
export interface VscodeFsApi extends SessionStoreDeps {
  writeFile(p: string, s: string): Promise<void>
  /** I1：新文件 Reject 时删除工作区文件；宿主必须提供（测试可省略，tracker 降级写空串） */
  deleteFile?(p: string): Promise<void>
  /** 快照 diff 缓存的 mtime/size 探针；未提供时 changes() 每轮全量重算 */
  stat?(p: string): Promise<{ mtimeMs: number; size: number } | null>
}

/** vscode 依赖注入面（extension.ts 提供真实现；测试提供假实现）。 */
export interface VscodeApi {
  workspaceFolders(): string | undefined
  globalStoragePath(): string
  fs: VscodeFsApi
  openDiff(sessionId: string, relPath: string, title: string): Promise<void>
  /** 执行 VS Code 命令：仅由 service 以硬编码字面量调用，严禁透传 webview 输入的命令名 */
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>
  /** 弹输入框；返回 undefined = 用户取消 */
  showInputBox(opts: { prompt: string; value?: string }): Promise<string | undefined>
  /** 本地信息提示（workbenchAction 失败兜底） */
  showInfoMessage(msg: string): Promise<void>
  /** 用内置 Simple Browser 打开网址（Uri 构造与 scheme 归一封在宿主实现） */
  openSimpleBrowser(url: string): Promise<void>
}

/** workbenchAction 的动作名单（protocol.ts 联合里该分支的 action 字段）。 */
type WorkbenchAction = Extract<WebviewMessage, { type: 'workbenchAction' }>['action']

export interface AgentServiceDeps { config: ConfigStore; api: VscodeApi; bridge: WebviewBridge; workerPath: string }

export class AgentService {
  /** 测试钩子（公开属性）：覆盖真实 AgentLoop 装配；null 时走 defaultLoop。 */
  public loopFactory: ((userText: string, provider: ResolvedProvider, signal: AbortSignal, images?: ChatImage[]) => Promise<'completed' | 'error' | 'aborted'>) | null = null

  /** 测试钩子（公开属性）：覆盖 /compact 的真实 LLM 摘要请求；null 时走 defaultCompact。 */
  public compactFactory: ((history: HistoryMessage[], provider: ResolvedProvider, signal: AbortSignal) => Promise<string>) | null = null

  private sessionId: string | null = null
  private events: TimelineEvent[] = []
  private queue: QueuedMessage[] = []
  private title = 'Agent'
  private phase: SessionPhase = 'idle'
  private turnInFlight = false   // 同步占位：防止第一个 await 之前的并发 submit 重入
  private turnPromise: Promise<void> | null = null   // 在飞活动（轮次含 drain 链，或 /compact 压缩）的 promise：queueSubmitNow 等收尾用
  private compacting = false   // /compact 压缩在飞：queueSubmitNow 不得 abort 压缩（只中止轮次）
  private currentLocale: 'en' | 'zh' = 'en'   // UI 语言：配置优先（setLocale 即时更新），bootSnapshot/openSession 起点刷新
  private abort: AbortController | null = null
  private store: SessionStore
  /** JSONL 追加串行化链：emit/onHistory 的 fire-and-forget append 同 tick 背靠背在飞时 fs 层无完成顺序保证，
   *  行序必须等于调用序（否则重放时 patch 行先于 append 落盘会丢事件文本、时间线错乱）。 */
  private appendChain: Promise<unknown> = Promise.resolve()
  private tracker: SnapshotTracker | null = null
  private history: HistoryMessage[] = []
  private idSeq = 0
  private lastSnapshotState: WebviewState | null = null

  constructor(private readonly deps: AgentServiceDeps) {
    const ws = this.deps.api.workspaceFolders() ?? 'no-folder'
    this.store = new SessionStore(path.join(this.deps.api.globalStoragePath(), 'sessions', SessionStore.workspaceHash(ws)), this.deps.api.fs)
  }

  /** 当前会话 tracker（extension 接线 reviewProvider 读取快照原文用）。 */
  get currentTracker(): SnapshotTracker | null { return this.tracker }

  /** 中止进行中的回合（extension 在 webview dispose/重开时调用；无进行中回合则无操作）。
   *  loop 感知 abort 后自行收尾（时间线标注 + runtime dispose 在 defaultLoop 的 finally）。 */
  stop(reason: string): void { this.abort?.abort(reason) }

  /** 只读测试钩子（Task 27 冒烟）：最近一次 bootSnapshot 构建的完整状态；null = 尚未 ready。 */
  getLastSnapshotForTest(): WebviewState | null { return this.lastSnapshotState }

  /** 只读测试钩子：当前 LLM 上下文历史（/compact 替换与重放还原的单测断言面）。 */
  getHistoryForTest(): HistoryMessage[] { return [...this.history] }

  private cwd(): string { return this.deps.api.workspaceFolders() ?? process.cwd() }

  /** I3：一轮提交进行中（loop 运行或提交占位）——会话切换类操作在此期间拒绝。 */
  private isTurnActive(): boolean { return this.phase === 'running' || this.phase === 'submitting' || this.turnInFlight }

  /** UiOp 三路分发：本地状态归约（内存态） + JSONL 持久化（有会话时） + webview 推送。 */
  private emit(ops: UiOp[]): void {
    for (const op of ops) {
      if (op.op === 'append') this.events.push(op.event)
      else if (op.op === 'patch') this.events = this.events.map(e => e.id === op.id ? { ...e, ...op.patch, id: e.id } as TimelineEvent : e)
      else if (op.op === 'remove') this.events = this.events.filter(e => e.id !== op.id)
      else if (op.op === 'phase') this.phase = op.phase
      else if (op.op === 'title') this.title = op.title
      else if (op.op === 'queue') this.queue = op.queue
      else if (op.op === 'replaceEvents') this.events = op.events
      else if (op.op === 'clear') { this.events = []; this.queue = [] }
      // 'changes' 不在本地维护：bootSnapshot 一律从 tracker.changes() 取实时值
    }
    const sid = this.sessionId ?? 'none'
    if (this.sessionId) void this.persist(this.sessionId, { kind: 'ops', ops }).catch(() => {})
    this.deps.bridge.sendOps(sid, ops)
  }

  /** JSONL 追加统一入口：promise 链排队保证行序 = 调用序（sessionId 调用时同步快照，防链执行时已切会话）；
   *  前序失败吞掉不断链，本次失败原样传给调用方（现有 .catch / await-catch 语义不变）。 */
  private persist(sessionId: string, record: SessionRecord): Promise<void> {
    const run = this.appendChain.then(() => this.store.append(sessionId, record))
    this.appendChain = run.then(() => undefined, () => undefined)
    return run
  }

  async bootSnapshot(): Promise<void> {
    this.currentLocale = (await this.deps.config.getLocale()) ?? 'en'
    const { providers, keyed, active } = await this.deps.config.sanitized()
    const state: WebviewState = {
      ...initialWebviewState(this.currentLocale),
      phase: this.phase, title: this.title, sessionId: this.sessionId,
      events: this.events, queue: this.queue,
      changes: this.tracker ? await this.tracker.changes(this.cwd()).catch(() => [] as FileChangeSummary[]) : [],
      providers, providerKeyed: keyed, active,
      // I4：会话库读取失败降级 hasSessions:false（单文件坏行由 store 层隔离，不阻塞快照下发）
      hasSessions: await this.store.list().then(metas => metas.length > 0).catch(() => false),
    }
    this.lastSnapshotState = state
    this.deps.bridge.send({ type: 'snapshot', state })
  }

  async handleWebviewMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'submit': {
        if (this.phase === 'running' || this.turnInFlight) {
          this.queue = [...this.queue, { id: `q${Date.now().toString(36)}-${++this.idSeq}`, text: m.text, ...(m.images?.length ? { images: m.images } : {}) }]
          this.emit([{ op: 'queue', queue: this.queue }])
          return
        }
        this.turnPromise = this.runGuarded(m.text, m.images)
        await this.turnPromise
        return
      }
      case 'stop': this.abort?.abort('user stop'); return
      case 'queueEdit': this.queue = this.queue.map(q => q.id === m.id ? { ...q, text: m.text } : q); this.emit([{ op: 'queue', queue: this.queue }]); return
      case 'queueDelete': this.queue = this.queue.filter(q => q.id !== m.id); this.emit([{ op: 'queue', queue: this.queue }]); return
      case 'queueSubmitNow': {
        const item = this.queue.find(q => q.id === m.id)
        if (!item) return
        if (this.phase === 'running' || this.turnInFlight) {
          // 用户拍板：运行中立即发送 = 中止当前轮，等它收尾后立刻把该条作为新轮发出。
          // abort 后 loop 自行收尾（时间线标注 Stopped），outcome=aborted 不 drain——队列其余项原样保留。
          // 压缩在飞时不得 abort（F1：压缩不是轮次，只等它落地再起轮）。
          if (!this.compacting) this.abort?.abort('queue submit now')
          const inflight = this.turnPromise
          if (inflight) await inflight   // 严禁并发：先等在飞活动（轮次含 drain 链，或压缩）彻底落地
        }
        // F3：await 期间条目可能被 queueEdit/queueDelete 改动——按 id 重取 fresh 再出队起轮
        const fresh = this.queue.find(q => q.id === m.id)
        if (!fresh) return   // 竞态兜底：await 期间该条已被出队发送或删除——不得重复起轮
        // F5：等同一个在飞收尾的 continuation 可能有多个（连点两条立即发送）——首个恢复起轮后，
        // 后续到达此处时新轮已在飞，直接返回让条目留在队列（轮次完成后按序 drain 或用户再点）
        if (this.turnInFlight || this.phase === 'running' || this.compacting) return
        this.queue = this.queue.filter(q => q.id !== fresh.id)
        this.emit([{ op: 'queue', queue: this.queue }])
        this.turnPromise = this.runGuarded(fresh.text, fresh.images)
        await this.turnPromise
        return
      }
      case 'selectModel': await this.deps.config.setActive(m.active); await this.bootSnapshot(); return
      case 'newSession':
        if (this.isTurnActive()) return   // I3：运行中拒绝切换——避免 loop/JSONL 继续写向旧会话（串写）
        await this.openSession(null); return
      case 'openSession':
        if (this.isTurnActive()) return   // I3：同上；UI 侧运行中禁用入口，此处兜底竞态
        if (!SESSION_ID_RE.test(m.sessionId)) return   // 非法会话 id（穿越/注入形状）：静默忽略
        await this.openSession(m.sessionId); return
      case 'reviewFile': {
        const rel = m.path.replace(/\\/g, '/')
        await this.deps.api.openDiff(this.sessionId ?? '', rel, t(this.currentLocale, 'review.diffTitle', { path: rel }))
        return
      }
      case 'reviewAccept': await this.acceptReject(m.path, 'accept'); return
      case 'reviewReject': await this.acceptReject(m.path, 'reject'); return
      case 'saveProviders': await this.deps.config.saveProviders(m.providers); if (m.active) await this.deps.config.setActive(m.active); await this.bootSnapshot(); return
      case 'saveApiKey': await this.deps.config.saveApiKey(m.providerId, m.apiKey); await this.bootSnapshot(); return
      case 'deleteProvider': await this.deps.config.deleteProvider(m.providerId); await this.bootSnapshot(); return
      case 'setLocale': this.currentLocale = m.locale; await this.deps.config.setLocale(m.locale); await this.bootSnapshot(); return
      case 'workbenchAction': await this.handleWorkbenchAction(m.action); return
      case 'slashCommand': if (m.command === 'compact') await this.compactHistory(); return
      case 'rpc': await this.handleRpc(m.reqId, m.method, m.params); return
      case 'ready': await this.bootSnapshot(); return   // 桥内部消化 ready 并经 onReady 触发；直连调用时兜底
    }
  }

  private async acceptReject(rel: string | undefined, action: 'accept' | 'reject'): Promise<void> {
    if (!this.tracker) return
    const cwd = this.cwd()
    try {
      // 批量目标 = 全量 changes（单文件即 [rel]）；changes() 自身失败（manifest/快照损坏）也要上屏可见，不得静默吞掉
      let targets: string[]
      try { targets = rel ? [rel] : (await this.tracker.changes(cwd)).map(c => c.path) }
      catch (error: unknown) {
        this.emit([{ op: 'append', event: { id: `err${++this.idSeq}`, ts: Date.now(), type: 'error', message: t(this.currentLocale, 'service.review.listFailed', { action, error: error instanceof Error ? error.message : String(error) }) } }])
        return   // 仍走 finally 刷新面板
      }
      for (const p of targets) {
        try { if (action === 'accept') await this.tracker.drop(p); else await this.tracker.restore(p, cwd) }
        catch (error: unknown) {
          // 单文件失败（快照损坏/globalStorage 写入故障等）：上屏可见 error 后继续处理其余文件——
          // bridge.onMessage 是 void 调用，异常上抛只会中断整批并漏发 changes 刷新，面板停留在过期列表
          this.emit([{ op: 'append', event: { id: `err${++this.idSeq}`, ts: Date.now(), type: 'error', message: t(this.currentLocale, 'service.review.fileFailed', { action, path: p, error: error instanceof Error ? error.message : String(error) }) } }])
        }
      }
    } finally {
      // 无条件刷新（含部分失败）：面板必须回到真实 changes 状态，用户重复点 Reject all 不会对已还原文件再走一遍
      this.emit([{ op: 'changes', changes: await this.tracker.changes(cwd).catch(() => [] as FileChangeSummary[]) }])
    }
  }

  /** submit/queueSubmitNow 起轮统一入口：turnInFlight 占位覆盖第一个 await 前的并发窗口，并把在飞 promise 交给 this.turnPromise。 */
  private async runGuarded(text: string, images?: ChatImage[]): Promise<void> {
    this.turnInFlight = true
    try { await this.runTurn(text, images) } finally { this.turnInFlight = false }
  }

  /** /compact：用当前激活 provider 发一次无工具 LLM 请求把会话历史压成摘要，整体替换 this.history 与时间线。
   *  运行中拒绝（严禁与在飞轮并发改写 getHistory）；无会话/空历史/失败只上屏反馈，原历史不动；队列不受影响。 */
  private async compactHistory(): Promise<void> {
    if (this.isTurnActive()) {
      this.emit([{ op: 'append', event: { id: `err${++this.idSeq}`, ts: Date.now(), type: 'error', message: t(this.currentLocale, 'service.compact.busy') } }])
      return
    }
    if (!this.sessionId || this.history.length === 0) {
      this.emit([{ op: 'append', event: { id: `err${++this.idSeq}`, ts: Date.now(), type: 'error', message: t(this.currentLocale, 'service.compact.empty') } }])
      return
    }
    this.turnPromise = this.compactGuarded()   // F1：压缩 promise 挂入在飞占位——queueSubmitNow 等它落地而非误中止
    await this.turnPromise
  }

  /** 压缩主体（turnInFlight/compacting 占位 + abort 归属）：占位期间 submit 入队、会话切换被 I3 守卫、queueSubmitNow 等待。 */
  private async compactGuarded(): Promise<void> {
    this.compacting = true
    this.turnInFlight = true
    // 压缩起点的队列快照（首个 await 前同步取）：落地后只 drain 压缩期间新入队的条目——
    // 压缩前已在队列的（如 aborted 轮保留的）维持「中止不 drain」语义，不被压缩顺带发出
    const preCompactQueueIds = new Set(this.queue.map(q => q.id))
    const prevPhase = this.phase
    try {
      const active = await this.deps.config.getActive()
      const providerInfo = active ? (await this.deps.config.getProviders()).find(p => p.id === active.providerId) : undefined
      if (!active || !providerInfo) {
        this.emit([{ op: 'append', event: { id: `err${++this.idSeq}`, ts: Date.now(), type: 'error', message: t(this.currentLocale, 'service.noProvider') } }])
        return
      }
      const provider: ResolvedProvider = { info: providerInfo, apiKey: (await this.deps.config.getApiKey(active.providerId)) ?? '', modelId: active.modelId, quality: active.quality,
        thinkingMode: await this.deps.config.getThinkingMode(active.providerId, active.modelId) }
      const beforeChars = JSON.stringify(this.history).length
      this.abort = new AbortController()
      this.emit([{ op: 'phase', phase: 'submitting' }])
      try {
        const summary = (this.compactFactory
          ? await this.compactFactory(this.history, provider, this.abort.signal)
          : await this.defaultCompact(this.history, provider, this.abort.signal)).trim()
        if (!summary) throw new Error('model returned an empty summary')
        this.history = [{ role: 'user', text: `${COMPACT_PREAMBLE}\n\n${summary}` }]
        // F4：先 await 持久化 historyReplace，再 emit（emit 内 ops 为 fire-and-forget append）——
        // 保证 JSONL 中 historyReplace 行先于 replaceEvents ops 行，重放行序确定
        let persistError: string | null = null
        if (this.sessionId) {
          try { await this.persist(this.sessionId, { kind: 'historyReplace', messages: this.history }) }
          catch (error: unknown) { persistError = error instanceof Error ? error.message : String(error) }
        }
        const compactEvent: TimelineEvent = { id: `c${++this.idSeq}`, ts: Date.now(), type: 'compact', markdown: summary, before: beforeChars, after: JSON.stringify(this.history).length }
        this.emit([
          { op: 'replaceEvents', events: [compactEvent] },   // 时间线整体替换为压缩事件；queue/changes 不在替换范围
          { op: 'phase', phase: prevPhase },
        ])
        // F7：落盘失败降级可见——内存/时间线行为不变（history 已替换、压缩事件已上屏），
        // 但必须在 replaceEvents 之后上屏（否则会被整体替换冲掉），提示重放将不含本次压缩
        if (persistError) {
          this.emit([{ op: 'append', event: { id: `err${++this.idSeq}`, ts: Date.now(), type: 'error', message: t(this.currentLocale, 'service.compact.persistFailed', { error: persistError }) } }])
        }
      } catch (error: unknown) {
        // 失败：原 history 原样保留（此分支不触碰 this.history），只上屏 error 并恢复 phase；不 drain
        const message = error instanceof Error ? error.message : String(error)
        this.emit([
          { op: 'append', event: { id: `err${++this.idSeq}`, ts: Date.now(), type: 'error', message: t(this.currentLocale, 'service.compact.failed', { error: message }) } },
          { op: 'phase', phase: prevPhase },
        ])
        return
      } finally { this.abort = null }
      // 压缩落地成功：压缩期间新入队的消息自动续发（对齐 submit-during-turn 的自动出队契约——
      // 此前它们会滞留队列直到手动「立即发送」）。turnInFlight 仍为 true 天然防并发起轮；
      // 只取快照外（压缩开始后入队）的条目，该轮完成后的常规 drain 会接续处理队列剩余项。
      const next = this.queue.find(q => !preCompactQueueIds.has(q.id))
      if (next) {
        this.queue = this.queue.filter(q => q.id !== next.id)
        this.emit([{ op: 'queue', queue: this.queue }])
        await this.runTurn(next.text, next.images)
      }
    } finally {
      this.compacting = false
      this.turnInFlight = false
    }
  }

  /** 真实 /compact 请求：历史序列化为单条 user 转录（任意协议结尾形状都合法），system 携压缩指令，无工具。 */
  private async defaultCompact(history: HistoryMessage[], provider: ResolvedProvider, signal: AbortSignal): Promise<string> {
    const transcript = history.map(m => {
      if (m.role === 'user') return `[user] ${m.text}`
      if (m.role === 'assistant') return `[assistant] ${m.turn.text}`
      return `[tool result for ${m.callId}${m.isError ? ' (error)' : ''}]\n${m.content}`
    }).join('\n\n')
    let text = ''
    let err: string | null = null
    for await (const ev of ADAPTERS[provider.info.protocol].stream({
      system: COMPACT_SYSTEM_PROMPT,
      history: [{ role: 'user', text: `Transcript of the conversation to compact:\n\n${transcript}` }],
      provider, signal, noTools: true,   // F2：压缩请求真正无工具（三适配器省略 tools/tool_choice/toolConfig）
    })) {
      if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'stream_error') err = `${ev.kind}: ${this.redactKey(provider, ev.message)}`
    }
    if (err) throw new Error(err)
    return text
  }

  /** 错误文本脱敏（对齐 AgentLoop.redact）：apiKey 不进时间线与 JSONL。 */
  private redactKey(provider: ResolvedProvider, text: string): string {
    const key = provider.apiKey
    return key ? text.split(key).join('[REDACTED]') : text
  }

  /** workbenchAction：action→命令白名单硬编码映射（webview 只传动作名，不可传命令串）；
   *  openBrowser 先弹输入框（取消/空输入静默返回），再交宿主 Simple Browser 打开。
   *  任何失败（命令不存在、Uri 解析等）统一降级为本地提示——bridge.onMessage 是 void 调用，上抛只会变成 unhandled rejection。 */
  private async handleWorkbenchAction(action: WorkbenchAction): Promise<void> {
    try {
      switch (action) {
        case 'focusExplorer': await this.deps.api.executeCommand('workbench.view.explorer'); return
        case 'focusTerminal': await this.deps.api.executeCommand('workbench.action.terminal.focus'); return
        case 'openFolder': await this.deps.api.executeCommand('workbench.action.files.openFolder'); return
        case 'toggleSidebar': await this.deps.api.executeCommand('workbench.action.toggleSidebarVisibility'); return
        case 'openBrowser': {
          const url = (await this.deps.api.showInputBox({ prompt: t(this.currentLocale, 'service.urlPrompt') }))?.trim()
          if (!url) return   // 用户取消或空输入：静默返回
          await this.deps.api.openSimpleBrowser(url)
          return
        }
      }
    } catch {
      await this.deps.api.showInfoMessage(action === 'openBrowser' ? t(this.currentLocale, 'service.browserFailed') : t(this.currentLocale, 'service.actionFailed', { action }))
    }
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
    this.currentLocale = (await this.deps.config.getLocale()) ?? 'en'
    const reset = opts.reset ?? true
    this.sessionId = sessionId ?? `s${Date.now().toString(36)}${(++this.idSeq).toString(36)}`
    this.tracker = new SnapshotTracker(path.join(this.deps.api.globalStoragePath(), 'snapshots', this.sessionId), {
      readFile: p => this.deps.api.fs.readFile(p),
      writeFile: (p, s) => this.deps.api.fs.writeFile(p, s),
      mkdir: p => this.deps.api.fs.mkdir(p),
      exists: async p => { try { await this.deps.api.fs.readFile(p); return true } catch { return false } },
      deleteFile: p => this.deps.api.fs.deleteFile ? this.deps.api.fs.deleteFile(p) : Promise.resolve(),
      ...(this.deps.api.fs.stat ? { stat: (p: string) => this.deps.api.fs.stat!(p) } : {}),
    })
    if (sessionId) {
      // 打开旧会话：回放 JSONL 恢复内存态；不得向旧会话文件追加 clear（会破坏其回放终态）
      const records = await this.store.load(sessionId)
      const replayed = this.store.replayToState(records, this.currentLocale)
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

  /** 起轮前按当前协议过滤附件（host 兜底，对齐 webview Composer 的 L2 过滤）：返回保留的图（可能为空数组）。 */
  private filterImagesForProtocol(images: ChatImage[], protocol: Protocol): ChatImage[] {
    const banned = PROTOCOL_BANNED_MIME[protocol]
    if (!banned || images.length === 0) return images
    return images.filter(i => !banned.includes(i.mime))
  }

  private async runTurn(userText: string, images?: ChatImage[]): Promise<void> {
    // 回合起点上屏用户消息：先建会话再 emit——无 provider/配置异常时气泡与错误同样可见，且 JSONL 重放还原。
    // 直发/queueSubmitNow/队列出队三条路径都经 runTurn 此处汇合。provider 解析先于 user 事件：
    // 附件须按「当前」协议过滤后再上屏（时间线与实际请求一致——排队消息 drain 时协议可能已切换）。
    if (!this.sessionId) await this.openSession(null, { reset: false })
    const active = await this.deps.config.getActive()
    const providerInfo = active ? (await this.deps.config.getProviders()).find(p => p.id === active.providerId) : undefined
    // host 侧协议过滤兜底：webview 只在提交瞬间过滤一次，切到 Gemini 后 GIF 会让整轮 400 且消息已被消费出队
    const keepImages = images && providerInfo ? this.filterImagesForProtocol(images, providerInfo.protocol) : images
    if (!userText && (images?.length ?? 0) > 0 && !(keepImages?.length ?? 0)) {
      // 纯图消息的附件全被当前协议滤掉：镜像 webview doSubmit 的拒绝——不起空轮，上屏可见错误
      this.emit([
        { op: 'append', event: { id: `cfg${++this.idSeq}`, ts: Date.now(), type: 'error', message: t(this.currentLocale, 'service.images.dropped') } },
        { op: 'phase', phase: 'idle' },
      ])
      return
    }
    this.emit([{ op: 'append', event: { id: `u${++this.idSeq}`, ts: Date.now(), type: 'user', text: userText, ...(keepImages?.length ? { images: keepImages } : {}) } }])
    if (!active) {
      this.emit([
        { op: 'append', event: { id: `cfg${++this.idSeq}`, ts: Date.now(), type: 'error', message: t(this.currentLocale, 'service.noProvider') } },
        { op: 'phase', phase: 'idle' },
      ])
      return
    }
    if (!providerInfo) {
      // active 指向已删除的 provider：原先静默返回会让已上屏的用户消息无任何下文——补错误反馈
      this.emit([
        { op: 'append', event: { id: `cfg${++this.idSeq}`, ts: Date.now(), type: 'error', message: t(this.currentLocale, 'service.provider.gone') } },
        { op: 'phase', phase: 'idle' },
      ])
      return
    }
    const apiKey = (await this.deps.config.getApiKey(active.providerId)) ?? ''
    const provider: ResolvedProvider = { info: providerInfo, apiKey, modelId: active.modelId, quality: active.quality,
      thinkingMode: await this.deps.config.getThinkingMode(active.providerId, active.modelId) }
    const title = this.title === 'Agent' ? SessionStore.titleOf(userText) : this.title
    const meta = { sessionId: this.sessionId!, title, createdAt: Date.now(), providerId: active.providerId, modelId: active.modelId }
    try {
      await this.persist(this.sessionId!, { kind: 'meta', meta })
    } catch (error: unknown) {
      // globalStorage 持久化故障：降级为可见 error 提示后继续回合（内存时间线/历史仍完整，bridge void 调用不再逃逸成 unhandledRejection）
      this.emit([{ op: 'append', event: { id: `cfg${++this.idSeq}`, ts: Date.now(), type: 'error', message: t(this.currentLocale, 'service.persist.failed', { error: error instanceof Error ? error.message : String(error) }) } }])
    }
    this.emit([{ op: 'title', title }])
    this.abort = new AbortController()
    const run = this.loopFactory
      ? this.loopFactory(userText, provider, this.abort.signal, keepImages)
      : this.defaultLoop(userText, provider, ADAPTERS[providerInfo.protocol], keepImages)
    const outcome = await run
    this.abort = null
    if (outcome !== 'aborted') {
      const next = this.queue.shift()
      if (next) { this.emit([{ op: 'queue', queue: this.queue }]); await this.runTurn(next.text, next.images) }
    }
  }

  /** 真实 AgentLoop 装配：CodeRuntime + 6 工具 + 快照 tracker + 会话历史。 */
  private async defaultLoop(userText: string, provider: ResolvedProvider, adapter: ProtocolAdapter, images?: ChatImage[]): Promise<'completed' | 'error' | 'aborted'> {
    const runtime = new CodeRuntime(this.deps.workerPath)
    const tracker = this.tracker
    const loop = new AgentLoop({
      adapter, provider, runtime, tools: createTools(), cwd: this.cwd(), platform: process.platform,
      emit: ops => this.emit(ops),
      onHistory: msg => {
        this.history.push(msg)
        if (this.sessionId) void this.persist(this.sessionId, { kind: 'history', message: msg }).catch(() => {})
      },
      getHistory: () => [...this.history],
      onProviderThinkingMode: mode => { void this.deps.config.setThinkingMode(provider.info.id, provider.modelId, mode) },
      snapshotTracker: tracker ? {
        beforeEdit: (p, cwd) => tracker.beforeEdit(p, cwd),
        changes: async () => tracker.changes(this.cwd()).catch(() => [] as FileChangeSummary[]),
      } : undefined,
      newEventId: () => `e${++this.idSeq}`,
      locale: this.currentLocale,
    })
    try { return await loop.run(userText, this.abort!.signal, images) }
    finally { await runtime.dispose() }
  }
}
