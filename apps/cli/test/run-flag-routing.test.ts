import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

/**
 * `i-harness run` ARGUMENT ROUTING — the router that turns argv into a prompt.
 *
 * Two measured defects live here. (a) `--help` after `run` survives the task
 * filter and reaches `runHeadless` as a real turn whose prompt is `"--help"`.
 * (b) `--no-compact` is parsed as a run flag but is absent from the strip list,
 * so `i-harness run "do x" --no-compact` sends the model `do x --no-compact`.
 *
 * The seam is the one `compaction-wiring.test.ts:23-32` introduced, with one
 * difference that matters: this mock CAPTURES THE TASK. That file's
 * `runHeadless: async (_task: string, opts…)` discards it, which is measurably
 * why nothing today can catch either defect — the prompt never reaches an
 * assertion.
 *
 * HERMETIC CONFIG HOME (pre-flight ruling R-B): a mock of `run.ts` is NOT
 * isolation on its own. `main()` on the run path loads the SettingsStore (and,
 * before the guard below existed, could reach the model binding) from the
 * developer's REAL configuration, so a stray code path on a developer machine
 * with a provider configured could start a real turn and spend real tokens.
 * Every test therefore pins `IH_CONFIG_DIR` to a fresh empty temp directory
 * before `main` is invoked — the pattern at `e2e/helpers.ts:28-42`, whose
 * comment says the empty config dir is exactly what stops the "no configured
 * model" gate from starting a real turn.
 */
const calls: { task: string; opts: Record<string, unknown> }[] = []

vi.mock("../src/run.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/run.ts")>()
  return {
    ...actual,
    runHeadless: async (task: string, opts: Record<string, unknown>) => {
      calls.push({ task, opts })
      return { finalText: "", exitCode: 0 }
    },
  }
})

const { main } = await import("../src/index.ts")

let configDir: string
let previous: string | undefined

beforeEach(() => {
  calls.length = 0
  // Set BEFORE `main` is invoked, not merely before the import above: the
  // settings path chain resolves `$IH_CONFIG_DIR` per call (see
  // packages/settings/src/index.ts:705), so a per-call pin is sufficient —
  // and this ordering is the one that actually holds the run path hermetic.
  configDir = mkdtempSync(join(tmpdir(), "i-harness-run-flag-routing-"))
  previous = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = configDir
})

afterEach(() => {
  if (previous === undefined) delete process.env.IH_CONFIG_DIR
  else process.env.IH_CONFIG_DIR = previous
  rmSync(configDir, { recursive: true, force: true })
})

describe("run argv routing", () => {
  it("refuses a stray flag instead of sending it as the prompt", async () => {
    const code = await main(["node", "i-harness", "run", "--help"])
    expect(calls).toHaveLength(0)
    expect(code).toBe(1)
  })

  it("refuses a stray flag in any position", async () => {
    const code = await main(["node", "i-harness", "run", "hello", "--nope"])
    expect(calls).toHaveLength(0)
    expect(code).toBe(1)
  })

  it("does not leak --no-compact into the prompt", async () => {
    await main(["node", "i-harness", "run", "hello", "--no-compact"])
    expect(calls.map((c) => c.task)).toEqual(["hello"])
  })

  it("negative control: a flag-shaped word inside a quoted prompt is still the task", async () => {
    await main(["node", "i-harness", "run", "explain the --help flag"])
    expect(calls.map((c) => c.task)).toEqual(["explain the --help flag"])
  })

  it("value-skip control: a known value-taking flag consumes its value", async () => {
    await main(["node", "i-harness", "run", "hello", "--sandbox", "read-only"])
    expect(calls.map((c) => c.task)).toEqual(["hello"])
  })
})
