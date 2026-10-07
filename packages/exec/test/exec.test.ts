import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { registerExec, withExecCallerScope, type ExecService } from "../src/index.ts"
import { SandboxUnavailableError, type SandboxProvider } from "@i-harness/sandbox"

// Poll-wait helper: avoids raw fixed sleeps (flake-prone under parallel load).
async function waitForStatus(exec: ExecService, jobId: string, pred: (status: string) => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = exec.getOutput(jobId).status
    if (pred(status)) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for job ${jobId}`)
}

describe("exec service", () => {
  it("runs a command and captures stdout", async () => {
    const exec = registerExec(createContext())
    const result = await exec.run({ argv: [process.execPath, "-e", "console.log('hi')"] })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("hi")
    expect(result.timedOut).toBe(false)
  })

  it("captures exit codes and stderr", async () => {
    const exec = registerExec(createContext())
    const result = await exec.run({ argv: [process.execPath, "-e", "console.error('boom'); process.exit(3)"] })
    expect(result.exitCode).toBe(3)
    expect(result.stderr.trim()).toBe("boom")
  })

  it("times out long-running commands", async () => {
    const exec = registerExec(createContext())
    const result = await exec.run({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 5000)"], timeoutMs: 200 })
    expect(result.timedOut).toBe(true)
  }, 10_000)

  it("external abort kills a running command", async () => {
    const exec = registerExec(createContext())
    const controller = new AbortController()
    const started = Date.now()
    let readiness = ""
    // Admission is asynchronous. Abort only after the real child is running,
    // so this assertion covers cancellation rather than preparation rollback.
    const pending = exec.run({
      argv: [process.execPath, "-e", "console.log('ABORT_READY');setTimeout(()=>{}, 60000)"],
      abortSignal: controller.signal,
    }, { stream: { maxBytes: 1024, onStdout: chunk => {
      readiness += chunk.toString()
      if (readiness.includes("ABORT_READY")) controller.abort()
    } } })
    try {
      const result = await pending
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(10_000)
      expect(result.exitCode).not.toBe(0)
      // An abort is NOT a timeout — callers must see the real exitCode.
      expect(result.timedOut).toBe(false)
    } finally { await exec.dispose() }
  }, 10_000)

  it("aborts immediately when the signal is already aborted before spawn", async () => {
    const exec = registerExec(createContext())
    const controller = new AbortController()
    controller.abort()
    const result = await exec.run({
      argv: [process.execPath, "-e", "setTimeout(()=>{}, 60000)"],
      abortSignal: controller.signal,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.timedOut).toBe(false)
  }, 10_000)

  it("writes stdin", async () => {
    const exec = registerExec(createContext())
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdin.on('data', d => process.stdout.write('got:'+d))"], input: "x" })
    expect(result.stdout).toContain("got:x")
  })

  it("respects cwd", async () => {
    const exec = registerExec(createContext())
    const result = await exec.run({ argv: [process.execPath, "-e", "console.log(process.cwd())"], cwd: process.cwd() })
    expect(result.stdout.trim()).toBe(process.cwd())
  })
})

describe("exec background jobs", () => {
  it("runBackground returns immediately and accumulates output", async () => {
    const exec = registerExec(createContext())
    const launch = exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>console.log('done'), 100)"] })
    expect(launch).toBeInstanceOf(Promise)
    const { jobId } = await launch
    expect(jobId).toMatch(/^bash-\d+$/)
    expect(exec.getOutput(jobId).status).toBe("running")
    await waitForStatus(exec, jobId, (s) => s === "completed")
    const view = exec.getOutput(jobId)
    expect(view.status).toBe("completed")
    expect(view.stdout.trim()).toBe("done")
    expect(view.exitCode).toBe(0)
    expect(view.root?.exitCode).toBe(0)
    expect(view.settlement?.kind).toBe("settled")
    expect(view.receipt?.owner.sessionId).toBe(view.owner)
  }, 10_000)

  it("killJob cancels a running job and marks it killed", async () => {
    const exec = registerExec(createContext())
    const { jobId } = await exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 5000)"] })
    const cancellation = exec.killJob(jobId)
    expect(cancellation).toBeInstanceOf(Promise)
    expect(await cancellation).toBe("cancellation-requested")
    await waitForStatus(exec, jobId, (s) => s === "killed")
    expect(exec.getOutput(jobId).status).toBe("killed")
    expect(await exec.killJob(jobId)).toBe("already-finished")
  }, 10_000)

  it("getOutput for unknown job throws", () => {
    const exec = registerExec(createContext())
    expect(() => exec.getOutput("nope")).toThrow(/unknown job/i)
  })

  it("listJobs enumerates running and finished jobs", async () => {
    const exec = registerExec(createContext())
    const { jobId } = await exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 200)"] })
    const ids = exec.listJobs().map((j) => j.id)
    expect(ids).toContain(jobId)
    expect(exec.listJobs().find((j) => j.id === jobId)!.status).toBe("running")
    await waitForStatus(exec, jobId, (s) => s === "completed")
    expect(exec.listJobs().find((j) => j.id === jobId)!.status).toBe("completed")
  }, 10_000)

  it("getOutput shows accumulated stdout while the job is still running", async () => {
    const exec = registerExec(createContext())
    // 'late' is far enough out that the job is guaranteed still running when
    // the 'early' chunk becomes observable, even under parallel load.
    const { jobId } = await exec.runBackground({ argv: [process.execPath, "-e", "console.log('early'); setTimeout(()=>console.log('late'), 1000)"] })
    await waitForStatus(exec, jobId, () => exec.getOutput(jobId).stdout.includes("early"))
    const view = exec.getOutput(jobId)
    expect(view.status).toBe("running")
    expect(view.stdout).toContain("early")
    await waitForStatus(exec, jobId, (s) => s === "completed")
    const done = exec.getOutput(jobId)
    expect(done.status).toBe("completed")
    expect(done.stdout).toContain("late")
  }, 10_000)

  // W10 regression (review F2): the job's text must be normalized the way the
  // foreground result is — over the whole string — not chunk by chunk. A CRLF
  // SPLIT across two `data` events is in neither chunk, so per-chunk
  // normalization cannot fold it, and the model-visible `job_output` view said
  // `"A\r\nB"` where the same command run in the foreground said `"A\nB"`.
  it("folds a CRLF split ACROSS two chunks exactly as a foreground run does", async () => {
    const exec = registerExec(createContext())
    // "A\r" now, "\nB" 150ms later: one logical CRLF, two `data` events.
    const script = "process.stdout.write('A\\r');setTimeout(()=>process.stdout.write('\\nB'),150)"
    const foreground = await exec.run({ argv: [process.execPath, "-e", script] })
    expect(foreground.stdout).toBe("A\nB") // the pre-existing foreground contract
    const { jobId } = await exec.runBackground({ argv: [process.execPath, "-e", script] })
    await waitForStatus(exec, jobId, (s) => s === "completed")
    // RED before the fix: "A\r\nB" — measured. The job view is what job_output
    // renders to the model, so this is model-visible, not internal.
    expect(exec.getOutput(jobId).stdout).toBe("A\nB")
  }, 10_000)
})

// W10: the foreground promotion overload. The property is "one spawn, either
// outcome": the same process that would have been awaited is REGISTERED as a
// job at the threshold, so the command keeps running and the job surfaces
// (`getOutput`, `listJobs`, `killJob`) reach it. Both halves matter — an id for
// a dead process would pass a shape-only assertion and fail this one.
describe("exec foreground promotion (W10)", () => {
  it("a run that finishes under the threshold returns the ordinary result and registers NO job", async () => {
    const exec = registerExec(createContext())
    const result = await exec.run(
      { argv: [process.execPath, "-e", "process.stdout.write('quick')"] },
      { backgroundAfterMs: 2000 },
    )
    // The threshold never fired: the caller gets today's result, not a job id.
    if ("promoted" in result) throw new Error("expected an ordinary ExecResult, got a promotion")
    expect(result.stdout).toBe("quick")
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    // Nothing was promoted — a job record here would be a record for a run the
    // caller was told had finished.
    expect(exec.listJobs()).toEqual([])
  })

  it("a run that outlives the threshold is handed back as a job that KEEPS RUNNING and finishes its work", async () => {
    const exec = registerExec(createContext())
    const dir = mkdtempSync(join(tmpdir(), "ih-w10-"))
    const marker = join(dir, "done.txt")
    try {
      // The write lands AFTER the threshold, so the marker exists only if the
      // child survived the hand-back and completed the work it was doing.
      const script =
        `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'done');console.log('late')},600)`
      const result = await exec.run({ argv: [process.execPath, "-e", script] }, { backgroundAfterMs: 150 })
      if (!("promoted" in result)) throw new Error("expected a PromotedRun")
      expect(result.promoted).toBe(true)
      expect(result.jobId).toMatch(/^bash-\d+$/)
      expect(result.ranForegroundMs).toBeGreaterThanOrEqual(150)
      // Registered, not restarted: the id is already a live job record, and the
      // record is seeded with what the foreground phase had produced.
      const live = exec.getOutput(result.jobId)
      expect(live.status).toBe("running")
      expect(existsSync(marker)).toBe(false) // still running, not already done
      await waitForStatus(exec, result.jobId, (s) => s === "completed")
      const view = exec.getOutput(result.jobId)
      expect(view.exitCode).toBe(0)
      expect(view.stdout).toContain("late") // output written after the promotion
      expect(existsSync(marker)).toBe(true) // the work was not lost
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
})

describe("exec backend admission", () => {
  const policy = { mode: "read-only" as const, workspaceRoot: process.cwd() }

  it("does not let an argv-only provider bypass the selected transport backend", async () => {
    const provider: SandboxProvider = { confine() { throw new Error("argv provider must never launch") } }
    const exec = registerExec(createContext(), { sandbox: provider })
    if (process.platform === "win32") {
      await expect(exec.run({ argv: [process.execPath, "-e", ""], sandbox: policy })).rejects.toThrow(SandboxUnavailableError)
    }
  })

  it("uses the native unrestricted backend when sandbox is unset", async () => {
    const exec = registerExec(createContext())
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write('plain')"] })
    expect(result.stdout).toBe("plain")
  })

  it("preserves an explicitly empty environment at the backend seam", async () => {
    const exec = registerExec(createContext())
    const name = "IH_EXEC_TEST_INHERITED_ONLY"
    process.env[name] = "present"
    try {
      const argv = process.platform === "win32"
        ? [process.env.ComSpec ?? "C:/Windows/System32/cmd.exe", "/d", "/c", `if defined ${name} (echo present) else (echo absent)`]
        : ["/bin/sh", "-c", `if [ -z \"$${name}\" ]; then echo absent; else echo present; fi`]
      const result = await exec.run({ argv, env: {} })
      expect(result.stdout.trim(), JSON.stringify(result)).toBe("absent")
    } finally { delete process.env[name] }
  })

  it("binds a trusted caller and its parent into a committed transport receipt", async () => {
    const exec = registerExec(createContext())
    const owner = { sessionId: "child-transport", parentSessionId: "parent-transport" }
    const execution = await withExecCallerScope(owner, () => exec.launchTransport({
      argv: [process.execPath, "-e", "process.stdout.write('owned')"],
      cwd: process.cwd(), transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt",
    }))
    const chunks: Buffer[] = []
    await execution.handle.io.endInput()
    for await (const frame of execution.handle.io.output) chunks.push(Buffer.from(frame.data))
    expect(Buffer.concat(chunks).toString()).toBe("owned")
    expect(execution.handle.receipt.owner).toEqual(owner)
    expect((await execution.handle.settled).kind).toBe("settled")
    await exec.dispose()
  })

  it("does not expose another scoped caller's background job", async () => {
    const exec = registerExec(createContext())
    const ownerA = { sessionId: "owner-a" }, ownerB = { sessionId: "owner-b" }
    const { jobId } = await withExecCallerScope(ownerA, () => exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 5000)"] }))
    try {
      await withExecCallerScope(ownerB, async () => {
        expect(exec.listJobs()).toEqual([])
        expect(() => exec.getOutput(jobId)).toThrow(/unknown job/i)
        await expect(exec.killJob(jobId)).rejects.toThrow(/unknown job/i)
      })
      expect(exec.listJobs()).toEqual([])
      expect(() => exec.getOutput(jobId)).toThrow(/unknown job/i)
      await expect(exec.killJob(jobId)).rejects.toThrow(/unknown job/i)
    } finally {
      await withExecCallerScope(ownerA, () => exec.killJob(jobId))
      await exec.dispose()
    }
  })

  it("settles a public transport cancellation only for its bound owner", async () => {
    const exec = registerExec(createContext())
    const ownerA = { sessionId: "transport-a" }, ownerB = { sessionId: "transport-b" }
    const execution = await withExecCallerScope(ownerA, () => exec.launchTransport({
      argv: [process.execPath, "-e", "setInterval(()=>{}, 1000)"], cwd: process.cwd(),
      transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt",
    }))
    const drain = (async () => { for await (const _frame of execution.handle.io.output) { /* drain */ } })()
    await execution.handle.io.endInput()
    await withExecCallerScope(ownerB, async () => {
      await expect(exec.cancelExecution(execution.id, "cancelled")).rejects.toThrow(/unknown execution/i)
    })
    const settlement = await withExecCallerScope(ownerA, () => exec.cancelExecution(execution.id, "cancelled"))
    expect(settlement.kind).toBe("settled")
    await drain
    await exec.dispose()
  })
})
