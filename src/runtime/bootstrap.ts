import { inspect } from 'node:util'
import type { WorkerBootData, WorkerToHost, HostToWorker } from './protocol'

export type { WorkerBootData, WorkerToHost, HostToWorker } from './protocol'

// 在模块加载时捕获全局 Error，程序内篡改 globalThis.Error 不影响 instanceof 判定
const CapturedError = Error

class LogBuffer {
  private bytes = 2
  private truncated = false
  constructor(private readonly maxBytes: number, private readonly sink: (t: string) => void,
    private readonly onLimit: () => void = () => {}) {}
  push(text: string): void {
    if (this.truncated) return
    const sep = this.bytes > 2 ? 1 : 0
    const cost = Buffer.byteLength(JSON.stringify(text))
    if (this.bytes + sep + cost > this.maxBytes) { this.truncated = true; this.onLimit(); return }
    this.bytes += sep + cost
    this.sink(text)
  }
  remaining(): number { return this.maxBytes - this.bytes }
}

const INSPECT = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 } as const

export interface BootstrapPort {
  postMessage(m: WorkerToHost): void
  on(event: 'message', l: (m: HostToWorker) => void): void
}

export class ToolCallError extends CapturedError {
  constructor(public readonly toolName: string, message: string) {
    super(message)
    this.name = 'ToolCallError'
  }
}

function losslessJson(v: unknown): unknown | undefined {
  try { return JSON.parse(JSON.stringify(v)) } catch { return undefined }
}

export async function runBootstrap(
  port: BootstrapPort, data: WorkerBootData,
  streams: { stdout: { write(c: unknown): boolean }; stderr: { write(c: unknown): boolean } },
): Promise<void> {
  const logs = new LogBuffer(data.maxOutputBytes,
    text => { port.postMessage({ type: 'log', text }) },
    () => { port.postMessage({ type: 'output-limit' }) })
  const render = (args: unknown[]) => args.map(a => typeof a === 'string' ? a : inspect(a, INSPECT)).join(' ')
  const consoleShim = Object.create(null) as Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...a: unknown[]) => void>
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) consoleShim[level] = (...a: unknown[]) => { logs.push(render(a)) }
  for (const stream of [streams.stdout, streams.stderr]) {
    const original = stream.write
    stream.write = (chunk: unknown) => { logs.push(typeof chunk === 'string' ? chunk : String(chunk)); return true }
    void original
  }

  // pending 条目携带绑定名：reply reject 时才能构造 toolName 正确的 ToolCallError
  const pending = new Map<number, { name: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  port.on('message', m => {
    const entry = pending.get(m.id)
    if (!entry) return
    pending.delete(m.id)
    if (m.ok) entry.resolve(m.value)
    else entry.reject(new ToolCallError(entry.name, m.message ?? 'binding failed'))
  })
  let nextId = 1
  const tools = Object.create(null) as Record<string, (args: unknown) => Promise<unknown>>
  for (const name of data.names) {
    Object.defineProperty(tools, name, {
      enumerable: true,
      value: (args: unknown): Promise<unknown> => {
        const detached = losslessJson(args)
        if (detached === undefined) return Promise.reject(new ToolCallError(name, 'tool arguments must be lossless JSON'))
        return new Promise((resolve, reject) => {
          const id = nextId++
          pending.set(id, { name, resolve, reject })
          port.postMessage({ type: 'call', id, name, args: detached })
        })
      },
    })
  }

  let done: WorkerToHost
  try {
    const AsyncFunction = (async () => {}).constructor as new (...a: string[]) => (...f: unknown[]) => Promise<unknown>
    const fn = new AsyncFunction('tools', 'ToolCallError', 'console', `'use strict';\n${data.code}`)
    const value = await fn(tools, ToolCallError, consoleShim)
    const json = value === undefined ? undefined : losslessJson(value)
    if (value !== undefined && json === undefined) {
      done = { type: 'done', error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } }
    } else {
      const valueBytes = json === undefined ? 0 : Buffer.byteLength(JSON.stringify(json))
      if (valueBytes > logs.remaining()) done = { type: 'done', error: { kind: 'output-limit', message: `outer output exceeded ${data.maxOutputBytes} bytes` } }
      else done = { type: 'done', ...(json === undefined ? {} : { value: json }) }
    }
  } catch (error: unknown) {
    const detail = error instanceof CapturedError ? error.stack ?? error.message : String(error)
    done = { type: 'done', error: { kind: 'exception', message: detail.slice(0, logs.remaining() > 64 ? 4096 : 64) } }
  }
  port.postMessage(done)
}
