### Spec Compliance

- ✅ **I1 ADDRESSED.** The fix satisfies the scoped Stop/control usage-retention requirement in `task-1-fix-round1.md:7`. `packages/llm-seam/src/retry/execution.ts:31` captures a received usage event before the signal check; `:54` drains all pending observations before cancellation and branded generation/execution-control exits. `packages/core-agent/src/agent/model-step.ts:61` accumulates usage without executable output, while `:69` preserves the original abort reason for every other event. Existing response failure reporting remains the sole terminal usage-report owner.
- ✅ Exactly-once retention survives Stop during buffered successful usage: the queue is drained with `splice(0)` at `packages/llm-seam/src/retry/execution.ts:42` and `:54`, and the post-drain abort check at `:43` prevents completion. The recheck at `:47` also blocks pending text when Stop occurs during a recovered notification. Both branches have specific controls in `packages/llm-seam/test/retrying-client.test.ts:29` and `:42`.
- ✅ Actual connected Stop now retains the original attempt's usage and permits ordinary later work: `packages/session-executor/test/chat-stream-terminal-error.test.ts:209` uses the existing real provider-runtime/HTTP/Service fixture, observes actual usage mapping and delegates every reader call, Stops before another content/error/end frame, and checks one send/reservation, unknown settlement for the interrupted issued stream, zero effects/acceptance/calibration, and exactly one report attached to the original logical and physical attempt IDs (`:234`, `:243`). The same assembly subsequently succeeds. Its error identity assertion is correctly scoped to the actual Agent run signal; it does not claim to change the Service's earlier normalization of caller abort reasons.

### Strengths

- ✅ The correction stays in two existing production owners, with no admission, parser, classification, service, execution-reservation or schema changes. `packages/core-agent/src/agent/model-step.ts:61` moves the existing usage accumulator rather than introducing a second accounting mechanism.
- ✅ Failure controls use the real branded generation constructor and real execution-control marking path, assert the original error object, and prohibit retry: `packages/llm-seam/test/retrying-client.test.ts:8`. Agent controls verify one report/no acceptance for Stop and generation failures (`packages/core-agent/test/provider-usage.test.ts:75`), prohibit subsequent executable events (`:93`), and retain the original Stop as AggregateError cause if the usage observer also fails (`:108`).
- ✅ The connected usage barrier is observational: `packages/session-executor/test/chat-stream-terminal-error.test.ts:212` delegates to the original mapper/read implementations instead of synthesizing results. Its retained RED failed specifically on missing billing, and GREEN now passes; it is meaningful connected evidence, distinct from the focused synthetic seam controls.

### Scoped New Findings

- **Critical:** None.
- **Important:** None.
- **Minor:** None newly introduced in this fix range.
- ⚠️ Previous M1 and automatic partial-discard retry remain separately tracked and are not addressed by this correction. The unchanged guard control continues to establish safe refusal plus later new-submit continuation, not automatic recovery. This verdict does not convert the earlier three-owner BASE comparison into full-BASE evidence or qualify broader R5/native-cutover behavior.

### Checks and Evidence

- Reviewed supplied diff only for exact `3422c5627056a0e17db63c614d95d9f4917b4e3f..bf3dac6b906b25993d59f6944cfafa15c0c42661`, the fix instruction and appended implementation report. Relative product references resolve under `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`. No product/index/Git mutation, new runtime probe, suite rerun or recursive agent was needed.
- Read retained fresh RED logs in `C:/ih-r5-fix1-20261023`: `red-retry.log` has4 failures for the specific missing observations/completion leak, `red-agent.log` has3 failures, `red-connected.log` has the missing-billing failure, and `transition-red.log` has the recovered-notification text leak. These evidence paths are explicitly preserved instead of replaced by GREEN.
- Read final raw logs and command/UTC/env/exit sidecars: `final-retry.log`44/44, `final-agent.log`23/23, `final-connected.log`12/12. All three final typecheck sidecars record exit0. Final qualification logs are clean; no unrelated full-package suite was rerun. Final tests ran sequentially with maxWorkers2/minWorkers1 from their real package directories during UTC16:02:42–16:02:59, followed by types through16:03:16.
- Independently hashed current five owned files against `commit-binding.json`: five entries, zero SHA256 mismatches; all recorded qualifiedBlob values equal commitBlob values. `source-before.json` and `source-after.json` both hash to `9152a7baba27f16f4fcd8130ea81c47646cdafb7eb72cf3e92661c3660b530f6`. `commit-binding.meta.txt:3` binds HEAD `bf3dac6b906b25993d59f6944cfafa15c0c42661`. No Git command was rerun.

### Assessment

**Task quality: Approved for the scoped correction.**

**Reasoning:** I1 is addressed across both the buffering owner and Agent acceptance boundary, with original failure identity, exactly-once observed billing and no executable output after Stop preserved in the reviewed paths. Fresh connected evidence demonstrates actual usage-before-Stop retention and same-runtime follow-up; no new blocking issue was found in this fix range.
