# Task 1 independent spec and quality review

## Spec compliance

**❌ Issues found; IA acceptance needs fixes.** Review range: `41ad97d39fa1f056ef55cd55c7411b501e6ef130..43e6ec4f64f3a01855b0790360507c0cf75f64ac`. The implementation follows the approved internal API and file ownership, but canonical Git-boundary events can leave stale evidence marked ready, and Git-marker handle cleanup failures are lost during close. These violate the approved observation/alias contract and IA3 cleanup contract.

**⚠️ Integration remains outside this task.** The injected observation fixture establishes no real producer guarantee. IB must supply observation and migration ownership; IC/ID must connect the actual current/request and child owners. The ten-file diff adds internal modules/tests only. A focused check of [package.json](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/package.json:6) confirms the public export still points to legacy `src/index.ts`; no public instruction-support or release acceptance follows from this review.

## Strengths and verified checks

- Exact DTO types and method shapes are present in [contracts.ts](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/contracts.ts:2). Scope and target data are copied and recursively frozen, and live capability methods are captured through descriptors with the original receiver instead of freezing the owner; see [discovery.ts](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/discovery.ts:10), [service.ts](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/service.ts:8), and the capability replacement/getter control in [source-lifecycle.test.ts](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/test/source-lifecycle.test.ts:62).
- The discovery tests use actual files, invalid-directory candidates, Git directories/pointer files, junction aliases/escape, exact global allowlists, and casing/separator aliases. Relevant controls are [discovery.test.ts](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/test/discovery.test.ts:9), lines 18, 25, 39, 50, 65 and 72. Synthetic ambient sentinels are accompanied by filesystem-call assertions, rather than only checking final text.
- Content reads use bounded `FileHandle.read`, a shared four-byte lookahead allowance, 64 KiB maximum buffers, identity rechecks and cleanup; see [reader.ts](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/reader.ts:12). UTF8/header/marker accounting, real multi-MiB bounded reads, disabled/zero work, and exact 128-directory/256-slot limits have behavioral controls in [limits.test.ts](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/test/limits.test.ts:7), lines 14, 26, 31, 37, 45 and 51.
- Absence/priority dependencies, same-size/same-mtime event-driven rereads, zero-I/O clean preparation, independent applicable fingerprints, post-watch installation reconciliation, synchronous pending publication, successful/failed/partial settlement, and stale revision recovery have concrete positive/negative assertions in [dependencies.test.ts](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/test/dependencies.test.ts:7), lines 15, 22, 30, 37 and 45.
- Held source reads, bounded dirty retries, concurrent target union, joined close with lease failure, subscriber isolation, last-known-good/deletion recovery, and reentrant close/prepare are covered in [source-lifecycle.test.ts](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/test/source-lifecycle.test.ts:21), lines 27, 33, 41, 47, 54, 71, 78 and 85. These are meaningful controls, although the two combinations below remain uncovered.

## Important findings

### 1. [P1] Canonical Git-marker events do not invalidate lexical alias applicability

**Location:** [service.ts:48](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/service.ts:48), [service.ts:55](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/service.ts:55), [service.ts:70](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/service.ts:70); lexical marker interests originate in [discovery.ts:62](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/discovery.ts:62).

For a target through `root/alias -> root/real`, the service knows canonical instruction-file paths but retains only lexical `.git` marker paths. An observation of `root/real/.git` neither overlaps a candidate `AGENTS.md`/`CLAUDE.md` path nor matches the alias marker interest. `mark()` therefore returns without invalidating the applicable view. This affects ordinary changed events and the same matching logic used for pending metadata. The contract explicitly allows canonical observation paths and requires boundary metadata/alias invalidation.

**Focused Windows probe:** Created real broad and narrow instruction files and a real junction; prepared the alias target; then created `real/.git` and emitted a canonical `changed` event. Actual output:

```json
{"probe":"canonical Git marker event through junction alias","initiallyBroad":true,"immediateReliability":"ready","nextStillBroad":true,"unchangedSnapshot":true}
```

Expected: immediate applicable reliability becomes unavailable, then preparation discovers the new boundary and removes the broad root rule. The implementation instead returns the identical ready snapshot indefinitely until another matching invalidation occurs. Preserve canonical boundary dependencies/mappings for each lexical target and match both changed paths and pending paths against them. Add a junction-alias canonical-marker creation/removal control, including synchronous reliability and an independent unaffected target.

### 2. [P2] Git-marker handle cleanup failures are swallowed during joined shutdown

**Location:** [discovery.ts:87](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/discovery.ts:87), [service.ts:142](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/service.ts:142), [service.ts:174](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/src/service.ts:174).

The Git-marker reader closes its handle in `finally`, but the encompassing catch converts a rejected `handle.close()` to an ordinary invalid marker. Only `InstructionReadCleanupError` from the instruction-content reader reaches `cleanupFailures`. Consequently shutdown joins the marker read and still resolves successfully after the handle close rejected, violating IA3's requirement to preserve cleanup failure. The existing cleanup control at [source-lifecycle.test.ts:91](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/instructions/test/source-lifecycle.test.ts:91) instruments an instruction file, not the Git-marker reader.

**Focused real-file probe:** Opened an actual `.git` pointer file, held its real read result, called service close, and released the read. The handle wrapper performed native close and then rejected with `marker cleanup failed`. Actual output:

```json
{"probe":"close during held Git marker read with handle cleanup failure","prepare":"INSTRUCTIONS_CLOSED","close":"resolved"}
```

Expected: preparation rejects closed and service close rejects with the cleanup failure. Distinguish Git-marker cleanup errors from ordinary malformed/unreadable metadata and route them through the same cleanup aggregation. Add the held marker-read shutdown control, including the combined lease/marker failure case if aggregation changes.

## Evidence and review boundaries

- Read the task brief, execution constraints, implementation report and complete promoted IA plan, including IA1–IA3, then inspected the complete supplied ten-file diff. The initial tool response truncated its middle; only the omitted service/snapshot/dependency/discovery-test portions were recovered. No changed source file was separately reread. A later diff line-number lookup located the cited findings.
- The named outside-diff code risk was accidental public exposure: inspected only `packages/instructions/package.json`, whose export is still `./src/index.ts`. No broader code crawl or Git command was used.
- [package-gate.log](D:/I-harness-main/.superpowers/sdd/2026-10-24-instruction-source-foundation/package-gate.log:1) records the package cwd, `--maxWorkers=2 --minWorkers=1 --no-file-parallelism`, **58/58 tests across five files**, and exit 0. [typecheck-gate.log](D:/I-harness-main/.superpowers/sdd/2026-10-24-instruction-source-foundation/typecheck-gate.log:1) records `tsc --noEmit`, exit 0. Neither gate log contains warnings or unhandled diagnostics. No passing suite was rerun.
- Independently recomputed all **13 file hashes** in each gate identity receipt against current files: **zero mismatches** for both test and typecheck gates. The receipts bind their dirty source state at BASE; [source-commit-binding.json](D:/I-harness-main/.superpowers/sdd/2026-10-24-instruction-source-foundation/source-commit-binding.json:1) records promotion to the stated HEAD and the matching owned file list. The supplied full diff also contains only the ten permitted added files. Gate success is therefore evidence for the reviewed implementation, but not evidence against the newly reproduced cases.
- Inspected behavioral RED discovery output: precedence, scoped rendering, exact globals, and alias assertions failed against the empty baseline, rather than only import/setup failures. The report explicitly disclaims causal significance for the lifecycle timeout/unhandled-assertion cases; no lifecycle RED proof is inferred from those cases.
- Gate isolation records a synthetic `D:/ia-gate-...` home/config/temp path. The unchanged five-test legacy suite's isolated pass does not prove ambient isolation in legacy production behavior. The new sentinel control does establish the narrower explicit-scope claim. No user home/profile/provider reads were made in this review.
- Ran only the two focused probes above, with Node v24.15.0 and the exact current internal module. They used newly owned `D:/ia-review-*` directories; cleanup validated each resolved root against its exact parent and prefix before recursive removal. No product, test, index, branch or Git state was mutated. No subagents were dispatched.
- Independently hashed the root-owned untracked Gateway diagnostic: `9FB750A75EC847DC97DD95D16E7EC7668B65D919BCB8208805F9A34FB93CEC68`, matching the report. It was not edited or staged.

## Assessment

**Task quality: Needs fixes.** The internal foundation has substantial real-files and lifecycle coverage and honors the ownership boundary. The two reproduced defects cross explicit readiness and cleanup guarantees, so passing the 58-test gate is insufficient for IA acceptance until they are repaired and causally qualified.
