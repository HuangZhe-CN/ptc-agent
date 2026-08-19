import React, { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import type { SessionSummary } from '@shared/protocol'
import './header.css'

/** rpc reqId：模块内单调自增（与 useListModels 同款约定） */
let rpcSeq = 1

/** createdAt → 本地短日期（title 已含语义，日期用月/日/年紧凑格式即可） */
function formatDate(ts: number, locale: string): string {
  try {
    return new Date(ts).toLocaleDateString(
      locale && locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US',
      { year: 'numeric', month: 'short', day: 'numeric' },
    )
  } catch { return '' }
}

const isSessionSummary = (x: unknown): x is SessionSummary =>
  typeof x === 'object' && x !== null
  && typeof (x as SessionSummary).sessionId === 'string'
  && typeof (x as SessionSummary).title === 'string'
  && typeof (x as SessionSummary).createdAt === 'number'

/**
 * History 下拉（Task 26 新功能，设计稿 §06 右四图标中的 codicon-history）：
 * - 打开即 rpc listSessions（host 侧 SessionStore.list() 摘要：sessionId/title/createdAt）；
 * - 表面复用 tokens.css 的 .popover（editorWidget 底+边框+阴影），定位参照
 *   Floaters/ModelPopover：锚点 span 承担 position:relative，自 trigger 下缘向下展开；
 * - 行：title ellipsis + 右侧 muted 短日期；点击 → send({type:'openSession'}) 并关闭；
 * - 空态/加载态文案走 i18n.ts；点击外部 / Esc 关闭。
 */
export function HistoryDropdown({ anchorRef, onClose }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
}): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const send = useAgentStore(s => s.send)
  /** null=加载中；[]=空/失败（空态文案统一，失败不弹错——下拉可重开重试） */
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  /* 发起 rpc + 消费结果（模式同 Onboarding/useListModels：订阅 lastRpc 按 reqId 匹配） */
  useEffect(() => {
    const reqId = rpcSeq++
    const unsubscribe = useAgentStore.subscribe((s, prev) => {
      if (s.lastRpc === prev.lastRpc) return
      const rpc = s.lastRpc
      if (!rpc || rpc.reqId !== reqId) return
      setSessions(rpc.ok && Array.isArray(rpc.result) ? rpc.result.filter(isSessionSummary) : [])
    })
    useAgentStore.getState().send({
      type: 'rpc',
      reqId,
      method: 'listSessions',
      params: { providerId: '', protocol: 'openai' },   // 占位字段：listSessions 不使用
    })
    return unsubscribe
  }, [])

  /* 点击外部关闭（同 ModelPopover 约定：锚点按钮自身的 click 负责 toggle） */
  useEffect(() => {
    const onDown = (ev: MouseEvent): void => {
      const target = ev.target as Node
      if (rootRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const open = (sessionId: string): void => {
    send({ type: 'openSession', sessionId })
    onClose()
  }

  return (
    <div
      ref={rootRef}
      className="historyPopover popover"
      role="menu"
      aria-label={t(locale, 'history.title')}
      onKeyDown={onKeyDown}
    >
      <div className="historyTitle">{t(locale, 'history.title')}</div>
      {sessions === null && <div className="historyEmpty">{t(locale, 'history.loading')}</div>}
      {sessions !== null && sessions.length === 0 && (
        <div className="historyEmpty">{t(locale, 'history.empty')}</div>
      )}
      {sessions !== null && sessions.length > 0 && (
        <div className="historyList" role="group">
          {sessions.map(s => (
            <button
              key={s.sessionId}
              type="button"
              role="menuitem"
              className="historyRow"
              title={s.title}
              onClick={() => open(s.sessionId)}
            >
              <span className="historySessionTitle">{s.title}</span>
              <span className="historyDate">{formatDate(s.createdAt, locale)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
