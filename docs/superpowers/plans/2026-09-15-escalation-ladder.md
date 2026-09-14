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

**Files (corrected 2026-09-15 — the first list was written before Task 4 landed and named a file this task does not touch while omitting two it does):** Modify `packages/sandbox/src/index.ts` (re-export), `packages/sandbox/src/denial.ts` (+ `packages/sandbox/test/denial.test.ts`); create `packages/sandbox/src/call-policy.ts`, `packages/sandbox/test/call-policy.test.ts`. `packages/sandbox/src/escalation.ts` is listed for completeness only — **edit it only if a change is genuinely required; do not edit it to make this list true**, and say in the report whether it was touched.

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

The real seam is `packages/interaction/src/index.ts:26-28`: `approval/answerer` is registered as a **boolean-returning** function (`(req: ApprovalRequest) => (await fn(req)).approved`), normalized at the service boundary so a host returning `{ approved: false }` cannot fail open. `ApprovalRequest` is `{ name, reason, command?, argv?, dangerClass?, pathSummary? }` (`:5-13`) — a `(req: { name: string; reason: string }) => Promise<boolean>` is structurally assignable to it, which is why `ApprovalPrompt` needs no dependency on `interaction`. `ctx.services.get` **throws** when the service was never registered, so the `getAnswerer` getter must catch and return `undefined` → `"unavailable"`.

**IMPORT DIRECTION (added 2026-09-15) — a way to get it wrong.** `call-policy.ts` lives inside `@i-harness/sandbox` and `src/index.ts` will re-export it. Take **values** from the sibling modules directly (`approveEscalation`, `validateEscalationArgs`, `EscalationApprover` from `./escalation.ts`; `denialFor`, `SandboxDenial` from `./denial.ts`) and take **types only** from `./index.ts` via `import type` — a *value* import from `./index.ts` creates the runtime cycle `index → call-policy → index`, where the binding can be `undefined` at evaluation time. The precedent is already in the package: `denial.ts:1-2`.

**FIRST DECLARED ITEM — `denial.ts`'s header is FALSE, and this task is the one touching that package (added 2026-09-15; the first version of this paragraph was itself wrong).** `packages/sandbox/src/denial.ts:15-21` claims "`denialFor`'s only production caller is the assembly's write guard, which passes `"fs"` — so fs is the only surface emitting this object, and the shell still refuses the old way. … Task 3 (escalation arguments) does not change this". **Every clause is false** (verified repo-wide against `ceb85fb5`): `denialFor` has **two** production callers — `packages/session-executor/src/assembly.ts:438` (`"fs"`) and `packages/terminal/src/tool.ts:47` (`"terminal"`); the shell **does** emit the same shape (`packages/shell/src/index.ts:190-198`), built literally on purpose so it carries no escalation hint (`:169-176`); and `"search"` is the only surface still unwired — the §3.4 ruling, not an omission. Rewrite those lines so they are true, keeping the two distinctions that still hold: **who calls `denialFor`** is a different question from **who emits the shape**, and the shell's literal construction is a deliberate divergence, not an unfinished conversion. Comment-only — no test, no behaviour.

**SECOND DECLARED ITEM — `denialFor` must be able to express "no escalation guidance" (added 2026-09-15).** Spec §3.2 corollary 2 forbids an escalation hint on a refusal **of the escalation request itself**, but `denialFor` attaches one whenever a wider mode exists and its 4th parameter can only change *which* mode is named. Widen it to `escalationTarget?: SandboxMode | null`, where **`null` means "this refusal carries NO guidance"**; `undefined` keeps today's behaviour exactly, so fs, shell and terminal are byte-identical. Also enforce spec §3.2's new corollary 3: **an explicit target that is not strictly wider than `mode` is treated as no route at all (no hint)**, never advertised — `WIDER_MODES[mode].includes(target)` is the predicate, the same one `approveEscalation` uses (`escalation.ts:61`). Discriminating test: from **`workspace-write`** (where the default *does* attach guidance) assert `denialFor("fs", "workspace-write", "…", null).escalation` is `undefined` — asserting from `danger-full-access` would pass for the wrong reason (that mode has no wider mode).


**`resolveCallPolicy` order of operations — every branch, in this order. CORRECTED 2026-09-15: SEVEN branches, not six — the old branch 3 was too narrow and branch 4 is new.**

1. **Malformed pair** — `validateEscalationArgs(args.sandbox_permissions, args.justification)` inside `try/catch` (it throws when one is present without the other, or the justification is empty: `escalation.ts:12-25`) → `refused` with a denial on `surface`, mode `base?.mode ?? "danger-full-access"`, reason = the thrown message, **and `escalationTarget: null`** (spec §3.2 corollary 2: the request was wrong, and the thrown message already says how to fix it). *Reported mode when there is no policy is `danger-full-access`, which is accurate*: `sandboxPolicyNow()` is undefined only when the host requested no sandbox at all, and that is unconfined.
2. **No escalation arguments** — neither present → `proceed` with `base`. (No refusal, so no denial at all.)
3. **`base === undefined`** → **`proceed` with `undefined`, ignoring the args** (spec §3.3 point 5): there is no policy to escalate *from*, and `approveEscalation` requires a non-optional `effectiveMode`, so the request cannot be constructed. The call is already unrestricted.
4. **`base.mode === "danger-full-access"`** → **`proceed` with `base`, ignoring the args.** *New branch, 2026-09-15; read the reasoning before merging it into branch 5.* With no confinement there is nothing to escalate from, and the only thing `approveEscalation` could do is **throw `not strictly wider`** (`escalation.ts:61-63`) — i.e. a call that succeeds today (a model that habitually passes `sandbox_permissions`) would start being **refused** on an unconfined host. That is a regression with no security benefit: §3.2's denial only ever means "the mode in force does not permit this operation". So the args are vacuous here, not wrong.
5. **No approval channel** — `escalation === undefined`, or its `approver` is undefined → `approveEscalation` throws (`escalation.ts:64-66`) → `refused`, reason = the thrown message, **`escalationTarget: null`**. **Fail closed**: a host that composed no approval service gets a legible refusal, not a grant.
6. **Not granted** — `approveEscalation({ requestedMode, justification, effectiveMode: base.mode, subject }, escalation)` throws, for `rejected` / `cancelled` / `unavailable` (`:79-81`) or because the requested mode is not strictly wider (`:61-63`) → `refused`, reason = the thrown message, **`escalationTarget: null`** (all four are "your request was wrong").
7. **Granted** → `proceed` with `{ ...base, mode: granted }`.

Wrap branches 1, 5 and 6 in `try/catch`: both functions **throw**, and a throwing tool body fails the whole turn and appends no `tool/result` (spec §3.3 point 4; the same rule is written for fs at `packages/fs/src/error.ts:19-31`) — catch and return, never let it escape. **This is the most likely way to get this feature wrong.**

**Guidance decision for all seven branches, stated so none inherits one by accident:** 1 — none (malformed). 2/3/4/7 — no refusal, so no denial. 5/6 — none (the request, not the operation, was refused). **No branch of `resolveCallPolicy` emits escalation guidance**, and that is not an omission: this function only ever refuses the *request*, whereas `denialFor`'s guidance is for a refusal of an *operation* (what the fs guard and the terminal emit). Write that in a comment or the next reader will "fix" it.

- [ ] **Steps:** failing test for each of the **seven** branches (seven `it`s, each naming its branch in the title) + the `denialFor(…, null)` and not-strictly-wider-target tests above → implement → pass → **mutation proof: change branch 5 to fall through to `proceed` on a missing approver** and confirm the "no approval service" test goes red. **Two traps that make that proof vacuous:** (i) it only reddens if the test's requested mode is **strictly wider** than `base.mode`, because `approveEscalation` checks strictly-wider (`:61`) *before* approver-missing (`:64`) — a non-wider request throws at `:62` and the mutated code still returns `refused`; (ii) mutate **branch 5 alone**, since branch 6's test also expects `refused` and could redden a combined mutation while branch 5 stays unexercised. State in the report which single line was mutated. Then restore → confirm `git diff` is empty → commit.

---

### Task B: wire it into fs, shell and the assembly

**Files (corrected 2026-09-15 — `patch.ts` was missing, and it is the file that decides whether the fs guard still works):** Modify `packages/fs/src/index.ts` (+ `test/fs-sandbox-guard.test.ts`), **`packages/fs/src/patch.ts`**, `packages/shell/src/index.ts` (+ its sandbox tests), `packages/session-executor/src/assembly.ts`, `packages/session-executor/test/sandbox-escalation-schema.test.ts` (the terminal's three tools join its surface list); create `packages/session-executor/test/sandbox-escalation.test.ts`.

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

`messageFor(denial)` = `denial.reason` plus `denial.escalation` when present, so a reader that only looks at `error` still gets the recovery sentence. **A ladder refusal is returned AS ITSELF** — do not pass `resolution.denial` back through a surface's own refusal builder (`terminalRefusal`, say), because those re-attach an escalation sentence and would undo the `escalationTarget: null` that branches 1/5/6 exist to carry.

**`guardWrite` in `fs` becomes async — and that turns `packages/fs/src/patch.ts` into a FAIL-OPEN, SILENTLY (added 2026-09-15; the first version of this plan said only "`write`/`edit`/`apply_patch` already `await` through `softFail`", which is true of two of the three).**

`guardWrite` has **three** call sites, not two: `packages/fs/src/index.ts:163` (`write`) and `:207` (`edit`) call it directly in an async body, but `:272` reaches it through a **callback** — `applyPatch(…, (target) => guardWrite(deps, target))` — and `packages/fs/src/patch.ts:182` types that callback `(absPath: string) => void`, invoking it at `:189` as `guard?.(target)`, **not awaited**.

So if `guardWrite` becomes `async` and only the two direct call sites gain `await`:

- **TypeScript does not complain.** A `Promise<void>`-returning function is assignable to a `void`-returning callback type, and this repo has no lint rule for floating promises (`pnpm -r typecheck` is `tsc`).
- The guard runs only up to its first `await` and returns a pending promise; a refusal becomes an **unhandled rejection** while the loop continues — i.e. **every hunk of `apply_patch` is applied with the sandbox guard never having decided anything.** That is the multi-path write, the one you least want bypassed, and it is precisely the class of defect this plan keeps producing: a correction that edited the step and left the surrounding text describing the old shape.

Required, therefore: **`patch.ts:182` → `guard?: (absPath: string) => void | Promise<void>` and `:189` → `await guard?.(target)`** (it is already inside a `try`, and `applyPatch` is already `async`, so a refusal is still reported per-hunk alongside the others — `:180-181`). All **three** call sites gain `await`. The one test that catches a missed await is the pre-existing `packages/fs/test/fs-sandbox-guard.test.ts:109` (`apply_patch DENIES a hunk that resolves outside the workspace`) — it must stay green, and the report should say it was run.

**The base policy must be ONE read, shared with the guard (added 2026-09-15).** The assembly builds `writeGuard` as a closure over `sandboxPolicyNow()` (`assembly.ts:429-439`), re-read per call. Pass **that same thunk** as the new `FsToolDeps.sandboxPolicy`; do not build a second resolver for the fs tools. Otherwise the mode the ladder escalates *from* can differ from the mode the guard later checks (and `approveEscalation`'s strictly-wider test would be evaluated against one mode while the operation is judged under another).

**A stale comment this task owns (added 2026-09-15).** `packages/session-executor/src/assembly.ts:350-356` says the shell gets the resolver "so a mid-session mode change **(which the escalation ladder is)** reached the fs guard but not the shell". Spec §3.3 point 1 settles that the ladder is **per-call and transient** — it appends **no** `sandbox/mode` event and the standing mode never moves, so it is *not* a mid-session mode change and never was. This task edits exactly that registration, so it owns the comment: name the real producer (a host appending a `sandbox/mode` event) and say the ladder is a different path.

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

## Third declared item — the `edit` / `WRITE_TOOLS` asymmetry (added 2026-09-15, controller; user-delegated ruling)

**Folded in because it lands in the same subject (the approval service), not because it is part of the ladder.** Declare it to the reviewer as a stated item.

`packages/guard-approval/src/index.ts:54` is `const WRITE_TOOLS = new Set(["write"])`. Layer 2 is a directory whitelist — **inside the workspace allows, outside asks** — and a tool in neither `SHELL_TOOLS` nor `WRITE_TOOLS` falls to the Layer-1 fallback and asks **unconditionally**. `edit` carries a `path` argument exactly like `write` and is likewise `isReadOnly: false`, so today **an in-workspace `write` runs silently while the equivalent in-workspace `edit` prompts every single time.**

**The ruling: add `edit` to `WRITE_TOOLS`.** The reasons, so the change can be defended rather than merely made: (1) Layer 2's own comment states the intent, and an in-workspace `edit` *is* a write inside the workspace; (2) the asymmetry is **backwards on destructiveness** — `write` replaces a file wholesale and is pre-approved while the narrower `edit` is not, which pushes the model toward the more destructive tool; (3) **the loosening is nominal** — nothing becomes possible that was not possible before, since `write` already reaches every in-workspace byte without a prompt.

**`apply_patch` stays OUT, with the reason now written in the file.** It takes `patch_content` and can touch many paths, so Layer 2's single-`path` check cannot classify it. That reasoning appears nowhere today, which is exactly why the `edit` omission read as a bug rather than a decision — **an unstated exception and an oversight look identical.**

**Tests, both directions:** an in-workspace `edit` produces **no** ask; an out-of-workspace `edit` **still asks**; `apply_patch` **deliberately still asks** (pin the exception so a later reader cannot "fix" it). Note that today **every Layer-2 test in that package uses the tool name `"write"`** — nothing covers `edit` or `apply_patch`, which is how the asymmetry survived.

## Fourth declared item — the TERMINAL is a sixth surface (added 2026-09-15, controller)

Task 4 made the terminal refuse `terminal_open` / `process_spawn` / `terminal_send` under a confined mode, and **the terminal tool schemas declare neither argument** — precisely the defect Task 3 closed for `write`/`edit`/`apply_patch`/`bash`/`pwsh`: an instruction the model cannot act on. Task 4's implementer raised it itself.

**RULING: the terminal joins this task's scope.** Concretely:

1. Add `sandbox_permissions` + `justification` to those three tools in `packages/terminal/src/tool.ts` — the same shape and opt-in rule Task 3 used, and **not** in `required`.
2. Have the three refusing calls run the ladder before refusing, so a granted mode lets the PTY open **for that call**. Two traps:
   - **After a grant the confinement decision must use `resolution.policy`, not a fresh `deps.sandboxPolicy?.()` read.** A grant of `danger-full-access` is exactly what makes `confinement()` return `undefined`; re-reading the session thunk would refuse the very call that was just approved.
   - **Return the ladder's denial unchanged** (see `messageFor` above) — do **not** route it back through `terminalRefusal`, which rebuilds the denial through `denialFor(…, PTY_PERMITTED_MODE)` and would re-attach the escalation sentence that branches 1/5/6 set `escalationTarget: null` to withhold.
3. **Do NOT instead strip the escalation sentence from the terminal's denial.** That is the honest fallback if plumbing proves impractical, but it throws away a real capability — so it is a fallback, not the plan, and choosing it needs a recorded ruling.
4. The terminal's denial now names **`danger-full-access`** (`packages/terminal/src/tool.ts:31`, `PTY_PERMITTED_MODE`), not the first strictly-wider mode — that is Task 4's fix commit `ceb85fb5`, and `packages/terminal/test/sandbox-refusal.test.ts:286-305` plus `packages/session-executor/test/sandbox-terminal-refusal.test.ts:119-172` already pin it. Pin both directions: the terminal's **operation** refusal carries a hint naming the sufficient mode, while the **shell's** (no backend usable) carries none — `packages/shell/test/sandbox-refusal.test.ts:79`. Getting those two backwards is the mistake made while reviewing Task 4.
5. `packages/session-executor/test/sandbox-escalation-schema.test.ts` iterates the five declared surfaces; add the terminal's three tools so the declaration cannot silently regress.

**Verification item — `apps/cli/src/run.ts:257-261` (deferred minor #1, moved here).** Task 1's ledger flagged this comment as describing the pre-per-call resolution. **Read `packages/session-executor/src/assembly.ts:334-337` and either make it true or report it already true with the evidence** — do not rewrite it on the strength of this item alone: the floor is taken from **whichever session is actually read** (`policyBase`, which may not be the live one) and only events appended after construction count.


## Self-Review

**Spec coverage:** §3.3 (a) is the per-call plan's Task 3; this plan is (b) and (c). **§3.3 point 8 is a constraint**: nothing here adds a rule engine, changes the standing mode, or persists a grant.

**What this plan deliberately does not do:** there is no "remember this approval" path. `approval/answerer` returns a boolean per request and §5 rejects remembered-rule engines; if a host wants to stop asking, that is the host's answerer, not a new store here.

**Known risk this plan does not remove:** a granted call and the call before it are two separate model-visible steps, so the model must actually retry with the arguments. If it does not, nothing happens — the denial already told it how. That is the designed choreography (dsh's `escalation-ladder-and-approval-choreography`), not a gap.

**Second known limit:** the grant covers ONE call. A model that needs the same widening ten times asks ten times. That is intentional (`allowed-once`), and it is why the denial text says "retry this exact … once".
