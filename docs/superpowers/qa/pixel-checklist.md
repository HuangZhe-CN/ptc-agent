# PTC Agent 像素 QA 清单（Task 27）

对照【设计稿】`docs/前端设计/VSCode_Agent_Pixel_Replica_MD_Package/README.md` §21.2 黄金截图状态 × §21.4 Theme Matrix。
适用版本：v0.1.0（T1–T26 完成后）。执行人：人工（有头环境）；自动冒烟见 §6。

---

## 1. 执行环境与工具

| 项 | 值 |
|---|---|
| 宿主 | VS Code 1.134+（Windows，golden 环境按设计稿 §21.3 取 Windows + 目标 VS Code 版本） |
| 打开方式 A（推荐） | F5（Run Extension）→ Extension Development Host，左侧 **Explorer 容器底部「Agent」视图**（见 §5 已知问题 K1：活动栏容器 id 含点被 1.134 拒绝，视图暂落在 Explorer） |
| 打开方式 B | `npm run test:vscode`（@vscode/test-electron 自动冒烟，见 §6） |
| 量取工具 | `Developer: Open Webview Developer Tools`（元素面板量几何）/ `Developer: Toggle Developer Tools` |
| 主题切换 | `Preferences: Color Theme` → `Default Light Modern` / `Default Dark Modern` / `High Contrast` / `High Contrast Light` |
| 参考截图 | 设计稿包 `docs/前端设计/VSCode_Agent_Pixel_Replica_MD_Package/images/*.png` 并排人工比对；坐标速查见设计稿 APPENDIX A（764×1314 Capture px，`scale = containerWidth / 764` 换算） |

## 2. 通用验收标准（每个格子都适用）

1. **几何**：关键边界（Header / prompt card / EventRow 左起点 / Composer / popover / Queue 浮层）误差 ≤ **1 CSS px**；图标中心误差 ≤ 1.5px（§21.3）。
2. **颜色**：无写死色——生产 CSS 不得出现 `#hex` 背景/描边/焦点色，一律 `var(--vscode-*)`（§3.6 禁止项逐条过）；背景/surface 目标 ΔE < 2（仅 Light golden 行）。
3. **High Contrast 两行**：`agentCard` / `composer` / `popover` / Queue 浮层必须有显式 `contrastBorder` 边框且阴影为 none（§3.5）；focus 用 `--vscode-focusBorder` / `--vscode-contrastActiveBorder`。
4. **Popover 阴影**：Light/Dark 下 popover 阴影柔和（Dark 更谨慎，不得出现脏灰光晕，§3.5）；transform-origin = 锚点侧。
5. **动效节奏（§15）**：Popover 120ms 进/90ms 退（scale .98→1）；Chevron 120–160ms rotate；Thinking 展开 160–220ms；Queue 140–180ms（y 6→0 + 阴影同步）；Send→Stop 80–120ms cross-fade（外圆尺寸不变）；新 EventRow 100–160ms opacity（≤2px y 位移，禁 overshoot）；计时器 1Hz 无滚动动画。录屏 ≥20 FPS 与设计稿关键帧并排比较，时长误差 ±30ms；`prefers-reduced-motion: reduce` 下仅保留 50–80ms opacity（§15.1）。
6. **主题切换运行时（§21.4/§3.7）**：切换无需 Reload、不得出现一帧固定米黄背景、popover/Composer 立即换肤、SVG 无固定黑/白 fill 残留、Scrollbar/Focus/Selection/Button/Diff 同步变化。
7. **文字**：字号/行高对齐设计稿；diff 数字 tabular（+9→+1331 不挤压文件名，§17.1）。

## 3. 到达状态的两种方式

### 3a. 真实流程（少数状态）

- 首次安装：无 provider → Onboarding 表单（Add provider：protocol/baseUrl/api key → Fetch models → Save）。
- `submit` 真实任务需真模型；错误路径可用伪 baseUrl `http://127.0.0.1:1`（立即网络错误 → running → error 事件）。

### 3b. Fixture 注入（推荐，覆盖 G01–G07 全部）

webview `main.tsx` 直接消费 `window message`（`applyHost(e.data)`），故在 **Webview DevTools 控制台**粘贴 host 形状消息即可精确到达任一状态，不依赖模型与真实会话：

```js
// 通用注入器：把任意 WebviewState 打进 webview（seq 任意，applyHost 不校验）
function snap(state) {
  window.postMessage({ type: 'snapshot', seq: 1, state: {
    locale: 'en', phase: 'idle', title: 'Agent', sessionId: 'qa',
    events: [], queue: [], changes: [], providers: [], providerKeyed: {}, active: null, hasSessions: false,
    ...state } }, '*')
}
// ops 追加（如补一条 error / queue 变化）：
function ops(list) { window.postMessage({ type: 'ops', seq: 2, sessionId: 'qa', ops: list }, '*') }
```

G 状态 fixture 要点（时间线事件形状见 `src/shared/protocol.ts` `TimelineEvent`）：

- **G01**：`providers:[{id:'p1',label:'Demo',protocol:'openai',baseUrl:'',models:[{id:'m1',label:'Model A',supportsThinking:false}]}]`，`active:{providerId:'p1',modelId:'m1',quality:'medium'}`，phase idle；注入后点 ModelTrigger 开 popover。
- **G02**：phase `'running'`，events：`{type:'thought',status:'running',...}` + `{type:'explore',status:'done',count:5,targets:[...]}`（prompt card 由首条 user 提交产生——fixture 下用 `{op:'append'}` 补 `{type:'thought'…}` 前置一条即可观察 timeline 起点；Stop 由 phase=running 自动出现）。
- **G03**：events 含 `{type:'thought', id:'t1', status:'running', startedAt: Date.now(), markdown:'# Plan\n`code` inline', working:'reading files…'}`，展开态：`window.postMessage` 无法改 `ui.expandedThoughtIds`（ui 为 webview 本地态）→ 直接点击该 thought 行展开。
- **G04**：phase `'running'` + `ops([{op:'queue', queue:[{id:'q1',text:'first queued'},{id:'q2',text:'second'}]}])`；QueuePanel 由 queue 非空出现（`ui.queueOpen` 默认 true）。
- **G05**：events 填 12+ 条混合（explore done / edit 带 add/del 与 fileKind / thought done / run done+error / completion markdown），滚出滚动条检查纵距/图标/diff 色/scrollbar。
- **G06**：`changes:[{path:'src/a.ts',add:12,del:3,kind:'ts'},{path:'src/b.css',add:40,del:0,kind:'css'}]`，phase `'awaiting_review'`；点 utility rail 的 Review 图标（或 Header Review Changes）打开 ReviewPanel；Accept/Reject 单文件与 Accept all 计数变化。
- **G07**：phase `'completed'`，末尾 `{type:'completion', markdown:'## Done\n- summary...'}`，`changes:[]`（0 changes 变体；亦可留 1–2 条看 files changed 区）。

## 4. 矩阵 G01–G07 × 4 主题

每格 = 「必检项（对照 §21.2 表）」+「到达步骤（§3）」。勾选框走查时打勾。
主题列缩写：**L**=Default Light Modern（golden，需截图 diff）、**D**=Default Dark Modern、**HC**=High Contrast、**HCL**=High Contrast Light（D/HC/HCL 按 §21.4 只验宿主语义色与层级，不与源视频比色）。

| 状态 | 必检项（§21.2） | 到达步骤 | L | D | HC | HCL |
|---|---|---|---|---|---|---|
| **G01 Idle + model menu** | Header（64px 高、固定）；初始 Composer（16/1160、≈734×120，占位符单行）；Model popover 位置/宽度（x≈81、w≈323）/阴影/向上展开 origin；send 圆（Ø40–44）；quality 子菜单 | §3b G01 注入 → 点 ModelTrigger | ☐ | ☐ | ☐ | ☐ |
| **G02 Running + Explore** | prompt card（28/90、711×80）；timeline 一级事件左起点 x≈39；Stop（send 位交叉淡切，外圆不变）；bottom dock 布局 | §3b G02 注入（或真任务首轮） | ☐ | ☐ | ☐ | ☐ |
| **G03 Thinking open** | 缩进（thought body x≈56–75、w≈640–670）；标题 weight；行高；inline code 底色；Working 行；展开 160–220ms | §3b G03 注入 → 点击 thought 行展开 | ☐ | ☐ | ☐ | ☐ |
| **G04 Queue open** | 浮层宽高（16/≈992、≈734×156 两条时）；阴影；header；row actions（edit/delete/submit-now）；与 Composer 间距 | §3b G04 注入 | ☐ | ☐ | ☐ | ☐ |
| **G05 Dense history** | 事件纵距统一；file icons 固定 slot；diff 色（+green/−red 语义色）；scrollbar（x≈751–759、w 7–8）；+N 变宽不挤压 | §3b G05 注入 | ☐ | ☐ | ☐ | ☐ |
| **G06 Review open** | summary card；file list（含新增文件 pill）；feedback 区；sticky action bar；Accept all；Review 独立组件非气泡 | §3b G06 注入 → 打开 ReviewPanel | ☐ | ☐ | ☐ | ☐ |
| **G07 Completed** | Auto-proceeded 表现；Completion Markdown 渲染；Walkthrough 卡（数据源缺失，见 K5——验占位不渲染时布局不塌）；0 changes；Send 恢复 | §3b G07 注入 | ☐ | ☐ | ☐ | ☐ |

### 4.1 每主题行附加检查（切主题后逐行过）

- **L（golden）**：与 `images/*.png` 并排截图 diff；几何 ≤1px、ΔE<2（背景/surface）。
- **D**：无反相脏色、阴影收敛、diff 色仍可辨。
- **HC / HCL**：卡片/composer/popover/queue 全部有 contrastBorder 显式边框、无阴影；focus 环用宿主 token；文本/图标对比度足够。

### 4.2 键盘与可访问性（§20，随 G01/G04 行走查）

- ModelTrigger Enter 打开、↑↓ 移动、→ 进 quality 子菜单、Esc 关闭（T24 实现，待实机验）。
- Composer Enter 发送 / Shift+Enter 换行；Stop 可聚焦；队列浮层 Esc。

## 5. 已知待验项 / 已知问题（走查时重点确认）

**各任务报告标注「待冒烟」的 F5 项：**

- K1（**发现于本次自动冒烟，阻塞级**）：`package.json` 活动栏容器 `id: "ptc-agent.container"` 含 `.`，VS Code 1.134 校验拒绝（"Only alphanumeric characters, '_', and '-' are allowed"）→ 活动栏无 PTC 图标，Agent 视图落入 **Explorer** 容器底部。修复属 package.json `contributes` 变更（T27 代理无该文件权限，未改）：id 改为 `ptc-agent-container` 并同步引用处后需复验 G01 Header 与容器图标。
- K2：G01/G02 骨架 F5 视觉验证（T20/T21 报告遗留）。
- K3：G03/G05 fixture 视觉演练与 Markdown 渲染（T22 遗留；解析器已走查，渲染待实机）。
- K4：键盘路径（Enter/↑↓/→/Esc、运行中入队展开动画）（T24 遗留）。
- K5：真模型全流程（Onboarding → Fetch models → submit → timeline → completed）与 Accept/Reject 后 changes 计数联动（T23/T25 遗留；Walkthrough 卡 v1 无数据源，验收时按"不渲染"确认布局）。
- K6：VS Code 中文语言切换（`envLanguage` → snapshot locale → i18n 文案切换）。
- K7：popover/queue/history **退出动画缺失**（条件挂载即瞬时卸载，T24 concern 2；§15 要求 90/120ms 退场）——走查时记录是否接受为 v1 已知差异。
- K8：done 态 thought 会话重放时长显示墙钟差（T22 concern 1：协议无 durationMs）。
- K9：`reviewProvider` 双重 decodeURIComponent 对含 `%` 文件名的行为（T18 concern 2）。
- K10：Header more 下拉（ProviderManager 入口）未接线（T26 concern 3）。

## 6. 自动冒烟状态（`npm run test:vscode`）

@vscode/test-electron 3.1.0 + VS Code 1.134.0（首次运行下载至 `.vscode-test/`）。套件 `src/test/suite/index.ts` 四断言：

| # | 断言 | 结果 |
|---|---|---|
| A1 | 扩展激活无错 + `ptc-agent.view.focus` 可执行 | PASS |
| A2 | webview ready 握手后 AgentService 收到 snapshot（只读钩子 `getLastSnapshotForTest()`） | PASS（修复 K11 后） |
| A3 | `saveProviders`+`saveApiKey`+`submit`（伪 baseUrl `http://127.0.0.1:1`）→ phase=running → network error 事件 → phase=error | PASS（~7.2s，符合 1+2+4s 重试退避） |
| A4 | `dist/worker.js` 存在 + CodeRuntime 真 worker 一轮 `return 1` | PASS |

- K11（**发现于本次自动冒烟，已修复**）：`resolveWebviewView` 未设 `enableScripts: true` → webview 脚本被禁用、ready 永不发出、真实用户侧视图全空白。已改 `src/extension.ts`（一行），冒烟 4/4 通过。
- A2 依赖 `extension.ts` 的 `globalThis.__ptcAgentServiceRef` 只读测试钩子；A3 直接驱动真实 `AgentService`（真实 SecretStorage/JSONL 会话库），落库于一次性测试 profile（`.vscode-test/user-data`）。
- 复跑前置：`npm run build`（产 `dist/extension.js`、`dist/worker.js`、`webview-ui/dist/*`）。
