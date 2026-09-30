import { expect, it } from "vitest"
import { createSession } from "@i-harness/core-session"
import { createSessionService } from "../src/service.ts"
import { createSessionExecutor } from "@i-harness/core-agent"
import { Inbox } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"

it("executes one pre-admitted input without duplicate admission or consuming another queued input", async () => {
  const session = createSession()
  const model: ModelClient = { async *stream() { yield { type: "text/chunk", text: "ok" }; yield { type: "end" } } }
  const service = createSessionService({ workspace: process.cwd(), session, model })
  try {
    const assembly = await service.assemblyFor("s")
    assembly.inbox.admit({ inputId: "one", text: "first", delivery: "queue", intent: "user" })
    assembly.inbox.admit({ inputId: "two", text: "second", delivery: "queue", intent: "user" })
    expect(service.queue("s")).toHaveLength(2) // reading the projection must not reserve execution authority
    await service.submit("s", "first", new AbortController().signal, { admittedInputId: "one" })
    expect(assembly.inbox.pending().map((input) => input.inputId)).toEqual(["two"])
    expect(session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(2)
    expect(session.events.filter((event) => event.type === "user/message" && event.text === "first")).toHaveLength(1)
    await expect(service.submit("s", "wrong", new AbortController().signal, { admittedInputId: "two" })).rejects.toThrow("does not match")
  } finally { await service.close() }
})

it("keeps a durable input pending when cancellation wins before the lane microtask", async () => {
  const session = createSession()
  const inbox = new Inbox(session)
  inbox.admit({ inputId: "pending", text: "preserve", delivery: "queue", intent: "user" })
  let calls = 0
  const lane = createSessionExecutor({ session, inbox, agent: { async run() { calls++; return {} as never } } })
  const controller = new AbortController()
  const execution = lane.runAdmitted("pending", controller.signal)
  controller.abort()
  await execution
  expect(calls).toBe(0)
  expect(inbox.pending().map((input) => input.inputId)).toEqual(["pending"])
})
