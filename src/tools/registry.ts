import { readFileTool, writeFileTool, editFileTool } from './fs'
import { bashTool } from './bash'
import { globTool, grepTool } from './search'

export interface ToolContext { cwd: string; signal: AbortSignal }
export interface ToolDef {
  name: string
  concurrencySafe: boolean
  /** 失败一律 throw Error（桥接为程序内拒绝） */
  execute(args: unknown, ctx: ToolContext): Promise<unknown>
}

export function createTools(): Map<string, ToolDef> {
  const tools = [readFileTool, writeFileTool, editFileTool, bashTool, globTool, grepTool]
  return new Map<string, ToolDef>(tools.map(t => [t.name, t] as const))
}
