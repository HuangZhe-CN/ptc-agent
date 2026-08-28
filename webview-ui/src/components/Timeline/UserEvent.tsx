import React from 'react'
import type { TimelineEvent } from '@shared/protocol'

type UserEv = Extract<TimelineEvent, { type: 'user' }>

/**
 * 用户消息气泡（§08 时间线事件族补位）：回合起点上屏的用户原文，先于本轮 assistant 事件。
 * 纯文本渲染，pre-wrap 保留换行；右对齐气泡与 assistant 事件（左起点）区分对话双方。
 * 带图消息：缩略图网格在文本上方（Composer 粘贴/选择的附件原样重放）。
 */
export function UserEvent({ event }: { event: UserEv }): JSX.Element {
  return (
    <div className="eventRow userRow">
      <div className="userBubble">
        {event.images?.length ? (
          <div className="userImages">
            {event.images.map((img, i) => (
              <img key={i} className="userImage" src={`data:${img.mime};base64,${img.base64}`} alt="" draggable={false} />
            ))}
          </div>
        ) : null}
        {event.text}
      </div>
    </div>
  )
}
