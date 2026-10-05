# Windows sandbox toolchain follow-up

Date: 2026-10-05. Active checkout: `D:/I-harness-main`, branch
`codex/windows-sandbox-toolchain`, baseline
`35d6c2ccf59ee99f1db84342a01e2016933507ca` from the recreated repository.

## Required behavior

Run actual Git Bash/MSYS and Node children with piped stdio while preserving
read-only/workspace-write, current multi-root permissions, removed-root denial,
separate private temps, and cancellation of the entire owned process tree.
Reference trees may be read but must not acquire write permission. Failed
confinement must not retry a payload unconfined.

The native experiments below are feasibility evidence. They do not constitute a
completed backend implementation or product acceptance gate.

## Corrected handoff interpretation

The original handoff measured anonymous-pipe creation failures under explicit
user-only descriptors, successful named-pipe server creation, and successful
Bash/Node compatibility under a same-user Low token. Keep those observations.

Named server creation does not establish that its write client can open it.
Microsoft documents the client access check at `CreateFile`/`CallNamedPipe`.
MSYS2's published source constructs the signal pipe using `sec_user_nih`, calls
`CreateNamedPipe`, then opens the client using `CreateFile`. The absence of
certain SD-building imports in a DLL cannot prove that the signal pipe is
anonymous or that its descriptor is static.

Sources: [Microsoft named-pipe access checks](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights),
[MSYS2 signal-pipe initialization](https://raw.githubusercontent.com/msys2/msys2-runtime/msys2-3.6.10/winsup/cygwin/sigproc.cc),
[MSYS2 server and client construction](https://raw.githubusercontent.com/msys2/msys2-runtime/msys2-3.6.10/winsup/cygwin/fhandler/pipe.cc),
[MSYS2 token default-DACL initialization](https://raw.githubusercontent.com/msys2/msys2-runtime/msys2-3.6.10/winsup/cygwin/uinfo.cc).
The exact installed DLL/source correspondence was not verified here.

Lowering a same-user token to Low preserves no-write-up for a Medium fixture.
It does not distinguish two roots that were both lowered to Low, nor revoke a
previous root's Low label when a command becomes read-only. The same user can
also have ambient Low directories. Therefore the handoff's one denied Medium
write does not prove the scoped replacement contract.

## DSH references

Read-only inspection of `dsh-anchored-standard-main`,
`deepseek-harness-master-rc8`, and `deepseek-harness-dsh-v0.2.0-rc.2` found:

- The anchored-standard tree contains prompt/verification material, not a native
  Windows sandbox implementation.
- Both native backends retain `WRITE_RESTRICTED`. v0.2 adds Low labels and a
  delete-child deny; its documentation/tests still describe piped Node denial.
- Suspended creation, Job assignment before resume, checked native errors,
  allocation ownership, serialized ACL edits, and aggregate cleanup are useful
  implementation references. They are not evidence of restored compatibility.
- Standing Low project labels cannot be copied into a Low-only backend while
  claiming the existing per-command permission model.

No reference source, installed toolchain, or reference-directory ACL was changed.

## Profile-free AppContainer native experiment

Current host: PATH Node v24.15.0, x64, 8 physical/16 logical cores. This differs
from the original handoff's Node v22.23.2 and 4 physical/8 logical host; its
timings and suite totals must not be reported as fresh results here.

The experiment used derived package SIDs and `NtCreateLowBoxToken`, without
creating a persistent profile. Owned NTFS fixtures received per-package read
ACEs; two Medium work roots received Modify for their separate identities.
Actual Node/Git Bash files were copied into those fixtures. Every child was
created suspended, assigned to an owned kill-on-close Job, then resumed.

| Native check | Observed result |
| --- | --- |
| Package identity and token inspection | AppContainer=1, Low IL, exact supplied package SID, zero restricting SIDs |
| A writes A; B writes B | Success |
| Cross-root writes/deletes and outside baseline mutation | Denied; baseline victims unchanged |
| Separate read-only identity reads roots and attempts writes | Reads succeed; writes denied |
| Ordinary Low token writes a package-granted Medium root | Denied |
| Ordinary Low token attempts to mint A's copied package SID | `0xc0000022`; no token created |
| Node inline entry, inherited/ignored grandchild stdio | Success |
| Node `spawnSync` and asynchronous piped spawn | Stall; whole-Job termination requested and direct target awaited at a 20-second deadline |
| Actual copied Git Bash/MSYS, both modes | `0xC0000142`; global object-directory creation denied |
| Node script-file entry | Fails before probe body at ancestor realpath lookup (`lstat D:\\`) |

The direct `CreateProcessW`/SECURITY_CAPABILITIES constructor also returned
Win32 2 before a child existed; its cause was not established. The successful
route was the inspected LowBox token plus `CreateProcessAsUserW`.

The prototype passed zero LowBox namespace handles. It does not disprove every
AppContainer configuration. LPAC, arbitrary unchanged external reference reads,
all reparse/alias boundaries, and production privilege/handle escape resistance
were not proved by this experiment.

MSYS requests an absolute `\\BaseNamedObjects\\msys-...` directory. Historical
Chromium retained a package namespace directory handle; that does not rewrite
this absolute name or a libuv NPFS path. Node v22.23.2/v24.21.0 source names
stdio pipes without `LOCAL\\` and retries `ERROR_ACCESS_DENIED`; this supports an
explanation for the observed stall, but the experiment did not trace the exact
failing syscall. Current libuv's AppContainer-aware pipe names are a runtime
change, not a saved-handle fix.

Sources: [Microsoft AppContainer launch and resource access](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer),
[Microsoft NtCreateLowBoxToken](https://learn.microsoft.com/en-us/windows/win32/secauthz/ntcreatelowboxtoken),
[MSYS2 shared namespaces](https://raw.githubusercontent.com/msys2/msys2-runtime/msys2-3.6.10/winsup/cygwin/mm/shared.cc),
[Node v22.23.2 libuv pipe source](https://raw.githubusercontent.com/nodejs/node/v22.23.2/deps/uv/src/win/pipe.c),
[Node v24.21.0 libuv pipe source](https://raw.githubusercontent.com/nodejs/node/v24.21.0/deps/uv/src/win/pipe.c),
[current libuv AppContainer pipe support](https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/pipe.c).

## Evaluated provisioning candidate — rejected by the user

The user explicitly rejected local-account/SYSTEM-task provisioning and directed
this work to reuse existing DSH or ZCode designs. No account or task was created.
The candidate below is retained as research evidence; it is excluded from the
current implementation.

A protected launcher could provision a distinct non-admin Windows identity and
restrict its token using that identity's own user SID. Its explicit user-only
pipe descriptors would then have a matching restricting principal, without
adding the host user's SID. Compatibility remains unproved.

An account must not be reused across session/mode/root generations: files it
created can carry its explicit user ACEs and owner rights after parent-root
grants are removed. A one-account compatibility test must demonstrate this
negative control and must not claim production downgrade isolation.

`LogonUserW(LOGON32_LOGON_NETWORK)` plus `DuplicateTokenEx(TokenPrimary)` can
avoid a batch-right/profile setup for local testing; it does not prove remote
authenticated reads. Different-account `CreateProcessAsUserW` may require
assignment/quota privileges absent from a normal or elevated administrator
token. Missing privileges must stop before provisioning. A fallback to
`CreateProcessWithTokenW` is not equivalent: a NULL desktop automatically
changes inherited desktop/station access, and inherited-handle transport needs
its own proof.

Sources: [Microsoft LogonUserW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-logonuserw),
[CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw),
[CreateProcessWithTokenW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithtokenw),
[access-check owner rights](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-dtyp/4f1bbcbb-814a-4c70-a11e-2a5b8779a6f9).

Production provisioning, a privileged helper, external-read brokering, and any
owned noninteractive desktop are material architecture changes. They require a
concrete reviewed scope before implementation/execution. None has been created
by this investigation. The product backend still uses `WRITE_RESTRICTED`.

## Adopted DSH Windows design

Additional read-only checks covered the nested DSH `0.1.0-rc.5`, direct master
`0.1.0-rc.7`, and `0.1.7-rc.2` trees. The first two have identical selected
token/ACL/grant/native-runner-test sources; v0.1.7 and v0.2.0 likewise have
identical token/ACL/grant/process sources. There is no additional MSYS pipe fix.

DSH's shipped Windows bundle disables `bash-sandbox` and `tool-bash`, and selects
PowerShell (`packages/bundle/base/cordis.patch.yml:234-242,266-272` in v0.1.7;
its `base.spec.ts:69-80` tests the roster). Its native ACL runner tests explicitly
expect inherited/ignored Node descendants to work and piped capture to be
denied. Thus its usable Windows design is native PowerShell plus the existing
restricted-token/ACL backend, with documented compatibility limits.

The supplied ZCode executor states its protected-resource sandbox was removed
(`apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts:276`).
Its Bash handler sends a sandbox field, but `prepareChildSpawn` ignores it and
the execution path uses ordinary `child_process.spawn`. Its permission and cwd
checks are admission/bookkeeping, not a per-root OS write boundary. Copying that
spawn path would remove IH's enforcement and is not the selected design.

IH now adopts DSH's native Windows Agent Shell automatic default: PowerShell 7,
then Windows PowerShell, then CMD, or a legible unavailable result. Explicit
shell choices and interactive terminal auto-selection retain their separate
behavior. The existing same-user capability ACL/token remains responsible for
read-only/workspace-write and current roots; no unconfined retry or new Low label
is added. Native process-create errors are preserved before cleanup.

Implementation and acceptance are specified in
[the adopted design](../superpowers/specs/2026-10-05-dsh-windows-shell.md) and
[its plan](../superpowers/plans/2026-10-05-dsh-windows-shell.md).

The real PowerShell 7 gate exposed a language-policy difference: workspace-write
completed its `[IO.File]` read/write checks, while read-only rejected the first
such method call with a ConstrainedLanguage diagnostic. A rejected .NET method
does not establish that the referenced file itself is unreadable. The authority
gate therefore uses built-in `Get-Content`/`Set-Content` cmdlets and verifies
actual contents and write outcomes; no language-policy override or extra
read-only temp write grant is introduced.

## Delivered adaptation and verification

Implemented in local commits `c1b2a220` and `a90879ee` (Windows Agent automatic
selection and portable fixtures), `ddcc67c5` (native startup error preservation
and PowerShell authority gate), followed by the documentation commit.

- Windows Agent `auto` selects PS7 → Windows PowerShell → CMD → unavailable.
  Settings state, model shell dialect and launched argv use that resolved
  executable. Explicit shell choices and terminal/non-Windows auto behavior
  retain their separate semantics. No saved setting migration is needed.
- A failed `CreateProcessAsUserW` saves `GetLastError` before inheritance
  restoration and Job closure. Its regression failed with code 6 before the
  fix and passes with the original code 2 after it.
- The real detected PS7 cmdlet gate passes outside reads, workspace-only writes,
  and read-only denial on the same workspace after standing grants. Parent-side
  checks confirm byte-identical outside content and preserved workspace content.
  Multi-root (3), read visibility (1), and Job behavior (2) native gates pass.
- Gateway/shell prepared-executable verification: 3 files, 15 tests pass.
- `pnpm -r typecheck`: exit 0.
- First sequential all-package test run found only the fresh checkout's missing
  generated `attachment-reader-worker.mjs`: 17 Desktop failures. The existing
  `pnpm --filter @i-harness/desktop attachment:build` generated the prerequisite,
  and Desktop then passed 686 tests with 3 skips. No source change was needed.
- Fresh `pnpm -r --workspace-concurrency=1 --no-bail test` after that build:
  **73 packages, 4,811 passed, 13 skipped, 0 failed, exit 0**.
- Independent task reviews and whole-branch review: no outstanding findings.
  `git diff --check` passes. The implementation remains on
  `codex/windows-sandbox-toolchain` in the active checkout.

This delivers the supported native Windows route. Confined MSYS and piped Node
toolchains retain the documented restrictions; the adaptation does not claim
their general compatibility. No account, privileged task, service, elevation,
original-reference ACL mutation, or new Low label was introduced.

## Evidence and cleanup state

Private probe source, native JSON reports, ownership manifests, and ACL journals
are retained under `.superpowers/sdd/2026-10-05-windows-sandbox-toolchain/`.
Eight marked probe fixtures remain under the checkout's `.tmp/`; their complete
paths are in `appcontainer-retained-fixtures.json` in that evidence directory.
Automatic policy review rejected the ownership-checked recursive cleanup with
`blocked by policy`; it supplied no more specific reason. No deletion workaround
was attempted. The probe requested whole-Job termination, awaited direct targets,
and attempted to close its handles. It did not query Job active-process counts
to prove complete descendant settlement, and did not check every `CloseHandle`
result. Those cleanup gates remain necessary for a production replacement.

`pnpm install --frozen-lockfile` completed with exit 0, without a tracked lockfile
change. The focused ABI/token/ACL/FFI baseline was 12 passing tests across four
files, exit 0. No full current-host acceptance suite or replacement-backend
success is claimed.
