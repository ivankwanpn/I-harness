# Windows sandbox distribution observations

Date: 2026-10-08. Host: Windows 11 build 26200, x64. These are observations on one host, not a security certification. PSEC remains explicitly selected, experimental and pipes only. The existing user-visible sandbox modes and CLI/Desktop application versions are unchanged.

## Runtime artifacts

The CLI distribution bundles the native execution consumers in `ih.mjs`, the legacy runner in `runner.mjs`, and ships the fixed `sandbox-windows-psec/` asset directory. Desktop ships the same owning package under `resources/gateway/node_modules/@i-harness/sandbox-windows-psec`. Both contain the exact helper, integrity/provenance manifest, protocol and sanitized historical qualification record. CLI Code Mode also ships `worker.mjs`, `cpu-budget.mjs` and the installed QuickJS 0.32.0 dependency graph. Desktop main keeps Koffi external and ships its package and platform binary under `resources/app/node_modules`.

| Asset | Identity |
| --- | --- |
| Helper | `i-harness-windows-helper.exe`, 698880 bytes |
| Target / protocol | `x86_64-pc-windows-msvc` / 1 |
| Helper SHA-256 | `421d4a0ed72600d593f5cd1afe8012f49aa0e7ff1ab590486666cf5839e3d395` |
| Protocol SHA-256 | `c6bcb90ad924488e5d58df01e681ee899a910156d71f5b267b5ea9ad4aa62594` |

Packaging verifies all 12 recorded native source/lock hashes and refuses stale or missing assets. Execution verifies fixed location, target, protocol, architecture and digests before starting the helper. It does not search PATH for the helper, compile it, download it, or fall back to another backend. The build copies installed external dependencies without an install step.

Build the CLI with `node scripts/build-dist.mjs --out dist` and verify it with `node scripts/verify-dist.mjs --out dist`. Build the portable Desktop using its `dist` script; `IH_DESKTOP_RELEASE_LABEL=release-sandbox-task5` selects a separate output folder. Neither command publishes or installs the application. Native compiler provenance stays in the shipped manifest; the production helper was not rebuilt for this delivery.

## Actual observations

The actual bundled CLI passed version/usage/SDK initialization and its hidden distribution selfcheck. That selfcheck enters the assembled Code Mode worker and the supervised native/legacy process paths, validates root output and exit status, denies a readonly write, allows a workspace write, and awaits disposal. The actual portable Desktop main window opened after repairing its missing bundled Koffi dependency. Its actual packaged gateway CLI answered SDK requests and opened, wrote to and closed a native human terminal with complete settlement.

Under an owned GUI-subsystem parent, source and packaged runtime consumers passed Node, nested CMD, native Windows PowerShell, unrestricted Bash, binary streaming, foreground promotion without respawn, background cancellation, legacy readonly denial and workspace write, constrained search, SDK/LSP local helpers, local Git marketplace/plugin helpers, PTY open/close and generic native descendant cancellation. Source and packaged assemblies also passed durable main/child ownership through nested Code Mode, native writer revocation acknowledgement, and mandatory reference-lock refusal. Reference content SHA-256, size, timestamps and mode remained unchanged. Final workload observations recorded no surviving owned processes; successful disposals awaited native tree/I/O/resource settlement.

The window investigation found a concrete legacy launch defect. A zero-area `PseudoConsoleWindow` belonged to a newly started Windows Terminal hosting window that was visible, had window/client area and was not cloaked. The inherited restricted-child launch had dropped the hidden startup hint. The trusted hidden-console composition now forwards an opt-in `hideChildWindows` setting through the runner to `STARTF_USESHOWWINDOW/SW_HIDE`. Creation remains suspended with the same inherited stdio, token, Job, environment and grants. The default raw provider keeps its previous startup behavior. The native Rust helper and protocol were unchanged.

After that repair, both final GUI observation waves passed: an actual Desktop main-window SHOW positive control, successful source and packaged workloads, zero ordinary console SHOW events, zero pseudo-console SHOW events, zero new visible hosting windows, zero unknown owned SHOW events, and no surviving owned PIDs. The supplemental wave explicitly verified that the GUI observer had no console. This is bounded evidence for the exercised noninteractive paths on this host, not a prohibition on user-invoked GUI applications.

Desktop Agent `auto` already selects a native Windows shell rather than generic Bash discovery. It now excludes WindowsApps execution aliases from automatic selection because those aliases are refused by the native process path on this host. Explicit selections remain exact. The measured assembled readonly automatic shell ran a native PowerShell executable, `pwsh.exe`, with the PowerShell dialect. CLI currently exposes explicit `bash` and `pwsh` tools; it has no equivalent automatic shell setting.

## Acceptance limits that remain open

- **Console evidence is scoped.** Earlier failed observations, including destroyed/unqueryable HWNDs, remain retained. They were not relabeled as passing evidence. The corrected source and packaged paths passed the final measured waves described above. The positive control proves SHOW-hook operation; it is not a deliberately visible console calibration, and future operating-system or terminal-host changes require fresh qualification.
- **Confined Git Bash failed.** The legacy driver advertises pipes, not tool-family initialization guarantees. The controlled readonly Git Bash workload failed to create its MSYS signal pipe with Win32 error 5 and exited `3221225794` (`0xC0000142`). Its native tree, I/O and resources settled completely. Generic shell discovery finding Bash does not qualify it for confinement. There was no namespace/ACL relaxation or backend retry.
- **One Node ConPTY descendant case remains unqualified.** A trusted observer held an owned child query handle while the root waited. The child was `STILL_ACTIVE` before the root gate opened, then the root and child both exited 0. The child's first marker and delayed marker were absent; native tree/I/O/resources settled. The cause is unknown. Generic native self-child retention/cancellation does not substitute for this case, and this observation does not establish that every Node descendant is unsupported.
- **Legacy readonly PowerShell has a language compatibility limit.** The no-temp policy can select ConstrainedLanguage; cmdlet operations were qualified, but unrestricted .NET method calls were not. No hidden writable temporary directory was granted.
- **PSEC MSYS/BNO and PTY limits remain unchanged.** PSEC is opt-in experimental, with unsupported profiles refused. Previously recorded PSEC MSYS failure research was not repeated for this delivery.

The WinEvent observer records only owned process/window metadata and the bounded metadata of their exact related owner/root windows. Its Desktop positive control proves SHOW delivery, not calibration against a deliberately visible console. Destroyed/unqueryable HWNDs remain unknown. Missing or stale associated-window metadata also fails acceptance, even when a pseudo window has zero area. A successful, bracketed null owner lookup is recorded separately as known absence; it is not interchangeable with lookup failure. This classification has deterministic metadata-only regressions. The three recorded final real waves remain unchanged; this classifier repair did not rerun or extend their observations. Short process lifetimes can limit ancestry correlation. See the [fixture procedure](../scripts/qualification/headless-windows/README.md) for exact scope and Microsoft API references.

## Verification scope

Artifact integrity tests, Desktop runtime-copy tests, native package tests, focused CLI lifecycle/flag tests, automatic-shell regression tests and affected typechecks passed. The production-only workspace dependency graph is reachable and acyclic; the known exec/native-driver test-development cycle is excluded from that production graph.

The initial repository export reachability gate reported 15 public exports without named consumers outside their package. Existing admission, lifetime and host composition boundaries now use the appropriate exported type names, and the legacy local provider uses the shared capability guard. The nine deliberately public type contracts below have individual reachability declarations; these declarations do not assert additional runtime consumers. The baseline was not reseeded.

Literal `verify:all` was not run. Safe workspace packages and ACL/e2e cases were run separately, with missing packages enumerated after the recursive runner stopped at a failure. Review corrected two overly broad exclusions: all 12 ACL provider tests only construct argv or use mocked grant operations, and all three audit tests operate on fresh owned directories without real ACL probing. Both full files passed unchanged. The assembly-only Node case in the root sandbox e2e also passed; its temp fixture was inside the approved workspace boundary, so this does not establish the test title's outside-repository location claim. The root Bash case remains excluded from repeat qualification, and the direct standalone runner case would actually create private-temp write grants outside its declared workspace and rewrite the child TEMP/TMP, beyond the approved no-temp profile. Exact remaining actions and coverage are recorded in the delivery report. The controller still owns independent Task 5 and whole-branch review.

## Public type contracts

These names let library/plugin consumers name the types already present in exported runtime API signatures. Keeping them public avoids forcing callers to reconstruct anonymous or indexed types. They are type-only API declarations, not claims of unimplemented process features.

| Export | Existing public contract |
| --- | --- |
| `@i-harness/exec#ExecutionLaunch` | Input of `ExecutionSupervisor.launch`; includes trusted policy, backend, process specification and validator. |
| `@i-harness/sandbox#BackendAssurance` | Assurance field of `BackendProbe`, `ExecutionReceipt` and minimum requirements. |
| `@i-harness/sandbox#ConfinedSandboxMode` | Narrowed mode of `SandboxPolicy` and `SandboxUnavailableError`. |
| `@i-harness/sandbox#ExecutionIo` | Owned transport I/O of `TransportExecutionHandle.io`. |
| `@i-harness/sandbox-local#LegacyWindowsBackend` | Disposable backend returned by `createLegacyWindowsBackend`. |
| `@i-harness/sandbox-windows-psec#WindowsExecutionOptions` | Trusted construction options of both native factories and qualification inspection. |
| `@i-harness/sandbox-windows-psec#WindowsQualificationRecord` | Sanitized historical `WindowsQualificationView.record` schema. |
| `@i-harness/sandbox-windows-psec#ObservedSupport` | Historical status values in the record's source-family observations. |
| `@i-harness/settings#SettingsWindowsSandboxBackend` | Persisted `Settings.windowsSandboxBackend` vocabulary. |
