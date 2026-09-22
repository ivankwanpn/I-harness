// apps/cli/test/run-end.test.ts
// M3 §3.4 + docs/superpowers/specs/2026-09-22-operator-run-end-design.md: a run
// leaves a durable record at each PRODUCING exit (pre-assembly failure →
// `mount`, success → `run`, run failure → `run`). The resume-load-failure exit
// writes NOTHING — loadOwned failed, so no session document exists to hold it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"

const { main } = await import("../src/index.ts")

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The built-in `deepseek` profile is openai-compatible, so one SSE body is a
// whole turn — the fixture is diagnostics-bootstrap.test.ts:86/481's.
const SSE_OK = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`
// MEASURED 2026-09-22 (`apps/cli/src/index.ts:345-376`): the CLI wires the session
// coordinator ONLY under `--session-dir`. An ephemeral run has no session document,
// hence no `activeId`, and the producer writes nothing — so every run below is
// store-backed, and every assertion is about a store the test named itself.
const runArgs = (): string[] => ["node", "i-harness", "run", "hello", "--session-dir", storeDir, "--model", "deepseek:deepseek-chat", "--api-key", "sk-fixture-key-1234"]

let configDir: string
let storeDir: string
let previousConfigDir: string | undefined
const envSet: string[] = []

beforeEach(() => {
  // Hermetic config home: an EMPTY temp config dir is what keeps a run from
  // resolving a real provider (diagnostics-bootstrap.test.ts:150-160).
  configDir = mkdtempSync(join(tmpdir(), "ih-run-end-"))
  // The store the run is TOLD to use. The scan below reads exactly here —
  // `resolveSessionStoreRoot()` answers for the CONFIG HOME, a different place,
  // and reading it would find nothing.
  storeDir = mkdtempSync(join(tmpdir(), "ih-run-end-store-"))
  previousConfigDir = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = configDir
  delete process.env.I_HARNESS_LOG
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const name of envSet.splice(0)) delete process.env[name]
  if (previousConfigDir === undefined) delete process.env.IH_CONFIG_DIR
  else process.env.IH_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
  rmSync(storeDir, { recursive: true, force: true })
})

/** Every `operator/run-end` the run's own store (`--session-dir`) holds. */
async function runEndRecords(): Promise<Array<{ runId: string; exitCode: number; durationMs: number; phase: string; error?: string }>> {
  const coordinator = createSessionCoordinator(createJsonlBackend(storeDir), {})
  try {
    const out: Array<{ runId: string; exitCode: number; durationMs: number; phase: string; error?: string }> = []
    for (const id of await coordinator.list()) {
      const { session } = await coordinator.load(id)
      for (const ev of session.events) {
        if (ev.type === "operator/run-end") out.push(ev)
      }
    }
    return out
  } finally {
    await coordinator.close()
  }
}

describe("the durable run-end record (M3 §3.4)", () => {
  it("success: exit 0 · phase run · a positive durationMs and a minted runId", async () => {
    vi.stubGlobal("fetch", (async () => new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch)
    vi.spyOn(console, "log").mockImplementation(() => {})
    expect(await main(runArgs())).toBe(0)

    const records = await runEndRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ exitCode: 0, phase: "run" })
    expect(records[0]!.durationMs).toBeGreaterThan(0)
    expect(records[0]!.runId).toMatch(UUID_RE)
    expect(records[0]!.error).toBeUndefined()
  })

  it("run failure: exit 1 · phase run · the adapter's error, redacted", async () => {
    vi.stubGlobal("fetch", (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch)
    expect(await main(runArgs())).toBe(1)
    const records = await runEndRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ exitCode: 1, phase: "run" })
    expect(records[0]!.error).toContain("401")
  })

  it("pre-assembly failure: exit 1 · phase mount (an empty config home fails at model resolution)", async () => {
    // No fetch stub: the run dies before any provider call. diagnostics-bootstrap
    // .test.ts:465-469 pins the same trigger as "No model configured". Store-backed,
    // so the pre-assembly catch has a session to write the record into.
    expect(await main(["node", "i-harness", "run", "hello", "--session-dir", storeDir])).toBe(1)
    const records = await runEndRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ exitCode: 1, phase: "mount" })
  })

  it("resume of a missing session: no record — there is no document to hold one", async () => {
    // Store-backed, so this is the REAL resume-load-failure path (`run.ts:342-346`
    // returns early, before any append site) — not the `--resume`-without-store
    // refusal at `index.ts:336-339`, which would make this case pass vacuously.
    expect(await main(["node", "i-harness", "run", "hello", "--session-dir", storeDir, "--resume", "no-such-session"])).toBe(1)
    expect(await runEndRecords()).toEqual([])
  })
})

describe("the record joins the live JSONL (spec §1.3)", () => {
  it("the JSONL's `run` field equals the durable record's runId", async () => {
    process.env.I_HARNESS_LOG = "stderr"
    const chunks: string[] = []
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { chunks.push(String(chunk)); return true }) as never)
    vi.stubGlobal("fetch", (async () => new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch)
    vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      expect(await main(runArgs())).toBe(0)
    } finally {
      spy.mockRestore()
    }
    const firstLine = chunks.join("").split("\n").filter((l) => l !== "")[0]!
    const first = JSON.parse(firstLine) as { run: string }
    const records = await runEndRecords()
    expect(records[0]!.runId).toBe(first.run)
  })

  it("a registered secret in the provider's error never reaches the record", async () => {
    process.env.CORP_TOKEN = "corp-abc123"
    envSet.push("CORP_TOKEN")
    vi.stubGlobal("fetch", (async () => new Response("unauthorized: Authorization: Bearer corp-abc123", { status: 401 })) as unknown as typeof fetch)
    expect(await main(runArgs())).toBe(1)
    const records = await runEndRecords()
    expect(records[0]!.error).toBeDefined()
    expect(records[0]!.error).not.toContain("corp-abc123")
    expect(records[0]!.error).toContain("[REDACTED]")
  })
})
