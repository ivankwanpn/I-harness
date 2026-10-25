# Existing-session binding observation prerequisite implementation plan

Status: root-promoted executable prerequisite under the approved integrated program. Only this persistence-owner task is authorized; public fork DTOs/read adapters remain separate. Root records the immutable dispatch BASE.

> Use subagent-driven-development with one GPT-6.1 Sol implementer and independent full-range review. The assigned implementer executes this connected task without recursive agents.

**Goal:** Add an optional read-only callback which observes actual existing-session metadata and their exact project-binding documents under the existing F0 leases, revocation and cleanup lifecycle, without inventing a bootstrap target.

**Architecture:** Extend the Documents-owned binding-observation owner. Both fork and existing-session observations share actual session ownership pins, exact binding document locks, strict backend reads, pending mutation/deletion admission and original resource cleanup. Only real fork scopes retain the existing exact invocation bootstrap exception; existing-read scopes have no target and no bootstrap mutation exception.

**Tech:** Existing TypeScript, SessionCoordinator/JSONL, Windows/Linux fs-lock, Vitest, current strict observed-document backend.

**Spec:** [binding existing-session observation design](../specs/2026-10-25-existing-binding-observation.md).

**Source/requirements:** `docs/superpowers/plans/2026-10-24-fork-binding-observation.md`; actual `packages/session-persistence/src/coordinator/{binding-observation,types,documents,ownership,mutations,lifecycle}.ts` and `src/index.ts`; JSONL `src/index.ts`; section 7a in the sibling F1-C preflight. Root-supplied source checkpoint was MAIN `e8fc3d1d`, product `bc83c399`; root records the actual immutable dispatch base after documentation advances.

## Global constraints

- Preserve product `0.1.13-rc.1`, Session12, SemanticSeedV1, existing record formats and all original F0 behavior/tests.
- One connected owner task, one writer in the root-assigned checkout, no recursive delegation or concurrent production/runtime work in that checkout.
- Reuse the same maximum **64 existing session IDs** and safe-ID rules. Do not widen into a general snapshot, managed-document freeze, arbitrary document-read API, project registry or general lock export.
- No `BootstrapInvocation`, target ID, target reservation, target absence or bootstrap mutation exemption exists on the new request/scope. No synthetic invocation or fake target is legal.
- No new store, receipt, persisted format, quota, capability authority, model/input/tool effect or public fork rollout. Pure decomposition is deferred; factor only the shared lifecycle necessary for this callback.
- The callback captures current backend metadata and bindings only. It does **not** freeze same-coordinator managed fact append, establish READY, refresh a captured managed header, implement `localVisible`/`anchorVisible`, or authorize a host project scope. Those remain explicit later host-wrapper obligations.
- Use controlled temporary roots and actual supported native locks/JSONL backend. No user sessions, installed profiles, providers, remote publication, release or reachability exemptions.
- Package-CWD sequential Vitest: `--maxWorkers=2 --minWorkers=1`. Preserve setup failures, causal REDs, native counts and raw command/source receipts; do not repeat unrelated passing suites.

## Exact public contract to implement

Add the following optional coordinator capability and public types. The names/fields below are root-frozen; do not add public fields during implementation without a causal root ruling.

```ts
export interface ExistingSessionBindingObservationRequest {
  sessionIds: readonly string[];
  signal?: AbortSignal;
}
export interface ExistingSessionBindingObservation {
  assertCurrent(): void;
  metadata(sessionId: string): Readonly<SessionMeta>;
  binding(sessionId: string): ObservedDocument;
}
// SessionCoordinator
withExistingSessionBindingObservation?<T>(
  request: ExistingSessionBindingObservationRequest,
  run: (observation: ExistingSessionBindingObservation) => Promise<T>,
): Promise<T>;
```

`ObservedDocument` remains the existing closed `{kind:'absent'} | {kind:'present',value:unknown}`. Only internally derived `desktop-session-project-${sha256(id)}` keys may be read. Both metadata and binding getters accept requested IDs only, guard the scope first, and reject unknown IDs as existing `SessionBindingObservationError('invalid')`. Their returned captured JSON data is deeply immutable; no caller reference survives capture.

Request validation is synchronous before admission/acquisition: plain own request data; only required `sessionIds` and optional `signal`; no extra/undefined/accessor/symbol/nonenumerable/proxy fields; a plain dense array with exactly 1..64 distinct safe IDs; genuine AbortSignal using existing intrinsic-brand/state/listener handling; callback function. Copy IDs from own descriptors without invoking iterators/getters. Reject `target`, `invocation`, `existingSessionIds`, document keys and arbitrary caller binding selectors. Copy/close the request before the first await. Pre-aborted branded signal refuses revoked before acquiring, regardless of caller-shadowed fields.

Advertise the new optional capability under exactly the same facade condition as F0: enabled supported ownership locking, actual `readDocumentObserved`, and Windows/Linux production capability. Keep current F0 advertisement unchanged. A fake/custom/unlocked backend without the capability does not get a weaker fallback. Reuse `SessionBindingObservationError` reasons `unsupported|invalid|conflict|revoked|deleted|unavailable` and existing normalization. Missing requested session, archived metadata, invalid identity, malformed/unreadable metadata or strict binding failure never invokes callback; preserve actual deleted vs unavailable classification where the backend supplies it. Binding document ENOENT alone can be absent, but a missing session/root cannot.

Success returns `T` only after final guard and complete cleanup. A caller callback error remains the original error when cleanup succeeds. Cleanup failure throws the existing aggregate style preserving original `callbackResult`/`callbackError`; for this API attach frozen captured `sessionIds` rather than fabricating `invocation`. Retain exact original cleanup debt for `coordinator.close` retry. These are host diagnostic fields, not a wire DTO or new completion receipt. Existing F0 aggregate `invocation` diagnostics and callback behavior remain byte-for-byte equivalent in meaning.

## Frozen file map

| File | Allowed responsibility |
|---|---|
| `packages/session-persistence/src/coordinator/types.ts` | Add exact request/observation types and optional SessionCoordinator member. Reuse existing ObservedDocument/error. |
| `packages/session-persistence/src/coordinator/binding-observation.ts` | Add existing-read scope discriminant, shared capture/acquire/callback/retire engine and new entry. Preserve original fork-specific validation/target exception. |
| `packages/session-persistence/src/index.ts` | Export types; conditionally expose actual owner method with existing capability gate. |
| `packages/session-persistence/src/coordinator/documents.ts` | Only necessary type/return plumbing if shared owner shape requires it. Existing revocation/docChain/lease behavior remains. |
| `packages/session-persistence/src/coordinator/{mutations,lifecycle,ownership}.ts` | Existing integration seams should work through shared owner indexes. Edit only if a causal new test proves an actual bypass; no unrelated lock/cleanup rewrite. Report such change explicitly. |
| `packages/session-persistence/test/existing-binding-observation.test.ts` | New actual callback contract, authority lifecycle, bootstrap separation, native acquisition/disposal controls. Keep fixtures purpose-scoped; copy small actual fixture patterns, not a new generic framework. |
| `packages/session-persistence/test/binding-observation.test.ts` | Preserve original population/expectations. Add only narrowly necessary mixed-scope regressions where original F0 qualification needs them. Do not move/delete assertions to manufacture equivalence. |
| `packages/session-persistence-jsonl/test/document-observed-read.test.ts` | Existing strict backend contract regression; add a missing causal backend control only when needed. |

JSONL product changes are not planned: actual `profile` already checks the session tombstone, and actual `readDocumentObserved` checks root/tombstone before/after reading and distinguishes ENOENT. Any discovered backend gap needs a bounded causal finding/root ruling. No edits to SDK, CLI, Gateway, Desktop, ContextOutput, core-agent, assembly, public fork or host observation adapters.

## Shared-owner implementation invariants

Use a discriminated scope union. This is implementation guidance for the existing owner, not a public scope type:

```ts
type Scope = CommonScope & (
  | { kind: 'fork'; target: BootstrapInvocation }
  | { kind: 'existing-read' }
);
```

`CommonScope` retains current actual IDs/keys, acquiring/active/revoked/releasing/done state, pins/locks, original done/cleanup, signal and callback-finished state. It must not grow a view/payload/project cache. Capture fork target invocation only on `kind:'fork'`. In `bootstrapMutation`, only that branch can compare canonical target invocation and enter its `allowed` list. An intersecting existing-read callback self-bootstrap/resume throws conflict before pending admission; an external bootstrap/resume revokes and joins the read scope before B2 owner work. Never evaluate `canonicalJsonData(undefined)` or cast a missing target into a valid invocation.

The acquisition/release order remains:

1. Validate/copy request; synchronously check closed/deleted/pending/retiring intersections and register whole scope before its first await. Existing fork admission/retirement semantics must remain intact.
2. Sort actual requested existing IDs and acquire `ownership.pinOwnership(id)` for all. Record a newly obtained claim before any after-await guard can throw. Every assert checks held native slot incarnation/cleanup debt, signal and owner/scope admission. No session lane is held while another lease is acquired.
3. Derive/sort exact binding keys and acquire `ownership.acquireLease('doc:'+key)`. Strict backend reads happen only after all locks are held. No docChain is held around observation.
4. For **every requested ID**, enter its short `withSessionOperation(id)`, guard, call actual backend `profile`, guard, require actual sessionId and nonarchived metadata, capture immutable strict data, exit lane. Metadata never comes from the frozen managed view/header or ordinary `getDocument`. Under shared session pins, cooperative other coordinators cannot rewrite that session; local `updateMeta` is fenced by pending admission/revocation.
5. Strict-read each derived binding through actual `readDocumentObserved` with before/after guards and closed result validation. Capture immutable data. Activate scope and call user callback under the existing AsyncLocalStorage stack **outside all session lanes/docChain**. Getter methods and callback final return guard active state and actual claims/locks. No READY/model/project policy is inferred here.
6. Retire synchronously before disposal await, then release document locks in reverse acquisition order, then temporary session claims; attempt all independent original disposers. Scope done includes pending acquisition settlement and complete original cleanup. Do not lose a delayed successful acquisition to cancellation/Promise.race. Release only this scope's claims, preserving concurrent persistent adopters and other observations.
7. Cleanup error retains actual original resource handles and dependent owners. Coordinator close may retry exact supported release; a failed native release that consumed `held=false` stays explicit debt rather than becoming successful no-op. No replacement owner/service and no force-release timeout.

Current integration seams must cover both scope kinds without duplicate state:

- `mutations.ts` `metadataMutation` synchronously `beginMutation([id],[])`, joins before lane, then create/updateMeta under ownership. Any patch revokes permanently; ABA does not revive a scope. Pending mutation admitted first makes later intersecting observation fail conflict without waiting.
- `documents.ts` `putDocumentStrict` synchronously marks pending key/revokes and joins before docChain/write lease. Ordinary `putDocument` self-write must throw conflict before its normal reporting catch can swallow it. Unrelated keys progress.
- `lifecycle.ts` delete synchronously marks affected session/manifest docs deleted, joins outside lane, then uses session ownership + actual document leases for tombstone/remove/listeners. Later observation is deleted, not absent.
- Facade `closeManagedDocument`/`releaseOwnership` use `beginRetirement`, revoke/join before closing/releasing; later adopters during retirement conflict. Later ordinary reopen after successful retirement gets a fresh scope. `coordinator.close` permanently closes observation admission, joins acquisitions/callback/releases, preserves dependent owners on unresolved cleanup and attempts independent drainage.
- AsyncLocalStorage self-conflict applies to the entire nested stack. Overlapping fork/read observations and self metadata/binding mutation, profile/load/loadOwned/open/ensureWritableFormat/delete/retire/close refuse without revoking an otherwise current outer scope. Disjoint nested scopes retain outer protection and unrelated work progresses.

## One connected task and executable test cycle

## Task 1: Add existing-session observation without weakening F0

**Consumes:** Exact API above, existing `createBindingObservations`/Ownership/strict JSONL and original F0 tests. **Produces:** New optional read callback plus qualified shared lifecycle only. No production host consumer is claimed in this task.

- [ ] **Step 1: record the immutable source and capability gap.** Root supplies actual BASE/worktree. Read the complete original binding-observation tests, strict backend tests and owner code. Record the absence of the new optional method as capability/setup evidence; missing method/type errors are **not** a semantic RED. Preserve original F0 results and raw failures. Do not create a synthetic-target test adapter as a substitute for the new API.
- [ ] **Step 2: write closed contract and actual-storage tests.** Add `existing-binding-observation.test.ts` using `createJsonlBackend`, `createSessionCoordinator`, real temporary roots and native lock wrapper pattern from existing F0 tests. Tests call the real new method. Use backend-created sessions when testing temporary-only claims and coordinator-created/adopted sessions when testing retained persistent owners. Record causal behavioral REDs when observable; do not make intentionally unsafe intermediate code or weaken an assertion to force a RED.
- [ ] **Step 3: add exact public types/facade and factor the common lifecycle.** Add the types/optional entry and discriminated scope. Retain fork request capture/target exception separately. Reuse shared indexes/pins/locks/strict reads/cleanup as described above. No alternate `getDocument`/profile bypass and no target on the new request. Run the focused tests and fix actual observed causes.
- [ ] **Step 4: qualify mutation/deletion/retirement/native-cleanup cuts.** Implement missing integration only where the tests below show a causal bypass. Confirm all early-failure cuts release obtained temporaries and preserve independent live owners; preserve original diagnostics for both API kinds. Qualify existing/read/fork interactions and original bootstrap exemption through actual B2.
- [ ] **Step 5: run the required affected regression range and type checks.** Run package-CWD commands below sequentially once the focused cycle is green; repeat only changed/failed/unresolved coverage. Save exact source/CWD/command/exit/raw outputs and native acquisition/release counts. Report platform evidence honestly; Windows test success does not prove Linux execution.
- [ ] **Step 6: report the complete connected range for root review.** Root receives all BASE..HEAD changes, real test results, setup/failure corrections, supported capability conditions, native cleanup debt behavior and explicit later host obligations. This task does not make public fork callers or strict host readers complete. Commit only the connected source/tests after verification, freeze for review, and let root integrate.

### Actual RED/GREEN control matrix

Each row is an independent assertion group over real owner behavior. Use deterministic `Promise.withResolvers` barriers rather than sleeps to position races. Attach rejection handlers before triggering revocation so expected rejection is not an unhandled test failure. Release barriers/fixture-native handles in finally; do not conceal retained cleanup debt by blindly closing every coordinator after irrecoverable-native tests.

| Control | Concrete setup/trigger | Required evidence |
|---|---|---|
| E00 optional support | Actual supported locked JSONL facade; then lock disabled and backend without `readDocumentObserved`. Preserve existing F0 capability assertions too. | New method exists only under the supported gate and calls the actual owner. Unsupported facade omits it; no tolerant-read/unlocked fallback. Runtime/platform claims limited to environments actually exercised. |
| E01 closed contract | Plain dense `sessionIds:['source']`; then empty,65,duplicate/unsafe IDs; request/array proxies, index accessors, subclass/custom iterator, sparse/extra/symbol/undefined fields, fake signal and old `target` field. | Valid actual callback works; invalid paths are `invalid` before any native acquire/profile/binding read. Zero accessor/iterator calls. Exactly64 existing sessions accepted using actual created files; no extra target session lease or binding key is acquired. |
| E02 immutable actual metadata | Actual backend source metadata contains current title/parent/workspace and nested model selection; actual derived binding contains closed data. Mutate original request array while acquisition is held. | Captured original ID set only; `metadata/binding` values immutable, unknown ID rejects, after-return getters/guard reject. Strict backend profile used once per captured ID; no ordinary `getDocument`. Captured metadata is actual backend state, not an earlier managed header. |
| E03 archive/missing | Archive source before invocation; missing source file; backend profile failure; malformed identity. Include archived source with a previously opened stale managed document. | No callback; unavailable/deleted classification as actual backend supports. Absent binding does not make session valid; stale header cannot bypass actual archived profile. No assertion that persistence validates a managed view. |
| E04 metadata ABA/pending | Hold callback; call `updateMeta('source',{title:'other'})`; assert scope immediately, before yielding. Attempt another read observation while mutation waits. Let callback settle, then write title back and acquire fresh read scope. Repeat archive mutation. | Old scope synchronously revoked; mutation waits for whole callback/cleanup; later observation conflicts while pending; old scope stays revoked after ABA; fresh captures current state. Actual backend remains unchanged until barrier release. |
| E05 strict binding mutation/read | Hold scope then local strict/ordinary binding write; perform unrelated-key write; change binding away and back after original callback settles. In backend strict-read tests exercise malformed JSON, EACCES/EIO, missing/inaccessible root and tombstone appearing after file read. | Matching key revokes/joins before write; old scope never revives after binding ABA; unrelated key progresses; strict failures never collapse to absence. No arbitrary-key getter. Existing JSONL controls remain intact. |
| E06 delete | Hold callback for source; call real `deleteOwnedSession('source',{documents:[derivedBindingKey]})`; inspect immediate guard and before/after tombstone/file state. Retry observation after deletion. | Revoked synchronously; actual deletion waits cleanup then uses owned tombstone+document locks; post-delete observation is deleted, not absent. Actual deletion listener runs only after owned deletion; no self-join deadlock. |
| E07 release/closeManaged | Preopen actual managed source; hold read observation; invoke `releaseOwnership` or `closeManagedDocument` outside callback. Attempt later adopter before held callback settles. | Immediate revoked guard, lifecycle remains pending until original callback/releases finish; later adopter conflicts; old scope never revives; successful retirement permits ordinary reopen/new scope. No synthetic target involved. |
| E08 coordinator close/abort cuts | Cold temporary-only IDs; instrument real native acquisition at each session/doc lock and pause before returning handle. Abort or close at each cut. Include callback and disposal-in-progress cuts. | Close waits actual pending acquisition, then releases every acquired handle; callback not entered for preactive cuts; no late lease leak; dispose single-flight, no double release; closed admission stays revoked. Branded signal overrides never execute caller methods/getters or strand lifetime. |
| E09 self-wait stack | Inside read callback call matching updateMeta, strict/ordinary put, profile/load/loadOwned/open/ensureWritableFormat, delete/release/closeManaged/close, overlapping read/fork observation. In disjoint nested callback attempt mutation of outer ID. | Conflict before pending admission/mutation; original outer and inner scopes remain current after caught refusal. Unrelated ID/key normal operations progress. No wait timeout accepted as success. |
| E10 cross-coordinator exclusion | Two actual coordinators share root/lock root; first read scope holds session+binding native leases, with no preexisting persistent fixture lock obscuring cause. Second attempts updateMeta and binding write/new observation with bounded lock deadline. | Actual lock conflict and zero foreign mutation; first remains current. After original temporary scope release, second succeeds. Report this as real cross-coordinator/native evidence, not proof of unrun platforms. |
| E11 bootstrap separation | Actual existing-empty source request built from literal existing header digest/prefix as current F0 `existingAncestor` fixture. Inside read callback attempt bootstrap/resume targeting that observed ID. Outside callback start those same operations while read held. Also test bootstrap-first pending header. | Self-bootstrap/resume conflict without revoking current read or issuing backend birth work. External bootstrap/resume synchronously revokes read and waits its whole lifetime, then actual B2 proceeds with original invocation. Bootstrap-first pending admission makes read conflict immediately. No existing-read target exemption. |
| E12 preserve original F0 exemption | Run unmodified F0 original target-only trap, exact-invocation bootstrap/resume/join/unknown recovery, existing ancestor external bootstrap revocation and malformed/one-shot capture controls. Add mixed fork/read scopes if needed. | Exact real fork target still works without target profiles; other invocation or existing-ID mutation still conflicts/revokes as before. No broadened exception, lost original F0 test population or helper-only replacement. |
| E13 claim integrity/partial acquire | Preexisting persistent source adopter plus temporary read pin; concurrent temporary observation; fail a later document acquisition after earlier sessions/doc locks are held. | Releasing one read scope never releases live adopter/other scope claim. All obtained partial temporaries release; held/authority counts separated; sorted actual acquisition order recorded. Independent unrelated work still works after failure. |
| E14 native failure before action | Wrap real native document lock release to throw once **before** raw release, then succeed on same handle. Preserve a preexisting persistent source owner. | Original callback result retained in aggregate diagnostic with exact sessionIds/no invocation; all independent disposers attempted; dependent persistent owner survives unresolved close; explicit close retries that same handle and completes when release is proved. |
| E15 consumed-native unknown | Wrap real native release to perform raw release, then throw. Repeated close/retry follows current F0 ownership debt semantics. | Explicit unresolved debt remains even though raw held=false; later no-op not reported success; no new lease acquisition/owner replacement used to erase it; dependent source retained. Remove irrecoverable coordinator from normal afterEach and release only fixture-held raw handles explicitly. Preserve original raw failure/counters. |
| E16 callback/error retirement | Callback returns literal original result, throws original Error, gets revoked before final return; inject cleanup failure with callback error too. | Result only after final guard+cleanup; original callback error preserved when cleanup succeeds; aggregate retains callbackResult/callbackError on cleanup failure; no read data escapes a revoked scope. Captured IDs frozen in diagnostic; F0 invocation diagnostic unchanged. |
| E17 explicit non-freeze boundary | Open actual source before read scope; capture event count; inside callback admit a genuine managed metadata fact through document fact port, as original F0 test does. | Fact append can commit and count changes while metadata/binding scope remains current. This proves the API does not freeze managed facts. Test does not claim it implements host witness/predicate/body guards. Later host consumer must reject stale view results itself. |

At least E02/E04/E06/E08/E10/E11/E14/E15 use actual native resources and backend effects, not mocks returning success. Native wrapper mocks may position/fail real acquisition/release; they must call original native primitives and preserve actual handle state. Profile/strict-read fault injection must preserve raw error evidence. No fake READY/project authority or constant confirmed transfer port is part of this task.

### Focused executable test skeletons

These pin expected sequencing/observables for the new test file; the writer supplies small actual fixture/barrier helpers using the existing F0 patterns, with no production helper bypass.

```ts
// E04: synchronous revocation and backend-write join, then ABA/new scope.
const entered = Promise.withResolvers<ExistingSessionBindingObservation>();
const leave = Promise.withResolvers<void>();
const running = c.withExistingSessionBindingObservation!({sessionIds:['source']},
  async observed => { entered.resolve(observed); await leave.promise; return 'old'; });
const rejected = expect(running).rejects.toMatchObject({reason:'revoked'});
const observed = await entered.promise;
const changing = c.updateMeta('source',{title:'other'});
expect(() => observed.assertCurrent()).toThrow();
expect((await backend.profile('source')).meta.title).toBe('original');
await expect(c.withExistingSessionBindingObservation!({sessionIds:['source']},
  async () => 0)).rejects.toMatchObject({reason:'conflict'});
leave.resolve(); await rejected; await changing;
await c.updateMeta('source',{title:'original'});
expect(() => observed.assertCurrent()).toThrow();
await c.withExistingSessionBindingObservation!({sessionIds:['source']},
  async fresh => { expect(fresh.metadata('source').title).toBe('original'); });
```

```ts
// E11: no bootstrap exemption on an ordinary read scope.
// original is a genuine existing-empty request for source, constructed from
// actual source header bytes + legacyPrefixDigest, not a fake operation port.
await c.withExistingSessionBindingObservation!({sessionIds:['source']}, async read => {
  const writes = vi.spyOn(backend,'prepareBootstrapHeader');
  await expect(c.bootstrapSemanticTarget(original,originalGuards))
    .rejects.toMatchObject({reason:'conflict'});
  await expect(c.resumeSemanticTarget(original.invocation,originalGuards,original))
    .rejects.toMatchObject({reason:'conflict'});
  expect(writes).not.toHaveBeenCalled(); read.assertCurrent();
});
```

```ts
// E17: the API is metadata/binding observation, not managed fact freezing.
const source = await c.openManagedDocument('source');
await c.withExistingSessionBindingObservation!({sessionIds:['source']}, async read => {
  const count = source.view.events.length;
  expect((await source.metadata.admit({type:'plan/mode',mode:'on'})).kind).toBe('committed');
  read.assertCurrent();
  expect(source.view.events.length).toBeGreaterThan(count);
});
```

## Required verification commands and acceptance

Run sequentially from the listed actual package CWD. Begin with focused new+original F0 tests, then broaden once the owner implementation has stabilized:

```text
CWD packages/session-persistence
pnpm exec vitest run test/existing-binding-observation.test.ts test/binding-observation.test.ts --maxWorkers=2 --minWorkers=1
pnpm exec vitest run test/ownership.test.ts test/strict-document.test.ts test/load-gate-coverage.test.ts test/managed-fact-batch.test.ts test/semantic-bootstrap.test.ts --maxWorkers=2 --minWorkers=1
pnpm typecheck

CWD packages/session-persistence-jsonl
pnpm exec vitest run test/document-observed-read.test.ts test/delete-owned.test.ts test/bootstrap-physical.test.ts test/retained-format-ownership.test.ts --maxWorkers=2 --minWorkers=1
pnpm typecheck
```

If factoring changes shared journal/managed behavior, add the causally affected existing package test files and record why; do not substitute full-population count alone for specific original F0 controls. Preserve any existing unrelated failure as distinct evidence, with no assertion waiver. No host builds, providers, production runtime or release operation is required for this prerequisite. Root integrates/types affected downstream packages on its fixed integrated source separately.

Acceptance requires actual optional method reachability through `createSessionCoordinator` under the real supported gate; strict current existing metadata+binding under native leases; every matrix obligation with source-bound raw results; original F0 exact target semantics/tests preserved; complete original cleanup/retry evidence; and a reviewed connected range. A new test-only direct owner consumer does not claim a production strict-reader rollout.

## Explicit later consumer obligations

The future CLI/Gateway host wrapper must open the actual ManagedDocument outside this callback, establish actual READY through existing owners, and reconcile immutable seed identity with freshly observed current metadata. It must keep actual broker/project/host/Stop authority current, derive typed full-commitment local visibility and exact inherited anchor/extent visibility through approved pure helpers, and guard managed view/events identity/count before/after async reads and predicate/body/search I/O. This prerequisite implements none of those facts or predicates and cannot make a frozen header current.

Public fork receipt lookup remains a separate original-invocation route **before source profile, busy, fence or flush work**. Do not replace it with this ordinary read callback or require a surviving source for target receipt adoption. Public fork DTOs/attempt lifecycle, SDK/CLI/Gateway/Desktop rollout, ContextOutput strict host adapters, C2/instruction IDs, D2/B3 and R6 remain unimplemented/unqualified by this task.
