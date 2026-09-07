# M49 Grok TUI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **2026-09-07 交付注：** 本計劃 Task 1–15 全部執行完畢並由各 Task 報告 + 最終 PTY case-028（整合 parity）+ 全庫驗證關卡背書（見 `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/task-15-report.md`）。上面 Checkbox 以任務載入時的記錄（progress.md）為準；Task 15 唯一額外修正是將 `pnpm typecheck` 的工作區循環以 `pnpm-workspace.yaml ignoreWorkspaceCycles: true` 解決（指令 2 的 ruling 選擇），並以 `as unknown as SessionService` 放寬 acp 測試 mock 之舊型別斷言。

**Goal:** Make the I-harness TUI visually and behaviorally align with Grok Build wherever I-harness has a real backend capability, while removing every production mock-model, fixture-only, and toast-only path.

**Architecture:** Keep the TypeScript TUI, cell renderer, and I-harness agent runtime. Add a small `provider-runtime` composition package and a shared `text-diff` contract; extend existing session/subagent/backend capabilities rather than copying Grok's Rust runtime. All UI visibility is capability-driven, and missing provider/model/auth leaves the prompt disabled instead of constructing a mock.

**Tech Stack:** TypeScript ESM, pnpm workspaces, Vitest 3.2.7, Node.js >=22.18, existing `tui-core` cell renderer and PTY harness, JSONL session persistence, SDK JSON-RPC wire, provider/settings/credentials packages.

**Spec:** `docs/superpowers/specs/2026-09-06-m49-grok-tui-parity-design.md`

## Global Constraints

- Production composition must never pass `modelPolicy: "test-mock"`; only unit and PTY harnesses may opt in explicitly.
- `settings.llm.providers` is the only final provider/model persistence plane; `settings.tui` keeps presentation/input/dashboard preferences only.
- Raw API keys, bearer tokens, passwords, and authorization headers never enter settings, status lines, tool summaries, snapshots, or logs.
- Provider protocol/profile/probe/client code remains in `provider`; settings/credentials composition belongs in `provider-runtime`.
- Session lifecycle/model binding/queue changes follow `session-executor` and `core-agent` patterns; task projections follow `subagent`/`jobs` patterns.
- Visible TUI commands, rows, hit areas, settings, and actions require a real backend or local source; absent capability means hidden or explicitly unavailable.
- Unknown or hidden slash commands render `Unsupported command: /<name>` and are never submitted to the LLM.
- Minimal mode must not enter the alternate screen or emit mouse-enable sequences.
- Fullscreen zero-byte idle, resize, UTF-8/codepage, selection, timeline, and byte-budget invariants remain green.
- New behavior follows strict red-green-refactor TDD. Every task ends with focused tests, typecheck, commit, task-spec review, and task-quality review.
- Do not modify or stage `D:\I-harness-main\packages\tui-core\test\harness\case-010.test.ts` from the main checkout; M49 work is confined to `D:\I-harness-main\.worktrees\m49`.

---

## File Structure Map

| Area | Files and responsibility |
|---|---|
| Canonical config/auth | `packages/settings/src/{index,sections}.ts`, `packages/credentials/src/index.ts` |
| Provider composition | new `packages/provider-runtime/{package.json,tsconfig.json,src/index.ts,test/runtime.test.ts}` |
| Model/session binding | `packages/session-executor/src/{assembly,service,index}.ts`, `packages/core-agent/src/executor.ts` |
| SDK capabilities | `packages/sdk/src/{protocol,server,client,index}.ts`, `packages/tui/src/backend/{embedded,remote}.ts` |
| Executable composition | `apps/cli/src/{index,web}.ts`, `apps/tui/src/index.ts` |
| Welcome/settings/editor | `packages/tui/src/views/*`, `packages/tui/src/app/*`, new `packages/tui/src/editor/*` |
| Terminal/theme | `packages/tui-core/src/{terminal,theme,renderer}.ts` and palette modules |
| Diff/tool presentation | new `packages/text-diff/*`, `packages/fs/src/index.ts`, new `packages/tui/src/tool-presentation/*` |
| Queue/tasks/dashboard | `packages/core-agent/src/executor.ts`, `packages/session-executor/src/*`, `packages/subagent/src/*`, `packages/tui/src/views/*` |
| Slash/prompt | `packages/tui/src/app/slash/*`, `packages/preset/src/*`, `packages/session-executor/src/assembly.ts` |
| PTY/final docs | `packages/tui/test/harness/case-024..028*`, `docs/CAPABILITIES*.md`, `README.md` |

## Spec Coverage Map

| Spec requirement | Plan task(s) |
|---|---|
| Canonical providers/auth/OAuth extension boundary | 1, 2, 6 |
| Production no-mock and per-session model binding | 3, 4, 5 |
| Welcome/startup and Grok-like screen composition | 5 |
| Models & Providers settings and typed settings registry | 6 |
| Prompt editing and visible cursor | 7 |
| Minimal mode and five themes | 8 |
| Structured diff and typed tool blocks | 9, 10 |
| Modal/viewer/clipboard/approval/question | 10 |
| Queue projection/cancel | 11 |
| Tasks/subagents/jobs projection | 12 |
| Dashboard and truthful status line | 13 |
| Slash commands, prompts, runtime mouse/input precedence | 14 |
| Integrated PTY/e2e/dist/docs delivery | 15 |

## Preflight Already Completed

- M49 worktree/branch created from M48 final.
- `pnpm install --frozen-lockfile` and `pnpm typecheck` passed at baseline.
- Cross-platform shell-test assumptions fixed in commits `dba65e8` and `4a06b5a`.
- Windows native-module/test-worker isolation fixed in commit `a963fe9`.
- Detailed inventory committed as `88c6764`; design spec committed in `80c45ca`, `35b38c5`, and `b55406e`.

## Test Fixture Contract

Every helper name used below is test-local and must exercise the real unit under test. These definitions are binding:

| Helper | Required construction |
|---|---|
| `loadedStore()` | A `SettingsStore` under a fresh `mkdtempSync()` directory, followed by `await store.load()` |
| `fixture(...)` in provider-runtime tests | Real in-memory/temp settings and credentials, injected `ProviderRegistry`, injected auth resolver, and injected `buildClient` returning a capturing `ModelClient` |
| `readyFixture()` | Provider `deepseek` with models `override-model`, `session-model`, and `default-model`, a configured key ref, and default `deepseek:default-model` |
| `bedrockFixture()` | Canonical Bedrock provider/model, no API key ref, ambient auth resolver, and a capturing Bedrock-compatible fake client builder |
| `failingProbeFixture()` | Real settings store plus a registry probe that throws `ModelProbeFailedError`; returns `{ runtime, settings }` |
| `scriptedModel(text)` / `capturingModel()` | A real `ModelClient` test double whose `stream()` records `LLMRequest` and yields the literal text then `end` |
| `recordingBackend(...)` | Full structural `BackendClient` fake with call arrays and only the explicitly requested optional capabilities present |
| `testOptions(...)` | Real renderer, engine, palette, glyphs, write sink, and the supplied backend; no mocked presenter |
| `screenText()` / `key(name)` | Read the actual virtual renderer cells / construct a real parsed key event |
| `createExecutableApp()` | Task 5 executable test seam returning app/backend after initialization with injected provider runtime and streams |
| `providerFixture()` | Real temp settings/credentials plus Task 2 provider-runtime with injected registry/fetch/client builder |
| `seedCanonicalProvider(configDir, row)` | Set `IH_CONFIG_DIR=configDir`, write `settings.json` through `SettingsStore`, write the credential through `CredentialStore`, and point the provider at a local fixture server |
| `spawnSdkFor(configDir)` | Spawn the real CLI SDK subprocess with `IH_CONFIG_DIR=configDir` and return the real `HarnessClient` |
| `providerController(runtime, options)` | Real `ProviderController` using the supplied runtime and optional recording backend/session id |
| `readyRuntime()` / `manualOnlyRuntime()` | Task 2 runtime fixtures whose directory reports respectively discoverable DeepSeek or manual-only Bedrock |
| `cap256()` | `TerminalCapabilityContext` with color level 256 and no truecolor |
| `recordingTerminal()` | Real terminal surface over a byte-collecting stream; no mocked init/teardown methods |
| `createExecutableTui(...)` | `apps/tui` test seam with injected streams/backend/runtime/terminal, returning after initialization without entering an unbounded input loop |
| `runRealEditTurn()` | Real `createSessionAssembly` with a scripted model calling the actual fs edit tool in a temp workspace |
| `runApplyPatchFixture()` | Real fs `apply_patch` tool against a temp file with a literal unified patch |
| `diffPresentation()` | A literal `ToolPresentation` containing one `TextDiff` with `-old line` and `+new line` |
| `toolStart()` / `toolDone()` | Literal typed `TuiToolEvent` constructors sharing one call id |
| `createExecutableHost(...)` | Real `apps/tui` composition test seam exposing service plus approval/question bridge observers |
| `deferred<T>()` | `{ promise, resolve, reject }` promise controller used only to conditionally wait, never fixed sleeps |
| `serviceWithBlockingModel()` | Real `SessionService` whose injected model waits on `deferred()` before yielding `end` |
| `blockingService()` | Returns `{ service, seen, release }`; `seen` records actual model tasks and `release()` settles the first turn |
| `waitForQueueText()` | Condition-polls `service.queue()` until the literal text appears or throws after 5000ms |
| `queueBackend()` | Recording `BackendClient` with real in-memory queue snapshots and cancel mutation |
| `fixtureState()` | Real subagent registries populated through their public create/register methods, not object casts of private maps |
| `row(id,title)` | Literal `DashboardSessionRow` with `updatedAt: 1`, `live: false`, and only fields named by the test |
| `collectStatus()` | Calls the production builtin status aggregator with injected git/context/model/task sources |
| `scriptedStatusRunner()` | Condition-controlled runner returning each literal string/error in order |
| `dashboardApp()` | Real `TuiApp` with an injected dashboard backend and renderer |
| `context()` | Literal status/slash context with only fields named by the test |
| `recordingSlashContext()` | Real `SlashContext` shape with each optional capability implemented by one call-recording function |
| `slashContext()` / `slashApp()` | Real registry/app construction over `recordingSlashContext()` / `recordingBackend()` |
| `runSlash()` | Resolve through the production `CommandRegistry.matches()` then call the returned command's `run()` |

---

### Task 1: Canonical Provider Settings And Auth Resolver

**Files:**
- Modify: `packages/settings/src/index.ts`
- Modify: `packages/settings/src/sections.ts`
- Modify: `packages/settings/test/settings.test.ts`
- Modify: `packages/settings/test/sections.test.ts`
- Modify: `packages/credentials/src/index.ts`
- Modify: `packages/credentials/test/credentials.test.ts`

**Interfaces:**
- Produces: `SettingsProviderConfig.modelsURL?: string`
- Produces: `CredentialStore`
- Produces: `ProviderAuthRef`, `ResolvedProviderAuth`, `ProviderAuthResolver`
- Produces: `createProviderAuthResolver(store: CredentialStore): ProviderAuthResolver`
- Produces: deterministic legacy `tui.providers` -> canonical `llm.providers` read migration
- Consumed by: Task 2 provider-runtime and Task 6 final legacy-plane removal

- [ ] **Step 1: Write failing settings migration tests**

Add literal cases proving field and protocol mapping while preserving an explicit canonical value:

```ts
it("soft-migrates legacy TUI providers into canonical llm providers", () => {
  const out = normalizeSettings({
    llm: { providers: {}, defaultModel: { provider: "", model: "" } },
    tui: {
      providers: {
        version: 1,
        activeProviderId: "deepseek",
        providers: {
          deepseek: {
            id: "deepseek",
            name: "DeepSeek",
            baseUrl: "https://api.deepseek.com/v1/",
            protocol: "openai-compatible",
            apiKeyRef: "DEEPSEEK_API_KEY",
            modelsUrl: "https://api.deepseek.com/v1/models",
          },
        },
      },
    },
  })

  expect(out.llm.providers.deepseek).toEqual({
    displayName: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    protocol: "openai-completions",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    modelsURL: "https://api.deepseek.com/v1/models",
  })
  expect(out.llm.defaultModel).toEqual({ provider: "deepseek", model: "" })
})

it("canonical provider fields win over a legacy migration row", () => {
  const out = normalizeSettings({
    llm: {
      providers: { deepseek: { baseURL: "https://gateway.example", protocol: "openai-responses" } },
      defaultModel: { provider: "deepseek", model: "deepseek-chat" },
    },
    tui: {
      providers: {
        version: 1,
        activeProviderId: "deepseek",
        providers: { deepseek: { id: "deepseek", baseUrl: "https://legacy.example" } },
      },
    },
  })
  expect(out.llm.providers.deepseek.baseURL).toBe("https://gateway.example")
  expect(out.llm.defaultModel.model).toBe("deepseek-chat")
})
```

- [ ] **Step 2: Write failing section-schema tests for `modelsURL`**

```ts
it("mutates a provider modelsURL through the canonical llm section", async () => {
  const store = await loadedStore()
  const view = await mutateSection("llm", [{
    op: "set",
    path: ["providers", "custom", "modelsURL"],
    value: "https://models.example/v1/models",
  }], store)
  expect((view.user.providers as Record<string, unknown>).custom).toMatchObject({
    modelsURL: "https://models.example/v1/models",
  })
})
```

- [ ] **Step 3: Write failing credential auth-resolver tests**

```ts
it("resolves API-key refs without exposing values through describe", async () => {
  const store = createCredentialStore(join(dir, "credentials.json"))
  await store.set("DEEPSEEK_API_KEY", "secret-value")
  const auth = createProviderAuthResolver(store)

  await expect(auth.describe({ kind: "api-key-ref", ref: "DEEPSEEK_API_KEY" }))
    .resolves.toEqual({ configured: true, source: "file", writable: true })
  await expect(auth.resolve(
    { kind: "api-key-ref", ref: "DEEPSEEK_API_KEY" },
    { providerId: "deepseek", purpose: "inference" },
  )).resolves.toEqual({ kind: "api-key", value: "secret-value" })
})

it("represents ambient auth and leaves OAuth unimplemented", async () => {
  const auth = createProviderAuthResolver(createCredentialStore(join(dir, "credentials.json")))
  await expect(auth.resolve(
    { kind: "ambient" },
    { providerId: "bedrock", purpose: "inference" },
  )).resolves.toEqual({ kind: "ambient" })
  await expect(auth.describe({ kind: "oauth-account-ref", accountId: "future" }))
    .resolves.toEqual({ configured: false, source: "oauth", writable: false })
})
```

- [ ] **Step 4: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/settings test
pnpm --filter @i-harness/credentials test
```

Expected: failures for missing `modelsURL`, missing legacy mapping, and missing auth resolver exports.

- [ ] **Step 5: Implement the canonical migration and auth resolver**

```ts
function migrateLegacyProtocol(value: unknown): SettingsProviderProtocol | undefined {
  if (value === "openai-compatible") return "openai-completions"
  if (value === "anthropic") return "anthropic-messages"
  if (value === "openai-responses" || value === "gemini" || value === "bedrock") return value
  return undefined
}

function migrateLegacyTuiProviders(raw: unknown): {
  providers: Record<string, SettingsProviderConfig>
  activeProviderId: string
} {
  if (!isRecord(raw) || !isRecord(raw.providers)) return { providers: {}, activeProviderId: "" }
  const out: Record<string, SettingsProviderConfig> = {}
  for (const [id, value] of Object.entries(raw.providers)) {
    if (!isRecord(value) || typeof value.baseUrl !== "string" || value.baseUrl === "") continue
    const protocol = migrateLegacyProtocol(value.protocol)
    out[id] = {
      baseURL: stripBaseURLSuffix(value.baseUrl),
      ...(typeof value.name === "string" && value.name !== "" ? { displayName: value.name } : {}),
      ...(typeof value.apiKeyRef === "string" && value.apiKeyRef !== "" ? { apiKeyEnv: value.apiKeyRef } : {}),
      ...(typeof value.modelsUrl === "string" && value.modelsUrl !== "" ? { modelsURL: value.modelsUrl } : {}),
      ...(protocol !== undefined ? { protocol } : {}),
    }
  }
  return {
    providers: out,
    activeProviderId: typeof raw.activeProviderId === "string" ? raw.activeProviderId : "",
  }
}

export interface CredentialStore {
  describe(refs: string[]): Record<string, CredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  resolve(ref: string): string | undefined
}

export function createProviderAuthResolver(store: CredentialStore): ProviderAuthResolver {
  return {
    async describe(ref) {
      if (ref.kind === "ambient") return { configured: true, source: "ambient", writable: false }
      if (ref.kind === "oauth-account-ref") return { configured: false, source: "oauth", writable: false }
      return store.describe([ref.ref])[ref.ref]!
    },
    async resolve(ref) {
      if (ref.kind === "ambient") return { kind: "ambient" }
      if (ref.kind === "oauth-account-ref") return undefined
      const value = store.resolve(ref.ref)
      return value === undefined ? undefined : { kind: "api-key", value }
    },
  }
}
```

Keep the legacy TUI provider shape readable during this transition task so the branch still typechecks; Task 6 removes its writers and final public shape.

- [ ] **Step 6: Verify GREEN and typecheck**

```powershell
pnpm --filter @i-harness/settings test
pnpm --filter @i-harness/credentials test
pnpm --filter @i-harness/settings typecheck
pnpm --filter @i-harness/credentials typecheck
```

- [ ] **Step 7: Commit**

```powershell
git add packages/settings packages/credentials
git commit -m "feat(m49): canonicalize provider settings and auth refs"
```

---

### Task 2: Shared Provider Runtime Package

**Files:**
- Create: `packages/provider-runtime/package.json`
- Create: `packages/provider-runtime/tsconfig.json`
- Create: `packages/provider-runtime/src/index.ts`
- Create: `packages/provider-runtime/test/runtime.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `SettingsStoreSurface`, `CredentialStore`, `ProviderAuthResolver`, `ProviderRegistry`
- Produces: `ProviderRuntimeEntry`, `SessionModelBinding`, `ModelResolutionState`, `ProviderRuntime`
- Produces: `createProviderRuntime(options): ProviderRuntime`
- Does not depend on: `session-executor`, `tui`, `web-host`, or app packages

- [ ] **Step 1: Add package scaffolding and dependency declarations**

```json
{
  "name": "@i-harness/provider-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/credentials": "workspace:*",
    "@i-harness/llm-seam": "workspace:*",
    "@i-harness/provider": "workspace:*",
    "@i-harness/settings": "workspace:*"
  }
}
```

`tsconfig.json` extends `../../tsconfig.base.json` and includes `src/**/*.ts` plus `test/**/*.ts`.

Run `pnpm install` once after creating the manifest so the new workspace package receives dependency links and `pnpm-lock.yaml` gains its importer.

- [ ] **Step 2: Write failing directory and resolution tests**

```ts
it("merges provider templates with canonical user configuration", async () => {
  const runtime = createProviderRuntime(fixture({
    providers: {
      deepseek: {
        displayName: "Private DeepSeek",
        baseURL: "https://gateway.example",
        protocol: "openai-completions",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: [{ id: "deepseek-chat", contextWindow: 128000 }],
      },
    },
  }))
  await expect(runtime.directory()).resolves.toContainEqual(expect.objectContaining({
    id: "deepseek",
    displayName: "Private DeepSeek",
    configured: true,
    models: [expect.objectContaining({ id: "deepseek-chat" })],
  }))
})

it("uses override then session selection then default selection", async () => {
  const runtime = createProviderRuntime(readyFixture())
  await expect(runtime.resolveModel({ override: "deepseek:override-model" }))
    .resolves.toMatchObject({ status: "ready", binding: { modelId: "override-model" } })
  await expect(runtime.resolveModel({
    sessionSelection: { provider: "deepseek", model: "session-model", reasoningEffort: "high" },
  })).resolves.toMatchObject({
    status: "ready",
    binding: { modelId: "session-model", reasoningEffort: "high" },
  })
})
```

- [ ] **Step 3: Write failing auth/discovery/manual-catalog tests**

```ts
it("passes one resolved API key to discovery and inference", async () => {
  const calls: string[] = []
  const auth = fakeAuthResolver({
    onResolve: ({ purpose }) => { calls.push(purpose); return { kind: "api-key", value: "k" } },
  })
  const runtime = createProviderRuntime(fixture({ auth }))
  await runtime.discoverModels("deepseek", { force: true })
  const resolved = await runtime.resolveModel({})
  expect(resolved.status).toBe("ready")
  expect(calls).toEqual(["discovery", "inference"])
})

it("allows Bedrock ambient auth and reports manual-only discovery", async () => {
  const runtime = createProviderRuntime(bedrockFixture())
  const row = (await runtime.directory()).find((item) => item.id === "bedrock")!
  expect(row.auth).toMatchObject({ configured: true, source: "ambient" })
  expect(row.discovery).toBe("manual-only")
  await expect(runtime.resolveModel({})).resolves.toMatchObject({ status: "ready" })
})

it("keeps settings unchanged when discovery fails", async () => {
  const { runtime, settings } = failingProbeFixture()
  const before = structuredClone(settings.get().llm)
  await expect(runtime.discoverModels("custom", { force: true })).rejects.toThrow(/candidate/i)
  expect(settings.get().llm).toEqual(before)
})
```

- [ ] **Step 4: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/provider-runtime test
```

Expected: package compiles only after the new exports and runtime behavior exist.

- [ ] **Step 5: Implement `createProviderRuntime`**

```ts
export function createProviderRuntime(options: {
  settings: SettingsStoreSurface
  credentials: CredentialStore
  auth?: ProviderAuthResolver
  registry?: ProviderRegistry
  buildClient?: typeof buildModelClient
}): ProviderRuntime
```

- Use `defaultProviderRegistry()` for adapter templates unless a registry is injected.
- Merge template and user profile per field; user config wins.
- Derive `api-key-ref` from `apiKeyEnv`; Bedrock without one uses ambient; every other missing auth resolves `unconfigured`.
- Route discovery through `registry.probeModels()` with `modelsURL`/base URL and resolved auth, then merge by model id without deleting manual rows.
- `setApiKey()` derives `<NORMALIZED_ID>_API_KEY`, writes through credentials, then persists only the ref.
- `resolveModel()` returns a discriminated state and never imports or constructs `llm-mock`.

- [ ] **Step 6: Verify GREEN, typecheck, and dependency direction**

```powershell
pnpm --filter @i-harness/provider-runtime test
pnpm --filter @i-harness/provider-runtime typecheck
rg -n "session-executor|@i-harness/tui|web-host|apps/" packages/provider-runtime
```

Expected: tests pass and the final `rg` returns no dependency-direction hits.

- [ ] **Step 7: Commit**

```powershell
git add packages/provider-runtime pnpm-lock.yaml
git commit -m "feat(m49): add shared provider runtime"
```

---

### Task 3: Session Model Policy And Binding State

**Files:**
- Modify: `packages/session-executor/src/assembly.ts`
- Modify: `packages/session-executor/src/service.ts`
- Modify: `packages/session-executor/src/index.ts`
- Modify: `packages/session-executor/test/assembly.test.ts`
- Modify: `packages/session-executor/test/service.test.ts`
- Test: `packages/session-executor/test/assembly-import.test.ts`

**Interfaces:**
- Produces: `ModelUnavailableError`
- Produces: `ModelPolicy = "required" | "test-mock"`
- Produces: `SessionModelBindingResult`
- Produces: `SessionService.modelState(sessionId)`
- Produces: `SessionAssembly.modelLabel`
- Consumes structurally: Task 2 `ModelResolutionState` through app adapters, without importing `provider-runtime`

- [ ] **Step 1: Write failing assembly-policy tests**

```ts
it("required model policy refuses an assembly without a client", async () => {
  await expect(createSessionAssembly({
    workspace: dir,
    modelPolicy: "required",
  })).rejects.toThrow(ModelUnavailableError)
})

it("test-mock policy is an explicit test-only opt in", async () => {
  const assembly = await createSessionAssembly({
    workspace: dir,
    modelPolicy: "test-mock",
    mockCycles: true,
  })
  await expect(assembly.agent.run("hello")).resolves.toMatchObject({ finalText: "ok" })
  await assembly.dispose()
})
```

The production change caught by the first test is reintroducing implicit mock fallback under `required`.

- [ ] **Step 2: Write failing binding-state tests**

```ts
it("uses one ready binding for state and assembly construction", async () => {
  let calls = 0
  const model = scriptedModel("real")
  const service = createSessionService({
    workspace: dir,
    modelPolicy: "required",
    modelBindingFor: async () => {
      calls += 1
      return {
        status: "ready",
        binding: {
          model,
          providerId: "deepseek",
          modelId: "deepseek-chat",
          label: "deepseek:deepseek-chat",
          reasoningEffort: "high",
          contextWindow: 128000,
        },
      }
    },
  })

  await expect(service.modelState("s1")).resolves.toEqual({
    status: "ready",
    providerId: "deepseek",
    modelId: "deepseek-chat",
    label: "deepseek:deepseek-chat",
  })
  const assembly = await service.assemblyFor("s1")
  expect(assembly.model).toBe(model)
  expect(assembly.modelLabel).toBe("deepseek:deepseek-chat")
  expect(calls).toBe(1)
})

it("does not construct an assembly for an unconfigured binding", async () => {
  const service = createSessionService({
    workspace: dir,
    modelPolicy: "required",
    modelBindingFor: async () => ({ status: "unconfigured", reason: "No model configured" }),
  })
  await expect(service.modelState("s1")).resolves.toEqual({
    status: "unconfigured",
    reason: "No model configured",
  })
  await expect(service.assemblyFor("s1")).rejects.toThrow(/No model configured/)
  expect(service.hasAssembly("s1")).toBe(false)
})
```

- [ ] **Step 3: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/session-executor exec vitest run test/assembly.test.ts test/service.test.ts
```

Expected: missing policy, binding, state, and label APIs.

- [ ] **Step 4: Implement the core policy and binding cache**

```ts
export type SessionModelBindingResult =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | { status: "ready"; binding: {
      model: ModelClient
      providerId: string
      modelId: string
      label: string
      reasoningEffort?: ReasoningEffort
      contextWindow?: number
    } }
```

- `modelState()` and `getOrCreate()` share one pending binding promise per session.
- `closeSession()` clears binding state so an idle model change resolves again.
- A ready binding supplies `model`, `modelLabel`, `contextWindow`, and `reasoningEffort` atomically.
- An invalid/unconfigured binding throws `ModelUnavailableError` only when assembly construction is requested.
- During this transition task, callers that omit `modelPolicy` retain legacy test behavior; Task 4 flips the default to `required` after production call sites are wired.

- [ ] **Step 5: Verify GREEN and the lazy native import regression**

```powershell
pnpm --filter @i-harness/session-executor test
pnpm --filter @i-harness/session-executor typecheck
pnpm --filter @i-harness/session-executor exec vitest run test/assembly-import.test.ts --pool=threads --poolOptions.threads.singleThread=true
```

- [ ] **Step 6: Commit**

```powershell
git add packages/session-executor
git commit -m "feat(m49): add explicit session model binding"
```

---

### Task 4: Production Provider Composition And SDK Model Capabilities

**Files:**
- Create: `apps/cli/src/provider-runtime.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/run.ts`
- Modify: `apps/cli/src/web.ts`
- Modify: `apps/cli/test/cli.test.ts`
- Modify: `apps/cli/test/sdk-wire-v11.test.ts`
- Modify: `apps/tui/package.json`
- Modify: `apps/tui/src/index.ts`
- Modify: `apps/tui/test/tui-app.test.ts`
- Modify: `packages/sdk/src/protocol.ts`
- Modify: `packages/sdk/src/server.ts`
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/test/protocol.test.ts`
- Modify: `packages/sdk/test/server.test.ts`
- Modify: `packages/tui/src/contracts.ts`
- Modify: `packages/tui/src/backend/embedded.ts`
- Modify: `packages/tui/src/backend/remote.ts`
- Modify: `packages/tui/test/backend.test.ts`
- Modify: `packages/tui/test/remote-backend.test.ts`
- Create: `packages/session-persistence/src/fork.ts`
- Create: `packages/session-persistence/test/fork.test.ts`
- Modify: `packages/session-persistence/src/index.ts`
- Modify: `packages/web-host/src/host.ts`
- Modify: `packages/web-host/test/host-routes.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Tasks 1-3 auth/runtime/binding APIs
- Produces SDK capabilities: `session-create`, `session-fork`, `session-model`
- Produces methods: `session/create`, `session/fork`, `session/model/state`, `session/model/set`
- Produces serialized `SessionModelState` in `packages/sdk/src/protocol.ts`; TUI maps it to `BackendModelState`
- Produces TUI backend members: `createSession`, `forkSession`, `modelState`, `setSessionModel`
- Sets every production assembly/service to `modelPolicy: "required"`

- [ ] **Step 1: Write failing SDK protocol/client tests**

The SDK serializable type is:

```ts
export type SessionModelState =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | { status: "ready"; providerId: string; modelId: string; label: string }
```

```ts
it("advertises additive session create/fork/model capabilities", async () => {
  const info = await client.initialize()
  expect(info.capabilities["session-create"]).toEqual(["1"])
  expect(info.capabilities["session-fork"]).toEqual(["1"])
  expect(info.capabilities["session-model"]).toEqual(["1"])
})

it("round-trips model state and per-session selection", async () => {
  await expect(client.modelState("s1")).resolves.toEqual({
    status: "unconfigured",
    reason: "No model configured",
  })
  await client.setSessionModel("s1", {
    provider: "deepseek",
    model: "deepseek-chat",
    reasoningEffort: "high",
  })
  expect(seenSelection).toEqual({
    provider: "deepseek",
    model: "deepseek-chat",
    reasoningEffort: "high",
  })
})
```

- [ ] **Step 2: Write failing production-composition tests**

```ts
it("headless production refuses to run without a configured model", async () => {
  const result = await runHeadless("hello", { workspace: dir, modelPolicy: "required" })
  expect(result.exitCode).toBe(1)
  expect(result.error).toContain("No model configured")
})

it("the SDK command resolves its model from canonical settings", async () => {
  await seedCanonicalProvider(dir, {
    provider: "fixture",
    model: "fixture-model",
    apiKey: "fixture-key",
  })
  const client = spawnSdkFor(dir)
  await expect(client.modelState("s1")).resolves.toMatchObject({
    status: "ready",
    label: "fixture:fixture-model",
  })
})
```

Use an injected provider registry/model client in tests; no external network.

- [ ] **Step 3: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/sdk test
pnpm --filter @i-harness/tui exec vitest run test/backend.test.ts test/remote-backend.test.ts
pnpm --filter @i-harness/cli exec vitest run test/cli.test.ts test/sdk-wire-v11.test.ts
pnpm --filter @i-harness/tui-app test
```

- [ ] **Step 4: Implement shared app composition**

`apps/cli/src/provider-runtime.ts` owns only filesystem path/store assembly:

```ts
export async function loadProviderRuntime(options?: {
  settingsPath?: string
  credentialsPath?: string
  registry?: ProviderRegistry
}): Promise<{ settings: SettingsStore; credentials: CredentialStore; runtime: ProviderRuntime }>
```

- `run`, `web`, `sdk`, and `acp` resolve real clients through this runtime when no explicit client was supplied.
- `apps/tui` creates the same runtime from the same settings/credentials paths.
- Flip `createSessionAssembly`'s omitted `modelPolicy` default to `required`.
- Unit/PTY test factories explicitly pass `modelPolicy: "test-mock"` or a fake model.
- Remove production `mockCycles: true`, `forceMock`, and `mock-model` labels.

- [ ] **Step 5: Implement additive SDK methods**

Server option surfaces:

```ts
createSession?: () => Promise<{ sessionId: string }>
forkSession?: (sessionId: string) => Promise<{ sessionId: string }>
modelState?: (sessionId: string) => Promise<SessionModelState>
setSessionModel?: (sessionId: string, selection: SessionModelSelection) => Promise<void>
```

- `session/model/set` validates non-empty provider/model, updates `SessionMeta.modelSelection`, rejects busy/queued sessions, calls `closeSession()`, then returns the fresh serialized state.
- Extract the existing web-host completed-turn-prefix fork algorithm to `session-persistence/src/fork.ts`; web-host, SDK, and embedded TUI all call that one function.
- Unknown sessions use the existing not-found convention; unsupported seams return method/capability unavailable, never an empty success.
- Keep protocolVersion 2; capabilities are additive rows, matching the v1/v1.1 precedent.

- [ ] **Step 6: Wire embedded and remote TUI backends**

- Embedded calls coordinator/service/provider runtime directly.
- Remote checks advertised capability before issuing each new method.
- `modelState()` serializes no client/key, only status/reason/provider/model/label.
- `createSession` and `forkSession` return the authoritative id, then `open()` it through the existing atomic switch path.

- [ ] **Step 7: Verify GREEN and mock removal**

```powershell
pnpm --filter @i-harness/sdk test
pnpm --filter @i-harness/sdk typecheck
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui-app test
pnpm --filter @i-harness/cli test
rg -n "falling back to the mock|mock-model|mockCycles: true|forceMock" apps packages/tui packages/session-executor -g '*.ts'
```

Expected: tests pass; remaining mock hits are test-only or explicit `test-mock` branches.

- [ ] **Step 8: Commit**

```powershell
git add apps/cli apps/tui packages/sdk packages/tui packages/session-executor packages/session-persistence packages/web-host pnpm-lock.yaml
git commit -m "feat(m49): require real models in production hosts"
```

---

### Task 5: Welcome Startup And Model Gate

**Files:**
- Modify: `packages/tui/src/app/loop.ts`
- Modify: `packages/tui/src/app/present.ts`
- Modify: `packages/tui/src/contracts.ts`
- Modify: `packages/tui/src/views/agent.ts`
- Modify: `packages/tui/src/views/welcome.ts`
- Modify: `packages/tui/src/views/session-picker.ts`
- Modify: `packages/tui/test/welcome.test.ts`
- Modify: `packages/tui/test/present.test.ts`
- Modify: `packages/tui/test/backend.test.ts`
- Modify: `apps/tui/src/index.ts`
- Modify: `apps/tui/test/tui-app.test.ts`
- Create: `packages/tui/test/harness/host-024.ts`
- Create: `packages/tui/test/harness/case-024.yaml`
- Create: `packages/tui/test/harness/case-024.test.ts`

**Interfaces:**
- Consumes: Task 4 backend model/create/session capabilities
- Produces: `ActiveView = welcome | agent | dashboard`
- Produces: disabled prompt state with Settings action
- Produces: authoritative startup `backend.open()` and session-list flow

- [ ] **Step 1: Write failing state and render tests**

```ts
it("starts on Welcome and disables prompt when no model is configured", async () => {
  const app = new TuiApp(testOptions({
    modelState: { status: "unconfigured", reason: "No model configured" },
  }))
  await app.frame()
  expect(app.state.view).toEqual({ kind: "welcome" })
  expect(screenText()).toContain("No model configured")
  expect(screenText()).toContain("Settings > Models & Providers")
})

it("Enter on a disabled Welcome prompt opens Settings without submitting", async () => {
  const backend = fakeBackend({ modelState: { status: "unconfigured", reason: "No model configured" } })
  const app = new TuiApp(testOptions({ backend }))
  await app.handle(key("enter"))
  expect(app.state.overlay?.kind).toBe("settings")
  expect(backend.submissions).toEqual([])
})
```

- [ ] **Step 2: Write failing startup integration tests**

```ts
it("opens an explicit resume session before starting the app", async () => {
  const backend = recordingBackend({ modelState: readyState() })
  await runTuiForTest({ resume: "s1", backend })
  expect(backend.calls.slice(0, 2)).toEqual(["modelState", "open:s1"])
})

it("preserves --prompt on Welcome when model resolution is invalid", async () => {
  const app = await createExecutableApp({
    prompt: "keep me",
    modelState: { status: "invalid", reason: "Missing credential" },
  })
  expect(app.state.prompt.text).toBe("keep me")
  expect(app.backend.submissions).toHaveLength(0)
})
```

- [ ] **Step 3: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/tui exec vitest run test/welcome.test.ts test/present.test.ts test/backend.test.ts
pnpm --filter @i-harness/tui-app test
```

- [ ] **Step 4: Implement the startup state machine**

- Default view is Welcome unless `--resume`/`--attach` successfully opens a session.
- Welcome actions are `New session`, `Resume session`, `Settings`, and `Quit`; no login/account rows.
- Resolve model state before submit, not before rendering the Welcome shell.
- A ready Welcome prompt creates a session if needed, opens it, then submits.
- An invalid/unconfigured prompt remains editable but disabled for submission; Enter opens Models & Providers.
- Pass `providerRuntime` and `listSessions` regardless of whether raw input attachment succeeded.

- [ ] **Step 5: Implement the visual contract**

- Preserve max width 120 and wide threshold 90.
- Render startup/model error above the hero, provider/model status below the prompt, and keep the next content row visible in 24-row terminals.
- Fullscreen Agent layout follows status -> panes -> scrollback -> overlays -> turn -> prompt -> shortcuts.
- Narrow screens drop shortcut/detail rows before reducing scrollback below five rows.

- [ ] **Step 6: Add PTY case 024 RED then GREEN**

Case 024 sequence:

```yaml
- await-marker: { name: scene-ready }
- wait-screen: { rows: ["No model configured", "Settings > Models & Providers"] }
- write-pty: { data: "hello\r" }
- wait-screen: { rows: ["Models & Providers"] }
- request-marker: { name: request-exit }
- await-marker: { name: teardown-wrote }
- wait-exit: { code: 0 }
```

Assertions: no submission marker, `tool/result`, or assistant response; Welcome dimensions at 80x24 and 120x32; UTF-8 glyphs intact; zero-byte idle after each settled frame. Task 6 upgrades case-021 to the canonical provider runtime and ends that provider/settings flow with a real test-model submission.

- [ ] **Step 7: Verify GREEN**

```powershell
pnpm --filter @i-harness/tui exec vitest run test/welcome.test.ts test/present.test.ts test/backend.test.ts test/harness/case-024.test.ts
pnpm --filter @i-harness/tui-app test
pnpm --filter @i-harness/tui typecheck
pnpm --filter @i-harness/tui-app typecheck
```

- [ ] **Step 8: Commit**

```powershell
git add apps/tui packages/tui
git commit -m "feat(m49): add model-gated Welcome startup"
```

---

### Task 6: Typed Settings And Models/Providers Flow

**Files:**
- Create: `packages/tui/src/settings/registry.ts`
- Create: `packages/tui/src/settings/controller.ts`
- Create: `packages/tui/test/settings-registry.test.ts`
- Create: `packages/tui/src/app/provider-controller.ts`
- Modify: `packages/tui/src/views/settings.ts`
- Modify: `packages/tui/src/views/provider.ts`
- Modify: `packages/tui/src/views/model-picker.ts`
- Modify: `packages/tui/src/app/loop.ts`
- Modify: `packages/tui/src/app/slash/impl/g1.ts`
- Modify: `packages/tui/test/settings-modal.test.ts`
- Modify: `packages/tui/test/provider-view.test.ts`
- Modify: `packages/tui/test/provider-store.test.ts`
- Modify: `packages/tui/test/model-picker.test.ts`
- Modify: `packages/tui/test/model-factory.test.ts`
- Modify: `packages/tui/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/tui/test/harness/host-021.ts`
- Modify: `packages/tui/test/harness/case-021.yaml`
- Modify: `packages/tui/test/harness/case-021.test.ts`
- Modify: `packages/settings/src/index.ts`
- Modify: `packages/settings/test/settings.test.ts`
- Delete: `packages/tui/src/app/provider-store.ts`
- Delete: `packages/tui/src/app/model-factory.ts`

**Interfaces:**
- Consumes: `ProviderRuntime` and backend `setSessionModel`
- Produces: `SettingsCategory`, `SettingDefinition`, `SettingsController`
- Produces: `ProviderController` as the UI-only adapter over `ProviderRuntime`
- Finalizes: `SettingsTui` contains only `prefs`; legacy provider writers/types are removed

- [ ] **Step 1: Write failing registry visibility and rollback tests**

```ts
it("omits empty categories and unavailable-only rows", () => {
  const registry = createSettingsRegistry([
    def({ key: "theme", category: "Appearance", visible: () => true }),
    def({ key: "oauth", category: "Models & Providers", visible: () => false }),
  ])
  expect(registry.categories(ctx())).toEqual(["Appearance"])
})

it("rolls a live preview back when persistence fails", async () => {
  const live: string[] = []
  const row = def({
    key: "theme",
    preview: (_ctx, value) => live.push(String(value)),
    rollback: (_ctx, value) => live.push(`rollback:${String(value)}`),
    commit: async () => { throw new Error("disk full") },
  })
  const controller = createSettingsController([row], ctx({ theme: "grok-night" }))
  await expect(controller.commit("theme", "grok-day")).rejects.toThrow("disk full")
  expect(live).toEqual(["grok-day", "rollback:grok-night"])
})
```

- [ ] **Step 2: Write failing provider-flow tests**

```ts
it("adds a provider without storing the raw key in settings", async () => {
  const { controller, runtime, settings, credentials } = providerFixture()
  await controller.saveProvider({
    id: "custom",
    displayName: "Custom",
    protocol: "openai-completions",
    baseURL: "https://api.example",
    modelsURL: "https://api.example/v1/models",
    apiKey: "secret",
  })
  expect(settings.get().llm.providers.custom).toMatchObject({
    apiKeyEnv: "CUSTOM_API_KEY",
    baseURL: "https://api.example",
  })
  expect(JSON.stringify(settings.get())).not.toContain("secret")
  expect(credentials.resolve("CUSTOM_API_KEY")).toBe("secret")
  expect(runtime.directory()).resolves.toContainEqual(expect.objectContaining({ id: "custom" }))
})

it("shows manual model entry when discovery is unavailable", async () => {
  const controller = providerController(manualOnlyRuntime())
  await controller.selectProvider("bedrock")
  expect(controller.state.discovery).toEqual({
    status: "manual-only",
    message: "Discovery is not available for this provider; add a model ID manually.",
  })
})

it("sets the current session model only through the backend capability", async () => {
  const backend = recordingBackend({ setSessionModel: true })
  const controller = providerController(readyRuntime(), { backend, sessionId: "s1" })
  await controller.selectModel("deepseek-chat", "high")
  expect(backend.modelSelections).toEqual([{
    provider: "deepseek",
    model: "deepseek-chat",
    reasoningEffort: "high",
  }])
})
```

- [ ] **Step 3: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/tui exec vitest run test/settings-registry.test.ts test/settings-modal.test.ts test/provider-view.test.ts test/provider-store.test.ts test/model-picker.test.ts test/model-factory.test.ts
pnpm --filter @i-harness/settings test
```

- [ ] **Step 4: Implement the settings registry/controller**

- Define the eight categories from the spec; filter categories with zero visible definitions.
- Support boolean, enum, integer, string, action, and dynamic-list rows.
- Preview immediately; commit through settings/provider/backend; rollback on failure.
- Label non-live values exactly `Applies to new sessions`.
- Remove the current `SETTINGS_NOT_AVAILABLE` and placeholder rows.

- [ ] **Step 5: Implement Models & Providers master/detail**

Provider states:

```ts
type ProviderEditorState =
  | { mode: "list"; cursor: number }
  | { mode: "edit"; draft: ProviderDraft; field: ProviderField }
  | { mode: "models"; providerId: string; cursor: number }
  | { mode: "discovering"; providerId: string }
  | { mode: "confirm-delete"; providerId: string }
```

- List configured entries plus real adapter templates.
- Secret input never re-renders the value; empty keeps the current key.
- Discovery success merges model ids; failure preserves stored models and displays attempts.
- Manual add validates non-empty id and positive optional capacities.
- Default selection persists to `llm.defaultModel`; active-session selection uses backend and idle rebind semantics.
- No OAuth row/action appears because no OAuth capability exists.
- Update PTY case-021 to write only `llm.providers`/credentials, select the discovered model, close Settings, submit `hello`, and wait for the injected client's literal `fixture response`.

- [ ] **Step 6: Remove the legacy TUI provider plane**

- Migrate all callers/tests from `ProviderStore` and `createTuiModelBuilder` to `ProviderController`/`ProviderRuntime`.
- Remove `SettingsTuiProvider*` public types and `tui.providers` defaults/normalization after the canonical migration tests prove old files still load into `llm.providers`.
- Search for writes:

```powershell
rg -n "tui\.providers|SettingsTuiProvider|ProviderStore|createTuiModelBuilder" apps packages -g '*.ts'
```

Expected after cleanup: only migration fixture/comment references remain.

- [ ] **Step 7: Verify GREEN**

```powershell
pnpm --filter @i-harness/settings test
pnpm --filter @i-harness/settings typecheck
pnpm --filter @i-harness/provider-runtime test
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui typecheck
```

- [ ] **Step 8: Commit**

```powershell
git add packages/settings packages/tui pnpm-lock.yaml
git commit -m "feat(m49): add typed provider and settings flows"
```

---

### Task 7: Grapheme-Safe Prompt Editor And Visible Cursor

**Files:**
- Create: `packages/tui/src/editor/graphemes.ts`
- Create: `packages/tui/src/editor/history.ts`
- Create: `packages/tui/src/editor/index.ts`
- Create: `packages/tui/test/editor.test.ts`
- Create: `packages/tui-core/src/cursor/index.ts`
- Create: `packages/tui-core/test/cursor.test.ts`
- Modify: `packages/tui-core/src/index.ts`
- Modify: `packages/tui-core/src/renderer.ts`
- Modify: `packages/tui/src/views/prompt.ts`
- Modify: `packages/tui/src/views/text-input.ts`
- Modify: `packages/tui/src/app/keys.ts`
- Modify: `packages/tui/src/app/loop.ts`
- Modify: `packages/tui/src/app/present.ts`
- Modify: `packages/tui/test/keys.test.ts`
- Modify: `packages/tui/test/paste-stash.test.ts`
- Create: `packages/tui/test/harness/host-025.ts`
- Create: `packages/tui/test/harness/case-025.yaml`
- Create: `packages/tui/test/harness/case-025.test.ts`

**Interfaces:**
- Produces: `PromptEditor`
- Produces: atomic `PromptPaste { display: string; source: string }`
- Produces: `CursorTarget { x: number; y: number; visible: boolean }`
- Produces: renderer `setCursor(target)` / flush transition behavior
- Replaces: direct UTF-16 mutation in `loop.ts`

- [ ] **Step 1: Write failing editor behavior tests**

```ts
it.each([
  ["A🙂B", 3, "AB"],
  ["Ae\u0301B", 3, "AB"],
  ["A👨‍👩‍👧‍👦B", 12, "AB"],
])("backspace removes one grapheme from %s", (text, cursor, expected) => {
  const editor = createPromptEditor(text, cursor)
  editor.backspace()
  expect(editor.value()).toBe(expected)
})

it("inserts a newline at the cursor and supports undo/redo", () => {
  const editor = createPromptEditor("abcd", 2)
  editor.newline()
  expect(editor.value()).toBe("ab\ncd")
  expect(editor.undo()).toBe(true)
  expect(editor.value()).toBe("abcd")
  expect(editor.redo()).toBe(true)
  expect(editor.value()).toBe("ab\ncd")
})

it("treats a paste chip as one atomic cursor element", () => {
  const editor = createPromptEditor()
  editor.insertPaste({ display: "[Pasted: 20 lines]", source: "a\n".repeat(20) })
  editor.move("left")
  expect(editor.cursor()).toBe(0)
  editor.expandPasteAtCursor()
  expect(editor.value()).toBe("a\n".repeat(20))
})
```

- [ ] **Step 2: Write failing cursor-state tests**

```ts
it("writes Show/MoveTo once and emits nothing on an idle frame", () => {
  const cursor = createCursorState()
  expect(cursor.transition({ x: 4, y: 8, visible: true })).toBe("\x1b[?25h\x1b[9;5H")
  expect(cursor.transition({ x: 4, y: 8, visible: true })).toBe("")
  expect(cursor.transition({ x: 6, y: 8, visible: true })).toBe("\x1b[9;7H")
  expect(cursor.transition({ x: 6, y: 8, visible: false })).toBe("\x1b[?25l")
})
```

- [ ] **Step 3: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/tui exec vitest run test/editor.test.ts test/keys.test.ts test/paste-stash.test.ts
pnpm --filter @i-harness/tui-core exec vitest run test/cursor.test.ts
```

- [ ] **Step 4: Implement editor transactions and action routing**

- Use `Intl.Segmenter(undefined, { granularity: "grapheme" })`; fallback iterates Unicode code points.
- Coalesce adjacent printable inserts into one undo record until a movement, paste, newline, delete, submit, or 500ms gap.
- Route insert/delete/newline/history/stash/mouse/external-editor replacement through `PromptEditor` only.
- Add left/right, word-left/right, home/end, select-all, undo, and redo actions to `keys.ts`.
- Implement multiline Enter/Shift+Enter and busy Enter from the persisted setting.

- [ ] **Step 5: Implement prompt cursor geometry**

`renderPrompt()` returns the cursor cell after wrapping and inline-element layout:

```ts
export interface PromptRenderResult {
  cursor: CursorTarget
  rows: number
}
```

Hide it for disabled prompt, active modal/viewer, selection drag, unfocused app, and shutdown. After a cell flush that touches the cursor row, append the minimal cursor transition.

- [ ] **Step 6: Add PTY case 025**

Case actions: type ASCII/CJK/emoji/combining text; move left/right and word-wise; insert in the middle; undo/redo; resize from 100x30 to 60x20; open/close a modal. Assert cursor position bytes and visible screen text without requiring a fixed blink phase.

- [ ] **Step 7: Verify GREEN and zero-byte idle**

```powershell
pnpm --filter @i-harness/tui-core test
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui exec vitest run test/harness/case-025.test.ts
pnpm --filter @i-harness/tui-core typecheck
pnpm --filter @i-harness/tui typecheck
```

- [ ] **Step 8: Commit**

```powershell
git add packages/tui-core packages/tui
git commit -m "feat(m49): add full prompt editing and visible cursor"
```

---

### Task 8: Production Minimal Mode And Five-Theme Persistence

**Files:**
- Create: `packages/tui-core/src/theme/tokyonight.ts`
- Create: `packages/tui-core/src/theme/rose-pine-moon.ts`
- Create: `packages/tui-core/src/theme/oscura-midnight.ts`
- Modify: `packages/tui-core/src/theme/index.ts`
- Modify: `packages/tui-core/test/theme.test.ts`
- Modify: `packages/settings/src/index.ts`
- Modify: `packages/settings/test/settings.test.ts`
- Modify: `packages/tui/src/minimal/inline.ts`
- Modify: `packages/tui/src/minimal/mode.ts`
- Modify: `packages/tui/src/app/loop.ts`
- Modify: `packages/tui/src/app/slash/impl/visual.ts`
- Modify: `packages/tui/src/views/settings.ts`
- Modify: `packages/tui/test/minimal-mode.test.ts`
- Modify: `packages/tui/test/slash-app.test.ts`
- Modify: `apps/tui/src/index.ts`
- Modify: `apps/tui/test/tui-app.test.ts`

**Interfaces:**
- Produces: `SettingsTheme = system | grok-night | grok-day | tokyo-night | rose-pine-moon | oscura-midnight`
- Produces: persisted `tui.prefs.screenMode`
- Produces: production terminal initialization split for fullscreen/minimal

- [ ] **Step 1: Write failing theme migration and palette tests**

```ts
it("normalizes legacy light/dark theme values", () => {
  expect(normalizeSettings({ theme: "light" }).theme).toBe("grok-day")
  expect(normalizeSettings({ theme: "dark" }).theme).toBe("grok-night")
})

it.each(["tokyo-night", "rose-pine-moon", "oscura-midnight"] as const)(
  "resolves and quantizes %s",
  (theme) => {
    const palette = resolvePalette(cap256(), theme)
    expect(palette.name).toBe(theme)
    expect(palette.text).not.toEqual(palette.bg_base)
    expect(palette.diff_add_bg).not.toEqual(palette.diff_del_bg)
  },
)
```

- [ ] **Step 2: Write failing production minimal tests**

```ts
it("does not initialize the alternate screen in minimal mode", async () => {
  const terminal = recordingTerminal()
  await createExecutableTui({ mode: "minimal", terminal })
  expect(terminal.bytes).not.toContain("\x1b[?1049h")
  expect(terminal.bytes).not.toMatch(/\x1b\[\?100[0-6]h/)
})

it("uses explicit flag then persisted screen mode", () => {
  expect(resolveExecutableScreenMode({ flag: "fullscreen", persisted: "minimal" })).toBe("fullscreen")
  expect(resolveExecutableScreenMode({ persisted: "minimal" })).toBe("minimal")
})
```

- [ ] **Step 3: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/settings test
pnpm --filter @i-harness/tui-core exec vitest run test/theme.test.ts
pnpm --filter @i-harness/tui exec vitest run test/minimal-mode.test.ts test/slash-app.test.ts
pnpm --filter @i-harness/tui-app test
```

- [ ] **Step 4: Add the three palettes and unified resolver**

- Port semantic color values from the Grok source inventory, not screenshots.
- Keep palette fields identical to GrokNight/GrokDay and run through existing 256/16/mono quantizers.
- Low-color terminals expose only `system`, `grok-night`, and `grok-day` in pickers.
- `/theme` and Settings call the same preview/commit/rollback path; startup honors persisted theme.

- [ ] **Step 5: Split executable terminal startup by mode**

```ts
if (screenMode === "fullscreen") {
  terminal = createTerminal(...)
  terminal.init()
} else {
  inline = await loadInlineHost(cols, rows)
  // No alternate screen and no mouse capture.
}
```

- Minimal uses active semantic palette for ANSI output.
- Modal/viewer chrome becomes embedded and borderless.
- Inline-engine failure writes one warning and starts fullscreen without rewriting the persisted choice.

- [ ] **Step 6: Verify GREEN**

```powershell
pnpm --filter @i-harness/settings test
pnpm --filter @i-harness/tui-core test
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui-app test
pnpm --filter @i-harness/tui exec vitest run test/harness/case-015.test.ts
```

- [ ] **Step 7: Commit**

```powershell
git add apps/tui packages/settings packages/tui-core packages/tui
git commit -m "feat(m49): align themes and production minimal mode"
```

---

### Task 9: Structured Text Diff And Fs Change Results

**Files:**
- Create: `packages/text-diff/package.json`
- Create: `packages/text-diff/tsconfig.json`
- Create: `packages/text-diff/src/index.ts`
- Create: `packages/text-diff/test/diff.test.ts`
- Modify: `packages/fs/package.json`
- Modify: `packages/fs/src/index.ts`
- Modify: `packages/fs/test/fs.test.ts`
- Modify: `packages/tui/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `DiffLine`, `DiffHunk`, `TextDiff`
- Produces: `createTextDiff(path, before, after, options): TextDiff`
- Produces: `renderUnifiedDiff(diff): string`
- Extends fs write/edit/apply-patch results with optional `change: TextDiff`
- Consumed by: Task 10 tool presentation/viewer

- [ ] **Step 1: Add package scaffolding and the proven diff dependency**

Create the normal workspace manifest with `diff` as its only runtime dependency, then run:

```powershell
pnpm --filter @i-harness/text-diff add diff
```

The lockfile is the version pin. Do not implement a custom LCS/Myers engine.

- [ ] **Step 2: Write failing diff-contract tests**

```ts
it("builds context-limited hunks with literal line numbers", () => {
  const before = ["a", "b", "c", "d", "e", "f"].join("\n")
  const after = ["a", "b", "C", "d", "e", "F"].join("\n")
  expect(createTextDiff("src/a.ts", before, after, { context: 1 })).toEqual({
    path: "src/a.ts",
    added: 2,
    deleted: 2,
    truncated: false,
    hunks: [
      expect.objectContaining({ oldStart: 2, newStart: 2 }),
      expect.objectContaining({ oldStart: 5, newStart: 5 }),
    ],
  })
})

it("marks large inputs truncated without throwing", () => {
  const huge = "x\n".repeat(50_001)
  const diff = createTextDiff("large.txt", huge, `${huge}tail\n`)
  expect(diff.truncated).toBe(true)
  expect(diff.hunks.length).toBeGreaterThan(0)
})

it("renders one unified patch from the structured result", () => {
  const diff = createTextDiff("a.txt", "old\n", "new\n")
  expect(renderUnifiedDiff(diff)).toContain("@@ -1,1 +1,1 @@")
  expect(renderUnifiedDiff(diff)).toContain("-old")
  expect(renderUnifiedDiff(diff)).toContain("+new")
})
```

- [ ] **Step 3: Write failing real fs-tool tests**

```ts
it("edit returns a structured change generated from actual before/after text", async () => {
  await writeFile(join(dir, "a.txt"), "one\ntwo\n", "utf8")
  const edit = createFsTools({ workspace: dir }).find((tool) => tool.name === "edit")!
  const out = await edit.execute({ path: "a.txt", old_string: "two", new_string: "TWO" }, {})
  expect(out.change).toMatchObject({
    path: "a.txt",
    added: 1,
    deleted: 1,
    hunks: [expect.objectContaining({ oldStart: 1, newStart: 1 })],
  })
})

it("apply_patch preserves a raw patch fallback when a structured change cannot be built", async () => {
  const out = await runApplyPatchFixture()
  expect(out).toMatchObject({ changed: expect.any(Array) })
  expect(out.rawPatch ?? out.change).toBeDefined()
})
```

- [ ] **Step 4: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/text-diff test
pnpm --filter @i-harness/fs test
```

- [ ] **Step 5: Implement the structured adapter**

- Use `structuredPatch()` from `diff` with context default 3.
- Convert library rows into literal `DiffLine` entries and compute added/deleted counts independently.
- Cap full processing at 2 MiB per side or 50,000 lines; for oversized input, diff bounded head/tail windows and set `truncated: true`.
- Preserve line endings as logical text lines; unified rendering always uses `\n`.
- Empty/no-op edits return `hunks: []`, added/deleted 0, truncated false.

- [ ] **Step 6: Attach changes to fs results**

- Read the pre-image already used by write/edit/rewind; do not add a second unbounded file read.
- Return `change` only when before/after are known.
- `apply_patch` aggregates per-file changes when its parser exposes pre/post images; otherwise return its original patch text as `rawPatch`.
- Keep all existing result fields for compatibility.

- [ ] **Step 7: Verify GREEN**

```powershell
pnpm --filter @i-harness/text-diff test
pnpm --filter @i-harness/text-diff typecheck
pnpm --filter @i-harness/fs test
pnpm --filter @i-harness/fs typecheck
```

- [ ] **Step 8: Commit**

```powershell
git add packages/text-diff packages/fs packages/tui/package.json pnpm-lock.yaml
git commit -m "feat(m49): add structured file diffs"
```

---

### Task 10: Typed Tool Blocks, Viewer, Clipboard, And Interaction Bridges

**Files:**
- Create: `packages/tui/src/tool-presentation/redact.ts`
- Create: `packages/tui/src/tool-presentation/format.ts`
- Create: `packages/tui/src/tool-presentation/index.ts`
- Create: `packages/tui/src/views/block-viewer.ts`
- Create: `packages/tui/src/views/modal.ts`
- Create: `packages/tui/test/tool-presentation.test.ts`
- Create: `packages/tui/test/block-viewer.test.ts`
- Modify: `packages/tui/src/contracts.ts`
- Modify: `packages/tui/src/backend/embedded.ts`
- Modify: `packages/tui/src/backend/remote.ts`
- Modify: `packages/tui/src/scrollback/entries.ts`
- Modify: `packages/tui/src/scrollback/engine.ts`
- Modify: `packages/tui/src/scrollback/folding.ts`
- Modify: `packages/tui/src/app/clipboard.ts`
- Modify: `packages/tui/src/app/overlay-seam.ts`
- Modify: `packages/tui/src/app/loop.ts`
- Modify: `packages/tui/src/app/present.ts`
- Modify: `packages/tui/test/backend.test.ts`
- Modify: `packages/tui/test/remote-backend.test.ts`
- Modify: `packages/tui/test/scrollback.test.ts`
- Modify: `packages/tui/test/line-viewer.test.ts`
- Modify: `packages/tui/test/approval.test.ts`
- Modify: `apps/tui/src/index.ts`
- Modify: `apps/tui/test/tui-app.test.ts`
- Create: `packages/tui/test/harness/host-026.ts`
- Create: `packages/tui/test/harness/case-026.yaml`
- Create: `packages/tui/test/harness/case-026.test.ts`

**Interfaces:**
- Consumes: Task 9 `TextDiff`
- Produces: typed `TuiToolEvent` with `args/result/progress`
- Produces: `ToolPresentation` and secret redaction
- Produces: single modal/viewer input owner
- Wires: real clipboard plus production approval/question bridges

- [ ] **Step 1: Write failing mapper/redaction tests**

```ts
it("preserves tool args and structured results", () => {
  const call = mapSessionEvent({
    type: "tool/call",
    callId: "c1",
    name: "edit",
    args: { path: "a.ts", old_string: "x", new_string: "y" },
    seq: 1,
  })
  expect(call).toMatchObject({
    type: "tool",
    callId: "c1",
    args: { path: "a.ts", old_string: "x", new_string: "y" },
  })
})

it("redacts known secret keys recursively", () => {
  expect(redactToolPayload({
    headers: { authorization: "Bearer secret" },
    apiKey: "secret",
    nested: { password: "secret", keep: "ok" },
  })).toEqual({
    headers: { authorization: "***" },
    apiKey: "***",
    nested: { password: "***", keep: "ok" },
  })
})
```

- [ ] **Step 2: Write failing presentation and real-fs integration tests**

```ts
it("formats a real edit result as an expandable diff block", async () => {
  const events = await runRealEditTurn(fixtureWorkspace())
  const engine = createScrollbackEngine({ width: 100 })
  events.forEach((event) => engine.append(event))
  expect(renderLines(engine)).toContain("a.ts (+1/-1)")
  expect(renderLines(engine)).toContain("-old")
  expect(renderLines(engine)).toContain("+new")
})

it("keeps an update that arrives before its base tool call", () => {
  const engine = createScrollbackEngine({ width: 80 })
  engine.append(toolDone("c1", { stdout: "done" }))
  engine.append(toolStart("c1", "bash", { command: "echo hi" }))
  expect(engine.lineBlock(0)?.title).toContain("echo hi")
  expect(renderLines(engine)).toContain("done")
})
```

- [ ] **Step 3: Write failing viewer/clipboard/bridge tests**

```ts
it("opens raw diff view, searches, and copies through the host adapter", async () => {
  const copied: string[] = []
  const viewer = createBlockViewer(diffPresentation(), { copy: async (text) => { copied.push(text) } })
  viewer.setRaw(true)
  viewer.search("new line")
  await viewer.copy()
  expect(copied[0]).toContain("+new line")
})

it("attaches approval and question bridges to every production assembly", async () => {
  const host = await createExecutableHost({ approveAll: false })
  const assembly = await host.service.assemblyFor("s1")
  expect(host.approvals.isAttached(assembly.ctx)).toBe(true)
  expect(host.questions.isAttached(assembly.ctx)).toBe(true)
})
```

- [ ] **Step 4: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/tui exec vitest run test/tool-presentation.test.ts test/block-viewer.test.ts test/backend.test.ts test/scrollback.test.ts test/line-viewer.test.ts test/approval.test.ts
pnpm --filter @i-harness/tui-app test
```

- [ ] **Step 5: Implement typed presentation**

`ToolPresentation` shape:

```ts
export interface ToolPresentation {
  title: string
  summary?: string
  body: Array<{ kind: "text" | "diff" | "json"; value: string | TextDiff }>
  raw: unknown
  groupKey?: string
}
```

Dedicated formatters: execute, read, edit/write/apply_patch, list, search, web fetch/search, MCP, skill, subagent/task/job, todo, generic. Never use regex tool-name classification to extract a field that the structured payload already supplies.

- [ ] **Step 6: Implement modal/viewer ownership and real actions**

- One active modal/viewer union owns input before panes/prompt/scrollback.
- Viewer supports rendered/raw, search next/prev, scrolling, text selection, and copy.
- Line viewer reads the real file and positions exact line numbers.
- Clipboard uses existing platform commands; failures render the error and do not say `Copied!`.
- Hit areas exist only when the corresponding callback is present.
- Pump approval/question requests in `apps/tui`; one-shot decisions remain fail-closed.

- [ ] **Step 7: Add PTY case 026**

Run a fake model through real fs tools: read a file, edit it, apply a patch, and run the resolved shell. Assert typed headers, running->done update, `(+A/-D)`, expanded hunk lines, raw viewer, copy feedback, and no secret key text.

- [ ] **Step 8: Verify GREEN**

```powershell
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui-app test
pnpm --filter @i-harness/tui exec vitest run test/harness/case-026.test.ts
pnpm --filter @i-harness/tui typecheck
pnpm --filter @i-harness/tui-app typecheck
```

- [ ] **Step 9: Commit**

```powershell
git add apps/tui packages/tui
git commit -m "feat(m49): render typed tools and real viewers"
```

---

### Task 11: Real Session Queue Projection And Cancellation

**Files:**
- Modify: `packages/core-agent/src/executor.ts`
- Modify: `packages/core-agent/test/executor.test.ts`
- Modify: `packages/session-executor/src/service.ts`
- Modify: `packages/session-executor/src/index.ts`
- Modify: `packages/session-executor/test/service.test.ts`
- Modify: `packages/sdk/src/protocol.ts`
- Modify: `packages/sdk/src/server.ts`
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/test/protocol.test.ts`
- Modify: `packages/sdk/test/server.test.ts`
- Modify: `packages/tui/src/contracts.ts`
- Modify: `packages/tui/src/backend/embedded.ts`
- Modify: `packages/tui/src/backend/remote.ts`
- Modify: `packages/tui/src/views/queue-pane.ts`
- Modify: `packages/tui/src/app/loop.ts`
- Modify: `packages/tui/src/app/mouse.ts`
- Modify: `packages/tui/test/panes.test.ts`
- Modify: `packages/tui/test/mouse-click.test.ts`
- Modify: `packages/tui/test/backend.test.ts`
- Modify: `packages/tui/test/remote-backend.test.ts`

**Interfaces:**
- Produces: `SessionQueueItem`
- Produces: `SessionService.queue(sessionId)` and `cancelQueued(sessionId, id)`
- Produces SDK capability `session-queue` with list/cancel methods
- Replaces: fixture-only queue pane and toast-only cancel/send-now actions


- [ ] **Step 1: Write failing lane/service queue tests**

```ts
it("lists a running row followed by queued rows in FIFO order", async () => {
  const gate = deferred<void>()
  const service = serviceWithBlockingModel(gate)
  const first = service.submit("s1", "first", new AbortController().signal)
  const second = service.submit("s1", "second", new AbortController().signal)
  const third = service.submit("s1", "third", new AbortController().signal)
  await waitFor(() => service.queue("s1").length === 3)
  expect(service.queue("s1").map((row) => [row.text, row.state])).toEqual([
    ["first", "running"],
    ["second", "queued"],
    ["third", "queued"],
  ])
  gate.resolve()
  await Promise.all([first, second, third])
})

it("cancels a service-front queued row without executing it", async () => {
  const { service, seen, release } = blockingService()
  const first = service.submit("s1", "first", new AbortController().signal)
  const second = service.submit("s1", "second", new AbortController().signal)
  const row = await waitForQueueText(service, "s1", "second")
  expect(service.cancelQueued("s1", row.id)).toEqual({ cancelled: true })
  release()
  await Promise.all([first, second])
  expect(seen).toEqual(["first"])
})
```

- [ ] **Step 2: Write failing backend/UI tests**

```ts
it("renders live queue rows and removes a cancelled row after refresh", async () => {
  const backend = queueBackend([
    { id: "q1", text: "second prompt", delivery: "queue", intent: "user", state: "queued", order: 2 },
  ])
  const app = new TuiApp(testOptions({ backend }))
  await app.openQueue()
  expect(screenText()).toContain("second prompt")
  await app.cancelQueueItem("q1")
  expect(backend.cancelled).toEqual(["q1"])
  expect(screenText()).not.toContain("second prompt")
})
```

- [ ] **Step 3: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/core-agent exec vitest run test/executor.test.ts
pnpm --filter @i-harness/session-executor exec vitest run test/service.test.ts
pnpm --filter @i-harness/sdk exec vitest run test/protocol.test.ts test/server.test.ts
pnpm --filter @i-harness/tui exec vitest run test/panes.test.ts test/mouse-click.test.ts test/backend.test.ts test/remote-backend.test.ts
```

- [ ] **Step 4: Implement stable queue records**

- Generate the service row id before entering the per-session pacing chain.
- Link the caller signal to a service-owned controller; cancellation settles the submit promise without executing.
- When admitted to the lane, retain the public id and map it to the lane input id.
- Merge service-front and lane pending records by public id; state is running only for the current turn.
- Remove records exactly once on settle/error/cancel/close.

- [ ] **Step 5: Add SDK and backend surfaces**

Methods:

```text
session/queue { sessionId } -> { items }
session/queue/cancel { sessionId, id } -> { cancelled }
```

Advertise `session-queue: ["1"]`; remote hides cancel hit areas without it. Existing `session/status` remains the count-only compatibility surface.

- [ ] **Step 6: Complete QueuePane behavior**

- `/queue` always opens a pane with real rows or `Queue is empty.`.
- Show `[cancel]` only for queued items with backend cancel capability.
- Do not show shell/cron fixture rows or `[Send now]` until an atomic promote backend exists.
- Keyboard and mouse cancel call the same action and refresh from backend truth.

- [ ] **Step 7: Verify GREEN**

```powershell
pnpm --filter @i-harness/core-agent test
pnpm --filter @i-harness/session-executor test
pnpm --filter @i-harness/sdk test
pnpm --filter @i-harness/tui test
```

- [ ] **Step 8: Commit**

```powershell
git add packages/core-agent packages/session-executor packages/sdk packages/tui
git commit -m "feat(m49): expose and control the real prompt queue"
```

---

### Task 12: Subagent/Job Task Projection And Detail Viewer

**Files:**
- Create: `packages/subagent/src/projection.ts`
- Create: `packages/subagent/test/projection.test.ts`
- Modify: `packages/subagent/src/index.ts`
- Modify: `packages/session-executor/src/assembly.ts`
- Modify: `packages/session-executor/src/service.ts`
- Modify: `packages/session-executor/src/index.ts`
- Modify: `packages/session-executor/test/assembly.test.ts`
- Modify: `packages/session-executor/test/service.test.ts`
- Modify: `packages/sdk/src/protocol.ts`
- Modify: `packages/sdk/src/server.ts`
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/test/server.test.ts`
- Modify: `packages/tui/src/contracts.ts`
- Modify: `packages/tui/src/backend/embedded.ts`
- Modify: `packages/tui/src/backend/remote.ts`
- Modify: `packages/tui/src/views/tasks-pane.ts`
- Modify: `packages/tui/src/views/block-viewer.ts`
- Modify: `packages/tui/src/app/loop.ts`
- Modify: `packages/tui/src/app/mouse.ts`
- Modify: `packages/tui/test/panes.test.ts`
- Modify: `packages/tui/test/backend.test.ts`
- Modify: `packages/tui/test/remote-backend.test.ts`

**Interfaces:**
- Produces: `AgentTaskView`
- Produces: `projectAgentTasks(subagentState): AgentTaskView[]`
- Produces: `SessionAssembly.tasks()`, `SessionService.tasks(sessionId)`, `cancelTask(sessionId, id)`
- Produces SDK capability `session-tasks`

- [ ] **Step 1: Write failing projection tests**

```ts
it("projects stable parent/child task rows without leaking registries", () => {
  const rows = projectAgentTasks(fixtureState({
    agents: [{ id: "root/helper", parentId: "root", role: "helper", status: "running" }],
    jobs: [{ id: "job-1", agentId: "root/helper", status: "running", prompt: "inspect code" }],
  }))
  expect(rows).toEqual([
    expect.objectContaining({
      id: "root/helper",
      parentId: "root",
      group: "subagent",
      label: "helper",
      status: "running",
      canCancel: true,
    }),
    expect.objectContaining({
      id: "job-1",
      parentId: "root/helper",
      group: "job",
      status: "running",
    }),
  ])
})

it("maps settled and recovered states honestly", () => {
  expect(projectStatus({ status: "completed" })).toBe("completed")
  expect(projectStatus({ status: "error" })).toBe("failed")
  expect(projectStatus({ status: "waiting" })).toBe("waiting")
  expect(projectStatus({ status: "cancelled" })).toBe("cancelled")
})
```

- [ ] **Step 2: Write failing service/backend tests**

```ts
it("serves task rows for one live assembly and cancels through the owning registry", async () => {
  const service = serviceWithSubagentFixture()
  await service.assemblyFor("s1")
  expect(service.tasks("s1")).toContainEqual(expect.objectContaining({ id: "root/helper" }))
  expect(service.cancelTask("s1", "root/helper")).toBe("cancellation-requested")
})

it("remote tasks are absent when the server lacks session-tasks", async () => {
  const backend = remoteBackendWithCapabilities({})
  expect(backend.tasks).toBeUndefined()
  expect(backend.cancelTask).toBeUndefined()
})
```

- [ ] **Step 3: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/subagent exec vitest run test/projection.test.ts
pnpm --filter @i-harness/session-executor exec vitest run test/assembly.test.ts test/service.test.ts
pnpm --filter @i-harness/sdk exec vitest run test/server.test.ts
pnpm --filter @i-harness/tui exec vitest run test/panes.test.ts test/backend.test.ts test/remote-backend.test.ts
```

- [ ] **Step 4: Implement the projection at the domain boundary**

- Add a read-only projection method to the object returned by `registerSubagent()`.
- Stable ids come from existing agent/job ids; do not synthesize by array position.
- Include role/model/parent prompt/result/error/transcript availability in a detail payload, but keep the list row compact.
- Merge workflow jobs only when the assembly's real workflow executor owns them; schedule rows only when a schedule source is mounted.
- `canCancel` follows current registry state, not UI guesses.

- [ ] **Step 5: Add service/SDK/backend methods**

```text
session/tasks { sessionId } -> { items }
session/tasks/cancel { sessionId, id } -> { status }
```

Advertise `session-tasks: ["1"]`. Unknown/not-cancellable ids return existing not-found/already-finished semantics.

- [ ] **Step 6: Complete TasksPane and detail viewer**

- `/tasks` always shows true groups or `No active tasks.`.
- Group rows collapse/expand; selection is stable across refresh by id.
- Enter opens the Task viewer. Child transcript loads from memory/disk when reconstructible and explains unavailable states.
- `[stop]`/kill appears only when `canCancel` and backend capability are true.

- [ ] **Step 7: Verify GREEN**

```powershell
pnpm --filter @i-harness/subagent test
pnpm --filter @i-harness/session-executor test
pnpm --filter @i-harness/sdk test
pnpm --filter @i-harness/tui test
```

- [ ] **Step 8: Commit**

```powershell
git add packages/subagent packages/session-executor packages/sdk packages/tui
git commit -m "feat(m49): project live tasks and subagents into TUI"
```

---

### Task 13: Local Dashboard And Truthful Status Line

**Files:**
- Create: `packages/tui/src/views/dashboard-state.ts`
- Create: `packages/tui/src/views/dashboard.ts`
- Create: `packages/tui/src/app/status-source.ts`
- Create: `packages/tui/test/dashboard.test.ts`
- Create: `packages/tui/test/status-source.test.ts`
- Modify: `packages/tui/src/contracts.ts`
- Modify: `packages/tui/src/backend/embedded.ts`
- Modify: `packages/tui/src/backend/remote.ts`
- Modify: `packages/tui/src/views/status.ts`
- Modify: `packages/tui/src/app/keys.ts`
- Modify: `packages/tui/src/app/loop.ts`
- Modify: `packages/tui/src/app/present.ts`
- Modify: `packages/tui/src/app/mouse.ts`
- Modify: `packages/tui/test/present.test.ts`
- Modify: `packages/tui/test/backend.test.ts`
- Modify: `packages/tui/test/remote-backend.test.ts`
- Modify: `packages/settings/src/index.ts`
- Modify: `packages/settings/test/settings.test.ts`
- Modify: `packages/sdk/src/protocol.ts`
- Modify: `packages/sdk/src/server.ts`
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/test/server.test.ts`
- Modify: `apps/tui/package.json`
- Modify: `apps/tui/src/index.ts`
- Modify: `pnpm-lock.yaml`
- Create: `packages/tui/test/harness/host-027.ts`
- Create: `packages/tui/test/harness/case-027.yaml`
- Create: `packages/tui/test/harness/case-027.test.ts`

**Interfaces:**
- Produces: `DashboardSessionRow`, `DashboardState`
- Produces SDK capability `session-dashboard`
- Produces: injected `StatusSource` plus optional command runner
- Consumes: real model/queue/task/session projections

- [ ] **Step 1: Write failing dashboard-state tests**

```ts
it("keeps stable selection by session id while rows refresh", () => {
  const state = createDashboardState([
    row("s1", "One"), row("s2", "Two"),
  ])
  state.select("s2")
  state.replaceRows([row("s2", "Two updated"), row("s3", "Three")])
  expect(state.selectedId()).toBe("s2")
})

it("filters, pins, and orders only authoritative rows", () => {
  const state = createDashboardState([row("s1", "Alpha"), row("s2", "Beta")], {
    pinned: ["s2", "missing"], order: ["s1", "s2"],
  })
  state.setFilter("beta")
  expect(state.visibleRows().map((item) => item.id)).toEqual(["s2"])
})
```

- [ ] **Step 2: Write failing status aggregation tests**

```ts
it("omits unknown status segments instead of fabricating defaults", async () => {
  const status = await collectStatus({
    workspace: "D:/repo",
    modelState: { status: "unconfigured", reason: "No model configured" },
    context: undefined,
    tasks: undefined,
  })
  expect(status.cwd).toBe("D:/repo")
  expect(status.model).toBeUndefined()
  expect(status.context).toBeUndefined()
  expect(status.tasks).toBeUndefined()
})

it("sanitizes and retains a command status through two failures", async () => {
  const runner = scriptedStatusRunner(["ok\x1b[31m\nsecond", new Error("x"), new Error("y"), new Error("z")])
  const source = createCommandStatusSource(runner, { timeoutMs: 1000, refreshMs: 1000 })
  expect(await source.refresh(context())).toBe("ok")
  expect(await source.refresh(context())).toBe("ok")
  expect(await source.refresh(context())).toBe("ok")
  expect(await source.refresh(context())).toContain("status command failed")
})
```

- [ ] **Step 3: Write failing SDK/UI tests**

```ts
it("returns dashboard rows enriched only with known live fields", async () => {
  const result = await client.dashboard()
  expect(result.sessions).toContainEqual(expect.objectContaining({
    id: "s1", live: true, running: true, queued: 1, tasks: 2,
  }))
  expect(result.sessions[0]).not.toHaveProperty("cost")
})

it("opens a dashboard row and preserves state when returning", async () => {
  const app = dashboardApp([row("s1", "One"), row("s2", "Two")])
  app.dashboard.select("s2")
  await app.openSelectedDashboardSession()
  await app.goHome()
  expect(app.dashboard.selectedId()).toBe("s2")
})
```

- [ ] **Step 4: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/tui exec vitest run test/dashboard.test.ts test/status-source.test.ts test/present.test.ts test/backend.test.ts test/remote-backend.test.ts
pnpm --filter @i-harness/sdk exec vitest run test/server.test.ts
pnpm --filter @i-harness/settings test
```

- [ ] **Step 5: Implement local dashboard data and view**

- Build rows from session list plus live model/queue/task status.
- Support filter, keyboard/mouse selection, open/resume, create, peek tail, pin, and order.
- Persist only pinned/order ids under `tui.prefs.dashboard`; ignore missing ids without deleting them until the next successful commit.
- Never create a dashboard database or cross-machine/team rows.

- [ ] **Step 6: Add SDK dashboard capability**

```text
session/dashboard {} -> { sessions: DashboardSessionRow[] }
```

Advertise `session-dashboard: ["1"]`; the remote backend omits dashboard action without it.

- [ ] **Step 7: Implement status source and command runner**

- Builtin values: real cwd/branch/model/context/timer/session/queue/tasks/todo/goal only.
- Fit one stable row; drop rightmost low-priority segments before truncating text.
- `apps/tui` command runner uses `@i-harness/exec`, workspace cwd, JSON stdin, 1000ms timeout, first non-empty line, 4096-byte cap, control-code sanitization.
- Refresh no faster than 300ms; never block draw.

- [ ] **Step 8: Add PTY case 027**

Drive two sessions, one running subagent, and one queued prompt. Open dashboard, filter, peek, resume; open tasks and queue; cancel a queued prompt and task. Assert status counts update from 1 to 0 and selection remains stable.

- [ ] **Step 9: Verify GREEN**

```powershell
pnpm --filter @i-harness/settings test
pnpm --filter @i-harness/sdk test
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui-app test
pnpm --filter @i-harness/tui exec vitest run test/harness/case-027.test.ts
```

- [ ] **Step 10: Commit**

```powershell
git add apps/tui packages/settings packages/sdk packages/tui pnpm-lock.yaml
git commit -m "feat(m49): add local dashboard and truthful status"
```

---

### Task 14: Capability-Gated Slash Commands And Agent Prompts

**Files:**
- Create: `packages/preset/src/default.ts`
- Create: `packages/preset/test/default.test.ts`
- Modify: `packages/preset/src/index.ts`
- Modify: `packages/session-executor/src/assembly.ts`
- Modify: `packages/session-executor/test/assembly.test.ts`
- Modify: `packages/subagent/src/child.ts`
- Modify: `packages/subagent/test/child.test.ts`
- Modify: `packages/tui/src/app/slash/types.ts`
- Modify: `packages/tui/src/app/slash/registry.ts`
- Modify: `packages/tui/src/app/slash/impl/approval.ts`
- Modify: `packages/tui/src/app/slash/impl/eco.ts`
- Modify: `packages/tui/src/app/slash/impl/g1.ts`
- Modify: `packages/tui/src/app/slash/impl/mouse.ts`
- Modify: `packages/tui/src/app/slash/impl/navigation.ts`
- Modify: `packages/tui/src/app/slash/impl/run.ts`
- Modify: `packages/tui/src/app/slash/impl/sessions.ts`
- Modify: `packages/tui/src/app/slash/impl/surfaces.ts`
- Modify: `packages/tui/src/app/slash/impl/text-input.ts`
- Modify: `packages/tui/src/app/slash/impl/timeline.ts`
- Modify: `packages/tui/src/app/slash/impl/tools.ts`
- Modify: `packages/tui/src/app/slash/impl/visual.ts`
- Modify: `packages/tui/src/app/slash/impl/workflow2.ts`
- Delete: `packages/tui/src/app/slash/impl/skipped.ts`
- Modify: `packages/tui/src/app/keys.ts`
- Modify: `packages/tui/src/app/loop.ts`
- Modify: `packages/tui/src/views/slash-dropdown.ts`
- Modify: `packages/tui/src/views/shortcuts.ts`
- Modify: `packages/tui/test/slash-registry.test.ts`
- Modify: `packages/tui/test/slash-commands.test.ts`
- Modify: `packages/tui/test/slash-app.test.ts`
- Modify: `packages/tui/test/keys.test.ts`
- Modify: `packages/tui-core/src/terminal/index.ts`
- Modify: `packages/tui-core/test/terminal.test.ts`

**Interfaces:**
- Produces: typed `SlashCapability`
- Produces: `Unsupported command: /<name>` non-LLM path
- Produces: `DEFAULT_AGENT_PRESET` and subagent prompt fragments
- Produces: runtime terminal mouse capture enable/disable

- [ ] **Step 1: Write failing slash visibility/submission tests**

```ts
it("lists only commands whose capabilities are present", () => {
  const ctx = slashContext({ capabilities: ["session-list", "provider-settings"] })
  const names = defaultRegistry().visible(ctx).map((command) => command.name)
  expect(names).toContain("resume")
  expect(names).toContain("settings")
  expect(names).not.toContain("rewind")
  expect(names).not.toContain("login")
  expect(names).not.toContain("delete")
})

it("never submits an unsupported slash command to the model", async () => {
  const backend = recordingBackend()
  const app = slashApp(backend)
  app.editor.replaceAll("/login")
  await app.submitPrompt()
  expect(app.toast).toBe("Unsupported command: /login")
  expect(backend.submissions).toEqual([])
})
```

- [ ] **Step 2: Write failing real-command tests**

Use table-driven tests with literal expected calls:

```ts
it.each([
  ["/new", "createSession"],
  ["/dashboard", "dashboard"],
  ["/queue", "queue"],
  ["/tasks", "tasks"],
  ["/settings", "openSettings"],
  ["/copy", "copy"],
] as const)("%s invokes %s", async (input, expected) => {
  const ctx = recordingSlashContext()
  await runSlash(input, ctx)
  expect(ctx.calls).toEqual([expected])
})
```

Add explicit tests for argument validation of `/model`, `/effort`, `/rename`, `/fork`, `/compact`, `/find`, `/jump`, `/workflow`, and `/theme`.

- [ ] **Step 3: Write failing prompt-composition tests**

```ts
it("uses the I-harness default preset when no override is supplied", async () => {
  const model = capturingModel()
  const assembly = await createSessionAssembly({ workspace: dir, model })
  await assembly.agent.run("inspect")
  expect(model.requests[0].systemPrompt).toContain("I-harness")
  expect(model.requests[0].systemPrompt).toContain("verify before claiming completion")
  expect(model.requests[0].systemPrompt).not.toContain("Grok")
})

it("keeps an explicit preset override authoritative", async () => {
  const model = capturingModel()
  const assembly = await createSessionAssembly({
    workspace: dir,
    model,
    preset: JSON.stringify({ systemPrompt: "custom-system" }),
  })
  await assembly.agent.run("inspect")
  expect(model.requests[0].systemPrompt).toContain("custom-system")
})
```

- [ ] **Step 4: Run tests and verify RED**

```powershell
pnpm --filter @i-harness/tui exec vitest run test/slash-registry.test.ts test/slash-commands.test.ts test/slash-app.test.ts test/keys.test.ts
pnpm --filter @i-harness/preset test
pnpm --filter @i-harness/session-executor exec vitest run test/assembly.test.ts
pnpm --filter @i-harness/subagent exec vitest run test/child.test.ts
pnpm --filter @i-harness/tui-core exec vitest run test/terminal.test.ts
```

- [ ] **Step 5: Implement capability-gated command inventory**

Required visible command groups are exactly those in spec section 10.2. Account/billing/privacy/delete/cd/memory/media commands are not registered as executable commands. `/plan`, `/view-plan`, `/auto`, and `/always-approve` appear only if their live backend capability exists.

- Unknown slash parsing happens before user-message append.
- `/help` renders the current visible registry and active key bindings, never a static list.
- `/usage` is local context/session usage only and labels itself accordingly.
- `/plugins`/`/mcps`/`/hooks` distinguish configured, mounted, failed, and unavailable states.

- [ ] **Step 6: Implement the I-harness default prompts**

`DEFAULT_AGENT_PRESET.systemPrompt` covers repository-first work, existing patterns, tool/approval/sandbox semantics, systematic debugging, TDD, verification, subagent ownership, progress updates, honest capability reporting, and concise final delivery. Keep readable source in `preset`; do not copy Grok wording or add obfuscation.

Subagent prompt adds task scope, no recursive delegation unless explicitly supported, changed-files/test reporting, and result delivery. Human/project instructions remain higher priority.

- [ ] **Step 7: Implement runtime mouse capture toggle and input precedence**

- `terminal.setMouseReporting(on)` emits enable/disable sequences only on transitions.
- Turning off clears hover/drag/click state and restores terminal-native selection.
- Minimal ignores attempts and remains off.
- Input precedence is confirm/permission/question -> viewer -> modal -> pane -> prompt -> scrollback.

- [ ] **Step 8: Verify GREEN**

```powershell
pnpm --filter @i-harness/preset test
pnpm --filter @i-harness/subagent test
pnpm --filter @i-harness/session-executor test
pnpm --filter @i-harness/tui-core test
pnpm --filter @i-harness/tui test
```

- [ ] **Step 9: Commit**

```powershell
git add packages/preset packages/subagent packages/session-executor packages/tui-core packages/tui
git commit -m "feat(m49): gate commands and align agent prompts"
```

---

### Task 15: Final PTY Parity, Documentation, And Delivery Verification

**Files:**
- Create: `packages/tui/test/harness/host-028.ts`
- Create: `packages/tui/test/harness/case-028.yaml`
- Create: `packages/tui/test/harness/case-028.test.ts`
- Modify: `packages/tui/test/harness/host-024.ts`
- Modify: `packages/tui/test/harness/case-024.yaml`
- Modify: `packages/tui/test/harness/case-024.test.ts`
- Modify: `packages/tui/test/harness/host-025.ts`
- Modify: `packages/tui/test/harness/case-025.yaml`
- Modify: `packages/tui/test/harness/case-025.test.ts`
- Modify: `packages/tui/test/harness/host-026.ts`
- Modify: `packages/tui/test/harness/case-026.yaml`
- Modify: `packages/tui/test/harness/case-026.test.ts`
- Modify: `packages/tui/test/harness/host-027.ts`
- Modify: `packages/tui/test/harness/case-027.yaml`
- Modify: `packages/tui/test/harness/case-027.test.ts`
- Modify: `README.md`
- Modify: `docs/CAPABILITIES.md`
- Modify: `docs/CAPABILITIES-DETAIL.md`
- Modify: `docs/research/2026-09-06-m49-grok-tui-parity-inventory.md`
- Modify: `docs/superpowers/specs/2026-09-06-m49-grok-tui-parity-design.md`
- Modify: `docs/superpowers/plans/2026-09-06-m49-grok-tui-parity.md`

**Interfaces:**
- Consumes all earlier tasks
- Produces integrated parity proof and final delivery record
- Does not add new product behavior except fixes exposed by integration tests

- [ ] **Step 1: Write PTY case 028 before final integration fixes**

Case 028 must exercise one continuous executable session:

1. Start from persisted ready provider/model and `screenMode: minimal`.
2. Prove no alternate-screen or mouse-enable bytes.
3. Switch fullscreen, cycle all terminal-supported themes, and persist one.
4. Toggle mouse capture off/on and assert disable/enable bytes.
5. Open Settings, Dashboard, Queue, Tasks, tool viewer, file viewer, and Help; verify modal input precedence and Esc unwinding.
6. Submit an unsupported `/login`; assert the exact unsupported message and zero backend submissions.
7. Restart; assert theme/screen/status settings persisted and model label matches the real binding.

- [ ] **Step 2: Run case 028 and verify RED where integration is incomplete**

```powershell
pnpm --filter @i-harness/tui exec vitest run test/harness/case-028.test.ts
```

- [ ] **Step 3: Fix only integration defects found by case 028**

For each defect, add or tighten the smallest focused unit/integration test in the owning package before changing production code. Do not broaden scope beyond the spec.

- [ ] **Step 4: Run focused package gates**

```powershell
pnpm --filter @i-harness/settings test
pnpm --filter @i-harness/credentials test
pnpm --filter @i-harness/provider test
pnpm --filter @i-harness/provider-runtime test
pnpm --filter @i-harness/text-diff test
pnpm --filter @i-harness/fs test
pnpm --filter @i-harness/core-agent test
pnpm --filter @i-harness/session-executor test
pnpm --filter @i-harness/subagent test
pnpm --filter @i-harness/sdk test
pnpm --filter @i-harness/tui-core test
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui-app test
pnpm --filter @i-harness/cli test
```

- [ ] **Step 5: Run every PTY parity case separately**

```powershell
pnpm --filter @i-harness/tui-core exec vitest run test/harness/case-010.test.ts
pnpm --filter @i-harness/tui exec vitest run test/harness/case-011.test.ts test/harness/case-012.test.ts test/harness/case-013.test.ts test/harness/case-014.test.ts test/harness/case-015.test.ts test/harness/case-016.test.ts test/harness/case-017.test.ts test/harness/case-018.test.ts test/harness/case-019.test.ts test/harness/case-020.test.ts test/harness/case-021.test.ts test/harness/case-022.test.ts test/harness/case-023.test.ts test/harness/case-024.test.ts test/harness/case-025.test.ts test/harness/case-026.test.ts test/harness/case-027.test.ts test/harness/case-028.test.ts
```

Record the real exit code; `node-pty AttachConsole failed` helper noise does not override a passing exit, and a truncated console log never counts as proof.

- [ ] **Step 6: Update truthful documentation**

- Mark M46 mock fallback/provider plane and fixture-only pane claims as superseded by M49.
- Document canonical provider settings, manual/discovery behavior, ambient Bedrock auth, and the future OAuth extension boundary.
- List the exact visible slash command set and explicit omissions.
- Document minimal/fullscreen/theme/status behavior and local-only dashboard scope.
- Include final test counts and any remaining Minor findings; do not claim account OAuth, billing, delete, cross-machine dashboard, or unsupported discovery.

- [ ] **Step 7: Run full repository and distribution verification**

```powershell
pnpm typecheck
pnpm test
pnpm e2e
node scripts/build-dist.mjs
node scripts/verify-dist.mjs
node scripts/build-installer.mjs
node scripts/verify-installer.mjs
git diff --check
git status --short --branch
```

- [ ] **Step 8: Scan production honesty invariants**

```powershell
rg -n "falling back to the mock|mock-model|No model.*mock|SETTINGS_NOT_AVAILABLE|SETTINGS_MOUSE_PLACEHOLDER" apps packages -g '*.ts'
rg -n "tui\.providers|SettingsTuiProvider|createTuiModelBuilder|ProviderStore" apps packages -g '*.ts'
rg -n 'name: "(login|logout|share|privacy|delete|cd|remember|recap|voice|imagine|imagine-video)"' packages/tui/src/app/slash -g '*.ts'
```

Expected: no production mock/legacy-plane/unsupported-command implementation hits; intentional migration/test strings are reviewed individually.

- [ ] **Step 9: Commit final integration and docs**

```powershell
git add -u -- apps packages
git add README.md docs packages/tui/test/harness
git commit -m "docs(m49): close Grok TUI parity delivery"
```

- [ ] **Step 10: Request whole-branch review**

Generate the review package from M49 merge base through HEAD and dispatch the final reviewer. One fix wave is allowed, followed by one scoped re-review. Resolve every Critical/Important finding before branch finishing.
