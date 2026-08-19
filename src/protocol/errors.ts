import type { ProtocolErrorKind } from '../shared/protocol'

export function classifyHttpError(status: number, bodyText: string, headers?: { get(k: string): string | null }): { kind: ProtocolErrorKind; message: string; retryAfterMs?: number } {
  let message = bodyText.slice(0, 500)
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } }
    if (parsed.error?.message) message = parsed.error.message
  } catch { /* 非 JSON，保留原文 */ }
  let kind: ProtocolErrorKind
  if (status === 401 || status === 403) kind = 'auth'
  else if (status === 429) kind = 'rateLimit'
  else if (status >= 500) kind = 'server'
  else kind = 'invalidRequest'
  const retryAfterMs = kind === 'rateLimit' && headers ? Number(headers.get('retry-after')) * 1000 || undefined : undefined
  return { kind, message, retryAfterMs }
}
