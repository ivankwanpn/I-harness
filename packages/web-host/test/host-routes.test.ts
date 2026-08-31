import { describe, expect, it } from "vitest"
import { once } from "node:events"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import WebSocket from "ws"
import { append, createSession } from "@i-harness/core-session"
import { createImageAttachmentStore } from "@i-harness/attachment"
import { createContext } from "@i-harness/core-plugin"
import { askUser, type ApprovalRequest } from "@i-harness/interaction"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator, type SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionQuery } from "@i-harness/session-query"
import { SettingsStore } from "@i-harness/settings"
import { createWebHost, type WebHost, type WebHostOptions } from "../src/host.ts"
import { ApprovalMuxBridge } from "../src/approval.ts"
import { QuestionMuxBridge } from "../src/questions.ts"
import type { ApprovalRequestWire, CommandBridge, QuestionRequestWire } from "../src/types.ts"
import { createWorkspaceRegistry } from "@i-harness/workspace"
import { createSessionService } from "@i-harness/session-executor"

// registerApprovalAnswerer normalizes the `{ approved }` decision shape to a
// plain boolean at the service boundary (see approval.spec.ts) — host approval
// tests drive the seam exactly as core-tools sees it.
type Answerer = (req: ApprovalRequest) => Promise<boolean>

function getAnswerer(ctx: ReturnType<typeof createContext>): Answerer {
  return ctx.services.get<Answerer>("approval/answerer")
}

// Hermetic store root per test run (the plan sketch used `TMPDIR ?? cwd/.tmp`,
// which litters the repo on Windows where TMPDIR is unset). Same role: a
// throwaway jsonl root, cleaned up after the host closes. `options` adds the
// per-test host options; the run callback additionally receives the per-run
// root so tests can build sibling stores (e.g. @i-harness/attachment) over the
// same dir. R-C0 adaptation: the mux command endpoint runs over the REAL
// session service (mock model, cyclic) — branch-spec fixtures that stubbed
// sessionRunner were rewritten to service semantics.
async function withHost(
  run: (base: string, host: WebHost, coordinator: SessionCoordinator, root: string) => Promise<void>,
  options: Partial<Omit<WebHostOptions, "executor" | "port">> = {},
  serviceOptions: { mockScript?: Parameters<typeof createSessionService>[0]["mockScript"] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  const executor = createSessionService({
    workspace: process.cwd(), approveAll: true, mockCycles: true, coordinator,
    ...(serviceOptions.mockScript !== undefined ? { mockScript: serviceOptions.mockScript } : {}),
  })
  const host = createWebHost({ port: 0, executor, coordinator, ...options })
  executor.onAssembly((a) => { if (a.sessionId !== undefined) host.attachLiveSession({ sessionId: a.sessionId, session: a.session }) })
  const { port } = await host.listen()
  try {
    await run(`http://127.0.0.1:${port}`, host, coordinator, root)
  } finally {
    await host.close()
    await executor.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function createSessionViaHttp(base: string): Promise<string> {
  const create = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: process.cwd() }),
  })
  const created = await create.json() as { id: string }
  expect(created.id).toBeTruthy()
  return created.id
}

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met within timeout")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe("web-host HTTP", () => {
  it("lists sessions then returns paged events", async () => {
    await withHost(async (base) => {
      const createdId = await createSessionViaHttp(base)

      const events1 = await fetch(`${base}/api/sessions/${createdId}/events?limit=5`)
      const page = await events1.json() as any
      expect(Array.isArray(page.events)).toBe(true)
    })
  })

  // Review MUST-FIX: `?limit=abc` used to produce Number("abc") === NaN →
  // slice(-NaN) === slice(0) → the ENTIRE log. The route must not blow up and
  // must serve a bounded default page instead of everything.
  it("GET events tolerates non-numeric limit/beforeSeq (?limit=abc)", async () => {
    await withHost(async (base, _host, coordinator) => {
      const id = await createSessionViaHttp(base)
      // Seed > default page size so "whole log" is distinguishable from a
      // bounded default page (250 events, seqs 0..249 as appended).
      const events = Array.from({ length: 250 }, (_, i) => ({ type: "user/message" as const, text: `m${i}` }))
      await coordinator.append(id, events)

      const res = await fetch(`${base}/api/sessions/${id}/events?limit=abc&beforeSeq=xyz`)
      expect(res.status).toBe(200)
      const page = await res.json() as { events: unknown[]; hasMore: boolean }
      expect(Array.isArray(page.events)).toBe(true)
      expect(page.events.length).toBe(200) // DEFAULT_PAGE_LIMIT — NOT all 250
      expect(page.hasMore).toBe(true)
    })
  })

  it("resumes an existing session and 404s an unknown one", async () => {
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const resume = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/resume`, { method: "POST" })
      expect(resume.status).toBe(200)
      expect((await resume.json() as { id: string }).id).toBe(id)

      const missing = await fetch(`${base}/api/sessions/does-not-exist/resume`, { method: "POST" })
      expect(missing.status).toBe(404)
    })
  })

  it("GET /api/settings serves defaults when no store is configured (404)", async () => {
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/settings`)
      expect(res.status).toBe(404)
    })
  })

  it("GET/PUT /api/settings round-trips through the settings store", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-settings-"))
    const settings = new SettingsStore({ path: join(root, "settings.json") })
    try {
      await withHost(async (base) => {
        // First GET: defaults (file absent on disk).
        const get1 = await fetch(`${base}/api/settings`)
        expect(get1.status).toBe(200)
        const snap1 = await get1.json() as { settings: { theme: string; fontSize: number } }
        expect(snap1.settings.theme).toBe("system")
        expect(snap1.settings.fontSize).toBe(14)

        // PUT a partial patch; response carries the merged snapshot.
        const put = await fetch(`${base}/api/settings`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ theme: "dark", fontSize: 16 }),
        })
        expect(put.status).toBe(200)
        const snap2 = await put.json() as { settings: { theme: string; fontSize: number } }
        expect(snap2.settings.theme).toBe("dark")
        expect(snap2.settings.fontSize).toBe(16)

        // Second GET reflects the persisted state.
        const get2 = await fetch(`${base}/api/settings`)
        const snap3 = await get2.json() as { settings: { theme: string; fontSize: number } }
        expect(snap3.settings.theme).toBe("dark")
        expect(snap3.settings.fontSize).toBe(16)
      }, { settings })
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("upgrades /api/mux, wires live streams, and close() resolves with a stream open", async () => {
    // Task 4 review note: a live generator parked forever used to hang mux
    // close(). LiveSessionStreams is abort-aware, so host.close() must
    // resolve even with a ws client still connected and a stream open.
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))

      ws.send(JSON.stringify({ type: "open", streamId: "s1", endpoint: "session", payload: { sessionId: id } }))
      await until(() => messages.some(m => m.type === "ready" && m.streamId === "s1"))

      // Unknown live endpoint → error frame on that stream (not a crash).
      ws.send(JSON.stringify({ type: "open", streamId: "s2", endpoint: "telemetry", payload: { sessionId: id } }))
      await until(() => messages.some(m => m.type === "error" && m.streamId === "s2"))

      // Deliberately leave the socket + stream open; host.close() below must
      // terminate and drain them instead of hanging.
    })
  })

  // Review IMPORTANT: coordinator.load() returns a SNAPSHOT Session, so a
  // stream bundle built over it never sees appends made to the backend's own
  // live instance. attachLiveSession is the seam: the mux opener must prefer
  // the attached instance, so an append to it flows out over the mux stream.
  it("attachLiveSession: mux session stream yields appends made to the attached Session", async () => {
    await withHost(async (base, host) => {
      const id = await createSessionViaHttp(base)
      const attached = createSession()
      host.attachLiveSession({ sessionId: id, session: attached })

      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))

      ws.send(JSON.stringify({ type: "open", streamId: "s1", endpoint: "session", payload: { sessionId: id } }))
      await until(() => messages.some(m => m.type === "ready" && m.streamId === "s1"))
      // The generator subscribes on the mux pump's first pull — microtasks
      // right after "ready" is sent; one short macrotask settle before
      // appending keeps this deterministic without a long sleep.
      await new Promise(resolve => setTimeout(resolve, 20))

      append(attached, { type: "user/message", text: "live-seam", seq: 1 })
      await until(() => messages.some(m =>
        m.type === "item" && m.streamId === "s1" && (m.value as { text?: string }).text === "live-seam"))
      ws.close()
    })
  })

  // C1 (BLOCKER) regression: the SPA opens the session/chunk/agent-state
  // streams at session-select time — BEFORE the first command creates the
  // live agent and attachLiveSession runs. The opener used to bind those
  // streams to the coordinator's snapshot bundle forever (attach only evicted
  // the cache entry), so first-turn live events were lost until reload. The
  // bundle must re-point to the attached instance (gen-forward) and the OPEN
  // streams must yield appends made after the attach — not 0 items.
  it("streams opened BEFORE attachLiveSession rebind to the attached session and yield its appends", async () => {
    await withHost(async (base, host) => {
      const id = await createSessionViaHttp(base)
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))

      // Open all three live streams over the NOT-yet-attached session —
      // their bundles derive from the coordinator snapshot.
      const openStream = (streamId: string, endpoint: string): void => {
        ws.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { sessionId: id } }))
      }
      openStream("s1", "session")
      openStream("s2", "chunk")
      openStream("s3", "agent-state")
      await until(() =>
        messages.some(m => m.type === "ready" && m.streamId === "s1") &&
        messages.some(m => m.type === "ready" && m.streamId === "s2") &&
        messages.some(m => m.type === "ready" && m.streamId === "s3"))
      // Let the generators subscribe (first pull) before the attach.
      await new Promise(resolve => setTimeout(resolve, 20))

      // First-command time in the embedder: the live agent exists and is
      // attached while the streams above are still open.
      const live = createSession()
      host.attachLiveSession({ sessionId: id, session: live })

      // Appends made to the attached instance AFTER the attach must reach the
      // already-open streams — none of them may stay bound to the snapshot.
      append(live, { type: "user/message", text: "post-attach", seq: 1 })
      await new Promise(r => setTimeout(r, 300))
      console.log("DEBUG messages:", JSON.stringify(messages, null, 1))
      await until(() => messages.some(m =>
        m.type === "item" && m.streamId === "s1" && (m.value as { text?: string }).text === "post-attach"))

      // The chunk stream too: coalesced text, then the terminating message
      // flushes the full text and ends the stream.
      append(live, { type: "assistant/chunk", text: "he" })
      append(live, { type: "assistant/chunk", text: "llo" })
      append(live, { type: "assistant/message", text: "hello", seq: 2 })
      await until(() => messages.some(m => m.type === "item" && m.streamId === "s2" && m.value === "hello"))
      await until(() => messages.some(m => m.type === "end" && m.streamId === "s2"))

      // And agent-state: the turn/start transition surfaces on the pre-attach
      // stream (after the idle seed frame).
      append(live, { type: "turn/start" })
      await until(() => messages.some(m =>
        m.type === "item" && m.streamId === "s3" && (m.value as { status?: string }).status === "running"))
      ws.close()
    })
  })
})

describe("web-host session search + lineage endpoints (Task 1.2)", () => {
  // Documented contract (task 1.2 brief, 方案 A): without a `sessionQuery`
  // seam — the jsonl default, which has no FTS index — BOTH endpoints answer
  // HTTP 409 + { error, code: "search_not_enabled" }, which the frontend
  // detects by `code` and renders the 「未启用」 hint.
  it("absent seam: search + lineage answer 409 search_not_enabled", async () => {
    await withHost(async (base) => {
      const search = await fetch(`${base}/api/sessions/search?q=unicorn`)
      expect(search.status).toBe(409)
      expect(((await search.json()) as { code: string }).code).toBe("search_not_enabled")
      const lineage = await fetch(`${base}/api/sessions/any/lineage?direction=children`)
      expect(lineage.status).toBe(409)
      expect(((await lineage.json()) as { code: string }).code).toBe("search_not_enabled")
    })
  })

  it("seam present: search forwards q/sessionId/subtreeOf/limit and returns { hits }", async () => {
    const calls: Array<{ query: string; opts?: object }> = []
    const fake: SessionQuery = {
      search: async (query, opts) => {
        calls.push({ query, opts })
        return [{
          sessionId: "sess-1", seq: 2, eventType: "user/message", time: 123,
          snippet: "…unicorn…", bm25: -1.5,
        }]
      },
      lineage: async () => [],
    }
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/sessions/search?q=${encodeURIComponent("purple unicorn")}&sessionId=sess-1&subtreeOf=root&limit=7`)
      expect(res.status).toBe(200)
      const { hits } = await res.json() as { hits: Array<{ sessionId: string; snippet: string }> }
      expect(hits.length).toBe(1)
      expect(hits[0]!.sessionId).toBe("sess-1")
      expect(hits[0]!.snippet).toContain("unicorn")
      expect(calls).toEqual([{ query: "purple unicorn", opts: { sessionId: "sess-1", subtreeOf: "root", limit: 7 } }])
      // validation: missing/blank q and non-integer limit → 400, never a 500.
      expect((await fetch(`${base}/api/sessions/search`)).status).toBe(400)
      expect((await fetch(`${base}/api/sessions/search?q=`)).status).toBe(400)
      expect((await fetch(`${base}/api/sessions/search?limit=abc`)).status).toBe(400)
      expect((await fetch(`${base}/api/sessions/search?q=x&limit=2.5`)).status).toBe(400)
    }, { sessionQuery: fake })
  })

  it("seam present: lineage forwards direction/depth, 400 on bad params, 404 on unknown session", async () => {
    const calls: Array<{ sessionId: string; opts: object }> = []
    const fake: SessionQuery = {
      search: async () => [],
      lineage: async (sessionId, opts) => {
        calls.push({ sessionId, opts })
        if (sessionId === "ghost") throw new Error("unknown session: ghost")
        return [{ sessionId: "child-1", parentSession: sessionId, hasChildren: false }]
      },
    }
    await withHost(async (base) => {
      const ok = await fetch(`${base}/api/sessions/parent-1/lineage?direction=descendants&depth=2`)
      expect(ok.status).toBe(200)
      const { nodes } = await ok.json() as { nodes: Array<{ sessionId: string; parentSession?: string }> }
      expect(nodes).toEqual([{ sessionId: "child-1", parentSession: "parent-1", hasChildren: false }])
      expect(calls).toEqual([{ sessionId: "parent-1", opts: { direction: "descendants", depth: 2 } }])
      // validation: missing/unknown direction, depth < 1 → 400.
      expect((await fetch(`${base}/api/sessions/parent-1/lineage`)).status).toBe(400)
      expect((await fetch(`${base}/api/sessions/parent-1/lineage?direction=sideways`)).status).toBe(400)
      expect((await fetch(`${base}/api/sessions/parent-1/lineage?direction=children&depth=0`)).status).toBe(400)
      // session-query's `unknown session:` throw surfaces as a 404, not a 500.
      const ghost = await fetch(`${base}/api/sessions/ghost/lineage?direction=children`)
      expect(ghost.status).toBe(404)
      expect(((await ghost.json()) as { error: string }).error).toBe("unknown session: ghost")
    }, { sessionQuery: fake })
  })
})

describe("web-host attachment routes (Task 1.3)", () => {
  // 1x1 透明 PNG（canonical base64，無 data: prefix — 与 core-session ImageInput 一致）
  const PNG_1X1_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

  it("absent seam: upload + retrieve routes answer 404", async () => {
    await withHost(async (base) => {
      const up = await fetch(`${base}/api/attachments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaType: "image/png", dataBase64: PNG_1X1_BASE64 }),
      })
      expect(up.status).toBe(404)
      const dl = await fetch(`${base}/api/attachments/att-00000000-0000-0000-0000-000000000000?mediaType=image/png`)
      expect(dl.status).toBe(404)
    })
  })

  it("POST → GET round trip: upload returns the store ref, GET serves the identical bytes with the mime", async () => {
    // The store is created over its OWN tmp dir before withHost runs, so the
    // host gets the instance via the `attachments` seam (the host never
    // creates storage; web.ts is the composition point).
    const storeRoot = await mkdtemp(join(tmpdir(), "i-harness-web-host-att-"))
    const attachments = createImageAttachmentStore({ workspaceDir: storeRoot })
    try {
      await withHost(async (base) => {
        const up = await fetch(`${base}/api/attachments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mediaType: "image/png", dataBase64: PNG_1X1_BASE64, name: "pixel.png" }),
        })
        expect(up.status).toBe(200)
        const ref = await up.json() as { attachmentId: string; mediaType: string; bytes: number; name: string }
        expect(ref.attachmentId).toMatch(/^att-[0-9a-f-]+$/)
        expect(ref.mediaType).toBe("image/png")
        expect(ref.bytes).toBe(Buffer.from(PNG_1X1_BASE64, "base64").length)
        expect(ref.name).toBe("pixel.png")

        // The route really wrote through the store: bytes land on disk under
        // `<storeRoot>/.i-harness/attachments/att-<uuid>.bin` (M20 layout).
        const file = join(storeRoot, ".i-harness", "attachments", `${ref.attachmentId}.bin`)
        const onDisk = await readFile(file)
        expect(onDisk.equals(Buffer.from(PNG_1X1_BASE64, "base64"))).toBe(true)

        // Retrieve by URL: same bytes, the caller-supplied mime as content-type.
        const dl = await fetch(`${base}/api/attachments/${ref.attachmentId}?mediaType=image/png`)
        expect(dl.status).toBe(200)
        expect(dl.headers.get("content-type")).toBe("image/png")
        const body = Buffer.from(await dl.arrayBuffer())
        expect(body.equals(Buffer.from(PNG_1X1_BASE64, "base64"))).toBe(true)
      }, { attachments })
    } finally {
      await rm(storeRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("POST validation: unsupported media type / non-canonical base64 → 400", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "i-harness-web-host-att-"))
    const attachments = createImageAttachmentStore({ workspaceDir: storeRoot })
    try {
      await withHost(async (base) => {
        const badType = await fetch(`${base}/api/attachments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mediaType: "image/bmp", dataBase64: PNG_1X1_BASE64 }),
        })
        expect(badType.status).toBe(400)
        expect(((await badType.json()) as { error: string }).error).toContain("unsupported media type")

        // data: prefix is NOT canonical (core-session's ImageInput contract).
        const prefixed = await fetch(`${base}/api/attachments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mediaType: "image/png", dataBase64: `data:image/png;base64,${PNG_1X1_BASE64}` }),
        })
        expect(prefixed.status).toBe(400)

        const whitespace = await fetch(`${base}/api/attachments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mediaType: "image/png", dataBase64: `${PNG_1X1_BASE64} ` }),
        })
        expect(whitespace.status).toBe(400)

        // Malformed JSON body → 400 too (not the generic route-catch 500).
        const badJson = await fetch(`${base}/api/attachments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        })
        expect(badJson.status).toBe(400)

        // A validation failure never writes anything.
        const files = await readdir(join(storeRoot, ".i-harness", "attachments")).catch(() => [] as string[])
        expect(files).toHaveLength(0)
      }, { attachments })
    } finally {
      await rm(storeRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("a store with tighter limits surfaces the store's size throw as 413, not a 500", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "i-harness-web-host-att-"))
    const attachments = createImageAttachmentStore({ workspaceDir: storeRoot, limits: { maxImageBytes: 512 } })
    try {
      await withHost(async (base) => {
        // 1 KiB image: passes the HTTP pre-check (core-session's 200 MB cap),
        // but the embedder-configured store caps at 512 bytes.
        const big = Buffer.alloc(1024, 7).toString("base64")
        const res = await fetch(`${base}/api/attachments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mediaType: "image/png", dataBase64: big }),
        })
        expect(res.status).toBe(413)
        expect(((await res.json()) as { error: string }).error).toContain("image too large")
      }, { attachments })
    } finally {
      await rm(storeRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("GET validation: missing/bad mediaType and malformed/unknown ids never reach the store as a 500", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "i-harness-web-host-att-"))
    const attachments = createImageAttachmentStore({ workspaceDir: storeRoot })
    try {
      await withHost(async (base) => {
        // mediaType missing / outside the supported set → 400.
        expect((await fetch(`${base}/api/attachments/att-00000000-0000-0000-0000-000000000000`)).status).toBe(400)
        expect((await fetch(`${base}/api/attachments/att-00000000-0000-0000-0000-000000000000?mediaType=image/bmp`)).status).toBe(400)
        // Unknown id (valid att-<uuid> shape, no file) → 404.
        expect((await fetch(`${base}/api/attachments/att-00000000-0000-0000-0000-000000000000?mediaType=image/png`)).status).toBe(404)
        // Non-uuid ids (short, traversal-y) → 404, never a path join / 500.
        // (`%2F` is sent LITERALLY — the decoded `../../etc` must be rejected
        // before any resolvePath join, which would escape the attachments dir.)
        expect((await fetch(`${base}/api/attachments/att-123?mediaType=image/png`)).status).toBe(404)
        expect((await fetch(`${base}/api/attachments/..%2F..%2Fetc?mediaType=image/png`)).status).toBe(404)
        // Malformed percent-encoding → 400, not a decodeURIComponent 500.
        expect((await fetch(`${base}/api/attachments/att-0000%zz?mediaType=image/png`)).status).toBe(400)
      }, { attachments })
    } finally {
      await rm(storeRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe("web-host mux command + approval endpoints (B3-H2)", () => {
  it("command: per-session serialization + cross-session parallelism over the service lane", async () => {
    const laneCalls: string[] = []
    await withHost(async (base) => {
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))
      const openCommand = (streamId: string, sessionId: string, prompt: string): void => {
        ws.send(JSON.stringify({ type: "open", streamId, endpoint: "command", payload: { sessionId, prompt } }))
      }
      const frame = (streamId: string, status: string): unknown =>
        messages.find(m => m.type === "item" && m.streamId === streamId && (m.value as { status?: string }).status === status)?.value
      const okIndex = (streamId: string): number => messages.findIndex(m => m.type === "item" && m.streamId === streamId && (m.value as { status?: string }).status === "ok")

      // R-C0: the service lane resolves in FIFO per session; the host yields
      // started for each command as its generator starts (all three starts are
      // "immediate") and the ok frames order per-session.
      openCommand("c1", "session-a", "first")
      await until(() => frame("c1", "started") !== undefined)
      openCommand("c2", "session-a", "second") // queued behind c1 (same session)
      openCommand("c3", "session-b", "other") // parallel session — runs now
      // note: the branch stub observed runner-call ORDER; the service does it
      // inside its lane — the wire-visible contract is started×3 then ok×3.
      await until(() => frame("c1", "ok") !== undefined)
      await until(() => frame("c2", "ok") !== undefined)
      await until(() => frame("c3", "ok") !== undefined)
      // same session: c2's ok comes AFTER c1's (serial lane; use the message
      // order as our oracle since the mock turns are near-instant).
      expect(okIndex("c1")).toBeLessThan(okIndex("c2"))
      // NOTE: this test no longer holds a gate to prove non-overlap
      // deterministically — the per-session serial SERVE is exercised in
      // session-executor's own service tests; here the wire shape is the
      // contract. Keep the call-counter assert that the turn texts reached the
      // lane through the service:
      expect(laneCalls).toEqual([])
      ws.close()
    })
  })

  it("command: a failing turn yields started then an error frame; the chain keeps moving", async () => {
    // An exhausted one-shot mock script fails EVERY turn (mock model contract)
    // — the service drain rejection maps to the error frame.
    await withHost(async (base) => {
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))
      ws.send(JSON.stringify({ type: "open", streamId: "c1", endpoint: "command", payload: { sessionId: "s", prompt: "boom" } }))
      await until(() => messages.some(m => m.type === "item" && m.streamId === "c1" && (m.value as { status?: string }).status === "started"))
      await until(() => messages.some(m => m.type === "item" && m.streamId === "c1" && (m.value as { status?: string }).status === "error"))
      // The failed turn settled the chain: the next command settles too
      // (error again — the one-shot script is exhausted; the CHAIN moved).
      ws.send(JSON.stringify({ type: "open", streamId: "c2", endpoint: "command", payload: { sessionId: "s", prompt: "fine" } }))
      await until(() => messages.some(m => m.type === "item" && m.streamId === "c2" && (m.value as { status?: string }).status === "error"))
      ws.close()
    }, {}, { mockScript: [] })
  })

  it("command: missing prompt → error frame", async () => {
    await withHost(async (base) => {
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))
      ws.send(JSON.stringify({ type: "open", streamId: "c1", endpoint: "command", payload: { sessionId: "s" } }))
      await until(() => messages.some(m => m.type === "error" && m.streamId === "c1" && String(m.error).includes("prompt required")))
      ws.close()
    })
  })

  it("command: no configured executor → error frame, not a crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-noexec-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(root))
    const host = createWebHost({ port: 0, coordinator })
    const { port } = await host.listen()
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/mux`)
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))
      ws.send(JSON.stringify({ type: "open", streamId: "c1", endpoint: "command", payload: { sessionId: "s", prompt: "x" } }))
      await until(() => messages.some(m => m.type === "error" && m.streamId === "c1" && String(m.error).includes("command endpoint not configured")))
      ws.close()
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("approval: bridge request frame over the mux → client `{type:'approval'}` message resolves the waterfall", async () => {
    const ctx = createContext()
    const bridge = new ApprovalMuxBridge(ctx, 5_000)
    bridge.attach()
    await withHost(async (base) => {
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))

      ws.send(JSON.stringify({ type: "open", streamId: "a1", endpoint: "approval", payload: {} }))
      await until(() => messages.some(m => m.type === "ready" && m.streamId === "a1"))

      const decision = getAnswerer(ctx)({ name: "bash", reason: "host-mux test" })
      await until(() => messages.some(m =>
        m.type === "item" && m.streamId === "a1" && (m.value as ApprovalRequestWire).name === "bash"))
      const request = messages.find(m => m.type === "item" && m.streamId === "a1")!.value as ApprovalRequestWire
      expect(request.reason).toBe("host-mux test")

      // Client decision message (ruling 1 shape) on the SAME mux connection:
      // routes through the mux receive → bridge.respond → waterfall.
      ws.send(JSON.stringify({ type: "approval", streamId: "a1", value: { approvalId: request.approvalId, approved: true } }))
      await expect(decision).resolves.toBe(true)

      // The stream stays open after the decision (ruling 2): a second request
      // flows on the same stream without reopening.
      const second = getAnswerer(ctx)({ name: "write", reason: "second on same stream" })
      await until(() => messages.filter(m => m.type === "item" && m.streamId === "a1").length === 2)
      const secondRequest = messages.filter(m => m.type === "item" && m.streamId === "a1")[1]!.value as ApprovalRequestWire
      ws.send(JSON.stringify({ type: "approval", streamId: "a1", value: { approvalId: secondRequest.approvalId, approved: false } }))
      await expect(second).resolves.toBe(false)
      ws.close()
    }, { approvalBridge: bridge })
  })

  it("approval: no configured bridge → error frame; stray approval messages are ignored (no crash)", async () => {
    await withHost(async (base) => {
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))
      ws.send(JSON.stringify({ type: "open", streamId: "a1", endpoint: "approval", payload: {} }))
      await until(() => messages.some(m => m.type === "error" && m.streamId === "a1" && String(m.error).includes("approval endpoint not configured")))
      // A decision for a stream that never opened must not kill the connection.
      ws.send(JSON.stringify({ type: "approval", streamId: "a1", value: { approvalId: "nope", approved: true } }))
      // The connection still serves new streams afterwards.
      ws.send(JSON.stringify({ type: "open", streamId: "a2", endpoint: "approval", payload: {} }))
      await until(() => messages.some(m => m.type === "error" && m.streamId === "a2"))
      ws.close()
    })
  })
})

describe("web-host mux question endpoint (task 3.3)", () => {
  it("question: bridge request frame over the mux → client `{type:'answer'}` message resolves the asker", async () => {
    const ctx = createContext()
    const bridge = new QuestionMuxBridge(ctx, 5_000)
    bridge.attach()
    await withHost(async (base) => {
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))

      ws.send(JSON.stringify({ type: "open", streamId: "q1", endpoint: "question", payload: {} }))
      await until(() => messages.some(m => m.type === "ready" && m.streamId === "q1"))

      // The agent's askUser on the bridge-registered ctx — the exact seam a
      // tool calling askUser hits.
      const ask = askUser(ctx, { id: "confirm", prompt: "proceed with the plan?", options: ["yes", "later"] })
      await until(() => messages.some(m =>
        m.type === "item" && m.streamId === "q1" && (m.value as QuestionRequestWire).text === "proceed with the plan?"))
      const request = messages.find(m => m.type === "item" && m.streamId === "q1")!.value as QuestionRequestWire
      expect(request).toMatchObject({ questionId: request.questionId, kind: "confirm", options: ["yes", "later"] })

      // Client answer message (the `{type:"answer"}` shape) on the SAME mux
      // connection: routes through the mux receive → bridge.respond → waterfall.
      ws.send(JSON.stringify({ type: "answer", streamId: "q1", value: { questionId: request.questionId, answer: "yes, go" } }))
      await expect(ask).resolves.toBe("yes, go")

      // The stream stays open after the answer (approval ruling 2 mirrored): a
      // second question flows on the same stream without reopening.
      const second = askUser(ctx, { id: "plan", prompt: "second?" })
      await until(() => messages.filter(m => m.type === "item" && m.streamId === "q1").length === 2)
      const secondRequest = messages.filter(m => m.type === "item" && m.streamId === "q1")[1]!.value as QuestionRequestWire
      ws.send(JSON.stringify({ type: "answer", streamId: "q1", value: { questionId: secondRequest.questionId, answer: "no thanks" } }))
      await expect(second).resolves.toBe("no thanks")
      ws.close()
    }, { questionBridge: bridge })
  })

  it("question: no configured bridge → error frame; stray answer messages are ignored (no crash)", async () => {
    await withHost(async (base) => {
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))
      ws.send(JSON.stringify({ type: "open", streamId: "q1", endpoint: "question", payload: {} }))
      await until(() => messages.some(m => m.type === "error" && m.streamId === "q1" && String(m.error).includes("question endpoint not configured")))
      // An answer for a stream that never opened must not kill the connection.
      ws.send(JSON.stringify({ type: "answer", streamId: "q1", value: { questionId: "nope", answer: "x" } }))
      // The connection still serves new streams afterwards.
      ws.send(JSON.stringify({ type: "open", streamId: "q2", endpoint: "question", payload: {} }))
      await until(() => messages.some(m => m.type === "error" && m.streamId === "q2"))
      ws.close()
    })
  })

  it("question: malformed answer frames (non-object value) are dropped without killing the connection", async () => {
    const ctx = createContext()
    const bridge = new QuestionMuxBridge(ctx, 5_000)
    bridge.attach()
    await withHost(async (base) => {
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))

      ws.send(JSON.stringify({ type: "open", streamId: "q1", endpoint: "question", payload: {} }))
      await until(() => messages.some(m => m.type === "ready" && m.streamId === "q1"))

      // The review r1 bug: value: 42 (or a missing value) used to throw inside
      // receive() (questions.ts: read .questionId on undefined/primitive) and
      // close the socket (1008), tearing down EVERY stream.
      ws.send(JSON.stringify({ type: "answer", streamId: "q1", value: 42 }))
      ws.send(JSON.stringify({ type: "answer", streamId: "q1" }))

      // The SAME connection still serves the real question flow: ask → item → answer.
      const ask = askUser(ctx, { id: "confirm", prompt: "still alive?" })
      await until(() => messages.some(m =>
        m.type === "item" && m.streamId === "q1" && (m.value as QuestionRequestWire).text === "still alive?"))
      const request = messages.find(m => m.type === "item" && m.streamId === "q1")!.value as QuestionRequestWire
      ws.send(JSON.stringify({ type: "answer", streamId: "q1", value: { questionId: request.questionId, answer: "yes" } }))
      await expect(ask).resolves.toBe("yes")
      ws.close()
    }, { questionBridge: bridge })
  })
})

describe("web-host static serving (B3-H3)", () => {
  // M26 C-scope: static SPA serving is a deferred one-liner (the branch's
  // serveStatic is not ported) — non-API routes always 404 JSON. The
  // traversal-prevention surface returns with the static host.
  it("no staticDir → non-API routes stay 404 JSON (API-only host, unchanged)", async () => {
    await withHost(async (base) => {
      const res = await fetch(`${base}/`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toBe("not found")
    })
  })
})

// ── FW-2 (final merge-blocker): JSON `null` bodies must answer 400, never 500 ─
// `readJson` parses a literal `null` "fine"; the object-body routes then read
// a property on it → TypeError → the generic route catch answered 500. Every
// object-body route now routes through readJsonObject, which answers its own
// 400 (`*-invalid` code, or attachment's codeless shape) for a non-object body.
// One parametrised host-level test over the whole list keeps it honest; every
// endpoint family answers the same client-error shape.
describe("web-host object-body guard (FW-2: null body → 400, never 500)", () => {
  it("literal JSON `null` answers 400 on every object-body POST/PUT route", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-null-"))
    const storeRoot = await mkdtemp(join(tmpdir(), "i-harness-web-host-null-att-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(root))
    const attachments = createImageAttachmentStore({ workspaceDir: storeRoot })
    const commandBridge: CommandBridge = { list: () => [], run: async () => "x" }
    const host = createWebHost({
      port: 0,
      coordinator,
      workspaceRegistry: createWorkspaceRegistry(coordinator),
      attachments,
      commandBridge,
    })
    const { port } = await host.listen()
    const base = `http://127.0.0.1:${port}`
    try {
      const cases: Array<{ method: string; path: string }> = [
        { method: "POST", path: "/api/commands/execute" },
        { method: "POST", path: "/api/workspaces" },
        { method: "PUT", path: "/api/workspaces/ws-1" },
        { method: "POST", path: "/api/sessions" },
        { method: "PUT", path: "/api/sessions/s1" },
        { method: "POST", path: "/api/sessions/s1/fork" },
        { method: "POST", path: "/api/sessions/s1/goal" },
        { method: "POST", path: "/api/attachments" },
        { method: "PUT", path: "/api/sessions/s1/feedback" },
      ]
      for (const c of cases) {
        const res = await fetch(`${base}${c.path}`, {
          method: c.method,
          headers: { "content-type": "application/json" },
          body: "null",
        })
        expect(res.status, `${c.method} ${c.path}`).toBe(400)
        const body = await res.json() as { error: string }
        expect(body.error, `${c.method} ${c.path}`).toContain("invalid JSON body")
      }
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true }).catch(() => {})
      await rm(storeRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
