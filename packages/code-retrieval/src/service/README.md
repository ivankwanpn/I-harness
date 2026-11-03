# Code retrieval service

`../service.ts` assembles the existing `createCodeRetrievalService` factory.
`../index.ts` remains the only public package entry. These modules are private
responsibility boundaries; they do not add public options or notifications.

| Module | State and responsibility |
|---|---|
| `configuration.ts` | Single configuration, closed/stopping flags, active operation Set and serialized control promise chain. Admission/deadlines, cancellation and drain, configure/clear/close. Configuration validation remains in `../config.ts`. |
| `index-job.ts` | Single indexing reservation, retained job promises, last attempt and frozen diagnostics. Authorize/join/force admission, register session bindings, read/chunk/embed staging and synchronous Store commit, settle bindings and retain bounded handles. |
| `search.ts` | Query/path/source filters, captured generation, lexical/hybrid scoring, candidate/result budgets and final publication. It consumes the same Store and operation owner. |
| `revalidation.ts` | Per-search file validation/refusal Maps, typed refusal diagnostics and latest-search health. Cached admission never replaces the final source-authority check. |
| `status.ts` | Single error/source-health and measured embedding counter owner; detached status/config/progress/diagnostic snapshots and phase timestamps. |

The facade creates one Store after workspace identity and initial configuration
validation. Existing Store, chunker, embedding transport, config validation and
gateway reader modules retain their independent authority. Narrow typed owner
capabilities connect these modules; no module receives the entire service state.
Options stay referenced: reader, registration, credential and transport calls
resolve the current options and retain their original receivers. Status resolves
its configuration/job owners lazily, and auto-refresh calls the current public
`service.wait` with the service receiver.

Forced rebuild authorizes all current sources, requested sources and the exact
reserved job before cancelling work. Both joining and force admission check the
reservation again after authorization and retry if its lifetime changed. Control
increments stopping synchronously, aborts every active operation, waits for its
actual settlement, then performs the mutation. Forced replacement is reserved
inside that same control owner before admission reopens; the owner does not wait
for the replacement job.

Index staging checks cancellation at the original read/embedding/commit
boundaries. `stageIndex` is returned directly as the tracked operation; there is
no added await between Store commit, health reset, job settlement and reservation
release. Failed/cancelled attempts preserve the last good committed generation.
Search rechecks returned files after candidate work and rejects generation changes
during embedding. Provider usage continues to distinguish measured input tokens
from unreported requests.

Shutdown closes admission through the same serialized control chain, aborts and
drains source/transport/revalidation work, closes the single Store, then marks the
service closed. No early race-with-abort shortcut releases owned I/O. Event
notifications and the E6/E7 event migration remain separate work.

Verification uses controlled temporary indexes and mocked embedding responses:

```powershell
pnpm --filter @i-harness/code-retrieval exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/code-retrieval typecheck
pnpm --filter @i-harness/desktop-gateway exec vitest run test/context-runtime.test.ts test/context-subsystems.test.ts test/native-context-jobs.test.ts test/shared-index-authorization.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/desktop-gateway typecheck
```

The original test suites stay intact. `review.test.ts` additionally characterizes
construction getter order, replaced reader/registration receivers and the live
public wait callback, with passing evidence on the original and split source.
