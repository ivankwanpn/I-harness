# Compaction summary capability

`@i-harness/compaction` owns configuration, token compatibility helpers and the
concrete `createSummaryPort` factory. The connected transaction is owned by
`@i-harness/context-engine`; core-agent composes its private preparation and
publication bridge. The retired `createCompactionEngine` and prefix/slices
implementation are no longer production APIs.

| Owner | Responsibility |
|---|---|
| `src/config.ts` | Existing defaults and provider/model overlays; explicit alternate summary limits and effort. |
| `src/prepared-summary.ts` | C1 final prepared output eligibility, one output-cap derivative, full final source/image checks and source-native eligibility. |
| `src/summary/source.ts` | Exact selected native bundles and provenance manifest; complete portable observations, preserving images and ordinary reasoning. |
| `src/summary/generate.ts` | Whole-group partition and rolling checkpoints; two quality rounds per checkpoint within one shared eight-stream tracker. |
| `src/summary/port.ts` | Unbound model/configuration composition, closed blocked outcomes and summary-only usage observations. |
| `src/summary/checkpoint.ts`, `stream.ts` | Complete seven-section checkpoint validation and bounded stream acceptance. |

A native summary source is first prepared by the selected actual adapter. A
local native-replay rejection, or a selected-final `native=unverified` report
with selected native payload, permits one portable construction under the same
binding and raw options. The native candidate is never sent in that case.
Portable source is recorded observation; signature/encrypted bytes are not
ordinary text. Opaque-only or incomplete visible source blocks before generation.
A provider HTTP error does not authorize stripping source or request options.

Standalone `createAgent` callers configuring compaction must inject the unbound
`summaryFactory: createSummaryPort`. Executor, fresh child, resident child,
guardian and teammate composition supply it through their actual option carriers.
Missing generation capability returns `summary-unavailable`; missing managed
publication capability returns `publication-unavailable`, with no memory fallback.
Explicit standalone nondurable owners report `nondurable` and have no fact receipt.

`CompactionResult` keeps `compacted`, compatibility `shadowedSeqs`, `summary`,
`pruned`, `reset` and `reason`, and requires `outcome` and `publication`.
`compacted` means a proven applied rewrite. It does not mean target readiness or
permission to send. Callers must inspect `outcome` (`unchanged`, `ready`,
`reduced-over-target`, `blocked`) and `publication` (`none`, `committed`,
`nondurable`, `recovery-required`). Exact ordered replacement coverage is the
structural authority; `shadowedSeqs` is only a compatibility source union.

The engine selects whole source/evidence groups, protects current human/steer
inputs and unsettled effects, and retains the newest complete exchange. A prune
can publish alone only if the full main candidate is target-ready and improves
input. Otherwise prune and complete summary replacement publish atomically,
or neither publishes. Explicit reset uses the same whole groups/protection and
never trims the archive. A fresh ordinary main admission is required afterward.

Private-workspace barrel aliases retired with their sole production consumers:
`ResolvedPruneConfig`, `SummaryFactoryInput`, `resolveContextWindow`,
context-engine `ReductionPublication`, core-session `deriveMessagesUpTo` and
`LegacyCompactionFacts`, and provider `resolveModelContext`. Internally used type
definitions and the real historical prefix-reader/model-context owners remain;
internal tests import their actual owners directly. Callers of those aliases must
migrate imports; no fake consumer or reachability baseline exception is provided.

Focused verification from the repository root:

```powershell
pnpm --filter @i-harness/compaction test
pnpm --filter @i-harness/compaction typecheck
node node_modules/vitest/vitest.mjs run e2e/context-reduction-source.e2e.ts e2e/context-corpus.e2e.ts --config e2e/vitest.config.ts
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```

These controls qualify local connected reduction. Physical retry reservations,
additive capacity policy, semantic seed/retention redesign, full main-summary
authority enforcement and streaming cold recovery remain separate obligations.
