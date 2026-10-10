import type { ProviderInfo, ActiveModel } from '../shared/protocol'

const K_KEYS = 'ptcAgent.keys', K_PROVIDERS = 'ptcAgent.providers', K_ACTIVE = 'ptcAgent.active', K_MODES = 'ptcAgent.thinkingModes', K_LOCALE = 'ptcAgent.locale'
type ThinkingMode = 'adaptive' | 'manual' | 'none'

export interface SecretsLike { store(k: string, v: string): Promise<void>; get(k: string): Promise<string | undefined>; delete(k: string): Promise<void> }
export interface MementoLike { get<T>(k: string, d?: T): T | undefined; update(k: string, v: unknown): Promise<void> }

export class ConfigStore {
  private lock: Promise<unknown> = Promise.resolve()
  constructor(private readonly secrets: SecretsLike, private readonly state: MementoLike) {}
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn)
    this.lock = next.catch(() => {})
    return next
  }
  private async readKeys(): Promise<Record<string, string>> {
    const raw = await this.secrets.get(K_KEYS)
    try { return raw ? JSON.parse(raw) : {} } catch { return {} }
  }
  private async writeKeys(keys: Record<string, string>): Promise<void> {
    await this.secrets.store(K_KEYS, JSON.stringify(keys))
  }
  async getProviders(): Promise<ProviderInfo[]> { return this.state.get<ProviderInfo[]>(K_PROVIDERS, []) ?? [] }
  async getActive(): Promise<ActiveModel | null> { return this.state.get<ActiveModel | null>(K_ACTIVE, null) ?? null }
  async setActive(a: ActiveModel): Promise<void> { await this.state.update(K_ACTIVE, a) }
  async saveProviders(providers: ProviderInfo[]): Promise<void> { await this.state.update(K_PROVIDERS, providers) }
  async getApiKey(id: string): Promise<string | undefined> { return (await this.readKeys())[id] }
  async saveApiKey(id: string, key: string): Promise<void> {
    await this.withLock(async () => { const keys = await this.readKeys(); keys[id] = key; await this.writeKeys(keys) })
  }
  async deleteProvider(id: string): Promise<void> {
    await this.withLock(async () => {
      const keys = await this.readKeys(); delete keys[id]; await this.writeKeys(keys)
      await this.state.update(K_PROVIDERS, (await this.getProviders()).filter(p => p.id !== id))
      const active = await this.getActive()
      if (active?.providerId === id) await this.state.update(K_ACTIVE, null)
    })
  }
  async getThinkingMode(p: string, m: string): Promise<ThinkingMode | undefined> {
    return this.state.get<Record<string, ThinkingMode>>(K_MODES, {})?.[`${p}/${m}`]
  }
  async setThinkingMode(p: string, m: string, mode: ThinkingMode): Promise<void> {
    const all = this.state.get<Record<string, ThinkingMode>>(K_MODES, {}) ?? {}
    all[`${p}/${m}`] = mode
    await this.state.update(K_MODES, all)
  }
  async getLocale(): Promise<'en' | 'zh' | undefined> {
    const v = this.state.get<string>(K_LOCALE)
    return v === 'en' || v === 'zh' ? v : undefined
  }
  async setLocale(l: 'en' | 'zh'): Promise<void> { await this.state.update(K_LOCALE, l) }
  async sanitized(): Promise<{ providers: ProviderInfo[]; keyed: Record<string, boolean>; active: ActiveModel | null }> {
    const keys = await this.readKeys()
    const providers = await this.getProviders()
    const keyed: Record<string, boolean> = {}
    for (const p of providers) {
      const k = keys[p.id]
      if (typeof k === 'string' && k.length > 0) keyed[p.id] = true   // 未配置密钥的 provider 不出现（缺席即 falsy）
    }
    return { providers, keyed, active: await this.getActive() }
  }
}
