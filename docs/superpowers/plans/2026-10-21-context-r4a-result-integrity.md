# R4A — Bounded result integrity and cold lookup

Approved bounded execution plan, 2026-10-21. Native-catalog/witness acceptance and exact-source rebase are complete at aa2cadaef61bbf6060de8c95b3782cec30628426. The [source map](../../research/context-r4a-result-integrity-preflight-20261021/source-map.md), [independent preflight/re-review](../../research/context-r4a-result-integrity-preflight-20261021/review.md), and [accepted-source rebase](../../research/context-r4a-result-integrity-preflight-20261021/accepted-source-rebase.md) are preserved. All four preflight findings were incorporated before promotion; this is readiness, not behavior qualification. Root pins clean BASE in the brief and dispatches one fresh writer.

Part of the approved R4A storage qualification sequence: original A5 owns durable pins; original **A6 owns bounded integrity**, to which this unit's range/proof evidence must be mapped. This does not close A6 scale/packaged qualification or mixed retention/TTL/quota lifecycle. One GPT6.1Sol writer and fresh GPT6.1Sol final reviewer, no recursive agents. Version0.1.13-rc.1, Session10 and unrelated decomposition27/43 unchanged. No publishing, live provider, real user profile or installed application.

## Goal and authority separation

An immutable retained result must return a bounded verified page or a truthful failure when its actual stored metadata/index/body is missing, corrupt or points outside its original owner. Trusted cold lookup must not return a false commitment from unrelated metadata. Neither path can recreate a producer, grant, F1 result, task success or missing catalog witness.

Keep these distinct:

- `reconcileResult(operationId,id)` is a trusted host storage lookup, not a model/SDK method or ACL proof. Capturing/staged state remains recovery-required without restarting its old encoder.
- Actual page reads need original pins, current source/fact policy, exact immutable reference and touched-range integrity. A lookup ref does not establish page permission.
- A successful range page proves the requested chunks/proofs, not a full body digest on every request. Untouched corrupt content can remain undiscovered until requested.
- Session/F1 durable publication remains original document-owned state. Storage metadata cannot fabricate it.

Use original artifact ownership/io/recovery/manifest/index/readers and accepted tool/SDK/Gateway dispatch, not a parallel validator/storage service. Fresh fixtures use real original writers then completely retire them before new readers. Only disposable task-owned fixture files may be corrupted or replaced; verify resolved Windows containment before moves/removals. Never inspect user data for link targets.

## Source hypothesis and original-owner repair checkpoint

Current cold lookup reads bounded operation JSON without an `ownedPath` guard, and its committed recovery branch returns serialized ref without explicit ref/manifest validation. This is a source hypothesis until a genuine original host-lookup control reproduces a violation.

Build positive committed/capturing/staged/refused cases and negatives for wrong operationId, missing/invalid owner/ref, inconsistent operation/directory/ref identity, oversized/truncated metadata and a fixture-only link/junction to a sibling outside the managed root. Observe whether foreign metadata was opened. Use positively calibrated real native I/O observation; an unconnected spy reporting zero is not evidence.

Current lookup observes operation.json twice: ownership checks the first read's operationId, then recovery independently reads the record supplying the disposition. Add one calibrated fixture replacement between those actual reads, identifying each observation, and prove any returned commitment belongs to the original checked operation/ref/directory. Record the actual outcome before repair; this is still a source hypothesis. A repair must bind the returned receipt to the validated observation rather than validating one record and returning another. A single validated snapshot or validation of the actual returned observation can suffice; no new journal is presumed.

Root's phase contract for the controlled oracle:

| Authentic stored state | Honest cold lookup boundary |
| --- | --- |
| Capturing | May lack ref/manifest; bounded valid original identity yields recovery-required, with no new encoder/scope |
| Staged | Original metadata remains recovery-required; a candidate ref/manifest alone is not commitment |
| Refused | Valid original refusal can have no body/index/manifest after cleanup; preserve its recorded reason/observed count |
| Committed | Require exact original operation/directory/ref identity and valid embedded **and on-disk** canonical manifest identity; absent/inconsistent committed metadata refuses rather than returning an apparently usable commitment |

This committed metadata check does not verify all body/index bytes, grant read access or certify F1. Missing/corrupt metadata may throw a bounded host error; do not relabel it as successful commitment, automatically repair it or manufacture known execution failure. The writer reports actual before behavior and proposed error disposition to root before a change.

Before a product change, report the exact controlled failure, expected host contract and minimal original record/path owner correction to root. Do not add arbitrary caller ACL to a host-only method, turn unknown cold storage into success, or require a manifest in benign capturing state before it exists. Prefer bounded closed identity/phase validation and existing rooted checks. Semantic schema changes or a new authoritative journal require a separate root design; none is presumed necessary.

## Independent positive vectors

Construct expected data in test-only code using Node crypto and literal buffers, without importing product leafHash/buildIndex/manifestBytes/artifactRef/serializer to produce expected values:

```
leaf    = SHA256(00 || u64be(ordinal) || u64be(length) || literal bytes)
padding = SHA256(02 || u64be(ordinal))
branch  = SHA256(01 || left || right)
```

Independently construct the 64-byte IHARTIDX header, one-based heap nodes and exact ordered manifest bytes. Pin complete body digest, tree root, index-file digest and manifest-derived revision before invoking the product writer. Root/reviewer must check expected constants against independent literal construction, not merely compare product output to itself.

| Body | Required shape |
| --- | --- |
| Empty | One real empty leaf; one node; 96-byte index. Retain existing pinned empty vector regression |
| 65,536 bytes | One nonempty real leaf; 96-byte index |
| 65,537 bytes | Two real leaves, final length1; three nodes; 160-byte index |
| 131,073 bytes | Three real leaves plus domain02 padding ordinal3; seven nodes; 288-byte index |

Use deterministic distinguishable bytes per chunk so swapped chunks/ordinals/branch order cannot pass. Read actual complete pages for positive vectors, but do not claim A6 large-data coverage from these small controls.

## Discriminating corruption controls

Select controls that reach the intended owner; don't forge a public ref that rejects before a manifest/codec test and claim the deeper validation was exercised.

1. **Operation/pin/access:** malformed/oversize operation and pin documents; wrong actual pin document/session/revision/operation identity; absent/stale grant; source/project/archive denial. Distinguish invalid query, missing storage, metadata disagreement and policy refusal. Session/pin metadata is host-published truth; do not promise cryptographic detection of an attacker rewriting every trusted local record consistently.
2. **Manifest:** exact original vector succeeds; mutate version/codec/completeness/count/treeRoot, decoded field type/value/order, extra or renamed key, or omit/truncate/oversize/link the real manifest while keeping the caller's true original ref. Require the actual original manifest owner to reject before body read where sequencing permits. Equivalent JSON whitespace/string escaping can preserve canonical decoded identity and is not an assumed corruption RED. Exact writer-output bytes remain the independent positive oracle; do not impose a new byte-canonical JSON policy.
3. **Index/proof/body:** corrupt header dimensions/reserved bytes/root, touched leaf/sibling, body byte, or swap equal-size chunks; truncate body/index; fixture-only path identity replacement. A requested bad range refuses. A valid range over an untouched corrupted chunk may still succeed. Real short native reads must be joined; zero-progress before expected EOF is failure.
4. **Codec after valid proof:** commit deliberately malformed UTF-8 or exec-framing bytes through an authentic low-level fixture sink so Merkle verification itself succeeds. Then test original decoder behavior. Invalid body bytes with stale hashes only exercise integrity rejection and are not a decoder oracle. Valid UTF-8 that is incomplete/invalid JSON syntax is not automatically rejected by a text range reader; it does not parse a full JSON document per page. Require malformed UTF-8 to refuse without replacement characters (current public reason unavailable); malformed verified exec framing refuses as corrupt. Header literal is `IHEXEC01` followed by actual LF (9 bytes total), not backslash+n.
5. **Ranges/cursors:** original max32768 serialized response budget, valid multibyte boundaries/EOF, tiny budget, negative/fractional/unsafe offsets, malformed/out-of-bound native cursor, canonical base64 and bounded record grammar. Preserve public native typed cursor versus raw internal offset distinction. Name each entry: the model tool deliberately clamps integer maxBytes above32768 and adapts native compatibility offset; typed parser/RPC reject those invalid typed forms. Do not force identical outcomes across these separate contracts.
6. **Read-time identity change:** hold actual I/O and replace a disposable same-length body/index or change current policy, then require original post-read validation to discard the page. A race may legitimately read touched bytes before refusal; don't apply zero-I/O assertions to a post-I/O revocation case.

Held-read schedule: start read, reach a positively calibrated native hold, initiate the actual revocation/fence action, observe its real admission/blocked state, release I/O in guaranteed finally, then join both operations. Store mutations queue behind the read's `mutate`; Gateway archive/delete/close may drain it, so never await them before releasing the reader. A non-draining actual policy owner is a separate seam; raw coordinator metadata probes do not certify the whole Gateway path. Raw fixture filesystem replacement is deliberately outside the store queue and must be accounted. Require denial for a change still in effect afterward, not detection of an entire revoke-and-restore cycle between checks.

The active catalog-witness unit already owns positive memberships, repeated observations, uncertainty/refusal and lifecycle. Rebase and reuse its accepted controls; do not repeat them all here. Add only discriminating integrity cases for the companion's 8KiB closed schema, exact key/ref/pin/operation mismatch, missing/linked/corrupt file and post-read change. Absence is not cold reconstruction. Native registry sourceId/ordinal and captured session/project source are different facts; no invented independently re-derived native-source binding.

## Actual read bounds and no repair

Instrument real FileHandle read lengths/offsets and original file opens; report ownership metadata separately from proof/body I/O. Calibrate the observer with a genuine positive page.

For the actual verification interval `min(remaining,maxBytes+3)`, at most its intersecting65,536-byte chunks are verified; a boundary page can legitimately touch **two** chunks even if returned text later shrinks to its JSON budget. For nonempty data with k touched chunks and depth d, current proof reads are64-byte header +32-byte root +k*(32-byte leaf +d*32-byte siblings). Empty data still performs a successful cold page read and verifies its real empty leaf:96-byte index storage, but128 actual bytes read because root/leaf is read twice. Do not deduplicate repeated offsets in the I/O oracle. Native frame reads may additionally verify header/record boundary and one bounded record; measure them honestly instead of imposing the raw-page single-request bound. Distinguish requested versus successful read lengths and actual retries.

Explicit preexisting foreign permission/path denial must not open result body/index. Public malformed input must fail before host invocation where the original parser promises that boundary. Do not expose raw filesystem paths or content in a public failure.

Compare complete relevant session/F1 and artifact authority inventories before/after reads and lookup, accounting for deliberate fixture mutations separately. No read-side capture, new pin/grant, provider/tool/guest/hook invocation, automatic reindex, task wake or repair is allowed. Owned session recovery is separate and should not be called just to make the read pass.

Representative corruption and denied-I/O controls must traverse actual model tool or SDK/Gateway entry with original real storage/policy, not merely a helper stub. Respect caller capability v1/v2 and actual conversation/source restrictions from the accepted witness design. Unit host-port probes are distinctly labeled.

## Verification and handback

Before any runtime import/subprocess, set shell IH_CONFIG_DIR plus actual per-fixture settings under a fresh task-owned directory. Keep source manifests before/after final verification groups, native exit receipts, all initial failed/setup cases, independent literal constants, selected I/O counters and process cleanup. No competing suites or test-source edits during a running final gate. Original failure receipts are immutable.

Use a fresh **short** task-owned evidence root and set IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT too when running accepted native/CLI regressions. Their old roots are sealed and reject writes; old writer runners are audit artifacts. New fixtures must allow a fresh-root override and protect their own final seal so future reruns cannot append to accepted evidence. Enumerate relevant tracked/untracked source **including hidden fixtures**; distinguish later scope expansion from source changes. No raw Git-export/EOL claim should replace actual workspace-byte manifests.

Run focused controls and affected actual storage/read/lifecycle tests plus explicit helper types. Broaden only for changed owner paths or a concrete regression. No full repository/release build claim, no A6 packaging. Keep large helpers separate from product owners; no production test-only exports or hidden test exemptions.

Implement only reproduced original-owner defects after root's checkpoint, retain RED/GREEN and no-replay evidence, commit coherent local changes and freeze for a fresh reviewer plus root evidence audit. Acceptance is bounded integrity/cold-lookup, not all R4A or all protocol/context redesign.
