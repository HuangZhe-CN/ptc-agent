import { Worker } from 'node:worker_threads'
import { stripTypeScriptTypes } from 'node:module'
import type { Readable } from 'node:stream'
import type { WorkerBootData, WorkerToHost, HostToWorker } from './protocol'

export type CodeRunFailure = { kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit'; message: string }
export interface CodeRunResult { logs: string[]; value?: unknown; error?: CodeRunFailure }
export interface RuntimeConfig { computeMs?: number; maxWallMs?: number; maxOutputBytes?: number; maxOldGenerationSizeMb?: number }
export interface RunOptions { program: string; bindings: Record<string, (args: unknown) => Promise<unknown>>; signal?: AbortSignal; onLog?: (text: string) => void }

const DEFAULTS = { computeMs: 60_000, maxWallMs: 600_000, maxOutputBytes: 67_108_864, maxOldGenerationSizeMb: 512 }
const STRIP_WRAP = { prefix: 'async function __ptc_program__() {\n', suffix: '\n}' }
const ELU_POLL_MS = 25

/** 敌意对端：逐字段重建，垃圾静默丢弃 */
function parseWorkerMessage(raw: unknown): WorkerToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const m = raw as Record<string, unknown>
  switch (m.type) {
    case 'call':
      return typeof m.id === 'number' && typeof m.name === 'string'
        ? { type: 'call', id: m.id, name: m.name, args: m.args } : undefined
    case 'log': return typeof m.text === 'string' ? { type: 'log', text: m.text } : undefined
    case 'output-limit': return { type: 'output-limit' }
    case 'done': {
      if (m.error === undefined) return { type: 'done', ...(m.value !== undefined ? { value: m.value } : {}) }
      const e = m.error as Record<string, unknown>
      const kind = e.kind
      if ((kind === 'exception' || kind === 'invalid-output' || kind === 'output-limit') && typeof e.message === 'string')
        return { type: 'done', error: { kind, message: e.message } }
      return undefined
    }
    default: return undefined
  }
}

function drainPipes(s: Readable): Promise<void> {
  if (s.readableEnded || s.destroyed) return Promise.resolve()
  return new Promise(res => {
    const done = () => res()
    s.once('end', done); s.once('close', done); s.once('error', done)
    s.resume()   // paused 流在 worker 内 write 被拦截、无数据流动时，terminate 后不会自行触发 end/close
  })
}

export class CodeRuntime {
  private readonly cfg: Required<RuntimeConfig>
  private readonly live = new Set<{ settle(f: CodeRunFailure): void; finished: Promise<void> }>()
  private disposed = false
  constructor(private readonly workerPath: string, config: RuntimeConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config }
    for (const [k, v] of Object.entries(this.cfg)) if (!(Number.isFinite(v) && v > 0)) throw new Error(`config.${k} must be positive`)
  }

  async run(opts: RunOptions): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('runtime disposed')
    let code: string
    try {
      const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + opts.program + STRIP_WRAP.suffix)
      code = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length)
    } catch (error: unknown) {
      return { logs: [], error: { kind: 'exception', message: error instanceof Error ? error.message : String(error) } }
    }
    if (opts.signal?.aborted) return { logs: [], error: { kind: 'abort', message: String(opts.signal.reason) } }
    return this.execute(code, opts)
  }

  private execute(code: string, opts: RunOptions): Promise<CodeRunResult> {
    const names = Object.keys(opts.bindings)
    const boot: WorkerBootData = { code, names, maxOutputBytes: this.cfg.maxOutputBytes }
    const worker = new Worker(this.workerPath, {
      workerData: boot, env: {}, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: this.cfg.maxOldGenerationSizeMb },
      stdout: true, stderr: true,
    })
    return new Promise(resolve => {
      let settled = false
      const answered = new Set<number>()
      const logs: string[] = []
      let bytes = 2
      let resolveFinished: (() => void) | undefined
      const charge = (text: string): boolean => {
        const sep = logs.length > 0 ? 1 : 0
        const cost = Buffer.byteLength(JSON.stringify(text))
        if (bytes + sep + cost > this.cfg.maxOutputBytes) return false
        bytes += sep + cost; return true
      }
      const finish = (make: () => CodeRunResult): void => {
        if (settled) return
        settled = true
        clearInterval(eluTimer); clearTimeout(wallTimer)
        opts.signal?.removeEventListener('abort', onAbort)
        this.live.delete(live)
        void (async () => {
          await new Promise<void>(r => setImmediate(r))   // 让已排队管道字节送达
          const pipes = [worker.stdout, worker.stderr].map(drainPipes)
          await Promise.all([worker.terminate(), ...pipes])
          resolve(make())
          resolveFinished?.()
        })()
      }
      const reply = (payload: HostToWorker): void => { if (!settled) worker.postMessage(payload) }
      worker.on('message', (raw: unknown) => {
        const m = parseWorkerMessage(raw)
        if (!m) return
        if (m.type === 'log') {
          opts.onLog?.(m.text)
          if (!settled && !charge(m.text)) {
            finish(() => ({ logs, error: { kind: 'output-limit', message: `outer output exceeded ${this.cfg.maxOutputBytes} bytes` } }))
          } else if (!settled) logs.push(m.text)
          return
        }
        if (m.type === 'output-limit' && !settled) {
          finish(() => ({ logs, error: { kind: 'output-limit', message: `outer output exceeded ${this.cfg.maxOutputBytes} bytes` } })); return
        }
        if (m.type === 'call') {
          if (settled || answered.has(m.id)) return
          answered.add(m.id)
          const fn = Object.hasOwn(opts.bindings, m.name) ? opts.bindings[m.name] : undefined
          if (typeof fn !== 'function') { reply({ type: 'reply', id: m.id, ok: false, message: `unknown binding ${JSON.stringify(m.name)}` }); return }
          void (async () => {
            try { reply({ type: 'reply', id: m.id, ok: true, value: JSON.parse(JSON.stringify(await fn(m.args))) }) }
            catch (error: unknown) { reply({ type: 'reply', id: m.id, ok: false, message: error instanceof Error ? error.message : String(error) }) }
          })()
          return
        }
        if (m.type === 'done') {
          if (m.error) { finish(() => ({ logs, error: m.error! })); return }
          if (m.value === undefined) { finish(() => ({ logs })); return }
          let v: unknown
          try { v = JSON.parse(JSON.stringify(m.value)) }   // host 侧再验 lossless
          catch { v = undefined }
          finish(() => v === undefined ? { logs, error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } } : { logs, value: v })
        }
      })
      worker.on('error', e => finish(() => ({ logs, error: { kind: 'worker-exit', message: `worker error: ${e.message}` } })))
      worker.on('exit', codeExit => finish(() => ({ logs, error: { kind: 'worker-exit', message: `worker exited with code ${codeExit} before completing` } })))
      const eluTimer = setInterval(() => {
        if (worker.performance.eventLoopUtilization().active > this.cfg.computeMs)
          finish(() => ({ logs, error: { kind: 'timeout', message: `compute budget exhausted (${this.cfg.computeMs}ms busy)` } }))
      }, ELU_POLL_MS)
      const wallTimer = setTimeout(() =>
        finish(() => ({ logs, error: { kind: 'timeout', message: `wall-clock ceiling reached (${this.cfg.maxWallMs}ms)` } })), this.cfg.maxWallMs)
      const onAbort = () => finish(() => ({ logs, error: { kind: 'abort', message: String(opts.signal?.reason) } }))
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      const live = {
        settle: (f: CodeRunFailure) => finish(() => ({ logs, error: f })),
        finished: new Promise<void>(r => { resolveFinished = r }),   // finish 的清理段完成时 resolve；dispose 等它
      }
      this.live.add(live)
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    for (const r of runs) r.settle({ kind: 'abort', message: 'runtime disposed' })
    await Promise.all(runs.map(r => r.finished))
  }
}
