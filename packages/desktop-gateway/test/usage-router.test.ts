import { expect, it, vi } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { createSdkServer } from "@i-harness/sdk/server"
import { encodeFrame, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopRouter, createGatewayWrite } from "../src/router.ts"
import type { DesktopHandlers } from "../src/types.ts"

it("exposes global usage read and pricing through initialized gateway RPC", async () => {
  const frames: RpcMessage[] = []
  const query = vi.fn(async () => ({ totalRecords: 0 }))
  const setPricing = vi.fn(async () => {})
  const handlers: DesktopHandlers = { usageStats: { query, setPricing } as any }
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "required" })
  const send = (frame: RpcMessage) => frames.push(frame)
  const router = createDesktopRouter(createSdkServer(service, { onWrite: createGatewayWrite(send, handlers) }), send, handlers)
  try {
    await router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
    expect(frames[0]).toMatchObject({ result: { capabilities: { "desktop-usage": ["1"] } } })
    await router.handleLine(encodeFrame(makeRequest(2, "desktop/usage/query", { query: { start: 0, end: 86400000, timeZone: "UTC" } })))
    expect(frames.at(-1)).toMatchObject({ id: 2, result: { totalRecords: 0 } })
    expect(query).toHaveBeenCalledTimes(1)
    await router.handleLine(encodeFrame(makeRequest(3, "desktop/usage/query", { query: { start: 100, end: 0, timeZone: "UTC" } })))
    expect(frames.at(-1)).toHaveProperty("error")
    expect(query).toHaveBeenCalledTimes(1)
    const price = { providerId: "p", modelId: "m", inputPerMillion: 1, outputPerMillion: 2, source: "contract", updatedAt: 1 }
    await router.handleLine(encodeFrame(makeRequest(4, "desktop/usage/pricing", { price })))
    expect(frames.at(-1)).toMatchObject({ id: 4, result: { saved: true } })
    expect(setPricing).toHaveBeenCalledWith(price)
  } finally { await router.close(); await service.close() }
})

it("returns a generic storage error without leaking paths or credentials", async () => {
  const frames: RpcMessage[] = []
  const handlers: DesktopHandlers = { usageStats: { query: vi.fn(async () => { throw new Error("secret path + token") }), setPricing: vi.fn() } }
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "required" })
  const send = (frame: RpcMessage) => frames.push(frame)
  const router = createDesktopRouter(createSdkServer(service, { onWrite: createGatewayWrite(send, handlers) }), send, handlers)
  try {
    await router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
    await router.handleLine(encodeFrame(makeRequest(2, "desktop/usage/query", { query: { start: 0, end: 86400000, timeZone: "UTC" } })))
    expect(frames.at(-1)).toHaveProperty("error")
    expect(JSON.stringify(frames.at(-1))).not.toContain("secret")
  } finally { await router.close(); await service.close() }
})
