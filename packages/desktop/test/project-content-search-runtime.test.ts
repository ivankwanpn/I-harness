import { afterEach, expect, it } from "vitest"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { projectFilesFixture } from "./project-files-fixture.ts"
import { dispatchDesktopRequest } from "../src/main/ipc.ts"
import { createProjectContentSearch } from "../../desktop-gateway/src/project-content-search.ts"
import { openPinnedFileForReview } from "../../desktop-gateway/src/review-handle.ts"
import { createDesktopProjectContentSearch } from "../src/main/project-content-search.ts"

const fixtures: Awaited<ReturnType<typeof projectFilesFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.dispose(); await rm(f.home, { recursive: true, force: true }) } })

it("searches two actual current roots and preserves exact second-root file and line identity", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  await writeFile(join(f.first.path, "same.txt"), "first\nneedle\n")
  await writeFile(join(f.second.path, "same.txt"), "second\nnot here\n中文😀 needle\n")
  const result = await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "two-roots", query: { pattern: "needle", mode: "literal" } }, f.dependencies)
  expect(result, JSON.stringify(result)).toMatchObject({ status: "completed", partial: false, roots: [{ workspaceId: f.first.id }, { workspaceId: f.second.id }], matches: [
    { ref: { workspaceId: f.first.id, path: "same.txt" }, line: 2, column: 0, endColumn: 6 },
    { ref: { workspaceId: f.second.id, path: "same.txt" }, line: 3, column: 5, endColumn: 11 },
  ] })
})

it("withholds a root revoked during runtime startup and after real search results return", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  await writeFile(join(f.second.path, "same.txt"), "needle")
  f.beforeGet(async id => { if (id === f.second.id) await f.projects.save({ id: f.project.id, name: "Only first", workspaceIds: [f.first.id] }) })
  expect(await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "withdraw-start", workspaceIds: [f.second.id], query: { pattern: "needle" } }, f.dependencies)).toMatchObject({ status: "error", partial: true, matches: [] })
  f.beforeGet(async () => {})
  await f.projects.save({ id: f.project.id, name: "Both", workspaceIds: [f.first.id, f.second.id] })
  f.afterRequest(async method => { if (method === "desktop/project-files/content-search") await f.projects.save({ id: f.project.id, name: "Only first", workspaceIds: [f.first.id] }) })
  expect(await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "withdraw-return", workspaceIds: [f.second.id], query: { pattern: "needle" } }, f.dependencies)).toMatchObject({ status: "error", partial: true, matches: [] })
  await expect(dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/search-preview", ref: { workspaceId: f.second.id, path: "same.txt" }, line: 1 }, f.dependencies)).rejects.toThrow(/current project member/i)
})

it("cancels the captured job after membership withdrawal and rejects a forged cancellation owner", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  await writeFile(join(f.second.path, "same.txt"), "needle")
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  await f.content.get(f.second.id)!.close()
  f.content.set(f.second.id, createProjectContentSearch(f.second.path, { async openFile(path) {
    const handle = await openPinnedFileForReview(path)
    return { ...handle, async read(maxBytes) { started.resolve(); await release.promise; return handle.read(maxBytes) } }
  } }))
  const search = dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "owned-cancel", workspaceIds: [f.second.id], query: { pattern: "needle" } }, f.dependencies)
  await started.promise
  await expect(dispatchDesktopRequest({ workspaceId: f.second.id, kind: "desktop/project-files/content-cancel", requestId: "owned-cancel" }, f.dependencies)).rejects.toThrow(/owner mismatch/i)
  await f.projects.save({ id: f.project.id, name: "Only first", workspaceIds: [f.first.id] })
  const cancellation = dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-cancel", requestId: "owned-cancel" }, f.dependencies)
  release.resolve()
  expect(await cancellation).toEqual({ cancelled: true })
  expect(await search).toMatchObject({ status: "cancelled", partial: true, matches: [] })
  expect(await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-cancel", requestId: "owned-cancel" }, f.dependencies)).toEqual({ cancelled: false })
})

it("keeps limits aggregate and marks later roots unsearched when the result count stops the job", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  for (const entry of [f.first, f.second]) await writeFile(join(entry.path, "same.txt"), "needle\nneedle\n")
  const result = await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "aggregate-results", query: { pattern: "needle", maxResults: 1, maxResultBytes: 4096 } }, f.dependencies)
  expect(result).toMatchObject({ status: "limited", partial: true, truncated: true, matches: [{ ref: { workspaceId: f.first.id, path: "same.txt" } }], stats: { candidateFiles: 1, readFiles: 1 } })
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
})

it("returns a centered bounded readonly UTF16 preview and detects an altered disk snapshot", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const path = "unicode.txt", ref = { workspaceId: f.second.id, path }, text = Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行${index === 40 ? " needle 😀" : ""}`).join("\r\n")
  await writeFile(join(f.second.path, path), Buffer.from(`\uFEFF${text}`, "utf16le"))
  const result = await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "utf16", workspaceIds: [f.second.id], query: { pattern: "needle" } }, f.dependencies) as { matches: { revision: string }[] }
  const preview = await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/search-preview", ref, line: 41, encoding: "auto", expectedRevision: result.matches[0]!.revision }, f.dependencies) as { text: string; startLine: number }
  expect(preview).toMatchObject({ readonly: true, startLine: 21, encoding: "utf16le", changedSinceSearch: false, truncated: true })
  expect(preview.text.split("\n")[41 - preview.startLine]).toBe("第 41 行 needle 😀")
  expect(Buffer.byteLength(preview.text, "utf16le")).toBeLessThanOrEqual(32768)
  await writeFile(join(f.second.path, path), Buffer.from(`\uFEFFchanged\r\n${text}`, "utf16le"))
  expect(await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/search-preview", ref, line: 42, encoding: "auto", expectedRevision: result.matches[0]!.revision }, f.dependencies)).toMatchObject({ readonly: true, changedSinceSearch: true, startLine: 22 })
})

it("searches and reads an outside reference folder without adding a workspace or permitting any save", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const referencePath = join(f.home, "reference-only"); await mkdir(referencePath)
  const utf8 = join(referencePath, "reference.txt"), utf16 = join(referencePath, "unicode.txt")
  await writeFile(utf8, "outside reference\r\nneedle 😀\r\n"); await writeFile(utf16, Buffer.from("\uFEFF參考\r\nneedle 中文\r\n", "utf16le"))
  const before = await f.dependencies.catalog.list(), bytes8 = await readFile(utf8), bytes16 = await readFile(utf16)
  const result = await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "reference", referencePath, query: { pattern: "needle", mode: "literal" } }, f.dependencies) as { roots: unknown[]; matches: { reference: { path: string; readonly: true }; readonly: true; external: true; revision: string }[] }
  expect(result).toMatchObject({ status: "completed", partial: false, roots: [], matches: [
    { reference: { path: utf8, readonly: true }, readonly: true, external: true, line: 2 },
    { reference: { path: utf16, readonly: true }, readonly: true, external: true, line: 2 },
  ] })
  expect(await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/external-read", path: utf8 }, f.dependencies)).toMatchObject({ kind: "text", text: "outside reference\nneedle 😀\n", readonly: true, external: true })
  expect(await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/external-preview", path: utf16, line: 2, encoding: "auto", expectedRevision: result.matches[1]!.revision }, f.dependencies)).toMatchObject({ readonly: true, external: true, encoding: "utf16le", text: "參考\nneedle 中文\n", changedSinceSearch: false })
  await expect(dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/save", ref: { workspaceId: f.first.id, path: utf8 }, text: "never write outside", expectedRevision: result.matches[0]!.revision }, f.dependencies)).rejects.toThrow(/path/i)
  await expect(dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "mixed-authority", referencePath, workspaceIds: [f.first.id], query: { pattern: "needle" } }, f.dependencies)).rejects.toThrow(/mutually exclusive/i)
  expect(await f.dependencies.catalog.list()).toEqual(before)
  expect(await readFile(utf8)).toEqual(bytes8); expect(await readFile(utf16)).toEqual(bytes16)
})

it("makes repeated native shutdown calls wait for the same owned capture drain", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  await f.content.get(f.second.id)!.close()
  f.content.set(f.second.id, createProjectContentSearch(f.second.path, { async openFile(path) { const handle = await openPinnedFileForReview(path); return { ...handle, async read(limit) { started.resolve(); await release.promise; return handle.read(limit) } } } }))
  const manager = createDesktopProjectContentSearch(f.dependencies)
  const search = manager.request({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "native-shutdown", workspaceIds: [f.second.id], query: { pattern: "second" } })
  await started.promise
  const first = manager.close(); let drained = false
  const second = manager.close().then(() => { drained = true })
  try { await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false) }
  finally { release.resolve(); await Promise.all([first, second, search]) }
})

it("preserves actual includes/excludes and bounded metadata truncation flags through native aggregation", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const first = await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "effective-filters", query: { pattern: "first", includes: ["same.txt"], excludes: ["ignored*"] } }, f.dependencies)
  expect(first).toMatchObject({ filters: { includes: ["same.txt"], excludes: ["ignored*"], ignorePrecedence: expect.stringContaining(".rgignore") } })
  const compact = await dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "metadata-filters", query: { pattern: "absent", includes: Array.from({ length: 8 }, () => "漢".repeat(512)), maxResultBytes: 4096 } }, f.dependencies)
  expect(compact).toMatchObject({ filters: { filterPatternsTruncated: true }, partial: true, truncated: true })
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(4096)
})

it("cancels a client-owned preview request and acknowledges only after the pinned read drains", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), cancellationSent = Promise.withResolvers<void>()
  await f.content.get(f.second.id)!.close()
  f.content.set(f.second.id, createProjectContentSearch(f.second.path, { async openFile(path) { const handle = await openPinnedFileForReview(path); return { ...handle, async read(limit) { started.resolve(); await release.promise; return handle.read(limit) } } } }))
  f.beforeRequest(method => { if (method === "desktop/project-files/content-cancel") cancellationSent.resolve() })
  const preview = dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/search-preview", requestId: "owned-preview", ref: { workspaceId: f.second.id, path: "same.txt" }, line: 1 }, f.dependencies).then(value => value, error => error)
  await started.promise
  let acknowledged = false
  const cancellation = dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-cancel", requestId: "owned-preview" }, f.dependencies).then(value => { acknowledged = true; return value })
  try { expect(await Promise.race([cancellationSent.promise.then(() => true), cancellation.then(() => false)])).toBe(true); expect(acknowledged).toBe(false) }
  finally { release.resolve() }
  expect(await cancellation).toEqual({ cancelled: true }); expect(await preview).toBeInstanceOf(Error)
})

it("aborts and drains an active captured search when the real project-save boundary withdraws its root", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), cancellationSent = Promise.withResolvers<void>()
  await f.content.get(f.second.id)!.close()
  f.content.set(f.second.id, createProjectContentSearch(f.second.path, { async openFile(path) { const handle = await openPinnedFileForReview(path); return { ...handle, async read(limit) { started.resolve(); await release.promise; return handle.read(limit) } } } }))
  f.beforeRequest(method => { if (method === "desktop/project-files/content-cancel") cancellationSent.resolve() })
  const search = dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "withdraw-active", workspaceIds: [f.second.id], query: { pattern: "second" } }, f.dependencies)
  await started.promise
  const save = dispatchDesktopRequest({ kind: "projects/save", input: { id: f.project.id, name: "Only first", workspaceIds: [f.first.id] } }, f.dependencies)
  try { expect(await Promise.race([cancellationSent.promise.then(() => true), save.then(() => false)])).toBe(true) }
  finally { release.resolve(); await save }
  expect(await search).toMatchObject({ status: "cancelled", partial: true, matches: [] })
})

it("keeps an unaffected captured search running when only the project name changes", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let cancelled = false
  await f.content.get(f.second.id)!.close()
  f.content.set(f.second.id, createProjectContentSearch(f.second.path, { async openFile(path) { const handle = await openPinnedFileForReview(path); return { ...handle, async read(limit) { started.resolve(); await release.promise; return handle.read(limit) } } } }))
  f.beforeRequest(method => { if (method === "desktop/project-files/content-cancel") cancelled = true })
  const search = dispatchDesktopRequest({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "unaffected", workspaceIds: [f.second.id], query: { pattern: "second" } }, f.dependencies)
  await started.promise
  try { await dispatchDesktopRequest({ kind: "projects/save", input: { id: f.project.id, name: "Renamed", workspaceIds: [f.first.id, f.second.id] } }, f.dependencies); expect(cancelled).toBe(false) }
  finally { release.resolve() }
  expect(await search).toMatchObject({ status: "completed", partial: false, matches: [{ ref: { workspaceId: f.second.id, path: "same.txt" } }] })
})

it("waits for an already-stopped capture to drain when its project root is then withdrawn", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), cancellationSent = Promise.withResolvers<void>()
  await f.content.get(f.second.id)!.close()
  f.content.set(f.second.id, createProjectContentSearch(f.second.path, { async openFile(path) { const handle = await openPinnedFileForReview(path); return { ...handle, async read(limit) { started.resolve(); await release.promise; return handle.read(limit) } } } }))
  f.beforeRequest(method => { if (method === "desktop/project-files/content-cancel") cancellationSent.resolve() })
  const manager = createDesktopProjectContentSearch(f.dependencies)
  const search = manager.request({ ...f.selection, kind: "desktop/project-files/content-search", requestId: "stop-withdraw", workspaceIds: [f.second.id], query: { pattern: "second" } })
  await started.promise
  const stop = manager.request({ ...f.selection, kind: "desktop/project-files/content-cancel", requestId: "stop-withdraw" })
  await cancellationSent.promise
  await f.projects.save({ id: f.project.id, name: "Only first", workspaceIds: [f.first.id] })
  let acknowledged = false
  const changed = manager.scopeChanged().then(() => { acknowledged = true })
  try { await new Promise<void>(resolve => setImmediate(resolve)); expect(acknowledged).toBe(false) }
  finally { release.resolve(); await Promise.all([stop, changed, search]) }
})
