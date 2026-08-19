import React from 'react'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'

/**
 * 设计稿 §06 Header：
 * - 高 capture ≈64px（382w ≈32）→ calc(var(--scale) * 64px)
 * - 左内边距 capture ≈15px；标题单行 ellipsis，初始 "Agent"，提交后为任务名（state.title）
 * - 右四图标 ＋/history/more(layout)/close：16px glyph、28px 热区、hover=toolbar.hoverBackground
 *   圆底；close 不用红底；＋ → send({type:'newSession'})
 * - 背景与 --agent-bg 同色，固定不滚动（§2.2 header fixed）
 */
export function AgentHeader(): JSX.Element {
  const title = useAgentStore(s => s.title)
  const send = useAgentStore(s => s.send)
  const locale = useAgentStore(s => s.locale)
  return (
    <header className="agentHeader">
      <div className="headerTitle" title={title}>{title}</div>
      <div className="headerActions">
        <button
          type="button"
          className="iconButton"
          aria-label={t(locale, 'header.newSession')}
          title={t(locale, 'header.newSession')}
          onClick={() => send({ type: 'newSession' })}
        >
          <i className="codicon codicon-add" aria-hidden="true" />
        </button>
        {/* history / more / close：Task 24+ 接管行为，先保持可聚焦占位 */}
        <button type="button" className="iconButton">
          <i className="codicon codicon-history" aria-hidden="true" />
        </button>
        <button type="button" className="iconButton">
          <i className="codicon codicon-layout" aria-hidden="true" />
        </button>
        <button type="button" className="iconButton headerClose">
          <i className="codicon codicon-close" aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
