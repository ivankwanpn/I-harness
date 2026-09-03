// @i-harness/tui G3 — embedded backend bridge (M37a).
//
// What this is: a BackendClient over the per-session SessionService
// (@i-harness/session-executor) — the SAME service the web host and CLI run
// behind their transport. The bridge subscribes to the assembly's LIVE
// core-session log, maps SessionEvents → TuiEvents (contracts.ts), batches the
// stream at 16 ms, and serves replay from the in-memory log with the service's
// seq numbering as the resume cursor.
//
// What it is NOT (M37a seams — the caller must know):
//
// 1. PERSISTENCE / SESSION LIST CANNOT BE MIRRORED READ-ONLY. The canonical
//    apps/cli wiring composes `createSessionCoordinator(createJsonlBackend(
//    storeRoot))` + loadMeta/modelBuilder/contextWindowFor around
//    createSessionService, but @i-harness/session-persistence and
//    @i-harness/session-persistence-jsonl are NOT dependencies of
//    packages/tui (and adding them would touch package.json/lockfile, which
//    this milestone forbids). Consequence:
//      - `defaultEmbeddedFactory` is MOCK-ONLY: no coordinator, in-memory
//        session, `storeRoot` is accepted and ignored (M38). A fresh session
//        survives only for the process lifetime. `--model`/settings/
//        credential wiring: TODO M38 (the `modelBuilder` seam below is the
//        landing point; wire settings+credentials in apps/tui like
//        apps/cli/src/web.ts buildModelFor).
//      - `listSessions()` falls back to a single current-session stub row
//        (contract allows it) unless the host supplies the coordinator-backed
//        listing via EmbeddedOptions.listSessions (read-only seam; the type
//        is local so no persistence dep is needed here).
//      - `replay()` walks the LIVE in-memory session (service.assemblyFor →
//        core-session.log). The in-memory array is bounded; acceptable M37a.
//        Replay-from-disk (session restore across restarts) needs the
//        coordinator load + assembly `session: seed` seam → M38.
//
// 2. CHUNK PIPE IN THE ENGINE IS ABSENT. core-agent appends ONLY
//    assistant/message to the log (verified: no producer appends
//    assistant/chunk or reasoning outside tests). The mapper still supports
//    chunk/reasoning events for hosts that pipe the model mux into the log
//    (web-host pattern), with the dedupe rule below, so replay == live
//    exactly.
//
// 3. STEER. SessionService exposes no lane access; steer uses the assembly's
//    Inbox (the lane's own queue, R-A1 steer tier): while a turn is running
//    the input is admitted with delivery "steer" and claimed at the next step
//    boundary / turns into the next pump iteration; while IDLE it degrades to
//    submit (send tier) — the idle pump would otherwise never run it.
//
// 4. CANCEL. cancel() aborts the in-flight submit's AbortController. The
//    agent checks the signal at turn/step boundaries and EVERY stream yield,
//    and the service never starts an aborted QUEUED turn. A provider stream
//    parked on a never-yielding await cannot be interrupted — cancelling a
//    hung model requires a stream-level signal seam (M38).
//
// 5. EVENTS WITHOUT seq. core-session `append` always stamps seq, so log
//    events always carry one. A hypothetical seq-less event interpolates a
//    synthetic seq = highest-seen+1 in arrival order (documented seam for
//    malformed/external events only).
import { randomUUID } from "node:crypto"
import { subscribe, type AdmittedInput, type Session, type SessionEvent } from "@i-harness/core-session"
import { createSessionService, type SessionService, type SessionServiceOptions } from "@i-harness/session-executor"
import { toolKindOf, type BackendClient, type SessionSummary, type TodoItem as TuiTodoItem, type TuiEvent } from "../contracts.ts"

// ------------------------------------------------------------------ mapping

/** Map-state carried across one ordered walk of the log (live OR replay).
 * Both paths share ONE pure mapper so the same event sequence produces byte-
 * identical TuiEvents (the determinism anchor: replay(afterSeq) === live). */
export interface EventMapState {
  lastSeq: number
  /** the current assistant step has already delivered chunk text —
   * its terminal assistant/message is then SKIPPED (chunks were the
   * authoritative content; the aggregate would double it). */
  chunksSinceAssistant: boolean
}

export function createEventMapState(): EventMapState {
  return { lastSeq: -1, chunksSinceAssistant: false }
}

/** Durable seq when present; otherwise interpolate in arrival order
 * (highest-seen + 1 — a synthetic marker, engine appends never hit it). */
function eventSeq(ev: SessionEvent, state: EventMapState): number {
  const seq = ev.seq !== undefined && ev.seq > state.lastSeq ? ev.seq : state.lastSeq + 1
  state.lastSeq = seq
  return seq
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output
  try {
    return JSON.stringify(output, null, 2) ?? String(output)
  } catch {
    return String(output)
  }
}

/** Heuristic error output detection for tool/result (M37a):
 * - an object with a truthy `error` field (engine synthetic abort result and
 *   fs error results look exactly like this), or
 * - a string starting with "Error"/"error" (e.g. "Error: ...").
 * Everything else is a normal done result. */
export function toolResultIsError(output: unknown): boolean {
  if (output === null || output === undefined) return false
  if (typeof output === "object" && !Array.isArray(output)) {
    const err = (output as Record<string, unknown>).error
    if (err !== undefined && err !== null && err !== "") return true
  }
  const text = typeof output === "string" ? output : JSON.stringify(output) ?? ""
  return /^(error|fail(ed)?)\b[\s:"'{\[]/i.test(text.trimStart())
}

/** One SessionEvent → 0..n TuiEvents (a tool/call→result pair is MERGED by
 * callId at the scrollback engine; the bridge emits the running event at the
 * call seq and the done/error UPDATE at the result seq). Skips engine-log
 * bookkeeping that has no UI surface (step/start|end, team/*, job/status,
 * schedule/change, sandbox/mode, agent/input/*, subagent/inbox, ...). */
export function mapSessionEvent(ev: SessionEvent, state: EventMapState): TuiEvent | undefined {
  const ts = Date.now()
  switch (ev.type) {
    case "user/message":
      return { type: "user", text: ev.text, seq: eventSeq(ev, state), ts }
    case "assistant/chunk":
      state.chunksSinceAssistant = true
      return { type: "assistant", text: ev.text, seq: eventSeq(ev, state), ts }
    case "assistant/message": {
      const seq = eventSeq(ev, state)
      // dedupe: chunk text already streamed for this step → skip the aggregate
      if (state.chunksSinceAssistant) {
        state.chunksSinceAssistant = false
        return undefined
      }
      return { type: "assistant", text: ev.text, seq, ts }
    }
    case "reasoning":
      return { type: "thinking", text: ev.text, seq: eventSeq(ev, state), ts }
    case "tool/call":
      return {
        type: "tool",
        callId: ev.callId,
        name: ev.name,
        kind: toolKindOf(ev.name),
        status: "running",
        seq: eventSeq(ev, state),
        ts,
      }
    case "tool/result": {
      const seq = eventSeq(ev, state)
      const error = toolResultIsError(ev.output)
      const text = stringifyOutput(ev.output)
      return {
        type: "tool",
        callId: ev.callId,
        name: ev.name,
        kind: toolKindOf(ev.name),
        status: error ? "error" : "done",
        output: text,
        ...(error ? { error: text } : {}),
        seq,
        ts,
      }
    }
    case "turn/start":
      return { type: "turn", phase: "start", seq: eventSeq(ev, state), ts }
    case "turn/end":
      return { type: "turn", phase: "end", seq: eventSeq(ev, state), ts }
    case "compaction/start":
      return { type: "compaction", phase: "start", seq: eventSeq(ev, state), ts }
    case "compaction/end":
      return { type: "compaction", phase: "end", seq: eventSeq(ev, state), ts }
    case "compaction/summary":
      // M37a visual simplicity: the summary message is one system line.
      return { type: "system", text: "compacted", seq: eventSeq(ev, state), ts }
    case "compaction/reset":
      return { type: "system", text: "context reset", seq: eventSeq(ev, state), ts }
    case "compaction/prune":
      return { type: "system", text: "stale output pruned", seq: eventSeq(ev, state), ts }
    case "todo/write": {
      const seq = eventSeq(ev, state)
      return {
        type: "todo",
        // the durable todo snapshot has no ids — deterministic per-seq/index
        items: ev.items.map((item, i): TuiTodoItem => ({
          id: `${seq}-${i}`,
          text: item.content,
          status: item.status,
        })),
        seq,
        ts,
      }
    }
    case "goal/change":
      return {
        type: "goal",
        ...(ev.goal !== undefined ? { label: ev.goal.objective, state: ev.goal.phase } : {}),
        seq: eventSeq(ev, state),
        ts,
      }
    case "session/title":
      return { type: "title", title: ev.title, seq: eventSeq(ev, state), ts }
    case "plan/mode":
      return { type: "plan", phase: ev.mode, seq: eventSeq(ev, state), ts }
    case "command/run":
      return {
        type: "system",
        text: `command: ${ev.name}${ev.args !== undefined && ev.args !== "" ? ` ${ev.args}` : ""}`,
        seq: eventSeq(ev, state),
        ts,
      }
    case "command/done":
      return {
        type: "system",
        text: `command ${ev.commandId}: ${ev.kind}${ev.text !== undefined && ev.text !== "" ? ` — ${ev.text}` : ""}`,
        seq: eventSeq(ev, state),
        ts,
      }
    case "subagent/start":
      return {
        type: "system",
        text: `subagent started: ${ev.role || ev.agentPath}`,
        seq: eventSeq(ev, state),
        ts,
      }
    case "subagent/end":
      return {
        type: "system",
        text: `subagent ended: ${ev.outcome}${ev.error !== undefined ? ` — ${ev.error}` : ""}`,
        seq: eventSeq(ev, state),
        ts,
      }
    default:
      // step/start|end, team/*, job/status, schedule/change, sandbox/mode,
      // agent/input/*, subagent/inbox, ... — no M37a UI surface.
      return undefined
  }
}

// ------------------------------------------------------------------ options

export interface EmbeddedOptions {
  service: SessionService
  sessionId: string
  /** Initial prompt for a FRESH session (log empty): auto-submitted once by
   * open() — the TUI app needs no explicit kickoff call. */
  prompt?: string
  /** Label seam (M38: model badge in the header). Unused in M37a. */
  modelLabel?: string
  /** Stream batching window in ms. Default 16 (§3.5). */
  batchMs?: number
  /** Read-only session listing seam; ABSENT → current-session stub row
   * (contract-sanctioned M37a fallback; the M38 host passes a
   * coordinator-backed implementation). */
  listSessions?: () => Promise<SessionSummary[]>
}

export interface EmbeddedFactoryOptions {
  /** The agent workspace (AssemblyOptions.workspace — required by the engine). */
  workspace: string
  /** Initial prompt (see EmbeddedOptions.prompt). */
  prompt: string
  /** M38 model seam — the ONLY accepted wiring surface; ALSO gives the engine
   * the SessionServiceOptions.modelBuilder position for loadMeta-driven
   * resolution (pass apps/cli-style settings+credentials in M38). */
  modelBuilder?: SessionServiceOptions["modelBuilder"]
  /** true (default): force the mock client (cyclic "ok" — repeated turns on
   * one assembly survive). false + modelBuilder → production resolution chain
   * with mock fallback when the builder resolves undefined. */
  forceMock?: boolean
  /** Assembly auto-approval (M37a default true — the approval bridge via
   * service.onAssembly is an M37b host task; fail-closed otherwise). */
  approveAll?: boolean
  /** M38 (accepted + ignored in M37a): jsonl session store root. The mock-only
   * factory cannot persist without the session-persistence deps. */
  storeRoot?: string
}

// ------------------------------------------------------------------ backend

export function createEmbeddedBackend(opts: EmbeddedOptions): BackendClient {
  const service = opts.service
  const batchMs = opts.batchMs ?? 16
  const liveState = createEventMapState()

  let sessionId = opts.sessionId
  let session: Session | undefined
  let closed = false
  let currentSubmit: AbortController | undefined
  // -1 = nothing applied yet. replay() is EXCLUSIVE (seqs > afterSeq), so the
  // host bootstraps with replay(seqCursor()) without dropping the first event.
  let cursor = -1
  const promptSubmittedFor = new Set<string>()

  // 16 ms batch queue shared by every events() consumer (M37a: the app owns
  // exactly one consumer; multi-consumer wakes the same slot — see module
  // header). push() arms one window per batch; the generator drains the whole
  // queue when the window elapses.
  const queue: { items: TuiEvent[]; timer: NodeJS.Timeout | undefined; wake: (() => void) | undefined } = {
    items: [],
    timer: undefined,
    wake: undefined,
  }

  function pushEvent(ev: TuiEvent): void {
    queue.items.push(ev)
    cursor = Math.max(cursor, ev.seq)
    if (queue.timer === undefined) {
      queue.timer = setTimeout(() => {
        queue.timer = undefined
        queue.wake?.()
      }, batchMs)
      queue.timer.unref()
    }
  }

  function pushError(text: string): void {
    // Stream-only (never in the durable log): synthetic seq = cursor+1.
    pushEvent({ type: "system", text, seq: cursor + 1, ts: Date.now() })
  }

  function errText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async function ensureSession(): Promise<Session> {
    if (closed) throw new Error("embedded backend closed")
    if (session !== undefined) return session
    const assembly = await service.assemblyFor(sessionId)
    session = assembly.session
    return session
  }

  return {
    async listSessions(): Promise<SessionSummary[]> {
      if (opts.listSessions !== undefined) return opts.listSessions()
      const live = await ensureSession().catch(() => undefined)
      const turnCount = live === undefined ? 0 : live.events.filter((e) => e.type === "turn/start").length
      return [{ id: sessionId, title: "Session", updatedAt: Date.now(), turnCount }]
    },

    async open(id: string): Promise<void> {
      if (closed) throw new Error("embedded backend closed")
      sessionId = id
      session = undefined // re-resolve per session id
      cursor = -1
      const s = await ensureSession()
      if (opts.prompt !== undefined && opts.prompt !== "" && s.events.length === 0 && !promptSubmittedFor.has(id)) {
        promptSubmittedFor.add(id)
        // initial kickoff for the fresh session — errors surface on the stream
        await this.submit(opts.prompt).catch((error: unknown) => {
          pushError(`initial prompt failed: ${errText(error)}`)
        })
      }
    },

    async submit(prompt: string): Promise<void> {
      if (closed) throw new Error("embedded backend closed")
      const controller = new AbortController()
      currentSubmit = controller
      try {
        await service.submit(sessionId, prompt, controller.signal)
      } finally {
        if (currentSubmit === controller) currentSubmit = undefined
      }
    },

    async steer(text: string): Promise<void> {
      if (closed) throw new Error("embedded backend closed")
      // Idle → no pump is running, an inbox steer would sit pending until the
      // NEXT submit; degrade to a send-tier turn instead (documented M37a).
      if (!service.queueState(sessionId).running) {
        await this.submit(text)
        return
      }
      const assembly = await service.assemblyFor(sessionId)
      const admission: AdmittedInput = { inputId: randomUUID(), text, delivery: "steer", intent: "user" }
      // The lane's own queue: claimed at the next step boundary (R-A1 steer
      // tier) or picked up as the next pump iteration when the turn ends.
      assembly.inbox.admit(admission)
    },

    async cancel(): Promise<void> {
      // The agent checks the signal at every boundary/yield; an aborted
      // queued submit never runs (service-side). See module header item 4.
      currentSubmit?.abort()
    },

    async *events(): AsyncIterable<TuiEvent> {
      let s: Session
      try {
        s = await ensureSession()
      } catch (error) {
        pushError(`session open failed: ${errText(error)}`)
        return
      }
      const walkMap = (ev: SessionEvent): TuiEvent[] => {
        const mapped = mapSessionEvent(ev, liveState)
        return mapped === undefined ? [] : [mapped]
      }
      const unsubscribe = subscribe(s, (ev) => {
        for (const mapped of walkMap(ev)) pushEvent(mapped)
      })
      try {
        for (;;) {
          // drain the elapsed batch in one burst, then yield one item per pull
          if (queue.timer === undefined && queue.items.length > 0) {
            yield queue.items.shift()!
            continue
          }
          if (closed) break
          await new Promise<void>((resolve) => {
            queue.wake = resolve
          })
        }
        // close() flush — remaining items, no timer wait
        while (queue.items.length > 0) yield queue.items.shift()!
      } finally {
        if (queue.timer !== undefined) {
          clearTimeout(queue.timer)
          queue.timer = undefined
        }
        queue.wake = undefined
        unsubscribe()
      }
    },

    seqCursor: () => cursor,

    async replay(afterSeq: number): Promise<TuiEvent[]> {
      const live = await ensureSession().catch(() => undefined)
      if (live === undefined) return []
      // Determinism anchor: run the SAME state machine over the whole log
      // (even the pre-cursor prefix — the assistant-chunk dedupe must see
      // chunks of a step that began before the cursor), emit seq > afterSeq.
      const state = createEventMapState()
      const out: TuiEvent[] = []
      for (const ev of live.events) {
        const mapped = mapSessionEvent(ev, state)
        if (mapped !== undefined && mapped.seq > afterSeq) out.push(mapped)
      }
      if (out.length > 0) cursor = Math.max(cursor, out[out.length - 1]!.seq)
      return out
    },

    status: () => service.queueState(sessionId),

    async close(): Promise<void> {
      if (closed) return
      closed = true
      if (queue.timer !== undefined) {
        clearTimeout(queue.timer)
        queue.timer = undefined
      }
      queue.wake?.()
      // Best-effort: the caller handed us the service; we own its shutdown
      // (shared coordinator/telemetry are the CALLER's — never closed here).
      await service.close().catch(() => {})
    },
  }
}

// ------------------------------------------------------------------ factory (mock-only M37a)

/** Default host wiring — mirrors apps/cli's createSessionService call shape
 * MINUS the coordinator/store/meta chain (seam: not importable here without
 * adding @i-harness/session-persistence deps — see module header). Mock first,
 * modelBuilder passthrough (M38), approveAll default true, cyclic mock so
 * repeated turns survive. The returned client's session is fresh and
 * in-memory; callers wanting durability must M38 the factory. */
export async function defaultEmbeddedFactory(opts: EmbeddedFactoryOptions): Promise<BackendClient> {
  const forceMock = opts.forceMock ?? true
  const service: SessionService = createSessionService({
    workspace: opts.workspace,
    approveAll: opts.approveAll ?? true,
    // the default mock cycles ("ok" per turn); also the fallback when a
    // modelBuilder run resolves undefined — never the destructive one-shot.
    mockCycles: true,
    ...(!forceMock && opts.modelBuilder !== undefined ? { modelBuilder: opts.modelBuilder } : {}),
    // M37a: deliberately NO coordinator / loadMeta / contextWindowFor /
    // telemetry — in-memory session only (module header item 1).
  })
  return createEmbeddedBackend({
    service,
    sessionId: `sess-${randomUUID().slice(0, 8)}`,
    prompt: opts.prompt,
  })
}
