import { expect, it } from 'vitest'
import { append, createSession } from '@i-harness/core-session'
import { captureContextSnapshot } from '@i-harness/context-engine'
import { automaticReductionPolicy, softAdvances, softWorkFacts } from '../src/agent/context-reduction/automatic.ts'
it('empty failed-attempt and metadata bookkeeping do not create eligible soft work', () => {
  const session=createSession();append(session,{type:'turn/start'});append(session,{type:'user/message',text:'protected input'})
  const snapshot=()=>{const value=captureContextSnapshot(session,{ownerSessionId:'owner',surface:{systemPrompt:'',tools:[]}});if(value.kind!=='captured')throw Error('capture required');return value.snapshot}
  const before=softWorkFacts(snapshot(),{})
  append(session,{type:'step/start'});append(session,{type:'step/failed'});append(session,{type:'step/end'})
  append(session,{type:'session/title',title:'metadata',messageSeqs:[],source:'fallback'})
  expect(softWorkFacts(snapshot(),{})).toEqual(before)
  expect(softAdvances(session.events)).toEqual({acceptedExchanges:0,humanTurns:0})
})
it.each([false, true])('counts three accepted closed tool exchanges within one human turn (last unknown=%s)', unknown => {
  const session = createSession()
  append(session, { type: 'turn/start' }); append(session, { type: 'user/message', text: 'protected human input' })
  append(session, { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
  append(session, { type: 'compaction/prune', version: 1, pruned: [] })
  for (let index = 0; index < 3; index++) {
    const start = session.events.length, callId = `call-${index}`, actionId = `action-${index}`, attemptId = `attempt-${index}`
    append(session, { type: 'step/start', actionId, attemptId })
    append(session, { type: 'tool/call', callId, name: 'read', args: {} })
    append(session, { type: 'assistant/message', text: 'accepted tool request' })
    append(session, { type: 'model/exchange-accepted', version: 1, exchangeId: `exchange-${index}`, actionId, attemptId, stepStartSeq: start, assistantSeq: start + 2, callSeqs: [start + 1] })
    append(session, { type: 'tool/dispatch', callId, eventSeq: start + 1 })
    append(session, { type: 'tool/result', callId, name: 'read', ...(unknown && index === 2 ? { isError: true as const, output: { code: 'TOOL_OUTCOME_UNKNOWN', replay: false } } : { output: 'closed outcome' }) })
    append(session, { type: 'step/end' })
  }
  append(session, { type: 'session/title', title: 'bookkeeping', messageSeqs: [], source: 'fallback' })
  expect(softAdvances(session.events)).toEqual({ acceptedExchanges: unknown ? 2 : 3, humanTurns: 0 })
  const captured = captureContextSnapshot(session, { ownerSessionId: 'owner', surface: { systemPrompt: '', tools: [] } })
  if (captured.kind !== 'captured') { expect(unknown).toBe(true); return }
  expect(automaticReductionPolicy(session, { mode: 'accepted-exchanges', minimum: 3 }).allowed(captured.snapshot, {})).toBe(!unknown)
  expect(automaticReductionPolicy(session, { mode: 'human-turns', minimum: 3 }).allowed(captured.snapshot, {})).toBe(false)
})
