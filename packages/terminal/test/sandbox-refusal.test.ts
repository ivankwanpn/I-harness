import { describe, expect, it } from "vitest"
import type { Tool } from "@i-harness/core-tools"
import type { TerminalService } from "../src/service.ts"
import { createProcessTools, createTerminalTools } from "../src/tool.ts"

/**
 * The PTY is the last surface that could be started under a confined mode and
 * then run unrestricted.
 *
 * WHAT THE HOLE ACTUALLY WAS. The terminal was never *ungated*: `registerTerminal`
 * mounted unconditionally and its tools received only `{ cwd }`, and
 * `guard-approval`'s Layer-1 fallback asks for any non-`isReadOnly` tool — which
 * `terminal_open` is. But APPROVAL ANSWERS A DIFFERENT QUESTION THAN CONFINEMENT:
 * the prompt never says the PTY will run outside the requested mode, and on an
 * `approveAll` host there is no prompt at all. So `--sandbox read-only` could open
 * a shell that writes anywhere.
 *
 * WHY THE REFUSAL IS PER CALL, NOT AT MOUNT. The spec's §3.4 first said "do not
 * mount the terminal when the mode is restricted", and that was withdrawn: a
 * mount-time decision cannot see a mid-session change, so a session mounted
 * `danger-full-access` and later tightened (which the escalation ladder is) would
 * keep unconfined PTY tools. The tools therefore mount ALWAYS and refuse per call.
 *
 * WHY NOTHING HERE WRAPS THE PTY IN A RUNNER: it cannot be confined. A runner
 * around an interactive terminal would confine nothing while pretending the hole
 * was closed — the failure mode the spec names.
 *
 * The assertions are written against the FIELDS, not the declared output type:
 * `Tool<Args, Output>` erases `Output` at the registry
 * (`packages/core-tools/src/index.ts:10,15,120`), so a refusal that dropped
 * `code`/`surface`/`mode` entirely would still typecheck.
 */

/** A spy service that records every call, so "was a PTY actually spawned?" is a
 * real assertion rather than an inference from the returned object. */
function spyService() {
  const opened: Record<string, unknown>[] = []
  const sent: Array<{ id: string; data: string }> = []
  const signalled: Array<{ id: string; signal: string }> = []
  const closed: string[] = []
  const reads: Array<{ id: string; offset?: number }> = []
  const resized: Array<{ id: string; cols: number; rows: number }> = []
  let lists = 0
  const service = {
    open: (spec: Record<string, unknown>) => {
      opened.push(spec)
      return { id: "t1", pid: 1, cols: 80, rows: 24 }
    },
    send: (id: string, data: string): void => {
      sent.push({ id, data })
    },
    read: (id: string, opts?: { offset?: number; maxBytes?: number; sessionId?: string }) => {
      reads.push({ id, ...(opts?.offset !== undefined ? { offset: opts.offset } : {}) })
      return { data: "", nextOffset: 0 }
    },
    signal: (id: string, signal: string) => {
      signalled.push({ id, signal })
      return { id, status: "signalled" }
    },
    close: (id: string) => {
      closed.push(id)
      return { id, status: "closed" }
    },
    resize: (id: string, cols: number, rows: number) => {
      resized.push({ id, cols, rows })
      return { id, cols, rows, status: "running" }
    },
    list: () => {
      lists += 1
      return []
    },
  } as unknown as TerminalService
  return { service, opened, sent, signalled, closed, reads, resized, listCount: () => lists }
}

type Spy = ReturnType<typeof spyService>

/** The refusal as a MODEL sees it — fields read off the returned object. */
type Refusal = { error?: string; code?: string; denial?: { code: string; surface: string; mode: string; reason: string; escalation?: string } }

function toolNamed(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name)
  expect(tool, `${name} must still be mounted`).toBeDefined()
  return tool!
}

/**
 * The mode the refusal TELLS THE MODEL to retry with, read out of the sentence
 * the model actually receives — not from a constant, so a denial that names the
 * wrong mode cannot pass by agreeing with itself.
 */
function advisedMode(denial: Refusal["denial"]): string {
  const match = /sandbox_permissions set to "([^"]+)"/.exec(denial?.escalation ?? "")
  expect(match, "the denial must name a mode to retry with").not.toBeNull()
  return match![1]!
}

/** Every call that must refuse, with the effect on the spy that proves it did
 * not reach the service, and the effect that proves a permitted retry DID. */
const REFUSING_CALLS: Array<{ name: string; args: Record<string, unknown>; reached: (spy: Spy) => number }> = [
  { name: "terminal_open", args: { command: "bash" }, reached: (spy) => spy.opened.length },
  { name: "process_spawn", args: { command: "bash" }, reached: (spy) => spy.opened.length },
  { name: "terminal_send", args: { id: "t1", data: "echo hi" }, reached: (spy) => spy.sent.length },
]

/** All nine tools as `registerTerminal` mounts them, over one spy. */
function mounted(spy: Spy, mode: () => "read-only" | "workspace-write" | "danger-full-access"): Tool[] {
  const deps = { service: spy.service, sandboxPolicy: () => ({ mode: mode(), workspaceRoot: "/ws" }) }
  return [...createTerminalTools(deps), ...createProcessTools(deps)]
}

describe("terminal refuses capability-creating calls under a confined mode", () => {
  it("terminal_open refuses and never reaches the service", async () => {
    const spy = spyService()
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    })
    const result = (await toolNamed(tools, "terminal_open").execute({ command: "bash" }, {})) as Refusal
    // The shared denial shape (spec §3.2), asserted field by field — the output
    // type is erased at the registry, so nothing here is enforced by tsc.
    expect(result.code).toBe("SANDBOX_DENIED")
    expect(result.denial?.code).toBe("SANDBOX_DENIED")
    expect(result.denial?.surface).toBe("terminal")
    expect(result.denial?.mode).toBe("read-only")
    expect(result.denial?.reason).toContain("read-only")
    // The escalation guidance is what keeps the refusal actionable. The mode it
    // must name is the narrowest mode in which THIS operation is permitted —
    // `danger-full-access`, NOT the first strictly-wider mode `denialFor` picks
    // by default ("workspace-write" from read-only), which `confinement` refuses
    // too. The retry tests below are what actually hold this; the string here
    // only documents it.
    expect(advisedMode(result.denial)).toBe("danger-full-access")
    // The load-bearing assertion: refusing must not have spawned anything.
    expect(spy.opened).toHaveLength(0)
  })

  it("the refusal carries the escalation guidance so the model can recover", async () => {
    // read-only has wider modes; a refusal with no way forward is a dead end.
    const tools = createTerminalTools({
      service: spyService().service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    })
    const result = (await toolNamed(tools, "terminal_open").execute({ command: "bash" }, {})) as Refusal
    expect(result.denial?.escalation).toBeDefined()
    expect(result.error).toContain("sandbox_permissions")
    // The refusal is RETURNED, never thrown: a throwing body fails the whole turn
    // and appends no tool/result, so the model reads a hung call instead of an
    // answer. `error` repeats reason + escalation for a reader that only looks at
    // `error`; the structured denial rides alongside it.
    expect(result.error).toContain(result.denial!.reason)
  })

  it("workspace-write is confined too — a PTY is only allowed under danger-full-access", async () => {
    // workspace-write is not a synonym for unrestricted: the PTY ignores the
    // kernel sandbox entirely, so it must not inherit a mode that claims to
    // confine writes to the workspace.
    const spy = spyService()
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "workspace-write", workspaceRoot: "/ws" }),
    })
    const result = (await toolNamed(tools, "terminal_open").execute({ command: "bash" }, {})) as Refusal
    expect(result.denial?.mode).toBe("workspace-write")
    // From workspace-write the only mode a PTY is permitted in is
    // danger-full-access, which is also its only strictly-wider mode.
    expect(advisedMode(result.denial)).toBe("danger-full-access")
    expect(spy.opened).toHaveLength(0)
  })

  it("observation and shutdown stay allowed under a confined mode", async () => {
    const spy = spyService()
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    })
    // These can only observe or SHUT DOWN. Refusing them would strand live PTYs
    // opened under a wider mode with no way to close them — so "mounted" is not
    // the assertion; each one is EXERCISED and must reach the service.
    await toolNamed(tools, "terminal_list").execute({}, {})
    expect(spy.listCount()).toBe(1)
    await toolNamed(tools, "terminal_read").execute({ id: "t1" }, {})
    expect(spy.reads).toEqual([{ id: "t1" }])
    await toolNamed(tools, "terminal_signal").execute({ id: "t1", signal: "INT" }, {})
    expect(spy.signalled).toEqual([{ id: "t1", signal: "INT" }])
    await toolNamed(tools, "terminal_close").execute({ id: "t1" }, {})
    expect(spy.closed).toEqual(["t1"])
  })

  it("danger-full-access is not confined and must keep working", async () => {
    // The control. A fix that refuses everything would pass the three tests above
    // and be useless.
    const spy = spyService()
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "danger-full-access", workspaceRoot: "/ws" }),
    })
    await toolNamed(tools, "terminal_open").execute({ command: "bash" }, {})
    expect(spy.opened).toHaveLength(1)
  })

  it("no resolver at all means no sandbox was requested, so nothing is refused", async () => {
    const spy = spyService()
    const tools = createTerminalTools({ service: spy.service })
    await toolNamed(tools, "terminal_open").execute({ command: "bash" }, {})
    expect(spy.opened).toHaveLength(1)
    // A host that requested no sandbox must not be unmounted or refused on the
    // strength of the resolver merely being absent.
    const processes = createProcessTools({ service: spy.service })
    await toolNamed(processes, "process_spawn").execute({ command: "bash" }, {})
    expect(spy.opened).toHaveLength(2)
  })

  it("the policy is resolved PER CALL, not once at construction", async () => {
    const spy = spyService()
    let mode: "danger-full-access" | "read-only" = "danger-full-access"
    const tools = createTerminalTools({ service: spy.service, sandboxPolicy: () => ({ mode, workspaceRoot: "/ws" }) })
    const open = toolNamed(tools, "terminal_open")
    await open.execute({ command: "bash" }, {})
    expect(spy.opened).toHaveLength(1)
    // The mid-session tightening. THIS is the case a mount-time decision misses.
    mode = "read-only"
    const second = (await open.execute({ command: "bash" }, {})) as Refusal
    expect(second.code).toBe("SANDBOX_DENIED")
    expect(second.denial?.surface).toBe("terminal")
    expect(spy.opened).toHaveLength(1)
  })

  it("process_spawn refuses per call too (it creates the same capability)", async () => {
    const spy = spyService()
    let mode: "danger-full-access" | "read-only" = "danger-full-access"
    const tools = createProcessTools({ service: spy.service, sandboxPolicy: () => ({ mode, workspaceRoot: "/ws" }) })
    const spawn = toolNamed(tools, "process_spawn")
    await spawn.execute({ command: "bash" }, {})
    expect(spy.opened).toHaveLength(1)
    mode = "read-only"
    const refused = (await spawn.execute({ command: "bash" }, {})) as Refusal
    expect(refused.denial?.surface).toBe("terminal")
    expect(refused.denial?.mode).toBe("read-only")
    expect(spy.opened).toHaveLength(1)
  })

  it("terminal_send refuses under a confined mode even though the PTY already exists", async () => {
    // A PTY opened under a WIDER mode is still unconfined; feeding it input is
    // still unconfined execution. The refusal names the live terminal so the
    // model can tell which handle it may not drive.
    const spy = spyService()
    let mode: "danger-full-access" | "read-only" = "danger-full-access"
    const tools = createTerminalTools({ service: spy.service, sandboxPolicy: () => ({ mode, workspaceRoot: "/ws" }) })
    const send = toolNamed(tools, "terminal_send")
    await send.execute({ id: "t1", data: "echo hi" }, {})
    expect(spy.sent).toHaveLength(1)
    mode = "read-only"
    const refused = (await send.execute({ id: "t1", data: "rm -rf /" }, {})) as Refusal
    expect(refused.code).toBe("SANDBOX_DENIED")
    expect(refused.denial?.surface).toBe("terminal")
    expect(refused.denial?.reason).toContain("t1")
    // Nothing was written to the live PTY.
    expect(spy.sent).toHaveLength(1)
  })

  it("process_kill and process_resize_pty stay allowed (shutdown / observation)", async () => {
    const spy = spyService()
    const tools = createProcessTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    })
    // Exercised, not merely mounted: resizing cannot create anything, and a
    // refusal here would leave a live PTY whose geometry the model cannot fix.
    await toolNamed(tools, "process_kill").execute({ id: "t1" }, {})
    expect(spy.signalled).toEqual([{ id: "t1", signal: "TERM" }])
    await toolNamed(tools, "process_resize_pty").execute({ id: "t1", cols: 100, rows: 40 }, {})
    expect(spy.resized).toEqual([{ id: "t1", cols: 100, rows: 40 }])
  })

  // ── The advice must WORK, not merely exist ────────────────────────────────
  //
  // A test that only asserts the denial's sentence contains a mode name passes
  // on advice that cannot be followed — which is exactly what the first version
  // of this file did: it pinned `escalation` to contain "workspace-write" for
  // read-only, while `confinement` refuses under workspace-write too, so the
  // advised retry returned the IDENTICAL denial and spawned nothing. The only
  // assertion that can catch that is to FOLLOW the advice: take the mode the
  // denial names, put it in force, retry the identical call, and require the
  // operation to be permitted and to reach the service.
  for (const startingMode of ["read-only", "workspace-write"] as const) {
    for (const call of REFUSING_CALLS) {
      it(`the advised retry succeeds: ${call.name} from ${startingMode}`, async () => {
        const spy = spyService()
        let mode: "read-only" | "workspace-write" | "danger-full-access" = startingMode
        const tools = mounted(spy, () => mode)
        const tool = toolNamed(tools, call.name)

        const refused = (await tool.execute(call.args, {})) as Refusal
        expect(refused.code, `${call.name} must refuse under ${startingMode}`).toBe("SANDBOX_DENIED")
        expect(call.reached(spy)).toBe(0)

        // The retry the denial advertises, with the mode it advertises.
        mode = advisedMode(refused.denial) as typeof mode
        const retry = (await tool.execute(call.args, {})) as Refusal
        expect(retry.code, `the advised retry to "${mode}" must NOT be refused too`).toBeUndefined()
        expect(call.reached(spy), `the advised retry to "${mode}" must reach the service`).toBe(1)
      })
    }
  }

  it("the refusal is a returned value, not a throw", async () => {
    const spy = spyService()
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    })
    await expect(toolNamed(tools, "terminal_open").execute({ command: "bash" }, {})).resolves.toBeDefined()
  })
})

// ── The escalation ladder on the terminal surface ───────────────────────────
//
// Same per-call ladder as fs and the shell, at the top of each refusing tool's
// body. TWO traps, both of which defeat the grant:
//
//  1. After a grant the confinement decision must use `resolution.policy`. A
//     fresh `deps.sandboxPolicy?.()` read returns the SESSION's mode, and
//     `danger-full-access` is exactly the mode that makes `confinement()` return
//     undefined — so re-reading would refuse the very call just approved.
//  2. The ladder's denial is returned UNCHANGED. Routing it back through
//     `terminalRefusal` would rebuild it through `denialFor(…,
//     PTY_PERMITTED_MODE)` and re-attach the escalation sentence that ladder
//     branches 1/5/6 set `escalationTarget: null` to withhold.

function approverSaying(outcome: "allowed-once" | "rejected") {
  const prompts: Array<{ toolName: string; callId: string; reason: string }> = []
  return {
    prompts,
    approver: {
      async request(req: { toolName: string; callId: string; reason: string }) {
        prompts.push({ toolName: req.toolName, callId: req.callId, reason: req.reason })
        return outcome
      },
    },
  }
}

describe("terminal escalation ladder", () => {
  for (const call of REFUSING_CALLS) {
    it(`${call.name}: a granted danger-full-access escalation opens it for THIS call`, async () => {
      const spy = spyService()
      const { approver, prompts } = approverSaying("allowed-once")
      const deps = {
        service: spy.service,
        sandboxPolicy: () => ({ mode: "read-only" as const, workspaceRoot: "/ws" }),
        escalationApprover: approver as never,
      }
      const tools = [...createTerminalTools(deps), ...createProcessTools(deps)]
      const result = (await toolNamed(tools, call.name).execute(
        { ...call.args, sandbox_permissions: "danger-full-access", justification: "the PTY cannot be confined" },
        { callId: "call-pty" },
      )) as Refusal
      expect(result.code, "a granted escalation must not be refused again").toBeUndefined()
      expect(prompts).toHaveLength(1)
      expect(prompts[0]!.toolName).toBe(call.name)
      expect(prompts[0]!.callId).toBe("call-pty")
      // The prompt names the operation, not just the mode.
      expect(prompts[0]!.reason.length).toBeGreaterThan("escalate sandbox to danger-full-access".length)
      // The real proof: the granted call REACHED the service. Under a fresh
      // re-read of the session thunk it would still be read-only and refuse.
      expect(call.reached(spy)).toBe(1)
    })

    it(`${call.name}: a refused escalation returns the ladder's own denial`, async () => {
      const spy = spyService()
      const { approver } = approverSaying("rejected")
      const deps = {
        service: spy.service,
        sandboxPolicy: () => ({ mode: "read-only" as const, workspaceRoot: "/ws" }),
        escalationApprover: approver as never,
      }
      const tools = [...createTerminalTools(deps), ...createProcessTools(deps)]
      const result = (await toolNamed(tools, call.name).execute(
        { ...call.args, sandbox_permissions: "danger-full-access", justification: "please" },
        {},
      )) as Refusal
      expect(result.denial?.code).toBe("SANDBOX_DENIED")
      expect(result.denial?.surface).toBe("terminal")
      expect(result.denial?.mode).toBe("read-only")
      expect(result.denial?.reason).toMatch(/rejected/)
      // §3.2 corollary 2 -- the REQUEST was refused, so no escalation sentence
      // may be re-attached by `terminalRefusal`'s rebuild path.
      expect(result.denial?.escalation).toBeUndefined()
      expect(result.error).not.toContain("sandbox_permissions")
      expect(call.reached(spy)).toBe(0)
    })
  }

  it("a malformed escalation pair is refused without asking anyone", async () => {
    const spy = spyService()
    const { approver, prompts } = approverSaying("allowed-once")
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
      escalationApprover: approver as never,
    })
    const result = (await toolNamed(tools, "terminal_open").execute(
      { command: "bash", sandbox_permissions: "danger-full-access" },
      {},
    )) as Refusal
    expect(result.denial?.reason).toMatch(/justification/)
    expect(result.denial?.escalation).toBeUndefined()
    expect(prompts).toHaveLength(0)
    expect(spy.opened).toHaveLength(0)
  })

  it("the operation refusal still carries its hint when no escalation was requested", async () => {
    // The other direction, so the ladder's arrival cannot silently strip the
    // guidance an ordinary confined refusal must keep (Task 4's fix).
    const spy = spyService()
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
      escalationApprover: approverSaying("allowed-once").approver as never,
    })
    const result = (await toolNamed(tools, "terminal_open").execute({ command: "bash" }, {})) as Refusal
    expect(advisedMode(result.denial)).toBe("danger-full-access")
    expect(spy.opened).toHaveLength(0)
  })

  it("observation and shutdown tools stay allowed and never consult the ladder", async () => {
    const spy = spyService()
    const { approver, prompts } = approverSaying("allowed-once")
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
      escalationApprover: approver as never,
    })
    await toolNamed(tools, "terminal_read").execute({ id: "t1", sandbox_permissions: "danger-full-access", justification: "x" }, {})
    expect(spy.reads).toHaveLength(1)
    expect(prompts).toHaveLength(0)
  })
})
