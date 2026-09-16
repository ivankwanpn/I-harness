# M1 Phase B — handoff (2026-09-15)

**Read this before touching anything.** It exists because the SDD ledger that recorded this
milestone's work lives in `.superpowers/sdd/`, which is **gitignored** — so none of it reached this
repository. This file is the durable record: the rulings, the deferred work, and the measurements
that would otherwise have to be re-derived.

---

## 1. What Phase B is

M1 is the first milestone of the backend-polish roadmap
(`docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md`). Phase A built a reachability
instrument and a measured baseline; **Phase B acts on that baseline's verdicts** — every
`still-holds` row must either be wired to a production path or declared deliberate with a reason.

- Plan: `docs/superpowers/plans/2026-09-15-m1-phase-b-wire-the-unwired.md` (7 tasks)
- Baseline: `docs/audit/2026-09-15-reachability-baseline.md`
- Instrument: `scripts/audit/check-reachability.mjs`

**Branch:** `m64`. **Phase B base:** `fbfbfb5`. Work is committed in small per-task commits, and no
frozen frontend file was modified. **Corrected 2026-09-15 by re-measurement:** this line also said
"nothing outside `packages/*` and `apps/cli` was touched", and that is false for the range as a whole
— measured `git diff --name-only fbfbfb5..HEAD`, the range touches **12 `docs/` files**, including
three audit-corpus JSONs under `docs/audit/data/`. It was already false at this handoff's own
revision `d682a50b`, where the range had touched two of them
(`docs/audit/2026-09-15-reachability-baseline.md` and this file); the later fix waves added the rest.
The frontend half of the sentence holds: no frozen path was modified anywhere in the range.

---

## 2. Status

| Task | What it did | Commits | Review |
|---|---|---|---|
| 1 | Gave `sandbox/mode` its first production producer, **plus** the `session-persistence` registration that forced | `fbfbfb5`..`1ca5fd8` | clean (1 fix round + scoped re-review) |
| 2 | Made the event reader validate against its own vocabulary | `1ca5fd8`..`f4de68b` | clean (1 fix round + scoped re-review) |
| 3 | `i-harness run` rejects unknown flags instead of turning them into the prompt | `f4de68b`..`b96d162` | clean (1 fix round + scoped re-review) |
| 4 | Deleted two dead declarations (`buildWireClient`, `withdrawPlanModeTool`) | `b96d162`..`cd9579e` | clean (1 fix round + scoped re-review) |
| 5 | Un-export three names in `session-executor` and reroute their tests | `637cdd7`..`06d684c` | **APPROVED** — reviewer session `945e22d3` (spec ✅; one plan-mandated Important parked by ruling; 4 minors) |
| 6 | Reconciled the baseline's verdicts, allowlist and row tally | `cd9579e`..`637cdd7` | **NEEDS FIXES → ADDRESSED** — reviewer `bbf1d419`; fixed in `5b301609`; re-review `c4dc27a9`: all findings addressed |
| 7 | Baseline errata, post-Phase-B digest, M2 blind-spot requirements | `06d684c`..`17cdb25` | **NEEDS FIXES → ADDRESSED** — reviewer `3cd389db`; same fix wave `5b301609`; re-review `c4dc27a9`: all findings addressed |

**Corrected 2026-09-15 by re-measurement — those three `NOT REVIEWED` flags were stale and false,
and Task 5's range swallowed Task 6's whole commit.** All four reviews had run; their verdicts, the
reviewer sessions that produced them and the ruling one of them parked are copied into **the review
ledger below**, because the ledger that holds them is gitignored like the implementer's. Left as
written, the flags would have made the next session re-dispatch three completed reviews. Two range
corrections come with them: Task 5 is `637cdd7`..`06d684c` — the old cell said `cd9579e`..`06d684c`,
which is **two** commits, because Task 6 (`637cdd7`) landed *before* Task 5 (`06d684c`) — and Task 6
is `cd9579e`..`637cdd7`. Measured: `git log --oneline cd9579e9..06d684c6` lists both `06d684c6` and
`637cdd70`, while `git log --oneline 637cdd70..06d684c6` lists only `06d684c6` and
`git log --oneline cd9579e9..637cdd70` only `637cdd70`.

**Instrument state:** `reachability: 731 ts files, 523 finding(s)`; digest
`5acf81aaf9733c88fbcb7471fcef00247c8c24804276cdcdcbfae0ffeab97786`, computed as sha256 over the
findings rendered as sorted `kind<TAB>subject<TAB>evidence` lines, LF-joined, **each
newline-terminated — the trailing newline matters**, and **sorted byte-wise** (`Array#sort()` /
`LC_ALL=C`, not a locale-aware collation: a `localeCompare` sort moves `@i-harness/tui#…` after
`@i-harness/tui-core#…` and does not reproduce this digest — measured, baseline §2.1). Phase A's
digest was `da57ae75…` at 525 rows;
**two rows left the set** (Task 4's two deletions) and **zero were added** across all of Phase B.

**Row tally after Phase B (§4 of the baseline): `already-fixed` 5 · `still-holds` 2 · `by-design` 15
= 22 rows.** Phase A was 2/10/10. **Corrected 2026-09-15 by re-measurement:** this paragraph first
published `6 / 2 / 14` and `Phase A was 3/10/9`, both taken from the baseline's §4 tally paragraph,
which was wrong in two columns — Task 7 moved `§4.1 item 8` out of `still-holds` into **`by-design`**
and the baseline's paragraph counted it into `already-fixed` instead. The baseline now states the
derivation and the extraction it was checked with; this handoff carries the corrected figures and does
not re-derive them. Note that **15 `by-design` rows are not 19 allowlist *entries*** —
the baseline states that distinction explicitly, and `§4.1 item 8` is the one `by-design` row with no
allowlist entry. That is recorded deliberately rather than resolved by inventing an entry.

### Three corrections Task 7 made to the controller's numbers — and one it got backwards

Recorded because they are wrong in the briefs and would otherwise be re-derived:

- **§4.1 item 6:** the bare-pattern count of production comment lines is **18**, not the 17 the
  controller stated. The likely reconciliation is the self-describing meta-comment at
  `assembly.ts:339`, which a pre-Task-1 scan would not have seen. The document records the
  reproducible measured number and states its counting rule.
- **§4.4 item 3:** `apps/cli/src/sessions.ts:62` is **not** the only `startsWith("-")` in `apps/` —
  Task 3's own guard at `apps/cli/src/index.ts:191` is another. The cell names both.
- **The local-re-export blind spot is 39 names, not 38**, and **all 39** are declared elsewhere:
  68 entries / 6 with a local export list / `tui-core` 31, `fs-lock` 2, `sandbox-policy` 2,
  `session-persistence` 2, `attachment` 1, `core-agent` 1. (The controller's 38 treated
  `session-persistence` as 1.)
- **RETRACTED — `closeFileBackedConnections` is declared at `file-backed.ts:91`, which is what the
  brief said.** This item first read "…is declared at `file-backed.ts:89`, not the `:91` the brief
  said"; that correction was **false**. Re-measured: `:89` is the last line of the comment block that
  introduces `openConnections`, `:91` is `export function closeFileBackedConnections(): void {`, and
  `openConnections.clear()` is at `:93`. The false correction is recorded rather than deleted — it
  reached the baseline's §4.5 row 2 and §7 item 13, both now corrected — and it is the same failure
  mode §5 lists: the claim was published without the measurement that decides it (reading the three
  lines) being run.

**And one correction to the controller's *mechanism*, not just a number:** the re-export hazard is
**not** the `originOf` self-origin path. When the re-export carries a `from` specifier it resolves,
the declaring module **is** added to `origins`, and excluding it at `:364` **manufactures** the row —
measured: re-exporting `classifyDenial` through `sandbox-local`'s entry moves the count `523 → 524`
(experiment run and reverted). Two different mechanisms, both real, in the same area.

### The review ledger — verdicts, rulings and residuals (2026-09-15)

**Why this section exists:** the review verdicts were produced by a second session whose ledger is
`.superpowers/sdd/2026-09-15-m1-phase-b-wire-the-unwired/progress.md` — **gitignored, like the
implementing session's** — so without this section the milestone's review history dies with that
workspace. **The ids below are that ledger's review-session ids, not git revisions:**
`git log 945e22d3` fails with "unknown revision" (verified), and the commits the reviews name are the
branch's own, listed in the table above.

| Reviewed | Reviewer session | Verdict |
|---|---|---|
| Task 5 | `945e22d3` | **Approved** — spec ✅; independently re-ran package `tsc --noEmit` (exit 0), `assembly.test.ts` (22/22) and the instrument (731/523, unchanged) |
| Task 6 | `bbf1d419` | **Needs fixes** — spec ❌, no Critical, 4 Important, 5 Minor |
| Task 7 | `3cd389db` | **Needs fixes** — spec ❌, no Critical, 4 Important, 6 Minor |
| Tasks 6 + 7 fix wave | `5b301609`, re-reviewed by `c4dc27a9` | **All findings addressed** (F1–F6, all nine F5 bullets, plus a 38→39 figure neither review had flagged) |
| this session's own `a7f6775d` | `37a9eaa1` | **Needs fixes** — 1 Critical (a **false reachability claim**, withdrawn in `1cef0d59`), 1 Important, 5 Minor |
| wave 2 (`1cef0d59`) | `43e16ae3` | **All findings addressed** |
| final whole-branch review | `b7a33044` (Tasks 1–4 semantics) · `d9dd5dab` (the branch's own record) | code **merge-sound**, nothing to block on; the **record not ready** until this fix wave — its findings are the dated corrections in §2, the §6 entries, and the plan's mid-session bullet re-worded from "blocked by the freeze" to "must be built" |

**Task 5's parked Important, and its ruling (the remedy was documentation, not a fix).** The deleted
case was "degrades to ready when `currentState` itself throws", and the brief forced the deletion
because through the assembly `currentState` is `() => mcpStates.get(cfg.serverName)`
(`assembly.ts:643`) — a `Map.get` over `const mcpStates = new Map<…>()` (`:623`) that cannot throw.
So the defensive `catch` at `assembly.ts:263` is not merely untested, it is **unfalsifiable by
construction**: no mutation can redden a test for a branch that cannot be reached. **Ruling: park it;
remedy in the documentation, not a test-only seam** — this repo ruled against test-only production
surface in M62, and the file's own header plus the test's disclosure say the same. The ruling's
ordered remedy ("a handoff §6 follow-up entry, **or** an inline comment marking the catch
defensive-only") had landed **neither** half; both are now in place (§6's "Parked by ruling" entry
and the comment at `assembly.ts:261-263`).

**Task 5's four deferred minors** (kept out of the fix loop by design; none blocks merge):
1. `test/assembly.test.ts:598-643` sniffs `console.warn` **text** instead of asserting the exact error
   object on an injected `onHostError` — couples the test to the log string at `assembly.ts:646-648`.
2. `test/assembly.test.ts:44-61` — the `@i-harness/mcp-client` mock is file-global and
   non-delegating, so no case exercises the real mount plumbing (disclosed in-source; no other case
   in that file mounts MCP, so nothing else is weakened).
3. `assembly.ts:164-165` — the doc comment still says "the host (run.ts / the web service) builds a
   RewindService over these", but the host can no longer name the type. One-line fix.
4. `test/assembly.test.ts:530` uses `mcpMounts.calls.at(-1)` after clearing the array; `calls[0]` plus
   a length check would state the single-mount assumption and fail faster.
   Recorded with them: the plan's Step 5 call-site coordinates (`:762`/`:618`) had rotted to
   `:786`/`:642` — the same rot Task 7's reviewer found independently — and the red-first evidence is
   unverifiable for a structural reason worth keeping: `RewindAssemblyHandle`'s un-export is
   **type-only with no in-repo consumer**, so for that one of the three names red-first is *vacuous*,
   not merely unmeasured.

**Wave 2's two residuals, and where they stand:**
- `d3-ih`'s `context-window-resolution-chain` claim said the compact pass-through "stays exactly as
  the caller wrote it" — superseded by `73c9b725`, and **no citation can repair false prose**, so it
  was reported rather than papered over. **Fixed in this wave:** the corpus claim now states what the
  code does (the config is dropped with a warning when no window resolves, `assembly.ts:810-817`),
  and `docs/handoff/HANDOFF.md`'s repair bullet discloses that re-anchoring could not have caught it.
- **This document's own §6 `/sandbox` bullet** (the ledger that recorded the residual numbered it
  `:274-275`; the line numbers moved with this fix, so the section is the durable pointer) still
  repeated the withdrawn `/sandbox` claim; wave 1 owned this file, so it was left to the micro-fixer.
  **Fixed in `6f2c2cea`.**

**And the limit this milestone cannot repair: three of its four task reviews ran without an
implementer report.** The implementing session's ledger and per-task reports were gitignored and
never published, so spec compliance (plan text vs diff) and code quality (reading the code) were
reviewable, while *"did the implementer do what it said it did"* is **permanently unverifiable** here.
Assume the same base rate for the parts nobody could check: the one time a claim-level audit was
possible (this session's own `a7f6775d`) it found a Critical falsehood and an over-stated repair.

---

## 3. Deferred — what was deferred, and its state

**Corrected 2026-09-15 by re-measurement: nothing here is deferred any more, and this section said
the opposite.** It opened with "Three task reviews and the final whole-branch review were not run"
and then ordered the next session to dispatch them; all four have since run, and the verdicts are in
§2's review ledger. Left as written, the list would have re-run three completed reviews at whole-branch
cost. The *reason* the reviews were deferred rather than rushed still stands and is why they were
worth waiting for: a rushed review would have produced false confidence, which is worse than a
recorded gap. Nothing was *known* broken — Tasks 1–4 passed their gates and the instrument read `523`
unchanged throughout — but "not known broken" is exactly what those gates existed to replace.

What was deferred, and its state:

1. ~~**Review Task 5** — `scripts/review-package <plan> <task-5-base> HEAD`.~~ **Done** — reviewer
   session `945e22d3`, **Approved** (the parked Important and its ruling are in §2's review ledger).
2. ~~**Review Task 7, then Task 6**~~ **Done** — `3cd389db` (Task 7) and `bbf1d419` (Task 6), both
   **Needs fixes**; one fix wave (`5b301609`) carried both finding lists, and re-review `c4dc27a9`
   recorded **all findings addressed**.
3. **Final whole-branch review, scoped to `fbfbfb5..HEAD`** — *not* all of `m64` — **done**, in two
   scopes (`b7a33044`, `d9dd5dab`; §2's review ledger). Phase A (`m62..5b01bc3` plus its fix waves)
   already had its own final review and a scoped re-review; re-reviewing it would spend the pass on
   code a previous review already cleared. **The scoping sentence that used to sit here was false,
   and the correction is dated:** it read *"The two phases share no file except
   `scripts/audit/check-reachability.mjs`, which Phase B never modified."* Measured with
   `git diff --name-only` over both footprints (`m62..fbfbfb5` = Phase A, `fbfbfb5..HEAD` = Phase B),
   the second clause holds and **the first is the opposite of the truth**: the phases share **four
   documents** — `docs/audit/2026-09-15-reachability-baseline.md`, `docs/handoff/HANDOFF.md`, this
   Phase B plan and `docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md` — while
   `scripts/audit/check-reachability.mjs` is in **Phase A's footprint only**. Their Phase B churn,
   measured at `6f2c2cea` (the revision this correction was written against; the figures move with
   every later commit to those files, this fix wave's included), was `+379/−42`, `+23/−6`, `+10/−8`
   and `+3/−3` respectively. So the sentence named
   the one file the phases do *not* share and omitted the document Phase B rewrote most heavily (the
   baseline). The scoping *decision* survives the correction, and saying why is the point: the
   baseline's Phase B rewrites are inside `fbfbfb5..HEAD`, so the in-range review did see them, and
   Phase A's edition of that file was covered by Phase A's own final review.
   *Cost of this scoping, stated:* a defect spanning the Phase A/Phase B boundary would be seen by
   neither review.

Each task also parked Minors. They were deliberately kept out of the fix loops and are listed in
**§6** (**corrected 2026-09-15**: this line said §7, which is "Resuming"); hand them to the final
reviewer so it can triage which must be fixed.

**One pointer to repair while reading this:** the command the deferred list named,
`scripts/review-package <plan> <base> <head>`, is **not a path in this repository** — `Test-Path
scripts/review-package` is false (measured 2026-09-15), and `git grep` finds the string only in this
handoff and in the M49 plan. It is a script **of the `subagent-driven-development` skill**, resolved
from the installed plugin cache (this machine:
`C:\Users\inkik\.claude\plugins\cache\claude-plugins-official\superpowers\6.3.0\skills\subagent-driven-development\scripts\review-package`;
the codex-cache equivalent is recorded at
`docs/superpowers/plans/2026-09-06-m49-remaining-tasks-execution.md:186`). Same species as the
dangling `task-7-report.md` pointer the baseline's §7 item 3 fixed: a repository-relative path that
does not resolve.

---

## 4. Rulings made on the human's behalf

**Nine of these are corrections to the controller's own claims, briefs or measurements.** They are
listed with what each costs if wrong, because that is the only way they can be reworked.

### Pre-flight (before Task 1)
- **R-A** — Task 1's test passes an empty mock script. *Ruling:* if it were not constructible, use a
  single no-op step. It was constructible. *Cost if wrong:* one extra mock step.
- **R-B** — `main()` on the `run` path reads real settings before reaching a mocked `runHeadless`.
  *Ruling:* the new test must pin `IH_CONFIG_DIR` to a fresh empty temp dir. Resolved as **per-call**
  reads by a two-direction probe, so a `beforeEach` pin suffices. *Cost if wrong:* a test reads real
  settings — a flake or a token spend.
- **R-C** — Task 1 and Task 5 share `assembly.ts`. *Ruling:* Task 5's `git grep` is the authority.
- **R-D** — three items are M-shaped and excluded from Phase B (a real mid-session sandbox-tightening
  surface, the `classifyDenial` wiring, the `exitCode` disambiguation), plus a per-instance
  `SessionQuery.close()`. *Cost if wrong:* an M-shaped change lands unreviewed as an S task.

### Task 1
- **R-E — a plan defect the implementer found before committing.** The brief said the producer
  "produces nothing new". It was wrong in a way nothing had analysed: `sandbox/mode` had **zero
  producers**, so it had never been written to a durable session — and `session-persistence`'s load
  gate (`guardIgnorable`) **refuses event types that were never registered**. Wiring the first
  producer made **every sandboxed session unloadable** (HTTP 500 on `GET /api/sessions/:id/events`;
  the same waiting on CLI `--resume`, TUI resume, `--attach` and fork). Causality proved by
  stash/restore. *Rulings:* (E1) the companion fix is in scope; (E2) **one commit**, because a split
  leaves a commit whose every written session is unloadable; (E3) register the type rather than mark
  it `ignorable` — `load()` **drops** ignorable events, which would erase the mode history the reader
  exists to read.
  **Measured after the fact:** `sandbox/mode` was the **only** session event type in that hole —
  37 declared in `core-session`, 35 accepted, and the two others (`text`, `image`) are message
  *parts*, not events.
- **R-E4** — the commit message carried a UTF-8 BOM (PowerShell `Out-File -Encoding utf8`). *Ruling:*
  amend authorised, because the SHA was unreviewed and unreported. **`git log --format=%s` is
  confidently wrong about a leading BOM** — PowerShell's output decoder strips it. Verify by a raw
  byte read of `git cat-file commit HEAD`.
- **R-F — the producer silently disarmed a mutation proof.** `sandbox-policy-per-call.test.ts`'s
  restored-history case passed pre-fix only because the retained window was empty; with the producer's
  event appended last, the backwards scan returns the same mode **with or without** the `policyFloor`
  slice, so the case can no longer detect its removal. *Rulings:* disclose it in the test's name and
  comment; **no seam** (the file's own header forbids test-only production surface); **do not remove
  `policyFloor`** — it is now redundant *given* the producer and becomes load-bearing again if the
  append ever turns conditional. *Cost if wrong:* a guard on a privilege-escalation path stays
  unpinned.
- **R-G — an unrecorded landmine in the frozen TUI.** `packages/tui/src/backend/embedded.ts:536`
  gates the initial kickoff on `s.events.length === 0`; a host passing `sandbox` now has one event at
  construction, so `i-harness tui --prompt …` would silently never fire. Latent and frozen, but "the
  TUI composes no sandbox" is a named reachability gap. *Fix when unfrozen:*
  `!s.events.some((e) => e.type === "turn/start")`.

### Task 2
- **R-H — my brief was wrong about its own red state** (caught before dispatch). It said the second
  new case passes already; both are in fact red before the fix. Corrected in the dispatch.
- **R-I — my brief's test snippet did not compile** (`SessionEvent` out of scope). The implementer
  added the import and **proved it load-bearing** (`TS2304` ×2 without it).
- **R-J — the comment claimed more than the change does.** It said an out-of-vocabulary value "must
  not reach `checkWrite`"; `assembly.ts` passes the same unvalidated `opts.sandbox` into
  `createSandboxPolicy({ mode })` → `defaultMode` → `checkWrite`, **never through the reader**.
  *Ruling:* claim only that the **replayed-event path** is closed, and record the config path as a
  second residual.
- **R-K — retracted; the implementer falsified it experimentally.** I claimed the reason for an
  unchanged count was a production import. Removing exactly that mention changed nothing; **three
  experiments** (each reverted) showed the real cause.
- **R-L — the local re-export blind spot, and its measured scope.** A name re-exported from a package
  entry through a **local** `export { … }` list is **unreportable** by `scanUnusedExports`: `originOf`
  (`check-reachability.mjs:296-297`) credits the entry as its own origin, so the declaring module is
  never excluded from the used-scan and self-satisfies. **Measured: 68 entries, 6 with a local export
  list, 39 names, 38 declared elsewhere and therefore unreportable** (`tui-core` 31, `fs-lock` 2,
  `sandbox-policy` 2, `attachment` 1, `core-agent` 1, `session-persistence` 1). **Class 1's 512 is
  therefore a lower bound for a second reason the baseline did not state.** *Ruling:* record it, do
  **not** fix the scanner mid-flight — that would change the finding set, the digest and the precision
  sample after Phase A was reviewed and its digest published.
  **Correction to this ruling's own figure (2026-09-15, fix round):** the breakdown above under-counts
  `session-persistence` by one — it is **2**, not 1, and the measurement under the rule stated here
  gives **39 of 39** declared elsewhere; see §2's correction and the baseline's §7 item 12. The page
  above is left as it was written, because the ruling is what was ruled; only the number is
  superseded.

### Task 3
- **R-M** — the fail-loud router kills **any** dash-leading task token (`run "-40 degrees"`,
  `run hi --`, `run hi --flag=value`), not just a prompt that is exactly a flag token, and there is no
  `--` escape hatch. *Ruling:* accept and declare it; a `--` separator is **new argv grammar** and
  therefore M with its own spec. *Cost if wrong:* a genuine usability narrowing ships declared but
  unsolved.
- **R-N** — the committed comment's three line references were pre-insertion coordinates, and **the
  text was mine**. Corrected in a new commit.
- **R-O — my suggested test fixture could not discriminate.** I specified `run hi --model -x`; that
  argv exits 1 in *both* states (at the `--model requires --api-key` gate with the clause, at the
  guard without it), so it was a test that would pass under the defect. The implementer substituted
  `run hello --api-key -x` and mutation-proved it.

### Task 4
- **R-P — the plan's remediation rule was carried across a bucket boundary it was never measured
  for.** "Drop the `export` keyword, do not delete the symbol" was measured on **bucket-B** rows
  (live inside their own module). Both of Task 4's rows are **bucket A** — genuinely dead — and
  `noUnusedLocals` (`tsconfig.base.json:9`) makes an un-exported, unread declaration `TS6133`. *Ruling:*
  **delete both**, and refuse the implementer's `void <name>` workaround, because it **manufactures a
  use** for a symbol that has none — in a milestone whose instrument *is* a used-ness test, that is
  the one edit that makes the tool lie to itself. *Cost if wrong:* ~20 lines and two test arms are
  re-derived when the M-shaped spec is written.
- **R-P1** — the implementer read "let their tests go with them" more precisely than I wrote it: it
  deleted only the symbol-bound case and **kept** the case asserting live behaviour (that
  `ensurePlanModeTool` is idempotent and that exiting plan mode does not withdraw `exit_plan_mode`).
  Ratified.
- **R-Q — the most consequential error of the milestone.** A **false defect claim** — that the deleted
  `buildWireClient` was the missing piece for a live `provider-runtime` bug — was proposed by a
  research agent, adopted by me as fact, recorded by the implementer as "verified, not inherited"
  (it verified the *citations*, not the *inference*), and written into lift-ready text for Tasks 6
  and 7 to copy verbatim. It is **not a defect**: `adapterProtocol` maps only `"openai-completions"`
  → `"openai-compatible"` and passes the other four through unchanged, so the map is **injective** and
  every input yields the client the deleted switch returned. **Only the name is discarded, not the
  information.** Corrected in the report and in the tracked comment.
  *The lesson worth keeping:* every gate verified the citations, and the citations were all correct —
  the conclusion did not follow from them. **Verify the inference, not only the evidence it cites.**

### Process
- **R-S** — the tail of Phase B was parallelised (Task 5 concurrent with Tasks 6–7) after checking
  that their file sets are disjoint and that Task 5 cannot move the finding count. The shared git
  index was managed explicitly (`git commit -o <own path>`, retry on `index.lock`).
- **R-R** — a re-reviewer reported it could not reproduce the digest. It **could**: the document
  states the rule at `baseline.md:85-86` ("each newline-terminated") and the value reproduces exactly.
  The caveat was the reviewer's own convention error — the mirror image of R27 below. It behaved well
  by labelling the digest *unverified* rather than *wrong*.

---

## 5. Corrections the controller made to its own earlier work

Recorded because this milestone's value is its honesty about what was measured, and because a
handover that lists only successes cannot be reworked.

- **R24** (Phase A) — a published sampling rule that was not the one used.
- **R27** — a figure published from a rule I never named (a stateful global-regex `.test()`).
- **R34** — a plausible hypothesis adopted as fact without measuring it ("`help` is copy residue" —
  it is test-pinned and load-bearing).
- **R-E contamination** — I reported a class measurement taken from a **dirty worktree** that already
  contained the fix, so my "pre-fix" number was post-fix. The implementer's correction (34, not 35)
  is what made the claim true.
- **R-H, R-I, R-O, R-P** — briefs and instructions of mine that were wrong.
- **R-Q** — the false claim above.
- **The `file-backed.ts:89` correction** (§2) — withdrawn: the brief's `:91` was right, and the
  "correction" replaced a correct citation with a wrong one. Recorded here as well as in §2 because it
  is the first entry in this list where the error ran the *other* way: not a brief of mine that was
  wrong, but a brief of mine that was right and was overruled without a measurement.

**The pattern is identical every time: a plausible claim accepted before the mechanism that decides
it was checked.** The counter-check is cheap in every instance and was skipped in every instance.

---

## 6. Open items and follow-ups

**Blocking/completion:**
- ~~The three deferred task reviews and the final whole-branch review (§3).~~ **Discharged
  2026-09-15 — corrected by re-measurement:** all four reviews ran, every finding is addressed or
  parked by an explicit ruling, and §2's review ledger carries the verdicts. This line was written
  while they were outstanding and was not updated when they landed.
- **M1's published completion definition, and the one carve-out it needs** (roadmap §3.M1: every
  `still-holds` row either wired to a production path, **or** declared deliberate with a reason **and
  recorded in a reasoned allowlist**). **Read that criterion over §4's four source lists — the 22 rows
  the baseline rules it covers (baseline §3.4, ruling R13: those items "are the **four source lists**
  of §4, which are 22 rows") — and at HEAD exactly two of those 22 rows are `still-holds`:** the
  **`sandbox/mode` pair**, baseline §4.1 item 6 and §4.3 item 4, which the tally's `still-holds 2`
  counts. They are deliberately **not** among the allowlist's §6.1/§6.2 entries. They *are* declared deliberate, with the reason and the
  follow-up, in the baseline's **§6.4** ("What is deliberately **not** on the allowlist", which names
  the pair and says it "carries both" the M follow-up and its out-of-scope blocker) and in the
  M-shaped bullet below. **So the roadmap's definition is met by that statement, not silently
  unmet:** the pair is deliberate because **no shipped surface can change a live session's mode** —
  the `sandbox/mode` event's sole production producer is the construction-time append at
  `assembly.ts:354`, and the only shipped mode-changing command (the frozen `/sandbox`) writes
  `settings.sandboxMode` for sessions created *later* (measured; see the corrected bullet below).
  Wiring it would need the M-shaped mid-session surface, which is out of this milestone's scope by
  ruling R-D. Recorded explicitly because a reader otherwise sees "2 `still-holds`, no allowlist
  entry" and cannot tell a decision from a gap — which is exactly the state §6.4 exists to prevent.
  *Corrected 2026-09-15 by re-measurement — the count above is scoped, and this bullet did not say so
  until now:* it read "At HEAD exactly two rows are `still-holds`" with **whole-document** scope,
  evidenced by ``git grep -n '\*\*`still-holds`\*\* |$'``. That pattern names the **bold** verdict form
  only, so it returned **2 of 11 by construction**, not by measurement — and run verbatim it returns
  **0** here: git grep reads it as a BRE, where the unescaped `|` is a literal pipe (as an ERE it
  would be alternation and the pattern would degenerate to `$`, matching every line), so it demands a
  literal `|` immediately before end-of-line, and this file is CRLF, so `\r` sits between the two.
  Measured cell by cell over every form of the verdict cell — bold, plain, with or without trailing
  text — the baseline carries **11** `still-holds` rows at HEAD, and
  ``git grep -n -e '\*\*`still-holds`\*\*' -e '| `still-holds` |' --
  docs/audit/2026-09-15-reachability-baseline.md`` returns exactly those 11 lines (no `still-holds`
  verdict cell in this revision carries trailing text): the `sandbox/mode` pair above, **§3.3's eight
  `unconsulted-setting` keys**, and **§4.5's `registerUpgrade`** — the same 8 + 2 + 1 the baseline's
  **§6.4** groups as "the rows still reported as `still-holds`". **The nine rows outside §4 are outside
  M1's list by R13, not hidden by it:** they are §3.3 rows and a §4.5 adjacent row rather than
  source-list rows, so they belong to M2's ratchet, and §6.4 itself names them as "**simply open**" —
  they have neither a task nor a reason sentence, which §6.4 records precisely so that their absence
  from the allowlist is not read as a decision about them.
- **§4.1 item 8 of the baseline** — Task 5 landed as `06d684c`, so those names are no longer
  exported and the row is `by-design`, making the tally **`5 / 2 / 15 = 22`** (this line read
  `6 / 2 / 14` until the fix round re-measured it; §2 carries the correction and the baseline's §4 the
  derivation). Task 6 committed
  before Task 5 landed and therefore left it `still-holds`; **verify against the code, not the
  document.** The controller confirmed by `git grep` that all three names are un-exported and absent
  from the package entry, and that the instrument still reads `523`.

**Parked by ruling, and the remedy is landed here (Task 5's one Important finding):**
- **The defensive `catch` at `assembly.ts:261-263` stays, documented as defensive-only and
  unfalsifiable by construction.** The deleted case was "degrades to ready when `currentState` itself
  throws"; through the assembly `currentState` is `() => mcpStates.get(cfg.serverName)`
  (`assembly.ts:643`, over `const mcpStates = new Map<…>()` at `:623`), a `Map.get` that cannot
  throw — so no mutation can redden a test for a branch that cannot be reached. **Ruling: park it;
  the remedy is documentation, not a code change and not a test-only seam** (M62 ruled against
  test-only production surface, the file's own header forbids it, and the test's disclosure says the
  same). The review's ordered remedy was "a §6 follow-up entry **or** an inline comment marking the
  catch defensive-only"; **both halves are now in place** — this entry, and the comment at the site.
  *Corrected 2026-09-15:* neither half existed before this wave, and the only comment at the site was
  written 2026-09-09 (`b844fcd9`), before Phase B. This is the deferred-minors triage's single
  must-fix-before-merge item.
- **Its cost, stated:** one defensive `catch` stays permanently unprovable, which is the honest state
  of a catch for an impossible error. The alternative — inventing a seam whose only purpose is to make
  an unreachable branch testable — is what the ruling refuses.

**M-shaped follow-ups, each needing its own spec (roadmap §3.M1):**
- A real **mid-session sandbox-tightening surface** — **nothing shipped does this**, so it has to be
  **built**, not unfrozen. *Corrected 2026-09-15:* this bullet read "the only shipped one is `/sandbox`
  in the **frozen** `apps/cli/src/web.ts`", which implies `/sandbox` tightens a live session. It does
  not: `web.ts:273-282` runs `settings.set({ sandboxMode: mode })` and answers that it takes effect for
  sessions created **later**, and `web.ts:470-475` reads that value **once** at service construction,
  so no shipped command changes the mode of a running session. The `sandbox/mode` event's sole
  production producer stays `assembly.ts:354`, at construction (`apps/` appends none). The frozen
  `/sandbox` is the user-facing precedent a real surface should carry into the replacement frontend.
- **`classifyDenial` wiring** — a real OS denial in a confined shell currently reaches the model as a
  bare non-zero exit. Widens `ExecResult` and the model-visible shell payload.
- **`exitCode: -1` disambiguation** — at least eight meanings, four of them indistinguishable.
- **A per-instance `SessionQuery.close()`** — would add a member to the published interface.
- **A wire-keyed public provider factory** — the real disposition of the deleted `buildWireClient`:
  a coupling/surface question, **not a bug** (see R-Q).
- **`provider-runtime`'s protocol resolution** — no defect exists on that path; do not send anyone
  looking for one.

**M2 (the reachability gate) must inherit:**
- Seed the ratchet with the **digest** and fail only on **new** rows — never on "zero rows".
- **The local re-export blind spot** (R-L) — **39** unreportable names (R-L's "38 declared elsewhere"
  is corrected in §2; re-measured in the fix round as 39 of 39 under R-L's own rule); the ask is to
  follow a local re-export through the entry's own imports, or at minimum to refuse to credit the
  entry as its own origin.
- **The entry-only blind spot has two shapes, and M2 needs both** — class 1 walks only
  `packages/*/src/index.ts` and tests **the names those entries export**, so **(a)** any **file** its
  entry does not mention, and every name it declares, and **(b)** any **name** declared in a file the
  entry does reach but not exported through it, are invisible to all five classes. Two known
  instances of (a) — `packages/guard-approval/src/remember.ts`,
  `packages/sandbox-local/src/runner-failures.ts` — and one of (b), `closeFileBackedConnections`
  (`packages/session-query/src/file-backed.ts:91`), whose file the entry *does* import and re-export
  from, so a file-level rule alone would not report it. The baseline's §7 item 13 states the same two
  parts as M2's ask. **Re-exporting is not a remedy** — a probe gives 1 finding without the re-export
  and 2 with it.
- **Argument routing is invisible to every scanner class** — Task 3's defect class can never be
  caught by the gate; only tests will.
- **A worked demonstration of the cross-package collision false negative:** during Task 4, a
  **comment** naming `CreateProviderRuntimeOptions` suppressed that package's own row (523 → 522).
- Print each class's epistemic status where its count is printed: class 1 is an *unconsumed export
  edge, not dead code*; classes 3 and 4 are lower bounds; class 5 is reader-dependent.

**What M2 did with this list — added 2026-09-16, M2 Task 4, the milestone's closing task.** Stated item by
item, including the one that is only partly done, because the point of this list is that a reader can
tell closure from silence.

- **Seeded the ratchet from the digest ✓.** `scripts/audit/reachability-baseline.json` is committed with
  `seededAt: 2026-09-16`, `count: 523` and digest
  `5acf81aaf9733c88fbcb7471fcef00247c8c24804276cdcdcbfae0ffeab97786`, and it reproduces the §2.1 row set.
  `--gate` fails on rows **new** relative to it and never on a low count: `gateDiff` computes `removed`
  separately and the gate prints it as progress. Exit codes are `0` pass, `1` new rows, `2`
  usage/missing-baseline/stale-allowlist, all four measured 2026-09-16.
- **The local re-export blind spot (R-L) — documented in the tool, not fixed ✓.** `scanUnusedExports`'s
  own doc comment (`scripts/audit/check-reachability.mjs`) now carries the mechanism — a from-less local
  `export { X }` list has no module to attribute the name to, so `originOf` credits the **entry**, which
  leaves the file that DECLARES `X` inside the used-scan where its own declaration satisfies the word
  test — and the measured scope: **68 entries, 6 with such a list, 39 names** (`tui-core` 31, `fs-lock` 2,
  `sandbox-policy` 2, `session-persistence` 2, `attachment` 1, `core-agent` 1), and **0 of the 39 appears
  in the row set**. Re-measured independently on 2026-09-16; it reproduces R-L's post-§2 figure, 39 of 39.
  **Not fixed**, as R-L ruled: a fix moves the row set, the digest and the published precision sample.
  (Task 4's first check found this was *not* documented in the tool despite this list saying it was; the
  comment was written rather than the claim softened.)
- **The entry-only blind spot (both shapes) — documented ✓, not fixed.** The same comment names a measured
  instance of each shape: (a) a file the entry never mentions, `packages/guard-approval/src/remember.ts`
  and `packages/sandbox-local/src/runner-failures.ts`; (b) a name the entry reaches but does not export
  through itself, `closeFileBackedConnections` (`packages/session-query/src/file-backed.ts:91`), which the
  entry imports at `:7` and calls at `:55` while re-exporting only its siblings at `:246` — measured
  2026-09-16: **no row**. Class 1's 510 rows remain a **lower bound** for this reason and for R-L's.
- **Argument routing is invisible to every scanner class — documented as a test-only guard ✓.** The tool's
  header now says it in those terms: every scanner is a name/string test, so a flag parsed and handed to
  the **wrong** consumer reads exactly like one that is wired, no class can see it, no fixture can make
  one see it, and it is guarded by tests rather than by the gate. (As with R-L, this sentence did not
  exist before Task 4; the general "cannot prove it is wired correctly" clause did.)
- **Per-class epistemic status where its count is printed — done ✓.** The human table now prints a
  per-class tally **between** the summary line and the flat list, each row carrying its status string,
  with an explicit `(no status recorded -- add one)` fallback so a kind the map lacks cannot print as a
  bare number. Measured 2026-09-16 over the 523 rows: `510` `unused-export` / `8` `unconsulted-setting` /
  `3` `unpushed-capability` / `1` `producerless-event` / `1` `unread-flag`.

**Nothing on the list above was *fixed* — every item was seeded, documented or printed.** That is the
honest reading of the five ticks: the two blind spots still under-report class 1, and the gate still
cannot see argument routing.

**What M2 does not establish, in the roadmap's own words** — recorded here because this milestone is built
on not over-claiming, and these are the source's words, read in the source:

- `docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md:126` — *"**不保證可達的東西是對的** —— 它只證明「有人呼叫」。一個接了但接錯的生產者會通過這道閘門。"* A wired-but-wrong producer passes: the gate proves a caller exists, never that the call is right.
- `:102` (M1's limit, which M2 does not remove) — *"**不保證所有未接線的表面都找到了** —— 只保證抽樣過的與清單上的。"*
- And the completion definition M2 satisfies, `:125` — *"腳本可重跑；對**故意新增**的一個孤兒會**失敗**（變異證明）；基線與 allowlist 都帶日期與理由。"*

**Parked Minors** (kept out of the fix loops by design; the final reviewer should triage them) include:
the `sandbox-policy-per-call.test.ts` disclosure comment's self-falsifying grep sentence (triaged
ship-as-is, still there; **its unreachable "load-bearing again" example was corrected in this fix
wave — `opts.sandbox === undefined` builds no policy service, so that example could not happen**);
`assembly.ts`'s `policySession` comment; the
`sandbox-mode-event.test.ts` name implying the assembly wrote a hand-built log; the three name lists
in the `run` router that can still drift; the non-token-aware readers at `:197`/`:209`/`:246-250`;
`WireClientConfig`'s doc saying "all three client factories" while five exist; and this plan's own
superseded Step 2/3, which must **not** be cited as the shipped method.

---

## 7. Resuming

1. `git log --oneline -12` and `git status --porcelain` — **trust git over any document, including
   this one.**
2. `node scripts/audit/check-reachability.mjs` — expect `731 ts files, 523 finding(s)`. If the count
   moved, something in flight changed the tree.
3. ~~Run the deferred reviews (§3) with `scripts/review-package <plan> <base> <head>` from
   `subagent-driven-development`.~~ **Nothing to dispatch — all four reviews have run** (§2's review
   ledger). If a later change needs a scoped review, note that `scripts/review-package` is **not a
   path in this repository** (`Test-Path` false, measured 2026-09-15): it is a script **of the
   `subagent-driven-development` skill**, resolved from the installed plugin cache (§3's closing note
   names it).
4. Then decide with the human: **M1's own gate is met as of 2026-09-15.** *Corrected 2026-09-15:*
   this item read "**M1 is not complete until the reviews are clean and the verdicts reconcile**",
   which is the gate as it stood *before* the reviews ran — it repeated the stale `NOT REVIEWED` flags
   §2 corrects. All four reviews have run, and every finding is addressed or parked by an explicit
   ruling (§2's review ledger, §6's parked entry); **the fix waves were then themselves re-reviewed,
   and the corrections that re-review asked for are in** — the ones its follow-up `4a47145f` had
   already repaired, and the rest in this commit: the `still-holds` count's scope (§6 above), the
   "verbatim" wording in the D3 context-window claim, and this item's own premature "clean" (it was
   written before that re-review ran). **No item from the re-review is left open by this commit.** The
   verdicts reconcile (the tally `5 / 2 / 15 = 22` counts the same under the baseline's own
   extraction, and the two `still-holds` rows **of §4's 22** are declared deliberate with their
   reason — §6's completion carve-out). What stays open is what §6 names as open: the M-shaped
   follow-ups, each needing its own spec, and the parked minors awaiting triage. What remains is the
   human's: nothing has been merged or pushed beyond `m64`.
