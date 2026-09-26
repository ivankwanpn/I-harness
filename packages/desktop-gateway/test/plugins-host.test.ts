import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { encodeFrame, makeRequest, isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
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
