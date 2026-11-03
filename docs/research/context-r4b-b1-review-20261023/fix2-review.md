# Independent B1 fix round 2 re-review

**Scoped verdict: PASS. F2 and F4 are ADDRESSED. No actionable new breakage was found in this fix range.** F1/F3/F5/F6/F7 retain their prior addressed dispositions; all seven independent findings are now closed for B1 staging. Final acceptance remains root's decision. This is not B2, native, connected-volume or whole-B acceptance.

Reviewed range: `163e0f469fc658ba9ffb0d962f22dc2115b77169..594f4b259ae62e32b7ec3e3050345deeb2dbeb79`. Product HEAD: `594f4b259ae62e32b7ec3e3050345deeb2dbeb79`; tree `eedebac51c2068e2349fd0c0f27932724f245941`. The scope is the eleven changed source/test files and their relevant callers, against the round-2 brief and root R-B-18/19. No unrelated B2/decomposition/full-review restart was performed.

I read the brief, complete round-2 report, generated range diff, changed implementation/tests, relevant preparation/provenance/capture/serialization callers and current canonical rulings. Static checks matched **11 current file hashes, 20 preserved log hashes and 8 reused predecessor identities** against the manifests, with **zero mismatches**. I also read root's final static integration audit and its implementation: 109 historical blob bindings, 90 current product paths, 133 logs and the genuine 178-entry capsule check report zero errors. That audit is corroborating static evidence, not product execution by this reviewer.

## F2 — ADDRESSED under R-B-18

The earlier preparation/provenance reads now use the same selected owned payload path as rendering:

- `core-session/src/conversation/input-preparation.ts:10` extracts the existing raw/admission/derived-observation text equality into `validatePreparedInputText`. Full/public preparation validation calls it by default. Only the existing private semantic-source capability defers that payload equality; reference, action, phase, producer, promotion and provenance structure remain checked in the same preparation index (`:54`, `:62`).
- `core-session/src/events/input-preparation.ts:29` provides the private source shape profile for completed observations. It checks envelope/observation structure, presence, producer and count without traversing discarded observation text. The normal full shape profile remains strict. No public skip flag or second preparation index was introduced.
- `core-session/src/conversation/render-items.ts:24`–`39` validates selected preparation text before provenance or wire rendering, using descriptor capture for the selected message and its actual admission/observation. `conversation/sources.ts:60` reuses the same reader for promoted provenance text equality, closing the second raw-text read identified by the runtime probe.
- `core-session/src/conversation/payload.ts:14` caches the owned capture by actual object and property key. Text, images and native fields remain distinct even when they share a source address; subsequent equality/provenance/render consumers reuse the captured slot. The cache is scoped to this derived rendering operation, with no new persistent store or authority.

The maintained test constructs genuine nondurable preparation through the actual owner/admit/capture/start APIs, then detaches that committed history for controlled descriptor mutation. It proves raw, derived, admission and observation benign getters refuse with **zero calls** when selected; plain-data mismatches in all four slots still refuse; a fully consumed prepared component exports only its current summary without reading any of those historical bodies; public full validation remains strict. Admission text+images and human provenance remain correct. A valid text-first observation control preserves exact JSON property order through ordinary admission and selected export.

The property-order regression discovered during the fix was meaningfully reproduced and corrected rather than hidden: the helper rebuilds the validated observation in its existing key order using owned text, without spreading or rereading the original payload. The final core suite covers the corrected implementation. This satisfies the R-B-18 resolution of the structural/payload overlap; the earlier F2 residual is closed.

## F4 — ADDRESSED under R-B-19

`session-persistence-jsonl/src/format.ts:38` now binds the actual header publication to owner-controlled expectations:

1. It captures protected-field presence and canonical value strings before ordinary patch evaluation (`:40`), preserving the R-B-16 protected field set and format/journal error wording.
2. Protected own descriptors/data are checked without executing their getters. Ordinary metadata is materialized and the merged header serialized once (`:42`), including any supported ordinary getter or serialization callback.
3. Those exact bytes are parsed into detached owned JSON. Every final protected field is compared against the original presence/value expectations, including removals (`:47`), followed by the final owned semantic-header validation.
4. `session-persistence-jsonl/src/index.ts:260`–`266` writes the returned checked line directly and returns the detached metadata. There is no later patch read, callback or serialization step, and no checked protected object alias is returned from the caller patch.

The earlier title-getter mutation therefore cannot replace the value being checked: a changed final digest or missing protected field is rejected before any write, regardless of the earlier equivalent-value comparison. Shape-only rechecking is no longer the publication guarantee. The event body is neither parsed nor reserialized for a metadata update, preserving the ordinary title/torn-tail contract.

Maintained actual-backend controls cover the exact computed-title mutation with one callback and byte-identity refusal, an ordinary computed title succeeding exactly once, detached protected return data, a nested serialization callback changing protected identity, and a whole-header callback dropping the reservation. Existing protected-getter zero-call tests, birth/reservation introduction/change/removal, no-op/title/archive/model/workspace/torn-body positives and append/replacement readiness controls remain green. This closes the F4 residual while preserving its scoped public-writer correction; no new lifecycle/permission owner or public bypass was added.

## Verification reviewed and timing limits

All product execution below was performed by the designated writer/runtime owner. I read the scripts/source, command table, preserved log summaries and manifest bindings; I ran no product code or tests.

| Evidence under `.tmp/r4b-b1-fix2-20261023/` | Review assessment |
| --- | --- |
| `03-prepared-red-corrected.log` | Clean original-product regression: **4 behavioral failures / 6 passes**, including raw getter 2 calls, derived getter 1 call, selected admission getter acceptance and consumed-component refusal. The earlier frozen-nested-object setup failures in log 01 remain separately classified and are not the accepted RED receipt. |
| `02-metadata-red.log` | Original round-1 product: **4 failures / 23 passes**, covering the actual mutating title, protected return alias and nested/whole serialization cases. |
| `04-prepared-green.log`, `05-metadata-green.log` | Focused corrections: **40/40** preparation/source/generation tests and **42/42** public-writer/metadata/format tests. |
| `10-observation-order-red.log` → `11-observation-order-green.log` | Introduced text-first observation formatting regression: **1 failed / 10 passed**, corrected then **37/37** across preparation/generation/source controls. |
| `16-core-suite-final.log` | Final committed core source: **506/506**, 46 files, after the observation-order and final payload-source-label corrections. Includes earlier source/getter/readiness/memory/catalog regressions. |
| `17-jsonl-suite-final.log` | Final committed affected JSONL source: **179/179**, 16 affected files. The two unchanged predecessor-gate files are explicitly excluded by this command and their prior qualification reused as directed, not silently skipped in maintained tests. |
| `18-core-session-type-final.log`, `19-session-persistence-jsonl-type-final.log` | Both affected package typechecks pass on final source. Earlier union-narrowing type failures remain disclosed; runtime GREEN was not mislabeled type-qualified before correction. |

The earlier broad runs 12–15 were superseded by final runs 16–19 after the narrow payload source-label correction. No source/test edits follow those final checks. All eleven current file SHA256s and all twenty listed log SHA256s match the round-2 manifest.

The **eight** predecessor fixture/helper/test/tooling files are unchanged against both the round-1 and round-2 manifests, independently compared here. The genuine 177-file/10-package capsule plus root license remains exact. Its round-1 isolated **9/9** qualification is reused under the brief; no regeneration, fixture runtime rerun, maintained skip or simulated predecessor was introduced. Normal runtime dependencies are unchanged.

No public facade, DTO/package export or consumer interface changed in this round. Context/persistence suites and reachability were not rerun, as explicitly reported. Their prior source-timed evidence is not represented as a fresh result for this HEAD. The existing raw fork archive baseline remains an open expected RED obligation until the real B2 consumer changes, and the sole staged `exportConversationSeed` reachability row remains disclosed. This review does not claim all repository suites or graph gates are green.

## Final scope boundary

No additional actionable finding or required probe remains in this eleven-file review. F2/F4 are closed; the five prior closures stand. The changes retain the same structural/capture/preparation/metadata owners and implement root R-B-18/19 rather than introducing new authority. Product paths remain clean at `594f4b25`; only root's three documentation files are dirty. This report is the reviewer's only write; no product/test/index/Git/runtime mutation or agents were used.

The result qualifies the reviewed corrections for **B1 staging** only. Product remains 0.1.13-rc.1. No B2/native/provider/dependency-transfer/connected 100 MiB volume qualification, whole-B acceptance, release or decomposition completion is asserted. Root owns the acceptance decision and later gates.
