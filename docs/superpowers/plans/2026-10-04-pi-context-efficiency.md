# IH Pi Context Efficiency Implementation Plan

> **For agentic workers:** Use the existing development workflow with scoped parallel work and one independent final review. Execute tasks with test-first verification and record evidence in the task ledger.

**Goal:** Reduce avoidable tool declaration/result context and improve observable cache accounting and compaction estimates without changing executable authority.

**Architecture:** Extend existing Code Mode, token meter, compaction, provider adapter, telemetry and session assembly packages. Cell-local discovery uses captured catalog data; persistence is append-only data; provider wire options are gated by declared route capabilities.

**Tech Stack:** TypeScript, pnpm workspace, Vitest, QuickJS/WASM, Electron.

**Spec:** `docs/superpowers/specs/2026-10-04-pi-context-efficiency-design.md`

## Global Constraints

- Preserve permissions, cancellation, hidden/deferred visibility, fatal policy refusals and current output/transfer/search caps.
- Work only in `D:/frontend-test`; never stage the preexisting Electron configuration edit.
- No extra model calls for warming and no real credentials or provider calls for verification.
- Keep protocol accounting explicit, unknown cache measurements absent, and estimates labeled.
- User's subsystem request applies to the separate MCP research.

## Task 1: Stable Code Mode descriptions and bounded discovery

**Files:** `packages/code-mode/src/catalog.ts`, `register.ts`, `worker.mjs`, `types.ts`; Code Mode tests and narrowly affected integration tests.

**Interfaces:** Consume the captured `CodeModeToolDefinition[]`. Produce guest `searchTools(query, limit=8)` returning short metadata for at most 20 results, and `describeTool(name)` returning one bounded complete definition or a clear size error. Add `code_status` to list live cells using a fixed description and expose it in only mode; it is unavailable for nested composition.

- [x] Write tests for no duplicated direct schema in mixed descriptions, no deferred full schemas, stable wait/status descriptions before/during/after a live cell, search/describe aliases and unknown/hidden tools, and actual guest calls with unchanged fatal denial.
  ```ts
  expect(mount.schemas().find(s => s.name === 'code_wait')?.description).toBe(before)
  expect(await tools.execute({name:'code_status',args:{}})).toMatchObject({output:{cells:[{id:cellId,status:'running'}]}})
  ```
- [x] Run `pnpm --filter @i-harness/code-mode test`; confirm the new assertions fail on existing behavior.
- [x] Implement fixed guide/catalog presentation and bounded pure helpers over the existing captured worker catalog; do not promote schemas or add dispatch paths.
- [x] Re-run full Code Mode tests and typecheck plus affected host/child integration tests; read all failure output.

## Task 2: Usage accounting and calibrated context estimates

**Files:** `packages/llm-seam/src/index.ts`, provider adapter usage mapping, `packages/token-meter/src/context.ts`, `core-agent/src/index.ts`, `compaction/src/index.ts`; corresponding tests.

**Interfaces:** Add explicit input-accounting metadata to `LLMUsage` while preserving raw counters. The token meter owns a request anchor with `record(request, usage)` and `estimate(request)` that returns `{tokens, source}`; the source is provider-calibrated only when the exact system/tools and full anchored projected prefix still match. The core agent records successful positive usage and supplies the estimate to both budget and compactor.

- [x] Test cache-inclusive/exclusive totals, missing vs zero counters, invalid numbers, CJK/history underestimation correction, appended assistant/tool results, and invalidation after system/tool edits, prune/summary/reset/rewind/rebind and failed/aborted calls.
  ```ts
  meter.record(request, {inputTokens:12000, inputTokenSemantics:'includes-cache'})
  expect(meter.estimate(request)).toMatchObject({tokens:12000,source:'provider'})
  expect(meter.estimate({...request,systemPrompt:'changed'}).source).toBe('estimate')
  ```
- [x] Run targeted tests and verify failures before adding implementation.
- [x] Implement a single bounded anchor, with structural prefix checks and no reuse of ambiguous or zero reports; preserve raw estimates as fallback and invalidate on binding updates.
- [x] Use the same estimate for auto compaction pressure, absolute budget and output-cap room. Keep existing region selection/prune/original-message summarizer.
- [x] Run affected packages and integration tests/types.

## Task 3: Capability-gated cache options and efficiency telemetry

**Files:** settings/provider/provider-runtime cache configuration; llm-seam request/cache helper; adapter serializers; core-agent, compaction summarizer and telemetry; tests.

**Interfaces:** Persist opt-in `promptCache` route configuration, with off/automatic mode and short/long retention. Request intent and session affinity are typed neutral metadata; adapters own wire spellings. Provider reporting carries original usage and input semantics; telemetry records content byte counts, availability and normalized total/rate separately.

- [x] Test unchanged unknown-route payloads, explicit Anthropic marker positions and TTL, explicit Responses cache key, no leakage into Chat/Gemini/Bedrock, explicit off summary requests, validated settings roundtrip, and missing cache measurements remaining missing.
- [x] Run targeted tests to observe expected failures.
- [x] Add opt-in serialization only on applicable protocols; preserve explicit configured wire options and retry/abort behavior. Use sessionId for affinity without recording prompts/credentials in telemetry.
- [x] Record counts/estimates for request components and summary usage without introducing a new LLM request.
- [x] Run settings/provider/runtime/adapter/core/compaction tests and typechecks.

## Task 4: Durable bounded JSON state and retained text references

**Files:** Code Mode runtime/register/state module, core-session event union, output-retention integration, session-executor integration tests.

**Interfaces:** `code/store` is versioned append-only committed writes, owner-scoped; runtime initial state/commit callback use JSON entries only. Rewind excludes abandoned writes. Text retention returns a bounded preview plus a reference to the complete admitted text; native worker lifetime is never serialized.

- [x] Write real-runtime tests for dispose/resume/fork, failed and terminated stores, owner isolation, rewind rollback, concurrent cell merged-write ordering, size limit and spill preview reconstruction.
- [x] Confirm expected red failures.
- [x] Implement replay using current rewind visibility, validate persisted JSON bounds at admission, commit before publishing completion and flush when a persistence host is present; failure is visible and no false successful state is committed.
- [x] Retain emitted text within the existing transfer cap, with unchanged model preview/item caps and explicit completeness flags; oversized text remains visibly refused/truncated.
- [x] Run Code Mode, persistence, executor/child/host integration suites and types.

## Task 5: Verification, measurement and delivery

**Files:** private owned workload/proof scripts, `docs/audit/2026-10-04-pi-context-efficiency-acceptance.md`, public MCP research report.

- [x] Run deterministic offline before/after declaration/result measurements and adapter requests with synthetic usage. Count actual UTF-8 serialized bytes, label estimated tokens, record repeat count and latency.
- [x] Request one independent final review with baseline `d0eca79f`, this spec/plan and an explicit file list; fix concrete findings with red/green verification.
- [x] Run `pnpm verify:all` in isolation and inspect exit/result totals, types, E2E and reachability. Do not weaken gates or claim mocked usage as a real cache hit.
- [x] Build portable Desktop in a new task-specific release directory, prove current shipped source and an owned copied-app backend path, compute ZIP SHA256, and ensure all owned processes are closed.
- [x] Commit only task files after verified completion and deliver app/report links, measured claims and limits. Include two MCP pinned-source studies with standalone subsystem recommendations, without installing them.
