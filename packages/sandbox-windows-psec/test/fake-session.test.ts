import { EventEmitter } from "node:events"
import { mkdtempSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { launchExecution } from "@i-harness/exec"
import type { CompiledSandboxPolicy, ProcessSpec } from "@i-harness/sandbox"

const state = vi.hoisted(() => ({ spawn: undefined as undefined | (() => unknown) }))
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: () => state.spawn!() }
})
import { createWindowsUnrestrictedBackend } from "../src/index.ts"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const helper = resolve(repo, "packages/sandbox-windows-psec/artifacts/win32-x64/i-harness-windows-helper.exe")
const manifestPath = resolve(repo, "packages/sandbox-windows-psec/artifacts/win32-x64/manifest.json")
const hash = "421d4a0ed72600d593f5cd1afe8012f49aa0e7ff1ab590486666cf5839e3d395"
const nativeError = { code: "native-failure", api: "CreateProcessW", nativeCode: 203, detail: "environment unavailable", cleanup: [] }

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin: Writable
  sent: string[] = []
  private pendingWrite?: (error?: Error) => void
  constructor(private readonly onCommand: (command: Record<string, any>, child: FakeChild) => void,
    private readonly holdWrite = false) {
    super()
    this.stdin = new Writable({ write: (bytes, _encoding, done) => {
      const command = JSON.parse(Buffer.from(bytes).toString()) as Record<string, any>
      this.sent.push(command.type)
      if (this.holdWrite) { this.pendingWrite = done; return }
      this.onCommand(command, this)
      done()
    } })
  }
  failWrite(error: Error) { this.pendingWrite!(error) }
  status(id: string, type: string, fields: Record<string, unknown> = {}) {
    this.stdout.write(JSON.stringify({ version: 1, id, type, ...fields }) + "\n")
  }
  frameEnd() { this.stderr.write(Buffer.from([3, 0, 0, 0, 0])) }
}

function input() {
  const root = mkdtempSync(resolve(repo, ".tmp", "sandbox-redesign-fake-"))
  const owner = Object.freeze({ sessionId: "fake-session" })
  const policy: CompiledSandboxPolicy = Object.freeze({ mode: "danger-full-access", owner,
    authorityRevision: "fake-1", authorityKind: "bound", primaryRoot: root, readable: "caller",
    authorityRoots: Object.freeze([root]), writeRoots: Object.freeze([]), referenceRoots: Object.freeze([]), fingerprint: "fake-fingerprint" })
  const spec: ProcessSpec = Object.freeze({ argv: Object.freeze([helper, "--self-child", "basic"]), cwd: root,
    env: Object.freeze({ EMPTY: "" }), owner, transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" })
  const backend = createWindowsUnrestrictedBackend({ manifestPath })
  const requirements = { writeIsolation: false, readIsolation: false, denyPaths: false, transport: "pipe" as const,
    lifetime: "complete-tree" as const, minimumAssurance: "unverified" as const }
  return { spec, policy, backend, requirements }
}

describe("fake protocol ownership", () => {
  it("owns stdin error events so a failed pipe write cannot crash the host", async () => {
    const child = new FakeChild(() => {}, true)
    state.spawn = () => child
    const f = input()
    const preparation = f.backend.prepare(f.spec, f.policy)
    await vi.waitFor(() => expect(child.sent).toContain("prepare"))
    expect(child.stdin.listenerCount("error")).toBeGreaterThan(0)
    child.failWrite(new Error("stdin fault"))
    const failure = await preparation.catch(cause => cause as AggregateError)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toMatchObject({ message: "stdin fault" })
  })

  it("aborts while native prepare is awaiting ready and acknowledges rollback", async () => {
    const child = new FakeChild((command, client) => {
      if (command.type === "release") client.status(command.id, "released", { resourcesReleased: true, errors: [] })
    })
    state.spawn = () => child
    const f = input()
    const controller = new AbortController()
    const preparation = f.backend.prepare(f.spec, f.policy, controller.signal)
    await vi.waitFor(() => expect(child.sent).toContain("prepare"))
    controller.abort("owner closed")
    await expect(Promise.race([
      preparation,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("prepare abort stalled")), 1000)),
    ])).rejects.toThrow(/aborted/)
    expect(child.sent).toEqual(["prepare", "release"])
  })

  it("backend dispose retries cleanup retained after public admission loses preparation", async () => {
    let releases = 0
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "commit") client.status(command.id, "error", { error: nativeError })
      else if (command.type === "release") client.status(command.id, "released", {
        resourcesReleased: ++releases === 2, errors: [nativeError],
      })
    })
    state.spawn = () => child
    const f = input()
    await expect(launchExecution({ ...f, validateAuthority: () => {} })).rejects.toThrow(/rollback failed/)
    await (f.backend as typeof f.backend & { dispose(): Promise<void> }).dispose()
    expect(child.sent).toEqual(["prepare", "commit", "release", "release"])
  })

  it("concurrent dispose shares one native release and closes future admission", async () => {
    let releaseId: string | undefined
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "release") releaseId = command.id
    })
    state.spawn = () => child
    const f = input()
    await f.backend.prepare(f.spec, f.policy)
    const backend = f.backend as typeof f.backend & { dispose(): Promise<void> }
    const first = backend.dispose()
    const second = backend.dispose()
    await vi.waitFor(() => expect(releaseId).toBeDefined())
    expect(child.sent.filter(type => type === "release")).toHaveLength(1)
    child.status(releaseId!, "released", { resourcesReleased: true, errors: [] })
    await Promise.all([first, second])
    await expect(backend.prepare(f.spec, f.policy)).rejects.toThrow(/disposed/)
  })

  it("dispose preserves a false native release for a later retry", async () => {
    let releases = 0
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "release") client.status(command.id, "released", {
        resourcesReleased: ++releases === 2, errors: [nativeError],
      })
    })
    state.spawn = () => child
    const f = input()
    await f.backend.prepare(f.spec, f.policy)
    const backend = f.backend as typeof f.backend & { dispose(): Promise<void> }
    const firstFailure = await backend.dispose().catch(cause => cause as AggregateError)
    expect(firstFailure).toBeInstanceOf(AggregateError)
    expect((firstFailure as AggregateError).errors[0]).toMatchObject({ message: expect.stringContaining("203") })
    expect(child.sent.filter(type => type === "release")).toHaveLength(1)
    await backend.dispose()
    expect(child.sent.filter(type => type === "release")).toHaveLength(2)
    await backend.dispose()
    expect(child.sent.filter(type => type === "release")).toHaveLength(2)
  })

  it("a late successful release after timeout still clears backend ownership", async () => {
    const releaseIds: string[] = []
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "release") {
        releaseIds.push(command.id)
        if (releaseIds.length > 1) client.status(command.id, "released", { resourcesReleased: false, errors: [nativeError] })
      }
    })
    state.spawn = () => child
    const f = input()
    await f.backend.prepare(f.spec, f.policy)
    const backend = f.backend as typeof f.backend & { dispose(): Promise<void> }
    vi.useFakeTimers()
    try {
      const first = backend.dispose()
      expect(releaseIds).toHaveLength(1)
      const failure = expect(first).rejects.toThrow(/cleanup incomplete/)
      await vi.advanceTimersByTimeAsync(12000)
      await failure
      child.status(releaseIds[0]!, "released", { resourcesReleased: true, errors: [] })
      for (let turn = 0; turn < 10; turn++) await Promise.resolve()
      await backend.dispose()
      expect(releaseIds).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it("overlapping timed-out and retry releases join one confirmed cleanup", async () => {
    const releaseIds: string[] = []
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "release") releaseIds.push(command.id)
    })
    state.spawn = () => child
    const f = input()
    await f.backend.prepare(f.spec, f.policy)
    const backend = f.backend as typeof f.backend & { dispose(): Promise<void> }
    vi.useFakeTimers()
    try {
      const first = backend.dispose()
      expect(releaseIds).toHaveLength(1)
      const firstFailure = expect(first).rejects.toThrow(/cleanup incomplete/)
      await vi.advanceTimersByTimeAsync(12000)
      await firstFailure
      const second = backend.dispose()
      expect(releaseIds).toHaveLength(2)
      const confirmed = expect(second).resolves.toBeUndefined()
      child.status(releaseIds[0]!, "released", { resourcesReleased: true, errors: [nativeError] })
      await confirmed
      child.status(releaseIds[1]!, "released", { resourcesReleased: true, errors: [nativeError] })
      await backend.dispose()
      expect(releaseIds).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })

  it("confirmed cleanup still rejects unrelated unfinished input", async () => {
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "commit") client.status(command.id, "started", { pid: 1234 })
      else if (command.type === "release") client.status(command.id, "released", { resourcesReleased: true, errors: [] })
    })
    state.spawn = () => child
    const f = input()
    const prepared = await f.backend.prepare(f.spec, f.policy)
    const handle = await prepared.commit(() => {})
    const writing = handle.io.write(Buffer.from("unacknowledged"))
    await vi.waitFor(() => expect(child.sent).toContain("input"))
    const failure = expect(writing).rejects.toThrow(/released before pending response/)
    await (f.backend as typeof f.backend & { dispose(): Promise<void> }).dispose()
    await failure
  })

  it("malformed released status cannot retire cleanup ownership", async () => {
    let releases = 0
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "release") {
        releases++
        client.status(command.id, "released", releases === 1
          ? { resourcesReleased: true } : { resourcesReleased: true, errors: [] })
      }
    })
    state.spawn = () => child
    const f = input()
    await f.backend.prepare(f.spec, f.policy)
    const backend = f.backend as typeof f.backend & { dispose(): Promise<void> }
    await expect(backend.dispose()).rejects.toThrow(/cleanup incomplete/)
    await backend.dispose()
    expect(releases).toBe(2)
  })

  it("failed commit keeps lifecycle ownership and sends release without a second launch", async () => {
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "commit") {
        client.status(command.id, "error", { error: nativeError })
        client.status(command.id, "root-exit", { exitCode: null, observationError: nativeError })
        client.status(command.id, "tree-empty", { activeProcesses: 0 })
        client.frameEnd()
        client.status(command.id, "io-settled", { outputAbandoned: false, discardedBytes: 0, errors: [] })
      } else if (command.type === "release") client.status(command.id, "released", { resourcesReleased: true, errors: [] })
    })
    state.spawn = () => child
    const f = input()
    await expect(launchExecution({ ...f, validateAuthority: () => {} })).rejects.toThrow(/203/)
    expect(child.sent).toEqual(["prepare", "commit", "release"])
  })

  it("helper exit after root-exit leaves the tree incomplete", async () => {
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "commit") {
        client.status(command.id, "started", { pid: 1234 })
        client.status(command.id, "root-exit", { exitCode: 0, observationError: null })
        queueMicrotask(() => client.emit("exit", 1, null))
      }
    })
    state.spawn = () => child
    const f = input()
    const handle = await launchExecution({ ...f, validateAuthority: () => {} })
    expect(await handle.rootExited).toEqual({ exitCode: 0 })
    expect(await handle.settled).toMatchObject({ kind: "incomplete", phase: "tree" })
    expect(child.sent).not.toContain("release")
  })

  it("release failure retains native ownership for an acknowledged retry", async () => {
    let releases = 0
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "commit") {
        client.status(command.id, "started", { pid: 1234 })
        client.status(command.id, "root-exit", { exitCode: 0, observationError: null })
        client.status(command.id, "tree-empty", { activeProcesses: 0 })
        client.frameEnd()
        client.status(command.id, "io-settled", { outputAbandoned: false, discardedBytes: 0, errors: [] })
      } else if (command.type === "release") {
        client.status(command.id, "released", { resourcesReleased: ++releases === 2,
          errors: releases === 1 ? [nativeError] : [] })
      }
    })
    state.spawn = () => child
    const f = input()
    const handle = await launchExecution({ ...f, validateAuthority: () => {} })
    expect(await handle.settled).toMatchObject({ kind: "incomplete", phase: "release" })
    expect(await handle.release()).toMatchObject({ kind: "settled", resourcesReleased: true })
    expect(child.sent.filter(type => type === "release")).toHaveLength(2)
  })

  it("normal I/O refuses a missing output-end even after io-settled", async () => {
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "commit") {
        client.status(command.id, "started", { pid: 1234 })
        client.status(command.id, "root-exit", { exitCode: 0, observationError: null })
        client.status(command.id, "tree-empty", { activeProcesses: 0 })
        client.status(command.id, "io-settled", { outputAbandoned: false, discardedBytes: 0, errors: [] })
        client.stderr.end()
      }
    })
    state.spawn = () => child
    const f = input()
    const handle = await launchExecution({ ...f, validateAuthority: () => {} })
    expect(await handle.settled).toMatchObject({ kind: "incomplete", phase: "io" })
    expect(child.sent).not.toContain("release")
  })

  it("trusted cancellation abandonment permits a partial final frame and records loss", async () => {
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "commit") client.status(command.id, "started", { pid: 1234 })
      else if (command.type === "cancel") {
        client.status(command.id, "ack")
        client.status("r2", "root-exit", { exitCode: 1, observationError: null })
        client.status("r2", "tree-empty", { activeProcesses: 0 })
        client.stderr.write(Buffer.from([0, 4, 0, 0, 0, 65]))
        client.status("r2", "io-settled", { outputAbandoned: true, discardedBytes: 4, errors: [] })
        client.stderr.end()
      } else if (command.type === "release") client.status(command.id, "released", { resourcesReleased: true, errors: [] })
    })
    state.spawn = () => child
    const f = input()
    const handle = await launchExecution({ ...f, validateAuthority: () => {} })
    expect((await handle.cancel("cancelled")).kind).toBe("settled")
    expect(handle.io.diagnostics?.()).toEqual({ outputAbandoned: true, discardedOutputBytes: 4 })
  })

  it("preserves an unknown root observation with independent tree and I/O settlement", async () => {
    const child = new FakeChild((command, client) => {
      if (command.type === "prepare") client.status(command.id, "ready", {
        effectivePolicyDigest: "0".repeat(64), policyFingerprint: "fake-fingerprint", helperSha256: hash })
      else if (command.type === "commit") {
        client.status(command.id, "started", { pid: 1234 })
        client.status(command.id, "root-exit", { exitCode: null, observationError: nativeError })
        client.status(command.id, "tree-empty", { activeProcesses: 0 })
        client.frameEnd()
        client.status(command.id, "io-settled", { outputAbandoned: false, discardedBytes: 0, errors: [] })
      } else if (command.type === "release") client.status(command.id, "released", { resourcesReleased: true, errors: [] })
    })
    state.spawn = () => child
    const f = input()
    const handle = await launchExecution({ ...f, validateAuthority: () => {} })
    expect(await handle.rootExited).toMatchObject({ exitCode: null, observationError: expect.stringContaining("203") })
    expect(await handle.settled).toMatchObject({ kind: "settled", treeEmpty: true, ioSettled: true, resourcesReleased: true })
    expect((await handle.release()).kind).toBe("settled")
    expect(child.sent.filter(type => type === "release")).toHaveLength(1)
  })
})
