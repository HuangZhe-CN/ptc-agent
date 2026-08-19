import React, { useState, type KeyboardEvent } from 'react'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import { ModelTrigger } from './ModelTrigger'
import { QueuePanel } from '../Floaters/QueuePanel'

/**
 * 设计稿 §07/§12 Composer：
 * - 圆角 capture ≈22–26（382w 11–13）→ calc(var(--scale) * 26px)
 * - 高 capture ≈118–120（382w 59–60）→ calc(var(--scale) * 120px)
 * - 底部左：＋ / 模型名 / quality / chevron（ModelTrigger；popover 由 Task 24 接管）
 * - 右主按钮（§12.2 状态机）：idle|completed=send 圆钮（primary token）；
 *   running=Stop 方块 glyph（--agent-error）置于浅色圆底，外圆容器不变，
 *   80–120ms cross-fade（§15）
 * - Enter 发送 / Shift+Enter 换行；running 时 Enter 仍发 submit（host 负责入队）；
 *   中文输入法组词期 Enter 不触发（isComposing 守卫）
 * - Task 24：顶部挂 QueuePanel（§11 队列卡位于 Composer 正上方、同宽，
 *   流式占位由 .composerWrap 承担——queue 为空时组件返回 null，不留间隙）
 */
export function Composer(): JSX.Element {
  const phase = useAgentStore(s => s.phase)
  const send = useAgentStore(s => s.send)
  const locale = useAgentStore(s => s.locale)
  const [text, setText] = useState('')

  const running = phase === 'running' || phase === 'submitting'

  const doSubmit = (): void => {
    const value = text.trim()
    if (!value) return
    send({ type: 'submit', text: value })   // running 时同样照发——host 判定入队
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      doSubmit()
    }
  }

  const actionLabel = running ? t(locale, 'composer.stop') : t(locale, 'composer.send')

  return (
    <div className="composerWrap">
      <QueuePanel />
      <div className="composer">
        <textarea
          className="composerInput"
          value={text}
          rows={1}
          spellCheck={false}
          placeholder={t(locale, 'composer.placeholder')}
          aria-label={t(locale, 'composer.placeholder')}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composerActions">
          <div className="composerLeft">
            {/* ＋ 附加操作：行为待后续任务定义，先静态占位（§07.1 底部左侧控件之一） */}
            <button type="button" className="iconButton" aria-hidden="true" tabIndex={-1}>
              <i className="codicon codicon-add" />
            </button>
            <ModelTrigger />
          </div>
          <button
            type="button"
            className={running ? 'primaryAction running' : 'primaryAction'}
            disabled={!running && !text.trim()}
            aria-label={actionLabel}
            title={actionLabel}
            onClick={() => (running ? send({ type: 'stop' }) : doSubmit())}
          >
            {/* 两个 glyph 常驻 DOM，靠 opacity cross-fade；外圆尺寸不变（§15） */}
            <i className="codicon codicon-send primaryGlyph" aria-hidden="true" />
            <i className="codicon codicon-debug-stop primaryGlyph stopGlyph" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
