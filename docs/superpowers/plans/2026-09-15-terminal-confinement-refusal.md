# Terminal Confinement Refusal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PTY cannot be kernel-confined, so under a confined sandbox mode the terminal tools must refuse the calls that *create or drive* a capability — and say why, in the same denial shape the fs and shell surfaces use — instead of running unconfined.

**Architecture:** `registerTerminal` (`packages/terminal/src/tool.ts:164`) mounts six tools that spawn processes through `node-pty`. `TerminalToolDeps` carries only `{ service, cwd }`, so nothing in that package can see the session's sandbox mode. The assembly mounts it unconditionally at `assembly.ts:295`. The fix gives `TerminalToolDeps` the same `() => SandboxExecutionPolicy | undefined` resolver thunk that the fs `writeGuard` and the shell registration already use, resolves it **per call**, and returns a classified refusal for the three capability-creating calls.

**Tech Stack:** TypeScript ESM, pnpm workspace, vitest, Node ≥22.18. Zero external dependencies beyond the one workspace dependency this plan adds.

**Spec:** `docs/superpowers/specs/2026-09-14-backend-permission-sandbox-design.md` §3.4 (corrected 2026-09-15) — read that section before starting. The spec originally said "do not mount the terminal when the mode is restricted"; it was corrected because a **mount-time** decision cannot see a mid-session change, which is the case §3.1 exists to fix. The plan below implements the corrected rule.

**Depends on:** `docs/superpowers/plans/2026-09-14-sandbox-per-call-resolution.md` Tasks 1, 1b, 2 and 3. Task 2 creates `denialFor` / `SandboxDenial` in `@i-harness/sandbox`; this plan consumes them and cannot start before they exist.

## Global Constraints

- **No production code change without a test that fails first**, and a mutation proof that the test actually exercises the change (temporarily break the implementation, confirm the test goes red, restore).
- **No new external dependencies.** One new *workspace* dependency is authorised: `@i-harness/sandbox` in `packages/terminal`.
- **Do not introduce a permission rule engine, a governance layer, or a second LLM danger classifier** (spec §5, binding).
- **Do not wrap the PTY in a sandbox runner.** The whole point of this task is that the PTY cannot be confined; pretending otherwise is the failure mode the spec names.
- **Reads stay unrestricted** (spec §3.5).
- **Keep `ALL THRESHOLDS PASS`:** `node scripts/audit/check-thresholds.mjs` must stay green.
- **Push to `origin/m62` only.**
- Existing known-red tests, unrelated to this work: `packages/session-executor/test/workspace-cwd.test.ts` (2, bash on PATH is WSL not Git Bash) and `apps/cli` shell retry/retention (2, same cause).

## Why this is not hypothetical (and the precise form of the hole)

A session started with `--sandbox read-only` can open a PTY and write anywhere, because `registerTerminal` mounts unconditionally (`assembly.ts:295`) and its tools receive only `{ cwd }`.

**The precise form matters, and an earlier draft of this plan overstated it.** The terminal is not *ungated*: `guard-approval`'s Layer-1 fallback asks for any non-`isReadOnly` tool, and `terminal_open`/`terminal_send`/`terminal_signal`/`terminal_close` are all non-`isReadOnly` (only `terminal_read` and `terminal_list` are marked read-only). So a host with an approval bridge does prompt.

But **approval answers a different question than confinement does.** The prompt says "tool 'terminal_open' requires approval" — it does not say "this PTY will run outside the sandbox you asked for". A user approving a terminal in a read-only session is not being told that. And on a host that sets `approveAll` — a supported configuration the assembly exposes and its own tests use — there is no prompt at all.

So: **the only gate is orthogonal to the mode, and on `approveAll` hosts it is absent.** That is the hole this plan closes, stated as it actually is rather than as "nothing gates it".

## Why we are NOT changing fs-search (recorded so nobody re-opens it)

The spec's §3.4 also asked to route ripgrep through the exec runner. **That was withdrawn on 2026-09-15 with evidence, and is not part of this plan.** ripgrep 15.0.0's (shipped as `@vscode/ripgrep` 1.18.0) complete flag list contains **no flag that writes a file** — `--replace` substitutes text in the printed output, `--files` lists names, and there is no `--output`. IH's two call sites (`packages/fs-search/src/index.ts:87` and `:134`) pass only `--files` / `--json` / `--regexp`. Wrapping rg in the runner would therefore confine nothing that is not already unrestricted by design (§3.5), while making `glob` and `grep` throw `SandboxUnavailableError` on any host where the runner cannot start — two working read-only tools turned into failures for zero security gain. Revisit only when §3.5 acquires a concrete policy input, at which point running rg through the runner is exactly how read isolation would be enforced.

---

### Task 4: The terminal refuses capability-creating calls under a confined mode

**Files:**
- Modify: `packages/terminal/src/tool.ts` (`TerminalToolDeps`, `createTerminalTools`, `createProcessTools`, `registerTerminal`)
- Modify: `packages/terminal/src/index.ts` (only if a type needs re-exporting)
- Modify: `packages/terminal/package.json` (`@i-harness/sandbox` dependency + `pnpm install`)
- Modify: `packages/session-executor/src/assembly.ts` (`:295` terminal registration moves below the policy resolver; the resolver is passed in)
- Test: `packages/terminal/test/sandbox-refusal.test.ts` (create), `packages/session-executor/test/sandbox-terminal-refusal.test.ts` (create)

**Interfaces:**
- Consumes: `SandboxExecutionPolicy`, `SandboxMode`, `denialFor`, `SandboxDenial`, `SandboxSurface` — all from `@i-harness/sandbox` (created by the per-call resolution plan, Task 2).
- Produces: `TerminalToolDeps.sandboxPolicy?: () => SandboxExecutionPolicy | undefined` — the identical thunk type the shell registration uses.

**The rule, stated once so the code can be checked against it:**

| Tool | Confined mode | Why |
|---|---|---|
| `terminal_open`, `process_spawn` | **refuse** | These create the capability. No new unconfined PTY under a confined mode. |
| `terminal_send` | **refuse** | A PTY opened under a wider mode is still unconfined; feeding it input is still unconfined execution. |
| `terminal_read`, `terminal_signal`, `terminal_close`, `terminal_list` | **allow** | They can only observe or *shut down*. Refusing them would strand live PTYs with no way to close them. |

- [ ] **Step 1: Add the dependency first**

`packages/terminal/package.json` → `dependencies` gains `"@i-harness/sandbox": "workspace:*"`, then run `pnpm install`. Without it the import cannot resolve (`moduleResolution: "bundler"`, no tsconfig `paths`, so resolution goes through `node_modules`; verified: `packages/terminal` declares only `core-tools`, `core-plugin` and `node-pty`).

- [ ] **Step 2: Write the failing unit test**

Create `packages/terminal/test/sandbox-refusal.test.ts`. Model the service stub on the existing `spy` in `packages/terminal/test/terminal.test.ts:106` — read that file first and reuse its shape rather than inventing one.

```ts
import { describe, expect, it } from "vitest"
import { createProcessTools, createTerminalTools } from "../src/tool.ts"

// A spy service that records every call, so "was a PTY actually spawned?" is a
// real assertion rather than an inference from the returned object.
function spyService() { /* copy the existing spy from terminal.test.ts */ }

describe("terminal refuses capability-creating calls under a confined mode", () => {
  it("terminal_open refuses and never reaches the service", async () => {
    const spy = spyService()
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    })
    const open = tools.find((t) => t.name === "terminal_open")!
    const result = await open.execute({ command: "bash" }, {})
    expect(result).toMatchObject({ code: "SANDBOX_DENIED" })
    expect((result as { denial: { surface: string; mode: string } }).denial.surface).toBe("terminal")
    expect((result as { denial: { mode: string } }).denial.mode).toBe("read-only")
    // The load-bearing assertion: refusing must not have spawned anything.
    expect(spy.opened).toHaveLength(0)
  })

  it("the refusal carries the escalation guidance so the model can recover", async () => {
    // read-only has wider modes; a refusal with no way forward is a dead end.
    const tools = createTerminalTools({
      service: spyService().service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    })
    const open = tools.find((t) => t.name === "terminal_open")!
    const result = (await open.execute({ command: "bash" }, {})) as { error: string; denial: { escalation?: string } }
    expect(result.denial.escalation).toBeDefined()
    expect(result.error).toContain("sandbox_permissions")
  })

  it("observation and shutdown stay allowed under a confined mode", async () => {
    const spy = spyService()
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    })
    for (const name of ["terminal_read", "terminal_list", "terminal_close", "terminal_signal"]) {
      const tool = tools.find((t) => t.name === name)
      expect(tool, `${name} must still be mounted`).toBeDefined()
    }
    await tools.find((t) => t.name === "terminal_list")!.execute({}, {})
    expect(spy.listed).toBe(1)
  })

  it("danger-full-access is not confined and must keep working", async () => {
    // The control. A fix that refuses everything would pass the three tests above
    // and be useless.
    const spy = spyService()
    const tools = createTerminalTools({
      service: spy.service,
      sandboxPolicy: () => ({ mode: "danger-full-access", workspaceRoot: "/ws" }),
    })
    await tools.find((t) => t.name === "terminal_open")!.execute({ command: "bash" }, {})
    expect(spy.opened).toHaveLength(1)
  })

  it("no resolver at all means no sandbox was requested, so nothing is refused", async () => {
    const spy = spyService()
    const tools = createTerminalTools({ service: spy.service })
    await tools.find((t) => t.name === "terminal_open")!.execute({ command: "bash" }, {})
    expect(spy.opened).toHaveLength(1)
  })

  it("the policy is resolved PER CALL, not once at construction", async () => {
    const spy = spyService()
    let mode: "danger-full-access" | "read-only" = "danger-full-access"
    const tools = createTerminalTools({ service: spy.service, sandboxPolicy: () => ({ mode, workspaceRoot: "/ws" }) })
    const open = tools.find((t) => t.name === "terminal_open")!
    await open.execute({ command: "bash" }, {})
    expect(spy.opened).toHaveLength(1)
    // The mid-session tightening. THIS is the case a mount-time decision misses.
    mode = "read-only"
    const second = await open.execute({ command: "bash" }, {})
    expect(second).toMatchObject({ code: "SANDBOX_DENIED" })
    expect(spy.opened).toHaveLength(1)
  })
})
```

Add the same per-call assertion for `process_spawn` from `createProcessTools`, and one for `terminal_send` (it must refuse under a confined mode even though the PTY already exists).

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run --root packages/terminal test/sandbox-refusal.test.ts`
Expected: FAIL — `sandboxPolicy` is not a known dep, so nothing refuses and the writes reach the spy.

- [ ] **Step 4: Implement the refusal**

In `packages/terminal/src/tool.ts`:

```ts
export interface TerminalToolDeps {
  service: TerminalService
  cwd?: string
  /** Confinement for the PTY. Per CALL, like the fs write guard and the shell:
   * a mode that changes mid-session must reach the next call. Absent → no
   * sandbox was requested and nothing is refused. */
  sandboxPolicy?: () => import("@i-harness/sandbox").SandboxExecutionPolicy | undefined
}
```

```ts
/**
 * Terminal refusals are RETURNED, never thrown.
 *
 * A throwing tool body fails the whole turn — core-agent discards the batch and
 * appends no tool/result, so the model reads a hung call rather than an answer
 * (`packages/fs/src/error.ts` states the same rule for the fs tools; terminal
 * does not depend on `fs`, and pulling that package in for one helper would be
 * the wrong edge, so the shape is repeated here and pinned by a test).
 *
 * The returned object carries the SHARED denial (spec 3.2), so one rule covers
 * every surface a model can hit. `error` repeats the reason and the escalation
 * sentence in one string for a reader that only looks at `error`.
 */
function terminalRefusal(mode: SandboxMode, reason: string) {
  const denial = denialFor("terminal", mode, reason)
  return {
    error: denial.escalation === undefined ? denial.reason : `${denial.reason} ${denial.escalation}`,
    code: denial.code,
    denial,
  }
}

/** The confining mode in force for THIS call, or undefined when unconfined. */
function confinement(deps: TerminalToolDeps): SandboxMode | undefined {
  const policy = deps.sandboxPolicy?.()
  if (policy === undefined || policy.mode === "danger-full-access") return undefined
  return policy.mode
}
```

Then at the top of `terminal_open`, `process_spawn` and `terminal_send`:

```ts
      const mode = confinement(deps)
      if (mode !== undefined) {
        return terminalRefusal(
          mode,
          `refusing to start a PTY under ${mode}: an interactive terminal cannot be confined by the OS sandbox, so it would run unrestricted.`,
        )
      }
```

(`terminal_send`'s reason differs — name the live PTY, e.g. `...refusing to write to terminal ${args.id} under ${mode}: the PTY was started outside this mode and driving it would run unrestricted.`)

Leave `terminal_read`, `terminal_signal`, `terminal_close`, `terminal_list` untouched, with a one-line comment saying why they are deliberately not guarded.

Add the type imports (`denialFor`, and `SandboxMode` as a type) from `@i-harness/sandbox`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run --root packages/terminal`
Expected: PASS, including every pre-existing test in that package (nothing may regress when no resolver is supplied — that is the fifth test).

- [ ] **Step 6: Mutation proof**

In `confinement`, hoist the resolver to construction time:

```ts
  const frozen = deps.sandboxPolicy?.()   // deliberately wrong: resolved ONCE
```

and use `frozen` instead of calling per call. Run the test. Expected: **FAIL on "the policy is resolved PER CALL"** — the second `terminal_open` spawns. Restore.

- [ ] **Step 7: Wire the assembly**

Today the terminal is mounted at `assembly.ts:295`, **above** the sandbox policy resolver (`:316` onward), and the comment there claims the ordering mirrors `runHeadless`. The terminal now needs the resolver, so **move the `registerTerminal` call down to immediately before the `registerShell` call**:

```ts
  // M-p: the terminal is mounted HERE, not at the top of the environment, because
  // its tools resolve the sandbox policy per call and the resolver is defined
  // just above. Mount order does not affect disposal — `dispose()` tears the
  // terminal down explicitly by handle, not through the reverse-order mount list.
  const terminalMount: TerminalMountHandle = registerTerminal(ctx, tools, {
    cwd: opts.workspace,
    ...(sandboxPolicyService !== undefined ? { sandboxPolicy: sandboxPolicyNow } : {}),
  })
```

Delete or correct the old "Same sequence as runHeadless" comment. **Verified 2026-09-15: there is no second sequence to mirror.** `registerTerminal` has exactly one non-test caller in the repository (`assembly.ts:295`), and `runHeadless` (`apps/cli/src/run.ts:139`) does not mount anything itself — it calls `createSessionAssembly` at `:241` and lets the assembly compose. The comment describes an architecture that no longer exists, and leaving a comment that contradicts the code is the defect class this project has already paid for twice.

Note the guard on `sandboxPolicyService !== undefined`: a host that passed no `sandbox` gets no resolver, which is the correct pre-M16 behaviour (nothing refused). Do **not** pass the resolver when the service is absent "for symmetry" — the tools would then resolve `undefined` on every call for no reason.

- [ ] **Step 8: Write the wiring test**

Create `packages/session-executor/test/sandbox-terminal-refusal.test.ts`. Drive a real turn through a real assembly, following the mock-script shape in `packages/session-executor/test/workspace-cwd.test.ts:131-161`:

```ts
it("a read-only assembly refuses terminal_open and spawns nothing", async () => {
  // createSessionAssembly({ workspace, modelPolicy: "test-mock", mockScript: [
  //   { role: "assistant", toolCalls: [{ name: "terminal_open", args: { command: process.execPath, args: ["-e", "0"] } }] },
  //   { role: "assistant", text: "done" } ] , approveAll: true, sandbox: "read-only" })
  // then: the tool/result for terminal_open carries code "SANDBOX_DENIED" and
  // denial.surface === "terminal"; and
  // ctx.services.get<TerminalService>("terminal/service").list() is EMPTY.
})
```

Because the call is refused before any spawn, this test is fast — unlike the existing PTY test, it must not need a 30 s timeout.

The complementary control matters as much: a second test with **no** `sandbox` option must let `terminal_open` through, or the wiring could be refusing everything and the first test would still pass.

- [ ] **Step 9: Run the affected suites and commit**

`npx vitest run --root packages/terminal`, `npx vitest run --root packages/session-executor`, `pwsh -Command "pnpm -r typecheck"`, `node scripts/audit/check-thresholds.mjs`. Expect only the two known `workspace-cwd.test.ts` failures.

```bash
git add packages/terminal packages/session-executor/src/assembly.ts packages/session-executor/test/sandbox-terminal-refusal.test.ts
git commit -m "feat(sandbox): the terminal refuses capability-creating calls under a confined mode

The PTY cannot be kernel-confined, so terminal_open/process_spawn/terminal_send
now resolve the mode per call and return the shared denial instead of spawning
unrestricted. read/signal/close/list stay allowed — they can only observe or
shut down, and refusing them would strand live PTYs."
```

---

## Self-Review

**Spec coverage:** Spec §3.4's terminal half, in its corrected (2026-09-15) form. The fs-search half is deliberately not implemented — see the section above, which carries the evidence and the condition for revisiting it.

**The two failure modes this plan is written around:** (a) refusing at MOUNT time, which misses a mid-session tightening — pinned by the per-call test and its mutation proof; (b) throwing instead of returning, which fails the whole turn and reads to the model as a hung call — pinned by asserting on the returned object.

**Placeholder scan:** No TBD/TODO. Two steps deliberately point at existing code to copy rather than inlining it blind (`spyService` from `terminal.test.ts`, the mock-script shape from `workspace-cwd.test.ts`) — inventing a PTY service fake or an assembly mock script without reading the working ones would be worse than the pointer.

**Known risk this plan does not remove:** a PTY opened while the mode was permissive stays alive after a tightening. `terminal_send` is refused so it cannot be *driven*, and `terminal_signal`/`terminal_close` still work so it can be shut down, but the process itself is not killed by the mode change. Killing live PTYs on a tightening is a product decision this plan does not take; if it is wanted, it belongs with the escalation ladder (spec §3.3(b)(c)), which is the component that produces mid-session changes in the first place.
