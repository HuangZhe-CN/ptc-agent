import { describe, it, expect, beforeAll, vi } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createTools } from '../src/tools/registry'

// 透传 mock：仅记录全部 spawn 调用（含 killTree 内的 taskkill），行为不变——用于断言陈旧 PID 不再被击杀
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
const spawnMock = vi.mocked(spawn)

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
  it('glob 目录形态（尾 /）命中该目录下全部文件；grep 的 glob 参数同口径', async () => {
    await mkdir(path.join(cwd, 'pkg'), { recursive: true })
    await writeFile(path.join(cwd, 'pkg', 'x.md'), 'needle\n')
    await writeFile(path.join(cwd, 'top.md'), 'needle\n')
    const g = await createTools().get('glob')!.execute({ pattern: 'pkg/' }, { cwd, signal: new AbortController().signal })
    expect(g).toEqual({ matches: ['pkg/x.md'] })   // 修复前 /^pkg$/ 无文件路径可整串匹配 → 恒 []
    const r = await createTools().get('grep')!.execute({ query: 'needle', glob: 'pkg/' }, { cwd, signal: new AbortController().signal })
    expect(r).toEqual({ matches: [{ file: 'pkg/x.md', line: 1, text: 'needle' }] })   // 目录外同名内容被滤除
    const all = (await createTools().get('glob')!.execute({ pattern: '**/' }, { cwd, signal: new AbortController().signal })) as { matches: string[] }
    expect(all.matches.sort()).toEqual(['a.js', 'pkg/x.md', 'sub/b.ts', 'top.md'])   // '**/' 仍覆盖根级文件
  })
  it('bash 执行并捕获（Windows 上 echo）', async () => {
    const r = await createTools().get('bash')!.execute({ command: process.platform === 'win32' ? 'echo ptc-ok' : 'echo ptc-ok' }, { cwd, signal: new AbortController().signal })
    expect((r as { stdout: string }).stdout).toContain('ptc-ok')
    expect((r as { exitCode: number }).exitCode).toBe(0)
  })
  it('bash 完成后回合 signal 才 abort：监听器已随 close 摘除 + killTree 存活守卫，不再对陈旧 PID 补发 taskkill', async () => {
    const controller = new AbortController()
    const r = await createTools().get('bash')!.execute({ command: 'echo bye' }, { cwd, signal: controller.signal })
    expect((r as { exitCode: number }).exitCode).toBe(0)
    const before = spawnMock.mock.calls.length
    controller.abort()   // 模拟回合在 bash 结束后才中止（模型流式输出/后续工具轮期间）
    await new Promise(resolve => setTimeout(resolve, 50))   // 给潜在 taskkill 入队留时间窗
    expect(spawnMock.mock.calls.length).toBe(before)   // 无新 spawn（旧实现会对已退出 PID 补发 taskkill /T /F，PID 复用时误杀无关进程树）
  }, 10_000)
  it('bash 进行中 abort 仍正常击杀：存活守卫不误伤运行中的 kill（win32 可见 taskkill）', async () => {
    const controller = new AbortController()
    const p = createTools().get('bash')!.execute({ command: 'node -e "setTimeout(()=>{},30000)"' }, { cwd, signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 400))   // 等 shell 与 node 子进程起来
    const before = spawnMock.mock.calls.length
    controller.abort()
    const r = await p
    expect((r as { timedOut: boolean }).timedOut).toBe(true)
    if (process.platform === 'win32') expect(spawnMock.mock.calls.length).toBeGreaterThan(before)   // taskkill 已实际发起
  }, 15_000)
  it('bash 输出跨 chunk 的多字节字符不再拆成 U+FFFD（流设 utf8 编码经 StringDecoder 拼装）', async () => {
    const r = await createTools().get('bash')!.execute(
      { command: `node -e "process.stdout.write('你好世界'.repeat(60000))"` },   // 720KB 密集中文 → 必然跨多个 data chunk
      { cwd, signal: new AbortController().signal },
    )
    const stdout = (r as { stdout: string }).stdout
    expect(stdout.startsWith('你好世界')).toBe(true)
    expect(stdout).not.toContain('�')   // 旧实现按 data 块独立 toString，切点落在字符中段即两侧各出一个替换符
  }, 20_000)
  it('edit_file 替换值按字面写入：$$/$&/$\' 不被当作替换模式展开', async () => {
    // Makefile/bash 的 $$、正则替换风格的 $&/$' 一旦经 String.replace 字符串参数展开，写入内容即被静默损坏
    const f = path.join(cwd, 'dollar.txt')
    await writeFile(f, 'cost = 5\nflag & here\nquote me\n')
    const tool = createTools().get('edit_file')!
    await tool.execute({ path: 'dollar.txt', old_string: 'cost = 5', new_string: 'echo $$' }, { cwd, signal: new AbortController().signal })
    await tool.execute({ path: 'dollar.txt', old_string: 'flag & here', new_string: 'X$&Y' }, { cwd, signal: new AbortController().signal })
    await tool.execute({ path: 'dollar.txt', old_string: 'quote me', new_string: "A$'B" }, { cwd, signal: new AbortController().signal })
    expect(await readFile(f, 'utf8')).toBe('echo $$\nX$&Y\nA$\'B\n')
  })
  it('write_file 建目录写文件，返回与 Review 面板同口径的 add/del', async () => {
    const r = await createTools().get('write_file')!.execute({ path: 'new/dir/c.txt', content: 'x' }, { cwd, signal: new AbortController().signal })
    expect(r).toEqual({ path: 'new/dir/c.txt', bytes: 1, add: 1, del: 0 })   // 新文件：旧内容为空，全行新增
    const r2 = await createTools().get('write_file')!.execute({ path: 'new/dir/c.txt', content: 'x\ny\nz\n' }, { cwd, signal: new AbortController().signal })
    expect(r2).toEqual({ path: 'new/dir/c.txt', bytes: 6, add: 2, del: 0 })  // 覆盖：对旧内容做行级 diff
    const r3 = await createTools().get('write_file')!.execute({ path: 'new/dir/c.txt', content: 'x\ns\n' }, { cwd, signal: new AbortController().signal })
    expect(r3).toEqual({ path: 'new/dir/c.txt', bytes: 4, add: 1, del: 2 })
  })
})
