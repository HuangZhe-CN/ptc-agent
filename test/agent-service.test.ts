import { describe, it, expect, vi } from 'vitest'
import { AgentService } from '../src/service/agentService'
import { WebviewBridge, type PostTarget } from '../src/service/webviewBridge'
import { ConfigStore } from '../src/service/configStore'
import type { HostMessage, UiOp } from '../src/shared/protocol'

// openai 适配器注入假流：/compact 端到端用例走真实 defaultLoop/defaultCompact（其余用例 loopFactory 覆盖，不受影响）。
// gate 挂起流以构造 running 窗口；signal 已中止时抛异常模拟 fetch abort（loop 归为 aborted 收尾）。
const oaiMock = vi.hoisted(() => ({
  reqs: [] as Array<{ system: string; history: Array<{ role: string; text: string }>; signal: AbortSignal }>,
  gate: null as null | { promise: Promise<void>; resolve: () => void },
}))
vi.mock('../src/protocol/openai', () => ({
  openaiAdapter: {
    protocol: 'openai',
    stream: async function* (req: { system: string; history: Array<{ role: string; text: string }>; signal: AbortSignal }) {
      oaiMock.reqs.push(req)
      if (oaiMock.gate) await oaiMock.gate.promise
      if (req.signal.aborted) throw new Error('Request was aborted')
      if (req.system.startsWith('You are a conversation compactor')) {
        yield { type: 'text_delta' as const, text: '- Goal: ship the widget\n- Decided: keep dark mode' }
      } else {
        const last = req.history[req.history.length - 1]
        yield { type: 'text_delta' as const, text: `reply-to:${last ? last.text : ''}` }
      }
      yield { type: 'message_done' as const, stopReason: 'end_turn' as const }
    },
  },
}))

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

  it('用户消息上屏：直发与队列出队都 emit user 事件且先于 assistant 事件；JSONL 持久化、重放还原', async () => {
    const sent: HostMessage[] = []
    const listeners: Array<(m: unknown) => void> = []
    const disposable = { dispose: () => undefined }
    const files = new Map<string, string>()   // 内存 JSONL 文件库：appendFile 落盘、openSession 回放读取
    const target: PostTarget = {
      postMessage: async (m: unknown) => { sent.push(m as HostMessage); return true },
      onDidReceiveMessage: (l: (m: unknown) => void) => { listeners.push(l); return disposable },
      onDidDispose: (_cb: () => void) => disposable,
    }
    const bridge = new WebviewBridge(target)
    bridge.attach(target)
    const api = {
      workspaceFolders: () => 'E:\\ws', globalStoragePath: () => 'E:\\gs', envLanguage: () => 'en',
      fs: {
        readDir: async () => [...files.keys()].map(p => p.split(/[\\/]/).pop()!),
        readFile: async (p: string) => { const c = files.get(p); if (c === undefined) throw new Error('nf'); return c },
        appendFile: async (p: string, s: string) => { files.set(p, (files.get(p) ?? '') + s) },
        mkdir: async () => {}, writeFile: async () => {}, deleteFile: async () => {},
      },
      openDiff: async () => {},
    }
    const svc = new AgentService({ config: new ConfigStore(memorySecrets(), memoryMemento()), api: api as never, bridge, workerPath: 'x' })
    listeners[0]({ type: 'ready' })   // 桥握手：flush outbox，此后 ops 直发进 sent
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [{ id: 'p1', label: 'P', protocol: 'openai', baseUrl: 'https://x', models: [{ id: 'm1', label: 'm1', supportsThinking: false }] }], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    // 收集 helper：已推送 ops 中 append 事件的 (type, text) 序列
    const appended = (): Array<{ type: string; text?: string }> => {
      const out: Array<{ type: string; text?: string }> = []
      for (const s of sent) if (s.type === 'ops') for (const o of s.ops)
        if (o.op === 'append') out.push(o.event.type === 'user' ? { type: o.event.type, text: o.event.text } : { type: o.event.type })
      return out
    }

    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    svc.loopFactory = () => gate.then(() => 'completed')

    const first = svc.handleWebviewMessage({ type: 'submit', text: 'first' })
    await new Promise(r => setTimeout(r, 20))   // 等 runTurn 建立隐式会话并 emit user(first)
    await svc.handleWebviewMessage({ type: 'submit', text: 'queued-1' })   // running → 入队，不提前上屏
    expect(appended()).toEqual([{ type: 'user', text: 'first' }])   // 本轮唯一 append 事件即 user——先于一切 assistant 事件

    release()
    await first
    await new Promise(r => setTimeout(r, 20))   // drain：queued-1 出队执行再 emit user
    expect(appended()).toEqual([{ type: 'user', text: 'first' }, { type: 'user', text: 'queued-1' }])

    // JSONL 持久化 + openSession 重放还原用户气泡
    await svc.bootSnapshot()
    const sid = svc.getLastSnapshotForTest()!.sessionId
    expect(sid).toBeTruthy()
    await svc.handleWebviewMessage({ type: 'openSession', sessionId: sid })
    const replayedUsers = svc.getLastSnapshotForTest()!.events
      .filter(e => e.type === 'user').map(e => (e as { text: string }).text)
    expect(replayedUsers).toEqual(['first', 'queued-1'])
  })

  it('submit 携带图片：直发/队列出队/queueSubmitNow 三路径 user 事件与 loop 均收到 images', async () => {
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
    listeners[0]({ type: 'ready' })
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [{ id: 'p1', label: 'P', protocol: 'openai', baseUrl: 'https://x', models: [{ id: 'm1', label: 'm1', supportsThinking: false }] }], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    const img = { mime: 'image/png', base64: 'AAEC' }
    const loopArgs: Array<{ text: string; images?: { mime: string; base64: string }[] }> = []
    const userEvents = (): Array<{ text?: string; images?: unknown[] }> =>
      sent.filter(s => s.type === 'ops').flatMap(s => (s as { ops: { op: string; event?: { type: string; text?: string; images?: unknown[] } }[] }).ops)
        .filter(o => o.op === 'append' && o.event?.type === 'user')
        .map(o => ({ text: o.event!.text, images: o.event!.images }))

    // 阶段一（completed drain）：直发带图 + running 入队带图 → drain 出队同样带图
    let release!: () => void
    const gate1 = new Promise<void>(r => { release = r })
    svc.loopFactory = (text, _provider, _signal, images) => { loopArgs.push({ text, images }); return gate1.then(() => 'completed') }
    const first = svc.handleWebviewMessage({ type: 'submit', text: 'direct', images: [img] })
    await new Promise(r => setTimeout(r, 20))
    expect(userEvents()).toEqual([{ text: 'direct', images: [img] }])   // 直发：user 事件立即带图上屏
    await svc.handleWebviewMessage({ type: 'submit', text: 'queued', images: [img] })   // running → 入队
    const queueOps = sent.filter(s => s.type === 'ops').flatMap(s => (s as { ops: { op: string; queue?: { text: string; images?: unknown[] }[] }[] }).ops)
    const lastQueue = [...queueOps].reverse().find(o => o.op === 'queue')
    expect(lastQueue!.queue![0]).toMatchObject({ text: 'queued', images: [img] })   // 队列项携带图片
    release()
    await first
    await new Promise(r => setTimeout(r, 20))   // drain
    expect(userEvents()).toHaveLength(2)
    expect(userEvents()[1]).toEqual({ text: 'queued', images: [img] })

    // 阶段二（aborted 不 drain，队列保留）：queueSubmitNow 携图正常执行
    const gate2 = new Promise<void>(r => { release = r })
    svc.loopFactory = (text, _provider, _signal, images) => { loopArgs.push({ text, images }); return gate2.then(() => 'aborted') }
    const second = svc.handleWebviewMessage({ type: 'submit', text: 'aborted-turn' })
    await new Promise(r => setTimeout(r, 20))
    await svc.handleWebviewMessage({ type: 'submit', text: 'pending-now', images: [img] })   // 入队（不随 abort drain）
    release()
    await second
    const queueNow = [...sent.filter(s => s.type === 'ops').flatMap(s => (s as { ops: { op: string; queue?: { id: string }[] }[] }).ops)].reverse().find(o => o.op === 'queue')
    const pendingId = queueNow!.queue![0]!.id
    const gate3 = new Promise<void>(r => { release = r })
    svc.loopFactory = (text, _provider, _signal, images) => { loopArgs.push({ text, images }); return gate3.then(() => 'completed') }
    const third = svc.handleWebviewMessage({ type: 'queueSubmitNow', id: pendingId })
    await new Promise(r => setTimeout(r, 20))
    expect(userEvents()).toHaveLength(4)   // direct/queued/aborted-turn + queueSubmitNow 的 pending-now
    expect(userEvents()[3]).toEqual({ text: 'pending-now', images: [img] })   // queueSubmitNow：带图上屏
    release()
    await third
    expect(loopArgs).toEqual([
      { text: 'direct', images: [img] },
      { text: 'queued', images: [img] },
      { text: 'aborted-turn', images: undefined },
      { text: 'pending-now', images: [img] },
    ])   // loopFactory 全程收到透传的 images；无图消息 images 保持 undefined
  })

  it('无 provider 提交：用户气泡先上屏、随后 error 事件且 phase=idle；会话落盘可重放（配置异常不吞用户输入）', async () => {
    const sent: HostMessage[] = []
    const listeners: Array<(m: unknown) => void> = []
    const disposable = { dispose: () => undefined }
    let appendCalls = 0
    const target: PostTarget = {
      postMessage: async (m: unknown) => { sent.push(m as HostMessage); return true },
      onDidReceiveMessage: (l: (m: unknown) => void) => { listeners.push(l); return disposable },
      onDidDispose: (_cb: () => void) => disposable,
    }
    const bridge = new WebviewBridge(target)
    bridge.attach(target)
    const api = {
      workspaceFolders: () => 'E:\\ws', globalStoragePath: () => 'E:\\gs', envLanguage: () => 'en',
      fs: { readDir: async () => [], readFile: async () => { throw new Error('nf') }, appendFile: async () => { appendCalls++ }, mkdir: async () => {}, writeFile: async () => {} },
      openDiff: async () => {},
    }
    const svc = new AgentService({ config: new ConfigStore(memorySecrets(), memoryMemento()), api: api as never, bridge, workerPath: 'x' })
    const handled: Promise<void>[] = []
    bridge.onMessage(m => { handled.push(svc.handleWebviewMessage(m)) })
    bridge.onReady(() => { handled.push(svc.bootSnapshot()) })
    listeners[0]({ type: 'ready' })
    await handled[0]   // ready → bootSnapshot

    // 不配置任何 provider 直接提交：气泡不吞、错误可见
    const base = handled.length
    listeners[0]({ type: 'submit', text: 'no-provider-yet' })
    await handled[base]!
    const ops = sent.filter(s => s.type === 'ops').flatMap(s => (s as { ops: UiOp[] }).ops)
    const appends = ops.filter(o => o.op === 'append').map(o => (o as { event: { type: string } }).event.type)
    expect(appends).toEqual(['user', 'error'])   // 气泡先上屏，随后错误事件
    expect(ops.some(o => o.op === 'phase' && (o as { phase: string }).phase === 'idle')).toBe(true)
    // 会话已隐式建立且 JSONL 落盘（重放还原气泡的前提）
    expect(appendCalls).toBeGreaterThan(0)
    await svc.bootSnapshot()
    const snap = svc.getLastSnapshotForTest()
    expect(snap?.sessionId).not.toBeNull()
    expect(snap?.events.map(e => e.type)).toEqual(['user', 'error'])
  })

  it('I3：运行中 newSession/openSession 被守卫拒绝（不切换、不清时间线）；结束后恢复可用', async () => {
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
      fs: { readDir: async () => [], readFile: async () => { throw new Error('nf') }, appendFile: async () => {}, mkdir: async () => {}, writeFile: async () => {}, deleteFile: async () => {} },
      openDiff: async () => {},
    }
    const svc = new AgentService({ config: new ConfigStore(memorySecrets(), memoryMemento()), api: api as never, bridge, workerPath: 'x' })
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [{ id: 'p1', label: 'P', protocol: 'openai', baseUrl: 'https://x', models: [{ id: 'm1', label: 'm1', supportsThinking: false }] }], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    // 挂起一轮提交（phase=running 期间发起切换）
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    svc.loopFactory = () => gate.then(() => 'completed')
    const turn = svc.handleWebviewMessage({ type: 'submit', text: 'first' })
    await new Promise(r => setTimeout(r, 20))   // 等 runTurn 建立隐式会话并进入 running
    await svc.bootSnapshot()
    const runningSid = svc.getLastSnapshotForTest()!.sessionId
    expect(runningSid).toBeTruthy()

    const sentBefore = sent.length
    // 运行中：newSession 与 openSession 均拒绝——无 clear、无新 snapshot（sessionId 不变）
    await svc.handleWebviewMessage({ type: 'newSession' })
    await svc.handleWebviewMessage({ type: 'openSession', sessionId: 'other-session' })
    expect(sent.length).toBe(sentBefore)
    await svc.bootSnapshot()
    expect(svc.getLastSnapshotForTest()!.sessionId).toBe(runningSid)

    release()
    await turn
    // 结束后：newSession 生效——切换到新会话（clear 归约 + 新 sessionId）
    await svc.handleWebviewMessage({ type: 'newSession' })
    const finalState = svc.getLastSnapshotForTest()!
    expect(finalState.sessionId).not.toBe(runningSid)
    expect(finalState.events).toEqual([])
  })
})

describe('AgentService.queueSubmitNow 运行中止立即发 & /compact', () => {
  const openaiProvider = { id: 'p1', label: 'P', protocol: 'openai' as const, baseUrl: 'https://x', models: [{ id: 'm1', label: 'm1', supportsThinking: false }] }

  /** 公共夹具：内存 JSONL 文件库 + 真实桥握手（ready → isReady），ops/事件提取 helpers。 */
  const setup = () => {
    const sent: HostMessage[] = []
    const listeners: Array<(m: unknown) => void> = []
    const disposable = { dispose: () => undefined }
    const files = new Map<string, string>()
    const target: PostTarget = {
      postMessage: async (m: unknown) => { sent.push(m as HostMessage); return true },
      onDidReceiveMessage: (l: (m: unknown) => void) => { listeners.push(l); return disposable },
      onDidDispose: (_cb: () => void) => disposable,
    }
    const bridge = new WebviewBridge(target)
    bridge.attach(target)
    const api = {
      workspaceFolders: () => 'E:\\ws', globalStoragePath: () => 'E:\\gs', envLanguage: () => 'en',
      fs: {
        readDir: async () => [...files.keys()].map(p => p.split(/[\\/]/).pop()!),
        readFile: async (p: string) => { const c = files.get(p); if (c === undefined) throw new Error('nf'); return c },
        appendFile: async (p: string, s: string) => { files.set(p, (files.get(p) ?? '') + s) },
        mkdir: async () => {}, writeFile: async () => {}, deleteFile: async () => {},
      },
      openDiff: async () => {},
    }
    const svc = new AgentService({ config: new ConfigStore(memorySecrets(), memoryMemento()), api: api as never, bridge, workerPath: 'x' })
    bridge.onMessage(m => { void svc.handleWebviewMessage(m) })
    listeners[0]({ type: 'ready' })   // 桥内部消化 → isReady，此后 ops 直发 sent
    return { svc, sent, files, api }
  }
  const opsOf = (sent: HostMessage[]): UiOp[] => sent.filter(s => s.type === 'ops').flatMap(s => (s as { ops: UiOp[] }).ops)
  const lastQueueOp = (sent: HostMessage[]): { queue: Array<{ id: string; text: string }> } =>
    [...opsOf(sent)].reverse().find(o => o.op === 'queue') as unknown as { queue: Array<{ id: string; text: string }> }
  const userTexts = (sent: HostMessage[]): string[] =>
    opsOf(sent).filter(o => o.op === 'append' && (o as { event: { type: string } }).event.type === 'user')
      .map(o => (o as { event: { text: string } }).event.text)
  const lastErrorMessage = (sent: HostMessage[]): string => {
    const errs = opsOf(sent).filter(o => o.op === 'append' && (o as { event: { type: string } }).event.type === 'error')
    return (errs[errs.length - 1] as unknown as { event: { message: string } }).event.message
  }

  it('运行中立即发送：中止当前轮并立即发送该条，全程无并发轮次；剩余队列保留并在新轮完成后按序自动发', async () => {
    const { svc, sent } = setup()
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [openaiProvider], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    const turns: Array<{ text: string; signal: AbortSignal; resolve: (o: 'completed' | 'aborted' | 'error') => void }> = []
    svc.loopFactory = (text, _p, signal) => new Promise(resolve => {
      turns.push({ text, signal, resolve: resolve as (o: 'completed' | 'aborted' | 'error') => void })
    })

    const first = svc.handleWebviewMessage({ type: 'submit', text: 'first' })
    await new Promise(r => setTimeout(r, 20))
    await svc.handleWebviewMessage({ type: 'submit', text: 'q1' })
    await svc.handleWebviewMessage({ type: 'submit', text: 'q2' })
    const q1id = lastQueueOp(sent).queue[0].id   // 队列 [q1, q2] 的队首

    const now = svc.handleWebviewMessage({ type: 'queueSubmitNow', id: q1id })
    await new Promise(r => setTimeout(r, 20))
    expect(turns[0].signal.aborted).toBe(true)      // 当前轮被中止
    expect(turns).toHaveLength(1)                    // 收尾前不起新轮（严禁并发）
    turns[0].resolve('aborted')
    await new Promise(r => setTimeout(r, 20))
    expect(turns.map(t => t.text)).toEqual(['first', 'q1'])   // 该条立即作为新轮串行发出
    expect(userTexts(sent)).toEqual(['first', 'q1'])
    expect(lastQueueOp(sent).queue.map(q => q.text)).toEqual(['q2'])   // 被中止轮不 drain，q2 保留

    turns[1].resolve('completed')
    await new Promise(r => setTimeout(r, 20))
    expect(turns.map(t => t.text)).toEqual(['first', 'q1', 'q2'])   // q2 按序自动发
    turns[2].resolve('completed')
    await now   // now 的 turnPromise 覆盖含 q2 drain 在内的整条递归链
    expect(lastQueueOp(sent).queue).toEqual([])
    await first
  })

  it('/compact 端到端：无工具请求生成摘要、history 整体替换、时间线 replaceEvents+compact 事件、队列保留、重放一致、后续轮携带摘要', async () => {
    const { svc, sent } = setup()
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [openaiProvider], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })
    oaiMock.reqs.length = 0

    // ① 挂起一轮（真实 defaultLoop 走 mock adapter gate）并入队一条
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    oaiMock.gate = { promise: gate, resolve: release }
    const first = svc.handleWebviewMessage({ type: 'submit', text: 'first' })
    await new Promise(r => setTimeout(r, 20))
    await svc.handleWebviewMessage({ type: 'submit', text: 'keep' })
    // ② stop 中止：mock 检测 aborted 抛异常 → loop aborted 收尾，队列保留
    await svc.handleWebviewMessage({ type: 'stop' })
    release()
    await first
    await new Promise(r => setTimeout(r, 20))
    oaiMock.gate = null
    expect(lastQueueOp(sent).queue.map(q => q.text)).toEqual(['keep'])

    // ③ /compact：真实 defaultCompact 经 mock adapter 出摘要
    await svc.handleWebviewMessage({ type: 'slashCommand', command: 'compact' })

    // 压缩请求形状：压缩 system 指令 + 单条 user 转录（含此前 user 消息原文）
    const creq = oaiMock.reqs[oaiMock.reqs.length - 1]
    expect(creq.system.startsWith('You are a conversation compactor')).toBe(true)
    expect(creq.history).toHaveLength(1)
    expect(creq.history[0].text).toContain('[user] first')

    // getHistory 被替换为摘要（单条 user，preamble + 摘要正文）
    const hist = svc.getHistoryForTest()
    expect(hist).toHaveLength(1)
    expect(hist[0].role).toBe('user')
    expect((hist[0] as { text: string }).text).toContain('Conversation compacted')
    expect((hist[0] as { text: string }).text).toContain('Goal: ship the widget')

    // 时间线整体替换为单个 compact 事件（含前后规模对比），队列不受影响
    await svc.bootSnapshot()
    const mem = svc.getLastSnapshotForTest()!
    expect(mem.events).toHaveLength(1)
    expect(mem.events[0].type).toBe('compact')
    expect((mem.events[0] as { markdown: string }).markdown).toContain('Goal: ship the widget')
    expect((mem.events[0] as { before: number; after: number }).before).toBeGreaterThan(0)   // 压缩前历史字符规模
    expect((mem.events[0] as { after: number }).after).toBeGreaterThan(0)                    // 压缩后规模（玩具历史下不强行断言缩小）
    expect(mem.queue.map(q => q.text)).toEqual(['keep'])

    // JSONL 持久化：openSession 重放与内存态一致（events 与 history 双双还原为压缩后结果）
    const sid = mem.sessionId!
    await svc.handleWebviewMessage({ type: 'openSession', sessionId: sid })
    const replay = svc.getLastSnapshotForTest()!
    expect(replay.events).toEqual(mem.events)
    expect(svc.getHistoryForTest()).toEqual(hist)

    // 后续轮对话连贯：LLM 请求 history 首条即摘要（不再是旧历史）
    await svc.handleWebviewMessage({ type: 'submit', text: 'next' })
    // await 覆盖整条递归链：next 轮 3 条 + drain 队列 keep 轮 2 条 = 5
    expect(svc.getHistoryForTest()).toHaveLength(5)
    expect(svc.getHistoryForTest()[0]).toEqual(hist[0])   // 首条仍是压缩摘要
    const nextReq = oaiMock.reqs[oaiMock.reqs.length - 1]
    expect(nextReq.system.startsWith('You are a conversation compactor')).toBe(false)
    expect(nextReq.history[0].text).toContain('Goal: ship the widget')
  })

  it('/compact 反馈边界：无会话/空历史可见反馈；运行中拒绝且不执行压缩；失败原 history 不动且可重试', async () => {
    const { svc, sent } = setup()
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [openaiProvider], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    // 无会话 + 空历史：可见 error 反馈，不崩溃、无 replaceEvents
    await svc.handleWebviewMessage({ type: 'slashCommand', command: 'compact' })
    expect(lastErrorMessage(sent)).toContain('Nothing to compact')
    expect(opsOf(sent).some(o => o.op === 'replaceEvents')).toBe(false)

    // 运行中：拒绝执行压缩（不调 compactFactory）
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    svc.loopFactory = () => gate.then((): 'completed' => 'completed')
    const run = svc.handleWebviewMessage({ type: 'submit', text: 'running-turn' })
    await new Promise(r => setTimeout(r, 20))
    let compactRan = false
    svc.compactFactory = async () => { compactRan = true; return 'NOPE' }
    await svc.handleWebviewMessage({ type: 'slashCommand', command: 'compact' })
    expect(compactRan).toBe(false)
    expect(lastErrorMessage(sent)).toContain('Cannot compact')
    release()
    await run

    // 失败路径：原 history 原样保留，只上屏 error
    ;(svc as unknown as { history: unknown[] }).history.push({ role: 'user', text: 'h1' }, { role: 'assistant', turn: { text: 'a1' } })
    svc.compactFactory = async () => { throw new Error('boom') }
    await svc.handleWebviewMessage({ type: 'slashCommand', command: 'compact' })
    expect(lastErrorMessage(sent)).toContain('Compact failed: boom')
    expect(svc.getHistoryForTest()).toHaveLength(2)
    expect(opsOf(sent).some(o => o.op === 'replaceEvents')).toBe(false)

    // 重试成功：history 替换为摘要
    svc.compactFactory = async () => '- retry ok'
    await svc.handleWebviewMessage({ type: 'slashCommand', command: 'compact' })
    const hist = svc.getHistoryForTest()
    expect(hist).toHaveLength(1)
    expect((hist[0] as { text: string }).text).toContain('retry ok')
    expect(opsOf(sent).some(o => o.op === 'replaceEvents')).toBe(true)
  })

  it('F1 交叉：压缩进行中 queueSubmitNow 不中止压缩也不并发起轮，压缩落地后该条立即出队起轮', async () => {
    const { svc, sent } = setup()
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [openaiProvider], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    const turns: Array<{ text: string; signal: AbortSignal; resolve: (o: 'completed' | 'aborted' | 'error') => void }> = []
    svc.loopFactory = (text, _p, signal) => new Promise(resolve => {
      turns.push({ text, signal, resolve: resolve as (o: 'completed' | 'aborted' | 'error') => void })
    })
    // 造空闲 + 队列非空：挂起轮 stop 中止（aborted 不 drain）
    const first = svc.handleWebviewMessage({ type: 'submit', text: 'x' })
    await new Promise(r => setTimeout(r, 20))
    await svc.handleWebviewMessage({ type: 'submit', text: 'pending' })
    await svc.handleWebviewMessage({ type: 'stop' })
    turns[0].resolve('aborted')
    await first
    await new Promise(r => setTimeout(r, 20))
    const pendingId = lastQueueOp(sent).queue[0].id
    // 历史非白板（压缩前置条件）
    ;(svc as unknown as { history: unknown[] }).history.push({ role: 'user', text: 'h1' })

    // 压缩挂起在飞
    let compactRelease!: (v?: string) => void
    const compactGate = new Promise<string>(r => { compactRelease = (v) => r(v ?? 'COMPACT-SUMMARY') })
    let compactSignal!: AbortSignal
    svc.compactFactory = (_h, _p, signal) => { compactSignal = signal; return compactGate }
    const cp = svc.handleWebviewMessage({ type: 'slashCommand', command: 'compact' })
    await new Promise(r => setTimeout(r, 20))
    expect(compactSignal).toBeDefined()
    expect(compactSignal.aborted).toBe(false)

    // 压缩进行中点击立即发送：不得中止压缩、不得并发起轮
    const now = svc.handleWebviewMessage({ type: 'queueSubmitNow', id: pendingId })
    await new Promise(r => setTimeout(r, 20))
    expect(compactSignal.aborted).toBe(false)   // F1：压缩未被误中止
    expect(turns.map(t => t.text)).toEqual(['x'])   // F1：未并发起轮

    // 压缩落地：queueSubmitNow 随即把该条立即作为新轮发出
    compactRelease()
    await cp
    await new Promise(r => setTimeout(r, 20))
    expect(turns.map(t => t.text)).toEqual(['x', 'pending'])
    turns[1].resolve('completed')
    await now
    // 终态：history 已替换为摘要，队列清空
    const hist = svc.getHistoryForTest()
    expect(hist).toHaveLength(1)
    expect((hist[0] as { text: string }).text).toContain('COMPACT-SUMMARY')
    expect(lastQueueOp(sent).queue).toEqual([])
  })

  it('F3：queueSubmitNow 等收尾期间条目被 queueEdit——按重取的最新内容出队起轮', async () => {
    const { svc, sent } = setup()
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [openaiProvider], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    const turns: Array<{ text: string; signal: AbortSignal; resolve: (o: 'completed' | 'aborted' | 'error') => void }> = []
    svc.loopFactory = (text, _p, signal) => new Promise(resolve => {
      turns.push({ text, signal, resolve: resolve as (o: 'completed' | 'aborted' | 'error') => void })
    })
    const first = svc.handleWebviewMessage({ type: 'submit', text: 'x' })
    await new Promise(r => setTimeout(r, 20))
    await svc.handleWebviewMessage({ type: 'submit', text: 'q1' })
    const qid = [...opsOf(sent)].reverse().find(o => o.op === 'queue')!.queue[0].id

    const now = svc.handleWebviewMessage({ type: 'queueSubmitNow', id: qid })   // 同步 abort 后挂起等收尾
    await svc.handleWebviewMessage({ type: 'queueEdit', id: qid, text: 'EDITED-TEXT' })   // 收尾窗口内编辑
    turns[0].resolve('aborted')
    await new Promise(r => setTimeout(r, 20))
    expect(turns.map(t => t.text)).toEqual(['x', 'EDITED-TEXT'])   // F3：用 fresh 内容（非 await 前的旧快照）起轮
    turns[1].resolve('completed')
    await now
  })

  it('F4：compact 成功路径先落盘 historyReplace 再 emit——JSONL 行序确定', async () => {
    const { svc, files } = setup()
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [openaiProvider], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })
    svc.loopFactory = () => Promise.resolve('completed' as const)
    await svc.handleWebviewMessage({ type: 'submit', text: 'setup' })   // 建立隐式会话
    ;(svc as unknown as { history: unknown[] }).history.push({ role: 'user', text: 'h1' })

    svc.compactFactory = async () => 'SUMMARY-OK'
    await svc.handleWebviewMessage({ type: 'slashCommand', command: 'compact' })

    const sid = (svc as unknown as { sessionId: string }).sessionId
    const jsonl = [...files.entries()].find(([p]) => p.endsWith(`${sid}.jsonl`))![1]
    const kinds = jsonl.split('\n').filter(l => l.trim()).map(l => {
      const r = JSON.parse(l) as { kind: string; ops?: Array<{ op: string }> }
      return r.kind === 'ops' ? `ops:${r.ops!.map(o => o.op).join('+')}` : r.kind
    })
    const hr = kinds.indexOf('historyReplace')
    const re = kinds.findIndex(k => typeof k === 'string' && k.startsWith('ops:') && k.includes('replaceEvents'))
    expect(hr).toBeGreaterThanOrEqual(0)
    expect(re).toBeGreaterThan(hr)   // historyReplace 行先于 replaceEvents ops 行（重放行序确定）
    expect(kinds[re]).toBe('ops:replaceEvents+phase')   // 同批 emit：时间线整体替换与 phase 恢复同记录
  })

  it('F5：原轮在飞连点两条立即发送——continuation 串行起轮不并发，第二条保留队列按序 drain', async () => {
    const { svc, sent } = setup()
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [openaiProvider], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    const turns: Array<{ text: string; signal: AbortSignal; resolve: (o: 'completed' | 'aborted' | 'error') => void }> = []
    svc.loopFactory = (text, _p, signal) => new Promise(resolve => {
      turns.push({ text, signal, resolve: resolve as (o: 'completed' | 'aborted' | 'error') => void })
    })
    const first = svc.handleWebviewMessage({ type: 'submit', text: 'R' })
    await new Promise(r => setTimeout(r, 20))
    await svc.handleWebviewMessage({ type: 'submit', text: 'A' })
    await svc.handleWebviewMessage({ type: 'submit', text: 'B' })
    const q = lastQueueOp(sent).queue
    const aid = q[0].id
    const bid = q[1].id

    // 连点两条立即发送：两个 continuation 挂在同一个在飞收尾上
    const nowA = svc.handleWebviewMessage({ type: 'queueSubmitNow', id: aid })
    const nowB = svc.handleWebviewMessage({ type: 'queueSubmitNow', id: bid })
    await new Promise(r => setTimeout(r, 20))
    expect(turns[0].signal.aborted).toBe(true)
    turns[0].resolve('aborted')
    await new Promise(r => setTimeout(r, 20))
    // 首个 continuation 起轮 A；第二个被 F5 在飞守卫挡回，B 保留队列（不并发）
    expect(turns.map(t => t.text)).toEqual(['R', 'A'])
    expect(lastQueueOp(sent).queue.map(q2 => q2.text)).toEqual(['B'])

    turns[1].resolve('completed')
    await new Promise(r => setTimeout(r, 20))
    expect(turns.map(t => t.text)).toEqual(['R', 'A', 'B'])   // A 完成后 drain 按序自动发 B
    turns[2].resolve('completed')
    await nowA
    await nowB
    expect(lastQueueOp(sent).queue).toEqual([])
    await first
  })

  it('F6：queueSubmitNow 等收尾期间 queueDelete 该条——收尾后不出队不起轮、无异常', async () => {
    const { svc, sent } = setup()
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [openaiProvider], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    const turns: Array<{ text: string; signal: AbortSignal; resolve: (o: 'completed' | 'aborted' | 'error') => void }> = []
    svc.loopFactory = (text, _p, signal) => new Promise(resolve => {
      turns.push({ text, signal, resolve: resolve as (o: 'completed' | 'aborted' | 'error') => void })
    })
    const first = svc.handleWebviewMessage({ type: 'submit', text: 'x' })
    await new Promise(r => setTimeout(r, 20))
    await svc.handleWebviewMessage({ type: 'submit', text: 'q1' })
    const qid = lastQueueOp(sent).queue[0].id

    const now = svc.handleWebviewMessage({ type: 'queueSubmitNow', id: qid })   // 同步 abort 后挂起等收尾
    await svc.handleWebviewMessage({ type: 'queueDelete', id: qid })   // 收尾窗口内删除该条
    turns[0].resolve('aborted')
    await now   // fresh find 落空 → 直接返回，无异常
    expect(turns.map(t => t.text)).toEqual(['x'])   // 不起轮
    expect(lastQueueOp(sent).queue).toEqual([])   // 队列为空（该条已被删除）
    await first
  })

  it('F7：historyReplace 落盘失败——replaceEvents 之后上屏可见错误，内存压缩行为不变', async () => {
    const { svc, sent, api } = setup()
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [openaiProvider], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })
    svc.loopFactory = () => Promise.resolve('completed' as const)
    await svc.handleWebviewMessage({ type: 'submit', text: 'setup' })
    ;(svc as unknown as { history: unknown[] }).history.push({ role: 'user', text: 'h1' })

    api.fs.appendFile = async () => { throw new Error('disk full') }   // 压缩期间所有落盘失败
    svc.compactFactory = async () => 'SUMMARY-F7'
    await svc.handleWebviewMessage({ type: 'slashCommand', command: 'compact' })

    // error 事件在 replaceEvents 之后（否则会被时间线整体替换冲掉）
    const ops = opsOf(sent)
    const reIdx = ops.findIndex(o => o.op === 'replaceEvents')
    const errIdx = ops.findIndex((o, i) => i > reIdx && o.op === 'append'
      && (o as { event: { message: string } }).event.message.includes('compact persist failed'))
    expect(reIdx).toBeGreaterThanOrEqual(0)
    expect(errIdx).toBeGreaterThan(reIdx)
    expect((ops[errIdx] as { event: { message: string } }).event.message).toContain('disk full')
    // 内存/时间线压缩行为不变：history 已替换为摘要，compact 事件已上屏
    const hist = svc.getHistoryForTest()
    expect(hist).toHaveLength(1)
    expect((hist[0] as { text: string }).text).toContain('SUMMARY-F7')
    const snapOps = ops.filter(o => o.op === 'replaceEvents')
    expect((snapOps[0] as { events: Array<{ type: string; markdown: string }> }).events[0].markdown).toBe('SUMMARY-F7')
  })

  it('压缩期间 submit 的消息入队后自动续发（对齐 submit-during-turn 契约）；压缩前已在队列的条目不被压缩顺带发出', async () => {
    const { svc, sent } = setup()
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [openaiProvider], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    const turns: Array<{ text: string; resolve: (o: 'completed' | 'aborted' | 'error') => void }> = []
    svc.loopFactory = text => new Promise(resolve => { turns.push({ text, resolve: resolve as (o: 'completed' | 'aborted' | 'error') => void }) })

    // 压缩前队列已有条目：挂起轮 stop 中止（aborted 不 drain，队列保留）
    const first = svc.handleWebviewMessage({ type: 'submit', text: 'x' })
    await new Promise(r => setTimeout(r, 20))
    await svc.handleWebviewMessage({ type: 'submit', text: 'keep' })
    await svc.handleWebviewMessage({ type: 'stop' })
    turns[0].resolve('aborted')
    await first
    await new Promise(r => setTimeout(r, 20))
    ;(svc as unknown as { history: unknown[] }).history.push({ role: 'user', text: 'h1' })   // 压缩前置：历史非空

    // 压缩挂起在飞
    let compactRelease!: () => void
    const compactGate = new Promise<string>(r => { compactRelease = () => r('COMPACT-SUMMARY') })
    svc.compactFactory = () => compactGate
    const cp = svc.handleWebviewMessage({ type: 'slashCommand', command: 'compact' })
    await new Promise(r => setTimeout(r, 20))

    // 压缩期间 submit：入队（修复前会永远滞留队列，只能手动「立即发送」）
    await svc.handleWebviewMessage({ type: 'submit', text: 'during-compact' })
    expect(lastQueueOp(sent).queue.map(q => q.text)).toEqual(['keep', 'during-compact'])
    expect(turns.map(t => t.text)).toEqual(['x'])   // 压缩在飞不并发起轮

    // 压缩落地：during-compact 自动作为新轮发出；keep（压缩前入队）保留
    compactRelease()
    await new Promise(r => setTimeout(r, 20))
    expect(turns.map(t => t.text)).toEqual(['x', 'during-compact'])
    expect(lastQueueOp(sent).queue.map(q => q.text)).toEqual(['keep'])
    expect(svc.getHistoryForTest()).toHaveLength(1)   // 压缩成功：历史已替换为摘要

    // during-compact 轮完成后按常规 drain 契约接续发出 keep
    turns[1].resolve('completed')
    await new Promise(r => setTimeout(r, 20))
    expect(turns.map(t => t.text)).toEqual(['x', 'during-compact', 'keep'])
    turns[2].resolve('completed')
    await cp
    expect(lastQueueOp(sent).queue).toEqual([])
  })

  it('JSONL 追加串行化：同窗口背靠背 emit 的落盘行序等于调用序（慢先快后不颠倒）', async () => {
    const { svc, files, api } = setup()
    // 不配置 provider：runTurn 内 emit(user) 后紧跟 emit(error)——两次 fire-and-forget append 同窗口在飞
    api.fs.appendFile = async (p: string, s: string) => {
      if (s.includes('SLOW-USER')) await new Promise(r => setTimeout(r, 25))   // 人为让首个 append 慢于后续
      files.set(p, (files.get(p) ?? '') + s)
    }
    await svc.handleWebviewMessage({ type: 'submit', text: 'SLOW-USER' })
    await new Promise(r => setTimeout(r, 100))   // 等 fire-and-forget 链收尾
    const sid = (svc as unknown as { sessionId: string }).sessionId
    const jsonl = [...files.entries()].find(([p]) => p.endsWith(`${sid}.jsonl`))![1]
    const opsLines = jsonl.split('\n').filter(l => l.includes('"kind":"ops"'))
    expect(opsLines[0]).toContain('SLOW-USER')                    // user 行先落盘 = 调用序
    expect(opsLines[1]).toContain('No provider/model selected')   // error 行在后（无串行化时慢行被快行反超，重放时间线错乱）
  })

  it('排队消息起轮时按当前协议重滤附件：运行中切到 Gemini 后 drain 的 GIF 不进请求与时间线；纯图全滤上屏错误不起空轮', async () => {
    const { svc, sent } = setup()
    const geminiProvider = { id: 'g1', label: 'G', protocol: 'gemini' as const, baseUrl: 'https://g', models: [{ id: 'm1', label: 'm1', supportsThinking: false }] }
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [openaiProvider, geminiProvider], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })

    const loopArgs: Array<{ text: string; images?: unknown[] }> = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    svc.loopFactory = (text, _p, _s, images) => { loopArgs.push({ text, images }); return gate.then(() => 'completed') }

    const gif = { mime: 'image/gif', base64: 'R0lG' }
    const first = svc.handleWebviewMessage({ type: 'submit', text: 'first' })
    await new Promise(r => setTimeout(r, 20))
    await svc.handleWebviewMessage({ type: 'submit', text: 'gif-msg', images: [gif] })   // openai 下合法 → 入队
    await svc.handleWebviewMessage({ type: 'selectModel', active: { providerId: 'g1', modelId: 'm1', quality: 'low' } })   // 运行中切到 Gemini
    release()
    await first   // 覆盖整条 drain 链
    expect(loopArgs.map(a => a.text)).toEqual(['first', 'gif-msg'])
    expect(loopArgs[1].images).toStrictEqual([])   // GIF 被当前协议滤掉：请求不带图（修复前原样转发 → Gemini 400 整轮失败）
    const userEvents = opsOf(sent).filter(o => o.op === 'append' && (o as { event: { type: string } }).event.type === 'user')
    expect((userEvents[1] as { event: { images?: unknown[] } }).event.images).toBeUndefined()   // 时间线 user 事件与实际请求一致

    // 纯图消息全被当前协议滤掉：不起空轮，上屏可见错误（镜像 webview doSubmit 的拒绝行为）
    await svc.handleWebviewMessage({ type: 'submit', text: '', images: [gif] })
    expect(loopArgs).toHaveLength(2)   // 未起轮
    expect(lastErrorMessage(sent)).toContain('dropped')
  })
})

describe('AgentService.workbenchAction', () => {
  /** 最小夹具：记录命令调用与本地提示；输入框返回值用例内可控（api 对象动态取，构造后改属性仍生效）。 */
  const setup = () => {
    const calls: Array<{ command: string; args: unknown[] }> = []
    const infos: string[] = []
    let inputResult: string | undefined
    const bridge = new WebviewBridge({ postMessage: async () => true })
    const api = {
      workspaceFolders: () => 'E:\\ws', globalStoragePath: () => 'E:\\gs', envLanguage: () => 'en',
      fs: { readDir: async () => [], readFile: async () => { throw new Error('nf') }, appendFile: async () => {}, mkdir: async () => {}, writeFile: async () => {} },
      openDiff: async () => {},
      executeCommand: async (command: string, ...args: unknown[]) => { calls.push({ command, args }) },
      showInputBox: async () => inputResult,
      showInfoMessage: async (msg: string) => { infos.push(msg) },
      openSimpleBrowser: async (url: string) => { calls.push({ command: 'simpleBrowser.api.open', args: [url] }) },
    }
    const svc = new AgentService({ config: new ConfigStore(memorySecrets(), memoryMemento()), api: api as never, bridge, workerPath: 'x' })
    return { svc, calls, infos, api, setInput: (v: string | undefined) => { inputResult = v } }
  }

  it('四个命令 action 触发硬编码白名单命令；openBrowser 输入 URL 交 openSimpleBrowser', async () => {
    const { svc, calls, setInput } = setup()
    await svc.handleWebviewMessage({ type: 'workbenchAction', action: 'focusExplorer' })
    await svc.handleWebviewMessage({ type: 'workbenchAction', action: 'focusTerminal' })
    await svc.handleWebviewMessage({ type: 'workbenchAction', action: 'openFolder' })
    await svc.handleWebviewMessage({ type: 'workbenchAction', action: 'toggleSidebar' })
    expect(calls.map(c => c.command)).toEqual([
      'workbench.view.explorer',
      'workbench.action.terminal.focus',
      'workbench.action.files.openFolder',
      'workbench.action.toggleSidebarVisibility',
    ])
    calls.length = 0
    setInput('https://example.com')
    await svc.handleWebviewMessage({ type: 'workbenchAction', action: 'openBrowser' })
    expect(calls).toEqual([{ command: 'simpleBrowser.api.open', args: ['https://example.com'] }])
  })

  it('openBrowser：取消或空白输入不执行任何命令、不提示', async () => {
    const { svc, calls, infos, setInput } = setup()
    setInput(undefined)   // 用户取消
    await svc.handleWebviewMessage({ type: 'workbenchAction', action: 'openBrowser' })
    expect(calls).toEqual([])
    expect(infos).toEqual([])
    setInput('   ')   // 纯空白：trim 后视为取消
    await svc.handleWebviewMessage({ type: 'workbenchAction', action: 'openBrowser' })
    expect(calls).toEqual([])
    expect(infos).toEqual([])
  })

  it('executeCommand/openSimpleBrowser reject：降级 showInfoMessage 且不向外抛出', async () => {
    const { svc, infos, api, setInput } = setup()
    api.executeCommand = async () => { throw new Error('command not found') }
    await expect(svc.handleWebviewMessage({ type: 'workbenchAction', action: 'focusExplorer' })).resolves.toBeUndefined()
    expect(infos).toEqual(['Unable to run action: focusExplorer'])

    api.openSimpleBrowser = async () => { throw new Error('no simple browser') }
    setInput('https://example.com')
    await expect(svc.handleWebviewMessage({ type: 'workbenchAction', action: 'openBrowser' })).resolves.toBeUndefined()
    expect(infos).toEqual(['Unable to run action: focusExplorer', 'Unable to open browser'])
  })
})
