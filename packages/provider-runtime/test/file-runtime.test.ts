import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createFileProviderRuntime } from "../src/file-runtime.ts"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
it("preserves independent edits from two runtimes sharing settings and credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-provider-files-")); roots.push(root)
  const options = { settingsPath: join(root, "settings.json"), credentialsPath: join(root, "credentials.json") }
  const a = createFileProviderRuntime(options)
  const b = createFileProviderRuntime(options)
  await Promise.all([
    a.createProvider("route-a", { protocol: "openai-completions" }),
    b.createProvider("route-b", { protocol: "openai-completions" }),
  ])
  await Promise.all([a.setApiKey("route-a", "secret-a"), b.setApiKey("route-b", "secret-b")])
  const rows = await a.directory()
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "route-a", auth: expect.objectContaining({ configured: true }) }),
    expect.objectContaining({ id: "route-b", auth: expect.objectContaining({ configured: true }) }),
  ]))
  const raw = await readFile(options.credentialsPath, "utf8")
  expect(raw).toContain("secret-a"); expect(raw).toContain("secret-b")
})

it("refuses corrupt settings before replacing them with defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-provider-invalid-")); roots.push(root)
  const options = { settingsPath: join(root, "settings.json"), credentialsPath: join(root, "credentials.json") }
  await writeFile(options.settingsPath, "{broken")
  await expect(createFileProviderRuntime(options).createProvider("test", {})).rejects.toThrow("Invalid provider configuration document")
  expect(await readFile(options.settingsPath, "utf8")).toBe("{broken")
})

