# D1a Ordinary Child Receiver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task after root promotion and checkout assignment. No recursive agents. Steps use checkbox syntax for tracking. Root promotes this packet under the approved program; execute only the explicitly assigned review task on its reserved checkout.

**Goal:** Deliver an original ordinary background-subagent completion once to a valid published SessionService parent through its existing managed Inbox and model lane, with durable Stop generation and original outcome recovery.

**Architecture:** Add required delivery-generation/source-binding/receipt facts to the existing managed journal, grouped with the actual original source start and recipient admission. Extend the existing received-input source and managed promotion guards; route one real ordinary subagent source through the published service lane. Source outbox ack/wake remains derived evidence, while original result/artifact/native owners remain authoritative.

**Tech Stack:** Existing TypeScript/Node/pnpm/Vitest; JSONL fact-batch version1; original managed writer/claims and controlled ModelClient; existing source/result/Inbox/lane lifetimes.

**Spec:** [D1a specification](../specs/2026-10-26-ordinary-child-delivery.md). Read it and the original [preflight](../../research/2026-10-26-event-delivery-preflight.md) before implementation. Root's integrated plan Task5 remains controlling; this packet completes only its scoped ordinary-child receiver slice.

## Global Constraints

- Product stays `0.1.13-rc.1`. Session13 is explicitly ratified for Task1, including genuine12 migration/predecessor refusal and original11/12 bootstrap birth preservation.
- `TaskProtocolDocument.formatVersion` stays `1|2`; no new trust-bearing task/outbox fields, result store, event store or source IO in DTOs.
- B2 final review/integration is accepted at MAIN9453cf0e/productdd98e983 (root evidence); actual B2 signatures were checked on integratedb656d278 and its unchanged body was not re-audited here. The full source contract is now promoted; implementation requires the recorded root-assigned isolated checkout and immutable BASE. Preserve its integrated exact capture signatures. HOST retains ContextOutput Store/service/index lifecycle ownership; this packet does not edit those files.
- Preserve original11/12 bootstrap birth/stage/frame bytes, B2 pre-capture reservation, original task/native/artifact capture/references, model allowance/Stop/accounting and human-steer behavior. A genuine known-ready original outcome is reconciled, never replayed.
- Ordinary non-Stop human followup/steer does not fence old eligible children. Explicit Stop and rewind do. A fork target inherits no operational delivery authority; source session remains unchanged by fork.
- Distinguish executable pending eligibility from historical same-action origin proof. A consumed receipt cannot authorize a second finite action. An otherwise accepted parent without D1a's own-human origin returns unavailable auto-delivery capability and keeps its normal spawn/result-read behavior; genuine trusted open failure still propagates.
- Old unproved ordinary task rows retain normal readable results but cannot auto-wake. No adoption API. Team legacy ParentInputAdmission/mailbox behavior stays unchanged until its separate consumer cutover.
- One original source drain per registry, one recipient scheduling drain/lane; no fake consumer or unused-framework acceptance. Necessary deadline/backoff timers remain; healthy state polling is not added.
- Use package-CWD Vitest with `--maxWorkers=2 --minWorkers=1`, sequentially. Preserve original causal RED/setup/unknown evidence and exact source. No live provider/profile/account/release/push/tag work.

## Task shape and review gates

Use one product writer at a time; root assigns a fresh Sol worker for each task and a separate reviewer, with the reviewed branch handed forward. The three tasks are sequential checkpoints of one vertical delivery. Task1 establishes a usable managed protocol with real owned journal tests; Task2 connects its actual source/service; Task3 closes physical/lifecycle/upgrade qualification. Do not mark D1a complete until all three pass an independent complete-range review.

Recipient/source planning baseline is MAIN `5b47573bee140c4e5b74ec69e635b8d351b213a0`; B2 API was checked on integratedb656d278, with root's final acceptance now9453cf0e/productdd98e983. Root records the actual immutable dispatch base after final review/assignment. Keep baseline-vs-rebased causal expectations distinct; never rebrand a setup failure as the intended RED. Actual integrated B2 optional coordinator APIs are inspectBootstrapCapture(request) and bootstrapSemanticTargetWithCapture(request,guards,capture); exact signatures and backend seams are listed in spec§8. Delivery does not call them as authority.

## Task 1: Managed delivery protocol, required capture and Session13 compatibility

**Files — create:**

- `packages/core-session/src/events/delivery.ts`: exact closed data/validators from spec§3.
- `packages/core-session/src/conversation/delivery.ts`: staged scalar delivery index, eligibility and frame-pair validation.
- `packages/core-session/src/managed/delivery-control.ts`: private exact-view revocation control; it can only strengthen the durable fold's refusal, never grant eligibility.
- `packages/core-session/test/delivery-protocol.test.ts` and `packages/session-persistence/test/delivery-facts.test.ts`.
- `packages/session-persistence-jsonl/test/format13-predecessor.test.ts`, `test/delivery-journal.test.ts`, `test/helpers/format12-predecessor.ts`, and frozen `test/fixtures/format12-predecessor/{manifest.json,graph.json.gz,README.md,LICENSE}` using the existing format10 predecessor fixture mechanism.

**Files — modify, keep edits cohesive:**

- Core `src/{events/types,events/conversation,events/intake,index}.ts`, `conversation/{validation,generation,bootstrap-validation,seed-capture,history/facts,history/replacements,state}.ts` only for required facts/protection/origin linkage; `managed/{groups,ports,view,nondurable,memory-source,memory-group}.ts`; `inbox-view.ts`, `managed/inbox.ts`; `serialization/{jsonl,fact-journal}.ts`.
- Persistence `src/coordinator/{received-input-source,managed-document,action-captures,fact-types,bootstrap-header}.ts`, `format/{registry,validation}.ts`. Reuse actual `source-facts.ts` / `settlement-fact.ts`; change them only if the narrow per-capture guard integration requires it, preserving their generic original-capture contract.
- JSONL `src/{format,index}.ts`, `backend/{format-upgrade,fact-journal,bootstrap-header}.ts` for explicit13 support and literal11/12 birth preservation only. Rebase rather than replace B2's accepted changes.
- Executor `src/lifecycle/generation-actions.ts`: only pass actual view.formatVersion to its two readGenerationActions callers in Task1; wider service/lifecycle integration remains Task2.
- Regression tests `core-session/test/{fact-journal,input-event,semantic-seed-boundaries}.test.ts`, persistence `test/{received-cancellation-witness,semantic-bootstrap,conversation-format}.test.ts`, JSONL `test/{bootstrap-physical,fact-batch-journal,format11-predecessor,semantic-publication}.test.ts` where affected.

**Interfaces consumed:** existing FactOutcome/CapturedActionFact/CapturedSettlementFact, FactGroupDraft/resolveFactGroup, original ManagedAction.captureSubagentStart, ReceivedInputSource, createManagedSessionState, createConversationIndex, encode/readFactJournal, backend append/reconcileOwnedBatch and real B2 guards.

**Interfaces produced:** exactly the spec§3 types, including bound/unavailable DeliveryLaunchPreparation; `readDeliveries(view)`; `validateDeliveryFrame(events,formatVersion)`; optional second binding argument on captureSubagentStart; three ReceivedInputSource capture methods plus managed source's original frozen diagnostic owner field. `createGenerationIndex` gets staged `DeliveryOriginLookup.lookupActionOrigin(open:Readonly<MainActionOpen>):Readonly<DeliveryActionOrigin>|undefined`; `readGenerationActions(events,scope,formatVersion)` replays the same delivery/origin validation. No new public FactPorts catch-all or TaskDoc version.

- [ ] **Step 1: Freeze and preserve genuine12 evidence before touching the constant.** From actual dispatch baseline capture the closed TypeScript dependency graph of the predecessor execution reader using the established format10 helper's manifest/hash/graph extraction pattern. Pin exact source commit and checksums; loader rejects any workspace escape, fetch or provider import. Preserve at least a genuine ordinary12 journal and original semantic11/12 ready/header-only/interrupted bootstrap stages; do not create predecessor12 by changing a current constant. Record the actual old12 body/header bytes and TaskDoc/result reference fixtures. The new helper exports `extractFormat12Predecessor(root):Promise<{packages:string[];product:string;fileCount:number;graphFiles:number}>` and `pinnedSource`; counts are generated from captured files, never copied from another fixture.
- [ ] **Step 2: Write protocol failing cases against the real owner.** Use real coordinator/openManagedDocument and captured original start/end sources for the valid fixture; do not add test-only success append. Define test helper `ownedDeliveryHistory():Promise<{coordinator,backend,document,root,sourceSeq,terminalSeq,inputId,close():Promise<void>}>` inside delivery-facts.test.ts by real human admission → actual managed tool/call+dispatch → grouped start/binding → original retained task result/end. It is a test helper, not a production authority. Negative mutation tests copy that valid history and alter exactly one reference/field/frame boundary.

```ts
it('rejects a receipt split from its admission across complete frames', async () => {
  const f = await ownedDeliveryHistory();
  try {
    const paired = f.document.view.events.filter(e =>
      e.type === 'agent/delivery-received' ||
      e.type === 'agent/input/admitted' && e.inputId === f.inputId);
    expect(paired).toHaveLength(2);
    expect(() => validateDeliveryFrame([paired[0]!], 13)).toThrow();
    expect(() => validateDeliveryFrame([paired[1]!], 13)).toThrow();
    expect(() => validateDeliveryFrame(paired, 13)).not.toThrow();
    expect(() => validateDeliveryFrame(paired, 12)).toThrow();
  } finally { await f.close(); }
});
```

Run from packages/session-persistence: `pnpm exec vitest run test/delivery-facts.test.ts --maxWorkers=2 --minWorkers=1`. First missing API/type failure is a setup-stage RED only. Follow it with the genuine behavior baseline probes in Task2; do not claim an import failure proves lost wake.

- [ ] **Step 3: Define exact events and closed group lowering.** Copy the spec's closed types; reject unknown keys/accessors/undefined and format≤12. Add groups and resolve their concrete sequence references; source pair is start then binding, admission pair is receipt then existing admitted record. Implement physical frame check before aggregate journal installation, including torn-final and unframed-legacy rejection. Do not add journal v2 or new result bytes.

```ts
// Core lowering shape; normal resolve assigns seq fields and checks actual prefix refs.
case 'subagent-delivery-start':
  return [group.start, {
    type:'agent/delivery-source', version:1, kind:'subagent', ...group.binding,
    startSeq:{kind:'group',position:0,expectedType:'subagent/start'},
  }];
case 'delivery-admission': return [group.receipt, group.admitted];
case 'delivery-generation': return [group.event];
```

The draft reference object above is private lowering data; final persisted startSeq is a number. Add it to existing resolve's allowed reference rules rather than serializing this object or coercing it to a scalar unchecked.

- [ ] **Step 4: Stage one delivery fold with existing indexes.** Validate recipient scope, own non-synthetic human origin after latest close, unique open/id, real dispatched spawn call, immediately adjacent original start, one namespace/source binding, concrete committed terminal/resultRevision/envelope/outcome, adjacent admitted shape and unique key/input. Advance staged delivery before staged generation and use the exact historical lookupActionOrigin(open) contract in spec§4. Authenticate both permitted original finite-action orders: pending admitted observation opens before promotion, or the first action of the exact grouped input-start opens from its raw message afterward. A steer claim grants no extra action; bind one receipt to at most one original finite action across admitted/raw-origin aliases. Do not call isEligible(pending) to revalidate consumed history. Promoted/cancelled update derived disposition; rewind fences; summary/seed protection follows raw facts rather than rendered text. Seed import/export cannot carry operational authority.

Update readGenerationActions' current hardcoded11 bootstrap check to the actual explicit format argument and replay staged delivery before generation there too. Its two actual executor lifecycle/generation-actions.ts callers pass view.formatVersion. A current service notification must not pass the staged writer then fail the later lifecycle.read replay, or gain permission from the new producer string alone.

Source-order evidence: prepareInputExecution in executor lifecycle/input-preparation.ts and Agent openDirectInput open main before runAdmitted/input-start; agent/turn.ts promotes input-start before the fallback lifecycle.open and reuses supplied/direct firstGeneration when available; turn.ts opens deps.generationAction before step-input.ts claims steer. Add owner tests for these exact orders, immutable original actionId/openedSeq after consumption, no second action via the other origin spelling, no new B action for a steer claim, and live Stop-beforeIssue refusal separate from historical replay acceptance.

```ts
// Existing ConversationValidationIndex stage loop gains these paired operations.
const stagedDelivery = delivery.stage(readCurrent);
const stagedGeneration = generation.stage(); // origin lookup closes over stagedDelivery
for (const event of suffix) {
  validateShape(event, formatVersion);
  stagedDelivery.advance(event);
  stagedGeneration.advance(event);
  // Existing soft/preparation/history stages continue unchanged.
}
// In the existing synchronous install, commit delivery with the other staged indexes.
```

- [ ] **Step 5: Add required received captures and central pre-issue fencing.** Wire captureDeliveryOpen/captureDeliveryAdmission to original captureSettlementFact with per-capture guards; captureDeliveryClose installs synchronous exact-view revocation before any await and captures one required close. In managed-document admit/stage/backend.beforeIssue compose delivery preconditions for new delivery-generation open, bound subagent-start, receipt-admission, captured/direct input-start/steer-claim and finite action open from either the receipt-backed admitted observation-input or its exact grouped input-start raw message. It must run after any preparation/capacity wait, while original issued frame reconciliation remains unaffected. Only private owner construction can bind/revoke control; no public Session toggle. Keep readInbox raw audit/cancellation semantics; AsyncInbox executable pending/isPending combines durable fold and live guard, while cancel tests raw pending explicitly. Never change historical replay validity using current live Stop. Add memory behavior explicitly nondurable. Existing input/cancellation API behavior remains unchanged for nonordinary-delivery inputs and team legacy.
- [ ] **Step 6: Make upgrade13 explicit without rewriting original births.** Set current13 only after root promotion. Add registry12→13 identity and required types. Add13 to exact framed-reader/header lists and accepted writable upgrade sources. Genuine12 body is copied byte-for-byte after old-profile preflight; original semantic11/12 birth is preserve/confirm-checked first. New bootstrap births use current13; original11/12 stage headers/phases remain valid only in their exact original bootstrap append lane. `preserveBootstrapBirth` accepts original11→12/13 and original12→13, preserving manifest/stage/header preimages and actual birth frame bytes. Tests must inspect raw files, not just returned version.
- [ ] **Step 7: Execute owner and compatibility gates.** Run the named new protocol/delivery tests and existing affected suites sequentially from their package CWD. A valid paired frame succeeds; split/mutated source/terminal/recipient refs, hidden/forged new producer, old-format facts and seed imports fail before installation. Genuine12 upgrade body SHA stays identical and opens no generation; old11/12 original stages resume without second source callback or initial input. Literal predecessor12 refuses ready/header-only/torn13 with repair/upgrade/provider/fetch counters0 and unchanged bytes. A header-downgraded new required fact is rejected by predecessor/current old-profile controls before repair. Run each affected package `pnpm run typecheck` once after final source.
- [ ] **Step 8: Review checkpoint and scoped commit.** Inspect the entire Task1 diff, including all version/birth paths and new required-source close debt. Stage only its explicit files, then commit `feat: add managed receiver delivery protocol and format13`. This checkpoint is protocol qualification, not D1a/user-visible acceptance. Root or its assigned independent reviewer must approve before source integration proceeds; do not spawn reviewers from this worker.

## Task 2: Connect original ordinary source, receiver recovery and existing service lane

**Files — create:**

- `packages/session-executor/src/lifecycle/recipient-delivery.ts`: the single RecipientDelivery adapter using existing received source; no new journal/result owner.
- `packages/session-executor/src/service/delivery-drain.ts`: published-owner single-flight/dirty scheduling and one error-only timer.
- `packages/session-executor/test/helpers/delivery-fixture.ts`: real service/provider/backend fixture only.
- `packages/session-executor/test/delivery-receiver.test.ts`, `test/delivery-recovery.test.ts`.

**Files — modify:**

- `session-executor/src/lifecycle/{received-inputs,managed-document,generation-actions}.ts`, `src/{service,assembly}.ts`; existing `service/submission-completion.ts` only if needed to preserve original ingress settlement, not as a new delivery owner.
- `subagent/src/{task-notification,index}.ts`, `tools/{spawn,spawn-source,types}.ts`. No TaskDoc types/validation/schema field changes; TaskDoc-related tests assert this explicitly. Existing `task/registry.ts` early terminal callback may remain a dirty signal, while source's once-only original terminal-committed callback supplies the decisive signal. Existing `task/result.ts`, TaskPersistence, native/artifact/ContextOutput owners are consumers, not redesigned files.
- `subagent/test/task-notification.test.ts`; affected executor tests `default-parent-writer`, `admitted-input`, `service-completion`, `event-driven-steering`, `input-promotion-generation`, `retained-batch-continuation`.

**Interfaces consumed:** Task1 ports/fold/key/groups; existing `receivedInputsFor(owner)`, TaskRegistry.retainResult/qualifyRestoredResults, createSpawnSource, createSessionExecutor.runAdmitted and service submit's admittedInputId.

**Interfaces produced:** spec§5 RecipientDelivery with prepareLaunch/admit/requestClose/settle; optional ParentInputAdmission.prepareTaskDelivery/admitTaskDelivery; actual SubagentHandle.drainParentNotifications; SessionService.awaitDeliveryStop. `createSpawnSource.start` accepts optional launch binding. All are host composition surfaces, never tool/RPC DTO fields.

- [ ] **Step 1: Build decisive real-service fixture on unmodified baseline and record causal REDs.** Follow existing `retained-batch-continuation.test.ts` setup: actual createContextOutputService, createJsonlBackend, lock-enabled coordinator, createDurableSessionLoader and createSessionService with controlled parent/child clients and plugin role. Parent ModelClient emits real spawn_agent; child gate controls completion. Do not call registry.submit/terminalize or inject a fake parentNotify in the decisive fixture. Expose only these helper methods from the test module:

```ts
interface DeliveryFixture {
  service: SessionService;
  backend: ReturnType<typeof createJsonlBackend>;
  coordinator: ReturnType<typeof createSessionCoordinator>;
  parentRequests: LLMRequest[];
  launchCount(): number;
  start(): Promise<void>; // actual service.submit('parent',...,signal), parent turn ends
  releaseChild(): void;
  waitForDeliveryRequest(): Promise<void>; // controlled provider latch, not product poll
  reopen(): Promise<void>; // closes original owners before replacement coordinator/service
  close(): Promise<void>; // finally releases held gates and closes every acquired owner
}
```

Use counters based on real child stream entry/producer, actual managed journal facts and parent request messages. Returning a controllable promise from provider/backend is allowed; replacing Inbox, lane or notification consumer is not.

```ts
it('keeps an old eligible child across an ordinary followup', async () => {
  const f = await createDeliveryFixture();
  try {
    await f.start();
    await f.service.submit('parent','new human followup',new AbortController().signal);
    f.releaseChild();
    await f.waitForDeliveryRequest();
    expect(f.launchCount()).toBe(1);
    const events = (await f.backend.read('parent')).events;
    const receipts = events.filter(e => e.type === 'agent/delivery-received');
    expect(receipts).toHaveLength(1);
    const id = receipts[0]!.inputId;
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId === id)).toHaveLength(1);
    expect(f.parentRequests.some(r => JSON.stringify(r.messages).includes('original child result'))).toBe(true);
  } finally { await f.close(); }
});
```

Actual baseline RED expectations: cold ordinary outbox is attempted before publication and never retried by team-only hook; Stop then genuine human submit clears cancelledParents and an older child can pass the late notification gate; holding parent subagent/end after retention may let old notification admission start early. Capture facts proving which trigger happened. Baseline may pass a simple idle-child case; do not label that a defect or forge a RED. Equality/presentation defect gets a targeted real recipient adapter test with two genuine committed source witnesses plus equal supplied presentation, while the real-source oracle verifies the default source rendering separately.

- [ ] **Step 2: Implement the one original-capture receiver adapter.** Extend receivedInputsFor(owner,recipientSessionId?)'s cached exact-owner object with delivery; share its existing registered ReceivedInputSource rather than registering a competing input source. Managed recipient id comes from source.owner.sessionId with supplied-id equality checked; memory binds its first actual host id and rejects rebinding. openExecutorDocument passes existing options.sessionId. Do not begin an optional action merely to obtain identity during Stop/recovery. prepareLaunch returns DeliveryLaunchPreparation: bound joins/reuses a valid generation; unavailable/no-own-human-origin is a validated no-write capability outcome before any capture, preserving the normal unbound spawn. Current close debt, cancelled scope, invalid/conflicting state or any failed/issued-unknown trusted open propagates as a genuine failure; do not catch it as unavailable. admit reads actual source/end and builds typed-key id; existing receipt returns original disposition. New capture freezes first presentation. Preserve captured handle for unknown/conflict/install failure; settle calls observe/reconcile, uses retryAbsent only after proven absence and explicit same-source request, and never recaptures output. Classify blocked conflict distinctly from retryable original unknown. requestClose installs live fence synchronously, captures one required close and starts an attempt; subsequent attempts retry the same handle after rejection. Close acknowledgment requires committed seq, not successful observation text.

```ts
// Required decision order inside the host adapter, before any new capture.
await settleOriginalCloses();
const original = lookupCommittedReceipt(view, evidence);
if (original) return receiptFromFold(original);
const source = requireQualifiedSourceAndTerminal(view, evidence);
assertExactLiveOwnerAndOpenGeneration(source);
const inputId = deliveryInputId(source.key);
const captured = inputSource.captureDeliveryAdmission(
  {type:'agent/delivery-received',version:1,key:source.key,
   sourceSeq:evidence.sourceSeq,terminalSeq:evidence.terminalSeq,inputId},
  makeOriginalAdmittedInput(inputId,presentation),
  () => exactOwnerCurrent() && eligibleSourceNow(source));
// Retain captured before await; outcome→committed receipt or original recovery error.
```

The local helper names in this block are private functions implemented in recipient-delivery.ts, not additional exported APIs. They respectively read the scalar fold, validate actual events/ref/outcome/readiness, construct the exact spec producer/intent/display input and guard exact owner/generation; none performs source IO, model calls or TaskDoc mutation.

- [ ] **Step 3: Bind source before launch and signal only original terminal commitment.** Add to SubagentToolDeps the exact optional members parentNotify?:ParentInputAdmission, notificationNamespace?:string and onTaskTerminalCommitted?:()=>void; registerSubagent supplies actual stateId and a callback dirtying its original notifDrain. Extend createSpawnSource with optional fifth onTerminalCommitted callback and its start with optional binding. For background ordinary actual callSeq and this mount's exact exec.session/sessionId, prepare launch; bound uses grouped source.start, unavailable uses original source.start without a binding, then existing spawnChild once. Missing adapter, legitimate delegated/synthetic/unknown parent without own-human origin, and legitimate custom-role child sharing a root-bound tool closure cannot be converted into new tool failures or relabeled root bindings. Existing role/depth/source gates still apply. Do not invent inherited delivery generation/shared approval allowance or retrospectively bind the unbound task after a later human input. Foreground/nested code/ownerless uncertified paths retain their existing result/read behavior with no D1a auto-delivery. Genuine trusted open/start failure still prevents launch. Preserve terminalize/retainResult, and signal once only from existing settleTerminal when both original terminalSaved and taskSaved are true, including reconciliation. Early terminalized hooks may dirty but cannot admit while terminal proof is absent; no second terminalization or new task-document field. Current task snapshot/version stays unchanged.
- [ ] **Step 4: Replace ordinary drain's admission contract without changing team generic admission.** With new optional adapter available, ordinary notifications resolve actual source/end evidence and await admitTaskDelivery. No generic fallback. Pending→delivered follows receipt; claimed is already consumed; cancelled/suppressed remain suppressed; source woken is only scheduling evidence. Without adapter or binding leave row/result pending/readable, do not call old generic admit or mark delivered. Serialize the single ordinary drain in both shipping and legacy branches; all terminal/restore/activation signals use the same dirty loop. Existing `ParentInputAdmission.admit/wake` remains for team.
- [ ] **Step 5: Move ordinary activation to exact publication.** subagent.ready performs mirrors/task restore/qualification/classification but no ordinary admission. Add SubagentHandle.drainParentNotifications over its existing drain. assembly.drainParentNotifications joins it plus existing teamHandles. During service construction install receiver subscriptions before first reconciliation; after assemblies+lanes+hooks are published, activate and await source reconciliation only, never await a newly scheduled model turn from getOrCreate. Completion during await sets dirty. Exact owner checks before/after await prevent a failed/disposed owner from scheduling through a replacement assembly.
- [ ] **Step 6: Implement receiver scheduling over committed eligible Inbox ids.** New private delivery-drain.ts owns dirty/running/one timer, not an Agent. For each pending eligible receipt id, call current service scheduling entry with admittedInputId. Recheck current exact owner and pending at lane execution. If active step already claimed it, treat the scheduled hint as consumed/no-op; catch only that proven disposition, never blanket swallow provider/admission errors. Delete only derived scheduling cache after completion; read receipts on recovery regardless of source woken. Implement spec§6 DeliveryDrainDisposition exactly: settled/waiting-source/retryable/blocked/suppressed. Only positively classified same-original unknown/known installation recovery or actual owner-classified temporary admission arms100/500/2000/5000ms retry. Conflict/invalid/unsupported/retired/out-of-scope/unclassified gets zero automatic timers, with original debt/diagnostics retained. Absent requires explicit same-source retryAbsent. Generic FACT_RECOVERY_REQUIRED/exception alone is not retry classification. An actual source/receiver change may cause one new same-authority reconciliation and reclassification, never a self-dirtying blocked loop. Logical suppression does not discharge an issued batch/cleanup debt. No timer after healthy success/retirement, and no arbitrary live-invocation/source/model replay.

```ts
// The receiver's wake path schedules an existing id, never submits new input text.
for (const item of currentEligiblePending()) {
  if (!isExactPublishedOwner() || !stillPendingAndEligible(item.inputId)) continue;
  await scheduleExistingInput(item.inputId); // schedules, does not await turn inside mount
}
// Subsequent delivery facts during awaits set dirty; one current drain loops again.
```

scheduleExistingInput is private to the service composition and returns after registration on its existing pacing/lane, with turn rejection owned by the existing service error path. It must not return the whole model turn to getOrCreate, which would self-wait on its own creation promise.

- [ ] **Step 7: Add request-vs-durable Stop API and submit barrier.** cancelRunning requests delivery close before model abort even for live idle parent; keep cancelled as current-action result. Store exact last live request/fence id; awaitDeliveryStop attempts/join-reconciles its original capture and returns receipt or undefined if none requested. Before service starts a new human submit, join original delivery close debt, then existing runtime-context/finished-action settlement. A synchronous requested Stop is never called durable until acknowledgment. Separate disposal revocation from user-stop closure in close/closeSession/setup failure; existing native/child resource drains remain original owners.
- [ ] **Step 8: Execute connected GREEN and targeted regressions.** Run from session-executor: `pnpm exec vitest run test/delivery-receiver.test.ts test/delivery-recovery.test.ts test/admitted-input.test.ts test/default-parent-writer.test.ts test/input-promotion-generation.test.ts --maxWorkers=2 --minWorkers=1`. From subagent run task-notification plus affected spawn/source tests selected by actual changed files. Actual idle completion/followup/Stop/publication/held-terminal controls must each show one original producer, exact retained bytes/revision, admitted/claimed counts and real next request. Add valid delegated/B2/unknown/synthetic-origin parent controls: otherwise accepted spawn succeeds and original result retrieval succeeds, preparation says unavailable and no D1a wake/binding is created; a held/failed trusted generation-open instead rejects launch with its original debt retained. Preserve existing approved child creation boundaries; do not add new recursive tools or fix shared-mount depth semantics in these controls. New API typechecks: core-agent, subagent, session-executor; preserve unaffected team completion behavior in agent-team/test/completion-delivery.test.ts.
- [ ] **Step 9: Review checkpoint and scoped commit.** Review complete source/service changed range and explicit task-document nonchanges, then commit `feat: connect ordinary child delivery to managed receiver lane`. Do not claim D1a acceptance until Task3's crash/lifetime/compatibility controls close on this same source. No scope expansion into public F1, child ID, ContextOutput or UI.

## Task 3: Close physical crash, Stop/rewind/seed and lifecycle qualification

**Files — create:**

- `packages/session-executor/test/delivery-lifecycle.test.ts`, `test/helpers/delivery-crash.mts`.
- `packages/core-session/test/delivery-seed-boundaries.test.ts`.

**Files — modify:**

- `session-executor/src/lifecycle/rewind-facts.ts` to request/confirm delivery close before restore callback; keep original rewind marker source unchanged.
- Task2 delivery tests/helpers and JSONL delivery/predecessor tests for actual process-cut matrices.
- Existing affected regressions: `session-executor/test/{rewind,event-driven-steering,retained-batch-continuation,code-mode-children-close-boundary,received-cancellation-close,service-instruction-close}.test.ts`; existing `core-agent/test/retained-batch-continuation.test.ts`; current team completion gate. Product fixes only for concrete failed D1a obligations, followed by affected retest/review.

**Interfaces consumed/produced:** no new production DTO/port. Consumes `RecipientDelivery.requestClose('rewind')`, `awaitDeliveryStop`, existing withRewindFacts callback, original BatchKey/capture handles and actual journal/body readers. Produces only scoped qualification evidence and necessary corrections within frozen D1a owners.

- [ ] **Step 1: Write Stop and rewind failing assertions before helper changes.** Hold parent delivery admission/promotion preparation and call actual cancelRunning; synchronous pending eligibility must disappear immediately. Its durable wait stays unresolved or rejects while close batch is unknown; no successful receipt until original close reconciles. For withRewindFacts, make close append fail before restore; assert restoreCalls0. Release original close and invoke the actual explicit retry path; restoration executes once, marker reconciliation never reruns it.

```ts
it('confirms delivery fence before any rewind restoration effect', async () => {
  const f = await createDeliveryFixture();
  try {
    await f.start();
    const owner = await f.coordinator.openManagedDocument('parent');
    let effects = 0;
    // holdDeliveryClose gates real backend append, never replaces received-source methods.
    const held = holdDeliveryClose(f.backend);
    const rewinding = withRewindFacts(owner, async record => {
      effects++;
      await record({type:'rewind/point',version:1,targetTurn:0,anchorSeq:0,
        mode:'conversation',fileOps:[]});
    });
    await held.entered;
    expect(effects).toBe(0);
    held.release();
    await rewinding;
    expect(effects).toBe(1);
  } finally { await f.close(); }
});
```

The controlled backend helper returns `{entered:Promise<void>,release():void}` and only gates decoded matching close frames. For actual full rewind integration reuse the existing RewindService fixture and fingerprint checks, not this small callback example alone.

- [ ] **Step 2: Implement the narrow rewind precondition.** In withRewindFacts, acquire the same cached received adapter and await requestClose('rewind').settled before creating/invoking any restoration callback. If source acquisition/close fails, perform no new file effects. Preserve original error primary/cleanup aggregation, action.finish/source.close and original marker retention. Replay of rewind/point fences history even when reading older logs without explicit new close; consumption records remain consumed. Existing gateway caller already routes through this helper and needs only its actual contract regression.
- [ ] **Step 3: Run actual physical cuts independently, with terminal-proof cuts separated.** delivery-crash.mts uses a child Node process and the real backend, exits at causally confirmed cuts, and returns source ids/revision/batch keys plus raw journal bytes to the parent test. First prove the positive cut: original result bytes durable **and original subagent/end committed**, before receiver receipt; cold actual journal/source qualification then drives the same existing post-publication drain once. Separately physically land original end and return unknown: live same-capture reconciliation must call onTerminalCommitted and dirty that same drain; cold success requires the actual complete original frame/current committed-prefix recovery to establish the proof, never a reconstructed handle or TaskDoc-derived end append.

For the separate negative cut, persist original result bytes/ref but gate subagent/end **before issuance**, then terminate so its in-memory terminal capture/prepareEnd closure is lost. Current TaskDoc does not persist that source authority; unqualifyRestoredTask/qualifyTaskPublication(taskId) and classifyRestoredTasks' unqualified skip must remain effective. Assert no receiver receipt, no automatic parent request, no new result revision and no producer replay. Read original retained bytes only if the existing independently authorized reader allows them; otherwise assert its recovery-required/unavailable outcome and preserve saved diagnostics. A job/status-only record or completed child text is not a replacement taskId end witness. This negative is honest blocked recovery, not a cold-completion success. Add torn/absent/conflicted-end negatives under the same proof rule. Broader failure-delivery across unrecoverable missing terminal publication remains Task5 work, not silently closed by this packet.

Then cover receiver receipt landed/unknown response, receipt before source ack, source woken before hint, hint before claim, claim landed/unknown response, close requested-before-issue, close issued-unknown and close confirmed. Restart actual coordinator/service and run post-publication reconciliation without another child run/human input **for cuts with established original terminal proof**. Distinguish close-before-issuance limitation from confirmed durability; preserve original source outcome and exact BatchKey. Source execution count/admitted count/claim count are separate assertions; wake count can exceed1.
- [ ] **Step 4: Cover generation transitions and one live owner.** Run Stop while idle background child, Stop during retention/admission/claim, committed claim wins before Stop, new human turn, normal followup, human steer, cancelTask/tree, service close/reopen, failed extension mount and callback after replacement. For replacement test keep reference to old exact assembly callback while new assembly exists; old callback produces no admission/request. Force one disposer failure and prove others attempted and original cleanup debt retriable. Verify one backoff timer only for known original unknown/temporary cases; zero for structural invalid/conflict/unsupported/retired/out-of-scope/unclassified, with debt retained. A real same-authority state change may permit one original reconciliation; blocked state cannot poll itself every5s. Confirm logical suppression leaves physical/cleanup debt unresolved until original owner settlement, and no failed/claimed input is sent again. Replay the same consumed action succeeds, second admitted/raw-alias action fails, and active steer adds no B-owned action.
- [ ] **Step 5: Qualify identity, legacy and seed boundaries.** Two real source witnesses/equal presentation yield two keys; same witness/rerender returns original input bytes and one claim. Wrong recipient/namespace/task/terminal/revision/generation, forged producer/system text, inherited binding/receipt and split physical pair refuse. Completed genuine12 task result remains readable via actual get_task_output/retained page with original ref bytes, with zero automatic delivery request and no new TaskDoc trust fields. Existing team legacy delivery test still passes. Compaction before/after claim cannot resurrect consumed input; rewind fences old sources; semantic fork target has no imported operational delivery facts/eligibility. Preserve source fork session authority unchanged.
- [ ] **Step 6: Reuse accepted continuation and native/resource controls.** Run actual retained-batch continuation and its close qualification unchanged, plus affected human event-driven-steering tests: original task/input/action/result revision/error metadata stay exact, producer executes once, ready outcome never replays and foreground/nested observation remains quiet. Preserve N2/native artifact owners; no source-only test claims new backend support. If a platform/reader is unavailable, report exact limitation and keep gate open.
- [ ] **Step 7: Final scoped gate on fixed source.** Run new core/persistence/JSONL/subagent/service cases and affected regressions sequentially, then only affected package typechecks and required build/copy checks dictated by changed entry exports. Reuse unchanged passing evidence; repeat only after real source changes or unresolved failures. Bind commands/CWD/exits/source manifest/resource cleanup to one final candidate. Root runs fixed-version full verification/reachability/package gates later, not this worker. Inspect spec coverage table below and full BASE..HEAD; request independent root-assigned review without spawning agents here.
- [ ] **Step 8: Commit qualification/corrections and hand off.** Stage exact remaining task files and commit `test: qualify ordinary delivery crash and lifecycle boundaries`. Report precise commits, tests/failures, source identity, remaining public CLI/team/D3/D4/GUI/native gates and no release claim. Root reviews/promotes/integrates; do not independently merge or publish.

## Expected causal RED ledger, not claimed executions

| Baseline trigger | Evidence to capture on5b47573b/rebased dispatch baseline | Expected causal failure |
| --- | --- | --- |
| Ordinary cold outbox before assembly publication | Source row becomes error; assemblies/lane not yet published; no second source event | New parent idle request absent after publish because hook is team-only. |
| Old child after explicit Stop then human submit | Real cancelRunning request, cancelledParents later cleared, original child/result identity unchanged | Old generation has no durable fence/binding and may admit/wake. Hold unrelated current action so Stop is a genuine request. |
| Retained task ready while subagent/end append held | Actual task retention durable; original end batch still uncommitted; source callback/drain entered | Current adapter may admit before actual terminal publication. Preserve outcome even if scheduling prevents a particular run; do not assert timing without controlled latch. |
| Result bytes durable, end never issued, then process exits | Actual retained ref saved; backend gate proves zero terminal issuance; original live capture lost | Expected D1a negative is unqualified/recovery-required/readable-where-authorized with zero wake/replay, not repaired cold completion. Current taskId witness cannot invent subagent/end. |
| Same original evidence changed presentation | Actual qualified source/end; first receiver admission committed; second adapter call same source refs | Text-hash old adapter can remint admission. New API absence alone is setup RED, not behavior proof. |
| Received close/claim race | Actual write/preparation gate, current close returned only request acknowledgment | Missing durable generation/central eligibility permits stale admission/claim, or cold fence disappears. |
| Format13 required facts | Genuine predecessor12 graph and new actual13 file | Refusal must happen before repair/write; current-code version emulation is invalid evidence. |

Any baseline behavior that already passes is a positive control. Do not fabricate an old receipt/delivery schema to make a RED easy. Do not add a fake notification consumer or bypass real managed/Agent entry because a causal test is harder.

## Interface/scope coverage self-audit

| Spec obligation | Task/code/tests | Explicit exclusion or review focus |
| --- | --- | --- |
| Stable key and original terminal proof | Tasks1/2; events/fold/grouped source; held-end/equal-presentation controls | No new task/result revision/store or source IO in DTO. |
| Cold durable bytes without original terminal | Task3 separate before-issue process cut + real publication/reader assertions | Honest no-wake recovery-required; no TaskDoc-derived source certificate or broad failure-delivery claim. |
| Generation open/close + genuine human origin | Tasks1/2; managed capture/fold/live gate; Stop/followup controls | Finite action allowance unchanged; no ordinary-turn fencing. |
| Original action after consumption | Tasks1/3; lookupActionOrigin(open), exact grouped input-start vs steer and cross-alias uniqueness | Historical original action remains valid; pending eligibility cannot authorize a second action. |
| Delegated/synthetic parent without own human | Task2 bound/unavailable preparation + actual accepted spawn/read controls | No fabricated shared delivery generation and no new spawn failure from capability absence; C2/ID remains separate. |
| Atomic receipt/admission and active claim guard | Tasks1/2; frame validation/received capture/beforeIssue; unknown/active race | Claim is consumption even on later provider failure. |
| Request Stop vs durable ack | Tasks2/3; cancelRunning + awaitDeliveryStop + submit/close barrier | No new public wire acknowledgment; pre-issue crash limitation explicit. |
| Ordinary restore after publication | Task2; same SubagentHandle drain and exact service lane | Team generic admit preserved; no replacement-owner callback. |
| Old12 readable/no automatic wake | Tasks1/3; literal old bytes/result read and no binding | No automatic adoption or exhaustive unlabeled custom injection classification. |
| Format13/predecessor/birth | Task1 + actual Task3 cuts | Genuine12 header-only upgrade; original11/12 stages/phase bytes immutable. |
| Rewind/summary/fork | Tasks1/3; history/seed validator + real rewind helper | Source fork generation stays open; target imports no authority. |
| Cancellation/lifetime/original ready | Task3 + accepted real continuation gates | Native/artifact/ContextOutput ownership unchanged. |
| Timers | Task2 classifier/Task3 per-disposition timer controls | Only known retryable originals; blocked/suppressed scheduling cannot erase physical debt; no catch-all retry/source/model replay. |
| Subsequent public F1/ID | Integration reservation below | No public caller raw-clone changes or child instruction factory redesign. |

## Ratified reservations and execution order

1. B2 final independent review/integration is accepted at MAIN9453cf0e/productdd98e983. Start only on root's assigned integrated base. B2 owns accepted private stage/IO lifetime; do not cherry-pick an assumed subset or reset its exact original capture semantics. No wait on public F1 implementation is added.
2. HOST Store/service/index work remains separate and is never edited here. Root reserves executor service/assembly changes relative to current host composition. Default createContextOutputService is used unchanged in tests; unavailable index is not permission to fake retained result success.
3. C2/ID owns public child caller/instruction/lifetime cutover. Reserve `subagent/tools/spawn*.ts`, `subagent/index.ts` and executor assembly with that writer; this packet adds only delivery-generation launch binding and post-publication drain. F1 may need13 compatibility after this integration but retains its original invocation/readiness/capture rules.
4. Root has ratified the full13/event/frame/birth contract, both finite-action origin forms, request-only external Stop acknowledgment, the explicit bound/unavailable spawn capability and positive error-retry classifier. The explicit custom/unlabeled legacy limitation is kept in the review, while actual12 ordinary task metadata and unchanged team legacy are tested.
5. Initial promoted packet must expose a real reachable consumer: actual service→ordinary spawn source→managed receiver→Inbox/lane→next actual request. CLI/team/D3/D4/GUI follow-ons remain named open work, not unused API consumers added to improve reachability counts.

Plan self-review: all new port/type names match the sibling spec; tasks carry actual owner/file/test changes and failure expectations; source IO and authoritative result storage remain outside DTOs; no test/performance/compatibility success is claimed by this document. Execution mode is already assigned by root; no repeated execution-choice question is needed; only root-assigned review tasks may start.
