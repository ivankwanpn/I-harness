# Compaction refused after a rewind (and with tool deliveries)

Status: **fixed 2026-11-07** (rc8). Reproduced in the rc7 Desktop on a session that had a bash turn, later turns, a
conversation rewind and a write turn.

## Symptom

`desktop/session/compact` returned `blocked: capacity-unavailable` (rc7) or `source-unrepresentable` (after the
mapping fix) and never compacted.

## Root cause

`core-session/src/conversation/history/replacements.ts` validates a compaction replacement against the visible
history. Two independent problems blocked it:

1. **Rewind leaves an open turn.** The rewind anchor sat inside a turn, so the visible branch kept that
   `turn/start` without its `turn/end`. The next branch's `turn/start` then made the history ambiguous and the
   validator refused every replacement (`protected-source`).
2. **Stale delivery sources stay pending.** `pendingDeliverySources` accumulated every `agent/delivery-source`,
   including `delivery: 'tool'` deliveries and sources from closed generations. Their dependency (the tool call
   seq) is exactly what compaction summarizes, so the replacement was refused.

The reduction bridge also masked these as `capacity-unavailable` (fixed separately in `bridge.prepare`).

## Fix

* `rewind/point` resets the open-turn tracker in replacement validation;
* delivery tracking keeps only the active generation's non-tool sources, drops sources on
  `agent/delivery-received`, and ignores `delivery: 'tool'` sources;
* `historyFact` exposes `deliveryKind` so the validator can distinguish them.

## Verification

* New `replacement.test.ts` case: rewind after an open turn + replacement in the next branch validates;
* core-session replacement/history suites 68/68; gateway compact/auto-title/fork 4/4;
* Desktop rc7 with the fix: the same session compacts — `compacted: true`, `outcome: ready`,
  `publication: committed`, with a summary (23 shadowed seqs).