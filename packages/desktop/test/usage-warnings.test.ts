import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createUsageWarnings } from "../src/main/usage-warnings.ts"
import { createGlobalProviderSettings } from "../src/main/global-provider-settings.ts"
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it("carries a workspace warning into global queries and across restart without storing event data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ih-usage-warning-")); directories.push(dir)
  const path = join(dir, "warnings.json")
  const warnings = createUsageWarnings(path)
  warnings.observe({ kind: "sdk/notification", workspaceId: "workspace-a", method: "desktop/usage/recording-warning", params: { warnings: ["secret fixture"] } })
  await warnings.flush()
  const reopened = createUsageWarnings(path)
  const service = createGlobalProviderSettings(async () => ({ request: vi.fn(async () => ({ warnings: [], summary: { requests: 3 } })) }), { usageWarnings: reopened.read })
  const result = await service.request({ kind: "desktop/usage/query", query: { start: 0, end: 1, timeZone: "UTC" } }) as any
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toContain("incomplete")
  expect(JSON.stringify(result)).not.toContain("secret")
  await service.close()
})

it("keeps an in-memory warning visible when persistence fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ih-usage-warning-")); directories.push(dir)
  const blocked = join(dir, "blocked"); await writeFile(blocked, "fixture")
  const warnings = createUsageWarnings(join(blocked, "warnings.json"))
  warnings.observe({ kind: "sdk/notification", workspaceId: "a", method: "desktop/usage/recording-warning", params: {} })
  await warnings.flush()
  expect(await warnings.read()).toHaveLength(1)
})

it("ignores unrelated notifications and marks corrupt history unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ih-usage-warning-")); directories.push(dir)
  const path = join(dir, "warnings.json")
  const warnings = createUsageWarnings(path)
  warnings.observe({ kind: "sdk/notification", workspaceId: "a", method: "session/status", params: {} })
  expect(await warnings.read()).toEqual([])
  await writeFile(path, "bad")
  expect((await warnings.read())[0]).toContain("unavailable")
})
