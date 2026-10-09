# Experimental WSL2 execution backend

`@i-harness/sandbox-wsl` provides an explicitly constructed Windows-to-WSL2
backend for IH's existing execution supervisor. Linux Bash and Linux tools run
inside bubblewrap, with captured writable project roots, PID namespaces,
explicit networking, seccomp and Windows interop masking.

The backend keeps experimental assurance while the CLI and Desktop integration
expose WSL selection. Construction captures the distribution, networking option,
managed runtime PATH and exact worker bytes for each new assembly.

## Existing-runtime requirements

- Windows with an existing, explicitly named WSL2 distribution.
- Linux x86_64, Python 3.10 or newer at `/usr/bin/python3`, and bubblewrap with
  `--bind-fd`, `--ro-bind-fd` and seccomp support at `/usr/bin/bwrap`.
- The distribution must permit the user/PID/mount/network namespaces exercised
  by the real startup probe. An unavailable runtime or profile refuses execution.
- Linux Node/npm are optional system or managed dependencies. Socat is optional;
  command networking uses the guest network namespace without a proxy.

The package does not install packages or change WSL/AppArmor/interop settings.
The worker's Python source is captured once by the controller, hashed, sent over
the owned pipe, verified and executed in memory with isolated Python imports.

## Try the real supervisor qualification

From this checkout with the existing Node development dependencies:

```powershell
node --import tsx scripts/qualification/wsl2-sandbox/run.mts --distribution Ubuntu
```

The command creates fresh fixtures under `.tmp/wsl2-qualification-*` and keeps
its `qualification.json`. It exercises actual `compileExecutionPolicy` and
`createExecutionSupervisor` consumers: Bash/pipeline/children, RO/WW effects,
references, binary I/O, Windows interop refusal, a controlled network listener,
cancel/root-exit/revocation cleanup, changed directories, unsupported requests
and pre-existing hardlinks. It performs no installation or global configuration.

## Construct the backend

```ts
import { createWslExecutionBackend } from "@i-harness/sandbox-wsl"

const backend = createWslExecutionBackend({ distribution: "Ubuntu", networkAccess: false })
const probe = await backend.probe()
// Supply this backend to createExecutionSupervisor().launch(...).
await backend.dispose()
```

Requests use the existing `ProcessSpec` and `CompiledSandboxPolicy`. Cwd,
authority, write and reference roots are existing absolute local-drive Windows
directories, such as `D:\project`; the guest resolves their actual Linux paths
and directory identities. Argv must name a Linux executable, such as
`/usr/bin/bash --noprofile --norc -c ...`. Windows executable argv is refused.
The workload environment is explicit, is checked for interop variables and is
applied only after bubblewrap starts under a trusted safe environment.

Supported requests are `read-only`, `workspace-write` or `danger-full-access`, pipes,
`complete-tree` lifetime and CRT argument-list encoding. The backend reports
`assurance: "experimental"`, caller-visible reads, write isolation, no PTY,
no retained-tree mode and no general read/deny-path isolation. It advertises
reference protection separately. Full access with protected references refuses.
Networking defaults off in RO/WW and on in full access; `networkAccess:true`
enables networking in RO/WW. Unix sockets, io_uring and Windows interop remain
restricted in every mode. No error-triggered backend retry occurs.

Root exit, Linux settlement acknowledgement, output EOF and Windows launcher
closure are separate observations. The execution lease waits for the required
observations. Cancellation and control EOF terminate the owned PID namespace;
unknown protocol/cleanup failures remain incomplete. Known prelaunch refusal
rejects the request and acknowledges empty cleanup, without fabricating a root
exit or execution handle. Launcher diagnostics are bounded and separate from
the command's stdout/stderr.

## Runtime discovery and packaged assets

`listWslDistributions()` returns exact names, WSL versions and states.
`inspectWslRuntime(distribution, paths?)` reports real isolation availability,
Python/Bash/bubblewrap/Node/npm/socat/git statuses and Windows-to-Linux path
mappings. These APIs use hidden fixed `C:\\Windows\\System32\\wsl.exe`, isolated
Python and no shell startup profiles or installation. Dependency status means
present on the fixed system runtime PATH; managed runtime status is supplied by
the separate runtime manager. Launcher diagnostics never contain the workload
environment.

Source/Desktop TS loading captures `../worker/runner.py` relative to this
package's source module. Bundled CLI loading with `I_HARNESS_DIST=1` requires
`./wsl-assets/runner.py` and `./wsl-assets/manifest.json` relative to the bundle.
The manifest schema is `{schema:1,protocol:1,worker:"runner.py",sha256}` and must
match the captured bytes. A source worker manifest, when present, is also checked.
Missing or mismatched assets refuse construction.

Trusted `runtimePath` options supply absolute Linux bin directories. A release's
`bin` parent is pinned and rebound read-only after writable project mounts; its
inventory and ancestry are revalidated before launch, with outside hardlink
aliases refused. Missing managed paths refuse admission.

## Experimental compatibility limits

- Linux toolchains must exist in the selected distribution. Windows toolchain
  executables do not become Linux executables through path conversion.
- Reads remain visible as specified by IH's caller-readable policy. The backend
  is not a whole-application or whole-WSL security boundary.
- Writable/reference overlap is refused in either direction. Writable inventory
  admission counts every regular inode link across captured writable roots.
  Internal hardlinks are admitted only when all links are accounted for; outside
  aliases, unreadable/special/cross-device layouts and changed inventories refuse.
  Limits are 1,000,000 entries, 100,000 directories, depth 128 and a cooperative
  45-second scan. Preparation/commit admission have a 55-second guest deadline
  and a 60-second controller response deadline; control writes remain bounded
  to ten seconds. Progress and cancellation are serviced during enumeration.
  All dependency and git directories are scanned; no persistent authority cache
  or omitted-directory shortcut is used.
- Each writable root must stay on one existing mount. Pinned/reopened root,
  directory and no-follow entry mount IDs use kernel statx relative to pinned
  descriptors; nested mounts, including same-device mounts, and unavailable
  metadata refuse. The previously blocked native nested-mount witness is not
  needed or repeated by the metadata tests.
- Canonical directory resolution is bounded to 128 ancestor levels, 8192
  examined entries and a cooperative two-second budget per distinct captured
  directory. Blocking filesystem operations can outlast a cooperative budget.
- Descriptor pinning and final revalidation protect captured roots; they do not
  create an atomic filesystem snapshot or lock out concurrent trusted host
  filesystem modifications after the final scan.
- A measured Desktop project preparation included its dependency tree within
  the bounded budget. Filesystem latency and concurrent trusted changes can
  still cause refusal; descriptor pinning is not an atomic snapshot.

## Tests

Controller tests and typecheck, from the repository root:

```powershell
$env:IH_WSL_TEST_DISTRIBUTION = 'Ubuntu'
node node_modules/vitest/vitest.mjs run --root packages/sandbox-wsl --config vitest.config.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/sandbox-wsl/tsconfig.json
```

The Python worker tests execute real namespaces and keep their owned fixtures.
Use the fixed hidden WSL launcher or an existing Ubuntu terminal to run:

```bash
python3 -I -B packages/sandbox-wsl/test/worker_test.py
python3 -I -B packages/sandbox-wsl/test/product_worker_test.py ProductWorkerTests
```

The worker tests do not use Linux-home or shared system-temp fixtures. Their
controlled case-sensitive filesystem test is inside a private namespace tmpfs.
