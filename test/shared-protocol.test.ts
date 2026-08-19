import { describe, it, expect } from 'vitest'
import type { UiOp, TimelineEvent } from '../src/shared/protocol'
import { applyUiOps, initialWebviewState } from '../src/shared/protocol'

const ev = (id: string, over: Partial<TimelineEvent>): TimelineEvent =>
  ({ id, ts: 1, type: 'thought', status: 'running', startedAt: 0, markdown: '', working: '', ...over } as TimelineEvent)

describe('applyUiOps', () => {
  it('append + patch 按 id 原位更新', () => {
    let s = initialWebviewState('en')
    s = applyUiOps(s, [{ op: 'append', event: ev('t1', { type: 'thought', markdown: 'a' }) }])
    s = applyUiOps(s, [{ op: 'patch', id: 't1', patch: { markdown: 'ab' } as never }])
    expect(s.events[0].id).toBe('t1')
    expect((s.events[0] as { markdown: string }).markdown).toBe('ab')
    expect(s.events).toHaveLength(1)   // patch 不追加
  })
  it('clear 清空时间线', () => {
    let s = applyUiOps(initialWebviewState('en'), [{ op: 'append', event: ev('t1', {}) }, { op: 'clear' }])
    expect(s.events).toHaveLength(0)
  })
  it('I5：remove 按 id 移除单个事件（其余保留；未知 id 无害）', () => {
    let s = initialWebviewState('en')
    s = applyUiOps(s, [
      { op: 'append', event: ev('t1', {}) },
      { op: 'append', event: ev('c1', { type: 'completion', markdown: 'par' } as never) },
      { op: 'append', event: ev('t2', {}) },
    ])
    s = applyUiOps(s, [{ op: 'remove', id: 'c1' }, { op: 'remove', id: 'nope' }])
    expect(s.events.map(e => e.id)).toEqual(['t1', 't2'])
  })
})
