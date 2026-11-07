# Signatures no longer disable capacity accounting

Status: **fixed 2026-11-07** (rc13 pending).

## Symptom

Every DeepSeek(anthropic) request carried a small protocol signature (36-72 bytes), even with reasoning off.
`ProjectionCounter.metadata` priced the signature through `opaque()`, which added
`opaque-continuation-token-cost` to the input uncertainties; `estimateFor` then reported `kind: unknown`,
so admission fell back to `compatibility`: `estimate unknown`, `pressure unavailable`,
`context dimension unchecked`. Calibration and pre-emptive compaction were both disabled — the exact path we
want for long conversations.

## Fix

* `metadata` still counts `signatureBytes` and reports `signature-token-cost`, but prices the bytes directly
  (bytes/2 + 4) instead of routing through `opaque()`, so it no longer claims an opaque continuation.
* `assessPreparedRequest` no longer treats `signature-token-cost` as unpriced: the signature is small, bounded
  replay material, and the heuristic bytes/2 is an acceptable conservative price.

## Verification

* token-meter 55/55 (new signature test: signature priced, no opaque uncertainty);
* context-engine 98/98;
* Desktop with the change: the context budget now reports
  `estimate {kind: estimated, source: projected-heuristic}`, `pressure {kind: known, trigger: 10145, target: 8877}`
  for a 20k window instead of `unknown/unavailable`.