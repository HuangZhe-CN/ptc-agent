import React from 'react'
import type { TimelineEvent } from '@shared/protocol'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import { EventRow } from './EventRow'
import { FileIcon } from '../shared/FileIcon'

type EditEv = Extract<TimelineEvent, { type: 'edit' }>

/**
 * Edit 事件（§08.2）："Edited + FileIcon + filename + +N -N"，无外层卡片、无 disclosure。
 * diff 用 tabular-nums + 绿 --agent-add / 红 --agent-delete（§17.1）。
 */
export function EditEvent({ event }: { event: EditEv }): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  return (
    <EventRow
      label={t(locale, 'event.edit.label')}
      icon={<FileIcon kind={event.fileKind} />}
      target={event.file}
      diff={{ add: event.add, del: event.del }}
    />
  )
}
