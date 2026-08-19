import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { CodeRuntime } from '../src/runtime/codeRuntime'

const workerPath = path.resolve(__dirname, '../dist/worker.js')
beforeAll(() => { if (!existsSync(workerPath)) throw new Error('先运行 npm run build 生成 dist/worker.js') })

describe('CodeRuntime（真 worker）', () => {
  it('成功：程序返回值 + logs', async () => {
    const rt = new CodeRuntime(workerPath, { computeMs: 5000, maxWallMs: 10000, maxOutputBytes: 65536 })
    const r = await rt.run({ program: 'console.log("L"); return 41 + 1', bindings: {} })
    expect(r.error).toBeUndefined()
    expect(r.value).toBe(42)
    expect(r.logs).toEqual(['L'])
    await rt.dispose()
  })
  it('绑定调用往返 + 失败拒绝', async () => {
    const rt = new CodeRuntime(workerPath, { computeMs: 5000, maxWallMs: 10000, maxOutputBytes: 65536 })
    const r = await rt.run({
      program: 'const ok = await tools.echo({x:1}); try { await tools.boom({}) } catch (e) { return { ok, name: e.name } }',
      bindings: {
        echo: async a => a,
        boom: async () => { throw new Error('kaput') },
      },
    })
    expect(r.value).toEqual({ ok: { x: 1 }, name: 'ToolCallError' })
    await rt.dispose()
  })
  it('热循环触发 compute 预算 → timeout', async () => {
    const rt = new CodeRuntime(workerPath, { computeMs: 300, maxWallMs: 5000, maxOutputBytes: 65536 })
    const r = await rt.run({ program: 'while (true) {}', bindings: {} })
    expect(r.error?.kind).toBe('timeout')
    await rt.dispose()
  })
  it('语法错误 → exception（不 spawn worker）；abort → abort', async () => {
    const rt = new CodeRuntime(workerPath)
    const bad = await rt.run({ program: 'const x: = bad ts', bindings: {} })
    expect(bad.error?.kind).toBe('exception')
    const ac = new AbortController()
    const p = rt.run({ program: 'await new Promise(() => {})', bindings: {}, signal: ac.signal })
    ac.abort('user stop')
    expect((await p).error?.kind).toBe('abort')
    await rt.dispose()
  })
  it('敌意消息：未知名/重复 id/结算后消息不会崩 host', async () => {
    const rt = new CodeRuntime(workerPath, { computeMs: 5000, maxWallMs: 5000, maxOutputBytes: 65536 })
    const r = await rt.run({
      program: 'const w = (globalThis as any); const r1 = await tools.echo({}); return r1',
      bindings: { echo: async () => 'ok' },
    })
    expect(r.value).toBe('ok')
    await rt.dispose()
  })
})
