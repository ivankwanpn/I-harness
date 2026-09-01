// M27 R-E10: layered settings (global < workspace < project, last wins),
// polling hot-reload, comment-preserving leaf-patch writes.
import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLayeredStore, resolveLayeredSources, watchSettings, mergeRawLayers, type LayerSource } from "../src/index.ts"
import { mutateSection } from "../src/sections.ts"

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ih-layers-"))
}

describe("resolveLayeredSources (global < workspace < project)", () => {
  it("orders sources low → high and labels them", async () => {
    const root = await tmpRoot()
    try {
      for (const name of ["g.json", "w.json", "p.json"]) {
        await writeFile(join(root, name), "{}", "utf8")
      }
      const sources = resolveLayeredSources({
        global: join(root, "g.json"),
        workspace: join(root, "w.json"),
        project: join(root, "p.json"),
      })
      expect(sources.map((s) => s.label)).toEqual(["global", "workspace", "project"])
      expect(sources[0]!.order).toBeLessThan(sources[1]!.order)
      expect(sources[2]!.order).toBeGreaterThan(sources[1]!.order)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("skips a missing configured root", async () => {
    const sources = resolveLayeredSources({ workspace: "/definitely/not/here/w.json" })
    expect(sources).toEqual([])
  })
})

describe("mergeRawLayers", () => {
  it("last wins per key, deep-merged across layers", () => {
    const merged = mergeRawLayers([
      { label: "global", order: 0, path: null, raws: { model: "g-model", theme: "dark" } },
      { label: "project", order: 2, path: null, raws: { model: "p-model", plugins: { bash: false } } },
    ])
    expect(merged).toEqual({ model: "p-model", theme: "dark", plugins: { bash: false } })
  })
})

describe("createLayeredStore", () => {
  it("global < workspace < project: the project layer wins", async () => {
    const root = await tmpRoot()
    try {
      await writeFile(join(root, "g.json"), JSON.stringify({ model: "g-model" }), "utf8")
      await writeFile(join(root, "w.json"), JSON.stringify({ model: "w-model", theme: "dark" }), "utf8")
      await writeFile(join(root, "p.json"), JSON.stringify({ model: "p-model", fontFamily: "hmm" }), "utf8")
      const store = createLayeredStore({
        files: [join(root, "g.json"), join(root, "w.json"), join(root, "p.json")],
      })
      await store.load()
      expect(store.get().model).toBe("p-model")
      expect(store.get().theme).toBe("dark")
      // unknown/partial keys degrade per-normalize; merged values are normalized once
      expect(store.get().fontSize).toBe(14)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("missing layers are fine; master = the last existing source", async () => {
    const root = await tmpRoot()
    try {
      await writeFile(join(root, "p.json"), JSON.stringify({ model: "p" }), "utf8")
      const store = createLayeredStore({
        files: [join(root, "g.json"), join(root, "p.json")], // g.json never exists
      })
      const s = await store.load()
      expect(s.model).toBe("p")
      // writes go to the master (last source), never a silent first-source write
      await store.set({ theme: "light" })
      expect(await readFile(join(root, "p.json"), "utf8")).toContain("light")
      expect(await readFile(join(root, "g.json"), "utf8").catch(() => "MISSING")).toBe("MISSING")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("set() leaf-patches the master raw doc: unknown keys + revision are preserved", async () => {
    const root = await tmpRoot()
    try {
      const file = join(root, "settings.json")
      await writeFile(
        file,
        JSON.stringify({ model: "legacy", team: { role: "dev" }, _revision: { llm: 3 } }, null, 2),
        "utf8",
      )
      const store = createLayeredStore({ files: [file] })
      await store.load()
      await store.set({ theme: "dark" })
      const raw = JSON.parse(await readFile(file, "utf8"))
      // the hand-edited unknown key and the revision meta survive the write
      expect(raw.team).toEqual({ role: "dev" })
      expect(raw._revision).toEqual({ llm: 3 })
      expect(raw.theme).toBe("dark")
      // the in-memory view is normalized (unknown keys invisible)
      expect(store.get().theme).toBe("dark")
      expect((store.get() as unknown as Record<string, unknown>).team).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("mutateSection preserves comment lines in an existing file", async () => {
    const root = await tmpRoot()
    try {
      const file = join(root, "settings.json")
      const commentHeader = "// I-harness settings (hand-edited)\n"
      const commentInline = '  // winter theme during demos\n'
      await writeFile(
        file,
        commentHeader
          + JSON.stringify({ theme: "system", llm: { providers: {}, defaultModel: { provider: "", model: "" } } }, null, 2)
          .replace('"theme": "system"', `"theme": "system",\n${commentInline.slice(0, -1)}`),
        "utf8",
      )
      const store = createLayeredStore({ files: [file] })
      await store.load()
      await mutateSection("llm", [{ op: "set", path: ["defaultModel", "model"], value: "deepseek-r2" }], store, 0)
      const raw = await readFile(file, "utf8")
      expect(raw).toContain("// I-harness settings (hand-edited)")
      expect(raw).toContain("winter theme during demos")
      // the patch applied (leaf); the file still parses after comment stripping
      const stripped = raw.split("\n").filter((l) => !/^\s*(?:[//#]|".*",\s*\/\/)/.test(l.trim()) && l.trim() !== "").join("\n")
      const parsed = JSON.parse(stripped)
      expect(parsed.llm.defaultModel.model).toBe("deepseek-r2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("exposes per-source LayerSource details after load", async () => {
    const root = await tmpRoot()
    try {
      await writeFile(join(root, "p.json"), JSON.stringify({ model: "p" }), "utf8")
      const store = createLayeredStore({ files: [join(root, "p.json")] })
      await store.load()
      const sources: LayerSource[] = store.sources()
      expect(sources).toHaveLength(1)
      expect(sources[0]!.path).toBe(join(root, "p.json"))
      expect(sources[0]!.raws).toEqual({ model: "p" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("watchSettings (polling hot-reload)", () => {
  it("fires the change callback when the file changes; dispose stops it", async () => {
    const root = await tmpRoot()
    try {
      const file = join(root, "s.json")
      await writeFile(file, JSON.stringify({ model: "a" }), "utf8")
      const changed: string[] = []
      const { dispose: stop } = watchSettings(file, (path) => changed.push(path), { intervalMs: 60 })
      // wait one poll cycle to stabilize the initial snapshot
      await new Promise((r) => setTimeout(r, 200))
      await writeFile(file, JSON.stringify({ model: "b" }), "utf8")
      await new Promise((r) => setTimeout(r, 260))
      stop()
      const fired = changed.length
      expect(fired).toBeGreaterThanOrEqual(1)
      expect(changed[0]).toBe(file)
      // after dispose: a further change is not reported
      await writeFile(file, JSON.stringify({ model: "c" }), "utf8")
      await new Promise((r) => setTimeout(r, 200))
      expect(changed.length).toBe(fired)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
