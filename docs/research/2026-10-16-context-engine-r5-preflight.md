# ContextEngine R5 — observation and final-consumer decisions

2026-10-16. Future planning only, pinned to `292362992f304e6bf7811f22df29608999c59539`; F1 remains the sole product writer. Evidence/consumer table: `.tmp/context-redesign-20261015/r5-observation-preflight.md`. Actual reviewed F1–F4/E/R4 domain interfaces must be rebased before executable R5 plans. No new version, completed milestone, live-provider result or release qualification is claimed here.

## Preserve correct boundaries and remove remaining read side effects

The shared browser-safe SessionContextState decoder and service context reader already avoid prepare/auth/send and expose cold saved budgets as historical/unavailable. Info/context diagnostics are already Log-only; RuntimeFeedback uses explicit kinds plus correlation, not severity alone. Preserve those fixes and their existing fixtures. A local stale-observation cache latch is not a new admission fact or authority to infer.

Ruling: model/dashboard/history/status inspection also becomes observational. Use metadata descriptors and known live observations instead of the inference resolver used by current model/dashboard getters. A legacy backend without a safe cold snapshot returns explicit observation-unavailable; it cannot silently adopt ownership, repair or assemble a session merely to show history. Actual opening/resume/model-setting/refresh actions remain explicit. Do not claim a model authenticated or connected merely from configuration metadata.

Keep distinct domain DTOs/fields for current versus historical capacity observations, exact HTTP bytes versus SDK estimate, reported usage versus calibrated estimate, effective input trigger/target, reduction outcome, publication disposition, recovery, logical action/physical attempt, retained-result status and delivery stage. Reuse the actual owners' reviewed contracts; no new calculation or a single ready/busy/error flag in the renderer. Current input/window percentages may remain clearly labelled display arithmetic, but cannot decide E's trigger/target or transform an unavailable reading into zero.

Manual compaction CLI/Gateway/renderer consumers must stop deriving success from compacted boolean or marker/flush. Consume F3/E's exact current reduction/publication result. Child catalog completion must stop inferring from repaired turn/end and last assistant text; consume R4C's actual expected-action/result facts. Inspection cannot repair delivery, admit input, wake, claim or clear a recovery state. Retention recorded at capture and current authorized availability remain distinct.

## Usage: append-only observations of the actual attempt owner

Existing immutable UsageRecord rows count capture-wrapper invocations. A pre-send auth/fence failure can create one, an exhausted stream without explicit end may be labelled completed, and rows have no action/send/purpose identity. They are not retrospectively provable physical sends or logical actions. Their raw reported token/cache fields, missing-versus-zero semantics, explicit prices and subscription cost rules remain valuable and must be preserved.

Ruling: add a **versioned append-only observation record stream**, with immutable per-observation IDs and F4 action/attempt/cause/purpose/origin correlation. Group observations into the final attempt/action view; do not persist an unfinished row then mutate it under the existing same-ID immutable store contract. F4's journal is the execution authority; the usage store is an observer and cannot mint reservations, retry work or declare a missing terminal phase successful. Phase/usage snapshots must define provider-normalized cumulative/partial behavior explicitly so multiple reports are not added as separate billing totals.

New producer, strict validator, store, aggregation and UI must cut over together; the current validator reconstructs an allowlist and would silently drop added identity fields if only the producer changed. Deduplicate replayed observation IDs. Recover/resurface known durable F4 facts without inventing provider usage; reserved/unknown and issued/no-usage remain separate from zero tokens. Logical actions, known transport handoffs, uncertain reservations, local no-send candidates and measured-usage coverage are separate counts. A successful capture callback or row count is not an actual-send oracle.

Older rows stay legacy/unknown attribution. Do not backfill physical or main-purpose labels from model/time or merge legacy wrapper counts into a falsely precise new physical total. Preserve a clearly labelled legacy bucket/coverage when displaying mixed records. Main, child, summary, recovery, approval, title and the actual media auxiliary keep their own selected model/purpose and real parent origin; normal child spend is separate, recovery remains in the same action, and no nonexistent WS/count producer is invented. A usage-store failure adds no inference/effect and does not alter raw usage retained by its existing source owner.

## Logical terminal feedback and typed recovery

Only the actual owner's final logical disposition creates terminal diagnostics/popups. A discarded no-send candidate, a handled summary-piece failure or a reconciled storage attempt is bookkeeping until the owning action fails. A physical attempt settling does not mean the logical action finished, the checkpoint reached target, or the parent consumed a result. Carry exact action/attempt identities through SDK/native diagnostics and preserve existing execution-revision/correlation safeguards against late old events.

Keep scalar allowlists and canonical messages at both gateway and native persistence boundaries; identifiers need explicit bounded validation. No raw envelopes, arguments, signatures or media in Log data. Historical Log reads cannot recreate live toasts. Existing info-kind filtering remains unchanged. This introduces no UI retry owner or additional setting.

Schema/auth/server/request-bytes/context/output errors remain distinct. E and F4 determine permitted progress/retry, not the UI. Only relevant measured reduction in the failed dimension can authorize changed-input recovery; a new payload hash or smaller cap alone is insufficient. Preserve CLI exit compatibility with independent truncated/refused/empty quality flags and stderr outside NDJSON stdout.

## Two bounded correctness units before the broad consumer migration

1. **Supported provider tool-argument data before acceptance.** Static evidence shows incoming args can reach acceptance before the R1C supported-data guard. Establish a literal failing fixture, then guard before accepted exchange or any dispatch using the same supported-data contract. Preserve raw observations/usage available on failure, without creating a calibration sample. A typed MALFORMED_RESPONSE correction uses the same F4 action/lane allowance; it cannot reclaim input, rerun hooks/tools, reset summary or create free retries around the lower wrapper. Schema-invalid but otherwise supported JSON remains an ordinary tool validation case. Historical unsupported accepted data is explicitly blocked/qualified; do not invent lost lexical precision. This is a static gap until reproduced, not a new diagnosis of the user's old provider incident.
2. **Public Responses null-reference consistency.** Measurement currently uses !==undefined while final validation uses !=null for previous_response_id/conversation/prompt. Align those adapter-owned absence predicates with exact absent/null/non-null controls, preserving raw option bytes. Non-null remote input remains incomplete; no implicit remote fetch or broader protocol audit.

These narrow fixes can be independently rejected/reviewed after their actual dependencies. R5's full observation/statistics migration still requires all real consumers and the reviewed domain owners; neither a DTO-only edit nor renderer-only test completes it.

## Required controlled evidence

- Repeated real context/history/model/dashboard/artifact/child reads and UI mount/hover/refresh produce zero prepare/auth/count/generation/dispatch/admission/wake/repair and no journal mutation; cold readings stay historical, live owner appearing across an await wins, unsupported backend reads are explicit.
- Gateway→native→renderer correlation controls: internal rebuild then success yields no terminal popup/stuck activity; final repeated instability yields one final failure; late older results cannot settle new work; context info/Log replay never overwrites live feedback.
- Physical recording transport counts versus versioned usage observations across local no-send, retries, summaries, recovery, children, title/approval/media and crash-unknown. Preserve legacy unknowns and exact missing/zero usage; store failure adds no sends.
- R4 cases with successful execution/failed retention, durable result/stopped parent, admitted/unclaimed result, duplicate text with different revisions and repaired/interrupted child state. Reading them cannot change their stage.
- Actual malformed-argument and null-reference RED/GREEN controls, plus independent canonical failure/CLI fixtures. Effect count remains one, input claim remains one and automatic work stays within F4's action allowance.

The old failed whole-program evidence remains open until R6 fixed-HEAD qualification. No scope/count advancement or candidate publication follows from this document.

## F1 file-query reader follow-through (2026-10-17, still unreviewed)

Actual CLI qualification found the file-backed session-query scanner interpreting format6 batch wrappers as individual events. F1 is correcting it through the shared byte-exact journal codec while retaining read-only, structural file observation semantics. A bare file reader can see a complete unsynced frame; it cannot manufacture an owned receipt, execution/permission proof or a current runtime Session. F1 adds no unused optional coordinator seam to the standalone storeRoot API. Rebase the accepted reader/API in R5 and decide the actual shipping composition of live-owned query observations where needed: use established immutable ownership/lineage checks, state unavailable honestly, and never load/repair/assemble/send to satisfy observation. Preserve standalone structural-file compatibility with explicit provenance and no false durability claim. This note adds no product completion or R4 artifact authority.

## 2026-10-18 qualification obligation: renderer must not depend on Node fact machinery

Actual F4 candidate c6a78be1 renderer build fails in core-session/managed/capture.ts: node:util `types` is not exported by Vite's browser external module. The exact sealed4b4cbe47 BASE build also fails, but its first error is core-session/events/usage-anchor.ts: node:crypto `createHash` is not exported. Both logs additionally report Node imports from managed/settlement-event.ts and serialization/fact-journal.ts. Current build transforms2107modules; BASE2102. These are DISTINCT initial failures. Unchanged source files do not prove unchanged dependency reachability or absence of an F4 contribution.

Closed evidence in .superpowers/sdd/2026-10-18-context-engine-r3-f4-physical-attempts/evidence:
- build-renderer-final1.log SHA256 a60af69bf430f66e9b404d05aaad5116cc9638403e900aea3fcf778017e798cf.
- base-4b4c-renderer-build1.log SHA256 201ef3615f1256d3f74015fb53cdd16297d563164ef3b6b7c66ee33f01604375.

Root independently read both causes/warnings and hashes. F4 records renderer as FAILED/unqualified, not an identical baseline or a renderer pass. Fresh F4 review still evaluates any concrete added risk. This does not block continued isolated Gateway/CLI evidence, nor does their success qualify the renderer.

R5 must establish the actual browser-safe observation/DTO dependency boundary and migrate real renderer consumers, while Node retains the strict proxy/accessor checks, ownership, journal, hash and captured-fact validation it needs. Do not replace strict host validation with a permissive browser stub, blanket polyfill or suppressed build warning. Follow the live imports to decide the narrow split; do not move execution authority or capacity decisions into UI code merely to make bundling succeed. Qualify actual renderer build and its observed-state paths with zero prepare/auth/model/tool calls. R6 must include the corrected shipping renderer before any release claim. This is part of the existing observation-boundary redesign, not an extra independent frontend feature.
