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
  const sandboxPolicyNow = () => sandboxPolicyService?.resolve({ session: opts.policySession })
```

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

### Task 2: Shell resolves per call too, and one denial shape for both surfaces

**Files:**
- Modify: `packages/shell/src/index.ts:147`, `:240`, `:243`, `:260`, `:263`, `:277`
- Modify: `packages/fs/src/error.ts` (the shared code), `packages/fs/src/index.ts` (`guardWrite`)
- Create: `packages/sandbox-policy/src/denial.ts`
- Test: `packages/shell/test/sandbox-per-call.test.ts` (create), `packages/sandbox-policy/test/denial.test.ts` (create)

**Interfaces:**
- Consumes: `SandboxExecutionPolicy` from `@i-harness/sandbox`; `SandboxMode` likewise.
- Produces:
  - `type SandboxSurface = "shell" | "fs" | "search" | "terminal"` (from `sandbox-policy`)
  - `interface SandboxDenial { code: "SANDBOX_DENIED"; surface: SandboxSurface; mode: SandboxMode; reason: string; escalation?: string }`
  - `function denialFor(surface: SandboxSurface, mode: SandboxMode, reason: string): SandboxDenial` — builds it, and fills `escalation` from `WIDER_MODES` when a wider mode exists.

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

Run: `npx vitest run --root packages/sandbox-policy test/denial.test.ts`
Expected: FAIL — cannot resolve `../src/denial.ts`.

- [ ] **Step 3: Implement `denial.ts`**

```ts
import type { SandboxMode } from "@i-harness/sandbox"
import { WIDER_MODES } from "@i-harness/sandbox"

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

Export it from `packages/sandbox-policy/src/index.ts`:

```ts
export { denialFor, type SandboxDenial, type SandboxSurface } from "./denial.ts"
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --root packages/sandbox-policy test/denial.test.ts`
Expected: PASS

- [ ] **Step 5: Make the fs denial use the shared shape**

In `packages/fs/src/index.ts`, `guardWrite` currently throws `FsToolError("FS_SANDBOX_DENIED", decision.reason)`. Change `FsToolDeps.writeGuard`'s return type to carry the full denial:

```ts
  writeGuard?: (absPath: string) => { ok: true } | { ok: false; denial: import("@i-harness/sandbox-policy").SandboxDenial }
```

and `guardWrite`:

```ts
function guardWrite(deps: FsToolDeps, target: string): void {
  if (deps.writeGuard === undefined) return
  const decision = deps.writeGuard(target)
  if (!decision.ok) throw new FsToolError("FS_SANDBOX_DENIED", JSON.stringify(decision.denial))
}
```

Update the fs test's stub guard to return `{ ok: false, denial: { code: "SANDBOX_DENIED", surface: "fs", mode: "read-only", reason: "denied" } }` and assert the error message parses back to that object.

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
git add packages/sandbox-policy packages/fs packages/shell
git commit -m "feat(sandbox): one denial shape, and the shell resolves per call"
```

---

### Task 3: Declare the escalation arguments the marker text already advertises

**Files:**
- Modify: `packages/fs/src/index.ts` (write/edit/apply_patch schemas), `packages/shell/src/index.ts` (bash/pwsh schemas)
- Test: `packages/session-executor/test/sandbox-escalation-schema.test.ts` (create)

**Interfaces:**
- Consumes: `ESCALATION_TARGETS` from `@i-harness/sandbox` (already exported).
- Produces: nothing new; this task only makes existing marker text actionable.

**Context:** `packages/sandbox/src/escalation.ts` renders `sandboxDenialMarker` / `escalationHintMarker` text telling the model to pass `sandbox_permissions` and `justification` — and **no tool schema declares either argument**. D1 recorded this; it is the reason the ladder has no production caller.

- [ ] **Step 1: Write the failing test**

```ts
it("every write-capable and shell tool declares the escalation arguments", async () => {
  const names = ["write", "edit", "apply_patch", "bash", "pwsh"]
  const schemas = await toolSchemasFor(names)
  for (const name of names) {
    const props = schemas[name].properties as Record<string, unknown>
    expect(props.sandbox_permissions, `${name} must declare sandbox_permissions`).toBeDefined()
    expect(props.justification, `${name} must declare justification`).toBeDefined()
  }
})
```

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

- [ ] **Step 6: Commit**

```bash
git add packages/fs packages/shell packages/session-executor/test/sandbox-escalation-schema.test.ts
git commit -m "feat(sandbox): declare the escalation arguments the marker text advertises"
```

---

## Self-Review

**Spec coverage:** Spec §3.1 → Task 1. §3.2 → Task 2. §3.3(a) → Task 3. **§3.3(b)(c), §3.4 and §3.5 are NOT covered by this plan** and are not silently dropped: they need their own plans, and each has an open question the spec records (§7). Step 4 needs an approval-service design decision; step 5 needs an answer to "what would IH hide" before any code is worth writing.

**Placeholder scan:** No TBD/TODO. Every code step carries the actual code. Two steps deliberately measure rather than assert (`Task 1 Step 6`, and the shell test's `fakeExec` is specified by behaviour and pointed at existing fakes rather than inlined, because inventing an exec fake blind would be worse than copying a working one).

**Type consistency:** `SandboxDenial` is defined once in `sandbox-policy/src/denial.ts` and referenced by `fs` and `shell`. `denialFor(surface, mode, reason)` has the same three-parameter shape everywhere it is called. `SandboxSurface` values match the four strings `denialFor`'s test asserts. The resolver thunk type `() => SandboxExecutionPolicy | undefined` is identical in `shell` (Task 2 Step 6) and the assembly (Task 1 Step 3).

**Known risk this plan does not remove:** Task 1's test seam (`writeGuardForTest`) is a production-object mutation for test reachability. It is named so it cannot be mistaken for API, but a cleaner seam would be to return the resolver from `createSessionAssembly`. I did not choose that because it widens the assembly's public surface for a test-only need; if a reviewer prefers the explicit export, that is a reasonable swap and changes only Task 1.
