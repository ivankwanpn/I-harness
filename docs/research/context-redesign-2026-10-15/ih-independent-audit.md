# Independent challenge of IH context probes

Read-only audit, 2026-10-15, confirmed HEAD `81bca938a750b73bce6bebc02219ae2665b7e47e`. Inputs: `.tmp/context-redesign-20261015/probes.ts`, its recorded `probe-results.json`, and current implementation. I did not rerun or edit the probes, call providers, inspect profiles, run broad tests, or modify product files. All local source paths below are relative to `D:/I-harness-main/` unless written in full.

## Main judgment

The observations expose real architectural inconsistencies, but several stronger interpretations would be false positives. IH already has protocol-specific prepared requests, hard token admission, durable single-retry provider-context recovery, summary request admission, output-cap capability facts, continuation checks, append-only compaction, and bounded shipping child reports. A redesign should unify these existing owners rather than assume none exists.

| Observation | Independent assessment | Priority / limitation |
|---|---|---|
| Legacy `/4` versus prepared accounting | Real, shipped dual domains. Legacy means JS characters/4; prepared uses ASCII/3, non-ASCII UTF-8 bytes/1 plus protocol-specific material. | High: policy/action/effectiveness disagree. Does not prove main prepared gate uses the legacy count. |
| Prune-only reports success while above canonical auto threshold | Real reachable policy inconsistency. Probe's standalone engine path is the same implementation used by core-agent. | High: premature success and inconsistent hysteresis. Main agent re-prepares after mutation, so this is not a demonstrated hard-admission bypass. |
| Current human input shadowed under default retention | Real shipped ordinary preflight-compaction behavior. No protected current input is passed there. | Highest semantic risk. Explicit provider-error recovery does protect the current turn tail. Probe shows loss of verbatim input, not that every live summary necessarily loses its meaning. |
| Summary `maxTokens` enforced as `chars*4` | Real cross-domain contract mismatch; code explicitly tells model a character ceiling. | Medium-high. Probe's 12,288 is conservative projected tokens, not measured provider tokens; custom summary stream need not honor output caps. |
| Sensitive-instruction prefill selects arbitrary tool text | Real provenance collapse. Shipping renderer uses role-free search text to prefill a section explicitly described as user instructions. | High semantic/authority risk. Probe establishes misclassification, not a measured live prompt-injection success rate. |
| Moving Anthropic cache markers invalidate calibration | Source-confirmed for protocol projection calibration when automatic markers move. | High availability/efficiency risk, conservatively falling back to heuristics. Signed-thinking prefix integrity uses a different pre-cache fingerprint and is protected. |
| 100+ MiB archive produces tiny request | Valid separation demonstration, already true in IH. | Does not benchmark JSONL resume, memory scaling, crash reconstruction or actual provider acceptance. |

## 1. Existing admission is a material mitigation

`core-agent/src/agent/admission.ts:20` prepares the real adapter request; `:24` assesses the owned budget; `:44-59` may compact; `:61` rebuilds after a mutation or `result.compacted`; `:64` rejects remaining `admission === "compact"` before transport. `:68-76` rechecks binding/history and recovery at the physical boundary. Rebuilds are capped at three, and `state.compacted` prevents another ordinary compact attempt in the same admission.

`core-agent/src/agent/budget.ts:40-63` reserves output and margin from protocol-specific input facts, only claims an applied output derivative where supported, and distinguishes incomplete coverage. `:19-25` refuses stale budget reads after history/revision/model/config changes. `:76-91` records accepted samples and marks the old snapshot unavailable until next projection. `token-meter/src/checkpoint.ts:16-38` anchors reported input to a prefix and prices only projected suffix; hidden total generation is intentionally not automatically replayed.

Therefore a report saying “IH always sends the legacy 4-char estimate to providers” would be wrong at this HEAD. The actual problem is that **compaction's policy and completion decisions remain legacy-based while main transport admission is prepared-based**. These two layers can make inconsistent decisions, yet the final gate still exists.

Likewise, outputCap configuration is not necessarily the actual next wire cap. `ownedBudget.assess` can lower a supported output cap to available room. In the probe, initial pressure equals exactly 100,000 partly because the cap was reduced to fill room; it is not 100,000 unbounded input tokens. The threshold comparison intentionally uses input + effective output reserve + safety margin because `budget.ts:35` defines pressure that way.

## 2. Dual accounting and prune-only completion

Legacy implementation:

- `token-meter/src/estimate.ts:5` defines CHARS_PER_TOKEN=4, prices JS string length, and uses a fixed 1,024/image.
- `token-meter/src/estimate.ts:12` does not count assistant thinking/continuation metadata.
- `token-meter/src/breakdown.ts:15` prices `deriveMessages(session)` with that estimator.
- `compaction/src/engine/prune.ts:39` prices a hypothetical prune by calling this legacy activeTokens.
- `compaction/src/region.ts:128`, `:143` select retained tail using `deriveSearchText` and approximate text counts, rather than actual provider projection.

Prepared implementation:

- `token-meter/src/projection/pricing.ts:5` charges ASCII/3 and non-ASCII UTF-8 bytes/1. Its comment explicitly identifies a conservative heuristic, not provider tokenizer.
- `token-meter/src/projection/measure.ts:19-55` counts components and framing, with uncertainty for media/opaque data.
- `llm-anthropic/src/context.ts:19-32` includes actually replayed thinking and tool blocks.

The recorded 4,283 legacy versus 64,511 Anthropic projected count combines multilingual conservatism, different framing/system/tool schema treatment, and replayed reasoning. It does not measure a true provider-token undercount of exactly 15×. The fixture's thinking signature is synthetic and has no real backend provenance; prepare accepts legacy continuation-free thinking here (`llm-anthropic/src/request/messages.ts:40-53`). The presence and estimator omission of real signed thinking are nevertheless reachable: accepted main responses persist thinking and continuation (`core-agent/src/agent/finalization.ts:50-58`), and matching continuations replay in the same adapter. Production continuation checks can drop incompatible reasoning; the fixture is not evidence that every route replays this synthetic reasoning.

The mismatch at the prune decision is exact:

1. `core-agent/src/agent/context.ts:79` supplies `ownedBudget.pressure()` to the compactor.
2. `compaction/src/index.ts:127` uses that callback for initial pressure.
3. `compaction/src/engine/commit.ts:37` decides prune-only success using `surfaceTokensAfterPrune + legacy overhead`, rather than re-preparing the candidate under the original owner.
4. `compaction/src/engine/admission.ts:79` also determines sticky post-success state using `safeActiveTokens + overhead`, again the legacy domain.

The probe's final canonical pressure 92,251 is below the 100,000 hard window but above the 80,000 auto threshold. It correctly shows that “compacted” does not certify threshold relief. It does not show an over-window network request. In the ordinary agent, a `fit` request goes through maybeCompact (which permits prune-only); a hard `compact` request instead invokes `compact()` with allowPruneOnly=false (`core-agent/src/agent/admission.ts:53`; `compaction/src/engine/admission.ts:99`). That is another reason not to extrapolate the probe to a hard-overflow bypass.

Other existing mitigations: pruning preserves originals, uses head/tail substitutes, refuses same/looser repeated carving, and checks actual byte-removal provenance (`compaction/src/engine/prune.ts:12-34`). This is not raw data deletion. Sticky/re-fire/hysteresis/circuit-breaker gates prevent some repeated work, though their pressure/effectiveness assessment still uses a different count. Main re-admission can fail closed after a mutation whose newly invalidated calibration falls back to a larger heuristic; the report should call that an availability issue rather than silently unsafe admission.

Architecture: one owner should evaluate a candidate projected request, return measured before/after evidence and policy status, and commit a selected rewrite. Distinguish “changed”, “threshold relieved”, “hard-fit certified” and “no further reduction”; a single `compacted:true` is insufficient. The compaction engine should consume a candidate assessor rather than a scalar callback that cannot price its own proposed rewrite.

## 3. The latest human input is not structurally protected in ordinary compaction

`core-agent/src/agent/turn.ts:25-38` appends turn/start and current user/message before any model admission. `admission.ts:53-54` passes `{signal}` to ordinary compact/maybeCompact, without protectedSeqs. `compaction/src/config.ts:126` defaults retainTokens to zero. `compaction/src/region.ts:131` then selects every active nonmarker event, including current user input. `engine/commit.ts:29-33` only constrains selection when protectedSeqs were actually provided. `:72` commits a summary shadowing those input seqs; `core-session/src/projection/messages.ts:218-220` sends that summary as a user-role message.

This is reachable in shipped assembly: `apps/cli/src/index.ts:477` sets compact auto policy, `session-executor/src/assembly.ts:1518-1525` binds the known window, and `subagent/src/child/assembly.ts:104-105` enables default compaction for known-window children. This is not solely an independently constructed engine seam.

The probe's mocked summary omits the unique current input. It proves the engine accepts a valid-sized checkpoint that omits it, the raw event survives, and the next main request lacks the original bytes. It does not measure whether a live model would have included those bytes or preserved the request semantically. The normal template asks to preserve objective/authority/instructions but does not validate that promise. Given the current input has not yet been answered, replacing it through an unverified summary is a significant semantic failure mode even if storage is append-only.

Important boundary: **provider-error recovery already protects it**. `core-agent/src/agent/recovery.ts:76-79` finds the current turn's first user message and protects the entire tail. `:34-41` requires changed projection fingerprint, lower projected input cost and nonincreasing bytes under the same binding/shape. `:64-81` permits one compaction and one main retry, persists retry consumption, and blocks ineffective or repeated recovery. This protection cannot be described as missing everywhere; it is missing from the ordinary preflight policy.

Architecture: accepted human inputs, plugin context, child reports, tool evidence, summaries and operational control events should have explicit provenance and retention obligations. A compaction transaction should preserve the unresolved input/tail exactly, summarize only eligible older context, and verify selected seq coverage. This is distinct from a configurable retainTokens tail estimate.

## 4. Summary retention versus actual model budget

`summarizer.ts:208`, `:241`, `:328`, `:335` consistently enforce a character ceiling `maxTokens * 4`. The prompt explicitly names characters. This is an intentional old retention convention with misleading token-shaped API naming, not a single accidental missing tokenizer call. `config.ts:38` distinguishes summaryMaxOutputTokens from retained maxTokens. The 4,096 CJK characters accepted for maxTokens=1,024 consume 12,288 units under current conservative prepared text pricing; they are not proven to consume 12,288 real provider tokens.

The probe calls summarizeWithModel with a custom stream-only client returning synthetic output. Such a client can ignore requested caps; this isolates retained-summary acceptance, rather than proving a production adapter violates its wire cap. A real summary uses an independent prepared path (`summarizer.ts:254-285`), own binding/limits (`engine/summary.ts:43-49`), output-floor checks, model ceiling, optional fixed-input splitting, explicit 5% reserve and shared max 8 calls. It rejects refused, truncated or incomplete responses (`:322-324`) and rejects too-short/too-long outputs after one quality retry (`:238`, `:328-335`). It does not lossy-slice a checkpoint.

Those safeguards are meaningful but do not make retained chars a canonical request cost. A character-valid checkpoint can exceed the intended retained token allocation and create another main admission/compaction problem, especially with CJK, code, escaping or a smaller target model. Conversely the conservative estimator can greatly exceed true token usage, so silently replacing maxTokens with that estimate changes retention quality substantially.

Architecture: name units explicitly (characters, UTF-8 bytes, estimated target-model tokens, actual output tokens). Validate retained checkpoint cost against the *continuing target binding*, separately from the summarizer's generation cap and summarizer-input admission. Preserve a semantic quality floor and typed mandatory facts; do not conflate the output cap, retained size, and full-window reserve.

## 5. Sensitive prefill loses origin

`summarizer.ts:10` defines lexical imperative markers. `:132-143` scans every line without role/source information; `:120-125` copies matches into the Sensitive Instructions template. The template's guidance explicitly calls them “user instructions” (`:31-32`). Shipping replayText originates in `compaction/src/projection/shadowed.ts:21-66`, using `deriveSearchText` over selected events. `core-session/src/projection/search.ts:28-38` serializes tool-result text without an external/source trust distinction. Prune substitutes also enter this role-free string.

Therefore a webpage/tool/assistant line containing 不要/改成/remind can be promoted into the user-instruction preservation section. The pure buildSummaryPrompt probe uses a manually prefixed `[tool]` string, but actual output need not have that prefix; it travels through the same untyped string extractor. Inherited-prefix summaries also use this same prefill even with embedText=false (`summarizer.ts:91-104`, `:240`), so retaining native role messages in the original prefix does not prevent this second classification.

Existing mitigations: original tool-role messages can remain distinguishable in inherited prefix; the template does not mechanically grant system authority; a live summarizer may recognize untrusted content; original evidence remains stored; and the summary is projected as user rather than system. None fixes the explicit host-authored mislabeling. This is a source-proven authority/provenance error, not proof of a particular live attack succeeding.

Architecture: instruction preservation should consume typed source spans of accepted human/developer instructions, with origin and exact wording. Summarized facts and untrusted quotations must remain attributed evidence. Keyword matching can help discover candidate text but cannot manufacture source authority. Summary checkpoints should preserve the distinction on replay.

## 6. Anthropic prompt-cache markers invalidate accepted calibration

This issue has two separate fingerprint paths:

**Signed continuation integrity is protected.** `llm-anthropic/src/request/body.ts:89-108` builds `body` before `payload = applyPromptCache`; `llm-anthropic/src/client.ts:57` computes the response continuation prefix from body, not payload. `request/messages.ts:40-60` checks model/source/prefix/tool bindings before replaying signed reasoning. Do not claim moving cache markers invalidates signatures in this path.

**Owned token calibration uses the cache-decorated payload.** `client.ts:27` calls describeContext(payload). `llm-anthropic/src/context.ts:51` passes the full wire message to `counter.unit`. `token-meter/src/projection/measure.ts:53-58` hashes that entire value, including content blocks' cache_control. `context.ts:61` hashes decorated system/tools into shapeFingerprint as well. `checkpoint.ts:30-31` invalidates the anchor when an old unit fingerprint or shape differs.

Automatic cache policy marks the latest user content block (`request/body.ts:55-70`). On a tool continuation or new user turn, the marker moves to a later user-shaped message; the previous anchored message returns to its undecorated form. Besides deleting cache_control, strings can change from an array containing marked text back to string content. Thus semantically unchanged prefix content differs in the calibration chain. The next estimate discards provider input observation and falls back to a conservative heuristic. Appending assistant-only content without a new user-shaped message need not move the marker. Cache-disabled/absent routes do not have this automatic movement; this finding should be scoped to enabled policy or relevant option changes.

The coordinator's updated offline result independently confirms this path: with the same synthetic accepted usage of 200, cache off preserves the first-unit fingerprint and calibrated estimate 239; automatic markers change that first unit and return uncalibrated heuristic 708 while shape remains equal. These numbers validate anchor lifetime, not real backend token consumption or performance.

Costing already separates cache metadata from token content (`measure.ts:62-65`), which is directionally correct, but identity does not. Provider usage normalization correctly includes cache read/creation tokens according to declared semantics (`token-meter/src/calibration-usage.ts:9-17`); cached input is not discounted from context capacity. This issue is therefore calibration stability, not arithmetic subtraction of cached tokens.

Architecture: semantic projection identity, signed wire-prefix identity, cache-layout identity and serialized-payload identity require distinct contracts. Generate calibration units from semantic pre-decoration blocks while separately tracking actual wire bytes and cache markers. Preserve user data fields literally, including a tool argument/schema named cache_control; generic recursive key stripping is unsafe. Include binding changes and token-relevant options in calibration identity, while harmless cache breakpoint movement should not erase a valid semantic-prefix observation.

## 7. Forks, child results, archives and remaining cautions

IH already filters parent context usage/recovery events from child seeds, remaps seq references for partial forks and materializes required image admissions (`subagent/src/fork.ts:38-49`; `session-persistence/src/fork.ts:194-225`). Child default is no fork (`subagent/src/child.ts:26`), and selected seeds are assembled into a separate session (`:53-71`). All-context forks still copy raw parent event seeds; existing summaries make their active projection smaller, but this is not Codex's paginated latest-model-context loader. Child admission rechecks its own model/window and can summarize inheritance. Do not infer that parent calibrated usage is blindly inherited as child context truth. The updated explicit-all probe confirms 132,018,505 JSON-equivalent event bytes copied into the seed while only two active messages survive; this is a storage/memory inheritance concern, not automatic 132 MB provider transmission, and does not apply to default no-fork children.

Shipping report policy is already substantial: `subagent/src/report-policy.ts:6` sets 2,048-byte child previews and 16,384-byte total reports; `:43` budgets final JSON and paginates with generation/digest checks. `task-notification.ts:90-109` retains full results and injects bounded notifications; assembly wires SHIPPING_REPORT_POLICY (`session-executor/src/assembly.ts:1219`, `:1408`). Codex's uncapped success-result completion is not evidence of an equivalent IH shipping weakness. Multiple bounded child reports can still accumulate; they must participate in parent admission and retention.

The recorded >100 MiB archive probe creates in-memory events and an explicit summary shadow marker, then measures deriveMessages + prepared packet. It demonstrates that raw archives and active requests are already separate in IH (132,018,505 raw JSONL-equivalent event bytes versus 467 body bytes), but excludes reading/parsing JSONL, cold startup, migration, seq validation and durable checkpoint retrieval. A claimed “IH cannot handle 100 MB sessions” is too broad; the actual failure surfaces require measurement of loading, projection, admission and physical provider rejection separately.

The coordinator added a persisted-orphan tool-result probe: actual Anthropic prepare accepts a 399-byte packet without transport. Source corroborates the gap: `core-session/src/projection/messages.ts:225-232` collects a result unless its ID was explicitly suppressed; `llm-anthropic/src/request/messages.ts:28-34` emits it as tool_result without verifying a matching prior tool_use. Existing folds suppress failed/unresolved calls (`messages.ts:122-151`), and compaction walks cuts to avoid separating valid pairs (`compaction/src/region.ts:88-111`). Thus the orphan fixture proves **absence of a universal final protocol invariant guard for malformed/resumed input**, not that normal current tool producers create orphans. Pair validation belongs at replay acceptance and final protocol projection, with explicit recovery semantics, rather than a serializer silently dropping evidence.

Several historical comments describe reset fallback or cache-prefix behavior that current source no longer implements. Example: `subagent/src/child/assembly.ts:87-103` says indivisible summary failure can fall back to a reset; actual core-agent admission and recovery do not automatically call resetWindow. Treat comments as context, not execution evidence.

## Prioritized coherent design

1. Establish one owned **candidate request assessor** for main, summary, prune, retained-checkpoint validation and changed-input recovery. It must report semantic estimated tokens, uncertainty, route-applied output reserve, safety reserve and actual/estimated physical packet bytes. Distinguish policy threshold from hard fit and include the target binding/generation in every certification.
2. Make compaction a validated projection transaction over typed eligible spans: unresolved human inputs and current tool transactions stay exact; older evidence can be summarized; provenance/authority and durable references survive; candidate effect is measured before commit; later concurrent inputs are not overwritten.
3. Separate cache transport decoration from semantic calibration identity without weakening signed continuation or schema/argument integrity. Keep provider observations scoped to binding, semantic prefix and rewrite generation; invalidate for actual semantic edits, not merely a moving marker.
4. Give summaries explicit unit contracts and target-model budgets. Preserve checkpoint quality and required semantic facts, retain raw evidence, and leave pending input intact when no viable checkpoint fits. Use one bounded physical-call budget across summary retries/splits and recovery rather than several overlapping success booleans.
5. Extend existing durable recovery and bounded report/artifact machinery instead of rebuilding ad hoc counterparts. Validate archive replay equivalence and cold-load cost independently of provider request size.

This audit confirms the important design gaps while rejecting the claim that the existing probes alone prove a main token-admission bypass, real provider-token ratios, universal summary loss, or missing child-output retention. The remaining live HTTP400 causes require redacted physical request/error evidence, not more arithmetic inferred from archive size.
