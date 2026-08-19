import React, { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useAgentStore } from '../../store'
import { ft, type FtKey } from '../Floaters/floatersText'
import { ModelPopover } from '../Floaters/ModelPopover'

/** §15 动效表：Popover 退出 90ms（closing 期间保持挂载播动画，之后卸载） */
const POPOVER_EXIT_MS = 90

/**
 * 设计稿 §07.1 底部左侧模型控件：模型名 + quality + chevron，同一 baseline。
 * Task 24：接 ModelPopover——点击展开/再点收起；选中/Esc/点击外部关闭后焦点返回本按钮；
 * 键盘（§20 交互表）：Enter 打开，↑↓ 选择，Esc 关闭（细节由 popover 内部 roving 处理）。
 * Task 26：关闭改经 closing 状态 + 90ms 延迟卸载（§15 退出动效）；期间重复关闭去重。
 */
export function ModelTrigger(): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const providers = useAgentStore(s => s.providers)
  const active = useAgentStore(s => s.active)

  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => { if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current) }, [])

  const close = (refocus?: boolean): void => {
    if (closing || !open) return
    setClosing(true)
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = undefined
      setClosing(false)
      setOpen(false)
      if (refocus) btnRef.current?.focus()   /* 关闭后焦点返回 trigger（§7.2） */
    }, POPOVER_EXIT_MS)
  }

  let label = '—'
  if (active) {
    const provider = providers.find(p => p.id === active.providerId)
    label = provider?.models.find(m => m.id === active.modelId)?.label ?? active.modelId
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    /* popover 打开时焦点通常在菜单内（其自身处理 Esc）；此处兜底焦点仍在 trigger 的 Esc */
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      close(true)
    }
  }

  return (
    <span className="modelTriggerWrap">
      <button
        ref={btnRef}
        type="button"
        className="modelTrigger"
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(true) : setOpen(true))}
        onKeyDown={onKeyDown}
      >
        <span className="modelLabel">{label}</span>
        {active && <span className="modelQuality">{ft(locale, `quality.${active.quality}` as FtKey)}</span>}
        <i className="codicon codicon-chevron-down" aria-hidden="true" />
      </button>
      {(open || closing) && <ModelPopover anchorRef={btnRef} onClose={close} closing={closing} />}
    </span>
  )
}
