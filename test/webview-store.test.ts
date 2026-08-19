// test/webview-store.test.ts
// 依赖链：webview-ui/src/store.ts 必须保持 node 可加载（无 './api' 依赖）；
// '@shared/protocol' 经 vitest.config.ts 的 alias 解析到 src/shared。
import { describe, it, expect } from 'vitest'
import { applyUiOps, initialWebviewState } from '../src/shared/protocol'
import { useAgentStore } from '../webview-ui/src/store'

describe('webview store 归约（复用 applyUiOps）', () => {
  it('snapshot 替换、ops 应用——与 host 侧同源', () => {
    let s = initialWebviewState('zh')
    s = applyUiOps(s, [{ op: 'phase', phase: 'running' }, { op: 'append', event: { id: 'x', ts: 1, type: 'error', message: 'E' } }])
    expect(s.phase).toBe('running'); expect(s.events).toHaveLength(1)
  })
  it('I5：remove op 在 store 侧同样移除事件', () => {
    let s = initialWebviewState('en')
    s = applyUiOps(s, [
      { op: 'append', event: { id: 'a', ts: 1, type: 'error', message: 'E' } },
      { op: 'append', event: { id: 'c', ts: 2, type: 'completion', markdown: 'par' } },
    ])
    s = applyUiOps(s, [{ op: 'remove', id: 'c' }])
    expect(s.events.map(e => e.id)).toEqual(['a'])
  })
})

describe('webview store applyHost（真实 zustand store，node 加载）', () => {
  it('I2：snapshot 携带的 locale 生效（不再被内存初值覆盖恒为 en）；ui 本地态保留', () => {
    const st = useAgentStore.getState()
    st.applyHost({ type: 'snapshot', seq: 1, state: { ...initialWebviewState('zh-CN'), title: '任务' } })
    const zh = useAgentStore.getState()
    expect(zh.locale).toBe('zh-CN')
    expect(zh.title).toBe('任务')
    // ui 偏好是 webview 本地态：snapshot 不覆盖
    zh.setUiPref({ queueOpen: false })
    st.applyHost({ type: 'snapshot', seq: 2, state: { ...initialWebviewState('en') } })
    const after = useAgentStore.getState()
    expect(after.locale).toBe('en')
    expect(after.ui.queueOpen).toBe(false)
  })
})
