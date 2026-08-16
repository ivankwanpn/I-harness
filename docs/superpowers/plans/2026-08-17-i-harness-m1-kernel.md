# I-harness M1 Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the M1 kernel of the I-harness agent runtime — a pnpm monorepo with a self-developed plugin kernel, session event log, tool system, pure event-driven agent loop, LLM seam with mock, interaction seam family, preset mount, and a headless CLI that runs a "read → edit → report" task driven by a mock LLM.

**Architecture:** Pure event-driven (Scheme A). `core-plugin` provides four primitives (PluginContext/service/scope/lifecycle) plus waterfall events (`next()` semantics) and monotonic deny-only guards. `core-agent` runs the agent loop entirely through these events. `core-session` is an append-only versioned JSONL event log; `deriveMessages()` derives model history (invariant: model-visible ⟺ logged, enforced at the LLM seam). `core-tools` registers tools into scoped layers with the audited guard-bypass fix. `llm-mock` drives the loop with pre-recorded response sequences. `interaction` is a pure-interface seam family (approval/questions/commands, fail-closed). `preset` mounts per-agent configuration. `apps/cli` implements the interaction answerers and runs the acceptance task.

**Tech Stack:** pnpm workspaces, TypeScript strict, vitest, Node ≥22 (installed v24). No Bun. No runtime framework deps. tsdown deferred to M2.

## Global Constraints

- Repo: `D:\agent-complete\I-harness`. Currently an npm single-package (node:test, src/, test/). Task 1 converts it to pnpm workspace root.
- `pnpm` is the package manager. `pnpm-lock.yaml` replaces `package-lock.json`; remove `package-lock.json`.
- `"type": "module"` (ESM). `import`/`export` only — no `require`.
- TypeScript strict (`strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noEmit`, `module: ESNext`, `moduleResolution: bundler`, `target: ESNext`, `allowImportingTsExtensions` for source imports).
- Node built-in test runner is REPLACED by vitest (dsh-style). The existing `node:test` test in `test/` is migrated to vitest or removed in Task 1.
- Every package has its own `package.json` with `name: @i-harness/<name>`, `private: true`, `"type": "module"`, `exports` pointing at `src/index.ts`.
- Workspace deps reference `workspace:*`.
- `engines.node: >=22`.
- No `bootstrap`, no `tool-bootstrap`, no `guard-tool-bootstrap` — first model request exposes the full catalog.
- No OS-level sandbox, no SQLite backend, no real LLM providers, no tsdown, no interaction-cli separate package in M1.
- Audit-driven regression tests are REQUIRED for: F02-1 (forgotten `next()` = error, not silent veto), F03-1 (malformed pre-execute decision → tool not executed; guards run unconditionally), F01-3 (non-log message rejected at LLM seam), F01-1 (formatVersion bump = migrate-on-continue), F02-4 (disposer timeout), F03-5 (same-layer duplicate tool name throws).
- All test runs use vitest. `tsc --noEmit` must pass at each package.
- Commit style: `feat:`, `chore:`, `test:`, `docs:` prefixes.

---

### Task 1: Convert to pnpm monorepo

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Modify: `package.json` (root → `@i-harness/root`)
- Modify: `.gitignore` (add `node_modules/` already present; no `*.tsbuildinfo` needed since noEmit)
- Delete: `package-lock.json`
- Create: `packages/core-plugin/package.json`, `tsconfig.json`, `src/index.ts` (empty placeholder), `test/plugin.test.ts`
- Create: `apps/cli/package.json`, `tsconfig.json`, `src/index.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the workspace skeleton; `pnpm` commands work; package layout for all later tasks. Placeholder `core-plugin` and `apps/cli` packages that later tasks fill in.

- [ ] **Step 1: Write the workspace config files**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

Rewrite root `package.json`:

```json
{
  "name": "@i-harness/root",
  "private": true,
  "version": "0.1.0",
  "description": "I-harness agent runtime monorepo",
  "type": "module",
  "license": "MIT",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

Add `"types": ["node"]` requires `@types/node` — add it to root devDependencies too:

```json
    "typescript": "^5.9.0",
    "vitest": "^3.2.0",
    "@types/node": "^24.0.0"
```

- [ ] **Step 2: Create the placeholder packages**

`packages/core-plugin/package.json`:

```json
{
  "name": "@i-harness/core-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/core-plugin/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`packages/core-plugin/src/index.ts`:

```ts
export const corePluginVersion = "0.1.0"
```

`packages/core-plugin/test/plugin.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { corePluginVersion } from "../src/index.ts"

describe("core-plugin", () => {
  it("exports a version", () => {
    expect(corePluginVersion).toBe("0.1.0")
  })
})
```

`apps/cli/package.json`:

```json
{
  "name": "@i-harness/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`apps/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`apps/cli/src/index.ts`:

```ts
export function hello(name: string): string {
  return `hello, ${name}`
}
```

`apps/cli/test/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { hello } from "../src/index.ts"

describe("cli", () => {
  it("greets", () => {
    expect(hello("world")).toBe("hello, world")
  })
})
```

- [ ] **Step 3: Migrate the old template files**

The old root `src/index.ts` and `test/index.test.ts` (hello module) are superseded by `apps/cli/src/index.ts`. DELETE `src/` and `test/` at the repo root (their content moved into `apps/cli`). Update root `.gitignore`:

```
node_modules/
```

- [ ] **Step 4: Remove old lockfile and install**

```bash
rm -f package-lock.json
pnpm install
```

Expected: `pnpm-lock.yaml` created; `pnpm install` clean.

- [ ] **Step 5: Run typecheck and tests**

```bash
pnpm typecheck
pnpm test
```

Expected: both pass (root typecheck runs `pnpm -r typecheck` → both placeholder packages pass; tests: core-plugin 1 pass, cli 1 pass).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: convert to pnpm monorepo workspace"
```

---

### Task 2: core-plugin — four primitives

**Files:**
- Modify: `packages/core-plugin/src/index.ts`
- Modify: `packages/core-plugin/test/plugin.test.ts`

**Interfaces:**
- Consumes: Task 1 workspace skeleton.
- Produces: `PluginContext` type, `createContext()` factory, `ctx.on/emit/services.register/services.get/scope/mount/unmount`. Later tasks (core-session, core-tools, core-agent, interaction, preset) consume these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core-plugin/test/plugin.test.ts`:

```ts
import { createContext } from "../src/index.ts"
import type { Plugin } from "../src/index.ts"

describe("four primitives", () => {
  it("registers and resolves a service", () => {
    const ctx = createContext()
    const svc = { value: 1 }
    ctx.services.register("svc", svc)
    expect(ctx.services.get<{ value: number }>("svc")).toBe(svc)
  })

  it("mounts and unmounts a plugin, reclaiming listeners", () => {
    const ctx = createContext()
    const calls: number[] = []
    const plugin: Plugin = {
      name: "p",
      mount(c) {
        c.on("ev", () => calls.push(1))
      },
    }
    ctx.mount(plugin)
    ctx.emit("ev", {})
    expect(calls).toEqual([1])
    ctx.unmount(plugin.name)
    ctx.emit("ev", {})
    expect(calls).toEqual([1]) // no second call — listener reclaimed
  })

  it("shadows service in child scope, restores on unmount", () => {
    const ctx = createContext()
    ctx.services.register("svc", { value: 1 })
    const child = ctx.scope.mount()
    child.services.register("svc", { value: 2 })
    expect(child.services.get<{ value: number }>("svc").value).toBe(2)
    expect(ctx.services.get<{ value: number }>("svc").value).toBe(1)
    child.scope.unmount()
    const child2 = ctx.scope.mount()
    expect(child2.services.get<{ value: number }>("svc").value).toBe(1)
  })

  it("throws on same-layer duplicate service name", () => {
    const ctx = createContext()
    ctx.services.register("dup", { a: 1 })
    expect(() => ctx.services.register("dup", { a: 2 })).toThrow(/duplicate/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/core-plugin test`
Expected: FAIL — `createContext` / `Plugin` not exported.

- [ ] **Step 3: Write the minimal implementation**

Replace `packages/core-plugin/src/index.ts` with:

```ts
export type Listener = (payload: unknown, next: (payload: unknown) => unknown | Promise<unknown>) => unknown | Promise<unknown>

export interface PluginContext {
  services: {
    register(name: string, impl: unknown): void
    get<T>(name: string): T
  }
  scope: {
    mount(): PluginContext
    unmount(): void
  }
  on(event: string, handler: (payload: unknown) => unknown): void
  emit(event: string, payload: unknown): void
  mount(plugin: Plugin): void
  unmount(name: string): void
}

export interface Plugin {
  name: string
  mount(ctx: PluginContext): void
  unmount?(ctx: PluginContext): void
}

interface ServiceEntry {
  impl: unknown
  parent: Map<string, ServiceEntry> | null
}

function makeServices(parent: Map<string, ServiceEntry> | null) {
  const store = new Map<string, ServiceEntry>()
  return {
    register(name: string, impl: unknown): void {
      if (store.has(name)) throw new Error(`duplicate service registration: ${name}`)
      store.set(name, { impl, parent })
    },
    get<T>(name: string): T {
      let cur: Map<string, ServiceEntry> | null = store
      while (cur) {
        const entry = cur.get(name)
        if (entry) return entry.impl as T
        // parent chain handled at scope level; service entries keep a reference
        cur = (entry as { parent?: Map<string, ServiceEntry> | null } | undefined)?.parent ?? null
      }
      return undefined as T
    },
  }
}
```

Hmm — the scope shadow needs a cleaner parent chain. Replace with this correct implementation:

```ts
interface Scope {
  services: {
    register(name: string, impl: unknown): void
    get<T>(name: string): T
  }
  scope: {
    mount(): Scope
    unmount(): void
  }
  on(event: string, handler: (payload: unknown) => unknown): void
  emit(event: string, payload: unknown): void
  mount(plugin: Plugin): void
  unmount(name: string): void
}

type ServiceStore = Map<string, unknown>

function createScope(parentStore: ServiceStore | null, parentEmit: (event: string, payload: unknown) => void): Scope {
  const store: ServiceStore = new Map()
  const listeners = new Map<string, Array<(payload: unknown) => unknown>>()
  const scopes = new Set<Scope>()
  const plugins = new Map<string, Plugin>()

  function emitHere(event: string, payload: unknown): void {
    for (const handler of listeners.get(event) ?? []) handler(payload)
    parentEmit(event, payload)
  }

  const ctx: Scope = {
    services: {
      register(name: string, impl: unknown): void {
        if (store.has(name)) throw new Error(`duplicate service registration: ${name}`)
        store.set(name, impl)
      },
      get<T>(name: string): T {
        if (store.has(name)) return store.get(name) as T
        if (parentStore?.has(name)) return parentStore.get(name) as T
        throw new Error(`service not found: ${name}`)
      },
    },
    scope: {
      mount(): Scope {
        const child = createScope(store, emitHere)
        scopes.add(child)
        return child
      },
      unmount(): void {
        scopes.delete(ctx)
      },
    },
    on(event: string, handler: (payload: unknown) => unknown): void {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    emit(event: string, payload: unknown): void {
      emitHere(event, payload)
    },
    mount(plugin: Plugin): void {
      plugins.set(plugin.name, plugin)
      plugin.mount(ctx)
    },
    unmount(name: string): void {
      const plugin = plugins.get(name)
      if (!plugin) return
      plugin.unmount?.(ctx)
      plugins.delete(name)
    },
  }
  return ctx
}

export function createContext(): Scope {
  return createScope(null, () => {})
}

export type PluginContext = Scope
export type { Plugin }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/core-plugin test`
Expected: PASS (4 new tests + 1 version test).

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @i-harness/core-plugin typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-plugin/
git commit -m "feat: core-plugin four primitives (services/scope/events/lifecycle)"
```

---

### Task 3: core-plugin — waterfall events + monotonic guard

**Files:**
- Modify: `packages/core-plugin/src/index.ts`
- Modify: `packages/core-plugin/test/plugin.test.ts`

**Interfaces:**
- Consumes: Task 2 `createContext()` / `PluginContext`.
- Produces: `ctx.waterfall(event, payload, handler)` (returns after all handlers run, each receives `next`), `ctx.guard(event, fn)` (deny-only). core-session and core-agent consume these.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core-plugin/test/plugin.test.ts`:

```ts
describe("waterfall", () => {
  it("runs handlers in order, each mutating payload, releasing via next", async () => {
    const ctx = createContext()
    const seen: string[] = []
    ctx.on("wf", async (payload: unknown, next) => {
      seen.push(`a:${(payload as { v: number }).v}`)
      const nextPayload = (await next(payload)) as { v: number }
      ;(nextPayload as { v: number }).v += 1
      seen.push(`a2:${nextPayload.v}`)
    })
    ctx.on("wf", async (payload: unknown) => {
      seen.push(`b:${(payload as { v: number }).v}`)
      ;(payload as { v: number }).v += 10
    })
    await ctx.emit("wf", { v: 1 })
    expect(seen).toEqual(["a:1", "b:1", "a2:11"])
  })

  it("treats a handler that forgets next() as an error, not a silent veto", async () => {
    const ctx = createContext()
    let err: unknown
    ctx.on("wf2", async (_p: unknown, next) => {
      // forget to call next()
    })
    ctx.on("wf2", async (p: unknown) => {
      void p
    })
    try {
      await ctx.emit("wf2", {})
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
  })
})

describe("monotonic guard", () => {
  it("is deny-only and order-independent", () => {
    const ctx = createContext()
    const denials: string[] = []
    ctx.guard("g", (exec) => {
      if ((exec as { cmd: string }).cmd === "rm") return "denied: rm"
      return undefined
    })
    ctx.guard("g", (exec) => {
      void exec
      return undefined // cannot re-allow
    })
    // First deny wins; a second guard cannot turn it back.
    expect(ctx.checkGuards("g", { cmd: "rm" })).toBe("denied: rm")
    expect(ctx.checkGuards("g", { cmd: "ls" })).toBeUndefined()
  })

  it("runs guards unconditionally even for non-allow decisions", () => {
    const ctx = createContext()
    let guardRan = false
    ctx.guard("g2", () => {
      guardRan = true
      return undefined
    })
    // pre-execute returns a non-vocabulary object; guards must still run
    ctx.checkGuards("g2", {})
    expect(guardRan).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/core-plugin test`
Expected: FAIL — `ctx.waterfall` / `ctx.guard` / `ctx.checkGuards` not found, `ctx.emit` not returning a Promise.

- [ ] **Step 3: Write the minimal implementation**

The waterfall needs `emit` to be async and `next()` to be provided to handlers. Update the `Scope` interface and `createScope`. Replace `ctx.on`/`ctx.emit` and add `waterfall`/`guard`/`checkGuards`:

```ts
type WaterfallHandler = (payload: unknown, next: (payload: unknown) => unknown | Promise<unknown>) => unknown | Promise<unknown>
type GuardFn = (exec: unknown) => string | undefined

function createScope(parentStore: ServiceStore | null, parentEmit: (event: string, payload: unknown) => void): Scope {
  const store: ServiceStore = new Map()
  const listeners = new Map<string, Array<(payload: unknown) => unknown>>()
  const waterfalls = new Map<string, Array<WaterfallHandler>>()
  const guards = new Map<string, Array<GuardFn>>()
  const scopes = new Set<Scope>()
  const plugins = new Map<string, Plugin>()

  function emitHere(event: string, payload: unknown): void {
    for (const handler of listeners.get(event) ?? []) handler(payload)
    parentEmit(event, payload)
  }

  async function runWaterfall(event: string, payload: unknown): Promise<unknown> {
    const handlers = [...(waterfalls.get(event) ?? [])] // re-snapshot per dispatch
    let current = payload
    let index = 0
    let nextCalled = false
    const next = (p: unknown) => {
      nextCalled = true
      current = p
      return runNext(index + 1, current)
    }
    async function runNext(i: number, p: unknown): Promise<unknown> {
      if (i >= handlers.length) return p
      nextCalled = false
      const result = await handlers[i]!(p, next)
      if (!nextCalled) {
        throw new Error(`waterfall handler ${i} for '${event}' forgot next()`)
      }
      return result
    }
    await runNext(0, current)
    return current
  }

  const ctx: Scope = {
    services: { /* unchanged from Task 2 */ },
    scope: { /* unchanged */ },
    on(event, handler) { /* unchanged */ },
    async emit(event: string, payload: unknown): Promise<void> {
      const isWaterfall = waterfalls.has(event) || parentHasWaterfall(event, ctx)
      if (isWaterfall) {
        await runWaterfall(event, payload)
      } else {
        emitHere(event, payload)
      }
      // parent emit after local processing
      await parentEmitAsync(event, payload)
    },
    waterfall(event, handler) {
      const list = waterfalls.get(event) ?? []
      list.push(handler)
      waterfalls.set(event, list)
    },
    guard(event, fn) {
      const list = guards.get(event) ?? []
      list.push(fn)
      guards.set(event, list)
    },
    checkGuards(event, exec): string | undefined {
      for (const fn of guards.get(event) ?? []) {
        const reason = fn(exec)
        if (reason !== undefined) return reason // first deny wins
      }
      return undefined
    },
    mount(plugin) { /* unchanged */ },
    unmount(name) { /* unchanged */ },
  }
  return ctx
}
```

To keep this self-contained and avoid parent-waterfall plumbing complexity, this plan defines the waterfall and guard at the ROOT scope only (the kernel's single event bus). Child scopes inherit via `parentStore` for services; waterfall/guard registration happens on the root context. Tests use the root context directly. The `emit` signature becomes `Promise<void>`.

Final `index.ts`:

```ts
export type Listener = (payload: unknown) => unknown
export type WaterfallHandler = (payload: unknown, next: (payload: unknown) => unknown | Promise<unknown>) => unknown | Promise<unknown>
export type GuardFn = (exec: unknown) => string | undefined

export interface Plugin {
  name: string
  mount(ctx: PluginContext): void
  unmount?(ctx: PluginContext): void
}

export interface PluginContext {
  services: {
    register(name: string, impl: unknown): void
    get<T>(name: string): T
  }
  scope: {
    mount(): PluginContext
    unmount(): void
  }
  on(event: string, handler: Listener): void
  emit(event: string, payload: unknown): Promise<void>
  waterfall(event: string, handler: WaterfallHandler): void
  guard(event: string, fn: GuardFn): void
  checkGuards(event: string, exec: unknown): string | undefined
  mount(plugin: Plugin): void
  unmount(name: string): void
}

export function createContext(): PluginContext {
  const store = new Map<string, unknown>()
  const listeners = new Map<string, Listener[]>()
  const waterfalls = new Map<string, WaterfallHandler[]>()
  const guards = new Map<string, GuardFn[]>()
  const plugins = new Map<string, Plugin>()

  async function runWaterfall(event: string, payload: unknown): Promise<unknown> {
    const handlers = [...(waterfalls.get(event) ?? [])]
    let index = 0
    const next = (p: unknown) => runNext(index + 1, p)
    async function runNext(i: number, p: unknown): Promise<unknown> {
      if (i >= handlers.length) return p
      let nextCalled = false
      const localNext = (pp: unknown) => {
        nextCalled = true
        return runNext(i + 1, pp)
      }
      const result = await handlers[i]!(p, localNext)
      if (!nextCalled) throw new Error(`waterfall handler ${i} for '${event}' forgot next()`)
      return result
    }
    await runNext(0, payload)
  }

  const ctx: PluginContext = {
    services: {
      register(name, impl) {
        if (store.has(name)) throw new Error(`duplicate service registration: ${name}`)
        store.set(name, impl)
      },
      get<T>(name) {
        if (store.has(name)) return store.get(name) as T
        throw new Error(`service not found: ${name}`)
      },
    },
    scope: {
      mount() {
        // M1: child scopes share the root service store's parent map — simplified:
        // child scope shadows root services by name.
        const childStore = new Map<string, unknown>()
        const child: PluginContext = {
          ...ctx,
          services: {
            register(name, impl) {
              if (childStore.has(name)) throw new Error(`duplicate service registration: ${name}`)
              childStore.set(name, impl)
            },
            get<T>(name) {
              if (childStore.has(name)) return childStore.get(name) as T
              return ctx.services.get<T>(name)
            },
          },
          scope: {
            mount: ctx.scope.mount,
            unmount() {
              childStore.clear()
            },
          },
        }
        return child
      },
      unmount() {},
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    async emit(event, payload) {
      const isWaterfall = waterfalls.has(event)
      if (isWaterfall) {
        await runWaterfall(event, payload)
      } else {
        for (const handler of listeners.get(event) ?? []) handler(payload)
      }
    },
    waterfall(event, handler) {
      const list = waterfalls.get(event) ?? []
      list.push(handler)
      waterfalls.set(event, list)
    },
    guard(event, fn) {
      const list = guards.get(event) ?? []
      list.push(fn)
      guards.set(event, list)
    },
    checkGuards(event, exec) {
      for (const fn of guards.get(event) ?? []) {
        const reason = fn(exec)
        if (reason !== undefined) return reason
      }
      return undefined
    },
    mount(plugin) {
      plugins.set(plugin.name, plugin)
      plugin.mount(ctx)
    },
    unmount(name) {
      const plugin = plugins.get(name)
      if (!plugin) return
      plugin.unmount?.(ctx)
      plugins.delete(name)
    },
  }
  return ctx
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/core-plugin test`
Expected: PASS (all primitive + waterfall + guard tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @i-harness/core-plugin typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-plugin/
git commit -m "feat: core-plugin waterfall events and monotonic guard"
```

---

### Task 4: core-plugin — lifecycle disposer timeout (audit F02-4)

**Files:**
- Modify: `packages/core-plugin/src/index.ts`
- Modify: `packages/core-plugin/test/plugin.test.ts`

**Interfaces:**
- Consumes: Tasks 2-3.
- Produces: `Plugin.unmount` may return a Promise; `ctx.unmount(name)` awaits it with a 5s timeout; on timeout logs an error and completes anyway. No teardown hangs.

- [ ] **Step 1: Write the failing test**

Append to `packages/core-plugin/test/plugin.test.ts`:

```ts
import { setTimeout as sleep } from "node:timers/promises"

describe("lifecycle", () => {
  it("times out a never-settling unmount disposer instead of hanging", async () => {
    const ctx = createContext()
    const plugin: Plugin = {
      name: "hang",
      mount() {},
      async unmount() {
        await sleep(10_000) // never settles within timeout
      },
    }
    ctx.mount(plugin)
    // Should resolve (via timeout), not hang
    await ctx.unmount("hang")
    // After timeout, plugin is removed
    expect(ctx.services.get).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/core-plugin test`
Expected: FAIL — `ctx.unmount` is synchronous and does not return a Promise; the test's `await ctx.unmount` resolves immediately, but with the timeout the test still passes trivially (need to assert the plugin is actually removed after timeout). Adjust the test to assert removal.

Revised test:

```ts
  it("times out a never-settling unmount disposer and removes the plugin", async () => {
    const ctx = createContext()
    let removed = false
    const plugin: Plugin = {
      name: "hang",
      mount() {},
      async unmount() {
        await sleep(10_000)
        removed = true
      },
    }
    ctx.mount(plugin)
    await ctx.unmount("hang")
    expect(removed).toBe(false) // disposer timed out, not settled
  })
```

- [ ] **Step 3: Implement the timeout**

Change `ctx.unmount` to async with a 5s timeout:

```ts
    async unmount(name: string): Promise<void> {
      const plugin = plugins.get(name)
      if (!plugin) return
      const maybePromise = plugin.unmount?.(ctx)
      if (maybePromise instanceof Promise) {
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000))
        await Promise.race([maybePromise, timeout])
        if (await Promise.race([maybePromise.then(() => false), timeout.then(() => true)])) {
          console.error(`[core-plugin] unmount disposer for '${name}' timed out after 5s`)
        }
      }
      plugins.delete(name)
    },
```

Simplify to avoid double-race: just race the disposer against a timer and log on timeout:

```ts
    async unmount(name: string): Promise<void> {
      const plugin = plugins.get(name)
      if (!plugin) return
      const disposer = plugin.unmount?.(ctx)
      if (disposer) {
        let timedOut = false
        const timeout = new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true
            resolve()
          }, 5_000)
        })
        await Promise.race([Promise.resolve(disposer), timeout])
        if (timedOut) {
          console.error(`[core-plugin] unmount disposer for '${name}' timed out after 5s`)
        }
      }
      plugins.delete(name)
    },
```

Also update `Plugin` interface: `unmount?(ctx: PluginContext): void | Promise<void>`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/core-plugin test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @i-harness/core-plugin typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-plugin/
git commit -m "feat: core-plugin disposer timeout (audit F02-4)"
```

---

### Task 5: core-session — event log, deriveMessages, versioned JSONL

**Files:**
- Create: `packages/core-session/package.json`, `tsconfig.json`
- Create: `packages/core-session/src/index.ts`
- Create: `packages/core-session/test/session.test.ts`

**Interfaces:**
- Consumes: `core-plugin` events (Task 2-4) as the event bus the session log listens on.
- Produces:
  - `type SessionEvent` union (see below).
  - `type Session = { events: SessionEvent[]; formatVersion: number }`.
  - `createSession(): Session`.
  - `append(session, event): void` — validates + appends, assigns seq.
  - `deriveMessages(session): LLMMessage[]` — user/assistant messages (+ merged chunks).
  - `toJSONL(session): string` / `fromJSONL(text): Session` — versioned JSONL with `formatVersion` header.
  - `migrate(session, targetVersion): Session` — migrate-on-continue (v1 only in M1, so a no-op that refuses unknown).
  - `assertVersion(session, expected)` — refuses unknown/higher before structural decode.

core-agent (Task 9) and llm-seam (Task 7) consume these.

- [ ] **Step 1: Write the failing tests**

Create `packages/core-session/test/session.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, toJSONL, fromJSONL, assertVersion } from "../src/index.ts"
import type { SessionEvent } from "../src/index.ts"

describe("session log", () => {
  it("appends events in order with seq", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "assistant/message", text: "hello" })
    expect(s.events.length).toBe(2)
    expect(s.events[0]!.seq).toBe(0)
    expect(s.events[1]!.seq).toBe(1)
  })

  it("derives model messages from the log only", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "tool/call", name: "read", args: {} })
    append(s, { type: "assistant/chunk", text: "hel" })
    append(s, { type: "assistant/chunk", text: "lo" })
    append(s, { type: "assistant/message", text: "done" })
    const msgs = deriveMessages(s)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(msgs[1]!.content).toBe("done")
  })

  it("round-trips JSONL with formatVersion", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "x" })
    const text = toJSONL(s)
    const s2 = fromJSONL(text)
    expect(s2.formatVersion).toBe(1)
    expect(s2.events.length).toBe(1)
  })

  it("refuses unknown format version before decode", () => {
    const bad = JSON.stringify({ formatVersion: 99, events: [] })
    expect(() => fromJSONL(bad)).toThrow(/version/i)
  })

  it("migrate-on-continue upgrades v1 (no-op in M1) and refuses higher", () => {
    const s = createSession()
    expect(assertVersion(s, 1)).toBe(1)
    expect(() => assertVersion(s, 2)).toThrow(/version/i)
  })
})

describe("append validation", () => {
  it("rejects a non-log-source message at the seam (audit F01-3)", () => {
    const s = createSession()
    // model-visible ⟺ logged: every model message must come from the log
    expect(() => append(s, { type: "assistant/message", text: "external", source: "non-log" } as SessionEvent)).toThrow(/log/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/core-session test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/core-session/package.json` (same shape as core-plugin, name `@i-harness/core-session`).

Create `packages/core-session/src/index.ts`:

```ts
export type SessionEvent =
  | { type: "turn/start"; seq?: number }
  | { type: "step/start"; seq?: number }
  | { type: "user/message"; text: string; seq?: number }
  | { type: "assistant/chunk"; text: string; seq?: number }
  | { type: "assistant/message"; text: string; seq?: number }
  | { type: "tool/call"; name: string; args: unknown; seq?: number }
  | { type: "tool/result"; name: string; output: unknown; seq?: number }
  | { type: "step/end"; seq?: number }
  | { type: "turn/end"; seq?: number }

export interface Session {
  formatVersion: number
  events: SessionEvent[]
}

export const CURRENT_FORMAT_VERSION = 1

export function createSession(): Session {
  return { formatVersion: CURRENT_FORMAT_VERSION, events: [] }
}

export function append(session: Session, event: SessionEvent): void {
  if (event.type === "assistant/message" && (event as { source?: string }).source !== undefined) {
    throw new Error("assistant/message must originate from the log, not an external source")
  }
  const ev = { ...event, seq: session.events.length }
  session.events.push(ev)
}

export interface LLMMessage {
  role: "user" | "assistant"
  content: string
}

export function deriveMessages(session: Session): LLMMessage[] {
  const result: LLMMessage[] = []
  let chunkBuffer = ""
  for (const ev of session.events) {
    if (ev.type === "user/message") result.push({ role: "user", content: ev.text })
    else if (ev.type === "assistant/chunk") chunkBuffer += ev.text
    else if (ev.type === "assistant/message") {
      result.push({ role: "assistant", content: ev.text })
      chunkBuffer = ""
    }
  }
  return result
}

export function toJSONL(session: Session): string {
  const lines: string[] = [JSON.stringify({ formatVersion: session.formatVersion })]
  for (const ev of session.events) lines.push(JSON.stringify(ev))
  return lines.join("\n") + "\n"
}

export function assertVersion(session: Session, expected: number): number {
  if (session.formatVersion !== expected) {
    throw new Error(`session format version ${session.formatVersion} not supported (expected ${expected})`)
  }
  return session.formatVersion
}

export function fromJSONL(text: string): Session {
  const lines = text.trim().split("\n")
  const header = JSON.parse(lines[0]!) as { formatVersion?: number }
  if (header.formatVersion !== CURRENT_FORMAT_VERSION) {
    throw new Error(`session format version ${header.formatVersion} not supported`)
  }
  const events = lines.slice(1).map((l) => JSON.parse(l) as SessionEvent)
  return { formatVersion: CURRENT_FORMAT_VERSION, events }
}

export function migrate(session: Session, targetVersion: number): Session {
  if (targetVersion !== CURRENT_FORMAT_VERSION) {
    throw new Error(`no migration path to format version ${targetVersion}`)
  }
  return session // M1: only v1 exists; migrate-on-continue is a no-op placeholder for future versions
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/core-session test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @i-harness/core-session typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-session/
git commit -m "feat: core-session event log, deriveMessages, versioned JSONL"
```

---

### Task 6: core-tools — tool registry, scope shadow, execution pipeline

**Files:**
- Create: `packages/core-tools/package.json`, `tsconfig.json`
- Create: `packages/core-tools/src/index.ts`
- Create: `packages/core-tools/test/tools.test.ts`

**Interfaces:**
- Consumes: `core-plugin` (services + guards + events).
- Produces:
  - `interface Tool<Args, Output>` (per spec §4.1).
  - `type ToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason: string }`.
  - `createToolRegistry(ctx: PluginContext)` → `{ register, list, schemas, materialize, execute }`.
  - `execute(exec)` runs the full pipeline (pre-execute waterfall → guards → execute → post-execute → result), with the F03-1 fix: malformed decision = hard error; guards unconditional.
  - `genToolCatalog(registry)` / `verifyToolCatalog(registry, schema)` — catalog generation + completeness gate.

- [ ] **Step 1: Write the failing tests**

Create `packages/core-tools/test/tools.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "../src/index.ts"

function makeCtx(): PluginContext {
  return createContext()
}

describe("tool registry", () => {
  it("registers tools and lists schemas", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    const read: Tool = {
      name: "read",
      description: "read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: async ({ path }: { path: string }) => ({ content: `file:${path}` }),
    }
    reg.register(read)
    expect(reg.schemas().map((s) => s.name)).toEqual(["read"])
  })

  it("throws on same-layer duplicate tool name (audit F03-5)", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    const t: Tool = { name: "x", description: "", inputSchema: {}, execute: async () => ({}) }
    reg.register(t)
    expect(() => reg.register({ ...t })).toThrow(/duplicate/i)
  })

  it("shadows tool in child scope and restores on unmount", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "t", description: "root", inputSchema: {}, execute: async () => ({ who: "root" }) })
    const child = ctx.scope.mount()
    const reg2 = createToolRegistry(child)
    reg2.register({ name: "t", description: "child", inputSchema: {}, execute: async () => ({ who: "child" }) })
    expect(reg2.schemas().map((s) => s.name)).toEqual(["t"])
    child.scope.unmount()
    expect(reg.schemas().map((s) => s.name)).toEqual(["t"])
  })
})

describe("execution pipeline", () => {
  it("executes a tool through the pipeline", async () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    const t: Tool = { name: "echo", description: "", inputSchema: {}, execute: async (args: { m?: string }) => ({ out: args.m ?? "" }) }
    reg.register(t)
    const result = await reg.execute({ name: "echo", args: { m: "hi" } })
    expect(result.output).toEqual({ out: "hi" })
  })

  it("rejects a malformed pre-execute decision before dispatch (audit F03-1)", async () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    let bodyRan = false
    reg.register({ name: "t", description: "", inputSchema: {}, execute: async () => { bodyRan = true; return {} } })
    // a pre-execute listener returns a NON-vocabulary decision object
    ctx.on("tools/pre-execute", () => ({ kind: "anything" }))
    await expect(reg.execute({ name: "t", args: {} })).rejects.toThrow(/decision/i)
    expect(bodyRan).toBe(false)
  })

  it("runs monotonic guards unconditionally before dispatch (audit F03-1)", async () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    let guardRan = false
    ctx.guard("tools/execute", () => {
      guardRan = true
      return "denied"
    })
    reg.register({ name: "t", description: "", inputSchema: {}, execute: async () => ({}) })
    await expect(reg.execute({ name: "t", args: {} })).rejects.toThrow(/denied/)
    expect(guardRan).toBe(true)
  })

  it("honors approval seam fail-closed for non-readOnly tools", async () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    let asked = false
    ctx.on("tools/pre-execute", () => {
      asked = true
      return { kind: "ask", reason: "needs approval" }
    })
    reg.register({ name: "t", description: "", inputSchema: {}, execute: async () => ({}) })
    // no approval answerer registered → fail closed → deny
    await expect(reg.execute({ name: "t", args: {} })).rejects.toThrow(/approval|denied/i)
    expect(asked).toBe(true)
  })
})

describe("catalog", () => {
  it("generates a catalog and completeness gate fails on missing tool", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "a", description: "", inputSchema: {}, execute: async () => ({}) })
    const catalog = reg.genToolCatalog()
    expect(catalog.map((s) => s.name)).toEqual(["a"])
    // completeness gate: every registered tool must appear
    expect(() => reg.verifyToolCatalog([{ name: "a", description: "", inputSchema: {}, execute: async () => ({}) }], catalog)).not.toThrow()
    expect(() => reg.verifyToolCatalog([{ name: "a" }, { name: "b" }] as Tool[], catalog)).toThrow(/missing/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/core-tools test`
Expected: FAIL — module not found (core-tools not created).

- [ ] **Step 3: Write the implementation**

Create `packages/core-tools/src/index.ts`:

```ts
import type { PluginContext } from "@i-harness/core-plugin"

export interface Tool<Args = unknown, Output = unknown> {
  name: string
  description: string
  inputSchema: unknown
  outputSchema?: unknown
  execute(args: Args, exec: ToolExec): Promise<Output>
  timeoutMs?: number
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
}

export interface ToolExec {
  abortSignal?: AbortSignal
}

export type ToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason: string }

export interface ToolCall {
  name: string
  args: unknown
}

export interface ToolResult {
  name: string
  output: unknown
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: unknown
}

const DECISION_KINDS = new Set(["allow", "deny", "ask"])

export interface ToolRegistry {
  register(tool: Tool): void
  schemas(): ToolSchema[]
  execute(call: ToolCall): Promise<ToolResult>
  genToolCatalog(): ToolSchema[]
  verifyToolCatalog(expected: Tool[], catalog: ToolSchema[]): void
}

export function createToolRegistry(ctx: PluginContext): ToolRegistry {
  const tools = new Map<string, Tool>()

  function register(tool: Tool): void {
    if (tools.has(tool.name)) throw new Error(`duplicate tool registration: ${tool.name}`)
    tools.set(tool.name, tool)
  }

  function schemas(): ToolSchema[] {
    return [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  }

  async function execute(call: ToolCall): Promise<ToolResult> {
    const tool = tools.get(call.name)
    if (!tool) throw new Error(`unknown tool: ${call.name}`)

    // 1. pre-execute waterfall — closed vocabulary check (audit F03-1)
    let decision: ToolDecision = { kind: "allow" }
    ctx.waterfall("tools/pre-execute", call, async (payload, next) => {
      const handlerDecision = await next(payload)
      if (handlerDecision !== undefined) {
        if (typeof handlerDecision !== "object" || handlerDecision === null || !DECISION_KINDS.has((handlerDecision as ToolDecision).kind)) {
          throw new Error(`malformed pre-execute decision for '${call.name}': ${JSON.stringify(handlerDecision)}`)
        }
        decision = handlerDecision as ToolDecision
      }
    })

    // 2. monotonic guards — run UNCONDITIONALLY before dispatch (audit F03-1)
    const guardReason = ctx.checkGuards("tools/execute", { name: call.name, args: call.args })
    if (guardReason !== undefined) throw new Error(`guard denied: ${guardReason}`)

    // 3. approval seam — fail closed
    if (decision.kind === "deny") throw new Error(`denied: ${decision.reason}`)
    if (decision.kind === "ask") {
      const answerer = ctx.services.get<(req: { name: string; reason: string }) => Promise<boolean>>("approval/answerer") ?? null
      if (!answerer) throw new Error(`approval required but no answerer registered (fail closed): ${decision.reason}`)
      const ok = await answerer({ name: call.name, reason: decision.reason })
      if (!ok) throw new Error(`denied by user: ${decision.reason}`)
    }

    // 4. execute
    const exec: ToolExec = {}
    const output = await tool.execute(call.args as never, exec)

    // 5. post-execute waterfall
    await ctx.emit("tools/post-execute", { name: call.name, output })

    return { name: call.name, output }
  }

  function genToolCatalog(): ToolSchema[] {
    return schemas()
  }

  function verifyToolCatalog(expected: Tool[], catalog: ToolSchema[]): void {
    const catalogNames = new Set(catalog.map((s) => s.name))
    const missing = expected.map((t) => t.name).filter((n) => !catalogNames.has(n))
    if (missing.length > 0) throw new Error(`catalog completeness: missing tools: ${missing.join(", ")}`)
  }

  return { register, schemas, execute, genToolCatalog, verifyToolCatalog }
}
```

Note: the `ctx.waterfall` in `execute` registers a transient handler each call. Since core-plugin waterfall handlers are re-snapshotted per dispatch and persist in the map, this accumulates. For M1, register the pre-execute decision handler ONCE at `createToolRegistry` time instead. Refactor: create the registry function to register its waterfall handler on ctx at construction:

```ts
export function createToolRegistry(ctx: PluginContext): ToolRegistry {
  const tools = new Map<string, Tool>()
  let decision: ToolDecision = { kind: "allow" }

  ctx.waterfall("tools/pre-execute", {} as ToolCall, async (payload, next) => {
    const handlerDecision = await next(payload)
    if (handlerDecision !== undefined) {
      if (typeof handlerDecision !== "object" || handlerDecision === null || !DECISION_KINDS.has((handlerDecision as ToolDecision).kind)) {
        throw new Error(`malformed pre-execute decision: ${JSON.stringify(handlerDecision)}`)
      }
      decision = handlerDecision as ToolDecision
    }
  })
  // rest unchanged; in execute() reset decision = { kind: "allow" } before emitting the waterfall.
}
```

Then in `execute`, before running the pipeline, emit the waterfall via `await ctx.emit("tools/pre-execute", call)` (after resetting `decision`), then read `decision`.

Final `execute`:

```ts
  async function execute(call: ToolCall): Promise<ToolResult> {
    const tool = tools.get(call.name)
    if (!tool) throw new Error(`unknown tool: ${call.name}`)

    decision = { kind: "allow" }
    await ctx.emit("tools/pre-execute", call) // runs the waterfall handler

    const guardReason = ctx.checkGuards("tools/execute", { name: call.name, args: call.args })
    if (guardReason !== undefined) throw new Error(`guard denied: ${guardReason}`)

    if (decision.kind === "deny") throw new Error(`denied: ${decision.reason}`)
    if (decision.kind === "ask") {
      let answerer: ((req: { name: string; reason: string }) => Promise<boolean>) | null = null
      try {
        answerer = ctx.services.get("approval/answerer")
      } catch {
        answerer = null
      }
      if (!answerer) throw new Error(`approval required but no answerer registered (fail closed): ${decision.reason}`)
      const ok = await answerer({ name: call.name, reason: decision.reason })
      if (!ok) throw new Error(`denied by user: ${decision.reason}`)
    }

    const exec: ToolExec = {}
    const output = await tool.execute(call.args as never, exec)
    await ctx.emit("tools/post-execute", { name: call.name, output })
    return { name: call.name, output }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/core-tools test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @i-harness/core-tools typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-tools/
git commit -m "feat: core-tools registry, scope shadow, guarded exec pipeline"
```

---

### Task 7: llm-seam + llm-mock

**Files:**
- Create: `packages/llm-seam/package.json`, `tsconfig.json`, `src/index.ts`, `test/seam.test.ts`
- Create: `packages/llm-mock/package.json`, `tsconfig.json`, `src/index.ts`, `test/mock.test.ts`

**Interfaces:**
- Consumes: core-session `deriveMessages`, `Session`, `LLMMessage` (Task 5); core-tools `ToolSchema` (Task 6).
- Produces:
  - `type LLMStreamEvent = { type: "text/chunk"; text: string } | { type: "reasoning"; text: string } | { type: "tool_call"; call: ToolCall } | { type: "end" } | { type: "error"; error: Error }`.
  - `interface LLMRequest { messages: LLMMessage[]; tools: ToolSchema[]; systemPrompt: string; model?: string }`.
  - `interface ModelClient { stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> }`.
  - `assertMessagesFromLog(request, session)` — the F01-3 invariant check at the seam.
  - `createMockClient(script: MockStep[])` — script-driven mock. `MockStep = { role: "assistant"; text?: string; toolCalls?: ToolCall[] }[]`.

- [ ] **Step 1: Write the failing tests**

`packages/llm-seam/test/seam.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { assertMessagesFromLog } from "../src/index.ts"
import { createSession, append } from "@i-harness/core-session"

describe("llm-seam invariant (audit F01-3)", () => {
  it("accepts messages derived from the log", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    const msgs = s.events.filter((e) => e.type === "user/message").map((e) => ({ role: "user" as const, content: (e as { text: string }).text }))
    expect(() => assertMessagesFromLog(msgs, s)).not.toThrow()
  })

  it("rejects messages NOT derived from the log", () => {
    const s = createSession()
    const foreign = [{ role: "assistant" as const, content: "not in log" }]
    expect(() => assertMessagesFromLog(foreign, s)).toThrow(/log/i)
  })
})
```

`packages/llm-mock/test/mock.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createMockClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

describe("llm-mock", () => {
  it("replays a scripted sequence", async () => {
    const client = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
      { role: "assistant", text: "done reading" },
    ])
    const events: string[] = []
    for await (const ev of client.stream({} as LLMRequest)) {
      if (ev.type === "tool_call") events.push(`tool:${ev.call.name}`)
      if (ev.type === "text/chunk") events.push(`text:${ev.text}`)
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["tool:read", "text:done reading", "end"])
  })

  it("exhausts the script with an error", async () => {
    const client = createMockClient([])
    const events: string[] = []
    for await (const ev of client.stream({} as LLMRequest)) {
      if (ev.type === "error") events.push("error")
    }
    expect(events).toEqual(["error"])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -r test` (both new packages)
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

`packages/llm-seam/src/index.ts`:

```ts
import type { Session } from "@i-harness/core-session"

export type LLMStreamEvent =
  | { type: "text/chunk"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: { name: string; args: unknown } }
  | { type: "end" }
  | { type: "error"; error: Error }

export interface LLMMessage {
  role: "user" | "assistant"
  content: string
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: unknown
}

export interface LLMRequest {
  messages: LLMMessage[]
  tools: ToolSchema[]
  systemPrompt: string
  model?: string
}

export interface ModelClient {
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>
}

export function assertMessagesFromLog(messages: LLMMessage[], session: Session): void {
  const logged: LLMMessage[] = []
  for (const ev of session.events) {
    if (ev.type === "user/message") logged.push({ role: "user", content: ev.text })
    else if (ev.type === "assistant/message") logged.push({ role: "assistant", content: ev.text })
  }
  const msgJson = JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })))
  const logJson = JSON.stringify(logged.map((m) => ({ role: m.role, content: m.content })))
  if (msgJson !== logJson) throw new Error("model-visible messages must derive from the session log (audit F01-3)")
}
```

`packages/llm-mock/src/index.ts`:

```ts
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"

export interface MockToolCall {
  name: string
  args: unknown
}

export interface MockStep {
  role: "assistant"
  text?: string
  toolCalls?: MockToolCall[]
}

export function createMockClient(script: MockStep[]): ModelClient {
  return {
    async *stream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      if (script.length === 0) {
        yield { type: "error", error: new Error("mock script exhausted") }
        return
      }
      const step = script.shift()!
      if (step.toolCalls && step.toolCalls.length > 0) {
        for (const call of step.toolCalls) yield { type: "tool_call", call }
      }
      if (step.text !== undefined) yield { type: "text/chunk", text: step.text }
      yield { type: "end" }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -r test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-seam/ packages/llm-mock/
git commit -m "feat: llm-seam interface and script-driven llm-mock"
```

---

### Task 8: interaction — seam family (approval/questions/commands)

**Files:**
- Create: `packages/interaction/package.json`, `tsconfig.json`, `src/index.ts`, `test/interaction.test.ts`

**Interfaces:**
- Consumes: core-plugin (services + events).
- Produces (pure interfaces + fail-closed behavior, audit F05-5/F05-6):
  - `interface ApprovalRequest { name: string; reason: string }`.
  - `interface ApprovalDecision { approved: boolean }`.
  - `registerApprovalAnswerer(ctx, fn)` — registers a `services` entry `approval/answerer`.
  - `interface UserQuestion { id: string; prompt: string; options?: string[] }`.
  - `interface QuestionProvider { ask(q: UserQuestion): Promise<string> }` — `registerQuestionProvider(ctx, provider)`; no provider → `NO_PROVIDER` throw.
  - `interface Command { name: string; execute(input: string, ctx: PluginContext): Promise<string> }` — UI-plane commands never enter model history (audit F05-6).
  - `registerCommand(ctx, cmd)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/interaction/test/interaction.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { registerApprovalAnswerer, registerQuestionProvider, registerCommand, runCommand, askUser } from "../src/index.ts"

function makeCtx(): PluginContext {
  return createContext()
}

describe("approval seam", () => {
  it("fails closed when no answerer is registered (audit F05-5)", () => {
    const ctx = makeCtx()
    expect(() => ctx.services.get("approval/answerer")).toThrow()
  })

  it("registers an answerer and resolves it", async () => {
    const ctx = makeCtx()
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
    const fn = ctx.services.get<{ name: string; reason: string }>("approval/answerer")
    expect(fn).toBeDefined()
  })
})

describe("questions seam", () => {
  it("throws NO_PROVIDER when none registered", () => {
    const ctx = makeCtx()
    expect(() => askUser(ctx, { id: "q", prompt: "?" })).toThrow(/provider/i)
  })

  it("asks via a registered provider", async () => {
    const ctx = makeCtx()
    registerQuestionProvider(ctx, { ask: async (q) => `answer:${q.id}` })
    const ans = await askUser(ctx, { id: "q", prompt: "?" })
    expect(ans).toBe("answer:q")
  })
})

describe("commands seam (audit F05-6)", () => {
  it("executes a registered command", async () => {
    const ctx = makeCtx()
    registerCommand(ctx, { name: "help", execute: async () => "help text" })
    expect(await runCommand(ctx, "help", "")).toBe("help text")
  })

  it("rejects unknown commands", async () => {
    const ctx = makeCtx()
    await expect(runCommand(ctx, "nope", "")).rejects.toThrow(/unknown command/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/interaction test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/interaction/src/index.ts`:

```ts
import type { PluginContext } from "@i-harness/core-plugin"

// ── approval seam (audit F05-5) ────────────────────────────────────────────

export interface ApprovalRequest {
  name: string
  reason: string
}

export interface ApprovalDecision {
  approved: boolean
}

export type ApprovalAnswerer = (req: ApprovalRequest) => Promise<ApprovalDecision>

export function registerApprovalAnswerer(ctx: PluginContext, fn: ApprovalAnswerer): void {
  ctx.services.register("approval/answerer", fn)
}

// ── questions seam (audit F05-5) ───────────────────────────────────────────

export interface UserQuestion {
  id: string
  prompt: string
  options?: string[]
}

export interface QuestionProvider {
  ask(q: UserQuestion): Promise<string>
}

export function registerQuestionProvider(ctx: PluginContext, provider: QuestionProvider): void {
  ctx.services.register("questions/provider", provider)
}

export async function askUser(ctx: PluginContext, q: UserQuestion): Promise<string> {
  let provider: QuestionProvider
  try {
    provider = ctx.services.get<QuestionProvider>("questions/provider")
  } catch {
    throw new Error("no user-questions provider is registered (NO_PROVIDER)")
  }
  return provider.ask(q)
}

// ── commands seam (audit F05-6: results never enter model history) ─────────

export interface Command {
  name: string
  execute(input: string, ctx: PluginContext): Promise<string>
}

export function registerCommand(ctx: PluginContext, cmd: Command): void {
  const registry = ctx.services.get<Map<string, Command>>("commands/registry") ?? new Map<string, Command>()
  registry.set(cmd.name, cmd)
  ctx.services.register("commands/registry", registry)
}

export async function runCommand(ctx: PluginContext, name: string, input: string): Promise<string> {
  const registry = ctx.services.get<Map<string, Command>>("commands/registry")
  const cmd = registry?.get(name)
  if (!cmd) throw new Error(`unknown command: ${name}`)
  return cmd.execute(input, ctx)
}
```

Note: `registerCommand` uses `get` with `?? new Map()` — but `get` throws when missing. Wrap in try/catch:

```ts
export function registerCommand(ctx: PluginContext, cmd: Command): void {
  let registry: Map<string, Command>
  try {
    registry = ctx.services.get<Map<string, Command>>("commands/registry")
  } catch {
    registry = new Map()
    ctx.services.register("commands/registry", registry)
  }
  registry.set(cmd.name, cmd)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/interaction test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @i-harness/interaction typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/interaction/
git commit -m "feat: interaction seam family (approval/questions/commands, fail-closed)"
```

---

### Task 9: core-agent — pure event-driven agent loop

**Files:**
- Create: `packages/core-agent/package.json`, `tsconfig.json`
- Create: `packages/core-agent/src/index.ts`
- Create: `packages/core-agent/test/agent.test.ts`

**Interfaces:**
- Consumes: core-plugin (events, waterfall, guard); core-session (`createSession`, `append`, `deriveMessages`, `Session`); core-tools (`ToolRegistry`, `execute`); llm-seam (`ModelClient`, `LLMRequest`, `assertMessagesFromLog`); interaction (approval).
- Produces:
  - `interface AgentConfig { systemPrompt: string; model?: string }`.
  - `createAgent(ctx, deps)` → `{ run(task: string): Promise<AgentResult> }`.
  - `deps = { session: Session; tools: ToolRegistry; model: ModelClient }`.
  - `AgentResult = { finalText: string; turns: number }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core-agent/test/agent.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createSession, append } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"

function makeDeps(ctx: PluginContext) {
  const session = createSession()
  const tools = createToolRegistry(ctx)
  const readTool: Tool = {
    name: "read",
    description: "read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    execute: async ({ path }: { path: string }) => ({ content: `content-of-${path}` }),
  }
  const editTool: Tool = {
    name: "edit",
    description: "edit a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } } },
    execute: async () => ({ ok: true }),
  }
  tools.register(readTool)
  tools.register(editTool)
  return { session, tools, model: undefined as unknown as ReturnType<typeof createMockClient> }
}

describe("agent loop", () => {
  it("runs a read → edit → report sequence", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
      { role: "assistant", toolCalls: [{ name: "edit", args: { path: "a.txt", text: "new" } }] },
      { role: "assistant", text: "Report: edited a.txt" },
    ])
    const agent = createAgent(ctx, { ...deps, systemPrompt: "You are a coding agent" })
    const result = await agent.run("edit a.txt")
    expect(result.finalText).toBe("Report: edited a.txt")
    expect(result.turns).toBeGreaterThanOrEqual(1)
    // session log records the tool calls
    const callTypes = deps.session.events.filter((e) => e.type === "tool/call").map((e) => (e as { name: string }).name)
    expect(callTypes).toEqual(["read", "edit"])
  })

  it("ends the turn when the model replies without tool calls", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = createMockClient([{ role: "assistant", text: "all done" }])
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
    const result = await agent.run("nothing")
    expect(result.finalText).toBe("all done")
    expect(result.turns).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/core-agent/src/index.ts`:

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append, deriveMessages } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient, LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"
import { assertMessagesFromLog } from "@i-harness/llm-seam"

export interface AgentConfig {
  systemPrompt: string
  model?: string
}

export interface AgentDeps {
  session: Session
  tools: ToolRegistry
  model: ModelClient
}

export interface AgentResult {
  finalText: string
  turns: number
}

export function createAgent(ctx: PluginContext, deps: AgentDeps & AgentConfig) {
  return {
    async run(task: string): Promise<AgentResult> {
      let finalText = ""
      let turns = 0

      append(deps.session, { type: "turn/start" })
      append(deps.session, { type: "user/message", text: task })

      let needsContinuation = true
      while (needsContinuation) {
        turns += 1
        append(deps.session, { type: "step/start" })

        await ctx.emit("agent/pre-step", { task, session: deps.session })

        const messages = deriveMessages(deps.session)
        // invariant at the seam (audit F01-3): messages must come from the log
        assertMessagesFromLog(messages, deps.session)

        const request: LLMRequest = {
          messages,
          tools: deps.tools.schemas(),
          systemPrompt: deps.config?.systemPrompt ?? "",
          model: deps.model,
        }
        // NOTE: LLMRequest.model is a string in the seam; deps.config carries the systemPrompt.
        // See corrected request below.

        let stepText = ""
        let toolCallsThisStep = 0
        for await (const ev of deps.model.stream(request)) {
          switch (ev.type) {
            case "text/chunk":
              stepText += ev.text
              break
            case "tool_call":
              append(deps.session, { type: "tool/call", name: ev.call.name, args: ev.call.args })
              const result = await deps.tools.execute({ name: ev.call.name, args: ev.call.args })
              append(deps.session, { type: "tool/result", name: ev.call.name, output: result.output })
              toolCallsThisStep += 1
              break
            case "error":
              throw new Error(`model stream error: ${ev.error.message}`)
            case "end":
              break
          }
        }

        if (stepText) append(deps.session, { type: "assistant/message", text: stepText })
        else if (toolCallsThisStep === 0) append(deps.session, { type: "assistant/message", text: "" })

        append(deps.session, { type: "step/end" })

        // continuation: keep going only if there were tool calls and the model has not given a final message
        const lastMsg = deriveMessages(deps.session).at(-1)
        needsContinuation = toolCallsThisStep > 0 && !lastMsg
      }

      append(deps.session, { type: "turn/end" })
      finalText = deriveMessages(deps.session).at(-1)?.content ?? ""
      return { finalText, turns }
    },
  }
}
```

There's a type bug: `deps` is `AgentDeps & AgentConfig`, so `deps.systemPrompt` exists (not `deps.config`). Fix the request construction:

```ts
        const request: LLMRequest = {
          messages,
          tools: deps.tools.schemas(),
          systemPrompt: deps.systemPrompt,
          model: deps.model,
        }
```

`model` in `LLMRequest` is a string; passing a ModelClient is a type error. For M1, drop `model` from the request (the mock ignores it). Change:

```ts
        const request: LLMRequest = {
          messages,
          tools: deps.tools.schemas(),
          systemPrompt: deps.systemPrompt,
        }
```

Also the `assertMessagesFromLog` call: since the agent loop appends every user/assistant message to the log and derives from it, the check passes trivially — but the real seam-level protection is for EXTERNAL callers. Keep the call in the loop as the discipline point.

Also fix the continuation logic: the loop should continue after tool calls to let the model produce the final message. The `needsContinuation` should be: there were tool calls this step AND the model has NOT yet produced a final assistant message. Simplify: continue while `toolCallsThisStep > 0`:

```ts
        needsContinuation = toolCallsThisStep > 0
```

This is the correct semantics: after a step with tool calls, run another step; the mock's final step has no tool calls → loop ends.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: PASS (both tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @i-harness/core-agent typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-agent/
git commit -m "feat: core-agent pure event-driven loop"
```

---

### Task 10: preset — agent preset mount

**Files:**
- Create: `packages/preset/package.json`, `tsconfig.json`, `src/index.ts`, `test/preset.test.ts`

**Interfaces:**
- Consumes: core-plugin (scope mount), core-agent (AgentConfig).
- Produces:
  - `interface AgentPreset { name: string; systemPrompt: string; tools: string[]; model?: string }`.
  - `parsePreset(yamlOrJson: string): AgentPreset` (M1 accepts JSON; YAML parsing deferred or via a tiny JSON config).
  - `mountPreset(ctx, preset, onTool): PluginContext` — mounts the preset into a child scope, registers the tools it names (resolving from a provider), returns the child scope.

- [ ] **Step 1: Write the failing tests**

Create `packages/preset/test/preset.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { parsePreset, mountPreset } from "../src/index.ts"

describe("preset", () => {
  it("parses a preset definition", () => {
    const preset = parsePreset(JSON.stringify({
      name: "default",
      systemPrompt: "You are a coding agent.",
      tools: ["read", "edit"],
    }))
    expect(preset.name).toBe("default")
    expect(preset.tools).toEqual(["read", "edit"])
  })

  it("mounts a preset into a child scope with its tools", () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    const t: Tool = { name: "read", description: "", inputSchema: {}, execute: async () => ({}) }
    reg.register(t)
    const provider = { resolve: (name: string) => name === "read" ? t : null }
    const child = mountPreset(ctx, { name: "default", systemPrompt: "p", tools: ["read"] }, provider)
    expect(child).toBeDefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/preset test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/preset/src/index.ts`:

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool } from "@i-harness/core-tools"

export interface AgentPreset {
  name: string
  systemPrompt: string
  tools: string[]
  model?: string
}

export interface ToolProvider {
  resolve(name: string): Tool | null
}

export function parsePreset(text: string): AgentPreset {
  const parsed = JSON.parse(text) as Partial<AgentPreset>
  if (!parsed.name || !parsed.systemPrompt || !Array.isArray(parsed.tools)) {
    throw new Error("invalid preset: name, systemPrompt, tools required")
  }
  return parsed as AgentPreset
}

export function mountPreset(ctx: PluginContext, preset: AgentPreset, provider: ToolProvider): PluginContext {
  const child = ctx.scope.mount()
  ctx.services.register("preset", { name: preset.name, systemPrompt: preset.systemPrompt })
  // resolve + register the preset's tools into the child tool registry
  const tools = preset.tools.map((name) => {
    const tool = provider.resolve(name)
    if (!tool) throw new Error(`preset '${preset.name}' requires unknown tool: ${name}`)
    return tool
  })
  // register into child scope's tool registry service
  const reg = ctx.services.get<{ register(tool: Tool): void }>("tools/registry") ?? null
  if (reg) for (const tool of tools) reg.register(tool)
  return child
}
```

Simplify: the preset mount registers the preset metadata and resolves its tool list, throwing on unknown tools (fail-loud, not silent).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/preset test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @i-harness/preset typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/preset/
git commit -m "feat: preset parse and mount"
```

---

### Task 11: apps/cli — headless CLI + acceptance task

**Files:**
- Modify: `apps/cli/package.json` (add deps on all kernel packages)
- Modify: `apps/cli/src/index.ts`
- Create: `apps/cli/src/run.ts`
- Modify: `apps/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: all kernel packages + interaction.
- Produces: `runHeadless(task: string, opts): Promise<{ finalText: string; exitCode: number }>` — the acceptance command. `main(argv)` parses `run <task>` and calls it.

- [ ] **Step 1: Write the failing test**

Modify `apps/cli/test/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { runHeadless } from "../src/run.ts"

describe("headless CLI", () => {
  it("runs the read → edit → report acceptance task", async () => {
    const result = await runHeadless("把 src/data.txt 第一行改成 hello", {
      workspace: process.cwd(),
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "src/data.txt" } }] },
        { role: "assistant", toolCalls: [{ name: "edit", args: { path: "src/data.txt", text: "hello" } }] },
        { role: "assistant", text: "报告：已将 src/data.txt 第一行改为 hello" },
      ],
    })
    expect(result.exitCode).toBe(0)
    expect(result.finalText).toContain("hello")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/cli test`
Expected: FAIL — `runHeadless` not found.

- [ ] **Step 3: Write the implementation**

Update `apps/cli/package.json` deps:

```json
  "dependencies": {
    "@i-harness/core-plugin": "workspace:*",
    "@i-harness/core-session": "workspace:*",
    "@i-harness/core-tools": "workspace:*",
    "@i-harness/core-agent": "workspace:*",
    "@i-harness/llm-seam": "workspace:*",
    "@i-harness/llm-mock": "workspace:*",
    "@i-harness/interaction": "workspace:*",
    "@i-harness/preset": "workspace:*"
  }
```

Create `apps/cli/src/run.ts`:

```ts
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createSession, append, deriveMessages } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createAgent } from "@i-harness/core-agent"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"

export interface HeadlessOptions {
  workspace: string
  mockScript?: MockStep[]
}

export interface HeadlessResult {
  finalText: string
  exitCode: number
}

export async function runHeadless(task: string, opts: HeadlessOptions): Promise<HeadlessResult> {
  const ctx: PluginContext = createContext()
  const session = createSession()
  const tools = createToolRegistry(ctx)

  // real file tools for the acceptance task
  const readTool: Tool<{ path: string }, { content: string }> = {
    name: "read",
    description: "read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async ({ path }) => {
      const fs = await import("node:fs/promises")
      const full = `${opts.workspace}/${path}`
      return { content: await fs.readFile(full, "utf-8") }
    },
  }
  const editTool: Tool<{ path: string; text: string }, { ok: boolean }> = {
    name: "edit",
    description: "write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"] },
    execute: async ({ path, text }) => {
      const fs = await import("node:fs/promises")
      const full = `${opts.workspace}/${path}`
      await fs.writeFile(full, text, "utf-8")
      return { ok: true }
    },
  }
  tools.register(readTool)
  tools.register(editTool)

  const model = createMockClient(opts.mockScript ?? [{ role: "assistant", text: "ok" }])

  const agent = createAgent(ctx, { session, tools, model, systemPrompt: "You are a coding agent." })
  const result = await agent.run(task)
  return { finalText: result.finalText, exitCode: 0 }
}
```

Update `apps/cli/src/index.ts` to export `runHeadless` + a `main`:

```ts
export { runHeadless } from "./run.ts"
export type { HeadlessOptions, HeadlessResult } from "./run.ts"

export function main(argv: string[]): Promise<number> {
  const cmd = argv[2]
  if (cmd === "run") {
    const task = argv.slice(3).join(" ")
    return runHeadless(task, { workspace: process.cwd() }).then((r) => {
      console.log(r.finalText)
      return r.exitCode
    })
  }
  console.error("usage: i-harness run <task>")
  return Promise.resolve(1)
}
```

Note: the mock-driven acceptance test needs a real `src/data.txt` file. The test creates it in a temp workspace:

Update `apps/cli/test/cli.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"

describe("headless CLI", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-"))
    writeFileSync(join(dir, "data.txt"), "old line")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("runs the read → edit → report acceptance task", async () => {
    const result = await runHeadless("把 data.txt 第一行改成 hello", {
      workspace: dir,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "data.txt" } }] },
        { role: "assistant", toolCalls: [{ name: "edit", args: { path: "data.txt", text: "hello" } }] },
        { role: "assistant", text: "报告：已将 data.txt 第一行改为 hello" },
      ],
    })
    expect(result.exitCode).toBe(0)
    expect(result.finalText).toContain("hello")
    expect(readFileSync(join(dir, "data.txt"), "utf-8")).toBe("hello")
  })
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: all packages pass.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/
git commit -m "feat: headless CLI with read→edit→report acceptance"
```

---

### Task 12: catalog-as-artifact gates

**Files:**
- Create: `packages/core-tools/scripts/gen-tool-catalog.ts`
- Create: `packages/core-tools/scripts/verify-tool-catalog.ts`
- Modify: `packages/core-tools/package.json` (scripts)
- Modify: `packages/core-tools/test/tools.test.ts`

**Interfaces:**
- Consumes: core-tools catalog functions (Task 6).
- Produces: `gen-tool-catalog` CLI writes `docs/tool-catalog.md`; `verify-tool-catalog` fails if any registered tool is missing (audit F03-7).

- [ ] **Step 1: Write the failing test**

Append to `packages/core-tools/test/tools.test.ts`:

```ts
  it("verify-tool-catalog gate fails loud (audit F03-7)", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "a", description: "", inputSchema: {}, execute: async () => ({}) })
    const catalog = reg.genToolCatalog()
    // completeness gate: registered tool must appear; missing → throw
    expect(() => reg.verifyToolCatalog([{ name: "a" }, { name: "ghost" }] as Tool[], catalog)).toThrow(/missing.*ghost/i)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/core-tools test`
Expected: FAIL if the earlier catalog test wasn't written — ensure the catalog tests exist (Task 6 wrote them).

- [ ] **Step 3: Write the scripts**

`packages/core-tools/scripts/gen-tool-catalog.ts`:

```ts
#!/usr/bin/env node
// Generates the model-visible tool catalog document from a registry snapshot.
// Usage: gen-tool-catalog <tools-json> <out-md>
import { readFileSync, writeFileSync } from "node:fs"

const [, , toolsJsonPath, outMdPath] = process.argv
const tools = JSON.parse(readFileSync(toolsJsonPath, "utf-8")) as Array<{ name: string; description: string; inputSchema: unknown }>

const rows = tools.map((t) => `| ${t.name} | ${t.description} | \`${JSON.stringify(t.inputSchema)}\` |`).join("\n")
const md = `# Tool Catalog\n\n| Name | Description | Schema |\n|---|---|---|\n${rows}\n`
writeFileSync(outMdPath, md, "utf-8")
console.log(`wrote ${outMdPath} (${tools.length} tools)`)
```

`packages/core-tools/scripts/verify-tool-catalog.ts`:

```ts
#!/usr/bin/env node
// Fails if the committed catalog is missing any registered tool.
import { readFileSync } from "node:fs"

const [, , registeredJsonPath, catalogMdPath] = process.argv
const registered = JSON.parse(readFileSync(registeredJsonPath, "utf-8")) as Array<{ name: string }>
const catalogText = readFileSync(catalogMdPath, "utf-8")

const missing = registered.filter((t) => !catalogText.includes(`| ${t.name} |`)).map((t) => t.name)
if (missing.length > 0) {
  console.error(`catalog completeness: missing tools: ${missing.join(", ")}`)
  process.exit(1)
}
console.log(`catalog complete (${registered.length} tools)`)
```

Update `packages/core-tools/package.json` scripts:

```json
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "gen-tool-catalog": "tsx scripts/gen-tool-catalog.ts",
    "verify-tool-catalog": "tsx scripts/verify-tool-catalog.ts"
  }
```

Add `tsx` to root devDependencies:

```json
    "tsx": "^4.19.0"
```

- [ ] **Step 4: Run tests + gates**

Run: `pnpm --filter @i-harness/core-tools test && pnpm -r typecheck`
Expected: PASS.

Run a manual gate check:

```bash
echo '[{"name":"a","description":"d","inputSchema":{}}]' > /tmp/tools.json
pnpm --filter @i-harness/core-tools exec tsx packages/core-tools/scripts/gen-tool-catalog.ts /tmp/tools.json /tmp/catalog.md
pnpm --filter @i-harness/core-tools exec tsx packages/core-tools/scripts/verify-tool-catalog.ts /tmp/tools.json /tmp/catalog.md
```

Expected: `wrote /tmp/catalog.md (1 tools)` then `catalog complete (1 tools)`.

- [ ] **Step 5: Commit**

```bash
git add packages/core-tools/
git commit -m "feat: catalog-as-artifact gen/verify gates"
```

---

### Task 13: M1 acceptance verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Run the full gate**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: all packages pass (core-plugin, core-session, core-tools, llm-seam, llm-mock, interaction, core-agent, preset, cli).

- [ ] **Step 2: Run the acceptance task via CLI**

```bash
cd /d/agent-complete/I-harness
node --import tsx apps/cli/src/index.ts run "把 data.txt 第一行改成 hello"
```

(If a real data.txt exists in the repo root; otherwise use the test which exercises the same path.)

- [ ] **Step 3: Confirm clean tree + commit log**

Run: `git status --short` → clean.
Run: `git log --oneline` → 12-13 implementation commits.

- [ ] **Step 4: Report completion**

Report: M1 kernel complete — pnpm monorepo, 8 packages + cli, all tests green, acceptance task runs.