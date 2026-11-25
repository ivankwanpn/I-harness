import { useEffect, useRef, useState } from "react"
import type { HistoryRange } from "@i-harness/sdk"
import { HISTORY_PAGE_SIZE, MAX_HISTORY_VIEW_EVENTS, historyViewport, pageHistoryViewport, type HistoryViewport, type WireEvent } from "./event-window.ts"
import { loadEarlierHistory, type HistoryPageRequest, type HistoryReadScope } from "./history.ts"
import type { HistoryRequest } from "./SessionHistoryView.tsx"

type Selection = { workspaceId?: string; sessionId?: string }

export interface HistoryScroll {
  viewport?: HistoryViewport
  loading: boolean
  error?: string
  earlier?(): void
  later?(): void
  latest?(): void
}

/** Browsing holds one bounded snapshot for the selected session. Live replay
 * keeps its own cursor, so scrolling never delays or rewinds live admission. */
export function useHistoryScroll(
  selection: Selection,
  readOwner: HistoryReadScope,
  tail: readonly WireEvent[],
  liveCursor: number,
  request: (input: HistoryRequest) => Promise<HistoryRange>,
): HistoryScroll {
  const [view, setView] = useState<{ owner: Selection; viewport: HistoryViewport }>()
  const [error, setError] = useState<{ owner: HistoryReadScope; message: string }>()
  const [loading, setLoading] = useState<HistoryReadScope>()
  const owner = useRef(readOwner)
  owner.current = readOwner
  const flight = useRef<{ owner: HistoryReadScope } | undefined>(undefined)
  const current = () => owner.current === readOwner && readOwner.isCurrent()
  const viewport = view?.owner === selection ? view.viewport : undefined
  const oldest = viewport?.startSeq ?? tail[0]?.seq
  const hasBefore = viewport?.hasBefore ?? (oldest !== undefined && oldest > 0)
  const hasAfter = viewport?.hasAfter ?? false

  useEffect(() => {
    // A settled view survives standby. Only its request or error belongs to
    // the retired transport, while navigation also drops published pages.
    setView(current => current?.owner === selection ? current : undefined)
    setError(current => current?.owner === readOwner ? current : undefined)
    setLoading(current => current === readOwner ? current : undefined)
    return () => { if (flight.current?.owner === readOwner) flight.current = undefined }
  }, [selection, readOwner])

  const latest = () => {
    if (!current()) return
    if (flight.current?.owner === readOwner) flight.current = undefined
    setView(undefined)
    setError(undefined)
    setLoading(undefined)
  }

  async function page(direction: "before" | "after") {
    const { workspaceId, sessionId } = selection
    if (!workspaceId || !sessionId || !current() || flight.current?.owner === readOwner) return
    const cursor = direction === "before" ? oldest : viewport?.endSeq
    if (cursor === undefined || !(direction === "before" ? hasBefore : hasAfter)) return
    const ticket = { owner: readOwner }
    flight.current = ticket
    setError(undefined)
    setLoading(readOwner)
    const valid = () => flight.current === ticket && current()
    const read = async (params: HistoryPageRequest) => {
      if (!valid()) throw new Error("History selection changed")
      return request({ kind: "session/history", workspaceId, sessionId, ...params })
    }
    try {
      const range = direction === "before"
        ? await loadEarlierHistory(read, cursor, HISTORY_PAGE_SIZE)
        : await read({ afterSeq: cursor, limit: HISTORY_PAGE_SIZE })
      if (!valid()) return
      if (!Array.isArray(range.events) || !Number.isSafeInteger(range.nextSeq) || range.nextSeq < 0) throw new Error("Invalid history page")
      const events = range.events.filter(event => event.seq !== undefined && (direction === "before" ? event.seq < cursor : event.seq >= cursor))
      let previous = viewport
      if (!previous) {
        const seed = tail.slice(0, MAX_HISTORY_VIEW_EVENTS - HISTORY_PAGE_SIZE)
        const seedEnd = (seed.at(-1)?.seq ?? cursor - 1) + 1
        previous = { ...historyViewport({ events: seed, nextSeq: seedEnd }, cursor), hasAfter: seedEnd < liveCursor }
      }
      const next = pageHistoryViewport(previous, { ...range, events }, previous.startSeq, direction)
      if (direction === "before") {
        next.startSeq = events[0]?.seq ?? previous.startSeq
        next.hasBefore = next.startSeq > 0 && next.startSeq < cursor
      } else {
        if (events.length > 0) next.endSeq = Math.max(next.endSeq, range.nextSeq)
        const head = range.headSeq ?? liveCursor
        next.hasAfter = next.endSeq > cursor && next.endSeq < head
      }
      setView({ owner: selection, viewport: next })
    } catch (reason) {
      if (valid()) setError({ owner: readOwner, message: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      if (valid()) { flight.current = undefined; setLoading(undefined) }
    }
  }

  return {
    viewport,
    loading: loading === readOwner,
    error: error?.owner === readOwner ? error.message : undefined,
    ...(hasBefore ? { earlier: () => { void page("before") } } : {}),
    ...(hasAfter ? { later: () => { void page("after") } } : {}),
    ...(viewport || loading === readOwner ? { latest } : {}),
  }
}
