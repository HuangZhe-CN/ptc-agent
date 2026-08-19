import { describe, it, expect } from 'vitest'
import { parseSse } from '../src/protocol/sse'

const stream = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream({ pull(c) { i < chunks.length ? c.enqueue(enc.encode(chunks[i++])) : c.close() } })
}
const collect = async (s: ReadableStream<Uint8Array>) => {
  const out: string[] = []
  for await (const e of parseSse(s)) out.push(e.event ? `${e.event}:${e.data}` : e.data)
  return out
}

describe('parseSse', () => {
  it('解析 data/event、多行 data、CRLF、[DONE]、注释行、跨块分割', async () => {
    const events = await collect(stream(
      'data: {"a":1}\n\n',
      ': keepalive\n\n',
      'event: content_block_delta\r\ndata: {"b":2}\r\n\r\n',
      'data: line1\ndata: line2\n\n',
      'data: [DONE]\n\n',
      'data: {"split":', 'ted}\n\n'))
    expect(events).toEqual([
      '{"a":1}',
      'content_block_delta:{"b":2}',
      'line1\nline2',
      '[DONE]',
      '{"split":ted}',
    ])
  })
  it('M2：混合换行边界（\\r\\n\\n 与 \\n\\r\\n）不吃下一 block 首字符', async () => {
    const events = await collect(stream(
      'event: one\r\ndata: {"a":1}\r\n\n',      // 块尾 \r\n\n（匹配长度 3）
      'data: {"b":2}\n\r\n',                     // 块尾 \n\r\n（匹配长度 3）
      'data: {"c":3}\n\n'))
    expect(events).toEqual([
      'one:{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ])
  })
  it('M2：混合换行跨 chunk 分割仍正确', async () => {
    const events = await collect(stream(
      'event: mixed\r\ndata: {"x":', '1}\r\n', '\n', 'data: {"y":2}\n\n'))
    expect(events).toEqual(['mixed:{"x":1}', '{"y":2}'])
  })
})
