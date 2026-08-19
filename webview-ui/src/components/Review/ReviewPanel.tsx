import React from 'react'
import { useAgentStore } from '../../store'
import { rv } from './reviewText'
import './review.css'

/**
 * 「打开审阅」的跨组件信号（Task 23 受控约束：reviewOpen 状态住在 AgentView，
 * store.ts/i18n.ts/tokens.css 均不可改，故用 window CustomEvent 解耦；
 * Task 26 persistUi 统一收口时若迁移为 store 字段，此处仅改这一个模块）。
 */
export const OPEN_REVIEW_EVENT = 'ptc-agent:open-review'
export function openReviewPanel(): void {
  try { window.dispatchEvent(new CustomEvent(OPEN_REVIEW_EVENT)) } catch { /* 非 DOM 环境 */ }
}

/** path 形如 a/b/c.tsx（host 侧已归一为 /）：尾段为 filename，其余为 muted path */
function splitPath(p: string): { name: string; dir: string } {
  const i = p.lastIndexOf('/')
  return i === -1 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i + 1) }
}

/** 新增文件 = 无删除行（§13.2：codicon-add 新增 / codicon-file 修改） */
function isNewFile(del: number): boolean {
  return del === 0
}

/**
 * Review Inline Panel（【设计稿】§13.2，计划 Task 23）：
 * - 属于 mainScroll 内容（AgentView 在 Timeline 之后渲染）；
 * - 文件行：新增/修改 glyph + +N -N（tabular 绿/红）+ filename(semibold) + path(muted ellipsis)；
 *   点击行 → send({type:'reviewFile', path})（host 打开 vscode.diff）；
 * - 底部反馈区 copy / thumbs-up / thumbs-down（右对齐低对比，本版本纯 UI）。
 */
export function ReviewPanel(): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const changes = useAgentStore(s => s.changes)

  const openDiff = (path: string): void => {
    useAgentStore.getState().send({ type: 'reviewFile', path })
  }

  return (
    <div className="reviewPanel">
      <div className="reviewFileList">
        {changes.length === 0 && <div className="reviewEmpty">{rv(locale, 'panel.empty')}</div>}
        {changes.map(c => {
          const { name, dir } = splitPath(c.path)
          const isNew = isNewFile(c.del)
          return (
            <button
              key={c.path}
              type="button"
              className="reviewFileRow"
              title={rv(locale, 'panel.openDiff')}
              aria-label={`${rv(locale, 'panel.openDiff')}: ${c.path}`}
              onClick={() => openDiff(c.path)}
            >
              <span
                className={`reviewFileGlyph${isNew ? ' isNew' : ''}`}
                title={rv(locale, isNew ? 'panel.newFile' : 'panel.modifiedFile')}
              >
                <i className={`codicon ${isNew ? 'codicon-add' : 'codicon-file'}`} aria-hidden="true" />
              </span>
              <span className="reviewDiff">
                <span className="reviewDiffAdd">+{c.add}</span>
                <span className="reviewDiffDel">-{c.del}</span>
              </span>
              <span className="reviewFileName">{name}</span>
              {dir && <span className="reviewFilePath" title={c.path}>{dir}</span>}
            </button>
          )
        })}
      </div>
      <div className="reviewFeedback">
        <button
          type="button"
          className="reviewFeedbackBtn"
          title={rv(locale, 'feedback.copy')}
          aria-label={rv(locale, 'feedback.copy')}
        >
          <i className="codicon codicon-copy" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="reviewFeedbackBtn"
          title={rv(locale, 'feedback.helpful')}
          aria-label={rv(locale, 'feedback.helpful')}
        >
          <i className="codicon codicon-thumbs-up" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="reviewFeedbackBtn"
          title={rv(locale, 'feedback.notHelpful')}
          aria-label={rv(locale, 'feedback.notHelpful')}
        >
          <i className="codicon codicon-thumbs-down" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
