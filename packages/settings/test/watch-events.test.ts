// WHY: push detections have no polling capture guard. Force duplicate arrivals
// inside a held reload to prove the unchanged state conflate alone suffices
// (src/index.ts:1446), and force stream errors without relying on OS timing.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { FsWatcher, FsWatchEvent } from "../../fs-watch/src/index.ts"
import { createLayeredStore, LayeredSettingsStore, watchSettings, type Settings } from "../src/index.ts"

const mock = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("../../fs-watch/src/index.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../fs-watch/src/index.ts")>(),
  createFsWatcher: mock.create,
}))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for push watcher")
    await sleep(5)
  }
}

interface PushStream extends FsWatcher {
  delivered: number
  emit(event: FsWatchEvent): void
  fail(error: Error): void
  close: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function pushStream(): PushStream {
  const queue: Array<IteratorResult<FsWatchEvent> | Error> = []
  let ended = false
  let waiting: ((value: IteratorResult<FsWatchEvent> | Error) => void) | undefined
  const send = (value: IteratorResult<FsWatchEvent> | Error): void => {
    if (waiting === undefined) queue.push(value)
    else {
      const resolve = waiting
      waiting = undefined
      resolve(value)
    }
  }
  const stream: PushStream = {
    delivered: 0,
    emit(event) { if (!ended) send({ value: event, done: false }) },
    fail(error) { ended = true; send(error) },
    events: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<FsWatchEvent>> {
            const value = queue.shift()
              ?? (ended ? { value: undefined, done: true } as const
                : await new Promise<IteratorResult<FsWatchEvent> | Error>((resolve) => { waiting = resolve }))
            if (value instanceof Error) throw value
            if (!value.done) stream.delivered += 1
            return value
          },
        }
      },
    },
    close: vi.fn(async () => {
      ended = true
      queue.length = 0
      if (waiting !== undefined) send({ value: undefined, done: true })
    }),
  }
  return stream
}

class GatedReloadStore extends LayeredSettingsStore {
  readonly releases: Array<() => void> = []
  override async reloadFromDisk(): Promise<Settings> {
    const settings = await super.reloadFromDisk()
    await new Promise<void>((resolve) => { this.releases.push(resolve) })
    return settings
  }
}

class GatedFailingReloadStore extends LayeredSettingsStore {
  readonly releases: Array<() => void> = []
  private attempts = 0
  override async reloadFromDisk(): Promise<Settings> {
    const attempt = this.attempts++
    await new Promise<void>((resolve) => { this.releases.push(resolve) })
    if (attempt === 0) throw new Error("held reload failed")
    return super.reloadFromDisk()
  }
}

class DeferredReadStore extends LayeredSettingsStore {
  started = false
  release = (): void => {}
  private readonly readGate = new Promise<void>((resolve) => { this.release = resolve })
  override async reloadFromDisk(): Promise<Settings> {
    this.started = true
    await this.readGate
    return super.reloadFromDisk()
  }
}

let streams: PushStream[]
beforeEach(() => {
  vi.clearAllMocks()
  streams = []
  mock.create.mockImplementation(() => {
    const stream = pushStream()
    streams.push(stream)
    return stream
  })
})

describe("settings push adapter", () => {
  it.each(["change", "creation", "deletion"])("reconciles a missed %s during watcher recovery without reporting unchanged paths", async mode => {
    const root = await mkdtemp(join(tmpdir(), "ih-settings-recovery-"))
    const file = join(root, "settings.json"), unchanged = join(root, "unchanged.json")
    if (mode !== "creation") await writeFile(file, '{"fontSize":14}')
    await writeFile(unchanged, "{}")
    const changed: string[] = []
    const watcher = watchSettings([file, unchanged], path => changed.push(path), { intervalMs: 100 })
    try {
      expect(changed).toEqual([])
      streams[0]!.fail(new Error("watch stream failed"))
      await waitFor(() => streams[0]!.close.mock.calls.length > 0)
      if (mode === "deletion") await unlink(file)
      else await writeFile(file, '{"fontSize":15}')
      await waitFor(() => streams.length === 2)
      await waitFor(() => changed.length > 0)
      expect(changed).toEqual([file])
      streams[1]!.fail(new Error("another watch stream failure"))
      await waitFor(() => streams.length === 3)
      expect(changed).toEqual([file])
    } finally {
      watcher.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("duplicates inside an in-flight reload emit once; a different state behind that reload still emits", async () => {
    const root = await mkdtemp(join(tmpdir(), "ih-settings-push-"))
    const file = join(root, "settings.json")
    await writeFile(file, '{"fontSize":14}')
    const changed: string[] = []
    const emitted: Array<{ type: string; data: Record<string, unknown> }> = []
    const store = new GatedReloadStore({
      files: [file],
      watchIntervalMs: 60_000,
      telemetry: { emit: (event) => emitted.push(event), close: () => {} },
    })
    store.onChange((path) => changed.push(path))
    try {
      await store.load()
      expect(mock.create).toHaveBeenCalledWith({ roots: [file], persistent: false })
      expect(changed).toEqual([])
      await writeFile(file, '{"fontSize":15}')
      streams[0]!.emit({ path: file, kind: "change" })
      await waitFor(() => store.releases.length === 1)
      expect(changed).toEqual([])
      for (let i = 0; i < 3; i += 1) streams[0]!.emit({ path: file, kind: "change" })
      await waitFor(() => streams[0]!.delivered === 4)
      store.releases[0]!()
      await waitFor(() => store.releases.length === 2)
      expect(changed).toEqual([file])
      // WHY: the re-check has read 15 but is held; 16 arrives behind it. A time
      // debounce or dropping in-flight detections would lose this real state
      // (src/index.ts:1514); an equality re-check absorbs 15 then discovers 16.
      await writeFile(file, '{"fontSize":16}')
      streams[0]!.emit({ path: file, kind: "change" })
      await waitFor(() => streams[0]!.delivered === 5)
      store.releases[1]!()
      await waitFor(() => store.releases.length === 3)
      expect(changed).toEqual([file])
      store.releases[2]!()
      await waitFor(() => changed.length === 2)
      expect(changed).toEqual([file, file])
      expect(emitted.filter((event) => event.type === "settings/changed").map((event) => event.data.path)).toEqual([file, file])
      expect(store.get().fontSize).toBe(16)
      expect(store.releases).toHaveLength(3)
    } finally {
      store.dispose()
      for (const release of store.releases) release()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("a duplicate push queued during a failed reload is state-rechecked and reported once", async () => {
    const root = await mkdtemp(join(tmpdir(), "ih-settings-failed-read-"))
    const file = join(root, "settings.json")
    await writeFile(file, '{"fontSize":14}')
    const changed: string[] = []
    const store = new GatedFailingReloadStore({ files: [file] })
    store.onChange((path) => changed.push(path))
    try {
      await store.load()
      await writeFile(file, '{"fontSize":15}')
      streams[0]!.emit({ path: file, kind: "change" })
      await waitFor(() => store.releases.length === 1)
      streams[0]!.emit({ path: file, kind: "change" })
      await waitFor(() => streams[0]!.delivered === 2)
      store.releases[0]!()
      await waitFor(() => store.releases.length === 2)
      expect(changed).toEqual([])
      store.releases[1]!()
      await waitFor(() => changed.length > 0)
      expect(changed).toEqual([file])
      expect(store.get().fontSize).toBe(15)
    } finally {
      store.dispose()
      for (const release of store.releases) release()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("dispose cannot be undone by the load at the end of an already-started reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "ih-settings-disposed-read-"))
    const file = join(root, "settings.json")
    await writeFile(file, '{"fontSize":14}')
    const store = new DeferredReadStore({ files: [file] })
    try {
      await store.load()
      await writeFile(file, '{"fontSize":15}')
      streams[0]!.emit({ path: file, kind: "change" })
      await waitFor(() => store.started)
      store.dispose()
      store.release()
      await waitFor(() => store.get().fontSize === 15)
      expect(mock.create).toHaveBeenCalledTimes(1)
      expect(streams[0]!.close).toHaveBeenCalled()
    } finally {
      store.dispose()
      store.release()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("a self-write and its duplicate push echoes do not report an already-current state", async () => {
    const root = await mkdtemp(join(tmpdir(), "ih-settings-self-"))
    const file = join(root, "settings.json")
    await writeFile(file, '{"fontSize":14}')
    const changed: string[] = []
    const store = createLayeredStore({ files: [file] })
    store.onChange((path) => changed.push(path))
    try {
      await store.load()
      expect(streams).toHaveLength(1)
      await store.set({ fontSize: 15 })
      for (let i = 0; i < 3; i += 1) streams[0]!.emit({ path: file, kind: "change" })
      await waitFor(() => streams[0]!.delivered === 3)
      await sleep(50)
      expect(store.get().fontSize).toBe(15)
      expect(changed).toEqual([])
    } finally {
      store.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("catches a latched stream error, closes it, and resumes hot reload; dispose cancels the next retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "ih-settings-error-"))
    const file = join(root, "settings.json")
    await writeFile(file, '{"fontSize":14}')
    const changed: string[] = []
    const store = createLayeredStore({ files: [file], watchIntervalMs: 10 })
    store.onChange((path) => changed.push(path))
    try {
      await store.load()
      expect(streams).toHaveLength(1)
      streams[0]!.close.mockRejectedValueOnce(new Error("watcher cleanup error"))
      streams[0]!.fail(new Error("latched watcher error"))
      await waitFor(() => streams.length === 2)
      expect(streams[0]!.close).toHaveBeenCalled()
      expect(changed).toEqual([])
      await writeFile(file, '{"fontSize":15}')
      streams[1]!.emit({ path: file, kind: "change" })
      await waitFor(() => changed.length === 1)
      expect(changed).toEqual([file])
      expect(store.get().fontSize).toBe(15)
      streams[1]!.fail(new Error("another watcher error"))
      await waitFor(() => streams[1]!.close.mock.calls.length > 0)
      store.dispose()
      store.dispose()
      await sleep(60)
      expect(streams).toHaveLength(2)
      streams[1]!.emit({ path: file, kind: "change" })
      expect(changed).toEqual([file])
    } finally {
      store.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("a synchronous watcher startup failure is retried rather than escaping watchSettings", async () => {
    mock.create.mockImplementationOnce(() => { throw new Error("watcher startup failure") })
    const changed: string[] = []
    const watcher = watchSettings("settings.json", (path) => changed.push(path), { intervalMs: 10 })
    try {
      await waitFor(() => streams.length === 1)
      streams[0]!.emit({ path: resolve("settings.json"), kind: "change" })
      await waitFor(() => changed.length === 1)
      expect(changed).toEqual(["settings.json"])
    } finally { watcher.dispose() }
  })

  it("uses narrow routing roots for missing ignored files but callbacks name only selected files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ih-settings-routing-"))
    const parent = join(root, ".i-harness")
    const file = join(parent, "settings.json")
    const changed: string[] = []
    const watcher = watchSettings(file, (path) => changed.push(path))
    try {
      expect(mock.create).toHaveBeenCalledWith({ roots: [file, parent], persistent: false })
      streams[0]!.emit({ path: parent, kind: "add" })
      streams[0]!.emit({ path: join(parent, "session.json"), kind: "change" })
      streams[0]!.emit({ path: file, kind: "add" })
      await waitFor(() => streams[0]!.delivered === 3)
      expect(changed).toEqual([file])
      watcher.dispose()
      streams[0]!.emit({ path: file, kind: "change" })
      await sleep(20)
      expect(changed).toEqual([file])
    } finally {
      watcher.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("watchIntervalMs:false never constructs a watcher", async () => {
    const store = createLayeredStore({ files: ["settings.json"], watchIntervalMs: false })
    try {
      await store.load()
      expect(mock.create).not.toHaveBeenCalled()
    } finally { store.dispose() }
  })
})
