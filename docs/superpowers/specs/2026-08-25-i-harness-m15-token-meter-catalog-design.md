# M15 Design — Token Meter + Per-Model Context Catalog

Date: 2026-08-25. Milestone: M15. Status: design.

## 1. Framing

### 1.1 Problem

I-harness's token accounting is a single `chars/4` heuristic inside
`packages/compaction/src/tokens.ts` (`approxTokens` → `activeTokens`,
M11-era, made parts-aware in M14 with `IMAGE_TOKEN_ESTIMATE`). It has no
per-block structural overhead, no role framing cost, no breakdown surface, and
no way to know a model's context window except a hardcoded
`CompactionConfig.contextWindow`. The parity audit names this gap directly:
"NO token meter service, NO per-model context windows, NO provider-side budget
enforcement."

dsh ships a `token-meter` package (fixed-density `estimateContent`: `chars/4` +
per-block `BLOCK_OVERHEAD` + `ROLE_OVERHEAD`, recursive over content blocks) and
a `replay-token-meter-service`; codex ships `models.json` with per-model
`context_window` / `max_context_window` (`models-manager`). M14 left one gate
open (its I3): tool-content strings can still carry full base64 to a text-only
model — the metering in M15 would price those leaked bytes if unaddressed.

### 1.2 Goal

Add two things at the smallest coherent scope:
1. **A pure-function token meter** (`packages/token-meter`, zero deps) using
   dsh's fixed-density heuristic (`chars/4` + per-block/role overhead),
   multimodal-aware (parts + image estimate), with a breakdown surface —
   so hardening compaction and future budget checks share one estimate.
2. **A per-model context catalog** on `ProviderProfile`
   (`contextWindow` / `maxContextWindow` + per-model overrides), consumed by
   compaction (catalog-first, config-fallback) so its pressure trigger uses the
   right window for the model instead of a hardcoded number.

Also: fix M14's **I3** (tool-string base64 masking under negative capability)
before the meter lands, so tool-image sessions are not priced with leaking
base64 bytes.

### 1.3 Non-goals (out of scope for M15)

- **Budget enforcement / truncation** (forcing compaction at
  `maxContextWindow`, truncating oversized tool outputs codex-style):
  deferred — M15 only meters + catalogs + wires. The exposure of
  `maxContextWindow` is the hook for it.
- **Event-sourced token meter service** (per-session incremental counts,
  projection/`surface-fold`, host-vs-client views like dsh's
  `usage-projection`/`breakdown-projection`): deferred — M15 is a pure-function
  package; the service pattern is a later milestone (would build on M13's
  projection research and the session fold-state split).
- **Real tokenization** (tiktoken/other): out — violates the no-new-external-dep
  constraint; the fixed-density heuristic is the defined precision.
- **Model catalog as a separate package** (`model-catalog` with static
  `models.json`): deferred — M15 extends `ProviderProfile` (the provider
  registry is the catalog; no new package).
- **Overflow recovery / `prompt_too_long` auto-compact**: separate roadmap item
  (M11 §out-of-scope); not this milestone.
- **No version bumps, no new session event types, no `CURRENT_FORMAT_VERSION`
  change.**

## 2. Confirmed decisions (brainstorm 2026-08-25)

| Decision | Choice |
|---|---|
| Scope | token meter + context catalog together |
| Pricing | dsh fixed-density (chars/4 + block/role overhead), multimodal-aware |
| Meter home | new `packages/token-meter` (zero-dep pure functions) |
| Structure | pure functions (not an event-sourced service) |
| Catalog | extend `ProviderProfile` (contextWindow/maxContextWindow + per-model overrides) |
| Compaction | catalog-first, config-fallback (`contextWindow` source becomes resolvable) |
| M14 I3 | fix first in M15 (tool-string base64 mask under negative capability) |
| Budget | metering + catalog + wiring only (no enforcement/truncation) |

## 3. `packages/token-meter` (new, zero dependencies)

### 3.1 estimate.ts — dsh-style fixed-density heuristic

```ts
export const CHARS_PER_TOKEN = 4
export const BLOCK_OVERHEAD = 4
export const ROLE_OVERHEAD = 4
export const IMAGE_TOKEN_ESTIMATE = 1024 // moved from compaction (M14)

// estimateContent(messages: LLMMessage[]): number
// Fixed-density heuristic shared by every consumer (meter, compaction,
// future budget checks). Deterministic — same input, same number.
```

Pricing rules (per message, recursive):

- `user` / `tool` message with **string content**: `ceil(content.length / 4) + ROLE_OVERHEAD`.
- `user` / `tool` message with **parts array**: `ROLE_OVERHEAD +` per part —
  text part `ceil(text.length / 4) + BLOCK_OVERHEAD`; image part
  `IMAGE_TOKEN_ESTIMATE + BLOCK_OVERHEAD`.
- `assistant` message with `toolCalls`: `ROLE_OVERHEAD +` per call
  `ceil(name.length / 4) + ceil(JSON.stringify(args).length / 4) + BLOCK_OVERHEAD`
  (args exactly as the wire would send — `JSON.stringify`), plus its string
  content if any (assistant content is always string).
- `assistant` string message: `ceil(len / 4) + ROLE_OVERHEAD`.

This is I-harness's mapping of dsh's `estimateContent` (which prices
`text|reasoning|tool-call|tool-result` blocks) onto I-harness's
`LLMMessage` union, with the M14 image part charged at `IMAGE_TOKEN_ESTIMATE`.

### 3.2 activeTokens / breakdown

```ts
// activeTokens(session: Session): number
// deriveMessages(session) then estimateContent — the single projection rule
// (audit seam F01-3: the model only sees deriveMessages output).

// breakdown(session): TokenBreakdown
export interface TokenBreakdown {
  total: number
  perMessage: { index: number; seq?: number; role: "user" | "assistant" | "tool"; tokens: number }[]
}
```

`breakdown` is the observability surface (per-message cost) — used by tests,
future budget checks, and any host wanting to see where context goes.

### 3.3 Migration compatibility

`packages/compaction/src/tokens.ts` migrates to the new package:

- `activeTokens(session)` → re-export/delegate to `token-meter`'s
  `activeTokens` (single source of truth).
- `approxTokens(content)` → kept as a thin wrapper: for a string returns
  `ceil(len / 4)`; for a parts array returns the per-part sum (text `ceil/4`,
  image `IMAGE_TOKEN_ESTIMATE`) — **without** block/role overhead, because
  existing callers (e.g. `region.ts` shadow selection, `summarizer.ts`) price
  single blobs, not full messages. Document the difference (approxTokens =
  content-only; estimateContent = full-message with overhead).
- `IMAGE_TOKEN_ESTIMATE` → re-exported from token-meter (keeps M14's public
  surface; the value is unchanged).
- The compaction `tokens.ts` diverges intentionally: it calls token-meter's
  `estimateContent` for `activeTokens` but keeps `approxTokens` for
  single-blob use. NO external consumer breaks (both names still exported from
  compaction).

## 4. ProviderProfile context catalog

### 4.1 Fields

```ts
export interface ProviderProfile {
  name: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl?: string
  apiKey?: string
  models?: string[]
  defaultModel?: string
  inputModalities?: ("text" | "image")[] // M14
  contextWindow?: number                  // M15: default context window (tokens) for this provider
  maxContextWindow?: number               // M15: absolute ceiling (budget-enforcement hook; no enforcement in M15)
  modelContexts?: Record<string, {        // M15: per-model overrides
    contextWindow?: number
    maxContextWindow?: number
  }>
}
```

Validation at registration (fail-loud): `contextWindow`/`maxContextWindow` must
be positive integers when present; each `modelContexts[*]` entry same. No
defaults injected — absence means "unknown, fall back to config".

### 4.2 resolveModelContext

```ts
// resolveModelContext(profile, modelId): { contextWindow?: number; maxContextWindow?: number }
// Per-model override wins → profile-level → undefined.
export function resolveModelContext(profile: ProviderProfile, modelId: string): {
  contextWindow?: number
  maxContextWindow?: number
}
```

Pure, no validation at call time (already validated at registration). `modelId`
is the resolved model id (the adapter's `config.model`); when absent, falls back
to `profile.defaultModel`/`models[0]` resolution by the caller.

## 5. Compaction wiring (catalog-first, config-fallback)

```ts
// createCompactionEngine(deps: {
//   model: ModelClient
//   config: CompactionConfig
//   profile?: ProviderProfile   // NEW (optional)
//   modelId?: string            // NEW (optional): the resolved model id
// }): CompactionEngine
```

Inside, resolve the effective window once at construction via a pure exported
helper so tests can assert it directly:

```ts
// resolveContextWindow(profile?, modelId?, config): number
// catalog-first: profile.modelContexts[modelId].contextWindow
//            → profile.contextWindow → config.contextWindow
export function resolveContextWindow(
  profile: ProviderProfile | undefined,
  modelId: string | undefined,
  config: ResolvedCompactionConfig,
): number {
  const catalogWindow = profile && modelId
    ? resolveModelContext(profile, modelId).contextWindow
    : undefined
  return catalogWindow ?? config.contextWindow
}
```

```ts
const contextWindow = resolveContextWindow(deps.profile, deps.modelId, config)
```

- `maybeCompact` trigger logic unchanged
  (`activeTokens(session) >= contextWindow * thresholdRatio`).
- Backward compatibility: no `profile`/`modelId` → `catalogWindow = undefined`
  → `contextWindow = config.contextWindow` → byte-identical to M11/M14.
- `CompactionConfig.contextWindow` STAYS required (its contract is unchanged;
  catalog is an override, not a replacement).

## 6. M14 I3 fix (tool-string base64 masking)

In `packages/llm-seam/src/index.ts` `projectImagesForTextModel`:

- The current behavior: string content passes through untouched — so a
  `role: "tool"` message whose content is `JSON.stringify(output)` with an
  `images` array carries the FULL `dataBase64` to a text-only model.
- Fix: before the string passthrough, when the caller is projecting for a
  text-only model, mask `dataBase64` values inside **tool-role** string content:
  replace each `"dataBase64":"<base64>"` occurrence with
  `"dataBase64":"[image omitted: base64:<first-8-of-that-base64>]"` using the
  regex `/"dataBase64":"([A-Za-z0-9+/]{8})[A-Za-z0-9+/=]*"/g` (canonical base64
  charset; captures the first 8 chars for the correlation hint). User/assistant
  string content is untouched (it never carries embedded images from the
  projection — tool results are the only leak).
- New test: `projectImagesForTextModel` on a tool message with
  `content: '{"ok":true,"images":[{"dataBase64":"<long>"}]}'` produces the
  masked placeholder, not the raw base64, when the model is text-only.
- This closes M14's I3 (the hard gate: no real text-only provider may be wired
  with tool-image sessions until masked). The seam comment in llm-seam is
  updated to say "part-level + tool-string masked".

## 7. Error handling

- token-meter: pure functions — no throws for valid input; `deriveMessages`
  is the projection (already validated at append/intake). A malformed persisted
  image field is treated as data (M14 §8; the meter just prices whatever the
  projection produces).
- provider: registration validation fail-loud (non-positive/NaN contextWindow).
- compaction: `profile`/`modelId` are optional — no new throw paths.

## 8. Testing

1. **token-meter** (`packages/token-meter/test/estimate.test.ts`):
   - `estimateContent`: string content (ceil/4 + ROLE_OVERHEAD); parts array
     (text part ceil/4 + BLOCK_OVERHEAD; image part 1024 + BLOCK_OVERHEAD);
     toolCalls message (per-call name+args + BLOCK_OVERHEAD); tool message
     (content + BLOCK_OVERHEAD); determinism (same input → same number).
   - `activeTokens(session)` — derives then estimates; equals `estimateContent(deriveMessages(session))`.
   - `breakdown(session)` — total sums per-message; roles correct.
2. **provider** (`packages/provider/test/provider.test.ts`):
   - `resolveModelContext`: per-model override wins over profile-level;
     missing → undefined; fallback to profile when no override.
   - registration validation: non-positive contextWindow throws.
3. **compaction** (`packages/compaction/test/*.test.ts`):
   - `createCompactionEngine` with `profile.modelContexts` → effective window =
     per-model override; with only profile.contextWindow → profile; with
     neither → config. The effective window is exposed by a pure exported
     helper `resolveContextWindow(profile?, modelId?, config)` (returns the
     resolved number) so tests assert it directly; `createCompactionEngine`
     uses it internally AND `maybeCompact`'s fire/no-fire behavior is pinned for
     two configs (small window fires, large window does not — behavior-based).
   - `approxTokens`/`activeTokens`/`IMAGE_TOKEN_ESTIMATE` still exported
     (M14 surface intact); `approxTokens` content-only semantics preserved.
4. **llm-seam** I3: tool-string base64 masked under text-only projection;
   vision path untouched.
5. **Regression**: full `pnpm -r test` + `pnpm -r typecheck` green (no-image /
   text-only / M11-M14 suites).

## 9. Files touched

- Create: `packages/token-meter/src/{index,estimate,breakdown}.ts` + `package.json` + tests.
- Modify: `packages/compaction/src/{index,tokens}.ts` (migrate activeTokens to
  token-meter; keep approxTokens thin wrapper + IMAGE_TOKEN_ESTIMATE re-export;
  add profile/modelId params).
- Modify: `packages/provider/src/index.ts` (catalog fields + `resolveModelContext`).
- Modify: `packages/llm-seam/src/index.ts` (I3 tool-string masking + comment).
- Modify: `apps/cli/src/run.ts` (NO change required in M15 — the CLI passes
  `compact` config; profile/modelId wiring to compaction is a package-level
  capability. Document that the CLI continues with config-fallback unless a
  host wires profile+modelId).
- Tests per §8.
- New workspace dep: `@i-harness/token-meter` added to `compaction` as
  `workspace:*` (the only new dependency link; no external deps).

## 10. Global constraints (binding)

- No bun. No `@ai-sdk/*`. No new EXTERNAL dependencies (workspace links only —
  the new `packages/token-meter` is an internal workspace package).
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- No version bumps; no new session event types; `CURRENT_FORMAT_VERSION` stays 1.
- Audit seam F01-3: `activeTokens` derives from the session (deriveMessages is
  the single projection); the meter never sees raw events.
- Behavior unchanged when no catalog is provided (config-fallback;
  byte-identical M11/M14 path).
- `approxTokens` / `IMAGE_TOKEN_ESTIMATE` public surface (M14) preserved.

## Appendix A — reference designs (dsh token-meter + codex models.json)

- **dsh `token-meter`** (`estimate.ts`): fixed-density `estimateContent` —
  `chars/4` + `BLOCK_OVERHEAD` per block + `ROLE_OVERHEAD` per message,
  recursive over `text|reasoning|tool-call|tool-result` blocks; shared by the
  meter service AND the pure context-breakdown projection so both price the
  same content to the same numbers. (M13 delta research: token-meter moved its
  host fold into the `SessionProjectionStateMap` state table with a `wire` view
  — the event-sourced service form is a later milestone for I-harness.)
- **codex `models.json`** (`models-manager`): per-model `context_window` /
  `max_context_window`; `model_info.rs` overrides. I-harness's
  `ProviderProfile.modelContexts` mirrors the per-model override shape, at the
  registry level instead of a static catalog file.
- Common: fixed-density estimation is the zero-dependency norm (codex uses
  `approx_bytes_for_tokens`); per-model context metadata is a catalog the loop
  reads, not a hardcoded constant.
