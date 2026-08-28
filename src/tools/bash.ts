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
      // Windows 下 shell:true 的 child 是 shell 进程，kill() 不及孙进程：taskkill /T 按进程树击杀（timeout/abort 共用）
      const killTree = (): void => {
        if (process.platform === 'win32' && child.pid != null) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } else child.kill()
      }
      const timer = setTimeout(() => { timedOut = true; killTree() }, timeout_ms)
      child.stdout.on('data', (d: Buffer) => { stdout.push(d.toString('utf8')) })
      child.stderr.on('data', (d: Buffer) => { stderr.push(d.toString('utf8')) })
      child.on('error', e => { clearTimeout(timer); rejectP(new Error(`bash: ${e.message}`)) })
      child.on('close', exitCode => {
        clearTimeout(timer)
        resolveP({ stdout: stdout.result(), stderr: stderr.result(), exitCode: exitCode ?? -1, timedOut })
      })
      ctx.signal.addEventListener('abort', () => { timedOut = true; killTree() }, { once: true })
    })
  },
}
