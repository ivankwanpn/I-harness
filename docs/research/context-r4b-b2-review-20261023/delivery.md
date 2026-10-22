# Task2/B2.1 implementation report

2026-10-23. **DONE_WITH_CONCERNS — implementation handoff for independent review; no self-acceptance.**

BASE `cf437fb549e550ac33cf7e524b99162173c58122` → HEAD `50db21c16cc8a4add4b2ff4bf2d6c7c0d4757c58` on `codex/v0.1.13-development`. One product/test commit: `50db21c1 feat(persistence): qualify semantic bootstrap storage and recovery`. It changes 20 files, 1161 insertions/63 deletions. Only the dispatched Task2 product/test paths were staged and committed. This report remains separate from that commit. B1 remains intact; product0.1.13-rc.1 and Session11 are unchanged.

Binding inputs: `task-2-implementation-brief.md`, refreshed `task-2-brief.md`/`task-2-contracts.md`, the owner preflight and `docs/research/2026-10-23-context-r4b-b2-owner-rulings.md` (R-B-20..25). No unresolved public-contract deviation was introduced. Root's cold stage-only and existing-empty publication clarifications are implemented and tested.

## Implemented owner contracts

- **Compiler/materialization:** `session-persistence/src/semantic-seed.ts` compiles actual B1 exports into deterministic addressed records and validates source/seed/dependency binding. None uses the shared literal constants without reading parent content. `coordinator/bootstrap-header.ts` captures strict own data, rejects accessors/callbacks/unknown fields, validates metadata/model/lineage/initial clocks, freezes detached request data, computes the exact R-B-23 manifest and captures bounded final stage/header bytes. New operation IDs are printable ASCII1..237. The shared initial-admission hashing helper lives in core and is consumed by both B1 readiness validation and B2 through the existing internal/bootstrap bridge.
- **One registry and writer:** `managed-documents.ts` now stores retained ordinary/bootstrap entries with the current flight, optional sole Document and original operation. Same-operation calls join; cached ordinary targets refuse. Header uncertainty survives rejected public opens and failed close. Bootstrap constructs one managed state only after header confirmation. Its private phase control uses the existing queue, capacity, Pending, state/index, quarantine, install and observer order. Deterministic phases cannot coalesce with ordinary work. All ordinary ports/source/action/snapshot paths refuse incomplete state. Public mutation fences are repeated under the lane without rejecting already-admitted deletion drains.
- **Qualified header I/O:** JSONL `backend/bootstrap-header.ts` uses the exact invocation-derived `.stage`/`.publish` paths, retained closed original staging,262144-byte stage and65536-byte header budgets, exclusive new-target publication, exact existing-empty expectation and same-operation matching-prefix continuation. Passive reconciliation can sync-confirm complete original header bytes; it cannot fill/truncate/rename/delete partial bytes. Guards are repeated after awaits before mutation/publication. There is no header rollback. File-close cleanup after known sync cannot erase commitment. Directory sync remains best-effort on Windows.
- **Cold/public fences and cleanup:** raw JSONL ordinary create/read/append/repair/replace/metadata/format paths detect retained pre-publication staging. A fresh coordinator cannot fill a stage-only absent target or treat the original existing-empty header as ordinary unprepared storage. Ready metadata edits validate only the immutable bootstrap prefix, preserving the ordinary body/torn suffix. Owned deletion inventories only the exact target's bootstrap stage/publication filenames, includes them in its existing receipt and retains confinement/tombstone behavior.
- **Journal/receipts:** core's existing physical decoder now supplies a private growing-prefix reader via the existing bridge; the public reader remains full-ready and ordinary terminal-suffix reconciliation is unchanged. JSONL historical confirmation validates original deterministic frame bytes/keys/prefix positions and the later complete chain, syncs under the current held owner and returns the original frame's prefix receipt. B2 applies the normal receipt owner/key/last-seq/prefix validation before readiness. It does not reissue the append or observers. Later torn suffixes block adoption unchanged.
- **Inspection/resume/dependencies:** unknown-manifest header tokens are honest closed-union values; readable original stage/header fields provide actual digests. Inspection performs reads and transient validation without mutation/lease/receipt. Cold incomplete work needs exact original payload. Ready adoption reconstructs the original manifest from retained original metadata and actual target records, preserves current mutable metadata/live suffix and rebinds receipts to the current Document incarnation. It does not confirm old full-header bytes after metadata edits, read changed source, re-admit initial input or launch an action. Zero artifacts use the exact empty closure with no dependency-port call. Nonempty dependencies require a session source and injected exact confirmation/reconciliation outcomes; anonymous artifact authority refuses. Ready dependency reconciliation must match the stored closure.

The private bootstrap owned-load composition is in the new coordinator bootstrap owner using the existing lane/lease, `buildSession`, private journal reader and internal managed constructor; it does not call public `loadOwned` and suppress readiness errors. No second opening map/queue/index/persistent service was added. Retained header staging is the explicitly approved bounded original transaction artifact.

## Final qualification and source timing

All product test/typecheck/reachability commands ran sequentially. Yielded product commands were polled to completion before another product runtime command. Final logs and command/exit metadata are under `.tmp/r4b-b2-20261023/`. No live providers, credentials, user sessions, model/tool calls, subagents or publication were involved.

Each final command has `.before.sha256` and `.after.sha256` manifests covering **all241 files** in the three affected packages' `src` and `test` trees, including new/untracked files. The manifests are identical before/after and across all final tsc/suite/gate runs. SHA256 of each manifest file is:

`03B85DA1B3F709C0C52EAE1E0473A9C6A40B64C50312CE52169DB2617A254DBF`

`committed-source.sha256` has that same hash after the commit. `commit-binding.txt` binds it to BASE/HEAD and the exact committed file inventory. `.meta.txt` files preserve command, UTC, source HEAD, exit code and final scope hashes; early metadata formats put UTC/command/HEAD on one readable line. Early exploratory logs only hashed tracked modifications and therefore omit new modules: they are not presented as complete source-timed qualification. The final whole-scope manifests close that gap without retroactively changing those early observations.

| Final command | Result | Evidence stem |
| --- | --- | --- |
| `pnpm --filter @i-harness/core-session exec tsc --noEmit` | exit0 | `final-core-tsc` |
| `pnpm --filter @i-harness/session-persistence exec tsc --noEmit` | exit0 | `final-persistence-tsc` |
| `pnpm --filter @i-harness/session-persistence-jsonl exec tsc --noEmit` | exit0 | `final-jsonl-tsc` |
| `pnpm --filter @i-harness/core-session exec vitest run --maxWorkers=2 --minWorkers=1` | exit0;46 files/506 tests pass | `stable-core-suite` |
| `pnpm --filter @i-harness/session-persistence exec vitest run --maxWorkers=2 --minWorkers=1` | exit1;29 files/180 tests pass, original fork baseline1 test fails | `stable-persistence-suite` |
| `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run --maxWorkers=2 --minWorkers=1` | exit0;19 files/217 tests pass | `stable-jsonl-suite` |
| `pnpm verify:reachability` | exit1;7 new rows, detailed below | `stable-reachability` |
| `git diff --cached --check` before commit | exit0 | observed in handoff tool output |

The JSONL suite includes29 new physical bootstrap tests. Compiler suite has3 new tests. Existing JSONL post-sync cleanup test intentionally logs its diagnostic while passing. Full affected suites naturally exercised maintained current-reader/predecessor cases; no sealed R4A volume/packaged inventory or capsule regeneration was rerun. Accepted predecessor evidence remains historical; these logs are current source execution.

## Meaningful RED/GREEN, setup failures and iterations

Raw logs are retained even when a filename contains `green` but the attempt failed. Classification is based on the actual output:

| Evidence stem(s) | Exit(s) | Actual observation |
| --- | --- | --- |
| `compiler-api-red`, `storage-api-red` |1,1| API absence (`compileSemanticSeed`/coordinator method unavailable). These are **not** behavioral crash-ownership counterexamples. |
| `storage-behavior-red` |1| After explicit unsupported scaffold: actual expected-ready and cached-refusal assertions fail. Establishes missing behavior after API setup. |
| `compiler-green-1` |0| Initial2 compiler cases pass. |
| `storage-green-1`, `storage-green-2` |1,0| First still reached the temporary unsupported scaffold; wiring corrected, then2 storage cases pass. |
| `physical-cuts-red`, `physical-cuts-green` |1,0| Actual synced seed response-loss reentry incorrectly returned header conflict because full target bytes included seed suffix. Header confirmation fixed to validate exact header plus its journal suffix;10 cases pass. |
| `lifecycle-red` |1| Actual retained staging leaked through deletion, and metadata-only nonempty target was classified conflict. |
| `lifecycle-green` |1| Collection/setup error: duplicate declarations during deletion integration. No test ran. |
| `lifecycle-green-2` |0| Declaration error corrected;14 cases pass, including actual deletion inventory and nonempty refusal. |
| `remaining-physical-red` |1| Collection/setup syntax error in added FileHandle test proxy; no test ran. |
| `remaining-physical-behavior` |0| Corrected tests:21 cases pass, including actual short/partial writes, absence-proof/install and rename cuts. No claim these added cases each separately failed first. |
| `dependency-binding-qualification` |1| Collection/setup syntax error in a test dependency fixture. |
| `dependency-binding-behavior` |0| Corrected tests:25 cases pass, including exact closure, anonymous authority refusal, original manifest and callback/source binding. |
| `compiler-descriptor-red`, `compiler-descriptor-green` |1,0| Actual compiler accepted/evaluated accessor discriminant; strict wrapper preflight added;3 cases pass with zero getter calls. |
| `physical-final-focused` |0|27 physical cases pass, including target-sync uncertainty and close-after-sync diagnostics. |
| `final-core-suite`, `final-persistence-suite`, `final-jsonl-suite` |0,1,1| First full affected run:506 core pass;180 persistence pass plus original fork RED;214 JSONL pass plus a **new** deletion-drain regression. |
| `accepted-drain-regression-green` |0| Existing test directly reproduced the regression: new under-lane `assertWritable` rechecked `deleted` after closing admissions, blocking previously accepted write-behind drain. Narrowly changed repeated checks to the managed-bootstrap fence, preserving original deletion pre-admission policy. Existing delete-owned + bootstrap33 cases pass. No assertion weakening. |
| `historical-receipt-red`, `historical-receipt-green` |1,0| Actual real-sync backend response with foreign receipt owner was accepted. Added existing receipt validation at historical adoption;29 physical cases pass and foreign evidence stays blocked. |
| `interim-tsc`, `interim-tsc-2`, `interim-tsc-3`, `typecheck-interim-clean` |1 each| Type errors during integration/test development: source union narrowing/unused imports, literal request versions, test callback typing. These are compiler/setup failures, not behavioral regressions. |
| `typecheck-interim-clean-2` |0| JSONL transitive typecheck clean before final stable verification. |

The initial attempted Python edit command failed because the Windows Python alias was unavailable; no source edit occurred from it. Subsequent edits used the installed Node runtime/apply_patch. This was an editing environment issue, not a product test.

Existing tests were not changed to match implementation. New physical tests use real JSONL files and held Windows ownership. Vi mocks wrap real FileHandles/rename and bound original methods; backend lost-response wrappers allow real writes/sync before substituting unknown/foreign evidence. The internal managed-state installation wrapper throws once after real frame sync to exercise retained install failure. Controlled dependency fixtures test the port contract only; they are not a shipping grant implementation.

## Decisive physical/lifecycle oracles

- **Registry/identity:** concurrent same-operation requests return one Document; ordinary cached targets refuse without byte changes; same invocation with changed metadata/initial materialization conflicts. Pending write-behind refuses before opening and its originally accepted event still flushes. Invalid/oversized operation IDs produce no target staging.
- **Headers:** independently read raw header/frame files. Actual writes limited to11-byte chunks complete stage and target. A17-byte partial original stage survives rejected public open and failed close; invocation-only cold inspection/resume uses unknown-manifest/payload-required and changes no bytes. Original payload continues the same prefix. A13-byte partial target continues with no header truncation. Existing-empty raw extension metadata survives reservation. Actual rename followed by thrown response is reconciled. A target-sync failure leaves complete header bytes; Stop permits passive confirmation but prevents completion issuance. Post-sync close failures preserve readiness.
- **Cold reservation:** copied physical store files (excluding OS lease files) model a fresh process over the same persisted operation without fabricating owner contexts or force-releasing a live uncertain lease. A new coordinator's ordinary create refuses stage-only state; ordinary open/update/append refuse an existing-empty pre-publication stage and preserve its raw original bytes.
- **Seed/completion:** actual sync then response loss retains private uncertainty; public snapshot/open refuse and close rejects. Partial seed plus failed truncate/sync remains unknown; only original journal reconciliation subsequently proves absence before exact retry. Installation failure retains the synced frame and installs once on reconcile. Frame IDs are counted in independent file reads; initial admission appears once with original100/200 clocks. Marker+input are one deterministic completion frame.
- **Dependency/currentness:** a real header-only target remains unreadable while the injected exact dependency operation awaits. Source change after dependency await or real seed sync prevents later optional issuance, preserving target/manifest/clocks. Nonempty ready dependency reentry must confirm its stored exact closure. Zero dependencies never invoke the injected port. Anonymous refs refuse before reservation.
- **Ready adoption:** after title/archive/model/workspace changes, a later real plan fact and close/reopen, original deterministic keys/manifest are retained, returned owner incarnation changes, initial input remains singular and current metadata/live suffix survive. The staged manifest preimage is independently hashed from physical stage inputs plus compiled records. A later torn suffix remains byte-identical and blocks adoption. Foreign historical receipt evidence is rejected after actual sync; replacing the wrapper permits same-operation adoption without append changes.
- **Deletion:** exact valid target identity plus a literal additional partial staging artifact is deleted through the existing owned inventory, both staging names are in its durable receipt, and the tombstone refuses resume. No orphan/deletion authority was invented for unreadable target identity.

These controls qualify storage operations, not exactly-once child execution. There is no model/generation consumer in Task2 to launch or replay. No fake caller was added to manufacture such coverage.

## Remaining gates and limits

1. **Original semantic-fork baseline remains RED by the dispatch boundary.** `test/semantic-fork-baseline.test.ts` still finds `CONSUMED-PROOF-ONLY` in the legacy raw fork archive. `fork.ts` and its original assertion were not changed. Actual fork/spawn/team/SDK/Gateway/standalone cutover is Task4, not completed by storage readiness.
2. **Normal reachability gate remains failing with7 rows.** The existing B1 `@i-harness/core-session#exportConversationSeed` plus new caller-facing type reexports `@i-harness/session-persistence#BootstrapCallerMetadata`, `BootstrapDependencyPort`, `BootstrapInitial`, `BootstrapLineage`, `BootstrapReceipt`, `BootstrapTarget`. These have real internal/storage contract roles but no connected Task4 external consumer yet. No fake graph consumer, baseline reseed, allowlist/exemption or assertion change was used. Reachability reports398 current rows/75 removed baseline rows, with7 new rows causing failure.
3. **Task3/Task4 authority is still required.** Artifact transfer/membership/current authorization is injected, not implemented. B2 validates invocation/materialization equality, not an originating task/role it cannot observe. Task4 must bind/persist genuine per-entry logical intent and original clocks before target mutation. Storage readiness does not authorize action replay.
4. **Recovery is deliberately honest.** Missing semantic records/initial text require exact original payload. Missing/corrupt retained original binding may remain unavailable/payload-required; changed current metadata cannot stand in for its original values. Later torn ordinary suffixes require the separate original qualified recovery path. Best-effort Windows directory sync is not a universal power-loss promise.

Final source/tests were reviewed against the staged diff; whitespace check passed. The product/test commit is complete, but independent functional/quality review and root acceptance remain outstanding. No background command/job remains at handoff.

## Fix round1 — Important findings1–3

2026-10-23. Implementation handoff for the **same independent reviewer**, not self-acceptance. Root accepted the three reproduced Important findings and selected R-B-26/27 in `task-2-fix-round1-brief.md`. Read the full review/probes/rulings before changing product code. This section supersedes the initial implementation's claims where findings1–3 exposed missing behavior; the original logs/report remain retained above.

Fix BASE `50db21c16cc8a4add4b2ff4bf2d6c7c0d4757c58` → FIX_HEAD `9b7f3fa343528cb7e77725273b19ca7aa3fabf87`. Commit `9b7f3fa3 fix(persistence): preserve bootstrap birth and fence continuations` changes only six product/test files,231 insertions/20 deletions:

- JSONL `src/backend/bootstrap-header.ts`, `src/backend/fact-journal.ts`, `src/index.ts`, `test/bootstrap-physical.test.ts`.
- Persistence `src/coordinator/bootstrap.ts`, `src/coordinator/bootstrap-types.ts`.

No core code, ordinary fact-journal settlement semantics, actual caller, artifact owner, provider, release/version, unrelated decomposition or reachability policy was changed. The root-owned dirty rulings document was neither edited nor staged. Its SHA256 remains `5B9938A70A5B2EF52FA4473F778C4727DE6BF70085F668D14220851F056C0C78` from the first fix command through commit binding; it remains the sole dirty tracked file after the commit.

### Finding1: preserve actual birth frames during ordinary replacement

`preserveBootstrapBirth` in the existing JSONL journal owner validates the retained original stage against current immutable birth/header/journal fields, decodes the actual existing journal through the existing private reader, checks the genuine deterministic phase layout/counts, and requires candidate birth records to be data-equivalent. Public `replaceEvents` fully validates the candidate for retained-stage targets, copies the **actual existing raw header and actual birth-frame bytes**, then encodes only an allowed later suffix against the actual birth prefix digest. It never regenerates original deterministic frames or invents an old receipt. Malformed/unavailable original phase layout or changed/dropped birth data refuses before publication. Existing stage-free/legacy replacement stays on its prior canonical rewrite path.

Maintained controls independently retain the raw header+seed+completion/initial bytes and compare the exact prefix after same-events and changed-suffix replacement. Normal read and title update then work; cold same-operation resume adopts the original seed/completion keys and one initial admission. A zero-seed target remains byte-identical through same-events replacement and adopts its original completion key. Changed completion closure, dropped initial admission and a physically rewritten foreign whole-birth frame refuse without changing any bytes. The existing stage-free canonical whole-event test passes without altered assertions.

### Finding2: recheck at every header write boundary

`continueFile` now invokes the same idempotent issuing/current guard immediately before **each** native `h.write` in its asynchronous complete-write loop. A stale source or aborted signal after a short write stops before another remainder write. Original partial stage/target bytes remain retained; passive reconciliation remains distinct, and fresh-current same-operation continuation can complete them. The ordinary fact journal's existing original-settlement rules were not changed.

The four maintained stage/target × stale/abort controls call the real native write for11 bytes, then flip currentness or abort before returning the write promise. Final assertions require exactly1 selected write, zero post-flip writes, exactly11 retained bytes and header-phase blocked state. Repeating resume with the same guards makes no additional writes and preserves those bytes. Restoring native I/O and providing a fresh guard reaches ready under the original invocation. Existing positive short-write tests continue to pass.

### Finding3: validate retained publication state

The backend read-state DTO now carries publication presence and bounded original publication bytes. Read-only absence requires target, stage **and publication** absent with no foreign artifact. Publication-only bytes without verifiable binding remain unavailable/needsConfirmation with an honest unknown-manifest header token; public bootstrap cannot create a target/stage around them.

Both backend preparation/reconciliation and coordinator inspection/ready adoption check retained publication state. A publication file is forbidden for a new-target operation. Existing-empty continuation requires original stage binding, exact matching original publication bytes/prefix and unchanged original target qualification. A literal foreign prefix conflicts and remains byte-identical. A matching partial publication stays blocked under stale guards; fresh warm/cold original-payload continuation completes that same prefix, renames it and reaches ready. Passive reconciliation now correctly distinguishes the unchanged qualified original empty header from a conflicting header: it reports unknown so current guarded continuation can proceed, rather than returning the pre-fix false conflict. Already-ready bootstrap confirmation refuses conflicting retained publication instead of issuing another receipt around it.

The maintained controls cover publication-only19-byte unknown state with no target/stage creation, actual partial existing-empty publication produced by a real13-byte native write followed by failure, stale no-write resume, successful copied-store cold and warm original recovery, foreign publication unchanged across inspection/resume, and conflicting publication after genuine ready state. No filename alone becomes materialization/manifest authority; no ignore/delete/rollback/new identity was added.

### Fix-round RED/GREEN and final commands

New evidence only: `.tmp/r4b-b2-fix1-20261023/`. Earlier implementation and unchanged-source probe evidence was untouched. Every product runtime command below ran sequentially with full raw output, UTC, command, source HEAD, exit code, root-rulings hash and before/after **complete affected source/test** manifests. No setup/collection/API failure occurred in this round.

All commands have `.log`, `.meta.txt`, `.before.sha256` and `.after.sha256` files named by the evidence stem:

| Evidence stem | Exact command | Exit/result |
| --- | --- | --- |
| `three-findings-red` | `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/bootstrap-physical.test.ts -t "review F" --maxWorkers=2 --minWorkers=1` |1;7 maintained new cases fail on the three Important behaviors,29 skipped. F1 actual birth replacement/refusal, F2 continued short writes/phase, F3 false absence. |
| `short-write-counts-red` | `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/bootstrap-physical.test.ts -t "review F2" --maxWorkers=2 --minWorkers=1` |1;all4 fail directly on native write counts:165 stage writes or71 target writes rather than1. The request is shorter than the earlier standalone probe, so total counts differ. |
| `short-write-counts-green` | same F2 command |0;4 pass,32 skipped after the per-write guard fix. |
| `birth-replacement-green` | `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/bootstrap-physical.test.ts test/semantic-publication.test.ts -t "review F1|canonical whole-event" --maxWorkers=2 --minWorkers=1` |0;3 pass,60 skipped: new genuine-B2 cases plus existing stage-free canonical control. |
| `retained-publication-red` | `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/bootstrap-physical.test.ts -t "review F3" --maxWorkers=2 --minWorkers=1` |1;4 maintained cases fail: false publication-only absence, false conflict for matching existing-empty continuation, missing foreign-publication inspection refusal, ready confirmation ignoring conflicting publication. |
| `retained-publication-green` | same F3 command |0;4 pass,35 skipped after retained-state validation and exact existing-empty continuation fix. |
| `focused-owner-green` | `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/bootstrap-physical.test.ts test/semantic-publication.test.ts test/delete-owned.test.ts test/fact-batch-journal.test.ts --maxWorkers=2 --minWorkers=1` |0;4 files/101 tests pass. Includes the added zero-seed and dropped-initial controls. |
| `final-persistence-tsc` | `pnpm --filter @i-harness/session-persistence exec tsc --noEmit` |0. |
| `final-jsonl-tsc` | `pnpm --filter @i-harness/session-persistence-jsonl exec tsc --noEmit` |0. |
| `final-jsonl-suite` | `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run --maxWorkers=2 --minWorkers=1` |0;19 files/228 tests pass, including40 physical bootstrap tests (11 added in this fix round). |

The F2 early outcome assertion was ordered after the write-count assertion to expose the actual writes on the unchanged implementation; its final header-phase requirement remains, rather than weakening it to match the old dependencies phase. No existing assertion was loosened, no baseline was changed and no fake committed response was used. All maintained faults wrap real file handles/native writes and independently compare physical bytes. No broad core/persistence suites were rerun: core code is unchanged, and the persistence amendments are exercised through the real JSONL bootstrap tests and both transitive typechecks, as selected by the fix dispatch. No sealed volume/capsule inventory or live-provider work was added.

The final focused run, both final typechecks and full JSONL suite share the identical241-file scope manifest SHA256 before/after:

`F37D8C3414041C2A994EA4F18BAE06E215E3692EEFC4EE61217E6476AF257683`

`committed-source.sha256` has that same hash after the commit. `commit-binding.txt` binds it to `50db21c1..9b7f3fa3`, the exact six-file commit and unchanged root-rulings hash. Staged full fix diff was reviewed and `git diff --cached --check` passed before commit. No product source changed after final qualification and no background command remains.

### Remaining review/connected gates

The same reviewer must re-review the complete fix range before root acceptance. Review Minor4 (non-enumerable DTO fields) and inherited Minor5 (asserting the expected cleanup diagnostic) are **explicitly deferred and not fixed**. The inherited diagnostic still appears in passing journal tests, as expected; it was not hidden or relabelled.

Task3 transfer authority, Task4 actual consumers/logical intent/action ownership, the original raw-fork RED and the previously recorded seven reachability rows remain connected/whole-B obligations. No new public symbol or consumer was added to erase them and no reachability policy changed. Their earlier logs are historical evidence, not fresh fix-round reruns. This handoff claims implementation and the exact tests above, not self-acceptance or whole-B completion.
