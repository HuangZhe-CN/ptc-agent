import { describe, it, expect } from 'vitest'
import { mapDispatchEvent } from '../src/agent/events'

/** write/edit finish 分支的 M1 同类守卫：args 可能为原始值/null/缺 path（如 tools.write_file({content}) 漏 path、
 *  或以原始字符串调用）。该分支在 DispatchPool 的 catch 块内被同步调用——任何抛错都会跳过 reject、
 *  使工具 promise 永不结算（挂起 10 分钟 + unhandledRejection）；必须降级为空 file 的事件行而非抛错。 */
describe('mapDispatchEvent: write/edit 缺 path 守卫', () => {
  it('args 缺 path（{content}）→ 不抛错，降级为 file 空串的 edit 事件行', () => {
    const edits = new Map<string, { add: number; del: number }>()
    const ops = mapDispatchEvent({ phase: 'finish', name: 'write_file', args: { content: 'x' }, ok: false, error: 'The "path" argument must be of type string' }, 'w1', edits)
    expect(ops).toEqual([{ op: 'append', event: { id: 'w1', ts: expect.any(Number), type: 'edit', file: '', fileKind: 'other', add: 0, del: 0 } }])
  })
  it('args 为原始字符串/number/null → 同样降级为空 file，不抛错', () => {
    const edits = new Map<string, { add: number; del: number }>()
    for (const [i, args] of ['src/a.ts', 42, null].entries()) {
      const ops = mapDispatchEvent({ phase: 'finish', name: 'edit_file', args, ok: false, error: 'boom' }, `e${i}`, edits)
      expect(ops[0]).toMatchObject({ op: 'append', event: { type: 'edit', file: '' } })
    }
  })
  it('args.path 为非字符串（对象/数组）→ String() 兜底，不抛错', () => {
    const edits = new Map<string, { add: number; del: number }>()
    const ops = mapDispatchEvent({ phase: 'finish', name: 'write_file', args: { path: { bad: true }, content: 'x' }, ok: false, error: 'boom' }, 'w9', edits)
    expect(ops[0]).toMatchObject({ op: 'append', event: { type: 'edit', file: expect.any(String) } })
  })
  it('正常路径零回归：path 反斜杠归一 + fileKind + diff 计数注入', () => {
    const edits = new Map<string, { add: number; del: number }>()
    edits.set('w2', { add: 3, del: 1 })
    const ops = mapDispatchEvent({ phase: 'finish', name: 'write_file', args: { path: 'src\\a.ts', content: 'x' }, ok: true, result: { path: 'src/a.ts', bytes: 1 } }, 'w2', edits)
    expect(ops[0]).toMatchObject({ op: 'append', event: { type: 'edit', file: 'src/a.ts', fileKind: 'ts', add: 3, del: 1 } })
  })
})
