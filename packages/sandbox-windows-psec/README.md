# Windows native execution owner

This package contains the direct Windows PSEC helper and an explicit unrestricted engine. Its public TypeScript API is `createWindowsPsecBackend(options?)` and `createWindowsUnrestrictedBackend(options?)`. Both return a `WindowsExecutionBackend` extending the public `TransportExecutionBackend` contract from `@i-harness/sandbox`; callers pass the selected backend to `launchExecution` or `createExecutionSupervisor` from `@i-harness/exec`. The backend never chooses another engine after a failure. `backend.dispose()` closes admission and retries cleanup of every helper session still owned by that backend. Incomplete native release remains owned, and a later `dispose()` can retry it.

PSEC remains **experimental**. API support discovery is not confinement proof. The current narrow policy uses Microsoft's pinned generated schema directly and has no learning runner, fallback dispatcher, account helper, installation service or elevated setup dependency. `unrestricted` must be selected explicitly; it still owns a non-breakaway Job and transport, but has no filesystem or network isolation. It rejects requested reference/protection locks.

PSEC currently supports **pipes only**. PSEC + ConPTY stalled before real child output in native controls and is rejected before launch; its probe reports `pty:false`. Unrestricted ConPTY has passing input, output, resize, retention and cleanup controls. This explicit capability limit must remain visible to the selecting driver.

The private trusted `consoleMode:"hidden-console"` option is available only for unrestricted pipes. It retains a real hidden console for a later legacy adapter, with the same Job and pipe ownership. Default pipes use no-window. Native root/descendant console presence and visibility are verified; arbitrary GUI windows and complete legacy compatibility are not covered by this primitive.

See [protocol.md](protocol.md) for the exact native contract, field schemas, bounded queues, error fields, effective digest, cancellation output abandonment and release sequence.

The driver verifies the shipped helper and protocol against `manifest.json`, probes the selected engine, then prepares one immutable native policy. The final authority callback runs immediately before the one commit command. The helper supplies the actual PID and independent root, tree, I/O and resource-release acknowledgements. Output has one iterator and bounded buffering before it attaches. When a cancellation explicitly discards output, `handle.io.diagnostics?.()` reports `outputAbandoned` and a conservative `discardedOutputBytes` count from both native and driver drainage. A missing diagnostics method on another backend means accounting is unavailable, not zero loss. A helper crash or incomplete frame never confirms cleanup.

The explicit environment is forwarded unchanged, including empty values; the driver adds no TEMP, LOCALAPPDATA or write grant. On the qualified host, missing LOCALAPPDATA in PSEC mode surfaces native error 203. PSEC currently rejects PTY before preparation and keeps experimental assurance. Unrestricted has no filesystem isolation and refuses mandatory reference or deny locks. `hidden-console` is trusted host configuration for unrestricted pipes only.

## Behavioral qualification

Run `pnpm --filter @i-harness/sandbox-windows-psec qualify:windows` on a Windows x64 host after installing workspace dependencies. It uses the public policy compiler, execution supervisor and backend exports with the shipped manifest and helper. Each run creates a new `.tmp/sandbox-redesign-qualification-*` fixture containing the exact observed results, environment, helper identity, reference content hashes, file metadata and ACL snapshots. The runner reports `pass`, `fail` and `unsupported` separately. Its direct process exit code is 0 only when every control passes, 1 for a failed control and 2 when a required source family is unsupported. Fixtures are retained for review.

On Windows 11 build 26200 with helper SHA256 `421d4a0ed72600d593f5cd1afe8012f49aa0e7ff1ab590486666cf5839e3d395`, PSEC passed the listed filesystem, Node/tsx, CMD, PowerShell, Git executable, Job, pipe and local loopback denial controls. **Git/MSYS Bash failed under PSEC during MSYS initialization** with `NtCreateDirectoryObject(\BaseNamedObjects\msys-...): 0xC0000022`; the same argv, cwd, explicit environment and pipe input succeeded under explicitly selected unrestricted execution. The same failure occurred using Git's direct `usr/bin/bash.exe` image and retain-tree lifetime. This is an observed compatibility limit, so do not route Bash to PSEC or claim the original Bash issue fixed. Unrestricted ConPTY passed real input, resize and descendant retention; PSEC PTY remains rejected before workload launch.

See [the qualification audit](../../docs/audit/2026-10-07-windows-psec-qualification.md) for the exact host, results and limitations. These checks support only the observed cases. PSEC remains opt-in and experimental; production exec/terminal selection and GUI/packaged application checks are separate work. The existing Windows default must not change on this qualification alone.

## Developer build and native controls

On Windows x64 with installed Rust 1.94+ and VS2022 BuildTools:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packages/sandbox-windows-psec/scripts/build-native.ps1 -Test
powershell -NoProfile -ExecutionPolicy Bypass -File packages/sandbox-windows-psec/scripts/build-native.ps1
node packages/sandbox-windows-psec/test/native-helper-smoke.mjs
```

The build uses `cargo --locked`, writes only this package's native target and artifact directories, copies the release executable to `artifacts/win32-x64/`, and records hashes/tool versions in `manifest.json`. Runtime consumers ship and verify that existing executable; they do not invoke Cargo or download a helper. The only Git dependency is generated `process_security_environment_spec` at Microsoft/mxc `6cd3d58f05d3447e67109cfb75e042803b843ca4`; flatbuffers 25.12.19 and windows-sys 0.61.2 are exact pins. Cargo.lock records all transitive versions.

The smoke creates a fresh owned workspace fixture and saves `results.json` there. Set `SANDBOX_HELPER` to test another explicit helper build. `SANDBOX_ENV_OMIT` is a qualification-only comma-separated environment omission control. Native execution forwards the explicit environment exactly. On Windows 26200, missing LOCALAPPDATA caused PSEC CreateProcessW to fail with error 203; the fixture supplies LOCALAPPDATA within its own directory, without any implicit policy grant.

## Native ownership

Rust sources are split by responsibility: `ffi` owns the System32 DLL, boxed PSEC handle and aligned attribute list; `policy` validates/canonicalizes filesystem identities and serializes the schema; `command_line` implements CRT quoting; `job` owns Job accounting and termination; `transport` owns private descriptors, bounded worker queues and ConPTY; `runner` owns preparation/commit/lifecycle; `protocol` defines strict input types and bounds. `self_child` implements explicit fixture workloads.

Workloads start suspended and enter the Job before resuming. Handle lists exclude protocol descriptors. A root exit retains descendants for retain-tree, with native Job ActiveProcesses determining actual completion. PSEC/Job/HPCON remain owned until tree and I/O settlement. Cancel, control EOF and failed launches trigger teardown, never unrestricted retry. See the task report for actual observed gates and remaining qualification limits; this package does not establish a verified Windows security boundary.
