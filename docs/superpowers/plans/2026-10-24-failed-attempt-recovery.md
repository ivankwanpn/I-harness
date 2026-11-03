# Failed-attempt recovery through complete outcome bookkeeping

> Root-approved next R5 packet under the integrated v0.1.13 plan. Execute only after IC-A's shared history/current-context range is reviewed and integrated. Fresh GPT6Astra implementer, then independent task review; no recursive workers. This plan does not claim a passing repair.

**Goal:** A retry allowed by existing policy actually progresses after partial output, while new input, Stop, changed context, uncertain writes and genuine unresolved effects still block the old candidate.

**Architecture:** Correct the existing model-step's terminal facts and the shared history owner's classification of explicitly known aborted attempts. Keep one prepared request, one retry loop, one action/deadline budget, and strict `sameRequestCandidate`. Retain failure audit bytes without presenting failed output as accepted history.

**Baseline evidence:** The controlled five-scenario diagnosis at b7ba78b0 is preserved in `.superpowers/v0113-integrated-delivery-20261023/partial-retry-diagnosis/`. Its final read-only addendum supersedes its earlier private retry-baseline proposal. Text-only and text+tool partials cause only `protectionRevision` to change; the real pending-human control changes that same coordinate for a legitimate reason. Never solve this by ignoring that revision.

**Parent:** [integrated delivery](2026-10-23-v0.1.13-integrated-delivery.md), [current-context contract](2026-10-24-current-context-reduction.md). Accepted Chat error/usage behavior remains binding. Product version stays0.1.13-rc.1; IC-A owns the single format12 transition. No additional event, format, parser policy, accepted-exchange codec or public execution capability is allocated here.

## Source facts and design rulings

1. `core-agent/src/agent/model-step.ts` retry-waiting saves audit text, marks failed, ends the step and clears its local tool batch. It currently omits precise never-dispatched outcomes. Public `discard()` emits those outcomes, but terminal `fail(error)` calls `discard(false)` and omits them too. The local batch is not the scheduler's earlier accepted/unknown work.
2. `core-session/src/conversation/unit-state.ts` returns unresolved for every failed or ended-suppressed step before inspecting outcomes. Bookkeeping alone cannot repair text-only or complete never-dispatched retries.
3. `legacy.ts` sets `ended` on failure and inferred next boundaries. `step/failed` closes its active record immediately, so a subsequent actual `step/end` is not presently associated with that record. Add precise internal source evidence; never relabel `ended` as explicit closure without changing the prepass.
4. `history/group.ts` has the complete structural call set before `legacy-fragment` removes public exchange metadata. Empty public effects/calls cannot prove no effect. Classification belongs in this shared structural owner, not admission code or a retry guard exception.
5. Existing legacy failed/shadowed/post-failure-repair histories intentionally remain unresolved. The new class applies only to unambiguous explicit-acceptance-region failed units, not all legacy failures.

## Ownership and module placement

| Owner/files | Assigned responsibility |
|---|---|
| `packages/core-agent/src/agent/model-step.ts` | One awaited, per-attempt terminal audit/outcome path shared by retry/discard/terminal failure; original usage/error identity and once-only cleanup |
| optional private `packages/core-agent/src/agent/failed-attempt.ts` | Only if separating that cohesive local lifecycle keeps model-step readable; no second mutable attempt owner |
| `packages/core-session/src/conversation/legacy.ts`, `unit-state.ts`, `history/{facts,group,types}.ts` | Exact structural failure/end/call/outcome evidence and conservative derived terminal audit classification |
| optional private `packages/core-session/src/conversation/history/failed-audit.ts` | Pure structural predicate, supplied current archive/visibility/source metadata; no new cache/store or payload rendering |
| `packages/core-session/test/{conversation-state,conversation-projection}.test.ts` and focused `failed-audit.test.ts` | Known terminal positives and ambiguous legacy/dispatch/source/visibility negatives |
| `packages/core-agent/test/model-recovery.test.ts`, focused `failed-attempt.test.ts` | Local settlement, terminal failure/Stop/save outcomes and real usage contract |
| `packages/session-executor/test/chat-stream-terminal-error.test.ts`, focused `partial-retry-recovery.test.ts` | Actual provider-runtime→HTTP→managed service connected success/negative/cold controls |

No edits to `sameRequestCandidate`, admission/execution guards, F4 accounting, retry/parser policy, IA/IB, compaction selection/paging, or child factory. A concrete additional owner requirement returns to root. `response.ts`/boundaries may only change if the existing save/cleanup path cannot preserve original outcome; provide the causal case first, not a generic response redesign. The non-durable R503 exception below adds only original-failure provenance across the existing waiting-event boundary.

**R503 original-error handoff:** The actual retry owner retains the provider Error while its waiting event exposes sanitized `ModelRetryInfo`; model-step cannot preserve original cause on a settlement/telemetry failure using that metadata alone. Root authorizes one private weak association keyed by the genuine emitted waiting event and a consumed reader returning an optional `{failure: unknown}` record. Creation remains internal to `llm-seam/src/retry`; an additive consumed export may cross to core-agent. It conveys diagnostics only, not execution/protection authority. Do not put raw Error/cause into enumerable retry metadata, durable events, request bodies or telemetry serialization. Copied/custom events have no original association; retain their available metadata without inventing original identity. Preserve thrown `undefined` as distinct from no association. Qualify actual owned prepared/retrying wrappers and model-step failure paths: same original primary cause, failed usage once, no reopen after uncertain save, unchanged retry delay/count/action. No new policy/store/retry loop; event lifetime bounds the association.

## Task 1: Complete failed-attempt facts and classify only proven terminal audit

### A. Local model-attempt settlement

- Capture the exact unaccepted local batch and audit content once for the physical attempt. Use existing captured tool-result/lifecycle capabilities and `committedFactSeqs`; never raw append or fabricate a successful envelope/acceptance.
- Each recorded local call receives one `TOOL_ABORTED_BEFORE_DISPATCH` error result tied to its original call ID/name before `step/failed` and explicit `step/end`. There must be no scheduler handoff or actual dispatch for these calls. A call publication that failed before entering this batch remains unknown, not guessed into the batch.
- Reuse one per-attempt settlement operation/promise when outer failure/finalization re-enters after a partial save. Do not repeat already committed audit/results or turn unknown publication into a fresh logical operation. A rejected/unknown operation remains unresolved and stops reopening; retain original bytes and outcome evidence for the existing recovery owner.
- Preserve reasoning flush, signed/native audit metadata already observed, and original error/cause. Reset transient batch/text/reasoning/receipt/ending flags only after settlement has committed. Retry creates the next physical step under the same action and existing retry ordinal, never a new logical response or allowance.
- Usage remains attached to each actual failed physical attempt once, before reset. Terminal response finalization must not duplicate usage already reported by retry handling. A throwing telemetry sink or save failure preserves original failure identity and known usage without accepting failed output.
- Stop may finish required already-owned local bookkeeping, but cannot issue another HTTP request/reservation or replay a tool. Unknown earlier dispatched work and independently accepted background work are outside this batch.

Conceptual sequencing, within the existing model-step owner:

```ts
await settleUnacceptedAttempt() // actual local call results + audit + failed + explicit end
// only after committed settlement, and only from existing retry waiting:
clearAttemptBuffers()
await openNextPhysicalStepUnderOriginalAction()
// existing seam backoff, confirmation, budget and transport proceed unchanged
```

### B. Structural proof, before payload projection

- Derive a private terminal-audit qualification using the actual complete structural unit. Preserve exact start/failure/end source indices and validity; no new durable event or trust in a public boolean. Every source must be uniquely addressable and selected in the same unambiguous physical interval.
- Require explicit acceptance semantics, a genuine action/attempt-bearing step start, no accepted exchange for that start, one explicit failure and its one actual matching end before a later step/turn boundary. Failure alone or a later inferred boundary does not qualify. Keep post-failure/end association bounded to its original unit; conflicting/duplicate/missing boundaries are unresolved.
- Require every call/result exactly once with matching ID/name, the result after its call and before terminal failure, explicit known never-dispatched disposition, and no matching dispatch. Duplicate call IDs/results, conflicting dispatch addresses, result outside the unit, generic errors/successes, unknown outcomes, unsafe sequences and partial shadows stay unresolved. Zero calls only makes the call condition vacuous; text-only still needs all closure/source conditions.
- Use the complete branch/visibility metadata. Hidden dispatch/outcome/content cannot be ignored to turn an ambiguous unit into known terminal work. Preserve existing shadowed lifecycle behavior, while partial-shadow and arbitrary legacy cases retain conservative protection.
- If all conditions hold, the physical unit may be derived `closed` as **known terminal completion**, while its item remains suppressed `legacy-fragment` with zero model messages and no accepted/reducible/replayable exchange. Do not grant seed/replacement eligibility merely because physical state is closed; preserve their existing kind/acceptance requirements.
- Pending human input, session/current instructions, unsettled child/effect ownership, branch/context epoch and unsafe unit address protections remain independent in the existing state owner. A known aborted audit unit cannot clear those protections.
- Confirm every consumer of `physicalUnitState`/`ConversationUnitState` distinguishes known closure from successful acceptance. If a consumer treats closed as accepted without checking item kind, report/fix that exact consumer within root-approved scope before broadening the rule.

### C. Required behavioral controls

1. Before product edits, preserve actual text-only and text+tool automatic-retry failure with the same causal mismatch, at the reviewed IC-A base. Root diagnosis is prior evidence, not a substitute for current expected behavior. Keep raw commands/source identities. No missing-export RED substitutes.
2. Positive structural fixtures: explicit failed text-only; one and multiple unique never-dispatched calls; reasoning-only; original failed audit still readable after serialization/cold reopen; current component outside history remains separately protected. In each case projection excludes failed text/calls and replacement/seed cannot manufacture acceptance.
3. Negative matrix: no semantics fence; absent/invalid/duplicate start/action/attempt or terminal source; failure without explicit end; inferred next-step end; missing/late/wrong-name/duplicate outcome; duplicate/conflicting call; actual dispatch plus claimed never-dispatched; hidden dispatch/partial shadow; unsafe sequences; pending/unknown result; acceptance attached to failed start; unsettled child. Existing conservative tests stay unchanged unless an expectation directly asserts the newly corrected behavior; explain each changed assertion.
4. Real managed service, actual built-in Chat HTTP route: first response has partial text, then retryable error and usage; second succeeds. Exactly two physical requests, one action, failed+completed settlements, one accepted exchange/calibration, failed usage once and success usage once. Original payload is unchanged across physical sends and excludes failed audit. Tool-positive control proves dispatch counters can increment, while failed batch effects remain zero.
5. Repeat actual case for text+tool and reasoning-only, plus two consecutive discarded failures then success under existing retry cap. Assert unique physical attempt IDs, no duplicate outcome records and unchanged original action/deadline/cap. Include an earlier accepted tool effect: it stays once and is not replayed by later retry.
6. Actual pending human admission during first response must still stale the candidate even when text is identical. Typed current-source change with equal text but different source identity also stales it; changed surface/binding guard remains enforced. Do not implement a new IC-B dependency acknowledgment here; that future live-file guard stays its integration obligation.
7. Genuine Stop while capacity backoff is waiting (10seconds policy) aborts promptly using the actual abort path; no second send/reservation. Actual allowance one and exhausted deadline also refuse without resetting budget. Use event/deferred barriers, not sleeps or polling until success.
8. Inject known failed and unknown tool-result/audit/end saves in the real managed owner: no reopened send, no duplicate result or new action, original error retained, cold history remains unresolved unless the original operation genuinely settles. A second terminal failure pass must join the original operation rather than duplicate it.
9. After successful retry, ordinary next submit and cold reopen/follow-up succeed with failed audit retained but excluded from wire. Preserve accepted Chat terminal/cancellation/usage cases. This is a recovery gate, not merely a refusal assertion.
10. Correct `model-recovery.test.ts` successful-only usage expectation to real failed+successful physical usage, and old assertions that there are no tool/results on a known aborted batch to exact never-dispatched results. Keep their zero-effects/no-replay assertions. Do not weaken assertions unrelated to this repair or label other baseline failures fixed.

## Qualification and delivery

Run focused RED/GREEN controls during development. After source stabilizes, run sequential owner gates (maxWorkers2/minWorkers1):

```text
pnpm --filter @i-harness/core-session exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-agent exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/session-executor exec vitest run test/chat-stream-terminal-error.test.ts test/partial-retry-recovery.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-session typecheck
pnpm --filter @i-harness/core-agent typecheck
pnpm --filter @i-harness/session-executor typecheck
```

The new focused files are created by this packet. Reuse IC-A's exact baseline failure population for unchanged cases; compare test names/outcomes, never subtract counts to claim no regression. Preserve setup-invalid and genuine failed receipts. Root may select only affected suites after a scoped review fix; do not repeat full passing gates without a change or concrete doubt.

Delivery report identifies full BASE..HEAD, owned files, actual controls and command exits, physical source and Git-blob binding, classified remaining failures, and deferred IC-B/native/whole-version obligations. Fresh task review judges both spec and quality. Root integrates reviewed commits, then continues IC-C/actual caller/event work; no release claim from this packet alone.
