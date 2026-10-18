# R3 F3a pure prepared assessment — verification record

**Status:** independently approved through `c87b0e599e3ba00a7b90e92a8323840694def52a`, from BASE `6178b8ec908d5e897031874f8c891018dd018757`. Spec compliance and task quality both Approved; no blocking product or plan-mandated defect found. Product remains0.1.13-rc.1 and original decomposition27/43. This is the calculation/construction prerequisite, not whole-F3 or release completion.

The [plan](../superpowers/plans/2026-10-17-context-engine-r3-f3-prepared-assessment.md), amended task brief, three-commit diff, implementation report and review are under the plan and `.superpowers/sdd/2026-10-17-context-engine-r3-f3-prepared-assessment/`. All failed and earlier-source receipts remain under `.tmp/context-r3-f3a-validation/`.

## Actual ownership change

ContextEngine owns `assessLegacyPreparedRequest`, consumed by the real main budget owner. It validates A, chooses at most one allowed cap derivative, validates/reprices the final B and reads recovery against B. Capacity fit stays separate from authorization-sensitive admission. The calculator has no Session, telemetry, calibration retirement, publication, execution confirmation or recovery-admit operation. It copies requestContext before freezing returned scalar facts and retains the actual prepared handle.

The live core-agent budget owner still owns accepted calibration, current observations and checkpoints, installing its new observation only after successful calculation. The new execution.peekExpected observes the same lifetime/value without clearing a previously confirmed identity. Existing candidate/confirmation paths retain mutation authority.

`buildContextRequest` is a data-only constructor used by the actual step caller. It preserves captured message/native/image order, copied schemas, effort, cap, scope/signal, cache key and retry policy. The live caller retains hooks, input claims, step identity and prefix telemetry.

Root explicitly amended the original fallback-retention proposal after auditing real consumers: the old private-package `checkBudget(Session,...)` wrapper had lost its only production caller. It and its barrel entry were retired completely; `compareBudgetTotal` is the actual scalar primitive. Numeric/ratio/boundary assertions migrated and the real assessor proves complete input is charged once. activeTokens and its genuine users remain. This is an intentional internal package-API removal, not a claim that the old fallback still exists.

## Evidence and limits

| Scope | Result and qualification |
|---|---|
| Token-meter |21/21 required scalar/calibration tests pass |
| ContextEngine |50/50 full package tests pass;15 assessment cases are included in that count |
| Current raw test source | One review-requested focused15/15 pass directly binds final raw test SHA8b3d134c7f101c8262c83af2cd42a3b17032d8a02ecdbc694bc8b68361e17f93 and unchanged source tree8e507a7e2ef0ebd375fadc1fac426f7df78eecf8a8c8332769b67c9866db85fe atc87b0e59 |
| Required core-agent covering scope |102pass/18fail; exact original BASE95pass/same18 assertion summaries. Seven new controls pass. Original assertions/failed receipts remain; see [named baseline obligations](2026-10-17-context-engine-f3a-baseline-gaps.md) |
| Types and graph | Seven required package typechecks, E2E types and corrected reachability pass; no baseline reseed/allowlist change |
| Actual copied Gateway main |2 preparations/2 derivatives/2 controlled sends/2 accepted exchanges;10 actual context observations add no prepare/derive/send. Sent caps600 and78838 agree with persisted selected-cap facts; second input11162 gives I+R90000 at W100000 |
| Actual copied CLI run/resume |2 accepted main exchanges; caps600 and81255 agree with persisted facts; second input8745 gives I+R90000. There are3 controlled fetches in total:2 main and1 auxiliary title, kept distinct |

Fresh final copies are `.tmp/context-r3-f3a-{gateway,cli}-20261017b`; actual result is `packaged-assessment-GrB80d/result.json` in the evidence directory. The reviewer independently verified17/17 final task source hashes,10/10 Gateway runtime copy hashes and CLI bundle SHA256 `fcb82d382fc89c976247baea4a5adb56e813d602d9c443c0edf041f11ed33b5c`. Runtime artifact HEADed58d47a has exact final runtime bytes; later test refinement/EOF differences are explicitly separated.

The initial test-source normalization receipt did not directly bind the raw self-review test bytes. Review identified that limitation. A single focused current-source test run resolved it without product edits, broad reruns or rebuilds; the old receipt was not retrospectively declared stronger than it was. Early invalid fixtures, stale first-copy identity and the first CLI smoke's unsupported harness route remain recorded separately from passing final-source evidence.

Review Minor F3a-M1 retains36 dynamic TypeScript-import packaging warnings, the inert SdkRunError allowlist warning and unavailable optional platform packages. Successful tested main paths do not qualify unexercised shipping paths. F1-CLOSE-OBS-01, B2 coordinates, the18 named BASE assertions, cold memory and full R6 obligations remain open. Matching BASE assertion summaries do not diagnose every nested error or turn those tests green.

No six-route online qualification, new selection/summary/publication/target policy, F4 attempt mechanism, E capacity policy or R4/R5 delivery/observation completion follows from this gate. Connected source-unit work must address the post-F2 closure inconsistencies before a new replacement producer is enabled.
