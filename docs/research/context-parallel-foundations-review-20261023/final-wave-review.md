# Final combined-wave review

Reviewed product range: `7ef8d71b76541b6311a9fa8364dbfe6f89f41869..7706c2ea768af6da573ebb9abef75ef12aad4969` (34 files). Review applies to the approved parallel-foundations plan, including P-04 no-clobber publication and P-05 link-seam test adaptation. It includes the final typed-denial correction.

## Spec compliance

**Compliant for the three scoped foundations and their integration correction.** No significant implementation departure from this wave's approved contracts was found.

- Artifact settlement validates and drains actual catalog metadata before issuing companions, then checks every alias's original operation and pin before canonical-first publication. Strict metadata capture, bounded parser buffers, no-clobber immutable publication and retained uncertainty are implemented under the existing mutation owner (`packages/context-output/src/artifact/dependency-membership.ts:62`, `packages/context-output/src/artifact/dependency-catalog.ts:52`, `packages/context-output/src/artifact/io.ts:132`).
- Semantic retrieval follows validated group associations through the existing history owner. Both automatic executor authorization and Gateway visibility consume these refs, compare all seven managed fields, and preserve the artifact owner's pin/source checks (`packages/core-session/src/conversation/history/facts.ts:33`, `packages/core-session/src/results/seed-refs.ts:7`, `packages/session-executor/src/lifecycle/result-store.ts:99`, `packages/desktop-gateway/src/host.ts:228`).
- Independent READY reads use genuine broker-owned binding/catalog revisions; resolver errors deny. Gateway guards its supplied-service fast path as well as the executor's automatic path, and successful body returns retain final currentness/archive/lifetime checks (`packages/desktop-gateway/src/project-scope.ts:303`, `packages/desktop-gateway/src/context-runtime.ts:53`, `packages/session-executor/src/service/result-reader.ts:20`).
- Owned confirmation provenance remains private and specific to an original confirmation and actual executed source handle. Fixed wrappers derive one executed cap source. Ordinary structural receipt behavior remains separate, and terminal end is not promoted to Agent acceptance (`packages/llm-seam/src/prepared/payload.ts:13`, `packages/llm-seam/src/prepared/payload.ts:85`, `packages/llm-seam/src/prepared/owned-terminal.ts:17`, `packages/llm-seam/src/prepared/owned-wrappers.ts:15`).

## Strengths

- Authorization responsibilities compose without a new authority store: structural reference evidence does not itself grant a pin, immutable membership does not itself grant host permission, and broker revisions do not replace artifact pre/post authorization. The actual owner still authorizes before and after both page and exec-frame reads (`packages/context-output/src/artifact/ownership.ts:94`, `:114`, `:127`).
- Canonical-first membership settlement deduplicates only companion publication. Distinct sourceIds and all catalog ordinals survive; conflicting aliases and noncanonical witnesses refuse. The parser's escaped-surrogate identity encoding avoids conflating distinct sourceIds, and its callback contract explicitly requires successful EOF before later target mutations (`packages/context-output/src/artifact/dependency-membership.ts:76`, `packages/context-output/src/artifact/dependency-catalog.ts:94`).
- The supplied Gateway owner is explicitly wrapped, closing the gap that an automatic-store-only change would leave. Equal-root reconfiguration and revoke/restore are observable by revision even when source identity returns to its earlier value (`packages/desktop-gateway/src/context-runtime.ts:53`, `packages/desktop-gateway/test/result-page.test.ts:99`).
- The final reader correction preserves a bodyless typed denial after awaited release while keeping every successful-page guard. It does not weaken native-frame authorization or relabel unrelated failures (`packages/session-executor/src/service/result-reader.ts:38`, `:42`, `:45`; `packages/session-executor/test/result-reader-lifetime.test.ts:78`).
- Native tests exercise actual controlled HTTP issuance, callback timing, failed retries, copied confirmations, wrong sources/caps, fetch overrides and nested fixed wrappers. The single-derivative fix preserves exact source identity rather than repairing an independently derived source by digest comparison (`packages/llm-seam/test/owned-confirmation.test.ts:36`, `:53`, `:74`, `:91`).

## Issues

### Critical

None found.

### Important

None found.

### Minor

No new combined-wave finding. Retain the existing deferred coverage item at `packages/core-session/test/semantic-seed-result-refs.test.ts:10`: its positive fixture shares one result/catalog ref, so a distinct catalog-only ref/index regression is still useful during actual transfer integration. Source inspection confirms both indices are extracted; this is not an observed behavior defect or a new blocker.

## Concrete checks and evidence

- Read the complete supplied combined diff once in six manageable sections, covering all 34 files. Read the approved plan, acceptance draft, three task review reports, integration-correction review, checkpoint and integrated source audit. The only file written by this review is this report; no product, index, HEAD, branch or runtime configuration changes were made. No subagents, suite reruns or runtime probes were used.
- **Catalog/authorization interaction:** checked the unchanged original scope admission and settlement entry in `packages/context-output/src/artifact/ownership.ts:36` through `:77`, the operation/pin helper in `dependency-membership.ts:40`, and the owner read boundary at `ownership.ts:94`. Actual registered entries are captured; settlement requires the initialized committed original scope; catalog evidence cannot bypass original-operation/pin or host source policy.
- **Quota-reconfirmation question:** examined the moved admission point at `dependency-membership.ts:95`, `quota.ts:48`, and the original scope lifecycle. Published original companions already have their ordinal in the retained registration's admitted set. A new scope cannot silently reopen the existing operation, so no reachable tighter-quota reconfirmation regression was established. No speculative finding or unnecessary probe was issued.
- **Parser/storage interaction:** checked the existing verified-byte reader used by catalog pages (`packages/context-output/src/artifact/reader.ts:10`). It validates manifest/index/chunks and physical identity. The new parser does not read member bodies; bounded page/descriptor claims remain distinct from count-dependent identity bookkeeping.
- **Semantic association/rewind interaction:** checked the unchanged seed codec's association/use/count validation (`packages/core-session/src/conversation/seed-codec.ts:82`, `:215`) and branch visibility (`packages/core-session/src/conversation/history/visibility.ts:7`). The new extraction uses validated indices and rewind eligibility, without applying reset/summary content hiding to archived retrieval.
- **Read lifetime/source interaction:** completed the broker's existing catalog admission, withdrawal, move and close context, and the automatic store's existing lineage branch. Catalog revisions advance before asynchronous reconfiguration, close rejects getters, independent target authority avoids ancestor dependence, and the fallback remains lineage-dependent. Existing moves refuse sessions with descendants, limiting inherited-binding mutation paths (`packages/desktop-gateway/src/project-scope.ts:176`, `:217`, `:276`, `:335`; `packages/session-executor/src/lifecycle/result-store.ts:65`).
- **Typed-denial correction:** inspected `packages/context-output/src/result-page.ts:9` and `:33` together with the successful page returns. Only the bodyless failure union has top-level `kind`; successful text and exec bodies continue through the final guard. Awaited release still precedes either return.
- **Native issue/confirmation/source interaction:** checked unchanged `packages/llm-seam/src/prepared/execution.ts:33` and fixed/public control composition in `prepared/wrappers.ts:49`. Original confirmation creation precedes the guard, but the internal issue notification follows successful guard/reservation issue; successful evidence additionally requires observed end. Per-stream state and WeakMap keys keep concurrent/retried invocations separate. The new constructors/reader remain absent from public exports, as enforced by the source-boundary test.
- **Exact tested-source binding:** confirmed checkout HEAD is `7706c2ea768af6da573ebb9abef75ef12aad4969`; independently SHA256-hashed all 34 current changed files against `docs/research/context-parallel-foundations-review-20261023/integration-root-audit.json`: **34 checked, zero mismatches**. `git diff --check` for the complete product range exits 0. The broader 4,606-file stability audit is root-supplied evidence, not an independently repeated hash audit by this reviewer.
- **Raw final validation:** decoded and inspected the archived integrated logs: artifact **134 passed**, executor **32**, Gateway **53**, semantic refs **9**, seam **25**, actual calibration **16**, and all **six** typechecks exit 0. Artifact qualification is at `a6065a0e` and reused after the reader-only correction; the other named final logs identify `7706c2ea`. These are inspected results, not new runs or counts to sum across overlapping suites. The final normal reachability log exits 1 with exactly the disclosed seven staged export rows; it is not represented as a passing gate.

## Scope limits and recommendations

Keep the existing catalog-only fixture minor visible. The native isolated snapshot limitation is addressed for integrated acceptance by the actual final calibration rerun and broader root snapshot; this does not retroactively enlarge the isolated snapshot.

This review does not qualify full artifact transfer/v2/pins/closure folding, pre-ready project binding or zero-artifact bootstrap ordering, actual fork/spawn/caller cutover, native acceptance/current-unit/source-lifetime proof, NativeSourceProof/Lookup, final permit, protocol lowering, or whole R4B. The raw-fork RED, seven staged exports, original two storage Minor obligations and later whole-program/package gates remain pending. READY archived-reference retrieval is not native-current selection. No publication, release or decomposition-only resumption is recommended by this review.

## Assessment

**Quality: Approved. Ready to accept this integrated foundation wave: Yes.**

The combined source maintains the intended boundaries between structural evidence, immutable artifact ownership, read-time host authority and native terminal provenance. The final correction preserves denial compatibility without releasing stale bodies, and the inspected integrated qualification matches the frozen changed files. There is no new blocking finding requiring a product change before the root records this scoped acceptance and prepares the next wave.
