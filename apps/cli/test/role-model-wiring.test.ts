import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The CLI's ROLE-MODEL WIRING (`agents.roles.<name>` + `plugins.subagentModel`).
 *
 * `main` is the layer where "the seam exists" and "it is supplied" came apart
 * twice in this repo's history — M11's compaction config and M62's sandbox mode
 * both existed on `HeadlessOptions` and were set by nobody, so the feature was
 * dead on every shipped path while every unit test of the seam passed. These
 * cases assert on the options `main` actually builds, by mocking `run.ts` the
 * way that defect's test does.
 *
 * What this does NOT prove: that a role's selection is resolved at spawn time
 * rather than captured here. The getter's body is a store read
 * (`roleModelOptionsFor`), which the "read it live" rule rests on and the
 * subagent/session-executor suites exercise end to end.
 */
const captured: Array<Record<string, unknown>> = []

vi.mock("../src/run.ts", () => ({
  runHeadless: async (_task: string, opts: Record<string, unknown>) => {
    captured.push(opts)
    return { finalText: "ok", exitCode: 0 }
  },
}))

const { main } = await import("../src/index.ts")

let configDir: string
let previous: string | undefined

beforeEach(() => {
  captured.length = 0
  configDir = mkdtempSync(join(tmpdir(), "i-harness-role-model-wiring-"))
  previous = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = configDir
  // main() prints; keep the output out of the report.
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previous === undefined) delete process.env.IH_CONFIG_DIR
  else process.env.IH_CONFIG_DIR = previous
  rmSync(configDir, { recursive: true, force: true })
})

type RoleSelection = { provider: string; model: string; [k: string]: unknown }

describe("the CLI supplies the sub-agent role-model options", () => {
  it("with no settings file: switch OFF, and no role is declared", async () => {
    await main(["node", "i-harness", "run", "hello"])

    expect(captured).toHaveLength(1)
    const opts = captured[0]!
    // `plugins.subagentModel` defaults to false — the shipped path must not
    // enable it by omission.
    expect(opts.allowSubagentModelSelection).toBe(false)
    const get = opts.roleSelectionFor as (roleName: string) => RoleSelection | undefined
    expect(typeof get).toBe("function")
    expect(get("worker")).toBeUndefined()
  }, 30_000)

  it("reads agents.roles + plugins.subagentModel from the store main() loaded", async () => {
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({
        plugins: { subagentModel: true },
        agents: { roles: { worker: { provider: "gw", model: "small", reasoningEffort: "low" } } },
      }),
      "utf8",
    )

    await main(["node", "i-harness", "run", "hello"])

    expect(captured).toHaveLength(1)
    const opts = captured[0]!
    expect(opts.allowSubagentModelSelection).toBe(true)
    const get = opts.roleSelectionFor as (roleName: string) => RoleSelection | undefined
    // The operator's file is what the getter answers with — an UNLOADED store
    // would answer the defaults, which is the M62 sandbox trap.
    expect(get("worker")).toEqual({ provider: "gw", model: "small", reasoningEffort: "low" })
    expect(get("general")).toBeUndefined()
  }, 30_000)
})
