import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

// ── B1 (block ③): the tool-output bound on the `sdk` and `acp` hosts ─────────
// The guard is mounted by the CALL SITE, not by the assembly (`assembly.ts`:
// `if (opts.outputSpill)` — absent means not mounted). `runHeadless` opts in
// (`run.ts`: `outputSpill: opts.outputSpill ?? {}`), and that was the ONLY
// opt-in in the tree, so the two hosts that build their assemblies through
// `createSessionService` — `i-harness sdk` and `i-harness acp` — ran with
// unbounded tool output (recorded as B1 in
// docs/handoff/2026-09-20-m5-t4-block3-output-bound.md).
//
// THIS test pins the ROUTING half only: the option the CLI hands its service.
// The behavior half (a service-built assembly really bounds an over-cap tool
// result, and mounts nothing when the option is absent) lives in
// packages/session-executor/test/service-output-spill.test.ts — the same split
// run-flag-routing.test.ts uses for the run path (the CLI pins routing, the
// assembly layer pins behavior; a mount changed here and not there still fails
// one of the two).
//
// The mock OBSERVES without altering: it records the options index.ts passes
// and returns the REAL service (the M23 coordinatorFactoryCalls pattern in
// cli.test.ts), so every other behavior of the command is unchanged.
const serviceCalls = vi.hoisted(() => ({ list: [] as Record<string, unknown>[] }))
vi.mock("@i-harness/session-executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@i-harness/session-executor")>()
  const real = actual.createSessionService as unknown as (opts: Record<string, unknown>) => unknown
  return {
    ...actual,
    createSessionService: (opts: Record<string, unknown>) => {
      serviceCalls.list.push(opts)
      return real(opts)
    },
  }
})

const { main } = await import("../src/index.ts")

let configDir: string
let previousConfigDir: string | undefined
let previousStdin: PropertyDescriptor | undefined

beforeEach(() => {
  serviceCalls.list.length = 0
  // Hermetic config home (run-flag-routing.test.ts:20-30): an empty config dir
  // is what keeps the provider runtime from resolving a real endpoint.
  configDir = mkdtempSync(join(tmpdir(), "i-harness-host-spill-"))
  previousConfigDir = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = configDir
  // Both commands live on stdin until the client ends it. The test supplies an
  // ALREADY-ENDED stdin so the server starts its real loop, builds its real
  // service, and then closes — no fabricated transport, just EOF.
  previousStdin = Object.getOwnPropertyDescriptor(process, "stdin")
  Object.defineProperty(process, "stdin", { value: Readable.from([]), configurable: true, writable: true })
})

afterEach(() => {
  if (previousStdin !== undefined) Object.defineProperty(process, "stdin", previousStdin)
  if (previousConfigDir === undefined) delete process.env.IH_CONFIG_DIR
  else process.env.IH_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe("the sdk and acp hosts bound their tool output by default", () => {
  it("main() opts the sdk command's service into the spill guard", async () => {
    expect(await main(["node", "i-harness", "sdk"])).toBe(0)
    expect(serviceCalls.list).toHaveLength(1)
    // `{}` is the opt-in, not a config: `if (opts.outputSpill)` is truthy and
    // the guard's SHIPPED defaults (64,000 B, <tmpdir>/i-harness-spill) apply —
    // the same shape runHeadless passes (`opts.outputSpill ?? {}`).
    expect(serviceCalls.list[0]!.outputSpill).toEqual({})
  })

  it("main() opts the acp command's service into the spill guard", async () => {
    expect(await main(["node", "i-harness", "acp"])).toBe(0)
    expect(serviceCalls.list).toHaveLength(1)
    expect(serviceCalls.list[0]!.outputSpill).toEqual({})
  })
})
