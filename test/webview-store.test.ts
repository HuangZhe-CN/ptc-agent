// test/webview-store.test.ts
import { describe, it, expect } from 'vitest'
import { applyUiOps, initialWebviewState } from '../src/shared/protocol'

describe('webview store 归约（复用 applyUiOps）', () => {
  it('snapshot 替换、ops 应用——与 host 侧同源', () => {
    let s = initialWebviewState('zh')
    s = applyUiOps(s, [{ op: 'phase', phase: 'running' }, { op: 'append', event: { id: 'x', ts: 1, type: 'error', message: 'E' } }])
    expect(s.phase).toBe('running'); expect(s.events).toHaveLength(1)
  })
})
