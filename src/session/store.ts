import { createHash } from 'node:crypto'
import type { UiOp, WebviewState } from '../shared/protocol'
import { applyUiOps, initialWebviewState } from '../shared/protocol'
import type { HistoryMessage } from '../protocol/types'

export interface SessionMeta { sessionId: string; title: string; createdAt: number; providerId: string; modelId: string }
export type SessionRecord =
  | { kind: 'meta'; meta: SessionMeta }
  | { kind: 'history'; message: HistoryMessage }
  | { kind: 'ops'; ops: UiOp[] }
export interface SessionStoreDeps { readDir(p: string): Promise<string[]>; readFile(p: string): Promise<string>; appendFile(p: string, s: string): Promise<void>; mkdir(p: string): Promise<void> }

export class SessionStore {
  constructor(private readonly root: string, private readonly deps: SessionStoreDeps) {}
  private file(sessionId: string): string { return `${this.root.replace(/[\\/]$/, '')}/${sessionId}.jsonl` }
  async append(sessionId: string, record: SessionRecord): Promise<void> {
    await this.deps.mkdir(this.root)
    await this.deps.appendFile(this.file(sessionId), JSON.stringify(record) + '\n')
  }
  async load(sessionId: string): Promise<SessionRecord[]> {
    let text: string
    try { text = String(await this.deps.readFile(this.file(sessionId))) } catch { return [] }
    // I4：逐行容错——撕裂/损坏行跳过，不让单个坏行瘫痪整个会话回放
    const records: SessionRecord[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as SessionRecord
        if (r && typeof r === 'object' && typeof r.kind === 'string') records.push(r)
      } catch { /* torn/corrupt line → skip */ }
    }
    return records
  }
  async list(): Promise<SessionMeta[]> {
    let files: string[]
    try { files = await this.deps.readDir(this.root) } catch { return [] }
    const metas: SessionMeta[] = []
    for (const f of files.filter(f => f.endsWith('.jsonl'))) {
      // I4：单文件失败隔离——一个坏会话文件不拖垮整个列表
      try {
        const meta = (await this.load(f.slice(0, -6))).find(r => r.kind === 'meta') as { meta: SessionMeta } | undefined
        if (meta) metas.push(meta.meta)
      } catch { /* skip unreadable session file */ }
    }
    return metas.sort((a, b) => b.createdAt - a.createdAt)
  }
  static workspaceHash(workspaceFolder: string): string { return createHash('sha1').update(workspaceFolder).digest('hex').slice(0, 12) }
  static titleOf(prompt: string): string { return prompt.split('\n')[0].trim().slice(0, 48) || 'New task' }
  replayToState(records: SessionRecord[], locale: string): { state: Pick<WebviewState, 'phase' | 'title' | 'events' | 'changes' | 'queue'>; history: HistoryMessage[] } {
    let state = initialWebviewState(locale)
    const history: HistoryMessage[] = []
    for (const r of records) {
      if (r.kind === 'ops') state = applyUiOps(state, r.ops)
      else if (r.kind === 'history') history.push(r.message)
      else state = { ...state, title: r.meta.title }
    }
    return { state: { phase: state.phase, title: state.title, events: state.events, changes: state.changes, queue: state.queue }, history }
  }
}
