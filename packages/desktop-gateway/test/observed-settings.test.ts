import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SettingsStore } from "@i-harness/settings"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
import { withDesktopSettings } from "../src/settings-file.ts"

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
const realFs = await vi.importActual<typeof fs>("node:fs/promises")

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "ih-observed-desktop-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const sessionDir = join(root, "sessions")
  const settingsPath = join(root, "settings.json")
  await fs.mkdir(workspace)
  return { root, workspace, sessionDir, settingsPath, credentialsPath: join(root, "credentials.json") }
}
const instructions = { enabled: false, maxBytes: 41, globalSources: [] }
const commentDocument = `// a hand-edited profile\n${JSON.stringify({ sandboxMode: "workspace-write", approvalMode: "delegate", instructions })}\n`
function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function replaceAfterCapture(path: string, replacement: string, start: () => Promise<unknown>) {
  const captured = barrier()
  const held = barrier()
  vi.mocked(fs.readFile).mockImplementationOnce(async (...args) => {
    const bytes = await realFs.readFile(...args)
    captured.release()
    await held.promise
    return bytes
  })
  const pending = start()
  try {
    await captured.promise
    await fs.writeFile(`${path}.replacement`, replacement)
    await fs.rename(`${path}.replacement`, path)
  } finally { held.release() }
  return pending
}

describe("Desktop observed saved settings", () => {
  it("starts the actual host from a valid comment-bearing saved profile", async () => {
    const f = await fixture()
    await fs.writeFile(f.settingsPath, commentDocument)
    expect((await new SettingsStore({ path: f.settingsPath }).load()).instructions).toEqual(instructions)
    const frames: RpcMessage[] = []
    const host = await createDesktopHost({ ...f, onWrite: frame => frames.push(frame) })
    try {
      await host.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      await host.handleLine(encodeFrame(makeRequest(2, "desktop/sandbox/state", {})))
      const reply = frames.find(frame => "id" in frame && frame.id === 2)
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) throw new Error("sandbox reply missing")
      expect(reply.result).toMatchObject({ mode: "workspace-write" })
    } finally { await host.close() }
  }, 20000)

  it("runs the actual locked edit against a valid comment-bearing saved profile", async () => {
    const f = await fixture()
    await fs.writeFile(f.settingsPath, commentDocument)
    const saved = await withDesktopSettings(f.settingsPath, async store => {
      expect(store.get()).toMatchObject({ sandboxMode: "workspace-write", instructions })
      return store.set({ compaction: { auto: false } })
    })
    expect(saved).toMatchObject({ compaction: { auto: false }, instructions })
    expect((await new SettingsStore({ path: f.settingsPath }).load()).instructions).toEqual(instructions)
  })

  it("does not swap the checked document for a second read before locked work", async () => {
    const f = await fixture()
    await fs.writeFile(f.settingsPath, JSON.stringify({ sandboxMode: "workspace-write", instructions }))
    const replacement = JSON.stringify({ sandboxMode: "private-observed-credential", instructions: { enabled: "invalid" } })
    const saved = await replaceAfterCapture(f.settingsPath, replacement, () => withDesktopSettings(f.settingsPath, async store => store.get()))
    expect(saved).toMatchObject({ sandboxMode: "workspace-write", instructions })
    expect(await realFs.readFile(f.settingsPath, "utf8")).toBe(replacement)
  })

  it("uses the validated captured snapshot for the actual host startup policy after replacement", async () => {
    const f = await fixture()
    await fs.writeFile(f.settingsPath, JSON.stringify({ sandboxMode: "workspace-write", instructions }))
    // Later explicit policy synchronizations may read a new valid document. This
    // gate observes the actual startup owner's get() calls before those reloads.
    const get = vi.spyOn(SettingsStore.prototype, "get")
    const pending = replaceAfterCapture(f.settingsPath, JSON.stringify({ sandboxMode: "read-only", instructions: { enabled: true, maxBytes: 999 } }), () => createDesktopHost({ ...f, onWrite() {} }))
    const host = await pending as Awaited<ReturnType<typeof createDesktopHost>>
    try {
      expect(get.mock.results[0]?.value).toMatchObject({ sandboxMode: "workspace-write", instructions })
      expect(get.mock.results[1]?.value).toMatchObject({ sandboxMode: "workspace-write", instructions })
    } finally { await host.close() }
  }, 20000)

  it("rejects invalid saved documents at both actual entry points, keeps work uncalled, and releases the lease for retry", async () => {
    const f = await fixture()
    const diagnostics = [vi.spyOn(console, "error"), vi.spyOn(console, "warn")]
    let worked = 0
    const invalid = ["{private-observed-credential", "null", "[]", ...[
      { instructions: { enabled: "private-observed-credential" } },
      { instructions: { globalSources: ["relative/AGENTS.md"] } },
      { sandboxMode: "private-observed-credential" }, { approvalMode: "unknown" },
      { approvalMode: "full-access", sandboxMode: "workspace-write" },
      { windowsSandboxBackend: "unknown" }, { webSearchMode: "unknown" },
      { wslExecution: { distribution: "bad\nname" } }, { wslExecution: { networkAccess: "yes" } },
      { wslExecution: { unknown: true } }, { wslExecution: [] },
      { _instructionsMigration: { version: 1, mode: "native", profilePath: join(f.root, "other.json") } },
    ].map(value => JSON.stringify(value))]
    for (const text of invalid) {
      await fs.writeFile(f.settingsPath, text)
      for (const run of [() => createDesktopHost({ ...f, onWrite() {} }), () => withDesktopSettings(f.settingsPath, async () => { worked++; return true })]) {
        const error = await run().then(() => { throw new Error("invalid document accepted") }, error => error)
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).not.toContain("private-observed-credential")
      }
      expect(worked).toBe(0)
      await fs.writeFile(f.settingsPath, commentDocument)
      expect(await withDesktopSettings(f.settingsPath, async store => store.get().instructions)).toEqual(instructions)
    }
    expect(diagnostics.flatMap(spy => spy.mock.calls)).toEqual([])
  }, 20000)

  it("initializes a missing profile once inside the actual lease and starts a first-run host", async () => {
    const f = await fixture()
    vi.mocked(fs.readFile).mockClear()
    const saved = await withDesktopSettings(f.settingsPath, async store => {
      expect(store.isLoaded()).toBe(true)
      return store.set({ instructions })
    })
    expect(saved.instructions).toEqual(instructions)
    expect(fs.readFile).toHaveBeenCalledExactlyOnceWith(f.settingsPath)
    await fs.unlink(f.settingsPath)
    const frames: RpcMessage[] = []
    const host = await createDesktopHost({ ...f, onWrite: frame => frames.push(frame) })
    try {
      await host.handleLine(encodeFrame(makeRequest(10, "initialize", {})))
      await host.handleLine(encodeFrame(makeRequest(11, "desktop/sandbox/state", {})))
      const reply = frames.find(frame => "id" in frame && frame.id === 11)
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) throw new Error("sandbox reply missing")
      expect(reply.result).toMatchObject({ mode: "workspace-write" })
    } finally { await host.close() }
  }, 20000)
})
