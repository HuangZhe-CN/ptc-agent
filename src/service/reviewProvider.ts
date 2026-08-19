import * as vscode from 'vscode'
import type { SnapshotTracker } from './snapshot'

export const SNAPSHOT_SCHEME = 'ptc-snapshot'

/** 注册快照只读内容提供者：uri.path = /<sessionId>/<encoded relPath>，经 tracker 读取快照原文。 */
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

/** 打开 快照(original) ↔ 当前文件 的 diff 编辑器。 */
export async function openSnapshotDiff(sessionId: string, relPath: string, fileAbsPath: string): Promise<void> {
  const snapUri = vscode.Uri.parse(`${SNAPSHOT_SCHEME}:/${sessionId}/${relPath.split('/').map(encodeURIComponent).join('/')}`)
  const fileUri = vscode.Uri.file(fileAbsPath)
  await vscode.commands.executeCommand('vscode.diff', snapUri, fileUri, `${relPath} (original ↔ current)`, { preserveFocus: true })
}
