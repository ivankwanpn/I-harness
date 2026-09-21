/**
 * Local schedule driver — the session-side delivery loop (dsh driver parity,
 * IH-shaped). One `tick()` fold-checks every registered session's
 * schedule/change stream, asks `decideDue` for exactly ONE decision — a due
 * one-shot, or one batch of every overdue fixed-rate record — and hands the HOST
 * one `ScheduleDelivery` (the dispatch event(s), framed text, one idempotency
 * key) through the injectable `deliver` seam.
 * THE ENGINE DOES NOT WRITE THE LOG (spec §3.4's 2026-09-21 correction): the
 * host owns "write or not" — it accepts by appending `[dispatch, admitted]` as
 * ONE durable batch, and rejects by throwing (nothing accepted ⇒ nothing due).
 * Restart re-drive is FREE: a new driver instance over the same persisted
 * events delivers exactly the still-overdue remainder — records whose dispatch
 * was accepted are no longer due.
 *
 * Rules: deliver BEFORE counting (a delivery the host refused is not delivered
 * — fail-closed path); a corrupted schedule stream OR a decision the state
 * cannot satisfy skips that session with a deliveryError entry
 * (projection-grade honesty) and never throws out of `tick()`; a batch is ONE
 * model message, so N overdue records cost one turn, not N (spec §6.3).
 */

import type { SessionEvent } from "@i-harness/core-session"
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
 * `[dispatchEvents…, admitted]` in ONE durable batch and rejects by throwing
 * (spec §3.4) — the engine never touches the log.
 */
export interface ScheduleDelivery {
  sessionId: string
  dispatchEvents: SessionEvent[]
  text: string
  inputId: string
  due: ScheduleDue[]
}

export interface ScheduleTickResult {
  delivered: number
  due: ScheduleDue[]
  /** Per-session delivery failures (the host's deliver), sessionId-prefixed — never a silent drop. */
  deliveryErrors: string[]
}

export interface ScheduleDriverOptions {
  /** Enumerate the sessions this driver owns. */
  sessions(): string[]
  /** The session's foldable events; undefined = unknown session (skipped). */
  events(sessionId: string): readonly SessionEvent[] | undefined
  /** Hand one delivery to the host — the ONLY writer of the log (spec §3.4). Throwing = rejection. */
  deliver: (delivery: ScheduleDelivery) => void | Promise<void>
  /** Wall-clock source (tests inject). Default Date.now. */
  now?: () => number
  /** Background tick interval; the first tick runs at start() (restart re-drive). */
  pollMs?: number
  /** Per-session log corruption reporter. Default console.warn. */
  logWarn?: (message: string) => void
}

export interface ScheduleDriver {
  /** Re-drive immediately (restart policy), then poll every pollMs. */
  start(): Promise<ScheduleTickResult>
  stop(): void
  isRunning(): boolean
  tick(): Promise<ScheduleTickResult>
}

function dispatchEventFor(record: ScheduleRecord, acceptedAt: number): SessionEvent {
  if (record.kind !== "every") {
    return { type: "schedule/change", version: 1, operation: "dispatch", id: record.id }
  }
  return { type: "schedule/change", version: 1, operation: "dispatch", id: record.id, acceptedAt: new Date(acceptedAt).toISOString() }
}

export function createScheduleDriver(opts: ScheduleDriverOptions): ScheduleDriver {
  const nowFn = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? 30_000
  const logWarn = opts.logWarn ?? ((message: string) => console.warn(`[schedule] ${message}`))
  let timer: NodeJS.Timeout | null = null
  let running = false

  let ticking = false  // one tick in flight (W1's shape, settings/src/index.ts:1437): a tick that
                       // arrives while one is running is SKIPPED, not queued — the next tick re-reads
                       // the fold, and a skipped tick can never miss a state that has settled. Without
                       // this guard two overlapping ticks can both fold BEFORE either host delivery
                       // lands, and each would deliver the same occurrence.
  async function tick(): Promise<ScheduleTickResult> {
    if (ticking) return { delivered: 0, due: [], deliveryErrors: [] }
    ticking = true
    try {
      const result: ScheduleTickResult = { delivered: 0, due: [], deliveryErrors: [] }
      const accepted = nowFn()
      for (const sessionId of opts.sessions()) {
        const events = opts.events(sessionId)
        if (events === undefined) continue
        let decision: ScheduleDecision
        try {
          // Fold AND decide under one guard: a corrupt stream and a decision this state cannot
          // satisfy are the same session-scoped failure — reported, never thrown out of tick()
          // (the in-flight guard's finally must still reset).
          decision = decideDue(foldScheduleEvents(events).active, accepted)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          result.deliveryErrors.push(`${sessionId}: ${reason}`)
          logWarn(`schedule state of ${sessionId} is corrupt: ${reason}`)
          continue
        }
        if (decision.kind === "none" || decision.kind === "wait") continue
        try {
          // ONE decision ⇒ ONE delivery: a single one-shot, or one batch whose dispatch events,
          // framing and idempotency key are all built from that same decision.
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
          // The HOST decides (spec §3.4): accept by writing [dispatch, admitted] as ONE durable
          // batch, or refuse by throwing — nothing is counted before this returns.
          await opts.deliver(delivery)
          result.due.push(...delivery.due)
          result.delivered += delivery.due.length
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          const label = decision.kind === "one-shot"
            ? decision.record.id
            : `batch [${decision.reminders.map(({ record }) => record.id).join(", ")}]`
          result.deliveryErrors.push(`${sessionId}: ${reason}`)
          logWarn(`schedule delivery of ${label} in ${sessionId} failed: ${reason}`)
        }
      }
      return result
    } finally {
      ticking = false
    }
  }

  return {
    async start() {
      running = true
      const first = await tick()
      timer = setInterval(() => {
        void tick()
      }, pollMs)
      timer.unref?.()
      return first
    },
    stop() {
      running = false
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    isRunning: () => running,
    tick,
  }
}
