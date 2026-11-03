# F0 fix round 2 — terminal bootstrap capture refusal

Status: appended correction committed and frozen for the same reviewer's fresh connected review. No owner-approval or shipping-completion claim is made.

Checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`

Branch: `codex/fork-binding-observation-20261024`

Original BASE: `ca81bdd2ec944105b9fd62534a932336e587179e`

Reviewed parent: `187eea5545f5ab462e210e168e2db6cb9af1deb9`

New HEAD: `4d999d251823b964398348165de94ea7d432080e`

Commit: `fix(persistence): refuse failed bootstrap capture without retry`

Only the private `coordinator/binding-observation.ts` and existing `test/binding-observation.test.ts` change: 65 additions / 7 deletions. No amend, new registry, native implementation change, MAIN product edit, remote action, live account/provider or child agent occurred. The four protected retirement directories remain untouched. The complete F0 BASE..HEAD stays within the original eleven-path owner scope.

## Remaining finding and correction

The fix-round-1 review identified a genuine capture-error escape: after the facade's capture threw, its catch called the original owner again with raw caller objects outside mutation admission. A one-shot guard descriptor/has trap could fail on the first inspection and succeed on the second, allowing the original owner to rewrite a currently observed ancestor without revoking it.

Both bootstrap and resume capture failures are now terminal. They directly return the original closed `{ kind: 'refused', reason: 'manifest-invalid' }` outcome. No original-owner callback, caller reinspection, pending admission, lane or backend issue occurs after that capture error.

These helpers and their bootstrap admission callback are now explicitly `BootstrapOutcome`-specific. There is no generic result cast or fabricated callback result. Successfully captured work still reaches the same original managed/bootstrap owner through the existing mutation admission and exact captured-target exception.

The helper first preserves the original owner's unsupported-before-capture decision, using its exact enabled-lock and six actual backend bootstrap capability conditions. Unsupported bootstrap/resume returns `{ kind: 'not-issued', reason: 'unsupported' }` before inspecting caller input. This is a synchronous capability check, not a second bootstrap registry or new authority. The original owner still owns all successful validation, flight sharing, header/fact issuance and recovery.

Malformed request fields, invocation fields and optional resume payload accessors retain manifest-invalid refusal without running their getters. Existing target preparation capture/absence, live guard receiver/Stop, genuine original target promotion/shared-flight/unknown recovery, and R1-04 held-admission data capture controls remain unchanged and pass.

## Causal RED at the reviewed parent

`evidence/fix-round-2/terminal-capture-red` snapshots product source at `187eea55` and runs seven new controls: six fail and the ordinary malformed/accessor control already passes. The four primary cases use actual JSONL existing-empty ancestors observed by a paused external callback, then invoke bootstrap or resume with one-shot descriptor or `has` inspection traps.

Raw stdout emits the actual before-fix facts for all four cases:

- Guard inspection count: 2.
- Actual backend call counts: `[3, 1, 1, 1, 1]` in order `readBootstrapState`, `prepareBootstrapHeader`, `reconcileBootstrapHeader`, `appendOwnedBatch`, `confirmBootstrapFrames`.
- Header byte equality: false.
- The call returns an actual ready receipt while the observation's guard still succeeds.

The two unsupported cases return unsupported but unnecessarily inspect the caller guards once; they fail the original unsupported-first no-inspection contract.

`terminal-capture-green` passes all seven after the product correction. Final stdout records the four primary cases as inspection count 1, backend counts `[0, 0, 0, 0, 0]`, and unchanged header bytes. The observation remains current and completes normally, then an ordinary metadata mutation progresses. A bounded race detects an erroneous wait on the paused observation; no wait occurs. Fixture teardown also closes through the normal coordinator owner.

The backend counters are spies over actual JSONL methods, not replacements for successful issuance. The RED reaches actual disk/header/journal work through the original bootstrap owner. These counters are not native kernel resource-failure or OS-wide handle census evidence.

## Final verification

All gates have exact executable/argv, package CWD, UTC start/end, exit/signal and worker values in `command.json`, plus raw stdout/stderr and copied eleven-file source manifests. Vitest commands run sequentially with `--maxWorkers=2 --minWorkers=1`; the two independent typechecks run in parallel.

| Final gate | Actual result |
| --- | --- |
| `handoff-owner` | 90 passed: 56 observation controls (all prior 49 plus seven new), ownership18, managed14, strict document2; exit 0 |
| `handoff-jsonl` | 70 passed: all 58 physical bootstrap controls, strict reader6 and owned deletion6; exit 0 |
| `handoff-types-1` | persistence `exec tsc --noEmit`; exit 0 |
| `handoff-types-2` | JSONL `exec tsc --noEmit`; exit 0 |
| `diff-check-command.json` | `git diff --check`; exit 0; only Windows line-ending conversion warnings in stderr |

The first persistence typecheck (`final-types-1`) retains a test-instrumentation TS2339 error: a heterogeneous array of spies on optional backend methods inferred a never element. The test now gives its counter collection an explicit mock-call shape; assertions and product behavior are unchanged. Both affected suites and both typechecks were rerun on that final source. No other unexpected product test failure appeared in this round.

Full packages were not repeated, following the root's requested verification boundary: the correction is confined to terminal pre-admission refusal and compatibility checks, all prior 49 observation controls plus all 58 physical bootstrap controls pass, and the additional owner/managed/strict/deletion checks and both typechecks pass. The fix-round-1 full package receipts remain historical evidence for `187eea55`, not newly claimed full package runs at this HEAD.

The original F1 `semantic-fork-baseline.test.ts` / `CONSUMED-PROOF-ONLY` obligation remains visible in the immutable earlier reports and raw full-package receipts. Its test, fork.ts, seed.ts, core-session and fs-lock trees are diff-empty against original BASE (`f1-paths-unchanged.patch`). No BASE rerun, oracle edit, waiver, reseed or new global-green claim was added.

## Source binding and prior-evidence preservation

`final-gate-source-comparison.json` verifies that all four final gate copies equal the current physical eleven-file source. `committed-source/manifest.json` binds those physical hashes to new HEAD and separately verifies that CRLF-normalized LF bytes equal the canonical Git blobs. Raw physical/Git bytes are not claimed equal where Windows line endings differ.

`fix-range.patch/stat` covers `187eea55..4d999d25`; `full-base-head.patch/stat` covers the connected `ca81bdd2..4d999d25` range. Final status contains only the four protected preexisting untracked retirement directories.

`previous-preservation-after.json` independently rechecks every byte count/SHA256 for all 295 original Task 1 evidence entries and all 392 fix-round-1 entries, with no extra files in either old subtree. Both prior reports and both prior evidence manifests retain their before-round hashes. No old report, manifest or receipt was edited. The earlier audits' historical limitations remain unchanged.

The new evidence manifest is an unsigned current inventory, not an independent authorship or full dependency/runtime attestation. It binds this report and the round's artifacts while excluding itself. Native execution evidence remains Windows only. No native backend fault or Linux execution claim is added.

## Review handoff

Source/runtime work is stopped at `4d999d251823b964398348165de94ea7d432080e` for the same reviewer. The next review should cover this correction and its interactions over the complete `ca81bdd2..4d999d25` owner range.

F0 remains staged. F1 still requires the real production acquireCliForkTransfer caller, actual stdio fork route, nonempty result catalog/member transfer, ordinary cold target read, original-invocation adoption and final vertical-range reachability. No F1 completion claim follows from this correction.
