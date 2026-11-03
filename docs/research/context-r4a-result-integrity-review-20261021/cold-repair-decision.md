# Root engineering checkpoint — cold receipt and pin identity

2026-10-21. Root read the complete `cold-lookup-integrity.test.ts`, original lookup/recovery/writer callers, actual `01-cold-red.receipt.json`, static case names and raw junction/two-observation receipts in `.tmp/r4ai-1021-01/`. The first controlled run has one authentic-phase positive and three failing negative tests. Sixteen static inconsistencies return committed; a preexisting fixture junction opens the operation twice and returns committed; replacing the file after the first actual read returns B's ref for A's checked operation/id. These are reproduced original host-owner violations, not merely source hypotheses.

Root also read the pin identity test, `05-corruption-red.receipt.json` and raw `pin-operationId` outcome. With only the actual pin operationId changed to foreign, the original read returns `real original pinned bytes` and opens both index and body (two content-file opens total). Other tested pin/access/malformed/missing cases deny. This is a second reproduced original-owner binding gap; no cross-session exploit is inferred from this same-owner corruption control.

## Approved repairs

1. Preserve the public host `reconcileResult(operationId,id)` interface. Pass the original root/workspace/expected identities into a focused cold recovery/validation leaf. Guard the original metadata path, read one bounded operation snapshot, validate its original identity/namespace hash, supported version/phase/codec and safe counts, and choose the disposition from that validated observation. Never check observation A then return independent unchecked B.
2. Committed receipts require exact closed ref identity/count/codec and valid embedded plus rooted bounded on-disk canonical manifest identities with safe dimensions. No body/index scan or new pin/current-caller ACL/F1 authority is introduced. Equivalent JSON whitespace/escaping can preserve decoded canonical identity.
3. Preserve authentic capturing/staged recovery-required and cleaned refused behavior. Capturing need not already have manifest/ref; refused can retain fields from an earlier staged state after lifetime-deletion refusal, so do not invent a requirement that every refused record omit ref/manifest. Validate optional owner/source data according to the actual writer contract rather than an arbitrary narrower format.
4. The replacement control may return the original checked A snapshot or refuse; it must never return unchecked B. This is not a new guarantee of an atomic multi-file snapshot against arbitrary filesystem mutation or cryptographic resistance to rewriting all trusted metadata.
5. Original read authorization must require the real pin's operationId to equal the actual operation owner's operationId before content I/O, retaining existing before/after policy checks.

The cold helper is used only by host lookup; live sink reconciliation follows retained writer.commit/createArtifactPublication. Keep those ownership paths distinct. Do not impose the new cold disk-manifest requirement on all witness authorization or unrelated readers without a separate controlled finding. No new journal, duplicate store/ACL, cold producer reconstruction or execution replay.

Root authorizes the sole writer to implement these corrections now, keeping exact RED evidence and proving GREEN plus affected regressions/types. This is within the approved redesign; no additional user permission is needed. Correct the reader's misleading one-chunk comment against the actual calibrated two-chunk boundary proof.

## Independent controls and oracle corrections

The writer reports four independent literal vectors and calibrated actual I/O passing before product edits. They remain qualification of existing format/proof behavior, not manufactured product RED. The initial one-argument generator invocation failure is preserved as setup.

The codec gate's safe offset beyond EOF returns existing bounded public `budget`, because the old error text contains both range and budget and the mapper prioritizes budget. Correct that test oracle to the actual approved behavior, preserve its failure, and do not change public reason semantics merely to manufacture RED.

All repairs need fresh final review. This checkpoint does not accept the unit, all original A6, scale/packaging, or unrelated ContextEngine work.
