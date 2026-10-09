import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"
import { ReadableStream, WritableStream } from "node:stream/web"
import { expect, it, vi } from "vitest"
const captured = vi.hoisted(() => [] as any[])
vi.mock("@i-harness/session-executor", async importOriginal => {
  const actual = await importOriginal<typeof import("@i-harness/session-executor")>()
  return { ...actual, createSessionService: (options: any) => { captured.push(options); return actual.createSessionService(options) } }
})
vi.mock("node:readline", async () => {
  const { EventEmitter } = await import("node:events")
  return { createInterface: () => { const stream = new EventEmitter() as any; stream.close = () => {}; setTimeout(() => stream.emit("close"), 10); return stream } }
})
vi.mock("@i-harness/acp", () => ({ createAcpServer: () => ({ connect: () => ({ closed: Promise.resolve(), close() {} }) }) }))
import { main } from "../src/index.ts"

it.each(["sdk", "acp"])("%s captures persisted sandbox, WSL and web execution settings without a model call", async command => {
  mkdirSync(resolve(".tmp"), { recursive: true })
  const root = mkdtempSync(resolve(".tmp/wsl-product-integration-stdio-")), before = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = root; captured.length = 0
  writeFileSync(join(root, "settings.json"), JSON.stringify({ windowsSandboxBackend: "wsl", wslExecution: { distribution: "Ubuntu-24.04", networkAccess: true, workspaceDependencies: false }, sandboxMode: "read-only", webSearchMode: "disabled" }))
  // The ACP connection's controlled EOF never attaches to the user's stdin.
  vi.spyOn(Readable, "toWeb").mockReturnValue(new ReadableStream({ start(controller) { controller.close() } }))
  vi.spyOn(Writable, "toWeb").mockReturnValue(new WritableStream())
  try {
    expect(await main(["node", "ih", command])).toBe(0)
    expect(captured[0]).toMatchObject({ sandbox: "read-only", windowsSandboxBackend: "wsl", webSearchMode: "disabled", webCacheRoot: join(root, "web-cache") })
    expect(await captured[0].wslExecutionFor()).toEqual({ distribution: "Ubuntu-24.04", networkAccess: true, workspaceDependencies: false })
  } finally { vi.restoreAllMocks(); if (before === undefined) delete process.env.IH_CONFIG_DIR; else process.env.IH_CONFIG_DIR = before; rmSync(root, { recursive: true, force: true }) }
})
