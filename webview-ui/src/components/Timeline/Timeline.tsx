import React from 'react'
import { useAgentStore } from '../../store'
import type { TimelineEvent } from '@shared/protocol'

/**
 * Task 21 最小占位：仅以原始简表渲染 events，供骨架联调肉眼核对。
 * Task 22 将按设计稿 §08/§09 重写为完整事件组件族（EventRow/Thought/...）。
 */

/** Task 25 前的 Onboarding 占位（无 provider 时主区留白） */
function Onboarding(): JSX.Element | null {
  return null
}

function summarize(e: TimelineEvent): { tag: string; detail: string } {
  switch (e.type) {
    case 'explore':
      return { tag: e.status === 'running' ? 'Exploring' : 'Explored', detail: `${e.count} · ${e.targets.join(', ')}` }
    case 'edit':
      return { tag: 'Edited', detail: `${e.file} +${e.add} -${e.del}` }
    case 'thought':
      return { tag: e.status === 'running' ? 'Thinking' : 'Thought', detail: (e.working || e.markdown || '').slice(0, 120) }
    case 'run':
      return { tag: `Ran${e.status === 'error' ? ' (error)' : e.status === 'running' ? '…' : ''}`, detail: e.command }
    case 'completion':
      return { tag: 'Completed', detail: e.markdown.slice(0, 160) }
    case 'error':
      return { tag: 'Error', detail: e.message }
  }
}

export function Timeline(): JSX.Element | null {
  const events = useAgentStore(s => s.events)
  const hasProvider = useAgentStore(s => s.providers.length > 0)
  if (!hasProvider) return <Onboarding />
  return (
    <div className="timeline">
      {events.map(e => {
        const { tag, detail } = summarize(e)
        return (
          <div key={e.id} className="timelineRow" data-type={e.type}>
            <span className="timelineTag">{tag}</span>
            <span className="timelineDetail">{detail}</span>
          </div>
        )
      })}
    </div>
  )
}
