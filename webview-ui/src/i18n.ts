/**
 * i18n 最小骨架（Task 20）：zh/en 两个空字典 + t() 占位。
 * 文案在 Task 21+ 逐组件填充；key 缺失时回退显示 key 本身，便于发现漏译。
 */
export type Locale = 'zh' | 'en'

const dicts: Record<Locale, Record<string, string>> = { zh: {}, en: {} }

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
