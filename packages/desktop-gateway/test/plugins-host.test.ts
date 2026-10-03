import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { encodeFrame, makeRequest, isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
it("lists authored commands through the same effective local/plugin precedence after create, edit and removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-effective-command-host-")), workspace = join(root, "workspace")
  await mkdir(workspace)
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir: join(root, "sessions"), settingsPath: join(root, "settings.json"), onWrite: frame => frames.push(frame) })
  let id = 0
  const call = async (method: string, params: unknown = {}) => {
    const requestId = ++id; await host.handleLine(encodeFrame(makeRequest(requestId, method, params)))
    const reply = frames.find(frame => "id" in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply)); return reply.result
  }
  const command = (description: string, hints: string) => `---\ndescription: ${description}\nargument-hints: ${hints}\n---\nOwned command body $ARGUMENTS`
  const write = (source: "global" | "workspace", name: string, body: string, expectedRevision: string | null = null) => call("desktop/resources/write", { resourceKind: "commands", source, name, body, expectedRevision }) as Promise<{ kind: string; revision: string }>
  const remove = (source: "global" | "workspace", name: string, expectedRevision: string) => call("desktop/resources/remove", { resourceKind: "commands", source, name, expectedRevision, confirmed: true })
  const listed = () => call("desktop/plugins/commands") as Promise<{ name: string; description?: string; argumentHints?: string }[]>
  try {
    await call("initialize")
    expect(await listed()).toEqual([]); expect(await call("session/list")).toEqual({ sessions: [] })
    const local = await write("workspace", "native-command", command("Native initial", "[initial]"))
    expect(local.kind).toBe("saved")
    expect(await listed()).toContainEqual({ name: "native-command", description: "Native initial", argumentHints: "[initial]" })
    const edited = await write("workspace", "native-command", command("Native edited", "[edited]"), local.revision)
    expect(await listed()).toContainEqual({ name: "native-command", description: "Native edited", argumentHints: "[edited]" })
    expect(JSON.stringify(await listed())).not.toContain("Owned command body")
    const global = await write("global", "hello", command("Global hello", "[global]"))
    const source = fileURLToPath(new URL("../../plugin-registry/test/fixtures/marketplace-a", import.meta.url))
    await call("desktop/plugins/mutate", { action: "source/add", source }); await call("desktop/plugins/mutate", { action: "install", id: "Marketplace A__hello" })
    await call("desktop/plugins/mutate", { action: "disable", id: "Marketplace A__hello" })
    expect((await listed()).find(row => row.name === "hello")).toEqual({ name: "hello", description: "Global hello", argumentHints: "[global]" })
    await call("desktop/plugins/mutate", { action: "enable", id: "Marketplace A__hello" })
    expect((await listed()).filter(row => row.name === "hello")).toEqual([{ name: "hello", description: "Greets the user by name", argumentHints: "[name]" }])
    const override = await write("workspace", "hello", command("Workspace hello", "[workspace]"))
    expect((await listed()).filter(row => row.name === "hello")).toEqual([{ name: "hello", description: "Workspace hello", argumentHints: "[workspace]" }])
    expect(await call("desktop/resources/read", { resourceKind: "commands", name: "hello" })).toMatchObject({ source: "workspace", description: "Workspace hello" })
    await remove("workspace", "hello", override.revision)
    expect((await listed()).find(row => row.name === "hello")?.description).toBe("Greets the user by name")
    await call("desktop/plugins/mutate", { action: "disable", id: "Marketplace A__hello" })
    expect((await listed()).find(row => row.name === "hello")?.description).toBe("Global hello")
    await remove("global", "hello", global.revision); await remove("workspace", "native-command", edited.revision)
    expect(await listed()).toEqual([])
    expect(await call("session/list")).toEqual({ sessions: [] })
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
it("persists plugin source/install/enable lifecycle across gateway restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-host-"))
  const workspace = join(root, "workspace"); await mkdir(workspace)
  const frames: RpcMessage[] = []
  const options = { workspace, sessionDir: join(root, "sessions"), settingsPath: join(root, "settings.json"), onWrite: (frame: RpcMessage) => frames.push(frame) }
  let host = await createDesktopHost(options); let id = 0
  const call = async (method: string, params: unknown) => {
    const requestId = ++id
    await host.handleLine(encodeFrame(makeRequest(requestId, method, params)))
    const reply = frames.find((frame) => "id" in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  try {
    await call("initialize", {})
    const source = fileURLToPath(new URL("../../plugin-registry/test/fixtures/marketplace-a", import.meta.url))
    await call("desktop/plugins/mutate", { action: "source/add", source })
    await call("desktop/plugins/mutate", { action: "install", id: "Marketplace A__hello" })
    await call("desktop/plugins/mutate", { action: "enable", id: "Marketplace A__hello" })
    await host.close(); host = await createDesktopHost(options)
    await call("initialize", {})
    expect(await call("desktop/plugins/state", {})).toMatchObject({ plugins: expect.arrayContaining([expect.objectContaining({ id: "Marketplace A__hello", installed: true, enabled: true })]) })
    await call("desktop/plugins/mutate", { action: "disable", id: "Marketplace A__hello" })
    await call("desktop/plugins/mutate", { action: "uninstall", id: "Marketplace A__hello" })
    expect(await call("desktop/plugins/state", {})).toMatchObject({ plugins: expect.arrayContaining([expect.objectContaining({ id: "Marketplace A__hello", installed: false, enabled: false })]) })
  } finally { await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
