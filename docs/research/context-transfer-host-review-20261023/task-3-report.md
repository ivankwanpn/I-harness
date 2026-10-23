# Task 3 implementation report — genuine host/artifact composition

Status: **DONE_WITH_CONCERNS**, ready for independent review. This report does not approve its own implementation or claim shipping fork/spawn cutover.

Exact committed range: `fc71742db138c1018994edf94e954fdc3bff5f58..41ad97d39fa1f056ef55cd55c7411b501e6ef130`, branch `codex/v0.1.13-development`, workspace `D:/I-harness-main`. Commit: `feat(gateway): compose broker bootstrap artifact transfer`. Four explicit assigned paths, 337 insertions / 5 deletions:

- `packages/desktop-gateway/src/context-runtime.ts`
- `packages/desktop-gateway/src/host.ts`
- `packages/desktop-gateway/test/bootstrap-transfer.test.ts`
- `packages/core-session/test/semantic-seed-result-refs.test.ts`

No artifact, coordinator, broker, reader, native-source, audit, SDK/router, or fork/spawn implementation was changed. No facade export was added. Root-owned documents were left unstaged; the unrelated untracked `docs/superpowers/plans/2026-10-23-chat-stream-terminal-errors.md` remains untouched. No subagents, external provider/credential/user-session experiments, publication, or decomposition credit. Product 0.1.13-rc.1 / Session11 and 28/43 deferred decomposition remain unchanged. All started runtime commands finished before handoff.

## Ownership and contract implementation

The real native context runtime now exposes the host-only `prepareBootstrapTransfer(capture, sourceAccess)` primitive. Actual Desktop host construction supplies `projects.prepareBootstrapInheritance`. The adapter uses its existing `contextOutput` instance, so existing supplied-service reads and policies remain the production owner. Missing broker preparation refuses; no unmanaged cold authority, synthetic target profile, copied DTO roots, second artifact store, reservation manager, or work queue was introduced.

The adapter synchronously captures the broker invocation/intent through `captureBootstrapProject`, captures the original source access container and signal without accessors/proxies/hidden fields, and retains original host function references. The actual broker sees the original invocation and coordinator-produced manifest during its phase. The adapter captures that phase's digest before the broker await, and admits it only after genuine broker confirmation/currentness. It does not invent a digest or obtain target authority through public incomplete profile/snapshot/open calls.

The dependency port verifies operation, target, manifest, and any supplied source identities before artifact registration. It lazily registers one real `SeedDependencyTransferScope`; subsequent confirm/reconcile calls retain that same scope and the artifact owner's exact full first-request binding, including full refs, uses, counts, and origins. Target source identity comes from existing `contextSourceIdentity(workspaceKey, canonical, brokerTargetScope)`. The real artifact owner retains T-07 source identity compatibility and T-08 repeated original source authorization. NEW uses the broker's `assertSourceCurrent` and original source availability; it cannot substitute an absent caller predicate with a passive call.

For T-09, absence of source access permits only passive artifact registration, using the exact original coordinator request's session label. Source availability remains permanently false for NEW, and source-current assertion refuses. PASSIVE neither looks up a source runtime/profile nor evaluates source hooks/signals/authorizers. An explicitly supplied different source identity conflicts. Anonymous artifact observations retain the real coordinator's `target-policy` refusal. Empty none/empty-observation seeds still run host preparation with zero dependency calls.

Attempt `close()` invalidates synchronously through the captured availability guards and closes the broker preparation. Runtime close also invalidates attempts synchronously through the existing closed flag. It does not release durable target pins or close the original artifact owner. Existing owners perform their normal drainage; the adapter adds no queue. The same broker preparation retains the immutable target baseline across confirm/reconcile, so revocation/reconfiguration ABA cannot refresh an attempt into authority.

The public result read authorizer and all final successful-page currentness guards remain unchanged. Storage staging makes no ordinary target read-policy calls before READY; subsequent ordinary reads still deny if target visibility/policy is unavailable. No execution assembly, F1/F4/tool effect, or duplicate child start is introduced by this storage bootstrap.

## Genuine controls and positive progress

The new Gateway suite has **16 tests**, using temporary canonical workspace roots, actual JSONL coordinator/reservation/header, actual project broker, existing native runtime service, real text result bytes, a distinct catalog with retained exec member, an unavailable entry, and an alias occurrence. Every confirmed transfer/closure comes from the actual artifact service. No desired closure digest is returned by a success stub.

The suite establishes:

- Real pre-READY preparation and nonempty transfer reach READY. The coordinator is not queried for a public target profile during staging. The existing `createSessionService` supplied-service fast path reads inherited text and exec frames via the exact catalog after source close, without constructing an execution assembly. A later ordinary target visibility denial still rejects reads.
- Both none and an actual empty semantic observation prepare the target project with zero dependency callbacks.
- A fresh broker plus fresh native runtime adopt the original completed operation after source close and target owner close, without source access. Source profile, visibility, action, and availability hooks are forbidden. The same passive factory refuses later NEW confirmation. Real target exec reads remain possible. Removing a real target pin makes passive confirmation unavailable without recreating it.
- Source-access/container capture, no getter execution, source mismatch, operation/target/manifest/full-ref/use/origin mismatch, exact original scope reuse, malformed caller predicate refusal, and attempt closure.
- NEW source catalog exclusion prevents target publication; source-free NEW does not create authority.
- Actual broker await manifest mutation cannot change the adapter's bound manifest; a proxy-bearing phase request is rejected without invoking its descriptor trap.
- Actual target pin publication crossed by attempt close, project revoke/reconfigure ABA, or source close returns blocked and leaves the target incomplete. A fresh genuine NEW attempt continues exact original partially issued work in the attempt-close/ABA cases and reaches READY with readable exec bytes.
- Actual landed target access publication with a lost response blocks, then the same original attempt recovers and reaches READY. Original result/catalog/member top-level files, including bodies, indexes, manifests, and `operation.json`, remain byte-identical.
- Project revoke and revoke/reconfigure ABA during an actual target body read reject its result.
- Actual source document deletion invokes normal pin-release ownership, removes the source pin, retains the target pin, and still permits passive original confirmation plus target text reads. This is separate from source runtime close and target policy denial.

The deferred core fixture now uses separately indexed result and catalog refs, with the catalog used only as a dependency catalog. Both refs survive reset and independently validated whole-group replacement; rewind removes the group's refs. Its independent literal-session digest helper is used before validation. Existing same-ref deduplication, strict invalid-manifest cases, and body-accessor refusal remain unchanged.

These are storage/host continuation controls. Actual source/target policy edge cases such as root/member source identity incompatibility, all publication cut positions, and original passive source-signal avoidance are additionally covered by the unchanged full artifact package qualification. The new integration suite is not misrepresented as rerunning every artifact-only scenario at every layer.

## RED/GREEN and fixture corrections

Exploratory logs are in `D:/I-harness-main/.tmp/t3c/`. They are retained but do **not** have the later broad before/after source manifests and are not used as final source-bound qualification:

- `setup-red.log`: invalid envelope fixture (`catalog` instead of event-envelope `artifact-set`); corrected before behavior conclusions.
- `api-absence.log`: wrong fixture import for `createBootstrapRequestIntent`; corrected to its existing private test import, with no test-only public export.
- `api-absence-valid.log`: three failures for absent `prepareBootstrapTransfer`; explicitly new-API evidence, not behavioral RED.
- `behavioral-red.log`: genuine broker staging with the existing `inheritFork` route returned blocked instead of READY because the legacy route requires a public ready profile. The committed baseline assertion preserves that blocked legacy behavior, while the new genuine adapter positive independently requires READY. No existing fork test was weakened or altered.
- `first-green.log`: initial four actual composition controls passed.
- `controls-red.log`: real exact-request test exposed undefined NEW predicate being routed to passive confirmation (one failed / eleven passed). Corrected by requiring a function at the NEW port boundary.
- `manifest-red.log`: caller mutation across actual broker confirmation made the valid original dependency request blocked. Corrected by capturing the digest synchronously.
- `proxy-red.log`: descriptor trap executed before broker rejection. Corrected by strict-data rejection before descriptor inspection.
- `controls-green.log`, `distinct-green.log`, `distinct-fixed.log`, `cold-pin-body.log`, and `empty-anon.log` retain intermediate outcomes. The distinct-catalog fixture initially changed a digested session after construction, then attempted replacement after reset had hidden all projected items; corrected by forming the fixture before the independent literal digest and using independent reset/replacement branches. No production semantic helper changed.

During stable qualification, the anonymous fixture initially carried fork parent lineage with an anonymous origin, yielding `manifest-invalid` before target policy. It was corrected to explicit import/no source capture, while retaining strict expected `target-policy` refusal. Typechecking later required explicit discriminant guards in the new empty-observation fixture and the new distinct-catalog fixture. Those test-only corrections were rerun in their exact affected suites. The final Gateway test rerun also follows trailing blank-line cleanup caught by staged `diff --check`. No product change occurred during qualification.

## Source-bound qualification

Runner: `.tmp/t3c/qualify.ps1`; manifest producer: `.tmp/t3c/snapshot.mjs`. Each qualified run has a fresh short root, exact Node argv, cwd, starting HEAD, UTC start/end, Node v24.15.0, actual exit, raw log, before/after physical SHA256 manifests, and stability result in its `record.json`. All runs were sequential in MAIN, maxWorkers2/minWorkers1. Executor uses its real package Vitest config with Windows file parallelism disabled. All four IH roots are set before imports; the existing native-dependency fixture additionally redirects IH_CONFIG_DIR to its fresh `<run>/native/config`, as before.

Each source manifest covers **2,806 tracked/new files** across packages/apps/scripts plus root package/lock/workspace/tsconfig configuration, including the new integration test and transitive workspace code/tests. It excludes ignored generated historical distribution artifacts from production source. A separate current `generated-physical-inventory.json` lists **1,874** additional physical paths discovered by rg, primarily historical release/package outputs; they are not asserted to be production source or pre/post-bound test inputs. `.gitattributes` is separately bound to identical BASE/HEAD/working Git objects in commit binding. No ignored historical packaged CLI is counted as a live reachability consumer.

| Run | UTC interval, 2026-10-23 | Result |
| --- | --- | --- |
| q1c | 15:18:26.117–15:18:46.837 | Gateway/broker/result-reader/core connected scope: 112/113 tests, 11/12 files; unchanged legacy native-fork fixture failure below |
| q2 | 15:19:28.276–15:19:56.982 | Full context-output package: 169/169, 21 files, exit0 |
| q3 | 15:20:12.448–15:20:16.969 | Bootstrap/intent/physical plus preserved fork baseline: 63/64, 3/4 files; original fork RED below |
| q4b | 15:20:30.213–15:21:17.228 | Native dependencies + result readers: 28/28, 7 files, exit0 |
| q5 | 15:22:25.928–15:22:42.446 | New adapter suite after fixture discriminant guard: 16/16, exit0 |
| q6 | 15:24:17.859–15:24:19.340 | Core result-ref suite after fixture discriminant guard: 10/10, exit0 |
| q7 | 15:26:53.666–15:27:10.360 | Final byte-exact new adapter test file after EOF cleanup: 16/16, exit0 |
| t1b | 15:23:03.281–15:23:11.488 | Gateway tsc --noEmit, exit0 |
| t2 | 15:22:05.939–15:22:09.723 | Context-output tsc --noEmit, exit0 |
| t3 | 15:23:28.262–15:23:36.817 | Executor tsc --noEmit, exit0 |
| t4 | 15:23:41.794–15:23:45.341 | Persistence tsc --noEmit, exit0 |
| t5 | 15:23:54.298–15:23:58.687 | JSONL tsc --noEmit, exit0 |
| t6b | 15:24:24.975–15:24:28.293 | Core-session tsc --noEmit, exit0 |
| reach | 15:24:35.322–15:24:39.066 | Ordinary `node scripts/audit/check-reachability.mjs --gate`, exit1, 7 NEW rows |

Counts overlap; do not add q1c/q5/q6/q7 or focused transfer controls to their containing package counts.

Exact test commands (all invoked as `node node_modules/vitest/vitest.mjs` from MAIN):

```text
q1c: run packages/desktop-gateway/test/bootstrap-transfer.test.ts packages/desktop-gateway/test/bootstrap-project.test.ts packages/desktop-gateway/test/context-runtime.test.ts packages/desktop-gateway/test/semantic-seed-result-read.test.ts packages/desktop-gateway/test/result-page.test.ts packages/desktop-gateway/test/result-page-host.test.ts packages/desktop-gateway/test/native-context-project-revocation.test.ts packages/desktop-gateway/test/native-context-host.test.ts packages/desktop-gateway/test/native-context-fork.test.ts packages/desktop-gateway/test/project-scope.test.ts packages/desktop-gateway/test/project-scope-host.test.ts packages/core-session/test/semantic-seed-result-refs.test.ts --exclude **/.tmp/** --maxWorkers=2 --minWorkers=1
q2: run --root packages/context-output --exclude **/.tmp/** --maxWorkers=2 --minWorkers=1
q3: run packages/session-persistence-jsonl/test/bootstrap-physical.test.ts packages/session-persistence/test/semantic-bootstrap.test.ts packages/session-persistence/test/bootstrap-intent.test.ts packages/session-persistence/test/semantic-fork-baseline.test.ts --exclude **/.tmp/** --maxWorkers=2 --minWorkers=1
q4b: run --root packages/session-executor --config vitest.config.ts test/result-reader.test.ts test/result-reader-lifetime.test.ts test/result-store-read.test.ts test/native-dependency-composition.test.ts test/native-dependency-membership.test.ts test/native-dependency-refusals.test.ts test/native-dependency-observer.test.ts --exclude **/.tmp/** --maxWorkers=2 --minWorkers=1
q5/q7: run --root packages/desktop-gateway test/bootstrap-transfer.test.ts --exclude **/.tmp/** --maxWorkers=2 --minWorkers=1
q6: run --root packages/core-session test/semantic-seed-result-refs.test.ts --exclude **/.tmp/** --maxWorkers=2 --minWorkers=1
types: node node_modules/typescript/bin/tsc -p packages/<package>/tsconfig.json --noEmit
```

Qualification corrections remain visible: q1 unintentionally matched historical `.tmp` checkout copies because Vitest CLI paths are substring filters (66 files); its result is invalid as MAIN-only qualification and is not counted. q1b excluded those copies but still had the anonymous fixture error. q4 failed startup due to a duplicated root-relative config path; q4b corrected it. t1/t6 recorded the two fixture-only type errors, and t1b/t6b replace them. These failed runs were retained, not overwritten or silently counted as passed. The q1 historical-copy execution used the fresh shell IH configuration; no historical-copy outcome is used to attribute MAIN behavior.

Every qualified run's physical manifest is stable within that run. Product source stayed fixed throughout. q1c/q2/q3/q4b/t2 use manifest `e22d363e0e202b2f155b676aa0b6fd0ef27f5afba2680b755dbaccaa921a30a4`. Later differences are confined to the two new/extended test files (discriminant guards and EOF whitespace), with their final versions rerun separately. q7 final manifest is `67570cedc29dce7cb37d73482b3e8d51c01feab2244d5cd19fc0b1658ccc56f0`. Commit binding enumerates each prior run's exact path differences, so earlier unchanged scope is reused only for those unchanged files, not described as a fresh monolithic final-source run.

## Preserved concerns and limits

1. `session-persistence/test/semantic-fork-baseline.test.ts` still fails because the real legacy fork serializes `CONSUMED-PROOF-ONLY`. Fresh q3 confirms the original RED. Task4 actual caller cutover remains required.
2. `desktop-gateway/test/native-context-fork.test.ts` is unchanged at BASE and fails in q1c with `Exclusive owned fact backend is required`; its fixture constructs a coordinator without the required exclusive lock. This is separately disclosed from the original semantic-fork RED. No clean-BASE runtime reproduction was performed in this task, and no unrelated fixture/legacy fork fix was made.
3. The prior independently reproduced clean-BASE SQLite parameter3 failure in session-management remains a carried limitation (task-2-report and task-2-review describe its exact evidence). That case was not rerun or repaired here. Expected diagnostic/noise obligations are unchanged, and no stderr filtering/suppression was added.
4. Normal reachability still fails. Accepted BASE had8 NEW rows; final product has7 because `BootstrapDependencyPort` now has a real production import/type use in `context-runtime.ts`. Remaining rows: `exportConversationSeed`, `withPreparedRequests`, `BootstrapCallerMetadata`, `BootstrapInitial`, `BootstrapLineage`, `BootstrapReceipt`, `BootstrapTarget`. No baseline/exemption/reseed/audit edit or fake graph consumer was added. In particular `withPreparedRequests` remains present, so the previous ignored-release contamination is not treated as resolved through fake use.
5. This wave supplies actual callable host/artifact composition and positive storage continuation evidence. Shipping fork/spawn/team/reviewer/SDK/CLI/Desktop request intent capture, transport, invocation, and execution cutover remain original Task4. No claim that a user-visible shipping fork now consumes this primitive, that an actual long-session product continuation is finished end to end, or that the native-source next plan is promoted.
6. No repeated whole-monorepo, old 500MiB, real-provider, or user-session experiments were run. Tests are controlled local ownership/bytes/policy evidence, not production deployment evidence.

## Commit binding and review handoff

`D:/I-harness-main/.tmp/t3c/bind.mjs` verified all **2,806** final physical files against q7 and all normalized Git objects against actual committed HEAD: zero mismatches. It also records raw log SHA256, every stable run record, and per-run differences from final. `commit-binding.json` was generated `2026-10-23T15:27:54.660Z`; SHA256:

`c3f2f0e04e835024796b53747d4b18d9869a549943443b126017fc131348cea2`

| Owned path | Physical SHA256 | Committed normalized Git blob |
| --- | --- | --- |
| core-session/test/semantic-seed-result-refs.test.ts | d3a0500538be062b4093327dbca3ccb45becb8eeebf8113aec955923a02cd25a | 6e001e4150ce9c813b1cd5b4ec64cee99725fdac |
| desktop-gateway/src/context-runtime.ts | 2e202b5ff2d723303a4acf20e0bc91fc7666e83d60a961770c247b70afbee936 | 70d491cd2e3e88515b862fc7fc5db080af6c6d63 |
| desktop-gateway/src/host.ts | 8d1069f618ef14b91d2d992131c5a5e38aa369600845a9b9f7abb60926aa2b28 | 5fc6143674dbd469ed62edae16704fb5c2006ba7 |
| desktop-gateway/test/bootstrap-transfer.test.ts | 0d8dcbb830675e7a5d4a6bae8fccd33f3ed96ba1f53bb93588d2b33c1e174ad3 | 3c72e8ae0b3c10a5e892a962d77571b5762e27bb |

Staged diff check passed before commit. Git warned that the new test's LF working bytes may normalize to CRLF on a later checkout; physical SHA256 and committed normalized Git identity are deliberately separate above. Root should review the exact BASE..HEAD range and this evidence, then obtain the fresh full Task3 review and connected-plan review. No runtime remains active and no uncommitted assigned code remains.
