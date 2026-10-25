# Task 1 independent review — 2026-10-25

**Scoped fixture verdict: accept the bounded test correction. No actionable defect or required revision found in the reviewed range.**

**Overall 003 / N2 integration verdict: unresolved; this review does not approve overall readiness.** Attempt003 is a real failure of the authenticated child Code Mode path. Its initial recovery trigger remains unproved. The final passing gates and the six hook-assisted passes do not close it.

## Reviewed scope and method

- BASE `e68b4fc32fefbd98b4857ca70e2e72cf004f6f33` through HEAD `4a0ddfe4d79708da45db1040afb412978738196b`.
- Sole changed file: `packages/session-executor/test/execution-authority.test.ts`, 80 insertions / 5 deletions. Reviewed the complete `review-e68b4fc3..4a0ddfe4.diff` and committed source, not only the final incremental edit.
- Read `task-1-brief.md`, `task-1/task-1-report.md`, `code-mode-003-diagnosis.md`, upstream `2026-10-24-windows-native-event-owner/consumer-076-diagnosis.md`, the final raw receipts/logs and selected actual JSONL/artifact files, and the shipping result reader/store/disposal implementation. The inspected product source files match BASE by a read-only scoped `git diff --quiet`.
- Performed read-only source/hash/evidence checks. No tests, native jobs, repeated runs, build, product/test/Git mutations, or subagents. The protected repeated-growth diagnostic was not read or run. This requested review report is the only file written by this review.

## Specification and quality assessment

The positive fixture now uses `assembly.agent.run` with the required mock order: parent `owner_probe`, parent synchronous `spawn_agent`, child `code_exec` invoking `owner_probe`, child `done`, parent `parent done` (final source lines 92–116). The probe retains the original closure over the actual execution service and launches real native jobs with the original `setTimeout(()=>{},1000)` command. The original two-receipt count, parent owner, child owner/parentSessionId, persisted parentSession, and execution-job owner checks remain (117–123). No caller descriptor is manufactured.

Actual final014 JSONL corroborates this path: main `owner_probe` call_1 seq12, main `spawn_agent` call_2 seq27 with dispatch seq34, and successful spawn result seq37. The child is `child-4456c9ce-090c-4606-9eca-570506ff15a8`, with header parentSession `main` and origin `subagent`. Child `code_exec` call_1 dispatches at seq17; cell `581f5b63-7878-4dc5-9e5c-2149289ea710` records nested `owner_probe`, actual retained output, completed seq23, and succeeded/dispatched outer result seq24. Child `done` and parent `parent done` are recorded. The two native receipt execution IDs are `5b4270f3-e04d-4ece-89fd-ced90864306f` and `7f88d83e-da3e-42a0-a404-43ca3cc68a40`, with the expected main/child ownership.

The new artifact assertions use the actual task document's retained ref, require completed task/child identity and nonempty parent call identity, then require complete `json-utf8-v1`, 21 encoded bytes. They read the actual body through `createSessionService.readResultPage`, require the exact ref and EOF page, and decode `{resultText:"done"}` (132–152). The saved operation independently binds artifact `ctxv1_9a5f0721224881962da3ed2865c381b609716e5798a8f090727d924ab756dd61` to main/task-1/document task-main and captured source `session-scope:4ca2fb02ad17779adae70fb68137990da8b0d3c121cec85b2cfea4fbcaf496f1`. Its committed body is exactly `{"resultText":"done"}`, with digest `fd378c97aa1e714837245f728f224241b405c18cf25e27e18930bba4288687c2`.

Cold retrieval is substantive: owned probe cleanup and awaited producer `assembly.dispose()` precede the first read. Creating the reader object earlier does not acquire a result-store lease: `service/result-reader.ts` acquires the read lease lazily inside `read`; `lifecycle/result-store.ts` closes/removes the last producer-owned store on successful release. The assembly disposal path awaits native/subagent/Code Mode cleanup, publication/document drains, and result-store release. No supplied availability, confirm, read, source, or ContextOutput adapter keeps a producer registration alive. The coordinator remains open for the public read and its actual authorization checks. This qualifies cold result-store retrieval after producer disposal, not a new-process or entirely new-coordinator restart claim.

The separately created `unrelated` session reads the same ref through the same shipping route and must receive exactly `unavailable/unauthorized`. The saved ownership receipt records the real parent body/EOF and unrelated denial. This supplies the explicit access denial missing from the original convenience fixture; owner strings or `listJobs` are not used as substitutes.

The separate identity-less negative genuinely completes a controlled child, then requires `FACT_RECOVERY_REQUIRED` caused by `unsupported-owner`, a completed child message, and an unavailable 21-byte envelope with no durable claim (162–183). It neither injects parent authority nor adds probe jobs/receipts to the positive. The existing spoofed-child prepared-dispatch refusal remains unchanged, including the assertion that the tool body did not run.

Cleanup now targets only the two IDs recorded by this probe, checks rejected cleanup results, and retains owner disposal in nested finally blocks. Final014 records parent `already-finished` and child `cancellation-requested`, both fulfilled. Terminal idempotence is treated honestly. The probe duration, Code Mode yield, test deadline, ROOT/EOF/resource expectations, native assets, retention guards, source resolution, and report policy are not weakened by the diff. In particular, the complete task artifact and completed JavaScript cell do not relabel the child native frame artifact's producer-incomplete state as native EOF.

## Evidence binding and recorded final validation

Independently checked all 610 entries in `task-1/evidence-file-manifest.json`: byte lengths and SHA256 values all match, with no path outside the owned evidence directory. The manifest hash matches the seal (`21e7c5e2420a1843dfb2be0fbf880e6d24c5dc1543c2f3acb24be19fb2fbc955`); the sealed implementation report hash also matches. All 15 stage source snapshots match their raw receipts and `source-bindings.json`, including the explicitly reconstructed earlier snapshots. The final committed source equals the final snapshot after CRLF/LF normalization; final raw snapshot SHA256 is `955ff5e7dbd4ca1b84664063292bc8dcf6d29739610610b889f9399404bd8af9`. Final stage receipts correctly record BASE as the then-current HEAD plus this test source hash; they are not mislabeled as post-commit runtime executions.

The preserved raw gates on that final source are:

| Stage | Recorded command result | Review limit |
|---|---|---|
| 013 cold named and negatives | 3 passed, 4 filtered/skipped, exit 0 | One named/control gate, no diagnostic hook |
| 014 cold original076 focused set | 20/20, three files passed, exit 0 | One gate on the final cold-reader source |
| 015 cold executor typecheck | `tsc --noEmit`, exit 0, no diagnostics | Static check on the same source |

The logs/receipts bind package CWD, Node argv, owned profile/config paths, sequential intervals, and Vitest maxWorkers2/minWorkers1. I inspected those saved results and did not rerun them. A fresh read-only `git diff --check BASE HEAD` returned 0 and the range lists only the scoped test file.

Independently rehashed the current HOST final test, Windows helper, MSYS PTY template, and native manifest against `after-hashes.json`: all match. The native hashes equal the recorded before hashes. Independently rehashed all three original076 HOST JSONL anchors against the preserved diagnosis values: all match. Original076 remains the recorded failed 18/19 run. The diagnosed missing parent source descriptor in that convenience invocation explains its unsupported-owner branch; it does not establish pre-N2 runtime baseline equivalence.

## Unresolved authenticated003 and acceptance limits

I independently inspected the failing003 source/log and actual child/task JSONL. Its authenticated parent task records call_2/seq27. Nested `owner_probe` succeeds at child seq21; the emitted text artifact is complete at seq22; the actual cell completes at seq23. Outer `code_exec` seq24 is **failed/dispatched** while carrying the recovered actual completed observation. The child then ends its step/turn without consuming its `done` response; the task is error `Managed facts require reconciliation`, with a real complete 48-byte error artifact. The parent consumes `done`, and the strict expected `parent done` assertion fails. That assertion exposes the failure rather than causing it or accepting recovered error as completion.

The saved log has the downstream assertion stack. It lacks the initial recovery throw's original stack/cause. The read-only diagnosis explains propagation of a prior dispatch recovery error and identifies candidate recovery boundaries; it does not select the historical first trigger. Unsupported-owner from original076 is not an explanation for this authenticated003 failure. Native causation, a baseline flake, and an assertion defect are all unproved. Six 004–009 passes with asynchronous catch/rethrow hooks cannot establish scheduling stability; later no-hook passes qualify their recorded sources only.

The report's choice to prove durable artifact retrieval rather than require saved top-level `retention === "durable"` is acceptable for this bounded gate. Its retained ref, committed body, cold read and denial are independently substantive. The raw top-level `pending` state remains visible; this review does not decide any separate persistence/reporting freshness issue. Likewise, the identity-less negative uses its actual settled unavailable envelope and cause rather than assuming an immediate saved retentionError field.

Accepted scope is exactly the test-only authenticated fixture correction and its controls in BASE..HEAD, with the recorded final gates and evidence limits above. No fixture revision is requested. Stable076 closure, original003 resolution, broader C2 recovery behavior, whole N2/Task6 integration acceptance, baseline/native equivalence, and version/release readiness remain outside this acceptance. Root retains ownership of the separate C2 recovery diagnosis and integration decision.
