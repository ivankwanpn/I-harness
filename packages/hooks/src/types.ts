/**
 * Hook configuration + runtime contract (R-E5 — CC-compatible output
 * semantics over the core-plugin waterfall/cascade seams; the package itself
 * never executes plugin code in-process — handlers run as spawned
 * subprocesses and are trust-hashed).
 */

/** The 9 hook events (CC/codex vocabulary, IH names). */
export const HOOK_EVENTS = [
  "session/start",
  "session/end",
  "prompt/submit",
  "pre-tool",
  "post-tool",
  "permission",
  "stop",
  "subagent/stop",
  "notification",
] as const
export type HookEventName = (typeof HOOK_EVENTS)[number]

/** Handler type (CC Command/McpTool/Prompt/Agent). v1: the type tags the
 * handler for trust/audit; matching is by event + tool matcher. */
export type HookHandlerType = "command" | "mcpTool" | "prompt" | "agent"

/** Permission verdict vocabulary (CC PermissionRequest). */
export type HookDecision = "allow" | "deny" | "ask"

/**
 * CC-compatible handler stdout contract. A handler prints ONE JSON object.
 * Semantics per event:
 *   - pre-tool/post-tool:  continue:false or block:true (with reason) vetoes
 *     the tool (pre) / surfaces a failure (post); decision:deny is mapped to
 *     block at gate events.
 *   - permission:          decision allow|deny|ask (ask = fail-closed deny in
 *     v1 — no ask seam exists on main yet).
 *   - prompt/submit, stop, session/start|session/end, subagent/stop,
 *     notification: observation only, except block:true which aborts the
 *     phase (fail-closed).
 */
export interface HookOutput {
  continue?: boolean
  stopReason?: string
  decision?: HookDecision
  block?: boolean
  reason?: string
}

/** Per-event context the handler receives on stdin (JSON). */
export type HookContext =
  | { event: "session/start" | "session/end" | "subagent/stop"; sessionId: string }
  | { event: "prompt/submit"; prompt: string }
  | { event: "pre-tool" | "post-tool" | "permission"; tool: { name: string; args: unknown } }
  | { event: "stop"; sessionId: string; finalText: string; turns: number }
  | { event: "notification"; message: string }

/** Tool-name match (tool events only). Absent matcher = every tool. */
export interface HandlerMatcher {
  /** Exact tool name. */
  tool?: string
  /** Case-insensitive RegExp source matched against the tool name. */
  toolRegex?: string
}

/**
 * One handler. Execution: `cmd` `args…` spawned with NO shell, `cwd`
 * optional, stdin = one JSON HookContext, stdout = one JSON HookOutput,
 * killed after `timeoutMs` (default 1000).
 * Trust: `trust.script` + `trust.sha256` — `script` is the executed artifact
 * (resolved against the config dir when relative; the hash is recomputed on
 * EVERY run and must match; mismatch → trust failure → fail-closed deny).
 */
export interface HookHandlerSpec {
  id: string
  event: HookEventName
  type: HookHandlerType
  matcher?: HandlerMatcher
  command: { cmd: string; args?: string[]; cwd?: string }
  trust: { script: string; sha256: string }
  timeoutMs?: number
}

/** The on-disk hooks configuration. */
export interface HooksConfig {
  version: 1
  handlers: HookHandlerSpec[]
}

/** The configuration document is missing/unshapeable. */
export class HookConfigError extends Error {
  readonly code = "hook-config-invalid" as const
  constructor(message: string) {
    super(message)
    this.name = "HookConfigError"
  }
}

/** sha256 of the handler script does not match the trusted value. */
export class HookTrustError extends Error {
  readonly code = "hook-trust-failed" as const
  constructor(
    readonly handlerId: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`hook handler ${handlerId} failed trust check: sha256 ${actual} != trusted ${expected}`)
    this.name = "HookTrustError"
  }
}

/** Handler stdout is not one valid JSON HookOutput (unparseable/typed-wrong). */
export class HookOutputError extends Error {
  readonly code = "hook-output-invalid" as const
  constructor(message: string) {
    super(message)
    this.name = "HookOutputError"
  }
}

/** A gate/block veto: tool blocked or phase stopped (reason carried). */
export class HookBlockedError extends Error {
  readonly code = "hook-blocked" as const
  constructor(
    readonly handlerId: string,
    message: string,
  ) {
    super(message)
    this.name = "HookBlockedError"
  }
}

/** Default subprocess timeout for one handler (ms). */
export const DEFAULT_HOOK_TIMEOUT_MS = 1000
/** Maximum handler stdout/stderr captured (bytes). */
export const HOOK_OUTPUT_CAP_BYTES = 64 * 1024
