import * as vscode from 'vscode'
import type { SnapshotTracker } from './snapshot'

export const SNAPSHOT_SCHEME = 'ptc-snapshot'

/** 注册快照只读内容提供者：uri.path = /<sessionId>/<encoded relPath>，经 tracker 读取快照原文。 */
export function registerSnapshotContentProvider(resolveTracker: () => SnapshotTracker | undefined): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
      // uri.path = /<sessionId>/<encoded relPath>；vscode.Uri.parse 已对 path 做过一次 percentDecode，
      // 这里不能再 decodeURIComponent（否则含 % 的文件名被多次解码：URIError 打不开、字面名读错快照）。
      // 写入侧按段 encode 时 '/' 已变 %2F，解码后的段内不含 '/'，直接 join 无歧义；rel 交 readSnapshot
      // → snapPath 会重新按段 encode，与落盘快照名精确对应。
      const rel = uri.path.split('/').slice(2).join('/')
      const tracker = resolveTracker()
      if (!tracker) return Promise.resolve('')
      return tracker.readSnapshot(rel).catch(() => '')
    },
  })
}

/** 打开 快照(original) ↔ 当前文件 的 diff 编辑器。 */
export async function openSnapshotDiff(sessionId: string, relPath: string, fileAbsPath: string): Promise<void> {
  const snapUri = vscode.Uri.parse(`${SNAPSHOT_SCHEME}:/${sessionId}/${relPath.split('/').map(encodeURIComponent).join('/')}`)
  const fileUri = vscode.Uri.file(fileAbsPath)
  await vscode.commands.executeCommand('vscode.diff', snapUri, fileUri, `${relPath} (original ↔ current)`, { preserveFocus: true })
}
