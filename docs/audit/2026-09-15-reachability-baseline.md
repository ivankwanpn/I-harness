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

| Item | Value |
|---|---|
| node | `v22.23.2` |
| pnpm | `11.7.0` |
| branch | `m64` |
| HEAD | `74f86d5a80528b61653a437658e4657e208fe59a` |
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

---

## 3. The finding table

### 3.1 The 525 rows, grouped by class

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

### 3.4 The 512 `unused-export` rows — recorded, not adjudicated (ruling R13)

The plan's Step 2 says "adjudicate **every** finding". **Ruling R13 overrides that**: the roadmap's
§3.M1 completion criterion never required it — it requires that each item which still holds be either
wired up or explicitly declared deliberate, and those items are the **four source lists** of §4,
which are 22 rows. At 525 rows a row-by-row adjudication is not a workflow anyone should perform and
would not be a measurement. So the 512 class-1 rows are recorded here as the raw baseline for M2's
ratchet, and §5 samples 39 rows to characterise them.

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

**Tally: `already-fixed` 2 · `still-holds` 10 · `by-design` 10.**

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
verdicts moved from `still-holds` to `by-design`. The remaining 10 `still-holds` rows are in-scope work
as written — their evidence is `packages/*` or `apps/cli` code, and none is a TUI-only gap (§4.3 item 2
does list one `packages/tui` site among its six, and §4.4 item 3 names both parsers, but neither row is
about TUI code alone).

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
| 3 | `buildWireClient` | yes — `unused-export @i-harness/provider#buildWireClient` | the name occurs in exactly **2** files: its declaration (`packages/provider/src/index.ts:762`) and `packages/provider/test/provider.test.ts` | **`still-holds`** |
| 4 | `mountPreset` | **no** | the name occurs in 3 files: declaration `packages/preset/src/index.ts:30`, a **comment** `packages/tui/src/views/light-personas.ts:2` (`// persona catalog (verified: @i-harness/preset exports parsePreset/mountPreset`), and `packages/preset/test/preset.test.ts`. It has **no production caller**. It did not surface because the comment in an unrelated production file counts as a mention — see §7 item 4. The file holding that comment is `packages/tui` — the TUI, frozen and slated for replacement (§4, scope decision) — so the row is allowlisted as deliberately out of scope instead of kept as Phase B work | **`by-design`** — allowlist §6.2, deliberately out of scope; the replacement frontend carries the decision |
| 5 | `withdrawPlanModeTool` | yes — `unused-export @i-harness/plan-mode#withdrawPlanModeTool` | the name occurs in exactly **1** file in the entire tree: `packages/plan-mode/src/index.ts:36` | **`still-holds`** |
| 6 | `sandbox/mode` has no producer | **no** | the quoted literal `"sandbox/mode"` occurs on **19** lines of the walked tree: **17 in `test/` files** and **2 in production code** — the event-type declaration (`packages/core-session/src/index.ts:43`) and the **reader** (`packages/sandbox-policy/src/session-mode.ts:9`) — with **0** in production comments. 14 of the 17 test lines are `append(…)` calls, and **0** production files append the event. It did not surface because class 2 is anchored on the declaring file's **name** (`/(^\|\/)(events?\|manifest\|public-event-manifest)\.ts$/`), which matches exactly **one** file in this repo — `packages/telemetry/src/manifest.ts` — while this union lives in `packages/core-session/src/index.ts` | **`still-holds`** |
| 7 | `tui --yes` | yes — `unread-flag --yes` | see §3.2 item 2: `flags.yes` is assigned at `apps/tui/src/index.ts:445` and read nowhere; `--yes` is additionally advertised in two usage strings (`:9`, `:461`). The finding is real; `apps/tui` is the TUI, frozen and slated for replacement (§4, scope decision — note this is `apps/tui`, not `packages/tui`), so it is allowlisted as deliberately out of scope | **`by-design`** — allowlist §6.2, deliberately out of scope |
| 8 | `estimateAssemblyOverhead` / `bindAuthRefreshStatus` | **no** | both are declared and **used inside their own module**: `packages/session-executor/src/assembly.ts:220` + call at `:762`, and `:234` + call at `:618`. `packages/session-executor/src/index.ts` is 22 lines and re-exports **exactly 14 names**, none of them these two — in full: `createSessionAssembly`, `ModelUnavailableError`, `AssemblyOptions`, `ModelPolicy`, `SessionAssembly` (all from `./assembly.ts`), `createDurableSessionLoader` (from `./durable-session.ts`), `createSessionService`, `SessionModelBindingResult`, `SessionQueueItem`, `SessionService`, `SessionServiceOptions` (from `./service.ts`), `AgentTaskStatus`, `AgentTaskView` (from `@i-harness/subagent`), `ReasoningEffort` (from `@i-harness/core-agent`). The only importer of the two is `packages/session-executor/test/assembly.test.ts:19-24`, which reaches them through the relative path `../src/assembly.ts`, i.e. **not** through the package entry. So D1's claim (exported from `assembly.ts`, not re-exported by `index.ts`, `package.json` exposes only `"."` → unreachable outside the package) **still holds as written**. It did not surface because class 1 walks only `packages/*/src/index.ts` entries and reports the names **that entry exports** — these two are not among them, so there is nothing for the scanner to test. Half the sentence that introduced them in D1 ("no production caller") is however no longer true — both are called on a production path inside `assembly.ts`, so the residue is a re-export decision, not a wiring gap | **`still-holds`** |

### 4.2 D1 §未竟事項

| # | Item | Surfaced? | Measured evidence | Verdict |
|---|---|---|---|---|
| 1 | `core-session` `migrate()` is a no-op | **no** | `packages/core-session/src/index.ts:682-687`: the body returns `session` unchanged when `targetVersion === CURRENT_FORMAT_VERSION` and throws otherwise, and `:686` says in-source *"M1: only v1 exists; migrate-on-continue is a no-op placeholder for future versions"*. It has **zero call sites** in the tree; the only other `migrate` identifier is an unrelated private function in `packages/session-persistence/src/index.ts:360`, called at `:468` and `:515`. It did not surface because **that same-named unrelated function in another package counts as a mention and suppresses the finding** — the cross-package collision of §7 item 3 | **`by-design`** — see allowlist §6 |
| 2 | `goal` round admission unimplemented | **no** | `packages/goal/src/index.ts:9-10` says in-source: *"no round admission (DSH's `roundsStarted` — explicitly out of scope; the `round` view field is a …)"*, and `:36-43` declares `round?: number` as wire vocabulary so the UI/host contract does not break when round admission lands. `packages/goal/test/goal.test.ts:37` asserts `(view as GoalView).round` is `undefined`. It did not surface because `round` is an optional interface *field*, and no scanner class covers a field | **`by-design`** — allowlist §6 |
| 3 | `session-query` `SearchHit.time` is index time | **no** | `packages/session-query/src/index.ts:13-17` — the field's own doc comment says *"M51 B4: INDEX-REBUILD time (epoch ms), NOT the event's time. The JSONL log carries no per-event timestamp, so the file-backed index can only …"*. `SearchHit` **is** on a production path: imported at `packages/session-query/src/file-backed.ts:12` and used at `:469`, `packages/session-query/src/index.ts:44,150`. Correctly not a finding | **`by-design`** — allowlist §6 |
| 4 | `output-retention` bare `createSpillStore` never cleans up | **partly** | `packages/output-retention/src/index.ts:170-172` self-labels it: *"完整原文落檔（0700 per-process temp root，絕不寫 workspace——研究決策；**不清理（已知 limitation）**）"*. `createSpillStore` itself is **not** a finding — it is called on a production path at `packages/shell/src/index.ts:280` and `packages/output-retention/src/spill-guard.ts:22,91`, so bare, uncleaned stores are what ships. Its GC-wired sibling **is** a finding: `@i-harness/output-retention#createUnifiedSpillStore` (`spill-guard.ts:90`, re-exported by `index.ts:209`) has **no caller anywhere**, and `@i-harness/output-retention#gcSpillStore` is reported because its only call (`spill-guard.ts:25`) is inside its own declaring module. **The fix exists in-repo and is unwired** | **`still-holds`** |
| 5 | `workspace` defers `delete`/`insertBefore`/`follow`/`status` | **no** | `packages/workspace/src/index.ts:30-42` says in-source: *"Deliberately DEFERRED (Task 3.1 controller ruling — seams noted in code, not implemented)"* and gives a reason per item (`delete`: the host route is intentionally absent so it answers the generic JSON 404; `insertBefore`: reordering APIs are out of the minimal set; `follow`: the list routes already serve a full baseline; `status`: liveness tracking is deferred). It did not surface because a deferred API that is simply **absent declares nothing** — the scanner finds declarations without consumers, not consumers without declarations | **`by-design`** — allowlist §6 |
| 6 | `lsp` forces one server per run | **no** | `packages/lsp/src/scheduler.ts:20-24`: *"M18 core supports ONE LSP server per run: a second mount with a DIFFERENT … (M18 non-goal)"*, with the refusal string `"lsp: only one LSP server per run is supported (M18 core)"`. Not surfaced: a documented non-goal leaves nothing declared to find | **`by-design`** — allowlist §6 |

### 4.3 sandbox spec §7

The roadmap cites "the sandbox spec §7"; the residuals are `docs/superpowers/specs/2026-09-14-backend-permission-sandbox-design.md` §7, items 1–4 (added 2026-09-15).

| # | Item | Surfaced? | Measured evidence | Verdict |
|---|---|---|---|---|
| 1 | shell runtime denial unclassified (`classifyDenial`'s callers are only tests) | **no** | `classifyDenial` is declared at `packages/sandbox-local/src/runner-failures.ts:23` and its only importer is `packages/sandbox-local/test/local.test.ts:3`. The field it consumes, `denialSignatures`, **is** published in production (`packages/sandbox-local/src/index.ts:83`, `packages/sandbox-windows-acl/src/index.ts:647`) but is read in production only at `packages/sandbox-local/src/runner-failures.ts:26` — i.e. inside the test-only classifier. `packages/exec/src/index.ts:103` only mentions it in a comment. So a real OS denial inside a confined shell reaches the model as an ordinary non-zero exit plus raw stderr. Not surfaced because `runner-failures.ts` is not re-exported from `packages/sandbox-local/src/index.ts` (which exports exactly `LocalSandboxConfig`, `createLocalSandbox`, `probeBwrap`), and class 1 walks package entries only | **`still-holds`** |
| 2 | `exitCode: -1` is six-valued | **no** | measured `-1` synthesis sites: `packages/shell/src/index.ts:217` (ladder refusal), `:268` (sandbox-unavailable refusal), `:372` (shell refusal with `kind: "refused"`), `packages/exec/src/index.ts:209` (`child.on("close", (code) => doneFn(code ?? -1))` — so any signal death or Windows force-kill is also `-1`), `packages/workflow/src/runner.ts:222` (synthesised for a **thrown** error), plus `packages/tui/src/app/slash/impl/workflow2.ts:220` with the same `code ?? -1` shape. No scanner class covers a numeric sentinel | **`still-holds`** |
| 3 | `allowed-once` consumed by a call that fails for an unrelated reason | **no** | verified in code: `packages/fs/src/index.ts:305` runs the escalation ladder (`resolveWriteCall`, which is where the one-shot grant is asked for and consumed) and only **then**, at `:308`, does `if (old_string === "") throw new FsToolError("FS_AMBIGUOUS_EDIT", …)`. `apply_patch` is the same shape: the ladder at `:381`, `applyPatch` at `:384` with per-hunk `guardWrite`. So a granted widening is spent on a call that fails validation the widening could not have helped. Not surfaced: no scanner class covers call ordering. The spec itself says of this item *"記錄而不修"* and gives the reason — see allowlist §6 | **`by-design`** — allowlist §6 |
| 4 | the `sandbox/mode` scenario has no producer | **no** | identical to §4.1 item 6 — same measurement, one row, cross-referenced rather than re-derived. The non-surfacing reason is the same: the event union is declared in `packages/core-session/src/index.ts:43`, which class 2's file-name anchor does not match (it matches exactly one file, `packages/telemetry/src/manifest.ts`). Note the disagreement recorded in §6: the spec calls this *"a reachability statement, not a defect"*, while roadmap §3.M1 makes it M1's headline case | **`still-holds`** |

### 4.4 CLI surface

| # | Item | Surfaced? | Measured evidence | Verdict |
|---|---|---|---|---|
| 1 | `tui --yes` parsed but never read | yes — `unread-flag --yes` | identical to §4.1 item 7 — cross-referenced, not re-derived. Verdict follows it: `apps/tui` is frozen and slated for replacement (§4, scope decision), so deliberately out of scope | **`by-design`** — allowlist §6.2 |
| 2 | unknown subcommands not rejected | **no** | `apps/cli/src/index.ts` dispatches by exact equality on `args[0]`: `web` `:102`, `sdk` `:129`, `sessions` `:134`, `acp` `:139`, `tui` `:145`, `__dist-selfcheck` `:153`, `--version`/`-v` `:156`, `help`/`--help`/`-h` `:160`; then `:164` `if (args[0] !== "run") return Promise.resolve(runTui(parseFlags(args)))` at `:167`. So `i-harness --sandbox x run t` — and any typo — launches the TUI. Not surfaced: no scanner class covers a dispatch chain. The fall-through is documented as deliberate at `:142-144` (*"the GROK-STYLE DEFAULT — a bare `i-harness` (**or any non-subcommand first token**) launches the TUI"*) | **`by-design`** — allowlist §6 |
| 3 | no `--flag=value` support | **no** | across the whole tree: `apps/` contains **zero** occurrences of `split("=")`, `indexOf("=")` or `startsWith("--")`; `packages/` contains exactly one `startsWith("--")` — `packages/guard-approval/src/danger-class.ts:87`, a shell-flag classifier, not a parser. Both parsers match whole tokens (`apps/tui/src/index.ts:441-456` `switch (argv[i])`; `apps/cli/src/index.ts:181,305` `args.indexOf("--sandbox")` / `a === "--model"`). Not surfaced: no scanner class covers argument *syntax*; all five look for declarations, not for shapes a parser fails to accept | **`still-holds`** |
| 4 | `i-harness run --help` runs a task named `"--help"` | **no** | `apps/cli/src/index.ts:160` catches `--help` only as `args[0]`, so `run --help` passes it; the task is then built at `:304-309` by filtering out exactly seven flags (`--model`, `--api-key`, `--yes`, `--session-dir`, `--resume`, `--telemetry`, `--sandbox`) and their values, so the literal `"--help"` survives into `task`, is non-empty at `:310`, and reaches `runHeadless` at `:333`. Not surfaced: no scanner class covers argument routing | **`still-holds`** |

### 4.5 Adjacent rows from the same D1 sections (recorded, not list items)

Not part of the four lists as the roadmap copies them, but they sit in the same D1 sentences and were
cheap to measure. Recorded so Phase B does not have to rediscover them.

| Item (D1 location) | Surfaced? | Measured evidence | Verdict |
|---|---|---|---|
| `session-persistence` `registerUpgrade` has no registration point (D1 §未竟事項 bullet 4) | yes — `unused-export @i-harness/session-persistence#registerUpgrade` | the name occurs in exactly 2 files: its declaration + comment (`packages/session-persistence/src/index.ts:151,153`) and `packages/session-persistence/test/persistence.test.ts:74`. No production caller | `still-holds` |
| `session-query` `closeSessionQueries` (and the legacy opener) has no production caller (D1 §8) | **no** | the name occurs in exactly 3 files: `packages/session-query/src/index.ts:49` (comment) + `:52` (declaration), `packages/session-query/src/file-backed.ts:88` (**comment**), and four `test/` files. It has **no production caller** and did not surface because of the comment-masking mechanism of §7 item 4 — the same mechanism as `mountPreset` | `still-holds` |
| `guard-approval/src/remember.ts` is not re-exported and has no importer (D1 §8) | **no** | not a finding: `packages/guard-approval/src/index.ts` does not export it, and class 1 walks package entries only. This is the same structural blind spot as §4.3 item 1 | `still-holds` |
| `sandbox-local/src/runner-failures.ts` is not re-exported, and `exec` never scans `ConfinedArgv.denialSignatures` (D1 §8) | no | the same measurement as §4.3 item 1; one row, not two | `still-holds` |

---

## 5. The precision sample

### 5.1 How the sample was drawn

**Frame**: the 525 findings minus the 6 rows adjudicated in §4 = **519**
(the 5 source-list `unused-export` rows `@i-harness/provider#buildWireClient`,
`@i-harness/plan-mode#withdrawPlanModeTool`,
`@i-harness/output-retention#createUnifiedSpillStore`,
`@i-harness/output-retention#gcSpillStore`,
`@i-harness/session-persistence#registerUpgrade`, plus the `unread-flag --yes` row).

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

Two parts: the `by-design` **findings** this document adjudicated, and the `by-design` **source-list
rows**. Because R13 forbids row-by-row adjudication of the 512 class-1 rows, **this allowlist is not
exhaustive over them** — M2 inherits that obligation. Until it is discharged, the ratchet must be
seeded with the §2 digest and fail only on *new* rows, never on the existing set.

### 6.1 `by-design` findings that are not source-list rows (4)

| kind | subject | evidence | reason sentence |
|---|---|---|---|
| `producerless-event` | `retry/start` | `packages/telemetry/src/manifest.ts` | The telemetry manifest is the event **vocabulary**, not an emitter — `TELEMETRY_MANIFEST` is consumed at `packages/telemetry/src/manifest.ts:39` to build `TELEMETRY_EVENT_TYPES` — and the deferral is recorded in source at `packages/core-agent/src/index.ts:234,238` ("NOTE (retry/start deferral): M12 tool retry (guard-retry) and M20 … emits no `retry/start`"), so deleting the row would delete a vocabulary entry the M12/M20 retry work is specified against. |
| `unpushed-capability` | `plan-mode` | `packages/tui/src/app/slash/types.ts` | `packages/tui/src/app/loop.ts:2415-2418` states the three are NEVER supplied because the M49 backend has no live capability for them and the project refuses UI-state-only fakes, and their commands are gated invisible by `hasCapability` (`packages/tui/src/app/slash/impl/run.ts:49,57`) rather than faked — so nothing is broken and nothing is unreachable that advertises itself as reachable. |
| `unpushed-capability` | `guardian` | `packages/tui/src/app/slash/types.ts` | Same declaration and the same reason as `plan-mode` above: the guardian commands are gated by `hasCapability(ctx, "guardian")` at `packages/tui/src/app/slash/impl/approval.ts:27,35` and the loop never pushes it, deliberately. |
| `unpushed-capability` | `vim-mode` | `packages/tui/src/app/slash/types.ts` | Same declaration and the same reason as `plan-mode` above: the vim binding is gated by `hasCapability(ctx, "vim-mode")` at `packages/tui/src/app/slash/impl/text-input.ts:67` and the loop never pushes it, deliberately. |

### 6.2 `by-design` source-list rows (9)

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

### 6.3 Proposed class-level rule — **not in force**, M2 must decide

**Status: a proposal. Nothing in this subsection is an allowlist entry today.** It is recorded so the
decision is made once, explicitly, rather than 17 times quietly.

**Proposed: `@i-harness/sdk`: 17 `unused-export` rows, all with evidence `packages/sdk/src/index.ts`.**
Reason sentence: the SDK package is the **embedder-facing public surface**, so its exports are
addressed to code outside this repository and "no in-repo production consumer" is the expected state
rather than an orphan — which is exactly the case roadmap §3.M1 names ("`sdk` 的公開 API 本來就不該有
內部呼叫者"). I did **not** adjudicate these 17 rows individually (R13). If M2 accepts the rule, the
allowlist becomes 4 + 17 = 21 findings plus the 9 source-list rows; if M2 rejects it, all 17 stay in
the ratchet's baseline population.

### 6.4 What is deliberately **not** on the allowlist

- **As of this document, the allowlist contains only the 4 findings in §6.1 and the 9 source-list rows
  in §6.2.** Everything else in the 525 is unadjudicated or reported as `still-holds`.
- **None of the 507 unadjudicated class-1 rows is allowlisted**, and the 17 `@i-harness/sdk` rows are
  among those 507 — §6.3 only *proposes* allowlisting them and is not in force (see its status line).
  Absence from this allowlist is not a claim that a row is a defect; it is a claim that nobody has
  looked yet.
- The **26 bucket-B rows of §5 are not allowlist candidates.** They are live symbols whose `export`
  keyword has no consumer; the fix is to narrow the declaration, not to grant an exception.
- The `plugins.*` / `language` / `fontSize` / `searchBackend` / `onboarding.welcomeNoticeVersion`
  settings, and `withdrawPlanModeTool` / `buildWireClient` / `createUnifiedSpillStore` are `still-holds`:
  none of them is declared deliberate anywhere in the tree, so none belongs in an allowlist. `--yes` and
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
That is why `estimateAssemblyOverhead` / `bindAuthRefreshStatus` (§4.1 item 8) are absent from the
525 while being unreachable from outside their package: they are called, inside a module nothing
outside the package can reach.

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
imports, re-exports and calls (see the `EntryCallSite` self-test case, `check-reachability.mjs:767-775`).

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
