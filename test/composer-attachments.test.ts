import { describe, it, expect } from 'vitest'
import { IMAGE_LIMIT, IMAGE_MAX_EDGE, fitWithin, encodeBase64, fileToImage, filterImagesForProtocol, type AttachDeps } from '../webview-ui/src/components/Composer/attachments'
import type { ChatImage } from '../src/shared/protocol'

/** 假 DOM 依赖：记录调用、返回可控尺寸/重绘结果（node 环境无 createImageBitmap/canvas） */
const fakeDeps = (size: { width: number; height: number }, redrawn = 'image/png'): {
  deps: AttachDeps
  draws: Array<{ width: number; height: number }>
} => {
  const draws: Array<{ width: number; height: number }> = []
  return {
    draws,
    deps: {
      decode: async () => size,
      draw: async (blob, width, height) => {
        draws.push({ width, height })
        return new Blob([await blob.arrayBuffer()], { type: redrawn })
      },
    },
  }
}

describe('fitWithin（降采样目标尺寸）', () => {
  it('长边超阈值等比缩到阈值；界内原样', () => {
    expect(fitWithin(3136, 1568, IMAGE_MAX_EDGE)).toEqual({ width: 1568, height: 784 })
    expect(fitWithin(1568, 3136, IMAGE_MAX_EDGE)).toEqual({ width: 784, height: 1568 })
    expect(fitWithin(800, 600, IMAGE_MAX_EDGE)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(1568, 1568, IMAGE_MAX_EDGE)).toEqual({ width: 1568, height: 1568 })   // 恰好等于阈值不缩
  })
})

describe('encodeBase64', () => {
  it('字节序列 → 标准 base64', () => {
    expect(encodeBase64(new Uint8Array([0, 1, 2]).buffer)).toBe('AAEC')
    expect(encodeBase64(new TextEncoder().encode('hello').buffer)).toBe(btoa('hello'))
  })
})

describe('fileToImage（Composer 附件管线决策）', () => {
  it('小图原样直传：不触发重绘、保留原 mime、base64 正确', async () => {
    const blob = new Blob([new Uint8Array([0, 1, 2])], { type: 'image/png' })
    const { deps, draws } = fakeDeps({ width: 800, height: 600 })
    const r = await fileToImage(blob, 'image/png', 0, deps)
    expect(r).toEqual({ image: { mime: 'image/png', base64: 'AAEC' } })
    expect(draws).toEqual([])   // 界内不重绘
  })
  it('大图降采样：按长边 1568 等比重绘并转 png', async () => {
    const blob = new Blob([new Uint8Array([0, 1, 2])], { type: 'image/jpeg' })
    const { deps, draws } = fakeDeps({ width: 4000, height: 2000 })
    const r = await fileToImage(blob, 'image/jpeg', 0, deps)
    expect(r).toEqual({ image: { mime: 'image/png', base64: 'AAEC' } })   // 重绘输出 png
    expect(draws).toEqual([{ width: 1568, height: 784 }])   // 等比、长边钳制在阈值
  })
  it(`已附 ${IMAGE_LIMIT} 张时拒绝（limit）；不支持的 mime 拒绝（unsupported）`, async () => {
    const blob = new Blob([new Uint8Array([0, 1, 2])], { type: 'image/png' })
    const { deps } = fakeDeps({ width: 10, height: 10 })
    expect(await fileToImage(blob, 'image/png', IMAGE_LIMIT, deps)).toEqual({ error: 'limit' })
    expect(await fileToImage(blob, 'image/bmp', 0, deps)).toEqual({ error: 'unsupported' })
    expect(await fileToImage(blob, 'text/plain', 0, deps)).toEqual({ error: 'unsupported' })
  })
  it('decode 抛错（损坏图）降级 unsupported，不向外抛', async () => {
    const blob = new Blob([new Uint8Array([0, 1, 2])], { type: 'image/png' })
    const deps: AttachDeps = { decode: async () => { throw new Error('corrupt') }, draw: async () => { throw new Error('never') } }
    expect(await fileToImage(blob, 'image/png', 0, deps)).toEqual({ error: 'unsupported' })
  })
})

describe('filterImagesForProtocol（协议×mime 提交兜底过滤，L2）', () => {
  const png: ChatImage = { mime: 'image/png', base64: 'aGk=' }
  const gif: ChatImage = { mime: 'image/gif', base64: 'aGk=' }

  it('gemini 丢弃 gif 保留其余；openai/anthropic/未选模型全保留', () => {
    expect(filterImagesForProtocol([png, gif], 'gemini')).toEqual({ keep: [png], dropped: [gif] })
    expect(filterImagesForProtocol([gif, png], 'openai')).toEqual({ keep: [gif, png], dropped: [] })
    expect(filterImagesForProtocol([gif], 'anthropic')).toEqual({ keep: [gif], dropped: [] })
    expect(filterImagesForProtocol([gif], undefined)).toEqual({ keep: [gif], dropped: [] })
  })

  it('空数组直通返回原引用（零拷贝快路径）', () => {
    const empty: ChatImage[] = []
    const r = filterImagesForProtocol(empty, 'gemini')
    expect(r.keep).toBe(empty)
    expect(r.dropped).toEqual([])
  })
})
