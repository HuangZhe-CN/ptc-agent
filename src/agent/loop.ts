import type { StreamEvent, FileChangeSummary } from '../shared/protocol'
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

  constructor(private readonly d: LoopDeps) {}

  async run(userText: string, signal: AbortSignal): Promise<'completed' | 'error' | 'aborted'> {
    const d = this.d
    d.onHistory({ role: 'user', text: userText })
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
        if (this.thoughtId) {
          // 工具轮间：working 行（thought 事件内）
          d.emit([{ op: 'patch', id: this.thoughtId, patch: { working: this.workingText.slice(-2000) } as never }])
        } else if (this.completionId) {
          this.completionText += ev.text
          d.emit([{ op: 'patch', id: this.completionId, patch: { markdown: this.completionText } as never }])
        } else {
          // 最终轮：completion 事件
          this.completionId = d.newEventId()
          this.completionText = ev.text
          d.emit([{ op: 'append', event: { id: this.completionId, ts: Date.now(), type: 'completion', markdown: this.completionText } }])
        }
        break
      }
      case 'tool_call_delta':
        this.toolArgs += ev.argsDelta
        if (!this.toolCallId) this.toolCallId = `call_${d.newEventId()}`
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
            replay: this.providerReplay(args),
          }
          // 重置本轮流式累积（下一轮 thought 重开新事件；finalText 只保留最终轮文本）
          this.thoughtId = undefined
          this.thoughtStartedAt = undefined
          this.turnThinking = undefined
          this.workingText = ''
          this.finalText = ''
          this.toolArgs = ''
          this.toolCallId = ''
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
        const key = (e.args ?? null) as object | null
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
      const result = await d.runtime.run({ program: turn.toolCall!.args.code, bindings, signal })
      await pool.settle()
      const content = JSON.stringify({
        logs: result.logs,
        ...(result.value !== undefined ? { value: result.value } : {}),
        ...(result.error ? { error: result.error } : {}),
      })
      d.emit([{ op: 'patch', id: runEventId, patch: { status: result.error ? 'error' : 'done', outputTail: result.logs.slice(-3).join('\n').slice(-500) } as never }])
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
