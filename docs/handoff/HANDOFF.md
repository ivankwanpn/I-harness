# Handoff — I-harness

**Written:** 2026-09-15, by the agent session that closed the sandbox permission/per-call goal.
**Audience:** whoever picks this up next — an agent told "survey the project, prepare to take over", or a human maintainer.
**Where this lives:** this document is **tracked in the repo** (`docs/handoff/`), so it survives a fresh clone. Two companions sit beside it: `FINAL-REPORT.md` (the closed goal — verdicts, fixes, process lessons) and `what-the-design-does-not-answer.md` (what the design does not answer, and what was declined with rulings). The design itself is tracked at `docs/superpowers/specs/2026-09-14-backend-permission-sandbox-design.md`, and its implementation plans at `docs/superpowers/plans/2026-09-14-sandbox-per-call-resolution.md` and `2026-09-15-escalation-ladder.md`.
**Everything below is either measured or grep-verified. Where a claim is weaker than it sounds, it says so.** §9 lists what this handoff does *not* establish.

---

## 0. State at handoff — check these five things first

| Fact | Value |
|---|---|
| Repo | `D:\I-harness-main` on the original workstation; any clone works |
| Remote | `https://github.com/ivankwanpn/I-harness` — **authoritative** |
| Branch | `m62` |
| HEAD | **`3e0e2536`** — `fix(sandbox): the fs refusal stops advising a retry that cannot work` |
| Sync / tree | `HEAD == origin/m62`, working tree **clean** |

`3e0e2536` is the **code state this document describes**. Everything after it on this branch is **docs-only** — this handoff set, the `README` pointers, and this topology addendum — so `git log` will show a newer HEAD than `3e0e2536`. That is expected: **no code has changed after `3e0e2536`.** To confirm you are on the described state: `git merge-base --is-ancestor 3e0e2536 HEAD` succeeds and `git diff 3e0e2536 HEAD -- packages apps` is empty.

The last goal — implementing `docs/superpowers/specs/2026-09-14-backend-permission-sandbox-design.md` — is **complete**: five steps, a four-scope final review, a consolidated fix round. Its report is the first thing to read if you need depth: `docs/handoff/FINAL-REPORT.md`.

**One surprising thing you should know up front** (it is a reachability statement, not a bug): the "session is tightened mid-run" scenario the whole sandbox design exists for **has no producer today**, and the **TUI composes no sandbox at all**. Details in §7.

### 0.1 Which branch is which — measured, because this already went wrong once

On **2026-09-14 two machines continued from the same commit** (`62711537`), and only one of them knew it.

| Ref | Commit | What it actually is |
|---|---|---|
| `origin/m62` | `9dc028c7` | **The branch to take over from.** 55 commits ahead of `main`, 2 behind. Carries the whole sandbox permission/call-policy milestone **and** this handoff set. |
| `origin/main` | `f39d4870` | The integration point. Contains `m62` **only as of `62711537`** — it does **not** have the 55 commits that followed. |
| `origin/m63` | *retired* | Was `main` + one docs commit. **Deleted on 2026-09-15** — see below. |
| `m62` @ `62711537` | | What the other machine snapshotted as "m62 complete, merged into `main`". |

**What happened.** The 2026-09-11 audit handoff (`docs/audit/2026-09-11-ih-takeover-handoff.md`) recorded "m62 = `6271153`". On 09-14 the other machine took that as current: it treated `m62` as a finished milestone, fast-forwarded `main` to that point, and opened `m63` off `main` for the next milestone. Meanwhile this branch kept committing to `m62` — 55 commits, the entire sandbox milestone — and never touched `main`. **A document asserting the state of a *branch* is a snapshot of the most mobile thing in a repo** — the same defect class as §6 item 5, one level up.

**m63 was a dead end, and that is measured, not assumed.** Its three commits were `d309e68e` and `f39d4870` (both already on `main`) plus `c5e03fd6`, whose *entire* content was one edit to that document asserting three false things: that `main` had merged `m62`, that `m62` stopped at `6271153`, and that `m62` was two commits **behind** `main`. Relative to `m62`, `m63` was missing **7,651 lines**, including `scripts/audit/verify-citations.mjs` — on `m63` that file is the **older checker that silently skipped 1,532 citations**. So it was not merely empty: working on it would have resurrected a bug this branch had already fixed.

**It is safe to delete, which is why it was.** Nothing unique was lost: `f39d4870` *is* `origin/main`; `d309e68e` is on `main`; the only casualty is `c5e03fd6`, a false statement. **To restore it anyway:** `git push origin c5e03fd6e0de8dbec2f7b965d7e90ac42f975d4a:refs/heads/m63`.

**Verify the whole picture yourself (four commands):**

```bash
git rev-list --count origin/main..origin/m62                    # 55  = m62 is ahead of main
git ls-tree origin/main packages/sandbox/src/call-policy.ts     # empty = main lacks the sandbox work
git merge-base --is-ancestor 3e0e2536 origin/main; echo $?      # 1 = main lacks the fix
git ls-remote --heads origin | grep m63                         # empty = m63 retired
```

**Still open, and it is the human's call, not an agent's:** `main` is 55 commits behind and does not contain the sandbox milestone. The merge is one command in a conflict-free direction (`m62` never touched the audit handoff after the merge-base, and `main`'s two commits touch only that file):

```bash
git switch main && git merge --no-ff origin/m62 && git push origin main
```

This is documented rather than executed because the repo's own discipline says **merge timing into `main` is the human's decision** (`d309e68e`). Until that happens, **open the next milestone branch off `m62`, not off `main`.**

---

## 1. There are TWO checkouts. Do not confuse them — it has already happened once.

| Path | What it is |
|---|---|
| `D:\I-harness-main` | **The product.** This repo. A pnpm monorepo of 68 packages. |
| `D:\deepseek-harness` | **The agent harness (DSH)** that runs *you*. Different codebase, different purpose. |

Worked example, because it cost real time: a run died with `SSE stream ended without [DONE]` / code `STREAM_CLOSED`. That error is **harness-side** — thrown at `D:\deepseek-harness\packages\llm\llm-deepseek\src\sse.ts:39`. There is **no `STREAM_CLOSED` anywhere in I-harness** (repo-wide grep: zero hits; I-harness ships `llm-openai`, `llm-anthropic`, `llm-bedrock`, `llm-gemini`, `llm-mock`, `llm-seam` and **no `llm-deepseek`**). The earlier note that placed this in "`packages/llm/llm-deepseek`" was reading the *harness* tree with the *product* root in mind.

Also harness-side, and worth knowing if a goal dies mid-run: `STREAM_CLOSED` is **deliberately not retried**. `DEFAULT_RETRYABLE_CODES` is `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]` (`D:\deepseek-harness\packages\llm\llm\src\retry-policy.ts:18-24`), and a test pins the exclusion (`llm-retry/tests/transport-recovery.spec.ts:177`, "exposes a clean partial EOF as non-default-retryable STREAM_CLOSED"). A partial EOF therefore kills the in-flight agent and **disarms the goal**. When that happens: nothing on disk is lost — the artifacts *are* the memory — and the goal is re-armed with `update_goal action=resume`, not restarted.

---

## 2. What this repo is, in thirty seconds

- **pnpm monorepo**, 68 packages under `packages/`, plus `apps/` (`apps/cli`, `apps/tui`, …).
- **Node ≥ 22.18**; this machine runs **v24.15.0**.
- **Windows-first** — and several traps in §6 are Windows/PowerShell-specific.
- **Zero-external-dependency discipline**: a package uses `node:*` builtins and other workspace packages, nothing else. New runtime dependencies are a design decision, not a convenience.
- Design work lives in `docs/superpowers/` (`specs/`, `plans/`), audits in `docs/audit/`, and this handoff set in `docs/handoff/`. The original session also used a **gitignored** process directory (`.superpowers/`) — §4 records exactly what was in it and what was not published.

---

## 3. What was just delivered, and where its evidence is

The goal was to implement the backend permission/sandbox design **in the order it specifies**:

| Step | State |
|---|---|
| 1. per-call policy resolution | **done, reviewed** — with a `MEASURE` test; the cache decision is "no cache", because the cost is inside budget |
| 2. one denial shape + declared `sandbox_permissions`/`justification` args | **done, reviewed** — declared on **eight** tools, pinned by a test reading the schemas back out of a real `LLMRequest` |
| 3. terminal (+ fs-search ruled out) | **done, reviewed** — terminal refuses **per call**, not at mount (the spec was corrected: a mount-time rule cannot see a mid-session change) |
| 4. escalation ladder | **done, reviewed, fixed, finally reviewed** |
| 5. read isolation | **answered: do not build**, with the revisit condition now written as a concrete seam |

**The final review was four disjoint scopes** (semantics/architecture, tests+mutation, spec compliance, claims audit), because this deployment exposes **exactly one model route** — "use the strongest model" was impossible, so quality was substituted with *structure*. Verdicts worth carrying:

- **No Critical in scope A**; grants reach all four checks; the transient (`allowed-once`) property holds.
- **§5 negatives: NO VIOLATION** — no permission rule engine, no governance layer, no second LLM danger classifier.
- **0 of 131 removed lines weakened** (mutation-verified), both long-standing mutation proofs reproduce exactly.
- **21 false claims in the docs**, including one Critical of mine: a citation written by a freeze commit while claiming same-day verification.
- Scope D's "nine tools" finding was **REFUTED** (eight), and so was one line-number finding. **A reviewer's finding is a claim like any other** — two were false.

The consolidated fix round (`3e0e2536`) closed the two real defects it found:

1. **P1 — the fs refusal advised a retry that could not work.** Under `read-only`, an out-of-workspace write was told to retry with `workspace-write`, which refuses the identical path — so the first retry was guaranteed to fail and the correct one cost a second human approval. `checkWrite` now returns `sufficientMode` and the call site passes it through. The red test **performs the advised retry** rather than asserting the advice string — because a string assertion is exactly what let the terminal's version of this bug ship.
2. **P2 — a malformed `sandbox_permissions`/`justification` pair refused on hosts where nothing is confined**, turning a call that used to succeed into `SANDBOX_DENIED`. The two "nothing to escalate from" branches now precede validation. **This is a declared behaviour change**: on an unconfined host a malformed pair now gets no feedback.

Primary files touched: `packages/sandbox-policy/src/paths.ts`, `packages/session-executor/src/assembly.ts`, `packages/sandbox/src/call-policy.ts`, plus three test files and the spec.

---

## 4. Durable memory — what is in the repo and what is not

**In the repo (a fresh clone has all of it):**

- `docs/handoff/FINAL-REPORT.md` — the closed goal: the four verdicts, the fixes, the parked list, **12 process lessons**.
- `docs/handoff/what-the-design-does-not-answer.md` — four sections: **A** still open, **B** answered during the work (do not report as open), **C** residuals found by implementation, **D** findings considered and **declined with rulings**.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — the design and its implementation plans.
- `docs/CAPABILITIES.md` and `docs/CAPABILITIES-DETAIL.md` — the capability inventory; `docs/audit/` — the audit data and the seven-way comparison.

**NOT in the repo — it existed only in the original session's working copy, which was gitignored (`.superpowers/`):**

- The SDD ledger (`.superpowers/sdd/2026-09-14-sandbox-per-call-resolution/progress.md`, ~840 lines): the round-by-round record, whose `STATE` block was the live memory. It corrected itself inline many times, so its *corrections* are its most useful part.
- The raw review evidence: `scope-C-report.md` (46 KB), the four scope reports, the mutation transcripts, the task briefs and the per-task reports.

**Why the split:** those files are process churn — dense, self-superseding, and mostly interesting for *how* the work was done rather than *what* state it is in. `FINAL-REPORT.md` §8 distils their lessons, and §3 of this document carries their outcomes. **The gap is real and you should know it exists:** if you need the raw provenance (why a particular line number was changed, which agent id did what), it is not on this branch and a clone cannot get it. Ask the original workstation's owner rather than assuming it never existed.

**If you are an agent working here:** keep your own notes in a gitignored scratch directory if you like, but **do not treat it as durable** — committing does not save it. Anything the next person must have belongs in a tracked path.

---

## 5. Verification — exact commands and the measured baselines

**First, on a fresh machine** (this is what "take over" needs before anything else):

```bash
git clone https://github.com/ivankwanpn/I-harness
cd I-harness
git checkout m62            # the branch the work is on
pnpm install                # pnpm >= 10 required (package.json engines: node >=22.18, pnpm >=10)
```

Then confirm you are on the described state: `git log --oneline -1` and `git diff 3e0e2536 HEAD -- packages apps` (expect: empty).

**The verification gates:**

```powershell
$env:NO_COLOR = $null                                   # REQUIRED — see §6
pnpm -r typecheck                                       # expect: exit 0, every package
node scripts/audit/check-thresholds.mjs                 # expect: ALL THRESHOLDS PASS
node scripts/audit/verify-citations.mjs --all-problems  # CLEAN TREE ONLY — see §6
pnpm test                                               # -r --no-bail, then the tui quarantine
```

Single file: `cd packages/<pkg>; npx vitest run test/<file>.test.ts`.

**And a coverage limit you must not read past:** `verify-citations.mjs` takes its citations from **`docs/audit/data/*.json`** — the audit dataset — not from prose. Adding this handoff set left the count *identical* (8678 resolved / 51 problems), which proves the point: **the `path:line` citations inside `docs/handoff/` and the design spec's prose are NOT machine-checked.** They were verified by hand while writing, which is weaker. If you change code that any citation here names, **re-check the ones you touched yourself** — no tool will tell you they rotted.

**Hint for a first session:** run the four gates once *before* changing anything, and compare against the baselines below. If a number differs on a fresh machine, you have learned something about the machine before you have muddied it with your own edits.

**Measured at `3e0e2536` on a clean tree:**

- typecheck **exit 0**, every package.
- thresholds: **ALL THRESHOLDS PASS**.
- citations: **8678 resolved, 0 missing files, 51 problems**, of which exactly **3 are `BLANK_LINE`** — `compaction/src/config.ts:99`, `settings/src/index.ts:1269`, `settings/src/index.ts:918`. **All three pre-existing, none from the recent range.**
- full suite: **every package green except `session-executor`**, whose only two failures are the known-red WSL-`bash` pair (`test/workspace-cwd.test.ts`, 87 passed / 2 failed of 89). **`apps/cli` passed on this run** — its M12 pair was inherited as known-red and did not redden, so treat that item as retired until it reddens again.

**The known-red pair, verified at the cause rather than inherited:** those tests shell out to `bash`, and on this host `bash` resolves to `C:\WINDOWS\system32\bash.exe` (WSL's), where `bash -c "node --version"` fails while the Windows `node --version` returns `v24.15.0`. Reproducible in one command; not a regression from any change in this range.

---

## 6. Traps that have actually cost time in this repo

1. **`$env:NO_COLOR` breaks test runs.** Unset it before running anything.
2. **PowerShell `Select-String` is case-INSENSITIVE by default.** It produced a false "7 blank-line findings" report and a false `MUTATION` hit in a commit message. Use exact patterns (`-CaseSensitive`) and diff-scoped checks.
3. **`git restore <file>` reverts to the INDEX, not to HEAD.** With nothing staged it destroys your uncommitted work — it destroyed a verified fix here. Prefer targeted edits; if you must restore, commit or stash first.
4. **`verify-citations.mjs` has three blind spots:** it reads the **working tree** (so a run while an agent is mid-edit looks authoritative and is not), it only detects *blank*/missing/comment-only targets (a citation that **shifted onto different non-blank code is invisible**), and without `--all-problems` it prints a **capped** view. One citation in this range stopped being blank because content moved onto it — the checker now calls it resolved. Run it clean, uncapped, and never report its output as "citations verified".
5. **A comment asserting a *current* fact about a component another task is about to change is a promise nothing checks.** **Nine** instances in one goal. The rule that works: *the task that changes a component owns its comments* — and in every case the catch came from a later reader, never the author of the change.
6. **`Tool<Args, Output>` erases `Output` at the registry.** "The type says so" is never evidence at a tool boundary: removing a field from a tool's output type leaves `tsc` exit 0 **and every test green** (verified twice).
7. **A test that covers a path is not a test that fails when the path breaks.** Ask "could this redden?" — and when a mutation reddens exactly one test, ask whether the others *could* have. A red test can also fail for the **wrong reason** and look like success (one red-first run here went red because an unrelated approval prompt threw).
8. **A reviewer's finding is a claim like any other.** Specificity is not evidence of verification. Two were false; one had been propagated into a live dispatch before anyone checked.
9. **Long runs are fragile.** A harness-side `STREAM_CLOSED` kills the agent and disarms the goal (§1). Re-arm with `update_goal action=resume`; the files on disk are the state.

---

## 7. Not done — the honest list

**One design question remains genuinely open:** whether IH should have **project-level settings trust** (a repo being able to change behaviour for whoever cloned it). grok has an answer; IH's `settings` is user-level only. Product positioning, not a technical gap. Nothing in the delivered work depends on it.

**Six findings were considered and declined, each with a written ruling** (`what-the-design-does-not-answer.md` §D, in this directory):

1. The fs guard path's refusal carries its denial as **JSON inside `error`** rather than as a structured `denial` field — the advice-bearing refusal is the one the model must parse. Parked because three tests parse that encoding back out, so unifying it is its own task with its own red-first test.
2. `modeOverride` is passed even when **nothing was granted** — the parameter carrying the grant can nullify a mid-call tightening.
3. On an already-unconfined host, a **narrower** request is silently discarded (answering a request it did not honour — not a fail-open).
4. The shell's **runtime** OS denials are unclassified: `classifyDenial`'s only callers are tests and `denialSignatures` is read by nothing. Pre-existing, and §3.2's "one rule for any surface" is qualified accordingly in the spec.
5. `patch.ts`'s latent fail-open is protected by **one test and no lint gate** (the repo has no eslint config). Recorded rather than fixed.
6. ~18 **stale citations** in `docs/CAPABILITIES-DETAIL.md` — pre-existing debt. The one claim in it that this range *falsified* is fixed (see below).

**Reachability — read this before assuming confinement is on:**

- **Nothing in production appends a `sandbox/mode` event.** Repo-wide, it appears as the event-type declaration (`packages/core-session/src/index.ts:43`), the reader (`packages/sandbox-policy/src/session-mode.ts:6-12`), and tests. `sandbox-policy` has **no writer at all** — IH ported the fold, not dsh's setter. So the mid-session tightening path is correct-but-unexercised; the escalation ladder is the reachable half.
- **The TUI composes no sandbox.** The word `sandbox` does not occur in `apps/tui/src/index.ts`, and the embedded session service is built with **no `sandbox` key** (`packages/tui/src/backend/embedded.ts:969`). On the shipped TUI the fs guard, the shell policy and the terminal refusal are **inert** and the ladder is unreachable. **Confinement is enabled by the CLI and the web host only.** Related and worth knowing: the same construction passes `approveAll: opts.approveAll ?? true` (`:976`) — so **on the TUI, `approveAll` is the DEFAULT**, and a host that auto-approves everything has also handed over *widening the sandbox mode* for a call. That consequence is documented in spec §3.3 point 2.
- **Read isolation is not "unwired", it is unimplemented.** No backend declares `capabilities.readIsolation: true` (`sandbox-local` says `false` explicitly at `:47`/`:71`; `sandbox-windows-acl` omits the declaration, which the contract at `packages/sandbox/src/index.ts:38` treats as false), so `requireReadIsolation: true` makes **every confined call throw** by design (`:64-71`). The revisit condition, including the `denyRead?: readonly string[]` field that does not exist yet, is written up in spec §3.5.
- `docs/CAPABILITIES-DETAIL.md:285` used to name `session-mode.ts` as the `sandbox/mode` **producer**; it only reads. Corrected — a mechanism claim this range disproved must not be inherited silently.

**And one number you must not quote:** the per-call policy cost of **0.056–0.125 ms** is **withdrawn**. Nothing in the repo reproduces it; it was one uncontrolled observation. The *conclusion* survives (the worst observation, 0.275 ms, is 0.55× the 0.5 ms budget, so no cache is warranted); the *attestation* does not. Also: the test guarding it is a **ceiling, not a detector** — its bound was tightened 5 ms → 2 ms, and a semantically identical 10×-scan mutation printed 1.002 ms/call, i.e. **a 10× regression passes both bounds**. That is recorded in spec §7 and in the test's own comment.

---

## 8. If you are the next agent: the process that was used here

- **Plan → fresh implementer per task → independent task review → scoped re-review after fixes → final whole-branch review in disjoint scopes → fix round → finishing.** The ledger is the long-term memory between fresh contexts; each task's brief names the *exact* files, the red-first test, and the mutation proof.
- **Constraints that were binding, and should stay binding:** no production change without a test that failed first **and** a mutation proof; all §8 thresholds keep passing; **push to `origin/m62` only**; record honestly what the design does not answer; the design's §5 exclusions are binding (no permission rule engine, no governance layer, no second LLM danger classifier).
- **One model route** means you cannot buy a stronger reviewer. Substitute **structure**: disjoint scopes, fresh contexts, each required to re-derive claims from code — and report that as structure, not as extra rigour.
- **If the budget binds, the agreed reduction order is:** merge the semantics scope into the compliance scope *for reporting* → trim the claims audit's sampling, **never** its triage → **never** drop the tests+mutation scope. Any reduction must be reported as a reduction. (It was not needed this time.)
- **Finishing:** `finishing-a-development-branch`, **Option 3 only** (keep on `m62`, pushed) — the goal's push constraint pre-decides it; do not open a PR.

---

## 9. What this handoff does NOT establish

- I did **not** run the TUI or the web host end-to-end. The reachability statements in §7 come from reading code plus targeted greps, not from driving those surfaces.
- The six parked findings in §7 are **unproven in both directions** — no test was written to demonstrate them, and none was written to rule them out.
- The performance figure is withdrawn; no replacement measurement exists, and **IH has no benchmarking harness** (dsh does).
- On the harness side I verified only the code paths cited in §1 (`sse.ts:39`, `retry-policy.ts:18-24`, the pinning test). I did not reproduce the `STREAM_CLOSED` failure itself.
- Everything in §5 is a **snapshot**: those numbers were true at `3e0e2536` on this machine. Re-run before relying on them.
