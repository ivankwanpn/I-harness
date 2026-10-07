// packages/session-executor/src/service.ts — R-C0 (engine-owned posture).
// The GLOBAL per-session service. A-region owns the per-session serial lane
// (packages/core-agent/src/executor.ts: createSessionExecutor over
// { session, agent, inbox } — four-tier input admits + serial pump + drain);
// THIS module is a thin registry wrapper over those instances and owns the
// get-or-create assembly lifecycle, the onAssembly bridge attach point, and
// the service-level submit pacing. The web host owns only transport.
//
// Naming note (M26 execution): the C-plan defined this GLOBAL surface as
// `SessionExecutor`, but A-region had ALREADY landed `SessionExecutor` as the
// PER-SESSION lane — so the global one is `SessionService`
// (createSessionService / SessionServiceOptions). A's sessionId-keyed
// SessionExecutorRegistry pattern is not re-exported: this class IS the
// registry (keyed by session id, one lane each).
//
// A-plan adaptation (verified at execution): the plan's
// `submit(sessionId, prompt, signal)` mapped to "tier-0 send with an
// in-memory per-session chain". The chain is now A's OWN per-session serial
// lane (submit: { tier: "send" }); the pacing chain here only skips aborted
// queued turns. A's `drain()` REJECTS on the first turn failure (CLI
// exit-code contract) — this service REJECTS submit with that error so the
// web-host opener maps the rejection to an `{status:"error"}` frame.
import { createHash, randomUUID } from "node:crypto"
import { append, validateImages, type ImageInput, type Session } from "@i-harness/core-session"
import type { SandboxMode } from "@i-harness/sandbox"
import { createSessionExecutor, type SessionExecutor as SessionTurnLane, type ReasoningEffort } from "@i-harness/core-agent"
import type { ModelClient } from "@i-harness/llm-seam"
import type { OutputSpillGuardConfig } from "@i-harness/output-retention"
import { ParentNotificationStoppedError, type AgentTaskView } from "@i-harness/subagent"
import type { SessionMeta } from "@i-harness/session-persistence"
import type { Telemetry } from "@i-harness/telemetry"
import { diagnosticsFor } from "@i-harness/diagnostics"
import { breakdown } from "@i-harness/token-meter"

// W6 T6: ONE module-scope handle for this file's single report. The phase is
// `session`: the message is about THIS session's resolved model binding (a
// window-less binding disables auto-compaction despite the requested config),
// and the service is the per-session registry that owns the assembly
// lifecycle. With nothing installed the handle delegates to console.warn
// verbatim (one argument) — unset mode is the pre-migration bytes.
const d = diagnosticsFor("session")
import {
  createSessionAssembly,
  ModelUnavailableError,
  type AssemblyOptions,
  type SessionAssembly,
  type SessionProjectContext,
} from "./assembly.ts"

export type SessionModelBindingResult =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | {
      status: "ready"
      binding: {
        model: ModelClient
        providerId: string
        modelId: string
        label: string
        protocol?: string
        reasoningEffort?: ReasoningEffort
        reasoningEfforts?: ReasoningEffort[]
        contextWindow?: number
        /** M72 Ⅱ: the resolved output cap. Absent → nothing was resolved, and
         * nothing is defaulted in its place (the adapter sends none). */
        maxOutputTokens?: number
        imageInput?: true
      }
    }

/** Task 4: the installable half of a resolved binding — a `ready` result with
 * the status discriminator stripped. What `rebindModel` takes from the host,
 * which resolved it (only the host owns the runtime and the wire's optional
 * protocol). Not exported: the public shape is `SessionModelBindingResult`. */
type ReadyModelBinding = Extract<SessionModelBindingResult, { status: "ready" }>["binding"]

/** M49 Task 11 (spec §8.1): one row of the real session queue projection.
 * `order` is the per-session FIFO ordinal; the running row is always
 * reported FIRST by queue() — the rest follow FIFO by `order`. */
export interface SessionQueueItem {
  id: string
  text: string
  delivery: "queue" | "steer"
  intent: "user" | "system"
  state: "queued" | "running"
  order: number
}

type SessionModelState =
  | Exclude<SessionModelBindingResult, { status: "ready" }>
  | { status: "ready"; providerId: string; modelId: string; label: string; protocol?: string; reasoningEffort?: ReasoningEffort; reasoningEfforts?: ReasoningEffort[]; imageInput?: true }

export interface SessionServiceOptions extends AssemblyOptions {
  /** Host structural management shares this admission boundary with all writers. */
  sessionOperation?: { run<T>(id: string, operation: () => Promise<T>): Promise<T>; assertOpen(id: string): void }
  /** Bind the session once; its returned getter follows current membership. */
  projectContextFor?: (sessionId: string) => Promise<() => SessionProjectContext | undefined>
  executionAuthorityFor?: (sessionId: string) => Promise<NonNullable<AssemblyOptions["executionAuthority"]>>
  windowsSandboxBackendFor?: () => "legacy" | "psec"
  transformPrompt?: (assembly: SessionAssembly, prompt: string) => Promise<string>
  /** Host-owned post-turn work runs within this session's submit lane. Failure
   * is reported but never changes a successfully completed Agent turn. */
  afterSuccessfulSubmit?: (sessionId: string, assembly: SessionAssembly, limits: { contextWindow?: number; maxOutputTokens?: number }) => Promise<void>
  /** Trusted host extension snapshot, re-read for each new assembly. */
  extensionsFor?: (sessionId: string) => Promise<{
    options: Pick<AssemblyOptions, "skills" | "pluginMcp" | "pluginAgents" | "pluginAgentsEphemeral">
    mount?: (assembly: SessionAssembly) => Promise<(() => void | Promise<void>) | void>
    update?: (assembly: SessionAssembly) => Promise<void>
  }>
  beforeDispose?: () => Promise<void>
  /** Shared host event stream (also handed to each assembly). */
  telemetry?: Telemetry
  /** Metadata source for an assembly's FIRST build (the tier-1 model chain
   * input, e.g. session.meta.modelSelection). Absent → no meta. */
  loadMeta?: (sessionId: string) => Promise<SessionMeta | undefined>
  /** Legacy per-assembly model resolution. Absent or unresolved means the
   * assembly follows modelPolicy (production defaults to required). */
  modelBuilder?: (sessionId: string, meta: SessionMeta | undefined) => Promise<ModelClient | undefined>
  /** Atomic per-session model resolution. The local structural type keeps
   * session-executor independent of provider-runtime; app composition adapts
   * the provider result at this boundary. */
  modelBindingFor?: (
    sessionId: string,
    meta: SessionMeta | undefined,
  ) => Promise<SessionModelBindingResult>
  /** Resolve a host-seeded session per id. When defined, it takes precedence
   * over the static `session` option for every assembly build. */
  sessionFor?: (sessionId: string) => Promise<Session | undefined>
  /** M31 T3: per-session context-window resolver — evaluated at EVERY assembly
   * build (meta-aware, so session.modelSelection drives the window). When
   * defined it ALWAYS wins over the static AssemblyOptions.contextWindow
   * (undefined → fail-closed, get_context_remaining not registered); absent →
   * the static value (legacy path). */
  contextWindowFor?: (sessionId: string, meta: SessionMeta | undefined) => number | undefined
  /** M32 T3: per-session reasoning-effort resolver — evaluated at EVERY
   * assembly build (meta-aware: session.meta.modelSelection.reasoningEffort).
   * When defined it ALWAYS wins over the static AssemblyOptions.
   * reasoningEffort; absent → the static value (or never set). */
  reasoningEffortFor?: (sessionId: string, meta: SessionMeta | undefined) => ReasoningEffort | undefined
  /** M5 T4 block ③ B1: the registry-level tool-output bound. Declared here —
   * although AssemblyOptions already carries it — because THIS interface is the
   * host contract for `i-harness sdk` and `i-harness acp`: those hosts own no
   * assembly call of their own, so this option is how the bound reaches them,
   * and it is named where a host reads its surface. The assembly keeps its own
   * ruling (absent = the guard is NOT mounted); the call sites opt in.
   *
   * BOTH `createSessionAssembly` calls below carry it through their `...opts`
   * spread, so there is no second line to find: the spread IS the threading.
   * Each call site is pinned by a case of its OWN in
   * `packages/session-executor/test/service-output-spill.test.ts` — the
   * binding-path call by the tests that supply `modelBindingFor`, the legacy
   * call by the third case (`modelBuilder`, which is what routes a build to it).
   * Verified at execution one site at a time: shadowing the field at a site
   * reddens THAT site's case and leaves the others green, and each case drives
   * a real over-cap tool result into the durable record. NARROWING a spread to
   * an explicit field list therefore has to list `outputSpill`. */
  outputSpill?: OutputSpillGuardConfig
}

export interface SessionService {
  /** Update plugin-owned capabilities without replacing sessions or agents. */
  refreshExtensions(): Promise<void>
  /** One prompt for one session (tier send). Serialized per session;
   * cross-session parallel. An aborted QUEUED submit never runs. REJECTS when
   * the session's turn lane failed (drain rejection → the host maps it to an
   * error frame). */
  submit(sessionId: string, prompt: string, signal: AbortSignal, options?: { context?: string; images?: ImageInput[]; clientToken?: string; admittedInputId?: string }): Promise<void>
  assemblyFor(sessionId: string): Promise<SessionAssembly>
  /** Resolve serializable model state without constructing an assembly. */
  modelState(sessionId: string): Promise<SessionModelState>
  /** Estimated active transcript size; no provider request is made. */
  contextState(sessionId: string): Promise<{ kind: "ready"; estimatedTokens: number; contextWindow: number; roleTokens: { user: number; assistant: number; tool: number } } | { kind: "unavailable"; reason: string }>
  /** Task 4 (F1): install a HOST-RESOLVED model binding for a session — the
   * `session/model/set` rebind. The host resolves because only it owns the
   * runtime and the wire's optional protocol (§4.2②); this method makes the
   * install reach the two REPORTING surfaces as well: the memoised binding
   * (what `modelState` and the dashboard row report — previously only
   * `closeSession` cleared it) and, when the session is LIVE, the assembly's
   * handle plus its label, and the binding's reasoning effort — the whole
   * resolved selection, so no field of it can go stale (review F-1; an absent
   * effort CLEARS the live one). It NEVER disposes an assembly: the live rebind
   * IS the point. Returns whether a live assembly was retargeted; false means
   * nothing was live, and the refreshed binding is what the next build in this
   * process starts from. A live idle rebind installs context/output limits and
   * the compactor with the client before updating the reported binding. Busy
   * sessions and active agent tasks reject rebind rather than mixing models. */
  rebindModel(sessionId: string, binding: ReadyModelBinding): boolean
  liveSession(sessionId: string): Session | undefined
  /** Synchronous observation only; never resolves a model or constructs an Agent. */
  liveAssembly(sessionId: string): SessionAssembly | undefined
  hasAssembly(sessionId: string): boolean
  /** Per-session lane observation for the jobs/queue surface:
   * running = a turn is executing; queued = registered submit turns not yet
   * started (the service pacing chain, in front of the lane). */
  queueState(sessionId: string): { running: boolean; queued: number }
  /** M49 Task 11 (spec §8.1): the REAL per-session queue projection —
   * service-front (pacing chain) rows merged with lane rows by public id;
   * the running row is first, the rest FIFO. Never fabricated: {} here means
   * literally no queued/running work for the session. */
  queue(sessionId: string): SessionQueueItem[]
  /** Cancel ONE queued row by its stable public id: the submit settles without
   * executing (never leaving the lane to turn). `cancelled: false` for an
   * unknown/already-finished row or a RUNNING one (whole-turn cancel is
   * session/cancel, not row cancel). */
  cancelQueued(sessionId: string, id: string): { cancelled: boolean }
  /** Cancel the executing submission; queued submissions retain their own controllers. */
  cancelRunning?(sessionId: string): { cancelled: boolean }
  /** M49 Task 12 (spec §8.2): the per-session task projection (assembly tasks
   * rows — subagent/job/workflow). Workflow rows are attributed to the session
   * that started the run (the run-level store is shared — another session's
   * workflow jobs never leak into this projection; runs started outside a
   * session surface belong to the run-level /workflow panel and appear in no
   * session's list). Never fabricated: a session with no live assembly answers
   * an honest empty list. */
  tasks(sessionId: string): AgentTaskView[]
  /** M49 Task 12: cancel ONE task through the owning assembly (its registries
   * hold the authority). An id with no owner (unknown session/unknown id)
   * throws the registry's not-found error — never a silent success. */
  cancelTask(sessionId: string, id: string): "cancellation-requested" | "already-finished"
  /** Fires once per created assembly — the bridge attach point
   * (approval/question bridges). */
  onAssembly(hook: (assembly: SessionAssembly) => void): () => void
  /** Changes the standing sandbox on existing and future assemblies. */
  updateSandboxMode(mode: SandboxMode): Promise<void>
  reconcileExecutionAuthority(sessionIds?: readonly string[]): Promise<void>
  executionBackendStatus(): Promise<readonly { sessionId: string; status: unknown }[]>
  /** Wait for this session's pending work/build/model resolution, remove its
   * cached state and assembly, and dispose only that assembly. A later
   * request resolves and builds it again. */
  closeSession(sessionId: string): Promise<void>
  /** Wait for active turns, then dispose every assembly best-effort. NEVER
   * closes a caller-owned telemetry stream or coordinator. */
  close(): Promise<void>
}

export function createSessionService(opts: SessionServiceOptions): SessionService {
  const assemblies = new Map<string, SessionAssembly>()
  const mountingAssemblies = new Map<string, SessionAssembly>()
  const ownedAssemblies = () => new Map([...mountingAssemblies, ...assemblies])
  const lanes = new Map<string, SessionTurnLane>()
  const creating = new Map<string, Promise<SessionAssembly>>()
  const modelBindings = new Map<string, Promise<SessionModelBindingResult>>()
  const extensionRefreshes = new Map<string, Promise<void>>()
  const extensionCleanups = new Map<string, () => void | Promise<void>>()
  const hooks = new Set<(assembly: SessionAssembly) => void>()
  const chains = new Map<string, Promise<void>>()
  const active = new Set<Promise<void>>()
  const closing = new Map<string, Promise<void>>()
  const telemetry = opts.telemetry
  let closed = false
  let currentSandbox = opts.sandbox
  const cancelledParents = new Set<string>()
  const notificationAdmissions = new Map<string, Promise<void>>()
  const notificationInputs = new Map<string, Set<string>>()
  const notificationControllers = new Map<string, Map<string, AbortController>>()
  const notificationStops = new Set<Promise<void>>()
  function stopNotifications(id: string): void {
    cancelledParents.add(id)
    for (const controller of notificationControllers.get(id)?.values() ?? []) controller.abort()
    const assembly = assemblies.get(id)
    let cancelled = false
    for (const input of assembly?.inbox.pending() ?? []) {
      if (input.intent === "system" && input.inputId.startsWith("parent-notify-")) cancelled = assembly!.inbox.cancel(input.inputId, "parent stopped") || cancelled
    }
    if (cancelled && opts.coordinator) {
      const job = opts.coordinator.flush(id)
      notificationStops.add(job)
      void job.catch((error) => d.warn(`[i-harness] parent notification cancellation flush failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => notificationStops.delete(job))
    }
  }
  function parentNotifyFor(id: string, owner: () => SessionAssembly | undefined): NonNullable<AssemblyOptions["parentNotify"]> {
    if (opts.parentNotify) return opts.parentNotify
    return {
      admit(input) {
        const previousAdmission = notificationAdmissions.get(id) ?? Promise.resolve()
        const admission = async () => previousAdmission.catch(() => undefined).then(async () => {
          const assembly = assemblies.get(id)
          if (closed || closing.has(id) || cancelledParents.has(id)) throw new ParentNotificationStoppedError()
          if (input.sessionId !== id || !assembly || assembly !== owner()) throw new Error("parent notification admission unavailable")
          const inputId = `parent-notify-${createHash("sha256").update(input.text).update(input.description).digest("hex")}`
          if (!assembly.session.events.some((event) => event.type === "agent/input/admitted" && event.inputId === inputId)) {
            assembly.inbox.admit({ inputId, text: input.text, delivery: "steer", intent: "system", synthetic: { description: input.description, scope: "turn", ...(input.display !== undefined ? { display: input.display } : {}) } })
          }
          await opts.coordinator?.flush(id)
          if (closed || closing.has(id) || cancelledParents.has(id)) {
            assembly.inbox.cancel(inputId, "parent stopped during admission")
            await opts.coordinator?.flush(id)
            throw new ParentNotificationStoppedError()
          }
          let inputs = notificationInputs.get(id)
          if (!inputs) { inputs = new Set(); notificationInputs.set(id, inputs) }
          inputs.add(inputId)
        })
        const job = opts.sessionOperation ? opts.sessionOperation.run(id, admission) : admission()
        notificationAdmissions.set(id, job)
        void job.finally(() => { if (notificationAdmissions.get(id) === job) notificationAdmissions.delete(id) }).catch(() => undefined)
        return job
      },
      wake(sessionId) {
        if (sessionId !== id || closed || closing.has(id) || cancelledParents.has(id)) return
        try { opts.sessionOperation?.assertOpen(id) } catch { return }
        const assembly = assemblies.get(id)
        if (!assembly || assembly !== owner()) return
        let controllers = notificationControllers.get(id)
        if (!controllers) { controllers = new Map(); notificationControllers.set(id, controllers) }
        for (const inputId of notificationInputs.get(id) ?? []) {
          const input = assembly.inbox.pending().find((row) => row.inputId === inputId)
          if (!input || controllers.has(inputId)) continue
          const controller = new AbortController()
          controllers.set(inputId, controller)
          void submit(id, input.text, controller.signal, { admittedInputId: inputId }).catch(() => {
            // The service already emits its execution error; never re-admit.
          }).finally(() => { controllers!.delete(inputId); notificationInputs.get(id)?.delete(inputId) })
        }
      },
    }
  }

  // M49 Task 11: the per-session queue projection state. ONE record per
  // submit (and per adopted lane-only steer), keyed by the STABLE public id
  // generated BEFORE the pacing chain. `wait` = service-front (not yet
  // admitted to the lane); `queued` = admitted and pending; `running` = the
  // lane's current turn; `cancelled` = abort-before-run (hidden, settled by
  // the chain hand-over). Records are removed exactly once on settle/error/
  // cancel/close (the submit cleanup + the queue() finished-purge).
  interface QueueRowRecord {
    id: string
    text: string
    delivery: "queue" | "steer"
    intent: "user" | "system"
    order: number
    controller: AbortController
    state: "wait" | "queued" | "running" | "cancelled"
    scheduled?: boolean
  }
  interface SessionQueueState {
    byId: Map<string, QueueRowRecord>
    /** Next submission-order ordinal (per-session FIFO among service rows). */
    nextOrder: number
    /** Steer-adoption ladder: orders live inside (window, window+1) so they
     * sort after every already-admitted record and before the next one —
     * the adopted steer was admitted DURING the running record's turn. */
    adoptWindow: number
    adoptCount: number
  }
  const queues = new Map<string, SessionQueueState>()

  function sessionQueueState(sessionId: string): SessionQueueState {
    let st = queues.get(sessionId)
    if (st === undefined) {
      st = { byId: new Map(), nextOrder: 1, adoptWindow: 0, adoptCount: 0 }
      queues.set(sessionId, st)
    }
    return st
  }

  /** Order for a lane-only steer adopted at first sight: strictly inside
   * (admittedWindow, admittedWindow+1), the ladder after the currently
   * running record's order — bounded below by the next unadmitted record. */
  function adoptOrder(st: SessionQueueState, window: number): number {
    if (st.adoptWindow !== window) {
      st.adoptWindow = window
      st.adoptCount = 0
    }
    st.adoptCount += 1
    return window + 1 - Math.pow(0.5, st.adoptCount)
  }

  function bindingFor(sessionId: string): Promise<SessionModelBindingResult> {
    let pending = modelBindings.get(sessionId)
    if (pending === undefined) {
      const resolveBinding = opts.modelBindingFor
      pending = resolveBinding === undefined
        ? Promise.resolve({ status: "unconfigured", reason: "No model configured" })
        : (async () => {
            const meta = opts.loadMeta === undefined ? undefined : await opts.loadMeta(sessionId)
            return resolveBinding(sessionId, meta)
          })()
      modelBindings.set(sessionId, pending)
      const attempt = pending
      // A missing key/default can be repaired while this host stays alive.
      // Keep successful bindings stable; only failed resolution is retryable.
      void attempt.then((result) => {
        if (result.status !== "ready" && modelBindings.get(sessionId) === attempt) modelBindings.delete(sessionId)
      }, () => { if (modelBindings.get(sessionId) === attempt) modelBindings.delete(sessionId) })
    }
    return pending
  }

  async function modelState(sessionId: string): Promise<SessionModelState> {
    if (closed) throw new Error("session service closed")
    const pendingClose = closing.get(sessionId)
    if (pendingClose !== undefined) await pendingClose
    if (closed) throw new Error("session service closed")
    const result = await bindingFor(sessionId)
    if (result.status !== "ready") return result
    return {
      status: "ready",
      providerId: result.binding.providerId,
      modelId: result.binding.modelId,
      label: result.binding.label,
      ...(result.binding.protocol ? { protocol: result.binding.protocol } : {}),
      ...(result.binding.reasoningEffort ? { reasoningEffort: result.binding.reasoningEffort } : {}),
      ...(result.binding.reasoningEfforts ? { reasoningEfforts: [...result.binding.reasoningEfforts] } : {}),
      ...(result.binding.imageInput ? { imageInput: true } : {}),
    }
  }

  async function contextState(sessionId: string): Promise<{ kind: "ready"; estimatedTokens: number; contextWindow: number; roleTokens: { user: number; assistant: number; tool: number } } | { kind: "unavailable"; reason: string }> {
    if (closed) throw new Error("session service closed")
    const model = await bindingFor(sessionId)
    if (model.status !== "ready") return { kind: "unavailable", reason: model.reason }
    const window = model.binding.contextWindow
    if (window === undefined) return { kind: "unavailable", reason: "This model has no configured context window" }
    const session = assemblies.get(sessionId)?.session ?? await opts.sessionFor?.(sessionId) ?? opts.session
    if (session === undefined) return { kind: "unavailable", reason: "Session history is unavailable" }
    const measured = breakdown(session)
    const roleTokens = { user: 0, assistant: 0, tool: 0 }
    for (const message of measured.perMessage) roleTokens[message.role] += message.tokens
    return { kind: "ready", estimatedTokens: measured.total, contextWindow: window, roleTokens }
  }

  function rebindModel(sessionId: string, binding: ReadyModelBinding): boolean {
    if (closed) throw new Error("session service closed")
    if (chains.has(sessionId) || creating.has(sessionId) || closing.has(sessionId)) throw new Error("session is busy")
    const live = assemblies.get(sessionId)
    if (live?.tasks().some(task => task.group !== "job" && ["queued", "running", "waiting"].includes(task.status))) throw new Error("session has active agent tasks")
    if (live !== undefined) {
      if (!live.setModelBinding) throw new Error("assembly does not support atomic model binding")
      live.setModelBinding(binding, opts.compact)
    }
    // Publish only after the live assembly accepted the complete binding.
    modelBindings.set(sessionId, Promise.resolve({ status: "ready", binding }))
    const assembly = assemblies.get(sessionId)
    if (assembly === undefined) return false
    assembly.modelLabel = binding.label
    return true
  }

  function getOrCreate(sessionId: string): Promise<SessionAssembly> {
    return opts.sessionOperation ? opts.sessionOperation.run(sessionId, () => getOrCreateUnfenced(sessionId)) : getOrCreateUnfenced(sessionId)
  }
  async function getOrCreateUnfenced(sessionId: string): Promise<SessionAssembly> {
    if (closed) throw new Error("session service closed")
    if (failedClose.has(sessionId)) throw new Error("Session process cleanup incomplete; retry close before admission")
    const pendingClose = closing.get(sessionId)
    if (pendingClose !== undefined) await pendingClose
    if (closed) throw new Error("session service closed")
    const existing = assemblies.get(sessionId)
    if (existing !== undefined) return existing
    let pending = creating.get(sessionId)
    if (pending === undefined) {
      pending = (async () => {
        const extensions = await opts.extensionsFor?.(sessionId)
        const projectContext = opts.projectContextFor ? await opts.projectContextFor(sessionId) : opts.projectContext
        const executionAuthority = opts.executionAuthorityFor ? await opts.executionAuthorityFor(sessionId) : opts.executionAuthority
        let assembly: SessionAssembly
        const executionCallerAvailable = () => !closed && !closing.has(sessionId) && !failedClose.has(sessionId)
          && (liveAssembly(sessionId) === assembly || mountingAssemblies.get(sessionId) === assembly)
        let sandboxAtBuild: SandboxMode | undefined
        if (opts.modelBindingFor !== undefined) {
          const result = await bindingFor(sessionId)
          if (result.status !== "ready") throw new ModelUnavailableError(result.reason)
          const binding = result.binding
          // The BINDING is authoritative here: `modelBindingFor` exists so that
          // state and construction share one resolution, so its window decides
          // and its ABSENCE disables compaction. A window the host put in the
          // config must not override a binding that deliberately has none — the
          // service test for this supplies `contextWindow: 1`, which would leave
          // the engine permanently over threshold.
          //
          // What changed is the SILENCE, not the rule: this used to drop the
          // request without a word. It now says so, because the caller asked for
          // compaction and will otherwise assume it is running.
          const compact = binding.contextWindow !== undefined ? opts.compact : undefined
          if (opts.compact !== undefined && binding.contextWindow === undefined) {
            d.warn(
              "[i-harness] the resolved model binding carries no contextWindow, so auto-compaction is DISABLED for this session despite the requested config. " +
                "The binding is authoritative — a window from the config is not used to override its absence.",
            )
          }
          const resolvedSession = opts.sessionFor === undefined ? opts.session : await opts.sessionFor(sessionId)
          sandboxAtBuild = currentSandbox
          assembly = await createSessionAssembly({
            ...opts,
            sandbox: sandboxAtBuild,
            ...extensions?.options,
            projectContext,
            executionAuthority,
            executionCallerAvailable,
            windowsSandboxBackend: opts.windowsSandboxBackendFor?.() ?? opts.windowsSandboxBackend,
            parentNotify: parentNotifyFor(sessionId, () => assembly),
            sessionId,
            session: resolvedSession,
            model: binding.model,
            modelLabel: binding.label,
            contextWindow: binding.contextWindow,
            maxOutputTokens: binding.maxOutputTokens,
            reasoningEffort: binding.reasoningEffort,
            compact,
          })
        } else {
          // Legacy path retained for explicit embedders; production apps use
          // modelBindingFor so state and construction share one resolution.
          const meta = opts.loadMeta === undefined ? undefined : await opts.loadMeta(sessionId)
          const model = opts.modelBuilder === undefined ? undefined : await opts.modelBuilder(sessionId, meta)
          const resolvedSession = opts.sessionFor === undefined ? opts.session : await opts.sessionFor(sessionId)
          // M31 T3: per-session window (meta-aware) — a defined contextWindowFor
          // decides even when it resolves to undefined (fail-closed).
          const contextWindow = opts.contextWindowFor === undefined
            ? opts.contextWindow
            : opts.contextWindowFor(sessionId, meta)
          // M32 T3: per-session effort (same meta-driven pattern as the window).
          // A DEFINED resolver always wins — even when it resolves to undefined
          // (the explicit spread below overrides the `...opts` static value; the
          // assembly treats undefined as "never set").
          const reasoningEffort = opts.reasoningEffortFor === undefined
            ? opts.reasoningEffort
            : opts.reasoningEffortFor(sessionId, meta)
          sandboxAtBuild = currentSandbox
          assembly = await createSessionAssembly({
            ...opts,
            sandbox: sandboxAtBuild,
            ...extensions?.options,
            projectContext,
            executionAuthority,
            executionCallerAvailable,
            windowsSandboxBackend: opts.windowsSandboxBackendFor?.() ?? opts.windowsSandboxBackend,
            parentNotify: parentNotifyFor(sessionId, () => assembly),
            sessionId,
            session: resolvedSession,
            ...(model !== undefined ? { model } : {}),
            ...(opts.contextWindowFor !== undefined ? { contextWindow } : {}),
            ...(opts.reasoningEffortFor !== undefined ? { reasoningEffort } : {}),
          })
        }
        if (currentSandbox !== sandboxAtBuild && currentSandbox !== undefined) append(opts.policySession ?? assembly.session, { type: "sandbox/mode", mode: currentSandbox })
        mountingAssemblies.set(sessionId, assembly)
        if (extensions?.mount) {
          try {
            const cleanup = await extensions.mount(assembly)
            if (cleanup) {
              extensionCleanups.set(sessionId, cleanup)
            }
          } catch (error) { await assembly.dispose(); mountingAssemblies.delete(sessionId); throw error }
        }
        if (opts.extensionsFor) {
          const dispose = assembly.dispose.bind(assembly)
          let disposing: Promise<void> | undefined
          assembly.dispose = () => {
            if (disposing) return disposing
            const pending = (async () => {
              await extensionRefreshes.get(sessionId)?.catch(() => undefined)
              const failures: unknown[] = []
              const current = extensionCleanups.get(sessionId)
              try { await current?.(); extensionCleanups.delete(sessionId) } catch (error) { failures.push(error) }
              try { await dispose() } catch (error) { failures.push(error) }
              if (failures.length) throw new AggregateError(failures, "Assembly extension/process cleanup incomplete")
            })()
            disposing = pending
            void pending.then(() => { disposing = undefined }, () => { disposing = undefined })
            return pending
          }
        }
        // No await between this reconciliation and publication. A settings
        // change during an asynchronous extension mount must not miss an
        // assembly that was not yet present in the live map.
        assemblies.set(sessionId, assembly)
        mountingAssemblies.delete(sessionId)
        assembly.ctx.on("agent/pre-step", async () => { await extensionRefreshes.get(sessionId)?.catch(() => undefined) })
        // The A-region serial lane over this assembly (tiers; send on submit).
        lanes.set(sessionId, createSessionExecutor({
          session: assembly.session,
          agent: assembly.agent,
          inbox: assembly.inbox,
        }))
        // Hooks fire ONCE per assembly, after registration, inside the shared
        // pending — concurrent racers never double-attach (ApprovalMuxBridge
        // registers its answerer per ctx; a double attach would register twice).
        for (const hook of [...hooks]) hook(assembly)
        // Recovery admission needs the exact published parent and its lane.
        // Waking schedules through submit without awaiting that turn here.
        try { await assembly.drainParentNotifications?.() }
        catch (error) { d.warn(`[i-harness] parent notification recovery failed: ${error instanceof Error ? error.message : String(error)}`) }
        return assembly
      })().finally(() => { creating.delete(sessionId) })
      creating.set(sessionId, pending)
    }
    return pending
  }

  function submit(sessionId: string, prompt: string, signal: AbortSignal, options?: { context?: string; images?: ImageInput[]; clientToken?: string; admittedInputId?: string }): Promise<void> {
    return opts.sessionOperation ? opts.sessionOperation.run(sessionId, () => submitUnfenced(sessionId, prompt, signal, options)) : submitUnfenced(sessionId, prompt, signal, options)
  }
  function submitUnfenced(sessionId: string, prompt: string, signal: AbortSignal, options?: { context?: string; images?: ImageInput[]; clientToken?: string; admittedInputId?: string }): Promise<void> {
    const context = options?.context
    if (context !== undefined && (typeof context !== "string" || context.length > 131072)) return Promise.reject(new Error("Invalid prompt context"))
    const clientToken = options?.clientToken
    if (clientToken !== undefined && (typeof clientToken !== "string" || clientToken.length < 8 || clientToken.length > 128)) return Promise.reject(new Error("Invalid prompt client token"))
    const images = options?.images?.map((image) => ({ ...image }))
    if (images !== undefined) {
      try { if (!Array.isArray(images)) throw new Error("images must be an array"); validateImages(images, "session/prompt") }
      catch (error) { return Promise.reject(error) }
    }
    if (closed) return Promise.reject(new Error("session service closed"))
    if (closing.has(sessionId)) return Promise.reject(new Error(`session closing: ${sessionId}`))
    // M49 Task 11: the STABLE row id + a SERVICE-OWNED controller are created
    // BEFORE the pacing chain (spec §8.1 — a service-front turn must have its
    // own id/controller). The caller signal is LINKED to it (M41b abort
    // semantics flow through: abort the caller's signal → controller aborts →
    // the queued gate settles, the in-flight engine copies abort).
    const st = sessionQueueState(sessionId)
    const id = options?.admittedInputId ?? randomUUID()
    const admitted = options?.admittedInputId ? assemblies.get(sessionId)?.inbox.pending().find((input) => input.inputId === id) : undefined
    if (st.byId.get(id)?.scheduled || lanes.get(sessionId)?.currentInput()?.inputId === id) return Promise.reject(new Error("Input is already scheduled"))
    if (admitted?.intent !== "system" && !signal.aborted) cancelledParents.delete(sessionId)
    const controller = new AbortController()
    const record: QueueRowRecord = {
      id,
      text: prompt,
      delivery: admitted?.delivery ?? "queue",
      intent: admitted?.intent ?? "user",
      order: st.nextOrder++,
      controller,
      state: "wait",
      scheduled: true,
    }
    st.byId.set(id, record)
    const markFromCaller = (): void => {
      // M41b: the caller's abort flows INTO the service-owned controller —
      // the queued gate settles (never starts), the in-flight engine aborts
      // (the lane hands the controller signal to agent.run). An unstarted
      // row also flips to cancelled so the projection hides it immediately.
      if (record.state === "wait") record.state = "cancelled"
      controller.abort()
    }
    signal.addEventListener("abort", markFromCaller)
    if (signal.aborted) markFromCaller()
    const hasQueued = chains.has(sessionId)
    const prev = chains.get(sessionId) ?? Promise.resolve()
    let settle!: () => void
    let settleError!: (error: unknown) => void
    const turn = new Promise<void>((resolve, reject) => { settle = resolve; settleError = reject })
    chains.set(sessionId, turn)
    active.add(turn)
    const cleanup = (): void => {
      // Exactly-once removal for service rows (settle/error/cancel path); the
      // queue() finished-purge is the read-side twin — both delete idempotently.
      st.byId.delete(id)
      if (chains.get(sessionId) === turn) chains.delete(sessionId)
      active.delete(turn)
    }
    // Rejections stay owned: the submit caller gets the rejection in its own
    // handler — the cleanup promise must never surface one (a bare
    // `turn.finally` would propagate it).
    void turn.then(cleanup, cleanup)
    telemetry?.emit({ type: "session/request", ts: Date.now(), data: { sessionId } })
    if (hasQueued) {
      telemetry?.emit({ type: "session/queued", ts: Date.now(), data: { sessionId } })
    }
    const startTurn = (): void => {
      if (closed || controller.signal.aborted) {
        settle() // the queued turn never starts; the chain keeps moving
        return
      }
      getOrCreate(sessionId).then(async (assembly) => {
        if (controller.signal.aborted || closed) {
          settle()
          return
        }
        const lane = lanes.get(sessionId)!
        let execution: Promise<void>
        try {
          await extensionRefreshes.get(sessionId)?.catch(() => undefined)
          const prepared = !options?.admittedInputId && opts.transformPrompt ? await opts.transformPrompt(assembly, prompt) : prompt
          if (controller.signal.aborted || closed) { settle(); return }
          // M41b: the submit signal now rides INTO the lane — the agent's
          // run() gets it and aborts at step boundaries/yields (in-flight
          // cancel reaches the engine, not just the queue gate). Task 11:
          // the row id is RETAINED through the lane (public id == lane input
          // id) so the projection merges service-front + lane rows by id.
          const text = context ? `${prepared}\n\n${context}` : prepared
          if (options?.admittedInputId) {
            const pending = assembly.inbox.pending().find((input) => input.inputId === id)
            if (!pending) { settle(); return }
            if (pending.text !== text) throw new Error("Admitted input does not match submitted text")
            execution = lane.runAdmitted(id, controller.signal)
          } else {
            assembly.inbox.admit({ inputId: id, text, delivery: "queue", intent: "user", ...(images?.length ? { images } : {}), ...(clientToken ? { clientToken } : {}) })
            execution = lane.runAdmitted(id, controller.signal)
          }
          record.state = "queued"
        } catch (error) {
          // A synchronous lane failure still settles this turn.
          if (!closed) telemetry?.emit({
            type: "session/error",
            ts: Date.now(),
            data: { sessionId, error: error instanceof Error ? error.message : String(error) },
          })
          settleError(error)
          return
        }
        // Lane drain: rejects on the first turn failure (A-plan semantics) —
        // the rejection becomes this submit's rejection (host error frame).
        execution.then(
          async () => {
            if (!closed && !controller.signal.aborted && opts.afterSuccessfulSubmit) {
              try {
                const state = await bindingFor(sessionId)
                await opts.afterSuccessfulSubmit(sessionId, assembly, state.status === "ready"
                  ? { ...(state.binding.contextWindow !== undefined ? { contextWindow: state.binding.contextWindow } : {}), ...(state.binding.maxOutputTokens !== undefined ? { maxOutputTokens: state.binding.maxOutputTokens } : {}) }
                  : {})
              } catch (error) {
                d.warn(`[i-harness] post-turn host callback failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
            settle()
          },
          (error: unknown) => {
            if (!signal.aborted && !closed) {
              telemetry?.emit({
                type: "session/error",
                ts: Date.now(),
                data: { sessionId, error: error instanceof Error ? error.message : String(error) },
              })
            }
            settleError(error)
          },
        )
      }, (error: unknown) => {
        // Assembly build failure (e.g. loadMeta unknown session) → reject.
        telemetry?.emit({
          type: "session/error",
          ts: Date.now(),
          data: { sessionId, error: error instanceof Error ? error.message : String(error) },
        })
        settleError(error)
      })
    }
    void prev.then(startTurn, startTurn)
    return turn
  }

  // ── M49 Task 11: the real queue projection ────────────────────────────────
  // Single read (no UI-derived truth — the projection is the service records +
  // the lane's own truth). Merges service-front and lane rows BY PUBLIC ID;
  // state is "running" only for the lane's current turn; the running row is
  // first, the rest FIFO. Records whose turn already finished are purged here
  // (their submit cleanup may still be waiting on the chain — exactly-once
  // removal on the read side too).

  function queue(sessionId: string): SessionQueueItem[] {
    const lane = lanes.get(sessionId)
    const st = sessionQueueState(sessionId)
    const pending = lane?.pending() ?? []
    const current = lane?.currentInput() ?? undefined
    const pendingIds = new Set(pending.map((p) => p.inputId))

    // Adopt lane-only rows (steers admitted directly into the inbox — the
    // embedded inbound seam) at first sight so they get a stable FIFO order
    // inside the currently admitted window.
    // The adoption window = the highest order among ADMITTED-or-running rows
    // (served or adopted) — service-front ("wait") rows are after the window.
    let window = 0
    for (const rec of st.byId.values()) {
      if (rec.state === "queued" || rec.state === "running") {
        window = Math.max(window, Math.floor(rec.order))
      }
    }
    for (const p of pending) {
      if (st.byId.has(p.inputId)) continue
      st.byId.set(p.inputId, {
        id: p.inputId,
        text: p.text,
        delivery: p.delivery,
        intent: p.intent,
        order: adoptOrder(st, window),
        controller: new AbortController(),
        state: "queued",
      })
    }
    if (current !== undefined && !st.byId.has(current.inputId)) {
      st.byId.set(current.inputId, {
        id: current.inputId,
        text: current.text,
        delivery: current.delivery,
        intent: current.intent,
        order: adoptOrder(st, window),
        controller: new AbortController(),
        state: "running",
      })
    }

    const out: SessionQueueItem[] = []
    const finished: string[] = []
    for (const rec of st.byId.values()) {
      if (rec.state === "cancelled") {
        continue // hidden — the submit settles at its chain hand-over
      }
      if (current?.inputId === rec.id) {
        rec.state = "running"
        out.push({ id: rec.id, text: rec.text, delivery: rec.delivery, intent: rec.intent, state: "running", order: rec.order })
        continue
      }
      if (pendingIds.has(rec.id)) {
        rec.state = "queued"
        out.push({ id: rec.id, text: rec.text, delivery: rec.delivery, intent: rec.intent, state: "queued", order: rec.order })
        continue
      }
      if (rec.state === "wait") {
        // service-front: admitted to the chain, not yet to the lane — queued.
        out.push({ id: rec.id, text: rec.text, delivery: rec.delivery, intent: rec.intent, state: "queued", order: rec.order })
        continue
      }
      // The turn's input left the lane (promoted → done): the row is finished
      // even though the submit's chain promise may not have settled yet.
      finished.push(rec.id)
    }
    for (const id of finished) st.byId.delete(id)
    out.sort((a, b) => (a.state === "running" ? -1 : b.state === "running" ? 1 : a.order - b.order))
    return out
  }

  function cancelQueued(sessionId: string, id: string): { cancelled: boolean } {
    // THE LANE is the ground truth for "running": the record's state is a
    // queue()-read projection and can lag a fresh promotion — consulting it
    // alone would abort a running turn's controller (agent.run's signal) and
    // report an honest-but-false { cancelled: true } (review fix).
    if (lanes.get(sessionId)?.currentInput()?.inputId === id) return { cancelled: false }
    const rec = queues.get(sessionId)?.byId.get(id)
    // Already-cancelled / running / unknown ids are all an honest false — the
    // row is no longer cancellable at the moment (the UI refresh shows truth).
    if (rec === undefined || rec.state === "running" || rec.state === "cancelled") return { cancelled: false }
    // Abort the row controller (settles the submit's chain gate without
    // executing) and retract a lane-admitted input synchronously — the inbox
    // cancel is append-marked, so the projection drops the row immediately.
    rec.controller.abort()
    rec.state = "cancelled"
    lanes.get(sessionId)?.cancel(id)
    return { cancelled: true }
  }

  function cancelRunning(sessionId: string): { cancelled: boolean } {
    const current = lanes.get(sessionId)?.currentInput()
    if (current !== undefined && lanes.get(sessionId)?.cancelCurrent !== undefined) {
      const result = lanes.get(sessionId)!.cancelCurrent!()
      if (result.cancelled) stopNotifications(sessionId)
      return result
    }
    const records = queues.get(sessionId)?.byId
    const record = current === undefined
      ? [...(records?.values() ?? [])].filter(r => r.state === "wait").sort((a, b) => a.order - b.order)[0]
      : records?.get(current.inputId)
    if (record === undefined || record.controller.signal.aborted) return { cancelled: false }
    record.controller.abort()
    stopNotifications(sessionId)
    if (current === undefined) record.state = "cancelled"
    return { cancelled: true }
  }

  const failedClose = new Set<string>()
  const liveAssembly = (sessionId: string) => closed || closing.has(sessionId) || failedClose.has(sessionId) ? undefined : assemblies.get(sessionId)
  let closeAttempt: Promise<void> | undefined
  function close(): Promise<void> {
    if (closeAttempt) return closeAttempt
    const pending = closeAll()
    closeAttempt = pending
    void pending.then(() => { closeAttempt = undefined }, () => { closeAttempt = undefined })
    return pending
  }
  async function closeAll(): Promise<void> {
    if (closed && ownedAssemblies().size === 0) return
    closed = true
    for (const id of assemblies.keys()) stopNotifications(id)
    await Promise.allSettled([
      ...active,
      ...creating.values(),
      ...modelBindings.values(),
      ...closing.values(),
      ...notificationAdmissions.values(),
      ...notificationStops,
    ])
    let failure: unknown
    try { await opts.beforeDispose?.() } catch (error) { failure = error }
    const failures: unknown[] = []
    for (const [id, handle] of ownedAssemblies()) {
      try {
        await handle.dispose()
        assemblies.delete(id); mountingAssemblies.delete(id); lanes.delete(id); modelBindings.delete(id); chains.delete(id); queues.delete(id); failedClose.delete(id)
      } catch (error) { failedClose.add(id); failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, "Session service process cleanup incomplete")
    if (failure !== undefined) throw failure
  }

  function closeSession(sessionId: string): Promise<void> {
    stopNotifications(sessionId)
    const existing = closing.get(sessionId)
    if (existing !== undefined) return existing
    let pending!: Promise<void>
    pending = (async () => {
      const turn = chains.get(sessionId)
      if (turn !== undefined) await Promise.allSettled([turn])
      const build = creating.get(sessionId)
      if (build !== undefined) await build.catch(() => undefined)
      const binding = modelBindings.get(sessionId)
      if (binding !== undefined) await Promise.allSettled([binding])
      await Promise.allSettled([...(notificationAdmissions.has(sessionId) ? [notificationAdmissions.get(sessionId)!] : []), ...notificationStops])
      const handle = assemblies.get(sessionId) ?? mountingAssemblies.get(sessionId)
      try { await handle?.dispose() } catch (error) { failedClose.add(sessionId); throw error }
      failedClose.delete(sessionId)
      assemblies.delete(sessionId)
      mountingAssemblies.delete(sessionId)
      lanes.delete(sessionId)
      modelBindings.delete(sessionId)
      chains.delete(sessionId)
      queues.delete(sessionId)
    })().finally(() => {
      if (closing.get(sessionId) === pending) closing.delete(sessionId)
    })
    closing.set(sessionId, pending)
    return pending
  }

  return {
    async refreshExtensions() {
      if (closed || !opts.extensionsFor) return
      await Promise.allSettled([...creating.values()])
      const jobs = [...assemblies].map(([id, assembly]) => {
        const job = (extensionRefreshes.get(id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
          if (closed || assemblies.get(id) !== assembly) return
          const next = await opts.extensionsFor!(id)
          if (closed || assemblies.get(id) !== assembly) return
          const failures: unknown[] = []
          try { await assembly.updatePluginCapabilities(next.options) } catch (error) { failures.push(error) }
          try {
            if (next.update) await next.update(assembly)
            else {
              await extensionCleanups.get(id)?.(); extensionCleanups.delete(id)
              const cleanup = await next.mount?.(assembly)
              if (cleanup) extensionCleanups.set(id, cleanup)
            }
          } catch (error) { failures.push(error) }
          if (failures.length) throw new AggregateError(failures, "Live plugin update failed")
        })
        extensionRefreshes.set(id, job)
        void job.finally(() => { if (extensionRefreshes.get(id) === job) extensionRefreshes.delete(id) }).catch(() => undefined)
        return job
      })
      const results = await Promise.allSettled(jobs)
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Some live plugin updates failed")
    },
    submit,
    assemblyFor: getOrCreate,
    modelState,
    contextState,
    rebindModel,
    liveSession: (sessionId) => assemblies.get(sessionId)?.session,
    liveAssembly,
    hasAssembly: (sessionId) => assemblies.has(sessionId),
    queueState: (sessionId) => {
      // Count-only compatibility surface (session/status) — derived from the
      // SAME projection, so the counts and the rows never disagree.
      let running = false
      let queued = 0
      for (const item of queue(sessionId)) {
        if (item.state === "running") running = true
        else queued++
      }
      return { running, queued }
    },
    queue: (sessionId) => queue(sessionId),
    cancelQueued: (sessionId, id) => cancelQueued(sessionId, id),
    cancelRunning,
    // M49 Task 12: the sessions' task rows — the assembly owns the truth; a
    // session whose assembly does not exist (or was closed) has NO tasks
    // (honest empty, never a fabricated row).
    tasks: (sessionId) => assemblies.get(sessionId)?.tasks() ?? [],
    cancelTask: (sessionId, id) => {
      const assembly = assemblies.get(sessionId)
      if (assembly === undefined) throw new Error(`unknown task: ${id}`)
      return assembly.cancelTask(id)
    },
    onAssembly: (hook) => {
      hooks.add(hook)
      return () => { hooks.delete(hook) }
    },
    reconcileExecutionAuthority: async (ids) => {
      await Promise.all([...ownedAssemblies()].filter(([id]) => !ids || ids.includes(id)).map(([, assembly]) => assembly.reconcileExecutionAuthority()))
    },
    updateSandboxMode: async (mode) => {
      if (closed || currentSandbox === undefined) throw new Error("sandbox mode is unavailable")
      const changed = currentSandbox !== mode
      currentSandbox = mode
      const owned = ownedAssemblies()
      if (changed) for (const assembly of owned.values()) append(opts.policySession ?? assembly.session, { type: "sandbox/mode", mode })
      await Promise.all([...owned.values()].map(assembly => assembly.reconcileExecutionAuthority()))
    },
    executionBackendStatus: () => Promise.all([...assemblies].map(async ([sessionId, assembly]) => ({ sessionId, status: await assembly.executionBackendStatus() }))),
    closeSession,
    close,
  }
}
