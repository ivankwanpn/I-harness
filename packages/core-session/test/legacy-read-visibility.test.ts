import { expect, it } from 'vitest'
import * as core from '../src/index.ts'
import { literalReady } from './fixtures/format11-seed.ts'
const ref = { id: 'ctx_' + 'a'.repeat(64), revision: 'b'.repeat(64), workspaceId: 'workspace', sessionId: 'creator', callId: 'call', label: 'retained', bytes: 1, originalBytes: 1, complete: true, expiresAt: 1234.5 }
it('reads typed visible local refs in unfinished turns and excludes shadow/rewind coordinates', () => {
  const view = core.createSession()
  core.append(view, { type: 'turn/start' }); core.append(view, { type: 'user/message', text: 'ctx_fake is not authority' })
  core.append(view, { type: 'context/result-ref', ref })
  let visible = core.createLegacyReadVisibility(view)
  expect(visible.kind).toBe('visible')
  if (visible.kind !== 'visible') throw new Error('Expected visible')
  expect([...visible.local()]).toEqual([{ ref, original: { seq: 2, part: 'context/result-ref.ref' } }])
  core.append(view, { type: 'compaction/summary', text: 'summary', shadowedSeqs: [2] })
  visible = core.createLegacyReadVisibility(view)
  if (visible.kind !== 'visible') throw new Error('Expected visible')
  expect([...visible.local()]).toEqual([])
})
it('requires the exact existing group and complete surviving seed-item coverage', () => {
  const view = structuredClone(literalReady), extent = { kind: 'framed' as const, first: 1, last: 2 }, anchor = { kind: 'seed-group' as const, manifestSeq: 0 as const, ordinal: 0 }
  const visible = core.createLegacyReadVisibility(view)
  if (visible.kind !== 'visible') throw new Error('Expected visible')
  expect(visible.anchorVisible(anchor, extent)).toBe(true)
  expect(visible.anchorVisible({ ...anchor, ordinal: 1 }, extent)).toBe(false)
  expect(visible.anchorVisible(anchor, { ...extent, last: 3 })).toBe(false)
  expect(visible.anchorVisible({ kind: 'manifest', seq: 0 }, { kind: 'unframed' })).toBe(false)
  const items = core.projectConversation(view).items
  const coverage = items.map(item => ({ item: item.ref!, sources: item.sources.map(source => ({ seq: source.seq!, part: source.part })).sort((a, b) => a.seq - b.seq || a.part.localeCompare(b.part)) }))
  core.append(view, { type: 'compaction/replacement', version: 1, replacementId: 'consumed', text: 'summary', coverage, insertBefore: coverage[0]!.item })
  const consumed = core.createLegacyReadVisibility(view)
  if (consumed.kind !== 'visible') throw new Error('Expected visible')
  expect(consumed.anchorVisible(anchor, extent)).toBe(false)
  core.append(view, { type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: 3, mode: 'conversation', fileOps: [] })
  const rewoundSummary = core.createLegacyReadVisibility(view)
  if (rewoundSummary.kind !== 'visible') throw new Error('Expected visible')
  expect(rewoundSummary.anchorVisible(anchor, extent)).toBe(false)
})
it('refuses corrupt/future/unfinished semantic structures rather than manufacturing empty authority', () => {
  const duplicate = core.createSession(); core.append(duplicate, { type: 'context/result-ref', ref }); duplicate.events.push({ type: 'context/result-ref', ref, seq: 0 })
  expect(core.createLegacyReadVisibility(duplicate).kind).toBe('refused')
  expect(core.createLegacyReadVisibility({ ...literalReady, events: literalReady.events.slice(0, 1) }).kind).toBe('refused')
  expect(core.createLegacyReadVisibility({ ...literalReady, formatVersion: core.CURRENT_FORMAT_VERSION + 1 }).kind).toBe('refused')
})
