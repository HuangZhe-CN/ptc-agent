import React, { useRef, useState } from 'react'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import { HistoryDropdown } from './HistoryDropdown'

/**
 * 设计稿 §06 Header：
 * - 高 capture ≈64px（382w ≈32）→ calc(var(--scale) * 64px)
 * - 左内边距 capture ≈15px；标题单行 ellipsis，初始 "Agent"，提交后为任务名（state.title）
 * - 右四图标 ＋/history/more(layout)/close：16px glyph、28px 热区、hover=toolbar.hoverBackground
 *   圆底；close 不用红底；＋ → send({type:'newSession'})
 * - 背景与 --agent-bg 同色，固定不滚动（§2.2 header fixed）
 * - Task 26：history 图标接 HistoryDropdown（rpc listSessions → openSession）；
 *   more/layout 与 close 仍为可聚焦占位（后续任务接管）。
 */
export function AgentHeader(): JSX.Element {
  const title = useAgentStore(s => s.title)
  const send = useAgentStore(s => s.send)
  const locale = useAgentStore(s => s.locale)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyBtnRef = useRef<HTMLButtonElement>(null)

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
        <span className="historyAnchor">
          <button
            ref={historyBtnRef}
            type="button"
            className="iconButton"
            aria-label={t(locale, 'header.history')}
            title={t(locale, 'header.history')}
            aria-haspopup="menu"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen(v => !v)}
          >
            <i className="codicon codicon-history" aria-hidden="true" />
          </button>
          {historyOpen && (
            <HistoryDropdown anchorRef={historyBtnRef} onClose={() => setHistoryOpen(false)} />
          )}
        </span>
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
