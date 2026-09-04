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
import type { Session } from "@i-harness/core-session"
import { createSessionExecutor, type SessionExecutor as SessionTurnLane, type ReasoningEffort } from "@i-harness/core-agent"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionMeta } from "@i-harness/session-persistence"
import type { Telemetry } from "@i-harness/telemetry"
import { createSessionAssembly, type AssemblyOptions, type SessionAssembly } from "./assembly.ts"

export interface SessionServiceOptions extends AssemblyOptions {
  /** Shared host event stream (also handed to each assembly). */
  telemetry?: Telemetry
  /** Metadata source for an assembly's FIRST build (the tier-1 model chain
   * input, e.g. session.meta.modelSelection). Absent → no meta. */
  loadMeta?: (sessionId: string) => Promise<SessionMeta | undefined>
  /** Per-assembly model resolution; the chain itself stays in the composition
   * (apps/cli/src/web.ts resolveModelSpec). Absent → the assembly's mock
   * default. */
  modelBuilder?: (sessionId: string, meta: SessionMeta | undefined) => Promise<ModelClient | undefined>
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
  liveSession(sessionId: string): Session | undefined
  hasAssembly(sessionId: string): boolean
  /** Per-session lane observation for the jobs/queue surface:
   * running = a turn is executing; queued = registered submit turns not yet
   * started (the service pacing chain, in front of the lane). */
  queueState(sessionId: string): { running: boolean; queued: number }
  /** Fires once per created assembly — the bridge attach point
   * (approval/question bridges). */
  onAssembly(hook: (assembly: SessionAssembly) => void): () => void
  /** Wait for active turns, then dispose every assembly best-effort. NEVER
   * closes a caller-owned telemetry stream or coordinator. */
  close(): Promise<void>
}

export function createSessionService(opts: SessionServiceOptions): SessionService {
  const assemblies = new Map<string, SessionAssembly>()
  const lanes = new Map<string, SessionTurnLane>()
  const creating = new Map<string, Promise<SessionAssembly>>()
  const hooks = new Set<(assembly: SessionAssembly) => void>()
  const chains = new Map<string, Promise<void>>()
  const active = new Set<Promise<void>>()
  // Registered-but-unsettled turns per session (the service's own pacing
  // queue, in front of the lane) — the jobs/queue observation surface.
  const registered = new Map<string, number>()
  const telemetry = opts.telemetry
  let closed = false

  async function getOrCreate(sessionId: string): Promise<SessionAssembly> {
    const existing = assemblies.get(sessionId)
    if (existing !== undefined) return existing
    let pending = creating.get(sessionId)
    if (pending === undefined) {
      pending = (async () => {
        const meta = opts.loadMeta === undefined ? undefined : await opts.loadMeta(sessionId)
        const model = opts.modelBuilder === undefined ? undefined : await opts.modelBuilder(sessionId, meta)
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
        const assembly = await createSessionAssembly({
          ...opts,
          sessionId,
          ...(model !== undefined ? { model } : {}),
          ...(opts.contextWindowFor !== undefined ? { contextWindow } : {}),
          ...(opts.reasoningEffortFor !== undefined ? { reasoningEffort } : {}),
        })
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
    const hasQueued = chains.has(sessionId)
    const prev = chains.get(sessionId) ?? Promise.resolve()
    let settle!: () => void
    let settleError!: (error: unknown) => void
    const turn = new Promise<void>((resolve, reject) => { settle = resolve; settleError = reject })
    chains.set(sessionId, turn)
    active.add(turn)
    registered.set(sessionId, (registered.get(sessionId) ?? 0) + 1)
    const cleanup = (): void => {
      registered.set(sessionId, Math.max(0, (registered.get(sessionId) ?? 1) - 1))
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
    void prev.then(() => {
      if (closed || signal.aborted) {
        settle() // the queued turn never starts; the chain keeps moving
        return
      }
      getOrCreate(sessionId).then(() => {
        if (signal.aborted || closed) {
          settle()
          return
        }
        const lane = lanes.get(sessionId)!
        try {
          // M41b: the submit signal now rides INTO the lane — the agent's
          // run() gets it and aborts at step boundaries/yields (in-flight
          // cancel reaches the engine, not just the queue gate).
          lane.submit({ tier: "send", text: prompt, signal })
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
    })
    return turn
  }

  async function close(): Promise<void> {
    closed = true
    await Promise.allSettled([...active])
    const handles = [...assemblies.values()]
    assemblies.clear()
    lanes.clear()
    chains.clear()
    for (const handle of handles) await handle.dispose().catch(() => {})
  }

  return {
    submit,
    assemblyFor: getOrCreate,
    liveSession: (sessionId) => assemblies.get(sessionId)?.session,
    hasAssembly: (sessionId) => assemblies.has(sessionId),
    queueState: (sessionId) => {
      const lane = lanes.get(sessionId)
      const running = lane?.isRunning() ?? false
      const total = registered.get(sessionId) ?? 0
      return { running, queued: Math.max(0, total - (running ? 1 : 0)) }
    },
    onAssembly: (hook) => {
      hooks.add(hook)
      return () => { hooks.delete(hook) }
    },
    close,
  }
}
