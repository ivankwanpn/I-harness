// ctx 建構沿用 interaction.test.ts 既有模式：createContext() from @i-harness/core-plugin
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { registerApprovalAnswerer, type ApprovalRequest } from "../src/index.ts"

function makeCtx() {
  return createContext()
}

describe("ApprovalRequest extension (M22)", () => {
  it("approveAll-style answerer ignores extra echo-consent fields", async () => {
    const ctx = makeCtx()
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
    const fn = ctx.services.get<(req: { name: string; reason: string }) => Promise<boolean>>("approval/answerer")
    // 綁定型別變數（非 fresh literal）——echo-consent 欄位是 ApprovalRequest 的合法成員
    const req: ApprovalRequest = {
      name: "bash",
      reason: "r",
      command: "rm -rf /",
      argv: ["rm", "-rf", "/"],
      dangerClass: "extreme",
      pathSummary: "/",
    }
    expect(await fn(req)).toBe(true)
  })

  it("old shape (no extra fields) still works", async () => {
    const ctx = makeCtx()
    registerApprovalAnswerer(ctx, async () => ({ approved: false }))
    const fn = ctx.services.get<(req: { name: string; reason: string }) => Promise<boolean>>("approval/answerer")
    expect(await fn({ name: "bash", reason: "r" })).toBe(false)
  })
})
