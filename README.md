# PTC Agent (Pure-Then-Code)

English | [简体中文](README.zh-CN.md)

A minimal, fast coding agent for VS Code. The core mechanism of PTC/Code mode: instead of calling tools one by one, the model writes a TypeScript program and executes it in a sandboxed worker thread via the built-in `run_code` tool. Inside the program it can call tool functions such as read file, write file, bash, and search. When execution finishes, **only the program's return value and console.log output are fed back into the model context** — the context stays lean, so intermediate steps of long tasks never blow up the token budget.

- **Pure**: the model thinks, plans, and explores first (read/glob/grep are read-only)
- **Then Code**: one generated program batch-completes the edits and command executions
- **Snapshot Review**: all file changes land in snapshots first — Accept keeps them, Reject restores with one click

## System Requirements

| Item | Requirement |
| --- | --- |
| VS Code | ≥ 1.101.0 (the worker runtime depends on the Node 22 built into the extension host) |
| OS | Windows / macOS / Linux |

> Note: the worker thread uses the Node runtime built into the VS Code extension host, which requires VS Code 1.101+ (Node 22). On older versions the worker fails to start.

## Installation

### Option 1: Install the .vsix

```bash
code --install-extension ptc-agent-<version>.vsix   # version = the version field in the root package.json; release artifacts are ptc-agent-x.y.z.vsix in the repo root
```

### Option 2: Run from source (F5 debugging)

```bash
npm install          # root dependencies (includes the webview-ui workspace)
npm run build        # fetch codicons + esbuild the extension host + vite build the webview
```

Open this project in VS Code and press F5 to launch the Extension Development Host. When the PTC Agent icon appears in the left activity bar, it is running.

## First Run: Three-Step Setup Wizard

The first time you open the PTC Agent view, a setup wizard appears. Everything happens in the UI — no config file editing required:

1. **Choose a protocol** — OpenAI-compatible / Anthropic / Gemini, pick one of the three;
2. **Fill in baseURL and API key** — the form pre-fills each protocol's official default baseURL (see the table below). Keys are stored via VS Code SecretStorage and never written into the workspace. The OpenAI-compatible protocol supports "fetch model list" to pull the model catalog online; Anthropic / Gemini have no standard list endpoint, so add models manually;
3. **Choose a model** — pick the default model from the ones you have added and select a quality tier (low / medium / high).

Once the three steps are done, submit tasks from the input box. You can switch model / quality tier anytime via the model-switcher popover, or add and remove services on the settings management page.

## Language

The UI defaults to English. Activity bar → PTC Agent → the manage icon at the top opens the settings management page, where the "Interface Language" section switches between Chinese and English — effective immediately and persisted.

## Protocol Support

| Protocol | Default baseURL | Applicable services |
| --- | --- | --- |
| OpenAI-compatible | `https://api.openai.com/v1` | Official OpenAI and any service compatible with `/chat/completions` (DeepSeek, vLLM, OneAPI gateways, etc.) |
| Anthropic | `https://api.anthropic.com` | Official Claude-family APIs and gateways compatible with `/v1/messages` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | Official Google Gemini-family APIs |

Configuration example (self-hosted OpenAI-compatible gateway): choose "OpenAI-compatible" as the protocol, set baseURL to `https://your-gateway.example.com/v1`, fill in the key issued by the gateway, add a model, and you are ready to go.

### What the quality tier means

The quality tier maps to each protocol's own thinking-control parameter:

| quality | OpenAI-compatible | Anthropic | Gemini |
| --- | --- | --- | --- |
| low / medium / high | `reasoning_effort` parameter | thinking budget `budget_tokens` (1024 / 4096 / 16384; Claude 4.6+ defaults to adaptive thinking and auto-downgrades on a 400 error) | `thinkingLevel` (LOW / MEDIUM / HIGH) |

Applies only to models with "supports thinking" checked.

## Toolset

The 6 built-in tools available inside `run_code` programs:

| Tool | Description | Concurrency |
| --- | --- | --- |
| `read_file(path)` | Read a text file | safe |
| `write_file(path, content)` | Write a file (snapshots automatically before writing) | serial |
| `edit_file(path, find, replace)` | Exact find-and-replace editing | serial |
| `glob(pattern)` | Filename glob matching | safe |
| `grep(pattern, path?)` | Regex content search | safe |
| `bash(command)` | Run a shell command in the workspace directory | serial |

Concurrency-safe tools run in parallel in the scheduling pool, writes are serialized automatically, and at most 10 tools run in parallel within a single round.

## Security Statement

The `bash` and `run_code` tools execute on your machine with your current user privileges and have **full file-system and network access** (the same default semantics as coding agents like Cline); file reads/writes and command execution are not limited to the current workspace. The `run_code` worker thread only provides **resource-limit isolation** — compute time, wall clock, memory, and output size — **it is not a security sandbox**: programs can still dynamically load Node built-in modules to access the host machine, and subprocesses spawned by the program inherit the extension host's entire environment. Use this extension only with trusted workspaces and trusted tasks.

## Worker Budgets and Guardrails (defaults)

| Parameter | Default | Description |
| --- | --- | --- |
| `computeMs` | 60 s | Pure compute-time budget of the program (event-loop-active duration) |
| `maxWallMs` | 600 s (10 min) | Wall-clock limit (including I/O waits) |
| `maxOutputBytes` | 64 MB | Combined cap on return value + logs; exceeding it truncates and terminates |
| `maxOldGenerationSizeMb` | 512 MB | Worker thread heap limit |
| `maxParallel` | 10 | Max parallel tools in the scheduling pool |
| `maxToolRounds` | 40 | Max tool-execution rounds per task |

When any budget is exhausted, the program is terminated and the error message is fed back into the model context so it can adjust on its own.

## Sessions & Snapshot Review

- **Session persistence**: every conversation turn (timeline events, state-machine phases) is persisted as JSONL in VS Code globalStorage: `<globalStorage>/ptc-agent/sessions/<workspaceHash>/<sessionId>.jsonl`, isolated per workspace. Restore any session from the history dropdown at the top.
- **Snapshot Review**: before each file edit, the agent snapshots the original content to `<globalStorage>/ptc-agent/snapshots/<sessionId>/`. When the task finishes and enters the Review phase:
  - Click a changed file → a native VS Code diff view opens, comparing the snapshot with the current content;
  - **Accept**: keep the change and discard that file's snapshot (no path = Accept all);
  - **Reject**: restore the file from the snapshot to its pre-edit state (no path = Reject all).

## Known Issues & Troubleshooting

### SSE stream stalls behind a proxy (`http.proxySupport`)

VS Code enables `http.proxySupport` by default, which intercepts extension network requests; under some proxies this breaks SSE streaming responses — the stream stalls with no output. To troubleshoot:

1. Open VS Code settings (`Ctrl+,`);
2. Search for `http.proxySupport` and set it to **`off`**;
3. Restart VS Code (`Developer: Reload Window` is enough) and try again.

If it still fails, confirm that the baseURL is reachable (temporarily verify with `curl`) and check that the proxy allows long-lived SSE connections.

### Windows path conventions

Paths in tools and inside `run_code` programs uniformly use **forward-slash** (`/`) relative paths (relative to the current workspace root), e.g. `src/index.ts`. Backslash paths are not supported on Windows; snapshots, diffs, and review all resolve per the forward-slash convention.

### Misc

- API keys live only in VS Code SecretStorage (never written in plaintext under `globalStorage`); reinstalling the extension requires re-entering them;
- The extension registers no command-palette commands; all interaction happens inside the PTC Agent sidebar;
- On upstream API rate limiting (429) it retries with backoff as instructed by the response; auth failures (401/403) prompt a key check.

## Development

```bash
npm run build    # full build (codicons + extension-host esbuild + webview vite)
npm run watch    # extension-host watch mode
npm test         # vitest unit tests
npx @vscode/vsce package --no-dependencies   # package the .vsix
```
