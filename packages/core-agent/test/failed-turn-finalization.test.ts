import { expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, deriveMessages } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import type { ModelClient } from "@i-harness/llm-seam"
import { createAgent } from "../src/index.ts"

it.each(["pre-step", "request-context"] as const)("closes a %s refusal without contacting the model and permits a later turn", async boundary => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const refusal = new Error("Execution authority revoked: owned project removed")
  let denied = true, modelCalls = 0
  const model: ModelClient = { async *stream() { modelCalls++; yield { type: "text/chunk", text: "Actual later answer" }; yield { type: "end" } } }
  if (boundary === "pre-step") ctx.on("agent/pre-step", () => { if (denied) throw refusal })
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: () => {
    if (boundary === "request-context" && denied) throw refusal
    return "Owned test context"
  } })
  await expect(agent.run("Owned refused input")).rejects.toBe(refusal)
  expect(modelCalls).toBe(0)
  expect(session.events.map(event => event.type)).toEqual(["turn/start", "user/message", "step/start", "step/failed", "step/end", "turn/end"])
  expect(session.events.some(event => event.type === "assistant/message")).toBe(false)
  denied = false
  expect((await agent.run("Owned later input")).finalText).toBe("Actual later answer")
  expect(modelCalls).toBe(1)
  expect(session.events.filter(event => event.type === "turn/end")).toHaveLength(2)
})

it("awaits the failed turn's persistence barrier before returning its original refusal", async () => {
  const ctx = createContext(), session = createSession(), refusal = new Error("owned refusal")
  ctx.on("agent/pre-step", () => { throw refusal })
  const release = Promise.withResolvers<void>()
  let saving = false, settled = false
  const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), model: { async *stream() { throw new Error("must not contact model") } }, systemPrompt: "",
    flush: async () => { saving = true; await release.promise },
  })
  const failed = agent.run("Owned refused input").then(() => { settled = true }, error => { settled = true; return error })
  try {
    await vi.waitFor(() => expect(saving).toBe(true))
    expect(settled).toBe(false)
    expect(session.events.at(-1)?.type).toBe("turn/end")
  } finally { release.resolve() }
  expect(await failed).toBe(refusal)
})

it.each(["agent aborted", "Execution authority revoked: owned project removed"])("names %s and failed saving while retaining both errors", async reason => {
  const ctx = createContext(), session = createSession(), refusal = new Error(reason), disk = new Error("owned disk failure")
  ctx.on("agent/pre-step", () => { throw refusal })
  const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), model: { async *stream() { throw new Error("must not contact model") } }, systemPrompt: "", flush: async () => { throw disk } })
  const failure = await agent.run("Owned refused input").catch(error => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toEqual([refusal, disk])
  expect(failure.cause).toBe(refusal)
  expect(failure.message).toContain(reason)
  expect(failure.message).toContain("owned disk failure")
  expect(session.events.some(event => event.type === "assistant/message")).toBe(false)
})

it("closes a tool commit failure while preserving the provider call and actual result", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const failure = new Error("owned post-tool observer failure")
  tools.register({ name: "owned_probe", description: "Owned in-memory probe", inputSchema: { type: "object", properties: {} }, execute: async () => ({ actual: "owned result" }) })
  ctx.on("agent/post-tool", () => { throw failure })
  const model: ModelClient = { async *stream() { yield { type: "tool_call", call: { name: "owned_probe", args: {} } }; yield { type: "end" } } }
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: "" })
  await expect(agent.run("Owned tool input")).rejects.toBe(failure)
  expect(session.events.slice(-2).map(event => event.type)).toEqual(["step/end", "turn/end"])
  expect(session.events.some(event => event.type === "step/failed")).toBe(false)
  const messages = deriveMessages(session)
  expect(messages.some(message => message.role === "assistant" && message.toolCalls?.some(call => call.name === "owned_probe"))).toBe(true)
  expect(session.events.some(event => event.type === "tool/result" && JSON.stringify(event.output).includes("owned result"))).toBe(true)
})
