export interface SseEvent { event?: string; data: string }

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const emitBlock = function* (block: string): Generator<SseEvent> {
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') dataLines.push(value)
      else if (field === 'event') event = value
    }
    if (dataLines.length > 0) yield { event, data: dataLines.join('\n') }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    // 事件块以空行结束；兼容 \n\n 与 \r\n\r\n
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2))
      yield* emitBlock(block)
    }
  }
  buf += decoder.decode()
  if (buf.trim()) yield* emitBlock(buf)
}
