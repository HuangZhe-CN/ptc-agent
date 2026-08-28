import type { StreamEvent, FileChangeSummary, ChatImage } from '../shared/protocol'
import type { ProtocolAdapter, ResolvedProvider, HistoryMessage, AssistantTurn } from '../protocol/types'
import type { CodeRuntime } from '../runtime/codeRuntime'
import { DispatchPool, type DispatchEvent } from '../runtime/dispatchPool'
import type { ToolDef, ToolContext } from '../tools/registry'
import { buildSystemPrompt } from './prompt'
import { mapDispatchEvent, type Emit } from './events'

export interface LoopDeps {
  adapter: ProtocolAdapter
  provider: ResolvedProvider
  runtime: Pick<CodeRuntime, 'run'>
  tools: Map<string, ToolDef>
  cwd: string
  platform: NodeJS.Platform
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

  constructor(private readonly d: LoopDeps) {}

  async run(userText: string, signal: AbortSignal, images?: ChatImage[]): Promise<'completed' | 'error' | 'aborted'> {
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
        events.push({ type: 'stream_error', kind: 'network', message: error instanceof Error ? error.message : String(error) })
      }
      const done = events.find(e => e.type === 'message_done') as Extract<StreamEvent, { type: 'message_done' }> | undefined
      const err = [...events].reverse().find(e => e.type === 'stream_error') as Extract<StreamEvent, { type: 'stream_error' }> | undefined
      if (err) {
        if (err.kind === 'rateLimit' || err.kind === 'network') {
          if (this.retries < 3) {
            this.retries++
            d.emit([{ op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: `${err.kind}: ${err.message} — retrying (${this.retries}/3)` } }])
            this.resetRoundStreaming()
            await (d.delayMs ?? defaultDelay)(1000 * 2 ** (this.retries - 1))
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
        d.emit([
          { op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: `${err.kind}: ${err.message}` } },
          { op: 'phase', phase: 'error' },
        ])
        return 'error'
      }
      if (signal.aborted) return this.abort(signal)
      if (!done) {
        d.emit([
          { op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: 'stream ended without message_done' } },
          { op: 'phase', phase: 'error' },
        ])
        return 'error'
      }
      if (done.stopReason === 'tool_use') {
        this.round++
        const limit = d.maxToolRounds ?? 40
        if (this.round > limit) {
          d.emit([
            { op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: `Reached the tool-call round limit (${limit}). Stopping to stay safe.` } },
            { op: 'phase', phase: 'error' },
          ])
          return 'error'
        }
        const turn = this.pendingTurn
        if (!turn?.toolCall) {
          d.emit([
            { op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: 'tool_use stop reason without a parsed run_code call' } },
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
        d.onHistory({ role: 'assistant', turn: { ...(this.turnThinking ? { thinking: this.turnThinking } : {}), text: this.finalText } })
      }
      d.emit([{ op: 'phase', phase: 'completed' }])
      return 'completed'
    }
  }

  /** 重试（rateLimit/network/thinking 降级）前清空本轮流式累积，避免重放轮文本重复进入 completion/历史 */
  private resetRoundStreaming(): void {
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
        d.emit([{ op: 'patch', id: this.thoughtId, patch: { markdown: this.turnThinking } as never }])
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
        d.emit([{ op: 'patch', id: this.completionId, patch: { markdown: this.completionText } as never }])
        break
      }
      case 'tool_call_delta':
        this.toolArgs += ev.argsDelta
        if (!this.toolCallId) this.toolCallId = `call_${d.newEventId()}`
        break
      case 'replay_envelope':
        this.replayEnvelope = ev.envelope
        break
      case 'message_done': {
        if (this.thoughtId) d.emit([{ op: 'patch', id: this.thoughtId, patch: { status: 'done', durationMs: Date.now() - (this.thoughtStartedAt ?? Date.now()) } as never }])
        if (ev.stopReason === 'tool_use') {
          let args: { code: string; description: string }
          try {
            args = JSON.parse(this.toolArgs || '{}') as { code: string; description: string }
          } catch {
            args = { code: this.toolArgs, description: 'unparsed program' }
          }
          this.pendingTurn = {
            ...(this.turnThinking ? { thinking: this.turnThinking } : {}),
            text: this.workingText,
            toolCall: { callId: this.toolCallId || `call_${Date.now()}`, name: 'run_code', args },
            replay: this.replayEnvelope ?? this.providerReplay(args),
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

  private providerReplay(args: { code: string; description: string }): unknown {
    const callId = this.toolCallId || 'tu'
    if (this.d.provider.info.protocol === 'openai') {
      return this.turnThinking ? { reasoning_content: this.turnThinking } : undefined
    }
    if (this.d.provider.info.protocol === 'anthropic') {
      return { blocks: [
        ...(this.turnThinking ? [{ type: 'thinking', thinking: this.turnThinking, signature: '' }] : []),
        { type: 'tool_use', id: callId, name: 'run_code', input: args },
      ] }
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
    const toolCtx: ToolContext = { cwd: d.cwd, signal }
    const pool = new DispatchPool(d.tools, toolCtx, {
      maxParallel: 10,
      onEvent: (e: DispatchEvent): void => {
        // M1：args 可能为原始值（程序传了字符串等）——WeakMap key 仅接受对象，先 typeof 判定
        const raw = e.args ?? null
        const key = raw !== null && typeof raw === 'object' ? raw : null
        let id = key !== null ? dispatchIds.get(key) : undefined
        if (!id) {
          id = d.newEventId()
          if (key !== null) dispatchIds.set(key, id)
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
            await d.snapshotTracker.beforeEdit((a as { path?: string }).path ?? '', d.cwd).catch(() => {})
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
      const message = error instanceof Error ? error.message : String(error)
      d.emit([{ op: 'patch', id: runEventId, patch: { status: 'error', outputTail: message } as never }])
      return { content: JSON.stringify({ error: { kind: 'abort', message } }), isError: true }
    }
  }

  private abort(signal: AbortSignal): 'aborted' {
    // 保留时间线，标注 stopped；phase 回 completed
    this.d.emit([
      { op: 'append', event: { id: this.d.newEventId(), ts: Date.now(), type: 'error', message: `Stopped (${String(signal.reason ?? 'user')})` } },
      { op: 'phase', phase: 'completed' },
    ])
    return 'aborted'
  }
}
