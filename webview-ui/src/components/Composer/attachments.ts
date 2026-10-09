import type { ChatImage, Protocol } from '@shared/protocol'
import { PROTOCOL_BANNED_MIME } from '@shared/protocol'

// 协议禁收 mime 表由 shared/protocol 单一事实来源提供（host 起轮兜底过滤同源）——两端各抄一份会漂移
export { PROTOCOL_BANNED_MIME }

/** 单条消息图片上限（超出拒绝并提示） */
export const IMAGE_LIMIT = 4
/** 降采样阈值：长边超过则等比缩到该值（Anthropic 建议 ≤1568，兼顾 token 与清晰度） */
export const IMAGE_MAX_EDGE = 1568

/** 按当前模型协议过滤附件：贴入后切换模型可能造成协议与附件错配，提交前兜底（L2） */
export function filterImagesForProtocol(images: ChatImage[], protocol: Protocol | undefined): { keep: ChatImage[]; dropped: ChatImage[] } {
  const banned = (protocol && PROTOCOL_BANNED_MIME[protocol]) ?? []
  if (banned.length === 0 || images.length === 0) return { keep: images, dropped: [] }
  const keep = images.filter(i => !banned.includes(i.mime))
  return { keep, dropped: images.filter(i => banned.includes(i.mime)) }
}

/** 等比缩到长边 ≤ max（已在界内返回原尺寸） */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const long = Math.max(width, height)
  if (long <= max) return { width, height }
  const scale = max / long
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** 大数组 → base64（btoa 分块拼接，避免 String.fromCharCode 一次展开爆栈） */
export function encodeBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** DOM 能力注入面：webview 注入 createImageBitmap/canvas 真实现，node 测试注入假实现 */
export interface AttachDeps {
  decode(blob: Blob): Promise<{ width: number; height: number }>
  /** 按目标尺寸重绘（透明通道保留，统一输出 image/png） */
  draw(blob: Blob, width: number, height: number): Promise<Blob>
}

export type AttachResult = { image: ChatImage } | { error: 'limit' | 'unsupported' }

const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Blob → ChatImage：超上限拒绝；长边超阈值等比降采样；小图原样直传。
 * decode 失败（损坏图/位图解码不支持）与 mime 不受支持统一降级为 unsupported。
 */
export async function fileToImage(blob: Blob, mime: string, currentCount: number, deps: AttachDeps): Promise<AttachResult> {
  if (currentCount >= IMAGE_LIMIT) return { error: 'limit' }
  if (!SUPPORTED.has(mime)) return { error: 'unsupported' }
  let source = blob
  let outMime = mime
  try {
    const { width, height } = await deps.decode(blob)
    const fit = fitWithin(width, height, IMAGE_MAX_EDGE)
    if (fit.width !== width || fit.height !== height) {
      source = await deps.draw(blob, fit.width, fit.height)
      outMime = 'image/png'
    }
  } catch {
    return { error: 'unsupported' }
  }
  return { image: { mime: outMime, base64: encodeBase64(await source.arrayBuffer()) } }
}
