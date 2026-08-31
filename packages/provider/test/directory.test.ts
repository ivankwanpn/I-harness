import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ModelProbeFailedError,
  ProbeUnavailableError,
  createProviderRegistry,
  defaultProviderRegistry,
  describeDirectory,
  probeCandidatePaths,
  probeModels,
  registerProbe,
} from "../src/index.ts"

const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }))

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

describe("provider directory view", () => {
  it("describes the registry as a directory — route/displayName/protocol/defaultApiKeyEnv, no credentials leak", () => {
    const reg = createProviderRegistry()
    reg.register({
      name: "deepseek",
      displayName: "DeepSeek",
      protocol: "openai-compatible",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      defaultModel: "deepseek-chat",
      models: ["deepseek-chat", "deepseek-reasoner"],
      baseUrl: "https://api.deepseek.com",
      apiKey: "hunter2",
    })
    reg.register({
      name: "anthropic",
      displayName: "Anthropic",
      protocol: "anthropic-messages",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    })
    const entries = reg.describeDirectory()
    // list() insertion order — the view is the registry, no separate sorting
    expect(entries.map((e) => e.route)).toEqual(["deepseek", "anthropic"])
    expect(entries[0]).toEqual({
      route: "deepseek",
      displayName: "DeepSeek",
      protocol: "openai-compatible",
      defaultApiKeyEnv: "DEEPSEEK_API_KEY",
      defaultModel: "deepseek-chat",
      models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
    })
    // The directory is the UI-facing view — runtime credentials never surface.
    expect("apiKey" in entries[0]!).toBe(false)
    expect("baseUrl" in entries[0]!).toBe(false)
    expect("apiKeyEnv" in entries[0]!).toBe(false) // surfaced as defaultApiKeyEnv only
    expect(entries[1]).toEqual({
      route: "anthropic",
      displayName: "Anthropic",
      protocol: "anthropic-messages",
      defaultApiKeyEnv: "ANTHROPIC_API_KEY",
    })
  })

  it("omits defaultApiKeyEnv/defaultModel/models when the profile does not declare them", () => {
    const reg = createProviderRegistry()
    reg.register({ name: "openai", displayName: "OpenAI", protocol: "openai-responses" })
    expect(reg.describeDirectory()).toEqual([
      { route: "openai", displayName: "OpenAI", protocol: "openai-responses" },
    ])
  })
})

describe("probeModels", () => {
  it("falls back to the profile's static catalog when no probe is registered (deepseek), without any fetch", async () => {
    vi.stubGlobal("fetch", fetchMock)
    const reg = createProviderRegistry()
    reg.register({
      name: "deepseek",
      displayName: "DeepSeek",
      protocol: "openai-compatible",
      models: ["deepseek-v4-flash-vision-exp", "deepseek-v4-pro"],
    })
    const models = await reg.probeModels("deepseek", {})
    expect(models).toEqual([{ id: "deepseek-v4-flash-vision-exp" }, { id: "deepseek-v4-pro" }])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("openai-compatible route probes GET {baseURL}/v1/models (root-only baseURL) with Bearer apiKey and parses {data:[{id}]}", async () => {
    const okFetch = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] }), { status: 200 }),
    )
    vi.stubGlobal("fetch", okFetch)
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "Custom (OpenAI-compatible)", protocol: "openai-compatible" })
    const models = await reg.probeModels("openai-compatible", { baseURL: "https://api.example.com", apiKey: "sk-123" })
    expect(okFetch).toHaveBeenCalledWith("https://api.example.com/v1/models", {
      headers: { Authorization: "Bearer sk-123" },
      signal: expect.any(AbortSignal),
    })
    expect(models).toEqual([{ id: "gpt-5" }, { id: "gpt-5-mini" }])
  })

  it("passes a server-supplied name through when the models feed carries one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "m1", name: "Model One" }, { id: "m2" }] }), { status: 200 }),
    ))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    const models = await reg.probeModels("openai-compatible", { baseURL: "https://x/v1", apiKey: "k" })
    expect(models).toEqual([{ id: "m1", name: "Model One" }, { id: "m2" }])
  })

  it("uses the registered profile's baseUrl/apiKey when the request carries no draft", async () => {
    const okFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 }),
    )
    vi.stubGlobal("fetch", okFetch)
    const reg = createProviderRegistry()
    reg.register({
      name: "openai-compatible",
      displayName: "X",
      protocol: "openai-compatible",
      baseUrl: "https://api.example.com",
      apiKey: "sk-profile",
    })
    expect(await reg.probeModels("openai-compatible", {})).toEqual([{ id: "gpt-5" }])
    expect(okFetch).toHaveBeenCalledWith("https://api.example.com/v1/models", {
      headers: { Authorization: "Bearer sk-profile" },
      signal: expect.any(AbortSignal),
    })
  })

  it("registerProbe overrides the built-in probe for a route (last registration wins)", async () => {
    vi.stubGlobal("fetch", fetchMock)
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    reg.registerProbe("openai-compatible", async () => [{ id: "fake-v0" }])
    expect(await reg.probeModels("openai-compatible", { baseURL: "https://x/v1" })).toEqual([{ id: "fake-v0" }])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("no probe + no static catalog → ProbeUnavailableError with code probe-unavailable", async () => {
    const reg = createProviderRegistry()
    reg.register({
      name: "anthropic",
      displayName: "Anthropic",
      protocol: "anthropic-messages",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    })
    const error = await reg.probeModels("anthropic", {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProbeUnavailableError)
    const pe = error as ProbeUnavailableError
    expect(pe.code).toBe("probe-unavailable")
    expect(pe.route).toBe("anthropic")
  })

  it("unknown route → ProbeUnavailableError as well", async () => {
    const reg = createProviderRegistry()
    await expect(reg.probeModels("nope", {})).rejects.toBeInstanceOf(ProbeUnavailableError)
  })

  it("openai-compatible probe without any baseURL fails loudly", async () => {
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    await expect(reg.probeModels("openai-compatible", {})).rejects.toThrow(/baseURL/i)
  })
})

describe("probe robustness (fix round 1)", () => {
  it("fetch receives an abort signal; timeout rejections are branded model-probe-failed", async () => {
    const timedOut = vi.fn((_url: string, _init: RequestInit) =>
      Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    )
    vi.stubGlobal("fetch", timedOut)
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    await expect(reg.probeModels("openai-compatible", { baseURL: "https://x", apiKey: "k" }))
      .rejects.toMatchObject({ code: "model-probe-failed", message: expect.stringMatching(/timed out/) })
    // the 10_000 ms timeout is wired into the probe fetch
    expect(timedOut).toHaveBeenCalledWith("https://x/v1/models", expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it("rejects non-http(s) or unparseable baseURL with the branded error, never a bare TypeError", async () => {
    vi.stubGlobal("fetch", fetchMock)
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    await expect(reg.probeModels("openai-compatible", { baseURL: "ftp://example.com" }))
      .rejects.toBeInstanceOf(ModelProbeFailedError)
    await expect(reg.probeModels("openai-compatible", { baseURL: "not a url" }))
      .rejects.toMatchObject({ code: "model-probe-failed", message: expect.stringMatching(/invalid baseURL/) })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("normalizes a trailing slash on baseURL (never builds //v1/models)", async () => {
    const okFetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 }))
    vi.stubGlobal("fetch", okFetch)
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    await reg.probeModels("openai-compatible", { baseURL: "https://api.example.com/", apiKey: "k" })
    expect(okFetch).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.anything())
  })

  it("null/undefined data entries fail with the clean branded id error, not a TypeError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "ok" }, null, undefined] }), { status: 200 }),
    ))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    await expect(reg.probeModels("openai-compatible", { baseURL: "https://x/v1", apiKey: "k" }))
      .rejects.toMatchObject({ code: "model-probe-failed", message: expect.stringMatching(/model entry missing id/) })
  })

  it("falls back to the static catalog when no baseURL is available (offline custom route)", async () => {
    vi.stubGlobal("fetch", fetchMock)
    const reg = createProviderRegistry()
    reg.register({
      name: "openai-compatible",
      displayName: "X",
      protocol: "openai-compatible",
      models: ["static-model"],
    })
    expect(await reg.probeModels("openai-compatible", {})).toEqual([{ id: "static-model" }])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("every probe failure carries the model-probe-failed code and class", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    const error = await reg.probeModels("openai-compatible", { baseURL: "https://x/v1" }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelProbeFailedError)
    expect((error as ModelProbeFailedError).code).toBe("model-probe-failed")
  })

  // Fix round 2: a 2xx with a NON-JSON body (error-page HTML, proxy message)
  // used to escape response.json()'s bare SyntaxError → an unbranded 500 over
  // POST /api/llm/probe. It must be branded like every other probe failure.
  it("2xx with a non-JSON body (error page) rejects branded, not a bare SyntaxError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("<html><body>bad gateway proxy page</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    const error = await reg.probeModels("openai-compatible", { baseURL: "https://x/v1", apiKey: "k" })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelProbeFailedError)
    expect((error as ModelProbeFailedError).code).toBe("model-probe-failed")
    expect((error as ModelProbeFailedError).message).toMatch(/body is not JSON — expected \{data:\[\{id\}\]\}/)
  })
})

describe("protocol-aware probe (task 2)", () => {
  it("anthropic-messages → x-api-key + anthropic-version headers, never Authorization", async () => {
    const probeFetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude-sonnet" }] }), { status: 200 }))
    vi.stubGlobal("fetch", probeFetch)
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    const models = await reg.probeModels("openai-compatible", {
      baseURL: "https://g.example",
      apiKey: "sk-a",
      protocol: "anthropic-messages",
    })
    expect(models).toEqual([{ id: "claude-sonnet" }])
    expect(probeFetch).toHaveBeenCalledWith("https://g.example/v1/models", {
      headers: { "x-api-key": "sk-a", "anthropic-version": "2023-06-01" },
      signal: expect.any(AbortSignal),
    })
  })

  it("openai-completions and openai-responses → Bearer Authorization (takes both spellings)", async () => {
    for (const protocol of [undefined, "openai-completions", "openai-responses"]) {
      const probeFetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }))
      vi.stubGlobal("fetch", probeFetch)
      const reg = createProviderRegistry()
      reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
      await reg.probeModels("openai-compatible", {
        baseURL: "https://g.example",
        apiKey: "sk-b",
        ...(protocol !== undefined ? { protocol } : {}),
      })
      expect(probeFetch).toHaveBeenCalledWith("https://g.example/v1/models", {
        headers: { Authorization: "Bearer sk-b" },
        signal: expect.any(AbortSignal),
      })
      vi.unstubAllGlobals()
    }
  })

  it("absent/empty apiKey omits the auth header entirely (never `Bearer undefined`)", async () => {
    const openaiFetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }))
    vi.stubGlobal("fetch", openaiFetch)
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    await reg.probeModels("openai-compatible", { baseURL: "https://g.example", protocol: "openai-completions" })
    expect(openaiFetch).toHaveBeenCalledWith("https://g.example/v1/models", {
      headers: {},
      signal: expect.any(AbortSignal),
    })
    vi.unstubAllGlobals()
    const anthropicFetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }))
    vi.stubGlobal("fetch", anthropicFetch)
    await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "", protocol: "anthropic-messages" })
    expect(anthropicFetch).toHaveBeenCalledWith("https://g.example/v1/models", {
      headers: { "anthropic-version": "2023-06-01" },
      signal: expect.any(AbortSignal),
    })
  })

  it("terminal protocol fallback is openai-completions (Bearer) when req.protocol is absent", async () => {
    const probeFetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }))
    vi.stubGlobal("fetch", probeFetch)
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" })
    expect(probeFetch).toHaveBeenCalledWith("https://g.example/v1/models", {
      headers: { Authorization: "Bearer k" },
      signal: expect.any(AbortSignal),
    })
  })
})

describe("dual-candidate probe (task 2)", () => {
  it("tries {base}/v1/models first; a 404 advances to {base}/models and wins", async () => {
    const urls: string[] = []
    const probeFetch = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), { status: 404 })
      }
      return new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 })
    })
    vi.stubGlobal("fetch", probeFetch)
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    // trailing slash normalized — the candidates are always base + "/v1/models" and "/models"
    const models = await reg.probeModels("openai-compatible", { baseURL: "https://g.example/", apiKey: "k" })
    expect(urls).toEqual(["https://g.example/v1/models", "https://g.example/models"])
    expect(models).toEqual([{ id: "gpt-5" }])
  })

  it("405 and 500 advance to the sibling candidate as well (any HTTP error status)", async () => {
    for (const status of [405, 500]) {
      const urls: string[] = []
      const probeFetch = vi.fn(async (url: string) => {
        urls.push(url)
        if (url.endsWith("/v1/models")) return new Response("nope", { status })
        return new Response(JSON.stringify({ models: [{ id: "m" }] }), { status: 200 })
      })
      vi.stubGlobal("fetch", probeFetch)
      const reg = createProviderRegistry()
      reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
      expect(await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
        .toEqual([{ id: "m" }])
      expect(urls).toEqual(["https://g.example/v1/models", "https://g.example/models"])
      vi.unstubAllGlobals()
    }
  })

  it("transport failures stop after the first candidate (same host — no second 10s wait)", async () => {
    const probeFetch = vi.fn((_url: string, _init: RequestInit) =>
      Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    )
    vi.stubGlobal("fetch", probeFetch)
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    await expect(reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
      .rejects.toMatchObject({ code: "model-probe-failed", message: expect.stringMatching(/timed out/) })
    expect(probeFetch).toHaveBeenCalledTimes(1)
    expect(probeFetch).toHaveBeenCalledWith("https://g.example/v1/models", expect.anything())
  })

  it("every candidate failing → branded error naming BOTH attempted URLs", async () => {
    const probeFetch = vi.fn(async () => new Response("nope", { status: 404 }))
    vi.stubGlobal("fetch", probeFetch)
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    const error = await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelProbeFailedError)
    expect((error as ModelProbeFailedError).code).toBe("model-probe-failed")
    const message = (error as ModelProbeFailedError).message
    expect(message).toContain("https://g.example/v1/models → 404")
    expect(message).toContain("https://g.example/models → 404")
  })
})

describe("compat-suffix candidate stripping (bug fix 3)", () => {
  // DeepSeek's Anthropic-compat endpoint lives at {root}/anthropic, but its
  // models endpoint is at the STRIPPED ROOT ({root}/v1/models or {root}/models).
  // Both /anthropic candidates 404/401 → the probe must advance to the
  // stripped-root candidates (suffix candidates first, then root).
  it("a base ending in /anthropic ALSO tries {root}/v1/models and {root}/models (suffix first, root last)", async () => {
    const urls: string[] = []
    const probeFetch = vi.fn(async (url: string) => {
      urls.push(url)
      if (url === "https://api.deepseek.com/models") {
        return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-toggle" }] }), { status: 200 })
      }
      return new Response("nope", { status: 404 })
    })
    vi.stubGlobal("fetch", probeFetch)
    const reg = createProviderRegistry()
    const models = await reg.probeModels("openai-compatible", {
      baseURL: "https://api.deepseek.com/anthropic",
      apiKey: "k",
    })
    expect(urls).toEqual([
      "https://api.deepseek.com/anthropic/v1/models",
      "https://api.deepseek.com/anthropic/models",
      "https://api.deepseek.com/v1/models",
      "https://api.deepseek.com/models",
    ])
    expect(models).toEqual([{ id: "deepseek-v4-toggle" }])
  })

  it("both /anthropic candidates failing → the stripped-root /models candidate wins (the real endpoint)", async () => {
    const urls: string[] = []
    const probeFetch = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes("/anthropic/")) return new Response("auth required", { status: 401 })
      if (url.endsWith("/v1/models")) return new Response("nope", { status: 404 })
      return new Response(JSON.stringify({ models: [{ id: "deepseek-chat" }] }), { status: 200 })
    })
    vi.stubGlobal("fetch", probeFetch)
    const reg = createProviderRegistry()
    const models = await reg.probeModels("openai-compatible", {
      baseURL: "https://api.deepseek.com/anthropic",
      apiKey: "k",
    })
    expect(urls).toEqual([
      "https://api.deepseek.com/anthropic/v1/models",
      "https://api.deepseek.com/anthropic/models",
      "https://api.deepseek.com/v1/models",
      "https://api.deepseek.com/models",
    ])
    expect(models).toEqual([{ id: "deepseek-chat" }])
  })

  it("a base with /v1 already keeps the existing dual candidates (no compat suffix → no root stripping)", async () => {
    const urls: string[] = []
    const probeFetch = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.endsWith("/v1/v1/models")) return new Response("nope", { status: 404 })
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 })
    })
    vi.stubGlobal("fetch", probeFetch)
    const reg = createProviderRegistry()
    await reg.probeModels("openai-compatible", { baseURL: "https://api.example.com/v1", apiKey: "k" })
    expect(urls).toEqual(["https://api.example.com/v1/v1/models", "https://api.example.com/v1/models"])
  })

  it("every known Claude-compat suffix (cc-switch KNOWN_COMPAT_SUFFIXES) strips to the same root candidates", () => {
    const expected = ["<root>/v1/models", "<root>/models"]
    const cases: Array<[string, string]> = [
      ["https://h/api.example/anthropic", "https://h/api.example"],
      ["https://h/api.example/api/claudecode", "https://h/api.example"],
      ["https://h/api.example/api/anthropic", "https://h/api.example/api"],
      ["https://h/api.example/api/coding", "https://h/api.example"],
      ["https://h/api.example/claude", "https://h/api.example"],
      ["https://h/api.example/step_plan", "https://h/api.example"],
      ["https://h/api.example/apps/anthropic", "https://h/api.example/apps"],
    ]
    for (const [base, root] of cases) {
      expect(probeCandidatePaths(base)).toEqual([
        `${base}/v1/models`,
        `${base}/models`,
        ...expected.map((p) => p.replace("<root>", root)),
      ])
    }
  })

  it("a base without a compat suffix yields exactly the existing dual candidates", () => {
    expect(probeCandidatePaths("https://h")).toEqual(["https://h/v1/models", "https://h/models"])
  })
})

describe("custom-route live probe (task 7 — D4 fix: explicit draft probes ANY route)", () => {
  it("custom route (never registered, no static catalog) live-discovers with the draft baseURL + protocol headers", async () => {
    const anthropicFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "claude-x" }] }), { status: 200 }),
    )
    vi.stubGlobal("fetch", anthropicFetch)
    const reg = createProviderRegistry()
    const models = await reg.probeModels("acme-gw", {
      baseURL: "https://g.example",
      apiKey: "sk-a",
      protocol: "anthropic-messages",
    })
    expect(models).toEqual([{ id: "claude-x" }])
    // protocol-aware headers per the req's protocol — the route gate is gone
    expect(anthropicFetch).toHaveBeenCalledWith("https://g.example/v1/models", {
      headers: { "x-api-key": "sk-a", "anthropic-version": "2023-06-01" },
      signal: expect.any(AbortSignal),
    })
  })

  it("openai-completions and openai-responses apply Bearer on a custom route too", async () => {
    for (const protocol of ["openai-completions", "openai-responses"] as const) {
      const probeFetch = vi.fn(async () => new Response(JSON.stringify({ models: [{ id: "m1" }] }), { status: 200 }))
      vi.stubGlobal("fetch", probeFetch)
      const reg = createProviderRegistry()
      await reg.probeModels("acme-gw", { baseURL: "https://g.example", apiKey: "sk-b", protocol })
      expect(probeFetch).toHaveBeenCalledWith("https://g.example/v1/models", {
        headers: { Authorization: "Bearer sk-b" },
        signal: expect.any(AbortSignal),
      })
      vi.unstubAllGlobals()
    }
  })

  it("the dual candidate paths apply on a custom route: /v1/models 404 advances to /models", async () => {
    const urls: string[] = []
    const probeFetch = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.endsWith("/v1/models")) return new Response("nope", { status: 404 })
      return new Response(JSON.stringify({ items: [{ id: "m2" }, { id: "m1", name: "M One" }] }), { status: 200 })
    })
    vi.stubGlobal("fetch", probeFetch)
    const reg = createProviderRegistry()
    const models = await reg.probeModels("acme-gw", { baseURL: "https://g.example", apiKey: "k" })
    expect(urls).toEqual(["https://g.example/v1/models", "https://g.example/models"])
    expect(models).toEqual([{ id: "m2" }, { id: "m1", name: "M One" }])
  })

  it("record-map shape works on a custom route (both response shapes for ANY route)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        "acme-a": { name: "Acme A", contextWindow: 96000 },
        "acme-b": null,
      }), { status: 200 }),
    ))
    const reg = createProviderRegistry()
    expect(await reg.probeModels("acme-gw", { baseURL: "https://g.example", apiKey: "k" })).toEqual([
      { id: "acme-a", name: "Acme A", contextWindow: 96000 },
      { id: "acme-b" },
    ])
  })

  it("no draft, no registered profile → ProbeUnavailableError (route-based preview flow preserved)", async () => {
    const reg = createProviderRegistry()
    await expect(reg.probeModels("acme-gw", {})).rejects.toBeInstanceOf(ProbeUnavailableError)
  })

  it("an empty-string draft baseURL is NOT an explicit draft: route-based flow keeps the static catalog", async () => {
    vi.stubGlobal("fetch", fetchMock)
    const reg = createProviderRegistry()
    reg.register({ name: "my-gw", displayName: "X", protocol: "openai-compatible", models: ["static-1"] })
    expect(await reg.probeModels("my-gw", { baseURL: "" })).toEqual([{ id: "static-1" }])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("route-based preview flow does NOT widen to arbitrary registered profiles: bare probe → ProbeUnavailable (only the explicit-draft path probes)", async () => {
    vi.stubGlobal("fetch", fetchMock)
    const reg = createProviderRegistry()
    reg.register({
      name: "groq",
      displayName: "Groq",
      protocol: "openai-compatible",
      baseUrl: "https://api.groq.example",
      apiKey: "sk-profile-groq",
    })
    // Omitted draft fields → the route-based flow (openai-compatible route's
    // built-in probe + static catalogs) — a registered profile's baseUrl alone
    // does NOT turn it into a live probe; the explicit draft path is D4's.
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible", apiKey: "sk-other" })
    await expect(reg.probeModels("groq", {})).rejects.toBeInstanceOf(ProbeUnavailableError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("probe response normalization (task 2)", () => {
  it("accepts a bare array of model objects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify([{ id: "m1" }, { id: "m2", display_name: "M Two" }]), { status: 200 }),
    ))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    expect(await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
      .toEqual([{ id: "m1" }, { id: "m2", name: "M Two" }])
  })

  it("accepts {models:[...]} and {items:[...]} containers besides {data:[...]}", async () => {
    for (const key of ["models", "items"]) {
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response(JSON.stringify({ [key]: [{ id: "m" }] }), { status: 200 }),
      ))
      const reg = createProviderRegistry()
      reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
      expect(await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
        .toEqual([{ id: "m" }])
      vi.unstubAllGlobals()
    }
  })

  it("accepts record maps — id from the key, name from the value (or a string value)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        "gpt-5": { name: "GPT-5", contextWindow: 128000 },
        "deepseek-chat": "DeepSeek Chat",
        opus: null,
      }), { status: 200 }),
    ))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    expect(await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
      .toEqual([
        { id: "gpt-5", name: "GPT-5", contextWindow: 128000 },
        { id: "deepseek-chat", name: "DeepSeek Chat" },
        { id: "opus" },
      ])
  })

  it("accepts a record map under a container key ({models:{…}})", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ models: { "m1": { displayName: "M One" }, "m2": {} } }), { status: 200 }),
    ))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    expect(await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
      .toEqual([{ id: "m1", name: "M One" }, { id: "m2" }])
  })

  it("infers id from id|slug|model|name (first present wins)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [
        { slug: "s1" },
        { model: "m2", display_name: "M Two" },
        { name: "n3" },
        { id: "i4", label: "I Four" },
      ] }), { status: 200 }),
    ))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    expect(await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
      .toEqual([{ id: "s1" }, { id: "m2", name: "M Two" }, { id: "n3", name: "n3" }, { id: "i4", name: "I Four" }])
  })

  it("maps display_name|displayName|label|name to the descriptor name (precedence in that order)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [
        { id: "a", display_name: "A", label: "overridden" },
        { id: "b", displayName: "B" },
        { id: "c", label: "C" },
        { id: "d", name: "D" },
        { id: "e" },
      ] }), { status: 200 }),
    ))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    expect(await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
      .toEqual([
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
        { id: "d", name: "D" },
        { id: "e" },
      ])
  })

  it("parses capacity from top-level contextWindow/maxTokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "a", contextWindow: 200000, maxTokens: 16384 }] }), { status: 200 }),
    ))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    expect(await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
      .toEqual([{ id: "a", contextWindow: 200000, maxTokens: 16384 }])
  })

  it("parses the limit context/output pair atomically (both-or-neither; top-level wins per field)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [
        { id: "a", limit: { context: 100000, output: 8000 } },
        { id: "b", limit: { context: 50000 } },      // incomplete pair → neither
        { id: "c", limit: { output: 3000 } },        // incomplete pair → neither
        { id: "d", contextWindow: 1, limit: { context: 2, output: 3 } }, // top-level wins per field
      ] }), { status: 200 }),
    ))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    expect(await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
      .toEqual([
        { id: "a", contextWindow: 100000, maxTokens: 8000 },
        { id: "b" },
        { id: "c" },
        { id: "d", contextWindow: 1, maxTokens: 3 },
      ])
  })

  it("drops non-positive-integer capacities (0, negatives, floats, junk); integer strings parse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [
        { id: "a", contextWindow: 0, maxTokens: -1 },
        { id: "b", contextWindow: 1.5 },
        { id: "c", contextWindow: "100k" },
        { id: "d", contextWindow: "64000" },
        // the POSITIVE contract: "0" parses to 0 — must be dropped, not kept
        { id: "e", contextWindow: "0", maxTokens: "0" },
        { id: "f", contextWindow: "1", maxTokens: "4096" },
      ] }), { status: 200 }),
    ))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    expect(await reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
      .toEqual([
        { id: "a" },
        { id: "b" },
        { id: "c" },
        { id: "d", contextWindow: 64000 },
        { id: "e" },
        { id: "f", contextWindow: 1, maxTokens: 4096 },
      ])
  })

  it("container present but not an array/object → branded shape failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: 42 }), { status: 200 })))
    const reg = createProviderRegistry()
    reg.register({ name: "openai-compatible", displayName: "X", protocol: "openai-compatible" })
    await expect(reg.probeModels("openai-compatible", { baseURL: "https://g.example", apiKey: "k" }))
      .rejects.toMatchObject({ code: "model-probe-failed" })
  })
})

describe("module-level directory/probe API", () => {
  it("describeDirectory/probeModels/registerProbe operate on the module default registry", async () => {
    defaultProviderRegistry().register({
      name: "module-static",
      displayName: "Module Static",
      protocol: "anthropic-messages",
      apiKeyEnv: "MODULE_STATIC_KEY",
      models: ["a-model", "b-model"],
    })
    const entry = describeDirectory().find((e) => e.route === "module-static")
    expect(entry).toEqual({
      route: "module-static",
      displayName: "Module Static",
      protocol: "anthropic-messages",
      defaultApiKeyEnv: "MODULE_STATIC_KEY",
      models: [{ id: "a-model" }, { id: "b-model" }],
    })
    expect(await probeModels("module-static", {})).toEqual([{ id: "a-model" }, { id: "b-model" }])
    registerProbe("module-static", async () => [{ id: "dynamic-probe" }])
    expect(await probeModels("module-static", {})).toEqual([{ id: "dynamic-probe" }])
  })
})
