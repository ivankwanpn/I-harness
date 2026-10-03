import { expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { loadHooksConfig, createHookRegistry } from "@i-harness/hooks"
import { createSessionService } from "@i-harness/session-executor"
import { createHookSettings } from "../src/hook-settings.ts"
import { authoredHookPath } from "../src/effective-local-inputs.ts"

it("requires a grant for global authoring and invalidates it for config, command and script edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-hook-authoring-")), home = join(root, "home"), workspace = join(root, "work")
  vi.stubEnv("IH_CONFIG_DIR", home)
  await mkdir(home); await mkdir(workspace)
  const configPath = authoredHookPath(workspace, home, "global"), output = join(root, "calls.txt")
  const body = `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'x'); console.log('{}')`
  const hash = createHash("sha256").update(body).digest("hex")
  const hooks = createHookSettings(home, async () => [], async () => {}, { workspace })
  const service = createSessionService({ workspace, model: { async *stream() { yield { type: "end" as const } } } })
  let registry: Awaited<ReturnType<typeof createHookRegistry>> | undefined
  try {
    await hooks.writeScript({ source: "global", name: "observe", body, expectedRevision: null })
    const command = { cmd: process.execPath, args: [join(home, "hooks", "authored", "scripts", "observe.cjs")] }
    const config = JSON.stringify({ version: 1, handlers: [{ id: "observe", event: "prompt/submit", type: "command", command, trust: { script: "scripts/observe.cjs", sha256: hash }, timeoutMs: 5000 }] }, null, 2)
    await hooks.writeConfig({ source: "global", body: config, expectedRevision: null })
    const row = (await hooks.state()).handlers[0]!
    expect(row.status).toBe("needs-approval")
    await hooks.mutate({ action: "approve", id: row.id, sha256: row.sha256 })
    const approvals = hooks.approvalsFor(configPath)
    expect((await loadHooksConfig(configPath, join(home, "hooks", "authored"), approvals))[0]?.valid).toBe(true)
    const assembly = await service.assemblyFor("s")
    registry = await createHookRegistry(assembly.ctx, { configPath, configDir: join(home, "hooks", "authored"), approvals })
    await service.submit("s", "run", new AbortController().signal)
    expect(await readFile(output, "utf8")).toBe("x")
    const original = (await hooks.readConfig("global"))!
    const changed = config.replace('"prompt/submit"', '"notification"')
    expect(await hooks.writeConfig({ source: "global", body: changed, expectedRevision: original.revision })).toMatchObject({ kind: "saved" })
    expect((await hooks.state()).handlers[0]?.status).toBe("needs-approval")
    expect(approvals.isApproved(hash)).toBe(false)
    expect(await hooks.writeConfig({ source: "global", body: config, expectedRevision: original.revision })).toMatchObject({ kind: "conflict" })
    const second = (await hooks.state()).handlers[0]!
    await hooks.mutate({ action: "approve", id: second.id, sha256: hash })
    await writeFile(configPath, changed.replace('"args": [', '"args": ["--inspect",'))
    expect(approvals.isApproved(hash)).toBe(false)
    await writeFile(configPath, changed)
    const script = (await hooks.readScript("global", "observe"))!
    await hooks.writeScript({ source: "global", name: "observe", body: "console.log('{}')", expectedRevision: script.revision })
    expect(approvals.isApproved(hash)).toBe(false)
    expect((await hooks.state()).handlers[0]?.status).toBe("invalid")
    await expect(hooks.writeConfig({ source: "global", body: '{"version":2}', expectedRevision: (await hooks.readConfig("global"))!.revision })).rejects.toThrow(/version/)
  } finally { await registry?.dispose(); await service.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
})
