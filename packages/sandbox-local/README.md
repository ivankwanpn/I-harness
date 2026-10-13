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

## Windows ConPTY resize/input limitation

**Known third-party input-integrity defect; not fixed by awaiting resize.**
On 2026-10-13, an independent raw `node-pty@1.1.0` probe (no IH code) on
Windows 11 build 26200, Node v22.23.2, and Git for Windows Bash 5.3.15
(`C:\Program Files\Git\bin\bash.exe`, Git 2.55.0.windows.5) reproduced loss of
the leading byte of the first write after resizing. `printf` reached Bash as
`rintf`; exact file contents, not terminal echo, determined success.
The no-resize control was 24/24 for both writes. The first input after resize
is vulnerable even after 500 ms or observed redraw: the failure window is not
a time-bounded IH promise race. In these samples a subsequent write, without
another intervening resize, was intact. This is an observation on this host,
not a lossless-input guarantee for other programs, versions, or hosts.

The probe used eight mixed sizes, an initial ready prompt and warm-up for
running-terminal cases, and split output acknowledgements to ensure each shell
line completed before checking its file or sending the second line. All rows
have 24 samples; the second payload has no resize between it and the first.
The startup row calls resize immediately after spawn, before the first output;
"before any input" instead waits for the initial prompt without writing first.
Raw source and per-sample transcripts/file effects remain in gitignored
`packages/sandbox-local/.tmp/raw-conpty-resize.mjs` and its timestamped JSONs.
These are empirical success fractions, not estimates of a universal flake rate.

| Raw call-site candidate | First payload intact | Second payload intact |
| --- | --- | --- |
| No resize (control) | 24/24 (100%) | 24/24 (100%) |
| No resize, bundled ConPTY DLL (control) | 24/24 (100%) | 24/24 (100%) |
| No resize, legacy WinPTY (control) | 24/24 (100%) | 24/24 (100%) |
| Resize, write immediately | 15/24 (62.5%) | 24/24 (100%) |
| Resize twice to the same size | 20/24 (83.3%) | 24/24 (100%) |
| Resize to another size, then target | 16/24 (66.7%) | 24/24 (100%) |
| Resize, wait `setImmediate` | 20/24 (83.3%) | 24/24 (100%) |
| Resize, wait 20 ms | 22/24 (91.7%) | 24/24 (100%) |
| Resize, wait 500 ms | 21/24 (87.5%) | 24/24 (100%) |
| Resize, observe post-resize output | 16/24 (66.7%) | 24/24 (100%) |
| Output quiet for 250 ms, resize, observe output | 17/24 (70.8%) | 24/24 (100%) |
| Resize before any input, after initial prompt | 7/24 (29.2%) | 24/24 (100%) |
| Resize immediately on a just-spawned terminal | 24/24 (100%) | 24/24 (100%) |
| Resize, inject a sacrificial space, then payload | 24/24 (100%) | 24/24 (100%) |
| Resize, inject a sacrificial NUL, then payload | 24/24 (100%) | 24/24 (100%) |
| Resize, inject a sacrificial CR, then payload | 24/24 (100%) | 24/24 (100%) |
| Bundled ConPTY DLL (`useConptyDll: true`), resize | 20/24 (83.3%) | 24/24 (100%) |
| Legacy WinPTY (`useConpty: false`), resize | 19/24 (79.2%) | 24/24 (100%) |

An earlier file-only control also had 24/24 intact first and second writes;
its immediate-resize probe had 18/24 (75%) intact first payloads and 24/24
second writes. Preliminary timing-only candidate samples with incomplete
command acknowledgements were discarded, then rerun with the completion
checks above; only completed samples appear in the table.

The startup and each sacrificial-input row were repeated with another 24
samples: all four again had 24/24 intact payloads and second writes (48/48
across the two runs). That does not make them a running-terminal repair.

No tested, byte-transparent workaround repairs resize on a running terminal.
Startup success does not repair later resizes, and respawning would discard the
child's state. Sacrificial input is **not generalisable**: even NUL, space or CR
can change an arbitrary child's stdin. The test fixture can send an empty Bash
line explicitly; the service must not secretly send it on behalf of a caller.

IH does **not** add sleeps, an output-quiet queue, a redraw barrier, or injected
input. The audit's earlier raw sample improved from 14/24 to 19/24 after redraw
(58% to 79%); the independent sample above improved only from 15/24 to 16/24,
and the strict quiet-plus-redraw sample was still 17/24. An earlier
quiet-plus-redraw sample was 15/24; the stricter rerun resets its output
observation baseline after becoming quiet. None eliminated the loss.
Gating on child output would add latency and can stall indefinitely when the
child does not redraw. A timeout would reintroduce an unqualified sleep-based
promise. The implementation remains byte-transparent rather than advertising
that partial measure as a fix (see `docs/audit/2026-10-13-external-install-and-verification.md:196`).

The POSIX `node-pty` adapter is not selected on Windows
(`packages/sandbox-local/src/execution-backends.ts:47`). The current Windows
unrestricted backend uses native ConPTY and acknowledges resize delivery;
that acknowledgement also does not establish input integrity. The raw probe
places the defect below IH, but does not isolate node-pty, conhost, and MSYS
internals from one another. Linux/macOS behavior has not been qualified by this
Windows-hosted measurement.

`packages/terminal/test/resize-input.test.ts` now separates IH's guarantees:
a deterministic fake-backend test pins awaited delivery, view updates, and
unchanged payload forwarding; a real-host test checks mixed sizes with
`tput cols/lines` and complete commands after a separate post-resize input.
The **original first-command assertion is retained unchanged**, clearly named
`KNOWN THIRD-PARTY LIMITATION` and skipped by default, not converted into a
false green or an expected failure that randomly passes. To run that diagnostic
on Windows with Git Bash (a failure remains expected on affected hosts):

```sh
IH_RUN_CONPTY_RESIZE_LIMITATION=1 pnpm --filter @i-harness/terminal test test/resize-input.test.ts --maxWorkers=2 --minWorkers=1
```
