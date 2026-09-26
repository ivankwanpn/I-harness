import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createFileProviderRuntime } from "../src/file-runtime.ts"

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
it("releases shared settings locks while a provider network probe waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-provider-probe-")); roots.push(root)
  const options = { settingsPath: join(root, "settings.json"), credentialsPath: join(root, "credentials.json") }
  const a = createFileProviderRuntime(options); const b = createFileProviderRuntime(options)
  await a.createProvider("probe", { protocol: "openai-completions", baseURL: "https://example.invalid" })
  await a.setApiKey("probe", "test-fixture-key")
  let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve })
  let respond!: (response: Response) => void
  vi.stubGlobal("fetch", vi.fn(() => { started(); return new Promise<Response>((resolve) => { respond = resolve }) }))
  const probe = a.probeModels("probe")
  await entered
  const write = b.createProvider("other", { protocol: "gemini" })
  let timer!: ReturnType<typeof setTimeout>
  const winner = await Promise.race([write.then(() => "write"), new Promise<string>((resolve) => { timer = setTimeout(() => resolve("blocked"), 2000) })])
  clearTimeout(timer)
  respond(new Response(JSON.stringify({ data: [{ id: "m" }] }), { headers: { "content-type": "application/json" } }))
  await Promise.all([write, probe])
  expect(winner).toBe("write")
})
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

