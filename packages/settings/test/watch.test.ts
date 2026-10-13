// WHY: an event-driven settings watcher must not wait for the legacy polling
// interval, even for the workspace's ignored-segment root (src/index.ts:1544).
import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLayeredStore, watchSettings } from "../src/index.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for settings change")
    await sleep(5)
  }
}

async function workspaceLayer(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "ih-settings-watch-"))
  await mkdir(join(root, ".i-harness"))
  const file = join(root, ".i-harness", "settings.json")
  await writeFile(file, JSON.stringify({ fontSize: 14 }))
  return { root, file }
}

describe("fs-watch settings hot reload", () => {
  it("loading settings does not keep an otherwise finished process alive", async () => {
    const { root, file } = await workspaceLayer()
    const source = new URL("../src/index.ts", import.meta.url).href
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { createLayeredStore } from ${JSON.stringify(source)}; await createLayeredStore({ files: [${JSON.stringify(file)}] }).load(); console.log('loaded');`,
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let output = "", timedOut = false
    child.stdout.on("data", chunk => { output += chunk })
    child.stderr.on("data", chunk => { output += chunk })
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 3000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      expect(output).toContain("loaded")
      expect(timedOut, output).toBe(false)
      expect(code, output).toBe(0)
    } finally {
      clearTimeout(timeout)
      child.kill()
      await rm(root, { recursive: true, force: true })
    }
  }, 8000)

  it("an external truncate→write to the WORKSPACE layer fires exactly one onChange with the changed path", async () => {
    const { root, file } = await workspaceLayer()
    const changed: string[] = []
    const watcher = watchSettings(file, (path) => changed.push(path), { intervalMs: 60_000 })
    try {
      await sleep(300)
      expect(changed).toEqual([]) // pre-existing state is only a baseline
      await writeFile(file, "")
      await sleep(30) // shorter than fs-watch's 100ms awaitWriteFinish stability
      await writeFile(file, JSON.stringify({ fontSize: 15 }))
      await waitFor(() => changed.length > 0)
      await sleep(400)
      expect(changed).toEqual([file])
      watcher.dispose()
      watcher.dispose() // idempotent, including while close is asynchronous
      await writeFile(file, JSON.stringify({ fontSize: 16 }))
      await sleep(300)
      expect(changed).toEqual([file])
    } finally {
      watcher.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("the auto WORKSPACE layer reloads once and preserves its onChange/telemetry path", async () => {
    const { root, file } = await workspaceLayer()
    const changed: string[] = []
    const emitted: Array<{ type: string; data: Record<string, unknown> }> = []
    const store = createLayeredStore({
      roots: { workspace: "auto" },
      workspace: root,
      watchIntervalMs: 60_000,
      telemetry: { emit: (event) => emitted.push(event), close: () => {} },
    })
    store.onChange((path) => changed.push(path))
    try {
      await store.load()
      await sleep(300)
      expect(changed).toEqual([])
      expect(emitted).toEqual([])
      await writeFile(file, JSON.stringify({ fontSize: 15 }))
      await waitFor(() => changed.length > 0)
      await sleep(400)
      expect(store.get().fontSize).toBe(15)
      expect(changed).toEqual([file])
      expect(emitted.filter((event) => event.type === "settings/changed").map((event) => event.data.path)).toEqual([file])
      store.dispose()
      await writeFile(file, JSON.stringify({ fontSize: 16 }))
      await sleep(300)
      expect(store.get().fontSize).toBe(15)
      expect(changed).toEqual([file])
    } finally {
      store.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports creation, deletion, and recreation of an explicitly selected settings file", async () => {
    const root = await mkdtemp(join(tmpdir(), "ih-settings-lifecycle-"))
    await mkdir(join(root, ".i-harness"))
    const file = join(root, ".i-harness", "settings.json")
    const changed: string[] = []
    const watcher = watchSettings(file, (path) => changed.push(path), { intervalMs: 60_000 })
    try {
      await sleep(300)
      expect(changed).toEqual([])
      await writeFile(join(root, ".i-harness", "session.json"), "{}")
      await sleep(200)
      expect(changed).toEqual([])
      await writeFile(file, '{"fontSize":15}')
      await waitFor(() => changed.length === 1)
      await unlink(file)
      await waitFor(() => changed.length === 2)
      await writeFile(file, '{"fontSize":16}')
      await waitFor(() => changed.length === 3)
      expect(changed).toEqual([file, file, file])
    } finally {
      watcher.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("observes a selected file whose ignored directory is created after watching starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "ih-settings-missing-dir-"))
    const file = join(root, ".i-harness", "settings.json")
    const changed: string[] = []
    const watcher = watchSettings(file, (path) => changed.push(path), { intervalMs: 60_000 })
    try {
      await sleep(300)
      expect(changed).toEqual([])
      await mkdir(join(root, ".i-harness"))
      await writeFile(file, '{"fontSize":15}')
      await waitFor(() => changed.length > 0)
      await sleep(200)
      expect(changed).toEqual([file])
    } finally {
      watcher.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(["global", "project"] as const)("the %s layer reloads without polling", async (layer) => {
    const { root, file: workspaceFile } = await workspaceLayer()
    const file = layer === "global" ? workspaceFile : join(root, "settings.json")
    if (layer === "project") await writeFile(file, '{"fontSize":14}')
    const store = createLayeredStore({
      roots: layer === "global" ? { global: "auto" } : { project: file },
      configDir: join(root, ".i-harness"),
      watchIntervalMs: 60_000,
    })
    const changed: string[] = []
    store.onChange((path) => changed.push(path))
    try {
      await store.load()
      await sleep(300)
      expect(changed).toEqual([])
      await writeFile(file, '{"fontSize":15}')
      await waitFor(() => changed.length === 1)
      expect(changed).toEqual([file])
      expect(store.get().fontSize).toBe(15)
    } finally {
      store.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("watchIntervalMs:false disables hot reload entirely", async () => {
    const { root, file } = await workspaceLayer()
    const changed: string[] = []
    const store = createLayeredStore({ files: [file], watchIntervalMs: false })
    store.onChange((path) => changed.push(path))
    try {
      await store.load()
      await writeFile(file, JSON.stringify({ fontSize: 15 }))
      await sleep(400)
      expect(store.get().fontSize).toBe(14)
      expect(changed).toEqual([])
    } finally {
      store.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
