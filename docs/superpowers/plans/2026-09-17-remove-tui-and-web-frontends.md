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

### Task 2A: Retire the TUI-only settings, and un-export the names the frontend alone consumed

**Added 2026-09-17, after Task 1's review.** Task 1's review found the gate failing with **104 new rows**, and a follow-up classification put every one in a bucket. Two human rulings fixed this task's shape: **the TUI-only settings are deleted, not deferred**, and **the un-exports happen here**, not in a later milestone.

**Input — the classification, which is the specification for this task:**
`D:\I-harness-main\.superpowers\sdd\m3\orphaned-exports-classification.md`

| bucket | meaning | count | disposition |
|---|---|---|---|
| **T** | TUI-only leftover | 19 | **delete** (human ruling) |
| **B** | backend-internal; only the *export* is unused | 38 | **un-export** (human ruling) |
| **C** | frontend/wire contract | 34 | Task 2B allowlists it |
| **?** | needs a product call | 13 | Task 2B defers it |

**Files:**
- Modify: `packages/settings/src/index.ts` (all 19 T rows live in this one file — 14 settings keys and 5 types)
- Modify: the 38 files named in the classification's bucket-B table
- Test: `packages/settings/test/**`, plus whatever test asserts on the removed keys

**Interfaces:**
- Consumes: the classification file, and the reachability instrument as the detector for both halves.
- Produces: a tree where the 19 T rows and the 38 B rows **no longer appear as findings** — which is a *measurable* claim, not a described one.

- [ ] **Step 1: Measure the starting point, and do not reuse the plan's numbers**

Run `node scripts/audit/check-reachability.mjs` and record the tree's current count and its full list of `new` rows (there should be 104: 90 `unused-export` + 14 `unconsulted-setting`). **The plan's arithmetic — `523 − 115 + 104 = 512` — described `dbe2e41`; re-measure rather than quoting it.** If the numbers differ from that, say so in the report before continuing.

- [ ] **Step 2: Answer the data-migration question BEFORE deleting any settings key**

Deleting a key from the settings schema is not the same as deleting an unused export: **users have `settings.json` files that already contain these keys.** Determine, by reading the loader and validating against a hand-written `settings.json` containing `"tui": {"prefs": {"scrollSpeed": 3}}`, what happens on load today and what would happen after the key is removed — tolerated, silently dropped, or a hard failure.

**State the answer in the report and choose the handling deliberately.** If removal makes an existing settings file unloadable, that is a migration defect and this step is not done. Existing tests are the cheapest evidence; a scratch settings file under `.superpowers/sdd/` is the second.

- [ ] **Step 3: Delete the 19 T rows, red-first**

The 19 are enumerated in the classification's §3: the 14 `unconsulted-setting` keys (`busyEnter`, `theme`, `transcriptMode`, the eleven `tui.prefs.*`) and the 5 types (`SETTINGS_THEMES`, `SETTINGS_THEMES_LOW_COLOR`, `SettingsTheme`, `SettingsScrollMode`, `SettingsKeepTextSelection`).

Write the failing test first — an assertion that the schema no longer carries these keys, or that a settings file carrying them loads cleanly, whichever Step 2 showed is the real behaviour. **A test that would pass with the keys still present is not the test.** Then delete, and carry any test that asserted the old shape with it — **naming in the commit message what each removed test was pinning and why it goes**, exactly as Task 1 did.

Note `tui.prefs.dashboard.pinned` has **zero mentions anywhere at HEAD, including the deleted tree** — it is a schema key with no reader at all, so its removal needs no test change and should be called out as such.

- [ ] **Step 4: Un-export the 38 B rows — and stop if any is not what the bucket says**

Drop the **`export` keyword only**; keep every declaration. This is this repo's bucket-B rule (`docs/audit/2026-09-15-reachability-baseline.md:1230-1234`), whose worked precedent is `output-retention#createUnifiedSpillStore` in the allowlist.

**Two traps, both met before in this repo:**
- **`TS6133`.** Phase B's Task 4 found that un-exporting a declaration which is *not* read inside its own module fails under `noUnusedLocals` (`tsconfig.base.json:9`). Bucket B *means* the declaration is read inside its module — but **verify each one rather than trusting the bucket.** If any turns out not to be, **stop and report it**; do not "fix" it by deleting the declaration, and do not manufacture a use with `void <name>` — that edit makes the instrument lie to itself, which is the one thing this repo refuses.
- **`createExecService` is reached by a two-package chain**, not by its own module (`exec/src/index.ts:291` `registerExec` → `shell/src/index.ts:462` → `session-executor/src/assembly.ts:17`). Chains like this are why the classification re-implemented the gate's scan instead of trusting `git grep`.

- [ ] **Step 5: Prove both halves with the instrument, and mutate**

Re-run `node scripts/audit/check-reachability.mjs`. Expected: **the 19 T rows and the 38 B rows are gone from the finding set**, and the `--gate` "new" count has dropped by 57.

Then mutate, in both directions:
- re-add one removed settings key → its `unconsulted-setting` row returns;
- re-add one `export` keyword → its `unused-export` row returns.

Restore both and confirm the tree is byte-identical afterwards (`git diff` empty).

- [ ] **Step 6: Gates, then commit**

`pnpm -r typecheck` exit 0; `pnpm -r --no-bail test` showing **64 Done / 2 Failed and exactly the four known pre-existing cases** — the pass condition is **no NEW failures**, because the suite is red at base for `bash`-is-WSL reasons.

```bash
git add -A packages/settings packages/exec packages/shell
git commit -m "refactor: retire the TUI-only settings and un-export the backend names whose only consumer was the frontend"
```

---

### Task 2B: Re-seed the gate, and price what the removal left behind

**This is the task that repairs the baseline, and it is the one step in this plan with real risk** — it rewrites a gate that was built and reviewed days ago, and the allowlist's `source` fields cite the baseline document **by line**.

**Files:**
- Modify: `scripts/audit/reachability-baseline.json` (written **only** by `--seed-baseline`)
- Modify: `scripts/audit/reachability-allowlist.json`
- Test: `scripts/audit/check-reachability.mjs --self-test` and `--gate`

**Interfaces:**
- Consumes: the post-2A tree, and the classification's C and ? tables.
- Produces: a baseline whose `count` and `digest` describe the tree, and an allowlist that prices the frontend contract as **one named class** rather than a hundred near-identical entries.

- [ ] **Step 1: Measure, then re-seed**

Run `--json` and record the count. **Do not carry over any figure from the plan or from Task 2A's report** — the M2 handoff's own lesson is that a figure written ahead of its measurement is the defect this repo keeps finding.

Then `--seed-baseline`, followed by `--gate` and `--digest`. Expected: `gate PASS`, and a digest that is **not** `5acf81aa…` (that one described the pre-removal tree). Record all three outputs.

- [ ] **Step 2: Record the 104 as a class disposition — the human's ruling**

**Ruling (2026-09-17): one named class entry, not 104 near-identical ones.** The `reason` field on the baseline seed, plus a dated section in `docs/audit/2026-09-15-reachability-baseline.md` (Task 3 carries the prose), must say: **104 rows became findings on 2026-09-17 because the TUI and web frontends — their only in-repo consumer — were removed**; and what happened to each bucket (**T deleted, B un-exported in Task 2A; C is the replacement frontend's contract; ? is deferred**).

**The reader who matters is the one who will design the replacement frontend.** They must be able to find the C list and read it as a contract, and must not conclude the backend rotted.

- [ ] **Step 3: Give the C rows one allowlist class entry, and defer the ? rows with reasons**

- **C (34)** — the frontend/wire contract: view models, DTOs and the approval / question / command seams. One class entry, reason citing the classification §2 and the human's ruling. Their shape did not change; only the consumer did.
- **? (13)** — **deferred, each with its deciding question**, not guessed. Nine collapse to one question (*does the rebuilt frontend still have that surface?* — image upload, plugin status, the settings-section API, unified diffs, a host shell resolver). Three are `sdk` wire names (`HarnessClient`, `ServerInfo`, `RewindFileOpWire`) which are **siblings of 18 sdk names already allowlisted** as embedder-facing public API — treat the likely reading as an **allowlist gap, not an orphan class**, and say so. One is `mountPreset`, **already deferred by the allowlist's own `noRow` entry dated 2026-09-15** — re-state that ruling rather than re-deriving it.

- [ ] **Step 4: Prune the four moot entries**

`unpushed-capability plan-mode`, `unpushed-capability guardian`, `unpushed-capability vim-mode` (evidence `packages/tui/src/app/slash/types.ts`) and `unread-flag --yes` (evidence `apps/tui/src/index.ts`) all name deleted code.

**Say in the commit message that these four went *because their subject was deleted*, not because they were adjudicated differently.** A reader must not conclude the exemption was withdrawn on its merits.

- [ ] **Step 5: Re-match every remaining `source` line — the known trap**

The M2 handoff §6 item 1 records this exactly: the allowlist's `source` fields cite the baseline document **by line**, Task 4's edits moved all 24, a repair introduced a +1 error in seven, and the closing wave moved them again. **Any edit above §6.1 rotates them**, and Task 3 edits that document.

**Re-print every `source` and match it to the row its entry names.** Run the check again after Task 3, and treat a mismatch as a defect rather than a rounding error.

- [ ] **Step 6: Run the gate's own proof and the self-test**

`--self-test` → expect **36/36 ok**, exit 0.
The M2 handoff §7 completion proof: copy the repo to `%TEMP%`, append `export const M2_GATE_PROOF = "delete me"` to `packages/guard-repeat-tool/src/index.ts` in the copy, run `--gate --root <copy>` → expect **exit 1** naming exactly that row.

- [ ] **Step 7: Commit**

```bash
git add scripts/audit/reachability-baseline.json scripts/audit/reachability-allowlist.json
git commit -m "chore(audit): re-seed the reachability baseline after the frontend removal, and price the 104 rows it left behind"
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
