# M1 Phase B — Wire the Unwired Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the `still-holds` rows of M1's measured reachability baseline and either wire each one to a production path or declare it deliberate with a reason, so that "this capability exists" stops being a claim the code does not honour.

**Architecture:** Phase A built the instrument (`scripts/audit/check-reachability.mjs`) and the baseline (`docs/audit/2026-09-15-reachability-baseline.md`). Phase B acts on its verdicts. Three of the nine items are real wiring (`sandbox/mode`'s missing producer, the `run` flag router, and three unconsumed export edges); the rest are adjudications that move rows to a reasoned allowlist. Every item was re-measured at HEAD by read-only research before this plan was written, and the research corrected the baseline in six places — those corrections are Tasks 6 and 7, because a milestone whose entire output is a claim about what was measured must not leave a wrong claim standing.

**Tech Stack:** TypeScript 5 (ESM, `.ts` extensions in relative imports), pnpm workspace (`packages/*` + `apps/*`), vitest per package, `tsc --noEmit` per package. No external runtime dependencies — this repo has none and this plan adds none.

**Spec:** `docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md` §1 (method and invariants) and §3.M1 (this milestone). The measured input is `docs/audit/2026-09-15-reachability-baseline.md` §4 (source-list verdicts) and §6 (the allowlist).

## Global Constraints

- **Backend only.** The existing TUI and web are **frozen and slated for replacement**: do not modify `apps/tui`, `packages/tui`, `packages/tui-core`, `packages/web`, `packages/web-host`, or `apps/cli/src/web.ts`. `apps/cli` (except `web.ts`) and `packages/*` are in scope.
- **Keep the tree compiling.** The frozen packages consume the engine's public API and are checked by `pnpm -r typecheck`. A change that breaks them is a change that breaks a package we agreed not to edit.
- **Plan vs spec (roadmap §3.M1, ruled 2026-09-15):** dropping an unconsumed `export` from a `private: true` workspace package is in scope for this plan; a change to an interface that in-repo code actually consumes, or to the `@i-harness/sdk` wire, is **M and needs its own spec** — it does not belong in Phase B.
- **Red-first, and mutation-proof.** A test that passes while the defect is present is not a test. Every task that changes behaviour must show the failure *before* the fix and name the mutation that would re-break it. Phase A spent two fix waves removing tests that passed under their own defect; do not add more.
- **The instrument is the acceptance check.** After every code task run `node scripts/audit/check-reachability.mjs` and record how the finding count moved. Do not adjust the tool to make a row disappear.
- **Never amend a reported commit.** `e8d4d9f`, `b4c128b`, `6fed2f0`, `5b01bc3`, `a9d0810`, `ad49e64`, `ca7bdf8`, `19975cb` have all been reported to the human and to reviewers. New commits only.
- **Verify before asserting.** Phase A's plan shipped five code snippets that were all broken on this repo, four of them silently returning nothing. Where this plan quotes a line, re-read it before editing; where it tells you to adapt an existing test's harness, read that test. If a quoted line does not match, stop and report rather than forcing the edit.
- **Read back every edited region verbatim** and confirm no splice damage — no duplicated line, no orphaned fragment. An earlier task in this milestone shipped a duplicated `return dir` that the self-test could not see and `git diff --numstat` reported as 0 deletions.
- **Line endings:** the worktree is CRLF; keep it CRLF and never introduce a BOM. Verify with a byte count after editing.
- **Gates** (run the focused one during a task, the wide one before the task's commit):
  - focused: `pnpm --filter <pkg> exec vitest run <file>` and `pnpm --filter <pkg> typecheck`
  - wide: `pnpm -r typecheck`, `pnpm -r --no-bail test`
- **Environment:** node v22.23.2; the pnpm CLI on this machine is 11.7.0 but `node_modules` was built by 10.34.5, so any install must be `npx --yes pnpm@10.34.5 install`. `bash` resolves to Git Bash, not WSL.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/session-executor/src/assembly.ts` | modify — add the construction-time `sandbox/mode` producer; drop two unconsumed exports | 1, 5 |
| `packages/session-executor/test/sandbox-escalation.test.ts` | modify — scope a zero-count assertion to post-construction events | 1 |
| `packages/session-executor/test/sandbox-policy-per-call.test.ts` | modify — new producer case + negative control | 1 |
| `packages/sandbox-policy/src/session-mode.ts` | modify — validate the reader against its own vocabulary | 2 |
| `packages/sandbox-policy/test/policy.test.ts` | modify — forged-mode case | 2 |
| `apps/cli/src/index.ts` | modify — run-path flag routing; strip `--no-compact` | 3 |
| `apps/cli/test/run-flag-routing.test.ts` | **create** — the red-first carrier for Task 3 | 3 |
| `packages/provider/src/index.ts` | modify — drop one `export` | 4 |
| `packages/plan-mode/src/index.ts` | modify — drop one `export` | 4 |
| `packages/session-executor/src/assembly.ts` | modify — drop a third `export` (`RewindAssemblyHandle`) | 5 |
| `packages/session-executor/test/assembly.test.ts` | modify — reroute two tests through the public surface | 5 |
| `docs/audit/2026-09-15-reachability-baseline.md` | modify — verdicts, allowlist, tally (Task 6); errata, post-Phase-B state, M2 inputs (Task 7) | 6, 7 |

---

### Task 1: `sandbox/mode` gets a production producer

The milestone's headline finding. Measured at HEAD: the event has **0 production producers** — 14 of its 17 test occurrences are `append(…)` calls and none is in production code — so `effectiveSandboxMode`'s non-default branch is dead and a host that states a mode at construction writes nothing. The two session-executor tests already append the event *as the host* and say so in-source; this task makes the assembly do what those tests simulate.

**Files:**
- Modify: `packages/session-executor/src/assembly.ts:9` (import) and `:337` (insert the producer)
- Modify: `packages/session-executor/test/sandbox-escalation.test.ts:105`
- Test: `packages/session-executor/test/sandbox-policy-per-call.test.ts`

**Interfaces:**
- Consumes: `append(session, event)` from `@i-harness/core-session`; `SessionEvent`'s existing `{ type: "sandbox/mode"; mode: SandboxMode }` member (`packages/core-session/src/index.ts:43`); `SessionAssemblyOptions.sandbox?: SandboxMode` (already exists, `assembly.ts` options type).
- Produces: nothing new. One extra durable event on sessions whose assembly was given a `sandbox` option. No signature changes.

- [ ] **Step 1: Read the three sites before touching them**

Read `packages/session-executor/src/assembly.ts:320-345` (the `policyBase` / `policyFloor` region), `packages/session-executor/test/sandbox-policy-per-call.test.ts:51-100` (the harness to copy), and `packages/session-executor/test/sandbox-escalation.test.ts:86-109`. If any line differs from what this plan quotes, stop and report.

- [ ] **Step 2: Write the failing test**

Append to the `describe("sandbox policy is resolved per call", …)` block in `packages/session-executor/test/sandbox-policy-per-call.test.ts`, reusing that file's existing imports and its `mkdtempSync`/`createSession`/`createSessionAssembly` setup style (lines 53-72):

```ts
  it("the assembly records the mode it starts under, so the resolver has a producer", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-producer-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    const session = createSession()
    const assembly = await createSessionAssembly({
      workspace,
      session,
      model: modelWritingTargets([]),
      sandbox: "read-only",
    })
    try {
      const modes = session.events.filter((e) => e.type === "sandbox/mode")
      expect(modes).toHaveLength(1)
      expect(modes[0]).toMatchObject({ type: "sandbox/mode", mode: "read-only" })
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("negative control: an assembly with no sandbox option writes no sandbox/mode event", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-producer-none-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    const session = createSession()
    const assembly = await createSessionAssembly({ workspace, session, model: modelWritingTargets([]) })
    try {
      expect(session.events.filter((e) => e.type === "sandbox/mode")).toHaveLength(0)
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 3: Run it and confirm both fail**

Run: `pnpm --filter @i-harness/session-executor exec vitest run test/sandbox-policy-per-call.test.ts`
Expected: the first case FAILS with `expected [] to have a length of 1`; the negative control PASSES (it is a control — it must pass before and after).

- [ ] **Step 4: Add the producer**

At `packages/session-executor/src/assembly.ts:9`, add `append` to the existing value import:

```ts
import { append, createSession, Inbox, subscribe, type Session } from "@i-harness/core-session"
```

Then insert immediately after `const policyFloor = policyBase.events.length` (`:337`), before the `sandboxPolicyNow` definition:

```ts
  // M1 Phase B: the CONSTRUCTION-TIME producer. Until this line the
  // `sandbox/mode` event had zero production producers -- 14 of its 17
  // occurrences were test `append(…)` calls -- so `effectiveSandboxMode`'s
  // non-default branch could never be taken and a host that stated the mode it
  // was starting under wrote nothing at all. The two session-executor tests
  // already append this event "as a HOST action, not the ladder's", and say so
  // in source; this makes the assembly do what they simulate.
  //
  // Appended ABOVE `policyFloor` deliberately: this is THIS run's decision, not
  // restored history, so the resume-escalation guard documented just above is
  // untouched. The ladder is still forbidden from producing this event
  // (call-policy.ts documents that; sandbox-escalation.test.ts pins it).
  if (opts.sandbox !== undefined) append(policyBase, { type: "sandbox/mode", mode: opts.sandbox })
```

- [ ] **Step 5: Run the new tests, then the package suite**

Run: `pnpm --filter @i-harness/session-executor exec vitest run test/sandbox-policy-per-call.test.ts`
Expected: PASS.

Run: `pnpm --filter @i-harness/session-executor test`
Expected: **one failure** — `sandbox-escalation.test.ts` line 105, which asserts zero `sandbox/mode` events on an assembly built with `sandbox: "read-only"`. That assertion is the ladder's mutation proof ("the grant moved nothing standing") and it must keep meaning that.

- [ ] **Step 6: Scope the escalation assertion instead of weakening it**

In `packages/session-executor/test/sandbox-escalation.test.ts`, capture a floor immediately after the assembly is constructed (before `try {` at `:86`) — the assembly variable is in scope there — and change `:105` to count only events appended after construction:

```ts
    const eventsAtConstruction = session.events.length
```

```ts
      // And the grant moved nothing standing: no `sandbox/mode` event was
      // appended by the ESCALATION (spec §3.3 point 1 -- per-call, transient).
      // Scoped to post-construction events on purpose: the assembly itself now
      // records the mode it was constructed under, and counting that event
      // would make this assertion unable to see a ladder-produced one.
      expect(
        session.events.slice(eventsAtConstruction).filter((e) => e.type === "sandbox/mode"),
      ).toHaveLength(0)
```

- [ ] **Step 7: Prove the scoped assertion still catches the defect it exists for**

Temporarily make the ladder produce an event — in `packages/session-executor/src/assembly.ts`, inside the escalation path that grants a wider mode, add `append(policyBase, { type: "sandbox/mode", mode: "workspace-write" })`. Run `pnpm --filter @i-harness/session-executor exec vitest run test/sandbox-escalation.test.ts`: it must FAIL at the Step-6 assertion. Remove the temporary line and re-run: PASS. Record both outputs in the report — this is the mutation proof for the scoped assertion.

- [ ] **Step 8: Run the instrument and record the delta**

Run: `node scripts/audit/check-reachability.mjs`
Expected: `729 ts files`, and the count is **unchanged at 525** — this task adds no failing scanner row. Record the exact line.

- [ ] **Step 9: Commit**

```bash
git add packages/session-executor/src/assembly.ts packages/session-executor/test/sandbox-escalation.test.ts packages/session-executor/test/sandbox-policy-per-call.test.ts
git commit -m "feat(sandbox): the assembly records the mode it starts under, giving sandbox/mode its first production producer"
```

**Do not claim the headline is discharged.** This wires a construction-time producer. The baseline's stronger claim — that a **mid-session tightening** is unreachable in production — survives this task, and **more strongly than this paragraph first stated (corrected 2026-09-15)**: no shipped surface can change a live mode. This paragraph used to name one — "the only shipped surface that could change a live mode is `/sandbox` in `apps/cli/src/web.ts`, which is frozen" — and **that is false**: measured, `/sandbox` writes `settings.sandboxMode` and answers that it takes effect for sessions created *later* (`apps/cli/src/web.ts:273-282`), and `:470-475` reads that setting once at construction, so it never appends a `sandbox/mode` event to a live session. A per-call escalation ladder is deliberately forbidden from producing the event either. Task 6 records that as a named open item.

---

### Task 2: the reader checks its own vocabulary

`effectiveSandboxMode` returns `ev.mode` with no membership check, and `SANDBOX_MODES` — the array that exists for exactly this — has no production use. Downstream, `checkWrite` treats an unrecognised mode as `workspace-write` (`packages/sandbox-policy/src/paths.ts:108,113,127` test only the two literals). Task 1 is what finally puts values into that path, so this hardens it in the same phase.

**Files:**
- Modify: `packages/sandbox-policy/src/session-mode.ts:6-12`
- Test: `packages/sandbox-policy/test/policy.test.ts`

**Interfaces:**
- Consumes: `SANDBOX_MODES` (already exported, `session-mode.ts:4`).
- Produces: `effectiveSandboxMode` keeps its signature `(events: readonly SessionEvent[]) => SandboxMode | undefined`. Only the value returned for an out-of-vocabulary event changes, from that value to either an older valid one or `undefined`.

- [ ] **Step 1: Write the failing test**

Add to `packages/sandbox-policy/test/policy.test.ts`, following that file's existing `effectiveSandboxMode` cases at `:13,21,27`:

```ts
  it("ignores a mode outside the vocabulary instead of returning it", () => {
    const events = [
      { type: "sandbox/mode", mode: "read-only" },
      { type: "sandbox/mode", mode: "host-root" as never },
    ] as unknown as SessionEvent[]
    expect(effectiveSandboxMode(events)).toBe("read-only")
  })

  it("returns undefined when the only mode is out of vocabulary", () => {
    const events = [{ type: "sandbox/mode", mode: "host-root" as never }] as unknown as SessionEvent[]
    expect(effectiveSandboxMode(events)).toBeUndefined()
  })
```

- [ ] **Step 2: Run it and confirm the first case fails**

Run: `pnpm --filter @i-harness/sandbox-policy exec vitest run test/policy.test.ts`
Expected: the first case FAILS with `expected 'host-root' to be 'read-only'`; the second PASSES already (it returns the forged value only when it is the sole event — verify this is genuinely the case before proceeding; if both pass, the vocabulary hole is not where this plan says it is and you must stop and report).

- [ ] **Step 3: Implement the check**

Replace `packages/sandbox-policy/src/session-mode.ts:6-12` with:

```ts
export function effectiveSandboxMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!
    if (ev.type !== "sandbox/mode") continue
    // The event is persisted and replayed, and `append` does not validate the
    // mode (core-session validates images and assistant-source only; logs loaded
    // from disk bypass validation entirely). An out-of-vocabulary value must not
    // reach `checkWrite`, which tests two literals and would silently treat
    // anything else as workspace-write -- a downgrade nobody asked for. Skip the
    // bad event and keep scanning, so a corrupt newest entry cannot discard a
    // valid older one.
    if (!SANDBOX_MODES.includes(ev.mode)) continue
    return ev.mode
  }
  return undefined
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @i-harness/sandbox-policy exec vitest run test/policy.test.ts`
Expected: PASS, both new cases and the three existing ones.

Run: `pnpm --filter @i-harness/sandbox-policy typecheck`
Expected: exit 0.

- [ ] **Step 5: Mutation proof**

Change `if (!SANDBOX_MODES.includes(ev.mode)) continue` to `if (false) continue`. Run the test file: the first new case must FAIL. Restore and re-run: PASS. Record both.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-policy/src/session-mode.ts packages/sandbox-policy/test/policy.test.ts
git commit -m "fix(sandbox-policy): a persisted sandbox/mode outside the vocabulary no longer decides the mode"
```

---

### Task 3: `i-harness run` stops turning flags into prompts

Two measured defects in one router. (a) `--help` after `run` survives the task filter and reaches `runHeadless` as a real turn whose prompt is `"--help"`. (b) **The baseline missed this one:** `--no-compact` is parsed as an eighth run flag at `:182` but is absent from the strip list at `:305`, so `i-harness run "do x" --no-compact` sends the model `do x --no-compact`.

The run path parses its argv **twice** — `:170-223` reads flag values, `:304-308` re-derives which tokens are flags in order to strip them — and that duplication is the shared cause of both defects. This task closes both at the router, which is the fix that cannot drift again; the larger single-table refactor is deliberately **not** taken here because it is a bigger diff for the same behaviour.

**Scope: the top-level `help` command is deliberately left alone.** It is not residue — `apps/cli/test/bin.test.ts:33-38` asserts it prints the subcommand list and the grok-style default, and `:72-75` ("documents the flag in help") is an M62 test that forces a new run flag to be documented there. Removing it would break both, delete the only on-demand way to read `USAGE`, and delete that enforcement. The run path gets **no** `--help` special case for a different and simpler reason: **`--help` after `run` is not a help request, it is an unrecognised flag**, and this task makes unrecognised flags errors. `--flag=value` stays unsupported and is declared deliberate in Task 6; what changes is that it now **fails loud** instead of being silently swallowed into the prompt.

*Optional and deliberately not done here:* `help` prints `USAGE` via `console.error` (`:161`) — the error channel — while returning exit 0, whereas the TUI's own handler writes to stdout (`apps/tui/src/index.ts:459`). Making them consistent would change stdout for a command scripts may parse, so it is a separate decision, not part of Task 3.

**Files:**
- Modify: `apps/cli/src/index.ts` — insert a guard at the top of the run path (after `:168`, before the `SettingsStore` load at `:188`) and add one clause at `:305`
- Create: `apps/cli/test/run-flag-routing.test.ts`

**Interfaces:**
- Consumes: nothing new. `main(argv: string[]): Promise<number>` is unchanged and stays the test seam.
- Produces: behaviour change only — an unknown dash-leading token in a `run` argv now returns `1` with usage on stderr instead of entering the prompt. No type or signature changes; no in-repo caller is affected.

- [ ] **Step 1: Read the two parse sites**

Read `apps/cli/src/index.ts:164-200` and `:300-335`. Confirm the eight flags the run path accepts (`--yes`, `--sandbox`, `--no-compact`, `--telemetry`, `--model`, `--api-key`, `--session-dir`, `--resume`), which five take values (`--sandbox`, `--model`, `--api-key`, `--session-dir`, `--resume`), and that `:305` currently lists only seven names. If the code differs, stop and report.

- [ ] **Step 2: Write the failing test**

Create `apps/cli/test/run-flag-routing.test.ts`. Take the `vi.mock` seam from `apps/cli/test/compaction-wiring.test.ts:23-32` — **but capture the task**, which that mock discards (`runHeadless: async (_task: string, opts…)`), because discarding it is measurably why nothing today can catch either defect:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest"

const calls: { task: string; opts: Record<string, unknown> }[] = []
vi.mock("../src/run.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/run.ts")>()
  return {
    ...actual,
    runHeadless: async (task: string, opts: Record<string, unknown>) => {
      calls.push({ task, opts })
      return { finalText: "", exitCode: 0 }
    },
  }
})

const { main } = await import("../src/index.ts")

beforeEach(() => { calls.length = 0 })

describe("run argv routing", () => {
  it("refuses a stray flag instead of sending it as the prompt", async () => {
    const code = await main(["node", "i-harness", "run", "--help"])
    expect(calls).toHaveLength(0)
    expect(code).toBe(1)
  })

  it("refuses a stray flag in any position", async () => {
    const code = await main(["node", "i-harness", "run", "hello", "--nope"])
    expect(calls).toHaveLength(0)
    expect(code).toBe(1)
  })

  it("does not leak --no-compact into the prompt", async () => {
    await main(["node", "i-harness", "run", "hello", "--no-compact"])
    expect(calls.map((c) => c.task)).toEqual(["hello"])
  })

  it("negative control: a flag-shaped word inside a quoted prompt is still the task", async () => {
    await main(["node", "i-harness", "run", "explain the --help flag"])
    expect(calls.map((c) => c.task)).toEqual(["explain the --help flag"])
  })

  it("value-skip control: a known value-taking flag consumes its value", async () => {
    await main(["node", "i-harness", "run", "hello", "--sandbox", "read-only"])
    expect(calls.map((c) => c.task)).toEqual(["hello"])
  })
})
```

- [ ] **Step 3: Run it and confirm the first three fail**

Run: `pnpm --filter @i-harness/cli exec vitest run test/run-flag-routing.test.ts`
Expected: case 1 FAILS with `calls` holding `task: "--help"`; case 2 FAILS the same way; case 3 FAILS with `task: "hello --no-compact"`; cases 4 and 5 PASS (controls).

**Do not run these tests against `bin.test.ts` or `cli.test.ts`.** `bin.test.ts:14-24` inherits the developer's real `IH_CONFIG_DIR` and `cli.test.ts:30-60` stands up a real fixture model, so a red test in either can start a real turn and spend real tokens. The mock above never reaches a model.

- [ ] **Step 4: Add the router guard**

Insert at the top of the run path, after the `if (args[0] !== "run")` block closes and before the settings load:

```ts
  // M1 Phase B: a FLAG must never become the prompt. `--help`/`-h` are handled at
  // :156-163 as `args[0]` only, so `i-harness run --help` fell through to the
  // filter at :304-308 -- which knows only the seven flags it strips -- and
  // reached runHeadless as a real turn whose prompt was "--help". The same hole
  // sent `--no-compact` (parsed at :182, absent from that filter) into the prompt
  // as `do x --no-compact`.
  //
  // The TOP-LEVEL `help`/`--help`/`-h` command at :156-163 is deliberately left
  // alone -- it is test-pinned as the documentation surface (bin.test.ts:33-38,
  // and ":72-75" forces a new run flag to appear in it). The run path gets no
  // `--help` case for a different reason: `--help` AFTER `run` is not a help
  // request, it is an unrecognised flag, and unrecognised flags are errors here.
  // That mirrors the file's own fail-loud stance (`--session-backend`: ":92-97";
  // `--resume`: ":225-235") rather than inventing a second help contract.
  const RUN_FLAGS = new Set(["--model", "--api-key", "--yes", "--session-dir", "--resume", "--telemetry", "--sandbox", "--no-compact"])
  const RUN_VALUE_FLAGS = new Set(["--model", "--api-key", "--session-dir", "--resume", "--sandbox"])
  const runArgs = args.slice(1)
  for (let i = 0; i < runArgs.length; i += 1) {
    const a = runArgs[i]!
    if (RUN_FLAGS.has(a)) continue
    if (i > 0 && RUN_VALUE_FLAGS.has(runArgs[i - 1]!)) continue
    if (a.startsWith("-")) {
      console.error(`i-harness run: unknown flag ${a} (a flag-like token would otherwise become the prompt)\n${USAGE}`)
      return Promise.resolve(1)
    }
  }
```

Do **not** widen the check at `:160` to scan every position: `apps/cli/test/bin.test.ts:44-46` runs `tui --help` and asserts the TUI prints `usage: tui`, which a position-agnostic check would pre-empt.

- [ ] **Step 5: Strip the eighth flag**

At the strip list (currently seven `===` clauses), add the eighth so the value is not leaked:

```ts
    if (a === "--model" || a === "--api-key" || a === "--yes" || a === "--session-dir" || a === "--resume" || a === "--telemetry" || a === "--sandbox" || a === "--no-compact") return false
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm --filter @i-harness/cli exec vitest run test/run-flag-routing.test.ts`
Expected: all five PASS.

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS. If `bin.test.ts` or `compaction-wiring.test.ts` fails, read the failure before changing anything — a genuine regression here means the router is rejecting an argv shape production uses.

- [ ] **Step 7: Mutation proof**

Delete the guard added in Step 4. Run the test file: cases 1 and 2 must FAIL. Restore. Then revert only the Step-5 clause: case 3 must FAIL. Restore. Record both.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/index.ts apps/cli/test/run-flag-routing.test.ts
git commit -m "fix(cli): run rejects an unknown flag instead of sending it as the prompt, and stops leaking --no-compact"
```

---

### Task 4: drop two unconsumed export edges

Both are bucket-A rows: genuinely dead declarations with no reference in their own module, so the §5.2 remediation ("drop the `export` keyword, do not delete the symbol") applies without the usual caution.

- `buildWireClient` — `packages/provider/src/index.ts:762`. Its only occurrences in the tree are its declaration and `packages/provider/test/provider.test.ts:2,43-47`. Its documented audience is the **frozen web build** and a T2 probe D1 already recorded as absent; the sibling it duplicates is the private `buildClient` at `:707`, which `buildModelClient` actually calls. Keep the header comment at `:739-746` — it is the only in-code statement of the resolved-wire-protocol requirement — and carry its substance into the commit message.
- `withdrawPlanModeTool` — `packages/plan-mode/src/index.ts:36`. Exactly one occurrence in the whole tree, and **not** in its own test file (`packages/plan-mode/test/plan-mode.test.ts:5` imports five other names). Wiring it would be wrong: the tool registry is created inside the assembly and dies with it, plan-mode OFF is a session-log event rather than a registry mutation, and the upstream design argues the opposite ("exit_plan_mode stays registered while plan mode is inactive, keeping the request tool catalog stable").

**Files:**
- Modify: `packages/provider/src/index.ts:762`
- Modify: `packages/plan-mode/src/index.ts:36`

**Interfaces:**
- Consumes: nothing.
- Produces: two names leave their package entry surfaces. Neither has an in-repo consumer; both packages are `private: true` with a single `"."` export, so nothing outside can name them either.

- [ ] **Step 1: Confirm both are still unconsumed**

Run: `git grep -n "buildWireClient" -- packages apps` and `git grep -n "withdrawPlanModeTool" -- packages apps`
Expected: for `buildWireClient`, its declaration plus `packages/provider/test/provider.test.ts`; for `withdrawPlanModeTool`, its declaration only. If either has a production caller now, stop and report — the baseline's verdict would have moved.

- [ ] **Step 2: Drop the keywords**

`packages/provider/src/index.ts:762`: `export function buildWireClient(` → `function buildWireClient(`
`packages/plan-mode/src/index.ts:36`: `export function withdrawPlanModeTool(` → `function withdrawPlanModeTool(`

- [ ] **Step 3: Typecheck both packages and their consumers**

Run: `pnpm --filter @i-harness/provider typecheck` and `pnpm --filter @i-harness/plan-mode typecheck`
Expected: both exit 0.

Run: `pnpm -r typecheck`
Expected: exit 0. This is the check that matters — the frozen TUI/web are in the same workspace and a consumer here would surface as a failure in one of their packages.

- [ ] **Step 4: Add the missing test for the plan-mode seam**

`withdrawPlanModeTool` has no test at all. Add one to `packages/plan-mode/test/plan-mode.test.ts` — extend its import list with `withdrawPlanModeTool` and add:

```ts
  it("withdrawPlanModeTool unregisters by name and is idempotent", () => {
    const registry = createToolRegistry(createContext())
    ensurePlanModeTool(registry, createSession())
    expect(registry.get("exit_plan_mode")).toBeDefined()
    withdrawPlanModeTool(registry)
    expect(registry.get("exit_plan_mode")).toBeUndefined()
    withdrawPlanModeTool(registry)
  })
```

Take the `createToolRegistry`/`createContext`/`createSession` imports from the existing file if present; otherwise import them from `@i-harness/core-tools`, `@i-harness/core-plugin` and `@i-harness/core-session`. **This test passes before and after the un-export** — it is not the guard for this change, it pins the seam so it cannot rot. Say so in the commit message rather than implying it is the red test.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @i-harness/provider test` and `pnpm --filter @i-harness/plan-mode test`
Expected: PASS.

- [ ] **Step 6: Run the instrument and record the delta**

Run: `node scripts/audit/check-reachability.mjs`
Expected: **523 findings** (down from 525 by two), and `@i-harness/provider#buildWireClient` and `@i-harness/plan-mode#withdrawPlanModeTool` gone from the output. Record the exact line and the new digest.

- [ ] **Step 7: Commit**

```bash
git add packages/provider/src/index.ts packages/plan-mode/src/index.ts packages/plan-mode/test/plan-mode.test.ts
git commit -m "refactor(provider,plan-mode): un-export two declarations that have no consumer on any production path"
```

---

### Task 5: drop three unconsumed export edges in session-executor

A variant the baseline never names: these are **alive inside their own module** with an unconsumed **file-level** export edge. `packages/session-executor/src/index.ts` re-exports exactly 14 names and none of these three; the only importer is the package's own test, through the relative path `../src/assembly.ts`.

| Name | Line | In-module use |
|---|---|---|
| `estimateAssemblyOverhead` | `assembly.ts:220` | called from the **`overheadEstimate` initializer** in `createSessionAssembly` |
| `bindAuthRefreshStatus` | `assembly.ts:234` | called from **`prepareMcpConfig`**'s `onAuthRefreshFailed` |
| `RewindAssemblyHandle` | `assembly.ts:166` | **not in the baseline** — a third name in the same position |

**2026-09-15 — the two call-site coordinates this table used to carry were stale, and the fix is to stop citing lines.** The table read `called at :762` and `called at :618`; at `m64` the two call sites are **`assembly.ts:786`** (`estimateAssemblyOverhead(systemPromptNow(), tools.schemas())`, the `overheadEstimate` initializer) and **`assembly.ts:642`** (`onAuthRefreshFailed: bindAuthRefreshStatus(…)`, inside `prepareMcpConfig`) — measured with `git grep -n "estimateAssemblyOverhead\|bindAuthRefreshStatus" -- packages/session-executor/src/assembly.ts`. The three declaration lines this table gives (`:166`, `:220`, `:234`) still match the file exactly, which is why only the mutation instruction rotted: **a plan that cites a line rots the next time the file moves, so cite the symbol.** Every reference to those call sites below is now by symbol rather than by line.

**Do not re-export them from the entry to "make them reachable".** That would manufacture three new class-1 rows (their only non-test mention would still be inside `assembly.ts`) — a net regression against M2's digest.

**Files:**
- Modify: `packages/session-executor/src/assembly.ts:166`, `:220`, `:234`
- Modify: `packages/session-executor/test/assembly.test.ts:19-24` and the two tests that call the helpers directly

**Interfaces:**
- Consumes: nothing.
- Produces: `packages/session-executor/src/index.ts` is **unchanged at 14 names** — that is the point. `assembly.ts` loses three file-level exports.

- [ ] **Step 1: Confirm the current state**

Run: `git grep -n "estimateAssemblyOverhead\|bindAuthRefreshStatus\|RewindAssemblyHandle" -- packages apps`
Expected: declarations and in-module calls in `assembly.ts`, plus `packages/session-executor/test/assembly.test.ts:24` importing two of them by name. If a production file outside `assembly.ts` names any of the three, stop and report.

- [ ] **Step 2: Observe the red state the un-export will create**

This task's red state is a **typecheck failure**, and it is real: `packages/session-executor/test/assembly.test.ts:24` name-imports `estimateAssemblyOverhead` and `bindAuthRefreshStatus` from `../src/assembly.ts`, and in this repo's ESM + `tsc --noEmit` setup an un-exported name cannot be named-imported.

Drop the three `export ` keywords (`assembly.ts:166`, `:220`, `:234`), then run:

Run: `pnpm --filter @i-harness/session-executor typecheck`
Expected: FAIL — `Module '"../src/assembly.ts"' has no exported member 'estimateAssemblyOverhead'` (and the same for `bindAuthRefreshStatus`). Record the exact error; it is the red evidence for this task.

- [ ] **Step 3: Reroute the two tests through the public surface**

Read `packages/session-executor/test/assembly.test.ts` — the import block at `:19-24` and the two cases that call the helpers directly (around `:96-99`). Replace the named imports with the public ones and rewrite those cases to assert the **production effect** through `createSessionAssembly` rather than the private helper:

- Remove `estimateAssemblyOverhead` and `bindAuthRefreshStatus` from the `:19-24` import list, keeping the names that remain.
- For the overhead case: build an assembly with a known `contextWindow` and a tools registry carrying a known schema set, and assert the overhead the agent received equals `approxTokens(systemPrompt) + approxTokens(JSON.stringify(schemas))`, observed through the compaction/budget config the assembly passes into `createAgent`. Take the exact option names from the assembly's own `createAgent` call and the `compactForAgent` / `budget` options it composes just above that call — read them from the file, do not guess them.

**Why this is the required shape:** the current case calls the helper directly, so changing the `overheadEstimate` initializer to `estimateAssemblyOverhead(systemPromptNow(), [])` would not fail it. Rerouting through the assembly is what makes the mutation catchable.

- [ ] **Step 4: Typecheck and test**

Run: `pnpm --filter @i-harness/session-executor typecheck`
Expected: exit 0.

Run: `pnpm --filter @i-harness/session-executor test`
Expected: PASS.

- [ ] **Step 5: Mutation proof**

Change the **`overheadEstimate` initializer** in `createSessionAssembly` — the `estimateAssemblyOverhead(systemPromptNow(), tools.schemas())` call — to pass `[]` instead of `tools.schemas()`. Run the rerouted overhead case: it must FAIL. Restore and re-run: PASS. Record both.

- [ ] **Step 6: Run the instrument and record the delta**

Run: `node scripts/audit/check-reachability.mjs`
Expected: the count does **not** change — these names were never in the 525, because class 1 walks only `packages/*/src/index.ts` entries and the entry does not export them. That is precisely the entry-only blind spot Task 7 records. Confirm the count is still 523.

- [ ] **Step 7: Commit**

```bash
git add packages/session-executor/src/assembly.ts packages/session-executor/test/assembly.test.ts
git commit -m "refactor(session-executor): un-export three names consumed only inside their own module, and route their tests through the public surface"
```

---

### Task 6: the baseline's verdicts and allowlist

Documentation only. Task 1–5 changed behaviour; this task makes the milestone's published claims match what is now true, and adjudicates the rows research showed were decided wrongly.

**Files:**
- Modify: `docs/audit/2026-09-15-reachability-baseline.md` — §4's tables and tally, §6.1, §6.2, §6.4

**Interfaces:** none — no code reads this document. It is M2's input, which is why it must be right.

- [ ] **Step 1: Flip the output-retention row and correct its characterisation**

§4.2 item 4 is currently `still-holds` with the words "the fix exists in-repo and is unwired". All three parts are wrong on measurement: `createUnifiedSpillStore` (`packages/output-retention/src/spill-guard.ts:90-92`) is a three-line root-selecting factory that **never calls GC**; GC **is** wired at `spill-guard.ts:25` inside `createOutputSpillGuard`, which production mounts at `packages/session-executor/src/assembly.ts:507`; and nothing in production supplies a spill root at all, so what ships is **no spill store**, not an uncleaned one.

Rewrite the row's evidence and set it to **`by-design`**, citing the source's own label at `packages/output-retention/src/index.ts:170-171` ("研究決策；不清理（已知 limitation）") and the fact that GC + guard + factory landed together in `c3875a9`.

- [ ] **Step 2: Add the allowlist rows decided by research and by the human**

Add to §6.1, each with a reason that cites code rather than restating the verdict:

- **`classifyDenial` (baseline §4.3 item 1)** — `by-design`, upholding the parked ruling at `docs/handoff/what-the-design-does-not-answer.md:71` ("**Ruling: document, do not implement.**"). State that the fix is structurally forced through `@i-harness/sandbox` and necessarily widens `ExecResult` plus the model-visible shell payload, so it is an M-shaped spec; name it as a follow-up, do not imply it is closed by preference alone.
- **`exitCode: -1` (baseline §4.3 item 2)** — `by-design`, upholding `docs/handoff/what-the-design-does-not-answer.md:49` (C10), and correct the site list in the same edit: `packages/shell/src/index.ts:372` is the **bash-absent** branch (not a `kind: "refused"` refusal — that is `:217`, whose discriminator is internal), and `packages/exec/src/index.ts:210` (`child.on("error", …)`) is **missing** from the baseline. Record that counting meanings rather than sites gives at least eight, because `exec/src/index.ts:150` documents a deliberate indistinguishable `-1` on external abort.
- **`remember.ts` (baseline §4.5 row 3)** — keep the module and its test, and declare it **deliberately unwired** (human ruling, 2026-09-15). Reason: the TUI lists `"remember"` in `NEVER_REGISTERED` (`packages/tui/test/slash-registry.test.ts:42-46`, "zero registration hits — not even as hidden inventory"), the approval path has no persistent-decision vocabulary (only `allow-once`), and `packages/guard-approval/src/index.ts:82-88` omits it deliberately while covering three sibling modules. Record that the module carries the tree's only statement of the rule that a shell or interpreter can never be remembered (`BANNED_PREFIX_PATTERNS`), and name it as an **input to the replacement frontend** rather than a pending task.
- **`closeSessionQueries` (baseline §4.5 row 2)** — `by-design`. Reason: each CLI entry point creates at most one query per process (`apps/cli/src/index.ts:280`, `:447`, `:617`), the code's own comment at `:277` states the index is a process-private `:memory:` index, and no caller passes a `dbPath`; the process exit is the lifetime boundary, so a close would have no observable effect. Note that `closeSessionQueries` is a **process-global destroyer** and that the honest long-term fix — a per-instance `close()` — adds a member to the published `SessionQuery` interface and is therefore M.
- **`--flag=value` (baseline §4.4 item 3)** — `by-design`, deliberately unsupported. Reason: the value-taking flags are parsed at seven in-scope sites, two of them re-parsing the same `run` argv, and the remaining parser is `apps/tui` (frozen) — so `=` support could only ever be partial in-repo, and partial grammar is worse than none. Demand is zero. **State the obligation this declaration carries:** Task 3 makes the form fail loud as an unknown flag, so `--model=x` can no longer be silently swallowed into the prompt.

- [ ] **Step 3: Record what Task 1 did and did not discharge**

Add a note to §4.1 item 6 stating that the construction-time producer now exists (Task 1) **and that the row's stronger claim survives**: no in-scope surface can change a *live* mode — and **no shipped surface can either** (**corrected 2026-09-15**: this sentence named `/sandbox` in the frozen `apps/cli/src/web.ts` as "the only shipped one", and that is false; measured, it appends no `sandbox/mode` event at all — it writes `settings.sandboxMode` and takes effect for sessions created *later*, `apps/cli/src/web.ts:273-282` / `:470-475`) — ACP's `session/set_mode` is in the v0 drop-set, and the SDK and subagent trees contain no `sandbox` occurrence at all. Name the follow-up (a `setSandboxMode` seam plus a caller) as M, and record its out-of-scope blocker explicitly so it is not rediscovered as a surprise.

- [ ] **Step 4: Restate the tally and check every place that repeats a count**

The row tally is over **rows, not distinct items** (`tui --yes` occupies two rows; the document's own note records the duplication). Moving `mountPreset` and both `--yes` cells moved three rows; this task moves three more (§4.2 item 4, §4.3 items 1 and 2) and leaves §4.5's four adjacent rows as recorded-not-list-items.

Compute the new split from the tables rather than from this paragraph, state it in §4, and then grep the document for every other place a count or verdict appears — §3.2's table, §3.3, §6.1's heading, §6.2's heading, §6.3's arithmetic, §6.4's list — and make them agree. A document that contradicts itself about how many rows carry which verdict is the defect this milestone exists to remove.

- [ ] **Step 5: Verify no row still says `still-holds` without a task or a reason**

Run: `git grep -n "still-holds" -- docs/audit/2026-09-15-reachability-baseline.md`
Expected: every hit is either a row Task 1–5 wired, or a row this task moved. If any row remains `still-holds` with neither, that is M1's completion definition failing — report it rather than editing the verdict to make the list tidy.

- [ ] **Step 6: Commit**

```bash
git add docs/audit/2026-09-15-reachability-baseline.md
git commit -m "docs(audit): reconcile the baseline's verdicts -- three rows become by-design with cited reasons, and the tally is recomputed from the tables"
```

---

### Task 7: the baseline's errata, and the state M2 inherits

Documentation only, and the last task, because the digest changes here. Phase B's research re-measured every row at HEAD and found six places where the baseline's description is wrong while its underlying finding is right. A milestone whose output is a claim about what was measured must not leave those standing.

**Files:**
- Modify: `docs/audit/2026-09-15-reachability-baseline.md` — §2, §4.1 item 8, §4.3 item 2, §4.4 item 3, §4.5, §5.1, §7

- [ ] **Step 1: Correct the six measured errata**

- **§4.1 item 6** says "0 in production comments". True only of the double-quoted form; the bare pattern matches **17 production comment lines**, four of which state the missing-producer contract in prose. Say which form was counted.
- **§4.4 item 3** says "across the whole tree: `apps/` contains zero occurrences of `split("=")`, `indexOf("=")` or `startsWith("--")`". Two `=` splits do exist — `packages/web-host/src/host.ts:700` and `packages/tui/src/app/slash/impl/workflow2.ts:38` — both in frozen frontend packages and neither a CLI parser, so the verdict stands, but the sentence must say "in `apps/`". The same row's parse-site list omits a third in-scope site, `apps/cli/src/sessions.ts:45-65` (which holds the only `startsWith("-")` in `apps/`, at `:62`).
- **§4.4 item 4** under-states its class: the filter it describes also fails to strip `--no-compact`, an eighth run flag parsed at `apps/cli/src/index.ts:182` and documented nowhere (absent from USAGE `:37`/`:311` and from `docs/CAPABILITIES-DETAIL.md:425`). Note that Task 3 fixed it, so the row is now `already-fixed` rather than `still-holds` — and record *what* was fixed, since "the filter listed seven" was true and incomplete at the same time.
- **§4.1 item 8** names two names; there are **three** in the same position — add `RewindAssemblyHandle` (`packages/session-executor/src/assembly.ts:166`), which Task 5 un-exported with the other two.
- **§4.5 row 2** says "four `test/` files"; `apps/cli/test/cli.test.ts:17` also imports the name, so it is five, and that file is in an **in-scope** package. The verdict does not change (test-only callers), but the count is wrong.
- **§2** records HEAD `74f86d5a…`. The Phase A fix wave and the Q6 roadmap commit moved HEAD; state the revision the *measurement* was taken at **and** the revision the document is published at, so a later reader is not misled about which is which.

- [ ] **Step 2: Record the entry-only blind spot as a named M2 requirement**

Class 1 walks only `packages/*/src/index.ts` entries, so **any file under `packages/*/src/` that its entry does not mention — and every name it declares — is invisible to all five scanner classes.** Three instances are now known: `packages/guard-approval/src/remember.ts`, `packages/sandbox-local/src/runner-failures.ts`, and `closeFileBackedConnections` in `packages/session-query/src/file-backed.ts:91`. Write this into §7 as a limitation, and into the M2 requirements, with the concrete ask: a scanner class that enumerates `packages/*/src/**/*.ts` with no inbound reference from either its entry or any other production file.

It must land in the **M2** list, not as a fix here — the ratchet's scope is M2's, and without this the rows and their siblings regrow. Also record the measured fact that **re-exporting is not a remedy**: a probe through the real scanner gives 1 finding without the re-export and 2 with it (`scanUnusedExports` in `check-reachability.mjs` — the entry selection, the origin exclusion and the `findings.push`; M2's closing wave replaced this plan's original line citation, which had rotted), so "re-export to clear the row" measurably makes the ratchet worse.

- [ ] **Step 3: Record the argument-routing blind spot**

Add to §7: no scanner class covers argument routing, so Task 3's class of defect — a flag becoming a prompt — is invisible to the gate forever. State that the `run` path parses its argv twice (`apps/cli/src/index.ts:170-223` reads values, `:304-308` re-derives which tokens are flags), that this duplication is the shared cause of both defects Task 3 fixed, and that the tests are the only protection. Name the single-declarative-flag-table refactor as the shape that cannot drift again, without requiring it.

- [ ] **Step 4: Publish the post-Phase-B state M2 seeds from**

Run `node scripts/audit/check-reachability.mjs` and `--json`, then record in §2 (or a clearly-labelled new subsection): the new finding count and split, the new `kind⇥subject⇥evidence` digest — computed with the document's own stated rule, `\n`-joined **with a trailing newline**, which is exactly the rule a reader will try to reproduce — the revision it was measured at, and the row delta from Phase A (which rows left the set and which task removed each). This is the artefact M2's ratchet seeds from, and §6 already prescribes that it must fail only on **new** rows, never on "zero rows".

- [ ] **Step 5: Verify the document against itself**

Run: `node scripts/audit/check-reachability.mjs --self-test` (expect `18/18 ok`) and re-read every `check-reachability.mjs:NNN` citation in the document, confirming each resolves to what it claims at the current revision. Renumbering this document has broken citations twice in this milestone; check rather than assume.

Confirm the file is CRLF with **0 bare LF** and no BOM, and that the digest you published reproduces from the stated rule.

- [ ] **Step 6: Commit**

```bash
git add docs/audit/2026-09-15-reachability-baseline.md
git commit -m "docs(audit): correct six measured errata, record two scanner blind spots for M2, and publish the post-Phase-B digest"
```

---

## Self-Review

**Spec coverage.** Roadmap §3.M1's completion definition — every `still-holds` row either wired to a production path or declared deliberate with a reason — is discharged by Tasks 1–6; Task 6 Step 5 is the check that no row is left in neither state. The roadmap's interface rule is honoured by excluding the three M-shaped items (A2, the `classifyDenial` fix, the `exitCode` disambiguation) and naming them as follow-ups rather than folding them in; each is recorded in Task 6 Step 2 or Task 6 Step 3. §1.1's re-measurement principle was satisfied before this plan was written: `git diff 74f86d5..HEAD -- packages apps` is empty, so the baseline's code measurements hold at HEAD, and every task re-verifies its own site rather than trusting the quotation.

**Items deliberately outside this plan, all named in Task 6 or Task 7:** a real mid-session sandbox-tightening surface (**corrected 2026-09-15:** this said "blocked by the frozen `apps/cli/src/web.ts`", and the freeze is not the blocker — **nothing shipped can change a live session's mode at all**, so the surface has to be **built**, not unfrozen. Measured: `/sandbox` writes `settings.sandboxMode` and takes effect for sessions created *later* (`apps/cli/src/web.ts:273-282`, read once at `:470-475`), and no shipped host appends a `sandbox/mode` event — `assembly.ts:354` is the sole producer, at construction. Aligned with Task 1's paragraph and Task 6 Step 3, which were corrected in `1cef0d59`); the `classifyDenial` wiring (M — widens `ExecResult`, the `@i-harness/sandbox` entry and the model-visible shell payload); the `exitCode: -1` disambiguation (M — same shape); a per-instance `SessionQuery.close()` (M — published interface); a **wire-keyed public provider factory** (**corrected 2026-09-15:** this read "the `provider-runtime` protocol-resolution defect that `buildWireClient` was written for" — there is **no defect** on that path: `adapterProtocol` (`packages/provider-runtime/src/index.ts:492-494`) renames only `"openai-completions"` → `"openai-compatible"` and passes the other four through, so it is injective and `buildModelClient` already dispatches every resolved route to the client the deleted switch returned; measured, and stated in the tracked comment at `packages/provider/test/provider.test.ts:43-56` plus the handoff's R-Q); the entry-only scanner class (M2); the single flag table (not required); and `--flag=value` (declared deliberate).

**Type consistency.** `effectiveSandboxMode` keeps its signature across Task 2. `createSessionAssembly`'s option names are read from the file in each task rather than invented. `ExecResult` and `SessionQuery` are not modified by any task — that is what keeps the three M items out. No task introduces a name another task consumes, so tasks are independently applicable.

**Known risk, stated rather than hidden:** Tasks 1 and 5 each change a test that currently passes, and both changes are the kind that can silently destroy a mutation proof — `sandbox-escalation.test.ts:105` guards the escalation ladder, and the two `assembly.test.ts` cases guard the overhead arithmetic for the **`overheadEstimate` initializer** in `createSessionAssembly`. Both tasks therefore require an explicit mutation proof *after* the test edit, not just a green run.
