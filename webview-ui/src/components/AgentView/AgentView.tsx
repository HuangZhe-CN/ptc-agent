import React, { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import { useTailFollow } from '../../hooks/useTailFollow'
import { AgentHeader } from '../Header/AgentHeader'
import { Composer } from '../Composer/Composer'
import { Timeline } from '../Timeline/Timeline'
import { ReviewPanel } from '../Review/ReviewPanel'
import { ReviewActionBar } from '../Review/ReviewActionBar'
import { ProviderManager } from '../Onboarding/Onboarding'

/** 【设计稿】§0.1：录屏坐标系 764×1314 capture px，等比基准宽 */
const DESIGN_WIDTH = 764

/**
 * Task 21：三层骨架（设计稿 §2.2）
 *   header (fixed) + mainScroll (minmax(0,1fr)) + bottomDock (content-sized)
 * --scale 由 ResizeObserver 写入 root（§2.3：scale = W/764，clamp 0.5–1），
 * 所有几何以「设计稿 capture px × --scale」换算；文字/图标/热区不随 scale 缩放。
 * Task 23 插入：reviewOpen 时在 mainScroll 内渲染 ReviewPanel（§13.2 属于主滚动内容），
 * 并在 agentScroll 与 agentDock 之间挂 ReviewActionBar（grid 独立行 → 不随内容滚动，
 * 天然 sticky，视觉上紧贴 Composer 上方，像第二层 Dock）。
 * Task 26：reviewOpen 迁入 store.ui（persistUi/setUiPref 统一收口，消除 window
 * CustomEvent hack——CompletionEvent 直接写 store）；agentScroll 接 useTailFollow（§14.1）。
 * Header layout 按钮（原设计 §12.4「Provider 管理」入口）挂 ProviderManager：
 * 走组件级 state 而非 store.ui——管理视图是一次性覆盖层，不持久化，重载后回聊天视图。
 */
export function AgentView(): JSX.Element {
  const ref = useRef<HTMLElement | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  const reviewOpen = useAgentStore(s => s.ui.reviewOpen)
  const setUiPref = useAgentStore(s => s.setUiPref)
  const [manageOpen, setManageOpen] = useState(false)

  useTailFollow(scrollRef)

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
      <AgentHeader onOpenManage={() => setManageOpen(true)} />
      <main className="agentScroll" ref={scrollRef}>
        {/* 管理视图整屏替代 Timeline；review 相关 UI 一并隐藏，避免浮在管理内容上 */}
        {manageOpen ? (
          <ProviderManager onBack={() => setManageOpen(false)} />
        ) : (
          <Timeline />
        )}
        {!manageOpen && reviewOpen && <ReviewPanel />}
      </main>
      {!manageOpen && reviewOpen && (
        <ReviewActionBar onClose={() => setUiPref({ reviewOpen: false })} />
      )}
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
  // 原为纯装饰 span（用户反馈「无法点击」）；现接 host 的 workbenchAction：
  // 聚焦资源管理器/终端、开文件夹、开简单浏览器。icon 作子元素 + aria-hidden，
  // 可访问名走 aria-label（与 AgentHeader iconButton 同 idiom）。
  const railActions = [
    { icon: 'codicon-files', key: 'rail.files', action: 'focusExplorer' },
    { icon: 'codicon-terminal', key: 'rail.terminal', action: 'focusTerminal' },
    { icon: 'codicon-folder', key: 'rail.folder', action: 'openFolder' },
    { icon: 'codicon-browser', key: 'rail.browser', action: 'openBrowser' },
  ] as const
  return (
    <div className="utilityRail">
      {railActions.map(item => (
        <button
          key={item.action}
          type="button"
          className="railIcon"
          aria-label={t(locale, item.key)}
          title={t(locale, item.key)}
          onClick={() => send({ type: 'workbenchAction', action: item.action })}
        >
          <i className={`codicon ${item.icon}`} aria-hidden="true" />
        </button>
      ))}
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
