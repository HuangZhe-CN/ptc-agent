import React, { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useAgentStore } from '../../store'
import { ft } from './floatersText'
import './floaters.css'

/**
 * Task 24：Queued Messages 浮层（设计稿 §11/§11.2/§15/§20）。
 * - 位置：Dock 内 Composer 正上方、同宽（由 Composer 外层 .composerWrap 承担流式占位，
 *   队列出现时自然把 dock 撑高，Composer 保持贴底——§11「Composer 向下保持贴底」）。
 * - header：标题 semibold + 圆形计数 badge + 说明 muted + chevron 旋转展开（160–220ms grid + opacity）。
 * - 行：codicon-comment + 摘要 ellipsis + 右 send/edit/trash 三操作；行高 ≈20 CSS px 无分隔线。
 * - 编辑：行内 textarea，Enter 确认 queueEdit（Esc 取消；中文输入法组词期 Enter 不触发）。
 * - 出现 140–180ms translateY(6→0)+opacity，无 spring；queue 为空不渲染。
 */
export function QueuePanel(): JSX.Element | null {
  const locale = useAgentStore(s => s.locale)
  const queue = useAgentStore(s => s.queue)
  const send = useAgentStore(s => s.send)

  const [open, setOpen] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  if (queue.length === 0) return null

  const commitEdit = (id: string): void => {
    const text = draft.trim()
    if (text) send({ type: 'queueEdit', id, text })
    setEditingId(null)
  }

  const onEditKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>, id: string): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      commitEdit(id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setEditingId(null)
    }
  }

  return (
    <section className={open ? 'queuePanel isOpen' : 'queuePanel'} aria-label={ft(locale, 'queue.title')}>
      <button
        type="button"
        className="queueHeader"
        aria-expanded={open}
        aria-label={ft(locale, 'queue.toggle')}
        onClick={() => setOpen(v => !v)}
      >
        <span className="queueTitle">{ft(locale, 'queue.title')}</span>
        <span className="queueBadge" aria-hidden="true">{queue.length}</span>
        <span className="queueHint">{ft(locale, 'queue.hint')}</span>
        <i className="codicon codicon-chevron-down queueChevron" aria-hidden="true" />
      </button>
      <div className="queueBody">
        <div className="queueBodyInner">
          {queue.map(m =>
            editingId === m.id ? (
              <div className="queueRow isEditing" key={m.id}>
                <i className="codicon codicon-comment queueRowIcon" aria-hidden="true" />
                <textarea
                  className="queueEditInput"
                  value={draft}
                  rows={1}
                  autoFocus
                  spellCheck={false}
                  aria-label={ft(locale, 'queue.edit')}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => onEditKeyDown(e, m.id)}
                />
                <span className="queueRowActions">
                  <button
                    type="button"
                    className="queueAction"
                    aria-label={ft(locale, 'queue.editConfirm')}
                    onClick={() => commitEdit(m.id)}
                  >
                    <i className="codicon codicon-check" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="queueAction"
                    aria-label={ft(locale, 'queue.editCancel')}
                    onClick={() => setEditingId(null)}
                  >
                    <i className="codicon codicon-close" aria-hidden="true" />
                  </button>
                </span>
              </div>
            ) : (
              <div className="queueRow" key={m.id}>
                <i className="codicon codicon-comment queueRowIcon" aria-hidden="true" />
                <span className="queueText" title={m.text}>{m.text}</span>
                <span className="queueRowActions">
                  <button
                    type="button"
                    className="queueAction"
                    aria-label={ft(locale, 'queue.send')}
                    title={ft(locale, 'queue.send')}
                    onClick={() => send({ type: 'queueSubmitNow', id: m.id })}
                  >
                    <i className="codicon codicon-send" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="queueAction"
                    aria-label={ft(locale, 'queue.edit')}
                    title={ft(locale, 'queue.edit')}
                    onClick={() => { setEditingId(m.id); setDraft(m.text) }}
                  >
                    <i className="codicon codicon-edit" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="queueAction"
                    aria-label={ft(locale, 'queue.delete')}
                    title={ft(locale, 'queue.delete')}
                    onClick={() => send({ type: 'queueDelete', id: m.id })}
                  >
                    <i className="codicon codicon-trash" aria-hidden="true" />
                  </button>
                </span>
              </div>
            )
          )}
        </div>
      </div>
    </section>
  )
}
