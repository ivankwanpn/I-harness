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

  // M28 S-1 + M41a A1 + M41b v1.1: sdk wire contract field-level lock (drift
  // sentinel). Every field the default initialize emits is part of the v1.1
  // contract — a change here is a breaking protocol change for embedders (see
  // protocol.ts JSDoc + docs/contracts.md "SDK Wire Contract v1/v1.1"). v1/v1.1
  // are additive bumps: protocolVersion stayed 2 (v1.1 is an APPENDIX — the
  // new surface is capability-advertised rows, the v0/v1 rows byte-identical).
  it("initialize wire contract v1.1 (field-level lock)", async () => {
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
            "session-cancel": ["1"],
            "session-rewind": ["1"],
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

describe("createSdkServer v1.1 (session/cancel + session/rewind/*)", () => {
  /** A model whose stream parks on a test-controlled gate ("scripted slow
   * step") so the turn is observable IN flight. `release` is idempotent so a
   * test's finally can always free the gate (an unreleased gate would make
   * service.close() await the parked turn forever). */
  function gatedModel(): { model: unknown; release: () => void } {
    let released = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = () => {
        if (released) return
        released = true
        resolve()
      }
    })
    return {
      release,
      model: {
        async *stream(_request: never) {
          await gate
          yield { type: "text/chunk", text: "slow ok" }
          yield { type: "end" }
        },
      },
    }
  }

  /** Poll session/status until it reports the expected running/queued flags
   * (polled — the post-submit state is written by async handlers, so a single
   * request can race ahead of them). */
  async function waitStatus(
    server: SdkServer,
    sessionId: string,
    expected: { running?: boolean; queued?: number },
  ): Promise<void> {
    const deadline = Date.now() + 5000
    for (;;) {
      const reply = await server.handleLine(encodeFrame(makeRequest(90, "session/status", { sessionId })))
      const result = (decodeFrame(reply!) as RpcSuccess).result as { running: boolean; queued: number }
      const ok = (expected.running === undefined || result.running === expected.running)
        && (expected.queued === undefined || result.queued === expected.queued)
      if (ok) return
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for status ${JSON.stringify(expected)} (status: ${JSON.stringify(result)})`)
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it("session/cancel answers cancelled:true for a running prompt (the per-session controller is aborted)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ih-sdk-cancel-run-"))
    const { model, release } = gatedModel()
    const service = createSessionService({ workspace: dir, approveAll: true, model: model as never })
    try {
      const server = createSdkServer(service)
      const drv = drive(server)
      const promptPromise = server.handleLine(
        encodeFrame(makeRequest(140, "session/prompt", { sessionId: "c1", prompt: "go" })),
      )
      await waitStatus(server, "c1", { running: true }) // the turn is in flight (stream parked on the gate)
      const cancelReply = await server.handleLine(encodeFrame(makeRequest(141, "session/cancel", { sessionId: "c1" })))
      expect((decodeFrame(cancelReply!) as RpcSuccess).result).toEqual({ cancelled: true })
      // The slot is cleared only when the submit settles; until then a second
      // cancel reports "already aborted" honestly (no in-flight slot hole is
      // masked — the controller stays registered by this submit).
      const again = await server.handleLine(encodeFrame(makeRequest(142, "session/cancel", { sessionId: "c1" })))
      expect((decodeFrame(again!) as RpcSuccess).result).toEqual({ cancelled: true })
      // M41b signal threading: cancel NOW aborts the running turn at the
      // engine — the submit settles as a FAILURE (aborted signal), not the
      // old "turn completes afterwards" semantics. The queued-gate abort is
      // the service's pre-submit check (tested separately).
      release()
      const promptReply = await promptPromise
      const frame = decodeFrame(promptReply!) as RpcFailure
      expect(frame.error).toBeDefined()
      expect(frame.error?.message).toMatch(/abort/i)
      await waitStatus(server, "c1", { running: false })
      // known + idle now → not-running
      const idle = await server.handleLine(encodeFrame(makeRequest(143, "session/cancel", { sessionId: "c1" })))
      expect((decodeFrame(idle!) as RpcSuccess).result).toEqual({ cancelled: false, reason: "not-running" })
      expect(drv.out.length).toBeGreaterThan(0)
      await server.close()
    } finally {
      release() // idempotent — never leaves a gated turn holding close()
      await service.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("session/cancel aborts a QUEUED submit (the signal reaches the service chain — it never runs)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ih-sdk-cancel-queued-"))
    const { model, release } = gatedModel()
    const service = createSessionService({ workspace: dir, approveAll: true, model: model as never })
    try {
      const server = createSdkServer(service)
      const first = server.handleLine(encodeFrame(makeRequest(150, "session/prompt", { sessionId: "cq", prompt: "first" })))
      await waitStatus(server, "cq", { running: true })
      // second submit chains behind the running turn → queued; its controller
      // is the per-session cancel slot (the latest submit — set before submit).
      const second = server.handleLine(encodeFrame(makeRequest(151, "session/prompt", { sessionId: "cq", prompt: "second" })))
      await waitStatus(server, "cq", { running: true, queued: 1 })
      const cancelReply = await server.handleLine(encodeFrame(makeRequest(153, "session/cancel", { sessionId: "cq" })))
      expect((decodeFrame(cancelReply!) as RpcSuccess).result).toEqual({ cancelled: true })
      release()
      // both submits settle (the aborted queued turn never started)…
      expect((decodeFrame((await second)!) as RpcSuccess).result).toEqual({ sessionId: "cq", ok: true })
      await first
      // …and the session log carried exactly ONE turn: the abort reached the
      // engine (service.submit checks signal.aborted before the lane runs).
      const historyReply = await server.handleLine(
        encodeFrame(makeRequest(154, "session/history", { sessionId: "cq" })),
      )
      const history = (decodeFrame(historyReply!) as RpcSuccess).result as { events: SessionEvent[] }
      expect(history.events.filter((ev) => ev.type === "turn/start")).toHaveLength(1)
      await server.close()
    } finally {
      release() // idempotent — never leaves a gated turn holding close()
      await service.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("session/cancel: unknown session → not-found; empty sessionId → -32602; param guard", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service)
      const unknown = await server.handleLine(encodeFrame(makeRequest(160, "session/cancel", { sessionId: "nope" })))
      expect((decodeFrame(unknown!) as RpcSuccess).result).toEqual({ cancelled: false, reason: "not-found" })
      const bad = await server.handleLine(encodeFrame(makeRequest(161, "session/cancel", { sessionId: "" })))
      expect((decodeFrame(bad!) as RpcFailure).error.code).toBe(INVALID_PARAMS)
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("session/rewind round-trips through a factory (points/plan/execute; execute appends the rewind/point marker into the live log)", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service, {
        rewindFactory: () => ({
          points: async () => ({ points: [{ turnIndex: 0, preview: "turn zero", files: 1 }] }),
          plan: async (_target: number, mode: "all" | "files" | "conversation") => ({
            clean: [{ path: "a.txt", op: "restore-blob" }],
            conflicts: [{ path: "b.txt", kind: "modified" }],
            unTracked: ["c.txt"],
            ops: mode === "conversation" ? [] : [{ path: "a.txt", op: "restore-blob" }],
          }),
          execute: async (target: number, mode: "all" | "files" | "conversation", hooks: { appendEvent: (ev: unknown) => void }) => {
            hooks.appendEvent({
              type: "rewind/point", version: 1, targetTurn: target, anchorSeq: 0, mode, fileOps: [],
            })
            return { revertedFiles: 1, conflicts: [] }
          },
        }),
      })
      const drv = drive(server)
      // the live session must exist (never auto-created by a rewind read)
      const promptReply = await server.handleLine(
        encodeFrame(makeRequest(170, "session/prompt", { sessionId: "r1", prompt: "hello" })),
      )
      expect((decodeFrame(promptReply!) as RpcSuccess).result).toEqual({ sessionId: "r1", ok: true })

      const points = await server.handleLine(encodeFrame(makeRequest(171, "session/rewind/points", { sessionId: "r1" })))
      expect((decodeFrame(points!) as RpcSuccess).result).toEqual({ points: [{ turnIndex: 0, preview: "turn zero", files: 1 }] })

      const plan = await server.handleLine(encodeFrame(makeRequest(172, "session/rewind/plan", { sessionId: "r1", target: 0, mode: "conversation" })))
      expect((decodeFrame(plan!) as RpcSuccess).result).toEqual({
        clean: [{ path: "a.txt", op: "restore-blob" }],
        conflicts: [{ path: "b.txt", kind: "modified" }],
        unTracked: ["c.txt"],
        ops: [],
      })
      // mode omitted → server default "all" (ops present)
      const planDefault = await server.handleLine(encodeFrame(makeRequest(173, "session/rewind/plan", { sessionId: "r1", target: 0 })))
      expect((decodeFrame(planDefault!) as RpcSuccess).result).toMatchObject({ ops: [{ path: "a.txt", op: "restore-blob" }] })

      const execute = await server.handleLine(encodeFrame(makeRequest(174, "session/rewind/execute", { sessionId: "r1", target: 0, mode: "conversation" })))
      expect((decodeFrame(execute!) as RpcSuccess).result).toEqual({ revertedFiles: 1, conflicts: [] })
      // the marker the factory pushed through appendEvent landed in the LIVE
      // session and flowed on the session/event notification stream
      const marker = drv.out.find((m) => {
        if (!isRpcNotification(m) || m.method !== "session/event") return false
        const event = (m.params as { event?: { type?: string } }).event
        return event?.type === "rewind/point"
      })
      expect(marker).toBeDefined()
      if (marker !== undefined && isRpcNotification(marker)) {
        expect((marker.params as { event: unknown }).event).toMatchObject({
          type: "rewind/point", targetTurn: 0, mode: "conversation",
        })
      } else {
        throw new Error("rewind/point marker did not flow as a session/event notification")
      }
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("session/rewind without a factory → -32603 'rewind not enabled'; unknown session → -32602 'session not found'", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service) // no rewindFactory wired
      // unknown session wins the check order (never auto-creates)
      const unknown = await server.handleLine(encodeFrame(makeRequest(180, "session/rewind/points", { sessionId: "u1" })))
      const unknownMsg = decodeFrame(unknown!) as RpcFailure
      expect(unknownMsg.error.code).toBe(INVALID_PARAMS)
      expect(String(unknownMsg.error.message)).toContain("session not found")

      const promptReply = await server.handleLine(
        encodeFrame(makeRequest(181, "session/prompt", { sessionId: "r2", prompt: "hello" })),
      )
      expect((decodeFrame(promptReply!) as RpcSuccess).result).toEqual({ sessionId: "r2", ok: true })
      for (const [method, params] of [
        ["session/rewind/points", { sessionId: "r2" }],
        ["session/rewind/plan", { sessionId: "r2", target: 0 }],
        ["session/rewind/execute", { sessionId: "r2", target: 0, mode: "all" }],
      ] as const) {
        const reply = await server.handleLine(encodeFrame(makeRequest(182, method, params)))
        const msg = decodeFrame(reply!) as RpcFailure
        expect(msg.error.code).toBe(INTERNAL_ERROR)
        expect(String(msg.error.message)).toContain("rewind not enabled")
      }
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })

  it("session/rewind validates target and mode (non-integer/negative target, unknown mode → -32602)", async () => {
    const { service, cleanup } = await makeService()
    try {
      const server = createSdkServer(service, {
        rewindFactory: () => ({
          points: async () => ({ points: [] }),
          plan: async () => ({ clean: [], conflicts: [], unTracked: [], ops: [] }),
          execute: async (_target: number, _mode: "all" | "files" | "conversation", hooks) => {
            hooks.appendEvent({ type: "rewind/point", version: 1, targetTurn: 0, anchorSeq: 0, mode: "all", fileOps: [] })
            return { revertedFiles: 0, conflicts: [] }
          },
        }),
      })
      await server.handleLine(encodeFrame(makeRequest(190, "session/prompt", { sessionId: "r3", prompt: "hello" })))
      for (const bad of [
        { sessionId: "r3", target: -1 },
        { sessionId: "r3", target: 1.5 },
        { sessionId: "r3", target: 0, mode: "everything" },
        { sessionId: "", target: 0 },
      ]) {
        const reply = await server.handleLine(encodeFrame(makeRequest(191, "session/rewind/plan", bad)))
        expect((decodeFrame(reply!) as RpcFailure).error.code).toBe(INVALID_PARAMS)
      }
      await server.close()
    } finally {
      await service.close()
      await cleanup()
    }
  })
})
