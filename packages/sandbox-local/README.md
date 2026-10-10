# Local execution backends

`createLocalExecutionBackends` selects one transport backend from the compiled
policy and requested transport before preparation. Callers retain that backend
through commit or rollback and await the composition's `dispose()` after all
execution handles settle. An explicit Windows confined choice is `legacy` or
`psec`; the default is `legacy`. The selection never changes after a failed
probe, preparation, or launch.

On Windows, unrestricted execution uses the native unrestricted Job backend.
The experimental PSEC backend is available only when explicitly selected and
does not offer a confined PTY. The legacy adapter runs the existing ACL
restricted-token runner inside a separate native unrestricted Job with a
hidden console. Its public receipt names `windows-acl-legacy` and the original
compiled policy; the retained native handle supplies actual Job settlement.
The adapter exposes the runner's denial and failure signatures for the output
collector. It accepts only pipes and `complete-tree` lifetime. The runner
mirrors the restricted child's exit status; historical background presentation
is therefore root-bound. The Job observation belongs to the runner and its
Job descendants, and must not be inferred from wrapper close alone.
The runner defaults to CRT quoting. Its explicit `cmd-verbatim` path accepts
only absolute `cmd.exe /d /s /c` plus one raw command argument and serializes
that fifth argument without CRT quoting, matching the native helper's shape.
Other verbatim shapes refuse before restricted-child launch.

Legacy composition requires a trusted existing `legacyPrivateTempRoot`. This
is a location for runner metadata, not a write grant. The new composition
disables private temp writes in both confined modes. Workspace-write grants
only the compiled workspace roots, and read-only grants no writable temp.
`TEMP`, `TMP`, and every other supplied environment entry are forwarded
unchanged to the restricted child. Programs that require writable temp outside
declared workspace roots can fail. A host that needs such storage must declare
its authority before compiling and capturing the process request; this driver
does not create a hidden grant. Dispose the native owner before revoking ACL
provider resources. Workspace ACL ACEs are standing reuse grants in the
existing provider; private temp grants are absent from this composition.

On Linux, confined modes use the existing bubblewrap profile. Unrestricted
Linux and macOS use Node pipes or node-pty. POSIX output has one consumer and a
bounded queue; pipes use backpressure. PTY cannot backpressure node-pty, so
overflow cancels the process and reports abandoned output. The driver owns a
process group and observes it until empty before settlement. A child that
escapes the process group (for example by starting a new session) is outside
that observation. Bubblewrap's read-only root bind restricts writes but does
not hide reads; its existing workspace-write profile creates a writable
private `/tmp`. The POSIX driver has not been qualified by the Windows-hosted
tests. Other platforms refuse confined execution.

node-pty always sets `PWD` and `TERM` in its child environment. To preserve the
captured exact environment, this driver admits a PTY only when the caller
already supplies `PWD` equal to `cwd` and a nonempty `TERM`; it passes the
supplied `TERM` as the PTY name. Missing or different entries refuse before
spawn. PTY output uses node-pty's supported `encoding: null` byte stream.

Windows composition also accepts `windowsSelection: "wsl"` and immutable
`wslExecution: { distribution, networkAccess, workspaceDependencies, runtimePath? }`.
Only a trusted process specification with `executionTarget: "wsl"` selects the
WSL backend, including in full-access mode. Native helpers and PowerShell keep
a host target. For confined native pipes without references, the composed
legacy backend is selected when present; references or PTY select the explicit
native PSEC surface. Full-access native requests use the native unrestricted
backend. Selection occurs before preparation and never retries another backend
after failure. WSL has Linux pipes and root-bound complete-tree jobs; its PTY
and retained-tree capabilities remain unavailable.

CLI selection uses `--windows-sandbox wsl`, `--wsl-distribution NAME`,
`--wsl-network allow|deny` and `--wsl-workspace-dependencies true|false`.
Equivalent `IH_WINDOWS_SANDBOX`, `IH_WSL_DISTRIBUTION`, `IH_WSL_NETWORK` and
`IH_WSL_WORKSPACE_DEPENDENCIES` overrides are validated before a run starts.
New assemblies capture changed configuration; running executions retain their
backend and environment. Managed runtime paths are supplied by trusted host
composition, never by a model permission parameter.
