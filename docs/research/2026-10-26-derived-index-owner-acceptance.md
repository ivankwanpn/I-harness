# Derived-index ownership and exact-budget cleanup — scoped acceptance

The connected implementation, earlier expiry traversal, final native/caller qualification and MAIN integration are accepted through `9ef15a8ebfc6388e7875edd024b88efe611b6c74`. Product remains `0.1.13-rc.1`, MAIN Session format12. This closes the reproduced full-budget legacy cleanup gap and its supporting owner work. It does not close public semantic fork, all long-session performance work or the release gate.

The binding [spec](../superpowers/specs/2026-10-26-derived-index-owner.md) and [plan](../superpowers/plans/2026-10-26-derived-index-owner.md) consume the already accepted [native/gate foundations](2026-10-26-derived-index-foundations-acceptance.md). Original result files, owner ledgers and managed facts remain authoritative. The SQLite index is reconstructed under the same Store/lifetime owner when needed; its readiness is separate from whether requested original cleanup completed.

## Final behavior

One lifecycle owns the actual SQLite handle, generation, mutation admission and disposal debt. A creating-gate lease spans the complete read/query or write-capable operation. Native statements/cursors do not survive across asynchronous policy or file work. Expiry performs a complete original-authority preflight and one streamed effect pass rather than repeating whole graphs for each ref.

Cleanup first removes canonical authority and files with their existing proof and retry anchors. It does not require an FTS deletion to succeed at an already full quota. If valid surviving originals cannot fit a freshly reconstructed index, requested cleanup can complete while search reports explicit unavailability; valid direct reads remain available. Actual original file, ledger or native-disposal failures still reject and retain their original resources. No quota raise, hidden reserve, fabricated empty search or producer replay was added.

Capture chooses incremental mutation or an unpublished fresh candidate before canonical mutation, using the actual encoded prospective allocation. It retains one producer/result and publishes the candidate only after original files, native commit and final guards settle. Grants keep their canonical ledger checks/restoration and final cancellation guard. The unused SQL owner mirror writes were removed after verifying no SQL consumer; the canonical owner maps/ledgers and unchanged empty table schema remain.

## Review and integration ranges

Earlier expiry donor `a3dbcfc5..abbc30c4` was not accepted alone. Its final connected form was reviewed together with owner candidate `6689aa95..28fd2cdb`, then corrections `6cbf31c3` and `0ad73a0a`. Task2 added only the actual Gateway caller test at `12bc2b44`. Already accepted intervening foundation commits were reused, not re-integrated or treated as new product review.

These commits map to MAIN `497ad8ab`, `7cd392a8`, `a5b86397`, `b96bd9a7` and `3fac19ad`. The earlier WIP commit message preserves its historical failing state; acceptance is for the complete final range. Root additionally corrected an old Executor test's private cleanup call in `9ef15a8e`.

The fresh full-range reviewer approved the expiry semantics and found three P2 status defects in the connected owner: a stale completed-cleanup prefix, one failed cleanup scope overwriting another, and unrelated hint preparation clearing an unrepaired binding's error. Causal tests reproduced each. The same reviewer required a second correction for queued inventory failure before helper entry. Final status handling now belongs to the entire queued cleanup transition, retains unresolved requests by scope and retires hint errors only for the repaired binding or actual reconstruction.

The same reviewer approved the two correction rounds, Task2 evidence/caller test and the final MAIN followup. The followup removed an unused, unawaited direct `ContextStore.close()` call without its creating-gate lease; the fixture still awaits the actual service owner's cleanup. No substantive test assertion or product behavior was weakened.

## Verification and provenance

Raw reports, commands, source manifests, causal failures and reviews remain under `.superpowers/sdd/2026-10-26-derived-index-owner/`.

| Source and gate | Observed result |
|---|---|
| Task1 corrections |First round's five new cases fail on its baseline, then89 affected tests pass. Second round's four new filesystem cases fail on round1, then93 affected tests pass. The original full-budget positive and frozen types pass separately. These overlapping populations are not summed. |
| Frozen product `0ad73a0a` |Exactly one ContextOutput fast gate:36 files,338 passed, one10001-named case intentionally filtered out. ContextOutput package types pass. All4291 tracked raw hashes remain identical across qualification. |
| Explicit native gate |Both qualifier tests pass, covering14 scenarios on pinned Windows x64 Node24.15.0/SQLite3.51.3 and Node22.18.0/SQLite3.50.2. Original official executable/fixture checksums are verified before launch. |
| Qualifier boundaries |Missing inputs, nonexistent executable and wrong-role executable refuse with exit2 before output/native children. Ordinary discovery finds36 ordinary files without qualifier/author-local inputs. |
| Actual Gateway caller |Final context-subsystems file16/16 and affected tracked-source/named-test types pass. Only this test file differs from frozen product; other4290 raw hashes match. Its initial manifest-shape assumption failure is preserved as test-author error. |
| MAIN `3fac19ad` |All23 donor file identities,11 raw fixtures and both qualified schema groups match. Owned-index/legacy tests98 pass plus one deliberately filtered case; Gateway context/capture tests33 pass; ContextOutput types pass. Executor types expose the old test cleanup signature error. |
| MAIN followup `9ef15a8e` |Correctly isolated actual result-store close tests5/5, Executor types and Gateway types pass. Only the test cleanup changed;2923 source entries remain stable during followup. An earlier non-isolated exploratory run is excluded from qualification and documented. |

The real full-budget fixture retains eleven refs, two observations and two applied roots, exact configured physical bytes258749, four graph walks/88 rows and eleven terminal slot effects. Canonical removals, no replay, surviving original bytes and final physical usage within the same quota are asserted. Counters do not substitute for authority/file checks.

The Gateway controller uses the actual ContextOutput service and storage. Successful cleanup with an unavailable index resolves to a fresh error/count-one snapshot, preserves survivor files/direct read and rejects indexed search explicitly. A real canonical-body removal EIO preserves the exact error object, original files and incomplete status, then recovers through a controller retry.

Root audited final23 raw/Git paths and all20 Task2 command streams. Independent review also confirmed14 native source bindings and source manifests. The final integration review checked all14 streams across initial/followup MAIN receipts and the executed final test bytes. No unchanged full338 or dual-runtime native gate was repeated solely because a separate caller/cleanup test changed.

## Native and program limits

The native evidence applies under the reviewed SQL/schema/resource conditions and pinned Windows runtimes. It retains the separate fresh8192 and existing-image journal bounds, schema21 pages/cap64 and same-transaction ceiling raise. Source arguments and phase snapshots are not continuous native-memory/filesystem-peak measurements or internal SQL tracing. Six normal floor children retain Node22's expected SQLite ExperimentalWarning in stderr; no assertion failed or warning was hidden.

The1001/10001 scale work was not rerun here. Historical1001-ref latency and the remaining aggregate-funding/performance task remain R6 obligations; this acceptance does not infer a new large-scale timing result. Public F1-C, child/instruction integration, complete internal event delivery, all-platform and packaged release gates remain open. The original full-budget cleanup and expiry-traversal failure are resolved in this final connected range and should not be redispatched as unfinished standalone WIP.
