# R4A Codex refinement after external fix round1

> **For agentic workers:** The user changed workflow on2026-10-19: DeepSeek provides initial implementation, Codex reviews and directly adjusts it. Codex is now the sole product writer for this bounded refinement; the original GPT6.1Sol review seat will independently re-review the resulting diff. No other product agent runs concurrently.

**Goal:** Close the two independently reproduced exec retention boundaries at e8b2781f and qualify original-operation recovery without claiming completion of the remaining R4A work.

**Architecture:** The existing job registry owns execution/retention lifetime. Passive settlement invokes the original frame capture; genuine foreground/query observation registers its own dependency. Retention outcomes are separate from native execution outcomes. Observer rejection is contained and exposed as a typed retention disposition, never silently dropped or turned into another command execution.

**Tech Stack:** Existing TypeScript/Node/Vitest/JSONL/ContextOutput. No dependency addition.

**Spec:** Original R4A contract, external fix-round1 plan and original reviewer `fix1-review.md`. Starting product HEAD `e8b2781f607c63421b4089a66ea230aa9799ff21`; version0.1.13-rc.1 and decomposition27/43 unchanged.

## User-approved design boundaries

- Root's actual RED probes already demonstrate passive completion mutating finalized startup producer metadata and foreground observer rejection escaping the public caller as unhandled.
- Automatic completion and dispose use passive settlement only. Current queries register their own observer synchronously before result finalization; observer-specific grant failure cannot rewrite the original job's storage disposition.
- Foreground async observation is joined before returning its disposition. Preserve stdout/stderr/exitCode/timedOut; an optional `ExecResult.retentionFailure` communicates unavailable/recovery-required separately. It does not grant artifact authority or change the command's execution status.
- A legacy retention adapter lacking the newly added passive hook may settle through its existing original `ExecFrameCapture.settle()`; it must not invoke observer registration as the fallback.
- Unknown captures retain the original handle and bounded explicit retry/close responsibility; known refusal remains terminal. No new timers, unlimited retry, command replay or empty catch pretending complete retention.
- Broader different-owner catalog-membership authorization, Code emission, remaining consumers, full crash matrix and whole-session qualification remain existing R4A/R4B–R6 obligations. A limited same-session refinement cannot silently mark them accepted.

## Execution

- [x] Add the passive-startup regression to the actual background assembly test, using an EOF release gate and a genuine startup ToolExec; observe zero late registration and a valid later reader catalog. Preserve the already-recorded RED.
- [x] Add real public exec controls for foreground observer rejection, observer unavailability and normal observation; assert the unchanged native outcome, truthful retention disposition, no unhandled rejection and one launch. Run RED before product changes.
- [x] Extract a focused `packages/exec/src/jobs/retention.ts` responsibility leaf as needed. It owns no independent execution/store state; the original registry/capture remains authoritative. Switch automatic/close to passive, current observations to the authentic observer port, and join foreground observation at `jobs/observation.ts`.
- [x] Keep uncertain original captures available for required close/reconciliation; do not let a rejected async observer escape, and do not destroy required storage ownership as a side effect of returning an execution result.
- [x] Add a real ContextOutput integration with a deliberately lost original finish receipt, recovery through the same operation, actual cold bytes/digest and one controlled transport launch. Keep controlled fake-sink branch tests separately labelled.
- [x] Run original probes, new package controls, affected exec/executor scopes and types sequentially at fixed source. Preserve known unrelated broader failures; inspect any new failure before changing an assertion.
- [x] Send the coherent diff and evidence to the original reviewer for scoped independent re-review, address material findings, and report exact accepted scope and remaining gates. No merge/tag/release from this refinement.

Evidence is written to a new `.tmp/context-r4a-codex-refinement-20261019/` directory. Existing external and reviewer evidence stays immutable. Structural/semantic changes and observed proof gaps are recorded separately; no full R4A acceptance is implied by this plan.

Completed through product `3ba0d782` with scoped independent specification/quality PASS. The later reader-rebinding correction has its own preserved RED/GREEN and final exec257-test pass. Earlier executor30/probes6 are not relabeled exact-final-source runs. Fresh Gateway-copy9-test controls and842source-copy matches supplement CLI distribution smoke. See the [acceptance report](../../research/2026-10-19-context-r4a-codex-refinement.md) for exact evidence, preliminary manifest limitations and remaining R4A obligations.
