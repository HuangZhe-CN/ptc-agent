/**
 * Floaters 局部文案字典（zh/en）——Task 24。
 * 受控约束：不得修改 i18n.ts（Task 26 统一收口），参照 Onboarding/onboardingText.ts 先例，
 * 本目录组件（ModelPopover/QueuePanel 及 ModelTrigger 的 quality 字段）自带字典；
 * locale 取 useAgentStore 的 state.locale（boot 快照下发）。
 * key 缺失时回退 key 本身（与 i18n.ts 约定一致）。
 */
export type FtLocale = 'zh' | 'en'

const zh = {
  /* ModelPopover（§07.2） */
  'popover.title': '模型',
  'popover.empty': '尚未配置模型',
  'popover.thinking': '思考',
  'popover.noKey': '未保存密钥',
  'popover.more': '选择思考强度',
  'quality.title': '思考强度',
  'quality.low': '低',
  'quality.medium': '中',
  'quality.high': '高',
  /* QueuePanel（§11） */
  'queue.title': '排队消息',
  'queue.hint': 'Agent 完成当前工作后自动发送',
  'queue.count': '{n} 条排队消息',
  'queue.send': '立即发送',
  'queue.edit': '编辑',
  'queue.editConfirm': '确认修改',
  'queue.editCancel': '取消修改',
  'queue.delete': '删除',
  'queue.toggle': '展开或收起队列',
} as const

const en: Record<keyof typeof zh, string> = {
  /* ModelPopover (§07.2) */
  'popover.title': 'Model',
  'popover.empty': 'No models configured',
  'popover.thinking': 'Thinking',
  'popover.noKey': 'No API key saved',
  'popover.more': 'Change reasoning effort',
  'quality.title': 'Reasoning effort',
  'quality.low': 'Low',
  'quality.medium': 'Medium',
  'quality.high': 'High',
  /* QueuePanel (§11) */
  'queue.title': 'Queued Messages',
  'queue.hint': 'Sends after agent finishes working',
  'queue.count': '{n} queued messages',
  'queue.send': 'Send now',
  'queue.edit': 'Edit',
  'queue.editConfirm': 'Confirm edit',
  'queue.editCancel': 'Cancel edit',
  'queue.delete': 'Delete',
  'queue.toggle': 'Expand or collapse the queue',
}

export type FtKey = keyof typeof zh

/** 与 i18n.normalizeLocale 同规则的局部取词：zh* → zh，其余 → en */
export function ft(locale: string, key: FtKey, params?: Record<string, string | number>): string {
  const dict: Record<FtKey, string> =
    locale && locale.toLowerCase().startsWith('zh') ? (zh as Record<FtKey, string>) : en
  let s = dict[key] ?? (key as string)
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v))
  }
  return s
}
