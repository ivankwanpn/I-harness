// M27 R-C4b: SessionService-backed SDK server (in-process): initialize,
// session/prompt → service.submit with session/event + session/status
// notifications, error codes, shutdown lifecycle.
import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEvent } from "@i-harness/core-session"
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
      expect(msg.result).toMatchObject({ name: "i-harness", protocolVersion: 2, version: "9.9" })
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  // M28 S-1 + M41a A1: sdk wire contract field-level lock (drift sentinel). Every
  // field the default initialize emits is part of the (v1) contract — a change
  // here is a breaking protocol change for embedders (see protocol.ts JSDoc +
  // docs/contracts.md "SDK Wire Contract v1"). v1 is the additive bump: the v0
  // rows are byte-identical and protocolVersion moved 1 → 2.
  it("initialize wire contract v1 (field-level lock)", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service) // default version = "0.1.0" (contract)
      const output = await server.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      const msg = decodeFrame(output!) as RpcSuccess
      expect(msg).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          name: "i-harness",
          version: "0.1.0",
          protocolVersion: 2,
          capabilities: {
            session: ["prompt", "status"],
            notifications: ["session/event", "session/status"],
            "session-history": ["1"],
            "session-list": ["1"],
          },
        },
      })
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

describe("createSdkServer v1 (session/history + session/list)", () => {
  it("session/history walks the live log (afterSeq exclusive, limit, nextSeq)", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service)
      // Drive one turn so the live session exists and has a full event log
      // (submit resolves AFTER the turn drained, so the log is stable).
      const promptReply = await server.handleLine(
        encodeFrame(makeRequest(100, "session/prompt", { sessionId: "h1", prompt: "hello" })),
      )
      expect((decodeFrame(promptReply!) as RpcSuccess).result).toEqual({ sessionId: "h1", ok: true })

      // Full walk (defaults: afterSeq 0, limit 500) — every event of the turn.
      const allReply = await server.handleLine(encodeFrame(makeRequest(101, "session/history", { sessionId: "h1" })))
      const all = decodeFrame(allReply!) as RpcSuccess
      expect(all.id).toBe(101)
      const range = all.result as { events: SessionEvent[]; nextSeq: number }
      expect(range.events.length).toBeGreaterThan(0)
      const types = range.events.map((e) => e.type)
      expect(types).toContain("turn/start")
      expect(types).toContain("user/message")
      expect(types).toContain("assistant/message")
      expect(types).toContain("turn/end")
      // seqs are 0-based positions: nextSeq == length when returned in full.
      expect(range.nextSeq).toBe(range.events.length)
      expect(range.events[0]!.seq).toBe(0)

      // afterSeq is EXCLUSIVE: only later events, same tail.
      const cut = 2
      const laterReply = await server.handleLine(
        encodeFrame(makeRequest(102, "session/history", { sessionId: "h1", afterSeq: cut })),
      )
      const later = decodeFrame(laterReply!) as RpcSuccess
      expect(later.result).toEqual({ events: range.events.slice(cut), nextSeq: range.nextSeq })

      // limit pages the log: first page of 1, nextSeq continues at 1.
      const pageReply = await server.handleLine(
        encodeFrame(makeRequest(103, "session/history", { sessionId: "h1", limit: 1 })),
      )
      expect(decodeFrame(pageReply!)).toMatchObject({
        result: { events: range.events.slice(0, 1), nextSeq: 1 },
      })

      // afterSeq past the end → empty page, nextSeq = log length (the final seq).
      const pastReply = await server.handleLine(
        encodeFrame(makeRequest(104, "session/history", { sessionId: "h1", afterSeq: 10_000 })),
      )
      expect(decodeFrame(pastReply!)).toMatchObject({
        result: { events: [], nextSeq: range.nextSeq },
      })
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("session/history unknown sessionId → -32602 with an explicit 'session not found' message", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service)
      const reply = await server.handleLine(encodeFrame(makeRequest(110, "session/history", { sessionId: "nope" })))
      const msg = decodeFrame(reply!) as RpcFailure
      expect(msg.id).toBe(110)
      expect(msg.error.code).toBe(INVALID_PARAMS)
      expect(String(msg.error.message)).toContain("session not found")
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("session/history validates afterSeq/limit (non-integer or negative → -32602)", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service)
      for (const bad of [
        { sessionId: "h1", afterSeq: -1 },
        { sessionId: "h1", afterSeq: 1.5 },
        { sessionId: "h1", limit: 0 },
        { sessionId: "h1", limit: -2 },
      ]) {
        const reply = await server.handleLine(encodeFrame(makeRequest(111, "session/history", bad)))
        expect((decodeFrame(reply!) as RpcFailure).error.code).toBe(INVALID_PARAMS)
      }
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("session/list without a listing source → { sessions: [], listingUnavailable: true }", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service) // no listSessions option wired
      const reply = await server.handleLine(encodeFrame(makeRequest(120, "session/list", {})))
      expect((decodeFrame(reply!) as RpcSuccess).result).toEqual({ sessions: [], listingUnavailable: true })
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("session/list passes the listing source through verbatim", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service, {
        listSessions: async () => ({
          sessions: [
            { id: "a", title: "Alpha" },
            { id: "b", turnCount: 3, updatedAt: 1_720_000_000_000, contextUsed: 100, contextTotal: 500 },
          ],
        }),
      })
      const reply = await server.handleLine(encodeFrame(makeRequest(121, "session/list", {})))
      expect((decodeFrame(reply!) as RpcSuccess).result).toEqual({
        sessions: [
          { id: "a", title: "Alpha" },
          { id: "b", turnCount: 3, updatedAt: 1_720_000_000_000, contextUsed: 100, contextTotal: 500 },
        ],
      })
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("session/list source failure → -32603 (fail-closed, never a fake empty list)", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service, {
        listSessions: () => Promise.reject(new Error("store exploded")),
      })
      const reply = await server.handleLine(encodeFrame(makeRequest(122, "session/list", {})))
      const msg = decodeFrame(reply!) as RpcFailure
      expect(msg.error.code).toBe(INTERNAL_ERROR)
      expect(String(msg.error.message)).toContain("store exploded") // raw message, prompt-failure convention
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("v0-shaped client surface still works after the v1 bump (additive guarantee)", async () => {
    // A hand-written v0 client knows ONLY: initialize / session/prompt /
    // session/status / shutdown. Every one of its requests must behave exactly
    // per the v0 contract — the new methods neither change nor break it.
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service)
      const init = await server.handleLine(encodeFrame(makeRequest(130, "initialize", {})))
      expect((decodeFrame(init!) as RpcSuccess).result).toMatchObject({
        name: "i-harness",
        protocolVersion: 2, // the version moved — but the v0 METHOD surface is intact
      })
      const prompt = await server.handleLine(
        encodeFrame(makeRequest(131, "session/prompt", { sessionId: "v0c", prompt: "hello" })),
      )
      expect((decodeFrame(prompt!) as RpcSuccess).result).toEqual({ sessionId: "v0c", ok: true })
      const status = await server.handleLine(encodeFrame(makeRequest(132, "session/status", { sessionId: "v0c" })))
      expect((decodeFrame(status!) as RpcSuccess).result).toEqual({ running: false, queued: 0 })
      const shutdown = await server.handleLine(encodeFrame(makeRequest(133, "shutdown", {})))
      expect((decodeFrame(shutdown!) as RpcSuccess).result).toEqual({ ok: true })
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })
})
