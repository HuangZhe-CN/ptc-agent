import React, { useState } from 'react'
import type { TimelineEvent } from '@shared/protocol'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import { EventRow } from './EventRow'

type ExploreEv = Extract<TimelineEvent, { type: 'explore' }>

/**
 * Explore 事件（§08.2）：一级行 "Explored N files"（running 为 "Exploring…"），
 * 展开后列出 targets（muted，每行 codicon-file + path）。
 */
export function ExploreEvent({ event }: { event: ExploreEv }): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const [expanded, setExpanded] = useState(false)
  const label = event.status === 'running'
    ? t(locale, 'event.explore.running')
    : t(locale, 'event.explore.done', { n: event.count })
  const expandable = event.targets.length > 0
  return (
    <EventRow
      label={label}
      icon={<i className="codicon codicon-folder" aria-hidden="true" />}
      disclosure={expandable}
      expanded={expanded}
      onToggle={expandable ? () => setExpanded(v => !v) : undefined}
    >
      <div className="exploreTargets">
        {event.targets.map(tp => (
          <div key={tp} className="exploreTarget">
            <i className="codicon codicon-file" aria-hidden="true" />
            <span className="explorePath" title={tp}>{tp}</span>
          </div>
        ))}
      </div>
    </EventRow>
  )
}
