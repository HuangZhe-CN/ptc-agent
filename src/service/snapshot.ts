import * as path from 'node:path'
import type { FileChangeSummary } from '../shared/protocol'
import { countLineDiff } from '../review/diffCount'
import { fileKindOf } from '../review/fileKind'

export interface SnapshotFs { readFile(p: string): Promise<string>; writeFile(p: string, s: string): Promise<void>; mkdir(p: string): Promise<void>; exists(p: string): Promise<boolean> }

/** 快照区管理：root = globalStorage/snapshots/<sessionId>/（fs 注入可测）。 */
export class SnapshotTracker {
  constructor(private readonly root: string, private readonly fs: SnapshotFs) {}

  /** rel 每段 encodeURIComponent 后拼到 root 下；resolve 后必须仍在 root 内，防 `..` 越界。 */
  private snapPath(rel: string): string {
    const relNorm = rel.replace(/\\/g, '/')
    const abs = path.resolve(this.root, ...relNorm.split('/').map(encodeURIComponent))
    if (!abs.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`snapshot: illegal path ${rel}`)
    return abs
  }

  /** 首次编辑前快照（已存在则跳过），并登记 manifest（ensureManifest 逻辑并入此处，见计划修正注）。 */
  async beforeEdit(rel: string, cwd: string): Promise<void> {
    const target = this.snapPath(rel)
    if (await this.fs.exists(target)) return
    const original = await this.fs.readFile(path.resolve(cwd, rel))
    await this.fs.mkdir(path.dirname(target))
    await this.fs.writeFile(target, original)
    await this.ensureManifest(rel)
  }

  /** Reject：写回快照。 */
  async restore(rel: string, cwd: string): Promise<void> {
    const original = await this.fs.readFile(this.snapPath(rel))
    await this.fs.writeFile(path.resolve(cwd, rel), original)
  }

  /** Accept：快照内容置空（已接受标记）。 */
  async drop(rel: string): Promise<void> {
    const target = this.snapPath(rel)
    if (await this.fs.exists(target)) await this.fs.writeFile(target, '')
  }

  async dropAll(): Promise<void> { /* changes() 天然过滤空快照；无需遍历删除 */ }

  /** 对比快照 vs 当前工作区文件（countLineDiff），空快照（已接受）与零差异文件不呈现。 */
  async changes(cwd: string): Promise<FileChangeSummary[]> {
    const manifestPath = path.join(this.root, 'manifest.json')
    if (!(await this.fs.exists(manifestPath))) return []
    const manifest = JSON.parse(await this.fs.readFile(manifestPath)) as string[]
    const out: FileChangeSummary[] = []
    for (const rel of manifest) {
      const target = this.snapPath(rel)
      const snap = await this.fs.readFile(target)
      if (snap === '') continue   // accepted
      let current = ''
      try { current = await this.fs.readFile(path.resolve(cwd, rel)) } catch { /* 已删除文件 */ }
      const { add, del } = countLineDiff(snap, current)
      if (add === 0 && del === 0) continue
      out.push({ path: rel.replace(/\\/g, '/'), add, del, kind: fileKindOf(rel) })
    }
    return out
  }

  /** 读取快照内容（reviewProvider 展示 original 侧用）。 */
  async readSnapshot(rel: string): Promise<string> {
    return this.fs.readFile(this.snapPath(rel))
  }

  private async ensureManifest(rel: string): Promise<void> {
    const manifestPath = path.join(this.root, 'manifest.json')
    let list: string[] = []
    if (await this.fs.exists(manifestPath)) list = JSON.parse(await this.fs.readFile(manifestPath)) as string[]
    if (!list.includes(rel)) { list.push(rel); await this.fs.writeFile(manifestPath, JSON.stringify(list)) }
  }
}
