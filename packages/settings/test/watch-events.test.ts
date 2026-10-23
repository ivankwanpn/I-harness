import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LayeredSettingsStore, watchSettings, type Settings } from "../src/index.ts"
import { controlledLease, settle } from "./helpers/settings-lease.ts"

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ih-events-")); roots.push(root)
  const a = join(root, "a.json"), b = join(root, "b.json"), c = join(root, "c.json")
  await writeFile(a, '{"fontSize":14}'); await writeFile(b, '{"model":"b0"}'); await writeFile(c, '{"searchBackend":"jsonl"}')
  return { a, b, c }
}
// Gate the actual serialized read seam, without adding a test-only store API.
function gateReads(store: LayeredSettingsStore, fail = -1, before = false) {
  const seam = store as unknown as { read(): Promise<Settings> }, original = seam.read.bind(store)
  const releases: Array<() => void> = []; let attempt = 0
  vi.spyOn(seam, "read").mockImplementation(async () => {
    const current = attempt++
    const result = before || current === fail ? undefined : await original()
    await new Promise<void>(resolve => { releases.push(resolve) })
    if (current === fail) throw new Error("held read failed")
    return result ?? await original()
  })
  return releases
}

it.each([{ first: "b", second: "c" }, { first: "c", second: "b" }] as const)("drains each queued detection after a failed read ($first then $second), attributing all read sources", async ({ first, second }) => {
  const files = await fixture(), lease = controlledLease(), changed: string[] = [], emitted: string[] = []
  const store = new LayeredSettingsStore({ files: [files.a, files.b, files.c], watchService: lease.service,
    onWatchError: () => {}, telemetry: { emit: event => { emitted.push(String(event.data.path)) }, close() {} } })
  await store.load(); store.onChange(path => { changed.push(path) }); const releases = gateReads(store, 1)
  try {
    await writeFile(files.a, '{"fontSize":15}'); lease.changed(files.a)
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    await writeFile(files.b, '{"model":"b1"}'); await writeFile(files.c, '{"searchBackend":"sqlite"}')
    lease.changed(files[first], files[second]); await settle(); expect(changed).toEqual([])
    releases[0]!(); await vi.waitFor(() => expect(releases).toHaveLength(2)); expect(changed).toEqual([files.a])
    releases[1]!(); await vi.waitFor(() => expect(releases).toHaveLength(3)); expect(changed).toEqual([files.a])
    releases[2]!(); await vi.waitFor(() => expect(changed).toEqual([files.a, files.b, files.c]))
    expect(emitted).toEqual(changed); expect(store.get()).toMatchObject({ fontSize: 15, model: "b1", searchBackend: "sqlite" })
  } finally { store.dispose(); releases.forEach(release => release()); await store.close() }
})

it("duplicate pushes conflate, but a same-path write behind an already-read value gets a subsequent read", async () => {
  const { a } = await fixture(), lease = controlledLease(), changed: string[] = []
  const store = new LayeredSettingsStore({ files: [a], watchService: lease.service }); await store.load()
  store.onChange(path => { changed.push(path) }); const releases = gateReads(store)
  try {
    await writeFile(a, '{"fontSize":15}'); lease.changed(a); await vi.waitFor(() => expect(releases).toHaveLength(1))
    lease.changed(a); await settle(); releases[0]!(); await vi.waitFor(() => expect(releases).toHaveLength(2)); expect(changed).toEqual([a])
    await writeFile(a, '{"fontSize":16}'); lease.changed(a); await settle(); releases[1]!()
    await vi.waitFor(() => expect(releases).toHaveLength(3)); expect(changed).toEqual([a]); releases[2]!()
    await vi.waitFor(() => expect(changed).toEqual([a, a])); expect(store.get().fontSize).toBe(16)
  } finally { store.dispose(); releases.forEach(release => release()); await store.close() }
})

it("a duplicate queued during a failed read is retried even with identical observed bytes", async () => {
  const { a } = await fixture(), lease = controlledLease(), changed: string[] = []
  const store = new LayeredSettingsStore({ files: [a], watchService: lease.service, onWatchError: () => {} }); await store.load()
  store.onChange(path => { changed.push(path) }); const releases = gateReads(store, 0, true)
  try {
    await writeFile(a, '{"fontSize":15}'); lease.changed(a); await vi.waitFor(() => expect(releases).toHaveLength(1))
    lease.changed(a); await settle(); releases[0]!(); await vi.waitFor(() => expect(releases).toHaveLength(2))
    expect(changed).toEqual([]); releases[1]!(); await vi.waitFor(() => expect(changed).toEqual([a]))
  } finally { store.dispose(); releases.forEach(release => release()); await store.close() }
})

it("self-writes and duplicate push echoes are already current and stay silent", async () => {
  const { a } = await fixture(), lease = controlledLease(), changed = vi.fn()
  const store = new LayeredSettingsStore({ files: [a], watchService: lease.service }); await store.load(); store.onChange(changed)
  await store.set({ fontSize: 15 }); lease.changed(a); lease.changed(a); await settle()
  expect(store.get().fontSize).toBe(15); expect(changed).not.toHaveBeenCalled(); await store.close()
})

it.each(["change", "creation", "deletion"])("recovery reconciles a missed %s and leaves unchanged sources quiet", async mode => {
  const { a, b } = await fixture(), lease = controlledLease(), changed: string[] = []
  if (mode === "creation") await unlink(a)
  const watcher = watchSettings([a, b], path => { changed.push(path) }, { service: lease.service, intervalMs: 60000 })
  lease.reset(); await settle(); lease.emit({ kind: "unavailable", code: "FS_WATCH_GAP", cursor: lease.cursor })
  if (mode === "deletion") await unlink(a); else await writeFile(a, '{"fontSize":15}')
  lease.reset("recovered"); await vi.waitFor(() => expect(changed).toEqual([a]))
  lease.reset("recovered"); await settle(); expect(changed).toEqual([a]); expect(lease.service.acquire).toHaveBeenCalledOnce(); await watcher.close()
})

it("watchIntervalMs false acquires nothing", async () => {
  const { a } = await fixture(), lease = controlledLease()
  const store = new LayeredSettingsStore({ files: [a], watchService: lease.service, watchIntervalMs: false })
  await store.load(); expect(lease.service.acquire).not.toHaveBeenCalled(); await store.close()
})
