import { expect, it } from 'vitest'
import { materializeSessionHistoryPage, planSessionHistoryPage, sessionHistoryFact } from '../src/serialization/archive-internal.ts'
import type { SessionEventView } from '../src/managed/types.ts'

const photo = (dataBase64: string) => ({ mediaType: 'image/png' as const, dataBase64 })
const admission = (seq: number, image?: ReturnType<typeof photo>): SessionEventView => ({
  type: 'agent/input/admitted', version: 1, seq, inputId: 'repeat', text: 'picture', delivery: 'queue', intent: 'user',
  ...(image === undefined ? {} : { images: [image] }),
})

it('plans partial turns and page-external images from logical records alone', () => {
  const latest = photo('bGF0ZXN0'), future = photo('ZnV0dXJl')
  const events: SessionEventView[] = [
    admission(0, photo('b2xk')), { type: 'turn/start', seq: 1 }, admission(2, latest),
    { type: 'user/message', text: 'show latest', imageInputId: 'repeat', seq: 3 },
    { type: 'assistant/message', text: 'reply', seq: 4 }, { type: 'turn/end', seq: 5 },
    admission(6, future), { type: 'turn/start', seq: 7 },
    { type: 'user/message', text: 'show future', imageInputId: 'repeat', seq: 8 },
  ]
  const facts = events.map(sessionHistoryFact)
  expect(facts[2]).toEqual({ type: 'agent/input/admitted', inputId: 'repeat', seq: 2 })
  expect(facts[3]).toEqual({ type: 'user/message', imageInputId: 'repeat', seq: 3 })
  const middle = planSessionHistoryPage(facts, { afterSeq: 0, beforeSeq: 5, limit: 2, includeTurns: true })!
  expect(middle.ordinals).toEqual([3, 4, 2])
  expect(materializeSessionHistoryPage(middle, middle.ordinals.map(seq => events[seq]!))).toEqual({
    startSeq: 3, nextSeq: 5, headSeq: 9, events: events.slice(3, 5),
    images: new Map([[3, [latest]]]), turns: [{ startSeq: 1, endSeq: 5 }],
  })
  expect(() => materializeSessionHistoryPage(middle, events.slice(2, 5))).toThrow('Original selected history records required')

  const open = planSessionHistoryPage(facts, { afterSeq: 8, limit: 1, includeTurns: true })!
  expect(open.ordinals).toEqual([8, 6])
  expect(materializeSessionHistoryPage(open, open.ordinals.map(seq => events[seq]!))).toEqual({
    startSeq: 8, nextSeq: 9, headSeq: 9, events: [events[8]], images: new Map([[8, [future]]]), turns: [{ startSeq: 7 }],
  })
})

it('requires the latest earlier admission even if an older repeat has images', () => {
  const events: SessionEventView[] = [admission(0, photo('b2xk')), admission(1), { type: 'user/message', text: 'show', imageInputId: 'repeat', seq: 2 }]
  const plan = planSessionHistoryPage(events.map(sessionHistoryFact), { afterSeq: 2, limit: 1 })!
  expect(plan.ordinals).toEqual([2, 1])
  expect(() => materializeSessionHistoryPage(plan, plan.ordinals.map(seq => events[seq]!))).toThrow('image admission not found for user/message: repeat')
  expect(() => planSessionHistoryPage([sessionHistoryFact({ ...events[2]!, seq: 0 })], { afterSeq: 0, limit: 1 })).toThrow('image admission not found for user/message: repeat')
})

it('keeps empty windows and legacy ordinal fallback distinct', () => {
  const event: SessionEventView = { type: 'user/message', text: 'saved', seq: 0 }
  const past = planSessionHistoryPage([sessionHistoryFact(event)], { afterSeq: 99, limit: 1, includeTurns: true })!
  expect(past.ordinals).toEqual([0])
  expect(materializeSessionHistoryPage(past, [event])).toEqual({ startSeq: 1, nextSeq: 1, headSeq: 1, events: [], images: new Map(), turns: [] })
  const empty = planSessionHistoryPage([], { afterSeq: 0, beforeSeq: 0, limit: 1 })!
  expect(empty.ordinals).toEqual([])
  expect(materializeSessionHistoryPage(empty, [])).toEqual({ startSeq: 0, nextSeq: 0, headSeq: 0, events: [], images: new Map() })
  expect(planSessionHistoryPage([sessionHistoryFact({ ...event, seq: undefined })], { afterSeq: 0, limit: 1 })).toBeUndefined()
})
