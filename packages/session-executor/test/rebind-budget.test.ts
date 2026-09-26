import { it, expect, vi } from "vitest"
import { append } from "@i-harness/core-session"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { createSessionService } from "../src/service.ts"

it("switches the live output cap, compaction window and context tool together", async () => {
  const requests: LLMRequest[] = []
  const first: ModelClient = { async *stream() { yield { type: "text/chunk", text: "A" }; yield { type: "end" } } }
  const second: ModelClient = { async *stream(request) {
    requests.push(request)
    if (requests.length === 2) yield { type: "tool_call", call: { name: "get_context_remaining", args: {} } }
    else yield { type: "text/chunk", text: "Keep the existing task and its decisions. ".repeat(20) }
    yield { type: "end" }
  } }
  const service = createSessionService({ workspace: process.cwd(), compact: { auto: true },
    modelBindingFor: async () => ({ status: "ready", binding: {
      providerId: "test", modelId: "a", label: "a", model: first, contextWindow: 1000000, maxOutputTokens: 2000,
    } }),
  })
  try {
    await service.submit("s", "first", new AbortController().signal)
    const assembly = await service.assemblyFor("s")
    append(assembly.session, { type: "user/message", text: "x".repeat(170000) })
    service.rebindModel("s", { providerId: "test", modelId: "b", label: "b", model: second, contextWindow: 50000, maxOutputTokens: 777 })
    expect(await service.assemblyFor("s")).toBe(assembly)
    await service.submit("s", "continue", new AbortController().signal)
    expect(assembly.session.events.some(e => e.type === "compaction/summary")).toBe(true)
    expect(requests.every(r => r.maxOutputTokens !== undefined && r.maxOutputTokens <= 777)).toBe(true)
    expect(assembly.session.events.filter(e => e.type === "tool/result")).toContainEqual(expect.objectContaining({ output: expect.objectContaining({ window: 50000 }) }))
  } finally { await service.close() }
})

it("rejects a rebind while a turn is running without changing the reported model", async () => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  let started = false
  const model: ModelClient = { async *stream() {
    started = true
    await gate
    yield { type: "text/chunk", text: "A" }
    yield { type: "end" }
  } }
  const service = createSessionService({ workspace: process.cwd(), modelBindingFor: async () => ({
    status: "ready", binding: { model, providerId: "test", modelId: "a", label: "a", contextWindow: 100000 },
  }) })
  const run = service.submit("s", "run", new AbortController().signal)
  try {
    await vi.waitFor(() => expect(started).toBe(true))
    expect(() => service.rebindModel("s", { model, providerId: "test", modelId: "b", label: "b", contextWindow: 50000 })).toThrow(/busy/)
    expect(await service.modelState("s")).toMatchObject({ modelId: "a" })
  } finally { release(); await run; await service.close() }
})

it("rejects rebinding while a manually invoked compaction is awaiting a model", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started = false
  const model: ModelClient = { async *stream() {
    started = true
    await gate
    yield { type: "text/chunk", text: "Keep the requested task and decisions. ".repeat(20) }
    yield { type: "end" }
  } }
  const service = createSessionService({ workspace: process.cwd(), compact: { auto: true },
    modelBindingFor: async () => ({ status: "ready", binding: { model, providerId: "test", modelId: "a", label: "a", contextWindow: 100000 } }),
  })
  const assembly = await service.assemblyFor("s")
  append(assembly.session, { type: "user/message", text: "remember the task ".repeat(100) })
  const compact = assembly.compactNow()
  try {
    await vi.waitFor(() => expect(started).toBe(true))
    expect(() => service.rebindModel("s", { model, providerId: "test", modelId: "b", label: "b", contextWindow: 50000 })).toThrow(/busy/)
    expect(await service.modelState("s")).toMatchObject({ modelId: "a" })
  } finally { release(); await compact; await service.close() }
})
