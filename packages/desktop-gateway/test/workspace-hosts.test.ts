import { mkdtemp, mkdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { makeSuccess } from "@i-harness/sdk"
import type { DesktopHostEvent } from "../src/host-protocol.ts"
import { DesktopHostStartupError, type DesktopHost, type DesktopHostOptions } from "../src/host.ts"
import { createWorkspaceHosts } from "../src/workspace-hosts.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(create: (options: DesktopHostOptions) => Promise<DesktopHost>) {
  const root = await mkdtemp(join(tmpdir(), "ih-workspace-hosts-"))
  roots.push(root)
  const paths = [join(root, "first"), join(root, "second")]
  await Promise.all(paths.map(path => mkdir(path)))
  const events: DesktopHostEvent[] = []
  const channels = createWorkspaceHosts(join(root, "sessions"), create, event => events.push(event))
  const open = (id: string, workspacePath = paths[0]) => channels.receive({ type: "open", workspaceId: id, workspacePath })
  const data = (id: string, method: string, sequence = 1) => channels.receive({ type: "data", workspaceId: id,
    line: JSON.stringify({ jsonrpc: "2.0", id: sequence, method }) })
  const close = (id: string) => channels.receive({ type: "close", workspaceId: id })
  return { root, paths, channels, events, open, data, close }
}

it("isolates overlapping RPC IDs, retires only their channel and suppresses notifications from retired hosts", async () => {
  const opened: DesktopHostOptions[] = []
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const f = await fixture(async options => {
    opened.push(options)
    return {
      async handleLine(line) {
        const cmd = JSON.parse(line)
        if (cmd.method === "hold") { started.resolve(); await gate.promise }
        options.onWrite(makeSuccess(cmd.id, options.workspace))
      },
      async close() { gate.resolve() },
    }
  })
  await f.open("first", f.paths[0])
  await f.open("second", f.paths[1])
  expect(opened.map(row => row.sessionDir)).toEqual([join(f.root, "sessions", "first"), join(f.root, "sessions", "second")])
  const pending = f.data("first", "hold")
  await started.promise
  await f.data("second", "read")
  expect(f.events.at(-1)).toMatchObject({ type: "data", workspaceId: "second", line: JSON.stringify(makeSuccess(1, f.paths[1])) })
  await f.close("first")
  await pending
  expect(f.events.filter(e => e.type === "data" && e.workspaceId === "first")).toEqual([])
  await f.open("first", f.paths[0])
  opened[0]!.onWrite(makeSuccess(1, "stale"))
  expect(f.events.at(-1)).toEqual({ type: "opened", workspaceId: "first" })
  await f.data("first", "shutdown")
  expect(f.events.at(-1)).toMatchObject({ type: "data", workspaceId: "first" })
  await f.data("second", "read")
  expect(f.events.at(-1)).toMatchObject({ type: "data", workspaceId: "second" })
  await f.channels.close()
})

it("joins an opening host on close and fences queued handshakes per workspace", async () => {
  const creating = Promise.withResolvers<void>()
  const opening = Promise.withResolvers<void>()
  const init = Promise.withResolvers<void>()
  const handled: string[] = []
  const closed = vi.fn(async () => {})
  const f = await fixture(async () => {
    creating.resolve(); await opening.promise
    return { close: closed, async handleLine(line) {
      const { method } = JSON.parse(line)
      if (method === "initialize") await init.promise
      handled.push(method)
    } }
  })
  const first = f.open("w")
  await creating.promise
  const stop = f.close("w")
  opening.resolve()
  await Promise.all([first, stop])
  expect(closed).toHaveBeenCalledOnce()
  expect(f.events).toEqual([{ type: "closed", workspaceId: "w" }])
  await f.open("w")
  const handshake = f.data("w", "initialize")
  const read = f.data("w", "read")
  expect(handled).toEqual([])
  init.resolve()
  await Promise.all([handshake, read])
  expect(handled).toEqual(["initialize", "read"])
  await f.channels.close()
})

it("samples the requested owners together and treats pending, missing or failed owners as busy", async () => {
  const handshake = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let busy = false
  const f = await fixture(async ({ workspace }) => ({
    async handleLine(line) {
      const { method } = JSON.parse(line)
      if (method === "initialize") await handshake.promise
      if (method === "hold") { busy = true; await release.promise; busy = false }
    },
    hasActiveWork() { if (workspace === f.paths[1]) throw Error("Unknown owner"); return busy },
    async close() {},
  }))
  const inspect = async (workspaceIds?: string[]) => {
    await f.channels.receive({ type: "activity", requestId: 1, workspaceIds })
    const reply = f.events.at(-1)
    if (reply?.type !== "activity") throw Error("Expected activity report")
    return Object.fromEntries(reply.scopes)
  }
  await f.open("one")
  await f.open("two", f.paths[1])
  const initializing = f.data("one", "initialize")
  const work = f.data("one", "hold")
  try {
    expect(await inspect()).toEqual({ one: true, two: true })
    handshake.resolve()
    await initializing
    expect(await inspect(["one", "gone"])).toEqual({ one: true, gone: true })
    release.resolve()
    await work
    expect(await inspect()).toEqual({ one: false, two: true })
  } finally { handshake.resolve(); release.resolve(); await f.channels.close() }
})

it("preserves the failed cleanup owner until retry and allows other workspaces to run", async () => {
  const close = vi.fn(async () => {}).mockRejectedValueOnce(Error("unsettled"))
  const f = await fixture(async options => ({
    async handleLine() { options.onWrite(makeSuccess(1, true)) }, close,
  }))
  await f.open("w")
  await f.close("w")
  expect(f.events.at(-1)).toEqual({ type: "error", workspaceId: "w", operation: "close", message: "unsettled" })
  await f.data("w", "read")
  expect(f.events.at(-1)).toMatchObject({ type: "error", workspaceId: "w", operation: "data" })
  await f.open("w", f.paths[1])
  expect(f.events.at(-1)).toMatchObject({ type: "error", operation: "open" })
  await f.open("other", f.paths[1])
  await f.data("other", "read")
  expect(f.events.at(-1)).toMatchObject({ type: "data", workspaceId: "other" })
  await f.close("w")
  expect(f.events.at(-1)).toEqual({ type: "closed", workspaceId: "w" })
  expect(close).toHaveBeenCalledTimes(2)
  await f.channels.close()
})

it("retains failed startup cleanup for retry before reopening the same workspace", async () => {
  let builds = 0
  const cleanup = vi.fn(async () => {}).mockRejectedValueOnce(Error("cleanup still pending"))
  const f = await fixture(async options => {
    if (++builds === 1) throw new DesktopHostStartupError(Error("startup failed"), Error("cleanup failed"), cleanup)
    return { async handleLine() { options.onWrite(makeSuccess(1, true)) }, async close() {} }
  })
  await f.open("w")
  await f.open("other", f.paths[1])
  await f.data("other", "read")
  expect(f.events.at(-1)).toMatchObject({ type: "data", workspaceId: "other" })
  await f.open("w")
  expect(f.events.at(-1)).toMatchObject({ type: "error", message: "cleanup still pending" })
  expect(builds).toBe(2)
  await f.open("w")
  expect(f.events.at(-1)).toEqual({ type: "opened", workspaceId: "w" })
  expect(cleanup).toHaveBeenCalledTimes(2)
  expect(builds).toBe(3)
  await f.channels.close()
})

it("only admits the profile root for the configuration channel and creates no session directory", async () => {
  const create = vi.fn(async () => ({ async close() {}, async handleLine() {} }))
  const f = await fixture(create)
  await f.open("desktop-configuration", f.paths[0])
  expect(create).not.toHaveBeenCalled()
  if (process.platform === "win32") {
    await f.open("DESKTOP-CONFIGURATION", f.root)
    expect(create).not.toHaveBeenCalled()
  }
  await f.open("desktop-configuration", f.root)
  expect(f.events.at(-1)).toEqual({ type: "opened", workspaceId: "desktop-configuration" })
  await expect(stat(join(f.root, "sessions", "desktop-configuration"))).rejects.toMatchObject({ code: "ENOENT" })
  await f.channels.close()
})

it("joins and retries unpublished startup cleanup during whole-host shutdown", async () => {
  const started = Promise.withResolvers<void>(), fail = Promise.withResolvers<void>()
  const retry = vi.fn(async () => {}).mockRejectedValueOnce(Error("still held"))
  const f = await fixture(async () => {
    started.resolve()
    await fail.promise
    throw new DesktopHostStartupError(Error("startup failed"), Error("rollback failed"), retry)
  })
  const opening = f.open("w")
  await started.promise
  const closing = f.channels.close()
  fail.resolve()
  await expect(closing).rejects.toThrow("workspace cleanup incomplete")
  await opening
  await f.channels.close()
  expect(retry).toHaveBeenCalledTimes(2)
})

it("checks workspace roots and identities before constructing a host", async () => {
  const create = vi.fn(async () => ({ async close() {}, async handleLine() {} }))
  const f = await fixture(create)
  await f.open("../other")
  await f.open("w", "relative")
  await f.open("w", join(f.root, "missing"))
  expect(create).not.toHaveBeenCalled()
  await f.channels.receive({ type: "ping" })
  expect(f.events.at(-1)).toEqual({ type: "pong" })
  if (process.platform === "win32") {
    await f.open("CON")
    expect(create).not.toHaveBeenCalled()
    await f.open("w")
    await f.open("W")
    await f.data("W", "read")
    await f.close("W")
    expect(f.events.slice(-3).every(e => e.type === "error")).toBe(true)
    await f.close("w")
    await f.open("W")
    expect(f.events.at(-1)).toMatchObject({ type: "error", operation: "open" })
    expect(create).toHaveBeenCalledOnce()
  }
  await f.channels.close()
})
