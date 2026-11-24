import type { ImageInput } from '../../images.ts'
import type { DeepReadonly, SessionEventView } from '../../managed/types.ts'

export const SESSION_HISTORY_LIMIT = 1000

export interface SessionHistoryPageOptions {
  afterSeq: number
  beforeSeq?: number
  limit: number
  includeTurns?: boolean
}

interface SessionHistoryTurn {
  startSeq: number
  endSeq?: number
}

export interface OwnedSessionHistoryPage {
  startSeq: number
  nextSeq: number
  headSeq: number
  events: readonly SessionEventView[]
  images: ReadonlyMap<number, readonly DeepReadonly<ImageInput>[]>
  turns?: SessionHistoryTurn[]
}

export function sessionHistoryRange(headSeq: number, { afterSeq, beforeSeq, limit }: SessionHistoryPageOptions) {
  const nextSeq = beforeSeq === undefined ? Math.min(afterSeq + limit, headSeq) : Math.min(beforeSeq, headSeq)
  const startSeq = beforeSeq === undefined ? Math.min(afterSeq, headSeq) : Math.max(0, nextSeq - limit)
  return { startSeq, nextSeq, headSeq }
}

type TurnRecord = Pick<SessionEventView, 'type'>
type TurnIndex = { indexed: number; last?: TurnRecord; turns: SessionHistoryTurn[] }
const indexes = new WeakMap<readonly TurnRecord[], TurnIndex>()

/** Raw event-log turn boundaries for SDK history, including turns spanning a page. */
export function sessionHistoryTurns(events: readonly TurnRecord[], start: number, end: number): SessionHistoryTurn[] {
  if (start >= end) return []
  let index = indexes.get(events)
  if (!index || index.indexed > events.length || events[index.indexed - 1] !== index.last) {
    index = { indexed: 0, turns: [] }
    indexes.set(events, index)
  }
  const turns = index.turns
  for (let seq = index.indexed; seq < events.length; seq++) {
    const event = events[seq]!
    if (event.type === 'turn/start') turns.push({ startSeq: seq })
    if (event.type === 'turn/end') {
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
  const page: SessionHistoryTurn[] = []
  for (let i = Math.max(0, lo - 1); i < turns.length && turns[i]!.startSeq < end; i++) {
    const turn = turns[i]!
    if (turn.endSeq === undefined || turn.endSeq >= start) page.push({ ...turn })
  }
  return page
}
