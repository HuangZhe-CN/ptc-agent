import React from 'react'

/**
 * EventRow 通用骨架（【设计稿】§08.1 / §17.1 渲染不变量）：
 *   actionLabel（secondary 色 regular）+ typeIcon?（固定 16px slot，防 filename 抖动）
 *   + primaryTarget?（semibold primary）+ diff?（tabular-nums 绿/红）
 *   + disclosure?（codicon-chevron-right，展开旋转 90°，120–160ms）
 * 展开内容经 .eventCollapse（grid-template-rows 0fr→1fr + opacity，160–220ms）包裹；
 * collapse 只隐藏 body，event header DOM 不变（§17.1）。
 */
export interface EventRowProps {
  /** actionLabel，如 "Edited" / "Thought for 17s" */
  label: React.ReactNode
  /** typeIcon：JS/CSS/terminal/folder 等，置于 label 后的固定 slot */
  icon?: React.ReactNode
  /** primaryTarget：文件名等 semibold 内容 */
  target?: React.ReactNode
  /** diff：绿色 +N / 红色 -N */
  diff?: { add: number; del: number }
  /** 是否渲染 disclosure chevron（可展开时） */
  disclosure?: boolean
  expanded?: boolean
  onToggle?: () => void
  /** error 态：label/icon 转 --agent-error（§08.2） */
  error?: boolean
  /** 展开内容（折叠容器内） */
  children?: React.ReactNode
  className?: string
}

export function EventRow(props: EventRowProps): JSX.Element {
  const { label, icon, target, diff, disclosure, expanded = false, onToggle, error, children, className } = props
  const cls = ['eventRow', expanded && 'expanded', error && 'isError', className].filter(Boolean).join(' ')

  const header = (
    <React.Fragment>
      <span className="eventLabel">{label}</span>
      {icon != null && <span className="eventIcon">{icon}</span>}
      {target != null && <span className="eventTarget">{target}</span>}
      {diff != null && (
        <span className="eventDiff">
          <span className="diffAdd">+{diff.add}</span>
          <span className="diffDel">-{diff.del}</span>
        </span>
      )}
      {disclosure && <i className="codicon codicon-chevron-right eventChevron" aria-hidden="true" />}
    </React.Fragment>
  )

  return (
    <div className={cls}>
      {onToggle ? (
        <button type="button" className="eventHeader" aria-expanded={expanded} onClick={onToggle}>
          {header}
        </button>
      ) : (
        <div className="eventHeader eventHeaderStatic">{header}</div>
      )}
      {children != null && (
        <div className="eventCollapse">
          <div className="eventCollapseInner">{children}</div>
        </div>
      )}
    </div>
  )
}
