import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createMockClient } from "@i-harness/llm-mock"
import { createSession, append, type Session } from "@i-harness/core-session"
import { createSessionExecutor } from "@i-harness/core-agent"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import type { SandboxDenial } from "@i-harness/sandbox"
import { createSessionAssembly } from "../src/assembly.ts"

/**
 * END-TO-END: the escalation ladder, from a model's arguments to a write that
 * actually lands — and to a refusal that actually refuses.
 *
 * Task A built the machinery inside `@i-harness/sandbox` and could not reach it
 * from a real turn (its report says so explicitly: "the model can actually
 * escalate is NOT demonstrated by this task -- that is Task B, and its assembly
 * test is the proof"). This is that proof. Everything below drives a REAL
 * assembly with a REAL `checkWrite` behind its write guard; only the approval
 * answerer is a double, because a human is not available to a test.
 *
 * THE TARGET IS INSIDE THE WORKSPACE ON PURPOSE (tests 1, 2 and 4). An outside
 * target would ALSO trip `guard-approval`'s Layer 2 directory whitelist, so the
 * approval service would be asked twice for one call and the test could not tell
 * the ladder's ask from the whitelist's. Inside the workspace, Layer 2 allows
 * silently and the ladder is the only thing that can ask — which is exactly what
 * makes the granted-write assertion discriminating: under `read-only`,
 * `checkWrite` refuses an in-workspace write too, so the file can only appear if
 * the GRANTED mode reached the check.
 */

/** One real turn on the assembly's session, drained to completion. */
async function runTurn(assembly: Awaited<ReturnType<typeof createSessionAssembly>>): Promise<void> {
  const executor = createSessionExecutor({ session: assembly.session, agent: assembly.agent, inbox: assembly.inbox })
  executor.submit({ tier: "send", text: "go" })
  await executor.drain()
}

/**
 * The `SandboxDenial` the model received.
 *
 * TWO ENCODINGS reach it, and this helper exists because of the difference:
 * the LADDER's refusal carries the denial as a structured `denial` field
 * (`{ error, code, denial }`), while the write GUARD's refusal still serializes
 * it into `error` as JSON under `FS_SANDBOX_DENIED` — kept byte-identical for
 * existing readers. The split is deferred minor #3 in the plan, owned by the
 * final review, not by this task: what matters here is that both are the SAME
 * `SandboxDenial` shape, so a model can classify them the one way.
 */
function denialFrom(session: Session): SandboxDenial {
  const result = session.events.filter((e) => e.type === "tool/result").at(-1)
  expect(result, "the model must receive a tool result").toBeDefined()
  const output = (result as { output?: { error?: string; denial?: SandboxDenial } }).output
  if (output?.denial !== undefined) return output.denial
  expect(output?.error).toBeTypeOf("string")
  return JSON.parse(output!.error!) as SandboxDenial
}

function modelWriting(target: string, extra: Record<string, unknown>) {
  return createMockClient([
    { role: "assistant", toolCalls: [{ name: "write", args: { path: target, text: "escalated", ...extra } }] },
    { role: "assistant", text: "done" },
  ])
}

describe("assembly → the fs escalation ladder", () => {
  it("a granted escalation lands the write under the GRANTED mode, and moves no session mode", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-escalation-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    const target = join(workspace, "inside.txt")
    const session = createSession()
    append(session, { type: "user/message", text: "write it" })
    const prompts: Array<{ name: string; reason: string }> = []
    const assembly = await createSessionAssembly({
      workspace,
      session,
      model: modelWriting(target, {
        sandbox_permissions: "workspace-write",
        justification: "this file is part of the task",
      }),
      sandbox: "read-only",
    })
    try {
      // The host's answerer, wired the way a real host wires it (assembly.ctx).
      registerApprovalAnswerer(assembly.ctx, async (req) => {
        prompts.push({ name: req.name, reason: req.reason })
        return { approved: true }
      })
      await runTurn(assembly)

      // (a) somebody was ASKED, and the prompt named the operation.
      expect(prompts).toHaveLength(1)
      expect(prompts[0]!.reason).toContain("escalate sandbox to workspace-write")
      expect(prompts[0]!.reason).toContain(target)
      // (b) the write LANDED. Under `read-only` the guard refuses an in-workspace
      // write too, so this is only reachable if the granted mode reached
      // `checkWrite` — `writeGuard`'s `modeOverride` parameter is the whole
      // bridge, and this is the assertion that goes red without it.
      expect(readFileSync(target, "utf8")).toBe("escalated")
      // And the grant moved nothing standing: no `sandbox/mode` event, no change
      // to the session's mode (spec §3.3 point 1 -- per-call, transient).
      expect(session.events.filter((e) => e.type === "sandbox/mode")).toHaveLength(0)
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("a rejected escalation leaves the file absent and returns a classified denial", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-escalation-no-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    const target = join(workspace, "inside.txt")
    const session = createSession()
    append(session, { type: "user/message", text: "write it" })
    let asked = 0
    const assembly = await createSessionAssembly({
      workspace,
      session,
      model: modelWriting(target, { sandbox_permissions: "workspace-write", justification: "because" }),
      sandbox: "read-only",
    })
    try {
      registerApprovalAnswerer(assembly.ctx, async () => {
        asked += 1
        return { approved: false }
      })
      await runTurn(assembly)

      expect(asked).toBe(1)
      expect(existsSync(target)).toBe(false)
      const denial = denialFrom(session)
      expect(denial.code).toBe("SANDBOX_DENIED")
      expect(denial.surface).toBe("fs")
      expect(denial.mode).toBe("read-only")
      expect(denial.reason).toMatch(/rejected/)
      // The request was refused, not the operation: no escalation advice.
      expect(denial.escalation).toBeUndefined()
      // The turn survived: a REFUSAL is a value, not a throw that discards the
      // batch and appends no `tool/result` (the model would read a hung call).
      expect(session.events.some((e) => e.type === "turn/end")).toBe(true)
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("a grant that does NOT make the operation legal reports the GRANTED mode", async () => {
    // The second mode in play: the session's standing `read-only`, and the
    // `workspace-write` the user granted. `workspace-write` does not reach
    // outside the workspace, so the check still fails — and the denial must name
    // the mode the CHECK ran under. Told "read-only" instead, a model that just
    // obtained `workspace-write` retries forever against a mode it is no longer
    // in.
    const base = mkdtempSync(join(tmpdir(), "i-harness-escalation-still-"))
    const workspace = join(base, "ws")
    const outside = join(base, "outside")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const target = join(outside, "escaped.txt")
    const session = createSession()
    append(session, { type: "user/message", text: "write it" })
    const assembly = await createSessionAssembly({
      workspace,
      session,
      model: modelWriting(target, { sandbox_permissions: "workspace-write", justification: "outside the workspace" }),
      // Layer 2 of guard-approval ALSO asks for an outside target; auto-approving
      // it keeps this test about the ladder's grant, which is the one that
      // matters (both asks are answered by the same service).
      approveAll: true,
      sandbox: "read-only",
    })
    try {
      await runTurn(assembly)
      expect(existsSync(target)).toBe(false)
      const denial = denialFrom(session)
      expect(denial.mode).toBe("workspace-write")
      expect(denial.reason).toMatch(/outside|workspace/i)
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("the grant is per CALL: the very next write is refused again", async () => {
    // `EscalationOutcome`'s literal `"allowed-once"`: one call, not a standing
    // mode change. Two writes in one turn — the first escalated and granted, the
    // second plain — so "the grant persisted" would be visible as a second file.
    const base = mkdtempSync(join(tmpdir(), "i-harness-escalation-once-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    const first = join(workspace, "first.txt")
    const second = join(workspace, "second.txt")
    const session = createSession()
    append(session, { type: "user/message", text: "write twice" })
    const assembly = await createSessionAssembly({
      workspace,
      session,
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "write", args: { path: first, text: "one", sandbox_permissions: "workspace-write", justification: "first" } }] },
        { role: "assistant", toolCalls: [{ name: "write", args: { path: second, text: "two" } }] },
        { role: "assistant", text: "done" },
      ]),
      sandbox: "read-only",
    })
    try {
      registerApprovalAnswerer(assembly.ctx, async () => ({ approved: true }))
      await runTurn(assembly)
      expect(readFileSync(first, "utf8")).toBe("one")
      expect(existsSync(second)).toBe(false)
      const denial = denialFrom(session)
      expect(denial.mode).toBe("read-only")
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })
})
