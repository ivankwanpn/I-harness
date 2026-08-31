import { mkdtempSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createSessionService } from "@i-harness/session-executor"
import { createWebHost, type WebHost, type WebHostOptions } from "../src/host.ts"
import { createAuth } from "../src/auth.ts"

const base = (host: { port: number }) => `http://127.0.0.1:${host.port}`
const tempStore = () => mkdtempSync(join(tmpdir(), "ih-web-host-"))

async function withHost(
  run: (port: number, coordinator: ReturnType<typeof createSessionCoordinator>) => Promise<void>,
  options: Partial<WebHostOptions> = {},
): Promise<void> {
  const root = tempStore()
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  const executor = createSessionService({ workspace: process.cwd(), approveAll: true, mockCycles: true, coordinator })
  const host: WebHost = createWebHost({ port: 0, executor, coordinator, ...options })
  executor.onAssembly((a) => { if (a.sessionId !== undefined) host.attachLiveSession({ sessionId: a.sessionId, session: a.session }) })
  const { port } = await host.listen()
  try {
    await run(port, coordinator)
  } finally {
    await host.close()
    await executor.close()
    await coordinator.close()
  }
}

async function createSession(baseUrl: string): Promise<string> {
  const post = await fetch(`${baseUrl}/api/sessions`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
  expect(post.status).toBe(200)
  const { id } = await post.json() as { id: string }
  return id
}

describe("host unary routes", () => {
  let stop: (() => Promise<void>) | undefined
  afterEach(async () => { await stop?.(); stop = undefined })

  it("creates and lists sessions, resumes, pages events", async () => {
    await withHost(async (port) => {
      const id = await createSession(base({ port }))
      const res = await fetch(`${base({ port })}/api/sessions`)
      expect((await res.json() as { sessions: unknown[] }).sessions.length).toBe(1)
      const resume = await fetch(`${base({ port })}/api/sessions/${id}/resume`, { method: "POST" })
      expect(resume.status).toBe(200)
      const events = await fetch(`${base({ port })}/api/sessions/${id}/events`)
      expect((await events.json()).events).toEqual([])
      expect(events.status).toBe(200)
      const fork = await fetch(`${base({ port })}/api/sessions/${id}/fork`, { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } })
      expect(fork.status).toBe(409) // no completed turn to fork from
    })
  })

  it("mux: command stream runs one turn and ends; live session stream sees appends", async () => {
    await withHost(async (port) => {
      const id = await createSession(base({ port }))
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/mux`)
      const frames: string[] = []
      await new Promise<void>((resolve) => {
        ws.onopen = () => ws.send(JSON.stringify({ type: "open", streamId: "cmd", endpoint: "command", payload: { sessionId: id, prompt: "hi" } }))
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data))
          frames.push(msg.type === "item" ? `${msg.type}:${(msg.value as { status?: string })?.status ?? ""}` : msg.type)
          if (msg.type === "end") resolve()
        }
      })
      expect(frames).toContain("item:started")
      expect(frames.at(-1)).toBe("end")
      ws.close()
    })
  })

  it("commands: list and execute through the seam", async () => {
    const commandBridge = {
      list: () => [{ name: "ping", description: "pong" }],
      run: async (_: string, line: string) => `ran:${line}`,
    }
    await withHost(async (port) => {
      const id = await createSession(base({ port }))
      const list = await fetch(`${base({ port })}/api/commands`)
      expect((await list.json()) as { commands: unknown }).toEqual({ commands: [{ name: "ping", description: "pong" }] })
      const exec = await fetch(`${base({ port })}/api/commands/execute`, { method: "POST", body: JSON.stringify({ sessionId: id, line: "ping hi" }), headers: { "content-type": "application/json" } })
      expect(exec.status).toBe(200)
      expect(await exec.json()).toEqual({ result: "ran:ping hi" })
    }, { commandBridge })
  })

  it("events: afterSeq replays forward, bounded; both cursors rejected", async () => {
    await withHost(async (port, coordinator) => {
      const id = await createSession(base({ port }))
      await coordinator.append(id, [
        { type: "user/message", text: "a", seq: 0 }, { type: "assistant/message", text: "b", seq: 1 },
      ])
      const page = await (await fetch(`${base({ port })}/api/sessions/${id}/events?afterSeq=0&limit=1`)).json() as { events: { seq?: number }[]; nextAfterSeq?: number }
      expect(page.events.map((e) => e.seq)).toEqual([1])
      expect(page.nextAfterSeq).toBe(1)
      const both = await fetch(`${base({ port })}/api/sessions/${id}/events?beforeSeq=5&afterSeq=0`)
      expect(both.status).toBe(400)
    })
  })

  it("auth: unauthenticated requests answer 401; bad hosts answer 403; login sets the cookie", async () => {
    const auth = createAuth({ hmacSecret: "b".repeat(64), launchToken: "t" })
    await withHost(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`)
      expect(res.status).toBe(401)
      const token = auth.signSession()
      const ok = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { cookie: `i-harness=${token}` } })
      expect(ok.status).toBe(200)
      // fence checked even before auth: an evil ORIGIN headers through fetch
      // (the Host header is undici-protected — test it via raw http.request).
      const evil = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { origin: "http://evil.com", cookie: `i-harness=${token}` } })
      expect(evil.status).toBe(403)
      const evilHost = await new Promise<number>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/api/sessions", headers: { host: "evil.com", cookie: `i-harness=${token}` } }, (r) => resolve(r.statusCode ?? 0))
        req.end()
      })
      expect(evilHost).toBe(403)
      // OPTIONS preflight on an allowed origin → 204 CORS
      const preflight = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: "OPTIONS",
        headers: { origin: "http://127.0.0.1:3000", "access-control-request-method": "POST" },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3000")
      // ?token= works on HTTP (curl/CLI)
      const query = await fetch(`http://127.0.0.1:${port}/api/sessions?token=t`)
      expect(query.status).toBe(200)
      expect(query.headers.get("set-cookie")).toBeNull()
      // login route: invalid launch token 401, valid sets the cookie
      const bad = await fetch(`http://127.0.0.1:${port}/api/auth/login?token=wrong`)
      expect(bad.status).toBe(401)
      const login = await fetch(`http://127.0.0.1:${port}/api/auth/login?token=t`)
      expect(login.status).toBe(200)
      expect(login.headers.get("set-cookie") ?? "").toContain("i-harness=")
      const withCookie = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { cookie: login.headers.get("set-cookie")!.split(";")[0]! } })
      expect(withCookie.status).toBe(200)
    }, { auth })
  })

  it("model routes: title PUT + per-session model selection + list row enrichment; llm/directory 404 without the seam", async () => {
    await withHost(async (port) => {
      const id = await createSession(base({ port }))
      const title = await fetch(`${base({ port })}/api/sessions/${id}`, { method: "PUT", body: JSON.stringify({ title: "T" }), headers: { "content-type": "application/json" } })
      expect(title.status).toBe(200)
      expect(await title.json()).toEqual({ title: "T" })
      const model = await fetch(`${base({ port })}/api/sessions/${id}/model`, { method: "POST", body: JSON.stringify({ provider: "p", model: "m" }), headers: { "content-type": "application/json" } })
      expect(model.status).toBe(200)
      expect((await model.json() as { modelSelection: unknown }).modelSelection).toEqual({ provider: "p", model: "m" })
      const list = await (await fetch(`${base({ port })}/api/sessions`)).json() as { sessions: Array<Record<string, unknown>> }
      expect(list.sessions[0]).toMatchObject({ title: "T", modelSelection: { provider: "p", model: "m" }, blank: true })
      const directory = await fetch(`${base({ port })}/api/llm/directory`)
      expect(directory.status).toBe(404)
    })
  })
})
