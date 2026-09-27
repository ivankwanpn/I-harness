import { expect, it } from "vitest"
import { createSession } from "@i-harness/core-session"
import { transportSessionEvents } from "../src/image-transport.ts"

it("fails a cold log with a missing image admission instead of returning text only", () => {
  const session = createSession()
  session.events.push({ type: "user/message", text: "inspect", imageInputId: "missing", seq: 0 })
  expect(() => transportSessionEvents(session, session.events)).toThrow(/image admission not found/)
})

it("uses the latest earlier admission when an input id is reused", () => {
  const session = createSession()
  const first = { mediaType: "image/png" as const, dataBase64: "AQID" }
  const second = { mediaType: "image/png" as const, dataBase64: "BAUG" }
  session.events.push(
    { type: "agent/input/admitted", version: 1, inputId: "same", text: "one", delivery: "queue", intent: "user", images: [first], seq: 0 },
    { type: "user/message", text: "one", imageInputId: "same", seq: 1 },
    { type: "agent/input/admitted", version: 1, inputId: "same", text: "two", delivery: "queue", intent: "user", images: [second], seq: 2 },
    { type: "user/message", text: "two", imageInputId: "same", seq: 3 },
  )
  const wire = transportSessionEvents(session, session.events)
  expect(wire[1]).toMatchObject({ images: [first] })
  expect(wire[3]).toMatchObject({ images: [second] })
  expect(wire[0]).not.toHaveProperty("images")
  expect(wire[2]).not.toHaveProperty("images")
})
