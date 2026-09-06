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
import { randomUUID } from "node:crypto"
import type { Session } from "@i-harness/core-session"
import { createSessionExecutor, type SessionExecutor as SessionTurnLane, type ReasoningEffort } from "@i-harness/core-agent"
import type { ModelClient } from "@i-harness/llm-seam"
import type { AgentTaskView } from "@i-harness/subagent"
import type { SessionMeta } from "@i-harness/session-persistence"
import type { Telemetry } from "@i-harness/telemetry"
import {
  createSessionAssembly,
  ModelUnavailableError,
  type AssemblyOptions,
  type SessionAssembly,
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
        reasoningEffort?: ReasoningEffort
        contextWindow?: number
      }
    }

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
  | { status: "ready"; providerId: string; modelId: string; label: string }

export interface SessionServiceOptions extends AssemblyOptions {
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
}

export interface SessionService {
  /** One prompt for one session (tier send). Serialized per session;
   * cross-session parallel. An aborted QUEUED submit never runs. REJECTS when
   * the session's turn lane failed (drain rejection → the host maps it to an
   * error frame). */
  submit(sessionId: string, prompt: string, signal: AbortSignal): Promise<void>
  assemblyFor(sessionId: string): Promise<SessionAssembly>
  /** Resolve serializable model state without constructing an assembly. */
  modelState(sessionId: string): Promise<SessionModelState>
  liveSession(sessionId: string): Session | undefined
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
  const lanes = new Map<string, SessionTurnLane>()
  const creating = new Map<string, Promise<SessionAssembly>>()
  const modelBindings = new Map<string, Promise<SessionModelBindingResult>>()
  const hooks = new Set<(assembly: SessionAssembly) => void>()
  const chains = new Map<string, Promise<void>>()
  const active = new Set<Promise<void>>()
  const closing = new Map<string, Promise<void>>()
  const telemetry = opts.telemetry
  let closed = false

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
    }
  }

  async function getOrCreate(sessionId: string): Promise<SessionAssembly> {
    if (closed) throw new Error("session service closed")
    const pendingClose = closing.get(sessionId)
    if (pendingClose !== undefined) await pendingClose
    if (closed) throw new Error("session service closed")
    const existing = assemblies.get(sessionId)
    if (existing !== undefined) return existing
    let pending = creating.get(sessionId)
    if (pending === undefined) {
      pending = (async () => {
        let assembly: SessionAssembly
        if (opts.modelBindingFor !== undefined) {
          const result = await bindingFor(sessionId)
          if (result.status !== "ready") throw new ModelUnavailableError(result.reason)
          const binding = result.binding
          const compact = binding.contextWindow === undefined || opts.compact === undefined
            ? undefined
            : { ...opts.compact, contextWindow: binding.contextWindow }
          const resolvedSession = opts.sessionFor === undefined ? opts.session : await opts.sessionFor(sessionId)
          assembly = await createSessionAssembly({
            ...opts,
            sessionId,
            session: resolvedSession,
            model: binding.model,
            modelLabel: binding.label,
            contextWindow: binding.contextWindow,
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
          assembly = await createSessionAssembly({
            ...opts,
            sessionId,
            session: resolvedSession,
            ...(model !== undefined ? { model } : {}),
            ...(opts.contextWindowFor !== undefined ? { contextWindow } : {}),
            ...(opts.reasoningEffortFor !== undefined ? { reasoningEffort } : {}),
          })
        }
        assemblies.set(sessionId, assembly)
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
        return assembly
      })().finally(() => { creating.delete(sessionId) })
      creating.set(sessionId, pending)
    }
    return pending
  }

  function submit(sessionId: string, prompt: string, signal: AbortSignal): Promise<void> {
    if (closed) return Promise.reject(new Error("session service closed"))
    if (closing.has(sessionId)) return Promise.reject(new Error(`session closing: ${sessionId}`))
    // M49 Task 11: the STABLE row id + a SERVICE-OWNED controller are created
    // BEFORE the pacing chain (spec §8.1 — a service-front turn must have its
    // own id/controller). The caller signal is LINKED to it (M41b abort
    // semantics flow through: abort the caller's signal → controller aborts →
    // the queued gate settles, the in-flight engine copies abort).
    const st = sessionQueueState(sessionId)
    const id = randomUUID()
    const controller = new AbortController()
    const record: QueueRowRecord = {
      id,
      text: prompt,
      delivery: "queue",
      intent: "user",
      order: st.nextOrder++,
      controller,
      state: "wait",
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
      getOrCreate(sessionId).then(() => {
        if (controller.signal.aborted || closed) {
          settle()
          return
        }
        const lane = lanes.get(sessionId)!
        try {
          // M41b: the submit signal now rides INTO the lane — the agent's
          // run() gets it and aborts at step boundaries/yields (in-flight
          // cancel reaches the engine, not just the queue gate). Task 11:
          // the row id is RETAINED through the lane (public id == lane input
          // id) so the projection merges service-front + lane rows by id.
          lane.submit({ tier: "send", text: prompt, signal: controller.signal }, id)
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
        lane.drain().then(
          () => { settle() },
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

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    await Promise.allSettled([
      ...active,
      ...creating.values(),
      ...modelBindings.values(),
      ...closing.values(),
    ])
    let failure: unknown
    try { await opts.beforeDispose?.() } catch (error) { failure = error }
    const handles = [...assemblies.values()]
    assemblies.clear()
    lanes.clear()
    modelBindings.clear()
    chains.clear()
    queues.clear()
    for (const handle of handles) await handle.dispose().catch(() => {})
    if (failure !== undefined) throw failure
  }

  function closeSession(sessionId: string): Promise<void> {
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
      const handle = assemblies.get(sessionId)
      assemblies.delete(sessionId)
      lanes.delete(sessionId)
      modelBindings.delete(sessionId)
      chains.delete(sessionId)
      queues.delete(sessionId)
      await handle?.dispose().catch(() => {})
    })().finally(() => {
      if (closing.get(sessionId) === pending) closing.delete(sessionId)
    })
    closing.set(sessionId, pending)
    return pending
  }

  return {
    submit,
    assemblyFor: getOrCreate,
    modelState,
    liveSession: (sessionId) => assemblies.get(sessionId)?.session,
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
    closeSession,
    close,
  }
}
