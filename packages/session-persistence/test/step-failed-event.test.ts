import { expect, it } from "vitest"
import { append, createSession, deriveMessages } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

it("reopens a failed model step without reviving its incomplete tool call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i-harness-step-failed-"))
  const first = createSessionCoordinator(createJsonlBackend(dir), {})
  try {
    const { id } = await first.create({})
    const log = createSession()
    append(log, { type: "turn/start" })
    append(log, { type: "user/message", text: "read" })
    append(log, { type: "step/start" })
    append(log, { type: "tool/call", callId: "c1", name: "read", args: {} })
    append(log, { type: "step/failed" })
    first.enqueue(id, log.events)
    await first.flush(id)
    await first.close()
    const reopened = createSessionCoordinator(createJsonlBackend(dir), {})
    try {
      const loaded = await reopened.load(id)
      expect(loaded.session.events.some((event) => event.type === "step/failed")).toBe(true)
      expect(deriveMessages(loaded.session)).toEqual([{ role: "user", content: "read" }])
      const owned = await reopened.loadOwned(id)
      expect(owned.session.events.some((event) => event.type === "step/failed")).toBe(true)
      expect(deriveMessages(owned.session)).toEqual([{ role: "user", content: "read" }])
    } finally { await reopened.close() }
  } finally {
    await first.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})
