import { describe, expect, it, vi } from "vitest"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import WebSocket from "ws"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator, type SessionCoordinator } from "@i-harness/session-persistence"
import { createSessionService } from "@i-harness/session-executor"
import { createWebHost, type WebHost, type WebHostOptions } from "../src/host.ts"
import { JobKillUnknownJobError, type JobView } from "@i-harness/jobs"
import type { JobKillBridge } from "../src/types.ts"

// M27-H-1: branch jobs.spec.ts route cases ported to the C-scope fixture
// (the real session service provides queueState; the sessionRunner option of
// the branch fixture no longer exists).
async function withHost(
  run: (base: string, host: WebHost, coordinator: SessionCoordinator, root: string) => Promise<void>,
  options: Partial<Omit<WebHostOptions, "executor" | "port" | "coordinator">> = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-jobs-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  const executor = createSessionService({ workspace: process.cwd(), approveAll: true, mockCycles: true, coordinator })
  const host = createWebHost({ port: 0, executor, coordinator, ...options })
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

// The subagent layer's persisted snapshot shape (structurally what persist.ts
// puts under stateId; web-host maps it without depending on @i-harness/subagent).
const DOC = {
  formatVersion: 1,
  jobs: [
    { id: "subagent-1", owner: "root", kind: "subagent", label: "helper", status: "running", output: "", terminal: false, startedAt: 1000 },
    { id: "subagent-2", owner: "root", kind: "subagent", label: "reporter", status: "completed", output: "done", terminal: true, startedAt: 500, endedAt: 900 },
  ],
  agentTable: [],
  roles: [],
}

describe("GET /api/sessions/:id/jobs (portfolio, ported)", () => {
  it("404s an unknown session (events route parity)", async () => {
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/sessions/ghost/jobs`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toContain("session not found")
    })
  })

  it("serves { jobs: [], queue: { running: false, queued: 0 } } for a session with no subagent doc", async () => {
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/jobs`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ jobs: [], queue: { running: false, queued: 0 } })
    })
  })

  it("projects the subagent persistence snapshot doc (stamps + output availability, doc order)", async () => {
    await withHost(async (base, _host, coordinator) => {
      const id = await createSessionViaHttp(base)
      await coordinator.putDocument(id, DOC)
      const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/jobs`)
      expect(res.status).toBe(200)
      const body = await res.json() as { jobs: JobView[]; queue: { running: boolean; queued: number } }
      expect(body.queue).toEqual({ running: false, queued: 0 })
      expect(body.jobs).toEqual([
        { jobId: "subagent-1", kind: "subagent", label: "helper", status: "running", outputAvailable: false, startedAt: 1000 },
        { jobId: "subagent-2", kind: "subagent", label: "reporter", status: "completed", outputAvailable: true, startedAt: 500, endedAt: 900 },
      ])
    })
  })

  it("a foreign/non-snapshot doc under the session key serves an honest empty list (warnings, never a 500)", async () => {
    await withHost(async (base, _host, coordinator) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const id = await createSessionViaHttp(base)
        await coordinator.putDocument(id, { notAJobsArray: true })
        const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/jobs`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ jobs: [], queue: { running: false, queued: 0 } })
        expect(warn).toHaveBeenCalledOnce()
      } finally {
        warn.mockRestore()
      }
    })
  })

  it("queue reports the real service lane state: settled turns → idle (no gate fixture in the C-scope)", async () => {
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))
      const openCommand = (streamId: string, prompt: string): void => {
        ws.send(JSON.stringify({ type: "open", streamId, endpoint: "command", payload: { sessionId: id, prompt } }))
      }
      const frame = (streamId: string, status: string): unknown =>
        messages.find(m => m.type === "item" && m.streamId === streamId && (m.value as { status?: string }).status === status)?.value

      openCommand("c1", "first")
      await until(() => frame("c1", "started") !== undefined)
      openCommand("c2", "second")
      await until(() => frame("c2", "started") !== undefined)
      await until(() => frame("c1", "ok") !== undefined)
      await until(() => frame("c2", "ok") !== undefined)
      // both settled → idle (the stats entry is pruned at zero)
      const idle = await (await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/jobs`)).json() as { queue: { running: boolean; queued: number } }
      expect(idle.queue).toEqual({ running: false, queued: 0 })
      ws.close()
    })
  })
})

describe("POST /api/sessions/:id/jobs/:jobId/kill (portfolio, ported)", () => {
  it("404s an unknown session (events route parity)", async () => {
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/sessions/ghost/jobs/subagent-1/kill`, { method: "POST" })
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toContain("session not found")
    })
  })

  it("404s when the jobKillBridge seam is absent (optional-seam semantics)", async () => {
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/jobs/subagent-1/kill`, { method: "POST" })
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toContain("not configured")
    })
  })

  it("returns the registry outcome on success", async () => {
    const bridge: JobKillBridge = {
      kill: async (_sessionId, jobId) => {
        expect(jobId).toBe("subagent-1")
        return "cancellation-requested"
      },
    }
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/jobs/subagent-1/kill`, { method: "POST" })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ outcome: "cancellation-requested" })
    }, { jobKillBridge: bridge })
  })

  it("409s an unknown job id (JobKillUnknownJobError, with the id in the message)", async () => {
    const bridge: JobKillBridge = {
      kill: async () => { throw new JobKillUnknownJobError("ghost-job") },
    }
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/jobs/ghost-job/kill`, { method: "POST" })
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toContain("unknown job: ghost-job")
    }, { jobKillBridge: bridge })
  })

  it("surfaces a bridge failure as 500 with the message (never a silent 200)", async () => {
    const bridge: JobKillBridge = {
      kill: async () => { throw new Error("registry exploded") },
    }
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/jobs/subagent-1/kill`, { method: "POST" })
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: string }).error).toContain("registry exploded")
    }, { jobKillBridge: bridge })
  })
})
