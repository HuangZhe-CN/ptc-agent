import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { globToRegExp } from '../src/tools/search'
import { editFileTool, readFileTool } from '../src/tools/fs'
import { CappedBuffer } from '../src/tools/bash'
import { parseSse } from '../src/protocol/sse'
import { SessionStore } from '../src/session/store'
import { AgentLoop, type LoopDeps } from '../src/agent/loop'
import type { ProtocolAdapter, StreamRequest, ResolvedProvider } from '../src/protocol/types'
import type { CodeRunResult } from '../src/runtime/codeRuntime'
import type { ToolDef } from '../src/tools/registry'
import type { StreamEvent, UiOp } from '../src/shared/protocol'

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal })

describe('globToRegExp 未闭合 {（blocker：原实现同步死循环）', () => {
  it("'{ts' 与 'a{b' 按字面量匹配，不再挂死", () => {
    const re = globToRegExp('{ts')
    expect(re.test('{ts')).toBe(true)
    expect(re.test('ts')).toBe(false)
    const re2 = globToRegExp('a{b')
    expect(re2.test('a{b')).toBe(true)
    expect(re2.test('ab')).toBe(false)
  })
  it('闭合 {a,b} alternation 语义不回归', () => {
    const re = globToRegExp('*.{ts,js}')
    expect(re.test('a.ts')).toBe(true)
    expect(re.test('a.js')).toBe(true)
    expect(re.test('a.py')).toBe(false)
  })
})

describe('edit_file CRLF 归一（LF 视图匹配、写回保持原 EOL）', () => {
  it('CRLF 文件 + LF old_string 匹配成功，写回仍是 CRLF', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ptc-crlf-'))
    await writeFile(path.join(cwd, 'crlf.txt'), 'line1\r\nline2\r\nline3\r\n')
    const r = await editFileTool.execute({ path: 'crlf.txt', old_string: 'line2', new_string: 'L2\nL2b' }, ctx(cwd))
    expect(r).toMatchObject({ path: 'crlf.txt', add: 2, del: 1 })
    const after = await readFile(path.join(cwd, 'crlf.txt'), 'utf8')
    expect(after).toBe('line1\r\nL2\r\nL2b\r\nline3\r\n')   // new_string 的 LF 同样按文件 EOL 展开
  })
  it('CRLF 文件 + CRLF old_string 同样命中；LF 文件保持 LF', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ptc-crlf2-'))
    await writeFile(path.join(cwd, 'a.txt'), 'x\r\ny\r\n')
    const r = await editFileTool.execute({ path: 'a.txt', old_string: 'x\r\ny', new_string: 'z' }, ctx(cwd))
    expect(r).toMatchObject({ add: 1, del: 2 })
    expect(await readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('z\r\n')
    await writeFile(path.join(cwd, 'b.txt'), 'x\ny\n')
    await editFileTool.execute({ path: 'b.txt', old_string: 'y', new_string: 'w' }, ctx(cwd))
    expect(await readFile(path.join(cwd, 'b.txt'), 'utf8')).toBe('x\nw\n')   // LF 文件不被引入 CR
  })
  it('LF 视图下仍找不到 → 原错误信息不变', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ptc-crlf3-'))
    await writeFile(path.join(cwd, 'c.txt'), 'a\r\nb\r\n')
    await expect(editFileTool.execute({ path: 'c.txt', old_string: 'nope', new_string: 'x' }, ctx(cwd)))
      .rejects.toThrow(/not found/)
  })
})

describe('CappedBuffer（bash 增量封顶）', () => {
  const CAP = 32 * 1024
  it('未超 头+尾 上限：原样返回全文', () => {
    const b = new CappedBuffer()
    b.push('abc')
    b.push('def')
    expect(b.result()).toBe('abcdef')
    const b2 = new CappedBuffer()
    b2.push('x'.repeat(CAP))
    b2.push('y'.repeat(CAP))   // total = 2*CAP 恰好完整
    expect(b2.result()).toBe(`${'x'.repeat(CAP)}${'y'.repeat(CAP)}`)
  })
  it('超限：保留头/尾各 CAP，中段丢弃并计数', () => {
    const b = new CappedBuffer()
    const seg = (c: string): string => c.repeat(16 * 1024)   // 16KB 段
    b.push(seg('a')); b.push(seg('b')); b.push(seg('c'))   // 48KB：头 CAP=前 2 段
    b.push(seg('d')); b.push(seg('e')); b.push(seg('f'))   // 96KB：中段丢弃，尾 CAP=后 2 段
    const out = b.result()
    expect(out.startsWith('a'.repeat(16 * 1024) + 'b'.repeat(16 * 1024))).toBe(true)
    expect(out.endsWith('e'.repeat(16 * 1024) + 'f'.repeat(16 * 1024))).toBe(true)
    expect(out).toContain(`[truncated ${32 * 1024} bytes]`)   // 96K - 头32K - 尾32K
  })
})

describe('read_file 大小上限', () => {
  it('超 8MB 只读头部并标注 truncated', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ptc-big-'))
    const MAX = 8 * 1024 * 1024
    await writeFile(path.join(cwd, 'big.txt'), Buffer.alloc(MAX + 4096, 0x61))
    const r = (await readFileTool.execute({ path: 'big.txt' }, ctx(cwd))) as { content: string; truncated?: boolean; totalBytes?: number }
    expect(r.truncated).toBe(true)
    expect(r.totalBytes).toBe(MAX + 4096)
    expect(r.content.length).toBeLessThanOrEqual(MAX)
  }, 20_000)
})

describe('parseSse 健壮性', () => {
  const enc = new TextEncoder()
  it('idle 超时：长时间无数据 → 抛错（loop 侧归 network 重试）', async () => {
    const hanging = new ReadableStream<Uint8Array>({ start() { /* 永不发数据 */ } })
    await expect(async () => {
      for await (const _ of parseSse(hanging, { idleTimeoutMs: 30 })) { void _ }
    }).rejects.toThrow(/idle/)
  })
  it('消费者提前退出 → reader.cancel 释放底层流', async () => {
    let cancelled = false
    const s = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('data: a\n\n')); c.enqueue(enc.encode('data: b\n\n')) },
      cancel() { cancelled = true },
    })
    const iter = parseSse(s)
    await iter.next()
    await iter.return!(undefined as never)
    expect(cancelled).toBe(true)
  })
  it('无边界缓冲超限 → 抛错', async () => {
    const s = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('data: ' + 'x'.repeat(1024 * 1024 + 10))) },   // 无空行，永不 emit
    })
    await expect(async () => {
      for await (const _ of parseSse(s)) { void _ }
    }).rejects.toThrow(/exceeds/)
  })
})

describe('SessionStore.list 浅读', () => {
  it('readHead 命中 meta 行时不全文读取', async () => {
    const meta = { sessionId: 's1', title: 'T', createdAt: 1, providerId: 'p', modelId: 'm' }
    const metaLine = JSON.stringify({ kind: 'meta', meta }) + '\n'
    const deps = {
      readDir: async () => ['s1.jsonl'],
      readFile: async () => { throw new Error('full read must not happen') },
      appendFile: async () => {},
      mkdir: async () => {},
      readHead: async (_p: string, bytes: number) => metaLine.slice(0, bytes),
    }
    const metas = await new SessionStore('/root', deps).list()
    expect(metas).toEqual([meta])
  })
  it('readHead 未命中 meta（撕裂/缺失）回退全量 load', async () => {
    const meta = { sessionId: 's2', title: 'T2', createdAt: 2, providerId: 'p', modelId: 'm' }
    const full = JSON.stringify({ kind: 'meta', meta }) + '\n' + JSON.stringify({ kind: 'ops', ops: [] }) + '\n'
    const deps = {
      readDir: async () => ['s2.jsonl'],
      readFile: async () => full,
      appendFile: async () => {},
      mkdir: async () => {},
      readHead: async () => '',   // 浅读一无所获
    }
    const metas = await new SessionStore('/root', deps).list()
    expect(metas).toEqual([meta])
  })
})

describe('AgentLoop 流式 patch 节流', () => {
  const provider = (): ResolvedProvider => ({
    info: { id: 'p', label: 'p', protocol: 'openai', baseUrl: 'https://x/v1', models: [{ id: 'm', label: 'm', supportsThinking: false }] },
    apiKey: 'SECRET-KEY', modelId: 'm', quality: 'medium',
  })
  const idGen = (): (() => string) => { let n = 0; return () => `e${++n}` }
  const baseDeps = (over: Partial<LoopDeps> & Pick<LoopDeps, 'adapter' | 'runtime'>): LoopDeps => ({
    provider: provider(),
    tools: new Map<string, ToolDef>(),
    cwd: '/w',
    platform: 'win32',
    emit: () => {},
    onHistory: () => {},
    getHistory: () => [],
    newEventId: idGen(),
    ...over,
  })
  const adapterOf = (script: StreamEvent[]): ProtocolAdapter => ({
    protocol: 'openai',
    async *stream(_req: StreamRequest) { for (const e of script) yield e },
  })
  const runtime = { run: async (): Promise<CodeRunResult> => ({ logs: [] }) }

  it('同轮连发 delta 合并节流：patch 数少于 delta 数，终态 patch 含全文', async () => {
    const ops: UiOp[] = []
    const loop = new AgentLoop(baseDeps({
      adapter: adapterOf([
        { type: 'text_delta', text: 'a' }, { type: 'text_delta', text: 'b' },
        { type: 'text_delta', text: 'c' }, { type: 'text_delta', text: 'd' },
        { type: 'message_done', stopReason: 'end_turn' },
      ]),
      runtime,
      emit: o => ops.push(...o),
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    const completionId = (ops.find(o => o.op === 'append' && o.event.type === 'completion') as { event: { id: string } }).event.id
    const patches = ops.filter(o => o.op === 'patch' && (o as { id: string }).id === completionId)
      .map(o => (o as { patch: { markdown?: string } }).patch.markdown)
    expect(patches.length).toBeLessThanOrEqual(2)   // 首 delta 立即 flush + message_done 边界 flush（原实现为 4）
    expect(patches.at(-1)).toBe('abcd')             // 重放语义：终态 patch 必含全文
  })

  it('per-id 节流：thought 与 completion 各自首个 delta 都立即上屏', async () => {
    const ops: UiOp[] = []
    const loop = new AgentLoop(baseDeps({
      adapter: adapterOf([
        { type: 'thinking_delta', text: 'plan' },
        { type: 'text_delta', text: '你好' },
        { type: 'message_done', stopReason: 'end_turn' },
      ]),
      runtime,
      emit: o => ops.push(...o),
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    const thoughtId = (ops.find(o => o.op === 'append' && o.event.type === 'thought') as { event: { id: string } }).event.id
    const completionId = (ops.find(o => o.op === 'append' && o.event.type === 'completion') as { event: { id: string } }).event.id
    const firstThought = ops.find(o => o.op === 'patch' && (o as { id: string }).id === thoughtId) as { patch: { markdown?: string } }
    const firstCompletion = ops.find(o => o.op === 'patch' && (o as { id: string }).id === completionId) as { patch: { markdown?: string } }
    expect(firstThought.patch.markdown).toBe('plan')
    expect(firstCompletion.patch.markdown).toBe('你好')   // 不被 thought 的同刻 flush 吞掉
  })

  it('apiKey 脱敏：流错误 message 中的 key 不进时间线', async () => {
    const ops: UiOp[] = []
    const loop = new AgentLoop(baseDeps({
      adapter: adapterOf([{ type: 'stream_error', kind: 'auth', message: 'fetch https://x/v1?key=SECRET-KEY failed' }]),
      runtime,
      emit: o => ops.push(...o),
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('error')
    const messages = ops.filter(o => o.op === 'append' && o.event.type === 'error').map(o => (o as { event: { message: string } }).event.message)
    expect(messages.join('\n')).not.toContain('SECRET-KEY')
    expect(messages.join('\n')).toContain('[REDACTED]')
  })

  it('apiKey 脱敏（rateLimit+retry 路径）：retrying 消息同样不含 key', async () => {
    const ops: UiOp[] = []
    // 带游标 adapter：第一轮 rateLimit，第二轮成功（adapterOf 会重放同一脚本，重试将耗尽）
    const scripts: StreamEvent[][] = [
      [{ type: 'stream_error', kind: 'rateLimit', message: 'limit hit at https://x/v1?key=SECRET-KEY' }],
      [{ type: 'text_delta', text: 'ok' }, { type: 'message_done', stopReason: 'end_turn' }],
    ]
    let round = 0
    const adapter: ProtocolAdapter = {
      protocol: 'openai',
      async *stream() { for (const e of scripts[Math.min(round++, scripts.length - 1)]) yield e },
    }
    const loop = new AgentLoop(baseDeps({
      adapter,
      runtime,
      emit: o => ops.push(...o),
      delayMs: async () => {},   // 注入即时退避，不真实等待
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    const messages = ops.filter(o => o.op === 'append' && o.event.type === 'error').map(o => (o as { event: { message: string } }).event.message)
    expect(messages).toHaveLength(1)   // 仅 retrying 提示（第二轮成功无新 error）
    expect(messages[0]).toContain('rateLimit')
    expect(messages[0]).toContain('retrying (1/3)')
    expect(messages[0]).not.toContain('SECRET-KEY')
    expect(messages[0]).toContain('[REDACTED]')
  })
})
