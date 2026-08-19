import React, { useEffect, useState } from 'react'
import type { TimelineEvent } from '@shared/protocol'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import { vscodeApi } from '../../api'
import { EventRow } from './EventRow'
import { Markdown } from '../shared/Markdown'

type ThoughtEv = Extract<TimelineEvent, { type: 'thought' }>

/** vscodeApi 持久化 UI 的最小形状（Task 26 由 store.persistUi 正式接管；本任务组件内读写） */
interface PersistedUi { expandedThoughtIds?: string[]; queueOpen?: boolean; reviewOpen?: boolean }

function readPrefs(): PersistedUi {
  try { return (vscodeApi.getState<PersistedUi>() ?? {}) as PersistedUi } catch { return {} }
}

/**
 * 计时标签（【设计稿】§09/§15）：
 * - "Thinking for Ns" 1Hz 更新，只重绘本标题节点（隔离为子组件，避免整行/整树重渲）；
 * - 无数字滚动动画；done 后冻结：优先用 host 在 message_done 固化的 durationMs
 *   （会话重放/快照恢复时避免 Date.now()-startedAt 的墙钟差），旧事件无该字段则回退最后 tick。
 */
function ThoughtLabel({ status, startedAt, durationMs, locale }: {
  status: 'running' | 'done'
  startedAt: number
  durationMs?: number
  locale: string
}): JSX.Element {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (status !== 'running') return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [status])
  const seconds = status === 'done' && typeof durationMs === 'number'
    ? Math.max(0, Math.round(durationMs / 1000))
    : Math.max(0, Math.round((now - startedAt) / 1000))
  return (
    <>
      {t(locale, status === 'running' ? 'event.thought.thinking' : 'event.thought.thought', { n: seconds })}
    </>
  )
}

/**
 * Thought 事件（§08.2/§09）：
 * - running：展开 + 流式 markdown（Markdown memo + block 序号 key，追加式渲染不重挂载容器）；
 *   正文下方 "Working…" 实时尾标单独一行（working 字段，secondary 色）；
 * - done：折叠为一行 "Thought for Ns"（用户手动展开过则保持展开）；
 * - 展开态经 vscodeApi.getState() 记忆（仅在组件内 import api.ts，store.ts 保持 node 可加载）。
 */
export function ThoughtEvent({ event }: { event: ThoughtEv }): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  // 用户手选优先；默认 running 展开 / done 折叠（§08.2）
  const [override, setOverride] = useState<boolean | null>(() => {
    const saved = readPrefs().expandedThoughtIds
    return saved && saved.includes(event.id) ? true : null
  })
  const expanded = override ?? event.status === 'running'

  const toggle = (): void => {
    const next = !expanded
    setOverride(next)
    // 记忆展开态：组件内直写 vscodeApi（persistUi 占位由 Task 26 接管同一持久层）
    const prefs = readPrefs()
    const ids = new Set(prefs.expandedThoughtIds ?? [])
    if (next) ids.add(event.id)
    else ids.delete(event.id)
    const expandedIds = [...ids]
    const nextPrefs: PersistedUi = { ...prefs, expandedThoughtIds: expandedIds }
    try { vscodeApi.setState(nextPrefs) } catch { /* host 不可达 */ }
    useAgentStore.getState().persistUi({
      expandedThoughtIds: expandedIds,
      queueOpen: !!nextPrefs.queueOpen,
      reviewOpen: !!nextPrefs.reviewOpen,
    })
  }

  return (
    <EventRow
      label={<ThoughtLabel status={event.status} startedAt={event.startedAt} durationMs={event.durationMs} locale={locale} />}
      disclosure
      expanded={expanded}
      onToggle={toggle}
    >
      <div className="thoughtBody">
        <Markdown source={event.markdown} />
        {event.status === 'running' && (
          <div className="thoughtWorking">{event.working || t(locale, 'event.thought.working')}</div>
        )}
      </div>
    </EventRow>
  )
}
