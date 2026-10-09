import { describe, it, expect } from 'vitest'
import { openaiAdapter, buildOpenAiBody } from '../src/protocol/openai'
import type { StreamRequest } from '../src/protocol/types'

const sse = (...events: string[]) => new ReadableStream<Uint8Array>({
  start(c) { const e = new TextEncoder(); for (const ev of events) c.enqueue(e.encode(ev)); c.close() },
})
const baseReq = (history: StreamRequest['history']): StreamRequest => ({
  system: 'SYS', history,
  provider: { info: { id: 'p', label: 'p', protocol: 'openai', baseUrl: 'https://x/v1', models: [{ id: 'm', label: 'm', supportsThinking: true }] }, apiKey: 'K', modelId: 'm', quality: 'high' },
  signal: new AbortController().signal,
})
const fakeFetch = (body: ReadableStream<Uint8Array>, status = 200) => async () =>
  ({ ok: status < 400, status, headers: { get: () => null }, body } as unknown as Response)

describe('buildOpenAiBody', () => {
  it('system 首位、run_code 工具、reasoning_effort、include_usage、max_completion_tokens', () => {
    const body = buildOpenAiBody(baseReq([])) as Record<string, any>
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.max_completion_tokens).toBe(32768)
    expect(body.reasoning_effort).toBe('high')
    expect(body.tools[0].function.name).toBe('run_code')
    expect(body.tools[0].function.parameters.required).toEqual(['code', 'description'])
  })
  it('noTools（/compact 压缩）：省略 tools/tool_choice，其余请求形状不变', () => {
    const body = buildOpenAiBody({ ...baseReq([{ role: 'user', text: 'hi' }]), noTools: true }) as Record<string, any>
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })
  it('assistant 轮回放 tool_calls 与 reasoning_content；tool 角色回传结果', () => {
    const body = buildOpenAiBody(baseReq([
      { role: 'assistant', turn: { thinking: 'TH', text: '', toolCall: { callId: 'c1', name: 'run_code', args: { code: '1', description: 'd' } }, replay: { reasoning_content: 'TH' } } },
      { role: 'toolResult', callId: 'c1', content: '{"value":1}', isError: false },
    ])) as Record<string, any>
    const asst = body.messages[1]   // messages[0] 是 system（见上一测试）
    expect(asst.role).toBe('assistant')
    expect(asst.reasoning_content).toBe('TH')
    expect(asst.tool_calls[0]).toEqual({ id: 'c1', type: 'function', function: { name: 'run_code', arguments: '{"code":"1","description":"d"}' } })
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"value":1}' })
  })
  it('无图 user 保持纯字符串 content（零回归）；带图升级为图文混排数组、纯图省略 text 块', () => {
    const img = { mime: 'image/png', base64: 'AAEC' }
    const plain = buildOpenAiBody(baseReq([{ role: 'user', text: 'hi' }])) as Record<string, any>
    expect(plain.messages[1]).toEqual({ role: 'user', content: 'hi' })   // 现状路径逐字节一致
    const mixed = buildOpenAiBody(baseReq([{ role: 'user', text: '看这张图', images: [img] }])) as Record<string, any>
    expect(mixed.messages[1]).toEqual({ role: 'user', content: [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAEC' } },
    ] })
    const onlyImage = buildOpenAiBody(baseReq([{ role: 'user', text: '', images: [img] }])) as Record<string, any>
    expect(onlyImage.messages[1]).toEqual({ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAEC' } },
    ] })
  })
})

describe('openaiAdapter.stream', () => {
  it('文本/思考/工具增量与 message_done', async () => {
    const events: any[] = []
    const iter = openaiAdapter.stream(baseReq([]), fakeFetch(sse(
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"run_code","arguments":"{\\"code\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"return 1\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\n',
      'data: [DONE]\n\n')))
    for await (const e of iter) events.push(e)
    expect(events).toEqual([
      { type: 'thinking_delta', text: 'think' },
      { type: 'text_delta', text: 'Hi' },
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":', id: 'c1' },   // 真实 call id 随增量外传（loop 采信后与回放 tool_calls[0].id 配对）
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '"return 1"}', id: 'c1' },
      { type: 'message_done', stopReason: 'tool_use', usage: { input: 5, output: 7 } },
    ])
  })
  it('delta.reasoning 字段（vLLM 系）也归一为 thinking_delta', async () => {
    const events: any[] = []
    for await (const e of openaiAdapter.stream(baseReq([]), fakeFetch(sse('data: {"choices":[{"delta":{"reasoning":"r"}}]}\n\n')))) events.push(e)
    expect(events[0]).toEqual({ type: 'thinking_delta', text: 'r' })
  })
  it('并行 tool_calls 截断到首个调用：后续 index 的增量整段丢弃，不拼出多调用串联的坏 JSON', async () => {
    const events: any[] = []
    const iter = openaiAdapter.stream(baseReq([]), fakeFetch(sse(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"run_code","arguments":"{\\"code\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","type":"function","function":{"name":"run_code","arguments":"{\\"code\\":\\"other\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"return 1\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n')))
    for await (const e of iter) events.push(e)
    expect(events.filter(e => e.type === 'tool_call_delta')).toEqual([
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":', id: 'c1' },
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '"return 1"}', id: 'c1' },
    ])   // index=1 的并行调用被丢弃——loop 拼出的仍是首个调用的完整合法 JSON
    expect(events[events.length - 1]).toMatchObject({ type: 'message_done', stopReason: 'tool_use' })
  })
  it('HTTP 401 → auth stream_error', async () => {
    const events: any[] = []
    for await (const e of openaiAdapter.stream(baseReq([]), fakeFetch(sse(), 401))) events.push(e)
    expect(events[0].type).toBe('stream_error'); expect(events[0].kind).toBe('auth')
  })
})
