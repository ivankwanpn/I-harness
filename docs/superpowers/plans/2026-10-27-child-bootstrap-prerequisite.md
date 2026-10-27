# C2 child bootstrap prerequisite A — implementation plan, 2026-10-27

> Same-reviewer design PASS; root approved bounded implementation on 2026-10-27. One reserved writer per assigned slice; no recursive delegation. Implement only the task text in the root brief, with review before the next slice.

**Goal:** qualify closed original child birth intent, source-free none, one B2 recovery/IO owner, immutable-birth mutation and genuine old ACTIVE-writer fencing.
**Architecture:** existing B2 documents/flight/held/issuer/IO state receives an explicit child request/route; public admission stays public-only. A single JSONL stage lookup serves routed recovery and ordinary birth consumers; Documents still owns observation admission and guard lifetimes.
**Tech stack:** existing TypeScript/Node persistence/core-session/JSONL/native fs-lock/Vitest; no dependency/provider/network installation.
**Spec:** `docs/superpowers/specs/2026-10-27-child-bootstrap-prerequisite.md`, sections1–8; original candidate packets and independent reviews remain preserved.
**Source:** immutable MAIN `d62c85ea24e7cb87c3a674a38e6a9476a6b891d1`; bootstrap/Documents/JSONL owners unchanged from read source8ea95aa4 by scoped immutable diff. No tests/runtime/product/Git mutations performed while authoring this plan. All boxes and controls below are unrun.

## Global constraints

- Root sequencing ruling: Task1 declares closed child data/route/reservation aliases and parsers only. Do not widen existing shipping public header/read-state fields to their union until the routed consumers in Tasks2–4 are connected; that avoids an invalid intermediate public-only consumer graph. No private coordinator capability is advertised in Task1.
- The full-stage validator that requires the routed reservation union is wired with Task2, while Task1 covers pure core/request/intent/reservation/initial commitment. Use a cohesive private child-data leaf rather than inserting an unrelated large block into existing public owners; factoring the existing metadata validator without behavior change is permitted. No casts may stand in for a routed consumer.
- Root sequencing ruling: Task2's actual READY→mutation qualification depends on Task3's private entry and Task4's Documents facade. Implement the shared backend first, but defer that actual-facade runtime gate until these consumers exist; do not fabricate a READY record or bypass Documents to claim Task2 complete. Root may batch the tightly coupled Tasks2–4 into one reviewed owner slice.
- Runtime tooling: resolve the first Node Application result, not all Get-Command matches. Every test/type/runtime invocation receives six new short task IH roots from its brief. Use existing direct Vitest/TS and sequential --no-file-parallelism; never pnpm run/exec/install/relink, HOME/USERPROFILE changes, or protected evidence traversal.

- Keep public ForkRequestCore/RPC/readers/request domains/public path key and predecessor full-stage bytes/captureReservation absence unchanged. Current Session13, child V1 seed; no format/codec bump.
- Digest-only initial `{inputId,digest,startedAt,expiresAt,parentSessionId?}` uses exact existing bootstrapInitialInputDigest(initialAdmission(request),start,expiry); prompt stays in original live payload and actual admission. No new256KiB prompt limit; existing stage262144/header65536 and completion limits remain.
- Sole child-domain recognized hex stage; same existing B2 helper/IO ledger/entry, no second registry/seed cache/sentinel/capture owner. Routed backend port is a facade over that same instance.
- READY/adopted birth data cannot run a child, grant approval/model/source authority, reset original expiry/attempt floor, or reenter settled Agent. No task/Team/reviewer caller, initial generation adoption, L1 all/N, Team schema or passive CodeStore extension.
- Existing source/Stop identities, observation target exemption, retirement/close/held cleanup and O1 authority remain. Unsupported complete child capability refuses before source/callback effects; no raw-fork fallback.
- Scope is existing Windows/Linux process-interruption/restart qualification, not machine/power-loss durability; Windows optional directory flush remains intentionally skipped on capture path. Original required IO/cleanup failures remain real debt.
- Root later assigns immutable BASE/checkout, runtime roots and evidence destination. Do not infer ownership of moving HOST/CURRENT/NATIVE or alter protected historical evidence. Keep distinct RED/setup/GREEN populations and exact source/command/CWD/exit/resource receipts.

## Frozen file map

All paths in this table begin at packages/; tasks are sequential because these owners overlap.

| Owner | Exact files and responsibility |
|---|---|
| Closed data/routes | session-persistence/src/coordinator/{bootstrap-types,bootstrap-intent,bootstrap-capture,bootstrap-header,types}.ts; normal src/index.ts exports only. Child validators/domains/tuple, internal reservation union and BootstrapRouteBackend type; no fork-contract.ts edit. |
| One B2 execution/recovery | session-persistence/src/coordinator/bootstrap.ts; managed-documents.ts. Store route on existing entry; check before flight; same run/cached adoption/capture IO; resolve ordinary READY route under actual ownership before tagging/attach. |
| Documents admission | session-persistence/src/coordinator/binding-observation.ts and src/index.ts. Existing strict guard capture with child validator dispatch; same bootstrapMutation and self-wait/retirement/close boundary. documents.ts consumed as existing owner, no duplicate observations. |
| JSONL path/IO/birth | session-persistence-jsonl/src/backend/bootstrap-stage.ts(new); {bootstrap-header,bootstrap-capture,fact-journal}.ts; src/index.ts. Shared validated unique lookup and same IO instance; both immutable-birth/historical append consumers. format-upgrade.ts consumed through preserveBootstrapBirth; edit only if actual lookup call integration requires it. |
| Focused tests | session-persistence/test/child-bootstrap-intent.test.ts(new), child-bootstrap-routes.test.ts(new), child-bootstrap-admission.test.ts(new); existing bootstrap-{capture,cached-ready,intent}.test.ts, semantic-bootstrap.test.ts, binding-observation.test.ts, existing-binding-observation.test.ts. |
| Physical/predecessor controls | session-persistence-jsonl/test/child-bootstrap-physical.test.ts(new), child-bootstrap-predecessor.test.ts(new), existing bootstrap-{capture-physical,physical}.test.ts and semantic-codec2-predecessor.test.ts; test/helpers/child-bootstrap-predecessor.ts(new), test/fixtures/child-bootstrap-predecessor13/{manifest.json,graph.json.gz,README.md,LICENSE}(new genuine pinned graph only). Existing format11/12/codec1-13 fixtures/helpers unchanged. |

## Task1 — close data/tuple validators without changing public contracts

Consumes existing BootstrapRequest/Initial/Invocation, validateCreation, initialAdmission, bootstrapInitialInputDigest, canonical bootstrapHash and public parser. Produces exact spec§1 functions and spec§1–3 types; internal header/read-state may carry OwnedCaptureReservation, coordinator public reader remains public-only.

- [ ] Add child-bootstrap-intent.test.ts table tests for each exact union branch, caller↔lineage↔approval matrix, positive/negative safe integers, optional absence, inherited/declared model metadata consistency, protocol enum, anonymous/durable-parent refusal and exact target/source identity. Include proxy/getter/hidden/symbol/extra/undefined/sparse arrays; malformed input effects counters remain zero.
- [ ] Freeze public request/core/intent/canonical stage vectors from existing tests, and assert public capture readers reject a child DTO; new child readers reject public DTOs. No test obtains source authority from a digest/role label.
- [ ] Use this exact commitment oracle on valid real BootstrapRequest data: `const e=initialAdmission(payload)!; expect(childInitialCommitment(payload)).toEqual({inputId:payload.initial!.inputId,digest:bootstrapInitialInputDigest(e,payload.initial!.startedAt,payload.initial!.expiresAt),startedAt:payload.initial!.startedAt,expiresAt:payload.initial!.expiresAt,...(payload.initial!.parentSessionId===undefined?{}:{parentSessionId:payload.initial!.parentSessionId})})`. Changing text/provenance-producing parent/inputId/start/expiry changes that existing digest; text is absent from encoded reservation.
- [ ] Run focused tests to confirm meaningful semantic RED once interfaces exist; missing export/setup is setup evidence, never accepted semantic RED. Implement strict captured readers, child canonical domains and exact tuple with existing owner validators factored only as needed; do not add prompt text to core or use a TypeScript intersection as policy.
- [ ] Run focused GREEN plus bootstrap-intent/fork-core-contract public vectors and affected typecheck. Review deliverable: closed child data/equality only, original public bytes unchanged, no source/callback/claim before validation.

## Task2 — one routed namespace/lookup and actual immutable-birth consumers

Consumes Task1 validated route/reservations. Produces spec§3 BootstrapRouteBackend and spec§6 lookup/path APIs; original public backend signatures delegate to the same JSONL instance. Existing capture ledger supplies tracked lookup IO; helper creates no resource/phase owner.

- [ ] Add physical controls that place public/child exact-key stages, both keys, wrong-key protocol, reservation-free child, unknown namespace suffix, future/torn/oversize stage and matching/nonmatching promote bytes. Test complete/empty/one-byte/common-prefix child reservation path; strict absence stays unavailable/conflict on any uncertain artifact.
- [ ] Implement bootstrap-stage.ts path/lookup leaf and compatibility re-exports. Derive two candidates only from exact actual header invocation for ordinary birth; require unique canonical full stage with child reservation or literal-compatible public predecessor. Do not branch on header.origin or guess a requestDigest's domain.
- [ ] Have same helper supply readState/readCapture/reserveCapture/resolveBirth through one optional bootstrapRoutes port; original bootstrap backend wrappers remain public. Header prepare/reconcile derives route from validated preserved reservation; public reservation-free predecessor remains public. Missing port/method means no child capability.
- [ ] Replace both fact-journal.ts hardcoded public-path reads with shared lookup: preserveBootstrapBirth still validates immutable header/upgraded11/12 rule, actual seed manifest, birth event equality and original phase frame keys/bytes; historical append still validates exact old header and original prefix/batch layout before issue. Wire ordinary replaceEvents/repair/metadata/upgrade through their actual original guards, with no generic fallback for failed child lookup.
- [ ] Prove actual none-child READY→ordinary read→append valid suffix→replace valid suffix→torn-suffix repair→metadata update→cold/private resume preserves exact birth frame bytes, batch keys and prefix digests; returned receipt owner is actual current owner, not a copied historical incarnation. Candidate replacement that changes initial/seed/bootstrap birth rejects with byte-identical target.
- [ ] Prove public generic predecessor full stages with no captureReservation and supported11/12 upgrade remain positive through ordinary birth-preserving paths. Child stages have no reservation-free predecessor. Existing tombstone/deletion inventory recognizes sole hex child stage and retains original header restrictions; no new headerless delete path.
- [ ] Focused GREEN/typecheck and review gate: every stage lookup consumer identified by source search uses shared selected route, one ledger, no altered public-stage bytes or historical receipt-frame layout.

## Task3 — private facade, explicit entry route and warm/cold/READY recovery

Consumes Task1 data and Task2 routed port. Produces exact optional `inspectChildBootstrapCapture(request)`, `bootstrapChildTargetWithCapture(request,guards,capture)` and `resumeChildTarget(request,guards,originalPayload?)`, each with spec§3 result types and one complete capability gate.

- [ ] Add child-bootstrap-routes.test.ts controls for no hooks/partial port/no locking/unsupported platform: all private methods absent together; no fallback/source/callback/target effects. Existing public generic capabilities remain as before.
- [ ] Suspend actual original child capture after committed-new reservation. Call every public generic bootstrap/resume/public-capture entry with same target+exact invocation and a valid generic/public input where its reader permits; require conflict before joining suspended child flight, while original private duplicate joins same flight and callback remains once. Invalid public child DTO remains validation refusal. Repeat READY and fresh coordinator.
- [ ] Store validated route/full child request on existing entry before flight publication; compare protocol/request before entry.flight in every path. Use same run/start/captureBundle/settle/release and known-token owner; no second map. Child unavailable/future/torn/foreign stops before build/header reconcile/prepare, rather than inheriting generic unavailable fallthrough.
- [ ] Recovery table: original warm ownedRequest may continue; exact spent/cold reservation with new callback or supplied payload must return payload-required and zero callback; unknown returns blocked/unknown; full stage + exact payload may finish missing original header/seed/initial; no payload where missing bytes required blocks; full READY confirms actual frame receipts. Compare all returned-payload initial commitments after callback and before promotion/header publication; mismatch spends reservation.
- [ ] Ordinary openManagedDocument uses port.resolveBirth on exact actual header/body/unique stage under its existing ownership before attaching/tagging entry. Cached child resume shares captureManagedReadyObservation, actual document/view/prefix checks, target/dependency reconciliation and receipt confirmation; public call refuses route before joining cached flight. Opening unresolved document is not a route-qualified bootstrap join.
- [ ] For none, trap every parent history/export/hash/legacy/CodeStore read and reach real READY with records[], sourceObservation none and exact original initial tuple. For all/N data, validate existing B1 V1 payload/selection/origin and reject passive V2 or anonymous+durable parent without modifying B1/L1. No actual caller launch tests belong here.
- [ ] Long-prompt parity: use `text='é'.repeat(131073)` (262146UTF8 bytes), bounded metadata/role/tool intent and same initial clocks. Existing generic bootstrap must be a real positive control; private none must also reach READY and exact event/receipt without larger stage commitment. Changing callback text yields manifest-invalid after callback1/reservation, no target header, retry remains spent with callback count1.
- [ ] Focused GREEN includes cold full-stage header/seed/initial cuts, ordinary-open cached READY, wrong document/prefix/reservation, exact original reservation across rebuild/promotion and public READY positives. Review gate: READY/adoption performs no Agent/model/launch activity, original clocks and tokens are unchanged.

## Task4 — retain Documents admission and genuine guard/resource lifetimes

Consumes Task3 internal private methods. Produces facade forwarding through spec§4 withChildBootstrapCapture/withChildBootstrapResume, using same original bootstrapMutation and strict host snapshot with explicit child parser dispatch; public wrappers keep public parsers.

- [ ] Add child-bootstrap-admission.test.ts through actual createSessionCoordinator facade, not internal owner direct calls. Verify active existing-read observation on target refuses self mutation; exact fork target exemption only for same complete invocation; unrelated observations revoke/join before mutation. Retirement/deletion/closed target refuses even when child identity is valid.
- [ ] Capture child request, optional original payload, signal, callback and guard/dependency/targetPreparation method descriptors before first await. Preserve original `this` receivers and optional targetPreparation absence through suspended observation admission. Trap accessor/proxy/stateful second lookup and assert single inspection, no mutation on invalid host shape.
- [ ] Exercise direct callback self child/public bootstrap/resume/open/close/retire/delete/coordinator-close. Self-wait checks must refuse before admission/close state changes; original callback can then complete normally and original unrelated admission remains usable.
- [ ] Suspend root check, claim acquisition, namespace read, reservation IO, callback, promotion and READY receipt confirmation in separate actual owner controls; external close/retire revokes new work synchronously and joins late acquisitions plus original ledger/observations. Inject close/release/readback failures; retain same held.owner cleanup handles and settle by original owner, never replacement identity.
- [ ] Preserve literal thrown undefined/null/false/0/empty string plus independent cleanup failure; no truthiness-based success. Inspect routing fact is returned only after actual cleanup; no unavailable→absent on cleanup/root/tombstone failure.
- [ ] Focused GREEN plus original capture-retirement/existing-binding-observation/binding-observation controls. Review gate: private facade cannot bypass Documents, original F0/existing-read semantics and Stop/retirement lifecycle remain intact.

## Task5 — genuine process cuts and predecessor ACTIVE-writer qualification

Consumes reviewed integrated Tasks1–4. Produces process evidence for A only; no wider fork/caller/L1 acceptance. Source graph fixtures remain unmodified product sources with qualified native lock dependency, not edited-constant emulations.

- [ ] In child-bootstrap-physical.test.ts exercise process cuts at exclusive empty/short reservation, sync/readback/close, callback returned, pending promotion, rename uncertainty, header, seed, completion+initial and receipt confirmation. Cold restart never invokes callback2 or reconstructs lost payload/launch; exact reservation and original stage/birth bytes/receipts stay bound. Retain original issued IO debt in warm controls.
- [ ] Build a complete isolated immutable d62c85ea pre-child graph fixture with provenance/manifest/capsule/blob/file/Node/native hashes; import resolution must stay inside fixture graph except explicitly qualified Node/test loader/native lock. Reuse genuine existing11/12/codec1-13 capsules and extractors unchanged; no workspace fallback, provider/fetch/profile or CURRENT_FORMAT_VERSION/parser edits.
- [ ] For each genuine graph×child-key stage complete/empty/one-byte/common-prefix/oversize/torn/future×same/different invocation: run passive inspect/optional capture inspect, ordinary read/snapshot/load/loadOwned/direct repair/create, ACTIVE bootstrapSemanticTarget(valid old generic payload), ACTIVE resumeSemanticTarget(valid old generic payload), and payloadless resume. Missing old method is explicit inapplicable entry, not proof of active refusal.
- [ ] Count actual target/header/stage opens-for-write, fs writes/rename/truncate/append, backend append/repair/updateMeta/upgrade/replace, capture/source/model calls; compare all original target/stage/promotion bytes and complete names inventory before/after. Allowed native lock artifacts are tracked separately; zero forbidden session writes and no new header are mandatory.
- [ ] Every graph must positively reach READY through its actual old writer on a clean absent target; demonstrate same-key common-prefix/zero-stage vulnerability where actual predecessor permits continuation. Child-domain foreign-stage control must block that same writer before header preparation, even for empty child stage. Parser rejection alone earns no compatibility credit.
- [ ] Positively cold-resume genuine old V1 full-stage ready/header-only/torn11/12/13 populations on new owner, preserving captureReservation absence/bytes, original birth frames and supported upgrade. Existing public completed V2 positive controls remain positive; do not turn them into unsupported/refusal tests.
- [ ] Run focused process populations once per assigned runtime; report exact setup/semantic RED/GREEN and interruption model. Review gate: no claim of power-loss safety, old universal READY rejection or product shipping acceptance.

## Task6 — focused verification and same-scope integration review

No commands in this candidate have been executed. After root release, resolve approved Node/Vitest/TypeScript entrypoints locally; missing paths/runtime/native lock are setup blockers, not permission to install dependencies or weaken controls. Run from each assigned package CWD, sequentially with `--maxWorkers=2 --minWorkers=1`.

```powershell
# Package CWD: assigned checkout/packages/session-persistence
$childBootstrapNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
& $childBootstrapNode (Resolve-Path '../../node_modules/vitest/vitest.mjs').Path run test/child-bootstrap-intent.test.ts test/child-bootstrap-routes.test.ts test/child-bootstrap-admission.test.ts test/bootstrap-intent.test.ts test/bootstrap-capture.test.ts test/bootstrap-cached-ready.test.ts test/semantic-bootstrap.test.ts test/capture-retirement.test.ts test/binding-observation.test.ts test/existing-binding-observation.test.ts test/fork-core-contract.test.ts --maxWorkers=2 --minWorkers=1 --no-file-parallelism
& $childBootstrapNode (Resolve-Path '../../node_modules/typescript/bin/tsc').Path --noEmit -p tsconfig.json
# Package CWD: assigned checkout/packages/session-persistence-jsonl
& $childBootstrapNode (Resolve-Path '../../node_modules/vitest/vitest.mjs').Path run test/child-bootstrap-physical.test.ts test/child-bootstrap-predecessor.test.ts test/bootstrap-capture-physical.test.ts test/bootstrap-physical.test.ts test/semantic-codec2-predecessor.test.ts --maxWorkers=2 --minWorkers=1 --no-file-parallelism
& $childBootstrapNode (Resolve-Path '../../node_modules/typescript/bin/tsc').Path --noEmit -p tsconfig.json
```

- [ ] Preserve actual commands/CWD/tool versions/exits/source/runtime/evidence roots and original failures; run only causal affected existing controls, no broad repeat without changed code/unresolved concern. All package/path commands require the root-assigned checkout and runtime, never moving worktree inference.
- [ ] Audit production reachability from three private coordinator entries through Documents, one B2 map/flight/ledger, routed backend and both fact-journal lanes; exact same-invocation public calls cannot enter/join child. Confirm capability gate/none source traps and ordinary mutation controls execute actual owners.
- [ ] Review candidate source range against spec§1–8 and original I1/I2/I3/M1/M2. Record source/dependency manifest and test population/resource counts; root owns promotion/integration decision. No Git/release/caller migration action is authorized by this plan.

## Review closure map and stop

| Review item | Concrete task/acceptance closure |
|---|---|
| I1 | Task2 shared unique validated lookup, both fact-journal consumers and actual READY birth-preserving mutation; Task5 original V1 predecessor positives. |
| I2 | Task3 exact private facade+typed routes/capability gate, same entry protocol before flight, reservation-only/full/cold/cached READY matrix; Task5 genuine ACTIVE writers. |
| I3 | Task4 existing Documents admission/receiver snapshots/self-wait/retirement/late IO, facade-only production path. |
| M1/R1 | Task1 exact existing initial digest tuple, Task3 >262144UTF8 generic/private positive and post-callback mismatch spends reservation; no prompt text duplication. |
| M2 | Task1 complete caller/lineage/model/role/numeric/absence/anonymous matrix; Task3 preserves generic anonymous/durable-parent restriction and excludes passive V2. |

Design rereview is complete and original candidate/rulings/review files remain untouched. Root releases bounded implementation slices in task briefs; later qualification, caller integration and release approval remain separate.
