# CJK token accounting: pricing and recorded cache usage

Status: **fixed 2026-11-07** (rc12 pending).

## Finding

`priceProjectedText` priced non-ASCII text at one token **per UTF-8 byte**, so a CJK character cost 3 tokens.
Observed on a real DeepSeek conversation: heuristic prefix 32,062 tokens vs the provider's normalized total
17,944 — a 1.8x over-estimate that grows with CJK-heavy turns. Because admission and the compaction target
(`window x targetRatio`) use this estimate, CJK conversations compacted far too early and a candidate that
actually fit could never reach the target.

The durable `context/usage` checkpoint also stored only `reportedInputTokens` (the normalized total) with
`usageSemantics`, but dropped the raw cache counters, so an estimate could not be reconciled after the fact.

## Changes

* `priceProjectedText`: CJK ideographs/kana/Hangul count one token per character; ASCII stays bytes/3; other
  non-ASCII text keeps the byte heuristic.
* `context/usage` v2 checkpoint accepts optional `cacheReadTokens` / `cacheCreationTokens`; the accepted
  calibration records them when the provider reports them. `reportedInputTokens` remains the normalized total.

## Verification

* token-meter 54/54 (pricing table updated: `中文` 6 -> 2, `a中` 4 -> 2, unit 19 -> 17);
* context-engine 98/98; core-agent context suites 66/66.