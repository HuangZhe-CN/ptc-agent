import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTools } from '../src/tools/registry'

let cwd: string
beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'ptc-tools-'))
  await writeFile(path.join(cwd, 'a.js'), 'line1\nline2\nline3\n')
  await mkdir(path.join(cwd, 'sub'), { recursive: true })
  await writeFile(path.join(cwd, 'sub', 'b.ts'), 'hello world\n')
})

describe('tools', () => {
  it('read_file 默认前 2000 行 + totalLines', async () => {
    const r = await createTools().get('read_file')!.execute({ path: 'a.js' }, { cwd, signal: new AbortController().signal })
    expect(r).toEqual({ content: 'line1\nline2\nline3\n', totalLines: 3, startLine: 1 })
  })
  it('edit_file 唯一匹配替换并返回行差；不唯一报错', async () => {
    const r = await createTools().get('edit_file')!.execute({ path: 'a.js', old_string: 'line2', new_string: 'L2\nL2b' }, { cwd, signal: new AbortController().signal })
    expect(r).toMatchObject({ path: 'a.js', add: 2, del: 1 })
    await expect(createTools().get('edit_file')!.execute({ path: 'a.js', old_string: 'L2', new_string: 'x' }, { cwd, signal: new AbortController().signal }))
      .rejects.toThrow(/unique/)   // 'L2' 现在出现两次
  })
  it('glob ** 与 {a,b}', async () => {
    const r = await createTools().get('glob')!.execute({ pattern: '**/*.{js,ts}' }, { cwd, signal: new AbortController().signal })
    expect(r).toEqual({ matches: ['a.js', path.join('sub', 'b.ts').replace(/\\/g, '/')] })
  })
  it('grep 子串命中行', async () => {
    const r = await createTools().get('grep')!.execute({ query: 'hello' }, { cwd, signal: new AbortController().signal })
    expect(r).toEqual({ matches: [{ file: 'sub/b.ts', line: 1, text: 'hello world' }] })
  })
  it('bash 执行并捕获（Windows 上 echo）', async () => {
    const r = await createTools().get('bash')!.execute({ command: process.platform === 'win32' ? 'echo ptc-ok' : 'echo ptc-ok' }, { cwd, signal: new AbortController().signal })
    expect((r as { stdout: string }).stdout).toContain('ptc-ok')
    expect((r as { exitCode: number }).exitCode).toBe(0)
  })
  it('write_file 建目录写文件', async () => {
    const r = await createTools().get('write_file')!.execute({ path: 'new/dir/c.txt', content: 'x' }, { cwd, signal: new AbortController().signal })
    expect(r).toEqual({ path: 'new/dir/c.txt', bytes: 1 })
  })
})
