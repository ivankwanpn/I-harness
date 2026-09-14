import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import type { SandboxDenial, SandboxMode } from "@i-harness/sandbox"
import type { TerminalService } from "@i-harness/terminal"
import { createSessionAssembly, type SessionAssembly } from "../src/assembly.ts"
import { rmWorkspaceSync } from "./helpers.ts"

/**
 * The ASSEMBLY → terminal hand-off: the wiring half of the terminal refusal.
 *
 * `packages/terminal/test/sandbox-refusal.test.ts` proves the tools refuse when
 * they are handed a resolver. It cannot prove the assembly hands them one — and a
 * mount-time snapshot (`sandboxPolicy: () => sandboxPolicyAtMount`) typechecks,
 * passes that file, and passes the read-only test below, because a session
 * mounted read-only refuses either way. Only a mode that CHANGES after the mount
 * can tell the two apart, so the third test here is the one that pins per-call
 * resolution end-to-end.
 *
 * Every assembly below is built with `approveAll: true` ON PURPOSE. The terminal
 * was never *ungated* — `guard-approval`'s Layer-1 fallback asks for any
 * non-`isReadOnly` tool, and `terminal_open` is one. But approval answers a
 * different question than confinement: the prompt never says the PTY will run
 * outside the requested mode, and on an approveAll host there is no prompt at
 * all. Auto-approving here removes the prompt as an explanation, so what these
 * tests observe can only be the sandbox rule.
 */

type ToolResultEvent = { type: "tool/result"; callId: string; name: string; output: unknown }

function toolResults(assembly: SessionAssembly): ToolResultEvent[] {
  return assembly.session.events.filter((e): e is ToolResultEvent => e.type === "tool/result")
}

function modelCallingTerminalOpen() {
  return [
    {
      role: "assistant" as const,
      toolCalls: [{ name: "terminal_open", args: { command: process.execPath, args: ["-e", "0"] } }],
    },
    { role: "assistant" as const, text: "done" },
  ]
}

/** The refusal as the model receives it, read off the tool/result output. */
function terminalResult(assembly: SessionAssembly): { code?: string; error?: string; denial?: SandboxDenial } {
  const result = toolResults(assembly).find((r) => r.name === "terminal_open")
  expect(result, "the model must receive a tool/result for terminal_open").toBeDefined()
  return result!.output as { code?: string; error?: string; denial?: SandboxDenial }
}

describe("the assembly hands the terminal a per-call policy", () => {
  it("a read-only assembly refuses terminal_open and spawns nothing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "i-harness-term-refuse-"))
    const assembly = await createSessionAssembly({
      workspace,
      sessionId: "s1",
      approveAll: true,
      modelPolicy: "test-mock",
      mockScript: modelCallingTerminalOpen(),
      sandbox: "read-only",
    })
    try {
      await assembly.agent.run("go")
      const output = terminalResult(assembly)
      // Asserted field by field: `Tool<Args, Output>` erases `Output` at the
      // registry, so nothing here is enforced by tsc.
      expect(output.code).toBe("SANDBOX_DENIED")
      expect(output.denial?.code).toBe("SANDBOX_DENIED")
      expect(output.denial?.surface).toBe("terminal")
      expect(output.denial?.mode).toBe("read-only")
      // The independent proof that no PTY exists — read from the SERVICE the
      // assembly registered, not inferred from the returned JSON.
      const terminals = assembly.ctx.services.get<TerminalService>("terminal/service")
      expect(terminals.list()).toEqual([])
    } finally {
      await assembly.dispose()
      rmWorkspaceSync(workspace)
    }
    // No budget override: the refusal happens before any spawn, so this test is
    // fast. If it ever needs a timeout, the refusal stopped being a refusal.
  })

  it("a mid-session tightening reaches the NEXT terminal_open (nothing is spawned)", async () => {
    // The mount-time snapshot this task removed would have passed every other
    // test in this file: the session mounts permissive, so the snapshot can only
    // ever be permissive, whatever the session does afterwards.
    const workspace = mkdtempSync(join(tmpdir(), "i-harness-term-percall-"))
    const session = createSession()
    append(session, { type: "user/message", text: "go" })
    const assembly = await createSessionAssembly({
      workspace,
      session,
      sessionId: "s1",
      approveAll: true,
      modelPolicy: "test-mock",
      mockScript: modelCallingTerminalOpen(),
      // Permissive at mount — and no provider is composed for it.
      sandbox: "danger-full-access",
    })
    try {
      // The escalation ladder's shape: the SAME assembly, no reassembly, with the
      // mode tightened after the tools were mounted.
      append(session, { type: "sandbox/mode", mode: "read-only" })
      await assembly.agent.run("go")
      const output = terminalResult(assembly)
      expect(output.denial?.surface).toBe("terminal")
      expect(output.denial?.mode).toBe("read-only")
      const terminals = assembly.ctx.services.get<TerminalService>("terminal/service")
      expect(terminals.list()).toEqual([])
    } finally {
      await assembly.dispose()
      rmWorkspaceSync(workspace)
    }
  })

  it("the mode the denial advises, granted through the session, actually opens the PTY", async () => {
    // THE END-TO-END FORM OF THE ADVICE TEST, and the one that would have caught
    // the unactionable target: from a read-only assembly the refusal used to
    // advise "workspace-write" (the first strictly-wider mode), which the terminal
    // refuses in as well — the advised retry returned the IDENTICAL denial. A
    // string assertion cannot see that; granting the advised mode and observing a
    // real PTY can.
    const workspace = mkdtempSync(join(tmpdir(), "i-harness-term-advice-"))
    const session = createSession()
    append(session, { type: "user/message", text: "go" })
    const assembly = await createSessionAssembly({
      workspace,
      session,
      sessionId: "s1",
      approveAll: true,
      modelPolicy: "test-mock",
      // Two turns on one cassette: refuse, then retry after the grant.
      mockScript: [
        ...modelCallingTerminalOpen(),
        ...modelCallingTerminalOpen(),
      ],
      sandbox: "read-only",
    })
    const terminals = assembly.ctx.services.get<TerminalService>("terminal/service")
    let opened: string | undefined
    try {
      await assembly.agent.run("go")
      const refused = terminalResult(assembly)
      expect(refused.denial?.surface).toBe("terminal")
      expect(terminals.list()).toEqual([])

      const advised = /sandbox_permissions set to "([^"]+)"/.exec(refused.denial?.escalation ?? "")?.[1]
      expect(advised, "the denial must name a mode").toBeDefined()
      // The escalation ladder's shape: an approved request becomes the session's
      // mode, and the NEXT call resolves against it.
      append(session, { type: "sandbox/mode", mode: advised as SandboxMode })

      await assembly.agent.run("retry with the mode the denial named")
      const results = toolResults(assembly).filter((r) => r.name === "terminal_open")
      expect(results, "the retry must produce a second tool/result").toHaveLength(2)
      opened = (results[1]!.output as { id?: string }).id
      expect(opened, `the advised retry to "${advised}" must open the PTY, not refuse again`).toBeDefined()
      // A real PTY, in the service the assembly registered.
      expect(terminals.list().map((v) => v.id)).toContain(opened)
    } finally {
      if (opened !== undefined) {
        try { terminals.close(opened, { sessionId: "s1" }) } catch { /* already gone */ }
      }
      await assembly.dispose()
      rmWorkspaceSync(workspace)
    }
    // The retry starts a real node-pty process (the refusal half never does), so
    // this one carries the same explicit budget as the control below.
  }, 30_000)

  it("CONTROL: a host that requested no sandbox still gets a working terminal_open", async () => {
    // Without this the two tests above could pass against a wiring that refuses
    // every terminal call for reasons that have nothing to do with the mode.
    const workspace = mkdtempSync(join(tmpdir(), "i-harness-term-ctl-"))
    const assembly = await createSessionAssembly({
      workspace,
      sessionId: "s1",
      approveAll: true,
      modelPolicy: "test-mock",
      mockScript: modelCallingTerminalOpen(),
      // No `sandbox` option at all: the host requested no sandbox, so no
      // resolver is passed and nothing is refused (the pre-M16 behaviour).
    })
    const terminals = assembly.ctx.services.get<TerminalService>("terminal/service")
    let opened: string | undefined
    try {
      await assembly.agent.run("go")
      const result = toolResults(assembly).find((r) => r.name === "terminal_open")
      opened = (result?.output as { id?: string } | undefined)?.id
      expect(opened, "terminal_open must have reached the service").toBeDefined()
      // A real PTY was started, so it must also really exist.
      expect(terminals.list().map((v) => v.id)).toContain(opened)
    } finally {
      // A live PTY must not outlive the test — dispose() would catch it too, but
      // closing by handle first is what proves the terminal was real.
      if (opened !== undefined) {
        try { terminals.close(opened, { sessionId: "s1" }) } catch { /* already gone */ }
      }
      await assembly.dispose()
      rmWorkspaceSync(workspace)
    }
    // This case starts a real node-pty process on the host. `workspace-cwd.test.ts`
    // gives its PTY test 30_000 for the same reason; the default 5s turns a slow
    // start into a hung suite rather than a failure.
  }, 30_000)
})
