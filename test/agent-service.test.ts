import { describe, it, expect } from 'vitest'
import { AgentService } from '../src/service/agentService'
import { WebviewBridge, type PostTarget } from '../src/service/webviewBridge'
import { ConfigStore } from '../src/service/configStore'
import type { HostMessage } from '../src/shared/protocol'

const memorySecrets = () => {
  const m = new Map<string, string>()
  return { store: async (k: string, v: string) => { m.set(k, v) }, get: async (k: string) => m.get(k), delete: async (k: string) => { m.delete(k) } }
}
const memoryMemento = () => {
  const m = new Map<string, unknown>()
  return { get: <T,>(k: string, d?: T) => (m.has(k) ? m.get(k) as T : d), update: async (k: string, v: unknown) => { m.set(k, v) } }
}

describe('AgentService', () => {
  it('running 时 submit 入队；loop 结束后自动 drain 下一条', async () => {
    const sent: HostMessage[] = []
    const listeners: Array<(m: unknown) => void> = []
    const disposable = { dispose: () => undefined }
    const target: PostTarget = {
      postMessage: async (m: unknown) => { sent.push(m as HostMessage); return true },
      onDidReceiveMessage: (l: (m: unknown) => void) => { listeners.push(l); return disposable },
      onDidDispose: (_cb: () => void) => disposable,
    }
    const bridge = new WebviewBridge(target)
    bridge.attach(target)
    const api = {
      workspaceFolders: () => 'E:\\ws', globalStoragePath: () => 'E:\\gs', envLanguage: () => 'en',
      fs: { readDir: async () => [], readFile: async () => { throw new Error('nf') }, appendFile: async () => {}, mkdir: async () => {}, writeFile: async () => {} },
      openDiff: async () => {},
    }
    const svc = new AgentService({ config: new ConfigStore(memorySecrets(), memoryMemento()), api: api as never, bridge, workerPath: 'x' })

    // 真实接线：bridge.onMessage 注册 handler；消息经 attach 注册的 listener（webview → host）驱动
    const handled: Promise<void>[] = []
    bridge.onMessage(m => { handled.push(svc.handleWebviewMessage(m)) })
    bridge.onReady(() => { handled.push(svc.bootSnapshot()) })
    listeners[0]({ type: 'ready' })
    await handled[0]   // ready → bootSnapshot
    expect(sent.some(s => s.type === 'snapshot')).toBe(true)

    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [{ id: 'p1', label: 'P', protocol: 'openai', baseUrl: 'https://x', models: [{ id: 'm1', label: 'm1', supportsThinking: false }] }], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    // 第一轮 hang 住（loopFactory 覆盖点：公开属性，测试直接赋值），直到放行
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    svc.loopFactory = () => gate.then(() => 'completed')

    const base = handled.length
    listeners[0]({ type: 'submit', text: 'first' })      // → runTurn（挂起在 gate）
    listeners[0]({ type: 'submit', text: 'queued-1' })   // running → 入队
    const firstTurn = handled[base]!
    const queuedTurn = handled[base + 1]!
    await queuedTurn
    const queueOps = sent.filter(s => s.type === 'ops').flatMap(s => (s as { ops: { op: string }[] }).ops)
    expect(queueOps.some(o => o.op === 'queue')).toBe(true)
    release()
    await firstTurn
    await new Promise(r => setTimeout(r, 20))   // drain 微任务
    // 队列清空
    const after = sent.filter(s => s.type === 'ops').flatMap(s => (s as { ops: { op: string }[] }).ops)
    const lastQueue = [...after].reverse().find(o => o.op === 'queue') as unknown as { queue: unknown[] }
    expect(lastQueue.queue).toEqual([])
  })
})
