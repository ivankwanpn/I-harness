import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSession } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator, type SessionCoordinator } from "@i-harness/session-persistence"
import { createSessionService } from "@i-harness/session-executor"
import { createWebHost, type WebHost, type WebHostOptions } from "../src/host.ts"
import type { SessionEvent } from "@i-harness/core-session"
import type { GoalView } from "@i-harness/goal"

// M27-H-1: branch goal.spec.ts HTTP route cases ported to the C-scope
// fixture (the domain-level fold/mutation unit tests stay in the branch's
// heritage — the route contract is what this suite covers).
async function withHost(
  run: (base: string, host: WebHost, coordinator: SessionCoordinator, root: string) => Promise<void>,
  options: Partial<Omit<WebHostOptions, "executor" | "port" | "coordinator">> = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-goal-"))
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
    body: JSON.stringify({}),
  })
  const created = await create.json() as { id: string }
  expect(created.id).toBeTruthy()
  return created.id
}

async function createGoalViaHttp(base: string, id: string, objective = "write the report"): Promise<{ goal: GoalView }> {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective }),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ goal: GoalView }>
}

describe("goal HTTP routes (task 4.2, ported)", () => {
  it("GET /api/sessions/:id/goal answers 404 for an unknown session and { goal: null } when none", async () => {
    await withHost(async (base) => {
      const missing = await fetch(`${base}/api/sessions/ghost/goal`)
      expect(missing.status).toBe(404)
      const id = await createSessionViaHttp(base)
      const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ goal: null })
    })
  })

  it("POST create returns the projection AND appends the durable goal/change event to the log", async () => {
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const { goal } = await createGoalViaHttp(base, id)
      expect(goal).toMatchObject({ phase: "active", revision: 1, objective: "write the report" })
      expect(goal.maxGoalRounds).toBeUndefined()
      const get = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`)
      expect(((await get.json()) as { goal: GoalView }).goal).toEqual(goal)
      const page = await (await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/events`)).json() as { events: SessionEvent[] }
      expect(page.events.map((e) => e.type)).toEqual(["goal/change"])
    })
  })

  it("POST create validates the body: blank objective, negative rounds and bad JSON → 400 goal-invalid", async () => {
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const post = (body: string): Promise<Response> =>
        fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`, { method: "POST", headers: { "content-type": "application/json" }, body })
      expect((await post(JSON.stringify({ objective: "  " }))).status).toBe(400)
      expect((await post(JSON.stringify({ objective: "x", maxGoalRounds: 0 }))).status).toBe(400)
      expect((await post("{not json")).status).toBe(400)
      const page = await (await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/events`)).json() as { events: unknown[] }
      expect(page.events).toEqual([])
    })
  })

  it("POST create 409 goal-exists while a goal is active; replace works after complete", async () => {
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const { goal } = await createGoalViaHttp(base, id, "first")
      const dup = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "second" }),
      })
      expect(dup.status).toBe(409)
      expect(((await dup.json()) as { code: string }).code).toBe("goal-exists")
      const complete = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: { id: goal.id, revision: goal.revision } }),
      })
      expect(complete.status).toBe(200)
      const done = (await complete.json()) as { goal: GoalView }
      expect(done.goal.phase).toBe("complete")
      const replacement = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "replacement" }),
      })
      expect(replacement.status).toBe(200)
      expect(((await replacement.json()) as { goal: GoalView }).goal.revision).toBe(1)
    })
  })

  it("PUT edit changes fields without changing phase; stale ref → 409 goal-stale-ref", async () => {
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const { goal } = await createGoalViaHttp(base, id, "t")
      const edit = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: { id: goal.id, revision: goal.revision }, objective: "t2", maxGoalRounds: 3 }),
      })
      expect(edit.status).toBe(200)
      const edited = (await edit.json()) as { goal: GoalView }
      expect(edited.goal).toMatchObject({ objective: "t2", phase: "active", revision: 2, maxGoalRounds: 3 })
      const stale = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: { id: goal.id, revision: goal.revision }, objective: "stale write" }),
      })
      expect(stale.status).toBe(409)
      expect(((await stale.json()) as { code: string }).code).toBe("goal-stale-ref")
      const get = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`)
      expect(((await get.json()) as { goal: GoalView }).goal.objective).toBe("t2")
    })
  })

  it("pause/resume/complete/clear transition the phase; invalid transitions answer 409 with a code", async () => {
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const { goal } = await createGoalViaHttp(base, id)
      const ref = { id: goal.id, revision: goal.revision }
      const act = (path: string, body: string): Promise<Response> =>
        fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal/${path}`, {
          method: "POST", headers: { "content-type": "application/json" }, body,
        })
      const pausedView = (await (await act("pause", JSON.stringify({ ref }))).json()) as { goal: GoalView }
      expect(pausedView.goal.phase).toBe("paused")
      const doublePause = await act("pause", JSON.stringify({ ref: { id: pausedView.goal.id, revision: pausedView.goal.revision } }))
      expect(doublePause.status).toBe(409)
      expect(((await doublePause.json()) as { code: string }).code).toBe("goal-invalid-transition")
      const resumedView = (await (await act("resume", JSON.stringify({ ref: { id: pausedView.goal.id, revision: pausedView.goal.revision } }))).json()) as { goal: GoalView }
      expect(resumedView.goal.phase).toBe("active")
      const cleared = await act("clear", JSON.stringify({ ref: { id: resumedView.goal.id, revision: resumedView.goal.revision } }))
      expect(cleared.status).toBe(200)
      expect(((await cleared.json()) as { goal: GoalView | null }).goal).toBeNull()
      const get = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`)
      expect(await get.json()).toEqual({ goal: null })
    })
  })

  it("action verbs without a current goal answer 409 goal-none; missing ref 409 goal-stale-ref", async () => {
    await withHost(async (base) => {
      const id = await createSessionViaHttp(base)
      const none = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal/pause`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      })
      expect(none.status).toBe(409)
      expect(((await none.json()) as { code: string }).code).toBe("goal-none")
      await createGoalViaHttp(base, id)
      const noRef = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal/pause`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      })
      expect(noRef.status).toBe(409)
      expect(((await noRef.json()) as { code: string }).code).toBe("goal-stale-ref")
    })
  })

  it("live path: the mutation lands in the attached instance AND in the durable snapshot the reads fold", async () => {
    await withHost(async (base, _host, coordinator) => {
      const id = await createSessionViaHttp(base)
      const live = createSession((ev) => { coordinator.enqueue(id, [ev]) })
      _host.attachLiveSession({ sessionId: id, session: live })
      const { goal } = await createGoalViaHttp(base, id)
      expect(live.events.map((e) => e.type)).toEqual(["goal/change"])
      expect((live.events[0] as { goal?: { phase?: string } }).goal?.phase).toBe("active")
      const snapshot = await coordinator.load(id)
      expect(snapshot.session.events.map((e) => e.type)).toEqual(["goal/change"])
      const get = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`)
      expect(((await get.json()) as { goal: GoalView }).goal).toEqual(goal)
    })
  })

  it("a goal set BEFORE the first message survives a later live attach (goal-first flow, restart re-attach)", async () => {
    await withHost(async (base, _host, coordinator) => {
      const id = await createSessionViaHttp(base)
      const { goal } = await createGoalViaHttp(base, id)
      const durable = await coordinator.load(id)
      expect(durable.session.events.map((e) => e.type)).toEqual(["goal/change"])
      const fresh = createSession()
      _host.attachLiveSession({ sessionId: id, session: fresh })
      const get = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal`)
      expect(((await get.json()) as { goal: GoalView }).goal).toEqual(goal)
      const hooked = createSession((ev) => { coordinator.enqueue(id, [ev]) })
      _host.attachLiveSession({ sessionId: id, session: hooked })
      const paused = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/goal/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: { id: goal.id, revision: goal.revision } }),
      })
      expect(paused.status).toBe(200)
      expect(((await paused.json()) as { goal: GoalView }).goal.phase).toBe("paused")
      expect((await coordinator.load(id)).session.events.map((e) => e.type))
        .toEqual(["goal/change", "goal/change"])
    })
  })

  it("without a coordinator the goal routes answer 500 (server misconfiguration, session-route parity)", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-goal-nocoord-"))
    const host = createWebHost({ port: 0 })
    const { port } = await host.listen()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/goal`)
      expect(res.status).toBe(500)
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
