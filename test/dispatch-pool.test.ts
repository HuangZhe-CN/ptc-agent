import { describe, it, expect } from 'vitest'
import { DispatchPool } from '../src/runtime/dispatchPool'
import type { ToolDef } from '../src/tools/registry'

const tool = (name: string, concurrencySafe: boolean, ms: number, result = name): ToolDef => ({
  name, concurrencySafe,
  execute: async () => { await new Promise(r => setTimeout(r, ms)); return result },
})
const events: string[] = []
const pool = (tools: ToolDef[]) => new DispatchPool(new Map(tools.map(t => [t.name, t])),
  { cwd: process.cwd(), signal: new AbortController().signal },
  { maxParallel: 10, onEvent: e => events.push(`${e.phase}:${e.name}`) })

describe('DispatchPool', () => {
  it('safe 工具并行重叠（并发计数峰值 > 1），独占工具排空后单独执行', async () => {
    let inflight = 0, peak = 0
    const track = (t: ToolDef): ToolDef => ({ ...t, execute: async (a, c) => {
      inflight++; peak = Math.max(peak, inflight)
      const r = await t.execute(a, c); inflight--; return r } })
    const p = pool([track(tool('read', true, 50)), track(tool('write', false, 10))])
    await Promise.all([p.submit('read', {}), p.submit('read', {}), p.submit('read', {})])
    expect(peak).toBe(3)
    await p.submit('write', {})
    await p.settle()
  })
  it('提交顺序：先提交的先启动', async () => {
    const order: string[] = []
    const t = (n: string): ToolDef => ({ name: n, concurrencySafe: true, execute: async () => { order.push(n); return n } })
    const p = pool([t('a'), t('b'), t('c')])
    await Promise.all([p.submit('c', {}), p.submit('a', {}), p.submit('b', {})])
    expect(order).toEqual(['c', 'a', 'b'])
    await p.settle()
  })
  it('onEvent 双相（start/finish）且 finish 带结果或错误', async () => {
    const p = pool([{ name: 'ok', concurrencySafe: true, execute: async () => 'R' },
      { name: 'bad', concurrencySafe: true, execute: async () => { throw new Error('E') } }])
    await expect(p.submit('bad', {})).rejects.toThrow('E')
    await p.submit('ok', {})
    await p.settle()
    expect(events).toContain('start:ok'); expect(events).toContain('start:bad')
  })
  it('未知工具 throw；settle 后 submit throw', async () => {
    const p = pool([tool('read', true, 1)])
    await expect(p.submit('nope', {})).rejects.toThrow(/unknown/)
    await p.settle()
    await expect(p.submit('read', {})).rejects.toThrow(/settled/)
  })
  it('原始值 args 触发工具异常：promise 正常 reject（不挂起）——onEvent 在 catch 内抛错也不阻断 reject', async () => {
    const seen: unknown[] = []
    const t: ToolDef = { name: 'read', concurrencySafe: true, execute: async a => { seen.push(a); throw new Error('bad args') } }
    const p = new DispatchPool(new Map([[t.name, t]]), { cwd: process.cwd(), signal: new AbortController().signal },
      { maxParallel: 5, onEvent: e => { if (e.phase === 'finish') throw new Error('mapper exploded') } })   // 映射层抛错模拟 mapDispatchEvent 对异常 args 的 TypeError
    await expect(p.submit('read', null)).rejects.toThrow('bad args')
    expect(seen).toEqual([null])
    await p.settle()
  })
  it('onEvent 回调抛错不阻断结算：finish 后 promise 照常 resolve', async () => {
    const t: ToolDef = { name: 'ok', concurrencySafe: true, execute: async () => 'R' }
    const p = new DispatchPool(new Map([[t.name, t]]), { cwd: process.cwd(), signal: new AbortController().signal },
      { maxParallel: 5, onEvent: () => { throw new Error('mapper exploded') } })
    await expect(p.submit('ok', {})).resolves.toBe('R')
    await p.settle()
  })
})
