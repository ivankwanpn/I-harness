# Handoff — I-harness @ M10a Complete (2026-08-18)

> Handoff for a new session continuing development of the I-harness project.
> Repo: `D:\agent-complete\I-harness` (pnpm monorepo, git on `master`).
> Working tree is clean at this commit: `a6b3a7d`.

## 1. Current State

- **Milestone M10a (guard: tool timeout + repeat reminder) is COMPLETE and on `master`.**
- All gates green at HEAD: `pnpm -r test` exit 0, `pnpm -r typecheck` exit 0.
- No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps; no new external dependencies
  (all package.json additions are `workspace:*`).
- 24 packages + 1 app (`apps/cli`). Environment: **Windows (Git Bash)**, Node >=22, ESM + strict TS, vitest.

### Recent commit history (M10a, oldest → newest)
```
37f81ae docs: M10a guard (tool timeout + repeat reminder) design spec
3bc4399 docs: M10a guard (tool timeout + repeat reminder) implementation plan
56aadb2 feat(core-plugin): ctx.cascade around-dispatch primitive
cb3144d feat(core-tools): tools/execute around-seam via ctx.cascade
995e5af feat(core-session,core-agent): user/message.source + agent/post-tool
23967c2 docs: M10a plan — TOOL_TIMEOUT marker at output.code (controller ruling)
174e53c feat(exec,shell): external abortSignal + tool timeoutMs threading
1c1efef feat(guard-timeout): cooperative tool timeout via tools/execute cascade
2a0e36a feat(guard-repeat-tool): advisory consecutive-repeat tool reminder
5505726 fix(core-agent): emit agent/post-tool after tool/result (ordering)
0a15688 docs: M10a spec §4 — lock agent/post-tool ordering invariant
c4d5390 feat(cli): mount guard-timeout + guard-repeat-tool, expose session
a6b3a7d fix: final-review wave — ancestor-visible cascade, timeout catch, ordering regression test, doc parity
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
- **Cooperative timeout contract**: a tool that declares `timeoutMs` MUST honor `exec.abortSignal`
  (settle promptly when it fires). The guard never force-cancels or races the tool promise —
  a hostile tool that ignores the signal hangs by design.
- No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps without an explicit milestone decision.
- Existing behavior unchanged when no guards are mounted / no tool declares `timeoutMs`.

## 4. What M10a Delivered (architecture tour)

### 4.1 core-plugin — `ctx.cascade` / `ctx.onCascade`
Koa-style around-dispatch primitive (`packages/core-plugin/src/index.ts`), distinct from the
value-producing `waterfall`:
- `cascade<TInput,TOutput>(event, input, final)` runs registered `onCascade` handlers outside-in
  around `final`; `next()` returns the inner result; skipping `next()` short-circuits (legal);
  calling `next()` twice throws. Plain listeners do NOT run in a cascade dispatch.
- **Ancestor-visible** (final-review decision): `dispatchCascade` walks the scope chain
  ROOT-FIRST → self-last, so root-registered handlers wrap child-scope dispatches (mirrors
  `emit` propagation / `checkGuards` union-of-ancestors / `resolveDecision` nearest-wins).
  No handlers anywhere → `final()` runs directly (byte-identical no-op path).
- Unmount reclamation covers `pluginCascades` (same pattern as listeners/waterfalls).

### 4.2 core-tools — `tools/execute` around-seam
`createToolRegistry(ctx)`'s `execute(call)` step 4:
```ts
const exec: ToolExec = {}
const output = await ctx.cascade(
  "tools/execute",
  { name: call.name, args: call.args, exec, tool },
  async () => tool.execute(call.args as never, exec),
)
```
Pre-execute waterfall / `resolveDecision` merge / monotonic guards / approval / post-execute
are UNCHANGED. `Tool.timeoutMs?` and `ToolExec.abortSignal?` already existed; the guard enforces them.

### 4.3 core-session — `user/message.source`
`SessionEvent` union: `user/message` gains optional `source?: { kind: "plugin"; plugin: string }`.
Additive, no version bump. `deriveMessages` renders it as plain user text (source is metadata).

### 4.4 core-agent — `agent/post-tool` (ordering invariant)
`runTurn`'s `tool_call` branch order (locking the invariant):
```ts
const result = await deps.tools.execute({ name, args })
if (abort?.aborted) throw new Error("agent aborted")
append(deps.session, { type: "tool/result", ... })
await ctx.emit("agent/post-tool", { name, args, output: result.output, session: deps.session })
```
**Why after the append**: a listener-appended `user/message` (the reminder) must land AFTER the
result, so `deriveMessages` renders `assistant(toolCalls) → tool(result) → user(reminder)`.
A `user` message between an assistant `tool_calls` block and its tool results is rejected by
OpenAI-style providers. Documented in spec §4.

### 4.5 exec — `ExecCommand.abortSignal`
External cancel kills the process tree via a shared module-level `killTree(child)` (win32
`taskkill /T /F`, else `process.kill(-pid)`). An abort kill is NOT a timeout (`timedOut` stays false;
caller sees the real exitCode `-1`). Both `timeoutMs` and `abortSignal` may be present (first wins).

### 4.6 shell — timeoutMs + signal threading
`createShellTools({ exec, timeoutMs? })` declares `timeoutMs` on bash/pwsh tools; each tool's
foreground `execute` forwards `abortSignal: exec.abortSignal` into `exec.run`. Background runs
unchanged. `registerShell(ctx, registry, opts?: { timeoutMs?: number })`.

### 4.7 `@i-harness/guard-timeout` (new package)
`onCascade("tools/execute")` handler. When `tool.timeoutMs` is set:
- swaps `exec.abortSignal` for a timer-backed derived `AbortController` (linked to upstream: an
  upstream abort is NOT our timeout), runs `next()`, restores the upstream signal in `finally`.
- On OUR timer firing: substitutes `{ ...rawResult, error, code: TOOL_TIMEOUT }` at the TOP level.
  The registry wraps the cascade value in `{ name, output }`, so the marker reads at
  `result.output.code` (the spec's original `output:` nesting would bury it — documented ruling).
- `catch` on the inner tool: if `timedOut`, still returns the structured substitution
  (a rejecting deadline tool must not abort the whole agent run).
- Upstream abort listener is named + `removeEventListener`'d in `finally` (leak hygiene).
- `export const TOOL_TIMEOUT = "TOOL_TIMEOUT"`.

### 4.8 `@i-harness/guard-repeat-tool` (new package)
`on("agent/post-tool")` listener, advisory (never vetoes):
- Canonical key = `toolName + JSON.stringify(args)`; per-session counter via
  `WeakMap<Session, { key, count }>` (Session has no durable in-memory id).
- `include`/`exclude` are `*`-wildcard patterns (anchored RegExp); exclude is transparent
  (no count, no reset). Default thresholds `[3, 5, 8]` (validated: non-empty ints ≥ 2, fail loud).
- On each threshold hit, appends a plugin-source `user/message`
  (`source: { kind: "plugin", plugin: "guard-repeat-tool" }`).

### 4.9 CLI wiring (`apps/cli/src/run.ts`)
`runHeadless` mounts: `registerShell(ctx, tools, { timeoutMs: opts.shellTimeoutMs ?? 120_000 })`,
fs tools, `createApprovalPolicy`, `ctx.mount(createTimeoutGuard(ctx))`,
`ctx.mount(createRepeatToolGuard(ctx))`, tool-search, fs-search. `HeadlessResult` exposes
`session?` for e2e assertions.

### 4.10 subagent (M8/M9) interaction
Child scopes (subagents) create their own registry/ctx and never `ctx.mount` plugins. Because
`cascade` is now **ancestor-visible**, the root-mounted `guard-timeout` DOES cover subagent tool
dispatches (this was the final-review cross-scope gap, fixed by user-approved option (a)).
`agent/post-tool` already covered subagents via `emit` upward propagation. Both guards are now
symmetric in scope.

## 5. Execution Rulings Made During M10a (recorded in spec/plan docs)

1. **TOOL_TIMEOUT marker location**: top-level `{ ...result, error, code }` (reads at
   `result.output.code`), not the spec's original `output:` nesting. Spec §5 amended.
2. **`agent/post-tool` emits AFTER `tool/result` append** (provider message-ordering). Spec §4 amended.
3. **Cascade is ancestor-visible** (root outermost). User-approved during final review.

## 6. Deferred Follow-ups (reconstructed from the deleted SDD ledger — carry forward)

### Code / test hardening (Safe to defer per final review, but worth doing eventually)
- Export a typed `ToolsExecuteDispatch` (`{ name, args, exec, tool }`) from core-tools so
  downstream `onCascade("tools/execute")` handlers stop hand-casting `unknown`.
- core-plugin cascade tests: add input pass-through, error-propagation-through-chain, and
  mid-dispatch snapshot coverage.
- core-tools observe test asserts `exec` `toEqual {}` — prefer `toBe` identity (future outer
  handlers may populate `exec.abortSignal`).
- guard-timeout: assert spread-preservation of the tool's own fields in the substitution test.
- guard-repeat-tool: `patternToRegExp` recompiles per emit (precompute at factory);
  `argumentsPreviewChars` negatives unvalidated (`Math.max(0, …)`); preview `slice` can split
  surrogate pairs (code-point-aware slice if the product cares).
- core-agent: directly test "aborted dispatch produces no `agent/post-tool` observation".
- CLI: repeat e2e only exercises threshold 3 of [3,5,8]; `output.error` assertion couples to
  guard wording (acceptable).

### Design-level observations worth documenting/deciding
- **120s default shell deadline is a shipped behavior change**: bash/pwsh commands > 2 min die
  unless `shellTimeoutMs` is raised. Worth a harness doc note.
- **Repeat counter resets on session resume** (WeakMap keyed by session object) — document for
  `resumeSessionId` flows.
- **Mid-step reminder splits an assistant tool_calls block**: a threshold hit mid-step flushes
  the tool block early (protocol-valid but semantically distorts history). Consider buffering
  reminders to flush at `step/end` later.
- **Seam contract ambiguity**: `tools/execute` cascade value is the RAW tool output; the Task-2
  substitute test uses a full `{ name, output }` shaped handler while guard-timeout substitutes
  the raw value. Pin the raw-value convention (ideally via the typed dispatch export).
- **Cosmetic**: `guard-timeout/package.json` declares `core-tools` as a runtime dep though `src/`
  only imports `core-plugin` (test-only); unused `_ctx` params in both guard factories are
  vestigial symmetry with `createApprovalPolicy`.
- **Parked (cosmetic doc drift)**: spec §5 snippet still shows an anonymous upstream listener
  without `removeEventListener`; shipped code uses a named handler + removal.

## 7. Next: M10b (session-query / SQLite FTS / lineage)

- Explicitly OUT OF SCOPE of M10a (see spec `docs/superpowers/specs/2026-08-18-i-harness-m10a-guard-design.md` §10):
  - session-query / SQLite FTS / lineage — separate spec + plan.
- Other future work the seams now enable:
  - Retry-on-timeout / sandbox-wrapping tools (the `tools/execute` cascade seam exists).
  - Agent-aware tool execution (`tools.get(name, agent)`) — explicitly NOT adopted.

### Process for the next milestone
- Follow the established pattern: **brainstorming → spec → writing-plans → SDD execution**
  (subagent per task + per-task review + final whole-branch review), working directly on `master`
  (user consent already given for this project).
- Docs live in `docs/superpowers/specs/` (design specs) and `docs/superpowers/plans/`
  (implementation plans), named `YYYY-MM-DD-i-harness-<milestone>-design.md` / `-plan.md`.
- **Infrastructure quirk observed**: subagent dispatches occasionally return an EMPTY result
  (no report file, no commit) even though the task session reports completed — two occurred
  (Task 3 first dispatch, Task 6 first dispatch). After every implementer dispatch, verify the
  report file AND a commit exist before reviewing; if not, re-dispatch a fresh subagent.
- The SDD ledger workspace (`/.superpowers/sdd/<plan>/`) is gitignored scratch; a new plan
  creates its own.

## 8. Package Map (for orientation)

- **Core kernel**: `core-plugin` (ctx/scopes/listeners/waterfalls/cascades/guards/services),
  `core-tools` (registry + execute pipeline), `core-agent` (runTurn loop), `core-session`
  (session events + deriveMessages), `exec` (subprocess), `shell` (bash/pwsh tools).
- **Policy/guards**: `guard-approval`, `guard-timeout`, `guard-repeat-tool`, `interaction`,
  `preset`, `tool-search`.
- **Models**: `llm-seam` (interfaces), `llm-openai`, `llm-anthropic`, `llm-openai-compatible`,
  `llm-mock`, `provider`.
- **Persistence**: `session-persistence`, `session-persistence-jsonl`, `session-persistence-sqlite`.
- **Filesystem**: `fs`, `fs-search`.
- **Subagents (M8/M9)**: `subagent` (child scopes, roles, tools, jobs, persistence, cold-resume).
- **App**: `apps/cli` (`run.ts` = headless runHeadless; `cli.test.ts` = e2e).
