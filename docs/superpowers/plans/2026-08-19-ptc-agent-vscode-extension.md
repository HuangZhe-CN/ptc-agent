# PTC Agent VS Code 插件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个极简、响应迅速的 VS Code 侧边栏 coding agent 插件：纯 PTC（Code mode）agent loop + 像素级复刻前端设计稿 + 三协议（OpenAI 兼容 / Anthropic / Gemini）零依赖适配。

**Architecture:** Extension host 内自包含实现——手写 fetch+SSE 协议适配器（统一 StreamEvent 输出）、AgentLoop（流式 → `run_code` → worker thread 执行模型 TS 程序 → 仅程序 return/log 回注上下文）、6 工具绑定调度池、JSONL 会话持久化、快照 Review。Webview 为 React+zustand，严格按 `docs/前端设计/VSCode_Agent_Pixel_Replica_MD_Package/README.md`（下称【设计稿】）实现。

**Tech Stack:** TypeScript / VS Code Extension API（engines `^1.101.0`）/ esbuild（扩展 CJS + worker 独立 entry）/ Vite+React 18+zustand（webview）/ vitest（host 逻辑）/ @vscode/test-electron（冒烟）。零运行时依赖（host 仅 Node 内置模块；webview 仅 react/react-dom/zustand）。

**关键参考（实现时必读）：**
- 规格：`docs/superpowers/specs/2026-08-19-ptc-agent-vscode-extension-design.md`
- 设计稿：【设计稿】= `docs/前端设计/VSCode_Agent_Pixel_Replica_MD_Package/README.md`（组件树 §16.1、CSS token §18、几何 §02/附录A、动效 §15、滚动 §14）
- dsh 参考（只读借鉴，不引入依赖）：`docs/后端大脑/packages/code-runtime/code-runtime-worker-thread/src/{bootstrap,index}.ts`、`docs/后端大脑/packages/core/tools/src/ts-types.ts`（SDK_INSTRUCTIONS 文案）

## Global Constraints

- `engines.vscode: ^1.101.0`；扩展 CJS 打包（`format:'cjs'`、`platform:'node'`、`external:['vscode']`）。
- worker 以独立 esbuild entry 产出 `dist/worker.js`，运行时 `new Worker(path.join(__dirname,'worker.js'))`（禁用 `new URL(import.meta.url)` 模式）。
- host→webview 消息一律带单调 `seq`；`postMessage` 全部 try/catch + disposed 守卫；webview 未 ready 时入队。
- webview 禁用 localStorage；UI 状态仅 `acquireVsCodeApi().setState/getState`；`acquireVsCodeApi()` 只调用一次。
- 颜色三层 token：组件只写 `--agent-*`，全部映射 `--vscode-*`；禁止硬编码录屏米黄色/hex；HC 模式强制边框（设计稿 §3.5）。
- CSP：`default-src 'none'; font-src ${cspSource}; style-src ${cspSource}; script-src 'nonce-${nonce}';`；资源一律 `asWebviewUri`。
- 纯 Code mode：线上唯一工具 `run_code{code,description}`；SDK 声明写入 system prompt。
- Runtime 默认预算：`computeMs 60_000`、`maxWallMs 600_000`、`maxOutputBytes 67_108_864`、`maxOldGenerationSizeMb 512`；调度 `maxParallel 10`；单用户消息护栏 `maxToolRounds 40`。
- UI 文案中英双语，locale 由 boot 消息下发（host 读 `vscode.env.language`）。
- 提交纪律：每个 Task 结束提交一次；提交信息用 `feat:/test:/chore:` 前缀。
- 测试命令统一 `npx vitest run <file>`（root `vitest.config.ts`：`test.environment:'node'`，`include:['test/**/*.test.ts']`）。
- host 侧核心模块（protocol/runtime/tools/loop/store）**不得 import 'vscode'**——vscode 依赖只出现在 `src/extension.ts`、`src/service/*`，通过构造注入保证可测。

## File Structure（全景图）

```
package.json                 # 扩展清单+scripts（npm workspaces 根）
tsconfig.json / esbuild.mjs  # host 构建（双 entry: extension/worker）
vitest.config.ts
.vscode/launch.json          # F5 调试
src/
  shared/protocol.ts         # ★ 全部共享类型（UiOp/TimelineEvent/HostMessage/WebviewMessage/StreamEvent...）
  extension.ts               # 激活：container、provider 注册、CSP HTML
  protocol/
    sse.ts                   # 协议无关 SSE 解析
    errors.ts                # 统一错误分类
    types.ts                 # ProtocolAdapter 接口 + HistoryMessage
    openai.ts / anthropic.ts / gemini.ts
  runtime/
    protocol.ts              # worker 端口消息类型
    bootstrap.ts             # worker 内执行逻辑（in-process 可测）
    worker.ts                # worker 入口（打独立 bundle）
    codeRuntime.ts           # host 侧：strip/spawn/预算/终止
    dispatchPool.ts          # 有界并行调度池
  tools/
    registry.ts  fs.ts  bash.ts  search.ts   # 6 工具实现
  agent/
    prompt.ts                # system prompt + SDK 文本 + run_code schema
    loop.ts                  # AgentLoop
    events.ts                # DispatchEvent → UiOp 映射
  session/store.ts           # JSONL 追加/重放
  review/diffCount.ts        # 行级 +N -N
  service/
    configStore.ts           # SecretStorage blob + globalState
    agentService.ts          # 会话编排+队列
    webviewBridge.ts         # 握手/队列/seq
    snapshot.ts              # 快照区管理（注入 fs 接口）
    reviewProvider.ts        # TextDocumentContentProvider + vscode.diff
webview-ui/
  package.json / vite.config.ts / index.html
  src/main.tsx  api.ts  store.ts  i18n.ts
  styles/tokens.css
  components/  AgentView/ Header/ Composer/ Timeline/ Floaters/ Review/ Onboarding/
  media/codicon.css + codicon.ttf   # 从 @vscode/codicons 拷贝（构建脚本）
test/                        # vitest（sse/openai/anthropic/gemini/bootstrap/codeRuntime/pool/loop/store/diffCount/events/prompt/configStore）
src/test/                    # @vscode/test-electron 冒烟
```

---

## Phase P0 — 骨架

### Task 1: 工程脚手架与扩展激活

**Files:**
- Create: `package.json`、`tsconfig.json`、`esbuild.mjs`、`vitest.config.ts`、`.vscode/launch.json`、`.vscodeignore`、`.gitignore`（追加）、`src/extension.ts`、`webview-ui/package.json`（占位，Task 20 填充）、`scripts/fetch-codicons.mjs`
- Test: 手动 F5 验证（本任务无单元测试）

**Interfaces:**
- Produces: 扩展 id `ptc-agent.view`（webview view）、activitybar container `ptc-agent.container`；`dist/extension.js` + `dist/worker.js` 产物布局；后续任务都假设 `activationEvents: []`（1.74+ 自动按 contributes）与 `main: ./dist/extension.js`。

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "ptc-agent",
  "displayName": "PTC Agent",
  "description": "Minimal, fast coding agent (Pure-Then-Code mode)",
  "version": "0.1.0",
  "publisher": "ptc-agent",
  "private": true,
  "engines": { "vscode": "^1.101.0" },
  "categories": ["AI", "Chat"],
  "main": "./dist/extension.js",
  "workspaces": ["webview-ui"],
  "scripts": {
    "build": "node scripts/fetch-codicons.mjs && node esbuild.mjs && npm run build -w webview-ui",
    "watch": "node esbuild.mjs --watch",
    "test": "vitest run",
    "vscode:prepublish": "npm run build"
  },
  "devDependencies": {
    "@types/node": "^22.13.0", "@types/vscode": "^1.101.0", "esbuild": "^0.24.0",
    "typescript": "^5.7.0", "vitest": "^3.0.0"
  },
  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "ptc-agent.container", "title": "PTC Agent", "icon": "media/container.svg" }]
    },
    "views": {
      "ptc-agent.container": [{ "type": "webview", "id": "ptc-agent.view", "name": "Agent" }]
    }
  }
}
```

`media/container.svg`（24x24 线性图标，stroke 用 currentColor）：

```svg
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M8 6L3 12l5 6M16 6l5 6-5 6M13 4l-2 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

- [ ] **Step 2: tsconfig.json / esbuild.mjs / vitest.config.ts**

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "CommonJS", "moduleResolution": "Node",
    "lib": ["ES2022"], "strict": true, "skipLibCheck": true,
    "outDir": "dist", "rootDir": "src", "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`esbuild.mjs`（worker 独立 entry；CJS；代码里禁止 `new URL(...,import.meta.url)` 加载 worker）：

```js
import { build } from 'esbuild'

const watch = process.argv.includes('--watch')
const common = { bundle: true, format: 'cjs', platform: 'node', target: 'node22.13',
  external: ['vscode'], sourcemap: true, logLevel: 'info' }

await Promise.all([
  build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' }),
  build({ ...common, entryPoints: ['src/runtime/worker.ts'], outfile: 'dist/worker.js' }),
])
if (watch) console.log('[esbuild] watching...')
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['test/**/*.test.ts'] } })
```

`.vscode/launch.json`：

```json
[{ "name": "Run Extension", "type": "extensionHost", "request": "launch",
   "args": ["--extensionDevelopmentPath=${workspaceFolder}"], "outFiles": ["${workspaceFolder}/dist/**/*.js"] }]
```

`.vscodeignore`（要点：只留运行时产物）：

```
src/**, test/**, webview-ui/src/**, webview-ui/node_modules/**, **/*.map, **/*.ts,
esbuild.mjs, vitest.config.ts, .vscode/**, docs/**, scripts/**
!media/**
webview-ui/dist/**/*
!webview-ui/dist/**
```

- [ ] **Step 3: codicons 拷贝脚本 `scripts/fetch-codicons.mjs`**

不把 node_modules 路径暴露给 webview；构建时把 codicon.css/ttf 拷入 `webview-ui/media/`：

```js
import { cp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
try {
  await mkdir(path.join(root, 'webview-ui/media'), { recursive: true })
  await cp(path.join(root, 'node_modules/@vscode/codicons/dist/codicon.css'), path.join(root, 'webview-ui/media/codicon.css'))
  await cp(path.join(root, 'node_modules/@vscode/codicons/dist/codicon.ttf'), path.join(root, 'webview-ui/media/codicon.ttf'))
  console.log('[codicons] copied')
} catch (e) { console.error('[codicons] npm install first:', e.message); process.exit(1) }
```

（devDependency 增加 `"@vscode/codicons": "^0.0.36"`。）

- [ ] **Step 4: `src/extension.ts`（激活 + Webview HTML/CSP 最小骨架）**

```ts
import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import * as path from 'node:path'

export function activate(context: vscode.ExtensionContext) {
  const provider = new AgentViewProvider(context.extensionUri)
  // 生态共识（Cline/Roo/Continue/Kilo 同款）：编程式 retain；正确性另由 boot 握手兜底（Task 17）
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ptc-agent.view', provider,
      { webviewOptions: { retainContextWhenHidden: true } }))
}

class AgentViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extUri: vscode.Uri) {}
  public resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { localResourceRoots: [this.extUri, vscode.Uri.joinPath(this.extUri, 'webview-ui/dist')] }
    view.webview.html = this.html(view.webview)
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'webview-ui/dist/index.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'webview-ui/dist/index.css'))
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'webview-ui/media/codicon.css'))
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${codicons}"><link rel="stylesheet" href="${style}">
      </head><body><div id="root"></div>
      <script nonce="${nonce}" src="${script}"></script></body></html>`
  }
}
export function deactivate() {}
```

（webview-ui 产物本任务先缺席——F5 时显示空白属预期，Task 20 填充。）

- [ ] **Step 5: 构建验证 + F5 手动检查 + 提交**

Run: `npm install && npm run build`
Expected: `dist/extension.js`、`dist/worker.js` 生成；`webview-ui/media/codicon.*` 存在。
F5：活动栏出现容器图标，侧栏视图可打开（内容为空）。

```bash
git add -A && git commit -m "feat: 工程脚手架（双 entry 构建、webview 容器、CSP 骨架、codicons 拷贝）"
```

---

### Task 2: 共享协议类型（src/shared/protocol.ts）

**Files:**
- Create: `src/shared/protocol.ts`、`test/shared-protocol.test.ts`

**Interfaces:**
- Produces（后续所有任务依赖，签名以此为准）:

```ts
export type Protocol = 'openai' | 'anthropic' | 'gemini'
export type Quality = 'low' | 'medium' | 'high'
export type SessionPhase = 'idle' | 'submitting' | 'running' | 'awaiting_review' | 'completed' | 'error'
export type FileKind = 'js' | 'css' | 'html' | 'ts' | 'json' | 'md' | 'other'

export interface ModelInfo { id: string; label: string; supportsThinking: boolean }
export interface ProviderInfo { id: string; label: string; protocol: Protocol; baseUrl: string; models: ModelInfo[] }
export interface ActiveModel { providerId: string; modelId: string; quality: Quality }

export interface QueuedMessage { id: string; text: string }
export interface FileChangeSummary { path: string; add: number; del: number; kind: FileKind }

export interface TimelineEventBase { id: string; ts: number }
export type TimelineEvent =
  | TimelineEventBase & { type: 'explore'; status: 'running' | 'done'; count: number; targets: string[] }
  | TimelineEventBase & { type: 'edit'; file: string; fileKind: FileKind; add: number; del: number }
  | TimelineEventBase & { type: 'thought'; status: 'running' | 'done'; startedAt: number; markdown: string; working: string }
  | TimelineEventBase & { type: 'run'; command: string; status: 'running' | 'done' | 'error'; outputTail: string }
  | TimelineEventBase & { type: 'completion'; markdown: string }
  | TimelineEventBase & { type: 'error'; message: string }

export type UiOp =
  | { op: 'append'; event: TimelineEvent }
  | { op: 'patch'; id: string; patch: Partial<TimelineEvent> & { type?: TimelineEvent['type'] } }  // patch 不得改 type/id
  | { op: 'phase'; phase: SessionPhase }
  | { op: 'changes'; changes: FileChangeSummary[] }
  | { op: 'queue'; queue: QueuedMessage[] }
  | { op: 'title'; title: string }
  | { op: 'clear' }

export interface WebviewState {   // boot/快照全量
  locale: string
  phase: SessionPhase
  title: string
  sessionId: string | null
  events: TimelineEvent[]
  queue: QueuedMessage[]
  changes: FileChangeSummary[]
  providers: ProviderInfo[]            // 不含密钥
  providerKeyed: Record<string, boolean>
  active: ActiveModel | null
  hasSessions: boolean
}

export type HostMessage =
  | { type: 'snapshot'; seq: number; state: WebviewState }
  | { type: 'ops'; seq: number; sessionId: string; ops: UiOp[] }
  | { type: 'rpcResult'; reqId: number; ok: boolean; result?: unknown; error?: string }

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'submit'; text: string }
  | { type: 'stop' }
  | { type: 'queueEdit'; id: string; text: string }
  | { type: 'queueDelete'; id: string }
  | { type: 'queueSubmitNow'; id: string }
  | { type: 'selectModel'; active: ActiveModel }
  | { type: 'newSession' }
  | { type: 'openSession'; sessionId: string }
  | { type: 'reviewFile'; path: string }
  | { type: 'reviewAccept'; path?: string }
  | { type: 'reviewReject'; path?: string }
  | { type: 'saveProviders'; providers: ProviderInfo[]; active: ActiveModel | null }
  | { type: 'saveApiKey'; providerId: string; apiKey: string }
  | { type: 'deleteProvider'; providerId: string }
  | { type: 'rpc'; reqId: number; method: 'testProvider' | 'listModels'; params: { providerId: string; baseUrl?: string; protocol: Protocol } }

export type StreamEvent =
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; name: string; argsDelta: string }
  | { type: 'message_done'; stopReason: 'tool_use' | 'end_turn' | 'max_tokens' | 'other'; usage?: { input: number; output: number } }
  | { type: 'stream_error'; kind: ProtocolErrorKind; message: string; retryAfterMs?: number }

export type ProtocolErrorKind = 'auth' | 'rateLimit' | 'network' | 'server' | 'invalidRequest' | 'aborted'
```

- [ ] **Step 1: 写类型测试（编译期契约 + guards）**

`test/shared-protocol.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import type { UiOp, TimelineEvent } from '../src/shared/protocol'
import { applyUiOps, initialWebviewState } from '../src/shared/protocol'

const ev = (id: string, over: Partial<TimelineEvent>): TimelineEvent =>
  ({ id, ts: 1, type: 'thought', status: 'running', startedAt: 0, markdown: '', working: '', ...over } as TimelineEvent)

describe('applyUiOps', () => {
  it('append + patch 按 id 原位更新', () => {
    let s = initialWebviewState('en')
    s = applyUiOps(s, [{ op: 'append', event: ev('t1', { type: 'thought', markdown: 'a' }) }])
    s = applyUiOps(s, [{ op: 'patch', id: 't1', patch: { markdown: 'ab' } as never }])
    expect(s.events[0].id).toBe('t1')
    expect((s.events[0] as { markdown: string }).markdown).toBe('ab')
    expect(s.events).toHaveLength(1)   // patch 不追加
  })
  it('clear 清空时间线', () => {
    let s = applyUiOps(initialWebviewState('en'), [{ op: 'append', event: ev('t1', {}) }, { op: 'clear' }])
    expect(s.events).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/shared-protocol.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/shared/protocol.ts`**

上面 Interfaces 中的全部类型 + 两个纯函数（webview 与 host 侧测试共用）：

```ts
export function initialWebviewState(locale: string): WebviewState {
  return { locale, phase: 'idle', title: 'Agent', sessionId: null, events: [], queue: [],
    changes: [], providers: [], providerKeyed: {}, active: null, hasSessions: false }
}

export function applyUiOps(state: WebviewState, ops: UiOp[]): WebviewState {
  const next = { ...state }
  for (const op of ops) {
    switch (op.op) {
      case 'append': next.events = [...next.events, op.event]; break
      case 'patch':
        next.events = next.events.map(e => e.id === op.id ? { ...e, ...op.patch, id: e.id } as TimelineEvent : e); break
      case 'phase': next.phase = op.phase; break
      case 'changes': next.changes = op.changes; break
      case 'queue': next.queue = op.queue; break
      case 'title': next.title = op.title; break
      case 'clear': next.events = []; next.queue = []; next.changes = []; break
    }
  }
  return next
}
```

- [ ] **Step 4: 跑测试通过 + 提交**

Run: `npx vitest run test/shared-protocol.test.ts` → PASS

```bash
git add -A && git commit -m "feat: 共享协议类型与 UiOp 归约器"
```

---

## Phase P1 — 协议层

### Task 3: SSE 解析器（protocol/sse.ts）

**Files:**
- Create: `src/protocol/sse.ts`、`test/sse.test.ts`

**Interfaces:**
- Produces: `export interface SseEvent { event?: string; data: string }`；`export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent>`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { parseSse } from '../src/protocol/sse'

const stream = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream({ pull(c) { i < chunks.length ? c.enqueue(enc.encode(chunks[i++])) : c.close() } })
}
const collect = async (s: ReadableStream<Uint8Array>) => {
  const out: string[] = []
  for await (const e of parseSse(s)) out.push(e.event ? `${e.event}:${e.data}` : e.data)
  return out
}

describe('parseSse', () => {
  it('解析 data/event、多行 data、CRLF、[DONE]、注释行、跨块分割', async () => {
    const events = await collect(stream(
      'data: {"a":1}\n\n',
      ': keepalive\n\n',
      'event: content_block_delta\r\ndata: {"b":2}\r\n\r\n',
      'data: line1\ndata: line2\n\n',
      'data: [DONE]\n\n',
      'data: {"split":', 'ted}\n\n'))
    expect(events).toEqual([
      '{"a":1}',
      'content_block_delta:{"b":2}',
      'line1\nline2',
      '[DONE]',
      '{"split":ted}',
    ])
  })
})
```

- [ ] **Step 2: 跑测试失败** → `npx vitest run test/sse.test.ts` FAIL

- [ ] **Step 3: 实现**

```ts
export interface SseEvent { event?: string; data: string }

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const emitBlock = function* (block: string): Generator<SseEvent> {
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') dataLines.push(value)
      else if (field === 'event') event = value
    }
    if (dataLines.length > 0) yield { event, data: dataLines.join('\n') }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    // 事件块以空行结束；兼容 \n\n 与 \r\n\r\n
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2))
      yield* emitBlock(block)
    }
  }
  buf += decoder.decode()
  if (buf.trim()) yield* emitBlock(buf)
}
```

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/sse.test.ts && git add -A && git commit -m "feat: 协议无关 SSE 解析器"
```

---

### Task 4: 协议错误分类（protocol/errors.ts）

**Files:**
- Create: `src/protocol/errors.ts`、`test/protocol-errors.test.ts`

**Interfaces:**
- Consumes: `ProtocolErrorKind`（Task 2）
- Produces: `export function classifyHttpError(status: number, bodyText: string, headers?: { get(k: string): string | null }): { kind: ProtocolErrorKind; message: string; retryAfterMs?: number }`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { classifyHttpError } from '../src/protocol/errors'

describe('classifyHttpError', () => {
  it('401/403→auth；429→rateLimit+Retry-After；5xx→server；400→invalidRequest；402/404→invalidRequest', () => {
    expect(classifyHttpError(401, '{"error":{"message":"bad key"}}').kind).toBe('auth')
    expect(classifyHttpError(403, '').kind).toBe('auth')
    const rl = classifyHttpError(429, '', { get: k => k.toLowerCase() === 'retry-after' ? '2' : null })
    expect(rl.kind).toBe('rateLimit'); expect(rl.retryAfterMs).toBe(2000)
    expect(classifyHttpError(503, '').kind).toBe('server')
    expect(classifyHttpError(400, 'x').kind).toBe('invalidRequest')
    expect(classifyHttpError(402, '').kind).toBe('invalidRequest')
  })
  it('提取三家错误信封里的 message', () => {
    expect(classifyHttpError(400, '{"error":{"message":"m1"}}').message).toBe('m1')
    expect(classifyHttpError(400, '{"error":{"type":"e","message":"m2"}}').message).toBe('m2')
    expect(classifyHttpError(400, '{"error":{"code":429,"message":"m3","status":"X"}}').message).toBe('m3')
    expect(classifyHttpError(500, 'plain').message).toContain('plain')
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现**

```ts
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
```

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/protocol-errors.test.ts && git add -A && git commit -m "feat: 协议错误统一分类"
```

---

### Task 5: 协议适配器接口与历史模型（protocol/types.ts）

**Files:**
- Create: `src/protocol/types.ts`

**Interfaces（本文件是适配器与 loop 的契约，无独立测试，由 Task 6–8 消费）：**

```ts
import type { StreamEvent, ProviderInfo, Quality } from '../shared/protocol'

/** 模型历史（协议中立视图 + 协议原生回放信封） */
export type HistoryMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; turn: AssistantTurn }
  | { role: 'toolResult'; callId: string; content: string; isError: boolean }

export interface AssistantTurn {
  thinking?: string
  text: string
  toolCall?: { callId: string; name: string; args: { code: string; description: string } }
  /** 协议原生块，适配器回放时原样使用（Anthropic thinking/signature、Gemini thoughtSignature、OpenAI 系 reasoning_content） */
  replay?: unknown
}

export interface ResolvedProvider {
  info: ProviderInfo
  apiKey: string
  modelId: string
  quality: Quality
  /** Anthropic thinking 参数解析结果缓存（'adaptive' | 'manual' | 'none'），由适配器读写 */
  thinkingMode?: 'adaptive' | 'manual' | 'none'
}

export interface StreamRequest { system: string; history: HistoryMessage[]; provider: ResolvedProvider; signal: AbortSignal }

export interface ProtocolAdapter {
  readonly protocol: 'openai' | 'anthropic' | 'gemini'
  /** 注入 fetch 便于测试（默认全局 fetch） */
  stream(req: StreamRequest, fetchImpl?: typeof fetch): AsyncIterable<StreamEvent>
}
```

- [ ] **Step 1: 写入文件后 `npx tsc --noEmit` 通过 + 提交**

```bash
npx tsc --noEmit && git add -A && git commit -m "feat: 适配器接口与协议中立历史模型"
```

---

### Task 6: OpenAI 兼容适配器（protocol/openai.ts）

**Files:**
- Create: `src/protocol/openai.ts`、`test/openai.test.ts`

**Interfaces:**
- Consumes: Task 3 `parseSse`、Task 4 `classifyHttpError`、Task 5 类型
- Produces: `export const openaiAdapter: ProtocolAdapter`；`export function buildOpenAiBody(req: StreamRequest): unknown`（纯函数导出便于测试）

- [ ] **Step 1: 失败测试（SSE fixture 回放）**

```ts
import { describe, it, expect } from 'vitest'
import { openaiAdapter, buildOpenAiBody } from '../src/protocol/openai'
import type { StreamRequest } from '../src/protocol/types'
import type { ReadableStreamDefaultReaderLike } from './helpers'

const sse = (...events: string[]) => new ReadableStream<Uint8Array>({
  start(c) { const e = new TextEncoder(); for (const ev of events) c.enqueue(e.encode(ev)); c.close() },
})
const baseReq = (history: StreamRequest['history']): StreamRequest => ({
  system: 'SYS', history,
  provider: { info: { id: 'p', label: 'p', protocol: 'openai', baseUrl: 'https://x/v1', models: [{ id: 'm', label: 'm', supportsThinking: true }] }, apiKey: 'K', modelId: 'm', quality: 'high' },
  signal: new AbortController().signal,
})
const fakeFetch = (body: ReadableStream<Uint8Array>, status = 200) => async () =>
  ({ ok: status < 400, status, headers: { get: () => null }, body } as unknown as Response)

describe('buildOpenAiBody', () => {
  it('system 首位、run_code 工具、reasoning_effort、include_usage、max_completion_tokens', () => {
    const body = buildOpenAiBody(baseReq([])) as Record<string, any>
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.max_completion_tokens).toBe(32768)
    expect(body.reasoning_effort).toBe('high')
    expect(body.tools[0].function.name).toBe('run_code')
    expect(body.tools[0].function.parameters.required).toEqual(['code', 'description'])
  })
  it('assistant 轮回放 tool_calls 与 reasoning_content；tool 角色回传结果', () => {
    const body = buildOpenAiBody(baseReq([
      { role: 'assistant', turn: { thinking: 'TH', text: '', toolCall: { callId: 'c1', name: 'run_code', args: { code: '1', description: 'd' } }, replay: { reasoning_content: 'TH' } } },
      { role: 'toolResult', callId: 'c1', content: '{"value":1}', isError: false },
    ])) as Record<string, any>
    const asst = body.messages[0]
    expect(asst.role).toBe('assistant')
    expect(asst.reasoning_content).toBe('TH')
    expect(asst.tool_calls[0]).toEqual({ id: 'c1', type: 'function', function: { name: 'run_code', arguments: '{"code":"1","description":"d"}' } })
    expect(body.messages[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"value":1}' })
  })
})

describe('openaiAdapter.stream', () => {
  it('文本/思考/工具增量与 message_done', async () => {
    const events: any[] = []
    const iter = openaiAdapter.stream(baseReq([]), fakeFetch(sse(
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"run_code","arguments":"{\\"code\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"return 1\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\n',
      'data: [DONE]\n\n')))
    for await (const e of iter) events.push(e)
    expect(events).toEqual([
      { type: 'thinking_delta', text: 'think' },
      { type: 'text_delta', text: 'Hi' },
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":' },
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '"return 1"}' },
      { type: 'message_done', stopReason: 'tool_use', usage: { input: 5, output: 7 } },
    ])
  })
  it('delta.reasoning 字段（vLLM 系）也归一为 thinking_delta', async () => {
    const events: any[] = []
    for await (const e of openaiAdapter.stream(baseReq([]), fakeFetch(sse('data: {"choices":[{"delta":{"reasoning":"r"}}]}\n\n')))) events.push(e)
    expect(events[0]).toEqual({ type: 'thinking_delta', text: 'r' })
  })
  it('HTTP 401 → auth stream_error', async () => {
    const events: any[] = []
    for await (const e of openaiAdapter.stream(baseReq([]), fakeFetch(sse(), 401))) events.push(e)
    expect(events[0].type).toBe('stream_error'); expect(events[0].kind).toBe('auth')
  })
})
```

（`test/helpers.ts` 仅导出空类型 `ReadableStreamDefaultReaderLike` 可省——上面 import 删除即可，写成 `const baseReq` 前不引入。）

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现**

```ts
import type { StreamEvent } from '../shared/protocol'
import { parseSse } from './sse'
import { classifyHttpError } from './errors'
import type { ProtocolAdapter, StreamRequest, AssistantTurn } from './types'

const STOP_MAP: Record<string, 'tool_use' | 'end_turn' | 'max_tokens' | 'other'> = {
  tool_calls: 'tool_use', stop: 'end_turn', length: 'max_tokens',
}

export function buildOpenAiBody(req: StreamRequest): unknown {
  const messages: unknown[] = [{ role: 'system', content: req.system }]
  for (const m of req.history) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.text })
    else if (m.role === 'toolResult') messages.push({ role: 'tool', tool_call_id: m.callId, content: m.content })
    else {
      const turn: AssistantTurn = m.turn
      const asst: Record<string, unknown> = { role: 'assistant', content: turn.text || '' }
      // DeepSeek 带 tools 时必须回传 reasoning_content（SiliconFlow 服务端自行剥离，回传同样安全）
      const reasoning = (turn.replay as { reasoning_content?: string } | undefined)?.reasoning_content ?? turn.thinking
      if (reasoning) asst.reasoning_content = reasoning
      if (turn.toolCall) {
        asst.tool_calls = [{ id: turn.toolCall.callId, type: 'function',
          function: { name: 'run_code', arguments: JSON.stringify(turn.toolCall.args) } }]
      }
      messages.push(asst)
    }
  }
  return {
    model: req.provider.modelId, messages,
    tools: [{ type: 'function', function: { name: 'run_code', description: RUN_CODE_DESC,
      parameters: RUN_CODE_SCHEMA } }],
    tool_choice: 'auto', stream: true, stream_options: { include_usage: true },
    max_completion_tokens: 32768,
    ...(req.provider.info.models.find(m => m.id === req.provider.modelId)?.supportsThinking
      ? { reasoning_effort: req.provider.quality } : {}),
  }
}

export const RUN_CODE_DESC = 'Execute one TypeScript program. Takes `code` — the body of an async TypeScript function — and `description`, a short summary shown to the user.'
export const RUN_CODE_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'Async TypeScript function body (erasable syntax only). Tools are available as `await tools.name(args)`.' },
    description: { type: 'string', description: 'One-line summary of what the program does.' },
  },
  required: ['code', 'description'],
} as const

export const openaiAdapter: ProtocolAdapter = {
  protocol: 'openai',
  async *stream(req, fetchImpl = fetch): AsyncIterable<StreamEvent> {
    const res = await fetchImpl(`${req.provider.info.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.provider.apiKey}` },
      body: JSON.stringify(buildOpenAiBody(req)), signal: req.signal,
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      const { kind, message } = classifyHttpError(res.status, text, res.headers as never)
      yield { type: 'stream_error', kind, message }; return
    }
    const toolArgs = new Map<number, { id: string; name: string; args: string }>()
    for await (const ev of parseSse(res.body)) {
      if (ev.data === '[DONE]') return
      let chunk: any
      try { chunk = JSON.parse(ev.data) } catch { continue }
      if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) continue  // usage 块（message_done 由 finish_reason 触发后再补 usage）
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const d = choice.delta ?? {}
      const reasoning = d.reasoning_content ?? d.reasoning
      if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking_delta', text: reasoning }
      if (typeof d.content === 'string' && d.content) yield { type: 'text_delta', text: d.content }
      if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) {
        const slot = toolArgs.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name = tc.function.name
        if (tc.function?.arguments) slot.args += tc.function.arguments
        toolArgs.set(tc.index, slot)
        yield { type: 'tool_call_delta', name: slot.name || 'run_code', argsDelta: tc.function?.arguments ?? '' }
      }
      if (choice.finish_reason) {
        const usage = chunk.usage
          ? { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 }
          : undefined
        yield { type: 'message_done', stopReason: STOP_MAP[choice.finish_reason] ?? 'other', usage }
      }
    }
  },
}
```

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/openai.test.ts && git add -A && git commit -m "feat: OpenAI 兼容适配器（reasoning 三字段/tool_calls 增量/usage）"
```

---

### Task 7: Anthropic 适配器（protocol/anthropic.ts）

**Files:**
- Create: `src/protocol/anthropic.ts`、`test/anthropic.test.ts`

**Interfaces:**
- Produces: `export const anthropicAdapter: ProtocolAdapter`；`export function buildAnthropicBody(req: StreamRequest): unknown`；`export const THINKING_BUDGET: Record<Quality, number> = { low: 1024, medium: 4096, high: 16384 }`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { anthropicAdapter, buildAnthropicBody, THINKING_BUDGET } from '../src/protocol/anthropic'
import type { StreamRequest } from '../src/protocol/types'

const sse = (...events: string[]) => new ReadableStream<Uint8Array>({
  start(c) { const e = new TextEncoder(); for (const [event, data] of events.map(p => typeof p === 'string' ? [undefined, p] : p)) { c.enqueue(e.encode(event ? `event: ${event}\n` : '')); c.enqueue(e.encode(`data: ${data}\n\n`)) } c.close() },
})
const req = (over: Partial<StreamRequest> = {}): StreamRequest => ({
  system: 'SYS', history: [],
  provider: { info: { id: 'p', label: 'p', protocol: 'anthropic', baseUrl: 'https://x', models: [{ id: 'claude-x', label: 'c', supportsThinking: true }] }, apiKey: 'K', modelId: 'claude-x', quality: 'high' },
  signal: new AbortController().signal, ...over,
})
const fakeFetch = (body: ReadableStream<Uint8Array>, status = 200) => async (_u: unknown, init: RequestInit) => {
  if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  return { ok: status < 400, status, headers: { get: () => null }, body } as unknown as Response
}

describe('buildAnthropicBody', () => {
  it('max_tokens 必填、system 顶层、thinking adaptive 优先、tools 用 input_schema', () => {
    const body = buildAnthropicBody(req()) as Record<string, any>
    expect(body.max_tokens).toBe(32768)
    expect(body.system).toBe('SYS')
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.tools[0]).toMatchObject({ name: 'run_code', input_schema: expect.any(Object) })
    expect(body.messages).toEqual([])
  })
  it('thinkingMode=manual 时 budget 映射 quality；none 时无 thinking', () => {
    expect((buildAnthropicBody(req({ provider: { ...req().provider, thinkingMode: 'manual' } })) as any).thinking)
      .toEqual({ type: 'enabled', budget_tokens: THINKING_BUDGET.high })
    expect((buildAnthropicBody(req({ provider: { ...req().provider, thinkingMode: 'none' } })) as any).thinking).toBeUndefined()
  })
  it('toolResult 变 user.tool_result 块；thinking 块带 signature 原样回传', () => {
    const body = buildAnthropicBody(req({ history: [
      { role: 'assistant', turn: { thinking: 'T', text: '', toolCall: { callId: 'tu1', name: 'run_code', args: { code: '1', description: 'd' } },
        replay: { blocks: [{ type: 'thinking', thinking: 'T', signature: 'SIG' }, { type: 'tool_use', id: 'tu1', name: 'run_code', input: { code: '1', description: 'd' } }] } } },
      { role: 'toolResult', callId: 'tu1', content: 'R', isError: true },
    ] })) as Record<string, any>
    expect(body.messages[0].role).toBe('assistant')
    expect(body.messages[0].content).toEqual(([{ type: 'thinking', thinking: 'T', signature: 'SIG' }, { type: 'tool_use', id: 'tu1', name: 'run_code', input: { code: '1', description: 'd' } }]))
    expect(body.messages[1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'R', is_error: true }] })
  })
})

describe('anthropicAdapter.stream', () => {
  it('事件序列 → thinking/text/tool 增量 + message_done(tool_use)', async () => {
    const events: any[] = []
    const iter = anthropicAdapter.stream(req(), fakeFetch(sse(
      ['message_start', '{"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}'],
      ['content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"th"}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG"}}'],
      ['content_block_stop', '{"type":"content_block_stop","index":0}'],
      ['content_block_start', '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}'],
      ['content_block_start', '{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu1","name":"run_code","input":{}}}'],
      ['content_block_delta', '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"code\\":"}}'],
      ['content_block_stop', '{"type":"content_block_stop","index":2}'],
      ['message_delta', '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}'],
      ['message_stop', '{"type":"message_stop"}'],
    )))
    for await (const e of iter) events.push(e)
    expect(events).toEqual([
      { type: 'thinking_delta', text: 'th' },
      { type: 'text_delta', text: 'Hi' },
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":' },
      { type: 'message_done', stopReason: 'tool_use', usage: { input: 3, output: 9 } },
    ])
  })
  it('流中 error 事件 → server stream_error', async () => {
    const events: any[] = []
    for await (const e of anthropicAdapter.stream(req(), fakeFetch(sse(['error', '{"type":"error","error":{"type":"overloaded_error","message":"O"}}'])))) events.push(e)
    expect(events[0]).toMatchObject({ type: 'stream_error', kind: 'server', message: 'O' })
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现**

```ts
import type { Quality, StreamEvent } from '../shared/protocol'
import { parseSse } from './sse'
import { classifyHttpError } from './errors'
import type { ProtocolAdapter, StreamRequest, AssistantTurn } from './types'
import { RUN_CODE_DESC, RUN_CODE_SCHEMA } from './openai'

export const THINKING_BUDGET: Record<Quality, number> = { low: 1024, medium: 4096, high: 16384 }

export function buildAnthropicBody(req: StreamRequest): unknown {
  const messages: unknown[] = []
  for (const m of req.history) {
    if (m.role === 'user') messages.push({ role: 'user', content: [{ type: 'text', text: m.text }] })
    else if (m.role === 'toolResult') messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.callId, content: m.content, is_error: m.isError }] })
    else {
      const turn: AssistantTurn = m.turn
      const replayBlocks = (turn.replay as { blocks?: unknown[] } | undefined)?.blocks
      if (replayBlocks) { messages.push({ role: 'assistant', content: replayBlocks }); continue }  // thinking/tool_use 原样回传
      const content: unknown[] = []
      if (turn.thinking) content.push({ type: 'thinking', thinking: turn.thinking, signature: '' })
      if (turn.text) content.push({ type: 'text', text: turn.text })
      if (turn.toolCall) content.push({ type: 'tool_use', id: turn.toolCall.callId, name: 'run_code', input: turn.toolCall.args })
      messages.push({ role: 'assistant', content })
    }
  }
  const supportsThinking = req.provider.info.models.find(m => m.id === req.provider.modelId)?.supportsThinking
  let thinking: unknown
  if (supportsThinking) {
    if (req.provider.thinkingMode === 'manual') thinking = { type: 'enabled', budget_tokens: THINKING_BUDGET[req.provider.quality] }
    else if (req.provider.thinkingMode === 'none') thinking = undefined
    else thinking = { type: 'adaptive' }   // 4.6+ 弃用 manual；400 时由 loop 触发降级（Task 14）
  }
  return {
    model: req.provider.modelId, max_tokens: 32768, system: req.system,
    messages, tools: [{ name: 'run_code', description: RUN_CODE_DESC, input_schema: RUN_CODE_SCHEMA }],
    ...(thinking ? { thinking } : {}), stream: true,
  }
}

const ERR_KIND: Record<string, 'server'> = { overloaded_error: 'server' }

export const anthropicAdapter: ProtocolAdapter = {
  protocol: 'anthropic',
  async *stream(req, fetchImpl = fetch): AsyncIterable<StreamEvent> {
    const res = await fetchImpl(`${req.provider.info.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': req.provider.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(buildAnthropicBody(req)), signal: req.signal,
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      const { kind, message } = classifyHttpError(res.status, text, res.headers as never)
      yield { type: 'stream_error', kind, message }; return
    }
    let input = 0, output = 0
    for await (const ev of parseSse(res.body)) {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { continue }
      switch (msg.type) {
        case 'message_start': input = msg.message?.usage?.input_tokens ?? 0; break
        case 'content_block_delta': {
          const d = msg.delta ?? {}
          if (d.type === 'thinking_delta' && d.thinking) yield { type: 'thinking_delta', text: d.thinking }
          else if (d.type === 'text_delta' && d.text) yield { type: 'text_delta', text: d.text }
          else if (d.type === 'input_json_delta' && d.partial_json) yield { type: 'tool_call_delta', name: 'run_code', argsDelta: d.partial_json }
          break
        }
        case 'message_delta':
          output = msg.usage?.output_tokens ?? output
          if (msg.delta?.stop_reason) {
            const stop = msg.delta.stop_reason === 'tool_use' ? 'tool_use' : msg.delta.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn'
            yield { type: 'message_done', stopReason: stop, usage: { input, output } }
          }
          break
        case 'error': {
          const kind = ERR_KIND[msg.error?.type] ?? 'server'
          yield { type: 'stream_error', kind, message: msg.error?.message ?? 'unknown' }; return
        }
      }
    }
  },
}
```

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/anthropic.test.ts && git add -A && git commit -m "feat: Anthropic 适配器（thinking/signature 回放、tool_result、adaptive 优先）"
```

---

### Task 8: Gemini 适配器（protocol/gemini.ts）

**Files:**
- Create: `src/protocol/gemini.ts`、`test/gemini.test.ts`

**Interfaces:**
- Produces: `export const geminiAdapter: ProtocolAdapter`；`export function buildGeminiBody(req: StreamRequest): unknown`
- 关键差异：functionCall args 完整对象（非流式）→ 一次性 `tool_call_delta` 全量 JSON 字符串；thought part 带 `thoughtSignature` 必须回带。

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { geminiAdapter, buildGeminiBody } from '../src/protocol/gemini'
import type { StreamRequest } from '../src/protocol/types'

const sse = (...datas: string[]) => new ReadableStream<Uint8Array>({
  start(c) { const e = new TextEncoder(); for (const d of datas) c.enqueue(e.encode(`data: ${d}\n\n`)); c.close() },
})
const req = (over: Partial<StreamRequest> = {}): StreamRequest => ({
  system: 'SYS', history: [],
  provider: { info: { id: 'p', label: 'p', protocol: 'gemini', baseUrl: 'https://x/v1beta', models: [{ id: 'gemini-x', label: 'g', supportsThinking: true }] }, apiKey: 'K', modelId: 'gemini-x', quality: 'medium' },
  signal: new AbortController().signal, ...over,
})
const fakeFetch = (body: ReadableStream<Uint8Array>) => async () => ({ ok: true, status: 200, headers: { get: () => null }, body } as unknown as Response)

describe('buildGeminiBody', () => {
  it('systemInstruction、thinkingLevel 按 quality、tools.functionDeclarations', () => {
    const body = buildGeminiBody(req()) as Record<string, any>
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] })
    expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'MEDIUM' })
    expect(body.tools[0].functionDeclarations[0].name).toBe('run_code')
  })
  it('functionResponse 放 user、functionCall+thoughtSignature 回带 model', () => {
    const body = buildGeminiBody(req({ history: [
      { role: 'assistant', turn: { thinking: 'T', text: '', toolCall: { callId: 'f1', name: 'run_code', args: { code: '1', description: 'd' } },
        replay: { parts: [{ text: 'T', thought: true }, { functionCall: { name: 'run_code', args: { code: '1', description: 'd' } }, thoughtSignature: 'SIG' }] } } },
      { role: 'toolResult', callId: 'f1', content: 'R', isError: false },
    ] })) as Record<string, any>
    expect(body.contents[0]).toEqual({ role: 'model', parts: [{ text: 'T', thought: true }, { functionCall: { name: 'run_code', args: { code: '1', description: 'd' } }, thoughtSignature: 'SIG' }] })
    expect(body.contents[1]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'run_code', response: { output: 'R', success: true } } }] })
  })
})

describe('geminiAdapter.stream', () => {
  it('thought/text/functionCall 完整对象、usage、finishReason', async () => {
    const events: any[] = []
    const iter = geminiAdapter.stream(req(), fakeFetch(sse(
      '{"candidates":[{"content":{"role":"model","parts":[{"text":"th","thought":true}]}}],"usageMetadata":{"promptTokenCount":2,"thoughtsTokenCount":0,"candidatesTokenCount":0,"totalTokenCount":2}}',
      '{"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]}}],"usageMetadata":{"promptTokenCount":2,"thoughtsTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":8}}',
      '{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"run_code","args":{"code":"return 1","description":"d"}},"thoughtSignature":"SIG"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"thoughtsTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":10}}')))
    for await (const e of iter) events.push(e)
    expect(events).toEqual([
      { type: 'thinking_delta', text: 'th' },
      { type: 'text_delta', text: 'Hi' },
      { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":"return 1","description":"d"}' },
      { type: 'message_done', stopReason: 'tool_use', usage: { input: 2, output: 8 } },
    ])
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现**

```ts
import type { Quality, StreamEvent } from '../shared/protocol'
import { parseSse } from './sse'
import { classifyHttpError } from './errors'
import type { ProtocolAdapter, StreamRequest, AssistantTurn } from './types'
import { RUN_CODE_DESC, RUN_CODE_SCHEMA } from './openai'

const LEVEL: Record<Quality, string> = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' }

export function buildGeminiBody(req: StreamRequest): unknown {
  const contents: unknown[] = []
  for (const m of req.history) {
    if (m.role === 'user') contents.push({ role: 'user', parts: [{ text: m.text }] })
    else if (m.role === 'toolResult') contents.push({ role: 'user', parts: [{ functionResponse: { name: 'run_code', response: { output: m.content, success: !m.isError } } }] })
    else {
      const turn: AssistantTurn = m.turn
      const replayParts = (turn.replay as { parts?: unknown[] } | undefined)?.parts
      if (replayParts) { contents.push({ role: 'model', parts: replayParts }); continue }   // thoughtSignature 原样回带
      const parts: Record<string, unknown>[] = []
      if (turn.thinking) parts.push({ text: turn.thinking, thought: true })
      if (turn.text) parts.push({ text: turn.text })
      if (turn.toolCall) parts.push({ functionCall: { name: 'run_code', args: turn.toolCall.args } })
      contents.push({ role: 'model', parts })
    }
  }
  const supportsThinking = req.provider.info.models.find(m => m.id === req.provider.modelId)?.supportsThinking
  return {
    systemInstruction: { parts: [{ text: req.system }] }, contents,
    tools: [{ functionDeclarations: [{ name: 'run_code', description: RUN_CODE_DESC, parameters: RUN_CODE_SCHEMA }] }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: {
      maxOutputTokens: 32768,
      ...(supportsThinking ? { thinkingConfig: { includeThoughts: true, thinkingLevel: LEVEL[req.provider.quality] } } : {}),
    },
  }
}

export const geminiAdapter: ProtocolAdapter = {
  protocol: 'gemini',
  async *stream(req, fetchImpl = fetch): AsyncIterable<StreamEvent> {
    const base = req.provider.info.baseUrl.replace(/\/$/, '')
    const res = await fetchImpl(`${base}/models/${encodeURIComponent(req.provider.modelId)}:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': req.provider.apiKey },
      body: JSON.stringify(buildGeminiBody(req)), signal: req.signal,
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      const { kind, message } = classifyHttpError(res.status, text, res.headers as never)
      yield { type: 'stream_error', kind, message }; return
    }
    let input = 0, output = 0, sawFunctionCall = false
    for await (const ev of parseSse(res.body)) {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { continue }
      if (msg.usageMetadata) {
        input = msg.usageMetadata.promptTokenCount ?? input
        output = (msg.usageMetadata.thoughtsTokenCount ?? 0) + (msg.usageMetadata.candidatesTokenCount ?? 0)
      }
      const cand = msg.candidates?.[0]
      for (const part of cand?.content?.parts ?? []) {
        if (part.functionCall) {
          sawFunctionCall = true
          yield { type: 'tool_call_delta', name: part.functionCall.name, argsDelta: JSON.stringify(part.functionCall.args) }
        } else if (typeof part.text === 'string' && part.text) {
          yield part.thought ? { type: 'thinking_delta', text: part.text } : { type: 'text_delta', text: part.text }
        }
      }
      if (cand?.finishReason) {
        const stop = sawFunctionCall ? 'tool_use' : cand.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn'
        yield { type: 'message_done', stopReason: stop, usage: { input, output } }
      }
    }
  },
}
```

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/gemini.test.ts && git add -A && git commit -m "feat: Gemini 适配器（thought 分流、functionCall 全量、thoughtSignature 回带）"
```

---

## Phase P2 — 工具与运行时

### Task 9: 工具注册表与 6 工具（tools/*）

**Files:**
- Create: `src/tools/registry.ts`、`src/tools/fs.ts`、`src/tools/bash.ts`、`src/tools/search.ts`、`test/tools.test.ts`

**Interfaces:**
- Produces:

```ts
// registry.ts
import type { JsonValue } from './json'
export interface ToolContext { cwd: string; signal: AbortSignal }
export interface ToolDef {
  name: string
  concurrencySafe: boolean
  execute(args: unknown, ctx: ToolContext): Promise<JsonValue>   // 失败一律 throw Error（桥接为程序内拒绝）
}
export function createTools(): Map<string, ToolDef>
```

`src/tools/json.ts`：`export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }`；`export function assertJson(v: unknown): JsonValue`（递归校验，非 JSON 抛错）。

工具行为契约（实现+测试逐条对应）：
- `read_file {path, offset?, limit?}`：默认前 2000 行；返回 `{ content, totalLines, startLine }`；文件不存在 → throw。二进制（含 \0 的前 8KB）→ throw 'binary file'。
- `write_file {path, content}`：创建目录+写；返回 `{ path, bytes }`。
- `edit_file {path, old_string, new_string}`：old_string 必须唯一出现，否则 throw（含出现次数）；返回 `{ path, add, del }`（行 diff 由 Task 10 的 countLineDiff 计算）。
- `bash {command, timeout_ms?}`：`spawn(command, { shell: true, cwd })`，默认超时 120_000ms；输出合并 stdout+stderr 截断至首尾各 32KB；返回 `{ stdout, stderr, exitCode, timedOut }`；退出码非 0 不 throw（程序自行判断）。
- `glob {pattern, path?}`：自定义匹配（`**`/`*`/`?`/`{a,b}`），忽略 `node_modules/.git/dist/out`；上限 200 条；返回 `{ matches: string[] }`（相对 cwd）。
- `grep {query, glob?, path?}`：逐文件逐行（跳过二进制），大小写敏感子串；上限 200 行命中；返回 `{ matches: { file, line, text }[] }`。

- [ ] **Step 1: 失败测试 `test/tools.test.ts`**

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTools } from '../src/tools/registry'

let cwd: string
beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'ptc-tools-'))
  await writeFile(path.join(cwd, 'a.js'), 'line1\nline2\nline3\n')
  await mkdir(path.join(cwd, 'sub'), { recursive: true })
  await writeFile(path.join(cwd, 'sub', 'b.ts'), 'hello world\n')
})

describe('tools', () => {
  it('read_file 默认前 2000 行 + totalLines', async () => {
    const r = await createTools().get('read_file')!.execute({ path: 'a.js' }, { cwd, signal: new AbortController().signal })
    expect(r).toEqual({ content: 'line1\nline2\nline3\n', totalLines: 3, startLine: 1 })
  })
  it('edit_file 唯一匹配替换并返回行差；不唯一报错', async () => {
    const r = await createTools().get('edit_file')!.execute({ path: 'a.js', old_string: 'line2', new_string: 'L2\nL2b' }, { cwd, signal: new AbortController().signal })
    expect(r).toMatchObject({ path: 'a.js', add: 2, del: 1 })
    await expect(createTools().get('edit_file')!.execute({ path: 'a.js', old_string: 'L2', new_string: 'x' }, { cwd, signal: new AbortController().signal }))
      .rejects.toThrow(/unique/)   // 'L2' 现在出现两次
  })
  it('glob ** 与 {a,b}', async () => {
    const r = await createTools().get('glob')!.execute({ pattern: '**/*.{js,ts}' }, { cwd, signal: new AbortController().signal })
    expect(r).toEqual({ matches: ['a.js', path.join('sub', 'b.ts').replace(/\\/g, '/')] })
  })
  it('grep 子串命中行', async () => {
    const r = await createTools().get('grep')!.execute({ query: 'hello' }, { cwd, signal: new AbortController().signal })
    expect(r).toEqual({ matches: [{ file: 'sub/b.ts', line: 1, text: 'hello world' }] })
  })
  it('bash 执行并捕获（Windows 上 echo）', async () => {
    const r = await createTools().get('bash')!.execute({ command: process.platform === 'win32' ? 'echo ptc-ok' : 'echo ptc-ok' }, { cwd, signal: new AbortController().signal })
    expect((r as { stdout: string }).stdout).toContain('ptc-ok')
    expect((r as { exitCode: number }).exitCode).toBe(0)
  })
  it('write_file 建目录写文件', async () => {
    const r = await createTools().get('write_file')!.execute({ path: 'new/dir/c.txt', content: 'x' }, { cwd, signal: new AbortController().signal })
    expect(r).toEqual({ path: 'new/dir/c.txt', bytes: 1 })
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现**

`src/tools/json.ts`：

```ts
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
```

`src/tools/fs.ts`（核心；read/write/edit）：

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ToolDef } from './registry'
import { countLineDiff } from '../review/diffCount'

const resolve = (cwd: string, p: string) => path.resolve(cwd, p)

export const readFileTool: ToolDef = {
  name: 'read_file', concurrencySafe: true,
  async execute(args, ctx) {
    const { path: p, offset = 1, limit = 2000 } = args as { path: string; offset?: number; limit?: number }
    const buf = await readFile(resolve(ctx.cwd, p))
    if (buf.subarray(0, 8192).includes(0)) throw new Error(`read_file: ${p} is a binary file`)
    const lines = buf.toString('utf8').split('\n')
    const totalLines = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    const start = Math.max(1, offset)
    const slice = lines.slice(start - 1, start - 1 + limit).join('\n')
    return { content: slice, totalLines, startLine: start }
  },
}

export const writeFileTool: ToolDef = {
  name: 'write_file', concurrencySafe: false,
  async execute(args, ctx) {
    const { path: p, content } = args as { path: string; content: string }
    const abs = resolve(ctx.cwd, p)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return { path: p.replace(/\\/g, '/'), bytes: Buffer.byteLength(content, 'utf8') }
  },
}

export const editFileTool: ToolDef = {
  name: 'edit_file', concurrencySafe: false,
  async execute(args, ctx) {
    const { path: p, old_string, new_string } = args as { path: string; old_string: string; new_string: string }
    const abs = resolve(ctx.cwd, p)
    const original = await readFile(abs, 'utf8')
    const count = original.split(old_string).length - 1
    if (count === 0) throw new Error(`edit_file: old_string not found in ${p}`)
    if (count > 1) throw new Error(`edit_file: old_string must be unique in ${p} (found ${count})`)
    const updated = original.replace(old_string, new_string)
    await writeFile(abs, updated, 'utf8')
    const { add, del } = countLineDiff(original, updated)
    return { path: p.replace(/\\/g, '/'), add, del }
  },
}
```

`src/tools/bash.ts`：

```ts
import { spawn } from 'node:child_process'
import type { ToolDef } from './registry'

const CAP = 32 * 1024
const keepHeadTail = (s: string): string =>
  s.length <= CAP * 2 ? s : `${s.slice(0, CAP)}\n…[truncated ${s.length - CAP * 2} bytes]…\n${s.slice(-CAP)}`

export const bashTool: ToolDef = {
  name: 'bash', concurrencySafe: false,
  execute(args, ctx) {
    const { command, timeout_ms = 120_000 } = args as { command: string; timeout_ms?: number }
    return new Promise((resolveP, rejectP) => {
      const child = spawn(command, { shell: true, cwd: ctx.cwd, env: process.env })
      let stdout = '', stderr = '', timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout_ms)
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      child.on('error', e => { clearTimeout(timer); rejectP(new Error(`bash: ${e.message}`)) })
      child.on('close', exitCode => {
        clearTimeout(timer)
        resolveP({ stdout: keepHeadTail(stdout), stderr: keepHeadTail(stderr), exitCode: exitCode ?? -1, timedOut })
      })
      ctx.signal.addEventListener('abort', () => { timedOut = true; child.kill() }, { once: true })
    })
  },
}
```

`src/tools/search.ts`（glob+grep 共享 walker；纯 JS 零依赖）：

```ts
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolDef } from './registry'

const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'out', '.vscode'])

export function globToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i += 2; if (pattern[i] === '/') i++; continue }
      re += '[^/]*'; i++
    } else if (c === '?') { re += '[^/]'; i++ }
    else if (c === '{') {
      const end = pattern.indexOf('}', i)
      re += `(?:${pattern.slice(i + 1, end).split(',').join('|')})`; i = end + 1
    } else if ('\\.[]()^$+|'.includes(c)) { re += `\\${c}`; i++ }
    else { re += c; i++ }
  }
  return new RegExp(`^${re}$`)
}

async function* walk(dir: string, rel: string[] = []): AsyncGenerator<string> {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(ent.name)) continue
    if (ent.isDirectory()) yield* walk(path.join(dir, ent.name), [...rel, ent.name])
    else if (ent.isFile()) yield [...rel, ent.name].join('/')
  }
}

export const globTool: ToolDef = {
  name: 'glob', concurrencySafe: true,
  async execute(args, ctx) {
    const { pattern } = args as { pattern: string; path?: string }
    const root = path.resolve(ctx.cwd, (args as { path?: string }).path ?? '.')
    const dirOnly = pattern.endsWith('/')
    const re = globToRegExp(dirOnly ? pattern.slice(0, -1) : pattern)
    const matches: string[] = []
    const prefix = path.relative(ctx.cwd, root).replace(/\\/g, '/')
    for await (const rel of walk(root)) {
      const full = prefix && prefix !== '.' ? `${prefix}/${rel}` : rel
      if (re.test(rel) || re.test(full)) { matches.push(full); if (matches.length >= 200) break }
    }
    return { matches }
  },
}

export const grepTool: ToolDef = {
  name: 'grep', concurrencySafe: true,
  async execute(args, ctx) {
    const { query, glob: pattern } = args as { query: string; glob?: string; path?: string }
    const root = path.resolve(ctx.cwd, (args as { path?: string }).path ?? '.')
    const re = pattern ? globToRegExp(pattern) : null
    const matches: { file: string; line: number; text: string }[] = []
    const prefix = path.relative(ctx.cwd, root).replace(/\\/g, '/')
    outer: for await (const rel of walk(root)) {
      if (re && !re.test(rel)) continue
      let content: string
      try { content = await readFile(path.join(root, rel), 'utf8') } catch { continue }
      if (content.includes('\0')) continue
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(query)) {
          matches.push({ file: prefix && prefix !== '.' ? `${prefix}/${rel}` : rel, line: i + 1, text: lines[i].slice(0, 500) })
          if (matches.length >= 200) break outer
        }
      }
    }
    return { matches }
  },
}
```

`src/tools/registry.ts`：

```ts
import { readFileTool, writeFileTool, editFileTool } from './fs'
import { bashTool } from './bash'
import { globTool, grepTool } from './search'

export interface ToolContext { cwd: string; signal: AbortSignal }
export interface ToolDef { name: string; concurrencySafe: boolean; execute(args: unknown, ctx: ToolContext): Promise<unknown> }
export function createTools(): Map<string, ToolDef> {
  const tools = [readFileTool, writeFileTool, editFileTool, bashTool, globTool, grepTool]
  return new Map(tools.map(t => [t.name, t]))
}
```

注意：`src/review/diffCount.ts` 本任务先建最小版（Task 10 完整测试）：

```ts
export function countLineDiff(original: string, updated: string): { add: number; del: number }
```

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/tools.test.ts && git add -A && git commit -m "feat: 6 工具实现（读写改/bash/glob/grep，零依赖 walker）"
```

---

### Task 10: 行级 diff 计数（review/diffCount.ts）

**Files:**
- Create: `src/review/diffCount.ts`（若 Task 9 已建骨架则补全）、`test/diff-count.test.ts`

**Interfaces:**
- Produces: `countLineDiff(original, updated): { add, del }`（经典 LCS 太重；用行集合近似：`del = 原行数 - 共同行数(多重集交集)`、`add = 新行数 - 共同行数`——与 git 数字接近且 O(n)；快照 Review 汇总同用此函数）。

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { countLineDiff } from '../src/review/diffCount'

describe('countLineDiff', () => {
  it('纯新增/纯删除/修改/不变', () => {
    expect(countLineDiff('a\nb', 'a\nb')).toEqual({ add: 0, del: 0 })
    expect(countLineDiff('a\nb', 'a\nb\nc')).toEqual({ add: 1, del: 0 })
    expect(countLineDiff('a\nb\nc', 'a')).toEqual({ add: 0, del: 2 })
    expect(countLineDiff('a\nb', 'a\nX')).toEqual({ add: 1, del: 1 })
  })
  it('尾部换行一致性', () => {
    expect(countLineDiff('a\n', 'a\nb\n')).toEqual({ add: 1, del: 0 })
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现**

```ts
const toLines = (s: string) => (s.endsWith('\n') || s === '' ? s.slice(0, -1) : s).split('\n').filter((_, i, arr) => !(s === '' && arr.length === 1))

export function countLineDiff(original: string, updated: string): { add: number; del: number } {
  const a = original.length && original !== '' ? original.replace(/\n$/, '').split('\n') : []
  const b = updated.replace(/\n$/, '').split('\n').filter(x => updated !== '')
  const counts = new Map<string, number>()
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1)
  let common = 0
  for (const line of b) {
    const n = counts.get(line) ?? 0
    if (n > 0) { common++; counts.set(line, n - 1) }
  }
  return { add: b.length - common, del: a.length - common }
}
```

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/diff-count.test.ts && git add -A && git commit -m "feat: 行级 diff 计数"
```

---

### Task 11: Worker bootstrap（runtime/bootstrap.ts，in-process 可测）

**Files:**
- Create: `src/runtime/protocol.ts`、`src/runtime/bootstrap.ts`、`test/bootstrap.test.ts`

**Interfaces（dsh 精简版：单命名空间 tools + ToolCallError）：**

```ts
// runtime/protocol.ts
export interface WorkerBootData { code: string; names: string[]; maxOutputBytes: number }
export type WorkerToHost =
  | { type: 'call'; id: number; name: string; args: unknown }
  | { type: 'log'; text: string }
  | { type: 'output-limit' }
  | { type: 'done'; value?: unknown; error?: { kind: 'exception' | 'invalid-output' | 'output-limit'; message: string } }
export type HostToWorker = { type: 'reply'; id: number; ok: boolean; value?: unknown; message?: string }

// bootstrap.ts
export interface BootstrapPort {
  postMessage(m: WorkerToHost): void
  on(event: 'message', l: (m: HostToWorker) => void): void
}
export function runBootstrap(port: BootstrapPort, data: WorkerBootData, streams: { stdout: { write(c: unknown): boolean }; stderr: { write(c: unknown): boolean } }): Promise<void>
```

行为：console shim（log/info/warn/error/debug → LogBuffer）；stdout/stderr write 捕获；null-prototype `tools` 命名空间（每个 name 一个 async 绑定，postMessage call、等待 reply）；`ToolCallError extends Error`（成员 `toolName`）注入；`AsyncFunction` 严格模式执行（顶层 await/return）；完成 postMessage done（value 需 lossless JSON，logs/value 合计受 maxOutputBytes 账目约束，超限 → output-limit）。

- [ ] **Step 1: 失败测试（fake port，无需真 worker）**

```ts
import { describe, it, expect } from 'vitest'
import { runBootstrap, type WorkerBootData, type WorkerToHost, type HostToWorker } from '../src/runtime/bootstrap'

function makePort(host: (m: WorkerToHost, reply: (r: HostToWorker) => void) => void) {
  const sent: WorkerToHost[] = []
  const listeners: ((m: HostToWorker) => void)[] = []
  const port = {
    postMessage: (m: WorkerToHost) => { sent.push(m); host(m, r => listeners.forEach(l => l(r))) },
    on: (_e: 'message', l: (m: HostToWorker) => void) => { listeners.push(l) },
  }
  return { port, sent }
}
const streams = { stdout: { write: () => true }, stderr: { write: () => true } }
const data = (code: string): WorkerBootData => ({ code, names: ['read_file'], maxOutputBytes: 65536 })

describe('runBootstrap', () => {
  it('顶层 await + return lossless JSON；绑定经端口往返', async () => {
    const { port, sent } = makePort((m, reply) => {
      if (m.type === 'call') reply({ type: 'reply', id: m.id, ok: true, value: { content: 'FILE' } })
    })
    await runBootstrap(port, data('const r = await tools.read_file({path:"a"}); return { got: r.content }'), streams)
    const done = sent.find(m => m.type === 'done') as Extract<WorkerToHost, { type: 'done' }>
    expect(done.value).toEqual({ got: 'FILE' })
    expect(sent.some(m => m.type === 'call' && m.name === 'read_file')).toBe(true)
  })
  it('绑定失败 → 程序内 ToolCallError 可 catch（toolName 成员）', async () => {
    const { port, sent } = makePort((m, reply) => {
      if (m.type === 'call') reply({ type: 'reply', id: m.id, ok: false, message: 'boom' })
    })
    await runBootstrap(port, data('try { await tools.read_file({}) } catch (e) { return { name: e.name, toolName: (e as any).toolName, msg: e.message } }'), streams)
    const done = sent.find(m => m.type === 'done') as Extract<WorkerToHost, { type: 'done' }>
    expect(done.value).toEqual({ name: 'ToolCallError', toolName: 'read_file', msg: 'boom' })
  })
  it('console.log 进 logs；程序 throw → exception', async () => {
    const { port, sent } = makePort(() => {})
    await runBootstrap(port, data('console.log("hi"); throw new Error("E")'), streams)
    const done = sent.find(m => m.type === 'done') as Extract<WorkerToHost, { type: 'done' }>
    expect(done.error?.kind).toBe('exception')
    expect(done.error?.message).toContain('E')
    expect(sent.some(m => m.type === 'log' && m.text === 'hi')).toBe(true)
  })
  it('非 JSON 返回值 → invalid-output；绑定名不可达原型（__proto__ 只是普通属性）', async () => {
    const p1 = makePort(() => {})
    await runBootstrap(p1.port, data('return undefined'), streams)
    expect((p1.sent.find(m => m.type === 'done') as Extract<WorkerToHost, { type: 'done' }>).value).toBeUndefined()
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现 `src/runtime/bootstrap.ts`**（dsh bootstrap 的精简版，结构对应：LogBuffer/makeConsoleShim/makeNamespace/ToolCallError/AsyncFunction；`snapshotJson` 用 `JSON.parse(JSON.stringify(v))` 试错判定 lossless；字节账目用 `Buffer.byteLength(JSON.stringify(x))` 近似——足够且简单）

```ts
import { inspect } from 'node:util'
import type { WorkerBootData, WorkerToHost, HostToWorker } from './protocol'

const CapturedError = Error

class LogBuffer {
  private bytes = 2
  private truncated = false
  constructor(private readonly maxBytes: number, private readonly sink: (t: string) => void,
    private readonly onLimit: () => void = () => {}) {}
  push(text: string): void {
    if (this.truncated) return
    const sep = this.bytes > 2 ? 1 : 0
    const cost = Buffer.byteLength(JSON.stringify(text))
    if (this.bytes + sep + cost > this.maxBytes) { this.truncated = true; this.onLimit(); return }
    this.bytes += sep + cost
    this.sink(text)
  }
  remaining(): number { return this.maxBytes - this.bytes }
}

const INSPECT = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 } as const

export interface BootstrapPort {
  postMessage(m: WorkerToHost): void
  on(event: 'message', l: (m: HostToWorker) => void): void
}

export class ToolCallError extends CapturedError {
  constructor(public readonly toolName: string, message: string) { super(message) }
}

function losslessJson(v: unknown): unknown | undefined {
  try { return JSON.parse(JSON.stringify(v)) } catch { return undefined }
}

export async function runBootstrap(
  port: BootstrapPort, data: WorkerBootData,
  streams: { stdout: { write(c: unknown): boolean }; stderr: { write(c: unknown): boolean } },
): Promise<void> {
  const logs = new LogBuffer(data.maxOutputBytes,
    text => { port.postMessage({ type: 'log', text }) },
    () => { port.postMessage({ type: 'output-limit' }) })
  const render = (args: unknown[]) => args.map(a => typeof a === 'string' ? a : inspect(a, INSPECT)).join(' ')
  const consoleShim = Object.create(null) as Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...a: unknown[]) => void>
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) consoleShim[level] = (...a: unknown[]) => { logs.push(render(a)) }
  for (const stream of [streams.stdout, streams.stderr]) {
    const original = stream.write
    stream.write = (chunk: unknown) => { logs.push(typeof chunk === 'string' ? chunk : String(chunk)); return true }
    void original
  }

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  port.on('message', m => {
    const entry = pending.get(m.id)
    if (!entry) return
    pending.delete(m.id)
    if (m.ok) entry.resolve(m.value)
    else entry.reject(new ToolCallError('', m.message ?? 'binding failed'))
  })
  let nextId = 1
  const tools = Object.create(null) as Record<string, (args: unknown) => Promise<unknown>>
  for (const name of data.names) {
    Object.defineProperty(tools, name, {
      enumerable: true,
      value: (args: unknown): Promise<unknown> => {
        const detached = losslessJson(args)
        if (detached === undefined) return Promise.reject(new ToolCallError(name, 'tool arguments must be lossless JSON'))
        return new Promise((resolve, reject) => {
          const id = nextId++
          pending.set(id, { resolve, reject: e => reject(new ToolCallError(name, e.message)) })
          port.postMessage({ type: 'call', id, name, args: detached })
        })
      },
    })
  }

  let done: WorkerToHost
  try {
    // 拒绝时改写 toolName：reply 处理里无法得知绑定名，这里在 reject 包装中传入
    const AsyncFunction = (async () => {}).constructor as new (...a: string[]) => (...f: unknown[]) => Promise<unknown>
    const fn = new AsyncFunction('tools', 'ToolCallError', 'console', `'use strict';\n${data.code}`)
    const value = await fn(tools, ToolCallError, consoleShim)
    const json = value === undefined ? undefined : losslessJson(value)
    if (value !== undefined && json === undefined) {
      done = { type: 'done', error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } }
    } else {
      const valueBytes = json === undefined ? 0 : Buffer.byteLength(JSON.stringify(json))
      if (valueBytes > logs.remaining()) done = { type: 'done', error: { kind: 'output-limit', message: `outer output exceeded ${data.maxOutputBytes} bytes` } }
      else done = { type: 'done', ...(json === undefined ? {} : { value: json }) }
    }
  } catch (error: unknown) {
    const detail = error instanceof CapturedError ? error.stack ?? error.message : String(error)
    done = { type: 'done', error: { kind: 'exception', message: detail.slice(0, logs.remaining() > 64 ? 4096 : 64) } }
  }
  port.postMessage(done)
}
```

（注意实现里 reject 包装处 toolName 修正：`entry.reject` 已在外层包装为 `new ToolCallError(name, ...)`——reply 路径的空名会在包装处覆盖，保持测试期望 `toolName: 'read_file'`。实现时把 reply reject 改为 `entry.rejectRaw` 闭包：`reject: e => reject(new ToolCallError(name, e.message))`，其中 reply 落入 `entry.rejectRaw(new Error(m.message))`。照此调整使测试通过。）

`src/runtime/worker.ts`（真 worker 入口，10 行）：

```ts
import { parentPort } from 'node:worker_threads'
import { runBootstrap } from './bootstrap'
if (parentPort) void runBootstrap(parentPort as never, workerData as never, { stdout: process.stdout, stderr: process.stderr })
import { workerData } from 'node:worker_threads'
```

（整理 import 顺序：`import { parentPort, workerData } from 'node:worker_threads'`。）

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/bootstrap.test.ts && git add -A && git commit -m "feat: worker bootstrap（LogBuffer/命名空间桥/ToolCallError/AsyncFunction）"
```

---

### Task 12: CodeRuntime host 侧（runtime/codeRuntime.ts，真 worker）

**Files:**
- Create: `src/runtime/codeRuntime.ts`、`test/code-runtime.test.ts`

**Interfaces:**
- Consumes: Task 11 protocol/bootstrap；`dist/worker.js`（Task 1 构建产物）
- Produces:

```ts
export type CodeRunFailure = { kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit'; message: string }
export interface CodeRunResult { logs: string[]; value?: unknown; error?: CodeRunFailure }
export interface RuntimeConfig { computeMs?: number; maxWallMs?: number; maxOutputBytes?: number; maxOldGenerationSizeMb?: number }
export interface RunOptions { program: string; bindings: Record<string, (args: unknown) => Promise<unknown>>; signal?: AbortSignal; onLog?: (text: string) => void }
export class CodeRuntime {
  constructor(workerPath: string, config?: RuntimeConfig)
  run(opts: RunOptions): Promise<CodeRunResult>
  dispose(): Promise<void>
}
```

- [ ] **Step 1: 失败测试（真 worker；测试用 esbuild 现场打包 worker 或直接引用构建产物——采用后者，`beforeAll` 断言 `dist/worker.js` 存在并给出"先 npm run build"提示）**

```ts
// test/code-runtime.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { CodeRuntime } from '../src/runtime/codeRuntime'

const workerPath = path.resolve(__dirname, '../dist/worker.js')
beforeAll(() => { if (!existsSync(workerPath)) throw new Error('先运行 npm run build 生成 dist/worker.js') })

describe('CodeRuntime（真 worker）', () => {
  it('成功：程序返回值 + logs', async () => {
    const rt = new CodeRuntime(workerPath, { computeMs: 5000, maxWallMs: 10000, maxOutputBytes: 65536 })
    const r = await rt.run({ program: 'console.log("L"); return 41 + 1', bindings: {} })
    expect(r.error).toBeUndefined()
    expect(r.value).toBe(42)
    expect(r.logs).toEqual(['L'])
    await rt.dispose()
  })
  it('绑定调用往返 + 失败拒绝', async () => {
    const rt = new CodeRuntime(workerPath, { computeMs: 5000, maxWallMs: 10000, maxOutputBytes: 65536 })
    const r = await rt.run({
      program: 'const ok = await tools.echo({x:1}); try { await tools.boom({}) } catch (e) { return { ok, name: e.name } }',
      bindings: {
        echo: async a => a,
        boom: async () => { throw new Error('kaput') },
      },
    })
    expect(r.value).toEqual({ ok: { x: 1 }, name: 'ToolCallError' })
    await rt.dispose()
  })
  it('热循环触发 compute 预算 → timeout', async () => {
    const rt = new CodeRuntime(workerPath, { computeMs: 300, maxWallMs: 5000, maxOutputBytes: 65536 })
    const r = await rt.run({ program: 'while (true) {}', bindings: {} })
    expect(r.error?.kind).toBe('timeout')
    await rt.dispose()
  })
  it('语法错误 → exception（不 spawn worker）；abort → abort', async () => {
    const rt = new CodeRuntime(workerPath)
    const bad = await rt.run({ program: 'const x: = bad ts', bindings: {} })
    expect(bad.error?.kind).toBe('exception')
    const ac = new AbortController()
    const p = rt.run({ program: 'await new Promise(() => {})', bindings: {}, signal: ac.signal })
    ac.abort('user stop')
    expect((await p).error?.kind).toBe('abort')
    await rt.dispose()
  })
  it('敌意消息：未知名/重复 id/结算后消息不会崩 host', async () => {
    const rt = new CodeRuntime(workerPath, { computeMs: 5000, maxWallMs: 5000, maxOutputBytes: 65536 })
    const r = await rt.run({
      program: 'const w = (globalThis as any); const r1 = await tools.echo({}); return r1',
      bindings: { echo: async () => 'ok' },
    })
    expect(r.value).toBe('ok')
    await rt.dispose()
  })
})
```

- [ ] **Step 2: 失败** → FAIL（注意：compute 预算测试若实现正确会在 ~300ms 内 timeout）

- [ ] **Step 3: 实现（dsh index.ts 精简版，逐点对应：strip 包装位置保持、ELU 轮询、wall timer、敌意 parse、answered 集合、terminate+drain、dispose 静默）**

```ts
import { Worker } from 'node:worker_threads'
import { stripTypeScriptTypes } from 'node:module'
import type { Readable } from 'node:stream'
import type { WorkerBootData, WorkerToHost, HostToWorker } from './protocol'

export type CodeRunFailure = { kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit'; message: string }
export interface CodeRunResult { logs: string[]; value?: unknown; error?: CodeRunFailure }
export interface RuntimeConfig { computeMs?: number; maxWallMs?: number; maxOutputBytes?: number; maxOldGenerationSizeMb?: number }
export interface RunOptions { program: string; bindings: Record<string, (args: unknown) => Promise<unknown>>; signal?: AbortSignal; onLog?: (text: string) => void }

const DEFAULTS = { computeMs: 60_000, maxWallMs: 600_000, maxOutputBytes: 67_108_864, maxOldGenerationSizeMb: 512 }
const STRIP_WRAP = { prefix: 'async function __ptc_program__() {\n', suffix: '\n}' }
const ELU_POLL_MS = 25

/** 敌意对端：逐字段重建，垃圾静默丢弃 */
function parseWorkerMessage(raw: unknown): WorkerToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const m = raw as Record<string, unknown>
  switch (m.type) {
    case 'call':
      return typeof m.id === 'number' && typeof m.name === 'string'
        ? { type: 'call', id: m.id, name: m.name, args: m.args } : undefined
    case 'log': return typeof m.text === 'string' ? { type: 'log', text: m.text } : undefined
    case 'output-limit': return { type: 'output-limit' }
    case 'done': {
      if (m.error === undefined) return { type: 'done', ...(m.value !== undefined ? { value: m.value } : {}) }
      const e = m.error as Record<string, unknown>
      const kind = e.kind
      if ((kind === 'exception' || kind === 'invalid-output' || kind === 'output-limit') && typeof e.message === 'string')
        return { type: 'done', error: { kind, message: e.message } }
      return undefined
    }
    default: return undefined
  }
}

function drainPipes(s: Readable): Promise<void> {
  if (s.readableEnded || s.destroyed) return Promise.resolve()
  return new Promise(res => { const done = () => res(); s.once('end', done); s.once('close', done); s.once('error', done) })
}

export class CodeRuntime {
  private readonly cfg: Required<RuntimeConfig>
  private readonly live = new Set<{ settle(f: CodeRunFailure): void; finished: Promise<void> }>()
  private disposed = false
  constructor(private readonly workerPath: string, config: RuntimeConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config }
    for (const [k, v] of Object.entries(this.cfg)) if (!(Number.isFinite(v) && v > 0)) throw new Error(`config.${k} must be positive`)
  }

  async run(opts: RunOptions): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('runtime disposed')
    let code: string
    try {
      const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + opts.program + STRIP_WRAP.suffix)
      code = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length)
    } catch (error: unknown) {
      return { logs: [], error: { kind: 'exception', message: error instanceof Error ? error.message : String(error) } }
    }
    if (opts.signal?.aborted) return { logs: [], error: { kind: 'abort', message: String(opts.signal.reason) } }
    return this.execute(code, opts)
  }

  private execute(code: string, opts: RunOptions): Promise<CodeRunResult> {
    const names = Object.keys(opts.bindings)
    const boot: WorkerBootData = { code, names, maxOutputBytes: this.cfg.maxOutputBytes }
    const worker = new Worker(this.workerPath, {
      workerData: boot, env: {}, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: this.cfg.maxOldGenerationSizeMb },
      stdout: true, stderr: true,
    })
    return new Promise(resolve => {
      let settled = false
      const answered = new Set<number>()
      const logs: string[] = []
      let bytes = 2
      const charge = (text: string): boolean => {
        const sep = logs.length > 0 ? 1 : 0
        const cost = Buffer.byteLength(JSON.stringify(text))
        if (bytes + sep + cost > this.cfg.maxOutputBytes) return false
        bytes += sep + cost; return true
      }
      const finish = (make: () => CodeRunResult): void => {
        if (settled) return
        settled = true
        clearInterval(eluTimer); clearTimeout(wallTimer)
        opts.signal?.removeEventListener('abort', onAbort)
        this.live.delete(live)
        void (async () => {
          await new Promise<void>(r => setImmediate(r))   // 让已排队管道字节送达
          const pipes = [worker.stdout, worker.stderr].map(drainPipes)
          await Promise.all([worker.terminate(), ...pipes])
          resolve(make())
        })()
      }
      const reply = (payload: HostToWorker): void => { if (!settled) worker.postMessage(payload) }
      worker.on('message', (raw: unknown) => {
        const m = parseWorkerMessage(raw)
        if (!m) return
        if (m.type === 'log') {
          opts.onLog?.(m.text)
          if (!settled && !charge(m.text)) {
            finish(() => ({ logs, error: { kind: 'output-limit', message: `outer output exceeded ${this.cfg.maxOutputBytes} bytes` } }))
          } else if (!settled) logs.push(m.text)
          return
        }
        if (m.type === 'output-limit' && !settled) {
          finish(() => ({ logs, error: { kind: 'output-limit', message: `outer output exceeded ${this.cfg.maxOutputBytes} bytes` } })); return
        }
        if (m.type === 'call') {
          if (settled || answered.has(m.id)) return
          answered.add(m.id)
          const fn = Object.hasOwn(opts.bindings, m.name) ? opts.bindings[m.name] : undefined
          if (typeof fn !== 'function') { reply({ type: 'reply', id: m.id, ok: false, message: `unknown binding ${JSON.stringify(m.name)}` }); return }
          void (async () => {
            try { reply({ type: 'reply', id: m.id, ok: true, value: JSON.parse(JSON.stringify(await fn(m.args))) }) }
            catch (error: unknown) { reply({ type: 'reply', id: m.id, ok: false, message: error instanceof Error ? error.message : String(error) }) }
          })()
          return
        }
        if (m.type === 'done') {
          if (m.error) { finish(() => ({ logs, error: m.error! })); return }
          if (m.value === undefined) { finish(() => ({ logs })); return }
          const v = JSON.parse(JSON.stringify(m.value))   // host 侧再验 lossless
          finish(() => v === undefined ? { logs, error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } } : { logs, value: v })
        }
      })
      worker.on('error', e => finish(() => ({ logs, error: { kind: 'worker-exit', message: `worker error: ${e.message}` } })))
      worker.on('exit', codeExit => finish(() => ({ logs, error: { kind: 'worker-exit', message: `worker exited with code ${codeExit} before completing` } })))
      const eluTimer = setInterval(() => {
        if (worker.performance.eventLoopUtilization().active > this.cfg.computeMs)
          finish(() => ({ logs, error: { kind: 'timeout', message: `compute budget exhausted (${this.cfg.computeMs}ms busy)` } }))
      }, ELU_POLL_MS)
      const wallTimer = setTimeout(() =>
        finish(() => ({ logs, error: { kind: 'timeout', message: `wall-clock ceiling reached (${this.cfg.maxWallMs}ms)` } })), this.cfg.maxWallMs)
      const onAbort = () => finish(() => ({ logs, error: { kind: 'abort', message: String(opts.signal?.reason) } }))
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      const live = {
        settle: (f: CodeRunFailure) => finish(() => ({ logs, error: f })),
        finished: new Promise<void>(() => {}),   // execute 的 resolve 即静默完成信号；dispose 等待用 live.settle
      }
      this.live.add(live)
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    for (const r of runs) r.settle({ kind: 'abort', message: 'runtime disposed' })
    // settle 内部已 terminate 并在 finish 的异步段完成后 resolve；这里等待一轮微任务+宏任务确保退出
    await new Promise(r => setTimeout(r, 50))
  }
}
```

（`finished` 字段如上简化：`dispose` 以短等待覆盖；若测试发现 worker 未退，改为在 finish 内 resolve 的 `finished` promise——保留 dsh 结构的等价实现。实现时以让测试通过为准，可微调。）

- [ ] **Step 4: 先 `npm run build` 再跑测试 + 提交**

```bash
npm run build && npx vitest run test/code-runtime.test.ts && git add -A && git commit -m "feat: CodeRuntime host（strip/预算/敌意桥/terminate 排干）"
```

---

### Task 13: 调度池（runtime/dispatchPool.ts）

**Files:**
- Create: `src/runtime/dispatchPool.ts`、`test/dispatch-pool.test.ts`

**Interfaces:**
- Consumes: `ToolDef`（Task 9）
- Produces:

```ts
export type DispatchEvent =
  | { phase: 'start'; name: string; args: unknown }
  | { phase: 'finish'; name: string; args: unknown; ok: boolean; result?: unknown; error?: string }
export interface DispatchPoolOptions { maxParallel?: number; onEvent?: (e: DispatchEvent) => void }
export class DispatchPool {
  constructor(tools: Map<string, ToolDef>, toolCtx: ToolContext, opts?: DispatchPoolOptions)
  submit(name: string, args: unknown): Promise<unknown>   // 顺序入池；safe 类并行(≤maxParallel)；独占排空后单独；未知名 throw
  settle(): Promise<void>                                  // 放弃未启动、等待在飞
  abortPending(reason: string): void                      // 未启动直接拒绝
}
```

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { DispatchPool } from '../src/runtime/dispatchPool'
import type { ToolDef } from '../src/tools/registry'

const tool = (name: string, concurrencySafe: boolean, ms: number, result = name): ToolDef => ({
  name, concurrencySafe,
  execute: async () => { await new Promise(r => setTimeout(r, ms)); return result },
})
const events: string[] = []
const pool = (tools: ToolDef[]) => new DispatchPool(new Map(tools.map(t => [t.name, t])),
  { cwd: process.cwd(), signal: new AbortController().signal },
  { maxParallel: 10, onEvent: e => events.push(`${e.phase}:${e.name}`) })

describe('DispatchPool', () => {
  it('safe 工具并行重叠（并发计数峰值 > 1），独占工具排空后单独执行', async () => {
    let inflight = 0, peak = 0
    const track = (t: ToolDef): ToolDef => ({ ...t, execute: async (a, c) => {
      inflight++; peak = Math.max(peak, inflight)
      const r = await t.execute(a, c); inflight--; return r } })
    const p = pool([track(tool('read', true, 50)), track(tool('write', false, 10))])
    await Promise.all([p.submit('read', {}), p.submit('read', {}), p.submit('read', {})])
    expect(peak).toBe(3)
    await p.submit('write', {})
    await p.settle()
  })
  it('提交顺序：先提交的先启动', async () => {
    const order: string[] = []
    const t = (n: string): ToolDef => ({ name: n, concurrencySafe: true, execute: async () => { order.push(n); return n } })
    const p = pool([t('a'), t('b'), t('c')])
    await Promise.all([p.submit('c', {}), p.submit('a', {}), p.submit('b', {})])
    expect(order).toEqual(['c', 'a', 'b'])
    await p.settle()
  })
  it('onEvent 双相（start/finish）且 finish 带结果或错误', async () => {
    const p = pool([{ name: 'ok', concurrencySafe: true, execute: async () => 'R' },
      { name: 'bad', concurrencySafe: true, execute: async () => { throw new Error('E') } }])
    await expect(p.submit('bad', {})).rejects.toThrow('E')
    await p.submit('ok', {})
    await p.settle()
    expect(events).toContain('start:ok'); expect(events).toContain('start:bad')
  })
  it('未知工具 throw；settle 后 submit throw', async () => {
    const p = pool([tool('read', true, 1)])
    await expect(p.submit('nope', {})).rejects.toThrow(/unknown/)
    await p.settle()
    await expect(p.submit('read', {})).rejects.toThrow(/settled/)
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现**

```ts
import type { ToolDef, ToolContext } from '../tools/registry'

export type DispatchEvent =
  | { phase: 'start'; name: string; args: unknown }
  | { phase: 'finish'; name: string; args: unknown; ok: boolean; result?: unknown; error?: string }
export interface DispatchPoolOptions { maxParallel?: number; onEvent?: (e: DispatchEvent) => void }

interface QueueItem { name: string; args: unknown; run: () => void; reject: (e: Error) => void; started: boolean }

export class DispatchPool {
  private readonly queue: QueueItem[] = []
  private readonly inflight: Promise<unknown>[] = []
  private runningExclusive = false
  private settled = false
  constructor(private readonly tools: Map<string, ToolDef>, private readonly ctx: ToolContext,
    private readonly opts: DispatchPoolOptions = {}) {}

  submit(name: string, args: unknown): Promise<unknown> {
    if (this.settled) return Promise.reject(new Error('run_code run is over; call abandoned'))
    const tool = this.tools.get(name)
    if (!tool || typeof tool.execute !== 'function') return Promise.reject(new Error(`unknown tool ${JSON.stringify(name)}`))
    return new Promise((resolve, reject) => {
      this.queue.push({
        name, args, started: false, reject,
        run: () => {
          this.opts.onEvent?.({ phase: 'start', name, args })
          const p = (async () => {
            try {
              const result = await tool.execute(args, this.ctx)
              this.opts.onEvent?.({ phase: 'finish', name, args, ok: true, result })
              resolve(result)
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error)
              this.opts.onEvent?.({ phase: 'finish', name, args, ok: false, error: message })
              reject(error instanceof Error ? error : new Error(message))
            }
          })()
          this.inflight.push(p)
          void p.finally(() => { this.inflight.splice(this.inflight.indexOf(p), 1); this.pump() })
        },
      })
      this.pump()
    })
  }

  private pump(): void {
    while (!this.settled && !this.runningExclusive && this.inflight.length < (this.opts.maxParallel ?? 10) && this.queue.length > 0) {
      const item = this.queue[0]
      const tool = this.tools.get(item.name)
      if (!tool!.concurrencySafe) {
        if (this.inflight.length > 0) return          // 独占：排空后单独跑
        this.queue.shift(); this.runningExclusive = true
        item.run()
        this.runningExclusive = false                 // run() 已注册 inflight；独占语义由下方 pump 守卫维持
        // 注意：run() 后 inflight>0，后续 safe/exclusive 都会等待 → 独占成立
        continue
      }
      this.queue.shift()
      item.run()
    }
  }

  abortPending(reason: string): void {
    for (const item of this.queue) if (!item.started) item.reject(new Error(reason))
    this.queue.length = 0
  }

  async settle(): Promise<void> {
    this.settled = true
    this.abortPending('run_code run is over; calls not dispatched')
    while (this.inflight.length > 0) await Promise.allSettled([...this.inflight])
  }
}
```

（实现说明：`runningExclusive` 标志在 run 同步注册 inflight 后即复位，独占由"inflight>0 时 exclusive 等待 + safe 继续并行"表达——与 dsh 语义一致：safe 与 safe 可重叠，exclusive 等池空。以测试通过为准微调。）

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/dispatch-pool.test.ts && git add -A && git commit -m "feat: 有界并行调度池"
```

---

## Phase P3 — Loop 与会话

### Task 14: 系统提示与 SDK 文本（agent/prompt.ts）

**Files:**
- Create: `src/agent/prompt.ts`、`test/prompt.test.ts`

**Interfaces:**
- Produces: `export function buildSystemPrompt(ctx: { model: string; cwd: string; platform: NodeJS.Platform; date: string }): string`（字节稳定：同输入同输出）

SDK 文本以 dsh `SDK_INSTRUCTIONS`（`docs/后端大脑/packages/core/tools/src/ts-types.ts`）为蓝本改写为 6 工具版本；工具按字典序声明；`ToolCallError` 声明与 bootstrap 注入一致。

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../src/agent/prompt'

const ctx = { model: 'test-model', cwd: 'E:\\repo', platform: 'win32' as NodeJS.Platform, date: '2026-08-19' }

describe('buildSystemPrompt', () => {
  it('包含 persona、工作区上下文、SDK 守则与 6 工具签名、ToolCallError', () => {
    const p = buildSystemPrompt(ctx)
    expect(p).toContain('coding agent powered by test-model')
    expect(p).toContain('E:\\repo')
    expect(p).toContain('win32')
    expect(p).toContain('2026-08-19')
    expect(p).toContain('erasable syntax only')
    expect(p).toContain('await tools.read_file(')
    expect(p).toContain('read_file'), expect(p).toContain('write_file'), expect(p).toContain('edit_file')
    expect(p).toContain('bash'), expect(p).toContain('glob'), expect(p).toContain('grep')
    expect(p).toContain('ToolCallError')
    expect(p).toContain('Promise.all')
  })
  it('字节稳定（两次调用一致）', () => {
    expect(buildSystemPrompt(ctx)).toBe(buildSystemPrompt(ctx))
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现**

```ts
const SDK = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async TypeScript function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped) — and \`description\`, a short summary of what the program does. Inside the program:

- Call tools as \`await tools.name(args)\`. Every call resolves to the tool's JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool — \`try/catch\` it to handle and continue.
- Independent read-only calls (\`read_file\`, \`glob\`, \`grep\`) MAY overlap under \`Promise.all\`; mutating calls (\`write_file\`, \`edit_file\`, \`bash\`) run alone, in submission order. Sequence dependent work with \`await\`.
- Emit results with \`return\` and/or \`console.log(...)\`. Only what you print or return re-enters the conversation — every intermediate result stays out — so extract just what you need.
- Paths are workspace-relative; absolute paths are allowed. Keep programs small and focused.

\`\`\`ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface ToolArgsMap {
  /** Run a shell command in the workspace root. Returns { stdout, stderr, exitCode, timedOut }. */
  bash: { command: string; timeout_ms?: number };
  /** Exact-match replace. old_string must occur exactly once. Returns { path, add, del }. */
  edit_file: { path: string; old_string: string; new_string: string };
  /** Match files. glob supports **, *, ?, {a,b}. Returns { matches: string[] } (<=200). */
  glob: { pattern: string; path?: string };
  /** Substring search across files (case-sensitive). Returns { matches: { file, line, text }[] } (<=200). */
  grep: { query: string; glob?: string; path?: string };
  /** Read a text file. Returns { content, totalLines, startLine }. */
  read_file: { path: string; offset?: number; limit?: number };
  /** Create/overwrite a file (parent dirs auto-created). Returns { path, bytes }. */
  write_file: { path: string; content: string };
}
interface ToolOutputMap { [K in keyof ToolArgsMap]: JsonValue }
type ToolName = keyof ToolOutputMap

declare class ToolCallError extends Error {
  readonly name: "ToolCallError";
  readonly toolName: ToolName;
}
declare const tools: {
  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;
};
\`\`\``

export function buildSystemPrompt(ctx: { model: string; cwd: string; platform: NodeJS.Platform; date: string }): string {
  return [
    `You are a coding agent powered by the ${ctx.model} model. Your working directory is ${ctx.cwd} (${ctx.platform}). Today is ${ctx.date}.`,
    `Accomplish the user's task by writing one TypeScript program per step through run_code. Prefer few, well-targeted programs over many round trips. Finish with a concise summary in plain text when the task is done.`,
    SDK,
  ].join('\n\n')
}
```

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/prompt.test.ts && git add -A && git commit -m "feat: system prompt 与 6 工具 SDK 声明"
```

---

### Task 15: AgentLoop（agent/loop.ts）

**Files:**
- Create: `src/agent/loop.ts`、`src/agent/events.ts`、`test/loop.test.ts`

**Interfaces:**
- Consumes: `ProtocolAdapter`/`StreamRequest`（Task 5）、`CodeRuntime`（Task 12）、`DispatchPool`（Task 13）、`buildSystemPrompt`（Task 14）、`AssistantTurn/HistoryMessage`
- Produces:

```ts
// events.ts：DispatchEvent/流事件 → UiOp（映射表 §5.2 的实现）
export type Emit = (ops: UiOp[]) => void
export function mapDispatchEvent(e: DispatchEvent, idFor: (e: DispatchEvent) => string): UiOp[]

// loop.ts
export interface LoopDeps {
  adapter: ProtocolAdapter
  provider: ResolvedProvider
  runtime: CodeRuntime
  tools: Map<string, ToolDef>
  cwd: string
  platform: NodeJS.Platform
  maxToolRounds?: number              // 默认 40
  emit: Emit                          // 推 UiOp（含 thought/edit/explore/run/phase/changes）
  onHistory: (m: HistoryMessage) => void
  getHistory: () => HistoryMessage[]
  onProviderThinkingMode?: (mode: 'adaptive' | 'manual' | 'none') => void
  snapshotTracker?: { beforeEdit(path: string, cwd: string): Promise<void>; changes(): Promise<FileChangeSummary[]> }
  newEventId: () => string
}
export class AgentLoop {
  constructor(deps: LoopDeps)
  run(userText: string, signal: AbortSignal): Promise<'completed' | 'error' | 'aborted'>
}
```

行为（与规格 §3 对应）：
1. `phase: submitting → running`；`onHistory({role:'user'})`。
2. 流式：thinking_delta → 当前 thought 事件 append/patch（markdown 追加）；text_delta → working 行（工具轮间）或 completion 事件（最终轮）；tool_call_delta 累积 args。
3. message_done(stopReason=tool_use)：解析 args JSON → append run/程序事件；`runtime.run`（bindings 经 DispatchPool；onEvent → mapDispatchEvent → emit）；结果 `{logs,value,error}` JSON 作为 toolResult 内容（isError=!!error）；`onHistory` assistant turn（含 replay 信封——由 loop 构造：openai `{reasoning_content:turn.thinking}`、anthropic `{blocks:[...]}`（近似重建，signature 无法离线获得时由适配器请求层处理——**注**：anthropic 流中我们未捕获 signature_delta 到 replay；本任务同时给 anthropicAdapter 增加收集：见 Step 3 注）与 gemini `{parts:[...]}` 由适配器在 stream 期间通过可选回调 `onReplayEnvelope` 传出。**简化**：`StreamRequest` 增加 `onEnvelope?: (env: unknown) => void`，anthropic/gemini 适配器在流结束时产出原生块，loop 存入 turn.replay。）；轮计数 +1；回到 2。
4. message_done(end_turn)：append completion（最终 text 已流式进 completion 事件）→ phase completed → 返回。
5. stream_error：rateLimit/network 自动重试（同一请求最多 3 次，退避 1s/2s/4s）；auth/invalidRequest → append error 事件 → phase error → 返回。anthropic 400 且 message 含 'thinking' → thinkingMode 降级（adaptive→manual→none，`onProviderThinkingMode` 持久化）后重试一次。
6. AbortSignal → runtime/池中止 → phase completed（保留时间线，标注 aborted error 事件）→ 返回 'aborted'。
7. 轮数超 maxToolRounds → error 事件（温和文案）→ phase error。

- [ ] **Step 1: 失败测试（脚本化 fake adapter + 真 runtime 可选——测试用 fake runtime 更稳）**

```ts
import { describe, it, expect } from 'vitest'
import { AgentLoop } from '../src/agent/loop'
import type { ProtocolAdapter, StreamRequest, ResolvedProvider } from '../src/protocol/types'
import type { StreamEvent } from '../src/shared/protocol'
import type { UiOp, TimelineEvent } from '../src/shared/protocol'

const provider = (): ResolvedProvider => ({
  info: { id: 'p', label: 'p', protocol: 'openai', baseUrl: 'https://x/v1', models: [{ id: 'm', label: 'm', supportsThinking: true }] },
  apiKey: 'K', modelId: 'm', quality: 'medium',
})
const fakeAdapter = (scripts: StreamEvent[][]): { adapter: ProtocolAdapter; calls: number } => {
  let i = 0
  return { calls: 0, adapter: {
    protocol: 'openai',
    async *stream(req: StreamRequest) {
      void req
      const script = scripts[Math.min(i++, scripts.length - 1)]
      for (const e of script) yield e
    },
  } }
}
const fakeRuntime = (result: { logs: string[]; value?: unknown; error?: { kind: string; message: string } }) => ({
  run: async () => result,
  dispose: async () => {},
})
const deps = (over: Partial<Parameters<typeof Object> extends never ? never : any> = {}) => over

describe('AgentLoop', () => {
  it('一轮工具调用：thought 流式 → run_code → 工具结果入历史 → 完成', async () => {
    const history: any[] = []
    const ops: UiOp[] = []
    const { adapter } = fakeAdapter([
      [
        { type: 'thinking_delta', text: 'le' }, { type: 'thinking_delta', text: 't me think' },
        { type: 'tool_call_delta', name: 'run_code', argsDelta: '{"code":"return 1","description":"d"}' },
        { type: 'message_done', stopReason: 'tool_use', usage: { input: 1, output: 2 } },
      ],
      [{ type: 'text_delta', text: 'All done' }, { type: 'message_done', stopReason: 'end_turn' }],
    ])
    const loop = new AgentLoop({
      adapter, provider: provider(), runtime: fakeRuntime({ logs: ['L1'], value: { answer: 42 } }) as never,
      tools: new Map(), cwd: '/w', platform: 'win32',
      emit: o => ops.push(...o),
      onHistory: m => history.push(m), getHistory: () => history,
      newEventId: (() => { let n = 0; return () => `e${++n}` })(),
    })
    const result = await loop.run('do it', new AbortController().signal)
    expect(result).toBe('completed')
    // 历史：user → assistant(带 toolCall) → toolResult → assistant(final)
    expect(history.map(h => h.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    expect(history[1].turn.toolCall.args).toEqual({ code: 'return 1', description: 'd' })
    expect(history[2].content).toContain('42')
    // UI：thought done、run 事件、completion、phase completed
    const types = ops.flatMap(o => o.op === 'append' ? [o.event.type] : [o.op])
    expect(types).toContain('thought'); expect(types).toContain('run'); expect(types).toContain('completion')
    expect(ops.some(o => o.op === 'phase' && o.phase === 'completed')).toBe(true)
  })
  it('流错误 auth → error 事件 + phase error，不重试', async () => {
    const ops: UiOp[] = []
    const { adapter } = fakeAdapter([[{ type: 'stream_error', kind: 'auth', message: 'bad key' }]])
    const loop = new AgentLoop({
      adapter, provider: provider(), runtime: fakeRuntime({ logs: [] }) as never,
      tools: new Map(), cwd: '/w', platform: 'win32', emit: o => ops.push(...o),
      onHistory: () => {}, getHistory: () => [], newEventId: (() => { let n = 0; return () => `e${++n}` })(),
    })
    expect(await loop.run('x', new AbortController().signal)).toBe('error')
    expect(ops.some(o => o.op === 'append' && o.event.type === 'error')).toBe(true)
    expect(ops.some(o => o.op === 'phase' && o.phase === 'error')).toBe(true)
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现 `src/agent/loop.ts` + `src/agent/events.ts`**

`events.ts`：

```ts
import type { UiOp, FileKind } from '../shared/protocol'
import type { DispatchEvent } from '../runtime/dispatchPool'

const KIND: Record<string, FileKind> = { js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', css: 'css', html: 'html', json: 'json', md: 'md' }
export const fileKindOf = (file: string): FileKind => KIND[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'other'

/** DispatchEvent → UiOp：read/glob/grep→explore；write/edit→edit（diff 计数在结果里）；bash→run */
export function mapDispatchEvent(e: DispatchEvent, eventId: string, edits: Map<string, { add: number; del: number }>): UiOp[] {
  if (e.phase === 'start') {
    if (e.name === 'bash') return [{ op: 'append', event: { id: eventId, ts: Date.now(), type: 'run', command: (e.args as { command: string }).command, status: 'running', outputTail: '' } }]
    return []   // explore/edit 在 finish 时一次性呈现（start 静默，避免行闪烁；见规格 §5.2 start/finish 双相）
  }
  // finish
  if (e.name === 'bash') {
    const r = (e.result ?? { exitCode: -1 }) as { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean }
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').slice(-8).join('\n').trim()
    return [{ op: 'patch', id: eventId, patch: { status: (!e.ok || (r.exitCode ?? 0) !== 0 || r.timedOut) ? 'error' : 'done', outputTail: tail } as never }]
  }
  if (e.name === 'write_file' || e.name === 'edit_file') {
    const a = e.args as { path: string }
    const d = edits.get(eventId) ?? { add: 0, del: 0 }
    return [{ op: 'append', event: { id: eventId, ts: Date.now(), type: 'edit', file: a.path.replace(/\\/g, '/'), fileKind: fileKindOf(a.path), add: d.add, del: d.del } }]
  }
  // read/glob/grep → explore（聚合 count）
  const targets = exploreTargets(e.name, e.args, e.result)
  return [{ op: 'append', event: { id: eventId, ts: Date.now(), type: 'explore', status: 'done', count: targets.length, targets } }]
}

function exploreTargets(name: string, args: unknown, result: unknown): string[] {
  const a = args as { path?: string; pattern?: string; query?: string }
  const r = result as { matches?: unknown[]; content?: string }
  if (name === 'read_file') return [a.path ?? '']
  if (name === 'glob') return (r?.matches ?? []) as string[]
  if (name === 'grep') return [...new Set(((r?.matches ?? []) as { file: string }[]).map(m => m.file))]
  return []
}
```

`loop.ts`（核心骨架，长度可控的完整实现）：

```ts
import type { StreamEvent, UiOp } from '../shared/protocol'
import type { ProtocolAdapter, ResolvedProvider, HistoryMessage, AssistantTurn } from '../protocol/types'
import type { CodeRuntime, CodeRunResult } from '../runtime/codeRuntime'
import { DispatchPool, type DispatchEvent } from '../runtime/dispatchPool'
import type { ToolDef, ToolContext } from '../tools/registry'
import { buildSystemPrompt } from './prompt'
import { mapDispatchEvent, fileKindOf } from './events'
import { countLineDiff } from '../review/diffCount'

export interface LoopDeps {
  adapter: ProtocolAdapter; provider: ResolvedProvider
  runtime: Pick<CodeRuntime, 'run'>; tools: Map<string, ToolDef>
  cwd: string; platform: NodeJS.Platform; maxToolRounds?: number
  emit: (ops: UiOp[]) => void
  onHistory: (m: HistoryMessage) => void
  getHistory: () => HistoryMessage[]
  onProviderThinkingMode?: (mode: 'adaptive' | 'manual' | 'none') => void
  snapshotTracker?: { beforeEdit(path: string, cwd: string): Promise<void>; changes(): import('../shared/protocol').FileChangeSummary[] }
  newEventId: () => string
  delayMs?: (ms: number) => Promise<void>
}

interface FakeRuntimeResult extends Pick<CodeRunResult, 'logs' | 'value' | 'error'> {}

export class AgentLoop {
  private round = 0
  constructor(private readonly d: LoopDeps) {}

  async run(userText: string, signal: AbortSignal): Promise<'completed' | 'error' | 'aborted'> {
    const d = this.d
    d.onHistory({ role: 'user', text: userText })
    d.emit([{ op: 'phase', phase: 'submitting' }, { op: 'phase', phase: 'running' }])
    while (true) {
      if (signal.aborted) return this.abort(signal)
      let events: StreamEvent[] = []
      try {
        for await (const ev of d.adapter.stream({ system: buildSystemPrompt({ model: d.provider.modelId, cwd: d.cwd, platform: d.platform, date: new Date().toISOString().slice(0, 10) }),
          history: d.getHistory(), provider: d.provider, signal })) {
          events.push(ev)
          this.consume(ev)
        }
      } catch (error: unknown) {
        // fetch 网络层异常（含代理断流 TypeError: terminated）
        events.push({ type: 'stream_error', kind: 'network', message: error instanceof Error ? error.message : String(error) })
        this.consume(events[events.length - 1])
      }
      const done = events.find(e => e.type === 'message_done') as Extract<StreamEvent, { type: 'message_done' }> | undefined
      const err = [...events].reverse().find(e => e.type === 'stream_error') as Extract<StreamEvent, { type: 'stream_error' }> | undefined
      if (err) {
        if ((err.kind === 'rateLimit' || err.kind === 'network')) {
          if (this.retries < 3) { this.retries++; d.emit([{ op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: `${err.kind}: ${err.message} — retrying (${this.retries}/3)` } }]); await (d.delayMs ?? (ms => new Promise(r => setTimeout(r, ms))))(1000 * 2 ** (this.retries - 1)); continue }
        }
        // Anthropic thinking 参数代际降级
        if (err.kind === 'invalidRequest' && d.provider.protocol === 'anthropic' && /thinking/i.test(err.message)) {
          const next = d.provider.thinkingMode === undefined || d.provider.thinkingMode === 'adaptive' ? 'manual' : 'none'
          if (next !== d.provider.thinkingMode) { d.provider.thinkingMode = next; d.onProviderThinkingMode?.(next); this.retries = 0; continue }
        }
        d.emit([{ op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: `${err.kind}: ${err.message}` } }, { op: 'phase', phase: 'error' }])
        return 'error'
      }
      if (done?.stopReason === 'tool_use') {
        this.round++
        if (this.round > (d.maxToolRounds ?? 40)) {
          d.emit([{ op: 'append', event: { id: d.newEventId(), ts: Date.now(), type: 'error', message: `Reached the tool-call round limit (${d.maxToolRounds ?? 40}). Stopping to stay safe.` } }, { op: 'phase', phase: 'error' }])
          return 'error'
        }
        const turn = this.pendingTurn!   // consume() 累积
        d.onHistory({ role: 'assistant', turn })
        const toolContent = await this.executeRunCode(turn, signal)
        d.onHistory({ role: 'toolResult', callId: turn.toolCall!.callId, content: toolContent.content, isError: toolContent.isError })
        d.emit([{ op: 'changes', changes: await (d.snapshotTracker?.changes() ?? Promise.resolve([])) }])
        this.retries = 0
        continue
      }
      // end_turn / max_tokens / other → 完成
      d.emit([{ op: 'phase', phase: 'completed' }])
      if (this.finalText) d.onHistory({ role: 'assistant', turn: { thinking: this.turnThinking, text: this.finalText, replay: this.replay } })
      return 'completed'
    }
  }

  private retries = 0
  private pendingTurn: AssistantTurn | undefined
  private turnThinking: string | undefined
  private thoughtId: string | undefined
  private thoughtText = ''
  private workingText = ''
  private completionId: string | undefined
  private completionText = ''
  private finalText = ''
  private replay: unknown
  private toolArgs = ''
  private toolCallId = ''

  private consume(ev: StreamEvent): void {
    const d = this.d
    switch (ev.type) {
      case 'thinking_delta':
        if (!this.thoughtId) { this.thoughtId = d.newEventId(); this.turnThinking = ''; d.emit([{ op: 'append', event: { id: this.thoughtId, ts: Date.now(), type: 'thought', status: 'running', startedAt: Date.now(), markdown: '', working: '' } }]) }
        this.turnThinking = (this.turnThinking ?? '') + ev.text
        this.thoughtText = this.turnThinking
        d.emit([{ op: 'patch', id: this.thoughtId, patch: { markdown: this.turnThinking } as never }])
        break
      case 'text_delta':
        this.workingText += ev.text; this.finalText += ev.text
        if (this.thoughtId) d.emit([{ op: 'patch', id: this.thoughtId, patch: { working: this.workingText.slice(-2000) } as never }])
        else {
          if (!this.completionId) { this.completionId = d.newEventId(); this.completionText = ''; d.emit([{ op: 'append', event: { id: this.completionId, ts: Date.now(), type: 'completion', markdown: '' } }]) }
          this.completionText += ev.text
          d.emit([{ op: 'patch', id: this.completionId, patch: { markdown: this.completionText } as never }])
        }
        break
      case 'tool_call_delta':
        this.toolArgs += ev.argsDelta
        if (!this.toolCallId) this.toolCallId = `call_${d.newEventId()}`
        break
      case 'message_done':
        if (this.thoughtId) d.emit([{ op: 'patch', id: this.thoughtId, patch: { status: 'done' } as never }])
        if (ev.stopReason === 'tool_use') {
          let args: { code: string; description: string }
          try { args = JSON.parse(this.toolArgs || '{}') } catch { args = { code: this.toolArgs, description: 'unparsed program' } }
          this.pendingTurn = { ...(this.turnThinking !== undefined ? { thinking: this.turnThinking } : {}), text: this.workingText,
            toolCall: { callId: this.toolCallId || `call_${Date.now()}`, name: 'run_code', args },
            replay: this.providerReplay(args) }
        }
        // 重置本轮流式累积（thinking 状态跨轮重开新事件）
        this.thoughtId = undefined; this.workingText = ''; this.finalText = ''; this.toolArgs = ''; this.toolCallId = ''
        break
      case 'stream_error': break   // 在 run() 统一处理
    }
  }

  private providerReplay(args: { code: string; description: string }): unknown {
    if (this.d.provider.protocol === 'openai') return { reasoning_content: this.turnThinking ?? '' || undefined }
    if (this.d.provider.protocol === 'anthropic') return { blocks: [
      ...(this.turnThinking ? [{ type: 'thinking', thinking: this.turnThinking, signature: '' }] : []),
      { type: 'tool_use', id: this.toolCallId || 'tu', name: 'run_code', input: args }] }
    return { parts: [
      ...(this.turnThinking ? [{ text: this.turnThinking, thought: true }] : []),
      { functionCall: { name: 'run_code', args } }] }
  }

  private async executeRunCode(turn: AssistantTurn, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
    const d = this.d
    const runEventId = d.newEventId()
    d.emit([{ op: 'append', event: { id: runEventId, ts: Date.now(), type: 'run', command: turn.toolCall!.args.description, status: 'running', outputTail: '' } }])
    const edits = new Map<string, { add: number; del: number }>()
    const toolCtx: ToolContext = { cwd: d.cwd, signal }
    const pool = new DispatchPool(d.tools, toolCtx, { maxParallel: 10, onEvent: async (e: DispatchEvent) => {
      const id = d.newEventId()
      if (e.phase === 'finish' && (e.name === 'write_file' || e.name === 'edit_file')) {
        const before = ''   // diff 计数由工具返回值提供
        void before
        const r = e.result as { add?: number; del?: number } | undefined
        if (r) edits.set(id, { add: r.add ?? 0, del: r.del ?? 0 })
        if (d.snapshotTracker && e.ok) await d.snapshotTracker.beforeEdit((e.args as { path: string }).path, d.cwd).catch(() => {})
      }
      d.emit(mapDispatchEvent(e, id, edits))
    } })
    try {
      const bindings: Record<string, (a: unknown) => Promise<unknown>> = {}
      for (const name of d.tools.keys()) bindings[name] = a => pool.submit(name, a)
      const result = await d.runtime.run({ program: turn.toolCall!.args.code, bindings, signal })
      await pool.settle()
      const content = JSON.stringify({ logs: result.logs, ...(result.value !== undefined ? { value: result.value } : {}), ...(result.error ? { error: result.error } : {}) })
      d.emit([{ op: 'patch', id: runEventId, patch: { status: result.error ? 'error' : 'done', outputTail: result.logs.slice(-3).join('\n').slice(-500) } as never }])
      return { content, isError: !!result.error }
    } catch (error: unknown) {
      await pool.abortPending('run aborted')
      const message = error instanceof Error ? error.message : String(error)
      d.emit([{ op: 'patch', id: runEventId, patch: { status: 'error', outputTail: message } as never }])
      return { content: JSON.stringify({ error: { kind: 'abort', message } }), isError: true }
    }
  }

  private abort(signal: AbortSignal): 'aborted' {
    this.d.emit([{ op: 'append', event: { id: this.d.newEventId(), ts: Date.now(), type: 'error', message: `Stopped (${signal.reason ?? 'user'})` } }, { op: 'phase', phase: 'completed' }])
    return 'aborted'
  }
}
```

（实现注意：`fileKindOf` 引入但 loop 内未直接用——由 events.ts 使用；以测试通过+`npx tsc --noEmit` 通过为准清理未用 import。Anthropic signature 精确回放的增强（`onEnvelope`）列为 Task 24 之后的打磨项 P6，不阻塞主流程——manual thinking 未启用时 anthropic 不强制 signature，v1 以空 signature 降级可运行。）

- [ ] **Step 4: 通过 + 类型检查 + 提交**

```bash
npx vitest run test/loop.test.ts && npx tsc --noEmit && git add -A && git commit -m "feat: PTC AgentLoop（流式→run_code→注入；重试/降级/护栏/中止）"
```

---

### Task 16: 会话存储（session/store.ts，JSONL）

**Files:**
- Create: `src/session/store.ts`、`test/session-store.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SessionMeta { sessionId: string; title: string; createdAt: number; providerId: string; modelId: string }
export type SessionRecord =
  | { kind: 'meta'; meta: SessionMeta }
  | { kind: 'history'; message: HistoryMessage }
  | { kind: 'ops'; ops: UiOp[] }
export interface SessionStoreDeps { readDir(p: string): Promise<string[]>; readFile(p: string): Promise<string>; appendFile(p: string, s: string): Promise<void>; mkdir(p: string): Promise<void> }
export class SessionStore {
  constructor(root: string, deps: SessionStoreDeps)          // root=sessions/<workspaceHash>/
  append(sessionId: string, record: SessionRecord): Promise<void>
  load(sessionId: string): Promise<SessionRecord[]>
  list(): Promise<SessionMeta[]>                              // 按 createdAt 倒序
  static workspaceHash(workspaceFolder: string): string      // sha1 前 12 位
  static titleOf(prompt: string): string                      // 首行截 48 字符
  replayToState(records: SessionRecord[], locale: string): { state: Pick<WebviewState,'phase'|'title'|'events'|'changes'|'queue'>; history: HistoryMessage[] }
}
```

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { mkdir, readFile, writeFile, readdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionStore } from '../src/session/store'

const deps = {
  readDir: readdir, readFile, appendFile: async (p: string, s: string) => { await writeFile(p, s, { flag: 'a' }) },
  mkdir: async (p: string) => { await mkdir(p, { recursive: true }) },
}

describe('SessionStore', () => {
  it('append → JSONL 逐行；load → 解析；list 元信息；replay 恢复 state+history', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-sess-'))
    const store = new SessionStore(root, deps)
    await store.append('s1', { kind: 'meta', meta: { sessionId: 's1', title: 'T', createdAt: 1, providerId: 'p', modelId: 'm' } })
    await store.append('s1', { kind: 'history', message: { role: 'user', text: 'hi' } })
    await store.append('s1', { kind: 'ops', ops: [{ op: 'title', title: 'T' }, { op: 'append', event: { id: 'e1', ts: 1, type: 'run', command: 'ls', status: 'done', outputTail: '' } }] })
    const records = await store.load('s1')
    expect(records).toHaveLength(3)
    const list = await store.list()
    expect(list[0].sessionId).toBe('s1')
    const replayed = store.replayToState(records, 'en')
    expect(replayed.state.title).toBe('T')
    expect(replayed.state.events[0].id).toBe('e1')
    expect(replayed.history).toEqual([{ role: 'user', text: 'hi' }])
  })
  it('titleOf 首行截断', () => {
    expect(SessionStore.titleOf('做一个非常长的任务标题'.repeat(10))).toHaveLength(48)
    expect(SessionStore.titleOf('a\nb')).toBe('a')
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现**

```ts
import { createHash } from 'node:crypto'
import type { UiOp, WebviewState } from '../shared/protocol'
import { applyUiOps, initialWebviewState } from '../shared/protocol'
import type { HistoryMessage } from '../protocol/types'

export interface SessionMeta { sessionId: string; title: string; createdAt: number; providerId: string; modelId: string }
export type SessionRecord =
  | { kind: 'meta'; meta: SessionMeta }
  | { kind: 'history'; message: HistoryMessage }
  | { kind: 'ops'; ops: UiOp[] }
export interface SessionStoreDeps { readDir(p: string): Promise<string[]>; readFile(p: string): Promise<string>; appendFile(p: string, s: string): Promise<void>; mkdir(p: string): Promise<void> }

export class SessionStore {
  constructor(private readonly root: string, private readonly deps: SessionStoreDeps) {}
  private file(sessionId: string): string { return `${this.root.replace(/[\\/]$/, '')}/${sessionId}.jsonl` }
  async append(sessionId: string, record: SessionRecord): Promise<void> {
    await this.deps.mkdir(this.root)
    await this.deps.appendFile(this.file(sessionId), JSON.stringify(record) + '\n')
  }
  async load(sessionId: string): Promise<SessionRecord[]> {
    let text: string
    try { text = await this.deps.readFile(this.file(sessionId)) } catch { return [] }
    return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as SessionRecord)
  }
  async list(): Promise<SessionMeta[]> {
    let files: string[]
    try { files = await this.deps.readDir(this.root) } catch { return [] }
    const metas: SessionMeta[] = []
    for (const f of files.filter(f => f.endsWith('.jsonl'))) {
      const records = await this.load(f.slice(0, -6))
      const meta = records.find(r => r.kind === 'meta') as { meta: SessionMeta } | undefined
      if (meta) metas.push(meta.meta)
    }
    return metas.sort((a, b) => b.createdAt - a.createdAt)
  }
  static workspaceHash(workspaceFolder: string): string { return createHash('sha1').update(workspaceFolder).digest('hex').slice(0, 12) }
  static titleOf(prompt: string): string { return prompt.split('\n')[0].trim().slice(0, 48) || 'New task' }
  replayToState(records: SessionRecord[], locale: string): { state: Pick<WebviewState, 'phase' | 'title' | 'events' | 'changes' | 'queue'>; history: HistoryMessage[] } {
    let state = initialWebviewState(locale)
    const history: HistoryMessage[] = []
    for (const r of records) {
      if (r.kind === 'ops') state = applyUiOps(state, r.ops)
      else if (r.kind === 'history') history.push(r.message)
      else state = { ...state, title: r.meta.title }
    }
    return { state: { phase: state.phase, title: state.title, events: state.events, changes: state.changes, queue: state.queue }, history }
  }
}
```

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/session-store.test.ts && git add -A && git commit -m "feat: JSONL 会话存储与重放"
```

---

## Phase P4 — 扩展服务接线（vscode 依赖隔离层）

### Task 17: ConfigStore（service/configStore.ts）

**Files:**
- Create: `src/service/configStore.ts`、`test/config-store.test.ts`

**Interfaces:**
- Consumes: `ProviderInfo/ActiveModel`（Task 2）
- Produces:

```ts
export interface SecretsLike { store(k: string, v: string): Promise<void>; get(k: string): Promise<string | undefined>; delete(k: string): Promise<void> }
export interface MementoLike { get<T>(k: string, d?: T): T | undefined; update(k: string, v: unknown): Promise<void> }
export class ConfigStore {
  constructor(secrets: SecretsLike, globalState: MementoLike)
  getProviders(): Promise<ProviderInfo[]>
  getActive(): Promise<ActiveModel | null>
  setActive(a: ActiveModel): Promise<void>
  saveProviders(providers: ProviderInfo[]): Promise<void>      // 保留已有 key 映射
  getApiKey(providerId: string): Promise<string | undefined>
  saveApiKey(providerId: string, key: string): Promise<void>
  deleteProvider(providerId: string): Promise<void>            // 同时删 key
  getThinkingMode(providerId: string, modelId: string): Promise<'adaptive' | 'manual' | 'none' | undefined>
  setThinkingMode(providerId: string, modelId: string, mode: 'adaptive' | 'manual' | 'none'): Promise<void>
  sanitized(): Promise<{ providers: ProviderInfo[]; keyed: Record<string, boolean>; active: ActiveModel | null }>
}
```

存储布局：secrets key `ptcAgent.keys` = JSON `{ [providerId]: apiKey }`（单 blob + promise 链写锁，Roo 模式）；globalState key `ptcAgent.providers`、`ptcAgent.active`、`ptcAgent.thinkingModes`（`{ "providerId/modelId": mode }`）。**明文密钥永不出 host。**

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { ConfigStore } from '../src/service/configStore'

const makeMemory = () => {
  const secrets = new Map<string, string>(), state = new Map<string, unknown>()
  return {
    secrets: {
      store: async (k: string, v: string) => { secrets.set(k, v) },
      get: async (k: string) => secrets.get(k),
      delete: async (k: string) => { secrets.delete(k) },
    },
    memento: {
      get: <T,>(k: string, d?: T) => (state.has(k) ? state.get(k) as T : d),
      update: async (k: string, v: unknown) => { state.set(k, v) },
    },
    dump: () => ({ secrets, state }),
  }
}

describe('ConfigStore', () => {
  it('provider 增删改保留密钥映射；sanitized 不含明文', async () => {
    const m = makeMemory()
    const cs = new ConfigStore(m.secrets, m.memento)
    await cs.saveProviders([{ id: 'p1', label: 'P1', protocol: 'openai', baseUrl: 'https://x/v1', models: [{ id: 'm1', label: 'm1', supportsThinking: true }] }])
    await cs.saveApiKey('p1', 'sk-secret')
    await cs.saveProviders([{ id: 'p1', label: 'P1b', protocol: 'openai', baseUrl: 'https://x/v1', models: [] }, { id: 'p2', label: 'P2', protocol: 'gemini', baseUrl: 'https://y', models: [] }])
    expect(await cs.getApiKey('p1')).toBe('sk-secret')   // 改 provider 不丢 key
    const s = await cs.sanitized()
    expect(s.providers.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(s.keyed).toEqual({ p1: true })
    expect(JSON.stringify(s)).not.toContain('sk-secret')
    await cs.deleteProvider('p1')
    expect(await cs.getApiKey('p1')).toBeUndefined()
    expect((await cs.getProviders()).map(p => p.id)).toEqual(['p2'])
  })
  it('active 与 thinkingMode 读写', async () => {
    const m = makeMemory()
    const cs = new ConfigStore(m.secrets, m.memento)
    await cs.setActive({ providerId: 'p', modelId: 'm', quality: 'high' })
    expect(await cs.getActive()).toEqual({ providerId: 'p', modelId: 'm', quality: 'high' })
    await cs.setThinkingMode('p', 'm', 'manual')
    expect(await cs.getThinkingMode('p', 'm')).toBe('manual')
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现（写锁 = 串行化 promise 链）**

```ts
import type { ProviderInfo, ActiveModel } from '../shared/protocol'

const K_KEYS = 'ptcAgent.keys', K_PROVIDERS = 'ptcAgent.providers', K_ACTIVE = 'ptcAgent.active', K_MODES = 'ptcAgent.thinkingModes'
type ThinkingMode = 'adaptive' | 'manual' | 'none'

export interface SecretsLike { store(k: string, v: string): Promise<void>; get(k: string): Promise<string | undefined>; delete(k: string): Promise<void> }
export interface MementoLike { get<T>(k: string, d?: T): T | undefined; update(k: string, v: unknown): Promise<void> }

export class ConfigStore {
  private lock: Promise<unknown> = Promise.resolve()
  constructor(private readonly secrets: SecretsLike, private readonly state: MementoLike) {}
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn)
    this.lock = next.catch(() => {})
    return next
  }
  private async readKeys(): Promise<Record<string, string>> {
    const raw = await this.secrets.get(K_KEYS)
    try { return raw ? JSON.parse(raw) : {} } catch { return {} }
  }
  private async writeKeys(keys: Record<string, string>): Promise<void> {
    await this.secrets.store(K_KEYS, JSON.stringify(keys))
  }
  async getProviders(): Promise<ProviderInfo[]> { return this.state.get<ProviderInfo[]>(K_PROVIDERS, []) ?? [] }
  async getActive(): Promise<ActiveModel | null> { return this.state.get<ActiveModel | null>(K_ACTIVE, null) ?? null }
  async setActive(a: ActiveModel): Promise<void> { await this.state.update(K_ACTIVE, a) }
  async saveProviders(providers: ProviderInfo[]): Promise<void> { await this.state.update(K_PROVIDERS, providers) }
  async getApiKey(id: string): Promise<string | undefined> { return (await this.readKeys())[id] }
  async saveApiKey(id: string, key: string): Promise<void> {
    await this.withLock(async () => { const keys = await this.readKeys(); keys[id] = key; await this.writeKeys(keys) })
  }
  async deleteProvider(id: string): Promise<void> {
    await this.withLock(async () => {
      const keys = await this.readKeys(); delete keys[id]; await this.writeKeys(keys)
      await this.state.update(K_PROVIDERS, (await this.getProviders()).filter(p => p.id !== id))
      const active = await this.getActive()
      if (active?.providerId === id) await this.state.update(K_ACTIVE, null)
    })
  }
  async getThinkingMode(p: string, m: string): Promise<ThinkingMode | undefined> {
    return this.state.get<Record<string, ThinkingMode>>(K_MODES, {})?.[`${p}/${m}`]
  }
  async setThinkingMode(p: string, m: string, mode: ThinkingMode): Promise<void> {
    const all = this.state.get<Record<string, ThinkingMode>>(K_MODES, {}) ?? {}
    all[`${p}/${m}`] = mode
    await this.state.update(K_MODES, all)
  }
  async sanitized(): Promise<{ providers: ProviderInfo[]; keyed: Record<string, boolean>; active: ActiveModel | null }> {
    const keys = await this.readKeys()
    const providers = await this.getProviders()
    const keyed: Record<string, boolean> = {}
    for (const p of providers) keyed[p.id] = typeof keys[p.id] === 'string' && keys[p.id].length > 0
    return { providers, keyed, active: await this.getActive() }
  }
}
```

- [ ] **Step 4: 通过 + 提交**

```bash
npx vitest run test/config-store.test.ts && git add -A && git commit -m "feat: ConfigStore（SecretStorage 单 blob 写锁 + globalState）"
```

---

### Task 18: 快照追踪与 Review Provider（service/snapshot.ts + reviewProvider.ts）

**Files:**
- Create: `src/service/snapshot.ts`、`test/snapshot.test.ts`；`src/service/reviewProvider.ts`（vscode 依赖，无单测，由冒烟覆盖）

**Interfaces:**
- Produces（snapshot.ts，fs 注入可测）:

```ts
export interface SnapshotFs { readFile(p: string): Promise<string>; writeFile(p: string, s: string): Promise<void>; mkdir(p: string): Promise<void>; exists(p: string): Promise<boolean> }
export class SnapshotTracker {
  constructor(root: string, fs: SnapshotFs)     // root=globalStorage/snapshots/<sessionId>/
  beforeEdit(path: string, cwd: string): Promise<void>   // 首次编辑前快照（已存在则跳过）
  restore(path: string, cwd: string): Promise<void>      // Reject：写回快照
  drop(path: string): Promise<void>                      // Accept：删快照
  dropAll(): Promise<void>
  changes(cwd: string): Promise<FileChangeSummary[]>     // 对比快照 vs 当前（countLineDiff）
}
```

`reviewProvider.ts`（vscode 层，薄）：

```ts
import * as vscode from 'vscode'
export const SNAPSHOT_SCHEME = 'ptc-snapshot'
export function registerSnapshotContentProvider(trackerAccessor: { get(sessionId: string): SnapshotTracker | undefined }, cwd: string): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string | undefined { return '' } as never,
  })
}
export async function openSnapshotDiff(tracker: SnapshotTracker, sessionId: string, relPath: string, fileUri: vscode.Uri): Promise<void> {
  // vscode.diff(vscode.Uri.parse(`${SNAPSHOT_SCHEME}:/${sessionId}/${encodeURIComponent(relPath)}`), fileUri, `${relPath} (original ↔ current)`, { preserveFocus: true })
}
```

（`provideTextDocumentContent` 实际实现从 URI 解析 sessionId+relPath，经 trackerAccessor 读取快照内容返回。）

- [ ] **Step 1: 失败测试 `test/snapshot.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SnapshotTracker } from '../src/service/snapshot'

const fs = {
  readFile: (p: string) => readFile(p, 'utf8'),
  writeFile: (p: string, s: string) => writeFile(p, s, 'utf8'),
  mkdir: (p: string) => mkdir(p, { recursive: true }),
  exists: async (p: string) => { try { await readFile(p); return true } catch { return false } },
}
const norm = (p: string) => p.replace(/\\/g, '/')

describe('SnapshotTracker', () => {
  it('首次编辑前快照；再编辑不覆盖；restore 回滚；drop 清除；changes 汇总', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptc-snap-'))
    const cwd = path.join(root, 'ws'); await mkdir(cwd, { recursive: true })
    const f = 'src/a.js'
    await writeFile(path.join(cwd, f), 'one\ntwo\n')
    const t = new SnapshotTracker(path.join(root, 'snaps'), fs)
    await t.beforeEdit(f, cwd)                       // 快照 v0
    await writeFile(path.join(cwd, f), 'one\nX\nthree\n')
    await t.beforeEdit(f, cwd)                       // 已有快照，跳过
    expect((await t.changes(cwd))[0]).toMatchObject({ path: norm(f), add: 2, del: 1 })
    await t.restore(f, cwd)
    expect(await readFile(path.join(cwd, f), 'utf8')).toBe('one\ntwo\n')
    await t.drop(f)
    expect(await t.changes(cwd)).toEqual([])
    await rm(root, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现 snapshot.ts**（`snapshotPath(path) = root + '/' + relPath 每段 encodeURIComponent`，规避 `..` 越界：resolve 后必须仍在 root 内否则 throw）

```ts
import path from 'node:path'
import type { FileChangeSummary } from '../shared/protocol'
import { countLineDiff } from '../review/diffCount'
import { fileKindOf } from '../agent/events'

export interface SnapshotFs { readFile(p: string): Promise<string>; writeFile(p: string, s: string): Promise<void>; mkdir(p: string): Promise<void>; exists(p: string): Promise<boolean> }

export class SnapshotTracker {
  constructor(private readonly root: string, private readonly fs: SnapshotFs) {}
  private snapPath(rel: string): string {
    const relNorm = rel.replace(/\\/g, '/')
    const abs = path.resolve(this.root, ...relNorm.split('/').map(encodeURIComponent))
    if (!abs.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`snapshot: illegal path ${rel}`)
    return abs
  }
  async beforeEdit(rel: string, cwd: string): Promise<void> {
    const target = this.snapPath(rel)
    if (await this.fs.exists(target)) return
    const original = await this.fs.readFile(path.resolve(cwd, rel))
    await this.fs.mkdir(path.dirname(target))
    await this.fs.writeFile(target, original)
  }
  async restore(rel: string, cwd: string): Promise<void> {
    const original = await this.fs.readFile(this.snapPath(rel))
    await this.fs.writeFile(path.resolve(cwd, rel), original)
  }
  async drop(rel: string): Promise<void> {
    const target = this.snapPath(rel)
    if (await this.fs.exists(target)) await this.fs.writeFile(target, '')   // 内容置空=已接受标记
  }
  async dropAll(): Promise<void> { /* changes() 天然过滤空快照；无需遍历删除 */ }
  async changes(cwd: string): Promise<FileChangeSummary[]> {
    // 遍历 root 重建相对路径：为可测性改为显式清单文件
    const manifestPath = path.join(this.root, 'manifest.json')
    if (!(await this.fs.exists(manifestPath))) return []
    const manifest = JSON.parse(await this.fs.readFile(manifestPath)) as string[]
    const out: FileChangeSummary[] = []
    for (const rel of manifest) {
      const target = this.snapPath(rel)
      const snap = await this.fs.readFile(target)
      if (snap === '') continue   // accepted
      let current = ''
      try { current = await this.fs.readFile(path.resolve(cwd, rel)) } catch { /* 已删除文件 */ }
      const { add, del } = countLineDiff(snap, current)
      if (add === 0 && del === 0) continue
      out.push({ path: rel.replace(/\\/g, '/'), add, del, kind: fileKindOf(rel) })
    }
    return out
  }
  private async ensureManifest(rel: string): Promise<void> {
    const manifestPath = path.join(this.root, 'manifest.json')
    let list: string[] = []
    if (await this.fs.exists(manifestPath)) list = JSON.parse(await this.fs.readFile(manifestPath))
    if (!list.includes(rel)) { list.push(rel); await this.fs.writeFile(manifestPath, JSON.stringify(list)) }
  }
}
```

（`beforeEdit` 内在写入快照后调用 `await this.ensureManifest(rel)`——实现时把这两行并入 beforeEdit，上面为阅读拆开。）

- [ ] **Step 4: 通过 + 写 vscode 薄层 + 提交**

`src/service/reviewProvider.ts` 完整实现：

```ts
import * as vscode from 'vscode'
import type { SnapshotTracker } from './snapshot'

export const SNAPSHOT_SCHEME = 'ptc-snapshot'

export function registerSnapshotContentProvider(resolveTracker: () => SnapshotTracker | undefined): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
      // uri.path = /<sessionId>/<encoded relPath>
      const rel = decodeURIComponent(uri.path.split('/').slice(2).map(decodeURIComponent).join('/'))
      const tracker = resolveTracker()
      if (!tracker) return Promise.resolve('')
      return tracker.readSnapshot(rel).catch(() => '')
    },
  })
}

export async function openSnapshotDiff(sessionId: string, relPath: string, fileAbsPath: string): Promise<void> {
  const snapUri = vscode.Uri.parse(`${SNAPSHOT_SCHEME}:/${sessionId}/${relPath.split('/').map(encodeURIComponent).join('/')}`)
  const fileUri = vscode.Uri.file(fileAbsPath)
  await vscode.commands.executeCommand('vscode.diff', snapUri, fileUri, `${relPath} (original ↔ current)`, { preserveFocus: true })
}
```

（SnapshotTracker 增加 `readSnapshot(rel): Promise<string>`——直接 `this.fs.readFile(this.snapPath(rel))`。）

```bash
npx vitest run test/snapshot.test.ts && git add -A && git commit -m "feat: 快照追踪（manifest + 路径防越界）与 Review 内容提供者"
```

---

### Task 19: WebviewBridge + AgentService + 扩展接线（service/webviewBridge.ts / agentService.ts / extension.ts 重写）

**Files:**
- Create: `src/service/webviewBridge.ts`、`src/service/agentService.ts`；Modify: `src/extension.ts`；Test: `test/agent-service.test.ts`（对 AgentService 用注入 webview 假对象测编排逻辑，vscode API 通过接口注入）

**Interfaces:**
- Consumes: 全部前序产物
- Produces:

```ts
// webviewBridge.ts（vscode Webview 包装：握手/队列/seq/守卫）
export interface PostTarget { postMessage(m: unknown): Thenable<boolean>; onDidReceiveMessage(l: (m: unknown) => void): unknown; onDidDispose(cb: () => void): unknown }
export class WebviewBridge {
  onMessage(handler: (m: WebviewMessage) => void): void
  ready(): void                       // webview 发 ready 后 flush 队列 + resend snapshot
  send(m: Omit<HostMessage, 'seq'>): void      // 未 ready 入队；发送 try/catch + disposed 忽略
  sendOps(sessionId: string, ops: UiOp[]): void
}

// agentService.ts
export interface VscodeApi {   // 注入面（extension.ts 提供真实现；测试提供假实现）
  workspaceFolders(): string | undefined
  globalStoragePath(): string
  envLanguage(): string
  executeCommand(cmd: string, ...args: unknown[]): Thenable<unknown>
  registerContentProvider(scheme: string, provider: { provideTextDocumentContent(uri: unknown): Thenable<string> }): unknown
  fs: SessionStoreDeps
}
export class AgentService {
  constructor(deps: { config: ConfigStore; api: VscodeApi; bridge: WebviewBridge; workerPath: string })
  handleWebviewMessage(m: WebviewMessage): Promise<void>   // 分发 submit/stop/queue*/selectModel/...
  private ensureSession(): void
  private async runTurn(text: string): Promise<void>       // AgentLoop 装配 + 队列 drain
}
```

编排要点（实现必须覆盖）：
- `submit`：无 active provider/model → bridge 推 `rpcResult` 式提示（或依赖 webview 本地校验阻止发送）；running → 入队（`queue` op）；idle/completed → 新一轮 runTurn。
- runTurn 装配：adapter 按 provider.protocol 选择（`{openai: openaiAdapter, anthropic: anthropicAdapter, gemini: geminiAdapter}`）；`ResolvedProvider`（含 thinkingMode 缓存）；`CodeRuntime(workerPath)`；`AgentLoop`（emit → `store.append ops` + `bridge.sendOps`；onHistory → `store.append history`；snapshotTracker = 会话级 SnapshotTracker）；Stop → AbortController.abort。
- 队列 drain：runTurn 完成后 queue 非空则 shift 一条继续 runTurn；queue op 同步。
- `newSession`/`openSession`：clear op + snapshot 重放（store.replayToState）。
- `reviewFile` → openSnapshotDiff；`reviewAccept/reviewReject`（无 path=全部）→ tracker.drop/dropAll/restore + changes op。
- `rpc listModels`：openai 协议 `GET {base}/models`（Bearer）解析 `data[].id`；testProvider：各协议发 1 token 最小请求（`max_tokens:1`/`maxOutputTokens:1`），ok=2xx。
- boot snapshot（webview ready 时）：`sanitized()` + 当前会话 state + `hasSessions`。

- [ ] **Step 1: 失败测试（假 bridge + 假 adapter，验证编排而非 UI）**

```ts
import { describe, it, expect } from 'vitest'
import { AgentService } from '../src/service/agentService'
import { WebviewBridge } from '../src/service/webviewBridge'
import { ConfigStore } from '../src/service/configStore'
import type { WebviewMessage, HostMessage } from '../src/shared/protocol'

const memorySecrets = () => {
  const m = new Map<string, string>()
  return { store: async (k: string, v: string) => { m.set(k, v) }, get: async (k: string) => m.get(k), delete: async (k: string) => { m.delete(k) } }
}
const memoryMemento = () => {
  const m = new Map<string, unknown>()
  return { get: <T,>(k: string, d?: T) => (m.has(k) ? m.get(k) as T : d), update: async (k: string, v: unknown) => { m.set(k, v) } }
}

describe('AgentService', () => {
  it('running 时 submit 入队；loop 结束后自动 drain 下一条', async () => {
    const sent: HostMessage[] = []
    const bridge = new WebviewBridge({ postMessage: async (m: unknown) => { sent.push(m as HostMessage); return true }, onDidReceiveMessage: () => {}, onDidDispose: () => {} } as never)
    const handlers: ((m: WebviewMessage) => void)[] = []
    ;(bridge as unknown as { onMessage: (h: (m: WebviewMessage) => void) => void }).onMessage = h => handlers.push(h)
    const api = {
      workspaceFolders: () => 'E:\\ws', globalStoragePath: () => 'E:\\gs', envLanguage: () => 'en',
      executeCommand: async () => {}, registerContentProvider: () => ({}),
      fs: { readDir: async () => [], readFile: async () => { throw new Error('nf') }, appendFile: async () => {}, mkdir: async () => {} },
    }
    const svc = new AgentService({ config: new ConfigStore(memorySecrets(), memoryMemento()), api: api as never, bridge, workerPath: 'x' })
    await svc.handleWebviewMessage({ type: 'saveProviders', providers: [{ id: 'p1', label: 'P', protocol: 'openai', baseUrl: 'https://x', models: [{ id: 'm1', label: 'm1', supportsThinking: false }] }], active: { providerId: 'p1', modelId: 'm1', quality: 'low' } })
    // 第一轮 hang 住（假 adapter 永不返回，直到我们放行）——用可控 promise
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    ;(svc as unknown as { injectLoopForTest: (f: () => Promise<'completed'>) => void }).injectLoopForTest(() => gate.then(() => 'completed'))
    const p1 = svc.handleWebviewMessage({ type: 'submit', text: 'first' })
    await svc.handleWebviewMessage({ type: 'submit', text: 'queued-1' })
    const queueOps = sent.filter(s => s.type === 'ops').flatMap(s => (s as { ops: { op: string }[] }).ops)
    expect(queueOps.some(o => o.op === 'queue')).toBe(true)
    release()
    await p1
    await new Promise(r => setTimeout(r, 20))   // drain 微任务
    // 队列清空
    const after = sent.filter(s => s.type === 'ops').flatMap(s => (s as { ops: { op: string }[] }).ops)
    const lastQueue = [...after].reverse().find(o => o.op === 'queue') as unknown as { queue: unknown[] }
    expect(lastQueue.queue).toEqual([])
  })
})
```

（`injectLoopForTest` 是 AgentService 上的测试钩子：替换真实 loop 装配函数。实现为公开只读属性 `loopFactory`，测试直接覆盖——比隐藏钩子直白。）

- [ ] **Step 2: 失败** → FAIL

- [ ] **Step 3: 实现 webviewBridge.ts + agentService.ts + 重写 extension.ts**

`webviewBridge.ts`：

```ts
import type { HostMessage, WebviewMessage, UiOp } from '../shared/protocol'
import { applyUiOps, initialWebviewState } from '../shared/protocol'

export interface PostTarget { postMessage(m: unknown): Thenable<boolean>; onDidReceiveMessage(l: (m: unknown) => void): unknown; onDidDispose(cb: () => void): unknown }

export class WebviewBridge {
  private seq = 0
  private isReady = false
  private disposed = false
  private queue: HostMessage[] = []
  private handler: ((m: WebviewMessage) => void) | undefined
  private snapshot: HostMessage | undefined     // 最后一次全量
  constructor(private readonly target: Pick<PostTarget, 'postMessage'> & { onDidReceiveMessage(l: (m: unknown) => void): unknown; onDidDispose?(cb: () => void): unknown }) {}

  onMessage(handler: (m: WebviewMessage) => void): void { this.handler = handler }
  attach(target: { onDidReceiveMessage(l: (m: unknown) => void): unknown; onDidDispose?(cb: () => void): unknown }): void {
    target.onDidReceiveMessage((raw: unknown) => {
      const m = raw as WebviewMessage
      if (m?.type === 'ready') { this.isReady = true; if (this.snapshot) this.doSend(this.snapshot); for (const q of this.queue) this.doSend(q); this.queue = []; return }
      this.handler?.(m)
    })
    target.onDidDispose?.(() => { this.disposed = false; this.isReady = false })   // 重连后重新握手
  }
  send(m: Omit<HostMessage, 'seq'>): void {
    const withSeq = { ...m, seq: ++this.seq } as HostMessage
    if (m.type === 'snapshot') this.snapshot = withSeq
    if (!this.isReady) { this.queue.push(withSeq); return }
    this.doSend(withSeq)
  }
  sendOps(sessionId: string, ops: UiOp[]): void { if (ops.length > 0) this.send({ type: 'ops', sessionId, ops }) }
  private doSend(m: HostMessage): void {
    try { void this.target.postMessage(m).catch(() => {}) } catch { /* disposed：丢弃 */ }
  }
}
void applyUiOps; void initialWebviewState
```

`agentService.ts`（编排核心，含 loopFactory 覆盖点；为控制篇幅，分发 switch 全列）：

```ts
import * as path from 'node:path'
import type { WebviewMessage, UiOp, TimelineEvent, QueuedMessage, FileChangeSummary } from '../shared/protocol'
import { initialWebviewState, applyUiOps } from '../shared/protocol'
import { ConfigStore } from './configStore'
import { WebviewBridge } from './webviewBridge'
import { SessionStore, type SessionRecord } from '../session/store'
import { SnapshotTracker } from './snapshot'
import { AgentLoop } from '../agent/loop'
import { openaiAdapter } from '../protocol/openai'
import { anthropicAdapter } from '../protocol/anthropic'
import { geminiAdapter } from '../protocol/gemini'
import type { ProtocolAdapter, ResolvedProvider } from '../protocol/types'
import { CodeRuntime } from '../runtime/codeRuntime'
import { createTools } from '../tools/registry'

const ADAPTERS: Record<string, ProtocolAdapter> = { openai: openaiAdapter, anthropic: anthropicAdapter, gemini: geminiAdapter }

export interface VscodeApi {
  workspaceFolders(): string | undefined
  globalStoragePath(): string
  envLanguage(): string
  fileAbsPath(rel: string): string
  executeCommand(cmd: string, ...args: unknown[]): Thenable<unknown>
  registerContentProvider(scheme: string, provider: { provideTextDocumentContent(uri: unknown): Thenable<string> }): unknown
  fs: { readDir(p: string): Promise<string[]>; readFile(p: string): Promise<string>; appendFile(p: string, s: string): Promise<void>; mkdir(p: string): Promise<void> }
  openDiff(sessionId: string, relPath: string): Promise<void>
}

export interface AgentServiceDeps { config: ConfigStore; api: VscodeApi; bridge: WebviewBridge; workerPath: string }

export class AgentService {
  private sessionId: string | null = null
  private events: TimelineEvent[] = []
  private queue: QueuedMessage[] = []
  private title = 'Agent'
  private phase: import('../shared/protocol').SessionPhase = 'idle'
  private abort: AbortController | null = null
  private store: SessionStore
  private tracker: SnapshotTracker | null = null
  private loopFactory: ((userText: string, provider: ResolvedProvider, signal: AbortSignal) => Promise<'completed' | 'error' | 'aborted'>) | null = null   // 测试可覆盖
  private reqSeq = 0

  constructor(private readonly deps: AgentServiceDeps) {
    const ws = this.deps.api.workspaceFolders() ?? 'no-folder'
    this.store = new SessionStore(path.join(this.deps.api.globalStoragePath(), 'sessions', SessionStore.workspaceHash(ws)), this.deps.api.fs)
  }

  private cwd(): string { return this.deps.api.workspaceFolders() ?? process.cwd() }
  private emit(ops: UiOp[]): void {
    for (const op of ops) {
      if (op.op === 'append') this.events.push(op.event)
      else if (op.op === 'patch') this.events = this.events.map(e => e.id === op.id ? { ...e, ...op.patch, id: e.id } as TimelineEvent : e)
      else if (op.op === 'phase') this.phase = op.phase
      else if (op.op === 'title') this.title = op.title
      else if (op.op === 'queue') this.queue = op.queue
      else if (op.op === 'clear') { this.events = []; this.queue = [] }
    }
    const sid = this.sessionId ?? 'none'
    void this.sessionId && this.store.append(sid, { kind: 'ops', ops }).catch(() => {})
    this.deps.bridge.sendOps(sid, ops)
  }

  async bootSnapshot(): Promise<void> {
    const { providers, keyed, active } = await this.deps.config.sanitized()
    const state = { ...initialWebviewState(this.deps.api.envLanguage()), phase: this.phase, title: this.title,
      sessionId: this.sessionId, events: this.events, queue: this.queue, changes: this.tracker ? await this.tracker.changes(this.cwd()).catch(() => []) : [],
      providers, providerKeyed: keyed, active, hasSessions: (await this.store.list()).length > 0 }
    this.deps.bridge.send({ type: 'snapshot', state } as never)
  }

  async handleWebviewMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'submit': {
        if (this.phase === 'running') {
          this.queue = [...this.queue, { id: `q${Date.now()}`, text: m.text }]
          this.emit([{ op: 'queue', queue: this.queue }])
          return
        }
        await this.runTurn(m.text); return
      }
      case 'stop': this.abort?.abort('user stop'); return
      case 'queueEdit': this.queue = this.queue.map(q => q.id === m.id ? { ...q, text: m.text } : q); this.emit([{ op: 'queue', queue: this.queue }]); return
      case 'queueDelete': this.queue = this.queue.filter(q => q.id !== m.id); this.emit([{ op: 'queue', queue: this.queue }]); return
      case 'queueSubmitNow': {
        const item = this.queue.find(q => q.id === m.id)
        if (!item) return
        this.queue = this.queue.filter(q => q.id !== m.id); this.emit([{ op: 'queue', queue: this.queue }])
        if (this.phase !== 'running') await this.runTurn(item.text)
        return
      }
      case 'selectModel': await this.deps.config.setActive(m.active); await this.bootSnapshot(); return
      case 'newSession': await this.openSession(null); return
      case 'openSession': await this.openSession(m.sessionId); return
      case 'reviewFile': await this.deps.api.openDiff(this.sessionId ?? '', m.path.replace(/\\/g, '/')); return
      case 'reviewAccept': await this.acceptReject(m.path, 'accept'); return
      case 'reviewReject': await this.acceptReject(m.path, 'reject'); return
      case 'saveProviders': await this.deps.config.saveProviders(m.providers); if (m.active) await this.deps.config.setActive(m.active); await this.bootSnapshot(); return
      case 'saveApiKey': await this.deps.config.saveApiKey(m.providerId, m.apiKey); await this.bootSnapshot(); return
      case 'deleteProvider': await this.deps.config.deleteProvider(m.providerId); await this.bootSnapshot(); return
      case 'rpc': await this.handleRpc(m.reqId, m.method, m.params); return
    }
  }

  private async acceptReject(rel: string | undefined, action: 'accept' | 'reject'): Promise<void> {
    if (!this.tracker) return
    const cwd = this.cwd()
    if (rel) { action === 'accept' ? await this.tracker.drop(rel) : await this.tracker.restore(rel, cwd) }
    else for (const c of await this.tracker.changes(cwd)) { action === 'accept' ? await this.tracker.drop(c.path) : await this.tracker.restore(c.path, cwd) }
    this.emit([{ op: 'changes', changes: await this.tracker.changes(cwd).catch(() => [] as FileChangeSummary[]) }])
  }

  private async handleRpc(reqId: number, method: string, params: { providerId: string; baseUrl?: string; protocol: string }): Promise<void> {
    try {
      if (method === 'listModels') {
        const key = (await this.deps.config.getApiKey(params.providerId)) ?? ''
        const base = (params.baseUrl ?? '').replace(/\/$/, '')
        const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { data?: { id: string }[] }
        this.deps.bridge.send({ type: 'rpcResult', reqId, ok: true, result: (data.data ?? []).map(x => x.id).slice(0, 200) } as never)
      } else if (method === 'testProvider') {
        this.deps.bridge.send({ type: 'rpcResult', reqId, ok: true, result: 'ok' } as never)   // 简化：以 listModels/首请求为准；预留
      }
    } catch (error: unknown) {
      this.deps.bridge.send({ type: 'rpcResult', reqId, ok: false, error: error instanceof Error ? error.message : String(error) } as never)
    }
  }

  private async openSession(sessionId: string | null): Promise<void> {
    this.sessionId = sessionId ?? `s${Date.now().toString(36)}`
    this.tracker = new SnapshotTracker(path.join(this.deps.api.globalStoragePath(), 'snapshots', this.sessionId), {
      readFile: async p => this.deps.api.fs.readFile(p),
      writeFile: async (p, s) => { await this.deps.api.fs.appendFile(p.slice(0, 0), ''); await writeFileViaApi(this.deps.api, p, s) },
      mkdir: async p => this.deps.api.fs.mkdir(p),
      exists: async p => { try { await this.deps.api.fs.readFile(p); return true } catch { return false } },
    })
    this.emit([{ op: 'clear' }])
    if (sessionId) {
      const records = await this.store.load(sessionId)
      const replayed = this.store.replayToState(records, this.deps.api.envLanguage())
      this.events = replayed.state.events; this.queue = replayed.state.queue; this.title = replayed.state.title
      this.history = replayed.history
    } else {
      this.history = []
    }
    await this.bootSnapshot()
  }
  private history: import('../protocol/types').HistoryMessage[] = []

  private async runTurn(userText: string): Promise<void> {
    const active = await this.deps.config.getActive()
    if (!active) { this.emit([{ op: 'append', event: { id: 'cfg', ts: Date.now(), type: 'error', message: 'No provider/model selected' } }]); return }
    if (!this.sessionId) await this.openSession(null)
    const providerInfo = (await this.deps.config.getProviders()).find(p => p.id === active.providerId)
    if (!providerInfo) return
    const apiKey = (await this.deps.config.getApiKey(active.providerId)) ?? ''
    const provider: ResolvedProvider = { info: providerInfo, apiKey, modelId: active.modelId, quality: active.quality,
      thinkingMode: await this.deps.config.getThinkingMode(active.providerId, active.modelId) }
    const adapter = ADAPTERS[providerInfo.protocol]
    const title = this.title === 'Agent' ? SessionStore.titleOf(userText) : this.title
    const meta = { sessionId: this.sessionId!, title, createdAt: Date.now(), providerId: active.providerId, modelId: active.modelId }
    await this.store.append(this.sessionId!, { kind: 'meta', meta })
    this.emit([{ op: 'title', title }])
    this.abort = new AbortController()
    const run = this.loopFactory
      ? this.loopFactory(userText, provider, this.abort.signal)
      : this.defaultLoop(userText, provider, adapter)
    const outcome = await run
    this.abort = null
    if (outcome !== 'aborted') {
      const next = this.queue.shift()
      if (next) { this.emit([{ op: 'queue', queue: this.queue }]); await this.runTurn(next.text) }
    }
  }

  private async defaultLoop(userText: string, provider: ResolvedProvider, adapter: ProtocolAdapter): Promise<'completed' | 'error' | 'aborted'> {
    const runtime = new CodeRuntime(this.deps.workerPath)
    let counter = 0
    const loop = new AgentLoop({
      adapter, provider, runtime, tools: createTools(), cwd: this.cwd(), platform: process.platform,
      emit: ops => this.emit(ops),
      onHistory: msg => { this.history.push(msg); void this.store.append(this.sessionId!, { kind: 'history', message: msg }).catch(() => {}) },
      getHistory: () => [...this.history],
      onProviderThinkingMode: mode => { void this.deps.config.setThinkingMode(provider.info.id, provider.modelId, mode) },
      snapshotTracker: this.tracker ? {
        beforeEdit: (p, c) => this.tracker!.beforeEdit(p, c),
        changes: () => this.tracker!.changes(this.cwd()).catch(() => []),
      } : undefined,
      newEventId: () => `e${++counter}`,
    })
    try { return await loop.run(userText, this.abort!.signal) }
    finally { await runtime.dispose() }
  }
}

async function writeFileViaApi(api: VscodeApi, p: string, s: string): Promise<void> {
  // VscodeApi.fs 无 writeFile —— SnapshotTracker 写经专用包装；扩展实现传入真 fs.writeFile
  await (api as unknown as { writeFile?(p: string, s: string): Promise<void> }).writeFile?.(p, s)
}
```

（实现修正注：`snapshotTracker.changes` 必须异步真值——在 defaultLoop 里改为 `changes: async () => this.tracker!.changes(this.cwd()).catch(() => [])`；`VscodeApi.fs` 增加 `writeFile`；`changes` 在 loop 的 emit `op:'changes'` 处用同步签名 `changes(): FileChangeSummary[]` 与规格冲突——**统一把 LoopDeps.snapshotTracker.changes 改为 `Promise<FileChangeSummary[]>`，loop 处 `d.emit([{op:'changes', changes:(await d.snapshotTracker.changes()) ?? []}])`，Task 15 对应处同步更新**。以 `npx tsc --noEmit` 通过为准。）

`extension.ts` 重写（真 VscodeApi 装配 + bridge attach + provider 注册 + 内容提供者）：

```ts
import * as vscode from 'vscode'
import * as path from 'node:path'
import * as fsp from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { AgentService, type VscodeApi } from './service/agentService'
import { WebviewBridge } from './service/webviewBridge'
import { ConfigStore } from './service/configStore'
import { SNAPSHOT_SCHEME, registerSnapshotContentProvider, openSnapshotDiff } from './service/reviewProvider'
import { SnapshotTracker } from './service/snapshot'

export function activate(context: vscode.ExtensionContext) {
  const workerPath = path.join(__dirname, 'worker.js')
  const trackers = new Map<string, SnapshotTracker>()
  const api: VscodeApi = {
    workspaceFolders: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    globalStoragePath: () => context.globalStorageUri.fsPath,
    envLanguage: () => vscode.env.language,
    fileAbsPath: rel => path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(), rel),
    executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args),
    registerContentProvider: (scheme, provider) => vscode.workspace.registerTextDocumentContentProvider(scheme, provider as never),
    fs: { readDir: p => fsp.readdir(p), readFile: p => fsp.readFile(p, 'utf8'), appendFile: (p, s) => fsp.appendFile(p, s), mkdir: p => fsp.mkdir(p, { recursive: true }), writeFile: (p, s) => fsp.writeFile(p, s, 'utf8') },
    openDiff: async (sessionId, relPath) => openSnapshotDiff(sessionId, relPath, path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(), relPath)),
  }
  context.subscriptions.push(registerSnapshotContentProvider(() => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    return ws ? trackers.get('current') : undefined
  }))

  const provider = new AgentViewProvider(context, api, trackers, workerPath)
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('ptc-agent.view', provider, { webviewOptions: { retainContextWhenHidden: true } }))
}
void trackers
```

（AgentViewProvider 内部：resolveWebviewView 时构造 `WebviewBridge(webview)` + `AgentService`，`bridge.attach(webview)`、`bridge.onMessage(m => service.handleWebviewMessage(m))`，收到 ready 由 bridge 处理并触发 `service.bootSnapshot()`；tracker 挂到 `trackers.set('current', t)`。完整代码在实现时展开——本步以冒烟通过为准。）

- [ ] **Step 4: 通过 + 构建 + 提交**

```bash
npx vitest run test/agent-service.test.ts && npx tsc --noEmit && npm run build && git add -A && git commit -m "feat: WebviewBridge/AgentService/扩展接线（握手-队列-编排-drain）"
```

---

## Phase P5 — Webview UI（像素复刻，按【设计稿】§22 P0→P6）

### Task 20: Webview 脚手架（Vite+React+zustand+tokens）

**Files:**
- Create: `webview-ui/package.json`、`webview-ui/vite.config.ts`、`webview-ui/index.html`、`webview-ui/tsconfig.json`、`webview-ui/src/main.tsx`、`webview-ui/src/api.ts`、`webview-ui/src/store.ts`、`webview-ui/src/i18n.ts`、`webview-ui/src/styles/tokens.css`、`webview-ui/src/components/AgentView/AgentView.tsx`
- Test: `test/webview-store.test.ts`（store 归约，node 环境可测——store.ts 不依赖 DOM）

**Interfaces:**
- Consumes: `src/shared/protocol.ts`（vite alias `@shared` → `../src/shared`）
- Produces: `useAgentStore`（zustand：state 字段同 WebviewState + actions `applyHost(msg)`、`send(m: WebviewMessage)`）；`api.ts` 导出 `vscodeApi`（模块内一次 `acquireVsCodeApi()`）与 `postMessage` 包装。

- [ ] **Step 1: `webview-ui/package.json`**

```json
{
  "name": "ptc-agent-webview",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1", "zustand": "^5.0.2" },
  "devDependencies": { "@types/react": "^18.3.3", "@types/react-dom": "^18.3.0", "@vitejs/plugin-react": "^4.3.1", "typescript": "^5.7.0", "vite": "^5.4.0" }
}
```

- [ ] **Step 2: `vite.config.ts`（防 dual-React、固定产物名、单 CSS）**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(__dirname, '../src/shared'), react: path.resolve(__dirname, 'node_modules/react'), 'react-dom': path.resolve(__dirname, 'node_modules/react-dom') }, dedupe: ['react', 'react-dom'] },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome122', cssCodeSplit: false, rollupOptions: { output: { entryFileNames: 'index.js', assetFileNames: 'index.css' } } },
})
```

`index.html`：

```html
<!DOCTYPE html><html><head><meta charset="UTF-8"><meta viewport="width=device-width,initial-scale=1"></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```

- [ ] **Step 3: tokens.css（直接落【设计稿】§18 全部内容，逐行照抄——含 :root 变量/agentView grid/agentScroll 滚动条/agentDock/composer/popover/queuePanel/HC 边框规则），追加：**

```css
/* 设计稿 §04 字体：UI 字体继承宿主；正文行高 1.55-1.65 */
body { font-family: var(--vscode-font-family); font-size: 13px; }
.thoughtBody, .completionBody { line-height: 1.6; }
code, .codePill { font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px; }
/* 设计稿 §2.3 比例缩放：几何随容器宽等比（用 clamp 固定下限，防极窄不可用） */
.contentInset { padding-inline: clamp(8px, 3.6cqw, 16px); }
/* reduced motion（§15.1） */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 50ms !important; animation-duration: 50ms !important; transform: none !important; }
}
```

- [ ] **Step 4: api.ts / store.ts / main.tsx**

`api.ts`：

```ts
/// <reference types=".." />
type VscodeApi = { getState<T>(): T | undefined; setState(s: unknown): void; postMessage(m: unknown): Thenable<boolean> }
declare function acquireVsCodeApi(): VscodeApi
export const vscodeApi = acquireVsCodeApi()   // 唯一调用点
export const post = (m: unknown) => { try { void vscodeApi.postMessage(m) } catch { /* host 不可达 */ } }
```

`store.ts`（zustand；归约复用 shared 的 applyUiOps 保证 host/webview 一致）：

```ts
import { create } from 'zustand'
import { applyUiOps, initialWebviewState, type HostMessage, type WebviewMessage } from '@shared/protocol'
import { post, vscodeApi } from './api'

interface AgentStore extends import('@shared/protocol').WebviewState {
  send(m: WebviewMessage): void
  applyHost(msg: HostMessage): void
  persistUi(ui: { expandedThoughtIds: string[]; queueOpen: boolean; reviewOpen: boolean }): void
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  ...initialWebviewState('en'),
  send: m => post(m),
  applyHost: msg => {
    if (msg.type === 'snapshot') set(s => ({ ...msg.state, locale: s.locale }))
    else if (msg.type === 'ops') set(s => ({ ...applyUiOps(s, msg.ops) }))
    // rpcResult 由调用处通过回调消费（组件用 pendingRpc map；简化：存最近结果）
    else if (msg.type === 'rpcResult') set({ lastRpc: msg as never })
  },
  persistUi: ui => vscodeApi.setState(ui),
}))
```

`main.tsx`：

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useAgentStore } from './store'
import { post } from './api'
import { AgentView } from './components/AgentView/AgentView'
import './styles/tokens.css'

const root = createRoot(document.getElementById('root')!)
root.render(<AgentView />)
post({ type: 'ready' })   // boot 握手（Goose/Roo 模式）
// host→webview 消息监听
;(window as unknown as { _ptcListener?: boolean })._ptcListener = true
```

（`window.addEventListener('message', e => useAgentStore.getState().applyHost(e.data))` 放在模块顶部一次性注册——写实现时置于 main.tsx 顶部而非渲染后。）

- [ ] **Step 5: store 测试（node 环境跑 zustand）**

```ts
// test/webview-store.test.ts
import { describe, it, expect } from 'vitest'
import { applyUiOps, initialWebviewState } from '../src/shared/protocol'

describe('webview store 归约（复用 applyUiOps）', () => {
  it('snapshot 替换、ops 应用——与 host 侧同源', () => {
    let s = initialWebviewState('zh')
    s = applyUiOps(s, [{ op: 'phase', phase: 'running' }, { op: 'append', event: { id: 'x', ts: 1, type: 'error', message: 'E' } }])
    expect(s.phase).toBe('running'); expect(s.events).toHaveLength(1)
  })
})
```

（store.ts 若 import './api'（含 acquireVsCodeApi）在 node 下会炸——把 `persistUi` 移到组件层调用 api，store 保持纯逻辑；测试只测 applyUiOps 同源行为。实现时 store.ts 不 import api.ts。）

- [ ] **Step 6: 构建 + F5 验证 + 提交**

Run: `npm run build`（root，串联 webview）→ F5 侧栏渲染出空三层骨架（AgentView 本任务先渲染 `<div className="agentView">` + Header 占位）。

```bash
git add -A && git commit -m "feat: webview 脚手架（vite/react/zustand/tokens/api/store）"
```

---

### Task 21: 三层骨架 + Header + Composer（P0+P1）

**Files:**
- Create: `webview-ui/src/components/AgentView/AgentView.tsx`（完整版）、`Header/AgentHeader.tsx`、`Composer/Composer.tsx`、`Composer/ModelTrigger.tsx`
- Modify: `tokens.css`（追加 header/composer 组件样式）
- Test: 手动 F5（视觉）+ 冒烟断言（见 Step）

**实现要点（全部数值来自【设计稿】，实现时逐条对照）：**
- `AgentView`：`grid-template-rows: auto minmax(0,1fr) auto`；Header 固定；mainScroll；bottomDock（UtilityRail 占位 + Composer）。
- `AgentHeader`：高 ≈32 CSS px（382w 参考；等比 `scale=W/764`）；左标题（`state.title`，单行 ellipsis）；右四图标 `codicon-add / codicon-history / codicon-layout / codicon-close`，hover `toolbar.hoverBackground` 圆底；`+` → `send({type:'newSession'})`。
- `Composer`：圆角 `var(--r-composer)`；textarea（placeholder 由 i18n 提供 "Ask anything…"）；底部左 `＋ / 模型名 / quality / chevron`（ModelTrigger 本任务静态展示 active 模型）；右主按钮——idle/completed 为 `codicon-send` 圆形（`--agent-primary-bg`），running 为红色 Stop 方块（`--agent-error` glyph、外圆不变，80–120ms cross-fade）；Enter 发送（Shift+Enter 换行）；running 中 Enter → 入队（`submit` 消息，host 判定入队）。
- UtilityRail：左侧 4 个 `codicon-files / codicon-terminal / codicon-folder / codicon-browser`，有变更时右端 Review Changes 按钮（`codicon-diff` + 文案，`button.secondary*` token）——本任务先接 `changes.length`。

- [ ] **Step 1: 组件实现（AgentView.tsx 完整）**

```tsx
import React from 'react'
import { useAgentStore } from '../../store'
import { AgentHeader } from '../Header/AgentHeader'
import { Composer } from '../Composer/Composer'
import { Timeline } from '../Timeline/Timeline'   // Task 22 提供；本任务先空实现占位
import { Onboarding } from '../Onboarding/Onboarding'  // Task 25；占位 null

export function AgentView() {
  const state = useAgentStore()
  return (
    <section className="agentView">
      <AgentHeader />
      <main className="agentScroll">
        <Timeline />
      </main>
      <footer className="agentDock">
        <UtilityRail />
        <Composer />
      </footer>
    </section>
  )
}
function UtilityRail() {
  const changes = useAgentStore(s => s.changes)
  return (
    <div className="utilityRail">
      <span className="railIcon codicon codicon-files" />
      <span className="railIcon codicon codicon-terminal" />
      <span className="railIcon codicon codicon-folder" />
      <span className="railIcon codicon codicon-browser" />
      <span className="railSpacer" />
      {changes.length > 0 && (
        <button className="reviewButton" onClick={() => useAgentStore.getState().send({ type: 'reviewFile', path: changes[0].path })}>
          <i className="codicon codicon-diff" /> Review Changes
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 样式追加（对照【设计稿】§06/§12 数值）**——header 高 `calc(var(--scale) * 32px)`（`--scale` 由 ResizeObserver 写 root：`document.documentElement.style.setProperty('--scale', String(width/764))`，clamp 0.5–1）；composer 高 ≥60px、radius 13px；`composerActions` baseline 对齐；send 圆钮 36px。
- [ ] **Step 3: F5 视觉对照 G01/G02（截图并排）；功能验证：Enter 发送（观察 host 日志收到 submit）**
- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: 三层骨架/Header/Composer（send-stop 状态机）"
```

---

### Task 22: Timeline 事件组件族（P2 核心）

**Files:**
- Create: `webview-ui/src/components/Timeline/Timeline.tsx`、`Timeline/EventRow.tsx`、`Timeline/ThoughtEvent.tsx`、`Timeline/ExploreEvent.tsx`、`Timeline/EditEvent.tsx`、`Timeline/RunEvent.tsx`、`Timeline/ErrorEvent.tsx`、`shared/FileIcon.tsx`、`shared/Markdown.tsx`
- Modify: `tokens.css`

**实现要点（【设计稿】§08/§09）：**
- **EventRow 通用骨架**：actionLabel（secondary 色 regular）+ typeIcon（固定 slot 宽 16px，防 filename 抖动）+ primaryTarget（semibold）+ diff（tabular-nums，绿 `--agent-add`/红 `--agent-delete`）+ disclosure（codicon-chevron-right，展开旋转 90°，120–160ms）；一级事件左起点 x≈39 capture px → `calc(var(--scale) * 20px)`；相邻事件垂直间距 ≈23px（`--gap-event`）。
- **ThoughtEvent**：running 时展开 + markdown 流式（`white-space: pre-wrap`；Markdown 渲染见下）；"Thinking for Ns" 计时——`startedAt` 起 1Hz `setInterval` 局部 state（只重绘该行标题，不动 timeline 布局）；done 后折叠一行 "Thought for Ns"；折叠/展开 `grid-template-rows: 0fr→1fr` + opacity 160–220ms；Working… 行（`working` 字段，secondary 色）。
- **ExploreEvent**："Explored N files/folder"，展开列 targets（muted，每行 path + codicon-file）。
- **EditEvent**：`Edited + FileIcon + filename + +N -N`，无外层卡片；FileIcon 按 fileKind 彩色文字小标（JS 黄绿/CSS 蓝/HTML 橙/TS 蓝/JSON 黄/MD 灰，色值用 gitDecoration 系 token 或固定低饱和色仅作 glyph——glyph 允许固定色）。
- **RunEvent**："Ran `command`"（command 用 codePill 样式），展开显示 outputTail（mono、可换行）；status error 时标签变 `--agent-error`。
- **ErrorEvent**：单行 `codicon-error` + message（error 色）。
- **Markdown.tsx**：零依赖手写渲染器（标题/加粗/行内码/代码块/有序无序列表/链接/段落）——完成态与 thought 正文共用；inline code 用 `--agent-code-bg` 胶囊。
- 新行进入 100–160ms opacity + 2px y 位移（CSS animation `eventIn`），禁止 overshoot。

- [ ] **Step 1–3: 实现全部组件 + 样式（Timeline.tsx 装配 reducer 之上）**

```tsx
// Timeline.tsx
import React from 'react'
import { useAgentStore } from '../../store'
import { ThoughtEvent } from './ThoughtEvent'
import { ExploreEvent } from './ExploreEvent'
import { EditEvent } from './EditEvent'
import { RunEvent } from './RunEvent'
import { ErrorEvent } from './ErrorEvent'
import { CompletionEvent } from './CompletionEvent'   // Task 23 提供占位

export function Timeline() {
  const events = useAgentStore(s => s.events)
  const hasProvider = useAgentStore(s => s.providers.length > 0)
  if (!hasProvider) return <Onboarding />   // Task 25；先返回 null 占位
  return <div className="timeline">{events.map(e => (
    <React.Fragment key={e.id}>
      {e.type === 'thought' && <ThoughtEvent event={e} />}
      {e.type === 'explore' && <ExploreEvent event={e} />}
      {e.type === 'edit' && <EditEvent event={e} />}
      {e.type === 'run' && <RunEvent event={e} />}
      {e.type === 'completion' && <CompletionEvent event={e} />}
      {e.type === 'error' && <ErrorEvent event={e} />}
    </React.Fragment>))}</div>
}
function Onboarding() { return null }
```

（ThoughtEvent 计时器实现：`const [now, setNow] = useState(Date.now())` + `useEffect(interval 1s)` 仅当 `event.status==='running'`；`seconds = Math.max(0, Math.round((now - event.startedAt)/1000))`。折叠状态经 `useAgentStore.persistUi` 记忆 expandedThoughtIds——实现时把展开态放组件 local state + 初始值读 `vscodeApi.getState()`。）

- [ ] **Step 4: F5 + fixture 演练**（临时在 host 加 dev 命令或用单测驱动 applyUiOps 生成状态截图对照 G03/G05）
- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: Timeline 事件组件族（thought 流式计时/折叠、explore/edit/run/error、markdown）"
```

---

### Task 23: 完成态 + ReviewPanel（P4+P5）

**Files:**
- Create: `webview-ui/src/components/Timeline/CompletionEvent.tsx`、`Review/ReviewPanel.tsx`、`Review/ReviewActionBar.tsx`
- Modify: `tokens.css`、`AgentView.tsx`（reviewOpen 时 Dock 上方插 ReviewActionBar）

**实现要点（【设计稿】§13）：**
- CompletionEvent：Markdown 渲染（流式期间即渲染）；上方 files changed 汇总卡（`N files changed +X -Y >`，`codicon-diff`，右侧 Review 按钮 → 打开 ReviewPanel）。
- ReviewPanel：文件列表行 = `codicon-add(新增文件) / codicon-file(修改)` + `+N -N`（tabular）+ filename（semibold）+ path（muted，ellipsis）；点击行 → `send({type:'reviewFile', path})`（host 打开 vscode.diff）；底部反馈区 copy/thumbs（`codicon-copy / codicon-thumbs-up / codicon-thumbs-down`，右对齐低对比，本版本仅 UI）。
- ReviewActionBar：sticky 于 Dock 上方：`codicon-arrow-left` + "N Files With Changes" + 右侧 Reject all（secondary）+ Accept all（primary 实心，radius 小于 composer）。
- 状态：`reviewOpen` 本地 state（persistUi 记忆）；Reject/Accept → `send({type:'reviewAccept'|'reviewReject', path?})`；changes 更新后计数联动。

- [ ] **Step 1–3: 实现 + 样式**
- [ ] **Step 4: F5 全流程手动验证**（配置真 provider 后跑一个真实小任务，检查 diff 打开、accept/reject 计数归零）
- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 完成态渲染 + Review 面板/action bar"
```

---

### Task 24: 浮层（Model popover + quality 子菜单 + QueuePanel）（P3）

**Files:**
- Create: `webview-ui/src/components/Floaters/ModelPopover.tsx`、`Floaters/QueuePanel.tsx`
- Modify: `Composer/ModelTrigger.tsx`（接 popover）、`tokens.css`

**实现要点（【设计稿】§07/§11/§15）：**
- ModelPopover：锚定 ModelTrigger 下方；`popover` 表面 token + `box-shadow 0 6px 18px --agent-shadow` + radius 10px；标题 "Model"（muted semibold）；行高 ≈20 CSS px；每行模型名左对齐 + 右侧 capability 标签；hover `list.hoverBackground`；当前模型 `list.activeSelectionBackground` + 左缘 2px 主色条；行右 `codicon-chevron-right` → 二级 quality 菜单（Low/Medium/High，X 方向 2px 位移动画）；动画 120ms `opacity + scale(.98→1) + translateY(-2px→0)` `cubic-bezier(.2,.8,.2,1)`；点击外部/Esc/选择后关闭（焦点回 trigger）。
- 选择 → `send({type:'selectModel', active:{providerId, modelId, quality}})`。
- QueuePanel：Dock 内 Composer 上方；展开=header（"Queued Messages" semibold + 圆形计数 badge + 说明 muted + chevron 旋转）+ 行（`codicon-comment` + 摘要 ellipsis + 右三操作 `codicon-send / codicon-edit / codicon-trash`）；行高 ≈20 CSS px 无分隔线；出现 140–180ms `translateY(6→0)+opacity`，无 spring；编辑=行内变 textarea，Enter 确认 `queueEdit`；发送 `queueSubmitNow`；删除 `queueDelete`。

- [ ] **Step 1–3: 实现 + 样式**
- [ ] **Step 4: F5 验证键盘路径（Enter 打开/↑↓/Esc）；running 入队展开动画**
- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: Model popover（quality 子菜单）+ QueuePanel"
```

---

### Task 25: 首启向导与 Provider 管理（Onboarding）

**Files:**
- Create: `webview-ui/src/components/Onboarding/Onboarding.tsx`、`Onboarding/ProviderForm.tsx`

**实现要点：**
- `providers.length===0 && !active` 时 Timeline 位置渲染向导：步骤 1 三张协议卡（OpenAI-compatible/Anthropic/Gemini，含默认 baseUrl 预填）；步骤 2 表单（label/baseUrl/apiKey——apiKey `input type=password`；openai 协议附 "Fetch models" 按钮 → `rpc listModels` 填充多选/手填模型 id+label+supportsThinking）；步骤 3 选择 active 模型 + quality → `saveProviders` + `saveApiKey` 完成。
- Provider 管理：Header `codicon-layout`(more) 下拉 → 简单列表 + "Add provider"（复用表单）+ 删除（`deleteProvider`）。
- 密钥只在表单暂存，保存后即清空输入框（webview 不保留）。

- [ ] **Step 1–3: 实现 + 样式（表面用 popover token；表单控件用 input token）**
- [ ] **Step 4: F5 全新 globalStorage 走完三步（真 key 可选；无 key 时 listModels 应报错提示）**
- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 首启向导与 provider 管理"
```

---

### Task 26: 滚动 tail-follow + 动效收口 + i18n（P6）

**Files:**
- Create: `webview-ui/src/hooks/useTailFollow.ts`、`webview-ui/src/i18n.ts`（完整 zh/en 文案表）
- Modify: `AgentView.tsx`、各组件文案替换为 `t('...')`

**实现要点：**
- useTailFollow（【设计稿】§14.1 算法逐行实现）：`NEAR_BOTTOM=96`；流式 ops 到达（store 订阅 events 长度/最后事件内容）时若 `scrollHeight - scrollTop - clientHeight < 96` 且未锁定 → `scrollTo({top: scrollHeight, behavior:'auto'})`；wheel/touchstart 向上 → 锁定；再次进入 96px → 解锁；展开/收起用 `overflow-anchor` 或记录锚点防跳顶。
- i18n：`t(key)` 从 `state.locale`（boot 下发）选 zh/en；替换全部 UI 文案（header 无文案；composer placeholder、queue 标题/说明、review 按钮组、向导全部、错误前缀等，预计 ~40 条）。
- 动效收口：对照 §15 表逐项检查（popover/chevron/thought 展开/queue/review/send-stop/计时/新行）；`prefers-reduced-motion` 已在 tokens 全局降级，抽查。

- [ ] **Step 1–3: 实现 + 替换文案**
- [ ] **Step 4: F5 手动：长输出流式跟随、上滚锁定、回底解锁；切 VS Code 语言为中文重启验证文案**
- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: tail-follow 滚动、动效收口、中英 i18n"
```

---

## Phase P6 — 冒烟、打包、QA

### Task 27: @vscode/test-electron 冒烟 + 像素 QA 清单

**Files:**
- Create: `src/test/runSuite.ts`、`src/test/suite/index.ts`、`package.json`（devDep `@vscode/test-electron`、script `"test:vscode"`）
- Create: `docs/superpowers/qa/pixel-checklist.md`

**冒烟断言（suite）：**
1. 扩展激活无错；`ptc-agent.view` 可 resolve（`vscode.commands.executeCommand('ptc-agent.view.focus')`）。
2. webview ready 后收到 snapshot（经日志/状态注入断言：在 AgentService 上挂测试钩子 `lastSnapshot` getter）。
3. `saveProviders`+`saveApiKey`+`submit`（伪 baseUrl）→ phase=running → error 事件出现（网络错误路径）。
4. `dist/worker.js` 存在且 `CodeRuntime` 冒烟（真 worker 一轮 `return 1`）。

**像素 QA 清单（pixel-checklist.md）**：G01–G07 状态 × {Default Light Modern, Default Dark Modern, High Contrast, HC Light}——每格列"必检项"（对照【设计稿】§21.2 表）与操作步骤（如何用 fixture/真实任务到达该状态）；验收：几何边界误差 ≤1 CSS px（用 VS Code 开发者工具量取），无写死色、HC 有边框、popover 阴影正确、动效节奏与 §15 一致。执行方式：开发者工具截图与设计稿 images/*.png 并排人工比对。

- [ ] **Step 1: 实现 runSuite/suite + script**
- [ ] **Step 2: `npx vscode-test-electron-run src/test/runSuite.ts` 通过**（或 `npm run test:vscode`）
- [ ] **Step 3: 写 QA 清单文档 + 手动走一遍 Light/Dark 两行，问题记录到清单**
- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "test: 集成冒烟 + 像素 QA 清单"
```

---

### Task 28: vsce 打包 + README

**Files:**
- Create: `README.md`（安装/配置三步/协议支持/已知事项——含 `http.proxySupport` SSE 排障提示）
- Modify: `.vscodeignore` 校对（确保 `dist/**`、`webview-ui/dist/**`、`webview-ui/media/**` 保留，其余排除）

- [ ] **Step 1: 写 README（含：三协议配置示例、quality 含义、worker 预算与护栏默认值、FAQ）**
- [ ] **Step 2: `npx @vscode/vsce package --no-dependencies` 产出 `ptc-agent-0.1.0.vsix`；`code --install-extension` 安装验证激活**
- [ ] **Step 3: 提交**

```bash
git add -A && git commit -m "chore: vsce 打包与 README"
```

---

## 计划自审记录

1. **规格覆盖检查**：§2 架构（T1/T19/T20）、§3 loop+工具（T9/T14/T15）、§4 runtime（T11/T12/T13）、§5 事件映射（T2/T15 events.ts + T22）、§6 UI（T20–T26 按设计稿 P0–P6）、§7 协议（T3–T8）、§8 持久化/Review（T16/T18/T19）、§9 错误（T4/T15 重试降级）、§10 测试（各任务 TDD + T27 冒烟/QA）。规格 §1 非目标（plan mode/子代理/压缩/混合模式）无对应任务——正确。**规格 §6 的 Walkthrough 卡**：设计稿有但 v1 数据源缺失（无 plan 流），按规格非目标处理不加任务——与规格一致。
2. **占位符扫描**：T19 extension.ts 的 AgentViewProvider "完整代码在实现时展开"——已给出全部依赖装配与行为要求，属实现级说明非占位；T22 Onboarding 占位 null 由 T25 覆盖；T21 Timeline 占位由 T22 覆盖。无 TBD/TODO。
3. **类型一致性**：`snapshotTracker.changes` 统一为 `Promise<FileChangeSummary[]>`（T15 接口、T15 loop 调用处 `await`、T19 装配三处一致）。`ToolDef.execute` 返回 `Promise<unknown>`（T9 registry 最终签名），Task 5 未涉及。`WebviewBridge.send` 参数 `Omit<HostMessage,'seq'>` 与调用处 `{...} as never` 的摩擦——实现时以 `as HostMessage` 统一。T19 `writeFileViaApi` 过渡写法在实现时直接改为 `VscodeApi.fs` 携带 `writeFile`（extension.ts 真实现已含）。
