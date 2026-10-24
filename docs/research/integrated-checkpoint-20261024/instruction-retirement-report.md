# Task 1 retirement handoff

The approved dead-API retirement is implemented and committed for fresh independent review. This packet does not claim whole-feature or release completion.

- Checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`
- Branch: `codex/instruction-retirement-20261024`
- Full BASE: `03a97a3ea6bb00fc15197ade19761000982b3e52`
- Full HEAD: `0d82ecf432bd109d2341083ad220a366c53eb2f2`
- Exact review range: `03a97a3ea6bb00fc15197ade19761000982b3e52..0d82ecf432bd109d2341083ad220a366c53eb2f2`
- Commit: `refactor: retire replaced instruction publication wrappers`
- Worker: `instruction_retirement_impl_sol_20261024`, assigned GPT-6.1 Sol, sole product writer/runtime, no subagents.
- 12 changed paths; 106 insertions / 293 deletions. Tracked checkout clean at handoff. Four generated packaging output directories remain untracked, described below.

## Implementation and contract check

The source/package consumer recheck at BASE confirmed the synchronous instruction chain and pre-step runtime wrapper have no shipping callers. Both packages are private workspace packages. Search receipts `01-retired-consumers-baseline.txt` and `39-final-retired-name-search.txt` preserve the before/after inventory. No supported external contract was discovered. Final package source/test search has zero retired-name matches (rg exit1 as expected).

Removed from instructions: `createInstructionsSection`, `InstructionsConfig`, `DEFAULT_INSTRUCTIONS_MAX_BYTES`, the legacy `InstructionFile` type/re-export, `loadInstructionFiles`, `renderInstructions`, `discoverInstructionPaths`, and legacy-only `src/files.ts`. Current observed service/observation/discovery/limits/dependencies/recovery/host bodies remain unchanged.

Removed from runtime-context: only `installRuntimeContext` and the `PluginContext` import. The `createRuntimeContext` body, original capture settlement, lease ownership, render order and lifetime behavior remain unchanged. After wrapper-test removal, no production or test consumer of core-plugin remains inside runtime-context, so its direct package dependency and exactly the matching lock importer entry were removed. No other dependency change or lock reseed.

The two live test consumers were migrated rather than dropped:

- core-agent/current-context-loopback uses explicit `createRuntimeContext.render()` calls at the initial/instructions-empty/skills-empty source boundaries. The name/comment labels this honestly as a low-level source publisher. Its actual Anthropic HTTP/native signature/tool-result ordering/current-once, skills-only, clear, reduction protection, plugin feedback, lost-publication/original-capture/reconciliation/close assertions remain.
- executor/managed-producers removes the obsolete createInstructionsSection mock and uses a real temporary scoped AGENTS.md, supported `createSessionAssembly`, actual Agent run/followup, managed JSONL owner and local HTTP OpenAI-compatible transport. The backend decodes batches and holds only runtime/context receipts. Legitimate input/step writes are counted separately; their presence is explicitly allowed. While held, runtime publication is absent from live and durable views, the run is unsettled, and no model request has arrived. After release, two real admissions receive the exact complete committed current snapshot once each, and unchanged text produces one runtime fact. The fixture independently expects the exact scoped header/instruction bytes, then checks entire current snapshot equality at the model boundary. Other actual producer, unknown reconciliation and overlapping dedupe controls are retained.

Only the two obsolete runtime/current and instruction paragraphs in CAPABILITIES-DETAIL.md changed. They describe owned logical admission, scoped observed files and UTF-8 byte budgeting, and explicitly keep child/native mutation/UI qualification pending. Historical audit inventories, including the old files.ts citation elsewhere in that document, were left unchanged per plan.

## Exact test dispositions

Deleted legacy-only instructions.test.ts, all five cases:

1. `walks workspace → parent → ancestor; AGENTS.md preferred over CLAUDE.md per dir`
2. `prepends the global candidates (synthetic home override)`
3. `returns a stable ordered list with no duplicates`
4. `caches by mtime/size — changed content re-renders`
5. `truncates the rendered set at maxBytes`

These specified the removed ambient-home/unbounded-ancestor/synchronous-character-slicing API. The accepted scoped discovery/UTF-8/observation controls remain; the final instructions suite has 124 cases.

Deleted exactly two wrapper-only runtime tests:

- `ignores a bubbled child pre-step before reading parent getters`
- `installRuntimeContext renders on the agent/pre-step emit (loop integration seam)`

The standalone snapshot/dedupe/clear/replay/refused-admission/rewind and all original-publication/resource lifetime controls remain (22 runtime tests).

Managed-producers remains eight tests. Its obsolete assembly pre-step case is replaced by `gates actual assembly Agent visibility on the runtime receipt and deduplicates later admissions`; the five producer cases plus unknown and overlap controls are retained. Core loopback remains two tests, with explicit source-boundary publication replacing the removed wrapper.

## IR-01: prior stale close-Promise expectations

The first full instructions run (`10-instructions-suite.log`) had 119 pass / 5 fail, all unchanged source-lifecycle Promise identity assertions at former lines38/136. Root independently reproduced the same five failures and 12 passes on unchanged MAIN product (`evidence/root/02-source-lifecycle-baseline.txt`, exit1). This is a prior stale test contract, not a retirement runtime regression.

Root ruling IR-01 explicitly authorized migration of this one additional test file and prohibited service.ts changes. The accepted IC-B implementation clears a failed close flight to permit explicit retry of the same captured lease. Updated controls verify:

- concurrent closes while the first held read is pending return that same Promise;
- success remains memoized;
- after lease-only rejection, clearing the fixture fault permits a new explicit flight to close the original lease successfully;
- after Git marker native read/cleanup faults, retry still reports the original error identities and aggregation; clearing the transient lease fault does not erase native debt;
- retries perform no new prepare/read/native open/subscription/update; marker native close count stays1, while the same observation lease close method may be retried (count2);
- rejected retry handlers are attached immediately, and the closed admission fence remains effective.

No case was removed from source-lifecycle (17/17), and service.ts SHA/body is unchanged. Root supplied source SHA256 `6F072AEE35AE8676FB9C9D4BBA80337C3FE8C89DBB41C89B45D3ACD3C4C9CAA1` and original test SHA256 `86B6A768B685F16F72CDEC16138FD51C1B7F74FC921A0F65DAF6B8977AD8AA3F`; normalized selected-source comparisons are independently saved in receipt24.

## Validation receipts and numeric exits

All Vitest runs used package CWD, ran sequentially, and passed `--maxWorkers=2 --minWorkers=1`. One runtime at a time. No live provider or user session.

| Receipt | Command scope | Result |
|---|---|---|
| 00 | Original managed-producers baseline | exit1; 7 pass / 1 obsolete pre-step failure `No runtime receipt hold` |
| 03 | Second unchanged managed-producers attempt after failed setup edit | exit1; same obsolete RED, not migrated product behavior |
| 04 | Actual migrated managed-producers before deletion | exit0; 8/8 |
| 05 | Actual migrated core loopback before deletion | exit0; 2/2 |
| 10 | First post-retirement instructions full suite | exit1; 119 pass / 5 prior stale close-Promise expectations |
| 11 | Runtime-context full suite | exit0; 4 files,22/22 |
| 12 | Core-agent current-context-loopback | exit0; 2/2 |
| 13 | Executor managed-producers, main-instructions, freshness, source-close, publication, publication-submit | exit0; 6 files,27/27 |
| 14 / 15 / 16 / 17 | Instructions / runtime-context / core-agent / executor typechecks | each exit0 |
| 18 / 19 | First original CLI build / Gateway package-copy owner | each exit0; warnings recorded below |
| 20 | IR-01 migrated source-lifecycle | exit0;17/17 |
| 21 | Historical reachability gate, unchanged baseline/allowlist | exit1;399 live,16 new vs historic seed,83 gone; no new rows vs actual BASE |
| 22 | Final full instructions suite after IR-01 | exit0;11 files,124/124 |
| 28 | Final instructions typecheck after IR-01 | exit0 |
| 29 | Final managed-producers with entire model/current snapshot equality | exit0;8/8 |
| 30 | Final executor typecheck after final assertion | exit0 |
| 31 | Final original CLI build, fresh output | exit0;0 esbuild warnings, owner dynamic-import warning retained |
| 32 | Final Gateway copy owner, fresh output | exit0;242 packages shipped; platform optional skips retained |
| 33 / 40 | Final unstaged/staged diff checks | each exit0; local LF→CRLF Git notices only |
| 41 | Scoped commit | exit0 |
| 47 | Post-commit tracked diff | exit0;clean |

`49-command-exit-manifest.json` records all22 runtime/test/build command argv/CWD/numeric exits. Each `.log` preserves raw stdout/stderr with UTC, package CWD and the command. Setup/obsolete-oracle dispositions are kept separately in receipt37.

## Source preservation and selected long-control reuse

`23-base-source-manifest.txt` and `45-head-source-manifest.txt` contain Git blob manifests; `43-final-changed-paths.txt`, `44-full-range.diff`, `48-final-changed-path-manifest.json` preserve the exact final range and changed-file SHA256/blob IDs.

`24-production-body-comparison.json` compares170 bodies/files at BASE/current: whole normalized observed instruction/observation source files, executor instruction host/policy/manager/view/target files, whole assembly, core-agent and core-session sources, plus the exact `createRuntimeContext` declaration/body. All170 are equal. Normalization is explicitly CRLF→LF and trailing-newline trimming for the isolated runtime function. This is body preservation, not whole-file or bundle identity.

The accepted product source at `2e9307af2e48405fbf755362b2a3248e0ca5d32a` and assigned BASE have no packages/apps path diff (`38-accepted-to-base-product-paths.txt`, exit0). The accepted long target proof was not rerun, as authorized for this dead API retirement. The inherited behavioral evidence is `D:/I-harness-main/.superpowers/sdd/2026-10-24-main-instruction-consumer/evidence/task-1/064-final-target-full-range.txt` and `target-proof/targets-257.json`, with its original selected reuse/correction binding documented in that packet's task-1-report.md. The N257 control is the actual standalone nondurable SessionService/HTTP/tool/read-scope chain, not a durable JSONL performance proof. Its actual main assembly/admission/observed/publication bodies are unchanged here. Only unused synchronous/pre-step entry points were deleted; this packet does not assert old/new index files or CLI bundle bytes are identical.

Final packaging owners were discovered from tracked manifests/source: root `node scripts/build-dist.mjs --out .retirement-cli-final-20261024` via pnpm exec; `packages/desktop` `pnpm run gateway:ship --out .retirement-gateway-final-20261024`. Receipt34 hashes selected final artifacts; receipt36 verifies selected copied instructions/runtime-context/assembly sources equal final writer bytes and legacy instructions/files.ts is absent in the Gateway tree.

## Reachability: actual BASE delta and remaining historical rows

Root's unchanged product baseline JSON (`evidence/root/03-reachability-baseline.json`) has404 rows. Current JSON (`26-reachability-current.json`, command exit0) has399. Actual row-set comparison `27-reachability-delta.json` has **added=[]** and exactly five removals:

- instructions#DEFAULT_INSTRUCTIONS_MAX_BYTES
- instructions#InstructionsConfig
- instructions#createInstructionsSection
- instructions#discoverInstructionPaths
- runtime-context#installRuntimeContext

The requested historical gate still exits1 because it compares to the unchanged2026-09-24 seed456. It reports16 new rows and83 removed; the2 existing inert allowlist warnings are output-retention#gcSpillStore and sdk#SdkRunError. There is no new retirement row, no reseed, no exemption and no fake consumer.

The16 remaining seed-relative rows are: core-session#CurrentContextComponent, #exportConversationSeed, #validateRuntimeContextRecord; instructions#InstructionPendingLease; llm-seam#withPreparedRequests; session-persistence#BootstrapCallerMetadata, #BootstrapInitial, #BootstrapLineage, #BootstrapReceipt, #BootstrapTarget; settings#InstructionMigrationMeta, #SettingsRevisionGuard, #SettingsWatchError, #SettingsWatchOptions, #SettingsWatchState, #previewLegacyInstructionImport. Their existing owner/disposition remains outside this narrow packet. InstructionPendingLease is an unchanged accepted observation export; this report makes no supported external-contract claim to justify it.

## Warnings, preserved outputs and handoff boundary

The original CLI build owner exits0 with0 esbuild warnings but reports90 remaining dynamic imports and warns that36 dynamic TypeScript imports require a tsx-like loader and can fail on affected dist paths. This remains an unresolved distribution qualification limit; no smoke/platform/installer/provider qualification is inferred from build success. Gateway copy ships242 packages and reports unavailable optional packages for other platforms; all raw skips remain in logs.

The first edit attempt hit the Windows Store python.exe alias (exit1, no edit/output); Node performed the actual edit. Receipt03 preserves the resulting second unchanged RED honestly. The first pnpm call performed workspace link/setup verification and later verified the existing615-entry lock against supply-chain policies; no requested provider requests or dependency version changes were made.

Automatic approval review rejected a cleanup command for the two verified generated output directories with `blocked by policy`; it did not execute. No alternative deletion mechanism was used. Four untracked outputs remain in this worker checkout: `.retirement-cli-20261024/`, `.retirement-gateway-20261024/`, `.retirement-cli-final-20261024/`, `.retirement-gateway-final-20261024/`. They were excluded from the commit. The final variants correspond to receipts31/32/34/36; earlier ones correspond to18/19/25.

Product version0.1.13-rc.1 and Session format12 remain unchanged. No general decomposition, child manager/semantic inheritance, native mutation fencing, UI, result-store/lifecycle/context-output repair, R6 performance/durable qualification, release, push, tag, merge, credentials or live account/provider claim is included. Protected other worktrees were not modified. MAIN writes were limited to this report/evidence subtree.

The writer stops product/test/report writes at this delivery. Branch/worktree remain for root's fresh full-range spec and quality review. Any correction should return through root with scope and the reviewer's finding.
