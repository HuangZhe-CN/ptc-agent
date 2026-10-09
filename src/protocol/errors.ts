import type { ProtocolErrorKind } from '../shared/protocol'

export function classifyHttpError(status: number, bodyText: string, headers?: { get(k: string): string | null }): { kind: ProtocolErrorKind; message: string; retryAfterMs?: number } {
  let message = bodyText.slice(0, 500)
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } }
    // 提取路径同受 500 封顶（String 兜底非字符串的畸形信封）：网关回显的超长 error.message
    // 会无界进入时间线/JSONL/webview，绕过本函数自身的有界契约
    if (parsed.error?.message) message = String(parsed.error.message).slice(0, 500)
  } catch { /* 非 JSON，保留原文 */ }
  let kind: ProtocolErrorKind
  if (status === 401 || status === 403) kind = 'auth'
  else if (status === 429) kind = 'rateLimit'
  else if (status >= 500) kind = 'server'
  else kind = 'invalidRequest'
  const retryAfterMs = kind === 'rateLimit' && headers ? Number(headers.get('retry-after')) * 1000 || undefined : undefined
  return { kind, message, retryAfterMs }
}
