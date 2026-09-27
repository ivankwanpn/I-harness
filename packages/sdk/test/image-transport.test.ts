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

it("reuses an indexed long prefix across image-bearing history pages", () => {
  const session = createSession()
  const image = { mediaType: "image/png" as const, dataBase64: "AQID" }
  session.events.push({ type: "agent/input/admitted", version: 1, inputId: "photo", text: "look", delivery: "queue", intent: "user", images: [image], seq: 0 })
  for (let seq = 1; seq < 10_000; seq++) session.events.push({ type: "assistant/chunk", text: "x", seq })
  const user = { type: "user/message" as const, text: "look", imageInputId: "photo", seq: 10_000 }
  session.events.push(user)
  let reads = 0
  session.events = new Proxy(session.events, { get(target, property, receiver) {
    if (typeof property === "string" && /^\d+$/.test(property)) reads++
    return Reflect.get(target, property, receiver)
  } })
  expect(transportSessionEvents(session, [user])[0]).toMatchObject({ images: [image] })
  reads = 0
  expect(transportSessionEvents(session, [user])[0]).toMatchObject({ images: [image] })
  expect(reads).toBeLessThan(50)
})
