import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import * as syncFs from "node:fs"
import { normalizeSettings, SettingsStore, createLayeredStore, normalizeInstructions, resolveInstructionPolicy,
  previewLegacyInstructionImport, InstructionMigrationError, mutateSection, describeSection, type LegacyInstructionImport } from "../src/index.ts"
import { parseDocumentTolerant } from "../src/storage/json-patch.ts"

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile), readFile: vi.fn(actual.readFile) }
})
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>()
  return { ...actual, existsSync: vi.fn(actual.existsSync) }
})

const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "ih-instruction-policy-"))
  roots.push(root)
  vi.stubEnv("IH_CONFIG_DIR", join(root, "native"))
  return { root, profile: join(root, "settings.json") }
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
async function importFixture(raw: unknown = { model: "old", instructions: { enabled: false, maxBytes: 0 } }) {
  const { root, profile } = await fixture()
  const home = join(root, "home")
  const workspace = join(root, "work")
  await fs.mkdir(join(home, ".claude"), { recursive: true })
  await fs.mkdir(workspace)
  await fs.writeFile(join(home, "AGENTS.md"), "")
  await fs.writeFile(join(home, "CLAUDE.md"), "not selected")
  await fs.writeFile(join(home, ".claude", "CLAUDE.md"), "selected")
  const text = JSON.stringify(raw)
  await fs.writeFile(profile, text)
  const request: LegacyInstructionImport = { version: 1, profilePath: profile, legacyHome: home, legacyWorkspace: workspace, expectedDocumentHash: digest(text) }
  return { root, profile, home, workspace, request, text }
}

describe("instruction policy boundaries", () => {
  it("resolves only native exact paths without probing home and distinguishes absence from explicit denial", async () => {
    const { root, profile } = await fixture()
    vi.stubEnv("IH_CONFIG_DIR", join(root, "native"))
    await fs.writeFile(profile, JSON.stringify({ model: "new isolated", _revision: { llm: 4 }, onboarding: { welcomeNoticeVersion: "yes" } }))
    const probe = vi.spyOn(syncFs, "existsSync")
    probe.mockClear()
    const store = new SettingsStore({ path: profile })
    const saved = await store.load()
    expect(saved.instructions).toEqual({ enabled: true, maxBytes: 24000 })
    expect(resolveInstructionPolicy(saved.instructions).globalSources).toEqual([join(root, "native", "AGENTS.md"), join(root, "native", "CLAUDE.md")])
    expect(resolveInstructionPolicy({ enabled: false, maxBytes: 0, globalSources: [] }, root).globalSources).toEqual([])
    const exact = join(root, "custom", "CLAUDE.md")
    expect(resolveInstructionPolicy({ enabled: true, maxBytes: 99, globalSources: [exact] }, root).globalSources).toEqual([exact])
    expect(probe).not.toHaveBeenCalled()
    expect(JSON.parse(await fs.readFile(profile, "utf8"))).not.toHaveProperty("_instructionsMigration")
    for (const configDir of ["", "relative"]) expect(() => resolveInstructionPolicy(saved.instructions, configDir)).toThrow("absolute")
  })

  it("fails closed on malformed persisted globals without losing enabled or budget", async () => {
    const { root } = await fixture()
    const path = join(root, "AGENTS.md")
    for (const globalSources of [null, "auto", ["AGENTS.md"], [join(root, "other.md")], [path, path], Array(257).fill(path)]) {
      const policy = normalizeInstructions({ enabled: false, maxBytes: 0, globalSources })
      expect(policy).toEqual({ enabled: false, maxBytes: 0, globalSources: [] })
    }
    expect(normalizeInstructions({ maxBytes: Number.MAX_SAFE_INTEGER }).maxBytes).toBe(Number.MAX_SAFE_INTEGER)
    for (const maxBytes of [-1, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(normalizeInstructions({ maxBytes }).maxBytes).toBe(24000)
  })

  it("strict section mutations reject invalid aggregate paths, budgets and accessors, and isolate drafts", async () => {
    const { root, profile } = await fixture()
    const store = new SettingsStore({ path: profile })
    await store.load()
    const path = join(root, "AGENTS.md")
    for (const value of [[path, path], ["relative/AGENTS.md"], [join(root, "wrong.md")], Array.from({ length: 257 }, (_, i) => join(root, String(i), "AGENTS.md"))]) {
      await expect(mutateSection("instructions", [{ op: "set", path: ["globalSources"], value }], store)).rejects.toThrow()
    }
    for (const value of [-1, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) await expect(mutateSection("instructions", [{ op: "set", path: ["maxBytes"], value }], store)).rejects.toThrow()
    const getter = vi.fn(() => path)
    const paths: string[] = []
    Object.defineProperty(paths, "0", { get: getter, enumerable: true })
    await expect(mutateSection("instructions", [{ op: "set", path: ["globalSources"], value: paths }], store)).rejects.toThrow("accessors")
    expect(getter).not.toHaveBeenCalled()
    await mutateSection("instructions", [{ op: "set", path: ["globalSources"], value: [path] }], store, 0)
    await expect(mutateSection("instructions", [{ op: "set", path: ["globalSources", "1"], value: path }], store, 1)).rejects.toThrow()
    expect(store.getSectionRevision("instructions")).toBe(1)
    const draft = store.get()
    draft.instructions.enabled = false
    draft.instructions.globalSources!.push(join(root, "CLAUDE.md"))
    expect(describeSection("instructions", store).value).toEqual({ enabled: true, maxBytes: 24000, globalSources: [path] })
    await mutateSection("instructions", [{ op: "unset", path: ["globalSources"] }], store, 1)
    expect((await store.load()).instructions).not.toHaveProperty("globalSources")
  })
})

describe("explicit legacy import", () => {
  it.each([{ webSearchMode: "cached" }, { compaction: { auto: false } }, { instructions: { enabled: false } }])("accepts a valid recognized setting %j as explicit import eligibility", async (raw) => {
    const { request } = await importFixture(raw)
    expect(await previewLegacyInstructionImport(request)).toHaveLength(2)
  })
  it("previews exact ordered winners without reading rule bodies or writing the profile", async () => {
    const { request, home, profile, text } = await importFixture()
    const reads = vi.spyOn(fs, "readFile")
    reads.mockClear()
    expect(await previewLegacyInstructionImport(request)).toEqual([join(home, ".claude", "CLAUDE.md"), join(home, "AGENTS.md")])
    expect(reads.mock.calls.map(([path]) => path)).toEqual([profile])
    expect(await fs.readFile(profile, "utf8")).toBe(text)
  })

  it("selects an existing AGENTS directory as the old error winner instead of falling back", async () => {
    const { request, home } = await importFixture()
    await fs.unlink(join(home, "AGENTS.md"))
    await fs.mkdir(join(home, "AGENTS.md"))
    expect(await previewLegacyInstructionImport(request)).toEqual([join(home, ".claude", "CLAUDE.md"), join(home, "AGENTS.md")])
  })

  it.each(["home", "both"])("preserves legacy ordering when %s directories were already local ancestors", async (mode) => {
    const { request, home } = await importFixture()
    request.legacyWorkspace = mode === "home" ? join(home, "project") : join(home, ".claude", "project")
    expect(await previewLegacyInstructionImport(request)).toEqual(mode === "home"
      ? [join(home, ".claude", "CLAUDE.md"), join(home, "AGENTS.md")]
      : [join(home, "AGENTS.md"), join(home, ".claude", "CLAUDE.md")])
  })

  for (const raw of [{}, { _revision: { llm: 3 } }, { onboarding: { welcomeNoticeVersion: "yes" } }, { model: 10 }, { webSearchMode: "invalid" }, { compaction: { auto: "invalid" } }, []]) {
    it(`rejects noneligible profile ${JSON.stringify(raw)} before home probes`, async () => {
      const { request } = await importFixture(raw)
      const probes = vi.spyOn(syncFs, "existsSync")
      probes.mockClear()
      await expect(previewLegacyInstructionImport(request)).rejects.toBeInstanceOf(InstructionMigrationError)
      expect(probes).not.toHaveBeenCalled()
    })
  }
  it.each(["missing", "corrupt", "changed"])("rejects %s profiles before probing", async (mode) => {
    const { request, profile } = await importFixture()
    if (mode === "missing") await fs.unlink(profile)
    else await fs.writeFile(profile, mode === "corrupt" ? "{" : '{"model":"changed"}')
    const probes = vi.spyOn(syncFs, "existsSync")
    probes.mockClear()
    await expect(previewLegacyInstructionImport(request)).rejects.toMatchObject({ code: mode === "changed" ? "conflict" : "ineligible" })
    expect(probes).not.toHaveBeenCalled()
  })

  it("commits once, retains partial policy, preserves provenance through edits/reset, and replays without probes/writes", async () => {
    const { request, profile, home, text } = await importFixture()
    const store = new SettingsStore({ path: profile })
    await store.load()
    const saved = await store.migrateInstructions(request)
    expect(saved.instructions).toEqual({ enabled: false, maxBytes: 0, globalSources: [join(home, ".claude", "CLAUDE.md"), join(home, "AGENTS.md")] })
    expect(store.getSectionRevision("instructions")).toBe(1)
    const meta = JSON.parse(await fs.readFile(profile, "utf8"))._instructionsMigration
    expect(meta).toEqual({ version: 1, mode: "legacy-explicit", profilePath: profile, sourceHash: digest(text), globalSources: saved.instructions.globalSources, legacyWorkspace: request.legacyWorkspace })
    await store.set({ model: "edited" })
    expect(JSON.parse(await fs.readFile(profile, "utf8"))._instructionsMigration).toEqual(meta)
    await store.reset()
    expect(store.get().instructions).toEqual({ enabled: true, maxBytes: 24000 })
    const before = await fs.readFile(profile, "utf8")
    const probes = vi.spyOn(syncFs, "existsSync"); probes.mockClear()
    await store.migrateInstructions(request)
    expect(store.get().instructions).toEqual({ enabled: true, maxBytes: 24000 })
    expect(await fs.readFile(profile, "utf8")).toBe(before)
    expect(probes).not.toHaveBeenCalled()
    expect(JSON.parse(before)._instructionsMigration).toEqual(meta)
  })

  it("keeps explicit sources authoritative and allows only fresh digest-bound native transition", async () => {
    const { request, profile } = await importFixture({ model: "old", instructions: { globalSources: [] } })
    const store = new SettingsStore({ path: profile })
    await store.load()
    const probes = vi.spyOn(syncFs, "existsSync"); probes.mockClear()
    await expect(previewLegacyInstructionImport(request)).rejects.toMatchObject({ code: "inapplicable" })
    await store.migrateInstructions(request)
    expect(store.get().instructions.globalSources).toEqual([])
    expect(probes).not.toHaveBeenCalled()
    await store.reset()
    expect(JSON.parse(await fs.readFile(profile, "utf8"))._instructionsMigration.mode).toBe("native")
    await expect(store.migrateInstructions(request)).rejects.toMatchObject({ code: "conflict" })
    request.expectedDocumentHash = digest(await fs.readFile(profile, "utf8"))
    await store.migrateInstructions(request)
    expect(JSON.parse(await fs.readFile(profile, "utf8"))._instructionsMigration.mode).toBe("legacy-explicit")
  })

  it("validates strict metadata on load and import without treating unknown versions as permission", async () => {
    const { request, profile } = await importFixture()
    for (const meta of [null, { version: 2, mode: "native", profilePath: profile }, { version: 1, mode: "other", profilePath: profile },
      { version: 1, mode: "native", profilePath: "relative" }, { version: 1, mode: "legacy-explicit", profilePath: profile },
      { version: 1, mode: "native", profilePath: profile, globalSources: [] },
      { version: 1, mode: "native", profilePath: join(request.legacyHome, "other.json") },
      { version: 1, mode: "legacy-explicit", profilePath: profile, sourceHash: "x".repeat(64), globalSources: [], legacyWorkspace: request.legacyWorkspace },
      { version: 1, mode: "legacy-explicit", profilePath: profile, sourceHash: "a".repeat(64), globalSources: ["relative/AGENTS.md"], legacyWorkspace: request.legacyWorkspace },
      { version: 1, mode: "legacy-explicit", profilePath: profile, sourceHash: "a".repeat(64), globalSources: [], legacyWorkspace: "relative" }]) {
      await fs.writeFile(profile, JSON.stringify({ model: "old", _instructionsMigration: meta }))
      request.expectedDocumentHash = digest(await fs.readFile(profile, "utf8"))
      await expect(new SettingsStore({ path: profile }).load()).rejects.toMatchObject({ code: "invalid-metadata" })
      await expect(previewLegacyInstructionImport(request)).rejects.toMatchObject({ code: "invalid-metadata" })
      const layered = createLayeredStore({ files: [profile], instructionProfilePath: profile, watchIntervalMs: false })
      await expect(layered.load()).rejects.toMatchObject({ code: "invalid-metadata" })
    }
  })
})

describe("instruction import transactions", () => {
  it("rejects missing, mismatched, relative or duplicate host profile selections", async () => {
    const { request, profile, root } = await importFixture()
    for (const options of [
      { files: [profile] },
      { files: [profile], instructionProfilePath: join(root, "absent.json") },
      { files: [profile], instructionProfilePath: "settings.json" },
      { files: [profile, profile], instructionProfilePath: profile },
      { roots: { global: profile, workspace: profile } },
    ]) {
      const store = createLayeredStore({ ...options, watchIntervalMs: false })
      expect(() => store.migrateInstructions(request)).toThrow(InstructionMigrationError)
    }
  })
  for (const layered of [false, true]) {
    const mode = layered ? "layered" : "single"
    it(`rejects a foreign owning profile (${mode})`, async () => {
      const { request, profile, root } = await importFixture()
      const store = layered ? createLayeredStore({ files: [profile], instructionProfilePath: profile, watchIntervalMs: false }) : new SettingsStore({ path: profile })
      expect(() => store.migrateInstructions({ ...request, profilePath: join(root, "other.json") })).toThrow(InstructionMigrationError)
    })

    for (const operation of ["writeFile", "rename"] as const) {
      it(`retains saved state and owned temp cleanup after ${operation} failure (${mode})`, async () => {
        const { request, profile, root, text } = await importFixture()
        const store = layered ? createLayeredStore({ files: [profile], instructionProfilePath: profile, watchIntervalMs: false }) : new SettingsStore({ path: profile })
        await store.load()
        const before = store.get()
        const unrelated = `${profile}.tmp`
        await fs.writeFile(unrelated, "other owner")
        vi.spyOn(fs, operation).mockRejectedValueOnce(new Error("injected failure"))
        await expect(store.migrateInstructions(request)).rejects.toMatchObject({ code: "write-failed" })
        expect(store.get()).toEqual(before)
        expect(store.getSectionRevision("instructions")).toBe(0)
        expect(await fs.readFile(profile, "utf8")).toBe(text)
        expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual(["settings.json.tmp"])
        expect(await fs.readFile(unrelated, "utf8")).toBe("other owner")
      })
    }

    it(`detects a changed preimage immediately before rename (${mode})`, async () => {
      const { request, profile } = await importFixture()
      const store = layered ? createLayeredStore({ files: [profile], instructionProfilePath: profile, watchIntervalMs: false }) : new SettingsStore({ path: profile })
      await store.load()
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args: Parameters<typeof fs.writeFile>) => {
        await actual.writeFile(...args)
        await actual.writeFile(profile, '{"model":"foreign"}')
      })
      await expect(store.migrateInstructions(request)).rejects.toMatchObject({ code: "conflict" })
      expect(store.get().model).toBe("old")
      expect(await fs.readFile(profile, "utf8")).toBe('{"model":"foreign"}')
    })

    it(`serializes import, save, reset and caller-owned drafts; publishes only after rename (${mode})`, async () => {
      const { request, profile } = await importFixture()
      const store = layered ? createLayeredStore({ files: [profile], instructionProfilePath: profile, watchIntervalMs: false }) : new SettingsStore({ path: profile })
      await store.load()
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      let entered!: () => void
      const ready = new Promise<void>((resolve) => { entered = resolve })
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      vi.spyOn(fs, "rename").mockImplementationOnce(async (...args: Parameters<typeof fs.rename>) => {
        entered(); await held; await actual.rename(...args)
      })
      const pending = store.migrateInstructions(request)
      await ready
      expect(store.get().instructions).toEqual({ enabled: false, maxBytes: 0 })
      expect(store.getSectionRevision("instructions")).toBe(0)
      const draft = { instructions: { enabled: false, maxBytes: 7, globalSources: [] as string[] } }
      const edited = store.set(draft)
      draft.instructions.maxBytes = 999
      const reset = store.reset()
      release()
      expect((await pending).instructions.globalSources).toHaveLength(2)
      expect((await edited).instructions.maxBytes).toBe(7)
      expect((await reset).instructions).toEqual({ enabled: true, maxBytes: 24000 })
      expect(store.getSectionRevision("instructions")).toBe(3)
      expect((await store.load()).instructions).toEqual({ enabled: true, maxBytes: 24000 })
      const bytes = await fs.readFile(profile, "utf8")
      await store.migrateInstructions(request)
      expect(await fs.readFile(profile, "utf8")).toBe(bytes)
    })

    it(`rereads the preimage inside the queue after an ordinary save and recovers after failed reset (${mode})`, async () => {
      const { request, profile } = await importFixture()
      const store = layered ? createLayeredStore({ files: [profile], instructionProfilePath: profile, watchIntervalMs: false }) : new SettingsStore({ path: profile })
      await store.load()
      const save = store.set({ model: "new" })
      const migration = store.migrateInstructions(request)
      const rejection = expect(migration).rejects.toMatchObject({ code: "conflict" })
      await save
      await rejection
      request.expectedDocumentHash = digest(await fs.readFile(profile, "utf8"))
      await store.migrateInstructions(request)
      const before = store.get()
      const bytes = await fs.readFile(profile, "utf8")
      vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("failed reset"))
      await expect(store.reset()).rejects.toThrow("failed reset")
      expect(store.get()).toEqual(before)
      expect(store.getSectionRevision("instructions")).toBe(1)
      expect(await fs.readFile(profile, "utf8")).toBe(bytes)
      await store.reset()
      expect(store.get().instructions).toEqual({ enabled: true, maxBytes: 24000 })
      expect(store.getSectionRevision("instructions")).toBe(2)
    })

    it(`rejects a stale section edit queued behind a committing import (${mode})`, async () => {
      const { request, profile } = await importFixture()
      const store = layered ? createLayeredStore({ files: [profile], instructionProfilePath: profile, watchIntervalMs: false }) : new SettingsStore({ path: profile })
      await store.load()
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      let entered!: () => void
      const ready = new Promise<void>((resolve) => { entered = resolve })
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      vi.spyOn(fs, "rename").mockImplementationOnce(async (...args: Parameters<typeof fs.rename>) => {
        entered(); await held; await actual.rename(...args)
      })
      const migration = store.migrateInstructions(request)
      await ready
      const edit = mutateSection("instructions", [{ op: "set", path: ["enabled"], value: true }], store, 0)
      const rejected = expect(edit).rejects.toMatchObject({ expected: 0, actual: 1 })
      const independent = mutateSection("onboarding", [{ op: "set", path: ["welcomeNoticeVersion"], value: "accepted" }], store, 0)
      release()
      await migration
      await rejected
      await independent
      expect(store.getSectionRevision("onboarding")).toBe(1)
      expect(store.get().instructions.enabled).toBe(false)
      expect(store.get().instructions.globalSources).toHaveLength(2)
      expect(store.getSectionRevision("instructions")).toBe(1)
    })
  }

  it("patches only the explicit layered profile, preserving comments/unknown keys and higher policy", async () => {
    const { root, profile, home, request } = await importFixture({ model: "global", instructions: { maxBytes: 12 }, unknown: { keep: 1 } })
    const text = '// profile comment\n{\n"model":"global",\n// interior comment\n"instructions":{"maxBytes":12,"futureSetting":"keep"},\n"unknown":{"keep":1}\n}'
    await fs.writeFile(profile, text)
    request.expectedDocumentHash = digest(text)
    const workspaceProfile = join(root, "workspace.json")
    const higher = JSON.stringify({ model: "workspace", instructions: { enabled: false, maxBytes: 1, globalSources: [] } })
    await fs.writeFile(workspaceProfile, higher)
    const store = createLayeredStore({ roots: { global: profile, workspace: workspaceProfile }, watchIntervalMs: false })
    await store.load()
    await store.migrateInstructions(request)
    expect(store.get().instructions).toEqual({ enabled: false, maxBytes: 1, globalSources: [] })
    expect(store.getSectionRevision("instructions")).toBe(1)
    expect(await fs.readFile(workspaceProfile, "utf8")).toBe(higher)
    const migrated = await fs.readFile(profile, "utf8")
    expect(migrated).toContain("// profile comment")
    expect(migrated).toContain("// interior comment")
    const raw = parseDocumentTolerant(migrated)
    expect(raw.model).toBe("global")
    expect(raw.unknown).toEqual({ keep: 1 })
    expect(raw.instructions).toEqual({ enabled: true, maxBytes: 12, futureSetting: "keep", globalSources: [join(home, ".claude", "CLAUDE.md"), join(home, "AGENTS.md")] })
    await store.reset()
    expect((await store.load()).instructions).toEqual({ enabled: true, maxBytes: 24000 })
    await store.migrateInstructions(request)
    expect(store.get().instructions).toEqual({ enabled: true, maxBytes: 24000 })
    expect(await fs.readFile(profile, "utf8")).toBe(migrated)
    const accidental = createLayeredStore({ roots: { workspace: workspaceProfile }, instructionProfilePath: workspaceProfile, watchIntervalMs: false })
    expect(() => accidental.migrateInstructions({ ...request, profilePath: workspaceProfile })).toThrow("global profile")
    const unselected = createLayeredStore({ files: [profile, workspaceProfile], watchIntervalMs: false })
    expect(() => unselected.migrateInstructions(request)).toThrow("global profile")
  })

  it("treats each higher instructions section as a complete policy and inherits only when absent", async () => {
    const { root, profile, request, home } = await importFixture({ model: "global" })
    const workspaceProfile = join(root, "workspace.json")
    await fs.writeFile(workspaceProfile, JSON.stringify({ instructions: { enabled: false } }))
    const store = createLayeredStore({ roots: { global: profile, workspace: workspaceProfile }, watchIntervalMs: false })
    await store.load()
    await store.migrateInstructions(request)
    expect(store.get().instructions).toEqual({ enabled: false, maxBytes: 24000 })
    await fs.writeFile(workspaceProfile, JSON.stringify({ instructions: { maxBytes: 0 } }))
    expect((await store.load()).instructions).toEqual({ enabled: true, maxBytes: 0 })
    const globalText = await fs.readFile(profile, "utf8")
    await store.set({ fontSize: 16 })
    expect(store.get().instructions).toEqual({ enabled: true, maxBytes: 0 })
    expect(await fs.readFile(profile, "utf8")).toBe(globalText)
    expect(JSON.parse(await fs.readFile(workspaceProfile, "utf8"))).not.toHaveProperty("_instructionsMigration")
    await fs.writeFile(workspaceProfile, JSON.stringify({ fontSize: 16 }))
    expect((await store.load()).instructions.globalSources).toEqual([join(home, ".claude", "CLAUDE.md"), join(home, "AGENTS.md")])
    await store.reset()
    expect((await store.load()).instructions).toEqual({ enabled: true, maxBytes: 24000 })
    expect(await fs.readFile(profile, "utf8")).toBe(globalText)
    // Generic nested objects retain their existing deep-merge behavior.
    await fs.writeFile(workspaceProfile, JSON.stringify({ unknown: { instructions: { b: 2 } } }))
    await store.load()
    await store.set({ fontSize: 15 })
    expect(JSON.parse(await fs.readFile(workspaceProfile, "utf8")).unknown).toEqual({ instructions: { b: 2 } })
  })

  it("records native provenance only on a selected profile's first write, never an extra file", async () => {
    const { root, profile } = await fixture()
    const workspaceProfile = join(root, "workspace.json")
    await fs.writeFile(workspaceProfile, '{"model":"workspace"}')
    const writes = vi.spyOn(fs, "rename"); writes.mockClear()
    const store = createLayeredStore({ roots: { global: profile, workspace: workspaceProfile }, watchIntervalMs: false })
    await store.load()
    await store.set({ model: "workspace edited" })
    expect(writes.mock.calls.map(([, path]) => path)).toEqual([workspaceProfile])
    await expect(fs.readFile(profile)).rejects.toMatchObject({ code: "ENOENT" })
    expect(JSON.parse(await fs.readFile(workspaceProfile, "utf8"))).not.toHaveProperty("_instructionsMigration")
    const unselected = createLayeredStore({ files: [workspaceProfile], watchIntervalMs: false })
    await unselected.set({ model: "still unselected" })
    expect(JSON.parse(await fs.readFile(workspaceProfile, "utf8"))).not.toHaveProperty("_instructionsMigration")
    const global = createLayeredStore({ roots: { global: profile }, watchIntervalMs: false })
    await global.load()
    await expect(fs.readFile(profile)).rejects.toMatchObject({ code: "ENOENT" })
    await global.set({ model: "native" })
    expect(JSON.parse(await fs.readFile(profile, "utf8"))._instructionsMigration).toEqual({ version: 1, mode: "native", profilePath: profile })
  })
})

describe("saved instruction policy", () => {
  it("retains explicit denial and zero budget when normalizing an existing document", () => {
    expect(normalizeSettings({ instructions: { enabled: false, maxBytes: 0, globalSources: [] } })).toHaveProperty(
      "instructions", { enabled: false, maxBytes: 0, globalSources: [] },
    )
  })

  for (const layered of [false, true]) {
    it(`does not publish failed writes or advance revisions (${layered ? "layered" : "single"})`, async () => {
      const { profile } = await fixture()
      await fs.writeFile(profile, JSON.stringify({ model: "before" }))
      const store = layered ? createLayeredStore({ files: [profile], watchIntervalMs: false }) : new SettingsStore({ path: profile })
      await store.load()
      const before = store.get()
      vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("injected rename failure"))
      await expect(store.set({ onboarding: { welcomeNoticeVersion: "after" } })).rejects.toThrow("injected")
      expect(store.get()).toEqual(before)
      expect(store.getSectionRevision("onboarding")).toBe(0)
      expect(JSON.parse(await fs.readFile(profile, "utf8"))).toEqual({ model: "before" })
    })
  }
})
