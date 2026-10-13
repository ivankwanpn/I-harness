// M27 R-E10: layered settings (global < workspace < project, last wins),
// event-driven hot-reload, comment-preserving leaf-patch writes.
import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLayeredStore, LayeredSettingsStore, resolveLayeredSources, watchSettings, mergeRawLayers, type LayerSource, type Settings } from "../src/index.ts"
import { mutateSection } from "../src/sections.ts"
import type { Telemetry, TelemetryEvent } from "@i-harness/telemetry"

// WHY: native watchers must close before their Windows temp roots are removed;
// unlike the old unref'ed poll they own OS handles (packages/fs-watch/src/index.ts:201).
const tracked: Array<{ dispose: () => void }> = []
function track<T extends { dispose: () => void }>(watcher: T): T {
  tracked.push(watcher)
  return watcher
}
function disposeTracked(): void {
  for (const watcher of tracked.splice(0)) watcher.dispose()
}
function trackedStore(options: Parameters<typeof createLayeredStore>[0]): LayeredSettingsStore {
  return track(createLayeredStore(options))
}

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ih-layers-"))
}

/** Poll until `ready()`. W1's two-write case must not guess a sleep long
 * enough for the first change to have settled — that distance is what it
 * measures — so it waits for the observed event instead. */
async function waitFor(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out")
    await new Promise((r) => setTimeout(r, 2))
  }
}

/** Atomic replace (tmp + rename — the shape the store itself writes): ONE stat
 * transition per file, so a case can count exactly one change per write. A plain
 * `writeFile` truncates first and presents a second `mtime:size` state that the
 * poll legitimately reports. */
async function replaceFile(target: string, text: string): Promise<void> {
  const tmp = `${target}.tmp`
  await writeFile(tmp, text, "utf8")
  await rename(tmp, target)
}

/** W1 rig: the store with the reload latency a loaded machine produces BY LUCK
 * injected deterministically — the in-flight window the conflate has to
 * survive. `reads` is pushed the instant the reload's file read finished,
 * while the reload is still in flight, so a test can land a second change
 * strictly after that read and strictly inside the window (no sleep needed to
 * guess where the read fell, which is the one thing such a test could not
 * otherwise observe). */
class SlowReloadStore extends LayeredSettingsStore {
  readonly reads: number[] = []
  override async reloadFromDisk(): Promise<Settings> {
    const settings = await super.reloadFromDisk()
    this.reads.push(Date.now())
    // 250ms, not "long enough": the case below asserts that nothing was
    // reported BEFORE the second write lands, so an over-loaded worker that
    // stalls past this delay would break the test, not the fix. 250ms is the
    // same order the rest of this file already waits on.
    await new Promise((r) => setTimeout(r, 250))
    return settings
  }
}

/** W1 rig for the FAILING reload: the first `reloadFromDisk` waits out a window
 * and then throws; later ones behave. The throw stands in for the real failure
 * the conflate must survive — `parseDocumentTolerant` on a torn read of a
 * non-atomic write — which cannot be scheduled from outside the store (the read
 * must see the torn bytes AND the settled write must land while that read is
 * running). The path pinned is the same one either way: the handler's `catch`. */
class FailingReloadStore extends LayeredSettingsStore {
  readonly attempts: number[] = []
  override async reloadFromDisk(): Promise<Settings> {
    const attempt = this.attempts.length
    this.attempts.push(Date.now())
    await new Promise((r) => setTimeout(r, 350)) // WHY: include 100ms write stability (packages/fs-watch/src/index.ts:145)
    if (attempt === 0) throw new Error("reload failed (W1 pin: the torn read)")
    return super.reloadFromDisk()
  }
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
      disposeTracked()
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
      { label: "global", order: 0, path: null, raws: { model: "g-model", fontSize: 13 } },
      { label: "project", order: 2, path: null, raws: { model: "p-model", plugins: { bash: false } } },
    ])
    expect(merged).toEqual({ model: "p-model", fontSize: 13, plugins: { bash: false } })
  })
})

describe("createLayeredStore", () => {
  it("global < workspace < project: the project layer wins", async () => {
    const root = await tmpRoot()
    try {
      await writeFile(join(root, "g.json"), JSON.stringify({ model: "g-model" }), "utf8")
      await writeFile(join(root, "w.json"), JSON.stringify({ model: "w-model", sandboxMode: "read-only" }), "utf8")
      await writeFile(join(root, "p.json"), JSON.stringify({ model: "p-model", fontFamily: "hmm" }), "utf8")
      const store = trackedStore({
        files: [join(root, "g.json"), join(root, "w.json"), join(root, "p.json")],
      })
      await store.load()
      expect(store.get().model).toBe("p-model")
      expect(store.get().sandboxMode).toBe("read-only") // the workspace layer's value survives
      // unknown/partial keys degrade per-normalize; merged values are normalized once
      expect(store.get().fontSize).toBe(14)
    } finally {
      disposeTracked()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("missing layers are fine; master = the last existing source", async () => {
    const root = await tmpRoot()
    try {
      await writeFile(join(root, "p.json"), JSON.stringify({ model: "p" }), "utf8")
      const store = trackedStore({
        files: [join(root, "g.json"), join(root, "p.json")], // g.json never exists
      })
      const s = await store.load()
      expect(s.model).toBe("p")
      // writes go to the master (last source), never a silent first-source write
      await store.set({ fontSize: 16 })
      expect(await readFile(join(root, "p.json"), "utf8")).toContain('"fontSize": 16')
      expect(await readFile(join(root, "g.json"), "utf8").catch(() => "MISSING")).toBe("MISSING")
    } finally {
      disposeTracked()
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
      const store = trackedStore({ files: [file] })
      await store.load()
      await store.set({ fontSize: 16 })
      const raw = JSON.parse(await readFile(file, "utf8"))
      // the hand-edited unknown key and the revision meta survive the write
      expect(raw.team).toEqual({ role: "dev" })
      expect(raw._revision).toEqual({ llm: 3 })
      expect(raw.fontSize).toBe(16) // raw doc keeps the written value verbatim
      expect(store.get().fontSize).toBe(16)
      expect((store.get() as unknown as Record<string, unknown>).team).toBeUndefined()
    } finally {
      disposeTracked()
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
          + JSON.stringify({ fontSize: 15, llm: { providers: {}, defaultModel: { provider: "", model: "" } } }, null, 2)
          .replace('"fontSize": 15', `"fontSize": 15,\n${commentInline.slice(0, -1)}`),
        "utf8",
      )
      const store = trackedStore({ files: [file] })
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
      disposeTracked()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("exposes per-source LayerSource details after load", async () => {
    const root = await tmpRoot()
    try {
      await writeFile(join(root, "p.json"), JSON.stringify({ model: "p" }), "utf8")
      const store = trackedStore({ files: [join(root, "p.json")] })
      await store.load()
      const sources: LayerSource[] = store.sources()
      expect(sources).toHaveLength(1)
      expect(sources[0]!.path).toBe(join(root, "p.json"))
      expect(sources[0]!.raws).toEqual({ model: "p" })
    } finally {
      disposeTracked()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("watchSettings (event-driven hot-reload)", () => {
  it("fires the change callback when the file changes; dispose stops it", async () => {
    const root = await tmpRoot()
    try {
      const file = join(root, "s.json")
      await writeFile(file, JSON.stringify({ model: "a" }), "utf8")
      const changed: string[] = []
      const { dispose: stop } = track(watchSettings(file, (path) => changed.push(path), { intervalMs: 60 }))
      // WHY: allow the baseline scan before writing (packages/fs-watch/src/index.ts:149).
      await new Promise((r) => setTimeout(r, 300))
      await writeFile(file, JSON.stringify({ model: "b" }), "utf8")
      await waitFor(() => changed.length > 0)
      stop()
      const fired = changed.length
      expect(fired).toBeGreaterThanOrEqual(1)
      expect(changed[0]).toBe(file)
      // after dispose: a further change is not reported
      await writeFile(file, JSON.stringify({ model: "c" }), "utf8")
      await new Promise((r) => setTimeout(r, 300))
      expect(changed.length).toBe(fired)
    } finally {
      disposeTracked()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("two files changed together are both reported without dropping either path", async () => {
    const root = await tmpRoot()
    try {
      const a = join(root, "a.json")
      const b = join(root, "b.json")
      // Atomic replacements (see replaceFile), so each round is exactly ONE
      // change per file and the counts below are exact.
      await replaceFile(a, "a-0")
      await replaceFile(b, "b-0")
      const changed: string[] = []
      const { dispose: stop } = track(watchSettings([a, b], (path) => changed.push(path), { intervalMs: 60 }))
      try {
        // WHY: let fs-watch's baseline scan settle before the first pair
        // (packages/fs-watch/src/index.ts:149).
        await new Promise((r) => setTimeout(r, 300))
        expect(changed).toHaveLength(0)
        for (let round = 1; round <= 3; round += 1) {
          // WHY: both push paths must survive a near-simultaneous pair; the
          // callback bridge must not retain the old one-batch-per-tick loss
          // mode (packages/settings/src/index.ts:1618).
          await Promise.all([replaceFile(a, `a-${round}`), replaceFile(b, `b-${round}`)])
          await waitFor(() => changed.length >= round * 2)
        }
        // Each round reports BOTH changed paths exactly once.
        expect(changed.filter((p) => p === a)).toHaveLength(3)
        expect(changed.filter((p) => p === b)).toHaveLength(3)
        expect(changed).toHaveLength(6)
      } finally {
        stop()
      }
    } finally {
      disposeTracked()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M40 A6: settings/changed telemetry on hot-reload", () => {
  it("emits settings/changed (path-payload) only on a DETECTED change — the load-time snapshot never fires", async () => {
    const root = await tmpRoot()
    try {
      const file = join(root, "s.json")
      await writeFile(file, JSON.stringify({ fontSize: 14 }), "utf8")
      const events: TelemetryEvent[] = []
      const telemetry: Telemetry = { emit: (ev) => events.push(ev), close: () => {} }
      const store = trackedStore({ files: [file], watchIntervalMs: 10, telemetry })
      await store.load()
      // WHY: the initial fs-watch baseline must emit nothing (packages/fs-watch/src/index.ts:162).
      await new Promise((r) => setTimeout(r, 300))
      expect(events).toHaveLength(0)
      // Mutation → stabilized push + reload + emit with the changed path.
      await writeFile(file, JSON.stringify({ fontSize: 15 }), "utf8")
      await waitFor(() => events.some((event) => event.type === "settings/changed"))
      expect(store.get().fontSize).toBe(15)
      const changed = events.filter((e) => e.type === "settings/changed")
      expect(changed.length).toBe(1)
      expect(changed[0]!.data.path).toBe(file)
      // onChange listeners still get the same change (store surface unchanged).
      let notified: string | undefined
      store.onChange((p) => { notified = p })
      await writeFile(file, JSON.stringify({ fontSize: 16 }), "utf8")
      await waitFor(() => notified !== undefined)
      expect(notified).toBe(file)
      expect(events.filter((e) => e.type === "settings/changed")).toHaveLength(2)
    } finally {
      disposeTracked()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("W1: the hot-reload conflate compares state, not time", () => {
  it("two genuinely separate writes report 2 settings/changed (a conflate that swallows the second is the failure mode)", async () => {
    const root = await tmpRoot()
    try {
      const file = join(root, "s.json")
      await writeFile(file, JSON.stringify({ fontSize: 14 }), "utf8")
      const events: TelemetryEvent[] = []
      const telemetry: Telemetry = { emit: (ev) => events.push(ev), close: () => {} }
      const store = trackedStore({ files: [file], watchIntervalMs: 10, telemetry })
      await store.load()
      const changed = () => events.filter((e) => e.type === "settings/changed")
      // WHY: the initial fs-watch baseline must emit nothing (packages/fs-watch/src/index.ts:162).
      await new Promise((r) => setTimeout(r, 300))
      expect(changed()).toHaveLength(0)
      // "Separate" is measured in REPORTED changes, not wall-clock: the second
      // write goes out as soon as the first report lands, so a conflate that
      // merges by time window (the debounce this fix rejects) has to swallow
      // it here, while one that compares state cannot — the disk moved after
      // the reload that reported the first write read it.
      await writeFile(file, JSON.stringify({ fontSize: 15 }), "utf8")
      await waitFor(() => changed().length >= 1)
      await writeFile(file, JSON.stringify({ fontSize: 16 }), "utf8")
      await waitFor(() => changed().length >= 2)
      // Let settled push echoes land: absorbed duplicates must not add a
      // third report (exactly 2, not "at least 2" — the conflate's whole job).
      await new Promise((r) => setTimeout(r, 300))
      expect(changed()).toHaveLength(2)
      expect(store.get().fontSize).toBe(16)
      expect(changed().map((e) => e.data.path)).toEqual([file, file])
    } finally {
      disposeTracked()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("a change detected inside an in-flight reload is still reported when that reload did not read it", async () => {
    const root = await tmpRoot()
    try {
      const file = join(root, "s.json")
      await writeFile(file, JSON.stringify({ fontSize: 14 }), "utf8")
      const events: TelemetryEvent[] = []
      const telemetry: Telemetry = { emit: (ev) => events.push(ev), close: () => {} }
      const store = track(new SlowReloadStore({ files: [file], watchIntervalMs: 10, telemetry }))
      await store.load()
      const changed = () => events.filter((e) => e.type === "settings/changed")
      // WHY: the initial fs-watch baseline must emit nothing (packages/fs-watch/src/index.ts:162).
      await new Promise((r) => setTimeout(r, 300))
      expect(changed()).toHaveLength(0)
      await writeFile(file, JSON.stringify({ fontSize: 15 }), "utf8")
      // Gate on the in-flight reload having READ the file (it read 15): the
      // next write is therefore strictly after that read, and the reload is
      // still in flight for ~250ms after this point — the one window in which
      // "absorb the pending detection" and "re-check its state" differ.
      await waitFor(() => store.reads.length >= 1)
      expect(changed()).toHaveLength(0) // nothing reported yet: the window is open
      await writeFile(file, JSON.stringify({ fontSize: 16 }), "utf8")
      // The report for 16 must survive the conflate: the reload that was in
      // flight never saw 16, so only a re-check that compares STATE finds it.
      await waitFor(() => changed().length >= 2)
      await new Promise((r) => setTimeout(r, 300))
      expect(changed()).toHaveLength(2)
      expect(store.get().fontSize).toBe(16)
    } finally {
      disposeTracked()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("two files: the report for the change detected inside a reload carries THAT file's path", async () => {
    const root = await tmpRoot()
    try {
      const a = join(root, "a.json")
      const b = join(root, "b.json")
      await writeFile(a, JSON.stringify({ fontSize: 14 }), "utf8")
      await writeFile(b, JSON.stringify({ model: "b0" }), "utf8")
      const events: TelemetryEvent[] = []
      const telemetry: Telemetry = { emit: (ev) => events.push(ev), close: () => {} }
      const store = track(new SlowReloadStore({ files: [a, b], watchIntervalMs: 10, telemetry }))
      await store.load()
      const changed = () => events.filter((e) => e.type === "settings/changed")
      // WHY: the initial fs-watch baseline must emit nothing (packages/fs-watch/src/index.ts:162).
      await new Promise((r) => setTimeout(r, 300))
      expect(changed()).toHaveLength(0)
      // a.json changes ATOMICALLY (tmp + rename — the store's own write shape):
      // one stat transition. A plain writeFile truncates first, so the poll can
      // see a second a.json transition; if that lands in the same tick as the
      // b.json write below, the watcher fires a.json for that tick and advances
      // its snapshot past b.json too (`one batch per tick`), so the b detection
      // is swallowed and this assertion would fail for a reason it does not
      // guard. Measured: 7 of 12 parallel runs red before the write was made
      // atomic (received [a, a] — the state right, the path wrong).
      const aTmp = `${a}.tmp`
      await writeFile(aTmp, JSON.stringify({ fontSize: 15 }), "utf8")
      await rename(aTmp, a)
      // Gate on the reload having read BOTH files: the b change below is then
      // strictly after that read and inside the reload's window, so its report
      // comes from the re-check — which must name b, not the a.json that
      // started the reload in flight (`data.path` is user-visible).
      await waitFor(() => store.reads.length >= 1)
      await writeFile(b, JSON.stringify({ model: "b1" }), "utf8")
      await waitFor(() => changed().length >= 2)
      await new Promise((r) => setTimeout(r, 300))
      expect(changed().map((e) => e.data.path)).toEqual([a, b])
      expect(store.get().fontSize).toBe(15)
      expect(store.get().model).toBe("b1")
    } finally {
      disposeTracked()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("a detection that lands while a reload FAILS is re-checked, not dropped (the watcher will not re-detect it)", async () => {
    const root = await tmpRoot()
    try {
      const file = join(root, "s.json")
      await writeFile(file, JSON.stringify({ fontSize: 14 }), "utf8")
      const events: TelemetryEvent[] = []
      const telemetry: Telemetry = { emit: (ev) => events.push(ev), close: () => {} }
      const store = track(new FailingReloadStore({ files: [file], watchIntervalMs: 10, telemetry }))
      await store.load()
      const changed = () => events.filter((e) => e.type === "settings/changed")
      // WHY: the initial fs-watch baseline must emit nothing (packages/fs-watch/src/index.ts:162).
      await new Promise((r) => setTimeout(r, 300))
      expect(changed()).toHaveLength(0)
      await writeFile(file, JSON.stringify({ fontSize: 15 }), "utf8")
      await waitFor(() => store.attempts.length >= 1) // the failing reload is in flight
      await new Promise((r) => setTimeout(r, 20)) // its detection has landed
      // The settled write, inside the failing reload's window: the watcher
      // advances its snapshot when it fires this one, so if the failure dropped
      // it the change would be lost until the next write — store.get() would
      // stay at 14 and nothing would ever report.
      await writeFile(file, JSON.stringify({ fontSize: 16 }), "utf8")
      await waitFor(() => changed().length >= 1)
      await new Promise((r) => setTimeout(r, 300))
      expect(changed()).toHaveLength(1)
      expect(changed()[0]!.data.path).toBe(file)
      expect(store.get().fontSize).toBe(16)
    } finally {
      disposeTracked()
      await rm(root, { recursive: true, force: true })
    }
  })

})
