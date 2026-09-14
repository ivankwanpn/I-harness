import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createMockClient } from "@i-harness/llm-mock"
import { createSession, append } from "@i-harness/core-session"
import { createSessionExecutor } from "@i-harness/core-agent"
import { createSessionAssembly } from "../src/assembly.ts"

/**
 * END-TO-END: a session's sandbox mode must reach the fs tools.
 *
 * The defect, stated precisely, because the first version of this file got it
 * wrong and the failure taught us what is actually there:
 *
 * fs writes outside the workspace are NOT ungated. `guard-approval` Layer 2 asks
 * for approval on them (`write target outside workspace requires approval`), and
 * with no answerer registered that fails closed — which is what the first run of
 * this test hit. What the sandbox mode never does is get CONSULTED. The only gate
 * is a human approval, and `approveAll` (the CLI's `--yes`, apps/cli/src/index.ts)
 * auto-grants it. So `sandbox: "read-only"` refuses a shell write at the kernel
 * while the same session's `write` tool lands anywhere on disk.
 *
 * These tests therefore run with `approveAll: true` — the dangerous combination —
 * and assert that POLICY denies the write regardless of approval. Approval asks
 * "may I?"; the sandbox answers "no, not in this mode".
 */

/** A model whose first response is a tool call, then a plain completion. */
function modelCallingWrite(target: string) {
  return createMockClient([
    { role: "assistant", toolCalls: [{ name: "write", args: { path: target, text: "escaped" } }] },
    { role: "assistant", text: "done" },
  ])
}

async function runTurn(mode: "read-only" | "workspace-write" | undefined, workspace: string, target: string) {
  const session = createSession()
  append(session, { type: "user/message", text: "write it" })
  const assembly = await createSessionAssembly({
    workspace,
    session,
    model: modelCallingWrite(target),
    // The dangerous combination: approval is auto-granted, so the ONLY thing that
    // can refuse this write is the sandbox policy.
    approveAll: true,
    ...(mode !== undefined ? { sandbox: mode } : {}),
  })
  try {
    const executor = createSessionExecutor({ session, agent: assembly.agent, inbox: assembly.inbox })
    executor.submit({ tier: "send", text: "go" })
    await executor.drain()
    return session
  } finally {
    await assembly.dispose()
  }
}

describe("assembly → fs write confinement", () => {
  it("sandbox read-only denies an fs write outside the workspace", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-assembly-sandbox-"))
    const workspace = join(base, "ws")
    const outside = join(base, "outside")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const target = join(outside, "escaped.txt")
    try {
      const session = await runTurn("read-only", workspace, target)
      expect(existsSync(target)).toBe(false)
      // The refusal must be MODEL-VISIBLE as a classified failure, not a thrown
      // turn-killer: the model has to be able to read it and adapt.
      const resultEvent = session.events.find((e) => e.type === "tool/result")
      expect(JSON.stringify(resultEvent)).toContain("FS_SANDBOX_DENIED")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("no sandbox requested leaves fs writes unconfined (the pre-existing contract)", async () => {
    // The other direction, so the test above cannot pass by refusing everything.
    const base = mkdtempSync(join(tmpdir(), "i-harness-assembly-nosandbox-"))
    const workspace = join(base, "ws")
    const outside = join(base, "outside")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const target = join(outside, "allowed.txt")
    try {
      await runTurn(undefined, workspace, target)
      expect(readFileSync(target, "utf8")).toBe("escaped")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
