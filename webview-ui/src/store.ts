import { create } from 'zustand'
import {
  applyUiOps,
  initialWebviewState,
  type HostMessage,
  type WebviewMessage,
  type WebviewState,
} from '@shared/protocol'

/**
 * 本文件必须保持 node 可加载（test/webview-store.test.ts 依赖链）：
 * 禁止 import './api'（acquireVsCodeApi 在 node 下不存在）。
 * 发送通道由 main.tsx 通过 bindPost 注入；persistUi 为占位（Task 26 接 vscodeApi.setState）。
 */
type PostFn = (m: WebviewMessage) => void
let postImpl: PostFn | null = null
export function bindPost(fn: PostFn): void { postImpl = fn }

export interface UiPrefs {
  expandedThoughtIds: string[]
  queueOpen: boolean
  reviewOpen: boolean
}

interface AgentStore extends WebviewState {
  /** 最近一次 rpc 结果（组件轮询/回调消费；Task 23+ 细化） */
  lastRpc?: Extract<HostMessage, { type: 'rpcResult' }>
  send(m: WebviewMessage): void
  applyHost(msg: HostMessage): void
  persistUi(ui: UiPrefs): void
}

export const useAgentStore = create<AgentStore>(set => ({
  ...initialWebviewState('en'),
  send: m => { if (postImpl) postImpl(m) },
  applyHost: msg => {
    if (msg.type === 'snapshot') set(s => ({ ...msg.state, locale: s.locale }))
    else if (msg.type === 'ops') set(s => ({ ...applyUiOps(s, msg.ops) }))
    // rpcResult 由调用处通过回调消费（组件用 pendingRpc map；简化：存最近结果）
    else if (msg.type === 'rpcResult') set({ lastRpc: msg })
  },
  persistUi: _ui => { /* Task 26 接入 vscodeApi.setState（需经组件层访问 api.ts） */ },
}))
