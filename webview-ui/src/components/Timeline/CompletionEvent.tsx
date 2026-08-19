import React from 'react'
import type { TimelineEvent } from '@shared/protocol'
import { useAgentStore } from '../../store'
import { Markdown } from '../shared/Markdown'
import { openReviewPanel } from '../Review/ReviewPanel'
import { rv } from '../Review/reviewText'
import '../Review/review.css'

type CompletionEv = Extract<TimelineEvent, { type: 'completion' }>

/**
 * 完成态事件（【设计稿】§13.1/§10.3，计划 Task 23）：
 * - 正文直接输出 Markdown-like 内容（流式期间即渲染，Markdown memo 追加式更新）；
 *   正文落在背景上不加总卡片，段落间自然 vertical rhythm；
 * - 正文下方 files changed 汇总卡：`N files changed +X -Y >`（codicon-diff）+
 *   右侧 Review 按钮 → 打开 ReviewPanel（汇总数字随 state.changes 联动）。
 */
export function CompletionEvent({ event }: { event: CompletionEv }): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const changes = useAgentStore(s => s.changes)

  const totalAdd = changes.reduce((n, c) => n + c.add, 0)
  const totalDel = changes.reduce((n, c) => n + c.del, 0)

  return (
    <div className="eventRow completionRow">
      <div className="completionBody">
        <Markdown source={event.markdown} />
      </div>
      {changes.length > 0 && (
        <div className="filesChangedCard">
          <button
            type="button"
            className="filesChangedSummary"
            onClick={openReviewPanel}
          >
            <i className="codicon codicon-diff" aria-hidden="true" />
            <span className="filesChangedLabel">
              {rv(locale, 'card.filesChanged', { n: changes.length })}
            </span>
            <span className="reviewDiff">
              <span className="reviewDiffAdd">+{totalAdd}</span>
              <span className="reviewDiffDel">-{totalDel}</span>
            </span>
            <i className="codicon codicon-chevron-right filesChangedChevron" aria-hidden="true" />
          </button>
          <button type="button" className="reviewButton" onClick={openReviewPanel}>
            {rv(locale, 'card.review')}
          </button>
        </div>
      )}
    </div>
  )
}
