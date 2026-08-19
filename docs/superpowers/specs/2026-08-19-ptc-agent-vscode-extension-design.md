# PTC Agent VS Code 插件 — 设计文档

日期：2026-08-19
状态：已与用户逐节确认

## 1. 目标与非目标

### 目标

一个极简、响应迅速的 VS Code 侧边栏 coding agent 插件：

1. **PTC 模式**（Pure-Then-Code / Code mode，源自 DeepSeek Harness）：模型针对生成的 TypeScript SDK 编写程序，通过唯一的 `run_code` 传输工具执行；只有程序 return/log 的内容回到模型上下文。
2. **像素级复刻** `docs/前端设计/VSCode_Agent_Pixel_Replica_MD_Package/README.md`（v1.1 Theme-Adaptive Edition）定义的界面，loop 中间态与 UI 衔接流畅自然。
3. **配置极简**：全程 webview 内配置，零 settings.json、零命令行。
4. **三家协议**：OpenAI-compatible、Anthropic、Google Gemini，自由选择、配置模型。

### 非目标（v1 明确排除）

- 不做 plan mode / "Proceeded with Implementation Plan" pill（组件留位、事件类型保留，未来可点亮）。
- 不做子代理、workflow、compaction（上下文压缩）、skills、MCP。
- 不做 native 工具调用（纯 Code mode，无 'both' 混合形态）。
- 不做 worker thread 层面的硬安全边界（信任姿态等同 bash 工具，见 §5.2）。
- 不复刻录屏的米黄色固定配色（颜色全部跟随 VS Code 主题）。

## 2. 架构

### 2.1 进程模型

```
VS Code
├─ Webview View (Sidebar "Agent")
│    React 18 + zustand + 纯 CSS token（设计稿三层：Header / Scroll / Dock）
│    └─ postMessage（typed 双向协议）↕
└─ Extension Host (Node 22)
     AgentService     会话编排、消息队列、快照/Review、历史
     AgentLoop        PTC 循环：流式 → run_code → 注入结果
     CodeRuntime      worker_threads 隔离执行 TS 程序
     ToolRegistry     6 工具绑定：read_file/write_file/edit_file/bash/glob/grep
     ProtocolLayer    openai / anthropic / gemini 适配器（fetch+SSE，零 SDK 依赖）
     SessionStore     JSONL 持久化（globalStorage/sessions/<workspaceHash>/）
     ConfigStore      SecretStorage（密钥）+ globalState（配置）
```

- 单一 Webview View，注册进自定义 ActivityBar viewContainer；`retainContextWhenHidden: true` 保证侧栏切换时流式状态不丢。
- 所有模型通信与工具执行都在 extension host；worker thread 由 extension host spawn。
- 零运行时依赖（host 侧仅 Node 内置模块；webview 侧 React+zustand 打包）。

### 2.2 目录结构

```
vscode-ptc-agent/
├─ src/                  # extension host 侧
│  ├─ extension.ts       # 激活：注册 viewContainer + webview view
│  ├─ protocol/          # types.ts / openai.ts / anthropic.ts / gemini.ts
│  ├─ agent/             # loop.ts / queue.ts / events.ts
│  ├─ runtime/           # codeRuntime.ts / workerBootstrap.ts / typeStrip.ts
│  ├─ tools/             # registry.ts + 6 个工具实现
│  ├─ review/            # snapshot.ts（快照 / Accept / Reject / diff 计数）
│  ├─ session/           # store.ts（JSONL 读写 + 重放）
│  └─ config/            # configStore.ts（SecretStorage + globalState）
├─ webview-ui/           # 前端（独立 Vite 构建）
│  ├─ src/components/    # 按设计稿 §16.1 组件树
│  ├─ src/state/         # zustand store + 事件归约器
│  └─ src/styles/        # tokens.css（设计稿 §18 骨架）
├─ test/                 # 单元 / SSE fixture / 黄金截图
├─ package.json / esbuild.js / vite.config.ts
```

构建：extension host 用 esbuild bundle；webview 用 Vite；`vsce` 打包。

## 3. Agent Loop（PTC）

### 3.1 循环流程

```
user prompt
  → 组装请求：system prompt = persona（"You are a coding agent powered by {model}. Working directory is {cwd}."）
              + 工作区上下文（cwd / 平台 / 日期）
              + tools SDK 声明（6 工具 .d.ts）+ 使用守则
    wire 工具列表 = 仅 run_code{code, description}
  → 流式请求
      thinking_delta → UI Thought 事件（展开流式 + "Thinking for Ns" 计时）
      text_delta     → UI Working… / 完成总结流式
      tool_call_delta → run_code 参数流式拼装
  → 模型发出 run_code → CodeRuntime 执行（子派发实时上报 UI）
  → 程序 return {value, logs} → 仅此进入模型历史（子调用中间结果只进会话日志）
  → 回到流式请求，直到无工具调用 → completed
```

### 3.2 关键机制

- **上下文纪律**：子调用（`await tools.read_file(...)` 等）的结果不进入模型历史；仅存在于会话日志（UI 时间线数据源）。模型只看到程序本身与它 return/log 的摘要。
- **停止**：AbortController 级联——外层 loop → runtime 信号 → worker terminate + 未决绑定中断。已完成的编辑保留，可 Review 回滚。
- **队列**：running 中新消息入队；loop 结束后自动逐条作为新一轮发送（设计稿 §11）。队列行支持编辑/单发/删除。
- **护栏**：单条用户消息最多 40 轮工具调用（可配）；超限温和终止并告知。
- **模型历史消息形态**：assistant（thinking + text + run_code call）与 tool（程序结果 value+logs / error）交替；适配器各自负责映射到本协议 wire 格式。

### 3.3 工具集（6 个，SDK 绑定名）

| 绑定 | 说明 | 并发安全 |
|---|---|---|
| `read_file(path, offset?, limit?)` | 读文件，默认头部 N 行 + 总行数提示 | ✅ |
| `write_file(path, content)` | 写文件（创建/覆盖） | ❌ 独占 |
| `edit_file(path, old_string, new_string)` | str_replace 精确替换；唯一匹配校验 | ❌ 独占 |
| `bash(command, timeout_ms?)` | shell 执行，cwd=工作区根 | ❌ 独占 |
| `glob(pattern, path?)` | 文件匹配 | ✅ |
| `grep(query, glob?, path?)` | 内容搜索（ripgrep 优先，降级 JS 实现） | ✅ |

SDK 声明（写入 system prompt）包含：每个工具的 JSDoc + 签名、使用守则（"erasable TypeScript only"、独立只读调用可 `Promise.all`、写/命令独占串行、只 return/log 应回上下文的输出、`ToolCallError` 可 catch）。

## 4. Code Runtime（照 dsh 设计决策，精简实现）

- **每次 run 一个全新 worker thread**：`env:{}`；`resourceLimits`（默认 maxOldGenerationSizeMb 512）；stdout/stderr 捕获进 logs；跨 run 零状态（可重建性）。
- **类型擦除**：Node 22 `node:module` 的 `stripTypeScriptTypes`（位置保持，报错行号与模型源码一致）；不可擦除语法以 `exception` 返回，模型自纠。若 API 不可用则降级为把程序按纯 JS 执行（类型本就是 advisory）。
- **程序形态**：剥类型后作为 `AsyncFunction` body，参数 = 绑定全局 `tools`、`ToolCallError` 类、捕获 console 的 shim；顶层 `await` 与 `return` 可用。
- **消息端口桥接**（按敌意对端设计）：worker→host `{id,name,args}`；host 校验工具名、拒绝重复 id 与结算后消息；回 `{id,ok,value|message}`；绑定命名空间 null-prototype 防原型污染。
- **预算**：`computeMs`（`eventLoopUtilization()` 轮询计忙时，慢 await 不计）+ `maxWallMs`（总时长）+ `maxOutputBytes`（仅最终 value+logs 合并账目）；到期/取消/完成即 terminate；heap 退出为显式失败。
- **有界并行调度**：提交顺序入池；并发安全类（read/glob/grep）最多 10 重叠；独占类（write/edit/bash）排空池后单独执行；结算时放弃未启动调用。
- **结算后静默**：runtime settle → 中止未决绑定、排干队列后才返回 tool result。
- **失败分类**（dsh `CodeRunFailure`）：`exception | timeout | abort | worker-exit | invalid-output | output-limit`；作为 isError tool result 回给模型，同时上时间线错误行。
- **信任姿态**：worker 是遏制不是安全边界（模型代码可达 Node API，权限等同 bash）；对用户依赖 VS Code 本身的扩展信任模型。

## 5. 中间态 → 前端事件映射

### 5.1 事件 schema（直接采用设计稿 §17）

```ts
type AgentEvent =
  | { type:'explore'; status:'running'|'done'; count:number; path?:string }
  | { type:'edit';   file:string; fileKind:'js'|'css'|'html'|'other'; add:number; del:number }
  | { type:'thought'; seconds:number; open:boolean; title?:string; markdown?:string; status:'running'|'done' }
  | { type:'run';    command:string; status:'running'|'done'|'error' }
  | { type:'proceeded'; auto:boolean; artifact:string }   // v1 不产生，类型保留

type AgentSession = {
  phase:'idle'|'running'|'awaiting_review'|'completed'|'error';
  title:string; prompt:string; events:AgentEvent[];
  queued:QueuedMessage[]; changes:FileChange[];
}
```

### 5.2 映射表

| 后端来源 | UI 事件 | 呈现 |
|---|---|---|
| `thinking_delta` | thought(running) | 展开流式正文 + 每秒 "Thinking for Ns" |
| thinking 结束 | thought(done) | 折叠为 "Thought for Ns" |
| `text_delta`（工具轮间） | 当前 thought 的 Working 行 | Secondary 色 |
| 程序内 read/glob/grep 派发 | explore(running→done) | "Explored N files/folder"，展开列 path |
| 程序内 write/edit 派发 | edit | "Edited `file.js` +N -N"（host 派发时算好行差） |
| 程序内 bash 派发 | run(running→done/error) | "Ran `cmd`"，展开看输出尾部 |
| 最终轮 text | completed | CompletionMarkdown 流式 + files changed 卡 |
| 快照追踪器 | changes[] | Review 按钮 / "N files changed +X -Y" |
| 失败 | 事件级 error | 时间线行错误态，会话保留 |

子派发 start/finish 双相实时推送；行进入用设计稿 §15 的 100–160ms opacity。**衔接机制是事件流驱动（非轮询），逐行浮现。**

## 6. Webview UI（像素复刻）

设计稿规范为实现蓝本，此处只记录执行决策：

- **三层骨架**：`grid-template-rows: auto minmax(0,1fr) auto`；几何 `scale = 容器宽/764`，锚点用设计稿附录 A 坐标；382–520 CSS px 为主验收区间。
- **组件树**：严格按设计稿 §16.1。
- **颜色**：三层 token（VS Code → `--agent-*` → 组件），全部映射 `--vscode-*`；HC 强制边框；禁止写死录屏色、禁止 JS 缓存计算色。
- **动效**：设计稿 §15 时序（popover 120ms、事件行 100–160ms、Send→Stop 80–120ms cross-fade、计时 1Hz 纯文本）；`prefers-reduced-motion` 只留 50–80ms opacity。
- **滚动**：tail-follow，NEAR_BOTTOM=96px；流式到达 `behavior:'auto'`（禁 smooth）；上滚锁定、回底解锁；展开/收起保持锚点。
- **图标**：Codicons 为主；文件类型用彩色文字小 glyph；hit target ≥28px（Composer 主按钮 36–40px）。
- **i18n**：中英 bundle，`vscode.l10n`/nls 跟随 VS Code 显示语言；布局按设计稿 ellipsis 规则消化文案长度差。
- **Model popover**：当前 provider 模型列表 + quality 子菜单（Low/Medium/High）；quality 为协议中立抽象 → OpenAI `reasoning_effort` / Anthropic thinking budget / Gemini `thinkingConfig`。

## 7. 协议层

### 7.1 统一流事件

```ts
type StreamEvent =
  | { type:'thinking_delta'; text:string }
  | { type:'text_delta'; text:string }
  | { type:'tool_call_delta'; name:string; argsDelta:string }   // 仅 run_code
  | { type:'message_done'; usage:TokenUsage; stopReason:string }
  | { type:'stream_error'; code:string; message:string }
```

### 7.2 三适配器

| | OpenAI-compatible | Anthropic | Gemini |
|---|---|---|---|
| 端点 | `POST {base}/chat/completions` | `POST {base}/v1/messages` | `POST {base}/models/{m}:streamGenerateContent?alt=sse` |
| 文本 | `delta.content` | `content_block_delta.text_delta` | `candidates[0].content.parts[].text` |
| 思考 | `delta.reasoning_content` | `content_block_delta.thinking_delta` | `parts[].thought` |
| 工具 | `tool_calls` 增量 | `input_json_delta` | `functionCall`（非流式参数） |
| system | `messages[0]{role:'system'}` | `system` 字段 | `systemInstruction` |

默认 baseUrl：`https://api.openai.com/v1`（或 DeepSeek 等预设）、`https://api.anthropic.com`、`https://generativelanguage.googleapis.com/v1beta`。手写 fetch+SSE，~200 行/适配器，零 SDK。

### 7.3 配置模型

```ts
type ProviderConfig = {
  id:string; protocol:'openai'|'anthropic'|'gemini';
  baseUrl:string; apiKeyRef:string;           // 密钥存 SecretStorage
  models:{ id:string; label:string; supportsThinking:boolean }[];
}
type AgentConfig = { providerId:string; modelId:string; quality:'low'|'medium'|'high' }
```

- 多 provider 共存；idle 可切换；运行中会话锁定启动时 provider。
- 首启引导（webview 内三步）：选协议 → baseURL+密钥（openai 协议可 `GET /models` 拉列表）→ 选模型完成。

## 8. 会话持久化与 Review

- **JSONL 追加日志**存 `globalStorage/sessions/<workspaceHash>/<sessionId>.jsonl`；重放恢复时间线与变更状态；Header history 列当前工作区历史会话；标题=首条 prompt 截断。
- **快照**：会话内首次改某文件前，原文存 `globalStorage/snapshots/<sessionId>/<relPath>`。
- **Review**：面板列文件 +N -N；点击 → `vscode.diff(快照, 当前)`（自定义 FileSystemProvider 暴露快照区）；Accept（全部/单文件）= 丢弃快照；Reject = 恢复原文；底部 "N Files With Changes" 实时计数。

## 9. 错误处理

| 层 | 策略 |
|---|---|
| 协议错误 | 统一分类 `auth / rateLimit / network / server / invalidRequest / aborted`；rateLimit/network 自动退避重试 ≤3；其余 UI 内联报错，会话保留 |
| 程序失败 | `CodeRunFailure` 六类 → isError tool result 回模型自纠 + 时间线错误行 |
| 工具失败 | 程序内 `ToolCallError` 可 catch；未捕获即程序异常 |
| 扩展重载 | 从会话日志重建；流式中断标注中断点 |

## 10. 测试与验收

- **单元**：SSE fixture 回放测三适配器；类型擦除；worker 桥敌意用例（伪造 id/未知名/结算后消息）；预算触发；调度池顺序；diff 计数；快照恢复。
- **像素黄金截图**：设计稿 §21 G01–G07 fixture，几何 ≤1 CSS px，主题矩阵（Default Light/Dark Modern、HC、HC Light + 一款高频第三方主题）。
- **E2E**：mock SSE 服务器驱动完整 loop，断言时间线事件顺序与队列行为；真模型冒烟手动。
- **交付阶段**：沿用设计稿 §22 P0 骨架 → P1 Composer → P2 Timeline → P3 浮层 → P4 Review → P5 完成态 → P6 动效打磨。

## 11. 关键设计依据

- PTC/Code mode：`docs/后端大脑/.agents/notes/implemented/feature/2026-06-15-code-mode.md`（及 typed-tool-returns、live-parallel-dispatch、language-dispatch 后续笔记）。
- 像素规范：`docs/前端设计/VSCode_Agent_Pixel_Replica_MD_Package/README.md`（v1.1）。
- dsh preset 参考：`apps/cli/config/agent-presets/code/agent.cordis.yml`。
