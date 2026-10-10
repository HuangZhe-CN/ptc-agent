/**
 * host 侧 i18n 字典：与 webview-ui/src/i18n.ts 同构的 t(locale, key, params)。
 * 约束：本模块零 vscode 依赖、零 service 依赖——不得被 worker 入口链（worker.ts→bootstrap）引入。
 * en 值为历史文案的逐字基线（测试断言与已持久化 JSONL 的一致性依赖），改动需同步核对 test/agent-service.test.ts。
 */
export type Locale = 'en' | 'zh'

const dicts: Record<Locale, Record<string, string>> = {
  zh: {
    'service.compact.busy': '回合进行中，无法压缩',
    'service.compact.empty': '没有可压缩的内容：会话为空',
    'service.noProvider': '未选择模型服务',
    'service.compact.persistFailed': '压缩结果持久化失败：{error}（仅内存中完成压缩；重新打开该会话将显示未压缩的历史）',
    'service.compact.failed': '压缩失败：{error}',
    'service.review.listFailed': '审阅 {action} 列出更改失败：{error}',
    'service.review.fileFailed': '审阅 {action} {path} 失败：{error}',
    'service.images.dropped': '所有图片附件已被丢弃：当前模型协议不支持其格式（如 Gemini 不支持 GIF）',
    'service.provider.gone': '所选的模型服务已不存在',
    'service.persist.failed': '会话持久化失败：{error}',
    'service.urlPrompt': '输入要打开的网址',
    'service.browserFailed': '无法打开浏览器',
    'service.actionFailed': '无法执行操作：{action}',
    'review.diffTitle': '{path}（原始 ↔ 当前）',
    'loop.retrying': '{kind}: {message} — 正在重试（{n}/3）',
    'loop.streamNoDone': '流在 message_done 前结束',
    'loop.roundLimit': '已到达工具调用轮次上限（{limit}）。为安全起见停止。',
    'loop.toolUseNoCall': 'stop reason 为 tool_use 但未解析出 run_code 调用',
    'loop.snapshotUnavailable': '快照不可用：{path}（{error}）——该编辑无法审阅/拒绝',
    'loop.stopped': '已停止（{reason}）',
  },
  en: {
    'service.compact.busy': 'Cannot compact while a turn is running',
    'service.compact.empty': 'Nothing to compact: the conversation is empty',
    'service.noProvider': 'No provider/model selected',
    'service.compact.persistFailed': 'compact persist failed: {error} (history compacted in memory only; reopening the session will show the uncompacted history)',
    'service.compact.failed': 'Compact failed: {error}',
    'service.review.listFailed': 'review {action} failed to list changes: {error}',
    'service.review.fileFailed': 'review {action} failed for {path}: {error}',
    'service.images.dropped': 'All image attachments were dropped: the active model protocol does not support their format (e.g. GIF on Gemini)',
    'service.provider.gone': 'Selected provider no longer exists',
    'service.persist.failed': 'session persist failed: {error}',
    'service.urlPrompt': 'Enter the URL to open',
    'service.browserFailed': 'Unable to open browser',
    'service.actionFailed': 'Unable to run action: {action}',
    'review.diffTitle': '{path} (original ↔ current)',
    'loop.retrying': '{kind}: {message} — retrying ({n}/3)',
    'loop.streamNoDone': 'stream ended without message_done',
    'loop.roundLimit': 'Reached the tool-call round limit ({limit}). Stopping to stay safe.',
    'loop.toolUseNoCall': 'tool_use stop reason without a parsed run_code call',
    'loop.snapshotUnavailable': 'snapshot unavailable: {path} ({error}) — this edit is not reviewable/rejectable',
    'loop.stopped': 'Stopped ({reason})',
  },
}

export function normalizeLocale(locale: string): Locale {
  return locale && locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function t(locale: string, key: string, params?: Record<string, string | number>): string {
  const dict = dicts[normalizeLocale(locale)]
  let s = dict[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v))
  }
  return s
}
