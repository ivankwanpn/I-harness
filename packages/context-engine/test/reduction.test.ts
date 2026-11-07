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
it.each(['auto', 'manual', 'recovery'] as const)('escapes a retained complete tail only after hard capacity failure (%s)', async reason => {
  const { capture } = fixture(), observed: unknown[] = []
  const ports: ContextReductionPorts = { capture, current: () => true,
    prepare: async (_s, groups, rewrites) => ({ ...assessment(rewrites.length && groups.some(g => g.items.some(i => i.messages.some(m => m.content === 'tail'))) ? 50 : 100), capacityFit: 'no' }),
    summary: async source => { observed.push(source.groups.flatMap(g => g.items.flatMap(i => i.messages.map(m => m.content)))); source.attempts.count++; return { kind: 'complete', text: 'S', groupIds: source.groups.map(g => g.id) } },
    publish: async () => ({ kind: 'nondurable' }),
  }
  expect(await engine.reduceContext(ports, {}, { reason })).toMatchObject({ compacted: true })
  expect(observed).toEqual([['E1', 'E2'], ['E3', 'E4'], ['tail']])
})
it.each(['yes', 'no'] as const)('a no-op summary cannot publish or repeatedly select a span (capacity=%s)', async capacityFit => {
  const { capture } = fixture(), seen: unknown[] = []; let published = 0
  const attempts = { count: 0, staleRebuilds: 0 }
  const ports: ContextReductionPorts = { capture, current: () => true,
    prepare: async () => ({ ...assessment(100), capacityFit }),
    summary: async source => { seen.push(source.groups.map(group => group.id)); source.attempts.count++; return { kind: 'complete', text: 'unchanged', groupIds: source.groups.map(group => group.id) } },
    publish: async () => { published++; return { kind: 'nondurable' } },
  }
  expect(await engine.reduceContext(ports, {}, { attempts })).toMatchObject({ compacted: false, blockedReason: 'no-progress' })
  expect(published).toBe(0); expect(seen.length).toBe(capacityFit === 'no' ? 3 : 2); expect(attempts.count).toBe(seen.length)
})
it('hard pressure still excludes protected, open and unknown-outcome groups', async () => {
  const { session, capture } = fixture()
  append(session, { type: 'step/start' }); append(session, { type: 'tool/call', callId: 'pending', name: 'read', args: {} })
  const snapshot = capture(), selected = engine.selectReductionRuns(snapshot, {}, undefined, true)
  expect(selected.flatMap(run => run.groups).every(group => group.complete && !group.protected)).toBe(true)
  expect(selected.flatMap(run => run.groups.flatMap(group => group.items.flatMap(item => item.messages.map(message => message.content))))).toEqual(['tail'])
  const tailSeq = session.events.find(event => event.type === 'assistant/message' && event.text === 'tail')!.seq
  expect(engine.selectReductionRuns(snapshot, {}, [tailSeq!], true).flatMap(run => run.groups.flatMap(group => group.items.flatMap(item => item.messages.map(message => message.content))))).not.toContain('tail')
})
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

it('publishes an over-target candidate whose replacement forces a fixed input', async () => {
  const { capture } = fixture(); let published = 0
  const attempts = { count: 0, staleRebuilds: 0 }
  const ports: ContextReductionPorts = { capture, current: () => true,
    prepare: async (_source, _groups, rewrites) => ({ ...assessment(rewrites.length ? 50 : 100), ...(rewrites.length ? { fixedInput: true } : {}) }),
    summary: async source => { source.attempts.count++; return { kind: 'complete', text: 'S', groupIds: source.groups.map(group => group.id) } },
    publish: async () => { published++; return { kind: 'nondurable' } },
  }
  expect(await engine.reduceContext(ports, { retainTokens: 0 }, { attempts, reason: 'manual' })).toMatchObject({ compacted: true, outcome: 'reduced-over-target', publication: 'nondurable' })
  expect(published).toBe(1)
})

it('summarizes a reducible conversation even when the fixed surface exceeds the target', async () => {
  const { capture } = fixture(); let published = 0
  const attempts = { count: 0, staleRebuilds: 0 }
  const ports: ContextReductionPorts = { capture, current: () => true,
    prepare: async (_source, _groups, rewrites) => ({ ...assessment(rewrites.length ? 4000 : 5000), fixedInput: true, fixedTokens: 3000 }),
    summary: async source => { source.attempts.count++; return { kind: 'complete', text: 'S', groupIds: source.groups.map(group => group.id) } },
    publish: async () => { published++; return { kind: 'nondurable' } },
  }
  expect(await engine.reduceContext(ports, { retainTokens: 0 }, { attempts, reason: 'auto' })).toMatchObject({ compacted: true, outcome: 'reduced-over-target', publication: 'nondurable' })
  expect(published).toBe(1)
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