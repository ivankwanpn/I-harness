import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SettingsStore } from "../src/index.ts"

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
const realFs = await vi.importActual<typeof fs>("node:fs/promises")
const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "ih-observed-settings-"))
  roots.push(root)
  const path = join(root, "settings.json")
  return { root, path, store: new SettingsStore({ path }) }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})
const policy = { enabled: false, maxBytes: 51, globalSources: [] }
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

describe("observed saved settings load", () => {
  it("publishes the comment-tolerant captured bytes with exact source stamp and detached settings", async () => {
    const f = await fixture()
    const bytes = Buffer.from(`// exact source bytes\r\n${JSON.stringify({ instructions: policy, _revision: { instructions: 7 } })}\r\n`)
    await fs.writeFile(f.path, bytes)
    vi.mocked(fs.readFile).mockClear()
    const result = await f.store.loadObserved()
    expect(result).toMatchObject({ kind: "loaded", settings: { instructions: policy } })
    expect(result.stamp).toEqual({ kind: "present", sha256: digest(bytes) })
    expect(fs.readFile).toHaveBeenCalledExactlyOnceWith(f.path)
    if (result.kind !== "loaded") throw new Error("present fixture missing")
    result.settings.instructions.enabled = true
    result.settings.instructions.globalSources!.push(join(f.root, "AGENTS.md"))
    expect(f.store.get().instructions).toEqual(policy)
    expect(f.store.getSectionRevision("instructions")).toBe(7)
  })

  it("defaults absent instruction fields while preserving explicit empty globals", async () => {
    const f = await fixture()
    for (const [instructions, expected] of [[undefined, { enabled: true, maxBytes: 24000 }], [{}, { enabled: true, maxBytes: 24000 }], [{ globalSources: [] }, { enabled: true, maxBytes: 24000, globalSources: [] }], [{ enabled: false }, { enabled: false, maxBytes: 24000 }]] as const) {
      await fs.writeFile(f.path, JSON.stringify({ instructions }))
      expect(await f.store.loadObserved()).toMatchObject({ kind: "loaded", settings: { instructions: expected } })
      expect(f.store.get().instructions).toEqual(expected)
    }
  })

  it("rejects corrupt/nonobject and invalid supplied policy without changing last-good state or revision", async () => {
    const f = await fixture()
    await fs.writeFile(f.path, JSON.stringify({ instructions: policy, _revision: { instructions: 8 } }))
    await f.store.loadObserved()
    const saved = f.store.get()
    const invalid = ["{private-observed-credential", "null", "[]", JSON.stringify({ instructions: null }), JSON.stringify({ instructions: [] }), ...[
      { enabled: "private-observed-credential" }, { maxBytes: -1 }, { maxBytes: 1.5 }, { maxBytes: 9007199254740992 }, { globalSources: ["relative/AGENTS.md"] }, { globalSources: null }, { unknown: true },
    ].map(instructions => JSON.stringify({ instructions }))]
    for (const text of invalid) {
      await fs.writeFile(f.path, text)
      vi.mocked(fs.readFile).mockClear()
      const error = await f.store.loadObserved().then(() => { throw new Error("invalid source accepted") }, error => error)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain("private-observed-credential")
      expect(fs.readFile).toHaveBeenCalledExactlyOnceWith(f.path)
      expect(f.store.get()).toEqual(saved)
      expect(f.store.getSectionRevision("instructions")).toBe(8)
    }
    const fresh = new SettingsStore({ path: f.path })
    await expect(fresh.loadObserved()).rejects.toThrow()
    expect(fresh.isLoaded()).toBe(false)
    expect((await fresh.load()).instructions).toEqual({ enabled: true, maxBytes: 24000 })
  })

  it("validates original migration provenance and preserves revisions and unknown data through the original writer", async () => {
    const f = await fixture()
    const meta = { version: 1, mode: "legacy-explicit", profilePath: f.path, sourceHash: "a".repeat(64), globalSources: [], legacyWorkspace: f.root }
    await fs.writeFile(f.path, JSON.stringify({ instructions: policy, _instructionsMigration: meta, _revision: { instructions: 11 }, extension: { token: "private-observed-credential" } }))
    await f.store.loadObserved()
    const saved = f.store.get()
    const validDocument = await realFs.readFile(f.path, "utf8")
    for (const bad of [null, { ...meta, profilePath: join(f.root, "other.json") }, { ...meta, sourceHash: "bad" }, { ...meta, extra: true }, { version: 1, mode: "native", profilePath: f.path, globalSources: [] }]) {
      await fs.writeFile(f.path, JSON.stringify({ _instructionsMigration: bad }))
      await expect(f.store.loadObserved()).rejects.toThrow()
      expect(f.store.get()).toEqual(saved)
      expect(f.store.getSectionRevision("instructions")).toBe(11)
    }
    const invalidDocument = await realFs.readFile(f.path, "utf8")
    await expect(f.store.set({ compaction: { auto: false } })).rejects.toThrow()
    expect(await realFs.readFile(f.path, "utf8")).toBe(invalidDocument)
    expect(f.store.get()).toEqual(saved)
    await fs.writeFile(f.path, validDocument)
    await f.store.set({ compaction: { auto: false } })
    const persisted = JSON.parse(await realFs.readFile(f.path, "utf8"))
    expect(persisted._instructionsMigration).toEqual(meta)
    expect(persisted._revision.instructions).toBe(11)
    expect(persisted.extension).toEqual({ token: "private-observed-credential" })
  })

  it("only treats ENOENT as missing, initializes first-run defaults once and retains later last-good state", async () => {
    const f = await fixture()
    const validate = vi.fn()
    vi.mocked(fs.readFile).mockClear()
    expect(await f.store.loadObserved({ validate })).toEqual({ kind: "missing", stamp: { kind: "missing" } })
    expect(f.store.isLoaded()).toBe(true)
    expect(validate).not.toHaveBeenCalled()
    await f.store.set({ instructions: policy })
    // A mutation checks the current saved base even after an observed missing read.
    expect(fs.readFile).toHaveBeenCalledTimes(2)
    const saved = f.store.get()
    const revision = f.store.getSectionRevision("instructions")
    await fs.unlink(f.path)
    expect(await f.store.loadObserved()).toEqual({ kind: "missing", stamp: { kind: "missing" } })
    expect(f.store.get()).toEqual(saved)
    expect(f.store.getSectionRevision("instructions")).toBe(revision)
    const directoryDocument = new SettingsStore({ path: f.root })
    await expect(directoryDocument.loadObserved()).rejects.toThrow()
    expect(directoryDocument.isLoaded()).toBe(false)
    for (const code of ["ENOTDIR", "EACCES", "EIO"]) {
      vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error("private-observed-credential"), { code }))
      await expect(f.store.loadObserved()).rejects.toThrow()
      expect(f.store.get()).toEqual(saved)
      expect(f.store.getSectionRevision("instructions")).toBe(revision)
    }
    expect((await directoryDocument.load()).instructions).toEqual({ enabled: true, maxBytes: 24000 })
  })

  it("validates one isolated recursively frozen copy and rejects even undefined throws without private diagnostics", async () => {
    const f = await fixture()
    await fs.writeFile(f.path, JSON.stringify({ instructions: policy, extension: { rows: [{ token: "private-observed-credential" }] } }))
    let calls = 0
    await f.store.loadObserved({ validate(document) {
      calls++
      const extension = document.extension as { rows: { token: string }[] }
      for (const item of [document, document.instructions, extension, extension.rows, extension.rows[0]]) expect(Object.isFrozen(item)).toBe(true)
      expect(() => { (document.instructions as { enabled: boolean }).enabled = true }).toThrow()
      expect(() => { extension.rows[0]!.token = "changed" }).toThrow()
    } })
    expect(calls).toBe(1)
    expect(f.store.get().instructions).toEqual(policy)
    const saved = f.store.get()
    const diagnostics = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")]
    for (const thrown of [undefined, new Error("private-observed-credential"), { token: "private-observed-credential" }]) {
      const outcome = await f.store.loadObserved({ validate() { throw thrown } }).then(() => ({ rejected: false, error: undefined }), error => ({ rejected: true, error }))
      expect(outcome.rejected).toBe(true)
      expect(String(outcome.error)).not.toContain("private-observed-credential")
      expect(f.store.get()).toEqual(saved)
    }
    expect(diagnostics.flatMap(spy => spy.mock.calls)).toEqual([])
    await f.store.set({ compaction: { auto: false } })
    expect(JSON.parse(await realFs.readFile(f.path, "utf8")).extension.rows[0].token).toBe("private-observed-credential")
  })

  it("captures the validator before queueing and serializes actual set/reset after the captured-byte publication", async () => {
    const f = await fixture()
    const bytes = Buffer.from(`// captured before atomic replacement\n${JSON.stringify({ instructions: policy, _revision: { instructions: 3 } })}`)
    await fs.writeFile(f.path, bytes)
    const entered = barrier()
    const held = barrier()
    vi.mocked(fs.readFile).mockImplementationOnce(async (...args) => {
      const captured = await realFs.readFile(...args)
      entered.release()
      await held.promise
      return captured
    })
    const validated: unknown[] = []
    const options = { validate: (document: Readonly<Record<string, unknown>>) => { validated.push(document.instructions) } }
    const observed = f.store.loadObserved(options)
    await entered.promise
    const written = f.store.set({ compaction: { auto: false } })
    const reset = f.store.reset()
    options.validate = () => { throw new Error("replacement callback must not run") }
    const replacement = join(f.root, "replacement.json")
    await fs.writeFile(replacement, JSON.stringify({ instructions: { enabled: true, maxBytes: 999 } }))
    await fs.rename(replacement, f.path)
    expect(f.store.isLoaded()).toBe(false)
    held.release()
    expect(await observed).toMatchObject({ kind: "loaded", settings: { instructions: policy }, stamp: { kind: "present", sha256: digest(bytes) } })
    expect(validated).toEqual([policy])
    expect(await written).toMatchObject({ compaction: { auto: false }, instructions: { enabled: true, maxBytes: 999 } })
    expect((await reset).instructions).toEqual({ enabled: true, maxBytes: 24000 })
    expect(f.store.getSectionRevision("instructions")).toBe(1)
    expect(f.store.get().compaction.auto).toBe(true)
  })

  it("awaits asynchronous validation inside the queue before publishing captured bytes or running a queued set", async () => {
    const f = await fixture()
    const bytes = Buffer.from(`// async captured source\n${JSON.stringify({ instructions: policy, _revision: { instructions: 6 } })}`)
    await fs.writeFile(f.path, bytes)
    const entered = barrier()
    const held = barrier()
    let completed = false
    const observed = f.store.loadObserved({ validate: async document => {
      expect(Object.isFrozen(document.instructions)).toBe(true)
      entered.release()
      await held.promise
      expect(document.instructions).toEqual(policy)
    } })
    const completion = observed.then(() => { completed = true })
    await entered.promise
    const written = f.store.set({ compaction: { auto: false } })
    try {
      // One event-loop turn lets an incorrectly detached callback publish; this
      // is a scheduler checkpoint, not a timer or simulated validator result.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(completed).toBe(false)
      expect(f.store.isLoaded()).toBe(false)
      expect(f.store.getSectionRevision("instructions")).toBe(0)
      expect(await realFs.readFile(f.path)).toEqual(bytes)
      const replacement = join(f.root, "async-replacement.json")
      await fs.writeFile(replacement, JSON.stringify({ instructions: { enabled: true, maxBytes: 999 } }))
      await fs.rename(replacement, f.path)
    } finally {
      held.release()
      await completion
      await written
    }
    expect(await observed).toMatchObject({ kind: "loaded", settings: { instructions: policy }, stamp: { kind: "present", sha256: digest(bytes) } })
    expect(await written).toMatchObject({ instructions: { enabled: true, maxBytes: 999 }, compaction: { auto: false } })
    expect(f.store.getSectionRevision("instructions")).toBe(0)
  })

  it("joins asynchronous validator rejection without publishing or losing last-good revisions, including on a fresh store", async () => {
    const f = await fixture()
    await fs.writeFile(f.path, JSON.stringify({ instructions: policy, _revision: { instructions: 9 } }))
    await f.store.loadObserved()
    const saved = f.store.get()
    await fs.writeFile(f.path, JSON.stringify({ instructions: { enabled: true, maxBytes: 999 }, _revision: { instructions: 100 } }))
    for (const store of [f.store, new SettingsStore({ path: f.path })]) {
      const wasLoaded = store.isLoaded()
      const previous = store.get()
      const previousRevision = store.getSectionRevision("instructions")
      const entered = barrier()
      const held = barrier()
      const validation = held.promise.then(() => { throw new Error("private-observed-credential") })
      // Keep the pre-fix orphan rejection handled by the fixture so RED can
      // specifically assert the owner wrongly resolved rather than crash Vitest.
      void validation.catch(() => {})
      const observed = store.loadObserved({ validate() { entered.release(); return validation } })
      const outcome = observed.then(() => ({ rejected: false, error: undefined }), error => ({ rejected: true, error }))
      await entered.promise
      held.release()
      const result = await outcome
      expect(result.rejected).toBe(true)
      expect(String(result.error)).not.toContain("private-observed-credential")
      expect(store.isLoaded()).toBe(wasLoaded)
      expect(store.get()).toEqual(previous)
      expect(store.getSectionRevision("instructions")).toBe(previousRevision)
    }
    expect(f.store.get()).toEqual(saved)
    // A rejected async observation does not poison the original write queue.
    expect((await f.store.set({ compaction: { auto: false } })).instructions).toMatchObject({ enabled: true, maxBytes: 999 })
    expect(f.store.getSectionRevision("instructions")).toBe(100)
  })
})
