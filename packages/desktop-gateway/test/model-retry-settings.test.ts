import { afterEach, expect, it } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionService } from "@i-harness/session-executor"
import { createSdkServer } from "@i-harness/sdk/server"
import { encodeFrame, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createModelRetrySettings } from "../src/model-retry-settings.ts"
import { createDesktopRouter, createGatewayWrite } from "../src/router.ts"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it("exposes bounded retry settings through the gateway and persists zero across reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-retry-settings-")); roots.push(root)
  const path = join(root, "settings.json"), modelRetry = createModelRetrySettings(path)
  const sent: RpcMessage[] = []
  const service = createSessionService({ workspace: root, modelPolicy: "required" })
  const send = (frame: RpcMessage) => { sent.push(frame) }, handlers = { modelRetry }
  const router = createDesktopRouter(createSdkServer(service, { onWrite: createGatewayWrite(send, handlers) }), send, handlers)
  try {
    await router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
    expect(sent[0]).toMatchObject({ result: { capabilities: { "desktop-model-retry-settings": ["1"] } } })
    await router.handleLine(encodeFrame(makeRequest(2, "desktop/model-retry/state", {})))
    expect(sent.at(-1)).toMatchObject({ result: { maxRetries: 5 } })
    await router.handleLine(encodeFrame(makeRequest(3, "desktop/model-retry/configure", { maxRetries: 0 })))
    expect(sent.at(-1)).toMatchObject({ result: { maxRetries: 0 } })
    expect(await createModelRetrySettings(path).state()).toEqual({ maxRetries: 0 })
    const before = await readFile(path, "utf8")
    for (const maxRetries of [-1, 101, 2.5, "5", null]) {
      await router.handleLine(encodeFrame(makeRequest(4, "desktop/model-retry/configure", { maxRetries })))
      expect(sent.at(-1)).toHaveProperty("error")
      expect(await readFile(path, "utf8")).toBe(before)
    }
  } finally { await router.close(); await service.close() }
})
