import type { Quality, StreamEvent } from '../shared/protocol'
import { parseSse } from './sse'
import { classifyHttpError } from './errors'
import type { ProtocolAdapter, StreamRequest, AssistantTurn } from './types'
import { RUN_CODE_DESC, RUN_CODE_SCHEMA } from './openai'

export const THINKING_BUDGET: Record<Quality, number> = { low: 1024, medium: 4096, high: 16384 }

export function buildAnthropicBody(req: StreamRequest): unknown {
  const messages: unknown[] = []
  for (const m of req.history) {
    if (m.role === 'user') messages.push({ role: 'user', content: [{ type: 'text', text: m.text }] })
    else if (m.role === 'toolResult') messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.callId, content: m.content, is_error: m.isError }] })
    else {
      const turn: AssistantTurn = m.turn
      const replayBlocks = (turn.replay as { blocks?: unknown[] } | undefined)?.blocks
      if (replayBlocks) { messages.push({ role: 'assistant', content: replayBlocks }); continue }  // thinking/tool_use 原样回传
      const content: unknown[] = []
      if (turn.thinking) content.push({ type: 'thinking', thinking: turn.thinking, signature: '' })
      if (turn.text) content.push({ type: 'text', text: turn.text })
      if (turn.toolCall) content.push({ type: 'tool_use', id: turn.toolCall.callId, name: 'run_code', input: turn.toolCall.args })
      messages.push({ role: 'assistant', content })
    }
  }
  const supportsThinking = req.provider.info.models.find(m => m.id === req.provider.modelId)?.supportsThinking
  let thinking: unknown
  if (supportsThinking) {
    if (req.provider.thinkingMode === 'manual') thinking = { type: 'enabled', budget_tokens: THINKING_BUDGET[req.provider.quality] }
    else if (req.provider.thinkingMode === 'none') thinking = undefined
    else thinking = { type: 'adaptive' }   // 4.6+ 弃用 manual；400 时由 loop 触发降级（Task 14）
  }
  return {
    model: req.provider.modelId, max_tokens: 32768, system: req.system,
    messages, tools: [{ name: 'run_code', description: RUN_CODE_DESC, input_schema: RUN_CODE_SCHEMA }],
    ...(thinking ? { thinking } : {}), stream: true,
  }
}

const ERR_KIND: Record<string, 'server'> = { overloaded_error: 'server' }

export const anthropicAdapter: ProtocolAdapter = {
  protocol: 'anthropic',
  async *stream(req, fetchImpl = fetch): AsyncIterable<StreamEvent> {
    const res = await fetchImpl(`${req.provider.info.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': req.provider.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(buildAnthropicBody(req)), signal: req.signal,
    })
    if (!res.ok || !res.body) {
      let text = ''
      try { text = await res.text() } catch { /* 读取失败（含 mock/连接中断）时以空文本分类 */ }
      const { kind, message } = classifyHttpError(res.status, text, res.headers as never)
      yield { type: 'stream_error', kind, message }; return
    }
    let input = 0, output = 0
    for await (const ev of parseSse(res.body)) {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { continue }
      switch (msg.type) {
        case 'message_start': input = msg.message?.usage?.input_tokens ?? 0; break
        case 'content_block_delta': {
          const d = msg.delta ?? {}
          if (d.type === 'thinking_delta' && d.thinking) yield { type: 'thinking_delta', text: d.thinking }
          else if (d.type === 'text_delta' && d.text) yield { type: 'text_delta', text: d.text }
          else if (d.type === 'input_json_delta' && d.partial_json) yield { type: 'tool_call_delta', name: 'run_code', argsDelta: d.partial_json }
          break
        }
        case 'message_delta':
          output = msg.usage?.output_tokens ?? output
          if (msg.delta?.stop_reason) {
            const stop = msg.delta.stop_reason === 'tool_use' ? 'tool_use' : msg.delta.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn'
            yield { type: 'message_done', stopReason: stop, usage: { input, output } }
          }
          break
        case 'error': {
          const kind = ERR_KIND[msg.error?.type] ?? 'server'
          yield { type: 'stream_error', kind, message: msg.error?.message ?? 'unknown' }; return
        }
      }
    }
  },
}
