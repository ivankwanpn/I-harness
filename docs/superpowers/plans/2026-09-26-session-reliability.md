# Session reliability: approved B01–B05

Scope approved by the user on 2026-09-26. Work stays in D:/frontend-test.
No push; per-model contextWindow remains the user's capacity choice.

## B01 — cancellation ownership

- [x] Reproduce running A plus queued B: session/cancel previously targeted B.
- [x] Let the execution lane own its running abort controller; SessionService selects it.
- [x] Keep independent transport controllers for every outstanding prompt.
- [x] Preserve explicit queued cancellation by row id and repeat-stop idempotence.
- [x] Reference-count gateway prompt activity instead of deleting a shared set entry.
- [x] Reject submit after asynchronous preparation completes during shutdown.
- [x] Verify cancellation and delayed preparation regression tests.

## B02 — persistence acknowledgement

- [x] Reproduce completion before final flush and swallowed shutdown flush errors.
- [x] Await the existing persistence barrier after stop hooks and before returning success.
- [x] Report completed execution with failed saving; do not imply external work was rolled back.
- [x] Aggregate final flush errors after best-effort cleanup of all sessions and ownership leases.
- [x] Verify delayed/rejected final save and another session successfully draining on close.

## B03 — live model limits

- [x] Reproduce large-to-small model rebind with old compaction/output limits.
- [x] Update the existing agent's compactor, context budget and output cap together.
- [x] Install validated limits and matching client/effort synchronously; then update reported binding.
- [x] Re-register context-remaining tool for the new capacity.
- [x] Read inherited child/guardian/team limits through current option getters at new spawn/review.
- [x] Reject rebind during service work, active agent tasks, direct run or manual compaction.
- [x] Keep the same assembly/session and durable history.
- [x] Derive reset options from the latest budget rather than construction-time variables.

## B04 — restored model selection

- [x] Pass coordinator.profile metadata into the Desktop SessionService.
- [x] Expose the existing session/model/state hook after validating session existence.
- [x] Verify saved selection wins over a different global default without calling the model.

## B05 — cold history

- [x] Add optional coordinator.snapshot for pure durable-prefix reads.
- [x] Reuse version validation and migrations without repair, writer ownership or runtime construction.
- [x] SDK uses live history first, then snapshot where supported; legacy hosts retain their fallback.
- [x] Verify history without configured credentials and byte-identical persisted file.
- [x] Update the old sandbox test to execute a real turn rather than depend on history side effects.

## Independent review

One read-only reviewer inspected the changes. Two important findings (late submit
after close and rebind during direct compaction) and one budget-policy finding
received reproducing regression tests and fixes. No second review was substituted
for those tests.

Existing CLI live-rebind-before-metadata-write ordering was noted separately by
the reviewer. A metadata write failure can still leave live and saved selection
different; this separate transactional-settings issue is not claimed fixed here.

## Verification record

Detailed full-run logs live outside the repository in the chat's backend-audit
artifact directory. The first verify:all run identified one old sandbox test and
three unused memory exports. The test was updated to the new read-only contract;
the public exports were narrowed rather than exempted from reachability.

The final verify:all result is recorded in the external completion report.
Portable packaging and the ZCode visual redesign remain separate delivery work.
