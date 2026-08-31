import type { Session, SessionEvent } from "@i-harness/core-session"
import type { SessionPage } from "./types.ts"

export interface PaginateOptions {
  beforeSeq?: number
  /** C2 (afterSeq forward replay): events STRICTLY AFTER the cursor, in log
   * order — the resume-after-disconnect seq replay. Mutually exclusive with
   * beforeSeq at the route layer (the fold keeps them independent). */
  afterSeq?: number
  limit?: number
}

/** Page size used when `limit` is absent or invalid (see paginateEvents). */
export const DEFAULT_PAGE_LIMIT = 200
/** Hard cap on page size: a huge `?limit=` must not dump a whole session. */
export const MAX_PAGE_LIMIT = 500

function seqOf(ev: SessionEvent): number {
  return ev.seq ?? 0
}

export function paginateEvents(session: Session, opts: PaginateOptions): SessionPage {
  // Input validation (review MUST-FIX): `Math.max(1, NaN)` is NaN, and
  // `slice(-NaN)` === `slice(0)` — so a non-numeric `?limit=abc` used to
  // return the ENTIRE session. Non-finite / sub-1 limits fall back to the
  // default; valid limits are floored and clamped to the hard page cap.
  const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit >= 1
    ? Math.min(Math.floor(opts.limit), MAX_PAGE_LIMIT)
    : DEFAULT_PAGE_LIMIT
  // C2 (afterSeq forward replay): non-finite afterSeq is treated as absent
  // (the route-level validation REJECTS it instead so the client notices —
  // the fold stays permissive like the branch's beforeSeq arm).
  if (opts.afterSeq !== undefined && Number.isFinite(opts.afterSeq)) {
    const eligible = session.events.filter((ev) => seqOf(ev) > opts.afterSeq!)
    const head = eligible.slice(0, limit)
    const last = head.length > 0 ? seqOf(head[head.length - 1]!) : undefined
    const hasMore = eligible.length > head.length
    return { events: head, hasMore, ...(last === undefined ? {} : { nextAfterSeq: last }) }
  }
  // `beforeSeq` present but not finite (`?beforeSeq=abc`) → treated as absent.
  const limitSeq = typeof opts.beforeSeq === "number" && Number.isFinite(opts.beforeSeq)
    ? opts.beforeSeq
    : Number.MAX_SAFE_INTEGER
  const eligible = session.events.filter(ev => seqOf(ev) < limitSeq)
  const tail = eligible.slice(-limit)
  const oldest = tail.length > 0 ? seqOf(tail[0]) : undefined
  const hasMore = eligible.length > tail.length
  return {
    events: tail,
    hasMore,
    ...(oldest === undefined ? {} : { nextBeforeSeq: oldest }),
  }
}
