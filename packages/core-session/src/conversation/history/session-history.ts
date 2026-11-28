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
  return overlappingTurns(turns, start, end)
}

function overlappingTurns(turns: readonly SessionHistoryTurn[], start: number, end: number): SessionHistoryTurn[] {
  if (start >= end) return []
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
  return planRange(facts, checkedRange(facts.length, options), options.includeTurns)
}

function checkedRange(head: number, options: SessionHistoryPageOptions) {
  const { afterSeq, beforeSeq, limit } = options
  if (!Number.isInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit <= 0 ||
      (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)))
    throw new RangeError('Invalid session history range')
  return sessionHistoryRange(head, { afterSeq, beforeSeq, limit: Math.min(limit, SESSION_HISTORY_LIMIT) })
}

function planRange(facts: readonly SessionHistoryFact[], range: SessionHistoryPagePlan['range'], includeTurns?: boolean): SessionHistoryPagePlan | undefined {
  const { startSeq, nextSeq } = range
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
  }
  appendProofOrdinals(ordinals, range, admissions)
  // Legacy positional events may lack an explicit address. The snapshot path
  // still supports these events without an ordinal read.
  if (ordinals.some(ordinal => facts[ordinal]!.seq !== ordinal)) return undefined
  return { range, ordinals, admissions, ...(includeTurns ? { turns: sessionHistoryTurns(facts, startSeq, nextSeq) } : {}) }
}

function appendProofOrdinals(ordinals: number[], range: SessionHistoryPagePlan['range'], admissions: Map<number, number>) {
  for (const admission of new Set(admissions.values())) if (admission < range.startSeq) ordinals.push(admission)
  if (!ordinals.length && range.headSeq) ordinals.push(range.headSeq - 1)
}

/** Plan a bounded neighborhood in the scroll direction with absolute image
 * and turn coordinates. Only this plan needs to survive the original scan. */
export function planSessionHistoryWindow(facts: readonly SessionHistoryFact[], options: SessionHistoryPageOptions, maxEvents: number) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < SESSION_HISTORY_LIMIT) throw new RangeError('Invalid history window size')
  const requested = checkedRange(facts.length, options), width = Math.min(maxEvents, facts.length)
  const origin = options.beforeSeq === undefined ? requested.startSeq : requested.nextSeq - width
  const startSeq = Math.max(0, Math.min(facts.length - width, origin))
  return planRange(facts, { startSeq, nextSeq: startSeq + width, headSeq: facts.length }, true)
}

export function pageFromSessionHistoryWindow(window: Pick<SessionHistoryPagePlan, 'range' | 'admissions' | 'turns'>, options: SessionHistoryPageOptions): SessionHistoryPagePlan | undefined {
  const range = checkedRange(window.range.headSeq, options)
  if (range.startSeq < window.range.startSeq || range.nextSeq > window.range.nextSeq) return
  const ordinals = Array.from({ length: range.nextSeq - range.startSeq }, (_, index) => range.startSeq + index)
  const admissions = new Map<number, number>()
  for (const ordinal of ordinals) {
    const admission = window.admissions.get(ordinal)
    if (admission !== undefined) admissions.set(ordinal, admission)
  }
  appendProofOrdinals(ordinals, range, admissions)
  return { range, ordinals, admissions, ...(options.includeTurns ? { turns: overlappingTurns(window.turns!, range.startSeq, range.nextSeq) } : {}) }
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
