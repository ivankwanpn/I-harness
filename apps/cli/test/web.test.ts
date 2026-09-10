import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { SettingsStore, resolveSettingsPath, type SettingsProviderConfig } from "@i-harness/settings"
import { PluginRegistry } from "@i-harness/plugin-registry"
import { createProviderRegistry, resolveModelContext, type ProviderProfile } from "@i-harness/provider"
import { createCredentialStore } from "@i-harness/credentials"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderRuntime } from "@i-harness/provider-runtime"
import { parsePort, createWebServer, defaultContextWindow, effectiveProviderProfile, resolveModelSpec, sessionContextWindow, type WebServerOptions } from "../src/web.ts"
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
      // M61: the store is no longer the workspace by default — every test
      // pins it explicitly to its own temp dir so the suite never reads (or
      // writes) the real `~/.i-harness/sessions` store. The DEFAULT root is
      // pinned by its own test below.
      storeRoot: workspace,
      settings: new SettingsStore({ configDir }),
      credentials: createCredentialStore(join(configDir, "credentials.json")),
      providerRegistry: createProviderRegistry(),
      ...extra,
    }
  }

  it("M61: without an explicit storeRoot the host serves the SHARED root", async () => {
    // The regression this guards: the host rooted its jsonl store at the
    // WORKSPACE, so `/api/sessions` answered {sessions:[]} no matter how many
    // conversations the agent had kept.
    const configDir = mkdtempSync(join(tmpdir(), "ih-web-shared-"))
    const workspace = mkdtempSync(join(tmpdir(), "ih-web-shared-ws-"))
    const sharedRoot = join(configDir, "sessions")
    const seed = createSessionCoordinator(createJsonlBackend(sharedRoot))
    try {
      await seed.create({ sessionId: "shared-1" })
    } finally {
      await seed.close()
    }
    const prevConfigDir = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = configDir
    let server: Awaited<ReturnType<typeof createWebServer>> | undefined
    try {
      server = await createWebServer({
        port: 0,
        workspace,
        settings: new SettingsStore({ configDir }),
        credentials: createCredentialStore(join(configDir, "credentials.json")),
      })
      const list = await fetch(`http://127.0.0.1:${server.port}/api/sessions`)
      const body = (await list.json()) as { sessions: Array<{ id: string }> }
      expect(body.sessions.map((row) => row.id)).toContain("shared-1")
    } finally {
      process.env.IH_CONFIG_DIR = prevConfigDir
      await server?.close()
    }
  }, 60_000)

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

  it("runs web sessions through an injected provider runtime binding", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-web-provider-runtime-"))
    const requests: unknown[] = []
    const model: ModelClient = {
      async *stream(request) {
        requests.push(request)
        yield { type: "text/chunk", text: "runtime response" }
        yield { type: "end" }
      },
    }
    const resolveModel = vi.fn(async () => ({
      status: "ready" as const,
      binding: {
        client: model,
        providerId: "fixture",
        modelId: "fixture-model",
        label: "fixture:fixture-model",
      },
    }))
    const providerRuntime = { resolveModel } as unknown as ProviderRuntime
    const server = await createWebServer(options(workspace, { providerRuntime }))
    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      })
      const { id } = await created.json() as { id: string }
      await server.executor.submit(id, "hello from web", new AbortController().signal)
      expect(resolveModel).toHaveBeenCalledWith({})
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests[0])).toContain("hello from web")
      await expect(server.executor.modelState(id)).resolves.toEqual({
        status: "ready",
        providerId: "fixture",
        modelId: "fixture-model",
        label: "fixture:fixture-model",
      })
    } finally {
      await server.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 60_000)

  it("drains and closes its owned coordinator after executor shutdown", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-web-owned-coordinator-"))
    const server = await createWebServer(options(workspace, {
      mockScript: [{ role: "assistant", text: "fixture" }],
    })) as Awaited<ReturnType<typeof createWebServer>> & {
      coordinator: ReturnType<typeof createSessionCoordinator>
    }
    const order: string[] = []
    const executorClose = server.executor.close.bind(server.executor)
    const coordinatorClose = server.coordinator.close.bind(server.coordinator)
    vi.spyOn(server.executor, "close").mockImplementation(async () => {
      order.push("executor")
      await executorClose()
    })
    const closeCoordinator = vi.spyOn(server.coordinator, "close").mockImplementation(async () => {
      order.push("coordinator")
      await coordinatorClose()
    })
    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      })
      const { id } = await created.json() as { id: string }
      server.coordinator.enqueue(id, [{ type: "user/message", text: "pending durable write" }])

      await server.close()

      expect(order).toEqual(["executor", "coordinator"])
      expect(closeCoordinator).toHaveBeenCalledTimes(1)
      await expect(createJsonlBackend(workspace).read(id)).resolves.toMatchObject({
        events: [{ type: "user/message", text: "pending durable write" }],
      })
    } finally {
      await server.close().catch(() => {})
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("uses but does not close a caller-owned coordinator", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-web-caller-coordinator-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(workspace))
    const closeCoordinator = vi.spyOn(coordinator, "close")
    const server = await createWebServer({
      ...options(workspace, { mockScript: [{ role: "assistant", text: "fixture" }] }),
      coordinator,
    } as WebServerOptions & { coordinator: typeof coordinator }) as Awaited<ReturnType<typeof createWebServer>> & {
      coordinator: typeof coordinator
    }
    try {
      expect(server.coordinator).toBe(coordinator)
      const created = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      })
      const { id: serverCreatedId } = await created.json() as { id: string }
      expect(await coordinator.list()).toContain(serverCreatedId)
      await server.close()
      expect(closeCoordinator).not.toHaveBeenCalled()

      const { id } = await coordinator.create()
      await coordinator.append(id, [{ type: "turn/start" }])
      await expect(coordinator.load(id)).resolves.toBeDefined()
    } finally {
      await coordinator.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("resolves the model tier chain: session selection > default > legacy > unconfigured", async () => {
    const opts = options(process.cwd())
    expect(resolveModelSpec(opts).source).toBe("unconfigured")
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
    expect(defaultContextWindow(opts)).toBeUndefined() // unconfigured default → fail-closed (not registered)
    await opts.settings!.set({ model: "acme:small" })
    expect(defaultContextWindow(opts)).toBe(200_000) // per-model override wins
    await opts.settings!.set({ model: "acme:other" })
    expect(defaultContextWindow(opts)).toBe(96_000) // profile-level default
  })

  it("effectiveProviderProfile merges settings model rows into modelContexts (user wins per field; no id flattening)", () => {
    const base: ProviderProfile = {
      name: "acme", displayName: "Acme", protocol: "openai-compatible",
      contextWindow: 96_000,
      modelContexts: { small: { contextWindow: 100_000 }, kept: { contextWindow: 50_000 } },
    }
    const user: SettingsProviderConfig = {
      models: [
        { id: "small", contextWindow: 32_000 },
        { id: "fresh", contextWindow: 64_000, maxTokens: 8_000 },
        { id: "unsized", name: "no caps" },
      ],
    }
    const eff = effectiveProviderProfile(base, user)
    // settings rows aggregate into modelContexts — the contextWindow typed in
    // settings now reaches the resolution chain (the T1 override-chain fix).
    // M32 T1: maxTokens is the OUTPUT-LENGTH semantic (SettingsModel.maxTokens
    // = maxOutputTokens card value) — it no longer maps to maxContextWindow, so
    // the row flattens its contextWindow only (maxTokens stays in the settings
    // row for the resolution chain's per-field output-length override).
    expect(eff.modelContexts).toEqual({
      small: { contextWindow: 32_000 },
      kept: { contextWindow: 50_000 },
      fresh: { contextWindow: 64_000 },
    })
    // no id flattening (that dropped the caps) — the base catalog stays as-is
    expect(eff.models).toBeUndefined()
    // the merged profile lands in the unified chain: user row wins
    expect(resolveModelContext(eff, "small").contextWindow).toBe(32_000)
    expect(resolveModelContext(eff, "kept").contextWindow).toBe(50_000)
  })

  it("defaults the settings store path to the config dir", () => {
    // resolveSettingsPath is E's; assert the option override path works through
    // the default constructor location contract (no home touch).
    expect(typeof resolveSettingsPath()).toBe("string")
  })

  it("sessionContextWindow: per-session chain (M31 T3)", async () => {
    const registry = createProviderRegistry()
    registry.register({
      name: "acme", displayName: "Acme", protocol: "openai-compatible",
      contextWindow: 96_000, modelContexts: { small: { contextWindow: 200_000 } }, models: [],
    })
    const opts = options(process.cwd(), { providerRegistry: registry })
    const sel = (model: string) =>
      ({ formatVersion: 1, sessionId: "s", createdAt: "", modelSelection: { provider: "acme", model } })
    expect(sessionContextWindow(opts, sel("small"))).toBe(200_000) // per-model override
    expect(sessionContextWindow(opts, sel("other"))).toBe(96_000) // profile-level default
    // settings user row wins the chain
    await opts.settings!.set({
      llm: { ...opts.settings!.get().llm, providers: { acme: { models: [{ id: "small", contextWindow: 32_000 }, { id: "m2", contextWindow: 400_000 }] } } },
    })
    expect(sessionContextWindow(opts, sel("small"))).toBe(32_000)
    expect(sessionContextWindow(opts, sel("m2"))).toBe(400_000)
    // no window knowledge → fail-closed undefined
    expect(sessionContextWindow(opts)).toBeUndefined()
  })

  // M51 P1: the user settings row is the TOP tier of the unified chain and is
  // profile-INDEPENDENT — an empty registry (the web amendment's normal shape:
  // every provider is settings-managed) must not short-circuit it.
  it("P1: sessionContextWindow consults the user settings row with an EMPTY registry", async () => {
    const opts = options(process.cwd()) // providerRegistry = createProviderRegistry() (empty)
    const settings = opts.settings!
    await settings.set({
      llm: {
        ...settings.get().llm,
        defaultModel: { provider: "deepseek", model: "deepseek-chat" },
        providers: { deepseek: { models: [{ id: "deepseek-chat", contextWindow: 65_536 }] } },
      },
    })
    expect(resolveModelSpec(opts)).toEqual({ spec: "deepseek:deepseek-chat", source: "default" })
    // the identical user row resolves the same value with or without a profile
    expect(sessionContextWindow(opts)).toBe(65_536)
    expect(sessionContextWindow(opts, {
      formatVersion: 1, sessionId: "s", createdAt: "",
      modelSelection: { provider: "deepseek", model: "deepseek-chat" },
    })).toBe(65_536)
  })

  // M51 P1 (caller): createWebServer's contextWindowFor closure must resolve
  // through the settings/registry it RESOLVED, not the raw opts — the CLI
  // composition passes neither. Proven end-to-end on the legacy path (explicit
  // `model` ⇒ no modelBindingFor) via the registered get_context_remaining.
  it("P1: the web closure sees the RESOLVED settings (no opts.settings, empty registry)", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "ih-web-p1-config-"))
    const workspace = mkdtempSync(join(tmpdir(), "ih-web-p1-ws-"))
    const seeded = new SettingsStore({ configDir })
    await seeded.set({
      llm: {
        ...seeded.get().llm,
        defaultModel: { provider: "deepseek", model: "deepseek-chat" },
        providers: { deepseek: { models: [{ id: "deepseek-chat", contextWindow: 65_536 }] } },
      },
    })
    const seed = createSessionCoordinator(createJsonlBackend(workspace))
    try {
      await seed.create({ sessionId: "p1" })
    } finally {
      await seed.close()
    }
    const script: MockStep[] = [
      { role: "assistant", toolCalls: [{ name: "get_context_remaining", args: {} }] },
      { role: "assistant", text: "done" },
    ]
    let callIdx = 0
    const model: ModelClient = {
      async *stream(req) {
        const step = script[callIdx]!
        callIdx = (callIdx + 1) % script.length
        yield* createMockClient([step]).stream(req)
      },
    }
    const prevConfigDir = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = configDir // SettingsStore default-path resolution
    let server: Awaited<ReturnType<typeof createWebServer>> | undefined
    try {
      server = await createWebServer({
        port: 0,
        workspace,
        // M61: the store is explicit (the seeded temp dir), never the real
        // `~/.i-harness/sessions` — IH_CONFIG_DIR is set for SETTINGS here.
        storeRoot: workspace,
        credentials: createCredentialStore(join(configDir, "credentials.json")),
        model,
        // no settings, no providerRegistry: both are resolved inside createWebServer
      })
      await server.executor.submit("p1", "window?", new AbortController().signal)
      const assembly = await server.executor.assemblyFor("p1")
      const result = [...assembly.session.events].reverse().find(
        (e) => e.type === "tool/result" && (e as { name?: string }).name === "get_context_remaining",
      ) as { output?: { window?: number } } | undefined
      expect(result?.output?.window).toBe(65_536)
    } finally {
      if (prevConfigDir === undefined) delete process.env.IH_CONFIG_DIR
      else process.env.IH_CONFIG_DIR = prevConfigDir
      await server?.close()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  }, 60_000)

  it("M31 T3: per-session context window — two sessions report their own get_context_remaining windows", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-web-m31-per-session-"))
    const seed = createSessionCoordinator(createJsonlBackend(workspace))
    try {
      await seed.create({ sessionId: "s1" })
      await seed.updateMeta("s1", { modelSelection: { provider: "acme", model: "small" } })
      await seed.create({ sessionId: "s2" })
      await seed.updateMeta("s2", { modelSelection: { provider: "acme", model: "large" } })
    } finally {
      await seed.close()
    }
    const registry = createProviderRegistry()
    registry.register({
      name: "acme", displayName: "Acme", protocol: "openai-compatible",
      contextWindow: 96_000,
      modelContexts: { small: { contextWindow: 200_000 }, large: { contextWindow: 400_000 } },
      models: [],
    })
    // One turn = two stream calls (tool step, then text step). The cassette
    // cycles per stream call so a fresh per-call client can never replay the
    // tool step forever; both sessions' turns are strictly sequential here.
    const script: MockStep[] = [
      { role: "assistant", toolCalls: [{ name: "get_context_remaining", args: {} }] },
      { role: "assistant", text: "done" },
    ]
    let callIdx = 0
    const model: ModelClient = {
      async *stream(_req) {
        const step = script[callIdx]!
        callIdx = (callIdx + 1) % script.length
        yield* createMockClient([step]).stream(_req)
      },
    }
    const server = await createWebServer(options(workspace, { providerRegistry: registry, model }))
    try {
      await server.executor.submit("s1", "turn s1", new AbortController().signal)
      await server.executor.submit("s2", "turn s2", new AbortController().signal)
      const windowOf = async (id: string): Promise<number | undefined> => {
        const assembly = await server.executor.assemblyFor(id)
        for (let i = assembly.session.events.length - 1; i >= 0; i -= 1) {
          const ev = assembly.session.events[i] as { type?: string; name?: string; output?: { window?: number } }
          if (ev.type === "tool/result" && ev.name === "get_context_remaining") return ev.output?.window
        }
        return undefined
      }
      expect(await windowOf("s1")).toBe(200_000)
      expect(await windowOf("s2")).toBe(400_000)
    } finally {
      await server.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 60_000)

  // M32 T3: per-session reasoning effort — meta.modelSelection.reasoningEffort
  // flows through the service/assembly/agent chain into every LLMRequest; a
  // session WITHOUT a selection carries no reasoningEffort (缺省不發).
  it("M32 T3: per-session reasoning effort reaches the model request; absent → undefined", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-m32-effort-"))
    const seed = createSessionCoordinator(createJsonlBackend(workspace))
    try {
      await seed.create({ sessionId: "effort" })
      await seed.updateMeta("effort", { modelSelection: { provider: "acme", model: "m", reasoningEffort: "high" } })
      await seed.create({ sessionId: "plain" })
    } finally {
      await seed.close()
    }
    const captured: (string | undefined)[] = []
    const model: ModelClient = {
      async *stream(req) {
        captured.push((req as { reasoningEffort?: string }).reasoningEffort)
        yield* createMockClient([{ role: "assistant", text: "done" }]).stream(req)
      },
    }
    const server = await createWebServer(options(workspace, { model }))
    try {
      await server.executor.submit("effort", "turn", new AbortController().signal)
      await server.executor.submit("plain", "turn", new AbortController().signal)
      expect(captured[0]).toBe("high")
      expect(captured[1]).toBeUndefined()
    } finally {
      await server.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 60_000)

  // M40 A2: the plugin registry + jobs-kill seams are wired into the host —
  // /api/plugins/* and POST /api/sessions/:id/jobs/:jobId/kill answer (the
  // optional-seam 404s exist only when the embedder omits them).
  it("M40 A2: plugin + jobs-kill seams are reachable (catalog/runtime 200, unknown job kill 409)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-web-a2-"))
    const pluginsRoot = join(workspace, ".i-harness", "plugins")
    const server = await createWebServer(options(workspace, {
      pluginRegistry: { registry: new PluginRegistry({ root: pluginsRoot }), root: pluginsRoot },
      mockScript: [{ role: "assistant", text: "fixture" }],
    }))
    try {
      const post = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
      expect(post.status).toBe(200)
      const { id } = (await post.json()) as { id: string }

      // plugin catalog + runtime views serve the (empty) seam verbatim
      const catalog = await fetch(`http://127.0.0.1:${server.port}/api/plugins/catalog`)
      expect(catalog.status).toBe(200)
      expect(await catalog.json()).toEqual({ sources: [], plugins: [] })
      const runtime = await fetch(`http://127.0.0.1:${server.port}/api/plugins/runtime`)
      expect(runtime.status).toBe(200)
      expect(await runtime.json()).toEqual({ plugins: [] })

      // jobs kill: the bridge is composed over the session's assembly — an
      // unknown job answers the bridge's 409 (unknown-job), NOT the 404 that
      // an absent seam would produce.
      const kill = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/jobs/no-such-job/kill`, { method: "POST" })
      expect(kill.status).toBe(409)
    } finally {
      await server.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 60_000)

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

  // M62 regression: the web path must actually CONFINE the shell.
  //
  // Measured before this was wired: createWebServer never passed a sandbox at
  // all (SessionServiceOptions had no such field, and nothing in the repo read
  // settings.sandboxMode), so a shell command sent through the page wrote
  // outside the workspace while settings.json said "workspace-write" — and the
  // page's own `/sandbox` command was a false assurance. This is the green
  // version of that measurement: the setting now reaches the assembly.
  it("M62: settings.sandboxMode confines a shell command sent over the mux", async () => {
    const root = mkdtempSync(join(tmpdir(), "ih-web-sandbox-"))
    const workspace = join(root, "ws")
    const outsideDir = join(root, "outside")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    // OUTSIDE the writable root but OWNED by this test: the first version of
    // this test pointed at the temp ROOT, which plain Windows already refuses —
    // so it "passed" for the wrong reason (measured: with the fix disabled the
    // write was denied by the OS, not by the sandbox, and the mutant survived).
    const outside = join(outsideDir, "outside.txt")
    const configDir = mkdtempSync(join(tmpdir(), "ih-web-sandbox-cfg-"))
    // A LOADED store written with the operator's setting. This matters: an
    // UNLOADED SettingsStore answers `get()` with the DEFAULTS (workspace-write),
    // so a test handing in a fresh store would pass on the default and never
    // exercise the setting at all — which is exactly how the first version of
    // this test survived its own mutation.
    const loadedSettings = new SettingsStore({ configDir })
    await loadedSettings.load()
    await loadedSettings.set({ sandboxMode: "workspace-write" })

    let server: Awaited<ReturnType<typeof createWebServer>> | undefined
    try {
      server = await createWebServer({
        ...options(workspace),
        settings: loadedSettings,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "pwsh", args: { command: `Set-Content -Path '${outside}' -Value ESCAPED` } }] } as MockStep,
          { role: "assistant", text: "DONE" } as MockStep,
        ],
      })
      const created = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      })
      const { id } = (await created.json()) as { id: string }

      const frames: string[] = []
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/mux`)
      await new Promise<void>((resolve) => { ws.addEventListener("open", () => resolve()) })
      ws.addEventListener("message", (ev: { data: unknown }) => {
        const m = JSON.parse(String(ev.data)) as { type?: string; streamId?: string; value?: { status?: string } }
        if (m.type === "item" && m.streamId === "cmd" && m.value?.status !== undefined) frames.push(m.value.status)
      })
      ws.send(JSON.stringify({ type: "open", streamId: "cmd", endpoint: "command", payload: { sessionId: id, prompt: "go" } }))

      const t0 = Date.now()
      while (frames.length < 2 && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 25))
      ws.close()

      expect(frames).toEqual(["started", "ok"])
      // The whole point: the write did NOT land outside the workspace.
      expect(existsSync(outside), "a shell command escaped the workspace").toBe(false)
      // Discriminating: the tool ran and was REFUSED, so this is a confinement
      // rather than a turn that failed for an unrelated reason.
      const events = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/events?limit=50`)
        .then((r) => r.json()) as { events: Array<{ type: string; name?: string; output?: { exitCode?: number; stderr?: string } }> }
      const result = events.events.find((e) => e.type === "tool/result")
      expect(result, "the tool never ran — the turn failed for another reason").toBeDefined()
      expect(result?.output?.exitCode).not.toBe(0)
      expect(String(result?.output?.stderr ?? "")).toMatch(/denied|unauthorized/i)
    } finally {
      await server?.close()
      rmSync(root, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  }, 60_000)
})
