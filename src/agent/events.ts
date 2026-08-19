import type { UiOp } from '../shared/protocol'
import { fileKindOf } from '../review/fileKind'
import type { DispatchEvent } from '../runtime/dispatchPool'

export type Emit = (ops: UiOp[]) => void

/** DispatchEvent → UiOp：read/glob/grep→explore；write/edit→edit（diff 计数在结果里）；bash→run。
 * eventId 由调用方按同一次 submit 的 start/finish 复用（correlation），diff 计数经 edits 注入。 */
export function mapDispatchEvent(e: DispatchEvent, eventId: string, edits: Map<string, { add: number; del: number }>): UiOp[] {
  if (e.phase === 'start') {
    if (e.name === 'bash')
      return [{ op: 'append', event: { id: eventId, ts: Date.now(), type: 'run', command: (e.args as { command?: string }).command ?? '', status: 'running', outputTail: '' } }]
    return []   // explore/edit 在 finish 时一次性呈现（start 静默，避免行闪烁；见规格 §5.2 start/finish 双相）
  }
  // finish
  if (e.name === 'bash') {
    const r = (e.result ?? { exitCode: -1 }) as { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean }
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').slice(-8).join('\n').trim()
    return [{ op: 'patch', id: eventId, patch: { status: (!e.ok || (r.exitCode ?? 0) !== 0 || r.timedOut) ? 'error' : 'done', outputTail: tail } as never }]
  }
  if (e.name === 'write_file' || e.name === 'edit_file') {
    const a = e.args as { path: string }
    const d = edits.get(eventId) ?? { add: 0, del: 0 }
    return [{ op: 'append', event: { id: eventId, ts: Date.now(), type: 'edit', file: a.path.replace(/\\/g, '/'), fileKind: fileKindOf(a.path), add: d.add, del: d.del } }]
  }
  // read/glob/grep → explore（聚合 count）
  const targets = exploreTargets(e.name, e.args, e.result)
  return [{ op: 'append', event: { id: eventId, ts: Date.now(), type: 'explore', status: 'done', count: targets.length, targets } }]
}

function exploreTargets(name: string, args: unknown, result: unknown): string[] {
  const a = args as { path?: string; pattern?: string; query?: string }
  const r = result as { matches?: unknown[] } | undefined
  if (name === 'read_file') return [a.path ?? '']
  if (name === 'glob') return ((r?.matches ?? []) as string[])
  if (name === 'grep') return [...new Set(((r?.matches ?? []) as { file: string }[]).map(m => m.file))]
  return []
}
