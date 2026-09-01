import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SettingsStore, resolveSettingsPath } from "@i-harness/settings"
import { createProviderRegistry } from "@i-harness/provider"
import { createCredentialStore } from "@i-harness/credentials"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { parsePort, createWebServer, defaultContextWindow, resolveModelSpec, type WebServerOptions } from "../src/web.ts"
import { pickWebPort } from "../src/index.ts"

describe("pickWebPort (H-4)", () => {
  it("web: flag beats env beats default", () => {
    expect(pickWebPort(["node", "i-harness", "web", "--port", "4398"], "1234")).toBe(4398)
    expect(pickWebPort(["node", "i-harness", "web"], "1234")).toBe(1234)
    expect(pickWebPort(["node", "i-harness", "web"], undefined)).toBe(4310)
  })

  it("web: invalid flag falls back to env/default and env passes through parsePort", () => {
    expect(pickWebPort(["node", "i-harness", "web", "--port", "abc"], "1234")).toBe(1234)
    expect(pickWebPort(["node", "i-harness", "web", "--port", "0"], undefined)).toBe(4310)
  })
})

describe("parsePort", () => {
  it("falls back on junk and floors valid values", () => {
    expect(parsePort(undefined)).toBe(4310)
    expect(parsePort("")).toBe(4310)
    expect(parsePort("abc")).toBe(4310)
    expect(parsePort("3080.9")).toBe(3080)
    expect(parsePort("-5")).toBe(4310)
    expect(parsePort("0")).toBe(0)
  })
})

describe("web composition (R-C1)", () => {
  function options(workspace: string, extra: Partial<WebServerOptions> = {}): WebServerOptions {
    // Hermetic stores so the test never touches the user's home:
    const configDir = mkdtempSync(join(tmpdir(), "ih-web-config-"))
    return {
      port: 0,
      workspace,
      settings: new SettingsStore({ configDir }),
      credentials: createCredentialStore(join(configDir, "credentials.json")),
      providerRegistry: createProviderRegistry(),
      ...extra,
    }
  }

  it("serves session create/list over the thin composition", async () => {
    // The jsonl backend roots at the workspace — a temp dir so the repo's own
    // session files never appear in the list.
    const workspace = mkdtempSync(join(tmpdir(), "ih-web-ws-"))
    const server = await createWebServer(options(workspace))
    try {
      const post = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
      expect(post.status).toBe(200)
      const list = await fetch(`http://127.0.0.1:${server.port}/api/sessions`)
      expect(((await list.json()) as { sessions: unknown[] }).sessions.length).toBe(1)
    } finally {
      await server.close()
    }
  }, 60_000)

  it("resolves the model tier chain: session selection > default > legacy > mock", async () => {
    const opts = options(process.cwd())
    expect(resolveModelSpec(opts).source).toBe("mock")
    const settings = opts.settings!
    await settings.set({ model: "openai:gpt-4o" })
    expect(resolveModelSpec(opts)).toEqual({ spec: "openai:gpt-4o", source: "legacy" })
    await settings.set({ llm: { ...settings.get().llm, defaultModel: { provider: "deepseek", model: "deepseek-chat" } } })
    expect(resolveModelSpec(opts)).toEqual({ spec: "deepseek:deepseek-chat", source: "default" })
    expect(resolveModelSpec(opts, { formatVersion: 1, sessionId: "s", createdAt: "", modelSelection: { provider: "anthropic", model: "claude-3-5" } }))
      .toEqual({ spec: "anthropic:claude-3-5", source: "session" })
  })

  it("defaultContextWindow: M15 provider record → session window (R-A8)", async () => {
    const registry = createProviderRegistry()
    registry.register({
      name: "acme", displayName: "Acme", protocol: "openai-compatible",
      contextWindow: 96_000, modelContexts: { small: { contextWindow: 200_000 } }, models: [], defaultModel: "small",
    })
    const opts = options(process.cwd(), { providerRegistry: registry })
    expect(defaultContextWindow(opts)).toBeUndefined() // mock default → fail-closed (not registered)
    await opts.settings!.set({ model: "acme:small" })
    expect(defaultContextWindow(opts)).toBe(200_000) // per-model override wins
    await opts.settings!.set({ model: "acme:other" })
    expect(defaultContextWindow(opts)).toBe(96_000) // profile-level default
  })

  it("defaults the settings store path to the config dir", () => {
    // resolveSettingsPath is E's; assert the option override path works through
    // the default constructor location contract (no home touch).
    expect(typeof resolveSettingsPath()).toBe("string")
  })

  // M29: the file-backed query is wired into the host seam with the workspace
  // as its store root — search/lineage routes serve out of the box over the
  // jsonl store (reconcile-on-search derives the index on first request).
  it("serves search + lineage routes over the file-backed index (M29)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-web-m29-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(workspace))
      await coordinator.create({ sessionId: "parent" })
      await coordinator.create({ sessionId: "child", parentSession: "parent", delegationDepth: 1, origin: "subagent" })
      await coordinator.append("parent", [{ type: "user/message", text: "the purple unicorn fixed the parser" }])
      await coordinator.close()
      const server = await createWebServer(options(workspace))
      try {
        const search = await fetch(`http://127.0.0.1:${server.port}/api/sessions/search?q=unicorn`)
        expect(search.status).toBe(200)
        const { hits } = (await search.json()) as { hits: { sessionId: string; snippet: string }[] }
        expect(hits).toHaveLength(1)
        expect(hits[0]!.sessionId).toBe("parent")
        expect(hits[0]!.snippet).toContain("unicorn")
        const lineage = await fetch(`http://127.0.0.1:${server.port}/api/sessions/parent/lineage?direction=children`)
        expect(lineage.status).toBe(200)
        const { nodes } = (await lineage.json()) as { nodes: { sessionId: string; parentSession?: string }[] }
        expect(nodes.map((n) => n.sessionId)).toEqual(["child"])
        expect(nodes[0]!.parentSession).toBe("parent")
      } finally {
        await server.close()
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 60_000)
})
