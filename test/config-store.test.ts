import { describe, it, expect } from 'vitest'
import { ConfigStore } from '../src/service/configStore'

const makeMemory = () => {
  const secrets = new Map<string, string>(), state = new Map<string, unknown>()
  return {
    secrets: {
      store: async (k: string, v: string) => { secrets.set(k, v) },
      get: async (k: string) => secrets.get(k),
      delete: async (k: string) => { secrets.delete(k) },
    },
    memento: {
      get: <T,>(k: string, d?: T) => (state.has(k) ? state.get(k) as T : d),
      update: async (k: string, v: unknown) => { state.set(k, v) },
    },
    dump: () => ({ secrets, state }),
  }
}

describe('ConfigStore', () => {
  it('provider 增删改保留密钥映射；sanitized 不含明文', async () => {
    const m = makeMemory()
    const cs = new ConfigStore(m.secrets, m.memento)
    await cs.saveProviders([{ id: 'p1', label: 'P1', protocol: 'openai', baseUrl: 'https://x/v1', models: [{ id: 'm1', label: 'm1', supportsThinking: true }] }])
    await cs.saveApiKey('p1', 'sk-secret')
    await cs.saveProviders([{ id: 'p1', label: 'P1b', protocol: 'openai', baseUrl: 'https://x/v1', models: [] }, { id: 'p2', label: 'P2', protocol: 'gemini', baseUrl: 'https://y', models: [] }])
    expect(await cs.getApiKey('p1')).toBe('sk-secret')   // 改 provider 不丢 key
    const s = await cs.sanitized()
    expect(s.providers.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(s.keyed).toEqual({ p1: true })
    expect(JSON.stringify(s)).not.toContain('sk-secret')
    await cs.deleteProvider('p1')
    expect(await cs.getApiKey('p1')).toBeUndefined()
    expect((await cs.getProviders()).map(p => p.id)).toEqual(['p2'])
  })
  it('active 与 thinkingMode 读写', async () => {
    const m = makeMemory()
    const cs = new ConfigStore(m.secrets, m.memento)
    await cs.setActive({ providerId: 'p', modelId: 'm', quality: 'high' })
    expect(await cs.getActive()).toEqual({ providerId: 'p', modelId: 'm', quality: 'high' })
    await cs.setThinkingMode('p', 'm', 'manual')
    expect(await cs.getThinkingMode('p', 'm')).toBe('manual')
  })
  it('单 blob 写锁：并发 saveApiKey 不丢失更新', async () => {
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
    const secrets = new Map<string, string>()
    // 慢速后端：读在 1ms 后发生、写在 5ms 后落盘——若读改写未串行化，后写者会用旧快照覆盖前写者
    const slowSecrets = {
      store: async (k: string, v: string) => { await sleep(5); secrets.set(k, v) },
      get: async (k: string) => { await sleep(1); return secrets.get(k) },
      delete: async (k: string) => { await sleep(1); secrets.delete(k) },
    }
    const memento = {
      get: <T,>(_k: string, d?: T) => d,
      update: async (_k: string, _v: unknown) => {},
    }
    const cs = new ConfigStore(slowSecrets, memento)
    await Promise.all([
      cs.saveApiKey('a', 'k1'),
      cs.saveApiKey('b', 'k2'),
      cs.saveApiKey('c', 'k3'),
    ])
    const blob = JSON.parse(secrets.get('ptcAgent.keys')!) as Record<string, string>
    expect(blob).toEqual({ a: 'k1', b: 'k2', c: 'k3' })
    expect(await cs.getApiKey('b')).toBe('k2')
    expect(await cs.getApiKey('c')).toBe('k3')
  })
})
