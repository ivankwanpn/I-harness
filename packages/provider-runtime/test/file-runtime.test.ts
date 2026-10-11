import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createFileProviderRuntime } from "../src/file-runtime.ts"
import { SettingsStore } from "@i-harness/settings"

it("applies a changed retry limit to the next request of an already resolved binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-live-retry-")); roots.push(root)
  const settingsPath = join(root, "settings.json")
  const runtime = createFileProviderRuntime({ settingsPath, credentialsPath: join(root, "credentials.json") })
  await runtime.createProvider("fixture", { protocol: "openai-completions", baseURL: "https://fixture.invalid" })
  await runtime.setApiKey("fixture", "fixture-key")
  const store = new SettingsStore({ path: settingsPath }); await store.load(); await store.set({ modelRetryLimit: 0 })
  const resolved = await runtime.resolveModel({ sessionSelection: { provider: "fixture", model: "m" } })
  if (resolved.status !== "ready") throw new Error("binding unavailable")
  let calls = 0
  vi.stubGlobal("fetch", async () => { calls++; return new Response("private body", { status: 503 }) })
  const run = async () => { for await (const _ of resolved.binding.client.stream({ messages: [], tools: [], systemPrompt: "" })) {} }
  await expect(run()).rejects.toThrow("503"); expect(calls).toBe(1)
  await store.set({ modelRetryLimit: 1 })
  const inFlight = async () => {
    for await (const event of resolved.binding.client.stream({ messages: [], tools: [], systemPrompt: "" })) {
      if (event.type === "retry" && event.retry.phase === "waiting") await store.set({ modelRetryLimit: 0 })
    }
  }
  await expect(inFlight()).rejects.toThrow("503"); expect(calls).toBe(3)
  await expect(run()).rejects.toThrow("503"); expect(calls).toBe(4)
  await writeFile(settingsPath, "{corrupt")
  await expect(run()).rejects.toThrow("Invalid provider configuration document")
  expect(calls).toBe(4)
})

const roots: string[] = []
it("reports the saved default selection separately from route fallback metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-provider-default-ui-")); roots.push(root)
  const runtime = createFileProviderRuntime({ settingsPath: join(root, "settings.json"), credentialsPath: join(root, "credentials.json") })
  await runtime.createProvider("first", { protocol: "openai-completions" })
  await runtime.createProvider("second", { protocol: "openai-completions" })
  await runtime.setDefaultModel({ provider: "first", model: "chosen-first" })
  let rows = await runtime.directory()
  expect(rows.find(row => row.id === "first")).toMatchObject({ selectedDefaultModel: "chosen-first" })
  expect(rows.find(row => row.id === "second")?.selectedDefaultModel).toBeUndefined()
  await runtime.setDefaultModel({ provider: "second", model: "chosen-second" })
  rows = await runtime.directory()
  expect(rows.find(row => row.id === "first")?.selectedDefaultModel).toBeUndefined()
  expect(rows.find(row => row.id === "second")).toMatchObject({ selectedDefaultModel: "chosen-second" })
})
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

