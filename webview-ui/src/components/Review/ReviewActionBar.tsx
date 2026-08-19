import React from 'react'
import { useAgentStore } from '../../store'
import { rv } from './reviewText'
import './review.css'

/**
 * ReviewActionBar（【设计稿】§13.2 底部 bar，计划 Task 23）：
 * - sticky 于 Dock 上方：AgentView 渲染于 agentScroll 与 agentDock 之间（grid 独立行），
 *   不在滚动容器内，天然 sticky，视觉上紧贴 Composer 上方，像第二层 Dock；
 * - codicon-arrow-left（关闭面板）+ "N Files With Changes"（changes 更新后计数联动）
 *   + Reject all（secondary）+ Accept all（primary 实心，radius 小于 composer）；
 * - Accept/Reject all → send({type:'reviewAccept'|'reviewReject'})（无 path = 全部）。
 */
export function ReviewActionBar({ onClose }: { onClose: () => void }): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const changes = useAgentStore(s => s.changes)

  const reviewAll = (kind: 'reviewAccept' | 'reviewReject'): void => {
    // 无 path = 全部接受/拒绝（WebviewMessage 契约）
    useAgentStore.getState().send({ type: kind })
  }

  return (
    <div className="reviewActionBar" role="toolbar" aria-label={rv(locale, 'bar.filesWithChanges', { n: changes.length })}>
      <button
        type="button"
        className="iconButton"
        title={rv(locale, 'bar.close')}
        aria-label={rv(locale, 'bar.close')}
        onClick={onClose}
      >
        <i className="codicon codicon-arrow-left" aria-hidden="true" />
      </button>
      <span className="reviewCountTitle">
        {rv(locale, 'bar.filesWithChanges', { n: changes.length })}
      </span>
      <span className="reviewBarSpacer" />
      <button type="button" className="reviewRejectAll" onClick={() => reviewAll('reviewReject')}>
        {rv(locale, 'bar.rejectAll')}
      </button>
      <button type="button" className="reviewAcceptAll" onClick={() => reviewAll('reviewAccept')}>
        {rv(locale, 'bar.acceptAll')}
      </button>
    </div>
  )
}
