import type { ClaudePluginHooksOptions, ClaudeSessionSource, ClaudeHookSession, HookContext, HookEventName, HookHandlerSpec, HookOutput } from "./types.ts"
import type { HookTrustStore } from "./trust.ts"
import type { RunHookOptions } from "./runner.ts"

export interface HookRegistryOptions extends ClaudePluginHooksOptions {
  /** Explicit config file path; default <configDir|$IH_CONFIG_DIR|~/.i-harness>/hooks.json. */
  configPath?: string
  /** Base dir for relative trust.script paths; defaults to the config's dirname. */
  configDir?: string
  /** Subprocess env additions/overrides. */
  env?: NodeJS.ProcessEnv
  /** Observer-side failure reporter (trust/config/output errors on non-gate events). Default console.warn. */
  report?: (error: unknown) => void
  /**
   * The user-layer grant set, threaded to `loadHooksConfig`. Required for any
   * config that is NOT the harness home's own `hooks.json` — a host mounting
   * another tree's hooks must supply it, or every handler reads `valid: false`
   * (fail-closed by omission, which is the intended default and not an error).
   * The home's own config is self-granting and needs none.
   */
  approvals?: HookTrustStore
  /** Project directory supplied to Claude startup subprocesses. */
  cwd?: string
  sessionId?: string
  /** Actual root fallback; a child ToolExec/agent payload always overrides it. */
  session?: ClaudeHookSession | (() => ClaudeHookSession | undefined)
  permissionMode?: string | ((input: { session?: ClaudeHookSession; sessionId?: string }) => string)
}

/** One loaded handler with its load-time trust verdict. */
export interface LoadedHandler {
  spec: HookHandlerSpec
  /** false = may not run (a trust mismatch OR an ungranted declaration). */
  valid: boolean
  trustError?: string
  /**
   * WHY it may not run, when the reason is not tampering: this declaration has
   * never been GRANTED by the user (D1 —
   * docs/handoff/2026-09-18-prior-art-survey.md §4).
   *
   * Distinguished from a hash mismatch because the two demand OPPOSITE
   * responses, and both would otherwise read as `valid: false`:
   *   - a mismatch means someone changed an artifact the user already approved
   *     — a security event, so a gate closes;
   *   - an ungranted declaration is simply not the user's policy yet, so it must
   *     act in NEITHER direction. Closing a gate on it would let a plugin brick
   *     the agent by being enabled: every tool call refused until someone
   *     approves. That is fail-BROKEN, not fail-closed.
   */
  unapproved?: boolean
}

export interface HookRegistry {
  /** Re-evaluate trust on the mounted registry, without replaying lifecycle
   * hooks. Calls already running may finish; new gates fail closed while loading. */
  refreshTrust(approvals: Pick<HookTrustStore, "isApproved">): Promise<void>
  /** Detach this registry's event handlers from a still-running context. */
  dispose(): Promise<void>
  /**
   * Programmatic events only: session/start, session/end, subagent/stop
   * (sessionId) and notification (message). Tool/prompt/stop events are
   * fired by the mounted seams — fire() rejects them as not programmatic.
   */
  fire(event: HookEventName, input: { sessionId?: string; message?: string; session?: ClaudeHookSession; reason?: string; notificationType?: string; agentType?: string; agentId?: string; finalText?: string; signal?: AbortSignal }): Promise<void>
  beginSession(sessionId: string, source?: ClaudeSessionSource): Promise<void>
  endSession(sessionId: string): Promise<void>
  /** Loaded handlers (config order) with their trust verdicts. */
  handlers(): LoadedHandler[]
  /** Cached output from successfully trusted startup handlers for this session. */
  context(): string
}

export interface InternalRegistry {
  loaded: LoadedHandler[]
  opts: Required<Pick<HookRegistryOptions, "report" | "env">> & { configDir: string }
  /**
   * Handler ids already reported as UNGRANTED.
   *
   * Only the unapproved verdict needs this, and the asymmetry is the point. A
   * mismatch BLOCKS, so the user meets it on the first matching call and it
   * cannot repeat unboundedly — each refusal is a distinct event worth stating.
   * An ungranted declaration lets the run continue, so without this it would
   * report on every matching call for the life of the process, with nothing the
   * user could do about it until a grant UI exists. The fact never changes
   * between calls: saying it once is the signal.
   */
  reportedUnapproved: Set<string>
  run(handler: LoadedHandler, context: HookContext, input?: HookRuntimeInput): Promise<HookOutput>
  current(handler: LoadedHandler): boolean
}

export interface HookRuntimeInput extends RunHookOptions {
  session?: ClaudeHookSession
  nativeOnly?: boolean
  claudeOnly?: boolean
  promptSubmission?: boolean
  matchValue?: string
  dialect?: "posix" | "powershell" | "cmd"
}
