# R4A retained-result physical crash qualification — acceptance

Root accepts the test-only range `5c399cbb55a64fdd37b0cab0b30250871103e9d2..d41813518be99fcd41c4709108ed942e9810fba4` after a fresh GPT6.1Sol review and independent evidence audit. The unit qualifies existing behavior at five physical boundaries for both ordinary tools and actual Code Mode guest tools. It found no production defect requiring a product change.

The product remains **0.1.13-rc.1**, Session format **10**, and original decomposition progress **27/43**. No build, push, merge, tag, release, installed IH operation or live provider/account was involved. This does not close all of R4A/A5/A6, R4B/C, R5 or R6.

## What is now qualified

Both producer modes use the actual session service, original automatic result-store/source authorization, real JSONL coordinator and original OpenAI-compatible client against a task-owned loopback endpoint. Code Mode runs its actual guest and calls the same writing fixture. The fixture effect, body getter and original post-execute hook each occur once.

The parent kills only the direct test child it owns, then waits for process close before constructing fresh owners. The cases are:

| Physical state at process death | Verified fresh behavior |
| --- | --- |
| Artifact committed, result frame not issued | No original result frame appears; ordinary recovery stays unknown, and absent nested Code results remain absent |
| Exactly 17 frame bytes written and synced, rollback refused | The original backend returns unknown; owned recovery removes only the torn suffix and does not recreate success |
| Complete frame written and synced, durability evidence lost | The original frame/key/ref survives exactly once despite the withheld unknown outcome |
| Original committed receipt withheld from coordinator | The original frame survives exactly once without an original local installation |
| Original local install fails after durable receipt | The genuine `FACT_INSTALL_FAILED` outcome is observed; a fresh owner reconstructs the durable frame once |

The unknown cases stop below the coordinator, before passive reconciliation can move the cut. Native write faults match the exact original encoded batch object and then its genuine FileHandle. The install fault wraps the actual stage's installation; an observer failure is not used as a substitute.

Fresh `snapshot` and actual result-page reads precede any owned repair and leave original session and artifact authority bytes unchanged. Positive-calibrated authorization checks show the unrelated caller performs no artifact body open. Explicit `openManagedDocument` then invokes only the original recovery path, preserving the complete raw prefix at its original coordinates. The original result, conservative recovery row and outer/nested identities are counted separately.

A later new explicit input remains usable and adds exactly one model request. It does not repeat the writing fixture, getter or hook, and the shared effect ledger still contains one entry. Code Mode's original interrupted-cell marker is distinguished from guest continuation or a new nested result.

## Review and evidence

The [independent review](context-r4a-physical-crash-review-20261021/review.md) is PASS for spec and quality/evidence, with no actionable findings. Root read the complete review before accepting. The [writer delivery](2026-10-21-context-r4a-physical-crash-delivery.md) remains the detailed mapping of source seams, failures and commands.

Seven final gates passed on the same recorded source identity:

- Two normal setup controls and ten actual crash controls: **12/12**.
- Existing physical/retained-flow/hook regressions: **15/15**.
- Original JSONL fact journal: **28/28**.
- Original persistence managed fact batch: **1/1**.
- Original core journal/view: **6/6**.
- Explicit `.mts` helper typecheck and ordinary executor typecheck: both pass.

That is **62 passing tests and two type gates**. Source manifests contain 2,475 relevant tracked and untracked entries, including all new helpers/type configuration and direct runtime owners. The recorded set covers package/script `.ts`, `.mts`, `.tsx`, `.json`, `.mjs` plus root package, lock and TypeScript configuration. It does not constitute a new installed dependency/native binary or packaged build qualification.

Root's [final audit](context-r4a-physical-crash-review-20261021/root-verification.json) found zero mismatches across 1,033 sealed files totaling 73,734,220 bytes, nine handback files, all 2,475 current source entries, 18 recorded sequential runs, seven qualifying runs and all twelve final fixture records. Root independently checked fixed body bytes/digest, artifact authority inventories, exact selected frame/key, partial suffix, complete raw-prefix preservation, conservative recovery rows and recorded effect/request/callback values.

The first root checker incorrectly expected one IPC message in setup cases. Positive setup actually sends `setup` and then `closed`; crash cases send only `cut`. The original failed root report remains preserved, and a corrected checker required these exact per-case message sequences and common nonce/id/mode/cut before producing the passing v2 report. This was a verifier metadata correction, not a product/test/evidence change.

Raw evidence remains at `.tmp/context-r4a-physical-crash-20261021-implementation/`. Its closure SHA-256 is `c38246895b89eb09cf8740e83c019d22c5c0acd86c77f34366bc1f756718af2b`; the separate handback manifest SHA-256 is `b70b9da67d3e3453c83c980299d68bb6e0b4ff74b2d7d2c9c061b57786efaf21`.

## Necessary limits and corrections

The parent's `fresh.guestFulfilled` field is not independently wired to a fresh runtime callback. Root does not use that zero alone to prove no guest work. Cold behavior is supported by actual zero assembly/model/tool/getter/hook observations, unchanged authority inventory and absence of durable output. Later remount behavior is supported by original mount/runtime code, the sole text model response, fixture/ledger evidence and original cell/result/output facts. The original child guest callback is positively instrumented and fires once in setup, zero at every crash.

The child awaits `process.send`'s callback; the parent proves structured receipt delivery, not a separate acknowledgment that the callback ran. The selected original operation remains pending while sending and after parking, so this distinction does not move the physical cut. No additional callback-ordering guarantee is claimed.

Node's native module-mock experimental and `namedExports` deprecation warnings are retained. The original journal test's expected injected file-close-after-sync diagnostic is also retained. Earlier typing, selector, I/O probe, nested-outcome visibility and overly broad operation-count failures remain explicitly classified as setup/oracle failures. No production repair is inferred from them.

This is hard process-crash qualification on Windows x64 / Node v24.15.0. It is not a power-loss test, another-platform qualification, an absence-of-every-instruction proof, or a packaged-entry test.

## Rulings and remaining work

Ruling: observe the actual selected `FACT_INSTALL_FAILED` input to the original `committedFactSeqs`, preserve exact return/throw/outcome identity and delegate unchanged. Guest error conversion hides that nested outcome from the outer submit error. The cost of an incorrect observer would be false cut provenance; the actual receipt/key, original thrown outcome identity and independent source review constrain that risk.

Ruling: synchronize and restore the native ESM body-open probe only with a real positive read calibration. A zero from an unconnected spy is not evidence of denied I/O.

Ruling: no-cut Code Mode legitimately creates two artifacts, the nested result and its emitted text. Require exact distinct call/cell ownership and the independent 17-byte JSON digest; every crash still requires exactly one operation. The earlier blanket count failure is preserved.

Next is the original artifact publication and first/second document-pin unit. Catalog/set lifecycle, mixed quota/retention/deletion, bounded integrity and A6 scale/packaged controls remain separately qualified. Broader event-driven/instruction/decomposition work remains paused.
