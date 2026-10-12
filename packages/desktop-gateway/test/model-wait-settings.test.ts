import { afterEach, expect, it } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionService } from "@i-harness/session-executor"
import { createSdkServer } from "@i-harness/sdk/server"
import { encodeFrame, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createModelWaitSettings } from "../src/model-wait-settings.ts"
import { createDesktopRouter, createGatewayWrite } from "../src/router.ts"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it("exposes bounded wait settings through the gateway and persists zero across reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-wait-settings-")); roots.push(root)
  const path = join(root, "settings.json"), modelWait = createModelWaitSettings(path)
  const sent: RpcMessage[] = []
  const service = createSessionService({ workspace: root, modelPolicy: "required" })
  const send = (frame: RpcMessage) => { sent.push(frame) }, handlers = { modelWait }
  const router = createDesktopRouter(createSdkServer(service, { onWrite: createGatewayWrite(send, handlers) }), send, handlers)
  try {
    await router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
    expect(sent[0]).toMatchObject({ result: { capabilities: { "desktop-model-wait-settings": ["1"] } } })
    await router.handleLine(encodeFrame(makeRequest(2, "desktop/model-wait/state", {})))
    expect(sent.at(-1)).toMatchObject({ result: { firstResponseSeconds: 300, progressSeconds: 300 } })
    await router.handleLine(encodeFrame(makeRequest(3, "desktop/model-wait/configure", { firstResponseSeconds: 0, progressSeconds: 30 })))
    expect(sent.at(-1)).toMatchObject({ result: { firstResponseSeconds: 0, progressSeconds: 30 } })
    expect(await createModelWaitSettings(path).state()).toEqual({ firstResponseSeconds: 0, progressSeconds: 30 })
    const before = await readFile(path, "utf8")
    for (const field of ["firstResponseSeconds", "progressSeconds"]) for (const invalid of [-1, 29, 3601, 30.5, "30", null, undefined]) {
      await router.handleLine(encodeFrame(makeRequest(4, "desktop/model-wait/configure", { firstResponseSeconds: 30, progressSeconds: 30, [field]: invalid })))
      expect(sent.at(-1)).toHaveProperty("error")
      expect(await readFile(path, "utf8")).toBe(before)
    }
  } finally { await router.close(); await service.close() }
})
