# Fix round 1 — preserve the dependent default instruction owner

Status: I1 correction committed; source and runtime work stopped for the same reviewer's fresh handback. This report supplements the original packet. It does not change the original task report, evidence, seal, or remaining integration limits.

- Checkout: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`
- Branch: `codex/result-store-close-20261024`
- Full BASE: `03356998dc337ebc3d53bf63af73dce48498080d`
- Incremental BASE: `fb049821a0a2f02d8368a754532fab03d678f4ad`
- FIX HEAD: `1d392d441a0e742edb81df0aa4e53f4da0c64621`
- Appended commit: `fix: preserve shared instructions for retained assemblies`
- Incremental review range: `fb049821a0a2f02d8368a754532fab03d678f4ad..1d392d441a0e742edb81df0aa4e53f4da0c64621`
- Full review range: `03356998dc337ebc3d53bf63af73dce48498080d..1d392d441a0e742edb81df0aa4e53f4da0c64621`
- Incremental change: 2 files, 132 insertions, 1 deletion. Full range: 9 files, 651 insertions, 25 deletions.

## Review finding and correction

Review packet `task-1-review.md` identified P1 I1: global close newly attempted `defaultInstructions.close()` even when an original assembly remained retained because a managed runtime publication was unknown. That environment owns the underlying instruction services and watch. Closing it bypassed the instruction view's outstanding producer pin, invalidating the original source before reconciliation could establish the publication's real disposition.

RC-04 establishes that dependent ownership takes precedence over attempting every disposer. The only product change in this correction is in `packages/session-executor/src/service.ts`: close the owned default instruction environment only when `ownedAssemblies().size === 0`. That existing helper includes both ordinary and mounting assembly handles. When an assembly remains held, the same default environment object remains available for its eventual original cleanup. The existing service-close admission/dispose fence remains intact; normal operations are not reopened.

Reader-only cleanup debt does not retain an assembly. It therefore still permits closing the otherwise independent default environment. Reader join failures continue to be preserved, and independent cleanup still runs. No assembly, instruction view, publication, native handle owner, result-store, reader lifecycle, or policy implementation changed in this fix.

## Causal controls

New file `packages/session-executor/test/service-instruction-close.test.ts` exercises two actual service-owned default environments. Neither test supplies `opts.instructionEnvironment`.

The uncertain-publication control uses the real JSONL managed append, persists the original runtime/context fact batch, reports its disposition as unknown, and holds original reconciliation as unknown. The normal service constructs its project instruction environment, observed instruction source, observation owner and watch. Test instrumentation wraps the native source factory beneath the host's own view tracking so direct environment close cannot bypass the close counter. It delegates every prepare, snapshot and close to the real source.

The first close must reject while the original source close count is zero, its exact ready snapshot is retained, its real prepare remains ready, the assembly is still present, and the original result-store service has not closed. An additional reader lease joins that same result owner and releases without replacing it. The original managed batch is then reconciled through the real coordinator. Explicit close succeeds, closes the same source and result owner once, and removes the retained assembly. Runtime publication issues remain exactly one and model requests remain zero throughout.

The independent-cleanup control first lets an actual service assembly retire, leaving the actual service-owned default environment alive. An observed source in that environment is prepared using the real host/watch. A subsequent cold read creates a real result service with an unfinished native artifact writer; its actual original body handle close fails. Global close must still close the independent default environment/source while returning the reader cleanup failure and retaining that original native body handle. A later explicit close retires the original native body/leaves handles without closing the environment again. The existing reader-only cleanup controls also remain in the impacted gate.

## Evidence and verification

All new evidence is under `evidence/fix-round-1/`. Each named run has raw output, a JSON receipt with command/CWD/environment/exit, a full two-package SHA-256 source manifest, and exact snapshots of the two incrementally changed files. `source-freeze.json` was written before the expanded gates; its two file hashes were rechecked unchanged before staging. No source changed after that freeze.

| Receipt | Scope | Result |
| --- | --- | --- |
| `red-default-owner` | New default-owner tests against uncorrected `fb049821` service | Exit 1: unknown publication test detects underlying source close while the assembly remains held; independent reader-only default-environment cleanup control passes |
| `green-default-owner` | Same 2 tests after the narrow guard | Exit 0: 2 tests passed |
| `impacted-final` | 13 impacted service/publication/result-reader/result-store/retention suites | Exit 0: 86 tests passed |
| `executor-types` | session-executor `pnpm typecheck` | Exit 0 |

The impacted suites are `service-instruction-close`, `service`, `main-instruction-publication`, `main-instruction-lifetimes`, `main-instruction-host-lifetime`, `managed-lifecycle`, `result-reader-close`, `result-reader-lifetime`, `result-reader`, `result-store-close`, `result-store-read`, `service-result-retention`, and `retention-grants`.

Every Vitest run used the package CWD and `--maxWorkers=2 --minWorkers=1`, sequentially in this checkout. The existing service and watch cleanup tests emitted their expected controlled-failure diagnostics, and all suites passed. The new publication control uses the controlled model fixture and asserts zero transport requests. No live provider, user session or credential operation ran.

Three read-only exploration attempts at nonexistent filenames (`context/instructions/environment.ts`, `context/instructions/session.ts`, and `instructions/src/types.ts`) emitted Get-Content errors before the correct files were located with the inventory. No test or native process started from those attempts and no source changed. The causal RED was the only failing verification process in this correction; there was no failing setup run or substituted green receipt. Git add emitted a normal LF-to-CRLF working-copy notice; the staged diff check and commit both exited 0.

`changed-source.json` binds the final working-file SHA-256 values and committed Git blob IDs. `incremental.patch`, `full-range.patch`, `full-range-log.txt`, `handoff.json`, and `handoff-status.txt` preserve the two review ranges and clean handoff. All verification ran on the exact frozen source later committed.

## Preservation and limits

`initial-evidence-preservation.json` records an independent read-only hash audit of all 99 files listed by the original evidence manifest, with zero mismatches. The original manifest SHA-256 remains `2a65580bb29660aa7e481b7bd16ae6845df5554cf3833cd49c115e588a6c1994`; the original report remains `a5e2560213e0d01d10fc3e174631d422515b4b7b223ad6d63b246a22eb1f39f2`. The original evidence seal was read only, with SHA-256 `a98347f7bbbe23e8eb77a15b4caa424630fc57e4b4ee236380d721724f7c0fd4`.

The context-output product/tests did not change, so the earlier complete context-output 180-test evidence was not rerun, per root's bounded correction instructions. The full executor suite was not run. The original baseline-classified mixed-native archived-error expectation remains unchanged and is not claimed green. Version `0.1.13-rc.1` and format `12` remain unchanged.

Worktree status after commit contains only protected pre-existing `.task3-evidence/`, which was never inspected, edited, staged, deleted or run. No MAIN product file or other worktree was changed. No amend, build/copy, push, merge, tag, release, remote action, recursive agent or integration operation was performed.

Source/runtime work is stopped at this handoff. Fresh review by the original reviewer, integration, build/copy, F1/R6 and final release validation remain with root.
