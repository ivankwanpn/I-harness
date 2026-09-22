import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The CLI's COMPACTION WIRING, which is where the defect actually lived.
 *
 * `HeadlessOptions.compact` existed and `runHeadless` would have threaded it
 * correctly, but `main`'s option object in `apps/cli/src/index.ts` carried
 * workspace/approveAll/modelPolicy/sandbox and never `compact`. So on every
 * shipped path the engine was never constructed: pressure never triggered a
 * summary, `/compact` answered "No compactable history yet.", and the three-layer
 * budget ladder ran with its first layer dead — long sessions fell through to the
 * fail-closed `prompt_too_long`.
 *
 * An earlier attempt at this test called `runHeadless` directly with its own
 * `compact` argument. A mutation that removed the field from `main` left it
 * GREEN, because it never went through the layer under test — the same "looks
 * verified but verifies nothing" failure this audit exists to catch. This file
 * mocks `run.ts` so the assertions land on the options `main` actually builds.
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
  configDir = mkdtempSync(join(tmpdir(), "i-harness-compaction-wiring-"))
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

describe("M11 CLI compaction wiring", () => {
  it("main() supplies compact to runHeadless, so the engine can be constructed at all", async () => {
    // RED before the fix: no `compact` key reached runHeadless, so the agent had
    // no compaction seam and nothing downstream could ever compact.
    await main(["node", "i-harness", "run", "hello"])
    expect(captured).toHaveLength(1)
    expect(captured[0]).toHaveProperty("compact")
    expect((captured[0]!.compact as { auto: boolean }).auto).toBe(true)
  })

  it("--no-compact turns AUTO compaction off while still supplying the config", async () => {
    // "Off" must be expressible. Dropping the config entirely would also disable
    // the MANUAL /compact surface, which is a different thing from turning off
    // the automatic pressure trigger.
    await main(["node", "i-harness", "run", "hello", "--no-compact"])
    expect(captured).toHaveLength(1)
    expect((captured[0]!.compact as { auto: boolean }).auto).toBe(false)
  })

  it("the operator's compaction.auto setting is honoured when no flag is given", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ compaction: { auto: false } }), "utf8")
    await main(["node", "i-harness", "run", "hello"])
    expect(captured).toHaveLength(1)
    // The trap this catches is the one the web sandbox fix hit: an UNLOADED
    // SettingsStore answers get() with DEFAULTS, so reading before load() would
    // silently ignore the operator's file and report `true` here.
    expect((captured[0]!.compact as { auto: boolean }).auto).toBe(false)
  })

  it("an explicit flag wins over the setting", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ compaction: { auto: false } }), "utf8")
    await main(["node", "i-harness", "run", "hello", "--no-compact"])
    expect((captured[0]!.compact as { auto: boolean }).auto).toBe(false)
  })
})
