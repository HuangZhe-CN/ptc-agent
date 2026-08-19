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
