import { expect, it } from 'vitest'
import { append, createSession, projectConversationCandidate, renderConversation } from '@i-harness/core-session'
import * as engine from '../src/index.ts'
import type { ContextReductionPorts, ReductionAssessment } from '../src/index.ts'

function fixture() {
  const session = createSession()
  append(session, { type: 'turn/start' }); append(session, { type: 'user/message', text: 'H' })
  const exchange = (text: string) => { append(session, { type: 'step/start' }); append(session, { type: 'assistant/message', text }); append(session, { type: 'step/end' }) }
  exchange('E1'); exchange('E2')
  append(session, { type: 'user/message', text: 'steer' })
  exchange('E3'); exchange('E4'); exchange('tail')
  const capture = () => {
    const result = engine.captureContextSnapshot(session, { ownerSessionId: 'owner', surface: { systemPrompt: 'whole system', tools: [] } })
    if (result.kind !== 'captured') throw Error('capture required')
    return result.snapshot
  }
  return { session, capture, exchange }
}
it('selects literal E1/E2 only, keeps the whole surface and leaves a later eligible span', () => {
  const { session, capture } = fixture()
  const runs = engine.selectReductionRuns(capture(), { retainTokens: 0 })
  expect(runs.map(run => run.groups.flatMap(group => group.items.flatMap(item => item.messages.map(message => message.content))))).toEqual([['E1', 'E2'], ['E3', 'E4']])
  const draft = engine.replacementProposal(runs[0]!, 'S', 'literal')
  const candidate = projectConversationCandidate(session, [draft], { candidateId: 'literal', ownerSessionId: 'owner' })
  expect(renderConversation(candidate.projection).map(message => message.content)).toEqual(['H', 'S', 'steer', 'E3', 'E4', 'tail'])
})
it('protects only active inputs and newest complete exchange in a fifty-step active turn', () => {
  const { capture, exchange } = fixture()
  for (let i = 0; i < 45; i++) exchange(`older-${i}`)
  const runs = engine.selectReductionRuns(capture(), { retainTokens: 0 })
  const text = runs.flatMap(run => run.groups.flatMap(group => group.items.flatMap(item => item.messages.map(message => message.content))))
  expect(text).toHaveLength(49)
  expect(text).not.toContain('H'); expect(text).not.toContain('steer'); expect(text).not.toContain('older-44')
})
function assessment(input: number, target: ReductionAssessment['target'] = 'over-target'): ReductionAssessment {
  return { kind: 'assessed', capacityFit: 'yes', target, inputTokens: input, inputBytes: input, inputFingerprint: String(input), shape: 'same', currentView: 'view', fixedInput: false, proof: {} }
}
it('skips an unhelpful oldest span and commits only the useful later proposal', async () => {
  const { session, capture } = fixture(), observed: unknown[] = [], published: unknown[] = []
  const attempts = { count: 0, staleRebuilds: 0 }
  const ports: ContextReductionPorts = { capture, current: () => true,
    prepare: async (_source, _groups, rewrites) => rewrites.length ? assessment(rewrites[0]?.type === 'compaction/replacement' && rewrites[0].text === 'useful' ? 50 : 100, rewrites[0]?.type === 'compaction/replacement' && rewrites[0].text === 'useful' ? 'ready' : 'over-target') : assessment(100),
    summary: async source => { observed.push(source.groups.flatMap(group => group.items.flatMap(item => item.messages.map(message => message.content)))); source.attempts.count++; return { kind: 'complete', text: observed.length === 1 ? 'unhelpful' : 'useful', groupIds: source.groups.map(group => group.id) } },
    publish: async (_source, _groups, rewrites) => { published.push(rewrites); for (const rewrite of rewrites) append(session, rewrite); return { kind: 'nondurable' } },
  }
  expect(await engine.reduceContext(ports, { retainTokens: 0 }, { attempts })).toMatchObject({ compacted: true, outcome: 'ready', publication: 'nondurable', summary: 'useful' })
  expect(observed).toEqual([['E1', 'E2'], ['E3', 'E4']]); expect(published).toHaveLength(1); expect(attempts.count).toBe(2)
})
it('returns committed over-target progress without a second checkpoint and never certifies unknown publication', async () => {
  for (const publication of ['nondurable', 'recovery-required'] as const) {
    const { capture } = fixture(); let summaries = 0
    const ports: ContextReductionPorts = { capture, current: () => true,
      prepare: async (_s, _g, rewrites) => assessment(rewrites.length ? 50 : 100),
      summary: async source => ++summaries === 1 ? { kind: 'complete', text: 'S', groupIds: source.groups.map(group => group.id) } : { kind: 'blocked', reason: 'call-limit' },
      publish: async () => ({ kind: publication }),
    }
    expect(await engine.reduceContext(ports, {})).toMatchObject(publication === 'nondurable'
      ? { compacted: true, outcome: 'reduced-over-target', publication: 'nondurable' }
      : { compacted: false, outcome: 'blocked', publication: 'recovery-required', blockedReason: 'publication-recovery-required' })
    expect(summaries).toBe(1)
  }
})
