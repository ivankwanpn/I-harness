import { expect, it } from 'vitest'
import { managedResultRefs, rewindCuts, sameManagedArtifactRef, type ManagedArtifactRef, type SessionEvent, type SessionView } from '@i-harness/core-session'
import { createProcessReadVisibility } from '../src/coordinator/process-read-visibility.ts'

const ref = (id: string): ManagedArtifactRef => ({ version: 1, id: `ctxv1_${id.repeat(64)}`, revision: 'b'.repeat(64), codec: 'json-utf8-v1', encodedBytes: 10, contentDigest: 'c'.repeat(64), completeness: 'complete' })
const result = (seq: number | undefined, value: ManagedArtifactRef): SessionEvent => ({ type: 'code/output', cellId: 'c', ...(seq === undefined ? {} : { seq }), envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: value } } })
const point = (seq: number, anchorSeq: number): SessionEvent => ({ type: 'rewind/point', version: 1, seq, anchorSeq, targetTurn: 0, mode: 'conversation', fileOps: [] })

it('matches the original rewind oracle after each suffix including nonmonotonic meld and duplicate refs', () => {
  const a = ref('a'), b = ref('d'), c = ref('e')
  const events: SessionEvent[] = [result(75, a), result(undefined, a), result(150, b), point(200, 100), point(50, 0), result(25, c), result(250, b), point(300, 240)]
  const index = createProcessReadVisibility(), seen: SessionEvent[] = []
  for (const event of events) {
    seen.push(event); index.add([event])
    const view = { formatVersion: 13, events: seen } as SessionView, cuts = rewindCuts(view)
    for (const candidate of [a, b, c, { ...a, encodedBytes: 11 }, { ...a, completeness: 'source-limited' as const }]) {
      const expected = seen.some(row => !cuts.some(cut => row.seq !== undefined && row.seq >= cut.cutFrom && row.seq < cut.markerSeq) && managedResultRefs(row).some(found => sameManagedArtifactRef(found, candidate)))
      expect(index.contains(candidate)).toBe(expected)
    }
  }
})

it('distinguishes every ref field and removes only covered duplicate postings', () => {
  const original = ref('a'), index = createProcessReadVisibility()
  index.add([result(2, original), result(20, original)])
  index.add([point(10, 1)])
  expect(index.contains(original)).toBe(true)
  const alternatives = [
    { ...original, version: 2 }, { ...original, id: `ctxv1_${'d'.repeat(64)}` },
    { ...original, revision: 'd'.repeat(64) }, { ...original, codec: 'text-utf8-v1' },
    { ...original, encodedBytes: 11 }, { ...original, contentDigest: 'd'.repeat(64) },
    { ...original, completeness: 'source-limited' },
  ] as ManagedArtifactRef[]
  for (const other of alternatives) expect(index.contains(other)).toBe(false)
  index.add([point(30, 19)])
  expect(index.contains(original)).toBe(false)
})
