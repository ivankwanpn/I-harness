# ContextEngine R0 acceptance corpus implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development task-by-task. All implementers and reviewers use GPT 6.1 Sol, as explicitly required by the user.

**Goal:** Establish a maintained, offline six-route request corpus that can reject protocol/projection regressions during the approved ContextEngine replacement.

**Architecture:** Exercise real Session projection and real provider adapters with controlled physical transports. Expected protocol structures are explicit independent assertions; token estimates, wire bytes and archive bytes remain distinct. This phase adds acceptance evidence, not a second runtime or a claim that the redesign is implemented.

**Tech Stack:** Existing TypeScript, Vitest, Node, workspace adapters and e2e configuration; no dependency or test-runner replacement.

**Spec:** `docs/superpowers/specs/2026-10-15-context-engine-redesign.md`; normative supplement `docs/superpowers/specs/2026-10-15-context-engine-framework.md`; decomposition mapping `docs/refactoring/2026-10-15-context-decomposition-overlap.md`.

## Global Constraints

- User confirmed implementation on 2026-10-15. Continue through the approved R0–R6 work without check-in pauses; each phase receives a concrete execution plan before implementation.
- Work on existing dedicated branch `codex/v0.1.13-development` at `D:/I-harness-main`; one implementation writer. The user has approved continuation of this existing branch/workspace. Do not switch main or manipulate unrelated historical worktrees.
- All delegated roles GPT6.1Sol; no recursive agents; root handles remotes/release. Workers may commit their own scoped work, not push/merge/publish.
- No live provider calls, credentials/profile/app mutation, dependency install, broad full-repository suites in this unit.
- Product version remains 0.1.13-rc.1. Existing candidate-wide FAILED qualification is historical and not replaced by focused success.
- Tests and tool scripts are not decomposition targets. New meaningful acceptance fixtures are permitted; do not split existing suites or weaken timeout/assertion/permission/reachability gates.
- Existing replay/body/error/Stop behavior is baseline, not presumed correct where research identified a gap. Do not encode a known defect as a permanent expected behavior.

## Task 1: Actual prepared request corpus and preserved semantic invariants

Read this task as your complete scope. Use the global constraints above; no recursive subagents, live endpoints, account/profile reads, product fixes, dependency changes or remote writes. Root owns research/design/rulings. Work in `D:/I-harness-main` on `codex/v0.1.13-development`.

**Files:**
- Create `e2e/context-corpus.e2e.ts` — corpus assertions across real adapters and source projection.
- Create `e2e/fixtures/context-corpus.ts` — synthetic semantic history builders and immutable input data only.
- Create `e2e/fixtures/context-transports.ts` — test-only physical capture using existing fetch/systemFetch/mock Bedrock seams.
- Create `docs/research/2026-10-15-context-engine-r0-baseline.md` — command/results, cases and explicit gaps.
- Read `e2e/vitest.config.ts`, the five adapters' `test/prepared.test.ts`, core-session `test/compacted-step.test.ts`, Anthropic `test/compacted-tool-response.test.ts`, and the research `docs/research/context-redesign-2026-10-15/probes.ts`.
- No production source edits in this task. If a promised invariant fails, retain RED evidence and report to root for a separate implementation unit; do not weaken it.

**Interfaces:**
Consume real `createSession`, `append`, `deriveMessages`, `create*Client`, `client.prepare(request)`, `PreparedModelRequest.stream(control)`, `.measurement` and `.withOutputCap`.

Fixture exports:

```ts
export type CorpusRoute = 'chat' | 'responses' | 'subscription' | 'anthropic' | 'gemini' | 'bedrock'
export const corpusRoutes: readonly CorpusRoute[] = ['chat','responses','subscription','anthropic','gemini','bedrock']
// Fixture creates new owned objects each time; no production code depends on tests.
export function makeToolRound(route: CorpusRoute): { session: Session; request: LLMRequest }
export function makeCompactedToolRound(route: CorpusRoute): { session: Session; request: LLMRequest }
```

Use model/provider label `fixture` consistently for native replay. Distinct route labels must still produce public/subscription protocol differences. Source messages include a human request, one assistant exchange with two parallel calls (`read-a`/`read-b`), text and route-specific native continuation, and results arriving in reverse order. Add a later current human input after the closed round. Native content uses synthetic signatures/encrypted data; no real account state. PNG fixture can reuse the existing 1x1 image from prepared tests.

**Acceptance cases (all required):**

1. Every route physically receives its appropriate system/instructions, declared tool schema, paired call IDs/results and correct output-cap representation. Subscription omits unsupported output cap; Bedrock only claims SDK-command bytes, not HTTP bytes. Assert concrete protocol fields rather than mapping them back through the production serializer.
2. Compatible native continuation/order survives; foreign model provenance is handled according to current adapter's documented behavior. Do not assert every foreign route preserves/drop all reasoning identically. Explicitly check Anthropic thinking/tool group, Responses reasoning item/order, Chat reasoning_content, Gemini thought signatures/function responses and Bedrock reasoning blocks/toolResult.
3. The compaction fixture shadows the current step/start while preserving its subsequently committed assistant+tool block (same known regression shape as existing compacted-step tests). Live and JSONL round-trip projections produce legal route-specific call/result grouping; raw source events remain unchanged. This protects the already-repaired HTTP400 case.
4. Prepared body is immutable under subsequent mutation of caller messages/tools/options. Applied output-cap derivatives preserve semantic inputs and permitted native data. Final captured JSON byte length equals packet.bodyBytes for HTTP routes; Bedrock compare only command estimate under its actual label.
5. Prepare is network/auth-free. A stale/aborted pretransport guard prevents physical send; subscription held auth must recheck after auth. Do not race by sleeps; use deferred promises as existing prepared tests.
6. Text-only model projection quarantines image data without mutation of source history; image-capable routes retain typed image bytes instead of adding base64 as ordinary text. Assert observed image count and wire shape, not fictional exact visual token cost.
7. Large archived content is distinct from active payload: use >100MiB JSONL-equivalent raw events with an explicit controlled checkpoint and small retained tail, price actual prepared input, and assert active payload is bounded. This is projection acceptance, not disk-load or provider throughput qualification. Avoid persisting a 100MiB test fixture.
8. Test corpus oracles reject a deliberately malformed grouped-wire copy (missing tool result or wrong ID) and a lost synthetic native signature. These controls validate independent structural assertions; do not rely only on a snapshot produced by the same serializer. Real-adapter tests and oracle controls must be distinguishable.

Example independent HTTP byte assertion:

```ts
expect(prepared.measurement.packet.sizeKind).toBe('http-json-body')
expect(prepared.measurement.packet.bodyBytes).toBe(Buffer.byteLength(capturedBody, 'utf8'))
```

Example semantic expectation (Anthropic group, not a universal route layout):

```ts
const use = body.messages.findIndex(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use'))
expect(body.messages[use].content.filter(b => b.type === 'tool_use').map(b => b.id)).toEqual(['read-a','read-b'])
expect(body.messages[use + 1].content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id).sort()).toEqual(['read-a','read-b'])
```

- [ ] **Step 1: Capture baseline.** Run the five existing prepared test files sequentially from their package roots (`pnpm --filter @i-harness/llm-<name> exec vitest run test/prepared.test.ts --maxWorkers=2 --minWorkers=1`), plus core-session `test/compacted-step.test.ts` and Anthropic `test/compacted-tool-response.test.ts`. Store every real exit code/log in this plan's SDD workspace. Do not run entire repo. Known fixture harness failures are fixed only in this task's test setup; product failures are reported.
- [ ] **Step 2: Add corpus test cases before fixture capture helpers.** Each assertion names the production mutation it would reject in a short test comment/report. Because this is characterization of existing good behavior, a green baseline is expected; do not invent product RED requirements. Prove oracle sensitivity with the malformed-copy controls above.
- [ ] **Step 3: Implement test-only fixture/capture helpers.** Follow concrete exports/cases above. Stub all HTTP seams, inject Bedrock runtime, and fail unexpected transport; capture data local to each case and restore stubs after each test. Use minimal terminal response envelopes required by actual parsers; no tools execute.
- [ ] **Step 4: Run the focused corpus.** `pnpm exec vitest run e2e/context-corpus.e2e.ts --config e2e/vitest.config.ts --maxWorkers=2 --minWorkers=1`. Iterate only failed cases; no loosened protocol invariant. Existing prepared baselines need not be rerun if no product change; the new corpus is the new green evidence.
- [ ] **Step 5: Self-review and report.** Record actual route/case coverage, runner exit codes, baseline failures if any, test-only controls, metrics domain limits, relevant imports and mutable-state isolation. Typecheck with existing e2e/TypeScript setup if available; do not invent a new repo config merely for this task. `git diff --check` must pass.
- [ ] **Step 6: Commit.** `git add -- e2e/context-corpus.e2e.ts e2e/fixtures/context-corpus.ts e2e/fixtures/context-transports.ts docs/research/2026-10-15-context-engine-r0-baseline.md`; commit `test(context): establish six-route request acceptance corpus`. Write full report to the task report path supplied by root; return short status, commits, test summary and concerns.

## Phase exit and continuation

R0 is complete only after independent spec/quality review. It does not complete any S/CX decomposition, fix known research findings, prove live providers, or supersede full qualification. Root then writes the R1 execution plan against the approved semantic snapshot/importer framework and current tested corpus, and continues implementation without asking the user to reconfirm.
