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
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const code = await main(["node", "i-harness", "run", "--help"])
      expect(calls).toHaveLength(0)
      expect(code).toBe(1)
      // The HUMAN RULING is ENFORCED here, not merely documented: `--help` after
      // `run` is an unrecognised flag, not a help request, and must never become
      // a second help contract. A contributor who adds the natural run-path
      // `--help` branch (print usage, exit 0) fails the first two assertions; one
      // who exits non-zero with different output fails this one.
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("unknown flag --help")
    } finally {
      err.mockRestore()
    }
  })

  it("refuses a stray flag in any position", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const code = await main(["node", "i-harness", "run", "hello", "--nope"])
      expect(calls).toHaveLength(0)
      expect(code).toBe(1)
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("unknown flag --nope")
    } finally {
      err.mockRestore()
    }
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

  it("value-skip control: a value that is ITSELF dash-leading is consumed, not rejected", async () => {
    // The guard's `RUN_VALUE_FLAGS.has(runArgs[i - 1])` skip clause is pinned by
    // THIS case and by nothing else: the sibling control above passes even with
    // that clause deleted, because `read-only` has no leading dash. `-x` does, so
    // without the clause the loop reads it as a stray flag and returns 1 with no
    // call at all. (The class is likewise NOT pinned by `--model -x`: that argv
    // returns 1 at the `--model requires --api-key KEY` gate in BOTH states, so
    // only an added stderr assertion could tell them apart.)
    await main(["node", "i-harness", "run", "hello", "--api-key", "-x"])
    expect(calls.map((c) => c.task)).toEqual(["hello"])
  })

  it("declared narrowing: dash-leading task tokens are reserved, with no `--` escape hatch", async () => {
    // This test exists so the narrowing is INTENTIONAL and visible rather than an
    // accident of the guard. Task 6 declares it in the baseline's grammar
    // statement. `-40 degrees` is a legitimate-looking prompt the router now
    // refuses, and `--` is NOT an end-of-flags separator here -- adding one is
    // new argv grammar (M-shaped, own spec), not a router fix.
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const quoted = await main(["node", "i-harness", "run", "-40 degrees"])
      expect(quoted).toBe(1)
      expect(calls).toHaveLength(0)
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("unknown flag -40 degrees")

      err.mockClear()
      const separator = await main(["node", "i-harness", "run", "hello", "--"])
      expect(separator).toBe(1)
      expect(calls).toHaveLength(0)
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("unknown flag --")
    } finally {
      err.mockRestore()
    }
  })
})
