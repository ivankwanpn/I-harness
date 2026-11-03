# Shell discovery and execution

`src/index.ts` is the package facade. It preserves the public types, discovery
functions, `createShellTools` and `registerShell`; the package export still names
this entry. Composition creates the Bash binding map, retention configuration
and tools in their original order.

| Owner | Responsibility |
| --- | --- |
| `src/types.ts` | Public shell, dependency and retention contracts; internal dialect type. |
| `src/discovery/windows.ts` | Native Bash preference, launcher exclusions, PowerShell availability, alias probing and canonicalization. Injected exists/probe defaults remain supported. |
| `src/discovery/environment.ts` | Case-insensitive environment lookup and per-child native Bash PATH selection. |
| `src/command/resolve.ts` | Platform shell selection, immutable WSL options/environment, captured Agent Shell, dialect flags and prompt. POSIX default selection is a single branch here. |
| `src/command/argv.ts` | Advisory argument parsing, with separate POSIX and Windows escape rules. |
| `src/command/identity.ts` | Conservative executable/environment identity for literal native Node version queries. |
| `src/tools/policy.ts` | One sandbox policy resolution per call, escalation context and structured refusals. |
| `src/tools/foreground.ts` | Explicit Bash/PowerShell metadata, Bash executable binding and foreground/explicit background launch through the supplied Exec owner. |
| `src/tools/selected.ts` | One argument-object WeakMap for the selected shell; live descriptions, prepared bindings and execution using that binding. |
| `src/tools/background.ts` | Promotion result projection and messages for the existing Exec job. |
| `src/tools/retention.ts` | One configured spill store, fresh output buffers and original Exec retained-reader binding. |
| `src/tools/registration.ts` | Assembly Exec reuse or standalone construction, tool mounting and pre-execute shell pinning. |

The factory passes its original dependency object through narrow `Pick`
interfaces. It does not eagerly copy configuration values: policy, command
environment, cwd, promotion threshold, timeout and retention reads retain their
existing boundary and receiver. Generic shell preparation captures the selected
shell against the exact argument object before approval, and execution deletes
that binding. A preference change affects subsequent preparation and the live
description. Registration pins the same object before a policy can await.

Foreground waiting, explicit background execution and promotion all use the
supplied Exec service. A user steer or deadline changes observation of that
capture; Shell does not relaunch work, create a second job owner or implement
new completion behavior. Sandbox admission runs once and carries the returned
policy to execution. Backend unavailability returns the existing refusal value.

Retention creates fresh stdout/stderr buffers for each result and keeps the
configured spill store for the lifetime of the tool set. An existing Exec spill
is reused without writing another copy. Returned output keeps the original
retained reader, stderr, truncation markers and notice rules.

Run the package gate and the prescribed consumer checks sequentially:

```powershell
pnpm --filter @i-harness/shell exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/shell typecheck
pnpm --filter @i-harness/exec exec vitest run test/exec.test.ts test/capture-lifecycle.test.ts test/execution-contract-consumer.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/exec typecheck
pnpm --filter @i-harness/session-executor exec vitest run test/event-driven-steering.test.ts test/scoped-exec.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/session-executor typecheck
```
