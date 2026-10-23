import { expect, it } from 'vitest'
import { append, createSession } from '@i-harness/core-session'
import { captureContextSnapshot, reductionGroups, reductionSourceCurrent } from '../src/index.ts'

function fixture() {
  const session = createSession()
  append(session, { type: 'user/message', text: 'selected historical source' })
  const capture = () => { const result = captureContextSnapshot(session, { ownerSessionId: 'owner', surface: { systemPrompt: '', tools: [] } }); if (result.kind !== 'captured') throw Error('capture required'); return result.snapshot }
  return { session, capture }
}
it.each(['new text', 'same text'])('invalidates a typed current floor with %s and a new source identity', text => {
  const { session, capture } = fixture()
  append(session, { type: 'runtime/context', version: 1, sections: [{ name: 'rules', text: 'same text' }] })
  const source = capture(), groups = reductionGroups(source)
  append(session, { type: 'runtime/context', version: 1, sections: [{ name: 'rules', text }] })
  expect(reductionSourceCurrent(source, groups, capture())).toBe(false)
})
it.each(['pending', 'promoted', 'consumed', 'effect', 'delegation'] as const)('invalidates authoritative %s evidence outside the selected group', kind => {
  const { session, capture } = fixture(), source = capture(), groups = reductionGroups(source)
  if (kind === 'effect') { append(session, { type: 'step/start' }); append(session, { type: 'tool/call', callId: 'new', name: 'read', args: {} }) }
  else if (kind === 'delegation') append(session, { type: 'subagent/start', version: 1, taskId: 'child', agentPath: '/child', role: 'research', description: 'pending' })
  else {
    append(session, { type: 'turn/start' })
    append(session, { type: 'agent/input/admitted', version: 1, inputId: 'new', text: 'steer', intent: 'user', delivery: 'steer' })
    if (kind !== 'pending') append(session, { type: 'agent/input/promoted', version: 1, inputId: 'new' })
    if (kind === 'consumed') append(session, { type: 'user/message', text: 'steer', input: { inputId: 'new', intent: 'user' } })
  }
  expect(reductionSourceCurrent(source, groups, capture())).toBe(false)
})
it.each(['legacy human', 'closed exchange', 'diagnostic'])('keeps the compatible %s retained suffix without an archive/semantic revision equality gate', kind => {
  const { session, capture } = fixture(), source = capture(), groups = reductionGroups(source)
  if (kind === 'legacy human') append(session, { type: 'user/message', text: 'compatible suffix' })
  else if (kind === 'diagnostic') append(session, { type: 'session/title', title: 'new title', messageSeqs: [], source: 'user' })
  else { append(session, { type: 'step/start' }); append(session, { type: 'assistant/message', text: 'accepted suffix' }); append(session, { type: 'step/end' }) }
  expect(reductionSourceCurrent(source, groups, capture())).toBe(true)
})
