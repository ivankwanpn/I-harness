import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { PluginContext } from "@i-harness/core-plugin"
import type { SandboxDenial, SandboxMode } from "@i-harness/sandbox"
import { denialFor } from "@i-harness/sandbox"
import { createTerminalService, filterConptyNoise, type TerminalService, type TerminalSignalName } from "./service.ts"

export interface TerminalToolDeps {
  service: TerminalService
  // D1 (m55): the default cwd for terminal_open/process_spawn — the assembly
  // workspace. An explicit args.cwd from the model still wins; absent (both)
  // → no cwd field, so node-pty keeps its own contract (inherit the parent).
  cwd?: string
  // M62: confinement for the PTY. A RESOLVER, not a value, and read PER CALL —
  // the same thunk shape the shell takes. A mode that changes mid-session must
  // reach the NEXT call, which is exactly what a mount-time snapshot cannot do
  // (see `confinement`). Absent → the host requested no sandbox and nothing is
  // refused; `undefined` from the thunk means the same thing.
  sandboxPolicy?: () => import("@i-harness/sandbox").SandboxExecutionPolicy | undefined
}

/**
 * M62: terminal refusals are RETURNED, never thrown.
 *
 * A throwing tool body fails the whole turn — core-agent discards the batch and
 * appends no tool/result, so the model reads a hung call rather than an answer
 * (`packages/fs/src/error.ts` states the same rule for the fs tools; terminal
 * does not depend on `fs`, and pulling that package in for one helper would be
 * the wrong edge, so the shape is repeated here and pinned by a test).
 *
 * The returned object carries the SHARED denial (spec §3.2), so one rule covers
 * every surface a model can hit. `error` repeats the reason and the escalation
 * sentence in one string for a reader that only looks at `error`.
 */
function terminalRefusal(mode: SandboxMode, reason: string): { error: string; code: SandboxDenial["code"]; denial: SandboxDenial } {
  const denial = denialFor("terminal", mode, reason)
  return {
    error: denial.escalation === undefined ? denial.reason : `${denial.reason} ${denial.escalation}`,
    code: denial.code,
    denial,
  }
}

/**
 * The confining mode in force for THIS call, or undefined when unconfined.
 *
 * Resolved per call, never cached: a session mounted `danger-full-access` and
 * later tightened (the escalation ladder is a `sandbox/mode` event) must have
 * its NEXT terminal call refused. That is why the tools mount unconditionally
 * and refuse here rather than the terminal being unmounted at mount time.
 *
 * `danger-full-access` is the one mode that does not confine — a PTY under it
 * runs exactly as it always did. `workspace-write` DOES confine: the PTY cannot
 * be kernel-confined at all, so it must not inherit a mode that claims to bound
 * writes to the workspace.
 */
function confinement(deps: TerminalToolDeps): SandboxMode | undefined {
  const policy = deps.sandboxPolicy?.()
  if (policy === undefined || policy.mode === "danger-full-access") return undefined
  return policy.mode
}

/**
 * M27-H-2 error-path guard: node-pty's win32 ConPTY agent noise ("Error:
 * AttachConsole failed" — fork'd conpty_console_list_agent writing to the
 * inherited stderr, exit 0; the subprocess stderr is not interceptable
 * library-side). Tool errors are the only PTY error report escaping the
 * surface, so the guard runs here:
 *  - known-noise lines are stripped from the thrown report,
 *  - a report that is ONLY noise converts to the benign terminal-state
 *    outcome (the pty channel is terminating — the operation did not fail
 *    server-side), never leaking the raw agent text to the tool result.
 */
async function guardPtyErrors(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn()
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const cleaned = filterConptyNoise(raw)
    if (cleaned.trim() === "") {
      return { suppressed: "AttachConsole failed", note: "known win32 ConPTY agent noise — the pty is in its terminal state (see node-pty upstream)" }
    }
    if (cleaned !== raw) throw new Error(cleaned)
    throw err
  }
}

function noNoiseLeak(tools: Tool[]): Tool[] {
  return tools.map((t) => ({ ...t, execute: (args, exec) => guardPtyErrors(() => t.execute(args, exec)) }))
}

// M62: terminal_read, terminal_signal, terminal_close and terminal_list are
// DELIBERATELY not guarded. They can only observe or SHUT DOWN — refusing them
// would strand live PTYs (opened under a wider mode, or before a tightening)
// with no way to read or close them, which is a worse outcome than the reads.
// process_kill and process_resize_pty below are the same class.
export function createTerminalTools(deps: TerminalToolDeps): Tool[] {
  const { service } = deps
  return noNoiseLeak([
    {
      name: "terminal_open",
      description:
        "Open a long-running interactive terminal (PTY) and return its id. Use terminal_send to write input, terminal_read to pull output, terminal_close when done.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Executable path" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
          cols: { type: "number" }, rows: { type: "number" },
        },
        required: ["command"],
      },
      execute: async (args: { command: string; args?: string[]; cwd?: string; cols?: number; rows?: number }, exec: ToolExec) => {
        // M62: this call CREATES the capability, so it is the one place a
        // confined mode can still be honoured — the PTY itself cannot be
        // confined by the OS sandbox.
        const mode = confinement(deps)
        if (mode !== undefined) {
          return terminalRefusal(
            mode,
            `refusing to start a PTY under ${mode}: an interactive terminal cannot be confined by the OS sandbox, so it would run unrestricted.`,
          )
        }
        const cwd = args.cwd ?? deps.cwd
        const spec = {
          command: args.command,
          ...(args.args !== undefined ? { args: args.args } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(args.cols !== undefined ? { cols: args.cols } : {}),
          ...(args.rows !== undefined ? { rows: args.rows } : {}),
        }
        return service.open(spec, { sessionId: exec.sessionId })
      },
    },
    {
      name: "terminal_send",
      description: "Write text to a terminal's stdin (newlines are sent as '\\n').",
      inputSchema: { type: "object", properties: { id: { type: "string" }, data: { type: "string" } }, required: ["id", "data"] },
      execute: async (args: { id: string; data: string }, exec: ToolExec) => {
        // M62: the PTY itself was opened outside this mode (or before it was
        // tightened), and it is unconfined — so driving it is still unconfined
        // execution. The refusal names the terminal so the model knows which
        // handle it may not write to.
        const mode = confinement(deps)
        if (mode !== undefined) {
          return terminalRefusal(
            mode,
            `refusing to write to terminal ${args.id} under ${mode}: the PTY was started outside this mode and driving it would run unrestricted.`,
          )
        }
        service.send(args.id, args.data, { sessionId: exec.sessionId })
        return { id: args.id, sentChars: args.data.length }
      },
    },
    {
      name: "terminal_read",
      description: "Pull buffered terminal output since offset (in UTF-16 code units). Poll with nextOffset; output is normalized to LF.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, offset: { type: "number" }, maxBytes: { type: "number" } },
        required: ["id"],
      },
      isReadOnly: true,
      execute: async (args: { id: string; offset?: number; maxBytes?: number }, exec: ToolExec) => {
        return service.read(args.id, { offset: args.offset, maxBytes: args.maxBytes, sessionId: exec.sessionId })
      },
    },
    {
      name: "terminal_signal",
      description: "Send a signal to a terminal: INT (Ctrl+C), TERM (terminate), KILL (force).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, signal: { type: "string", enum: ["INT", "TERM", "KILL"] } },
        required: ["id", "signal"],
      },
      execute: async (args: { id: string; signal: TerminalSignalName }, exec: ToolExec) => {
        return service.signal(args.id, args.signal, { sessionId: exec.sessionId })
      },
    },
    {
      name: "terminal_close",
      description: "Close a terminal (terminate its process and forget it).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: async (args: { id: string }, exec: ToolExec) => service.close(args.id, { sessionId: exec.sessionId }),
    },
    {
      name: "terminal_list",
      description: "List live terminals (the background terminal registry).",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => ({ terminals: service.list() }),
    },
  ])
}

// M26-B8：進程控制面——terminal service 的薄包（spawn/kill/resize_pty）。
export function createProcessTools(deps: TerminalToolDeps): Tool[] {
  const { service } = deps
  return noNoiseLeak([
    {
      name: "process_spawn",
      description:
        "Spawn a pty-backed process handle and return its id (use terminal_read/terminal_send to exchange I/O; process_kill to terminate).",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, env: { type: "object" } },
        required: ["command"],
      },
      execute: async (args: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }, exec: ToolExec) => {
        // M62: process_spawn creates the same unconfined capability as
        // terminal_open (a pty-backed process), so it refuses on the same rule.
        const mode = confinement(deps)
        if (mode !== undefined) {
          return terminalRefusal(
            mode,
            `refusing to spawn a pty-backed process under ${mode}: an interactive terminal cannot be confined by the OS sandbox, so it would run unrestricted.`,
          )
        }
        const cwd = args.cwd ?? deps.cwd
        return service.open(
          { command: args.command, ...(args.args !== undefined ? { args: args.args } : {}), ...(cwd !== undefined ? { cwd } : {}), ...(args.env !== undefined ? { env: args.env } : {}) },
          { sessionId: exec.sessionId },
        )
      },
    },
    {
      name: "process_kill",
      description: "Terminate a process handle (signal: TERM terminates, KILL forces; INT sends Ctrl+C).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, signal: { type: "string", enum: ["INT", "TERM", "KILL"] } },
        required: ["id"],
      },
      execute: async (args: { id: string; signal?: TerminalSignalName }, exec: ToolExec) =>
        service.signal(args.id, args.signal ?? "TERM", { sessionId: exec.sessionId }),
    },
    {
      name: "process_resize_pty",
      description: "Resize a process's PTY (cols/rows). No-op for non-interactive output.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, cols: { type: "number" }, rows: { type: "number" } }, required: ["id", "cols", "rows"] },
      execute: async (args: { id: string; cols: number; rows: number }, exec: ToolExec) =>
        service.resize(args.id, args.cols, args.rows, { sessionId: exec.sessionId }),
    },
  ])
}

export interface TerminalMountHandle { dispose(): void }
export function registerTerminal(
  ctx: PluginContext,
  tools: { register(t: Tool): void },
  /** D1 (m55): assembly workspace — the default cwd for every PTY. */
  opts?: {
    cwd?: string
    // M62: the assembly's per-call policy read, passed straight through to the
    // tools. Absent → no sandbox was requested (nothing refused).
    sandboxPolicy?: () => import("@i-harness/sandbox").SandboxExecutionPolicy | undefined
  },
): TerminalMountHandle {
  const service = createTerminalService()
  ctx.services.register("terminal/service", service)
  const deps: TerminalToolDeps = {
    service,
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts?.sandboxPolicy !== undefined ? { sandboxPolicy: opts.sandboxPolicy } : {}),
  }
  for (const tool of [...createTerminalTools(deps), ...createProcessTools(deps)]) tools.register(tool)
  return { dispose: () => service.dispose() }
}
