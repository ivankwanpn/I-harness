import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SessionEvent } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator } from "../src/index.ts"

// M4's ACCEPTANCE, and it is a spawn test on purpose. The roadmap's completion
// definition: "在工具呼叫中途殺掉行程，斷言續行的 session 到達一個已記錄且正確的
// 裁決 —— **不是靠讀程式碼**".
//
// So a real process runs a tool, is SIGKILLed while the body is in flight, and a
// FRESH coordinator then reads the verdict out of the log. Nothing here inspects
// the repair implementation; it kills a process and reads what the next one sees.
//
// After M4 the two cases differed by exactly one event and the answers DIFFERED:
//
//   dispatched      turn/start · tool/call · tool/dispatch → killed
//                   the body STARTED, the outcome is unknown
//   not-dispatched  turn/start · tool/call                 → killed
//                   the model asked, the body never ran
//
// Before M4 both answered "aborted before dispatch", and a model that believed
// that about the first case could re-run a `rm -rf` that had already started.
//
// **Q8 (M71) DELIBERATELY REMOVED THAT CONTRAST.** A log with no marker ANYWHERE
// cannot prove the body never ran, so `not-dispatched` now answers unknown too —
// the same verdict `dispatched` gets, from a different payload. The
// discriminating case is now the THIRD mode, `earlier-turn-marker`: a marker in
// an EARLIER turn is what keeps a marker-less later call honestly "before
// dispatch". That case is also the proof that the rule is whole-log and not
// last-turn-scoped — nothing else in the suite separates the two.

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..", "..")
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")
const CHILD = join(HERE, "helpers", "kill-mid-tool.mts")

type KillMode = "dispatched" | "not-dispatched" | "earlier-turn-marker"

/** Run the child until it reports the tool body is in flight, then SIGKILL it
 * THERE. Killing anywhere earlier would be testing a different boundary. */
async function runThenKillMidTool(dir: string, sessionId: string, mode: KillMode): Promise<void> {
  const child = spawn(process.execPath, [TSX, CHILD, dir, sessionId, mode], { stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  let err = ""
  child.stdout.on("data", (d: Buffer) => { out += String(d) })
  child.stderr.on("data", (d: Buffer) => { err += String(d) })
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => { reject(new Error(`child never reached the tool body.\nstdout=${out}\nstderr=${err}`)) },
        30_000,
      )
      child.stdout.on("data", () => {
        if (out.includes("IN_TOOL")) { clearTimeout(deadline); resolve() }
      })
      child.on("exit", (code) => {
        clearTimeout(deadline)
        reject(new Error(`child exited before the kill (${String(code)}).\nstderr=${err}`))
      })
    })
  } finally {
    child.kill("SIGKILL") // ← the crash, while the tool body is running
    await new Promise<void>((resolve) => {
      child.on("exit", () => { resolve() })
      setTimeout(resolve, 5_000) // a kill that somehow does not land must not hang the suite
    })
  }
}

describe("M4 acceptance — a process killed mid-tool leaves a RECORDED verdict", () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ih-m4-accept-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** What a FRESH process sees when it opens the killed run's log. `callId`
   * narrows to one call — the whole-log case's log also holds an earlier turn's
   * real result, whose `code` is legitimately undefined. */
  async function verdictAfterCrash(sessionId: string, callId?: string): Promise<string[]> {
    const coordinator = createSessionCoordinator(createJsonlBackend(dir))
    try {
      const { session } = await coordinator.loadOwned(sessionId)
      return session.events
        .filter((event) => event.type === "tool/result")
        .filter((event) => callId === undefined || (event as { callId?: string }).callId === callId)
        .map((event) => String((event as { output?: { code?: unknown } }).output?.code))
    } finally {
      await coordinator.close().catch(() => {})
    }
  }

  it("a tool whose body had STARTED reports outcome-unknown, never 'before dispatch'", async () => {
    await runThenKillMidTool(dir, "sess-started", "dispatched")
    expect(await verdictAfterCrash("sess-started")).toEqual(["TOOL_OUTCOME_UNKNOWN"])
  })

  it("a tool in a log with NO marker ANYWHERE also reports outcome-unknown (Q8, conservative)", async () => {
    // M71 T2 — DELIBERATE CONTRACT CHANGE (was: "the control: a tool that never
    // started still reports before-dispatch"). The old contrast between the two
    // modes is GONE BY DECISION, not by breakage: absence of the marker anywhere
    // cannot prove the body never ran, and the benign verdict is the one that
    // licenses a re-run. The discriminating contrast moved to the third mode
    // below, which differs from this one by a marker in ANOTHER turn.
    await runThenKillMidTool(dir, "sess-never", "not-dispatched")
    expect(await verdictAfterCrash("sess-never")).toEqual(["TOOL_OUTCOME_UNKNOWN"])
  })

  it("a marker in an EARLIER turn keeps a later marker-less call 'before dispatch' (whole-log, not last-turn)", async () => {
    // The case that still discriminates — and the only one that separates the
    // whole-log read from a last-turn-scoped one: this log's LAST turn has no
    // marker, exactly like `not-dispatched`, and differs only by the closed
    // earlier turn's marker. Turn-scoping would wrongly relabel this call.
    await runThenKillMidTool(dir, "sess-history", "earlier-turn-marker")
    expect(await verdictAfterCrash("sess-history", "c1")).toEqual(["TOOL_ABORTED_BEFORE_DISPATCH"])
  })

  it("the verdict is on DISK, not only in the object the loader returned", async () => {
    await runThenKillMidTool(dir, "sess-durable", "dispatched")
    await verdictAfterCrash("sess-durable") // first recovery writes it back
    // A THIRD reader, straight off the file, with no repair involved.
    const { readFileSync } = await import("node:fs")
    const raw = readFileSync(join(dir, "sess-durable.jsonl"), "utf8")
      .trim().split("\n").slice(1)
      .map((line) => JSON.parse(line) as SessionEvent)
    const codes = raw.filter((e) => e.type === "tool/result")
      .map((e) => (e as { output?: { code?: unknown } }).output?.code)
    expect(codes).toEqual(["TOOL_OUTCOME_UNKNOWN"])
  })
})
