# Task 2 implementation report — semantic references and ready read scopes

Status: DONE for the approved Task 2 foundation, pending independent functional/quality review. This is not completion of the full R4B host transfer/caller cutover.

## Checkout and exact product range

- Worktree: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`.
- Branch: `codex/context-host-transfer-20261023`.
- Base: `63d9b5dd89397aaece202bf903f5e689065e09a7`.
- Commit: `3946af7755581c5ee3a3ca1be8dd53ed95a123a2` (`feat: qualify semantic result refs and host read scopes`).
- Exact range: `63d9b5dd89397aaece202bf903f5e689065e09a7..3946af7755581c5ee3a3ca1be8dd53ed95a123a2`.
- Clean final worktree; no ongoing runtime/watch process. No subagents, cross-worktree product writes, branch switching, merges, external providers, credentials, publication, or dependency changes.

Files (18):

- `packages/core-session/src/conversation/history/facts.ts`
- `packages/core-session/src/conversation/history/index.ts`
- `packages/core-session/src/conversation/validation.ts`
- `packages/core-session/src/index.ts`
- `packages/core-session/src/results/seed-refs.ts` (new)
- `packages/core-session/test/semantic-seed-result-refs.test.ts` (new)
- `packages/session-executor/src/index.ts`
- `packages/session-executor/src/lifecycle/result-store.ts`
- `packages/session-executor/src/service.ts`
- `packages/session-executor/src/service/result-reader.ts`
- `packages/session-executor/test/result-store-read.test.ts`
- `packages/desktop-gateway/src/project-scope.ts`
- `packages/desktop-gateway/src/context-runtime.ts`
- `packages/desktop-gateway/src/host.ts`
- `packages/desktop-gateway/test/project-scope.test.ts`
- `packages/desktop-gateway/test/context-runtime.test.ts`
- `packages/desktop-gateway/test/result-page.test.ts`
- `packages/desktop-gateway/test/semantic-seed-result-read.test.ts` (new)

## Contracts implemented

`semanticSeedResultRefs(view)` uses the existing semantic-source conversation validation index and its history facts. Bootstrap readiness and the closed seed codec validate manifest/group membership, artifact indices, exact managed refs, result/catalog uses and catalog counts. History retains only ref metadata and associated indices; it does not render or read discarded message bodies. The helper follows actual result/catalog indices, deduplicates the full identical ref, and uses existing branch/rewind visibility. Reset, summary shadowing and validated whole-group replacement leave archived references retrievable. Unused manifest entries are invalid, and text/origin provenance never becomes reference evidence.

`sameManagedArtifactRef` compares version, id, revision, codec, encodedBytes, contentDigest and completeness. Executor automatic-store authorization and Gateway managed authorization consume it. Legacy ContextResultRef has its own branch (it also has a revision, so the discriminator is managed `version`, not revision presence). The actual artifact owner still requires matching committed metadata and a real target pin.

SessionServiceOptions now accepts `resultReadScopeFor(sessionId)`. The actual project-scope broker produces it: undefined only for a target lacking its own binding; otherwise a live getter returns projectId, actual confirmed scope and revision. It checks the target profile/visibility/archive, loads the durable ownership document, and obtains roots only from its own confirmed catalog. Saved projectId alone cannot restore roots. Missing/withdrawn/empty/closed authority throws and never falls back. Independent target bindings let ready reads avoid ancestor traversal. Ordinary reader admission still has no execution projectContext. Without the resolver, automatic-store lineage remains the existing path.

The broker keeps one narrow transient binding revision counter alongside its existing catalog revisions. Binding writes invalidate before await, while catalog configure/revoke admissions already invalidate before asynchronous canonicalization/drain. Per-read frozen revisions reject equal-root reconfigure and revoke/restore ABA. Gateway nativeScopeFor also supplies the real broker revision. Its read-only lineage resolution checks archived ancestors when no independent target binding terminates traversal; execution project resolution is unchanged.

Executor read lifetimes capture the resolver getter, assert currentness around profile/acquisition/body/release boundaries, recheck the target profile after release, and join close. Gateway supplies its existing native service through the fast path, so context-runtime wraps both actual readResult and readExecResult with captured broker revision and target checks before/after body return. Existing context-output pre/post authorization and final owner checks remain intact. No context-output API or model/Assembly setup was introduced.

## RED/GREEN and fixture qualifications

Evidence root (new, ignored): `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/.tmp/context-parallel-host-20261023`.

Each `*.log` includes UTC, exact shell command, HEAD, exit and raw output. Commands were sequential within this lane and used maxWorkers2/minWorkers1. New API absence/setup failures are not claimed as reproduced behavior.

- `core-red.log`: new helper absent (3 positive tests fail with missing API; negative throw assertions are not behavioral evidence at that point). `core-green2.log` exposed fixture object sharing: the hidden-field negative mutated a ref reused by a later test. The fixture now copies each managed ref. `core-green3.log`: 8 pass, and final core adds validated replacement for 9 helper tests.
- `broker-api-red.log`: missing broker API plus an initially incorrect test-only coordinator delete call. Corrected to actual archive metadata; target binding remains independent. `broker-green2.log` initially expected full project display fields, then actual getter included its real name/primaryRoot in addition to the required id/roots. Final broker tests:18pass.
- `reader-red.log`: actual supplied service returned retained bytes despite configured resolver failure. `reader-green.log`:6pass after read resolver gating.
- `native-read-red.log`: real managed body I/O returned a page after broker same-root reconfigure and revoke/restore ABA (2 behavioral failures). `native-read-green.log`:9pass after actual fast-path guard. Later final suite extends this to text and exec-frame bodies plus automatic-reader reconfigure/ABA/target-close.
- `default-lineage-red.log`: actual native read with no target-own binding still returned bytes after its ancestor archived. `default-lineage-green.log`:13pass after narrow read-only ancestor archive check. Final suite:17pass.
- `seed-integration-first.log` through `seed-integration-setup4.log`: setup-only failures while establishing valid READY fixtures (bootstrap final adoption requires dependency reconcile; managed documents require fact admission rather than coordinator.append). No acceptance claim from these. The corrected fixture uses real original artifact grants/pins, actual bootstrap compiler/coordinator, exact same fixture closure on reconciliation, and actual managed compaction admission. It is retrieval fixture preparation, not qualification of the new semantic transfer adapter or pre-ready binding.
- `seed-consumers-behavior-red.log`: deliberately removed only executor and actual host semantic-ref consumption, ran the new byte tests, observed 2 behavioral authorization failures, restored exact source. Native fixture remained independently positive. This qualifies both real consumers separately from initial missing API evidence.
- `full-ref-behavior-red.log`: deliberately replaced full equality with id/revision equality, observed 5 actual body-release failures (version, codec, encodedBytes, contentDigest, completeness), restored exact source. Id and revision negatives already denied. Final context-runtime tests:12pass.
- `identity-first.log`: existing legacy SQLite/code-index tests failed at their long worktree paths while all new exact-ref tests passed. `sqlite-path-probe.log` directly reproduced SQLite failure at a258-character database path (journal creation) and success at129characters. The context-runtime test fixture now uses tmpdir rather than a nested build directory, preserving actual directories/SQLite behavior and every assertion. `identity-green.log`:12pass. No product storage path change.

## Stable final qualification (no overlapping counts summed)

All four commands below ran once against the final frozen source, before commit. `stable.sha256` and `after.sha256` match for every hashed product/test/config file. `source-binding.json` maps every changed path to SHA256 and verifies its normalized worktree blob equals the actual commit blob. Reuse is explicitly source-scoped to commit3946af77; no code changed after these checks. Root package.json, lockfile, workspace config and package versions remain unchanged.

1. `pnpm --filter @i-harness/core-session exec vitest run test/semantic-seed test/conversation test/generation-history.test.ts test/result-envelope.test.ts test/legacy-result-projection.test.ts test/retained-result-search.test.ts --maxWorkers=2 --minWorkers=1`
   - `final-core.log`: exit0;17files,190pass. Includes helper, seed codecs/bootstrap/replacement, conversation history, envelopes and legacy projections.
2. `pnpm --filter @i-harness/session-executor exec vitest run test/result-store-read.test.ts test/result-reader.test.ts test/result-reader-lifetime.test.ts test/retained-result-host.test.ts test/service-result-retention.test.ts --maxWorkers=2 --minWorkers=1`
   - `final-executor.log`: exit0;5files,19pass. Includes existing automatic lease/configuration/close races and real consumer regressions. Service-retention tests use their existing local fake-model execution fixtures; zero model/Assembly assertions belong specifically to the new/read-only paths, not this entire regression suite.
3. `pnpm --filter @i-harness/desktop-gateway exec vitest run test/project-scope.test.ts test/project-scope-host.test.ts test/context-runtime.test.ts test/result-page.test.ts test/result-page-host.test.ts test/semantic-seed-result-read.test.ts --maxWorkers=2 --minWorkers=1`
   - `final-gateway.log`: exit0;6files,53pass. Real broker/catalog/roots, actual managed bytes and pins, default ancestor-loss negative, target-own parent-close positive, cold confirmation denial, full wrong-ref fields, native text+exec revision guards, automatic ABA/close, fresh actual host RPC and legacy project/fork coverage.
4. `pnpm --filter @i-harness/core-session --filter @i-harness/session-executor --filter @i-harness/desktop-gateway typecheck`
   - `stable-types.log`: exit0; all3packages.

`git diff --check` and staged diff check passed. `final-status.txt` is empty. `before.sha256` captures pre-edit hashes across the three owned packages; stable/final hashes include new files. Source/config identity, root config hashes, raw RED/GREEN commands and source-binding.json stay local in the ignored evidence directory.

## Explicit limitations / remaining seams

- Pre-ready project binding, zero-artifact ordering, semantic transfer/caller confirmation and actual fork/spawn cutover were not implemented or claimed. Legacy grant hooks are untouched. New retrieval fixtures use the existing real grant owner solely to establish pins; they do not certify the artifact lane's new transfer protocol.
- No new distributed binding transaction or cross-process CAS is claimed. Broker durable ownership/save/catalog mechanisms remain the existing owners.
- Concurrent relevant revisions may refuse a read even when roots later become equal; this is the intended conservative per-read policy.
- Task2 Minor4/5 and later Task4/Task6 obligations remain where assigned. Known root fork RED/staged exports and product0.1.13-rc.1/Session11 remain unchanged.
- Independent functional/quality review is still required; this report is not self-approval.
