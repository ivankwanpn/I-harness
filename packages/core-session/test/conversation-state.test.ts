import { expect, it } from "vitest"
import { append, createSession, projectConversation, readConversationState } from "../src/index.ts"

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
