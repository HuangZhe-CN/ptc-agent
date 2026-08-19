import React from 'react'
import { useAgentStore } from '../../store'
import { ThoughtEvent } from './ThoughtEvent'
import { ExploreEvent } from './ExploreEvent'
import { EditEvent } from './EditEvent'
import { RunEvent } from './RunEvent'
import { ErrorEvent } from './ErrorEvent'
import { CompletionEvent } from './CompletionEvent'

/** Task 25/T26 前的 Onboarding 占位（无 provider 时主区留白） */
function Onboarding(): JSX.Element | null {
  return null
}

/**
 * Timeline（【设计稿】§08/§09）：按 reducer 之上的 events 装配事件组件族。
 * key 稳定于 e.id：patch（流式/状态翻转）只原位更新，不触发进入动画重放。
 */
export function Timeline(): JSX.Element | null {
  const events = useAgentStore(s => s.events)
  const hasProvider = useAgentStore(s => s.providers.length > 0)
  if (!hasProvider) return <Onboarding />
  return (
    <div className="timeline">
      {events.map(e => (
        <React.Fragment key={e.id}>
          {e.type === 'thought' && <ThoughtEvent event={e} />}
          {e.type === 'explore' && <ExploreEvent event={e} />}
          {e.type === 'edit' && <EditEvent event={e} />}
          {e.type === 'run' && <RunEvent event={e} />}
          {e.type === 'completion' && <CompletionEvent event={e} />}
          {e.type === 'error' && <ErrorEvent event={e} />}
        </React.Fragment>
      ))}
    </div>
  )
}
