import { readFile, writeFile, mkdir, stat, open } from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolDef } from './registry'
import { countLineDiff } from '../review/diffCount'

const resolve = (cwd: string, p: string) => path.resolve(cwd, p)

/** read_file 单次载入上限：超限只读前 MAX_READ_BYTES（file handle 定长读，不整载入内存） */
const MAX_READ_BYTES = 8 * 1024 * 1024

export const readFileTool: ToolDef = {
  name: 'read_file', concurrencySafe: true,
  async execute(args, ctx) {
    const { path: p, offset = 1, limit = 2000 } = args as { path: string; offset?: number; limit?: number }
    const abs = resolve(ctx.cwd, p)
    const size = (await stat(abs)).size
    let buf: Buffer
    let truncated = false
    if (size > MAX_READ_BYTES) {
      truncated = true
      const fh = await open(abs, 'r')
      try {
        const chunk = Buffer.alloc(MAX_READ_BYTES)
        const { bytesRead } = await fh.read(chunk, 0, MAX_READ_BYTES, 0)
        buf = chunk.subarray(0, bytesRead)
      } finally { await fh.close() }
    } else {
      buf = await readFile(abs)
    }
    if (buf.subarray(0, 8192).includes(0)) throw new Error(`read_file: ${p} is a binary file`)
    const lines = buf.toString('utf8').split('\n')
    const totalLines = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    const start = Math.max(1, offset)
    const slice = lines.slice(start - 1, start - 1 + limit).join('\n')
    return { content: slice, totalLines, startLine: start, ...(truncated ? { truncated: true, totalBytes: size } : {}) }
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
    // CRLF 归一：匹配在 LF 视图上做（模型的 old_string 是 LF），写回按文件原 EOL 展开
    const eol = original.includes('\r\n') ? '\r\n' : '\n'
    const lfView = original.replace(/\r\n/g, '\n')
    const oldLf = old_string.replace(/\r\n/g, '\n')
    const count = lfView.split(oldLf).length - 1
    if (count === 0) throw new Error(`edit_file: old_string not found in ${p}`)
    if (count > 1) throw new Error(`edit_file: old_string must be unique in ${p} (found ${count})`)
    const updatedLf = lfView.replace(oldLf, new_string.replace(/\r\n/g, '\n'))
    const updated = eol === '\r\n' ? updatedLf.replace(/\n/g, '\r\n') : updatedLf
    await writeFile(abs, updated, 'utf8')
    const { add, del } = countLineDiff(original, updated)
    return { path: p.replace(/\\/g, '/'), add, del }
  },
}
