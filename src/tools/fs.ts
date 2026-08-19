import { readFile, writeFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolDef } from './registry'
import { countLineDiff } from '../review/diffCount'

const resolve = (cwd: string, p: string) => path.resolve(cwd, p)

export const readFileTool: ToolDef = {
  name: 'read_file', concurrencySafe: true,
  async execute(args, ctx) {
    const { path: p, offset = 1, limit = 2000 } = args as { path: string; offset?: number; limit?: number }
    const buf = await readFile(resolve(ctx.cwd, p))
    if (buf.subarray(0, 8192).includes(0)) throw new Error(`read_file: ${p} is a binary file`)
    const lines = buf.toString('utf8').split('\n')
    const totalLines = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    const start = Math.max(1, offset)
    const slice = lines.slice(start - 1, start - 1 + limit).join('\n')
    return { content: slice, totalLines, startLine: start }
  },
}

export const writeFileTool: ToolDef = {
  name: 'write_file', concurrencySafe: false,
  async execute(args, ctx) {
    const { path: p, content } = args as { path: string; content: string }
    const abs = resolve(ctx.cwd, p)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return { path: p.replace(/\\/g, '/'), bytes: Buffer.byteLength(content, 'utf8') }
  },
}

export const editFileTool: ToolDef = {
  name: 'edit_file', concurrencySafe: false,
  async execute(args, ctx) {
    const { path: p, old_string, new_string } = args as { path: string; old_string: string; new_string: string }
    const abs = resolve(ctx.cwd, p)
    const original = await readFile(abs, 'utf8')
    const count = original.split(old_string).length - 1
    if (count === 0) throw new Error(`edit_file: old_string not found in ${p}`)
    if (count > 1) throw new Error(`edit_file: old_string must be unique in ${p} (found ${count})`)
    const updated = original.replace(old_string, new_string)
    await writeFile(abs, updated, 'utf8')
    const { add, del } = countLineDiff(original, updated)
    return { path: p.replace(/\\/g, '/'), add, del }
  },
}
