/**
 * Local schedule driver — the session-side delivery loop (dsh driver parity,
 * IH-shaped). One `tick()` fold-checks every registered session's
 * schedule/change stream, dispatch-advances due records (the durable event is
 * the acceptance record) and only then notifies the injectable `onDue`
 * deliverer (the A1 inbox followup wire — this milestone ships the seam).
 * Restart re-drive is FREE: a new driver instance over the same persisted
 * events delivers exactly the still-overdue remainder — records whose
 * dispatch was accepted are no longer due.
 *
 * Rules: append BEFORE deliver (a delivery without a durable accept is a
 * duplicate risk — fail-closed path); a corrupted schedule stream skips the
 * whole session with a deliveryError entry (projection-grade honesty); every
 * occurrences are resolved anchor-aligned via resolveEveryOccurrence.
 */

import type { SessionEvent } from "@i-harness/core-session"
import {
  foldScheduleEvents,
  resolveEveryOccurrence,
  scheduleView,
  type ScheduleRecord,
} from "./index.ts"

export interface ScheduleDue {
  sessionId: string
  record: ScheduleRecord
  /** The accepted occurrence (one-shot: the record's target; every: the latest anchored occurrence). */
  occurrenceAt: string
}

export interface ScheduleTickResult {
  delivered: number
  due: ScheduleDue[]
  /** Per-session delivery failures (append/onDue), sessionId-prefixed — never a silent drop. */
  deliveryErrors: string[]
}

export interface ScheduleDriverOptions {
  /** Enumerate the sessions this driver owns. */
  sessions(): string[]
  /** The session's foldable events; undefined = unknown session (skipped). */
  events(sessionId: string): readonly SessionEvent[] | undefined
  /** Append durable events to the session log (the dispatch records). */
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  /** Deliver a due reminder (the A1-inbox wire lands here later). */
  onDue?: (due: ScheduleDue) => void | Promise<void>
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
        try {
          // durable accept FIRST — a delivery without it double-fires on the next re-drive.
          await opts.append(sessionId, [dispatchEventFor(record, accepted)])
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          result.deliveryErrors.push(`${sessionId}: ${reason}`)
          logWarn(`schedule dispatch of ${record.id} in ${sessionId} failed: ${reason}`)
          continue
        }
        result.due.push({ sessionId, record, occurrenceAt })
        result.delivered += 1
        if (opts.onDue !== undefined) {
          try {
            await opts.onDue({ sessionId, record, occurrenceAt })
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            result.deliveryErrors.push(`${sessionId}: ${reason}`)
            logWarn(`schedule delivery of ${record.id} in ${sessionId} failed: ${reason}`)
          }
        }
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
