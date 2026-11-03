# Task2/B2.1 owner implementation preflight

2026-10-23. Static source refinement against the root-supplied accepted checkpoint `119402238ade82688f004f8c01c213009b9993fe` on `codex/v0.1.13-development`. B1 remains accepted. This report proposes executable composition and identifies root decisions; it does not authorize implementation or amend the approved contracts. Only this report was written. No tests, runtime, Git/index mutation, publication, provider work or subagents were used.

Inputs read: `task-2-owner-preflight-brief.md`, `task-2-brief.md`, `task-2-contracts.md`, the earlier `docs/research/context-r4b-design-20261022/bootstrap-preflight.md`, and the focused current owners referenced below. Current B1 and R-B-16/19 supersede historical source descriptions in the earlier preflight.

## Findings requiring a root ruling

1. Replace the value of the **existing** `managed-documents.ts` registry with an opening-entry state, so an issued header operation survives public-open rejection before a Document exists. Keep the existing resolved registry as a derived ready-document reference, not another bootstrap map.
2. Retain a bounded original header-transaction staging artifact, including original manifest binding inputs. The current mutable header alone cannot later reconstruct a manifest that includes original title/model/workspace metadata and original existing-empty qualification. Remove-after-ready would need an additional immutable persisted binding contract; there is none today.
3. Refine `BootstrapResumeToken` into a closed union allowing an explicitly unknown manifest **only for header phase**. Invocation plus an unreadable partial staging file does not supply a digest. The existing required-digest token cannot truthfully represent that cut.
4. Approve the noncircular request/manifest preimages below and the division between B2 byte validation and Task4 genuine caller intent. An invocation/request digest is an identity check, not permission or proof of caller ownership.
5. Add narrow internal bootstrap journal decoding and **historical complete-frame confirmation** in the existing owners. Do not use ordinary `readJournalPrefix` to repair incomplete work, or ordinary suffix reconciliation to confirm an old frame followed by live records.
6. Resolve operation-ID bounds: current core `seedId` allows 256 arbitrary characters, while `encodeFactBatch` allows 256 printable ASCII characters for the entire batch ID. Literal `bootstrap:<operationId>:complete` requires an ASCII operation ID of at most 237 characters. B2 can reject unsupported invocation IDs before issuance; widening/changing the existing B1 reader contract is unnecessary.

The detailed proposals below are recommendations for these rulings, not silently selected public contracts.

## 1. Same registry and lane before a readable header exists

### Current evidence

- `packages/session-persistence/src/coordinator/managed-documents.ts:16` stores `Map<string, Promise<Document>>`; `:17` stores resolved Documents; `:45` deletes every failed opening. Public `open` returns an existing promise without a readiness distinction.
- `packages/session-persistence/src/index.ts:53` and `:57` already fence raw append/enqueue with `managed.has`. The same predicate must include bootstrap openings. `:60–62` routes snapshot/load/loadOwned through the registry; rejection must not fall through to normal loading.
- `packages/session-persistence/src/coordinator/ownership.ts` has the sole `withSessionOperation` chain and held-lease map. `loadOwned` already enters that lane, so calling it inside another session operation deadlocks.
- `packages/core-session/src/managed/view.ts:16` captures the header, freezes the public view and constructs the one index. There is no legitimate reheader operation. `createBootstrapManagedSessionState` is already available through `@i-harness/core-session/internal/bootstrap`.

### Proposed private entry

Change only the value in the existing `documents` map. An illustrative private shape is:

```ts
type ManagedEntry = {
  origin: 'ordinary' | 'bootstrap';
  lifecycle: 'opening' | 'blocked' | 'ready' | 'closing' | 'closed';
  flight?: Promise<void>; // current opening/bootstrap orchestration, not a queue
  document?: InternalManagedDocument;
  bootstrap?: {
    invocation: Readonly<BootstrapInvocation>;
    manifestDigest?: Digest; // internal knowledge, never a fabricated digest
    phase: BootstrapPhase;
    original?: Readonly<CapturedBootstrapRequest>;
    header?: Readonly<HeaderOperation>;
    disposition: 'unissued' | 'issued-unknown' | 'confirmed';
  };
};
```

`CapturedBootstrapRequest`, `HeaderOperation` and `InternalManagedDocument` are private implementation types, not proposed JSON/public authority DTOs. The header operation owns original encoded staging/header bytes, target qualification and issued/confirmation state. It is not another fact queue. Once a Document exists, seed/completion uncertainty stays in its existing `Pending`, capacity ticket and quarantine.

Insert the entry synchronously before the first await. Same target plus the identical invocation and captured original manifest joins its current flight. Same operation with another manifest conflicts without replacing the entry; another invocation conflicts. An ordinary opening already present, including a cached pristine Document, produces `cached-unprepared`. Never close/evict/reopen it to obtain a different header/view.

Do not leave a rejected `Promise<Document>` as the retained representation: reject the individual public call while retaining the entry. Delete an ordinary failed opening or a bootstrap entry only after **proved zero issuance/no unresolved work**, or successful lifecycle close. Catching a header call rejection after its issued latch is set records unknown and retains the original operation. A cold invocation-only entry may have no original payload, no readable header and no Document; it still reserves registry identity and blocks ordinary loading.

Public `open`, snapshots, normal load/loadOwned and any action/source admission refuse while the entry is incomplete. Existing `assertObservable` only tests pending/quarantine; add bootstrap readiness to that gate and to `assertReady`, `beginAction`, ordinary fact admissions and `registerReceivedInputSource`. Private phase admission does not expose a public skip-readiness flag. Public projection of any accidentally retained incomplete view must continue to fail B1 readiness validation.

Construct the sole bootstrap managed state **after exact header confirmation**, from the immutable original reservation plus the validated complete committed prefix (which may be empty), through `createBootstrapManagedSessionState`. Never construct a provisional header and mutate it later. Ready transition installs the completion group in that same state/index and changes registry visibility; it does not create a second Document. The `resolved` map, if retained, mirrors only the published ready Document and remains derived from the same entry.

### Lane and lifecycle sequence

1. Validate/capture caller data and compile/validate the whole proposed manifest outside the target lane. Insert/check the registry entry synchronously. Read `pendingWriteBehind(id)?.hasWork`; a pending/active write-behind disqualifies existing-empty. Do not flush it into a target and then call that target pristine.
2. Enter `withSessionOperation` for lease acquisition, target qualification and one header I/O step, using an explicitly private unlocked helper. Call neither public `loadOwned` nor a queue admission while awaiting inside that lane. Recheck deletion, cache identity, write-behind work and current guard under the lane immediately before mutation.
3. Release the lane before dependency-port awaits and before enqueueing/awaiting a private phase. Each existing pump iteration obtains the lane itself. Same-operation orchestration is joined by `entry.flight`, not by another map or scheduling queue.
4. Cold `loadBootstrapOwned` is a private path in `load.ts` using the same lease and lane. It consumes the private no-repair journal read described in section 5, checks growing-prefix validity, and constructs the one state. It never calls public `loadOwned` and catches/suppresses its readiness error. It never performs turn-tail repair on an incomplete reservation.
5. Close/release first closes new admissions, awaits the entry flight and existing pump, then closes/drains the Document if present. An unknown header, unknown batch or failed install rejects close with recovery-required, retains entry/bytes/ticket and keeps the lease. `index.ts:67` already skips lifecycle lease release when `managed.close()` rejects; preserve that order. Passive reconciliation remains available after revocation. A known incomplete reservation with no issued uncertainty can be closed safely after orchestration stops; its frozen in-memory payload is then lost, so cold continuation may honestly require that payload. Safe close cannot assert readiness.

Existing `create` and `updateMeta`/format-upgrade entries also need registry-aware fences against a non-ready bootstrap opening, under the same lane. `updateMeta` can otherwise change title before original header reconciliation; `create` can otherwise fill an absent target while its staging operation is retained. Keep ordinary mutable metadata supported after ready. No new deletion authority is conferred by bootstrap; unresolved issued work must not be silently discarded by a lifecycle bypass.

## 2. Qualified header operation and physical reconciliation

### Why existing methods cannot serve

JSONL `index.ts` creates with `writeFile(..., {flag:'wx'})` and no qualified outcome. Ordinary `updateMeta` uses a random temp and rename with no header receipt. `format.ts:38` now correctly snapshots protected metadata; R-B-16/19 expressly forbid using this route to introduce/change the reservation. `backend/session-io.ts:13` uses a random staging path and unlinks failed staging files; that cleanup behavior is unsuitable for an issued uncertain bootstrap header. Reuse its I/O discipline, not that operation's identity or failure cleanup.

Keep the approved `prepareBootstrapHeader`/`reconcileBootstrapHeader` seam in the existing backend and coordinator owner. Its exact operation identity must also reach the backend when original header bytes are unavailable: a private captured operation argument or additional narrow read/inspection method is required. Bytes alone are enough to parse a full new header, but cannot identify invocation-only cold partial state. Root should approve these backend signature details together with the token refinement.

### Deterministic staging and original binding

Recommended names within the existing target artifact directory:

```text
target = filePath(targetSessionId)
K = SHA256(UTF8(canonicalJsonData(full BootstrapInvocation)))
originalStage = target + '.bootstrap-' + K + '.stage'
publicationTemp = target + '.bootstrap-' + K + '.publish'
```

`K` is a filename key, not a manifest/request digest or proof of authority. No caller path components or raw operation IDs are interpolated. The stage is one bounded **header-transaction artifact**, not a payload store, queue or new owner. It contains a closed versioned record with the full invocation, original creation target qualification, original selected metadata/lineage, original header-base snapshot, compiled scalar/source-observation descriptor and exact final header bytes. It deliberately need not contain semantic groups or initial input text. Keep enough original binding to reconstruct the manifest with committed target records later. Suggested hard bound: 256 KiB for this record and 64 KiB including LF for final header bytes, checked before first issuance; root must confirm the limits. No full source archive is staged.

Retain `originalStage` after ready. It must be a separate regular file, never a hard link to the growing target. Otherwise later append would mutate the supposed original header evidence. `publicationTemp` is disposable only after target confirmation; uncertain/partial bytes are retained under the same operation. All staging bytes are captured data with exact schema/encoding, no getters or serialization callbacks after the final check.

This retained record is necessary for the proposed manifest binding. Current `SeedHeaderV1` contains only a manifest digest, and current B1 readers validate seed/initial hashes but do **not** recompute the complete target manifest. Current title/model/workspace cannot reconstruct original caller metadata after edits. If root rejects retained header staging, root must instead select an immutable bounded original-binding field/record and corresponding codec change; deleting staging and inferring old metadata from the current header is incorrect.

### Issue and cuts

- **New target:** stage the original bounded transaction with exclusive create, complete-write loop and file sync. Publish target via exclusive `open('wx')`, write the exact captured header bytes with a complete-write loop, then target sync. Do not use ordinary rename-overwrite for new-target publication. This conservative path duplicates a bounded header write but avoids a new platform-specific no-clobber-rename primitive. There is no new file-link dependency.
- **Existing-empty:** require uncached current-format11 target with exact original raw header digest, exact zero-event `JournalPrefix`, no extra/torn body bytes, no write-behind work, and no ordinary open owner. Stage original transaction; materialize the exact header bytes in deterministic `publicationTemp`, sync, re-read/check the expected original target under the same held lane, then rename. Preserve unrelated raw header metadata in the final owned header-base snapshot. `blank/no turn-start` is insufficient: even a single metadata event is nonempty. Legacy upgrade is not folded into this narrow existing-empty transaction; qualify/upgrade separately before taking its exact expectation.
- `headerDigest` means SHA256 of the exact published header bytes **including terminating LF**. It is physical evidence, distinct from the domain-separated manifest hash. Existing-empty expectedHeaderDigest uses the same exact-byte convention. Do not hash a parsed/whitelisted header and call it raw equality.
- Authenticate backend owner with the existing `isHeldFactOwner` check, match target ID and call `assertHeld`. Check cancellation/current source immediately before the first persistent mutation (including exclusive file creation), again before first payload write after awaits, and before publication/rename. A header-specific `beforeIssue` wrapper may recheck guards repeatedly while setting one idempotent issued latch; do not reuse the ordinary fact-pump callback that throws on its second issue.
- A guard failure with no persistent issuance is not-issued. After a stage/target mutation has issued, preserve the invocation and report its actual blocked phase; source change or Stop cannot turn it into a fresh absent target or authorize a replacement invocation.
- Before any issuance: absent is unambiguous. During stage write/sync, target write/sync, publication rename or response loss: classify conservatively unknown unless exact evidence proves the original disposition. No truncation/delete/rollback of an issued header operation to regain pristine status.
- Held-only reconciliation verifies original stage and published target. Exact complete published header bytes can be synced and confirmed under the lease. Complete stage plus unchanged existing-empty target is not yet a committed header. A matching partial stage/target remains unknown during **passive** reconciliation. With original exact payload and a current issuing guard, a separately explicit continuation can finish only the original matching byte-prefix/publication operation; it cannot switch operation, rewrite foreign bytes or perform a fresh new-target create over an existing partial target. This same-operation continuation behavior needs root approval as part of the backend method semantics. Stop permits sync/read confirmation but forbids that continuation or another phase issuance.
- Mismatching complete bytes are conflict. Unreadable/partial bytes without original expected payload do not establish either a conflicting manifest or absence. A complete target header for a different invocation conflicts; staging path existence alone never makes its contents trusted.
- After confirmed file sync, close/cleanup failures are diagnostics and cannot erase commitment, as with the current fact journal. Directory sync remains best-effort under the existing Windows-qualified filesystem semantics (`session-io.ts`, `format-upgrade.ts`); do not advertise universal power-loss persistence of rename/directory entries.

`inspectBootstrap` uses only reads/stats, the deterministic invocation staging path, bounded stage/header decoding and private structural journal inspection. It never opens `r+`, syncs, truncates, renames, acquires a managed owner or produces a FactReceipt. A physical ready hint still needs owned confirmation.

### Staging deletion/cleanup ownership

JSONL `index.ts:289` deletes the target JSONL plus declared documents/files; it does not know bootstrap staging today. Extend this **existing** owned deletion inventory narrowly: discover sibling filenames with the exact target basename plus `.bootstrap-`, exactly 64 lowercase hex characters, and `.stage`/`.publish` suffix. Run the existing confinement/symlink checks, include them in the original deletion receipt's owned files before tombstone commit, and unlink through the existing deletion path. Discovery must work even for a partial unreadable stage, so deletion cannot depend on parsing it or on having a live invocation. The tombstone still fences later same-operation resume. Do not enumerate/delete arbitrary `.tmp` files or introduce a general cleanup service. Failed confirmation never proactively deletes staging as a substitute for recovery.

## 3. Honest unknown-manifest token

The current core definition at `events/bootstrap.ts:5` always requires `manifestDigest`. A partial stage write can leave only a deterministic name and unparseable bytes; a partial target header may have no digest at all. A caller may hold only the original invocation. Neither the path nor requestDigest supplies the missing manifest.

Recommended smallest closed refinement, preserving the shape of known tokens:

```ts
type BootstrapResumeToken =
  | { version: 1; invocation: BootstrapInvocation;
      phase: BootstrapPhase; manifestDigest: Digest }
  | { version: 1; invocation: BootstrapInvocation;
      phase: 'header'; manifest: 'unknown' };
```

Exact-key validation forbids both forms at once, unknown-manifest seed/dependency/completion tokens and `manifestDigest: undefined`. This is smaller than making digest optional everywhere. Core DTO consumers in the later Task4 observations must use the union, not fill missing strings. The current foundational type has no shipping V2 parent/team token consumer to justify inventing one during B2.

Invocation-only inspection can report `unavailable`, `needsConfirmation:true` plus this header token when a matching deterministic path/partial target exists but its identity-bearing contents cannot be confirmed. Do not report `reserved` with a known manifest unless validated stage/header data establishes it. With neither target nor same-operation staging present, report absent as a read-only observation, not durable absence proof. A valid full stage can provide its real manifest even before publication; it still cannot supply omitted semantic payload/initial text.

`resumeSemanticTarget(invocation, guards)` returns blocked/payload-required with the unknown-manifest token for an unreadable partial operation. Supplying the original request allows reconstruction/comparison of expected bytes and the separately guarded same-operation continuation above. It never allows deriving bytes from the digest or re-exporting changed source to fill a gap. An alternative is retaining the current token and returning only inspection-unavailable; that cannot represent the approved blocked/payload-required outcome for this cut and weakens recovery visibility. Root should rule before code.

## 4. Noncircular digest preimages and genuine logical intent

Use the existing canonical JSON/hash convention and B1 constants. `core-session/src/conversation/seed-digest.ts` owns empty seed/dependency constants and source preimages; B2 neither changes nor invents these hashes. The initial input is the real event shape from `subagent/src/child/generation.ts:21`: version1, supplied fixed inputId/text, queue/user and inherited observation provenance producer `subagent.initial`, plus actual parent origin when present. Construct/capture and validate this event once; omit only physical seq for R-B-13 hashing. Require `initial.parentSessionId` to agree with genuine lineage, not provide another parent override.

The shared implementation must also be reachable through the reviewed package boundary. `seedHash` is currently private and the B1 readiness reader invokes it directly. Factor the exact initial-event digest calculation into a narrow core helper consumed by that reader and B2, exported through `./internal/bootstrap` (or a root-approved public data-only export with its actual B2 consumer). The existing empty constants are already exported at `core-session/src/index.ts:109`; consume them directly. Do not import cross-package private relative paths or duplicate the initial-admission hashing algorithm in persistence. These are source-boundary refinements, not a new admission owner.

### Request identity — host/caller input, not observed source state

Proposed exact `ih.bootstrap.request.v1` top-level preimage:

```ts
{
  version: 1,
  caller: { kind: 'fork' | 'import' | 'spawn' | 'approval-review' | 'team',
            intent: /* closed data supplied by that real host entry */ },
  source: { kind: 'none' }
        | { kind: 'session', sessionId, selection }
        | { kind: 'anonymous', contentDigest },
  target: /* original new/existing-empty logical target choice */,
  metadata: /* exact caller-selected BootstrapCallerMetadata, including absence */,
  lineage: /* fixed trusted BootstrapLineage */,
  initial: /* absent, or fixed input identity/text/parent/clocks */
}
```

The top-level keys are proposed for root freezing; `caller.intent` is intentionally a **Task4 per-entry closed schema decision**, not permission to accept arbitrary JSON or silently define a generic new intent DTO in B2. Fork intent must include its requested selection/boundary and explicit metadata choices; spawn intent must include actual task, role identifier and explicit caller overrides; anonymous content binds its captured content digest because its content is the logical import itself. Session source observation revision/selected seed bytes, resolved current role settings, current inherited defaults, provider credentials, callbacks and capabilities are excluded. Those observations can change during an original-intent retry without changing the logical request. A changed task/selection/declared role/explicit override is another intent and cannot adopt the old invocation. Original captured initial clocks/identity survive retry rather than being re-created.

B2 receives a trusted `BootstrapInvocation` and cannot prove that a caller honestly computed this requestDigest: its API lacks the originating role/task fact and may not have the original source after ready. B2 validates closed invocation shape, equality with staged/target binding, exact original payload and manifest, then current guards for actual new issuance. Task4 must create/persist the digest from actual host input before mutation, retrieve the original committed V2 source intent on retry, and refuse attaching changed logical intent to its invocation. A hash is not authority; arbitrary model/RPC parameters cannot supply the invocation/lineage/dependency capability. Do not claim B2 tests alone establish this future ownership link.

Ready invocation-only resume does not export current source or resolve current role/provider state. It adopts historical storage readiness under the current held target owner. Any actual new execution still goes through the existing current preparation/instruction/Stop boundary; a ready receipt never authorizes rerunning a launched/uncertain task.

### Manifest identity — exact original materialization

Recommended `ih.bootstrap.manifest.v1` preimage:

```ts
{
  version: 1,
  invocation, // includes requestDigest; no manifestDigest
  target: originalCreationQualification, // new or exact existing-empty expectation
  metadata: originalSelectedMetadata,
  lineage: originalLineage,
  headerBase: originalFinalHeaderWithoutSemanticSeed,
  seed: { digest, dependencyDigest, sourceObservation, records },
  initial: /* absent, or { inputId, digest: initialInputDigest, startedAt, expiresAt } */
}
```

`headerBase` is the captured final header before adding semanticSeed: current format/journal, invocation target ID/createdAt, final lineage, seedLength and all preserved ordinary metadata. It binds the originally effective title/workspace/model as well as caller selection. `records` are the validated deterministic addressed manifest/group records, so exact compiled bytes are bound in addition to semantic scalars. Store all preimage inputs **except records** in original staging; ready reconstructs records from the target. A cold partial target still needs missing original records/initial admission body; the bounded stage is not a promise of automatic payload recovery.

Exclude the final semanticSeed object, its own manifestDigest, final serialized header bytes/headerDigest, stage hash/path, journal batch IDs/digests/receipts, dependency closure confirmation, owner incarnation, runtime authority and current guards. Thus the order is initial event hash → compiled seed/scalars → manifest → SeedHeaderV1/final header bytes → header stage bytes → journal batches → receipts. No digest includes itself. Resume transport `{kind:'resume'}` never replaces the original target qualification in this preimage.

Batch identities remain `bootstrap:<operationId>:seed` and `bootstrap:<operationId>:complete`. Use `encodeFactBatch` unchanged for physical batch/predecessor/prefix hashes. The seed group is one exact deterministic frame when seedLength>0; no empty frame for none. Completion frame contains marker at seq=seedLength and optional initial admission at seq=seedLength+1, together. Stage names depend only on invocation, avoiding a lookup cycle through an unreadable manifest. Enforce the operation-ID bound above before reservation.

## 5. Ready reentry, mutable metadata and later live suffix

### Actual missing capabilities

- Core `serialization/fact-journal.ts:67` verifies physical frames then calls **public full** `validateConversationHistory`. It cannot currently return a valid incomplete reservation.
- JSONL `backend/fact-journal.ts:50` calls that reader, then opens `r+`, truncates a torn tail and syncs. It is neither pure inspection nor an acceptable first step for an unknown original bootstrap batch.
- JSONL `backend/fact-journal.ts:115` rejects `size > requestedPosition + batch.bytes.length`. It correctly reconciles a pending terminal suffix but cannot confirm a seed/completion frame followed by ordinary live frames.
- B1 `conversation/bootstrap-validation.ts` checks scalar agreement, complete seed digest/dependency digest and actual initial-event digest. It does not reconstruct the full target manifest. The retained original binding is therefore required for B2-owned ready adoption.

### Narrow composition proposal

Extract the physical decode/chain verification already owned by core `fact-journal.ts` so its normal public function still performs strict ready validation. Expose only an internal bootstrap reader through the **existing** `./internal/bootstrap` bridge. It uses that same decoder and the existing bootstrap validation profile, returns complete frame boundaries/keys plus torn-byte extent, and never grants repair authority or a public skip-readiness switch. Validate growing-prefix history in the sole bootstrap managed state; do not keep a second long-lived index in the registry/inspection object. Inspection can use transient structural validation without constructing a writable runtime.

Extend the existing JSONL journal owner with a narrowly qualified historical confirmation operation, illustratively:

```ts
confirmBootstrapFrames(id, heldOwner, expectedFrames): Promise<
  | { kind: 'committed'; receipts: readonly FactReceipt[] }
  | { kind: 'unknown' | 'conflict' }
>;
```

This is proposed backend surface, not an existing helper. It reads/verifies exact original deterministic frames at their actual chain positions, verifies complete later frame chaining and full public-ready history, then syncs the target under the current held owner and returns receipts for those exact frame keys. It performs no write/truncate and does not replay the original append or observers. Receipt prefixDigest is that frame's resulting prefix, not the latest live suffix prefix. For an independently torn later suffix it may confirm the complete original frames while leaving ordinary suffix recovery to its owner; this must not expose a writable Document before normal suffix recovery is qualified. Use the existing owner authentication and outcome/receipt validation conventions; do not relabel a reconstructed receipt as a newly issued append.

Cold ready adoption control flow:

1. Read the current target plus retained original stage without mutation; match invocation and immutable reservation/birth fields. Read original metadata/qualification from the stage, **never** infer them from current renamed/archived/model/workspace values.
2. Reconstruct semantic records and initial digest from the actual committed prefix; recompute the proposed full manifest using original stage inputs; compare to the reservation and stage. Validate actual deterministic seed/completion frame boundaries and keys; reject an arbitrary whole-body canonical rewrite that has replaced those frames even if B1 semantic history remains valid. Semantically valid history alone is not evidence for the original operation's deterministic receipts.
3. Confirm the historical frames under the held owner. Preserve their exact keys but bind returned receipts to the current Document owner incarnation. Reuse the current sole ready Document if already cached; for a cold entry construct it once from the verified current header's immutable scope and whole complete archive, then confirm using that Document's owner context. No original-header full-byte confirmation is claimed after legitimate mutable metadata changes.
4. Expose already-ready and the fixed initial receipt address/clocks. Do not enqueue/import seed, create another initial input, launch generation, replay observers or consult changed source. Later ordinary live facts remain present. The original metadata binding is historical; current mutable metadata continues to work.

If a ready target lacks readable retained binding, current B1 header/seed validation alone cannot prove the proposed full manifest. Return honest payload-required/unknown unless the original request reconstructs all original binding (including existing-empty expectations and originally preserved metadata) and verifies the exact frame evidence. Do not upgrade a literal B1 test fixture with arbitrary manifest `bbbb...` into a qualified B2 ready receipt.

Incomplete resume uses the stricter original full header bytes plus exact original payload/current guard. It may reconcile an original issued seed/completion batch with the existing terminal-suffix algorithm; a matching partial suffix can be truncated+synced only by that original journal operation to prove absence. Do not call generic torn-tail repair before reconstructing that original batch. A not-yet-issued phase requires current guards; an unknown issued phase first reconciles passively. Source changes after reservation return blocked/source-changed with the original token, never a refreshed manifest.

## 6. Phase composition, boundaries and focused actual tests

### Queue integration

`managed-document.ts:183` always chooses a random batch ID; ordinary `importSeed` goes through public `FactGroupDraft`/`resolveFactGroup`, whose seed-import is allowed only at seq0 into an empty view. It cannot carry the completion marker after the prefix. Do not overload metadata facts, weaken the raw-import rules or add a public arbitrary-bootstrap group.

Add a private bootstrap entry variant to the **same** queue. It carries captured exact addressed events, fixed phase/batch ID and a source/Stop assertion. The existing capacity, pump, `state.stage`, `Pending`, `finish`, quarantine, held/issuing contexts and observer-after-lane order remain authoritative. Coalescing must isolate a bootstrap phase from ordinary entries and from the other phase. Private exact events go through the bootstrap managed state's full stage validation; no broad public `FactGroupDraft` change is needed. Deterministic seed/completion events are reconstructed/captured once, not regenerated from mutable callers during retries. Unknown keeps its original ticket/bytes; only original reconciliation or proved absence changes disposition. Public-ready checks must be added to all ordinary ports, not merely `assertReady`.

Concretely, make the current private queue `Entry` a discriminated `FactEntry | BootstrapEntry` with its existing common ticket/authorization/resolve/bytes/seqs fields. FactEntry keeps the captured public group; BootstrapEntry carries `phase:'seed'|'completion'`, exact captured events and the fixed batch ID. In `run`, only FactEntry calls `resolveFactGroup`; BootstrapEntry validates its expected start seq and uses the exact captured addressed events before the common `state.stage`. `finish` updates `sourceDispositions` only for entries that have a real captured group, then uses the same receipt/install/ticket path for both. Return the private phase-admission control as a sibling composition handle from the constructor to `managed-documents`/`bootstrap.ts`, not as a property exported on `ManagedDocument` or an arbitrary-event port. Bind it to the entry's original invocation/manifest; its ordinary authorization cannot skip current guards merely because bootstrap is incomplete. This preserves one bound public fact owner and one private managed state.

`compileSemanticSeed` and new coordinator/backend methods may stage their real APIs in B2. They have actual internal producer/consumer calls, not fake graph consumers. The known real fork/spawn switch is Task4; `fork.ts` remains on its current raw path in this storage-only slice, with raw remapping retained. Do not claim its intentionally RED `semantic-fork-baseline.test.ts` becomes green in B2 or change it just to erase the consumer gap. If task file lists imply switching fork now, root should explicitly retain the owner brief's Task4 boundary.

Task3's `BootstrapDependencyPort` is injected. B2 checks exact returned closure descriptor and truthful blocked/confirmed outcomes; it does not implement an artifact grant. Tests can provide controlled confirmed/blocked ports and assert exact request/current callback behavior, but those fixtures cannot become a shipping default that confirms nonempty dependencies. Source authorization/current policy remain host capabilities outside DTOs. Zero-dependency handling must use the established exact empty closure convention; it cannot become a generic permission fallback. Source/Stop guards surround dependency awaits and each phase issuance; reconciliation of previously issued effects is passive and does not start optional work.

### Existing helpers and fault points

- `session-persistence-jsonl/test/fact-batch-journal.test.ts:11` already mocks `node:fs/promises.open`, calls `vi.importActual`, and wraps real FileHandles with bound methods. Reuse this pattern for short writes, zero progress, write/sync/truncate/close failure and barriers. Its tests at `:127`, `:155`, `:285` and `:609` qualify short writes, uncertainty, retained close holds and post-sync cleanup diagnostics. Use `Promise.withResolvers` for physical cuts, not arbitrary sleeps.
- The same test at `:61` wraps the **actual** `backend.appendOwnedBatch`, lets it commit and then returns unknown. Reuse that for lost responses after real sync; independently read target bytes/frame keys. Wrap actual new header/backend methods similarly for response cuts. A wrapper returning fake committed without I/O does not qualify durability.
- Mock actual `rename` alongside `open` for existing-empty pre/post publication cuts. No injectable bootstrap phase-hook API exists today. A before-install cut can be driven by a real managed-state installation wrapper/module mock at the imported internal bridge, or by a backend response barrier followed by installation failure; do not assert that a new imaginary `onPhase` hook already exists. Keep any test seam private to tests.
- `core-session/test/fixtures/format11-seed.ts` supplies literal seed data for compile/validation controls. Its ready fixture uses an arbitrary manifest scalar and cannot be used as qualified storage evidence without constructing the new operation's genuine manifest/staging/frames.
- `session-persistence-jsonl/test/semantic-publication.test.ts` exercises actual R-B-16/19 metadata methods, equivalent protected no-ops, computed metadata callbacks and exact torn body preservation. Add bootstrap adoption tests beside these behaviors without weakening them.
- `createSessionCoordinator(createJsonlBackend(root), {lock:{enabled:true}})`, `mkdtemp`, `readFile`, `writeFile`, `encodeFactBatch` and `decodeFactBatch` are existing real test building blocks. Supported Windows fs-lock is required for actual durable coordinator tests; do not replace it with a structurally fake owner callback.

### Compact test matrix

| Area | Entry/cut | Independent oracle |
| --- | --- | --- |
| Compiler | none, non-none, observation-only; malformed compiled digest/record/source slot | Literal B1 empty constants; deterministic records and exact seedLength; no parent access for none; altered record/digest refused before file mutation |
| Target qualification | absent; exact uncached empty; pending write-behind; metadata-only nonempty; cached ordinary empty; foreign reservation | Actual raw header/body before/after; exact zero events rather than no turn; no overwrite/open-owner replacement |
| Registry/lane | concurrent same invocation; changed manifest; ordinary open/snapshot/load while header response held | One retained entry and one eventual view/owner; one stage and deterministic frame each; public calls reject without eviction; recursive observer has no nested-lane deadlock |
| Header | pre-issue guard; partial stage; complete stage sync failure; partial target; target sync; rename before/after; lost response | Actual filesystem bytes plus issued counters; original deterministic name and createdAt; unknown survives; no deletion/rollback/new operation; held reconcile versus guarded original continuation distinguished |
| Header token | invocation-only with unreadable stage/target; full stage but missing seed payload; foreign full header | Unknown-manifest header token only when digest absent; real digest when recoverable; payload-required with unchanged bytes and zero sync/write for inspect |
| Dependencies | controlled unavailable/unknown; current source changes or Stop during await; exact original confirmed closure | No seed/completion/initial issuance before required confirmation; original token/target retained; no Task3 grant claimed |
| Seed | full frame sync then response loss; partial frame plus failed absence proof; install failure | Actual full/partial frame; managed events remain private until receipt/install; original pending key/bytes/ticket; reconcile does not append twice; cleanup error preserves receipt |
| Completion | marker+input sync then response loss; none without seed frame; initial text/provenance/clock mismatch | One completion frame with adjacent fixed input; one actual inputId/seq, original clocks; no early public-ready state or generation launch |
| Stop/source | before first mutation; after header; after seed; after completion commit | not-issued only before issuance; blocked original phase afterward; passive confirmation allowed, no unissued next phase under stale/cancelled guard; no fresh deadlines |
| Close/cold | unknown header before Document; unknown pending frame; revoke during dependency await; confirmed partial safe close | Failed close retains unknown bytes/owner; no lifecycle release; cold original payload resumes same target; invocation-only missing bytes stays payload-required; no normal repair of unknown suffix |
| Already-ready | current title/archive/model/workspace edits; source changes; later live suffix; fresh process incarnation | Original staged metadata recomputes same manifest; current metadata/body retained; exact original historical-frame receipts under current owner; no old full-header byte claim; no duplicate input/action/observer or source export |
| Binding/lifecycle | missing/corrupt stage, same invocation with changed original metadata/target expectation, deletion of partial stage | Cannot prove manifest from current mutable header; missing binding is honest blocked; exact owned deletion receipt includes only target's deterministic staging files; tombstone blocks resume |

No tests were run for this preflight. Once root rules and authorizes implementation, run the two planned suites, relevant existing journal/publication suites and persistence/JSONL/core typechecks. The real fork baseline remains a separately documented Task4 consumer gate; artifact/native/live-provider behavior is not qualified by this slice.

## Sequential implementation slice after root ruling

1. Freeze the token union, exact hash/binding schema, staging retention/cleanup, operation-ID bound, same-header continuation semantics and private backend signatures above. Preserve B1 public readiness and R-B-16/19.
2. Add pure compiler and closed bootstrap capture/manifest construction with independent digest/initial-event tests. Add no real caller switch.
3. Refine the existing registry entry/lifecycle and add private cold bootstrap decoding through the existing core bridge. Add readiness/admission fences and no-repair cold tests before header issuance.
4. Implement qualified header leaf/coordinator composition with deterministic original stage and exact new/existing-empty paths; qualify real physical cuts and read-only inspection/token behavior.
5. Add private fixed-phase entries to the existing pump, then injected dependency orchestration, seed/completion receipt sequencing and source/Stop checks. Qualify unknown/absence/install/close behavior.
6. Add exact historical-frame confirmation and ready adoption using retained original binding, current held owner and later live suffix. Qualify mutable metadata and source-change reentry without duplicate execution.
7. Run focused verification and request fresh functional review. Root decides acceptance and later Task3/Task4 dispatch. This report provides no self-approval.
