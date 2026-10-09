import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SnapshotTracker, NEW_FILE_SNAPSHOT } from '../src/service/snapshot'

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

  it('Accept 后再次编辑以已接受内容为新基线重新跟踪；restore 回滚到已接受内容（非最初快照）', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-snap-'))
    const cwd = path.join(root, 'ws'); await mkdir(cwd, { recursive: true })
    const f = 'a.js'
    await writeFile(path.join(cwd, f), 'v0\n')
    const t = new SnapshotTracker(path.join(root, 'snaps'), fs)
    await t.beforeEdit(f, cwd)                        // 快照 v0
    await writeFile(path.join(cwd, f), 'v1\n')
    await t.drop(f)                                   // Accept：快照置空串标记
    expect(await t.changes(cwd)).toEqual([])          // 已接受不呈现
    await t.beforeEdit(f, cwd)                        // 先快照再落盘（对齐 loop.ts 生产序）：此刻仍 v1，空串标记 → 重定基线（修复前当已有快照跳过 → 永久脱管）
    await writeFile(path.join(cwd, f), 'v1\nedit\n')  // turn2 再改同一文件
    expect(await t.changes(cwd)).toEqual([{ path: 'a.js', add: 1, del: 0, kind: 'js' }])
    await t.restore(f, cwd)                           // Reject：回到已接受内容 v1（而非最初 v0）
    expect(await readFile(path.join(cwd, f), 'utf8')).toBe('v1\n')
    await rm(root, { recursive: true, force: true })
  })

  it('I1：新文件 beforeEdit ENOENT → 哨兵登记 → changes 纯 add（isNewFile 驱动）；readSnapshot 呈现空原文', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-snap-'))
    const cwd = path.join(root, 'ws'); await mkdir(cwd, { recursive: true })
    const t = new SnapshotTracker(path.join(root, 'snaps'), fs)
    const f = 'created/new-file.ts'   // 编辑前不存在
    await t.beforeEdit(f, cwd)
    // 哨兵落盘（区别于 drop 的空串语义）
    expect(await t.readSnapshot(f)).toBe('')   // 对外呈现空原文（diff original 侧为空）
    await mkdir(path.dirname(path.join(cwd, f)), { recursive: true })
    await writeFile(path.join(cwd, f), 'a\nb\nc\n')
    const changes = await t.changes(cwd)
    expect(changes).toEqual([{ path: norm(f), add: 3, del: 0, kind: 'ts' }])   // 纯 add → isNewFile
    // 哨兵与空串语义区分：drop 后不再呈现
    await t.drop(f)
    expect(await t.changes(cwd)).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('I1：新文件 reject → 工作区文件删除（恢复"原不存在"）；无 deleteFile 注入时降级写空串', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-snap-'))
    const cwd = path.join(root, 'ws'); await mkdir(cwd, { recursive: true })
    const wsFile = path.join(cwd, 'n.txt')
    const fsWithDelete = { ...fs, deleteFile: async (p: string) => { await rm(p, { force: true }) } }
    const t = new SnapshotTracker(path.join(root, 'snaps'), fsWithDelete)
    await t.beforeEdit('n.txt', cwd)
    await writeFile(wsFile, 'content\n')
    await t.restore('n.txt', cwd)
    expect(await fs.exists(wsFile)).toBe(false)
    // 降级路径：无 deleteFile → 写空串（changes 随即归零差异，不再呈现）
    const t2 = new SnapshotTracker(path.join(root, 'snaps2'), fs)
    await t2.beforeEdit('n.txt', cwd)   // 此时工作区文件已被上一段删除 → 哨兵
    await writeFile(wsFile, 'x\n')
    await t2.restore('n.txt', cwd)
    expect(await readFile(wsFile, 'utf8')).toBe('')
    expect(await t2.changes(cwd)).toEqual([])
    expect(NEW_FILE_SNAPSHOT).toBe('\0new')
    await rm(root, { recursive: true, force: true })
  })

  it('restore 重建被删的父目录：Reject 不再中途 ENOENT，快照写回成功', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-snap-'))
    const cwd = path.join(root, 'ws'); await mkdir(cwd, { recursive: true })
    const f = 'sub/b.ts'
    await mkdir(path.join(cwd, 'sub'), { recursive: true })
    await writeFile(path.join(cwd, f), 'orig\n')
    const t = new SnapshotTracker(path.join(root, 'snaps'), fs)
    await t.beforeEdit(f, cwd)
    await writeFile(path.join(cwd, f), 'changed\n')
    await rm(path.join(cwd, 'sub'), { recursive: true, force: true })   // 编辑后目录整个被删（快照仍在）
    expect((await t.changes(cwd)).length).toBe(1)                       // 已删除文件按差异呈现（del 1）
    await t.restore(f, cwd)                                             // 修复前此处 writeFile 抛 ENOENT
    expect(await readFile(path.join(cwd, f), 'utf8')).toBe('orig\n')    // 父目录已重建、内容回滚
    await rm(root, { recursive: true, force: true })
  })

  it('restore 哨兵分支：文件已随目录删除时按已恢复处理（deleteFile 不抛 ENOENT）', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-snap-'))
    const cwd = path.join(root, 'ws'); await mkdir(cwd, { recursive: true })
    // 无 force：对缺失路径 rm 即抛 ENOENT（对齐宿主 fsp.rm 行为）
    const fsWithDelete = { ...fs, deleteFile: async (p: string) => { await rm(p) } }
    const t = new SnapshotTracker(path.join(root, 'snaps'), fsWithDelete)
    await t.beforeEdit('sub/n.txt', cwd)               // 编辑前不存在 → 哨兵；此后 sub 始终未被（重）建
    await t.restore('sub/n.txt', cwd)                  // 修复前 rm 缺失路径抛 ENOENT；现按已恢复处理
    expect(await fs.exists(path.join(cwd, 'sub', 'n.txt'))).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  it('I6：并发 beforeEdit（exists/readFile/writeFile 均带异步间隙）→ manifest 两次登记不丢（promise 链串行化）', async () => {
    const tick = async (): Promise<void> => { await new Promise(r => setTimeout(r, 0)) }
    const files = new Map<string, string>()
    const slowFs = {
      readFile: async (p: string) => { await tick(); if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p)! },
      writeFile: async (p: string, s: string) => { await tick(); files.set(p, s) },
      mkdir: async (_p: string) => { await tick() },
      exists: async (p: string) => { await tick(); return files.has(p) },
    }
    const root = path.join(await mkdtemp(path.join(tmpdir(), 'ptc-snap-')), 'snaps')
    const cwd = path.join(path.dirname(root), 'ws')
    const t = new SnapshotTracker(root, slowFs)
    // 未串行化时：两个 beforeEdit 在彼此 ensureManifest 写回前都读到旧 manifest → 后写覆盖前写（丢一条登记）
    await Promise.all([t.beforeEdit('a.js', cwd), t.beforeEdit('b.js', cwd)])
    const manifest = JSON.parse(files.get(path.join(root, 'manifest.json'))!) as string[]
    expect(manifest.filter(x => x === 'a.js')).toHaveLength(1)
    expect(manifest.filter(x => x === 'b.js')).toHaveLength(1)
    // 快照体各自落盘（a/b 均 ENOENT → 新文件哨兵）
    expect(files.get(path.join(root, 'a.js'))).toBe(NEW_FILE_SNAPSHOT)
    expect(files.get(path.join(root, 'b.js'))).toBe(NEW_FILE_SNAPSHOT)
    await rm(path.dirname(root), { recursive: true, force: true })
  })
})
