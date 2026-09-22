# Sandbox Policy Per-Call Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the effective sandbox mode resolve at each capability call instead of once at assembly, and give shell and fs one shared denial shape that names which mode refused and how to ask for more.

**Architecture:** The assembly currently resolves `SandboxExecutionPolicy` once (`packages/session-executor/src/assembly.ts:298-303`) and both `registerShell` and the new fs `writeGuard` close over that value. `packages/sandbox-policy/src/session-mode.ts` already reads the session's last `sandbox/mode` event, so the mechanism exists — it is simply read once at construction. The fix is to pass a **resolver thunk** instead of a value, so each tool call resolves the policy it is about to act under. That makes a mid-session mode change take effect and is the precondition for the escalation ladder, which is by definition a mid-session mode change.

**Tech Stack:** TypeScript ESM, pnpm workspace, vitest, Node ≥22.18. Zero external dependencies.

**Spec:** `docs/superpowers/specs/2026-09-14-backend-permission-sandbox-design.md`

## Global Constraints

- **No production code change without a test that fails first**, and a mutation proof that the test actually exercises the change (temporarily break the implementation, confirm the test goes red, restore).
- **No new dependencies.** The repo is zero-external-dependency by policy; only `node:*` builtins and workspace packages.
- **Do not introduce a permission rule engine, a governance layer, or a second LLM danger classifier** (spec §5, binding).
- **Reads stay unrestricted.** `checkWrite` deliberately does not gate reads; do not "fix" that (spec §3.5, and `packages/sandbox-policy/src/paths.ts` explains why).
- **Keep `ALL THRESHOLDS PASS`:** `node scripts/audit/check-thresholds.mjs` must stay green.
- **Push to `origin/m62` only.**
- Existing known-red tests, unrelated to this work: `packages/session-executor/test/workspace-cwd.test.ts` (2, bash on PATH is WSL not Git Bash) and `apps/cli` shell retry/retention (2, same cause). Proven pre-existing by re-running with changes stashed.

---

### Task 1: Resolve the sandbox policy per call

**Files:**
- Modify: `packages/session-executor/src/assembly.ts:298-303` (policy creation), `:304-310` (shell), `:368` (fs guard)
- Test: `packages/session-executor/test/sandbox-policy-per-call.test.ts` (create)

**Interfaces:**
- Consumes: `createSandboxPolicy(config).resolve(request?)` from `@i-harness/sandbox-policy` — already exported; `resolve` calls `effectiveSandboxMode(session.events)`, a reverse scan returning the last `sandbox/mode` event's mode or `undefined`.
- Produces: nothing shared yet. This task only changes when the policy is read.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createMockClient } from "@i-harness/llm-mock"
import { createSession, append } from "@i-harness/core-session"
import { createSessionExecutor } from "@i-harness/core-agent"
import { createSessionAssembly } from "../src/assembly.ts"

describe("sandbox policy is resolved per call", () => {
  it("a sandbox/mode event appended mid-session takes effect on the NEXT tool call", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-percall-"))
    const workspace = join(base, "ws")
    const outside = join(base, "outside")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const target = join(outside, "written.txt")
    const session = createSession()
    append(session, { type: "user/message", text: "write it" })
    // Start permissive, then tighten BEFORE the write happens.
    const assembly = await createSessionAssembly({
      workspace,
      session,
      model: createMockClient([
        { role: "assistant", text: "noted" },
      ]),
      approveAll: true,
      sandbox: "danger-full-access",
    })
    try {
      append(session, { type: "sandbox/mode", mode: "read-only" })
      // Resolve through the assembly's own path: the guard must see read-only now.
      const guard = (assembly as unknown as { writeGuardForTest?: (p: string) => { ok: boolean } }).writeGuardForTest
      expect(guard).toBeDefined()
      expect(guard!(target).ok).toBe(false)
      expect(existsSync(target)).toBe(false)
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/session-executor test/sandbox-policy-per-call.test.ts`
Expected: FAIL — `assembly.writeGuardForTest` is `undefined`, because the guard is a local const closed over a value resolved at construction.

- [ ] **Step 3: Replace the resolved value with a resolver thunk**

In `packages/session-executor/src/assembly.ts`, replace the block at `:298-303`:

```ts
  // M16 → per-call: resolve the effective policy at each use instead of once here.
  // `resolve` re-reads the session's LAST `sandbox/mode` event, so a mid-session
  // change (which the escalation ladder is) now takes effect. The SERVICE is built
  // once; only `resolve()` runs per call.
  const sandboxPolicyService =
    opts.sandbox === undefined ? undefined : createSandboxPolicy({ mode: opts.sandbox, workspaceRoot: opts.workspace })
  const sandboxPolicyNow = () => sandboxPolicyService?.resolve({ session: opts.policySession ?? session })
```

**`opts.policySession ?? session`, not `opts.policySession`.** Resolving against the LIVE session is what the spec requires (§3.1). `run.ts` passes the same object for both so it is unchanged there, but the web `createSessionService` path never passes `policySession` — with `policySession` alone the resolver sees `undefined` forever, a mid-session mode change is invisible, and the escalation ladder this task exists to unblock stays unreachable on the multi-turn surface.

This requires moving `const session = opts.session ?? createSession(...)` roughly four lines earlier so this block and the `registerShell` value below resolve through one resolver. That move belongs in the task's diff.

**CORRECTION (2026-09-14, during execution):** this step originally read `opts.policySession` alone, which contradicted this task's own test — the test passes the session as `session`, never as `policySession`, so `resolve` would see `undefined`, the mode would stay at the requested value, and the test would have failed even with the change applied. The implementer caught it before committing.

At `:304-310`, **leave the shell registration unchanged for now** — it still receives a resolved value, because `ShellToolDeps.sandboxPolicy` stays `SandboxExecutionPolicy` until Task 2 converts it to a thunk. Passing the thunk here would not typecheck. Task 2 owns that conversion:

```ts
  registerShell(ctx, tools, {
    timeoutMs: shellTimeoutMs,
    retention: opts.shellRetention ?? { maxBytes: 64_000 },
    cwd: opts.workspace,
    ...(sandboxProvider !== undefined ? { sandbox: sandboxProvider } : {}),
    ...(sandboxPolicyNow() !== undefined ? { sandboxPolicy: sandboxPolicyNow() } : {}),
  })
```

At `:368`, the fs guard becomes a live resolution:

```ts
  const writeGuard = sandboxPolicyService === undefined ? undefined : (abs: string) => {
    const policy = sandboxPolicyNow()
    return policy === undefined ? { ok: true as const } : checkWrite(policy, abs)
  }
```

Then add a test seam immediately after `createSessionAssembly`'s return object is built — expose the guard under an explicitly test-only name so the seam is obvious and greppable:

```ts
  // TEST SEAM: the guard is otherwise unreachable from outside. Named so a reader
  // cannot mistake it for API.
  ;(assembly as unknown as { writeGuardForTest?: unknown }).writeGuardForTest = writeGuard
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root packages/session-executor test/sandbox-policy-per-call.test.ts`
Expected: PASS

- [ ] **Step 5: Mutation proof**

Temporarily change `writeGuard` back to closing over a once-resolved value:

```ts
  const frozen = sandboxPolicyNow()
  const writeGuard = frozen === undefined ? undefined : (abs: string) => checkWrite(frozen, abs)
```

Run the test. Expected: **FAIL** (the appended `read-only` event is not seen). Restore.

- [ ] **Step 6: Measure the per-call scan cost**

Add a temporary timing harness in the test file:

```ts
  it("MEASURE: effectiveSandboxMode scan cost", () => {
    const session = createSession()
    for (let i = 0; i < 20_000; i += 1) append(session, { type: "user/message", text: "x" })
    const t0 = performance.now()
    for (let i = 0; i < 1_000; i += 1) effectiveSandboxMode(session.events)
    const perCall = (performance.now() - t0) / 1_000
    console.log(`scan over ${session.events.length} events: ${perCall.toFixed(3)} ms/call`)
    expect(perCall).toBeLessThan(5)
  })
```

Run it and **record the measured number in the commit message.** If it exceeds ~0.5 ms per call, do NOT add a cache in this task — open a follow-up instead, because a cache needs an invalidation rule and inventing one without a measured need is the wrong trade (spec §7 flags this).

- [ ] **Step 7: Commit**

```bash
git add packages/session-executor/src/assembly.ts packages/session-executor/test/sandbox-policy-per-call.test.ts
git commit -m "feat(sandbox): resolve the policy per call instead of once at assembly

<measured scan cost here>"
```

---

### Task 1b: Close the three findings Task 1's review left open

**Why this is a task and not a footnote.** Task 1 moved *enforcement* to per-call and left the *prompt* at mount time. Before Task 1 both were frozen together — stale, but consistent. After it they can disagree, and `assembly.ts:305-315` / `:658-663` still assert the invariant ("prompt and enforcement can never drift") that Task 1's own change broke. A comment claiming an invariant the code no longer satisfies is a defect in shipped code, not a wording preference. The prompt fragment also says **"Current DSH file policy"** — and it is not current. Task 2 widens the same drift to the shell, and Task 3 supplies the producer (a mid-session mode change) that makes it reachable.

**Files:**
- Modify: `packages/session-executor/src/assembly.ts` (`:130-135` doc; `:305-315` and `:658-663` comments; the system-prompt composition)
- Modify: `packages/core-agent/src/index.ts` (`AgentConfig.systemPrompt` at `:39`; the request construction at `:219`)
- Test: `packages/session-executor/test/sandbox-policy-per-call.test.ts` (extend)

**Interfaces:**
- Produces: `AgentConfig.systemPrompt: string | (() => string)` — resolved once per step. Additive: every existing caller passes a string and is unaffected; the loop already reads `deps.systemPrompt` at `:219` inside the step loop, so no loop restructuring.

- [ ] **Step 1: Correct the contract the code already changed (review I-1)**

`AssemblyOptions.policySession` (`:130-135`) still documents the pre-ruling contract — "Absent → resolve against nothing" — which is the **opposite** of shipped behavior and would tell a Task 2/3 implementer to resolve against the wrong thing. Replace the body with the shipped rule:

```ts
  /** The session the sandbox policy resolution READS for `sandbox/mode` events.
   * Defaults to the LIVE session (`opts.policySession ?? session`): a host that
   * passes only `session` (the web service) would otherwise resolve against
   * nothing forever and never observe a mid-session change. `run.ts` passes the
   * same object for both, so it is unaffected either way.
   *
   * ONLY events appended after the assembly is constructed count. Restored
   * history records decisions made by EARLIER runs; letting it win would enforce
   * them over the mode THIS run requested — `--resume X --sandbox read-only` on a
   * session once escalated would run unrestricted. */
```

- [ ] **Step 2: Pin the precedence branch (review M-3(d))**

No test covers the branch where `policySession` is a **different object** from the live `session`. Add to `sandbox-policy-per-call.test.ts`, inside the existing "restored history does not decide the sandbox mode" describe:

```ts
  it("a distinct policySession is what resolution reads, not the live session", async () => {
    const live = createSession()
    const policySession = createSession()
    append(live, { type: "user/message", text: "go" })
    const assembly = await createSessionAssembly({
      workspace, session: live, policySession,
      model: modelWritingTargets([first, second]),
      approveAll: true,
      sandbox: "danger-full-access",
    })
    try {
      // CONTROL: the LIVE session tightens. Resolution does not read it, so the
      // write still lands — this is what makes the next assertion meaningful
      // rather than a test that would pass if resolution read nothing at all.
      append(live, { type: "sandbox/mode", mode: "read-only" })
      await runTurn(assembly)
      expect(readFileSync(first, "utf8")).toBe("escaped")

      // The resolution session tightens; the NEXT call must obey it.
      append(policySession, { type: "sandbox/mode", mode: "read-only" })
      await runTurn(assembly)
      expect(existsSync(second)).toBe(false)
    } finally { await assembly.dispose(); rmSync(base, { recursive: true, force: true }) }
  })
```

- [ ] **Step 3: Mutation proof for Step 2**

Change `const policyBase = opts.policySession ?? session` to `const policyBase = session`. Run the test. Expected: **FAIL on the second assertion** — the tightened `policySession` is ignored and the write lands. Restore.

- [ ] **Step 4: Make the system prompt actually current (review M-2)**

In `packages/core-agent/src/index.ts`:

```ts
export interface AgentConfig {
  /** Prompt for every request. A STRING is fixed for the session. A FUNCTION is
   * resolved at the start of each step, for prompts that carry a fact the
   * session can change while the agent runs (the sandbox policy: see
   * session-executor/src/assembly.ts). */
  systemPrompt: string | (() => string)
```

and at `:219`:

```ts
        systemPrompt: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt,
```

In `packages/session-executor/src/assembly.ts`, keep the base prompt and the plan-mode fragment as they are, but build the policy fragment per request from the SAME resolver the guards use, memoised by mode so the request stays byte-identical until the mode actually changes (a stable prefix matters to provider-side prompt caching):

```ts
    // The fragment says "Current", so it must BE current. Both the guards and
    // this prompt read `sandboxPolicyNow()`, but the guards read it per CALL and
    // the prompt is re-read per STEP — so a mid-session mode change moves both,
    // and neither can describe a mode the other is not enforcing. Composed once
    // per distinct mode: unchanged mode → identical string → stable prefix.
    let promptCache: { mode: SandboxMode | undefined; text: string } | undefined
    const systemPromptNow = (): string => {
      const mode = sandboxPolicyNow()?.mode
      if (promptCache !== undefined && promptCache.mode === mode) return promptCache.text
      const policy = sandboxPolicyNow()
      const text = policy === undefined ? baseSystemPrompt : `${baseSystemPrompt}\n\n${renderPolicyContext(policy)}`
      promptCache = { mode, text }
      return text
    }
```

where `baseSystemPrompt` is the existing preset/default + plan-mode composition. Then pass `systemPrompt: systemPromptNow` to `createAgent`, and keep the overhead estimate on a concrete string (`estimateAssemblyOverhead(systemPromptNow(), tools.schemas())`).

Correct the two comments that assert the invariant: `:305-315` ("the prompt and every enforcement site read through THIS one resolver" — the prompt read it once at mount) and `:658-663` ("composed ONCE … so prompt and enforcement cannot disagree" — that is exactly what changed).

- [ ] **Step 5: Test that the model is told the CURRENT mode**

Add to `sandbox-policy-per-call.test.ts`. Capture what the provider actually receives rather than reading assembly internals:

```ts
  it("the system prompt states the mode in force on the NEXT request", async () => {
    const prompts: string[] = []
    const inner = modelWritingTargets([target])
    const model = { stream: (req: LLMRequest) => { prompts.push(req.systemPrompt); return inner.stream(req) } }
    // ... construct with model, sandbox: "danger-full-access"
    // Turn 1 — mount-time mode.
    await runTurn(assembly)
    expect(prompts.at(-1)).toContain("danger-full-access")
    // The mode changes; the NEXT request must say so.
    append(session, { type: "sandbox/mode", mode: "read-only" })
    await runTurn(assembly)
    expect(prompts.at(-1)).toContain("read-only")
    expect(prompts.at(-1)).not.toContain("danger-full-access")
  })
```

- [ ] **Step 6: Mutation proof for Step 5**

Pass the mount-time string instead of the thunk (`systemPrompt: systemPromptNow()`). Run. Expected: **FAIL on the second assertion** — the model is still told `danger-full-access` while the guard refuses the write. Restore.

- [ ] **Step 7: Run the affected suites and commit**

`npx vitest run --root packages/session-executor`, `npx vitest run --root packages/core-agent`, `npx tsc -b` (or the repo's typecheck script), `node scripts/audit/check-thresholds.mjs`.

```bash
git add packages/core-agent/src/index.ts packages/session-executor/src/assembly.ts packages/session-executor/test/sandbox-policy-per-call.test.ts
git commit -m "fix(sandbox): the prompt must state the mode in force, not the mode at mount

Task 1 moved enforcement to per-call and left the prompt at mount time, so a
mid-session sandbox/mode event changed what the guards enforce without changing
what the model was told. The fragment says \"Current\"; it now is."
```

---

### Task 2: Shell resolves per call too, and one denial shape for both surfaces

**Files:**
- Modify: `packages/shell/src/index.ts:147`, `:240`, `:243`, `:260`, `:263`, `:277`
- Modify: `packages/fs/src/error.ts` (the shared code), `packages/fs/src/index.ts` (`guardWrite`), `packages/fs/test/fs-sandbox-guard.test.ts` (the stub guard at `:36-37`)
- Modify: `packages/session-executor/src/assembly.ts` (`:407-413`, the production `writeGuard` — see the ruling below)
- Modify: `packages/sandbox/src/index.ts` (re-export), `packages/fs/package.json` (dependency + `pnpm install`)
- Create: `packages/sandbox/src/denial.ts`
- Test: `packages/shell/test/sandbox-per-call.test.ts` (create), `packages/sandbox/test/denial.test.ts` (create)

**Interfaces:**
- Consumes: `SandboxExecutionPolicy`, `SandboxMode`, `WIDER_MODES` — all from `@i-harness/sandbox`.
- Produces (all from `@i-harness/sandbox`):
  - `type SandboxSurface = "shell" | "fs" | "search" | "terminal"`
  - `interface SandboxDenial { code: "SANDBOX_DENIED"; surface: SandboxSurface; mode: SandboxMode; reason: string; escalation?: string }`
  - `function denialFor(surface: SandboxSurface, mode: SandboxMode, reason: string): SandboxDenial` — builds it, and fills `escalation` from `WIDER_MODES` when a wider mode exists.

**RULING (2026-09-15, controller — two plan defects found while pre-checking this task):**

1. **`denial.ts` lives in `@i-harness/sandbox`, not `@i-harness/sandbox-policy`.** `packages/fs` needs a dependency either way (it has neither package today — verified: its `node_modules/@i-harness` holds only `core-tools` and `text-diff`). `@i-harness/sandbox` is the lighter edge — zero dependencies of its own, whereas `sandbox-policy` pulls in `core-session` — and it is already the home of the vocabulary this shape quotes: `WIDER_MODES`, `ESCALATION_TARGETS`, `sandboxDenialMarker`, `escalationHintMarker`. Task 3 needs `ESCALATION_TARGETS` in `packages/fs/src/index.ts` too, so this single choice covers both tasks with ONE dependency. Spec §3.2 requires a unified shape; it does not name a package. Cost if wrong: a file sits in a different package than originally written down.

2. **The production `writeGuard` is in `assembly.ts`, and this task must convert it.** Changing `FsToolDeps.writeGuard`'s return type without touching `packages/session-executor/src/assembly.ts:407-413` fails to typecheck — the assembly is the only production producer of that predicate. The plan originally listed only the fs side. Cost if wrong: none; the original text did not compile.

**Dependency step, do this FIRST (both tasks depend on it):**

```bash
# packages/fs/package.json → dependencies gains:
#   "@i-harness/sandbox": "workspace:*"
pnpm install
```

Without the `pnpm install` the symlink is never created and `import ... from "@i-harness/sandbox"` fails to resolve (`moduleResolution: "bundler"`, no tsconfig `paths`, so resolution goes through `node_modules`).

**CORRECTIONS FOUND DURING EXECUTION (2026-09-15) — four defects in this task's text, all now fixed here.**

The implementer found two that the pre-check did not. Both are recorded because the pattern matters: **all four are text that still described the pre-ruling task while the steps around it had moved.**

1. **The file list omitted `packages/shell/test/shell.test.ts`.** Its `sandboxPolicy:` case passed a policy **value**, so under the new thunk interface `createShellTools` throws `TypeError: deps.sandboxPolicy is not a function` **at construction** — the whole file fails, not one test. Converted to a thunk with its original assertions kept. Add it to the Files list above.

2. **Step 7's test sketch could not support its own Step 8 mutation proof — it was vacuous.** As sketched (one `execute`, assert `seen[0]?.mode`) it **passes against a module-scope snapshot**, because building the tool set per call re-runs the resolver either way. The implementer's first draft had exactly that flaw and the mutation exposed it. Rewritten to build the tool set ONCE and assert the full call sequence across two calls — the only shape that distinguishes per-call resolution from a snapshot. **This is the most important of the four: a plan whose own verification step cannot fail is worse than no verification, because it returns a green result that means nothing.**

3. **Step 9's `git add` line was stale** — see the correction at that step; it would have omitted the new `packages/sandbox` package, the assembly conversion, `package.json` and `pnpm-lock.yaml`.

4. `packages/sandbox-policy` is correctly untouched, so the original line's `git add packages/sandbox-policy` would have staged nothing at all — harmless in itself, and exactly what made defect 3 invisible.

- [ ] **Step 1: Write the failing test for the shared shape**

```ts
import { describe, expect, it } from "vitest"
import { denialFor } from "../src/denial.ts"

describe("denialFor", () => {
  it("names the surface, the mode, and how to ask for more", () => {
    const d = denialFor("fs", "read-only", "refusing to modify /etc/hosts")
    expect(d.code).toBe("SANDBOX_DENIED")
    expect(d.surface).toBe("fs")
    expect(d.mode).toBe("read-only")
    expect(d.reason).toContain("/etc/hosts")
    // read-only has wider modes; the denial must say so, or a model cannot recover.
    expect(d.escalation).toContain("workspace-write")
  })

  it("omits escalation guidance when no wider mode exists", () => {
    const d = denialFor("shell", "danger-full-access", "unreachable in practice")
    expect(d.escalation).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --root packages/sandbox test/denial.test.ts`
Expected: FAIL — cannot resolve `../src/denial.ts`.

- [ ] **Step 3: Implement `packages/sandbox/src/denial.ts`**

Intra-package imports (it is the same package as the vocabulary — do not import `@i-harness/sandbox` from inside it):

```ts
import type { SandboxMode } from "./index.ts"
import { WIDER_MODES } from "./escalation.ts"

export type SandboxSurface = "shell" | "fs" | "search" | "terminal"

export interface SandboxDenial {
  code: "SANDBOX_DENIED"
  surface: SandboxSurface
  mode: SandboxMode
  reason: string
  escalation?: string
}

export function denialFor(surface: SandboxSurface, mode: SandboxMode, reason: string): SandboxDenial {
  const wider = WIDER_MODES[mode]
  const out: SandboxDenial = { code: "SANDBOX_DENIED", surface, mode, reason }
  if (wider !== undefined && wider.length > 0) {
    out.escalation =
      `If this operation is genuinely required, retry it with sandbox_permissions set to "${wider[0]}" and a justification. ` +
      `That requests a wider mode for this call and may be approved.`
  }
  return out
}
```

Export it from `packages/sandbox/src/index.ts` alongside the escalation block:

```ts
export { denialFor, type SandboxDenial, type SandboxSurface } from "./denial.ts"
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --root packages/sandbox test/denial.test.ts`
Expected: PASS

- [ ] **Step 5: Make the fs denial use the shared shape**

In `packages/fs/src/index.ts`, `guardWrite` currently throws `FsToolError("FS_SANDBOX_DENIED", decision.reason)`. Change `FsToolDeps.writeGuard`'s return type to carry the full denial:

```ts
  writeGuard?: (absPath: string) => { ok: true } | { ok: false; denial: import("@i-harness/sandbox").SandboxDenial }
```

and `guardWrite`:

```ts
function guardWrite(deps: FsToolDeps, target: string): void {
  if (deps.writeGuard === undefined) return
  const decision = deps.writeGuard(target)
  if (!decision.ok) throw new FsToolError("FS_SANDBOX_DENIED", JSON.stringify(decision.denial))
}
```

**Then convert the production producer** — `packages/session-executor/src/assembly.ts:407-413`. `checkWrite` still returns its own `PathDecision`, so the assembly wraps it:

```ts
  const writeGuard =
    sandboxPolicyService === undefined
      ? undefined
      : (abs: string) => {
          const policy = sandboxPolicyNow()
          if (policy === undefined) return { ok: true as const }
          const decision = checkWrite(policy, abs)
          return decision.ok ? { ok: true as const } : { ok: false as const, denial: denialFor("fs", policy.mode, decision.reason) }
        }
```

(`denialFor` needs importing from `@i-harness/sandbox` in that file.)

Finally update the stub guard in `packages/fs/test/fs-sandbox-guard.test.ts:36-37` to return `{ ok: false, denial: { code: "SANDBOX_DENIED", surface: "fs", mode: "read-only", reason: \`denied: ${abs}\` } }`, and change the assertion at `:54` so it parses the thrown message back to that object instead of matching the substring "denied" — a substring check would pass on the word `SANDBOX_DENIED` even if the reason were dropped.

- [ ] **Step 6: Make the shell resolve per call**

In `packages/shell/src/index.ts`, change both `sandboxPolicy?: SandboxExecutionPolicy` declarations (L147, L277) to:

```ts
  sandboxPolicy?: () => SandboxExecutionPolicy | undefined
```

and each call site (L240, L243, L260, L263) from:

```ts
...(deps.sandboxPolicy ? { sandbox: deps.sandboxPolicy } : {})
```

to:

```ts
...(sandboxResolved !== undefined ? { sandbox: sandboxResolved } : {})
```

with, at the top of each tool's `execute`:

```ts
      const sandboxResolved = deps.sandboxPolicy?.()
```

- [ ] **Step 7: Write the shell per-call test**

```ts
it("the shell resolves the policy at each call", async () => {
  const seen: Array<SandboxExecutionPolicy | undefined> = []
  const deps = {
    exec: fakeExec(seen),
    sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    cwd: "/ws",
  }
  const bash = createShellTools(deps).find((t) => t.name === "bash")!
  await bash.execute({ command: "true" }, {})
  expect(seen[0]?.mode).toBe("read-only")
})
```

(`fakeExec` captures the `sandbox` field of each `exec.run` call and returns a minimal result. Model it on the existing fakes in `packages/shell/test/`.)

- [ ] **Step 8: Mutation proof**

In `packages/shell/src/index.ts`, change `const sandboxResolved = deps.sandboxPolicy?.()` to call it once at module scope. Run the shell test. Expected: **FAIL**. Restore.

- [ ] **Step 9: Commit**

```bash
git add packages/sandbox packages/fs packages/shell packages/session-executor/src/assembly.ts pnpm-lock.yaml
git commit -m "feat(sandbox): one denial shape, and the shell resolves per call"
```

**CORRECTION (2026-09-15, controller):** this step originally read `git add packages/sandbox-policy packages/fs packages/shell`, written before the RULING block above moved `denial.ts` into `@i-harness/sandbox` and added the assembly to the file list. Taken literally it would have committed the shell and fs halves while **silently omitting the entire new vocabulary package, the production `writeGuard` conversion in `packages/session-executor/src/assembly.ts`, `packages/fs/package.json`, and `pnpm-lock.yaml`** — leaving a dirty tree and a commit that does not build. Recorded rather than quietly patched: it is the third defect in this task's text, all three from the same cause, which is that the correction touched the steps and not the boilerplate around them.

---

### Task 3: Declare the escalation arguments the marker text already advertises

**Files:**
- Modify: `packages/fs/src/index.ts` (write/edit/apply_patch schemas), `packages/shell/src/index.ts` (bash/pwsh schemas)
- Test: `packages/session-executor/test/sandbox-escalation-schema.test.ts` (create)

**Interfaces:**
- Consumes: `ESCALATION_TARGETS` from `@i-harness/sandbox` (already exported — verified in `packages/sandbox/src/index.ts:77`).
- Produces: nothing new; this task only makes existing marker text actionable.
- **Dependency:** `packages/fs` gains `@i-harness/sandbox` in **Task 2** (with the `pnpm install` that makes it resolve). `packages/shell` already declares it. Do not add it again here; if Task 2 has not landed, this task cannot compile.
- **ADDED 2026-09-15, approved by the user — a naming defect folded into this task.** `renderPolicyContext` (`packages/sandbox-policy/src/index.ts:45,47,49`) renders **"Current DSH file policy"** — a different product's name — into IH's own system prompt, in the same prompt whose first line is `DEFAULT_AGENT_PRESET`'s "You are I-harness" (`packages/preset/src/default.ts:14`). Change the three literals to name I-harness and add a test that pins the product name, so the wording cannot silently regress. It is folded in here rather than given its own task because it is three literals in a package this task does not otherwise touch — batching small mechanical edits is cheaper than a whole dispatch-and-review cycle.

  > **CORRECTION (2026-09-15, controller) — the justification originally written here was FALSE.** It claimed the three literals were "the ONLY `DSH` occurrences in shipped TypeScript", on the strength of a grep scoped to `packages/sandbox-policy/*` and `packages/session-executor/*` that was then quoted as a repo-wide fact. The real count is **138 lines across 21 files**. Task 3's implementer caught it.
  >
  > **The conclusion survives on evidence that was actually collected.** Classifying all 138 by position: **128 are comment lines** (deliberate parity notes naming DSH as the reference implementation — in `interaction`, `workspace`, `goal`, `feedback`, `web-host`), **8 are test names** carrying "(DSH parity)", and **2 are the negative assertions** Task 3 added. **Zero are user-visible product strings.** So the rendered prompt really was the one place it mattered — which is what the original note concluded, for a reason it had not checked.
  >
  > **Do not "finish the job" by renaming the other 137.** They are intentional references to what IH was built against; renaming them would destroy real information. The lesson is the one this plan keeps relearning: a **scoped query quoted as a general fact** — the fourth instance in this session, three of them mine.

**Context:** `packages/sandbox/src/escalation.ts` renders `sandboxDenialMarker` / `escalationHintMarker` text telling the model to pass `sandbox_permissions` and `justification` — and **no tool schema declares either argument**. D1 recorded this; it is the reason the ladder has no production caller.

- [ ] **Step 1: Write the failing test**

```ts
it("every write-capable and shell tool declares the escalation arguments", async () => {
  const names = ["write", "edit", "apply_patch", "bash", "pwsh"]
  const schemas = await toolSchemasFor(names)
  for (const name of names) {
    const schema = schemas[name]
    expect(schema, `${name} must be registered`).toBeDefined()
    // tools.schemas() returns { name, description, inputSchema, exposure } — the
    // schema is NESTED, and ToolSchema.inputSchema is typed `unknown`.
    const props = ((schema.inputSchema as { properties?: Record<string, unknown> }).properties) ?? {}
    expect(props.sandbox_permissions, `${name} must declare sandbox_permissions`).toBeDefined()
    expect(props.justification, `${name} must declare justification`).toBeDefined()
    const required = (schema.inputSchema as { required?: string[] }).required ?? []
    expect(required).not.toContain("sandbox_permissions")
    expect(required).not.toContain("justification")
  }
})
```

**CORRECTION (2026-09-15, controller — the seventh defect in this plan's text).** This sketch originally read `schemas[name].properties`, which is **`undefined`**: `ToolRegistry.schemas()` (`packages/core-tools/src/index.ts:199-210`) maps to `{ name, description, inputSchema, exposure }`, and `ToolSchema.inputSchema` is `unknown` (`:62`). A test written from the original sketch would have failed on a typo rather than on the missing arguments — and the `required` assertions are new here: declaring the arguments is not the same as requiring them, and a schema that required them would break every ordinary call.

(`toolSchemasFor` builds an assembly with `sandbox: "read-only"` and reads `tools.schemas()`; follow the pattern in `packages/session-executor/test/assembly.test.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --root packages/session-executor test/sandbox-escalation-schema.test.ts`
Expected: FAIL for all five names.

- [ ] **Step 3: Add the arguments**

To each of the five `inputSchema` objects:

```ts
        sandbox_permissions: {
          type: "string",
          enum: [...ESCALATION_TARGETS],
          description: "request a wider sandbox mode for THIS call when a denial says the operation needs one",
        },
        justification: {
          type: "string",
          description: "why the wider mode is required; shown to whoever approves the request",
        },
```

Do NOT add them to `required` — they are opt-in and their absence is the normal case.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --root packages/session-executor test/sandbox-escalation-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Mutation proof**

Remove `sandbox_permissions` from the `write` schema only. Run. Expected: **FAIL naming `write`**. Restore.

- [ ] **Step 6: Rename the product in the policy fragment (added 2026-09-15, user-approved)**

`renderPolicyContext` (`packages/sandbox-policy/src/index.ts:45,47,49`) renders **"Current DSH file policy"** into IH's own system prompt — a different product's name, in the same prompt whose first line is `DEFAULT_AGENT_PRESET`'s "You are I-harness" (`packages/preset/src/default.ts:14`). Verified: those three literals are the ONLY "DSH" occurrences in shipped TypeScript, and **no test pins the string**.

Write the failing test first, in `packages/sandbox-policy/test/policy.test.ts`:

```ts
  it("names THIS harness, not another product", () => {
    for (const mode of ["read-only", "workspace-write", "danger-full-access"] as const) {
      const text = renderPolicyContext({ mode, workspaceRoot: "/x" })
      expect(text).toContain("I-harness")
      expect(text).not.toContain("DSH")
    }
  })
```

Run it — expected FAIL on all three. Then change the three literals (`"Current DSH file policy"` → `"Current I-harness file policy"`, `"the DSH file sandbox"` → `"the I-harness file sandbox"`), re-run to PASS.

Mutation proof: put `DSH` back in the read-only literal only. Expected: **FAIL naming `read-only`**. Restore.

**Check before you commit that this did not break the callers**: `packages/session-executor/test/sandbox-policy-per-call.test.ts` asserts the fragment contains a mode name and not another mode name, and `apps/cli`'s M16 sandbox-prompt tests assert on the prompt. Run both suites and confirm they are green. Neither pins "DSH" (verified), but they are the two places that read this text.

- [ ] **Step 7: Commit**

```bash
git add packages/fs packages/shell packages/sandbox-policy packages/session-executor/test/sandbox-escalation-schema.test.ts
git commit -m "feat(sandbox): declare the escalation arguments the marker text advertises

Also renames the policy fragment's product name: it said \"Current DSH file
policy\" in IH's own system prompt, one line after the preset calls the harness
I-harness."
```

---

## Self-Review

**Spec coverage:** Spec §3.1 → Task 1, **and Task 1b, which closes the three findings Task 1's independent review returned** (the stale `policySession` contract, the untested precedence branch, and the prompt/enforcement drift Task 1 itself introduced). §3.2 → Task 2. §3.3(a) → Task 3. **§3.3(b)(c), §3.4 and §3.5 are NOT covered by this plan** and are not silently dropped: they need their own plans, and each has an open question the spec records (§7). Step 4 needs an approval-service design decision; step 5 needs an answer to "what would IH hide" before any code is worth writing.

**Placeholder scan:** No TBD/TODO. Every code step carries the actual code. Two steps deliberately measure rather than assert (`Task 1 Step 6`, and the shell test's `fakeExec` is specified by behaviour and pointed at existing fakes rather than inlined, because inventing an exec fake blind would be worse than copying a working one).

**Type consistency:** `SandboxDenial` is defined once in `packages/sandbox/src/denial.ts` and referenced by `fs`, `shell` and the `session-executor` assembly. `denialFor(surface, mode, reason)` has the same three-parameter shape everywhere it is called. `SandboxSurface` values match the four strings `denialFor`'s test asserts. The resolver thunk type `() => SandboxExecutionPolicy | undefined` is identical in `shell` (Task 2 Step 6) and the assembly (Task 1 Step 3).

**Plan defects found by pre-checking Task 2 (2026-09-15) and corrected in place:** (a) the production `writeGuard` lives in the assembly, not in `fs`, so a Task 2 that only changed `FsToolDeps` would not compile; (b) `packages/fs` depends on neither `@i-harness/sandbox` nor `@i-harness/sandbox-policy`, so the shared denial shape needs a declared workspace dependency plus `pnpm install` — the original text would have failed module resolution. Both are recorded in Task 2's RULING block rather than silently patched.

**Known risk this plan does not remove — RESOLVED during execution.** Task 1 originally reached its guard through a test-only `writeGuardForTest` property, and this paragraph offered exporting the resolver as the alternative. The implementer found the third option, which is better than both: `packages/session-executor/test/sandbox-fs-confinement.test.ts` already drives a real turn through `createSessionExecutor` and reads the model-visible `FS_SANDBOX_DENIED`, so the test can be end-to-end with ZERO production surface. A synthetic guard call was never needed. Both the seam and the export are dropped.

