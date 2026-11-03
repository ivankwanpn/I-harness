# R2D native protocol validation verification

2026-10-16. **Task approved through `31d35024fbaaf5448e48edf481142197edb9d431`.** BASE `dc4a11f2513096bbe6cfc069231611bd4fc91a75`; initial product `a1852693`; fix1 `4527842f`; fix2 `31d35024`. Fresh full-range review found five Important defects. The original reviewer closed four after fix1 and the remaining compatibility regression after fix2, with no new Critical/Important issue in the correction range. Product remains0.1.13-rc.1; session data format is5; original decomposition remains27/43.

Contract: [R2D plan](../superpowers/plans/2026-10-16-context-engine-r2-native-validation.md). This completes the three remaining built-in final protocol validators after Responses/public+subscription and Chat. It does not complete R2E capacity policy or R3 transactional compaction.

## Actual delivery

Anthropic Messages, Gemini generateContent and Bedrock Converse now validate the selected final lowered HTTP body or typed SDK command before description and on every cap derivative/restoration. Existing prepared-payload, execution confirmation, freshness and acceptance-before-tools owners remain. Unknown/custom capability and unverified limits stay explicit; a final-protocol report is not a promise of upstream acceptance.

Adapter-owned checks cover supported envelopes, ordinary tool-call/result pairing, native order/compatibility, scoped capabilities and generation fields. Gemini shares a narrow read-only ProtoJSON interpreter across validation and description: optional null, supported aliases and exact numeric forms preserve their original wire values. Known malformed values cannot hide behind an allowlisted field name. Converse counts supported images/documents across the entire containing message, including tool-result siblings, without scanning arbitrary JSON for image-like keys.

Neutral tool-media mapping preserves original bytes and outcome. Anthropic uses supported native result blocks; Gemini uses documented error wrapping and sibling-safe image companions; Converse chooses native status/images only with applicable evidence and otherwise uses truthful result annotations/companions. Raw caller histories are validated, not silently repaired. Actual nested-image measurement defects in Converse and raw Gemini FunctionResponse media have regression controls.

Anthropic/Converse continuations carry optional bounded version1 producer witnesses from the actual selected execution/fold. Their fields distinguish thinking/effort/effective beta and preceding-message versus system/tool surfaces. One strict core-session primitive serves persistence and route-explicit pre-snapshot ingress; generic/custom clients are not given an unrelated Session-event gate. The existing stack-safe serializer has actual native binding/fold consumers. Witnesses do not establish signature authenticity or account authority.

Format5 fences the new metadata before issuance through existing readiness owners. Append, staged/cold validation, serialization, snapshot and seed/fork preserve valid witnesses and reject malformed/future versions. Formats1–4 remain readable without fabricated historical proof; seed validation uses the current version rather than literal3. Exact archived old4 refusal before repair/write is exercised.

Self-review additionally repaired the scoped ordinary manual-thinking minimum used by the current summary owner. One private final-wire logical-turn reader now handles Anthropic same-role merging: companions cannot hide within-turn drift, and later non-interleaved tool-only responses need not repeat the initial thinking block. This does not rewrite the request or infer provenance from attachment labels.

## Independent findings and closure

1. Gemini used request-wide native preservation to mask another assistant's opaque-only loss. Preservation/loss is now checked against the corresponding source/projected/actual assistant and conservatively aggregated; legitimate portable degradation remains unverified.
2. Anthropic rejected documented null user_id/effort. Field-specific null originals/derivatives/restoration now remain legal; tagged effort identity stays explicit.
3. Gemini interpreted null IDs as absent initially but later paired raw values. One interpreted ID now drives duplicate detection, pending capture and result matching; absent/null permutations remain legal and genuine ambiguity rejects.
4. Supported generation/enum fields lacked value checks. The scoped fix checks applicable known types/enums/envelopes and preserves ProtoJSON forms. Its first correction overrestricted schema MIME to JSON, which independent re-review caught. Fix2 preserves the first-party text/x.enum STRING-enum mode and partial coverage for unknown schema details/future MIME combinations.
5. Converse media totals omitted native tool-result images. The containing-message accumulator now covers supported top-level/nested positions, multiple result siblings and the same sourced document limit, while arbitrary JSON remains data.

Reports/diff packages are retained in `.superpowers/sdd/2026-10-16-context-engine-r2-native-validation/`. Reviewers used targeted controlled probes for unresolved code doubts; they did not rerun whole suites to regenerate evidence.

## Verification

Exact launchers/exits and retained RED/intermediate failures are in `.tmp/context-r2d-validation/`, especially `final-exits.jsonl`, `fix1-exits.jsonl`, `fix2-exits.jsonl` and the task report. Vitest scopes were sequential with maxWorkers2/minWorkers1. Counts overlap and are not a unique aggregate.

| Scope | Latest applicable passing evidence |
|---|---:|
| Anthropic / Gemini full |159 /165|
| Converse full / later media controls |99 /10, with8 overlapping and2 additional|
| core-session / persistence / JSONL |278 /133 /35|
| llm-seam |130|
| main full selected / later amended controls |60 /11 /9, overlapping|
| compaction full / amended controls |152 /24 /1, overlapping|
| six-route corpus |81|
| selected executor / SDK |43 /30|
| unchanged applicable subagent / query / context-engine |283 /38 /34|

Twenty affected consumer type scopes and e2e passed initially; amended adapter/main/summary/Gateway/CLI/e2e scopes were refreshed for the corrections. Exact reachability remains406 rows with digest `6f6445aeb2059dacfca8a81879184fb39aeee38a607ddd7b5bcb4f24ca6f05a7`;82 application-reachable packages and0 production cycles. No audit reseed, fake consumer or unrelated API retirement. Named retained large owner functions are disclosed in the task structure report; no new function exceeds120lines, and new helpers remain cohesive protocol/data leaves.

Meaningful RED/GREEN covers direct/group/native/media failures, strict ingress removal, actual selected native arguments at depths2000/6000, final signed-block/input mutation, format/seed serialization, scoped raw thinking floor and final-wire logical turns. Fix1's malformed-value/native/null/ID/count regressions and fix2's enum compatibility have permanent tests. Failed fixture/harness attempts remain distinguished from product REDs. No timeout/readiness/receipt assertion was weakened to manufacture a passing baseline.

The corpus represents132,018,224 JSONL-equivalent bytes/302events projected to2messages and actual six-route packets253–452bytes. This is an in-memory projection/send oracle, not a cold-load, performance, tokenizer-accuracy or live-provider result.

## Packaged evidence

Fresh final artifacts are `.tmp/context-r2d-fix2-final-gateway` and `.tmp/context-r2d-fix2-final-cli`. Earlier44/45-source and fix1 artifacts remain preserved and qualify only their recorded source. Final source manifest covers46 affected production files. The original reviewer independently verified all46 current-source/copy pairs and the final CLI SHA256 `da547623a01fb91ac4eeec8a90864e3231bcfe3e51130256da2ea65f579845f8`, with zero mismatches.

Applicable packaged controls include exact malformed direct/main/summary/CLI no-send/no-effect cases, legal null/ID/numeric/enum alternatives, native selected derivative/fold/replay, logical-turn handling, containing-message media boundaries, actual format5/cold/seed/fork and body-exact historical migration. Archived exact old4 rejects5 before repair/append with unchanged bytes. Fix1's base/finding probes observed12/13 controlled positive sends; final fix2 observed9 legal controlled sends and zero effects/compactions. These are separate scoped probes, not an upstream-attempt total. All negative-case transport counts remain unchanged.

CLI distribution verification passes. Headless smoke injects copied Gateway clients into the actual bundled public runHeadless seam; it does not qualify bundled provider-resolver construction, installed Desktop/renderer, accounts, native authenticity or live APIs. Other-platform copy skips, plugin-default warnings,36 dynamic TypeScript import warnings and the selected spill-GC ENOENT remain disclosed.

## Open qualification work

Executor full remains293pass/12fail; SDK full91pass/1fail. All named failures have exact-BASE receipts; one teammate case is scheduling-sensitive and passed once before reproducing alone. Root independently checked912 archived production blobs,6 unchanged failing fixture files and393 internal links against BASE with0 mismatches and no test reruns. This validates experiment provenance, not that timing cannot worsen or every future change is unrelated.

The observed child initial-prompt durability error and delayed-flush parent-state timeout are explicit F1/consumer gates. Earlier six B2 BASE core-agent failures and prior full verify:all FAILED/incomplete remain R6 concerns. Scoped passes do not waive them.

Unknown/custom capabilities remain partial; ambiguous byte units are not invented limits. Claude cache-only max_tokens0 is outside IH's retained positive-generation support, not universally invalid upstream. Count calibration, account portability, final admission policy, durable compaction, bounded cold memory and full release readiness remain later gates. The next connected implementation is [F1 managed ordinary facts](../superpowers/plans/2026-10-16-context-engine-r3-managed-facts.md), followed by replacement readers/publication and the remaining approved redesign.
