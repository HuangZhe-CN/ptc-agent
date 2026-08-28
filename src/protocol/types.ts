import type { StreamEvent, ProviderInfo, Quality, ChatImage } from '../shared/protocol'

/** 模型历史（协议中立视图 + 协议原生回放信封） */
export type HistoryMessage =
  | { role: 'user'; text: string; images?: ChatImage[] }
  | { role: 'assistant'; turn: AssistantTurn }
  | { role: 'toolResult'; callId: string; content: string; isError: boolean }

export interface AssistantTurn {
  thinking?: string
  text: string
  toolCall?: { callId: string; name: string; args: { code: string; description: string } }
  /** 协议原生块，适配器回放时原样使用（Anthropic thinking/signature、Gemini thoughtSignature、OpenAI 系 reasoning_content） */
  replay?: unknown
}

export interface ResolvedProvider {
  info: ProviderInfo
  apiKey: string
  modelId: string
  quality: Quality
  /** Anthropic thinking 参数解析结果缓存（'adaptive' | 'manual' | 'none'），由适配器读写 */
  thinkingMode?: 'adaptive' | 'manual' | 'none'
}

export interface StreamRequest { system: string; history: HistoryMessage[]; provider: ResolvedProvider; signal: AbortSignal }

export interface ProtocolAdapter {
  readonly protocol: 'openai' | 'anthropic' | 'gemini'
  /** 注入 fetch 便于测试（默认全局 fetch） */
  stream(req: StreamRequest, fetchImpl?: typeof fetch): AsyncIterable<StreamEvent>
}
