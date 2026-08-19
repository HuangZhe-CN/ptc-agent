import React from 'react'
import { createRoot } from 'react-dom/client'
import { useAgentStore, bindPost } from './store'
import { post } from './api'
import { AgentView } from './components/AgentView/AgentView'
import './styles/tokens.css'

// host→webview 消息监听：模块顶部一次性注册（全局唯一 listener，渲染前生效）
window.addEventListener('message', e => {
  useAgentStore.getState().applyHost(e.data)
})

// store 发送通道注入（store.ts 保持纯逻辑，不 import api.ts）
bindPost(post)

const root = createRoot(document.getElementById('root')!)
root.render(<AgentView />)

post({ type: 'ready' }) // boot 握手（Goose/Roo 模式）
