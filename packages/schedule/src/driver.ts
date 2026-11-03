/**
 * Local schedule driver — the session-side delivery loop (dsh driver parity,
 * IH-shaped). One `tick()` fold-checks every registered session's
 * schedule/change stream, asks `decideDue` for exactly ONE decision — a due
 * one-shot, or one batch of every overdue fixed-rate record — and hands the HOST
 * one `ScheduleDelivery` (the dispatch event(s), framed text, one idempotency
 * key) through the injectable `deliver` seam.
 * THE ENGINE DOES NOT WRITE THE LOG: the host owns grouped dispatch/admission
 * acceptance and any unknown-publication reconciliation. A rejected handoff is
 * reported without inferring refusal, durability or a synthetic acknowledgement.
 * Restart re-drive is FREE: a new driver instance over the same persisted
 * events delivers exactly the still-overdue remainder — records whose dispatch
 * was accepted are no longer due.
 *
 * Rules: deliver BEFORE counting (a rejected handoff is not counted); a corrupted
 * schedule stream OR a decision the state
 * cannot satisfy skips that session with a deliveryError entry
 * (projection-grade honesty) and never throws out of `tick()`; a batch is ONE
 * model message, so N overdue records cost one turn, not N (spec §6.3).
 */

import {readOriginalSchedules, type OriginalScheduleSource} from './observation.ts'
import type { SessionEvent, SessionEventView } from "@i-harness/core-session"
import { currentDiagnostics } from "@i-harness/diagnostics"
import {
  decideDue,
  foldScheduleEvents,
  renderEveryReminderBatchFraming,
  renderReminderFraming,
  scheduleBatchInputId,
  scheduleOccurrenceInputId,
  type ScheduleDecision,
  type ScheduleRecord,
} from "./index.ts"

export interface ScheduleDue {
  sessionId: string
  record: ScheduleRecord
  /** The accepted occurrence (one-shot: the record's target; every: the latest anchored occurrence). */
  occurrenceAt: string
}

/**
 * ONE hand-off from the engine to the host: the durable dispatch event(s), the
 * injection-resistant reminder text, the per-occurrence idempotency key, and
 * the due entries this delivery covers. The host accepts by writing
 * `[dispatchEvents…, admitted]` in ONE durable batch and the engine never
 * touches the log. A throw reports a failed handoff; publication authority stays
 * with the host (see `ScheduleDriverOptions.deliver`).
 */
export interface ScheduleDelivery {
  sessionId: string
  dispatchEvents: Extract<SessionEvent, { type: 'schedule/change' }>[]
  text: string
  inputId: string
  due: ScheduleDue[]
}

export interface ScheduleTickResult {
  delivered: number
  due: ScheduleDue[]
  /** Source/decision/handoff failures, sessionId-prefixed; driver-wide errors use <driver>. */
  deliveryErrors: string[]
}

export interface ScheduleDriverOptions {
  /** Enumerate the sessions this driver owns. */
  sessions(): string[]
  /** The session's foldable events; undefined = unknown session (skipped). */
  events?(sessionId: string): readonly SessionEventView[] | undefined
  /** Original owner observations; when supplied they are the sole source. */
  original?(sessionId: string): OriginalScheduleSource | undefined
  /** Hand one delivery to the host, the ONLY writer of the log. A returned handoff is counted;
   *  a rejected handoff is reported. Neither outcome establishes durable publication here. */
  deliver: (delivery: ScheduleDelivery) => void | Promise<void>
  /** Wall-clock source (tests inject). Default Date.now. */
  now?: () => number
  /** @deprecated Accepted for source compatibility; ignored. There is no polling/retry interval. */
  pollMs?: number
  /** Subscribe before the initial snapshot. Acquisition must be atomic or roll back before
   *  throwing; the returned disposer must be idempotent, including after a failed attempt. */
  subscribeMutations?: (changed: (sessionId?: string) => void) => (() => void)
  /** Per-session log corruption reporter. Default console.warn. */
  logWarn?: (message: string) => void
}

export interface ScheduleDriver {
  /** Opt in to one nearest-deadline timeout; concurrent starts share their initial pass. */
  start(): Promise<ScheduleTickResult>
  stop(): void
  /** Fence admission, detach and join accepted work. Failed known cleanup is retryable. */
  close(): Promise<void>
  invalidate(reason?: "mutation" | "clock" | "resume" | "retry", sessionId?: string): void
  isRunning(): boolean
  tick(): Promise<ScheduleTickResult>
}

function dispatchEventFor(record: ScheduleRecord, acceptedAt: number): Extract<SessionEvent, { type: 'schedule/change' }> {
  if (record.kind !== "every") {
    return { type: "schedule/change", version: 1, operation: "dispatch", id: record.id }
  }
  return { type: "schedule/change", version: 1, operation: "dispatch", id: record.id, acceptedAt: new Date(acceptedAt).toISOString() }
}

// W6 T6: the per-session log-corruption reporter's default (the driver is the
// session-side delivery loop and reports a SESSION's stream, hence phase
// `session`). The body reaches the ambient instance when a host installed one
// and is the console call it always was when none is: same function, same
// single verbatim argument. The option's signature is untouched.
function defaultLogWarn(message: string): void {
  const d = currentDiagnostics()
  if (d === undefined) {
    console.warn(`[schedule] ${message}`)
    return
  }
  d.child("session").warn(`[schedule] ${message}`)
}

export function createScheduleDriver(opts: ScheduleDriverOptions): ScheduleDriver {
  const nowFn = opts.now ?? Date.now
  const logWarn = opts.logWarn ?? defaultLogWarn
  let timer: NodeJS.Timeout | null = null
  let running = false
  let generation = 0
  let closed = false
  let dirty = false
  let queuedGeneration: number | undefined
  let activePass: Promise<ScheduleTickResult> | null = null
  let startPromise: Promise<ScheduleTickResult> | null = null
  let closePromise: Promise<void> | null = null
  let unsubscribe: (() => void) | undefined
  let cleanupFailure: { error: unknown } | undefined
  let acquisitionFailure: { error: unknown } | undefined
  let enumerationBlocked = false
  // Suppression describes the owned active fold, not event count or notifications.
  const failedStates = new Map<string, string>()
  const unreadable = new Set<string>()
  const empty = (): ScheduleTickResult => ({ delivered: 0, due: [], deliveryErrors: [] })
  const live = (owner: number): boolean => !closed && running && generation === owner
  const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

  function warn(text: string): void {
    try { logWarn(text) } catch { /* Reporting must never escape or recursively report itself. */ }
  }

  function report(result: ScheduleTickResult, id: string, error: unknown, context: string): void {
    const reason = message(error)
    result.deliveryErrors.push(`${id}: ${reason}`)
    warn(`${context}: ${reason}`)
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function stateKey(records: readonly ScheduleRecord[]): string {
    return JSON.stringify(records.map((record) => [record.id, record.kind, record.prompt, record.scheduledAt,
      record.kind === "after" ? record.afterSeconds : null,
      record.kind === "every" ? record.everySeconds : null]))
  }

  function read(id: string, result: ScheduleTickResult): {records:readonly ScheduleRecord[];assertCurrent():void} | undefined {
    if (unreadable.has(id)) return undefined
    try {
      if (opts.original) {
        const source=opts.original(id)
        if (source===undefined) return undefined
        const observed=readOriginalSchedules(source)
        return {records:observed.snapshot.active,assertCurrent:observed.assertCurrent}
      }
      const events = opts.events?.(id)
      return events === undefined ? undefined : {records:foldScheduleEvents(events).active,assertCurrent(){}}
    } catch (error) {
      unreadable.add(id)
      report(result, id, error, `schedule state of ${id} is corrupt`)
      return undefined
    }
  }

  function enumerate(result: ScheduleTickResult): string[] | undefined {
    if (enumerationBlocked) return undefined
    try { return [...new Set(opts.sessions())] } catch (error) {
      enumerationBlocked = true
      report(result, "<driver>", error, "schedule enumeration failed")
      return undefined
    }
  }

  function decisionFor(id: string, records: readonly ScheduleRecord[], accepted: number,
    result: ScheduleTickResult): ScheduleDecision | undefined {
    const key = stateKey(records)
    if (failedStates.get(id) === key) return undefined
    failedStates.delete(id) // Actual source progression, never just a notification.
    try { return decideDue(records, accepted) } catch (error) {
      unreadable.add(id)
      report(result, id, error, `schedule state of ${id} is corrupt`)
      return undefined
    }
  }

  function arm(owner: number, target: number): void {
    if (!live(owner)) return
    const handle = setTimeout(() => {
      if (!live(owner) || timer !== handle) return
      timer = null
      // The real deadline (including a capped timeout) always rereads wall time and the fold.
      background(owner)
    }, Math.min(Math.max(0, target - nowFn()), 2_147_483_647))
    timer = handle
    handle.unref?.()
  }

  function rearm(owner: number, result: ScheduleTickResult): void {
    if (!live(owner)) return
    clearTimer()
    // One final fresh snapshot, never a while(dirty) delivery drain. Mutations during
    // host awaits are included, while each pass still makes only one decision/session.
    dirty = false
    const ids = enumerate(result)
    if (ids === undefined) return
    const accepted = nowFn()
    let target: number | undefined
    for (const id of ids) {
      const observation = read(id, result)
      if (observation === undefined) continue
      const records = observation.records
      const decision = decisionFor(id, records, accepted, result)
      if (decision === undefined || decision.kind === "none") continue
      const candidate = decision.kind === "wait"
        ? (decision.target === undefined ? undefined : Date.parse(decision.target))
        : accepted
      observation.assertCurrent()
      if (candidate !== undefined && (target === undefined || candidate < target)) target = candidate
    }
    if (target !== undefined) arm(owner, target)
  }

  async function pass(owner: number): Promise<ScheduleTickResult> {
    const result = empty()
    try {
      const ids = enumerate(result)
      if (ids === undefined) return result
      const accepted = nowFn()
      for (const sessionId of ids) {
        // Also fences manual passes interrupted by stop/close; a later explicit tick is reuse.
        if (closed || generation !== owner) break
        const observation = read(sessionId, result)
        if (observation === undefined) continue
        const records = observation.records
        const decision = decisionFor(sessionId, records, accepted, result)
        if (decision === undefined || decision.kind === "none" || decision.kind === "wait") continue
        const key = stateKey(records)
        try {
          const delivery: ScheduleDelivery = decision.kind === "one-shot"
            ? {
                sessionId,
                dispatchEvents: [dispatchEventFor(decision.record, accepted)],
                text: renderReminderFraming(decision.record),
                inputId: scheduleOccurrenceInputId(decision.record, decision.occurrenceAt),
                due: [{ sessionId, record: decision.record, occurrenceAt: decision.occurrenceAt }],
              }
            : {
                sessionId,
                dispatchEvents: decision.reminders.map(({ record }) => dispatchEventFor(record, accepted)),
                text: renderEveryReminderBatchFraming(decision.reminders),
                inputId: scheduleBatchInputId(decision.acceptedAt),
                due: decision.reminders.map(({ record, occurrenceAt }) => ({ sessionId, record, occurrenceAt })),
              }
          if (closed || generation !== owner) break
          observation.assertCurrent()
          await opts.deliver(delivery)
          result.due.push(...delivery.due)
          result.delivered += delivery.due.length
          if (closed || generation !== owner) break
          const current = read(sessionId, result)
          if (current === undefined) {
            // Disappearing source is not evidence that any handed-off occurrence advanced.
            failedStates.set(sessionId, key)
            if (!unreadable.has(sessionId)) report(result, sessionId,
              new Error("delivery did not advance schedule state"), `schedule delivery in ${sessionId} failed`)
            continue
          }
          current.assertCurrent()
          const advanced = delivery.due.every(({ record, occurrenceAt }) => {
            const remaining = current.records.find((candidate) => candidate.id === record.id)
            return remaining === undefined || Date.parse(remaining.scheduledAt) > Date.parse(occurrenceAt)
          })
          if (!advanced) {
            failedStates.set(sessionId, stateKey(current.records))
            report(result, sessionId, new Error("delivery did not advance schedule state"),
              `schedule delivery in ${sessionId} failed`)
          }
        } catch (error) {
          // An older stopped generation cannot poison the new start's explicit retry.
          if (!closed && generation === owner) failedStates.set(sessionId, key)
          const label = decision.kind === "one-shot" ? decision.record.id
            : `batch [${decision.reminders.map(({ record }) => record.id).join(", ")}]`
          report(result, sessionId, error, `schedule delivery of ${label} in ${sessionId} failed`)
        }
      }
    } catch (error) {
      enumerationBlocked = true
      report(result, "<driver>", error, "schedule driver failed")
    } finally {
      // The final read and timeout setup are guarded too, including injected clock failures.
      try { rearm(owner, result) } catch (error) {
        clearTimer()
        enumerationBlocked = true
        report(result, "<driver>", error, "schedule driver failed")
      }
    }
    return result
  }

  function launch(owner: number): Promise<ScheduleTickResult> {
    clearTimer()
    dirty = false
    // Publish ownership before invoking sources/host: they may synchronously stop or close.
    let settle!: (result: ScheduleTickResult) => void
    const work = new Promise<ScheduleTickResult>((resolve) => { settle = resolve })
    activePass = work
    void work.then(() => { if (activePass === work) activePass = null })
    void pass(owner).then(settle, (error: unknown) => {
      const result = empty()
      report(result, "<driver>", error, "schedule driver failed")
      settle(result)
    })
    return work
  }

  function background(owner: number): void {
    if (!live(owner)) return
    dirty = true
    if (activePass !== null) return // Its one final snapshot consumes the dirty source.
    // pass contains callback failures; retain a rejection guard at the autonomous boundary.
    void launch(owner).catch((error: unknown) => { warn(`schedule background work failed: ${message(error)}`) })
  }

  function invalidate(reason: "mutation" | "clock" | "resume" | "retry" = "mutation", id?: string): void {
    if (closed) return
    dirty = true
    enumerationBlocked = false
    if (id === undefined) unreadable.clear()
    else unreadable.delete(id)
    if (reason === "retry") {
      if (id === undefined) failedStates.clear()
      else failedStates.delete(id)
    }
    if (!running || activePass !== null || queuedGeneration === generation) return
    const owner = generation
    queuedGeneration = owner
    void Promise.resolve().then(() => {
      if (queuedGeneration === owner) queuedGeneration = undefined
      if (live(owner) && dirty) background(owner)
    }).catch((error: unknown) => { warn(`schedule invalidation failed: ${message(error)}`) })
  }

  function stop(): void {
    running = false
    generation++
    startPromise = null
    queuedGeneration = undefined
    clearTimer()
    if (unsubscribe !== undefined) {
      try {
        unsubscribe()
        unsubscribe = undefined
        cleanupFailure = undefined
      } catch (error) {
        // Keep the exact idempotent handle; another explicit stop/close may retry it.
        cleanupFailure = { error }
        warn(`schedule mutation cleanup failed: ${message(error)}`)
      }
    }
  }

  return {
    start() {
      if (closed) return Promise.reject(new Error("schedule driver is closed"))
      if (acquisitionFailure !== undefined) return Promise.reject(new Error(`schedule subscription acquisition unresolved: ${message(acquisitionFailure.error)}`))
      if (cleanupFailure !== undefined) return Promise.reject(new Error(`schedule mutation cleanup unresolved: ${message(cleanupFailure.error)}`))
      if (running && startPromise !== null) return startPromise
      running = true
      const owner = ++generation
      let settle!: (result: ScheduleTickResult | PromiseLike<ScheduleTickResult>) => void
      const initial = new Promise<ScheduleTickResult>((resolve) => { settle = resolve })
      startPromise = initial
      failedStates.clear()
      unreadable.clear()
      enumerationBlocked = false
      try {
        unsubscribe = opts.subscribeMutations?.((id) => { if (live(owner)) invalidate("mutation", id) })
      } catch (error) {
        acquisitionFailure = { error }
        stop()
        const result = empty()
        report(result, "<driver>", error, "schedule subscription acquisition failed")
        settle(result)
        return initial
      }
      // A synchronous adapter callback can stop/close during acquisition. Dispose the
      // handle once it becomes known; close joins initial as well as accepted host work.
      if (!live(owner)) {
        stop()
        settle(empty())
        return initial
      }
      const previous = activePass
      if (previous === null) settle(launch(owner))
      else void previous.then(() => { settle(live(owner) ? launch(owner) : empty()) })
      return initial
    },
    stop,
    close() {
      if (closePromise !== null) return closePromise
      closed = true
      const starting = startPromise
      stop()
      const accepted = activePass
      const attempt = (async () => {
        if (accepted !== null) await accepted
        if (starting !== null) await starting
        if (acquisitionFailure !== undefined) throw new Error(`schedule subscription acquisition unresolved: ${message(acquisitionFailure.error)}`)
        if (cleanupFailure !== undefined) throw cleanupFailure.error
      })()
      closePromise = attempt
      void attempt.catch(() => { if (closePromise === attempt) closePromise = null })
      return attempt
    },
    invalidate,
    isRunning: () => running,
    tick() {
      if (closed) return Promise.reject(new Error("schedule driver is closed"))
      dirty = true
      if (activePass !== null) return Promise.resolve(empty())
      failedStates.clear()
      unreadable.clear()
      enumerationBlocked = false
      return launch(generation)
    },
  }
}

export type { OriginalScheduleSource } from './observation.ts'
