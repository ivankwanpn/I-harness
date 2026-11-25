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

/** Logical addresses only. This can be retained without any journal payload. */
export interface SessionHistoryFact {
  readonly type: SessionEventView['type']
  readonly seq?: number
  readonly inputId?: string
  readonly imageInputId?: string
}

export interface SessionHistoryPagePlan {
  range: ReturnType<typeof sessionHistoryRange>
  ordinals: number[]
  admissions: Map<number, number>
  turns?: SessionHistoryTurn[]
}

export function sessionHistoryFact(event: SessionEventView): SessionHistoryFact {
  return { type: event.type, seq: event.seq,
    ...(event.type === 'agent/input/admitted' ? { inputId: event.inputId } : {}),
    ...(event.type === 'user/message' && event.imageInputId !== undefined ? { imageInputId: event.imageInputId } : {}) }
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

/** Select logical records from the original verified order. The requesting
 * owner must prove the corresponding physical window before materialization. */
export function planSessionHistoryPage(facts: readonly SessionHistoryFact[], options: SessionHistoryPageOptions): SessionHistoryPagePlan | undefined {
  const { afterSeq, beforeSeq, limit, includeTurns } = options
  if (!Number.isInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit <= 0 ||
      (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)))
    throw new RangeError('Invalid session history range')
  const range = sessionHistoryRange(facts.length, { afterSeq, beforeSeq, limit: Math.min(limit, SESSION_HISTORY_LIMIT) })
  const { startSeq, nextSeq, headSeq } = range
  const ordinals = Array.from({ length: nextSeq - startSeq }, (_, index) => startSeq + index)
  const imageIds = new Set<string>()
  for (const ordinal of ordinals) {
    const inputId = facts[ordinal]!.imageInputId
    if (inputId !== undefined) imageIds.add(inputId)
  }
  const admissions = new Map<number, number>()
  if (imageIds.size) {
    const earlier = new Map<string, number>()
    for (let ordinal = 0; ordinal < nextSeq; ordinal++) {
      const fact = facts[ordinal]!
      if (fact.type === 'agent/input/admitted' && fact.inputId !== undefined && imageIds.has(fact.inputId))
        earlier.set(fact.inputId, ordinal)
      if (ordinal < startSeq || fact.imageInputId === undefined) continue
      const admission = earlier.get(fact.imageInputId)
      if (admission === undefined) throw new Error(`image admission not found for user/message: ${fact.imageInputId}`)
      admissions.set(ordinal, admission)
    }
    for (const admission of new Set(admissions.values())) if (admission < startSeq) ordinals.push(admission)
  }
  // An empty range of a nonempty log still requires its physical proof.
  if (!ordinals.length && headSeq) ordinals.push(headSeq - 1)
  // Legacy positional events may lack an explicit address. The snapshot path
  // still supports these events without an ordinal read.
  if (ordinals.some(ordinal => facts[ordinal]!.seq !== ordinal)) return undefined
  return { range, ordinals, admissions, ...(includeTurns ? { turns: sessionHistoryTurns(facts, startSeq, nextSeq) } : {}) }
}

/** Compose owned, physically verified records in the plan's ordinal order. */
export function materializeSessionHistoryPage(plan: SessionHistoryPagePlan, records: readonly SessionEventView[]): OwnedSessionHistoryPage {
  const { range, ordinals, admissions, turns } = plan
  if (records.length !== ordinals.length || ordinals.some((ordinal, index) => records[index]?.seq !== ordinal))
    throw new TypeError('Original selected history records required')
  const events = records.slice(0, range.nextSeq - range.startSeq)
  const images = new Map<number, readonly DeepReadonly<ImageInput>[]>()
  if (admissions.size) {
    const byOrdinal = new Map(records.map((record, index) => [ordinals[index]!, record]))
    for (const [ordinal, admission] of admissions) {
      const event = events[ordinal - range.startSeq], proof = byOrdinal.get(admission)
      if (event?.type !== 'user/message' || proof?.type !== 'agent/input/admitted' ||
          event.imageInputId !== proof.inputId || !proof.images?.length)
        throw new Error(`image admission not found for user/message: ${event?.type === 'user/message' ? event.imageInputId : ordinal}`)
      images.set(ordinal, proof.images)
    }
  }
  return { ...range, events, images, ...(turns === undefined ? {} : { turns }) }
}
