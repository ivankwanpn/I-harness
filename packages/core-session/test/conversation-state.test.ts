import { expect, it } from "vitest"
import { append, createSession, projectConversation, readConversationState } from "../src/index.ts"

it.each(['failed', 'unaccepted', 'unknown', 'error'] as const)('protects input with %s physical work using the shared unit source', kind => {
  const session = createSession()
  if (kind === 'unaccepted') append(session, { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
  append(session, { type: 'turn/start' })
  const start = session.events.length
  append(session, { type: 'step/start', actionId: 'a', attemptId: 'p' })
  const input = session.events.length
  append(session, { type: 'user/message', text: 'H' })
  append(session, { type: 'tool/call', callId: 'c', name: 'read', args: {} })
  append(session, { type: 'assistant/message', text: 'E' })
  append(session, { type: 'tool/result', callId: 'c', name: 'read', isError: true, output: kind === 'unknown' ? { code: 'TOOL_OUTCOME_UNKNOWN', replay: false } : 'known error' })
  append(session, { type: kind === 'failed' ? 'step/failed' : 'step/end' })
  append(session, { type: 'turn/end' })
  const projection = projectConversation(session, { ownerSessionId: 'owner' })
  const expected = kind === 'error' ? 'closed' : 'unresolved'
  expect(projection.items[0]?.unit).toMatchObject({ state: expected, source: { id: JSON.stringify(['owner', start, 'step']) } })
  const result = readConversationState(session, projection)
  if (result.kind !== 'available') throw Error('state required')
  expect(result.state.itemIds.includes(JSON.stringify(['owner', input, 'message']) + ':input')).toBe(kind !== 'error')
  expect(result.state.sourceIds.includes(JSON.stringify(['owner', start, 'step']))).toBe(kind !== 'error')
})

it('protects a readable closed input whose physical start has no safe address', () => {
  const session = { formatVersion: 7, events: [
    { type: 'turn/start' as const, seq: 0 }, { type: 'step/start' as const }, { type: 'user/message' as const, seq: 2, text: 'H' },
    { type: 'step/end' as const, seq: 3 }, { type: 'turn/end' as const, seq: 4 },
  ] }
  const projection = projectConversation(session, { ownerSessionId: 'owner' })
  expect(projection.items[0]?.unit).toMatchObject({ state: 'closed', source: { addressable: false } })
  expect(readConversationState(session, projection)).toMatchObject({ kind: 'available', state: { itemIds: ['["owner",2,"message"]:input'], sourceIds: expect.arrayContaining(['["owner","event:1","step"]']) } })
})

it("uses branch lifecycle for both boundaries hidden by compaction", () => {
  const session = createSession()
  append(session, { type: "turn/start" }); append(session, { type: "user/message", text: "anchor" }); append(session, { type: "turn/end" })
  append(session, { type: "compaction/reset", removedSeqs: [0, 2] })
  const result = readConversationState(session, projectConversation(session, { ownerSessionId: "owner" }))
  expect(result).toMatchObject({ kind: "available", state: { itemIds: [], pendingInputIds: [], unsettledDelegationIds: [] } })
  if (result.kind !== "available") throw Error("state required")
  expect(result.state.turnSourceId).toBeUndefined()
})

it("keeps session instructions and unsettled delegation evidence without inventing an idle anchor", () => {
  const session = createSession()
  append(session, { type: "user/message", text: "idle human" })
  append(session, { type: "user/message", text: "instruction", provenance: { kind: "plugin", authority: "observation", scope: "session", producer: "fixture" } })
  append(session, { type: "subagent/start", version: 1, taskId: "child", agentPath: "/child", role: "research", description: "task" })
  const before = readConversationState(session, projectConversation(session, { ownerSessionId: "owner" }))
  expect(before).toMatchObject({ kind: "available", state: { itemIds: ['["owner",1,"message"]:input'], unsettledDelegationIds: ["child"] } })
  append(session, { type: "subagent/end", version: 1, taskId: "child", outcome: "completed" })
  expect(readConversationState(session, projectConversation(session, { ownerSessionId: "owner" }))).toMatchObject({ kind: "available", state: { unsettledDelegationIds: [] } })
})
