# Remove the TUI and web frontends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the TUI and web frontends from this repository so the backend is a standalone agent — one that keeps working when no interface is attached, which today it cannot do, because the TUI's engine is assembled inside the TUI process.

**Architecture:** The frontends are almost self-contained. Measured at `ec93fe0`: the only files **outside** the removal set that reference them are `apps/cli/package.json`, `apps/cli/src/index.ts` and `apps/cli/src/web.ts` — and the last is itself being deleted. `e2e/` has **zero** references. So the work is: delete five paths, rewire one file, and then repair the two things that quote the deleted world — the CLI's bare-launch behaviour and the M2 gate's baseline.

**Tech Stack:** TypeScript 5 ESM (`.ts` extensions in relative imports), pnpm workspace, vitest per package, `tsc --noEmit` per package. Zero external runtime dependencies; this plan adds none.

**Spec / authority for the decision:** the human's product statement, 2026-09-17 — *"把界面關掉，但後端還是能在後台繼續工作的 agent，前端真就應該是純前端"* — recorded against roadmap §5 **Q6** (`docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md`), which already recorded the TUI and web as slated for replacement. This plan is that replacement's **first step: removal**, not the rebuild.

## Global Constraints

- **`packages/web` is NOT a frontend and must not be touched.** It implements the `web_search` / `web_fetch` **tools**, and `packages/session-executor/src/assembly.ts:19` imports `registerWeb` from it on the production path. Deleting it would destroy the model's web access. The frontend is `packages/web-host` plus `apps/cli/src/web.ts`.
- **Red-first, with a mutation proof.** Roadmap §1.7: no production code changes without a red-first test and a mutation proof. For a deletion, the red-first test is the *behaviour that changes* — the bare-launch fall-through and the removed subcommands — not the deletion itself.
- **Never amend a reported commit.** Every SHA in this repo has been shown to humans and reviewers.
- **CRLF in the worktree, no BOM.** Verify byte counts after editing. When composing a commit message through PowerShell, verify it by a **raw byte read** of `git cat-file commit HEAD` — `git log --format=%s` is confidently wrong about a leading BOM, because PowerShell's output decoder strips it.
- **Read back every edited region verbatim** and confirm no splice damage.
- **Push only to the milestone branch** (`m65`). `main`'s merge timing is the human's.
- **Gates:** focused `pnpm --filter <pkg> exec vitest run <file>` and `pnpm --filter <pkg> typecheck`; wide `pnpm -r typecheck` **and** `pnpm -r --no-bail test` (the plan lists both — a round that ran only one was pulled up for it).
- Environment: node v22.23.2; `bash` resolves to **WSL**, and `bash -c "node --version"` fails with exit 127 on this host.

---

## File Structure

| Path | Disposition |
|---|---|
| `apps/tui/` (`@i-harness/tui-app`) | **delete** — the TUI host + launcher |
| `packages/tui/` (`@i-harness/tui`) | **delete** — the TUI |
| `packages/tui-core/` (`@i-harness/tui-core`) | **delete** — terminal/render primitives |
| `packages/web-host/` (`@i-harness/web-host`) | **delete** — the HTTP host |
| `apps/cli/src/web.ts` | **delete** — the web server composition; `CLI_VERSION` must move out of it first |
| `apps/cli/src/index.ts` | **modify** — drop `tui`/`web`, restore the pre-M44 fall-through, strip the TUI probes from `__dist-selfcheck` |
| `apps/cli/package.json` | **modify** — drop four workspace deps |
| `scripts/verify-dist.mjs` | **modify** — its TUI probes have nothing left to check |
| `scripts/audit/reachability-baseline.json` | **re-seed** — 523 rows → the rows that survive |
| `scripts/audit/reachability-allowlist.json` | **prune** — four entries become moot; re-match every `source` line |
| `docs/audit/2026-09-15-reachability-baseline.md` | **modify** — §4/§6 quote verdicts for rows that no longer exist |
| `docs/handoff/HANDOFF.md`, `README.md`, `README.en.md`, `docs/CAPABILITIES-DETAIL.md` | **modify** — they document `tui` / `web` |

---

### Task 1: Delete the frontends and rewire the CLI

**Files:**
- Delete: `apps/tui/`, `packages/tui/`, `packages/tui-core/`, `packages/web-host/`, `apps/cli/src/web.ts`
- Modify: `apps/cli/src/index.ts`, `apps/cli/package.json`, `scripts/verify-dist.mjs`
- Test: `apps/cli/test/bare-launch.test.ts` (**create**)

**Interfaces:**
- Consumes: `CLI_VERSION` — which today lives in `apps/cli/src/web.ts` (`:30` imports it) and must survive the deletion.
- Produces: a CLI whose subcommand set is `run` / `sdk` / `acp` / `sessions` / `__dist-selfcheck` / `--version` / `help`, and whose bare-launch behaviour is the **pre-M44** one.

- [ ] **Step 1: Read the four sites before touching them**

Read `apps/cli/src/index.ts:25-35` (the imports), `:140-170` (the `tui` dispatch and the grok-style default), `:355-410` (`__dist-selfcheck`), and `:50-60` (`CLI_VERSION`'s uses). **If any line differs from what this plan quotes, stop and report.** Earlier milestones shipped plan snippets that were all broken on this repo, several silently doing nothing.

- [ ] **Step 2: Write the failing test — the behaviour that must change**

Create `apps/cli/test/bare-launch.test.ts`. Take the spawn harness from `apps/cli/test/bin.test.ts:14-24`, and **pin `IH_CONFIG_DIR` to a fresh empty temp dir** (the pattern at `e2e/helpers.ts:28-42`) so a stray path cannot start a real turn:

```ts
import { describe, expect, it } from "vitest"

// Spawn the real shim with an empty config home so nothing can start a turn.
const SHIM = new URL("../bin/i-harness.js", import.meta.url).pathname

describe("bare launch", () => {
  it("prints usage and exits 1 instead of launching anything", async () => {
    const r = await runNode([SHIM])              // no subcommand at all
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("usage: i-harness")
    expect(r.stdout).toBe("")
  })

  it("refuses a non-subcommand first token rather than defaulting to a UI", async () => {
    const r = await runNode([SHIM, "notacommand"])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("usage: i-harness")
  })

  it("refuses the removed tui subcommand", async () => {
    const r = await runNode([SHIM, "tui"])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("usage: i-harness")
  })

  it("refuses the removed web subcommand", async () => {
    const r = await runNode([SHIM, "web"])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("usage: i-harness")
  })
})
```

- [ ] **Step 3: Run it and confirm it fails, for the right reason**

Run: `pnpm --filter @i-harness/cli exec vitest run test/bare-launch.test.ts`
Expected **today**: the bare-launch and `notacommand` cases fail because the CLI **launches the TUI**; `tui` succeeds; `web` starts a server. Record the actual output — that is this task's red state.

- [ ] **Step 4: Move `CLI_VERSION` out of the doomed file**

Read where `web.ts` defines it and move the definition (and its imports) into `apps/cli/src/index.ts` or a small `apps/cli/src/version.ts`. Do this **before** deleting `web.ts`, or `--version` stops compiling.

- [ ] **Step 5: Delete the five paths**

```bash
git rm -r apps/tui packages/tui packages/tui-core packages/web-host
git rm apps/cli/src/web.ts
```

- [ ] **Step 6: Restore the pre-M44 fall-through**

Replace the grok-style default. The behaviour to restore, quoted from `db3d1e7^:apps/cli/src/index.ts`:

```ts
  if (args[0] !== "run") {
    console.error(USAGE)
    return Promise.resolve(1)
  }
```

Remove the `tui` dispatch (`:145-147`), the `web` dispatch, and the `@i-harness/tui-app` import (`:29`). **Keep `USAGE` accurate** — it must stop advertising `tui` and `web` and stop describing the bare-launch default. **Do not add a `help` feature**: the run path's flag router deliberately treats `--help` after `run` as an unknown flag, and the top-level `help`/`--help`/`-h` branch at `:160-163` is test-pinned by `bin.test.ts` — leave that branch alone.

- [ ] **Step 7: Strip the TUI probes from `__dist-selfcheck`**

`:375-404` probes `probeMinimalHost`, `relaunchArgs`, `spawnSdkSubprocess` and `buildSdkSpawnArgs` — all TUI surfaces. Remove the probes whose subject no longer exists and update `scripts/verify-dist.mjs` to match. **Keep the probes that still test something real** (the inline engine, the confinement path); deleting a working check because it sits beside a dead one is the kind of loss this plan exists to avoid.

- [ ] **Step 8: Drop the four workspace deps**

In `apps/cli/package.json`, remove `@i-harness/tui`, `@i-harness/tui-app`, `@i-harness/web`, `@i-harness/web-host`. **Do not remove `@i-harness/web` if it is still imported anywhere** — check with `git grep "@i-harness/web\"" -- apps/cli`; if `packages/web` (the tool) is reached through the assembly it is not a direct CLI dependency, but confirm rather than assume.

- [ ] **Step 9: Run the test, then both wide gates**

Run: `pnpm --filter @i-harness/cli exec vitest run test/bare-launch.test.ts` → **PASS**.
Run: `pnpm -r typecheck` → exit 0. This is the gate that finds a missed import.
Run: `pnpm -r --no-bail test` → exit 0. This is the gate that finds a test asserting on something deleted.
Expected: `bin.test.ts`'s `tui --help` case and any `web` case now **fail** — they assert the deleted surfaces. **Update or delete those assertions, and say in the commit message which ones went and why.**

- [ ] **Step 10: Mutation proof**

Re-add the two lines that restore the default-to-TUI behaviour and confirm `bare-launch.test.ts` goes red. Restore. Then re-add a `tui` dispatch and confirm the `tui` case goes red. Restore. Record both directions.

- [ ] **Step 11: Commit**

```bash
git add -A apps/cli apps/tui packages/tui packages/tui-core packages/web-host scripts/verify-dist.mjs
git commit -m "refactor: remove the TUI and web frontends, and restore the pre-M44 bare-launch usage error"
```

---

### Task 2: Re-seed the M2 gate and prune the allowlist

The gate compares against a committed baseline. **104 of its 523 rows mention `tui`** and are about to stop existing, so the baseline stops describing the tree. This task is the repair, and it is the only step in this plan with real risk.

**Files:**
- Modify: `scripts/audit/reachability-baseline.json` (written **only** by `--seed-baseline`)
- Modify: `scripts/audit/reachability-allowlist.json`
- Test: `scripts/audit/check-reachability.mjs --self-test` and `--gate`

**Interfaces:**
- Consumes: the seed writer `--seed-baseline` and the gate `--gate`, both already shipped by M2.
- Produces: a baseline whose `count` and `digest` describe the post-deletion tree, and an allowlist with no entry pointing at a row that cannot exist.

- [ ] **Step 1: Measure the delta before writing anything**

Run `node scripts/audit/check-reachability.mjs --json`, and count the rows. Expect **523 minus the TUI rows**. Record both numbers. **Do not guess the new count** — the M2 handoff's own lesson is that a figure written ahead of the measurement is the defect this repo keeps finding.

- [ ] **Step 2: Re-seed**

Run `node scripts/audit/check-reachability.mjs --seed-baseline`, then `--gate` and `--digest`. Expected: `gate PASS`, and a digest that is **not** `5acf81aa…` (the old one described the old tree). Record all three outputs.

- [ ] **Step 3: Prune the four moot allowlist entries**

Measured: `unpushed-capability plan-mode`, `unpushed-capability guardian`, `unpushed-capability vim-mode` (evidence `packages/tui/src/app/slash/types.ts`) and `unread-flag --yes` (evidence `apps/tui/src/index.ts`) all name deleted code. Remove them **and** their `noRow` counterparts if any.

**Say in the commit message that these four were removed *because their subject was deleted*, not because they were adjudicated differently.** A reader must not conclude the exemption was withdrawn on its merits.

- [ ] **Step 4: Re-match every remaining `source` line — the known trap**

The M2 handoff (`docs/handoff/2026-09-15-m2-reachability-gate-handoff.md` §6 item 1) records this exactly: the allowlist's `source` fields cite the baseline document **by line**, Task 4's edits moved all 24, a repair introduced a +1 error in seven of them, and the closing wave moved them again. **Any edit to `docs/audit/2026-09-15-reachability-baseline.md` above §6.1 rotates them.**

Task 3 edits that document. So: **re-print every `source`, and match it to the row its entry names.** Run the check after Task 3, not only before it, and treat a mismatch as a defect rather than a rounding error.

- [ ] **Step 5: Run the gate's own proof and the self-test**

Run `node scripts/audit/check-reachability.mjs --self-test` → expect **36/36 ok**, exit 0.
Run the completion proof from the M2 handoff §7: copy the repo to `%TEMP%`, append `export const M2_GATE_PROOF = "delete me"` to `packages/guard-repeat-tool/src/index.ts` in the copy, and run `--gate --root <copy>` → expect **exit 1** naming exactly that row.

- [ ] **Step 6: Commit**

```bash
git add scripts/audit/reachability-baseline.json scripts/audit/reachability-allowlist.json
git commit -m "chore(audit): re-seed the reachability baseline after the frontend removal, and drop the four exemptions whose subject no longer exists"
```

---

### Task 3: Correct the documents that describe the deleted world

**Files:**
- Modify: `docs/audit/2026-09-15-reachability-baseline.md`, `docs/handoff/HANDOFF.md`, `README.md`, `README.en.md`, `docs/CAPABILITIES-DETAIL.md`

**Interfaces:** none — documentation. It is M2's and M3's input, which is why it must be right.

- [ ] **Step 1: The baseline document**

Its §4 adjudicates rows by verdict and its §6 allowlist quotes them; several of those rows no longer exist. Correct them **in place, dated**, in the style the document already uses for its own corrections — and add a short note that the frontend removal deleted 104 rows and that the tally therefore moved for a **structural** reason, not because any verdict changed.

- [ ] **Step 2: `HANDOFF.md` and the takeover surface**

§0's state table, §0.1's branch table, and §7's sandbox discussion all reference the TUI. The bare-launch behaviour is described there too. Update those, and **record the product statement behind this** — the backend must keep working with no interface attached — so the next reader knows *why* the frontends went rather than inferring they were abandoned.

- [ ] **Step 3: The user-facing docs**

`README.md`, `README.en.md` and `docs/CAPABILITIES-DETAIL.md` document the `tui` and `web` commands and the bare-launch default. A README that advertises a command the binary rejects is the same defect class as a comment citing the wrong line.

- [ ] **Step 4: Re-run the allowlist `source` check from Task 2 Step 4**

This document was just edited; the line-numbered citations have rotated. Match every one.

- [ ] **Step 5: Verify the gate still passes and nothing dangles**

Run `pnpm verify:reachability` → exit 0.
Run `git grep -n "i-harness tui\|i-harness web\|@i-harness/tui\|@i-harness/web-host"` across the tree → the only surviving hits should be **historical records** (dated corrections, the M2/M3 handoffs' own history). If a live document still instructs a reader to run a deleted command, fix it.

- [ ] **Step 6: Commit**

```bash
git add docs README.md README.en.md
git commit -m "docs: correct the documents that described the removed frontends, and record why they were removed"
```

---

## Self-Review

**Scope coverage.** The removal set is the five paths in File Structure; `packages/web` is explicitly excluded and the reason is stated in Global Constraints with its file:line. The CLI rewiring covers all four TUI uses measured in `apps/cli/src/index.ts` (import, `tui` dispatch, grok-style default, `__dist-selfcheck`) plus the `CLI_VERSION` relocation that the `web.ts` deletion forces.

**What the measurement changed about the obvious plan.** Three things a plan written without measuring would have got wrong: `packages/web` is a *tool* and would have been deleted; the bare-launch replacement is not a free choice but a recorded pre-M44 behaviour (`db3d1e7^`); and `__dist-selfcheck` exists to verify the TUI, so it does not simply survive.

**The risk this plan names rather than hides.** Task 2 re-seeds a gate that was built and reviewed days ago, and Task 3 rotates the line-numbered citations that gate's allowlist depends on. That rotation has already caused one defect round in M2. Task 2 Step 4 and Task 3 Step 4 exist because of it, and both say to treat a mismatch as a defect.

**Not in this plan, deliberately.** The frontend **rebuild** — this is removal only, and building a replacement is a later, separate piece of work. The M4 work that makes a detached backend survive (durable turn state machine) — without it, "close the UI and the backend keeps working" is still not achievable, and saying otherwise would be the kind of claim this repo keeps removing. And any change to `packages/web`.
