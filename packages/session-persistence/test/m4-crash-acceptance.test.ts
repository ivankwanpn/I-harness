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
// The two cases differ by exactly one event, and the answers must DIFFER:
//
//   dispatched      turn/start · tool/call · tool/dispatch → killed
//                   the body STARTED, the outcome is unknown
//   not-dispatched  turn/start · tool/call                 → killed
//                   the model asked, the body never ran
//
// Before M4 both answered "aborted before dispatch", and a model that believed
// that about the first case could re-run a `rm -rf` that had already started.

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..", "..")
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")
const CHILD = join(HERE, "helpers", "kill-mid-tool.mts")

/** Run the child until it reports the tool body is in flight, then SIGKILL it
 * THERE. Killing anywhere earlier would be testing a different boundary. */
async function runThenKillMidTool(dir: string, sessionId: string, mode: "dispatched" | "not-dispatched"): Promise<void> {
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

  /** What a FRESH process sees when it opens the killed run's log. */
  async function verdictAfterCrash(sessionId: string): Promise<string[]> {
    const coordinator = createSessionCoordinator(createJsonlBackend(dir))
    try {
      const { session } = await coordinator.loadOwned(sessionId)
      return session.events
        .filter((event) => event.type === "tool/result")
        .map((event) => String((event as { output?: { code?: unknown } }).output?.code))
    } finally {
      await coordinator.close().catch(() => {})
    }
  }

  it("a tool whose body had STARTED reports outcome-unknown, never 'before dispatch'", async () => {
    await runThenKillMidTool(dir, "sess-started", "dispatched")
    expect(await verdictAfterCrash("sess-started")).toEqual(["TOOL_OUTCOME_UNKNOWN"])
  })

  it("the control: a tool that never started still reports before-dispatch", async () => {
    await runThenKillMidTool(dir, "sess-never", "not-dispatched")
    expect(await verdictAfterCrash("sess-never")).toEqual(["TOOL_ABORTED_BEFORE_DISPATCH"])
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
