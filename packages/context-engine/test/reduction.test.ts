import { expect, it } from 'vitest'
import { append, createSession, projectConversationCandidate, renderConversation } from '@i-harness/core-session'
import * as engine from '../src/index.ts'

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
it.each([[6399, 'ready'], [6400, 'over-target'], [7399, 'over-target']] as const)('uses strict final-request boundary at I=%i', (input, expected) => {
  expect(engine.reductionTarget({ capacityFit: 'yes', inputTokens: input, outputReserve: 600, contextWindow: 10000 }, {})).toBe(expected)
})
