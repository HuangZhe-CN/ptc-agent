import type { ToolDef, ToolContext } from '../tools/registry'

export type DispatchEvent =
  | { phase: 'start'; name: string; args: unknown }
  | { phase: 'finish'; name: string; args: unknown; ok: boolean; result?: unknown; error?: string }
export interface DispatchPoolOptions { maxParallel?: number; onEvent?: (e: DispatchEvent) => void }

interface QueueItem { name: string; args: unknown; run: () => void; reject: (e: Error) => void; started: boolean }

export class DispatchPool {
  private readonly queue: QueueItem[] = []
  private readonly inflight: Promise<unknown>[] = []
  private runningExclusive = false
  private settled = false
  constructor(private readonly tools: Map<string, ToolDef>, private readonly ctx: ToolContext,
    private readonly opts: DispatchPoolOptions = {}) {}

  submit(name: string, args: unknown): Promise<unknown> {
    if (this.settled) return Promise.reject(new Error('pool settled: run_code run is over; call abandoned'))
    const tool = this.tools.get(name)
    if (!tool || typeof tool.execute !== 'function') return Promise.reject(new Error(`unknown tool ${JSON.stringify(name)}`))
    return new Promise((resolve, reject) => {
      this.queue.push({
        name, args, started: false, reject,
        run: () => {
          this.opts.onEvent?.({ phase: 'start', name, args })
          const exclusive = !tool.concurrencySafe
          const p = (async () => {
            try {
              const result = await tool.execute(args, this.ctx)
              this.opts.onEvent?.({ phase: 'finish', name, args, ok: true, result })
              resolve(result)
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error)
              this.opts.onEvent?.({ phase: 'finish', name, args, ok: false, error: message })
              reject(error instanceof Error ? error : new Error(message))
            }
          })()
          this.inflight.push(p)
          void p.finally(() => {
            this.inflight.splice(this.inflight.indexOf(p), 1)
            if (exclusive) this.runningExclusive = false // 独占在飞期间 pump 全阻塞；离场时解除
            this.pump()
          })
        },
      })
      this.pump()
    })
  }

  private pump(): void {
    while (!this.settled && !this.runningExclusive && this.inflight.length < (this.opts.maxParallel ?? 10) && this.queue.length > 0) {
      const item = this.queue[0]
      const tool = this.tools.get(item.name)!
      if (!tool.concurrencySafe) {
        if (this.inflight.length > 0) return          // 独占：排空后单独跑
        this.queue.shift(); this.runningExclusive = true
        item.run()
        // runningExclusive 保持 true 直到该项离场（finally 复位）→ 在飞期间后续 safe/exclusive 均不启动，独占成立
        continue
      }
      this.queue.shift()
      item.run()
    }
  }

  abortPending(reason: string): void {
    for (const item of this.queue) if (!item.started) item.reject(new Error(reason))
    this.queue.length = 0
  }

  async settle(): Promise<void> {
    this.settled = true
    this.abortPending('run_code run is over; calls not dispatched')
    while (this.inflight.length > 0) await Promise.allSettled([...this.inflight])
  }
}
