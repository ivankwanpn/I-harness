# Execution service and ownership

`registerExec` installs one `ExecService`. Ordinary pipe runs, bounded streams,
explicit background jobs, and foreground promotion all enter its shared
`ExecutionSupervisor`. The service does not spawn a process or maintain a
second native process registry. The selected transport backend owns the child,
tree, I/O and resources. `dispose()` waits for supervisor cleanup before
disposing the selected backend composition; a failed cleanup remains owned and
can be retried by calling `dispose()` again.

The host may supply `ExecServiceOptions.execution` with a supervisor, backend
selector, compiled policy resolver and authority validator. The resolver and
validator are trusted host functions. They must capture the standing authority
generation, actual owner and per-call grant before launch, then validate that
same generation at admission and commit. A command's `sandbox` field is only a
prepared per-call mode request; its `sessionId`, workspace roots or command JSON
do not grant owner identity or filesystem authority. Standalone registration
binds a configured `workspaceRoot` (or the current workspace) and selects
unrestricted mode when no sandbox mode is supplied. A confined standalone call
requires an available transport backend. An old argv-only `SandboxProvider`
cannot substitute for a transport backend.

Trusted dispatch can call `withExecCallerScope({sessionId,parentSessionId?}, fn)`
around a tool cascade. The scope freezes owner lineage for nested async calls.
Without a scope the host must provide `defaultOwner`; standalone registration
uses `standalone-exec`. Background views expose the committed receipt and actual
owner lineage, root observation and complete settlement separately. Scoped
callers cannot read or cancel another caller's job. A job whose cleanup is
incomplete remains `running` and cancelable in the view, with
`settlement.kind === "incomplete"` and `cleanupDetail` naming the failed
barrier. Repeated `killJob` calls retry that same supervisor-owned handle; a
successful retry updates its settlement and preserves captured output.

`launchTransport` is the public owned entrypoint for terminal presentation:

```ts
const execution = await exec.launchTransport({
  argv, cwd, env, transport: "pty", lifetime: "retain-tree",
  argumentEncoding: "crt", pty: { cols: 80, rows: 24 }, sandbox,
})
for await (const frame of execution.handle.io.output) consume(frame)
await exec.cancelExecution(execution.id, "cancelled")
```

The caller supplies exact transport facts, never an owner, backend, compiled
policy or authority validator. The service captures an immutable ProcessSpec
before the supervisor's first asynchronous probe. On Windows it binds
environment keys case insensitively and resolves PATH names to an exact
executable before snapshotting. Omitted `env` captures the host environment;
explicit `{}` reaches the backend empty. The native Windows helper requires an
absolute executable and refuses inaccessible WindowsApps aliases rather than
substituting a different binary.

One consumer reads each handle's output frames. Foreground collection retains
UTF-8 output, CRLF normalization, memory tails and optional spill files.
Streaming admits raw bytes to its callback under a combined stdout/stderr
limit and keeps counters. Input is bounded to 2 MiB and sent in 16 KiB frames
to satisfy the native input contract. Timeout, external abort, output limit,
consumer stop and explicit kill request supervisor cancellation; completion
waits for tree, I/O and resource settlement. A null or failed root exit is
reported as `-1`, never as a successful zero exit. Promotion registers a view
of the already committed handle and preserves output from before handback.

`launchExecution` remains the lower-level admission function, and
`createExecutionSupervisor` remains public for host composition and tests.
The supervisor owns pending preparations, committed handles and retryable
cleanup. Its `reconcile`, `closeOwner` and `dispose` fences are the authority
and lifecycle operations used by host assemblies.

The package `src/index.ts` remains the public entry. `service.ts` and
`execution-supervisor.ts` are narrow factory entries. The internal modules
divide responsibilities without duplicating authoritative collections:

| Owner / module | Responsibility |
|---|---|
| `jobs/records.ts` | One job map, job ID counter, listener registration and service disposal flag; cleanup joins the supervisor before host disposal. |
| `jobs/views.ts`, `jobs/contracts.ts` | Snapshot formatting, retained readers and job contracts. Each listener receives its own view; listener exceptions cannot interrupt transitions. |
| `jobs/observation.ts` | Foreground return, deadline and user-steer observation. Promotion registers the original capture, with completion precedence and the same unsubscribe order. |
| `capture/output.ts`, `capture/input.ts` | One capture starts the sole iterator consumer and bounded input writes, and owns cancellation, timeout, abort linkage, stopped presentation and observer failures. |
| `capture/retention.ts` | The capture's stdout/stderr buffers, both spill collectors, snapshots and one finalization attempt. |
| `capture/completion.ts`, `capture/contracts.ts` | Completion joins root exit, driver tree/I/O/resource settlement, output consumption and input; it queries the capture's live state after waits and releases capture resources in the same order. |
| `transport-launch.ts`, `execution-host.ts` | Caller/access boundary, exact target/environment/spec selection, immutable policy dispatch and standalone backend composition. |
| `supervision/ownership.ts`, `supervision/contracts.ts` | One entry set, owner-state map, execution receipt ID set, admission counter and disposal attempt. Helpers receive capabilities over this owner. |
| `supervision/admission.ts` | Immutable admission snapshots, caller cancellation linkage, preparation/commit fences and receipt validation. |
| `supervision/retirement.ts` | Deduplicated settlement observations, exact cancellation promises, rollback retries and cleanup aggregation. Failed cleanup retains ownership for retry. |
| `supervision/reconciliation.ts` | Owner admission blocks, revisions, concurrent reconciliation and close attempts. |

Root exit can update a job view before completion. Successful capture still
requires output EOF plus tree, I/O and resource settlement. Failed native
settlement stops presentation and finalizes spill ownership while the
supervisor retains the native handle for explicit cleanup retries. Existing
admission, caller-scope, spill, retained-output and backend modules keep their
separate responsibilities.

The verification map is `execution-supervisor.test.ts` for admission fences,
concurrent owner operations and retryable cleanup;
`capture-lifecycle.test.ts` for EOF, input/output failures, spill finalization,
observation and callback receivers; `execution-contract-consumer.test.ts`
for public handle contracts; and `exec.test.ts` / `stream.test.ts` for job,
promotion and byte-limit behavior. Shell's `native-completed-command.test.ts`
checks the controlled native command/closed-stdin race. Session executor's
`scoped-exec.test.ts` and `event-driven-steering.test.ts` cover the caller and
steering consumers.

Trusted tool composition may assign `executionTarget: "wsl"`; omission means
the native host. Selection receives the frozen process specification as an
optional third argument, so existing two-argument hosts remain compatible.
WSL targets use case-sensitive Linux environment keys, preserve explicit Linux
argv, and omit host PATH executable resolution. Their omitted environment is
the minimal `{ PATH: "/usr/bin:/bin", LANG: "C" }` snapshot. Shell bindings also
capture the distribution and runtime options before approval waits.

`runBackground` and foreground promotion use root-bound `complete-tree` for
WSL: the root command may run after presentation returns, and descendants are
cleaned up when it exits. Job views report this lifetime. `launchTransport`
continues to require the exact requested lifetime and transport; a WSL
`retain-tree` or PTY request refuses. Reference authority requires the optional
`referenceProtection` capability; older drivers advertising `denyPaths` remain
compatible without claiming that WSL implements general deny-path isolation.
