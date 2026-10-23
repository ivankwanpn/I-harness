# Task 3 — genuine terminal-confirmation foundation

Status: DONE_WITH_CONCERNS — assigned foundation implemented and locally verified; fresh independent review/integration and later source-acceptance/native-permit work remain.

## Exact ownership and source range

- Worktree: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`.
- Branch: `codex/context-native-transfer-20261023`.
- BASE: `63d9b5dd89397aaece202bf903f5e689065e09a7`.
- HEAD: `57a899e3b74afd9c3d851b99c9c5d0b1d4d8ba4f`.
- Exact range: `63d9b5dd89397aaece202bf903f5e689065e09a7..57a899e3b74afd9c3d851b99c9c5d0b1d4d8ba4f`.
- Commit: `fix(llm-seam): track owned confirmations and single cap source`.
- Assigned product/test files only were committed; checkout clean at delivery. No package exports/facade changes, core-agent changes, schema/serialization additions, other-lane source changes, providers, publication, cross-worktree product writes, or agents.

Changed files:

1. `packages/llm-seam/src/prepared/payload.ts` — private WeakMap, readonly scalar reader, fixed-terminal private payload composition, per-invocation confirmation/issue/end/error tracking.
2. `packages/llm-seam/src/prepared/http-terminal.ts` — built-in HTTP path selects owned private payload composition; fetch overrides select ordinary composition. Ownership and invocation share the captured fetch override choice.
3. `packages/llm-seam/src/prepared/bedrock-terminal.ts` — existing private concrete SDK bridge selects owned private payload composition.
4. `packages/llm-seam/src/prepared/owned-terminal.ts` — fixed composition explicitly rebuilds from one actual derived inner handle.
5. `packages/llm-seam/src/prepared/owned-wrappers.ts` — retry/wait/observation and signal composition follow that one inner derivative.
6. `packages/llm-seam/test/owned-confirmation.test.ts` — 16 real-execution/negative tests using controlled localhost HTTP, synthetic identities, and fixed composition.
7. `packages/llm-seam/test/terminal-ownership-contract.test.ts` — source/API boundary covers private payload constructor importers and absence of reader/constructor/registrar from facade/export subpaths.

## Contracts implemented

`readOwnedExecutionConfirmation(originalConfirmation, expectedPrepared)` remains package-private in `prepared/payload.ts`, because this slice introduces no genuine cooperation consumer. It has no facade/package export and no fake reachability client. The existing public structural confirmation/receipt contract is unchanged.

The lookup associates only the original confirmation created within an actually invoked owned payload. It requires successful issuance and an observed successful terminal `end`, and validates the exact private source-handle identity reached through the trusted fixed-wrapper chain. It returns a frozen scalar object with `version`, `sendId`, `semanticId`, `payloadId`, and `payloadKind`; no payload bytes, execution handle, identity object, allowance, NativeSourceProof, or transport capability escapes.

Lookup is unavailable during confirmation callbacks, after issue but before end, on failed HTTP/decoder attempts, missing-end streams, cancellation before end, guard/issuance rejection before send, copied confirmations, distinct equal-payload handles, wrong cap derivatives, custom payload/local-identity composition, fetch overrides, and public arbitrary callback wrappers. A public wrapper can still execute the underlying real terminal; its own handle remains unverified, while the real executed terminal's handle has evidence. Observed errors/throws after `end` revoke subsequent lookups.

Existing waiting composition aborts its private controller and closes the inner iterator asynchronously after observing `end`; retry composition also closes after end. Evidence therefore follows the successful terminal-end event rather than requiring natural generator drain. This preserves fixed wrapper behavior and permits their completed real invocation to be read. It is terminal evidence at lookup time, not committed Agent acceptance or an irrevocable future source proof. The eventual consumer must still implement later acceptance/source-unit requirements.

The original nested-wrapper cap behavior was reproduced at **16 actual cap derivations** through observation/retry/wait/signal composition. It now derives once and records the very source handle that executed. Retry policy, activity/signal plumbing, payload identities, cap identities, and ordinary calibration are preserved by the affected suites.

A separate regression showed that mutating `transport.fetchOverride` after preparation replaced an invocation already considered owned. Capturing that choice once binds ownership to the executed HTTP path; a later mutation cannot switch it to a custom fetch. Initial explicit overrides retain ordinary standalone behavior and remain unverified.

## TDD and raw evidence

New ignored local evidence root:

`C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main/.tmp/context-parallel-native-20261023/`

All commands ran sequentially within this lane. Every Vitest command used `--maxWorkers=2 --minWorkers=1`. The initial API absence was recorded separately and is not claimed as a reproduced runtime behavior.

| Evidence | Exact command (from worktree root) | Result |
| --- | --- | --- |
| `red-cap-and-api.log` | `pnpm --filter @i-harness/llm-seam exec vitest run test/owned-confirmation.test.ts --maxWorkers=2 --minWorkers=1` | exit1; actual 16-vs-1 cap failure plus separately identified missing reader API |
| `red-behavior-api-unavailable.log` | same focused command | exit1; 14 tests blocked/failing, predominantly missing reader API; not accepted as behavioral RED |
| `red-behavior.log` | same focused command | exit1 after empty private map/reader existed; 4 meaningful positive/cap failures, 10 negatives passed |
| `green-focused.log` | `pnpm --filter @i-harness/llm-seam exec vitest run test/owned-confirmation.test.ts test/prepared-wrappers.test.ts test/execution-receipt.test.ts --maxWorkers=2 --minWorkers=1` | exit1; remaining fixed-wrapper end/cleanup interaction discovered |
| `green-focused-2.log` | same three-file command | exit1; Vitest IPC channel-closed harness failure, no acceptance claim |
| `green-focused-3.log` | same three-file command | exit1; wrapper end interaction still reproduced after IPC retry |
| `green-focused-4.log` | same three-file command | exit0; 22 tests passed at that development source |
| `types-initial.log` | `pnpm --filter @i-harness/llm-seam typecheck` | exit1; recursive function needed explicit return type; corrected |
| `types-focused-2.log` | same type command | exit0 |
| `red-mutable-override.log` | focused owned-confirmation command above | exit1; mutable custom fetch called once despite initially owned preparation |
| `green-mutable-override.log` | same focused command | exit0; 16 tests passed after captured transport choice fix |

Development logs precede the final frozen-source qualification; pass counts are not summed across overlapping runs.

## Final frozen-source verification

The following are final verification runs on the source committed in HEAD; raw files contain the command, UTC start/end and exit. All runtimes finished before delivery.

| Raw log | Command | Result |
| --- | --- | --- |
| `final-seam-tests.log` | `pnpm --filter @i-harness/llm-seam exec vitest run --maxWorkers=2 --minWorkers=1` | exit0; 19 files, 158 tests passed |
| `final-bedrock-tests.log` | `pnpm --filter @i-harness/llm-bedrock exec vitest run test/prepared.test.ts test/physical-attempts.test.ts test/final-validation.test.ts --maxWorkers=2 --minWorkers=1` | exit0; 3 files, 12 tests passed |
| `final-calibration-tests.log` | `pnpm --filter @i-harness/core-agent exec vitest run test/execution-calibration.test.ts --maxWorkers=2 --minWorkers=1` | exit0; 1 file, 16 tests passed |
| `final-types.log` | `pnpm --filter @i-harness/llm-seam --filter @i-harness/llm-bedrock --filter @i-harness/core-agent --workspace-concurrency=1 typecheck` | exit0; all three package type checks passed sequentially |

`git diff --check` exited0. No existing assertions were weakened and no existing fixtures were corrected. New fixtures use literal `{cap:10}` / `{cap:7}` wire bodies, synthetic process-local identity strings, actual built-in HTTP execution, and a localhost server; no real provider/credential was used. The retry test performs an actual HTTP503 response followed by HTTP200 and verifies reservation issue/failed/completed disposition independently for each physical send.

## Source and resolution binding

`capture-evidence.mjs` records complete SHA256 file hashes for 361 product/test/config files covering llm-seam, Bedrock, core-agent, core-session, token-meter, http-transport, image-validation, their package/TypeScript configs, root package/lock/TypeScript config. New owned-confirmation tests are included. `before-final.json`, `after-final.json`, and `commit-bound.json` have identical hashes for all 361 files; `hash-comparison.log` records the before/after equality.

The manifests record actual resolved paths and realpaths of declared workspace dependencies plus Vitest/TypeScript from each relevant consumer. They resolve within this native worktree. Node was `v24.15.0`; Vitest was `3.2.7`. An initial evidence-script attempt incorrectly asked Bedrock to resolve undeclared direct dependencies; it failed before a manifest was produced and was corrected to resolve each consumer's actual declared workspace dependencies. No dependency installation/link modification occurred.

`commit-binding.json` binds the exact seven changed files to HEAD through matching `git rev-parse HEAD:<path>` and `git hash-object -- <path>` object IDs and records their working-file SHA256 values. Git's existing LF/CRLF normalization is respected; the committed filtered blobs match the tested worktree files. It records BASE, HEAD, UTC and the 361 unchanged hashes. This supports source-scoped reuse of the final verification after the commit without rerunning unchanged suites.

## Remaining seams and limits

- No full NativeSourceProof, NativeSourceLookup, selected-unit lookup/digest, source acceptance registration, current-unit closure, source-scope disposal, final native permit, or adapter lowering was implemented.
- No receipt-to-original-confirmation core-agent association was necessary in this foundation. Its future consumer is still required before exposing the readonly reader outside the package.
- Terminal evidence is deliberately insufficient for later native source reuse; committed Agent acceptance and all source-unit/selection/lease gates remain pending.
- Unsupported/custom execution remains unavailable for this stronger evidence and must later fall back portably.
- The original cross-binding spawn baseline, original fork RED, seven staged exports, and deferred Task2 Minor4/5 remain obligations; this report claims no fix/waiver/reseed for them.
- Fresh independent functional/quality review and root integration have not been performed by this lane.
