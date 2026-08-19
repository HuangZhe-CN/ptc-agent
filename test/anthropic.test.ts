import { describe, it, expect } from 'vitest'
import { anthropicAdapter, buildAnthropicBody, THINKING_BUDGET } from '../src/protocol/anthropic'
import type { StreamRequest } from '../src/protocol/types'

const sse = (...events: (string | [event: string, data: string])[]) => new ReadableStream<Uint8Array>({
  start(c) { const e = new TextEncoder(); for (const [event, data] of events.map(p => typeof p === 'string' ? [undefined, p] : p)) { c.enqueue(e.encode(event ? `event: ${event}\n` : '')); c.enqueue(e.encode(`data: ${data}\n\n`)) } c.close() },
})
const req = (over: Partial<StreamRequest> = {}): StreamRequest => ({
  system: 'SYS', history: [],
  provider: { info: { id: 'p', label: 'p', protocol: 'anthropic', baseUrl: 'https://x', models: [{ id: 'claude-x', label: 'c', supportsThinking: true }] }, apiKey: 'K', modelId: 'claude-x', quality: 'high' },
  signal: new AbortController().signal, ...over,
})
const fakeFetch = (body: ReadableStream<Uint8Array>, status = 200) => async (_u: unknown, init: RequestInit) => {
  if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  return { ok: status < 400, status, headers: { get: () => null }, body } as unknown as Response
}

describe('buildAnthropicBody', () => {
  it('max_tokens 必填、system 顶层、thinking adaptive 优先、tools 用 input_schema', () => {
    const body = buildAnthropicBody(req()) as Record<string, any>
    expect(body.max_tokens).toBe(32768)
    expect(body.system).toBe('SYS')
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.tools[0]).toMatchObject({ name: 'run_code', input_schema: expect.any(Object) })
    expect(body.messages).toEqual([])
  })
  it('thinkingMode=manual 时 budget 映射 quality；none 时无 thinking', () => {
    expect((buildAnthropicBody(req({ provider: { ...req().provider, thinkingMode: 'manual' } })) as any).thinking)
      .toEqual({ type: 'enabled', budget_tokens: THINKING_BUDGET.high })
    expect((buildAnthropicBody(req({ provider: { ...req().provider, thinkingMode: 'none' } })) as any).thinking).toBeUndefined()
  })
  it('toolResult 变 user.tool_result 块；thinking 块带 signature 原样回传', () => {
    const body = buildAnthropicBody(req({ history: [
      { role: 'assistant', turn: { thinking: 'T', text: '', toolCall: { callId: 'tu1', name: 'run_code', args: { code: '1', description: 'd' } },
        replay: { blocks: [{ type: 'thinking', thinking: 'T', signature: 'SIG' }, { type: 'tool_use', id: 'tu1', name: 'run_code', input: { code: '1', description: 'd' } }] } } },
      { role: 'toolResult', callId: 'tu1', content: 'R', isError: true },
    ] })) as Record<string, any>
    expect(body.messages[0].role).toBe('assistant')
    expect(body.messages[0].content).toEqual(([{ type: 'thinking', thinking: 'T', signature: 'SIG' }, { type: 'tool_use', id: 'tu1', name: 'run_code', input: { code: '1', description: 'd' } }]))
    expect(body.messages[1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'R', is_error: true }] })
  })
})

describe('anthropicAdapter.stream', () => {
  it('事件序列 → thinking/text/tool 增量 + message_done(tool_use)', async () => {
    const events: any[] = []
    const iter = anthropicAdapter.stream(req(), fakeFetch(sse(
      ['message_start', '{"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}'],
      ['content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"th"}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG"}}'],
      ['content_block_stop', '{"type":"content_block_stop","index":0}'],
      ['content_block_start', '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}'],
      ['content_block_start', '{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu1","name":"run_code","input":{}}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"code\\":"}}'],
      ['content_block_stop', '{"type":"content_block_stop","index":2}'],
      ['message_delta', '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}'],
      ['message_stop', '{"type":"message_stop"}'],
    )))
    for await (const e of iter) events.push(e)
    expect(events).toEqual([
      { type: 'thinking_delta', text: 'th' },
      { type: 'text_delta', text: 'Hi' },
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":' },
      { type: 'message_done', stopReason: 'tool_use', usage: { input: 3, output: 9 } },
    ])
  })
  it('流中 error 事件 → server stream_error', async () => {
    const events: any[] = []
    for await (const e of anthropicAdapter.stream(req(), fakeFetch(sse(['error', '{"type":"error","error":{"type":"overloaded_error","message":"O"}}'])))) events.push(e)
    expect(events[0]).toMatchObject({ type: 'stream_error', kind: 'server', message: 'O' })
  })
})
