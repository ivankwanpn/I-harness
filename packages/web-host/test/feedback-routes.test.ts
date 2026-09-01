import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEvent } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator, type SessionCoordinator } from "@i-harness/session-persistence"
import { createSessionService } from "@i-harness/session-executor"
import { createWebHost, type WebHost, type WebHostOptions } from "../src/host.ts"
import type { MessageFeedbackItem } from "@i-harness/feedback"

// M27-H-1: branch feedback.spec.ts HTTP route cases ported to the C-scope
// fixture (store-level unit cases stay in the branch's heritage).
async function withHost(
  run: (base: string, host: WebHost, coordinator: SessionCoordinator, root: string) => Promise<void>,
  options: Partial<Omit<WebHostOptions, "executor" | "port" | "coordinator">> = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-feedback-"))
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
  const created = await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { id: string }
  return created.id
}

async function seedEvents(coordinator: SessionCoordinator, id: string): Promise<void> {
  await coordinator.append(id, [
    { type: "user/message", text: "hi", seq: 0 },
    { type: "assistant/message", text: "hello", seq: 1 },
  ] as SessionEvent[])
}

const putFeedback = (base: string, id: string, body: object): Promise<Response> =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/feedback`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })

describe("message feedback HTTP routes (task 4.3, ported)", () => {
  it("GET: empty items list, then the persisted items; unknown session → 404", async () => {
    await withHost(async (base, _host, coordinator) => {
      expect((await fetch(`${base}/api/sessions/ghost/feedback`)).status).toBe(404)
      const id = await createSessionViaHttp(base)
      const empty = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/feedback`)
      expect(empty.status).toBe(200)
      expect(await empty.json()).toEqual({ items: [] })
      await seedEvents(coordinator, id)
      const put = await putFeedback(base, id, { messageId: "1", rating: "like" })
      expect(put.status).toBe(200)
      const { item } = await put.json() as { item: MessageFeedbackItem }
      expect(item).toMatchObject({ messageId: "1", rating: "like", version: 1 })
      expect(typeof item.updatedAt).toBe("string")
      const listed = await (await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/feedback`)).json() as { items: MessageFeedbackItem[] }
      expect(listed.items).toEqual([item])
      expect("note" in listed.items[0]!).toBe(false)
    })
  })

  it("PUT stores the optional note; whole-value overwrite erases it", async () => {
    await withHost(async (base, _host, coordinator) => {
      const id = await createSessionViaHttp(base)
      await seedEvents(coordinator, id)
      const withNote = await (await putFeedback(base, id, { messageId: "1", rating: "like", note: "清晰" })).json() as { item: MessageFeedbackItem }
      expect(withNote.item.note).toBe("清晰")
      const stripped = await (await putFeedback(base, id, { messageId: "1", rating: "dislike" })).json() as { item: MessageFeedbackItem }
      expect(stripped.item).toMatchObject({ rating: "dislike", version: 2 })
      expect(stripped.item.note).toBeUndefined()
    })
  })

  it("PUT validation → 400 with machine codes; nothing is written", async () => {
    await withHost(async (base, _host, coordinator) => {
      const id = await createSessionViaHttp(base)
      await seedEvents(coordinator, id)
      const cases: Array<[object, string]> = [
        [{ messageId: "1", rating: "meh" }, "feedback-invalid"],
        [{ messageId: "0", rating: "like" }, "message-not-found"],
        [{ messageId: "99", rating: "like" }, "message-not-found"],
        [{ messageId: "1", rating: "like", note: "   " }, "note-blank"],
        [{ messageId: "1", rating: "like", note: "好".repeat(1366) }, "note-too-large"],
        [{ messageId: "1", rating: "like", ifVersion: 1.5 }, "feedback-invalid"],
        [{ rating: "like" }, "feedback-invalid"],
      ]
      for (const [body, code] of cases) {
        const res = await putFeedback(base, id, body)
        expect(res.status).toBe(400)
        expect(((await res.json()) as { code: string }).code).toBe(code)
      }
      const badJson = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/feedback`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: "{not json",
      })
      expect(badJson.status).toBe(400)
      expect(((await badJson.json()) as { code: string }).code).toBe("feedback-invalid")
      expect((await (await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/feedback`)).json() as { items: unknown[] }).items).toEqual([])
    })
  })

  it("PUT CAS: stale ifVersion → 409 version-conflict + current; force overwrite succeeds", async () => {
    await withHost(async (base, _host, coordinator) => {
      const id = await createSessionViaHttp(base)
      await seedEvents(coordinator, id)
      const { item } = await (await putFeedback(base, id, { messageId: "1", rating: "like" })).json() as { item: MessageFeedbackItem }
      const stale = await putFeedback(base, id, { messageId: "1", rating: "dislike", ifVersion: item.version + 1 })
      expect(stale.status).toBe(409)
      const conflict = await stale.json() as { code: string; current: MessageFeedbackItem }
      expect(conflict.code).toBe("version-conflict")
      expect(conflict.current).toEqual(item)
      const forced = await (await putFeedback(base, id, { messageId: "1", rating: "dislike" })).json() as { item: MessageFeedbackItem }
      expect(forced.item).toMatchObject({ rating: "dislike", version: item.version + 1 })
    })
  })

  it("DELETE: absent succeeds; matching ifVersion removes; mismatch 409; invalid ifVersion 400", async () => {
    await withHost(async (base, _host, coordinator) => {
      const id = await createSessionViaHttp(base)
      await seedEvents(coordinator, id)
      const absent = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/feedback/12`, { method: "DELETE" })
      expect(absent.status).toBe(200)
      expect(await absent.json()).toEqual({ absent: true })
      await putFeedback(base, id, { messageId: "1", rating: "like" })
      const mismatch = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/feedback/1?ifVersion=9`, { method: "DELETE" })
      expect(mismatch.status).toBe(409)
      expect(((await mismatch.json()) as { code: string }).code).toBe("version-conflict")
      const invalid = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/feedback/1?ifVersion=abc`, { method: "DELETE" })
      expect(invalid.status).toBe(400)
      const ok = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/feedback/1?ifVersion=1`, { method: "DELETE" })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ absent: true })
      expect((await (await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/feedback`)).json() as { items: unknown[] }).items).toEqual([])
      expect((await fetch(`${base}/api/sessions/ghost/feedback/1`, { method: "DELETE" })).status).toBe(404)
    })
  })

  it("without a coordinator the feedback routes answer 500 (session-route parity)", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-feedback-nocoord-"))
    const host = createWebHost({ port: 0 })
    const { port } = await host.listen()
    try {
      const base = `http://127.0.0.1:${port}`
      expect((await fetch(`${base}/api/sessions/s1/feedback`)).status).toBe(500)
      expect((await fetch(`${base}/api/sessions/s1/feedback`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: "1", rating: "like" }),
      })).status).toBe(500)
      expect((await fetch(`${base}/api/sessions/s1/feedback/1`, { method: "DELETE" })).status).toBe(500)
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("PUT answers 500 (never a silent 200) when the doc write does not land", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-feedback-"))
    const failing = createSessionCoordinator({
      ...createJsonlBackend(root),
      putDocument: async () => { throw new Error("disk full") },
    }, { reportBackgroundFailure: () => {} })
    const host = createWebHost({ port: 0, coordinator: failing })
    const { port } = await host.listen()
    try {
      const base = `http://127.0.0.1:${port}`
      const id = await createSessionViaHttp(base)
      await seedEvents(failing, id)
      const res = await putFeedback(base, id, { messageId: "1", rating: "like" })
      expect(res.status).toBe(500)
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("feedback survives a new host over the same store root (refresh/restart persistence)", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-feedback-"))
    const firstCoord = createSessionCoordinator(createJsonlBackend(root))
    const firstHost = createWebHost({ port: 0, coordinator: firstCoord })
    const { port } = await firstHost.listen()
    try {
      const base = `http://127.0.0.1:${port}`
      const id = await createSessionViaHttp(base)
      await seedEvents(firstCoord, id)
      await putFeedback(base, id, { messageId: "1", rating: "like", note: "保留" })
    } finally {
      await firstHost.close()
      await firstCoord.close()
    }
    const secondCoord = createSessionCoordinator(createJsonlBackend(root))
    const secondHost = createWebHost({ port: 0, coordinator: secondCoord })
    const { port: secondPort } = await secondHost.listen()
    try {
      const res = await fetch(`http://127.0.0.1:${secondPort}/api/sessions`)
      const { sessions } = await res.json() as { sessions: Array<{ id: string }> }
      const id = sessions[0]!.id
      const listed = await (await fetch(`http://127.0.0.1:${secondPort}/api/sessions/${encodeURIComponent(id)}/feedback`)).json() as { items: MessageFeedbackItem[] }
      expect(listed.items).toMatchObject([{ messageId: "1", rating: "like", note: "保留", version: 1 }])
    } finally {
      await secondHost.close()
      await secondCoord.close()
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
