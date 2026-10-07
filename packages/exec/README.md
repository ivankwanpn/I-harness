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
callers cannot read or cancel another caller's job.

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
