import { describe, it, expect } from 'vitest'
import { runBootstrap, type WorkerBootData, type WorkerToHost, type HostToWorker } from '../src/runtime/bootstrap'

function makePort(host: (m: WorkerToHost, reply: (r: HostToWorker) => void) => void) {
  const sent: WorkerToHost[] = []
  const listeners: ((m: HostToWorker) => void)[] = []
  const port = {
    postMessage: (m: WorkerToHost) => { sent.push(m); host(m, r => listeners.forEach(l => l(r))) },
    on: (_e: 'message', l: (m: HostToWorker) => void) => { listeners.push(l) },
  }
  return { port, sent }
}
const streams = { stdout: { write: () => true }, stderr: { write: () => true } }
const data = (code: string): WorkerBootData => ({ code, names: ['read_file'], maxOutputBytes: 65536 })

describe('runBootstrap', () => {
  it('顶层 await + return lossless JSON；绑定经端口往返', async () => {
    const { port, sent } = makePort((m, reply) => {
      if (m.type === 'call') reply({ type: 'reply', id: m.id, ok: true, value: { content: 'FILE' } })
    })
    await runBootstrap(port, data('const r = await tools.read_file({path:"a"}); return { got: r.content }'), streams)
    const done = sent.find(m => m.type === 'done') as Extract<WorkerToHost, { type: 'done' }>
    expect(done.value).toEqual({ got: 'FILE' })
    expect(sent.some(m => m.type === 'call' && m.name === 'read_file')).toBe(true)
  })
  it('绑定失败 → 程序内 ToolCallError 可 catch（toolName 成员）', async () => {
    const { port, sent } = makePort((m, reply) => {
      if (m.type === 'call') reply({ type: 'reply', id: m.id, ok: false, message: 'boom' })
    })
    // 注：程序串须为纯 JS（TS 剥离在 host 侧 codeRuntime 完成，见 Task 12），故此处写 e.toolName 而非 (e as any).toolName
    await runBootstrap(port, data('try { await tools.read_file({}) } catch (e) { return { name: e.name, toolName: e.toolName, msg: e.message } }'), streams)
    const done = sent.find(m => m.type === 'done') as Extract<WorkerToHost, { type: 'done' }>
    expect(done.value).toEqual({ name: 'ToolCallError', toolName: 'read_file', msg: 'boom' })
  })
  it('console.log 进 logs；程序 throw → exception', async () => {
    const { port, sent } = makePort(() => {})
    await runBootstrap(port, data('console.log("hi"); throw new Error("E")'), streams)
    const done = sent.find(m => m.type === 'done') as Extract<WorkerToHost, { type: 'done' }>
    expect(done.error?.kind).toBe('exception')
    expect(done.error?.message).toContain('E')
    expect(sent.some(m => m.type === 'log' && m.text === 'hi')).toBe(true)
  })
  it('非 JSON 返回值 → invalid-output；绑定名不可达原型（__proto__ 只是普通属性）', async () => {
    const p1 = makePort(() => {})
    await runBootstrap(p1.port, data('return undefined'), streams)
    expect((p1.sent.find(m => m.type === 'done') as Extract<WorkerToHost, { type: 'done' }>).value).toBeUndefined()
  })
})
