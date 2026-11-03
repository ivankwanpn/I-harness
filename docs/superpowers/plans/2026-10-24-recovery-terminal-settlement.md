# Recovery / Stop terminal settlement implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans for this scoped packet; independent full-range review follows.

**Goal:** Preserve the real recovery outcome and accepted usage through Stop/save failures, with truthful caller error classification.

**Architecture:** The existing response owns its original terminal recovery captures through the existing settlement source; ordinary admission remains revocable. Semantic exhaustion is an explicit original-owner result, and optional diagnostics cannot revoke accepted usage or mask primary failures.

**Tech stack:** TypeScript, existing Session fact capture/persistence and Agent lifecycle, controlled HTTP, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-v0.1.13-integrated-delivery.md`, accepted R5 and Agent invocation plans. Source refinement at8b429c05 is rebased for implementation after reviewed IC-C integration; verify actual signatures at assignedBASE, do not redo accepted work.

## Global constraints and root rulings

- Product0.1.13-rc.1/Session12 unchanged; no event/format/newjournal, retry allowance/source policy, compaction or pure decomposition changes. No remote push/merge/tag/release, live accounts/providers/profile access or recursive agents.
- One writer/runtime in assigned HOST checkout; root owns MAIN. Native worker separately owns only deep-context/reasoning/effect fixture qualification. Preserve HOST protected untracked Gateway diagnostic SHA9fb750a75ec847dc97dd95d16e7ec7668b65d919bcb8208805f9a34fb93cec68, never edit/run/stage it.
- Scope actual files named below plus narrowly required typed source consumers/test fixtures. No broad Agent or persistence rewrite. Public required/retry-started permission must remain action-owned; this terminal constructor cannot start model work.
- R01: createRecovery AND createAdmission that consumes it become per-response closures; immutable request preparation helper may stay runner-owned. Register original delegated source before first admission/await. Release idle/successfully settled source promptly through its original close, so normal multi-step turns do not retain one source per past step. Failed/uncertain captures stay held for genuine original drain, never new admission.
- R02: derive from the existing `Event<'context/recovery'>` type but explicitly omit `state | seq | ignorable` before narrowing state to blocked/resolved. The existing Event alias still includes optional envelope fields. Runtime validator rejects supplied seq/ignorable/envelope/accessors/proxy/class/extra unsafe forms; no full SessionEvent envelope in the terminal draft.
- R03: exact original semantic-error identity is caller classification only, never execution authority. A save failure still wins as an aggregate with real original cause. Do not inspect strings or copy arbitrary recoveryBlocked properties from unrelated errors.
- R04 / P2-05: the derived optional post-response budget snapshot may be omitted on proved pre-issue cancellation OR backend-proven absence, after actual accepted completion/usage has settled. It grants no execution authority, and the next request prepares again. Keep local capacity unavailable/awaiting-projection and make no persisted-success claim. Unknown/conflict/install-failed writes remain held under the original document; unrelated failures are not swallowed. Required acceptance, usage and terminal recovery records never use this exception. No terminal budget or unrestricted metadata bypass.
- Runtime sequential per checkout, package-CWD Vitest maxWorkers2/minWorkers1. Preserve failed/setup evidence and exact source bindings. Review fullBASE..HEAD; no failure waiver or broad tests merely to repeat green gates.

## 1. Exact existing owners and defect boundaries
- `packages/core-agent/src/agent/response.ts`: inner stream catch calls `recovery.require`; outer catch currently labels every different error as saving failure.
- `agent/recovery.ts`: `fact()` uses ordinary metadata except retry-started; `resolve()` catches failed/aborted flush then attempts blocked via revoked metadata.
- `agent/budget.ts`: `record()` correctly uses source lifecycle for usage but publishes post-response budget through ordinary metadata.
- `agent/finalization.ts`: `acceptCompletedModelStep` does completion in `finally`, so secondary completion failure can replace acceptance/flush failure.
- `agent/exchange.ts`: `onAccepted` follows committed/memory-committed installation, precedes flush; nondurable append-observer failure has a separate installed-event callback path.
- `agent/create.ts`: invocation source is registered before `operation(action.signal)`; delegated `registerFactSource` drains are retained until close succeeds.
- `packages/core-session/src/managed/{ports,settlement-event,memory-source}.ts` and `packages/session-persistence/src/coordinator/settlement-source.ts`: no terminal recovery port exists.
- Persistence `source-facts.ts` + `settlement-fact.ts` already retain exact lowered captures, reconcile original keys, expose read-only observe and explicit retryAbsent; use these unchanged.

## 2. Closed semantic result, not error-field promotion
- Change `createRecovery.require` to a closed result: `{kind:'not-applicable'}` | `{kind:'required'}` | `{kind:'blocked'; error: Error & {code:'CONTEXT_WINDOW_EXCEEDED'; recoveryBlocked:true}}`.
- Construct blocked error only in recovery's original owner, after required/blocked writes and their barriers succeed; preserve actual rejected provider error as `cause`.
- Refactor blocked persistence/error construction so `admit()` can still throw the same semantic error while `require()` returns it.
- In `response.ts`, retain the exact returned blocked error in one local variable before throwing; outer catch exempts only identity equality with that original error from `savingFailure`.
- Save/flush/discard/step-close failures still throw and aggregate around `streamFailure`; arbitrary `recoveryBlocked` properties or AggregateError members confer no classification.
- A later genuine settlement failure may wrap semantic blocked as its cause; never pretend that save failure is pure semantic exhaustion.

## 3. Narrow terminal recovery constructor and original lifetime
- Add `RecoverySettlementFact = Omit<Event<'context/recovery'>,'state'|'seq'|'ignorable'> & {state:'blocked'|'resolved'}` using the actual existing event type in `managed/ports.ts`.
- Add only `SettlementFacts.recovery.capture(event: RecoverySettlementFact): CapturedSettlementFact<Outcome>`; no metadata/budget/required/retry-started settlement port.
- Add `recovery` discriminator to `managed/settlement-event.ts`; require strict fact data, `validContextEvent`, exact `context/recovery` and terminal state, no supplied seq/envelope fields.
- Managed implementation routes that constructor to existing `records.capture({kind:'metadata',event})`; memory routes to existing `captureMemoryFact(session,{kind:'metadata',event},assertHeld)`.
- `agent/settlement-source.ts` wraps `recovery.capture` with its existing `assertOpen`/captured handle wrapper, preserving delegated source binding and release.
- Update explicit SettlementFacts typed fixtures/compositions discovered by TypeScript; export type through existing managed barrel if required. No new fact group/event/storage journal.
- Move `createRecovery(deps,context)` and its consuming `createAdmission(...)` inside the `respond` invocation (currently constructed once with the response runner), before first admission/await. Keep the existing request-preparation helper if it has no per-response recovery state.
- Register its delegated source synchronously using actual invocation `deps.registerFactSource`; retain that exact source locally, never read a later invocation's `deps.sourceFacts` during drain.
- The helper copies existing scalar recovery fields exactly as current `fact()` does; no event envelope, mutable folded object, deserialized executable token, or event-ID lookup becomes authority.
- Ordinary `required` and `retry-started` stay on current action/generation paths with current checks. Cold history supplies data only; a live response owns any newly decided terminal outcome.
- Add a small private helper, e.g. `agent/recovery-settlement.ts`, owning at most one resolution capture plus one conservative blocked correction for this response, their outcomes, and original failure.
- Helper exposes terminal operation/drain internally, not a new public Agent capability; source lifetime ends after successful drain and drops captured data.
- Use `capture.admit()` once per decided outcome; read raw ProducerFactOutcome before converting success with committedFactSeqs. Never recapture the same outcome to retry.
- Unknown/conflict/recovery-required retain original capture and call `holdRecovery`. Malformed capture retains its failure and calls the existing recovery-fault path; also preserve the real source hold until its drain can succeed. Memory requireRecovery currently only asserts lifetime, so do not claim that call alone fences a nondurable owner: use its actual holdRecovery and retained failing drain. Closed/failed sources cannot reopen work. Do not rewrite generic memory fault semantics to hide this packet's own lifetime obligation.
- Drains use original `reconcile()`/`observe()` only. Known absent stays retained; no automatic `retryAbsent`, replacement batch, or semantic retry.
- Explicit original-source management may invoke the retained handle's existing `retryAbsent`; no new management API is required in this packet.

## 4. Resolution state machine and error precedence
- `resolve()` still starts only after actual accepted main completion; retain exact previous recovery scalars before the first resolution barrier.
- If pre-resolution flush aborts/fails before resolved issuance, decide blocked directly on the held source; save it without the canceled signal, then propagate original checkpoint failure.
- If resolved is committed/memory-committed and the subsequent flush/check fails or Stop arrives, capture exactly one blocked correction on the same held source.
- Successful blocked capture and barrier produce conservative cold blocked state, preserving retryConsumed and the original recovery identity; no transport/effect is replayed.
- If resolved issuance is uncertain, retain it and the pending correction decision; do not issue blocked against an unresolved physical frame.
- Original drain may reconcile resolved to committed, then finish the already-decided blocked correction. This is finite original settlement, not renewed model work.
- If resolved is proven absent, retain that exact capture and pending decision until explicit original-source disposition; cold prior required/retry-started remains unresolved.
- If blocked issuance is unknown/absent, retain its original capture and refuse new work. Do not claim a durable blocked checkpoint until the original capture is actually committed.
- Aggregate actual correction-save errors with the original Stop/checkpoint failure as cause. Preserve primary failure even if correction flush also fails; do not silently discard those failures.
- Source close/drain joins all work; no detached producer promise, normal metadata fallback after Stop, or new action registration after cancellation. Ordinary no-recovery responses close their empty delegated source promptly; uncertain captures retain the original source and do not block by joining their own enclosing response Promise.

## 5. Accepted usage and optional observation
- Keep accepted usage on existing `settlement().lifecycle.usage`; retain exact accepted event/measurement attribution and strict fact DTOs.
- `budget.record()` always updates in-memory budget to admission unavailable/awaiting-projection after acceptance, even when coordinates cannot be read; failed read omits postResponseContextRevision.
- No terminal budget port: omit the optional persisted post-response diagnostic when the invocation is canceled; ordinary checkpoint/admission writes keep their current authority.
- Pass the current signal from `acceptCompletedModelStep` through `completeModelStep` to `record`; check before attempting the optional normal-metadata write.
- Handle the race by inspecting its raw outcome: only proven `not-issued/FACT_CANCELLED` or backend-proven `absent` permits optional snapshot omission. Unknown/conflict/install failure must retain/report existing owner recovery, never masquerade as successful omission. Absence here is not a committed snapshot: in-memory budget remains unavailable/awaiting-projection and cold readers must rederive from real accepted/usage facts.
- Do not swallow arbitrary metadata exceptions or real usage failures; all successful accepted usage remains installed even when optional observation fails.
- Replace `finally` error override in `acceptCompletedModelStep` with explicit primary/result bookkeeping: attempt accepted completion once, preserve acceptance/flush failure, aggregate an actual secondary completion failure.
- In `exchange.ts`, check `signal.throwIfAborted()` after the awaited acceptance flush, retaining existing callback timing; Stop cannot return success into dispatch/generation/recovery continuation.
- Keep `onAccepted` as local installed fact evidence, not a newly named durability acknowledgement; memory observer failure still has its existing nondurable meaning.
- IC-B-compatible future handshake: return/hand off raw ProducerFactOutcome and exact installed event alongside a separate flush disposition; only actual issued receipt identifies managed acceptance. Do not implement a fake committed hook or acknowledgement store here.

## 6. RED/GREEN matrix (actual producer boundaries, all promises joined)
| Control / actual test owner | RED and final required observation |
|---|---|
| `core-agent/test/context-recovery.test.ts`: second actual HTTP overflow | Exact two physical main sends, one summary, prior effect once; top-level semantic blocked and original provider cause; durable blocked/retryConsumed; reload/followup sends zero. |
| Same suite: failed required/blocked save | Inject actual fact/flush failure separately; save AggregateError retains provider primary and real save failure; never semantic-only success; no third send. |
| Same suite: known-to-unknown / unknown-to-known, consumed false/true, unresolved identities | Preserve existing binding tuple/allowance controls; no metadata transition renews consumed retry; cold state and send count agree. |
| Same suite: held resolved flush, Stop and storage failure | Gate after exact resolved installation; abort/reject, release, join; source accepts blocked while normal metadata rejects; cold blocked after successful correction; accepted output/usage preserved, effects once. |
| New focused managed recovery settlement tests using real coordinator/backend | Gate original resolved/blocked receipt, vary committed/unknown/absent/install-failed; unknown reconciles only original key, absence does not reissue; source holds/refuses followup until original outcome resolved. |
| Same managed matrix: correction failure | Preserve original Stop/checkpoint cause plus actual save error; cold state described truthfully as unresolved/unknown until successful original correction; reconciliation never repeats HTTP/tool effects. |
| `core-session` nondurable + `session-persistence/test/managed-fact-batch.test.ts` constructor controls | Both accept valid held terminal facts after Stop and reject required/retry-started, budget/arbitrary metadata, seq spoofing, accessors/proxies/class DTOs and closed sources. Capture mutation cannot change admitted bytes. |
| `core-agent/test/context-snapshot.test.ts`: held acceptance flush + Stop | Actual installed acceptance and receipt boundary, one measured usage sample, no dispatch/effect; original cancellation retained; budget unavailable, omitted optional post-response event; cold acceptance retained. |
| Same suite: valid acceptance then failed coordinates/observation | Use plain JSON continuation and inject failure only after real acceptance; usage remains once, postResponseContextRevision absent, unavailable budget; subsequent unsupported request fails before transport. |
| Same suite: opaque class continuation negative control | Remains FACT_INVALID_GROUP before acceptance; zero accepted calibration; never use this fixture as proof of post-acceptance observation behavior. |
| `core-agent/test/provider-usage.test.ts` + R5 recovery controls | Real audit/save aggregation and failed physical-attempt usage preserved; raw unknown/known-absent remain held; no new automatic retryAbsent. |
| `session-executor/test/context-recovery.test.ts` integration | Actual service submit/Stop/cold reopen, real JSONL coordinator, parked child and prior tool result retain owners; no effect replay or new recovery allowance. |

## 7. Implementation/verification order
1. Freeze these interfaces with IC-B; implement semantic result + independent causal RED/GREEN first.
2. Add closed Session terminal constructor in managed and memory, then per-response recovery source/drain; validate exact outcome matrix before integration.
3. Fix budget optional observation and finalization error preservation; replace invalid acceptance fixture with distinct positive/negative controls.
4. Run package-CWD focused Vitest sequentially (`pnpm exec vitest run <files> --maxWorkers=2 --minWorkers=1`), then affected package typechecks and bounded integration.
5. Record exact source bytes, RED/GREEN raw output, caller error/cause, event/receipt/source identity, cold folds and HTTP/effect counts; distinguish known remaining baseline failures.
6. No claims that unknown/absent equals durable blocked, no metadata permission widening, no changes to IC-C compaction/context engine or IC-B acceptance authority.

## Root self-review / collision decisions

| Pair / requirement | Resolution |
|---|---|
| Semantic require result / response catch | Closed original result and exact identity; only after real barriers, no false save classification |
| Recovery constructor / managed+memory+delegated source | One closed draft/validator and original capture semantics across all implementations; no new storage format |
| Canceled correction / revoked action | Pre-existing held terminal source settles original attempt; required/retry-started remain revoked |
| Unknown resolution / later blocked decision | Resolve original physical frame before dependent correction; absent remains held, no auto retry |
| Recovery source / parent drain | Per-response local state, prompt empty/success close, no self-join or session-lifetime growth |
| Acceptance flush / usage+budget | Real usage remains; optional canceled observation omitted; errors preserve primary and genuine secondary cause |
| IC-C / P3 fixture worker | No compaction/contextengine/history or other worker's three test files; new failures reported before scope expansion |
| IC-B next acceptance handoff | Existing onAccepted remains installation evidence; later raw outcome + barrier + issued receipt must stay distinct |

Root ruling P2-05 (2026-10-24): the real managed/loopback receipt39 showed that ordinary metadata's proved-absent optional budget write leaves the document available, whereas unknown/install-failed remain held. The original plan overextended required-result retention to a derived optional snapshot with no retained retry handle. Do not manufacture a permanent unrecoverable source hold. The narrowly isolated absence outcome may omit only that snapshot after accepted completion/usage; qualify actual warm followup and cold continuation, missing optional record, unavailable capacity and no replay. Required recovery/usage/acceptance absence still retains its original operation. Preserve receipt39 as evidence that triggered this contract correction, not as a waived required-data defect.

Delivery includes exact changed-range/source copies, raw commands with numeric exits, every row's evidence/disposition and remaining release obligations. Write task-1-report.md in this plan's root SDD directory and stop writing for fresh review. ROOT continues integrated delivery; this packet is not whole-version completion.

## P2-06 authorized extension — accepted calls before batch entry

Postcommit receipt45 proves a real missing owner: Stop or save failure after accepted tool-call installation, before executeToolCalls, preserves usage but writes no terminal result. The exchange stays unresolved/protected and warm/cold requests omit that accepted pair. This packet is reopened; original23be7d67 and its qualified receipts remain intact, not amended.

- Own the original pre-entry call batch within the existing response lifecycle. Register its genuine delegated settlement source before the acceptance/continuation awaits (prefer per-response setup before admission), capture the exact completed original batch/call seqs before accepting, and close empty/successfully handed-off sources promptly. A small cohesive agent/unstarted-call-settlement.ts helper is allowed; no new journal, registry, execution lane or public permission API.
- On a failure before handoff to the existing executeToolCalls owner, settle each actually committed original call exactly once with the existing TOOL_ABORTED_BEFORE_DISPATCH result constructor and precise original call reference. No registry lookup, policy preparation, tool body, generation reissue or repeated effect. Keep accepted assistant/usage intact; do not reuse model-step discard, duplicate assistant audit, or mark accepted output unaccepted.
- After handoff, batch cancellation/settlement stays solely with executeToolCalls. The normal response-to-batch handoff must have a clear control-flow boundary and no unowned async gap; test Stop at that boundary and prove one terminal result, not two.
- The result establishes only the known local fact that this original call was never dispatched. It must not infer acceptance/durability from later JSON event scans. If acceptance is unknown, keep its original document frame under existing reconciliation. The call fact already committed before acceptance is the result dependency; no dependent result issuance may bypass the document's unresolved-frame gate. A required result that has never physically issued can finish through the existing original source after that gate clears; backend-proven absence remains held and never auto retryAbsent. Do not confuse not-issued with a proven absent issued operation.
- Retain original capture/outcome for result unknown/absent/install failures; source holds/drains on original operations. Stop does not revoke required original outcomes. Preserve primary Stop/save failure with any real result-settlement failure; successful original close drops retained state. No silent outcome fabrication for calls without actual committed references.
- Required controls: existing actual loopback Stop/save-error RED45 becomes warm+cold positive with paired never-dispatched results, closed original exchange, original acceptance/usage once, zero prior tool effects/replay and honest request bodies. Add real managed coordinator acceptance-unknown recovery and terminal-result unknown/absent/install cuts; conserve exact keys and call refs. Add accepted multi-call batch and successful ordinary handoff/Stop-at-entry controls to prove no duplicate settlement. Pending required data remains held; no broad change to current protection or renderer to conceal the gap.
- Allowed product owners are response/finalization/turn only where the actual handoff requires it, existing settlement source and the new cohesive helper. Do not expand to history/state/compaction or fabricate permissive classification. Existing R5 unaccepted-attempt controls must remain green. This extension receives the same fresh full-range review as the original P2 packet after implementation.

## P2-07 authorized interface — retain the original acceptance operation

Receipt52 proves that the temporary uncertain-acceptance WeakSet cannot finish the original classification when an initially unknown acceptance is later proven absent: the source closes while an unaccepted unit remains permanently protected. Replace that temporary classification workaround with a retained original captured acceptance, using the existing action capture framework.

- Add a narrowly typed `ManagedAction.captureModelExchange` (name may follow existing vocabulary) over exactly the existing assistant + accepted-exchange + optional generation-acceptance group. It is the capture form of current agent.accept, not a generic metadata/fact writer or expanded permission. Reuse one closed group constructor/validation for both paths; preserve ordinary raw accept callers' behavior. No new journal, storage format, generic outcome registry or JSON-derived authority.
- Capture immutable original payload/identity once; initial admit requires the same normal action permission/current checks as existing acceptance. The existing CapturedActionFact.observe/reconcile observes only that original operation. Reconcile issued unknown/conflict/recovery-required by its original key; not-issued/proven absent cannot silently issue or retry after Stop. No new acceptance or model request is minted by recovery.
- Wire the actual per-action capture through Agent's private execution fields, preserving P1 host receiver/isolation. Allowed exact extra owners are core-session managed ports/group-constructor/memory action and required exports; session-persistence coordinator action captures; Agent types/dependencies/create/exchange plus the P2 response/finalization/original settlement helper. Typed fixtures may use genuine owners. Do not change history/state/compaction or replace all fact APIs.
- The per-response original acceptance source retains the genuine handle/outcome and a deferred failure-close continuation. Known committed/memory-committed must never receive a false unaccepted step/failed. Proven absent/not-issued must eventually receive the original unaccepted failure boundary. Unknown must remain held, never close successfully with unresolved classification.
- Defer the dependent failure/step-end/turn-end ordering while acceptance is unknown, using original registered source lifetimes. On genuine original disposition, finish unstarted results first, then any required failed boundary, then the original end boundaries. Preserve existing source-proven ordering; do not append a late failed marker after a supposedly closed end. Audit generation disposition ordering as part of this same failure continuation. No self-join or registering new work after cancellation.
- Accepted callback/event installation, raw captured outcome and flush barrier remain separate. Late observation may discharge original closure only; it cannot dispatch calls, restart a model, fabricate calibration or promote a copied event/ID into authority. Preserve reporting exactly once and original provider usage/error; memory observer insertion remains honestly nondurable, not a forged durable receipt.
- Extend actual managed matrix: initial known absence and unknown→committed/absent/conflict/install-failed; Stop and save error; original source close/retry; warm/cold projection and absence of protected orphan; exact original keys and no duplicate frame/request/effect. Include bounded constructor/runtime controls for changed raw payload, invalid fields and canceled initial admit. Keep ordinary acceptance/captured acceptance compatibility plus all original R5/P1 controls.
- Full P2 remains unaccepted until this source-boundary repair and independent full-range review. Preserve23be7d67 and receipts45/52; no amend, waiver, permanently held fake recovery source or observer inferred from archive scans.

P2-07 construction refinement: use an explicit internal generation-factory cleanup dependency instead of temporarily replacing a method on the genuine ManagedAction. `AgentGenerationFactory` receives the original action plus a before-drain dependency, forwarded by actual `createGenerationLifecycle` construction to its registered source's existing pre-drain hook. Preserve action identity/ownsAction and frozen-object compatibility. Authorized exact additional files: `core-agent/src/agent/generation.ts`, `session-executor/src/lifecycle/generation-actions.ts`, and the two actual main/child generation-factory construction sites in `session-executor/src/assembly.ts`; fixtures forward the real dependency where applicable. No assembly instruction/schedule/other wiring changes. Verify actual source registration timing, coordinator-driven sibling close, setup failure and P1 normal-admission fence/error preservation under reordered cleanup. Do not preserve a formerly unsafe cleanup sequence merely to satisfy its old ordered error-array assertion, and do not weaken any missing-error, busy-lifetime or receiver control.

P2-07 borrowed-ingress refinement: actual service.submit/runAdmitted receipt63 proves its first generation comes from an independent input owner, bypassing AgentGenerationFactory. Unknown acceptance later commits/absents and the exchange closes, but real coordinator retries leave that main generation open. Authorize the existing `session-executor/src/lifecycle/input-preparation.ts` and `literal-input.ts` constructor/close owners (use actual resolved file locations): pass the same generation before-drain dependency tied to that original ingress owner's close decision. Begin its original generation.close synchronously, so the required terminal capture exists, then release the prerequisite BEFORE awaiting that close/drain. Resolve it on every success/setup/catch path even if generation was never created; preserve normal action fencing and original input preparation observe/reconcile. No new borrowed-authority API, proxy, registry, request or input replay. Qualify actual service UNKNOWN→COMMITTED and UNKNOWN→ABSENT with concurrent service/coordinator close, retry, terminal generation fact, no orphan or replay and warm/cold continuation; also failure at each construction boundary. This real shipping path is part of P2 acceptance, not a deferred limitation.
