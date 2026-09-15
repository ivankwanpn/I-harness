# The reachability baseline — 2026-09-15

Milestone **M1 Phase A ("the reachability sweep")**, Task 5 of 5. Branch `m64`. Produced by
`scripts/audit/check-reachability.mjs` (Tasks 1–4). This task changed **no code**: the only file it
creates is this one. Phase A measures; Phase B fixes.

**Sources this document refers to.** The plan is
`docs/superpowers/plans/2026-09-15-m1-reachability-sweep.md` (its Task 5 is this task; Tasks 1–4 built
the tool). The four source lists are reconciled against the roadmap
`docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md` §3.M1, D1
`docs/audit/data/2026-09-11-d1-front.md`, and sandbox spec §7
`docs/superpowers/specs/2026-09-14-backend-permission-sandbox-design.md`. A few figures are carried
forward from the Tasks 1–4 working notes in the gitignored scratch tree
`.superpowers/sdd/2026-09-15-m1-reachability-sweep/` (chiefly `task-2-report.md` and `progress.md`):
each such citation is marked, and those paths are **not present in a fresh checkout**, which is why
every carried number is stated with its counting rule and never as the document's only evidence for a
claim.

---

## 1. What this is

This is a **measured baseline**, not a census of dead code and not an audit. It records what
`node scripts/audit/check-reachability.mjs` reported against `m64` at the SHA in §2, and it
adjudicates — item by item — the four source lists the milestone was defined against (§4). The tool
is a name-based scan, and for every class it proves exactly one thing: that **no production
(non-test) file mentions this name** (or constructs this event, reads this flag, pushes this
capability, consults this setting) — proven by text matching, not by parsing, and with no call graph
anywhere in it. It cannot prove that a declaration which *is* mentioned is wired correctly, and it
cannot prove that a reported symbol is dead rather than used inside its own module or intended as
public API. §5 measures how large that gap actually is in this tree, and §7 lists what this baseline
therefore does not establish. The 525 rows are recorded as the raw baseline for M2's ratchet (§3);
they are deliberately **not** adjudicated row by row (ruling R13, §3.4).

---

## 2. Machine fingerprint

**Two revisions appear in this document, and they are not the same one.** The table below is the
**Phase A measurement**: the state the 525 rows and the Phase A digest were measured at. §2.1 publishes
the **Phase B state** — the 523 rows and the digest M2 seeds from — measured at `637cdd7`, the revision
this document's predecessor published at. §2.1 also names the revision **this** edition is published at.
Read §2.1 for "what the tree says now"; read this table for "what Phase A measured".

| Item | Value |
|---|---|
| node | `v22.23.2` |
| pnpm | `11.7.0` |
| branch | `m64` |
| HEAD, the revision measured | `74f86d5a80528b61653a437658e4657e208fe59a` — **the Phase A measurement revision** |
| scanner, human mode | `reachability: 729 ts files, 525 finding(s)` |
| walked `.ts`/`.tsx` count (the scanner's) | **729** |
| `git ls-files "*.ts" "*.tsx"` | **729** |
| **assertion** | **PASS — walked == tracked == 729** |
| of which test files, by the walker's predicate | 369 |
| of which production files | 360 |
| self-test | `self-test: 18/18 ok` (exit 0) — the tool as it now stands; the SHA above carried 13 cases, and M1's fix wave added five without moving either the 525 rows or the digest |
| baseline digest | `sha256 = da57ae75d53e20c6e73e37da4d5cda68ed084c85fb046d5f877699a2d082e728` |

Commands, run from `D:\I-harness-main`:

```powershell
node scripts/audit/check-reachability.mjs
# reachability: 729 ts files, 525 finding(s)

node scripts/audit/check-reachability.mjs --self-test
# self-test: 18/18 ok          (exit 0; 13 cases at the HEAD above, 18 after M1's fix wave)

node --version                 # v22.23.2
pnpm --version                 # 11.7.0
git rev-parse HEAD             # 74f86d5a80528b61653a437658e4657e208fe59a
git ls-files "*.ts" "*.tsx"    # 729 lines
```

The `HEAD`, walked/tracked count, finding count and digest rows are the state the 525 rows were
measured at, and they are unchanged by M1's fix wave. The self-test row is the tool as it now stands,
and its count needs reading carefully: that wave added **five fixture elements**, which are what make
five pre-existing cases fail under the loosening each element exists to expose, plus **five named
cases** that record which hazard each element protects against and whose `run` and `expect` are
identical to the sibling case above them. The tool therefore has **18 cases, five of which share an
assertion with a sibling** — not 18 independent checks. Measured, with the five added cases deleted:
every loosening those fixture elements exist to catch is still caught, by the pre-existing cases
(class-4 `12/13`, `TYPE_DECL_LINE` `11/13`, class-5 quoted-key `12/13`, DEFAULTS anchor `12/13`,
class-3 dot rule `12/13`, all exit 1). None of them changes what the tool prints on this tree — so the
digest, not the case count, is what pins the row set. For the same reason, every line citation into
`check-reachability.mjs` in this document is to the tool **as it now stands** rather than to the SHA
above: that wave added lines to the fixture, the main block and the case list, so a citation such as
`withoutReExportStatements`'s `:340-347` no longer resolves at `74f86d5`. Nothing these citations point
at changed behaviourally — only its line number.

The digest is `sha256` over the 525 findings rendered as sorted `kind<TAB>subject<TAB>evidence`
lines, each newline-terminated. It pins the baseline so M2 can verify that a later run is
reproducing *this* set rather than a set that merely has the same size.

**The walked-vs-tracked equality is asserted here, not assumed.** Ruling R8: it is now a property of
the walker's skip list rather than of git, so it can drift. It holds today because the tracked set
contains nothing the skip list would drop — measured: of the 729 tracked files, **0** live under a
dot-directory at the root and **0** under `node_modules`/`dist`/`lib`, which are the walker's three
skip rules (`scripts/audit/check-reachability.mjs:924-937`, which also excludes `*.ts`/`*.tsx`
outside those rules only by extension). On the authoring machine recorded in
`docs/handoff/HANDOFF.md` the node version was `v24.15.0`; this run is on `v22.23.2`, which is why
all three fingerprint values and the file count are recorded rather than the SHA alone.

### 2.1 The post-Phase-B state — this is what M2 seeds from

Measured by `node scripts/audit/check-reachability.mjs`, re-run in this task. **The revision the
measurement was taken at is `637cdd7`** (`637cdd70a97aab8b9664842ce5e7bfba483ca25d`, the commit this
document's Phase A edition published at). **The revision this edition is published at is the last commit
of the `m64` branch that touches this file** — `git log -1 -- docs/audit/2026-09-15-reachability-baseline.md`
names it exactly, and no hash that would go stale on re-reading is embedded here. The task report that
produced this edition, `.superpowers/sdd/2026-09-15-m1-phase-b-wire-the-unwired/task-7-report.md`
— a **gitignored scratch artifact, absent from a fresh checkout**, the same label §7 item 3 and §7
item 6 put on their sources — records the SHA; **`git log` is the pointer that survives**, which is why
the rule above is stated in terms of the command and not of the report. Between the measurement revision and the publication
revision sit this edition's own commits — this file only — and exactly one code commit: `06d684c`,
Task 5's un-export of the three names §4.1 item 8 names. **The row set, the finding count and the digest
are identical at all of them.** That was checked, not assumed: the
scanner was re-run at the publication revision and returns the same `731 ts files, 523 finding(s)`, and
Task 5's change is deliberately **row-neutral** because class 1 walks only package entries and the
assembly's three names are not exported from one (§2.1's delta table, §7 item 13). **No Phase B code
change moves a single row after Task 4's two deletions.**

| Item | Phase A (§2 above) | **Phase B — current** |
|---|---|---|
| revision measured | `74f86d5a…` | **`637cdd7`** |
| revision published | `74f86d5a…` | **the last `m64` commit touching this file** (see above) |
| walked `.ts`/`.tsx` | 729 | **731** |
| `git ls-files "*.ts" "*.tsx"` | 729 | **731** |
| assertion | PASS — 729 == 729 | **PASS — 731 == 731** |
| finding count | 525 | **523** |
| `unused-export` | 512 | **510** |
| `unconsulted-setting` | 8 | **8** |
| `unpushed-capability` | 3 | **3** |
| `producerless-event` | 1 | **1** |
| `unread-flag` | 1 | **1** |
| digest | `da57ae75…` | **`5acf81aaf9733c88fbcb7471fcef00247c8c24804276cdcdcbfae0ffeab97786`** |
| self-test | `18/18 ok` | **`18/18 ok`** (exit 0) |

```powershell
node scripts/audit/check-reachability.mjs
# reachability: 731 ts files, 523 finding(s)

node scripts/audit/check-reachability.mjs --self-test
# self-test: 18/18 ok          (exit 0)
```

**The digest reproduction rule, restated because M2 must recompute it rather than trust it.**
`sha256` over the findings rendered as `kind<TAB>subject<TAB>evidence` lines, **sorted**, LF-joined,
**each line newline-terminated — the trailing newline after the last line matters.** **The sort is
byte-wise, and that is part of the rule rather than an implementation detail:** `Array#sort()` on the
rendered lines (equivalently `LC_ALL=C`, or any plain code-unit/byte comparison) — **not** a
locale-aware collation. A `localeCompare` sort orders `@i-harness/tui-core#…` **before**
`@i-harness/tui#…`, while byte order puts `@i-harness/tui#…` first (`#` is U+0023, `-` is U+002D), and
both kinds of row are in the 523. Measured here on this tree's 523 findings: byte-wise gives the
published `5acf81aa…`, while `localeCompare` gives `13e9469f662f5737c37532d1e71d6b06fc2f134bb86784a3c267878aeaa6a5b6`
under the default locale, `en-US` and `zh-TW` alike — so a locale-dependent sort would not reproduce
the published digest at all. Dropping that final
newline yields `d89827d07a4521b3dca6ebde0159d82eb284c0118511835cbc71f4b5cad7b779`, so the two are not
interchangeable: reproduce the digest with `--json`, take `findings`, render and sort each as
`kind ⇥ subject ⇥ evidence`, and join with `"\n"` **after every line, including the last**. (The rule
above at the Phase A digest is the same rule; this paragraph states only what that one left implicit.)
The digest is the artefact §6 prescribes as the ratchet's seed: **M2 must fail only on rows that are
*new* relative to this digest, never on the fact that rows exist.**

**Row delta from Phase A — exactly two rows left the set, and zero were added.** Both departures are
Task 4's deletions, and both were `unused-export` rows, which is why class 1 moved 512 → 510 while all
four other classes are unchanged:

| row (Phase A subject) | evidence | left the set because |
|---|---|---|
| `@i-harness/provider#buildWireClient` | `packages/provider/src/index.ts` | Task 4 removed the declaration (un-exported in `c5652c7`, deleted in `24e9395`) — §4.1 item 3 |
| `@i-harness/plan-mode#withdrawPlanModeTool` | `packages/plan-mode/src/index.ts` | Task 4 removed the declaration (un-exported in `c5652c7`, deleted in `24e9395`) — §4.1 item 5 |

**No Phase B task added a row.** The three names Task 5 un-exports (§4.1 item 8) were never in the
set to begin with, because class 1 walks only `packages/*/src/index.ts` entries and none of the three
is exported from one — that is the entry-only blind spot §7 item 13 records. Re-exporting them to
"make them reachable" would *add* three rows rather than remove any (measured, §7 item 13).

**The walked count moved 729 → 731 and that is not a row delta.** The two extra files are both **test**
files added by Phase B — `apps/cli/test/run-flag-routing.test.ts` (Task 3) and
`packages/session-persistence/test/sandbox-mode-event.test.ts` (Task 1) — so they change neither the
360-file non-test universe nor the row set. `731` is
the count the scanner's own walk and `git ls-files` agree on at `637cdd7` — the same asserted equality
§2 records for Phase A, now at a second revision.

---

## 3. The finding table

### 3.1 The Phase A 525 rows, grouped by class

**This section is the Phase A record and its numbers are the Phase A ones.** The current counts are in
§2.1; the two differ only by Task 4's two deletions, and §3.2–§3.4 below are Phase A records for the
same reason. §3.4's 512 rows are 510 at `637cdd7`.

**Class 1's 512 is a LOWER BOUND, for a reason this section does not otherwise state.** Separately from
class 4's floor below, class 1 cannot see a name that its entry re-exports through a local
`export { … }` list with no `from` clause — measured at `637cdd7` as 39 names across 6 entries, all of
them unreportable. See §7 item 13 for the mechanism, the measurement and M2's ask.

| Class | `kind` | Rows | Distinct `evidence` files | Note |
|---|---|---:|---:|---|
| 1 | `unused-export` | 512 | 64 | one per exported name of a `packages/*/src/index.ts` entry with no non-test mention outside its declaring module |
| 5 | `unconsulted-setting` | 8 | 1 | all from `packages/settings/src/index.ts` |
| 4 | `unpushed-capability` | 3 | 1 | all from `packages/tui/src/app/slash/types.ts` — **LOWER BOUND, see below** |
| 2 | `producerless-event` | 1 | 1 | `packages/telemetry/src/manifest.ts` |
| 3 | `unread-flag` | 1 | 1 | `apps/tui/src/index.ts` |
| | **TOTAL** | **525** | | |

**Class 4's count is a LOWER BOUND, and structurally so.** The scanner inspects only string-literal
union *types* whose name ends `Cap`/`Caps`/`Capability`/`Capabilities`
(`check-reachability.mjs:529-530`), and it **skips any such union where no member is ever pushed**
(`:573`) — because a union with no pushed member is not a push inventory at all (it is sniffed off
disk, as `plugin-registry`'s is) and reporting its members would invent findings. Measured: the
production tree contains exactly three such unions —

| union | file:line | members | scanned? |
|---|---|---:|---|
| `CapabilityStatus` | `packages/plugin-registry/src/evaluate.ts:49` | 5 | no — the name filter rejects it (a status union, not an inventory) |
| `Capability` | `packages/plugin-registry/src/capability.ts:16` | 3 (`skills`, `commands`, `mcp`) | no — **no member is ever pushed, so it contributes 0 rows** |
| `SlashCapability` | `packages/tui/src/app/slash/types.ts:21` | 11 | yes |

So an inventory that is never pushed at all is a **silent miss**. `SlashCapability` has 11 members and
`Loop.slashCapabilities()` (`packages/tui/src/app/loop.ts:2419-2431`) pushes exactly 8
(`session-list`, `session-create`, `dashboard`, `rewind`, `compact`, `fork`, `context`,
`provider-settings`), so the 3 reported rows are exactly its unpushed members. **3 is therefore a
floor on the number of unpushed capabilities in this tree, not the number.**

### 3.2 The tool independently reproduced three of D1's hand-recorded findings

This is the strongest evidence the tool works: three different scanner classes, three different
mechanisms, three rows a human had already written down by reading code.

1. **Class 4 returns exactly `["guardian", "plan-mode", "vim-mode"]`.** D1 `inventory:3277` records
   those three as never pushed by `Loop.slashCapabilities()`. Verified from the other side here: an
   exact `.push("guardian")` / `.push("plan-mode")` / `.push("vim-mode")` site occurs **0 times**
   across the 360 production files, while `.push(` call sites exist in 130 of them.
2. **Class 3 returns `--yes`, whose `flags.yes` occurs once in the whole tree**
   (`apps/tui/src/index.ts:445`) and is read nowhere. Measured: `--yes` occurs at
   `apps/tui/src/index.ts:9` (usage string), `:102` (the `TuiFlags` field), `:439` (initialiser),
   `:445` (the assignment) and `:461` (usage string); `flags.yes` is never read.
3. **Class 2 returns `retry/start`,** declared at `packages/telemetry/src/manifest.ts:30`, with its
   own source comment at `packages/core-agent/src/index.ts:234,238` saying it emits no such event.

### 3.3 The 13 non-`unused-export` rows, enumerated with verdicts

These are few enough to adjudicate in full. Verdict vocabulary is §4's.

| kind | subject | evidence | verdict | note |
|---|---|---|---|---|
| `producerless-event` | `retry/start` | `packages/telemetry/src/manifest.ts` | `by-design` | allowlist §6 |
| `unread-flag` | `--yes` | `apps/tui/src/index.ts` | `by-design` | allowlist §6.2 — deliberately out of scope: `apps/tui` is the TUI, frozen and slated for replacement (§4, scope decision). Source-list row; see §4.1 item 7 and §4.4 item 1 |
| `unpushed-capability` | `plan-mode` | `packages/tui/src/app/slash/types.ts` | `by-design` | allowlist §6 |
| `unpushed-capability` | `guardian` | `packages/tui/src/app/slash/types.ts` | `by-design` | allowlist §6 |
| `unpushed-capability` | `vim-mode` | `packages/tui/src/app/slash/types.ts` | `by-design` | allowlist §6 |
| `unconsulted-setting` | `language` | `packages/settings/src/index.ts` | `still-holds` | no production reader. The **6** production files **other than the one that declares the key** that contain the bare word `language` all declare unrelated locals (`packages/tui/src/render/highlight.ts:147` `const language = (lang ?? "")`, `packages/lsp/src/instance.ts:258` `languageId`); the 7th is the declaring file itself, so the count is 6 excluding it and 7 including it. None is a settings read |
| `unconsulted-setting` | `fontSize` | `packages/settings/src/index.ts` | `still-holds` | the name occurs in **no** production file other than the declaring one (schema `:272`, default `:315`, normaliser `:670`); no reader anywhere |
| `unconsulted-setting` | `searchBackend` | `packages/settings/src/index.ts` | `still-holds` | same shape (`:278`, `:318`, `:673`); declared, defaulted and validated, read nowhere |
| `unconsulted-setting` | `plugins.agentLoop` | `packages/settings/src/index.ts` | `still-holds` | declared at `:77`/`:319`/`:676`; no production file outside the declaring one mentions it |
| `unconsulted-setting` | `plugins.bash` | `packages/settings/src/index.ts` | `still-holds` | `bash` occurs in **22** production files **other than the one that declares the key** (23 including it), but always as the shell tool name or a plugin-tool list entry (`packages/preset/src/default.ts:59`, `packages/subagent/src/roles.ts:37`) — never as `plugins.bash`, so the toggle is unread |
| `unconsulted-setting` | `plugins.webSearch` | `packages/settings/src/index.ts` | `still-holds` | declared `:79`/`:319`/`:678`; no occurrence outside the declaring file |
| `unconsulted-setting` | `plugins.subagentModel` | `packages/settings/src/index.ts` | `still-holds` | declared `:80`/`:319`/`:679`; no occurrence outside the declaring file |
| `unconsulted-setting` | `onboarding.welcomeNoticeVersion` | `packages/settings/src/index.ts` | `still-holds` | the only other production occurrence is the mutation schema (`packages/settings/src/sections.ts:170`). The comment at `packages/settings/src/index.ts:329-331` says *"the frontend shows the notice while `welcomeNoticeVersion !== "2026-08-30.1"` (Task 9)"* — and **no frontend reads it**. The comment describes a behaviour that does not exist |

### 3.4 The Phase A 512 `unused-export` rows (510 at `637cdd7`) — recorded, not adjudicated (ruling R13)

The plan's Step 2 says "adjudicate **every** finding". **Ruling R13 overrides that**: the roadmap's
§3.M1 completion criterion never required it — it requires that each item which still holds be either
wired up or explicitly declared deliberate, and those items are the **four source lists** of §4,
which are 22 rows. At 525 rows a row-by-row adjudication is not a workflow anyone should perform and
would not be a measurement. So the 512 class-1 rows are recorded here as the raw baseline for M2's
ratchet, and §5 samples 39 rows to characterise them. **At the Phase B revision (§2.1) the same list is
510 rows** — Task 4 deleted the two rows §2.1's delta table names — and the per-package table below is
the Phase A grouping, unrevised: `@i-harness/provider` loses one row and `@i-harness/plan-mode` one, so
of the counts below only those two move (15 → 14 and 3 → 2 respectively at `637cdd7`).

Grouped by declaring package (`subject` prefix), descending:

| package | rows | package | rows | package | rows | package | rows |
|---|---:|---|---:|---|---:|---|---:|
| `@i-harness/tui` | 96 | `@i-harness/sandbox` | 9 | `@i-harness/fs-watch` | 5 | `@i-harness/goal` | 2 |
| `@i-harness/settings` | 36 | `@i-harness/core-agent` | 8 | `@i-harness/interaction` | 5 | `@i-harness/provider-runtime` | 2 |
| `@i-harness/skills` | 26 | `@i-harness/guard-approval` | 8 | `@i-harness/output-retention` | 5 | `@i-harness/sandbox-local` | 2 |
| `@i-harness/schedule` | 19 | `@i-harness/hooks` | 8 | `@i-harness/runtime-context` | 5 | `@i-harness/guard-repeat-tool` | 1 |
| `@i-harness/sdk` | 17 | `@i-harness/lsp` | 8 | `@i-harness/sandbox-policy` | 5 | `@i-harness/guard-timeout` | 1 |
| `@i-harness/plugin-registry` | 15 | `@i-harness/sandbox-windows-acl` | 8 | `@i-harness/shell` | 5 | `@i-harness/llm-anthropic` | 1 |
| `@i-harness/provider` | 15 | `@i-harness/terminal` | 8 | `@i-harness/token-meter` | 5 | `@i-harness/llm-gemini` | 1 |
| `@i-harness/workflow` | 15 | `@i-harness/agent-team` | 7 | `@i-harness/web` | 5 | `@i-harness/llm-mock` | 1 |
| `@i-harness/subagent` | 13 | `@i-harness/core-plugin` | 7 | `@i-harness/workspace` | 5 | `@i-harness/llm-openai` | 1 |
| `@i-harness/core-session` | 12 | `@i-harness/session-persistence` | 6 | `@i-harness/acp` | 4 | `@i-harness/llm-openai-compatible` | 1 |
| `@i-harness/mcp-client` | 11 | `@i-harness/text-diff` | 6 | `@i-harness/compaction` | 4 | `@i-harness/preset` | 1 |
| `@i-harness/web-host` | 11 | `@i-harness/feedback` | 5 | `@i-harness/core-tools` | 4 | `@i-harness/session-executor` | 1 |
| `@i-harness/llm-seam` | 9 | `@i-harness/fs-search` | 5 | `@i-harness/fs` | 4 | | |
| `@i-harness/rewind` | 9 | | | `@i-harness/llm-bedrock` | 4 | | |
| | | | | `@i-harness/session-query` | 4 | | |
| | | | | `@i-harness/session-title` | 4 | | |
| | | | | `@i-harness/tool-search` | 4 | | |
| | | | | `@i-harness/tui-core` | 4 | | |
| | | | | `@i-harness/attachment` | 3 | | |
| | | | | `@i-harness/instructions` | 3 | | |
| | | | | `@i-harness/plan-mode` | 3 | | |
| | | | | `@i-harness/telemetry` | 3 | | |
| | | | | `@i-harness/todo` | 3 | | |
| | | | | `@i-harness/credentials` | 2 | | |
| | | | | `@i-harness/exec` | 2 | | |

64 of the 68 directories under `packages/` that carry a `package.json` appear above. The four that
carry **no** finding at all are `fs-lock`, `guard-retry`, `jobs` and `session-persistence-jsonl`. The
authoritative row-level list is the tool's own output at this SHA — regenerate with

```powershell
node scripts/audit/check-reachability.mjs --json > baseline.json
```

and check it against the §2 digest. **No row-by-row adjudication of these 512 rows was performed, and
none is claimed.** §5 states the sample that was.

---

## 4. The source-list reconciliation

22 rows over four lists (20 distinct items: `sandbox/mode` appears in both D1 §跨包主線 8 and sandbox
spec §7; `tui --yes` in both D1 §跨包主線 8 and the CLI surface). Verdicts are exactly one of
`already-fixed`, `still-holds`, `by-design`.

**Tally: `already-fixed` 5 · `still-holds` 2 · `by-design` 15** — recomputed from the four tables below
rather than carried from any sentence of this document. **Corrected here by re-measurement:** the
edition before this one published `6 · 2 · 14` in this line. The verdict cells of the four tables give
**`5 · 2 · 15` = 22** — taken row by row as the final cell of each of §4.1's 8, §4.2's 6, §4.3's 4 and
§4.4's 4 rows: §4.1 = 4 `already-fixed` (items 1, 2, 3, 5), 1 `still-holds` (item 6), 3 `by-design`
(items 4, 7, 8); §4.2 = 6 `by-design`; §4.3 = 3 `by-design` (items 1–3), 1 `still-holds` (item 4);
§4.4 = 3 `by-design` (items 1–3), 1 `already-fixed` (item 4). The published `6` and `14` were each
wrong by one, in opposite directions: Task 7 moved §4.1 item 8 out of `still-holds` into **`by-design`**
(§4.1 item 8's own cell says "narrowed, not allowlisted as a finding"), and this paragraph counted
that move into `already-fixed` instead. Phase B moved **eight** of the 22 verdicts:

- **three to `already-fixed`**, each by a code task: `buildWireClient` (§4.1 item 3) and
  `withdrawPlanModeTool` (§4.1 item 5), whose declarations Task 4 deleted; and `i-harness run --help`
  (§4.4 item 4), whose route Task 3's guard now closes. Each row names the commits that did it;
- **five to `by-design`**, each with a reason sentence in §6.2 or §4.1: the `output-retention` spill row
  (§4.2 item 4), `classifyDenial` (§4.3 item 1), `exitCode: -1` (§4.3 item 2), `--flag=value`
  (§4.4 item 3), and the three-name export residue of §4.1 item 8, which Task 5 narrowed to
  module-private declarations rather than wiring (`06d684c`).

The arithmetic is stated so it can be checked against the tables rather than against this paragraph:
**Phase A was `2 / 10 / 10`** — its own tally line, which the edition before Task 6's carried, and
Task 6 replaced. Phase B moved eight rows **out of Phase A's `still-holds` 10**, and the two bullets
above are those eight: three became `already-fixed` (**2 + 3 = 5**) and five became `by-design`
(**10 + 5 = 15**), leaving **10 − 8 = 2** still holding. **5 + 2 + 15 = 22**, the row count §4 opens
with — the same 22 rows Phase A counted as `2 + 10 + 10`.
**The earlier edition's numbers at this spot were a second error of the same edit:** it read
"Phase A's `already-fixed` 3 is unchanged (3) … `by-design` 9 gained 5 (9 + 5 = 14) … 6 + 2 + 14 = 22",
which is both the wrong Phase A baseline (3/10/9 rather than 2/10/10) and arithmetic that does not
close (**3 + 2 + 14 = 19**, not 22).
This is a **row** tally, not the allowlist's entry count. The four tables contribute 8 + 6 + 4 + 4 = 22
rows, of which **15 are `by-design`**; §4.5's **three** `by-design` adjacent D1 rows are recorded there
and are **not** part of this tally, so they neither add to the 15 nor move it. The
allowlist's 6 entries in §6.1 and 13 in §6.2 are a separate set, so 15 `by-design` rows and 19
allowlist entries are not two figures for one thing.
§4.1 item 8's move is the eighth of Phase B's eight, and the fifth of the five that took `by-design`
from 10 to 15 — which is why `by-design`, not `already-fixed`, is the column Task 5's narrowing moved:
dropping an `export` keyword removes a consumer-less declaration *edge*, it does not make the
declaration reachable from anywhere it was not reachable before, so the row is a disposition
(`by-design`) rather than a fix.

**The two remaining `still-holds` cells are one item twice.** The `sandbox/mode` scenario — §4.1 item 6
and §4.3 item 4, which the sandbox spec repeats. That one is not a TUI-only gap and is not left without
a task or a reason: §4.1 item 6 records what Task 1 did and did not discharge, and names the follow-up
as **M** with its out-of-scope blocker stated. **Both `still-holds` cells in the tally are that pair**,
and no third residue remains: §4.1 item 8 was the third and Task 5's narrowing moved it to `by-design`.

**§4.5's four adjacent rows are recorded, not list items, and are not in this tally** — which is why
three of their cells can be `by-design` without moving the 22-row split.

**The standing scope decision this tally applies (2026-09-15, roadmap §5 Q6).** The existing TUI and
web are **frozen and slated for replacement**: the whole frontend is to be abandoned and rebuilt later,
outside M1–M7, so the roadmap's own scope line excludes the four frontend packages `tui`, `tui-core`,
`web`, `web-host` and keeps `apps/cli` and `packages/*` in scope
(`docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md:3`, `:192`, `:278`). Two items
below are therefore allowlisted as **deliberately out of scope** rather than as `still-holds` — the
finding is real, but the only in-repo code it names is TUI code that is going away, so fixing it would
be investment in code being removed. Each carries the obligation it hands the replacement frontend in
its reason sentence (§6.2), so the replacement does not silently inherit the gap. That move is why the
tally changed from the first edition's `2 / 13 / 7`: `tui --yes` is **two** of the 22 rows (§4.1 item 7
and §4.4 item 1 — the CLI-surface list repeats the D1 item) and `mountPreset` is one, so three row
verdicts moved from `still-holds` to `by-design` before Phase B's code tasks and this task's
adjudications moved eight more (the tally above — and it is the **same** eight: three to
`already-fixed` and five to `by-design`, taking `2 / 10 / 10` to `5 / 2 / 15`).

An item the scanner did **not** surface is still a row. The `surfaced?` column records **what the tool
emitted for that item** — a finding kind and subject where it emitted one, a bold **no** where it did
not. It is not a reason column: where a non-surfacing needs explaining, the explanation is in the
`Measured evidence` cell, because the reason is always a fact about the tree (which file anchors
match, which names are re-exported, which mention suppressed the row) rather than a property of the
column. Every verdict below rests on a command run in this task, not on the source document.

### 4.1 D1 §跨包主線 8

| # | Item | Surfaced? | Measured evidence | Verdict |
|---|---|---|---|---|
| 1 | no tool schema declares `sandbox_permissions` | no | `sandbox_permissions` occurs in **7** production files: `packages/fs/src/index.ts:81,247,250` (the exact three lines cited by the brief), plus `packages/shell/src/index.ts:194,239,352,412` and `packages/terminal/src/tool.ts:86,187,226`, and the ladder consumes it at `packages/sandbox/src/call-policy.ts:141,177,192`. Not surfaced because there is no longer an orphan to find: the claim is false, so no scanner class can emit a row for it | **`already-fixed`** |
| 2 | the sandbox escalation module appears only in tests | no | `WIDER_MODES` is used on a production path at `packages/sandbox/src/denial.ts:91,93` (the exact two lines cited by the brief). Not surfaced for the same reason as row 1 — the module is reached from production, so there is nothing to report | **`already-fixed`** |
| 3 | `buildWireClient` | yes — `unused-export @i-harness/provider#buildWireClient` | the name occurred in exactly **2** files at Phase A: its declaration (`packages/provider/src/index.ts:762`) and `packages/provider/test/provider.test.ts`. It was a **bucket-A** row — no reference inside its own declaring module — so the remediation was deletion rather than un-exporting: Task 4 removed it in two commits — `c5652c7` un-exported it, then `24e9395` deleted the declaration and the case that called it — and the name survives only in that case's comment, which keeps the **requirement** the function embodied (a wire-keyed factory is useful only to a consumer that holds the resolved string and no profile) rather than the dead function. The declaration is gone from the tree, so the row is discharged | **`already-fixed`** |
| 4 | `mountPreset` | **no** | the name occurs in 3 files: declaration `packages/preset/src/index.ts:30`, a **comment** `packages/tui/src/views/light-personas.ts:2` (`// persona catalog (verified: @i-harness/preset exports parsePreset/mountPreset`), and `packages/preset/test/preset.test.ts`. It has **no production caller**. It did not surface because the comment in an unrelated production file counts as a mention — see §7 item 4. The file holding that comment is `packages/tui` — the TUI, frozen and slated for replacement (§4, scope decision) — so the row is allowlisted as deliberately out of scope instead of kept as Phase B work | **`by-design`** — allowlist §6.2, deliberately out of scope; the replacement frontend carries the decision |
| 5 | `withdrawPlanModeTool` | yes — `unused-export @i-harness/plan-mode#withdrawPlanModeTool` | the name occurred in exactly **1** file in the entire tree at Phase A: `packages/plan-mode/src/index.ts:36`. Task 4 removed it in two commits — `c5652c7` un-exported the declaration, then `24e9395` deleted it — and removed only the case that asserted the absence of the export edge the deletion removes; the surviving `plan-mode` case asserts **live** behaviour instead (`ensurePlanModeTool` is idempotent, and plan mode OFF does not withdraw `exit_plan_mode`), so the deletion did not have to sacrifice coverage. The declaration is gone from the tree, so the row is discharged | **`already-fixed`** |
| 6 | `sandbox/mode` has no producer | **no** | **Re-labelled and re-measured here: the sentence below left its revision unstated while the same cell carried HEAD coordinates.** At **Phase A** (`74f86d5`) the quoted literal `"sandbox/mode"` occurs on **19** lines of the walked tree: **17 in `test/` files** and **2 in production code** — the event-type declaration (`packages/core-session/src/index.ts:43`) and the **reader** (`packages/sandbox-policy/src/session-mode.ts:9`) — with **0** in production comments *in that quoted form*. At **HEAD** the same rule gives **32** lines: **28 in `test/` files** and **4 in production** — those same two plus Task 1's construction-time **producer** (`packages/session-executor/src/assembly.ts:354`) and the **registration** it forced (`packages/session-persistence/src/index.ts:236`). The quoted-literal production-comment count is still **0** at HEAD. **Which form that zero counts, corrected here by re-measurement.** The `0` above is true of the **double-quoted literal only**; the **bare** pattern `sandbox/mode` — the spelling the codebase actually uses in prose — matches **18 production comment lines** (measured over the 360 non-test files, counting a line whose first non-space characters open a `//`, `/*` or `*` comment), of which **four state the missing-producer contract in prose**: `packages/sandbox/src/call-policy.ts:33` and `:206` (*"appends no `sandbox/mode` event"*, *"no `sandbox/mode` event is appended"*), `packages/shell/src/index.ts:159` and `:385` (*"no `sandbox/mode` event, and never moves the standing mode"*, *"appends no `sandbox/mode` event of its own"*). The bare count is what a reader reproduces, so recording only the quoted zero understated this row's production-comment count by 18 lines. 14 of those 17 test lines are `append(…)` calls at Phase A (15 of the 28 at HEAD), and **0** production files append the event **at Phase A**. It did not surface because class 2 is anchored on the declaring file's **name** (`/(^\|\/)(events?\|manifest\|public-event-manifest)\.ts$/`), which matches exactly **one** file in this repo — `packages/telemetry/src/manifest.ts` — while this union lives in `packages/core-session/src/index.ts`. **What Task 1 changed, and what it did not.** A **construction-time** producer now exists: `packages/session-executor/src/assembly.ts:354` appends the event when a host passes a `sandbox` option (`if (opts.sandbox !== undefined) append(policyBase, { type: "sandbox/mode", mode: opts.sandbox })`), so the "0 production files append the event" measurement above is the **Phase A** one. The row's **stronger** claim survives it: **no in-scope surface can change a *live* mode.** The only shipped surface that could is `/sandbox` (`apps/cli/src/web.ts:273-282`), which is frozen, and even it writes `settings.sandboxMode` for sessions created *afterwards* (`:280`), not for the one running; ACP's `session/set_mode` is in the v0 **drop-set** (`packages/acp/src/index.ts:21-25`); and the SDK and subagent trees contain **no** `sandbox` occurrence at all (0 in `packages/sdk/src`, `packages/subagent/src`). The follow-up is therefore a **`setSandboxMode` seam plus a caller** — new mechanism on a published assembly surface, i.e. **M** — and its blocker is **outside this milestone**: the only host that changes a mode at all is the frozen web route, so the caller cannot be written here. Recorded so it is not rediscovered as a surprise | **`still-holds`** |
| 7 | `tui --yes` | yes — `unread-flag --yes` | see §3.2 item 2: `flags.yes` is assigned at `apps/tui/src/index.ts:445` and read nowhere; `--yes` is additionally advertised in two usage strings (`:9`, `:461`). The finding is real; `apps/tui` is the TUI, frozen and slated for replacement (§4, scope decision — note this is `apps/tui`, not `packages/tui`), so it is allowlisted as deliberately out of scope | **`by-design`** — allowlist §6.2, deliberately out of scope |
| 8 | `estimateAssemblyOverhead` / `bindAuthRefreshStatus` / `RewindAssemblyHandle` | **no** | **Corrected to three names** — D1 and the first edition named two; there are **three** in the same position, and the third is `RewindAssemblyHandle`, an interface declared at `packages/session-executor/src/assembly.ts:166` and used only at `:206` (`rewind?: RewindAssemblyHandle`). All three are declared and **used inside their own module**: `:220` + call at `:786`, `:234` + call at `:642`, `:166` + use at `:206`. **The two call coordinates are corrected here by re-measurement:** the previous edition published `:779` and `:635`, which are a blank line and a comment line respectively — the calls are at `assembly.ts:786` (`: estimateAssemblyOverhead(systemPromptNow(), tools.schemas())`) and `:642` (`onAuthRefreshFailed: bindAuthRefreshStatus(cfg.serverName, mcpStatusHook, {`). `packages/session-executor/src/index.ts` is 22 lines and re-exports **exactly 14 names**, none of them these three — in full: `createSessionAssembly`, `ModelUnavailableError`, `AssemblyOptions`, `ModelPolicy`, `SessionAssembly` (all from `./assembly.ts`), `createDurableSessionLoader` (from `./durable-session.ts`), `createSessionService`, `SessionModelBindingResult`, `SessionQueueItem`, `SessionService`, `SessionServiceOptions` (from `./service.ts`), `AgentTaskStatus`, `AgentTaskView` (from `@i-harness/subagent`), `ReasoningEffort` (from `@i-harness/core-agent`). At Phase A their only importer was `packages/session-executor/test/assembly.test.ts:19-24`, through the relative path `../src/assembly.ts` — i.e. **not** through the package entry. So D1's claim (declared in `assembly.ts`, not re-exported by `index.ts`, `package.json` exposes only `"."` → unreachable outside the package) **still holds as written**. It did not surface because class 1 walks only `packages/*/src/index.ts` entries and reports the names **that entry exports** — these three are not among them, so there is nothing for the scanner to test. Half the sentence that introduced them in D1 ("no production caller") is however no longer true — all three are used on a production path inside `assembly.ts`. **Task 5 discharged the residue**: it dropped the three `export` keywords (`assembly.ts:166`, `:220`, `:234`) and rerouted the two test cases through `createSessionAssembly`, so the file-level export edge with no consumer is gone and the declarations are now module-private. That is the *narrowing* disposition this row's residue called for, not a wiring change — nothing was made reachable, and nothing needed to be. Verdict moved to `by-design`: the row is a declaration-edge decision that has been taken, and the declarations stay live and private. **Task 5 completed the change in `06d684c`**, this edition's parent commit: the un-export is committed, not a working-tree state, and the scanner returns the same 523 rows before and after it (§2.1). | **`by-design`** — narrowed, not allowlisted as a finding (§6.4) |

### 4.2 D1 §未竟事項

| # | Item | Surfaced? | Measured evidence | Verdict |
|---|---|---|---|---|
| 1 | `core-session` `migrate()` is a no-op | **no** | `packages/core-session/src/index.ts:682-687`: the body returns `session` unchanged when `targetVersion === CURRENT_FORMAT_VERSION` and throws otherwise, and `:686` says in-source *"M1: only v1 exists; migrate-on-continue is a no-op placeholder for future versions"*. It has **zero call sites** in the tree; the only other `migrate` identifier is an unrelated private function in `packages/session-persistence/src/index.ts:360`, called at `:468` and `:515`. It did not surface because **that same-named unrelated function in another package counts as a mention and suppresses the finding** — the cross-package collision of §7 item 3 | **`by-design`** — see allowlist §6 |
| 2 | `goal` round admission unimplemented | **no** | `packages/goal/src/index.ts:9-10` says in-source: *"no round admission (DSH's `roundsStarted` — explicitly out of scope; the `round` view field is a …)"*, and `:36-43` declares `round?: number` as wire vocabulary so the UI/host contract does not break when round admission lands. `packages/goal/test/goal.test.ts:37` asserts `(view as GoalView).round` is `undefined`. It did not surface because `round` is an optional interface *field*, and no scanner class covers a field | **`by-design`** — allowlist §6 |
| 3 | `session-query` `SearchHit.time` is index time | **no** | `packages/session-query/src/index.ts:13-17` — the field's own doc comment says *"M51 B4: INDEX-REBUILD time (epoch ms), NOT the event's time. The JSONL log carries no per-event timestamp, so the file-backed index can only …"*. `SearchHit` **is** on a production path: imported at `packages/session-query/src/file-backed.ts:12` and used at `:469`, `packages/session-query/src/index.ts:44,150`. Correctly not a finding | **`by-design`** — allowlist §6 |
| 4 | `output-retention` bare `createSpillStore` never cleans up | **partly** | all three parts of the Phase A characterisation fail on measurement. (a) **`createUnifiedSpillStore` is not a fix and never calls GC**: `packages/output-retention/src/spill-guard.ts:90-92` is a three-line root-selecting factory — `return createSpillStore({ root: root ?? join(tmpdir(), "i-harness-spill") })`. (b) **GC is wired**: `spill-guard.ts:25` calls `gcSpillStore(root, gcOpts)` inside `createOutputSpillGuard`, which production mounts at `packages/session-executor/src/assembly.ts:524` (`if (opts.outputSpill) ctx.mount(createOutputSpillGuard(ctx, opts.outputSpill))`). (c) **Nothing in production supplies a spill root at all**, so what ships is **no spill store, not an uncleaned one**: the assembly's default retention is `opts.shellRetention ?? { maxBytes: 64_000 }` (`assembly.ts:400`), which carries no `spill` key — the key is declared at `packages/shell/src/index.ts:135` and is exactly what `:280` tests before it creates a store — and **nothing outside `test/` ever supplies either option**: `apps/cli/src/run.ts:252,288` only forwards what its caller passed, and the only sites in the tree that pass a value are tests (`apps/cli/test/cli.test.ts:1340` on the headless path; `packages/shell/test/spill-notice.test.ts:34,65,85` and `packages/output-retention/test/spill-guard.test.ts` on the store/guard layer). The two rows the scanner does emit are real — `@i-harness/output-retention#createUnifiedSpillStore` has **no caller anywhere**, and `@i-harness/output-retention#gcSpillStore` is reported because its only call (`spill-guard.ts:25`) is inside its own declaring module — but neither is a fix that was left unwired. The source labels the shipped behaviour itself as the decision, at `packages/output-retention/src/index.ts:170-171` (*"絕不寫 workspace——研究決策；**不清理（已知 limitation）**"*), and all three declarations landed together in `c3875a9`: the guard, the GC it calls, and the factory that only selects a root | **`by-design`** — allowlist §6.2 |
| 5 | `workspace` defers `delete`/`insertBefore`/`follow`/`status` | **no** | `packages/workspace/src/index.ts:30-42` says in-source: *"Deliberately DEFERRED (Task 3.1 controller ruling — seams noted in code, not implemented)"* and gives a reason per item (`delete`: the host route is intentionally absent so it answers the generic JSON 404; `insertBefore`: reordering APIs are out of the minimal set; `follow`: the list routes already serve a full baseline; `status`: liveness tracking is deferred). It did not surface because a deferred API that is simply **absent declares nothing** — the scanner finds declarations without consumers, not consumers without declarations | **`by-design`** — allowlist §6 |
| 6 | `lsp` forces one server per run | **no** | `packages/lsp/src/scheduler.ts:20-24`: *"M18 core supports ONE LSP server per run: a second mount with a DIFFERENT … (M18 non-goal)"*, with the refusal string `"lsp: only one LSP server per run is supported (M18 core)"`. Not surfaced: a documented non-goal leaves nothing declared to find | **`by-design`** — allowlist §6 |

### 4.3 sandbox spec §7

The roadmap cites "the sandbox spec §7"; the residuals are `docs/superpowers/specs/2026-09-14-backend-permission-sandbox-design.md` §7, items 1–4 (added 2026-09-15).

| # | Item | Surfaced? | Measured evidence | Verdict |
|---|---|---|---|---|
| 1 | shell runtime denial unclassified (`classifyDenial`'s callers are only tests) | **no** | `classifyDenial` is declared at `packages/sandbox-local/src/runner-failures.ts:23` and its only importer is `packages/sandbox-local/test/local.test.ts:3`. The field it consumes, `denialSignatures`, **is** published in production (`packages/sandbox-local/src/index.ts:83`, `packages/sandbox-windows-acl/src/index.ts:647`) but is read in production only at `packages/sandbox-local/src/runner-failures.ts:26` — i.e. inside the test-only classifier. `packages/exec/src/index.ts:103` only mentions it in a comment. So a real OS denial inside a confined shell reaches the model as an ordinary non-zero exit plus raw stderr. Not surfaced because `runner-failures.ts` is not re-exported from `packages/sandbox-local/src/index.ts` (which exports exactly `LocalSandboxConfig`, `createLocalSandbox`, `probeBwrap`), and class 1 walks package entries only. **Adjudicated `by-design` on the parked ruling** at `docs/handoff/what-the-design-does-not-answer.md:71` — *"**Ruling: document, do not implement.**"* — because the fix is structurally forced through `@i-harness/sandbox` (the seam the same file's header at `:1-3` says the classification helpers moved into, while `classifyDenial` stayed behind) and necessarily widens `ExecResult` **plus** the model-visible shell payload, i.e. it is an **M-shaped spec** with no S-sized version. Naming it `by-design` records the ruling and the follow-up (§6.2), not a preference that closes it | **`by-design`** — allowlist §6.2 |
| 2 | `exitCode: -1` is six-valued | **no** | re-measured at HEAD, and the Phase A site list was wrong in two ways. Corrected: `packages/shell/src/index.ts:217` is the **ladder refusal** (`resolution.kind === "refused"`), whose discriminator is **internal** — the tool result the model sees is only `{ stdout, stderr, exitCode }` (`:380` returns `ladder.refusal`), so the refusal does not arrive as one; `:268` is the sandbox-unavailable refusal; `:372` is **not** a `kind: "refused"` refusal at all but the **bash-absent** branch (`if (!bashAvailable())` → *"bash is not installed on this host"*), and the comment at `:266` takes that as the meaning `-1` carries everywhere ("this host could not run it", never "it ran and failed"); `packages/exec/src/index.ts:209` is `child.on("close", (code) => doneFn(code ?? -1))`, so any signal death or Windows force-kill is also `-1`; and `:210` — `child.on("error", () => doneFn(-1))`, a spawn that never happened — was **missing from the baseline entirely**. Also measured: `packages/workflow/src/runner.ts:222` (synthesised for a **thrown** error), and the frozen TUI's copy of that runner at `packages/tui/src/app/slash/impl/workflow2.ts:220-221`. Counting **meanings** rather than sites gives **at least eight**: (1) bash is not installed; (2) the ladder refused the call; (3) no sandbox backend is usable, which `:266` says the `-1` "mirrors the bash-absent branch" for; (4) the child was killed by a signal; (5) the child was killed by the host's own abort — `exec/src/index.ts:148-150` documents this as deliberately **indistinguishable** from (4), since "an abort is NOT a timeout — `timedOut` stays false so callers see the real (killed) exitCode"; (6) the child could not be spawned at all; (7) a workflow step threw; (8) the TUI's copy of that runner does the same. No scanner class covers a numeric sentinel. **Adjudicated `by-design` on C10** at `docs/handoff/what-the-design-does-not-answer.md:49`, with the disambiguation named as an M follow-up in §6.2 (the same shape as `classifyDenial`: it widens a result type every surface consumes) | **`by-design`** — allowlist §6.2 |
| 3 | `allowed-once` consumed by a call that fails for an unrelated reason | **no** | verified in code: `packages/fs/src/index.ts:305` runs the escalation ladder (`resolveWriteCall`, which is where the one-shot grant is asked for and consumed) and only **then**, at `:308`, does `if (old_string === "") throw new FsToolError("FS_AMBIGUOUS_EDIT", …)`. `apply_patch` is the same shape: the ladder at `:381`, `applyPatch` at `:384` with per-hunk `guardWrite`. So a granted widening is spent on a call that fails validation the widening could not have helped. Not surfaced: no scanner class covers call ordering. The spec itself says of this item *"記錄而不修"* and gives the reason — see allowlist §6 | **`by-design`** — allowlist §6 |
| 4 | the `sandbox/mode` scenario has no producer | **no** | identical to §4.1 item 6 — same measurement, one row, cross-referenced rather than re-derived. The non-surfacing reason is the same: the event union is declared in `packages/core-session/src/index.ts:43`, which class 2's file-name anchor does not match (it matches exactly one file, `packages/telemetry/src/manifest.ts`). Note the disagreement recorded in §6: the spec calls this *"a reachability statement, not a defect"*, while roadmap §3.M1 makes it M1's headline case. **The row still holds, for the reason §4.1 item 6 states in full:** Task 1's producer is construction-time only, so the mid-session tightening this item is about is still unreachable in production; the named **M** follow-up and its out-of-scope blocker are recorded there rather than repeated here | **`still-holds`** |

### 4.4 CLI surface

| # | Item | Surfaced? | Measured evidence | Verdict |
|---|---|---|---|---|
| 1 | `tui --yes` parsed but never read | yes — `unread-flag --yes` | identical to §4.1 item 7 — cross-referenced, not re-derived. Verdict follows it: `apps/tui` is frozen and slated for replacement (§4, scope decision), so deliberately out of scope | **`by-design`** — allowlist §6.2 |
| 2 | unknown subcommands not rejected | **no** | `apps/cli/src/index.ts` dispatches by exact equality on `args[0]`: `web` `:102`, `sdk` `:129`, `sessions` `:134`, `acp` `:139`, `tui` `:145`, `__dist-selfcheck` `:153`, `--version`/`-v` `:156`, `help`/`--help`/`-h` `:160`; then `:164` `if (args[0] !== "run") return Promise.resolve(runTui(parseFlags(args)))` at `:167`. So `i-harness --sandbox x run t` — and any typo — launches the TUI. Not surfaced: no scanner class covers a dispatch chain. The fall-through is documented as deliberate at `:142-144` (*"the GROK-STYLE DEFAULT — a bare `i-harness` (**or any non-subcommand first token**) launches the TUI"*) | **`by-design`** — allowlist §6 |
| 3 | no `--flag=value` support | **no** | **in `apps/`**: contains **zero** `split("=")` and **zero** `indexOf("=")`, and two `startsWith("-")` — `apps/cli/src/sessions.ts:62` (`if (!token.startsWith("-") && subcommand === "show" && id === undefined)`) and `apps/cli/src/index.ts:191`, which is the **dash-token guard Task 3 added**, not a parser (§4.4 item 4). **Corrected here: the first edition's "across the whole tree … `apps/` contains zero occurrences of …" conflated two scopes.** Two `=` splits **do** exist in the tree — `packages/web-host/src/host.ts:700` (`const i = part.indexOf("=")`) and `packages/tui/src/app/slash/impl/workflow2.ts:38` (`const eq = tok.indexOf("=")`) — both in **frozen frontend packages** (§4, scope decision) and neither a CLI parser, so the verdict stands; only the scope sentence was wrong. `packages/` also contains exactly one `startsWith("--")` — `packages/guard-approval/src/danger-class.ts:87`, a shell-flag classifier, not a parser. **The parse-site list was also incomplete**: it missed a third in-scope site, `apps/cli/src/sessions.ts:45-65` (`parseSessionsArgs`, which reads `--json` at `:52`, `--session-dir` at `:53`, `--last` at `:54-58`, `--help`/`-h` at `:59`, and the bare positional at `:62`) — the `sessions` subcommand's own parser. Both parsers match whole tokens (`apps/tui/src/index.ts:441-456` `switch (argv[i])`; `apps/cli/src/index.ts:208` `args.indexOf("--sandbox")` and `:332` `a === "--model"` — the `:181`/`:305` of Phase A, which Task 3's guard pushed down by 27 lines). Not surfaced: no scanner class covers argument *syntax*; all five look for declarations, not for shapes a parser fails to accept. **Adjudicated `by-design` — deliberately unsupported (§6.2)** — and the declaration carries an obligation Task 3 discharged: the form now **fails loud** as an unknown flag, so `--model=x` can no longer be silently swallowed into the prompt. The grammar this leaves in place is narrower than "no `=` support" and is recorded as **grammar, not as a defect**: any `run` task token beginning with a dash is **reserved and rejected with exit 1** — `run "-40 degrees"`, `run hi --` and `run hi --flag=value` all exit 1 naming the token — and there is **no `--` end-of-flags separator**, so a prompt that must begin with a dash is inexpressible. Adding one is new argv grammar, i.e. an **M** follow-up with its own spec (§6.2), not a fix round on the router | **`by-design`** — allowlist §6.2 |
| 4 | `i-harness run --help` runs a task named `"--help"` | **no** | `apps/cli/src/index.ts:160` catches `--help` only as `args[0]`, so `run --help` passes it; the task is then built at `:304-309` by filtering out exactly seven flags (`--model`, `--api-key`, `--yes`, `--session-dir`, `--resume`, `--telemetry`, `--sandbox`) and their values, so the literal `"--help"` survives into `task`, is non-empty at `:310`, and reaches `runHeadless` at `:333`. Not surfaced: no scanner class covers argument routing. **Task 3 fixed the route** (`0d168e2`, then `b96d162`): the guard at `:184-195` rejects any dash-leading unknown token on the `run` path **before** the settings load, the session/coordinator creation and model resolution, so `run --help` now exits 1 with `unknown flag --help` and never reaches the filter — which at HEAD is `:331-335`, with `runHeadless` at `:360`. Refusing is the intended answer here: `--help` *after* `run` is an unrecognised flag, not a help request, and the top-level `help`/`--help`/`-h` command is deliberately untouched, still pinned by `apps/cli/test/bin.test.ts:33-38`. The new refusal and the declared narrowing are pinned in `apps/cli/test/run-flag-routing.test.ts`. The description above is the **Phase A** measurement of the pre-fix code. **This row under-stated its own class, and the erratum is recorded here so §7 item 14's cross-reference to it resolves:** the filter described above did not merely list "exactly seven flags" — it failed to strip an **eighth** run flag, `--no-compact`, parsed at `apps/cli/src/index.ts:182` in Phase A (HEAD `:209`) and **documented nowhere** (absent from the run usage line at `apps/cli/src/index.ts:37` and from the error-path usage at `:338`, and from `docs/CAPABILITIES-DETAIL.md:425`). So the leak ran both ways: `i-harness run "do x" --no-compact` sent the model `do x --no-compact`, exactly as `run --help` sent it `"--help"`. Task 3 fixed both in the same guard change (`0d168e2`, `b96d162`) — the HEAD filter at `:332` lists eight names and the flag set at `:184` lists the same eight — which is part of what this row's `already-fixed` rests on | **`already-fixed`** |

### 4.5 Adjacent rows from the same D1 sections (recorded, not list items)

Not part of the four lists as the roadmap copies them, but they sit in the same D1 sentences and were
cheap to measure. Recorded so Phase B does not have to rediscover them.

| Item (D1 location) | Surfaced? | Measured evidence | Verdict |
|---|---|---|---|
| `session-persistence` `registerUpgrade` has no registration point (D1 §未竟事項 bullet 4) | yes — `unused-export @i-harness/session-persistence#registerUpgrade` | the name occurs in exactly 2 files: its declaration + comment (`packages/session-persistence/src/index.ts:151,153`) and `packages/session-persistence/test/persistence.test.ts:74`. No production caller | `still-holds` |
| `session-query` `closeSessionQueries` (and the legacy opener) has no production caller (D1 §8) | **no** | the name occurs in **6** files, **2** of them non-test: `packages/session-query/src/index.ts:49` (comment) + `:52` (declaration) and `packages/session-query/src/file-backed.ts:88` (**comment**). The other **four** are `test/` files, counted by the rule that counts every other occurrence — whole-word matches of the name: `packages/session-query/test/filebacked.test.ts:10,28`, `query.test.ts:8,11,166`, `tools.test.ts:9,42,58,74`, and **`apps/cli/test/cli.test.ts:17,320,348`**. **The count of test files is corrected here by re-measurement:** this cell said "five" while enumerating the four above, and the five came from the Task 7 brief rather than from a count; the measurement is `6 = 2 non-test + 4 test`, and the four named are exactly the four files the name occurs in. (The first edition's "exactly **3** files … and four `test/` files" was wrong in its total and right in its test count — its list simply omitted `cli.test.ts` from those four.) One of the four, `apps/cli/test/cli.test.ts`, is in an **in-scope** package (`apps/cli`), unlike the other three. **This is a count fix, not a verdict change:** all four are still test files and test-only callers are still not production callers, so the row's disposition — `by-design` (§6.1), on the lifetime argument below — is untouched by it. It has **no production caller** and did not surface because of the comment-masking mechanism of §7 item 4 — the same mechanism as `mountPreset`. **It also has a sibling invisible for the entry-only reason at name level**: `closeFileBackedConnections` — declared at `packages/session-query/src/file-backed.ts:91` — appears in only two files, both non-test — its declaration and `packages/session-query/src/index.ts:55`, which is inside the package that imports it relatively (`:7`) — and it is **not exported from the package entry at all** (`packages/session-query/src/index.ts` imports it, never re-exports it), so class 1, which walks only `packages/*/src/index.ts` entries and tests **the names those entries export**, cannot test it: §7 item 13's blind spot, with this name as its third named instance. **Erratum, and one of this milestone's own:** the previous edition moved this declaration's citation to `:89` and asserted that the `:91` a brief cites for it is the `openConnections.clear()` line inside its body. Re-measured: `:89` is the last line of the comment block that introduces the connection `Set`, `:91` is `export function closeFileBackedConnections(): void {`, and `openConnections.clear()` is at `:93` — **the brief was right and the "correction" invented an error.** It is recorded here rather than silently reverted (the same false correction stood in the handoff's §2 after Phase B, where it is now retracted in place); the false correction, not the citation, was the defect. **Adjudicated `by-design`** (§6.1): each CLI entry point creates **at most one query per process** — `apps/cli/src/index.ts:307` (`run`), `:474` (`sdk`), `:644` (`acp`) — the code's own comment at `:304` says the index is a process-private `:memory:` index, and no caller passes a `dbPath` (the default at `packages/session-query/src/file-backed.ts:238` is `:memory:`). The process exit **is** the lifetime boundary, so a close would have no observable effect on any shipped path. Note what the function is: a **process-global destroyer** (`packages/session-query/src/index.ts:52-56` closes a module-level `Set` of connections plus the file-backed ones, so any caller reaching it closes every other caller's handle too). The honest long-term fix — a per-instance `close()` — adds a member to the published `SessionQuery` interface (`:43-46`) and is therefore **M** | `by-design` |
| `guard-approval/src/remember.ts` is not re-exported and has no importer (D1 §8) | **no** | not a finding: `packages/guard-approval/src/index.ts` does not export it, and class 1 walks package entries only. This is the same structural blind spot as §4.3 item 1. **Kept and declared deliberately unwired** (human ruling, 2026-09-15): §6.1 states the reasons — the TUI lists `"remember"` in `NEVER_REGISTERED`, the approval path has no persistent-decision vocabulary, and the entry re-exports three sibling modules while never mentioning this one — and names the module an **input to the replacement frontend**, not a pending task | `by-design` |
| `sandbox-local/src/runner-failures.ts` is not re-exported, and `exec` never scans `ConfinedArgv.denialSignatures` (D1 §8) | no | the same measurement as §4.3 item 1; one row, not two. **Its verdict follows that row's**: `by-design` (§6.2) — the wiring is the same M-shaped change, and recording it here keeps the two rows from disagreeing | `by-design` |

---

## 5. The precision sample

### 5.1 How the sample was drawn

**Frame: 519, stated both ways so the arithmetic survives the two rows Task 4 deleted.** At the Phase A
revision the frame was `525 − 6 = 519` (the 6 being the 5 source-list `unused-export` rows
`@i-harness/provider#buildWireClient`, `@i-harness/plan-mode#withdrawPlanModeTool`,
`@i-harness/output-retention#createUnifiedSpillStore`,
`@i-harness/output-retention#gcSpillStore`,
`@i-harness/session-persistence#registerUpgrade`, plus the `unread-flag --yes` row). At the Phase B
revision it is `523 − 4 = 519`: `buildWireClient` and `withdrawPlanModeTool` are no longer *in* the 523
(Task 4 deleted both — §2.1), so only **four** of those six are still findings to subtract. **The frame
is 519 at both revisions and the sample arithmetic is unchanged** — but note it is not the *same* 519:
the Phase B frame is the Phase A frame minus those two rows. The 39-row sample below was drawn against
the Phase A frame, so two of its 27 class-1 rows (`buildWireClient`, `withdrawPlanModeTool`) are no
longer in the shipped set; that is recorded here rather than silently re-drawn, because §5.2's result is
tied to exactly those rows.

**Sample size: 39**, drawn in two parts:

- a **census** of all **12** non-`unused-export`, non-source-list rows — 1 `producerless-event`,
  3 `unpushed-capability`, 8 `unconsulted-setting`;
- a **systematic sample of 27** from the 507 remaining `unused-export` rows, drawn in **the tool's own
  emission order** — the order in which `check-reachability.mjs` pushes class-1 findings, minus the
  five source-list rows — starting at index 0 and stepping by ⌊507 / 27⌋ = **18**, stopping once 27
  rows are held.

  **What that order is, precisely:** `collectTs` (`scripts/audit/check-reachability.mjs:924-937`)
  walks with a raw `readdirSync` and never sorts, and the scanners are `flatMap`'d in class order
  (`:984`). So the emission order is **the filesystem's `readdir` order** — alphabetical on this NTFS
  checkout only because NTFS returns directory entries in index order, and hash order on ext4. Within
  a package it is declaration order in that package's `index.ts`. It is **not a property of the tool**
  and is **not stable across filesystems**, so this draw rule cannot be replayed portably.

  This is also why the wrong rule was easy to publish: the drawn list *looks* alphabetical. It is not.
  The counter-example is in the list itself — `@i-harness/settings#SettingsStatusLineSegment` is drawn
  at index 270 and `@i-harness/settings#LayeredSettingsStore` at index 288, while a subject sort puts
  `LayeredSettingsStore` first (`L` < `S`). Measured here: under a subject-sorted stride, **24 of the
  27 published rows are not drawn at all** (only `@i-harness/core-agent#AgentConfig`,
  `@i-harness/skills#MAX_SKILL_DEPTH` and `@i-harness/tui#editorBackspace` coincide). A reader who
  applied a sorted-stride rule would audit a different set and compute a different precision table.

**The 27 rows tabulated below are the sample of record — they are the sample, not a derivation of the
rule, and they are load-bearing rather than illustrative.** A reader must not re-derive them: the
§5.2 result is tied to exactly these rows, and re-drawing would invalidate it. Since the draw cannot
be reproduced portably, this table *is* the definition of the sample. Each row is the
`kind | subject | evidence` triple the tool itself emits, so every one can be located directly in
`node scripts/audit/check-reachability.mjs --json` output. The `draw index` column records the row's
position in *this run's* emission order (see the caveat above); it documents provenance and is not a
recipe.

| draw index | kind | subject | evidence |
|---:|---|---|---|
| 0 | `unused-export` | `@i-harness/acp#ACP_SERVER_NAME` | `packages/acp/src/index.ts` |
| 18 | `unused-export` | `@i-harness/core-agent#AgentConfig` | `packages/core-agent/src/index.ts` |
| 36 | `unused-export` | `@i-harness/core-session#PlanModeView` | `packages/core-session/src/index.ts` |
| 54 | `unused-export` | `@i-harness/feedback#MAX_FEEDBACK_NOTE_BYTES` | `packages/feedback/src/index.ts` |
| 72 | `unused-export` | `@i-harness/goal#GoalStateErrorCode` | `packages/goal/src/index.ts` |
| 90 | `unused-export` | `@i-harness/hooks#HookDecision` | `packages/hooks/src/index.ts` |
| 108 | `unused-export` | `@i-harness/llm-openai-compatible#OpenAICompatibleConfig` | `packages/llm-openai-compatible/src/index.ts` |
| 126 | `unused-export` | `@i-harness/mcp-client#MAX_PUBLIC_NAME_LENGTH` | `packages/mcp-client/src/index.ts` |
| 144 | `unused-export` | `@i-harness/plugin-registry#readMcpServers` | `packages/plugin-registry/src/index.ts` |
| 162 | `unused-export` | `@i-harness/provider#EffectiveContextInput` | `packages/provider/src/index.ts` |
| 180 | `unused-export` | `@i-harness/rewind#GitProbeOptions` | `packages/rewind/src/index.ts` |
| 198 | `unused-export` | `@i-harness/sandbox-local#probeBwrap` | `packages/sandbox-local/src/index.ts` |
| 216 | `unused-export` | `@i-harness/schedule#EveryScheduleRecord` | `packages/schedule/src/index.ts` |
| 234 | `unused-export` | `@i-harness/sdk#SdkConnectionError` | `packages/sdk/src/index.ts` |
| 252 | `unused-export` | `@i-harness/session-persistence#TOOL_ABORTED_RECOVERY_RESULT` | `packages/session-persistence/src/index.ts` |
| 270 | `unused-export` | `@i-harness/settings#SettingsStatusLineSegment` | `packages/settings/src/index.ts` |
| 288 | `unused-export` | `@i-harness/settings#LayeredSettingsStore` | `packages/settings/src/index.ts` |
| 306 | `unused-export` | `@i-harness/skills#MAX_SKILL_DEPTH` | `packages/skills/src/index.ts` |
| 324 | `unused-export` | `@i-harness/skills#SkillGetArgs` | `packages/skills/src/index.ts` |
| 342 | `unused-export` | `@i-harness/telemetry#TELEMETRY_MANIFEST` | `packages/telemetry/src/index.ts` |
| 360 | `unused-export` | `@i-harness/todo#validateTodoItems` | `packages/todo/src/index.ts` |
| 378 | `unused-export` | `@i-harness/tui#CancelTurnBindOptions` | `packages/tui/src/index.ts` |
| 396 | `unused-export` | `@i-harness/tui#PermissionKey` | `packages/tui/src/index.ts` |
| 414 | `unused-export` | `@i-harness/tui#ComposeRegionOptions` | `packages/tui/src/index.ts` |
| 432 | `unused-export` | `@i-harness/tui#editorBackspace` | `packages/tui/src/index.ts` |
| 450 | `unused-export` | `@i-harness/tui#NEW_SESSIONS_LABEL` | `packages/tui/src/index.ts` |
| 468 | `unused-export` | `@i-harness/tui-core#TtyStream` | `packages/tui-core/src/index.ts` |

Per row the check was mechanical: recompute the module(s) that **declare** the name (the tool's
`origins`), blank re-export statements the way `withoutReExportStatements` does, then classify every
remaining occurrence of the name across the 360 production files as a declaration, a comment, or
code. **The reproduction path for this baseline is the §3 command
(`node scripts/audit/check-reachability.mjs --json`) checked against the §2 digest** — not any scratch
script. The probe used to draw the sample lived in the gitignored `.superpowers/sdd/` scratch tree and
is not available in a fresh checkout; the 27 rows are published above precisely so that nothing
depends on it.

### 5.2 Result

| Bucket | Meaning | class 1 | classes 2–5 | total |
|---|---|---:|---:|---:|
| **A — dead** | **no code occurrence beyond the declaration itself**: apart from the declaration, every occurrence of the name — in the declaring module or in any other production file — is a re-export statement, a comment, a test import, or absent altogether. A declaration is not a "reference" for this purpose, and neither is a re-export statement or a comment; that is what separates A from B, which requires at least one **code** occurrence inside the module that declares the name. The tool is right, and the symbol really is dead | 1 | 0 | 1 |
| **B — live inside its declaring module only** | the name is referenced in **code** inside the module(s) that declare it; no production file outside them mentions it, so the `export` edge has no consumer anywhere, but the **symbol is not dead** | 26 | 0 | 26 |
| **C — live elsewhere** | referenced in a production file **outside** its declaring module. The report would be flatly wrong | **0** | 0 | 0 |
| | classes 2–5 are all genuine | | 12 | 12 |

Two numbers follow, and M2 needs both because they answer different questions:

- **Against the tool's own literal claim** ("nothing in the non-test tree mentions this name"):
  **26 of 39 rows are false positives = 66.7 %.** The name *is* mentioned on a production path; the
  mention is simply inside the module that declares it, which the tool excludes by construction.
- **Against the ratchet's operative claim** ("this declaration has no consumer on a production
  path"): **0 of 39.** Not one sampled row is exported-and-consumed, produced, read, pushed or
  consulted anywhere the tool should have seen. **The ratchet is trustworthy as a set of unconsumed
  declaration edges** — with three limits that this sample cannot lift, stated so the sentence is not
  read as a guarantee:
  1. **The bound, not a point estimate.** 0 false positives in 27 class-1 rows bounds the class-1
     false-positive rate at only **≈ 11 % (95 %, one-sided — the rule of three: 3 / 27 = 11.1 %)**.
     "0 of 27" is consistent with a real rate of up to about one row in nine.
  2. **507 is the population, not the sampling frame.** The stride stops once 27 rows are held, so the
     last row drawn sits at index 468 and **indices 469–506 (38 rows) can never be drawn** by this
     rule. The 27 rows are a systematic sample of the first 469 rows of the emission order, not of all
     507 in equal proportion.
  3. **Shared-attribution blindness, by construction.** The per-row check reuses the tool's own
     `origins` attribution and its `withoutReExportStatements` blanking, so **any attribution error
     the tool makes and the check inherits is invisible to this sample** — it can falsify the tool's
     *consumer* test, not its *attribution*. Only reading the code by hand, as in the bucket tables
     below, partially compensates.

These limits apply to the class-1 block only; classes 2–5 were a census, not a sample, and their
12/12 result is unaffected. They are also why the sentence above is scoped to *unconsumed declaration
edges*: that is the claim the sample supports, and it is a weaker claim than "these are orphans".

The operational consequence, which is the single most useful sentence for M2: **for 26 of the 27
sampled class-1 rows the correct remediation is "drop the `export` keyword", not "delete the
symbol".** A Phase B fix plan that reads §3.4 as a deletion list would propose deleting live code in
~96 % of the class-1 rows it touched.

The 26 bucket-B rows and the in-module reference that makes each name reachable:

| finding | declared in | the in-module reference |
|---|---|---|
| `@i-harness/acp#ACP_SERVER_NAME` | `packages/acp/src/index.ts` | `:104` `const app = agent({ name: ACP_SERVER_NAME })`, `:112` |
| `@i-harness/core-agent#AgentConfig` | `packages/core-agent/src/index.ts` | `:104` `createAgent(ctx: PluginContext, deps: AgentDeps & AgentConfig)` |
| `@i-harness/core-session#PlanModeView` | `packages/core-session/src/index.ts` | `:595-596` `derivePlanMode(session): PlanModeView` |
| `@i-harness/feedback#MAX_FEEDBACK_NOTE_BYTES` | `packages/feedback/src/index.ts` | `:178` compared and passed to `FeedbackNoteTooLargeError` |
| `@i-harness/goal#GoalStateErrorCode` | `packages/goal/src/index.ts` | `:57-58` the error class's own field and constructor parameter |
| `@i-harness/hooks#HookDecision` | `packages/hooks/src/types.ts` | `:44` `decision?: HookDecision` |
| `@i-harness/llm-openai-compatible#OpenAICompatibleConfig` | `packages/llm-openai-compatible/src/index.ts` | `:92` `createOpenAICompatibleClient(config: OpenAICompatibleConfig)` |
| `@i-harness/mcp-client#MAX_PUBLIC_NAME_LENGTH` | `packages/mcp-client/src/naming.ts` | `:24`, `:26` length cap and truncation arithmetic |
| `@i-harness/provider#EffectiveContextInput` | `packages/provider/src/index.ts` | `:142` `resolveEffectiveModelContext(input: EffectiveContextInput)` |
| `@i-harness/rewind#GitProbeOptions` | `packages/rewind/src/git-probe.ts` | `:113` `createGitProbe(opts: GitProbeOptions)` |
| `@i-harness/sandbox-local#probeBwrap` | `packages/sandbox-local/src/index.ts` | `:59` `const probe = probeBwrap(config.probeTimeoutMs)` |
| `@i-harness/schedule#EveryScheduleRecord` | `packages/schedule/src/index.ts` | `:56` union member, `:289` factory return, `:378` parameter |
| `@i-harness/sdk#SdkConnectionError` | `packages/sdk/src/client.ts` | `:46`, `:116`, `:120`, `:148`, `:153` — the class is constructed four times on the client's error paths |
| `@i-harness/session-persistence#TOOL_ABORTED_RECOVERY_RESULT` | `packages/session-persistence/src/repair.ts` | `:122` `output: TOOL_ABORTED_RECOVERY_RESULT` |
| `@i-harness/settings#SettingsStatusLineSegment` | `packages/settings/src/index.ts` | `:207`, `:421`, `:423`, `:426` |
| `@i-harness/settings#LayeredSettingsStore` | `packages/settings/src/index.ts` | `:1299-1300` `createLayeredStore` returns `new LayeredSettingsStore(options)` |
| `@i-harness/skills#MAX_SKILL_DEPTH` | `packages/skills/src/registry.ts` | `:148` `if (depth + 1 > MAX_SKILL_DEPTH) continue` |
| `@i-harness/skills#SkillGetArgs` | `packages/skills/src/tool.ts` | `:137` `Tool<SkillGetArgs, SkillGetOutput>`, `:154` `execute: async (args: SkillGetArgs)` |
| `@i-harness/telemetry#TELEMETRY_MANIFEST` | `packages/telemetry/src/manifest.ts` | `:39` `TELEMETRY_EVENT_TYPES = TELEMETRY_MANIFEST.map((row) => row.code)` |
| `@i-harness/todo#validateTodoItems` | `packages/todo/src/index.ts` | `:55` `validateTodoItems(todos, deps.allowParallelInProgress ?? false)` |
| `@i-harness/tui#CancelTurnBindOptions` | `packages/tui/src/app/overlay-seam.ts` | `:444` `opts: CancelTurnBindOptions = {}` |
| `@i-harness/tui#PermissionKey` | `packages/tui/src/views/permission.ts` | `:68` `permissionKeys(ev: KeyLike): PermissionKey \| undefined` |
| `@i-harness/tui#ComposeRegionOptions` | `packages/tui/src/minimal/live-region.ts` | `:41` `opts: ComposeRegionOptions = {}` |
| `@i-harness/tui#editorBackspace` | `packages/tui/src/views/provider.ts` | `:655` `backspace: () => editorBackspace(state)` |
| `@i-harness/tui#NEW_SESSIONS_LABEL` | `packages/tui/src/views/settings.ts` | 10 references at `:160-190`, `:331` |
| `@i-harness/tui-core#TtyStream` | `packages/tui-core/src/index.ts` | `:98` `stdin: TtyStream` |

The single bucket-A row: **`@i-harness/plugin-registry#readMcpServers`** — declared
`packages/plugin-registry/src/install.ts:140`, exported from the entry at `index.ts:92`, and its only
remaining references are two comments (`install.ts:18`, `:153`) and a test import. Its documented
consumer, `PluginRegistry.runtimeInputs()`, calls the **synchronous** sibling
`readMcpServersSync` (`index.ts:463`). A genuinely dead sibling — the async variant was left behind
when the sync one landed.

**Classes 2–5: 12 of 12 are genuine.** `plan-mode`/`guardian`/`vim-mode` have zero exact
`.push("<name>")` sites in 360 production files; all 8 settings keys have no production reader under
the scanner's own test and, for the six checked by hand, none under any looser reading either (the
leaf words that do occur — `language`, `bash` — are unrelated locals and the shell tool name, §3.3);
`retry/start` has no producer.

### 5.3 The method limitation this baseline inherits: **the plan's snippets do not produce it**

**The plan's five Step-3 code snippets were each rewritten against this repo before they produced this
baseline, and none of the five produces it as written.** The first edition of this section put that as
"all five were broken and four returned zero findings"; that sentence measured three of the five and
asserted the rest, so it is replaced here by what the claim actually rests on — **measured** for the
class-4 and class-5 anchors (0 of the 729 tracked files, an exact match count) and for class 5's drafted
string-only reader (**29** rows instead of **8**, re-run with that one predicate changed); **derived**
for class 3, whose drafted read test is applied by hand to the two usage strings this tree actually
contains rather than executed; **argued structurally** for class 2, whose anchor matches exactly one
file and therefore sweeps the wrong union, with what it would have emitted from that one file **not**
measured; and **not re-measured at all** for class 1, whose claimed row count is withdrawn. Each class
in turn:

("The plan" throughout this document is
`docs/superpowers/plans/2026-09-15-m1-reachability-sweep.md`; an identical draft copy sits at
`.superpowers/sdd/m1-plan-draft.md`.)

- the drafted **class-4** anchor `/(^|\/)(caps|capabilities)\.ts$/` matches **0** of the 729 tracked
  files (measured directly), so the drafted scanner reported nothing over a tree that holds three
  unpushed capabilities;
- the drafted **class-3** snippet (`docs/superpowers/plans/2026-09-15-m1-reachability-sweep.md:378-395`)
  decides a flag is read with a bare `\b<field>\b` test over the raw file text — line `:389` is
  ``return new RegExp(`\\b${field}\\b`).test(ln)`` — excluding only the `case "…"` line and
  `field:` / `field =` lines. For `--yes` the field is `yes`, and `\byes\b` matches inside the literal
  `"--yes"` in the two usage strings (`apps/tui/src/index.ts:9`, `:461`), neither of which is excluded
  — so `read` is `true` and the scanner reports **nothing** over a tree whose one real unread flag is
  `--yes` (derived from the drafted rule plus those two lines; the snippet was not executed here).
  Shipped instead: `codeOnly` blanks string literals and trailing comments before the field
  name is sought;
- the drafted **class-5** anchor `/(^|\/)(schema|settings-schema)\.ts$/` likewise matches **0** of the
  729 tracked files (measured directly). And class 5's reader, reduced to its drafted string-only
  form, returns **29** `unconsulted-setting` rows instead of **8** — **including `compaction.auto`,
  which is genuinely read at `apps/cli/src/index.ts:215` (`const compactAuto = noCompact ? false :
  settings.get().compaction.auto`)**. So the drafted reader would have **invented** a finding for the
  exact key the roadmap names as class 5's worked example. The 21-key difference is produced by the
  property test, which matches on the key's **leaf name only** — and the leaves here include very
  common identifiers. Stating the counting rule, because without it the figures do not reproduce:
  these are the class-5 scanner's **own** property regex `\.\s*<leaf>\b`
  (`scripts/audit/check-reachability.mjs:691`) applied over the 360 production files **excluding the
  file that declares the key** (`packages/settings/src/index.ts`), counted as occurrences / matching
  lines / distinct files — `mode` **151 / 140 / 28**, `model` **121 / 97 / 39**, `providers`
  **54 / 52 / 15**, `items` **53 / 48 / 17**. Genuine settings reads were confirmed by hand for **7** of the 21
  (`compaction.auto` at `apps/cli/src/index.ts:215`; `sandboxMode` at `apps/cli/src/index.ts:202` and
  `apps/cli/src/web.ts:470`; `tui.prefs.scrollSpeed` at `apps/tui/src/index.ts:708` and
  `packages/tui/src/views/settings.ts:502-504`; `tui.prefs.timestamps` at `views/settings.ts:108,156`;
  `tui.prefs.guardian` at `apps/tui/src/index.ts:781`; `tui.prefs.screenMode` at
  `apps/tui/src/index.ts:572,577,666`; `tui.prefs.dashboard.pinned` at `views/dashboard-state.ts:60`).
  For the rest — `tui.prefs.statusLine.mode`, `tui.prefs.statusLine.items`, `llm.providers`,
  `llm.defaultModel.provider`, `llm.defaultModel.model` — the suppression is **not** evidence of a
  read: `tui.prefs.statusLine.mode` in particular is cleared by any of the 151 unrelated `.mode`
  occurrences counted above, and the test cannot tell one of those from a genuine read.
- **class 2 fails by sweeping the wrong union**, which is a stronger and more specific failure than
  "returns zero". Its file anchor `/(^|\/)(events?|manifest|public-event-manifest)\.ts$/` matches
  exactly **one** file in the whole tree, `packages/telemetry/src/manifest.ts` (measured — the same
  match count §4.1 item 6 rests on), while the event union it was meant to sweep lives in
  `packages/core-session/src/index.ts:43`. So `sandbox/mode` — M1's headline unreachability, and the
  roadmap's own named class-2 example — can never be reported by it: the drafted rule is blind exactly
  where the milestone's worked example sits, and its silence there would have been a **structural**
  silence, not a clean result. Whether the drafted snippet would have emitted rows from the one file its
  anchor *does* match is **not** measured. Note that this is the same file whose union holds today's
  single class-2 row, `retry/start`, so the first edition's "class 2 would have reported nothing" was an
  inference, not a measurement.
- **class 1 was not re-measured here, and no row count for it is claimed.** The first edition's "only
  class 1 would have produced rows" was an assertion, and it is withdrawn. What *is* measured about the
  drafted class-1 rule is fixture-level rather than a count over the tree: the drafted scanner excluded
  the whole entry file (`f !== entry`) and required the package specifier and the name in the same file,
  and the `EntryCallSite` self-test case (`check-reachability.mjs:767-775`) fails under exactly that
  whole-entry exclusion, because the entry imports, re-exports and **calls** the name it re-exports. The
  real-tree row count of the drafted class-1 snippet is unknown and is not guessed at here.

**A verbatim implementation of the plan would not have produced this baseline, and on the classes that
could be checked it would have looked like a clean sweep.** This is recorded as a limitation of the
method, not buried: the baseline in §3 is **not the plan's output**. It is the output of five scanners
that were each rewritten against the real tree, and the only evidence they are detectors rather than
rubber stamps is the self-test plus the mutation proofs Tasks 2–4 recorded and the six that this
document's fix wave re-ran. The self-test is **18 cases** since that wave, and the count is not 18
independent checks: the wave added five **fixture elements**, which are what make five pre-existing
cases fail under their loosening, and five **named cases** that record each hazard and whose `run` and
`expect` are identical to the sibling case above them. Measured with the five added cases deleted: the
class-4 loosening still fails at **12/13**, the `TYPE_DECL_LINE` veto at **11/13**, and the class-5
quoted-key half, the class-5 DEFAULTS anchor and the class-3 `.`-before-the-read rule at **12/13**
each — every one of them on a pre-existing case
(`node scripts/audit/check-reachability.mjs --self-test` → `self-test: 18/18 ok`; mutation driver
transcript in `.superpowers/sdd/2026-09-15-m1-reachability-sweep/fixwave/mutation-run.txt`, gitignored
scratch, absent from a fresh checkout). M2 must not read a falling row count as progress unless it first
re-runs the self-test and checks the §2 digest.

---

## 6. The allowlist

Three parts: the `by-design` **findings** this document adjudicated and the two **adjacent D1 rows**
beside them, neither of which is a list item (§6.1); the `by-design` **source-list rows** (§6.2); and a
proposal that is **not** in force (§6.3). Because R13 forbids row-by-row adjudication of the 512 class-1
rows, **this allowlist is not exhaustive over them** — M2 inherits that obligation. Until it is
discharged, the ratchet must be seeded with the §2 digest and fail only on *new* rows, never on the
existing set.

### 6.1 `by-design` rows that are not source-list items (6)

The first four are scanner **findings**; the last two are the adjacent D1 §8 rows of §4.5 — not findings
at all, and not list items either, so they belong here rather than in §6.2.

| kind | subject | evidence | reason sentence |
|---|---|---|---|
| `producerless-event` | `retry/start` | `packages/telemetry/src/manifest.ts` | The telemetry manifest is the event **vocabulary**, not an emitter — `TELEMETRY_MANIFEST` is consumed at `packages/telemetry/src/manifest.ts:39` to build `TELEMETRY_EVENT_TYPES` — and the deferral is recorded in source at `packages/core-agent/src/index.ts:234,238` ("NOTE (retry/start deferral): M12 tool retry (guard-retry) and M20 … emits no `retry/start`"), so deleting the row would delete a vocabulary entry the M12/M20 retry work is specified against. |
| `unpushed-capability` | `plan-mode` | `packages/tui/src/app/slash/types.ts` | `packages/tui/src/app/loop.ts:2415-2418` states the three are NEVER supplied because the M49 backend has no live capability for them and the project refuses UI-state-only fakes, and their commands are gated invisible by `hasCapability` (`packages/tui/src/app/slash/impl/run.ts:49,57`) rather than faked — so nothing is broken and nothing is unreachable that advertises itself as reachable. |
| `unpushed-capability` | `guardian` | `packages/tui/src/app/slash/types.ts` | Same declaration and the same reason as `plan-mode` above: the guardian commands are gated by `hasCapability(ctx, "guardian")` at `packages/tui/src/app/slash/impl/approval.ts:27,35` and the loop never pushes it, deliberately. |
| `unpushed-capability` | `vim-mode` | `packages/tui/src/app/slash/types.ts` | Same declaration and the same reason as `plan-mode` above: the vim binding is gated by `hasCapability(ctx, "vim-mode")` at `packages/tui/src/app/slash/impl/text-input.ts:67` and the loop never pushes it, deliberately. |
| — (no row surfaced) | `guard-approval/src/remember.ts` | `packages/guard-approval/src/remember.ts` | **Kept and declared deliberately unwired** (human ruling, 2026-09-15) — an **input to the replacement frontend**, not a pending task, and not deletable without losing a rule the tree states nowhere else. The three structural reasons: (a) the TUI records that nothing ever registered it — `packages/tui/test/slash-registry.test.ts:42-46` lists `"remember"` in `NEVER_REGISTERED`, whose own comment reads *"zero registration hits — not even as hidden inventory"*; (b) the approval path has **no persistent-decision vocabulary** to hang a remembered decision on — `packages/interaction/src/index.ts:15-17` is boolean-only (`ApprovalDecision = { approved: boolean }`), and the only "once" vocabulary in the tree is ACP's `allow-once` admission (`packages/acp/src/index.ts:15,43`), a per-request posture rather than a stored rule; (c) the package entry publishes three sibling modules and never this one — `packages/guard-approval/src/index.ts:82-88` re-exports `./guardian/verdict.ts`, `./guardian/breaker.ts` and `./guardian/index.ts`, `remember.ts` is the only file under `src/` that entry never mentions (`danger-class.ts` is at least imported, at `:4`), and `package.json` exposes only `"."`. What the module carries is the tree's **only** statement of the rule that a shell or interpreter can never be remembered: `BANNED_PREFIX_PATTERNS` (`remember.ts:14-20`) covers `bash`, `sh`, `zsh`, `cmd`, `pwsh`, `powershell` and `node -e`/`bun -e`, is matched at `:48`, and refuses with *"shell/interpreters cannot be remembered (would approve everything)"* at `:51`. |
| — (no row surfaced) | `session-query` `closeSessionQueries` | `packages/session-query/src/index.ts` | **`by-design`: the lifetime it would end never outlives the process.** Each CLI entry point creates **at most one query per process** — `apps/cli/src/index.ts:307` (`run`), `:474` (`sdk`), `:644` (`acp`) — the code's own comment at `:304` says the index is a process-private `:memory:` index, and **no caller passes a `dbPath`** (`packages/session-query/src/file-backed.ts:238` defaults it to `:memory:`), so the process exit **is** the lifetime boundary and a close would have **no observable effect** on any shipped path. Two things this row must carry: the function is a **process-global destroyer** (`packages/session-query/src/index.ts:51-56` closes a module-level `Set` of connections plus the file-backed ones, so any caller reaching it closes every other caller's handles too), and the honest long-term fix is a **per-instance `close()`** — which adds a member to the published `SessionQuery` interface (`:43-46`) and is therefore **M**: a public-surface change with its own spec, not a wiring gap. |

### 6.2 `by-design` source-list rows (13)

| source | item | reason sentence |
|---|---|---|
| D1 §未竟事項 1 | `core-session` `migrate()` is a no-op | It is declared a placeholder in its own body — `packages/core-session/src/index.ts:686` "M1: only v1 exists; migrate-on-continue is a no-op placeholder for future versions" — and with `CURRENT_FORMAT_VERSION` at 1 there is no v0 to migrate; note for Phase B that it also has **zero call sites**, so the live choice is really "un-export or delete the seam" rather than "keep it". |
| D1 §未竟事項 2 | `goal` round admission unimplemented | `packages/goal/src/index.ts:9-10` says "no round admission (DSH's `roundsStarted` — explicitly out of scope)", and `:36-43` keeps `round?: number` as wire vocabulary precisely so that the UI/host contract does not break when admission lands; `packages/goal/test/goal.test.ts:37` pins it as `undefined`. |
| D1 §未竟事項 3 | `session-query` `SearchHit.time` is index time | The field's own doc comment declares the semantics and the reason — `packages/session-query/src/index.ts:13-17` "INDEX-REBUILD time (epoch ms), NOT the event's time. The JSONL log carries no per-event timestamp, so the file-backed index can only …" — so the value is documented as what it is rather than silently mislabelled. |
| D1 §未竟事項 5 | `workspace` defers `delete`/`insertBefore`/`follow`/`status` | `packages/workspace/src/index.ts:30-42` records the deferral as a controller ruling ("Deliberately DEFERRED (Task 3.1 controller ruling — seams noted in code, not implemented)") with a per-item reason, and each seam is anchored in the code rather than left implicit. |
| D1 §未竟事項 6 | `lsp` forces one server per run | `packages/lsp/src/scheduler.ts:20-24` declares it an explicit M18 non-goal and ships the refusal string "lsp: only one LSP server per run is supported (M18 core)", so the limit is announced rather than silent. |
| sandbox spec §7 item 3 | `allowed-once` consumed by a call that fails for an unrelated reason | The spec records this as "記錄而不修" (recorded, not fixed) with its reason — reordering the guard would change **which** refusal a granted-but-invalid call returns — and the ordering is deliberate in code: `packages/fs/src/index.ts:305` spends the grant before `:308`'s unrelated `old_string === ""` validation. |
| CLI surface 2 | unknown subcommands not rejected | `apps/cli/src/index.ts:142-144` documents the fall-through as the intended grok-style default — "a bare `i-harness` (or any non-subcommand first token) launches the TUI in the current folder" — so rejecting unknown subcommands would remove a documented behaviour; the accepted cost is that a mistyped subcommand opens the TUI instead of erroring. |
| D1 §跨包主線 8 item 7 / CLI surface 1 | `tui --yes` parsed but never read | **Deliberately out of scope — freeze/replacement.** The finding is real and unpatched: `flags.yes` is assigned at `apps/tui/src/index.ts:445` and read nowhere, while `--yes` is advertised in two usage strings (`:9`, `:461`). The code is `apps/tui`, the **TUI application** (not `packages/tui`), i.e. the frontend the roadmap's Q6 freeze covers (`2026-09-15-backend-polish-roadmap-design.md:278`), so fixing it would be investment in code being removed and Phase B must not be handed it. The gap is **not** retired with the code: the replacement frontend inherits the requirement that its flag surface must not advertise a flag nothing reads — if the replacement keeps a `--yes`, it must parse **and** read it, or drop the flag and its usage text. That obligation belongs to the replacement's requirements; this row records it rather than leaving it implicit. |
| D1 §跨包主線 8 item 4 | `mountPreset` declared and exported with no production caller | **Deliberately out of scope — freeze/replacement.** The finding is real: `packages/preset/src/index.ts:30` declares and exports it and no production file calls it — the only production mention outside the declaring module is a comment in `packages/tui/src/views/light-personas.ts:2` (§7 item 4). That file is `packages/tui`, one of the four frontend packages frozen and slated for replacement (Q6), so the only in-repo evidence of a consumer is code being removed, and whether this export is wanted cannot be decided against it. `packages/preset` itself stays in scope; what is deferred is the decision, and it moves to the replacement frontend: its persona/catalog surface either calls `mountPreset` (which clears the row) or the export is dropped as dead. |
| D1 §未竟事項 4 | `output-retention` spill pair — the unified factory never GC'd, and nothing ships a spill root (§4.2 item 4) | `by-design`, because all three parts of the Phase A characterisation were wrong: `createUnifiedSpillStore` (`packages/output-retention/src/spill-guard.ts:90-92`) is a three-line root-selecting factory that **never calls GC**; GC **is** wired at `spill-guard.ts:25` inside `createOutputSpillGuard`, which production mounts at `packages/session-executor/src/assembly.ts:524` whenever a host passes `outputSpill` (`assembly.ts:129`); and **no production host passes one**, so what ships is **no spill store at all** — the shell path's default retention is `opts.shellRetention ?? { maxBytes: 64_000 }` (`assembly.ts:400`), which carries no `spill` key (`packages/shell/src/index.ts:135` declares it, `:280` tests it), and nothing outside `test/` ever passes either option with a value (`apps/cli/src/run.ts:252,288` only forwards what its caller gave). The decision is the source's own, at `packages/output-retention/src/index.ts:170-171`: *"絕不寫 workspace——研究決策；**不清理（已知 limitation）**"*, and the guard, the GC it calls and the factory landed together in `c3875a9`. Follow-up: **none owed in code** — if a host ever supplies a spill root it gets exactly the GC wired at `:25`, so the honest future question is retention **policy** (age/size caps), not wiring. |
| sandbox spec §7 item 1 | shell runtime denial unclassified (`classifyDenial`) (§4.3 item 1) | `by-design` on the parked ruling at `docs/handoff/what-the-design-does-not-answer.md:71` — *"**Ruling: document, do not implement.**"* — and the reason is structural rather than a preference: a real OS denial inside a confined shell reaches the model as an ordinary non-zero exit plus raw stderr (`denialSignatures` is read in production only inside the test-only classifier, `packages/sandbox-local/src/runner-failures.ts:26`), and classifying it means carrying the answer out of the platform backend through the **`@i-harness/sandbox`** seam — where `runner-failures.ts:1-3` says the other classification helpers already live, while `classifyDenial` stayed behind — into `exec`'s `ExecResult` **and** then into the model-visible shell payload. That is new surface on two published shapes at once, i.e. an **M-shaped spec**; the follow-up is "write that spec", not "wire this function". |
| sandbox spec §7 item 2 | `exitCode: -1` is six-valued (§4.3 item 2) | `by-design` on **C10** (`docs/handoff/what-the-design-does-not-answer.md:49`), which records the **six** meanings and the mitigation that does hold — both sandbox refusals carry parseable JSON in `stderr`, and bash-absent is the only prose case — **and not, as this cell said until this correction, that the sentinel is "deliberate":** C10 rules nothing intentional, so "un-disambiguated" is what the source supports and "deliberate" is not — the `by-design` disposition is this document's adjudication on top of C10's record, not a quotation of it; the site list is corrected in §4.3 item 2, where `packages/shell/src/index.ts:372` turns out to be the **bash-absent** branch rather than a `kind: "refused"` refusal (that is `:217`, and its discriminator is internal — `:380` returns the bare refusal object), and `packages/exec/src/index.ts:210` (`child.on("error", …)`) was missing from the baseline entirely. Counting **meanings** rather than sites gives **at least eight**, because `exec/src/index.ts:148-150` documents a deliberate, indistinguishable `-1` for an external abort (the same value a signal death produces). Follow-up: the disambiguation is **M** for the same reason as `classifyDenial` — it widens a result type every surface consumes before it can change what the model is told. |
| CLI surface 3 | no `--flag=value` support (§4.4 item 3) | `by-design` — **deliberately unsupported**, because partial grammar is worse than none: the value-taking flags are read through **nine** in-scope sites before the frozen TUI's parser is even reached — five lookups on the `run` argv (`apps/cli/src/index.ts:208`, `:247-250`), a **second** pass over that same argv which re-derives which tokens are flags and which are values (`:331-335` — the duplication Task 3's fix had to reconcile), and `apps/cli/src/sessions.ts:53-54`, which is **seven**, **plus** `--session-dir` again on the `sdk` and `acp` paths (`:455`, `:625`), which makes **nine**. **Corrected here by re-measurement:** this cell said "seven" while enumerating all nine; the seven is the count *before* the two subcommand parsers, and the plan this number was inherited from (`docs/superpowers/plans/2026-09-15-m1-phase-b-wire-the-unwired.md:573`) stops at seven. The last parser in the chain is the frozen TUI's (`apps/tui/src/index.ts:441-456`), which is reached only after all nine. Demand is zero: no caller, test or argv in the tree uses the form, and no spec or report asks for it. **The obligation this declaration carries:** Task 3 made the form **fail loud** as an unknown flag, so `--model=x` can no longer be silently swallowed into the prompt. The related grammar narrowing is recorded as grammar in §4.4 item 3 — any `run` task token beginning with a dash is reserved and rejected with exit 1, and there is no `--` end-of-flags separator — and adding one is new argv grammar, i.e. the **M** follow-up. |

### 6.3 Proposed class-level rule — **not in force**, M2 must decide

**Status: a proposal. Nothing in this subsection is an allowlist entry today.** It is recorded so the
decision is made once, explicitly, rather than 17 times quietly.

**Proposed: `@i-harness/sdk`: 17 `unused-export` rows, all with evidence `packages/sdk/src/index.ts`.**
Reason sentence: the SDK package is the **embedder-facing public surface**, so its exports are
addressed to code outside this repository and "no in-repo production consumer" is the expected state
rather than an orphan — which is exactly the case roadmap §3.M1 names ("`sdk` 的公開 API 本來就不該有
內部呼叫者"). I did **not** adjudicate these 17 rows individually (R13). If M2 accepts the rule, the
allowlist becomes **4 + 17 = 21 findings**, alongside §6.1's **2** adjacent rows and §6.2's **13**
source-list rows — **36 entries** in all; if M2 rejects it, all 17 stay in the ratchet's baseline
population.

### 6.4 What is deliberately **not** on the allowlist

- **As of this document, the allowlist contains the 6 rows of §6.1 — 4 findings plus 2 adjacent D1 rows —
  and the 13 source-list rows of §6.2, i.e. 19 entries.** Everything else in the 525 is unadjudicated, or
  one of the rows still reported as `still-holds`: §3.3's eight `unconsulted-setting` keys, the
  `sandbox/mode` pair (§4.1 item 6 and §4.3 item 4), and §4.5's `registerUpgrade`. **Two of those three
  residuals have neither a task nor a reason sentence:** §3.3's eight `unconsulted-setting` keys and
  §4.5's `registerUpgrade` are simply open — this document names no work that would discharge them and
  nothing in the tree declares them deliberate — whereas the `sandbox/mode` pair carries both (the **M**
  follow-up and its out-of-scope blocker, §4.1 item 6). They are named here so that a reader does not
  read the absence of an allowlist entry as a decision about them.
- **§4.1 item 8 is `by-design` and deliberately carries no allowlist entry.** Task 5 discharged it by
  **narrowing the declarations** — dropping three `export` keywords (§8's bucket-B method) — not by
  granting an exception, so it needs no reason sentence here; the row's own cell carries it. The **15**
  `by-design` rows of §4 (**14** in the previous edition, which counted this row's move into
  `already-fixed` — §4's tally) are therefore 15 rows and 19 allowlist entries, not two figures for one
  thing: §4.1 item 8 is the one `by-design` row absent from this allowlist.
- **None of the 507 unadjudicated class-1 rows is allowlisted**, and the 17 `@i-harness/sdk` rows are
  among those 507 — §6.3 only *proposes* allowlisting them and is not in force (see its status line).
  Absence from this allowlist is not a claim that a row is a defect; it is a claim that nobody has
  looked yet.
- The **26 bucket-B rows of §5 are not allowlist candidates.** They are live symbols whose `export`
  keyword has no consumer; the fix is to narrow the declaration, not to grant an exception.
- The `plugins.*` / `language` / `fontSize` / `searchBackend` / `onboarding.welcomeNoticeVersion`
  settings are `still-holds`: none of them is declared deliberate anywhere in the tree, so none belongs
  in an allowlist. Three rows that stood beside them in the previous edition are **no longer
  `still-holds`**: `withdrawPlanModeTool` and `buildWireClient` were **not** declared deliberate either —
  they were dead declarations, and Task 4 deleted them (§4.1 items 3 and 5), while `createUnifiedSpillStore`
  moved into this allowlist (§4.2 item 4, §6.2) once its characterisation was measured. `--yes` and
  `mountPreset` are **not** in this list and are not `still-holds`: they are the two rows allowlisted in
  §6.2 as **deliberately out of scope** by the freeze/replacement decision (§4) — which is a scope
  judgement, not a claim that either is declared deliberate in the tree.

---

## 7. What this does not establish

Each item below is a measured limitation of **this baseline**, with the measurement that establishes
it.

**1. The tool is a heuristic.** Every class is a name/string test over file text: it proves that a
name is never mentioned on a production path, **never** that a mentioned one is wired correctly. Two
exact shapes it cannot tell apart: a symbol imported and immediately discarded, and a symbol
imported and called.

**2. It did not check reachability *within* a call graph.** There is no call graph anywhere in it. A
declaration whose only consumer is a function that is itself never called is reported as **used**.
That is why the three names of §4.1 item 8 are absent from the 525 while being unreachable from outside their package: they are called, inside a module nothing outside the package can reach.

**3. Named re-export statements mask genuinely dead exports — a false negative, safe direction.**
`export { X } from "./mod.ts"` makes `X` reachable from the barrel, and `originOf`
(`check-reachability.mjs:289-306`) attributes the name to its **declarer**, so the barrel is a
consumer and the chain terminates nowhere in particular. The re-export-blanking rule
(`withoutReExportStatements`, `:340-347`) applies only to the entry file currently being scanned, so
a re-export statement in **any other** production file counts as a mention and suppresses the
finding. **128** such statements were measured in Task 2, by the counting rule it states: *"statements
across package entry points [that] are named re-exports carrying a source specifier —
`export { X } from "./mod.ts"`"* (source: `.superpowers/sdd/2026-09-15-m1-reachability-sweep/task-2-report.md:390-392`
— a gitignored scratch artifact, absent from a fresh checkout).
Carried forward, not re-derived here. The counting rule was not re-measured in this task and the
figure has no published alternative under a second rule; my own two attempts over the 729-file
universe gave **130** (single-line `export { … } from "…"` *without* a `type` modifier, 33 files) and
**214** (the same allowing `export type { … }`, 36 files) — different rules, so not comparable, and
neither is offered as a correction.

**4. A name used only inside its declaring module is still reported, because telling a declaration
from a call inside one file needs real parsing.** Measured in §5.2: **26 of the 27 sampled class-1
rows (96 %)** are exactly this. It is the largest single source of untrustworthiness in the row
counts.

**5. Cross-package name collisions mask genuinely unused exports.** Measured instances:
`activeTokens` exists in both `packages/token-meter/src/breakdown.ts:13` and
`packages/compaction/src/tokens.ts:25`, so `@i-harness/compaction#activeTokens` — exported at
`packages/compaction/src/index.ts:11` and imported by **no** production file (the five
`from "@i-harness/compaction"` imports in the tree bring in `CompactionResult`, `CompactionRequest`,
`CompactionConfig`, `createCompactionEngine` and `approxTokens`) — is **not** reported, because
`packages/core-agent/src/index.ts:8` imports the token-meter symbol of the same name.
`AgentTaskStatus` is declared independently in `packages/subagent/src/projection.ts:26`,
`packages/sdk/src/protocol.ts:337` and `packages/tui/src/contracts.ts:148`, so subagent's export of it
is not reported either. And `core-session`'s `migrate` (§4.2 item 1) is hidden by an unrelated
private `migrate` in `session-persistence`. **Any rule narrow enough to catch these reintroduces the
original defect**: the module-scoping that made the entry-point scan report a name the entry itself
imports, re-exports and calls (see the `EntryCallSite` fixture at `check-reachability.mjs:109-115` and
the comment that states its hazard at `:761-766` — **corrected here:** the previous edition pointed the
fixture at `:761-766`, which is where the hazard is stated, not where the fixture lives).

**6. Four symbols whose only in-repo mention is a comment stay unreported**, and comments cannot
simply be stripped. Each is listed with the module that **declares** it (so the export edge exists)
and the **comment** that masks it (the actual mechanism — a comment in a production file other than
the declaring module counts as a mention):

| symbol | declaring module | the comment that masks it |
|---|---|---|
| `@i-harness/settings#FieldSpec` | `packages/settings/src/sections.ts:30` | `packages/settings/src/index.ts:506` — `* values remains the section API's mutate (the protocol enum FieldSpec). */` |
| `@i-harness/subagent#TaskConcurrencyLimitError` | `packages/subagent/src/task-protocol.ts:67` | `packages/subagent/src/index.ts:62` — `// maxConcurrency 時 submit 以 TaskConcurrencyLimitError 失敗閉合（fail-closed）。` |
| `@i-harness/tui#SdkClientLike` | `packages/tui/src/backend/remote.ts:179` | `packages/tui/src/index.ts:54` — `// dep) + the BackendClient adapter (createRemoteBackend; SdkClientLike is the` |
| `@i-harness/workflow#WorkflowJobStore` | `packages/workflow/src/runner.ts:59` | `packages/workflow/src/index.ts:4` — `// WorkflowJobStore; createWorkflowExecutor exposes the ExecService-like job` |

Re-checked here: none of the four appears among the 525. The claim that each is mentioned outside its
declaring module **only** inside the comment above holds **literally for `FieldSpec` alone** — no
production file other than `packages/settings/src/sections.ts` mentions it except the comment at
`packages/settings/src/index.ts:506`. The other three carry a second out-of-module occurrence, which the
tool **blanks** rather than counts: each is re-exported by its own package entry
(`packages/subagent/src/index.ts:17`, `packages/tui/src/index.ts:64`,
`packages/workflow/src/index.ts:30`), and `withoutReExportStatements`
(`check-reachability.mjs:340-347`) blanks exactly those statements when it scans that entry — so for
those three the masking mention is the comment **plus** a re-export the tool deliberately discounts,
not the comment alone. All four are also **live inside their declaring module** — `FieldSpec` at
`packages/settings/src/sections.ts:40,46,50,127,136`; `TaskConcurrencyLimitError` thrown at
`packages/subagent/src/task-protocol.ts:190`; `SdkClientLike` implemented at
`packages/tui/src/backend/remote.ts:670` and used at `:661`, `:823`; and `WorkflowJobStore` returned at
`packages/workflow/src/runner.ts:68` and typed at `:178`, `:287` — which is the separate reason the
`export` edge has no consumer outside the module that declares it. Stripping comments is
unsafe because **69 files contain a string literal with `//`** — Task 2's counting rule: *"a quoted
run containing `//` on one line"*, over its 722-file universe (packages + apps, dot-directories
skipped) (source: `.superpowers/sdd/2026-09-15-m1-reachability-sweep/progress.md:224`, restated with
its rule and alternates at `:368`; both are gitignored scratch artifacts, absent from a fresh
checkout). Carried forward, not re-derived here. Under the two other rules
that same source measured, the figure is **74** (a URL-ish `://` literal) and **243** (any `//` after
a quote character) — so read 69 as "files where a naive comment strip is unsafe" only under the first
rule; under the widest it is ~3.5× larger. My own attempt over the 729-file universe with a
one-line-quoted-run rule gave **89**, which is again a different universe and a different regex, not
a correction.
**Two source-list items are hidden by this same mechanism**, measured here: `mountPreset` (§4.1 item
4) and `closeSessionQueries` (§4.5).

**7. Class 3's masking is name-based and file-wide, so "unreported" is not proof a flag is read.** A
single occurrence of the field name anywhere in a production file, in any position the two
declaration/assignment shapes do not blank, marks the flag read. `--yes` is *reported* and is
therefore strong evidence; the absence of other reports is not evidence of anything.

**8. Class 5's reader slack is now measured, and it cuts both ways.** With the property-read half of
the reader removed, the class returns **29** rows instead of **8** (§5.3) — so **21 of the 29
declared leaf key paths** are cleared by the property test, and the count of unconsulted settings
moves by a factor of 3.6 on that one predicate. But the property test matches the key's **leaf name
only**, so it is simultaneously too **loose**: `tui.prefs.statusLine.mode` is cleared by **any** `.mode`
property access elsewhere in production — and there are **151 of them, on 140 lines across 28 files** —
while `llm.defaultModel.model` is cleared by any of **121 `.model` occurrences, on 97 lines across 39
files**. (Rule, identical to §5.3: the scanner's own property regex `\.\s*<leaf>\b`
(`check-reachability.mjs:691`) over the 360 production files **excluding** `packages/settings/src/index.ts`,
the file that declares both keys; counts are occurrences, then matching lines, then distinct files.)
That this test cannot tell an unrelated access from a genuine read of the key is exactly the weakness:
the key is cleared by a `.mode` on a modal dialog or a `.model` in a provider list just as readily as
by a real read. Genuine settings reads
were confirmed for 7 of the 21 by hand (`compaction.auto`, `sandboxMode`, `tui.prefs.scrollSpeed`,
`tui.prefs.timestamps`, `tui.prefs.guardian`, `tui.prefs.screenMode`, `tui.prefs.dashboard.pinned`);
the remaining 14 are **not** established. So class 5's **8 is not a count of settings nobody reads**
either — it is "keys whose leaf name never appears after a dot in another production file". The bound
is a function of the reader on both sides, and the roadmap's plan to grow this class must fix the
reader before the number means anything.

**9. Items not on the four lists were not swept, and the 512 class-1 rows were not adjudicated
(R13).** The only rows decided item by item in this document are the 22 source-list rows (§4), the 4
adjacent D1 rows (§4.5) and the 13 non-`unused-export` rows (§3.3). Everything else in the 525 is
recorded, sampled (§5), and left for M2.

**10. `still-holds` is a claim about the current HEAD only** (`74f86d5a80528b61653a437658e4657e208fe59a`).
This repo's own audit trail records three shipped features that were declared, tested and never
wired, each found months later by a human reading code — the fs guard never consulting the sandbox
mode, the shipped hosts never passing `compact`, and the TUI composing no sandbox at all. Two of the
rows marked `already-fixed` in §4.1 are fixes from 2026-09-14, i.e. one day old at this SHA. Re-run
the tool; do not trust this document.

**11. This baseline is not the plan's output.** See §5.3: the plan's five Step-3 snippets were each
rewritten against the real tree, and what each half of that claim rests on — two measured anchor
failures, one measured reader, one structural wrong-union argument, and one class not re-measured at all
— is stated there rather than compressed into "all five were broken". The 525 rows come from five
rewritten scanners whose only warrant is the self-test (**18 cases** since M1's fix wave, five of which
share an assertion with a sibling; §5.3) and the mutation proofs Tasks 2–4 recorded. **M2 must check the
self-test and the §2 digest before it trusts any comparison against this baseline.**

---

**Items 12–15 are new in this edition.** Each was found by **re-measurement during Phase B**, and each is
recorded as a **named M2 requirement** rather than a defect in this baseline: the ratchet's scope is M2's,
and without them the rows they hide — and the siblings of those rows — regrow.

**12. Re-exporting through a package entry does not report the entry's re-exported names — it can
*add* rows, and the entry's own local `export { … }` list is unreportable entirely.** This is the
**local re-export blind spot**, and it is a second reason class 1's 510 is a **lower bound**.

- **The mechanism.** When the entry itself declares the name, `originOf`
  (`scripts/audit/check-reachability.mjs:289-306`) credits the entry as the origin, and the used-scan
  excludes origin modules (`:364`, `!origins.has(f.rel)`), so the entry is scanned through
  `withoutReExportStatements` (`:340-347`, called at `:361`) — a deliberate and correct rule
  (`EntryCallSite`, `:761-775`). The failure is at `:296-297`: for an `export { X }` entry with **no
  `from` clause**, `resolveModule` yields no target, so the code does `origins.add(file.rel)` — **the
  entry becomes its own origin**, and the module that actually declares `X` is never added to `origins`
  and therefore never excluded from the used-scan. The name then self-satisfies at `:364` (`prod.some(…,
  !origins.has(f.rel) && word.test(…))`): the file that
  declares it is scanned as an ordinary production file, finds its own declaration, and reports "used".
  **A name re-exported from an entry through a local `export { … }` list is unreportable by
  `scanUnusedExports`.**
- **Measured at `637cdd7`.** Of the **68** `packages/*/src/index.ts` entries, **6 carry a local
  `export { … }` list** (an export list with no `from` clause) — the entries of `tui-core`, `attachment`,
  `core-agent`, `fs-lock`, `sandbox-policy` and `session-persistence`. Those six lists name **39 distinct
  names**, and **all 39 are declared elsewhere** — in a sibling module the entry re-exports from — so
  **every one of the 39 is unreportable** by class 1. Counted by the module that **declares** the name:
  `tui-core` **31**, `fs-lock` **2**, `sandbox-policy` **2**, `session-persistence` **2**
  (`SessionWriteBehind`, `SessionWriteBehindOptions`, both from
  `packages/session-persistence/src/write-behind.ts`), `attachment` **1** (`ImageMediaType`, declared in
  `packages/core-session/src/index.ts`) and `core-agent` **1** (`ReasoningEffort`, declared in
  `packages/llm-seam/src/index.ts`). **31 + 2 + 2 + 2 + 1 + 1 = 39.** A working figure of 38 for this
  blind spot is a count under a slightly different attribution rule; this document's rule is stated
  above, and under it the number is 39 of 39.
- **The ask for M2.** Either **follow a local re-export through to the module that declares the name**
  — resolve `export { X }` against the entry's own imports and re-exports before falling back — or, at
  minimum, **refuse to credit the entry as its own origin** when it does not declare the name, so the
  declaring module is excluded from the used-scan and the row is emitted. This is a scanner change, not
  a code change, and it belongs to M2's ratchet scope.
- **Consequence for this document: 510 `unused-export` rows is a lower bound for a second reason.**
  §3.1 already records class 4's count as a lower bound; class 1 has a different one here, and the
  paragraph in §3.1 states only the first. 510 is a floor on the number of unused export edges in this
  tree, not the number.

**13. The entry-only blind spot has two shapes: a file under `packages/*/src/` that its entry never
mentions, and a name the entry reaches but does not export. Both are invisible to all five classes, and
re-exporting is *not* a remedy.** Class 1 walks only
`packages/*/src/index.ts` entries (`check-reachability.mjs:359`) and tests **the names those entries
export** (`:362`), so two kinds of row fall outside its population: (a) any **file** an entry never
mentions — and every name it declares — and (b) any **name** declared in a file the entry *does* reach
but not among the names that entry exports. Classes 2–5 are anchored on file-name patterns and
specific constructs, and none of them enumerates `packages/*/src/**/*.ts`, so neither shape is visible
anywhere. **Three instances are now known** — two of shape (a), one of shape (b) — one of them found
during Phase B:

| invisible file / name | why it is invisible |
|---|---|
| `packages/guard-approval/src/remember.ts` | **shape (a).** The package entry (`packages/guard-approval/src/index.ts`) never mentions it — not imported, not re-exported (§4.5, §6.1). It carries `BANNED_PREFIX_PATTERNS`, the tree's **only** statement that a shell or interpreter can never be "remembered" |
| `packages/sandbox-local/src/runner-failures.ts` | **shape (a).** The entry exports exactly `LocalSandboxConfig`, `createLocalSandbox`, `probeBwrap` and never mentions this file, so `classifyDenial` (§4.3 item 1) has no row |
| `closeFileBackedConnections` (`packages/session-query/src/file-backed.ts:91`) | **shape (b), not (a).** `file-backed.ts` **is** reachable — the entry imports it at `packages/session-query/src/index.ts:7` and re-exports four of its names at `:246` — so a file-level class of the shape (a) ask would report nothing here. What is invisible is the **name**: it is not exported from the package entry at all, and class 1 tests only the names the entry exports, so the `export` edge at `file-backed.ts:91` is never a candidate. Its only caller is `packages/session-query/src/index.ts:55`, inside the package. **Citation corrected here:** the previous edition wrote `:89`, which is the last line of the comment block above the declaration; `:91` is `export function closeFileBackedConnections(): void {` — the coordinate the brief carried was right (see §4.5 row 2, where the false "correction" to `:89` is recorded). Found during Phase B while working §4.5 row 2; a **sibling of a row that *is* recorded**, which is the shape M2 should expect to keep finding |

- **The ask for M2 — two parts, because there are two shapes.** **(a)** A scanner class that enumerates
  `packages/*/src/**/*.ts` and reports every such **file** with **no inbound reference from either its
  entry or any other production file** — i.e. the file is reachable from nothing (`remember.ts`,
  `runner-failures.ts`). **(b)** The same enumeration applied to **names**: every declaration under
  `packages/*/src/` that is **not exported through its package entry** and has no reference outside its
  own declaring module — the shape `closeFileBackedConnections` has, and the one class 1 cannot see
  however reachable its file is, because class 1's population is the entry's *exported* names
  (`:362`). Part (b) is the load-bearing half for this milestone's own instance: a file-level rule alone
  would certify `file-backed.ts` as reachable and leave the name unreported. This is M2's, not a fix
  here: the rows and their siblings regrow without it, and each of the three instances above is a live
  symbol, not dead code.
- **Re-exporting is NOT a remedy — measured.** Re-exporting such a file's name through the package entry
  to "clear the row" makes the ratchet **worse**, not better. The `export { X } from "./file.ts"` line
  becomes a traversable export-list entry, so `originOf` (`check-reachability.mjs:294-299`) follows it
  through `resolveModule` (`:296`) and adds the **real declaring module** to `origins`. Because the
  used-scan excludes every origin module (`:364`, `!origins.has(f.rel)`), the declaring module is no
  longer scanned for the name — exactly the exclusion that makes class 1 correct when a name *is* a
  genuine export — so the name is now reported as an unused export **it is not**. Nothing about the code
  changed; the re-export manufactured the row. Probe through the real scanner: **1 finding without the
  re-export and 2 with it** for the probed pair. Re-measured in this task for the `classifyDenial` case
  (`packages/sandbox-local`): adding `export { classifyDenial } from "./runner-failures.ts"` to the
  package entry moves the total **523 → 524**, adding `@i-harness/sandbox-local#classifyDenial` and
  removing nothing. (The citation the probe runs through is `check-reachability.mjs:359-365` — the entry
  selection, the origin exclusion and the `findings.push` that all three halves of the mechanism live
  in.)
- Recorded so the remedy is not discovered twice: **fix the scanner, not the re-export.**

**14. No scanner class covers argument routing, so Task 3's defect class is invisible to the gate
forever.** The class is "a flag becomes a prompt": a value-taking or boolean token that a parser fails
to strip is passed through as task text. Nothing in the five classes looks at argv — class 3 asks
whether a *declared* flag is ever *read* (`flags.yes` assigned and never read, §3.2 item 2), which is a
different question from whether the router routes it correctly.
- **The structural reason is that the `run` path parses its argv twice.** `apps/cli/src/index.ts:170-223`
  reads values (`--sandbox` at `:208`, the settings load that follows), and `:331-335` **re-derives which
  tokens to strip** by filtering the known flags and their values out of the same argv before the
  remaining tokens become the task. Two passes over one argv is a drift surface by construction: adding a
  flag to the first pass and not the second is exactly how `--no-compact` became a prompt (Task 3,
  §4.4 item 4) and how `run --help` reached `runHeadless`.
- **Task 3's tests are the only protection.** `apps/cli/test/run-flag-routing.test.ts` pins the guard
  and the value-skip clause; nothing in the baseline's five classes would have caught the defect or
  would catch its reintroduction.
- **The shape that cannot drift again** — named as the direction, **not required**: a **single
  declarative flag table** (one entry per flag: name, takes-value, …) that both the value-reading pass
  and the token-stripping pass consume, so there is one place to add a flag and no second list to forget.
  M2 should hold the tests until that exists.
- This is why §3's row count is not a defect count for this class: **the gate would report zero rows for
  a router that sends every flag into the prompt.**

**15. The cross-package collision false negative has a *worked* instance, not just a structural
limit — and a comment written to *explain* code can hide a finding about it.** §7 item 5 records the
collision mechanism in the abstract (`activeTokens`, `AgentTaskStatus`, `migrate`); this is it
happening during Phase B, measured.
- **The instance.** During Task 4 a **comment** that named `CreateProviderRuntimeOptions` suppressed
  that package's **own** row: the expected count of **523** came back **522**, and the missing row was
  `@i-harness/provider-runtime#CreateProviderRuntimeOptions`. The comment mentioned the name in a
  production file other than the declaring module, which is enough for the used-scan (`:364`'s word test
  over `f.text`); the row disappeared without any code changing.
- **The general hazard, stated for M2.** A comment written to **explain** code — a contract note, a
  "why this exists" paragraph, a cross-reference — can hide a finding about the thing it explains. The
  suppression is not a property of dead code or of the comment's intent; it is a property of the name
  appearing in a production file. §7 item 6 records four symbols hidden this way and §4.5 two more;
  this instance is the one where the masking comment was **added during the milestone**, and it is why
  a falling row count must never be read as progress without the §2 digest and the self-test (§5.3).

---

## 8. A warning about this milestone's own plan text

**Do not cite the Phase B plan's Step 2/Step 3 as the shipped method.** The plan at
`docs/superpowers/plans/2026-09-15-m1-phase-b-wire-the-unwired.md:434-435` prescribes the **un-export
method** — drop the `export` keyword at `packages/provider/src/index.ts:762` and
`packages/plan-mode/src/index.ts:36` — and its brief repeats it at `:3` and `:23-24`.

**Task 4 found that method unsatisfiable for bucket-A rows, and the controller superseded it.** A
bucket-A row is a **dead** declaration: nothing references it, inside its module or out (§5.2's bucket
definition). Dropping only the `export` keyword leaves the declaration referenced by nothing at all,
which is a **`TS6133` unused-declaration error** under this repo's compiler settings — `noUnusedLocals`
is `true` at `tsconfig.base.json:9` — so the "fix" does not typecheck. For a bucket-A row the only
satisfiable remediation is **deletion**, which is what shipped: `c5652c7` un-exported both names,
`24e9395` then deleted the declarations and the case that called `buildWireClient` (§4.1 items 3 and 5).

So a later reader has two different dispositions to keep apart, and the plan text records only the first:

| row shape | the method that ships | example |
|---|---|---|
| **bucket A** — nothing references the name anywhere | **delete the declaration** (un-exporting alone is `TS6133`) | `buildWireClient`, `withdrawPlanModeTool` — Task 4, §4.1 items 3 and 5 |
| **bucket B** — referenced in **code inside its declaring module** | **drop the `export` keyword**, keep the declaration | the three names of §4.1 item 8 — Task 5 |

**The un-export method is still correct for bucket B, and only for bucket B.** §5.2 measured that 26 of
the 27 sampled class-1 rows are bucket B, which is why "drop the `export` keyword" is the right
remediation for most class-1 rows (§5.2) *and* why it would silently fail to typecheck on the bucket-A
minority. A future fix wave that reads the plan's Step 2/3 and applies it row-by-row will hit a red
typecheck on every bucket-A row it touches; the plan's own text was never updated to say so, and this
section is the correction of record.
