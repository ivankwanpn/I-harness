import { afterEach, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentSettings } from "../src/agent-settings.ts"
import { createFileProviderRuntime } from "@i-harness/provider-runtime/file"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it("persists only supported defaults without claiming the running sandbox changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-agent-settings-")); roots.push(root)
  const path = join(root, "settings.json")
  await writeFile(path, JSON.stringify({ sandboxMode: "read-only", compaction: { auto: true } }))
  const settings = createAgentSettings(path, { sandboxMode: "read-only", autoCompaction: true })
  const provider = createFileProviderRuntime({ settingsPath: path, credentialsPath: join(root, "credentials.json") })
  await Promise.all([
    settings.configure({ sandboxMode: "workspace-write", autoCompaction: false }),
    provider.createProvider("test", { protocol: "openai-completions" }),
  ])
  expect(await settings.state()).toMatchObject({ saved: { sandboxMode: "workspace-write", autoCompaction: false }, effective: { sandboxMode: "read-only", autoCompaction: true }, restartRequired: true })
  const raw = JSON.parse(await readFile(path, "utf8"))
  expect(raw.llm.providers.test).toBeTruthy()
  await expect(settings.configure({ autoCompaction: "false" })).rejects.toThrow()
  await expect(settings.configure({ unknown: true })).rejects.toThrow()
})

it("refuses to replace damaged configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-agent-settings-")); roots.push(root)
  const path = join(root, "settings.json")
  await writeFile(path, "{broken")
  const settings = createAgentSettings(path, { sandboxMode: "read-only", autoCompaction: true })
  await expect(settings.configure({ autoCompaction: false })).rejects.toThrow()
  expect(await readFile(path, "utf8")).toBe("{broken")
})
