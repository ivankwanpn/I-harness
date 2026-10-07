# Execution ownership

`@i-harness/exec` exports `launchExecution` and the additive
`createExecutionSupervisor` runtime. The caller supplies a transport backend,
an immutable compiled policy, requirements and an authority validator. The
supervisor owns preparations and committed pipe and PTY handles in one registry.

```ts
import { createExecutionSupervisor } from "@i-harness/exec"

const supervisor = createExecutionSupervisor()
const execution = await supervisor.launch({
  backend, spec, policy, requirements, validateAuthority, signal,
})
// Presentation can retain this same handle when a foreground call is promoted.
const { handle } = execution
for await (const frame of handle.io.output) consume(frame)
await supervisor.cancel(execution.id, "cancelled")
await supervisor.closeOwner(policy.owner.sessionId)
await supervisor.dispose()
```

Launch copies and freezes the exact `ProcessSpec` fields, including arguments,
environment, owner lineage and PTY size, before its first asynchronous operation.
It preserves the executable, arguments, cwd and argument encoding. The spec owner
and lineage must match the policy. Requirements must negotiate the spec's actual
transport and lifetime. Policy, policy owner and root lists must already be
frozen. This immutability guard does not authenticate a policy or establish
filesystem identity; the supplied validator and native backend enforce authority.

Preparations are registered before probing. The linked signal preserves the
caller's abort cause; recognized stop reasons reach cancellation unchanged.
Authority fences check owner closure, supervisor disposal and cancellation both
before and after invoking the current validator. A committed handle is owned
before receipt validation or exposure. Its receipt must match the negotiated
backend ID, policy fingerprint and owner lineage, with a unique execution ID.
An invalid receipt or a handle returned after revocation still requires complete
cleanup before launch rejects. `SupervisedExecution.id` identifies the registry
entry independently of the driver's receipt ID, so a duplicate receipt cannot
replace an existing handle.

`list()` reports committed handles, including handles retained after failed
cleanup. Pending preparations remain owned internally. A root exit alone leaves
ownership intact. Removal requires a driver's `kind: "settled"` lease result,
which confirms the tree, I/O and resource barriers. An incomplete result remains
historical: `cancel`, owner close, reconciliation or disposal can explicitly retry
the lease's current attempt without changing its handle. The supervisor is the
sole lifetime owner: presentation adapters use `handle.io` and perform
cancellation or final cleanup through supervisor methods, without independent
`handle.cancel/release` retries. Each supervisor cleanup attempt is observed. The
supervisor also observes the current handle promise when listing entries.

`reconcile(owner, validator)` temporarily blocks new admission for that owner and
replaces the validator for pending preparations. Compatible policies continue.
Invalid preparations are aborted and rolled back; invalid committed handles are
cancelled with `authority-revoked`. Reconciliation awaits affected preparations
and complete cleanup before acknowledging the change. Operations for unrelated
owners continue. Failure leaves admission blocked until a successful reconcile.
A closed owner or disposed supervisor stays closed permanently.

`closeOwner` and `dispose` block admission synchronously, then await pending
preparations, late committed handles and active handle cleanup. Concurrent calls
share their current attempt. Failed cleanup produces an `AggregateError` with
collected diagnostics, retains ownership and leaves admission blocked. A later
call retries the retained cleanup, including a failed preparation rollback.
Cleanup success and failure are represented separately from a rejection's value.
`AggregateError.errors` preserves opaque causes exactly, including `undefined`,
`null`, false, zero and empty strings. A cause that cannot be formatted still
remains in the diagnostic data and still prevents a successful acknowledgement.

This runtime does not choose a backend, spawn a process, consume output or infer
native tree observations. Its tests use fake native operations with real public
admission, policy compilation and execution leases. The existing exec and PTY
services have not yet migrated to it. Concrete native drivers, authority producer
integration and production service migration are subsequent phases; this module
does not establish confinement or change platform defaults.

## Headless pipe launches on Windows

The existing ordinary exec service requests `windowsHide: true` for direct and
unconfined pipe commands, including foreground, background and promoted runs.
It retains pipe capture, environment merging, argument encoding and cancellation.
Confined wrapper launches retain their previous startup behavior because the
legacy Windows restricted runner depends on an inherited console. Its compatible
hidden-console launch and production sandbox migration require separate Windows
qualification. Streaming exec already requests hidden startup.

These launch options express immediate-child startup intent. Passing pipe and
process lifecycle tests from a console parent does not prove that a GUI parent
or native descendants produce no visible console windows.
