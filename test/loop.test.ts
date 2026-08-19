import { describe, it, expect } from 'vitest'
import { AgentLoop, type LoopDeps } from '../src/agent/loop'
import { mapDispatchEvent } from '../src/agent/events'
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
  })

  it('流错误 auth → error 事件 + phase error，不重试', async () => {
    const ops: UiOp[] = []
    const { adapter } = fakeAdapter([[{ type: 'stream_error', kind: 'auth', message: 'bad key' }]])
    const loop = new AgentLoop(baseDeps({ adapter, runtime: fakeRuntime({ logs: [] }), emit: o => ops.push(...o) }))
    expect(await loop.run('x', new AbortController().signal)).toBe('error')
    expect(errorEvents(ops)).toEqual(['auth: bad key'])
    expect(hasPhase(ops, 'error')).toBe(true)
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
    expect(completions).toEqual(['par', 'All '])   // append 只带首个增量，后续走 patch
    const markdowns = ops.filter(o => o.op === 'patch').map(o => (o as { patch: { markdown?: string } }).patch.markdown)
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
