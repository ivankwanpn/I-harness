import type { HistoryRange } from "@i-harness/sdk"

export interface HistoryPageRequest {
  afterSeq: number
  limit: number
}

export interface HistoryLoad {
  events: HistoryRange["events"]
  cursor: number
  /** False when the page budget ran out before the durable log did. */
  exhausted: boolean
  startSeq?: number
}

/** Existing SDK history clamps an oversized cursor to the durable log head.
 * Probe that head without loading content, then load only the latest window. */
export async function loadRecentHistory(
  request: (params: HistoryPageRequest) => Promise<HistoryRange>,
  options: { limit: number; maxEvents: number },
): Promise<HistoryLoad> {
  const head = await request({ afterSeq: Number.MAX_SAFE_INTEGER, limit: 1 })
  if (!Number.isSafeInteger(head.nextSeq) || head.nextSeq < 0) throw new Error("Invalid history head")
  const startSeq = Math.max(0, head.nextSeq - options.maxEvents)
  const loaded = await loadHistory(request, { afterSeq: startSeq, limit: options.limit, maxPages: Math.ceil(options.maxEvents / options.limit) })
  return { ...loaded, startSeq, exhausted: loaded.cursor >= head.nextSeq }
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
