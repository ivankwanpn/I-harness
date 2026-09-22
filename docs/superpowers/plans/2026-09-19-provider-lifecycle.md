# Provider Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the whole provider lifecycle — create a route, store its credential, probe its endpoint, choose which models to add, override per-model numbers, pick the default — exercisable from the CLI, on top of `@i-harness/provider-runtime`.

**Architecture:** The capability layer lands first (five new `ProviderRuntime` methods; `discoverModels` recomposed on the read/write split), then the two CLI trees that exercise it. Protocol moves from the route's identity to the route's **default**, overridable per model row. No `llm-*` adapter changes: `buildClient` still switches on `profile.protocol`, only the value's origin changes.

**Tech Stack:** TypeScript ESM, pnpm workspace, vitest, node ≥ 20 (native fetch), `@i-harness/settings` / `@i-harness/provider` / `@i-harness/provider-runtime` / `apps/cli`.

**Spec:** `docs/superpowers/specs/2026-09-19-provider-lifecycle-design.md`

## Global Constraints

- **Never add a `Co-Authored-By` trailer** to any commit in this repo. (User's standing rule; it overrides the harness's attribution reminder.)
- **A new export must land WITH its consumer in the same task.** `node scripts/audit/check-reachability.mjs --gate` must print `gate PASS -- no new rows` after every task. An export whose only caller is a test IS a new row — commit `8ec8fda0` exists because of exactly that. **The instrument counts `export type` and `export interface` as rows too** (`scripts/audit/check-reachability.mjs:254` matches `type|interface`; its own self-tests pin `#OnlyAType`), so a type exported "for later" is a new row today. Keep a type module-private until a caller NAMES it — structural typing means passing an object literal never names it.
- **TDD, and a mutation proof where a mechanism can be removed.** Red first, then green, then remove the mechanism and watch the right tests redden, then restore.
- Gate commands, run from the repo root: `pnpm -C packages/<pkg> test`, `pnpm typecheck`, `node scripts/audit/check-reachability.mjs --gate`.
- **stdout carries data; stderr carries diagnostics. Exit 0 on success, 1 on failure. Key material NEVER reaches stdout** — masked as `x…<last4>`.
- Existing test assertions in `packages/provider-runtime/test/runtime.test.ts` are the guard for Task 3: **they must stay green without being edited.**
- `apps/cli` is a development/test harness, not a product surface. Its commands exist so every production capability is exercisable (the `i-harness hooks approve` precedent).

---

### Task 1: `probeModels` — the READ half of discovery

**Files:**
- Modify: `packages/provider-runtime/src/index.ts` (interface at :63-66; new method inside `createProviderRuntime`)
- Test: `packages/provider-runtime/test/runtime.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `probeModels(id: string, options?: { signal?: AbortSignal }): Promise<ModelDescriptor[]>` on `ProviderRuntime`. Task 3 calls the local helper it is built from.

- [ ] **Step 1: Write the failing test**

Append to `packages/provider-runtime/test/runtime.test.ts`:

```ts
// D4-superseding (spec §3.1): `discoverModels` probed AND wrote, so "show me
// what this endpoint offers" could not be asked without also changing the
// route's model list. This is the read half.
describe("probeModels — the read half of discovery", () => {
  async function probeFixture() {
    const probe = vi.fn(async () => [{ id: "gw-model", name: "Gateway" }])
    const f = await fixture({
      providers: {
        deepseek: {
          baseURL: "https://gateway.example",
          modelsURL: "https://models.example/v1/models",
          protocol: "openai-completions",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: [{ id: "manual" }],
        },
      },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
      registry(registry) {
        registry.register({ name: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible" })
        registry.registerProbe("deepseek", probe)
      },
    })
    return { ...f, probe }
  }

  it("returns what the endpoint offers and writes NOTHING", async () => {
    const { runtime, settings } = await probeFixture()
    const before = JSON.stringify(settings.get().llm)

    await expect(runtime.probeModels("deepseek")).resolves.toEqual([{ id: "gw-model", name: "Gateway" }])

    expect(JSON.stringify(settings.get().llm)).toBe(before)
  })

  it("leaves the discovery memo alone — a later discoverModels still writes", async () => {
    const { runtime, settings } = await probeFixture()

    await runtime.probeModels("deepseek")
    // No `force`: only a populated memo could answer without probing. If
    // probeModels had filled it, the settings below would be untouched.
    await runtime.discoverModels("deepseek")

    expect(settings.get().llm.providers.deepseek?.models).toEqual([
      { id: "manual" },
      { id: "gw-model", name: "Gateway" },
    ])
  })

  it("refuses bedrock, a keyless route, and a route that is not configured", async () => {
    const { runtime } = await fixture({
      providers: {
        bedrock: { baseURL: "https://bedrock.example", protocol: "bedrock" },
        keyless: { baseURL: "https://gw.example", protocol: "openai-completions" },
      },
    })

    await expect(runtime.probeModels("bedrock")).rejects.toThrow(/manually|not available/i)
    await expect(runtime.probeModels("keyless")).rejects.toThrow(/No API key/i)
    await expect(runtime.probeModels("nope")).rejects.toThrow(/not configured/)
  })
})
```

- [ ] **Step 2: Run it — expect RED**

Run: `pnpm -C packages/provider-runtime test`
Expected: FAIL — `runtime.probeModels is not a function`.

- [ ] **Step 3: Implement**

In `packages/provider-runtime/src/index.ts`, add to the `ProviderRuntime` interface (after `clearApiKey`):

```ts
  /** What the route's endpoint offers, WITHOUT writing anything. The read half
   * of `discoverModels` — see that method for why the two are separate. */
  probeModels(id: string, options?: { signal?: AbortSignal }): Promise<ModelDescriptor[]>
```

Inside `createProviderRuntime`, immediately BEFORE `return {`, add a local function (a function, not a method, so `discoverModels` can call it without `this`):

```ts
  /** One probe, one credential resolution, no writes. The single implementation
   * behind `probeModels` and `discoverModels`. */
  async function probeRouteModels(
    id: string,
    probeOptions: { signal?: AbortSignal },
  ): Promise<ModelDescriptor[]> {
    probeOptions.signal?.throwIfAborted()

    const view = provider(id)
    if (view === undefined) throw new Error(`provider "${id}" is not configured`)
    if (view.protocol === "bedrock") {
      throw new Error("Discovery is not available for this provider; add a model ID manually.")
    }

    const ref = authRef(view)
    if (ref === undefined) throw new Error(`No API key configured for provider "${id}"`)
    const resolvedAuth = await auth.resolve(ref, {
      providerId: id,
      purpose: "discovery",
      ...(probeOptions.signal !== undefined ? { signal: probeOptions.signal } : {}),
    })
    const apiKey = authValue(resolvedAuth)
    if (apiKey === undefined) throw new Error(`No API key configured for provider "${id}"`)
    probeOptions.signal?.throwIfAborted()

    const models = await registry.probeModels(id, {
      ...(view.modelsURL !== undefined
        ? { modelsURL: view.modelsURL }
        : view.baseURL !== undefined ? { baseURL: view.baseURL } : {}),
      apiKey,
      protocol: view.protocol,
      // M60 E: the route's configured headers (a gateway may require one for
      // discovery too) — the probe's own auth keys still win.
      ...(view.headers !== undefined ? { headers: view.headers } : {}),
    })
    // Copied: the registry's array is not a caller's to mutate.
    return cloneModels(models)
  }
```

Then add the method to the returned object (after `clearApiKey`):

```ts
    async probeModels(id, probeOptions = {}) {
      assertProviderId(id)
      return probeRouteModels(id, probeOptions)
    },
```

- [ ] **Step 4: Run it — expect GREEN**

Run: `pnpm -C packages/provider-runtime test`
Expected: PASS (25 existing + 3 new = 28).

- [ ] **Step 5: Commit**

```bash
git add packages/provider-runtime/src/index.ts packages/provider-runtime/test/runtime.test.ts
git commit -m "feat(provider-runtime): probeModels — the read half of discovery"
```

---

### Task 2: `addModels` / `setModel` / `removeModel` — per-row writes

**Files:**
- Modify: `packages/provider-runtime/src/index.ts`
- Test: `packages/provider-runtime/test/runtime.test.ts`

**Interfaces:**
- Consumes: `probeRouteModels` (Task 1, local).
- Produces:
  - `addModels(id: string, rows: readonly SettingsModel[]): Promise<ModelDescriptor[]>` — **merge, existing rows win** (the `mergeDiscoveredModels` rule).
  - `setModel(id: string, modelId: string, fields: ModelFields): Promise<ModelDescriptor[]>` — row must exist; the fields given WIN; `null` CLEARS a field.
  - `removeModel(id: string, modelId: string): Promise<ModelDescriptor[]>` — row must exist.
  - **module-private** `interface ModelFields { protocol?: SettingsProviderProtocol | null; contextWindow?: number | null; maxTokens?: number | null; name?: string | null }` — NOT exported: callers pass object literals, and the gate counts type exports as rows.

- [ ] **Step 1: Write the failing test**

Append to `packages/provider-runtime/test/runtime.test.ts`:

```ts
describe("per-row model writes", () => {
  async function rowsFixture() {
    return fixture({
      providers: {
        deepseek: {
          baseURL: "https://gateway.example",
          protocol: "openai-completions",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: [{ id: "kept", contextWindow: 128_000 }, { id: "gone" }],
        },
      },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
      registry(registry) {
        registry.register({ name: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible" })
      },
    })
  }

  it("addModels adds only the rows given, and an EXISTING row keeps its own numbers", async () => {
    const { runtime, settings } = await rowsFixture()

    await runtime.addModels("deepseek", [
      { id: "kept", contextWindow: 999 },      // exists → left alone
      { id: "fresh", name: "Fresh" },          // new → added
    ])

    expect(settings.get().llm.providers.deepseek?.models).toEqual([
      { id: "kept", contextWindow: 128_000 },
      { id: "gone" },
      { id: "fresh", name: "Fresh" },
    ])
  })

  it("addModels refuses an empty list and a blank id, without writing", async () => {
    const { runtime, settings } = await rowsFixture()
    const before = JSON.stringify(settings.get().llm)

    await expect(runtime.addModels("deepseek", [])).rejects.toThrow(/at least one/i)
    await expect(runtime.addModels("deepseek", [{ id: "   " }])).rejects.toThrow(/non-empty id/i)

    expect(JSON.stringify(settings.get().llm)).toBe(before)
  })

  it("setModel changes only that row, and null CLEARS a field back to the card", async () => {
    const { runtime, settings } = await rowsFixture()

    await runtime.setModel("deepseek", "kept", { contextWindow: 65_536, maxTokens: 8_192 })
    expect(settings.get().llm.providers.deepseek?.models).toEqual([
      { id: "kept", contextWindow: 65_536, maxTokens: 8_192 },
      { id: "gone" },
    ])

    await runtime.setModel("deepseek", "kept", { contextWindow: null })
    expect(settings.get().llm.providers.deepseek?.models).toEqual([
      { id: "kept", maxTokens: 8_192 },
      { id: "gone" },
    ])
  })

  it("setModel and removeModel refuse a model the route does not have", async () => {
    const { runtime } = await rowsFixture()

    await expect(runtime.setModel("deepseek", "absent", { contextWindow: 1 })).rejects.toThrow(/no model "absent"/)
    await expect(runtime.removeModel("deepseek", "absent")).rejects.toThrow(/no model "absent"/)
  })

  it("removeModel takes one row out and leaves llm.defaultModel ALONE", async () => {
    const { runtime, settings } = await rowsFixture()
    await settings.set({
      llm: { providers: settings.get().llm.providers, defaultModel: { provider: "deepseek", model: "gone" } },
    })

    await runtime.removeModel("deepseek", "gone")

    expect(settings.get().llm.providers.deepseek?.models).toEqual([{ id: "kept", contextWindow: 128_000 }])
    // D1 removed the membership check, so a default naming a removed row still
    // resolves — nothing breaks, and the row is simply gone from the directory.
    expect(settings.get().llm.defaultModel).toEqual({ provider: "deepseek", model: "gone" })
  })
})
```

- [ ] **Step 2: Run it — expect RED**

Run: `pnpm -C packages/provider-runtime test`
Expected: FAIL — `runtime.addModels is not a function` (and the same for `setModel` / `removeModel`).

- [ ] **Step 3: Implement**

In the interface (next to `probeModels`):

```ts
  /** Add rows, or complete existing ones. EXISTING ROWS WIN — this is the
   * `mergeDiscoveredModels` rule, and it is what keeps a probe from clobbering
   * numbers the user set. To change an existing row, use `setModel`. */
  addModels(id: string, rows: readonly SettingsModel[]): Promise<ModelDescriptor[]>
  /** Change named fields on ONE existing row. `null` clears a field (the CLI's
   * `auto`); an omitted field is left alone. */
  setModel(id: string, modelId: string, fields: ModelFields): Promise<ModelDescriptor[]>
  /** Remove one row. The route and its credential are untouched. */
  removeModel(id: string, modelId: string): Promise<ModelDescriptor[]>
```

Near the top of the module, beside `ModelResolutionState`:

```ts
/** The per-model fields a caller may set. `null` CLEARS the field (falling back
 * to the card), which is NOT the same as omitting it (leave it alone).
 *
 * NOT EXPORTED, deliberately. Callers pass object literals and TypeScript checks
 * them structurally, so nothing outside this module ever needs to NAME this
 * type — and the reachability instrument counts type exports as rows (its own
 * allowlist carries `@i-harness/sdk#HistoryOptions` and `#QueueState` for
 * exactly that reason). Exporting it here would open a new row that only Task 7
 * could close, which is the shape commit 8ec8fda0 was written about. */
interface ModelFields {
  protocol?: SettingsProviderProtocol | null
  contextWindow?: number | null
  maxTokens?: number | null
  name?: string | null
}
```

A local function beside `probeRouteModels`:

```ts
  /** Merge `rows` into the route's SETTINGS model list and persist once. The
   * existing row wins every field it has — see `mergeDiscoveredModels`. */
  async function addModelRows(id: string, rows: readonly SettingsModel[]): Promise<ModelDescriptor[]> {
    const additions: SettingsModel[] = rows.map((row) => {
      const modelId = row.id.trim()
      if (modelId === "") throw new Error("a model row needs a non-empty id")
      return { ...row, id: modelId }
    })
    if (additions.length === 0) throw new Error("addModels needs at least one row")

    const llm = canonicalLlm(options.settings)
    const current = llm.providers[id]
    const models = mergeDiscoveredModels(current?.models ?? [], additions)
    await persistLlm({
      providers: { ...llm.providers, [id]: { ...(current ?? {}), models } },
      defaultModel: { ...llm.defaultModel },
    })
    discovered.delete(id)
    return cloneModels(provider(id)?.models ?? models)
  }
```

The three methods (after `probeModels`):

```ts
    async addModels(id, rows) {
      assertProviderId(id)
      if (provider(id) === undefined) throw new Error(`provider "${id}" is not configured`)
      return addModelRows(id, rows)
    },

    async setModel(id, modelId, fields) {
      assertProviderId(id)
      if (provider(id) === undefined) throw new Error(`provider "${id}" is not configured`)
      const llm = canonicalLlm(options.settings)
      const current = llm.providers[id]
      const models = current?.models ?? []
      const existing = models.find((model) => model.id === modelId)
      // The SETTINGS list, not the merged view: the view also carries template
      // rows, and a write has to land somewhere real.
      if (existing === undefined) {
        throw new Error(`provider "${id}" has no model "${modelId}"; add it first`)
      }
      const next: SettingsModel = { ...existing }
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue
        if (value === null) delete (next as Record<string, unknown>)[key]
        else (next as Record<string, unknown>)[key] = value
      }
      const merged = models.map((model) => (model.id === modelId ? next : { ...model }))
      await persistLlm({
        providers: { ...llm.providers, [id]: { ...(current ?? {}), models: merged } },
        defaultModel: { ...llm.defaultModel },
      })
      discovered.delete(id)
      return cloneModels(provider(id)?.models ?? merged)
    },

    async removeModel(id, modelId) {
      assertProviderId(id)
      const llm = canonicalLlm(options.settings)
      const current = llm.providers[id]
      if (current === undefined) throw new Error(`provider "${id}" is not configured`)
      const models = current.models ?? []
      if (!models.some((model) => model.id === modelId)) {
        throw new Error(`provider "${id}" has no model "${modelId}"`)
      }
      // `llm.defaultModel` is deliberately NOT touched: with D1's membership
      // check gone, a default naming a removed row still resolves.
      const merged = models.filter((model) => model.id !== modelId).map((model) => ({ ...model }))
      await persistLlm({
        providers: { ...llm.providers, [id]: { ...current, models: merged } },
        defaultModel: { ...llm.defaultModel },
      })
      discovered.delete(id)
      return cloneModels(provider(id)?.models ?? merged)
    },
```

Add `SettingsProviderProtocol` to the existing `@i-harness/settings` import block.

- [ ] **Step 4: Run it — expect GREEN**

Run: `pnpm -C packages/provider-runtime test`
Expected: PASS (28 + 5 = 33).

- [ ] **Step 5: Commit**

```bash
git add packages/provider-runtime/src/index.ts packages/provider-runtime/test/runtime.test.ts
git commit -m "feat(provider-runtime): per-row model writes — add, set, remove"
```

---

### Task 3: `discoverModels` recomposed on the read/write split

**Files:**
- Modify: `packages/provider-runtime/src/index.ts:252-303`
- Test: `packages/provider-runtime/test/runtime.test.ts` — **not edited**

**Interfaces:**
- Consumes: `probeRouteModels` (Task 1), `addModelRows` (Task 2).
- Produces: no new surface. `discoverModels` keeps its exact signature and return.

- [ ] **Step 1: Confirm the guard is green BEFORE the change**

Run: `pnpm -C packages/provider-runtime test`
Expected: PASS (33). These 33 assertions — five of them on `discoverModels` — are the guard; **do not edit them.**

- [ ] **Step 2: Replace the method body**

Replace `discoverModels` (`packages/provider-runtime/src/index.ts:252-303`) with:

```ts
    async discoverModels(id, discoveryOptions = {}) {
      assertProviderId(id)
      if (!discoveryOptions.force) {
        const cached = discovered.get(id)
        if (cached !== undefined) return cloneModels(cached)
      }
      // ONE merge implementation, two verbs: this is probe-then-add, and the
      // only thing it adds to that is the memo.
      const probed = await probeRouteModels(id, discoveryOptions)
      discoveryOptions.signal?.throwIfAborted()
      const merged = await addModelRows(id, probed)
      discovered.set(id, cloneModels(merged))
      return cloneModels(merged)
    },
```

- [ ] **Step 3: Run it — expect GREEN, with no test edited**

Run: `pnpm -C packages/provider-runtime test`
Expected: PASS (33). If any of the five `discoverModels` assertions fail, the recomposition changed behaviour — fix the implementation, never the assertion.

- [ ] **Step 4: Mutation proof**

Temporarily change `const merged = await addModelRows(id, probed)` to `const merged = cloneModels(probed)` and run the suite.
Expected: the `discoverModels` cases redden (the pre-existing manual rows vanish from the settings). Restore the line and re-run to green.

- [ ] **Step 5: Commit**

```bash
git add packages/provider-runtime/src/index.ts
git commit -m "refactor(provider-runtime): discoverModels is probe-then-add"
```

---

### Task 4: `createProvider` / `patchProvider` — route writes that never touch `models`

**Files:**
- Modify: `packages/provider-runtime/src/index.ts`
- Test: `packages/provider-runtime/test/runtime.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `createProvider(id: string, fields: Omit<SettingsProviderConfig, "models">): Promise<void>` — throws if the route exists.
  - `patchProvider(id: string, patch: ProviderPatch): Promise<void>` — throws if it does not; **`models` is not in the patch**.
  - **module-private** `interface ProviderPatch { baseURL?: string | null; protocol?: SettingsProviderProtocol | null; catalog?: string | null; displayName?: string | null; modelsURL?: string | null; apiKeyEnv?: string | null }` — NOT exported, same reason as `ModelFields`.

- [ ] **Step 1: Write the failing test**

```ts
describe("route writes that leave the model list alone", () => {
  async function routeFixture() {
    return fixture({
      providers: {
        deepseek: {
          baseURL: "https://old.example",
          protocol: "openai-completions",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          displayName: "Old",
          models: [{ id: "kept", contextWindow: 128_000 }],
        },
      },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
      registry(registry) {
        registry.register({ name: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible" })
      },
    })
  }

  it("patchProvider changes named fields and KEEPS models, displayName and apiKeyEnv", async () => {
    const { runtime, settings } = await routeFixture()

    await runtime.patchProvider("deepseek", { protocol: "anthropic-messages" })

    const row = settings.get().llm.providers.deepseek
    expect(row?.protocol).toBe("anthropic-messages")
    // The three fields a naive whole-config replace would have dropped — this
    // is the merge the deleted TUI's saveProvider() did, and why it existed.
    expect(row?.models).toEqual([{ id: "kept", contextWindow: 128_000 }])
    expect(row?.displayName).toBe("Old")
    expect(row?.apiKeyEnv).toBe("DEEPSEEK_API_KEY")
  })

  it("patchProvider with null CLEARS a field", async () => {
    const { runtime, settings } = await routeFixture()

    await runtime.patchProvider("deepseek", { displayName: null })

    expect(settings.get().llm.providers.deepseek?.displayName).toBeUndefined()
  })

  it("createProvider refuses an existing route; patchProvider refuses an absent one", async () => {
    const { runtime, settings } = await routeFixture()
    const before = JSON.stringify(settings.get().llm)

    await expect(runtime.createProvider("deepseek", { baseURL: "https://new.example" })).rejects.toThrow(/already exists/)
    await expect(runtime.patchProvider("nope", { baseURL: "https://new.example" })).rejects.toThrow(/not configured/)

    expect(JSON.stringify(settings.get().llm)).toBe(before)
  })

  it("createProvider writes a new route with no models at all", async () => {
    const { runtime, settings } = await routeFixture()

    await runtime.createProvider("fresh", { baseURL: "https://fresh.example", protocol: "anthropic-messages" })

    expect(settings.get().llm.providers.fresh).toEqual({ baseURL: "https://fresh.example", protocol: "anthropic-messages" })
  })
})
```

- [ ] **Step 2: Run it — expect RED**

Run: `pnpm -C packages/provider-runtime test`
Expected: FAIL — `runtime.patchProvider is not a function`.

- [ ] **Step 3: Implement**

Interface additions (after `upsertProvider`):

```ts
  /** Create a route. Refuses an id that already exists — `patchProvider` is the
   * verb for changing one, so a typo cannot silently rewrite a live route. */
  createProvider(id: string, fields: Omit<SettingsProviderConfig, "models">): Promise<void>
  /** Change named fields on an existing route. `models` is deliberately NOT
   * patchable: changing a protocol or a base URL must not empty the catalog the
   * route holds. `null` clears a field. */
  patchProvider(id: string, patch: ProviderPatch): Promise<void>
```

And the type, beside `ModelFields`:

```ts
/** The route fields `patchProvider` may change. `models` is absent ON PURPOSE —
 * see the method. `null` CLEARS the field. Not exported: see `ModelFields`. */
interface ProviderPatch {
  baseURL?: string | null
  protocol?: SettingsProviderProtocol | null
  catalog?: string | null
  displayName?: string | null
  modelsURL?: string | null
  apiKeyEnv?: string | null
}
```

The methods (after `upsertProvider`):

```ts
    async createProvider(id, fields) {
      assertProviderId(id)
      const llm = canonicalLlm(options.settings)
      if (llm.providers[id] !== undefined) {
        // No sibling METHOD name in the message: a library caller can act on
        // "patchProvider", but this string also reaches a CLI user, for whom
        // that is not a command they can type. The surface adds its own hint.
        throw new Error(`provider "${id}" already exists`)
      }
      await persistLlm({
        providers: { ...llm.providers, [id]: cloneProviderConfig({ ...fields }) },
        defaultModel: { ...llm.defaultModel },
      })
      discovered.delete(id)
    },

    async patchProvider(id, patch) {
      assertProviderId(id)
      const llm = canonicalLlm(options.settings)
      const current = llm.providers[id]
      if (current === undefined) {
        throw new Error(`provider "${id}" is not configured`)
      }
      const next: SettingsProviderConfig = { ...current }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        if (value === null) delete (next as Record<string, unknown>)[key]
        else (next as Record<string, unknown>)[key] = value
      }
      // No baseURL suffix-stripping here: `SettingsStore.set` normalizes every
      // write (normalizeSettings → normalizeProviderConfig → stripBaseURLSuffix),
      // so a second implementation in the runtime would be a second place for
      // the rule to live — and the helper is module-private in settings, so
      // reaching it would mean exporting it for one caller.
      await persistLlm({
        providers: { ...llm.providers, [id]: cloneProviderConfig(next) },
        defaultModel: { ...llm.defaultModel },
      })
      discovered.delete(id)
    },
```

**No import of `stripBaseURLSuffix`** — it is module-private in settings (`packages/settings/src/index.ts:366`), and it does not need to be reached: the store normalizes on every write, so the suffix is stripped there. `isProviderProtocol` (`:332`) is likewise local; Task 5 uses it from inside the same file.

- [ ] **Step 4: Run it — expect GREEN**

Run: `pnpm -C packages/provider-runtime test`
Expected: PASS (33 + 4 = 37).

- [ ] **Step 5: Mutation proof**

Change `const next: SettingsProviderConfig = { ...current }` to `const next = {} as SettingsProviderConfig` and run.
Expected: the "KEEPS models, displayName and apiKeyEnv" case reddens. Restore and re-run to green.

- [ ] **Step 6: Commit**

```bash
git add packages/provider-runtime/src/index.ts packages/provider-runtime/test/runtime.test.ts
git commit -m "feat(provider-runtime): createProvider and patchProvider — the merge that keeps a route's models"
```

---

### Task 5: protocol moves from the route's identity to its default

**Files:**
- Modify: `packages/settings/src/index.ts:60-73` (`SettingsModel`), `:403-423` (`normalizeModels`)
- Modify: `packages/provider-runtime/src/index.ts` (`runtimeProfile` :473-498, `resolveModel` :401-402)
- Test: `packages/provider-runtime/test/runtime.test.ts`

**Interfaces:**
- Consumes: `ModelFields.protocol` (Task 2 already forwards it, because `setModel` copies any named field).
- Produces: `SettingsModel.protocol?: SettingsProviderProtocol` — the per-row override. Resolution: **row → route → the existing hard-coded default.**

- [ ] **Step 1: Write the failing test**

```ts
describe("protocol: the row overrides the route", () => {
  it("a row's protocol wins over its route's; a row without one inherits the route's", async () => {
    const { runtime, builds } = await fixture({
      providers: {
        gw: {
          baseURL: "https://gw.example",
          protocol: "openai-completions",
          apiKeyEnv: "GW_API_KEY",
          models: [
            { id: "anthropic-model", protocol: "anthropic-messages" },
            { id: "plain-model" },
          ],
        },
      },
      credentials: { GW_API_KEY: "fixture-key" },
      registry(registry) {
        registry.register({ name: "gw", displayName: "Gateway", protocol: "openai-compatible" })
      },
    })

    await runtime.resolveModel({ override: "gw:anthropic-model" })
    await runtime.resolveModel({ override: "gw:plain-model" })

    // adapterProtocol maps openai-completions → openai-compatible.
    expect(builds[0]?.profile.protocol).toBe("anthropic-messages")
    expect(builds[1]?.profile.protocol).toBe("openai-compatible")
  })
})
```

- [ ] **Step 2: Run it — expect RED**

Run: `pnpm -C packages/provider-runtime test`
Expected: FAIL — the first assertion gets `"openai-compatible"` where it expects `"anthropic-messages"`. (This is also the RED for the settings half: without `SettingsModel.protocol`, the fixture's row fails typecheck.)

- [ ] **Step 3: Implement the settings half**

`packages/settings/src/index.ts`, in `SettingsModel` (after `maxTokens`):

```ts
  /** The WIRE PROTOCOL for this model, overriding the route's. One endpoint can
   * serve different models on different protocols (the gateway case), and the
   * protocol is a property of the endpoint, so the route states the default and
   * a row states the exception. Absent → the route's. */
  protocol?: SettingsProviderProtocol
```

In `normalizeModels` (after the `maxTokens` line, `:416`):

```ts
      if (isProviderProtocol(entry.protocol)) model.protocol = entry.protocol
```

And in `packages/settings/src/sections.ts`, add the field to `MODEL_FIELDS` (around `:127-134`), beside `maxTokens`:

```ts
  protocol: { type: "enum", enum: [...PROVIDER_PROTOCOLS] },
```

**Why both, when only one of them is on the write path** (verified: `SettingsStore.set` routes through `normalizeSettings` → `normalizeModels`; `MODEL_FIELDS` feeds the section schema, whose only consumers are `sections.ts:300` and `:549`): the two lists are both definitions of "what a model row is", and a definition that disagrees is how a field disappears without a message. This one is one line.

- [ ] **Step 4: Implement the runtime half**

In `packages/provider-runtime/src/index.ts`, change `runtimeProfile`'s signature and its protocol line:

```ts
function runtimeProfile(
  view: ProviderView,
  apiKey: string | undefined,
  modelModalities?: SettingsInputModality[],
  modelProtocol?: SettingsProviderProtocol,
): ProviderProfile {
```
```ts
    // The MODEL's protocol wins over the route's default. The route is an
    // endpoint, and an endpoint has one protocol — a row that declares another
    // is naming a different endpoint path under the same host and credential.
    protocol: adapterProtocol(modelProtocol ?? view.protocol),
```

And in `resolveModel` (`:401-402`):

```ts
      const userModel = view.user?.models?.find((model) => model.id === modelId)
      const profile = runtimeProfile(view, apiKey, userModel?.inputModalities, userModel?.protocol)
```

- [ ] **Step 5: Run both packages — expect GREEN**

Run: `pnpm -C packages/settings test && pnpm -C packages/provider-runtime test`
Expected: settings PASS (unchanged count), provider-runtime PASS (37 + 1 = 38).

- [ ] **Step 6: Mutation proof**

Change `modelProtocol ?? view.protocol` to `view.protocol` and run.
Expected: the new case's first assertion reddens; the second stays green (it never depended on the override). Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/settings/src/index.ts packages/provider-runtime/src/index.ts packages/provider-runtime/test/runtime.test.ts
git commit -m "feat(settings,provider-runtime): a model row may declare its own protocol"
```

---

### Task 6: `i-harness provider` — the route tree

**Files:**
- Create: `apps/cli/src/provider.ts`
- Modify: `apps/cli/src/index.ts` (dispatch near `:122`; `USAGE` at `:55-60`)
- Modify: `apps/cli/test/bin.test.ts:44` (the pinned usage line)
- Test: `apps/cli/test/provider-command.test.ts`

**Interfaces:**
- Consumes: `ProviderRuntime.directory/createProvider/patchProvider/removeProvider/setApiKey` (Tasks 2, 4), `loadProviderRuntime` (`apps/cli/src/provider-runtime.ts`), `resolveModelCard`, `resolveModelCatalogProvenance`, `listModelCatalogFamily` from `@i-harness/provider`.
- Produces: `parseProviderArgs`, `renderProviderList`, `runProviderCommand`.

- [ ] **Step 1: Re-add the catalog readers (their consumer is this task)**

In `packages/provider/src/index.ts`, restore the three interfaces and two functions that commit `8ec8fda0` pulled out, exactly as they were — `ModelCatalogRow`, `ModelCatalogFamilySource`, `ModelCatalogProvenance`, `resolveModelCatalogProvenance()`, `listModelCatalogFamily(family)`. The loader must again build the `rows` map and the `provenance` list alongside `catalog`.

Gate check for this step alone: `node scripts/audit/check-reachability.mjs --gate` will FAIL with 5 new rows **until Step 4 imports them**. That is expected mid-task; the task is not done until it passes.

- [ ] **Step 2: Write the failing test**

Create `apps/cli/test/provider-command.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProviderArgs, renderProviderList, runProviderCommand } from "../src/provider.ts"

// The CLI face of the provider lifecycle
// (docs/superpowers/specs/2026-09-19-provider-lifecycle-design.md §4). Its
// reason for existing is the same as `i-harness hooks approve`'s: seven
// ProviderRuntime methods had ZERO production callers after M65 deleted the
// TUI, and a capability nothing can exercise is a capability nothing notices
// breaking.
describe("parseProviderArgs", () => {
  it("reads the five subcommands and their flags", () => {
    expect(parseProviderArgs(["provider", "list"])).toEqual({ subcommand: "list", fields: {} })
    expect(parseProviderArgs([
      "provider", "add", "gw",
      "--base-url", "https://gw.example",
      "--protocol", "anthropic-messages",
      "--catalog", "deepseek",
    ])).toEqual({
      subcommand: "add",
      id: "gw",
      fields: { baseURL: "https://gw.example", protocol: "anthropic-messages", catalog: "deepseek" },
    })
    expect(parseProviderArgs(["provider", "rm", "gw"])).toEqual({ subcommand: "rm", id: "gw", fields: {} })
  })

  it("an unknown subcommand is reported, never treated as an id", () => {
    expect(parseProviderArgs(["provider", "aproove", "gw"])).toEqual({
      subcommand: "help",
      fields: {},
      error: "unknown provider subcommand: aproove",
    })
  })

  it("a bad protocol is refused with the valid list", () => {
    const parsed = parseProviderArgs(["provider", "add", "gw", "--protocol", "grpc"])
    expect(parsed.error).toContain("grpc")
    expect(parsed.error).toContain("anthropic-messages")
  })

  it("add without --base-url or --protocol is refused", () => {
    expect(parseProviderArgs(["provider", "add", "gw", "--base-url", "https://gw.example"]).error)
      .toMatch(/--protocol/)
    expect(parseProviderArgs(["provider", "add", "gw", "--protocol", "gemini"]).error)
      .toMatch(/--base-url/)
  })
})

describe("runProviderCommand — the route round trip", () => {
  let home: string
  let previous: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "i-harness-providercmd-"))
    previous = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home
    writeFileSync(join(home, "settings.json"), JSON.stringify({ llm: { providers: {}, defaultModel: { provider: "", model: "" } } }), "utf8")
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    rmSync(home, { recursive: true, force: true })
  })

  it("add → key → list, and the key never reaches stdout", async () => {
    expect(await runProviderCommand([
      "provider", "add", "gw",
      "--base-url", "https://gw.example",
      "--protocol", "anthropic-messages",
      "--catalog", "deepseek",
    ])).toBe(0)

    const stored = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))
    // No `apiKeyEnv` yet: `key` is the verb that writes it, and the credential
    // REF is the runtime's to choose (`providerApiKeyRef`), not the CLI's.
    expect(stored.llm.providers.gw).toEqual({
      baseURL: "https://gw.example",
      protocol: "anthropic-messages",
      catalog: "deepseek",
    })

    // The key is INJECTED, never pushed at process.stdin: a test that writes to
    // the real stdin is a test that hangs on CI.
    expect(await runProviderCommand(["provider", "key", "gw"], { readKey: async () => "sk-secret-value" })).toBe(0)

    const credentials = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8"))
    expect(JSON.stringify(credentials)).toContain("sk-secret-value")
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.apiKeyEnv).toBe("GW_API_KEY")
  })

  it("key refuses an empty read rather than storing nothing", async () => {
    await runProviderCommand(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini"])
    expect(await runProviderCommand(["provider", "key", "gw"], { readKey: async () => "  " })).toBe(1)
  })

  it("add on an existing id fails and says which verb to use", async () => {
    await runProviderCommand(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini"])
    expect(await runProviderCommand(["provider", "add", "gw", "--base-url", "https://other.example", "--protocol", "gemini"])).toBe(1)
  })

  it("set changes one field and keeps the rest", async () => {
    await runProviderCommand(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini", "--display-name", "Old"])
    expect(await runProviderCommand(["provider", "set", "gw", "--protocol", "anthropic-messages"])).toBe(0)

    const row = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw
    expect(row.protocol).toBe("anthropic-messages")
    expect(row.displayName).toBe("Old")
  })

  it("rm removes the route", async () => {
    await runProviderCommand(["provider", "add", "gw", "--base-url", "https://gw.example", "--protocol", "gemini"])
    expect(await runProviderCommand(["provider", "rm", "gw"])).toBe(0)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw).toBeUndefined()
  })
})

describe("renderProviderList", () => {
  it("names the family each route resolves and the table's provenance", () => {
    const out = renderProviderList(
      [{
        id: "deepseek1", displayName: "DeepSeek", protocol: "anthropic-messages",
        configured: true, auth: { configured: true, writable: true }, models: [{ id: "deepseek-flash" }],
        discovery: "available", cardFamily: "deepseek", catalog: "deepseek",
      }],
      { generatedAt: "2026-09-19", families: [{ family: "deepseek", source: "DeepSeek API docs" }] },
    )
    expect(out).toContain("deepseek1")
    expect(out).toContain("card family: deepseek (declared)")
    expect(out).toContain("2026-09-19")
    expect(out).toContain("DeepSeek API docs")
  })

  it("says a route inherits its name when nothing was declared", () => {
    const out = renderProviderList(
      [{
        id: "deepseek", displayName: "DeepSeek", protocol: "anthropic-messages",
        configured: true, auth: { configured: true, writable: true }, models: [],
        discovery: "available", cardFamily: "deepseek",
      }],
      { generatedAt: "2026-09-19", families: [] },
    )
    expect(out).toContain("card family: deepseek (the route name)")
  })
})
```

- [ ] **Step 3: Run it — expect RED**

Run: `pnpm -C apps/cli test provider-command`
Expected: FAIL — cannot resolve `../src/provider.ts`.

- [ ] **Step 4: Implement `apps/cli/src/provider.ts`**

```ts
/**
 * `i-harness provider` — the CLI face of the provider lifecycle
 * (docs/superpowers/specs/2026-09-19-provider-lifecycle-design.md §4).
 *
 * WHY IT EXISTS: M65 deleted the TUI, and with it the only caller of SEVEN
 * ProviderRuntime methods — directory, upsert, remove, setApiKey, clearApiKey,
 * discoverModels, setDefaultModel. Nothing noticed, because nothing could
 * exercise them. This is the same reason `i-harness hooks approve` exists: a
 * rule that cannot be invoked is a rule that is already broken.
 *
 * Shape follows `sessions.ts` and `hooks.ts` — parse → gather → render → run,
 * each piece pure and separately testable.
 */

import { createInterface } from "node:readline"
import {
  listModelCatalogFamily,
  resolveModelCard,
  resolveModelCatalogProvenance,
  type ModelCatalogProvenance,
} from "@i-harness/provider"
import type { ProviderRuntimeEntry } from "@i-harness/provider-runtime"
import { loadProviderRuntime } from "./provider-runtime.ts"

/** The five wire protocols a route may declare. Exported because `models.ts`
 * validates `--protocol` against the SAME list — two copies would drift. */
export const PROVIDER_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages", "gemini", "bedrock"] as const
export type CliProtocol = (typeof PROVIDER_PROTOCOLS)[number]

/** The route fields the CLI can write. `models` is not among them — that is
 * `i-harness models`' job, and keeping them apart is what stops a protocol
 * change from emptying a route's catalog. */
export interface ProviderFields {
  baseURL?: string
  protocol?: CliProtocol
  catalog?: string
  displayName?: string
  modelsURL?: string
}

export interface ParsedProviderArgs {
  subcommand: "list" | "add" | "set" | "key" | "rm" | "help"
  id?: string
  fields: ProviderFields
  error?: string
}

const PROVIDER_USAGE =
  "usage: i-harness provider <list|add|set|key|rm>\n" +
  "  list                                        routes, the card family each resolves, and the table's provenance\n" +
  "  add <id> --base-url URL --protocol P [--catalog F] [--display-name N] [--models-url URL]\n" +
  "  set <id> [--base-url URL] [--protocol P] [--catalog F] [--display-name N] [--models-url URL]\n" +
  "  key <id>                                    read the API key from stdin (never from argv)\n" +
  "  rm <id>\n" +
  `  protocols: ${PROVIDER_PROTOCOLS.join(" | ")}`

export function parseProviderArgs(args: string[]): ParsedProviderArgs {
  const sub = args[1]
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { subcommand: "help", fields: {} }
  }
  const rest = args.slice(2)
  if (sub !== "list" && sub !== "add" && sub !== "set" && sub !== "key" && sub !== "rm") {
    return { subcommand: "help", fields: {}, error: `unknown provider subcommand: ${sub}` }
  }

  let id: string | undefined
  const fields: ProviderFields = {}
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!
    if (!token.startsWith("-")) {
      if (id !== undefined) return { subcommand: "help", fields: {}, error: `unexpected extra argument: ${token}` }
      id = token
      continue
    }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith("--")) {
      return { subcommand: "help", fields: {}, error: `${token} needs a value` }
    }
    i += 1
    if (token === "--base-url") { fields.baseURL = value; continue }
    if (token === "--models-url") { fields.modelsURL = value; continue }
    if (token === "--catalog") { fields.catalog = value; continue }
    if (token === "--display-name") { fields.displayName = value; continue }
    if (token === "--protocol") {
      if (!(PROVIDER_PROTOCOLS as readonly string[]).includes(value)) {
        // Never default a protocol: the schema's fill-in is `openai-completions`
        // (settings/src/sections.ts:116), and applying it silently is a wrong
        // answer stated as a right one.
        return { subcommand: "help", fields: {}, error: `unknown protocol "${value}"; expected one of: ${PROVIDER_PROTOCOLS.join(" | ")}` }
      }
      fields.protocol = value as CliProtocol
      continue
    }
    return { subcommand: "help", fields: {}, error: `unknown flag: ${token}` }
  }

  if (sub !== "list" && id === undefined) {
    return { subcommand: "help", fields: {}, error: `${sub} requires a provider id` }
  }
  if (sub === "add") {
    if (fields.baseURL === undefined) return { subcommand: "help", fields: {}, error: "add requires --base-url" }
    if (fields.protocol === undefined) return { subcommand: "help", fields: {}, error: "add requires --protocol" }
  }
  if (sub !== "list" && sub !== "add" && sub !== "set" && Object.keys(fields).length > 0) {
    return { subcommand: "help", fields: {}, error: `${sub} takes no flags` }
  }
  return { subcommand: sub, ...(id !== undefined ? { id } : {}), fields }
}

export function renderProviderList(
  rows: readonly ProviderRuntimeEntry[],
  provenance: ModelCatalogProvenance,
): string {
  if (rows.length === 0) return "no provider routes configured"
  const lines = [`${rows.length} provider route(s):`, ""]
  for (const row of rows) {
    // Declared vs defaulted is the distinction the whole `catalog` field exists
    // for, so the listing states which one it is.
    lines.push(`  ${row.id}  [${row.protocol}]${row.configured ? "" : "  (not configured)"}`)
    lines.push(`    card family: ${row.cardFamily} (${row.catalog !== undefined ? "declared" : "the route name"})`)
    lines.push(`    discovery: ${row.discovery}`)
    if (row.defaultModel !== undefined) lines.push(`    default model: ${row.defaultModel}`)
    const cards = row.models.map((model) => {
      const card = resolveModelCard(row.cardFamily, model.id)
      const aliases = listModelCatalogFamily(row.cardFamily).find((entry) => entry.modelId === model.id)?.aliases ?? []
      const numbers = card?.contextWindow !== undefined
        ? `${card.contextWindow}${card.maxOutputTokens !== undefined ? ` / ${card.maxOutputTokens}` : ""}`
        : "no card"
      return `      ${model.id}  (${numbers})${aliases.length > 0 ? `  +${aliases.length} retired name(s): ${aliases.join(", ")}` : ""}`
    })
    lines.push("    models:", ...(cards.length > 0 ? cards : ["      (none — try: i-harness models probe " + row.id + ")"]))
    lines.push("")
  }
  lines.push(`model table: last revised ${provenance.generatedAt}`)
  for (const family of provenance.families) lines.push(`  ${family.family}  ${family.source}`)
  return lines.join("\n")
}

/** One line from stdin. A TTY would echo it, so say that rather than pretend. */
async function readStdinLine(): Promise<string> {
  if (process.stdin.isTTY === true) {
    console.error("provider: reading the key from a terminal — it WILL be echoed. Prefer: printf %s \"$KEY\" | i-harness provider key <id>")
  }
  const rl = createInterface({ input: process.stdin, terminal: false })
  for await (const line of rl) {
    rl.close()
    return line.trim()
  }
  return ""
}

/** Injection point for the credential read. Tests MUST use it: writing to the
 * real `process.stdin` from a test is a test that hangs on CI. */
export interface ProviderCommandOptions {
  readKey?: () => Promise<string>
}

export async function runProviderCommand(args: string[], options: ProviderCommandOptions = {}): Promise<number> {
  const parsed = parseProviderArgs(args)
  if (parsed.error !== undefined) {
    console.error(`provider: ${parsed.error}`)
    console.error(PROVIDER_USAGE)
    return 1
  }
  if (parsed.subcommand === "help") {
    console.error(PROVIDER_USAGE)
    return 0
  }

  const { runtime } = await loadProviderRuntime()
  try {
    if (parsed.subcommand === "list") {
      console.log(renderProviderList(await runtime.directory(), resolveModelCatalogProvenance()))
      return 0
    }
    const id = parsed.id!
    if (parsed.subcommand === "add") {
      try {
        await runtime.createProvider(id, { ...parsed.fields })
      } catch (error) {
        // The runtime's message deliberately names no sibling method; this is
        // where the CLI verb the user can actually type belongs.
        console.error(`provider: ${error instanceof Error ? error.message : String(error)}`)
        console.error(`  to change an existing route: i-harness provider set ${id} [flags]`)
        return 1
      }
      // The credential REF is decided by the runtime; print it so the next
      // step is a copy-paste rather than a guess.
      console.log(`created provider "${id}"\n  next: i-harness provider key ${id}`)
      return 0
    }
    if (parsed.subcommand === "set") {
      try {
        await runtime.patchProvider(id, { ...parsed.fields })
      } catch (error) {
        console.error(`provider: ${error instanceof Error ? error.message : String(error)}`)
        console.error(`  to create a route: i-harness provider add ${id} --base-url URL --protocol P`)
        return 1
      }
      console.log(`updated provider "${id}"`)
      return 0
    }
    if (parsed.subcommand === "key") {
      const value = (await (options.readKey ?? readStdinLine)()).trim()
      if (value === "") {
        console.error("provider: no key on stdin")
        return 1
      }
      await runtime.setApiKey(id, value)
      const tail = value.length > 4 ? value.slice(-4) : value
      console.log(`stored a credential for "${id}" (x…${tail})`)
      return 0
    }
    await runtime.removeProvider(id)
    console.log(`removed provider "${id}"`)
    return 0
  } catch (error) {
    console.error(`provider: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
```

- [ ] **Step 5: Wire the dispatch and the usage**

In `apps/cli/src/index.ts`, import and dispatch beside the `hooks` branch (`:122`):

```ts
  // The provider lifecycle's route tree
  // (docs/superpowers/specs/2026-09-19-provider-lifecycle-design.md §4). Same
  // reason as `hooks`: M65 left seven ProviderRuntime methods with no caller.
  if (args[0] === "provider") {
    return runProviderCommand(args)
  }
```

and extend `USAGE`'s first two lines:

```ts
  "usage: i-harness [<run|sdk|acp|sessions|hooks|provider> ...]\n" +
```
```ts
  "  hooks <list|approve|revoke> [sha256] |\n" +
  "  provider <list|add|set|key|rm>"
```

Then update the pin in `apps/cli/test/bin.test.ts:44`:

```ts
    expect(r.stderr).toContain("[<run|sdk|acp|sessions|hooks|provider> ...]")
```

- [ ] **Step 6: Run — expect GREEN, and the gate PASS**

Run: `pnpm -C apps/cli test provider-command && pnpm -C apps/cli test bin && pnpm typecheck && node scripts/audit/check-reachability.mjs --gate`
Expected: PASS, and `gate PASS -- no new rows` (the five readers now have their consumer).

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/provider.ts apps/cli/src/index.ts apps/cli/test/provider-command.test.ts apps/cli/test/bin.test.ts packages/provider/src/index.ts
git commit -m "feat(cli): i-harness provider — the route tree, and the catalog readers' first consumer"
```

---

### Task 7: `i-harness models` — the model tree

**Files:**
- Create: `apps/cli/src/models.ts`
- Modify: `apps/cli/src/index.ts` (dispatch + `USAGE`)
- Modify: `apps/cli/test/bin.test.ts:44`
- Test: `apps/cli/test/models-command.test.ts`

**Interfaces:**
- Consumes: `ProviderRuntime.directory/probeModels/addModels/setModel/removeModel/discoverModels/setDefaultModel` (Tasks 1, 2, 3), `resolveModelCard` (existing).
- Produces: `parseModelsArgs`, `renderModels`, `parseTokenValue`, `runModelsCommand`.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/models-command.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseModelsArgs, parseTokenValue, renderModels, runModelsCommand } from "../src/models.ts"

describe("parseTokenValue", () => {
  it("reads plain integers, k/m suffixes, and `auto`", () => {
    expect(parseTokenValue("131072")).toEqual({ kind: "value", value: 131_072 })
    expect(parseTokenValue("128k")).toEqual({ kind: "value", value: 131_072 })
    expect(parseTokenValue("1m")).toEqual({ kind: "value", value: 1_000_000 })
    expect(parseTokenValue("auto")).toEqual({ kind: "clear" })
  })

  it("refuses anything else rather than guessing", () => {
    expect(parseTokenValue("128kb").kind).toBe("error")
    expect(parseTokenValue("0").kind).toBe("error")
    expect(parseTokenValue("-1").kind).toBe("error")
    expect(parseTokenValue("").kind).toBe("error")
  })
})

describe("parseModelsArgs", () => {
  it("reads the subcommands", () => {
    expect(parseModelsArgs(["models"])).toEqual({ subcommand: "list", ids: [], values: {} })
    expect(parseModelsArgs(["models", "probe", "gw"])).toEqual({ subcommand: "probe", route: "gw", ids: [], values: {} })
    expect(parseModelsArgs(["models", "add", "gw", "a", "b", "--context-window", "1m"]))
      .toEqual({ subcommand: "add", route: "gw", ids: ["a", "b"], values: { contextWindow: { kind: "value", value: 1_000_000 } } })
    expect(parseModelsArgs(["models", "set", "gw", "a", "--max-tokens", "auto"]))
      .toEqual({ subcommand: "set", route: "gw", ids: ["a"], values: { maxTokens: { kind: "clear" } } })
  })

  it("a bad value is an error, not a silent skip", () => {
    expect(parseModelsArgs(["models", "set", "gw", "a", "--context-window", "1_000_000"]).values.contextWindow)
      .toEqual({ kind: "value", value: 1_000_000 })
    expect(parseModelsArgs(["models", "set", "gw", "a", "--context-window", "huge"]).error).toMatch(/huge/)
  })

  it("a bare first token is a ROUTE, not an unknown subcommand", () => {
    // `models myroute` is the list-one-route form, so a bare token cannot be
    // diagnosed as an unknown subcommand — it IS a route until a second one
    // proves otherwise, and that second one is the error.
    expect(parseModelsArgs(["models", "myroute"]))
      .toEqual({ subcommand: "list", route: "myroute", ids: [], values: {} })
    expect(parseModelsArgs(["models", "discovr", "gw"]).error).toMatch(/unexpected extra argument/)
  })

  it("missing arguments are reported", () => {
    expect(parseModelsArgs(["models", "add", "gw"]).error).toMatch(/at least one model id/)
    expect(parseModelsArgs(["models", "rm", "gw", "a", "b"]).error).toMatch(/exactly one model id/)
  })

  it("--protocol takes one of the five, or `auto` — never a guess", () => {
    expect(parseModelsArgs(["models", "set", "gw", "a", "--protocol", "anthropic-messages"]).values.protocol)
      .toBe("anthropic-messages")
    expect(parseModelsArgs(["models", "set", "gw", "a", "--protocol", "auto"]).values.protocol).toBeNull()
    expect(parseModelsArgs(["models", "set", "gw", "a", "--protocol", "grpc"]).error).toMatch(/grpc/)
  })
})

describe("renderModels", () => {
  it("shows each model's card, its retired names, and flags a route with no card at all", () => {
    const out = renderModels([
      {
        id: "deepseek1", cardFamily: "deepseek", declared: true, protocol: "anthropic-messages",
        models: [{ id: "deepseek-flash", card: { contextWindow: 1_048_576, maxOutputTokens: 384_000 }, aliases: ["deepseek-v4-flash"] }],
      },
      {
        id: "gw", cardFamily: "gw", declared: false, protocol: "openai-completions",
        models: [{ id: "mystery", card: undefined, aliases: [] }],
      },
    ])
    expect(out).toContain("deepseek1")
    expect(out).toContain("1048576 / 384000")
    expect(out).toContain("deepseek-v4-flash")
    // The D1/D2 diagnosis, stated where a human will see it.
    expect(out).toContain("no card resolves for: gw")
  })
})

describe("runModelsCommand", () => {
  let home: string
  let previous: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "i-harness-modelscmd-"))
    previous = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      llm: {
        providers: {
          gw: { baseURL: "https://gw.example", protocol: "openai-completions", apiKeyEnv: "GW_API_KEY", catalog: "deepseek", models: [{ id: "keep-me" }] },
        },
        defaultModel: { provider: "", model: "" },
      },
    }), "utf8")
    writeFileSync(join(home, "credentials.json"), JSON.stringify({ GW_API_KEY: "fixture-key" }), "utf8")
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    rmSync(home, { recursive: true, force: true })
  })

  it("add writes only the ids given, with the numbers given", async () => {
    expect(await runModelsCommand(["models", "add", "gw", "deepseek-flash", "--context-window", "128k"])).toBe(0)

    const models = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.models
    expect(models).toEqual([{ id: "keep-me" }, { id: "deepseek-flash", contextWindow: 131_072 }])
  })

  it("set changes one row; `auto` clears the override back to the card", async () => {
    await runModelsCommand(["models", "add", "gw", "deepseek-flash", "--context-window", "128k"])
    expect(await runModelsCommand(["models", "set", "gw", "deepseek-flash", "--context-window", "auto"])).toBe(0)

    const models = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.models
    expect(models).toEqual([{ id: "keep-me" }, { id: "deepseek-flash" }])
  })

  it("rm takes a row out; an absent row is a failure, not a shrug", async () => {
    expect(await runModelsCommand(["models", "rm", "gw", "keep-me"])).toBe(0)
    expect(await runModelsCommand(["models", "rm", "gw", "keep-me"])).toBe(1)
  })

  it("set can declare a per-model protocol, and `auto` clears it back to the route's", async () => {
    await runModelsCommand(["models", "add", "gw", "deepseek-flash"])

    expect(await runModelsCommand(["models", "set", "gw", "deepseek-flash", "--protocol", "anthropic-messages"])).toBe(0)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.models)
      .toEqual([{ id: "keep-me" }, { id: "deepseek-flash", protocol: "anthropic-messages" }])

    expect(await runModelsCommand(["models", "set", "gw", "deepseek-flash", "--protocol", "auto"])).toBe(0)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.providers.gw.models)
      .toEqual([{ id: "keep-me" }, { id: "deepseek-flash" }])
  })

  it("use writes llm.defaultModel", async () => {
    expect(await runModelsCommand(["models", "use", "gw:deepseek-flash"])).toBe(0)
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).llm.defaultModel)
      .toEqual({ provider: "gw", model: "deepseek-flash" })
  })

  it("a route that cannot be probed fails loudly (bedrock is manual-only)", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      llm: { providers: { br: { baseURL: "https://br.example", protocol: "bedrock", models: [] } }, defaultModel: { provider: "", model: "" } },
    }), "utf8")
    expect(await runModelsCommand(["models", "probe", "br"])).toBe(1)
  })
})
```

- [ ] **Step 2: Run it — expect RED**

Run: `pnpm -C apps/cli test models-command`
Expected: FAIL — cannot resolve `../src/models.ts`.

- [ ] **Step 3: Implement `apps/cli/src/models.ts`**

```ts
/**
 * `i-harness models` — the model tree of the provider lifecycle
 * (docs/superpowers/specs/2026-09-19-provider-lifecycle-design.md §4).
 *
 * `probe` is the ONLY verb here that touches the network, and it WRITES
 * NOTHING — that split is the whole reason `probeModels` exists beside
 * `discoverModels`. What the user's flow called "multi-select" is `add` with
 * several ids.
 *
 * Shape follows `sessions.ts` and `hooks.ts`.
 */

import { listModelCatalogFamily, resolveModelCard, type ModelCard } from "@i-harness/provider"
import type { ProviderRuntime } from "@i-harness/provider-runtime"
import { PROVIDER_PROTOCOLS, type CliProtocol } from "./provider.ts"
import { loadProviderRuntime } from "./provider-runtime.ts"

/** A parsed `--context-window` / `--max-tokens` argument. `auto` CLEARS the
 * override and falls back to the card — without it, a number once written
 * could never be taken back. */
export type TokenValue = { kind: "value"; value: number } | { kind: "clear" } | { kind: "error"; message: string }

export function parseTokenValue(raw: string): TokenValue {
  const normalized = raw.trim().toLowerCase()
  if (normalized === "auto") return { kind: "clear" }
  const match = /^(\d+)([km]?)$/.exec(normalized)
  if (match === null) return { kind: "error", message: `expected a positive integer, k/m suffix, or "auto"; got "${raw}"` }
  const value = Number(match[1]) * (match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1)
  if (!Number.isSafeInteger(value) || value <= 0) return { kind: "error", message: `not a positive token count: "${raw}"` }
  return { kind: "value", value }
}

export interface ModelValues {
  contextWindow?: TokenValue
  maxTokens?: TokenValue
  /** A settings protocol name, or `null` for `auto` (clear the row's override
   * and fall back to the route's default — NOT to the hard-coded one). */
  protocol?: CliProtocol | null
}

export interface ParsedModelsArgs {
  subcommand: "list" | "probe" | "add" | "set" | "rm" | "use" | "refresh" | "help"
  route?: string
  ids: string[]
  values: ModelValues
  error?: string
}

const MODELS_USAGE =
  "usage: i-harness models <list|probe|add|set|rm|use|refresh> [args]\n" +
  "  [<route>]                                 what each model resolves, and whether the route can be probed\n" +
  "  probe <route>                             ask the endpoint what it offers — WRITES NOTHING\n" +
  "  add <route> <id...> [--protocol P] [--context-window V] [--max-tokens V]\n" +
  "  set <route> <id>    [--protocol P] [--context-window V] [--max-tokens V]\n" +
  "  rm <route> <id>\n" +
  "  use <route>:<model> [--reasoning-effort E]\n" +
  "  refresh <route>                           probe and merge everything it returns\n" +
  "  V = 131072 | 128k | 1m | auto    (auto clears the override, falling back to the card)\n" +
  "  P = one of the five protocols | auto  (auto falls back to the ROUTE's protocol)"

export function parseModelsArgs(args: string[]): ParsedModelsArgs {
  const rest = args.slice(1)
  const values: ModelValues = {}
  const positional: string[] = []
  let subcommand: ParsedModelsArgs["subcommand"] = "list"

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!
    if (token === "--context-window" || token === "--max-tokens") {
      const raw = rest[i + 1]
      if (raw === undefined) return { subcommand: "help", ids: [], values: {}, error: `${token} needs a value` }
      i += 1
      const parsed = parseTokenValue(raw)
      if (parsed.kind === "error") return { subcommand: "help", ids: [], values: {}, error: parsed.message }
      if (token === "--context-window") values.contextWindow = parsed
      else values.maxTokens = parsed
      continue
    }
    if (token === "--protocol") {
      const raw = rest[i + 1]
      if (raw === undefined) return { subcommand: "help", ids: [], values: {}, error: "--protocol needs a value" }
      i += 1
      // `auto` clears the row's override, falling back to the ROUTE's default.
      // The hard-coded `openai-completions` arm is never a destination the CLI
      // can name — it is the failure mode, not a choice.
      if (raw === "auto") { values.protocol = null; continue }
      if (!(PROVIDER_PROTOCOLS as readonly string[]).includes(raw)) {
        return { subcommand: "help", ids: [], values: {}, error: `unknown protocol "${raw}"; expected one of: ${PROVIDER_PROTOCOLS.join(" | ")} | auto` }
      }
      values.protocol = raw as CliProtocol
      continue
    }
    if (token.startsWith("-")) return { subcommand: "help", ids: [], values: {}, error: `unknown flag: ${token}` }
    if (positional.length === 0 && ["list", "probe", "add", "set", "rm", "use", "refresh"].includes(token)) {
      subcommand = token as ParsedModelsArgs["subcommand"]
      continue
    }
    positional.push(token)
  }

  if (subcommand === "list") {
    if (positional.length > 1) return { subcommand: "help", ids: [], values: {}, error: "unexpected extra argument" }
    if (positional.length > 0) return { subcommand, route: positional[0], ids: [], values }
    return { subcommand, ids: [], values }
  }
  if (subcommand === "use") {
    if (positional.length !== 1) return { subcommand: "help", ids: [], values: {}, error: "use takes <route>:<model>" }
    if (!positional[0]!.includes(":")) return { subcommand: "help", ids: [], values: {}, error: `use needs provider:model; got "${positional[0]}"` }
    return { subcommand, route: positional[0], ids: [], values }
  }
  if (subcommand === "probe" || subcommand === "refresh") {
    if (positional.length !== 1) return { subcommand: "help", ids: [], values: {}, error: `${subcommand} takes exactly one route` }
    return { subcommand, route: positional[0], ids: [], values }
  }
  if (subcommand === "rm") {
    if (positional.length !== 2) return { subcommand: "help", ids: [], values: {}, error: "rm takes exactly one model id" }
    return { subcommand, route: positional[0], ids: [positional[1]!], values }
  }
  // add / set
  if (positional.length < 2) return { subcommand: "help", ids: [], values: {}, error: `${subcommand} takes a route and at least one model id` }
  if (subcommand === "set" && positional.length !== 2) return { subcommand: "help", ids: [], values: {}, error: "set takes exactly one model id" }
  return { subcommand, route: positional[0], ids: positional.slice(1), values }
}

export interface ModelsRouteView {
  id: string
  cardFamily: string
  declared: boolean
  protocol: string
  models: Array<{ id: string; card: ModelCard | undefined; aliases: string[] }>
}

export function renderModels(routes: readonly ModelsRouteView[]): string {
  if (routes.length === 0) return "no provider routes configured"
  const lines: string[] = []
  const cardless: string[] = []
  for (const route of routes) {
    lines.push(`${route.id}  [${route.protocol}]  card family: ${route.cardFamily} (${route.declared ? "declared" : "the route name"})`)
    if (route.models.length === 0) lines.push("  (no models — try: i-harness models probe " + route.id + ")")
    for (const model of route.models) {
      const numbers = model.card?.contextWindow !== undefined
        ? `${model.card.contextWindow}${model.card.maxOutputTokens !== undefined ? ` / ${model.card.maxOutputTokens}` : ""}`
        : "no card"
      lines.push(`  ${model.id}  (${numbers})${model.aliases.length > 0 ? `  +retired: ${model.aliases.join(", ")}` : ""}`)
    }
    // The D1/D2 symptom, said out loud: a route whose family resolves nothing
    // is exactly the state that used to fail silently.
    if (route.models.length > 0 && route.models.every((model) => model.card === undefined)) cardless.push(route.id)
    lines.push("")
  }
  if (cardless.length > 0) {
    lines.push(`no card resolves for: ${cardless.join(", ")} — declare \`catalog\` on the route, or add the family to model-catalog.json`)
  }
  return lines.join("\n")
}

async function viewOf(runtime: ProviderRuntime, only?: string): Promise<ModelsRouteView[]> {
  const rows = await runtime.directory()
  return rows
    .filter((row) => only === undefined || row.id === only)
    .map((row) => {
      const family = listModelCatalogFamily(row.cardFamily)
      return {
        id: row.id,
        cardFamily: row.cardFamily,
        declared: row.catalog !== undefined,
        protocol: row.protocol,
        models: row.models.map((model) => {
          const own = family.find((entry) => entry.modelId === model.id)
          // BOTH directions matter. A row that IS the current name carries its
          // retired names; a row that is ITSELF retired says which name it is —
          // and that second direction is what tells a user holding
          // `deepseek-v4-flash` why it still resolves (design §1.2).
          const owner = own === undefined ? family.find((entry) => entry.aliases.includes(model.id)) : undefined
          return {
            id: model.id,
            card: own?.card ?? owner?.card,
            aliases: own?.aliases ?? (owner !== undefined ? [`alias of ${owner.modelId}`] : []),
          }
        }),
      }
    })
}

export async function runModelsCommand(args: string[]): Promise<number> {
  const parsed = parseModelsArgs(args)
  if (parsed.error !== undefined) {
    console.error(`models: ${parsed.error}`)
    console.error(MODELS_USAGE)
    return 1
  }
  if (parsed.subcommand === "help") {
    console.error(MODELS_USAGE)
    return 0
  }

  const { runtime } = await loadProviderRuntime()
  const fields = {
    ...(parsed.values.contextWindow !== undefined
      ? { contextWindow: parsed.values.contextWindow.kind === "clear" ? null : parsed.values.contextWindow.value }
      : {}),
    ...(parsed.values.maxTokens !== undefined
      ? { maxTokens: parsed.values.maxTokens.kind === "clear" ? null : parsed.values.maxTokens.value }
      : {}),
    ...(parsed.values.protocol !== undefined ? { protocol: parsed.values.protocol } : {}),
  }

  try {
    if (parsed.subcommand === "list") {
      console.log(renderModels(await viewOf(runtime, parsed.route)))
      return 0
    }
    const route = parsed.route!
    if (parsed.subcommand === "probe") {
      const models = await runtime.probeModels(route)
      console.log(`${models.length} model(s) found — NOTHING was written:`)
      for (const model of models) {
        const card = resolveModelCard(
          (await runtime.directory()).find((row) => row.id === route)?.cardFamily ?? route,
          model.id,
        )
        console.log(`  ${model.id}  ${card?.contextWindow !== undefined ? `card ${card.contextWindow}` : "no card"}`)
      }
      if (models.length > 0) console.log(`next: i-harness models add ${route} <id> ...`)
      return 0
    }
    if (parsed.subcommand === "refresh") {
      const models = await runtime.discoverModels(route, { force: true })
      console.log(`refreshed "${route}": ${models.length} model(s) now in its list`)
      return 0
    }
    if (parsed.subcommand === "add") {
      // Which ids already existed is REPORTED, because `addModels` follows the
      // merge rule (an existing row wins) and a silently-ignored
      // --context-window would be exactly the kind of quiet wrong answer this
      // repo keeps measuring.
      const before = new Set((await runtime.directory()).find((row) => row.id === route)?.models.map((model) => model.id) ?? [])
      const already = parsed.ids.filter((modelId) => before.has(modelId))
      const models = await runtime.addModels(route, parsed.ids.map((modelId) => ({ id: modelId, ...fields })))
      console.log(`"${route}": ${models.length} model(s)`)
      if (already.length > 0) {
        console.log(`  already present and left alone: ${already.join(", ")} — use \`models set\` to change one`)
      }
      return 0
    }
    if (parsed.subcommand === "set") {
      await runtime.setModel(route, parsed.ids[0]!, fields)
      console.log(`"${route}"/"${parsed.ids[0]}" updated`)
      return 0
    }
    if (parsed.subcommand === "rm") {
      await runtime.removeModel(route, parsed.ids[0]!)
      console.log(`"${route}"/"${parsed.ids[0]}" removed`)
      return 0
    }
    const separator = route.indexOf(":")
    await runtime.setDefaultModel({ provider: route.slice(0, separator), model: route.slice(separator + 1) })
    console.log(`default model: ${route}`)
    return 0
  } catch (error) {
    console.error(`models: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
```

- [ ] **Step 4: Wire the dispatch and the usage**

In `apps/cli/src/index.ts`, beside the `provider` branch:

```ts
  if (args[0] === "models") {
    return runModelsCommand(args)
  }
```

and extend `USAGE`:

```ts
  "usage: i-harness [<run|sdk|acp|sessions|hooks|provider|models> ...]\n" +
```
```ts
  "  provider <list|add|set|key|rm> | models <list|probe|add|set|rm|use|refresh>"
```

Update the pin in `apps/cli/test/bin.test.ts:44` to `"[<run|sdk|acp|sessions|hooks|provider|models> ...]"`.

- [ ] **Step 5: Run — expect GREEN**

Run: `pnpm -C apps/cli test && pnpm typecheck && node scripts/audit/check-reachability.mjs --gate`
Expected: PASS everywhere.

- [ ] **Step 6: Mutation proof**

In `runModelsCommand`'s `probe` branch, delete the `await runtime.probeModels(...)` call and read from `directory()` instead — or, simpler and equally decisive: change `parseTokenValue`'s `auto` branch to `{ kind: "value", value: 0 }` and run.
Expected: `parseTokenValue`'s "reads … and `auto`" case and the `set … auto` case redden. Restore.

- [ ] **Step 7: Run the full suite and commit**

```bash
pnpm test
git add apps/cli/src/models.ts apps/cli/src/index.ts apps/cli/test/models-command.test.ts apps/cli/test/bin.test.ts
git commit -m "feat(cli): i-harness models — probe, choose, override, use"
```

---

## Self-Review

**Spec coverage:**
- §1.1 route fields → Task 4 (`createProvider`/`patchProvider`) + Task 6.
- §1.2 model row gains `protocol` → Task 5.
- §1.3 protocol resolution arm → Task 5 (row → route → existing default).
- §1.4 two numeric layers, no global → existing behaviour; Task 7's `auto` is what makes layer ① reversible.
- §2 protocol on the model, evidence from Pi → Task 5.
- §3.1 five methods → Tasks 1, 2, 4.
- §3.2 `discoverModels` recomposition → Task 3.
- §3.3 one-line resolution change → Task 5 Step 4.
- §3.4 settings field → Task 5 Step 3.
- §4 two command trees → Tasks 6, 7.
- §5 error table → `parseProviderArgs`/`parseModelsArgs` refusals + the `try/catch` exit-1 paths.
- §7 tests → each task's steps; the mutation proofs are named per task.
- §8 open items → NOT implemented, by design (send-time protocol override; multi-vendor gateways; `--max-tokens` still has no consumer).

**Placeholder scan:** none — every step carries its code or its exact command.

**Type consistency:** `ModelFields` (Task 2) and `ProviderPatch` (Task 4) both use `| null` for clearing and are consumed by `setModel` / `patchProvider` respectively; `ProviderFields` (Task 6) has no `null` because the CLI expresses "clear" by not passing the flag. `ProviderRuntimeEntry.cardFamily` / `.catalog` already exist (commit `c98a05ba`). `TokenValue` is defined in Task 7 and used only there.
