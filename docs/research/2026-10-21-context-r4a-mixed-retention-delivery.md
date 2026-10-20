# R4A mixed retention / quota / optional index — bounded delivery

2026-10-21. Qualification-only implementation at `da289034ca5a9503675dd19874722da6f7257425`, from clean BASE `40b660c44a3e96248ae5ada6a3d2a0f7f54fbc7c`. Five new test/helper/config files, **zero product changes**. The preceding accepted integrity/native/pin owners remain unchanged. No calibrated behavioral RED was reproduced and no original-owner repair was requested or made. This delivery awaits fresh independent review and root audit; it does not accept whole R4A or start A6 scale/packaging, R4B/C, R5 or R6.

Product0.1.13-rc.1, Session10 and decomposition27/43 remain unchanged. Work stayed on `codex/v0.1.13-development`; no push, merge, tag, release, live provider/profile or installed-app work.

## Actual composition and original pending state

`packages/session-executor/test/helpers/mixed-retention-fixture.mts` creates a fresh short task root, actual JSONL coordinator, independent root sessions a/b and real project broker. It computes canonical `contextWorkspaceLocation`, saves the actual global/workspace override shape, loads it with `loadContextOutputConfiguration`, and supplies that exact configuration to `createNativeContextRuntime` at `<coordinator storageRoot>/native-context`. The executor lease receives the same native service/sourceFor; it is not a second active owner. Supplied release is a no-op; native runtime, broker and coordinator are explicitly retired before fresh open. Fresh project confirmation is required again.

The original TaskRegistry→prepareResult→createTaskResultRetention path produces committed a, committed independent b, and a genuine staged a operation. The selected **first-pin post-native rename acknowledgement loss** delegates the native rename and filters the exact original artifact directory/document. The automatic first retention attempt and its callback settle once, then the original component source lifetime is invalidated/retired without retry. The actual format2 running baseline, pending task observation, operation/ref identity, literal body and conservative pin are preserved separately. No authoritative operation or task JSON is manufactured. Initial terminal callbacks do not prove F1 publication or recover execution success.

## Qualified controls

Five new tests contain multiple steps; repeated gates are not additional distinct coverage.

| Control | Observed result |
| --- | --- |
| Native SQLite/FTS/canonical location | Genuine full legacy captures, literal reads/searches and native managed pages passed. Final database path187/journal195characters; no setup limitation was used as a passing recovery case. |
| Sequential mixed physical quota | Managed admission counts existing legacy/index bytes. Legacy capture/grant counts real committed plus staged managed bytes. A1000-byte literal prefix of5015original bytes reports complete=false with exact digest; full and none are distinct. Managed known quota refusal is distinct from staged recovery-required. Protected files remain identical. |
| Both live lowering branches | Opened legacy store rejects below-occupancy lowering and retains prior effective config. An existing90000-character managed result with no legacy index accepts live65536 lowering, keeps its92105physical bytes and authorized read, then refuses new growth. |
| Saved override/fresh lower open | Real saved65536 workspace override survives full retirement with unchanged canonical key/root. Fresh unconfirmed project access denies. Genuine confirmation restores managed reads. Underfunded legacy preflight preserves original index and authority bytes; new growth refuses. The real budget is restored before successful cleanup/rebuild. |
| Native mixed admission schedule | A no-hold positive first calibrates real legacy pre/post accounting/blob writes and managed quota/write boundaries. The deterministic schedule holds only the actual asynchronous managed body-write boundary while real legacy capture proceeds. SQLite synchronous transactions are untouched; no recursive lane or draining transition serves as a neutral barrier. |
| TTL, grants, clear and current denial | TTL first filters availability while the expired blob still exists. Authorized b capture actually prunes it while a is archived/denied. Source-bearing grant changes ledger but does not bypass current native source/visibility. Scoped/global clear preserves committed+staged managed inventories. Archive/project revocation and genuine restoration preserve access policy under config/cleanup pressure. |
| Funded missing/corrupt index | Separate retired-owner cases remove only the derived index or replace it with literal corrupt bytes. Both funded fresh opens recover the original b legacy ref/search hit, while a remains genuinely archived/denied throughout rebuild; actual restoration permits its managed read. Managed committed/staged authority remains unchanged. |
| Confirmed selective deletion | Actual `sessionArtifactManifest` includes task-a. Fresh native deletion listener stays alive through coordinator acknowledgement. Only a's document pins release: last-pin committed a is removed; staged a body remains conservative with its deleted pin released; independent root-session b remains readable. This is component/coordinator deletion, not a Gateway drained-route qualification. |

The final fixed schedule used quota370463, initial130463, after-legacy228767, after-managed-write294339 and final228786bytes. Legacy conservatively rolled back the new capture (none); managed finish returned a truthful quota refusal. No temporary files remained and the independent protected owner was unchanged. **294339 is a boundary-sampled peak**, not a proven maximum over unobserved synchronous SQLite journal writes. This single schedule does not establish every possible interleaving, cross-process race freedom or a new temporary allowance. Conservative refusal/rollback alone is not classified as a quota breach.

## Final verification and exact inputs

Evidence root `.tmp/r4am-1021-01/`; final runtime gate14 and sequential type gates15–17 all returned nativeexit0, with identical before/after source inventory SHA256 `f774de576f3b38e742726bf3f322b99240094f5d5dc9556ce34f540098139830` (**2671entries**). Receipts record exact argv, cwd, shell-isolated IH_CONFIG_DIR/fixture overrides, UTC timestamps, raw outputs and actual JSON test collection. Runtime gates ran one at a time with immutable source, one Vitest worker and `--dir packages` plus explicit temporary/worktree/dist/build exclusions.

Final14 collected exactly **8 current-source files /62tests: 5new +57existing**, all passing:

- `packages/session-executor/test/mixed-retention-native.test.ts` —1new test with the native lifecycle steps above.
- `packages/session-executor/test/mixed-retention-quota.test.ts` —4new tests (sequential dispositions, positive native calibration, deterministic schedule, unopened live lowering).
- `packages/context-output/test/service.test.ts` —39existing tests.
- `packages/context-output/test/managed-artifacts.test.ts` —6existing tests.
- `packages/context-output/test/quota-metadata-concurrency.test.ts` —1existing test.
- `packages/session-executor/test/result-store-read.test.ts` —5existing tests.
- `packages/desktop-gateway/test/context-runtime.test.ts` —5existing tests.
- `packages/desktop-gateway/test/native-context-project-revocation.test.ts` —1existing test.

Final types ran sequentially with installed TypeScript: `--noEmit -p packages/context-output/tsconfig.json`, `--noEmit -p packages/session-executor/tsconfig.mixed-retention.json`, `--noEmit -p packages/desktop-gateway/tsconfig.json`. The explicit executor config includes both new `.mts` helpers and both new test files, plus actual source imports. No product/dependency graph changed, so accepted catalog/publication/integrity and package/scale matrices were reused rather than rerun.

Gate14/15–17 executed the eventual committed package bytes while Git HEAD was still BASE40b660c4. Their receipts retain that actual HEAD; the later test commit identity is not substituted into them. Exact final source-byte snapshots and a current hash audit are supplied in the local frozen evidence. Git may normalize new-file line endings; raw qualified workspace bytes remain the source oracle.

## Preserved failures, inventory correction and limits

Gate02 contains **one fixture setup failure**, not a behavioral RED: the native body interception was installed after the body handle had opened, so its handle map could not observe the boundary. The first sequential quota test passed; the schedule timed out before reaching the controlled native hold. The corrected probe installs before native open. Gate03 and subsequent gates pass; gate02's JSON/nativeexit1/files remain untouched.

Early gates01–02 used a broad physical package/app traversal (13601/13603entries) that also inventoried historical Desktop release snapshots and sandbox native build files. These files were not collected tests. The gate-v1 source and original manifests are preserved. From gate03 onward, enumeration uses actual Git tracked/nonignored current package/app files plus new tests, root configuration/lock inputs and the relevant hidden task inputs/launcher. Final2671 is a deliberate scope contraction, not silently changed old-source bytes or retrospective historical qualification. Source manifests preserve names/hashes; earlier exploratory helper variants were not each copied as complete source snapshots, so no reconstructable-byte claim is made for every early variant.

Fixture/outer seal guards were positively checked in fresh dedicated roots: both actual configured-root and `<outer>/gates/18/fixtures` ancestor paths reject before runtime imports or fixture writes. Native delegate holds are released in finally; fixtures explicitly await native runtime/broker/coordinator close and record zero native context/code jobs. The gate subprocesses exited; final process audit records no matching active task Node process. Existing regression tests use their established build/OS-temp fixture locations and cleanup behavior; no claim is made that all historical evidence or OS temporary directories were independently unchanged.

Storage inspection/read/classification never reconstructs a producer scope, capture, F1/task success or permission. Same-owner bare refs are not globally revoked by rewind; accepted selective witness semantics are reused. No automatic staged/unknown GC is invented. These are local Windows/Node controlled component results, not a packaged entry, provider, renderer/installer,100MiB/fan-in or whole-session recovery qualification.

Final BASE..HEAD, immutable evidence inventory/seal, report/handback hashes, source snapshots and native command/failure map are recorded in `.superpowers/sdd/2026-10-21-context-r4a-mixed-retention/task-1-report.md` and `handback.json`. Keep the evidence sealed and source frozen for the fresh reviewer and root audit.
