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
