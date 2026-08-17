/**
 * Bounded per-session write batching for the shared persistence coordinator
 * (M7). Ported from dsh's `SessionWriteBehind` semantics: fixed-deadline
 * batching, failure retention, background-failure reporting, and an explicit
 * flush quiescence barrier.
 * @module @i-harness/session-persistence/write-behind
 */

import type { SessionEvent } from "@i-harness/core-session"

/** Dependencies and scheduling policy for one live session's write controller. */
export interface SessionWriteBehindOptions {
  /** Fixed batching window after an idle queue receives work. */
  maxDelayMs: number
  /** Persist one stable ordered prefix; resolves only after backend durability. */
  write: (events: SessionEvent[]) => Promise<void>
  /** Observe a detached background write failure without rejecting the producer. */
  reportBackgroundFailure: (error: unknown) => void
}

/**
 * Owns one live session's pending events, fixed batching deadline, active
 * write, failure retention, and explicit quiescence barrier.
 */
export class SessionWriteBehind {
  private pending: SessionEvent[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<void> | undefined
  private barrier: Promise<void> | undefined
  private deadlineExpired = false
  private automaticPaused = false

  constructor(private readonly options: SessionWriteBehindOptions) {}

  /** Whether this controller owns queued events or an active durable write. */
  get hasWork(): boolean {
    return this.pending.length > 0 || this.active !== undefined
  }

  /** Copy one event into the persistence-owned queue and start a fixed deadline. */
  enqueue(event: SessionEvent): void {
    const wasEmpty = this.pending.length === 0
    this.pending.push(structuredClone(event))
    if (this.barrier !== undefined) return
    if (this.automaticPaused) {
      this.automaticPaused = false
      this.deadlineExpired = false
      this.armTimer()
    } else if (wasEmpty) {
      this.armTimer()
    }
  }

  /** Cancel the batching wait and durably drain through a quiescent point. */
  flush(): Promise<void> {
    if (this.barrier !== undefined) return this.barrier
    this.cancelTimer()
    this.deadlineExpired = false
    this.automaticPaused = false
    const barrier = Promise.withResolvers<void>()
    this.barrier = barrier.promise
    void this.drainBarrier(barrier.resolve, barrier.reject)
    return barrier.promise
  }

  /** Cancel the current automatic deadline without draining retained work. */
  cancelAutomaticWait(): void {
    this.cancelTimer()
    this.deadlineExpired = false
  }

  private armTimer(): void {
    this.timer = setTimeout(() => { this.onDeadline() }, this.options.maxDelayMs)
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private onDeadline(): void {
    this.timer = undefined
    if (this.active !== undefined) {
      this.deadlineExpired = true // the active write used the budget
      return
    }
    this.startBackground()
  }

  private startBackground(): void {
    const active = this.startWrite(true)
    void active.then(() => { this.continueAutomatic() }, () => {})
  }

  private continueAutomatic(): void {
    if (this.barrier !== undefined || this.pending.length === 0) return
    if (this.deadlineExpired) {
      this.deadlineExpired = false
      this.startBackground()
    }
  }

  private async drainBarrier(resolve: () => void, reject: (reason?: unknown) => void): Promise<void> {
    try {
      const overlapping = this.active
      if (overlapping !== undefined) {
        await Promise.allSettled([overlapping])
        this.automaticPaused = false
      }
      while (this.pending.length > 0) await this.startWrite(false)
    } catch (error: unknown) {
      this.barrier = undefined
      reject(error)
      return
    }
    this.barrier = undefined
    resolve()
  }

  private startWrite(background: boolean): Promise<void> {
    const batch = this.pending.splice(0)
    this.cancelTimer()
    this.deadlineExpired = false
    const operation = Promise.resolve().then(() => this.options.write(batch))
    const active = operation
      .catch((error: unknown) => {
        this.pending = batch.concat(this.pending)
        this.cancelTimer()
        this.deadlineExpired = false
        this.automaticPaused = true
        if (background) this.options.reportBackgroundFailure(error)
        throw error
      })
      .finally(() => {
        this.active = undefined
      })
    this.active = active
    return active
  }
}
