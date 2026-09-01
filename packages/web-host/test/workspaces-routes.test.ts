import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createSession } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator, type SessionCoordinator } from "@i-harness/session-persistence"
import { createWorkspaceRegistry } from "@i-harness/workspace"
import { createSessionService } from "@i-harness/session-executor"
import { createWebHost, type WebHost, type WebHostOptions } from "../src/host.ts"

// M27-H-1: branch workspaces.spec.ts route cases ported to the C-scope
// fixture (createWebHost over the REAL session service). The branch's
// `workspacePath` option no longer exists — the host roots on the coordinator;
// the workspace registry is composed over the SAME coordinator the host uses
// (the CLI wiring's composition point), so docs + headers share one store.
async function withHost(
  run: (base: string, host: WebHost, coordinator: SessionCoordinator, root: string) => Promise<void>,
  buildOptions: (coordinator: SessionCoordinator) => Partial<Omit<WebHostOptions, "executor" | "port">> = () => ({}),
) {
  const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-workspaces-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  const executor = createSessionService({ workspace: process.cwd(), approveAll: true, mockCycles: true, coordinator })
  const host = createWebHost({ port: 0, executor, coordinator, ...buildOptions(coordinator) })
  const { port } = await host.listen()
  try {
    await run(`http://127.0.0.1:${port}`, host, coordinator, root)
  } finally {
    await host.close()
    await executor.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

describe("web-host workspace routes (task 3.1, ported)", () => {
  it("without the registry seam, a body workspaceId/cwd never reaches the session header", async () => {
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-dangling", cwd: process.cwd() }),
      })
      expect(res.status).toBe(200)
      const list = await (await fetch(`${base}/api/sessions`)).json() as { sessions: Array<{ workspaceId?: string }> }
      expect(list.sessions[0]!.workspaceId).toBeUndefined()
    })
  })

  it("workspace routes 404 without the registry seam", async () => {
    await withHost(async (base) => {
      expect((await fetch(`${base}/api/workspaces`)).status).toBe(404)
      expect((await fetch(`${base}/api/workspaces`, { method: "POST", body: "{}" })).status).toBe(404)
      expect((await fetch(`${base}/api/workspaces/ws-123`, { method: "PUT", body: "{}" })).status).toBe(404)
    })
  })

  it("GET /api/workspaces returns [] for an empty registry", async () => {
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/workspaces`)
      expect(res.status).toBe(200)
      expect((await res.json() as { workspaces: unknown[] }).workspaces).toEqual([])
    }, (coordinator) => ({ workspaceRegistry: createWorkspaceRegistry(coordinator) }))
  })

  it("POST /api/workspaces adopts an existing directory (idempotent by path)", async () => {
    await withHost(async (base, _host, _coordinator, root) => {
      const dir = join(root, "my-app")
      await mkdir(dir, { recursive: true })
      const first = await fetch(`${base}/api/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dir }),
      })
      expect(first.status).toBe(200)
      const created = await first.json() as { workspace: { workspaceId: string; path: string; title: string; sessionIds: string[] }; created: boolean }
      expect(created.created).toBe(true)
      expect(created.workspace.path).toBe(dir)
      expect(created.workspace.title).toBe(basename(dir))
      expect(created.workspace.sessionIds).toEqual([])

      const again = await fetch(`${base}/api/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dir }),
      })
      const resolved = await again.json() as { workspace: { workspaceId: string }; created: boolean }
      expect(resolved.created).toBe(false)
      expect(resolved.workspace.workspaceId).toBe(created.workspace.workspaceId)
    }, (coordinator) => ({ workspaceRegistry: createWorkspaceRegistry(coordinator) }))
  })

  it("POST /api/workspaces 400s a blank path, a missing dir, and a file", async () => {
    await withHost(async (base, _host, _coordinator, root) => {
      const blank = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "  " }) })
      expect(blank.status).toBe(400)

      const missing = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: join(root, "nope") }) })
      expect(missing.status).toBe(400)

      const file = join(root, "a-file.txt")
      await writeFile(file, "x")
      const notDir = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: file }) })
      expect(notDir.status).toBe(400)
    }, (coordinator) => ({ workspaceRegistry: createWorkspaceRegistry(coordinator) }))
  })

  it("PUT /api/workspaces/:id renames; 400/404/409 map the DSH error codes", async () => {
    await withHost(async (base, _host, _coordinator, root) => {
      const a = join(root, "app")
      const b = join(root, "api")
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      const wsA = await (await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: a }) })).json() as { workspace: { workspaceId: string } }
      const wsB = await (await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: b }) })).json() as { workspace: { workspaceId: string } }

      const ok = await fetch(`${base}/api/workspaces/${encodeURIComponent(wsA.workspace.workspaceId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "控制台" }),
      })
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { workspace: { title: string } }).workspace.title).toBe("控制台")

      const blank = await fetch(`${base}/api/workspaces/${encodeURIComponent(wsA.workspace.workspaceId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "  " }),
      })
      expect(blank.status).toBe(400)
      expect(((await blank.json()) as { code: string }).code).toBe("bad-request")

      const missing = await fetch(`${base}/api/workspaces/ws-zzzzzzzz`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      })
      expect(missing.status).toBe(404)

      const conflict = await fetch(`${base}/api/workspaces/${encodeURIComponent(wsB.workspace.workspaceId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "控制台" }),
      })
      expect(conflict.status).toBe(409)
      expect(((await conflict.json()) as { code: string }).code).toBe("workspace-name-conflict")
    }, (coordinator) => ({ workspaceRegistry: createWorkspaceRegistry(coordinator) }))
  })

  it("POST /api/sessions with cwd auto-records a workspace; the list joins workspaceId", async () => {
    await withHost(async (base, _host, _coordinator, root) => {
      const dir = join(root, "work")
      await mkdir(dir, { recursive: true })
      const created = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: dir }),
      })
      expect(created.status).toBe(200)
      const { id } = await created.json() as { id: string }

      const list = await (await fetch(`${base}/api/sessions`)).json() as { sessions: Array<{ id: string; workspaceId?: string; running: boolean }> }
      const row = list.sessions.find(s => s.id === id)
      expect(row?.workspaceId).toMatch(/^ws-[0-9a-f]{8}$/)
      expect(row?.running).toBe(false)

      const workspaces = await (await fetch(`${base}/api/workspaces`)).json() as { workspaces: Array<{ sessionIds: string[] }> }
      expect(workspaces.workspaces[0]!.sessionIds).toEqual([id])
    }, (coordinator) => ({ workspaceRegistry: createWorkspaceRegistry(coordinator) }))
  })

  it("POST /api/sessions with workspaceId attaches to an existing workspace; unknown → 404", async () => {
    await withHost(async (base, _host, _coordinator, root) => {
      const dir = join(root, "work")
      await mkdir(dir, { recursive: true })
      const ws = await (await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: dir }) })).json() as { workspace: { workspaceId: string } }
      const created = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: ws.workspace.workspaceId }),
      })
      expect(created.status).toBe(200)
      const list = await (await fetch(`${base}/api/sessions`)).json() as { sessions: Array<{ workspaceId?: string }> }
      expect(list.sessions[0]!.workspaceId).toBe(ws.workspace.workspaceId)

      const unknown = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-baddead" }),
      })
      expect(unknown.status).toBe(404)
    }, (coordinator) => ({ workspaceRegistry: createWorkspaceRegistry(coordinator) }))
  })

  it("POST /api/sessions with a missing cwd 400s; without cwd stays unassigned", async () => {
    await withHost(async (base) => {
      const missing = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: join(tmpdir(), "i-harness-definitely-missing", "x") }),
      })
      expect(missing.status).toBe(400)

      const unassigned = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(unassigned.status).toBe(200)
      const list = await (await fetch(`${base}/api/sessions`)).json() as { sessions: Array<{ workspaceId?: string }> }
      expect(list.sessions[0]!.workspaceId).toBeUndefined()
    }, (coordinator) => ({ workspaceRegistry: createWorkspaceRegistry(coordinator) }))
  })

  it("GET /api/sessions reports running=true for an attached live session", async () => {
    await withHost(async (base, host) => {
      const unassigned = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      const { id } = await unassigned.json() as { id: string }
      host.attachLiveSession({ sessionId: id, session: createSession() })
      const list = await (await fetch(`${base}/api/sessions`)).json() as { sessions: Array<{ id: string; running: boolean }> }
      expect(list.sessions.find(s => s.id === id)?.running).toBe(true)
    }, (coordinator) => ({ workspaceRegistry: createWorkspaceRegistry(coordinator) }))
  })
})
