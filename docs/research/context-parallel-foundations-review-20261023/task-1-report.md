# Task 1 — artifact metadata and catalog foundation

Status: implementation delivered for independent review. No self-approval or complete Task 3/transfer claim.

Checkout: `D:/I-harness-main`, branch `codex/v0.1.13-development`.
Base: `7ef8d71b76541b6311a9fa8364dbfe6f89f41869`.
Product/test commit: `1566b38914e2e8e697ec64748ceab93172548212` (`fix(context-output): confirm immutable dependency metadata`).
Review range: `7ef8d71b76541b6311a9fa8364dbfe6f89f41869..1566b38914e2e8e697ec64748ceab93172548212`.

## Exact files

- `packages/context-output/src/artifact/io.ts`
- `packages/context-output/src/artifact/metadata-data.ts` (new)
- `packages/context-output/src/artifact/dependency-catalog.ts` (new)
- `packages/context-output/src/artifact/dependency-membership.ts`
- `packages/context-output/test/immutable-metadata.test.ts` (new)
- `packages/context-output/test/dependency-catalog.test.ts` (new)
- `packages/context-output/test/dependency-foundations.test.ts` (new)
- `packages/session-executor/test/native-dependency-membership.test.ts` (narrow affected test adaptation approved by root)

No host, model, executor product, core, package/config/version or public tool changes. Root's dirty `docs/superpowers/plans/2026-10-23-context-parallel-foundations.md` remained unstaged/uncommitted. This ignored local report is the only assigned SDD report write.

## Implemented contracts

`continueAtomicJson(root,path,value,current)` and `confirmAtomicJson(root,path,value)` capture strict JSON metadata bytes synchronously before their first await. They reject accessors, toJSON, proxies, symbols, foreign prototypes, nonfinite numbers, undefined values, hidden fields, sparse arrays and array extensions instead of silently dropping data. The existing 65,536-byte metadata limit remains. `atomicJson` retains its mutable rename policy and existing callers; `writeAll` gains an optional currentness guard used between physical short writes.

Immutable outcomes are closed physical kinds: `confirmed`, `absent`, `unknown`, `conflict`, `not-issued`, with optional diagnostics. They grant no host permission. Final and deterministic pending bytes are inspected, all sibling pending names in the same record namespace are accounted for, conflicting/foreign work is retained, and absent is returned only when final and pending work are absent. A stopped continuation with existing partial work stays unknown. A matching existing final is physically sync-confirmable even when the producer's currentness is false; membership separately enforces its original currentness policy.

Root ruling P-04 replaced the original brief's immutable rename seam: publication uses real atomic `link(pending,final)`, which cannot replace a final inserted after the absence check. EEXIST inspects the actual final. Unsupported/uncertain link results preserve the exact pending transaction and return unknown; there is no overwriting rename fallback. Exact pending cleanup occurs only after final validation/sync and a fresh currentness check. Post-sync close/cleanup failures and retained pending work appear as diagnostics without fabricating absence or retracting a confirmed physical final. Passive confirmation reads and syncs only; it never creates, fills, links, renames, truncates, deletes or cleans up work. On Windows its sync handle is `r+`, required by FlushFileBuffers; no bytes are written.

`readDependencyCatalog(root,directory,ref,visit,expectedCount?)` reads the actual immutable JSON body through `readVerifiedArtifactBytes`, requesting pages no larger than 32,768 bytes. It retains at most one 8,192-encoded-byte descriptor/token buffer, uses fatal incremental UTF8, preserves arbitrary valid root/key ordering, whitespace, escaped Unicode and page-split multibyte text, refuses duplicate JSON keys at all descriptor nesting levels, enforces the existing closed catalog/entry/retention/ref schema, sourceId uniqueness, optional exact count and EOF. It reads no member body and does not concatenate the catalog. The sourceId hash set grows with entry count; no constant-total-memory claim is made. Hashing JSON string encoding preserves distinct escaped lone-surrogate IDs, which raw UTF8 hashing would collapse. The verified byte reader's existing Merkle/chunk scratch buffers remain its own established bounds.

The visit callback is metadata traversal, not a commit hook. Consumers must await successful completion/EOF before target mutations. Original membership settlement now does so, comparing every actual catalog entry with its captured registration before creating any companion. It then validates every retained alias's exact original operation/ref and physical pin before publishing distinct companions.

Canonical-first settlement preserves all catalog observations, ordinals and sourceIds. For identical refs under different sourceIds it publishes one existing-path companion containing the lowest ordinal/sourceId. Later aliases still validate their operations and pins. Conflicting immutable aliases and noncanonical existing companions refuse unchanged. Existing valid v1 reads keep their established witness behavior; ready retries now revalidate actual catalog/operations/pins/companions rather than trusting an earlier ready cache. Future transfer must still independently verify entry evidence and fold every occurrence.

## RED evidence and setup distinctions

Evidence root: `D:/I-harness-main/.tmp/context-parallel-artifact-20261023`.
Each named raw log records UTC and exit; final logs also contain the exact command. Early logs are iteration evidence only, not acceptance evidence for final source.

1. `red-settlement.txt`: `pnpm --filter @i-harness/context-output test test/dependency-foundations.test.ts --maxWorkers=2 --minWorkers=1`, exit 1, two meaningful real-API failures against original product. The valid repeated-ref catalog returned recovery-required instead of ready. Precisely: old code published ordinal0, then ordinal1 conflicted with those existing bytes; it did **not** overwrite ordinal0. The mismatched actual catalog body still emitted a companion before duplicate settlement returned recovery-required, so the no-publication assertion failed.
2. `red-new-api-setup.txt`: missing new IO functions/new catalog module. These are explicitly new-API/setup failures, not reproduced original behavior.
3. `red-strict-capture.txt`: meaningful hidden-metadata RED, actual immutable continuation incorrectly returned confirmed for a non-enumerable field. `red-registration-capture.txt`: actual registration silently accepted hidden metadata. Both green in `green-strict-capture.txt` after strict capture.
4. `red-no-clobber-publication.txt`: meaningful P-04 RED after changing controls to the actual link seam, showing link/response cuts were bypassed by the prior rename implementation and cleanup diagnostics were missing. `green-no-clobber-publication.txt` passed after no-clobber publication/diagnostics.
5. `red-escaped-source-identity.txt`: actual verified catalog with distinct valid escaped source IDs failed as duplicate because raw UTF8 hashing collapsed them. `green-escaped-source-identity.txt` passed after hashing JSON string bytes.

The initial catalog scale fixture attempted one write larger than the existing sink's bounded chunk contract; corrected the **new fixture** to 32,768-byte writes. That failure in `green-foundations-1.txt` is setup evidence, not a product RED. The same iteration also exposed the actual Windows read-only-handle sync refusal; the final confirmation opens r+ without writing. No pre-existing fixture content/assertion was weakened or changed to bypass actual catalog validation.

## Stable final qualification

All commands ran sequentially in this checkout with no concurrent lane runtime here. Vitest used maxWorkers2/minWorkers1. Environment roots are recorded in the execution calls: shell-isolated config, native dependency, result integrity and structure evidence all under the task evidence directory (`final-v2-*` for final runs). New physical fixtures remain under `catalog/`, `metadata/`, `settlement/`; native actual ledger/artifact receipts remain under `final-v2-native/`.

| Command | Result | Raw output |
| --- | --- | --- |
| `pnpm --filter @i-harness/context-output test --maxWorkers=2 --minWorkers=1` | exit 0; 20 files, 134 tests | `final-v2-context-output-tests.txt` |
| `pnpm --filter @i-harness/session-executor test test/native-dependency-membership.test.ts test/native-dependency-composition.test.ts test/native-dependency-observer.test.ts test/native-dependency-refusals.test.ts --maxWorkers=2 --minWorkers=1` | exit 0; 4 files, 11 tests | `final-v2-native-dependencies-tests.txt` |
| `pnpm --filter @i-harness/context-output typecheck` | exit 0 | `final-v2-context-output-types.txt` |
| `pnpm --filter @i-harness/session-executor typecheck` | exit 0 | `final-v2-session-executor-types.txt` |
| `git diff --cached --check` before commit | exit 0 | delivery tool output |

The earlier `final-*.txt` qualification (133 context-output tests, 11 native tests and types) is superseded by the final-v2 qualification after the escaped-source fix. Counts are not summed across overlapping runs.

Physical controls cover native short writes, Stop between writes and after pending sync, file sync failure, link refusal, link success with lost response, a foreign final inserted exactly at publication, retained foreign pending names, immutable final/pending conflicts, post-sync close response loss, cleanup failure, currentness loss after issued publication, passive no-mutation inventory checks and ordinary mutable atomicJson replacement. Settlement tests preserve original operation/catalog/member body bytes, exercise A/unavailable/B/A ordinals, revoke the actual member pin during the later alias operation read, retain canonical bytes after a real lost link response, and refuse noncanonical companions unchanged. Catalog tests use independent JSON.parse fixture oracles, 300 metadata entries, unavailable entries, no physical member artifact, exact count mismatches, duplicate/escaped keys, closed-schema/EOF failures, descriptor budget and valid/invalid page-split Unicode.

The existing native membership test now injects its real lost acknowledgement after immutable link, replacing its unreachable membership-rename hook. It preserves its original uncertainty, no-F1-before-settlement, actual native side-effect ledger, quota and single-execution assertions. Mutable operation rename remains unchanged and is covered by the existing artifact suite.

## Source binding and limitations

`before-head.txt` and `before-hashes.json` capture initial context-output physical source/test hashes before new files. `qualification-source.txt` / `qualification-before-hashes.json` bind the first broad iteration. `final-source.txt`, `final-before-hashes.json`, `final-after-hashes.json` cover 2,573 actual product/test/config files (including all new files and the adapted native test). `final-stability.txt` records `FILES=2573 CHANGED=0` across final-v2 qualification. `commit-source-binding.json` maps each of the eight assigned files' physical SHA256 to normalized working-tree/committed Git blobs; every match is true for commit `1566b38914e2e8e697ec64748ceab93172548212`. `commit.txt` records that full commit. No source-changing edit occurred after the final-v2 snapshot.

Hardlink publication requires filesystem support. Unsupported links intentionally leave recovery work unknown; there is no destructive fallback. This was qualified on the actual Windows checkout/volume. The helpers still rely on the existing artifact mutation/lease owner and path helpers; they add no second lock, queue or metadata store. Hash uniqueness bookkeeping and original registration/canonical settlement collections grow with catalog/member count.

Full transfer scope/service/pins/v2, closure digest/folding, host authorization/project preparation, semantic fork/spawn cutover and later native behavior are outside this foundation. Catalog callbacks cannot be treated as success until EOF. Existing v1 retrieval compatibility is maintained; later transfer must independently validate canonical entry evidence rather than infer it from old readable companions. Product 0.1.13-rc.1/Session11 remain unchanged; known main fork RED and seven staged exports are not waived or relabeled. No provider/live credential/user-session experiments, publication, cross-worktree edits or subagents occurred. All qualification runtimes ended before delivery. Independent functional/quality review remains required.
