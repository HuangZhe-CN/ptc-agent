import { describe, it, expect } from 'vitest'
import { mkdir, readFile, writeFile, readdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionStore } from '../src/session/store'

const deps = {
  readDir: readdir, readFile, appendFile: async (p: string, s: string) => { await writeFile(p, s, { flag: 'a' }) },
  mkdir: async (p: string) => { await mkdir(p, { recursive: true }) },
}

describe('SessionStore', () => {
  it('append → JSONL 逐行；load → 解析；list 元信息；replay 恢复 state+history', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-sess-'))
    const store = new SessionStore(root, deps)
    await store.append('s1', { kind: 'meta', meta: { sessionId: 's1', title: 'T', createdAt: 1, providerId: 'p', modelId: 'm' } })
    await store.append('s1', { kind: 'history', message: { role: 'user', text: 'hi' } })
    await store.append('s1', { kind: 'ops', ops: [{ op: 'title', title: 'T' }, { op: 'append', event: { id: 'e1', ts: 1, type: 'run', command: 'ls', status: 'done', outputTail: '' } }] })
    const records = await store.load('s1')
    expect(records).toHaveLength(3)
    const list = await store.list()
    expect(list[0].sessionId).toBe('s1')
    const replayed = store.replayToState(records, 'en')
    expect(replayed.state.title).toBe('T')
    expect(replayed.state.events[0].id).toBe('e1')
    expect(replayed.history).toEqual([{ role: 'user', text: 'hi' }])
  })
  it('titleOf 首行截断', () => {
    expect(SessionStore.titleOf('做一个非常长的任务标题'.repeat(10))).toHaveLength(48)
    expect(SessionStore.titleOf('a\nb')).toBe('a')
  })
  it('I4：torn/corrupt 行逐条跳过——好行仍可回放，单个坏行不瘫痪', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-sess-'))
    const store = new SessionStore(root, deps)
    // 直接手工拼接：好 meta 行 + 撕裂半行（进程中断写穿） + 好 ops 行 + 非 JSON 行 + JSON 但非记录行
    await deps.mkdir(root)
    const torn = [
      JSON.stringify({ kind: 'meta', meta: { sessionId: 's1', title: 'T', createdAt: 1, providerId: 'p', modelId: 'm' } }),
      '{"kind":"ops","ops":[{"op":"title","ti',   // torn：进程写入中断的半行
      JSON.stringify({ kind: 'history', message: { role: 'user', text: 'hi' } }),
      'not-json-at-all',
      '"just a string"',
      'null',
    ].join('\n') + '\n'
    await deps.appendFile(`${root}/s1.jsonl`, torn)
    const records = await store.load('s1')
    expect(records.map(r => r.kind)).toEqual(['meta', 'history'])
    const replayed = store.replayToState(records, 'en')
    expect(replayed.history).toEqual([{ role: 'user', text: 'hi' }])
  })
  it('I4：list 单文件失败隔离——坏会话文件不拖垮列表；load 读取失败返回 []', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-sess-'))
    const store = new SessionStore(root, deps)
    await store.append('good', { kind: 'meta', meta: { sessionId: 'good', title: 'Good', createdAt: 2, providerId: 'p', modelId: 'm' } })
    await deps.mkdir(root)
    // 坏文件：仅一行撕裂 meta（load 后无 meta 记录 → 不入列表，但 list 不抛）
    await deps.appendFile(`${root}/bad.jsonl`, '{"kind":"meta","meta":{"sessionId":"bad","tit')
    const list = await store.list()
    expect(list.map(m => m.sessionId)).toEqual(['good'])
    expect(await store.load('missing')).toEqual([])
  })
  it('historyReplace + replaceEvents 重放：history 整体替换为摘要、events 整体替换（/compact 重放闭环）', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-sess-'))
    const store = new SessionStore(root, deps)
    // 压缩前的旧历史与旧事件
    await store.append('s1', { kind: 'meta', meta: { sessionId: 's1', title: 'T', createdAt: 1, providerId: 'p', modelId: 'm' } })
    await store.append('s1', { kind: 'history', message: { role: 'user', text: 'hi' } })
    await store.append('s1', { kind: 'history', message: { role: 'assistant', turn: { text: 'hello' } } })
    await store.append('s1', { kind: 'ops', ops: [{ op: 'append', event: { id: 'e1', ts: 1, type: 'user', text: 'hi' } }] })
    // /compact：historyReplace 清空重填 + replaceEvents 整体替换时间线
    await store.append('s1', { kind: 'historyReplace', messages: [{ role: 'user', text: 'SUMMARY' }] })
    await store.append('s1', { kind: 'ops', ops: [{ op: 'replaceEvents', events: [{ id: 'c1', ts: 2, type: 'compact', markdown: 'SUMMARY', before: 100, after: 10 }] }] })
    // 压缩后的新轮继续追加：累积在摘要之上
    await store.append('s1', { kind: 'history', message: { role: 'user', text: 'next' } })
    const replayed = store.replayToState(await store.load('s1'), 'en')
    expect(replayed.history).toEqual([{ role: 'user', text: 'SUMMARY' }, { role: 'user', text: 'next' }])
    expect(replayed.state.events).toHaveLength(1)
    expect(replayed.state.events[0]).toMatchObject({ id: 'c1', type: 'compact' })
  })
})
