import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PushWatcher } from "../../fs-watch/test/helpers/push-watcher.ts"
import { createFsWatchService } from "@i-harness/fs-watch"
import type { WatchNotification } from "@i-harness/fs-watch"
import { createDesktopPlugins } from "../src/plugins.ts"

const seam = vi.hoisted(() => ({ watch: vi.fn() }))
vi.mock("../../fs-watch/node_modules/chokidar/index.js", () => ({ watch: seam.watch }))
let natives: PushWatcher[]
beforeEach(() => {
  natives = []
  seam.watch.mockReset().mockImplementation(() => { const native = new PushWatcher(); natives.push(native); return native })
})
afterEach(() => { vi.unstubAllEnvs() })

it("reconciles original service overflow reset without reopening a healthy backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-overflow-"))
  const path = join(root, "state.json")
  await writeFile(path, JSON.stringify({ version: 1, sources: [], plugins: [] }))
  const watch = createFsWatchService(), plugins = createDesktopPlugins(root, { watch })
  const audit = watch.acquire({ roots: [path], persistent: false })
  const notifications: WatchNotification[] = []
  audit.subscribe(event => notifications.push(event))
  let calls = 0
  const observer = plugins.bindRefresh(async () => { calls++; await plugins.inputs() })
  try {
    natives[0]!.ready()
    await vi.waitFor(() => expect(calls).toBe(1))
    // Alternating same-path transitions avoid source-level duplicate compression.
    for (let i = 0; i < 257; i++) natives[0]!.change(i % 2 ? "unlink" : "change", path)
    await vi.waitFor(() => expect(notifications.some(event => event.kind === "reset" && event.reason === "overflow")).toBe(true))
    await vi.waitFor(() => expect(calls).toBe(2))
    expect(natives).toHaveLength(1)
  } finally { await observer.close(); await plugins.close(); await audit.close(); await watch.close(); await rm(root, { recursive: true, force: true }) }
})

it("reports actual backend loss and reconciles through the original service recovered reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-backend-"))
  await writeFile(join(root, "state.json"), JSON.stringify({ version: 1, sources: [], plugins: [] }))
  const watch = createFsWatchService(), plugins = createDesktopPlugins(root, { watch })
  let calls = 0
  const observer = plugins.bindRefresh(async () => { calls++; await plugins.inputs() })
  try {
    natives[0]!.ready()
    await vi.waitFor(() => expect(calls).toBe(1))
    natives[0]!.change("change", join(root, "sibling.json"))
    natives[0]!.change("change", join(root, ".registry.lock"))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(calls).toBe(1)
    natives[0]!.fail(new Error("original backend failed"))
    await vi.waitFor(async () => expect((await plugins.state()).refreshError).toContain("FS_WATCH_BACKEND"))
    // Manual success does not certify restored watch coverage.
    await plugins.refresh()
    expect((await plugins.state()).refreshError).toContain("FS_WATCH_BACKEND")
    await vi.waitFor(() => expect(natives).toHaveLength(2), { timeout: 3000 })
    natives[1]!.ready()
    await vi.waitFor(() => expect(calls).toBe(3))
    expect((await plugins.state()).refreshError).toBeUndefined()
  } finally { await observer.close(); await plugins.close(); await watch.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(["polling", "unsupported"])("reports original %s backend rejection without polling fallback", async mode => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-reject-"))
  if (mode === "polling") vi.stubEnv("CHOKIDAR_USEPOLLING", "true")
  else seam.watch.mockImplementation(() => { throw new Error("unsupported native backend") })
  const watch = createFsWatchService(), plugins = createDesktopPlugins(root, { watch })
  let calls = 0
  const observer = plugins.bindRefresh(async () => { calls++ })
  try {
    await vi.waitFor(async () => expect((await plugins.state()).refreshError).toContain(mode === "polling" ? "FS_WATCH_POLLING" : "FS_WATCH_BACKEND"))
    expect(calls).toBe(0)
    if (mode === "polling") expect(seam.watch).not.toHaveBeenCalled()
  } finally { await observer.close(); await plugins.close(); await watch.close(); await rm(root, { recursive: true, force: true }) }
})
