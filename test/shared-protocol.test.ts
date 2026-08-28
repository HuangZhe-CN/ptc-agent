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
  it('user 事件 append 保留原文与换行，且位于 assistant 事件之前（重放还原用户气泡）', () => {
    let s = initialWebviewState('en')
    s = applyUiOps(s, [
      { op: 'append', event: { id: 'u1', ts: 1, type: 'user', text: '你好\n第二行' } },
      { op: 'append', event: ev('t1', {}) },
    ])
    const u = s.events[0] as Extract<TimelineEvent, { type: 'user' }>
    expect(u.type).toBe('user')
    expect(u.text).toBe('你好\n第二行')   // 换行原样保留，webview pre-wrap 才有意义
    expect(s.events.map(e => e.id)).toEqual(['u1', 't1'])   // user 在前、assistant 在后
  })
  it('user 事件 images 原样随事件保留（气泡缩略图重放还原）；无图事件不含 images 字段', () => {
    const images = [{ mime: 'image/png', base64: 'AAEC' }]
    let s = initialWebviewState('en')
    s = applyUiOps(s, [
      { op: 'append', event: { id: 'u1', ts: 1, type: 'user', text: '看图', images } },
      { op: 'append', event: { id: 'u2', ts: 2, type: 'user', text: '纯文本' } },
    ])
    const withImg = s.events[0] as Extract<TimelineEvent, { type: 'user' }>
    expect(withImg.images).toEqual(images)
    const plain = s.events[1] as Extract<TimelineEvent, { type: 'user' }>
    expect('images' in plain).toBe(false)   // 无图路径字段缺省——与既有 JSONL 会话兼容
  })
})
