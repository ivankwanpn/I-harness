import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_FORMAT_VERSION, deriveMessages, type SessionEvent } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator, SessionFormatUnsupportedError } from "../src/index.ts"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const events = (): SessionEvent[] => [
  { type: "conversation/semantics", version: 1, mode: "accepted-exchange-v1", seq: 0 },
  { type: "turn/start", seq: 1 }, { type: "step/start", actionId: "a", attemptId: "p", seq: 2 },
  { type: "tool/call", callId: "c", name: "write", args: {}, seq: 3 },
  { type: "assistant/message", text: "", seq: 4 },
  { type: "model/exchange-accepted", version: 1, exchangeId: "e", actionId: "a", attemptId: "p", stepStartSeq: 2, assistantSeq: 4, callSeqs: [3], seq: 5 },
]
async function fixture(prefix: SessionEvent[] = [], version = 3) {
  const root = await mkdtemp(join(tmpdir(), "accepted-format-")); roots.push(root)
  const path = join(root, "s.jsonl")
  await writeFile(path, JSON.stringify({ sessionId: "s", formatVersion: version, createdAt: "x", extension: "keep" }) + "\n" + prefix.map(event => JSON.stringify(event) + "\n").join(""))
  const backend = createJsonlBackend(root)
  return { path, backend, coordinator: createSessionCoordinator(backend, { maxDelayMs: 60000 }) }
}
it("admits acceptance references into an earlier durable batch", async () => {
  const { coordinator, backend } = await fixture()
  await coordinator.append("s", events().slice(0, 5))
  await coordinator.append("s", events().slice(5))
  expect((await coordinator.snapshot!("s")).session.events).toEqual(events())
  expect((await backend.profile("s")).meta.formatVersion).toBe(4)
  await coordinator.close()
})
it("rejects malformed complete format3 before any repair, retaining cause", async () => {
  const broken = events(); broken[5] = { ...broken[5], assistantSeq: 3 } as SessionEvent
  const { coordinator, backend, path } = await fixture(broken)
  const raw = await readFile(path, "utf8"), repair = vi.spyOn(backend, "repair")
  const error = await coordinator.loadOwned("s").catch(error => error)
  expect(error).toBeInstanceOf(SessionFormatUnsupportedError)
  expect(error.cause).toMatchObject({ code: "SESSION_CONVERSATION_FORMAT" })
  expect(repair).not.toHaveBeenCalled(); expect(await readFile(path, "utf8")).toBe(raw)
  await coordinator.close()
})
it("fenced recovery appends truthful results without shifting any accepted reference", async () => {
  const prefix = [...events(), { type: "tool/dispatch", callId: "c", eventSeq: 3, seq: 6 }, { type: "step/end", seq: 7 }, { type: "turn/end", seq: 8 }] as SessionEvent[]
  const { coordinator, backend } = await fixture(prefix)
  const loaded = await coordinator.loadOwned("s")
  expect(loaded.session.events.slice(0, prefix.length)).toEqual(prefix)
  expect(loaded.session.events[prefix.length]).toMatchObject({ type: "tool/result", seq: 9, isError: true, output: { code: "TOOL_OUTCOME_UNKNOWN", replay: false } })
  const raw = (await backend.read("s")).events
  await coordinator.loadOwned("s")
  expect((await backend.read("s")).events).toEqual(raw)
  expect(deriveMessages(loaded.session)).toHaveLength(2)
  await coordinator.close()
})
it("upgrades format2 header to3 preserving exact body before new facts", async () => {
  const { coordinator, path } = await fixture([{ type: "user/message", text: "legacy", seq: 0 }], 2)
  const before = await readFile(path, "utf8")
  await coordinator.loadOwned("s")
  const after = await readFile(path, "utf8")
  expect(JSON.parse(after.split("\n")[0]!)).toMatchObject({ formatVersion: CURRENT_FORMAT_VERSION, extension: "keep" })
  expect(after.slice(after.indexOf("\n") + 1)).toBe(before.slice(before.indexOf("\n") + 1))
  await coordinator.close()
})
it("rereads an uncertain append and does not duplicate an accepted record", async () => {
  const { coordinator, backend } = await fixture(events().slice(0, 5))
  const append = backend.append.bind(backend)
  let fault = true
  backend.append = async (id, batch) => { await append(id, batch); if (fault) { fault = false; throw new Error("uncertain") } }
  coordinator.enqueue("s", events().slice(5))
  await expect(coordinator.flush("s")).rejects.toThrow("uncertain")
  await coordinator.flush("s")
  expect((await backend.read("s")).events).toEqual(events())
  await coordinator.close()
})
it.each([3, 4, 5, 6, 7])("recovers a crash after prefix length %s without accepting failed fragments or shifting old coordinates", async length => {
  const all = [...events(), { type: "tool/dispatch", callId: "c", eventSeq: 3, seq: 6 }] as SessionEvent[]
  const prefix = all.slice(0, length)
  const { coordinator, backend, path } = await fixture(prefix)
  const before = await readFile(path, "utf8")
  await coordinator.snapshot!("s")
  expect(await readFile(path, "utf8")).toBe(before)
  const loaded = await coordinator.loadOwned("s")
  expect(loaded.session.events.slice(0, length)).toEqual(prefix)
  const after = await readFile(path, "utf8")
  expect(after.slice(after.indexOf("\n") + 1).startsWith(before.slice(before.indexOf("\n") + 1))).toBe(true)
  expect(loaded.session.events.filter(event => event.type === "model/exchange-accepted")).toHaveLength(length >= 6 ? 1 : 0)
  expect(deriveMessages(loaded.session)).toHaveLength(length >= 6 ? 2 : 0)
  const once = (await backend.read("s")).events
  await coordinator.loadOwned("s")
  expect((await backend.read("s")).events).toEqual(once)
  await coordinator.close()
})
it("rejects actual future format5 before repairing its file", async () => {
  const { coordinator, backend, path } = await fixture([], 5)
  const raw = await readFile(path, "utf8"), repair = vi.spyOn(backend, "repair")
  await expect(coordinator.loadOwned("s")).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
  expect(repair).not.toHaveBeenCalled(); expect(await readFile(path, "utf8")).toBe(raw)
  await coordinator.close()
})
