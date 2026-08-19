import React from 'react'

/**
 * 零依赖手写 Markdown 渲染器（Task 22：【设计稿】§09 + 计划 Task 22）。
 * 支持：标题 / 加粗 / 行内码（--agent-code-bg 胶囊）/ 围栏代码块 / 有序无序列表 /
 * 链接（仅放行 http(s)）/ 段落。完成态与 thought 正文共用。
 *
 * 流式友好（§9.1）：
 * - block 按序号 key，追加文本只新增末尾 block，既有 block DOM 不重挂载；
 * - 未闭合的 ``` 围栏按"已开块"渲染到末尾，流式中不闪烁；
 * - React.memo 使 Thought 计时器等无关重渲被整树跳过（计时只更新标题节点）。
 */

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }

const FENCE = /^\s*```/
const FENCE_CLOSE = /^\s*```\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const UL_ITEM = /^\s*[-*+]\s+/
const OL_ITEM = /^\s*\d+[.)]\s+/

const isBlockStart = (l: string): boolean =>
  HEADING.test(l) || FENCE.test(l) || UL_ITEM.test(l) || OL_ITEM.test(l)

function parseBlocks(src: string): Block[] {
  const lines = src.split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }

    if (FENCE.test(line)) { // 围栏代码块（流式未闭合则渲染到末尾）
      const buf: string[] = []
      i += 1
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) { buf.push(lines[i]); i += 1 }
      if (i < lines.length) i += 1 // 消费闭合 ```
      blocks.push({ kind: 'code', text: buf.join('\n') })
      continue
    }
    const h = HEADING.exec(line)
    if (h) { blocks.push({ kind: 'h', level: h[1].length, text: h[2].trim() }); i += 1; continue }

    if (UL_ITEM.test(line)) {
      const items: string[] = []
      while (i < lines.length && UL_ITEM.test(lines[i])) {
        const item = lines[i].replace(UL_ITEM, '').trim()
        if (item) items.push(item)
        i += 1
      }
      blocks.push({ kind: 'ul', items }); continue
    }
    if (OL_ITEM.test(line)) {
      const items: string[] = []
      while (i < lines.length && OL_ITEM.test(lines[i])) {
        const item = lines[i].replace(OL_ITEM, '').trim()
        if (item) items.push(item)
        i += 1
      }
      blocks.push({ kind: 'ol', items }); continue
    }

    const buf: string[] = [line.trim()] // 段落：空行/块起点结束，段内换行折叠为空格
    i += 1
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      buf.push(lines[i].trim()); i += 1
    }
    blocks.push({ kind: 'p', text: buf.join(' ') })
  }
  return blocks
}

/** 行内元素：`code` / **bold** / [text](http(s) url)，其余按原文（React 自带转义） */
const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]*\]\([^)\s]+\))/g

function safeHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let n = 0
  INLINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const k = `${keyPrefix}.${n++}`
    if (tok.startsWith('`')) {
      out.push(<code key={k} className="mdInlineCode">{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith('**')) {
      out.push(<strong key={k} className="mdBold">{tok.slice(2, -2).trim()}</strong>)
    } else {
      const lm = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok)
      if (lm) {
        const label = lm[1] || lm[2]
        const href = safeHref(lm[2])
        out.push(href !== undefined
          ? <a key={k} className="mdLink" href={href} title={href}>{label}</a>
          : <span key={k}>{label}</span>)
      } else out.push(tok)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export const Markdown = React.memo(function Markdown({ source }: { source: string }): JSX.Element {
  const blocks = parseBlocks(source)
  return (
    <div className="markdown">
      {blocks.map((b, i) => {
        const key = String(i)
        switch (b.kind) {
          case 'h':
            return (
              <div key={key} className={`mdHeading mdH${Math.min(b.level, 4)}`}>
                {renderInline(b.text, key)}
              </div>
            )
          case 'code':
            return <pre key={key} className="mdCodeBlock"><code>{b.text}</code></pre>
          case 'ul':
            return (
              <ul key={key} className="mdList">
                {b.items.map((it, j) => <li key={j}>{renderInline(it, `${key}-${j}`)}</li>)}
              </ul>
            )
          case 'ol':
            return (
              <ol key={key} className="mdList mdListOrdered">
                {b.items.map((it, j) => <li key={j}>{renderInline(it, `${key}-${j}`)}</li>)}
              </ol>
            )
          default:
            return <p key={key} className="mdPara">{renderInline(b.text, key)}</p>
        }
      })}
    </div>
  )
})
