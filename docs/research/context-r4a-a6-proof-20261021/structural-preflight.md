# A6 bounded structural preflight: four inherited large owners

Read-only assessment, 2026-10-21. Original R4A BASE: `91d8fef04253272a437c68f5f2f84a657fa53d3b`. Assessed accepted source: `6ac43a4d0892255e3588bbed59d260c002b2cd54`. This report is advice to root for A10, not acceptance of these functions, R4A, or a decomposition counter change. No runtime, test, build, product/helper, Git-state or agent changes were made. The only written artifact is this report.

## Recommendation and limits

Recommend **renewing four individually bounded cohesion exceptions at the assessed source**, with the responsibility/invariant qualifications below. None is byte-unchanged; all retain their previously reviewed state/lifetime boundary. `output.ts` has the most substantial behavioral replacement and deserves explicit renewed review, rather than inheriting acceptance by filename. Its new complete-result storage, artifact operation, pinning and same-operation reconciliation authorities already live outside this factory. The other changes add narrow handoffs/fences inside their original owners. I did not find a new independent algorithm/state authority in these four functions that must be extracted before A10 can be considered.

This is not a blanket exception for future growth. A new store/capture operation, result revision authority, scheduler, publication queue, journal issuer or lifecycle state machine placed into these functions would invalidate this recommendation. The functions remain over the ordinary 120-line target; three already exceeded the 250-line hard-candidate threshold at original R4A BASE, and spawn now crosses it. Those facts are recorded, not treated as passes. Root must decide whether the current concrete exceptions satisfy A10 after reviewing this report with the full-stage evidence.

## Governing scope and previous rationale

- `docs/refactoring/2026-10-15-context-decomposition-overlap.md:11–12,91` defines >=800 file lines, >=250 function lines or >=18,000 function characters as risk candidates, expressly not completion criteria; a hard candidate requires responsibility treatment or a concrete cohesive exception. Its S9/S15/S18 rows preserve completed skeletons and require changed-behavior regression, with no repeated decomposition credit.
- `docs/superpowers/specs/2026-10-15-context-engine-framework.md:119–121` requires one state owner, narrow interfaces and dependency direction, with a specific decomposition or named exception. It prohibits an all-locals bag and utility dumping.
- Original R4A plan `docs/superpowers/plans/2026-10-18-context-engine-r4a-retained-results.md:24–30,356` requires original capture/receipt ownership, focused new responsibilities, and cohesive folders/one state owner plus actual evidence for A10. It does not convert every existing orchestration closure into an automatic new decomposition task.
- The original F1 plan `docs/superpowers/plans/2026-10-16-context-engine-r3-managed-facts.md:18,30,158,204–210` assigns one document/prefix/queue/receipt lifetime to managed-document and one task/publication/foreground lifetime to spawn, with actual start/end capture and publication proof owned separately.
- Actual original F1 review `.superpowers/sdd/2026-10-16-context-engine-r3-managed-facts/task-1-review.md:79–83` explicitly assessed these same four longer owners. It explains the document prefix/queue/pending/private-index/incarnation cohesion, the detached output window/byte reservations/observer/continuation cohesion (including `project`), the cell completion/store/terminal cohesion, and spawn orchestration with a separate spawn-source. This is stronger evidence than the implementer's size rationale. The review still required its concrete correctness fixes.
- `.superpowers/sdd/2026-10-16-context-engine-r3-managed-facts/task-1-rereview-1.md` scopes the correction acceptance; `docs/research/2026-10-17-context-engine-r3-f1-verification.md:31` records the cohesion ruling and explicitly says it is not a general size waiver or new decomposition credit.
- The accepted 2026-10-21 structure unit's 47-file no-hard-candidate result concerns its task/legacy/S25 scope. It does not count these four functions as small or dispose of this broader original-range A6 census. Its separate catalog/artifact/job exceptions likewise do not waive these four.

Broader assembly/service/host/SDK/IPC/Workbench/CX1 and R5/R6 work remains separately recorded debt. This preflight does not expand that scope or claim S20/S21/S22/S23/S25/CX2 completion, whole-stage acceptance, release, or movement from original 27/43.

## Exact source-text AST measurements

Method: TypeScript `createSourceFile` over the actual `git show REV:path` source text for both revisions, plus a read of the current four checkout files. No product module was imported. Function start is `node.getStart(source)`; end is `node.getEnd()`; line span is inclusive. Characters are JavaScript string code units from start through end, including intervening comments/whitespace. File line counts include blank/comment lines and exclude the final empty split from a terminal newline. Nested function spans overlap their containing factory; they are not additive.

Git blobs are LF. The current output.ts checkout has CRLF; its function's 347 interior CR characters explain the census's 19,309 versus the committed blob's 18,962. Other three checkout files are LF and byte-equal to assessed committed source. Normalizing checkout output.ts from CRLF to LF yields the assessed committed text; this is a source-text equivalence observation, not copied-runtime verification.

| File / named factory | Original BASE function range | BASE lines / chars | Assessed committed function range | Current lines / chars (LF blob) | Actual checkout chars | File lines BASE → current |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/code-mode/src/runtime/output.ts` / `createOutput` | 12–349 | 338 / 17,457 | 26–373 | 348 / 18,962 | 19,309 | 350 → 374 |
| `packages/code-mode/src/runtime/retirement.ts` / `createRetirement` | 6–285 | 280 / 11,138 | 6–286 | 281 / 11,196 | 11,196 | 286 → 287 |
| `packages/subagent/src/tools/spawn.ts` / `createSpawnTool` | 9–249 | 241 / 14,311 | 10–263 | 254 / 15,405 | 15,405 | 257 → 271 |
| `packages/session-persistence/src/coordinator/managed-document.ts` / `createManagedDocument` | 48–391 | 344 / 17,733 | 48–400 | 353 / 18,666 | 18,666 | 391 → 400 |

| Significant nested function | BASE lines / chars (LF) | Current range | Current lines / chars (LF) | Current checkout chars |
| --- | --- | --- | --- | --- |
| output `project` | 155 / 9,314 | 102–265 | 164 / 10,693 | 10,856 |
| output `output` | 71 / 3,026 | 30–101 | 72 / 3,128 | 3,199 |
| output `observe` | 54 / 2,603 | 318–371 | 54 / 2,603 | 2,656 |
| output `retainObservation` | 52 / 2,107 | 266–317 | 52 / 2,107 | 2,158 |
| retirement `complete` | 164 / 6,442 | 85–249 | 165 / 6,500 | 6,500 |
| spawn `execute` | 186 / 10,693 | 62–260 | 199 / 11,787 | 11,787 |
| spawn `onSettled` | 30 / 1,450 | 166–205 | 40 / 2,238 | 2,238 |
| managed-document `run` | 68 / 3,766 | 151–218 | 68 / 3,830 | 3,830 |
| managed-document `beginAction` | 54 / 3,224 | 292–353 | 62 / 3,920 | 3,920 |

The original-range file diffs are output +75/-51, retirement +2/-1, spawn +22/-8 and managed-document +18/-9. These are replacements/additions within existing owners, not four unchanged-file waivers. In particular, 338→348 alone understates output's changed retention semantics. The hard-character triggers remain present on LF for both output and managed-document, so line-ending normalization does not remove their candidacy.

Assessed LF SHA-256 values, reproducible directly from the committed source text:

| File | Original BASE SHA-256 | Assessed source SHA-256 |
| --- | --- | --- |
| output.ts | `1e877f9dd65c8403413572f972ef08f6ee830b4b5ba5dd88687d8f9e43f7501b` | `047b9db1e93aa546186a7d56d753446f06c4c0fb0778e99731b01a0fca099331` |
| retirement.ts | `4f327e5e80adafc982cca1d369ee95474b906e920f0a5398944d1a14eb573715` | `8e6a595b29f29c3c1d76be96def8f4ffb77d309638d5da1360bdcc795434dbc1` |
| spawn.ts | `d3a8e57ccdb11353d618fd584f8a60d0aace6896d324c009c47933df9a3fb2cf` | `0eaa86978209966051a58b7d17ecb54b3a89e08496e1bbad142e178996a2dad2` |
| managed-document.ts | `6e78c804f1dc2b8a4f8908752f0759200997f9354ba32fc7d30fc093f1f41345` | `ec90b7d6169d6cf8860a966a7b833218591ec8b162f89ed43a1012b266230e7b` |

## 1. Code Mode output: renew the detached-window exception with explicit R4A mapping

**Original responsibility → current owner:**

| Original responsibility / retired path | Current owner / interface | Authority and lifetime |
| --- | --- | --- |
| Guest item admission, capacity reservation, receipt-gated item installation | `runtime/output.ts:30`, `output(cell, encoded)` | Same `Cell` pending/admitted/retained bytes/items and `cell.admission`; event's once-only committed callback installs the actual item. |
| Detached consumed window, bounded text/image projection, observer ownership and resumed passive observation | `runtime/output.ts:102,266,318`, `project`/`retainObservation`/`observe` | Same admitted window, observer flag/wake and pendingProjection continuation. CellState still owns cell registry and producer tracking; Retirement still owns executable/terminal lifetime. |
| Old observer-time full-text persistence and implicit spill fallback | Replaced by existing host `retainText` port; `session-executor/src/lifecycle/code-text-retention.ts` implements artifact capture/confirmation/reconciliation | Runtime no longer owns a spill store. Host result store owns artifact authority and operation/pin lifetime. Standalone observer-time retention remains explicit and has no-owner/unavailable dispositions. |
| Original already-admitted item's captured retention result | Output-local `WeakMap<CodeModeItem, CodeModeTextRetentionResult>` populated only by original `committed(captured)` | Associates item identity with its receipt-stage result; it is neither a second raw archive nor an issuer of facts/refs. |
| One/many original text-item descriptor projection | Same project chooses single original result or constructs ordered `code-text-index-v1`; top-level `applyTextRetention` maps host disposition | Index members preserve interleaved nontext markers. Actual index artifact encoding/writing and recovery remain in host capture/store leaves. |

**Actual delta effects:** removes `createUnifiedSpillStore`, spill state and errorCap dependency; adds capturedText identity association; avoids joining/re-storing shipping text bodies; computes admitted bytes with newline separators; chooses original single ref or a host-retained ordered index; replaces contextRef/path with closed envelope/unavailable state. Captured passive observation may project already-real refs without a guest restart. Retention failure is kept separate from the guest execution outcome. Known pre-issuance cancellation and post-save Stop retain distinct truthful dispositions.

**Why this remains one cohesive owner:** output and observation must share the exact receipt-installed item identity and detached consumed window. Clearing the live window before an await, retaining the old window through unknown, installing recoveredProjection once, charging/releasing retained bytes/items and handing the next window to the next observer form the same lifetime explicitly reviewed in F1. The new WeakMap bridges that same admission/observation boundary; it does not acquire host artifact authority. `applyTextRetention` already isolates the stateless disposition translation. The new index construction is an 8-line request-data projection within that window, not a store, reader or new replay algorithm. Splitting the complete `project` state machine now solely to shrink the outer factory would relocate the previously accepted window lifetime or require passing its live locals and continuation state across a new boundary.

**Bounded recommendation:** renew for `createOutput` and its existing `project` at the recorded source. Keep capturedText local, current Cell identity and budget reset points, original per-item receipt callbacks, same continuation/signal, one observer and one store owner. No claim of constant whole-session memory: the pending/admitted window and actual configured capacity still matter. Any future substantial standalone index/preview algorithm belongs in a narrow stateless sibling; it must not become an all-locals projection bag or a second retention owner.

## 2. Code Mode retirement: renew the existing completion/store/terminal exception

**Original responsibility → current owner:** worker stop memoization stays in `stop`; one cell's termination/error/closed event stays in `close`; ordered store commits, real completion retention and terminal acknowledgement stay in `complete`; cancellation barrier/epoch and disposal stay in `cancel`/`dispose`. Cell registry/store/accepted producer membership remain in `runtime/cell-state.ts`, while host fact/source/reference ownership is outside this module. The single `commits` chain, stopping set, cancellation barrier and disposing promise are not copied into another owner.

**Actual delta effects:** precisely one behavioral correction: `await event(closed)` becomes `const receipt = event(closed); if (receipt) await receipt`. This is NAT-13's synchronous-ack correction from `docs/superpowers/plans/2026-10-20-context-r4a-native-producer-outcomes.md:25,71`. A void callback now reaches committed installation synchronously; an actual returned promise still blocks completion/store publication and capacity until acknowledgement. It adds no new responsibility or ownership, and does not move commit ahead of a real asynchronous F1/storage barrier. Ordinary promise/thenable assimilation remains via await rather than instanceof.

**Bounded recommendation:** renew `createRetirement` and its nested `complete` at recorded source. Keep the once-only store/terminal flags and original cancellation/retained-outcome checks together. Do not extract a new terminal owner or duplicate commit state to remove 31 excess lines. Full lifetime correctness still depends on source-qualified execution evidence; size cohesion is not proof that every schedule passes.

## 3. Spawn: renew orchestration exception; explicitly retain separate result and source owners

**Original responsibility → current owner:**

| Original responsibility | Current owner / interface |
| --- | --- |
| Role metadata/schema, current role revision and pre-effect depth/model/fork checks | `tools/spawn.ts` factory/roleMetadata/execute; original live deps/model selection remain read at invocation. |
| Actual task submit/CAS/claim/indexes and saved row | Existing TaskRegistry and `task/records.ts`/persistence leaves, reached by deps.tasks; spawn owns no record Map or result revision counter. |
| Child construction, initial durable publication and final launch fence | `spawnChild` and child lifecycle owners; same `source.assertLaunch`/`source.published` private boundary. |
| Parent start/end capture, immutable published identity, observed foreground/background retained outcome and recovery | Existing `tools/spawn-source.ts`, through start/prepareEnd/end/foreground/recoverPublished; source owns terminal capture and preparation memoization. |
| New full task body retention/revision and per-source store preparation | `task/result.ts` TaskResultOwner and actual registry result interfaces `prepareResult`/`retainResult`; spawn only passes the prepared result store. |
| Bounded child table/job projection from the task's actual result | `child/result.ts` `publishChildResult`; same table/job owners, no new spawn-local durable truth. |
| Foreground wait, deadline/steer/abort behavior and final source finish | Existing execute lifetime and `waitForObservation`; published child is not restarted when observation fails. |

**Actual delta effects:** source's save callback changes from mere flush to retainResult; prepareResult runs before start/launch and its store is passed into child; settling is marked before terminalization; the callback publishes current pending/settled task projection through the existing helper, prepares the same source-owned end after retention, and includes result envelope/revision. Claim now also records actual executed.jobId. Refusal-end projection includes a retained result if one exists. Task CAS continues to choose the outcome if Stop/close already terminalized it. No second task/capture/outbox/wake authority is created in this factory.

**Why crossing 250 is still an exception candidate:** the 13 added factory lines chiefly wire newly separated result owners into the existing launch→settle→observe lifetime. The enlarged onSettled callback is 40 lines, with an 11-line end preparation callback; it delegates capture/retention and once-only terminal preparation. Moving this callback into a new completion controller would risk hiding the task CAS/source/publication order and would not extract an independent algorithm currently stranded here. The existing roleMetadata is a separable 22-line cache, but it predates R4A and extracting it solely to make 254 less than 250 would be threshold cosmetics.

**Bounded recommendation:** renew recorded createSpawnTool/execute orchestration with no new task/result/source state added to spawn. Preserve exact original deps object/model/budget/context/window/reasoning bindings, prepared source store, callbacks' time of invocation, immutable source identity and actual publication fence. A future redesign of delivery/claim/wake remains R4C/R5; this exception does not accept those semantics wholesale.

## 4. Managed document: renew sole-writer exception with recoverable optional fence included

**Original responsibility → current owner:** managed-document retains one incarnation/held owner, private managed state/view/index, current prefix, optional/required authorization, queue, pending physical frame, installation and observation order. `fact-capacity.ts` still owns only ticket/FIFO scheduling; `fact-owner.ts` owns held/issuing authority; `fact-outcome.ts` validates/binds backend dispositions; `action-captures.ts`, `settlement-source.ts`, `source-facts.ts` and `settlement-fact.ts` retain source/capture/receipt-specific state; backend owns physical journal operations. `createManagedSessionState` owns structural staging/install. No alternative raw log, prefix, frame or second journal issuer was added.

**Actual delta effects:** adds source-keyed `recoveryHolds`; optional assertion/admission checks include those live holds both before and after capacity await; actual pre-issuance refusals preserve FACT_RECOVERY_REQUIRED; a held registered settlement source blocks/refuses optional queued work, while required actual-source outcomes can settle; successful source release removes that exact hold and releases its capacity fence; close refuses unresolved holds. `bindFactSettlementSource` gains the exact document id. Queue removal/ticket release/resolve occurs synchronously under the existing owner, not through a new lane or effect retry.

**Why these additions belong here:** only the original writer can atomically refuse already-admitted optional queue entries, enforce rechecks at physical issuance and retain the one pending suffix. The recoveryHolds set tracks document/source admission readiness, while capacity's recoverable set implements corresponding wait admission; they are updated synchronously with the same source identity and have different jobs. Neither stores a second fact or decides artifact settlement. Source lifetime/release remains in `createSettlementSource`, not in a new document-level result subsystem. Splitting this fence into a new generalized hold manager would need queue and capacity/lifecycle authority together, creating the locals bag the framework prohibits. This is a nine-line expansion of the existing optional-versus-required gate, not a new responsibility warranting that split.

**Bounded recommendation:** renew the recorded factory exception. Keep prefix/pending/install/queue/quarantine and source release authority singular; continue admitting required original facts under the existing scoped rules. Preserve sourceFault (nonrecoverable capture fault), recoverable source hold and unknown-journal quarantine as distinct states; exact physical reconciliation alone must not clear a still-live source hold. Current scope/identity must not be cached at a different time. No changes to journal issuance, close order or recovery are authorized by this report.

## Equivalence controls and remaining evidence

No extraction is recommended by this preflight, so there is no newly introduced extraction-equivalence test requirement or artificial RED to manufacture. This read-only report ran no tests and grants no new behavioral pass. Root must use the actual final freeze and its source-scoped gate receipts. Relevant **existing source controls inspected/located**, rather than newly executed evidence, include:

- `packages/code-mode/test/text-retention.test.ts`: detached retention overlapping later output/completion, bounded Unicode/error previews, independent consumed windows, incomplete source, no-owner disposition, disposal drain and preservation of true guest outcome on retention failure.
- `packages/session-executor/test/retained-code-output.test.ts:35,80,120,141`: real accepted text/image/text with exact member bytes/order/index, same-operation unknown finish without another guest, acting child document scope and actual restricted child assembly authority. `packages/code-mode/test/output-source-recovery.test.ts` and managed-store Stop controls cover original source/window/terminal interplay.
- `packages/code-mode/test/runtime.test.ts:408,422,433`: held asynchronous terminal acknowledgement, original failed/recovery acknowledgement and retained completed-cell bounds. These distinguish NAT-13 from prematurely committing all callbacks.
- `packages/session-persistence/test/fact-capacity.test.ts:51–60`: two source-keyed recoverable holds and release/resume scheduling; this leaf control alone does not replace an actual managed-document queue/issuance/close control.
- Original F1 coalesced-source recovery and cleanup diagnostics remain separate per-group-slice and receipt/observation controls; their historical passes cannot by themselves qualify the new R4A holds or result envelope.

If root chooses extraction despite the cohesion recommendation, the meaningful before/after controls are the following. This report has not established that every discriminator is already covered; missing controls should be determined by mapping actual test assertions/receipts, not by test counts or filenames:

| Potential extraction | Required discriminating equivalence at real public entry |
| --- | --- |
| Output's captured-member/index preparation | Same committed item identity; one-item original ref without a second artifact; exact mixed text/image/text index and member refs; no shipping body join/recapture; held index retention plus later output goes to the next window; unknown continuation preserves same detached window/bytes/items; Stop before issuance differs from a completed save; no-owner/unavailable never becomes stored. Compare exact values/order/counters and source authority, not just a final status. |
| Retirement completion/terminal orchestration | Void acknowledgement publishes synchronously, held promise withholds terminal/store/capacity, reject/FACT unknown preserves original semantics, and Stop cannot overwrite retained real completion; one commit, termination and closer; original producer drains and cancellation epoch unchanged. |
| Spawn settlement wiring | Actual task CAS already terminalized by Stop/close wins; prepare/store binding uses original source/exec; pending→retained table/job/end projection has same revision; held/unknown retention settles one original end and one child/body/finalizer; published foreground wait abort/steer/deadline preserves child lifetime; refusal before publication stays distinct from uncertain published child. Preserve actual profile/model/seed/grant/workspace bindings across awaits. |
| Managed document optional-hold fence | One optional entry queued before hold is refused/released once; one waiting for capacity is refused; hold introduced during backend wait is rechecked before issuance; two holds require both releases; original required facts remain saveable; wrong/closed source cannot clear another hold; sourceFault and pending-journal quarantine remain independently blocking; exact coalesced caller seqs, original key/one installation and failed-close retention stay unchanged. |

Any extraction should keep one authoritative capture/settlement/publication/lifecycle state and original current-value/await timing. Do not pass all factory locals in a dependencies object, copy Maps/Sets/counters into both modules, move the factory wholesale under a new name, compress formatting, or treat dropping below a threshold as evidence of equivalence.

Root's final record should state the four source-scoped decisions explicitly, retain the exact sizes including nested over-target functions, bind any final source drift to this report or a recheck, and leave all unrelated original decomposition/R5/R6 obligations intact.
