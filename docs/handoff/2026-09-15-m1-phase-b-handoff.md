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

**Branch:** `m64`. **Phase B base:** `fbfbfb5`. Work is committed in small per-task commits; nothing
outside `packages/*` and `apps/cli` was touched, and no frozen frontend file was modified.

---

## 2. Status

| Task | What it did | Commits | Review |
|---|---|---|---|
| 1 | Gave `sandbox/mode` its first production producer, **plus** the `session-persistence` registration that forced | `fbfbfb5`..`1ca5fd8` | clean (1 fix round + scoped re-review) |
| 2 | Made the event reader validate against its own vocabulary | `1ca5fd8`..`f4de68b` | clean (1 fix round + scoped re-review) |
| 3 | `i-harness run` rejects unknown flags instead of turning them into the prompt | `f4de68b`..`b96d162` | clean (1 fix round + scoped re-review) |
| 4 | Deleted two dead declarations (`buildWireClient`, `withdrawPlanModeTool`) | `b96d162`..`cd9579e` | clean (1 fix round + scoped re-review) |
| 5 | Un-export three names in `session-executor` and reroute their tests | `cd9579e`..`06d684c` | **NOT REVIEWED** |
| 6 | Reconciled the baseline's verdicts, allowlist and row tally | `637cdd7` | **NOT REVIEWED** |
| 7 | Baseline errata, post-Phase-B digest, M2 blind-spot requirements | `06d684c`..`17cdb25` | **NOT REVIEWED** |

**Instrument state:** `reachability: 731 ts files, 523 finding(s)`; digest
`5acf81aaf9733c88fbcb7471fcef00247c8c24804276cdcdcbfae0ffeab97786`, computed as sha256 over the
findings rendered as sorted `kind<TAB>subject<TAB>evidence` lines, LF-joined, **each
newline-terminated — the trailing newline matters**. Phase A's digest was `da57ae75…` at 525 rows;
**two rows left the set** (Task 4's two deletions) and **zero were added** across all of Phase B.

**Row tally after Phase B (§4 of the baseline): `already-fixed` 6 · `still-holds` 2 · `by-design` 14
= 22 rows.** Phase A was 3/10/9. Note that **14 `by-design` rows are not 19 allowlist *entries*** —
the baseline states that distinction explicitly, and `§4.1 item 8` is the one `by-design` row with no
allowlist entry. That is recorded deliberately rather than resolved by inventing an entry.

### Four corrections Task 7 made to the controller's numbers, each by re-measurement

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
- **`closeFileBackedConnections` is declared at `file-backed.ts:89`**, not the `:91` the brief said.

**And one correction to the controller's *mechanism*, not just a number:** the re-export hazard is
**not** the `originOf` self-origin path. When the re-export carries a `from` specifier it resolves,
the declaring module **is** added to `origins`, and excluding it at `:364` **manufactures** the row —
measured: re-exporting `classifyDenial` through `sandbox-local`'s entry moves the count `523 → 524`
(experiment run and reverted). Two different mechanisms, both real, in the same area.

---

## 3. Deferred — do these first

The working day ended mid-flight. **Three task reviews and the final whole-branch review were not
run.** That was a deliberate choice with a stated cost: a rushed review would have produced false
confidence, which is worse than a recorded gap. Nothing is *known* broken — Tasks 1–4 passed their
gates and the instrument read `523` unchanged throughout — but "not known broken" is exactly what
those gates exist to replace.

In order:

1. **Review Task 5** — `scripts/review-package <plan> <task-5-base> HEAD`.
2. **Review Task 7**, then **Task 6** (Task 6's tally depends on whether Task 5 landed; see §6).
3. **Final whole-branch review, scoped to `fbfbfb5..HEAD`** — *not* all of `m64`. Phase A
   (`m62..5b01bc3` plus its fix waves) already had its own final review and a scoped re-review;
   re-reviewing it would spend the pass on code a previous review already cleared. The two phases
   share no file except `scripts/audit/check-reachability.mjs`, which Phase B never modified.
   *Cost of this scoping, stated:* a defect spanning the Phase A/Phase B boundary would be seen by
   neither review.

Each task also parked Minors. They were deliberately kept out of the fix loops and are listed in §7;
hand them to the final reviewer so it can triage which must be fixed.

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

**The pattern is identical every time: a plausible claim accepted before the mechanism that decides
it was checked.** The counter-check is cheap in every instance and was skipped in every instance.

---

## 6. Open items and follow-ups

**Blocking/completion:**
- The three deferred task reviews and the final whole-branch review (§3).
- **§4.1 item 8 of the baseline** — Task 5 landed as `06d684c`, so those names are no longer
  exported and the row should be `by-design`, making the tally **`6 / 2 / 14 = 22`**. Task 6 committed
  before Task 5 landed and therefore left it `still-holds`; **verify against the code, not the
  document.** The controller confirmed by `git grep` that all three names are un-exported and absent
  from the package entry, and that the instrument still reads `523`.

**M-shaped follow-ups, each needing its own spec (roadmap §3.M1):**
- A real **mid-session sandbox-tightening surface**. *Blocker to report:* the only shipped one is
  `/sandbox` in the **frozen** `apps/cli/src/web.ts`.
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
- **The local re-export blind spot** (R-L) — 38 unreportable names; the ask is to follow a local
  re-export through the entry's own imports, or at minimum to refuse to credit the entry as its own
  origin.
- **The entry-only blind spot** — class 1 walks only `packages/*/src/index.ts`, so any file its entry
  does not mention, and every name it declares, is invisible to all five classes. Three known
  instances: `packages/guard-approval/src/remember.ts`,
  `packages/sandbox-local/src/runner-failures.ts`, `closeFileBackedConnections`. **Re-exporting is not
  a remedy** — a probe gives 1 finding without the re-export and 2 with it.
- **Argument routing is invisible to every scanner class** — Task 3's defect class can never be
  caught by the gate; only tests will.
- **A worked demonstration of the cross-package collision false negative:** during Task 4, a
  **comment** naming `CreateProviderRuntimeOptions` suppressed that package's own row (523 → 522).
- Print each class's epistemic status where its count is printed: class 1 is an *unconsumed export
  edge, not dead code*; classes 3 and 4 are lower bounds; class 5 is reader-dependent.

**Parked Minors** (kept out of the fix loops by design; the final reviewer should triage them) include:
the `sandbox-policy-per-call.test.ts` disclosure comment's self-falsifying grep sentence and its
unreachable "load-bearing again" example; `assembly.ts`'s `policySession` comment; the
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
3. Run the deferred reviews (§3) with `scripts/review-package <plan> <base> <head>` from
   `subagent-driven-development`.
4. Then decide with the human: **M1 is not complete until the reviews are clean and the verdicts
   reconcile.** Nothing has been merged or pushed beyond `m64`.
