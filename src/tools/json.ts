export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }
export function assertJson(v: unknown): JsonValue {
  if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v as JsonValue
  if (Array.isArray(v)) return v.map(assertJson)
  if (typeof v === 'object' && v !== null) {
    const out: { [k: string]: JsonValue } = {}
    for (const [k, val] of Object.entries(v)) out[k] = assertJson(val)
    return out
  }
  throw new Error('value is not lossless JSON')
}
