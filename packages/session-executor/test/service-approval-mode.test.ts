import { afterEach as afterFixture, vi as fixtureVi } from 'vitest'
afterFixture(() => fixtureVi.unstubAllGlobals())
import { controlledModel } from "./controlled-model.ts"
import { describe, expect, it, vi } from "vitest"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionService } from "../src/service.ts"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe("live approval modes", () => {
  it("runs an isolated reviewer on its selected model without creating child sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-f1-reviewer-owner-'))
    const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    await coordinator.create({ sessionId: 's' })
    const create = vi.spyOn(coordinator, 'create')
    const seen: { model: string; tools: number; effort?: string }[] = []
    let selected = "cheap-one"
    let mainCalls = 0
    const parent: ModelClient = controlledModel(async function* () {
      if (mainCalls++ % 2 === 0) yield { type: "tool_call", call: { name: "list_dir", args: { path: "." } } }
      else yield { type: "text/chunk", text: "done" }
      yield { type: "end" }
    })
    const service = createSessionService({
      workspace: process.cwd(), model: parent, coordinator, approvalMode: "delegate", allowSubagentModelSelection: false,
      guardian: { execution: "isolated", allowModelSelection: true },
      roleSelectionFor: (name) => name === "reviewer" ? { provider: "p", model: selected, reasoningEffort: "low" } : undefined,
      resolveRoleModel: async (selection) => ({ status: "ready", binding: { reasoningEffort: "low", contextWindow: 100000, maxOutputTokens: 8192, client: controlledModel(async function* (request) {
        seen.push({ model: selection.model, tools: request.tools.length, effort: request.reasoningEffort })
        yield { type: "text/chunk", text: '{"outcome":"approve","rationale":"safe","risk_level":"none"}' }
        yield { type: "end" }
      }) } }),
    })
    try {
      await service.submit("s", "first", new AbortController().signal)
      selected = "cheap-two"
      await service.submit("s", "second", new AbortController().signal)
      expect(seen).toEqual([{ model: "cheap-one", tools: 0, effort: "low" }, { model: "cheap-two", tools: 0, effort: "low" }])
      expect(create).not.toHaveBeenCalled()
    } finally { await service.close(); await coordinator.close() }
  })
  it("delegates tool review and switches the same assembly back to manual approval", async () => {
    let mode: "delegate" | "ask-all" | "dangerous" = "delegate"
    let mainCalls = 0
    let reviewerCalls = 0
    let manualCalls = 0
    const model: ModelClient = controlledModel(async function* (request) {
        if (String(request.systemPrompt).includes("approval guardian")) {
          reviewerCalls++
          yield { type: "text/chunk", text: '{"outcome":"approve","rationale":"read only","risk_level":"none"}' }
        } else if (mainCalls++ % 2 === 0) {
          yield { type: "tool_call", call: { name: "list_dir", args: { path: "." } } }
        } else {
          yield { type: "text/chunk", text: "done" }
        }
        yield { type: "end" }
      })
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
