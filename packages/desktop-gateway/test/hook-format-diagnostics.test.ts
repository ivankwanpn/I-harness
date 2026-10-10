import { afterEach, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { listCommands, runCommand } from "@i-harness/interaction"
import { resolveHookTrustPath } from "@i-harness/hooks"
import { createSessionService } from "@i-harness/session-executor"
import { createHookSettings } from "../src/hook-settings.ts"
import { authoredHookPath } from "../src/effective-local-inputs.ts"
import { pluginExtensions } from "../src/plugin-mount.ts"

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5 }))) })

async function fixture(source: "plugin" | "global" | "workspace" = "plugin", body?: string) {
  const root = await mkdtemp(join(tmpdir(), "ih-hook-format-gateway-")); roots.push(root)
  const home = join(root, "home"), workspace = join(root, "work")
  await mkdir(home); await mkdir(workspace)
  vi.stubEnv("IH_CONFIG_DIR", home)
  const path = source === "plugin" ? join(home, "plugins", "fixture", "hooks", "hooks.json") : authoredHookPath(workspace, home, source)
  await mkdir(dirname(path), { recursive: true })
  const marker = join(root, "foreign-executed.txt"), script = join(dirname(path), "foreign.cjs")
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); console.log('{}')`)
  const foreign = JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup|clear|compact", hooks: [{ type: "command", command: `"${process.execPath}" "${script}"`, shell: "bash", async: false }] }] } })
  await writeFile(path, body ?? foreign)
  return { root, home, workspace, path, marker, foreign }
}

it("reports unsupported plugin format without exposing a runnable handler or creating a grant", async () => {
  const { home, workspace, path, marker, foreign } = await fixture()
  const settings = createHookSettings(home, async () => [path], async () => {}, { workspace })
  const state = await settings.state()
  expect(state.handlers).toEqual([])
  expect(state.grants).toEqual([])
  expect(state.errors).toMatchObject([{ configPath: path, kind: "unsupported-format", source: "plugin", format: "claude-plugin" }])
  expect(state.errors[0]!.message).toContain("HookUnsupportedFormatError")
  expect(existsSync(marker)).toBe(false)
  expect(existsSync(resolveHookTrustPath(home))).toBe(false)
  await expect(settings.mutate({ action: "approve", id: "foreign", sha256: "a".repeat(64) })).rejects.toThrow("changed or is invalid")
  expect(existsSync(resolveHookTrustPath(home))).toBe(false)
  expect(await readFile(path, "utf8")).toBe(foreign)
})

it("refreshes supported capabilities on the same agent while recognized foreign hooks remain inactive", async () => {
  const { home, workspace, path, marker } = await fixture()
  let enabled = false
  const diagnostics: string[][] = []
  const service = createSessionService({ workspace, modelPolicy: "test-mock", extensionsFor: async id => pluginExtensions({
    skillDirs: [], hookConfigs: [path], mcpServerConfigs: {},
    commandDescriptors: enabled ? [{ name: "supported-command", body: "Explain the supplied material" }] : [],
    agentDescriptors: enabled ? [{ name: "supported-reader", description: "Read supplied material", systemPrompt: "Read the supplied material", tools: ["Read"] }] : [],
  }, home, id, messages => diagnostics.push(messages)) })
  try {
    const assembly = await service.assemblyFor("s")
    enabled = true
    await service.refreshExtensions()
    expect(await service.assemblyFor("s")).toBe(assembly)
    expect(listCommands(assembly.ctx).map(command => command.name)).toContain("supported-command")
    expect(await runCommand(assembly.ctx, "supported-command", "")).toMatchObject({ kind: "prompt", text: "Explain the supplied material" })
    expect(assembly.pluginAgentResults.get("supported-reader")).toBe(true)
    expect(diagnostics.flat().join(" ")).toContain("HookUnsupportedFormatError")
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(resolveHookTrustPath(home))).toBe(false)
  } finally { await service.close() }
  expect(existsSync(marker)).toBe(false)
})

it.each(["global", "workspace"] as const)("keeps recognized foreign %s authoring strict during live refresh", async source => {
  const { home, workspace, path, marker } = await fixture(source)
  const settings = createHookSettings(home, async () => [path], async () => {}, { workspace })
  expect((await settings.state()).errors).toMatchObject([{ kind: "invalid", source, format: "claude-plugin" }])
  const service = createSessionService({ workspace, modelPolicy: "test-mock", extensionsFor: async id => pluginExtensions({ skillDirs: [], hookConfigs: [path], mcpServerConfigs: {}, commandDescriptors: [], agentDescriptors: [] }, home, id, () => {}) })
  try {
    await service.assemblyFor("s")
    await expect(service.refreshExtensions()).rejects.toThrow()
    expect(existsSync(marker)).toBe(false)
  } finally { await service.close() }
})

it.each([
  ["invalid JSON", "{"],
  ["invalid native version", JSON.stringify({ version: 2, handlers: [] })],
  ["mixed native fields", JSON.stringify({ version: 1, handlers: "invalid", hooks: { SessionStart: [] } })],
  ["invalid native handler", JSON.stringify({ version: 1, handlers: [{ id: "invalid" }] })],
] as const)("keeps %s strict for plugin live refresh", async (_name, body) => {
  const { home, workspace, path } = await fixture("plugin", body)
  const service = createSessionService({ workspace, modelPolicy: "test-mock", extensionsFor: async id => pluginExtensions({ skillDirs: [], hookConfigs: [path], mcpServerConfigs: {}, commandDescriptors: [], agentDescriptors: [] }, home, id, () => {}) })
  try {
    await service.assemblyFor("s")
    await expect(service.refreshExtensions()).rejects.toThrow()
  } finally { await service.close() }
})
