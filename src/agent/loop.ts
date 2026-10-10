import type { StreamEvent, FileChangeSummary, ChatImage } from '../shared/protocol'
import type { ProtocolAdapter, ResolvedProvider, HistoryMessage, AssistantTurn } from '../protocol/types'
import type { CodeRuntime } from '../runtime/codeRuntime'
import { DispatchPool, type DispatchEvent } from '../runtime/dispatchPool'
import type { ToolDef, ToolContext } from '../tools/registry'
import { t } from '../i18n'
import { buildSystemPrompt } from './prompt'
import { mapDispatchEvent, type Emit } from './events'

export interface LoopDeps {
  adapter: ProtocolAdapter
  provider: ResolvedProvider
  runtime: Pick<CodeRuntime, 'run'>
  tools: Map<string, ToolDef>
  cwd: string
  platform: NodeJS.Platform
  /** UI 语言（影响面向用户的错误文案），缺省 'en'（测试装配零改动） */
  locale?: 'en' | 'zh'
  /** 单用户消息护栏，默认 40 */
  maxToolRounds?: number
  emit: Emit   // 推 UiOp（含 thought/edit/explore/run/phase/changes）
  onHistory: (m: HistoryMessage) => void
  getHistory: () => HistoryMessage[]
  onProviderThinkingMode?: (mode: 'adaptive' | 'manual' | 'none') => void
  snapshotTracker?: { beforeEdit(path: string, cwd: string): Promise<void>; changes(): Promise<FileChangeSummary[]> }
  newEventId: () => string
  /** 退避等待注入点（测试可注入即时 resolve） */
  delayMs?: (ms: number) => Promise<void>
}

const defaultDelay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * run 事件错误行组装（V1）：worker 对 exception 上报完整 error.stack（截 4096），原因首行在栈头。
 * 若把整段 message 原样拼进窗口再整体尾截 500，首行会被 Module._compile 之类 node 内部帧挤出。
 * 故「kind: 原因首行」强制打头，仅跟栈顶前 5 帧（紧邻 throw 的帧最有价值），整体维持 500 字符有界。
 */
const formatRunErrorLine = (error: { kind: string; message: string }): string => {
  const [first = '', ...frames] = error.message.split('\n')
  const head = `${error.kind}: ${first}`.slice(0, 500)
  if (!frames.length || head.length >= 500) return head
  return `${head}\n${frames.slice(0, 5).join('\n')}`.slice(0, 500)
}

export class AgentLoop {
  private round = 0
  private retries = 0
  private pendingTurn: AssistantTurn | undefined
  private turnThinking: string | undefined
  private thoughtId: string | undefined
  private thoughtStartedAt: number | undefined
  private workingText = ''
  private completionId: string | undefined
  private completionText = ''
  private finalText = ''
  private toolArgs = ''
  private toolCallId = ''
  /** C1/C2：适配器经 replay_envelope 事件上报的协议原生回放信封（无信封时回退 providerReplay 伪造） */
  private replayEnvelope: unknown

  /** 流式 markdown patch 合并节流：每个事件 id 独立缓冲，距上次 flush ≥PATCH_MIN_INTERVAL_MS
   *  或事件边界（message_done / 流结束 / error / run 返回）才 emit 一次。flush 的 patch 携带
   *  最新全量文本——JSONL 重放的终态与逐 delta 逐次 emit 等价，写放大从 O(delta 数) 降为 O(时间片)。 */
  private static readonly PATCH_MIN_INTERVAL_MS = 50
  private pendingPatches: Map<string, { markdown: string }> = new Map()
  private lastPatchFlushAt: Map<string, number> = new Map()
  private patchTimer: NodeJS.Timeout | null = null

  constructor(private readonly d: LoopDeps) {}

  async run(userText: string, signal: AbortSignal, images?: ChatImage[]): Promise<'completed' | 'error' | 'aborted'> {
    try {
      return await this.doRun(userText, signal, images)
    } finally {
      this.flushStreamPatches()   // 任意返回路径（completed/error/aborted）不留未落盘的终态 patch
    }
  }

  private async doRun(userText: string, signal: AbortSignal, images?: ChatImage[]): Promise<'completed' | 'error' | 'aborted'> {
    const d = this.d
    // 图片随首条 user 历史进入请求体（三适配器按协议渲染）；无图时不带 images 字段（JSONL 与现状逐字节一致）
    d.onHistory({ role: 'user', text: userText, ...(images?.length ? { images } : {}) })
    d.emit([{ op: 'phase', phase: 'submitting' }, { op: 'phase', phase: 'running' }])
    while (true) {
      if (signal.aborted) return this.abort(signal)
      const events: StreamEvent[] = []
      try {
        for await (const ev of d.adapter.stream({
          system: buildSystemPrompt({ model: d.provider.modelId, cwd: d.cwd, platform: d.platform, date: new Date().toISOString().slice(0, 10) }),
          history: d.getHistory(), provider: d.provider, signal,
        })) {
          events.push(ev)
          this.consume(ev)
        }
      } catch (error: unknown) {
        if (signal.aborted) return this.abort(signal)
        // fetch 网络层异常（含代理断流 TypeError: terminated）
        events.push({ type: 'stream_error', kind: 'network', message: this.redact(error instanceof Error ? error.message : String(error)) })
      }
      this.flushStreamPatches()   // 流结束/出错：边界 flush（err/done 处理前保证过程文本已落盘）
      const done = events.find(e => e.type === 'message_done') as Extract<StreamEvent, { type: 'message_done' }> | undefined
      const err = [...events].reverse().find(e => e.type === 'stream_error') as Extract<StreamEvent, { type: 'stream_error' }> | undefined
      if (err) {
        if (err.kind === 'rateLimit' || err.kind === 'network') {
          if (this.retries < 3) {
            this.retries++
            d.emit([{ op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: t(d.locale ?? 'en', 'loop.retrying', { kind: err.kind, message: this.redact(err.message), n: this.retries }) } }])
            this.resetRoundStreaming()
            // Retry-After 指示与指数退避取大者（服务端明确要求的退避不被忽略），封顶 60s——
            // 异常网关的超长值不挂死整轮；适配器未上报 retryAfterMs 时退化为纯指数退避（零回归）
            await (d.delayMs ?? defaultDelay)(Math.min(Math.max(err.retryAfterMs ?? 0, 1000 * 2 ** (this.retries - 1)), 60_000))
            continue
          }
        }
        // Anthropic thinking 参数代际降级（400 + message 含 thinking）：adaptive→manual→none
        if (err.kind === 'invalidRequest' && d.provider.info.protocol === 'anthropic' && /thinking/i.test(err.message)) {
          const next = d.provider.thinkingMode === undefined || d.provider.thinkingMode === 'adaptive'
            ? 'manual'
            : d.provider.thinkingMode === 'manual' ? 'none' : undefined
          if (next) {
            d.provider.thinkingMode = next
            d.onProviderThinkingMode?.(next)
            this.retries = 0
            this.resetRoundStreaming()
            continue
          }
        }
        this.finalizeThought()   // 硬错误返回前冻结思考计时（内容保留在时间线）
        d.emit([
          { op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: this.redact(`${err.kind}: ${err.message}`) } },
          { op: 'phase', phase: 'error' },
        ])
        return 'error'
      }
      if (signal.aborted) return this.abort(signal)
      if (!done) {
        this.finalizeThought()   // 无 message_done 的残流同样不让 thought 停在 running
        d.emit([
          { op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: t(d.locale ?? 'en', 'loop.streamNoDone') } },
          { op: 'phase', phase: 'error' },
        ])
        return 'error'
      }
      if (done.stopReason === 'tool_use') {
        this.round++
        const limit = d.maxToolRounds ?? 40
        if (this.round > limit) {
          d.emit([
            { op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: t(d.locale ?? 'en', 'loop.roundLimit', { limit }) } },
            { op: 'phase', phase: 'error' },
          ])
          return 'error'
        }
        const turn = this.pendingTurn
        if (!turn?.toolCall) {
          d.emit([
            { op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: t(d.locale ?? 'en', 'loop.toolUseNoCall') } },
            { op: 'phase', phase: 'error' },
          ])
          return 'error'
        }
        d.onHistory({ role: 'assistant', turn })
        const toolContent = await this.executeRunCode(turn, signal)
        d.onHistory({ role: 'toolResult', callId: turn.toolCall.callId, content: toolContent.content, isError: toolContent.isError })
        d.emit([{ op: 'changes', changes: await (d.snapshotTracker?.changes() ?? Promise.resolve([])) }])
        this.retries = 0
        continue
      }
      // end_turn / max_tokens / other → 完成
      if (this.finalText) {
        // 最终轮同样携带 replay 信封（此刻尚未清空）：anthropic blocks / gemini parts 原样回带真实
        // signature/thoughtSignature，跨轮推理上下文不再丢失；openai 无信封 → 字段缺省，
        // buildOpenAiBody 的 ?? turn.thinking 回退不变（旧会话无信封路径零回归）。
        d.onHistory({ role: 'assistant', turn: { ...(this.turnThinking ? { thinking: this.turnThinking } : {}), text: this.finalText, ...(this.replayEnvelope ? { replay: this.replayEnvelope } : {}) } })
      }
      d.emit([{ op: 'phase', phase: 'completed' }])
      return 'completed'
    }
  }

  /** 重试（rateLimit/network/thinking 降级）前清空本轮流式累积，避免重放轮文本重复进入 completion/历史 */
  private resetRoundStreaming(): void {
    this.flushStreamPatches()   // 失败轮 partial 全文先落盘，clearCompletionEvent 的 remove 才有对应 append/patch 序列
    this.finalizeThought()      // 失败轮思考冻结计时（保留已流式内容），不留 running 态走秒
    this.clearCompletionEvent()
    this.pendingTurn = undefined
    this.thoughtId = undefined
    this.thoughtStartedAt = undefined
    this.turnThinking = undefined
    this.workingText = ''
    this.completionId = undefined
    this.completionText = ''
    this.finalText = ''
    this.toolArgs = ''
    this.toolCallId = ''
    this.replayEnvelope = undefined
  }

  /** I5：撤下本轮流式过程误建/半程的 completion 气泡（中间轮 preamble 不是最终总结；重试失败轮 partial 同理） */
  private clearCompletionEvent(): void {
    if (this.completionId === undefined) return
    this.d.emit([{ op: 'remove', id: this.completionId }])
    this.completionId = undefined
    this.completionText = ''
  }

  /** thought 终态收尾：done patch 固化 durationMs，UI 不再用墙钟差递增走秒。
   *  message_done / 重试重置 / 硬错误返回 / abort 各路径都必须走到——否则 running 态 thought
   *  随 ops 持久化进 JSONL，会话重放后永久显示「Thinking for N 小时」。内容保留（部分思考仍有价值）。 */
  private finalizeThought(): void {
    if (this.thoughtId === undefined) return
    this.d.emit([{ op: 'patch', id: this.thoughtId, patch: { status: 'done', durationMs: Date.now() - (this.thoughtStartedAt ?? Date.now()) } as never }])
    this.thoughtId = undefined
    this.thoughtStartedAt = undefined
  }

  /** delta 到达：距该 id 上次 flush ≥间隔则立即 emit，否则入缓冲（定时器兜底到点 flush） */
  private bufferStreamPatch(id: string, markdown: string): void {
    this.pendingPatches.set(id, { markdown })
    const last = this.lastPatchFlushAt.get(id) ?? 0
    const now = Date.now()
    const elapsed = now - last
    if (elapsed >= AgentLoop.PATCH_MIN_INTERVAL_MS) { this.flushStreamPatches(); return }
    if (this.patchTimer === null) {
      this.patchTimer = setTimeout(() => { this.patchTimer = null; this.flushStreamPatches() }, AgentLoop.PATCH_MIN_INTERVAL_MS - elapsed)
      this.patchTimer.unref()
    }
  }

  /** 边界/到点：把缓冲里的最新全量文本按 id 合并为一批 patch emit（幂等，缓冲空则无操作） */
  private flushStreamPatches(): void {
    if (this.patchTimer !== null) { clearTimeout(this.patchTimer); this.patchTimer = null }
    if (this.pendingPatches.size === 0) return
    const ops = [...this.pendingPatches.entries()].map(([id, patch]) => ({ op: 'patch' as const, id, patch: patch as never }))
    const now = Date.now()
    for (const id of this.pendingPatches.keys()) this.lastPatchFlushAt.set(id, now)
    this.pendingPatches.clear()
    this.d.emit(ops)
  }

  /** 错误文本脱敏：流错误消息（URL/回显）中出现的 apiKey 一律替换，不进时间线与 JSONL */
  private redact(text: string): string {
    const key = this.d.provider.apiKey
    return key ? text.split(key).join('[REDACTED]') : text
  }

  private consume(ev: StreamEvent): void {
    const d = this.d
    switch (ev.type) {
      case 'thinking_delta': {
        if (!this.thoughtId) {
          this.thoughtId = d.newEventId()
          const startedAt = Date.now()
          this.thoughtStartedAt = startedAt
          this.turnThinking = ''
          d.emit([{ op: 'append', event: { id: this.thoughtId, ts: Date.now(), type: 'thought', status: 'running', startedAt, markdown: '', working: '' } }])
        }
        this.turnThinking = (this.turnThinking ?? '') + ev.text
        this.bufferStreamPatch(this.thoughtId, this.turnThinking ?? '')
        break
      }
      case 'text_delta': {
        this.workingText += ev.text
        this.finalText += ev.text
        // 正文一律走 completion 气泡流式（含同轮 thinking+text 的纯聊天轮）——
        // 此前 thoughtId 存在时文本被塞进 thought.working，done 后 UI 隐藏该行，
        // 导致「思考了 Ns」后正文永远不可见；中间轮 preamble 气泡仍由 I5 在
        // tool_use 重置时 remove 撤下，语义不变。
        if (!this.completionId) {
          this.completionId = d.newEventId()
          d.emit([{ op: 'append', event: { id: this.completionId, ts: Date.now(), type: 'completion', markdown: '' } }])
        }
        this.completionText += ev.text
        this.bufferStreamPatch(this.completionId, this.completionText)
        break
      }
      case 'tool_call_delta':
        this.toolArgs += ev.argsDelta
        // 真实 id（适配器随增量外传的 toolu_…/call_…）优先采信：toolResult.callId 与 replay 信封中
        // tool_use.id 天然配对，消除第二轮 tool_use_id 不匹配的 Anthropic 400；无 id 路径（缺
        // content_block_start 的流、mock）保持合成 id 兜底零回归
        if (!this.toolCallId) this.toolCallId = ev.id ?? `call_${d.newEventId()}`
        break
      case 'replay_envelope':
        this.replayEnvelope = ev.envelope
        break
      case 'message_done': {
        this.flushStreamPatches()   // 事件边界：终态全文 patch 先于 status done 落盘
        this.finalizeThought()      // 正常收尾：done 固化 durationMs（与错误/中止路径共用同一收尾）
        if (ev.stopReason === 'tool_use') {
          let args: { code: string; description: string }
          try {
            args = JSON.parse(this.toolArgs || '{}') as { code: string; description: string }
          } catch {
            args = { code: this.toolArgs, description: 'unparsed program' }
          }
          // callId 先定后用：toolCall.callId 与兜底信封 tool_use.id 必须同源（各算各的会在无信封+无增量
          // 的极端流上重新制造 id 不匹配）。正常路径 toolCallId 已是适配器外传的真实 toolu_…。
          const callId = this.toolCallId || `call_${Date.now()}`
          this.pendingTurn = {
            ...(this.turnThinking ? { thinking: this.turnThinking } : {}),
            text: this.workingText,
            toolCall: { callId, name: 'run_code', args },
            replay: this.replayEnvelope ?? this.providerReplay(callId, args),
          }
          // 重置本轮流式累积（下一轮 thought 重开新事件；finalText 只保留最终轮文本；completion 气泡撤下——I5）
          this.clearCompletionEvent()
          this.thoughtId = undefined
          this.thoughtStartedAt = undefined
          this.turnThinking = undefined
          this.workingText = ''
          this.finalText = ''
          this.toolArgs = ''
          this.toolCallId = ''
          this.replayEnvelope = undefined
        }
        break
      }
      case 'stream_error':
        break   // 在 run() 统一处理
    }
  }

  /** 无信封兜底信封（适配器未上报 replay_envelope 时的回放重建）。callId 由调用方传入——
   *  与 toolCall.callId 同源，保证 anthropic 兜底 tool_use.id 与 tool_result.tool_use_id 配对。 */
  private providerReplay(callId: string, args: { code: string; description: string }): unknown {
    if (this.d.provider.info.protocol === 'openai') {
      return this.turnThinking ? { reasoning_content: this.turnThinking } : undefined
    }
    if (this.d.provider.info.protocol === 'anthropic') {
      // 不得伪造 thinking 块：Anthropic 用 signature 校验 thinking 确由模型生成，空/伪签名必 400
      // （与 buildAnthropicBody 防御同口径——非工具轮省略历史 thinking 合法，跨轮推理上下文
      // 由真实信封承载；走到本兜底说明信封缺失，thinking 上下文只能弃，不能伪造）。
      return { blocks: [{ type: 'tool_use', id: callId, name: 'run_code', input: args }] }
    }
    return { parts: [
      ...(this.turnThinking ? [{ text: this.turnThinking, thought: true }] : []),
      { functionCall: { name: 'run_code', args } },
    ] }
  }

  private async executeRunCode(turn: AssistantTurn, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
    const d = this.d
    const runEventId = d.newEventId()
    d.emit([{ op: 'append', event: { id: runEventId, ts: Date.now(), type: 'run', command: turn.toolCall!.args.description, status: 'running', outputTail: '' } }])
    const edits = new Map<string, { add: number; del: number }>()
    // DispatchPool 对同一次 submit 的 start/finish 传同一 args 引用——以此关联两相共用的 eventId
    const dispatchIds = new WeakMap<object, string>()
    // 原始值 args（程序直接传字符串等）进不了 WeakMap：唯一在 start 即 append 的 bash 是独占工具，
    // 其 start/finish 不会与另一个原始值调用交错——单个待配对槽即可保证 finish patch 落回 start append 的 id
    // （并发 safe 工具的原始值调用最坏只是配对落空另起新 id，append 各自带全量数据，不产生重复/孤儿事件）
    let pendingRawId: string | undefined
    const toolCtx: ToolContext = { cwd: d.cwd, signal }
    const pool = new DispatchPool(d.tools, toolCtx, {
      maxParallel: 10,
      onEvent: (e: DispatchEvent): void => {
        // M1：args 可能为原始值（程序传了字符串等）——WeakMap key 仅接受对象，先 typeof 判定
        const raw = e.args ?? null
        const key = raw !== null && typeof raw === 'object' ? raw : null
        let id: string | undefined
        if (key !== null) {
          id = dispatchIds.get(key)
          if (!id) { id = d.newEventId(); dispatchIds.set(key, id) }
        } else {
          id = pendingRawId ?? d.newEventId()
          pendingRawId = e.phase === 'start' ? id : undefined   // finish 用毕即清，槽位不复用旧 id
        }
        if (e.phase === 'finish' && (e.name === 'write_file' || e.name === 'edit_file') && e.result != null && typeof e.result === 'object') {
          const r = e.result as { add?: number; del?: number }
          edits.set(id, { add: r.add ?? 0, del: r.del ?? 0 })
        }
        d.emit(mapDispatchEvent(e, id, edits))
      },
    })
    try {
      const bindings: Record<string, (a: unknown) => Promise<unknown>> = {}
      for (const name of d.tools.keys()) {
        const editLike = name === 'write_file' || name === 'edit_file'
        // 快照先于执行：编辑类 binding 内先 await beforeEdit，再进池（onEvent 为同步签名）
        bindings[name] = async a => {
          if (editLike && d.snapshotTracker) {
            // 快照失败（典型：../ 越出工作区被 snapPath 拒绝）不阻断编辑，但绝不静默——否则该修改
            // 完全脱离 Review 面板（不可审阅/不可拒绝）而用户毫无感知
            await d.snapshotTracker.beforeEdit((a as { path?: string }).path ?? '', d.cwd).catch(err => {
              d.emit([{ op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: t(d.locale ?? 'en', 'loop.snapshotUnavailable', { path: (a as { path?: string }).path ?? '', error: err instanceof Error ? err.message : String(err) }) } }])
            })
          }
          return pool.submit(name, a)
        }
      }
      // onLog 流式接线：console.log 到达即 patch outputTail，执行期间输出可见（CodeRuntime.run 的 RunOptions.onLog）
      const liveLogs: string[] = []
      const result = await d.runtime.run({
        program: turn.toolCall!.args.code, bindings, signal,
        onLog: text => {
          liveLogs.push(text)
          d.emit([{ op: 'patch', id: runEventId, patch: { outputTail: liveLogs.slice(-3).join('\n').slice(-500) } as never }])
        },
      })
      await pool.settle()
      const content = JSON.stringify({
        logs: result.logs,
        ...(result.value !== undefined ? { value: result.value } : {}),
        ...(result.error ? { error: result.error } : {}),
      })
      // error 态不再空输出：失败原因（kind+message）附在末尾（错误时日志窗口收窄到 2 条给原因留位）；
      // 成功且无 logs 仍为空串，UI 显示无输出占位
      const outputTail = (result.error
        ? [...result.logs.slice(-2), formatRunErrorLine(result.error)]
        : result.logs.slice(-3)).join('\n').slice(-500)
      d.emit([{ op: 'patch', id: runEventId, patch: { status: result.error ? 'error' : 'done', outputTail } as never }])
      return { content, isError: !!result.error }
    } catch (error: unknown) {
      pool.abortPending('run aborted')
      // 等 inflight 工具（长 bash 等）收尾后再 patch run 终态：finish 事件不迟到、不与新轮 emit 交错
      await pool.settle().catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      d.emit([{ op: 'patch', id: runEventId, patch: { status: 'error', outputTail: message } as never }])
      return { content: JSON.stringify({ error: { kind: 'abort', message } }), isError: true }
    }
  }

  private abort(signal: AbortSignal): 'aborted' {
    this.flushStreamPatches()
    this.finalizeThought()   // 保留时间线，标注 stopped——思考冻结计时，内容保留但不再走秒
    this.d.emit([
      { op: 'append', event: { id: this.d.newEventId(), ts: Date.now(), type: 'error', message: t(this.d.locale ?? 'en', 'loop.stopped', { reason: String(signal.reason ?? 'user') }) } },
      { op: 'phase', phase: 'completed' },
    ])
    return 'aborted'
  }
}
