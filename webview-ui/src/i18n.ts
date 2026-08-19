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
    'rail.reviewChanges': '审阅更改',
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
    'event.run.error': '已运行',
    'event.run.noOutput': '（无输出）',
  },
  en: {
    'composer.placeholder': 'Ask anything…',
    'composer.send': 'Send',
    'composer.stop': 'Stop',
    'rail.reviewChanges': 'Review Changes',
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
    'event.run.error': 'Ran',
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
