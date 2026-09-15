# The reachability baseline — 2026-09-15

Milestone **M1 Phase A ("the reachability sweep")**, Task 5 of 5. Branch `m64`. Produced by
`scripts/audit/check-reachability.mjs` (Tasks 1–4). This task changed **no code**: the only file it
creates is this one. Phase A measures; Phase B fixes.

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
| self-test | `self-test: 13/13 ok` (exit 0) |
| baseline digest | `sha256 = da57ae75d53e20c6e73e37da4d5cda68ed084c85fb046d5f877699a2d082e728` |

Commands, run from `D:\I-harness-main`:

```powershell
node scripts/audit/check-reachability.mjs
# reachability: 729 ts files, 525 finding(s)

node scripts/audit/check-reachability.mjs --self-test
# self-test: 13/13 ok          (exit 0)

node --version                 # v22.23.2
pnpm --version                 # 11.7.0
git rev-parse HEAD             # 74f86d5a80528b61653a437658e4657e208fe59a
git ls-files "*.ts" "*.tsx"    # 729 lines
```

The digest is `sha256` over the 525 findings rendered as sorted `kind<TAB>subject<TAB>evidence`
lines, each newline-terminated. It pins the baseline so M2 can verify that a later run is
reproducing *this* set rather than a set that merely has the same size.

**The walked-vs-tracked equality is asserted here, not assumed.** Ruling R8: it is now a property of
the walker's skip list rather than of git, so it can drift. It holds today because the tracked set
contains nothing the skip list would drop — measured: of the 729 tracked files, **0** live under a
dot-directory at the root and **0** under `node_modules`/`dist`/`lib`, which are the walker's three
skip rules (`scripts/audit/check-reachability.mjs:794-807`, which also excludes `*.ts`/`*.tsx`
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
(`check-reachability.mjs:475-476`), and it **skips any such union where no member is ever pushed**
(`:519`) — because a union with no pushed member is not a push inventory at all (it is sniffed off
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
| `unread-flag` | `--yes` | `apps/tui/src/index.ts` | `still-holds` | source-list row; see §4.1 item 7 and §4.4 item 1 |
| `unpushed-capability` | `plan-mode` | `packages/tui/src/app/slash/types.ts` | `by-design` | allowlist §6 |
| `unpushed-capability` | `guardian` | `packages/tui/src/app/slash/types.ts` | `by-design` | allowlist §6 |
| `unpushed-capability` | `vim-mode` | `packages/tui/src/app/slash/types.ts` | `by-design` | allowlist §6 |
| `unconsulted-setting` | `language` | `packages/settings/src/index.ts` | `still-holds` | no production reader. The 6 files containing the bare word `language` declare unrelated locals (`packages/tui/src/render/highlight.ts:147` `const language = (lang ?? "")`, `packages/lsp/src/instance.ts:258` `languageId`); none is a settings read |
| `unconsulted-setting` | `fontSize` | `packages/settings/src/index.ts` | `still-holds` | the name occurs in **no** production file other than the declaring one (schema `:272`, default `:315`, normaliser `:670`); no reader anywhere |
| `unconsulted-setting` | `searchBackend` | `packages/settings/src/index.ts` | `still-holds` | same shape (`:278`, `:318`, `:673`); declared, defaulted and validated, read nowhere |
| `unconsulted-setting` | `plugins.agentLoop` | `packages/settings/src/index.ts` | `still-holds` | declared at `:77`/`:319`/`:676`; no production file outside the declaring one mentions it |
| `unconsulted-setting` | `plugins.bash` | `packages/settings/src/index.ts` | `still-holds` | `bash` occurs in 22 production files, but always as the shell tool name or a plugin-tool list entry (`packages/preset/src/default.ts:59`, `packages/subagent/src/roles.ts:37`) — never as `plugins.bash`, so the toggle is unread |
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

**Tally: `already-fixed` 2 · `still-holds` 13 · `by-design` 7.**

An item the scanner did **not** surface is still a row, and the "surfaced?" column says why not.
Every verdict below rests on a command run in this task, not on the source document.

### 4.1 D1 §跨包主線 8

| # | Item | Surfaced? | Measured evidence | Verdict |
|---|---|---|---|---|
| 1 | no tool schema declares `sandbox_permissions` | no | `sandbox_permissions` occurs in **7** production files: `packages/fs/src/index.ts:81,247,250` (the exact three lines cited by the brief), plus `packages/shell/src/index.ts:194,239,352,412` and `packages/terminal/src/tool.ts:86,187,226`, and the ladder consumes it at `packages/sandbox/src/call-policy.ts:141,177,192` | **`already-fixed`** |
| 2 | the sandbox escalation module appears only in tests | no | `WIDER_MODES` is used on a production path at `packages/sandbox/src/denial.ts:91,93` (the exact two lines cited by the brief) | **`already-fixed`** |
| 3 | `buildWireClient` | yes — `unused-export @i-harness/provider#buildWireClient` | the name occurs in exactly **2** files: its declaration (`packages/provider/src/index.ts:762`) and `packages/provider/test/provider.test.ts` | **`still-holds`** |
| 4 | `mountPreset` | **no** | the name occurs in 3 files: declaration `packages/preset/src/index.ts:30`, a **comment** `packages/tui/src/views/light-personas.ts:2` (`// persona catalog (verified: @i-harness/preset exports parsePreset/mountPreset`), and `packages/preset/test/preset.test.ts`. It has **no production caller**. It did not surface because the comment in an unrelated production file counts as a mention — see §7 item 4 | **`still-holds`** |
| 5 | `withdrawPlanModeTool` | yes — `unused-export @i-harness/plan-mode#withdrawPlanModeTool` | the name occurs in exactly **1** file in the entire tree: `packages/plan-mode/src/index.ts:36` | **`still-holds`** |
| 6 | `sandbox/mode` has no producer | **no** | the quoted literal `"sandbox/mode"` occurs on **19** lines of the walked tree: **17 in `test/` files** and **2 in production code** — the event-type declaration (`packages/core-session/src/index.ts:43`) and the **reader** (`packages/sandbox-policy/src/session-mode.ts:9`) — with **0** in production comments. 14 of the 17 test lines are `append(…)` calls, and **0** production files append the event. It did not surface because class 2 is anchored on the declaring file's **name** (`/(^\|\/)(events?\|manifest\|public-event-manifest)\.ts$/`), which matches exactly **one** file in this repo — `packages/telemetry/src/manifest.ts` — while this union lives in `packages/core-session/src/index.ts` | **`still-holds`** |
| 7 | `tui --yes` | yes — `unread-flag --yes` | see §3.2 item 2: `flags.yes` is assigned at `apps/tui/src/index.ts:445` and read nowhere; `--yes` is additionally advertised in two usage strings (`:9`, `:461`) | **`still-holds`** |
| 8 | `estimateAssemblyOverhead` / `bindAuthRefreshStatus` | **no** | both are declared and **used inside their own module**: `packages/session-executor/src/assembly.ts:220` + call at `:762`, and `:234` + call at `:618`. `packages/session-executor/src/index.ts` (22 lines) re-exports `createSessionAssembly`, `ModelUnavailableError`, `AssemblyOptions`, `ModelPolicy`, `SessionAssembly`, `createDurableSessionLoader`, `createSessionService` and three types — **not** these two. The only importer is `packages/session-executor/test/assembly.test.ts:19-24`, which reaches them through the relative path `../src/assembly.ts`, i.e. **not** through the package entry. So D1's claim (exported from `assembly.ts`, not re-exported by `index.ts`, `package.json` exposes only `"."` → unreachable outside the package) **still holds as written**. It did not surface because class 1 walks only `packages/*/src/index.ts` entries, and the entry does not export these names. Half the sentence that introduced them in D1 ("no production caller") is however no longer true — both are called on a production path inside `assembly.ts`, so the residue is a re-export decision, not a wiring gap | **`still-holds`** |

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
| 4 | the `sandbox/mode` scenario has no producer | **no** | identical to §4.1 item 6 — same measurement, one row, cross-referenced rather than re-derived. Note the disagreement recorded in §6: the spec calls this *"a reachability statement, not a defect"*, while roadmap §3.M1 makes it M1's headline case | **`still-holds`** |

### 4.4 CLI surface

| # | Item | Surfaced? | Measured evidence | Verdict |
|---|---|---|---|---|
| 1 | `tui --yes` parsed but never read | yes — `unread-flag --yes` | identical to §4.1 item 7 — cross-referenced, not re-derived | **`still-holds`** |
| 2 | unknown subcommands not rejected | **no** | `apps/cli/src/index.ts` dispatches by exact equality on `args[0]`: `web` `:102`, `sdk` `:129`, `sessions` `:134`, `acp` `:139`, `tui` `:145`, `__dist-selfcheck` `:153`, `--version`/`-v` `:156`, `help`/`--help`/`-h` `:160`; then `:164` `if (args[0] !== "run") return Promise.resolve(runTui(parseFlags(args)))` at `:167`. So `i-harness --sandbox x run t` — and any typo — launches the TUI. Not surfaced: no scanner class covers a dispatch chain. The fall-through is documented as deliberate at `:142-144` (*"the GROK-STYLE DEFAULT — a bare `i-harness` (**or any non-subcommand first token**) launches the TUI"*) | **`by-design`** — allowlist §6 |
| 3 | no `--flag=value` support | **no** | across the whole tree: `apps/` contains **zero** occurrences of `split("=")`, `indexOf("=")` or `startsWith("--")`; `packages/` contains exactly one `startsWith("--")` — `packages/guard-approval/src/danger-class.ts:87`, a shell-flag classifier, not a parser. Both parsers match whole tokens (`apps/tui/src/index.ts:441-456` `switch (argv[i])`; `apps/cli/src/index.ts:181,305` `args.indexOf("--sandbox")` / `a === "--model"`) | **`still-holds`** |
| 4 | `i-harness run --help` runs a task named `"--help"` | **no** | `apps/cli/src/index.ts:160` catches `--help` only as `args[0]`, so `run --help` passes it; the task is then built at `:304-309` by filtering out exactly seven flags (`--model`, `--api-key`, `--yes`, `--session-dir`, `--resume`, `--telemetry`, `--sandbox`) and their values, so the literal `"--help"` survives into `task`, is non-empty at `:310`, and reaches `runHeadless` at `:333` | **`still-holds`** |

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
- a **systematic sample of 27** from the 507 remaining `unused-export` rows: sorted by
  `(kind, subject, evidence)`, take every ⌊507 / 27⌋ = **18th** row starting at index 0, i.e. indices
  0, 18, 36, …, 468.

The 27 sampled class-1 subjects, in draw order:

```
@i-harness/acp#ACP_SERVER_NAME, @i-harness/core-agent#AgentConfig,
@i-harness/core-session#PlanModeView, @i-harness/feedback#MAX_FEEDBACK_NOTE_BYTES,
@i-harness/goal#GoalStateErrorCode, @i-harness/hooks#HookDecision,
@i-harness/llm-openai-compatible#OpenAICompatibleConfig, @i-harness/mcp-client#MAX_PUBLIC_NAME_LENGTH,
@i-harness/plugin-registry#readMcpServers, @i-harness/provider#EffectiveContextInput,
@i-harness/rewind#GitProbeOptions, @i-harness/sandbox-local#probeBwrap,
@i-harness/schedule#EveryScheduleRecord, @i-harness/sdk#SdkConnectionError,
@i-harness/session-persistence#TOOL_ABORTED_RECOVERY_RESULT, @i-harness/settings#SettingsStatusLineSegment,
@i-harness/settings#LayeredSettingsStore, @i-harness/skills#MAX_SKILL_DEPTH,
@i-harness/skills#SkillGetArgs, @i-harness/telemetry#TELEMETRY_MANIFEST,
@i-harness/todo#validateTodoItems, @i-harness/tui#CancelTurnBindOptions,
@i-harness/tui#PermissionKey, @i-harness/tui#ComposeRegionOptions,
@i-harness/tui#editorBackspace, @i-harness/tui#NEW_SESSIONS_LABEL, @i-harness/tui-core#TtyStream
```

Per row the check was mechanical: recompute the module(s) that **declare** the name (the tool's
`origins`), blank re-export statements the way `withoutReExportStatements` does, then classify every
remaining occurrence of the name across the 360 production files as a declaration, a comment, or
code. Reproduce with
`node .superpowers/sdd/2026-09-15-m1-reachability-sweep/t5-probe.mjs sample`.

### 5.2 Result

| Bucket | Meaning | class 1 | classes 2–5 | total |
|---|---|---:|---:|---:|
| **A — dead** | the only occurrences are declarations, re-export statements and comments. The tool is right, and the symbol really is dead | 1 | 0 | 1 |
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
  declaration edges.**

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

### 5.3 The method limitation this baseline inherits: **the plan's five snippets were all broken**

**Every one of the plan's five Step-3 code snippets was broken on this repo, and four of the five
failed by returning zero findings.** Classes 2, 4 and 5 would each have reported **nothing**. Two of
those I re-measured here rather than carrying them forward:

- the drafted class-4 anchor `/(^|\/)(caps|capabilities)\.ts$/` matches **0** of the 729 tracked files
  (measured directly), so the drafted scanner reported nothing over a tree that holds three unpushed
  capabilities;
- the drafted class-5 anchor `/(^|\/)(schema|settings-schema)\.ts$/` likewise matches **0** of the 729
  tracked files (measured directly). And class 5's reader, reduced to its drafted string-only form,
  returns **29** `unconsulted-setting` rows instead of **8** — **including `compaction.auto`, which
  is genuinely read at `apps/cli/src/index.ts:215` (`const compactAuto = noCompact ? false :
  settings.get().compaction.auto`)**. So the drafted reader would have **invented** a finding for the
  exact key the roadmap names as class 5's worked example. The 21-key difference is produced by the
  property test, which matches on the key's **leaf name only** — and the leaves here include very
  common identifiers (`mode` 140 sites after a dot in other production files, `model` 97,
  `providers` 52, `items` 48). Genuine settings reads were confirmed by hand for **7** of the 21
  (`compaction.auto` at `apps/cli/src/index.ts:215`; `sandboxMode` at `apps/cli/src/index.ts:202` and
  `apps/cli/src/web.ts:470`; `tui.prefs.scrollSpeed` at `apps/tui/src/index.ts:708` and
  `packages/tui/src/views/settings.ts:502-504`; `tui.prefs.timestamps` at `views/settings.ts:108,156`;
  `tui.prefs.guardian` at `apps/tui/src/index.ts:781`; `tui.prefs.screenMode` at
  `apps/tui/src/index.ts:572,577,666`; `tui.prefs.dashboard.pinned` at `views/dashboard-state.ts:60`).
  For the rest — `tui.prefs.statusLine.mode`, `tui.prefs.statusLine.items`, `llm.providers`,
  `llm.defaultModel.provider`, `llm.defaultModel.model` — the suppression is **not** evidence of a
  read; `tui.prefs.statusLine.mode` in particular is cleared by any of 140 unrelated `.mode` accesses.
- class 2 is **structurally** blind here: its file anchor matches exactly **one** file in the whole
  tree, `packages/telemetry/src/manifest.ts`, while the event union it was meant to sweep lives in
  `packages/core-session/src/index.ts:43`. That is why `sandbox/mode` — M1's headline unreachability,
  and the roadmap's own named class-2 example — is **not** in the 525.

**A verbatim implementation of the plan would have looked like a clean sweep.** This is recorded as a
limitation of the method, not buried: the baseline in §3 is **not the plan's output**. It is the
output of five scanners that were each rewritten against the real tree, and the only evidence they
are detectors rather than rubber stamps is the 13-case self-test
(`node scripts/audit/check-reachability.mjs --self-test` → `self-test: 13/13 ok`) plus the mutation
proofs Tasks 2–4 recorded. M2 must not read a falling row count as progress unless it first re-runs
the self-test and checks the §2 digest.

---

## 6. The allowlist

Two parts: the `by-design` **findings** this document adjudicated, and the `by-design` **source-list
rows**. Because R13 forbids row-by-row adjudication of the 512 class-1 rows, **this allowlist is not
exhaustive over them** — M2 inherits that obligation. Until it is discharged, the ratchet must be
seeded with the §2 digest and fail only on *new* rows, never on the existing set.

### 6.1 `by-design` findings (4)

| kind | subject | evidence | reason sentence |
|---|---|---|---|
| `producerless-event` | `retry/start` | `packages/telemetry/src/manifest.ts` | The telemetry manifest is the event **vocabulary**, not an emitter — `TELEMETRY_MANIFEST` is consumed at `packages/telemetry/src/manifest.ts:39` to build `TELEMETRY_EVENT_TYPES` — and the deferral is recorded in source at `packages/core-agent/src/index.ts:234,238` ("NOTE (retry/start deferral): M12 tool retry (guard-retry) and M20 … emits no `retry/start`"), so deleting the row would delete a vocabulary entry the M12/M20 retry work is specified against. |
| `unpushed-capability` | `plan-mode` | `packages/tui/src/app/slash/types.ts` | `packages/tui/src/app/loop.ts:2415-2418` states the three are NEVER supplied because the M49 backend has no live capability for them and the project refuses UI-state-only fakes, and their commands are gated invisible by `hasCapability` (`packages/tui/src/app/slash/impl/run.ts:49,57`) rather than faked — so nothing is broken and nothing is unreachable that advertises itself as reachable. |
| `unpushed-capability` | `guardian` | `packages/tui/src/app/slash/types.ts` | Same declaration and the same reason as `plan-mode` above: the guardian commands are gated by `hasCapability(ctx, "guardian")` at `packages/tui/src/app/slash/impl/approval.ts:27,35` and the loop never pushes it, deliberately. |
| `unpushed-capability` | `vim-mode` | `packages/tui/src/app/slash/types.ts` | Same declaration and the same reason as `plan-mode` above: the vim binding is gated by `hasCapability(ctx, "vim-mode")` at `packages/tui/src/app/slash/impl/text-input.ts:67` and the loop never pushes it, deliberately. |

### 6.2 `by-design` source-list rows (7)

| source | item | reason sentence |
|---|---|---|
| D1 §未竟事項 1 | `core-session` `migrate()` is a no-op | It is declared a placeholder in its own body — `packages/core-session/src/index.ts:686` "M1: only v1 exists; migrate-on-continue is a no-op placeholder for future versions" — and with `CURRENT_FORMAT_VERSION` at 1 there is no v0 to migrate; note for Phase B that it also has **zero call sites**, so the live choice is really "un-export or delete the seam" rather than "keep it". |
| D1 §未竟事項 2 | `goal` round admission unimplemented | `packages/goal/src/index.ts:9-10` says "no round admission (DSH's `roundsStarted` — explicitly out of scope)", and `:36-43` keeps `round?: number` as wire vocabulary precisely so that the UI/host contract does not break when admission lands; `packages/goal/test/goal.test.ts:37` pins it as `undefined`. |
| D1 §未竟事項 3 | `session-query` `SearchHit.time` is index time | The field's own doc comment declares the semantics and the reason — `packages/session-query/src/index.ts:13-17` "INDEX-REBUILD time (epoch ms), NOT the event's time. The JSONL log carries no per-event timestamp, so the file-backed index can only …" — so the value is documented as what it is rather than silently mislabelled. |
| D1 §未竟事項 5 | `workspace` defers `delete`/`insertBefore`/`follow`/`status` | `packages/workspace/src/index.ts:30-42` records the deferral as a controller ruling ("Deliberately DEFERRED (Task 3.1 controller ruling — seams noted in code, not implemented)") with a per-item reason, and each seam is anchored in the code rather than left implicit. |
| D1 §未竟事項 6 | `lsp` forces one server per run | `packages/lsp/src/scheduler.ts:20-24` declares it an explicit M18 non-goal and ships the refusal string "lsp: only one LSP server per run is supported (M18 core)", so the limit is announced rather than silent. |
| sandbox spec §7 item 3 | `allowed-once` consumed by a call that fails for an unrelated reason | The spec records this as "記錄而不修" (recorded, not fixed) with its reason — reordering the guard would change **which** refusal a granted-but-invalid call returns — and the ordering is deliberate in code: `packages/fs/src/index.ts:305` spends the grant before `:308`'s unrelated `old_string === ""` validation. |
| CLI surface 2 | unknown subcommands not rejected | `apps/cli/src/index.ts:142-144` documents the fall-through as the intended grok-style default — "a bare `i-harness` (or any non-subcommand first token) launches the TUI in the current folder" — so rejecting unknown subcommands would remove a documented behaviour; the accepted cost is that a mistyped subcommand opens the TUI instead of erroring. |

### 6.3 Proposed class-level rule — M2 must confirm

**`@i-harness/sdk`: 17 `unused-export` rows, all with evidence `packages/sdk/src/index.ts`.**
Reason sentence: the SDK package is the **embedder-facing public surface**, so its exports are
addressed to code outside this repository and "no in-repo production consumer" is the expected state
rather than an orphan — which is exactly the case roadmap §3.M1 names ("`sdk` 的公開 API 本來就不該有
內部呼叫者"). I did **not** adjudicate these 17 rows individually (R13); the rule is recorded here as a
single decision for M2 to accept or reject wholesale. If accepted, the allowlist becomes 4 + 17 = 21
findings plus the 7 source-list rows.

### 6.4 What is deliberately **not** on the allowlist

- **Nothing** in the 507 unadjudicated class-1 rows is allowlisted. Absence from this allowlist is
  not a claim that a row is a defect; it is a claim that nobody has looked yet.
- The **26 bucket-B rows of §5 are not allowlist candidates.** They are live symbols whose `export`
  keyword has no consumer; the fix is to narrow the declaration, not to grant an exception.
- `--yes`, the `plugins.*` / `language` / `fontSize` / `searchBackend` / `onboarding.welcomeNoticeVersion`
  settings, and `withdrawPlanModeTool` / `buildWireClient` / `mountPreset` / `createUnifiedSpillStore`
  are `still-holds`: none of them is declared deliberate anywhere in the tree, so none belongs in an
  allowlist.

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
(`check-reachability.mjs:235-252`) attributes the name to its **declarer**, so the barrel is a
consumer and the chain terminates nowhere in particular. The re-export-blanking rule
(`withoutReExportStatements`, `:286-293`) applies only to the entry file currently being scanned, so
a re-export statement in **any other** production file counts as a mention and suppresses the
finding. **128 named re-export statements** were measured in Tasks 1–4 (carried forward; not
re-derived here — a coarser regex over the 729 files gives a larger count under a wider definition,
so the number is not comparable and is not restated as mine).

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
imports, re-exports and calls (see the `EntryCallSite` self-test case, `:705-713`).

**6. Four symbols whose only in-repo mention is a comment stay unreported**, and comments cannot
simply be stripped: `settings#FieldSpec` (`packages/settings/src/index.ts:506`),
`subagent#TaskConcurrencyLimitError` (`:62`), `tui#SdkClientLike` (`:54`), `workflow#WorkflowJobStore`
(`:4`). Re-checked here: none of the four appears among the 525, and each is mentioned in a
production file **other than** the module that declares it **only** inside a comment. Stripping
comments is unsafe because **69 files contain a string literal with `//`** (carried forward from
Tasks 1–4; not re-derived here — my own wider regex over the 729 files finds 89 files with a `//`
inside a string literal, and 20 where that literal is not a URL, so again the definitions differ).
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
only**, so it is simultaneously too **loose**: `tui.prefs.statusLine.mode` is cleared by any of 140
unrelated `.mode` accesses, `llm.defaultModel.model` by 97 `.model` accesses. Genuine settings reads
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

**11. This baseline is not the plan's output.** See §5.3: every one of the plan's five Step-3 snippets
was broken on this repo and four of the five would have reported zero findings. The 525 rows come
from five rewritten scanners whose only warrant is a 13-case self-test and the mutation proofs Tasks
2–4 recorded. **M2 must check the self-test and the §2 digest before it trusts any comparison against
this baseline.**
