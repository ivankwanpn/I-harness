import type { SessionEventView as SessionEvent } from "@i-harness/core-session"
import type { HistoryTurn } from "./protocol.ts"

interface TurnIndex {
  indexed: number
  last?: SessionEvent
  turns: HistoryTurn[]
}

// The event log owns this index. Appends extend it; a replaced or truncated
// log starts a fresh index. Returning a page never retains a cold session.
const indexes = new WeakMap<readonly SessionEvent[], TurnIndex>()

export function historyTurns(events: readonly SessionEvent[], start: number, end: number): HistoryTurn[] {
  if (start >= end) return []
  let index = indexes.get(events)
  if (!index || index.indexed > events.length || events[index.indexed - 1] !== index.last) {
    index = { indexed: 0, turns: [] }
    indexes.set(events, index)
  }
  const turns = index.turns
  for (let seq = index.indexed; seq < events.length; seq++) {
    const event = events[seq]!
    if (event.type === "turn/start") turns.push({ startSeq: seq })
    if (event.type === "turn/end") {
      const open = turns.at(-1)
      if (open && open.endSeq === undefined) open.endSeq = seq
    }
  }
  index.indexed = events.length
  index.last = events.at(-1)
  let lo = 0
  let hi = turns.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (turns[mid]!.startSeq <= start) lo = mid + 1
    else hi = mid
  }
  const page: HistoryTurn[] = []
  for (let i = Math.max(0, lo - 1); i < turns.length && turns[i]!.startSeq < end; i++) {
    const turn = turns[i]!
    if (turn.endSeq === undefined || turn.endSeq >= start) page.push({ ...turn })
  }
  return page
}
