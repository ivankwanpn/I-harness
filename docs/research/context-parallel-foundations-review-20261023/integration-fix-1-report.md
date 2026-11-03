# Integration fix 1 report — typed result denial after release

Implementation submitted for same-host review; this report does not accept the integration or complete Task 3/5.

## Source and scope

- Checkout: `D:/I-harness-main`, branch `codex/v0.1.13-development`.
- Exact range: `a6065a0e4cafb8a31c28630a274e1fb9120f5893..7706c2ea768af6da573ebb9abef75ef12aad4969`.
- Commit: `7706c2ea768af6da573ebb9abef75ef12aad4969` — `fix: preserve typed result denials after read release`.
- Explicitly staged and committed only `packages/session-executor/src/service/result-reader.ts` and `packages/session-executor/test/result-reader-lifetime.test.ts` (20 insertions).
- Root dirty plan remained byte-equivalent as a Git diff to its pre-work snapshot. Final tracked status contains only the pre-existing modification to `docs/superpowers/plans/2026-10-23-context-parallel-foundations.md`.
- Product 0.1.13-rc.1 / Session 11 unchanged. No new owner/index, broader cleanup, external provider, credentials, user session, subagent, publication, or remaining integration gate.

## Root cause and correction

The actual native observer archives its genuine parent during verified child frame reading. `artifact/ownership.ts` reauthorizes after reading the frame; the current source authorization refuses the archived parent. `readManagedResultPage` maps this existing artifact denial to `{ kind: 'unavailable', reason: 'unauthorized' }`. The newly integrated post-release profile guard then sees `meta.archived` and replaces that meaningful bodyless denial with generic `unavailable`.

After the awaited release/failure handling, the reader now returns an already-bodyless result before the final page currentness checks. `ResultPageResult` has `kind` only on its unavailable variant; this branch cannot return an artifact page or exec frame body. Successfully obtained pages still pass the existing final scope assertion, awaited profile/archive check, second scope assertion, and availability check. Earlier admission/read assertions and release-error mapping are unchanged. No scope/error is newly classified as unauthorized.

Added one paired real-store behavioral control in the existing lifetime test: a real successful read for `s` and a real unauthorized read for `other` encounter archival during the cold owner's final release. The successful page must be discarded with an exact bodyless generic result; the denied read must retain the exact bodyless unauthorized result. The existing close hooks control timing around the real owner close; they do not fabricate the read outcome.

## Verification and raw evidence

Evidence root: `D:/I-harness-main/.tmp/context-parallel-integration-fix1-20261023`.

Its `run.ps1` is copied from the prescribed isolated runner. Each invocation sets shell `IH_CONFIG_DIR` to this evidence root's `config` and distinct per-name `IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT`, `IH_RESULT_INTEGRITY_EVIDENCE_ROOT`, and `IH_STRUCTURE_EVIDENCE_ROOT`. Prior logs and sealed evidence were not overwritten. Each log records UTC start/end, starting HEAD, exact command, raw output, and exit. Runs used Node v24.15.0 / pnpm 12.3.4.

| Phase | Command after `pnpm` | Result | Raw log |
| --- | --- | --- | --- |
| RED, tests added before product edit | `--filter @i-harness/session-executor exec vitest run test/native-dependency-observer.test.ts test/result-reader-lifetime.test.ts` | Exit 1; 2 failures, 5 passes. Original native observer and new unauthorized release case both expected unauthorized but received unavailable. Successful-page discard control passed. | `red.log` |
| Focused GREEN | `--filter @i-harness/session-executor exec vitest run test/native-dependency-observer.test.ts test/result-reader.test.ts test/result-reader-lifetime.test.ts test/result-store-read.test.ts` | Exit 0; 4 files / 18 tests passed. Native observer completed its real child/catalog/archive/rewind lifecycle. | `green.log` |
| Executor typecheck | `--filter @i-harness/session-executor typecheck` | Exit 0; `tsc --noEmit`. | `typecheck.log` |

`git diff --check -- packages/session-executor/src/service/result-reader.ts packages/session-executor/test/result-reader-lifetime.test.ts` exited 0 before commit. Git emitted only the existing checkout's LF-to-CRLF normalization warning for the test. Self-review confirmed the committed paths, discriminated bodyless branch, unchanged page guards, and awaited release before returning failures.

The successful native run's `green-native/observer-bMZUqR/cleanup.json` records `allOwnedJobsClosed: true`, one launch, and `jobId: bash-1`; its `observer-receipt.json` contains the completed real observer evidence. `runtime-status.json` records no matching Node/Bun/cmd test or task-native processes after test/typecheck completion. All command sessions have exited.

## Source binding

Full-file SHA-256 manifests cover all tracked files under `packages` plus root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `tsconfig.base.json`: 2,677 entries, including source, tests, package configs, and compiler/Vitest settings. `before.sha256` is BASE before edits; `red.sha256` is BASE plus the regression control; `green.sha256` was captured before GREEN/typecheck; `after.sha256` after both. GREEN and after manifests are identical. Comparing before/after changes only the two committed files. Logs report BASE as HEAD because validation preceded the explicit commit; these manifests bind the exact tested working tree.

| File | Before SHA-256 | Tested/after SHA-256 |
| --- | --- | --- |
| `packages/session-executor/src/service/result-reader.ts` | `438b42425a05b54b4b6e0c9e8533bec9f21bf0019f87fad8f3337a280a5962bd` | `e8c094e11f737bc87933b2c104825b7a1bfd8530bf933c45894050a84e77498b` |
| `packages/session-executor/test/result-reader-lifetime.test.ts` | `5a2f88fc0c9b3931f7093f61cce4a23c3871617ed3cf9348a3aaf61e85176357` | `23783a373f05d39b45a819931f4b448754f462025a679bfd6726e654436d9fd9` |

Manifest SHA-256:

- `before.sha256`: `e6e52fa598034e0e0646153dfe5e5995f07137d54ee2cafcc1f2d78536734b78`.
- `red.sha256`: `eab37ad55e05fe5295f7668fc174fe84d8bd85a7ed35054cdc906846e54b1061`.
- `green.sha256` and `after.sha256`: `62f2f6a765cb254d71a286a1ea41e4783cd018066c737b75917b113e17849d18`.

`evidence-files.json` records hashes for those manifests, all three logs, and the runner. `commit.txt` records the final commit and exact stat.

## Limits and handoff

No full context-output repeat, additional Gateway/seam/integration gates, fork cutover, or full Task 3/5 was performed. Root resumes those gates after independent review. This focused correction preserves the already denied result at the new post-release guard; it does not redesign earlier scope assertion or release failure precedence. The same-host reviewer should assess the narrow fix and broader integration implications before acceptance.
