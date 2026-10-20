# R4A — Cohesive owner structure before final qualification

Approved bounded execution plan, 2026-10-21. [Mixed retention is accepted](../../research/2026-10-21-context-r4a-mixed-retention-acceptance.md) at88b24b513a5bfb7538b8540d3ed63205f44e4b93. The [fresh preflight/re-review](../../research/context-r4a-structure-preflight-20261021/review.md) passes after four precise amendments; [root accepted-source rebase](../../research/context-r4a-structure-preflight-20261021/accepted-source-rebase.md) confirms unchanged product interfaces and44 exact source hashes.

The approved original R4A plan already requires coherent Context Output leaves, full CX2 task responsibility and S25 mapping before final A6 source freeze. This is that overlap, not a restart of the unrelated broad decomposition. Version0.1.13-rc.1 / Session10 remain unchanged. One GPT6.1Sol writer, fresh final reviewer, no recursive agents, no publishing/profile/provider/installed-app actions.

## Scope and source observations

The independently parsed [source-only AST census](../../research/context-r4a-structure-preflight-20261021/census-before.json), rehashed at accepted88b24b51, finds `createTaskRegistry`270lines/12094characters and `createContextOutputService`255lines/14635characters. Their thin package facades do not complete the responsibility split. Mixed retention changed no product owner; root pins the subsequent documentation-only plan checkpoint as clean writer BASE. The [preparation map](../../research/context-r4a-structure-preflight-20261021/preparation-map.md) includes the corrected S25 scaling statement and future A6 obligations, not permission to execute final qualification before structure is accepted.

Keep current behavior throughout this structural unit. If a characterization reveals a real defect, preserve it and ask root to separate any approved behavioral repair from the structural commit. Do not make behavior more atomic, reorder observers, tighten compatibility or implement R4C as an incidental cleanup.

## CX2: one record/index owner, existing result/outbox/persistence owners

Preserve the public `createTaskRegistry` interface and actual TaskRecord object identities. Introduce an internal cohesive records/index owner under the existing task directory (or use an existing equivalent). It owns exactly one set of records, byIdentity, byChild, taskCounter and anonCounter. Do not retain duplicate copies of those Maps/counters in the composing registry.

This owner handles record lookup/enumeration, original identity matching/adoption, insertion/counter allocation, claim/index updates and indexed restore. Pure restored-field normalization can be a separate leaf. The registry continues to compose EXISTING TaskResultOwner, TaskNotifications and TaskPersistence; no extra result captures, notification queue, save chain, event journal or delivery authority.

Narrow operations should expose actual records and explicit insertion/adoption outcomes, not a bag of all private locals. Keep terminal outcome normalization in existing `settlement.ts`, original F1 qualification in `publication.ts`, result capture/revision/page logic in `result.ts`, strict document validation in `validation.ts`, and original persistence in `persistence.ts`.

Preserve these specific behaviors and observation order:

- Max-concurrency checking currently precedes identity adoption during submit. Do not move it after adoption as an unrelated “improvement.”
- Existing record references remain the same objects. Same identity plus matching prompt/agent/path/delivery adopts; conflict and counter behavior stay unchanged.
- Anonymous identity lookup currently has its own counter effect; restored anonymous keys use a separate restored namespace. Preserve actual original behavior, not an assumed prettier implementation.
- Claim updates status/time/model/job/child indexes before the same save/publish sequence. Cancel-tree follows existing insertion/path order, original terminal CAS and existing notification scheduling.
- Restore follows this exact synchronous cross-owner protocol: validate the complete document before mutation; upgrade documentVersion for v2 and seed taskCounter from ALL input task IDs; restore notifications/counter through the existing outbox; then process tasks in input order. For each task reject an existing ID, apply original v1 bodyKind/v2 unqualification to the supplied object, insert that same object, perform original terminal retention classification, then install identity/child indexes. Publish input tasks only after the whole loop succeeds. Restore schedules no save/capture/terminal notification/callback.
- A late duplicate task ID retains earlier version/counter/outbox/record mutations and performs no final publication loop. Duplicate identity/child keys replace index entries while both records remain; restored-anon numbering resets each restore. Preserve these semantics rather than making restore atomic or cloning shared input. Registry retains cross-owner order through a few narrow record operations or synchronous per-record hook; records ownership does not absorb outbox/result authority.
- TaskPersistence keeps strict mode's CALL-TIME outer task/notification snapshots and existing shallow nested references, and legacy non-strict mode's WRITE-EXECUTION-TIME snapshot. Keep the sole save chain, swallowed continuation versus returned failure, and quiescent flush with no extra write. Do not deep-clone/freeze, change snapshot timing, or insert a yield before save/publish.
- Original terminal retention is scheduled once. Callback occurs under existing success OR failure semantics; operational completion does not prove retained publication. No cold restore starts a producer capture.
- Current TaskRegistry.claim is accepted→running task state, not a receiver delivery claim. Preserve current outbox/notification drain and leave R4C durable admission/claim/wake/branch-epoch behavior for its approved later phase.

Target: registry becomes a readable composition/orchestration facade; record/index transitions live in a cohesive small owner. Do not move the270line closure unchanged elsewhere, hide size by dense formatting, or add public package exports used only by tests.

## Context Output: stateless legacy operation leaves, one service lifecycle

The existing service remains the sole composition owner of config/state, lazy legacy-store initialization, active job controllers, mutation/transition sequencing, managed owner and close joins. Accepted mixed quota/retention behavior and any newly repaired shared admission owner must remain authoritative; rebase those interfaces first.

Extract the substantial legacy capture and search/read algorithms into stateless cohesive internal leaves with only the operations/data they actually require. Example responsibility split: `legacy/capture.ts` for prepared capture execution and original ref construction; `legacy/query.ts` for prepared legacy read/search projection. Exact names may follow current layout. Use explicit narrow callbacks/getters for current config/store/policy as needed, never a giant private-locals deps object or a second service/store. Admission remains in the service, not in the leaf.

Keep the public `async` wrappers and this boundary table. A synchronous preparation helper is allowed; never await it before run/admission or convert validation rejection into a synchronous thrown public call:

| Operation | Synchronous work in existing async wrapper before admission | Work within existing run owner |
| --- | --- | --- |
| capture | Validate identities/label/text/complete, preserve disabled early return, structured-clone input before returning to caller | mutation=true; impossible-budget early return; original producer with current capture limit; abort/producer validation; lazy getStore/prune; current quota/capture/expiry reads; ref/put |
| read | Snapshot caller/refId/offset and current read budget after validation | nonmutation; original readable/policy/presence checks, captured bytes, UTF8 cursor projection |
| search | Snapshot caller/terms/limit/current serialized budget/refIds Set after validation | nonmutation; lazy store/candidates, original policy/existence/order, scan budget/matching/reason/shrink/final budget |

Keep lifecycle/configuration decisions and storage mutation ownership in their current accepted owner. In particular:

- Validation and synchronous input snapshot still happen at their original points before yielding to producer/storage. Preserve caller-mutation isolation and callback counts.
- Disabled behavior, abort admission, producer invocation, current config reads, source-policy checks before/after waits and full/partial/none captures remain identical.
- Legacy search keeps exact matching/filtering, order, truncation/reasons and final serialized budgets. No new eager full-history read or search cache.
- Existing jobs/queues, once-only lazy initialization and transition cancellation/drain/close ordering stay single-owned. Do not create reentrant locks or a second queue just to pass data into a leaf.
- Existing managed-only/opened-store quota branches, canonical settings/workspace root, document listeners, pin/recovery/witness semantics remain unchanged.

Read/search budgets are fixed at their original public call points; capture reads current config at its original execution/await boundaries. Never capture one construction-time config object. Keep getStore's existing shared opening promise and first-opener signal, without new eager initialization or retries. Leaves do not recursively call run/mutate.

Legacy capture has no new host-authorization round trip. Reuse exact allowed/readable policy: ownership/source-bearing distinction, cloned ref to the host, abort after policy and presence rechecks. Legacy read currently loads its bounded captured body before slicing, and search may scan up to32MiB; preserve those algorithms and describe their existing capture/scan/output bounds, not managed range-I/O or whole-history streaming guarantees.

This is responsibility extraction, not rewriting the optional legacy store or changing provider protocol logic.

## S25 and size review

Produce a complete original responsibility→replaced old production path→current module→public interface→sole state owner→lifecycle/release order→actual consumer/gate map for `desktop-gateway/session-subagents.ts` and `subagents/{catalog,scope,read,result-proof,changes,control,types}` plus session-visibility. Include facade close(observation detach then control drain), header/lineage/live binding identity, retained projection, explicit history/result with receipt and pre/post scope fences, original F1 proof, legacy classification memo/fallback, observer replacement/hook-failure cleanup, serialized controls/Plan checks/flush, and DTO validation. Name actual host/router/renderer consumers without claiming renderer/package validation from a map.

The121line catalog factory/117line list performs one cohesive request with request-local derived maps and no durable authority. Work/map size scale with stored sessions and discovered owners: it profiles sessions, obtains owner snapshots, and legacy/unretained fallbacks can read transcripts/events. Only retained row previews and particular header probes have their existing bounds. It may remain as a reviewed general120line-target exception with that concrete lifecycle/I/O rationale. Do not call the whole query constant/bounded-memory, add caching/streaming guarantees, or split on line count alone. Map original already-replaced responsibilities honestly rather than claiming every leaf is new in this unit.

Also assess existing createArtifactOwnership172lines and createJobRegistry145lines against the general target. Their private scope/lock/pin and live-job ownership may warrant a documented cohesive exception; do not duplicate authority or opportunistically refactor them without a concrete responsibility reason. Any >=250line or >=18000character function in new/changed responsibility must be resolved, not renamed or compressed.

Tests/scripts stay outside decomposition targets. Do not expand into R5 SessionService/Assembly/SDK/Gateway-wide composition refactoring. Record S25/CX2 structural status precisely; original43file completion counter remains27/43 until root explicitly accepts the complete mapping and original gates. R4C semantics remain unaccepted regardless of structural progress.

## Characterization, verification and evidence

Before extraction, map existing actual task/retention/save/order and legacy lifecycle tests to the above behavior. Add only missing discriminating characterization at real public entries. Keep the same assertions before and after; pure moves need equivalence controls rather than invented RED. Preserve any baseline failure and distinguish it from a regression.

Required discriminators (reuse existing where already present):

- Capacity-full exact retry rejection, adopted identity with no new save/publication, and claim preserving the same record/child backlink.
- Successful restore keeps supplied object identity and duplicate identity/child index replacement; late duplicate ID preserves partial application/counter/outbox but emits no final publish. Malformed-document no-mutation is a different boundary.
- Held actual coordinator writes distinguish strict call-time versus legacy execution-time snapshots, including original shallow references, FIFO failure/continuation and flush. Exercise public submit/claim/terminalize rather than exporting internal counters.
- Original terminal callback once after both successful and failed retention; cancellation's notify=false remains. Keep bounded-reports held-retention/no-replay behavior.
- Held actual public capture producer, caller text/source mutation immediately after call, once-only producer and original snapshot; characterize disabled/impossible-budget/pre-aborted/queued-close producer counts from existing behavior rather than assuming a different early rejection order.
- Read/search caller fields/budgets fixed before caller mutation, original cancelable/drained host authorization and existing Unicode/finalJSON/search reason/order oracles. Source-equivalence inspection suffices for anonymous counter internals that lack a useful public discriminator; no test-only exports.

One product writer and one runtime gate at a time. First cohesive task ownership commit; then cohesive legacy-operation extraction commit, each with necessary affected tests/types and exact responsibility mapping. If an inseparable accepted shared-quota interface dictates a different order, explain it to root before edits.

Minimum connected scopes are original task-protocol/task-control/task-notification/bounded-reports/retained-task/current-cold-negative/search tests; executor retained-state/child/pin/cold-zero-work; original Context Output service/disabled-grant/config/quotas plus newly accepted mixed-retention and bounded-integrity controls; S25 original session-subagents timer/subscription/hook-failure/close-drain, desktop-child-authority/publication-proof/catalog-I/O consumers. Select the smallest complete relevant suite list from current source. Do not retest all accepted physical cut matrices without a changed owner.

Run affected types, package public-import/dependency checks and normal reachability without reseed/exemptions/fake consumers. Keep before/after physical+AST size census for maintained product source, responsibility map and unchanged public API/ownership identities. Test imports use package roots or established internal test conventions; do not expose internals solely for tests.

Use a fresh short isolated evidence root, shell config before imports, guarded fresh overrides for accepted fixtures, actual source manifests including hidden helpers, explicit current test discovery/exclusions and native receipts/cleanup. No old sealed runner. Freeze final code and evidence, commit coherent local changes, then obtain a fresh independent combined spec/structure/behavior/evidence review and root audit. Final A6 scale/copied/bundled work follows the accepted structural source, not a moving checkout.
