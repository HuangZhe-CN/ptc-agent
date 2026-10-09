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
  /** 工作区文件 mtime/size 探针（changes() 的 diff 缓存键）；未提供时每轮全量重算 */
  stat?(p: string): Promise<{ mtimeMs: number; size: number } | null>
}

/** I1：新文件哨兵——编辑前文件不存在（ENOENT）时登记此值。 */
export const NEW_FILE_SNAPSHOT = '\0new'

/** Accept（drop）哨兵——置此值而非空串：空原文件的真实快照恰是 ''，用 '' 作已接受标记会让该文件的
 *  第二次编辑被误判为已接受而重定基线（原始空基线永久丢失，Reject 回不到空内容）。
 *  与 NEW_FILE_SNAPSHOT 同款 '\0' 前缀：真实文本内容不会逐字节等于哨兵，可区分。 */
export const ACCEPTED_SNAPSHOT = '\0accepted'

/** 快照区管理：root = globalStorage/snapshots/<sessionId>/（fs 注入可测）。 */
export class SnapshotTracker {
  /** I6：操作串行链——beforeEdit(内含 ensureManifest 读改写)/changes 等排队执行，杜绝并发丢登记 */
  private chain: Promise<unknown> = Promise.resolve()

  /** changes() 的 per-file diff 缓存：stat 签名（mtimeMs:size / deleted）未变则复用上次 diff 结果，
   *  免每工具轮全量重读工作区文件 + countLineDiff。drop/restore 改动快照侧内容时按 rel 失效。 */
  private diffCache = new Map<string, { sig: string; summary: FileChangeSummary | null }>()

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
   *  I1：编辑前文件不存在（新文件）→ 写 NEW_FILE_SNAPSHOT 哨兵，changes 按 countLineDiff('',content) 呈现为纯新增。
   *  Accept（drop 的哨兵标记）之后的再次编辑以当时工作区内容为新基线重新快照（见 doBeforeEdit 内注）。 */
  async beforeEdit(rel: string, cwd: string): Promise<void> {
    return this.enqueue(() => this.doBeforeEdit(rel, cwd))
  }

  private async doBeforeEdit(rel: string, cwd: string): Promise<void> {
    const target = this.snapPath(rel)
    if (await this.fs.exists(target)) {
      // drop() 写入的哨兵是『已接受』标记而非真实快照：以当前（已接受的）工作区内容为新基线重新快照，
      // 让 Accept 之后的再次编辑重新进入 changes 审查环（否则会话内永久脱管、无法 diff/Reject）。
      // 只认哨兵——空原文件的真实快照恰是 ''，以 '' 判定已接受会把该文件第二次编辑误判、覆盖原始空基线。
      // 必须同步失效 diffCache：旧 stat 签名缓存会让 doChanges 复用 accept 前的过期 diff。
      if ((await this.fs.readFile(target)) !== ACCEPTED_SNAPSHOT) return
      this.diffCache.delete(rel)
    }
    let original: string
    try {
      original = await this.fs.readFile(path.resolve(cwd, rel))
    } catch {
      original = NEW_FILE_SNAPSHOT   // 新文件：登记哨兵（区别于 drop 的已接受哨兵）
    }
    await this.fs.mkdir(path.dirname(target))
    await this.fs.writeFile(target, original)
    await this.ensureManifest(rel)
  }

  /** Reject：写回快照。新文件（哨兵）→ 删除工作区文件恢复"原不存在"状态（无 deleteFile 时降级写空串）。
   *  写回前重建父目录：编辑后目录可能已被删（如 bash 删除），否则 Reject all 中途 ENOENT、
   *  异常逃逸成 unhandled rejection 且剩余文件不还原。 */
  async restore(rel: string, cwd: string): Promise<void> {
    return this.enqueue(async () => {
      const target = this.snapPath(rel)
      const snap = await this.fs.readFile(target)
      this.diffCache.delete(rel)
      const wsAbs = path.resolve(cwd, rel)
      if (snap === NEW_FILE_SNAPSHOT) {
        // 哨兵 + 文件已随目录被删：原状态（不存在）已达成，直接视为恢复完成
        //（deleteFile 对缺失路径会抛 ENOENT，故先探存在）
        if (this.fs.deleteFile) { if (await this.fs.exists(wsAbs)) await this.fs.deleteFile(wsAbs) }
        else { await this.fs.mkdir(path.dirname(wsAbs)); await this.fs.writeFile(wsAbs, '') }
        return
      }
      await this.fs.mkdir(path.dirname(wsAbs))   // recursive 幂等：父目录在则 no-op、不在则重建
      await this.fs.writeFile(wsAbs, snap)
    })
  }

  /** Accept：快照置为已接受哨兵（不用 ''——空原文件的真实快照就是 ''，见 ACCEPTED_SNAPSHOT 注）。 */
  async drop(rel: string): Promise<void> {
    return this.enqueue(async () => {
      this.diffCache.delete(rel)
      const target = this.snapPath(rel)
      if (await this.fs.exists(target)) await this.fs.writeFile(target, ACCEPTED_SNAPSHOT)
    })
  }

  async dropAll(): Promise<void> { /* changes() 天然过滤已接受标记；无需遍历删除 */ }

  /** 对比快照 vs 当前工作区文件（countLineDiff），已接受（哨兵）与零差异文件不呈现。
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
      if (snap === '' || snap === ACCEPTED_SNAPSHOT) continue   // accepted（'' 兼容升级前以空串落盘的旧标记）
      const wsAbs = path.resolve(cwd, rel)
      // stat 签名未变 → 复用上次 diff（null 结果也缓存：零差异/已删除不重复重算）
      let sig: string | null = null
      if (this.fs.stat) {
        const st = await this.fs.stat(wsAbs).catch(() => null)
        sig = st === null ? 'deleted' : `${st.mtimeMs}:${st.size}`
      }
      const cached = sig !== null ? this.diffCache.get(rel) : undefined
      if (cached && cached.sig === sig) {
        if (cached.summary) out.push(cached.summary)
        continue
      }
      const original = snap === NEW_FILE_SNAPSHOT ? '' : snap
      let current = ''
      try { current = await this.fs.readFile(wsAbs) } catch { /* 已删除文件 */ }
      const { add, del } = countLineDiff(original, current)
      const summary = add === 0 && del === 0 ? null : { path: rel.replace(/\\/g, '/'), add, del, kind: fileKindOf(rel) }
      if (sig !== null) this.diffCache.set(rel, { sig, summary })
      if (summary) out.push(summary)
    }
    return out
  }

  /** 读取快照内容（reviewProvider 展示 original 侧用）；新文件/已接受哨兵均呈现为空
   *  （accepted 本就不在 changes 列表，此处兜底防陈旧 diff 视图露出哨兵原文）。 */
  async readSnapshot(rel: string): Promise<string> {
    const snap = await this.fs.readFile(this.snapPath(rel))
    return snap === NEW_FILE_SNAPSHOT || snap === ACCEPTED_SNAPSHOT ? '' : snap
  }

  private async ensureManifest(rel: string): Promise<void> {
    const manifestPath = path.join(this.root, 'manifest.json')
    let list: string[] = []
    if (await this.fs.exists(manifestPath)) list = JSON.parse(await this.fs.readFile(manifestPath)) as string[]
    if (!list.includes(rel)) { list.push(rel); await this.fs.writeFile(manifestPath, JSON.stringify(list)) }
  }
}
