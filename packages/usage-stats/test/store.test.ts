import { afterEach, expect, it } from "vitest"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as storage from "../src/store.js"
import type { UsageQuery, UsageRecord } from "../src/types.js"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))) })
async function directory() { const d = await mkdtemp(join(tmpdir(), "ih-usage-test-")); directories.push(d); return d }
const query: UsageQuery = { start: 0, end: 86_400_000, timeZone: "UTC" }
function record(id: string): UsageRecord { return { id, startedAt: 1, durationMs: 10, workspace: "w", providerId: "p", modelId: "m", billing: "api", status: "completed" } }

it("persists concurrent writes from independent stores and survives reopen", async () => {
  expect(storage.createUsageStore).toBeTypeOf("function")
  const d = await directory(), a = storage.createUsageStore(d), b = storage.createUsageStore(d)
  await Promise.all(Array.from({ length: 80 }, (_, i) => (i % 2 ? a : b).record(record(String(i)))))
  const snapshot = await storage.createUsageStore(d).query(query)
  expect(snapshot.summary.requests).toBe(80)
  expect(snapshot.totalRecords).toBe(80)
  expect(snapshot.warnings).toEqual([])
})
it("deduplicates concurrent same IDs and refuses immutable ID collisions", async () => {
  const d = await directory(), stores = [storage.createUsageStore(d), storage.createUsageStore(d)]
  await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].record(record("same/../id"))))
  await expect(stores[0].record({ ...record("same/../id"), status: "failed" })).rejects.toThrow(/collision/i)
  expect((await stores[1].query(query)).summary).toMatchObject({ requests: 1, completed: 1 })
})
it("stores allowlisted metadata only and surfaces corrupted records without erasing healthy ones", async () => {
  const d = await directory(), store = storage.createUsageStore(d)
  await store.record({ ...record("a"), prompt: "SECRET PROMPT", apiKey: "SECRET KEY" } as UsageRecord)
  const files = await readdir(join(d, "records"))
  expect(await readFile(join(d, "records", files[0]), "utf8")).not.toContain("SECRET")
  await writeFile(join(d, "records", "broken.json"), "{")
  const snapshot = await store.query(query)
  expect(snapshot.summary.requests).toBe(1)
  expect(snapshot.warnings.some(w => /corrupt|unreadable/i.test(w))).toBe(true)
})
it("persists model price updates independently without losing another model", async () => {
  const d = await directory(), a = storage.createUsageStore(d), b = storage.createUsageStore(d)
  const price = { providerId: "p", modelId: "m", inputPerMillion: 1, outputPerMillion: 2, source: "Manual pricing", updatedAt: 1 }
  await Promise.all([a.setPricing(price), b.setPricing({ ...price, modelId: "other" })])
  await a.setPricing({ ...price, inputPerMillion: 3, updatedAt: 2 })
  const snapshot = await storage.createUsageStore(d).query(query)
  expect(snapshot.prices).toHaveLength(2)
  expect(snapshot.prices.find(p => p.modelId === "m")?.inputPerMillion).toBe(3)
  await expect(a.setPricing({ ...price, source: "" })).rejects.toThrow()
})
it("warns when a persisted measurement becomes contradictory and retains other records", async () => {
  const d = await directory(), store = storage.createUsageStore(d)
  await store.record(record("healthy"))
  await store.record({ ...record("bad"), inputTokens: 1, cacheReadTokens: 1, inputTokenSemantics: "includes-cache" })
  for (const name of await readdir(join(d, "records"))) {
    const path = join(d, "records", name), data = JSON.parse(await readFile(path, "utf8"))
    if (data.id === "bad") await writeFile(path, JSON.stringify({ ...data, cacheReadTokens: 2 }))
  }
  const snapshot = await store.query(query)
  expect(snapshot.records.map(r => r.id)).toEqual(["healthy"])
  expect(snapshot.warnings).toHaveLength(1)
})
