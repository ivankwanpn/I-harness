import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { isCascadeRedispatch, type PluginContext } from "@i-harness/core-plugin"
import type { ToolCall, ToolDecision } from "@i-harness/core-tools"
import { currentDiagnostics } from "@i-harness/diagnostics"
import type {
  HandlerMatcher,
  ClaudePluginHooksOptions,
  ClaudeSessionSource,
  ClaudeHookSession,
  HookContext,
  HookEventName,
  HookHandlerSpec,
  HookOutput,
} from "./types.ts"
import {
  HOOK_EVENTS,
  HookBlockedError,
  HookConfigError,
  HookUnsupportedFormatError,
  HookTrustError,
  HookOwnerAbortError,
  HOOK_OUTPUT_CAP_BYTES,
} from "./types.ts"
import { verifyHandlerTrust } from "./trust.ts"
import { assertAllowed, runHookHandler, type RunHookOptions } from "./runner.ts"
import { resolveHarnessHome } from "@i-harness/harness-home"
import { adaptClaudePluginHooks, claudeToolName } from "./claude.ts"
import { createClaudeTranscriptProjection } from "./claude-transcript.ts"
import { claudeRuntimeService } from "./claude-runtime.ts"

export * from "./types.ts"
import type { HookTrustStore } from "./trust.ts"

// The last two are the user-layer grant surface. They are exported because the
// rule `loadHooksConfig` enforces is UNSATISFIABLE without them — a non-home
// handler can only be granted by a store a host constructs, and only located by
// the same path helper. The two TYPES stay internal to trust.ts and are not
// re-exported: `loadHooksConfig` takes its approvals STRUCTURALLY
// (`{ isApproved(sha256): boolean }`), so no host is obliged to name either.
//
// NOTE FOR THE NEXT EDITOR: this comment sits ABOVE the export block on purpose.
// `check-reachability.mjs` reads the braces literally, so a comment INSIDE them
// is parsed as a list of exported names — measured 2026-09-18, when a five-line
// comment in there produced four phantom rows and moved the digest. It reports
// those as NEW, so the failure is at least loud rather than silent.
export {
  sha256File,
  trustScriptPath,
  verifyHandlerTrust,
  resolveHookTrustPath,
  createHookTrustStore,
} from "./trust.ts"
export { runHookHandler, validateHookOutput, assertAllowed } from "./runner.ts"
export { sha256ClaudePluginTreeSync } from "./claude.ts"

const CONFIG_FILE = "hooks.json"

/** @i-harness/settings config-home convention (no cross-package import). */
export function resolveHooksConfigPath(configDir?: string): string {
  // The explicit case keeps `resolve` (it normalises a relative dir); only the
  // default chain moves out, to the one package that resolves the harness home.
  if (configDir !== undefined) return resolve(configDir, CONFIG_FILE)
  return join(resolveHarnessHome(), CONFIG_FILE)
}

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

interface InternalRegistry {
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

interface HookRuntimeInput extends RunHookOptions {
  session?: ClaudeHookSession
  nativeOnly?: boolean
  claudeOnly?: boolean
  promptSubmission?: boolean
  matchValue?: string
  dialect?: "posix" | "powershell" | "cmd"
}

const TOOL_EVENTS = new Set<HookEventName>(["pre-tool", "post-tool", "permission"])

function compileMatcher(matcher: HandlerMatcher | undefined): (name: string) => boolean {
  if (matcher === undefined) return () => true
  const exact = matcher.tool !== undefined
    ? (name: string): boolean => name === matcher.tool
    : undefined
  const regex = matcher.toolRegex !== undefined
    ? new RegExp(matcher.toolRegex, "i")
    : undefined
  if (exact === undefined && regex === undefined) throw new HookConfigError("handler matcher must define tool and/or toolRegex")
  return (name: string): boolean => (exact !== undefined ? exact(name) : regex!.test(name))
}

/**
 * Strict config load: version 1, every handler's fields validated.
 *
 * TWO TRUST QUESTIONS, and a handler must pass both — they catch different lies:
 *
 *   1. **Was the declaration ever GRANTED?** A config's `trust.sha256` is
 *      written by whoever wrote the config, so on its own it means nothing:
 *      a config naming its own script and its own hash satisfies it entirely.
 *      The rule (D1, docs/handoff/2026-09-18-prior-art-survey.md): **a declaring
 *      layer may declare; only the user layer may grant.** The user layer is
 *      THIS config being the one the harness-home convention resolves to —
 *      derived from the path, never from a caller's claim, so another tree's
 *      `hooks/hooks.json` cannot assert its way in.
 *   2. **Do the bytes still match?** `verifyHandlerTrust` recomputes the
 *      artifact's hash. That is what catches a granted script edited later.
 *
 * `approvals` is the user-layer store. Omitted, a non-home config grants nothing
 * — fail-closed by omission rather than by a flag someone can get wrong.
 */
export async function loadHooksConfig(
  configPath: string,
  configDir: string,
  approvals?: { isApproved(sha256: string): boolean },
  options: ClaudePluginHooksOptions = {},
): Promise<LoadedHandler[]> {
  let text: string
  try {
    text = await readFile(configPath, "utf8")
  } catch (err) {
    throw new HookConfigError(`hooks config ${configPath} unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new HookConfigError(`hooks config ${configPath} is not valid JSON`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HookConfigError("hooks config must be a JSON object")
  }
  const cfg = raw as Record<string, unknown>
  // Native fields take precedence: an invalid or mixed native policy must not
  // acquire the optional-plugin containment reserved for this foreign format.
  if (!Object.hasOwn(cfg, "version") && !Object.hasOwn(cfg, "handlers")
    && typeof cfg.hooks === "object" && cfg.hooks !== null && !Array.isArray(cfg.hooks)
    && Object.values(cfg.hooks).every(Array.isArray)) {
    if (options.claudePluginRoot !== undefined) return adaptClaudePluginHooks(cfg, configPath, text, approvals, { ...options, claudePluginRoot: options.claudePluginRoot })
    throw new HookUnsupportedFormatError()
  }
  if (cfg.version !== 1) throw new HookConfigError("hooks config version must be 1")
  if (!Array.isArray(cfg.handlers)) throw new HookConfigError("hooks config must carry a handlers array")
  const userLayer = resolve(configPath) === resolve(resolveHooksConfigPath())
  const loaded: LoadedHandler[] = []
  for (const entry of cfg.handlers) {
    const spec = validateSpec(entry, configPath)
    compileMatcher(spec.matcher) // regex validity is a config error
    let trustError: string | undefined
    let unapproved = false
    try {
      await verifyHandlerTrust(spec, configDir)
    } catch (err) {
      trustError = err instanceof Error ? err.message : String(err)
    }
    if (trustError === undefined && !userLayer && approvals?.isApproved(spec.trust.sha256) !== true) {
      trustError = `hook handler ${spec.id} is not approved by the user for this source (sha256 ${spec.trust.sha256})`
      unapproved = true
    }
    loaded.push({ spec, valid: trustError === undefined, trustError, ...(unapproved ? { unapproved } : {}) })
  }
  return loaded
}

function validateSpec(entry: unknown, configPath: string): HookHandlerSpec {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new HookConfigError(`hook handler entry must be an object (${configPath})`)
  }
  const e = entry as Record<string, unknown>
  if (Object.hasOwn(e, "claude")) throw new HookConfigError("native hook declarations cannot supply runtime Claude metadata")
  if (typeof e.id !== "string" || e.id.trim() === "") throw new HookConfigError("hook handler id must be a non-blank string")
  if (!(HOOK_EVENTS as readonly string[]).includes(e.event as string)) {
    throw new HookConfigError(`hook handler ${e.id}: unknown event ${JSON.stringify(e.event)}`)
  }
  if (e.type !== "command" && e.type !== "mcpTool" && e.type !== "prompt" && e.type !== "agent") {
    throw new HookConfigError(`hook handler ${e.id}: type must be command|mcpTool|prompt|agent`)
  }
  const command = e.command as Record<string, unknown> | undefined
  if (typeof command !== "object" || command === null || typeof command.cmd !== "string" || command.cmd === "") {
    throw new HookConfigError(`hook handler ${e.id}: command.cmd must be a non-blank string`)
  }
  if (command.args !== undefined && (!Array.isArray(command.args) || !command.args.every((a) => typeof a === "string"))) {
    throw new HookConfigError(`hook handler ${e.id}: command.args must be an array of strings`)
  }
  const trust = e.trust as Record<string, unknown> | undefined
  if (typeof trust !== "object" || trust === null
    || typeof trust.script !== "string" || trust.script === ""
    || typeof trust.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(trust.sha256)) {
    throw new HookConfigError(`hook handler ${e.id}: trust.script (non-blank) and trust.sha256 (64 hex chars) are required`)
  }
  const spec: HookHandlerSpec = {
    id: e.id,
    event: e.event as HookEventName,
    type: e.type as HookHandlerSpec["type"],
    command: {
      cmd: command.cmd,
      ...(command.args !== undefined ? { args: [...command.args as string[]] } : {}),
      ...(typeof command.cwd === "string" ? { cwd: command.cwd } : {}),
    },
    trust: { script: trust.script, sha256: trust.sha256.toLowerCase() },
  }
  if (e.matcher !== undefined) {
    const m = e.matcher as Record<string, unknown>
    if (typeof m !== "object" || m === null) throw new HookConfigError(`hook handler ${e.id}: matcher must be an object`)
    const matcher: HandlerMatcher = {}
    if (typeof m.tool === "string") matcher.tool = m.tool
    if (typeof m.toolRegex === "string") matcher.toolRegex = m.toolRegex
    if (matcher.tool === undefined && matcher.toolRegex === undefined) {
      throw new HookConfigError(`hook handler ${e.id}: matcher must define tool and/or toolRegex`)
    }
    spec.matcher = matcher
  }
  if (e.timeoutMs !== undefined && (typeof e.timeoutMs !== "number" || !Number.isInteger(e.timeoutMs) || e.timeoutMs <= 0)) {
    throw new HookConfigError(`hook handler ${e.id}: timeoutMs must be a positive integer`)
  }
  if (typeof e.timeoutMs === "number") spec.timeoutMs = e.timeoutMs
  return spec
}

function matches(handler: LoadedHandler, event: HookEventName, toolName?: string, input?: HookRuntimeInput): boolean {
  if (handler.spec.event !== event) return false
  const claude = handler.spec.claude
  if (claude !== undefined) {
    if (input?.nativeOnly || event === "prompt/submit" && input?.promptSubmission === false) return false
    const pattern = claude.matcher
    if (pattern === undefined || pattern === "" || pattern === "*") return true
    if (["UserPromptSubmit", "Stop"].includes(claude.event)) return true // Claude ignores matchers for these events.
    const subject = TOOL_EVENTS.has(event) && toolName !== undefined ? claudeToolName(toolName, input?.dialect) : input?.matchValue
    return subject !== undefined && new RegExp(pattern).test(subject)
  }
  if (input?.claudeOnly) return false
  if (!TOOL_EVENTS.has(event)) return true
  if (toolName === undefined) return true
  return compileMatcher(handler.spec.matcher)(toolName)
}

/**
 * Run the handlers for one event in config order. gate:true — every failure
 * becomes assertAllowed (deny/ask/block/continue:false → HookBlockedError)
 * and every handler error (trust/output/exit/timeout) also throws
 * fail-closed. gate:false — observer semantics: errors + broken-trust handlers
 * are reported, never fatal.
 */
async function runHandlers(
  registry: InternalRegistry,
  event: HookEventName,
  context: HookContext,
  toolName?: string,
  gate = false,
  input?: HookRuntimeInput,
): Promise<HookOutput[]> {
  const outputs: HookOutput[] = []
  for (const handler of registry.loaded) {
    // Claude startup commands have a separate output/context lifecycle below.
    if (handler.spec.claude?.event === "SessionStart") continue
    if (!matches(handler, event, toolName, input)) continue
    if (!handler.valid) {
      const message = handler.trustError ?? "handler failed trust verification"
      if (handler.unapproved === true) {
        // Not the user's policy yet: acts in NEITHER direction, and is reported
        // ONCE (see InternalRegistry.reportedUnapproved).
        if (!registry.reportedUnapproved.has(handler.spec.id)) {
          registry.reportedUnapproved.add(handler.spec.id)
          registry.opts.report(new HookTrustError(handler.spec.id, handler.spec.trust.sha256, message))
        }
        continue
      }
      // A genuine mismatch: someone changed an approved artifact, so the gate
      // closes. See LoadedHandler.unapproved for why the two must differ.
      if (gate) throw new HookBlockedError(handler.spec.id, message)
      registry.opts.report(new HookTrustError(handler.spec.id, handler.spec.trust.sha256, message))
      continue
    }
    let output: HookOutput
    try {
      output = await registry.run(handler, context, input)
    } catch (err) {
      if (err instanceof HookOwnerAbortError) throw err
      if (!gate) {
        registry.opts.report(err)
        continue
      }
      throw new HookBlockedError(handler.spec.id, `handler failed closed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (gate && !(handler.spec.claude !== undefined && event === "post-tool")) assertAllowed(output, handler.spec.id)
    outputs.push(output)
  }
  return outputs
}

/** Permission handlers → ToolDecision | undefined (undefined = no decision). */
async function permissionDecision(
  registry: InternalRegistry,
  call: ToolCall & HookRuntimeInput,
): Promise<ToolDecision | undefined> {
  for (const handler of registry.loaded) {
    if (!matches(handler, "permission", call.name, call)) continue
    if (!handler.valid) {
      if (handler.spec.claude !== undefined && handler.unapproved === true) {
        if (!registry.reportedUnapproved.has(handler.spec.id)) {
          registry.reportedUnapproved.add(handler.spec.id)
          registry.opts.report(new HookTrustError(handler.spec.id, handler.spec.trust.sha256, handler.trustError ?? "handler is not approved"))
        }
        continue
      }
      return { kind: "deny", reason: `hook handler ${handler.spec.id} failed trust verification` }
    }
    let output: HookOutput
    try {
      output = await registry.run(
        handler,
        { event: "permission", tool: { name: call.name, args: call.args } },
        call,
      )
    } catch (err) {
      return { kind: "deny", reason: `hook handler ${handler.spec.id} failed closed: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (handler.spec.claude !== undefined && (output.continue === false || output.block === true)) return { kind: "deny", reason: output.reason ?? output.stopReason ?? "Claude permission hook stopped the action" }
    if (output.decision === undefined) continue
    // A plugin's allow can never grant more than IH's host permission policy.
    if (output.decision === "allow") { if (handler.spec.claude !== undefined) continue; return { kind: "allow" } }
    // ask is not wired to a question seam on main yet — fail closed as deny.
    return { kind: "deny", reason: output.reason ?? output.stopReason ?? `hook handler ${handler.spec.id} requires approval` }
  }
  return undefined
}

/**
 * Create + mount the hooks registry on the running PluginContext:
 *   - pre-tool/post-tool → `tools/execute` cascade wrap (gate);
 *   - permission         → `tools/pre-execute` plain listener producing a
 *     ToolDecision (merged by core-tools' own closed-vocabulary waterfall);
 *   - prompt/submit      → `agent/pre-step` waterfall (block ⇔ throw);
 *   - stop               → `agent/stop` listener (block ⇔ throw).
 * The config is loaded up front: an EXPLICIT configPath that is unreadable
 * throws (fail-closed); a missing DEFAULT config simply yields zero handlers
 * (the host may not use hooks at all).
 */
// W6 T6: the observer-side failure reporter's default. The registry is created
// as a host MOUNTS hooks, so its reports are phase `mount`. The body reaches the
// ambient diagnostics instance when a host installed one and is the console call
// it always was when none is: same function, same single verbatim argument. The
// `report` option's signature is untouched.
function defaultReport(err: unknown): void {
  const message = `[hooks] ${err instanceof Error ? err.message : String(err)}`
  const d = currentDiagnostics()
  if (d === undefined) console.warn(message)
  else d.child("mount").warn(message)
}

export async function createHookRegistry(
  ctx: PluginContext,
  opts: HookRegistryOptions = {},
): Promise<HookRegistry> {
  const explicitConfigPath = opts.configPath !== undefined
  const configPath = opts.configPath ?? resolveHooksConfigPath(opts.configDir)
  const configDir = opts.configDir ?? dirname(configPath)
  const projection = createClaudeTranscriptProjection()
  const runtimeService = claudeRuntimeService(ctx)
  const sessionIds = new WeakMap<ClaudeHookSession, string>()
  let ephemeralIds = 0
  const fallbackSession = (): ClaudeHookSession | undefined => typeof opts.session === "function" ? opts.session() : opts.session
  const registry: InternalRegistry = {
    loaded: [],
    reportedUnapproved: new Set<string>(),
    opts: {
      report: opts.report ?? defaultReport,
      env: opts.env ?? {},
      configDir,
    },
    current: (handler) => !disposed && registry.loaded.includes(handler) && handler.valid
      && (handler.spec.claude === undefined || activeApprovals?.isApproved(handler.spec.trust.sha256) === true),
    async run(handler, context, input = {}) {
      if (handler.spec.claude === undefined) return runHookHandler(handler.spec, context, configDir, { env: registry.opts.env, signal: input.signal, validateCurrent: () => registry.current(handler) })
      if (!registry.current(handler)) throw new HookTrustError(handler.spec.id, handler.spec.trust.sha256, "handler grant is not current")
      const fallback = fallbackSession(), session = input.session ?? fallback
      let sessionId = "sessionId" in context && context.sessionId ? context.sessionId : input.sessionId
      if (sessionId === undefined && session && session !== fallback) {
        sessionId = sessionIds.get(session)
        if (sessionId === undefined) { sessionId = `ih-ephemeral-${++ephemeralIds}`; sessionIds.set(session, sessionId) }
      }
      sessionId ??= opts.sessionId ?? ""
      const cwd = input.cwd ?? opts.cwd ?? process.cwd()
      const capture = session ? await projection.capture(session, sessionId, cwd) : undefined
      try {
        const output = await runHookHandler(handler.spec, context, configDir, {
          ...input, sessionId, cwd, env: registry.opts.env,
          validateCurrent: () => registry.current(handler),
          ...(capture ? { transcriptPath: capture.path } : {}),
          permissionMode: typeof opts.permissionMode === "function" ? opts.permissionMode({ session, sessionId }) : opts.permissionMode ?? "default",
        })
        if (!registry.current(handler)) throw new HookTrustError(handler.spec.id, handler.spec.trust.sha256, "handler grant changed during execution")
        await verifyHandlerTrust(handler.spec, configDir)
        if (session && output.additionalContext && context.event !== "session/start" && context.event !== "stop" && context.event !== "subagent/stop") {
          runtimeService.queueContext(session, output.additionalContext, () => registry.current(handler))
        }
        return output
      } finally { await capture?.release() }
    },
  }
  // Missing file: an EXPLICIT configPath fails closed (the caller named a
  // config — its absence is a hard error); a DEFAULT-derived path simply
  // yields zero handlers (a host that never configured hooks).
  if (existsSync(configPath)) {
    registry.loaded = await loadHooksConfig(configPath, configDir, opts.approvals, opts)
  } else if (explicitConfigPath) {
    throw new HookConfigError(`hooks config ${configPath} does not exist (explicit configPath)`)
  }

  const mountName = `hooks:${randomUUID()}`
  let disposed = false
  let trustRevision = 0
  let startupRevision = 0
  let activeSession: { sessionId: string; source: ClaudeSessionSource } | undefined
  let activeApprovals: Pick<HookTrustStore, "isApproved"> | undefined = opts.approvals
  type StartupResult = { handlerId: string; sha256: string; sessionId: string; source: ClaudeSessionSource; text: string }
  const startupResults = new Map<string, StartupResult>()
  const startupPending = new Map<string, { revision: number; promise: Promise<void> }>()
  const startupKey = (handler: LoadedHandler, sessionId: string, source: ClaudeSessionSource): string => JSON.stringify([handler.spec.id, handler.spec.trust.sha256, sessionId, source])
  const removeBundleContext = (handler: LoadedHandler): void => {
    for (const [key, row] of startupResults) if (row.sha256 === handler.spec.trust.sha256) startupResults.delete(key)
  }
  const removeHandlerContext = (handler: LoadedHandler): void => {
    for (const [key, row] of startupResults) if (row.handlerId === handler.spec.id && row.sha256 === handler.spec.trust.sha256) startupResults.delete(key)
  }
  async function beginSession(sessionId: string, source: ClaudeSessionSource = "startup"): Promise<void> {
    if (disposed) return
    if (activeSession?.sessionId !== sessionId || activeSession.source !== source) {
      if (activeSession?.sessionId !== sessionId) startupResults.clear()
      activeSession = { sessionId, source }; ++startupRevision
    }
    // Preserve native lifecycle observers, including their existing replay semantics.
    await runHandlers(registry, "session/start", { event: "session/start", sessionId })
    const revision = startupRevision, trust = trustRevision
    for (const handler of registry.loaded) {
      const claude = handler.spec.claude
      if (claude?.event !== "SessionStart" || claude.matcher !== undefined && claude.matcher !== "*" && claude.matcher !== "" && !new RegExp(claude.matcher).test(source)) continue
      if (!handler.valid || activeApprovals?.isApproved(handler.spec.trust.sha256) !== true) {
        removeBundleContext(handler)
        if (!registry.reportedUnapproved.has(handler.spec.id)) {
          registry.reportedUnapproved.add(handler.spec.id)
          registry.opts.report(new HookTrustError(handler.spec.id, handler.spec.trust.sha256, handler.trustError ?? "handler is not approved"))
        }
        continue
      }
      // A cached result is reusable only after checking the bundle again.
      try { await verifyHandlerTrust(handler.spec, configDir) } catch (error) {
        if (disposed || revision !== startupRevision || trust !== trustRevision || !registry.loaded.includes(handler)) return
        removeBundleContext(handler); handler.valid = false; handler.unapproved = false
        handler.trustError = error instanceof Error ? error.message : String(error)
        registry.opts.report(error); continue
      }
      if (disposed || revision !== startupRevision || trust !== trustRevision || activeSession?.sessionId !== sessionId || activeSession.source !== source) return
      const key = startupKey(handler, sessionId, source)
      if (startupResults.has(key)) continue
      const pending = startupPending.get(key)
      if (pending?.revision === revision) { await pending.promise; continue }
      const promise = (async () => {
        try {
          const output = await registry.run(handler, { event: "session/start", sessionId }, { source })
          assertAllowed(output, handler.spec.id)
          // Execution can overlap revoke, refresh, remount, or another session.
          if (disposed || revision !== startupRevision || trust !== trustRevision || !registry.loaded.includes(handler) || !handler.valid || activeApprovals?.isApproved(handler.spec.trust.sha256) !== true) return
          await verifyHandlerTrust(handler.spec, configDir)
          if (disposed || revision !== startupRevision || trust !== trustRevision || !handler.valid || activeApprovals?.isApproved(handler.spec.trust.sha256) !== true) return
          startupResults.set(key, { handlerId: handler.spec.id, sha256: handler.spec.trust.sha256, sessionId, source, text: output.additionalContext ?? "" })
        } catch (error) {
          if (disposed || revision !== startupRevision || trust !== trustRevision || !registry.loaded.includes(handler)) return
          // Exit/output failures belong to one handler. A changed or unreadable
          // bundle withdraws every sibling result sharing that content grant.
          let trustError: unknown = error instanceof HookTrustError ? error : undefined
          if (trustError === undefined) {
            try { await verifyHandlerTrust(handler.spec, configDir) } catch (failure) { trustError = failure }
          }
          if (disposed || revision !== startupRevision || trust !== trustRevision || !registry.loaded.includes(handler)) return
          if (trustError !== undefined || activeApprovals?.isApproved(handler.spec.trust.sha256) !== true) removeBundleContext(handler)
          else removeHandlerContext(handler)
          if (trustError !== undefined) {
            handler.valid = false; handler.unapproved = false
            handler.trustError = trustError instanceof Error ? trustError.message : String(trustError)
          }
          registry.opts.report(trustError ?? error)
        }
      })()
      startupPending.set(key, { revision, promise })
      try { await promise } finally { if (startupPending.get(key)?.promise === promise) startupPending.delete(key) }
    }
  }
  const removeStop = runtimeService.registerStop(async (input) => {
    if (disposed) return undefined
    const header = (input.session as ClaudeHookSession & { header?: { origin?: string } }).header
    const event = header?.origin === "subagent" ? "subagent/stop" : "stop"
    const context: HookContext = event === "stop" ? { event, sessionId: input.sessionId ?? "", finalText: input.finalText, turns: input.turns }
      : { event, sessionId: input.sessionId ?? "" }
    const outputs = await runHandlers(registry, event, context, undefined, false, {
      ...input, claudeOnly: true, agentId: input.sessionId, matchValue: input.agentType === "explore" ? "Explore" : input.agentType,
      agentType: input.agentType === "explore" ? "Explore" : input.agentType,
    })
    if (input.signal?.aborted) throw new Error("agent aborted")
    return outputs.filter(output => output.continue !== false).map(output => output.continuation).filter(Boolean).join("\n\n") || undefined
  })
  ctx.mount({ name: mountName, mount() {
  // 1+2. pre-tool / post-tool around the real tool body (tools/execute cascade).
  ctx.onCascade("tools/execute", async (input, next) => {
    const call = input as { name: string; args: unknown; commandDialect?: HookRuntimeInput["dialect"]; exec?: { session?: ClaudeHookSession; sessionId?: string; callId?: string; abortSignal?: AbortSignal } }
    const runtime: HookRuntimeInput = { session: call.exec?.session, sessionId: call.exec?.sessionId, callId: call.exec?.callId, signal: call.exec?.abortSignal, dialect: call.commandDialect }
    // M51 B1: a guard-retry RE-DISPATCH frame already had its pre-tool run
    // (approval/args are unchanged) and the frame that ran the pair owns the
    // single post-tool — skip this frame's pair so one logical call sees
    // exactly one pre-tool and one post-tool regardless of retry count and
    // mount order. The re-dispatch still enters the cascade (timeout re-arms).
    if (isCascadeRedispatch(input)) return next()
    await runHandlers(
      registry,
      "pre-tool",
      { event: "pre-tool", tool: { name: call.name, args: call.args } },
      call.name,
      true,
      runtime,
    )
    const output = await next()
    if (runtime.signal?.aborted) return output
    try {
      await runHandlers(
        registry, "post-tool", { event: "post-tool", tool: { name: call.name, args: call.args } },
        call.name, true, { ...runtime, toolOutput: output },
      )
    } catch (error) {
      // The actual body already completed. Owner cancellation of its post
      // observation must not replace that result; genuine vetoes stay loud.
      if (!(error instanceof HookOwnerAbortError) || !runtime.signal?.aborted) throw error
    }
    return output
  })

  // 3. permission: seed the pre-execute chain with a ToolDecision.
  ctx.on("tools/pre-execute", async (payload) => {
    return permissionDecision(registry, payload as ToolCall)
  })

  // 4. prompt/submit: waterfall on agent/pre-step (block ⇔ throw).
  ctx.waterfall("agent/pre-step", async (payload, next) => {
    const resolved = await next(payload)
    const p = resolved as { task?: string; session?: ClaudeHookSession; sessionId?: string; promptSubmission?: boolean; signal?: AbortSignal }
    await runHandlers(
      registry,
      "prompt/submit",
      { event: "prompt/submit", prompt: typeof p.task === "string" ? p.task : "" },
      undefined,
      true,
      { session: p.session, sessionId: p.sessionId, signal: p.signal, promptSubmission: p.promptSubmission },
    )
    return resolved
  })

  // 5. stop: plain listener on agent/stop (block ⇔ throw).
  ctx.on("agent/stop", async (payload) => {
    const p = payload as { sessionId?: string; finalText?: string; turns?: number }
    await runHandlers(
      registry,
      "stop",
      {
        event: "stop",
        sessionId: typeof p.sessionId === "string" ? p.sessionId : "",
        finalText: typeof p.finalText === "string" ? p.finalText : "",
        turns: typeof p.turns === "number" ? p.turns : 0,
      },
      undefined,
      true,
      { nativeOnly: true },
    )
  })

  } })
  return {
    async refreshTrust(approvals) {
      if (disposed) throw new HookConfigError("hooks registry is disposed")
      const revision = ++trustRevision
      ++startupRevision
      activeApprovals = approvals
      const previous = [...startupResults.entries()]
      startupResults.clear()
      registry.loaded = registry.loaded.map((row) => ({ ...row, valid: false, unapproved: false, trustError: "Hook trust refresh is in progress" }))
      const loaded = await loadHooksConfig(configPath, configDir, approvals, opts)
      if (disposed || revision !== trustRevision) return
      registry.loaded = loaded
      registry.reportedUnapproved.clear()
      for (const [key, result] of previous) {
        if (result.sessionId === activeSession?.sessionId && loaded.some(handler => handler.valid && handler.spec.claude !== undefined && handler.spec.id === result.handlerId && handler.spec.trust.sha256 === result.sha256)) startupResults.set(key, result)
      }
    },
    async dispose() { if (disposed) return; disposed = true; removeStop(); ++startupRevision; startupResults.clear(); await ctx.unmount(mountName); registry.loaded = []; await projection.dispose() },
    async fire(event, input) {
      if (event === "session/start" || event === "session/end" || event === "subagent/stop") {
        if (typeof input.sessionId !== "string") {
          throw new HookConfigError(`hooks fire(${event}) requires sessionId`)
        }
        if (event === "session/start") await beginSession(input.sessionId)
        else await runHandlers(registry, event, { event, sessionId: input.sessionId }, undefined, false, {
          ...input, matchValue: event === "session/end" ? input.reason ?? "other" : input.agentType === "explore" ? "Explore" : input.agentType,
        })
      } else if (event === "notification") {
        await runHandlers(registry, "notification", { event: "notification", message: input.message ?? "" }, undefined, false, {
          ...input, matchValue: input.notificationType ?? "ih_notification",
        })
      } else {
        throw new HookConfigError(`hooks fire(${event}) is not a programmatic event`)
      }
    },
    beginSession,
    async endSession(sessionId) {
      await runHandlers(registry, "session/end", { event: "session/end", sessionId }, undefined, false, { matchValue: "other" })
    },
    handlers: () => registry.loaded.map((h) => ({ ...h, spec: structuredClone(h.spec) })),
    context() {
      if (disposed || activeSession === undefined) return ""
      const parts: string[] = []
      for (const handler of registry.loaded) {
        if (handler.spec.claude === undefined) continue
        if (!handler.valid || activeApprovals?.isApproved(handler.spec.trust.sha256) !== true) { removeBundleContext(handler); continue }
        const output = startupResults.get(startupKey(handler, activeSession.sessionId, activeSession.source))
        if (output?.text) parts.push(output.text)
      }
      return Buffer.from(parts.join("\n\n")).subarray(0, HOOK_OUTPUT_CAP_BYTES).toString("utf8")
    },
  }
}
