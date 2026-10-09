import type { Quality, StreamEvent } from '../shared/protocol'
import { parseSse } from './sse'
import { classifyHttpError } from './errors'
import type { ProtocolAdapter, StreamRequest, AssistantTurn } from './types'
import { RUN_CODE_DESC, RUN_CODE_SCHEMA } from './openai'

export const THINKING_BUDGET: Record<Quality, number> = { low: 1024, medium: 4096, high: 16384 }

export function buildAnthropicBody(req: StreamRequest): unknown {
  const messages: unknown[] = []
  for (const m of req.history) {
    if (m.role === 'user') {
      // 带图时 text 块在前 + image 块（base64 source）；无图保持单 text 块（零回归）
      if (m.images?.length) {
        const content: unknown[] = [
          ...(m.text ? [{ type: 'text', text: m.text }] : []),
          ...m.images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } })),
        ]
        messages.push({ role: 'user', content })
      } else messages.push({ role: 'user', content: [{ type: 'text', text: m.text }] })
    }
    else if (m.role === 'toolResult') messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.callId, content: m.content, is_error: m.isError }] })
    else {
      const turn: AssistantTurn = m.turn
      const replayBlocks = (turn.replay as { blocks?: unknown[] } | undefined)?.blocks
      if (replayBlocks) { messages.push({ role: 'assistant', content: replayBlocks }); continue }  // thinking/tool_use 原样回传
      // 无信封重建路径不得伪造 thinking 块：Anthropic 用 signature 校验 thinking 确由模型生成，
      // 空/伪签名必 400；官方文档确认非工具轮省略历史 thinking 块合法（跨轮推理上下文由 replay 信封承载）
      const content: unknown[] = []
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
    messages,
    // noTools（/compact 压缩）：省略工具定义，真正的无工具请求
    ...(req.noTools ? {} : { tools: [{ name: 'run_code', description: RUN_CODE_DESC, input_schema: RUN_CODE_SCHEMA }] }),
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
      const { kind, message, retryAfterMs } = classifyHttpError(res.status, text, res.headers as never)
      // retryAfterMs（429 的 Retry-After 秒数换算）随事件透传（三适配器同口径），重试退避由 loop 消费端采信
      yield { type: 'stream_error', kind, message, retryAfterMs }; return
    }
    let input = 0, output = 0
    // C1：原生块累积——thinking(+signature)/redacted_thinking/text/tool_use 原样重建，供 loop 存入 turn.replay 原样回传
    const blocks: unknown[] = []
    // 并行 tool_use 截断到首个：loop 只支持单工具调用——后续块的增量混入会拼成坏 JSON 被当程序执行，
    // 且信封多 tool_use 对单条 tool_result 必 400（镜像 openai/gemini 的同类截断，被丢调用模型下轮可重发）
    let sawToolUse = false
    const open = new Map<number, { type: 'thinking'; thinking: string; signature: string } | { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; json: string }>()
    const finalizeBlock = (index: number): void => {
      const s = open.get(index)
      if (!s) return
      if (s.type === 'thinking') {
        if (s.thinking || s.signature) blocks[index] = { type: 'thinking', thinking: s.thinking, signature: s.signature }
      } else if (s.type === 'text') {
        if (s.text) blocks[index] = { type: 'text', text: s.text }
      } else {
        let parsed: unknown = {}
        try { parsed = JSON.parse(s.json || '{}') } catch { /* 流截断的残缺 input：回退空对象（真实流在 stop 前必完整） */ }
        blocks[index] = { type: 'tool_use', id: s.id, name: s.name, input: parsed }
      }
      open.delete(index)
    }
    for await (const ev of parseSse(res.body)) {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { continue }
      switch (msg.type) {
        case 'message_start': input = msg.message?.usage?.input_tokens ?? 0; break
        case 'content_block_start': {
          const b = msg.content_block ?? {}
          if (b.type === 'redacted_thinking') blocks[msg.index] = { ...b }   // 原样保存（含 data，无需增量）
          else if (b.type === 'thinking') open.set(msg.index, { type: 'thinking', thinking: b.thinking ?? '', signature: b.signature ?? '' })
          else if (b.type === 'text') open.set(msg.index, { type: 'text', text: b.text ?? '' })
          else if (b.type === 'tool_use') {
            if (sawToolUse) break   // 并行调用的后续 tool_use 块：不开槽（增量在 delta 分支按同条件丢弃）
            sawToolUse = true
            open.set(msg.index, { type: 'tool_use', id: b.id ?? '', name: b.name ?? '', json: '' })
          }
          break
        }
        case 'content_block_delta': {
          const d = msg.delta ?? {}
          const s = open.get(msg.index)
          if (d.type === 'thinking_delta' && d.thinking) { yield { type: 'thinking_delta', text: d.thinking }; if (s?.type === 'thinking') s.thinking += d.thinking }
          else if (d.type === 'signature_delta' && d.signature) { if (s?.type === 'thinking') s.signature += d.signature }
          else if (d.type === 'text_delta' && d.text) { yield { type: 'text_delta', text: d.text }; if (s?.type === 'text') s.text += d.text }
          else if (d.type === 'input_json_delta' && d.partial_json) {
            if (s?.type !== 'tool_use') break   // 未开槽的并行 tool_use 块增量：丢弃（不 yield、不拼接）
            yield { type: 'tool_call_delta', name: 'run_code', argsDelta: d.partial_json, ...(s.id ? { id: s.id } : {}) }   // 真实 id（toolu_…）随增量外传：loop 采信后 tool_use_id 与 replay 信封中 tool_use.id 天然配对（缺信封/无 id 时省略字段）
            s.json += d.partial_json
          }
          break
        }
        case 'content_block_stop': finalizeBlock(msg.index); break
        case 'message_delta':
          output = msg.usage?.output_tokens ?? output
          if (msg.delta?.stop_reason) {
            const stop = msg.delta.stop_reason === 'tool_use' ? 'tool_use' : msg.delta.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn'
            for (const index of open.keys()) finalizeBlock(index)   // 兜底：流未发 content_block_stop 的未闭块
            const native = blocks.filter(Boolean)
            if (native.length > 0) yield { type: 'replay_envelope', envelope: { blocks: native } }
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
