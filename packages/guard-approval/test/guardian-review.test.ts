import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
import { registerExec } from "@i-harness/exec"
import { registerSubagent } from "@i-harness/subagent"
import { registerGuardian, runGuardianReview, ensureReviewerRole, renderGuardianMessage } from "../src/guardian/index.ts"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { createApprovalPolicy } from "../src/index.ts"

/** The seam is required; the reviewer role carries no model, so it is never
 * reached — the spawn path that reads a role's model is covered in
 * @i-harness/subagent's child.test.ts. */
const noRoleModel = async () => ({ status: "unconfigured" as const, reason: "unused" })

function makeSubagents(ctx: PluginContext, parentRegistry: ReturnType<typeof createToolRegistry>, parentSession: ReturnType<typeof createSession>, model: ReturnType<typeof createMockClient>) {
  const exec = registerExec(createContext())
  const sub = registerSubagent(ctx, parentRegistry, {
    resolveModel: noRoleModel, exec, parentModel: model, parentSession,
  })
  return { exec, sub }
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
      resolveModel: noRoleModel, parentModel: reviewerModel,
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
      resolveModel: noRoleModel, parentModel: reviewerModel,
      model: reviewerModel,
    }, { name: "write", reason: "r", args: { path: "x" } })
    expect(verdict.outcome).toBe("deny")
    expect(verdict.rationale).toContain("malformed")
    // M40 A7: the fail-closed cause is tagged for the breaker counting.
    expect(verdict.cause).toBe("malformed")
  })

  it("M40 A7: a review timeout denies fail-closed with cause=timeout", async () => {
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    // Slow reviewer: the first chunk arrives quickly, the turn only SETTLES
    // after 300ms — the 50ms runner timeout wins the race.
    const slowModel: ModelClient = {
      async *stream() {
        yield { type: "text/chunk", text: "slow review" }
        await new Promise((r) => setTimeout(r, 300))
        yield { type: "end" }
      },
    }
    const { sub } = makeSubagents(ctx, parentRegistry, parentSession, slowModel)
    const verdict = await runGuardianReview({
      subagents: sub, parentRegistry, parentSession, parentCtx: ctx,
      resolveModel: noRoleModel, parentModel: slowModel,
      model: slowModel, timeoutMs: 50,
    }, { name: "write", reason: "timed", args: { path: "x" } })
    expect(verdict.outcome).toBe("deny")
    expect(verdict.rationale).toContain("timed out")
    expect(verdict.cause).toBe("timeout")
    // transient reviewer is cleaned up despite the timeout
    expect(sub.table.entries().size).toBe(0)
    expect(sub.agents.entries().size).toBe(0)
  })

  // The guardian's spawn is one of the assembly's three role-carrying spawn
  // sites, so it must resolve the reviewer's model through the SAME seam the
  // subagent tools use: a settings-declared `agents.roles.reviewer` entry plus
  // `plugins.subagentModel` has to reach spawnChild from these deps. Without
  // them the declared selection collapsed to the role's own (undefined) model,
  // so the reviewer silently inherited the parent's client here while the
  // team/rebuild paths resolved the declared one — the same role on two models.
  it("a settings-declared reviewer selection reaches the guardian's spawn (no silent inherit)", async () => {
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    // The parent's client answers with a verdict the runner cannot parse; the
    // DECLARED client's verdict is the one that approves. So the verdict below
    // says which client actually ran, not merely that one was built.
    const parentModel = createMockClient([{ role: "assistant", text: "I think it is fine." }])
    const declaredModel = createMockClient([
      { role: "assistant", text: '{"outcome":"approve","rationale":"declared model ran","risk_level":"none"}' },
    ])
    const { sub } = makeSubagents(ctx, parentRegistry, parentSession, parentModel)
    const calls: Array<{ provider: string; model: string }> = []
    const verdict = await runGuardianReview({
      subagents: sub, parentRegistry, parentSession, parentCtx: ctx,
      resolveModel: async (selection) => {
        calls.push(selection)
        return { status: "ready" as const, binding: { client: declaredModel } }
      },
      parentModel,
      allowSubagentModelSelection: true,
      roleSelectionFor: (roleName) => (roleName === "reviewer" ? { provider: "gw", model: "small" } : undefined),
    }, { name: "write", reason: "write to ./x", args: { path: "./x" } })

    expect(calls).toEqual([{ provider: "gw", model: "small" }])
    expect(verdict.outcome).toBe("approve")
    expect(verdict.rationale).toContain("declared model ran")
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
      resolveModel: noRoleModel, parentModel: reviewerModel, model: reviewerModel,
    })
    await expect(registry.execute({ name: "publish_artifact", args: { tag: "1.0" } })).rejects.toThrow(/guardian denied: no publishing today/)
  })
})
