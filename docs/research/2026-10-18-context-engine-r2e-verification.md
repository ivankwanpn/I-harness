# ContextEngine R2E — shared admission and durable soft-reduction acceptance

Accepted2026-10-18 through product commit `9fb933f69627b015c086472bd2533e7ff7c8e0f2`, following fresh full-range review and two scoped correction rounds by the original reviewer. Task BASE is `221051b2630de429038fe04900122e757f55711d`; initial implementation is `be124adb666320fd1984c964463a9bb88bce1d7f`, fix1 is `21ab4c31b39cf0d2d9621326c9289cdf8218dc2f`. This accepts the connected E task, not the whole ContextEngine branch, renderer build or release.

Normative contract: [E plan](../superpowers/plans/2026-10-18-context-engine-r2e-admission-activation.md), [admission policy](../superpowers/specs/2026-10-18-context-engine-admission-policy.md), [framework](../superpowers/specs/2026-10-15-context-engine-framework.md). Product version remains0.1.13-rc.1. Original decomposition remains27/43.

## Delivered behavior

- The shared capacity/final-candidate owner is connected through actual main/recovery/summary, isolated and inline approval, title and media callers. Independent input/shared-context/output/body dimensions stay distinct. Honest unknown/compatibility cases do not become zero or healthy percentages.
- A real numerical output-cap change prepares, validates and prices the actual derivative B, even when a custom derivative returns the same object. An unchanged numerical cap avoids redundant derivation without bypassing original validation. Explicit/raw/ambiguous output preferences remain distinct from an unambiguous catalog default.
- Durable soft-reduction start and terminal facts use the existing required source and grouped publication ownership. Consumed before/assessed-after keys, failure counts and accepted-exchange/explicit legacy cooldown semantics survive cold replay. Blocked/no-call work consumes its key while preserving prior failures; genuine provider/quality failure increments once per sequence; confirmed current-target success may reset.
- Stable selected summary configuration/binding participates in work keys without hashing client-object identity or a global settings epoch. Relevant cap/binding changes permit one attempt; recreated clients with unchanged facts and cold reopen do not manufacture new work.
- Complete resolved threshold/target/cooldown/retention/prune/reserve facts also fence held work. They are shared by assessment, key generation, source freshness and final publication admission. A target change cannot publish an old target-ready verdict or clear failures under an unmet new target.
- Closed v2 scalar observations and format9 are connected through real readers. Literal prior format8 is readable and upgrades through the existing header-only owned path, preserving metadata, body and unresolved execution state. Future versions still refuse.
- Old production comparison/clamping/reduction-target owners are retired. Three existing workspace dependencies and exact lock importer rows were added under E-DEP-01; no external package, audit exemption or reachability reseed. The conditional E-INDEX-01 shortcut was not needed and is absent: raw history keeps canonical validation.

## Review corrections and meaningful regressions

The fresh reviewer read the entire initial142-file range and independently reproduced three Important failures: format8 public decoding, format8 owned upgrade/reopen, and zero-call blocked summaries being persisted as failed. Fix1 closes all three and the adjacent public migrate(8,9) path. Nonempty literal8 controls include admitted input, generation/preparation, unresolved reservation and result-reference facts; later append and future10 refusal are independently exercised.

Root's connected key concern was reproduced: changing only summary output cap after a blocked consumed key did not permit work. Fix1 introduced stable selected-summary facts and actual cap/binding/cold controls. The scoped reviewer then found a new regression in that fix: the replacement held-source identity omitted the prior reduction-policy members. Its controlled target `.7→.01` example installed target-ready and reset failures1→0, although a fresh assessment was input225/B2500/target25/targetReadyfalse.

Fix2 restores the complete resolved-policy fence. The same mutation is exercised while the actual summary stream, final full-candidate preparation and optional publication admission are held. Each now uses the original sequence, two bounded summary calls and one publication issue; it returns reduced-over-target with failures1 live/cold and the current assessed after-key. Unchanged policy still legitimately reaches ready in one call. A held reserve change is assessed with the new B500/target350.

The actual issuance control exposed a cleanup interaction: a trusted precondition-stale refusal before issuance canceled the running soft source before the reducer's bounded recapture. E-FIX2-01 narrows cleanup only for the captured `{kind:'not-issued',code:'FACT_PRECONDITION_STALE'}` outcome. It closes that optional publication source while keeping the original sequence; backend-proven absence still cancels, and issued/unknown stays original-key reconciliation. A thrown same-code hint remains recovery-required/pending, with no issue or rebuild. An actual JSONL unknown receipt through Stop confirms one original issued batch/rewrite/terminal and no reissue.

The original reviewer approved fix2 with no new Critical/Important finding. Original I1–I3 and RootC1 closures remain intact. Final review SHA256: `e1afe5e05f6c5665d1777b568c4b6b121f711b4d5d4dc2696d2873f536ae1841`.

## Verification and source timing

These are distinct, overlapping scopes, not an additive whole-program test total. Full raw receipts and failed/setup runs remain in the local task evidence workspace `.superpowers/sdd/2026-10-18-context-engine-r2e-admission-activation/`.

| Evidence scope | Recorded result and limit |
| --- | --- |
| Initial connected E | Engine71; core-session400; token50; seam142; compaction195; guardian100; title16; provider-runtime92; JSONL117; persistence152; SDK93; query52; executor414; Desktop32;20type scopes and audit. Counts describe each actual source-timed run. |
| Growth repair | Original30s controls pass at21.289/16.596/15.620seconds. The90s/profile runs are diagnostic only. Measured redundant no-op-cap derivation was removed; full raw validation remained. |
| Fix1 owners | core-session403/JSONL119/persistence152/ContextEngine71/compaction206; connected42; final soft/cold11; four growth controls; seven types/audit. Full206 precedes a test-only cold-client reinforcement; final11 and copied120 include it. |
| Fix2 owners | fullcompaction217 before a later test-only forged-hint addition; final held12 and copied78 include it. Connected43 includes actual JSONL unknown-receipt controls; four types/audit pass. No full218 result is claimed. |
| Actual copied/runtime controls | Initial132, fix1 120, fix2 78, each bound to its own build. Gateway/CLI normal, malformed, no-progress, cold reads and subsequent input; actual SDK Stop/reentry. Source/copy equality does not qualify unexecuted branches. |
| Read/upgrade behavior | Literal8 public/migrate/owned paths, exact2300-byte body preservation, raw metadata and generation-state preservation, owned append, current9 read/future10 refusal; zero read transports. |

Final copied SDK Stop observes three handoffs/reservations/turn ends and two acceptances, with no tool dispatch and usable later explicit input. Complete Gateway summary publishes one replacement; malformed two-round output publishes none. The constant-small-usage calibrated no-progress negative remains blocked with zero rewrite/retirement. All are isolated synthetic controls; no live-provider/account/profile or historical-incident reproduction claim.

Root independently verified final2584 raw/Git-filtered source inputs,9338artifact files,1082production copy pairs,13reconstructed AST test transformations and63actual copied imports with0errors. Both builds match9fb933f6 with no source delta. Both production distributions stayed unchanged; exactly one QA Vitest results-cache addition is classified.

## Immutable evidence identities

| Delivery/check | SHA256 |
| --- | --- |
| Initial360-file seal | `862e25181b9cd00878ef536faee0433415f3001a00cb474a2d19599b770e1296` |
| Fix1 169-file seal | `3ff5e5fdc2be83c7ddb3bccdac70bffa2e4fdf9f63f993daa6d348edd2070a18` |
| Fix2 127-file seal | `d82a4abdd8114717b53f1c755d0535160323c05ef9787a1eb8f7d123f571e911` |
| Final fix2 report | `093cd5e22bea21f56c5ddf4ccdb4e4c607c864404699d3fed31e52fcf1cabf50` |
| Root final source/copy verification | `e5ea09e3173ee085c04bdb93bb741efcc68d536da4affbd79bfb08ebd596120d` |
| Root all closed-set/prior-artifact verification | `00a0493f03d1bd6bb2157d66c08ab899de8bae11cfcc11ad8670ad1e25b3e656` |

Root verified all original360/fix1 169/fix2 127 closed files,18693 prior artifact files and six prior review/probe files unchanged. First failed verifier receipts remain: one mishandled the literal absent marker for deleted inputs; another compared aggregate sealed-file bytes to the JSON manifest file's own length. Corrected separately named verifiers passed; neither was a product defect, and no failed evidence was overwritten.

## Retained limitations and next work

Renderer build still fails at the Node `util/types` browser-external boundary; proper dependency repair is R5. Missing copied MCP SDK sourcemaps, prior `typescript.js.map` ENOENT and36dynamic-TypeScript-import build warnings remain visible; unexecuted import paths are not qualified.

Initial broad core-agent evidence remains367pass/39fail/one unhandled versus exact BASE360pass/same39fail/one unhandled, with actual stacks retained. Selected provider2, subagent4 and route2 baseline failures remain. Earlier Gateway452pass/56fail versus BASE455pass/53fail has52shared names, one BASE-only observation and four current-only growth/v1 differences later fixed by focused controls; no new complete Gateway total or established intermittence claim is invented. The executor's earlier13assertion failures and two cleanup unhandled errors remain distinct from its later414/414/no-unhandled run. Same names and unchanged source do not qualify hidden blocked paths.

R4A actual retained results, R4B semantic seed/bootstrap, R4C delivery/epoch, R5 recovery/observation/decompositions and R6 streaming archive/cold/history paging plus whole-product/release qualification remain required. The new [R4A plan](../superpowers/plans/2026-10-18-context-engine-r4a-retained-results.md) must use accepted E interfaces before dispatch. Broader event-driven/instruction work and unrelated decomposition remain paused. This E acceptance is a development checkpoint, not a merge or release approval.
