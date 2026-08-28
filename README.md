# PTC Agent（Pure-Then-Code）

极简、快速的 VS Code 编程智能体。PTC/Code mode 的核心机制：模型不逐个调用工具，而是编写一段 TypeScript 程序，经内置 `run_code` 工具在沙箱 worker 线程中执行；程序内可调用读文件、写文件、bash、搜索等工具函数；执行结束后，**仅程序的 return 值与 console.log 输出回注到模型上下文**——上下文保持精简，长任务的中间过程不会撑爆 token。

- **Pure**：模型先思考、规划、探索（read/glob/grep 只读）
- **Then Code**：一次生成程序批量完成编辑与命令执行
- **快照 Review**：所有文件改动先落快照，Accept 才保留、Reject 一键还原

## 系统要求

| 项目 | 要求 |
| --- | --- |
| VS Code | ≥ 1.101.0（worker 运行时依赖扩展宿主内置 Node 22） |
| 操作系统 | Windows / macOS / Linux |

> 注意：worker 线程使用 VS Code 扩展宿主内置的 Node 运行时，需要 VS Code 1.101+（Node 22）。低版本下 worker 无法启动。

## 安装

### 方式一：安装 .vsix

```bash
code --install-extension ptc-agent-0.1.1.vsix
```

### 方式二：源码运行（F5 调试）

```bash
npm install          # 根目录依赖（含 webview-ui workspace）
npm run build        # 拉取 codicons + esbuild 主进程 + vite 构建 webview
```

在 VS Code 中打开本项目，按 F5 启动「扩展开发宿主」，左侧活动栏出现 PTC Agent 图标即成功。

## 首次启动：三步配置向导

首次打开 PTC Agent 视图会进入引导向导，全部在 UI 内完成，无需手改任何配置文件：

1. **选择协议** —— OpenAI 兼容 / Anthropic / Gemini 三选一；
2. **填写 baseURL 与 API 密钥** —— 表单已预填各协议官方默认 baseURL（见下表），密钥经 VS Code SecretStorage 存储，绝不写入工作区；OpenAI 兼容协议支持「获取模型列表」在线拉取模型清单，Anthropic / Gemini 无标准列表端点，手动添加即可；
3. **选择模型** —— 从已添加模型中选定默认模型，并选择质量档位（low / medium / high）。

完成三步即可在输入框提交任务。后续可随时通过模型切换浮层更换模型 / 质量档位，或在设置管理页增删服务。

## 协议支持

| 协议 | 默认 baseURL | 适用服务 |
| --- | --- | --- |
| OpenAI 兼容 | `https://api.openai.com/v1` | OpenAI 官方及一切兼容 `/chat/completions` 的服务（DeepSeek、vLLM、OneAPI 网关等） |
| Anthropic | `https://api.anthropic.com` | Claude 系列官方 API 及兼容 `/v1/messages` 的网关 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | Google Gemini 系列官方 API |

配置示例（自建 OpenAI 兼容网关）：协议选「OpenAI 兼容」，baseURL 填 `https://your-gateway.example.com/v1`，密钥填网关签发的 key，添加模型后即可使用。

### 质量档位（quality）的含义

质量档位会映射为各协议各自的思考控制参数：

| quality | OpenAI 兼容 | Anthropic | Gemini |
| --- | --- | --- | --- |
| low / medium / high | `reasoning_effort` 参数 | 思考预算 `budget_tokens`（1024 / 4096 / 16384；Claude 4.6+ 默认走 adaptive 思考，报 400 时自动降级） | `thinkingLevel`（LOW / MEDIUM / HIGH） |

仅对勾选了「支持思考」的模型生效。

## 工具集

`run_code` 程序内可用的 6 个内置工具：

| 工具 | 说明 | 并发 |
| --- | --- | --- |
| `read_file(path)` | 读取文本文件 | 安全 |
| `write_file(path, content)` | 写入文件（写前自动快照） | 串行 |
| `edit_file(path, find, replace)` | 精确查找替换编辑 | 串行 |
| `glob(pattern)` | 文件名通配匹配 | 安全 |
| `grep(pattern, path?)` | 内容正则搜索 | 安全 |
| `bash(command)` | 在工作区目录执行 shell 命令 | 串行 |

并发安全的工具在调度池中并行执行，写操作自动串行化，同一轮内最多 10 个并行。

## Worker 预算与护栏（默认值）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `computeMs` | 60 秒 | 程序纯计算时间预算（事件循环活跃时长） |
| `maxWallMs` | 600 秒（10 分钟） | 墙钟时间上限（含等待 I/O） |
| `maxOutputBytes` | 64 MB | return 值 + 日志合计输出上限，超限截断终止 |
| `maxOldGenerationSizeMb` | 512 MB | worker 线程堆内存上限 |
| `maxParallel` | 10 | 调度池最大并行工具数 |
| `maxToolRounds` | 40 | 单次任务最大工具执行轮数 |

任一预算耗尽即终止该程序，错误信息回注模型上下文由其自行调整。

## 会话与快照 Review

- **会话持久化**：每轮对话（时间线事件、状态机阶段）以 JSONL 持久化于 VS Code globalStorage：`<globalStorage>/ptc-agent/sessions/<workspaceHash>/<sessionId>.jsonl`，按工作区隔离，可从顶部历史下拉恢复任意会话。
- **快照 Review**：Agent 每次编辑文件前先把原文快照到 `<globalStorage>/ptc-agent/snapshots/<sessionId>/`。任务完成进入 Review 阶段后：
  - 点击改动文件 → 打开 VS Code 原生 diff 视图对比快照与当前内容；
  - **Accept**：保留改动并丢弃该文件快照（不传路径则 Accept 全部）；
  - **Reject**：从快照还原文件到编辑前状态（不传路径则 Reject 全部）。

## 已知事项与排障

### 代理环境 SSE 断流（`http.proxySupport`）

VS Code 默认开启 `http.proxySupport`，会劫持扩展的网络请求；某些代理环境下会导致 SSE 流式响应断流、卡住无输出。排障步骤：

1. 打开 VS Code 设置（`Ctrl+,`）；
2. 搜索 `http.proxySupport`，将其设为 **`off`**；
3. 重启 VS Code（`Developer: Reload Window` 即可）后再试。

若仍不通，请确认 baseURL 可达（可临时用 `curl` 验证），并检查代理是否放行 SSE 长连接。

### Windows 路径约定

工具与 `run_code` 程序内的路径统一使用**正斜杠**（`/`）相对路径（相对当前工作区根目录），如 `src/index.ts`。Windows 下反斜杠路径不受支持，快照、diff 与 review 均按正斜杠约定解析。

### 其他

- API 密钥仅存于 VS Code SecretStorage（`globalStorage` 中不落盘明文），重装插件需重新录入；
- 插件无任何命令面板命令，全部交互在 PTC Agent 侧边栏内完成；
- 上游 API 限流（429）时自动按响应指示退避重试，鉴权失败（401/403）提示检查密钥。

## 开发

```bash
npm run build    # 完整构建（codicons + 主进程 esbuild + webview vite）
npm run watch    # 主进程 watch 模式
npm test         # vitest 单元测试
npx @vscode/vsce package --no-dependencies   # 打包 .vsix
```
