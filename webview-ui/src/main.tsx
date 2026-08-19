import React from 'react'
import { createRoot } from 'react-dom/client'
import { useAgentStore, bindPost, bindPersistUi, initialUiPrefs, type UiPrefs } from './store'
import { vscodeApi, post } from './api'
import { AgentView } from './components/AgentView/AgentView'
import './styles/tokens.css'

// host→webview 消息监听：模块顶部一次性注册（全局唯一 listener，渲染前生效）
window.addEventListener('message', e => {
  useAgentStore.getState().applyHost(e.data)
})

// store 发送通道注入（store.ts 保持纯逻辑，不 import api.ts）
bindPost(post)

// UI 偏好（Task 26 统一收口）：初值读 vscodeApi.getState()（渲染前注入，组件挂载即见），
// 写回经注入通道 → vscodeApi.setState（store 保持 node 可加载的同构方案）
let savedUi: Partial<UiPrefs> = {}
try { savedUi = (vscodeApi.getState<Partial<UiPrefs>>() ?? {}) as Partial<UiPrefs> } catch { /* 非 webview 环境 */ }
useAgentStore.setState({
  ui: {
    expandedThoughtIds: Array.isArray(savedUi.expandedThoughtIds) ? savedUi.expandedThoughtIds : initialUiPrefs.expandedThoughtIds,
    queueOpen: savedUi.queueOpen ?? initialUiPrefs.queueOpen,
    reviewOpen: savedUi.reviewOpen ?? initialUiPrefs.reviewOpen,
  },
})
bindPersistUi(ui => { try { vscodeApi.setState(ui) } catch { /* host 不可达 */ } })

const root = createRoot(document.getElementById('root')!)
root.render(<AgentView />)

post({ type: 'ready' }) // boot 握手（Goose/Roo 模式）
