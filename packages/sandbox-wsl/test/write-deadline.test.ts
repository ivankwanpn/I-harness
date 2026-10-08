import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ExecutionReceipt } from "@i-harness/sandbox"

const state = vi.hoisted(() => ({ blocked: "", ends: 0, destroys: 0, kills: 0, holdClose: false,
  callbacks: [] as (() => void)[], close: undefined as (() => void) | undefined }))
vi.mock("node:child_process", () => ({
  execFile: (_path: string, _args: string[], _options: unknown, callback: (error: null, output: Buffer, stderr: Buffer) => void) => {
    queueMicrotask(() => callback(null, Buffer.from("  NAME    STATE    VERSION\n* Ubuntu    Running    2\n", "utf16le"), Buffer.alloc(0)))
  },
  spawn: () => {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { write(line: string, callback: (error?: Error) => void): boolean; end(): void; destroy(): void }
    stdout: PassThrough; stderr: PassThrough; kill(): boolean
  }
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.stdin = new EventEmitter() as typeof child.stdin
  let nonce = "", closed = false
  const reply = (type: string, fields = {}) => child.stdout.write(JSON.stringify({ v: 1, nonce, type, ...fields }) + "\n")
  child.stdin.end = () => { state.ends++ }
  child.stdin.destroy = () => { state.destroys++ }
  state.close = () => { if (!closed) { closed = true; child.stdout.end(); child.stderr.end(); child.emit("close", 0, null) } }
  child.kill = () => { state.kills++; if (!state.holdClose) state.close!(); return true }
  child.stdin.write = (line, callback) => {
    const frame = JSON.parse(line)
    const type = frame.source ? "bootstrap" : frame.type
    if (type === state.blocked) { state.callbacks.push(() => callback()); return false }
    queueMicrotask(() => {
      callback()
      if (frame.source) { nonce = frame.nonce; reply("hello", { sha256: frame.sha256, workerPid: 1 }) }
      else if (type === "prepare") reply("prepared", { policyFingerprint: "fp" })
      else if (type === "commit") reply("started", { pid: 2 })
    })
    return true
  }
  return child
} }))
import { WorkerClient } from "../src/transport.ts"
import { createWslExecutionBackend } from "../src/index.ts"

const nonce = "b".repeat(64), digest = "a".repeat(64)
const receipt: ExecutionReceipt = { executionId: "write-deadline", backendId: "wsl2-bubblewrap-experimental",
  owner: { sessionId: "owner" }, assurance: "experimental", policyFingerprint: "fp" }
function client() { return new WorkerClient("Ubuntu", nonce, JSON.stringify({ v: 1, nonce, source: "captured", sha256: digest }) + "\n", digest) }
beforeEach(() => { vi.useFakeTimers(); state.blocked = ""; state.ends = 0; state.destroys = 0; state.kills = 0; state.holdClose = false; state.callbacks = []; state.close = undefined })
afterEach(() => vi.useRealTimers())

it.each(["bootstrap", "probe", "prepare", "commit", "input", "endInput", "shutdown", "cancel"])("bounds a blocked %s write and drains to truthful failure", async type => {
  if (type === "bootstrap") state.blocked = type
  const owner = client()
  if (type !== "bootstrap") await owner.ready()
  if (["commit", "input", "endInput", "cancel"].includes(type)) await owner.prepare({}, {})
  const handle = ["input", "endInput", "cancel"].includes(type) ? await owner.commit(receipt, () => {}) : undefined
  state.blocked = type
  const operation = type === "bootstrap" ? owner.ready()
    : type === "probe" ? owner.probe()
    : type === "prepare" ? owner.prepare({}, {})
    : type === "commit" ? owner.commit(receipt, () => {})
    : type === "input" ? handle!.io.write(Buffer.from("payload"))
    : type === "endInput" ? handle!.io.endInput()
    : type === "shutdown" ? owner.shutdown() : owner.send("cancel")
  let completed = false
  void operation.catch(() => { completed = true })
  await vi.advanceTimersByTimeAsync(40_001)
  expect(completed).toBe(true)
  await expect(operation).rejects.toThrow(/timed out/)
  expect(state.ends).toBeGreaterThan(0)
  expect(state.destroys).toBeGreaterThan(0)
  expect(state.kills).toBe(1)
  if (handle) expect(await handle.settled).toMatchObject({ kind: "incomplete", phase: "tree" })
  await expect(owner.shutdown()).rejects.toThrow(/timed out/)
  // A callback delivered after the deadline cannot resurrect ownership or successful settlement.
  for (const finish of state.callbacks) finish()
  if (handle) expect(await handle.release()).toMatchObject({ kind: "incomplete" })
})

it("bounds shutdown even when forced launcher closure never arrives", async () => {
  const owner = client()
  await owner.ready()
  state.blocked = "shutdown"; state.holdClose = true
  const shutdown = owner.shutdown()
  let completed = false
  void shutdown.catch(() => { completed = true })
  await vi.advanceTimersByTimeAsync(40_001)
  expect(completed).toBe(true)
  expect(state.kills).toBe(1)
  await expect(shutdown).rejects.toThrow(/timed out/)
  let closed = false
  void owner.completion().finally(() => { closed = true }).catch(() => {})
  await Promise.resolve()
  expect(closed).toBe(false)
  state.close!()
  await expect(owner.completion()).rejects.toThrow(/timed out/)
})

it("bounds backend disposal around a blocked preparation and retains unconfirmed ownership on retry", async () => {
  state.blocked = "prepare"; state.holdClose = true
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const cwd = process.cwd()
  const admission = backend.prepare({ argv: ["/usr/bin/true"], cwd, env: {}, owner: receipt.owner,
    transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" }, {
    mode: "read-only", owner: receipt.owner, authorityRevision: "blocked", authorityKind: "bound", primaryRoot: cwd,
    readable: "caller", authorityRoots: [cwd], writeRoots: [], referenceRoots: [], fingerprint: "fp",
  })
  void admission.catch(() => {})
  await vi.advanceTimersByTimeAsync(1)
  expect(state.callbacks).toHaveLength(1)
  const disposal = backend.dispose()
  void disposal.catch(() => {})
  await vi.advanceTimersByTimeAsync(40_001)
  await expect(admission).rejects.toThrow("cleanup incomplete")
  await expect(disposal).rejects.toThrow("disposal incomplete")
  expect(backend.diagnostics().length).toBeGreaterThan(0)
  await expect(backend.dispose()).rejects.toThrow("disposal incomplete")
  expect(state.kills).toBe(1)
  state.close!()
  await Promise.resolve()
  await expect(backend.dispose()).rejects.toThrow("disposal incomplete")
})
