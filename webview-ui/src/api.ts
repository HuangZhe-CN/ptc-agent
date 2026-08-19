// VS Code webview API 最小声明（不引入 @types/vscode：webview 侧只有 acquireVsCodeApi 一个全局）
type VscodeApi = {
  getState<T>(): T | undefined
  setState(s: unknown): void
  postMessage(m: unknown): PromiseLike<boolean>
}
declare function acquireVsCodeApi(): VscodeApi

/**
 * acquireVsCodeApi() 全局仅允许调用一次（Global Constraints）——
 * 模块加载时取得唯一实例，其余代码一律经由本模块访问。
 * 注意：本模块不得被 node 环境（vitest）加载，store.ts 因此不 import 本文件。
 */
export const vscodeApi = acquireVsCodeApi()

/** webview → host 发消息（不可达时静默） */
export const post = (m: unknown): void => {
  try { void vscodeApi.postMessage(m) } catch { /* host 不可达 */ }
}
