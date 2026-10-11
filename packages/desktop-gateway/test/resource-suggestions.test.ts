import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { encodeFrame, isRpcSuccess, makeRequest, INVALID_PARAMS, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
import type { ResourceSuggestionPage } from "../src/resources.ts"
import { writeSuggestionMarketplace } from "./resource-suggestions-fixture.ts"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ih-resource-suggestions-"))
  const workspace = join(root, "workspace"), sessionDir = join(root, "sessions"), settingsPath = join(root, "settings.json")
  await mkdir(workspace)
  await mkdir(join(root, "plugins"))
  await writeFile(join(root, "plugins", "state.json"), JSON.stringify({ version: 1, sources: [], plugins: [] }))
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: "read-only" }))
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: frame => frames.push(frame) })
  let id = 0
  const request = async (method: string, params: unknown = {}) => {
    const requestId = ++id
    await host.handleLine(encodeFrame(makeRequest(requestId, method, params)))
    return frames.find(frame => "id" in frame && frame.id === requestId)
  }
  const call = async (method: string, params: unknown = {}) => {
    const reply = await request(method, params)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  await call("initialize")
  return { root, workspace, sessionDir, request, call, suggestions: async (query = "") => await call("desktop/resources/suggestions", { query }) as ResourceSuggestionPage,
    async close() { await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) } }
}

it("updates skill-only and command plugin suggestions after install, enable, disable and uninstall without creating a session", async () => {
  const f = await fixture()
  try {
    const marketplace = await writeSuggestionMarketplace(f.root)
    const before = await readdir(f.sessionDir)
    expect(await f.suggestions()).toEqual({ items: [], total: 0, diagnostics: [] })
    await f.call("desktop/plugins/mutate", { action: "source/add", source: marketplace.source })
    for (const id of [marketplace.skillsId, marketplace.commandsId]) await f.call("desktop/plugins/mutate", { action: "install", id })
    expect((await f.suggestions()).items).toEqual([])
    for (const id of [marketplace.skillsId, marketplace.commandsId]) await f.call("desktop/plugins/mutate", { action: "enable", id })
    const page = await f.suggestions()
    expect(page.total).toBe(4)
    expect(page.items).toEqual([
      { name: "brainstorming", kind: "skill", description: "Review a design before implementation", source: "plugin", pluginId: "suggestion-fixture__superpowers" },
      { name: "review-changes", kind: "command", description: "Review changed files", argumentHints: "<file>", source: "plugin", pluginId: "suggestion-fixture__prompts" },
      { name: "shared", kind: "command", description: "Plugin shared command", source: "plugin", pluginId: "suggestion-fixture__prompts" },
      { name: "shared", kind: "skill", description: "Plugin shared skill", source: "plugin", pluginId: "suggestion-fixture__superpowers" },
    ])
    expect(JSON.stringify(page)).not.toContain("private")
    expect(JSON.stringify(page)).not.toContain(f.root)
    expect(page.items.every(row => Object.keys(row).every(key => ["name", "kind", "description", "argumentHints", "source", "pluginId"].includes(key)))).toBe(true)
    expect(await f.call("desktop/plugins/commands")).toEqual([
      { name: "review-changes", description: "Review changed files", argumentHints: "<file>" },
      { name: "shared", description: "Plugin shared command" },
    ])
    for (const id of [marketplace.skillsId, marketplace.commandsId]) await f.call("desktop/plugins/mutate", { action: "disable", id })
    expect((await f.suggestions()).items).toEqual([])
    for (const id of [marketplace.skillsId, marketplace.commandsId]) await f.call("desktop/plugins/mutate", { action: "enable", id })
    expect((await f.suggestions()).total).toBe(4)
    for (const id of [marketplace.skillsId, marketplace.commandsId]) await f.call("desktop/plugins/mutate", { action: "uninstall", id })
    expect((await f.suggestions()).items).toEqual([])
    expect(await f.call("session/list")).toMatchObject({ sessions: [] })
    expect(await readdir(f.sessionDir)).toEqual(before)
  } finally { await f.close() }
})

it("searches names, descriptions and plugin IDs case-insensitively and ranks name prefixes first", async () => {
  const f = await fixture()
  try {
    const marketplace = await writeSuggestionMarketplace(f.root)
    await f.call("desktop/plugins/mutate", { action: "source/add", source: marketplace.source })
    for (const id of [marketplace.skillsId, marketplace.commandsId]) {
      await f.call("desktop/plugins/mutate", { action: "install", id })
      await f.call("desktop/plugins/mutate", { action: "enable", id })
    }
    expect((await f.suggestions(" ReViEw ")).items.map(row => row.name)).toEqual(["review-changes", "brainstorming"])
    expect((await f.suggestions("IMPLEMENTATION")).items.map(row => row.name)).toEqual(["brainstorming"])
    expect((await f.suggestions("SUPERPOWERS")).items.map(row => row.name)).toEqual(["brainstorming", "shared"])
    expect((await f.suggestions("absent")).total).toBe(0)
  } finally { await f.close() }
})

it("suggests only the effective same-name resource in each kind while workspace overrides are added and removed", async () => {
  const f = await fixture()
  try {
    const marketplace = await writeSuggestionMarketplace(f.root)
    await f.call("desktop/plugins/mutate", { action: "source/add", source: marketplace.source })
    for (const id of [marketplace.skillsId, marketplace.commandsId]) {
      await f.call("desktop/plugins/mutate", { action: "install", id })
      await f.call("desktop/plugins/mutate", { action: "enable", id })
    }
    for (const [root, description] of [[f.root, "Global"], [f.workspace, "Workspace"]]) {
      await mkdir(join(root!, "commands"), { recursive: true })
      await writeFile(join(root!, "commands", "shared.md"), `---\ndescription: ${description} command\n---\nprivate command body`)
      await mkdir(join(root!, "skills", "shared"), { recursive: true })
      await writeFile(join(root!, "skills", "shared", "SKILL.md"), `---\nname: shared\ndescription: ${description} skill\n---\nprivate skill body`)
    }
    expect((await f.suggestions("shared")).items).toEqual([
      { name: "shared", kind: "command", description: "Workspace command", source: "workspace" },
      { name: "shared", kind: "skill", description: "Workspace skill", source: "workspace" },
    ])
    await rm(join(f.workspace, "commands", "shared.md"))
    await rm(join(f.workspace, "skills", "shared"), { recursive: true })
    expect((await f.suggestions("shared")).items.map(row => [row.kind, row.source, row.pluginId])).toEqual([
      ["command", "plugin", "suggestion-fixture__prompts"], ["skill", "plugin", "suggestion-fixture__superpowers"],
    ])
    for (const id of [marketplace.skillsId, marketplace.commandsId]) await f.call("desktop/plugins/mutate", { action: "disable", id })
    expect((await f.suggestions("shared")).items).toEqual([
      { name: "shared", kind: "command", description: "Global command", source: "global" },
      { name: "shared", kind: "skill", description: "Global skill", source: "global" },
    ])
  } finally { await f.close() }
})

it("caps suggestions at 100 while retaining the total and validates the 512-character query boundary", async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.workspace, "commands"))
    for (let i = 0; i < 105; i++) await writeFile(join(f.workspace, "commands", `bulk-${String(i).padStart(3, "0")}.md`), "private command body")
    const page = await f.suggestions("bulk")
    expect(page.items).toHaveLength(100)
    expect(page.total).toBe(105)
    expect(page.items[0]?.name).toBe("bulk-000")
    expect(page.items.at(-1)?.name).toBe("bulk-099")
    expect((await f.suggestions("x".repeat(512))).total).toBe(0)
    for (const params of [{}, { query: null }, { query: 1 }, { query: "x".repeat(513) }]) {
      expect(await f.request("desktop/resources/suggestions", params)).toMatchObject({ error: { code: INVALID_PARAMS } })
    }
  } finally { await f.close() }
})
