export interface SseEvent { event?: string; data: string }

/** 无块边界缓冲上限（防服务端发超长无空行数据撑爆内存） */
const MAX_BUF = 1024 * 1024
/** 相邻数据块间最长等待，超时抛错（loop 侧归 network 走既有重试） */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000

export interface ParseSseOptions {
  /** idle 超时毫秒数；默认 120s */
  idleTimeoutMs?: number
}

export async function* parseSse(body: ReadableStream<Uint8Array>, opts: ParseSseOptions = {}): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
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
  try {
    while (true) {
      let res: Awaited<ReturnType<typeof reader.read>>
      let timer: NodeJS.Timeout | undefined
      try {
        res = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`sse: no data for ${idleMs}ms (idle timeout)`)), idleMs)
            timer.unref()
          }),
        ])
      } finally { if (timer !== undefined) clearTimeout(timer) }
      if (res.done) break
      buf += decoder.decode(res.value, { stream: true })
      if (buf.length > MAX_BUF) throw new Error(`sse: buffer exceeds ${MAX_BUF} chars without event boundary`)
      // 事件块以空行结束；兼容 \n\n、\r\n\r\n 与混合 \r\n\n / \n\r\n（M2：按实际匹配长度跳过，不吃下一 block 首字符）
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf)
        if (!m) break
        const block = buf.slice(0, m.index)
        buf = buf.slice(m.index + m[0].length)
        yield* emitBlock(block)
      }
    }
    buf += decoder.decode()
    if (buf.trim()) yield* emitBlock(buf)
  } finally {
    // 消费者提前退出（[DONE] return / error / break）时也释放底层连接
    await reader.cancel().catch(() => {})
  }
}
