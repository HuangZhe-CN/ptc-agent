import { useCallback, useEffect, useRef, useState } from 'react'
import { useAgentStore } from '../../store'
import type { Protocol } from '@shared/protocol'

/**
 * rpc listModels（Task 25）——webview 侧只管发消息与消费结果。
 * 发送：`{type:'rpc', reqId, method:'listModels', params}`（reqId 模块内单调自增）；
 * 消费：main.tsx 的全局 message 监听已把 host 回包写入 store.lastRpc（applyHost），
 * 此处以 useAgentStore.subscribe 监听 lastRpc 变化并按 reqId 匹配（host 侧 Task 19 未实现时
 * 恒为 pending，UI 呈获取中态——不阻塞手填路径）。
 */
let rpcSeq = 1

export interface ListModelsState {
  pending: boolean
  fetched: boolean
  models: string[]
  error: string | null
}

const IDLE: ListModelsState = { pending: false, fetched: false, models: [], error: null }

export function useListModels(): ListModelsState & {
  fetch: (params: { baseUrl: string; protocol: Protocol }) => void
  reset: () => void
} {
  const [state, setState] = useState<ListModelsState>(IDLE)
  const reqIdRef = useRef<number | null>(null)

  useEffect(() => {
    // zustand v5 原生 subscribe(listener(state, prevState))；lastRpc 未变则跳过
    return useAgentStore.subscribe((s, prev) => {
      if (s.lastRpc === prev.lastRpc) return
      const rpc = s.lastRpc
      if (!rpc || rpc.reqId !== reqIdRef.current) return // 非本组件发起 / 已过期的请求
      reqIdRef.current = null
      if (rpc.ok && Array.isArray(rpc.result)) {
        const models = rpc.result.filter((x): x is string => typeof x === 'string')
        setState({ pending: false, fetched: true, models, error: null })
      } else {
        setState({ pending: false, fetched: true, models: [], error: rpc.error ?? 'listModels failed' })
      }
    })
  }, [])

  const fetch = useCallback((params: { baseUrl: string; protocol: Protocol }): void => {
    const reqId = rpcSeq++
    reqIdRef.current = reqId
    setState({ pending: true, fetched: false, models: [], error: null })
    // providerId 传空串：listModels 针对未落盘的表单草稿（baseUrl+apiKey 在 host 侧即时验证）
    useAgentStore.getState().send({
      type: 'rpc',
      reqId,
      method: 'listModels',
      params: { providerId: '', baseUrl: params.baseUrl, protocol: params.protocol },
    })
  }, [])

  const reset = useCallback((): void => setState(IDLE), [])

  return { ...state, fetch, reset }
}
