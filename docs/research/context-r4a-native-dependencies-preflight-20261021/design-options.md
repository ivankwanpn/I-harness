# Confirmed native observer visibility gap — design options

Design advice for root, 2026-10-21. Read-only source inspection plus the writer/root-reported real-entry RED; no product/test edits, suites, Git or runtime processes were run by this reviewer. Only this requested design note was written. Using the brainstorming skill for the architectural comparison; root owns the implementation choice and further design approval within the authorized redesign.

## Decision in brief

Recommend **an immutable per-catalog membership witness owned by the existing artifact pin/publication lifecycle, selected explicitly on a cross-owner frame read**. The witness records what the genuine catalog finalizer registered; the read request merely selects it. Both the frame pin and current visibility of the exact catalog remain mandatory. Store one bounded immutable record per `(target document, original frame revision, original catalog revision)`, never one mutable latest `visibilityRef` and never an unbounded witness array in `Pin`.

This recommendation deliberately extends the read query with `viaCatalog`. It makes lookup independent of the number of observations/catalog entries and preserves every older visible observation. It does **not** make the currently failing bare `{ref: frame}` query succeed by itself. Root must explicitly accept that caller contract and update the real-entry control to read the frame using its actual returned catalog witness, while retaining bare-ref denial as a negative boundary. If bare frame-only cross-owner reads must remain the success contract, choose option B below and accept its explicit witness-search/index responsibility instead. Do not silently modify the RED assertion and report the original bare-ref behavior as fixed.

The accepted DEP contract promises a usable registered result through original authority; it does not currently define a query witness field. This is an architectural choice for root, not an inference that the field is already approved. Neither option requires an R4B seed or grants from arbitrary body JSON.

## Established owner boundary

The inspected real test `packages/session-executor/test/native-dependency-observer.test.ts` follows an actual parent Agent spawn, genuine direct durable child, shared original `ExecService`, running prepared `job_list`, original completion and later parent prepared `job_output`. The catalog equals the original dependency, the frame operation remains child-owned, the parent frame pin exists and source IDs match. Root/writer report that the accepted typed reader returns unauthorized. This note does not re-execute the RED.

The source explains that result: `exec-result-retention.ts` grants the frame from the genuine origin; artifact `authorized()` requires a target pin plus `authorizeResult`; `lifecycle/result-store.ts:77–86` permits a cross-owner ref only when current closed facts directly expose that exact ref. `managedResultRefs()` exposes the primary and dependency-catalog refs, not entries. Gateway `context-runtime.ts:38–42` applies the equivalent visibility rule. The repair must connect the original registered member to a **currently visible original catalog**, while preserving the existing source and pin checks.

`pins.ts` currently overwrites one pin file per document and has an unused scalar `visibilityRef`. Repeated `grant()` republishes the same target document pin. Attaching an authoritative latest catalog to that scalar would lose older witnesses, including when the new catalog never reaches F1 or is hidden by rewind. Copying that scalar through every pin rewrite would still not represent two simultaneously relevant witnesses.

## Options and tradeoffs

| Option | Authority and lookup | Multiple observations | Cost / scope | Assessment |
| --- | --- | --- | --- | --- |
| A. Pin-owned immutable membership records + explicit `viaCatalog` query | Existing frame and catalog pins; current source; current closed catalog fact; one exact membership record | Each catalog has its own record; caller selects any visible original witness | Constant count of bounded metadata lookups for membership; current host fact visibility retains its existing cost. Extends read DTO/parser/callers | Recommended when a deliberate explicit witness API is acceptable |
| B. Same immutable membership records + transparent frame-only witness resolution | Same authority, but store/host must search or index the intersection of registered witnesses and currently visible catalogs | Must test all relevant alternatives or use a complete derived index; latest-only fails | Preserves current bare read query. Requires an explicit candidate-search/index and invalidation design; worst cold cost scales with witnesses/current facts unless more structure is built | Coherent if bare-frame success is a required interface; larger responsibility |
| C. Put member references in closed result facts / new fact projection | Original document facts explicitly expose all members, then current projection authorizes them | Current fact/rewind projection determines active witnesses | Either unbounded F1 metadata, multiple new facts plus grouping/indexing, or a new durable relation under document ownership; touches closed event validators/readers/format contract | Not the minimal unit. Consider only as a separate root-owned closed-fact design |

Merely parsing every catalog on each frame page is not an option. Merely treating an actual target pin as permission is also not an option: rewind/current policy currently limit cross-owner visibility, and pins deliberately protect hidden/archived history without making it readable.

## Recommended A: concrete schema and ownership

Keep the existing `Pin`/`Access` records as the retention and access owners. Add a focused pin-membership leaf inside the original artifact owner. A concrete layout can preserve existing `pins/<pinId>.json` and `access/<sessionHash>.json` unchanged, with bounded companion records at:

```text
<frame-directory>/pin-memberships/<pinId>/<catalogKey>.json
pinId     = sha(targetDocumentId)
catalogKey = sha(canonical [catalog.id, catalog.revision])
```

This directory is subordinate metadata of that exact original pin, not a new workspace ACL registry. Every membership read must re-read/validate the live original pin; a companion record alone never grants access or keeps the body alive. Pin release owns its cleanup. Use rooted checked paths, closed schemas and bounded metadata reads exactly as other artifact metadata does. Do not insert subdirectories into the current `pins/` listing without changing its strict file parser; a companion directory avoids accidentally making `releaseDocumentPin()` treat a legitimate directory as corruption.

Proposed record, field names illustrative but identities normative:

```ts
interface PinCatalogMembership {
  version: 1
  kind: 'result-dependency'
  workspaceId: string
  documentId: string             // target catalog's original document
  sessionId: string              // actual observing target session
  memberRef: ManagedArtifactRef  // exact committed original frame ref
  catalogRef: ManagedArtifactRef // exact committed original catalog ref
  catalogOperationId: string
  sourceId: string               // actual native sourceId from registry
  ordinal: number                // original ordered catalog entry
}
```

Both full refs are small closed DTOs; set an explicit metadata budget (for example4096bytes) and validate every field. Require native member codec and JSON catalog codec, safe ordinal, valid sourceId and exact original committed identities. The key is immutable: an existing different record is a conflict/recovery condition, never overwritten as a newer observation. Different catalogs get different keys. Same catalog retry writes the same bytes through the original atomic metadata mechanism.

Do not reuse `Pin.operationId` as the catalog identity: it currently identifies the original member artifact operation, including target grants. Do not set or consult the unused scalar `visibilityRef` for this mechanism.

### Trusted membership input and API

`session-executor/lifecycle/result-dependencies.ts` is the only semantic author: its `entries` are constructed from the actual private `toolResultDependencies(prepared.exec)` handles and their validated settlements. Capture that exact ordered frozen entry set once, at the same point used to create the canonical catalog body. Pass it through the **original catalog capture scope**, not through a read query, user output object or catalog parser.

A narrow trusted-composition API can be expressed as:

```ts
registerResultDependencyScope(owner, current, entries): ResultArtifactScope
settleResultDependencyMembership(scope, catalogRef): Promise<
  | { kind: 'ready' }
  | { kind: 'refused'; reason: 'quota' | 'storage-refused' | 'capture-canceled' }
  | { kind: 'recovery-required' }
>
```

These are proposed names, not existing exports. They belong beside `registerResultScope`/`confirmResultOwner`, not in a model tool or generic read transport. The scope is service-created and held in its private scope WeakMap; `current` must remain the original `assertResultPrepared(prepared)` owner check. The scope stores a snapshot of the trusted registered entries, the one original catalog operation and its same-operation publication progress. It cannot be reopened from cold JSON or a structurally similar scope object.

Use a focused catalog scope/publication wrapper in `result-retention.ts` so `withResultDependencies` can supply its exact entries and later settle membership without giving core-tools an import of context-output. Do not add authority-like fields to `ResultDependency`, the envelope, programValue or the returned primary metadata. Do not let a reader supply `entries` to the writer API. The trusted composition boundary is the existing original PreparedCall -> result capture binding; the store should not import ToolExec/admission/execution authority to recreate that authentication.

Independently validate at publication that the exact catalog operation belongs to this scope; each artifact member exists at its exact committed ref; the target already holds the actual original member pin; and the target holds the catalog's original document pin. These are integrity/precondition checks, not a replacement source of semantic registration. For an origin!=target member, the existing genuine `dependencyFor` grant must have succeeded first. No membership API may grant an otherwise unpinned member opportunistically to make these checks pass.

### Publication and unknown recovery

1. Settle primary and all original native registrations. Existing cross-owner frame grants/pins settle before proceeding. Preserve unavailable entries in order; only actual artifact members need membership records.
2. Build/freeze the one canonical catalog entry set and original scope. Stream/commit the same catalog artifact with its original pin, preserving the current force-artifact behavior and completeness.
3. Publish each registered artifact member's immutable pin-membership record under the existing artifact mutation lock. Reserve real quota for metadata writes and partial/pending atomic records. Do not hold the lock while re-entering another public method that acquires it.
4. Confirm every required record and original pin on that same scope. Only then cache/return the final artifact-set descriptor and allow the existing F1 result path to proceed.

This requires a distinct membership-settlement phase after `catalog.settle()` is ready and before `withResultDependencies` caches its final `result`. Repeated attempts reuse the already captured catalog, original members, scope, operation and per-record identity. There is no command/body replay or second catalog serialization.

An acknowledgement lost after one relation write is **recovery-required** until same-owned verification/retry confirms all original records. Earlier partial relations cannot authorize an uncommitted catalog fact. A physically committed catalog with incomplete membership is not a usable artifact-set and must not be exposed at F1. A cold read may validate already published records but cannot create missing records, recreate the live scope or finish the lost set publication. Original source uncertainty remains conservative; these records are not a reason to release any original pin.

Known membership quota refusal needs an explicit root ruling before implementation: the coherent narrow behavior is a top-level unavailable dependency descriptor with the actual positive count and truthful primary/program facts, even if a catalog artifact was already committed. Preserve already committed/pending original document pins until confirmed deletion; do not pretend the catalog never existed or return a usable artifact-set with missing membership. This is a new composition refusal seam and must be tested separately from catalog-body refusal. Unknown I/O is never mapped to that known refusal. If root prefers reservation before catalog commit to reduce this case, it must use the real quota owner and same-operation reservations, not estimates or a bypass of physical accounting.

### Read API and policy

Extend both raw/typed read query forms with optional `viaCatalog?: ManagedArtifactRef` (and the narrow service query types needed to pass it). It must be a valid closed `json-utf8-v1` ref. Keep native `cursor` versus raw `offset` parsing rules unchanged. The SDK reexports the query type; inspect its dispatch/parser and Gateway entry as actual consumers. This optional DTO extension requires root acceptance and explicit transport compatibility qualification; Session events/envelopes and semantic seed format do not change merely to carry it.

For a witness-assisted read under the existing workspace mutation fence:

1. Validate the requested frame's original committed ref and actual target session pin as today.
2. Check the current target session/source/project policy against the **frame's captured source** as today. Revocation/archive/missing project scope still deny.
3. Derive the one member-pin/catalog key from the supplied exact witness. Read and validate its immutable membership record. Require all frame/catalog/target/operation identities to match; require the actual target document pin named by the record, not merely any unrelated pin for that session.
4. Validate that exact catalog operation is committed and the target holds its real catalog pin. Ask the existing host policy whether that **catalog ref** is currently directly visible. In automatic composition this uses the closed-fact/rewind check; Gateway uses its existing visibleRefsFor result. Never authorize the catalog recursively through another witness. The source-policy check remains in force for the frame as well as the catalog.
5. Read the bounded requested frame page; recheck original pin/current-policy/witness conditions after the read, preserving the current before/after authorization pattern. A rewind or revocation that happens across an await cannot leak the completed page.

The request's witness is a selector, not authority: a fabricated catalog ref, a real catalog containing a copied ref in arbitrary JSON, a missing original membership, an invisible catalog, or a missing frame pin all deny. The store never reads the whole catalog body for this decision. Membership lookup uses a constant number of bounded metadata reads per page; this does **not** claim constant cost for the host's existing session fact projection, physical quota scanning or page Merkle proof.

Concretely, the existing `authorizeResult` callback currently combines source and direct-ref visibility, so it needs a narrow original-owner extension rather than a permissive replacement. One suitable callback metadata member is `visibleVia?: ManagedArtifactRef`, supplied **only by artifact ownership after validating the original membership/pins**, never forwarded directly from the query. Preserve `owner` and `ref` as the actual frame; automatic/Gateway policies keep their current frame-source comparison, then apply their closed-fact visibility check to `visibleVia ?? ref`. Separately authorize the catalog directly with no `visibleVia`, so nested/chained witnesses cannot bootstrap visibility. Existing callbacks that ignore the optional field remain conservatively denied. Do not replace frame metadata with catalog metadata and thereby skip the frame's current source check; do not pass this host-only field through tool output or the public read DTO.

Same-owner reads keep their original direct source/pin policy and need no witness. A directly visible frame ref can keep its existing successful route. A cross-owner frame that has only a catalog relationship uses `viaCatalog`. Once it succeeds, a second call should not silently cache lasting permission that survives subsequent current-policy changes.

### Multiple witnesses and lifecycle

- C1 visible, C2 observed but not yet at F1: C1's immutable membership and current fact still authorize reads with C1. C2 is not visible and cannot authorize even if some records/pins exist. Neither write replaces C1.
- C1 and C2 visible: either exact witness works. Rewinding away C2 leaves C1 usable; hiding both denies. Rewinding C1 while C2 remains visible permits C2. No latest-record heuristic is involved.
- Source child deletion after successful target publication: release only child document pins. The actual target frame pin plus target catalog pin/membership survive. Read checks target's current source against the frame's captured source, without requiring a live origin-child profile. If policy instead needs an origin profile at this point, that is a separate integration defect; do not synthesize an origin registration.
- Target/source project revocation or archive: deny through the current target source policy, but preserve original pins and membership bytes. Restoring confirmed policy can make the same original witness usable again if its fact remains visible.
- Confirmed target document deletion: remove that document's memberships with its original frame pins under the pin-release owner. Do not remove another target's records/pins. Last-pin deletion can remove the full artifact directory. Companion metadata must never count as an independent body-retention pin.
- Missing witness record after a committed F1: deny truthfully; cold reads do not reconstruct it from body JSON. Missing/corrupt target/catalog pin or stale revision also denies. Record corruption is not current-policy denial; retain distinct diagnostic evidence even if the outer DTO coalesces failures.

Deletion interrupted between pin removal and companion cleanup must remain resumable with the original document identity even when `releaseDocumentPin()` subsequently finds no pin file. Specify cleanup ordering/retry now; do not return early on missing pin and orphan unbounded metadata forever. A safe direction is idempotent per-document companion cleanup under the same release operation, independent of whether its pin file still exists, with artifact removal still governed solely by remaining real pins.

## If root chooses B: preserve frame-only reads explicitly

Reuse exactly the trusted immutable publication records above. Replace the query selector with a **complete current visibility intersection** under the original store/policy owners. Two simple correct baselines are: iterate that pin's witness records and point-check their catalog visibility; or derive current directly visible catalogs from the host's closed facts and point-probe the corresponding membership files. Both are metadata joins, not catalog body scans. Both scale with observation history/current facts, and neither becomes constant-work merely because every individual file is bounded.

A scalar hint or a cache may accelerate the common case, but must fall back completely when the hint is invisible; it cannot cap search and deny while an older visible witness exists. To eliminate repeated per-page scans, root must define a derived visibility/membership index/cache keyed by the exact current closed-fact view (including rewind), current policy generation, actual pin identity and membership publication generation. Cold rebuilding may scan trusted membership metadata and closed facts, never arbitrary catalog bodies or ToolExec reconstruction. Revocation/deletion must still be checked on every page. Such an index is an acceleration of the original facts/pins, not a second durable ACL owner; writing a new independent permission database would violate this constraint.

B preserves the initial bare-query RED as its exact GREEN target but is a larger structural choice. Its truthful handback must disclose worst cold/uncached work and qualify repeat/uncommitted/rewound witness cases. If constant membership I/O for every cold bare-ref page is a hard requirement, root must design more indexing or adopt A's explicit witness; latest-only and arbitrary witness-count truncation cannot satisfy all three requirements.

## Discriminating controls for either choice

Keep the genuine current observer route as the product RED. In addition to its eventual GREEN, require these independent controls at original entry/owner seams:

1. Two later genuine observations of the same native source produce distinct catalogs; exact original frame identity/native launch count remain one. An unfinished second catalog cannot invalidate C1. Selectively rewind C1/C2 and test every active/inactive combination.
2. False payload `dependencies/ref/entries` and a real unrelated JSON artifact cannot establish membership. Authentic foreign/other-source/member-revision combinations deny even when refs are structurally valid.
3. A catalog without a target frame pin, a frame pin without trusted membership, an unpublished catalog, a missing membership record and sibling/revoked reader each deny through the correct boundary. A current-policy denial remains separate from original cold committed classification.
4. Relation publication cut after one actual member record: no premature F1; original same-owned recovery completes the same catalog/member set. Known relation quota and unknown publication are separate. All negative setup cuts retain real operation IDs and delegate original I/O.
5. Retire original assembly/store/coordinator; acquire genuine distinct fresh readers. Read all typed pages using the chosen API, with no producer/capture recreated. Delete the child through the supported lower lifecycle while retaining the parent's real frame/catalog pins and an actual deletion observer lease; prove exact bytes remain usable. Then delete the target and show last-pin/member cleanup without leaking companion metadata.
6. A page read held across current policy/rewind change must recheck and deny before returning its page. Raw-byte/hash oracles remain separate from typed caller-facing page success.

These controls qualify this live registered-result relationship only. They do not establish semantic fork seed/bootstrap, inherited R4B grants, delivery/claim R4C, global A5 completion or A6 scale. Root should choose A versus B and settle the known membership-publication refusal behavior before authorizing the product writer to implement the relation.
