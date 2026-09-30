import { afterEach, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSubagentSettings } from "../src/subagent-settings.ts"
const roots: string[] = []
it("applies model-selection enablement without restarting the host", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-role-live-")); roots.push(root)
  const path = join(root, "settings.json")
  let enabled = false
  const roles = createSubagentSettings(path, false, { onEnabledChanged: (next) => { enabled = next } })
  expect(await roles.mutate({ action: "enable", enabled: true })).toMatchObject({ effectiveEnabled: true, restartRequired: false })
  expect(enabled).toBe(true)
  await writeFile(path, JSON.stringify({ plugins: { subagentModel: false } }))
  expect(await roles.state()).toMatchObject({ effectiveEnabled: false, restartRequired: false })
  expect(enabled).toBe(false)
})
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it("preserves independent role mappings and reads edits at the next selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-role-settings-")); roots.push(root)
  const path = join(root, "settings.json")
  await writeFile(path, JSON.stringify({ plugins: { bash: false }, agents: { roles: { worker: { provider: "p", model: "worker" } } } }))
  const roles = createSubagentSettings(path, false)
  expect((await roles.state()).roles).toContainEqual(expect.objectContaining({ name: "reviewer" }))
  await roles.mutate({ action: "role/set", role: "explore", selection: { provider: "p", model: "small", reasoningEffort: "low" } })
  expect(roles.selectionFor("explore")).toEqual({ provider: "p", model: "small", reasoningEffort: "low" })
  await roles.mutate({ action: "enable", enabled: true })
  expect(await roles.state()).toMatchObject({ enabled: true, effectiveEnabled: false, restartRequired: true })
  await roles.mutate({ action: "role/clear", role: "explore" })
  expect(roles.selectionFor("explore")).toBeUndefined()
  expect(roles.selectionFor("worker")).toEqual({ provider: "p", model: "worker" })
  const saved = JSON.parse(await readFile(path, "utf8"))
  expect(saved.plugins.bash).toBe(false)
  await expect(roles.mutate({ action: "role/set", role: "__proto__", selection: { provider: "p", model: "x" } })).rejects.toThrow()
})
