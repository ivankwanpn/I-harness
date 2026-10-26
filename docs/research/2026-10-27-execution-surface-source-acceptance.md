# Execution surface source publication — Task1 limited acceptance

The original Code Mode and SessionService owners now publish observation changes after actual installation and bookkeeping, expose passive availability, and retire observation synchronously before disposal waits. This accepts only source publication/retirement. ExecutionPane still uses its existing UI path; Gateway/SDK/native subscription composition, capability advertisement and zero-idle-read qualification remain Tasks2–6.

## Source and independent review

- Plan/spec: `docs/superpowers/{plans,specs}/2026-10-27-execution-surface-observation.md`, including root ruling O1-S01.
- Isolated candidate: `0fce736349c16aba8f019f87488124cbaf72d101..39489aa6534c1e12de83a804056b004b0df6bdde`, eight reserved source/test files, NATIVE worktree.
- MAIN integration: `381dc63a496499d8c1d7a3c318e0eb454c155da0`. All eight integrated Git blobs equal the reviewed candidate. Product remains0.1.13-rc.1/Session13.
- Independent `execution_surface_source_review_sol_20261027`: spec PASS, quality APPROVE, no actionable Important/Minor. Its report is `.superpowers/sdd/2026-10-27-execution-surface-observation/task-1-review.md`.

## Behavior accepted

Code Mode availability includes initial readiness, whole started-handler/local-install transitions, original pending and source recovery holds, installation faults and irreversible retirement. Pure state reads and subscriber callbacks never prepare models, execute tools, clear holds or drive reconciliation. Exceptions in observers do not roll back producer publication.

The failed-start observation hold clears only after its exact original interrupted record commits, finishes the action, leaves pending bookkeeping and completes handler bookkeeping. A late receipt can restore truthful observation after the caller rejected, but cannot start a broker cell, add live cells or resume guest work. Unrelated success cannot release that hold; actual sticky source faults remain unavailable.

The original `revokeNewWork` path and service extension-dispose wrapper retire observation before their first wait. Lifecycle events carry exact assembly identity. IncludeExisting registers first, never publishes an unpublished active mount or retired failed-cleanup owner as live, and handles reentrant retirement. Successful original cleanup produces removal; failed cleanup retains the same retired debt. Consumer detachment does not close or detach the producer's recovery subscription.

## Verification

Candidate evidence contains the causal REDs, fixture/type corrections, source snapshots and exact commands. Controlled probes demonstrate that dropping the whole-handler condition exposes availability before live-cell installation, and dropping the exact-source hold exposes availability at pending-size zero before source close. Both probes restored exact source hashes before their full target-file GREEN runs. A first relative restore path failed because the runner changed CWD; absolute restoration occurred before any intervening runtime/test and is documented.

Root independently matched all eight source snapshots and Git blobs, the complete changed-file set, 23 raw log hashes/exits, runner and 57-direct-dependency resolution evidence. The initial root patch comparison incorrectly compared `git diff` with `git show` including its commit preamble; the preserved corrected audit verifies that commit prefix and then compares the exact diff body after CRLF normalization. No source mismatch occurred.

On fixed MAIN381dc63a, root ran the prescribed packages sequentially with direct Node24.15.0/Vitest3.2.7/TypeScript entrypoints, maxWorkers2/minWorkers1 and fresh six IH roots for each command:

| Population | Result |
|---|---|
| Code Mode surface-publication, output-source-recovery, register, managed-store-stop |28/28 passed|
| Executor lifecycle, execution-state, code-mode, code-mode-live-settings |25/25 passed|
| Code Mode TypeScript --noEmit |exit0|
| Executor TypeScript --noEmit |exit0|

All eight source hashes remained stable. The executor's deliberately held cleanup case prints `Code Mode disposal failed: Error: original mount cleanup held`; this is expected original-owner failure evidence, not an unhandled or suppressed result. Candidate and integration populations overlap and are not additive.

Exact root evidence: `.superpowers/sdd/2026-10-27-execution-surface-observation/task-1-evidence/root-integrated.json`, its four logs, `root-audit.json` and `root-source-audit-corrected.json`; original comparison failure remains in `root-source-audit.json`.

## Explicit limits and next handoff

Task1 is complete within this scope. F1's frozen assembly delta and the passive-code-store lane are separate and still require serial integration with their own tests. Shared Gateway/SDK/Desktop subscriptions, real pane/IPC route, capability advertisement, removal of the1500ms poll, O2/O3/W2/IG, native gates and the full version are not accepted by these results. No remote push, tag, release or installed application change occurred.
