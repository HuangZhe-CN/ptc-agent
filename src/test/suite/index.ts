/**
 * Task 27 扩展宿主冒烟套件（加载于 VS Code 扩展宿主进程内，与被测扩展同进程）。
 * 四条断言对照计划 Task 27：
 *   A1 扩展激活无错 + `ptc-agent.view.focus` 可执行
 *   A2 webview ready 握手后 AgentService 已发出 snapshot（只读钩子 getLastSnapshotForTest）
 *   A3 saveProviders + saveApiKey + submit（伪 baseUrl）→ phase=running → error 事件（网络错误路径）
 *   A4 dist/worker.js 存在 + CodeRuntime 真 worker 一轮 `return 1`
 *
 * 无 mocha 依赖：自带顺序执行的极小 runner（失败抛错 → @vscode/test-electron 以非零码退出）。
 */
import * as assert from 'node:assert/strict'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import * as vscode from 'vscode'
import { CodeRuntime } from '../../runtime/codeRuntime'
import type { AgentService } from '../../service/agentService'
import type { WebviewState } from '../../shared/protocol'

const EXT_ID = 'ptcagent.ptc-agent'   // 与 package.json publisher 一致（47a2ce2 改 publisher 时本常量漏更，smoke 0/4 的根因）

// ---- 极小测试 harness（顺序执行） ----
type TestFn = () => void | Promise<void>
const cases: Array<{ name: string; fn: TestFn }> = []
function test(name: string, fn: TestFn): void { cases.push({ name, fn }) }
const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms) })

/** 轮询直到 probe 返回 truthy（支持 async probe）；超时抛错。返回类型收窄掉 null/undefined/false。 */
async function until<T>(label: string, timeoutMs: number, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await probe()
    if (v) return v as T
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs}ms) waiting for: ${label}`)
    await sleep(150)
  }
}

function getServiceRef(): { service: AgentService | null } {
  const ref = (globalThis as { __ptcAgentServiceRef?: { service: AgentService | null } }).__ptcAgentServiceRef
  assert.ok(ref, 'extension test hook __ptcAgentServiceRef missing (extension not activated?)')
  return ref
}

// ---- A1 激活 + 视图可聚焦 ----
test('A1 extension activates without error; ptc-agent.view.focus executes', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID)
  assert.ok(ext, `extension ${EXT_ID} not found in test workbench`)
  await ext!.activate()   // 激活抛错会直接 fail 本用例
  assert.equal(ext!.isActive, true)
  await vscode.commands.executeCommand('ptc-agent.view.focus')   // 不可执行/未注册将 reject
})

// ---- A2 webview ready → snapshot ----
test('A2 webview ready handshake delivers snapshot to AgentService', async () => {
  const ref = getServiceRef()
  const service = await until('AgentService instance (webview view resolved)', 30_000, () => ref.service)
  // webview 加载 webview-ui/dist/index.js → postMessage('ready') → bridge.onReady → bootSnapshot
  const snapshot = await until('snapshot after ready (getLastSnapshotForTest)', 60_000, () => service.getLastSnapshotForTest())
  assert.equal(snapshot.phase, 'idle')
  assert.equal(snapshot.title, 'Agent')
  assert.ok(Array.isArray(snapshot.events), 'snapshot.events is array')
  assert.ok(Array.isArray(snapshot.providers), 'snapshot.providers is array')
})

// ---- A3 配置 + 提交 → running → 网络错误 ----
test('A3 saveProviders+saveApiKey+submit(fake baseUrl) reaches running then error event', async () => {
  const service = getServiceRef().service
  assert.ok(service, 'service missing (run A1/A2 first)')
  const svc = service!

  await svc.handleWebviewMessage({
    type: 'saveProviders',
    providers: [{
      id: 'smoke-p1', label: 'Smoke Provider', protocol: 'openai',
      baseUrl: 'http://127.0.0.1:1',   // 伪 baseUrl：本地拒绝连接 → fetch 网络错误路径
      models: [{ id: 'smoke-m1', label: 'smoke-m1', supportsThinking: false }],
    }],
    active: { providerId: 'smoke-p1', modelId: 'smoke-m1', quality: 'low' },
  })
  await svc.handleWebviewMessage({ type: 'saveApiKey', providerId: 'smoke-p1', apiKey: 'sk-test-smoke' })

  await svc.bootSnapshot()
  const cfg = svc.getLastSnapshotForTest()
  assert.ok(cfg, 'snapshot after config save')
  assert.equal(cfg!.providers.length, 1)
  assert.equal(cfg!.active?.providerId, 'smoke-p1')
  assert.equal(cfg!.providerKeyed['smoke-p1'], true, 'apiKey recorded (providerKeyed)')

  // 提交后不立即 await：先在重试窗口内观测 phase=running（bootSnapshot 为只读观测面）
  const turn = svc.handleWebviewMessage({ type: 'submit', text: 'smoke: expect network failure' })
  await until('phase=running during turn', 30_000, async () => {
    await svc.bootSnapshot()
    return svc.getLastSnapshotForTest()?.phase === 'running' ? true : null
  })
  await turn   // 3 次重试退避 1s/2s/4s + 4 次即时连接拒绝
  await svc.bootSnapshot()
  const after: WebviewState | null = svc.getLastSnapshotForTest()
  assert.ok(after, 'snapshot after turn')
  assert.equal(after!.phase, 'error', `final phase (got ${after!.phase})`)
  const errorEvents = after!.events.filter(e => e.type === 'error')
  assert.ok(errorEvents.length > 0, 'error timeline event appended')
  assert.ok(errorEvents.some(e => e.message.startsWith('network')),
    `error event is network-kind (messages: ${errorEvents.map(e => e.message).join(' | ')})`)
})

// ---- A4 worker 产物 + CodeRuntime 一轮 ----
test('A4 dist/worker.js exists; CodeRuntime runs one `return 1` program', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID)
  assert.ok(ext, 'extension handle missing')
  const workerPath = path.join(ext!.extensionUri.fsPath, 'dist', 'worker.js')
  assert.ok(existsSync(workerPath), `worker bundle missing: ${workerPath}`)
  const rt = new CodeRuntime(workerPath, { computeMs: 5000, maxWallMs: 10_000, maxOutputBytes: 65_536 })
  try {
    const r = await rt.run({ program: 'return 1', bindings: {} })
    assert.equal(r.error, undefined, `worker run error: ${JSON.stringify(r.error)}`)
    assert.equal(r.value, 1)
  } finally {
    await rt.dispose()
  }
})

// ---- VS Code 测试加载器入口：全过 resolve，任一失败 reject（非零退出码） ----
export async function run(): Promise<void> {
  const failures: Array<{ name: string; error: unknown }> = []
  for (const c of cases) {
    const t0 = Date.now()
    try {
      await c.fn()
      console.log(`[PASS] ${c.name} (${Date.now() - t0}ms)`)
    } catch (error: unknown) {
      failures.push({ name: c.name, error })
      console.error(`[FAIL] ${c.name}`)
      console.error(error)
    }
  }
  console.log(`smoke suite: ${cases.length - failures.length}/${cases.length} passed`)
  if (failures.length > 0) {
    throw new Error(`smoke suite failed: ${failures.map(f => f.name).join('; ')}`)
  }
}
