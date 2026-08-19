# Handoff — I-harness @ M10a + M10b + M11 Complete (2026-08-20)

> Handoff for a new session continuing development of the I-harness project.
> Repo: `D:\agent-complete\I-harness` (pnpm monorepo, git on `master`).
> Working tree is clean at this commit: `2e1e51e`.

## 1. Current State

- **M10a (guards: tool timeout + repeat reminder) — COMPLETE, on `master`.**
- **M10b (session-query: SQLite FTS + lineage) — COMPLETE, on `master`.**
- **M11 (compaction: context-pressure auto + manual compact) — COMPLETE, on `master`.**
- All gates green at HEAD: `pnpm -r test` exit 0, `pnpm -r typecheck` exit 0.
- No `CURRENT_FORMAT_VERSION` / event-vocabulary changes since M10b's `compaction/*` addition (M11, additive; the M9 `subagent/inbox` and M11 `compaction/*` events ARE registered in `session-persistence`'s `KNOWN_EVENT_TYPES` — this matters for persistence!). The ONLY schema bump is `session-persistence-sqlite` `SCHEMA_VERSION` 1→2 (M10b, via the M5 migration chain).
- Root `engines.node` is `>=22.18` (required by `node:sqlite`'s `readOnly` option).
- All package.json additions are `workspace:*` — no new external dependencies.
- 26 packages + 1 app (`apps/cli`). Environment: **Windows (Git Bash)**, Node v24, ESM + strict TS, vitest.

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

## 8. Next Milestones

- The M7 milestone sequence ("jobs upgrade (M9), guard/session-query (M10), compaction (M11)")
  is now complete. M12 is unassigned.
- Candidate next work (from the M10a/M11 specs' Out-of-Scope and ledger):
  - **Retry-on-timeout / sandbox-wrapping tools** — the `tools/execute` cascade seam exists.
  - **Context-overflow recovery / remote compaction** (codex-style) — M11's §Out-of-Scope.
  - **Per-model compaction policy routing** (dsh `modelPolicies`).
  - **Compaction progress hooks/UI** (headless library + tools exist).
  - **`KNOWN_EVENT_TYPES` recommendation from the M11 final review**: make registering new
    additive event types a mandatory step with a coordinator round-trip test (would have caught
    the M11 C1 immediately).
  - Agent-aware tool execution (`tools.get(name, agent)`) — explicitly NOT adopted.

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
