import type { FileKind } from '../shared/protocol'

/** 文件后缀 → FileKind（与 agent/events.ts 的映射保持同一实现，Task 15 起 loop 侧从此处 import）。 */
const KIND: Record<string, FileKind> = { js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', css: 'css', html: 'html', json: 'json', md: 'md' }
export const fileKindOf = (file: string): FileKind => KIND[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'other'
