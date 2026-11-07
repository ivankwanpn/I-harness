# Auto-compaction with unpriced replay content

Status: **partially fixed 2026-11-07** (rc11 pending).

## Symptom

On a legacy Desktop conversation whose prepared request carries signature/opaque replay content, the capacity
assessment reports `estimate: unknown` / `pressure: token-cost-unavailable` and disposition `compatibility`.
Both auto-compaction gates required `pressure.kind === 'known'`, so **no soft reduction was ever attempted**:
the context kept growing until the provider itself would reject the request.

## Change

When the pressure reason is `token-cost-unavailable` and the prepared input coverage is `complete`, the auto
gates now fall back to the complete heuristic prefix: if it exceeds `contextWindow * thresholdRatio`, a soft
reduction starts. Managed (`managed.ts`) and legacy (`composition.ts`) paths share the rule.

## Observed after the change

* soft sequences now start on the affected session (previously none);
* reduction returns `no-progress` when the fixed schema/system and retained tail cannot fall below the target,
  so no summary is published; the turn still completes;
* 66 core-agent tests (auto policy, compaction binding, context recovery/usage, connected reduction) pass.

## Accounting notes

`context/usage` checkpoints store `usageSemantics: excludes-cache` and only `reportedInputTokens`; cache reads
are reported by the provider (`provider/usage`) but not persisted in the durable checkpoint, so the heuristic
prefix and the reported (non-cached) input cannot be compared after the fact. Recording `cacheReadTokens` /
`totalInputTokens` is the next accounting fix.