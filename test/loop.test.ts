import { describe, it, expect } from 'vitest'
import { AgentLoop, type LoopDeps } from '../src/agent/loop'
import { mapDispatchEvent } from '../src/agent/events'
import { anthropicAdapter, buildAnthropicBody } from '../src/protocol/anthropic'
import { geminiAdapter, buildGeminiBody } from '../src/protocol/gemini'
import type { ProtocolAdapter, StreamRequest, ResolvedProvider, AssistantTurn, HistoryMessage } from '../src/protocol/types'
import type { CodeRunResult, RunOptions } from '../src/runtime/codeRuntime'
import type { ToolDef } from '../src/tools/registry'
import type { StreamEvent, UiOp } from '../src/shared/protocol'

const provider = (protocol: 'openai' | 'anthropic' | 'gemini' = 'openai'): ResolvedProvider => ({
  info: { id: 'p', label: 'p', protocol, baseUrl: 'https://x/v1', models: [{ id: 'm', label: 'm', supportsThinking: true }] },
  apiKey: 'K', modelId: 'm', quality: 'medium',
})

const fakeAdapter = (scripts: StreamEvent[][]): { adapter: ProtocolAdapter; requests: StreamRequest[] } => {
  const requests: StreamRequest[] = []
  let i = 0
  return {
    requests,
    adapter: {
      protocol: 'openai',
      async *stream(req: StreamRequest) {
        requests.push(req)
        const script = scripts[Math.min(i++, scripts.length - 1)]
        for (const e of script) yield e
      },
    },
  }
}

const fakeRuntime = (result: CodeRunResult): Pick<LoopDeps['runtime'], 'run'> => ({ run: async () => result })

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

const toolUseScript: StreamEvent[] = [
  { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":"return 1","description":"d"}' },
  { type: 'message_done', stopReason: 'tool_use' },
]

const appended = (ops: UiOp[]) => ops.flatMap(o => (o.op === 'append' ? [o.event.type] : [o.op]))
const hasPhase = (ops: UiOp[], phase: string) => ops.some(o => o.op === 'phase' && o.phase === phase)
const errorEvents = (ops: UiOp[]) => ops.filter(o => o.op === 'append' && o.event.type === 'error')
  .map(o => (o as { event: { message: string } }).event.message)

describe('AgentLoop', () => {
  it('一轮工具调用：thought 流式 → run_code → 工具结果入历史 → 完成', async () => {
    const history: HistoryMessage[] = []
    const ops: UiOp[] = []
    const { adapter } = fakeAdapter([
      [
        { type: 'thinking_delta', text: 'le' }, { type: 'thinking_delta', text: 't me think' },
        { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":"return 1","description":"d"}' },
        { type: 'message_done', stopReason: 'tool_use', usage: { input: 1, output: 2 } },
      ],
      [{ type: 'text_delta', text: 'All done' }, { type: 'message_done', stopReason: 'end_turn' }],
    ])
    const loop = new AgentLoop(baseDeps({
      adapter,
      runtime: fakeRuntime({ logs: ['L1'], value: { answer: 42 } }),
      emit: o => ops.push(...o),
      onHistory: m => history.push(m),
      getHistory: () => history,
    }))
    const result = await loop.run('do it', new AbortController().signal)
    expect(result).toBe('completed')
    // 历史：user → assistant(带 toolCall) → toolResult → assistant(final)
    expect(history.map(h => h.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    const toolTurn = history[1] as { role: 'assistant'; turn: AssistantTurn }
    expect(toolTurn.turn.toolCall!.args).toEqual({ code: 'return 1', description: 'd' })
    expect((history[2] as { content: string }).content).toContain('42')
    const finalTurn = history[3] as { role: 'assistant'; turn: AssistantTurn }
    expect(finalTurn.turn.text).toBe('All done')
    // UI：thought done、run 事件、completion、phase completed
    const types = appended(ops)
    expect(types).toContain('thought'); expect(types).toContain('run'); expect(types).toContain('completion')
    expect(hasPhase(ops, 'completed')).toBe(true)
    // thought markdown 流式追加
    const markdowns = ops.filter(o => o.op === 'patch').map(o => (o as { patch: { markdown?: string } }).patch.markdown)
    expect(markdowns).toContain('let me think')
    // thought 折叠时固化 durationMs（重放/快照恢复不再用 Date.now()-startedAt 墙钟差）
    const durationPatches = ops.filter(o => o.op === 'patch' && (o as { patch: { durationMs?: number } }).patch.durationMs !== undefined)
    expect(durationPatches).toHaveLength(1)
    expect(durationPatches[0]).toMatchObject({ op: 'patch', patch: { status: 'done', durationMs: expect.any(Number) } })
  })

  it('流错误 auth → error 事件 + phase error，不重试', async () => {
    const ops: UiOp[] = []
    const { adapter } = fakeAdapter([[{ type: 'stream_error', kind: 'auth', message: 'bad key' }]])
    const loop = new AgentLoop(baseDeps({ adapter, runtime: fakeRuntime({ logs: [] }), emit: o => ops.push(...o) }))
    expect(await loop.run('x', new AbortController().signal)).toBe('error')
    expect(errorEvents(ops)).toEqual(['auth: bad key'])
    expect(hasPhase(ops, 'error')).toBe(true)
  })

  it('run 第三参 images 随首条 user 历史入请求；无图时不带 images 字段（零回归）', async () => {
    const history: HistoryMessage[] = []
    const { adapter, requests } = fakeAdapter([[{ type: 'text_delta', text: 'ok' }, { type: 'message_done', stopReason: 'end_turn' }]])
    const loop = new AgentLoop(baseDeps({
      adapter, runtime: fakeRuntime({ logs: [] }),
      onHistory: m => history.push(m), getHistory: () => history,
    }))
    const images = [{ mime: 'image/png', base64: 'AAEC' }]
    await loop.run('看图', new AbortController().signal, images)
    expect(history[0]).toEqual({ role: 'user', text: '看图', images })
    expect(requests[0].history[0]).toEqual({ role: 'user', text: '看图', images })   // 适配器请求体同源
    // 无图路径：字段缺省而非空数组——与既有 JSONL 会话逐字节兼容
    const history2: HistoryMessage[] = []
    const second = new AgentLoop(baseDeps({
      adapter, runtime: fakeRuntime({ logs: [] }),
      onHistory: m => history2.push(m), getHistory: () => history2,
    }))
    await second.run('plain', new AbortController().signal)
    expect(history2[0]).toEqual({ role: 'user', text: 'plain' })
  })

  it('rateLimit 自动重试（退避 1s）：重放轮 completion 不含失败轮的部分文本', async () => {
    const ops: UiOp[] = []
    const history: HistoryMessage[] = []
    const delays: number[] = []
    const { adapter, requests } = fakeAdapter([
      [{ type: 'text_delta', text: 'par' }, { type: 'stream_error', kind: 'rateLimit', message: 'slow down' }],
      [{ type: 'text_delta', text: 'All ' }, { type: 'text_delta', text: 'done' }, { type: 'message_done', stopReason: 'end_turn' }],
    ])
    const loop = new AgentLoop(baseDeps({
      adapter, runtime: fakeRuntime({ logs: [] }),
      emit: o => ops.push(...o),
      onHistory: m => history.push(m), getHistory: () => history,
      delayMs: async ms => { delays.push(ms) },
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    expect(delays).toEqual([1000])
    expect(requests).toHaveLength(2)
    expect(errorEvents(ops)).toEqual(['rateLimit: slow down — retrying (1/3)'])
    const completions = ops.filter(o => o.op === 'append' && o.event.type === 'completion')
      .map(o => (o as { event: { markdown: string } }).event.markdown)
    expect(completions).toEqual(['', ''])          // append 空正文，增量全走 patch
    // 重试轮各自流式：失败轮 patch 到 'par'，成功轮 patch 到 'All '
    const markdowns = ops.filter(o => o.op === 'patch').map(o => (o as { patch: { markdown?: string } }).patch.markdown)
    expect(markdowns).toContain('par')
    expect(markdowns).toContain('All ')
    // I5：失败轮 partial completion 气泡在重试前被 remove 撤下
    const partialId = (ops.find(o => o.op === 'patch' && (o as { patch: { markdown?: string } }).patch.markdown === 'par') as { id: string }).id
    expect(ops).toContainEqual({ op: 'remove', id: partialId })
    expect(markdowns).toContain('All done')
    const finalTurn = history[history.length - 1] as { role: 'assistant'; turn: AssistantTurn }
    expect(finalTurn.turn.text).toBe('All done')
  })
  it('rateLimit 重试耗尽（3 次，退避 1/2/4s）→ error', async () => {
    const ops: UiOp[] = []
    const delays: number[] = []
    const err: StreamEvent[] = [{ type: 'stream_error', kind: 'rateLimit', message: 'nope' }]
    const { adapter, requests } = fakeAdapter([err, err, err, err])
    const loop = new AgentLoop(baseDeps({
      adapter, runtime: fakeRuntime({ logs: [] }),
      emit: o => ops.push(...o),
      delayMs: async ms => { delays.push(ms) },
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('error')
    expect(delays).toEqual([1000, 2000, 4000])
    expect(requests).toHaveLength(4)
    expect(hasPhase(ops, 'error')).toBe(true)
  })
  it('rateLimit 重试退避采信服务端 Retry-After：与指数退避取大者，封顶 60s', async () => {
    const delays: number[] = []
    const err = (retryAfterMs: number): StreamEvent[] => [{ type: 'stream_error', kind: 'rateLimit', message: 'slow down', retryAfterMs }]
    const { adapter } = fakeAdapter([
      err(5000),      // 5s > 指数 1s → 5s
      err(120000),    // 120s 封顶 → 60s
      err(500),       // 500ms < 指数 4s → 4s
      [{ type: 'text_delta', text: 'ok' }, { type: 'message_done', stopReason: 'end_turn' }],
    ])
    const loop = new AgentLoop(baseDeps({
      adapter, runtime: fakeRuntime({ logs: [] }),
      delayMs: async ms => { delays.push(ms) },
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    expect(delays).toEqual([5000, 60000, 4000])
  })

  it('anthropic 400 含 thinking → 降级 manual 重试一次，onProviderThinkingMode 持久化', async () => {
    const ops: UiOp[] = []
    const modes: string[] = []
    const prov = provider('anthropic')
    const { adapter, requests } = fakeAdapter([
      [{ type: 'stream_error', kind: 'invalidRequest', message: 'thinking parameter not supported' }],
      [{ type: 'text_delta', text: 'ok' }, { type: 'message_done', stopReason: 'end_turn' }],
    ])
    const loop = new AgentLoop(baseDeps({
      adapter, runtime: fakeRuntime({ logs: [] }), provider: prov,
      emit: o => ops.push(...o),
      onProviderThinkingMode: m => modes.push(m),
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    expect(modes).toEqual(['manual'])
    expect(prov.thinkingMode).toBe('manual')
    expect(requests[1].provider.thinkingMode).toBe('manual')
    expect(hasPhase(ops, 'error')).toBe(false)
  })

  it('maxToolRounds 护栏：超限 → 温和 error + phase error', async () => {
    const ops: UiOp[] = []
    const history: HistoryMessage[] = []
    const { adapter } = fakeAdapter([toolUseScript])   // 永远返回同一脚本
    const loop = new AgentLoop(baseDeps({
      adapter, runtime: fakeRuntime({ logs: [] }),
      maxToolRounds: 2,
      emit: o => ops.push(...o),
      onHistory: m => history.push(m), getHistory: () => history,
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('error')
    const errors = errorEvents(ops)
    expect(errors[errors.length - 1]).toContain('limit')
    expect(hasPhase(ops, 'error')).toBe(true)
    expect(history.map(h => h.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant', 'toolResult'])
  })

  it('abort：工具轮后中止 → 保留时间线（error 标注 + phase completed）返回 aborted', async () => {
    const ops: UiOp[] = []
    const history: HistoryMessage[] = []
    const controller = new AbortController()
    const { adapter } = fakeAdapter([[
      { type: 'thinking_delta', text: 't' },
      ...toolUseScript,
    ]])
    const loop = new AgentLoop(baseDeps({
      adapter,
      runtime: { run: async () => { controller.abort(); return { logs: [] } } },
      emit: o => ops.push(...o),
      onHistory: m => history.push(m), getHistory: () => history,
    }))
    expect(await loop.run('x', controller.signal)).toBe('aborted')
    expect(history.map(h => h.role)).toEqual(['user', 'assistant', 'toolResult'])
    const errors = errorEvents(ops)
    expect(errors.some(m => m.includes('Stopped'))).toBe(true)
    expect(hasPhase(ops, 'completed')).toBe(true)
  })

  /** thought 收尾断言：所有 append 的 thought 事件都拿到 done 终态 patch（错误/中止/重试路径不得遗留 running 走秒） */
  const allThoughtsFinalized = (ops: UiOp[]): void => {
    const thoughts = ops.filter(o => o.op === 'append' && o.event.type === 'thought') as Array<{ event: { id: string } }>
    expect(thoughts.length).toBeGreaterThan(0)
    for (const t of thoughts) {
      const done = ops.find(o => o.op === 'patch' && (o as { id: string }).id === t.event.id
        && (o as { patch: { status?: string } }).patch.status === 'done')
      expect(done, `thought ${t.event.id} 未收尾（running 残留）`).toBeDefined()
    }
  }

  it('auth 硬错误路径收尾 thought：done patch 固化 durationMs，不再随 JSONL 永久走秒', async () => {
    const ops: UiOp[] = []
    const { adapter } = fakeAdapter([[{ type: 'thinking_delta', text: 'partial' }, { type: 'stream_error', kind: 'auth', message: 'bad key' }]])
    const loop = new AgentLoop(baseDeps({ adapter, runtime: fakeRuntime({ logs: [] }), emit: o => ops.push(...o) }))
    expect(await loop.run('x', new AbortController().signal)).toBe('error')
    allThoughtsFinalized(ops)
  })

  it('rateLimit 重试轮的失败 thought 同样冻结：两轮思考均 done，无 running 残留', async () => {
    const ops: UiOp[] = []
    const { adapter } = fakeAdapter([
      [{ type: 'thinking_delta', text: 'half' }, { type: 'stream_error', kind: 'rateLimit', message: 'slow' }],
      [{ type: 'thinking_delta', text: 'ok' }, { type: 'message_done', stopReason: 'end_turn' }],
    ])
    const loop = new AgentLoop(baseDeps({
      adapter, runtime: fakeRuntime({ logs: [] }),
      emit: o => ops.push(...o), delayMs: async () => {},
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    const thoughts = ops.filter(o => o.op === 'append' && o.event.type === 'thought') as Array<{ event: { id: string } }>
    expect(thoughts).toHaveLength(2)   // 失败轮 + 成功轮各一个 thought
    allThoughtsFinalized(ops)
  })

  it('流式中途 abort：在途思考 done 冻结计时（内容保留），Stopped 标注不变', async () => {
    const ops: UiOp[] = []
    const controller = new AbortController()
    const adapter: ProtocolAdapter = {
      protocol: 'openai',
      async *stream() {
        yield { type: 'thinking_delta', text: 'mid-thought' }
        controller.abort()   // 流式中途用户中止
        throw new Error('terminated')   // 中止常伴随 fetch 断流
      },
    }
    const loop = new AgentLoop(baseDeps({ adapter, runtime: fakeRuntime({ logs: [] }), emit: o => ops.push(...o) }))
    expect(await loop.run('x', controller.signal)).toBe('aborted')
    allThoughtsFinalized(ops)
    expect(errorEvents(ops).some(m => m.includes('Stopped'))).toBe(true)
  })

  /** run 事件 patch 序列（按 append 的 run 事件 id 过滤），断言 outputTail 流式/终态 */
  const runPatches = (ops: UiOp[]): Array<{ patch: Record<string, unknown> }> => {
    const runId = (ops.find(o => o.op === 'append' && o.event.type === 'run') as { event: { id: string } } | undefined)?.event.id
    return ops.filter(o => o.op === 'patch' && (o as { id: string }).id === runId) as Array<{ patch: Record<string, unknown> }>
  }
  const toolRound: StreamEvent[][] = [
    [{ type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":"return 1","description":"d"}' }, { type: 'message_done', stopReason: 'tool_use' }],
    [{ type: 'message_done', stopReason: 'end_turn' }],
  ]

  it('run_code 失败无 logs → error 态 outputTail 携带失败原因（kind+message），不再空输出', async () => {
    const ops: UiOp[] = []
    const loop = new AgentLoop(baseDeps({
      adapter: fakeAdapter(toolRound).adapter,
      runtime: fakeRuntime({ logs: [], error: { kind: 'exception', message: 'boom at line 1' } }),
      emit: o => ops.push(...o),
      onHistory: () => {}, getHistory: () => [],
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    expect(runPatches(ops).at(-1)!.patch).toEqual({ status: 'error', outputTail: 'exception: boom at line 1' })
  })

  it('run_code 失败且有前置 logs → 尾部日志 + 失败原因（错误时窗口收窄到 2 条给原因留位）', async () => {
    const ops: UiOp[] = []
    const loop = new AgentLoop(baseDeps({
      adapter: fakeAdapter(toolRound).adapter,
      runtime: fakeRuntime({ logs: ['L1', 'L2', 'L3', 'L4'], error: { kind: 'timeout', message: 'compute budget exhausted' } }),
      emit: o => ops.push(...o),
      onHistory: () => {}, getHistory: () => [],
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    expect(runPatches(ops).at(-1)!.patch).toEqual({ status: 'error', outputTail: 'L3\nL4\ntimeout: compute budget exhausted' })
  })
  it('V1：error.message 为长堆栈（原因首行+多帧，总长>600）→ 原因首行强制保留在 outputTail 头部', async () => {
    const ops: UiOp[] = []
    const frames = Array.from({ length: 12 }, (_, i) => `    at fn${i} (E:/very/long/path/module${i}.ts:${i + 10}:${i * 3})`)
    const loop = new AgentLoop(baseDeps({
      adapter: fakeAdapter(toolRound).adapter,
      runtime: fakeRuntime({ logs: [], error: { kind: 'exception', message: ['Error: mock-boom', ...frames].join('\n') } }),
      emit: o => ops.push(...o),
      onHistory: () => {}, getHistory: () => [],
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    const tail = runPatches(ops).at(-1)!.patch.outputTail as string
    expect(tail.startsWith('exception: Error: mock-boom')).toBe(true)   // kind 前缀 + 原因首行打头，不再被 node 内部帧挤出窗口
    expect(tail).toContain('at fn0')                                     // 栈顶帧（紧邻 throw）保留
    expect(tail).not.toContain('at fn11')                                // 帧数截断：仅前 5 帧
    expect(tail.length).toBeLessThanOrEqual(500)                         // 有界语义维持
  })

  it('onLog 流式：执行中每条 console.log 即刻 patch run 事件 outputTail（尾部窗口 3 条，不等结束）', async () => {
    const ops: UiOp[] = []
    const runtime = {
      run: async (opts: RunOptions): Promise<CodeRunResult> => {
        opts.onLog?.('L1')
        opts.onLog?.('L2')
        opts.onLog?.('L3')
        opts.onLog?.('L4')
        return { logs: ['L1', 'L2', 'L3', 'L4'] }
      },
    }
    const loop = new AgentLoop(baseDeps({
      adapter: fakeAdapter(toolRound).adapter,
      runtime,
      emit: o => ops.push(...o),
      onHistory: () => {}, getHistory: () => [],
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    expect(runPatches(ops).map(p => p.patch)).toEqual([
      { outputTail: 'L1' },
      { outputTail: 'L1\nL2' },
      { outputTail: 'L1\nL2\nL3' },
      { outputTail: 'L2\nL3\nL4' },
      { status: 'done', outputTail: 'L2\nL3\nL4' },
    ])
  })

  it('成功且无 logs → outputTail 保持空串（无输出占位不回归）', async () => {
    const ops: UiOp[] = []
    const loop = new AgentLoop(baseDeps({
      adapter: fakeAdapter(toolRound).adapter,
      runtime: fakeRuntime({ logs: [] }),
      emit: o => ops.push(...o),
      onHistory: () => {}, getHistory: () => [],
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    expect(runPatches(ops)).toHaveLength(1)
    expect(runPatches(ops)[0].patch).toEqual({ status: 'done', outputTail: '' })
  })

  it('程序内工具调用经 DispatchPool：explore/edit/run UiOp、changes 快照、beforeEdit 先于执行', async () => {
    const ops: UiOp[] = []
    const order: string[] = []
    const tools = new Map<string, ToolDef>([
      ['read_file', { name: 'read_file', concurrencySafe: true, execute: async () => ({ content: 'x', totalLines: 1, startLine: 1 }) }],
      ['write_file', { name: 'write_file', concurrencySafe: false, execute: async () => { order.push('write'); return { path: 'b.ts', bytes: 1, add: 2, del: 0 } } }],
    ])
    const runtime = {
      run: async (opts: RunOptions): Promise<CodeRunResult> => {
        await opts.bindings.read_file({ path: 'a.js' })
        await opts.bindings.write_file({ path: 'b.ts', content: 'x' })
        return { logs: [], value: true }
      },
    }
    const loop = new AgentLoop(baseDeps({
      adapter: fakeAdapter([
        [
          { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":"return 1","description":"d"}' },
          { type: 'message_done', stopReason: 'tool_use' },
        ],
        [{ type: 'message_done', stopReason: 'end_turn' }],
      ]).adapter,
      runtime,
      tools,
      emit: o => ops.push(...o),
      onHistory: () => {}, getHistory: () => [],
      snapshotTracker: {
        beforeEdit: async path => { order.push(`beforeEdit:${path}`) },
        changes: async () => [{ path: 'b.ts', add: 2, del: 0, kind: 'ts' }],
      },
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    // 快照先于写入执行
    expect(order).toEqual(['beforeEdit:b.ts', 'write'])
    const types = appended(ops)
    expect(types).toContain('explore'); expect(types).toContain('edit'); expect(types).toContain('run')
    const editEvent = ops.find(o => o.op === 'append' && o.event.type === 'edit') as { event: { file: string; fileKind: string; add: number; del: number } }
    expect(editEvent.event).toMatchObject({ file: 'b.ts', fileKind: 'ts', add: 2, del: 0 })
    const changesOp = ops.find(o => o.op === 'changes') as { changes: { path: string; add: number; del: number; kind: string }[] }
    expect(changesOp.changes).toEqual([{ path: 'b.ts', add: 2, del: 0, kind: 'ts' }])
  })

  it('I5：中间轮 preamble 气泡在 tool_use 重置时 remove 撤下；最终 completion 仅含最终轮文本', async () => {
    const ops: UiOp[] = []
    const history: HistoryMessage[] = []
    const { adapter } = fakeAdapter([
      [
        { type: 'text_delta', text: 'preamble ' },   // 无 thoughtId → 流式期误建 completion 气泡
        { type: 'text_delta', text: 'before tool' },
        { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":"return 1","description":"d"}' },
        { type: 'message_done', stopReason: 'tool_use' },
      ],
      [{ type: 'text_delta', text: 'All done' }, { type: 'message_done', stopReason: 'end_turn' }],
    ])
    const loop = new AgentLoop(baseDeps({
      adapter, runtime: fakeRuntime({ logs: [] }),
      emit: o => ops.push(...o),
      onHistory: m => history.push(m), getHistory: () => history,
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    const completionAppends = ops.filter(o => o.op === 'append' && o.event.type === 'completion') as Array<{ event: { id: string; markdown: string } }>
    expect(completionAppends.map(c => c.event.markdown)).toEqual(['', ''])   // append 空正文，增量走 patch
    // preamble 气泡被撤下；最终 completion 未被撤
    expect(ops).toContainEqual({ op: 'remove', id: completionAppends[0].event.id })
    expect(ops).not.toContainEqual({ op: 'remove', id: completionAppends[1].event.id })
    // 最终 completion 只含最终轮文本（无 preamble 拼接泄漏）
    const finalCompletionMarkdown = ops.filter(o => o.op === 'patch' && (o as { id: string }).id === completionAppends[1].event.id)
      .map(o => (o as { patch: { markdown: string } }).patch.markdown).at(-1)
    expect(finalCompletionMarkdown).toBe('All done')
    // 中间轮 preamble 仍完整入历史（模型可见），只是 UI 不再呈现为最终总结
    const toolTurn = history[1] as { role: 'assistant'; turn: AssistantTurn }
    expect(toolTurn.turn.text).toBe('preamble before tool')
  })

  it('同轮 thinking+text+end_turn（纯聊天）：正文进 completion 气泡流式，不再藏进 thought.working', async () => {
    const ops: UiOp[] = []
    const history: HistoryMessage[] = []
    const { adapter } = fakeAdapter([
      [
        { type: 'thinking_delta', text: 'plan the greeting' },
        { type: 'text_delta', text: '你好' },
        { type: 'text_delta', text: '！需要帮忙吗？' },
        { type: 'message_done', stopReason: 'end_turn' },
      ],
    ])
    const loop = new AgentLoop(baseDeps({
      adapter, runtime: fakeRuntime({ logs: [] }),
      emit: o => ops.push(...o),
      onHistory: m => history.push(m), getHistory: () => history,
    }))
    expect(await loop.run('你好', new AbortController().signal)).toBe('completed')
    // completion 事件流式承载正文（append 空正文 + patch 累积）
    const completionAppends = ops.filter(o => o.op === 'append' && o.event.type === 'completion') as Array<{ event: { id: string; markdown: string } }>
    expect(completionAppends).toHaveLength(1)
    expect(completionAppends[0].event.markdown).toBe('')
    const completionPatches = ops.filter(o => o.op === 'patch' && (o as { id: string }).id === completionAppends[0].event.id)
      .map(o => (o as { patch: { markdown: string } }).patch.markdown)
    expect(completionPatches).toEqual(['你好', '你好！需要帮忙吗？'])
    // thought.working 不再吞正文：thought 的 patch 只出现在 thinking 文本与 done 固化
    const workingPatches = ops.filter(o => o.op === 'patch' && (o as { patch: { working?: string } }).patch.working !== undefined)
    expect(workingPatches).toHaveLength(0)
    expect(hasPhase(ops, 'completed')).toBe(true)
    const finalTurn = history[history.length - 1] as { role: 'assistant'; turn: AssistantTurn }
    expect(finalTurn.turn.text).toBe('你好！需要帮忙吗？')
    expect(finalTurn.turn.thinking).toBe('plan the greeting')
  })

  it('M1：程序以原始值调用工具（args 非 object）→ WeakMap key 守卫，不抛 Invalid value used as weak map key', async () => {
    const ops: UiOp[] = []
    const tools = new Map<string, ToolDef>([
      ['read_file', { name: 'read_file', concurrencySafe: true, execute: async () => ({ content: 'x', totalLines: 1, startLine: 1 }) }],
    ])
    const runtime = {
      run: async (opts: RunOptions): Promise<CodeRunResult> => {
        await opts.bindings.read_file('a.js' as never)   // 原始值 args（字符串）
        return { logs: [], value: true }
      },
    }
    const loop = new AgentLoop(baseDeps({
      adapter: fakeAdapter([
        [{ type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":"return 1","description":"d"}' }, { type: 'message_done', stopReason: 'tool_use' }],
        [{ type: 'message_done', stopReason: 'end_turn' }],
      ]).adapter,
      runtime, tools,
      emit: o => ops.push(...o),
      onHistory: () => {}, getHistory: () => [],
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    expect(appended(ops)).toContain('explore')
  })

  it('原始值 args 调用 bash：start append 与 finish patch 共用同一 id，run 事件不再孤儿 running', async () => {
    const ops: UiOp[] = []
    const tools = new Map<string, ToolDef>([
      // execute 抛错模拟 worker 侧对非法 args 的 reject（bash 的 finish 分支不触碰 args 形状）
      ['bash', { name: 'bash', concurrencySafe: false, execute: async () => { throw new Error('invalid args') } }],
    ])
    const runtime = {
      run: async (opts: RunOptions): Promise<CodeRunResult> => {
        await opts.bindings.bash('ls' as never).catch(() => {})   // 原始值 args（字符串）进不了 WeakMap
        return { logs: [], value: true }
      },
    }
    const loop = new AgentLoop(baseDeps({
      adapter: fakeAdapter([
        [{ type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":"return 1","description":"d"}' }, { type: 'message_done', stopReason: 'tool_use' }],
        [{ type: 'message_done', stopReason: 'end_turn' }],
      ]).adapter,
      runtime, tools,
      emit: o => ops.push(...o),
      onHistory: () => {}, getHistory: () => [],
    }))
    expect(await loop.run('x', new AbortController().signal)).toBe('completed')
    // bash start 的 run append（原始值 args → command 回退 ''）必须收到落在同 id 上的 finish patch
    const runAppends = ops.filter(o => o.op === 'append' && o.event.type === 'run') as Array<{ event: { id: string; command: string } }>
    const bashAppend = runAppends.find(r => r.event.command === '')
    expect(bashAppend).toBeDefined()
    const bashPatches = ops.filter(o => o.op === 'patch' && (o as { id: string }).id === bashAppend!.event.id) as Array<{ patch: Record<string, unknown> }>
    expect(bashPatches.at(-1)!.patch).toMatchObject({ status: 'error' })   // execute 抛错 → finish ok:false → error 终态；旧实现 patch 落在新 id 上被静默丢弃
  })

  describe('C1/C2 端到端：SSE 字节 → 适配器 → loop → turn.replay → 下一请求 body', () => {
    const enc = new TextEncoder()
    const sse = (...events: Array<[name: string, data: string]>): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(c) { for (const [name, data] of events) { c.enqueue(enc.encode(`event: ${name}\ndata: ${data}\n\n`)) } c.close() },
    })
    const anthropicToolRound = (sig: string) => sse(
      ['message_start', '{"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}'],
      ['content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"th"}}'],
      ['content_block_delta', `{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"${sig}"}}`],
      ['content_block_stop', '{"type":"content_block_stop","index":0}'],
      ['content_block_start', '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"run_code","input":{}}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"code\\":\\"return 1\\",\\"description\\":\\"d\\"}"}}'],
      ['content_block_stop', '{"type":"content_block_stop","index":1}'],
      ['message_delta', '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}'],
      ['message_stop', '{"type":"message_stop"}'],
    )
    const anthropicFinalRound = () => sse(
      ['content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"All done"}}'],
      ['message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}'],
      ['message_stop', '{"type":"message_stop"}'],
    )

    it('C1 anthropic：turn.replay.blocks 签名与流中 signature_delta 逐字节一致，并原样进入下一请求 body', async () => {
      const SIG = 'EqQBCkgIBRAGKFWTQmFhZ2dnbmRlZGRlZA=='
      const history: HistoryMessage[] = []
      const requests: StreamRequest[] = []
      const fetchImpl = (() => {
        let round = 0
        return async (): Promise<Response> => {
          round++
          return { ok: true, status: 200, headers: { get: () => null }, body: round === 1 ? anthropicToolRound(SIG) : anthropicFinalRound() } as unknown as Response
        }
      })()
      const adapter: ProtocolAdapter = {
        protocol: 'anthropic',
        stream: (req, fetchOverride) => { requests.push(req); return anthropicAdapter.stream(req, fetchOverride ?? fetchImpl) },
      }
      const loop = new AgentLoop(baseDeps({ adapter, runtime: fakeRuntime({ logs: [] }), provider: provider('anthropic'),
        onHistory: m => history.push(m), getHistory: () => history }))
      expect(await loop.run('do it', new AbortController().signal)).toBe('completed')
      // turn.replay：thinking 签名逐字节一致 + tool_use 原样
      const toolTurn = history[1] as { role: 'assistant'; turn: AssistantTurn }
      expect((toolTurn.turn.replay as { blocks: unknown[] }).blocks).toEqual([
        { type: 'thinking', thinking: 'th', signature: SIG },
        { type: 'tool_use', id: 'tu1', name: 'run_code', input: { code: 'return 1', description: 'd' } },
      ])
      // 下一请求 body：replay blocks 原样回传（非空伪签名）
      expect(requests).toHaveLength(2)
      const body = buildAnthropicBody(requests[1]) as { messages: Array<{ role: string; content: unknown }> }
      expect(body.messages[1]).toEqual({ role: 'assistant', content: [
        { type: 'thinking', thinking: 'th', signature: SIG },
        { type: 'tool_use', id: 'tu1', name: 'run_code', input: { code: 'return 1', description: 'd' } },
      ] })
      // 端到端闭环：tool_result.tool_use_id 采信流中真实 toolu id（tu1），与回放 tool_use.id 配对——
      // 修复前此处是合成的 call_<eventId>，Anthropic 第二轮必 400
      const toolResultMsg = body.messages[2] as { role: string; content: Array<{ type: string; tool_use_id: string; is_error: boolean }> }
      expect(toolResultMsg.role).toBe('user')
      expect(toolResultMsg.content[0].tool_use_id).toBe('tu1')
      expect(toolResultMsg.content[0].is_error).toBe(false)
    })

    it('C2 gemini：thought/functionCall part 的 thoughtSignature 原样采集，逐字节进入下一请求 body', async () => {
      const TS_THOUGHT = 'c2lnLW9uLXRoaW5raW5nLXBhcnQ='
      const TS_CALL = 'c2lnLW9uLWNhbGwtcGFydA=='
      const history: HistoryMessage[] = []
      const requests: StreamRequest[] = []
      const toolRound = sse(
        ['data', '{"candidates":[{"content":{"role":"model","parts":[{"text":"th","thought":true,"thoughtSignature":"' + TS_THOUGHT + '"}]}}]}'],
        ['data', `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"run_code","args":{"code":"return 1","description":"d"}},"thoughtSignature":"${TS_CALL}"}]},"finishReason":"STOP"}]}`],
      )
      const finalRound = sse(
        ['data', '{"candidates":[{"content":{"role":"model","parts":[{"text":"All done"}]},"finishReason":"STOP"}]}'],
      )
      const fetchImpl = (() => {
        let round = 0
        return async (): Promise<Response> => {
          round++
          return { ok: true, status: 200, headers: { get: () => null }, body: round === 1 ? toolRound : finalRound } as unknown as Response
        }
      })()
      const adapter: ProtocolAdapter = {
        protocol: 'gemini',
        stream: (req, fetchOverride) => { requests.push(req); return geminiAdapter.stream(req, fetchOverride ?? fetchImpl) },
      }
      const loop = new AgentLoop(baseDeps({ adapter, runtime: fakeRuntime({ logs: [] }), provider: provider('gemini'),
        onHistory: m => history.push(m), getHistory: () => history }))
      expect(await loop.run('do it', new AbortController().signal)).toBe('completed')
      const toolTurn = history[1] as { role: 'assistant'; turn: AssistantTurn }
      expect((toolTurn.turn.replay as { parts: unknown[] }).parts).toEqual([
        { text: 'th', thought: true, thoughtSignature: TS_THOUGHT },
        { functionCall: { name: 'run_code', args: { code: 'return 1', description: 'd' } }, thoughtSignature: TS_CALL },
      ])
      expect(requests).toHaveLength(2)
      const body = buildGeminiBody(requests[1]) as { contents: Array<{ role: string; parts: unknown }> }
      expect(body.contents[1]).toEqual({ role: 'model', parts: [
        { text: 'th', thought: true, thoughtSignature: TS_THOUGHT },
        { functionCall: { name: 'run_code', args: { code: 'return 1', description: 'd' } }, thoughtSignature: TS_CALL },
      ] })
    })
  })
})

describe('mapDispatchEvent', () => {
  it('bash start/finish 同 id：append run → patch done；非零退出 → error；write/edit → edit 事件带 diff；read → explore', () => {
    const edits = new Map<string, { add: number; del: number }>()
    const start = mapDispatchEvent({ phase: 'start', name: 'bash', args: { command: 'npm t' } }, 'b1', edits)
    expect(start).toEqual([{ op: 'append', event: { id: 'b1', ts: expect.any(Number), type: 'run', command: 'npm t', status: 'running', outputTail: '' } }])
    const finish = mapDispatchEvent({ phase: 'finish', name: 'bash', args: { command: 'npm t' }, ok: true, result: { exitCode: 0, stdout: 'ok', stderr: '' } }, 'b1', edits)
    expect(finish[0]).toMatchObject({ op: 'patch', id: 'b1' })
    expect((finish[0] as { patch: { status: string } }).patch.status).toBe('done')
    const fail = mapDispatchEvent({ phase: 'finish', name: 'bash', args: { command: 'x' }, ok: true, result: { exitCode: 1, stdout: '', stderr: 'boom' } }, 'b2', edits)
    expect((fail[0] as { patch: { status: string; outputTail: string } }).patch).toMatchObject({ status: 'error', outputTail: 'boom' })
    edits.set('w1', { add: 3, del: 1 })
    const edit = mapDispatchEvent({ phase: 'finish', name: 'write_file', args: { path: 'src\\a.ts' }, ok: true, result: { path: 'src/a.ts', bytes: 5 } }, 'w1', edits)
    expect(edit[0]).toMatchObject({ op: 'append', event: { type: 'edit', file: 'src/a.ts', fileKind: 'ts', add: 3, del: 1 } })
    const explore = mapDispatchEvent({ phase: 'finish', name: 'read_file', args: { path: 'a.js' }, ok: true, result: { content: 'x', totalLines: 1, startLine: 1 } }, 'r1', edits)
    expect(explore[0]).toMatchObject({ op: 'append', event: { type: 'explore', status: 'done', count: 1, targets: ['a.js'] } })
    // explore/edit start 静默
    expect(mapDispatchEvent({ phase: 'start', name: 'read_file', args: { path: 'a.js' } }, 'r2', edits)).toEqual([])
    expect(mapDispatchEvent({ phase: 'start', name: 'edit_file', args: { path: 'a.js' } }, 'e2', edits)).toEqual([])
  })
})
