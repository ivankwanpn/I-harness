import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { CompiledSandboxPolicy, ProcessSpec } from "@i-harness/sandbox"

const state = vi.hoisted(() => ({ mode: "normal", commands: [] as Record<string, unknown>[],
  launches: [] as { path: string; args: string[]; options: Record<string, unknown> }[],
  close: undefined as (() => void) | undefined, prepared: undefined as (() => void) | undefined }))

// A module mock controls launcher events deterministically. Production construction has no injected launcher.
vi.mock("node:child_process", () => ({
  execFile: (_path: string, _args: string[], _options: unknown, cb: (error: null, bytes: Buffer, stderr: Buffer) => void) => {
    queueMicrotask(() => cb(null, Buffer.from("  NAME    STATE    VERSION\n* Ubuntu    Running    2\n", "utf16le"), Buffer.alloc(0)))
  },
  spawn: (path: string, args: string[], options: Record<string, unknown>) => {
    state.launches.push({ path, args, options })
    const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill(): boolean }
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    let nonce = "", digest = "", pending = "", active = false, settled = false, closed = false, rootSent = false
    const reply = (type: string, fields = {}) => child.stdout.write(JSON.stringify({ v: 1, nonce, type, ...fields }) + "\n")
    const close = () => {
      if (closed) return
      closed = true
      child.stdout.end(); child.stderr.end(); child.emit("close", 0, null)
    }
    state.close = close
    child.kill = () => { close(); return true }
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      pending += chunk.toString()
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n"), command = JSON.parse(pending.slice(0, end))
        pending = pending.slice(end + 1)
        state.commands.push(command)
        queueMicrotask(() => {
          if (command.source) {
            nonce = command.nonce; digest = command.sha256
            reply("hello", { sha256: digest, workerPid: 123 })
            child.stderr.write(Buffer.from("proxy diagnostic\r\n", "utf16le"))
          } else if (command.type === "probe") reply("probe", { available: true, detail: "checked" })
          else if (command.type === "prepare") {
            if (state.mode.startsWith("prepare-refusal")) {
              reply("refused", { detail: "owned root unsupported" })
              if (state.mode !== "prepare-refusal-noack") { reply("settled"); settled = true }
              if (state.mode !== "prepare-refusal-holdclose") close()
              return
            }
            state.prepared = () => reply("prepared", { policyFingerprint: command.policy.fingerprint })
            if (state.mode !== "preparing") state.prepared()
          } else if (command.type === "commit") {
            if (state.mode === "commit-refusal") { reply("refused", { detail: "directory identity changed" }); reply("settled"); settled = true; close(); return }
            active = true
            reply("started", { pid: 456 })
            if (state.mode === "foreign-nonce") setImmediate(() => child.stdout.write(JSON.stringify({ v: 1, nonce: "foreign", type: "settled" }) + "\n"))
            else if (state.mode === "root-only") { reply("root", { exitCode: 0 }); rootSent = true }
            // These tests exercise failure of an admitted handle; let its native write callback complete first.
            if (state.mode === "crash") setImmediate(() => { reply("root", { exitCode: 0 }); close() })
            else if (state.mode === "normal" || state.mode === "late-abandon") {
              reply("output", { channel: "stdout", data: Buffer.from([0, 255, 128, 10]).toString("base64") })
              if (state.mode === "late-abandon") reply("output", { channel: "stdout", data: Buffer.from("second").toString("base64") })
              reply("root", { exitCode: 0 }); reply("settled"); settled = true
            }
          } else if (command.type === "shutdown" || command.type === "cancel") {
            if (!settled && state.commands.some(value => value.type === "prepare")) {
              if (active && !rootSent) reply("root", { exitCode: 137, signal: "SIGKILL" })
              reply("settled"); settled = true
            }
            if (state.mode !== "manual-close" && command.type === "shutdown") close()
          }
        })
      }
      done()
    } })
    return child
  },
}))

import { createWslExecutionBackend } from "../src/index.ts"
const root = "D:\\I-harness-main"
const spec = (): ProcessSpec => ({ argv: ["/usr/bin/bash", "-c", "true"], cwd: root, env: {}, owner: { sessionId: "owner" },
  transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" })
const policy = (): CompiledSandboxPolicy => ({ mode: "read-only", owner: { sessionId: "owner" }, authorityRevision: "r",
  authorityKind: "bound", primaryRoot: root, readable: "caller", authorityRoots: [root], writeRoots: [], referenceRoots: [], fingerprint: "captured-fp" })
beforeEach(() => { state.mode = "normal"; state.commands.length = 0; state.launches.length = 0; state.close = undefined; state.prepared = undefined })
afterEach(() => vi.useRealTimers())

it("preparation can exceed short control deadlines and stays abortable", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  state.mode = "preparing"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const controller = new AbortController()
  const pending = backend.prepare(spec(), policy(), controller.signal)
  let done = false
  void pending.then(() => { done = true }, () => { done = true })
  for (let i=0;i<30;i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(10_001)
  expect(done).toBe(false)
  controller.abort()
  await expect(pending).rejects.toThrow(/aborted/)
  await backend.dispose()
})

it("captures network and managed PATH configuration once and advertises reference protection", async () => {
  const options = { distribution: "Ubuntu", networkAccess: true, runtimePath: ["/opt/ih/node/bin"] }
  const backend = createWslExecutionBackend(options)
  options.networkAccess = false
  options.runtimePath[0] = "/changed"
  expect((await backend.probe()).features).toMatchObject({ referenceProtection: true, denyPaths: false })
  const prepared = await backend.prepare(spec(), policy())
  expect(state.commands.find(command => command.type === "prepare")!.configuration).toEqual({ networkAccess: true, runtimePath: ["/opt/ih/node/bin"] })
  await prepared.rollback()
  await backend.dispose()
})

it("launches the fixed captured worker and preserves binary output and experimental receipt", async () => {
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const prepared = await backend.prepare(spec(), policy())
  const handle = await prepared.commit(() => {})
  const output = []
  for await (const value of handle.io.output) output.push(value)
  expect(output).toEqual([{ channel: "stdout", data: Buffer.from([0, 255, 128, 10]) }])
  expect(await handle.settled).toMatchObject({ kind: "settled", treeEmpty: true })
  expect(handle.receipt).toMatchObject({ backendId: "wsl2-bubblewrap-experimental", assurance: "experimental", policyFingerprint: "captured-fp", owner: { sessionId: "owner" } })
  expect(state.launches[0]!.path).toBe("C:\\Windows\\System32\\wsl.exe")
  expect(state.launches[0]!.args.slice(0, -1)).toEqual(["--distribution", "Ubuntu", "--exec", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C", "/usr/bin/python3", "-I", "-B", "-u", "-c"])
  expect(state.launches[0]!.options).toMatchObject({ windowsHide: true, stdio: "pipe", shell: false })
  expect(handle.io.signal).toBeUndefined()
  await backend.dispose()
})

it("authority failure shuts down prepared guest and awaits WSL closure without commit", async () => {
  state.mode = "manual-close"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const prepared = await backend.prepare(spec(), policy())
  const rejected = prepared.commit(() => { throw new Error("authority revoked") })
  let finished = false
  void rejected.catch(() => { finished = true })
  await vi.waitFor(() => expect(state.commands.some(value => value.type === "shutdown")).toBe(true))
  expect(finished).toBe(false)
  expect(state.commands.some(value => value.type === "commit")).toBe(false)
  state.close!()
  await expect(rejected).rejects.toThrow("authority revoked")
  await backend.dispose()
})

it("root exit followed by worker crash reports incomplete tree observation", async () => {
  state.mode = "crash"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const prepared = await backend.prepare(spec(), policy())
  const handle = await prepared.commit(() => {})
  expect(await handle.rootExited).toEqual({ exitCode: 0 })
  expect(await handle.settled).toMatchObject({ kind: "incomplete", phase: "tree" })
  await expect(backend.dispose()).rejects.toThrow()
})

it("abort while preparing waits for guest shutdown and launcher closure", async () => {
  state.mode = "preparing"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const abort = new AbortController()
  const admission = backend.prepare(spec(), policy(), abort.signal)
  void admission.catch(() => {})
  await vi.waitFor(() => expect(state.prepared).toBeTypeOf("function"))
  abort.abort()
  await expect(admission).rejects.toThrow(/abort/i)
  expect(state.commands.some(value => value.type === "shutdown")).toBe(true)
  expect(state.commands.some(value => value.type === "commit")).toBe(false)
  await backend.dispose()
})

it("disposal closes admission and drains prepared owners", async () => {
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  await backend.prepare(spec(), policy())
  await backend.dispose()
  expect(state.commands.some(value => value.type === "shutdown")).toBe(true)
  await expect(backend.prepare(spec(), policy())).rejects.toThrow(/disposed/)
})

it("missing guest acknowledgement after root exit reaches an incomplete result", async () => {
  vi.useFakeTimers()
  state.mode = "root-only"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const prepared = await backend.prepare(spec(), policy())
  const handle = await prepared.commit(() => {})
  expect(await handle.rootExited).toEqual({ exitCode: 0 })
  await vi.advanceTimersByTimeAsync(10_001)
  expect(await handle.settled).toMatchObject({ kind: "incomplete", phase: "tree" })
  const disposal = backend.dispose()
  state.close!()
  await expect(disposal).rejects.toThrow()
})

it("worker protocol injection cannot create a successful settlement", async () => {
  state.mode = "foreign-nonce"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const prepared = await backend.prepare(spec(), policy())
  const handle = await prepared.commit(() => {})
  expect(await handle.settled).toMatchObject({ kind: "incomplete", phase: "tree" })
  const disposal = backend.dispose()
  state.close!()
  await expect(disposal).rejects.toThrow()
})

it("active cancellation requires launcher closure after root and guest acknowledgement", async () => {
  state.mode = "manual-close"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const handle = await (await backend.prepare(spec(), policy())).commit(() => {})
  const cancelled = handle.cancel("cancelled")
  let finished = false
  void cancelled.then(() => { finished = true })
  await vi.waitFor(() => expect(state.commands.some(value => value.type === "shutdown")).toBe(true))
  expect(finished).toBe(false)
  state.close!()
  expect(await cancelled).toMatchObject({ kind: "settled", root: { exitCode: 137 }, treeEmpty: true })
  await backend.dispose()
})

it("abandoning retained output after guest settlement does not send cancellation to a closed worker", async () => {
  state.mode = "late-abandon"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const handle = await (await backend.prepare(spec(), policy())).commit(() => {})
  for await (const _value of handle.io.output) break
  expect(handle.io.diagnostics!()).toEqual({ outputAbandoned: true, discardedOutputBytes: 6 })
  expect(await handle.settled).toMatchObject({ kind: "settled", treeEmpty: true })
  await backend.dispose()
})

it("preparation refusal rejects the request and releases acknowledged prelaunch ownership", async () => {
  state.mode = "prepare-refusal"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  await expect(backend.prepare(spec(), policy())).rejects.toThrow("owned root unsupported")
  expect(state.commands.some(value => value.type === "commit")).toBe(false)
  await backend.dispose()
})

it("commit refusal produces no handle and allows acknowledged rollback and disposal", async () => {
  state.mode = "commit-refusal"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const prepared = await backend.prepare(spec(), policy())
  await expect(prepared.commit(() => {})).rejects.toThrow("directory identity changed")
  await prepared.rollback()
  await backend.dispose()
})

it("prelaunch refusal waits for launcher closure after its acknowledgement", async () => {
  state.mode = "prepare-refusal-holdclose"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  const admission = backend.prepare(spec(), policy())
  let finished = false
  void admission.catch(() => { finished = true })
  await vi.waitFor(() => expect(state.commands.some(value => value.type === "prepare")).toBe(true))
  expect(finished).toBe(false)
  state.close!()
  await expect(admission).rejects.toThrow("owned root unsupported")
  await backend.dispose()
})

it("a refused frame without settlement acknowledgement remains incomplete", async () => {
  state.mode = "prepare-refusal-noack"
  const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
  await expect(backend.prepare(spec(), policy())).rejects.toThrow("cleanup incomplete")
  await expect(backend.dispose()).rejects.toThrow("disposal incomplete")
})
