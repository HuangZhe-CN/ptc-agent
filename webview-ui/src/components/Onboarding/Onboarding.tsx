import React, { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '../../store'
import type { ActiveModel, ModelInfo, ProviderInfo, Protocol, Quality } from '@shared/protocol'
import { ProviderForm, DEFAULT_BASE_URL, type ProviderDraft } from './ProviderForm'
import { ob } from './onboardingText'
import './onboarding.css'

const PROTOCOLS: Protocol[] = ['openai', 'anthropic', 'gemini']

/** provider id：label slug + 时间/随机短后缀（本地生成，host 落盘前保证不与现有冲突即可） */
function makeProviderId(label: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'provider'
  return `${slug}-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`
}

/**
 * Task 25 首启向导（计划：providers.length===0 && !active 时渲染于 Timeline 位置）。
 * 已有 provider 时自动转管理视图；Task 26 负责 Timeline 占位挂接与 Header more 入口。
 */
export function Onboarding(): JSX.Element {
  const hasProviders = useAgentStore(s => s.providers.length > 0)
  return hasProviders ? <ProviderManager /> : <ProviderWizard />
}

/** 步骤 1–3 向导；也被 ProviderManager 的「添加服务」复用（已有 active 时跳过步骤 3） */
function ProviderWizard({ onDone }: { onDone?: () => void }): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const send = useAgentStore(s => s.send)
  const providers = useAgentStore(s => s.providers)
  const storeActive = useAgentStore(s => s.active)

  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [protocol, setProtocol] = useState<Protocol | null>(null)
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  /** 已提交过的步骤 2 内容（回填「上一步」再进入；不含 apiKey——密钥不回填） */
  const [kept, setKept] = useState<{ protocol: Protocol; label: string; baseUrl: string; models: ModelInfo[] } | null>(null)
  const [activePick, setActivePick] = useState<{ modelId: string; quality: Quality } | null>(null)

  const needActive = !storeActive // 管理流新增且已有 active：保留原 active，跳过步骤 3

  const finalize = (proto: Protocol, d: ProviderDraft, pick: { modelId: string; quality: Quality } | null): void => {
    const provider: ProviderInfo = {
      id: makeProviderId(d.label),
      label: d.label,
      protocol: proto,
      baseUrl: d.baseUrl,
      models: d.models,
    }
    const nextActive: ActiveModel | null = pick
      ? { providerId: provider.id, modelId: pick.modelId, quality: pick.quality }
      : storeActive
    // 完成时依次 saveProviders / saveApiKey（后者仅当填写了密钥；本地网关可空）
    send({ type: 'saveProviders', providers: [...providers, provider], active: nextActive })
    if (d.apiKey) send({ type: 'saveApiKey', providerId: provider.id, apiKey: d.apiKey })
    setDraft(prev => (prev ? { ...prev, apiKey: '' } : prev)) // 密钥用后即弃
    onDone?.()
  }

  if (step === 1) {
    return (
      <div className="obRoot">
        <div className="obHead">
          <span className="obStepBadge">{ob(locale, 'wizard.step', { n: 1 })}</span>
          <h2 className="obTitle">{ob(locale, 'wizard.title')}</h2>
          <p className="obHint">{ob(locale, 'wizard.subtitle')}</p>
        </div>
        <p className="obHint">{ob(locale, 'step1.desc')}</p>
        <div className="obCards">
          {PROTOCOLS.map(p => (
            <button
              key={p}
              type="button"
              className="obCard"
              onClick={() => {
                setProtocol(p)
                setStep(2)
              }}
            >
              <span className="obProtoName">{ob(locale, `proto.${p}`)}</span>
              <span className="obProtoDesc">{ob(locale, `proto.${p}.desc`)}</span>
              <span className="obProtoUrl">{DEFAULT_BASE_URL[p]}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (step === 2 && protocol) {
    return (
      <div className="obRoot">
        <div className="obHead">
          <span className="obStepBadge">{ob(locale, 'wizard.step', { n: 2 })}</span>
          <h2 className="obTitle">{ob(locale, 'step2.title')}</h2>
        </div>
        <ProviderForm
          key={protocol}
          protocol={protocol}
          locale={locale}
          initial={
            kept && kept.protocol === protocol
              ? { label: kept.label, baseUrl: kept.baseUrl, models: kept.models }
              : undefined
          }
          submitLabel={ob(locale, needActive ? 'form.next' : 'form.save')}
          onBack={() => setStep(1)}
          onSubmit={d => {
            setDraft(d)
            setKept({ protocol, label: d.label, baseUrl: d.baseUrl, models: d.models })
            if (needActive && d.models.length > 0) {
              setActivePick({ modelId: d.models[0].id, quality: 'medium' })
              setStep(3)
            } else {
              finalize(protocol, d, null)
            }
          }}
        />
      </div>
    )
  }

  // step 3：选 active 模型 + quality
  return (
    <div className="obRoot">
      <div className="obHead">
        <span className="obStepBadge">{ob(locale, 'wizard.step', { n: 3 })}</span>
        <h2 className="obTitle">{ob(locale, 'step3.title')}</h2>
      </div>
      <div className="obField">
        <span className="obFieldLabel">{ob(locale, 'step3.model')}</span>
        <div className="obRadioList" role="radiogroup" aria-label={ob(locale, 'step3.model')}>
          {(draft?.models ?? []).map(m => (
            <label key={m.id} className="obCheckRow">
              <input
                type="radio"
                name="ob-active-model"
                checked={activePick?.modelId === m.id}
                onChange={() =>
                  setActivePick(prev =>
                    prev ? { ...prev, modelId: m.id } : { modelId: m.id, quality: 'medium' },
                  )
                }
              />
              <span className="obModelId" title={m.id}>
                {m.id}
              </span>
              {m.label !== m.id && <span className="obTag">{m.label}</span>}
              {m.supportsThinking && <span className="obTag">{ob(locale, 'tag.thinking')}</span>}
            </label>
          ))}
        </div>
      </div>
      <div className="obField">
        <span className="obFieldLabel">{ob(locale, 'step3.quality')}</span>
        <QualitySeg
          locale={locale}
          value={activePick?.quality ?? 'medium'}
          onChange={q =>
            setActivePick(prev => ({
              modelId: prev?.modelId ?? draft?.models[0]?.id ?? '',
              quality: q,
            }))
          }
        />
        <span className="obHint">{ob(locale, 'step3.qualityHint')}</span>
      </div>
      <div className="obActions">
        <button
          type="button"
          className="obBtnSecondary"
          onClick={() => (protocol ? setStep(2) : setStep(1))}
        >
          {ob(locale, 'form.back')}
        </button>
        <button
          type="button"
          className="obBtnPrimary"
          disabled={!activePick || !protocol || !draft}
          onClick={() => {
            if (protocol && draft && activePick) finalize(protocol, draft, activePick)
          }}
        >
          {ob(locale, 'step3.finish')}
        </button>
      </div>
    </div>
  )
}

function QualitySeg(props: { locale: string; value: Quality; onChange: (q: Quality) => void }): JSX.Element {
  const opts: Quality[] = ['low', 'medium', 'high']
  return (
    <div className="obQualitySeg" role="radiogroup">
      {opts.map(q => (
        <button
          key={q}
          type="button"
          role="radio"
          aria-checked={props.value === q}
          className={`obQualityOpt${props.value === q ? ' on' : ''}`}
          onClick={() => props.onChange(q)}
        >
          {ob(props.locale, `quality.${q}`)}
        </button>
      ))}
    </div>
  )
}

/**
 * Provider 管理视图（计划 Task 25「Header more 下拉」的目标组件；Task 26 挂接）。
 * 列出 state.providers + keyed 状态；添加（复用三步向导）；删除（两击确认 → deleteProvider）。
 */
export function ProviderManager(): JSX.Element {
  const locale = useAgentStore(s => s.locale)
  const providers = useAgentStore(s => s.providers)
  const providerKeyed = useAgentStore(s => s.providerKeyed)
  const active = useAgentStore(s => s.active)
  const send = useAgentStore(s => s.send)

  const [adding, setAdding] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => () => { if (timerRef.current !== undefined) window.clearTimeout(timerRef.current) }, [])

  if (adding) return <ProviderWizard onDone={() => setAdding(false)} />

  return (
    <div className="obRoot">
      <h2 className="obTitle">{ob(locale, 'manage.title')}</h2>
      {providers.length === 0 && <p className="obHint">{ob(locale, 'manage.empty')}</p>}
      <div className="obProvList">
        {providers.map(p => {
          const keyed = providerKeyed[p.id] === true
          return (
            <div key={p.id} className="obProvRow">
              <div className="obProvMain">
                <div className="obProvLabel">
                  <span className="obProvLabelText">{p.label}</span>
                  {active?.providerId === p.id && <span className="obTag">{ob(locale, 'manage.active')}</span>}
                </div>
                <div className="obProvMeta" title={`${p.baseUrl} · ${p.models.map(m => m.id).join(', ')}`}>
                  {ob(locale, `proto.${p.protocol}`)} · {p.baseUrl} ·{' '}
                  {ob(locale, 'manage.modelsCount', { n: p.models.length })}
                </div>
                <span className={`obKeyState${keyed ? ' ok' : ' missing'}`}>
                  <i className={`codicon ${keyed ? 'codicon-key' : 'codicon-warning'}`} aria-hidden="true" />
                  {ob(locale, keyed ? 'manage.keyed' : 'manage.nokey')}
                </span>
              </div>
              {confirmId === p.id ? (
                <button
                  type="button"
                  className="obBtnSecondary obBtnDanger obDeleteBtn"
                  title={ob(locale, 'manage.confirmDelete')}
                  onClick={() => {
                    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
                    setConfirmId(null)
                    send({ type: 'deleteProvider', providerId: p.id })
                  }}
                >
                  {ob(locale, 'manage.confirmDelete')}
                </button>
              ) : (
                <button
                  type="button"
                  className="obIconMini obDeleteBtn"
                  title={ob(locale, 'manage.delete')}
                  aria-label={ob(locale, 'manage.delete')}
                  onClick={() => {
                    setConfirmId(p.id)
                    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
                    timerRef.current = window.setTimeout(() => setConfirmId(null), 3000)
                  }}
                >
                  <i className="codicon codicon-trash" aria-hidden="true" />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <button type="button" className="obBtnSecondary obAddBtn" onClick={() => setAdding(true)}>
        <i className="codicon codicon-add" aria-hidden="true" />
        {ob(locale, 'manage.add')}
      </button>
    </div>
  )
}
