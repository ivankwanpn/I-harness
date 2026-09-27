import { describe, expect, it, vi } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { createSdkServer } from "@i-harness/sdk/server"
import type { SdkServer } from "@i-harness/sdk/server"
import {
  decodeFrame,
  encodeFrame,
  INVALID_REQUEST,
  isRpcFailure,
  isRpcSuccess,
  makeRequest,
  makeSuccess,
  type RpcMessage,
} from "@i-harness/sdk"
import { createDesktopRouter, createGatewayWrite } from "../src/router.ts"
import type { DesktopHandlers } from "../src/types.ts"

it("advertises and validates session reminder methods only when the schedule handler is wired", async () => {
  const sent: RpcMessage[] = []
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", mockScript: [] })
  const schedules = { list: vi.fn(async () => ({ schedules: [] })), create: vi.fn(async () => ({ id: "schedule-1", kind: "after", scheduledAt: "2099-01-01T00:00:00.000Z" })), delete: vi.fn(async (_sessionId: string, id: string) => ({ deleted: id })) } as unknown as NonNullable<DesktopHandlers["schedules"]>
  const handlers: DesktopHandlers = { schedules }
  const send = (frame: RpcMessage) => { sent.push(frame) }
  const base = createSdkServer(service, { onWrite: createGatewayWrite(send, handlers) })
  const router = createDesktopRouter(base, send, handlers)
  try {
    await router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
    expect(sent[0]).toMatchObject({ result: { capabilities: { "desktop-schedule": ["1"] } } })
    await router.handleLine(encodeFrame(makeRequest(2, "desktop/schedule/create", { sessionId: "s", command: { prompt: "x", after_seconds: 600, every_seconds: 300 } })))
    expect(isRpcFailure(sent.at(-1))).toBe(true)
    expect(schedules.create).not.toHaveBeenCalled()
    await router.handleLine(encodeFrame(makeRequest(3, "desktop/schedule/create", { sessionId: "s", command: { prompt: "later", after_seconds: 600, command: "pwsh" } })))
    expect(isRpcFailure(sent.at(-1))).toBe(true)
    expect(schedules.create).not.toHaveBeenCalled()
    await router.handleLine(encodeFrame(makeRequest(4, "desktop/schedule/create", { sessionId: "s", command: { prompt: "later", after_seconds: 600 } })))
    expect(isRpcSuccess(sent.at(-1))).toBe(true)
    expect(schedules.create).toHaveBeenCalledWith("s", { prompt: "later", after_seconds: 600 })
    await router.handleLine(encodeFrame(makeRequest(5, "desktop/schedule/list", { sessionId: "s" })))
    expect(schedules.list).toHaveBeenCalledWith("s")
    await router.handleLine(encodeFrame(makeRequest(6, "desktop/schedule/delete", { sessionId: "s", id: "schedule-1" })))
    expect(schedules.delete).toHaveBeenCalledWith("s", "schedule-1")
  } finally { await router.close(); await service.close() }
})

function fixture() {
  const sent: RpcMessage[] = []
  const service = createSessionService({
    workspace: process.cwd(),
    modelPolicy: "test-mock",
    mockScript: [{ role: "assistant", text: "ok" }],
  })
  const send = (frame: RpcMessage) => { sent.push(frame) }
  const handlers: DesktopHandlers = {
    sandboxState: () => ({ mode: "workspace-write", source: "settings", wired: true }),
  }
  const base = createSdkServer(service, { onWrite: createGatewayWrite(send, handlers) })
  const router = createDesktopRouter(base, send, handlers)
  return {
    sent,
    router,
    async close() { await router.close(); await service.close() },
  }
}

describe("Desktop SDK router", () => {
  it("reserves a session while an asynchronous model switch is pending", async () => {
    const sent: RpcMessage[] = []
    let release!: () => void
    const base = {
      async handleLine(line: string) {
        const frame = decodeFrame(line)
        if (!frame || !("method" in frame)) return null
        if (frame.method === "initialize") return encodeFrame(makeSuccess(1, {}))
        if (frame.method === "session/model/set") await new Promise<void>((resolve) => { release = resolve })
        return null
      },
      async close() {},
    } as SdkServer
    const router = createDesktopRouter(base, (frame) => sent.push(frame), { compact: async () => ({ compacted: true }) })
    await router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
    const change = router.handleLine(encodeFrame(makeRequest(2, "session/model/set", { sessionId: "s" })))
    await Promise.resolve()
    await router.handleLine(encodeFrame(makeRequest(3, "session/prompt", { sessionId: "s", prompt: "test" })))
    await router.handleLine(encodeFrame(makeRequest(4, "desktop/session/compact", { sessionId: "s" })))
    expect(sent).toHaveLength(2)
    expect(sent.every(isRpcFailure)).toBe(true)
    release(); await change; await router.close()
  })
  it("cancels an active SDK prompt before closing", async () => {
    const sent: RpcMessage[] = []
    let releasePrompt = () => {}
    let cancelled = false
    const base = {
      async handleLine(line: string) {
        const frame = decodeFrame(line)
        if (!frame || !("method" in frame) || !("id" in frame)) return null
        if (frame.method === "initialize") return encodeFrame(makeSuccess(1, { name: "test", version: "1", protocolVersion: 3, capabilities: {} }))
        if (frame.method === "session/prompt") {
          await new Promise<void>((resolve) => { releasePrompt = resolve })
          return encodeFrame(makeSuccess(2, { ok: true }))
        }
        if (frame.method === "session/cancel") { cancelled = true; releasePrompt(); return encodeFrame(makeSuccess(frame.id, { cancelled: true })) }
        return null
      },
      async close() {},
    } as SdkServer
    const router = createDesktopRouter(base, (frame) => { sent.push(frame) }, {})
    await router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
    const prompt = router.handleLine(encodeFrame(makeRequest(2, "session/prompt", { sessionId: "s1", prompt: "wait" })))
    await router.close()
    await prompt
    expect(cancelled).toBe(true)
  })

  it("advertises sandbox only when a sandbox-state handler is installed", () => {
    const frames: RpcMessage[] = []
    const write = createGatewayWrite((frame) => frames.push(frame), {
      sandboxState: () => ({ mode: "read-only", source: "settings", wired: true }),
    })
    write(makeSuccess(1, { name: "i-harness", version: "0.1.0", protocolVersion: 3, capabilities: { session: ["prompt"] } }))
    const reply = frames[0]
    expect(isRpcSuccess(reply)).toBe(true)
    if (!isRpcSuccess(reply)) throw new Error("initialize reply missing")
    expect((reply.result as { capabilities: Record<string, string[]> }).capabilities["desktop-sandbox"]).toEqual(["1"])
  })

  it("advertises only installed Desktop capabilities without changing SDK v3", async () => {
    const f = fixture()
    try {
      await f.router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      expect(f.sent).toHaveLength(1)
      const reply = f.sent[0]
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) throw new Error("initialize was not a success")
      const result = reply.result as { protocolVersion: number; capabilities: Record<string, string[]> }
      expect(result.protocolVersion).toBe(3)
      expect(result.capabilities.session).toEqual(["prompt", "status"])
      expect(result.capabilities["desktop-sandbox"]).toEqual(["1"])
      expect(result.capabilities["desktop-interaction"]).toBeUndefined()
      expect(result.capabilities["desktop-review"]).toBeUndefined()
      expect(result.capabilities["desktop-provider"]).toBeUndefined()
    } finally { await f.close() }
  })

  it("refuses Desktop requests before initialize and answers sandbox state after it", async () => {
    const f = fixture()
    try {
      const request = encodeFrame(makeRequest("s", "desktop/sandbox/state", {}))
      await f.router.handleLine(request)
      expect(f.sent).toHaveLength(1)
      expect(isRpcFailure(f.sent[0])).toBe(true)
      if (!isRpcFailure(f.sent[0])) throw new Error("pre-initialize request was accepted")
      expect(f.sent[0].error.code).toBe(INVALID_REQUEST)
      await f.router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      await f.router.handleLine(request)
      expect(f.sent).toHaveLength(3)
      const reply = f.sent[2]
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) throw new Error("sandbox request failed")
      expect(reply.result).toEqual({ mode: "workspace-write", source: "settings", wired: true })
    } finally { await f.close() }
  })

  it("delegates SDK requests exactly once and ignores malformed lines", async () => {
    const f = fixture()
    try {
      await f.router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      f.sent.length = 0
      await f.router.handleLine(encodeFrame(makeRequest(2, "session/status", { sessionId: "missing" })))
      expect(f.sent).toHaveLength(1)
      const reply = f.sent[0]
      expect(reply && "id" in reply ? reply.id : undefined).toBe(2)
      await f.router.handleLine("{not-json")
      expect(f.sent).toHaveLength(1)
      expect(decodeFrame(encodeFrame(f.sent[0]!))).toEqual(f.sent[0])
    } finally { await f.close() }
  })
})
