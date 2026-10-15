# ContextEngine R2D — native protocol validation and producer compatibility

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans. Steps use checkbox syntax for tracking.

**Status:** Ready after reviewed R2C through2ee26aa4d18f01f443d01fad43387682b0efac95. Root has fixed the bounded witness/capability/ProtoJSON contracts and rebased the actual C API below. Ledger records the subsequent documentation BASE before dispatch. One product writer only; no D product work has started yet.

**Goal:** Give Anthropic Messages, Gemini generateContent and Bedrock Converse actual final-body validators, preserve native replay with attributable producer compatibility, and replace the three transitional unvalidated built-in reports.

**Architecture:** Each adapter owns its grammar/capability/native checks. Existing core-session continuation carries bounded versioned compatibility metadata; the actual selected prepared invocation produces it and the same adapter consumes it. Existing persistence/readiness owns the version fence. C's seam owns reports, safe errors and confirmation composition. No new history, auth, tool-execution, retry or admission owner.

**Evidence:** approved ContextEngine design/framework; pinned0024423d preflight `.tmp/context-redesign-20261015/r2d-final-preflight.md` and its addendum, followed by `r2d-root-rulings.md`. Source-contract facts below must survive the reviewed C rebase. Primary source links are attached to the corresponding rules; access2026-10-16. No local fixture proves live provider acceptance.

**C API rebase at2ee26aa4:** adapters consume public `FinalValidator<T>` and `validationCollector` from llm-seam; enum/packet/result aliases remain implementation-private, not extra public exports. `createPreparedPayload` takes optional validate(actualBody, discriminatedPacket), checks it before describe/output and retains an immutable sanitized report. `preparedExecution(measurement,control,validation?)` asserts before confirmation. `readPreparedValidation` implements honest custom/D staging. Data codec/coherence live in prepared/validation.ts, error construction/assertion in prepared/rejection.ts; shared provider-error facts/classification and SDK/Desktop consume those results. D extends reason coherence/sanitization for actual size/media consumers without another error owner, then retires built-in staging at each real adapter. Fix1 changed only adapter validation/Chat remote-audio facts/tests, not these seam contracts. Current session format remains4, so D's next fence is5.

## Global constraints

- User authorized continuous R0–R6. One GPT6.1Sol product writer, fresh task review, no recursive delegates. Existing development checkout/version0.1.13-rc.1; no installed profile/account/provider/count calls, remote/merge/release or unrelated decomposition.
- Preserve accepted-before-tools, actual selected payload/measurement/receipt, current snapshot guards and C typed error boundaries. All negative protocol/native cases are no-send and cannot trigger compaction or replay effects.
- Shared semantics do not make native signatures portable. Structure, retained bytes/order, source compatibility, account authority, capacity and upstream acceptance are independent. Never hash credentials or manufacture native/account evidence.
- Use actual final lowered HTTP values or typed SDK command, every derivative. Never reserialize for validation or compare an SDK estimate to an HTTP limit. Unknown capability stays explicit; no blanket model-name/brand inference.
- Leaves normally150–400lines/functions<=120; keep sole state owners/public-entry dependencies. No second native ledger, fake public consumer, audit waiver or reseed. Tests/scripts are not decomposition targets.
- Desktop version and original27/43 remain unchanged. Prior whole verify:all failures, six BASE exploratory failures and CLI warnings remain separate qualification concerns.

## Owner and file map

- Each of `llm-anthropic`, `llm-gemini`, `llm-bedrock`: private `request/{validate,validate-content,validate-native,capabilities}.ts` leaves as cohesion requires; actual client installs the callback. Existing request builder precedence remains route-owned. `context.ts` extracts valid facts after moved checks, without a duplicate validator.
- Gemini may use one private read-only ProtoJSON field interpreter shared by its validator and descriptor for the known emitted/raw-supported fields. This is a protocol reader, not a second body or a global key normalizer; it never rewrites tool arguments/schemas or the actual serialized request.
- Existing native mapper/fold/client/iterate paths: produce and consume witnesses and actual block order. No-call assistant branches and unsigned generic Bedrock reasoning must have explicit preservation/degradation behavior, not accidental field loss.
- Direct neutral tool-media mapping is an actual D consumer: pinned Anthropic forwards neutral image objects unchanged inside tool_result, while Gemini/Bedrock collapse tool-image parts to text placeholders. Add independent actual-preparation RED for declared image-capable clients, then preserve media in documented native positions or adapter-owned companions after complete sibling outcomes. Do not repair raw caller messages, alter tool outcomes or hide a missing sibling; unsupported-vision projection keeps its existing explicit behavior. A shared pure companion helper is appropriate only if it replaces real equivalent adapter logic and preserves route-specific choices.
- `core-session/projection/types.ts` and a data-only native witness validator: narrow union extensions and actual append/load enforcement; SDK/renderer/projector/fork/snapshot consumers retain their existing role. No llm/provider import into core-session.
- Existing persistence format registry/JSONL/backend readiness: next format fence before persisted witness; real old-reader refusal and historical migration. Preserve B2 accepted/usage semantics.
- C seam bounded report/error codecs gain request-size/media-limit only with actual consumers; no separate sanitizer. Main/summary consume the same selected handle without new formula changes.

### Task 1: Replace D transitional coverage with final validators and native producer evidence

- [ ] **Step1: Rebase and establish focused RED.**

Reuse unchanged C/B2 receipts. Inventory actual existing tests before commands. Add mapper-independent literal legal/illegal groups, final raw overrides, signed prefix/order changes and current-mode changes first. Keep formerly malformed measurement fixtures as named validator negatives; where an unrelated measurement test needs valid history, provide real complete literal results rather than weaken closure. No routine full baseline duplication.

Include optional/null/native-reference cases explicitly. C's fresh review found a real regression from treating a documented nullable cap as an invalid number; D must compare actual wire grammar with old accepted behavior instead of assuming a TypeScript optional field forbids JSON null. Preserve each protocol's own meaning and do not transplant Chat's nullable rules universally.

- [ ] **Step2: Freeze capability and witness contracts before source changes.**

Private capability input distinguishes recognized direct Anthropic, Google developer generateContent and AWS Converse surfaces from custom transports. Resolve only documented model IDs/aliases, using the explicit evidence-commented initial table in the appendix. Unknown aliases/custom endpoints receive no model-specific certainty. Do not use the existing broad reasoning-translator regex as capability evidence; optional absent facts mean unknown, not false. This pure resolver has actual adapter consumers and adds no catalog/network/UI owner.

Proposed persisted optional `producerWitness` on corresponding continuation variants:

```ts
type AnthropicProducerWitnessV1 = {
  version: 1; thinkingConfigId: string; effortConfigId: string;
  interleavedBeta: boolean;
  mode: 'absent' | 'disabled' | 'manual' | 'adaptive' | 'between_tools' | 'unknown';
  budgetTokens?: number;
  interleaving: 'enabled' | 'disabled' | 'unknown';
};
type BedrockProducerWitnessV1 = {
  version: 1; messagesPrefixId: string; inputSurfaceId: string;
  callsId: string; callCount: number;
};
```

Digests are64lowercasehex, supported scalars safe and own fields only; unknown witness versions fail. Each complete witness is at most512UTF8bytes, a local metadata bound that the closed fields satisfy at their maximum valid scalar lengths. No arrays/body values are admitted inside it. callCount is a safe nonnegative count of the actual observed response calls, not a newly invented provider call limit; it must agree with the compared source group. This digest/count shape supersedes the preflight's duplicated per-call metadata array. Existing native arrays carry the original bytes. Bedrock witnessed continuations require existing contentOrder even when canonical, covering all reasoning/tool indices and exact visible text; no duplicate order copy. New capture must retain any unsigned generic reasoningText without pretending it has a signed-prefix requirement.

Hash only owned final data in versioned domains: Bedrock messagesPrefixId covers the actual preceding messages array via typed SDK encoding, while inputSurfaceId separately covers system/toolConfig with explicit presence sentinels; callsId covers ordered actual call tuples (explicit ID presence, supplied ID, name and canonical-argument digest). Anthropic thinkingConfigId covers only actual final thinking or explicit absence. interleavedBeta records the fixed interleaved-thinking-2025-05-14 token from the actual merged outgoing beta header; inferred capability/interleaving labels never enter equality identity. Preserve call order and missing-ID distinctions rather than inventing upstream IDs; malformed/incomplete producer bindings cannot produce a checked witness. Exclude unrelated headers, auth, account, request metadata and output cap. Capture in the selected execute invocation after derivative lowering; fold combines that immutable input evidence with actual returned call bindings/order. Completed accepted native responses alone become durable witnesses. Never construct historical proof from today's replay body.

Anthropic effortConfigId is separate: domain messages-effort-v1 over tagged present/absent final output_config.effort, without guessing omitted defaults or hashing unrelated structured-output settings. Effort-only change yields changed/unverified native compatibility while retaining original blocks; it is not a universal schema failure. Thinking-mode drift is also a local preserve/valid-degrade/block decision, not proof that every backend returns400: current official documentation describes silent disabling on some mid-turn mode conflicts. Enforce actual proven invalid mode/effort combinations separately. [Thinking behavior](https://platform.claude.com/docs/en/build-with-claude/thinking), [effort changes](https://platform.claude.com/docs/en/build-with-claude/effort).

Anthropic within-turn comparison uses the actual continuing assistant tool turn, not every earlier completed turn. Identical raw wire facts remain identical when a capability-table update refines unknown to known; producer mode/interleaving labels describe coverage only. Changed beta is incompatible only where effective mode semantics establish it; a documented ignored header does not create drift. Bedrock compares the corresponding preceding final-message prefix, not the entire later conversation. Changed signed preceding messages use the documented incompatibility rule; unsigned reasoning does not inherit it. Equal messages with changed system/tools is partial/native-unverified unless separate applicable evidence proves incompatibility. Legacy missing witness remains unverified. Stale explicit signed order must preserve valid original order or use explicit currently legal portable degradation with real semantic source; opaque-only/incompatible data blocks.

- [ ] **Step3: Establish the native-witness format fence through real owners.**

If reviewed C still uses4, new witness persistence uses format5. Core-session's append/load validator rejects malformed/unknown witness metadata; serialization, staged validation, snapshots and seed/fork preserve accepted fields and historical absence. Existing coordinator-owned readiness establishes the durable header before a model request could produce a witness. Formats1–4 remain readable, body/seq data remain intact, and the actual archived old4 runtime refuses5 before repair/write. Explicit source-version lists and format-aware caches must be updated. Standalone old Sessions fail before transport without an explicit upgrade. No retroactive witness conversion or ignorable metadata workaround.

This consumes5 before the later journal work: F1 uses next6 and F2 next7 unless the reviewed sequence explicitly changes. Do not silently share versions with records old readers could misinterpret.

- [ ] **Step4: Implement the three actual final grammar/native validators.**

**Anthropic:** validate emitted message/content/tool alternatives and protected binding, including empty readable thinking with a signature and redacted blocks. Client tool-use siblings need all results in the next user message, before ordinary text; sibling result order may reverse. Distinguish server tools, never fabricate their local results. Thinking mode/budget checks are scoped to effective capability and current turn. Ordinary manual budget and interleaved/adaptive rules differ; unknown models remain partial. Existing protected raw fields/cache evidence and managed transformations remain. [Tool formatting](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [manual modes](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), [model configuration](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting).

**Gemini:** validate content/part data unions separately from thought metadata; preserve signed empty text and signatures at their original parts. Ordinary blocking siblings must close before another model continuation. Optional IDs bind when present; distinct no-ID names can pair, while ambiguous same-name/no-ID raw groups reject with unavailable-native-contract. Actual IH mapping supplies IDs and retains same-name parallel calls. Recognized current-turn signature requirements must not become all-sibling/all-history requirements. Raw contents/systemInstruction/tools remain actual supported precedence; unrelated raw signed content cannot inherit mapper preservation claims. Unsupported replay-essential nonblocking/continuationToken forms block, inert unknown extensions stay partial. [REST schema](https://ai.google.dev/api/generate-content), [signature scope](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).

The official [GenerateContent protobuf definition](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ai/generativelanguage/v1beta/generative_service.proto) and [ProtoJSON rules](https://protobuf.dev/programming-guides/json/) distinguish wire syntax from application-required fields. For known optional fields, null means unset; generationConfig:null and optional thinkingConfig/null-cap alternatives must not acquire invented output bounds or false schema failures. Required contents remains required after absence interpretation; null elements in repeated message/part arrays are invalid, whereas null inside arbitrary protobuf.Value/Struct tool data remains data. Known snake_case/camelCase field aliases and documented numeric-string integer representations require explicit protocol interpretation at the same descriptor/validator boundary, never blind JavaScript coercion. Preserve the actual wire bytes. Numeric caps/budgets must resolve to exact in-range integers before being reported as known applied values; invalid or nonrepresentable values fail explicitly. Ambiguous duplicate aliases/non-null oneof members are unsupported local representation, not a guessed arbitrary winner. Limit this interpreter to known protocol fields; do not recursively rename or normalize arbitrary schema/argument keys. Unknown future fields remain explicitly partial, not a reason to pretend the pinned protobuf file enumerates every current feature.

**Bedrock:** validate the actual typed command and block unions; redactedContent remains Uint8Array, and generic reasoningText signature is optional. Call inputs/result JSON may be JSON values, not universally objects. Ordinary client groups require exact outcomes before model continuation; do not import every Anthropic adjacency restriction into generic Converse. Model-specific status/thinking rules need their own capability. Only inferenceConfig.maxTokens is the generic applied cap; retire unproven additionalModelRequestFields aliases as cap facts, retaining those fields as actual model-specific input. Preserve existing managed Claude mapping. [Reasoning union](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ReasoningContentBlock.html), [reasoning text](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ReasoningTextBlock.html), [tool use](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolUseBlock.html), [Converse prefix](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html).

Final known size/media checks consume the exact packet context and observed dimensions/bytes only. Use a sourced applicability/units table. Unknown external dimensions and unresolved20MB/MB conventions cannot become guessed hard limits. [Direct Anthropic errors](https://platform.claude.com/docs/en/api/errors), [Bedrock Message constraints](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html). Keep local preprocessing quarantine distinct from provider limits.

- [ ] **Step5: Integrate and retire, without parallel owners.**

Actual clients supply validators; every cap/restored/repeated derivative validates before describe. Keep C's report assertion in existing confirm and preserve its receipt/freshness guards. Remove the D built-in unvalidated fallback production, retaining honest custom-client coverage. Move old binding/type/mode/output checks from descriptors to real validators, preserving necessary mapper provenance preconditions. Current policy math/default preferences remain E's responsibility.

No schema/order/native rejection becomes context overflow, no validator repairs source history, and no tool/summary is invoked to resolve protocol invalidity. Safe reports contain only allowlisted enums/counts≤4096bytes; native witnesses/digests/signatures never enter diagnostic reports. API definitions may expose only actually consumed contracts, not future registry scaffolding.

- [ ] **Step6: Independent behavior, migration and packaged gates.**

Use literal A/B call groups and B/A outcomes per protocol. Missing/duplicate/orphan/result-before-call fails even with legacy authority unknown. Anthropic text-before-results fails, empty result and valid interleaving pass. Gemini ID/name/part collisions fail, signed empty parts/first-only signature/unsigned eligible2.5 and IH same-name IDs pass; raw ambiguous IDs fail. Bedrock unsigned reasoning and typed redacted bytes pass; JSON byte-array substitution, union collision, invalid IDs and known changed prefix/order fail. Validate native no-call assistant behavior explicitly.

Direct declared-vision tool results containing mixed text/images and image-only data must retain the actual image bytes through preparation and fake transport, with legal group order. Keep text, isError, native source order and ordinary human messages. Main projected image companions must not be duplicated. Do not describe an invented placeholder as original tool output or a successful effect; any necessary representation annotation is explicit, and empty-content handling follows the actual route schema. These direct-encoder tests complement C's shared-projector controls.

Producer witnesses must reflect the selected cap derivative, not initial config. Test changed within-turn thinking versus allowed next-turn changes; historical absence, malformed/unknown versions, actual append/cold/seed/snapshot and old-reader refusal. Also prove identical wire with unknown→known capability refinement creates no drift, ignored beta changes do not force mismatch, Bedrock surface-only change remains partial, and signed messages-prefix changes differ from unsigned reasoning. Mutation after prepare cannot alter body/report; known native alteration cannot be disguised as partial coverage. Full-argument/schema depths2000/6000 remain stack-safe. Include main/summary/direct zero-send/zero-compact/zero-tool negatives and held-auth confirmation positives.

Run affected adapter suites, seam wrapper/error/receipt controls, selected main/summary tests, relevant core-session/persistence/JSONL/executor/subagent/SDK consumers and six-route corpus sequentially with maxWorkers2/minWorkers1. Typecheck actual consumers/e2e, exact audit and acyclic reachable graph. Refresh isolated phase Gateway/CLI using controlled transport and task-local homes; prove current source copies, actual witness format roundtrip and refusal before repair. Keep failed RED/intermediate attempts and exact exits.

Report precise public contracts, witness production/consumption, per-route coverage, retired checks, known portability limits, structural changes and receipts. Fresh full-range spec/quality review before progression. No full-program/native authenticity/whole-decomposition claim from these gates.

## Explicit later portability decision

Google documents special signature-bypass sentinels for imported/deterministic histories. D does not automatically insert them to conceal broken native capture. R4/R5 must evaluate an explicit portable-import capability with source provenance and degraded/unverified status, or document the final limitation; genuine received signatures and opaque-only authority boundaries remain protected. This is a known supported mechanism requiring the actual import owner, not an undocumented API assumption.

## Initial capability table and literal acceptance controls

The direct Messages table is closed, never extrapolated by version suffix. M=manual enabled, A=adaptive, D=disabled, B=between_tools. Sources combine [literal IDs](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions), [current IDs](https://platform.claude.com/docs/en/models/overview), [mode distinctions](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting), [interleaving](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) and [forced-tool rules](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows), checked2026-10-16.

| Direct Claude API IDs | Mode facts |
| --- | --- |
| claude-sonnet-4-5-20250929; evidenced alias claude-sonnet-4-5 | M/D; manual interleaving requires effective supported beta |
| claude-haiku-4-5-20251001 | M/D; no manual interleaving |
| claude-sonnet-4-6 | M/A/D; manual interleaving requires effective supported beta |
| claude-opus-4-6 | M/A/D; no manual interleaving |
| claude-opus-4-7; claude-opus-4-8; claude-sonnet-5 | A/D |
| claude-opus-5; claude-haiku-5-5 | A; D limited to low/medium/high effort |
| claude-fable-5-1; claude-opus-5-5 | A; adaptive forced tool choice unsupported |
| claude-sonnet-5-5 | A or B; B limited to low/medium/high and no additional thinking fields; adaptive forced tool choice unsupported |

M rows reject forced any/named-tool choice. Other listed A rows allow forced choice subject to their documented scope. Differing per-message effort on Sonnet5.5/B and Haiku5.5/D has its own restriction; D does not add a per-message effort feature. Unsupported inert extensions stay partial rather than acquire a false checked report. The Sonnet4.5 alias retains minor-version capability evidence; do not pretend it identifies one immutable dated snapshot. Arbitrary custom IDs and future suffixes remain unknown/usable.

Converse's generic unsigned-reasoning rule is schema-wide. Initial explicit status-eligible IDs are anthropic.claude-sonnet-4-5-20250929-v1:0, anthropic.claude-sonnet-4-6, anthropic.claude-opus-4-6-v1, anthropic.claude-opus-4-7 and anthropic.claude-opus-4-8, using the checked ID examples and [ToolResultBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolResultBlock.html) scope. No direct thinking rule is transplanted merely by adding anthropic.; unverified regional/profile aliases stay unknown.

For recognized Google developer generateContent, the [thinking page](https://ai.google.dev/gemini-api/docs/generate-content/thinking) supplies literal gemini-3.8-flash, gemini-4-argon and gemini-2.5-flash. Combined with signature-scope evidence, first current-step call signatures are required for the first two, not universally for2.5. Current documented Argon/3.8 restrictions on minimal, and Argon budget+level conflicts, have independent parameter checks. Do not extrapolate to arbitrary family-looking strings or use these rows as a catalog-membership gate.

Tests must compare each listed rule with a nearby unsupported inference: unknown suffix/custom endpoint gives partial coverage, not unsupported-model rejection; exact beta/manual differences, forced-choice exceptions, effort-only drift versus mode drift, B/D limits and next-turn changes have literal positives/negatives. Add no guessed output ceiling, remote-auth proof or signature fabrication.
