import React, { useState } from 'react'
import type { ModelInfo, Protocol } from '@shared/protocol'
import { ob } from './onboardingText'
import { useListModels } from './useListModels'

/** 表单产出草稿：密钥仅在此暂存，onSubmit 消费后立即清空（webview 不保留） */
export interface ProviderDraft {
  label: string
  baseUrl: string
  apiKey: string
  models: ModelInfo[]
}

/** 三协议官方默认 Base URL（步骤 1 卡片与表单预填共用） */
export const DEFAULT_BASE_URL: Record<Protocol, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
}

/** supportsThinking 启发式：常见思考系模型命名（o1/o3/o4、*thinking*、*reason*、deepseek-r*） */
const THINKING_HINT = /(?:^|[^a-z])(?:o1|o3|o4)(?:[^a-z]|$)|think|reason|deepseek-r/i
export function guessSupportsThinking(id: string): boolean {
  return THINKING_HINT.test(id)
}

export interface ProviderFormProps {
  protocol: Protocol
  locale: string
  /** 回填（向导内「上一步」再进入时保留已填内容；不回填 apiKey） */
  initial?: { label?: string; baseUrl?: string; models?: ModelInfo[] }
  submitLabel: string
  onSubmit: (draft: ProviderDraft) => void
  onBack?: () => void
}

/**
 * 步骤 2 表单：label / baseUrl / apiKey(password) / 模型编辑。
 * - openai 协议附「获取模型列表」：rpc listModels（reqId 自增，结果经 store.lastRpc 回流），
 *   勾选即添加；anthropic/gemini 无标准 list 端点，仅手填。
 * - 手动添加：模型 ID + 显示名（可选）+ supportsThinking 勾选。
 */
export function ProviderForm(props: ProviderFormProps): JSX.Element {
  const { protocol, locale, initial, submitLabel, onSubmit, onBack } = props
  const [label, setLabel] = useState(initial?.label ?? ob(locale, `proto.${protocol}`))
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? DEFAULT_BASE_URL[protocol])
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<ModelInfo[]>(initial?.models ?? [])
  const [manualId, setManualId] = useState('')
  const [manualLabel, setManualLabel] = useState('')
  const [manualThinking, setManualThinking] = useState(false)
  const [dup, setDup] = useState(false)
  const rpc = useListModels()

  const trimmedUrl = baseUrl.trim()
  const valid = label.trim() !== '' && trimmedUrl !== '' && models.length > 0

  const addManual = (): void => {
    const id = manualId.trim()
    if (!id) return
    if (models.some(m => m.id === id)) {
      setDup(true)
      return
    }
    setDup(false)
    setModels(ms => [
      ...ms,
      { id, label: manualLabel.trim() || id, supportsThinking: manualThinking || guessSupportsThinking(id) },
    ])
    setManualId('')
    setManualLabel('')
    setManualThinking(false)
  }

  const toggleFetched = (id: string, on: boolean): void => {
    if (on) {
      if (!models.some(m => m.id === id)) {
        setModels(ms => [...ms, { id, label: id, supportsThinking: guessSupportsThinking(id) }])
      }
    } else {
      setModels(ms => ms.filter(m => m.id !== id))
    }
  }

  const submit = (): void => {
    if (!valid) return
    onSubmit({ label: label.trim(), baseUrl: trimmedUrl, apiKey: apiKey.trim(), models })
    setApiKey('') // 密钥只在表单暂存，提交后即清空输入框
  }

  return (
    <div className="obForm">
      <div className="obField">
        <label className="obFieldLabel">
          {ob(locale, 'form.label')}
          <span className="obHint"> · {ob(locale, 'form.label.hint')}</span>
        </label>
        <input
          className="obInput"
          value={label}
          spellCheck={false}
          onChange={e => setLabel(e.target.value)}
        />
      </div>

      <div className="obField">
        <label className="obFieldLabel">{ob(locale, 'form.baseUrl')}</label>
        <input
          className="obInput"
          value={baseUrl}
          spellCheck={false}
          placeholder={DEFAULT_BASE_URL[protocol]}
          onChange={e => {
            setBaseUrl(e.target.value)
            rpc.reset()
          }}
        />
      </div>

      <div className="obField">
        <label className="obFieldLabel">{ob(locale, 'form.apiKey')}</label>
        <input
          className="obInput"
          type="password"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          onChange={e => setApiKey(e.target.value)}
        />
        <span className="obHint">{ob(locale, 'form.apiKey.hint')}</span>
      </div>

      {protocol === 'openai' && (
        <div className="obField">
          <button
            type="button"
            className="obBtnSecondary"
            disabled={rpc.pending || trimmedUrl === ''}
            onClick={() => rpc.fetch({ baseUrl: trimmedUrl, protocol })}
          >
            <i
              className={`codicon ${rpc.pending ? 'codicon-sync codicon-modifier-spin' : 'codicon-cloud-download'}`}
              aria-hidden="true"
            />
            {rpc.pending ? ob(locale, 'form.fetching') : ob(locale, 'form.fetchModels')}
          </button>
          {!rpc.fetched && !rpc.error && <span className="obHint">{ob(locale, 'form.fetchHint')}</span>}
          {rpc.error && (
            <span className="obError">
              {ob(locale, 'form.fetchFailed')}: {rpc.error}
            </span>
          )}
          {rpc.fetched && !rpc.error && (
            <div className="obCheckList" role="group" aria-label={ob(locale, 'form.fetched')}>
              <div className="obCheckHead">{ob(locale, 'form.fetched')}</div>
              {rpc.models.length === 0 && (
                <div className="obCheckRow obHint">{ob(locale, 'form.fetchEmpty')}</div>
              )}
              {rpc.models.map(id => (
                <label key={id} className="obCheckRow">
                  <input
                    type="checkbox"
                    checked={models.some(m => m.id === id)}
                    onChange={e => toggleFetched(id, e.target.checked)}
                  />
                  <span className="obModelId">{id}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="obField">
        <label className="obFieldLabel">{ob(locale, 'form.models', { n: models.length })}</label>
        <span className="obHint">{ob(locale, 'form.models.hint')}</span>
        <div className="obManualRow">
          <label className="obThink">
            <input
              type="checkbox"
              checked={manualThinking}
              onChange={e => setManualThinking(e.target.checked)}
            />
            {ob(locale, 'form.thinking')}
          </label>
          <input
            className="obInput"
            value={manualId}
            placeholder={ob(locale, 'form.modelId')}
            spellCheck={false}
            onChange={e => {
              setManualId(e.target.value)
              setDup(false)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addManual()
              }
            }}
          />
          <input
            className="obInput"
            value={manualLabel}
            placeholder={ob(locale, 'form.modelLabel')}
            spellCheck={false}
            onChange={e => setManualLabel(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addManual()
              }
            }}
          />
          <button type="button" className="obBtnSecondary" disabled={manualId.trim() === ''} onClick={addManual}>
            {ob(locale, 'form.addModel')}
          </button>
        </div>
        {dup && <span className="obError">{ob(locale, 'form.errDup')}</span>}
        {models.length > 0 && (
          <div className="obModels">
            {models.map(m => (
              <div key={m.id} className="obModelRow">
                <span className="obModelId" title={m.id}>
                  {m.id}
                </span>
                {m.label !== m.id && (
                  <span className="obTag" title={m.label}>
                    {m.label}
                  </span>
                )}
                {m.supportsThinking && <span className="obTag">{ob(locale, 'tag.thinking')}</span>}
                <span className="obFlexSpace" />
                <button
                  type="button"
                  className="obIconMini"
                  title={ob(locale, 'form.removeModel')}
                  aria-label={ob(locale, 'form.removeModel')}
                  onClick={() => setModels(ms => ms.filter(x => x.id !== m.id))}
                >
                  <i className="codicon codicon-close" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="obActions">
        {onBack ? (
          <button type="button" className="obBtnSecondary" onClick={onBack}>
            {ob(locale, 'form.back')}
          </button>
        ) : (
          <span />
        )}
        <span className="obActionsRight">
          {!valid && <span className="obHint">{ob(locale, 'form.errRequired')}</span>}
          <button type="button" className="obBtnPrimary" disabled={!valid} onClick={submit}>
            {submitLabel}
          </button>
        </span>
      </div>
    </div>
  )
}
