# A large partial reduction is never published

Status: **fixed 2026-11-07** (rc11).

## Reproduction

Legacy Desktop conversation, `deepseek-flash` contextWindow temporarily 26,000, prepared input carries signature
replay so the capacity price is unknown. Auto-compaction now starts (fallback in `7a33932c`) and the engine
computes:

    baseline: capacityFit=no target=over-target tokens=32,930
    run:      30 groups, 9,956 group tokens
    candidate: target=over-target tokens=13,9xx   (window 26,000, targetRatio .7, reserve 4,096)

The candidate removes ~58% of the request but still lands slightly above the computed target. `reduceContext`
(`context-engine/src/reduction/run.ts`) only publishes when `candidate.target === 'ready'` (line 55 loop
condition + line 84 publish path); it therefore requests more summaries instead. The next run selects a tiny
6-token group, the candidate grows to 33k, progress fails, no run remains, and the whole reduction reports
`no-progress` — nothing is published.

Consequences: for conversations whose fixed schema/system plus retained content cannot reach the target, the
engine never publishes *any* reduction, so the context keeps growing until the provider rejects it. The
`reduced-over-target` outcome exists but is effectively unreachable in this path.

## Root cause of the abandoned candidate

Instrumentation at the publish gate showed:

    gate: progressed=false baselineTokens=33083 candidateTokens=14009 fixed=true beforeFixed=false

`reductionProgress` requires both assessments to be non-`fixedInput`. A compaction replacement rewrites the
conversation, so the provider-native representation is overridden and the candidate legitimately reports
`fixedInput: true`. The guard therefore rejected every reduced candidate, and the engine fell through to another
(smaller, worse) run and finally `no-progress`.

## Fix

`reductionProgress` gains `reductionRewrites`: when the candidate carries the reduction's own rewrites, an
after-`fixedInput` is expected and no longer blocks publication. `reduceContext` passes `rewrites.length > 0`.
A mock-port test pins it: candidate after rewrite reports `fixedInput: true`, tokens drop 100→50, target stays
over-target → expect `compacted: true, outcome: reduced-over-target`.

## Verification

* context-engine reduction suites 21/21 (new test included);
* Desktop with the fix: the conversation that previously reported `no-progress` now publishes
  `compaction/replacement` after the summary (33,240 → 14,014 heuristic tokens) and the turn completes.