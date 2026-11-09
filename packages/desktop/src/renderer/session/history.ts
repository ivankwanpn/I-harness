import type { HistoryRange } from "@i-harness/sdk"

export interface HistoryPageRequest {
  afterSeq: number
  beforeSeq?: number
  limit: number
}

export interface HistoryLoad {
  events: HistoryRange["events"]
  cursor: number
  /** False when the page budget ran out before the durable log did. */
  exhausted: boolean
  startSeq?: number
}

/** Tail read: one request returns the newest bounded window plus the durable
 * head, instead of probing and then re-snapshotting the full log page by page. */
export async function loadRecentHistory(
  request: (params: HistoryPageRequest) => Promise<HistoryRange>,
  options: { limit: number; maxEvents?: number },
): Promise<HistoryLoad> {
  const tail = await request({ afterSeq: 0, beforeSeq: Number.MAX_SAFE_INTEGER, limit: options.limit })
  if (!Number.isSafeInteger(tail.nextSeq) || !Number.isSafeInteger(tail.headSeq) || !Number.isSafeInteger(tail.startSeq)) throw new Error("Invalid history tail")
  return { events: tail.events, cursor: tail.nextSeq, exhausted: tail.nextSeq >= tail.headSeq!, startSeq: tail.startSeq }
}

/**
 * Cursor-driven paging: each page is requested strictly after the last
 * confirmed seq, so a long session is backfilled completely (up to maxPages)
 * instead of showing only its first window.
 */
export async function loadHistory(
  request: (params: HistoryPageRequest) => Promise<HistoryRange>,
  options: { afterSeq: number; limit: number; maxPages?: number },
): Promise<HistoryLoad> {
  const maxPages = options.maxPages ?? 40
  const events: HistoryRange["events"] = []
  let cursor = options.afterSeq
  for (let page = 0; page < maxPages; page += 1) {
    const result = await request({ afterSeq: cursor, limit: options.limit })
    events.push(...result.events)
    const previous = cursor
    cursor = Math.max(cursor, result.nextSeq)
    // A short page means the log is exhausted; a non-advancing cursor means a
    // server that has nothing more to give.
    if (result.events.length < options.limit || cursor <= previous) {
      return { events, cursor, exhausted: true }
    }
  }
  return { events, cursor, exhausted: false }
}
