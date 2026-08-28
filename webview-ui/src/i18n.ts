/**
 * i18n 最小骨架（Task 20）：zh/en 两个字典 + t()。
 * Task 21 填入 Composer/UtilityRail/Header 所需文案；后续任务逐组件扩充。
 * key 缺失时回退显示 key 本身，便于发现漏译。
 */
export type Locale = 'zh' | 'en'

const dicts: Record<Locale, Record<string, string>> = {
  zh: {
    'composer.placeholder': '随便问点什么…',
    'composer.send': '发送',
    'composer.stop': '停止',
    /* 图片附件（粘贴/选择/删除/上限提示） */
    'composer.addImage': '添加图片',
    'composer.removeImage': '删除图片',
    'composer.imageLimit': '最多 4 张图片',
    'composer.imageUnsupported': '仅支持 PNG/JPEG/WebP/GIF 图片',
    'composer.imageDropped': 'GIF 图片不被当前模型协议支持，已忽略',
    'rail.reviewChanges': '审阅更改',
    /* utility rail 图标 + header 管理/收起（workbenchAction 接线） */
    'rail.files': '资源管理器',
    'rail.terminal': '终端',
    'rail.folder': '打开文件夹',
    'rail.browser': '打开网页',
    'header.manage': '管理模型服务',
    'header.close': '收起侧栏',
    'quality.low': '低',
    'quality.medium': '中',
    'quality.high': '高',
    'header.newSession': '新建会话',
    /* Task 26：Header history 入口 + History 下拉（rpc listSessions） */
    'header.history': '历史会话',
    'history.title': '会话历史',
    'history.loading': '加载中…',
    'history.empty': '暂无历史会话',
    /* Task 22：Timeline 事件标签（§08/§09） */
    'event.thought.thinking': '思考中 {n}s',
    'event.thought.thought': '思考了 {n}s',
    'event.thought.working': '处理中…',
    'event.explore.running': '探索中…',
    'event.explore.done': '已探索 {n} 个文件',
    'event.edit.label': '已编辑',
    'event.run.running': '运行中…',
    'event.run.done': '已运行',
    'event.run.error': '运行失败',
    'event.run.noOutput': '（无输出）',
  },
  en: {
    'composer.placeholder': 'Ask anything…',
    'composer.send': 'Send',
    'composer.stop': 'Stop',
    /* Image attachments (paste/pick/remove/limit notices) */
    'composer.addImage': 'Add image',
    'composer.removeImage': 'Remove image',
    'composer.imageLimit': 'Up to 4 images',
    'composer.imageUnsupported': 'Only PNG/JPEG/WebP/GIF images are supported',
    'composer.imageDropped': 'GIF images are not supported by the active model protocol and were ignored',
    'rail.reviewChanges': 'Review Changes',
    /* Utility rail icons + header manage/close (workbenchAction wiring) */
    'rail.files': 'Explorer',
    'rail.terminal': 'Terminal',
    'rail.folder': 'Open folder',
    'rail.browser': 'Open page',
    'header.manage': 'Manage providers',
    'header.close': 'Hide sidebar',
    'quality.low': 'Low',
    'quality.medium': 'Medium',
    'quality.high': 'High',
    'header.newSession': 'New Session',
    /* Task 26: Header history entry + History dropdown (rpc listSessions) */
    'header.history': 'Session History',
    'history.title': 'Sessions',
    'history.loading': 'Loading…',
    'history.empty': 'No sessions yet',
    /* Task 22: Timeline event labels (§08/§09) */
    'event.thought.thinking': 'Thinking for {n}s',
    'event.thought.thought': 'Thought for {n}s',
    'event.thought.working': 'Working…',
    'event.explore.running': 'Exploring…',
    'event.explore.done': 'Explored {n} files',
    'event.edit.label': 'Edited',
    'event.run.running': 'Running…',
    'event.run.done': 'Ran',
    'event.run.error': 'Run failed',
    'event.run.noOutput': '(no output)',
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
