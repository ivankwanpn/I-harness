# R4A A3 Codex refinement plan

> **For agentic workers:** Continue the approved executing-plans workflow. Root is the only product writer under the user's “DeepSeek initial implementation → Codex review and direct adjustment” instruction. The original GPT6.1Sol reviewer remains read-only. No new implementation agents.

**Goal:** Complete the actual Code Mode text output cutover and recover original storage after cancellation, without claiming the rest of R4A.

**Architecture:** Each admitted text is captured through the existing result store before its original output source publishes a bounded `code/output` envelope. The real cell action registers a finite settlement source; already accepted same-cell backlog reuses that source as an ordered cohort while it remains unsettled. Original capture, F1 publication and callbacks complete before the source closes; only its own hold is released. Observer cancellation cannot revoke an already issued passive storage operation. Multi-text observations reference an explicit ordered text index, never a second concatenated body.

**Tech Stack:** Existing TypeScript/Node, QuickJS/WASM, Vitest, managed Session/F1 and ContextOutput. No new dependency, journal or scheduler.

**Spec:** [approved A3](2026-10-19-context-engine-r4a-completion-handoff.md), [retained-result contract](2026-10-18-context-engine-r4a-retained-results.md), original reviewer `a3-review.md`. Start `0cf2d24f` after external product `954f6c87`; full external+root review range starts at `4730ca83`.

## Binding constraints

- Desktop version0.1.13-rc.1, original decomposition27/43, session format10 unchanged; legacy raw content remains readable, new envelope and raw content cannot coexist in one output fact.
- Ordinary final escaped model JSON≤64000bytes; typed media retains its independent limits. Original guest transfer/admission limits unchanged.
- Once-only guest/tool/capture/write identities; unknown is not absence. No generic fault reset, no fake calls or new source permissions from payloads.
- Original source/receipt controls own storage and required fact publication. Existing root/child read policy, pin owner, media ordering and protocol-specific semantics remain intact.
- Source tests are sequential, without concurrent edits. Existing external evidence remains immutable. New evidence lives at `.tmp/context-r4a-a3-codex-20261019/`.

## Work and discriminating controls

- [x] Reproduce the external archive defect through an actual managed mount: hold `beginResult`, confirm raw output is already committed; reproduce unknown finish followed by cancellation failing original recovery. Preserve two REDs before product changes.
- [x] At `code-mode/output-facts.ts` and existing `event-facts.ts`, stage original per-item storage before one F1 capture, using the existing cell action and source ports. Preserve callbacks, output order and media facts. `runtime/output.ts` reuses committed item references; the index stores refs and media positions only.
- [x] In existing `code-text-retention.ts`, set issued state before `beginResult` await, preserve original scope through Stop, and confirm the same owner before returning ready. Actual managed Agent begin/finish cuts require one guest/inner tool and original scope identity.
- [x] Add the explicit envelope alternative to core-session code/output; wire validation through both intake and cold decode, reference discovery, search preview, Gateway and existing renderer. Preserve predecessor raw data; test conflicting alternatives and predecessor/current/future format behavior.
- [x] Reproduce then close a temporary hold that outlived recovered storage. A finite output source closes after its exact fact/callback, releasing only itself while the mount remains usable.
- [x] Reproduce index-only unknown admitting optional new work. The existing branded retained ToolExec outcome now holds its actual source before registry finalization exists. No second hold owner; original batch/source close releases it.
- [x] Reproduce escaped NUL model output99178bytes and valid long image-name metadata failure. Extract `observation-output.ts`; final ordinary JSON owns preview size. Keep full image name in typed `images`, omit its redundant ordinary copy.
- [x] Extend actual assembly to1MiB emitted text and cold bytes/digest, add a genuine role-restricted child mount, migrate old raw-fact assertions to the new reference representation without dropping their behavioral oracles.
- [x] Close Stop and source-pre-drain ordering: freeze strict terminal metadata immediately, allocate its F1 capture only at the original queue position, preserve metadata against caller mutation, and keep already accepted backlog under its original held source. Preserve each RED/GREEN pair.
- [x] Run affected suites/types, compare remaining failures against preserved source-time evidence, qualify fresh Gateway/CLI copies and perform independent rereview.
- [x] Record accepted scope, evidence/source hashes, inherited failures and remaining A4–A6/R4B–R6 responsibilities; commit locally, no push/merge/tag/release.

## Responsibility map

| Owner | Responsibility |
| --- | --- |
| `code-mode/event-facts.ts` + `output-facts.ts` | Original accepted output source, staged storage→F1→installation, finite hold lifetime |
| `code-mode/runtime/output.ts` | Accepted output window, committed-item association, bounded preview and ordered reference index |
| `code-mode/observation-output.ts` | Actual escaped ordinary model DTO budget; typed media stays separate |
| `session-executor/lifecycle/code-text-retention.ts` | Original result-store operation, bytes and owner confirmation; no guest execution |
| `core-tools/registry/retained-outcome.ts` | Genuine pre-finalization retained outcome hold, owned by existing tool settlement source |
| `core-session/events` + `results` + `projection/search.ts` | Versioned closed event validation, legacy read compatibility, reference discovery and preview |
| Existing Gateway/renderer consumers | Bounded read-only projection and preview/reference disclosure using IH styles |

The implementation may add cohesive leaves in these existing responsibilities. It does not advance unrelated decomposition counts or use this plan to waive broader lifecycle, cross-owner, search, migration or packaged qualification obligations.

Completed at product`583bc11f` with scoped independent specification/quality PASS; [acceptance](../../research/2026-10-20-context-r4a-a3-acceptance.md). Final copied libraries30tests, source/copy845matches and CLI smoke pass; final CodeMode95/1 and executor39/5 preserve the remaining failures. Evidence57receipts/312sealed files and source timing are explicit. This is the completed A3 refinement plan; subsequent work follows the2026-10-20 Codex-led/GPT6.1Sol workflow in the active framework.
