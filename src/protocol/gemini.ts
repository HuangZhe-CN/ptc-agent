import type { Quality, StreamEvent } from '../shared/protocol'
import { parseSse } from './sse'
import { classifyHttpError } from './errors'
import type { ProtocolAdapter, StreamRequest, AssistantTurn } from './types'
import { RUN_CODE_DESC, RUN_CODE_SCHEMA } from './openai'

const LEVEL: Record<Quality, string> = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' }

export function buildGeminiBody(req: StreamRequest): unknown {
  const contents: unknown[] = []
  for (const m of req.history) {
    if (m.role === 'user') contents.push({ role: 'user', parts: [{ text: m.text }] })
    else if (m.role === 'toolResult') contents.push({ role: 'user', parts: [{ functionResponse: { name: 'run_code', response: { output: m.content, success: !m.isError } } }] })
    else {
      const turn: AssistantTurn = m.turn
      const replayParts = (turn.replay as { parts?: unknown[] } | undefined)?.parts
      if (replayParts) { contents.push({ role: 'model', parts: replayParts }); continue }   // thoughtSignature 原样回带
      const parts: Record<string, unknown>[] = []
      if (turn.thinking) parts.push({ text: turn.thinking, thought: true })
      if (turn.text) parts.push({ text: turn.text })
      if (turn.toolCall) parts.push({ functionCall: { name: 'run_code', args: turn.toolCall.args } })
      contents.push({ role: 'model', parts })
    }
  }
  const supportsThinking = req.provider.info.models.find(m => m.id === req.provider.modelId)?.supportsThinking
  return {
    systemInstruction: { parts: [{ text: req.system }] }, contents,
    tools: [{ functionDeclarations: [{ name: 'run_code', description: RUN_CODE_DESC, parameters: RUN_CODE_SCHEMA }] }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: {
      maxOutputTokens: 32768,
      ...(supportsThinking ? { thinkingConfig: { includeThoughts: true, thinkingLevel: LEVEL[req.provider.quality] } } : {}),
    },
  }
}

export const geminiAdapter: ProtocolAdapter = {
  protocol: 'gemini',
  async *stream(req, fetchImpl = fetch): AsyncIterable<StreamEvent> {
    const base = req.provider.info.baseUrl.replace(/\/$/, '')
    const res = await fetchImpl(`${base}/models/${encodeURIComponent(req.provider.modelId)}:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': req.provider.apiKey },
      body: JSON.stringify(buildGeminiBody(req)), signal: req.signal,
    })
    if (!res.ok || !res.body) {
      let text = ''
      try { text = await res.text() } catch { /* 读取失败（含 mock/连接中断）时以空文本分类 */ }
      const { kind, message } = classifyHttpError(res.status, text, res.headers as never)
      yield { type: 'stream_error', kind, message }; return
    }
    let input = 0, output = 0, sawFunctionCall = false
    for await (const ev of parseSse(res.body)) {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { continue }
      if (msg.usageMetadata) {
        input = msg.usageMetadata.promptTokenCount ?? input
        output = (msg.usageMetadata.thoughtsTokenCount ?? 0) + (msg.usageMetadata.candidatesTokenCount ?? 0)
      }
      const cand = msg.candidates?.[0]
      for (const part of cand?.content?.parts ?? []) {
        if (part.functionCall) {
          sawFunctionCall = true
          yield { type: 'tool_call_delta', name: part.functionCall.name, argsDelta: JSON.stringify(part.functionCall.args) }
        } else if (typeof part.text === 'string' && part.text) {
          yield part.thought ? { type: 'thinking_delta', text: part.text } : { type: 'text_delta', text: part.text }
        }
      }
      if (cand?.finishReason) {
        const stop = sawFunctionCall ? 'tool_use' : cand.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn'
        yield { type: 'message_done', stopReason: stop, usage: { input, output } }
      }
    }
  },
}
