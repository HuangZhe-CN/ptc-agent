import React from 'react'
import type { TimelineEvent } from '@shared/protocol'
import { Markdown } from '../shared/Markdown'

type CompletionEv = Extract<TimelineEvent, { type: 'completion' }>

/**
 * Task 22 最小实现：完成态 markdown 正文（设计稿 §13 完成总结）。
 * Task 23 完善：小节标题/反馈操作（copy/thumbs）与 ReviewPanel 联动。
 */
export function CompletionEvent({ event }: { event: CompletionEv }): JSX.Element {
  return (
    <div className="eventRow completionRow">
      <div className="completionBody">
        <Markdown source={event.markdown} />
      </div>
    </div>
  )
}
