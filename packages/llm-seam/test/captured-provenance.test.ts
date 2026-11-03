import { expect, it } from "vitest"
import { append, createSession, projectConversation, renderConversation } from "@i-harness/core-session"
import { assertMessagesFromLog } from "../src/index.ts"

it("validates against the captured source projection after the live log advances", () => {
  const session = createSession(); append(session, { type: "user/message", text: "captured" })
  const projection = projectConversation(session), messages = renderConversation(projection)
  append(session, { type: "user/message", text: "new input" })
  expect(() => assertMessagesFromLog(messages, projection)).not.toThrow()
  expect(() => assertMessagesFromLog(messages, session)).toThrow(/derive from the session log/)
  messages[0]!.content = "injected"
  expect(() => assertMessagesFromLog(messages, projection)).toThrow(/derive from the session log/)
})
