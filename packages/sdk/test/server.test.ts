// M27 R-C4b: SessionService-backed SDK server (in-process): initialize,
// session/prompt → service.submit with session/event + session/status
// notifications, error codes, shutdown lifecycle.
import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionService, type SessionService } from "@i-harness/session-executor"
import { createSdkServer, type SdkServer } from "../src/server.ts"
import {
  decodeFrame,
  encodeFrame,
  makeRequest,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  isRpcNotification,
  type RpcMessage,
  type RpcSuccess,
  type RpcFailure,
} from "../src/protocol.ts"

async function makeService(): Promise<{ service: SessionService; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ih-sdk-server-"))
  const service = createSessionService({
    workspace: dir,
    approveAll: true,
    mockScript: [{ role: "assistant", text: "hello from the mock" }],
  })
  return { service, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** A test harness that runs handleLine per line and records every output
 * (responses via the returned promise, notifications via onNotify). */
function drive(server: SdkServer): {
  out: RpcMessage[]
  line(line: string): Promise<string | null>
  waitFor(fn: (m: RpcMessage) => boolean, timeoutMs?: number): Promise<RpcMessage>
} {
  const out: RpcMessage[] = []
  server.onNotify((m) => out.push(m))
  return {
    out,
    line: (l) => server.handleLine(l),
    waitFor: (fn, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const start = Date.now()
        const poll = (): void => {
          const found = out.find(fn)
          if (found !== undefined) return resolve(found)
          if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for message"))
          setTimeout(poll, 10)
        }
        poll()
      }),
  }
}

describe("createSdkServer", () => {
  it("initialize returns the server info", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service, { version: "9.9" })
      const output = await server.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      const msg = decodeFrame(output!) as RpcSuccess
      expect(msg.id).toBe(1)
      expect(msg.result).toMatchObject({ name: "i-harness", protocolVersion: 1, version: "9.9" })
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("session/prompt streams session events + status notifications and resolves ok", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service)
      const driveState = drive(server)
      const responsePromise = server.handleLine(
        encodeFrame(makeRequest(2, "session/prompt", { sessionId: "s1", prompt: "hello" })),
      )
      const response = decodeFrame((await responsePromise)!) as RpcSuccess
      expect(response.id).toBe(2)
      expect(response.result).toEqual({ sessionId: "s1", ok: true })

      const notifications = driveState.out.filter(isRpcNotification)
      const eventNotifs = notifications.filter((n) => n.method === "session/event")
      expect(eventNotifs.length).toBeGreaterThan(0)
      const eventSeq = eventNotifs.map((n) => (n.params as { event: { type: string } }).event.type)
      expect(eventSeq).toContain("turn/start")
      expect(eventSeq).toContain("assistant/message")
      expect(eventSeq).toContain("turn/end")
      // the assistant text reached the stream
      const text = eventNotifs
        .map((n) => (n.params as { event: { type: string; text?: string } }).event.text)
        .find((t) => typeof t === "string" && t.includes("mock"))
      expect(text).toContain("hello from the mock")
      // lifecycle status notifications present
      expect(notifications.some((n) => n.method === "session/status")).toBe(true)
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("validates session/prompt params (invalid → -32602)", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service)
      const bad = await server.handleLine(encodeFrame(makeRequest(3, "session/prompt", { sessionId: "", prompt: "" })))
      const msg = decodeFrame(bad!) as RpcFailure
      expect(msg.id).toBe(3)
      expect(msg.error.code).toBe(INVALID_PARAMS)
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("unknown method → -32601; malformed line → ignored (no output)", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service)
      const written: RpcMessage[] = []
      server.onNotify((m) => written.push(m))
      const unknown = await server.handleLine(encodeFrame(makeRequest(4, "nope-nothing", {})))
      expect((decodeFrame(unknown!) as RpcFailure).error.code).toBe(METHOD_NOT_FOUND)
      const malformed = await server.handleLine("garbage {{{")
      expect(malformed).toBeNull()
      expect(written).toEqual([])
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("session/status reports the queue state", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service)
      const status = await server.handleLine(encodeFrame(makeRequest(5, "session/status", { sessionId: "s9" })))
      expect((decodeFrame(status!) as RpcSuccess).result).toEqual({ running: false, queued: 0 })
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("shutdown responds ok and fires the shutdown hook", async () => {
    const { service, cleanup } = await makeService()
    try {
      let shutdownSeen = false
      const server = createSdkServer(service, { onShutdown: () => { shutdownSeen = true } })
      const reply = await server.handleLine(encodeFrame(makeRequest(6, "shutdown", {})))
      expect((decodeFrame(reply!) as RpcSuccess).result).toEqual({ ok: true })
      await new Promise((r) => setTimeout(r, 10))
      expect(shutdownSeen).toBe(true)
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("a failed turn rejects the prompt (error response carries the message)", async () => {
    // Service whose lane rejects on the first turn failure: a mock that calls
    // a missing skill (SKILL_NOT_FOUND throw) fails the turn.
    const dir = await mkdtemp(join(tmpdir(), "ih-sdk-server-fail-"))
    const service = createSessionService({
      workspace: dir,
      approveAll: true,
      mockScript: [{ role: "assistant", toolCalls: [{ name: "skill_get", args: { name: "missing" } }] }],
    })
    try {
      const server = createSdkServer(service)
      const reply = await server.handleLine(encodeFrame(makeRequest(7, "session/prompt", { sessionId: "s2", prompt: "go" })))
      const msg = decodeFrame(reply!) as RpcFailure
      expect(msg.id).toBe(7)
      expect(msg.error.code).toBe(INTERNAL_ERROR)
      expect(String(msg.error.message)).toContain("SKILL_NOT_FOUND")
      await server.close()
    } finally {
      await service.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
