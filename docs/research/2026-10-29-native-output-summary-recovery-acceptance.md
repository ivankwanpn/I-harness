# Original native output summaries and guarded record continuation

2026-10-29 HKT. The bounded J2 and original-record recovery code is accepted and integrated through MAIN `e4357fab4fd74d003df3a9069ac18e4bfa3d9673`. Integration test forwarding is corrected in `0909f97ee00da6a6df674db58eb1ea87af56b266`. Shipping `job_output` cutover (J3) and cold Desktop consumption (J4) remain separate work.

J2 computes stdout/stderr byte totals and SHA-256 from authenticated original frame pages. It validates full refs, cursor/frame progression, bounded pages and EOF, preserves completeness, and retains one original capture's authority across reads. Shared scans support independent reader cancellation; cached summaries still require current read authority. Pending metadata returns before unfinished dependency registration, so a genuine registered tool call can finalize while the producer is still running. Terminal observation continues to bind the actual finalized recipient catalog.

A qualification run exposed a real storage boundary: native decoding received all150009 stdout bytes and3 stderr bytes, but a frame-sink write rejected with EPERM during rename. The final authenticated archive retained49152 stdout bytes, no stderr, and correctly marked producer-incomplete. Original settlement can reconcile a previously rejected admitted record, explaining why archived bytes exceed successfully acknowledged writes. The exact historical rename owner, whether those bytes had physically reached the body before rejection, and the underlying OS cause were not established. An earlier32768-byte failure remains separately preserved and unattributed.

The repair permits one guarded continuation per authentic admitted record, inside its original write flight. Eligibility is established by the writer's exact original pending object, returned rejection and metadata-rename phase; aggregates or uncertain lease cleanup do not qualify. No bytes, paths, owners or refs are supplied as replacement authority. Written requires exact-record completion, original mutation retirement and final gates. Permanent failure preserves the existing incomplete/recovery behavior. No sleep loop, frame reissue, new artifact or new writer is introduced.

Review also corrected a physical-progress bookkeeping race: explicit reconciliation could apply the original record before a claimed continuation. The writer now records that fact across every original apply path, while retaining the separate invocation-local proof required for Written. Reconciliation cannot become an unearned acknowledgment. Recovery has its own closing/cancellation fence; ordinary admitted writes still drain normally. Completion and settlement cannot overtake an active original frame write.

Root verification on the integrated source:

| Scope | Result |
|---|---|
| Frame continuation, summaries, pages and mutation controls | 67 passed |
| Original exec observation/retention/outcome controls | 37 passed |
| Actual registered native producer, pending/terminal observers and recipient catalogs | 1 passed |
| Context-output, output-retention, exec, session-executor and persistence types | Each exit0 |

The actual MAIN control measured150009 stdout bytes and3 stderr bytes before capture and in the original sink; authenticated archive and summary assertions matched, with complete disposition and no escaped frame-write failure. This diagnostic did not measure internal continuation usage, so it cannot prove absence of an internally recovered OS error. Earlier donor qualification consisted of three complete native runs at22593dc, before the final three-line bookkeeping fix; their source boundary remains explicit. Injected deterministic controls establish the recovery mechanism, not the historical OS cause.

All nine final root invocations recorded494 unchanged local source/test/native-asset inputs and new six-root isolation sets. Evidence is `.superpowers/sdd/2026-10-29-integrated-output-checkpoint/`; actual native run `230db3e583e44183970c080e04b3dd86`. Full donor reports, failed receipts, independent reviews, setup corrections and original error observations remain in `.superpowers/sdd/2026-10-27-execution-surface-observation/`. The diagnostic wrapper now forwards all original write arguments to its bound original receiver, preserving continuation controls; that test-only change was independently reviewed.

No whole-version or universal native-completeness claim is made. Existing failed cold/tool oracles, J3/J4 integration, remaining context/event/instruction work and final release gates stay open. Version0.1.13-rc.1 / Session13 and all provider protocol distinctions remain unchanged; no release or push occurred.
