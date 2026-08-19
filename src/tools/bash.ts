import { spawn } from 'node:child_process'
import type { ToolDef } from './registry'

const CAP = 32 * 1024
const keepHeadTail = (s: string): string =>
  s.length <= CAP * 2 ? s : `${s.slice(0, CAP)}\n…[truncated ${s.length - CAP * 2} bytes]…\n${s.slice(-CAP)}`

export const bashTool: ToolDef = {
  name: 'bash', concurrencySafe: false,
  execute(args, ctx) {
    const { command, timeout_ms = 120_000 } = args as { command: string; timeout_ms?: number }
    return new Promise((resolveP, rejectP) => {
      const child = spawn(command, { shell: true, cwd: ctx.cwd, env: process.env })
      let stdout = '', stderr = '', timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout_ms)
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      child.on('error', e => { clearTimeout(timer); rejectP(new Error(`bash: ${e.message}`)) })
      child.on('close', exitCode => {
        clearTimeout(timer)
        resolveP({ stdout: keepHeadTail(stdout), stderr: keepHeadTail(stderr), exitCode: exitCode ?? -1, timedOut })
      })
      ctx.signal.addEventListener('abort', () => { timedOut = true; child.kill() }, { once: true })
    })
  },
}
