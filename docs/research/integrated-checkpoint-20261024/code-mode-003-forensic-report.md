# Task 1 — bounded failure-only 003 forensic diagnostic

**Status: bounded diagnostic COMPLETE; corrected single sample PASSED; historical 003 remains OPEN.** The initial invocation was setup-limited and preserved. After root proved and authorized restoration of the exact historical raw CRLF runtime inputs, the single allowed corrected named invocation passed. No 003 first-failure stack was obtained; neither stability nor a product recovery fix follows. Both invocation allowances are exhausted.

**Forensic snapshot only — never cherry-pick into MAIN as a fix.** Instrumentation commit `a07f220e75add5e8bcc5da884868a66b121a494a` (`forensics: preserve bounded code-mode 003 failure-only probe (not a fix)`) is on `codex/code-mode-recovery-probe-20261025`, based on `e68b4fc32fefbd98b4857ca70e2e72cf004f6f33`. Writer/runtime root was exclusively `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`, using explicit working directories. Follow-up setup/result snapshot `9f34e988` (`forensics: preserve historical raw setup and single corrected probe pass`) adds only the setup/launch scripts and updated forensic README; the seven historical raw CRLF working files are deliberately unstaged and never shipping changes. This report and its task-1 evidence are the only MAIN writes.

The brief was read first, followed by the full historical causal report and exact original003 test source. Before instrumentation, tracked status was clean and the seven inspected product source trees matched baseline (`git diff --quiet e68b4fc3 -- packages/code-mode/src packages/core-tools/src packages/core-agent/src packages/core-session/src packages/session-persistence/src packages/subagent/src packages/session-executor/src`, exit 0). The unrelated four protected untracked `.retirement-*` directories were never read, executed, modified, staged, copied or deleted. Their directory names appeared only in Git status.

Initial evidence root: `D:/I-harness-main/.superpowers/sdd/2026-10-25-code-mode-recovery-diagnostic/task-1/001-failure-only-named/`. It contains baseline and instrumented source copies/hashes, exact test bytes, runtime/dependency audit, command/environment/timestamps/exit, stdout/stderr, Vitest JSON, the test-owned failure buffer, copied fresh fixture files, durable-order summary, native asset/integrity checks, and the full forensic commit patch.

## Original binding and initial001 invocation

The original source at `2026-10-25-native-consumer-identity-fixture/task-1/003-named-and-negatives-final/execution-authority.source.ts.txt` was copied byte-for-byte only to the forensic checkout's `packages/session-executor/test/execution-authority.test.ts`. SHA256 before invocation and after snapshot: `a45a7eafebd3ae41847437579885e839b67fb194f0b0553402215cfaaa50e775`. The shipping/final fixture in MAIN was not changed.

The one named test was `binds durable child and nested Code Mode receipts and permits only trusted parent visibility`. Its original source and 20,000 ms deadline were preserved. The other six test instances were skipped, including both historical negative controls. No tools/execute wrapper, guest rerun, replacement fixture, additional action, snapshot, reconcile, flush, close or timer relaxation was inserted.

Runtime was existing `C:/Program Files/nodejs/node.exe`, Node `v24.15.0`, direct existing Vitest `3.2.7` CLI. Existing tsx `4.23.12` and TypeScript `5.9.3` were used only for read-only integrity/syntax checks. All 353 audited `@i-harness/*` dependency edges resolved within NATIVE. The declared SDK package's root entry was not resolvable, but all six actual MCP source import subpaths resolved within existing native dependencies; this did not require dependency installation or relinking. Before the initial invocation, no dependency, native helper, manifest, protocol, template or qualification record was changed. The later root-authorized raw-only setup is recorded separately below.

The exact argument array is in `receipt.json` and `run-started.json`. Equivalent command, run from NATIVE `packages/session-executor`:

```text
C:/Program Files/nodejs/node.exe ../../node_modules/vitest/vitest.mjs run test/execution-authority.test.ts -t "^binds durable child and nested Code Mode receipts and permits only trusted parent visibility$" --maxWorkers=2 --minWorkers=1 --config vitest.forensic-003.config.ts --reporter=default --reporter=json --outputFile=<evidence>/vitest-result.json
```

The dedicated config preserves the existing package's Windows fileParallelism setting and adds only the test-owned synchronous setup/afterEach buffer. Invocation environment overrides isolated `IH_CONFIG_DIR`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `TEMP`, and `TMP` into `<evidence>/owned-runtime-profile`; `RUST_TEST_THREADS=1`, `RUST_TEST_NOCAPTURE=1`, and the buffer path were also set. Full controlled values are preserved in the receipt; inherited secrets were not printed. The exact fixture stubs fetch against unexpected network destinations and uses its mock model. No provider, real user profile, push or release operation was performed.

Start UTC `2026-10-25T08:56:43.950Z`; settlement/copy completion UTC `2026-10-25T08:56:52.842Z`; process exit **1**, signal null. The process wall bound was 60 seconds and was not reached. Vitest test duration was 1289.2802 ms; overall reported duration 8.16 seconds. One test failed and six were skipped. There were no pass-until-green loops. The run-once wrapper writes an exclusive marker and refuses another invocation against that evidence root.

## Initial001 actual result and setup discrimination

The final-text assertion at original line 106 passed (`parent done`). The first failed assertion was original line 107: `expect(receipts).toHaveLength(2)`, actual zero. This is different from historical 003, where actual native jobs and completed Code Mode output were retained and a prior recovery error ultimately displaced the child's continuation.

Fresh fixture root: `sandbox-redesign-caller-JwTmBA`; child `child-a99eaabf-4c82-4a0e-b0d9-3aeb1a9f72f4`; cell `e9d04ae7-0ba6-4900-af3b-ad7a85afd867`.

| Durable record | Actual fact |
|---|---|
| main seq12,19,20 | Real parent owner_probe call/dispatch; failed/dispatched result: `Execution admission refused: missing backend requirements: availability, pipe, retained-tree`. |
| main seq27,34,35 | Real spawn_agent call_2/dispatch/task start. |
| child seq10,17,18 | Real code_exec call_1/dispatch/cell started using the exact original source. |
| child seq19,21 | Real nested owner_probe; failed/dispatched result with the same native admission refusal. |
| child seq22,23 | Truthful failed cell and failed Code Mode observation, no emitted text items or completed-cell claim. |
| child seq31,37 | Child receives mock `done` and ends its turn. |
| main seq36,37,45,51 | Subagent reports completed, parent receives `parent done`, then turn ends. |

The buffer persisted after the original test body and its nested finally cleanup settled. It reports `installed: true`, `installedType: function`, `dropped: 0`, `entries: []`. Saved exact sources verify the capture statements are installed at the selected failure branches. Empty entries are not evidence that historical 003 is absent or repaired: this run's native admission failure bypassed the successful output/recovery sequence required for 003. No first FACT failure stack from003 was obtained.

Read-only asset audit found:

| Input | SHA256 |
|---|---|
| Existing helper and manifest helperSha256 | `300348687570c71e3012545442336f807f8e7f66478d6eaaf1d35e016d70e68d` |
| Existing MSYS template and manifest msysPty.sha256 | `334994eec6217a985841b65b3d81553556f406ac6baf7de8893bb123805b8b6d` |
| Manifest protocolSha256 | `fc0e8472f35a210d9cab523c226ad53866947f81dde4c525ed3562be1663a287` |
| Actual NATIVE protocol.md, baseline e68b4fc3 Git blob, and LF-normalized bytes | `e795fc9cae6e26d45ecdba592e13f84eccc803bae141ffc37f6acd3d0bd2912c` |

A direct read-only call to existing `verifyHelper()` reproduced `Windows helper protocol hash mismatch` at `packages/sandbox-windows-psec/src/integrity.ts:40:55`; it performs file reads/hashes and starts no helper process or job. Existing `index.ts` probe catches that error and returns unavailable with false pipe/retained-tree capabilities; existing execution admission then produces the durable refusal above. This source chain and independent hash check establish the setup obstruction. Root subsequently proved the historical protocol and six digest-bound sources used CRLF raw bytes while their LF-normalized bytes equal baseline Git content; this was a checkout portability obstruction. No correction was applied until root specifically authorized restoring those immutable historical raw bytes, without changing manifest hashes or choosing another helper. The initial setup-limited report is preserved verbatim under 001; its earlier statement excluding line-ending conversion is superseded by this independent root evidence.

The fresh fixture was copied only after the test process settled. Its original fixture and all evidence remain. The original test's finally performed the existing kill-job list (empty), reader.close, assembly.dispose, coordinator.close. The failing test completed and no separate cleanup error was reported; no additional cleanup action or source-close call was added. The copied lock files are preserved filesystem artifacts, not a claim that their locks remained active.

## Root-authorized historical raw setup and corrected002 invocation

Corrected evidence root: `D:/I-harness-main/.superpowers/sdd/2026-10-25-code-mode-recovery-diagnostic/task-1/002-historical-bytes-corrected-named/`. The initial001 artifacts, source copies, failed receipt, buffer and fixture remain intact.

Root authorization was explicit: restore only the exact immutable original raw bytes from `2026-10-24-windows-native-event-owner/final-review-package/body/packages/sandbox-windows-psec/`, for protocol and mismatching manifest.sources whose normalized bytes equal e68b4fc3 Git. Root's independent `protocol-checkout-audit.json` and `source-checkout-audit.json` bind the historical CRLF hashes. No helper rebuild, hash patch, manifest/qualification edit, dependency rewrite or semantic source edit was authorized or performed.

The setup script prevalidated all files before copying. Frozen raw SHA had to equal the existing historical manifest value; both target and frozen LF-normalized bytes had to equal the exact baseline Git blob. Real paths were confined inside the named NATIVE package and immutable source package. Only these seven mismatches were copied:

- `protocol.md`
- `native/msys/api.h`
- `native/msys/bridge.c`
- `native/src/runner/dispatch.rs`
- `native/src/runner/event_drain.rs`
- `native/src/runner/notifications.rs`
- `native/src/runner/running.rs`

`setup-receipt.json` preserves all 30 source identities plus protocol, exact immutable paths, baseline hashes, before/historical/after raw hashes, copied paths and timestamps. `setup-before/` and `setup-after/` preserve the raw bytes. Protocol now has historical raw `fc0e8472…` and normalized `e795fc9c…`; all 30 manifest.sources match their historical raw hashes. Direct existing `verifyHelper()` and `verifyMsysBridge()` passed with exact helper 300348/template 334994 and no helper process started in these read-only checks. The unchanged manifest bytes were checked after copying.

One preflight used an overly strict raw manifest equality guard and stopped before creating the stage or mutating any file. Frozen/native manifest JSON fields were identical; their raw difference was solely CRLF vs LF. This preflight and source script are preserved in `task-1/setup-preflight-manifest-comparison.json` and `task-1/setup-preflight-raw-manifest-equality.cjs.txt`. The corrected guard permits only normalized equality of the two unchanged manifests. This was not a test/runtime invocation.

The corrected command, config, test name, worker settings, deadline and environment isolation match 001, with output/profile/buffer paths changed to 002 only. The exact003 fixture hash remained `a45a7eafebd3ae41847437579885e839b67fb194f0b0553402215cfaaa50e775`. All nine TypeScript product instrumentation/helper/test/setup/config source hashes were unchanged between 001 and 002. A fresh audit again found all 353 workspace edges inside NATIVE. No success-path continuation or timing relaxation was added.

UTC start **2026-10-25T09:12:12.054Z**, completion **2026-10-25T09:12:19.787Z**, exit **0**, signal null. Vitest: **one passed, six skipped**, named test duration 1778 ms, overall 7.10 s. Neither the original 20 s test deadline nor 60 s process wall bound was reached. No further run was made.

Fresh fixture `sandbox-redesign-caller-mOjroR` contains the authentic `ownership-receipt.json` and durable journals. Child `child-78272942-c405-4aa1-9902-214604d43ef9`, cell `2d1cf833-2bba-4d3d-ac5e-83b337cb250d`:

| Durable record / asserted result | Actual fact |
|---|---|
| main seq12,19,20 | Real parent owner_probe succeeded with main-owned native job receipt. |
| main seq27,34,35 | Real authenticated synchronous spawn_agent call_2/dispatch/task start. |
| child seq10,17,18 | Real code_exec call_1/dispatch/cell start. |
| child seq19,21 | Real nested owner_probe succeeded; actual bash-2 receipt owns the child and parentSessionId main. |
| child seq22,23,24 | Retained artifact output, true completed cell, succeeded/dispatched code_exec with completed observation. |
| child seq32,38 | Child assistant done then turn/end. |
| main seq36,37,45,51 | Completed retained task/result, parent assistant parent done then turn/end. |
| Exact fixture assertions | Two authentic receipts; durable child profile parent binding; completed cell/nested call/artifact output; task toolCallId call_2 and callEventSeq27; complete 21-byte task artifact; trusted parent reads actual done result; unrelated session unauthorized. |

The corrected failure buffer again reports installed/function, entries 0, dropped 0, persisted after test settlement. No initial FACT failure from003 was captured. This single successful sample is a **nonreproduction**, not evidence of baseline stability, safe automatic retry, changed error precedence or a solved003 trigger.

Original fixture cleanup completed before process settlement: both owned job IDs were included in its existing killJob cleanup, followed by reader.close, assembly.dispose and coordinator.close; no cleanup failure was reported. The ownership receipt was written before cleanup, so its child job status running is that reporting-time state, not evidence of a leaked post-cleanup process. No extra kill, close, snapshot, flush or reconciliation was added.

The historical raw CRLF setup remains only in NATIVE and is deliberately not staged. Git status reports seven raw-byte modifications; normalized Git diff is empty for those files. Their exact raw bytes are preserved outside Git in 002. Do not normalize them, stage them, or transfer them to MAIN as a fix; root owns a separate canonical build/checkout correction.

## Instrumentation and exact diff

The initial instrumentation commit contains 11 explicitly staged files, 259 insertions and 12 deletions. The follow-up forensic setup/result commit adds two task-owned scripts and updates the README (three files, 109 insertions, one deletion); it stages none of the seven raw setup files. `forensic-snapshot.patch` contains the exact full diff; `snapshot-source-hashes.json` binds every file. The larger test diff is solely restoration of the original003 bytes, not new instrumentation inside the fixture.

| File | Change and failure-only justification |
|---|---|
| `packages/code-mode/src/runtime/output.ts` | Imports a synchronous helper; calls only in existing FACT output-publication catch, existing projection catch, and existing FACT observer catch immediately before retained observation registration. Original errors still propagate unchanged. |
| `packages/code-mode/src/runtime/retirement.ts` | Imports the helper; calls only in existing FACT close-failure, terminal catch and finalize catch branches, before their original recovery transitions. Existing catches/awaits and recovery calls are retained; no success continuation is added. |
| `packages/code-mode/src/runtime/forensic-003.ts` | Never-throw scalar-only cell capture: original cell/session/call IDs and sequence, status/finishing/recovery/terminal/completion flags, pending receipts/items/bytes/projection, counts of calls/producers/items, and failure-site local booleans. No text/item/store bodies are read. |
| `packages/code-mode/src/event-facts.ts` | Adds never-throw capture only to existing preparation, local installation, and ordered refresh failure catches. Captures original cause, original source/fact presence, installed flags and pending/source/action counts before existing wrapping or recovery holds. No fact.observe/reconcile/admit call is added. |
| `packages/session-persistence/src/coordinator/managed-document.ts` | Adds a synchronous local helper invoked only in existing invalid-source/recovery authorization refusals and observable refusal. Captures existing pending batch identity/count/issue/receipt flags, local fences/counts and up to32 original source finished/closeRequested flags and exact action/source comparisons. The original refusal error is constructed once and the same object is thrown; source invalidation retains its original ordering. |
| `packages/subagent/src/child/lifecycle.ts` | Adds one never-throw synchronous statement at the start of the existing child-run rejection callback, before err.message/String(err) serialization. No new then/catch stage or success hook is added. |
| `packages/session-executor/test/execution-authority.test.ts` | Exact historical 003 restoration; its SHA proves absence of fixture instrumentation or substituted final fixture. |
| `packages/session-executor/vitest.forensic-003.config.ts` | Dedicated forensic config preserving package scheduling and registering the test-owned setup file. |
| `.forensic-003-20261025/setup.ts` | Installs the bounded synchronous buffer before test execution; existing failure-branch statements alone append entries. A synchronous afterEach writes only after original test/cleanup settlement. All capture/persistence errors are swallowed so they cannot replace original outcomes. |
| `.forensic-003-20261025/run-once.cjs` | Reviewable bounded launcher, exact fixture hash guard, exclusive once marker, isolated controlled environment, timestamps/exit/stdout/stderr and post-settlement fresh fixture preservation. |
| `.forensic-003-20261025/README.md` | Forensic-only label, actual setup result, evidence pointer and no-shipping warning. |

Buffer limits: 64 entries; cause/AggregateError depth 5; at most 8 children per aggregate; at most 24 expanded error object nodes per entry; each error field capped 8192 UTF-16 code units and error-object field string budget 32768 per entry (primitive cause/aggregate-child strings are independently capped at8192); state 48 keys, arrays 32 rows, at most 8 scalar fields per row. Error objects get test-local WeakMap IDs to compare shared identity without retaining payloads. Cycles/depth/node limits produce bounded markers; excess entries increment dropped. State is copied synchronously from existing local flags/counts and the existing finished closures (which return the local action-finished scalar); no new owner state snapshot is requested. No payload body is inspected by instrumentation. Source/key data is limited to already-local batch identifiers/counts, and the original errors retain their precedence.

Verification: exact fixture SHA passed before run and after commit; nine TypeScript files parsed with zero syntax diagnostics; `git diff --check` and staged whitespace check passed before commit; the initial post-commit tracked and staged diffs were empty. At final settlement, staged diff is empty; the seven historical raw setup files remain deliberately unstaged and semantically identical to baseline Git. Existing dependencies and helper assets were audited without rewriting. No broad suite, additional behavioral rerun beyond the single setup correction, alternate native workload or dependency install was performed.

**Limits and next decision:** The bounded diagnostic is complete: one initial setup-limited attempt, one root-authorized corrected invocation, no behavioral retries or loops. The corrected sample passed and 003 remains open. The historical first trigger is still unselected. No baseline-flake, stability, solved, shipping-fix or automatic retry-safety claim follows. If root wants a subsequent deterministic protocol test, the source-based candidate remains the existing original output capture boundary at `output-facts.ts:26`: hold the original capture, return its actual unknown disposition once, then release the same resume handle and assert one guest/tool execution, exact original source/call identity, true completed output and preserved initial error precedence. This tests a downstream recovery contract rather than proving the historical trigger. No barrier or speculative retry/error-precedence change was implemented here. Root owns any further diagnosis, canonical build/checkout fix and independent product review.
