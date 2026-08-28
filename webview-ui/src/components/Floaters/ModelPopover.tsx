import React, { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { useAgentStore } from '../../store'
import type { ActiveModel, Quality } from '@shared/protocol'
import { ft, type FtKey } from './floatersText'
import './floaters.css'

/** Low / Medium / High（设计稿 §07.2 二级菜单竖排顺序） */
const QUALITIES: Quality[] = ['low', 'medium', 'high']

interface ModelRow {
  providerId: string
  providerLabel: string
  /** providerKeyed[p.id]——未保存密钥仅作提示，不禁用（本地网关可空 key） */
  keyed: boolean
  modelId: string
  modelLabel: string
  supportsThinking: boolean
}

const rowKey = (r: { providerId: string; modelId: string }): string => `${r.providerId}/${r.modelId}`

/**
 * Task 24：Model popover + quality 二级菜单（设计稿 §07.2/§07.3/§15/§20）。
 * 定位：由 ModelTrigger 的 .modelTriggerWrap（position:relative）承担锚定；
 * 实现布局中 Composer 常驻底部 dock，故菜单自 trigger 上缘向上展开
 * （§7.3 translateY(-2px→0) + transform-origin=锚点侧，即 bottom）。
 * 键盘（§20 交互表）：Enter 打开（trigger 侧）；↑↓ 移动；→ 进入二级菜单；
 * ← / Esc 退回或关闭；选择/点击外部关闭后焦点返回 trigger（onClose(true)）。
 * Task 26（§15 Popover 退出 90ms）：closing 时根节点挂 isClosing 播退出动画，
 * 卸载时机由 ModelTrigger 延迟 90ms 控制（reduced-motion 下 tokens.css 全局降级）。
 */
export function ModelPopover({ anchorRef, onClose, closing = false }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  onClose: (refocus?: boolean) => void
  closing?: boolean
}): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const providers = useAgentStore(s => s.providers)
  const providerKeyed = useAgentStore(s => s.providerKeyed)
  const active = useAgentStore(s => s.active)
  const send = useAgentStore(s => s.send)

  const multiProvider = providers.length > 1
  const rows: ModelRow[] = providers.flatMap(p =>
    p.models.map<ModelRow>(m => ({
      providerId: p.id,
      providerLabel: p.label,
      keyed: !!providerKeyed[p.id],
      modelId: m.id,
      modelLabel: m.label || m.id,
      supportsThinking: m.supportsThinking,
    }))
  )

  const [subFor, setSubFor] = useState<string | null>(null)   // rowKey of the row whose quality submenu is open
  /** 二级菜单定位（审计 P1-1）：right=右弹（§7.2 默认）；left=右溢翻左；clamp=两侧都放不下，钉视口左缘 */
  type SubPos = 'right' | 'left' | { clampLeft: number }
  const [subPos, setSubPos] = useState<SubPos>('right')
  const rootRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  /** 主菜单可聚焦项：每行两个（行主体 + chevron），DOM 顺序扁平存储 */
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const subItemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const pendingSubFocus = useRef(false)

  const currentQuality: Quality = active?.quality ?? 'high'   // quality 当前值从 store.active.quality 读

  const isActiveRow = (r: ModelRow): boolean =>
    !!active && active.providerId === r.providerId && active.modelId === r.modelId

  const focusInitial = (): void => {
    const idx = rows.findIndex(isActiveRow)
    itemRefs.current[(idx >= 0 ? idx : 0) * 2]?.focus()
  }

  const select = (r: ModelRow, quality?: Quality): void => {
    const next: ActiveModel = {
      providerId: r.providerId,
      modelId: r.modelId,
      quality: quality ?? currentQuality,
    }
    send({ type: 'selectModel', active: next })
    onClose(true)
  }

  const openSubmenu = (rowIdx: number): void => {
    const r = rows[rowIdx]
    if (!r) return
    pendingSubFocus.current = true
    setSubFor(rowKey(r))
  }

  /* 打开时焦点落在当前模型行（§7.2 选中态可定位） */
  useEffect(() => { focusInitial() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* 二级菜单挂载后焦点移入第一项（键盘与鼠标行为一致，Esc 有明确回退目标） */
  useEffect(() => {
    if (subFor && pendingSubFocus.current) {
      pendingSubFocus.current = false
      subItemRefs.current[0]?.focus()
    }
  }, [subFor])

  /* 二级菜单视口自适应（审计 P1-1）：绘制前测量——右弹放不下先翻左；翻左左缘 <8px
     （默认 ≈300px 侧栏两侧均不足 120px）则钉在视口左缘内侧，覆盖 popover 左部 */
  useLayoutEffect(() => {
    if (!subFor) { setSubPos('right'); return }
    const menu = subRef.current
    const vw = document.documentElement.clientWidth
    if (!menu || vw === 0 || !menu.parentElement) return
    const rect = menu.getBoundingClientRect()
    if (rect.right <= vw - 4) { setSubPos('right'); return }
    const rowLeft = menu.parentElement.getBoundingClientRect().left
    if (rowLeft - rect.width - 2 >= 8) setSubPos('left')
    else setSubPos({ clampLeft: Math.max(4, Math.round(8 - rowLeft)) })
  }, [subFor])

  /* 点击外部关闭：popover 与 trigger 内部除外（trigger 自身的 click 负责 toggle，避免 mousedown 提前关闭又被 click 重开） */
  useEffect(() => {
    const onDown = (ev: MouseEvent): void => {
      const target = ev.target as Node
      if (rootRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const focusItem = (i: number): void => {
    const total = rows.length * 2
    if (total === 0) return
    itemRefs.current[((i % total) + total) % total]?.focus()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (subFor !== null) {
      /* ---- 二级菜单（quality）---- */
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const cur = subItemRefs.current.findIndex(b => b === document.activeElement)
        const dir = e.key === 'ArrowDown' ? 1 : -1
        const next = cur === -1 ? 0 : cur + dir
        if (next >= 0 && next < QUALITIES.length) subItemRefs.current[next]?.focus()
      } else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
        /* ←/Esc 只关二级菜单，焦点回该行 chevron；主菜单 Esc 再关整体 */
        e.preventDefault()
        e.stopPropagation()
        const idx = rows.findIndex(r => rowKey(r) === subFor)
        setSubFor(null)
        focusItem((idx >= 0 ? idx : 0) * 2 + 1)
      }
      return
    }
    /* ---- 主菜单 ---- */
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const cur = itemRefs.current.findIndex(b => b === document.activeElement)
      focusItem(cur + (e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      const cur = itemRefs.current.findIndex(b => b === document.activeElement)
      if (cur >= 0) openSubmenu(Math.floor(cur / 2))
    }
  }

  return (
    <div
      ref={rootRef}
      className={closing ? 'modelPopover popover isClosing' : 'modelPopover popover'}
      role="menu"
      aria-label={ft(locale, 'popover.title')}
      onKeyDown={onKeyDown}
    >
      <div className="modelPopoverTitle">{ft(locale, 'popover.title')}</div>
      {rows.length === 0 && <div className="modelPopoverEmpty">{ft(locale, 'popover.empty')}</div>}
      {rows.map((r, i) => {
        const selected = isActiveRow(r)
        const subOpen = subFor === rowKey(r)
        return (
          <div key={rowKey(r)} className={selected ? 'modelRow isActive' : 'modelRow'} role="none">
            <button
              type="button"
              role="menuitem"
              className="modelRowMain"
              tabIndex={-1}
              aria-current={selected || undefined}
              ref={el => { itemRefs.current[i * 2] = el }}
              onClick={() => select(r)}
            >
              {multiProvider && (
                <span className="modelRowProvider">{r.providerLabel}</span>
              )}
              <span className="modelRowName" title={r.modelLabel}>{r.modelLabel}</span>
              <span className="modelRowTags">
                {!r.keyed && (
                  <i
                    className="codicon codicon-key modelKeyHint"
                    role="img"
                    title={ft(locale, 'popover.noKey')}
                    aria-label={ft(locale, 'popover.noKey')}
                  />
                )}
                {r.supportsThinking && <span className="modelTagThink">{ft(locale, 'popover.thinking')}</span>}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="modelRowMore"
              tabIndex={-1}
              aria-haspopup="menu"
              aria-expanded={subOpen}
              aria-label={ft(locale, 'popover.more')}
              title={ft(locale, 'popover.more')}
              ref={el => { itemRefs.current[i * 2 + 1] = el }}
              onClick={() => (subOpen ? setSubFor(null) : openSubmenu(i))}
            >
              <i className="codicon codicon-chevron-right" aria-hidden="true" />
            </button>
            {subOpen && (() => {
              const cls = subPos === 'right' ? 'qualityMenu popover'
                : subPos === 'left' ? 'qualityMenu popover flipLeft'
                : 'qualityMenu popover subClamp'
              return (
                <div
                  ref={subRef}
                  className={cls}
                  style={typeof subPos === 'object' ? { left: `${subPos.clampLeft}px` } : undefined}
                  role="menu"
                  aria-label={ft(locale, 'quality.title')}
                >
                {QUALITIES.map((q, qi) => {
                  const isCur = currentQuality === q
                  return (
                    <button
                      key={q}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isCur}
                      className={isCur ? 'qualityRow isActive' : 'qualityRow'}
                      tabIndex={-1}
                      ref={el => { subItemRefs.current[qi] = el }}
                      onClick={() => select(r, q)}
                    >
                      <span className="qualityCheck">
                        {isCur && <i className="codicon codicon-check" aria-hidden="true" />}
                      </span>
                      <span>{ft(locale, `quality.${q}` as FtKey)}</span>
                    </button>
                  )
                })}
                </div>
              )
            })()}
          </div>
        )
      })}
    </div>
  )
}
