export type Protocol = 'openai' | 'anthropic' | 'gemini'
export type Quality = 'low' | 'medium' | 'high'
export type SessionPhase = 'idle' | 'submitting' | 'running' | 'awaiting_review' | 'completed' | 'error'
export type FileKind = 'js' | 'css' | 'html' | 'ts' | 'json' | 'md' | 'other'

export interface ModelInfo { id: string; label: string; supportsThinking: boolean }
export interface ProviderInfo { id: string; label: string; protocol: Protocol; baseUrl: string; models: ModelInfo[] }
export interface ActiveModel { providerId: string; modelId: string; quality: Quality }

/** 聊天图片附件：mime 如 image/png，base64 为不带前缀的裸编码（气泡与三协议请求体各自拼装） */
export interface ChatImage { mime: string; base64: string }

/** 各协议不支持的图片 mime（Gemini inlineData 不收 GIF）——host 与 webview 共用的单一事实来源，勿在两端各抄一份 */
export const PROTOCOL_BANNED_MIME: Partial<Record<Protocol, readonly string[]>> = { gemini: ['image/gif'] }

export interface QueuedMessage { id: string; text: string; images?: ChatImage[] }
export interface FileChangeSummary { path: string; add: number; del: number; kind: FileKind }
/** Task 26：rpc listSessions 的结果元素（host 侧 SessionStore.list() 摘要） */
export interface SessionSummary { sessionId: string; title: string; createdAt: number }

export interface TimelineEventBase { id: string; ts: number }
export type TimelineEvent =
  | TimelineEventBase & { type: 'user'; text: string; images?: ChatImage[] }   // 回合起点的用户原文（气泡重放还原；images 为可选缩略图附件）
  | TimelineEventBase & { type: 'explore'; status: 'running' | 'done'; count: number; targets: string[] }
  | TimelineEventBase & { type: 'edit'; file: string; fileKind: FileKind; add: number; del: number }
  | TimelineEventBase & { type: 'thought'; status: 'running' | 'done'; startedAt: number; durationMs?: number; markdown: string; working: string }
  | TimelineEventBase & { type: 'run'; command: string; status: 'running' | 'done' | 'error'; outputTail: string }
  | TimelineEventBase & { type: 'completion'; markdown: string }
  | TimelineEventBase & { type: 'error'; message: string }
  | TimelineEventBase & { type: 'compact'; markdown: string; before: number; after: number }   // /compact 压缩收尾：markdown=摘要，before/after=压缩前后历史字符规模

export type UiOp =
  | { op: 'append'; event: TimelineEvent }
  | { op: 'patch'; id: string; patch: Partial<TimelineEvent> & { type?: TimelineEvent['type'] } }  // patch 不得改 type/id
  | { op: 'remove'; id: string }   // I5：从时间线移除事件（tool_use 轮重置时撤下中间轮误建的 completion 气泡）
  | { op: 'phase'; phase: SessionPhase }
  | { op: 'changes'; changes: FileChangeSummary[] }
  | { op: 'queue'; queue: QueuedMessage[] }
  | { op: 'title'; title: string }
  | { op: 'replaceEvents'; events: TimelineEvent[] }   // /compact 整体替换时间线（勿复用 clear——会误清 queue 与 changes）
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
  | { type: 'submit'; text: string; images?: ChatImage[] }
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
  | { type: 'setLocale'; locale: 'en' | 'zh' }
  | { type: 'workbenchAction'; action: 'focusExplorer' | 'focusTerminal' | 'openFolder' | 'openBrowser' | 'toggleSidebar' }
  | { type: 'slashCommand'; command: 'compact' }
  | { type: 'rpc'; reqId: number; method: 'testProvider' | 'listModels' | 'listSessions'; params: { providerId: string; baseUrl?: string; protocol: Protocol } }

export type StreamEvent =
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; name: string; argsDelta: string; id?: string }   // id：适配器外传的真实调用 id（anthropic toolu_… / openai call_…），loop 采信后与 replay 信封配对
  | { type: 'message_done'; stopReason: 'tool_use' | 'end_turn' | 'max_tokens' | 'other'; usage?: { input: number; output: number } }
  /** C1/C2：协议原生回放信封（Anthropic blocks / Gemini parts）——适配器在流中原样累积，loop 存入 turn.replay */
  | { type: 'replay_envelope'; envelope: unknown }
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
      case 'remove': next.events = next.events.filter(e => e.id !== op.id); break
      case 'phase': next.phase = op.phase; break
      case 'changes': next.changes = op.changes; break
      case 'queue': next.queue = op.queue; break
      case 'title': next.title = op.title; break
      case 'replaceEvents': next.events = op.events; break
      case 'clear': next.events = []; next.queue = []; next.changes = []; break
    }
  }
  return next
}
