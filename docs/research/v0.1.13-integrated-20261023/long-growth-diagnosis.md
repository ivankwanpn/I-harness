# Actual repeated-compaction host diagnosis — 2026-10-23

**The 60-read autonomous workload completes through 29 committed compactions and a final answer. Cold reopen preserves the originals and a valid follow-up completes through a 30th compaction. A separate real 24-read parallel exchange leaves the session unable to continue: initial automatic recovery, manual compaction, and a subsequent valid prompt cannot reduce its selected tool group.** This is a continuation limitation, even though no oversized request is transmitted and no tool is executed twice.

No production code, previous test, model/session format, dependencies, or MAIN runtime was changed. No commit was made.

## Source and execution identity

- Sole runtime/worktree: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`.
- Branch: `codex/long-growth-diagnosis-20261023`; HEAD/BASE: `fc71742db138c1018994edf94e954fdc3bff5f58` throughout.
- One new test: [repeated-growth-diagnosis.test.ts](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts). Final SHA-256: `9fb750a75ec847dc97dd95d16e7ec7668b65d919bcb8208805f9a34fb93cec68`.
- Node `v24.15.0`, Vitest `3.2.7`; real `createDesktopHost`, built-in Chat-compatible HTTP adapter, localhost receiver, short fresh `ih-lg-*` temporary roots. No live accounts, credentials, provider endpoints, or user-session data.
- Exact test command, run sequentially on each fixture revision:

```powershell
$env:IH_LONG_GROWTH_EVIDENCE_DIR = 'D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4'
pnpm exec vitest run packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts --maxWorkers=2 --minWorkers=1 --no-file-parallelism
```

Runs 1–3 used their corresponding `run1`, `run2`, or `run3` evidence directory. Run4 additionally copied the exact test into `probe-source.ts`, captured output with `Tee-Object`, and wrote `exit.txt` using `$LASTEXITCODE`. [Final log](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4/vitest.log), [exact source snapshot](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4/probe-source.ts), [machine summary](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/summary.json).

**Final verification:** 2 tests passed, 0 failed, exit0. Test execution142.396s; complete Vitest process148.57s. `pnpm --filter @i-harness/desktop-gateway typecheck` also exited0; [typecheck log](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4/typecheck.log). `git diff --check` exited0; `git status --short` showed only the new test. No broad monorepo suite was run. The second passing test asserts a reproduced refusal; it is **not** a claim that the parallel workload completed.

## Successful continuous growth and cold continuation

Final initial-plus-cold interval: **2026-10-23T15:32:44.962Z–15:35:03.438Z**, 138.476s inside the probe (Vitest138.646s). Neither watchdog nor provider timeout fired.

The single original user turn requests `page-0.txt` through `page-59.txt` once each. Every file contains6,000 JavaScript code units /16,800 UTF-8 bytes of CJK plus code/text. Every retained JSON result is below8,192 characters and64,000 bytes. Results use the current successful inline result envelopes, not fabricated legacy events. No prune or result-reference event substitutes these moderate results.

The receiver's scripted next read is computed from **the actual incoming wire's completed results and checkpoint text**, not a private server counter. Its checkpoint carries only completed-work state from the received source. Every main request during the original turn must still contain the full original task instruction. Cold requests must contain the new follow-up instruction. This makes lost progress/current-input behavior observable.

| Observation | Actual final run4 |
|---|---:|
| Original read dispatches/results | 60/60, unique `read-0` through `read-59`, each once |
| Compaction replacements before final original answer | 29 |
| Original turn main HTTP requests | 61 (60 tool-producing replies + final answer) |
| Original final assistant answer | `TASK-60-COMPLETE` |
| Cold reopen original results | All60 equal the pre-close history results |
| Cold follow-up | One `cold-read`, final `COLD-FOLLOWUP-COMPLETE` |
| Total durable replacements after cold follow-up | 30 |
| Total actual HTTP requests | 63 main +30 summary +1 title =94 |
| Actual request bytes, aggregate / maximum | 7,994,035 /107,467 |
| Final paginated event count | 1,242 |
| Pairing errors / receiver rejections / duplicate dispatches | 0/0/0 |
| Requests exceeding synthetic input + actual output cap +10k reserve | 0 |

The independent receiver collects Buffer chunks before UTF-8 decoding, byte lengths, SHA-256 hashes, routes, request role/call/result counts, portable recorded-source call/result pairing, schema/system/replayed-reasoning byte measures, actual output caps, and request timestamps. It never calls IH's conversation projection to validate wire pairing. All raw decoded request bodies are retained losslessly in compressed JSONL; the recorded SHA-256/byte count applies to each original request body, not the gzip stream.

There are **28 directly observed decreases between consecutive sent main bodies**, normally99,153→79,032bytes, each with a summary between them; subsequent main requests grow again. The first compaction's net decrease is not visible by comparing consecutive sends because the latter includes a newly completed result absent from the preceding request; it is still a durable replacement. Cold continuation additionally shrinks99,317→38,910bytes around its summary. This is actual selected-wire shrinkage, not archive-size inference.

Requested output caps adapt: e.g.71,546 synthetic input +18,454 actual `max_tokens` +10,000 reserve =100,000. The cold first request uses71,623 +18,377 +10,000 =100,000. Summary caps are4,096. No real tokenizer truth is claimed: the receiver intentionally reports cache-inclusive usage calibrated to `describeContext`'s projected heuristic. Byte/call measurements are independent; token usage is fixture-authored. Thus this qualifies transport/host continuation under this declared local contract, not live-provider tokenization or natural-model summary quality.

Evidence: [receiver metrics](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4/repeated60/receiver.json), [raw wire bodies](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4/repeated60/wire.jsonl.gz), [complete paginated events](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4/repeated60/events.json), [RPC frames](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4/repeated60/frames.json). Replacement IDs/source coverage and soft-reduction committed publication records are in the event evidence; the machine summary extracts replacement IDs and source sequence coverage.

## Reproduced single large exchange limitation

Final interval: **2026-10-23T15:35:03.592Z–15:35:07.310Z**. The model's first legal response requests24 actual `read` calls together. The host dispatches all24 once and records24 successful, complete, inline originals. Each individual result remains below the normal thresholds; the large unit is their **one accepted assistant exchange**, not one giant user message, impossible fixed instruction/schema, forged history, or many independently closed exchanges.

The initial request really sent is37,849bytes /12,675 projected input /20,000 output cap. After the results, the main candidate has **449,285 prepared HTTP-body bytes and411,118 provider-anchor-plus-projection input**, against70,000 input budget. This candidate is refused locally with `prompt_too_long`; it is **not** a receiver-measured request and was never sent. The initial invocation sends no summary. Fixed system+schema input is only12,555 projected tokens, so this is not an impossibly large fixed-surface case.

Then the test invokes the real public `desktop/session/compact`: it returns `compacted:false`, `outcome:blocked`, `publication:none`, `blockedReason:no-progress`. A valid subsequent prompt also returns `prompt_too_long`, now411,168 projected input /449,399 prepared bytes. These two actions send one small40,894-byte summary request each; raw bodies show they contain the **old human instruction and no tool calls/results**. Neither publishes a replacement or dispatches another read. Total observed wire:1 main +2 summary, all200, no stall. This is a reproducible session continuation failure despite safe local refusal.

The source/data trace explains why the relevant group is never summarized:

1. `runtime-context` publishes its synthetic snapshot as an internal `user/message` ([producer](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/runtime-context/src/index.ts:67)). In the actual first step this occurs before the tool exchange. History attaches the step unit to that input as well as the exchange ([group.ts:41](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/core-session/src/conversation/history/group.ts:41)). Whole source-interval closure groups that input with all24 calls/results.
2. During the original turn, all inputs after `turn/start` are protected ([state.ts:63](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/core-session/src/conversation/state.ts:63)); group-level protection propagates to the completed exchange ([selection.ts:18](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/context-engine/src/reduction/selection.ts:18)). The actual state immediately before the failed budget has two complete **protected** groups and zero eligible runs. This is the initial barrier.
3. After failure ends the turn, the group is complete and unprotected, but selection always retains at least one latest complete exchange—even with default `retainTokens:0` ([selection.ts:40](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/context-engine/src/reduction/selection.ts:40)). Consequently manual/follow-up reduction can select only small input groups. Those summaries cannot reduce the dominant tool material.

[Offline selection evidence](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4/parallel24/offline-selection.json) replays the exact persisted host events through production snapshot/group/selection functions at three real cuts: before the first rejected budget, after its `turn/end`, and after the follow-up. It performs no admission, mutation, semantic seed fabrication, or runtime hook. The group has one input plus one exchange containing24 calls. [Receiver metrics](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4/parallel24/receiver.json), [raw request bodies](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4/parallel24/wire.jsonl.gz), [actual events](D:/I-harness-main/.superpowers/sdd/2026-10-23-context-transfer-host/long-growth-evidence/run4/parallel24/events.json).

**Summary partitioning itself was not reached for this oversized group.** The source still refuses partitioning one group (`groups.length < 2`, [generate.ts:12](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/compaction/src/summary/generate.ts:12)), but this run does not experimentally attribute the refusal to that branch. The exact prerequisite for that narrower test is making this real completed group eligible despite active-turn input coupling / latest-exchange retention, then preparing its actual summary surface. No test-only semantic admission was added to bypass those owners. The successful60-read case proves progress across many independently closed groups, not splitting this one exchange.

## Smallest follow-on work justified by this evidence

Keep the successful normal growth path. For the reproduced24-call case, the existing owners need a bounded recovery path for complete result-heavy exchanges:

- First qualify the runtime-context input/step coupling in core-session grouping/protection, while preserving the actual current human instruction and unresolved effects. Then qualify an explicit hard-capacity escape from the mandatory recent-exchange tail in context-engine selection. Changing only the summarizer cannot affect a group that never becomes eligible.
- Once eligible, test the real summary preparation. If it cannot fit one group, evaluate an explicit bounded portable summary view in the existing compaction source/generation owner. Preserve the original result envelopes and call/result provenance; do not forge a smaller accepted exchange or missing tool results. This is a proposal, not a tested repair or an authorization to weaken grouping. Original bytes already survive in the event log here; any shorter summary representation must be separate and its fidelity/loss policy explicit.
- The follow-on acceptance must turn this same24-call workload from prompt failure into final answer and valid cold follow-up, with each read dispatched once, all originals retrievable/equal, actual wire pairing intact, bounded calls, and declared capacity satisfied. Also retain the successful60-read test. No new architecture/owner or native-proof project is needed to test this causal path.

## Earlier runs and limitations

| Run | UTC probe interval | Test exit / counts | Classification |
|---|---|---|---|
| 1 |15:25:05.070–15:25:09.911|1;0pass/2fail|Invalid diagnostic assumptions: receiver demanded protected current input inside summary source, returning its own400; result assertions used obsolete `output` instead of envelope retention. No product defect inferred.|
| 2 |15:26:42.387–15:27:25.365|1;1pass/1fail|40s watchdog fired with31reads/14committed replacements and advancing request timestamps. Genuine bounded timeout evidence, **not** demonstrated deadlock. Retained unchanged.|
| 3 |15:28:59.197–15:31:05.953|1;1pass/1fail|180s bound; original task actually finished (61main/29summary/1title), but diagnostic read only the first1,000 history events and incorrectly saw51results. `session/history` caps pages and returns `nextSeq` ([server.ts:631](C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/sdk/src/server.ts:631)). Corrected cursor walking, not workload/product behavior. Cold follow-up not reached in this run.|
| 4 |15:32:44.962–15:35:07.310|0;2pass/0fail|Full paginated verification plus cold follow-up; positive continuous growth and asserted parallel-group limitation above.|

The deadline increased only after observing steady progress at the first deadline; the original failure remains evidence. Page size/count,100k window, default compaction policy, real adapter, and capacity/pairing assertions were not weakened to achieve green. The final run uses a180s RPC watchdog and210s outer long-test bound, a150-request/64MiB receiver cap, and at most10history pages. Actual elapsed time is a performance observation; no profiling supports assigning its cause.

This scoped probe does not cover live providers, real tokenization, Anthropic/Responses, reference-agent execution,150k windows, multiple human turns, Stop/restart races, child fan-in, native-only source, or an eligible single-unit summary overflow. It establishes actual repeated Chat-compatible host continuation and a specific producer-reachable single-group failure, rather than general long-session reliability or the historical users' unknown400cause. All evidence is synthetic; temporary runtimes were closed and their owned roots removed.
