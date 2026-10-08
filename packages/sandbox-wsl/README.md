# Experimental WSL2 execution backend

`@i-harness/sandbox-wsl` provides an explicitly constructed Windows-to-WSL2
backend for IH's existing execution supervisor. Linux Bash and Linux tools run
inside bubblewrap, with a read-only root filesystem, captured writable project
roots, PID namespaces, no network, seccomp and Windows interop masking.

This package is an experiment on `codex/wsl2-sandbox-experiment`. It does not
change Desktop settings, default shell selection or published releases.

## Existing-runtime requirements

- Windows with an existing, explicitly named WSL2 distribution.
- Linux x86_64, Python 3.10 or newer at `/usr/bin/python3`, and bubblewrap with
  `--bind-fd`, `--ro-bind-fd` and seccomp support at `/usr/bin/bwrap`.
- The distribution must permit the user/PID/mount/network namespaces exercised
  by the real startup probe. An unavailable runtime or profile refuses execution.
- No Linux Node runtime is needed. Network is disabled; this experiment does not
  use a proxy or require socat.

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

const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
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

Supported requests are `read-only` or `workspace-write`, pipes,
`complete-tree` lifetime and CRT argument-list encoding. The backend reports
`assurance: "experimental"`, caller-visible reads, write isolation, no PTY,
no retained-tree mode and no general read/deny-path isolation. It refuses
`danger-full-access`; it never retries through another backend.

Root exit, Linux settlement acknowledgement, output EOF and Windows launcher
closure are separate observations. The execution lease waits for the required
observations. Cancellation and control EOF terminate the owned PID namespace;
unknown protocol/cleanup failures remain incomplete. Known prelaunch refusal
rejects the request and acknowledges empty cleanup, without fabricating a root
exit or execution handle. Launcher diagnostics are bounded and separate from
the command's stdout/stderr.

## Public API scope

The three exported names are deliberate opt-in library contracts:
`createWslExecutionBackend` constructs the backend, `WslExecutionBackend` names
its disposable interface, and `WslDiagnostics` names its bounded diagnostic
result. The real consumer in `scripts/qualification/wsl2-sandbox/run.mts`
constructs the backend through the existing supervisor. That script is outside
the production-source reachability scanner, so each name has an individual
dated declaration in its allowlist. These declarations do not assert a shipped
Desktop or CLI default consumer.

## Experimental compatibility limits

- Linux toolchains must exist in the selected distribution. Windows toolchain
  executables do not become Linux executables through path conversion.
- All network access is disabled. Workflows requiring package downloads need a
  future separately designed network policy and relay.
- Reads remain visible as specified by IH's caller-readable policy. The backend
  is not a whole-application or whole-WSL security boundary.
- Writable/reference overlap is refused in either direction. Writable inventory
  admission also refuses regular-file hardlinks, unreadable/special/cross-device
  layouts and changed inventories. Limits are 4096 entries, 512 directories,
  depth 32 and a cooperative two-second scan across writable roots. This can
  refuse larger repositories and dependency trees.
- Each writable root must stay on one existing mount. Pinned/reopened root,
  directory, regular-file and no-follow symlink descriptor mount IDs are checked;
  nested mounts, including same-device mounts, and unavailable metadata refuse.
- Canonical directory resolution is bounded to 128 ancestor levels, 8192
  examined entries and a cooperative two-second budget per distinct captured
  directory. Blocking filesystem operations can outlast a cooperative budget.
- Descriptor pinning and final revalidation protect captured roots; they do not
  create an atomic filesystem snapshot or lock out concurrent trusted host
  filesystem modifications after the final scan.
- This version has source/WSL qualification only, with the exact host/runtime
  documented in the acceptance report. It has no Desktop UI, installer or
  packaged-release qualification.

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
```

The worker tests do not use Linux-home or shared system-temp fixtures. Their
controlled case-sensitive filesystem test is inside a private namespace tmpfs.
