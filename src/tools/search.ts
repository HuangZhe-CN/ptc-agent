import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'
import type { ToolDef } from './registry'

const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'out', '.vscode'])
/** grep 单文件读取上限：超大文件跳过（防撑爆扩展宿主内存） */
const GREP_MAX_BYTES = 8 * 1024 * 1024

export function globToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i += 2; if (pattern[i] === '/') i++; continue }
      re += '[^/]*'; i++
    } else if (c === '?') { re += '[^/]'; i++ }
    else if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) { re += '\\{'; i++; continue }   // 未闭合 '{'：按字面量（end=-1 会使 i 回绕起点造成死循环）
      re += `(?:${pattern.slice(i + 1, end).split(',').join('|')})`; i = end + 1
    } else if ('\\.[]()^$+|'.includes(c)) { re += `\\${c}`; i++ }
    else { re += c; i++ }
  }
  return new RegExp(`^${re}$`)
}

async function* walk(dir: string, rel: string[] = []): AsyncGenerator<string> {
  let entries: Dirent[]
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }   // EPERM/junction/权限：跳过该目录
  for (const ent of entries) {
    if (EXCLUDE.has(ent.name)) continue
    if (ent.isDirectory()) yield* walk(path.join(dir, ent.name), [...rel, ent.name])
    else if (ent.isFile()) yield [...rel, ent.name].join('/')
  }
}

export const globTool: ToolDef = {
  name: 'glob', concurrencySafe: true,
  async execute(args, ctx) {
    const { pattern } = args as { pattern: string; path?: string }
    const root = path.resolve(ctx.cwd, (args as { path?: string }).path ?? '.')
    const dirOnly = pattern.endsWith('/')
    const re = globToRegExp(dirOnly ? pattern.slice(0, -1) : pattern)
    const matches: string[] = []
    const prefix = path.relative(ctx.cwd, root).replace(/\\/g, '/')
    for await (const rel of walk(root)) {
      const full = prefix && prefix !== '.' ? `${prefix}/${rel}` : rel
      if (re.test(rel) || re.test(full)) { matches.push(full); if (matches.length >= 200) break }
    }
    return { matches }
  },
}

export const grepTool: ToolDef = {
  name: 'grep', concurrencySafe: true,
  async execute(args, ctx) {
    const { query, glob: pattern } = args as { query: string; glob?: string; path?: string }
    const root = path.resolve(ctx.cwd, (args as { path?: string }).path ?? '.')
    const re = pattern ? globToRegExp(pattern) : null
    const matches: { file: string; line: number; text: string }[] = []
    const prefix = path.relative(ctx.cwd, root).replace(/\\/g, '/')
    outer: for await (const rel of walk(root)) {
      if (re && !re.test(rel)) continue
      const abs = path.join(root, rel)
      let content: string
      try {
        if ((await stat(abs)).size > GREP_MAX_BYTES) continue
        content = await readFile(abs, 'utf8')
      } catch { continue }
      if (content.includes('\0')) continue
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(query)) {
          matches.push({ file: prefix && prefix !== '.' ? `${prefix}/${rel}` : rel, line: i + 1, text: lines[i].slice(0, 500) })
          if (matches.length >= 200) break outer
        }
      }
    }
    return { matches }
  },
}
