# WSL2 sandbox experiment

Approved direction: the user requested a new branch to try a package-based WSL2 execution backend after reviewing the WSL2/Linux Bash approach. Branch: `codex/wsl2-sandbox-experiment`, starting at `a78d663e`.

## Goal and scope

Provide an explicitly constructed, experimental `TransportExecutionBackend` in `@i-harness/sandbox-wsl`. A Windows controller starts one trusted Python 3 worker in an existing WSL2 distribution. The worker launches Linux commands through bubblewrap. A qualification command consumes this backend through the existing execution supervisor.

The first version supports pipes, complete-tree lifetime, read-only and workspace-write, caller-visible reads, explicit reference locks, and no network. It refuses unrestricted execution, PTY, retained-tree lifetime, requested deny-path/read-isolation features, Windows command quoting and Windows executables. Desktop settings, automatic shell selection, release packaging, network proxies and automatic fallback are outside this experiment.

## Existing environment

Read-only inventory on 2026-10-08 found Ubuntu WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`, x86_64, Ubuntu 24.04.4, Python 3 and bubblewrap 0.9.0. Linux Node and socat were absent. A direct read-only bubblewrap namespace probe ran Linux Bash, an external pipeline and nested Bash successfully. WSL launcher stderr contained a host proxy diagnostic; it must be kept separate from command stderr.

## Package and process boundaries

- `packages/sandbox-wsl/src/`: TypeScript controller, framing, validation and standard execution-lease integration.
- `packages/sandbox-wsl/worker/runner.py`: Python standard-library worker, Linux path/identity checks, bubblewrap policy, seccomp and command ownership.
- `packages/sandbox-wsl/test/`: controller unit tests, real worker tests and WSL integration tests.
- `scripts/qualification/wsl2-sandbox/`: reproducible explicit qualification consumer and owned evidence.

Use only existing dependencies and runtimes. Do not install Linux packages, change WSL configuration, mutate host/reference ACLs, grant host-wide permissions, publish or switch backend after failure. All fixture files and evidence live inside this repository. Private `/tmp` is a namespace tmpfs, not an outside-host write grant.

## Trusted bootstrap and wire contract

Launch the fixed Windows System32 `wsl.exe` with exact argument-list execution, the chosen distribution, `/usr/bin/env -i PATH=/usr/bin:/bin LANG=C /usr/bin/python3 -I -B -u -c <fixed bootstrap>`. Hide the Windows launcher. Read the fixed package worker source into an immutable buffer; send one bounded JSON bootstrap line containing `{v:1, nonce, source, sha256}` where source is base64. The bootstrap verifies the digest and executes the captured source in memory. No guest copy, shell interpolation, Python import path override or source reread after admission is used.

Every following line has `{v:1, nonce, type, ...}`. Host-to-worker types:

- `probe`: check Linux/WSL2, Python, architecture and a real bubblewrap/seccomp startup.
- `prepare`: contains detached `spec` and `policy` in the existing sandbox contract vocabulary, with Windows paths. The worker maps absolute local-drive paths using `/usr/bin/wslpath -u` and opens/verifies directory identities. No workload executes.
- `commit`: validate identities again and launch the captured request once.
- `cancel`: kill only the owned bubblewrap execution; await namespace teardown and output drain.
- `input`: bounded base64 command stdin; `endInput`: close command stdin.
- `shutdown`: rollback a prepared request or cancel an active one, then exit.

Worker-to-host types:

- `hello`: bootstrap digest, worker PID and protocol version.
- `probe`: `{available:boolean, detail:string}`.
- `prepared`: `{policyFingerprint:string}`.
- `started`: `{pid:number}` for the owned Linux launcher.
- `output`: `{channel:"stdout"|"stderr", data:string}` where data is bounded base64.
- `root`: `{exitCode:number|null, signal?:string}` for the bubblewrap command status.
- `settled`: namespace/child cleanup and pipe EOF are complete.
- `error`: a sanitized failure, never request/environment contents or a traceback.

Maximum line size is 256 KiB; command-output chunks are at most 32 KiB. Unknown versions, nonces, types, malformed base64, oversized frames and impossible phase transitions fail closed. Command output is encoded inside output frames and cannot become control messages. Launcher stderr is bounded diagnostic metadata, not workload stderr.

## Filesystem policy and identity

Accept only `read-only` or `workspace-write`, exact owner match, `transport=pipe`, `lifetime=complete-tree`, `argumentEncoding=crt`, absolute Linux command paths and absolute existing local-drive Windows cwd/authority/write/reference roots. Do not reinterpret native Windows argv as Linux argv. Capture policy/spec before awaiting. Validate write roots against authority roots and reject writable roots that overlap reference roots; nested references can instead be rebound read-only after writable mounts. Cwd must belong to captured authority.

The guest resolves and captures every root's physical path and directory identity; before commit it rejects a changed path/inode. Prefer pinned directory descriptors as bubblewrap mount sources so rename/symlink races cannot redirect a captured grant. Target mount paths remain the captured physical guest paths. Root filesystem is bound read-only; workspace-write rebinds only captured write roots. References are read-only, including aliases. A private tmpfs `/tmp` is explicit in workspace-write. Read-only has no writable temp.

## Linux isolation

Use PID, mount, user, network, IPC and UTS isolation via bubblewrap; a new session, namespace `/proc`, private `/dev`, die-with-parent and no new privileges. Mask `/init` and `/run/WSL`, strip/reject WSL interop environment and use Linux argv/env. Add an x86_64 seccomp filter denying AF_UNIX socket creation and io_uring entry points; reject unsupported architecture or filter setup rather than continue without it. Network is disabled through its namespace. Do not modify distribution-wide interop/AppArmor settings.

## Ownership and failure

The host's commit invokes the existing authority validator immediately before remote commit; the guest rechecks captured filesystem identities before spawn. Authority revocation uses cancellation and awaits genuine guest settlement. Python owns bubblewrap, command pipe readers and termination. EOF/loss of the control pipe cancels the owned execution. PID namespace destruction must cover children that detach from their process group.

`rootExited` does not imply settlement. The standard lease publishes `settled` only after worker acknowledgement, pipe drain and WSL launcher closure. Protocol loss, missing acknowledgement or cleanup timeout produces incomplete settlement, never a successful tree-empty claim. Output buffering is bounded; overflow cancels and reports abandoned output. Cancellation during preparation also shuts down and waits for the worker. Disposal closes admission and drains prepared/active owners.

## Acceptance

1. Real WSL worker startup and Linux Bash stdout/stderr, nested child, pipeline, binary output and exit status.
2. Read-only denies both owned workspace and owned sibling writes; workspace-write permits workspace but denies sibling/reference writes. Windows-side sentinels verify actual effects.
3. WSL-to-Windows `cmd.exe`/PowerShell launch is denied without changing WSL configuration; AF_UNIX and io_uring restrictions are active.
4. Network namespace cannot connect to a controlled listener outside the namespace.
5. A long-lived child and a setsid child cannot continue after cancellation or root exit; wait for acknowledgement, EOF and launcher closure, then inspect owned Linux PIDs/late marker files.
6. Prepared policy/request mutation and path replacement, authority revocation, malformed protocol, missing runtime and unsupported modes refuse safely.
7. Affected unit tests/typechecks, package dependency/reachability checks and independent security/lifecycle review pass. Report one-host experimental scope accurately; no claim of production qualification or full read isolation.
