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
  it('noTools（/compact 压缩）：省略 tools，其余请求形状不变', () => {
    const body = buildAnthropicBody(req({ noTools: true })) as Record<string, any>
    expect(body.tools).toBeUndefined()
    expect(body.max_tokens).toBe(32768)
    expect(body.system).toBe('SYS')
    expect(body.stream).toBe(true)
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
  it('无信封重建路径不伪造 thinking 块（signature 空串必 400；非工具轮省略历史 thinking 合法）', () => {
    const plain = buildAnthropicBody(req({ history: [
      { role: 'assistant', turn: { thinking: 'T', text: 'hi' } },
      { role: 'user', text: 'again' },
    ] })) as Record<string, any>
    expect(plain.messages[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] })
    const tool = buildAnthropicBody(req({ history: [
      { role: 'assistant', turn: { thinking: 'T', text: '', toolCall: { callId: 'c1', name: 'run_code', args: { code: '1', description: 'd' } } } },
      { role: 'toolResult', callId: 'c1', content: 'R', isError: false },
    ] })) as Record<string, any>
    expect(tool.messages[0].content).toEqual([{ type: 'tool_use', id: 'c1', name: 'run_code', input: { code: '1', description: 'd' } }])
  })
  it('无图 user 保持单 text 块（零回归）；带图渲染 image base64 source、纯图省略 text 块', () => {
    const img = { mime: 'image/jpeg', base64: 'AAEC' }
    const plain = buildAnthropicBody(req({ history: [{ role: 'user', text: 'hi' }] })) as Record<string, any>
    expect(plain.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    const mixed = buildAnthropicBody(req({ history: [{ role: 'user', text: '看这张图', images: [img] }] })) as Record<string, any>
    expect(mixed.messages[0]).toEqual({ role: 'user', content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAEC' } },
    ] })
    const onlyImage = buildAnthropicBody(req({ history: [{ role: 'user', text: '', images: [img] }] })) as Record<string, any>
    expect(onlyImage.messages[0]).toEqual({ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAEC' } },
    ] })
  })
})

describe('anthropicAdapter.stream', () => {
  it('事件序列 → thinking/text/tool 增量 + replay_envelope + message_done(tool_use)', async () => {
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
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":', id: 'tu1' },   // 真实 toolu id 随增量外传（loop 采信后与 replay 信封中 tool_use.id 配对）
      // C1：thinking(+signature)/text/tool_use 原生块原样重建（残缺 input_json → {} 兜底）
      { type: 'replay_envelope', envelope: { blocks: [
        { type: 'thinking', thinking: 'th', signature: 'SIG' },
        { type: 'text', text: 'Hi' },
        { type: 'tool_use', id: 'tu1', name: 'run_code', input: {} },
      ] } },
      { type: 'message_done', stopReason: 'tool_use', usage: { input: 3, output: 9 } },
    ])
  })
  it('并行 tool_use 截断到首个：后续块的 start/delta 均忽略，信封只含一个 tool_use', async () => {
    const events: any[] = []
    const iter = anthropicAdapter.stream(req(), fakeFetch(sse(
      ['content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"run_code","input":{}}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"code\\":\\"1\\"}"}}'],
      ['content_block_stop', '{"type":"content_block_stop","index":0}'],
      // 并行第二个 tool_use 块：增量混入会拼成坏 JSON 被当程序执行，且信封多 tool_use 对单条 tool_result 必 400
      ['content_block_start', '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu2","name":"run_code","input":{}}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"code\\":\\"2\\"}"}}'],
      ['content_block_stop', '{"type":"content_block_stop","index":1}'],
      ['message_delta', '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}'],
      ['message_stop', '{"type":"message_stop"}'],
    )))
    for await (const e of iter) events.push(e)
    expect(events.filter(e => e.type === 'tool_call_delta')).toEqual([
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":"1"}', id: 'tu1' },
    ])
    const envelope = events.find(e => e.type === 'replay_envelope')
    expect(envelope.envelope.blocks).toEqual([{ type: 'tool_use', id: 'tu1', name: 'run_code', input: { code: '1' } }])
  })
  it('C1：signature_delta 分片累积 + redacted_thinking 原样 + tool input 完整解析 → 信封逐字节回传', async () => {
    const events: any[] = []
    const SIG_A = 'EqQBCkgIBRAGKFWTQmFhZ2dn'     // 分片 1（真实签名形态：base64 片段）
    const SIG_B = 'bmRlZGRlZA==9f3v8b7'          // 分片 2
    const iter = anthropicAdapter.stream(req(), fakeFetch(sse(
      ['content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}'],
      ['content_block_delta', `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"l"}}`],
      ['content_block_delta', `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"et me"}}`],
      ['content_block_delta', `{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"${SIG_A}"}}`],
      ['content_block_delta', `{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"${SIG_B}"}}`],
      ['content_block_stop', '{"type":"content_block_stop","index":0}'],
      ['content_block_start', '{"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"RW5jcnlwdGVkLXJlZGFjdGVkLWJsb2I="}}'],
      ['content_block_stop', '{"type":"content_block_stop","index":1}'],
      ['content_block_start', '{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu9","name":"run_code","input":{}}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"code\\":\\"return 1\\""}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":",\\"description\\":\\"d\\"}"}}'],
      ['content_block_stop', '{"type":"content_block_stop","index":2}'],
      ['message_delta', '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}'],
      ['message_stop', '{"type":"message_stop"}'],
    )))
    for await (const e of iter) events.push(e)
    const envelope = events.find(e => e.type === 'replay_envelope')
    expect(envelope).toBeDefined()
    // 签名逐字节一致（分片拼接）；redacted_thinking 原样；tool input 完整 JSON 解析
    expect(envelope.envelope).toEqual({ blocks: [
      { type: 'thinking', thinking: 'let me', signature: `${SIG_A}${SIG_B}` },
      { type: 'redacted_thinking', data: 'RW5jcnlwdGVkLXJlZGFjdGVkLWJsb2I=' },
      { type: 'tool_use', id: 'tu9', name: 'run_code', input: { code: 'return 1', description: 'd' } },
    ] })
    // 信封事件先于 message_done（loop 在 message_done 消费时取用）
    expect(events.findIndex(e => e.type === 'replay_envelope')).toBeLessThan(events.findIndex(e => e.type === 'message_done'))
    // 每个 tool_call_delta 增量都携带同一真实 tool_use id（多分片流同样成立）
    expect(events.filter(e => e.type === 'tool_call_delta')).toHaveLength(2)
    expect(events.filter(e => e.type === 'tool_call_delta').every(e => e.id === 'tu9')).toBe(true)
  })
  it('流中 error 事件 → server stream_error', async () => {
    const events: any[] = []
    for await (const e of anthropicAdapter.stream(req(), fakeFetch(sse(['error', '{"type":"error","error":{"type":"overloaded_error","message":"O"}}'])))) events.push(e)
    expect(events[0]).toMatchObject({ type: 'stream_error', kind: 'server', message: 'O' })
  })
})
