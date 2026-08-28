import { useEffect, useRef, useState } from 'react'

/**
 * useThrottled：高频变化值的节流视图（host 侧流式 patch 已 50ms 合并，这里再降一层
 * Markdown parseBlocks 的 O(全文) 重解析频率）。前导立即通过；间隔内的更新合并，
 * 由 trailing 定时器在到点时 flush 最新值——终值不丢（流式结束后的全文必然可见）。
 */
export function useThrottled<T>(value: T, ms = 50): T {
  const [shown, setShown] = useState(value)
  const latest = useRef(value)
  latest.current = value
  const lastAt = useRef(0)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    const now = Date.now()
    const elapsed = now - lastAt.current
    if (elapsed >= ms) {
      lastAt.current = now
      setShown(value)
      return
    }
    if (timer.current !== undefined) return
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      lastAt.current = Date.now()
      setShown(latest.current)
    }, ms - elapsed)
  }, [value, ms])

  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
  }, [])
  return shown
}
