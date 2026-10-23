import { captureContextSnapshot } from '../../context-engine/src/index.ts'
import { selectSeedHistory } from '../src/conversation/seed-selection.ts'
import { expect, it } from 'vitest'
import { append, createSession, projectConversation, readConversationState, toJSONL, fromJSONL } from '../src/index.ts'
import { groupConversationHistory } from '../src/conversation/history/group.ts'
import { historyFact } from '../src/conversation/history/facts.ts'
import type { SessionEvent } from '../src/index.ts'

function fixture(calls = 0) {
  const session = createSession()
  append(session, { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
  append(session, { type: 'turn/start' })
  append(session, { type: 'step/start', actionId: 'action', attemptId: 'attempt' })
  append(session, { type: 'assistant/message', text: 'failed audit' })
  for (let i = 0; i < calls; i++) {
    append(session, { type: 'tool/call', callId: 'call' + i, name: 'effect', args: {} })
    append(session, { type: 'tool/result', callId: 'call' + i, name: 'effect', isError: true, output: { code: 'TOOL_ABORTED_BEFORE_DISPATCH' } })
  }
  append(session, { type: 'step/failed' }); append(session, { type: 'step/end' }); append(session, { type: 'turn/end' })
  return session
}
function audit(session: ReturnType<typeof fixture>) { return projectConversation(session, { ownerSessionId: 'owner' }).items.find(i => i.kind === 'legacy-fragment')! }
it.each([0, 1, 3])('known failed audit with %s calls closes without acceptance, rendering or replay references', calls => {
  const session = fixture(calls)
  for (const source of [session, fromJSONL(toJSONL(session))]) {
    const item = audit(source)
    expect(item.unit?.state).toBe('closed')
    const selection = selectSeedHistory(source, { kind: 'all' })
    expect(selection).toMatchObject({ kind: 'selected', groups: [] })
    expect(item.messages).toEqual([]); expect(item.exchange).toBeUndefined(); expect(item.ref).toBeUndefined()
    expect(readConversationState(source, projectConversation(source))).toMatchObject({ kind: 'available', state: { itemIds: [] } })
    expect(source.events.some(e => e.type === 'assistant/message' && e.text === 'failed audit')).toBe(true)
  }
})

function structural(session: ReturnType<typeof fixture>) {
  const facts = session.events.map((e, i) => historyFact(e, i))
  return groupConversationHistory({ length: facts.length, get: i => facts[i]! }).items[0]!.unitInfo!.state
}
const mutations: Record<string, (events: SessionEvent[]) => void> = {
  'no semantics': e => { e.splice(0, 1) },
  'missing action': e => { Object.assign(e[2]!, { actionId: undefined }) },
  'overlong action': e => { Object.assign(e[2]!, { actionId: 'a'.repeat(257) }) },
  'empty attempt': e => { Object.assign(e[2]!, { attemptId: '' }) },
  'missing explicit end': e => { e.splice(7, 1) },
  'inferred end': e => { e[7] = { type: 'step/start', actionId: 'a2', attemptId: 'p2' } },
  'duplicate failure': e => { e.splice(7, 0, { type: 'step/failed' }) },
  'duplicate end': e => { e.splice(8, 0, { type: 'step/end' }) },
  'missing result': e => { e.splice(5, 1) },
  'late result': e => { const r = e.splice(5, 1)[0]!; e.splice(7, 0, r) },
  'wrong name': e => { Object.assign(e[5]!, { name: 'other' }) },
  'duplicate result': e => { e.splice(6, 0, { ...e[5]! }) },
  'duplicate call': e => { e.splice(5, 0, { ...e[4]! }) },
  'acceptance attached': e => { e.splice(6, 0, { type: 'model/exchange-accepted', version: 1, exchangeId: 'x', actionId: 'action', attemptId: 'attempt', stepStartSeq: 2, assistantSeq: 3, callSeqs: [4] }) },
  'generic error': e => { Object.assign(e[5]!, { output: 'error' }) },
  'success': e => { Object.assign(e[5]!, { isError: false }) },
  'unknown': e => { Object.assign(e[5]!, { output: { code: 'TOOL_OUTCOME_UNKNOWN', replay: false } }) },
  'actual dispatch': e => { e.splice(5, 0, { type: 'tool/dispatch', callId: 'call0', eventSeq: 4 }) },
  'conflicting dispatch': e => { e.splice(5, 0, { type: 'tool/dispatch', callId: 'call0', eventSeq: 99 }) },
}
it.each(Object.keys(mutations))('keeps %s unresolved', kind => {
  const session = fixture(1)
  mutations[kind]!(session.events)
  session.events.forEach((e, i) => { Object.assign(e, { seq: i }) })
  expect(structural(session)).toBe('unresolved')
})
it.each(['start', 'failure', 'end', 'result', 'content'] as const)('retains unsafe %s source protection', kind => {
  const session = fixture(1), index = { start: 2, failure: 6, end: 7, result: 5, content: 3 }[kind]
  Object.assign(session.events[index]!, { seq: session.events[1]!.seq })
  expect(structural(session)).toBe('unresolved')
})
it.each([3, 5, 6, 7])('does not use hidden source %s to prove known failure', seq => {
  const session = fixture(1)
  append(session, { type: 'compaction/reset', removedSeqs: [seq] })
  expect(structural(session)).toBe('unresolved')
})
it('cannot hide a dispatch to claim non-dispatch', () => {
  const session = fixture(1)
  session.events.splice(5, 0, { type: 'tool/dispatch', callId: 'call0', eventSeq: 4 })
  session.events.forEach((e, i) => { Object.assign(e, { seq: i }) })
  session.events.push({ type: 'compaction/reset', seq: session.events.length, removedSeqs: [5] })
  expect(structural(session)).toBe('unresolved')
})
it('keeps independently unsettled child protection on a known aborted unit', () => {
  const session = fixture()
  session.events.splice(4, 0, { type: 'subagent/start', version: 1, taskId: 'child', agentPath: '/child', role: 'research', description: 'pending' })
  session.events.forEach((e, i) => { Object.assign(e, { seq: i }) })
  const projection = projectConversation(session)
  expect(audit(session).unit?.state).toBe('closed')
  expect(readConversationState(session, projection)).toMatchObject({ kind: 'available', state: { itemIds: [projection.items[0]!.id], unsettledDelegationIds: ['child'] } })
})

it.each(['missing', 'negative', 'fractional', 'backward'] as const)('cannot close an audit with %s terminal sequence evidence', kind => {
  const session = fixture(1)
  Object.assign(session.events[7]!, { seq: kind === 'missing' ? undefined : kind === 'negative' ? -1 : kind === 'fractional' ? 7.5 : 0 })
  expect(structural(session)).toBe('unresolved')
})
it('known reasoning-only failure is terminal and leaves current instructions independently protected', () => {
  const session = createSession()
  append(session, { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
  append(session, { type: 'runtime/context', version: 1, sections: [{ name: 'instructions', text: 'current rules' }] })
  append(session, { type: 'turn/start' })
  append(session, { type: 'step/start', actionId: 'a', attemptId: 'p' })
  append(session, { type: 'user/message', text: 'observation' })
  append(session, { type: 'reasoning', text: 'failed reasoning' })
  append(session, { type: 'step/failed' }); append(session, { type: 'step/end' }); append(session, { type: 'turn/end' })
  const projection = projectConversation(fromJSONL(toJSONL(session)))
  expect(projection.items[0]!.unit!.state).toBe('closed')
  expect(JSON.stringify(projection.items)).not.toContain('failed reasoning')
  const snapshot = captureContextSnapshot(session, { ownerSessionId: 'owner', surface: { systemPrompt: '', tools: [] } })
  if (snapshot.kind !== 'captured') throw Error('captured snapshot required')
  expect(snapshot.snapshot.protection.itemIds).toEqual([])
  expect(snapshot.snapshot.protection.sourceIds).toEqual([snapshot.snapshot.conversation.current!.source.id])
})
