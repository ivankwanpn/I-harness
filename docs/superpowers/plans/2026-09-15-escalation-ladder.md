# Escalation Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** make the `sandbox_permissions` / `justification` arguments that the tools already *declare* actually do something: the tool asks the host's approval service, and on approval runs **that one call** under the granted mode.

**Read the spec first:** `docs/superpowers/specs/2026-09-14-backend-permission-sandbox-design.md` §3.3 — eight numbered points, all read out of the code. They are the requirements; this plan is only the code. The three that decide the shape:

- escalation is **per-call and transient** (`allowed-once`), so it appends **no** `sandbox/mode` event and the standing mode never moves;
- **every non-grant path throws**, and a throwing tool body fails the whole turn and appends no `tool/result` — so the caller must catch and return;
- fs and shell must share **one** request-side path, for the same reason §3.2 requires one refusal shape.

**Depends on:** the per-call resolution plan's Tasks 1–3 (`denialFor`/`SandboxDenial` in `@i-harness/sandbox`; the escalation args declared in five tool schemas). **Task A cannot start before Task 3 of that plan lands** — it consumes `ESCALATION_TARGETS` and the declared args.

## Global Constraints

- No production code change without a test that fails first, plus a mutation proof (break it, confirm red, restore, confirm the tree matches HEAD).
- No new dependencies. `@i-harness/sandbox` stays **dependency-free** — the approval seam is reached through a **structural** type, never by importing `@i-harness/interaction`.
- **Never let an escalation failure throw out of a tool body.** A refusal is *returned*.
- Do not introduce a permission rule engine, a governance layer, or a second LLM danger classifier (spec §5, binding).
- Reads stay unrestricted. **The ladder only ever widens; it never narrows and never persists.**
- `ALL THRESHOLDS PASS`; push to `origin/m62` only.

---

### Task A: the escalation machinery in `@i-harness/sandbox`

**Files:** Modify `packages/sandbox/src/escalation.ts`, `packages/sandbox/src/index.ts`; create `packages/sandbox/src/call-policy.ts`, `packages/sandbox/test/call-policy.test.ts`.

**Interfaces produced:**
```ts
export type EscalationArgs = { sandbox_permissions?: string; justification?: string }

export type CallPolicyResolution =
  | { kind: "proceed"; policy: SandboxExecutionPolicy | undefined }
  | { kind: "refused"; denial: SandboxDenial }

/** Structural, so `sandbox` never imports `interaction`. */
export type ApprovalPrompt = (req: { name: string; reason: string }) => Promise<boolean>

export function createApprovalEscalationApprover(getAnswerer: () => ApprovalPrompt | undefined): EscalationApprover<unknown, string>

export interface EscalationContext {
  approver: EscalationApprover<unknown, string> | undefined
  agent: unknown
  callId: string
  toolName: string
  signal?: AbortSignal
}

export async function resolveCallPolicy(input: {
  base: SandboxExecutionPolicy | undefined
  surface: SandboxSurface
  subject: string          // e.g. "write to /etc/hosts" — goes into the approval reason
  args: EscalationArgs
  escalation?: EscalationContext
}): Promise<CallPolicyResolution>
```

**The adapter mapping (spec §3.3 point 2), in one place:**
`true → "allowed-once"` · `false → "rejected"` · **getter returns undefined → `"unavailable"`** — never a silent allow.

**`resolveCallPolicy` order of operations — every branch, in this order:**
1. `validateEscalationArgs(args.sandbox_permissions, args.justification)` inside `try/catch`. A malformed pair (one without the other, or an empty justification) → `refused` with `denialFor(surface, base?.mode ?? "danger-full-access", message)`. **Reported mode when there is no policy is `danger-full-access`, which is accurate**: `sandboxPolicyNow()` is undefined only when the host requested no sandbox at all, and that is unconfined.
2. Neither argument present → `proceed` with `base`.
3. `base === undefined` → **`proceed` with `undefined`, ignoring the args** (spec §3.3 point 5): there is no policy to escalate *from* and `approveEscalation` requires a non-optional `effectiveMode`, so the request cannot even be constructed. The call is already unrestricted.
4. `escalation === undefined`, or its `approver` is undefined → `approveEscalation` throws → `refused`. **Fail closed**: a host that wired no approval service gets a legible refusal, not a grant.
5. Otherwise `approveEscalation({ requestedMode, justification, effectiveMode: base.mode, subject }, escalation)` in `try/catch`; a throw (`rejected` / `cancelled` / `unavailable` / not-strictly-wider) → `refused` with the thrown message.
6. Grant → `proceed` with `{ ...base, mode: granted }`.

- [ ] **Steps:** failing test for each of the six branches above (six `it`s, each naming the branch in its title) → implement → pass → **mutation proof: change step 4 to fall through to `proceed` on a missing approver** and confirm the "no approval service" test goes red (this is the fail-closed test; if it does not go red, the ladder can grant without asking) → restore → commit.

---

### Task B: wire it into fs, shell and the assembly

**Files:** Modify `packages/fs/src/index.ts` (+ `test/fs-sandbox-guard.test.ts`), `packages/shell/src/index.ts` (+ its sandbox tests), `packages/session-executor/src/assembly.ts`; create `packages/session-executor/test/sandbox-escalation.test.ts`.

**Dependency steps:**
- `packages/fs` and `packages/shell` already depend on `@i-harness/sandbox` (added by the per-call plan's Task 2). Nothing to install.
- `packages/session-executor` already depends on `@i-harness/interaction` (`assembly.ts:29`) — that is where the approval answerer is read from.

**Interface changes, kept deliberately small:**

| Where | Change |
|---|---|
| `FsToolDeps` | **add** `sandboxPolicy?: () => SandboxExecutionPolicy \| undefined` (mirrors shell) and `escalationApprover?: EscalationApprover<unknown, string>` — the **approver**, not a prebuilt context; see the correction below |
| `FsToolDeps.writeGuard` | **gains a second parameter**: `(absPath: string, modeOverride?: SandboxMode) => { ok: true } \| { ok: false; denial: SandboxDenial }`. The override is the escalation grant — without it a granted mode could not reach the check. |
| `FsToolDeps` call sites | `guardWrite(deps, target)` → `guardWrite(deps, target, exec)` in `write`, `edit` and `apply_patch`: without `exec` the tool cannot reach `callId` for the approval |
| `ShellToolDeps` | **add** `escalationApprover?: EscalationApprover<unknown, string>`; `sandboxPolicy` stays the thunk it already is |
| `assembly.ts` | builds the approver once, passes it (plus `sandboxPolicy`) into both registrations, and gives `writeGuard` its override parameter |

**The tool-side flow, identical in both packages** (this is the part that must not be written twice with different semantics):

```ts
// The context is composed HERE, in the tool, because this is the only layer that
// has `exec`. Passing a prebuilt context in through deps is impossible -- the
// assembly mounts before any call exists.
const escalation = deps.escalationApprover === undefined ? undefined : {
  approver: deps.escalationApprover,
  agent: exec,
  callId: exec.callId ?? "unknown",
  toolName: "write",
  ...(exec.abortSignal !== undefined ? { signal: exec.abortSignal } : {}),
}

const resolution = await resolveCallPolicy({
  base: deps.sandboxPolicy?.(),          // shell / fs
  surface: "fs",                          // or "shell"
  subject: `write to ${path}`,            // or `run ${argv[0]}`
  args,                                   // the raw tool args carry the two fields
  ...(escalation !== undefined ? { escalation } : {}),
})
if (resolution.kind === "refused") {
  return { error: messageFor(resolution.denial), code: resolution.denial.code, denial: resolution.denial }
}
// proceed using resolution.policy — the widened one when a grant happened
```

`messageFor(denial)` = `denial.reason` plus `denial.escalation` when present, so a reader that only looks at `error` still gets the recovery sentence. `guardWrite` in `fs` becomes **async** to await the ladder; `write`/`edit`/`apply_patch` already `await` through `softFail`.

**Who builds the escalation context — CORRECTED 2026-09-15 (controller).** An earlier draft of this plan had the **assembly** build the whole `EscalationContext`, including `agent: exec` and `callId: exec.callId`. **That is impossible**: the assembly runs at mount time and has no `ToolExec`; `exec` exists only inside a tool body, per call. Written that way, `callId` would have been invented or left `"unknown"` for every escalation, and the approval prompt could not name the call it is asking about.

The split is forced by where the data lives:

- **The assembly supplies the approver only** — a pure function of `ctx`, built once:
  ```ts
  escalationApprover: createApprovalEscalationApprover(() => {
    try { return ctx.services.get<ApprovalPrompt>("approval/answerer") } catch { return undefined }
  })
  ```
  The getter is read **lazily per call**, so a host that registers its answerer after mounting still works.
- **The tool composes the context per call**, because it is the only layer holding `exec`:
  ```ts
  const escalation = deps.escalationApprover === undefined ? undefined : {
    approver: deps.escalationApprover,
    agent: exec,                       // the per-call ToolExec
    callId: exec.callId ?? "unknown",
    toolName: "write",                 // the tool's own name, not a variable the assembly cannot see
    ...(exec.abortSignal !== undefined ? { signal: exec.abortSignal } : {}),
  }
  ```

So the deps field is `escalationApprover?: EscalationApprover<unknown, string>`, **not** a prebuilt `EscalationContext`. Consequently `guardWrite` in `fs` must take the execution context: `guardWrite(deps, target, exec)` at each of its call sites (`write`, `edit`, `apply_patch`) — today it is called as `guardWrite(deps, target)` and has no way to reach `callId`.

- [ ] **Steps:** failing assembly test first — a `read-only` assembly whose model calls `write` to an outside path **with** `sandbox_permissions: "workspace-write"` + a justification must (a) ask, (b) on approval land the write, (c) on rejection leave the file absent and return a classified denial. Then implement. Then **mutation proof: strip the `modeOverride` argument at the fs call site** and confirm the granted-write test goes red (the grant would no longer reach `checkWrite`). Restore and commit.

## Self-Review

**Spec coverage:** §3.3 (a) is the per-call plan's Task 3; this plan is (b) and (c). **§3.3 point 8 is a constraint**: nothing here adds a rule engine, changes the standing mode, or persists a grant.

**What this plan deliberately does not do:** there is no "remember this approval" path. `approval/answerer` returns a boolean per request and §5 rejects remembered-rule engines; if a host wants to stop asking, that is the host's answerer, not a new store here.

**Known risk this plan does not remove:** a granted call and the call before it are two separate model-visible steps, so the model must actually retry with the arguments. If it does not, nothing happens — the denial already told it how. That is the designed choreography (dsh's `escalation-ladder-and-approval-choreography`), not a gap.

**Second known limit:** the grant covers ONE call. A model that needs the same widening ten times asks ten times. That is intentional (`allowed-once`), and it is why the denial text says "retry this exact … once".
