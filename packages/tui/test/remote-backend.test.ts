// M38b G2 (M41a) — remote (SDK wire) backend tests.
//
// Two strata:
//   1. UNIT (in-process fake wire client): the BackendClient semantics over
//      the FROZEN v0 wire — submit/steer/cancel behavior, the 16 ms batching
//      + mapSessionEvent mapping (the SAME mapper the embedded bridge exports
//      — byte-identical mapping, no copy), the sync status cache, the open()
//      session filter switch, AND the M41a v1 consumption: the initialize
//      handshake's protocolVersion (2 → session/history + session/list are
//      used; 1 → the v0 degrade: replay [] + the active-session stub).
//   2. E2E (REAL subprocess): package/tui cannot import @i-harness/sdk (not a
//      dependency — the milestone forbids new private deps, package.json is
//      untouchable while G1 lands marked/highlight.js), so the real server is
//      spawned with the IN-PACKAGE stdio client (spawnSdkSubprocess): the real
//      apps/cli `i-harness sdk` entry (node --import tsx, exact sdk-e2e
//      precedent), driven over stdio with the default mock model. Kept small
//      (< 20 s): one mock turn, no extra steps. The expected v1 assertions
//      (replay non-empty + list includes the session) are gated on the
//      handshake's protocolVersion: when the server is still v0 (G1 not
//      landed), the test falls back to the v0 assertions with a LOUD console
//      warning and must be re-run once the v1 server is live.
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import type { TuiEvent } from "../src/contracts.ts"
import {
  createRemoteBackend,
  spawnSdkSubprocess,
  type SdkClientLike,
  type SdkNotification,
} from "../src/backend/remote.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await sleep(10)
  }
  throw new Error("waitFor: condition not met within budget")
}

// ------------------------------------------------------------------ fake wire client

type WireHandler = (method: string, params: unknown) => unknown | Promise<unknown>

interface FakeWireClient extends SdkClientLike {
  readonly requests: Array<{ method: string; params: unknown; timeoutMs?: number }>
  readonly closeCalls: number
  setHandler(handler: WireHandler): void
  /** Emit a server → client notification to the registered listener. */
  notify(n: SdkNotification): void
}

function fakeWireClient(handler?: WireHandler): FakeWireClient {
  const listeners = new Set<(n: SdkNotification) => void>()
  const requests: Array<{ method: string; params: unknown; timeoutMs?: number }> = []
  let closeCalls = 0
  let current: WireHandler = handler ?? (() => ({ ok: true }))
  const client: FakeWireClient = {
    requests,
    get closeCalls() { return closeCalls },
    setHandler(h: WireHandler) { current = h },
    async request(method: string, params: unknown, timeoutMs?: number) {
      requests.push({ method, params, timeoutMs })
      return current(method, params)
    },
    onNotification(listener: (n: SdkNotification) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async close(): Promise<void> { closeCalls++ },
    notify(n) {
      for (const listener of [...listeners]) listener(n)
    },
  }
  return client
}

function sendEvent(client: FakeWireClient, sessionId: string, event: SessionEvent): void {
  client.notify({ method: "session/event", params: { sessionId, event } })
}

/** A runnable turn fixture: user → start → assistant → end + the draining
 * session/status notification (the server's notification order). */
function emitTurn(client: FakeWireClient, sessionId: string, base: number): void {
  sendEvent(client, sessionId, { type: "user/message", text: "hello", seq: base })
  sendEvent(client, sessionId, { type: "turn/start", seq: base + 1 })
  sendEvent(client, sessionId, { type: "assistant/message", text: "ok", seq: base + 2 })
  sendEvent(client, sessionId, { type: "turn/end", seq: base + 3 })
  client.notify({ method: "session/status", params: { sessionId, status: "idle" } })
}

describe("createRemoteBackend (fake wire client)", () => {
  /** Drain the backend's event stream in the background (the real loop's
   * only consumer) — returns the seen array. */
  function startConsumer(backend: ReturnType<typeof createRemoteBackend>): TuiEvent[] {
    const seen: TuiEvent[] = []
    void (async () => {
      for await (const ev of backend.events()) seen.push(ev)
    })().catch(() => { /* stopped by close */ })
    return seen
  }

  it("submits via session/prompt and streams the mapped turn with real seqs", async () => {
    const client = fakeWireClient()
    client.setHandler((method, params) => {
      if (method === "session/prompt") {
        const sessionId = (params as { sessionId?: unknown }).sessionId as string
        emitTurn(client, sessionId, 100)
        return { sessionId, ok: true }
      }
      if (method === "session/status") return { running: false, queued: 0 }
      return { ok: true }
    })
    const backend = createRemoteBackend({ client, sessionId: "s1", title: "remote ses" })
    const seen = startConsumer(backend)

    await backend.submit("hello")
    await waitFor(() => seen.some((e) => e.type === "turn" && e.phase === "end"), 2000)

    // the wire method + params are EXACT (FROZEN contract names)
    expect(client.requests[0]).toMatchObject({ method: "session/prompt", params: { sessionId: "s1", prompt: "hello" } })
    // mapped 1:1 with the server's own seqs (mapSessionEvent reused verbatim
    // from the embedded bridge — the determinism anchor)
    expect(seen[0]).toEqual({ type: "user", text: "hello", seq: 100, ts: expect.any(Number) })
    expect(seen.some((e) => e.type === "assistant" && e.text === "ok" && e.seq === 102)).toBe(true)
    expect(seen.some((e) => e.type === "turn" && e.phase === "end" && e.seq === 103)).toBe(true)
    // status cache: the draining notification set running:false; the
    // post-submit session/status request refreshes the exact numbers
    expect(backend.status()).toEqual({ running: false, queued: 0 })
    expect(backend.seqCursor()).toBe(103)
    // default fake never answers initialize (its catch-all returns { ok: true }
    // → protocolVersion 1): the handshake says v0 → the v0 degrade path —
    // append-only wire, no history RPC → replay() is [] (honest gap)
    expect(await backend.replay(0)).toEqual([])
    // v0 degrade: active-session-only listing (no list RPC on v0): the stub
    // row — title + counted turns
    const list = await backend.listSessions()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: "s1", title: "remote ses", turnCount: 1 })

    await backend.close()
  })

  it("cancel: one honest stream note (no wire RPC); close idempotent", async () => {
    const client = fakeWireClient()
    const backend = createRemoteBackend({ client, sessionId: "s1" })
    const seen = startConsumer(backend)

    await backend.cancel()
    await backend.cancel()
    await waitFor(() => seen.length >= 1, 1000)
    const systems = seen.filter((e) => e.type === "system")
    expect(systems).toHaveLength(1)
    expect(systems[0]).toMatchObject({ text: expect.stringContaining("cancel unavailable") })

    await backend.close()
    await backend.close()
    expect(client.closeCalls).toBe(1)
  })

  it("steer chains through the same session/prompt (wire v0: only the send tier)", async () => {
    const client = fakeWireClient()
    const backend = createRemoteBackend({ client, sessionId: "s1" })
    await backend.steer("go go")
    expect(client.requests[0]).toMatchObject({ method: "session/prompt", params: { sessionId: "s1", prompt: "go go" } })
    await backend.close()
  })

  it("open() switches the notification filter; session/status drives the cache", async () => {
    const client = fakeWireClient()
    const backend = createRemoteBackend({ client, sessionId: "a" })
    const seen = startConsumer(backend)

    client.notify({ method: "session/status", params: { sessionId: "a", status: "queued" } })
    expect(backend.status().running).toBe(true)

    await backend.open("b")
    expect(backend.seqCursor()).toBe(-1)
    sendEvent(client, "a", { type: "user/message", text: "stale", seq: 0 })
    sendEvent(client, "b", { type: "user/message", text: "fresh", seq: 0 })
    await waitFor(() => seen.some((e) => e.type === "user" && e.text === "fresh"), 1000)
    expect(seen.some((e) => e.type === "user" && e.text === "stale")).toBe(false)
    client.notify({ method: "session/status", params: { sessionId: "b", status: "idle" } })
    expect(backend.status().running).toBe(false)
    await backend.close()
  })

  it("exposes the host-known modelLabel; the OPTIONAL context stays absent", () => {
    const labeled = createRemoteBackend({ client: fakeWireClient(), sessionId: "s1", modelLabel: "openai:gpt-4o" })
    expect(labeled.modelLabel).toBe("openai:gpt-4o")
    const bare = createRemoteBackend({ client: fakeWireClient(), sessionId: "s1" })
    expect(bare.modelLabel).toBeUndefined()
    // no per-session metrics RPC on v0 → the OPTIONAL member must not exist
    expect("context" in bare).toBe(false)
  })
})

describe("createRemoteBackend (wire v1: protocolVersion ≥ 2 handshake)", () => {
  it("replay walks session/history and maps with the shared mapper (exclusive afterSeq)", async () => {
    const client = fakeWireClient()
    client.setHandler((method) => {
      if (method === "initialize") return { name: "i-harness", version: "0.1.0", protocolVersion: 2, capabilities: {} }
      if (method === "session/history") {
        // the durable log walk; assistant/chunk + assistant/message pair
        // exercises the shared mapper's chunk-dedupe (byte-identical rule)
        return {
          events: [
            { type: "user/message", text: "prompt", seq: 100 },
            { type: "turn/start", seq: 101 },
            { type: "assistant/chunk", text: "res", seq: 102 },
            { type: "assistant/message", text: "res", seq: 103 },
            { type: "turn/end", seq: 104 },
          ],
          nextSeq: 105,
        }
      }
      return { ok: true }
    })
    const backend = createRemoteBackend({ client, sessionId: "s1" })

    const replayed = await backend.replay(0)
    // first event = the user prompt turn; the chunk dedupe merged 102 (the
    // aggregate 103 is skipped by the shared mapper — the live-fidelity rule)
    expect(replayed).toHaveLength(4)
    expect(replayed[0]).toEqual({ type: "user", text: "prompt", seq: 100, ts: expect.any(Number) })
    expect(replayed.map((e) => e.seq)).toEqual([100, 101, 102, 104])
    // EXCLUSIVE: a second walk after the user event skips it
    const after = await backend.replay(100)
    expect(after.map((e) => e.seq)).toEqual([101, 102, 104])
    // the wire emission is EXACT (v1 contract names + params)
    expect(client.requests.find((r) => r.method === "session/history")).toMatchObject({
      params: { sessionId: "s1", afterSeq: 0 },
    })
    // cursor advanced to the last mapped seq (embedded-bridge parity)
    expect(backend.seqCursor()).toBe(104)

    await backend.close()
  })

  it("listSessions maps the wire entries (context as present; id-only rows get honest defaults)", async () => {
    const client = fakeWireClient()
    client.setHandler((method) => {
      if (method === "initialize") return { protocolVersion: 2 }
      if (method === "session/list") {
        return {
          sessions: [
            { id: "s1", title: "One", updatedAt: 42, turnCount: 2, contextUsed: 7, contextTotal: 60 },
            { id: "s2", title: "Two", updatedAt: 43, turnCount: 1 },
            // the v1 wire's entry fields beyond id are OPTIONAL — a
            // header-only listing source serves a bare id row
            { id: "s3" },
          ],
        }
      }
      return { ok: true }
    })
    const backend = createRemoteBackend({ client, sessionId: "s1" })

    const list = await backend.listSessions()
    expect(list).toEqual([
      { id: "s1", title: "One", updatedAt: 42, turnCount: 2, contextUsed: 7, contextTotal: 60 },
      { id: "s2", title: "Two", updatedAt: 43, turnCount: 1 },
      { id: "s3", title: "Session", updatedAt: 0, turnCount: 0 },
    ])
    // exact wire emission (request params = the spec's {})
    expect(client.requests.find((r) => r.method === "session/list")).toMatchObject({ params: {} })
    // as-present: the entry without a context carries NO context member (the
    // loop keys on presence — never a fabricated 0)
    expect("contextUsed" in list[1]!).toBe(false)
    expect("contextTotal" in list[1]!).toBe(false)

    await backend.close()
  })

  it("v0 handshake (protocolVersion 1): replay [] + list degrades to the active-session stub — no new wire calls", async () => {
    const client = fakeWireClient()
    client.setHandler((method) => {
      if (method === "initialize") return { name: "i-harness", version: "0.1.0", protocolVersion: 1, capabilities: {} }
      return { ok: true }
    })
    const backend = createRemoteBackend({ client, sessionId: "s1", title: "old" })

    // the v0 dual path: replay stays [] (append-only wire) ...
    expect(await backend.replay(0)).toEqual([])
    // ... and list falls back to the ACTIVE-session stub (the pre-v1 behavior)
    const list = await backend.listSessions()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: "s1", title: "old", turnCount: 0 })
    // the old server NEVER sees the new methods (it would answer -32601; the
    // dual path is the point: v0 servers keep the v0 behavior untouched)
    expect(client.requests.some((r) => r.method === "session/history")).toBe(false)
    expect(client.requests.some((r) => r.method === "session/list")).toBe(false)

    await backend.close()
  })

  it("listing-unavailable response → [] (honest empty; never fabricated rows)", async () => {
    const client = fakeWireClient()
    client.setHandler((method) => {
      if (method === "initialize") return { protocolVersion: 2 }
      if (method === "session/list") return { sessions: [], listingUnavailable: true }
      return { ok: true }
    })
    const backend = createRemoteBackend({ client, sessionId: "s1" })
    expect(await backend.listSessions()).toEqual([])
    await backend.close()
  })

  it("design-spec status marker (no sessions array) → []", async () => {
    // the M41a design doc's `status: "listing-unavailable"` marker is also
    // normalized (a server version between the spec and the committed wire
    // must still degrade honestly, never fabricate rows)
    const client = fakeWireClient()
    client.setHandler((method) => {
      if (method === "initialize") return { protocolVersion: 2 }
      if (method === "session/list") return { status: "listing-unavailable" }
      return { ok: true }
    })
    const backend = createRemoteBackend({ client, sessionId: "s1" })
    expect(await backend.listSessions()).toEqual([])
    await backend.close()
  })

  it("history wire failure → honest [] degrade (never fabricated events)", async () => {
    const client = fakeWireClient()
    client.setHandler((method) => {
      if (method === "initialize") return { protocolVersion: 2 }
      if (method === "session/history") throw new Error("boom")
      return { ok: true }
    })
    const backend = createRemoteBackend({ client, sessionId: "s1" })
    expect(await backend.replay(0)).toEqual([])
    expect(backend.seqCursor()).toBe(-1)
    await backend.close()
  })
})

describe("real i-harness sdk subprocess (wire-level end-to-end)", () => {
  const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
  const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href
  const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "index.ts")

  it(
    "spawns the real CLI server, initializes, submits and streams the mapped turn",
    async () => {
      // sanity: node is runnable (a useful failure message vs a spawn mystery)
      const probe = spawnSync(process.execPath, ["--version"], { encoding: "utf8" })
      expect(probe.status).toBe(0)

      const workspace = mkdtempSync(join(tmpdir(), "ih-tui-remote-ws-"))
      const sessions = mkdtempSync(join(tmpdir(), "ih-tui-remote-sess-"))
      const client = spawnSdkSubprocess({
        command: process.execPath,
        args: ["--import", TSX_LOADER, CLI_ENTRY, "sdk", "--session-dir", sessions],
        cwd: workspace,
      })
      let backend: ReturnType<typeof createRemoteBackend> | undefined
      try {
        // handshake: the CLI's sdk server answers initialize — protocolVersion
        // is the M41a capability detection (2 = v1 session/history + list).
        const info = (await client.request("initialize", {})) as { name?: unknown; version?: unknown; protocolVersion?: unknown }
        expect(info.name).toBe("i-harness")
        expect(info.version).toBe("0.1.0")
        const protocolVersion = typeof info.protocolVersion === "number" ? info.protocolVersion : 1

        backend = createRemoteBackend({ client, sessionId: "g2-attach-1", title: "attach" })
        const seen: TuiEvent[] = []
        void (async () => {
          for await (const ev of backend.events()) seen.push(ev)
        })().catch(() => { /* stopped by close */ })

        await backend.submit("hello")
        await waitFor(() => seen.some((e) => e.type === "turn" && e.phase === "end"), 10_000)

        // REAL server events (mock model default), mapped with real seqs
        expect(seen.some((e) => e.type === "user" && e.text === "hello")).toBe(true)
        expect(seen.some((e) => e.type === "assistant" && e.text.includes("ok"))).toBe(true)
        expect(seen.some((e) => e.type === "turn" && e.phase === "start")).toBe(true)
        expect(backend.seqCursor()).toBeGreaterThanOrEqual(3)
        expect(backend.status()).toEqual({ running: false, queued: 0 })

        if (protocolVersion >= 2) {
          // M41a: the CLOSED gaps over the REAL v1 wire —
          // (a) replay(0): non-empty, strictly ascending seqs, and the REAL
          //     log order (core-agent appends turn/start BEFORE user/message —
          //     core-agent/src/index.ts:180-184): the first mapped event is
          //     the turn boundary; the user prompt turn is the first USER
          //     event, right after it (the prompt's own text)
          const replayed = await backend.replay(0)
          expect(replayed.length).toBeGreaterThan(0)
          expect(replayed[0]).toMatchObject({ type: "turn", phase: "start" })
          const prompt = replayed.find((e) => e.type === "user" && e.text === "hello")
          expect(prompt).toBeDefined()
          expect(replayed.indexOf(prompt!)).toBe(1)
          const seqs = replayed.map((e) => e.seq)
          for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
          // (b) listSessions: the active session row. G1's committed CLI
          //     listing source serves HEADER-ONLY rows ({ id }, title only
          //     when the store meta carries one), so the client's honest
          //     defaults fill the required SessionSummary fields ("Session",
          //     0/0 = unknown); the id presence is the hard wire assertion.
          const list = await backend.listSessions()
          const row = list.find((s) => s.id === "g2-attach-1")
          expect(row).toBeDefined()
          expect(typeof row!.title).toBe("string")
          expect(typeof row!.updatedAt).toBe("number")
          expect(typeof row!.turnCount).toBe("number")
        } else {
          // G1 (the v1 server) has not landed at runtime: the honest v0 dual
          // path — replay [] + the active-session stub. The v1 assertions
          // above are the milestone proof: this test MUST be re-run once the
          // SDK v1 server is live (G1 lands first; see the M41a plan §3).
          console.warn(
            `[remote-backend e2e] server protocolVersion=${protocolVersion}: v1 wire not served yet — asserting the v0 degrade only. Re-run once the SDK v1 server lands.`,
          )
          expect(await backend.replay(0)).toEqual([])
          const list = await backend.listSessions()
          expect(list[0]?.id).toBe("g2-attach-1")
        }
      } finally {
        await backend?.close().catch(() => {})
        await client.close().catch(() => {})
        rmSync(workspace, { recursive: true, force: true })
        rmSync(sessions, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
