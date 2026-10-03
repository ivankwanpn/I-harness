import { afterEach, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProjectContentSearch, dispatchGatewayContentSearch } from "../src/project-content-search.ts"
import { openPinnedFileForReview } from "../src/review-handle.ts"

const owned: { home: string; service: ReturnType<typeof createProjectContentSearch> }[] = []
afterEach(async () => { for (const row of owned.splice(0)) { await row.service.close(); await rm(row.home, { recursive: true, force: true }) } })
async function fixture() { const home = await mkdtemp(join(tmpdir(), "ih-content-search-")), service = createProjectContentSearch(home); owned.push({ home, service }); return { home, service } }

it("uses actual stdin regex validation for an empty tree and distinguishes complete emptiness", async () => {
  const f = await fixture()
  expect(await f.service.search({ requestId: "empty", query: { pattern: "absent" } })).toMatchObject({ status: "completed", partial: false, matches: [], stats: { candidateFiles: 0, readFiles: 0 } })
  expect(await f.service.search({ requestId: "invalid", query: { pattern: "[" } })).toMatchObject({ status: "error", partial: true, matches: [], stats: { candidateFiles: 0, readFiles: 0 } })
})

it("feeds only reserved file prefixes to the real matcher and reports input incompleteness", async () => {
  const f = await fixture()
  for (const name of ["a", "b", "c", "d"]) await writeFile(join(f.home, name), "needle....outside-this-prefix")
  const result = await dispatchGatewayContentSearch("desktop/project-files/content-search", { requestId: "prefix", query: { pattern: "needle", mode: "literal" }, limits: { maxInputBytes: 15, maxFileBytes: 10 } }, f.service)
  expect(result).toMatchObject({ status: "limited", partial: true, stats: { inputBytes: 15, attemptedFiles: 2, readFiles: 2, eofFiles: 0 }, filters: { ignorePolicy: "pinned-project-local" } })
  expect((result as { matches: unknown[] }).matches.length).toBe(1)
})

it("applies include/exclude/hidden and project ignore to actual candidate bytes", async () => {
  const f = await fixture(); await mkdir(join(f.home, "sub"))
  for (const name of ["visible.txt", "ignored.txt", ".hidden.txt", "sub/visible.txt"]) await writeFile(join(f.home, name), "Needle  \t\r\n")
  await writeFile(join(f.home, ".gitignore"), "ignored.txt\n")
  const normal = await f.service.search({ requestId: "filters", query: { pattern: "needle", mode: "literal", case: "insensitive", includes: ["*.txt"], excludes: ["sub/**"] } })
  expect(normal).toMatchObject({ status: "completed", partial: false, matches: [{ path: "visible.txt", text: "Needle  \t", column: 0, endColumn: 6 }], stats: { candidateFiles: 1 } })
  const widened = await f.service.search({ requestId: "widen", query: { pattern: "Needle", hidden: true, respectIgnore: false, includes: ["*.txt"], excludes: ["sub/**"] } })
  expect(widened.matches.map(row => row.path).sort()).toEqual([".hidden.txt", "ignored.txt", "visible.txt"])
})

it("bounds serialized human metadata and rows under a lowered result byte ceiling", async () => {
  const f = await fixture(); await writeFile(join(f.home, "many.txt"), Array.from({ length: 100 }, () => `needle ${"漢".repeat(400)}`).join("\n"))
  const result = await f.service.search({ requestId: "bytes", query: { pattern: "needle", maxResults: 1000, maxResultBytes: 4096 } })
  expect(result.status).toBe("limited"); expect(result.partial).toBe(true); expect(result.truncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
  expect(result.reasons).toContain("result-byte-limit")
})

it("includes large effective filter metadata in the same lowered serialized ceiling", async () => {
  const f = await fixture()
  const result = await f.service.search({ requestId: "metadata", query: { pattern: "absent", includes: Array.from({ length: 8 }, () => "漢".repeat(512)), maxResultBytes: 4096 } })
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
  expect(result).toMatchObject({ partial: true, truncated: true, filters: { filterPatternsTruncated: true } })
})

it("cancels before startup, and close drains an owned pinned read without later results", async () => {
  const f = await fixture(); await writeFile(join(f.home, "same.txt"), "needle")
  const early = f.service.search({ requestId: "early", query: { pattern: "needle" } }), cancel = f.service.cancel("early")
  expect(await early).toMatchObject({ status: "cancelled", partial: true, matches: [], stats: { inputBytes: 0 } }); expect(await cancel).toEqual({ cancelled: true })
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const service = createProjectContentSearch(f.home, { async openFile(path) { const handle = await openPinnedFileForReview(path); return { ...handle, async read(limit) { started.resolve(); await release.promise; return handle.read(limit) } } } })
  owned.push({ home: await mkdtemp(join(tmpdir(), "ih-content-search-empty-")), service })
  const search = service.search({ requestId: "close", query: { pattern: "needle" } })
  await started.promise
  const close = service.close(); release.resolve(); await close
  expect(await search).toMatchObject({ status: "cancelled", partial: true, matches: [] })
  await expect(service.search({ requestId: "after-close", query: { pattern: "needle" } })).rejects.toThrow(/closing/i)
})

it("closes and rejects readonly preview work when the service shuts down during capture", async () => {
  const f = await fixture(); await writeFile(join(f.home, "same.txt"), "needle")
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const service = createProjectContentSearch(f.home, { async openFile(path) { const handle = await openPinnedFileForReview(path); return { ...handle, async read(limit) { started.resolve(); await release.promise; return handle.read(limit) } } } })
  const preview = service.preview({ path: "same.txt", line: 1 }).then(value => value, error => error)
  await started.promise
  const close = service.close(); release.resolve(); await close
  expect(await preview).toBeInstanceOf(Error)
})

it("discloses replacement decoding for invalid UTF8 and incomplete UTF16 preview bytes", async () => {
  const f = await fixture()
  await writeFile(join(f.home, "invalid.txt"), Buffer.from([0x61, 0xff, 0x62])); await writeFile(join(f.home, "odd.txt"), Buffer.from([0x61, 0x00, 0x62]))
  expect(await f.service.preview({ path: "invalid.txt", line: 1, encoding: "utf8" })).toMatchObject({ readonly: true, text: "a�b", reason: expect.stringMatching(/invalid.*replacement/i) })
  expect(await f.service.preview({ path: "odd.txt", line: 1, encoding: "utf16le" })).toMatchObject({ readonly: true, text: "a�", reason: expect.stringMatching(/invalid.*replacement/i) })
})
