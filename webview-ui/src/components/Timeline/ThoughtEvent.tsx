import React, { useEffect, useState } from 'react'
import type { TimelineEvent } from '@shared/protocol'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import { EventRow } from './EventRow'
import { Markdown } from '../shared/Markdown'

type ThoughtEv = Extract<TimelineEvent, { type: 'thought' }>

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
 * 展开记忆键：会话前缀 + 事件 id（sessionId 形如 s+base36，SESSION_ID_RE 不含 ':'；事件 id 为 u/e/err/c+数字——分隔符无歧义）。
 * 加前缀的原因：宿主每次 webview 重开都新建 AgentService，事件 id 空间（idSeq）从低位重排；openSession 又会回放
 * 旧世代的 'eN'——裸 id 跨会话天然碰撞，持久化的展开记录会在新会话/重开的旧会话里误展开用户从未碰过的 thought。
 * 按会话隔离后：其他会话/旧世代的陈旧记录不再命中，同一会话重开仍能正确恢复展开态。
 */
const thoughtKey = (sessionId: string | null, eventId: string): string => `${sessionId}:${eventId}`

/**
 * Thought 事件（§08.2/§09）：
 * - running：展开 + 流式 markdown（Markdown memo + block 序号 key，追加式渲染不重挂载容器）；
 *   正文下方 "Working…" 实时尾标单独一行（working 字段，secondary 色）；
 * - done：折叠为一行 "Thought for Ns"（用户手动展开过则保持展开）；
 * - 展开态经 store.ui.expandedThoughtIds 记忆（Task 26 统一收口：setUiPref 合并 +
 *   main.tsx 注入的持久化通道写 vscodeApi，组件不再直写 api；键含会话前缀，防跨会话 id 碰撞——见 thoughtKey）。
 */
export function ThoughtEvent({ event }: { event: ThoughtEv }): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  // 用户手选优先；默认 running 展开 / done 折叠（§08.2）；展开记忆按会话前缀存取（thoughtKey）
  const [override, setOverride] = useState<boolean | null>(() => {
    const { sessionId, ui } = useAgentStore.getState()
    return ui.expandedThoughtIds.includes(thoughtKey(sessionId, event.id)) ? true : null
  })
  const expanded = override ?? event.status === 'running'

  // 挂载即自愈修剪：只保留当前会话前缀的展开记录——旧格式裸 id 与其他会话的陈旧条目就此清除，
  // 持久化列表收敛为当前会话规模（治无界增长）。getState 取实时态，仅在确有删减时写回（幂等，无重挂载循环）
  useEffect(() => {
    const { sessionId, ui } = useAgentStore.getState()
    const prefix = `${sessionId}:`
    if (ui.expandedThoughtIds.some(id => !id.startsWith(prefix))) {
      useAgentStore.getState().setUiPref({ expandedThoughtIds: ui.expandedThoughtIds.filter(id => id.startsWith(prefix)) })
    }
  }, [])

  const toggle = (): void => {
    const next = !expanded
    setOverride(next)
    // 记忆展开态：统一走 store.ui（持久化由 store.setUiPref 经注入通道完成）；键含会话前缀（thoughtKey）
    const ids = new Set(useAgentStore.getState().ui.expandedThoughtIds)
    const key = thoughtKey(useAgentStore.getState().sessionId, event.id)
    if (next) ids.add(key)
    else ids.delete(key)
    useAgentStore.getState().setUiPref({ expandedThoughtIds: [...ids] })
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
