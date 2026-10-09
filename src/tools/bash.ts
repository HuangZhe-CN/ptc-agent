import { spawn } from 'node:child_process'
import type { ToolDef } from './registry'

const CAP = 32 * 1024

/** 滚动封顶累积器：驻留内存最多头/尾各 CAP 字符，中段只计数字节（防失控命令输出撑爆扩展宿主内存）。
 *  close 时 result() 与旧 keepHeadTail 同形：未丢中段返回全文，超限返回 头CAP + 截断标注 + 尾CAP。 */
export class CappedBuffer {
  private head = ''
  private tail: string[] = []
  private tailLen = 0
  private total = 0
  push(chunk: string): void {
    this.total += chunk.length
    if (this.head.length < CAP) {
      this.head += chunk
      if (this.head.length > CAP) {
        const overflow = this.head.slice(CAP)
        this.head = this.head.slice(0, CAP)
        this.pushTail(overflow)
      }
      return
    }
    this.pushTail(chunk)
  }
  private pushTail(s: string): void {
    this.tail.push(s)
    this.tailLen += s.length
    while (this.tailLen > CAP && this.tail.length > 1) this.tailLen -= this.tail.shift()!.length
    if (this.tailLen > CAP && this.tail.length === 1) {
      const keep = this.tail[0].slice(-CAP)
      this.tailLen = keep.length
      this.tail[0] = keep
    }
  }
  result(): string {
    const dropped = this.total - this.head.length - this.tailLen
    if (dropped <= 0) return this.head + this.tail.join('')
    return `${this.head}\n…[truncated ${dropped} bytes]…\n${this.tail.join('')}`
  }
}

export const bashTool: ToolDef = {
  name: 'bash', concurrencySafe: false,
  execute(args, ctx) {
    const { command, timeout_ms = 120_000 } = args as { command: string; timeout_ms?: number }
    return new Promise((resolveP, rejectP) => {
      const child = spawn(command, { shell: true, cwd: ctx.cwd, env: process.env })
      const stdout = new CappedBuffer()
      const stderr = new CappedBuffer()
      let timedOut = false
      // Windows 下 shell:true 的 child 是 shell 进程，kill() 不及孙进程：taskkill /T 按进程树击杀（timeout/abort 共用）。
      // 存活守卫：子进程已退出（exitCode/signalCode 必有其一非 null）即跳过——此后 PID 可能已被无关进程
      // 复用，无守卫的 taskkill /F 会强杀整棵无关进程树（回合级 signal 在回合结束才 abort，窗口可达分钟级）
      const killTree = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return
        if (process.platform === 'win32' && child.pid != null) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } else child.kill()
      }
      const timer = setTimeout(() => { timedOut = true; killTree() }, timeout_ms)
      // 回合级 signal 上挂具名监听，close/error 时摘除：不摘除则本回合后续任意 abort 都会对陈旧 PID 补一发 taskkill
      const onAbort = (): void => { timedOut = true; killTree() }
      // 流设 utf8 编码：Node 内部经 StringDecoder 拼装跨 chunk 的多字节字符（中文/emoji 输出不再在 data 边界拆出 U+FFFD）
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (s: string) => { stdout.push(s) })
      child.stderr.on('data', (s: string) => { stderr.push(s) })
      const detach = (): void => { clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort) }
      child.on('error', e => { detach(); rejectP(new Error(`bash: ${e.message}`)) })
      child.on('close', exitCode => {
        detach()
        resolveP({ stdout: stdout.result(), stderr: stderr.result(), exitCode: exitCode ?? -1, timedOut })
      })
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    })
  },
}
