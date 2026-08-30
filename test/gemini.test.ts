import { describe, it, expect } from 'vitest'
import { geminiAdapter, buildGeminiBody } from '../src/protocol/gemini'
import type { StreamRequest } from '../src/protocol/types'

const sse = (...datas: string[]) => new ReadableStream<Uint8Array>({
  start(c) { const e = new TextEncoder(); for (const d of datas) c.enqueue(e.encode(`data: ${d}\n\n`)); c.close() },
})
const req = (over: Partial<StreamRequest> = {}): StreamRequest => ({
  system: 'SYS', history: [],
  provider: { info: { id: 'p', label: 'p', protocol: 'gemini', baseUrl: 'https://x/v1beta', models: [{ id: 'gemini-x', label: 'g', supportsThinking: true }] }, apiKey: 'K', modelId: 'gemini-x', quality: 'medium' },
  signal: new AbortController().signal, ...over,
})
const fakeFetch = (body: ReadableStream<Uint8Array>) => async () => ({ ok: true, status: 200, headers: { get: () => null }, body } as unknown as Response)

describe('buildGeminiBody', () => {
  it('systemInstruction、thinkingLevel 按 quality、tools.functionDeclarations', () => {
    const body = buildGeminiBody(req()) as Record<string, any>
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] })
    expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'MEDIUM' })
    expect(body.tools[0].functionDeclarations[0].name).toBe('run_code')
  })
  it('noTools（/compact 压缩）：省略 tools/toolConfig，其余请求形状不变', () => {
    const body = buildGeminiBody(req({ noTools: true })) as Record<string, any>
    expect(body.tools).toBeUndefined()
    expect(body.toolConfig).toBeUndefined()
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] })
    expect(body.generationConfig.maxOutputTokens).toBe(32768)
  })
  it('functionResponse 放 user、functionCall+thoughtSignature 回带 model', () => {
    const body = buildGeminiBody(req({ history: [
      { role: 'assistant', turn: { thinking: 'T', text: '', toolCall: { callId: 'f1', name: 'run_code', args: { code: '1', description: 'd' } },
        replay: { parts: [{ text: 'T', thought: true }, { functionCall: { name: 'run_code', args: { code: '1', description: 'd' } }, thoughtSignature: 'SIG' }] } } },
      { role: 'toolResult', callId: 'f1', content: 'R', isError: false },
    ] })) as Record<string, any>
    expect(body.contents[0]).toEqual({ role: 'model', parts: [{ text: 'T', thought: true }, { functionCall: { name: 'run_code', args: { code: '1', description: 'd' } }, thoughtSignature: 'SIG' }] })
    expect(body.contents[1]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'run_code', response: { output: 'R', success: true } } }] })
  })
  it('无图 user 保持单 text part（零回归）；带图渲染 inlineData、纯图省略 text part', () => {
    const img = { mime: 'image/webp', base64: 'AAEC' }
    const plain = buildGeminiBody(req({ history: [{ role: 'user', text: 'hi' }] })) as Record<string, any>
    expect(plain.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] })
    const mixed = buildGeminiBody(req({ history: [{ role: 'user', text: '看这张图', images: [img] }] })) as Record<string, any>
    expect(mixed.contents[0]).toEqual({ role: 'user', parts: [
      { text: '看这张图' },
      { inlineData: { mimeType: 'image/webp', data: 'AAEC' } },
    ] })
    const onlyImage = buildGeminiBody(req({ history: [{ role: 'user', text: '', images: [img] }] })) as Record<string, any>
    expect(onlyImage.contents[0]).toEqual({ role: 'user', parts: [
      { inlineData: { mimeType: 'image/webp', data: 'AAEC' } },
    ] })
  })
})

describe('geminiAdapter.stream', () => {
  it('thought/text/functionCall 完整对象、usage、finishReason、replay_envelope 原样 parts', async () => {
    const events: any[] = []
    const iter = geminiAdapter.stream(req(), fakeFetch(sse(
      '{"candidates":[{"content":{"role":"model","parts":[{"text":"th","thought":true}]}}],"usageMetadata":{"promptTokenCount":2,"thoughtsTokenCount":0,"candidatesTokenCount":0,"totalTokenCount":2}}',
      '{"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]}}],"usageMetadata":{"promptTokenCount":2,"thoughtsTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":8}}',
      '{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"run_code","args":{"code":"return 1","description":"d"}},"thoughtSignature":"SIG"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"thoughtsTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":10}}')))
    for await (const e of iter) events.push(e)
    expect(events).toEqual([
      { type: 'thinking_delta', text: 'th' },
      { type: 'text_delta', text: 'Hi' },
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":"return 1","description":"d"}' },
      // C2：parts 原样累积（functionCall 携带 thoughtSignature）
      { type: 'replay_envelope', envelope: { parts: [
        { text: 'th', thought: true },
        { text: 'Hi' },
        { functionCall: { name: 'run_code', args: { code: 'return 1', description: 'd' } }, thoughtSignature: 'SIG' },
      ] } },
      { type: 'message_done', stopReason: 'tool_use', usage: { input: 2, output: 8 } },
    ])
  })
  it('C2：thought part 与 functionCall part 各自携带的 thoughtSignature 均原样进信封（逐字节）', async () => {
    const events: any[] = []
    const TS_THOUGHT = 'c2lnLW9uLXRoaW5raW5nLXBhcnQ='
    const TS_CALL = 'c2lnLW9uLWNhbGwtcGFydA=='
    const iter = geminiAdapter.stream(req(), fakeFetch(sse(
      `{"candidates":[{"content":{"role":"model","parts":[{"text":"preamble","thought":true,"thoughtSignature":"${TS_THOUGHT}"}]}}]}`,
      `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"run_code","args":{"code":"return 2","description":"dd"}},"thoughtSignature":"${TS_CALL}"}]},"finishReason":"STOP"}]}`,
    )))
    for await (const e of iter) events.push(e)
    const envelope = events.find(e => e.type === 'replay_envelope')
    expect(envelope).toBeDefined()
    expect(envelope.envelope).toEqual({ parts: [
      { text: 'preamble', thought: true, thoughtSignature: TS_THOUGHT },
      { functionCall: { name: 'run_code', args: { code: 'return 2', description: 'dd' } }, thoughtSignature: TS_CALL },
    ] })
    expect(events.findIndex(e => e.type === 'replay_envelope')).toBeLessThan(events.findIndex(e => e.type === 'message_done'))
  })
})
