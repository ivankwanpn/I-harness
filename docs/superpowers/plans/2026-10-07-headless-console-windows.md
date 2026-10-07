# Prevent unexpected command windows

Date: 2026-10-07 (Asia/Hong_Kong). Additional user request during the approved sandbox package redesign: investigate and fix frequent cmd/pwsh-like windows while IH runs. Keep the sandbox objective active.

Source audit: `.superpowers/sdd/2026-10-07-windows-psec-driver/console-window-audit.md`. Findings are source evidence, not yet GUI runtime observations. Ordinary exec lacks window suppression; stream exec and Desktop gateway already hide. SDK, LSP and plugin Git helpers have gaps. Subagents run in process and Code Mode uses Worker threads; their tools use the affected exec route.

## Constraints and interface

No source patch to node_modules, no accounts/services/elevation, and no reference/OS ACL mutations. Preserve intentionally inherited CLI console and human terminal behavior. Existing legacy restricted children need a real inherited console; blindly adding CREATE_NO_WINDOW to that native path risks the recorded DLL initialization failure.

Native helper adds a trusted immutable `consoleMode` descriptor: `no-window` default for pipe, or `hidden-console` only for explicit unrestricted pipe owner. Hidden-console creates a real console with CREATE_NEW_CONSOLE and STARTF_USESHOWWINDOW/SW_HIDE; it retains normal Job/stdio whitelist and is not a PSEC/PTY fallback. A qualified legacy adapter may use this for its trusted launcher, with the restricted workload still under the legacy token. PSEC+PTY remains unsupported until actual application I/O is qualified.

## Task 1: Immediate headless launch gaps

**Own files:** packages/exec ordinary direct/unconfined spawn path and focused existing tests if needed; packages/sdk client launch, lsp connection launch, plugin-registry install/marketplace Git launch options; their READMEs/audit note as appropriate. No native helper edits in this task.

- [ ] Add windowsHide:true to ordinary direct/unconfined command launch and noninteractive SDK/LSP/plugin helpers. Keep the console-sensitive legacy confined runner path explicit until its hidden-console adapter is proved; do not present the direct fix as completing constrained/Desktop behavior.
- [ ] Preserve stdio/IPC/environment/exit semantics and actual background/promotion/cancel behavior. Do not add tests that only mirror a literal flag; use existing functionality gates and meaningful runtime observation.
- [ ] Run affected suites/typechecks. Commit assigned files only and independent review. Record unresolved constrained/helper paths in the ledger.

## Task 2: Qualified native console ownership

**Own files:** sandbox-local legacy composition and public native driver console descriptor; focused qualification fixtures. Reuse native helper implementation, do not create a second owner or direct launcher in exec/terminal.

- [ ] Qualify real hidden-console presence/invisibility and descendant behavior, including legacy readonly native shell success. A GUI/no-console parent must be the control; terminal-hosted Node alone cannot establish absence of Desktop flashes.
- [ ] Route legacy trusted runner via that hidden console while the actual restricted child inherits it. Keep native token, argv, policy, grant scope and Job facts unchanged. Unsupported combinations refuse. Unrestricted/PSEC pipe and human ConPTY remain explicit profiles.
- [ ] Complete terminal migration to native Job/ConPTY ownership so Windows no longer forks node-pty's console-list agent. POSIX node-pty remains in the platform driver. Do not edit installed dependency internals to hide symptoms.

## Task 3: Real GUI parent and window-event gates

**Own files:** scripts/qualification/headless-windows fixture and docs/audit acceptance, with only targeted repairs from observed failures. May use a GUI-subsystem runtime (bundled Electron in Node mode) and WinEvent observer under this owned fixture.

- [ ] Observe show events with PID/start time/ancestry/window class/visibility only, no screenshots/window titles/content. Filter to owned fixture processes and console brokers. Establish a controlled positive observer check, then successful hidden launches with no attributable visible console events.
- [ ] Cover foreground/background/promotion/streaming, nested cmd/pwsh/Node/Bash, legacy constrained shell/search helpers, SDK/LSP/plugin local stubs, and PTY open/close/descendant cancellation. Preserve successful execution and confirmed cleanup; a hidden failed process is not a pass.
- [ ] Repeat from actual packaged CLI/Desktop GUI entry points after distribution migration. Record observed source/packaged versions, skipped/unsupported cases and exact limitations. No claim that every possible user-invoked GUI program is forbidden; the target is IH's noninteractive tools/helpers.

## Completion

The source flag fixes and native console profiles are separate evidence. Do not close the user's window bug until the relevant GUI/constrained/presentation paths are verified, or clearly report a concrete remaining platform limitation. Continue the already authorized full package redesign and retain commits locally; no new publication request.
