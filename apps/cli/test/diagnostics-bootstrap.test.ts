import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { currentDiagnostics, diagnosticsFor, type Diagnostics } from "@i-harness/diagnostics"
import { createCredentialStore } from "@i-harness/credentials"
import { SettingsStore } from "@i-harness/settings"

// ── W6 task 4: the CLI's diagnostics bootstrap ───────────────────────────────
//
// WHAT THIS FILE PROVES, and where each half is pinned:
//
//   ROUTING (through the real entries): the three host entries — `run`, `sdk`,
//   `acp` — install an instance, feed the redactor's second source from the
//   credential store `loadProviderRuntime()` returns, and close on every exit.
//   The entries are driven through `main()`, so the pin is on the shipped path
//   and not on a re-assembly of it (`host-output-spill.test.ts`'s split).
//
//   BEHAVIOR (on the bootstrap directly): the env scan's boundary (name regex +
//   §3.5's ≥8 floor), the declared-refs half, and the late feed `run.ts` uses.
//
//   BYTE IDENTITY (`I_HARNESS_LOG` unset): a call through the installed instance
//   is the SAME console call as today — same function, one verbatim argument.
//   That is the property the other 30 test files' 95 console assertions guard;
//   this file pins the mechanism where the CLI's own instance is in the slot.
//
// TWO SEAMS ARE OBSERVED, NEVER ALTERED (the `importOriginal` + delegate pattern
// this suite already uses): the bootstrap (its calls are recorded, the real
// functions run) and session-executor's `createSessionService` (recorded, and
// used to capture what is installed at the moment a host builds its service).
const bootstrapLog = vi.hoisted(() => ({ log: [] as unknown[][] }))
vi.mock("../src/diagnostics-bootstrap.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/diagnostics-bootstrap.ts")>()
  return {
    ...actual,
    createCliDiagnostics: (opts?: Parameters<typeof actual.createCliDiagnostics>[0]) => {
      bootstrapLog.log.push(["create", opts])
      return actual.createCliDiagnostics(opts)
    },
    registerCliSecrets: (...args: Parameters<typeof actual.registerCliSecrets>) => {
      bootstrapLog.log.push(["feed", ...args])
      return actual.registerCliSecrets(...args)
    },
  }
})

const serviceCalls = vi.hoisted(() => ({ list: [] as { installed: unknown }[] }))
vi.mock("@i-harness/session-executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@i-harness/session-executor")>()
  const { currentDiagnostics: current } = await import("@i-harness/diagnostics")
  const real = actual.createSessionService as unknown as (opts: Record<string, unknown>) => unknown
  return {
    ...actual,
    createSessionService: (opts: Record<string, unknown>) => {
      // Observed where a host's service is built: whatever the entry installed
      // is in the slot by this call, or nothing is.
      serviceCalls.list.push({ installed: current() })
      return real(opts)
    },
  }
})

const { main } = await import("../src/index.ts")
const { createCliDiagnostics, registerCliSecrets } = await import("../src/diagnostics-bootstrap.ts")

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The built-in `deepseek` profile is openai-compatible, so a `--model` run
 *  posts to `<baseURL>/v1/chat/completions` and reads SSE. Both cases below stub
 *  `fetch` — the network is never touched — with the one response they need. */
const SSE_OK = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`

/** What actually reaches stderr. The logger's `stderr` sink calls
 *  `process.stderr.write` PER RECORD (resolved per write, not captured at
 *  construction), so a spy installed before an entry runs sees every record. */
function captureStderr(): { lines: () => string[]; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as never)
  return {
    lines: () => chunks.join("").split("\n").filter((line) => line !== ""),
    restore: () => spy.mockRestore(),
  }
}

/**
 * The two halves of "`close()` was reached", and why both are needed:
 *
 *   - `currentDiagnostics()` back to undefined means the instance is DETACHED —
 *     which the uninstaller also achieves, so on its own it says nothing about
 *     `close()`;
 *   - a CLOSED handle takes no further records (`closed` is set by `close()`
 *     alone). A handle that still writes after the entry returned is a
 *     slot-only teardown: the sink was never released.
 *
 * Requires `I_HARNESS_LOG=stderr`: an instance with NO sink delegates to the
 * console even after close (the byte-identity property T1 pinned), so `closed`
 * is only observable on a structured instance.
 */
function expectClosed(captured: Diagnostics | undefined, stderr: { lines: () => string[] }): void {
  expect(currentDiagnostics()).toBeUndefined()
  expect(captured).toBeDefined()
  const before = stderr.lines().length
  captured!.warn("[after the entry returned]")
  expect(stderr.lines()).toHaveLength(before)
}

let configDir: string
let previousConfigDir: string | undefined
let previousLog: string | undefined
let previousStdin: PropertyDescriptor | undefined
const envSet: string[] = []

beforeEach(() => {
  bootstrapLog.log.length = 0
  serviceCalls.list.length = 0
  // Hermetic config home (the pattern run-flag-routing.test.ts documents): an
  // EMPTY temp config dir is what keeps a run from resolving a real provider and
  // spending real tokens, and it is what makes `run hello` fail at the model
  // resolution for a reason this file can name.
  configDir = mkdtempSync(join(tmpdir(), "ih-diag-bootstrap-"))
  previousConfigDir = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = configDir
  // UNSET by default: the byte-identity case is the default state, and every
  // case that wants the structured channel sets it itself.
  previousLog = process.env.I_HARNESS_LOG
  delete process.env.I_HARNESS_LOG
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (previousStdin !== undefined) {
    Object.defineProperty(process, "stdin", previousStdin)
    previousStdin = undefined
  }
  for (const name of envSet.splice(0)) delete process.env[name]
  if (previousConfigDir === undefined) delete process.env.IH_CONFIG_DIR
  else process.env.IH_CONFIG_DIR = previousConfigDir
  if (previousLog === undefined) delete process.env.I_HARNESS_LOG
  else process.env.I_HARNESS_LOG = previousLog
  rmSync(configDir, { recursive: true, force: true })
})

/** Set a variable for one case (restored in afterEach). `process.env.X =
 *  undefined` would store the STRING "undefined", so the delete is explicit. */
function setEnv(name: string, value: string): void {
  process.env[name] = value
  envSet.push(name)
}

describe("the CLI's diagnostics bootstrap", () => {
  // ── ① byte identity, with an instance actually installed ───────────────────
  it("① I_HARNESS_LOG unset: an instance IS installed, and a site's call is today's console call byte for byte", async () => {
    const stderr = captureStderr()
    let installedAtTheFailureSite: boolean | undefined
    const err = vi.spyOn(console, "error").mockImplementation(() => {
      // A STAND-IN for the sites T5 migrates: a real run's failure-report
      // moment, driven through the ambient path exactly as a migrated site will
      // be (`diagnosticsFor(phase)` + one verbatim message). No site is migrated
      // in this task — that is T5's and T6's.
      installedAtTheFailureSite = currentDiagnostics() !== undefined
      diagnosticsFor("run").warn("[stand-in] a message a human reads today")
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const code = await main(["node", "i-harness", "run", "hello"])
      // The run fails at the model resolution (empty config home) — exit 1, and
      // the failure report is what puts us at the console call above.
      expect(code).toBe(1)
      expect(installedAtTheFailureSite).toBe(true)
      // THE PROPERTY: the SAME function, called with ONE argument, verbatim.
      expect(warn.mock.calls).toEqual([["[stand-in] a message a human reads today"]])
      // ... and nothing structured anywhere: no sink means no record.
      expect(stderr.lines()).toEqual([])
      // The un-migrated report keeps its own shape (one string, the M3 headline)
      // — the shape the suite's existing text assertions compare against.
      expect(err.mock.calls[0]).toHaveLength(1)
      expect(String(err.mock.calls[0]![0])).toContain("i-harness run did not finish")
    } finally {
      err.mockRestore()
      warn.mockRestore()
      stderr.restore()
    }
  })

  // ── ② the structured channel, on the run path ─────────────────────────────
  it("② I_HARNESS_LOG=stderr: a site's record is the FIRST thing on stderr, phased, with the minted uuid", async () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    const err = vi.spyOn(console, "error").mockImplementation(() => {
      diagnosticsFor("run").warn("[stand-in] going to the record")
    })
    try {
      const code = await main(["node", "i-harness", "run", "hello"])
      expect(code).toBe(1)
      const lines = stderr.lines()
      // FIRST and ONLY: neither the install nor the run wrote anything else, so
      // the record is the first line a reader would see.
      expect(lines).toHaveLength(1)
      const record = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(record).toMatchObject({ level: "warn", phase: "run", msg: "[stand-in] going to the record" })
      // `run` is the uuid the ENTRY minted (nothing in the tree had one to lend).
      expect(String(record.run)).toMatch(UUID_RE)
      expect(typeof record.ts).toBe("number")
    } finally {
      err.mockRestore()
      stderr.restore()
    }
  })

  // ── ③④⑥ the registered set: the env scan, its boundary, and what it misses ─
  it("③ an env secret (≥8 chars, credential-shaped NAME) is masked in `data` AND in `err.message`", () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    // `probe` is not a secret-looking KEY (so scan ① cannot mask the value) and
    // `corp-abc123` matches no credential SHAPE — the registered set is the only
    // rule that can catch it, which is exactly what this case must prove.
    const boot = createCliDiagnostics({ env: { CORP_TOKEN: "corp-abc123" } })
    try {
      boot.diagnostics.warn("request failed", { probe: "corp-abc123", kept: "unchanged" }, new Error("upstream echoed corp-abc123"))
      const record = JSON.parse(stderr.lines()[0]!) as Record<string, unknown>
      expect((record.data as Record<string, unknown>).probe).toBe("[REDACTED]")
      expect((record.data as Record<string, unknown>).kept).toBe("unchanged")
      expect((record.err as { message: string }).message).toContain("[REDACTED]")
      expect((record.err as { message: string }).message).not.toContain("corp-abc123")
    } finally {
      boot.diagnostics.close()
      boot.uninstall()
      stderr.restore()
    }
  })

  it("④ the ≥8 floor: an 8+ char named value registers, a 7-char one does not", () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    const boot = createCliDiagnostics({ env: { LONG_TOKEN: "abcdefgh", SHORT_TOKEN: "abc1234" } })
    try {
      boot.diagnostics.warn("probe", { long: "abcdefgh", short: "abc1234" })
      const data = (JSON.parse(stderr.lines()[0]!) as { data: Record<string, unknown> }).data
      expect(data.long).toBe("[REDACTED]")
      // 7 characters is below the floor, so it is not a secret this set holds.
      // NOTE (honest): the enforcement is the redactor's own MIN_SECRET_LENGTH —
      // the bootstrap's filter states the scan's contract, it does not create it.
      expect(data.short).toBe("abc1234")
    } finally {
      boot.diagnostics.close()
      boot.uninstall()
      stderr.restore()
    }
  })

  it("⑥ a name OUTSIDE the scan's regex is not scanned — measured by T3, not widened here", () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    // `*_WEBHOOK` and `*_URL` carry credentials in the wild and fall outside
    // /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i. This case pins the
    // scan's actual reach: the set is auditable, not guessed at.
    const boot = createCliDiagnostics({ env: { CORP_WEBHOOK: "hook-secret-abcdef", CORP_URL: "https://gw.example/abcdef" } })
    try {
      boot.diagnostics.warn("probe", { hook: "hook-secret-abcdef", url: "https://gw.example/abcdef" })
      const data = (JSON.parse(stderr.lines()[0]!) as { data: Record<string, unknown> }).data
      expect(data.hook).toBe("hook-secret-abcdef")
      expect(data.url).toBe("https://gw.example/abcdef")
    } finally {
      boot.diagnostics.close()
      boot.uninstall()
      stderr.restore()
    }
  })

  it("the scan's default source is process.env — the shape all three entries use", () => {
    process.env.I_HARNESS_LOG = "stderr"
    setEnv("CORP_TOKEN", "corp-abc123")
    const stderr = captureStderr()
    const boot = createCliDiagnostics()
    try {
      boot.diagnostics.warn("probe", { probe: "corp-abc123" })
      const data = (JSON.parse(stderr.lines()[0]!) as { data: Record<string, unknown> }).data
      expect(data.probe).toBe("[REDACTED]")
    } finally {
      boot.diagnostics.close()
      boot.uninstall()
      stderr.restore()
    }
  })

  // ── the declared refs (settings' apiKeyEnv → the credential store) ─────────
  it("③b the declared refs come from the credential store — the FILE half the env scan cannot see", async () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    // The ref resolves from the FILE only (no env var of that name exists), so a
    // record carrying the value proves the store was consulted: the env scan
    // could never have seen it.
    const dir = mkdtempSync(join(tmpdir(), "ih-diag-refs-"))
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ llm: { providers: { gw: { apiKeyEnv: "GW_FILE_REF" } } } }), "utf8")
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ refs: { GW_FILE_REF: "file-only-secret" } }), "utf8")
    const settings = new SettingsStore({ path: join(dir, "settings.json") })
    await settings.load()
    const credentials = createCredentialStore(join(dir, "credentials.json"))
    const boot = createCliDiagnostics({ env: {}, settings, credentials })
    try {
      boot.diagnostics.warn("probe", { probe: "file-only-secret" })
      const data = (JSON.parse(stderr.lines()[0]!) as { data: Record<string, unknown> }).data
      expect(data.probe).toBe("[REDACTED]")
    } finally {
      boot.diagnostics.close()
      boot.uninstall()
      stderr.restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("③c the run path's LATE feed: registerCliSecrets is what adds the declared refs after install", async () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    const dir = mkdtempSync(join(tmpdir(), "ih-diag-late-"))
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ llm: { providers: { gw: { apiKeyEnv: "GW_FILE_REF" } } } }), "utf8")
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ refs: { GW_FILE_REF: "file-only-secret" } }), "utf8")
    const settings = new SettingsStore({ path: join(dir, "settings.json") })
    await settings.load()
    const credentials = createCredentialStore(join(dir, "credentials.json"))
    // The run path's shape: install happens before any store exists, because
    // `runHeadless` loads the runtime lazily (`--model` runs and model-free runs
    // pay nothing for it).
    const boot = createCliDiagnostics({ env: {} })
    try {
      boot.diagnostics.warn("before", { probe: "file-only-secret" })
      // The control: unknown BEFORE the feed, masked AFTER it. Without the first
      // assertion the second could pass for a rule that never came from here.
      expect((JSON.parse(stderr.lines()[0]!) as { data: Record<string, unknown> }).data.probe).toBe("file-only-secret")
      registerCliSecrets(settings, credentials)
      boot.diagnostics.warn("after", { probe: "file-only-secret" })
      const after = JSON.parse(stderr.lines()[1]!) as { msg: string; data: Record<string, unknown> }
      expect(after.msg).toBe("after")
      expect(after.data.probe).toBe("[REDACTED]")
    } finally {
      boot.diagnostics.close()
      boot.uninstall()
      stderr.restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a malformed declared ref is skipped, not fatal — startup never dies on a bad settings document", () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    const settings = { get: () => ({ llm: { providers: { gw: { apiKeyEnv: "not a valid ref" } } } }) } as unknown as SettingsStore
    // `createCredentialStore.resolve` REFUSES a ref outside env grammar (it
    // throws), and a settings document is user input: an unusable ref must cost
    // a masking, never the CLI's startup.
    const credentials = createCredentialStore(join(configDir, "credentials.json"))
    const boot = createCliDiagnostics({ env: {}, settings, credentials })
    try {
      boot.diagnostics.warn("probe", { probe: "still here" })
      const data = (JSON.parse(stderr.lines()[0]!) as { data: Record<string, unknown> }).data
      expect(data.probe).toBe("still here")
    } finally {
      boot.diagnostics.close()
      boot.uninstall()
      stderr.restore()
    }
  })

  it("an explicit runId is used verbatim; absent, one is minted", () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    const boot = createCliDiagnostics({ runId: "run-explicit", env: {} })
    const minted = createCliDiagnostics({ env: {} })
    try {
      boot.diagnostics.warn("x")
      minted.diagnostics.warn("x")
      expect((JSON.parse(stderr.lines()[0]!) as { run: string }).run).toBe("run-explicit")
      expect((JSON.parse(stderr.lines()[1]!) as { run: string }).run).toMatch(UUID_RE)
      expect((JSON.parse(stderr.lines()[0]!) as { run: string }).run).not.toBe((JSON.parse(stderr.lines()[1]!) as { run: string }).run)
    } finally {
      boot.diagnostics.close()
      boot.uninstall()
      minted.diagnostics.close()
      minted.uninstall()
      stderr.restore()
    }
  })

  // ── ⑤ every exit closes: the four run exits, and the two hosts' teardowns ──
  it("⑤ run path / the RESUME-LOAD failure exit: the instance is closed and detached", async () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    const sessionDir = mkdtempSync(join(tmpdir(), "ih-diag-resume-"))
    let captured: Diagnostics | undefined
    const err = vi.spyOn(console, "error").mockImplementation(() => { captured ??= currentDiagnostics() })
    try {
      // No such session in an empty store: `loadOwned` fails and `runHeadless`
      // returns at its FIRST exit — before any model work, which is why this
      // exit is reachable here at all.
      const code = await main(["node", "i-harness", "run", "hello", "--session-dir", sessionDir, "--resume", "no-such-session"])
      expect(code).toBe(1)
      expect(String(err.mock.calls.at(-1)![0])).toContain("i-harness run did not finish")
      expectClosed(captured, stderr)
    } finally {
      err.mockRestore()
      stderr.restore()
      rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("⑤ run path / the PRE-ASSEMBLY failure exit: the instance is closed and detached", async () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    let captured: Diagnostics | undefined
    const err = vi.spyOn(console, "error").mockImplementation(() => { captured ??= currentDiagnostics() })
    try {
      // The empty config home makes the model resolution throw inside
      // `runHeadless`'s try — the exit taken when the assembly is never built.
      const code = await main(["node", "i-harness", "run", "hello"])
      expect(code).toBe(1)
      expect(String(err.mock.calls.at(-1)![0])).toContain("No model configured")
      expectClosed(captured, stderr)
    } finally {
      err.mockRestore()
      stderr.restore()
    }
  })

  it("⑤ run path / the SUCCESS exit: the instance is closed and detached", async () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    // A REAL successful run, over a stubbed transport: the built-in deepseek
    // profile speaks openai-compatible, so one SSE body is a whole turn.
    vi.stubGlobal("fetch", (async () => new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch)
    let captured: Diagnostics | undefined
    const log = vi.spyOn(console, "log").mockImplementation(() => { captured ??= currentDiagnostics() })
    try {
      const code = await main(["node", "i-harness", "run", "hello", "--model", "deepseek:deepseek-chat", "--api-key", "sk-fixture-key-1234"])
      expect(code).toBe(0)
      expect(log.mock.calls.map((c) => c.join(""))).toContain("ok")
      expectClosed(captured, stderr)
    } finally {
      log.mockRestore()
      stderr.restore()
    }
  })

  it("⑤ run path / the FAILED-RUN exit: the instance is closed and detached", async () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    // 401 from the provider: the adapter turns it into a model stream error and
    // the turn fails — the exit a run takes AFTER the assembly was built.
    vi.stubGlobal("fetch", (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch)
    let captured: Diagnostics | undefined
    const err = vi.spyOn(console, "error").mockImplementation(() => { captured ??= currentDiagnostics() })
    try {
      const code = await main(["node", "i-harness", "run", "hello", "--model", "deepseek:deepseek-chat", "--api-key", "sk-fixture-key-1234"])
      expect(code).toBe(1)
      expect(String(err.mock.calls.at(-1)![0])).toContain("401")
      expectClosed(captured, stderr)
    } finally {
      err.mockRestore()
      stderr.restore()
    }
  })

  it("⑤ sdk host: installed from the runtime it loaded, closed in its teardown", async () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    previousStdin = Object.getOwnPropertyDescriptor(process, "stdin")
    // Both hosts live on stdin until the client ends it; an ALREADY-ENDED stdin
    // runs the real loop, the real service, and the real teardown.
    Object.defineProperty(process, "stdin", { value: Readable.from([]), configurable: true, writable: true })
    try {
      expect(await main(["node", "i-harness", "sdk"])).toBe(0)
      expect(serviceCalls.list).toHaveLength(1)
      // The declared refs are fed where the store is reachable — one call, at
      // install, because this host holds the runtime it loaded.
      const create = bootstrapLog.log[0]
      expect(create?.[0]).toBe("create")
      const opts = create?.[1] as { settings?: unknown; credentials?: unknown }
      expect(opts.settings).toBeDefined()
      expect(opts.credentials).toBeDefined()
      expectClosed(serviceCalls.list[0]!.installed as Diagnostics | undefined, stderr)
    } finally {
      stderr.restore()
    }
  })

  it("⑤ acp host: installed from the runtime it loaded, closed in its teardown", async () => {
    process.env.I_HARNESS_LOG = "stderr"
    const stderr = captureStderr()
    previousStdin = Object.getOwnPropertyDescriptor(process, "stdin")
    Object.defineProperty(process, "stdin", { value: Readable.from([]), configurable: true, writable: true })
    try {
      expect(await main(["node", "i-harness", "acp"])).toBe(0)
      expect(serviceCalls.list).toHaveLength(1)
      const create = bootstrapLog.log[0]
      expect(create?.[0]).toBe("create")
      const opts = create?.[1] as { settings?: unknown; credentials?: unknown }
      expect(opts.settings).toBeDefined()
      expect(opts.credentials).toBeDefined()
      expectClosed(serviceCalls.list[0]!.installed as Diagnostics | undefined, stderr)
    } finally {
      stderr.restore()
    }
  })

  it("the run path installs BEFORE the run and feeds the refs when the runtime loads", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const code = await main(["node", "i-harness", "run", "hello"])
      expect(code).toBe(1)
      // Install first, feed second: the store only exists once the run's own
      // `loadProviderRuntime()` resolves, and it is that store — not a second
      // one built here — the redactor is fed from.
      expect(bootstrapLog.log.map((entry) => entry[0])).toEqual(["create", "feed"])
      const [, settings, credentials] = bootstrapLog.log[1]!
      expect(typeof (settings as SettingsStore).get).toBe("function")
      expect(typeof (credentials as { resolve: unknown }).resolve).toBe("function")
    } finally {
      err.mockRestore()
    }
  })

  it("the feed is a no-op when no CLI instance is installed (an embedder's runHeadless)", async () => {
    const stderr = captureStderr()
    process.env.I_HARNESS_LOG = "stderr"
    const dir = mkdtempSync(join(tmpdir(), "ih-diag-noinstance-"))
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ llm: { providers: { gw: { apiKeyEnv: "GW_FILE_REF" } } } }), "utf8")
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ refs: { GW_FILE_REF: "file-only-secret" } }), "utf8")
    const settings = new SettingsStore({ path: join(dir, "settings.json") })
    await settings.load()
    try {
      // No `createCliDiagnostics` call at all: the slot is empty, so there is
      // no redactor to feed and nothing may throw.
      expect(() => registerCliSecrets(settings, createCredentialStore(join(dir, "credentials.json")))).not.toThrow()
      expect(stderr.lines()).toEqual([])
    } finally {
      stderr.restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
