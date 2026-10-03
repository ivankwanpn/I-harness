import { afterEach, expect, it } from "vitest"
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { projectFilesFixture } from "./project-files-fixture.ts"
import { EditorDraftStore } from "../src/renderer/review/editor-drafts.ts"
import type { EditableSource, ReviewSaveResult } from "../src/renderer/review/SourceFileEditor.tsx"
import { dispatchProjectFilesRequest } from "../src/main/project-files.ts"

const fixtures: Awaited<ReturnType<typeof projectFilesFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.dispose(); await rm(f.home, { recursive: true, force: true }) } })
async function fixture() { const f = await projectFilesFixture(); fixtures.push(f); return f }

it("resolves session authority, edits the second root only, and restores CAS/CRLF/BOM drafts on restart", async () => {
  const f = await fixture(), ref = { workspaceId: f.second.id, path: "same.txt" }
  await writeFile(join(f.second.path, ref.path), "\uFEFFsecond\r\n")
  const roots = await f.request({ ...f.selection, kind: "desktop/project-files/roots" })
  expect(roots).toMatchObject({ projectId: f.project.id, roots: [{ workspaceId: f.first.id, label: "first" }, { workspaceId: f.second.id, label: "second" }] })
  const storage = new Map<string, string>(), persistence = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
  const store = new EditorDraftStore(persistence)
  const source = await f.request({ ...f.selection, kind: "desktop/project-files/read", ref }) as EditableSource
  store.open(ref); store.ingest(ref, source); store.edit(ref, "edited second\n"); store.close(ref, "keep")
  const restarted = new EditorDraftStore(persistence)
  expect(restarted.get(ref)?.ref).toEqual({ workspaceId: f.second.id, path: "same.txt" })
  expect(restarted.get(ref)?.revision).toBe(source.kind === "text" ? source.revision : "missing")
  restarted.open(ref)
  expect((await restarted.save(ref, async (text, expectedRevision) => await f.request({ ...f.selection, kind: "desktop/project-files/save", ref, text, expectedRevision }) as ReviewSaveResult)).kind).toBe("saved")
  expect(await readFile(join(f.first.path, "same.txt"), "utf8")).toBe("first")
  expect(await readFile(join(f.second.path, "same.txt"), "utf8")).toBe("\uFEFFedited second\r\n")
})

it("retains original revision and draft on external modification; explicitly adopted external base still uses CAS", async () => {
  const f = await fixture(), ref = { workspaceId: f.second.id, path: "same.txt" }, store = new EditorDraftStore()
  store.ingest(ref, await f.request({ ...f.selection, kind: "desktop/project-files/read", ref }) as EditableSource)
  store.edit(ref, "my draft")
  const revision = store.get(ref)!.revision
  await writeFile(join(f.second.path, "same.txt"), "external")
  const save = (text: string, expectedRevision: string) => f.request({ ...f.selection, kind: "desktop/project-files/save", ref, text, expectedRevision }) as Promise<ReviewSaveResult>
  expect(await store.save(ref, save)).toEqual({ kind: "conflict" })
  expect(store.get(ref)).toMatchObject({ text: "my draft", revision })
  store.ingest(ref, await f.request({ ...f.selection, kind: "desktop/project-files/read", ref }) as EditableSource)
  expect(store.get(ref)?.external?.text).toBe("external")
  store.rebase(ref)
  expect(store.get(ref)?.text).toBe("my draft")
  expect((await store.save(ref, save)).kind).toBe("saved")
  expect(await readFile(join(f.second.path, "same.txt"), "utf8")).toBe("my draft")
})

it("rejects a withdrawn root before target routing and after runtime startup", async () => {
  const f = await fixture(), ref = { workspaceId: f.second.id, path: "same.txt" }
  f.beforeGet(async (id) => { if (id === f.second.id) await f.projects.save({ id: f.project.id, name: "Only first", workspaceIds: [f.first.id] }) })
  await expect(f.request({ ...f.selection, kind: "desktop/project-files/read", ref })).rejects.toThrow(/membership changed/i)
  await expect(f.request({ ...f.selection, kind: "desktop/project-files/save", ref, text: "bad", expectedRevision: "a".repeat(64) })).rejects.toThrow(/current project member/i)
  expect(await readFile(join(f.second.path, "same.txt"), "utf8")).toBe("second")
})

it("rejects read results whose membership is revoked while awaiting their response", async () => {
  const f = await fixture()
  f.afterRequest(async (method) => { if (method.endsWith("/read")) await f.projects.save({ id: f.project.id, name: "Only first", workspaceIds: [f.first.id] }) })
  await expect(f.request({ ...f.selection, kind: "desktop/project-files/read", ref: { workspaceId: f.second.id, path: "same.txt" } })).rejects.toThrow(/membership changed/i)
})

it("reads an explicit external alias readonly while refusing alias saves, traversal and malformed refs", async () => {
  const f = await fixture()
  await symlink(f.second.path, join(f.first.path, "escape"), process.platform === "win32" ? "junction" : "dir")
  await expect(f.files.get(f.first.id)!.list("escape")).rejects.toThrow(/real directory/i)
  expect(await f.files.get(f.first.id)!.read("escape/same.txt")).toMatchObject({ kind: "text", text: "second", readonly: true, external: true })
  await expect(f.files.get(f.first.id)!.save("escape/same.txt", "never write outside", "a".repeat(64))).rejects.toThrow(/symlink/i)
  expect(await readFile(join(f.second.path, "same.txt"), "utf8")).toBe("second")
  await expect(f.files.get(f.first.id)!.list("../second")).rejects.toThrow(/escapes/i)
  await expect(f.files.get(f.first.id)!.search("same")).resolves.toMatchObject({ entries: [{ path: "same.txt" }] })
  await expect(dispatchProjectFilesRequest({ ...f.selection, kind: "desktop/project-files/read", ref: { workspaceId: f.second.id, path: resolve(f.second.path, "same.txt") } }, f.dependencies)).rejects.toThrow(/path/i)
})

it("never turns missing, binary, or incomplete reads into editable new files", async () => {
  const f = await fixture(), files = f.files.get(f.second.id)!, store = new EditorDraftStore()
  const missing = await files.read("missing.txt")
  expect(missing.kind).toBe("unavailable")
  store.ingest({ workspaceId: f.second.id, path: "missing.txt" }, missing)
  expect(store.get({ workspaceId: f.second.id, path: "missing.txt" })).toBeUndefined()
  expect(await files.save("missing.txt", "new", "a".repeat(64))).toMatchObject({ kind: "unavailable", reason: "not-found" })
  await writeFile(join(f.second.path, "binary.dat"), Buffer.from([1, 0, 2]))
  expect(await files.read("binary.dat")).toMatchObject({ kind: "unavailable", reason: "binary" })
  await writeFile(join(f.second.path, "large.txt"), "x".repeat(300000))
  const large = await files.read("large.txt")
  expect(large).toMatchObject({ kind: "text", truncated: true })
  store.ingest({ workspaceId: f.second.id, path: "large.txt" }, large)
  expect(store.get({ workspaceId: f.second.id, path: "large.txt" })).toBeUndefined()
})

it("lists and searches paged filenames, skips private metadata and bounds a large scan", async () => {
  const f = await fixture(), files = f.files.get(f.second.id)!
  await mkdir(join(f.second.path, "nested")); await mkdir(join(f.second.path, ".git"))
  await writeFile(join(f.second.path, "nested", "visible.txt"), "visible"); await writeFile(join(f.second.path, ".git", "hidden.txt"), "secret")
  await f.seedFiles(f.second.id, Array.from({ length: 110 }, (_, n) => `file-${String(n).padStart(4, "0")}.txt`))
  const first = await files.list("", 0), second = await files.list("", first.nextOffset!)
  expect(first.entries.length).toBe(100); expect(first.nextOffset).toBe(100)
  expect(second.entries.length).toBe(12); expect(second.nextOffset).toBeNull()
  expect(first.entries[0]).toMatchObject({ path: "nested", kind: "directory" })
  expect(await files.search("visible")).toMatchObject({ entries: [{ path: "nested/visible.txt", kind: "file" }] })
  expect((await files.search("hidden")).entries).toEqual([])
  await f.seedFiles(f.second.id, Array.from({ length: 3001 }, (_, n) => `bounded-${n}.txt`))
  expect(await files.search("bounded", 2900)).toMatchObject({ truncated: true })
}, 30000)
