import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { PluginContext } from "@i-harness/core-plugin"
import type { EscalationApprover, SandboxDenial, SandboxExecutionPolicy, SandboxMode } from "@i-harness/sandbox"
import type { ExecService } from "@i-harness/exec"
import { currentExecCaller, withExecCallerScope } from "@i-harness/exec"
import { ESCALATION_TARGETS, SandboxUnavailableError, denialFor, resolveCallPolicy } from "@i-harness/sandbox"
import { createTerminalService, type TerminalService, type TerminalSignalName } from "./service.ts"

export interface TerminalToolDeps {
  service: TerminalService
  // D1 (m55): the default cwd for terminal_open/process_spawn — the assembly
  // workspace. An explicit args.cwd from the model still wins; absent (both)
  // → no cwd field, so ExecService captures its configured workspace or cwd.
  cwd?: string
  // M62: confinement for the PTY. A RESOLVER, not a value, and read PER CALL —
  // the same thunk shape the shell takes. A mode that changes mid-session must
  // reach the NEXT call, which is exactly what a mount-time snapshot cannot do
  // (see `confinement`). Absent → the host requested no sandbox and nothing is
  // refused; `undefined` from the thunk means the same thing.
  sandboxPolicy?: () => SandboxExecutionPolicy | undefined
  // M62: the approval-service ADAPTER, built once by the assembly. The per-call
  // `EscalationContext` is composed in the tool body, because only that layer
  // holds the `ToolExec` a prompt must name. Absent → an escalation request is
  // refused (fail closed), never silently allowed.
  escalationApprover?: EscalationApprover<unknown, string>
}

/** Current Windows backends do not support confined PTY. POSIX admission probes
 * the selected backend through ExecService. */
const PTY_PERMITTED_MODE: SandboxMode = "danger-full-access"

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
  const denial = denialFor("terminal", mode, reason, PTY_PERMITTED_MODE)
  return { error: messageFor(denial), code: denial.code, denial }
}

/** The ladder's refusal, returned AS THE LADDER BUILT IT (spec §3.2 corollary 2).
 *  Routing it back through `terminalRefusal` would rebuild the denial through
 *  `denialFor(…, PTY_PERMITTED_MODE)` and re-attach the escalation sentence that
 *  branches 1/5/6 of the ladder set `escalationTarget: null` to withhold — advice
 *  to send the same refused request again. */
function ladderRefusal(denial: SandboxDenial): { error: string; code: SandboxDenial["code"]; denial: SandboxDenial } {
  return { error: messageFor(denial), code: denial.code, denial }
}

/** The model-facing sentence: the reason, plus the recovery route when the
 *  refusal has one. A reader that only looks at `error` still learns what to do. */
function messageFor(denial: SandboxDenial): string {
  return denial.escalation === undefined ? denial.reason : `${denial.reason} ${denial.escalation}`
}

/**
 * M62: the escalation ladder for this surface — the SAME per-call decision fs
 * and the shell make. A refusal is RETURNED as a value, never thrown (a throwing
 * tool body fails the whole turn and appends no `tool/result`).
 *
 * The `policy` it returns is the GRANTED one when an escalation was approved.
 * Deciding confinement from a fresh `deps.sandboxPolicy?.()` read instead would
 * be self-defeating: `danger-full-access` is exactly the mode that makes
 * `confinement()` return undefined, so the re-read would refuse the very call
 * the user just approved.
 */
async function resolveTerminalCall(
  deps: TerminalToolDeps,
  exec: ToolExec,
  toolName: string,
  args: { sandbox_permissions?: string; justification?: string },
  subject: string,
): Promise<
  | { kind: "proceed"; mode: SandboxMode | undefined; policy: SandboxExecutionPolicy | undefined }
  | { kind: "refused"; refusal: { error: string; code: SandboxDenial["code"]; denial: SandboxDenial } }
> {
  const escalation = deps.escalationApprover === undefined
    ? undefined
    : {
        approver: deps.escalationApprover,
        agent: exec,
        callId: exec.callId ?? "unknown",
        toolName,
        ...(exec.abortSignal !== undefined ? { signal: exec.abortSignal } : {}),
      }
  const resolution = await resolveCallPolicy({
    base: deps.sandboxPolicy?.(),
    surface: "terminal",
    subject,
    args,
    ...(escalation !== undefined ? { escalation } : {}),
  })
  if (resolution.kind === "refused") return { kind: "refused", refusal: ladderRefusal(resolution.denial) }
  return { kind: "proceed", mode: confinement(resolution.policy), policy: resolution.policy }
}

/**
 * The confining mode in force for THIS call, or undefined when unconfined.
 *
 * Resolved per call, never cached. The granted policy is forwarded to
 * ExecService so the selected backend can admit or refuse a confined PTY.
 */
function confinement(policy: SandboxExecutionPolicy | undefined): SandboxMode | undefined {
  if (policy === undefined || policy.mode === "danger-full-access") return undefined
  return policy.mode
}

function asTrustedToolCaller<T>(exec: ToolExec, call: () => T): T {
  if (currentExecCaller() || !exec.sessionId) return call()
  return withExecCallerScope({ sessionId: exec.sessionId }, call)
}

// M62: terminal_read, terminal_signal, terminal_close and terminal_list are
// DELIBERATELY not guarded. They can only observe or SHUT DOWN — refusing them
// would strand live PTYs (opened under a wider mode, or before a tightening)
// with no way to read or close them, which is a worse outcome than the reads.
// process_kill and process_resize_pty below are the same class.
export function createTerminalTools(deps: TerminalToolDeps): Tool[] {
  const { service } = deps
  return [
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
          // M62: the refusal below tells the model to retry with these two; until
          // now no terminal schema declared them, so the advice named arguments
          // the model could not send. OPT-IN — absent from `required`.
          sandbox_permissions: { type: "string", enum: [...ESCALATION_TARGETS], description: "request a wider sandbox mode for THIS call when a denial says the operation needs one" },
          justification: { type: "string", description: "why the wider mode is required; shown to whoever approves the request" },
        },
        required: ["command"],
      },
      execute: async (args: { command: string; args?: string[]; cwd?: string; cols?: number; rows?: number; sandbox_permissions?: string; justification?: string }, exec: ToolExec) => {
        // M62: this call CREATES the capability, so it is the one place a
        // confined mode is checked by the selected backend. Current Windows
        // backends refuse PTY before launch; POSIX can admit where supported.
        const ladder = await resolveTerminalCall(deps, exec, "terminal_open", args, `open a PTY running ${args.command}`)
        if (ladder.kind === "refused") return ladder.refusal
        const mode = ladder.mode
        if (mode !== undefined && process.platform === "win32") {
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
          ...(ladder.policy === undefined ? {} : { sandbox: ladder.policy }),
        }
        try { return await asTrustedToolCaller(exec, () => service.open(spec, { sessionId: exec.sessionId, abortSignal: exec.abortSignal })) }
        catch (cause) {
          if (mode !== undefined && cause instanceof SandboxUnavailableError) return terminalRefusal(mode, cause.message)
          throw cause
        }
      },
    },
    {
      name: "terminal_send",
      description: "Write text to a terminal's stdin (newlines are sent as '\\n').",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          data: { type: "string" },
          // M62 — same two arguments as terminal_open; see the note there.
          sandbox_permissions: { type: "string", enum: [...ESCALATION_TARGETS], description: "request a wider sandbox mode for THIS call when a denial says the operation needs one" },
          justification: { type: "string", description: "why the wider mode is required; shown to whoever approves the request" },
        },
        required: ["id", "data"],
      },
      execute: async (args: { id: string; data: string; sandbox_permissions?: string; justification?: string }, exec: ToolExec) => {
        // Windows confined PTY is unsupported. On POSIX the service compares
        // the current granted mode with the handle's admitted mode.
        const ladder = await resolveTerminalCall(deps, exec, "terminal_send", args, `write to terminal ${args.id}`)
        if (ladder.kind === "refused") return ladder.refusal
        const mode = ladder.mode
        if (mode !== undefined && process.platform === "win32") {
          return terminalRefusal(
            mode,
            `refusing to write to terminal ${args.id} under ${mode}: the PTY was started outside this mode and driving it would run unrestricted.`,
          )
        }
        try { await service.send(args.id, args.data, { sessionId: exec.sessionId, ...(ladder.policy === undefined ? {} : { sandbox: ladder.policy }) }) }
        catch (cause) {
          if (mode !== undefined && cause instanceof Error && cause.message.startsWith("TERMINAL_POLICY_MISMATCH")) return terminalRefusal(mode, cause.message)
          throw cause
        }
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
      execute: async (_args, exec: ToolExec) => ({ terminals: service.list({ sessionId: exec.sessionId }) }),
    },
  ]
}

// M26-B8：進程控制面——terminal service 的薄包（spawn/kill/resize_pty）。
export function createProcessTools(deps: TerminalToolDeps): Tool[] {
  const { service } = deps
  return [
    {
      name: "process_spawn",
      description:
        "Spawn a pty-backed process handle and return its id (use terminal_read/terminal_send to exchange I/O; process_kill to terminate).",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
          env: { type: "object" },
          // M62 — same two arguments as terminal_open; see the note there.
          sandbox_permissions: { type: "string", enum: [...ESCALATION_TARGETS], description: "request a wider sandbox mode for THIS call when a denial says the operation needs one" },
          justification: { type: "string", description: "why the wider mode is required; shown to whoever approves the request" },
        },
        required: ["command"],
      },
      execute: async (args: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; sandbox_permissions?: string; justification?: string }, exec: ToolExec) => {
        // process_spawn uses the same PTY admission as terminal_open.
        const ladder = await resolveTerminalCall(deps, exec, "process_spawn", args, `spawn a pty-backed process running ${args.command}`)
        if (ladder.kind === "refused") return ladder.refusal
        const mode = ladder.mode
        if (mode !== undefined && process.platform === "win32") {
          return terminalRefusal(
            mode,
            `refusing to spawn a pty-backed process under ${mode}: an interactive terminal cannot be confined by the OS sandbox, so it would run unrestricted.`,
          )
        }
        const cwd = args.cwd ?? deps.cwd
        try { return await asTrustedToolCaller(exec, () => service.open(
          { command: args.command, ...(args.args !== undefined ? { args: args.args } : {}), ...(cwd !== undefined ? { cwd } : {}), ...(args.env !== undefined ? { env: args.env } : {}), ...(ladder.policy === undefined ? {} : { sandbox: ladder.policy }) },
          { sessionId: exec.sessionId, abortSignal: exec.abortSignal },
        )) } catch (cause) {
          if (mode !== undefined && cause instanceof SandboxUnavailableError) return terminalRefusal(mode, cause.message)
          throw cause
        }
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
  ]
}

export interface TerminalMountHandle { dispose(): Promise<void> }
export function registerTerminal(
  ctx: PluginContext,
  tools: { register(t: Tool): void },
  /** D1 (m55): assembly workspace — the default cwd for every PTY. */
  opts?: {
    execService: ExecService
    cwd?: string
    // M62: the assembly's per-call policy read, passed straight through to the
    // tools. Absent → no sandbox was requested (nothing refused).
    sandboxPolicy?: () => SandboxExecutionPolicy | undefined
    // M62: the escalation approver, forwarded to the tool deps — see
    // TerminalToolDeps.escalationApprover. Without this hop the ladder would be
    // unreachable at runtime while every type still checked.
    escalationApprover?: EscalationApprover<unknown, string>
  },
): TerminalMountHandle {
  if (!opts?.execService) throw new Error("Terminal requires the assembly ExecService")
  const service = createTerminalService(opts.execService)
  ctx.services.register("terminal/service", service)
  const deps: TerminalToolDeps = {
    service,
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts?.sandboxPolicy !== undefined ? { sandboxPolicy: opts.sandboxPolicy } : {}),
    ...(opts?.escalationApprover !== undefined ? { escalationApprover: opts.escalationApprover } : {}),
  }
  for (const tool of [...createTerminalTools(deps), ...createProcessTools(deps)]) tools.register(tool)
  return { dispose: () => service.dispose() }
}
