import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SnapshotTracker } from '../src/service/snapshot'

const fs = {
  readFile: (p: string) => readFile(p, 'utf8'),
  writeFile: (p: string, s: string) => writeFile(p, s, 'utf8'),
  mkdir: (p: string) => mkdir(p, { recursive: true }),
  exists: async (p: string) => { try { await readFile(p); return true } catch { return false } },
}
const norm = (p: string) => p.replace(/\\/g, '/')

describe('SnapshotTracker', () => {
  it('首次编辑前快照；再编辑不覆盖；restore 回滚；drop 清除；changes 汇总', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-snap-'))
    const cwd = path.join(root, 'ws'); await mkdir(cwd, { recursive: true })
    const f = 'src/a.js'
    await mkdir(path.dirname(path.join(cwd, f)), { recursive: true })   // 微调：writeFile 不建父目录
    await writeFile(path.join(cwd, f), 'one\ntwo\n')
    const t = new SnapshotTracker(path.join(root, 'snaps'), fs)
    await t.beforeEdit(f, cwd)                       // 快照 v0
    await writeFile(path.join(cwd, f), 'one\nX\nthree\n')
    await t.beforeEdit(f, cwd)                       // 已有快照，跳过
    expect((await t.changes(cwd))[0]).toMatchObject({ path: norm(f), add: 2, del: 1 })
    await t.restore(f, cwd)
    expect(await readFile(path.join(cwd, f), 'utf8')).toBe('one\ntwo\n')
    await t.drop(f)
    expect(await t.changes(cwd)).toEqual([])
    await rm(root, { recursive: true, force: true })
  })
})
