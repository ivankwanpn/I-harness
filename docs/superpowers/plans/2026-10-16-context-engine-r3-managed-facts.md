# ContextEngine R3 F1 — Managed Ordinary Facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Root controls dispatch and fresh GPT6.1Sol review; this draft authorizes neither implementation nor recursive agents.

**Status:** FUTURE DRAFT. Do not dispatch before reviewed R2D plus root executable preflight. Planning source is pinned **db63d12e2e291dbfcb90eac61668853044888278**; inspect with `git show <SHA>:<path>`. Cfix1 is a separate active validator correction. Rebase every listed API after reviewed D. Current pin is format4; D plans producer-witness format5, therefore F1 plans6 and F2 plans7. Changed ordering requires an explicit root amendment, never silent number reuse.

**Goal:** Give every shipped ordinary fact producer one asynchronous, durably atomic document owner and an immutable committed Session view, using actual returned seqs.

**Architecture:** Core-session owns captured data, typed group validation and the sole private event array/view. Persistence coordinator owns the existing operation/lease lane and exact same-file journal receipts; executor attaches its lifecycle and injects narrow producer ports. No replacement, attempt ledger or E policy cutover is included.

**Tech Stack:** Existing TypeScript, Node filesystem promises, SHA-256, pnpm/Vitest; no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-context-engine-{redesign,framework,r1-contracts}.md`; `.tmp/context-redesign-20261015/{r3-sequence-root-rulings,r3-f1-root-rulings,r3-f1-plan-edge-checks,r3-f1-final-preflight}.md`; prerequisite `2026-10-16-context-engine-r2-native-validation.md`. Normative asynchronous issuance wording supersedes older synchronous publication proposals.

## Global Constraints

- One product writer, fresh GPT6.1Sol review; existing checkout, product0.1.13-rc.1, original27/43 unchanged. No installed profile, credentials/account/provider/count, remote/merge/release, dependency changes or unrelated decomposition.
- Leaves normally150–400lines, functions<=120, facades150–250; cohesive exceptions require review. Preserve package public-entry dependency direction and existing test structure; no audit reseed, fake consumer or generic application-wide writer bag.
- Accepted response/authorization/dispatch durability precedes effects. Unknown outcomes never authorize replay. Existing transient display deltas remain transient.
- No per-append full-history clone, second raw log/store, synchronous filesystem getter or bounded-cold-memory claim. R4 cross-document delivery and R6 archive/checkpoint/paging/performance qualification remain separate.

## File and owner map

New leaves, exported only where actual consumers require them:

| Location | Responsibility |
|---|---|
| core-session `src/managed/{types,capture,groups,view}.ts` | Data-only receipts/readonly types; once-only legacy capture; typed reference resolution/staged validation; private array/view install capability. |
| core-session `src/serialization/fact-journal.ts` | Pure format6 framing codec/digest inputs, shared by direct serializer and backend; no fs/auth/execution imports. |
| persistence `src/coordinator/managed-document.ts` | One document lifecycle/queue/seq/receipt state, using existing ownership and validation index; no second raw history. |
| JSONL `src/backend/{fact-journal,format-upgrade,session-io}.ts` | Sole complete-write/sync/reconcile and streaming header replacement; extract existing corresponding responsibility first where equivalent. |
| executor `src/lifecycle/managed-document.ts`, `src/service/input-admission.ts` | Attachment/composition and existing input owner extraction; preserve service Maps. |

Modify core-session events/state/append/types/index, Inbox, serialization/readers; persistence coordinator types/mutations/load/lifecycle/ownership/conversation-index/writable-format, format registry/validation/repair/fork/seed; JSONL index/format. Consumer files and retirement are listed in Step7. Existing S2/S9/S11/S17/S18/S19 are regression gates; S20 and CX1 remain partial unless their complete original responsibility gates independently pass. S22/S23/SDK carrier changes do not complete those decompositions.

### Task 1: Activate the ordinary managed document and all actual producers

**Consumes:** reviewed D format/native witness contracts, B2 acceptance attribution, R1C capture/freshness, existing coordinator operation gate/lease and core-session incremental validation.

**Produces:** `openManagedDocument`, internal `admitGroup/reconcile/drain/close`, immutable `SessionView`, actual typed seq receipts and producer-specific ports. Only this connected task may activate managed mode; internal intermediate commits are not shipping/completion gates.

- [ ] **Step1: Rebase contracts and capture baseline evidence.**

Record BASE and actual D report/schema names. Verify pin findings remain: `events/append.ts:54–66` installs before hook; loader `durable-session.ts:19–29` mirrors/pushes; backend `index.ts:123–147` returns void, ignores bytesWritten and suppresses rollback failures; coordinator `conversation-index.ts:20–30` overlap equality is not fsync evidence; ownership `:4–15,35–51` has optional locking. Refuse managed activation if an exclusive-owner capability cannot be established. Reuse unchanged B2/C/D receipts; characterize affected old behavior only where no applicable receipt exists.

- [ ] **Step2: Freeze narrow contracts before implementation.**

```ts
type SessionView = DeepReadonly<Session>;
type SeqRef<K extends SessionEvent['type']> =
  | {kind:'prior'; seq:number; expectedType:K}
  | {kind:'group'; position:number; expectedType:K};
type OwnerToken = {sessionId:string; incarnation:string};
type BatchKey = {batchId:string; firstSeq:number; count:number;
  previousPrefixDigest:string; batchDigest:string};
type FactReceipt = {owner:OwnerToken; key:BatchKey;
  lastSeq:number; prefixDigest:string};
type FactOutcome =
  | {kind:'committed'; receipt:FactReceipt; seqs:readonly number[]}
  | {kind:'absent'; key:BatchKey}
  | {kind:'unknown'|'conflict'; key:BatchKey}
  | {kind:'not-issued'; code:FactCode}
  | {kind:'recovery-required'; code:'FACT_INSTALL_FAILED'; receipt:FactReceipt};
type FactCode = 'FACT_CLOSED'|'FACT_CANCELLED'|'FACT_INVALID_GROUP'|
 'FACT_CAPTURE_FAILED'|'FACT_OWNER_UNSUPPORTED'|'FACT_QUEUE_FULL';
```

Define `DeepReadonly` recursively over JSON data; opaque branded captured groups cannot be constructed by plugins. `captureLegacyFact` returns owned data or FACT_CAPTURE_FAILED, retaining the original at its source. Capture existing `stringifyJsonData` behavior exactly once outside the writer lane, parse/validate/freeze the resulting data; deep plain JSON retains its stack-safe encoder. Class/toJSON/accessor code may run during this explicit legacy lowering, never during hash/install/reconcile. Strict receipt/context/native DTOs use strict data-only validators instead.

Define `CapturedFactGroup` as a closed tagged union: input-admission; input-start (promotion+turn/start+message); steer-claim (promotion+message); exchange-acceptance (assistant+accepted); tool/code call/dispatch/result; lifecycle; and existing metadata/legacy-compaction families. Extend existing DTOs with SeqRef **only** in acceptance assistantSeq/callSeqs/stepStartSeq, dispatch eventSeq and usage acceptedSeq structural slots. Prior refs require exact committed type/source; group refs require earlier compatible positions. Resolve those fields explicitly, never traverse user args/output searching for magic `$ref`. For example, exchange-acceptance carries `{assistant:AssistantDraft, accepted:AcceptedDraft}`; AcceptedDraft replaces only assistantSeq with `SeqRef<'assistant/message'>`, callSeqs with readonly `SeqRef<'tool/call'>[]`, and stepStartSeq with a prior-only `SeqRef<'step/start'>`. AssistantDraft is the existing assistant event without seq; AcceptedDraft otherwise preserves the reviewed versioned acceptance union. Use distributive omission for that union so version-specific witness/attribution fields remain required. All other references retain validated committed coordinates. Check duplicate input IDs/current pending state inside the owner operation, not just before await.

Internal `admitGroup(group):Promise<FactOutcome>`, `reconcile(key):Promise<FactOutcome>`, `drain():Promise<void>`, `close():Promise<void>` are coordinator-owned. Expose executor-injected InputFacts, AgentFacts, ToolFacts, CodeFacts, DeliveryFacts and MetadataFacts with only their permitted group constructors; subagent/job/tool payloads cannot mint acceptance or human-origin authority. `openManagedDocument(sessionId)` returns view and composition capabilities after fenced recovery; owner token is not B2 observationLifetime/sendId or ownerOf:boolean. Inject synchronous `assertOpenFor(actionFence)` into existing immediate model/tool/wake guards; it checks the actual held ownership capability, current incarnation, quarantine and the action Stop latch. Settlement uses a source-owned capability, not a payload flag granting permission. New explicit human input obtains a fresh fence through the existing input owner; this is lifecycle fencing, not F4 attempt reservation.

- [ ] **Step3: Write meaningful literal RED fixtures and verify failure.**

Create `core-session/test/managed-session-view.test.ts`, persistence `test/managed-fact-batch.test.ts`, JSONL `test/fact-batch-journal.test.ts`. Extend actual consumer suites in Step9. Example fixture shape (local fixture helpers belong to those files):

```ts
it('returns actual seqs and keeps a group atomic', async () => {
  const owner = await managedFixture({nextSeq:7});
  const [a,b] = await Promise.all([
    owner.admitInputStart('input-A','hello'),
    owner.admitMetadata({type:'plan/mode',mode:'on'}),
  ]);
  expect(a.seqs).toEqual([7,8,9]);
  expect(b.seqs).toEqual([10]);
});
it('does not replay a settled effect after unknown persistence', async () => {
  const f = await toolFixture({resultSync:'unknown'});
  await f.run(); await f.reconcile();
  expect([f.dispatches,f.finalizes,f.results]).toEqual([1,1,1]);
});
```

Run each new file individually using `pnpm --filter @i-harness/<package> test -- test/<file>.test.ts --maxWorkers=2 --minWorkers=1`. First RED must fail on the missing invariant/API, not malformed unrelated native fixtures. Hard-code independent expected seqs/order, not implementation-generated receipts.

Add independent cases: invalid/out-of-group refs issue zero bytes; user args containing `$ref` remain literal; partial input-start/acceptance frame yields zero embedded events and input stays pending. Acceptance refs/native witness/usage attribution match actual committed records. Subscriber throw and async rejection leave committed success; a subscriber awaiting recursive append completes with next seq10, without deadlock or duplicate admission.

- [ ] **Step4: Extract only equivalent structure, then implement the format6 journal.**

Commit equivalent extraction separately after characterization passes. Do not call new framing/ownership behavior an equivalent move. No dormant public factory/export is retained for tests alone.

Fix encoding literally: one canonical JSON envelope plus **LF byte0A**, UTF-8/no BOM. `core={batchId,firstSeq,count,previousPrefixDigest,events}`; `C=UTF8(canonicalJsonData(core))`; `batchDigest=SHA256(UTF8('ih.fact-batch.v1\0') || C)`; `prefixDigest=SHA256(UTF8('ih.fact-prefix.v1\0') || hexDecode(previousPrefixDigest) || hexDecode(batchDigest))`. Envelope is canonical JSON of `{recordKind:'session/fact-batch',version:1,...core,batchDigest,prefixDigest}`. count counts events; firstSeq/lastSeq count semantic events; offsets/lengths count bytes. IDs are bounded nonempty ASCII<=256; counts safe nonnegative integers, count>0, digests64lowercasehex; reject overflow. Envelope wrappers have no semantic seq. Require terminating LF, exact count, contiguous seq, both digests and full group/history validation; never activate a first embedded event independently.

Header6 adds strict `journal:{version:1,legacyBodyBytes,legacyEventCount,legacyPrefixDigest,separatorBytes:0|1}`. `P0=SHA256(UTF8('ih.fact-legacy.v1\0') || uint64BE(legacyEventCount) || exactLegacyBodyBytes)`; new files use empty body/count0. Preserve valid legacy raw body bytes including CRLF/non-ASCII. If final legacy byte is not LF, preserve it and add one separator LF outside legacyBodyBytes; journal starts at body-relative offset `legacyBodyBytes+separatorBytes`. Header itself is excluded. No bare event after this boundary is accepted.

Under existing owned gate, finish required legacy recovery before migration; stream-copy header+unchanged body into same-directory temp, sync, rename, and apply current platform-qualified directory-sync semantics. Physical streaming copy is one-time migration, never ordinary append. Preserve journal metadata/raw frames through profile/updateMeta/export/fork/repair; direct core-session serializers use the same codec. Future repairs append owned groups or use an explicitly fenced recovery operation, never flatten framed history into individually committed events. Old runtime5 rejects6 before repair/write; future runtime6 rejects7. Legacy1–5 remain readable with D witness validation preserved. Unsupported upgrade/backend refuses before model/effect work.

- [ ] **Step5: Implement the sole writer receipt/uncertainty lifecycle.**

Add backend-owned `appendOwnedBatch(expectedPrefix,encoded):Promise<FactOutcome>` and `reconcileOwnedBatch(key)`; no generic void append fallback. Loop bytesWritten until complete; zero progress fails. Sync before committed receipt. Proven absence after partial write requires exact prior boundary, successful truncate **and sync** under exclusivity. Write/close/rollback failure is unknown unless exact disposition is established. Ordinary equality-on-read cannot mint a live receipt.

Owner transitions `open→collecting→issued→committed/installed`, or `issued→quarantined→committed|absent|conflict`. Allocate once and stage exact group before issue; hold only the allocation/storage lane across that exact write/reconcile, never model/summary/tool/background waits. Unknown blocks allocation and new model/effect/wake continuation. A definitely successful complete sync establishes commitment even if subsequent close/observer cleanup fails: return the exact receipt and report cleanup separately, never truncate that known commit. Before first write issuance, verified no-write failure is absent; after partial write, only successful rollback+sync proves absence. Matching complete issued frame may be synced/reconciled after Stop; torn frame may be truncated/synced to prove absence; conflict stays quarantined. Install exact committed group and index in one nonyielding turn. A known durable commit followed by install failure stays committed-but-uninstalled/quarantined and returns FACT_INSTALL_FAILED with its receipt; reconcile installs that exact batch, never re-appends it. When coalescing groups, every caller gets only its own seqs plus the shared physical receipt; resolve/install/reconcile the whole frame atomically. Do not resend through write-behind/flush/close; original producer keeps its stable group/key until resolved. Cold owned recovery validates complete frames and establishes recovery durability before hydration/allocation. Unfenced read during active unknown returns unavailable/read-only observation.

Stop revokes the **old action fence** synchronously; required already-real input/result/usage/lifecycle facts settle. Later explicit human input creates a fresh authorized action; no permanent stopped-session boolean. Receipt permits no new transport/wake/effect without its existing owner rechecking current fence. Close revokes admissions, joins source drains, settles/reports recovery-required, releases ownership last. Async fsync may stall; responsiveness is not a bounded filesystem-latency promise.

Root queue ruling2026-10-16: use `maxPendingGroups=64` as a named local scheduling default, not a provider or result-size limit. Do not carry the old200ms nonblocking write-behind debounce into every awaited fact admission. Coalesce already-ready groups at a microtask boundary or immediately after the current write, preserving FIFO/atomic groups; a lone group proceeds without an artificial200ms delay. Use a262144-byte coalescing target, with one oversized atomic group admitted alone rather than truncated/rejected. These are performance targets, not a bound on one real result's size. Capacity wait is event-driven/cancellable for unissued optional work; required source-owned settlement retains its fact and waits or reports explicit recovery-required, never drops it or busy-polls. Close/quarantine wakes waiters with the correct disposition; a queue-full retry cannot replay an effect. Fix option validation and capacity-ticket semantics in root preflight; do not add an unrelated settings UI.

- [ ] **Step6: Implement immutable view and observation release.**

Retain one private append-only array plus index; detach once on hydration/intake. Return a readonly array facade; apply read methods with the **facade receiver**, never bind raw-array methods. map/forEach callbacks' third argument must be the facade. Descriptor values, iterator results/entries, slice/spread, header, nested objects and previous hydration aliases cannot reveal mutable backing data. Reflective mutation/prototype changes reject. Readers accept readonly types, without unsafe casts back to Session.

Commit/install and release allocation lane **before invoking observers**. Track observer promises through existing observation diagnostics outside that lane; recursive append must obtain the next actual seq. Observer errors are diagnosed once and cannot reject a committed admission or cause an unhandled rejection. Lifecycle drain must not wait for an observer while holding the lane that observer needs. No synchronous storage lazy getters/full-history clones.

- [ ] **Step7: Activate every real producer/carrier together.**

Use pinned preflight inventory, rechecked after D:

| Existing paths | Required activation/retirement |
|---|---|
| core-agent `agent/{exchange,model-loop,model-step,step-input,turn,finalization,reasoning,budget,recovery}.ts` | Await fact admission in stream accept/discard/settle/finally; actual call/step/accepted seqs. Atomic assistant+acceptance; returned event/receipt replaces array-slot probing. Reasoning clears after receipt. Pure budget reads remain I/O-free; sync send-guard retirement hands off to awaited rebuild. |
| core-session Inbox; core-agent executor; executor service/input-admission | Async admit/cancel/claim. Move separate executor promotion into atomic agent input-start. Stable service-front ID is not durable admission; cancellation success waits for receipt. |
| core-agent `tool-batch/{prepare,dispatch,record,cancel,join}` | Dispatch receipt before body. Retain finalized real slot through unknown; advance committed cursor after receipt. Fix documented unrecorded-settled-slot limitation; no second finalize/post-tool or fake synthetic overwrite. |
| executor durable-session/assembly/service; CLI run; subagent child/index/child-assembly | One open/attach factory for fresh/resume/metadata/child/seed. Retire hook mirrors, direct events.push, caller-owned flush escape and detached turn/end flush. Seed commits before inherited publication/Agent. |
| subagent tools spawn/followup/persist; team scheduler/task-delivery/transact | Await start/end/inbox/status. Existing persistence owner retains synchronous job-observer facts and exposes joined drain; failures retain them. Publish team folded state after receipt; unknown never reruns transaction. Preserve explicit partial cross-document disposition. |
| Code Mode broker/register/runtime callbacks | Actual call seq before enqueue; dispatch receipt before body; set recorded only after result commitment. Retain finalized output; join started/output/closed/store producer promises and startup interruption facts. |
| runtime-context, plan-mode, todo, schedule/tools, guard-repeat-tool, session-title, executor/context-output | Narrow injected ports and awaited hooks/tools. Retained state follows receipt; plan+proposal and schedule dispatch+admission atomic. Title/artifact sidecars do not become second fact authorities. |
| gateway rewind/work-state/workflow; SDK server; CLI input handlers | Cold controls resolve owned document, retire seq=events.length/backend append bypass. Await mutations before notifications/success; Stop fence stays immediate. |
| compaction engine/commit and projection/window | Existing prune/summary/reset use ordinary atomic groups; preserve named legacy selection/target limitations until F3. No replacement production/readiness or new assessor. |

Standalone mutable createSession/append and synchronous Inbox remain explicit nondurable APIs; provide an explicitly nondurable async adapter for shared Agent code. Managed instances reject synchronous append. Shipping custom session/sessionFor requires actual owned capability or explicit detached import, never Promise-or-void mode-dependent append.

- [ ] **Step8: Run crash/effect/escape controls to GREEN.**

Test short writes3+2+remaining; zero progress; fsync/close failure; successful and failed truncate/sync; complete unsynced frame visible to a bare reader; matching/absent/conflicting reconcile. Crash cuts: before issue, partial envelope, complete envelope before sync, after sync before receipt/install, dispatch before body, body complete before result admission. Assert one batch, zero partial promotion, dispatch/finalize counters1, Stop produces zero subsequent model/wake, late settlement survives, fresh later human action works. Legacy class/getter/toJSON executes once across failed write/reconcile; throwing/cyclic serialization retains real source outcome and recovery-required. CRLF/Chinese/escaped-newline literals keep exact body bytes/digests. Test descriptor/callback/iterator escape and awaited recursive observer with a finite test timeout.

- [ ] **Step9: Verify consumers, structure and packaged wiring; request fresh review.**

Run sequentially maxWorkers2/minWorkers1: core-session full; persistence full; JSONL full. Core-agent actual `accepted-exchange,executor,executor-failure,step-inputs,execute-tool-calls,batch-isolation,finalize-cancellation,reasoning-streaming`; executor `default-parent-writer,admitted-input,schedule-delivery,service,cold-state-inspection`; Code Mode `broker,register,store,human-stop`; subagent `child,resume,fork-isolation`; team `transact,child-sequence`; gateway `prepared-session-writer,rewind-host,workflow`; CLI `input-tiers`; affected title/runtime-context/plan/todo/schedule suites. Use `pnpm --filter @i-harness/<actual-package> test -- test/<name>.test.ts --maxWorkers=2 --minWorkers=1`; verify names after rebase. Preserve D witness and six-route corpus controls.

Typecheck changed packages/all actual consumers and e2e; run `pnpm verify:reachability` without reseed. Fresh isolated Gateway/CLI packaging smoke must exercise format6 reopen, child/input/dispatch receipts and old-runtime refusal with fake transports. Record append latency/queue delay, throughput and peak memory on nonprivate large-result/100MiB fixtures; no R6 bounded-cold-memory claim. Commit behavior only after actual consumers/gates pass; fresh full-range GPT6.1Sol functional+structural review gates progression. Report BASE/HEAD, exact retired paths, public ports, source-held unresolved facts, format evidence, test receipts/failed intermediates, performance and unchanged qualification/counts.

**Remaining root preflight decisions:** confirm reviewed D actually consumes5 and therefore6/7 placement; rebase exact producer APIs, capacity-ticket semantics and actual commands/gates. Queue64/microtask coalescing/262144-byte target, receipt-before-install, once-only legacy lowering and same-log framing are root design rulings, not new permission questions. No execution choice or dispatch is requested by this future draft.
