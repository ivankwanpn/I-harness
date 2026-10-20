# Original native catalog witness — root design decision

2026-10-21. Root reviewed the actual `native-dependency-observer.test.ts` and `observer-red-attempt2.log`: a genuine parent Agent spawns a direct durable child; the child launches native work on the inherited service; the parent discovers it while running and later makes a genuine prepared job_output. The closed parent catalog contains the original child frame, an actual target pin exists, current source identities agree, and the typed public reader rejects it as unauthorized. Attempt1 was unsupported outside-Agent fixture setup and is not the product RED.

Root chooses **option A** from the [design comparison](../../research/context-r4a-native-dependencies-preflight-20261021/design-options.md): immutable original pin-owned catalog membership plus an explicit `viaCatalog` read selector. This is within the user's approved redesign and deliberate structural repair, not a request for additional user permission.

## Contract and tradeoff

For a frame referenced by another session's genuine result catalog, the caller supplies both the complete frame ref and the exact enclosing catalog ref. Bare cross-owner frame refs without direct closed-fact visibility remain denied. Same-owner reads and directly visible refs retain the existing route.

This deliberately changes the success query for this cross-owner relationship. Preserve original RED evidence as the absence of a usable registered observer-read path; add a preimplementation RED for the new viaCatalog contract and retain bare-ref denial as a negative test. Do **not** report that the old bare query now succeeds. The tool/schema/docs must tell the caller how to carry the catalog ref returned in the original envelope. No arbitrary-reference auto-following UI is introduced.

The explicit selector makes member-witness lookup a constant number of bounded metadata reads regardless of catalog length or number of repeated observations. It is data, not a capability or permission. Current host fact projection, quota scanning and Merkle verification keep their own existing costs; do not claim the whole read is constant-time.

## Original semantic writer and publication

The only semantic author is the existing PreparedCall finalizer using the private `toolResultDependencies(exec)` handles. Freeze the exact validated ordered entries once when the catalog capture is constructed. Bind that set and original operation to a service-created dependency-catalog scope under the existing private scope owner; no structural scope or read payload can recreate it.

A focused composition leaf may expose host-only `registerResultDependencyScope(owner,current,entries)` and `settleResultDependencyMembership(scope,catalogRef)` alongside existing scope/confirmation methods. Equivalent focused names are acceptable if responsibility is identical. The scope's `current` remains the original prepared owner check. Do not import ToolExec into artifact storage or add a second global ACL journal.

Catalog body and membership must come from the **same frozen ordered entry set**, with ordinary unavailable entries preserved. A ready catalog must be the original capture's actual committed ref and original scope operation; compare its frozen program data with the intended catalog DTO as an integrity assertion before binding if useful. Do not parse arbitrary output for entries, accept reader-supplied membership, or rerun source lowering/encoder on retry. Trusted registration supplies semantic membership; the blob/reference, actual frame/catalog operations and original pins establish its persisted identity.

Every artifact member must be the exact committed native `exec-frames-v1` ref and already have the target's real pin. The catalog is `json-utf8-v1`, owned by the original observing document/session with its real catalog pin. The existing genuine origin→target grant happens first. This membership method cannot opportunistically grant an unpinned member to make validation succeed.

Publication order:

1. Settle primary, each actual registered source and its required target pin.
2. Settle the one original forced catalog capture.
3. Under the existing workspace mutation lock, validate originals and publish each immutable member witness, reserving physical metadata quota through the original quota owner.
4. Confirm all required witness records/pins before the finalizer caches a ready artifact-set or releases F1.

Preserve this separate post-catalog/pre-F1 settlement state on the same original scope. A lost acknowledgement or partial relation publication is recovery-required; retry only original same-owned publication with the same key/bytes. Cold read can validate existing records but cannot create a missing witness or reconstruct a live scope.

**Known relation quota refusal:** return truthful top-level `dependencies:{kind:"unavailable",reason:"quota",count:<actual count>}` with unchanged primary/program/execution facts. Retain original catalog/member pins until confirmed document deletion, including any already published witness. Do not return a usable artifact-set with missing members or pretend committed storage disappeared. Unknown I/O is not known refusal. This is a separate tested seam from catalog-body quota.

## Immutable pin-owned record

Use a focused leaf under the existing artifact/pin owner. Preserve existing `pins/<pinId>.json` and `access/<sessionHash>.json`. Put bounded companions at:

```text
<frame>/pin-memberships/<sha(targetDocumentId)>/<sha([catalog.id,catalog.revision])>.json
```

The record is subordinate to that actual frame pin, never an independent retention pin or workspace ACL. The unused scalar Pin.visibilityRef must not be used as “latest observation”; remove it if it has no real consumer after this change. Different catalogs get separate immutable keys. Repeating the same catalog is byte-identical idempotent publication; conflicting bytes at its key are refused/recovery/corrupt, not overwritten. Compare an existing keyed record before the general `atomicJson` helper: atomicJson alone permits replacing different destination bytes and is not an immutable-write primitive.

Closed record fields: version1, kind result-dependency, workspaceId, documentId, sessionId, exact memberRef, exact catalogRef, original catalogOperationId, original sourceId, nonnegative safe ordinal. Use existing identity/ref validators, exact allowed keys and an explicit **8,192-byte** metadata limit. Check every record path through the original rooted/non-link I/O guard. IDs come from validated host metadata, never raw filesystem paths in input.

The record's sourceId is the genuine native dependency identity (for example `process:<executionId>`), not `ArtifactOwner.source.sourceId`, which identifies the captured session/project source. The original registry supplies native sourceId/ordinal once; the existing frame operation cannot independently re-derive those fields. Validate their shape and exact original publication/retry values, without inventing another native-source authority. Current read source checks compare the frame's captured session/project identity. A “wrong source” negative means that current captured-source mismatch, not a claim that every self-consistent rewrite of local host metadata is cryptographically detected. These companions, like original pins, are host-published metadata.

Pin.operationId remains the original member operation, not the catalog operation. Record the latter separately. At read/publication validate exact pin document/session/revision/operation bindings and both original committed refs; stale codecs/completeness/digests/revisions cannot be accepted merely because id matches.

## Read/query/current policy

Add optional `viaCatalog?: ManagedArtifactRef` to original frame read queries, through raw internal frame reads and the typed public path. Public parser permits it only for native frame refs, with a closed valid JSON catalog ref; reject self-reference, non-native target, non-JSON witness, extra fields and malformed values before host resolution or body I/O. The lower original service methods also validate native-target/JSON-witness semantics; a trusted direct call must not rely solely on transport parsing. Retain original typed cursor versus offset rules and original response budgets. Legacy refId queries must reject viaCatalog rather than silently ignore it.

Within the existing mutation fence:

1. Verify the requested frame's original committed ref and actual caller session pin.
2. Check current target source/project/archive policy against the **frame's original captured source**.
3. Select exactly one companion from the actual target pin plus viaCatalog identity, validate closed record and full matching identities.
4. Verify the exact catalog operation is committed and its named original target document pin still exists. Require current **direct closed-fact visibility of that catalog**, including rewind filtering, even though the target owns the catalog. No same-owner shortcut may bypass this required catalog visibility; do not recursively authorize via another witness.
5. Read only the requested bounded frame page; repeat pin, witness and current-policy checks after the read.

The host callback may receive a host-only verified `visibleVia`/equivalent field containing the exact validated catalog ref. Both automatic result-store policy and Gateway native-context policy must retain frame-source equality and require direct current catalog visibility when that field is present. Do not substitute catalog owner/source for the frame owner/source. Without verified visibleVia, preserve existing direct rules. The field is never copied directly from a read query into the callback before storage validation. Use internal metadata/policy helpers under `mutate`; calling public read/grant methods that reacquire the same queue would deadlock.

Reads with missing/corrupt witness, missing frame/catalog pin, wrong member/source/revision, real unrelated JSON artifact, invisible catalog or revoked sibling caller deny. No full catalog body is read to establish membership. Catalog bodies and arbitrary same-name return fields remain data.

## RPC and actual callers

Update the `context_output_read` schema/description and runtime allow-list so the model can supply the enclosing original catalog ref; execute that real tool route in a control. Keep native cursor handling and legacy behavior intact.

Extend the existing result-read capability deliberately: hosts implementing witness reads advertise **session-result-read versions ["1","2"]**; ordinary ref-only reads still need1, viaCatalog requires2. The SDK server must not infer v2 merely because any custom readResultPage callback exists: use an explicit host opt-in (default false), enabled by the actual Gateway composition **and the genuine CLI SDK-server composition in `apps/cli/src/index.ts`**. The CLI also mounts the same actual `service.readResultPage`; keep its existing `packages/sdk/test/result-page-cli.test.ts` capability/control aligned. Reject a viaCatalog RPC before invoking a v1-only custom reader. SDK client and Desktop main preflight likewise require2 for viaCatalog. Keep ordinary legacy/v1 hosts working and test downgrade behavior. No Session-format or envelope-version change.

The shared ResultPageQuery should propagate through existing service/SDK/Gateway/Desktop transport, not duplicate schemas. Check actual server dispatch and copied-source build consumers when affected. A source/type/protocol test is not a packaged A6 claim. Desktop's existing generic catalog page does not auto-follow entries; no new product page is added.

## Multiple witnesses and lifecycle

C1 remains usable while a later C2 is pending, refused or rewound; C2 never replaces C1's record. If both are visible, either supplied witness works. If one is hidden by a real rewind, that witness denies and the other visible witness works. Hidden-by-current-facts history stays physically pinned. Do not invent event fields or grant from arbitrary payloads to simulate visibility.

Temporary source/project/archive denial preserves the original pins/companions; restore policy only through its actual owner. Read lifetimes stay monotonic. A page held across a concrete policy/rewind change that remains in force must deny on the post-read check. Existing Gateway rewind uses its actual fence; archive/delete/close may drain readers, so release a held reader before joining that draining management call. Two current checks alone do not prove detection of a revoke-and-restore cycle wholly between them; no new authority epoch or stronger ABA claim is introduced here.

After child source document deletion through the supported lower close/manifest/coordinator lifecycle, actual parent frame pin, parent catalog pin and parent membership remain usable. Check the target's current source against captured frame metadata without requiring a live deleted child profile. Hold a genuine deletion-observer lease through acknowledgement and inspect the physical set. This is not the rejected ordinary Gateway child delete route.

Confirmed target document deletion owns companion cleanup with its actual frame-pin release. Cleanup must be idempotent even if interrupted after deleting the pin file: retry cannot immediately return on missing pin and leave unbounded companions. Never remove another target's witnesses. Body lifetime remains determined only by real document pins; companions cannot retain an otherwise unpinned artifact. Use existing mutation/owned-path checks for recursive cleanup.

## Required repair controls

Keep actual source/read RED and new viaCatalog-contract RED before product changes, then verify genuine Agent→child native→parent job_output→real tool/typed reader succeeds with the exact original enclosing catalog. Negative bare/sibling/revoked/unrelated witness paths remain.

Test two genuine observations of the same frame, pending second publication preserving first, selective real rewind visibility, fresh owner read without producer reconstruction, source deletion with parent target pin, target deletion cleanup and retry after interrupted pin/companion deletion. Include actual partial membership acknowledgement uncertainty with no premature F1, same scope retry and no native/body replay; actual known relation quota refusal preserves primary facts/count. Exercise v1/v2 RPC and malformed-preflight boundaries.

The reviewer may recommend a more precise implementation mapping, but cannot silently weaken these semantics. Root owns any further architectural adjustment. This repair qualifies the existing live observer relationship only; semantic seed R4B, broader A5 and A6 remain open.

Independent [scoped design review and finding closure](../../research/context-r4a-native-dependencies-preflight-20261021/observer-design-review.md) is PASS. The one CLI mapping finding was corrected before product dispatch; this is design readiness, not product acceptance.
