import { describe, it, expect } from 'vitest'
import { classifyHttpError } from '../src/protocol/errors'

describe('classifyHttpError', () => {
  it('401/403→auth；429→rateLimit+Retry-After；5xx→server；400→invalidRequest；402/404→invalidRequest', () => {
    expect(classifyHttpError(401, '{"error":{"message":"bad key"}}').kind).toBe('auth')
    expect(classifyHttpError(403, '').kind).toBe('auth')
    const rl = classifyHttpError(429, '', { get: k => k.toLowerCase() === 'retry-after' ? '2' : null })
    expect(rl.kind).toBe('rateLimit'); expect(rl.retryAfterMs).toBe(2000)
    expect(classifyHttpError(503, '').kind).toBe('server')
    expect(classifyHttpError(400, 'x').kind).toBe('invalidRequest')
    expect(classifyHttpError(402, '').kind).toBe('invalidRequest')
  })
  it('提取三家错误信封里的 message', () => {
    expect(classifyHttpError(400, '{"error":{"message":"m1"}}').message).toBe('m1')
    expect(classifyHttpError(400, '{"error":{"type":"e","message":"m2"}}').message).toBe('m2')
    expect(classifyHttpError(400, '{"error":{"code":429,"message":"m3","status":"X"}}').message).toBe('m3')
    expect(classifyHttpError(500, 'plain').message).toContain('plain')
  })
})
