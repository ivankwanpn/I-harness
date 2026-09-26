import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { createManagedPluginRegistry } from "../src/managed.ts"
it("reports missing cache without fetching while reading the Desktop catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-offline-"))
  const managed = createManagedPluginRegistry({ root })
  const fetch = vi.fn(() => { throw new Error("unexpected network") })
  vi.stubGlobal("fetch", fetch)
  try {
    await writeFile(join(root, "state.json"), JSON.stringify({ version: 1, sources: [{ name: "remote", source: "https://example.invalid/marketplace.json", lastUpdated: 1 }], plugins: [] }))
    const sources = await managed.run((registry) => registry.listSources({ fetchMissing: false }))
    expect(sources[0]?.error).toContain("refresh this source explicitly")
    expect(await managed.run((registry) => registry.catalog({ fetchMissing: false }))).toEqual({ plugins: [] })
    expect(fetch).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals(); await managed.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
it("refuses corrupt state and does not accept work after shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-managed-invalid-"))
  const managed = createManagedPluginRegistry({ root })
  try {
    await writeFile(join(root, "state.json"), "{broken")
    await expect(managed.run((registry) => registry.addSource("unused"))).rejects.toThrow("valid plugin registry state")
    expect(await readFile(join(root, "state.json"), "utf8")).toBe("{broken")
    await managed.close()
    await expect(managed.run((registry) => registry.catalog())).rejects.toThrow("closed")
  } finally { await managed.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
it("shares source/install/enable state between managed registry instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-managed-plugins-"))
  const a = createManagedPluginRegistry({ root }); const b = createManagedPluginRegistry({ root })
  try {
    await a.run((registry) => registry.addSource(fileURLToPath(new URL("./fixtures/marketplace-a", import.meta.url))))
    await a.run((registry) => registry.install("Marketplace A__hello"))
    await b.run((registry) => registry.enable("Marketplace A__hello"))
    expect(await a.run((registry) => registry.runtimeInputs())).toMatchObject({ commandDescriptors: expect.arrayContaining([expect.objectContaining({ name: "hello" })]) })
    await a.run((registry) => registry.disable("Marketplace A__hello"))
    expect((await b.run((registry) => registry.runtimeInputs())).commandDescriptors).toEqual([])
  } finally { await a.close(); await b.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
