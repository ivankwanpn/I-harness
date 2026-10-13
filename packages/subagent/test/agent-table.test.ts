import { expect, it } from "vitest"
import { createSession } from "@i-harness/core-session"
import { createAgentTable, type ChildAgentEntry } from "../src/agent-table.ts"
import { persistentAgentTable } from "../src/persist.ts"

function entry(): ChildAgentEntry { return { path: "root/child", status: "running", session: createSession(), controller: new AbortController(), mailbox: [] } }
it("publishes coherent patches and session replacement, rejects stale identities and emits removal identity", () => {
  const table = createAgentTable(), original = entry(), replacement = entry()
  const seen: unknown[] = []
  table.subscribe(() => { throw new Error("listener") })
  const off = table.subscribe(change => seen.push({ kind: change.kind, entry: change.entry, status: change.entry.status, text: change.entry.finalText, error: change.entry.error, session: change.entry.session }))
  table.add(original.path, original)
  expect(table.update(original.path, original, { status: "waiting", finalText: "done", error: "details" })).toBe(true)
  const session = createSession()
  table.update(original.path, original, { session })
  expect(seen[1]).toMatchObject({ kind: "update", status: "waiting", text: "done", error: "details" })
  expect(seen[2]).toMatchObject({ session })
  table.add(original.path, replacement)
  expect(table.update(original.path, original, { status: "error" })).toBe(false)
  expect(replacement.status).toBe("running")
  expect(seen).toHaveLength(4)
  table.remove(original.path)
  expect(seen[4]).toMatchObject({ kind: "remove", entry: replacement })
  table.remove(original.path)
  off(); table.add(original.path, original)
  expect(seen).toHaveLength(5)
})
it("persists only successful patches and forwards lifecycle subscriptions", () => {
  let saves = 0, updates = 0
  const raw = createAgentTable(), table = persistentAgentTable(raw, async () => { saves++ }), original = entry()
  table.add(original.path, original)
  const off = table.subscribe(change => { if (change.kind === "update") updates++ })
  expect(table.update(original.path, original, { status: "waiting" })).toBe(true)
  expect(saves).toBe(2)
  expect(updates).toBe(1)
  expect(table.update(original.path, entry(), { status: "error" })).toBe(false)
  expect(saves).toBe(2)
  off()
})
