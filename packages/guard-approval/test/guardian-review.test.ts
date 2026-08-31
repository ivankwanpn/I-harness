import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { createProviderRegistry } from "@i-harness/provider"
import { createExecService } from "@i-harness/exec"
import { registerSubagent } from "@i-harness/subagent"
import { registerGuardian, runGuardianReview, ensureReviewerRole, renderGuardianMessage } from "../src/guardian/index.ts"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { createApprovalPolicy } from "../src/index.ts"

function makeSubagents(ctx: PluginContext, parentRegistry: ReturnType<typeof createToolRegistry>, parentSession: ReturnType<typeof createSession>, model: ReturnType<typeof createMockClient>) {
  const exec = createExecService()
  const providers = createProviderRegistry()
  const sub = registerSubagent(ctx, parentRegistry, {
    providers, exec, parentModel: model, parentSession,
  })
  return { exec, providers, sub }
}

describe("guardian review", () => {
  it("registers the reviewer role once and keeps an existing one", () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    const session = createSession()
    const { sub } = makeSubagents(ctx, reg, session, createMockClient([{ role: "assistant", text: "ok" }]))
    const role = ensureReviewerRole(sub.roles)
    expect(role.name).toBe("reviewer")
    expect(role.tools).toEqual([])
    expect(ensureReviewerRole(sub.roles)).toBe(role)
  })

  it("renders a bounded message containing the request facts", () => {
    const msg = renderGuardianMessage(
      { name: "bash", reason: "dangerous command", args: { command: "rm -rf /x" } },
      "last step: read data.txt",
    )
    expect(msg).toContain("rm -rf /x")
    expect(msg).toContain("dangerous command")
    expect(msg).toContain("last step: read data.txt")
    expect(msg).toContain('"outcome"')
  })

  it("runGuardianReview returns the model's verdict (approve)", async () => {
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    const reviewerModel = createMockClient([
      { role: "assistant", text: '{"outcome":"approve","rationale":"safe inside workspace","risk_level":"none"}' },
    ])
    const { sub } = makeSubagents(ctx, parentRegistry, parentSession, reviewerModel)
    const verdict = await runGuardianReview({
      subagents: sub, parentRegistry, parentSession, parentCtx: ctx,
      providers: createProviderRegistry(), parentModel: reviewerModel,
      model: reviewerModel,
    }, { name: "write", reason: "write to ./x", args: { path: "./x" } })
    expect(verdict.outcome).toBe("approve")
    expect(verdict.rationale).toContain("workspace")
    // transient reviewer is cleaned up
    expect(sub.table.entries().size).toBe(0)
    expect(sub.agents.entries().size).toBe(0)
  })

  it("malformed output denies fail-closed", async () => {
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    const reviewerModel = createMockClient([
      { role: "assistant", text: "I think it is fine." },
    ])
    const { sub } = makeSubagents(ctx, parentRegistry, parentSession, reviewerModel)
    const verdict = await runGuardianReview({
      subagents: sub, parentRegistry, parentSession, parentCtx: ctx,
      providers: createProviderRegistry(), parentModel: reviewerModel,
      model: reviewerModel,
    }, { name: "write", reason: "r", args: { path: "x" } })
    expect(verdict.outcome).toBe("deny")
    expect(verdict.rationale).toContain("malformed")
  })

  it("registerGuardian runs the full pipeline: deny skips the human answerer", async () => {
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    const session = createSession()
    // NOTE: the tool must NOT be one of guard-approval's special cases
    // (bash/pwsh/write) — those are classified on argv/path and an inside-
    // workspace `write` produces NO ask. A generic non-readOnly tool hits
    // Layer-1 fallback ("tool '...' requires approval") → ask fires.
    const tool = {
      name: "publish_artifact", description: "publish", inputSchema: { type: "object" },
      isReadOnly: false, execute: async () => ({ ok: true }),
    }
    registry.register(tool)
    createApprovalPolicy(ctx, registry, { workspace: process.cwd() })
    registerApprovalAnswerer(ctx, async () => { throw new Error("human answerer must not run") })
    const reviewerModel = createMockClient([
      { role: "assistant", text: '{"outcome":"deny","rationale":"no publishing today","risk_level":"high"}' },
    ])
    const { sub } = makeSubagents(ctx, registry, session, reviewerModel)
    await registerGuardian(ctx, {
      subagents: sub, parentRegistry: registry, parentSession: session, parentCtx: ctx,
      providers: createProviderRegistry(), parentModel: reviewerModel, model: reviewerModel,
    })
    await expect(registry.execute({ name: "publish_artifact", args: { tag: "1.0" } })).rejects.toThrow(/guardian denied: no publishing today/)
  })
})
