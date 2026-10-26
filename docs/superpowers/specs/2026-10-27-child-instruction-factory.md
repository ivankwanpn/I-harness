# C2/ID Session instruction factory — specification, 2026-10-27

Status: root-promoted after independent design review and I1–I3 fix review on2026-10-27. The plan ledger authorizes the isolated Stage A writer; no runtime acceptance is implied. Bound to MAIN `38e65b4027b35b1209cff2364e8d6589512278fb`, `0.1.13-rc.1`/Session13. Package paths abbreviate `packages/`. The original caller preflight and `c2-id-caller-rebase-20261027.md` remain unchanged.

MAIN advanced to `9ce86534eee684d3a64eebf2e80d3f5d4cc45fe0` during drafting. Scoped read-only comparison found no changes to the actual factory/caller/instruction/fs/runtime types inspected here; changed managed/bootstrap.ts was not read or used. These candidates retain the approved 38e source binding, not a moving bootstrap design.

Bounded review closure: root accepts I1–I3 and minor clarifications in preserved `child-instruction-factory-design-review-20261027.md` (fixed-source review at `1e43b42a`). This revision freezes failure ownership, the minimal lease, root-route joins and deterministic error/debt accounting; no product source was reread or changed.

## 1. Frozen outcome and scope

Each executing child Session has its own existing IC-B instruction manager, roots/policy view, target selection, evidence tokens, acknowledgment and runtime publication. Physical watch/observation infrastructure may be shared through the existing InstructionEnvironment. Parent pending/consumed targets and child/sibling state never substitute for one another.

Implement the original-owner factory/router slice independently; full ID completion requires actual child consumers and connected semantic birth handoff. Do not add a second loader, acknowledgment API, durable activation record, instruction text cache or execution lane. The factory must route actual file targets, not merely return an unused context.

Root ruling: no new core-agent post-settlement reentry in this scope. Preserve accepted retained live continuation `7edb3e41`; a settled child failure remains truthful terminal/reconcile. B2 READY is birth evidence, never initial execution permission. Future child intent stays separately closed under original B2; public ForkRequestCore remains completed-only. No bootstrap stage fields/version/migration are designed here.

Accepted D1a generation/source/receipt/Stop and O1 Task1 `381dc63a` passive surface publication/retirement remain owned by existing consumers. F1 HOST public cutover and current durable CodeStore writer are not accepted through this document. Passive completed-only CodeStore does not support child all/N/none.

## 2. Actual source ports and proposed capability

| Existing type/owner | Exact usable surface |
|---|---|
| `context/instructions/contracts.ts` | InstructionHost.create(InstructionScope); InstructionEnvironment.host/policy/dispose/close; policy.current/ready/subscribe. |
| `context/instructions/manager.ts` | createMainInstructionManager({environment,cwd,authority,available,publish}); returns SessionRequestContext plus text() and observe(InstructionTarget). Name is retained; no replacement manager algorithm. |
| `core-agent/src/agent/request-context.ts` | reconcile/capture/current/retain/succeeded/promotedHumanRequest/close; RequestContextPin.release; SuccessfulInstructionHandoff includes committed accepted outcome, exact candidate/evidence and physical ExecutionReceipt. |
| `runtime-context/src/index.ts` | createRuntimeContext(session, source); registerSection/render/settleOriginals/currentText/close. |
| executor `lifecycle/action-facts.ts` | createRuntimeContextSource(FactOwner), retaining original action/capture and signal through unknown publication. |
| `core-session/src/managed/ports.ts` | FactOwner.view, beginAction, optional ownsAction/drain; actual view identity is authority, scalar owner IDs are not. |
| `core-tools/src/types.ts` | ToolExec.session is trusted actual executing Session; sessionId is metadata; prepared registry validation and executable authority remain existing owners. |
| `fs/src/index.ts`, `range-read.ts` | FsToolDeps.observeInstructionTarget(target,exec); InstructionReadScope is queued/reference-only/unavailable with existing reasons. read validates page before target activation; list_dir activates only after successful readdir. |

Add a type-only capability in `subagent/src/child/instruction-context.ts`; re-export its types through the existing subagent entry. Import only existing SessionView, FactOwner and SessionRequestContext types using current dependency edges. Manager text/target/result types and runtime settlement stay private in executor. No new fs/instructions subagent dependencies, lockfile work, copied DTOs or executor import.

```ts
interface ChildInstructionContextInput {
  readonly session: SessionView;
  readonly factOwner: FactOwner;
  readonly lifetime: { available(): boolean };
}
interface ChildInstructionContext {
  readonly requestContext: SessionRequestContext;
  retire(): void;
  close(): Promise<void>;
}
type ChildInstructionContextFactory =
  (input: ChildInstructionContextInput) => ChildInstructionContext;
// Add to existing RoleModelHost, inherited by SpawnOptions and tool deps:
createInstructionContext?: ChildInstructionContextFactory;
```

The optional field preserves standalone embedders without an instruction host. Actual executor-connected child support requires the capability; omission is not ID acceptance. Do not replace it with a fabricated no-op context. No sessionId or PluginContext input performs a factory operation, so neither is part of this contract; original caller retains its actual ctx for its own unmount. IDs never select a manager.

Executor implements `createChildInstructionHost(options)` in `context/instructions/child-host.ts` with the following concrete constructor and output. The local manager alias is `ReturnType<typeof createMainInstructionManager>` and runtime alias is existing RuntimeContextService.

```ts
options: {
  environment: InstructionEnvironment;
  cwd: string;
  authority: () => AuthorityState;
  available: () => boolean;
  root: { session: SessionView; factOwner: FactOwner; manager: MainManager };
}
// output; factory identity is stable for this original assembly:
{
  create: ChildInstructionContextFactory;
  observe(target: InstructionTarget, exec: ToolExec): Promise<InstructionReadScope>;
  retire(): void;
  close(): Promise<void>;
}
```

cwd and live authority are mandatory host constructor capabilities, captured from actual assembly opts.workspace/authorityNow. A child/message cannot replace them. Future delegated roots would require a separately authorized host capability; inherited text, saved parent targets, Session IDs and lineage headers are insufficient. Each child manager independently calls existing policy+authority resolution to produce its own InstructionScope.

The factory is a trusted host capability and is never exposed as a tool/RPC/schema service. Do not invent PluginContext ancestry validation or grant authority from ctx services. No instructions pre-step hook is registered. Any future child-wide settle-before-followup requirement needs its actual owner/caller decision; do not expose unused public settlement/text/observe methods.

## 3. Deterministic construction and publication algorithm

1. Constructor validates root.factOwner.view === root.session. Keep the root manager already created by IC-B; do not create another main manager or change its instructions→skills→subagents section order.
2. create stays synchronous. Reject synchronous reentrant create/retired host; set host construction guard before validation and keep it through setup. Validate exact factOwner.view === session, root/duplicate view and actual isManagedFactOwner for managed views. Nondurable means trusted supplied FactOwner with exact equality plus isNondurableSession(view); no unique memory-owner branding/comparison owner exists. Never open/profile/restore storage or derive an owner from IDs.
3. BEFORE supplied availability callbacks or fallible resource setup, reserve exact view in the existing WeakMap and owned Set with phase constructing, original owner, retired flag, optional runtime/manager handles, original construction failure occurrence/value, cleanup flight/result and resource phase flags. This occupied record rejects same-view replacement. A host construction guard spans synchronous setup and resets in finally.
4. Check live host/input availability; allocate runtime = createRuntimeContext(session, createRuntimeContextSource(factOwner)) and retain its handle immediately. Construct/retain existing manager with captured cwd/authority, available = !hostRetired && !slotRetired && options.available() && input.lifetime.available(), publish = runtime.render(signal, retain). Register only manager.text instructions section. Child skill/subagent sections are not fabricated; full child snapshot replaces stale inherited instructions upon actual reconcile. These constructors/local registration perform no reads/actions/publication/ack; environment/watch construction is a separate existing owner.
5. Recheck host/slot retirement before setting phase live and exposing the usable lease. On setup error, retain explicit failure occurrence/value (including undefined/null), mark slot retired/failed, retain every obtained handle and expose no lease. Store deferred cleanup flight with immediate fulfilled/rejected observer/result, then rethrow original construction value synchronously and record its delivery independently of truthiness. Cleanup runs after construction unwinds; §5 permits slot removal only after error delivery and every obtained resource acknowledges close. Pending/failed cleanup retains exact slot/handles; host.close joins/retries originals without new render or unobserved close.
6. requestContext delegates existing reconcile/capture/current/retain/succeeded/promotedHumanRequest methods. Wrap reconcile to reject after retirement and track its original promise; capture returns undefined and current false when retired. Preserve already-issued original retain/succeeded/pin-release settlement without an added current/available gate or new physical-receipt validation. Retirement is a wrapper flag, not early manager.close. requestContext.close delegates lease.close to preserve runtime-before-manager ordering.
7. Private slot text is manager.text. Private observe registers its operation record BEFORE calling manager.observe(target), captures fulfilled/rejected result with an immediate rejection observer, then rechecks original slot/availability before returning the existing disposition. Private runtime settlement uses original methods only and cannot prepare/discover/render/issue. Mapping uncertainty stays truthful; no synthetic human promotion resets it.
8. Actual Agent receives this exact requestContext. Existing admission/request/summary paths reconcile and validate evidence, existing physical accepted handoff calls succeeded. Do not append manager.text into inheritedSystemContext or systemPrompt, acknowledge on render/READY, or manually promote a human request for inherited child input.

No new FIFO or model lane is added: actual Agent invocation owns serialized reconciliation/ack; concurrent read/list observations use existing manager's canonical ordered target set. Management close tracks a finite snapshot after synchronous retirement; no new operation can enter thereafter.

## 4. One actual file-target routing seam

Replace assembly fsToolsDeps.observeInstructionTarget's current parent-only branch with lazy `childInstructionHost.observe(target, exec)`. Initialize host after existing main manager construction and before any child execution; before initialization, return unavailable/mapping-unavailable (no fallback manager).

Exact algorithm: if host retired/unavailable return unavailable. Capture actual exec.session once; missing session takes unknown/reference-only without WeakMap insertion. If it equals root.session, register a root operation record BEFORE calling original root manager.observe, observe its rejection immediately, and recheck exact root/host availability after mapping. Otherwise look up only captured view in WeakMap. Foreign/cloned view→reference-only/outside-root; known retired/unavailable/closing slot→unavailable/mapping-unavailable, never parent fallback. A live slot uses private guarded observe and same-slot revalidation after mapping. Never use IDs/lineage/role/text/profile to choose a manager.

The fs callback is invoked by existing actual tool execution after content/read-page validation. Child resolveRoleTools registers the same parent read/list tool objects; registry.prepare seeds actual child view and Code Mode broker passes its actual session, so both reach this route. No fs package mutation or duplicate child fs registry is required. This route changes instruction activation only, never role/tool/approval/sandbox permissions. Absence of this production fs callback integration means the factory is staged and target activation is not shipped.

Factory adds no bubbled agent/pre-step handler. Actual child requestContext owns child preparation/ack directly. Any Session-owned hook changed during connected integration must check payload.session === its exact view before mutation. Existing parent manager/read targets remain untouched by child hooks; unrelated skill/MCP hook behavior is not declared fixed by this slice.

## 5. Retirement, original pins and cleanup debt

retire is synchronous/idempotent: set local flag before any await and deny new create/reconcile/capture/current/observe; host.retire fences all slots and root routing. Retired slots remain registered as unavailable until successful close, so a new slot cannot bypass original debt. Do not use an initial run controller as Session lifetime: interrupt may end a turn while later genuine inbox followup remains valid. The existing child owner calls retire on actual permanent close/dispose/replacement; request signals remain per original action/generation.

lease/private failed-slot cleanup first retires, joins tracked original reconcile/observe records, then calls obtained runtime.close. Even if operations rejected, attempt runtime settlement; failed runtime close retains its original handle and dependent manager/views. Once runtime closes (or was never obtained), call obtained manager.close despite earlier operation error. Record each resource success before advancing; failed close retains the original handle. Cleanup cannot release a constructing record or infer an unassigned handle is permanently absent until construction exits. No new render during recovery.

Error accounting is by explicit occurrence/delivery flags and values, never truthiness/equality. The construction error is already reported by synchronous create rethrow; host.close must not report it again as new debt. A never-exposed failed slot may be removed automatically once that delivery occurred, construction exited and EVERY obtained original resource acknowledged close; no whole-host shutdown is required before same-view retry. Pending/failed cleanup retains exact slot/handles/observed flight/result and any unreported current cleanup failure until original resource acknowledgment. Explicit close joins retained cleanup flight, then attempts remaining resource phases once, reporting unreported drained-operation/current cleanup occurrences once and marking them reported. Successful acknowledgment makes prior rejection historical, not permanent debt; already-reported history never makes a later successful close fail. Failed resource phases retain exact handles for retry; successful phases never replay for old errors.

Install close flight/deferred result before invoking any original cleanup method; attach rejection observer immediately. Concurrent external close joins that flight. Guard synchronous entry into original observe/reconcile/cleanup calls too: close reentered from the same host/slot construction or original invocation retires then returns an immediately observed local rejection before self-join/work. Preserve original record; never mark partially built resources clean. Construction's deferred cleanup runs only after its guard exits. A rejected flight clears only attempt marker after result capture, allowing same-owner retry; completed resource phases never repeat merely for historical error reporting.

Actual child owner order: retire instructions and existing new-work gates synchronously; cancel/drain accepted Code Mode/turn/followup/initial-generation producers under original owners; then lease.close; close document only after runtime publication settlement and producer obligations permit it; finally unmount original ctx when dependent cleanup has succeeded. Attempt independent cleanup even if another disposer rejects; retain dependencies needed by failed originals and aggregate errors. No source/debt disappearance through fresh construction.

Each cleanup flight is admitted into a private host flight set BEFORE work, independently of occupied slots, with immediate result/rejection observation. host.close retires and freezes root-route records, admitted cleanup flights and owned child records, then joins root/flight originals and independent remaining child cleanup with Promise.allSettled. Slot removal during completion cannot remove a captured flight from that finite join; retain pending flights until terminal result observation, and captured records through the attempt. Preserve unreported current cleanup failure until acknowledgment, aggregate without skipping siblings, and consume reported historical errors. Host never closes borrowed root manager/runtime/environment, child document/ctx/watch. Assembly waits router/producer barrier before root runtime→manager cleanup; owned environment closes after root/child dependencies drain. Preserve O1 retirement and service environment ownership.

## 6. Connected consumers and honest dependency gates

| Consumer | Frozen integration requirement | Gate |
|---|---|---|
| Fresh child | Create after exact owned birth/document+initial receipt handoff, before first actual Agent request; pass lease requestContext, retain it in existing lifecycle closure. | C2 semantic birth/launch owner; actual receipt+original action/document/input/clock, not READY. |
| Resident | Create only after real inbox execution controller and childFactOwner; lifetime uses same entry identity/closing state, not one turn's abort signal. Pure eligibility/status probe creates nothing. | Exact restored owned view and current C2 lifetime handoff; no initial-run replay. |
| Team | Forward same capability through TeamSubagentDeps/scheduler; fresh/all/N/none mapping and provisioning identity stay C2-owned. | Child intent and shared L1 all/N extension for inherited modes. |
| Ordinary reviewer | Forward through GuardianReviewDeps/reviewer-spawn, uses none and real child context. | Approval-specific initial receipt/generation handoff; tools[]/selected-client/role floor unchanged. |
| Detached/SDK assembly | Existing assembly's own IC-B manager remains Session-local; only use real B2-imported owned view for managed attachment. | C2 detached birth and F1 actual public handoff; no new public source/profile work in factory. |

Type forwarding may stage without enabling consumers. No fake consumer or no-op context is added to claim reachability. Root can accept the independent library slice separately, but connected product/type/reachability acceptance waits actual consumers. B2 child-intent version/compat, L1 all/N codecs/membership and initial receipt adoption are concrete later-owner gates; this spec neither implements nor waives them.

## 7. Isolated reviewer is a separate explicit gate

`guard-approval/src/guardian/isolated-reviewer.ts` owns no child Session. It needs a later request-local lease using existing InstructionHost.create/current saved policy and actual authority/cwd. Prepare exactly the applicable cwd sources; optional extra targets require genuine registered request input evidence, never arbitrary review text. The request's system prompt includes the prepared text once and its pool key includes that exact prompt/current dependencies.

Keep original snapshot/view pin across prepareModelRequest→assessPreparedCapacity→generation.bind→prepared.stream, rechecking policy generation/authority/dependency reliability+fingerprint immediately before actual physical issue; stale before issue refuses without renewal/replay. Successful stream+actual execution receipt settles only this request's lease; no SessionRequestContext.succeeded, parent pending/consumed selection, human promotion or synthetic child Session. Original auxiliary generation/timeout/no-tools/model limits and pool commit-on-valid-verdict remain unchanged.

Because its current prepared-request interface has no SessionRequestContext evidence handoff, the exact physical issue/receipt hook must be frozen with the auxiliary request owner before implementing that adapter. It is explicitly excluded from the independent child factory implementation and remains an open isolated-reviewer acceptance gate; a successful factory test cannot close it.

## 8. Acceptance contract

| ID | Actual stimulus/owner | Required observable |
|---|---|---|
| A1 | Factory with real owned view/FactOwner and original environment | One manager/runtime per view; zero constructor reads/actions; managed/trusted nondurable checks; setup failure→no lease, synchronous original error (undefined/null included), occupied slot until all obtained closes acknowledge, then same-view create succeeds without host shutdown; reentrant create/close refuses/self-join absent. |
| A2 | Actual registered read/list through two child registries sharing tool objects | Each exact child view queues its nested targets; parent/sibling current snapshot/selection untouched; order-independent text, one copy. Invalid page/failed read produces no activation. |
| A3 | Same read via actual child Code Mode broker | Trusted broker child session reaches same slot; no nested/foreign/forged text route or extra tool permission. |
| A4 | Real Agent request/summary using returned requestContext | Current child runtime/context contains fresh applicable rules; accepted physical handoff alone consumes child pending targets; prepare/render/failed exchange/summary-only/birth READY does not. |
| A5 | Authority/policy/AGENTS/CLAUDE dirty/delete/disable, canonical escape/revoke during mapping/preparation | Existing source precedence/bounds/ready checks preserved; stale send fenced; external content remains usable with precise reference-only metadata and no rule adoption. |
| A6 | Permanent retire during read/reconcile/issue; ordinary turn interrupt followed by genuine inbox message | Retire immediately fences new work; accepted originals drain. Turn interruption alone does not permanently retire Session context or mint a new original deadline. |
| A7 | Constructor cleanup pending/rejected/acknowledged; unknown publication/pin failure; drained operation rejection and same-owner retry | Pending/failed original closes block replacement and retain unreported current failure; acknowledgment permits release, delivered construction error never poisons host.close, reported history never poisons later successful close; exact resource handles retained, successful phases not replayed. |
| A8 | Actual fresh/resident/Team/reviewer/detached consumers after their gates | Real factory requestContext and target routing before request, current independent roots/ack, role/model/tools/budget/deadline/D1/Stop/O1 controls unchanged. |
| A9 | Held root observation; failed-slot cleanup completion removes slot during host.close snapshot/join; sibling failure | Root observe registered before invocation; finite root+admitted-flight+child joins survive slot removal; no skipped siblings/fallback/parent ack, borrowed root resources untouched, environment waits actual owner barrier. |
| A10 | Isolated actual auxiliary request | Separate later gate in §7; no parent ack/pool stale rules/no-tools or generation-floor regression. |

Controlled Stage A implementation and verification require the exact plan-ledger reservation. Actual profiles/network/remote publication remain excluded. Acceptance requires fixed-source evidence; Task4/Task5, full ID/public F1/provider B3/R6/package/release are not declared complete.

## 9. Root execution refinements

Stage A consumes the unchanged original factory/caller source on MAIN1e43b42a (root verified the scoped38e→MAIN comparison), with O1 source and passive durable prerequisites already integrated. Keep child-host.ts as the narrow constructor/router facade; cohesive private child-host/slot.ts and child-host/operations.ts may own slot cleanup and tracked operations. No new dependency, registry authority or duplicate manager is introduced.

Treat promotedHumanRequest as a new selection mutation: after wrapper retirement refuse it with the same unavailable disposition used for new reconcile. Already-issued retain/succeeded and original pin release remain usable as specified. Track live operations and finite close snapshots; completed operations whose failure has already been delivered to their caller are historical, not an unbounded error log or permanent resource debt. Pending/failed resource cleanup retains original handles until acknowledgment. This does not weaken occurrence flags, original error identity or failure delivery.

CF04: a refused create for the same captured view AND original FactOwner may schedule or join one deferred retry of its never-exposed failed slot's remaining original cleanup. It still throws before allocating any replacement resource/lease; no timer, retry loop or render is added. Only a later create after acknowledgment may allocate a replacement. Foreign owners cannot trigger recovery; a retired host uses its existing close path. Capture the original view, owner and lifetime function/receiver once before callbacks, retaining live predicate behavior without allowing mutable input aliases to replace those identities.

Controlled fixture-owned loopback HTTP on an ephemeral loopback port is authorized for actual Agent physical-handoff tests, using fixture credentials and isolated configuration. It is not an external provider/profile/account request. Close original server/sockets; do not fabricate an execution receipt or treat llm-mock local completion as successful physical acceptance.
