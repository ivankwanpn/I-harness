import { afterEach, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionService } from "@i-harness/session-executor"
import { append, createSession } from "@i-harness/core-session"
import type { LLMRequest, ModelClient } from "../../llm-seam/src/index.ts"
import { createHookSettings } from "../src/hook-settings.ts"
import { pluginExtensions } from "../src/plugin-mount.ts"

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5 }))) })

async function fixture(resume = false) {
  const root = await mkdtemp(join(tmpdir(), "ih-claude-context-")); roots.push(root)
  const home = join(root, "home"), workspace = join(root, "work"), plugin = join(home, "plugins", "official__context")
  await mkdir(workspace, { recursive: true }); await mkdir(join(plugin, "hooks"), { recursive: true })
  await mkdir(join(plugin, "skills", "context"), { recursive: true })
  vi.stubEnv("IH_CONFIG_DIR", home)
  const config = join(plugin, "hooks", "hooks.json"), marker = join(workspace, "calls.txt"), skill = join(plugin, "skills", "context", "SKILL.md")
  await writeFile(skill, "# Reviewed fixture skill")
  await writeFile(join(plugin, "hooks", "start.sh"), "#!/usr/bin/env bash\nset -euo pipefail\nprintf x >> \"$CLAUDE_PROJECT_DIR/calls.txt\"\nprintf '%s\\n' '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"OFFICIAL_START_CONTEXT\"}}'\n")
  await writeFile(config, JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup|clear|compact", hooks: [{ type: "command", command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/start.sh"', timeout: 5 }] }] } }))
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { requests.push(structuredClone(request)); yield { type: "text/chunk", text: "done" }; yield { type: "end" } } }
  let enabled = true
  const inputs = () => ({ hookConfigs: enabled ? [config] : [], skillDirs: [], commandDescriptors: [], agentDescriptors: [], mcpServerConfigs: {} })
  const restored = createSession()
  if (resume) append(restored, { type: "user/message", text: "Existing conversation" })
  const service = createSessionService({ workspace, model, ...(resume ? { sessionFor: async () => restored } : {}), additionalSystemPrompt: () => "HOST_GOAL_CONTEXT", extensionsFor: async id => pluginExtensions(inputs(), home, id, () => {}, [], workspace) })
  const settings = createHookSettings(home, async () => inputs().hookConfigs, () => service.refreshExtensions(), { workspace })
  return { home, workspace, config, marker, skill, requests, service, settings, disable: () => { enabled = false } }
}

it("approves the reviewed plugin bundle, activates startup on the same agent, and withdraws context on revoke/update/disable", async () => {
  const f = await fixture()
  try {
    const original = await f.service.assemblyFor("s")
    const row = (await f.settings.state()).handlers[0]!
    expect(row).toMatchObject({ status: "needs-approval", format: "claude-plugin", trustScope: "plugin", sourceEvent: "SessionStart" })
    expect(existsSync(f.marker)).toBe(false)
    await f.service.submit("s", "before grant", new AbortController().signal)
    expect(f.requests.at(-1)!.systemPrompt).not.toContain("OFFICIAL_START_CONTEXT")
    await f.settings.mutate({ action: "approve", id: row.id, sha256: row.sha256 })
    expect(await readFile(f.marker, "utf8")).toBe("x")
    await f.settings.refresh()
    expect(await readFile(f.marker, "utf8")).toBe("x")
    await f.service.submit("s", "after grant", new AbortController().signal)
    expect(f.requests.at(-1)!.systemPrompt).toContain("OFFICIAL_START_CONTEXT")
    expect(f.requests.at(-1)!.systemPrompt).toContain("HOST_GOAL_CONTEXT")
    expect(await f.service.assemblyFor("s")).toBe(original)
    await f.settings.mutate({ action: "revoke", sha256: row.sha256 })
    await f.service.submit("s", "after revoke", new AbortController().signal)
    expect(f.requests.at(-1)!.systemPrompt).not.toContain("OFFICIAL_START_CONTEXT")
    await f.settings.mutate({ action: "approve", id: row.id, sha256: row.sha256 })
    expect(await readFile(f.marker, "utf8")).toBe("xx")
    await writeFile(f.skill, "# Changed fixture skill")
    await f.settings.refresh()
    await f.service.submit("s", "after update", new AbortController().signal)
    expect(f.requests.at(-1)!.systemPrompt).not.toContain("OFFICIAL_START_CONTEXT")
    await expect(f.settings.mutate({ action: "approve", id: row.id, sha256: row.sha256 })).rejects.toThrow("changed or is invalid")
    const updated = (await f.settings.state()).handlers[0]!
    expect(updated.sha256).not.toBe(row.sha256)
    await f.settings.mutate({ action: "approve", id: updated.id, sha256: updated.sha256 })
    f.disable(); await f.service.refreshExtensions()
    await f.service.submit("s", "after disable", new AbortController().signal)
    expect(f.requests.at(-1)!.systemPrompt).not.toContain("OFFICIAL_START_CONTEXT")
  } finally { await f.service.close() }
}, 20_000)

it("diagnoses unsupported handlers individually while retaining a runnable SessionStart sibling", async () => {
  const f = await fixture()
  try {
    const raw = JSON.parse(await readFile(f.config, "utf8"))
    raw.hooks.Stop = [{ hooks: [{ type: "command", command: "exit 2" }] }]
    await writeFile(f.config, JSON.stringify(raw))
    const state = await f.settings.state()
    expect(state.handlers).toHaveLength(1)
    expect(state.errors).toMatchObject([{ kind: "unsupported-handler", event: "Stop", format: "claude-plugin", source: "plugin" }])
    expect(existsSync(f.marker)).toBe(false)
  } finally { await f.service.close() }
})

it("uses resume for restored conversation history and respects the plugin matcher", async () => {
  const f = await fixture(true)
  try {
    const row = (await f.settings.state()).handlers[0]!
    await f.settings.mutate({ action: "approve", id: row.id, sha256: row.sha256 })
    await f.service.submit("restored", "continue", new AbortController().signal)
    expect(existsSync(f.marker)).toBe(false)
    expect(f.requests.at(-1)!.systemPrompt).not.toContain("OFFICIAL_START_CONTEXT")
    // A plugin without a matcher intentionally runs on resume as well.
    const raw = JSON.parse(await readFile(f.config, "utf8")); delete raw.hooks.SessionStart[0].matcher
    await writeFile(f.config, JSON.stringify(raw))
    await f.settings.refresh()
    const updated = (await f.settings.state()).handlers[0]!
    await f.settings.mutate({ action: "approve", id: updated.id, sha256: updated.sha256 })
    await f.service.submit("restored", "continue with context", new AbortController().signal)
    expect(await readFile(f.marker, "utf8")).toBe("x")
    expect(f.requests.at(-1)!.systemPrompt).toContain("OFFICIAL_START_CONTEXT")
  } finally { await f.service.close() }
})
