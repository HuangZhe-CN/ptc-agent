import React from 'react'
import type { TimelineEvent } from '@shared/protocol'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import { Markdown } from '../shared/Markdown'

type CompactEv = Extract<TimelineEvent, { type: 'compact' }>

/** 字符规模展示：≥1KiB 显示 k 单位，其余原值 */
const fmtChars = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)}k` : String(n))

/**
 * /compact 压缩收尾事件：单行头（codicon-fold + 标签 + 前后规模对比）+ 摘要 markdown 正文。
 * 压缩后时间线仅此一条事件——它即此前全部会话的可见占位。
 */
export function CompactEvent({ event }: { event: CompactEv }): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  return (
    <div className="eventRow compactRow">
      <div className="eventHeader eventHeaderStatic">
        <span className="eventIcon">
          <i className="codicon codicon-fold" aria-hidden="true" />
        </span>
        <span className="eventLabel">{t(locale, 'event.compact.label')}</span>
        <span className="eventTarget">
          {t(locale, 'event.compact.scale', { before: fmtChars(event.before), after: fmtChars(event.after) })}
        </span>
      </div>
      <div className="completionBody">
        <Markdown source={event.markdown} />
      </div>
    </div>
  )
}
