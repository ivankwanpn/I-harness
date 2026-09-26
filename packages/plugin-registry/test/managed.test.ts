import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { createManagedPluginRegistry } from "../src/managed.ts"
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
