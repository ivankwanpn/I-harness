// M59 (grok parity): the THREE-STOP Shift+Tab rotation — normal → plan →
// always-approve → normal. Plan drives the engine's log-only mode; the third
// stop flips the runtime permission stance through the host seam (the same one
// /always-approve and /auto drive). Before M59 the cycle was Normal↔Plan only
// and the approval commands were hidden + a not-wired toast.
import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp, createScrollbackEngine } from "../src/index.ts"
import { unsupportedSessionManagement } from "./backend-stub.ts"
import type { BackendClient, TuiEvent } from "../src/contracts.ts"
import { approvalCommands } from "../src/app/slash/impl/approval.ts"
import type { SlashContext } from "../src/app/slash/types.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }

function stubBackend(): BackendClient {
  return {
    ...unsupportedSessionManagement,
    listSessions: async () => [],
    open: async () => {},
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    events: async function* (): AsyncIterable<TuiEvent> {},
    seqCursor: () => 0,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
  }
}

function makeApp(setAlwaysApprove?: (on: boolean) => void): TuiApp {
  return new TuiApp({
    renderer: createRenderer({ cols: 80, rows: 24, cap }),
    backend: stubBackend(),
    engine: createScrollbackEngine({ width: 80 }),
    capabilities: cap,
    palette: resolvePalette(cap, "groknight"),
    glyphs: GLYPHS,
    write: () => {},
    now: () => 0,
    ...(setAlwaysApprove !== undefined ? { setAlwaysApprove } : {}),
  })
}

describe("Shift+Tab mode cycle (M59 third stop)", () => {
  it("cycles normal → plan → always-approve → normal and reports both flags", () => {
    const stances: boolean[] = []
    const app = makeApp((on) => stances.push(on))
    const st = app.state()
    expect(st.mode).toBe("normal")

    app.dispatch("cycle-mode")
    expect(st.mode).toBe("plan")
    expect(st.prompt.plan).toBe(true)
    expect(st.prompt.alwaysApprove).toBe(false)

    app.dispatch("cycle-mode")
    expect(st.mode).toBe("always-approve")
    expect(st.prompt.plan).toBe(false)
    expect(st.prompt.alwaysApprove).toBe(true)
    expect(stances).toEqual([true])

    app.dispatch("cycle-mode")
    expect(st.mode).toBe("normal")
    expect(st.prompt.alwaysApprove).toBe(false)
    expect(stances).toEqual([true, false])
  })

  it("an unwired host leaves the stance honest (no seam call, still cycles)", () => {
    const app = makeApp()
    app.dispatch("cycle-mode") // plan
    app.dispatch("cycle-mode") // always-approve
    expect(app.state().prompt.alwaysApprove).toBe(true)
    app.dispatch("cycle-mode")
    expect(app.state().mode).toBe("normal")
  })
})

describe("/always-approve + /auto drive the same stance seam", () => {
  const ctxOf = (calls: boolean[], wired: boolean): SlashContext =>
    ({
      arg: "",
      toast: () => {},
      ...(wired ? { setAlwaysApprove: (on: boolean) => calls.push(on) } : {}),
    }) as unknown as SlashContext

  it("both commands flip the stance on when the seam is wired", () => {
    for (const cmd of approvalCommands) {
      const calls: boolean[] = []
      cmd.run(ctxOf(calls, true))
      expect(calls, cmd.name).toEqual([true])
    }
  })

  it("without the seam the command refuses to fake it (no call, honest toast)", () => {
    const calls: boolean[] = []
    for (const cmd of approvalCommands) {
      cmd.run(ctxOf(calls, false))
    }
    expect(calls).toEqual([])
  })
})
