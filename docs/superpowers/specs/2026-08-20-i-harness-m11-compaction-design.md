# M11 — Compaction: context-pressure auto-compaction + manual compact

Design spec for the M11 milestone. Status: Approved by user (brainstorming;
decisions confirmed — token-based auto trigger with built-in approx estimator +
config-provided context window, ModelClient structured summary reusing the agent
model, new `@i-harness/compaction` package wired into core-agent via an optional
seam, new `compaction/*` event vocabulary, log-preserving surface shadowing).

## Context

I-harness's `runTurn` loop feeds `deriveMessages(session)` (the full event log
projected to model messages) to the model every step. There is no context
management: a long session grows the prompt unboundedly until the provider
rejects it.

Reference implementations all converge on the same shape:
- **deepseek-harness (primary reference)**: `compact: { thresholdRatio,
  retainTokens/retainRatio, summarizationProvider/Model, maxTokens,
  compactionRetries }`; token pressure via a token meter vs the model context
  window; auto trigger at `thresholdRatio` of the window; one-shot LLM
  summarization into a structured checkpoint (`<compacted-summary>` blocks with
  sections: Primary Request / Key Technical Concepts / Files and Code / Errors
  and Fixes / Pending Jobs / Current Work / Next Step / Critical Context); new
  log events `compaction/start` / `compaction/end` / `compaction/summary`
  (summary carries `shadowedSeqs`); the model-facing surface replaces the
  shadowed range with the summary while the raw log keeps every event.
- **codex**: `CompactionTrigger::Auto` when `active_context_tokens >=
  context_window`, `approx_token_count` estimation, `SUMMARIZATION_PROMPT` +
  `SUMMARY_PREFIX`, `Session::replace_compacted_history`.
- **cc-custom (opencode fork)**: `getEffectiveContextWindowSize` (window minus
  reserved output tokens), buffer thresholds, `compactConversation` → summarize
  → replace history.
- **grok-build**: `compaction_at_tokens` threshold.

This milestone builds the I-harness equivalent on the existing session/
persistence/query substrate (including the M10b FTS index, which keeps shadowed
events searchable).

## Global Constraints (binding)

- **This project does NOT use bun.** No `@ai-sdk/*` dependencies. No new
  external dependencies (only `workspace:*` links).
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- Node floor `>=22.18`.
- No `CURRENT_FORMAT_VERSION` bump. The `compaction/*` event types are additive
  vocabulary within the existing event union (precedent: M9 added
  `subagent/inbox`). Old logs without compaction events parse normally.
- **Log-preserving**: compaction NEVER deletes or rewrites existing events. The
  durable log and the M10b FTS index keep everything; only the model-facing
  surface (the `deriveMessages` projection) replaces the shadowed range with the
  summary.
- Behavior unchanged when compaction is not configured (`compact` absent →
  core-agent runs exactly as today).
- Config is validated at engine construction (fail loud): `contextWindow`
  required positive integer; `thresholdRatio ∈ (0, 1]`; `retainTokens`
  non-negative integer; `maxTokens` positive integer (≥ 1). No hardcoded
  tunables — every default is a Config field.

## §1 core-session — event vocabulary + surface projection

### 1.1 New event types

`SessionEvent` union gains three members:

```ts
| { type: "compaction/start"; seq?: number }
| { type: "compaction/end"; seq?: number }
| { type: "compaction/summary"; text: string; shadowedSeqs: number[]; seq?: number }
```

- `compaction/summary.text` = the model-generated structured summary.
- `compaction/summary.shadowedSeqs` = the seqs of the events the summary
  replaces on the surface.
- `append`'s `assistant/message` source-guard is untouched; `toJSONL` /
  `fromJSONL` round-trip these like any event.

### 1.2 `deriveMessages` — shadow-aware projection

Two-pass render:

1. **Pre-pass**: scan the log once; collect every `compaction/summary`
   `shadowedSeqs` into a `Set<number>`.
2. **Render pass**: iterate events; skip any event whose `seq` is in the
   shadowed set; on `compaction/summary` flush the pending tool block and push
   `{ role: "user", content: summary.text }`; `compaction/start` and
   `compaction/end` produce nothing.

Resulting surface for a compacted session: the summary stands where the old
turns were, followed by the post-compaction turns. A session with no compaction
events derives identically to today.

### 1.3 `deriveSearchText`

- `compaction/summary` → `summary.text` (the summary itself is searchable).
- `compaction/start` / `compaction/end` → `""` (control markers).

## §2 `@i-harness/compaction` package (new)

`packages/compaction/` — package shape mirrors `guard-approval`. Runtime deps:
`@i-harness/core-session` (Session, append, deriveMessages, deriveSearchText)
and `@i-harness/llm-seam` (ModelClient/LLMRequest types). No dependency on
core-agent or core-tools.

### 2.1 Config and types

```ts
export interface CompactionConfig {
  contextWindow: number             // REQUIRED: model context window (tokens)
  thresholdRatio?: number           // default 0.8
  retainTokens?: number             // default 0
  maxTokens?: number                // default 1024
  summarizationModel?: ModelClient  // default: reuse the agent's model
  auto?: boolean                    // default true
}

export interface CompactionResult {
  compacted: boolean
  shadowedSeqs: number[]
  summary?: string
}

export interface CompactionEngine {
  maybeCompact(session: Session): Promise<CompactionResult>
  compact(session: Session): Promise<CompactionResult>
}

export function createCompactionEngine(deps: {
  model: ModelClient
  config: CompactionConfig
}): CompactionEngine
```

`createCompactionEngine` validates the config at construction (fail loud; §G).

### 2.2 Token estimation

`approxTokens(text)` = `Math.ceil(text.length / 4)` (codex-style
`approx_token_count`; unicode characters count as one — acceptable for a
pressure estimate).

`activeTokens(session)` = sum of `approxTokens` over every derived message's
`content` plus the JSON string of each tool result message content (i.e., the
same projection `deriveMessages` would produce, token-estimated).

### 2.3 Trigger

`maybeCompact(session)`:
- `if activeTokens(session) < contextWindow × thresholdRatio → { compacted:
  false, shadowedSeqs: [] }`.
- Re-fire guard: after a compaction, `maybeCompact` does not re-fire until new
  non-marker events are appended past the last `compaction/end` (prevents
  summary-driven hot loops); `compact()` remains ungated.
- Otherwise run `compact(session)` and return its result.

`compact(session)` (explicit, no pressure check):
1. **Select the shadowable range** (§2.4).
2. If the range is empty → `{ compacted: false, shadowedSeqs: [] }`.
3. **Summarize** the shadowed range (§2.5). On summarization failure → return
   `{ compacted: false, shadowedSeqs: [] }` (fail-soft; the agent continues).
4. Append, in ONE batch: `compaction/start`, `compaction/summary { text,
   shadowedSeqs }`, `compaction/end`.
5. Return `{ compacted: true, shadowedSeqs, summary }`.

### 2.4 Region selection (event-based)

- Walk the session events from the end backwards, accumulating
  `approxTokens(deriveSearchText(ev))` until the cumulative tail reaches
  `retainTokens` → boundary seq. Events with `seq >= boundary` are retained.
- `shadowedSeqs` = every event seq with `seq < boundary`, EXCLUDING
  `compaction/*` events (a summary never shadows another compaction marker —
  recomposed shadowed sets stay disjoint).
- Empty shadowable range (e.g., a fresh session or `retainTokens` covering
  everything) → no compaction.

### 2.5 Summarizer

- Builds the summarization request: `messages = [{ role: "user", content:
  COMPACTION_INSTRUCTION + "\n\n" + replayText }]` where `replayText` is the
  shadowed range rendered as text (reuse the event texts the projection would
  produce), and `COMPACTION_INSTRUCTION` is the dsh-style structured directive
  (sections: Primary Request and Intent / Key Technical Concepts / Files and
  Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical
  Context; terse bullets; `(none)` for empty sections). No system prompt.
- Calls `model.stream(request)`; collects the streamed text; truncates to
  `maxTokens` (approx).
- Uses `config.summarizationModel ?? deps.model`.
- Summarizer failures log a `console.warn` and return fail-soft (never block
  the agent); the engine retries at the next step boundary.

## §3 core-agent — optional compaction seam

- `AgentConfig` gains `compact?: CompactionConfig`.
- `createAgent` builds `const engine = deps.compact
  ? createCompactionEngine({ model: deps.model, config: deps.compact }) :
  undefined`.
- `runTurn`, at the top of each step loop iteration (after the `maxTurns` check
  and `append(step/start)`, BEFORE `deriveMessages`): `if (engine &&
  deps.compact!.auto !== false) await engine.maybeCompact(deps.session)`.
  Compaction only ever runs at a step boundary — no mid-step interleaving.
- `Agent` interface gains `compact(): Promise<CompactionResult>` (explicit
  manual compaction, dsh `command-compact` counterpart). Declared OPTIONAL
  (`compact?()`) in the interface so existing `Agent` implementers (e.g.
  subagent-package fakes) don't break; `createAgent` always returns the method
  (a no-op `{ compacted: false, shadowedSeqs: [] }` without a config), so the
  runtime contract is unconditional.
- `assertMessagesFromLog` still holds: compaction appends events to the log and
  `deriveMessages` derives from the log, so the invariant is preserved.
- No `compact` config → `engine` undefined → byte-identical behavior to today.

## §4 CLI wiring

`apps/cli/src/run.ts`:
- `HeadlessOptions` gains `compact?: CompactionConfig` (host supplies
  `contextWindow`; defaults for the rest).
- Passed through to `createAgent`'s `compact` config.
- No `compact` → behavior unchanged (opt-in).

## §5 Testing

### 5.1 core-session
- New event types round-trip `toJSONL`/`fromJSONL`; old logs without them parse.
- `deriveMessages` skips shadowed seqs and renders the summary as a user
  message; a multi-compaction session composes shadowed sets; a session with no
  compaction events derives identically to today.
- `deriveSearchText`: summary → text; start/end → `""`.

### 5.2 compaction package
- `approxTokens` estimation; `activeTokens` over derived messages.
- `maybeCompact` triggers above threshold and not below; `compact` explicit.
- Region selection: `retainTokens` tail boundary; `shadowedSeqs` excludes
  `compaction/*`; empty range → no-op.
- Summarizer: mock model receives the instruction + replay, produces the
  summary; result truncated to `maxTokens`; a throwing/failing model →
  fail-soft `{ compacted: false }`, no events appended.
- Event append order: `compaction/start` → `compaction/summary` →
  `compaction/end`, in one append batch.
- Config validation fail-loud cases (missing/zero contextWindow, ratio out of
  range, negative retain/max).

### 5.3 core-agent
- With `compact` config: a long mock-model session triggers `maybeCompact`
  before a step; the post-compaction surface (via `deriveMessages`) shrinks and
  contains the summary; the log keeps all events.
- Without `compact`: behavior identical to today (no engine created).
- `agent.compact()` explicit call returns a result and appends the events.
- Aborted signal and maxTurns behavior unchanged.

### 5.4 CLI e2e
- `runHeadless` with `compact` + a small `contextWindow` + a long mock script →
  the session log contains `compaction/summary` and the final output is normal.
- Resume path: a persisted compacted session loads and `deriveMessages` still
  projects the summary (no re-compaction of already-shadowed events —
  `shadowedSeqs` excludes `compaction/*`).
- Without `compact` → existing CLI tests keep passing.

## §6 Out of Scope

- **Remote/overflow compaction** (codex `compact_remote_v2`, context-overflow
  recovery, `maxOverflowRetries`): only pressure-triggered compaction.
- **Per-model policy routing** (dsh `modelPolicies`): one config per agent.
- **Compaction progress UI / hooks** (codex pre/post-compact hooks, cc-custom
  progress visibility): headless library + tools only.
- **Tool-result pruning during compaction** (dsh `compaction-tool-result-pruner`).
- **Deleting/truncating the durable log**: compaction only shadows the surface.
- **Token meter service**: built-in approx estimator only.
- No `CURRENT_FORMAT_VERSION` bump; no schema changes.
