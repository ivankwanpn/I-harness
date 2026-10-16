# ContextEngine R3 F1 — managed fact publication evidence

Status: F1 implementation and first correction wave accepted by fresh full-range review and original-reviewer scoped re-review through `fdc2f32e`. All five Important findings and M1 are addressed; no new fix-diff defect was established. The unclassified close observation below remains open for full qualification. This is a task-level record, not whole-ContextEngine, release or bounded-cold-memory qualification.

Original BASE: `292362992f304e6bf7811f22df29608999c59539`. Equivalent extractions: `8aea55d1` (atomic file replacement), `e4fc6ed6` (Code Mode result observation), `6f6ee6c6` (event intake). Connected activation: `e17202f6ffe3a65053502de0b067ecf970dd5d7c`. First review correction: `fdc2f32e1384cf3a81273472f364591168b78d64`. The complete amended [F1 plan](../superpowers/plans/2026-10-16-context-engine-r3-managed-facts.md) and its local SDD ledger/report govern these changes.

## Delivered boundary

The existing coordinator now owns ordinary fact publication through a format6 source-order UTF-8/LF batch journal. A held document/incarnation, exact prior prefix and synchronous first-write fence precede physical issuance. Complete short writes and sync establish a scoped receipt; only that exact receipt installs the staged suffix into the private event array and structural index. Callers receive their own group's actual seq slice even when several groups share a physical frame. Unknown results quarantine allocation and retain the original key/bytes for reconciliation; they are not permission to replay an effect.

`SessionView` exposes immutable committed history. Shipping Agent, tool/Code Mode, child/team/job, input, metadata/title, CLI, SDK and Gateway paths use the actual owned attachment and narrow producer/source ports. The old hook-driven mutable mirror and externally writable managed aliases are retired. Explicit nondurable APIs remain separate and make no receipt or cross-process recovery claim. Native property order and once-only legacy lowering are preserved through capture, storage and cold replay.

Required sources retain real tool bodies, references, finalizer state and lifecycle closers through capacity, quarantine, Stop and disposal. An exact reconciliation may install the already-issued fact and finish passive cleanup; it does not start another model/tool/guest/child. Actor/parent references have independent dispositions rather than a false cross-document transaction. Source capture/grant/finalizer faults remain distinct from uncertain journal writes. Full artifact durability, bounded result envelopes and outbox/claim/wake ownership are still R4 work.

The real CLI file-backed query reader also consumes the shared format6 codec. Its complete verified file prefix is structural observation, not fsync or execution authority. It performs no repair or hidden owned load. Same-file byte copying, structural export and new owned child journals retain their different contracts.

## Independent review and corrections

Fresh GPT6.1Sol review covered the entire BASE→e17202f6 range, including all extraction commits. It reproduced five Important issues with actual runtime controls. The correction wave addresses them through the existing owners:

| Finding | Correction and direct evidence |
|---|---|
| A later coalesced source received the first group's seqs after reconciliation | Source handles reread their own disposition after the shared physical key settles. Controls cover last/second caller first, concurrent callers and multi-event slices, with one write/reconciliation. |
| Agent used the producer's mutable arguments after call admission | BatchCall uses the actual committed tool/call at its returned seq. Real managed and nondurable generators mutate their original graph after yielding; dispatch still uses the captured original. |
| Nested Code Mode fabricated TOOL_FAILED after a real body returned | The broker consumes the registry-bound retained-outcome seam, preserving its original prepared call, reference and one finalizer/result through unknown or rejected retention and Stop. |
| Auto-title inference preceded its managed action check | Trusted service/CLI composition acquires the original action before preparation/binding; its narrow signal/check/metadata/view context survives profile awaits. The existing post-turn queue row remains cancellable through the actual SDK/Gateway route. Ordinary queued input is not selected by that path. |
| Runtime snapshot dedup missed the real assembly factory | Feedback ports are stable under the actual owner and original signal. Adjacent identical renders share their pending admission; distinct owners/signals/ports, A→B→A and unknown/reconcile retain their separate semantics. |

The Minor known-sync file-close diagnostic gap is corrected in the same wave. The internal backend outcome may carry only a fixed `file-close-failed` marker, independently sanitized from its receipt. The coordinator reports one safe diagnostic after lane release; reporting failure cannot undo commitment, roll back, rewrite or duplicate a coalesced report. No raw filesystem error or new backend logger is introduced.

The reviewer assessed the named longer managed-document, Code Mode output/retirement and spawn owners as cohesive for this task. This is not a general size waiver: independent capture/capacity/receipt/source/reference responsibilities remain separate, and no original decomposition credit is added. Original-reviewer scoped acceptance closes I1–I5/M1 and found no new Critical, Important or Minor issue in the correction diff; it explicitly retains the initial close observation and does not grant whole-branch/shipping approval.

## Qualification scopes

Actual logs and process/source manifests are retained locally under `.tmp/context-r3-f1-validation/`; reviewer controls are under `.tmp/context-r3-f1-review-20261017/`. Counts below overlap and must not be summed into a unique total.

| Scope | Evidence |
|---|---|
| Core-session foundation |284 passing controls at its unchanged qualified scope. |
| Final correction's persistence / JSONL |143 /74 passing controls, including shared-key source recovery and cleanup diagnostic cases. |
| Agent / tool compatibility / Code Mode |122 affected Agent controls,17 direct tool compatibility controls,33 Code Mode controls. The known B2 reasoning test was excluded from this correction run and remains unresolved, not silently green. |
| Executor |The final same-combination run plus exact close-boundary control passed83. The earlier81pass/1fail observation is retained separately below. |
| Other affected correction consumers |Runtime9, title15, SDK52, Gateway title/compaction3, CLI84pass/1skip; the original wider Gateway94/SDK92/CLI342pass/1skip and Team121 evidence remains scoped to its recorded source/unchanged paths. |
| Types / reachability |All11 affected packages and E2E typecheck passed at the final correction source. Earlier whole-package typecheck passed before this correction. Reachability403, no new rows or reseed. |
| Copied runtime |Fresh Gateway/CLI builds, dist verification and expanded actual runtime smoke passed;203 source/copy paths match. |

Final correction source-tree SHA256: `b1b8242ecb3625fb98a0f8e5ce8123e6efe66c77fcc3bb1a2c88301ed8d7f6f2`. `fix1-qualification-revision.json` binds2,240 actual source/config/test files,26 committed correction blobs and23 principal phase receipts. Git blob comparisons explicitly account for LF/CRLF checkout conversion; copied-source comparisons use exact bytes.

Reachability has two separate comparisons. Reviewed D406→F1final403 reflects real consumers of `ExecuteToolCallsOptions`, `ToolResult` and `CoordinatorOptions`. An intermediate F1 run separately added three unused exports (`CodeFacts`, `DeliveryFacts`, `TeamLead`); retiring those unused public exports removed its three new rows. Sixty of the final63 historical gone rows were already gone at D. Baseline digest remains `49399a6d851f23e4a3ad2b2a9af2ddf052fe7ca2429b7d00d7e1ec5860f7f2b5`.

Fresh final outputs are `.tmp/context-r3-f1-fix1-gateway-20261017a` and `.tmp/context-r3-f1-fix1-cli-20261017a`. Smoke result `packaged-smoke-rrGdZv/result.json` executes shared-frame last-handle recovery, mutated producer arguments reaching a real child unchanged, one retained nested body/capture/finalizer, original title Stop with zero title sends, and the actual runtime factory with one duplicate-suppressed write. It also executes parent/child format6 cold reopening, CLI fresh/resume and scoped search/lineage. Identity-checked old5 core/coordinator refuses6 before mutation; its54 source files match the original BASE after explicitly recorded line-ending normalization.

## Retained limits and unresolved observations

- The first correction's executor covering run reported81pass/1fail: `service.close()` raised AggregateError in `code-mode-children`, and the old finally hid its underlying cause. A bounded investigation preserved that receipt, improved only failure-path error reporting, kept the successful path/order/assertions/15s timeout, and added an exact second-turn receipt→snapshot-before-close control. The later83-pass run is not proof that the original error was repaired or harmless. The retained failed fixture contains three result/cell/turn-end records for each child, but bare file contents do not establish live receipt or disposal success. This remains an **unclassified close observation**, not a baseline, for scoped review and R6 full qualification.
- The original B2 reasoning-streaming expected-atSeq4/actual5 failure has exact historical evidence and remains unchanged. Previous whole-program qualification failures are not cleared by these selected passes.
- Pre-fix C performance measured a single synthetic100MiB ASCII result followed by warm metadata appends: journal104,927,960bytes/259events; sequential median receipt latency2.148ms before and2.293ms after the large result;128 concurrent writes formed two batches. PeakRSS1,229,132KiB is approximately1.17GiB. This is a substantial current large-result memory cost, not ordinary many-turn/cold-load or provider qualification. These measurements belong to the pre-fix source, not fdc2f32e. The original [R6 archive obligations](2026-10-17-context-engine-r6-archive-obligations.md) remain open.
- CLI's existing36 dynamic TypeScript-import warnings cover paths outside the executed bundle controls. Source hash matches do not qualify unexecuted dynamic paths.
- A prior native fixture supplied an unsupported fetch injection and may have attempted a dummy-key provider request before timing out. That failure is retained as fixture-isolation failure, with no installed credentials/profile access or live-provider/latency qualification. Subsequent controls intercept the actual transport before construction and deny unmatched requests.

Product version remains0.1.13-rc.1 and original decomposition remains27/43. F2 positional readers, F3 reduction/publication, F4 physical-attempt bounds, E policy cutover, R4 result/seed/delivery and R5/R6 remain unfinished. No merge, formal release or complete long-session repair is claimed by this task record.
