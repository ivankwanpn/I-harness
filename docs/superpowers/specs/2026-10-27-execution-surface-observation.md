# Task 6 O1 — ExecutionPane observation specification

**Status:** root-promoted 2026-10-27 after I1–I5 source review and explicit contract closure. Product0.1.13-rc.1/Session13 unchanged. Original drafts/review remain preserved. The plan ledger authorizes an isolated Task1 source-only reservation; shared composition still waits accepted F1.

**Authority:** integrated IH0.1.13 delivery Task 6 and event rebase; `surface-subscription-next-packet-20261026.md`; original 2026-10-26 O1 spec/plan; root's accepted D1a/Stop source and promoted F1 contract. Root supplies immutable full source/evidence IDs at dispatch. F1 currently owns the SDK/router/bridge/app-fork integration slot; O1 shared composition waits for its accepted handoff.

## 1. Bounded outcome and exclusions

ExecutionPane's Code Mode collection/current page becomes the first real subscription consumer. Preserve original IH styling, tabs, source/output/trace, pagination, clipping, raw records, refresh, confirmation keyboard behavior, explicit Stop route and owner checks. Capability absent means one initial/manual read-only inspection, clear limited-currentness presentation and no interval fallback; controls requiring live-current evidence remain disabled. O1 never grants execution permission.

No AgentProcessesPane, ContextSubsystemSettings, TerminalPane, BrowserPane, CodingPlans, instruction diagnostics/IG, O2/O3/W2 or native backend conversion. No new bus, durable completion registry, format change, second model lane, backend rewrite or hidden heartbeat. This packet cannot complete Task 6, release or native gates.

## 2. Actual stable source and ownership

Paths below are relative to `packages/`; source findings were checked on root-named stable MAIN `9b756167`, without Git verification or moving HOST/worktree inspection. Re-anchor shared composition only after accepted F1 handoff.

| Actual owner | Existing interface / anchor | Required preservation |
|---|---|---|
| `code-mode/src/types.ts:84`, `register.ts:28–71,119–144` | mount ready/liveCells/terminateCell/cancel/dispose; registerCodeMode | Start installs broker/liveCells after optional admission; terminal installation removes live state; nondurable installation respects its flush. No existing surface feed/state. |
| `code-mode/src/event-facts.ts:14–44,80–89,143–170` | original pending/refresh/required/optional/store/assertObserved/close | Original committed subscription can reconcile late receipts. Pending deletion follows local installation; assertObserved currently checks pending only; optional start and sticky recovery are not a complete certificate. |
| `session-executor/src/assembly.ts:1178–1184,1535–1540,1620,1695–1704,1760` | mounted effective mode, liveResources/executionState/Stop, revokeNewWork/dispose | Actual original owner; no model resolution for inspection. revokeNewWork currently only revokes managed-document work; new observation retirement must occur there synchronously. |
| `session-executor/src/service.ts:721,770,1075–1083,1093–1121,1141–1182,1262–1269` | publication/onAssembly/includeExisting/liveAssembly/revoke/close | Existing registration precedes synchronous enumeration; maps can retain retired failed-cleanup owners. Removal follows successful cleanup; debt remains original-owner debt. |
| `desktop-gateway/src/execution.ts:33–35,71–79,121–126` | existing execution.read and explicit Stop | Cold snapshot is read-only; profile and cold snapshot are real awaits. Preserve one DTO-construction read, live-owner Stop check and flush. |
| `desktop/src/renderer/session/ExecutionPane.tsx`, `execution-surface.ts` | pane uses current 1500ms polling hook | Convert ExecutionPane only. Preserve existing generation/ticket guards and other hook consumers. |
| `desktop/src/preload/index.ts` | actual request and onEvent/removeListener path | Reuse original bridge/transport; no parallel channel. |

**Resolved source-only reservation:** passive writer confirmed types.ts unchanged at cbb29546 and no Stage4 change needed; root released it to O1 for optional CodeModeMount additions. F1 writer confirmed assembly.ts frozen at f33 and service.ts unchanged, with no further planned F1 edits; both are released for O1 observation additions. Future actual needs return to root before editing. State/runtime-limits/core-seed stay passive-owned. Shared SDK/router/bridge/app-fork remain F1-owned. Root integrates exact frozen deltas serially; worktree isolation alone grants no duplicate slot.

## 3. Frozen wire, bounds and authority

Advertise `desktop-surface-events: ["1"]` only after complete source→Gateway→SDK→IPC→preload→pane composition and qualification. Protocol3 stays unchanged. Shared Gateway `observation/types.ts` defines the closed first union:

```ts
type SurfaceStamp = Readonly<{ epoch: string; revision: number }>
type ExecutionSurfaceQuery = Readonly<{ surface: "execution"; sessionId: string }>
type SurfaceLease = Readonly<{ subscriptionId: string; requestKey: string;
  scope: ExecutionSurfaceQuery; stamp: SurfaceStamp }>
type SurfaceNotice = Readonly<{ subscriptionId: string; stamp: SurfaceStamp;
  kind: "invalidate" | "reset" | "retired";
  reason?: "source-unavailable" | "scope-changed" | "owner-retired" | "overflow" }>
type ExecutionSurfaceSnapshot =
  | { kind: "snapshot"; subscriptionId: string; stamp: SurfaceStamp; value: DesktopExecutionView }
  | { kind: "reset"; subscriptionId: string; stamp: SurfaceStamp }
  | { kind: "unavailable"; subscriptionId: string; stamp: SurfaceStamp;
      reason: "source-unavailable" | "owner-retired" }
```

| Method | Exact Gateway params → result |
|---|---|
| `desktop/surface/subscribe` | `{requestKey,surface:"execution",sessionId}` → `SurfaceLease` |
| `desktop/surface/snapshot` | `{subscriptionId,epoch,offset?,limit?}` → `ExecutionSurfaceSnapshot` |
| `desktop/surface/unsubscribe` | `{subscriptionId}` → `{unsubscribed:true}` within owning connection |
| notification `desktop/surface/changed` | `SurfaceNotice`; stamps only, no source/result content |

Renderer request kinds use those methods plus workspaceId. Native resolves catalog workspace, strips workspaceId, allocates/reuses requestKey and gates leases. Renderer cannot choose Gateway keys, runtime generations, roots or ownership. One renderer subscribe invocation is one native-owned flight; lost-response retry uses the same key. Ambiguous pending flights remain owned/charged until reconciled/released; exhausted admission refuses. Timeout is not proof of non-admission. A late subscribe reply for an already retired lease cannot restore controls.

Opaque IDs/requestKey/epoch: nonempty, no NUL, max128 UTF8 bytes. sessionId retains resourceId max256 UTF16 code units. Reject extra fields, accessors, arrays and unsafe numbers before reads. Revision is a safe nonnegative integer; offset0…MAX_SAFE_INTEGER/default0; limit1…20/default10/pane10. Per cell retain65536 UTF16 units,100 output rows and100 call rows. Rendering bounds do not bound historical scan cost.

Native serializes subscribe issuance per Gateway connection using increasing canonical `r1:<positive-safe-decimal>` keys. Exact duplicate key/query joins or returns its original disposition; conflict refuses. Max32 active leases and64 retained idempotency entries/connection; Gateway high-watermark refuses evicted/older keys. Exhaustion refuses or retires, never reuses epoch/key. Native per-window routing metadata confers no execution authority or managed delivery identity. Snapshot/unsubscribe require that window's tracked token.

Lease binds connection, window, runtime generation, exact authorized conversation/source owner and binding incarnation. Existing visible-conversation inspection policy applies; hidden/internal children are denied. Archive/move/delete/project withdrawal and broker authority changes fence old leases. Historical reread needs fresh existing-policy authorization and confers no live authority.

Read-only guard captures visibility/profile, broker binding/revision and owner identity, asserts around every real read await and detects ABA. Reuse accepted F1 observation/currentness seams without profile recursion or another registry. `nativeScopeFor` is not blanket inspector permission; result-read semantics are not imported.

Epoch is random and never reused; runtime/source/binding replacement or revoke/regrant replaces it. Revision increments only for actual source dirtiness/publication. Queue/session/D1 counters are unrelated. Safe-integer overflow retires epoch. Cold↔live resets/rebinds with fresh authorization; cold snapshots never carry Stop evidence.

## 4. Exact additive source interfaces

The following interfaces are NEW, additive and optional only for custom-mount/assembly compatibility. Missing either mount feed or state means unavailable live source; never infer availability from queue state or a successful read.

```ts
// CodeModeMount additions
onSurfaceChanged?(listener: () => void): () => void
surfaceState?(): "available" | "unavailable" | "retired"
// Internal fact helper: retains its existing return methods and adds observationState().
createCodeModeEventFacts(owner: FactOwner, drainProducers: () => Promise<void>,
  onObservationChange?: () => void)
// Added internal returned method; no I/O, recovery, clearing or settlement.
observationState(): "available" | "unavailable" | "retired"
// SessionAssembly additions
onExecutionSurfaceChanged?(listener: () => void): () => void
executionSurfaceState?(): "available" | "unavailable" | "retired"
// SessionService addition; every event carries the exact owned assembly.
onExecutionSurfaceLifecycle?(listener: (event: {
  sessionId: string; assembly: SessionAssembly;
  kind: "published" | "retiring" | "removed"
}) => void, options?: { includeExisting?: boolean }): () => void
```

Callbacks are future-only, synchronous notifications after local bookkeeping and isolated per listener; callback exceptions cannot roll back committed facts or fail producer publication. Getters are passive and allocate no work. Unsubscribe removes only that consumer callback. No callback/getter may call refresh/recovery, timers, snapshots, tools or model actions.

**Complete mount certificate:** available requires successful initial readiness, no in-progress started-handler/local-install transition, fact helper available and no irreversible mount retirement/disposal. Enter unavailable before the started handler's first admission await; hold through broker.startCell and liveCells.add or through the original failed-admission→interrupted-terminal path. A fulfilled optional() promise alone never certifies installation. Publish after the actual add and completed handler bookkeeping. Late receipt for rejected start never replays broker.startCell, adds liveCells or revives the continuation.

The fact helper records pending registration before awaits, failed preparation/installation and original recovery requests. Publish on each actual dirtiness/reliability transition, after cancellation bookkeeping, after local install and after final pending deletion. Intermediate committed-but-not-installed/pending states remain unavailable. Terminal publication preserves durable callback versus nondurable-flush ordering; publish after actual liveCells removal and final pending removal even if the initiating tool already rejected. The existing original committed-event subscription retains late reconciliation ownership; observation adds no reconciler.

**Recovery premise, checked explicitly:** `core-session/src/managed/ports.ts:51–67` exposes assertHeld/close/requireRecovery/holdRecovery; there is NO acknowledgement/clear method. assertHeld certifies source lifetime, not recovery readiness; FactOwner does not expose assertObservable (`:116–123`). Managed source hold release is the successful original source.close boundary (`session-persistence/src/coordinator/settlement-source.ts:32–44`, `managed-document.ts:367–375`). Mirror a transient hold until that SAME source's successful original close is observed. Sticky requireRecovery/uncapturable or installation faults remain unavailable for the remaining mount lifetime: no existing acknowledgement permits clearing them. Unrelated success, pending.size0 or observer reads cannot clear either hold. Do not add a recovery-ack API or edit core/persistence ownership for O1.

Mount disposal sets retired synchronously before its first await; helper close marks its observation state retired at entry while original source.close/reconciliation still owns cleanup. Retirement is irreversible. Failed close keeps original subscription/captures/debt for retry; successful original close alone detaches its recovery subscription. Consumer lease teardown never calls fact-helper/source close or detaches that producer subscription.

Assembly forwards the actual mount feed/state, initial readiness and actual mounted effective-owner changes. Existing assembly.revokeNewWork synchronously marks observation retired and publishes once before any await, then preserves its original new-work revocation; direct dispose uses the same retirement latch. Service revokeSession/closeSession/closeAll invoke that path before cleanup awaits. Do not alter Stop/D1 authority, source settlement or cancellation order.

Service publishes exact owned identities; register lifecycle listener before synchronous includeExisting enumeration. Enumerate only identity-checked owned handles: eligible current owners are published, already closing/failed retired debt is retiring, never synthetically published. Reentrant revoke/remove cannot emit a later published event for that retired identity. Retiring is once/identity; removed follows successful cleanup/map removal only. Failed cleanup retains retired debt; retry cannot republish. Listener failure is isolated; removal/replacement detaches consumer forwards without suppressing original recovery.

Current codeMode is captured on assembly construction; saved settings are not an effective-mode transition. Publish actual replacement/effective changes only. O1 introduces no hot remount or saved==effective promise.

Gateway observes committed `code/cell`, `code/output`, `code/call`, `code/dispatch`, `code/result` and rewind/point reset, plus the post-install/reliability/lifecycle feeds. Unknown cell creation invalidates the collection; terminal removes live control while preserving history. Preserve raw saved-cell rewind semantics. Actual history replacement/deletion/manager drain/broker transitions reset or retire from their owners.

## 5. Exact Gateway adapter and read guard

All interfaces are internal; RPC/renderer cannot supply authority callbacks. attach is synchronous, attaches actual publishers before returning, and never constructs an assembly. Install provisional notice sink before authorization awaits; retain early notices and compare scope incarnation afterward.

```ts
type ExecutionAvailability = "available" | "unavailable" | "retired"
type ExecutionSourceChange = "invalidate" | "reset" | "retired"
interface ExecutionInspectorGuard { assertCurrent(): void; release(): Promise<void> }
interface ExecutionSourceAttachment {
  readonly identity: object
  state(): ExecutionAvailability
  read(page: {offset?: number; limit?: number}, assertCurrent: () => void): Promise<DesktopExecutionView>
  close(): Promise<void> // detaches this adapter; never disposes original producer
}
interface SurfaceSubscriptionOptions {
  authorizeExecution(query: ExecutionSurfaceQuery): Promise<ExecutionInspectorGuard>
  executionSource: { attach(sessionId: string,
    changed: (kind: ExecutionSourceChange) => void): ExecutionSourceAttachment }
  notify(notice: SurfaceNotice): void // throws on failed admission/forwarding
}
interface SurfaceSubscriptions {
  subscribe(input: ExecutionSurfaceQuery & {requestKey: string}): Promise<SurfaceLease>
  snapshot(input: {subscriptionId: string; epoch: string; offset?: number;
    limit?: number}): Promise<ExecutionSurfaceSnapshot>
  unsubscribe(input: {subscriptionId: string}): Promise<{unsubscribed: true}>
  invalidateScope(sessionId: string, reason: NonNullable<SurfaceNotice["reason"]>): void
  close(): Promise<void>
}
declare function createSurfaceSubscriptions(options: SurfaceSubscriptionOptions): SurfaceSubscriptions
```

Thread the mandatory attachment-read assertion privately into the actual existing `createDesktopExecution.read(sessionId, options={}, assertCurrent?: () => void)` and `readDesktopSnapshot(coordinator,sessionId,assertCurrent?: () => void)`. The existing manual route may omit it; the lease adapter must supply it. Invoke before/after profile, before selecting/reading source, around cold snapshot await, and before returning value. The callback only validates captured F1 authorization/currentness and source identity; it never calls profile, authorizes again, constructs or settles. Keep one existing DTO-construction read, and recheck lease stamp/owner/guard after it. Changed source returns reset without value; revoked scope refuses without value.

One pending notice/lease; reset supersedes invalidate, retired supersedes both. Sink precedes registration/includeExisting/read awaits; native retains early notices until lease correlation. Last lease releases adapter references/authorization guard, with maps bounded by active leases/owners. Any notify failure synchronously fences affected lease and enters observable reset/retire/disconnect.

One server snapshot flight/lease; same page joins, conflicting page returns reset without queuing. No server reread-until-stable loop. Close retires first and joins existing flights; repeated close joins one promise; one release failure cannot skip other releases. Producer recovery debt remains original-owner debt.

## 6. Pane, transport loss and acceptance

Controller owns one lease flight, one snapshot flight and one dirty bit per mount/workspace/session/page/runtime generation. Install sink, subscribe, snapshot. Coalesce manual/reconnect/visibility; hidden panes defer reads and reconcile dirty once visible. Scope/page/mutation retirement fences tickets synchronously. Ignore duplicate/old revisions; gap resets page. Unknown epoch cannot authorize itself; retire/rebind through native/server authority.

At most one immediate follow-up after reset; if still changing show updating/stale until next actual publication/manual boundary. One transient response retry/cycle under existing30s IPC deadline; then visible stale/error. Never retry mutation. Existing explicit Stop invalidates old read tickets, buffers notices and joins one post-operation reconciliation. Stale responses cannot restore controls; accepted hidden mutation completes.

Unmount/disconnect retires, clears control evidence, detaches consumer sinks/leases and joins flights/cleanup. Observation never calls assemblyFor/writableSessionFor/load, modelState/prepare/auth/send, tools.prepare/dispatch or facts.refresh/drain/requiredPrepared. sdk/disconnected immediately stales controls. sdk/ready carries current native runtime generation only after initialize+project sync+current publication; same-label reconnect performs one fresh capability/lease/snapshot. Old child/ready/read callbacks cannot publish; withdrawal fences generation before awaiting close.

Use ordered stdio/IPC and bounded writer without replay storage. Actual overload/write/forward failure, relevant listener failure, EOF/window destruction must observably reset/retire/disconnect. Isolate unrelated listeners while retiring the affected consumer; revision advancement is not delivery proof. Silent final-notice loss is undetectable with zero healthy polling: recover only at next actual gap/reset/reconnect/manual boundary and state this limit in evidence.

Required evidence is the actual original source→Gateway→HarnessClient→WorkspaceRuntimeManager→dispatchDesktopRequest/registerDesktopIpc→preload→ExecutionPane route; scope/window/epoch ABA denial; source validity/late reconciliation/retirement; bounded flights/reset; original Stop authority; cold bytes unchanged and no writable/model/assembly/recovery;10 healthy fake minutes after initial snapshot with zero repeated O1 reads/scans. Preserve original pane/style and unrelated polling tests. Fixtures alone cannot qualify capability or completion.

**Dispatch boundary:** root may reserve Task 1 source-only after passive-writer types handoff, independently of F1 shared acceptance. Tasks 2–6, shared rebase, advertisement and connected acceptance wait accepted immutable F1 handoff and root's sequential integration reservation. No unresolved source API choice is delegated to the implementer; a concrete incompatible handed-off signature returns to root before edits.
