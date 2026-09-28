import { describe, expect, it } from "vitest"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionService } from "../src/service.ts"

describe("live approval modes", () => {
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
