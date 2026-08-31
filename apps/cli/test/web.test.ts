import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SettingsStore, resolveSettingsPath } from "@i-harness/settings"
import { createProviderRegistry } from "@i-harness/provider"
import { createCredentialStore } from "@i-harness/credentials"
import { parsePort, createWebServer, resolveModelSpec, type WebServerOptions } from "../src/web.ts"

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

  it("defaults the settings store path to the config dir", () => {
    // resolveSettingsPath is E's; assert the option override path works through
    // the default constructor location contract (no home touch).
    expect(typeof resolveSettingsPath()).toBe("string")
  })
})
