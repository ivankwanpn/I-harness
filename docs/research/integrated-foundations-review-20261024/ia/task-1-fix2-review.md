# Task 1 fix round 2 independent review

## Spec compliance

**✅ Spec compliant for this fix; residual P1 addressed.** Reviewed exact range `8475aa3fa1b17270125c22b50d5695e6172ac86d..82d4b7a7c19f2971d7b21afd37c38ab6982bd8d0` against `task-1-fix-round2.md`, the fix1 finding, and the previously reviewed IA contract. No new blocking finding was identified in this three-file fix range. P2 remains closed and its cleanup implementation is unchanged.

## Residual finding and quality checks

- **Mapping uncertainty is preserved:** [discovery.ts:71](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/discovery.ts:71) adds a detached, frozen resolution result containing verified aliases and explicitly unavailable targets. The catch at line 85 now records failure instead of silently presenting the remaining aliases as complete. A later successful content/discovery lookup cannot erase that uncertainty.
- **Readiness is withheld until reconciliation succeeds:** [service.ts:138](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/service.ts:138) tracks failed targets, retains prior verified alias mappings while uncertainty remains, and requests another watch-interest update. The target override at [service.ts:151](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/service.ts:151) makes affected applicability unavailable/incomplete through the existing snapshot builder. [service.ts:158](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/service.ts:158) retains build work and affected dirty slots. The next prepare therefore executes the existing awaited interest barrier before resolving mappings again; the uncertainty is removed only after a successful resolution.
- **The exact transient failure has a causal control:** [dependencies.test.ts:90](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/test/dependencies.test.ts:90) uses a real junction, one injected alias `realpath` EACCES, and successful subsequent filesystem lookups. It asserts that content can be discovered while the target still remains unavailable. A held recovery update proves that snapshot readiness does not change before the observation barrier resolves. After recovery, canonical marker creation invalidates immediately and narrows policy; pending removal settles back to broad policy. An independent target's full applicable record remains equal throughout.
- **Permanent failure remains bounded and retryable:** [dependencies.test.ts:119](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/test/dependencies.test.ts:119) checks unavailable/incomplete results, bounded lookup attempts, a fresh observation update and real retry on a second prepare, and unchanged independent applicability. The implementation returns the unavailable result rather than spinning internally.
- **Known absence remains distinct from uncertainty:** [dependencies.test.ts:131](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/test/dependencies.test.ts:131) verifies ordinary missing ancestors remain ready/complete with absent slots and that clean repeated preparation returns the same snapshot without reinstalling interests. The unchanged canonical resolver handles ordinary ENOENT ascent.
- **The repair stays within the existing owner:** Only discovery, service reconciliation and dependency tests change. The fix introduces no new resource owner, public contract, exported package entry, consumer integration, settings behavior, observation producer or event-derived source authority. P2 cleanup code and tests remain unchanged in this range.

## Findings

**Critical:** None identified in the reviewed fix.

**Important:** None outstanding from the original review or either fix recheck.

**Minor:** None recorded.

## Verification evidence

- Read the complete supplied fix diff, exact round2 brief, appended implementation report and source-binding record. A later diff line-number lookup supplied citations. No changed source file was separately reread, no outside-diff code search was needed, and no Git command was run.
- [fix2-red.log](D:/I-harness-main/.superpowers/sdd/2026-10-24-instruction-source-foundation/fix2-red.log:1) contains **two causal failures / 14 passes** at fix1 source: the transient case incorrectly returned ready, and the permanent failure did not retry. The known-absence control already passed. These failures match the residual finding rather than setup/import/timeouts.
- [fix2-green.log](D:/I-harness-main/.superpowers/sdd/2026-10-24-instruction-source-foundation/fix2-green.log:1) records **50/50 affected discovery/dependency/lifecycle tests**, exit 0. [fix2-package-gate.log](D:/I-harness-main/.superpowers/sdd/2026-10-24-instruction-source-foundation/fix2-package-gate.log:1) records **68/68 tests across five files**, correct package cwd, bounded workers and serial files, exit 0. [fix2-typecheck-gate.log](D:/I-harness-main/.superpowers/sdd/2026-10-24-instruction-source-foundation/fix2-typecheck-gate.log:1) records `tsc --noEmit`, exit 0. No test/type warnings or unhandled errors appear in those gate logs.
- Independently recomputed **all 13 file hashes in each package/typecheck gate receipt** against current files: **zero mismatches in both**. The receipts identify dirty source at the previous HEAD; [fix2-source-commit-binding.json](D:/I-harness-main/.superpowers/sdd/2026-10-24-instruction-source-foundation/fix2-source-commit-binding.json:1) records promotion to `82d4b7a7c19f2971d7b21afd37c38ab6982bd8d0`, the exact focused range, and the three changed files.
- The package receipt records synthetic home/config/temp `D:/ia-gate-2d2b6d7f1a014c37a171d6847763720b`. The unchanged five-test legacy suite remains explicitly legacy; this isolated gate does not claim ambient isolation of legacy production behavior.
- Recomputed the root-owned Gateway diagnostic SHA256: `9FB750A75EC847DC97DD95D16E7EC7668B65D919BCB8208805F9A34FB93CEC68`, unchanged. No product/test files, index, branch, Git state or diagnostic were modified. No agents were dispatched.
- No passing suite or probe was rerun: the exact new failure/recovery behavior is covered by causal receipts bound to the reviewed implementation, and inspection raised no additional concrete doubt requiring execution.

## Assessment

**Task quality: Approved for the internal IA foundation.** The residual readiness defect is repaired with explicit failure state, retained dirty work, a fresh observation barrier and per-target qualification. The original P1/P2 findings and the fix1 residual are now closed.

**⚠️ Acceptance boundary:** This is internal injected-observation staging only. IB must still supply the real shared observation/migration owner, and IC/ID must connect actual current/request and child owners. This review does not accept public instruction support, consumer integration or release completion.
