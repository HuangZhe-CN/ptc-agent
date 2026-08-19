import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../src/agent/prompt'

const ctx = { model: 'test-model', cwd: 'E:\\repo', platform: 'win32' as NodeJS.Platform, date: '2026-08-19' }

describe('buildSystemPrompt', () => {
  it('包含 persona、工作区上下文、SDK 守则与 6 工具签名、ToolCallError', () => {
    const p = buildSystemPrompt(ctx)
    expect(p).toContain('coding agent powered by test-model')
    expect(p).toContain('E:\\repo')
    expect(p).toContain('win32')
    expect(p).toContain('2026-08-19')
    expect(p).toContain('erasable syntax only')
    expect(p).toContain('await tools.read_file(')
    expect(p).toContain('read_file'), expect(p).toContain('write_file'), expect(p).toContain('edit_file')
    expect(p).toContain('bash'), expect(p).toContain('glob'), expect(p).toContain('grep')
    expect(p).toContain('ToolCallError')
    expect(p).toContain('Promise.all')
  })
  it('字节稳定（两次调用一致）', () => {
    expect(buildSystemPrompt(ctx)).toBe(buildSystemPrompt(ctx))
  })
})
