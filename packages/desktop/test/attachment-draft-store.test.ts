import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AttachmentDraftStore } from "../src/main/attachment-draft-store.ts"
import type { UnsentDraft } from "../src/shared/attachment-drafts.ts"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const scope = { workspaceId: "workspace-a", identity: "new-task:project-a" }
const draft = (prompt = "unsent marker"): UnsentDraft => ({ prompt, references: ["src/main.ts"], images: [{ id: 7, mediaType: "image/png", name: "image.png", dataBase64: "iVBORw0KGgo=" }], texts: [{ id: 9, name: "snapshot.pdf", text: "attachment marker", contentType: "application/pdf", truncated: true, reason: "page limit" }], contextRefs: [] })
function fixture(options = {}) { const root = mkdtempSync(join(tmpdir(), "ih-drafts-")); roots.push(root); return { root, store: new AttachmentDraftStore(join(root, "owned"), options) } }
describe("main-owned durable unsent drafts", () => {
  it("permanently retires exactly the deleted session and fences queued saves across restart and expiry", async () => {
    let now = 1000
    const { root, store } = fixture({ now: () => now, lifetimeMs: 100 })
    const deleted = { ...scope, identity: "deleted-session" }, sibling = { ...scope, identity: "sibling" }
    const payload = { ...draft(), contextRefs: [{ kind: "file" as const, workspaceId: scope.workspaceId, path: "src/main.ts", label: "source" }] }
    const saved = await store.save(deleted, null, payload)
    const other = await store.save(sibling, null, draft("sibling")); const newTask = await store.save(scope, null, draft("new task"))
    const retirement = store.retire(deleted)
    const lateSave = store.save(deleted, saved.revision, payload)
    const lateClear = store.clear(deleted, saved.revision)
    await retirement
    await expect(lateSave).rejects.toThrow(/retired/); await expect(lateClear).rejects.toThrow(/retired/)
    expect(await store.load(deleted)).toEqual({ revision: null, draft: null })
    expect(await store.load(sibling)).toEqual(other); expect(await store.load(scope)).toEqual(newTask)
    expect(JSON.stringify(readdirSync(join(root, "owned")).filter(name => name.endsWith(".json")))).not.toContain("deleted-session")
    now = 1300
    const restarted = new AttachmentDraftStore(join(root, "owned"), { now: () => now, lifetimeMs: 100 })
    expect(await restarted.load(deleted)).toEqual({ revision: null, draft: null })
    await expect(restarted.save(deleted, null, payload)).rejects.toThrow(/retired/)
  })
  it("restores prompt/images/readable snapshots/references from a fresh store after restart", async () => {
    const { root, store } = fixture(), saved = await store.save(scope, null, draft())
    const restored = await new AttachmentDraftStore(join(root, "owned")).load(scope)
    expect(restored).toEqual(saved); expect(restored.draft?.texts[0]?.text).toBe("attachment marker")
    expect(readdirSync(join(root, "owned")).every((name) => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true)
    expect(await store.load({ ...scope, workspaceId: "workspace-b" })).toEqual({ revision: null, draft: null })
  })
  it("keeps newer edits when old admission tries to clear a previous revision", async () => {
    const { store } = fixture(), first = await store.save(scope, null, draft("first")), second = await store.save(scope, first.revision, draft("newer"))
    await expect(store.clear(scope, first.revision)).rejects.toThrow(/changed|revision|conflict/i)
    expect((await store.load(scope)).draft?.prompt).toBe("newer")
    const clear = await store.clear(scope, second.revision)
    expect(clear.draft).toBeNull()
    await expect(store.save(scope, second.revision, draft("late writer"))).rejects.toThrow(/changed|revision|conflict/i)
  })
  it("serializes simultaneous writes and refuses a stale revision", async () => {
    const { store } = fixture()
    const writes = await Promise.allSettled([store.save(scope, null, draft("first")), store.save(scope, null, draft("second"))])
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1)
  })
  it("refuses quota overflow without evicting current unsent drafts", async () => {
    const { store } = fixture({ quotaBytes: 1800 }), first = await store.save(scope, null, draft())
    await expect(store.save({ ...scope, identity: "session-b" }, null, draft("x".repeat(1500)))).rejects.toThrow(/quota/i)
    expect(await store.load(scope)).toEqual(first)
  })
  it("expires only owned stale drafts and leaves unrelated files intact", async () => {
    let now = 1000
    const { root, store } = fixture({ now: () => now, lifetimeMs: 100 })
    await store.save(scope, null, draft()); writeFileSync(join(root, "owned", "unrelated.txt"), "keep")
    now = 1200
    expect(await store.load(scope)).toEqual({ revision: null, draft: null })
    expect(readdirSync(join(root, "owned"))).toEqual(["unrelated.txt"])
  })
  it("rejects unsafe references and a linked draft root without touching its destination", async () => {
    const { root, store } = fixture()
    await expect(store.save(scope, null, { ...draft(), references: ["../outside.txt"] })).rejects.toThrow(/reference|path/i)
    const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "sentinel"), "keep")
    symlinkSync(outside, join(root, "linked"), "junction")
    await expect(new AttachmentDraftStore(join(root, "linked")).save(scope, null, draft())).rejects.toThrow(/link|owned|directory/i)
    expect(readdirSync(outside)).toEqual(["sentinel"])
  })
})
