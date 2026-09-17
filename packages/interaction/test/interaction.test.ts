import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { registerApprovalAnswerer, registerQuestionProvider, registerCommand, runCommand, askUser } from "../src/index.ts"

function makeCtx(): PluginContext {
  return createContext()
}

describe("approval seam", () => {
  it("fails closed when no answerer is registered (audit F05-5)", () => {
    const ctx = makeCtx()
    expect(() => ctx.services.get("approval/answerer")).toThrow()
  })

  it("registers an answerer resolved as a boolean wrapper (audit F05-5)", async () => {
    const ctx = makeCtx()
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
    const fn = ctx.services.get<(req: { name: string; reason: string }) => Promise<boolean>>("approval/answerer")
    expect(typeof fn).toBe("function")
    expect(await fn({ name: "read", reason: "needs approval" })).toBe(true)
  })
})

describe("questions seam", () => {
  it("throws NO_PROVIDER when none registered", () => {
    const ctx = makeCtx()
    expect(() => askUser(ctx, { id: "q", prompt: "?" })).toThrow(/provider/i)
  })

  it("asks via a registered provider", async () => {
    const ctx = makeCtx()
    registerQuestionProvider(ctx, { ask: async (q) => `answer:${q.id}` })
    const ans = await askUser(ctx, { id: "q", prompt: "?" })
    expect(ans).toBe("answer:q")
  })
})

describe("commands seam (audit F05-6)", () => {
  it("executes a registered command", async () => {
    const ctx = makeCtx()
    registerCommand(ctx, { name: "help", execute: async () => "help text" })
    // 2026-09-17: runCommand's result is now an explicit CommandOutcome. This
    // assertion is the ONE that had to change — the value is the same string,
    // but it now says WHERE it goes (a reply: shown to the user, never into
    // model history). See test/prompt-command.test.ts and the spec.
    expect(await runCommand(ctx, "help", "")).toEqual({ kind: "reply", text: "help text" })
  })

  it("rejects unknown commands", async () => {
    const ctx = makeCtx()
    await expect(runCommand(ctx, "nope", "")).rejects.toThrow(/unknown command/i)
  })
})
