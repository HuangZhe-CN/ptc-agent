import React, { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { useAgentStore } from '../../store'
import { t } from '../../i18n'
import { ModelTrigger } from './ModelTrigger'
import { QueuePanel } from '../Floaters/QueuePanel'
import { fileToImage, filterImagesForProtocol, IMAGE_LIMIT, type AttachDeps } from './attachments'
import type { ChatImage } from '@shared/protocol'

/** webview 真实现：createImageBitmap 取尺寸/重绘 + canvas 输出 png（透明通道保留） */
const domAttachDeps: AttachDeps = {
  decode: async blob => {
    const bmp = await createImageBitmap(blob)
    const size = { width: bmp.width, height: bmp.height }
    bmp.close()
    return size
  },
  draw: async (blob, width, height) => {
    const bmp = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, width, height)
    bmp.close()
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png'))
  },
}

/** 附件提示自动消退（3s） */
const NOTICE_MS = 3000

/**
 * 设计稿 §07/§12 Composer：
 * - 圆角 capture ≈22–26（382w 11–13）→ calc(var(--scale) * 26px)
 * - 高 capture ≈118–120（382w 59–60）→ calc(var(--scale) * 120px)
 * - 底部左：＋（图片附件入口）/ 模型名 / quality / chevron（ModelTrigger；popover 由 Task 24 接管）
 * - 右主按钮（§12.2 状态机）：idle|completed=send 圆钮（primary token）；
 *   running=Stop 方块 glyph（--agent-error）置于浅色圆底，外圆容器不变，
 *   80–120ms cross-fade（§15）
 * - Enter 发送 / Shift+Enter 换行；running 时 Enter 仍发 submit（host 负责入队）；
 *   中文输入法组词期 Enter 不触发（isComposing 守卫）
 * - Task 24：顶部挂 QueuePanel（§11 队列卡位于 Composer 正上方、同宽，
 *   流式占位由 .composerWrap 承担——queue 为空时组件返回 null，不留间隙）
 * - 图片附件：textarea onPaste（clipboardData 里的 image 文件）与 ＋ 按钮文件选择；
 *   缩略图 chip 可删除，上限/降采样见 attachments.ts；纯图无文本也可发送
 */
export function Composer(): JSX.Element {
  const phase = useAgentStore(s => s.phase)
  const send = useAgentStore(s => s.send)
  const locale = useAgentStore(s => s.locale)
  const active = useAgentStore(s => s.active)
  const providers = useAgentStore(s => s.providers)
  const [text, setText] = useState('')
  const [images, setImages] = useState<ChatImage[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // images 的 ref 镜像：异步 decode 窗口内二次粘贴/删除也能按最新计数判限（L1 竞态修复）。
  // next 在调用点即刻写入 ref，而非塞进 React updater 等 render 执行（render 排期可能是宏任务）——
  // 附件串行链（addChainRef）的后批在微任务里续跑，等不到 render 就要读最新计数
  const imagesRef = useRef<ChatImage[]>([])
  const setImagesSync = (updater: (cur: ChatImage[]) => ChatImage[]): void => {
    const next = updater(imagesRef.current)
    imagesRef.current = next
    setImages(() => next)
  }
  // 附件批次串行链（L1 补完）：onPaste/文件选择对 addFiles 是 fire-and-forget，若两批重叠，
  // 后批会在前批的 await decode 窗口内读到同一旧计数基线、各自放行至 IMAGE_LIMIT——
  // 入队串行后批间不重叠，批首 imagesRef 恒为最新；catch 防个别批次异常断链
  const addChainRef = useRef<Promise<void>>(Promise.resolve())

  const running = phase === 'running' || phase === 'submitting'

  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(id)
  }, [notice])

  /** 批量接图：串行保持顺序；超限/不支持给出一次性提示（不中断整批中已合格的图） */
  const doAddFiles = async (files: File[]): Promise<void> => {
    let count = imagesRef.current.length
    const next: ChatImage[] = []
    let limited = false
    let unsupported = false
    for (const f of files) {
      const r = await fileToImage(f, f.type, count, domAttachDeps)
      if ('image' in r) { next.push(r.image); count++ }
      else if (r.error === 'limit') limited = true
      else unsupported = true
    }
    if (next.length > 0) setImagesSync(cur => [...cur, ...next])
    if (limited) setNotice(t(locale, 'composer.imageLimit'))
    else if (unsupported) setNotice(t(locale, 'composer.imageUnsupported'))
  }

  /** 附件批次入口：入队串行执行（见 addChainRef 注释），保证并发批次判限基线不重叠 */
  const addFiles = (files: File[]): void => {
    addChainRef.current = addChainRef.current.then(() => doAddFiles(files)).catch(() => {})
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData.items)
      .filter(it => it.kind === 'file' && it.type.startsWith('image/'))
      .map(it => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length > 0) {
      e.preventDefault()   // 拦截位图粘贴的占位文本/文件名落入输入框
      void addFiles(files)
    }
  }

  const doSubmit = (): void => {
    const value = text.trim()
    if (!value && images.length === 0) return
    // 斜杠命令拦截：trim 后精确等于 /compact 时交 host 执行压缩，不作为普通消息发给模型
    //（随行图片存在时不拦截——按普通消息发送，避免静默丢弃附件）
    if (value === '/compact' && images.length === 0) {
      send({ type: 'slashCommand', command: 'compact' })
      setText('')
      return
    }
    // 协议×mime 兜底过滤（L2）：贴入后切换模型可能造成协议与附件错配（如 Gemini 不收 GIF）；
    // 数量双保险：串行链之外的任何未来路径泄漏的超限附件在发送前最后一刻截断
    const bounded = images.slice(0, IMAGE_LIMIT)
    const protocol = providers.find(p => p.id === active?.providerId)?.protocol
    const { keep, dropped } = filterImagesForProtocol(bounded, protocol)
    if (!value && keep.length === 0) {
      // 纯图消息但附件全被协议滤掉：不发送，保留附件让用户自行处理
      setNotice(t(locale, 'composer.imageDropped'))
      return
    }
    // 无图时 keep 为空不带 images 字段——host/协议层无图路径与既有行为逐字节一致
    send({ type: 'submit', text: value, ...(keep.length > 0 ? { images: keep } : {}) })   // running 时同样照发——host 判定入队
    if (dropped.length > 0) setNotice(t(locale, 'composer.imageDropped'))
    setText('')
    setImagesSync(() => [])
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      doSubmit()
    }
  }

  const actionLabel = running ? t(locale, 'composer.stop') : t(locale, 'composer.send')

  return (
    <div className="composerWrap">
      <QueuePanel />
      <div className="composer">
        <textarea
          className="composerInput"
          value={text}
          rows={1}
          spellCheck={false}
          placeholder={t(locale, 'composer.placeholder')}
          aria-label={t(locale, 'composer.placeholder')}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {(images.length > 0 || notice) && (
          <div className="attachStrip">
            {images.map((img, i) => (
              <span className="attachChip" key={i}>
                <img src={`data:${img.mime};base64,${img.base64}`} alt="" draggable={false} />
                <button
                  type="button"
                  className="attachRemove"
                  aria-label={t(locale, 'composer.removeImage')}
                  onClick={() => setImagesSync(cur => cur.filter((_, j) => j !== i))}
                >
                  <i className="codicon codicon-close" aria-hidden="true" />
                </button>
              </span>
            ))}
            {notice && <span className="attachNotice" role="status">{notice}</span>}
          </div>
        )}
        <div className="composerActions">
          <div className="composerLeft">
            {/* ＋ 图片附件：唤起文件选择（多选；上限/降采样在 attachments.ts） */}
            <button
              type="button"
              className="iconButton"
              aria-label={t(locale, 'composer.addImage')}
              title={t(locale, 'composer.addImage')}
              onClick={() => fileInputRef.current?.click()}
            >
              <i className="codicon codicon-add" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={e => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''   // 同一批文件可重复选择
                if (files.length > 0) void addFiles(files)
              }}
            />
            <ModelTrigger />
          </div>
          <button
            type="button"
            className={running ? 'primaryAction running' : 'primaryAction'}
            disabled={!running && !text.trim() && images.length === 0}
            aria-label={actionLabel}
            title={actionLabel}
            onClick={() => (running ? send({ type: 'stop' }) : doSubmit())}
          >
            {/* 两个 glyph 常驻 DOM，靠 opacity cross-fade；外圆尺寸不变（§15） */}
            <i className="codicon codicon-send primaryGlyph" aria-hidden="true" />
            <i className="codicon codicon-debug-stop primaryGlyph stopGlyph" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
