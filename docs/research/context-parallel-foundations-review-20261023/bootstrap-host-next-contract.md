# Bootstrap host next-contract resolution

Status: targeted read-only contract recommendation, not implementation, plan approval, or whole-B acceptance. Inspected the accepted host checkout `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main` at the supplied reviewed revision `3946af7755581c5ee3a3ca1be8dd53ed95a123a2`. Reused `task-2-report.md`, `task-2-review.md`, both original Task3 preflights, the root continuation draft, and the canonical approved R4B spec/plan. No tests, runtime, Git/index operations, product changes, or subagents. This report is the sole write. Product `0.1.13-rc.1`, Session `11`; decomposition-only 28/43 remains deferred.

## 1. Fixed constraints versus selected recommendations

Already fixed: the existing coordinator is the sole bootstrap owner; complete original invocation and manifest identify recovery; empty artifacts use the accepted literal without calling either dependency method; target association must precede artifact/seed/completion readiness; saved project identity never restores roots; original artifact owners/operations and branch-visible reference evidence remain authoritative; passive confirmation cannot create missing grants; no automatic restart on adoption. The accepted READY retrieval foundation is not reopened here.

The APIs, digest addition, and admission-order changes below are recommendations to freeze together before dispatch. They resolve the root draft's open contracts; they are not descriptions of already implemented methods. In particular, the current `BootstrapGuards` has only `signal/assertCurrent/dependencies`, `adopt()` begins with dependency reconciliation, and the actual spawn/fork callers still use legacy creation paths.

## 2. Separate optional host phase on the same bootstrap owner

Add these persistence-owned types in `session-persistence/src/coordinator/bootstrap-types.ts`, exported alongside the existing bootstrap types. No project roots or artifact receipt enters them:

```ts
interface BootstrapTargetPreparationRequest {
  invocation: BootstrapInvocation; // all five fields, captured own data
  manifestDigest: string;
}
type BootstrapTargetPreparationOutcome =
  | { kind: 'confirmed' }
  | { kind: 'blocked'; reason: 'unknown' | 'unavailable' | 'conflict' | 'policy' };
interface BootstrapTargetPreparationPort {
  confirm(request: BootstrapTargetPreparationRequest,
          current: () => boolean): Promise<BootstrapTargetPreparationOutcome>;
  reconcile(request: BootstrapTargetPreparationRequest):
    Promise<BootstrapTargetPreparationOutcome>;
  assertTargetCurrent(): void;
}
interface BootstrapGuards {
  signal?: AbortSignal;
  assertCurrent(): void; // existing NEW-work source/action/Stop predicate
  dependencies: BootstrapDependencyPort;
  targetPreparation?: BootstrapTargetPreparationPort;
}
```

`assertTargetCurrent` is a synchronous, read-only lifetime/revision check. It never loads, binds, writes, refreshes its baseline, invokes source currentness, or manufactures a successful phase. The function-bearing port is host composition, not serialized authority. Strictly validate/copy the request and closed data outcomes. Generic persistence users may omit the port. Actual broker-managed callers must supply it; a missing Gateway port is a caller wiring failure, not permission to treat that target as unmanaged.

In `coordinator/bootstrap.ts`:

1. Preserve header reconcile/issue and the private incomplete attachment. After confirmed header and attachment, set the existing phase to `dependencies`; call `targetPreparation.confirm` **outside** `withSessionOperation`, before `dependencies(...)`, even if the artifact table is empty. Pass the same current predicate used for NEW dependency work.
2. On host confirmation, call `assertTargetCurrent`; then run dependency confirmation. Recheck target currentness after that await, before each new seed/completion issuance, through the existing admission's `assertCurrent` wrapper, and at the final readiness boundary. Keep the existing source/action predicate for all new work.
3. In `adopt`, after `checkBirth`, call `targetPreparation.reconcile`, then check target currentness, then passive dependency reconciliation, compare the original completion closure, confirm the original frames under the existing held owner, and check target currentness again before `entry.control.ready()` / returning the receipt. This also applies to the final adoption inside a fresh run.
4. Passive adoption does **not** call the old source-sensitive `guards.assertCurrent` or require a nonaborted launching action merely to confirm already-issued original bytes. The host port supplies current target admission/visibility/lifetime. A closed target, revoked host authority, or retired management admission still blocks. Confirmation under the held session/artifact owner remains required; structural `inspectBootstrap` alone never makes READY.
5. A configured host phase failure maps conservatively to the existing `blocked/dependency-unavailable` (and its original token); unrecoverable missing caller intent maps to `payload-required` before attempting the phase. Malformed/unknown host returns never count as confirmed. Preserve the existing public phase/reason unions for this slice; document that `dependencies` covers host preparation plus dependency work. No new durable receipt, event, reservation, or Session version is needed for this host phase.

The same capability can see `confirm` followed by `reconcile` in one run. Its target revision baseline must remain the first successfully prepared baseline for that attempt; do not reset it during final adoption and thereby hide a revoke/restore ABA. A new retry may acquire a new genuine current target baseline while retaining the identical immutable invocation/intent.

## 3. Original project intent and a verifiable digest addition

There are three distinct values; absence of a broker is not evidence of broker-confirmed unassigned ownership:

```ts
type BootstrapProjectIntent =
  | { kind: 'unmanaged' } // host has no project-binding owner
  | { kind: 'unassigned' } // real broker selected its unassigned workspace
  | { kind: 'project'; projectId: string };
interface BootstrapRequestIntent {
  version: 1;
  requestCoreDigest: string;
  project: BootstrapProjectIntent;
}
```

Recommended immutable addition: preserve the approved caller logical request preimage (source identity/selection/task/role/creation intent) as `R`. Compute `requestCoreDigest = H('ih.bootstrap.request.core.v1', R)` and `invocation.requestDigest = H('ih.bootstrap.request.v1', {version:1, requestCoreDigest, project})`. Here `H` is the approved SHA256 UTF-8 domain + NUL + `canonicalJsonData` convention. `R` has no invocation requestDigest, manifest, closure, mutable scope revision, roots, or receipt. Freeze the additional core domain and independent literal vectors. This explicit two-level form allows recovery without retaining task/seed payload in the project document. It does not make a submitted hash trustworthy: the real new caller computes/checks `R`, and the real host validates project selection before issue.

Persist/retain `requestIntent: BootstrapRequestIntent` with the **existing caller's** operation intent. For managed spawn/team, add it to shared `ChildBootstrapIntent` and the strict V2 start/team validation/fold paths; it is immutable with the invocation and clocks. For SDK/Desktop, include it in the fork-only request and retain it with invocation in transport errors/retry state. For detached import and direct durable helpers, expose it with their existing private bootstrap invocation option. No field goes into tool/model parameters. A generic nonbroker caller deliberately computes the `unmanaged` variant. A broker caller may never downgrade to it on failure.

There is no need to extend the existing project document `{version:1, projectId?}`, SeedHeader, header stage, or artifact closure for this recommendation: the invocation already enters the manifest, and thus binds the project intent transitively. The broker verifies the outer request digest from the captured intent before any write. Existing start/team records and retry objects are intent owners, not a new authority store.

Cold recovery rules are precise:

- A real committed original start/team intent or retained original fork/import intent supplies both the core digest and intended project. Recompute its outer digest, compare the full inspected invocation, then compare target durable ownership. It may resume the original payload only when that exact payload is available.
- A saved target project document may supply a **candidate** project value when the actual original caller still retains the request core digest (or can reproduce the exact original `R`). Recompute the outer digest with that candidate. Only exact equality permits using the saved value. Distinguish absent document from an explicit unassigned document. Never recover `unmanaged` from a broker document.
- Invocation/requestDigest alone cannot invert a hash. A plain saved projectId without the original core digest/intent is insufficient; return payload-required/blocked. Missing target binding cannot be filled during passive adoption. This limitation is intentional and recoverable by supplying the original caller intent, not by recapturing today's source project.
- Existing durable READY content can still be independently read through the accepted READY read paths. Failure to reconstruct a bootstrap caller's intent is not permission to mutate or invalidate that existing content.

**Actual pretransport constraint:** SDK and Desktop must mint the complete invocation before transport. Gateway cannot insert its selected project afterward without changing the operation identity. Desktop's actual selected project state supplies a candidate before minting; Gateway checks it against the real broker on NEW work. A client without that state needs a read-only project-state lookup through the existing project surface before minting, or it reports unavailable. CLI/standalone without a broker uses explicit unmanaged intent. No server-minted replacement invocation, silent requestDigest rewrite, or automatic raw fallback. This is a narrow required change to the approved Task4 wire/intent signatures, to freeze with their consumers before implementation.

## 4. Broker method and exact incomplete-target proof

Add a host-only factory to `desktop-gateway/src/project-scope.ts`:

```ts
interface BootstrapProjectCapture {
  invocation: BootstrapInvocation;
  requestIntent: BootstrapRequestIntent;
  sourceSessionId?: string; // actual caller; optional for explicit imports
  sourceAvailable(): boolean;
  assertNewWorkCurrent(): void;
  targetAvailable(): boolean; // attempt/host/target lifetime, not parent's runtime
}
interface BootstrapTargetScope {
  projectId?: string;
  scope?: SessionProjectContext;
  revision: string;
}
interface BootstrapProjectPreparation {
  targetPreparation: BootstrapTargetPreparationPort;
  targetScope(): BootstrapTargetScope;
  close(): void;
}
prepareBootstrapInheritance(capture: BootstrapProjectCapture):
  BootstrapProjectPreparation;
```

Factory capture is synchronous descriptor-safe own-data capture; functions are captured once. It validates the outer digest and refuses unmanaged mode. It does not await source/profile, create another operation, or bind anything. `confirm` supplies the eventual manifest request and checks it against the retained full invocation; thus the caller can construct the capability before the coordinator has calculated the manifest. No invented public manifest builder or placeholder digest is needed. The object is attempt-local and is closed in caller cleanup only after its bootstrap/dependency work settles.

`confirm` and `reconcile` run their bounded work in existing `serial(target)` and use `coordinator.inspectBootstrap(fullCapturedInvocation)`. Require `reserved` or `ready`, exact returned invocation, a token with the same manifestDigest, and the original target ID. Reject absent/conflict/unavailable/unknown manifest. Inspection is read-only and does not wait for `entry.flight`; do not call bootstrap/resume recursively from the port. Do not call `profile`, `snapshot`, `openManagedDocument`, `resolveOwner(target)`, `nativeScopeFor(target)`, or READY `resultReadScopeFor(target)` for this proof.

NEW confirm resolves the genuine source via current broker ownership/catalog (ordinary source profile/visibility is valid), verifies that its selected project equals the originally captured intent, and captures source revision/currentness before waits. For an import without source lineage, require the host's explicit selected project intent/current catalog and existing import admission; never infer a parent. Preserve caller-specific visibility: public forks pass conversation visibility; managed protocol1 children use their actual internal caller admission; approval-review remains a private reviewer operation and must not be made public by weakening `createSessionRuntimeVisibility`. The incomplete target proof is the trusted original caller admission plus actual inspected operation, not a synthetic SessionMeta passed through the visibility callback.

Under target serial: await any existing load; refresh from `getDocument(key(target))`, using the same strict closed parser as `load`, rather than accepting a cached binding after uncertain work. An existing binding must match the intended project exactly. If absent, NEW confirm may save only that value, with source/caller/target checks immediately before issuance. Explicit unassigned writes `{version:1}`. Passive reconcile requires existing exact durable binding and performs **no save**, source resolution, ancestor traversal, or source availability check.

Both paths require the intended project's current confirmed catalog entry and actual canonical directories. Validate the already selected scope with the existing `resolveScope`, outside any catalog queue/drain cycle; capture revision before filesystem awaits and reject any intervening change. Do not install the returned scope as a new authority or revive a withdrawn catalog entry. Check broker closed, `referenceFailure`, missing/empty/withdrawn project and target admission before/after each await. An unassigned broker scope remains its real workspace authority, not a missing project fallback.

After exact readback, initialize the private target getter. It reads only this target's own binding plus this broker's current catalog/withdrawal/reference/closed state. Its revision includes target binding revision, project catalog revision, and reference revision (use existing counters). Getter failure or revision mismatch invalidates the attempt permanently. Roots come only from this live getter; callers receive copied arrays, never mutable broker state. Recheck durable binding/inspection on a new attempt; the synchronous getter provides in-process currentness within an attempt, not cross-process monitoring.

`assertTargetCurrent` checks capability open, genuine targetAvailable, management availability, own binding, and frozen revision. Parent runtime close is deliberately absent. Source currentness used by NEW transfer is a separately captured source lease/project revision/action check. No source lease is reacquired for passive adoption.

## 5. Artifact host access: split source permission from target lifetime

Keep core `BootstrapDependencyRequest/Outcome` and the artifact owner's separate WeakMap transfer scope. Replace the draft's ambiguous `available()` with these exact named hooks:

```ts
interface SeedDependencyHostAccess {
  binding: SeedDependencyTransferBinding;
  sourceAccess: ContextAccess;
  sourceAvailable(): boolean;
  assertSourceCurrent(): void;
  targetAvailable(): boolean;
  targetScope(): { source: NonNullable<ContextCapture['source']>; revision: string };
  assertTargetCurrent(): void;
}
```

`targetScope` is synchronous and works only after host preparation. Gateway derives `source` with the existing `contextSourceIdentity(workspaceKey, canonicalWorkspace, brokerScope.scope)` inside `context-runtime.ts`; it does not call the ordinary target `sourceFor`/authorizeResult path, which correctly profiles READY targets. `assertTargetCurrent` freezes the same prepared attempt baseline. Context-output remains independent of persistence/Gateway and stores only the captured hooks and exact binding in its existing owner closure.

NEW `confirmSeedDependencies` requires sourceAvailable + assertSourceCurrent + caller `current()` + targetAvailable/currentness at admission, before every publication and after every await. It still uses genuine original source artifact authorization for every root, catalog, and retained member, including exact catalog membership and original branch-visible full references. Target source identity must match the immutable original artifact owner source for the transfer policy; matching project labels alone is insufficient. These checks do not rewrite original owner/operation/pin identity.

PASSIVE `reconcileSeedDependencies` ignores sourceAvailable/assertSourceCurrent and source runtime/producer registrations. It requires the original exact transfer binding, all original immutable artifact/catalog/member operation metadata, all original complete bound target pins/access/companions, and genuine current target scope. Reconstruct/compare the deterministic closure and sync-confirm existing bytes under the original artifact owner. Missing source physical pins do not by themselves defeat this target confirmation; missing original metadata, changed original refs, absent target publication, or target policy denial does. Never call `authorized(source, ...)` as a passive prerequisite or `authorized(incompleteTarget, ...)` as staging authority. It writes no missing publication and cannot convert an unavailable catalog entry into retention. Parent runtime close, source-pin release, and source/session deletion are distinct tests; existing deletion policy remains authoritative.

Registration must permit a reconciliation-only attempt with sourceAvailable false: WeakMap membership and bound target authority are still required, and NEW confirm refuses. Otherwise a hidden registration-time source check would negate the split. Scope disposal follows the actual bootstrap attempt; currentness remains enforced through queued artifact work and final confirmation, and owner close/deletion flags still gate all work.

## 6. Real composition/caller differences

| Caller | Required concrete wiring and recovery owner |
|---|---|
| Gateway public fork | `desktop` renderer's two manage callbacks → bridge/main IPC → Gateway router → `session-management.ts` fork arm. Retain original requestIntent with invocation before transport. `host.ts` composes the real broker preparation with `context-runtime.ts` and its existing `nativeContext.contextOutput`; use it in the coordinator call, not late `onFork`. Current late `projects.inherit` + `inheritFork` only remains for explicitly legacy paths. |
| Managed child/team/reviewer on Gateway | Service option/private child bootstrap factory must flow from `host.ts` through `session-executor/service.ts`, actual `assembly.ts` subagent/team/reviewer registrations, and `SpawnOptions`/team bridge. `subagent/tools/spawn-source.ts` retains intent in original V2 start; team roster provisioning retains the same target/intent instead of child allocating a second ID. Review lifetime retains its own intent/none/shared generation and private authorization. None still performs the host phase but never source semantic projection or dependency calls. |
| Managed child outside Gateway | `assembly.ts` already acquires the automatic result-store lease; extend that actual lease/service composition for transfer rather than making another artifact service. No broker means explicit unmanaged intent and no project preparation port; it does not mean permission to invent project roots. Its actual producer/source registration and target host lifecycle must supply transfer hooks. Project-bound operation without a real target scope owner refuses; a copied `projectContext` snapshot cannot qualify cold target authority. |
| Standalone nondurable spawn | `subagent/child/document.ts` currently uses `createSession` + nondurable fact owner, not a SessionCoordinator. Its memory bootstrap uses the same seed/readiness contract but cannot call inspectBootstrap or write a broker target document. Host phase is omitted only for actual unmanaged standalone operation. No claim of durable cold recovery; live unmanaged transfer requires actual artifact/source owner and target lifetime or refuses. Do not label coordinator fixture coverage as standalone coverage. |
| SDK/CLI/direct persistence fork | SDK owns pretransport intent; CLI's real callback forwards it to persistence. CLI without project broker selects unmanaged; `fork.ts` does not import Gateway or infer project authority from headers. Durable convenience helper retains/returns the once-minted intent on failure. |
| Detached import | `lifecycle/managed-document.ts`/`detached-seed.ts` use caller's original invocation+intent before normal open, retaining exact supplied-view rules. Gateway-hosted imports require the genuine selected target project capability. Anonymous source observations do not authorize parent/source identity fabrication. |

The existing Gateway native service is a supplied-service fast path; adding hooks only to executor's automatic store cannot wire production Gateway transfer. Conversely, Gateway's broker cannot be silently introduced as a dependency of subagent/executor/context-output. The private factory is host composition; data DTOs stay in core/persistence as appropriate. READY adoption does not resolve a model or create an Assembly to obtain source permission. Legacy grants are skipped only from genuine complete coordinator/bootstrap receipt flow, never header presence alone.

## 7. Lock, fence, and uncertain-save ordering

Retain the target's existing durable session ownership through bootstrap. Distinguish that held lease from its per-operation lane: the lane is released for broker preparation and artifact work. Sequence is target/source host admission → short session header lane → release lane → bounded broker target serial/document put lease → release broker serial → artifact mutation chain/workspace lease → release artifact lane → short session seed/completion or frame-confirm lane → final target currentness → READY. No broker operation awaits artifact work; no artifact path recursively enters artifact `mutate`; no session lane awaits a host port; no callback waits for the bootstrap flight that invoked it.

Two concrete cutover corrections are necessary:

- `project-scope.ts:move` currently does `serial(target, () => fence.exclusive(target,...))`. If an admitted bootstrap queues behind that move while the move drains the admission, both wait forever. Change the move's management admission to `fence.exclusive(target, () => serial(target,...), preflight)` before adding outer target bootstrap `fence.run`. Preserve its existing idle checks, document refresh/held lease, descendant refusal and drains. The exclusive must not occupy target broker serial while draining registered work. Test a move queued behind an earlier broker operation, not just a move already holding the fence.
- `session-management.ts` currently runs fork inside the source's management-exclusive branch. The new semantic fork should have a dedicated admitted operation using the existing fence/run and existing idle/visibility checks, with the original source observation/currentness captured through its real owner. Do not run the whole transfer under `exclusive(source)` or `exclusive(target)` and then call `assertOpen`/nested admission. If a short exclusive source snapshot section is retained, release it before target/artifact work and revalidate the actual source observation before NEW issuance. Passive exact-target retry must branch before source profile/export/idle checks that would otherwise require a live original source. Public target visibility/current scope still applies.

Do not wait for `catalogTail`/`authorityChanged` drain from inside an admitted operation that the drain can be closing. Catalog configure/revoke publishes revisions/withdrawal synchronously before its waits; the active attempt detects staleness and settles. Use current catalog snapshot + direct canonical-directory verification + revision comparison, not a nested catalog mutation. Do not call `closeSession`/drain the same source or target from that attempt's callbacks. Source operations waiting on target operations do not introduce a reverse wait through broker `resolveOwner`: pre-ready target methods use own binding only, never target lineage resolution or awaiting their own `operations.get(target)`.

Existing `save` remains put+readback: `putDocument` can swallow/report failure, `getDocument` is a backend read, and only exact strict readback confirms ownership. The new path must recheck currentness after put and after readback and must not expose a getter until confirmed. A landed write followed by response/readback failure is unknown; preserve it and resume the same operation. A no-write response or absent/malformed/unreadable readback is not success. Exact later readback can confirm the original intended value, even when source has since closed, on the passive route; a different value conflicts. Partial/missing binding may be continued only on NEW work with original intent and actual source/current authority.

`serial` is process-local. Coordinator's `doc:<key>` lease protects a put, not the surrounding get/check/put; the session lease and existing management admission constrain cooperating owners but are not a distributed document CAS. Fresh readback and operation inspection do not change this. No new authority catalog, ACL, reservation map, or transaction manager is proposed, and no cross-process CAS claim is warranted.

## 8. Smallest coherent staged implementation and real acceptance tests

1. **Freeze shared contract and caller intent only:** add host phase types/owner ordering and the request-intent digest helper/closed DTO extensions. Keep current durable bootstrap owner, empty literal, phase union and public incomplete fences. Real JSONL tests demonstrate target port before dependencies/seed/completion, both none and non-none empty tables, and passive port before frame confirmation. Assert zero calls to both empty dependency methods; stale target after frame sync prevents READY. A callback here qualifies owner plumbing only.
2. **Implement genuine broker preparation plus admission-order correction:** real configured broker + real temporary directories + actual coordinator reserved target and `inspectBootstrap(full invocation)`. Assert target public profile remains unavailable during preparation. Test wrong operation/target/createdAt/requestDigest/manifest, saved foreign/unassigned binding, new source project change, same-roots reconfigure, reference failure, revoke/restore ABA, closed target, queued move, deletion drain, and close while put/resolveScope waits. Actual put/get failures cover no-write, committed-write/lost response, unreadable readback, then same-operation exact recovery. Passive path neither touches source profile/runtime nor writes a project document. Keep this separate from READY foundation tests already accepted.
3. **Compose artifact transfer with that real host:** use actual root/member/catalog bytes and original pins/operations, actual broker getter and native service. NEW source branch/policy loss refuses before publication; wrong full refs/catalog membership refuse. PASSIVE completed target confirms after parent runtime close and after source-pin release with target pins retained. Missing target pin/access/companion refuses without recreation. Reconfigure/withdraw target during a gated artifact I/O refuses the final outcome. Confirm source accessor counters stay zero in passive mode; generic callback success is not production evidence. Preserve physical-retention versus current-policy distinctions.
4. **Task4 actual caller cutover:** cover SDK/CLI wire and actual Desktop/Gateway route, managed spawn/all and default none, team fixed provisioning target, reviewer private none, detached imports and standalone. Gate lost response after actual completion, change source/project, retry the retained exact intent, and assert one target/initial admission/run. Cold original start/team intent succeeds or reports payload-required for lost seed; saved-document candidate recovery succeeds only with the original core digest and exact outer hash. Missing intent never recaptures source or changes invocation. No model/Assembly is created for storage-only fork/adoption. Keep the original fork RED open until this slice is qualified.

Relevant existing source anchors: `coordinator/bootstrap.ts` dependencies/adopt/run/inspect; `coordinator/bootstrap-types.ts`; `coordinator/bootstrap-header.ts`; `coordinator/documents.ts`; `desktop-gateway/project-scope.ts` load/save/serial/resolveOwner/move; `session-management-fence.ts`; `session-management.ts` fork arm; `host.ts` broker/service/onFork composition; `context-runtime.ts` projectScope/sourceFor/native service; `session-executor/lifecycle/result-store.ts`; `subagent/child.ts`, `child/document.ts`, `tools/spawn-source.ts`; and `agent-team/roster.ts`. The prior reports already qualify READY readers and exact semantic reference extraction; this next slice must not relabel those fixtures as evidence of new transfer or pre-ready caller wiring.
