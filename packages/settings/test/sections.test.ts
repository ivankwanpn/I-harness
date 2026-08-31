import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SettingsStore,
  normalizeSettings,
  SETTINGS_DEFAULTS,
} from "../src/index.ts"
import {
  describeSection,
  mutateSection,
  redactForSchema,
  resolveProviderProtocol,
  SEEDED_PROTOCOLS,
  SettingsConflictError,
  type SectionOp,
  type SectionSchema,
} from "../src/index.ts"

/** Test-local accessor for the unknown-typed view layers. */
type AnyRecord = Record<string, any>

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ih-sections-"))
}

async function newStore(): Promise<{ store: SettingsStore; file: string; root: string }> {
  const root = await tmpRoot()
  const file = join(root, "settings.json")
  const store = new SettingsStore({ path: file })
  await store.load()
  return { store, file, root }
}

describe("new keys default without migration (old file loads fine)", () => {
  it("old file without llm/onboarding loads with section defaults; top-level keys untouched", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    await writeFile(
      file,
      JSON.stringify({ theme: "dark", sandboxMode: "read-only", fontSize: 15, plugins: { bash: false } }),
    )
    const store = new SettingsStore({ path: file })
    await store.load()
    expect(store.get().theme).toBe("dark")
    expect(store.get().sandboxMode).toBe("read-only")
    expect(store.get().fontSize).toBe(15)
    expect(store.get().plugins.bash).toBe(false)
    // the appended keys come from defaults — no migration path
    expect(store.get().llm).toEqual(SETTINGS_DEFAULTS.llm)
    expect(store.get().onboarding).toEqual(SETTINGS_DEFAULTS.onboarding)
    // load() must not rewrite the document (no migration writes)
    expect(await readFile(file, "utf8")).toBe(JSON.stringify({ theme: "dark", sandboxMode: "read-only", fontSize: 15, plugins: { bash: false } }))
    // and a reload from the same file keeps the extra defaults
    const again = new SettingsStore({ path: file })
    await again.load()
    expect(again.get().llm).toEqual(SETTINGS_DEFAULTS.llm)
    await rm(root, { recursive: true, force: true })
  })

  it("normalizeSettings keeps valid llm/onboarding content and drops junk", () => {
    const s = normalizeSettings({
      llm: {
        providers: {
          gateway: { apiKeyEnv: "GATEWAY_KEY", baseURL: "https://g.local/v1", models: ["g1", "g2"], junk: true },
          broken: { baseURL: 42 },
        },
        defaultModel: { provider: "gateway", model: "g1", reasoningEffort: "high" },
      },
      onboarding: { welcomeNoticeVersion: "2026-08-30.1" },
    })
    // T1 (providers): trailing /v1 stripped at normalize (root convention),
    // old string model entries soft-upgrade to {id}. Protocol is NOT filled
    // (review r1: the per-route default is the consumers' seed chain —
    // user > SEEDED_PROTOCOLS > DEFAULT — filling it here would shadow a
    // seeded route's protocol, e.g. anthropic-messages).
    expect(s.llm.providers.gateway).toEqual({
      apiKeyEnv: "GATEWAY_KEY",
      baseURL: "https://g.local",
      models: [{ id: "g1" }, { id: "g2" }],
    })
    expect(s.llm.providers.broken).toBeUndefined()
    expect(s.llm.defaultModel).toEqual({ provider: "gateway", model: "g1", reasoningEffort: "high" })
    expect(s.onboarding.welcomeNoticeVersion).toBe("2026-08-30.1")
    expect(s.theme).toBe("system") // unrelated top-level key untouched
  })

  it("the revision meta key is additive-only: not part of normalized output", async () => {
    const { store, file, root } = await newStore()
    await mutateSection("llm", [{ op: "set", path: ["defaultModel", "provider"], value: "custom" }], store)
    const raw = JSON.parse(await readFile(file, "utf8"))
    expect(raw._revision).toEqual({ llm: 1 })
    expect("_revision" in normalizeSettings(raw)).toBe(false) // old readers never see it
    expect("llm" in SETTINGS_DEFAULTS).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
})

describe("describeSection", () => {
  it("redacts secrets to *** but keeps credential refs by name", () => {
    const schema: SectionSchema = {
      fields: {
        token: { type: "string", role: "secret" },
        endpoint: { type: "string", role: "credential-ref" },
        label: { type: "string" },
        strip: { type: "string" },
      },
    }
    const view = redactForSchema(schema, { token: "very-secret", endpoint: "MY_GATEWAY_KEY", label: "x", strip: 1 as unknown as string, unknownKey: "nope" })
    expect(view.token).toBe("***")
    // credential-ref values are ref NAMES — not secret values — and stay visible
    expect(view.endpoint).toBe("MY_GATEWAY_KEY")
    expect(view.label).toBe("x")
    // unknown keys are not describe-describable
    expect("unknownKey" in view).toBe(false)
    expect("strip" in view).toBe(false) // wrong-typed raw value: not a describable string
  })

  it("llm: base layer is EMPTY (no built-in seeds) — the value layer is user-only; refs preserved; writable + revision", async () => {
    const { store, root } = await newStore()
    await mutateSection("llm", [
      { op: "set", path: ["providers", "gateway", "apiKeyEnv"], value: "GATEWAY_KEY" },
      { op: "set", path: ["providers", "gateway", "baseURL"], value: "https://gateway.local/v1" },
      { op: "set", path: ["providers", "gateway", "models"], value: [{ id: "g1" }, { id: "g2" }] },
    ], store)
    const view = describeSection("llm", store)
    expect(view.writable).toBe(true)
    expect(view.revision).toBe(1)
    const value = view.value as AnyRecord
    // Amendment (seeds removed): NO built-in provider rows exist — a route the
    // user never configured (deepseek) does not appear anywhere.
    expect(value.providers.deepseek).toBeUndefined()
    expect(value.providers.gateway.apiKeyEnv).toBe("GATEWAY_KEY") // credential-ref: name preserved
    expect(value.providers.gateway.baseURL).toBe("https://gateway.local") // /v1 stripped on the write path
    expect(value.providers.gateway.models).toEqual([{ id: "g1" }, { id: "g2" }])
    // a route stays protocol-free at describe (resolution is the consumers'
    // chain: user > SEEDED_PROTOCOLS({}) > DEFAULT — the user layer never got a
    // protocol write)
    expect("protocol" in value.providers.gateway).toBe(false)
    // defaultModel section default: EMPTY ("" = unset — no seeded default model)
    expect(value.defaultModel).toEqual({ provider: "", model: "" })
    expect(value.defaultModel).toEqual(SETTINGS_DEFAULTS.llm.defaultModel)
    // user layer only holds what was written (no normalize protocol fill)
    const user = view.user as AnyRecord
    const base = view.base as AnyRecord
    expect(user.providers.gateway).toEqual({
      apiKeyEnv: "GATEWAY_KEY",
      baseURL: "https://gateway.local",
      models: [{ id: "g1" }, { id: "g2" }],
    })
    // the base layer survives the fold as EMPTY providers (no seed rows remain)
    expect(base.providers).toEqual({})
    expect(base.providers.deepseek).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  it("onboarding: fresh default, writable, revision 0, ack round-trips", async () => {
    const { store, root } = await newStore()
    const fresh = describeSection("onboarding", store)
    expect(fresh.writable).toBe(true)
    expect(fresh.revision).toBe(0)
    expect(fresh.value).toEqual({ welcomeNoticeVersion: "" })
    const v = await mutateSection("onboarding", [{ op: "set", path: ["welcomeNoticeVersion"], value: "2026-08-30.1" }], store, 0)
    expect(v.revision).toBe(1)
    expect(v.value.welcomeNoticeVersion).toBe("2026-08-30.1")
    await rm(root, { recursive: true, force: true })
  })
})

describe("mutateSection", () => {
  it("set path ops persist and bump the section revision (monotonic across reload)", async () => {
    const { store, file, root } = await newStore()
    await store.set({ theme: "dark" }) // unrelated top-level write must not disturb sections
    const v1 = await mutateSection("llm", [{ op: "set", path: ["defaultModel", "provider"], value: "custom" }], store, 0)
    expect(v1.revision).toBe(1)
    expect((v1.value as AnyRecord).defaultModel.provider).toBe("custom")
    const v2 = await mutateSection("llm", [{ op: "set", path: ["defaultModel", "model"], value: "m1" }], store, 1)
    expect(v2.revision).toBe(2)
    expect((v2.value as AnyRecord).defaultModel.model).toBe("m1")
    // persisted: doc on disk is the merged view, old top-level key intact
    const raw = JSON.parse(await readFile(file, "utf8"))
    expect(raw.llm.defaultModel).toEqual({ provider: "custom", model: "m1" })
    expect(raw.theme).toBe("dark")
    expect(raw._revision).toEqual({ llm: 2 })
    // revision survives a fresh instance pointing at the same file
    const again = new SettingsStore({ path: file })
    await again.load()
    expect(again.getSectionRevision("llm")).toBe(2)
    const v3 = await mutateSection("llm", [{ op: "set", path: ["defaultModel", "model"], value: "m2" }], again, 2)
    expect(v3.revision).toBe(3)
    await rm(root, { recursive: true, force: true })
  })

  it("sets a whole route object and validates per-field", async () => {
    const { store, root } = await newStore()
    const v = await mutateSection("llm", [
      { op: "set", path: ["providers", "gateway"], value: { apiKeyEnv: "GATEWAY_KEY", baseURL: "https://g.local" } },
    ], store)
    // protocol absent: normalize no longer fills a default (review r1 —
    // resolution belongs to resolveProviderProtocol's seed chain)
    expect((v.user as AnyRecord).providers.gateway).toEqual({
      apiKeyEnv: "GATEWAY_KEY",
      baseURL: "https://g.local",
    })
    await rm(root, { recursive: true, force: true })
  })

  it("unset removes a path (and can revert a field to default)", async () => {
    const { store, root } = await newStore()
    await mutateSection("llm", [
      { op: "set", path: ["providers", "gateway", "apiKeyEnv"], value: "GATEWAY_KEY" },
      { op: "set", path: ["defaultModel", "reasoningEffort"], value: "high" },
    ], store)
    const v = await mutateSection("llm", [
      { op: "unset", path: ["defaultModel", "reasoningEffort"] },
      { op: "unset", path: ["providers", "gateway"] },
    ], store)
    expect(v.revision).toBe(2)
    expect((v.user as AnyRecord).defaultModel.reasoningEffort).toBeUndefined()
    expect((v.user as AnyRecord).providers.gateway).toBeUndefined()
    // Amendment: there are NO built-in base rows — an unset only ever clears
    // user content; the value layer is user-only (never a seeded provider).
    expect((v.value as AnyRecord).providers).toEqual({})
    expect((v.value as AnyRecord).providers.deepseek).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  it("no-op ops do not bump the revision", async () => {
    const { store, root } = await newStore()
    const v1 = await mutateSection("llm", [{ op: "set", path: ["defaultModel", "provider"], value: "custom" }], store)
    expect(v1.revision).toBe(1)
    const v2 = await mutateSection("llm", [{ op: "set", path: ["defaultModel", "provider"], value: "custom" }], store, 1)
    expect(v2.revision).toBe(1) // same content → no bump
    const v3 = await mutateSection("llm", [{ op: "unset", path: ["providers", "never-added"] }], store, 1)
    expect(v3.revision).toBe(1)
    await rm(root, { recursive: true, force: true })
  })

  it("expectedRevision mismatch throws SettingsConflictError with expected/actual and a code", async () => {
    const { store, root } = await newStore()
    await mutateSection("llm", [{ op: "set", path: ["defaultModel", "provider"], value: "custom" }], store)
    await expect(
      mutateSection("llm", [{ op: "set", path: ["defaultModel", "model"], value: "m1" }], store, 99),
    ).rejects.toBeInstanceOf(SettingsConflictError)
    await expect(
      mutateSection("llm", [{ op: "set", path: ["defaultModel", "model"], value: "m1" }], store, 99),
    ).rejects.toMatchObject({ code: "settings-section-conflict", expected: 99, actual: 1 })
    await rm(root, { recursive: true, force: true })
  })

  it("conflict is checked before ops validation (409 wins over 400)", async () => {
    const { store, root } = await newStore()
    await mutateSection("llm", [{ op: "set", path: ["defaultModel", "provider"], value: "custom" }], store)
    await expect(
      mutateSection("llm", [{ op: "set", path: ["defaultModel", "bogus"], value: 123 }], store, 99),
    ).rejects.toBeInstanceOf(SettingsConflictError)
    await rm(root, { recursive: true, force: true })
  })

  it("unknown fields and wrong types throw SettingsValidationError", async () => {
    const { store, root } = await newStore()
    const bad: Array<{ ops: SectionOp[]; where: string }> = [
      { ops: [{ op: "set", path: ["defaultModel", "bogus"], value: "x" }], where: "unknown field" },
      { ops: [{ op: "set", path: ["defaultModel", "model"], value: 42 }], where: "wrong type" },
      { ops: [{ op: "set", path: ["defaultModel", "model"], value: "" }], where: "empty string" },
      { ops: [{ op: "set", path: ["defaultModel", "reasoningEffort"], value: "ultra" }], where: "bad enum" },
      { ops: [{ op: "set", path: ["providers", "gateway", "models"], value: "not-an-array" }], where: "wrong array type" },
      { ops: [{ op: "set", path: ["providers", "gateway"], value: { junk: "field" } }], where: "unknown route field" },
      { ops: [{ op: "unset", path: ["defaultModel", "bogus"] }], where: "unknown unset field" },
      { ops: [{ op: "set", path: ["welcomeNoticeVersion"], value: false }], where: "onboarding wrong type" },
    ]
    for (const t of bad) {
      await expect(
        mutateSection(t.where === "onboarding wrong type" ? "onboarding" : "llm", t.ops, store),
      ).rejects.toMatchObject({ code: "settings-section-validation" })
    }
    // nothing was persisted by the failed attempts
    expect(describeSection("llm", store).revision).toBe(0)
    await rm(root, { recursive: true, force: true })
  })

  it("accepts a valid reasoning effort and a valid onboarding version", async () => {
    const { store, root } = await newStore()
    const v = await mutateSection("llm", [{ op: "set", path: ["defaultModel", "reasoningEffort"], value: "high" }], store)
    expect((v.value as AnyRecord).defaultModel.reasoningEffort).toBe("high")
    const o = await mutateSection("onboarding", [{ op: "set", path: ["welcomeNoticeVersion"], value: "2026-08-30.1" }], store)
    expect(o.value.welcomeNoticeVersion).toBe("2026-08-30.1")
    await rm(root, { recursive: true, force: true })
  })
})

describe("array index paths (review round 1)", () => {
  it("materializes a missing models[] in its declared array shape and persists element sets", async () => {
    const { store, file, root } = await newStore()
    const v = await mutateSection("llm", [
      { op: "set", path: ["providers", "gateway", "models", "0"], value: { id: "g1" } },
      { op: "set", path: ["providers", "gateway", "models", "1"], value: { id: "g2" } },
    ], store)
    expect(v.revision).toBe(1)
    expect((v.user as AnyRecord).providers.gateway.models).toEqual([{ id: "g1" }, { id: "g2" }])
    expect((v.value as AnyRecord).providers.gateway.models).toEqual([{ id: "g1" }, { id: "g2" }])
    // persisted end-to-end — the old bug silently dropped the whole route
    const raw = JSON.parse(await readFile(file, "utf8"))
    expect(raw.llm.providers.gateway.models).toEqual([{ id: "g1" }, { id: "g2" }])
    expect(raw._revision.llm).toBe(1)
    const again = new SettingsStore({ path: file })
    await again.load()
    // no normalize protocol fill (review r1 — non-seeded route: absent)
    expect(again.get().llm.providers.gateway).toEqual({
      models: [{ id: "g1" }, { id: "g2" }],
    })
    await rm(root, { recursive: true, force: true })
  })

  it("rejects out-of-bounds and non-index array keys (no sparse/silent mutations)", async () => {
    const { store, root } = await newStore()
    await mutateSection("llm", [{ op: "set", path: ["providers", "gateway", "models"], value: [{ id: "g1" }] }], store)
    await expect(
      mutateSection("llm", [{ op: "set", path: ["providers", "gateway", "models", "5"], value: { id: "g6" } }], store),
    ).rejects.toMatchObject({ code: "settings-section-validation" })
    await expect(
      mutateSection("llm", [{ op: "set", path: ["providers", "gateway", "models", "junk"], value: { id: "g2" } }], store),
    ).rejects.toMatchObject({ code: "settings-section-validation" })
    // failed attempts changed nothing: same revision, same stored content
    const after = describeSection("llm", store)
    expect(after.revision).toBe(1)
    expect((after.user as AnyRecord).providers.gateway.models).toEqual([{ id: "g1" }])
    await rm(root, { recursive: true, force: true })
  })

  it("unset of an array element splices it; a missing index is a no-op with no bump", async () => {
    const { store, root } = await newStore()
    await mutateSection("llm", [{ op: "set", path: ["providers", "gateway", "models"], value: [{ id: "g1" }, { id: "g2" }, { id: "g3" }] }], store)
    const v1 = await mutateSection("llm", [{ op: "unset", path: ["providers", "gateway", "models", "1"] }], store, 1)
    expect((v1.user as AnyRecord).providers.gateway.models).toEqual([{ id: "g1" }, { id: "g3" }]) // spliced, no hole
    expect(v1.revision).toBe(2)
    const v2 = await mutateSection("llm", [{ op: "unset", path: ["providers", "gateway", "models", "99"] }], store, 2)
    expect(v2.revision).toBe(2) // no-op: nothing removed
    expect((v2.user as AnyRecord).providers.gateway.models).toEqual([{ id: "g1" }, { id: "g3" }])
    await rm(root, { recursive: true, force: true })
  })
})

// ── Task 1 (custom providers): protocol + models objects + /v1 stripping ────
describe("provider protocol + models objects (Task 1)", () => {
  it("old file string model entries soft-upgrade to {id} at load (no migration chain)", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    await writeFile(
      file,
      JSON.stringify({ llm: { providers: { gateway: { baseURL: "https://g.local/v1", models: ["g1", "g2"] } } } }),
    )
    const store = new SettingsStore({ path: file })
    await store.load()
    const view = describeSection("llm", store)
    expect((view.value as AnyRecord).providers.gateway.models).toEqual([{ id: "g1" }, { id: "g2" }])
    // the in-memory store is the normalized (object) shape
    expect(store.get().llm.providers.gateway.models).toEqual([{ id: "g1" }, { id: "g2" }])
    // load() alone must not rewrite the document (no migration writes)
    expect(await readFile(file, "utf8")).toBe(JSON.stringify({ llm: { providers: { gateway: { baseURL: "https://g.local/v1", models: ["g1", "g2"] } } } }))
    await rm(root, { recursive: true, force: true })
  })

  it("baseURL trailing /v1 (or /v1/) is stripped at normalize; /anthropic /openai /v2 kept", () => {
    const stripped = (baseURL: string): string | undefined =>
      normalizeSettings({ llm: { providers: { p: { baseURL } } } }).llm.providers.p?.baseURL
    // only the terminal `v1` segment is stripped (root convention — the
    // adapters assemble /v1/... themselves; cc-switch tolerance)
    expect(stripped("https://x.com/v1")).toBe("https://x.com")
    expect(stripped("https://x.com/v1/")).toBe("https://x.com")
    expect(stripped("https://x.com/api/v1")).toBe("https://x.com/api")
    expect(stripped("https://x.com/anthropic")).toBe("https://x.com/anthropic")
    expect(stripped("https://x.com/openai")).toBe("https://x.com/openai")
    expect(stripped("https://x.com/v2")).toBe("https://x.com/v2")
    expect(stripped("https://x.com")).toBe("https://x.com")
  })

  it("protocol is a closed three-value enum at mutate: unknown value fails loud, valid accepted", async () => {
    const { store, root } = await newStore()
    await expect(
      mutateSection("llm", [{ op: "set", path: ["providers", "gateway", "protocol"], value: "gpt-5" }], store),
    ).rejects.toMatchObject({ code: "settings-section-validation" })
    const v = await mutateSection("llm", [
      { op: "set", path: ["providers", "gateway", "protocol"], value: "anthropic-messages" },
      { op: "set", path: ["providers", "gateway", "displayName"], value: "自定义网关" },
    ], store)
    expect((v.user as AnyRecord).providers.gateway).toEqual({
      protocol: "anthropic-messages",
      displayName: "自定义网关",
    })
    // nothing persisted by the failed attempt
    expect(describeSection("llm", store).revision).toBe(1)
    await rm(root, { recursive: true, force: true })
  })

  it("protocol normalize two-tier: valid kept, absent/invalid left ABSENT (seed resolution is the consumers' chain)", () => {
    // absent stays absent — normalize must NOT fill a default (review r1:
    // filling would shadow the seed chain for user-touched seed routes)
    const absent = normalizeSettings({ llm: { providers: { p: { baseURL: "https://g.local" } } } })
    expect(absent.llm.providers.p?.protocol).toBeUndefined()
    // bad RAW value → absent at READ (load never fails); fail-loud rejection
    // is mutateSection's job (the test above)
    const bad = normalizeSettings({ llm: { providers: { p: { protocol: "gpt-5", baseURL: "https://g.local" } } } })
    expect(bad.llm.providers.p?.protocol).toBeUndefined()
    const ok = normalizeSettings({ llm: { providers: { p: { protocol: "anthropic-messages" } } } })
    expect(ok.llm.providers.p?.protocol).toBe("anthropic-messages")
    // a junk-only entry (nothing recognizable) is discarded entirely
    expect(normalizeSettings({ llm: { providers: { p: { protocol: "gpt-5" } } } }).llm.providers.p).toBeUndefined()
  })

  it("resolveProviderProtocol chains user > SEEDED_PROTOCOLS({}) > DEFAULT (T2 probe / T4 dispatch)", () => {
    // user value wins
    expect(resolveProviderProtocol("anthropic", { protocol: "openai-completions" })).toBe("openai-completions")
    // Amendment: no seeds remain — ANY route without a user protocol resolves
    // to the generic default (there is no seeded deepseek/anthropic/openai
    // protocol anymore; every provider is settings-managed).
    expect(resolveProviderProtocol("anthropic", { apiKeyEnv: "ANTHROPIC_API_KEY" })).toBe("openai-completions")
    expect(resolveProviderProtocol("openai", {})).toBe("openai-completions")
    expect(resolveProviderProtocol("deepseek", undefined)).toBe("openai-completions")
    expect(resolveProviderProtocol("openai-compatible", undefined)).toBe("openai-completions")
    // unknown route → the generic default (indistinguishable now — no seeds)
    expect(resolveProviderProtocol("custom-route", {})).toBe("openai-completions")
  })

  it("apiKeyEnv-only user entry stays protocol-free; the resolved protocol is the DEFAULT (no seeds remain)", async () => {
    const { store, root } = await newStore()
    // the settings UI's typical partial write: only the key ref, no protocol
    await mutateSection("llm", [{ op: "set", path: ["providers", "anthropic", "apiKeyEnv"], value: "ANTHROPIC_API_KEY_USER" }], store)
    const userCfg = store.get().llm.providers.anthropic
    // user layer stays protocol-free (no normalize fill)
    expect(userCfg).toEqual({ apiKeyEnv: "ANTHROPIC_API_KEY_USER" })
    expect(resolveProviderProtocol("anthropic", userCfg)).toBe("openai-completions")
    const view = describeSection("llm", store)
    // merged value = the user layer only (every provider is settings-managed);
    // the resolved default belongs to the consumers' chain, never the view
    expect((view.value as AnyRecord).providers.anthropic).toEqual({
      apiKeyEnv: "ANTHROPIC_API_KEY_USER",
    })
    expect((view.user as AnyRecord).providers.anthropic).toEqual({ apiKeyEnv: "ANTHROPIC_API_KEY_USER" })
    await rm(root, { recursive: true, force: true })
  })

  it("invalid raw protocol in an old file falls back to the DEFAULT protocol at read (no load failure)", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    await writeFile(file, JSON.stringify({
      llm: { providers: { anthropic: { protocol: "gpt-5", apiKeyEnv: "ANTHROPIC_API_KEY" } } },
    }))
    const store = new SettingsStore({ path: file })
    await store.load() // must not throw
    const userCfg = store.get().llm.providers.anthropic
    // the bad raw value degrades to absent (not to the old generic default fill)
    expect(userCfg).toEqual({ apiKeyEnv: "ANTHROPIC_API_KEY" })
    expect(resolveProviderProtocol("anthropic", userCfg)).toBe("openai-completions")
    await rm(root, { recursive: true, force: true })
  })

  it("models items validate as objects: id required, caps positive integers, unknown keys rejected", async () => {
    const { store, root } = await newStore()
    const v = await mutateSection("llm", [
      { op: "set", path: ["providers", "gateway", "models"], value: [{ id: "g1", name: "G1", contextWindow: 64000, maxTokens: 8192 }] },
    ], store)
    expect((v.user as AnyRecord).providers.gateway.models).toEqual([{ id: "g1", name: "G1", contextWindow: 64000, maxTokens: 8192 }])
    const bad: SectionOp[][] = [
      [{ op: "set", path: ["providers", "gateway", "models"], value: [{ name: "no-id" }] }],
      [{ op: "set", path: ["providers", "gateway", "models"], value: [{ id: "g1", contextWindow: -1 }] }],
      [{ op: "set", path: ["providers", "gateway", "models"], value: [{ id: "g1", contextWindow: 1.5 }] }],
      [{ op: "set", path: ["providers", "gateway", "models"], value: [{ id: "g1", maxTokens: 0 }] }],
      [{ op: "set", path: ["providers", "gateway", "models"], value: [{ id: "g1", junk: "x" }] }],
      [{ op: "set", path: ["providers", "gateway", "models"], value: ["old-format-string"] }],
    ]
    for (const ops of bad) {
      await expect(mutateSection("llm", ops, store)).rejects.toMatchObject({ code: "settings-section-validation" })
    }
    // failed attempts changed nothing
    expect(describeSection("llm", store).revision).toBe(1)
    await rm(root, { recursive: true, force: true })
  })

  it("normalize keeps valid model objects and drops malformed entries", () => {
    const s = normalizeSettings({
      llm: {
        providers: {
          p: {
            models: [
              { id: "m1", name: "M1", contextWindow: 128000, maxTokens: 4096 },
              { id: "m2", contextWindow: 1000 },
              { id: "" }, // no addressable id → dropped
              { junk: "x" }, // no id → dropped
              "legacy-string", // soft upgrade
              42, // not a model → dropped
            ],
          },
        },
      },
    })
    expect(s.llm.providers.p?.models).toEqual([
      { id: "m1", name: "M1", contextWindow: 128000, maxTokens: 4096 },
      { id: "m2", contextWindow: 1000 },
      { id: "legacy-string" },
    ])
  })

  it("SEEDED_PROTOCOLS is EMPTY: no built-in provider routes (the resolver keeps the user > {} > DEFAULT chain shape)", () => {
    // Amendment: seeds were removed entirely — every provider comes from the
    // user section. The export stays (the resolver chain shape
    // `user > SEEDED_PROTOCOLS > DEFAULT` is preserved); it simply never matches.
    expect(SEEDED_PROTOCOLS).toEqual({})
  })
})
