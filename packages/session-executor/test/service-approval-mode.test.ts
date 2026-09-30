import { describe, expect, it, vi } from "vitest"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionService } from "../src/service.ts"
import type { SessionCoordinator } from "@i-harness/session-persistence"

describe("live approval modes", () => {
  it("runs an isolated reviewer on its selected model without creating child sessions", async () => {
    const create = vi.fn(async () => ({ id: "unexpected-child" }))
    const coordinator = { create, enqueue() {}, async flush() {}, async getDocument() { return undefined }, async putDocument() {} } as unknown as SessionCoordinator
    const seen: { model: string; tools: number; effort?: string }[] = []
    let selected = "cheap-one"
    let mainCalls = 0
    const parent: ModelClient = { async *stream() {
      if (mainCalls++ % 2 === 0) yield { type: "tool_call", call: { name: "list_dir", args: { path: "." } } }
      else yield { type: "text/chunk", text: "done" }
      yield { type: "end" }
    } }
    const service = createSessionService({
      workspace: process.cwd(), model: parent, coordinator, approvalMode: "delegate", allowSubagentModelSelection: false,
      guardian: { execution: "isolated", allowModelSelection: true },
      roleSelectionFor: (name) => name === "reviewer" ? { provider: "p", model: selected, reasoningEffort: "low" } : undefined,
      resolveRoleModel: async (selection) => ({ status: "ready", binding: { reasoningEffort: "low", contextWindow: 100000, maxOutputTokens: 8192, client: { async *stream(request) {
        seen.push({ model: selection.model, tools: request.tools.length, effort: request.reasoningEffort })
        yield { type: "text/chunk", text: '{"outcome":"approve","rationale":"safe","risk_level":"none"}' }
        yield { type: "end" }
      } } } }),
    })
    try {
      await service.submit("s", "first", new AbortController().signal)
      selected = "cheap-two"
      await service.submit("s", "second", new AbortController().signal)
      expect(seen).toEqual([{ model: "cheap-one", tools: 0, effort: "low" }, { model: "cheap-two", tools: 0, effort: "low" }])
      expect(create).not.toHaveBeenCalled()
    } finally { await service.close() }
  })
  it("delegates tool review and switches the same assembly back to manual approval", async () => {
    let mode: "delegate" | "ask-all" | "dangerous" = "delegate"
    let mainCalls = 0
    let reviewerCalls = 0
    let manualCalls = 0
    const model: ModelClient = {
      async *stream(request) {
        if (String(request.systemPrompt).includes("approval guardian")) {
          reviewerCalls++
          yield { type: "text/chunk", text: '{"outcome":"approve","rationale":"read only","risk_level":"none"}' }
        } else if (mainCalls++ % 2 === 0) {
          yield { type: "tool_call", call: { name: "list_dir", args: { path: "." } } }
        } else {
          yield { type: "text/chunk", text: "done" }
        }
        yield { type: "end" }
      },
    }
    const service = createSessionService({ workspace: process.cwd(), model, approvalMode: () => mode, guardian: { enabled: () => mode === "delegate" } })
    const off = service.onAssembly((assembly) => registerApprovalAnswerer(assembly.ctx, async () => { manualCalls++; return { approved: true } }))
    try {
      await service.submit("s", "first", new AbortController().signal)
      expect(reviewerCalls).toBe(1)
      expect(manualCalls).toBe(0)
      mode = "ask-all"
      await service.submit("s", "second", new AbortController().signal)
      expect(reviewerCalls).toBe(1)
      expect(manualCalls).toBe(1)
      mode = "dangerous"
      await service.submit("s", "third", new AbortController().signal)
      expect(reviewerCalls).toBe(1)
      expect(manualCalls).toBe(1)
    } finally { off(); await service.close() }
  })
})
