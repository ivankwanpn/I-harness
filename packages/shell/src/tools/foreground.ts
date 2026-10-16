import type { Tool, ToolExec } from "@i-harness/core-tools"
import { userSteerForTool } from "@i-harness/core-tools"
import { ESCALATION_TARGETS, SandboxUnavailableError } from "@i-harness/sandbox"
import type { ShellToolDeps } from "../types.ts"
import { getArgv } from "../command/argv.ts"
import { boundShellEnvironment, shellFlags } from "../command/resolve.ts"
import { bashAvailable, resolveBashExe, resolvePwshExe } from "../discovery/windows.ts"
import { shellCommandEnvironment } from "../discovery/environment.ts"
import { sandboxUnavailableFailure, type ResolveShellCall } from "./policy.ts"
import { promotedResult } from "./background.ts"
import type { RetainedRunResult } from "./retention.ts"
import type { VersionIdentity } from "../command/identity.ts"

type NativeDeps = Pick<ShellToolDeps, "wslShell" | "exec" | "cwd" | "backgroundAfterMs" | "timeoutMs">

export function createNativeShellTools(deps: NativeDeps, bashBindings: WeakMap<object, string>, versionIdentity: VersionIdentity, retainedRunResult: RetainedRunResult, resolveCall: ResolveShellCall) {
  // M62 Task 3: `stderr` is declared because the refusals below RETURN it — the
  // bash-absent branch and `sandboxUnavailableFailure` both carry the reason in
  // `stderr` (the field the model reads). It was absent from this type, so the
  // refusal's most important field sat outside the declared output shape.
  const bash: Tool<{ command: string; background?: boolean }, { stdout?: string; stderr?: string; exitCode?: number; job_id?: string; promoted?: true; ran_foreground_ms?: number }> = {
    name: "bash",
    description: deps.wslShell ? `Run Linux Bash in ${deps.wslShell.label}. Background jobs remain alive only until the root command exits; descendants are then cleaned up.` : "run a bash command (background: true returns a job id instead of waiting)",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        background: { type: "boolean" },
        // M62 Task 3: the denial text tells the model to retry with these two
        // arguments; before this, no schema declared them. OPT-IN — absent from
        // `required`, because an ordinary call passes neither.
        sandbox_permissions: { type: "string", enum: [...ESCALATION_TARGETS], description: "request a wider sandbox mode for THIS call when a denial says the operation needs one" },
        justification: { type: "string", description: "why the wider mode is required; shown to whoever approves the request" },
      },
      required: ["command"],
    },
    timeoutMs: deps.timeoutMs,
    getArgv: (args: { command: string }) => getArgv(args.command),
    approvalIdentity: (args) => {
      if (deps.wslShell) return undefined
      const executable = bashBindings.get(args) ?? resolveBashExe()
      if (!executable) return undefined
      bashBindings.set(args, executable)
      return versionIdentity(args, executable, "posix")
    },
    // Hardcoded bash argv: a tool NAMED bash must run bash, never the platform
    // default shell (resolveShell can return pwsh on Windows without bash).
    // If bash is absent, exec.run exits -1 (fail-loud) rather than silently
    // executing PowerShell.
    execute: async (args: { command: string; background?: boolean; sandbox_permissions?: string; justification?: string }, exec: ToolExec) => {
      // M59: legible failure instead of a silent spawn-fail (-1 with empty
      // output) — the model can then pick the pwsh tool immediately.
      if (!deps.wslShell && !bashAvailable()) {
        return {
          stdout: "",
          stderr:
            "bash is not installed on this host (no bash.exe on PATH). " +
            "Use the pwsh tool for shell commands instead.",
          exitCode: -1,
        }
      }
      const argv = deps.wslShell ? [deps.wslShell.command, ...shellFlags(deps.wslShell), args.command] : [bashBindings.get(args) ?? resolveBashExe()!, "-c", args.command]
      bashBindings.delete(args)
      // M62: the ladder runs BEFORE exec is called and AFTER the availability
      // check — asking a human to widen the sandbox for a command this host
      // cannot run at all would be a prompt with no possible outcome.
      const ladder = await resolveCall("bash", exec, args, `run command ${args.command.slice(0, 2048)}${args.command.length > 2048 ? "… [truncated]" : ""}${deps.wslShell ? ` in ${deps.wslShell.label}; captured options ${deps.wslShell.executionContext}` : ""}`)
      if (ladder.kind === "refused") return ladder.refusal
      // Per CALL, never cached: the assembly's resolver re-reads the session's
      // last `sandbox/mode` event, so a mode change a HOST appends mid-session
      // applies here. (`ladder.policy` is the granted policy when this call
      // carried an approved escalation — the ladder is per-call and transient
      // and appends no `sandbox/mode` event of its own.)
      const sandboxResolved = ladder.policy
      try {
        if (args.background === true) {
          const { jobId } = await deps.exec.runBackground({ argv, ...(deps.wslShell ? boundShellEnvironment(deps.wslShell) : shellCommandEnvironment(argv[0]!)), ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(sandboxResolved !== undefined ? { sandbox: sandboxResolved } : {}) })
          return { job_id: jobId }
        }
        // A deadline or direct user steer changes observation of this one
        // command; execution and policy admission are never replayed.
        const cmd = { argv, ...(deps.wslShell ? boundShellEnvironment(deps.wslShell) : shellCommandEnvironment(argv[0]!)), abortSignal: exec.abortSignal, ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(sandboxResolved !== undefined ? { sandbox: sandboxResolved } : {}) }
        const backgroundAfterMs = deps.backgroundAfterMs
        const promotionWake = userSteerForTool(exec)
        const runOptions = {
          ...(backgroundAfterMs === undefined ? {} : { backgroundAfterMs }),
          ...(promotionWake === undefined ? {} : { promotionWake }),
        }
        const result = await deps.exec.run(cmd, runOptions)
        if ("promoted" in result) return promotedResult(result, "bash", deps.timeoutMs)
        return retainedRunResult(result, "bash-stdout")
      } catch (err) {
        // M62 Step 7: exec refuses this command because no backend is composed
        // for the confined mode now in force. Returning the refusal keeps the
        // turn alive so the model can adapt; see sandboxUnavailableFailure.
        if (err instanceof SandboxUnavailableError) return sandboxUnavailableFailure("bash", "shell", sandboxResolved, err.kind, err.detail ?? err.message)
        throw err
      }
    },
  }
  const pwsh: Tool<{ command: string; background?: boolean }, { stdout?: string; stderr?: string; exitCode?: number; job_id?: string; promoted?: true; ran_foreground_ms?: number }> = {
    name: "pwsh",
    description: deps.wslShell ? "Run native Windows PowerShell using the host sandbox backend. WSL Linux paths and capabilities do not apply here; background or PTY support depends on the selected native backend." : "run a PowerShell command (background: true returns a job id instead of waiting)",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        background: { type: "boolean" },
        // M62 Task 3 — same two arguments as bash; see the note there.
        sandbox_permissions: { type: "string", enum: [...ESCALATION_TARGETS], description: "request a wider sandbox mode for THIS call when a denial says the operation needs one" },
        justification: { type: "string", description: "why the wider mode is required; shown to whoever approves the request" },
      },
      required: ["command"],
    },
    timeoutMs: deps.timeoutMs,
    getArgv: (args: { command: string }) => getArgv(args.command),
    // PowerShell resolves aliases/invocation itself; no proven reusable shape.
    approvalIdentity: () => undefined,
    execute: async (args: { command: string; background?: boolean; sandbox_permissions?: string; justification?: string }, exec: ToolExec) => {
      const argv = [resolvePwshExe(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", args.command]
      // M62: the ladder runs once, before exec; `ladder.policy` is the granted
      // policy when this call carried an approved escalation, and the session's
      // per-call read otherwise — see the bash tool above.
      const ladder = await resolveCall("pwsh", exec, args, `run command ${args.command.slice(0, 2048)}${args.command.length > 2048 ? "… [truncated]" : ""}`)
      if (ladder.kind === "refused") return ladder.refusal
      const sandboxResolved = ladder.policy
      try {
        if (args.background === true) {
          const { jobId } = await deps.exec.runBackground({ argv, ...shellCommandEnvironment(argv[0]!), ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(sandboxResolved !== undefined ? { sandbox: sandboxResolved } : {}) })
          return { job_id: jobId }
        }
        // Observe the same capture through the deadline and direct steer source.
        const cmd = { argv, ...shellCommandEnvironment(argv[0]!), abortSignal: exec.abortSignal, ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(sandboxResolved !== undefined ? { sandbox: sandboxResolved } : {}) }
        const backgroundAfterMs = deps.backgroundAfterMs
        const promotionWake = userSteerForTool(exec)
        const runOptions = {
          ...(backgroundAfterMs === undefined ? {} : { backgroundAfterMs }),
          ...(promotionWake === undefined ? {} : { promotionWake }),
        }
        const result = await deps.exec.run(cmd, runOptions)
        if ("promoted" in result) return promotedResult(result, "pwsh", deps.timeoutMs)
        return retainedRunResult(result, "pwsh-stdout")
      } catch (err) {
        // M62 Step 7 — see the bash tool above.
        if (err instanceof SandboxUnavailableError) return sandboxUnavailableFailure("pwsh", "shell", sandboxResolved, err.kind, err.detail ?? err.message)
        throw err
      }
    },
  }
  return [bash, pwsh] as const
}
