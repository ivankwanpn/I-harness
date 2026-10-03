import { expect, it } from "vitest"
import { EditorDraftStore } from "../src/renderer/review/editor-drafts.ts"
const ref = { workspaceId: "root", path: "file.txt" }
const source = { kind: "text" as const, text: "original", truncated: false, bytes: 8, revision: "a".repeat(64) }

it("keeps late edits when an earlier snapshot finishes saving", async () => {
  const store = new EditorDraftStore()
  store.ingest(ref, source); store.edit(ref, "snapshot")
  let finish: ((value: { kind: "saved"; revision: string; bytes: number }) => void) | undefined
  const pending = store.save(ref, () => new Promise((resolve) => { finish = resolve }))
  store.edit(ref, "typed during save")
  finish!({ kind: "saved", revision: "b".repeat(64), bytes: 8 })
  await pending
  expect(store.get(ref)).toMatchObject({ text: "typed during save", original: "snapshot", revision: "b".repeat(64) })
})

it("does not delete or change a persisted draft if saving throws", async () => {
  const store = new EditorDraftStore()
  store.ingest(ref, source); store.edit(ref, "my draft")
  await expect(store.save(ref, async () => { throw new Error("Offline") })).rejects.toThrow("Offline")
  expect(store.get(ref)).toMatchObject({ text: "my draft", original: "original", revision: "a".repeat(64) })
})

it("reports failed restart persistence while retaining the editable draft in memory", () => {
  const store = new EditorDraftStore({ getItem: () => null, setItem: () => { throw new Error("quota exceeded") } })
  store.ingest(ref, source); store.edit(ref, "still here")
  expect(store.get(ref)?.text).toBe("still here")
  expect(store.getSnapshot().persistenceError).toContain("quota exceeded")
})

it("rejects corrupt restored identities and partial revisions", () => {
  const raw = JSON.stringify({ drafts: { bogus: { ...source, ref, original: "original", crlf: false, bom: false } }, tabs: [] })
  const store = new EditorDraftStore({ getItem: () => raw, setItem: () => {} })
  expect(store.get(ref)).toBeUndefined()
  store.ingest(ref, { ...source, revision: "partial" })
  expect(store.get(ref)).toBeUndefined()
})
