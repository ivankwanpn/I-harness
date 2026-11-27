import { expect, it } from 'vitest'
import type { SessionEvent } from '../src/index.ts'
import { createConversationValidationIndex, prepareConversationAppend } from '../src/conversation/validation.ts'
import { historyFact, type HistoryFact } from '../src/conversation/history/facts.ts'
import { groupConversationHistory } from '../src/conversation/history/group.ts'
import { projectHistory } from '../src/conversation/history/replacements.ts'
import { historyVisibility } from '../src/conversation/history/visibility.ts'
import { inferLegacy } from '../src/conversation/legacy.ts'

const fence = { type: 'conversation/semantics', seq: 100, version: 1, mode: 'accepted-exchange-v1' } as const
const legacy = { type: 'assistant/message', seq: 7, text: 'Before the fence' } as const
const exchange = [
  { type: 'step/start', seq: 101, actionId: 'action', attemptId: 'attempt' },
  { type: 'assistant/message', seq: 102, text: 'Without an acceptance' },
  { type: 'step/end', seq: 103 },
] as const satisfies readonly SessionEvent[]

function projectDirect(events: readonly SessionEvent[], throughSeq?: number) {
  const facts = events.map((event, index) => historyFact(event, index))
  return projectHistory({ length: facts.length, get: index => facts[index]! }, throughSeq)
}

function replacement(seq: number, sourceSeq: number, kind: 'exchange' | 'summary' = 'exchange') {
  const at = { seq: sourceSeq, part: 'message' }, item = { kind, at } as const
  return { type: 'compaction/replacement', version: 1, replacementId: `replace-${seq}`, seq,
    text: 'Summary', coverage: [{ item, sources: [at] }], insertBefore: item } as const
}

it.each([
  { name: 'absent', prefix: [legacy], visible: [0, 2] },
  { name: 'ordinal zero', prefix: [fence], visible: [] },
  { name: 'late and distinct from sequence', prefix: [legacy, fence], visible: [0] },
])('keeps owned and direct history equal with a $name semantics fence', ({ prefix, visible }) => {
  const events = [...prefix, ...exchange]
  const owned = createConversationValidationIndex(events, { formatVersion: 7 })
  const history = owned.history()
  expect(history).toEqual(projectDirect(events))
  expect(history.items.flatMap(item => item.recipes.filter(recipe => recipe.kind === 'assistant').map(recipe => recipe.index))).toEqual(visible)
  expect(owned.history(7)).toEqual(projectDirect(events, 7))
})

it('publishes the staged fence only on a successful original append', async () => {
  const prefix = [legacy], suffix = [fence, ...exchange]
  const owned = createConversationValidationIndex(prefix, { formatVersion: 7 })
  const read = async () => { throw Error('The isolated suffix has no external dependencies') }
  const staged = await prepareConversationAppend(owned, suffix, read, () => {})
  expect(staged.history()).toEqual(projectDirect([...prefix, ...suffix]))
  expect(owned.history()).toEqual(projectDirect(prefix))
  staged.discard()
  expect(() => staged.commit()).toThrow('stale staged suffix')
  expect(owned.eventCount).toBe(1)
  expect(owned.semanticsStartSeq).toBeUndefined()
  expect(() => owned.stage([fence, { ...fence, seq: 101 }])).toThrow('duplicate semantics fence')
  expect(owned.history()).toEqual(projectDirect(prefix))

  const accepted = await prepareConversationAppend(owned, suffix, read, () => {})
  accepted.commit()
  expect(owned.eventCount).toBe(5)
  expect(owned.semanticsStartSeq).toBe(100)
  expect(owned.history()).toEqual(projectDirect([...prefix, ...suffix]))
})

it('uses only the exact preceding history to validate replacement across a staged fence', () => {
  const owned = createConversationValidationIndex([legacy], { formatVersion: 7 })
  expect(() => owned.stage([fence, ...exchange, replacement(104, 102)])).toThrowError(expect.objectContaining({
    code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'missing-source',
  }))
  expect(owned.replacementDependencies().size).toBe(0)
  expect(owned.history()).toEqual(projectDirect([legacy]))

  const before = replacement(8, 7), suffix = [before, fence, ...exchange]
  const staged = owned.stage(suffix)
  expect(staged.history()).toEqual(projectDirect([legacy, ...suffix]))
  staged.commit()
  expect([...owned.replacementDependencies().get(8)!]).toEqual([7])
  expect(owned.history()).toEqual(projectDirect([legacy, ...suffix]))
})

it('keeps first and second replacement effects on the exact staged or installed prefix', async () => {
  const owned = createConversationValidationIndex([legacy], { formatVersion: 7 })
  const suffix = [replacement(8, 7), replacement(9, 8, 'summary')], events = [legacy, ...suffix]
  const read = async (ordinal: number) => { expect(ordinal).toBe(0); return legacy }
  const staged = await prepareConversationAppend(owned, suffix, read, () => {})
  expect(staged.history()).toEqual(projectDirect(events))
  expect(staged.history().items.map(item => item.establishment.seq)).toEqual([9])
  staged.discard()
  expect(() => staged.commit()).toThrow('stale staged suffix')
  expect(owned.history()).toEqual(projectDirect([legacy]))
  expect(owned.replacementDependencies().size).toBe(0)

  const accepted = await prepareConversationAppend(owned, suffix, read, () => {})
  accepted.commit()
  expect(owned.history()).toEqual(projectDirect(events))
  for (const seq of [7, 8, 9]) {
    expect(owned.history(seq)).toEqual(projectDirect(events, seq))
    expect(owned.history(seq).items.map(item => item.establishment.seq)).toEqual([seq])
  }
})

it.each(['duplicate-id', 'missing-source'] as const)('still refuses %s against both prior staged and committed replacements', reason => {
  const owned = createConversationValidationIndex([legacy], { formatVersion: 7 })
  const first = replacement(8, 7)
  const second = reason === 'duplicate-id' ? { ...replacement(9, 8, 'summary'), replacementId: first.replacementId } : replacement(9, 7)
  const denied = expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason })
  expect(() => owned.stage([first, second])).toThrowError(denied)
  expect(owned.replacementDependencies().size).toBe(0)
  expect(owned.history()).toEqual(projectDirect([legacy]))
  owned.stage([first]).commit()
  expect(() => owned.stage([second])).toThrowError(denied)
  expect(owned.history()).toEqual(projectDirect([legacy, first]))
})

it('keeps foreign archive enumeration before inspecting its first fence', () => {
  const order: string[] = []
  const facts = [
    { index: 0, seq: 7, get type() { order.push('type:0'); return 'user/message' as const } },
    historyFact(fence, 1),
  ] satisfies HistoryFact[]
  const sources = { ref() { throw Error('Unexpected foreign source read') }, provenance() { throw Error('Unexpected provenance read') } }
  const result = inferLegacy({ length: facts.length, get(index) { order.push(`get:${index}`); return facts[index]! } }, historyVisibility([]), sources, [])
  expect(result.fenceIndex).toBe(1)
  expect(order.slice(0, 3)).toEqual(['get:0', 'get:1', 'type:0'])
})

it('keeps the ordinary replacement lookup passes for a foreign archive with no replacement', () => {
  const facts = [historyFact(legacy, 0), historyFact({ type: 'user/message', seq: 8, text: 'Follow-up' }, 1)]
  const archive = (reads: number[]) => ({ length: facts.length, get(index: number) { reads.push(index); return facts[index]! } })
  const groupingReads: number[] = [], projectionReads: number[] = []
  const grouped = groupConversationHistory(archive(groupingReads))
  expect(projectHistory(archive(projectionReads))).toEqual(grouped)
  expect(projectionReads).toEqual([...groupingReads, 0, 1, 0, 1])
})
