import React, { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import type { SessionSummary } from '@shared/protocol'
import './header.css'

/** rpc reqId：模块内单调自增，起点错开 useListModels 的小整数计数器（从 1 起）——
 *  回包走单槽 lastRpc、消费方仅按 reqId 匹配（rpcResult 不回显 method），两模块并发在飞时
 *  相同小整数 reqId 会互吞对方回包（本地 listSessions 先回即污染远程 listModels 的表单态），
 *  错开数量级即天然不重叠 */
let rpcSeq = 1_000_000

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
 * - 键盘：挂载即把焦点移入根节点（锚点按钮与下拉是兄弟节点，不移焦则 onKeyDown 收不到
 *   Esc）；Esc 关闭并把焦点还给锚点；↑↓ 在会话行间移动（roving 参照 ModelPopover）；
 * - 空态/加载态文案走 i18n.ts；点击外部 / Esc 关闭。
 */
export function HistoryDropdown({ anchorRef, onClose }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
}): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const send = useAgentStore(s => s.send)
  const phase = useAgentStore(s => s.phase)
  // I3：运行中禁用切换（host 侧 isTurnActive 守卫兜底）
  const busy = phase === 'running' || phase === 'submitting'
  /** null=加载中；[]=空/失败（空态文案统一，失败不弹错——下拉可重开重试） */
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 会话行按钮 refs：↑↓ roving 定位（参照 ModelPopover itemRefs） */
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

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

  /* 挂载即把焦点移入下拉根（tabIndex=-1）：锚点按钮与本根 div 是兄弟节点，鼠标点击/Enter
     打开后焦点仍留在锚点上，React 合成 onKeyDown 永远收不到 Esc——移焦后 Esc/↑↓ 才可达
     （同 ModelPopover 挂载即 focusInitial 的做法） */
  useEffect(() => { rootRef.current?.focus() }, [])

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

  /* 窄侧栏下 width:260 右对齐锚点会左越界视口（如默认 293px 侧栏 left=-31，
     标题/会话名首字被裁）。纯 CSS 表达不了锚点几何，挂载与侧栏尺寸变化时 JS 夹紧：
     左缘 ≥8px、右缘 ≤vw-8，宽度在 260 与可用空间间收缩。对齐语义（右贴锚点）不变。 */
  useEffect(() => {
    const el = rootRef.current
    const anchor = anchorRef.current
    if (!el || !anchor) return
    const clamp = (): void => {
      const vw = document.documentElement.clientWidth
      if (vw <= 0) return
      const a = anchor.getBoundingClientRect()
      const pad = 8
      const left = Math.max(pad, a.right - 260)          // 右对齐锚点，左缘夹进视口
      const width = Math.min(260, vw - pad - left)       // 右缘不越视口
      el.style.right = 'auto'
      el.style.left = Math.round(left - a.left) + 'px'   // 转 anchor 相对坐标
      el.style.width = Math.round(width) + 'px'
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [anchorRef])

  const focusItem = (i: number): void => {
    const total = sessions?.length ?? 0
    if (total === 0) return
    itemRefs.current[((i % total) + total) % total]?.focus()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      anchorRef.current?.focus()   /* Esc 关闭后焦点还给锚点（同 ModelTrigger 的 onClose(true) 语义） */
      onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const cur = itemRefs.current.findIndex(b => b === document.activeElement)
      focusItem(cur + (e.key === 'ArrowDown' ? 1 : -1))
    }
  }

  const open = (sessionId: string): void => {
    anchorRef.current?.focus()   /* 选中即关闭：焦点随关闭还给锚点（同 ModelPopover select） */
    send({ type: 'openSession', sessionId })
    onClose()
  }

  return (
    <div
      ref={rootRef}
      className="historyPopover popover"
      role="menu"
      aria-label={t(locale, 'history.title')}
      tabIndex={-1}
      /* 挂载移焦只为让 Esc/↑↓ 可达，根节点不承载可见焦点框（行级 .historyRow:focus-visible 已有） */
      style={{ outline: 'none' }}
      onKeyDown={onKeyDown}
    >
      <div className="historyTitle">{t(locale, 'history.title')}</div>
      {sessions === null && <div className="historyEmpty">{t(locale, 'history.loading')}</div>}
      {sessions !== null && sessions.length === 0 && (
        <div className="historyEmpty">{t(locale, 'history.empty')}</div>
      )}
      {sessions !== null && sessions.length > 0 && (
        <div className="historyList" role="group">
          {sessions.map((s, i) => (
              <button
                key={s.sessionId}
                ref={el => { itemRefs.current[i] = el }}
                type="button"
                role="menuitem"
                className="historyRow"
                title={s.title}
                disabled={busy}
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
