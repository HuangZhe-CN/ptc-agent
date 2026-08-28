import React, { useEffect, useState } from 'react'
import type { TimelineEvent } from '@shared/protocol'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import { EventRow } from './EventRow'

type RunEv = Extract<TimelineEvent, { type: 'run' }>

/**
 * Run 事件（§08.2）："Ran `command`"（command 用 codePill 样式，长命令单行截断），
 * 右侧 disclosure；展开显示 outputTail（mono、可换行）。
 * status=error 时标签（运行失败/Run failed，与 done 区分）/icon 转 --agent-error，并自动展开亮出失败原因。
 */
export function RunEvent({ event }: { event: RunEv }): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const [expanded, setExpanded] = useState(event.status === 'error')
  // 失败自动展开：错误原因直接可见，不必逐条手点 disclosure（用户手动收起后不再强制弹开）
  useEffect(() => { if (event.status === 'error') setExpanded(true) }, [event.status])
  const labelKey = event.status === 'running'
    ? 'event.run.running'
    : event.status === 'error' ? 'event.run.error' : 'event.run.done'
  return (
    <EventRow
      label={t(locale, labelKey)}
      error={event.status === 'error'}
      icon={<i className="codicon codicon-terminal" aria-hidden="true" />}
      target={<code className="codePill" title={event.command}>{event.command}</code>}
      disclosure
      expanded={expanded}
      onToggle={() => setExpanded(v => !v)}
    >
      {event.outputTail
        ? <pre className="runOutput">{event.outputTail}</pre>
        : <div className="runOutput runOutputEmpty">{t(locale, 'event.run.noOutput')}</div>}
    </EventRow>
  )
}
