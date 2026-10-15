# R1A semantic projection — reviewed implementation

Root status: complete after independent review and fix round1, range8af7cf42..b122fd9b. The implementation report below preserves its initial and fix evidence; any initial pending-review statement is historical. Final review: I1 addressed, spec/quality approved, no newCritical/Important. Product version0.1.13-rc.1; format2 remains unchanged in R1A. R1B/C/D and broaderqualification are not completed by this report.

# R1A Task 1 implementation report

Status: implemented and verified; root's fresh spec/quality review remains required. No R1B/R1C/R1D or S/CX completion is claimed.

Baseline: branch `codex/v0.1.13-development`, `8af7cf42fce728b33e9dea6df14031f0bda4c5dc`. All work local in `D:/I-harness-main`. No recursive agents, remotes, live providers, profile changes, dependency changes, event/writer/schema/serialization changes, or adapter package baseline reruns.

## Delivered boundary

- `projectConversation(session, { ownerSessionId?, throughSeq? })` and `renderConversation(projection)` are public exports alongside the exact Conversation DTOs. Diagnostic union additionally has `missing-source-seq` and `invalid-source-seq` per root's explicit contract ruling and normative-doc update.
- Existing `deriveMessages` and `deriveMessagesUpTo` are facades over the same semantic projector and renderer. There is no retained legacy message fold or inference from an already flattened message array.
- Source refs originate at actual archive indices; uniquely valid nonnegative safe-integer seqs are durable addresses. Missing/invalid/duplicate coordinates get event-index-qualified opaque IDs and no seq/addressable authority. Owner IDs isolate identical source coordinates across sessions.
- Provenance is recorded admission/source evidence, never text classification. Exact earlier admission ID/text/intent plus safe durable coordinates may establish human/request; plugin/internal/system/synthetic inputs are observation, known task/team-result display metadata is child-report, summaries derived, unadmitted legacy users unknown. Child seed inputs are inherited with only known parent session ID and child archive coordinates. An inherited admission cannot establish fresh local human-request authority.
- The sole fold attaches call/assistant/result/dispatch/image refs and keeps complete exchange bundles. Deferred reminders remain their own source/provenance/input items at the existing output position. Legacy stepless groups are explicitly inferred. Failed/unresolved groups retain refs and scalar call facts with empty rendered messages; no hidden full archive payload is retained just to render active items.
- Metadata envelopes/source/provenance/call/diagnostic containers are owned and frozen. Render copies plain object/array message containers, native sidecars, images and argument containers. Arbitrary non-plain unknown arguments remain opaque; this is not an immutable validated ContextSnapshot or a claim to deep-freeze arbitrary legacy payloads.

## RED/GREEN evidence

1. Added 22 independent semantic API tests before production implementation. Corrected an image fixture field (`dataBase64`) before taking the final expected RED. `red-semantic.log` records 22/22 failures because public `projectConversation` was missing, exit 1.
2. First implementation: 21/22 passed and all original 135 session tests passed. Remaining failure was an incorrect test assumption that core JSONL helpers serialize Session.header. Existing helpers intentionally encode events/format only; no serialization changes were made. Child roundtrip fixture now copies the separately held header, matching storage restoration scope. `first-green-semantic.log`: 22/22, exit 0.
3. Added 10 focused evidence-edge cases. `red-evidence-edge.log`: 2 failed/30 passed, exit 1. Independent failures proved inherited admissions were granting local request authority, and a shadowed tool/call was missing the partial-exchange-shadow diagnostic. Both corrected at their source owners. `green-evidence-edge.log`: 32/32, exit 0.
4. Final core-session suite: 167/167 (135 originals + 32 new), exit 0. Final core-session types: exit 0. New cases assert literal ordered messages, concrete call/result/dispatch/assistant/image event indices, failure/outcome facts, source safety, authority and item selection, not just equality of the facade and its implementation.

## Commands and actual exits

All Vitest suites ran sequentially with `--maxWorkers=2 --minWorkers=1`. Logs are beside this report.

| Command | Result / exit | Log |
| --- | --- | --- |
| `pnpm --filter @i-harness/core-session exec vitest run --maxWorkers=2 --minWorkers=1` (baseline) | 135/135; 0 | `baseline-session.log` |
| `pnpm --filter @i-harness/core-session typecheck` (baseline) | 0 | `baseline-types.log` |
| `pnpm exec vitest run e2e/context-corpus.e2e.ts --config e2e/vitest.config.ts --maxWorkers=2 --minWorkers=1` (baseline) | 57/57; 0 | `baseline-corpus.log` |
| `pnpm --filter @i-harness/core-session exec vitest run test/conversation-projection.test.ts --maxWorkers=2 --minWorkers=1` (RED) | 22 missing-API failures; 1 | `red-semantic.log` |
| Same focused command (first GREEN) | 22/22; 0 | `first-green-semantic.log` |
| Same focused command (edge RED) | 2 failed/30 passed; 1 | `red-evidence-edge.log` |
| Same focused command (edge GREEN) | 32/32; 0 | `green-evidence-edge.log` |
| `pnpm --filter @i-harness/core-session exec vitest run --maxWorkers=2 --minWorkers=1` (final) | 167/167; 0 | `final-session.log` |
| `pnpm --filter @i-harness/core-session typecheck` (final) | 0 | `final-session-types.log` |
| `pnpm --filter @i-harness/core-agent exec vitest run test/agent.test.ts test/context-recovery.test.ts --maxWorkers=2 --minWorkers=1` | 80/80 (47 + 33); 0 | `final-agent.log` |
| `pnpm exec vitest run e2e/context-corpus.e2e.ts --config e2e/vitest.config.ts --maxWorkers=2 --minWorkers=1` (final) | 57/57; 0 | `final-corpus.log` |
| `pnpm exec tsc --noEmit -p e2e/tsconfig.json` | 0 | `final-e2e-types.log` |
| `node scripts/audit/check-reachability.mjs --json` before/after | 0 for both; exact 408-row parity after owner adaptation | `reach-before.json`, `reach-after-before-map.json`, `reach-after.json`, `reach-comparison.json` |
| `node scripts/audit/check-reachability.mjs --self-test` | 82/82; 0 | `final-reach-selftest.log` |
| `pnpm verify:reachability` | PASS, no new rows; 0 | `final-reach-gate.log` |
| `node .superpowers/sdd/2026-10-15-context-engine-r1-projection/measure-sizes.mjs` | 0 | `sizes.json`, `sizes.log` |
| `git diff --check` | 0 | `final-diff-check.log` |
| `git diff HEAD^ HEAD --check` (committed change) | 0 | `final-committed-diff-check.log` |

Intermediate logs preserve first implementation output (`iteration-semantic.log`, `iteration-session.log`, `iteration-corpus.log`). The first typecheck identified one unused type import, then removed. No unchanged adapter package suite was run.

## Concrete compatibility and source proof

- New test's real 9-event parallel exchange has step 0, calls 1/2, assistant 3, dispatch 4, reverse result B 5, reminder 6, result A 7 with image companion, end 8. It asserts those exact refs, literal native `outputOrder` and opaque reasoning content, literal rendered message contents, reverse result order B/A, image after the tool results, reminder last. Every exchange source is checked against the event at its archive index.
- Headerless live versus JSONL-restored projection deep equality is tested on that native parallel fixture, including semantic item IDs and metadata. Child inherited equality is separately tested after explicitly restoring a copied header from source metadata; no parent seq is invented.
- Literal compacted-step fixture retains shadowed step/start as exchange boundary, summary before accepted call/assistant/result bundle, plus `partial-exchange-shadow`. Existing repaired compacted-step tests still verify shadowed end and failed markers. Explicit rewind fixture excludes abandoned lifecycle and never restores reset-hidden text.
- Prefix fixture asserts original archive count and throughSeq, exact pruned text despite the prune marker past the cut, and exclusion of the later summary. All original prune/rewind tests pass.
- Missing/negative/fractional/duplicate coordinates have distinct diagnostics, unique item IDs and no safe seq. Duplicate call identities have unknown outcomes; unmatched results and dispatches have scalar diagnostics.
- Outcome cases include generic error, canonical `isError:true` + `TOOL_OUTCOME_UNKNOWN` + `replay:false` on a log with no dispatch marker, code-only collisions, code/error without repair descriptor, failed-attempt not-dispatched evidence, contradictory matching dispatch => unknown, missing result with open versus closed attempt. Rendering keeps actual output/error bytes and never manufactures tool results.
- Selection fixture renders an exchange alone and gets assistant + tool + image companion as one complete bundle; selecting reminder alone gets its own input/source.
- Purity fixture compares original full Session JSON (including header) and JSONL before/after projection/render and mutations to separately rendered argument/native/container objects. Metadata/source/call arrays are frozen, render arrays/message objects are fresh.

## R0 carried ownership oracle

The existing six-route corpus ownership case now physically sends **both** prepared handles after caller objects are mutated: original `prepared` (1024 cap) followed by its pre-created `capped` derivative (2048 cap). Separate physical capture entries and separate bodies are retained/asserted. Both bodies receive concrete system/tool schema, call/result pairing, native continuation order/signature, unchanged provider options and absence-of-MUTATED assertions. `send` independently compares each handle's measured HTTP-body or SDK-command packet size with that handle's physical capture. Subscription explicitly keeps cap unsupported and records two auth calls. All 57 corpus cases pass; no adapter implementation changed.

## Structure, ownership and audit gate

`measure-sizes.mjs` uses the TypeScript AST and baseline git source, with actual outputs in `sizes.json`.

| File | Before lines | After lines | Main function |
| --- | ---: | ---: | --- |
| `projection/messages.ts` | 313 | 15 | derive APIs 3 lines each; previous `deriveMessages` was 238 |
| `conversation/project.ts` | — | 133 | `projectConversation` 108 (sole output fold) |
| `conversation/legacy.ts` | — | 112 | `inferLegacy` 83; `recordedOutcome` 11 |
| `conversation/sources.ts` | — | 61 | source catalog 55, provenance closure 30 |
| `conversation/visibility.ts` | — | 30 | visibility 22 |
| `conversation/exchange.ts` | — | 35 | item publication 10 |
| `conversation/render.ts` | — | 25 | container copy 10; rendering 3 |
| `conversation/types.ts` | — | 57 | public DTOs only |

`exchange.ts` is the brief's allowed extra cohesive module: it owns projection-local mutable builders and frozen publication, preventing fold mechanics from owning DTO sealing. No empty scaffolding. The >100-line projector remains one bounded protocol unit because calls/results/images/reminders share flush state; splitting the loop would create parallel ownership. Legacy inference has only scalar/index maps and suppression facts and never constructs messages.

State owners: source coordinate counts/cache in `sources.ts`; shadow set/rewind windows in `visibility.ts`; legacy call/result/dispatch maps, step evidence and suppression in `legacy.ts`; admissions, message buffers, deferred inputs and output-order ownership in the sole `project.ts` fold; local builder publication in `exchange.ts`. None escape as a session/archive closure. `render.ts` only walks selected item bundles. Core-session imports no core-agent, llm package, core-tools/tool-runtime or compaction package. New production consumers of semantic APIs are the existing message facades; all external callers still use the public core-session entry.

Before owner adaptation, moving the old internal RewindCut read into `conversation/visibility.ts` falsely retired exactly one baseline unused-export row. Added exactly that path to the existing `CORE_SESSION_SOURCE_UNIT`; no reseed, allowlist change, fake consumer or broad directory exemption. Actual before/after row sets are identical: 408 findings, digest `6af28bcbcb72706b3184f9b55025616f2e5c0358393538dce578312eb566eab4`. New project/render public exports remain real facade-consumed APIs. Audit self-tests and gate pass.

## Self-review and remaining limits

- Checked mandatory behaviors 1–8 against tests, public exports, fold/source owners and wire corpus. No format/version/writer/admission-policy change.
- Root resolved coordinate diagnostic names and legacy outcome ambiguity before finalization; normative contract remains root-owned. Result metadata is reported evidence, never authenticated producer identity, tool-effect certainty or replay authorization. Conservative unknown may discard specificity in contradictory/ambiguous historical records; the raw archive stays intact.
- Core JSONL helpers still omit lineage headers. R1A inherited-roundtrip proof assumes separately restored storage metadata. Actual coordinator persistence/header integration belongs to the later persistence unit.
- Metadata is frozen, but arbitrary unknown legacy values are not fully immutable, especially non-plain values. Message content is a newly owned plain-container copy; a validated deeply immutable request snapshot remains R1C work.
- Legacy acceptance remains inferred, including historical repairs and incomplete records. No explicit format3 acceptance fence, current-input protection policy, structural reduction policy, positional replacement, freshness CAS, transactional publication, or route/account binding certification is introduced.
- Only the named required core-agent consumers were run; no assertion of full monorepo test completion or live-provider validity.

Commit: `7da8898782ffa3e6a290baeda3e6f88ae344e1a7` — `refactor(session): project typed conversation sources and exchanges`.

The staged check caught one trailing blank line in the newly added legacy module (the earlier unstaged check does not cover untracked files). Removed it and amended this own scoped commit; the actual committed before/after diff now passes check, exit 0. Root's normative contract edit remains intentionally unstaged and outside this product commit. No product changes remain uncommitted.

## Fix round 1 — Important I1, stepless selectable bundle ownership

Fix baseline: `3460c87848248c82d479acec912c10d2de9bc49a`, containing the original product commit and root's contract clarification; clean worktree before fix. Read the complete `task-1-review.md`; applied receiving-code-review/systematic-debugging/TDD workflows. No agents, remotes, providers, dependency changes or broad consumer/audit reruns.

**Root cause confirmed.** `flushToolBlock` discarded its builder whenever `stepOpen` was false. Thus `tool/call(0) → assistant/message(1) → tool/result(2)` had looked-ahead result metadata on item 0 but no actual result message in that item. The intervening assistant and later result were separate items. Full rendering looked correct while selecting the advertised closed exchange exposed an unanswered call. `finishItem` trusted a looked-up `call.result` ref rather than evidence that the same bundle consumed it.

**RED.** Added three focused cases before product edits. The two contiguous cases (plain result and image result) assert the complete literal old full order, concrete call0/assistant1/result2/image2 refs, and the identical complete bundle when selecting only that exchange. A third case puts a separately attributed plugin input between assistant and image-bearing result: it asserts the literal full output order, independently selectable input/source/provenance, later legacy fragment, and an unresolved split call bundle. `fix1-red-semantic.log` records 3 failed/32 passed, exit 1. Contiguous cases failed because assistant/image sources and results were outside the exchange; the input-boundary case failed because the incomplete bundle advertised `closed`.

**Fix at the existing state owner.** `project.ts` retains the current builder while its known results have not been consumed, even without step markers. An intervening assistant message joins that builder in its existing emitted order and retains its actual source/native sidecar. The result branch records its consumed source ID before buffering result and image companion messages. Independent input/summary/lifecycle boundaries explicitly release the owner so later result fragments keep their original output positions. `exchange.ts` now tracks projection-local `receivedResults`; it never publishes `closed` based only on look-ahead result evidence. When a separately attributed input prevents one contiguous safe bundle, the earlier item remains `unresolved`, preserving the actual later result ref without pretending its message belongs to that selectable item. No extra fold, flattened-message guesser, format change, new DTO/policy, or hidden archive capture was added.

**GREEN and covering commands.** All Vitest commands sequential, maxWorkers2/minWorkers1; each log records actual output and `EXIT`.

| Exact command | Actual result / exit | Log |
| --- | --- | --- |
| `pnpm --filter @i-harness/core-session exec vitest run test/conversation-projection.test.ts --maxWorkers=2 --minWorkers=1` before fix | 3 failed/32 passed; 1 | `fix1-red-semantic.log` |
| Same focused command after fix | 35/35; 0 | `fix1-green-semantic.log` |
| `pnpm --filter @i-harness/core-session exec vitest run --maxWorkers=2 --minWorkers=1` | 170/170 across 18 files; 0 | `fix1-session.log` |
| `pnpm --filter @i-harness/core-session typecheck` | 0 | `fix1-session-types.log` |
| `pnpm exec vitest run e2e/context-corpus.e2e.ts --config e2e/vitest.config.ts --maxWorkers=2 --minWorkers=1` | 57/57; 0 | `fix1-corpus.log` |
| `pnpm exec tsc --noEmit -p e2e/tsconfig.json` | 0 | `fix1-e2e-types.log` |
| `node .superpowers/sdd/2026-10-15-context-engine-r1-projection/measure-sizes.mjs` | 0, old measurements preserved separately | `fix1-sizes.json`, `fix1-sizes.log` |
| `git diff --check` | 0, Windows line-ending warnings present | `fix1-diff-check.log` |

The original report's session count was 167. The new final count is now **170**, after adding exactly these three cases. Original and derivative six-route ownership assertions still pass physically in the corpus. No core-agent broad suite or unchanged reachability gate was repeated: public signatures, admission/visibility/legacy inference, source-owner audit map and external consumer integration did not change; the session fold and six-route wire oracle cover this fix boundary.

**Source sizes / ownership.** AST measurements compared with the preserved pre-fix output: `conversation/project.ts` 133 → 140 lines, `projectConversation` 108 → 115, `flushToolBlock` remains 11; `conversation/exchange.ts` 35 → 41, new `awaitingItemResults` 3 lines, `finishItem` remains 10. Other source modules are unchanged. The sole fold still owns result receipt and output positions; the builder helper only records/publishes whether its own results were consumed. The receipt Set is projection-local and is not returned in the DTO. Self-review checked the diff, full-order/selected-bundle assertions, source refs, boundary cases, and all covering logs.

**Minor M1 acknowledged.** Earlier audit output is not pristine: `final-reach-gate.log` contains the pre-existing inert allowlist warning for `@i-harness/sdk#SdkRunError` (audit/SDK owner), despite exit 0 and exact task row parity. Earlier and current working-tree diff checks also contain normal Windows LF/CRLF warnings, despite exit 0. These were not silenced by widening the audit map/allowlist, and no such audit edit belongs to this fix. The original committed-diff check was clean. No claim that all validation output is warning-free is made.

Fix commit: `b122fd9be507eeca4400221988682eb360ad7b09` — `fix(session): retain complete stepless exchange bundles`. Committed-diff check `git diff HEAD^ HEAD --check` is clean, exit 0 (`fix1-committed-diff-check.log`); worktree clean. Root's scoped re-review remains required.
