import type { ExecService } from "@i-harness/exec"
import type { RetentionMode, SpillStoreOptions } from "@i-harness/output-retention"

export interface ResolvedShell {
  name: "bash" | "pwsh"
  argv: string[] // shell executable + mode flag(s)
}

export type AgentShellDialect = "posix" | "powershell" | "cmd"
export interface ResolvedAgentShell {
  executionTarget?: "host" | "wsl"
  env?: Readonly<Record<string, string>>
  executionContext?: string
  workspacePath?: string
  id: string
  label: string
  command: string
  dialect: AgentShellDialect
  /** Revalidate the approved executable before launch without reading a new preference. */
  validate?(): void
}

export interface ShellRetentionOptions {
  maxBytes?: number // default 64_000
  mode?: RetentionMode
  // M21 B 層：truncated 時把完整輸出寫 spill + 併 notice（additive——不設=同前）
  spill?: SpillStoreOptions
}

export interface ShellToolDeps {
  /** Assembly-captured WSL Bash binding, also used by explicit bash. */
  wslShell?: ResolvedAgentShell
  exec: ExecService
  /** Live host preference. Only the generic shell tool uses this resolver. */
  agentShell?: () => ResolvedAgentShell
  timeoutMs?: number // declared on bash/pwsh tools; drives guard-timeout
  /** W10: a FOREGROUND bash/pwsh command still running after this many ms is
   * handed back as a background job id (the command keeps running) instead of
   * waiting — the escape hatch for commands that outlive `timeoutMs`, which
   * must be applied BEFORE the call rather than guessed before it.
   *
   * IT MUST BE WELL UNDER `timeoutMs`. The two knobs are read together for a
   * reason: `timeoutMs` is this tool's declared deadline, and at that deadline
   * guard-timeout aborts the call and exec kills the process tree — so a
   * threshold AT or ABOVE it never fires, and every long command still dies
   * mid-flight. Absent → no promotion (pre-W10 behavior, byte for byte). */
  backgroundAfterMs?: number
  retention?: ShellRetentionOptions
  // D1 (m55): the working directory for every shell execution — the assembly
  // workspace. Absent → no cwd field, so exec keeps its own contract (the
  // child inherits the parent process cwd).
  cwd?: string
  // M16 final-review (C1): when set, every bash/pwsh execution carries this
  // policy so exec confines at spawn. Absent → no sandbox field (passthrough,
  // pre-M16 behavior).
  // M62: a RESOLVER, not a value. It used to be the resolved policy, captured
  // once when the assembly mounted the tools, so a mid-session mode change
  // reached the fs guard but not the shell — the two surfaces then disagreed
  // about the mode in force. Every execute calls it, so the argv is confined
  // against the policy of THAT call. Returning `undefined` still means
  // "no policy ⇒ no sandbox field" (a host that requested no sandbox).
  //
  // What actually makes the per-call read pay off is a HOST appending a
  // `sandbox/mode` event mid-session. The escalation ladder is a DIFFERENT path
  // and not a producer of this one: a grant is per-call and transient, appends
  // no `sandbox/mode` event, and never moves the standing mode (spec §3.3
  // point 1). It reaches exec through the granted policy below, not through
  // this thunk.
  sandboxPolicy?: () => import("@i-harness/sandbox").SandboxExecutionPolicy | undefined
  // M62: the approval-service ADAPTER, built once by the assembly. The per-call
  // `EscalationContext` is composed in the tool body, because only that layer
  // holds the `ToolExec` a prompt must name. Absent → an escalation request is
  // refused (fail closed), never silently allowed.
  escalationApprover?: import("@i-harness/sandbox").EscalationApprover<unknown, string>
}
