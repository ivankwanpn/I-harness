# @i-harness/sandbox

Shared process sandbox contracts and platform neutral execution lifecycle ownership. Import supported APIs from `@i-harness/sandbox`.

The execution foundation exports the following contracts:

| Contract | Purpose |
| --- | --- |
| `ProcessSpec`, `ExecutionOwner` | Exact argv, cwd, environment, owner, transport, lifetime, argument encoding and optional PTY dimensions |
| `AuthorityState`, `CompiledSandboxPolicy` | Authority snapshot and compiled immutable policy, including all authority roots |
| `BackendProbe`, `BackendRequirements`, `BackendDecision` | Explicit capabilities, assurance and negotiation result |
| `ExecutionBackend`, `PreparedExecution` | Probe, preparation, commit with a trusted authority callback, and rollback |
| `ExecutionReceipt`, `ExecutionHandle` | Attribution and one owned execution, with root status and settlement |
| `RootExit`, `ExecutionSettlement`, `StopReason` | Known or unknown root status, cleanup result and cancellation reason |
| `ExecutionTransport`, `ExecutionLifetime`, `BackendAssurance` | Pipe or PTY, complete or retained tree, and verified/experimental/unverified assurance |

`checkBackendRequirements(probe, requirements)` compares one backend with explicit requirements. It refuses unavailable backends, missing capabilities, insufficient assurance, and malformed runtime contracts. A failed decision contains stable missing requirement labels. The function does not select a backend or try another one.

`createExecutionLease({ receipt, rootExited, waitTreeEmpty, settleIo, releaseResources, terminate })` creates one owned handle. Successful settlement requires confirmed tree emptiness, successful I/O settlement and successful resource release. Root exit alone cannot satisfy these conditions. A root observation rejection becomes `RootExit` with `exitCode: null` and sanitized `observationError`; independently confirmed cleanup can still release resources.

Concurrent cancellation and release share the active cleanup promise. Cancellation waits for an admitted termination attempt as well as cleanup. A failed phase returns `kind: "incomplete"` and retains resource ownership; an explicit `cancel` or `release` can retry unconfirmed phases. `handle.settled` is a getter for the current attempt's promise. A historical incomplete promise remains incomplete after a retry. Successful resource release happens once, and cancellation after confirmed tree emptiness joins cleanup without starting another termination.

Preparation and admission are composed through `launchExecution` from `@i-harness/exec`. That helper checks abort and authority before probing, negotiates before preparation, checks abort and authority after preparation, and supplies the same callback for the backend's final commit fence. Failed commit or revalidation rolls back returned prepared resources before rejection. Rollback failure is retained with the original cause in an `AggregateError`. The supplied immutable spec and policy reach preparation by reference, and successful admission returns the backend's exact handle. The backend must clean up allocations from preparation that rejects before returning a `PreparedExecution`.

Callers must choose requirements that describe the exact supplied spec and policy. Backend implementations must honor those inputs, keep the prepared policy tied to that exact command, and invoke the callback immediately before allowing workload execution. After a successful commit, the handle owns cleanup; callers retain that handle when changing presentation between foreground and background and use `cancel` or `release` to settle it.

The legacy `SandboxProvider`, `SandboxExecutionPolicy`, capability checks, denial/escalation helpers and argv runner failure classifiers remain supported during runtime migration. The new foundation is additive; the live exec and terminal paths have not yet migrated to this handle contract.

## Verification

Foundation gates run from the repository root on 2026-10-07:

| Command | Observed result |
| --- | --- |
| `pnpm --filter @i-harness/exec test -- test/execution-contract-consumer.test.ts` | 23 public consumer tests pass |
| `pnpm --filter @i-harness/sandbox test` | 125 tests in 7 files pass |
| `pnpm --filter @i-harness/sandbox-policy test` | 64 tests in 3 files pass |
| `pnpm --filter @i-harness/exec test` | 64 tests in 7 files pass |
| `pnpm --filter @i-harness/exec --filter @i-harness/sandbox --filter @i-harness/sandbox-policy typecheck` | Exit 0 |
| `pnpm typecheck` | Exit 0; existing workspace dependency cycle warning |

The public consumer tests use the real policy compiler, negotiation, admission helper and lease with a fake process boundary. They cover pipe/PTY contracts and receipts, pre-abort and revoked authority refusal, capability refusal, asynchronous preparation revalidation, final commit fencing, rollback errors, one returned handle, retained presentation and cancellation through tree/I/O/resource settlement.

## Limits

These tests establish common contract ordering and ownership. They do not prove native confinement, Windows PSEC enforcement, process-tree observation accuracy or atomic OS launch. Backend probes declare assurance; negotiation compares that declaration without certifying it. Driver hooks must confirm actual native facts, terminate the correct tree and make cleanup retries safe. Pending hooks can wait indefinitely; the common lease supplies no native timer or process interruption.

The authority callback is a trusted supervisor fence, not a serializable authorization secret. Native suspended creation and final resume fencing remain backend responsibilities. The admission signal is checked at admission boundaries; after successful commit, lifetime cancellation uses the handle. The retained presentation test demonstrates consumer handle reuse and does not migrate or qualify the existing live job registry. This base handle has no workload streams or terminal I/O extension. Later supervisor/legacy-driver migration, terminal/authority integration and native Windows PSEC implementation and qualification remain necessary for the full redesign.
