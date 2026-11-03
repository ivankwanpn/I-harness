# Task 1 — Agent contract regression qualification

P3 test-owner implementation is committed and ready for fresh independent review. The final combined three-file gate passed **14/14**, owner typecheck passed, and the NATIVE worktree is clean. Exact same-name comparison retains all fourteen original cases: **10 failed → passed; 4 passed → passed**. No final failing assertion remains in this bounded packet. This is not a whole-Agent or cross-branch integration claim.

## Exact source identity and owned scope

- Sole writer/runtime checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`.
- Branch: `codex/agent-contract-regressions-20261024`.
- Exact BASE: `07ac8fc9fa0997798e488040966605a1fcb8f0f4`.
- Committed HEAD: `f5bf396e0dfff53115c3adf51ef1db8c93bd5751`.
- Review range: `07ac8fc9fa0997798e488040966605a1fcb8f0f4..f5bf396e0dfff53115c3adf51ef1db8c93bd5751`.
- Commit: `test(agent): qualify deep request reasoning and effect contracts`.
- Exactly three tracked files changed, 209 insertions / 60 deletions: `packages/core-agent/test/deep-context-request.test.ts`, `packages/core-agent/test/reasoning-streaming.test.ts`, `packages/core-agent/test/context-effect-freshness.test.ts`.
- No product code, shared helper, skip, timeout increase, fabricated model metadata, broad cancellation matcher, version, remote, or live profile changes. No new child agents or branch switch. Earlier baseline/failed iteration receipts were preserved.

Promoted plan: `D:/I-harness-main/docs/superpowers/plans/2026-10-24-agent-contract-regressions.md`. This continuation first read the quota-switch handoff and retained its completed RED/source investigation. The original ten failures were not reproduced again.

## Behavior qualified

The four neutral depth cases retain depths 2000 and 6000, shallow and deeply nested schemas, exact nested argument/result contents, and two successful same-session requests. They assert an actual composed AbortSignal and exact caller reason propagation rather than signal object identity. A third request cancels inside the real provider generator and deliberately yields a late tool call; the Agent rejects with the exact `AbortError`, dispatches no tool, performs zero effects, and joins all three generators. An already-aborted followup emits no events and makes no additional sends. The stream-only custom ModelClient is honestly `neutral-only`, admission `unavailable`, cap support `unknown`, confidence `unknown-components`.

The fifth depth case traverses the actual Anthropic prepared adapter and its HTTP serialization/measurement path with **stubbed global fetch**. The selected URL is explicitly `http://controlled.invalid/v1/messages`. This is controlled in-process transport evidence; it does not make a real network request. It checks the depth-6000 serialized argument, exact `max_tokens = 2048`, the measured HTTP-body byte count against the actual serialized body, successful continuation, exact caller Stop propagation, settled fetch invocations, zero dispatch/effects, and zero additional send/events after Stop.

**HTTP fit limitation, accepted by root:** configured `contextWindow = 1000000` gives read-only heuristic pressure `{ kind: known, basis: legacy-shared-assumption, hardFits: true, targetReady: true }`; admission remains `unavailable`, disposition `compatibility`, reason `capacity-unknown`. Output-cap support is real and the body contains the asserted cap. No provider model capacity domain or verified provider-capacity certificate is invented. The title's historical “actual HTTP route” wording is unchanged for same-name comparison and denotes the actual adapter path under stub fetch.

The reasoning cases bind initial `atSeq` to the actual provider block boundary and `streamId` to the original step sequence, replacing the historical absolute index. They preserve first-delta immediacy, 50 ms batching, offsets/order, canonical full reasoning, distinct identities across adjacent blocks/tool rounds/followups, and uninterrupted reasoning around usage. Cancellation now checks exact custom and default `AbortError` reason identity, the composed provider signal, timer cleanup, no progress after Stop/settlement, retained original prefix, and distinct retry identity. The held provider is always released and joined; its rejection is handled immediately.

The freshness pair admits a real prepared candidate through `createAdmission`, `createAgentContext`, `createStepInput`, and `createRecovery`. Contradictory dispatch after a never-dispatched error result correctly changes the exchange to `unresolved` with `unknown` call outcome. Assertions bind exact protected item/source identities, including dispatch coordinates; semantic revision, branch, epoch, and surface remain stable while protection revision changes. The actual prepared transport guard rejects `CONTEXT_INPUT_STALE` with zero transports. Actual reduction grouping/currentness/run selection refuses replacement of the protected unresolved exchange, with zero compaction events. Existing settled-success and pending-to-unknown controls remain.

## Genuine freshness fixture lifetime and P2 boundary

Root authorized an additive fixture correction after the first final combined gate: construct `createNondurableFactOwner(session).beginAction()`, pass actual `action.facts` and `action.assertOpen`, and supply `registerFactSource` using actual `action.registerSettlementSource(drain)`. Every real registered source is tracked. The fixture closes candidate execution, finishes the action, and joins **all** source closes via `Promise.allSettled`; close failures remain visible through `AggregateError`. There are no fake/no-op FactPorts and no product fallback.

This branch remains based on BASE's `createRecovery(deps, context)` API, which has no returned `close` method. P2 is concurrently adding per-response held recovery source ownership while retaining the constructor signature and requiring genuine `deps.registerFactSource`. The new fixture already provides that capability and drains registered sources, but the future helper close method has **not** been imported, probed, emulated, or tested here. Root was notified before and after commit.

**Serial integration action after P2 lands:** retain the created recovery helper as a named fixture local, pass that local to `createAdmission`, and await its actual `close()` after candidate execution closes and before the enclosing source/action cleanup. The current constructor is inline, so this requires naming the local as well as adding the close await. Root must run the affected freshness/type gate against the real combined P2 API. This packet does not claim that future cross-branch integration is already verified.

## Preserved command and exit index

All runtime commands ran sequentially from `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main/packages/core-agent`. Evidence directory: `D:/I-harness-main/.superpowers/sdd/2026-10-24-agent-contract-regressions/evidence`.

Vitest command template: `pnpm exec vitest run <scope> --maxWorkers=2 --minWorkers=1 --reporter=default --reporter=json --outputFile.json=<evidence>/<receipt>-tests.json`.

| Receipt stem | Exact test scope / command | Exit and observed result |
|---|---|---|
| `baseline` | `test/deep-context-request.test.ts test/reasoning-streaming.test.ts test/context-effect-freshness.test.ts` | 1; 10 failed / 4 passed at exact BASE, preserved from prior owner |
| `iteration-1` | same three files | 1; 1 failed / 13 passed; new fixture read signal reason before abort, corrected with pre-created DOMException |
| `iteration-2` | same three files | 1; 2 failed / 12 passed; exact protection list omitted new dispatch source, corrected |
| `iteration-3` | `test/context-effect-freshness.test.ts` | 0; 4 passed |
| `iteration-4` | `test/deep-context-request.test.ts` | 0; 5 passed |
| `typecheck-1.raw.txt` | `pnpm run typecheck` | 0; `tsc --noEmit`, preserved prior-owner semantic-source gate |
| `final-combined` | all three files, before genuine fact-action addition | 0; 14 passed |
| `final-typecheck.raw.txt` | `pnpm run typecheck`, same pre-addition source | 0 |
| `final-freshness-owned` | `test/context-effect-freshness.test.ts`, initial genuine fact-action fixture | 0; 4 passed |
| `final-owned-typecheck.raw.txt` | `pnpm run typecheck` | 2; TS18048 at guarded-stream closure because mutable cleanup candidate could be undefined; corrected using stable admitted local |
| `final-owned-combined` | all three files on final committed source | **0; 14 passed**, 3 files passed, 11.15 s |
| `final-owned-typecheck-2.raw.txt` | `pnpm run typecheck` on final committed source | **0** |
| `final-owned-diff-check.raw.txt` | `git diff --check` | 0; only Git LF/CRLF conversion warnings, no whitespace error |
| `commit.raw.txt` | `git commit -m 'test(agent): qualify deep request reasoning and effect contracts'` | 0; created `f5bf396e` |
| `final-git-show.raw.txt` | `git show --format=fuller --stat HEAD` | 0; committed three-file scope |

Each Vitest stem has both `.raw.txt` and `-tests.json`. Earlier `final-source/` and `same-name-comparison.*` snapshots describe the first final gate before the owned fact-action addition and remain intact. Authoritative final snapshots are explicitly prefixed **`final-owned-`**.

The one additional type failure was fixture-only TypeScript closure narrowing, not a product failure or swallowed cancellation. Its original receipt remains. The final combined gate was rerun after that correction so all 14 tests bind to one stable final source. No whole suite was run.

## Same-name and physical/Git binding

`final-owned-same-name-comparison.json` contains all fourteen exact full names, baseline/final statuses, and complete original failure messages. It validates 14 tests on each side and exact full-name presence without renames. `final-owned-same-name-comparison.txt` is the readable ten-failures-to-pass / four-controls-still-pass index.

`final-source-git-binding.json` records exact BASE/HEAD/range, branch, clean worktree, final receipt names, every test's physical SHA-256, final snapshot SHA-256, BASE blob, HEAD blob, and `git hash-object --path=<path> <path>` result. Physical copies in `final-owned-source/packages/core-agent/test/` exactly match the runtime files; filtered source blobs exactly match committed HEAD blobs. This accounts for repository line-ending filters without claiming physical bytes and Git blobs are the same hash algorithm/representation.

| File | Physical runtime/copy SHA-256 | HEAD Git blob |
|---|---|---|
| `context-effect-freshness.test.ts` | `ba35f960744385bd7bcca80fab546b2a91c1c09089398cd189a17e81c038d1e6` | `f77297d5aa70db03c9695f6a6ccbf3a9e9dd9d99` |
| `deep-context-request.test.ts` | `73b211873b50973b84c837d30ede039160bc3e03f47b7d4eeb7c6238d72d32e0` | `9125d0eb4875f48b3361b9d195cb78fbbfe3e031` |
| `reasoning-streaming.test.ts` | `78422ef30b1ea513b9d1de1aef4196f12053156343225836e8ca0381f28d2ee7` | `5a9b35fe4ac3ce4494a04339c7b91efc47424892` |

The same manifest hashes all preserved raw/JSON receipts existing when it was written. Postcommit `git status --short` was empty and exact-range `git diff --name-status` listed only the three assigned tests. No test source changed between the final combined/type gates, source copies, and commit.

## Rulings and review state

1. Root-approved HTTP qualification: use the actual configured-budget heuristic-fit observation while preserving unavailable admission and unknown capacity. Cost if mistaken: overstating provider authority; mitigated by exact assertions and the explicit limit above.
2. Root-authorized genuine fact-action fixture composition: prepare the test for P2's required registration contract without importing unlanded APIs. Cost if integration is skipped: P2 helper lifetime may remain unclosed in the direct fixture; the exact serial integration action is recorded above.
3. Preserve the handoff's RED evidence and failed iterations rather than restart the packet. Cost if source identity were wrong: invalid baseline comparison; mitigated by exact BASE, unchanged original test names, preserved JSON failures, and committed source binding.

No new product defect was found in this bounded packet. No deferred minor finding has been identified by this author. **Fresh independent Sol review is pending and owned by root.** The implementer stops writing at this handoff; no merge or remote operation is requested or performed.
