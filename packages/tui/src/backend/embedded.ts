// @i-harness/tui G3 — embedded backend bridge (M37a).
//
// What this is: a BackendClient over the per-session SessionService
// (@i-harness/session-executor) — the SAME service the web host and CLI run
// behind their transport. The bridge subscribes to the assembly's LIVE
// core-session log, maps SessionEvents → TuiEvents (contracts.ts), batches the
// stream at 16 ms, and serves replay from the in-memory log with the service's
// seq numbering as the resume cursor.
//
// What it is NOT (current M48 boundaries — the caller must know):
//
// 1. MODEL / CREDENTIAL POLICY IS STILL A HOST CONCERN. Durable persistence
//    and resume are enabled when storeRoot/resumeSessionId are provided;
//    settings and credential discovery remain owned by the application host.
//    Without a store, the factory intentionally uses an ephemeral session.
//    Rewind is exposed only for durable sessions with a rewind root.
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
import { append, createSession, subscribe, type AdmittedInput, type Session, type SessionEvent } from "@i-harness/core-session"
import { RewindService } from "@i-harness/rewind"
import { renderUnifiedDiff, type TextDiff } from "@i-harness/text-diff"
import { applyTitle, normalizeTitle } from "@i-harness/session-title"
import {
  createSessionService,
  type ModelPolicy,
  type SessionAssembly,
  type SessionService,
  type SessionServiceOptions,
} from "@i-harness/session-executor"
import { activeTokens } from "@i-harness/token-meter"
import {
  completedTurnPrefix,
  createSessionCoordinator,
  forkSession,
  type SessionCoordinator,
  type SessionModelSelection,
} from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
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

/** M49 Task 10: when the tool/result's STRUCTURED payload supplies an fs
 * change (change: TextDiff / changes: TextDiff[] — edit/write/apply_patch)
 * the presentation string IS its unified diff; a rawPatch string (apply_patch
 * without parseable per-file changes) renders verbatim. The field came from
 * the structured payload itself — no regex string extraction.
 * Returns undefined when no change-shaped member exists (the caller then
 * keeps the plain stringified JSON). */
function structuredChangeText(output: unknown): string | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined
  const r = output as Record<string, unknown>
  const validDiff = (c: unknown): c is TextDiff =>
    c !== null && typeof c === "object"
    && typeof (c as TextDiff).path === "string"
    && typeof (c as TextDiff).added === "number"
    && typeof (c as TextDiff).deleted === "number"
    && Array.isArray((c as TextDiff).hunks)
  const changes = r.changes
  if (Array.isArray(changes) && changes.length > 0 && changes.every((c) => validDiff(c))) {
    return (changes as unknown as TextDiff[]).map(renderUnifiedDiff).join("")
  }
  if (validDiff(r.change)) {
    return renderUnifiedDiff(r.change)
  }
  if (typeof r.rawPatch === "string" && r.rawPatch !== "") return r.rawPatch
  return undefined
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
        args: ev.args,
        seq: eventSeq(ev, state),
        ts,
      }
    case "tool/result": {
      const seq = eventSeq(ev, state)
      const error = toolResultIsError(ev.output)
      // M49 Task 10: the structured fs change renders AS its unified diff;
      // everything else keeps the faithful stringified payload. `result`
      // always carries the raw structured payload (the typed surface — the
      // raw viewer/presentation redacts it at the UI boundary).
      const text = structuredChangeText(ev.output) ?? stringifyOutput(ev.output)
      return {
        type: "tool",
        callId: ev.callId,
        name: ev.name,
        kind: toolKindOf(ev.name),
        status: error ? "error" : "done",
        output: text,
        result: ev.output,
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
    // M43: the rewind engine's durable marker — surface the REWIND event
    // (engine draws `Rewound to turn {N}` + the dim anchor; the projection
    // semantics (deriveMessages cut) are core-session's, not ours).
    case "rewind/point":
      return {
        type: "rewind",
        targetTurn: ev.targetTurn,
        anchorSeq: ev.anchorSeq,
        mode: ev.mode,
        seq: eventSeq(ev, state),
        ts,
      }
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
  /** Info-line/status model label (M38b G2 — plumbed now). The label is
   * HOST-KNOWN (the --model spec): the resolution chain's ModelClient exposes
   * no name (llm-seam interface is stream() only), so the backend cannot
   * derive it itself. Absent → the loop's unconfigured fallback text. */
  modelLabel?: string
  /** Model context window (tokens) when the HOST resolved it (M38b G2,
   * read-only). Absent → contextTotal is unknown and the chip renders only
   * what exists. Used-token PRICING comes from @i-harness/token-meter
   * (activeTokens — the same estimator as the engine's context_remaining tool
   * and the M25 token/usage telemetry), a workspace dependency since M40 G2. */
  contextWindow?: number
  /** Stream batching window in ms. Default 16 (§3.5). */
  batchMs?: number
  /** Read-only session listing seam; ABSENT → current-session stub row
   * (contract-sanctioned M37a fallback; the M38 host passes a
   * coordinator-backed implementation). */
  listSessions?: () => Promise<SessionSummary[]>
  /** M43: workspace root for the rewind bridge's disk side — MUST be the SAME
   * root the service's assemblies were created with (createSessionService
   * rewindStoreRoot). Absent ⇒ the client has NO `rewind` member (the loop's
   * Esc-Esc arming stays off). The member's methods still fail loudly when the
   * resolved assembly carries no rewind handle (store not enabled). */
  rewindWorkspace?: string
  createSession?: () => Promise<string>
  forkSession?: (sessionId: string) => Promise<string>
  setSessionModel?: (sessionId: string, selection: SessionModelSelection) => Promise<void>
  /** M49 Task 10: the assembly seam for the interaction bridges — EVERY
   * assembly the backend resolves is forwarded ONCE here (before any tools
   * run: the resolution precedes the submit), so the approval/question
   * answerers land in time. Absent → the host owns the service's onAssembly
   * (the direct-backend path). */
  onAssembly?: (assembly: SessionAssembly) => void
}

export interface EmbeddedFactoryOptions {
  /** The agent workspace (AssemblyOptions.workspace — required by the engine). */
  workspace: string
  /** Initial prompt (see EmbeddedOptions.prompt). */
  prompt: string
  modelPolicy?: ModelPolicy
  modelBindingFor?: SessionServiceOptions["modelBindingFor"]
  /** Assembly auto-approval (M37a default true — the approval bridge via
   * service.onAssembly is an M37b host task; fail-closed otherwise). */
  approveAll?: boolean
  /** JSONL session store root. When set, the factory owns the coordinator
   * lifecycle and enables durable create/list/resume/flush behavior. */
  storeRoot?: string
  /** M38b G2: info-line/status model label — the HOST's --model spec (the
   * resolved ModelClient exposes no name; see EmbeddedOptions.modelLabel).
   * Absent → the loop displays an unconfigured label. */
  modelLabel?: string
  /** M38b G2: model context window (tokens) the host resolved (read-only;
   * see EmbeddedOptions.contextWindow). */
  contextWindow?: number
  /** M43: rewind store root — forwarded to createSessionService (assembly
   * creates RewindStore+Recorder for the fs-write pre-image channel, M42).
   * When set (with the factory's sessionId) the client exposes the `rewind`
   * bridge; ABSENT = rewind off (mock factory default — no member). */
  rewindStoreRoot?: string
  coordinator?: SessionCoordinator
  resumeSessionId?: string
  /** M49 Task 10: the interaction-bridge assembly seam — forwarded to
   * createEmbeddedBackend (see EmbeddedOptions.onAssembly); the host's
   * ApprovalBridgeService.onAssembly subscription lands here. */
  onAssembly?: (assembly: SessionAssembly) => void
}

// ------------------------------------------------------------------ backend

export function createEmbeddedBackend(opts: EmbeddedOptions): BackendClient {
  const service = opts.service
  const batchMs = opts.batchMs ?? 16
  let rebindLiveSession: ((session: Session, openedSessionId: string) => void) | undefined
  let pendingOpenedSessionId: string | undefined

  let sessionId = opts.sessionId
  let openGeneration = 0
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
    return (await ensureAssembly()).session
  }

  /** Assembly cache (gets .rewind handle + the session for appendEvent hooks). */
  let cachedAssembly: SessionAssembly | undefined
  let assemblyForId: string | undefined

  /** M49 Task 10: the bridge seam — notify once per unique assembly (the ctx
   * is the attach key: answerers land before any submit, so the ask surface
   * is live when the tools need it). */
  const notifiedAssemblies = new Set<SessionAssembly>()
  function notifyAssembly(assembly: SessionAssembly): void {
    if (notifiedAssemblies.has(assembly)) return
    notifiedAssemblies.add(assembly)
    opts.onAssembly?.(assembly)
  }

  async function ensureAssembly(): Promise<SessionAssembly> {
    for (;;) {
      if (closed) throw new Error("embedded backend closed")
      const targetId = sessionId
      if (cachedAssembly !== undefined && assemblyForId === targetId) return cachedAssembly
      const assembly = await service.assemblyFor(targetId)
      if (targetId !== sessionId) continue
      cachedAssembly = assembly
      assemblyForId = targetId
      notifyAssembly(assembly)
      return assembly
    }
  }

  return {
    async listSessions(): Promise<SessionSummary[]> {
      if (opts.listSessions !== undefined) return opts.listSessions()
      const live = await ensureSession().catch(() => undefined)
      const turnCount = live?.events.filter((e) => e.type === "turn/start").length
      return [{
        id: sessionId,
        title: "Session",
        updatedAt: Date.now(),
        ...(turnCount !== undefined ? { turnCount } : {}),
      }]
    },

    async open(id: string): Promise<void> {
      if (closed) throw new Error("embedded backend closed")
      const generation = ++openGeneration
      const assembly = await service.assemblyFor(id)
      if (closed) throw new Error("embedded backend closed")
      if (generation !== openGeneration) return
      sessionId = id
      cachedAssembly = assembly
      assemblyForId = id
      notifyAssembly(assembly)
      cursor = -1
      const s = assembly.session
      if (rebindLiveSession !== undefined) rebindLiveSession(s, id)
      else pendingOpenedSessionId = id
      if (opts.prompt !== undefined && opts.prompt !== "" && s.events.length === 0 && !promptSubmittedFor.has(id)) {
        promptSubmittedFor.add(id)
        // initial kickoff for the fresh session — errors surface on the stream
        await this.submit(opts.prompt).catch((error: unknown) => {
          pushError(`initial prompt failed: ${errText(error)}`)
        })
      }
    },

    async createSession(): Promise<string> {
      if (opts.createSession === undefined) throw new Error("session-create unavailable")
      const id = await opts.createSession()
      if (id === "") throw new Error("session-create returned an empty session id")
      await this.open(id)
      return id
    },

    async forkSession(): Promise<string> {
      if (opts.forkSession === undefined) throw new Error("session-fork unavailable")
      const id = await opts.forkSession(sessionId)
      if (id === "") throw new Error("session-fork returned an empty session id")
      await this.open(id)
      return id
    },

    modelState() {
      return service.modelState(sessionId)
    },

    async setSessionModel(selection): Promise<import("../contracts.ts").BackendModelState> {
      if (opts.setSessionModel === undefined) throw new Error("session-model unavailable")
      if (selection.provider.trim() === "" || selection.model.trim() === "") {
        throw new Error("session model selection requires non-empty provider and model")
      }
      const targetSessionId = sessionId
      const queueState = service.queueState(targetSessionId)
      if (queueState.running || queueState.queued > 0) {
        throw new Error(`session-model unavailable while session is busy: ${targetSessionId}`)
      }
      await opts.setSessionModel(targetSessionId, {
        provider: selection.provider.trim(),
        model: selection.model.trim(),
        ...(selection.reasoningEffort !== undefined
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      })
      await service.closeSession(targetSessionId)
      if (sessionId === targetSessionId) {
        cachedAssembly = undefined
        assemblyForId = undefined
      }
      return service.modelState(targetSessionId)
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
        for (;;) {
          const assembly = await ensureAssembly()
          if (assembly !== cachedAssembly || assemblyForId !== sessionId) continue
          s = assembly.session
          break
        }
      } catch (error) {
        pushError(`session open failed: ${errText(error)}`)
        return
      }
      let mapState = createEventMapState()
      const walkMap = (ev: SessionEvent): TuiEvent[] => {
        const mapped = mapSessionEvent(ev, mapState)
        return mapped === undefined ? [] : [mapped]
      }
      let unsubscribe: (() => void) | undefined
      const bind = (next: Session, openedSessionId?: string): void => {
        unsubscribe?.()
        if (queue.timer !== undefined) {
          clearTimeout(queue.timer)
          queue.timer = undefined
        }
        queue.items.length = 0
        mapState = createEventMapState()
        if (openedSessionId !== undefined) {
          pushEvent({ type: "session/open", sessionId: openedSessionId, seq: -1, ts: Date.now() })
        }
        unsubscribe = subscribe(next, (ev) => {
          for (const mapped of walkMap(ev)) pushEvent(mapped)
        })
        for (const ev of next.events) {
          for (const mapped of walkMap(ev)) pushEvent(mapped)
        }
        queue.wake?.()
      }
      rebindLiveSession = (next, openedSessionId) => bind(next, openedSessionId)
      const openedSessionId = pendingOpenedSessionId
      pendingOpenedSessionId = undefined
      bind(s, openedSessionId)
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
        rebindLiveSession = undefined
        unsubscribe?.()
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

    modelLabel: opts.modelLabel,

    async context(): Promise<{ used: number; total?: number } | undefined> {
      // M40 G2 — REAL values: used = the token-meter projection over the live
      // session (activeTokens(deriveMessages(session)) — the SAME estimator
      // the engine's get_context_remaining tool and the M25 token/usage
      // telemetry use: M15's single projection rule, the model only ever sees
      // deriveMessages(session), so tokens are counted on that exact output).
      // total = the host-resolved context window (M38b G2 seam); absent total
      // → the chip renders only the used count (never a fabricated total).
      // A closed/failed assembly resolve returns undefined (never a fake 0).
      const s = await ensureSession().catch(() => undefined)
      if (s === undefined) return undefined
      const used = activeTokens(s)
      if (opts.contextWindow !== undefined && opts.contextWindow > 0) {
        return { used, total: opts.contextWindow }
      }
      return { used }
    },

    // M43: the rewind bridge — present only when the host wired a workspace
    // (rewind store on); absent ⇒ BackendClient.rewind === undefined and the
    // loop's Esc-Esc rewind gate stays off (mock factory: no member).
    ...(opts.rewindWorkspace !== undefined
      ? { rewind: buildRewindMember(opts.rewindWorkspace, ensureAssembly) }
      : {}),

    // M46a G2: session rename — the session-title backend: applyTitle appends
    // a `session/title` event into the live log (the bridge maps it to the TUI
    // title event → the app title follows through the event stream). The
    // normalized title is the canonical-store rule (R-A6, title-invalid guard).
    async rename(title: string): Promise<void> {
      const s = await ensureSession()
      applyTitle(s, normalizeTitle(title), "user")
    },

    // M46a G2: session compact — the M33 session-compact command surface
    // (session-executor assembly.compactNow — shadow + summary; the CLI's
    // registerCommand handler is assembly-backed; this is the same call).
    async compact(instructions?: string): Promise<{ compacted: boolean }> {
      const assembly = await ensureAssembly()
      const r = await assembly.compactNow(instructions)
      return { compacted: r.compacted }
    },

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
      await service.close()
    },
  }
}

// ------------------------------------------------------------------ rewind member (M43)

/** Build the conditional `rewind` member of a createEmbeddedBackend client.
 * Present only when the host wired a rewind workspace (the assembly-side
 * rewindStoreRoot was on); every call resolves the CURRENT assembly's rewind
 * handle fresh (open() may have switched sessions) and fails loudly when the
 * assembly has none (host/store mismatch — never a silent no-op). */
function buildRewindMember(
  workspace: string,
  ensureAssembly: () => Promise<SessionAssembly>,
): NonNullable<BackendClient["rewind"]> {
  const svcFor = async (): Promise<{ svc: RewindService; session: Session }> => {
    const assembly = await ensureAssembly()
    if (assembly.rewind === undefined) {
      throw new Error("rewind not enabled on this session (assembled without rewindStoreRoot)")
    }
    return { svc: new RewindService({ store: assembly.rewind.store, workspace }), session: assembly.session }
  }
  return {
    async points() {
      return (await svcFor()).svc.points()
    },
    async plan(target, mode) {
      return (await svcFor()).svc.plan(target, mode)
    },
    async execute(target, mode) {
      const { svc, session } = await svcFor()
      // appendEvent = append into the LIVE session log → subscribe() fans the
      // rewind/point TuiEvent to the app (engine marker row + anchor).
      return svc.execute(target, mode, { appendEvent: (ev) => append(session, ev) })
    },
  }
}

// ------------------------------------------------------------------ factory

/** Default embedded host wiring. Without `storeRoot` it uses an ephemeral
 * session; with a coordinator/store it provides durable create/list/resume/
 * flush lifecycle and optionally the durable rewind bridge. */
export async function defaultEmbeddedFactory(opts: EmbeddedFactoryOptions): Promise<BackendClient> {
  const modelPolicy = opts.modelPolicy ?? "required"
  // A resumed injected coordinator is transferred to this factory instance because
  // adoptOwnership() holds its lease until coordinator.close().
  const ownsCoordinator = opts.coordinator === undefined && opts.storeRoot !== undefined
  const jsonlBackend = opts.storeRoot === undefined ? undefined : createJsonlBackend(opts.storeRoot)
  const coordinator = opts.coordinator ?? (jsonlBackend === undefined ? undefined : createSessionCoordinator(jsonlBackend, { lock: { enabled: true, lockRoot: opts.storeRoot! } }))
  let sessionId = opts.resumeSessionId
  const sessions = new Map<string, Session>()
  const ephemeralModelSelections = new Map<string, SessionModelSelection>()
  const openedSessionIds = new Set<string>()
  const mirroredSession = (id: string, restored?: Session): Session => {
    const live = createSession((ev) => {
      coordinator?.enqueue(id, [ev])
      if (ev.type === "turn/end") void coordinator?.flush(id).catch(() => {})
    })
    if (restored !== undefined) {
      live.events.push(...restored.events)
      live.formatVersion = restored.formatVersion
      live.header = restored.header
    }
    return live
  }
  let sessionFor: SessionServiceOptions["sessionFor"] | undefined
  try {
    if (coordinator !== undefined) {
      if (sessionId !== undefined) {
        const restored = (await coordinator.loadOwned(sessionId)).session
        sessions.set(sessionId, mirroredSession(sessionId, restored))
      } else {
        sessionId = (await coordinator.create()).id
      }
      openedSessionIds.add(sessionId!)
      sessionFor = async (id: string): Promise<Session | undefined> => {
        const cached = sessions.get(id)
        if (cached !== undefined) return cached
        const ids = await coordinator.list()
        if (ids.includes(id)) {
          const restored = (await coordinator.loadOwned(id)).session
          const live = mirroredSession(id, restored)
          sessions.set(id, live)
          openedSessionIds.add(id)
          return live
        }
        await coordinator.create({ sessionId: id })
        openedSessionIds.add(id)
        return undefined
      }
    } else {
      sessionId ??= `sess-${randomUUID().slice(0, 8)}`
      sessions.set(sessionId, createSession())
      sessionFor = async (id: string): Promise<Session> => {
        let session = sessions.get(id)
        if (session === undefined) {
          session = createSession()
          sessions.set(id, session)
        }
        return session
      }
    }
    sessionId ??= `sess-${randomUUID().slice(0, 8)}`
    const durableRewindRoot = coordinator === undefined ? undefined : opts.rewindStoreRoot
    const loadMeta: SessionServiceOptions["loadMeta"] = async (id) => {
      if (coordinator !== undefined) {
        return (await coordinator.profile(id)).meta
      }
      const session = sessions.get(id)
      if (session === undefined) return undefined
      const modelSelection = ephemeralModelSelections.get(id)
      return {
        formatVersion: session.formatVersion,
        sessionId: id,
        createdAt: "",
        ...(session.header ?? {}),
        ...(modelSelection !== undefined ? { modelSelection } : {}),
      }
    }
    const service: SessionService = createSessionService({
      workspace: opts.workspace, sessionId,
      modelPolicy,
      ...(sessionFor !== undefined ? { sessionFor } : {}),
      ...(coordinator !== undefined ? { coordinator } : {}),
      ...(coordinator !== undefined ? { beforeDispose: async () => { await Promise.all([...openedSessionIds].map((id) => coordinator.flush(id))) } } : {}),
      ...(coordinator !== undefined || opts.modelBindingFor !== undefined ? { loadMeta } : {}),
      approveAll: opts.approveAll ?? true,
      ...(modelPolicy === "test-mock" ? { mockCycles: true } : {}),
      ...(opts.modelBindingFor !== undefined ? { modelBindingFor: opts.modelBindingFor } : {}),
      ...(durableRewindRoot !== undefined ? { rewindStoreRoot: durableRewindRoot } : {}),
    })
    const listSessions = coordinator === undefined ? undefined : async (): Promise<SessionSummary[]> => {
      const ids = jsonlBackend === undefined ? await coordinator.list() : await jsonlBackend.list()
      const rows = await Promise.all(ids.map(async (id): Promise<SessionSummary | undefined> => {
        try {
          if (jsonlBackend !== undefined) {
            const [{ meta, updatedAt }, raw] = await Promise.all([jsonlBackend.profile(id), jsonlBackend.read(id)])
            return { id, title: meta.title ?? "Session", updatedAt: updatedAt ?? Date.parse(meta.createdAt), turnCount: raw.events.filter((event) => event.type === "turn/start").length }
          }
          const { meta, updatedAt, blank } = await coordinator.profile(id)
          const live = service.liveSession(id)
          const turnCount = live === undefined
            ? blank ? 0 : undefined
            : live.events.filter((event) => event.type === "turn/start").length
          return {
            id,
            title: meta.title ?? "Session",
            updatedAt: updatedAt ?? Date.parse(meta.createdAt),
            ...(turnCount !== undefined ? { turnCount } : {}),
          }
        } catch {
          return undefined
        }
      }))
      return rows.filter((row): row is SessionSummary => row !== undefined)
    }
    const createSessionForBackend = async (): Promise<string> => {
      if (coordinator !== undefined) return (await coordinator.create()).id
      const id = `sess-${randomUUID().slice(0, 8)}`
      sessions.set(id, createSession())
      return id
    }
    const forkSessionForBackend = async (sourceId: string): Promise<string> => {
      if (coordinator !== undefined) {
        await coordinator.flush(sourceId)
        return (await forkSession(coordinator, sourceId)).sessionId
      }
      const source = (await service.assemblyFor(sourceId)).session
      const prefix = completedTurnPrefix(source.events, sourceId, undefined)
      const id = `sess-${randomUUID().slice(0, 8)}`
      const child = createSession()
      child.events.push(...prefix)
      child.header = { parentSession: sourceId, seedLength: prefix.length }
      sessions.set(id, child)
      return id
    }
    const setSessionModel = opts.modelBindingFor === undefined
      ? undefined
      : async (id: string, selection: SessionModelSelection): Promise<void> => {
          if (coordinator !== undefined) {
            if (!(await coordinator.list()).includes(id)) throw new Error(`session not found: ${id}`)
            await coordinator.updateMeta(id, { modelSelection: selection })
            return
          }
          if (!sessions.has(id)) throw new Error(`session not found: ${id}`)
          ephemeralModelSelections.set(id, selection)
        }
    const backend = createEmbeddedBackend({
      service,
      sessionId,
      prompt: opts.prompt,
      createSession: createSessionForBackend,
      forkSession: forkSessionForBackend,
      ...(setSessionModel !== undefined ? { setSessionModel } : {}),
      ...(listSessions !== undefined ? { listSessions } : {}),
      ...(opts.modelLabel !== undefined ? { modelLabel: opts.modelLabel } : {}),
      ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
      ...(durableRewindRoot !== undefined ? { rewindWorkspace: opts.workspace } : {}),
      ...(opts.onAssembly !== undefined ? { onAssembly: opts.onAssembly } : {}),
    })
    if (coordinator === undefined) return backend
    const close = backend.close.bind(backend)
    let closePromise: Promise<void> | undefined
    backend.close = () => {
      closePromise ??= (async () => {
        let failure: unknown
        try { await close() } catch (error) { failure = error }
        try { if (ownsCoordinator) await coordinator.close() } catch (error) { if (failure === undefined) failure = error }
        if (failure !== undefined) throw failure
      })()
      return closePromise
    }
    return backend
  } catch (error) {
    if (ownsCoordinator && coordinator !== undefined) await coordinator.close().catch(() => {})
    throw error
  }
}
