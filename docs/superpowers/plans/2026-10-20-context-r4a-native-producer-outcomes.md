# R4A — Native producer outcomes

> **For agentic workers:** Use subagent-driven-development. Root leads integration; one GPT6.1Sol product writer and a fresh GPT6.1Sol reviewer. No recursive agents. Execute after the owned-version unit is frozen and accepted, on the same development branch.

**Goal:** Make the existing retained result's trusted execution outcome reflect the original foreground native execution or Code Mode launch, while leaving successful observation/control calls successful.

**Architecture:** The original sandbox execution lease exposes an observational snapshot of its own termination action. Exec captures a disposition after its existing settlement barriers and keeps that host-only fact in its existing result-identity metadata owner. Original shell/code producers declare through the existing ToolExec registration. No new journal, execution owner, output DTO or generic payload-status classifier.

**Status2026-10-20:** Accepted product3cf3bc12/delivery5a2c60f3, including root-authorized NAT-13, after fresh independent PASS and root provenance/copy audit. [Acceptance](../../research/2026-10-20-context-r4a-native-outcomes-acceptance.md) preserves the three separate subagent status assertions and precise source/platform limits. Predecessor is [owned version qualification](2026-10-20-context-r4a-owned-version-qualification.md). Retained result and display contracts remain unchanged.

## Fixed semantics

1. Foreground `shell`/`bash`/`pwsh` represents its own execution. Successful background startup or promotion represents a handoff and remains succeeded. Later job failure cannot rewrite its startup fact.
2. `job_output`, job/list/wait, child/task output queries, `code_wait` and `code_status` are observations; successfully returning a failed/canceled job or cell is a successful observation. Successful kill/interrupt/terminate requests are control success, not canceled calls.
3. `code_exec` may observe its own terminal result before return: running/completed→succeeded, failed→failed, terminated→canceled. Use the original closed runtime observation, not its serialized `status` field. Existing policy-refusal throws remain throws. A nested failure caught by guest code followed by normal completion leaves the outer code_exec succeeded.
4. Native execution outcome describes **process-tree settlement disposition**, not a claim about which signal caused the root command's exit. A root may exit0 while descendants remain; an original admitted and successful termination action can still make this execution canceled/failed. Preserve the original exitCode and body independently.
5. Supported `none` plus reliable native root status gives 0→succeeded/nonzero→failed. A reliable status requires an original non-null finite integer exit with no observationError. Never use the flattened `-1` DTO to reconstruct a lost native fact.
6. Confirmed original timeout/output-limit termination→failed; confirmed cancelled/authority-revoked/shutdown→canceled. This priority is the process-tree policy in rule4. Unsupported observation, pending/failed termination after otherwise successful barriers, or missing native status without confirmed disposition→unknown. Optional-method absence is not supported `none`.
7. For compatibility, custom ExecService objects without the new host identity still return their original program data. The built-in shell explicitly reports unknown rather than guessing native tree outcome from fields. Ordinary third-party tools returning arbitrary JSON keep the registry's ordinary-return success default.
8. A request already aborted at the original no-launch admission branch is canceled; it does not fabricate a native termination receipt. Tool-body dispatch remains the registry's own fact.
9. Late abort after tree-empty/release reservation only joins original cleanup and must not change a supported none/exit0 into canceled. Caller signal, `timedOut`, capture stop and frame completeness remain distinct observations.
10. Known shell availability/binding/policy/backend refusals declare failed at their original branch. Do not rewrite refusal bodies, rerun admission, change escalation or infer anything from payload error/status.
11. Any original incomplete cleanup, I/O/observer failure or policy-refusal throw keeps its existing throw/recovery contract. Adding outcome metadata cannot turn incomplete execution settlement into a ready success.
12. An explicitly declared normal-return unknown must survive registry finalization. Only the undeclared initial state receives the ordinary-return success default.
13. NAT-13 scoped root ruling after the original `bounds retained completed cells` test reproduced: `runtime/retirement.ts` unconditionally awaits the closed event callback even when it returned void, creating a stale running/capacity observation after synchronous acknowledgement. Preserve that existing RED and fix the original terminal owner to conditionally await a returned promise, then commit. A synchronous callback must return before commit; a promise-returning callback still withholds terminal publication/capacity until its real barrier resolves. Do not move commit before the callback, skip async F1/storage acknowledgement, weaken the test, or add a new completion owner. Hold/reject async callback controls must retain original failure/recovery semantics.

Product0.1.13-rc.1, Session10 and decomposition27/43 remain unchanged. No new dependencies, live user data/provider calls, publishing, audit exemption or unrelated event-driven work.

## Original owners and exact interfaces

### Sandbox lease

Add a public type in `packages/sandbox/src/execution.ts` and optional observational method on ExecutionHandle, exported through its existing public type exports:

```ts
export type TerminationObservation =
  | { kind: 'none' }
  | { kind: 'pending'; reason: StopReason }
  | { kind: 'confirmed'; reason: StopReason }
  | { kind: 'failed'; reason: StopReason };
// Existing ExecutionHandle:
terminationObservation?(): Readonly<TerminationObservation>;
```

`execution-lease.ts` adds `reason` to its original Termination object synchronously at admission. Snapshot reads original `nativeTermination`/`terminatedReason`, never just `current.termination`. The first successful reason remains sticky. Return immutable observations; no cleanup call, new await/listener, second state owner or repeated failure message.

The three actual adapters construct handles by a whitelist, not object spread. Explicitly forward the method in `sandbox-local/src/posix-execution.ts`, `sandbox-wsl/src/transport.ts`, and `sandbox-windows-psec/src/index.ts`. Preserve their original settled/release paths, including Windows session.release ordering.

`none` means this lease has admitted no native termination attempt. `confirmed` means the admitted hook returned successfully, not proof of root causality or a replacement for ExecutionSettlement. Optional missing method means observation unsupported. A failed hook can remain visible after cleanup recovery; don't erase it by inspecting a new attempt only.

### Exec identity

In `packages/exec/src/capture/completion.ts`, after original root/tree/I/O/cancel barriers and before null exit normalization, classify from the original RootExit and termination snapshot. A small pure classification leaf may keep this function cohesive. Its result uses the existing `ResultExecution['outcome']` type through the existing core-session dependency.

Extend the original `retained-output.ts` WeakMap entry from reader-only to `{ reader?, outcome? }`; keep `registerRetainedOutput` preserving other existing members and `retainedOutputReader` source-compatible. Add internal registration/transfer helpers in this same module and export only the actual shell consumer:

```ts
execResultOutcome(output: unknown): ResultExecution['outcome'] | undefined
```

Do not expose new enumerable fields or symbols in ExecResult, its JSON, shell body or artifact. No second WeakMap. The `jobs/observation.ts` retentionFailure rewrap must transfer the whole existing metadata entry, including outcome-only streaming results. Its already-aborted no-launch branch records canceled at its own admission site. Shell declares the original result outcome before its existing retainedRunResult presentation, so shell's projected DTO need not carry a new identity.

### Tool registration and producers

`core-tools/src/registry/result-finalization.ts` distinguishes explicitly declared outcomes from initial unknown inside its existing execution-map row. `resultExecution` still serializes only `{outcome,dispatch}`. `dispatchResultReturned` defaults only an undeclared result. Preserve prepared identity checks and presentation metadata.

`shell/src/tools/foreground.ts`, `selected.ts` and the original policy/refusal branch use existing `declareToolResultOutcome`. A tiny shared shell helper may declare `execResultOutcome(result) ?? 'unknown'` before presentation, avoiding three competing mappings. Background/promoted returns keep their ordinary default.

`code-mode/src/register.ts` declares only execTool's original runtime observation result before `observationOutput`. wait/status/control calls stay observational. The retained native result continues through the same normal/nested F1 publication and model projection; no special second finalizer.

NAT-13 adds only the original `runtime/retirement.ts` synchronous acknowledgement branch and its behavioral controls. Follow the existing `close()` distinction between void and a returned promise; do not use an `instanceof Promise` check that rejects structural/cross-realm promises. The separate pre-existing subagent tool-status failures are not folded into this correction.

## Task 1 — Wire truthful original producer metadata

- [x] Inspect named seams and existing tests; reproduce registered nonzero/refusal/code terminal failures wrongly reporting succeeded. Reproduce explicit declared unknown overwritten on normal return through actual registry. Preserve before/after raw evidence.
- [x] Implement original lease snapshot and explicit forwarding. Add deterministic lifecycle tests for no termination, pending/reentrant first reason, confirmed, failed/recovery, late tree-empty cancel and natural root0 with still-live tree termination. Preserve incomplete resource handling; observer must not trigger cancel/release itself.
- [x] At actual ExecService/capture, prove known0/nonzero, null/observation-error, confirmed reasons, unsupported method and pre-aborted no-launch. Keep original program fields/JSON unchanged. Exercise the retentionFailure rewrap and reader identity; failed retention must not erase or alter command outcome.
- [x] Wire all original shell variants and known refusal branches. Use genuine registry prepare/dispatch/finalization and native/controlled backend inputs; a fabricated output-shaped object with `error`, `status`, `exitCode` or `outcome` cannot mint metadata.
- [x] Wire code_exec only. Test immediate failure and termination, running/yielded handoff, normal completion, guest-caught nested failure and existing policy refusal. Successful code_wait/status/terminate observations remain success.
- [x] Resolve NAT-13's original synchronous terminal acknowledgement RED without changing its bounded-retention/eviction oracle. Verify a held async callback still blocks completed observation and next admission until released, and rejection retains original failure/recovery. Actual promise-bearing retained F1 publication remains awaited.
- [x] Qualify a real SessionExecutor retained normal and nested result path, verifying stored envelope and model projection use the same native outcome without changing source/call identity or original complete value.
- [x] Prove startup/promotion and observation/control exceptions with actual original job/cell factories: later error/cancel does not rewrite startup; observing that state stays succeeded. Keep exact bytes, frame dependencies and original Stop/drain assertions in retained execution controls.
- [x] Run focused affected owner tests/types sequentially. Real host-native smoke is permitted only in isolated fixtures. Adapter tests skipped on this Windows host remain explicitly unqualified; forwarding/types and fake native boundaries are not Linux/WSL live qualification.
- [x] Build one fresh isolated Gateway copy and test the changed actual registered producer path with exact source/copy/import maps. Preserve failures and source stability. No broad full-workspace rerun absent a new concrete concern.
- [x] Self-review, commit coherent changes, seal evidence, write delivery and hand back to a fresh independent GPT6.1Sol reviewer. Root then continues explicit artifact paging and remaining approved work.

## Evidence and acceptance

Plan workspace: `.superpowers/sdd/2026-10-20-context-r4a-native-producer-outcomes/`. Fresh evidence: `.tmp/context-r4a-native-outcomes-20261020-implementation/`. Each run records executable/args/cwd, source before/after, timing, exit and raw output. Product/test writes and test runs are sequential. Do not touch other task evidence.

Meaningful tests use original producer/registry ownership; helper-only enum assertions are insufficient. Preserve original timeouts, source content, quota/refusal distinctions, Stop/no-follow-on and cleanup oracles. Tests-only setup failures are not RED. Report the precise native platforms exercised and any unsupported custom-backend limitation.

This acceptance does not finish artifact readers, A5/A6/R4B/C/R5/R6, event-driven work or release readiness. No user continuation prompt is needed after the review boundary.
