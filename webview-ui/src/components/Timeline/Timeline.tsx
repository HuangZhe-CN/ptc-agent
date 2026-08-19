import React from 'react'
import { useAgentStore } from '../../store'
import { Onboarding } from '../Onboarding/Onboarding'
import { ThoughtEvent } from './ThoughtEvent'
import { ExploreEvent } from './ExploreEvent'
import { EditEvent } from './EditEvent'
import { RunEvent } from './RunEvent'
import { ErrorEvent } from './ErrorEvent'
import { CompletionEvent } from './CompletionEvent'

/**
 * Timeline（【设计稿】§08/§09）：按 reducer 之上的 events 装配事件组件族。
 * key 稳定于 e.id：patch（流式/状态翻转）只原位更新，不触发进入动画重放。
 * Task 26：providers 为空且无 active 时挂 T25 的 Onboarding（providers 非空时
 * Onboarding 自身转 manage 视图——但该路径由 Header more 入口承担，主区仍走时间线）。
 */
export function Timeline(): JSX.Element | null {
  const events = useAgentStore(s => s.events)
  const noProvider = useAgentStore(s => s.providers.length === 0)
  const noActive = useAgentStore(s => s.active === null)
  if (noProvider && noActive) return <Onboarding />
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
