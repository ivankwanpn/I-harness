import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { PROVIDER_PROTOCOLS } from "../src/provider.ts"

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

  // ── `--protocol P` (protocol-selection §4.3, phase B task 5) ────────────────
  // A VALUE-TAKING flag, which is why it exercises BOTH chains of the strip
  // list: the token itself, and the token after it. Missing the first leaks
  // `--protocol` into the prompt (exactly the `--no-compact` defect at the head
  // of this file); missing the second leaks `gemini`.
  it("--protocol is routed away from the task, and rides THIS session's resolution only", async () => {
    const settingsPath = join(configDir, "settings.json")
    writeFileSync(
      settingsPath,
      JSON.stringify({ llm: { defaultModel: { provider: "gw", model: "m" } } }, null, 2) + "\n",
      "utf8",
    )
    const before = readFileSync(settingsPath)

    const code = await main(["node", "i-harness", "run", "do x", "--protocol", "gemini"])

    expect(code).toBe(0)
    // Half (a): the router. Neither the flag nor its value is part of the task.
    expect(calls.map((c) => c.task)).toEqual(["do x"])
    // Half (a), second hop: the protocol reaches the resolution run.ts performs.
    // It is composed with the layer the chain would otherwise use
    // (`llm.defaultModel`) because a protocol has nowhere to ride without a
    // provider:model under it — and run.ts layers it over a resumed session's
    // durable selection, the protocol being the most specific rung of
    // selection > model row > route.
    expect(calls[0]!.opts.sessionSelection).toEqual({ provider: "gw", model: "m", protocol: "gemini" })
    // Half (b), §4.3 — BYTE-IDENTICAL, not merely "the same JSON": the one-shot
    // protocol is written to no file, so the operator's document must come out
    // exactly as it went in.
    expect(readFileSync(settingsPath).equals(before)).toBe(true)
  })

  it("refuses an unknown protocol and names the five", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const code = await main(["node", "i-harness", "run", "do x", "--protocol", "gpt-9"])
      expect(code).toBe(1)
      expect(calls).toHaveLength(0)
      // `provider add`'s refusal verbatim, and the SET named by content. The
      // value is validated OUTSIDE the settings chain on purpose: the settings
      // normalizer FILLS IN a default, which is the silent tail phase A removed.
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(
        `unknown protocol "gpt-9"; expected one of: ${PROVIDER_PROTOCOLS.join(" | ")}`,
      )
    } finally {
      err.mockRestore()
    }
  })

  it("refuses --protocol with no value instead of treating the next token as one", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const code = await main(["node", "i-harness", "run", "do x", "--protocol"])
      expect(code).toBe(1)
      expect(calls).toHaveLength(0)
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(
        `--protocol requires one of: ${PROVIDER_PROTOCOLS.join(" | ")}`,
      )
    } finally {
      err.mockRestore()
    }
  })

  it("refuses --protocol combined with --model rather than dropping the protocol", async () => {
    // `--model` builds its client from the flag's own route and never enters the
    // settings chain, so there is no selection for the protocol to ride. The
    // combination is REFUSED, loudly: accepting it would be the silent drop this
    // whole design removed.
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const code = await main(["node", "i-harness", "run", "do x", "--model", "deepseek:deepseek-chat", "--api-key", "sk-x", "--protocol", "gemini"])
      expect(code).toBe(1)
      expect(calls).toHaveLength(0)
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("--protocol cannot be combined with --model")
    } finally {
      err.mockRestore()
    }
  })

  it("advertises the flag in the usage it prints, and that it excludes --model", async () => {
    // The clause is the point (review F5): a reader who trusts the usage must
    // not have to meet the refusal to learn the two flags are exclusive.
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await main(["node", "i-harness", "help"])
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("[--protocol P (not with --model)]")
    } finally {
      err.mockRestore()
    }
  })
})
