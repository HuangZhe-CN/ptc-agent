import React from 'react'
import type { FileKind } from '@shared/protocol'

/**
 * 文件类型彩色文字小 glyph（【设计稿】§05/§08.1）。
 * - JS/CSS/HTML 等是 codicon 的例外：允许文字/彩色小 glyph（§05 像素复刻风险注）。
 * - 固定 16px slot（§17.1）：不同 kind 宽度差异不传导给 filename，防抖动。
 * - 颜色为 glyph 专属固定低饱和色（§3.4 允许范围：仅 2–3 字文字标，不作大面积使用）。
 */
const GLYPH: Record<Exclude<FileKind, 'other'>, string> = {
  js: 'JS',
  css: 'CSS',
  html: '</>',
  ts: 'TS',
  json: '{}',
  md: 'MD',
}

export function FileIcon({ kind }: { kind: FileKind }): JSX.Element {
  if (kind === 'other') {
    return (
      <span className="fileIcon fileIcon-other" aria-hidden="true">
        <i className="codicon codicon-file" />
      </span>
    )
  }
  return (
    <span className={`fileIcon fileIcon-${kind}`} aria-hidden="true">
      {GLYPH[kind]}
    </span>
  )
}
