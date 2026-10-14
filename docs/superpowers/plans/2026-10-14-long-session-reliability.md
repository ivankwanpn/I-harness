# Long-session reliability implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the complete long-session request-budget, diagnostic and recovery flow across IH's supported protocols, then stop on the current version.

**Architecture:** Protocol adapters prepare one immutable input and expose payload-free measurement through the existing wrappers. One per-agent budget owner provides admission, compaction, persisted facts and UI/tool reads; typed confirmed-overflow recovery changes durable effective history before a single rebuilt request.

**Tech Stack:** Existing TypeScript/Vitest/Node, Session log/coordinator, SDK JSONRPC, Electron/React; no new broker or live-provider requirement.

**Spec:** `docs/superpowers/specs/2026-10-14-long-session-reliability-design.md`

## Global Constraints

- Desktop version remains0.1.12; general v0.1.13 decomposition/E/I plans remain paused. No merge/release/installed app/profile changes.
- All delegated roles GPT6.1Sol fork none/high, no recursive agents; one product writer and fresh scoped review per task plus final repair-range review.
- Preserve protocol-specific cache/usage/signature/image/order/namespace and raw option precedence. Public Responses and Codex subscription are distinct cap capabilities.
- Preserve original Session/tool effects and owner authority. Bare400/413 never triggers destructive recovery; Stop/persistence errors remain authoritative.
- Payload-free scalar diagnostic allowlists; no credentials/prompt/signatures/image bytes or durable hash vectors. Billing counters stay raw.
- No test/tool-script decomposition or audit baseline weakening. Meaningful RED/GREEN; suites sequential maxWorkers2/minWorkers1, no redundant unchanged reruns.

## File/ownership map

|Task|Owned responsibility|Principal files|
|---|---|---|
|1|Safe typed model failure across transport/SDK/Desktop|llm-seam/provider-error/, SDK errors/server/client, gateway input, runtime diagnostics|
|2|Prepared protocol input and shared complete measurement|token-meter/projection/, llm-seam/prepared/, five adapters/context preparation, stream wrappers|
|3|Session-owned admission/snapshots/calibration/fork identity|core-session/events/context + folds, core-agent/agent/context and turn input, assembly/child/resident/persistence event registry|
|4|Compaction convergence/summary budgeting|compaction config/engine/projection/slices/summarizer|
|5|Typed bounded reactive recovery|core-agent/agent/recovery and model attempt lifecycle, core-session recovery fold/markers|
|6|Read-only context UI/tool and persisted diagnostics|core-tools context-remaining, session service/gateway/SDK context, Desktop ContextUsage/diagnostics/usage capture|
|7|Bounded reports with existing owned durable results|subagent result-preview/tools/task notification/register, persistence strict document seam|
|8|Combined controlled long-session regression and final gate|e2e fixtures/tests, packaged smoke/docs/checkpoint; version unchanged|

## Task 1: Preserve model failure facts and correct classification

**Files:** Create `packages/llm-seam/src/provider-error/{types,classify,facts,http}.ts`; retain index facade. Modify llm-seam waiting/retry error handling, llm-* HTTP/SDK error seams, `packages/core-agent/src/agent/model-step.ts`, `packages/sdk/src/{server,client}.ts`, `packages/desktop-gateway/src/{input,host}.ts`, `packages/desktop/src/main/runtime-diagnostics.ts` and related shared error wire types. Tests `llm-seam/test/provider-errors.test.ts`, existing retry/http/SDK/input/diagnostic cases.

**Interfaces:** produce `ModelFailureFacts`, `modelFailureFacts(error)`, canonical classification and validated scalar safe facts; legacy message/RPC numeric codes remain. Structured facts travel in additive modelFailure/errorDetails data, not raw bodies.

- [ ] RED exact response bodies: generic invalid_request_error + context_length_exceeded, CONTEXT_TOO_LONG, SDK ValidationException with precise context wording; controls auth/quota/schema/quoted context/413. Assert code/type/status/request ID/limit facts and no private body/key/prompt.

```ts
const err = await describeHttpError('anthropic', new Response(JSON.stringify({error:{type:'invalid_request_error',message:'context_length_exceeded'}}), {status:400}))
expect(retryErrorCode(err)).toBe('CONTEXT_WINDOW_EXCEEDED')
expect(modelFailureFacts(err)).toMatchObject({code:'CONTEXT_WINDOW_EXCEEDED',httpStatus:400})
expect(JSON.stringify(modelFailureFacts(err))).not.toContain('private prompt')
```

- [ ] Implement semantic-specific priority, bounded error body read and safe scalar extraction; unchanged-payload retry never loops a context error, including always mode. Preserve capacity10second and transport behavior.
- [ ] RED/GREEN through real SDK error/status and Desktop input/diagnostic path: retain legacy text plus facts; unknown generic errors remain bounded/generic; repeated400 fails a turn, not host scope.
- [ ] Reuse controller baseline75seam/7files+types0 on1332a465 (docs only since). Run affected seam/HTTP/SDK/diagnostic tests and types sequential; commit `fix: preserve classified model failure facts`; report/review before task2.

## Task 2: Prepare and measure the actual protocol input once

**Files:** Create token-meter `projection/{types,pricing,fingerprint,measure}.ts` and llm-seam `prepared/{types,fallback,wrappers}.ts`; declare real one-way dependency llm-seam->token-meter. Modify five llm client/request owners, add their `context.ts` descriptors, provider build/wait/retry wrappers, usage-capture/bind, provider-runtime binding, assembly stable handle, gateway model-binding/signal wrapper and compactor sessionId wrapper.

**Interfaces:** consume task1 safe errors; produce spec ModelClient.prepare/PreparedModelRequest/PreparedStreamControl, PreparedRequestMeasurement, ProjectedInputFacts, output/packet facts, and wrapped preparation helpers. token-meter remains independent of llm-seam. WithOutputCap is synchronous and immutable.

- [ ] RED full prepared bodies for all5adapters, public/subscription Responses, thinking replay/drop, signatures/order, images/text-only quarantine, raw options, conflicting cap fields and actual-model mismatch. Holding image/selection preparation then replacing source options cannot cause different measured/sent input.

```ts
const prepared = await client.prepare!(request)
const capped = prepared.withOutputCap(4096)
expect(capped.measurement.input.inputFingerprint).toBe(prepared.measurement.input.inputFingerprint)
await collect(capped.stream())
expect(capturedBody).toEqual(expectedFrozenBody)
expect(prepared.measurement.packet.bodyBytes).toBe(Buffer.byteLength(originalBody))
```

- [ ] Count final actual components, including only eligible reasoning and real raw-option replacements, no duplicated continuation backups. Complete conservative multilingual pricing has explicit uncertainty, exact HTTP bytes vs SDK estimate and no raw payload diagnostics.
- [ ] RED/GREEN wrapper chain: logical retry/waiting signal/activity, usage attribution, runtime policy refresh, stable client selection and manual-compaction signal remain present on all cap derivatives. No raw inner stream bypass, duplicate preparation or OAuth refresh during measurement.
- [ ] Restore compatible custom-client fallback with neutral-only status; validate reasoning floors and subscription unsupported cap; update real manifests/lockfile without version bump.
- [ ] Run adapter/prepare/wrapper/cache/usage contracts and affected types, normal reachability; commit `feat: prepare protocol-owned request context`; fresh review.

## Task 3: Install one owned Session budget and admission pipeline

**Files:** Create core-session `events/context.ts`, projection budget/checkpoint folds and persistence known event registrations; token-meter checkpoint/calibration modules; core-agent `agent/{context,budget,step-input,turn,finalization}.ts`; assembly and subagent child/resident binding/budget wiring. Preserve existing facades and role grants.

**Interfaces:** `Agent.contextBudget?():BudgetRead`, owned RequestBudgetSnapshot, scalar prefix ContextUsageCheckpoint; metadata events version1. Snapshot reader never prepares/streams/authenticates. Actual binding fields forwarded to compactor/model policies and child context.

- [ ] RED controlled real agent + actual prepared Anthropic input: 40K signed thinking tail is counted in next admission and snapshot; cache-inclusive/exclusive calibration; prefix/binding/rewrite invalidation; restored scalar prefix checkpoint without payload/vector storage.

```ts
await agent.run('first')
const state = agent.contextBudget!()
expect(state.kind).toBe('ready')
expect(nextPrepared.measurement.input.components.replayedReasoning.heuristicTokens).toBeGreaterThan(0)
expect(state.kind==='ready' && state.snapshot.estimateSource).not.toBe('provider-exact')
```

- [ ] Prepare after all claimed inputs/hooks/context/catalogue updates. Admit from same facts, output reserve/floor/headroom, derivative cap and final revision check; max3 local stale rebuilds, no hook/inbox replays. Held/rejected budget checkpoint means zero transport.
- [ ] Per-agent authority for root/no-fork/all-fork/finite-fork/resident children, independent binding/window/effort; inherited parent checkpoint/rejection cannot become child state. Existing role tool grants remain; replace a copied context tool with child reader only where granted.
- [ ] Old logs load; malformed facts and unsupported operational readers fail nondestructively; no unknown windows invented. UI-visible stale/unavailable facts don't get a healthy percentage.
- [ ] Run token-meter/core-session/agent/budget/binding/child/fork persistence covering tests/types; commit `fix: unify owned model context admission`; fresh review.

## Task 4: Make compaction bounded, cancellable and projection-correct

**Files:** `packages/compaction/src/{config,summarizer,slices}.ts`, engine admission/prune/summary/commit, projection shadowed/window; core-agent compactor factory to pass prepared model/session signal and actual binding policy. Tests new summary-admission/active-prune/checkpoint supersession plus existing limits/prefix/prune/auto tests.

**Interfaces:** add `summaryMaxOutputTokens?:number` default4096, `summaryLimits?:{contextWindow?:number;maxOutputTokens?:number}`, and CompactionRunOptions `{signal,protectedSeqs,reason,maxSummaryCalls}`; add engine recover(session,options). maxTokens retains accepted text limit. Eight shared calls/two shrink retries per piece are finite defaults.

- [ ] RED summary wire uses independent cap instead of384K; actual directive/system/tools/reasoning/cap floor measured. Distinct summary binding never borrows main limits; Stop reaches held transport; cancellation/checkpoint errors escape fail-soft.
- [ ] RED active-prune idempotence, real candidate reduction, undefined output safety; repeated anchored summaries supersede only incorporated old summary seqs. Raw log/results stay intact, pair boundaries valid.

```ts
await engine.compact(session)
const once = deriveMessages(session)
await engine.compact(session)
expect(activeSummaryCount(session)).toBe(1)
expect(rawToolOutput(session, callId)).toEqual(originalOutput)
expect(summaryRequests.every(r=>r.maxOutputTokens!<=4096)).toBe(true)
```

- [ ] Bounded balanced piece shrinking on confirmed summary overflow; preserve pending segments, reject indivisible fixed input, validate final accepted retained checkpoint, no truncated/refused/incomplete commits. No arbitrary history loss from a reset.
- [ ] Fix relevant per-model policy binding gap and remove its existing skip with actual initial/rebind assertions. Run compaction/fold/agent contracts/types; commit `fix: make context checkpoints bounded and durable`; fresh review.

## Task 5: Recover confirmed overflow with one changed-input retry

**Files:** core-agent `agent/{recovery,model-step,turn,finalization}.ts`, core-session recovery fold/events and fork handling; compaction recover integration. Tests `core-agent/test/context-recovery.test.ts`, same-instance service/background-child integration.

**Interfaces:** owned durable recovery-required/retry-started/resolved/blocked facts; one recovery per logical step. Facts use request/binding/input hashes and scalar cost, never payload.

- [ ] RED real adapter HTTP400 recognized context -> balanced failed step, persisted requirement -> local prune/summary -> durable changed/reduced prepared input -> one rebuilt successful main request. Prior tool bodies run once; failed partial calls never dispatch.

```ts
await service.submit(id,'continue',signal)
expect(mainAttempts).toHaveLength(2)
expect(mainAttempts[1].inputFingerprint).not.toBe(mainAttempts[0].inputFingerprint)
expect(mainAttempts[1].inputCost).toBeLessThan(mainAttempts[0].inputCost)
expect(priorToolEffects).toBe(1)
```

- [ ] Generic400/auth/quota/schema/413 controls do not compact/reset. Confirmation state survives meter invalidation/reload; same rejected context plus another continue isn't resent unchanged. Explicit model change receives fresh own admission; only accepted main success resolves.
- [ ] Hold/reject required/projection/retry checkpoints and Stop/summary awaits: no retry transport after failure/Stop. Crash after retry-started does not grant second automatic retry; second overflow is blocked and inspectable. Ordinary failures leave parked background children and same service usable.
- [ ] Run targeted agent/recovery/core-session/fork/service/child tests/types; commit `fix: recover model context overflow without replay`; fresh review.

## Task 6: Use shared budget and structured diagnostics in UI/tools

**Files:** core-tools context-remaining, session-executor service/assembly context getter, SDK context/status wire, gateway context/usage-capture and pure binding descriptor, Desktop bridge/ContextUsage/runtime-diagnostics/diagnostics view.

**Interfaces:** consume BudgetRead/task1 facts; retain existing context response fields plus source/confidence/reserve/coverage/recovery status. Live getter delegates actual owner; cold validated facts or unavailable. Pure metadata lookup never creates clients/auth/usage/network. Usage records gain validated bounded context facts separately from billing counters.

- [ ] RED UI/service/tool data matches real prepared main/child request, including system/schema/replayed thinking; no divergent43.8% counter. Unknown/stale before first measurement is explicit, full-by-provider distinct from estimate.

```ts
expect(await service.contextState(id)).toMatchObject({kind:'ready',estimatedTokens:budget.estimatedInputTokens})
expect(await contextTool.execute({})).toMatchObject({used:budget.estimatedInputTokens,source:budget.estimateSource})
expect(readOnlyInspectionTransportCount).toBe(0)
```

- [ ] Older capability/wire remains readable; raw billing/cache numbers unchanged; project/Session identity and old-epoch UI responses fenced. Show actual output reserve/cap support and recovery/blocked guidance.
- [ ] Safe request metrics/compaction reasons and typed failure facts reach logs/toasts; no private body/key/signature/image leaks. Existing runtime close emits bounded generation/reason at its owner, separate from model failure.
- [ ] Run context UI/SDK/gateway/input/usage/diagnostic integration/types and visual controlled layout; commit `fix: expose the admitted context budget`; fresh review.

## Task 7: Bound repeated reports while preserving owned full results

**Files:** subagent result-preview, tools status/wait/job output, task-protocol/task-notification/register and existing result persistence; session-persistence document strict seam; assembly production report policy/Team compatible callsites.

**Interfaces:** `putDocumentStrict(key,data):Promise<void>` on existing chain/lease, legacy putDocument unchanged. Injectable report policy; default shipping2048byte per-child preview/16384aggregate, UTF8-safe cursor/digest/paged output. Full store remains existing task/job owner, no new registry/outbox/drain.

- [ ] RED many long completed children list/wait/parent admission remain inside aggregate bound and advertise authorized full-result references. New followup changes digest; matching cursor avoids repeated text; metadata/framing charge inside bound.
- [ ] RED full-result durability failure suppresses durable ref/wake, retains true sideeffect/outcome and fails visibly without relaunch. Strict document operation rejects its own failure but normalizes chain tail so later save works; legacy callers retain behavior.

```ts
const page = await list.execute({})
expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16384)
const full = await output.execute({task_ids:[ownTask],offset_bytes:0,max_output_bytes:4096})
expect(full).toMatchObject({truncated:true})
await expect(output.execute({task_ids:[foreignTask]})).rejects.toThrow()
```

- [ ] Full retrieval pages use stable digest/UTF8 boundaries and existing ownership; stale digest refuses mixed generations. Missing policy keeps legacy package behavior; shipping model registrations/main/child/notification text use bounded policy, UI full display separate.
- [ ] Run subagent/task/persistence/Team/assembly contracts/types; commit `fix: bound model-facing reports with durable retrieval`; fresh review.

## Task 8: Combined reliability verification and stop

**Files:** controlled synthetic long-history e2e and packaged smoke, lasting docs/research/README/context help, checkpoint only. Existing private transcript is never committed as a test fixture.

- [ ] Exercise one actual request pipeline per protocol and Responses public/subscription variants: measured final payload, classification, independent summary cap, bounded recovery/Stop/restore, source counters and previews. Use mock fetch/SDK transport and actual Session/coordinator, not only event spies.
- [ ] One real long-history service/SDK/gateway scenario repeats continue after overflow, rejects unknown/schema failures distinctly, preserves child/result ownership and restores saved recovery state. Assert tool effects and main logical attempts, no hidden retry loops.
- [ ] Fresh final repair-range review against1332a465 after task gates, one scoped fix wave if needed. Final fixed-tree affected tests/types, repository verify:all/reachability and isolated packaged CLI/SDK/Desktop gateway Responses/Anthropic smoke. Inspect actual populations/exits/platform limitations, do not infer native qualification from JS tests.
- [ ] Verify every version file stays0.1.12 where currently0.1.12; save local commits/review/test/source evidence. No release/merge or S20/E/I continuation. Mark this repair complete only when all required cases pass, update pause checkpoint and stop.
