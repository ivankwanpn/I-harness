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
| Branch | **`m64`** — the live branch. `m62` is its ancestor and is finished; `m63` was retired (see §0.1) |
| HEAD | **`a5e4bb0e`** — `docs(handoff,audit): scope the still-holds count, and drop a "verbatim" the code refutes` |
| Sync / tree | `HEAD == origin/m64`, working tree **clean** |
| What `m64` holds | the **M62 sandbox milestone** (whose code state is `3e0e2536`) + **M1 Phase A/B** + **the 2026-09-15 review cycle** (7 commits, docs and comments only) — 50 commits after `3e0e2536`, 104 after `origin/main` |

**This document is not a snapshot of the tip; it is the orientation guide, and §5's baselines are the M62 baseline plus a tip section.** Two things follow, and the second is the one that bites:

- The M62 work itself is unchanged: `git merge-base --is-ancestor 3e0e2536 HEAD` succeeds.
- **`git diff 3e0e2536 HEAD -- packages apps` is NO LONGER empty** — this guide used to tell you it was, and that instruction became false when M1 Phase B landed code after `3e0e2536`: **14 paths, six of them sources** (`session-executor/src/assembly.ts`, `sandbox-policy/src/session-mode.ts`, `provider/src/index.ts`, `plan-mode/src/index.ts`, `session-persistence/src/index.ts`, `apps/cli/src/index.ts`) and eight tests. To confirm *the state you are adopting*, use `git rev-parse HEAD origin/m64` and read §5's tip bullet.
- **For the milestone that is actually live, read `docs/handoff/2026-09-15-m1-phase-b-handoff.md`** — its own record, including the review ledger (§2) that carries every verdict, ruling and parked minor from the 2026-09-15 review cycle.

The last goal — implementing `docs/superpowers/specs/2026-09-14-backend-permission-sandbox-design.md` — is **complete**: five steps, a four-scope final review, a consolidated fix round. Its report is the first thing to read if you need depth: `docs/handoff/FINAL-REPORT.md`.

**One surprising thing you should know up front** (it is a reachability statement, not a bug): the "session is tightened mid-run" scenario the whole sandbox design exists for is **still unreachable in production**, and the **TUI composes no sandbox at all**. A producer does exist now — M1 Phase B added one — but it runs at **construction time** only, recording the mode a session *starts* under; it does not create the mid-session path. Details in §7.

### 0.1 Which branch is which — measured, because this already went wrong once

On **2026-09-14 two machines continued from the same commit** (`62711537`), and only one of them knew it.

| Ref | Commit | What it actually is |
|---|---|---|
| `origin/m64` | `a5e4bb0e` | **The branch to take over from.** 104 commits ahead of `origin/main`, 2 behind. Holds the M62 sandbox milestone, M1 Phase A/B, and the 2026-09-15 review cycle. |
| `origin/m62` | `ddd88a15` | The **finished** milestone branch. An ancestor of `m64` — nothing on it is missing from `m64`. |
| `origin/main` | `f39d4870` | The integration point. Contains the milestones **only as far as `62711537`** — it does **not** have the M62 sandbox work, M1, or the review cycle. |
| `origin/m63` | *retired* | Was `main` + one docs commit. **Deleted 2026-09-15** — and see the correction below: it was our mistake, not an empty branch. |
| `m62` @ `62711537` | | What the other machine snapshotted as "m62 complete, merged into `main`". |

**What happened.** The 2026-09-11 audit handoff (`docs/audit/2026-09-11-ih-takeover-handoff.md`) recorded "m62 = `6271153`". On 09-14 the other machine took that as current: it treated `m62` as a finished milestone, fast-forwarded `main` to that point, and opened `m63` off `main` for the next milestone. Meanwhile this branch kept committing to `m62` — 55 commits, the entire sandbox milestone — and never touched `main`. **A document asserting the state of a *branch* is a snapshot of the most mobile thing in a repo** — the same defect class as §6 item 5, one level up.

**m63 was a dead end, and that is measured, not assumed.** Its three commits were `d309e68e` and `f39d4870` (both already on `main`) plus `c5e03fd6`, whose *entire* content was one edit to that document asserting three false things: that `main` had merged `m62`, that `m62` stopped at `6271153`, and that `m62` was two commits **behind** `main`. Relative to `m62`, `m63` was missing **7,651 lines**, including `scripts/audit/verify-citations.mjs` — on `m63` that file is the **older checker that silently skipped 1,532 citations**. So it was not merely empty: working on it would have resurrected a bug this branch had already fixed.

**It is safe to delete, which is why it was.** Nothing unique was lost: `f39d4870` *is* `origin/main`; `d309e68e` is on `main`; the only casualty is `c5e03fd6`, a false statement. **To restore it anyway:** `git push origin c5e03fd6e0de8dbec2f7b965d7e90ac42f975d4a:refs/heads/m63`.

**Verify the whole picture yourself (four commands):**

```bash
git rev-list --count origin/main..origin/m64                    # 104 = m64 is ahead of main
git ls-tree origin/main packages/sandbox/src/call-policy.ts     # empty = main lacks the sandbox work
git merge-base --is-ancestor 3e0e2536 origin/main; echo $?      # 1 = main lacks the M62 code state
git ls-remote --heads origin | grep m63                         # empty = m63 retired
```

**Still open, and it is the human's call, not an agent's:** `main` is **104 commits behind** and contains neither the M62 sandbox milestone nor M1. The merge is one command in a conflict-free direction — `m64` has never touched the one file `main`'s two unique commits touch (`docs/audit/2026-09-11-ih-takeover-handoff.md`), so nothing in the merge overlaps:

```bash
git switch main && git merge --no-ff origin/m64 && git push origin main
```

This is documented rather than executed because the repo's own discipline says **merge timing into `main` is the human's decision** (`d309e68e`). Until that happens, **open the next milestone branch off `m64`, not off `main`.**

**Correction, 2026-09-15 — recorded on `m64`.** The paragraph above says "Nothing
unique was lost". That is true of what `origin/m63` *held*, and it is what this
branch could see. It is **not** true of what `m63` *carried*: that machine had
**17 unpushed commits** on its own `m63` — the entire "opencode-fork narrow fix" —
and they were abandoned rather than merged. Two mistakes were made on that branch,
and both were ours, not accidents:

1. **It was opened off `main` while `m62` was still the live milestone branch.**
   `main` had been fast-forwarded only as far as `62711537`, and `m62` kept
   receiving commits afterwards. So every commit on `m63` sat on a base 7,651
   lines stale, including an older `verify-citations.mjs` that silently skipped
   1,532 citations — working there would have resurrected a bug `m62` had already
   fixed.

2. **The audit work on it was measured against the wrong revision.** That work
   concluded `packages/core/src/session/kernel/` "does not exist in the 999.0.19
   revision" — which is correct *for 999.0.19* — and on that basis retired seven
   mechanisms, one `forkDeltas` entry and several prose clauses. But the audited
   revision is **999.0.20**, where the subsystem is present:
   `packages/core/src/session/kernel/` holds `coordinator.ts` (828 lines),
   `lifecycle-store.ts` (929), `recovery-planner.ts` (179), `tool-scheduler.ts`
   (133) and `diagnostics.ts` (73), and every identifier that work called
   "zero-match" is there — `LifecycleStore` 126, `RecoveryPlanner` 31,
   `KernelUnavailableError` 15, `session_execution` 22, `TurnCoordinator` 13,
   `acquireIdle` 12, `selectSettlement` 3.

   **The D3 data was right; the measurement used the wrong tree.** Pointing
   `SOURCE_PATHS` at the trees this machine actually has resolves **8678/8678
   citations with 0 missing files**, and the baselines in §5 reproduce exactly.
   Nothing in the audit data needed the "fix" `m63` applied to it — and because
   that fix was never pushed, `m62` never inherited it, which is the only reason
   it is still intact.

So `m63` was not merely a dead end that emptied itself: it was a wrong branch
carrying wrong conclusions, and deleting it was the right call rather than a
loss. Two things follow. The restore command above should **not** be run, and the
name should not be reused — `m64` continues from `m62` for that reason.

The durable lesson is one level up from this section's own: a claim about which
*tree* is authoritative rots exactly as a claim about which *branch* is. Both were
asserted in documents, and both were stale when read. The repair is the same in
both cases — measure it, and make the wrong answer fail loudly instead of quietly.

---

### 0.2 The 2026-09-15 review cycle — what a second session found, and the one lesson worth inheriting

M1 Phase B was implemented on another machine, and its reviews were left outstanding. A second session
took `m64`, ran them, reviewed its own commit, and fixed what came back. Seven commits, all docs and
comments — **no behaviour changed anywhere** (measured: the only source files this cycle touched are
`packages/session-executor/src/assembly.ts` and `apps/cli/src/index.ts`, plus one test file, and every
changed line in all three is a comment).

**Verdicts:** Task 5 **Approved**; Tasks 6 and 7 **Needs fixes** → fixed → re-review *all findings
addressed*; the reviewing session's own commit **Needs fixes (1 Critical)** → fixed → re-review *all
addressed*; the final whole-branch review split in two — **code: merge-sound, no Critical**;
**record: not ready** (1 Critical, 4 Important) → fixed → residual verification clean. The full
history, with reviewer ids and per-finding verdicts, is in
`docs/handoff/2026-09-15-m1-phase-b-handoff.md` §2.

**What was actually wrong, because the shape repeats:**

- The milestone's own headline reconciliation published a tally (`6 / 2 / 14`) that **no table in its
  own document supported** — the tables said `5 / 2 / 15`. Four independent counts agreed on the latter.
- An "erratum" had **corrected a citation that was already right** (`file-backed.ts:91` is the
  declaration; `:89` is a comment) — and the false correction reached two durable documents.
- The reviewing session's own commit **published a falsehood into five documents**: that `/sandbox` in
  the frozen `apps/cli/src/web.ts` was a shipped host which tightens a live session. It only writes a
  setting for sessions created *later*; the event's sole producer is `assembly.ts:354`, at construction.
  It was copied from a handoff paragraph without being verified.
- The durable handoff said three reviews were `NOT REVIEWED` while its own gate sentence ("M1 is not
  complete until the reviews are clean") was already **met** — and the entire review history lived in a
  gitignored ledger that no clone can see. It is now a tracked section.
- A count ("exactly two rows are `still-holds`") was an artefact of the **grep pattern** rather than a
  measurement: the pattern matched only the bold form, and the file carries **eleven**.

**The one lesson, and it is not "review the diff":** every defect above — in the other session's work,
in this session's own commit, and in **three consecutive fix waves, each of which introduced a fresh
defect of the class it was fixing** — was found by **re-running the measurement the text quotes**, and
none by reading. Five false "corrections" shipped during this cycle, every one caught that way. When
you touch a document that cites a number, a line, or a revision, **re-derive it in the tree you are
standing in**, and date the correction so the next reader can tell what moved.

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

**This section describes the M62 goal, whose code state is `3e0e2536`.** The milestone that *followed* it — M1 Phase A/B, which wired seven "unreachable" declarations to production paths and gave `sandbox/mode` its first producer — has its own record: `docs/handoff/2026-09-15-m1-phase-b-handoff.md` (task table, rulings, deferred minors, and the review ledger from §0.2 above). Read that one for the state of the tree; read this one for how the repo behaves.

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
git checkout m64            # the branch the work is on (m62 is its ancestor, finished)
pnpm install                # pnpm >= 10 required (package.json engines: node >=22.18, pnpm >=10)
```

Then confirm you are on the described state — `git rev-parse HEAD origin/m64` (they must match) and
`git log --oneline -1`. **Do not use `git diff 3e0e2536 HEAD -- packages apps` to check this**: it was
the right test while M62 was the tip, and it is empty no longer — M1 Phase B changed 14 paths under
`packages/` and `apps/` after `3e0e2536`, six of them sources.

**The verification gates:**

```powershell
$env:NO_COLOR = $null                                   # REQUIRED — see §6
pnpm -r typecheck                                       # expect: exit 0, every package
node scripts/audit/check-thresholds.mjs                 # expect: ALL THRESHOLDS PASS
node scripts/audit/verify-citations.mjs --all-problems  # CLEAN TREE ONLY — see §6
node scripts/audit/check-reachability.mjs               # expect: 731 ts files, 523 finding(s)
pnpm test                                               # -r --no-bail, then the tui quarantine
```

`check-reachability.mjs` exists **only from M1 Phase A onward** — it is not on `m62`; it arrived with `m64`.

**One gate may refuse to run on your machine, and that is by design.** The audit tooling resolves citations against *reference source trees* whose paths are **machine-local**: the committed defaults in `scripts/audit/lib-union.mjs` describe the original workstation, and `missingSourceRoots()` (`:114`) exists so a caller "must refuse to run on a non-empty result rather than emit a phantom problem for every citation underneath" (`:110-111`). Name your own trees in **`scripts/audit/source-paths.local.json`** (gitignored — it will *not* arrive with your clone) or set **`IH_AUDIT_SOURCE_PATHS`**. On the original workstation neither is needed, because the committed defaults all resolve — so I verified the code that refuses, **not** the refusal itself.

Single file: `cd packages/<pkg>; npx vitest run test/<file>.test.ts`.

**And a coverage limit you must not read past:** `verify-citations.mjs` takes its citations from **`docs/audit/data/*.json`** — the audit dataset — not from prose. Adding this handoff set left the count *identical* (8678 resolved / 51 problems), which proves the point: **the `path:line` citations inside `docs/handoff/` and the design spec's prose are NOT machine-checked.** They were verified by hand while writing, which is weaker. If you change code that any citation here names, **re-check the ones you touched yourself** — no tool will tell you they rotted.

**Hint for a first session:** run the four gates once *before* changing anything, and compare against the baselines below. If a number differs on a fresh machine, you have learned something about the machine before you have muddied it with your own edits.

**The tip baseline — measured at `a5e4bb0e` on a clean tree. Compare your gates against THIS row:**

- typecheck **exit 0**, every package.
- thresholds: **ALL THRESHOLDS PASS**.
- citations: **8680 resolved / 0 missing / 51 problems**, of which exactly **3 are `BLANK_LINE`** (all pre-existing).
- reachability instrument: **731 ts files, 523 finding(s)** — the figure Phase B publishes, reproduced here.
- full suite: **every package green except `session-executor`** — the known-red WSL-`bash` pair only (86 passed / 2 failed of 88), unchanged across this cycle.
- What the 2026-09-15 cycle changed in the tree: **docs, the audit corpus, and comments only.** No behaviour.

**The M62 baseline, measured at `d682a50b` — kept because the corrections below were computed against it:**

- typecheck **exit 0**, every package.
- thresholds: **ALL THRESHOLDS PASS**.
- citations: **8680 resolved, 0 missing files, 51 problems**, of which exactly **3 are `BLANK_LINE`** — `compaction/src/config.ts:99`, `settings/src/index.ts:1269`, `settings/src/index.ts:918`. **All three pre-existing, none from any recent range.** *Corrected 2026-09-15 by re-measurement: this bullet published `8679` and the block heading names `d682a50b`, and neither is the number to compare against. **The state you are adopting reads `8680`** — the wave-2 corpus fix (`1cef0d59`) added one citation while re-deriving the 12 in the repair bullet below, and this figure was never updated for it. `d682a50b` itself read **8676 / 55 / 4** plus 2 `OUT_OF_RANGE` and 1 `NO_RESOLVABLE_CITATION` (next bullet). Measured at HEAD: `node scripts/audit/verify-citations.mjs --all-problems` → `8680 resolved, 0 missing, 51 problems`.*
- reachability instrument: **731 ts files, 523 finding(s)** — exactly what the Phase B handoff publishes, independently reproduced here.
- full suite: **every package green except `session-executor`**, whose only two failures are the known-red WSL-`bash` pair (`test/workspace-cwd.test.ts`, 86 passed / 2 failed of 88).
- **Baselines are snapshots, and this one moved twice in two days.** At `m62` (`3e0e2536`) the same citation gate read **8678 resolved / 51 problems / 3 `BLANK_LINE`**; at `m64` before the repair below it read **8676 / 55 / 4** plus **2 `OUT_OF_RANGE`** and **1 `NO_RESOLVABLE_CITATION`**. Both deltas are attributable, and both were *caused by edits to cited files* — see §6 item 4.

**The repair, so the record is not just a number.** Four things were fixed on 2026-09-15 — three regressions Phase B introduced or exposed, and one I inflicted on myself while fixing them — all in the audit corpus the checker reads (`docs/audit/data/*.json`) plus two comments in `packages/session-executor/src/assembly.ts`:

- Phase B's Task 4 **deleted two dead declarations from `packages/provider/src/index.ts`**, shrinking it 863 → 834 lines. Two cited ranges (`:848-861`, `:780-863`) then ran **past EOF** and a third citation no longer resolved. Repointed by the exact −29 offset: `:820→:791`, `:848-861→:819-832`, `:780-863→:751-834`, and the `failurePolicy` prose `(820-862)→(791-833)`.
- Phase B's Task 1 **added 14 lines to `packages/session-persistence/src/index.ts`**, pushing a citation onto a blank line at `:277` — and that citation had pointed at the wrong code (`ensureOwnership`) even before, which is why it stayed silent until it became blank. Repointed to the code the claim actually names: `:254` (opt-in default), `:271` (single-flight), `:276-288` (the operation chain and its non-rejecting gate), `:324` (single-flight use).
- **My own repair moved 12 more, and the checker could only see 2 of them — and re-anchoring them was not a repair (this bullet corrected 2026-09-15).** Expanding two comments in `assembly.ts` added **7 lines**, which shifted *every* corpus citation into that file below the insertion: **12 occurrences across 3 corpora** (**8 distinct citation strings**, **11 distinct (file, citation) pairs**), of which only the 2 that landed on a **blank** line were reported. All 12 were then repointed by the exact `+7` offset (`old[N] == new[N+7]` for every cited line, endpoints included) — but that mapping is **content-preserving by construction, so it is not verification**: it proves only that each citation still points at whatever it pointed at *before*, and **their validity was not re-derived in that commit at all**. (The same lines were already pointing at unrelated code *before* the shift — measured at `a7f6775d^`, `:702` was `table: subagent.table,` — because `assembly.ts` had been refactored repeatedly since the corpus was authored against `b844fcd9`; a shift of this kind can preserve an anchor, never repair one.) All 12 have since been re-targeted against their own claims' text and verified one by one, so **0 remain at the shifted position — and the checker could see none of them either way**. **This is §6 item 4 happening to me, in the same commit that documented it.** **And one of those 12 claims was itself false — re-anchoring a citation cannot repair false prose (added 2026-09-15):** `d3-ih`'s `context-window-resolution-chain` asserted that the compact pass-through "stays exactly as the caller wrote it", which `73c9b725` had already superseded — `assembly.ts:810-817` **drops** the caller's compact config (with a warning that auto-compaction is disabled) when no window resolves. The claim's own text was corrected in the wave-2 fix, and the episode is the reason to read "0 remain at the shifted position" as a statement about *anchors*, not about the claims being true.
- Two `assembly.ts` comments were false and are now true: the one quoting the **withdrawn** `0.056-0.125 ms` figure as a measurement (spec §7 had withdrawn it; the source had not), and the one saying "nothing in production appends the event" — which the construction-time producer at `:354` in the same file falsified.

**One more count correction, because the bullet above is what a new session compares its gate to:** the wave-2 fix (`1cef0d59`) added **one citation** to the corpus while re-deriving the 12, so the resolved count moved `8679 → 8680` with the problem count unchanged (51, of which 3 `BLANK_LINE`). The baselines bullet above now carries **8680**; `d682a50b`'s own pre-repair values stay in the following bullet, labelled as such.

**The known-red pair, verified at the cause rather than inherited:** those tests shell out to `bash`, and on this host `bash` resolves to `C:\WINDOWS\system32\bash.exe` (WSL's), where `bash -c "node --version"` fails while the Windows `node --version` returns `v24.15.0`. Reproducible in one command; not a regression from any change in this range.

---

## 6. Traps that have actually cost time in this repo

1. **`$env:NO_COLOR` breaks test runs.** Unset it before running anything.
2. **PowerShell `Select-String` is case-INSENSITIVE by default.** It produced a false "7 blank-line findings" report and a false `MUTATION` hit in a commit message. Use exact patterns (`-CaseSensitive`) and diff-scoped checks.
3. **`git restore <file>` reverts to the INDEX, not to HEAD.** With nothing staged it destroys your uncommitted work — it destroyed a verified fix here. Prefer targeted edits; if you must restore, commit or stash first.
4. **`verify-citations.mjs` has three blind spots, and one of them has a measured hit rate of 2 out of 12.** It reads the **working tree** (so a run while an agent is mid-edit looks authoritative and is not); it only detects *blank*/missing/comment-only targets, so a citation that **shifted onto different non-blank code is invisible**; and without `--all-problems` it prints a **capped** view. Measured on `m64`: a **comment-only** edit that added 7 lines to `assembly.ts` moved **12 occurrences** of corpus citations into that file — **8 distinct citation strings**, **11 distinct (file, citation) pairs** — and the checker reported **2**, the ones that landed on a blank line. **The paragraph that used to stand here drew the wrong lesson from that, and is corrected 2026-09-15.** The commit that fixed those 2 **re-anchored** the remaining occurrences by the exact `+7` offset (`old[N] == new[N+7]`, endpoints included) and presented the mechanical mapping as the verification. **That is a re-anchor, not a repair:** the mapping is content-preserving by construction, so it proves only that a citation still points at whatever it pointed at *before* — and **the validity of those citations was not re-derived in that commit at all**. (Nor did the edit cause their staleness: the same lines already pointed at the same unrelated code before the shift — measured at `a7f6775d^`, `:702` was `table: subagent.table,`, the identical line the shift landed back on — because `assembly.ts` had been refactored repeatedly since the corpus was authored against `b844fcd9`. A shift of this kind cannot break a citation; it can only preserve where it pointed.) **All 12 have since been re-targeted against their claims' own text, one at a time, and verified; 0 remain at the shifted position — the checker could see none of them either way, and re-anchoring alone would have left every one of them pointing at unrelated code.** One further trap in the same function, `verify-citations.mjs:197-216`: a plain `//` line is classified as **code** (only `//!`, `///`, `/**`, `*` and `#` count as doc comments), so a citation landing on an ordinary `//` comment is reported as resolved — and an unrelated nearby comment is exactly where a rotted citation tends to land. **So: any edit to a cited file invalidates citations into it, and the checker tells you about a small minority of them.** Repoint them yourself **and check each new target against the claim's own words** — the offset arithmetic is a necessary first step, never evidence. And when a claim's *own text* has been overtaken by later code, no re-target can rescue it: say so instead of moving the citation onto code that contradicts it.
5. **A comment asserting a *current* fact about a component another task is about to change is a promise nothing checks.** **Nine** instances in one goal. The rule that works: *the task that changes a component owns its comments* — and in every case the catch came from a later reader, never the author of the change.
6. **`Tool<Args, Output>` erases `Output` at the registry.** "The type says so" is never evidence at a tool boundary: removing a field from a tool's output type leaves `tsc` exit 0 **and every test green** (verified twice).
7. **A test that covers a path is not a test that fails when the path breaks.** Ask "could this redden?" — and when a mutation reddens exactly one test, ask whether the others *could* have. A red test can also fail for the **wrong reason** and look like success (one red-first run here went red because an unrelated approval prompt threw).
8. **A reviewer's finding is a claim like any other.** Specificity is not evidence of verification. Two were false; one had been propagated into a live dispatch before anyone checked.
9. **Long runs are fragile.** A harness-side `STREAM_CLOSED` kills the agent and disarms the goal (§1). Re-arm with `update_goal action=resume`; the files on disk are the state.

---

## 7. Not done — the honest list

**Outstanding as of `a5e4bb0e`, and whose call each one is:**

- **`main` is 104 commits behind** and contains neither the M62 sandbox milestone nor M1. The merge is the **human's decision** (repo discipline, `d309e68e`); the one-line command is in §0.1.
- **M1's completion definition is met by an explicit, scoped carve-out**, not silently: the two remaining `still-holds` rows (the `sandbox/mode` pair) are declared deliberate and outside M1's list. The scope and its basis are in `2026-09-15-m1-phase-b-handoff.md` §2.
- **The deferred-minors roll-up is triaged**: of 33 accumulated minors exactly **one** was must-fix (the parked Task 5 ruling's documentation remedy) and it landed in `d693cd7d`; the rest ship as-is with written reasons.
- **The "Phase A was already cleared" premise behind the final review's scoping is unverifiable from this repository** — Phase A's own final review left no tracked artifact. It is recorded as such rather than assumed.
- **A harness-side crash is not the code's problem, but it will interrupt you.** `dsh web` died with Windows fail-fast `0xC0000409` (exit `3221226505`) on 2026-09-15 mid-session. Work on disk survived; expect long tool calls to be cut and re-check state before resuming.

**One design question remains genuinely open:** whether IH should have **project-level settings trust** (a repo being able to change behaviour for whoever cloned it). grok has an answer; IH's `settings` is user-level only. Product positioning, not a technical gap. Nothing in the delivered work depends on it.

**Six findings were considered and declined, each with a written ruling** (`what-the-design-does-not-answer.md` §D, in this directory):

1. The fs guard path's refusal carries its denial as **JSON inside `error`** rather than as a structured `denial` field — the advice-bearing refusal is the one the model must parse. Parked because three tests parse that encoding back out, so unifying it is its own task with its own red-first test.
2. `modeOverride` is passed even when **nothing was granted** — the parameter carrying the grant can nullify a mid-call tightening.
3. On an already-unconfined host, a **narrower** request is silently discarded (answering a request it did not honour — not a fail-open).
4. The shell's **runtime** OS denials are unclassified: `classifyDenial`'s only callers are tests and `denialSignatures` is read by nothing. Pre-existing, and §3.2's "one rule for any surface" is qualified accordingly in the spec.
5. `patch.ts`'s latent fail-open is protected by **one test and no lint gate** (the repo has no eslint config). Recorded rather than fixed.
6. ~18 **stale citations** in `docs/CAPABILITIES-DETAIL.md` — pre-existing debt. The one claim in it that this range *falsified* is fixed (see below).

**Reachability — read this before assuming confinement is on:**

- **The `sandbox/mode` producer — CORRECTED 2026-09-15, because this bullet was true when written and false within a day.** It used to say "**nothing in production appends a `sandbox/mode` event** … `sandbox-policy` has **no writer at all**". M1 Phase B's Task 1 (`34c746e6`, on `m64`) added the first production producer: `packages/session-executor/src/assembly.ts:354` appends the event when a host passes a `sandbox` option. **The precise state now, and the two halves must not be conflated:**
  - **A production producer EXISTS, at construction time only** — it records the mode a session starts under, so `effectiveSandboxMode`'s non-default branch is finally taken and the event reaches durable JSONL. (That change also *forced* a companion fix: `session-persistence` had never registered the type, so the first producer made every sandboxed session unloadable — `registerEventType("sandbox/mode")`, same load-gate defect class as `rewind/point`.)
  - **The mid-session tightening path is STILL unreachable in production — and the reason is stronger than this bullet first gave (that clause CORRECTED 2026-09-15).** It needs a host that appends a `sandbox/mode` event *after* construction, and **no shipped host does**. This bullet previously named one: "the only shipped one is `/sandbox` in the **frozen** `apps/cli/src/web.ts`". **That was false.** Measured: `/sandbox` is a tightening *surface*, not a mid-session appender — `web.ts:273-282` runs `await settings.set({ sandboxMode: mode })` and answers "沙箱模式已设为 …（随后创建的会话生效）" (takes effect for sessions created **later**), and `web.ts:470-475` reads `const sandboxMode = opts.sandbox ?? settings.get().sandboxMode` **once**, before `createSessionService({ … sandbox: sandboxMode })`. So no shipped command changes the sandbox mode of a live session at all. The event's sole producer anywhere in production is `assembly.ts:354`, at **construction** — `git grep -n '"sandbox/mode"' -- apps packages` returns **nothing in `apps/`** (under the bare pattern that tree holds one comment, `apps/cli/src/run.ts:271`), and in `packages/` exactly one append, beside the type declaration, the reader and the persistence registration. So the ladder remains the reachable half, and this is still a reachability statement rather than a defect.
  - Two consequences Phase B recorded and this document did not: the producer **silently disarmed a mutation proof** (`sandbox-policy-per-call.test.ts`'s restored-history case can no longer detect removal of the `policyFloor` slice — disclosed in the test itself, deliberately no seam), and **a latent landmine in the frozen TUI** (`packages/tui/src/backend/embedded.ts:536` gates the initial kickoff on `events.length === 0`, so a host passing `sandbox` would make `i-harness tui --prompt …` silently never fire). Their `docs/handoff/2026-09-15-m1-phase-b-handoff.md` §4 R-G/R-F carry the fixes.
- **The TUI composes no sandbox.** The word `sandbox` does not occur in `apps/tui/src/index.ts`, and the embedded session service is built with **no `sandbox` key** (`packages/tui/src/backend/embedded.ts:969`). On the shipped TUI the fs guard, the shell policy and the terminal refusal are **inert** and the ladder is unreachable. **Confinement is enabled by the CLI and the web host only.** Related and worth knowing: the same construction passes `approveAll: opts.approveAll ?? true` (`:976`) — so **on the TUI, `approveAll` is the DEFAULT**, and a host that auto-approves everything has also handed over *widening the sandbox mode* for a call. That consequence is documented in spec §3.3 point 2.
- **Read isolation is not "unwired", it is unimplemented.** No backend declares `capabilities.readIsolation: true` (`sandbox-local` says `false` explicitly at `:47`/`:71`; `sandbox-windows-acl` omits the declaration, which the contract at `packages/sandbox/src/index.ts:38` treats as false), so `requireReadIsolation: true` makes **every confined call throw** by design (`:64-71`). The revisit condition, including the `denyRead?: readonly string[]` field that does not exist yet, is written up in spec §3.5.
- `docs/CAPABILITIES-DETAIL.md:285` used to name `session-mode.ts` as the `sandbox/mode` **producer**; it only reads. Corrected — a mechanism claim this range disproved must not be inherited silently.

**And one number you must not quote:** the per-call policy cost of **0.056–0.125 ms** is **withdrawn**. Nothing in the repo reproduces it; it was one uncontrolled observation. The *conclusion* survives (the worst observation, 0.275 ms, is 0.55× the 0.5 ms budget, so no cache is warranted); the *attestation* does not. Also: the test guarding it is a **ceiling, not a detector** — its bound was tightened 5 ms → 2 ms, and a semantically identical 10×-scan mutation printed 1.002 ms/call, i.e. **a 10× regression passes both bounds**. That is recorded in spec §7 and in the test's own comment.

---

## 8. If you are the next agent: the process that was used here

- **Plan → fresh implementer per task → independent task review → scoped re-review after fixes → final whole-branch review in disjoint scopes → fix round → finishing.** The ledger is the long-term memory between fresh contexts; each task's brief names the *exact* files, the red-first test, and the mutation proof.
- **Constraints that were binding, and should stay binding:** no production change without a test that failed first **and** a mutation proof; all §8 thresholds keep passing; record honestly what the design does not answer; the design's §5 exclusions are binding (no permission rule engine, no governance layer, no second LLM danger classifier). **The M62 goal also bound pushes to `origin/m62` only** — that constraint belonged to that goal; the live branch is now **`m64`**, and the merge into `main` remains the human's call.
- **One model route** means you cannot buy a stronger reviewer. Substitute **structure**: disjoint scopes, fresh contexts, each required to re-derive claims from code — and report that as structure, not as extra rigour.
- **If the budget binds, the agreed reduction order is:** merge the semantics scope into the compliance scope *for reporting* → trim the claims audit's sampling, **never** its triage → **never** drop the tests+mutation scope. Any reduction must be reported as a reduction. (It was not needed this time.)
- **Finishing:** `finishing-a-development-branch`, **Option 3 only** (keep the branch pushed) — the M62 goal's push constraint pre-decided it; do not open a PR. The live branch is `m64`.

---

## 9. What this handoff does NOT establish

- I did **not** run the TUI or the web host end-to-end. The reachability statements in §7 come from reading code plus targeted greps, not from driving those surfaces.
- The six parked findings in §7 are **unproven in both directions** — no test was written to demonstrate them, and none was written to rule them out.
- The performance figure is withdrawn; no replacement measurement exists, and **IH has no benchmarking harness** (dsh does).
- On the harness side I verified only the code paths cited in §1 (`sse.ts:39`, `retry-policy.ts:18-24`, the pinning test). I did not reproduce the `STREAM_CLOSED` failure itself — nor the `0xC0000409` web-server crash in §7.
- **The 2026-09-15 review cycle's verdicts cannot be independently re-derived from this repository.** Three of M1's four task reviews ran **without an implementer report** (that session's ledger was gitignored and never published), so "did the implementer do what it said it did" is permanently unverifiable there; what *was* independently re-measured — the tally, the digest and its rule, the two-row delta, the frozen-path and instrument constraints, and every gate number — is recorded with its commands in `2026-09-15-m1-phase-b-handoff.md` §2 and in this session's ledger.
- Everything in §5 is a **snapshot**: the M62 row was true at `3e0e2536`, the tip row at `a5e4bb0e`. Re-run before relying on either.
