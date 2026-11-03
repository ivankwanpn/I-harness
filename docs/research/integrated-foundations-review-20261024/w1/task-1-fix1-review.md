# W1 fix round 1 independent re-review

## Spec compliance — Addressed

The Important readiness finding from task-1-review.md is addressed in `341137236e2a7cc4eb655d635ed36cf3f054b7cd..8bea6e9ddbb6049c96f05670ee30d7fb07b24c77`. Reviewed the supplied fix diff, fix-round brief and appended implementation report. All code references below are relative to `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`.

- `packages/fs-watch/src/leases.ts:138–141` now checks the captured generation, healthy state and service fence immediately after synchronous reset publication. An observer that retires the source changes the generation/state, so the retiring continuation returns before it can settle replacement leases on the closing tombstone. Closed leases are also excluded from settlement. Promise resolution introduces no synchronous observer callback inside the remaining loop, so the guard covers the actual reentrancy boundary.
- The existing cleanup and replacement flow remains responsible for the new lease's own readiness. The fix adds no scheduler, factory, ownership map, public API or caller change (`packages/fs-watch/src/leases.ts:134–144`). It preserves the prior source-specific close-retry authority and tombstone behavior.
- Four new deterministic controls exercise initial/recovered reset retirement crossed with successful/failed held cleanup (`packages/fs-watch/test/leases.test.ts:272–334`). They assert readiness stays pending during cleanup, old callbacks remain quiet, replacement construction alone does not settle readiness, successful replacement initialization precedes the ready continuation, and failed cleanup rejects readiness with FS_WATCH_CLOSE without later recovery rewriting that promise. Repeated close identity and subsequent current-source delivery are checked in the same causal scenario.
- The added Windows control uses actual native readiness and file notifications while explicitly holding completion of actual old-source close (`packages/fs-watch/test/lease-windows.test.ts:76–108`). It verifies epoch 2 initialization before readiness and reads the written replacement-source content. Its hybrid held-close label accurately describes the injected part.

## Code quality — Approved for this fix and W1 task review

The five-line production change fixes the demonstrated callback-boundary race directly, without adding competing lifecycle machinery. The regression matrix distinguishes cleanup, construction and native readiness rather than merely checking eventual delivery. No new blocking or Important issue was established in this fix range. The sole blocker in the original task review is closed; the original review's staged-consumer and qualification limits remain in force.

## Evidence and limits

- Read the supplied fix diff once; no changed source was separately reread and no broader code search or Git command was run. No new concrete doubt required another execution probe, so no tests were rerun merely to reconfirm the reported green results.
- The appended report records four causal RED failures on the previous source, then four passing focused cases after the guard, followed by 38 passing lease/lifecycle/Windows-hybrid-child tests and both fs-watch/settings typechecks. These remain implementer-run results; this re-review checks their test assertions and source binding rather than presenting them as independently rerun evidence.
- At `2026-10-23T16:57:02.418Z`, computed LF-normalized Git blob identities without Git commands for all three fix files. They exactly matched the fix diff/report: leases source `baa960e2544dae89e7d909a09a6096c9c32b5d21`; lease tests `7175411793cbc2483051210810754822da1f3432`; Windows tests `1c9249f074db8cc7531876996db21437531bfba7`.
- Unaffected legacy/settings runtime suites and reachability were not rerun in this round; their earlier evidence remains explicitly prior-commit evidence. This fix changes no exports or production callers. I2/W2 consumption, the recorded non-green reachability gate, legacy pre-ready history limitations and eventual integrated/release qualification remain obligations. No cross-platform, spontaneous Windows failure or zero-CPU proof is inferred.
- Checkout remained read-only with no product, index, HEAD, branch or dependency mutations. The only retained write is this requested MAIN SDD re-review.
