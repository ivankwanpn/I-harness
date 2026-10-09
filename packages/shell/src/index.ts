import { existsSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { delimiter, isAbsolute, join, win32 } from "node:path"
import { spawnSync } from "node:child_process"
import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool, ToolExec, PreparedToolIdentity } from "@i-harness/core-tools"
import type { ExecService, PromotedRun } from "@i-harness/exec"
import { registerExec, registerRetainedOutput, retainedOutputReader } from "@i-harness/exec"
import type { SandboxDenial, SandboxExecutionPolicy, SandboxSurface } from "@i-harness/sandbox"
import { denialFor, ESCALATION_TARGETS, SandboxUnavailableError, resolveCallPolicy } from "@i-harness/sandbox"
import type { SandboxUnavailableKind } from "@i-harness/sandbox"
import { createTextRetainer, createSpillStore, spillNotice, type RetentionMode, type SpillStore, type SpillStoreOptions } from "@i-harness/output-retention"

export interface ResolvedShell {
  name: "bash" | "pwsh"
  argv: string[] // shell executable + mode flag(s)
}

type AgentShellDialect = "posix" | "powershell" | "cmd"
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

/** Immutable trusted Linux binding. Paths for file tools remain Windows paths. */
export function resolveWslAgentShell(options: { distribution: string; networkAccess: boolean; workspaceDependencies: boolean; runtimePath?: readonly string[] }, workspacePath?: string): ResolvedAgentShell {
  const captured = Object.freeze({ ...options, ...(options.runtimePath ? { runtimePath: Object.freeze([...options.runtimePath]) } : {}) })
  return Object.freeze({ id: `wsl:${captured.distribution}`, label: `Linux Bash (WSL2 ${captured.distribution})`, command: "/bin/bash", dialect: "posix",
    executionTarget: "wsl", env: Object.freeze({ PATH: [...(captured.runtimePath ?? []), "/usr/bin", "/bin"].join(":"), LANG: "C" }),
    executionContext: JSON.stringify(captured), ...(workspacePath ? { workspacePath } : {}) })
}
function capturedShell(shell: ResolvedAgentShell): ResolvedAgentShell {
  return Object.freeze({ ...shell, ...(shell.env === undefined ? {} : { env: Object.freeze({ ...shell.env }) }) })
}
function boundShellEnvironment(shell: ResolvedAgentShell) {
  return shell.executionTarget === "wsl" ? { executionTarget: "wsl" as const, env: { ...(shell.env ?? { PATH: "/usr/bin:/bin", LANG: "C" }) } }
    : shellCommandEnvironment(shell.command)
}
function shellFlags(shell: ResolvedAgentShell): string[] {
  return shell.dialect === "powershell" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
    : shell.dialect === "cmd" ? ["/d", "/s", "/c"] : shell.executionTarget === "wsl" ? ["--noprofile", "--norc", "-c"] : ["-c"]
}

export function agentShellPrompt(shell: ResolvedAgentShell): string {
  if (shell.executionTarget === "wsl") return `Agent Shell: ${shell.label} (${shell.command}). Use POSIX syntax and Linux paths. ${shell.workspacePath ? `Linux workspace: ${shell.workspacePath}. ` : "The Windows workspace is mapped by WSL at launch. "}File tools continue to use Windows workspace paths. Captured WSL options: ${shell.executionContext}. Background jobs are root-bound: descendants are cleaned up when the root command exits. The pwsh and native terminal tools run on the Windows host with their own sandbox capabilities. Settings changes apply to new assemblies.`
  const syntax = shell.dialect === "powershell" ? "PowerShell syntax (cmdlets, $variables, backtick escaping)"
    : shell.dialect === "cmd" ? "Windows CMD syntax (%VARIABLES%, caret escaping)"
      : "POSIX shell syntax"
  return `Agent Shell: ${shell.label} (${shell.command}). Use the shell tool for command execution with ${syntax}. ` +
    "The bash and pwsh tools remain explicit alternatives for their own dialects. New commands read the current preference; a command already prepared or running retains its executable."
}

/** Advisory approval tokens. Windows dialects preserve path backslashes; they
 * must never pass through the POSIX backslash parser. Dynamic expansion and
 * invocation stay conservative so the danger classifier requires approval. */
function getAgentArgv(command: string, dialect: AgentShellDialect): string[] {
  if (dialect === "posix") return getArgv(command)
  const argv: string[] = []
  let token = "", quoted: "'" | '"' | undefined, started = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quoted === undefined && /\s/.test(char)) {
      if (started) argv.push(token)
      token = ""; started = false
    } else if (char === quoted) {
      if (dialect === "powershell" && command[i + 1] === quoted) { token += char; i++ }
      else quoted = undefined
    } else if (quoted === undefined && (char === '"' || (dialect === "powershell" && char === "'"))) {
      quoted = char; started = true
    } else if ((dialect === "powershell" && char === "`" && quoted !== "'") || (dialect === "cmd" && char === "^" && quoted === undefined)) {
      token += command[++i] ?? ""; started = true
    } else {
      token += char; started = true
    }
  }
  if (started) argv.push(token)
  // The shared classifier has no expansion evaluator. Never allow an expanded
  // executable/target, script block or single-& invocation as a harmless argv.
  if (quoted !== undefined || /[\r\n&]/.test(command)
    || (dialect === "cmd" ? /[%!]/.test(command) : /[$`{}]/.test(command))) argv.push(";")
  return argv
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

function onWindowsPath(name: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  for (const entry of environmentValue(env, "PATH")?.split(";") ?? []) {
    const directory = entry.trim().replace(/^"|"$/g, "")
    if (!directory || name === "bash.exe" && ["system32", "windowsapps"].includes(win32.basename(directory).toLowerCase())) continue
    const candidate = win32.join(directory, name)
    try { if (exists(candidate)) return candidate } catch { /* continue past inaccessible PATH entries */ }
  }
  return undefined
}

function probePowerShellAlias(path: string): boolean {
  // App Execution Aliases may be launchable while Node's existsSync is false.
  // Probe only the known pwsh alias, never arbitrary executables from the model.
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true })
  return result.status === 0 && /^PowerShell 7(?:\.|\s|$)/.test(result.stdout.trim())
}

export function powerShellExecutableAvailable(path: string, exists: (path: string) => boolean = existsSync, probe = exists === existsSync ? probePowerShellAlias : () => false): boolean {
  return exists(path) || /[\\/]Microsoft[\\/]WindowsApps[\\/]pwsh\.exe$/i.test(path) && probe(path)
}

// Windows: prefer installed Git Bash, then another native Bash, else pwsh.
// `System32/bash.exe` and `WindowsApps/bash.exe` launch WSL; they do not obey
// the native cwd and `pwd -W` contract of this tool. Return the chosen absolute
// executable so spawning cannot silently resolve the earlier launcher again.
export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): ResolvedShell {
  if (platform === "win32") {
    const bashExe = resolveBashExe(env, platform, exists)
    if (bashExe) return { name: "bash", argv: [bashExe, "-c"] }
    return { name: "pwsh", argv: [resolvePwshExe(env, platform, exists), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] }
  }
  return { name: "bash", argv: ["bash", "-c"] }
}

/** M59: is `bash` resolvable on this host? The bash TOOL must never silently
 * run another shell — but a bare spawn-fail (exitCode -1, EMPTY stdout AND
 * stderr) left the model flailing across bash / pwsh / terminal_open on a
 * Windows box without Git Bash. The tool now answers legibly instead. */
function resolveBashExe(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (platform !== "win32") return "bash"
  const git = onWindowsPath("git.exe", env, exists)
  const candidates = [
    win32.join(environmentValue(env, "ProgramFiles") ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    win32.join(environmentValue(env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    ...(git ? [win32.resolve(win32.dirname(git), "..", "bin", "bash.exe"), win32.resolve(win32.dirname(git), "..", "..", "bin", "bash.exe")] : []),
  ]
  return candidates.find(exists) ?? onWindowsPath("bash.exe", env, exists) ?? onWindowsPath("bash", env, exists)
}

export function bashAvailable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return resolveBashExe(env, platform, exists) !== undefined
}

/**
 * M59: the PowerShell executable the `pwsh` tool spawns.
 *
 * PowerShell 7 (`pwsh`) when it is on PATH; otherwise Windows PowerShell 5.1
 * — `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, which ships
 * with every supported Windows. Hardcoding `pwsh` made the tool spawn-fail
 * (exitCode -1, EMPTY stdout AND stderr) on machines without PS7 — the model
 * saw a silent failure and flailed across pwd / Get-Location / terminal_open.
 * Both editions accept the same -NoLogo -NoProfile -NonInteractive -Command.
 *
 * The env/platform parameters exist for tests (both are read once, defaulting
 * to the process values).
 */
export function resolvePwshExe(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  probe: (path: string) => boolean = exists === existsSync ? probePowerShellAlias : () => false,
): string {
  if (platform !== "win32") return "pwsh"
  const onPath = onWindowsPath("pwsh.exe", env, (path) => powerShellExecutableAvailable(path, exists, probe))
  if (onPath) return onPath
  const installed = win32.join(environmentValue(env, "ProgramFiles") ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe")
  if (exists(installed)) return installed
  const root = environmentValue(env, "SystemRoot") ?? environmentValue(env, "windir") ?? "C:\\Windows"
  const windowsPowerShell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  return exists(windowsPowerShell) ? windowsPowerShell : "powershell"
}

/** Keep nested `bash` — a `#!/usr/bin/env bash` script, a `bash -c`, an npm
 * script that shells out — in the HARNESS's own runtime rather than whatever the
 * host PATH happens to name first.
 *
 * WHY THE DIRECTORY AND NOT A FLAG: on Windows the host PATH lists the WSL
 * launcher before any real Unix shell (`…\Microsoft\WindowsApps\bash.exe`), so a
 * bare `bash` runs a DIFFERENT filesystem — measured on this host from the pwsh
 * tool, `bash -c "uname -s"` printed `Linux` while the bash tool's own child
 * printed `MINGW64_NT-…`. Prepending the resolved bash's directory makes the
 * harness's bash win for THIS child only.
 *
 * A launched command that IS a bash keeps its OWN directory: an Agent Shell
 * deliberately set to Rtools/MSYS Bash must keep using it (the 2026-10-01
 * tooling audit's conclusion). Every other shell gets the harness's resolved
 * bash, and nothing is prepended when no bash can be resolved at all. This
 * changes only the launched command's environment, never global PATH. */
function shellCommandEnvironment(executable: string): { env?: Record<string, string> } {
  if (process.platform !== "win32") return {}
  const bash = win32.basename(executable).toLowerCase() === "bash.exe" ? executable : resolveBashExe()
  if (bash === undefined) return {}
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path") ?? "PATH"
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return { env: { ...inherited, [key]: `${win32.dirname(bash)};${process.env[key] ?? ""}` } }
}

// Minimal shell-quote parser: splits on whitespace, honors single/double
// quotes, and honors backslash escapes outside quotes and inside double
// quotes (F03-2 bypass shapes like `r\m`, `'r''m'`, `r""m`).
export function getArgv(command: string): string[] {
  const args: string[] = []
  let current = ""
  let inArg = false
  let quote: "'" | '"' | null = null
  let i = 0
  while (i < command.length) {
    const ch = command[i]!
    if (quote === null) {
      if (ch === "'" || ch === '"') {
        quote = ch
        inArg = true
        i++
        continue
      }
      if (ch === "\\") {
        current += command[i + 1] ?? ""
        inArg = true
        i += 2
        continue
      }
      if (ch === " " || ch === "\t" || ch === "\n") {
        if (inArg) {
          args.push(current)
          current = ""
          inArg = false
        }
        i++
        continue
      }
      current += ch
      inArg = true
      i++
    } else if (ch === quote) {
      quote = null
      i++
    } else if (ch === "\\" && quote === '"') {
      current += command[i + 1] ?? ""
      i += 2
    } else {
      current += ch
      i++
    }
  }
  if (inArg) args.push(current)
  return args
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

/**
 * M62: the escalation ladder for the shell surface — the SAME per-call decision
 * fs and the terminal make, in the one place that knows how a shell refusal is
 * delivered.
 *
 * A refusal is a VALUE, never a throw: a throwing tool body fails the whole turn
 * and appends no `tool/result` (`packages/fs/src/error.ts:19-31` records the same
 * rule), so the model would read a hung call instead of an answer.
 *
 * It is returned HERE, as the ladder built it, and NOT through
 * `sandboxUnavailableFailure`: that helper answers a different question (no
 * backend exists for ANY mode), so routing this denial through it would answer
 * with the wrong reason. Every ladder refusal withholds its escalation sentence
 * by construction (`escalationTarget: null` in branches 1/5/6), which is exactly
 * why the denial must not be rebuilt by a helper that has its own.
 *
 * `stderr` carries the JSON denial because that is the field this surface's
 * refusals already use (see `sandboxUnavailableFailure`), and the shell tool's
 * declared output has no `error`/`denial` slot.
 */
async function resolveShellCall(
  deps: ShellToolDeps,
  exec: ToolExec,
  toolName: "bash" | "pwsh" | "shell",
  args: { sandbox_permissions?: string; justification?: string },
  subject: string,
): Promise<
  | { kind: "proceed"; policy: SandboxExecutionPolicy | undefined }
  | { kind: "refused"; refusal: { stdout: string; stderr: string; exitCode: number } }
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
    surface: "shell",
    subject,
    args,
    ...(escalation !== undefined ? { escalation } : {}),
  })
  if (resolution.kind === "refused") {
    return { kind: "refused", refusal: { stdout: "", stderr: JSON.stringify(resolution.denial), exitCode: -1 } }
  }
  // The GRANTED policy when an escalation was approved, the session's otherwise.
  // Re-reading `deps.sandboxPolicy?.()` here would refuse the very call the user
  // just approved.
  return { kind: "proceed", policy: resolution.policy }
}

/**
 * M62 Task 3 (Step 7): a REFUSAL the model can read, not a turn that dies.
 *
 * `exec`'s `resolveArgv` throws `SandboxUnavailableError` synchronously — from
 * `run` (either overload: there is ONE implementation behind them, so W10's
 * promotion cannot diverge here) and from `runBackground`, both through
 * `spawnChild` — when a confined policy reaches it with no provider composed.
 * (Named by SYMBOL, not by line number: W10 moved every line in that file, and
 * the shell test's own note records the same lesson.) A throwing tool
 * body fails the whole turn and appends no `tool/result`, so ONE bash call ended
 * the turn and the model never learned why. The bash-absent branch below already
 * returns a legible failure for the same class of fact ("this host cannot run
 * what you asked"), and so does this one.
 *
 * WHAT IT MUST NOT DO.
 *
 * 1. It must never carry escalation guidance when the reason is `no-backend`:
 *    there NO backend is usable for ANY mode, so sending the model after a wider
 *    one points it at a request that cannot help. That denial is constructed
 *    literally, and the shared thing is the TYPE (`SandboxDenial`), which is what
 *    the Task 2 corrections settled on. The OTHER reason, `command-not-run`, is
 *    the opposite fact and takes the opposite advice — see the branch below.
 * 2. It must never fall back to running the command unconfined. Refusing is the
 *    whole point; the confinement boundary is `exec` failing closed, and
 *    swallowing the throw into a spawn would be strictly worse than the crash.
 *
 * `policy` is the policy THIS call handed to exec (the `mode` the model is told
 * about); the fallback only covers the theoretical case where the thunk returns
 * nothing after the throwing call already read a confined policy. `kind` and
 * `detail` come from the `SandboxUnavailableError` itself, and `kind` is what
 * decides which of the two facts this refusal is reporting.
 */
function sandboxUnavailableFailure(
  tool: "bash" | "pwsh" | "shell",
  surface: SandboxSurface,
  policy: SandboxExecutionPolicy | undefined,
  kind: SandboxUnavailableKind = "no-backend",
  detail = "",
): { stdout: string; stderr: string; exitCode: number } {
  // A backend that EXISTS and merely could not run THIS program is a different
  // fact from "no backend exists", and it takes the opposite advice. Measured on
  // this host: a confined native cmd.exe / node.exe / git.exe all exit 0, so the
  // sentence at the bottom of this function would be false — while
  // `danger-full-access` is exactly what runs the program. Every CONFINED mode
  // refuses such a program (Git Bash dies identically under read-only and under
  // workspace-write), so the mode worth naming is the unconfined one:
  // `denialFor`'s first-wider-mode default would name a mode that refuses
  // identically, which is advice the model cannot act on.
  if (kind === "command-not-run") {
    const mode = policy?.mode ?? "read-only"
    return {
      stdout: "",
      stderr: JSON.stringify(denialFor(
        surface,
        mode,
        `the ${mode} sandbox could not run this ${tool} command, so it was not run unconfined: ${detail}`,
        "danger-full-access",
      )),
      exitCode: -1,
    }
  }
  const denial: SandboxDenial = {
    code: "SANDBOX_DENIED",
    surface,
    mode: policy?.mode ?? "read-only",
    reason:
      "no sandbox backend is usable on this host, so the confined mode in force cannot be enforced: " +
      `refusing to run the ${tool} command unconfined. Asking for a wider mode cannot help — no backend ` +
      "exists for any mode here. Use a file tool for a file operation, or ask the host to compose a sandbox.",
  }
  // exitCode -1 mirrors the bash-absent branch at each call site: -1 means "this
  // host could not run it", never "it ran and failed".
  return { stdout: "", stderr: JSON.stringify(denial), exitCode: -1 }
}

/**
 * W10: exec handed a FOREGROUND command back as a job because it outlived the
 * promotion threshold. The result must say exactly that, because the one thing
 * it must never look like is a choice the model made: a bare `{ job_id }` is
 * what the model's OWN `background: true` call returns, so on that shape it
 * would believe it had asked for background. `promoted: true` plus the elapsed
 * time is the difference, and `stdout` states it in words as well — that is
 * the field the model reads first.
 *
 * The partial output is deliberately NOT repeated here. It is not lost: it is
 * already in the job record this id names (the same record `job_output` reads),
 * and copying it into the tool result would show the model a snapshot frozen at
 * the hand-back while the job keeps writing.
 */
function promotedResult(
  promoted: PromotedRun,
  tool: "bash" | "pwsh" | "shell",
  deadlineMs: number | undefined,
): { stdout: string; job_id: string; promoted: true; ran_foreground_ms: number } {
  // The deadline is named only when the host declared one: a mount without
  // `timeoutMs` has no deadline to explain, and quoting 120_000 here would be
  // asserting a number this layer never saw.
  const why = deadlineMs === undefined
    ? ""
    : ` A foreground ${tool} call is killed at ${deadlineMs}ms and its work is lost, so the harness promotes instead of waiting for that.`
  return {
    job_id: promoted.jobId,
    promoted: true,
    ran_foreground_ms: promoted.ranForegroundMs,
    stdout:
      `[i-harness] the ${tool} command was still running after ${promoted.ranForegroundMs}ms, so the harness promoted it to background job ` +
      `${promoted.jobId} and returned this id instead of waiting. You did NOT ask for background — the harness did.${why} ` +
      `The command is STILL RUNNING. Read its output with job_output({ job_id: "${promoted.jobId}" }); job_list lists it, job_kill stops it.`,
  }
}

export function createShellTools(deps: ShellToolDeps): Tool[] {
  // Remember only a fully literal native --version query. General commands can
  // load profiles, config, hooks, scripts or interpreters whose complete binding
  // is opaque at this layer. Advisory getArgv is never permission evidence.
  function versionIdentity(args: { command: string }, executable: string, dialect: AgentShellDialect): PreparedToolIdentity | undefined {
    if (dialect !== "posix" || ["BASH_ENV", "ENV", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].some((key) => environmentValue(process.env, key)) || Object.keys(process.env).some((key) => key.startsWith("BASH_FUNC_"))) return undefined
    const match = /^(?:"([A-Za-z0-9_ ./:\\-]+)"|'([A-Za-z0-9_ ./:\\-]+)'|([A-Za-z0-9_./:\\-]+)) --version$/.exec(args.command)
    const target = match?.[1] ?? match?.[2] ?? match?.[3]
    if (!target || !isAbsolute(target)) return undefined
    // Other native programs can load config/plugins even for --version. Only
    // the host's known Node binary has a supported complete version-query shape.
    try { if (realpathSync(target) !== realpathSync(process.execPath)) return undefined } catch { return undefined }
    const resolved = isAbsolute(executable) ? executable : (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, executable)).find(existsSync)
    if (!resolved || !isAbsolute(resolved)) return undefined
    const environmentDigest = createHash("sha256").update(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex")
    return { binding: JSON.stringify({ version: 1, cwd: deps.cwd ?? process.cwd(), shell: resolved, dialect, environmentDigest }), executablePaths: [resolved, target], command: { text: args.command, dialect } }
  }
  const bashBindings = new WeakMap<object, string>()
  // Retention is OPT-IN: without `deps.retention` the tools behave exactly as
  // before. The resolved retainer here is only the "configured" flag — the
  // per-run helper builds FRESH retainers because they are one-accumulation
  // stateful objects (never reused across calls).
  const retention = deps.retention
    ? createTextRetainer({ maxBytes: deps.retention.maxBytes ?? 64_000, mode: deps.retention.mode })
    : null
  // spillStore 一次建、跨呼叫重用（寫檔無狀態；root 固定）
  const spillStore: SpillStore | undefined = deps.retention?.spill ? createSpillStore(deps.retention.spill) : undefined

  // Apply retention at the tool-return layer only: exec keeps the full stream.
  // The `truncated` marker is present ONLY when something was omitted.
  // label: per-tool spill 檔前綴（bash → "bash-stdout"、pwsh → "pwsh-stdout"）。
  // M21 A/B bridge：exec 層若啟用 spill，超限輸出已落檔且 `stdout` 只回 tail。
  // 此處的 retainer 只看到 tail（通常 ≤ 預算）→ 自身判 truncated:false；若不
  // 橋接 exec 的截斷狀態，A+B 同開會「静默截斷、無 notice」。因此輸入型別吃進
  // exec 的 stdoutSpillPath/truncated：任一標記視同截斷；有 exec spill 檔時
  // notice 直接指向該檔（完整原文已在），絕不再重複寫一份 shell spill。
  async function retainedRunResult(
    result: {
      stdout: string
      stderr: string
      exitCode: number
      stdoutSpillPath?: string
      truncated?: { stdout: boolean; stderr: boolean }
    },
    label: string,
  ) {
    // M62 Task 3: `stderr` is carried here too (it used to be dropped). The
    // declared output shape now names it, and this branch is the one path where
    // the shape and the value disagreed — a stderr the caller can read is part of
    // the contract, not an artifact of whether retention happens to be on.
    const bind = <T extends object>(output:T):T => {
      const reader=retainedOutputReader(result)
      if(reader) registerRetainedOutput(output,reader)
      return output
    }
    if (retention === null) return bind({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode })
    const so = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
    const se = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
    so.push(result.stdout)
    se.push(result.stderr)
    const rs = so.finish()
    const re = se.finish()
    // 截斷判定＝exec 層（spill 落檔或明確標記）與 retainer 層取聯集。
    const execTruncated = result.truncated?.stdout === true || result.stdoutSpillPath !== undefined
    const truncated = execTruncated || result.truncated?.stderr === true || rs.truncated || re.truncated
    let stdout = rs.text
    // Spill 檔優先用 exec 既有的（完整原文）；否則僅在 retainer 自身截斷 stdout
    // 且有設定 store 時寫一份。只在「真省略」時加 notice——僅 stderr 截斷時
    // stdout 原樣（未被省略），spill/notice 反而會把未截斷的 stdout 加上
    // "(Omitted 0 bytes…)"。
    const spillPathForNotice =
      result.stdoutSpillPath ??
      (rs.truncated && spillStore ? await spillStore.saveText(result.stdout, label) : undefined)
    if (spillPathForNotice !== undefined && (rs.truncated || execTruncated)) {
      // exec tail-only 時完整省略位元組數未知（exec 只回 tail）→ 以 0 標記並指向
      // 完整 spill 檔；retainer 自身截斷則回報精確省略數。
      const omittedForNotice = rs.truncated ? rs.omittedBytes : execTruncated ? 0 : 0
      stdout = rs.text + "\n" + spillNotice(omittedForNotice, spillPathForNotice)
    }
    return bind({
      stdout,
      stderr: re.text,
      exitCode: result.exitCode,
      ...(truncated ? { truncated: { stdoutBytes: rs.omittedBytes, stderrBytes: re.omittedBytes } } : {}),
    })
  }
  // execute: `return retainedRunResult(result)`——async fn 回 promise 自動展平（既有呼叫面不變）

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
      const ladder = await resolveShellCall(deps, exec, "bash", args, `run command ${args.command.slice(0, 2048)}${args.command.length > 2048 ? "… [truncated]" : ""}${deps.wslShell ? ` in ${deps.wslShell.label}; captured options ${deps.wslShell.executionContext}` : ""}`)
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
        // W10: the command spec is built ONCE — the promotion overload takes
        // the very same ExecCommand, so the two calls below differ in nothing
        // but the threshold. The overload (not a second code path) is what
        // keeps a non-promoting call's result shape untouched.
        const cmd = { argv, ...(deps.wslShell ? boundShellEnvironment(deps.wslShell) : shellCommandEnvironment(argv[0]!)), abortSignal: exec.abortSignal, ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(sandboxResolved !== undefined ? { sandbox: sandboxResolved } : {}) }
        const result = deps.backgroundAfterMs === undefined
          ? await deps.exec.run(cmd)
          : await deps.exec.run(cmd, { backgroundAfterMs: deps.backgroundAfterMs })
        // The threshold is the trigger; ONLY a run that outlived it lands here.
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
      const ladder = await resolveShellCall(deps, exec, "pwsh", args, `run command ${args.command.slice(0, 2048)}${args.command.length > 2048 ? "… [truncated]" : ""}`)
      if (ladder.kind === "refused") return ladder.refusal
      const sandboxResolved = ladder.policy
      try {
        if (args.background === true) {
          const { jobId } = await deps.exec.runBackground({ argv, ...shellCommandEnvironment(argv[0]!), ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(sandboxResolved !== undefined ? { sandbox: sandboxResolved } : {}) })
          return { job_id: jobId }
        }
        // W10 — same two calls as the bash tool above; see the note there.
        const cmd = { argv, ...shellCommandEnvironment(argv[0]!), abortSignal: exec.abortSignal, ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(sandboxResolved !== undefined ? { sandbox: sandboxResolved } : {}) }
        const result = deps.backgroundAfterMs === undefined
          ? await deps.exec.run(cmd)
          : await deps.exec.run(cmd, { backgroundAfterMs: deps.backgroundAfterMs })
        if ("promoted" in result) return promotedResult(result, "pwsh", deps.timeoutMs)
        return retainedRunResult(result, "pwsh-stdout")
      } catch (err) {
        // M62 Step 7 — see the bash tool above.
        if (err instanceof SandboxUnavailableError) return sandboxUnavailableFailure("pwsh", "shell", sandboxResolved, err.kind, err.detail ?? err.message)
        throw err
      }
    },
  }
  if (!deps.agentShell) return [bash, pwsh]
  type Args = { command: string; background?: boolean; sandbox_permissions?: string; justification?: string }
  type Binding = { shell: ResolvedAgentShell } | { error: string }
  const bindings = new WeakMap<Args, Binding>()
  function bindingFor(args: Args): Binding {
    const existing = bindings.get(args)
    if (existing) return existing
    let binding: Binding
    try { binding = { shell: capturedShell(deps.agentShell!()) } }
    catch (error) { binding = { error: error instanceof Error ? error.message : String(error) } }
    bindings.set(args, binding)
    return binding
  }
  const shell: Tool<Args> = {
    name: "shell",
    get description() {
      try { return `Run a command in the selected Agent Shell. ${agentShellPrompt(deps.agentShell!())} background: true returns a job id.` }
      catch (error) { return `The selected Agent Shell is unavailable: ${error instanceof Error ? error.message : String(error)}. Change Agent Shell in settings before executing commands.` }
    },
    inputSchema: bash.inputSchema,
    timeoutMs: deps.timeoutMs,
    getArgv: (args) => {
      const binding = bindingFor(args)
      return "error" in binding ? [] : getAgentArgv(args.command, binding.shell.dialect)
    },
    approvalIdentity: (args) => {
      const binding = bindingFor(args)
      return "error" in binding || binding.shell.executionTarget === "wsl" ? undefined : versionIdentity(args, binding.shell.command, binding.shell.dialect)
    },
    execute: async (args, exec) => {
      const binding = bindingFor(args)
      bindings.delete(args)
      if ("error" in binding) return { stdout: "", stderr: binding.error, exitCode: -1 }
      const selected = binding.shell
      try { selected.validate?.() }
      catch (error) { return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: -1 } }
      const flags = shellFlags(selected)
      const argv = [selected.command, ...flags, selected.dialect === "cmd" ? `"${args.command}"` : args.command]
      const ladder = await resolveShellCall(deps, exec, "shell", args, `run ${selected.label} command ${args.command.slice(0, 2048)}${args.command.length > 2048 ? "… [truncated]" : ""}${selected.executionContext ? `; target ${selected.executionTarget}, captured options ${selected.executionContext}` : ""}`)
      if (ladder.kind === "refused") return ladder.refusal
      const sandbox = ladder.policy
      const spec = { argv, ...boundShellEnvironment(selected), ...(selected.dialect === "cmd" ? { windowsVerbatimArguments: true } : {}), ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(sandbox !== undefined ? { sandbox } : {}) }
      try {
        if (args.background === true) return { job_id: (await deps.exec.runBackground(spec)).jobId }
        const command = { ...spec, abortSignal: exec.abortSignal }
        const result = deps.backgroundAfterMs === undefined ? await deps.exec.run(command) : await deps.exec.run(command, { backgroundAfterMs: deps.backgroundAfterMs })
        return "promoted" in result ? promotedResult(result, "shell", deps.timeoutMs) : retainedRunResult(result, "shell-stdout")
      } catch (error) {
        if (error instanceof SandboxUnavailableError) return sandboxUnavailableFailure("shell", "shell", sandbox, error.kind, error.detail ?? error.message)
        throw error
      }
    },
  }
  return [bash, pwsh, shell]
}

export function registerShell(
  ctx: PluginContext,
  registry: { register(t: Tool): void },
  opts?: {
    wslShell?: ResolvedAgentShell
    agentShell?: () => ResolvedAgentShell
    timeoutMs?: number
    /** W10: the foreground promotion threshold, forwarded to both tools — see
     * ShellToolDeps.backgroundAfterMs. It MUST stay well under `timeoutMs`; the
     * assembly is the layer that knows both numbers and states the relation. */
    backgroundAfterMs?: number
    retention?: ShellRetentionOptions
    sandbox?: import("@i-harness/sandbox").SandboxProvider
    // M62: a resolver thunk passed straight through to the tools — see
    // ShellToolDeps.sandboxPolicy. The assembly hands over its per-call read.
    sandboxPolicy?: () => import("@i-harness/sandbox").SandboxExecutionPolicy | undefined
    // M62: the escalation approver, forwarded to `createShellTools` — see
    // ShellToolDeps.escalationApprover. Without this hop the ladder would be
    // unreachable at runtime while every type still checked.
    escalationApprover?: import("@i-harness/sandbox").EscalationApprover<unknown, string>
    /** D1 (m55): assembly workspace — the default cwd for bash/pwsh. */
    cwd?: string
  },
): void {
  // Assembly owns the service when supplied; standalone shell mounting composes
  // a local service bound to its configured workspace.
  let exec: ExecService
  try { exec = ctx.services.get<ExecService>("exec/service") }
  catch { exec = registerExec(ctx, { workspaceRoot: opts?.cwd ?? process.cwd(), sandbox: opts?.sandbox }) }
  const tools = createShellTools({
    exec,
    ...(opts?.wslShell ? { wslShell: capturedShell(opts.wslShell) } : {}),
    ...(opts?.agentShell !== undefined ? { agentShell: opts.agentShell } : {}),
    timeoutMs: opts?.timeoutMs,
    backgroundAfterMs: opts?.backgroundAfterMs,
    retention: opts?.retention,
    sandboxPolicy: opts?.sandboxPolicy,
    ...(opts?.escalationApprover !== undefined ? { escalationApprover: opts.escalationApprover } : {}),
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
  })
  for (const tool of tools) registry.register(tool)
  const selectedShell = tools.find((tool) => tool.name === "shell")
  if (selectedShell) {
    // Pin before any approval policy suspends the call. getArgv is otherwise
    // skipped by ask-all/delegate/full-access policies; execution still uses
    // the same argument object carried by core-tools prepare/dispatch.
    ctx.on("tools/pre-execute", (payload) => {
      const call = payload as { name?: string; args?: { command: string } }
      if (call?.name === "shell" && call.args && typeof call.args === "object") selectedShell.getArgv?.(call.args)
    })
  }
}
