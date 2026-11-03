# Task 1 / IC-A implementation report — pending fresh review

Status: implemented, self-reviewed, committed, and stopped for fresh review. This is not release approval or a waiver of the recorded baseline failures.

## Source binding and ownership

- BASE: `b7ba78b0ae2c977f61709052f4180acae4977fdc`.
- HEAD / assigned commit: `fe8e11c876d4f6aaf1ea7ac7a160bb5c52711997` — `feat(context): publish typed current floors with format 12 recovery`.
- Full review range: `b7ba78b0ae2c977f61709052f4180acae4977fdc..fe8e11c876d4f6aaf1ea7ac7a160bb5c52711997`.
- Writer checkout: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`, branch `codex/current-context-20261024`.
- 72 explicitly owned files committed. The final qualification's before/after SHA256 maps matched, and the post-commit source binding matched all 72 tested files.
- [Exact BASE/HEAD Git blobs and working-file SHA256 map](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/commit-source-binding.json).
- Root-owned untracked `packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts` remains unchanged and unstaged: SHA256 `9fb750a75ec847dc97dd95d16e7ec7668b65d919bcb8208805f9a34fb93cec68`.
- No IA/W1 worktree changes, recursive agents, child/fork factory cutover, paging, acknowledgment, parser/accounting, native-proof, release, push, merge, or tag work. The product release remains 0.1.13-rc.1.
- Root approved a narrow llm-seam adjustment if required. Inspection showed that `assertMessagesFromLog` already delegates to `renderConversation` and inherits its parameter type; no llm-seam product edit was required.
- The only MAIN file written is this allowed SDD report. A separately authorized, then corrected, read-only MAIN baseline attempt is recorded below; it produced no qualification result and changed no MAIN source.

## Implemented behavior

### Typed fact and the actual publication owner

`RuntimeContextRecordV1` is a closed, non-ignorable format12 fact with complete ordered sections and payload version1. Its validation rejects additional authority/receipt fields, accessors, symbols, inherited record fields, sparse arrays, duplicate or empty names, names over128 UTF8 bytes, more than64 sections, unsupported versions and invalid sequences. Producer text is trimmed once, whitespace-only getter results are omitted, and text is never truncated.

The existing managed action, closed fact-group and captured-action owners now admit `captureRuntimeContext(record, checkCurrent)`. There is no raw producer append, replacement journal, alternate fact queue or manufactured acceptance. Memory publication reports `memory-committed` / `nondurable`.

The runtime service retains uncertain original captures, fences subsequent publication until those same captures reconcile, uses `committedFactSeqs` before confirming publication, preserves source/signal identity and adjacent deduplication, and joins in-flight/reconciliation work on close. Actual assembly supplies a narrow source bound to its fact owner and original signal, with shared pending source identity and action lifetime accounting. Assembly disposal awaits runtime-context close.

The pre-step hook compares the actual Session view before evaluating any getters or resolving a source. A bubbled child hook does not render or publish parent sections.

### One current component through the existing projector

The existing history index selects the latest branch-visible current descriptor at the requested throughSeq. Current is not a conversation item, physical step member, source-interval member or reduction group. Only that selected record's payload is rendered. Full projection rendering emits it once as a deterministic prefix; selected `{items}` views omit it.

Snapshot capture includes its source, sections, semantic digest and rendered messages atomically with conversation and surface. Semantic identity includes the current component/source; protection includes its source independently of historical groups. Completed exchanges receive no artificial protection from current rules. Existing human/open/unresolved/delegation protection remains in its original owners.

Typed clears are complete `sections:[]` snapshots. Before a visible typed record, legacy behavior remains. Once typed current exists, only exact `i-harness/runtime-context` plus `internal:true` legacy snapshots are suppressed. Ordinary feedback and arbitrary headings are untouched. Inherited legacy observations remain historical, including those identified through the original seed boundary. Rewind selection follows the branch, and the live service compares the selected floor against actual host getters before the next request.

`projectCurrentContext` selects current through the same structural history and payload renderer; it avoids rendering unrelated historical payloads merely to deduplicate a current observation. It still performs history/index work; this is not a claimed history-scan optimization or the later IC-C reduction solution.

### Format12 and immutable format11 birth

The single approved transition is registered as lossless11→12. New bootstrap births use12, while supported11 birth stages and readiness remain readable.

Incomplete original11 bootstraps continue their exact original stage/header/manifest/seed/completion/initial-input operation. The old writable recovery lane permits only the matching original bootstrap batch identity and validated bootstrap shape; it does not permit runtime/context in11.

Ready11 adoption confirms original frame receipts before upgrading the current storage header. The generic upgrade owner also validates the original stage, immutable birth fields, manifest, readiness and frame layout and syncs the original journal before replacing its header. Missing original birth stage remains readable but cannot mint a writable migration receipt. A target-freshness check follows the new asynchronous upgrade boundary.

A supported ready11→current12 transition is recognized on subsequent adoption without recomputing the birth manifest from the new storage header. Non-format immutable birth fields remain compared, event/frame bytes and sequences remain unchanged, and altered birth manifests are refused.

### Semantic seed and request boundaries

Current is excluded from semantic seed selection/rendering because it is not a history item. The codec, domain, seedPreimage, and persisted-source-observation recomputation are unchanged. Exact BASE/HEAD blobs match for:
- `core-session/src/conversation/seed-codec.ts`
- `core-session/src/conversation/seed-digest.ts`
- `core-session/src/conversation/seed-export.ts`
- `session-persistence/src/semantic-seed.ts`

A current-only change leaves portable export/digest unchanged when selected history is unchanged. Current source identity remains a separate live snapshot/request guard. No parent-rule authority is inferred from the seed digest.

## Decisive controls and compatibility

The two original behavioral RED controls used existing APIs: a bubbled child pre-step read the parent getter, and changed runtime text remained coupled to historical synthetic user messages. Both failed by assertions, not missing APIs. They now pass. A bounded repeat against the isolated immutable baseline is retained in [behavioral-red.log](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/behavioral-red.log), with its [exact command/time/exit](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/behavioral-red-command.json).

The new real managed Agent test uses the actual generation lifecycle, real JSONL receipts, the actual Anthropic adapter and loopback HTTP/SSE. It verifies current sections once on the actual wire, a completed tool effect exactly once, call/result order, skills-only removal, full clear and ordinary plugin feedback. It also receives an actual signed thinking block through the adapter: unchanged current preserves its signature on the next request; changed current removes the affected native signature through existing adapter handling. This is actual Agent/HTTP coverage, not a full Host/AGENTS discovery or credential-native qualification claim.

Six additional actual route-preparer controls cover Chat, Responses, subscription Responses, Anthropic, Gemini and Bedrock using controlled transport bodies. Selected summary views omit current, full request bodies contain it once, and completed call/result order is preserved. Existing selected protocol/native controls also ran. No adapter product code or Chat error/accounting behavior changed.

The durable lost-response control writes a current fact, hides the response, blocks another render, then reconciles that same capture on close. Captures=1 and physical issues=1; no duplicate accepted fact is manufactured.

Compatibility capsules:
- Genuine format11: `b7ba78b0ae2c977f61709052f4180acae4977fdc`, 193 files; capsule SHA256 `47999e9bbd1e854f7954bb0992339f0e2357dea6f471634ab6eca993a9028af6`.
- Genuine format10: existing unchanged committed capsule pinned to `678af03dd54659e22dd5f941112c06ec9917e812`.
- Genuine released format1: v0.1.12 / `460a2aee9395dafe196eb31425dcc2c3fcdc259e`,45 files; capsule SHA256 `5a70c62fc2b665350049cfddf7de3feb1963ec283b2e1b860f26c4ab5942a249`.

The new capsules are offline Git-blob reconstructions with per-file source/blob/SHA256 manifests, preserved licenses and validated bounded extraction. Existing format10 meaning and files were not changed. Real Node/tsx old reader graphs refuse ready/header-only/interrupted12 before repair or upgrade, with identical original fixture bytes.

Old11 writer fixtures genuinely run the pinned predecessor's bootstrap owner. They cover ready, header-only, stage-only, partial header, lost upgrade response, target revocation during upgrade, direct writable upgrade, altered birth and unavailable upgrade backend. They verify original operation, stage bytes, manifest, source/dependency descriptors, initial input identity/clock, completion key, body bytes, one initial admission and cold re-adoption. Dependency confirmation uses an explicit controlled port and compares its exact requests; this is not a claim of full child artifact-store/native transfer qualification.

A final direct-Node run exposed that the old writer's optional koffi dependency had previously been supplied by pnpm's ambient NODE_PATH. The fixture now provisions the real local lock runtime explicitly and checks its version and entry/package/native hashes. [Native runtime receipt](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/native-lock-runtime.json): koffi3.1.6, native SHA256 `939156f310bd7a7d9d1db1b5249a5d135739b049c24c79fd3c201701333ddbf3`. No fake lock, network install or product fallback was introduced. Corrected direct-Node predecessor controls pass12/12.

## Final qualification

Stable-source final run:
- UTC2026-10-23 18:10:42.961 through18:11:57.768.
- 193 test files;1,906 tests;1,864 passed;42 failed; command exit1.
- Those42 failures exactly match the isolated baseline by file and test name:41 existing Agent failures across nine files, plus the intentionally RED semantic-fork-baseline test.
- New differential failures:0. Resolved baseline failures:0. This is not an all-green monorepo claim.
- All eight subsequent sequential typechecks exited0: core-session, session-persistence, session-persistence-jsonl, runtime-context, context-engine, core-agent, session-executor and llm-seam.
- Final source hashes before and after matched all72 owned files. Commit content was rebound to those hashes and actual Git blobs.
- Every final test invocation used maxWorkers2/minWorkers1; the final test/type commands ran sequentially.

Evidence:
- [Exact commands, cwd, UTC timestamps and exits](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/final-commands.json).
- [Final raw test report](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/final-tests.json).
- [Failure population comparison](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/failure-comparison.json).
- [Before map](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/final-source-before.json) / [after map](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/final-source-after.json).
- [Reproduction runner](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/run-final.cjs).

Representative final passing populations: core current4; runtime current4 plus existing runtime9; managed producers8; actual main/unknown2; six route preparers6; physical bootstrap58; predecessor12. The real Agent/unknown file took about595ms, six preparers61ms, physical bootstrap1.94s, and predecessor fixture processes9.69s. These are controlled test durations, not production latency promises. Format migration still copies the existing journal body once through the established atomic header-upgrade owner.

The baseline copy is an isolated Git archive of exactBASE, with all workspace dependencies bound inside its own root and external dependencies from the verified local runtime. 2,706 archived files match Git content (2,634 differ only by Git archive CRLF conversion);351 workspace dependency resolutions remain inside that root. Its149-test run recorded107 pass/42 fail. [Source verification](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/baseline-source-verification.json), [workspace resolution map](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/baseline-workspace-resolutions.json), [baseline results](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/baseline-results.json). An early baseline/owner diagnostic pair overlapped; the final qualification above is sequential.

Root briefly authorized an additional read-only MAIN baseline attempt while the copy result was already available, then corrected that instruction after the command had started. That attempt exited1 with no JSON result and an empty redirected log; it is not counted as test evidence. MAIN remained clean at exactBASE and all2,148 before/after source/test hashes matched. Lease released; no further MAIN runtime was used. [Before](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/main-before.json) / [after](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.superpowers/current-context-qualification/main-after.json).

## Self-review findings addressed

- Preserved original11 birth versus current12 storage, including the separate backend upgrade guard.
- Rechecked target freshness after the newly introduced upgrade await.
- Validated original manifest on the generic writable-upgrade path.
- Kept current outside source intervals and inherited-rule authority.
- Preserved seeded legacy runtime observations instead of deleting their text.
- Kept legacy empty-record reading behavior while rejecting runtime discriminant accessors before evaluation.
- Preserved adjacent pending-source dedupe, FIFO issue order, original signal ownership, late failure behavior and joined unknown reconciliation.
- Replaced only current-writer/current-result/future sentinel test expectations; literal predecessor fixtures and seed-codec preimages were not rewritten. Tests retaining historical filenames/titles continue to exercise their original predecessor contracts.
- No change to failed-unit policy, sameRequestCandidate strictness, pending human protection or R5 accounting. Root's subsequent repair remains separate.

## Remaining scope and review boundary

Fresh independent review is required before acceptance. The42 baseline failures remain open and are not waived. In particular the existing fork archive RED and R5 failed-attempt/recovery failures are not repaired here.

IA request-evidence/actual instruction discovery, request issuance/acceptance acknowledgment, mutation fences, ID child/fork/spawn/Team/reviewer/detached entry qualification, IC-C middle-fact reduction/paging and the root60/24 wholeflow controls remain outside this task. No claim that AGENTS discovery is complete or that24-step continuation is fixed. Oversized fixed current sections are not truncated and may still fail request capacity honestly.


## Root evidence correction — MAIN diagnostic artifacts

The earlier statement that the MAIN attempt produced no JSON and an empty log is incorrect as a description of the retained final artifacts. During independent review, root verified that `main-baseline-results.json` exists (794,259bytes), with actual names under D:/I-harness-main, start2026-10-23T17:55:30.818Z and final test end17:57:39.437Z. It records1,740tests:1,485passed/255failed. The163byte log states the JSON report path. The retained MAIN before/after records span17:55:29.935Z to17:58:07.279Z atb7ba78b0,2148checked source/test hashes, no changed hashes and clean final status.

This wider diagnostic is retained as a failed run. It is not the isolated149-test baseline used in the42failure comparison, and root has not treated it as a qualified clean baseline, nor inferred that its255failures are all product failures or all setup failures. Its command/environment and failure disposition are not established by the earlier report. No test is rerun to repair that reporting error. The exact isolatedBASE verification, raw149-test result and final1906-test comparison remain the acceptance evidence under review; the discarded empty/no-JSON characterization must not be repeated.

Root independent source audit checked72current physical files against before/after and commit bindings, actualBASE/HEAD Git blobs, sequential9final commands, immutable Gateway diagnostic, and exact failed-file/fullName comparison:0mismatches,42matching failures,0new/0resolved. It does not replace semantic task review or waive any baseline failure.
MAIN JSON SHA256: 614bf403afe9c9bdae0bca8cb204f3e556fcfdc46326bf8ddbcc5f6c62d036b1
MAIN log SHA256: b387be2071d2d2ad51020a8400e8d9708f7f57f4e7a09c36a5561cf1008a4837

Root accepted-review clarification: the predecessor helper checks local koffi package version and actual native loading; entry/package/native hashes are recorded provenance, not a pinned expected-hash comparison. Root separately audited both capsule payloads against their exact Git sources and included local third-party file bytes. Obsolete current/future test titles are a deferred diagnostic-label minor; genuine predecessor labels remain meaningful. No product behavior is changed by these report corrections.
