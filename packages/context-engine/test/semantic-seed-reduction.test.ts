import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { append, projectConversation, projectConversationCandidate, renderConversation } from '@i-harness/core-session'
import { priceProjectedText, projectionFingerprint } from '@i-harness/token-meter'
import { literalReady, literalSeed } from '../../core-session/test/fixtures/format11-seed.ts'
import { captureContextSnapshot, reductionGroups, reduceContext, type ContextReductionPorts } from '../src/index.ts'
import { pruneProposal } from '../src/reduction/prune.ts'
import { reductionProgress } from '../src/reduction/proposal.ts'

it('closes the entire local seed group and refuses v1 pruning of inherited calls', () => {
  const session = structuredClone(literalReady)
  const seed = structuredClone(literalSeed)
  seed.groups[0]!.items[1]!.messages[1]!.content = 'seed exact'.repeat(1000)
  const canonical = (value: unknown): string => value && typeof value === 'object' ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value)
  const hash = (domain: string, value: unknown) => createHash('sha256').update(domain + '\0' + canonical(value)).digest('hex')
  seed.origins = [{ kind: 'session', sessionId: 'parent', revision: hash('ih.semantic-seed.source.v1', { version: 1, source: { kind: 'session', sessionId: 'parent' }, inheritedOrigins: [], selection: seed.selection, turns: seed.turns, omissions: [], artifacts: [], groups: seed.groups }) }]
  const manifest = session.events[0]!, record = session.events[1]!
  if (manifest.type !== 'conversation/seed-manifest' || record.type !== 'conversation/seed-group') throw Error('literal records required')
  manifest.origins = seed.origins; record.group = seed.groups[0]!; manifest.digest = hash('ih.semantic-seed.v1', seed); session.header!.semanticSeed!.seedDigest = manifest.digest
  const captured = captureContextSnapshot(session, { ownerSessionId: 'child', surface: { systemPrompt: '', tools: [] } })
  if (captured.kind !== 'captured') throw Error('snapshot required')
  const groups = reductionGroups(captured.snapshot)
  expect(groups).toHaveLength(1)
  expect(groups[0]!.coverage).toHaveLength(2)
  expect(pruneProposal(captured.snapshot, { id: 'seed', groups }, { prune: { enabled: true, thresholdChars: 1, headChars: 1, tailChars: 1 } })).toEqual([])
  append(session, { type: 'compaction/prune', version: 1, pruned: [{ callId: 'same', head: '', tail: '', removedBytes: 100 }] })
  expect(renderConversation(projectConversation(session)).map(message => message.content)).toEqual(['inherited preface', '', 'seed exact'.repeat(1000)])
})

it('does not call an unchanged request reduction progress', () => {
  const before = { kind: 'assessed' as const, inputFingerprint: 'actual-full-request', inputTokens: 10, inputBytes: 80, capacityFit: 'yes' as const,
    target: 'over-target' as const, shape: 'same', currentView: 'view', fixedInput: false, proof: {} }
  expect(reductionProgress(before, { ...before }, false)).toBe(false)
})

it('measures the full unchanged request and uses whole-group summary fallback with a local callId collision', async () => {
  const session = structuredClone(literalReady)
  const measure = (projection: ReturnType<typeof projectConversation>) => {
    const request = { systemPrompt: 'current fixed instructions', tools: [{ name: 'read', parameters: {} }], messages: renderConversation(projection) }
    return { kind: 'assessed' as const, capacityFit: 'yes' as const, target: 'over-target' as const,
      inputTokens: priceProjectedText(JSON.stringify(request)), inputBytes: Buffer.byteLength(JSON.stringify(request)), inputByteKind: 'neutral-envelope-estimate' as const,
      inputFingerprint: projectionFingerprint(request), shape: 'same', currentView: 'current', fixedInput: false, proof: {} }
  }
  const before = measure(projectConversation(session))
  append(session, { type: 'compaction/prune', version: 1, pruned: [{ callId: 'same', head: 'ignored', tail: '', removedBytes: 9000 }] })
  const after = measure(projectConversation(session))
  expect(after.inputFingerprint).toBe(before.inputFingerprint); expect(after.inputTokens).toBe(before.inputTokens)
  expect(reductionProgress(before, after, false)).toBe(false)
  append(session, { type: 'step/start' }); append(session, { type: 'tool/call', callId: 'same', name: 'read', args: {} }); append(session, { type: 'assistant/message', text: '' })
  append(session, { type: 'tool/result', callId: 'same', name: 'read', output: 'local tail' }); append(session, { type: 'step/end' })
  const published: string[] = []
  let summaries = 0
  const ports: ContextReductionPorts = {
    capture() { const captured = captureContextSnapshot(session, { ownerSessionId: 'child', surface: { systemPrompt: 'current fixed instructions', tools: [] } }); if (captured.kind !== 'captured') throw Error('snapshot required'); return captured.snapshot },
    current: () => true,
    async prepare(_source, _groups, rewrites) { const measured = measure(rewrites.length ? projectConversationCandidate(session, rewrites, { candidateId: 'summary' }).projection : projectConversation(session)); return { ...measured, target: rewrites.length ? 'ready' : 'over-target' } },
    async summary(source) { summaries++; expect(source.coverage).toHaveLength(2); return { kind: 'complete', text: 'S', groupIds: source.groups.map(group => group.id) } },
    async publish(_source, _groups, rewrites) { for (const rewrite of rewrites) { published.push(rewrite.type); append(session, rewrite) } return { kind: 'nondurable' } },
  }
  expect(await reduceContext(ports, { retainTokens: 0, prune: { enabled: true, thresholdChars: 1, headChars: 1, tailChars: 1 } })).toMatchObject({ compacted: true, publication: 'nondurable', summary: 'S' })
  expect(summaries).toBe(1); expect(published).toEqual(['compaction/replacement'])
  expect(renderConversation(projectConversation(session)).map(message => message.content)).toEqual(['S', '', 'ignored\n…(pruned 9000 bytes)…\n'])
})
