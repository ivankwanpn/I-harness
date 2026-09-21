/**
 * Local schedule driver — the session-side delivery loop (dsh driver parity,
 * IH-shaped). One `tick()` fold-checks every registered session's
 * schedule/change stream and, for each due record, resolves the accepted
 * occurrence and hands the HOST one `ScheduleDelivery` (dispatch event, framed
 * text, per-occurrence inputId) through the injectable `deliver` seam.
 * THE ENGINE DOES NOT WRITE THE LOG (spec §3.4's 2026-09-21 correction): the
 * host owns "write or not" — it accepts by appending `[dispatch, admitted]` as
 * ONE durable batch, and rejects by throwing (nothing accepted ⇒ nothing due).
 * Restart re-drive is FREE: a new driver instance over the same persisted
 * events delivers exactly the still-overdue remainder — records whose dispatch
 * was accepted are no longer due.
 *
 * Rules: deliver BEFORE counting (a delivery the host refused is not delivered
 * — fail-closed path); a corrupted schedule stream skips the whole session with
 * a deliveryError entry (projection-grade honesty); every occurrences are
 * resolved anchor-aligned via resolveEveryOccurrence, and their framing states
 * the occurrence, never the lagging scheduledAt.
 */

import type { SessionEvent } from "@i-harness/core-session"
import {
  foldScheduleEvents,
  renderReminderFraming,
  resolveEveryOccurrence,
  scheduleOccurrenceInputId,
  scheduleView,
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

  async function tick(): Promise<ScheduleTickResult> {
    const result: ScheduleTickResult = { delivered: 0, due: [], deliveryErrors: [] }
    const accepted = nowFn()
    for (const sessionId of opts.sessions()) {
      const events = opts.events(sessionId)
      if (events === undefined) continue
      let active: readonly ScheduleRecord[]
      try {
        active = foldScheduleEvents(events).active
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        result.deliveryErrors.push(`${sessionId}: ${reason}`)
        logWarn(`schedule stream of ${sessionId} is corrupt: ${reason}`)
        continue
      }
      for (const record of active) {
        if (scheduleView(record, accepted).state !== "overdue") continue
        const occurrenceAt = record.kind === "every"
          ? resolveEveryOccurrence(record, accepted).occurrenceAt
          : record.scheduledAt
        const due: ScheduleDue = { sessionId, record, occurrenceAt }
        const delivery: ScheduleDelivery = {
          sessionId,
          dispatchEvents: [dispatchEventFor(record, accepted)],
          // renderReminderFraming reads record.scheduledAt — for an every record that is the lagging
          // target (the fold only advances it on the NEXT dispatch), so hand it the occurrence.
          text: renderReminderFraming(record.kind === "every" ? { ...record, scheduledAt: occurrenceAt } : record),
          inputId: scheduleOccurrenceInputId(record, occurrenceAt),
          due: [due],
        }
        try {
          // The HOST decides (spec §3.4): accept by writing [dispatch, admitted] as ONE durable
          // batch, or refuse by throwing — nothing is counted before this returns.
          await opts.deliver(delivery)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          result.deliveryErrors.push(`${sessionId}: ${reason}`)
          logWarn(`schedule delivery of ${record.id} in ${sessionId} failed: ${reason}`)
          continue
        }
        result.due.push(...delivery.due)
        result.delivered += delivery.due.length
      }
    }
    return result
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
