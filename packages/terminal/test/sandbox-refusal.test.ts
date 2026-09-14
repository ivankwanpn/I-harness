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
  let lists = 0
  const service = {
    open: (spec: Record<string, unknown>) => {
      opened.push(spec)
      return { id: "t1", pid: 1, cols: 80, rows: 24 }
    },
    send: (id: string, data: string) => {
      sent.push({ id, data })
      return { id, sentChars: data.length }
    },
    signal: (id: string, signal: string) => {
      signalled.push({ id, signal })
      return { id, status: "signalled" }
    },
    close: (id: string) => {
      closed.push(id)
      return { id, status: "closed" }
    },
    list: () => {
      lists += 1
      return []
    },
  } as unknown as TerminalService
  return { service, opened, sent, signalled, closed, listCount: () => lists }
}

/** The refusal as a MODEL sees it — fields read off the returned object. */
type Refusal = { error?: string; code?: string; denial?: { code: string; surface: string; mode: string; reason: string; escalation?: string } }

function toolNamed(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name)
  expect(tool, `${name} must still be mounted`).toBeDefined()
  return tool!
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
    // The escalation guidance is what keeps the refusal actionable: read-only has
    // strictly wider modes, so `denialFor` attaches the retry route. (This is the
    // shell's "no backend exists" case inverted — there the guidance is ABSENT
    // because asking for a wider mode cannot help; here it can.)
    expect(result.denial?.escalation).toContain("workspace-write")
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
    // From workspace-write the only wider mode is danger-full-access.
    expect(result.denial?.escalation).toContain("danger-full-access")
    expect(spy.opened).toHaveLength(0)
  })

  it("observation and shutdown stay allowed under a confined mode", async () => {
    const spy = spyService()
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    })
    // These can only observe or SHUT DOWN. Refusing them would strand live PTYs
    // opened under a wider mode with no way to close them.
    for (const name of ["terminal_read", "terminal_list", "terminal_close", "terminal_signal"]) {
      toolNamed(tools, name)
    }
    await toolNamed(tools, "terminal_list").execute({}, {})
    expect(spy.listCount()).toBe(1)
    // Not just mounted — they still REACH the service.
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
    await toolNamed(tools, "process_kill").execute({ id: "t1" }, {})
    expect(spy.signalled).toEqual([{ id: "t1", signal: "TERM" }])
  })

  it("the refusal is a returned value, not a throw", async () => {
    const spy = spyService()
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    })
    await expect(toolNamed(tools, "terminal_open").execute({ command: "bash" }, {})).resolves.toBeDefined()
  })
})
