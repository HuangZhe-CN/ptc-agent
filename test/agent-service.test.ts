import { describe, it, expect } from 'vitest'
import { AgentService } from '../src/service/agentService'
import { WebviewBridge, type PostTarget } from '../src/service/webviewBridge'
import { ConfigStore } from '../src/service/configStore'
import type { HostMessage, UiOp } from '../src/shared/protocol'

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
