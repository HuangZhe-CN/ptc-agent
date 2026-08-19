/** worker 端口消息类型（host ↔ worker 双向） */

export interface WorkerBootData { code: string; names: string[]; maxOutputBytes: number }

export type WorkerToHost =
  | { type: 'call'; id: number; name: string; args: unknown }
  | { type: 'log'; text: string }
  | { type: 'output-limit' }
  | { type: 'done'; value?: unknown; error?: { kind: 'exception' | 'invalid-output' | 'output-limit'; message: string } }

export type HostToWorker = { type: 'reply'; id: number; ok: boolean; value?: unknown; message?: string }
