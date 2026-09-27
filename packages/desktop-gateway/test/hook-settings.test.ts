import { expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { sha256File } from "@i-harness/hooks"
import { createSessionService } from "@i-harness/session-executor"
import { pluginExtensions } from "../src/plugin-mount.ts"
import { createHookSettings } from "../src/hook-settings.ts"

it("grants and revokes a hook on the existing agent and rejects changed artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-hook-settings-"))
  const plugin = join(root, "plugin"); await mkdir(plugin)
  const script = join(plugin, "hook.cjs"), output = join(root, "calls.txt"), config = join(plugin, "hooks.json")
  const source = `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'x'); console.log('{}')`
  await writeFile(script, source)
  const sha256 = await sha256File(script)
  await writeFile(config, JSON.stringify({ version: 1, handlers: [{ id: "observe", event: "prompt/submit", type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256 }, timeoutMs: 5000 }] }))
  const service = createSessionService({ workspace: root, model: { async *stream() { yield { type: "text/chunk" as const, text: "done" }; yield { type: "end" as const } } }, extensionsFor: async (id) => pluginExtensions({ hookConfigs: [config], skillDirs: [], commandDescriptors: [], mcpServerConfigs: {}, agentDescriptors: [] }, root, id, () => {}) })
  const hooks = createHookSettings(root, async () => [config], () => service.refreshExtensions())
  try {
    const assembly = await service.assemblyFor("s")
    const row = (await hooks.state()).handlers[0]!
    expect(row.status).toBe("needs-approval")
    await hooks.mutate({ action: "approve", id: row.id, sha256 })
    await service.submit("s", "one", new AbortController().signal)
    await writeFile(script, "console.log('{}')")
    const invalidAssembly = await service.assemblyFor("broken")
    await hooks.refresh()
    await expect(service.submit("broken", "invalid", new AbortController().signal)).rejects.toThrow()
    await writeFile(script, source)
    expect((await hooks.refresh()).handlers[0]!.status).toBe("ready")
    await service.submit("broken", "restored", new AbortController().signal)
    expect(await service.assemblyFor("broken")).toBe(invalidAssembly)
    const before = await readFile(output, "utf8")
    expect(before.length).toBeGreaterThan(0)
    await hooks.mutate({ action: "revoke", sha256 })
    await service.submit("s", "two", new AbortController().signal)
    expect(await readFile(output, "utf8")).toBe(before)
    expect(await service.assemblyFor("s")).toBe(assembly)
    await writeFile(script, "console.log('{}')")
    await expect(hooks.mutate({ action: "approve", id: row.id, sha256 })).rejects.toThrow("changed or is invalid")
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
