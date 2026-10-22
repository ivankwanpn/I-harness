# R4B Task2 owner composition rulings

Root decisions after the [source preflight](2026-10-23-context-r4b-b2-owner-preflight.md) at119402238ade82688f004f8c01c213009b9993fe. These refine the approved [R4B plan](../superpowers/plans/2026-10-22-context-r4b-semantic-inheritance.md); they are implementation requirements, not acceptance. B1 remains accepted. Product0.1.13-rc.1 and Session11 stay unchanged. Task2 covers compiler, qualified storage and same-owner bootstrap; Task3 owns actual artifact transfer, Task4 actual callers. No decomposition-only work, provider requests or publication.

## R-B-20 — one registry, one phase writer

Refine the existing managed-documents map value into an entry which retains ordinary/bootstrap origin, current flight, optional sole document and captured bootstrap operation. Insert it synchronously before the first await. No second opening map, fact queue or index. An issued header operation without a Document survives rejection of individual public calls. Same invocation and exact materialization join; different invocation/materialization conflicts. An existing ordinary opening/view remains cached-unprepared, including a pristine empty one.

Public create/open/load/snapshot/append/enqueue/metadata/format-change paths must not bypass an incomplete entry; checks that protect mutation are repeated under the existing lane. A pending or active write-behind disqualifies an existing-empty target, without flushing it into a supposedly pristine target. A header-confirmed target constructs exactly one bootstrap managed state through core's internal/bootstrap bridge, never a provisional header followed by reheader/reopen.

Add a private bootstrap variant to the current queue and isolate each deterministic phase from coalescing. It uses the same capacity, stage, Pending, finish/install, quarantine and observer-after-lane behavior. Ordinary FactGroupDraft/importSeed stays unchanged; no public arbitrary batch ID, event insertion or skip-readiness flag. The sibling private composition handle is bound to the captured operation. All public ports/source/action registration stay unavailable until exact completion, including while the internal view exists.

The registry flight joins orchestration, not another queue. Release the session lane before dependency awaits or enqueue-and-await; private unlocked helpers are used inside the lane. Close/revoke waits for that flight and existing pump. Unknown header/batch/install retains its entry/pending work and lease and returns recovery-required; passive reconciliation remains possible. A confirmed incomplete reservation with no issued uncertainty may close after stopping orchestration, honestly losing only its volatile original payload. Do not silently evict uncertainty.

Cost if wrong: duplicate creation, deadlocks, early execution or lost reconciliation. Actual same-op concurrency, failed-open retention, public refusal, close and reentrant-observer tests are required.

## R-B-21 — bounded original header transaction and exact continuation

Use the existing JSONL owner with deterministic sibling artifacts:

- target is the existing filePath(targetSessionId).
- K is plain SHA256 of UTF-8 canonicalJsonData(the complete validated invocation).
- original stage is target + '.bootstrap-' + K + '.stage'.
- publication temporary is target + '.bootstrap-' + K + '.publish'.

The original stage is a closed version1 header-transaction record, retained after ready and never hard-linked to the growing target. Its fields are version, kind='semantic-bootstrap-header', invocation, originalTarget, metadata, lineage, headerBase, seed and optional initial, plus headerBytes. seed has digest, dependencyDigest, sourceObservation, seedLength, groupCount; initial has inputId, digest, startedAt, expiresAt. headerBytes is the exact UTF-8 header string including LF. It excludes all semantic groups, initial text, credentials and runtime objects. Recompute and check all redundant identities when reading it. Limit encoded stage to262144bytes and final header including LF to65536bytes; reject before issuance if either exceeds its existing header-oriented budget. These limits do not cap the session archive or semantic payload.

Preserve this stage because current mutable metadata cannot recover original manifest inputs. Store no second raw transcript or generic bootstrap database. Before a new operation issues, discover only exact target-owned .bootstrap-<64hex>.stage/.publish siblings and refuse a foreign retained operation. Unknown bytes cannot be treated as an absent reservation. Same-operation identity comes from the supplied invocation plus checked bytes, never from a filename alone.

New target: exclusive stage creation, complete writes and file sync; then exclusive target creation and exact bounded header write/sync. No overwrite rename for new-target publication. Existing-empty: require uncached format11, exact raw header digest, exact zero-event journal prefix and no extra/torn body or pending writes. Preserve unrelated original JSON metadata in headerBase rather than rebuilding it from the lossy compatibility parser. The invocation's target ID and createdAt must agree with the original existing-empty header. Materialize and sync the fixed .publish file, recheck the unchanged original target, then rename under the held lane. Raw header digest is plain SHA256 of bytes including LF.

Capture strict data and final bytes before awaits. Owner/target checks use the existing held-owner context. Recheck the current source/instructions/Stop guard before every first persistent mutation or publication after an await. Use a header-operation issued latch that can recheck the guard multiple times; the ordinary single-issue fact callback is not a repeated header guard. No callbacks may mutate checked expected data or regenerate serialization after the final comparison.

prepareBootstrapHeader accepts the validated original operation (invocation, original new/existing-empty target, exact stage/header bytes), and either first issues or continues that SAME matching operation with an issuing owner. reconcileBootstrapHeader accepts the same captured operation with a held-only owner; it may read and sync-confirm complete matching target bytes, but cannot write missing bytes, truncate, rename or delete. A separate readBootstrapState(invocation) backend capability performs bounded stage/header reads and the private no-repair journal inspection for cold inspection/reentry. Names may be split into cohesive private helpers, but these operation/inspection responsibilities and outcomes are fixed.

An issued partial stage/target can continue only with its exact original captured bytes, matching prefix, held owner and current issuing guard. It must not create a new operation, truncate/roll back to empty, or overwrite a differing suffix. This is original-operation continuation, distinct from passive reconciliation. Stop/source change allows passive confirmation of issued bytes but prevents continuation and later phase issuance. Before all issuance cancellation/staleness is not-issued; afterward it remains a blocked original operation. Close failure after confirmed fsync is diagnostic, not a lost commit. Directory sync keeps the existing best-effort Windows limitation; no universal power-loss promise.

Extend existing owned deletion inventory for only those exact stage/publish siblings, preserving confinement checks and tombstone semantics. Include the discovered files in the original deletion receipt so retry cleans the same inventory. This does not relax caller authorization or invent visibility for an unreadable target; if existing deletion cannot establish its required identity, return its explicit failure before mutation. Test partial staging cleanup where the target identity is available. Do not implement a general orphan cleanup or new parent-deletion policy.

Cost: a small retained original header artifact and bounded write duplication. If its required binding is missing/corrupt, qualified adoption may need original data or remain unavailable; ordinary full-session reading is distinct. Test actual short writes/sync/rename/lost-response/cold cuts and exact owned cleanup, not simulated success receipts.

## R-B-22 — truthful partial-header token

Replace the foundational token type with this closed union, preserving known-token shape:

```ts
type BootstrapResumeToken =
  | {version:1;invocation:BootstrapInvocation;phase:BootstrapPhase;manifestDigest:Digest}
  | {version:1;invocation:BootstrapInvocation;phase:'header';manifest:'unknown'};
```

No mixed forms, undefined digest, unknown-manifest later phases or invented hash. A matching invocation path with unreadable bytes gives inspection unavailable/needsConfirmation, never a known reserved digest. With no original payload, return blocked/payload-required. Complete validated stage/header can supply its actual digest but not missing semantic groups or initial text. Absent read-only inspection is only an observation, not an owned absence receipt. Later parent/team consumers must preserve this union.

Cost if wrong: invented recovery identity or an unrecoverable cut hidden as absence. Literal partial-stage/header and no-I/O inspection controls are required.

## R-B-23 — exact binding, noncircular hashes and logical intent

Keep B1 hashes and canonical convention unchanged. Share the initial-event hash helper through core-session/internal/bootstrap with the B1 reader and real B2 consumer; do not duplicate its algorithm or import private relative paths. Construct the actual admitted event deterministically (queue/user and subagent.initial provenance, actual parent when present), then validate/capture it; initial.parentSessionId must match lineage. Hash all supported fields except seq plus the original clocks as R-B-13 requires.

The exact H('ih.bootstrap.manifest.v1', value) preimage is:

```ts
{
  version:1, invocation,
  target:originalTarget, metadata:originalSelectedMetadata, lineage:originalLineage,
  headerBase:originalFinalHeaderWithoutSemanticSeed,
  seed:{digest,dependencyDigest,sourceObservation,records},
  // absent unless a real initial admission exists:
  initial:{inputId,digest:initialInputDigest,startedAt,expiresAt}
}
```

headerBase includes current format/journal, fixed ID/createdAt, final lineage, seedLength and preserved effective metadata. Stage stores these preimage components except records; committed target records supply them during ready adoption. The resume transport target is never hashed in place of originalTarget. No initial field is emitted for no-initial. Exclude semanticSeed/final manifest, final serialized header/header hash, stage path/hash, frame/receipt/closure hashes, owner incarnation and callbacks. Order is initial hash → seed → manifest → reservation/header → stage → deterministic frames/receipts. Compare owned values, not caller aliases. Validate supplied compiled data against actual records/source slot/digests before use.

requestDigest identifies genuine logical caller intent, independent of the changing selected source observation, resolved role defaults and credentials. Task2 validates closed invocation/equality and materialization, not a claimed originating task it cannot observe. Task4 must bind per-entry closed intent schemas to the actual caller and persist the original invocation/clocks. Changed task/selection/role/explicit override is a different intent; an unchanged original request can adopt ready storage after source/defaults change. Per-entry intent schema is deliberately not replaced with arbitrary generic JSON in Task2. The proposed top-level request hash includes version, caller-kind/closed intent, requested source/selection or anonymous content digest, original target choice, explicit metadata/lineage and initial identity/text/clocks. It must be finalized with actual caller ownership in Task4 before that consumer ships; it is not an implemented Task2 authority guarantee.

For new B2 invocations require operationId printable ASCII [!–~], length1..237. Thus both bootstrap:<operationId>:seed and bootstrap:<operationId>:complete fit the unchanged fact encoder's256-character bound. Existing B1 readers stay compatible with observed historical IDs; unsupported new invocation IDs refuse before file work. Target IDs retain existing backend confinement/owner identity rules, not raw interpolation into staging filenames.

Cost if wrong: hash cycles, incorrect same-intent adoption or callbacks changing issued bytes. Independent literal hashes, changed metadata/initial/records, callback/accessor negatives and maximum-length IDs qualify this contract.

## R-B-24 — private journal reading and historical frame confirmation

Factor physical frame/chain decoding within the existing core journal owner. The public reader still performs full public-ready validation. Expose the narrow bootstrap reader only through the existing internal/bootstrap bridge; it validates complete frames, growing-prefix history and torn extent without repair, and returns frame boundaries/keys. Use the same sole managed index; transient read validation is not another stored index. Ordinary readJournalPrefix must not truncate an unknown bootstrap operation as part of cold opening.

Add confirmBootstrapFrames(id, heldOwner, expectedFrames) in the existing backend journal owner. expectedFrames identify exact original phase bytes/keys and preceding prefixes. Verify them at their real chain positions, validate the complete later chain/history, then sync under current held ownership. Return truthful receipts for those exact frame prefix digests under the current document incarnation; no append, truncate, replayed observers or fresh action. Ordinary terminal-suffix reconcileOwnedBatch semantics remain unchanged. Later torn/unconfirmed suffix blocks writable adoption with unknown and unchanged bytes; do not silently run general repair through this operation. Existing qualified ordinary recovery can be performed separately.

Ready adoption validates retained original binding against immutable current birth/reservation fields, reconstructs the full manifest from actual original seed/initial records and stored original metadata, verifies deterministic original frames, and confirms receipts. Mutable current title/archive/model/workspace and later complete live suffix are preserved. Never confirm old full header bytes against a renamed current header. Missing original binding cannot be inferred from changed current metadata. Supplied original payload is useful only if it actually reconstructs ALL original binding; otherwise remain payload-required. A B1 literal fixture with arbitrary manifest strings is not qualified B2 storage evidence.

Recheck dependencies passively through their original request and reconcile port on ready adoption; require the confirmed closure to equal the stored completion closure before returning already-ready. This is storage reconciliation, not a grant replay or execution permit. An ordinary ready document's existing read/action policy remains owned by its original consumers. No initial input/generation is re-admitted or launched by bootstrap.

Cost if wrong: fabricated historical receipts, data loss from generic tail repair, or duplicate work. Test metadata edits, changed source, later suffix, missing binding, changed deterministic frame IDs and different process owner incarnations.

## R-B-25 — dependency and task boundaries

Task2 injects the real contract for Task3 without a shipping permissive grant implementation. For zero artifacts, dependencyClosureDigest is exactly EMPTY_SEMANTIC_DEPENDENCY_DIGEST and no dependency source lookup/port invocation is required. That is an empty-set identity, not access to any artifact. Nonempty artifacts require a genuine session source plus the captured host dependency port; anonymous refs without that authority refuse. Validate closed returned outcomes, check current guards around first issuance/confirm awaits and preserve the same manifest/request during reconcile. Nonempty closure semantics/transfer membership are implemented by Task3, and Task2 does not claim those owner operations are qualified.

compileSemanticSeed is a pure actual consumer of B1 data; no fake consumer solely to eliminate reachability rows. fork.ts and real spawn/team/SDK/Gateway/Desktop/standalone cutover remain Task4; the original semantic-fork RED stays disclosed. Internal constructors/helpers may change coherently for Task2 but no unrelated file decomposition or maintenance census. No model/provider/credential request is needed for any Task2 test.

Task2 acceptance requires meaningful RED/GREEN cases, actual JSONL physical cuts and final affected core/persistence/JSONL typechecks and suites, sequentially on a stable source. Fresh independent functional/quality review follows, with the same reviewer for fixes. Source timing, reused evidence, setup failures and any remaining gates must be explicit.

## R-B-26 — ordinary replacement preserves the actual birth frames

Independent Task2 review and unchanged-source probe found that replacing identical events succeeded but collapsed the two original bootstrap frames into one random frame; normal read/title update then failed. Preserve the actual immutable bootstrap frame bytes in qualified, retained-stage targets and replace only the allowed later suffix. Validate the entire candidate and require its birth prefix (seed, completion and optional initial admission) to be data-equivalent to the existing confirmed prefix before any publication. Keep the original raw header/journal metadata and exact original phase bytes/keys/prefix; encode any new suffix against that actual prefix. This uses the existing journal/JSONL rewrite owners, not a second event store or invented phase receipt.

No-op/same-events canonical replacement, changed ordinary suffix, subsequent normal read/title update and cold original receipt adoption must work. A changed/dropped birth record or unavailable/malformed original phase layout refuses before changing bytes. Preserve legacy and stage-free rewrite behavior. Do not recreate deterministic original frames from arbitrary semantically equivalent rewritten bytes and call those original receipts; R-B-24 still rejects foreign/unqualified whole-body rewrites. This resolves the public compatibility regression without weakening incomplete-state refusal or historical receipt identity.

Cost if wrong: legitimate recovery rewrites could corrupt readability or invalidate original-operation recovery. Maintained genuine-B2 controls must include nonempty seed, initial input, later suffix, cold adoption and byte-preserving refusal of birth changes. This is functional repair, not decomposition credit.

## R-B-27 — all retained header-transaction artifacts participate

Independent review/probe found an exact matching19-byte .publish-only file was ignored as absence, then a fresh reservation completed around it. Read-only inspection must include matching publication artifacts in its uncertainty decision; absence requires target, stage AND publication absent (with no foreign retained operation). A filename alone never supplies a manifest or original binding. Without verifiable binding, retain the original invocation as unavailable/needsConfirmation and a truthful header token; do not mint a digest or declare pristine absence.

Before issuing or continuing header work, validate every retained stage/publication/target artifact against the captured original operation. A publication file is not a valid phase of a new-target operation; refuse it unchanged. For existing-empty continuation, only exact matching original publication bytes/prefix may be continued under current guards and the unchanged original target qualification. Unverifiable or conflicting bytes remain blocked/refused; no ignore/delete/rollback/new random identity. Ready original-operation confirmation likewise cannot pretend a conflicting retained artifact was verified. Ordinary deletion still uses its existing explicit inventory policy.

Cost if wrong: stale/foreign retained work can be hidden as a new operation. Add publication-only known/unknown/foreign-byte cases with independent inventories and zero-write assertions. Separately, R-B-21's existing currentness requirement applies before EACH awaited short-write continuation; failure retains the original partial bytes and blocks, while held-only passive confirmation stays distinct.
