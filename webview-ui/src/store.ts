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
 * 发送通道由 main.tsx 通过 bindPost 注入；UI 偏好持久化同理经 bindPersistUi
 * 注入（写 vscodeApi.setState）——store 内不触碰 api 模块，读写通道同构。
 */
type PostFn = (m: WebviewMessage) => void
let postImpl: PostFn | null = null
export function bindPost(fn: PostFn): void { postImpl = fn }

type PersistUiFn = (ui: UiPrefs) => void
let persistImpl: PersistUiFn | null = null
/** main.tsx 注入持久化通道（vscodeApi.setState）；未注入时仅内存态（node/测试） */
export function bindPersistUi(fn: PersistUiFn): void { persistImpl = fn }

export interface UiPrefs {
  expandedThoughtIds: string[]
  queueOpen: boolean
  reviewOpen: boolean
}

export const initialUiPrefs: UiPrefs = { expandedThoughtIds: [], queueOpen: true, reviewOpen: false }

interface AgentStore extends WebviewState {
  /** webview 本地 UI 偏好（不进协议：snapshot/ops 不覆盖，见 applyHost） */
  ui: UiPrefs
  /** 最近一次 rpc 结果（组件轮询/回调消费；Task 23+ 细化） */
  lastRpc?: Extract<HostMessage, { type: 'rpcResult' }>
  send(m: WebviewMessage): void
  applyHost(msg: HostMessage): void
  /** 统一 UI 偏好写入（Task 26 收口）：合并 → 更新内存态 → 经注入通道持久化 */
  setUiPref(patch: Partial<UiPrefs>): void
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  ...initialWebviewState('en'),
  ui: initialUiPrefs,
  send: m => { if (postImpl) postImpl(m) },
  applyHost: msg => {
    // snapshot/ops 均为协议态：只替换 WebviewState 字段；ui 为 webview 本地态保留。
    // locale 属协议态（host boot 快照下发 envLanguage）——随 snapshot 更新（I2：此前用内存初值覆盖，恒为 'en'）
    if (msg.type === 'snapshot') set(s => ({ ...msg.state, ui: s.ui }))
    else if (msg.type === 'ops') set(s => ({ ...applyUiOps(s, msg.ops) }))
    // rpcResult 由调用处通过回调消费（组件用 pendingRpc map；简化：存最近结果）
    else if (msg.type === 'rpcResult') set({ lastRpc: msg })
    // P2：changes 清空（新回合/清屏/新会话）时自动收起空审阅面板，
    // 避免 reviewOpen 持久化导致「暂无待审更改」空态常驻
    const st = get()
    if (st.changes.length === 0 && st.ui.reviewOpen) get().setUiPref({ reviewOpen: false })
  },
  setUiPref: patch => {
    const ui = { ...get().ui, ...patch }
    set({ ui })
    if (persistImpl) { try { persistImpl(ui) } catch { /* host 不可达 */ } }
  },
}))
