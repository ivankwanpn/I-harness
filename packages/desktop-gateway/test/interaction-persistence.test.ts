import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import type { QuestionProvider } from "@i-harness/interaction"
import type { SessionAssembly } from "@i-harness/session-executor"
import { createInteractionBridge, type PendingInteraction } from "../src/interaction.ts"
import { openInteractionPersistence } from "../src/interaction-persistence.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function directory() { const path = await mkdtemp(join(tmpdir(), "interaction-persistence-")); directories.push(path); return path }
function row(requestId = "r1"): PendingInteraction {
  return { requestId, sessionId: "s1", kind: "question", payload: { id: "q1", prompt: "Choose", options: ["A", "B"] }, openedAt: Date.now() }
}

describe("workspace interaction snapshots", () => {
  it("recovers disk state after a process restart and consumes it durably", async () => {
    const path = await directory()
    const store = await openInteractionPersistence(path, join(path, "workspace"))
    const first = createInteractionBridge(() => {}, { persistence: store })
    const owner = { sessionId: "s1", ctx: createContext() } as unknown as SessionAssembly
    first.attach(owner)
    const answer = owner.ctx.services.get<QuestionProvider>("questions/provider").ask({ id: "q1", prompt: "Which plan?" })
    const rejected = expect(answer).rejects.toThrow(/closed/)
    const requestId = first.pending()[0]!.requestId
    // Opening a second store reads the on-disk snapshot without relying on
    // graceful close or the original store's in-memory rows.
    const reopened = await openInteractionPersistence(path, join(path, "workspace"))
    expect(reopened.read()[0]?.requestId).toBe(requestId)
    first.close()
    await rejected
    const second = createInteractionBridge(() => {}, { persistence: reopened, recover: async () => {} })
    try {
      expect(second.pending()[0]?.state).toBe("interrupted")
      await second.reply({ requestId, sessionId: "s1", decision: { kind: "question", answer: "A" } })
      expect((await openInteractionPersistence(path, join(path, "workspace"))).read()).toEqual([])
    } finally { second.close() }
  })

  it("isolates workspace snapshots even when they share a session directory", async () => {
    const path = await directory()
    const first = await openInteractionPersistence(path, join(path, "first"))
    const second = await openInteractionPersistence(path, join(path, "second"))
    first.write([row("first")])
    second.write([row("second")])
    expect((await openInteractionPersistence(path, join(path, "first"))).read().map((item) => item.requestId)).toEqual(["first"])
    expect((await openInteractionPersistence(path, join(path, "second"))).read().map((item) => item.requestId)).toEqual(["second"])
    expect((await readdir(path)).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  it("protects its durable snapshot from nested payload mutations", async () => {
    const path = await directory()
    const store = await openInteractionPersistence(path, path)
    const input = row()
    store.write([input])
    ;(input.payload as { options: string[] }).options.push("unexpected")
    const snapshot = store.read()
    ;(snapshot[0]!.payload as { options: string[] }).options.push("also unexpected")
    expect(store.read()[0]?.payload).toEqual({ id: "q1", prompt: "Choose", options: ["A", "B"] })
    expect((await openInteractionPersistence(path, path)).read()[0]?.payload).toEqual(store.read()[0]?.payload)
  })

  it("refuses invalid or corrupt documents instead of quietly discarding pending requests", async () => {
    const path = await directory()
    const store = await openInteractionPersistence(path, path)
    expect(() => store.write([{ ...row(), kind: "unknown" } as never])).toThrow(/Invalid/)
    store.write([row()])
    const name = (await readdir(path)).find((entry) => entry.endsWith(".json"))!
    const snapshot = JSON.parse(await readFile(join(path, name), "utf8"))
    await writeFile(join(path, name), JSON.stringify({ ...snapshot, workspace: "wrong-workspace" }), "utf8")
    await expect(openInteractionPersistence(path, path)).rejects.toThrow(/restore pending interactions/)
    await writeFile(join(path, name), "{broken", "utf8")
    await expect(openInteractionPersistence(path, path)).rejects.toThrow(/restore pending interactions/)
  })
})
