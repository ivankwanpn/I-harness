import { spawn } from "node:child_process"
import { once, on } from "node:events"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, it } from "vitest"
import type { DesktopHostCommand, DesktopHostEvent } from "../src/host-protocol.ts"

it("hosts two real SDK connections with the same session ID and releases them independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-single-host-cli-"))
  const config = join(root, "config")
  const a = join(root, "a"), b = join(root, "b")
  await Promise.all([config, a, b].map(path => mkdir(path)))
  await writeFile(join(config, "settings.json"), JSON.stringify({ autoTitle: false, sandboxMode: "read-only", sessionStore: "jsonl" }))
  const loader = createRequire(new URL("../../../package.json", import.meta.url)).resolve("tsx")
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
  const child = spawn(process.execPath, ["--import", pathToFileURL(loader).href, cli, "--desktop-host", "--sessions-root", join(root, "sessions")],
    { cwd: root, env: { ...process.env, IH_CONFIG_DIR: config }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  const exited = once(child, "exit")
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const incoming = on(input, "line", { close: ["close"] })
  let diagnostic = ""
  child.stderr.setEncoding("utf8").on("data", message => { diagnostic = (diagnostic + message).slice(-4096) })
  let last: DesktopHostCommand | undefined
  const send = (frame: DesktopHostCommand) => { last = frame; child.stdin.write(JSON.stringify(frame) + "\n") }
  const deadline = setTimeout(() => { diagnostic += "\nTimed out after " + JSON.stringify(last); child.kill() }, 60_000)
  async function receive(accept: (event: DesktopHostEvent) => boolean) {
    for (;;) {
      const item = await incoming.next()
      if (item.done) throw Error("Desktop host closed: " + diagnostic)
      const event = JSON.parse(item.value[0]) as DesktopHostEvent
      if (event.type === "error") throw Error(event.message)
      if (accept(event)) return event
    }
  }
  async function rpc(workspaceId: string, method: string, params: Record<string, unknown> = {}) {
    send({ workspaceId, type: "data", line: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
    const reply = await receive(event => event.type === "data" && event.workspaceId === workspaceId && JSON.parse(event.line).id === 1)
    if (reply.type !== "data") throw Error("Expected scoped SDK reply")
    const message = JSON.parse(reply.line)
    if (message.error) throw Error(method + ": " + message.error.message)
    return message.result
  }
  async function open(workspaceId: string, workspacePath: string) {
    send({ type: "open", workspaceId, workspacePath })
    await receive(event => event.type === "opened" && event.workspaceId === workspaceId)
    return rpc(workspaceId, "initialize")
  }
  try {
    await open("a", a)
    await open("b", b)
    const configuration = "desktop-configuration"
    const settingsInfo = await open(configuration, root)
    send({ type: "activity", requestId: 1 })
    expect(await receive(event => event.type === "activity")).toMatchObject({
      requestId: 1, scopes: [["a", false], ["b", false], [configuration, false]], profileActive: false,
    })
    expect(settingsInfo.capabilities).toEqual({
      "desktop-runtime-activity": ["1"], "desktop-provider": ["1"], "desktop-usage": ["1", "2"],
      "desktop-model-wait-settings": ["1"], "desktop-model-retry-settings": ["1"], "desktop-auto-title": ["1"],
    })
    expect(await rpc(configuration, "desktop/model-retry/configure", { maxRetries: 3 })).toEqual({ maxRetries: 3 })
    expect(await rpc("b", "desktop/model-retry/state")).toEqual({ maxRetries: 3 })
    expect(await rpc(configuration, "desktop/coding-plans/state")).toMatchObject({ accounts: [] })
    expect(await rpc(configuration, "desktop/runtime/activity")).toEqual({ active: false })
    await expect(rpc(configuration, "session/create")).rejects.toThrow("Unknown configuration method")
    await expect(stat(join(root, "sessions", configuration))).rejects.toMatchObject({ code: "ENOENT" })
    send({ type: "close", workspaceId: configuration })
    await receive(event => event.type === "closed" && event.workspaceId === configuration)
    const { sessionId } = await rpc("a", "session/create", { clientToken: "same-draft-identity" })
    expect(typeof sessionId).toBe("string")
    expect((await rpc("b", "session/list")).sessions).toEqual([])
    expect(await rpc("b", "session/create", { clientToken: "same-draft-identity" })).toMatchObject({ sessionId })
    await rpc("a", "desktop/session/manage", { sessionId, action: "rename", title: "A only" })
    expect((await rpc("a", "session/list")).sessions).toContainEqual(expect.objectContaining({ id: sessionId, title: "A only" }))
    expect((await rpc("b", "session/list")).sessions).not.toContainEqual(expect.objectContaining({ title: "A only" }))
    await rpc("a", "shutdown")
    send({ type: "close", workspaceId: "a" })
    await receive(event => event.type === "closed" && event.workspaceId === "a")
    expect(await rpc("b", "ping")).toEqual({ ok: true })
    await open("a", a)
    expect((await rpc("a", "session/list")).sessions).toContainEqual(expect.objectContaining({ id: sessionId, title: "A only" }))
    send({ type: "shutdown" })
    expect((await exited)[0], diagnostic).toBe(0)
  } finally {
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 5000)
    try { await exited } finally { clearTimeout(timer); clearTimeout(deadline); input.close(); await rm(root, { recursive: true, force: true }) }
  }
}, 90_000)
