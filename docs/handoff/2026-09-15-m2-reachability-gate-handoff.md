# M2 — the reachability gate — milestone record

**Written:** 2026-09-16, by the session that implemented it. **Branch:** `m64`. **Base of the milestone:**
`85d234b3`; **record measured at** `a686d9e1`.

**Audience:** whoever picks this up next. This is the tracked, clone-visible record of M2. The SDD ledger,
task briefs, per-task reports and every review file also exist, but under `.superpowers/` — **gitignored**,
so a clone cannot see them. §3 below is the distilled version of what they contain, which is why it exists
at all: the 2026-09-15 review cycle's history once lived only in a gitignored ledger, and that is recorded
in `HANDOFF.md` §4 as a mistake. This document is the repair, applied to M2.

**Everything here is measured.** Where a claim is weaker than it sounds, it says so.

---

## 1. What shipped

M1 found the "declared but unreachable" orphans **once**. M2 makes them stay found: the instrument gained a
**baseline + ratchet** that fails **only on rows new relative to a committed baseline**, never on a low count
— "a gate that reddens when work is done gets switched off".

| Path | What it now is |
|---|---|
| `scripts/audit/check-reachability.mjs` | gained `--digest`, `--seed-baseline`, `--gate`; `--self-test` grew **18 → 36** cases and now drives the CLI itself, not only helper functions |
| `scripts/audit/reachability-baseline.json` | the seed — `seededAt`, **`reason`**, `digest`, `count: 523`, `rows`. **Written only by `--seed-baseline`**, never by hand |
| `scripts/audit/reachability-allowlist.json` | **24 `entries`** (keys are `kind<TAB>subject`) **+ 13 `noRow`** dispositions, each with a date and a reason |
| root `package.json` | `verify:reachability` → `--gate` |
| `README.md`, `README.en.md` | one row each in the development-command tables |
| `HANDOFF.md` §5, this milestone's docs | the gate list, the exit-code contract, and the two non-guarantees |

**Readings at `a686d9e1`, reproduced from a fresh `git archive HEAD`:** `--self-test` **36/36 ok** exit 0;
`--digest` `5acf81aaf9733c88fbcb7471fcef00247c8c24804276cdcdcbfae0ffeab97786`; `--gate` exit **0**
`PASS`; the table **`731 ts files, 523 finding(s)`** with the per-class tally `510 unused-export /
8 unconsulted-setting / 3 unpushed-capability / 1 producerless-event / 1 unread-flag`, each printed with an
epistemic status; `pnpm -r typecheck` exit 0; `check-thresholds.mjs` ALL THRESHOLDS PASS.

**Exit-code contract** (do not add a path that breaks it): `0` pass · `1` **new rows** · `2` usage or
configuration (missing baseline, a baseline whose own `count`/`digest` do not describe its own `rows`, a
malformed allowlist, an exemption lacking a date or a reason, `--seed-baseline --gate`). Every `return`
reaches the caller through `process.exitCode = main()`, not `process.exit`, so a piped stderr message cannot
be truncated.

The nine commits: `60cc9f47` (row identity + `--digest`) · `1c3e2501` (the plan) · `4c163ed3` (baseline +
ratchet) · `1b50bfc1` (plan corrections) · `c0616e7f` (fix wave 1) · `6717a97b` (the allowlist) ·
`ba656320` (the mutation proof, per-class status, wiring) · `08f30c59` (the closing wave) · `a686d9e1` (one
last citation). Counted: `git rev-list --count 85d234b3..a686d9e1` = **9**.

---

## 2. The completion definition, and the evidence for each clause

The roadmap (`docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md:125`) requires three
things. All three were measured on the frozen tree **and** on a fresh extraction:

1. **"腳本可重跑" — the script re-runs.** A `git archive HEAD` export reproduces the digest, the 523-row
   set, the tally, the gate verdict and the self-test total.
2. **"對故意新增的一個孤兒會失敗（變異證明）" — a deliberately added orphan fails it.** Performed on the real
   tree: adding `export const M2_GATE_PROOF = "delete me"` to `packages/guard-repeat-tool/src/index.ts` moved
   the digest to `be1178de220d3b8383a6734dfe0f73166a0248db67130abecbbc40ddb3ea09cf`, the count 523→524, and
   made `--gate` exit **1** naming exactly `new  unused-export  @i-harness/guard-repeat-tool#M2_GATE_PROOF
   packages/guard-repeat-tool/src/index.ts`. The revert is proved byte-exactly (worktree blob `b429e9df…` =
   HEAD, empty diff, digest and gate restored), and the procedure is re-runnable without a human edit as the
   `--self-test` case *"gate: a deliberately added orphan fails the gate (the milestone's completion
   proof)"*.
3. **"基線與 allowlist 都帶日期與理由" — both data files dated and reasoned.** The baseline carries
   `seededAt` and a tool-written `reason`; all 24 allowlist entries and all 13 `noRow` dispositions carry
   `dated` and `reason`; and the gate **refuses to run** (exit 2, before it exempts anything) on an entry
   missing either field.

---

## 3. The review cycle — verdicts, and the shape of what was found

Subagent-driven: one implementer per task, a **fresh independent reviewer** per task, scoped re-reviews
after each fix wave, then a final whole-plan review and a final re-verification.

| Task | Verdict |
|---|---|
| 1 — row identity + `--digest` | **Approved** (3 deferred minors) |
| 2 — baseline + ratchet | **Needs-fixes** (2 Important) → fix wave `c0616e7f` → re-review **Approved** |
| 3 — the allowlist | **Approved** (7 deferred minors) |
| 4 — mutation proof, per-class status, wiring | **Needs-fixes** (1 Important, 6 Minor) → closing wave `08f30c59` → re-review **Approved** |
| final whole-plan review | **Needs-fixes** (no Critical) — **milestone definition MET**; found 2 Importants the task reviews could not see |
| final re-verification of the closing wave | **Approved** — every ordered item closed, 18/18 mutants redden, invariants hold on the frozen tree and on a fresh extraction |

**What was wrong, because the shape repeats.** Almost nothing was wrong with the gate's *behaviour*: every
review independently re-derived the row set, the digest, the mutation proof and the exit-code contract and
found them sound. What was wrong was **the paperwork around it** — and, more often than not, **the
instructions that produced it**: a plan step whose test was a tautology (it called the function under test on
both sides of the assertion); a brief whose `gateDiff` body would have made the allowlist silently inert
while looking harmless; a brief step whose expectation was **inverted** (deleting a baseline row makes it
*new*, not `gone`); a brief that declared three blind spots "documented in the tool" when the tool contained
**no** such comment; a brief that used an internal label (`R1`) that exists nowhere in the repo; a brief
step whose stated fixture did not exist; stale self-test counts written ahead of execution; the controller's
own citation example being stale by the time the step that used it ran; and the controller's line-ending
claim being true of blobs and false of the working tree. The artifact defects were fewer and were mostly
**citations** — seven off-by-one allowlist sources, fifteen stale pointers into a tool that this milestone
had itself grown, and one takeover-document pointer at a record that was not there.

**The two defects that mattered most, and their provenance:**

- **The allowlist key was compared against the wrong shape.** `allowed.has(k)` compared a two-field
  `kind<TAB>subject` exemption against a three-field row key, so **no exemption could ever match**. The
  brief's own test caught it; the reviewer then proved it end-to-end (effective with the fix, inert without,
  and a three-field-keyed control also failing). A gate whose exemption list silently exempts nothing is
  worse than no list, because it looks like one.
- **`--seed-baseline` ignored `--root`.** Seeding from any other tree rewrote the repository's baseline and
  exited 0 — measured. The first fix then refused valid Windows spellings of this tree's own root
  (`d:\i-harness-main`, `\\?\…`, a junction), so the final version compares **canonical** paths and refuses
  a seed that would write the repository's baseline from a foreign root.

---

## 4. The deferred register — what the closing wave closed, and what it deliberately left

**Closed** (all verified by the final re-verification): the seven off-by-one allowlist `source` numbers and
the tool comment they matched; **14 + 1 stale `check-reachability.mjs:NNN` citations** invalidated by this
milestone's own growth of the tool (999 → 1389 lines) — they now name **symbols**, and no numeric citation
into the tool survives; a takeover-document pointer to a record that did not exist; the baseline's missing
`reason`; the plan's `24/24`; the document's false *"not the same 507"* and *"not the same 519"*
explanations; the superseded §6.3/§6.4 present-tense clauses; the Phase B inheritance block, which had
answered five of six bullets while claiming to answer them "item by item"; baseline `count`/`digest`
validation; wrong-shape baseline and allowlist → exit 2; the seed write path; the three allowlist clauses
and the CLI wiring pinned by `--self-test`; `noRow` dates enforced; an inert entry warning on stderr
(**never** an exit code — a legitimately fixed row must not redden the gate).

**Left unfixed, deliberately, with the reason:**

- The **self-test still cannot see a scanner loosening that no fixture element targets**. The baseline
  document's §7 remains the honest statement of that limit.
- **The Phase A row counts** in the baseline document (525 / 512 / 507) are history; only their **false
  explanations** were corrected. Their current analogues are 523 / 510 / 507-with-a-different-membership /
  490, with the arithmetic shown in the document.
- Four items the baseline document's §7 **asks M2 to follow through on**, which M2 did **not** take because
  each moves the row set, the digest or the precision sample and therefore needs its own milestone:
  the **from-less local re-export blind spot** (measured scope: 68 entries, 6 packages, 39 re-exportable
  names, **0** of them in the row set), the **entry-only blind spot** in both of its shapes, **argument
  routing**, which is invisible to all five classes by construction, and a **declarative flag table**. They
  are named here so that "M2 is done" is not read as "the reachability question is closed".
- `--gate` validates the baseline's shape, `count` and `digest`, but **not** the presence of `seededAt` /
  `reason`: the roadmap's date-and-reason clause on the baseline *file* is held by the writer, not enforced
  by the reader. A hand-stripped `reason` still gates exit 0 — measured. Disclosed rather than papered over.

---

## 5. What M2 does NOT establish

In the roadmap's own words (`:126`): ***"不保證可達的東西是對的 —— 它只證明「有人呼叫」。一個接了但接錯的
生產者會通過這道閘門。"*** The gate proves that something in the non-test tree **mentions a name**. It does
not prove the symbol is reachable, that a caller is right, or that a call is correct. It also inherits
`:102`: it does not prove that every unwired surface was found — only the sampled and the listed. Class 1
remains a **lower bound** for three measured reasons (the entry-only shapes and the 39 from-less
re-exportable names), and argument routing is invisible to every class.

Two further limits worth stating plainly:

- **A falling count proves nothing by itself.** Check the digest and run `--self-test`; a scan that quietly
  stopped reporting would otherwise look like progress.
- **The allowlist waives failure, never scanning.** Exempted rows are still printed and still counted by
  `--digest`. Seventeen of the 37 dispositions are one class rule over the whole `@i-harness/sdk` surface,
  accepted on the roadmap's own reasoning (`:120`) — a genuinely dead `sdk` export will not fail the gate.

---

## 6. Two traps a later edit will hit

1. **Line-number rot, and it already happened twice here.** The allowlist's `source` fields cite the
   baseline document by line; Task 4's own edits moved all 24, its repair introduced a +1 error in seven of
   them, and the closing wave's edits moved them again. The convention now is **label-primary with a dated
   line number** (`…baseline.md §6.1 — line 822 (as of the 2026-09-16 revision)`). **Any edit to
   `docs/audit/2026-09-15-reachability-baseline.md` above §6.1 rotates them again**, and any edit to the M1
   plan above its `--flag=value` bullet moves the one citation that sits in prose. After such an edit,
   re-print every `source` and match it to the row its entry names.
2. **`core.autocrlf=true` with no `.gitattributes`.** The **blobs** are LF; several **working-tree** files
   (the tool, four markdown files) are CRLF on disk — and `git archive` on this checkout CRLF-converts the
   export. So an archive-based proof compares **blobs**, and a worktree-vs-archive byte diff will show
   spurious differences. Verify what you are about to commit with `git cat-file blob` (or force
   `-c core.autocrlf=false` for the archive), not with a byte comparison of the two trees.

---

## 7. Reproduce it in five commands

```bash
node scripts/audit/check-reachability.mjs --self-test    # expect: 36/36 ok, exit 0
node scripts/audit/check-reachability.mjs --digest       # expect: 5acf81aa...786
node scripts/audit/check-reachability.mjs --gate         # expect: gate PASS -- no new rows, exit 0
node scripts/audit/check-reachability.mjs                # expect: 731 ts files, 523 finding(s) + the tally
pnpm verify:reachability                                 # the wired alias for --gate, exit 0
```

And to re-run the completion proof without touching the tree: copy the repository to `%TEMP%`, append
`export const M2_GATE_PROOF = "delete me"` to `packages/guard-repeat-tool/src/index.ts` in the copy, and run
`--gate --root <copy>` — the copy's digest is identical to this tree's, so the scan is equivalent. Expect
exit 1 naming exactly that one row.
