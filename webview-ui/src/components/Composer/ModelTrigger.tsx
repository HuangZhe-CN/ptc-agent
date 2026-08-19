import React from 'react'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'

/**
 * 设计稿 §07.1 底部左侧模型控件：模型名 + quality + chevron，同一 baseline。
 * 本任务（Task 21）仅静态展示 active 模型；popover / quality 子菜单由 Task 24 接管。
 */
export function ModelTrigger(): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const providers = useAgentStore(s => s.providers)
  const active = useAgentStore(s => s.active)

  let label = '—'
  if (active) {
    const provider = providers.find(p => p.id === active.providerId)
    label = provider?.models.find(m => m.id === active.modelId)?.label ?? active.modelId
  }

  return (
    <button type="button" className="modelTrigger" title={label}>
      <span className="modelLabel">{label}</span>
      {active && <span className="modelQuality">{t(locale, `quality.${active.quality}`)}</span>}
      <i className="codicon codicon-chevron-down" aria-hidden="true" />
    </button>
  )
}
