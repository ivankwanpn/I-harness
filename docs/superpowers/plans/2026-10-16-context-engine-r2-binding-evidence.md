# ContextEngine R2A — model budget evidence and binding carriers implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Separate model limits, configured generation intent and route capabilities at their real producers, then carry that evidence through actual main/child/summary snapshots without changing current admission mathematics.

**Architecture:** token-meter owns numeric evidence; llm-seam owns a small adjacent ModelBudgetBinding contract; provider/provider-runtime resolve it once. core-agent and its host/child/summary composition carry the data into the reviewed R1C capture. Existing scalar binding fields retain their behavior and current budget owners remain until the atomic R2E cutover.

**Implementation ruling, 2026-10-16:** The initial plan retained `resolveEffectiveModelContext` as a public scalar facade. After all shipping consumers migrated, the exact reachability audit found that facade was the only new unused export (409 versus408); `@i-harness/provider` is a private workspace package. Retire that unused function/public export in this atomic unit rather than retain a dead API, fabricate a consumer, or exempt/reseed the audit. The one evidence algorithm and actual runtime scalar aliases retain precedence, values and absence semantics. This explicitly supersedes the initial facade-retention requirement; it does not authorize changing request/default/admission behavior.

**Tech Stack:** Existing TypeScript/pnpm/Vitest workspace; no new package or third-party dependency.

**Spec:** `docs/superpowers/specs/2026-10-15-context-engine-redesign.md`, `docs/superpowers/specs/2026-10-15-context-engine-framework.md`, and `docs/superpowers/specs/2026-10-15-context-engine-r1-contracts.md`. Reviewed prerequisite is R1C through `dcaff3517dd64c8d2b6f2f4908405f7e3cb4797b`; its exact RequestSurfaceInput/Captured alias, RequestEvidence and main/inherited/summary interfaces were checked before promotion. Source evidence is `.tmp/context-redesign-20261015/r2a-contracts.md` and R2 measurement/default report. See `docs/research/2026-10-16-context-engine-r1c-verification.md` for retained limits.

## Global Constraints

- User approved continuous R0–R6 development; one product writer, all delegated agents GPT6.1Sol, no recursive delegation. Work on the existing development branch.
- Product remains0.1.13-rc.1. No installed profile, real account/provider/count request, dependency upgrade, merge or release. Only existing workspace dependencies may be added when a real direct import needs them.
- Preserve six routes, user/configuration values, raw-option precedence, ordered native data, role-model ownership, dynamic getters, requestScope/signal identity, R1B acceptance and reviewed R1C immutability/freshness.
- This unit adds evidence and real carriers, not another assessor. No production threshold/formula/default-output change. R2E removes the old competing math as one activation unit; no permanent fallback assessor.
- core-session must not import token-meter/llm-seam/context-engine. Persist no full budget descriptor; the4096-byte context-event bound remains. Credentials, headers, raw options, endpoint secrets and account tokens are excluded from evidence.
- New production modules normally150–400 lines/functions<=120. No locals-bag facade, unused public exports or fake audit consumers. Original S20/CX decomposition completion is not implied by field plumbing.
- Preserve prior whole verify:all FAILED/incomplete and recorded R1C before-edit failures. Report focused evidence honestly; no new skips/timeouts/assertion weakening/audit baseline reseed.

## File map

- Create `packages/token-meter/src/binding-evidence.ts`, export only real public contract consumers in its index. Create `packages/llm-seam/src/binding.ts` and public exports for ModelBudgetBinding/route constructor actually consumed by runtime.
- Modify `packages/provider/src/catalog/context.ts` to keep one resolution algorithm; `catalog/resolve.ts` supplies existing provenance; public index exports the evidence resolver and retires the unused scalar resolver under the ruling above. Add a direct token-meter workspace dependency if its types are imported. Do not change model-catalog.json numbers/names.
- Modify provider-runtime `selection/{metadata,resolve}.ts` and binding types. Keep metadata-only description free of auth/client/network work; runtime resolves budget evidence from the same described selection rather than independently recomputing it.
- Modify reviewed R1C context-engine surface type/capture, core-agent `agent/{types,context,request-snapshot,budget}.ts` at their actual reviewed responsibilities, and host `session-executor/{assembly,service}.ts` or their extracted binding leaves. Add only necessary field forwarding, not the whole S20 split in this unit.
- Modify `apps/cli/src/run.ts` binding handoff and subagent `child/model-binding.ts`, `child/{types,assembly}.ts`, `child.ts`, `followup/resident.ts`, `index.ts`, `tools/spawn.ts`. Actual team/child-review carriers include `agent-team/src/scheduler.ts`, `scheduler/teammate-lifecycle.ts` and `guard-approval/src/guardian/reviewer.ts`. Declared-model arms must not fall back to parent evidence. Isolated guardian and title direct-stream admission remain explicitly inventoried for R2E; do not add unused dead data fields there merely to claim coverage.
- Modify compaction config/factory/contracts/summary seams and core-agent buildCompactor to distinguish inherited budgetBinding from optional summaryBudgetBinding for an independently selected summary client. Actual summary cap4096 preference is separate from main limits/defaults.
- Tests: new provider `test/context-evidence.test.ts`, runtime `test/budget-binding.test.ts`, seam `test/budget-binding.test.ts`; extend R1C snapshot/context-update, main/child inherited and compaction-binding tests. Use existing catalog/runtime/role suites as regression evidence; tests/scripts are not decomposition targets.

### Task 1: Resolve and carry model budget evidence without policy activation

**Consumes:** reviewed R1C capture/coordinate/observation APIs and actual request surface, current provider resolver and runtime metadata, prepared measurement output facts, dynamic main/child binding descriptors.

**Produces:** typed ModelLimits/GenerationPolicy/ModelBudgetBinding, one source-provenance resolver, actual runtime/main/child/CLI/summary carriers, unchanged current wire behavior and capacity math.

- [ ] **Step 1: Record focused baseline and add literal RED producer/capture fixtures.**

Before source edits record provider provider.test.ts and runtime runtime.test.ts/chatgpt-plan.test.ts plus existing main compaction-binding/inherited-context-budget receipts if no source-equivalent baseline exists. New fixtures assert precedence and source separately from the old scalar value:

```ts
const profile = { name: 'test-route', displayName: 'test', protocol: 'gemini' as const,
  catalog: 'gemini', contextWindow: 500_000,
  modelContexts: { 'gemini-2.5-pro': { contextWindow: 600_000 } } };
const evidence = resolveEffectiveModelContextEvidence({ profile, modelId: 'gemini-2.5-pro',
  userModel: { contextWindow: 700_000, maxTokens: 8_000 } });
expect(evidence?.limits.contextTokens).toMatchObject({ value: 700_000, origin: 'configured-model-row' });
expect(evidence?.limits.outputTokens).toMatchObject({ value: 65_536, origin: 'catalog' });
expect(evidence?.generation).toMatchObject({ origin: 'configured', outputCap: { value: 8_000 } });
expect(evidence).toMatchObject({ contextWindow: 700_000,
  maxContextWindow: undefined, maxOutputTokens: 8_000 });
```

The65,536 expectation is the pinned IH catalog fixture, not a live provider claim. Test all precedence tiers, catalog alias/no-match, max-output-only resolution, configured output above the catalog preserving intent, unchanged shipped scalar values/absence, and actual replaceSubscriptionModels→resolve using configured-model-row rather than false human attribution. Record the missing API/field RED. The initial scalar-facade compatibility assertion is retired with that unused internal API; retain the equivalent value/absence controls at the real producer and runtime aliases.

- [ ] **Step 2: Add the concrete minimal public contracts and one resolution algorithm.**

```ts
// token-meter/binding-evidence.ts
export type EvidenceOrigin = 'configured-model-row' | 'profile-model' | 'profile' |
  'catalog' | 'adapter-default' | 'explicit-route' | 'explicit-request';
export interface NumericEvidence {
  readonly value: number;
  readonly origin: EvidenceOrigin;
  readonly sourceId: string;
}
export interface ModelLimits {
  readonly contextTokens?: NumericEvidence;
  readonly contextCeilingTokens?: NumericEvidence;
  readonly inputTokens?: NumericEvidence;
  readonly outputTokens?: NumericEvidence;
  readonly bodyBytes?: NumericEvidence;
}
export interface GenerationPolicy {
  readonly outputCap?: NumericEvidence;
  readonly origin: 'explicit' | 'configured' | 'legacy-catalog-default' |
    'adapter-default' | 'provider-managed' | 'unspecified';
}
// llm-seam/binding.ts
export type RouteKind = 'openai-responses' | 'openai-responses-subscription' |
  'openai-compatible' | 'anthropic-messages' | 'gemini' | 'bedrock';
export interface RouteBudgetCapability {
  readonly version: 1;
  readonly route: RouteKind;
  readonly evidenceId: string;
  readonly outputParameter: 'required' | 'optional' | 'unsupported' | 'unknown';
  readonly packetKind: 'http-json-body' | 'sdk-command-estimate';
}
export interface ModelBudgetBinding {
  readonly version: 1;
  readonly metadata: Readonly<ContextBindingMetadata>;
  readonly limits: ModelLimits;
  readonly generation: GenerationPolicy;
  readonly capability: RouteBudgetCapability;
  readonly reasoningEffort?: ReasoningEffort;
}
```

Ruling: outputParameter expresses the adapter's required/optional/unsupported parameter contract, replacing the planning report's ambiguous static outputMode. An optional route does not always emit a cap. Actual prepared output facts remain authoritative about each final payload. Do not use a universal thinking floor or imply provider enforcement from a locally supported field.

Use positive safe integers and bounded producer IDs, max256characters. Producer IDs are fixed labels such as settings-model-row-v1/profile-model-v1/profile-v1/host-request-v1/anthropic-fallback-v1, or a validated existing catalog family+generatedAt revision. Never encode arbitrary headers, URLs, raw options or credentials. Unknown limits remain absent. Catalog output evidence stays separate from configured generation output; the latter does not rewrite provider ceiling provenance. Current metadata identityCoverage is unchanged.

```ts
export interface ResolvedModelContextEvidence extends EffectiveModelContext {
  readonly limits: ModelLimits;
  readonly generation: GenerationPolicy;
}
export function resolveEffectiveModelContextEvidence(input: EffectiveContextInput):
  ResolvedModelContextEvidence | undefined;
export function describeRouteBudgetCapability(input: {
  protocol: Exclude<RouteKind, 'openai-responses-subscription'>;
  codexSubscription?: boolean;
}): RouteBudgetCapability;
```

The evidence resolver is the single production computation; existing binding scalar aliases preserve values/absence without a second resolve call. Window chain: configured model row > profile model override > profile > declared catalog family. Preserve maxContextWindow separately as contextCeilingTokens with profile-model/profile provenance; it is not an independently documented input-only limit and cannot be silently dropped from the new descriptor. A ceiling-only result exposes new evidence without inventing a scalar context window or output cap. Add a literal ceiling-only and configured-window-above-ceiling fixture proving data preservation without new R2A enforcement. Generation chain remains configured-model-row maxTokens > catalog maxOutputTokens; configured means a stored row, not human-authenticated intent. Subscription refresh writes those rows too. The catalog arm is legacy-catalog-default, not a newly recommended preference.

Capability table: public Responses/Chat/Gemini/Bedrock optional outputParameter; Anthropic required; subscription unsupported. Packet kind is SDK-command-estimate only for Bedrock. Mark evidence as this adapter's contract version, not a backend probe. Reject subscription:true paired with a different protocol rather than inventing another route. No count/native-compatibility feature is implied.

- [ ] **Step 3: Build one adjacent runtime descriptor, preserve exact wire precedence and aliases.**

describeSelection builds safe budgetBinding from the same effective profile/evidence/metadata and reasoning effort used by resolveModel. Anthropic128000 fallback becomes adapter-default generation when no value resolved, with no fabricated output ceiling. With no intent, an explicitly identified subscription output capability may say provider-managed; optional/custom absence remains unspecified until actual preparation proves raw/default behavior. No new endpoint/auth work.

Resolved runtime aliases contextWindow/maxOutputTokens/contextMetadata are projected once from the same descriptor. Verify consistency at this producer/forwarding boundary. Do not reject valid request-specific core-agent updateContext output overrides just because they differ from the base model default: R1C captures actual request cap separately; prepared output.source/effectiveCap describes final behavior. R2E will remove shipping scalar-alias decisions and resolve actual request intent explicitly.

Raw precedence stays adapter-owned: public request cap overrides raw max_output_tokens, subscription strips it; Chat uses configured maxTokensField after raw options and rejects conflicting fields; Anthropic request > raw > fallback; Gemini request wins nested generationConfig; Bedrock retains current inferenceConfig/conditional thinking-default/additional-field rules. R2A neither changes these bodies nor labels a base descriptor as the final applied cap.

- [ ] **Step 4: Forward into actual main, child and summary snapshot consumers.**

Add optional budgetBinding beside existing binding fields; custom/legacy callers without it stay unclassified, not given invented evidence. Main assembly supplies the live descriptor with client/binding identity. Model-switch updateContext and inheritedBindingForStep carry it atomically with context metadata/window/effort. CLI forwards it, never resolves a second catalog itself.

Each declared child role consumes its own descriptor from its ready result, even if absent; absence on a declared role cannot fall back to parent's descriptor. Inheriting children sample the parent's live tuple at their existing step boundary, without parent calibration, session owner or authority. Resident rebuild and all tool/team/guardian spawn arms preserve the same rule. Child snapshot mutation/identity tests must use two different real descriptor values and source models.

Extend reviewed R1C RequestSurfaceInput/CapturedRequestSurface with budgetBinding, detaching/freezing through its existing supported-data capture and including it in surfaceRevision. No new clone/hash implementation. Do not serialize this host descriptor into a protocol body. Held-prepare tests prove descriptor mutation causes a rebuild with zero stale send and once-only hooks/claim.

buildCompactor carries inherited budgetBinding only for the inherited summary client. Independently selected summaries use optional summaryBudgetBinding from that selection; no parent limit/account evidence by fallback. The existing summary output4096 preference remains a separate per-request preference and is not overwritten by the descriptor. Consume the passed descriptor in actual summary preparation/guard data, not a dead field retained only by tests; no new capacity math in this unit.

- [ ] **Step 5: Keep observation/persistence narrow and prove compatibility.**

No full descriptor enters core-session events. R1C requestContext.surfaceRevision already binds captured descriptor data; retain existing scalar measurement facts and4096-byte bound. Do not add reverse imports, arbitrary provenance arrays or secret-bearing identity hashes. Metadata-only context reads never build clients/auth/count/prepare, and changed descriptor evidence makes a historical read unavailable without erasing its prior measurement.

Required independent tests: all source precedence/absence/catalog alias cases; subscription rows labelled configured; Anthropic fallback not a ceiling; capability table and no unsupported wire cap; real runtime main and declared/inherited child carrier capture; local cap override distinct from base defaults; independent summary binding cannot inherit parent's limits; snapshot deep ownership and stale-guard race; metadata-only read counts unchanged; six-route actual wire capture unchanged. Existing partial identity remains partial. No configured model is refused merely for missing catalog membership/unknown limits in this data-only phase.

- [ ] **Step 6: Run scoped gates, audit/graph and commit the atomic carrier unit.**

Run these scoped commands sequentially with separate logs and actual exit receipts. Filenames below were checked against06079a1e; rebase only affected names if R1C review changes its public file map.

```powershell
pnpm --filter @i-harness/provider exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/provider-runtime exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/llm-seam exec vitest run test/budget-binding.test.ts test/prepared-wrappers.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/context-engine exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-agent exec vitest run test/compaction-binding.test.ts test/context-update.test.ts test/owned-budget.test.ts test/request-scope.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/session-executor exec vitest run test/inherited-context-budget.test.ts test/cold-state-inspection.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/subagent exec vitest run test/child.test.ts test/native-context-role.test.ts test/model-display.test.ts test/fork-isolation.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/agent-team exec vitest run test/child-sequence.test.ts test/lifecycle.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/guard-approval exec vitest run test/guardian-review.test.ts test/isolated-reviewer.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/compaction exec vitest run test/summarizer.test.ts test/summarizer-prefix.test.ts test/context-efficiency.test.ts test/policies.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/cli exec vitest run test/compaction-wiring.test.ts test/role-model-wiring.test.ts test/run-protocol-selection.test.ts --maxWorkers=2 --minWorkers=1
pnpm exec vitest run e2e/context-corpus.e2e.ts --config e2e/vitest.config.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/provider --filter @i-harness/token-meter --filter @i-harness/llm-seam --filter @i-harness/provider-runtime --filter @i-harness/context-engine --filter @i-harness/core-agent --filter @i-harness/session-executor --filter @i-harness/subagent --filter @i-harness/compaction --filter @i-harness/cli --filter @i-harness/agent-team --filter @i-harness/guard-approval typecheck
pnpm exec tsc --noEmit -p e2e/tsconfig.json
pnpm verify:reachability
```

The isolated-reviewer test is unchanged-auxiliary regression, not a claim that its separate capacity policy has been converted. New producer fixtures join the full provider/runtime suites. Add only a named relevant follow-up when a failure/new change invalidates a prior receipt; do not repeat unrelated passing scopes.

Only direct workspace dependency additions/lock links are allowed. Use offline ignore-scripts workspace linking if necessary; no registry drift. Run exact reachability comparison and acyclic/application-reachable manifest graph. Explain real export/import changes rather than reseeding baseline or creating fake consumers. Since no new package is created, reuse R1C packaged inclusion evidence for unchanged graph where justified; if the dependency graph changes, refresh isolated CLI/gateway resolution checks under new phase-owned paths.

Commit explicit product/tests/manifests/docs only. Report BASE/HEAD, actual carriers, before/after wire proof, RED/GREEN and warnings, source-provenance limitations, alias retirement assigned to R2E, and unchanged whole-program failure/S20 counts. Fresh independent spec/quality review is required before R2B starts. No release claim.
