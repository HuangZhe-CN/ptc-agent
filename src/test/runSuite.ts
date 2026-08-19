/**
 * Task 27 冒烟入口（外层 Node 进程，非扩展宿主）：
 * 经 @vscode/test-electron 拉起独立 VS Code 实例（首次运行下载 stable 到 <cwd>/.vscode-test），
 * 加载本扩展（extensionDevelopmentPath）+ 编译后的测试套件（extensionTestsPath → dist/test/suite-index.js）。
 *
 * 前置：npm run build 已产出 dist/extension.js、dist/worker.js、webview-ui/dist/*。
 * 运行：npm run test:vscode
 */
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { runTests } from '@vscode/test-electron'

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..')                       // dist/test → 项目根
  const extensionTestsPath = path.resolve(__dirname, 'suite-index.js')   // 由 test:vscode script 先行 esbuild 产出
  // 独立临时工作区：workspaceFolders 有值（与真实使用形态一致），跑完即删
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-agent-smoke-'))
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath,
      launchArgs: ['--disable-workspace-trust', '--disable-gpu', workspace],
    })
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => { console.error(err); process.exit(1) })
