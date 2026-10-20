# R4A — Artifact publication and original document pins

Approved execution plan, 2026-10-21, following accepted physical-crash qualification `db6c5d1f25759d80272e5c47adfe5796e8609ba5`. This unit is part of the approved retained-results A5 matrix. The [source map](../../research/context-r4a-publication-pins-preflight-20261021/source-map.md) and [independent preflight/re-review](../../research/context-r4a-publication-pins-preflight-20261021/review.md) are preserved. All four preflight findings were corrected before promotion. **Completed and accepted** for the bounded test-only range `5e4f6038..32c88704`; see [root acceptance](../../research/2026-10-21-context-r4a-publication-pins-acceptance.md) for independent review, original evidence and precise limits. Do not rerun this completed unit from the historical instructions below.

## Goal and boundary

Qualify uncertainty and physical crash during the original artifact's body/index/metadata publication and first/second original document pins. Keep the original capture, operation, quota, mutation queue, deletion subscriptions and source policy. Stored bytes, an artifact commitment, a task's operational outcome and parent F1 publication are distinct facts.

Use a real TaskRegistry/storage-owner component fixture. It is deliberately not a full spawned child/model/guest/F1 lifecycle qualification; the preceding physical unit covers real ordinary/guest result-frame cuts. No model/network/guest execution is required here. Remaining dependency catalogs, mixed-store quota/TTL/clear, bounded corruption/integrity, A6 scale/packaged work and later ContextEngine batches remain separate.

One GPT6.1Sol writer and a fresh GPT6.1Sol reviewer; no recursive agents. Product0.1.13-rc.1, Session10, decomposition27/43, no publishing or unrelated work. Task-owned isolated settings and IH_CONFIG_DIR before any import/subprocess. No new recovery journal, public test-only export, dependency or reconstructed cold execution capability.

## Actual composition

The fixture uses the original package seams:

```ts
const coordinator = createSessionCoordinator(createJsonlBackend(sessionRoot), { lock: { enabled: true } });
const { id: parent } = await coordinator.create({ sessionId: "publication-parent" });
const taskDocument = taskDocKey(parent);
let componentOpen = true;
const current = () => componentOpen && coordinator.ownerOf(parent);
const lease = await acquireAssemblyResultStore({
  workspace, coordinator, sessionId: parent,
  contextOutputSettingsPath: settingsPath,
  executionCallerAvailable: current,
});
const results = createTaskResultRetention(lease.service, lease.sourceFor, parent);
const tasks = createTaskRegistry({
  coordinator, stateId: parent, reportPolicy: SHIPPING_REPORT_POLICY, results,
});
```

`acquireAssemblyResultStore` is the existing internal composition leaf in `session-executor/src/lifecycle/result-store.ts`, already used by the shipping assembly. It supplies actual service/sourceFor/deletion wiring; do not create a permissive stand-in service or duplicate its deletion subscription. `coordinator.create` acquires and holds its original ownership lease for the live cycle. Assert `ownerOf(parent)` before preparing the result.

Submit and claim one actual task, join initial `flushPersistence`, then call `prepareResult(task.id, undefined, current)` before terminalizing. Read the actual `coordinator.getDocument(taskDocument)` and require the real format-2 document with this task's running identity and no terminal outcome/result. Record a detached baseline snapshot and its exact bytes at the actual backend document path. Absence/mismatch is a setup failure: flush joins a caught persistence chain and cannot by itself prove success. The component lifetime only changes true→false on permanent fixture closure; never reopen a closed source. This is a storage-owner lifetime predicate, not a fabricated PreparedCall/SettlementFacts or F1 permission.

Use a fixed terminal outcome and independently authored `{resultText,error}` body, retaining both fields. A large ASCII resultText exercises multiple body/leaf chunks; keep the error text a fixed literal. `settleTaskRecord` reads those two input fields once and supplies the original capture. Test getters may count terminal input normalization, but do not mislabel them as getters on the separately constructed plain captured body. A transparent TaskResultStore.capture observer may count and retain the actual returned handle identity; it must delegate unchanged, including any forSource binding.

`terminalize` already launches retention. Explicit `retainResult` calls must adopt/coalesce that same capture. Require one original revision/operation and one capture/normalization, rather than a second terminalization or another call to the encoder as an oracle.

The original task result revision is the artifact operationId. The artifact ref's revision is a different identity, derived from manifest bytes. Preserve both across retries without asserting they are equal. `taskDocKey` is already publicly exported by subagent; do not add a product export for the fixture.

The TaskRegistry legitimately enqueues its original terminal notification and calls onTerminalized after retention success OR failure. Do not require zero original terminal callbacks as a substitute for truthful retention/F1 state. The assertions are no ready artifact descriptor before required publication, unchanged operational outcome, no fabricated F1 and no repeated capture. A cold task document without original F1 witness must not be promoted to qualified successful publication.

## Files and fixture responsibilities

Add focused tests under `packages/session-executor/test/` for live publication/reconciliation and physical publication cuts, with small test-only helpers for:

- Original store/TaskRegistry fixture and independent body/pin/inventory assertions.
- File-specific native I/O observation and one-shot fault/park gates.
- Direct Node child entry and nonce-bound IPC for the cold cases.

Reuse the already qualified direct-Node/IPC/owned-handle approach from retained-physical-crash tests where it is a real shared responsibility. Do not import a `.test.ts` file to reuse a launcher, copy a complete fake storage implementation, or create an unnecessary generic fault framework. The existing physical fixture's HTTP/guest-specific setup need not be pulled into a storage-only child. Explicitly typecheck every new `.mts` helper.

Native FileHandle operations and `rename` must remain original except at the selected exact file/transaction boundary. A child-local builtin `fs/promises` wrapper plus `syncBuiltinESMExports` may track actual handle→path identity and delegate the original open/write/sync/rename functions. A parent live control may use the equivalent isolated single-worker interception. Qualify interception with a positive no-fault control before treating a missed cut as product failure. Restore every live-process modification in finally.

Metadata paths alone do not identify first/second access publication: both use the same access filename. Inspect the actual original bounded metadata bytes to distinguish pinId=hash(taskDocument) from pinId=hash(parent). For this fixture those document IDs are `task-publication-parent` and `publication-parent`. Do not generate a replacement transaction or infer success from a mocked return. Observe actual content-named `.pending` records and native rename results.

## Publication matrix

Use one-shot uncertainty followed by original live reconciliation, and a separate child held at the same physical transition followed by hard kill/fresh-owner inspection. The ten selected cuts are after the named native operation succeeds, before returning its acknowledgment to the original caller:

| Cut | Exact original transition | Persisted phase at cold cut |
| --- | --- | --- |
| Body sync | `writer.commit`: actual body FileHandle.sync | capturing |
| Leaves sync | Original leaves FileHandle.sync after body sync | capturing |
| Index sync | `buildIndex`: actual index output.sync | capturing |
| Staged operation rename | Atomic rename of original operation record with phase staged | staged |
| Manifest rename | Atomic rename of original manifest in publication step0 | staged |
| First document pin rename | `pins/hash(taskDocument).json`, original pending pin | staged |
| First access rename | `access/hash(parent).json`, pointer to the actual taskDocument pin | staged |
| Committed operation rename | Publication step2's original committed operation record | committed |
| Second document pin rename | Original confirmation's `pins/hash(parent).json` | committed |
| Second access rename | Same access file now points to original parent document pin | committed |

Do not equate a successful native syscall followed by a thrown wrapper acknowledgment with a disk syscall failure. The live test throws once after actual success, then awaits the original uncertainty. The physical child sends its evidence and parks at that same boundary, preserving the original pending promise until its owned hard kill. No graceful drain before a crash.

Every metadata cut must prove the exact selected record, original operation/revision and native destination, and that no later publication step ran before the cut. First/second pin files both keep the source's current `state:"pending"`; current source has no later pin-state-committed transition to invent.

For live recovery:

1. Observe the original attempt's recovery-required disposition and original capture handle. Join current persistence work without issuing another terminalization.
2. Remove the one-shot fault; retry only `tasks.retainResult(task.id)` on the same original registry/capture. Concurrent requests, where deliberately tested, must adopt the same underlying capture.
3. Verify one original operation/ref/digest, exact independent full JSON bytes, unchanged terminal outcome and exactly the two required document pins before a ready artifact descriptor.
4. Require pending metadata records to be resolved without unbounded accumulation. Repeating body/index sync or rebuilding an unfinished index from the original leaves is legitimate; re-lowering the source or minting a new operation is not.
5. The staged-save cut must preserve its already finalized digest/ref. Reconciliation cannot finalize the digest again or reset the capture.

For the separate physical case:

1. Directly launch the actual child with task-owned settings and nonce/id/cut IPC. Retain that ChildProcess only; reject spontaneous normal exit, kill it at the receipt, then await close before creating fresh owners. No scan of process names or unrelated PIDs.
2. Capture exact authority/body/index/pin/access and pending-record evidence at the cut. Metadata readings are test oracles; they do not grant any actor access.
3. Fresh original `reconcileResult(operationId,id)` may report only recovery-required for capturing/staged, including when a candidate ref/manifest/pins exist. A committed operation may supply its original immutable ref. It cannot recreate a missing pin, reopen the old scope, continue a lost encoder or authorize another capture.
4. Acquire the original fresh read composition (`acquireResultReadStore` or the accepted actual SessionService page reader), not a producer with a fabricated project resolver. An explicit read lease uses `readCallerAvailable: () => freshReadOpen`, its own monotonic component lifetime, and original source/profile policy. It does not reuse the old producer's `current`/ownerOf predicate or acquire write ownership to make a read possible. No new producer registration/TaskRegistry.prepareResult/capture/beginResult is permitted on the fresh side.
5. If committed, original task pin/access can authorize bounded body reads even before second-pin confirmation. Read the full literal body through advancing bounded pages before claiming the independent full byte/digest match. That readability does not prove the second pin or task/F1 publication. Preserve full ref/byte identity and actual current source checks.
6. Every selected cold cut is still inside result settlement, before TaskRegistry's terminal save. Require the actual original running task document and its exact baseline bytes to remain unchanged; absence/mismatch fails this fixture. Restore that baseline through the actual TaskRegistry and original qualification path, proving it does not gain terminal success/result/F1 publication from artifact metadata. This is not coverage of a saved terminal/pending/retained task-row crash; those prior qualification controls remain separate. Never synthesize a terminal snapshot or new producer to reach that different branch.
7. Require no new capture/pin/grant/operation, no task success/F1 inferred from metadata, and byte-identical existing authority records after lookup/read. Original lock lifecycle activity is permitted. No model/guest/workspace effect is launched.

The exact scope is process crash on the tested environment, not power loss or full child execution/F1 recovery.

## Coupled original deletion and known refusal

These cases share the fixture but have different assertions from successful live reconciliation:

**Direct coordinator deletion after original uncertainty.** Select first-pin/access and second-pin/access cases. Allow the injected fault to return uncertainty and release the artifact mutation queue. Join current retain/persistence work and verify the real saved baseline still exists, then call the actual `coordinator.deleteOwnedSession(parent,{documents:[taskDocument]})` from the outer fixture. The original store subscriber receives both parent and auxiliary document IDs. Do not await deletion while holding artifact mutate or the parent's session-operation callback.

Direct coordinator deletion closes admissions, waits write/document chains, records deletion and invokes the store listener. It does not drain ManagedDocument settlement sources. This fixture therefore does not install an artificial ManagedDocument source. Actual Gateway deletion first drains `service.closeSession`; that different user-facing lifecycle is not qualified by this component test.

After deletion, retry the same retained original capture only to prove it cannot publish a new ready artifact or resurrect pins/access. Do not demand a successful strict save after the task document was deleted. Check actual deletion receipt, physical pin/access/directory disposition and current source denial. A committed directory may be removed after its last pin releases; unknown staged/capturing evidence can remain protected and unavailable. Do not force cold unfinished captures to finish or claim all unknown bytes were purged.

After measuring the live deletion and same-capture retry, permanently close the original component, join its attempted retention/persistence work, release its LAST store lease, and close the original coordinator; or use a separate fresh process. The same-process option must prove the new store instance is distinct, because a second coordinator/read lease alone can reuse the original module-level entry and its deletedDocuments Set. Do not credit this later cleanup/release as the measured deletion or successful reconciliation.

In the genuinely fresh fixture, independently inspect actual `deletionReceipt(parent)` and actual `coordinator.profile(parent)` or original fresh sourceFor refusal. Separately exercise the accepted bounded reader with the original/candidate ref and record its real disposition. The host reader may reject a deleted profile before reaching storage; the raw artifact reader may reject a missing operation/pin before reaching authorizeResult. Both are legitimate, but neither should be mislabeled as an observed source-predicate invocation. No session is recreated to bypass its tombstone, and the old producer predicate is not reused for read admission. Individual auxiliary-pin release through a trusted lifecycle adapter remains a separate lower-level control.

**Real commit-reserve quota refusal.** Pick an independently calculated fixed body/budget so original open and all bounded body writes succeed but the original commit reserve cannot fit. Record physical inventory and the actual original quota error at that boundary; do not throw a fixture-made ARTIFACT_QUOTA. The original capture reports unavailable/quota with its observed bytes and preserves its actual operational outcome.

**Real second-pin quota refusal.** Body, first pin/access and committed operation fit, while the original second confirmation reserve262144 does not. Use the existing2MiB/approximately1.85MB source control as a starting calculation, account independently for the child JSON and actual metadata, and prove the selected original boundary. Require first task pin/body preserved, second pin/access switch absent, truthful unavailable/quota task retention, unchanged operational outcome, no repeated source normalization or new capture. A retry of the already known-refused task capture cannot upgrade it by inventing authority. Separately inspect the protected original committed artifact through current authorized read.

Use `tasks.retainResult(task.id)` and the existing unavailable descriptor for the known-refusal retry assertion. TaskResultOwner may have removed its now-settled capture from the pending map; do not require a pending handle to remain after known refusal.

**Monotonic component closure.** After uncertainty, permanently set componentOpen=false and retry only the retained original handle. It cannot become ready through a reopened or fabricated scope. Do not flip false→true; a temporarily unavailable policy predicate is not the same as a closed original lifetime.

## Verification and acceptance

Run the positive native interception controls first. Then the focused live/cold publication matrix and coupled cases on fixed source. Add an original-owner repair only when a genuine controlled counterexample identifies the defect; send root original source/evidence/minimal remedy before implementation. Existing passing behavior is qualification, not manufactured RED.

Run affected helper types and relevant existing managed-artifact/ownership/original-owner-pin/retained-child-pin controls sequentially. Run the preceding physical-crash suite only if its shared helpers or applicable owners changed. Broaden tests/builds only for a concrete concern; do not relabel this as A6 packaging.

Retain exact command exits, complete relevant tracked+untracked source manifests, all setup/failure receipts, native transition evidence, independent full body digest, current pin/access identities, actual task outcome/publication and source permission distinctions. Mutable progress stays outside immutable seals. Commit coherent local changes, write exact source-time/qualification limits and freeze for fresh independent review. Root performs its own evidence audit before acceptance and continuation.

## Preflight rulings

Root incorporated two P2 and two P3 findings before dispatch: verify real saved running baseline instead of trusting caught persistence flush; require genuinely retired/new storage for post-deletion cold claims; separate durable profile/deletion evidence from missing-artifact refusal; derive the actual auxiliary identity using taskDocKey(parent); keep component lifetime monotonic. These are fixture/design corrections. If wrong they can hide an absent baseline or stale-instance permission fence, so preserve exact baseline bytes, instance/lifetime evidence and scoped source checks for independent review.
