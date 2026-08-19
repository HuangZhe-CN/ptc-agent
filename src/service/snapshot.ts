import * as path from 'node:path'
import type { FileChangeSummary } from '../shared/protocol'
import { countLineDiff } from '../review/diffCount'
import { fileKindOf } from '../review/fileKind'

export interface SnapshotFs {
  readFile(p: string): Promise<string>
  writeFile(p: string, s: string): Promise<void>
  mkdir(p: string): Promise<void>
  exists(p: string): Promise<boolean>
  /** I1：新文件 Reject 时删除工作区文件（原状态=不存在）；未提供时降级写空串 */
  deleteFile?(p: string): Promise<void>
}

/** I1：新文件哨兵——编辑前文件不存在（ENOENT）时登记此值；与 drop() 的空串（已接受）语义区分。 */
export const NEW_FILE_SNAPSHOT = '\0new'

/** 快照区管理：root = globalStorage/snapshots/<sessionId>/（fs 注入可测）。 */
export class SnapshotTracker {
  /** I6：操作串行链——beforeEdit(内含 ensureManifest 读改写)/changes 等排队执行，杜绝并发丢登记 */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly root: string, private readonly fs: SnapshotFs) {}

  /** 入队串行执行：前序失败不断链（吞错继续），返回值/异常透传给调用方。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** rel 每段 encodeURIComponent 后拼到 root 下；resolve 后必须仍在 root 内，防 `..` 越界。 */
  private snapPath(rel: string): string {
    const relNorm = rel.replace(/\\/g, '/')
    const abs = path.resolve(this.root, ...relNorm.split('/').map(encodeURIComponent))
    if (!abs.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`snapshot: illegal path ${rel}`)
    return abs
  }

  /** 首次编辑前快照（已存在则跳过），并登记 manifest（ensureManifest 逻辑并入此处，见计划修正注）。
   *  I1：编辑前文件不存在（新文件）→ 写 NEW_FILE_SNAPSHOT 哨兵，changes 按 countLineDiff('',content) 呈现为纯新增。 */
  async beforeEdit(rel: string, cwd: string): Promise<void> {
    return this.enqueue(() => this.doBeforeEdit(rel, cwd))
  }

  private async doBeforeEdit(rel: string, cwd: string): Promise<void> {
    const target = this.snapPath(rel)
    if (await this.fs.exists(target)) return
    let original: string
    try {
      original = await this.fs.readFile(path.resolve(cwd, rel))
    } catch {
      original = NEW_FILE_SNAPSHOT   // 新文件：登记哨兵（区别于 drop 的空串）
    }
    await this.fs.mkdir(path.dirname(target))
    await this.fs.writeFile(target, original)
    await this.ensureManifest(rel)
  }

  /** Reject：写回快照。新文件（哨兵）→ 删除工作区文件恢复"原不存在"状态（无 deleteFile 时降级写空串）。 */
  async restore(rel: string, cwd: string): Promise<void> {
    return this.enqueue(async () => {
      const target = this.snapPath(rel)
      const snap = await this.fs.readFile(target)
      if (snap === NEW_FILE_SNAPSHOT) {
        const wsPath = path.resolve(cwd, rel)
        if (this.fs.deleteFile) await this.fs.deleteFile(wsPath)
        else await this.fs.writeFile(wsPath, '')
        return
      }
      await this.fs.writeFile(path.resolve(cwd, rel), snap)
    })
  }

  /** Accept：快照内容置空（已接受标记）。 */
  async drop(rel: string): Promise<void> {
    return this.enqueue(async () => {
      const target = this.snapPath(rel)
      if (await this.fs.exists(target)) await this.fs.writeFile(target, '')
    })
  }

  async dropAll(): Promise<void> { /* changes() 天然过滤空快照；无需遍历删除 */ }

  /** 对比快照 vs 当前工作区文件（countLineDiff），空快照（已接受）与零差异文件不呈现。
   *  新文件哨兵按原内容为空参与 diff（纯 add，驱动 isNewFile）。 */
  async changes(cwd: string): Promise<FileChangeSummary[]> {
    return this.enqueue(() => this.doChanges(cwd))
  }

  private async doChanges(cwd: string): Promise<FileChangeSummary[]> {
    const manifestPath = path.join(this.root, 'manifest.json')
    if (!(await this.fs.exists(manifestPath))) return []
    const manifest = JSON.parse(await this.fs.readFile(manifestPath)) as string[]
    const out: FileChangeSummary[] = []
    for (const rel of manifest) {
      const target = this.snapPath(rel)
      const snap = await this.fs.readFile(target)
      if (snap === '') continue   // accepted
      const original = snap === NEW_FILE_SNAPSHOT ? '' : snap
      let current = ''
      try { current = await this.fs.readFile(path.resolve(cwd, rel)) } catch { /* 已删除文件 */ }
      const { add, del } = countLineDiff(original, current)
      if (add === 0 && del === 0) continue
      out.push({ path: rel.replace(/\\/g, '/'), add, del, kind: fileKindOf(rel) })
    }
    return out
  }

  /** 读取快照内容（reviewProvider 展示 original 侧用）；新文件哨兵呈现为空（original 侧空 diff）。 */
  async readSnapshot(rel: string): Promise<string> {
    const snap = await this.fs.readFile(this.snapPath(rel))
    return snap === NEW_FILE_SNAPSHOT ? '' : snap
  }

  private async ensureManifest(rel: string): Promise<void> {
    const manifestPath = path.join(this.root, 'manifest.json')
    let list: string[] = []
    if (await this.fs.exists(manifestPath)) list = JSON.parse(await this.fs.readFile(manifestPath)) as string[]
    if (!list.includes(rel)) { list.push(rel); await this.fs.writeFile(manifestPath, JSON.stringify(list)) }
  }
}
