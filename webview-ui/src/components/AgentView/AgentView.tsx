import React, { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import { vscodeApi } from '../../api'
import { AgentHeader } from '../Header/AgentHeader'
import { Composer } from '../Composer/Composer'
import { Timeline } from '../Timeline/Timeline'
import { ReviewPanel, OPEN_REVIEW_EVENT } from '../Review/ReviewPanel'
import { ReviewActionBar } from '../Review/ReviewActionBar'

/** 【设计稿】§0.1：录屏坐标系 764×1314 capture px，等比基准宽 */
const DESIGN_WIDTH = 764

/** vscodeApi 持久化 UI 的最小形状（与 ThoughtEvent 同款；Task 26 由 store.persistUi 正式接管） */
interface PersistedUi { expandedThoughtIds?: string[]; queueOpen?: boolean; reviewOpen?: boolean }
function readPrefs(): PersistedUi {
  try { return (vscodeApi.getState<PersistedUi>() ?? {}) as PersistedUi } catch { return {} }
}

/**
 * Task 21：三层骨架（设计稿 §2.2）
 *   header (fixed) + mainScroll (minmax(0,1fr)) + bottomDock (content-sized)
 * --scale 由 ResizeObserver 写入 root（§2.3：scale = W/764，clamp 0.5–1），
 * 所有几何以「设计稿 capture px × --scale」换算；文字/图标/热区不随 scale 缩放。
 * Task 23 插入：reviewOpen 时在 mainScroll 内渲染 ReviewPanel（§13.2 属于主滚动内容），
 * 并在 agentScroll 与 agentDock 之间挂 ReviewActionBar（grid 独立行 → 不随内容滚动，
 * 天然 sticky，视觉上紧贴 Composer 上方，像第二层 Dock）。
 */
export function AgentView(): JSX.Element {
  const ref = useRef<HTMLElement | null>(null)
  // reviewOpen 本地 state：初始值读 vscodeApi.getState()（参照 ThoughtEvent 先例）；
  // 变更时经 vscodeApi.setState 持久（T26 persistUi 统一收口）
  const [reviewOpen, setReviewOpen] = useState<boolean>(() => !!readPrefs().reviewOpen)

  const updateReviewOpen = (next: boolean): void => {
    setReviewOpen(next)
    const prefs = readPrefs()
    const nextPrefs: PersistedUi = { ...prefs, reviewOpen: next }
    try { vscodeApi.setState(nextPrefs) } catch { /* host 不可达 */ }
    useAgentStore.getState().persistUi({
      expandedThoughtIds: nextPrefs.expandedThoughtIds ?? [],
      queueOpen: !!nextPrefs.queueOpen,
      reviewOpen: next,
    })
  }

  // 汇总卡/Review 按钮的「打开审阅」信号（CompletionEvent → AgentView，解耦于 store 约束）
  useEffect(() => {
    const onOpen = (): void => updateReviewOpen(true)
    window.addEventListener(OPEN_REVIEW_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_REVIEW_EVENT, onOpen)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const apply = (width: number): void => {
      const scale = Math.min(1, Math.max(0.5, width / DESIGN_WIDTH))
      document.documentElement.style.setProperty('--scale', scale.toFixed(4))
    }
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) apply(entry.contentRect.width)
    })
    ro.observe(el)
    apply(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  return (
    <section className="agentView" ref={ref}>
      <AgentHeader />
      <main className="agentScroll">
        <Timeline />
        {reviewOpen && <ReviewPanel />}
      </main>
      {reviewOpen && <ReviewActionBar onClose={() => updateReviewOpen(false)} />}
      <footer className="agentDock">
        <UtilityRail />
        <Composer />
      </footer>
    </section>
  )
}

/** 设计稿 §12.3：Composer 上方的 utility rail——左 4 图标 + 有变更时的 Review Changes */
function UtilityRail(): JSX.Element {
  const changes = useAgentStore(s => s.changes)
  const send = useAgentStore(s => s.send)
  const locale = useAgentStore(s => s.locale)
  return (
    <div className="utilityRail">
      <span className="railIcon codicon codicon-files" aria-hidden="true" />
      <span className="railIcon codicon codicon-terminal" aria-hidden="true" />
      <span className="railIcon codicon codicon-folder" aria-hidden="true" />
      <span className="railIcon codicon codicon-browser" aria-hidden="true" />
      <span className="railSpacer" />
      {changes.length > 0 && (
        <button
          type="button"
          className="reviewButton"
          onClick={() => send({ type: 'reviewFile', path: changes[0].path })}
        >
          <i className="codicon codicon-diff" aria-hidden="true" />
          {t(locale, 'rail.reviewChanges')}
        </button>
      )}
    </div>
  )
}
