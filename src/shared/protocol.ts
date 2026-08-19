export type Protocol = 'openai' | 'anthropic' | 'gemini'
export type Quality = 'low' | 'medium' | 'high'
export type SessionPhase = 'idle' | 'submitting' | 'running' | 'awaiting_review' | 'completed' | 'error'
export type FileKind = 'js' | 'css' | 'html' | 'ts' | 'json' | 'md' | 'other'

export interface ModelInfo { id: string; label: string; supportsThinking: boolean }
export interface ProviderInfo { id: string; label: string; protocol: Protocol; baseUrl: string; models: ModelInfo[] }
export interface ActiveModel { providerId: string; modelId: string; quality: Quality }

export interface QueuedMessage { id: string; text: string }
export interface FileChangeSummary { path: string; add: number; del: number; kind: FileKind }

export interface TimelineEventBase { id: string; ts: number }
export type TimelineEvent =
  | TimelineEventBase & { type: 'explore'; status: 'running' | 'done'; count: number; targets: string[] }
  | TimelineEventBase & { type: 'edit'; file: string; fileKind: FileKind; add: number; del: number }
  | TimelineEventBase & { type: 'thought'; status: 'running' | 'done'; startedAt: number; markdown: string; working: string }
  | TimelineEventBase & { type: 'run'; command: string; status: 'running' | 'done' | 'error'; outputTail: string }
  | TimelineEventBase & { type: 'completion'; markdown: string }
  | TimelineEventBase & { type: 'error'; message: string }

export type UiOp =
  | { op: 'append'; event: TimelineEvent }
  | { op: 'patch'; id: string; patch: Partial<TimelineEvent> & { type?: TimelineEvent['type'] } }  // patch 不得改 type/id
  | { op: 'phase'; phase: SessionPhase }
  | { op: 'changes'; changes: FileChangeSummary[] }
  | { op: 'queue'; queue: QueuedMessage[] }
  | { op: 'title'; title: string }
  | { op: 'clear' }

export interface WebviewState {   // boot/快照全量
  locale: string
  phase: SessionPhase
  title: string
  sessionId: string | null
  events: TimelineEvent[]
  queue: QueuedMessage[]
  changes: FileChangeSummary[]
  providers: ProviderInfo[]            // 不含密钥
  providerKeyed: Record<string, boolean>
  active: ActiveModel | null
  hasSessions: boolean
}

export type HostMessage =
  | { type: 'snapshot'; seq: number; state: WebviewState }
  | { type: 'ops'; seq: number; sessionId: string; ops: UiOp[] }
  | { type: 'rpcResult'; reqId: number; ok: boolean; result?: unknown; error?: string }

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'submit'; text: string }
  | { type: 'stop' }
  | { type: 'queueEdit'; id: string; text: string }
  | { type: 'queueDelete'; id: string }
  | { type: 'queueSubmitNow'; id: string }
  | { type: 'selectModel'; active: ActiveModel }
  | { type: 'newSession' }
  | { type: 'openSession'; sessionId: string }
  | { type: 'reviewFile'; path: string }
  | { type: 'reviewAccept'; path?: string }
  | { type: 'reviewReject'; path?: string }
  | { type: 'saveProviders'; providers: ProviderInfo[]; active: ActiveModel | null }
  | { type: 'saveApiKey'; providerId: string; apiKey: string }
  | { type: 'deleteProvider'; providerId: string }
  | { type: 'rpc'; reqId: number; method: 'testProvider' | 'listModels'; params: { providerId: string; baseUrl?: string; protocol: Protocol } }

export type StreamEvent =
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; name: string; argsDelta: string }
  | { type: 'message_done'; stopReason: 'tool_use' | 'end_turn' | 'max_tokens' | 'other'; usage?: { input: number; output: number } }
  | { type: 'stream_error'; kind: ProtocolErrorKind; message: string; retryAfterMs?: number }

export type ProtocolErrorKind = 'auth' | 'rateLimit' | 'network' | 'server' | 'invalidRequest' | 'aborted'

export function initialWebviewState(locale: string): WebviewState {
  return { locale, phase: 'idle', title: 'Agent', sessionId: null, events: [], queue: [],
    changes: [], providers: [], providerKeyed: {}, active: null, hasSessions: false }
}

export function applyUiOps(state: WebviewState, ops: UiOp[]): WebviewState {
  const next = { ...state }
  for (const op of ops) {
    switch (op.op) {
      case 'append': next.events = [...next.events, op.event]; break
      case 'patch':
        next.events = next.events.map(e => e.id === op.id ? { ...e, ...op.patch, id: e.id } as TimelineEvent : e); break
      case 'phase': next.phase = op.phase; break
      case 'changes': next.changes = op.changes; break
      case 'queue': next.queue = op.queue; break
      case 'title': next.title = op.title; break
      case 'clear': next.events = []; next.queue = []; next.changes = []; break
    }
  }
  return next
}
