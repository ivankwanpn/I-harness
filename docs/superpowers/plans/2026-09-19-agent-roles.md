# Agent Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a sub-agent role able to run on its own model, through the same resolution chain the session uses — so the main agent can dispatch `general` on a cheap model and `worker` on a strong one, instead of every sub-agent being a copy of the parent.

**Architecture:** A new `agents.roles.<name>` settings section carries the selection; the spawn path resolves it through `ProviderRuntime.resolveModel` (same credentials, same card table, same protocol chain) instead of the empty `ProviderRegistry` that made the existing `role.model` field a no-op. Nothing about the settings' provider plane changes, and no `llm-*` adapter is touched.

**Tech Stack:** TypeScript ESM, pnpm workspace, vitest, `@i-harness/settings`, `@i-harness/provider-runtime`, `@i-harness/subagent`, `@i-harness/session-executor`, `apps/cli`.

**Spec:** `docs/superpowers/specs/2026-09-19-agent-roles-design.md`
**Related:** `docs/superpowers/specs/2026-09-19-protocol-selection-design.md` §2 (the chain this plan's Task 2 extends) and §5 (the sub-agent unification, which THIS plan delivers ahead of that one).

## Global Constraints

- **Never add a `Co-Authored-By` trailer** to any commit in this repo. Write commit messages with a quoted heredoc (`git commit -F -`) — backticks inside `-m` have silently eaten text twice on this branch.
- **A new export must land WITH its consumer in the same task.** `node scripts/audit/check-reachability.mjs --gate` must print `gate PASS -- no new rows` after every task. The instrument counts `export interface` / `export type` as rows.
- **TDD, and a mutation proof where a mechanism can be removed.** Red first, then green, then remove the mechanism and watch the right tests redden, then restore.
- Gate commands from the repo root: `pnpm -C packages/<pkg> test`, `pnpm typecheck`, `pnpm -r --no-bail test`, `node scripts/audit/check-reachability.mjs --gate`.
- **No silent fallbacks.** A role that declares a model and cannot get it must FAIL the spawn with an actionable message — never run on a different model quietly.
- `apps/cli` is a development/test harness whose job is to make every production capability exercisable.

---

### Task 1: the `agents.roles` settings section

**Files:**
- Modify: `packages/settings/src/index.ts` (`Settings` at :226, `SETTINGS_DEFAULTS` at :275, `normalizeSettings` at :562)
- Test: `packages/settings/test/settings.test.ts` (append; if the file is named differently, find the suite that tests `normalizeSettings`)

**Interfaces:**
- Consumes: `SettingsProviderProtocol` + the module-private `isProviderProtocol` (:332) and `isNonEmptyString`, both already in this file.
- Produces:
  - `export interface SettingsRoleModel { provider: string; model: string; protocol?: SettingsProviderProtocol; reasoningEffort?: string }`
  - `export interface SettingsAgents { roles: Record<string, SettingsRoleModel> }`
  - `Settings.agents: SettingsAgents` — read by Task 4 and Task 5.

- [ ] **Step 1: Write the failing test**

```ts
// The roles section: each role may name a model. `provider` and `model` are
// required TOGETHER — a half entry is not a setting, it is a guess, and the
// normalizer drops it the same way it drops a bad baseURL.
describe("agents.roles", () => {
  it("round-trips a full entry and defaults to none", () => {
    const parsed = normalizeSettings({
      agents: {
        roles: {
          worker: { provider: "gw", model: "big", protocol: "anthropic-messages", reasoningEffort: "max" },
          explore: { provider: "gw", model: "small" },
        },
      },
    })
    expect(parsed.agents.roles).toEqual({
      worker: { provider: "gw", model: "big", protocol: "anthropic-messages", reasoningEffort: "max" },
      explore: { provider: "gw", model: "small" },
    })
    expect(normalizeSettings({}).agents).toEqual({ roles: {} })
  })

  it("drops a HALF entry rather than completing it", () => {
    const parsed = normalizeSettings({
      agents: { roles: { general: { provider: "gw" }, worker: { model: "big" } } },
    })
    expect(parsed.agents.roles).toEqual({})
  })

  it("drops an invalid protocol but keeps the entry", () => {
    const parsed = normalizeSettings({
      agents: { roles: { general: { provider: "gw", model: "m", protocol: "grpc" } } },
    })
    expect(parsed.agents.roles).toEqual({ general: { provider: "gw", model: "m" } })
  })
})
```

- [ ] **Step 2: Run it — expect RED**

Run: `pnpm -C packages/settings test`
Expected: FAIL — `agents` is `undefined`, so `parsed.agents.roles` throws.

- [ ] **Step 3: Implement**

In `packages/settings/src/index.ts`, beside `SettingsDefaultModel`:

```ts
/** One role's model selection: the shape of `SettingsDefaultModel` plus the
 * protocol, because a role may name an endpoint as well as a model. `provider`
 * and `model` are required TOGETHER — a role that named only one would be
 * asking us to guess the other. */
export interface SettingsRoleModel {
  provider: string
  model: string
  protocol?: SettingsProviderProtocol
  reasoningEffort?: string
}

/** `agents.roles.<name>`: the model a sub-agent role runs on. An ABSENT role
 * inherits the parent's client — which is what every role did before this
 * section existed, and what an unconfigured harness still does. */
export interface SettingsAgents {
  roles: Record<string, SettingsRoleModel>
}
```

Add to `Settings` (before `llm`):

```ts
  /** Agent-role configuration. A separate plane from `llm`: `llm` is the
   * provider plane, this is which of them a ROLE runs on. */
  agents: SettingsAgents
```

Add to `SETTINGS_DEFAULTS`:

```ts
  agents: { roles: {} },
```

Add the normalizers beside `normalizeProviderConfig`:

```ts
/** One role entry. Returns null for anything that is not a complete selection —
 * a half entry (`provider` without `model` or vice versa) is DROPPED, not
 * completed: completing it is the guess this design exists to avoid. */
function normalizeRoleModel(raw: unknown): SettingsRoleModel | null {
  if (!isRecord(raw)) return null
  if (!isNonEmptyString(raw.provider) || !isNonEmptyString(raw.model)) return null
  const out: SettingsRoleModel = { provider: raw.provider, model: raw.model }
  if (isProviderProtocol(raw.protocol)) out.protocol = raw.protocol
  if (isNonEmptyString(raw.reasoningEffort)) out.reasoningEffort = raw.reasoningEffort
  return out
}

function normalizeAgents(raw: unknown, base: SettingsAgents): SettingsAgents {
  if (!isRecord(raw)) return { roles: { ...base.roles } }
  const rolesRaw = isRecord(raw.roles) ? raw.roles : {}
  const roles: Record<string, SettingsRoleModel> = {}
  for (const [name, value] of Object.entries(rolesRaw)) {
    const entry = normalizeRoleModel(value)
    if (entry !== null) roles[name] = entry
  }
  return { roles }
}
```

Wire it into `normalizeSettings` — BOTH return arms (the non-record arm and the main arm):

```ts
      agents: normalizeAgents(undefined, base.agents),
```
```ts
    agents: normalizeAgents(raw.agents, base.agents),
```

**Do NOT add `agents` to `SectionName`** (`sections.ts:21`, currently `"llm" | "onboarding"`). That union is the UI-editable-section API, whose consumers are `describeSection`/`mutate`; the roles section becomes one when the frontend does.

- [ ] **Step 4: Run it — expect GREEN**

Run: `pnpm -C packages/settings test && pnpm typecheck`
Expected: PASS. `pnpm typecheck` matters here — adding a field to `Settings` means every exhaustive construction of it must be updated; fix those sites rather than loosening the type.

- [ ] **Step 5: Mutation proof**

Change `normalizeRoleModel`'s guard to `if (!isNonEmptyString(raw.provider)) return null` and run.
Expected: the "drops a HALF entry" case reddens (the `{ model: "big" }` entry is now dropped and the `{ provider: "gw" }` entry survives, so the equality fails). Restore and re-run to green.

- [ ] **Step 6: Commit**

```bash
git add packages/settings/src/index.ts <the test file>
git commit -F - <<'EOF'
feat(settings): the agents.roles section — a role may name its own model

The four roles ship WITHOUT a model, so every sub-agent inherits the parent's
client today. This is where a host says otherwise. `provider` and `model` are
required together and a half entry is DROPPED rather than completed: completing
it would be guessing which provider the user meant.
EOF
```

---

### Task 2: the selection carries a protocol (the chain's top arm)

**Files:**
- Modify: `packages/provider-runtime/src/index.ts` (`resolveModel`'s input type ~:70, the `runtimeProfile` call ~:588, `runtimeProfile` ~:673)
- Test: `packages/provider-runtime/test/runtime.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveModel`'s `sessionSelection` gains `protocol?: SettingsProviderProtocol`. Precedence becomes **selection > model row > route**. Task 4 passes a role's selection through this field.

- [ ] **Step 1: Write the failing test**

```ts
describe("a selection may carry its own protocol", () => {
  async function gwFixture() {
    return fixture({
      providers: {
        gw: {
          baseURL: "https://gw.example",
          protocol: "openai-completions",
          apiKeyEnv: "GW_API_KEY",
          models: [{ id: "plain" }, { id: "row-wins-otherwise", protocol: "gemini" }],
        },
      },
      credentials: { GW_API_KEY: "fixture-key" },
      registry(registry) {
        registry.register({ name: "gw", displayName: "Gateway", protocol: "openai-compatible" })
      },
    })
  }

  it("beats the ROUTE's protocol", async () => {
    const { runtime, builds } = await gwFixture()
    await runtime.resolveModel({ sessionSelection: { provider: "gw", model: "plain", protocol: "anthropic-messages" } })
    expect(builds[0]?.profile.protocol).toBe("anthropic-messages")
  })

  it("beats the model ROW's too — the selection is the most specific thing there is", async () => {
    const { runtime, builds } = await gwFixture()
    await runtime.resolveModel({ sessionSelection: { provider: "gw", model: "row-wins-otherwise", protocol: "anthropic-messages" } })
    expect(builds[0]?.profile.protocol).toBe("anthropic-messages")
  })

  it("absent → the row's, then the route's, exactly as before", async () => {
    const { runtime, builds } = await gwFixture()
    await runtime.resolveModel({ sessionSelection: { provider: "gw", model: "row-wins-otherwise" } })
    await runtime.resolveModel({ sessionSelection: { provider: "gw", model: "plain" } })
    expect(builds[0]?.profile.protocol).toBe("gemini")
    expect(builds[1]?.profile.protocol).toBe("openai-compatible")
  })
})
```

- [ ] **Step 2: Run it — expect RED**

Run: `pnpm -C packages/provider-runtime test`
Expected: the first two cases FAIL with `openai-compatible` where `anthropic-messages` was asked for (the third passes already).

- [ ] **Step 3: Implement**

In the `ProviderRuntime.resolveModel` input type (`~:68-71`), add the field and say what it is for:

```ts
  resolveModel(input: {
    /** The explicit selection. Named for the session because that is who
     * usually makes it, but a SUB-AGENT ROLE supplies one too — the child is a
     * session, and both go through this one chain. */
    sessionSelection?: { provider: string; model: string; protocol?: SettingsProviderProtocol; reasoningEffort?: string }
    override?: string
  }): Promise<ModelResolutionState>
```

In the implementation (`~:588`), pass the selection's protocol ABOVE the row's:

```ts
      const userModel = view.user?.models?.find((model) => model.id === modelId)
      // The chain, most specific first: the SELECTION (a session's or a role's),
      // then the model row, then the route — see runtimeProfile.
      const profile = runtimeProfile(
        view, apiKey, userModel?.inputModalities, selection.protocol ?? userModel?.protocol,
      )
```

(`selection` is what `selectModel` returned; add `protocol` to the `SelectedModel` interface and to `selectModel`'s third return arm — the session-selection one — so it rides through.)

Also add `protocol?: string` to `SelectedModel` and spread it in `selectModel`:
```ts
    return {
      providerId: input.sessionSelection.provider,
      modelId: input.sessionSelection.model,
      ...(input.sessionSelection.protocol !== undefined ? { protocol: input.sessionSelection.protocol } : {}),
      ...(input.sessionSelection.reasoningEffort !== undefined ? { reasoningEffort: input.sessionSelection.reasoningEffort } : {}),
    }
```

- [ ] **Step 4: Run it — expect GREEN**

Run: `pnpm -C packages/provider-runtime test`
Expected: PASS (42 existing + 3 new = 45).

- [ ] **Step 5: Mutation proof**

Change `selection.protocol ?? userModel?.protocol` to `userModel?.protocol` and run.
Expected: exactly the first two new cases redden; the third stays green. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/provider-runtime/src/index.ts packages/provider-runtime/test/runtime.test.ts
git commit -F - <<'EOF'
feat(provider-runtime): a selection may carry its own protocol

The chain was row > route. A role's selection (and a session's) belongs ABOVE
the row: it is the most specific statement of intent there is, and it is what
makes "this child runs on that endpoint" expressible without editing the
route's own declaration.
EOF
```

---

### Task 3: the sub-agent resolves through the runtime, not a registry

**Files:**
- Modify: `packages/subagent/src/index.ts` (`RegisterSubagentOptions.providers` ~:107), `packages/subagent/src/tools.ts` (`SubagentToolDeps.providers` ~:35, the restore path ~:553-563), `packages/subagent/src/child.ts` (`opts.providers` ~:98, the resolution ~:150-155)
- Modify: `packages/session-executor/src/assembly.ts:697-702` (the empty registry)
- Test: `packages/subagent/test/*` (the suite that covers `spawnChild`; find it — `grep -rn "spawnChild" packages/subagent/test`)

**Interfaces:**
- Consumes: `ProviderRuntime.resolveModel`'s contract (Task 2's shape).
- Produces: `resolveModel(selection: { provider: string; model: string; protocol?: SettingsProviderProtocol; reasoningEffort?: string }): Promise<ModelResolutionState>` replaces `providers: ProviderRegistry` in all three option/deps interfaces. Task 4 relies on it.

- [ ] **Step 1: Write the failing test**

Append to `packages/subagent/test/child.test.ts` (it already builds the fixture you need — see its `spawnChild` block at :31-65; copy that setup and drop the `providers` line):

```ts
describe("a role's model goes through the host's resolver (not a registry)", () => {
  function spawnFixture() {
    const parentCtx = createContext()
    const parentReg = createToolRegistry(parentCtx)
    parentReg.register(makeTool("read"))
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    return {
      parentCtx, parentReg, roles,
      parentSession: createSession(),
      jobs: createJobRegistry(),
      table: createAgentTable(),
      agents: createAgentRegistry(),
      parentModel: createMockClient([{ role: "assistant", text: "parent" }]),
    }
  }

  it("calls the resolver with the ROLE's selection and uses its client", async () => {
    const f = spawnFixture()
    const roleClient = createMockClient([{ role: "assistant", text: "from the role's model" }])
    const calls: Array<{ provider: string; model: string }> = []
    const resolveModel = async (sel: { provider: string; model: string }) => {
      calls.push(sel)
      return {
        status: "ready" as const,
        binding: { client: roleClient, providerId: sel.provider, modelId: sel.model, label: "role" },
      }
    }

    await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: { ...f.roles.get("general")!, model: { provider: "gw", model: "small" } },
      parentModel: f.parentModel, resolveModel,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })

    expect(calls).toEqual([{ provider: "gw", model: "small" }])
  })

  it("a resolver that is not ready FAILS the spawn with the resolver's reason", async () => {
    const f = spawnFixture()
    const resolveModel = async () => ({ status: "invalid" as const, reason: 'Unknown provider "gw"' })

    await expect(spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: { ...f.roles.get("general")!, model: { provider: "gw", model: "small" } },
      parentModel: f.parentModel, resolveModel,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })).rejects.toThrow(/Unknown provider "gw"/)
  })

  it("a role with NO model never calls the resolver — it inherits the parent's client", async () => {
    const f = spawnFixture()
    let called = 0
    const resolveModel = async () => { called += 1; return { status: "unconfigured" as const, reason: "x" } }

    await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: f.roles.get("general")!,
      parentModel: f.parentModel, resolveModel,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })

    expect(called).toBe(0)
  })
})
```

Remove the now-unused `import { createProviderRegistry } from "@i-harness/provider"` at `:13`.

- [ ] **Step 2: Run it — expect RED**

Expected: FAIL — the option is still `providers`, and today's code throws `references unknown provider` from the empty registry.

- [ ] **Step 3: Implement**

In all three interfaces, replace `providers: ProviderRegistry` with:

```ts
  /** Resolve a selection to a live client through the HOST's provider plane —
   * the same one the session's own model went through, so a role gets the same
   * credentials, the same card table and the same protocol chain.
   *
   * It replaced a `ProviderRegistry` that `assembly.ts` built empty and nothing
   * ever registered into, which made `role.model` throw `references unknown
   * provider` for every value it could ever hold. */
  resolveModel(selection: { provider: string; model: string; protocol?: SettingsProviderProtocol; reasoningEffort?: string }): Promise<ModelResolutionState>
```

In `child.ts`, the resolution becomes:

```ts
  // model: the role's own selection through the host's resolver, else inherit
  // the parent's client (which is what an unconfigured harness does).
  let model = opts.parentModel
  if (opts.role.model) {
    const state = await opts.resolveModel(opts.role.model)
    if (state.status !== "ready") {
      throw new Error(`role '${opts.role.name}' cannot resolve its model: ${state.reason}`)
    }
    model = state.binding.client
  }
```

(The `spawnChild` path is already async — it awaits the coordinator.)

In `tools.ts`'s restore path (`~:553-563`), the same shape with `deps.resolveModel`.

In `assembly.ts:697-702`, drop `const providers = createProviderRegistry()` and pass the HOST's resolver — a new optional seam, shaped exactly like the existing `modelBindingFor` (`service.ts:214-224` reads it from `opts` and awaits it):

```ts
// packages/session-executor/src/service.ts — SessionServiceOptions, beside modelBindingFor
  /** Resolve a ROLE's model selection. The host supplies it from the same
   * runtime `modelBindingFor` uses, so a sub-agent's provider, credential and
   * capability card come from the one provider plane this harness has. */
  resolveRoleModel?: (selection: {
    provider: string; model: string
    protocol?: SettingsProviderProtocol; reasoningEffort?: string
  }) => Promise<ModelResolutionState>
```

```ts
// packages/session-executor/src/assembly.ts — where `providers` was built
    const subagent = registerSubagent(ctx, tools, {
      exec: execService,
      parentModel: model,
      parentSession: session,
      resolveModel: opts.resolveRoleModel ?? (async (selection) => ({
        status: "unconfigured" as const,
        reason: `no role-model resolver is configured (role asked for ${selection.provider}:${selection.model})`,
      })),
      …unchanged…
```

A missing resolver returns `unconfigured` **naming the selection**, so an embedder that forgets to wire it hears about it at the first spawn of a model-carrying role rather than silently inheriting.

And the CLI supplies it from the runtime it already holds (`apps/cli/src/index.ts:83-94` is the session's own version — put this beside it):

```ts
function roleModelResolverFor(runtime: ProviderRuntime): NonNullable<SessionServiceOptions["resolveRoleModel"]> {
  // The SAME runtime call the session's binding makes; only the selection's
  // origin differs (a role instead of the session's meta).
  return async (selection) => runtime.resolveModel({ sessionSelection: selection })
}
```
Wire it where `modelBindingFor: providerModelBindingFor(runtime)` is already passed (`apps/cli/src/index.ts:437-440` for `sdk`, `:607-610` for `acp`, and `apps/cli/src/run.ts`'s assembly).

- [ ] **Step 4: Run it — expect GREEN**

Run: `pnpm -C packages/subagent test && pnpm -C packages/session-executor test && pnpm typecheck`
Expected: PASS. The existing subagent tests are the guard — they spawn roles that carry NO model, so they must be untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/*.ts packages/session-executor/src/assembly.ts <tests>
git commit -F - <<'EOF'
fix(subagent): a role's model goes through the host's resolver, not an empty registry

`registerSubagent` was handed `createProviderRegistry()` — created at
assembly.ts:697 and never registered into by anything in the repo. So
`role.model`, the field documented as "unless the user edits them", threw
`references unknown provider` for every value it could hold, and bypassed
settings, credentials and the card table even if it had not.

It now takes the same resolver the session's own binding uses. One resolution
path, which is the whole defence against the two-path mess this is patterned on.
EOF
```

---

### Task 4: the role's selection comes from settings, and the toggle is honoured

**Files:**
- Modify: `packages/subagent/src/index.ts` (`RegisterSubagentOptions`, the tool deps), `packages/subagent/src/child.ts`, `packages/subagent/src/tools.ts` (spawn + restore)
- Modify: `packages/session-executor/src/assembly.ts` + `service.ts` (thread the two new options)
- Modify: `apps/cli/src/run.ts` + `apps/cli/src/index.ts` (read them from the settings store)
- Test: `packages/subagent/test/*`, `apps/cli/test/*`

**Interfaces:**
- Consumes: `SettingsAgents` (Task 1), `resolveModel` (Task 3), and the `plugins.subagentModel` toggle (`settings/src/index.ts:54`, default `false`).
- Produces: at spawn, the selection is `roleSelectionFor(role.name) ?? role.model`; absent both → inherit.

- [ ] **Step 1: Write the failing test**

Move Task 3's `spawnFixture()` to module scope in `packages/subagent/test/child.test.ts` and reuse it:

```ts
describe("the role's model: settings beats the role, and the toggle gates both", () => {
  const roleWith = (f: ReturnType<typeof spawnFixture>, model?: { provider: string; model: string }) => ({
    ...f.roles.get("general")!, ...(model !== undefined ? { model } : {}),
  })
  const spyResolver = () => {
    const calls: Array<{ provider: string; model: string }> = []
    return {
      calls,
      resolveModel: async (sel: { provider: string; model: string }) => {
        calls.push(sel)
        return { status: "ready" as const, binding: { client: createMockClient([]), providerId: sel.provider, modelId: sel.model, label: "role" } }
      },
    }
  }
  const spawnWith = (f: ReturnType<typeof spawnFixture>, opts: Record<string, unknown>) => spawnChild({
    taskName: "helper", message: "do the thing", parentPath: "root",
    parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
    parentModel: f.parentModel, jobs: f.jobs, table: f.table, agents: f.agents,
    ...opts,
  })

  it("toggle OFF + a role that declares a model → the spawn FAILS, naming both fixes", async () => {
    const f = spawnFixture()
    const { resolveModel } = spyResolver()

    await expect(spawnWith(f, {
      role: roleWith(f, { provider: "gw", model: "small" }),
      resolveModel, allowSubagentModelSelection: false,
    })).rejects.toThrow(/plugins\.subagentModel/)
  })

  it("toggle OFF + a role with NO model → inherit, unchanged from today", async () => {
    const f = spawnFixture()
    const { calls, resolveModel } = spyResolver()

    await spawnWith(f, { role: roleWith(f), resolveModel, allowSubagentModelSelection: false })

    expect(calls).toEqual([])
  })

  it("toggle ON → SETTINGS beat the role's own declaration", async () => {
    const f = spawnFixture()
    const { calls, resolveModel } = spyResolver()

    await spawnWith(f, {
      role: roleWith(f, { provider: "gw", model: "from-role" }),
      resolveModel, allowSubagentModelSelection: true,
      roleSelectionFor: () => ({ provider: "gw", model: "from-settings" }),
    })

    expect(calls).toEqual([{ provider: "gw", model: "from-settings" }])
  })

  it("toggle ON + no settings entry → the role's own declaration", async () => {
    const f = spawnFixture()
    const { calls, resolveModel } = spyResolver()

    await spawnWith(f, {
      role: roleWith(f, { provider: "gw", model: "from-role" }),
      resolveModel, allowSubagentModelSelection: true,
      roleSelectionFor: () => undefined,
    })

    expect(calls).toEqual([{ provider: "gw", model: "from-role" }])
  })
})
```

- [ ] **Step 2: Run it — expect RED**

- [ ] **Step 3: Implement**

The two options ride the SAME path `resolveModel` took in Task 3: on `RegisterSubagentOptions`, on `SubagentToolDeps`, and on `spawnChild`'s opts (that last one is what the test above calls). They are plain values, not live reads — the LIVE reading is the CLI's getter (below).

```ts
  /** The HOST's declared role models, read AT SPAWN TIME so a settings edit
   * applies to the next spawn without restarting the session. */
  roleSelectionFor?: (roleName: string) => SettingsRoleModel | undefined
  /** `plugins.subagentModel`. Default false = today's behaviour exactly: every
   * role inherits the parent's client. */
  allowSubagentModelSelection?: boolean
```

In the spawn path (`tools.ts`, both the fresh and the restore arm), before building the child:

```ts
    const declared = deps.roleSelectionFor?.(role.name) ?? role.model
    if (declared !== undefined && deps.allowSubagentModelSelection !== true) {
      // NOT a silent fallback to the parent's model: a role that names a model
      // and quietly runs on another one is the wrong answer stated as a right
      // one, and the fix is one line either way.
      throw new Error(
        `role "${role.name}" declares a model, but sub-agent model selection is disabled: ` +
        `set plugins.subagentModel=true in settings, or clear it with \`i-harness roles unset ${role.name}\``,
      )
    }
```

and pass `modelSelection: declared` down into `spawnChild`, which resolves it with `opts.resolveModel` (Task 3).

`apps/cli/src/run.ts`: it already loads the settings store (`main()` does, for sandbox/compaction). Build the two options there and thread them through `HeadlessOptions` → the assembly:

```ts
    roleSelectionFor: (roleName) => settings.get().agents.roles[roleName],
    allowSubagentModelSelection: settings.get().plugins.subagentModel,
```

**Read them from the STORE, not a snapshot** — the getter is what makes §3's "a settings edit applies to the next spawn" true.

- [ ] **Step 4: Run it — expect GREEN**

Run: `pnpm -C packages/subagent test && pnpm -C apps/cli test && pnpm typecheck`
Expected: PASS. `plugins.subagentModel` defaults to false, so every existing test that spawns a role with no model is byte-identical.

- [ ] **Step 5: Mutation proof**

Change the toggle check from `!== true` to `=== false` (i.e. treat `undefined` as enabled) and run.
Expected: the toggle-off case reddens. Restore.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -F - <<'EOF'
feat(subagent): a role's model comes from agents.roles, behind plugins.subagentModel

`plugins.subagentModel` has been in the settings schema since M14 with no reader
anywhere — an `unconsulted-setting` row the audit baseline already records. It
gates exactly this: whether a role may name its own model. Default false, so
nothing changes until someone asks.

With it OFF and a role declaring a model, the spawn FAILS rather than quietly
running on the parent's model — with a message naming both fixes.
EOF
```

---

### Task 5: `i-harness roles`

**Files:**
- Create: `apps/cli/src/roles.ts`
- Modify: `apps/cli/src/index.ts` (dispatch + `USAGE`), `apps/cli/test/bin.test.ts` (the pinned usage line)
- Test: `apps/cli/test/roles-command.test.ts`

**Interfaces:**
- Consumes: `SettingsAgents` (Task 1), the four built-in role names (`packages/subagent/src/roles.ts` — `general`/`explore`/`research`/`worker`).
- Produces: `parseRolesArgs`, `renderRoles`, `runRolesCommand`.

- [ ] **Step 1: Write the failing test**

Follow `apps/cli/test/models-command.test.ts` exactly (temp `IH_CONFIG_DIR`, real `SettingsStore`, assert the persisted JSON). Cases:
- `roles set general --provider gw --model small` → settings has `agents.roles.general = { provider: "gw", model: "small" }`, exit 0
- `roles set general --provider gw` (no `--model`) → exit 1, **settings unchanged**
- `roles set nosuchrole --provider gw --model m` → exit 1, naming the four known roles
- `roles unset general` → the entry is gone
- `roles list` → names each role and says **declared** or **inherited**
- `roles set general --provider gw --model m --protocol grpc` → exit 1

- [ ] **Step 2: Run it — expect RED**

Run: `pnpm -C apps/cli test roles-command`
Expected: FAIL — cannot resolve `../src/roles.ts`.

- [ ] **Step 3: Implement `apps/cli/src/roles.ts`**

Same shape as `apps/cli/src/provider.ts` (parse → render → run, each piece pure): `ROLES_USAGE`; `parseRolesArgs` validating the five protocols via `PROVIDER_PROTOCOLS` imported from `./provider.ts` (**do not declare a second copy** — Task 6 of the lifecycle plan established one home); `runRolesCommand` loading `loadProviderRuntime().settings` and writing through `settings.set({ agents })`.

**`roles set` REPLACES the whole entry** — an omitted `--protocol` clears it. Say so in the usage text; the alternative (per-field merge) is what the spec rejected, because the unit here is "which model this role runs on".

- [ ] **Step 4: Wire the dispatch + usage**

In `apps/cli/src/index.ts`, beside the `models` branch, and extend `USAGE`:
```ts
  "  provider <list|add|set|key|rm> | models <…> | roles <list|set|unset>"
```
Then update the pinned assertion in `apps/cli/test/bin.test.ts` to include `roles`.

- [ ] **Step 5: Run it — expect GREEN + gate**

Run: `pnpm -C apps/cli test && pnpm typecheck && node scripts/audit/check-reachability.mjs --gate`

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/roles.ts apps/cli/src/index.ts apps/cli/test/roles-command.test.ts apps/cli/test/bin.test.ts
git commit -F - <<'EOF'
feat(cli): i-harness roles — which model each role runs on
EOF
```

---

### Task 6: show the model a role ACTUALLY ran on

**Files:**
- Modify: `packages/subagent/src/agent-table.ts` (the entry type), `packages/subagent/src/child.ts` (record it at spawn), `packages/subagent/src/persist.ts` (round-trip it), `packages/subagent/src/projection.ts:163`
- Test: `packages/subagent/test/projection.test.ts` + `packages/subagent/test/child.test.ts`

**Interfaces:**
- Consumes: the resolved selection from Task 4.
- Produces: `AgentEntry.modelLabel?: string` — `"provider:model"` when the role resolved one, **absent when it inherited**.

**The design point, and why it differs from the obvious one:** the row must print the model the role **actually ran on**, not re-derive today's precedence. Re-deriving needs `roleSelectionFor` plumbed into `SubagentTaskSource` (it is not there), and — worse — it would print what the settings say NOW, which for a running child is not what it is running on. **Record the fact at spawn; read the record.** That also removes the second implementation of the precedence that the previous draft of this task asked for.

- [ ] **Step 1: Write the failing test**

In `packages/subagent/test/projection.test.ts` (find its existing row fixture):

```ts
it("shows the model the role RESOLVED — and says so when it inherited instead", () => {
  const withModel = projectAgentTaskDetail({
    ...fixtureState,
    table: tableWithEntry({ path: "root/helper", roleName: "general", modelLabel: "gw:small" }),
  }, row)
  expect(withModel?.model).toBe("gw:small")

  const inherited = projectAgentTaskDetail({
    ...fixtureState,
    table: tableWithEntry({ path: "root/helper", roleName: "general" }),   // no modelLabel
  }, row)
  expect(inherited?.model).toBe("inherited from the session")
})
```

And in `packages/subagent/test/child.test.ts`, extend Task 3's resolver case:

```ts
    // the spawn RECORDS what it resolved, so a later read cannot disagree with it
    expect(f.table.get("root/helper")?.modelLabel).toBe("gw:small")
```

- [ ] **Step 2: Run it — expect RED**

Expected: `modelLabel` is `undefined` on the entry and `detail.model` is absent (the current line reads `role.model`, which is never set).

- [ ] **Step 3: Implement**

`agent-table.ts` — add to the entry interface:

```ts
  /** The model this child actually ran on, as `provider:model`, RECORDED at
   * spawn. Absent = it inherited the parent's client. Never re-derived at read
   * time: a running child's settings can change under it, and the row must say
   * what IS, not what today's configuration would say. */
  modelLabel?: string
```

`child.ts` — after resolving (`model = state.binding.client`), set it on the entry: `modelLabel: \`${selection.provider}:${selection.model}\``. The inherit arm sets nothing.

`persist.ts` — carry it through `snapshotState` (:81-84) and `restoreState` (:123), beside `mailbox`, so a restored entry still says what it ran on.

`projection.ts:163`:
```ts
        ...(entry?.modelLabel !== undefined
          ? { model: entry.modelLabel }
          : role?.model !== undefined
            ? { model: `${role.model.provider}:${role.model.model}` }
            : { model: "inherited from the session" }),
```
(The middle arm keeps a role's DECLARED model visible for a child that was spawned before this task recorded labels — decide whether to keep it once you see the existing tests; if nothing depends on it, one arm is better than two.)

- [ ] **Step 4: Run it — expect GREEN**

Run: `pnpm -C packages/subagent test && pnpm -r --no-bail test && pnpm typecheck && node scripts/audit/check-reachability.mjs --gate`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -F - <<'EOF'
feat(subagent): the job row says which model the child actually ran on

Recorded at spawn, not re-derived at read: the settings can change under a
running child, and the row must say what IS. It also means the display cannot
disagree with the spawn — there is one fact, written once.
EOF
```

---

## Self-Review

**Spec coverage:**
- §1 (unset → inherit; set → use it) → Tasks 3 (inherit path untouched) and 4.
- §2 (`agents.roles` shape; provider+model together; set replaces; unknown role refused) → Task 1 (data + the half-entry drop), Task 5 (the CLI rules).
- §3 (resolution at SPAWN; the same chain) → Task 4 (the `roleSelectionFor` getter, read at spawn) + Task 2 (the chain's top arm) + Task 3 (the resolver).
- §4 (settings beat the session snapshot; why) → Task 4's precedence expression.
- §5 (the plugin boundary untouched) → nothing in this plan touches `toSubagentRoles`; the build must not either.
- §6 (three consumers, two dead) → Task 3 (spawn + restore) and Task 6 (projection).
- §7 (failure message) → Task 4's toggle branch and Task 3's non-ready branch.
- §8 (interfaces) → Task 5.
- §9 (tests) → each task carries its own; the two mutation proofs are Task 1's and Task 2's, plus Task 4's toggle mutation.
- §11 (out of scope: user-defined roles, role tools/prompts, the plugin model door, an in-session editor) → NOT implemented, by design.

**Not covered, deliberately:** the `plugins.subagentModel` gate is a decision this plan makes that the spec does not mention — the spec was written before the toggle's existence was discovered. The plan uses it (default false = today's behaviour exactly) rather than deleting a declared setting or shipping an always-on feature.

**Placeholder scan:** clean. Tasks 3 and 4's tests were first written as assertion lists; they are now real code built on `child.test.ts`'s existing `spawnChild` fixture, read from the repo at `packages/subagent/test/child.test.ts:31-65`. Every implementation step carries code or an exact existing location to mirror.

**Type consistency:** `SettingsRoleModel` (Task 1) is the type threaded through Tasks 3, 4, 5, 6; the resolver's parameter is the same shape minus the name (`{ provider, model, protocol?, reasoningEffort? }`) so a `SettingsRoleModel` is assignable to it. `SettingsProviderProtocol` is the protocol type everywhere.
