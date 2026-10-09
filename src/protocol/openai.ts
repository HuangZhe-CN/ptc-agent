import type { StreamEvent } from '../shared/protocol'
import { parseSse } from './sse'
import { classifyHttpError } from './errors'
import type { ProtocolAdapter, StreamRequest, AssistantTurn } from './types'

const STOP_MAP: Record<string, 'tool_use' | 'end_turn' | 'max_tokens' | 'other'> = {
  tool_calls: 'tool_use', stop: 'end_turn', length: 'max_tokens',
}

export function buildOpenAiBody(req: StreamRequest): unknown {
  const messages: unknown[] = [{ role: 'system', content: req.system }]
  for (const m of req.history) {
    if (m.role === 'user') {
      // 带图时 content 升级为数组（text 块在前，空文本省略）；无图保持纯字符串（零回归）
      if (m.images?.length) {
        messages.push({ role: 'user', content: [
          ...(m.text ? [{ type: 'text', text: m.text }] : []),
          ...m.images.map(img => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } })),
        ] })
      } else messages.push({ role: 'user', content: m.text })
    }
    else if (m.role === 'toolResult') messages.push({ role: 'tool', tool_call_id: m.callId, content: m.content })
    else {
      const turn: AssistantTurn = m.turn
      const asst: Record<string, unknown> = { role: 'assistant', content: turn.text || '' }
      // DeepSeek 带 tools 时必须回传 reasoning_content（SiliconFlow 服务端自行剥离，回传同样安全）
      const reasoning = (turn.replay as { reasoning_content?: string } | undefined)?.reasoning_content ?? turn.thinking
      if (reasoning) asst.reasoning_content = reasoning
      if (turn.toolCall) {
        asst.tool_calls = [{ id: turn.toolCall.callId, type: 'function',
          function: { name: 'run_code', arguments: JSON.stringify(turn.toolCall.args) } }]
      }
      messages.push(asst)
    }
  }
  return {
    model: req.provider.modelId, messages,
    // noTools（/compact 压缩）：省略工具定义与 tool_choice，真正的无工具请求
    ...(req.noTools ? {} : {
      tools: [{ type: 'function', function: { name: 'run_code', description: RUN_CODE_DESC,
        parameters: RUN_CODE_SCHEMA } }],
      tool_choice: 'auto',
    }),
    stream: true, stream_options: { include_usage: true },
    max_completion_tokens: 32768,
    ...(req.provider.info.models.find(m => m.id === req.provider.modelId)?.supportsThinking
      ? { reasoning_effort: req.provider.quality } : {}),
  }
}

export const RUN_CODE_DESC = 'Execute one TypeScript program. Takes `code` — the body of an async TypeScript function — and `description`, a short summary shown to the user.'
export const RUN_CODE_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'Async TypeScript function body (erasable syntax only). Tools are available as `await tools.name(args)`.' },
    description: { type: 'string', description: 'One-line summary of what the program does.' },
  },
  required: ['code', 'description'],
} as const

export const openaiAdapter: ProtocolAdapter = {
  protocol: 'openai',
  async *stream(req, fetchImpl = fetch): AsyncIterable<StreamEvent> {
    const res = await fetchImpl(`${req.provider.info.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.provider.apiKey}` },
      body: JSON.stringify(buildOpenAiBody(req)), signal: req.signal,
    })
    if (!res.ok || !res.body) {
      let text = ''
      try { text = await res.text() } catch { /* 读取失败（含 mock/连接中断）时以空文本分类 */ }
      const { kind, message, retryAfterMs } = classifyHttpError(res.status, text, res.headers as never)
      yield { type: 'stream_error', kind, message, retryAfterMs }; return   // retryAfterMs 透传，退避由 loop 消费端采信（三适配器同口径）
    }
    const toolArgs = new Map<number, { id: string; name: string; args: string }>()
    // 并行 tool_calls 截断到首个调用：loop 只支持单工具调用（多调用增量会拼进同一 args，解析失败后
    // 整段垃圾串被当程序执行）。记首个 tool_call 的 index，其余 index 的增量整段丢弃——历史信封
    // （buildOpenAiBody 只回放单调用）与后续单条 toolResult 天然一致，被丢调用模型下轮可重发
    let firstToolIndex: number | undefined
    // message_done 由 finish_reason 触发；usage 通常作为独立块随后到达（stream_options.include_usage），届时补上再发出
    let pendingStop: 'tool_use' | 'end_turn' | 'max_tokens' | 'other' | undefined
    const emitDone = function* (usage?: { input: number; output: number }): Generator<StreamEvent> {
      if (pendingStop !== undefined) {
        yield { type: 'message_done', stopReason: pendingStop, usage }
        pendingStop = undefined
      }
    }
    for await (const ev of parseSse(res.body)) {
      if (ev.data === '[DONE]') { yield* emitDone(); return }
      let chunk: any
      try { chunk = JSON.parse(ev.data) } catch { continue }
      if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
        // usage 独立块：为 pending 的 message_done 补 usage
        yield* emitDone({ input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 })
        continue
      }
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const d = choice.delta ?? {}
      const reasoning = d.reasoning_content ?? d.reasoning
      if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking_delta', text: reasoning }
      if (typeof d.content === 'string' && d.content) yield { type: 'text_delta', text: d.content }
      if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) {
        if (firstToolIndex === undefined) firstToolIndex = tc.index
        else if (tc.index !== firstToolIndex) continue   // 并行调用的后续 slot：丢弃（不进 slot、不 yield）
        const slot = toolArgs.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name = tc.function.name
        if (tc.function?.arguments) slot.args += tc.function.arguments
        toolArgs.set(tc.index, slot)
        // 真实 call id 随增量外传：loop 采信后 tool_call_id 与回放 asst.tool_calls[0].id 同源配对
        yield { type: 'tool_call_delta', name: slot.name || 'run_code', argsDelta: tc.function?.arguments ?? '', ...(slot.id ? { id: slot.id } : {}) }
      }
      if (choice.finish_reason) {
        pendingStop = STOP_MAP[choice.finish_reason] ?? 'other'
        if (chunk.usage) {
          yield* emitDone({ input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 })
        }
      }
    }
    yield* emitDone()
  },
}
