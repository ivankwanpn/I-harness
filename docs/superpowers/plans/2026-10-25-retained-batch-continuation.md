# Retained live batch continuation Implementation Plan

> Use superpowers:subagent-driven-development for the connected task; assigned implementer uses executing-plans. No recursive agents or parallel runtime in this checkout. Root promotes this packet under the already approved continuous integrated delivery program.

**Goal:** after an explicitly branded retained dispatch fully reconciles under its original live batch owner, preserve the same original throw through cleanup, then let the same Agent loop continue through its existing successor-step path.

**Architecture:** register a real batch settlement source under the still-live invocation action, independent from the generic invocation delegate. Keep checkpoint provenance separate from error precedence. A private one-use mark binds the exact thrown error to its live turn/batch and successful original settlement; only the catch outside handoffBatch can consume it after actual readiness/Stop/shared-allowance validation.

**Tech stack:** TypeScript, existing core-agent/core-tools managed facts, real JSONL coordinator, actual Agent/CodeMode, Vitest. No dependency, Session format, persisted event, llm-seam grant or wire change.

**Spec:** [binding live continuation design](../specs/2026-10-25-retained-batch-continuation.md). Product baseline is MAIN `bc83c3999501f5e5ccfc939b2c0109cb7201d251`; the writer uses the later documentation-only promotion commit as BASE. Historical003 remains unresolved evidence.

**Review Focus:** later failure after a retained result; a successful source close with a missing slot; wrapper cleanup changing error identity; Stop/expiry during readiness; same-error reuse across batches. Each has a required negative in Task1.

## Global constraints

- One connected task/writer/review range; no C2 semantic caller, instruction factory, native/backend, bootstrap, quota/store, public post-rejection resume or packaging rewrite.
- Keep throw of the SAME original error from executeToolCalls; preserve raw/undefined/policy/outer/commit/cleanup precedence and original failed tool execution metadata.
- No new run/prompt/input/recovery-model-action, repeat preparation/body/result capture, producer replay, deadline renewal or second model lane/store.
- Do not close invocationSource, call factOwner.drain live, finish the invocation action early, bypass document fences or clear unrelated holds.
- Normal accepted main generation is already closed before tools. Never assert/reopen it; normal successor-step generation stays the existing behavior.
- Protected `packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts` remains unread/unrun/untouched. Preserve original003 receipt/source/fixtures and all new RED/failure evidence.
- Root must reserve one isolated checkout/runtime. Use explicit package CWD, task-owned config/profile/temp, sequential focused runs; no repeated native-job loops or external provider traffic.

## Task 1: exact original batch settlement → private live continuation

**Files and responsibility:**

- Create `packages/core-agent/src/tool-batch/live-continuation.ts`: private token/mark issuance, exact identity and one-use state; no payload interpretation, owner readiness implementation or public index export.
- Modify `agent/{create,dependencies,turn}.ts`: internal invocation capability, real batch source adapter, outside-handoff gate. Keep `agent/settlement-source.ts` generic trackSettlementSource unchanged.
- Modify `tool-batch/{dispatch,cancel,record,join}.ts`: all checkpoint provenance, receipt/slot completeness, source-close marking; keep existing throw and finalization owners.
- Modify `agent/tool-generation.ts`: retain original review-generation guard at mint; private read-only check for exact already-borrowed binding/view/action.
- If internal typing is needed, define a package-private execution-dependencies extension in dependencies.ts; do not add a caller-supplied authorization callback/token to exported AgentDeps/ExecuteToolCallsOptions or core-agent index.
- Create `packages/core-agent/test/retained-batch-continuation.test.ts` for actual owned Agent + private-edge negatives.
- Create `packages/session-executor/test/retained-batch-continuation.test.ts` for genuine parent→spawn→child CodeMode and same-handle JSONL publication fault.
- Extend `core-agent/test/execute-tool-calls.test.ts` only for missing raw/undefined/later-raw ordering oracles; `session-executor/test/guardian-generation.test.ts` only for actual borrowed-review allowance guard controls.

**Private contracts (proposed exact responsibilities; all package-internal):**

```ts
// Opaque tokens are issued objects validated in a private WeakMap, never DTO flags.
type LiveBatchToken = object;
type LiveInvocation = { readonly view: SessionView; readonly action: ManagedAction;
  registerBatchSource(drain: () => Promise<void>): SettlementFacts;
  assertInvocationOpen(): void; invalidate(): void };
type CheckpointSite = 'retained-dispatch' | 'raw-checkpoint';
type CheckpointEvidence = { site: CheckpointSite; error: unknown; index: number;
  prepared?: PreparedCall; retained?: RetainedToolOutcome };
```

- Source preparation, mark issuance and consumption are separate internal operations; only actual join calls mark after its own source.close succeeds. Turn cannot mint a successful mark, and a tool/host callback cannot provide one.
- Bind private token to exact invocation capability, requestScope/turn-lifecycle object, original batch object and registered source. Capture private context **before** resolveBatchFacts spreads options; do not accidentally lose identity or qualify a clone.
- Bind options→token through the private WeakMap, not an exported field. Standalone executeToolCalls with arbitrary callbacks/options receives no token and preserves existing behavior.
- Exact mark key is original thrown error object **plus** token; no cause traversal, matching code/message, payload flags, arbitrary callback, error-wrapper unwrapping or object identity from another turn.
- Keep a set of live tokens per invocation to invalidate/release references in finally; mark consumption is one-use even if readiness later fails. No retained completed-batch registry/history cache.

### RED: original landed publication, original recovery and one live invocation

- [ ] Build the connected fixture with real createJsonlBackend/createSessionCoordinator/openManagedDocument and createSessionAssembly, modelPolicy test-mock, actual Agent dispatcher and actual child CodeMode mount.
- [ ] Parent controlled response1 calls spawn_agent(background:false,fork_turns:none); child response1 calls code_exec with `text(await tools.owner_probe({}))`; owner_probe increments an in-memory count and returns literal `{probe:"once"}`; child response2 says `child final`; parent response2 says `parent final`. Separate controlled parent/child clients avoid shared-script inference.
- [ ] Wrap the real backend appendOwnedBatch only for the first child code/output frame: await actual append, retain exact batch key+real outcome, return `{kind:"unknown",key}` once. reconcileOwnedBatch calls the actual backend for that same key. Do not substitute a confirmed receipt, publish raw facts, inject callback flags or start native jobs.
- [ ] Assert independent journal facts and final values: parent final; child final; one child input/admission/promotion; one producer/cell/call; one committed output/artifact and completed terminal; original outer code_exec execution.failed remains failed; next child request contains that actual recovered result; no synthetic recovery input/action or repeated body.
- [ ] Observe original error identity at existing failure boundary without adding an async success-path hook. Assert actual source recovery hold clears by confirmed original source close, invocation remains open, and original view matches before next request.
- [ ] Run this named RED once and save raw command/cwd/env/HEAD/source hashes/exit/journals. Expected current failure is child terminal error/absence of child final while original retained value is real; a missing-import failure does not qualify.
- [ ] If automatic original refresh resolves before observer rejection, add a bounded **original-handle** gate: retain the first unknown until the existing observer reports FACT recovery, then permit the same captured reconcile. No sleeps/repeated runs; document that this gate tests the selected mechanism, not historical003's trigger.

### Implementation A: batch-specific actual source and original lifetime

- [ ] Create the private invocation capability inside withFactAction from its actual action/view; deliver it to the internal turn runner through private execution dependencies initialized/shadowed by createExecutionDependencies, never by reading host-supplied fields.
- [ ] Its registerBatchSource calls that same action.registerSettlementSource(drain), adds the **exact issued source object** to existing sourceDrains, and returns that object with its ownership brand intact.
- [ ] Retain original source.close bound method. Wrap close on the same source object (no spread/copy): await original close, then remove from sourceDrains; rejection keeps original source and failed debt tracked. Concurrent close/retry joins original source semantics, never replacement registration.
- [ ] Turn uses this adapter only for executeToolCalls' batch; generic deps.registerFactSource/trackSettlementSource for acceptance, reduction, unstarted sources and other clients stays unchanged.
- [ ] Preserve synchronous IC-B pin transfer at existing batch registration; actual source drain remains `finished.promise → records.drainSettled → original pin.release`. Required facts/references drain before source release; pin error holds that same original source and remains tracked.
- [ ] join finally resolves finished before source.close. Successful source release clears only its managed hold through existing owner behavior. Invocation source is still live and is not closed/joined; independent source holds still block readiness.
- [ ] Invalidate invocation capability before original action.finish/teardown; Stop/close rejects further registration. Existing owner-wide close still sees and joins retained failed batch sources.

### Implementation B: every checkpoint provenance, no precedence rewrite

- [ ] In dispatch, derive retained evidence only from retainedToolOutcome(error,prepared). Store exact prepared/handle/error/site/index once; all raw marker/flush failures use raw site including undefined. Do not infer classification in stopForCheckpoint from error shape.
- [ ] Keep existing hasFlushError/firstFlushError/stopped/batchAbort behavior. Add separate eligibility accounting for **every** checkpoint; later raw failure disqualifies even if firstFlushError is branded.
- [ ] Set a permanent disqualification bit for any raw checkpoint, recordOuterFailure, commit/finalization/post-tool/telemetry failure, policy refusal, external abort or any started slot with unknown outcome/dispatch, including a synthetic fill. Preserve each occurrence independently of its value.
- [ ] record must expose internal evidence that all slots exist, every slot.recorded is true, committed===batch.length, every retained take/reference/finalization succeeded, and no started slot was synthetic unknown. Drain success alone cannot establish completeness.
- [ ] Never-started known canceled/not-dispatched fills remain genuine recorded history; they are not rerun. Actual ordinary known tool failures keep existing handling; unknown started effects cannot qualify.
- [ ] finishCheckpointFailure continues throwing cancellation.firstFlushError unchanged. join captures exact primary occurrence/error for potential eligibility, performs original cleanup, and marks only after close success and all provenance/slot conditions pass.
- [ ] Any source-close error follows existing aggregate path and prevents marking. Do not mark by “has retained slot” or mark in a failed close catch. No finally-return that suppresses the original throw.

### Implementation C: exact error catch outside handoff, owner readiness and expiry

- [ ] Mint one private token around the actual batch. Catch **outside** `await handoffBatch(...)` in turn.ts. If wrapper cleanup throws AggregateError/savingFailure, it is a different object and cannot qualify even when its cause is the original marked error.
- [ ] Require exact token/error mark and live managed invocation; reserve it for this one handler before the first readiness await, consume only after all guards succeed, and invalidate in failure/finally. Unqualified errors rethrow unchanged; no fallback scanning causes or journal messages.
- [ ] Check original invocation action.assertOpen, current external turn/invocation signals and captured borrowed-review guard; await the existing ensureWritableContext callback that uses ownedContextReadiness's exact view+document.assertReady; repeat all synchronous guards afterward.
- [ ] Require actual managed owner/view and an installed exact-owner readiness callback; absent capability is ineligible, not silently successful. No factOwner.drain/invocationSource.close/settleFinishedActions or new action is invoked by this live gate.
- [ ] Store `check:()=>{ check(); generation.assertOpen() }` in existing reviewerBindings at forChild mint, closing over that actual generation and original accepted-call check.
- [ ] Capture binding+borrowed auxiliary action once at createAgent. A private read-only helper validates matching binding/view/action and consumed===true, checks actual signal and stored check. It never calls borrowApprovalGeneration, forChild, reserve/open/bind or extends deadlines; unknown/mismatched/expired/revoked binding refuses.
- [ ] A normal non-review child has no borrowed allowance to check. Do not assert deps.generationAction for the already accepted main response; it was legitimately closed before tools.
- [ ] On success swallow only this privately qualified original throw at this catch, proceed to existing closeStep/normal next iteration, and leave failed tool metadata/original diagnostic unchanged. No early successful instruction acknowledgment is synthesized.
- [ ] Wrapper failure rethrows its exact existing error without requalification. Gate failure invalidates the reserved mark and uses existing savingFailure(originalCheckpoint,[guardFailure],classification), with original checkpoint as primary/cause, then existing failTurn; no retry of the gate/tool and no loss of raw/undefined precedence.

### Required negative/ownership controls

| Control | Oracle |
|---|---|
| raw flush Error, FACT-shaped Error, undefined; raw before/after branded sibling | Original failure occurrence/precedence survives; no next model step. |
| branded error reused across prepared call/turn/token, forged code/message/flag, arbitrary options callback | No private mark or no exact match; cannot qualify. |
| commit still unknown/conflict/absent; outer commit failure that later settles | Original closure persists/fails; no continuation. |
| synthetic started unknown/unknown; missing slot despite successful drain | Ineligible; no invented settlement or replay. |
| source close, IC-B pin, unstarted wrapper close, post-tool/telemetry failure | All original cleanup attempted; wrapper aggregate never unwrapped/requalified. |
| unrelated recovery hold/quarantine/sourceFault or wrong view/missing readiness port | Exact owner refuses despite batch result/close success. |
| Stop/close before and during readiness; permission/policy revoke | Before/after guards refuse; no input/model/producer replay. |
| actual borrowed reviewer binding expires/revokes during readiness | Stored generation.assertOpen/check refuses with same allowance; no reborrow/new grant. |
| normal accepted main generation closed; valid detached background job ongoing | Main can continue normally; no assert/reopen accepted generation, no global EOF wait/cancel. |
| canceled CodeMode executable lifetime | Recovered observation never revives guest/timer/tool continuation. |
| overlapping run/compact/followup attempt | Existing AGENT_BUSY lease remains held through qualification and original cleanup. |
| same exact source first close fails then original retry succeeds during later owner cleanup | Source remains in existing drain set until confirmed close; failed live attempt never gains late continuation. |

- [ ] Use actual managed facts/registry brands and original guarded handles for negative eligibility; do not directly seed the private successful-mark map.
- [ ] Reviewer guard control must use actual mint/borrow identities through the existing generation composition. Preserve reviewer tools[]; do not widen reviewer tools merely to manufacture a batch.
- [ ] Public Agent/executeToolCalls without a genuine private token remains byte/behavior-compatible; add nondurable compatibility control rather than expanding managed continuation silently.

### Verification, evidence and fresh review

- [ ] Run sequential named RED/GREEN in affected package CWD via `node ../../node_modules/vitest/vitest.mjs run test/retained-batch-continuation.test.ts --maxWorkers=2 --minWorkers=1`; preserve raw failures, exact source manifests and original journals.
- [ ] Core-agent focused gate once on final source: new test plus `execute-tool-calls.test.ts retained-boundaries.test.ts recovery-settlement.test.ts`.
- [ ] Session-executor focused gate once on final source: new test plus `retained-code-output.test.ts retained-hook-recovery.test.ts retained-hook-stop.test.ts guardian-generation.test.ts code-mode-children-close-boundary.test.ts`; preserve all original assertions/deadlines.
- [ ] Add affected existing subagent managed-spawn/retained-task controls only if source coupling/failure justifies them; do not use repeated native consumer loops as stability evidence.
- [ ] Run `node ../../node_modules/typescript/bin/tsc --noEmit` in core-agent and session-executor; run scoped diff check. Verify no public exports/new grant/event/format or generic source change.
- [ ] Self-review exact throw identity, wrapper aggregate exclusion, later/undefined failure accounting, source hold release, private gate before/after await and reviewer clock authority.
- [ ] Commit only approved connected source/test files after checks; report BASE..HEAD/raw commands/results/source hashes and honest remaining limits. Root requests fresh independent full-range review and same-reviewer fixes before integration.
- [ ] Explicit report: deterministic unknown-after-landed→same-handle reconciliation proves this new live mechanism; historical003's first trigger remains unknown. No whole C2/R4B/version/stability claim.
