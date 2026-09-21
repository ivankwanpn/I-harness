import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createTimeoutGuard } from "@i-harness/guard-timeout"
import { createOutputSpillGuard } from "@i-harness/output-retention"

// ── the exemption's ONE production-reachable member ─────────────────────────
// The spill guard is mounted on the `tools/execute` cascade, so it sees only
// values a cascade HANDLER returned. core-agent's four synthetic fills are
// written straight to the session (`append`), skipping the cascade — those
// codes can never arrive here in production (their membership is
// defence-in-depth, plus the value-collision rule stated at the set). The
// timeout guard IS a cascade handler and the assembly mounts it INSIDE the
// spill guard, so its verdict is the one synthetic code that really crosses
// this seam. Measured before TOOL_TIMEOUT was in the set: this result came back
// as a spill envelope whose durable record had no top-level `code` and carried
// "TOOL_TIMEOUT" only as truncated text.
//
// The drive below is the ASSEMBLY's own shape: spill mounted first (outermost),
// then timeout inside it. The control tool returns the same over-cap payload
// WITHOUT timing out, so the guard is proven live at this cap and the only
// difference between the two outcomes is the verdict.
describe("a timed-out call's verdict crosses the seam the exemption guards", () => {
  it("an over-cap TOOL_TIMEOUT result passes through whole, and its no-verdict control is bounded", async () => {
    const root = mkdtempSync(join(tmpdir(), "m5-timeout-seam-"))
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    const partial = () => ({ stdout: "S".repeat(10_000), stderr: "", exitCode: 0 })
    registry.register({
      name: "slow", description: "", inputSchema: {}, isConcurrencySafe: true, timeoutMs: 30,
      // The body outlives the deadline and returns the shell-shaped partial: the
      // timeout guard stamps `error`/`code` on top of it, `...partial` included.
      execute: async () => { await new Promise((r) => setTimeout(r, 200)); return partial() },
    } as Tool)
    registry.register({
      name: "fast", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => partial(),
    } as Tool)
    ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 2_000, spillRoot: root }))
    ctx.mount(createTimeoutGuard(ctx))

    // The control first: the same payload, no verdict — bounded, so the guard is
    // live at this cap and "untouched" cannot be reached by doing nothing.
    const fast = await registry.execute({ name: "fast", args: {} })
    expect((fast.output as { spill?: unknown }).spill).toBeDefined()

    const slow = await registry.execute({ name: "slow", args: {} })
    const out = slow.output as { code?: string; error?: string; spill?: unknown; stdout?: string }
    // The verdict and the reason it carries survive — what the exemption buys.
    expect(out.code).toBe("TOOL_TIMEOUT")
    expect(out.error).toContain("timed out after 30ms")
    expect(out.spill).toBeUndefined()
    // ... and it really was over the cap (this is why the pass-through is a
    // decision, not a result that never needed the guard).
    expect(Buffer.byteLength(JSON.stringify(out), "utf-8")).toBeGreaterThan(2_000)
    // Unbounded is the DECISION, not an accident: the timeout guard spread the
    // tool's partial output under the verdict, so the durable record now holds
    // the tool's own bytes too. (This is the one member of the set that can be
    // large; the other four are a message.)
    expect(out.stdout).toBe("S".repeat(10_000))
    rmSync(root, { recursive: true, force: true })
  })
})
