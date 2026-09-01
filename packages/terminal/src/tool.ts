import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { PluginContext } from "@i-harness/core-plugin"
import { createTerminalService, filterConptyNoise, type TerminalService, type TerminalSignalName } from "./service.ts"

export interface TerminalToolDeps { service: TerminalService }

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
        const spec = {
          command: args.command,
          ...(args.args !== undefined ? { args: args.args } : {}),
          ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
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
      execute: async (args: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }, exec: ToolExec) =>
        service.open(
          { command: args.command, ...(args.args !== undefined ? { args: args.args } : {}), ...(args.cwd !== undefined ? { cwd: args.cwd } : {}), ...(args.env !== undefined ? { env: args.env } : {}) },
          { sessionId: exec.sessionId },
        ),
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
export function registerTerminal(ctx: PluginContext, tools: { register(t: Tool): void }): TerminalMountHandle {
  const service = createTerminalService()
  ctx.services.register("terminal/service", service)
  for (const tool of [...createTerminalTools({ service }), ...createProcessTools({ service })]) tools.register(tool)
  return { dispose: () => service.dispose() }
}
