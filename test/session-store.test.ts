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
})
