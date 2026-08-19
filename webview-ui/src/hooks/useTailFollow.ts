import { useEffect, type RefObject } from 'react'
import { useAgentStore } from '../store'

/**
 * useTailFollow（【设计稿】§14.1 推荐滚动算法逐行实现，Task 26）：
 * - NEAR_BOTTOM=96：`scrollHeight - scrollTop - clientHeight < 96` 视为近底；
 * - 流式 ops 到达（store 订阅——events 数组引用变化即「长度或最后事件内容」变化，
 *   append/patch 均产生新引用）且近底且未锁定 → requestAnimationFrame 内
 *   scrollTo({ top: scrollHeight, behavior: 'auto' })（禁 smooth：避免持续追赶感）；
 * - 用户上滚（wheel deltaY<0 / touch 指下移）→ 锁定，停止跟随；
 *   再次进入 96px（scroll 事件判定）→ 解锁；
 * - 展开/收起防跳顶：scroll 容器显式启用浏览器原生 overflow-anchor
 *   （锚定可视内容；设计稿允许「overflow-anchor 或记录锚点」二选一）；
 * - reduced-motion 不影响：behavior:'auto' 本就是瞬时滚动（§15.1 滚动/功能不受限）。
 */
const NEAR_BOTTOM = 96

export function useTailFollow(scrollRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // §14「展开/收起：保持当前 anchor 附近视觉位置」——原生滚动锚定（默认 auto，显式固定防样式覆盖）
    el.style.overflowAnchor = 'auto'

    let locked = false
    let rafId = 0

    const nearBottom = (): boolean =>
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM

    /* ---- 用户上滚锁定 / 回底解锁（§14 tail-follow 行为表） ---- */
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) locked = true   // 主动向上 = 查看更早内容
    }
    let touchStartY = 0
    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches.length > 0) touchStartY = e.touches[0].clientY
    }
    const onTouchMove = (e: TouchEvent): void => {
      if (e.touches.length > 0 && e.touches[0].clientY - touchStartY > 0) locked = true  // 指下移 = 向上翻
    }
    const onScroll = (): void => {
      if (locked && nearBottom()) locked = false   // 再次靠近底部 → 恢复跟随
    }

    /* ---- 流式到达：近底且未锁定 → rAF 瞬时贴底（§14.1 算法原文） ---- */
    const unsubscribe = useAgentStore.subscribe((s, prev) => {
      if (s.events === prev.events) return          // 只关心时间线变化（长度/末事件内容）
      if (locked || !nearBottom()) return
      if (rafId) return                             // 同帧去重
      rafId = requestAnimationFrame(() => {
        rafId = 0
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
      })
    })

    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      unsubscribe()
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('scroll', onScroll)
    }
  }, [scrollRef])
}
