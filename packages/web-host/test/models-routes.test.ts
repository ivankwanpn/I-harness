import { describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CredentialRefError, CredentialShadowedError, type CredentialInfo } from "@i-harness/credentials"
import { ModelProbeFailedError, ProbeUnavailableError, type DirectoryEntry } from "@i-harness/provider"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { SettingsStore } from "@i-harness/settings"
import { createWebHost, type WebHost } from "../src/host.ts"
import type { CredentialStoreFace, ModelSources, ProviderRegistryFace } from "../src/types.ts"

// M27-H-1: branch models.spec.ts HTTP route cases ported (the pure fold unit
// cases already live in test/models.test.ts). The fixture drops the branch's
// `workspacePath` option; the model-sources seam pieces are exactly as the
// CLI composition feeds them.
async function withHost(
  run: (base: string, host: WebHost) => Promise<void>,
  modelSources?: ModelSources,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-models-"))
  const host = createWebHost({
    port: 0,
    ...(modelSources !== undefined ? { modelSources } : {}),
  })
  const { port } = await host.listen()
  try {
    await run(`http://127.0.0.1:${port}`, host)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** Real SettingsStore on a throwaway file (the sections routes need actual
 * normalize/redact/revision semantics to be worth testing). */
async function settingsStoreHost(
  run: (base: string, store: SettingsStore) => Promise<void>,
  extra?: Omit<ModelSources, "settingsStore">,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-models-settings-"))
  const store = new SettingsStore({ path: join(root, "settings.json") })
  try {
    await withHost((base) => run(base, store), { settingsStore: store, ...extra })
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function fakeCredentialStore(
  stored: Record<string, string> = {},
  envRefs: string[] = [],
  resolve?: (ref: string) => string | undefined,
): CredentialStoreFace {
  return {
    describe: vi.fn((refs: string[]) => {
      const out: Record<string, CredentialInfo> = {}
      for (const ref of refs) {
        if (!REF_RE.test(ref)) throw new CredentialRefError(`invalid credential ref ${JSON.stringify(ref)}`)
        if (envRefs.includes(ref)) out[ref] = { configured: true, source: "env", writable: false }
        else if (ref in stored) out[ref] = { configured: true, source: "file", writable: true }
        else out[ref] = { configured: false, source: "file", writable: true }
      }
      return out
    }),
    set: vi.fn(async (ref: string, value: string) => {
      if (!REF_RE.test(ref) || value.trim() === "") {
        throw new CredentialRefError("invalid credential ref/value")
      }
      if (envRefs.includes(ref)) throw new CredentialShadowedError(`credential ref ${ref} is env-provided`)
      stored[ref] = value
    }),
    unset: vi.fn(async (ref: string) => {
      if (!REF_RE.test(ref)) throw new CredentialRefError(`invalid credential ref ${JSON.stringify(ref)}`)
      if (envRefs.includes(ref)) throw new CredentialShadowedError(`credential ref ${ref} is env-provided`)
      delete stored[ref]
    }),
    ...(resolve !== undefined ? { resolve } : {}),
  }
}

const DEEPSEEK_ROW: DirectoryEntry = {
  route: "deepseek",
  displayName: "DeepSeek",
  protocol: "openai-compatible",
  defaultApiKeyEnv: "DEEPSEEK_API_KEY",
  defaultModel: "deepseek-v4-flash-vision-exp",
  models: [{ id: "deepseek-v4-flash-vision-exp" }, { id: "deepseek-chat" }],
}

function fakeRegistry(
  overrides: Partial<ProviderRegistryFace> = {},
  rows: DirectoryEntry[] = [DEEPSEEK_ROW],
): ProviderRegistryFace {
  return {
    describeDirectory: vi.fn((): DirectoryEntry[] => rows),
    probeModels: vi.fn(async (_route: string, _req: { baseURL?: string; apiKey?: string }) => [
      { id: "m1", name: "Model One" },
    ]),
    ...overrides,
  }
}

describe("models-sources seam HTTP routes (task 4, ported)", () => {
  it("seam absent → every model-sources route answers 404 (optional-seam semantics)", async () => {
    await withHost(async (base) => {
      const expectations: Array<[string, string, string | undefined]> = [
        ["GET", "/api/settings/sections?name=llm", undefined],
        ["POST", "/api/settings/mutate", JSON.stringify({ name: "llm", ops: [] })],
        ["GET", "/api/credentials?refs=DEEPSEEK_API_KEY", undefined],
        ["POST", "/api/credentials", JSON.stringify({ ref: "A", value: "b" })],
        ["DELETE", "/api/credentials/A", undefined],
        ["GET", "/api/llm/directory", undefined],
        ["POST", "/api/llm/probe", JSON.stringify({ route: "deepseek" })],
        ["POST", "/api/llm/probe-apply", JSON.stringify({ route: "deepseek" })],
        ["GET", "/api/models/catalog", undefined],
      ]
      for (const [method, path, body] of expectations) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body !== undefined ? { body } : {}),
        })
        expect(res.status, `${method} ${path}`).toBe(404)
      }
    })
  })

  it("per-piece seam: a missing settingsStore 404s only the settings/catalog routes", async () => {
    const credentials = fakeCredentialStore()
    const registry = fakeRegistry()
    await withHost(async (base) => {
      const sections = await fetch(`${base}/api/settings/sections?name=llm`)
      expect(sections.status).toBe(404)
      const mutate = await fetch(`${base}/api/settings/mutate`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "llm", ops: [] }),
      })
      expect(mutate.status).toBe(404)
      const catalog = await fetch(`${base}/api/models/catalog`)
      expect(catalog.status).toBe(404)
      const cred = await fetch(`${base}/api/credentials?refs=A`)
      expect(cred.status).toBe(200)
      const dir = await fetch(`${base}/api/llm/directory`)
      expect(dir.status).toBe(200)
      const probe = await fetch(`${base}/api/llm/probe`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route: "deepseek" }),
      })
      expect(probe.status).toBe(200)
    }, { credentialStore: credentials, providerRegistry: registry })
  })

  it("GET /api/settings/sections?name=llm answers the redacted merged SectionView (user-only, no built-in seeds)", async () => {
    await settingsStoreHost(async (base) => {
      const res = await fetch(`${base}/api/settings/sections?name=llm`)
      expect(res.status).toBe(200)
      const body = await res.json() as {
        section: {
          value: { providers: Record<string, unknown>; defaultModel: Record<string, unknown> }
          base: Record<string, unknown>
          user: Record<string, unknown>
          revision: number
          writable: boolean
        }
      }
      expect(body.section.value.providers).toEqual({})
      expect(body.section.value.providers.deepseek).toBeUndefined()
      expect(body.section.value.providers.anthropic).toBeUndefined()
      expect(body.section.value.defaultModel).toEqual({ provider: "", model: "" })
      expect((body.section.base as { providers: Record<string, unknown> }).providers).toEqual({})
      expect((body.section.user as { defaultModel: Record<string, unknown> }).defaultModel)
        .toEqual({ provider: "", model: "" })
      expect(body.section.revision).toBe(0)
      expect(body.section.writable).toBe(true)
    })
  })

  it("GET /api/settings/sections?name=core answers the legacy top-level keys only", async () => {
    await settingsStoreHost(async (base) => {
      const res = await fetch(`${base}/api/settings/sections?name=core`)
      expect(res.status).toBe(200)
      const body = await res.json() as { section: { name: string; value: Record<string, unknown>; writable: boolean } }
      expect(body.section.name).toBe("core")
      expect(body.section.value.theme).toBe("system")
      expect("llm" in body.section.value).toBe(false)
      expect("onboarding" in body.section.value).toBe(false)
    })
  })

  it("GET /api/settings/sections rejects an unknown/missing name (400 settings-section-invalid)", async () => {
    await settingsStoreHost(async (base) => {
      for (const query of ["", "?name=", "?name=unknown"]) {
        const res = await fetch(`${base}/api/settings/sections${query}`)
        expect(res.status, query).toBe(400)
        expect(((await res.json()) as { code: string }).code).toBe("settings-section-invalid")
      }
    })
  })

  it("POST /api/settings/mutate applies ops and answers the fresh view (revision bumps)", async () => {
    await settingsStoreHost(async (base) => {
      const res = await fetch(`${base}/api/settings/mutate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "llm",
          ops: [
            { op: "set", path: ["defaultModel", "model"], value: "deepseek-reasoner" },
            { op: "set", path: ["providers", "custom", "baseURL"], value: "https://proxy.example" },
          ],
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as {
        section: { value: { providers: Record<string, { baseURL: string }>; defaultModel: Record<string, string> }; revision: number }
      }
      expect(body.section.value.defaultModel.model).toBe("deepseek-reasoner")
      expect(body.section.value.providers.custom.baseURL).toBe("https://proxy.example")
      expect(body.section.revision).toBe(1)

      const unset = await fetch(`${base}/api/settings/mutate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "llm", ops: [{ op: "unset", path: ["defaultModel", "model"] }] }),
      })
      expect(unset.status).toBe(200)
      const ubody = await unset.json() as { section: { value: { defaultModel: Record<string, string> } } }
      expect(ubody.section.value.defaultModel).toEqual({ provider: "", model: "" })
    })
  })

  it("POST /api/settings/mutate answers 409 with {expected, actual} on a stale expectedRevision", async () => {
    await settingsStoreHost(async (base) => {
      const first = await fetch(`${base}/api/settings/mutate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "llm", ops: [{ op: "set", path: ["defaultModel", "model"], value: "deepseek-reasoner" }] }),
      })
      expect(first.status).toBe(200)
      const stale = await fetch(`${base}/api/settings/mutate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "llm", ops: [{ op: "set", path: ["defaultModel", "model"], value: "other" }], expectedRevision: 99 }),
      })
      expect(stale.status).toBe(409)
      const body = await stale.json() as { code: string; expected: number; actual: number }
      expect(body.code).toBe("settings-section-conflict")
      expect(body.expected).toBe(99)
      expect(body.actual).toBe(1)
    })
  })

  it("POST /api/settings/mutate 400 settings-mutate-invalid on malformed shapes (nothing written)", async () => {
    await settingsStoreHost(async (base) => {
      const cases = [
        { name: "llm" },
        { name: "llm", ops: "x" },
        { name: "llm", ops: [{ op: "set", path: ["defaultModel"] }] },
        { name: "llm", ops: [{ op: "zap", path: ["defaultModel"] }] },
        { name: "llm", ops: [{ op: "set", path: ["defaultModel", 1], value: "x" }] },
        { name: "llm", ops: [], expectedRevision: -1 },
        { name: "core", ops: [{ op: "set", path: ["theme"], value: "dark" }] },
      ]
      for (const payload of cases) {
        const res = await fetch(`${base}/api/settings/mutate`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
        })
        expect(res.status, JSON.stringify(payload)).toBe(400)
        expect(((await res.json()) as { code: string }).code, JSON.stringify(payload)).toBe("settings-mutate-invalid")
      }
      const after = await fetch(`${base}/api/settings/sections?name=llm`)
      const view = await after.json() as { section: { revision: number } }
      expect(view.section.revision).toBe(0)
    })
  })

  it("GET /api/credentials parses refs and answers the seam's describe verbatim", async () => {
    const credentials = fakeCredentialStore({ MY_KEY: "v" })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/credentials?refs=DEEPSEEK_API_KEY, MY_KEY`)
      expect(res.status).toBe(200)
      const body = await res.json() as {
        credentials: Record<string, { configured: boolean; source: string; writable: boolean }>
      }
      expect(body.credentials.DEEPSEEK_API_KEY).toEqual({ configured: false, source: "file", writable: true })
      expect(body.credentials.MY_KEY).toEqual({ configured: true, source: "file", writable: true })
      expect(credentials.describe).toHaveBeenCalledWith(["DEEPSEEK_API_KEY", "MY_KEY"])
      const empty = await fetch(`${base}/api/credentials`)
      expect(empty.status).toBe(200)
      expect(await empty.json()).toEqual({ credentials: {} })
    }, { credentialStore: credentials })
  })

  it("GET /api/credentials maps an invalid ref name to 400 credential-invalid-ref", async () => {
    const credentials = fakeCredentialStore()
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/credentials?refs=1bad-ref`)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe("credential-invalid-ref")
    }, { credentialStore: credentials })
  })

  it("POST /api/credentials writes the value and answers the one-way describe of the post-write state", async () => {
    const credentials = fakeCredentialStore()
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/credentials`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: "MY_KEY", value: "s3cret" }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ref: string; credential: { configured: boolean; source: string } }
      expect(body.ref).toBe("MY_KEY")
      expect(body.credential).toEqual({ configured: true, source: "file", writable: true })
      expect(credentials.set).toHaveBeenCalledWith("MY_KEY", "s3cret")
      expect(credentials.describe).toHaveBeenCalledWith(["MY_KEY"])
    }, { credentialStore: credentials })
  })

  it("POST /api/credentials maps env-shadowed to 400 credential-rejected and invalid to 400 credential-invalid-ref", async () => {
    const shadowed = fakeCredentialStore({}, ["SHADOWED_KEY"])
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/credentials`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: "SHADOWED_KEY", value: "x" }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe("credential-rejected")
    }, { credentialStore: shadowed })

    const invalid = fakeCredentialStore()
    await withHost(async (base) => {
      for (const payload of [{ ref: "MY_KEY", value: "" }, { ref: "1bad" }, {}, { value: "x" }]) {
        const res = await fetch(`${base}/api/credentials`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
        })
        expect(res.status, JSON.stringify(payload)).toBe(400)
        expect(((await res.json()) as { code: string }).code, JSON.stringify(payload)).toBe("credential-invalid-ref")
      }
      const badJson = await fetch(`${base}/api/credentials`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{nope",
      })
      expect(badJson.status).toBe(400)
      expect(((await badJson.json()) as { code: string }).code).toBe("credential-invalid-ref")
    }, { credentialStore: invalid })
  })

  it("DELETE /api/credentials/:ref unsets (idempotent) and maps ref/shadow errors to 400", async () => {
    const credentials = fakeCredentialStore({ MY_KEY: "v" })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/credentials/MY_KEY`, { method: "DELETE" })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ref: "MY_KEY" })
      expect(credentials.unset).toHaveBeenCalledWith("MY_KEY")
      const again = await fetch(`${base}/api/credentials/MY_KEY`, { method: "DELETE" })
      expect(again.status).toBe(200)
      const badRef = await fetch(`${base}/api/credentials/1bad`, { method: "DELETE" })
      expect(badRef.status).toBe(400)
      expect(((await badRef.json()) as { code: string }).code).toBe("credential-invalid-ref")
    }, { credentialStore: credentials })

    const shadowed = fakeCredentialStore({}, ["SHADOWED_KEY"])
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/credentials/SHADOWED_KEY`, { method: "DELETE" })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe("credential-rejected")
    }, { credentialStore: shadowed })
  })

  it("GET /api/llm/directory merges seed rows ⊕ user-section routes (declared ⊕ user)", async () => {
    const registry = fakeRegistry()
    await settingsStoreHost(async (base, store) => {
      await store.set({
        llm: {
          providers: {
            deepseek: { models: [{ id: "deepseek-chat" }, { id: "custom-deepseek", name: "Custom DS", contextWindow: 96_000, maxTokens: 8_192 }] },
            "custom-route": { displayName: "自定义网关", protocol: "anthropic-messages", apiKeyEnv: "CUSTOM_API_KEY" },
          },
          defaultModel: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" },
        },
      })
      const res = await fetch(`${base}/api/llm/directory`)
      expect(res.status).toBe(200)
      const body = await res.json() as { directory: Array<Record<string, unknown>> }
      const deepseek = body.directory.find((r) => r.route === "deepseek")!
      expect(deepseek.declared).toBe(true)
      expect(deepseek.user).toBe(true)
      expect(deepseek.models).toEqual([
        { id: "deepseek-v4-flash-vision-exp" },
        { id: "deepseek-chat" },
        { id: "custom-deepseek", name: "Custom DS", contextWindow: 96000, maxTokens: 8192 },
      ])
      const custom = body.directory.find((r) => r.route === "custom-route")!
      expect(custom).toMatchObject({
        route: "custom-route",
        protocol: "anthropic-messages",
        defaultApiKeyEnv: "CUSTOM_API_KEY",
        declared: false,
        user: true,
      })
    }, { providerRegistry: registry })
  })

  it("POST /api/llm/probe passes the unsaved draft verbatim plus the RESOLVED protocol", async () => {
    let received: unknown
    const registry = fakeRegistry({
      probeModels: vi.fn(async (route, req) => {
        received = { route, req }
        return [{ id: "m1", name: "Model One" }]
      }),
    })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/llm/probe`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "openai-compatible", baseURL: "https://proxy.example", apiKey: "sk-draft", protocol: "openai-responses" }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ models: [{ id: "m1", name: "Model One" }] })
      expect(received).toEqual({ route: "openai-compatible", req: { baseURL: "https://proxy.example", apiKey: "sk-draft", protocol: "openai-responses" } })
      const bare = await fetch(`${base}/api/llm/probe`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route: "deepseek" }),
      })
      expect(bare.status).toBe(200)
      expect(received).toMatchObject({ req: { protocol: "openai-completions" } })
    }, { providerRegistry: registry })
  })

  it("POST /api/llm/probe resolves a SAVED route's credential key (apiKeyEnv, env>file) when the draft omits/empties it; an explicit draft key still wins", async () => {
    let received: unknown
    const registry = fakeRegistry({
      probeModels: vi.fn(async (route, req) => {
        received = { route, req }
        return [{ id: "m1", name: "Model One" }]
      }),
    })
    const resolve = vi.fn((ref: string) => (ref === "DS_KEY" ? "sk-env-resolved" : undefined))
    const credentials = fakeCredentialStore({}, [], resolve)
    await settingsStoreHost(async (base, store) => {
      await store.set({
        llm: {
          providers: {
            "deepseek-gw": { baseURL: "https://g.example", protocol: "anthropic-messages", apiKeyEnv: "DS_KEY" },
          },
          defaultModel: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" },
        },
      })
      const bare = await fetch(`${base}/api/llm/probe`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "deepseek-gw" }),
      })
      expect(bare.status).toBe(200)
      expect(received).toMatchObject({ route: "deepseek-gw", req: { apiKey: "sk-env-resolved" } })
      expect(resolve).toHaveBeenCalledWith("DS_KEY")
      const emptyKey = await fetch(`${base}/api/llm/probe`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "deepseek-gw", apiKey: "" }),
      })
      expect(emptyKey.status).toBe(200)
      expect(received).toMatchObject({ req: { apiKey: "sk-env-resolved" } })
      const draftKey = await fetch(`${base}/api/llm/probe`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "deepseek-gw", apiKey: "sk-draft" }),
      })
      expect(draftKey.status).toBe(200)
      expect(received).toMatchObject({ req: { apiKey: "sk-draft" } })
      expect(resolve).toHaveBeenCalledTimes(2)
    }, { credentialStore: credentials, providerRegistry: registry })
  })

  it("POST /api/llm/probe rejects a missing route (400 probe-invalid) without calling the registry", async () => {
    const registry = fakeRegistry()
    await withHost(async (base) => {
      for (const payload of [{}, { route: "" }, { route: "  " }, { route: 42 }, { route: "x", protocol: 42 }]) {
        const res = await fetch(`${base}/api/llm/probe`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
        })
        expect(res.status, JSON.stringify(payload)).toBe(400)
        expect(((await res.json()) as { code: string }).code, JSON.stringify(payload)).toBe("probe-invalid")
      }
      expect(registry.probeModels).not.toHaveBeenCalled()
    }, { providerRegistry: registry })
  })

  it("POST /api/llm/probe maps probe failures to 400 with their own codes", async () => {
    const failed = fakeRegistry({
      probeModels: vi.fn(async () => { throw new ModelProbeFailedError("baseURL unreachable") }),
    })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/llm/probe`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route: "x" }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { code: string }
      expect(body.code).toBe("model-probe-failed")
    }, { providerRegistry: failed })

    const unavailable = fakeRegistry({
      probeModels: vi.fn(async () => { throw new ProbeUnavailableError("x") }),
    })
    await withHost(async (base) => {
      const res = await fetch(`${base}/api/llm/probe`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route: "x" }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe("probe-unavailable")
    }, { providerRegistry: unavailable })
  })

  it("probe-apply adopts discovered models into settings (upsert by id — overwrite + add, never delete)", async () => {
    const registry = fakeRegistry({
      probeModels: vi.fn(async (_route: string, _req: unknown) => [
        { id: "m1", name: "Model One", contextWindow: 64_000, maxTokens: 8_192 },
        { id: "m2-b", name: "Model Two", contextWindow: 128_000 },
      ]),
    })
    await settingsStoreHost(async (base, store) => {
      await store.set({
        llm: {
          providers: { r1: { models: [{ id: "m1", name: "Old", contextWindow: 32_000 }, { id: "custom-old" }] } },
          defaultModel: { provider: "", model: "" },
        },
      })
      const res = await fetch(`${base}/api/llm/probe-apply`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "r1", baseURL: "https://g.example" }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { adopted: number; models: Array<{ id: string; contextWindow?: number }>; fingerprint: string }
      expect(body.adopted).toBe(2)
      expect(body.models.map((m) => m.id)).toEqual(["m1", "m2-b"])
      await store.load()
      // Existing rows survive (no delete); the discovered m1 overwrote in place;
      // the brand-new m2-b was appended.
      expect(store.get().llm.providers.r1?.models).toEqual([
        { id: "m1", name: "Model One", contextWindow: 64000, maxTokens: 8192 },
        { id: "custom-old" },
        { id: "m2-b", name: "Model Two", contextWindow: 128000 },
      ])
    }, { providerRegistry: registry })
  })

  it("probe-apply probe failure → 400 and settings stay untouched (no half-write)", async () => {
    const registry = fakeRegistry({
      probeModels: vi.fn(async () => { throw new ModelProbeFailedError("baseURL unreachable") }),
    })
    await settingsStoreHost(async (base, store) => {
      await store.set({
        llm: {
          providers: { r1: { models: [{ id: "keep-me", contextWindow: 8_000 }] } },
          defaultModel: { provider: "", model: "" },
        },
      })
      const before = store.get().llm.providers.r1?.models
      const beforeRevision = store.getSectionRevision("llm")
      const res = await fetch(`${base}/api/llm/probe-apply`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "r1", baseURL: "https://bad.example" }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe("model-probe-failed")
      await store.load()
      expect(store.get().llm.providers.r1?.models).toEqual(before)
      expect(store.getSectionRevision("llm")).toBe(beforeRevision)
    }, { providerRegistry: registry })
  })

  it("probe-apply returns a deterministic route+baseURL+apiKey fingerprint and never echoes the key", async () => {
    const registry = fakeRegistry()
    await settingsStoreHost(async (base) => {
      const send = (apiKey: string) => fetch(`${base}/api/llm/probe-apply`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "r1", baseURL: "https://g.example", apiKey }),
      })
      const first = await send("sk-secret")
      expect(first.status).toBe(200)
      const b1 = await first.json() as { fingerprint: string; adopted: number; models: unknown[] }
      expect(b1.fingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(b1)).not.toContain("sk-secret")
      const again = await send("sk-secret")
      expect(((await again.json()) as { fingerprint: string }).fingerprint).toBe(b1.fingerprint)
      const other = await send("sk-other")
      expect(((await other.json()) as { fingerprint: string }).fingerprint).not.toBe(b1.fingerprint)
    }, { providerRegistry: registry })
  })

  it("probe-apply rejects a missing/mistyped route (400 probe-apply-invalid) without touching settings", async () => {
    const registry = fakeRegistry()
    await settingsStoreHost(async (base, store) => {
      for (const payload of [{}, { route: "" }, { route: 42 }, { route: "x", protocol: 42 }]) {
        const res = await fetch(`${base}/api/llm/probe-apply`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
        })
        expect(res.status, JSON.stringify(payload)).toBe(400)
        expect(((await res.json()) as { code: string }).code, JSON.stringify(payload)).toBe("probe-apply-invalid")
      }
      expect(registry.probeModels).not.toHaveBeenCalled()
      expect(store.get().llm.providers).toEqual({})
    }, { providerRegistry: registry })
  })

  it("GET /api/models/catalog answers {default, groups, failures}: default is the honest UNSET when nothing configured", async () => {
    const registry = fakeRegistry()
    await settingsStoreHost(async (base) => {
      const res = await fetch(`${base}/api/models/catalog`)
      expect(res.status).toBe(200)
      const body = await res.json() as {
        default: { provider: string; model: string }
        groups: Array<{ route: string; displayName: string; models: Array<{ id: string; name?: string }> }>
        failures: unknown[]
      }
      expect(body.default).toEqual({ provider: "", model: "" })
      expect(body.groups).toEqual([{
        route: "deepseek",
        displayName: "DeepSeek",
        models: [{ id: "deepseek-v4-flash-vision-exp" }, { id: "deepseek-chat" }],
      }])
      expect(body.failures).toEqual([])
    }, { providerRegistry: registry })
  })

  it("catalog merges user provider models (directory wins per id) and user-section routes become groups", async () => {
    const registry = fakeRegistry({}, [
      DEEPSEEK_ROW,
      { route: "openai-compatible", displayName: "OpenAI Compatible", protocol: "openai-compatible" },
    ])
    await settingsStoreHost(async (base, store) => {
      await store.set({
        llm: {
          providers: {
            deepseek: {
              displayName: "我的 DeepSeek",
              models: [{ id: "deepseek-chat" }, { id: "custom-deepseek", name: "Custom DS", contextWindow: 96_000, maxTokens: 8_192 }],
            },
            "custom-route": { baseURL: "https://custom.example" },
          },
          defaultModel: { provider: "deepseek", model: "custom-model" },
        },
      })
      const res = await fetch(`${base}/api/models/catalog`)
      expect(res.status).toBe(200)
      const body = await res.json() as {
        default: Record<string, unknown>
        groups: Array<{ route: string; displayName: string; models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }> }>
        failures: Array<{ route: string; reason: string }>
      }
      expect(body.default).toEqual({ provider: "deepseek", model: "custom-model" })
      const deepseek = body.groups.find((g) => g.route === "deepseek")!
      expect(deepseek.displayName).toBe("我的 DeepSeek")
      expect(deepseek.models).toEqual([
        { id: "deepseek-v4-flash-vision-exp" },
        { id: "deepseek-chat" },
        { id: "custom-deepseek", name: "Custom DS", contextWindow: 96000, maxTokens: 8192 },
      ])
      const custom = body.groups.find((g) => g.route === "custom-route")!
      expect(custom.displayName).toBe("custom-route")
      expect(custom.models).toEqual([])
      expect(body.failures).toEqual([])
      expect(body.groups.find((g) => g.route === "openai-compatible")).toBeTruthy()
    }, { providerRegistry: registry })
  })

  it("catalog default reflects a mutateSection llm.defaultModel write (default comes from the section view)", async () => {
    const registry = fakeRegistry()
    await settingsStoreHost(async (base) => {
      const set = await fetch(`${base}/api/settings/mutate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "llm", ops: [
          { op: "set", path: ["defaultModel", "provider"], value: "deepseek" },
          { op: "set", path: ["defaultModel", "model"], value: "deepseek-reasoner" },
        ] }),
      })
      expect(set.status).toBe(200)
      const res = await fetch(`${base}/api/models/catalog`)
      const body = await res.json() as { default: Record<string, unknown> }
      expect(body.default).toEqual({ provider: "deepseek", model: "deepseek-reasoner" })
    }, { providerRegistry: registry })
  })

  describe("per-session model route (Task 5, ported)", () => {
    it("200 writes modelSelection durably; the list row carries it without any modelSources piece", async () => {
      const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-session-model-"))
      const coordinator = createSessionCoordinator(createJsonlBackend(root))
      const host = createWebHost({ port: 0, coordinator })
      const { port } = await host.listen()
      try {
        const base = `http://127.0.0.1:${port}`
        const created = await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: process.cwd() }),
        })
        expect(created.status).toBe(200)
        const { id } = (await created.json()) as { id: string }
        const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/model`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "high" }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
          modelSelection: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "high" },
        })
        const list = (await (await fetch(`${base}/api/sessions`)).json()) as {
          sessions: Array<{ id: string; modelSelection?: unknown }>
        }
        expect(list.sessions.find((s) => s.id === id)?.modelSelection)
          .toEqual({ provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "high" })
        const verifier = createSessionCoordinator(createJsonlBackend(root))
        try {
          const { meta } = await verifier.profile(id)
          expect(meta.modelSelection).toEqual({ provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "high" })
        } finally {
          await verifier.close()
        }
      } finally {
        await host.close()
        await coordinator.close()
        await rm(root, { recursive: true, force: true }).catch(() => {})
      }
    })

    it("400 rejects shape junk (never a silent normalize), 404 unknown session", async () => {
      const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-session-model-"))
      const coordinator = createSessionCoordinator(createJsonlBackend(root))
      const host = createWebHost({ port: 0, coordinator })
      const { port } = await host.listen()
      try {
        const base = `http://127.0.0.1:${port}`
        const created = await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: process.cwd() }),
        })
        const { id } = (await created.json()) as { id: string }
        const send = async (body: unknown): Promise<Response> =>
          fetch(`${base}/api/sessions/${encodeURIComponent(id)}/model`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        expect((await send({ model: "m1" })).status).toBe(400)
        expect((await send({ provider: "p", model: "" })).status).toBe(400)
        expect((await send({ provider: "p", model: "m", reasoningEffort: "" })).status).toBe(400)
        expect((await send({ provider: 42, model: "m" })).status).toBe(400)
        const ghost = await fetch(`${base}/api/sessions/ghost/model`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "p", model: "m" }),
        })
        expect(ghost.status).toBe(404)
      } finally {
        await host.close()
        await coordinator.close()
        await rm(root, { recursive: true, force: true }).catch(() => {})
      }
    })
  })
})
