const SDK = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async TypeScript function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped) — and \`description\`, a short summary of what the program does. Inside the program:

- Call tools as \`await tools.name(args)\`, e.g. \`await tools.read_file({ path: 'package.json' })\`. Every call resolves to the tool's JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool — \`try/catch\` it to handle and continue.
- Independent read-only calls (\`read_file\`, \`glob\`, \`grep\`) MAY overlap under \`Promise.all\`; mutating calls (\`write_file\`, \`edit_file\`, \`bash\`) run alone, in submission order. Sequence dependent work with \`await\`.
- Emit results with \`return\` and/or \`console.log(...)\`. Only what you print or return re-enters the conversation — every intermediate result stays out — so extract just what you need.
- Paths are workspace-relative; absolute paths are allowed. Keep programs small and focused.

\`\`\`ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface ToolArgsMap {
  /** Run a shell command in the workspace root. Returns { stdout, stderr, exitCode, timedOut }. */
  bash: { command: string; timeout_ms?: number };
  /** Exact-match replace. old_string must occur exactly once. Returns { path, add, del }. */
  edit_file: { path: string; old_string: string; new_string: string };
  /** Match files. glob supports **, *, ?, {a,b}. Returns { matches: string[] } (<=200). */
  glob: { pattern: string; path?: string };
  /** Substring search across files (case-sensitive). Returns { matches: { file, line, text }[] } (<=200). */
  grep: { query: string; glob?: string; path?: string };
  /** Read a text file. Returns { content, totalLines, startLine }. */
  read_file: { path: string; offset?: number; limit?: number };
  /** Create/overwrite a file (parent dirs auto-created). Returns { path, bytes }. */
  write_file: { path: string; content: string };
}
interface ToolOutputMap { [K in keyof ToolArgsMap]: JsonValue }
type ToolName = keyof ToolOutputMap

declare class ToolCallError extends Error {
  readonly name: "ToolCallError";
  readonly toolName: ToolName;
}
declare const tools: {
  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;
};
\`\`\``

export function buildSystemPrompt(ctx: { model: string; cwd: string; platform: NodeJS.Platform; date: string }): string {
  return [
    `You are a coding agent powered by ${ctx.model}. Your working directory is ${ctx.cwd} (${ctx.platform}). Today is ${ctx.date}.`,
    `Accomplish the user's task by writing one TypeScript program per step through run_code. Prefer few, well-targeted programs over many round trips. Finish with a concise summary in plain text when the task is done.`,
    SDK,
  ].join('\n\n')
}
