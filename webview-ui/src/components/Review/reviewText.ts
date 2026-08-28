/**
 * Review 局部文案字典（zh/en）——Task 23。
 * 受控约束：不得修改 i18n.ts（Task 26 统一收口），故本目录组件自带字典，
 * 参照 Onboarding/onboardingText.ts 先例；locale 取 useAgentStore 的 state.locale。
 * key 缺失时回退 key 本身，便于发现漏译（与 i18n.ts 约定一致）。
 */
export type RvLocale = 'zh' | 'en'

const zh = {
  /* 汇总卡（设计稿 §10.3 原文为英文；实际界面为中文，统一译出以保持文案语言一致） */
  'card.filesChanged': '已更改 {n} 个文件',
  'card.review': '审阅更改',
  /* ReviewPanel 文件列表行（§13.2） */
  'panel.newFile': '新文件',
  'panel.modifiedFile': '已修改',
  'panel.openDiff': '查看差异',
  'panel.empty': '暂无待审更改',
  /* 反馈区（§13.2：copy / thumbs up / thumbs down，纯 UI） */
  'feedback.copy': '复制',
  'feedback.helpful': '有帮助',
  'feedback.notHelpful': '没帮助',
  /* ReviewActionBar（§13.2 底部 bar） */
  'bar.filesWithChanges': '{n} 个文件待审',
  'bar.rejectAll': '全部拒绝',
  'bar.acceptAll': '全部接受',
  'bar.close': '关闭审阅',
} as const

const en: Record<keyof typeof zh, string> = {
  'card.filesChanged': '{n} files changed',
  'card.review': 'Review',
  'panel.newFile': 'New file',
  'panel.modifiedFile': 'Modified',
  'panel.openDiff': 'Open diff',
  'panel.empty': 'No pending changes',
  'feedback.copy': 'Copy',
  'feedback.helpful': 'Helpful',
  'feedback.notHelpful': 'Not helpful',
  'bar.filesWithChanges': '{n} Files With Changes',
  'bar.rejectAll': 'Reject all',
  'bar.acceptAll': 'Accept all',
  'bar.close': 'Close review',
}

export type RvKey = keyof typeof zh

/** 与 i18n.normalizeLocale 同规则的局部取词：zh* → zh，其余 → en */
export function rv(locale: string, key: RvKey, params?: Record<string, string | number>): string {
  const dict: Record<RvKey, string> =
    locale && locale.toLowerCase().startsWith('zh') ? (zh as Record<RvKey, string>) : en
  let s = dict[key] ?? (key as string)
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v))
  }
  return s
}
