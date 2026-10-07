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
  constructor(private readonly onCommand: (command: Record<string, any>, child: FakeChild) => void) {
    super()
    this.stdin = new Writable({ write: (bytes, _encoding, done) => {
      const command = JSON.parse(Buffer.from(bytes).toString()) as Record<string, any>
      this.sent.push(command.type)
      this.onCommand(command, this)
      done()
    } })
  }
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
