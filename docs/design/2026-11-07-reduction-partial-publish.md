# A large partial reduction is never published

Status: **diagnosed 2026-11-07** (rc10). Not fixed yet.

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

## Fix direction

1. Keep the best progressing candidate and publish it as `reduced-over-target` when no further run can improve
   (or when the call budget would otherwise be exhausted); the publication proof must be validated, so the
   candidate has to be produced from the current source (a deferred proof goes stale — observed).
2. Add a `context-engine` unit test with mock ports: baseline over target, first candidate improving but still
   over target, no further run → expect publication with `reduced-over-target` instead of `no-progress`.
3. Re-check the target formula for unpriced inputs: with schema ~11.7k heuristic and reserve 4,096, the target
   (window*0.7) can be unreachable even though the reduction is large; consider accepting a documented
   improvement threshold.