import React from 'react'
import type { TimelineEvent } from '@shared/protocol'

type ErrorEv = Extract<TimelineEvent, { type: 'error' }>

/**
 * Error 事件（§08.2）：单行 codicon-error + message（error 色）。
 * 复用 .eventRow/.eventHeader 几何，左起点与最小高度与其他一级事件统一（§17.1）。
 */
export function ErrorEvent({ event }: { event: ErrorEv }): JSX.Element {
  return (
    <div className="eventRow isError errorRow">
      <div className="eventHeader eventHeaderStatic">
        <span className="eventIcon">
          <i className="codicon codicon-error" aria-hidden="true" />
        </span>
        <span className="errorMessage">{event.message}</span>
      </div>
    </div>
  )
}
