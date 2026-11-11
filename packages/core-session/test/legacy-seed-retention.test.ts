import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { append, createSession, createLegacyRetentionSelection, exportConversationSeed, type SessionEvent } from '../src/index.ts'

const ref: Extract<SessionEvent, { type: 'context/result-ref' }>['ref'] = { id: 'ctx_' + 'a'.repeat(64), workspaceId: 'w', sessionId: 'creator', callId: 'call', label: 'label', revision: 'b'.repeat(64), bytes: 1, originalBytes: 1, complete: true, expiresAt: 2_000_000_000_000 }
it('keeps metadata after turn/end in the selected turn and emits no guessed observing session ID', () => {
  const view = createSession()
  append(view, { type: 'turn/start' }); append(view, { type: 'user/message', text: 'selected' }); append(view, { type: 'turn/end' }); append(view, { type: 'context/result-ref', ref })
  append(view, { type: 'turn/start' }); append(view, { type: 'user/message', text: 'future' }); append(view, { type: 'context/result-ref', ref: { ...ref, callId: 'future' } })
  const selected = createLegacyRetentionSelection(view, { kind: 'completed', atSeq: 2 })
  expect(selected.kind).toBe('selected')
  if (selected.kind !== 'selected') throw Error('Expected selected')
  expect([...selected.local()]).toEqual([{ ref, original: { seq: 3, part: 'context/result-ref.ref' }, extent: { kind: 'framed', first: 1, last: 1 }, anchor: { kind: 'seed-group', manifestSeq: 0, ordinal: 0 } }])
  expect(selected.turnDomainDigest).toBe(createHash('sha256').update('ih.legacy-fork.turn-domain.v1\0{"completed":[[1,1]],"total":1,"unframedPrefix":false}').digest('hex'))
})
it('uses the manifest only for an actual selected unframed prefix', () => {
  const view = createSession()
  append(view, { type: 'user/message', text: 'prefix' }); append(view, { type: 'context/result-ref', ref }); append(view, { type: 'turn/start' }); append(view, { type: 'user/message', text: 'framed' }); append(view, { type: 'turn/end' })
  const selected = createLegacyRetentionSelection(view, { kind: 'completed' })
  if (selected.kind !== 'selected') throw Error('Expected selected')
  expect([...selected.local()][0]).toMatchObject({ original: { seq: 1 }, extent: { kind: 'unframed' }, anchor: { kind: 'manifest', seq: 0 } })
  expect(exportConversationSeed(view, { kind: 'session', sessionId: 'source' }, { kind: 'completed' }).kind).toBe('seed')
})
it('refuses duplicate/ambiguous source coordinates before exposing an observation iterator', () => {
  const view = createSession()
  append(view, { type: 'turn/start' }); append(view, { type: 'user/message', text: 'selected' }); append(view, { type: 'context/result-ref', ref }); append(view, { type: 'turn/end' })
  const ambiguous = { ...view, events: view.events.map((event, index) => index === 2 ? { ...event, seq: 1 } : event) }
  expect(createLegacyRetentionSelection(ambiguous, { kind: 'completed' }).kind).toBe('refused')
})

it('last-turn selection omits an older legacy ref without refusing selected text', () => {
  const view = createSession()
  append(view, { type: 'turn/start' })
  append(view, { type: 'user/message', text: 'older' })
  append(view, { type: 'context/result-ref', ref })
  append(view, { type: 'turn/end' })
  append(view, { type: 'turn/start' })
  append(view, { type: 'user/message', text: 'selected' })
  append(view, { type: 'turn/end' })
  const last = createLegacyRetentionSelection(view, { kind: 'last-turns', count: 1 })
  expect(last.kind).toBe('selected')
  if (last.kind !== 'selected') throw Error('Expected selected')
  expect([...last.local()]).toEqual([])
  expect(last.inherited({ kind: 'framed', first: 1, last: 1 }, { kind: 'seed-group', manifestSeq: 0, ordinal: 0 })).toEqual({ kind: 'omitted' })
  const all = createLegacyRetentionSelection(view, { kind: 'all' })
  expect(all.kind).toBe('selected')
  if (all.kind !== 'selected') throw Error('Expected selected')
  expect([...all.local()]).toHaveLength(1)
})
it('last-turn selection retains a ref in the selected turn with its rebased extent', () => {
  const view = createSession()
  append(view, { type: 'turn/start' })
  append(view, { type: 'user/message', text: 'older' })
  append(view, { type: 'turn/end' })
  append(view, { type: 'turn/start' })
  append(view, { type: 'user/message', text: 'selected' })
  append(view, { type: 'context/result-ref', ref })
  append(view, { type: 'turn/end' })
  const selected = createLegacyRetentionSelection(view, { kind: 'last-turns', count: 1 })
  expect(selected.kind).toBe('selected')
  if (selected.kind !== 'selected') throw Error('Expected selected')
  expect([...selected.local()]).toEqual([{ ref, original: { seq: 5, part: 'context/result-ref.ref' }, extent: { kind: 'framed', first: 1, last: 1 }, anchor: { kind: 'seed-group', manifestSeq: 0, ordinal: 0 } }])
})
