# Scoped P1 gate qualification re-review

**Original P1: ADDRESSED by the connected test qualification and the full required session gate on `f36d8adc5807f623006af8a31ff181371cd37eb4`.**

**Final scoped specification verdict: PASS. Final scoped code-quality verdict: PASS with the separately reviewed, nonblocking evidence-I/O cleanup P3 still deferred.** No remaining blocking finding was established in this qualification review. Combined with the original full-range source review, the required session-gate blocker is resolved for this bounded retained live-batch continuation task. This is not integration/release authorization or a claim about source independence, historical003's cause, or broad timing stability.

## Scope and inputs

This review revisits only the P1 in `task-1-review.md`, not the unchanged continuation implementation. Inputs were the close-qualification plan Q01–Q04, its `task-1-report.md`, independent `task-1-review.md`, supplied `review-a6c234c8..f36d8adc.diff`, the frozen changed test, and root's saved full required session gate under:

`D:/I-harness-main/.superpowers/sdd/2026-10-25-retained-batch-continuation/session-gate-f36d8adc/`.

Read-only Git checks confirm native checkout HEAD is the stated full `f36d8adc` SHA and `a6c234c8..f36d8adc` changes only `packages/session-executor/test/code-mode-children-close-boundary.test.ts`. There is no new product-content delta to review broadly.

## Why this addresses the original blocker

The correction establishes the completed-work precondition that the original controlled model did not establish. At `code-mode-children-close-boundary.test.ts:16–24`, the fixture reads the actual model-visible tool result, matches the original assistant tool-call identity, validates the returned status/cell ID, and requires matching requested/returned cell IDs for waits. At lines43–52, actual `running` output produces a real model-dispatched `code_wait`; only `completed` output permits `child complete`. No successful observation or terminal fact is manufactured.

The positive's original guest program, ordinary child and teammate, role restrictions, schema/maxOutput checks, parallel limit, cold reopen and `["1","2","3"]` oracle remain. Its existing 15000 ms deadline remains at line171. The exact second-turn receipt callback still synchronously captures `assembly.subagentState()` and calls `service.close()` at lines115–118. The added checks immediately before those operations assert genuine stores1/2, matching completed cell IDs and store-before-completion ordering; they do not insert an asynchronous wait before close. Fallback state/close paths were removed, so a pass requires that callback actually to capture and close the original owner. The numeric cold oracle remains at line150.

I inspected root's authoritative `close/completed.json`, including actual request messages and boundary/restored facts. Both second-turn exec observations are genuinely `running`, followed by actual `code_wait` requests and matching `completed` results:

| Child | Second-turn cell | Store / completed seq | Second turn/end | Cold numeric outputs |
| --- | --- | --- | --- | --- |
| `child-614d2807-3e89-42b0-9ef7-57f4220bf162` | `5e9e994f-7a2c-48d3-b4ee-6e5f36b40562` | 65 / 66 | 96 | `["1","2","3"]` |
| `child-9c2c1975-e0df-45e2-93bc-eea42d36e119` | `9b0f0e85-3631-471b-bfab-7b63638124f3` | 73 / 75 | 96 | `["1","2","3"]` |

Thus both second stores and completions exist at the actual receipt-time close. The cold restored facts retain stores1/2/3 for each child. The saved request messages contain six actual completed observations overall. The helper accepts direct completed exec output when that is what the model received and uses waits only for actual running output.

Q03 also receives a distinct real running-at-close control (`test:173–274`). Its nested `held_read` producer enters once and stays unsettled until released by the test. The model sees real running output and ends with `guest remains running`, not completed. At the actual first turn/end callback, the test requires the entered/unsettled body, zero store and zero completed cell, then starts the original service close. It observes that body's real abort signal, verifies close/body remain pending, releases the same original held body and joins original close/submission. Reopen checks no live cells or automatic extra request before a distinct explicit followup.

Root's `close/running.json` supports those assertions: original cell `fbef2396-c06e-457d-b34b-1914c02d16d3` has started23, first turn/end40 and terminated41; it never completes or commits a store. There is one held call and one dispatch, one producer, and only `no unfinished store` output from a different cell after `distinct explicit followup`. Final body/close settled flags are true. No old continuation, hidden replay or uncertain-producer retry is used to make the positive pass.

This is an actual completed-state positive plus an actual unfinished-state negative. It changes the completion precondition while preserving the original completed-state oracle and exact close boundary; it does not waive the old failing assertion.

## Required gate and fixed-source evidence

Root's `receipt.json` records package CWD on native `f36d8adc`, all six originally required session files, `--maxWorkers=2 --minWorkers=1`, isolated configuration/evidence paths, exit0 and 2882 source files. The raw log independently reports **6/6 files and 21/21 tests passed**, including both close controls and the retained-batch continuation test. Positive close test6717ms, held-running955ms and live-batch1386ms are within their preserved deadlines.

The receipt supplies no alternate Vitest config or fileParallelism argument. The checked ordinary package `vitest.config.ts` uses `fileParallelism: process.platform !== "win32"`; this Windows gate therefore uses the package's ordinary serial-file policy, not a qualification-only override. The prior separate qualification runs used their own explicit config; those runs do not substitute for this full package-settings gate.

I independently checked:

- `raw.log` SHA256 equals the receipt's `0b904fb5f0f90f23280f070455120457b881c7e14bcb1516a4d3786b6737603e`.
- Saved `source-before.json` and `source-after.json` are identical and each contains2882 entries. This establishes recorded before/after byte stability for the gate; I did not rehash the whole repository.
- The current changed test SHA256 is `d92777c0d7cf71dc0fb348c0bf8f6ca0f5833f3b6be24cb130b5682d28c165b9`, matching the gate manifest and independently reviewed qualification.
- Gate-manifest hashes of the twelve original continuation files match the original review manifest except three newly added a6 files with checkout-only newline conversion: `live-continuation.ts` and the two new continuation tests are LF in context-current and CRLF in native-transfer. For all three, CRLF-to-LF-normalized text is identical and native `git hash-object` matches the exact original a6 blob (`168e867a…`, `2ee87276…`, `f51b4e96…`). This is product/content identity, not a false assertion of cross-checkout byte identity. The gate's own before/after bytes remain identical.
- The same full-gate `live-batch/fixture.json` records committed original output, producer1, parent requests2, child requests2, actual hold-at-rejection/live-at-next-request checks true, and the recovered completed result in the second child request with `isError:true`. It does not replace failed outer metadata with synthetic success.

The original core focused/named/type evidence remains as reviewed previously; there was no new core/product change or need to rerun it in this scoped review. The independent qualification review's passing final typecheck and one-file review remain applicable.

## Remaining limits and carried finding

The previous 19/20 candidate gate, `[1,2,2]` numerical failure, `[1,2]` diagnostic failure and one BASE pass remain original evidence. This review does not rewrite them as passes, establish source independence, or attribute historical003's first trigger. It establishes that the required gate now passes with the completed-state precondition genuinely satisfied and a separate unfinished-close scenario qualified.

The running control covers orderly close of one service-owned guest, not a still-running ordinary child/teammate, simulated process crash or broad timing stress. The positive covers both original child kinds. These limits do not reopen the specific P1 gate obligation but constrain wider claims.

The independent qualification review's **P3 at `code-mode-children-close-boundary.test.ts:163` and `:270`** remains deferred: evidence-write failure can skip subsequent cleanup and mask a primary failure. It is nonblocking for the saved successful evidence inspected here; this review does not mark that cleanup issue fixed.

The originally missing `final/public-and-generic-source-diff.txt` remains qualified by the original review's direct targeted comparison. No original receipt was reconstructed or claimed to exist.

No runtime, tests, application/model traffic, broad product review, subagents, product/Git mutation or protected-artifact access occurred in this re-review. Only this requested gate-review report was written. Root retains integration and release ownership.
