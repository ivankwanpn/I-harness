# Handoff — I-harness @ M10a + M10b + M11 + M12 + M13 Complete (2026-08-20)

> Handoff for a new session continuing development of the I-harness project.
> Repo: `D:\agent-complete\I-harness` (pnpm monorepo, git on `master`).
> Working tree is clean at this commit: `ba00fe0`.

## 1. Current State

- **M10a (guards: tool timeout + repeat reminder) — COMPLETE, on `master`.**
- **M10b (session-query: SQLite FTS + lineage) — COMPLETE, on `master`.**
- **M11 (compaction: context-pressure auto + manual compact) — COMPLETE, on `master`.**
- **M12 (tool retry-on-timeout + tool-result retention) — COMPLETE, on `master`.**
- **M13 (parallel tool-call execution) — COMPLETE, on `master`.**
- All gates green at HEAD: `pnpm -r test` exit 0, `pnpm -r typecheck` exit 0.
- No `CURRENT_FORMAT_VERSION` / event-vocabulary changes since M10b's `compaction/*` addition (M11, additive; M12 adds NO session events; M13 adds NO session events — the retry loop and the parallel scheduler are invisible to the session log by design, and the `truncated`/`TOOL_ABORTED_BEFORE_DISPATCH` markers live on the tool result, not events). The ONLY schema bump is `session-persistence-sqlite` `SCHEMA_VERSION` 1→2 (M10b, via the M5 migration chain).
- Root `engines.node` is `>=22.18` (required by `node:sqlite`'s `readOnly` option).
- All package.json additions are `workspace:*` — no new external dependencies.
- 28 packages + 1 app (`apps/cli`). Environment: **Windows (Git Bash)**, Node v24, ESM + strict TS, vitest.

### Recent commits (M13, oldest → newest)
```
35e1f90 docs: M13 parallel tool-call execution design spec
565c6a8 docs: M13 parallel tool-call execution implementation plan
747146b docs: M13 — fix decision-slot direction (preserve parent-propagation of the call payload; guard-approval must keep classifying child-scope calls)
8d2e6ed feat(core-plugin): emit returns the waterfall chain value (additive)
fb3c439 feat(core-tools): staged prepare/dispatch/finalize, per-dispatch decision, signal threading
49c414e feat(core-agent): bounded rolling-pool tool-call scheduler with model-order commits
a47a26c fix(core-agent): run staged finalize (post-execute) in the ordered commit lane
013b6c7 fix(core-agent): swallow abort-path finalize failure (abort dominates a throwing post-execute)
994e64a feat(core-agent): collect-then-batch tool execution + maxParallelToolCalls config
91672fa docs: M13 plan — record Task 2 core-plugin addition, Task 3 finalize-in-commit-lane, t.order assertion fix
eeef865 feat(guard-retry): abort-aware backoff (stop retrying when the caller signal aborts)
a39e011 feat: opt read-only tools into parallel execution (isConcurrencySafe)
b495964 feat(cli): maxParallelToolCalls pass-through + M13 e2e
04b6718 fix(core-agent): final-review wave — serial-regression + Ruling-B pins, abort-before-start synthesis test, truthful startedUpTo, spec export correction
ba00fe0 docs: M13 plan — sync startedUpTo placement with final-review fix
```

### Recent commits (M11, oldest → newest)
```
fbf50e8 docs: M11 compaction (context-pressure auto + manual compact) design spec
8e35e65 docs: M11 compaction (context-pressure auto + manual compact) implementation plan
071f4dd feat(core-session): compaction events + shadow-aware deriveMessages projection
216a318 feat(compaction): config validation, approx token estimation, region selection
4fcf85b docs: M11 spec §G — maxTokens is positive (>= 1), retainTokens non-negative
861be95 feat(compaction): CompactionEngine with pressure trigger, summarizer, and event append
67aa549 feat(core-agent): optional compaction seam (step-boundary pressure check + agent.compact)
260840c docs: M11 spec §3 — Agent.compact is optional in the interface (runtime contract unconditional)
66e5352 feat(cli): pass compaction config through to the agent
2e1e51e fix: M11 final-review wave — KNOWN_EVENT_TYPES registration, re-fire guard, fail-soft warning, resume e2e
```

### Recent commits (M10b, oldest → newest)
```
7d827e2 docs: M10b session-query (SQLite FTS + lineage) design spec
7ad9c98 docs: M10b session-query (SQLite FTS + lineage) implementation plan
fd63457 feat(core-session): deriveSearchText canonical event search-text normalizer
e192708 feat(session-persistence-sqlite): schema v2 + events_fts FTS5 index (migration 1→2 with backfill)
f37c744 feat(session-persistence-sqlite): same-tx FTS writes in append + repair re-sync
d6d158f docs: M10b spec §3.2 — pin combined sessionId+subtreeOf filter as union (OR)
254af17 feat(session-query): FTS5 search + lineage query library over the sqlite session store
d447b32 feat(session-query): session_search + lineage read-only tools
6a9c303 docs: M10b spec §3.4 — pin tool output as wrapper objects { hits } / { nodes } (ruling)
dc3654b feat(cli): mount session_search + lineage tools when a sessionQuery is provided
483d744 test(cli): cover session-query mount gating
af79a4a test(cli): distinguish unknown session tool failure
2b5540f fix: M10b final-review wave - repair atomicity, search/lineage hardening, engines floor, contract tests
```

## 2. Commands

```bash
cd D:/agent-complete/I-harness
pnpm -r test          # full suite (all packages + apps/cli)
pnpm -r typecheck     # full typecheck
# per-package (fast loop):
cd packages/<pkg> && pnpm test && pnpm typecheck
cd apps/cli && pnpm test && pnpm typecheck
```

## 3. Global Constraints (binding — never violate)

- **No bun. No `@ai-sdk/*` dependencies. No new external dependencies** (only `workspace:*` links).
- ESM + strict TypeScript. `tsconfig.base.json` has `strict`, `noUnusedLocals`, `noUnusedParameters`
  → unused params use the `_name` convention (e.g. `_ctx`).
- Tests live in `test/*.test.ts` per package, run with vitest (`pnpm test` = `vitest run`).
- Node floor `>=22.18` (node:sqlite `readOnly`).
- **Cooperative timeout contract** (M10a): a tool that declares `timeoutMs` MUST honor
  `exec.abortSignal`; the guard never force-cancels or races the tool promise.
- No `CURRENT_FORMAT_VERSION` bumps without an explicit milestone decision.
  `session-persistence-sqlite` `SCHEMA_VERSION` bumps go through the M5 migration chain
  (`MIGRATIONS[n]`, SAVEPOINT per step, one backup copy before the chain).
- Existing behavior unchanged when optional capability surfaces are not mounted.

## 4. M10a Delivered (guard milestone) — architecture tour

### 4.1 core-plugin — `ctx.cascade` / `ctx.onCascade`
Koa-style around-dispatch primitive, distinct from the value-producing `waterfall`:
`cascade<TInput,TOutput>(event, input, final)` runs `onCascade` handlers outside-in around `final`;
`next()` returns the inner result; skipping `next()` short-circuits (legal); double-`next` throws.
**Ancestor-visible** (final-review decision): `dispatchCascade` walks root→self, so root-registered
handlers wrap child-scope dispatches (mirrors `emit`/`checkGuards`/`resolveDecision`). No handlers
→ `final()` runs directly.

### 4.2 core-tools — `tools/execute` around-seam
`createToolRegistry(ctx).execute(call)` step 4 runs `ctx.cascade("tools/execute",
{ name, args, exec, tool }, () => tool.execute(args, exec))`. `Tool.timeoutMs?` and
`ToolExec.abortSignal?` enforced by the timeout guard. Pre-execute / decision / guards /
approval / post-execute unchanged.

### 4.3 core-session
- `user/message` gains optional `source?: { kind: "plugin"; plugin: string }` (additive).
- `deriveSearchText(ev): string` (M10b): user/assistant text, tool/call args JSON, tool/result
  output JSON (`?? ""` for undefined payloads), subagent/inbox message; control events +
  assistant/chunk → `""`.

### 4.4 core-agent — `agent/post-tool` (ordering invariant)
`tool_call` branch: `tools.execute` → abort check → append `tool/result` → emit
`agent/post-tool { name, args, output, session }`. **Emit AFTER the append** — a listener-appended
`user/message` must land after the result so `deriveMessages` renders
`assistant(toolCalls) → tool(result) → user(reminder)` (OpenAI-style providers reject a user
message between a tool_calls block and its results). Documented in spec §4.

### 4.5 exec — `ExecCommand.abortSignal`
External cancel kills the process tree via a shared module-level `killTree(child)` (win32
`taskkill /T /F`, else `process.kill(-pid)`). Abort is NOT a timeout (`timedOut` stays false).

### 4.6 shell — timeoutMs + signal threading
`createShellTools({ exec, timeoutMs? })` declares `timeoutMs` on bash/pwsh; foreground executes
forward `abortSignal: exec.abortSignal` into `exec.run`. `registerShell(ctx, registry, { timeoutMs })`.

### 4.7 `@i-harness/guard-timeout`
`onCascade("tools/execute")`: swaps `exec.abortSignal` for a timer-backed derived controller
(linked to upstream; an upstream abort is NOT our timeout), substitutes `{ ...raw, error,
code: TOOL_TIMEOUT }` on our timer firing, catches rejecting tools (still substitutes when timed
out), restores upstream in `finally`. Marker reads at `tool/result.output.code`.

### 4.8 `@i-harness/guard-repeat-tool`
`on("agent/post-tool")` advisory listener: canonical key = `toolName + JSON.stringify(args)`,
per-session `WeakMap<Session, {key, count}>`, `include`/`exclude` `*`-wildcard patterns,
thresholds `[3, 5, 8]` (validated), appends plugin-source `user/message` on each hit.

### 4.9 CLI (`apps/cli/src/run.ts`)
`runHeadless` mounts: shell (timeoutMs 120s default), fs tools, approval policy,
`guard-timeout` + `guard-repeat-tool`, tool-search, fs-search, and (M10b) session-query tools
when `sessionQuery` is provided. `HeadlessResult` exposes `session?`.

## 5. M10b Delivered (session-query milestone) — architecture tour

### 5.1 `session-persistence-sqlite` schema v2 + FTS
- `SCHEMA_VERSION` 1→2; `MIGRATIONS[1]` creates `events_fts` (FTS5:
  `session_id/seq/event_type/time` UNINDEXED, `text` indexed, `unicode61`) and backfills existing
  events via `deriveSearchText`. Fresh DBs get the table via the `openDatabase` DDL block.
- `append` writes FTS rows in the SAME transaction as event rows (index never diverges).
- `repair` runs ONE atomic transaction: closer inserts (if any) + revision bump + FTS
  DELETE/re-insert from the final event list.

### 5.2 `@i-harness/session-query` (new package)
- `createSessionQuery(dbPath)` opens a READ-ONLY `DatabaseSync`; `closeSessionQueries()` releases
  handles (Windows file locks).
- `search(query, { sessionId?, subtreeOf?, limit? })` → BM25-ordered `SearchHit[]` with snippets
  (`snippet(events_fts, 4, ...)`), FTS5-injection-safe sanitization (every whitespace token →
  quoted phrase, embedded quotes doubled, implicit AND; blank → `[]`), limit clamp 20/100
  (validated integer ≥ 1), sessionId/subtreeOf filters (**union/OR** when both, pinned in spec §3.2).
- `lineage(sessionId, { direction, depth? })` → ancestors (nearest-first, cycle-detected),
  descendants (BFS, depth = levels below), children; `hasChildren` via one grouped query;
  unknown session / invalid depth / invalid direction → throw.
- Capability-gated fail-closed: a DB without `events_fts` throws a clear error.
- `createSessionQueryTools(query)` → **`session_search`** (output `{ hits: SearchHit[] }`) and
  **`lineage`** (output `{ nodes: LineageNode[] }`), both `isReadOnly: true`, errors throw
  (→ CLI exitCode 1).

### 5.3 CLI wiring
`HeadlessOptions.sessionQuery?: SessionQuery` — when provided, the CLI mounts the two tools
(sqlite-only fail-closed; absent → tools not mounted, behavior unchanged).

## 5b. M11 Delivered (compaction milestone) — architecture tour

### 5b.1 core-session
- Three new `SessionEvent` members: `compaction/start`, `compaction/end`,
  `compaction/summary { text, shadowedSeqs }` (additive vocabulary; no
  `CURRENT_FORMAT_VERSION` bump). `compaction/*` events ARE registered in
  `session-persistence`'s `KNOWN_EVENT_TYPES` (final-review Critical fix — a
  missing registration made loading any persisted compacted session throw).
- `deriveMessages` shadow projection: a pre-pass collects every
  `compaction/summary.shadowedSeqs` into a Set; the render pass skips those
  seqs and renders the summary as a user message. Old logs without compaction
  events derive identically to today.
- `deriveSearchText`: `compaction/summary` → text (the summary is FTS-searchable);
  start/end → `""`.

### 5b.2 `@i-harness/compaction` (new package)
- `resolveConfig` (fail-loud; defaults: `thresholdRatio` 0.8, `retainTokens` 0,
  `maxTokens` 1024, `auto` true), `approxTokens` (ceil(chars/4)), `activeTokens`
  (sum over derived message contents), `selectShadowableRange` (events strictly
  before the first retained event; compaction markers never shadowed).
- `createCompactionEngine({ model, config })` → `maybeCompact` (pressure-gated:
  `activeTokens >= contextWindow × thresholdRatio`, PLUS a **re-fire guard** —
  no compaction until new non-marker events are appended past the last
  `compaction/end`; this prevents summary-driven hot loops) / `compact`
  (explicit, ungated).
- ModelClient summarizer with the dsh-style structured COMPACTION_INSTRUCTION
  (8 Markdown sections); fail-soft on throw/empty output with a `console.warn`
  (no events appended).
- On success appends `compaction/start` → `compaction/summary` →
  `compaction/end` (durable through the session's onAppend hook).

### 5b.3 core-agent
- `AgentConfig.compact?: CompactionConfig`; engine built once at construction
  from `deps.model`. Step-boundary pressure check (after `append(step/start)`,
  before `deriveMessages`, gated by `auto`). `Agent.compact?()` — optional in
  the interface (7 agent fakes across the repo would break otherwise); runtime
  contract unconditional (no-op result without config). No config → no engine →
  byte-identical behavior.

### 5b.4 CLI
`HeadlessOptions.compact?: CompactionConfig` pass-through. Auto-compaction
works headless; resume of a persisted compacted session projects the summary
(e2e-verified — the C1 regression).

## 5c. M12 Delivered (retry-on-timeout + result retention) — architecture tour

### 5c.1 `@i-harness/output-retention` (new pure library)
- `TextRetainer` with `head` / `headTail` modes (`headRatio` default 0.5),
  UTF-8/surrogate-safe trimming (binary search over whole code units; a
  multi-byte char is never split and unpaired surrogates are never emitted,
  even from malformed input), exact `truncated` / `omittedBytes`, fail-loud
  typed config validation (defaults only on `undefined`; `typeof` /
  `Number.isFinite` checks incl. Infinity pinning).
- Config snapshot at construction; a 1,800-case invariant sweep pinned
  head/tail byte-disjointness and whole-character boundaries.

### 5c.2 `@i-harness/guard-retry` (new package)
- `createRetryGuard(ctx, config?)` — a `tools/execute` cascade handler OUTER
  to `guard-timeout` that retries ONLY when the CASCADE raw value's
  `code === TOOL_TIMEOUT` (the M10a marker), with exponential backoff + jitter.
- **Re-entrancy guard** (WeakSet keyed by the per-execute dispatch object):
  `next()` is one-shot, so a retry RE-INVOKES `ctx.cascade` with a
  reconstructed final — the WeakSet bounds attempts to exactly `1 + maxRetries`
  (nested frames delegate without re-entering the loop; the exhaust test pins
  3 attempts for `maxRetries: 2`). Concurrency-safe for parallel tool calls.
- Re-dispatch is a **deliberate seam-bypass**: it re-runs ONLY the cascade
  handlers, skipping `registry.execute`'s pre-execute hooks, monotonic guards,
  and post-execute (approval was already granted; only the final result should
  hit post-execute) — documented in a comment at the call site.
- Config fail-loud (`maxRetries >= 0` int, delays `>= 0` ints, `jitterRatio`
  in `[0, 1)`); `backoffDelay` pure with monotonic growth + cap + jitter band.

### 5c.3 shell
- `createShellTools({ exec, timeoutMs?, retention? })`: exec keeps the FULL
  stream; the tool-return layer retains stdout/stderr via fresh per-run
  `TextRetainer`s and adds `truncated: { stdoutBytes, stderrBytes }` only when
  something was omitted. **No-retention path returns EXACTLY today's shape**
  `{ stdout, exitCode }` (a fix round dropped an unconditional stderr
  addition). `registerShell` threads retention.
- Minor (safe to defer): per-run retainers re-read `deps.retention!.maxBytes`
  live rather than from the creation-time snapshot; a host mutating deps
  between creation and execution would see inconsistent config.

### 5c.4 CLI
- `HeadlessOptions.shellRetention?` — shipped default `{ maxBytes: 64_000 }`
  headTail (parallel to `shellTimeoutMs` 120s); a host wanting no cap passes
  `{ maxBytes: Number.MAX_SAFE_INTEGER }`. `retry?: RetryConfig` is OPT-IN
  (mounted only `if (opts.retry)`) and mounted BEFORE `createTimeoutGuard`
  (first-registered = OUTERMOST — retry sees the substituted TOOL_TIMEOUT).
- E2e: a guard-file command times out on the first attempt and succeeds on the
  retry (`existsSync(flag)` + final `output.code` undefined — genuinely
  discriminates retry-on from retry-off; the brief's original stdout-only
  assertion was a false positive); a verbose command is truncated with the
  marker. Retry e2e uses `shellTimeoutMs: 300` (200 flaked on slow CI).

## 5d. M13 Delivered (parallel tool-call execution) — architecture tour

### 5d.1 core-plugin (2 additive changes)
- `ctx.emit(event, payload)` now returns the local scope's final waterfall chain
  value (additive; callers ignore the return pre-M13). This lets the registry
  read the pre-execute decision per-dispatch instead of a shared closure slot.
- `PluginContext.resolveAncestorDecision(event, payload)` — ancestor-only
  decision lookup (skips self). REQUIRED because `resolveDecision` reads the
  per-scope `decisions` map, which is itself a shared slot that races under
  concurrent emits (the M13 decision-slot race); the local decision now arrives
  per-dispatch from `emit`'s return.

### 5d.2 core-tools — staged execution machinery
- `prepare(call, signal?)` (policy layer: pre-execute decision from `emit`'s
  return + `resolveAncestorDecision` merge + monotonic guards + approval +
  `exec.abortSignal` seeding) / `dispatch(prepared)` (the `tools/execute`
  cascade over the body — the ONLY overlapping stage) / `finalize(prepared,
  output)` (post-execute + wrap). `execute(call, opts?)` is a thin sequential
  wrapper — byte-identical for every existing caller.
- **Decision-slot fix**: the shared `let decision` closure is gone; the
  once-registered waterfall handler RETURNS the validated candidate (or
  `undefined` when no decision — the **parent-propagation invariant**: a parent
  scope's guard-approval must still receive the ToolCall payload, else it stops
  classifying child-scope dispatches and approval fails open).

### 5d.3 core-agent — bounded rolling-pool scheduler
- `executeToolCalls(ctx, session, tools, batch, { maxParallel, signal })`:
  partitions the batch into groups (maximal runs of `isConcurrencySafe` calls;
  exclusive calls are singleton groups — they never overlap anything); runs
  `prepare`/`finalize` in an ORDERED lane with only `dispatch` overlapping up
  to `maxParallel`; commits results via a **head-of-line cursor** in MODEL
  order (tool/result + agent/post-tool always model-ordered regardless of
  settlement order). Failure = drain + rethrow first error (throw-fails-turn,
  no fabrication). Abort = drain started (commit settled), synthesize
  `TOOL_ABORTED_BEFORE_DISPATCH` results for never-started calls, then throw
  `agent aborted` (abort dominates a coincident finalize throw).
- The agent loop now COLLECTS a step's tool calls (appends `tool/call` during
  streaming) and hands the batch to the scheduler after the stream ends.
  `AgentConfig.maxParallelToolCalls?` (default 10, fail-loud integer >= 1; `1`
  = fully serial).

### 5d.4 guard-retry
- Abort-aware backoff: captures the ORIGINAL caller signal before `next()` (the
  timeout guard swaps `exec.abortSignal` to its own controller on timeout) and
  breaks the retry loop when the step aborts — no re-dispatch under a cancelled
  step.

### 5d.5 opt-ins + CLI
- `fs` `read`/`list_dir`, `fs-search` both tools, `session-query`
  `session_search`/`lineage` set `isConcurrencySafe: true` (fail-closed
  default: absent/false ⇒ exclusive). `subagent` tools deliberately NOT opted
  in (parallel subagents are a separate roadmap item).
- CLI: `HeadlessOptions.maxParallelToolCalls?` pass-through (agent default 10;
  a shipped default like `shellTimeoutMs` 120s / `shellRetention` 64k).

## 6. Execution Rulings Made (recorded in spec/plan docs)

1. **M10a — TOOL_TIMEOUT marker location**: top-level `{ ...result, error, code }` (reads at
   `result.output.code`), not the spec's original `output:` nesting. Spec §5 amended.
2. **M10a — `agent/post-tool` emits AFTER `tool/result` append** (provider message-ordering). Spec §4 amended.
3. **M10a — cascade is ancestor-visible** (root outermost). User-approved during final review.
4. **M10b — combined `sessionId` + `subtreeOf` filters UNION (OR).** Spec §3.2.
5. **M10b — tool outputs are wrapper objects `{ hits }` / `{ nodes }`** (consistent with existing
   object-returning tools), not bare arrays. Spec §3.4.
6. **M11 — `maxTokens` is a positive integer (≥ 1); `retainTokens` non-negative.** Spec §G amended.
7. **M11 — `Agent.compact` is OPTIONAL in the interface** (runtime contract unconditional);
   spec §3 amended.
8. **M11 — `maybeCompact` re-fire guard** (no compaction until new non-marker events past the
   last `compaction/end`); `compact()` ungated. Spec §2.3.
9. **M11 — fail-soft summarizer failures log a `console.warn`.** Spec §2.5.
10. **M12 — retry mount order**: first-registered = OUTERMOST in `ctx.cascade`
    (pinned by `cascade.test.ts`); `createRetryGuard` MUST be mounted BEFORE
    `createTimeoutGuard` (retry outer, timeout inner) to see the substituted
    `TOOL_TIMEOUT`. Spec §4/§5.2 and the plan's step-3 code block originally
    said "after" — corrected in the final-gate fix wave.
11. **M12 — retry is OPT-IN** (`if (opts.retry) ctx.mount(...)`): unconditional
    mounting would silently re-run timed-out commands for every host.
12. **M12 — no-retention shell result = today's exact shape** `{ stdout, exitCode }`
    (no `stderr` key added when retention is off).
13. **M13 — Ruling A (failure)**: tool failure ⇒ throw-fails-turn (drained);
    dsh-style `isError` model-visible results deferred to a future robustness
    milestone.
14. **M13 — Ruling B (staged scheduler)**: only the tool body overlaps;
    `prepare`/`finalize` (the policy layer) stay in an ordered lane; `execute`
    is a thin wrapper over the stages.
15. **M13 — parent-propagation invariant**: the registry's pre-execute waterfall
    handler returns `undefined` (NOT `{ kind: "allow" }`) when no decision, so a
    parent scope's guard-approval keeps classifying child-scope ToolCall
    payloads (no fail-open for subagent paths).
16. **M13 — `resolveAncestorDecision`**: ancestor-only decision lookup; the
    local decision is per-dispatch from `emit`'s return (the per-scope
    `decisions` map races under concurrent emits).

## 7. Deferred Follow-ups (reconstructed from SDD ledgers; triaged by final reviews)

### M10a deferred minors (all triaged "Safe to defer" or fixed)
- FIXED in final wave: upstream abort listener removal; rejecting-tool catch; CLI repeat e2e
  per-test timeout.
- Still open (safe to defer): typed `ToolsExecuteDispatch` export from core-tools (downstream
  handlers hand-cast); cascade tests for input pass-through/error-propagation/mid-dispatch
  snapshot; guard-timeout spread-preservation test; guard-repeat-tool patternToRegExp
  precompile + negative previewChars + surrogate-pair slice; "aborted dispatch produces no
  post-tool" direct test; repeat e2e only exercises threshold 3; `output.error` wording coupling.

### M10b deferred minors (triaged; T3/T4 fixed in final wave)
- FIXED in final wave: true mid-transaction rollback test; search contract tests (BM25 order,
  quote escaping, union filter, limit clamp, capability via lineage); invalid-direction tool test;
  core-plugin → devDependencies; limit finite-integer validation.
- Still open (safe to defer): deriveSearchText step/start + turn/end direct assertions;
  migration/fresh tests' temp-dir rmSync hygiene; tool tests for session_id/subtree_of/limit/depth
  passthrough + inputSchema assertion; CLI e2e sqlite-setup-outside-try (Windows handle risk if
  setup throws — worth a fixture refactor before relying on Windows CI).

### M11 deferred minors (triaged; C1/I1/I2 fixed in final wave)
- FIXED in final wave: `KNOWN_EVENT_TYPES` registration + load-tolerates test + resume e2e (C1);
  re-fire guard + representative e2e config (I1); `console.warn` on summarizer failure (I2).
- Still open (safe to defer): T1 pre-pass braces + summary-interrupts-tool-block flush test;
  T2 region exact-boundary test + `ev.seq ?? i` dead-code fallback; T3 tests for
  `summarizationModel` override / multi-chunk accumulation / empty-range no-op; T3 surrogate-pair
  split in trimToTokens; T5 loose cast + import ordering.
- Parked (final re-review observations): the re-fire guard counts zero-text control events
  (step/start|end) as "new work" — in a multi-step turn with the hot-loop shape it re-fires per
  step (bounded by maxTurns, not infinite); no test pins the fail-soft warn text; sqlite backend
  doesn't merge row seq into parsed events on read (pre-existing).

### M12 deferred minors (triaged by final whole-branch review; C/I fixed in the fix wave)
- FIXED in final wave: retry e2e `shellTimeoutMs` 200→300 (slow-CI flake risk, matches M10a);
  spec §4/§5.2 + plan step-3/test-section mount-order wording corrected to "BEFORE / outer";
  seam-bypass comment at the re-dispatch call site.
- Still open (safe to defer): `backoffDelay` public signature leaks non-exported
  `ResolvedRetryConfig` (no declaration emit today; `resolveConfig` is idempotent so
  `RetryConfig` suffices); `sleep` not abort-aware (one wasted re-dispatch after an upstream
  cancel — no corruption); shell per-run retainers read `deps.retention` live instead of the
  creation-time snapshot; unused direct dep `@i-harness/output-retention` in `apps/cli`
  (`run.ts` only imports the type from `@i-harness/shell`); duplicate `fakeExec` helpers in
  `packages/shell/test/shell.test.ts`; `trimToBytes` is O(n log n) with per-probe string
  allocation (fine at 64k, note for multi-MB); two untested edges — surrogate pair split ACROSS
  chunks and two different tools timing out concurrently (both work by construction).

### Design-level observations (worth documenting/deciding)
- **M10a**: 120s default shell deadline is a shipped behavior change (>2min bash dies unless
  `shellTimeoutMs` raised); repeat counter resets on session resume (WeakMap keyed by session
  object); mid-step reminder splits an assistant tool_calls block (protocol-valid, semantically
  distorting — consider buffering to step/end); seam contract ambiguity on `tools/execute`
  (raw-value convention — pin via the typed dispatch export).
- **M10b**: the M5 migration backup is `copyFileSync(path, path + ".bak")` which can be
  incomplete for WAL data — a SQLite backup/checkpoint strategy (`sqlite.backup`) is safer for
  production recovery. Consider as future hardening.
- **M11**: the compaction summarizer shares the agent's model client (script-based mocks would
  be consumed by summarizer calls — tests use inline structural ModelClients); the auto-compact
  e2e config must keep `maxTokens < threshold` to stay representative (not the hot-loop shape).
- **M12**: intermediate retry attempts are INVISIBLE in the session log (no new event types —
  by design, but spec §5.4 anticipated showing the retry; consider an observability hook such as
  a listener event or a `retries` count in the tool result for the next milestone); the CLI's
  default `shellRetention` (64k headTail) means the CLI always changes bash/pwsh tool-result
  shape for hosts that don't pass `shellRetention` — the plan rules this in (parallel to the
  120s shellTimeoutMs default) but it sits in tension with the spec's "behavior unchanged when
  retention is not configured" constraint, which strictly holds only at `createShellTools`.
- **M13**: the shared per-scope `decisions` map is read at `prepare` time via
  `resolveAncestorDecision`; two child scopes sharing a parent (parallel subagents) could
  interleave ⇒ fail-open window. UNREACHABLE in M13 (subagent tools are exclusive) and
  pre-existing pre-M13 — but becomes reachable when `parallel-subagent-delegations` (M18+)
  lands; revisit with per-emit scoping then. Also: intermediate parallel tool attempts are
  invisible to the session log (same observability gap as M12 retry); multi-call steps change
  the LOG interleaving from interleaved to batched (model-visible surface byte-identical,
  verified via `deriveMessages`); abort-during-collection can orphan `tool/call` events
  (cancellation edge, derived surface tolerates it).

### M13 deferred minors (triaged by final whole-branch review; C/I fixed in the fix wave)
- FIXED in final wave: `maxParallel: 1` serial-regression test (parallel-safe tools);
  agent-level Ruling-B policy-lane ordering pin; abort-before-any-start synthesis test;
  `startedUpTo` advanced after `prepare` succeeds; spec §2.4 `TOOL_ABORTED_BEFORE_DISPATCH`
  export location corrected to `@i-harness/core-agent`.
- Still open (safe to defer): `emitFn`'s `?? chainPayload` fallback is provably unreachable
  (`runWaterfall` self-falls-back); the ancestor `decisions` map cross-child race (see M13
  design observation — revisit at M18); the agent-level Ruling-B pin uses same-named `read`
  calls so its ordering assertions are permutation-insensitive (the ordering property is pinned
  transitively at the scheduler with distinguishable names); guard-retry's comment overstates
  the timeout-guard restore hazard (capture-before-`next()` is defensively robust) and a
  mid-backoff abort can still trigger one re-dispatch (brief-mandated placement); session-query
  flag test spins a real sqlite backend for a construction-time assert; fs-search flag test uses
  positional destructuring; first CLI e2e test lacks pass-through discriminating power (the
  rejection test proves wiring); redundant `executeToolCalls` import+re-export in core-agent index.

## 8. Next Milestones

- The M7 milestone sequence ("jobs upgrade (M9), guard/session-query (M10), compaction (M11),
  retry/retention (M12), parallel tool calls (M13)") is now complete. Per the parity audit's
  user-decided roadmap, **M14 = Token meter service + per-model context catalog** (hardens M11
  compaction, enables budget checks + overflow recovery) is next.
- Candidate next work (from the audit roadmap + M10a/M11/M12/M13 specs' Out-of-Scope and ledgers):
  - **M14: Token meter service + per-model context catalog** — audit roadmap item 3.
  - **M15: Sandbox** (Linux Landlock/bwrap; Windows restricted token) — audit roadmap item 4;
    the runtime-design deferred "pluggable later" safety layer.
  - **M16/M17: MCP client / LSP** — audit roadmap items 5-6 (the opencode-fork plugin ports).
  - **M18: Subagent teams** — audit roadmap item 7; NOTE the M13 design observation: the shared
    per-scope `decisions` map's cross-child race becomes reachable with
    `parallel-subagent-delegations` — revisit `resolveAncestorDecision` with per-emit scoping.
  - **Context-overflow recovery / remote compaction** (codex-style) — M11's §Out-of-Scope.
  - **Retry/parallel observability** (M12/M13 final reviews): a listener event or `retries` count
    in the tool result so retried/parallel tools are visible in session traces without a new event
    type.
  - **Per-model compaction policy routing** (dsh `modelPolicies`).
  - **`KNOWN_EVENT_TYPES` recommendation from the M11 final review**: make registering new
    additive event types a mandatory step with a coordinator round-trip test.
  - Agent-aware tool execution (`tools.get(name, agent)`) — explicitly NOT adopted.
  - Deferred: TUI/Web/Desktop; llm-gemini/llm-bedrock; workflows; skills-as-plugins; telemetry.

### Process for the next milestone
- Established pattern: **brainstorming → spec → writing-plans → SDD execution**
  (fresh subagent per task + task review + final whole-branch review), working directly on `master`
  (user consent already given for this project).
- Docs: `docs/superpowers/specs/YYYY-MM-DD-i-harness-<milestone>-design.md` and
  `docs/superpowers/plans/YYYY-MM-DD-i-harness-<milestone>.md`.
- SDD workspace lives at `/.superpowers/sdd/<plan-basename>/` (gitignored); a new plan creates its own.
- **Infrastructure quirk observed**: subagent dispatches occasionally return an EMPTY result
  (no report file, no commit) even though the task session reports completed — verify the report
  file AND a commit exist after every implementer dispatch before reviewing; re-dispatch if empty.
- Fix loops worked well: Task 6 needed 2 fix rounds (the first "fix" was ambiguous — always
  verify a negative test actually distinguishes the failure modes it claims to guard).

## 9. Package Map (for orientation)

- **Core kernel**: `core-plugin` (ctx/scopes/listeners/waterfalls/cascades/guards/services),
  `core-tools` (registry + execute pipeline), `core-agent` (runTurn loop), `core-session`
  (session events + deriveMessages + deriveSearchText), `exec` (subprocess), `shell` (bash/pwsh).
- **Policy/guards**: `guard-approval`, `guard-timeout`, `guard-repeat-tool`, `interaction`,
  `preset`, `tool-search`.
- **Persistence + query**: `session-persistence` (backend seam + coordinator + write-behind +
  `KNOWN_EVENT_TYPES`), `session-persistence-jsonl`, `session-persistence-sqlite` (schema v2 +
  events_fts), `session-query` (search + lineage + tools).
- **Context management**: `compaction` (config, token estimation, region selection, engine,
  summarizer), wired into `core-agent`'s optional `compact` seam.
- **Models**: `llm-seam`, `llm-openai`, `llm-anthropic`, `llm-openai-compatible`, `llm-mock`,
  `provider`.
- **Filesystem**: `fs`, `fs-search`.
- **Subagents (M8/M9)**: `subagent` (child scopes, roles, tools, jobs, persistence, cold-resume).
- **App**: `apps/cli` (`run.ts` = headless runHeadless; `cli.test.ts` = e2e).
