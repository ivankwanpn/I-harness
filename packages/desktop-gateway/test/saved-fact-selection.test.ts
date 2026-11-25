import { expect, it, vi } from 'vitest'
import type { SessionView } from '@i-harness/core-session'
import { createFixedFactSelection, createFixedTerminalSelections } from '../src/saved-fact-selection.ts'
import { savedTerminals } from '../src/saved-terminals.ts'

type Event = SessionView['events'][number]
const owner = 'owner'
const session = (events: Event[]): SessionView => ({ formatVersion: 14, events })
function terminal(id: string, seq: number, options: { code?: boolean; resultOwner?: string } = {}): Event[] {
  const callId = `open-${id}-${seq}`
  const output = { id, ownerSessionId: options.resultOwner ?? owner, status: 'running' }
  return options.code
    ? [{ type: 'code/call', cellId: 'cell', parentCallId: 'outer', callId, name: 'terminal_open', args: { id }, seq },
      { type: 'code/dispatch', cellId: 'cell', callId, eventSeq: seq, seq: seq + 1 },
      { type: 'code/result', cellId: 'cell', callId, name: 'terminal_open', output, seq: seq + 2 }]
    : [{ type: 'tool/call', callId, name: 'terminal_open', args: { id }, seq },
      { type: 'tool/dispatch', callId, eventSeq: seq, seq: seq + 1 },
      { type: 'tool/result', callId, name: 'terminal_open', output, seq: seq + 2 }]
}
const selectors = (events: Event[]) => [...savedTerminals(events, owner).values()].map(({ id, evidence }) => ({ id, evidence }))

it('seeds 200 saved terminals with one fixed replay and one shared original cell', () => {
  const events: Event[] = Array.from({ length: 9400 }, (_, seq) => ({ type: 'user/message', seq, text: 'observed archive' }))
  events.push({ type: 'code/cell', sessionId: owner, cellId: 'cell', parentCallId: 'outer', state: 'started', seq: events.length })
  for (let i = 0; i < 200; i++) events.push(...terminal(`pty-${i}`, events.length, { code: true }))
  const selected = selectors(events)
  expect(selected).toHaveLength(200)

  const iteration = vi.spyOn(events, Symbol.iterator)
  const clone = vi.spyOn(globalThis, 'structuredClone')
  try {
    expect(() => createFixedTerminalSelections(session(events), selected, owner).assertCurrent()).not.toThrow()
    expect(iteration).toHaveBeenCalledTimes(2) // rewind ranges once, then the original pending state once
    expect(clone).toHaveBeenCalledTimes(400) // one pending call and dispatch for each original invocation
  } finally { clone.mockRestore(); iteration.mockRestore() }
})

it('applies an already-delivered suffix and refuses replacement of one selected terminal', () => {
  const events = [...terminal('a', 0), ...terminal('b', 3)]
  const all = selectors(events), initial = session(events)
  const selected = createFixedTerminalSelections(initial, all, owner)
  const standalone = createFixedFactSelection(initial, all[0]!.evidence, owner, 'a')
  const unrelated = terminal('other', 6)
  const foreign = terminal('b', 9, { resultOwner: 'other-owner' })
  selected.append(6, unrelated)
  selected.append(9, foreign)
  selected.assertCurrent()
  standalone.append(6, [...unrelated, ...foreign])

  const replacement = terminal('b', 12)
  expect(() => selected.append(12, replacement)).toThrow(/evidence changed/)
  expect(() => standalone.append(12, replacement)).not.toThrow()
  standalone.assertCurrent()
})

it('keeps rewind, original-coordinate and Code cell owner checks in the shared proof', () => {
  const events: Event[] = [
    { type: 'code/cell', sessionId: owner, cellId: 'cell', parentCallId: 'outer', state: 'started', seq: 0 },
    ...terminal('a', 1, { code: true }), ...terminal('b', 4),
  ]
  const selected = selectors(events)
  const create = () => createFixedTerminalSelections(session(events), selected, owner)
  expect(() => create().append(7, [{ type: 'rewind/point', anchorSeq: 6, seq: 7 }])).toThrow(/evidence changed/)
  expect(() => create().append(7, [{ type: 'code/cell', sessionId: 'foreign', cellId: 'cell', parentCallId: 'outer', state: 'completed', seq: 7 }]))
    .toThrow(/evidence changed/)
  const old = create()
  const replaced = events.map(event => event.seq === 6 ? { ...event, output: { id: 'unrelated' } } as Event : event)
  expect(() => old.revalidate(session(replaced))).toThrow(/evidence changed/)
})
