# F0 fork binding observation prerequisite

> Approved owner-scoped implementation packet under integrated delivery Task4. Root dispatches a GPT-6.1 Sol writer in its reserved worktree, followed by independent full-range review. No recursive delegation. The original preflight remains historical evidence; the root rulings below override conflicting draft prose.

**Goal:** Give the real CLI fork handoff a bounded coordinator-owned observation of source binding/lineage metadata and unmanaged target binding, backed by actual OS exclusion and synchronous revocation, so accepted transfer callbacks can check currentness after every await.

**Architecture:** Extend existing Documents/Ownership/Mutations/Lifecycle owners. A purpose-scoped callback pins actual session leases, acquires exact binding-document leases, captures strict observed data, then releases session operation lanes before invoking bootstrap. Metadata/document mutation and deletion synchronously revoke affected observations and join them before mutation. Temporary pins cannot release another live owner. No project registry, fabricated revision, raw fs-lock export or second bootstrap owner.

**Tech:** Existing TypeScript, JSONL backend, Windows/Linux fs-lock, Vitest/pnpm. No package/schema/storage format/version changes.

**Spec:** integrated delivery contract, R4B Task4/B2.3 and accepted transfer-host Tasks1–3; [fork caller preflight](../../research/integrated-checkpoint-20261024/fork-caller-preflight.md) and [root decisions](../../research/2026-10-24-fork-caller-design-decisions.md). Source at planning is MAIN56cc7702, product retirement17925354; relevant persistence owners remain unchanged. Result-store/context-output RC03/04 cleanup remains separately owned. F0 touches no cleanup-writer files and may proceed independently; F1 waits for both accepted prerequisites.

## Root adjudication (binding)

- F0-01: approve the purpose-scoped Documents observation and exact private ownership claims. This is existing-owner work needed for actual fork policy checks, not general refactoring. Use cohesive private modules if needed; no second bootstrap store, project registry, format bump or generic grant API.
- F0-02: cleanup is dependency-ordered. Coordinator close first revokes and joins observations. If an observation retains unfinished acquisition/release work, keep the dependent original ownership state. After managed.close fails with unresolved facts, do not run a blanket lifecycle release that destroys those required session leases. Attempt independent disposers while preserving dependent owners, errors and same-owner retry. This explicitly overrides the draft's unconditional “all cleanup stages” wording below. The new capability stays fenced after close starts; ordinary previously supported close/reopen behavior must not be silently changed.
- F0-03: low-level cleanup failures are not success. Retain unfinished claim/lock disposal and retry the same capability when supported; if the existing native primitive cannot prove a failed release completed, preserve explicit cleanup debt instead of accepting a later no-op as success. Do not broaden into native backend rewrites without a causal finding and root ruling. Tests must distinguish revoked authority from proved OS-resource cleanup.
- F0-04: strictly observed binding reads use the actual backend's tombstone/storage/file facts. A missing child file under a missing or inaccessible storage root is not a trustworthy absent binding. Preserve normal getDocument semantics. Only actual supported production backend implementations are qualified; do not invent a SQLite session backend or assert cross-platform coverage absent source/host evidence.
- F0-05: one writer implements all three steps below and receives a connected owner review over full BASE..HEAD. No intermediate helper-only feature-complete claim. Stage acceptance remains conditional on F1's actual CLI consumer and nonempty transfer/cold-retry controls; any new reachability rows remain visible until that consumer lands.
- F0-06: run Vitest from each package CWD, sequentially with --maxWorkers=2 --minWorkers=1. Preserve causal RED, setup failures, source-bound receipts and native resource counts. No user sessions/live providers, remote publication or unrelated decomposition. Version0.1.13-rc.1 and Session12 remain unchanged.

## Decision and limits

Choose **actual session pins + exact document leases + local revocation/join**. Reject an arbitrary revision/getter: JSONL getDocument currently turns all read errors into undefined (`session-persistence-jsonl/src/index.ts:315–318`), Metadata is mutable under `mutations.ts:107–118`, and `ownerOf`/view length cannot establish policy currentness. Also reject holding session operation lanes for the callback: bootstrap reacquires its target lane (`bootstrap.ts:137`), so that would recurse and hang.

The tradeoff is explicit: observations hold exclusive existing OS leases while transfer runs; a conflicting cooperative coordinator receives bounded lock conflict rather than progress. Temporary observation pins release when finished; actual managed/bootstrap owners remain live as before. This is not protection against direct backend/file mutation or a writer configured with a different lock root. F0 only advertises capability with a strict observed-read backend and enabled supported locking; no unlocked fallback. SQLite/custom backends without the capability refuse. Existing ordinary getDocument behavior is not widened or reinterpreted by F0.

## Frozen public and private interfaces

Add to persistence types/index, keeping runtime objects host-only:

```ts
export interface SessionBindingObservationRequest {
  // Complete provisional lineage set; callback must validate exact chain.
  existingSessionIds: readonly string[];
  target: BootstrapInvocation;
  signal?: AbortSignal;
}
export interface SessionBindingObservation {
  assertCurrent(): void;
  metadata(sessionId: string): Readonly<SessionMeta>; // existing IDs only
  binding(sessionId: string):
    | { readonly kind: 'absent' }
    | { readonly kind: 'present'; readonly value: unknown };
}
// Optional capability; callers refuse when absent.
withSessionBindingObservation?<T>(
  request: SessionBindingObservationRequest,
  run: (observation: SessionBindingObservation) => Promise<T>,
): Promise<T>;
```

The owner validates/captures plain own fields, canonical invocation, safe bounded distinct session IDs (max64 existing plus one target), no target in existing set, real AbortSignal and callback function before admission. Target is never profiled or ordinarily loaded. Binding keys are derived internally as `desktop-session-project-${sha256(id)}` using the established key formula; callers do not select arbitrary keys or claim a different key owner. Binding values are immutable captured strict data; CLI's existing closed binding parser decides unmanaged/unassigned/project. No project roots or durable project grant are introduced. A `SessionBindingObservationError` carries one of `unsupported | invalid | conflict | revoked | deleted | unavailable` plus cause; F1 maps it to its already frozen typed outcome and always retains invocation.

Add backend capability, separate from legacy getDocument:

```ts
readDocumentObserved?(key: string): Promise<
  { kind: 'absent' } | { kind: 'present'; value: unknown }
>;
```

Only actual document ENOENT is absent. Deleted/tombstoned identity throws a typed deleted error; malformed JSON, EACCES/EIO, unknown marker state, missing/unreadable storage root and other read failure throw. Existing source profile/target bootstrap ownership handles session existence; target document absence alone never proves target existence/readiness. The owner returns no callback value before the final guard succeeds; cleanup errors reject with original callback result/error attached as diagnostic data for the F1 wrapper to preserve, not as a fabricated wire result.

Private ownership seam (not package export): `pinOwnership(id):Promise<{assertHeld():void;release():Promise<void>}>`. It uses the same per-ID held/inflight ownership slots as ensureOwnership. Internal temporary repair borrows become claim handles instead of booleans: `{release(),retainLive()}`. Every actual lock slot tracks its held lock, persistent live claim, temporary borrow claims, observation pins and acquire/release flight. Claims have object identity; closing one claim can affect only that claim. Last temporary release unlocks only if no persistent claim/other borrower/pin exists. ensureOwnership promotes a persistent claim; bootstrap's normal ensure promotes its target while an observation pin is held. Existing loadOwned promotes on successful return, load releases its temporary claim in finally, and create/adopt failure drops only their own setup claim. Public ownerOf continues to mean actual lease held, not permission to release someone else's claim. Release of persistent ownership is an explicit retire path after observation join; it cannot erase pins or an in-flight adopter.

## Actual owner state and ordering

Keep ephemeral observation state in Documents (or a tightly scoped sibling owned by createDocuments), not a project authority registry. Each scope is `{state: acquiring|active|revoked|releasing|done, sessionIds, keys, pins, locks, captured, donePromise}`. It is registered synchronously before the first await. Key/session indexes locate affected scopes; synchronous assert checks active state, cancellation/owner admission, and **every actual held lease**. Values and guard cannot be used after callback retirement. No revision string is necessary: one held scope is the capability and its actual leases exclude policy writes; local mutations revoke it permanently, including change-away-and-back.

Add keyed *pending mutation* admission tracking to the same owners: document put/strict, metadata create/update and deletion/release mark affected keys/IDs before any await. New observations intersecting a pending conflicting mutation immediately reject conflict; they do not wait on that mutation. Once registered, any later conflicting mutation first marks the scope revoked synchronously, then awaits its donePromise **outside** docChain and session operation lanes. Only after that join does the mutation enter its existing write chain/lane. This prevents observation→pending writer→observation cycles. Existing in-progress conflicting writes admitted before the observation are detected by their pending markers; registration/check is one synchronous section.

Use a private AsyncLocalStorage callback context to reject self-waits synchronously: from inside an observation callback, put/strict on observed binding keys, create/updateMeta/delete/release/closeManagedDocument on observed session IDs, nested overlapping observation, or coordinator.close must throw `conflict` before changing admission or awaiting anything. Calls on unrelated IDs/keys may use normal owners. This small reentrancy check is internal owner lifecycle, not a public bypass token. In particular the callback may call the existing bootstrap owner for its exact captured target; it must not call normal create/target-profile/put for that target. Bootstrap retains its existing original-invocation validation and ownership. No observation API grants caller-shaped code access to private bootstrap admission.

Acquisition is exactly:

1. Validate and synchronously admit scope/check pending mutations. Capture sorted unique session IDs = existing plus invocation.targetSessionId.
2. Acquire/pin actual session OS ownership in sorted order. Await each complete acquisition and guard cancellation/revocation before another. Do not hold one session operation lane while acquiring another. Shared single-flight acquisition produces independent claims; partial failure releases every obtained claim.
3. Acquire sorted derived `doc:<binding-key>` OS leases via Ownership.acquireLease in Documents. No backend binding read happens before all locks are held. F0 does not put the callback or read-lease lifetime on global docChain.
4. For each existing source/ancestor ID, enter its session operation lane only for backend.profile/capture; verify actual held pin and scope before/after await, capture metadata, exit lane. Never read target profile. Check source metadata identity/archive and the callback's exact lineage set before semantic export; no expanding held sets in place.
5. Strictly read all binding documents under their held leases, guard after every await, capture immutable closed data. Activate scope, invoke callback outside every session lane/docChain, with guard still live. Transfer's synchronous callbacks call this guard plus genuine source/Stop/host guards. Before returning callback success, assertCurrent again.
6. Retire the capability synchronously, release all document locks in reverse acquisition order, then release all temporary session pins, attempt every disposer even if an earlier one throws, settle done only after all acquisitions/releases settle. Persistent source/bootstrap ownership is not released by this cleanup. Aggregate errors while retaining original callback result/error and exact invocation.

Global discipline is session lease → document lease → *short* session lane/read, then callback with leases but no lane. A session lane is not a cross-session lock: callback bootstrap may enter target lane because the outer lane was released. Existing persistent session leases may already be held out of sorted order; F0 does not promise global deadlock freedom against those historical owners. OS acquisition is nonblocking with existing bounded deadlines, so cross-coordinator contention yields typed conflict and complete cleanup, never an infinite wait or a new target ID.

Fresh source flow opens the actual source ManagedDocument **before** F0. Its current readonly events-array/append witness plus assertReady guards payload; owning the lease alone does not freeze same-coordinator append. F0's local create/updateMeta revocation protects mutable lineage/archive/default metadata, while cross-coordinator mutations are excluded by pinned session leases. Legacy format upgrades/repair preserve authority fields; source managed open finishes these before capture. Do not call load/repair/ensureWritableFormat on observed existing identities inside the callback. Target's original bootstrap header/format confirmation is permitted only through the existing bootstrap owner. Discovery may read a provisional ancestor chain first; after F0 captures metadata/bindings, callback recomputes the exact existing sourceFor lineage (cycle/bound limits and origin rules) and rejects mismatch/missing/excess authority before export/transfer. It never acquires a newly discovered ancestor while holding the current set.

## Mutation, deletion, release and close integration

**Documents:** put/strict mark their key pending and revoke/join affected observations before enqueueing docChain. Failed ordinary put keeps existing reporting semantics, strict rejects; neither mutates under an active observation. Strict observation reads bypass legacy getDocument, not its authorization. Other-key writes can progress because the observation is not docChain's tail. closeAdmissions(keys) marks keys deleted and synchronously revokes affected scopes; joining is a separate await, never performed from a held session lane.

**Mutations:** create/updateMeta mark the ID pending and revoke/join before withSessionOperation; recheck write admission inside the lane. Any updateMeta patch revokes, including title/model/archive/parent/origin, so no patch-field loophole. Required metadata observation values remain snapshots, not mutable aliases to managed view.header. Source fact append is detected by the F1 payload witness; F0 does not become a second fact owner. Private automatic version/journal upgrades are not authority rewrites and must preserve captured authority fields; the callback prohibition above avoids repair reentry on source IDs.

**Deletion:** current lifecycle.ts:21–34 bypasses document leases when JSONL tombstones/unlinks (`index.ts:320–354`). Change admission first: synchronously retire source session and manifest keys, revoke/join affected observations outside lanes, drain existing writers as today, then enter the session lane. Under that existing session ownership, acquire sorted manifest doc:key leases **directly via the same Documents owner** (not another public observation callback); confirm held/deleted admission state, call backend.deleteOwnedSession, notify deletion listeners, attempt all doc lease releases, then release deletion's session claim. Thus deletion and binding reads share actual OS exclusion across coordinators too, including manifest document keys. No attempt to acquire a session lease while already holding a deletion document lease. Local listeners must not wait for this deletion callback's own observation/close. A pending external observer may hold a session pin; bounded conflict is expected, and target/source identity can never be read as fresh unmanaged absence after a tombstone.

**releaseOwnership/closeManagedDocument:** at coordinator facade synchronously block new observation admission for the ID, revoke/join its scopes before managed.closeOne or session-lane release. A concurrent adopter started after explicit retirement is rejected until retirement completes; a prior independent live claim cannot be erased by temporary borrow/pin cleanup. When retirement completes and reopening remains supported, a new observation uses a new scope/lock incarnation. Deleted admission remains permanent. Internal error cleanup uses claim.release, never the public retire operation or blanket releaseOwnershipUnlocked.

**coordinator.close:** change index.ts:79 ordering to synchronously close observation admission/revoke all scopes at close entry, join observation whole lifetimes, then managed.close, then existing lifecycle drain/lock release. All cleanup stages are attempted even if an earlier one rejects; aggregate failures and preserve retryable original owners rather than clearing claims before release is attempted. The observation facility stays closed after close begins; reopening the existing ordinary coordinator surface is outside F0. Scope.done must include pending OS acquisition settlement and final releases; racing Promise.race with cancellation may wake guards but must not discard an acquisition promise which could later yield a live leaked handle. Callback is cooperative and must settle after failed guards; F0 adds no unsafe force-release timeout.

## File ownership / implementation steps

One writer owns this prerequisite and its review. Exact files: `packages/session-persistence/src/coordinator/{documents,ownership,mutations,load,lifecycle,types}.ts`, `packages/session-persistence/src/index.ts`, and `packages/session-persistence-jsonl/src/index.ts`; optional new `coordinator/binding-observation.ts` only as Documents-owned implementation, not a new public registry. Tests: new persistence `test/binding-observation.test.ts` and JSONL `test/document-observed-read.test.ts`, plus affected ownership/load/deletion/managed/bootstrap suites. No result-store/context-output edits in F0; RC03 must finish and be accepted before F1 takes that ownership.

### Task 1 — strict read and claim ownership

- [ ] Add REDs where real existing getDocument would return undefined on injected EACCES, and where a temporary observation claim is retired after another adopter gained a persistent claim. Verify failure is causal before implementation.
- [ ] Implement optional strict observed-read capability in JSONL, preserving legacy getDocument. Call assertNotDeleted using typed deleted errors and storage availability checks; catch **only** file ENOENT as absent, and recheck tombstone/currentness before returning.
- [ ] Replace private borrow booleans with exact claim handles across load/create/adopt cleanup; add pinOwnership on existing ownership slots. Reads release their own claim; loadOwned success retains a live claim; bootstrap ensure promotes and is not released by pin retirement. Serialize acquire/release state so a new claim cannot attach to an already retiring OS handle.
- [ ] Run `pnpm --filter @i-harness/session-persistence-jsonl test -- test/document-observed-read.test.ts` and persistence ownership/load focused tests. Check partial acquire and borrowed-failure cleanup rather than merely API existence.

### Task 2 — observation callback and actual mutation/deletion fences

- [ ] Add REDs with two actual coordinators in the same explicit lockRoot: under observation, other-coordinator document write cannot change captured data; same-coordinator updateMeta(parent/origin/archive) synchronously makes guard throw; callback bootstrap can obtain its target lane without hanging.
- [ ] Implement exact interfaces/states/order above, pending conflict admission, AsyncLocalStorage self-wait rejection and immutable capture. Wire put/strict/create/updateMeta/deletion/release at actual entry points; no join inside a lane/docChain. Integrate deletion's direct keyed leases before its backend deletion.
- [ ] Ensure target mode never profiles target, existing metadata reads run under short lanes, and strict document read failures become typed unavailable/deleted rather than absent. Cancellation/revocation joins every real acquisition before cleanup.
- [ ] Run `pnpm --filter @i-harness/session-persistence test -- test/binding-observation.test.ts` plus affected deletion/managed/bootstrap tests; retain named causal counters/guards in the report.

### Task 3 — close, failure cuts and connected owner review

- [ ] Add REDs for close while first/second lease is being acquired, callback transfer paused, one release rejects, and callback tries updateMeta/put/deletion/close on itself. Include ordinary reported write versus strict rejecting write controls, and independent other-key writes.
- [ ] Implement facade close/release ordering and aggregate disposal without clearing original claim state prematurely. Verify all settled acquisition/release promises are joined, live adopted document still owns its original session lease after temporary scope ends, and no failed partial scope retains temporary OS handles.
- [ ] Run affected persistence/JSONL tests and both package typechecks. Run normal reachability once the actual production consumer is present; do not add fake callers/waivers. Preserve raw logs at the fixed root-selected integrated HEAD, and obtain independent owner review before F1 dispatch.

Representative causal expectations (fixture supplies real coordinator/backend, captured request/original BootstrapRequest and genuine `realHandoff`; no fake confirmed transfer port):

```ts
// Callback is outside target lane; original bootstrap remains the owner.
await coordinator.withSessionBindingObservation!(request, async observed => {
  observed.assertCurrent();
  expect(targetProfileCalls).toBe(0);
  const result = await coordinator.bootstrapSemanticTarget(original, {
    ...realHandoff.guards,
    assertCurrent() {
      observed.assertCurrent();
      realHandoff.guards.assertCurrent();
    },
  });
  observed.assertCurrent();
  expect(['ready', 'already-ready']).toContain(result.kind);
});
// A temporary claim must not retire the bootstrap's live target ownership.
expect(coordinator.ownerOf(request.target.targetSessionId)).toBe(true);

// Separate race test: observation callback is paused without holding a lane.
const entered = Promise.withResolvers<SessionBindingObservation>();
const leave = Promise.withResolvers<void>();
const observing = coordinator.withSessionBindingObservation!(request, async observed => {
  entered.resolve(observed);
  await leave.promise;
  observed.assertCurrent();
});
const rejection = expect(observing).rejects.toMatchObject({ reason: 'revoked' });
const observed = await entered.promise;
// updateMeta admission revokes synchronously, before the writer can commit.
const changing = coordinator.updateMeta('source', { parentSession: 'other' });
expect(() => observed.assertCurrent()).toThrow();
// Release the paused callback; writer joins scope cleanup, then changes header.
leave.resolve();
await rejection;
await changing;
```

Final matrix must cover actual backend present/ENOENT/EACCES/EIO/bad JSON/tombstone; shared lockRoot contention and unsupported locking; partial multi-key acquire; lineage changed during provisional discovery; same-owner metadata ABA; source append witness; local/external deletion; exact original target bootstrap promotion; passive target-only path with source traps; callback self-write/close/nested observation refusal; other-key progress; close/release/adopter races; and all-disposers-attempted after one failure. An observation callback returning success after revocation must be rejected by the final owner guard. Original issued receipts/pins survive host cleanup failure; F0 never removes or replays them.

## Delivery boundary / root adjudication

F0 can stage and receive **owner-scoped** acceptance, but its new public capability cannot be claimed as shipping completion with only tests. The same ultimate F0+F1 vertical range must contain the real CLI `acquireCliForkTransfer` consumer in the existing result-store owner, actual stdio fork request, nonempty catalog/member transfer, ordinary target read after cold restart and original-invocation adoption. F1 passive retry invokes observation with existingSessionIds empty and never calls source hooks. CLI still validates bootstrap reservation/manifest plus unmanaged policy; F0 observation alone is not a readiness receipt or authority to execute input/model/tool work.

Root has adjudicated the owner exception above. It is bounded but broader than a standalone withDocumentReadLease method; omitting these owner joins would leave the demonstrated policy race. General project broker redesign, B3 replay authorization, storage versions, remote release and decomposition remain outside scope. Source planning itself performed no product edits/runtime/tests. Execution and review must report their actual evidence separately.
