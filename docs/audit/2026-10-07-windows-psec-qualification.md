# Windows PSEC and explicit unrestricted behavioral qualification

Date: 2026-10-08 Asia/Hong_Kong. Source: `packages/sandbox-windows-psec/test/qualification.mts`. Evidence: `D:\I-harness-main\.tmp\sandbox-redesign-qualification-LDbdbc\qualification-results.json`. This is a host-specific observation tied to the exact helper and protocol; it does not establish a general security boundary or a production default.

## Identity and method

- Host: Windows 11 Pro for Workstations, NT 10.0.26200, x64; Node v24.15.0, pnpm 12.3.4, Git for Windows 2.54.0, Git Bash 5.3.9.
- Helper: `artifacts/win32-x64/i-harness-windows-helper.exe`, SHA256 `421d4a0ed72600d593f5cd1afe8012f49aa0e7ff1ab590486666cf5839e3d395`, 698,880 bytes. Manifest version 1, protocol version 1, Rust 1.94.0, generated MXC schema revision `6cd3d58f05d3447e67109cfb75e042803b843ca4`. The script verifies the helper against the manifest before launching.
- The harness uses `compileExecutionPolicy` and `assertExecutionAuthority` from the public policy package, `createExecutionSupervisor` from public exec, and the public Windows backend constructors. It does not import private implementation modules, substitute an unrestricted launch for PSEC, or change host/reference ACLs.
- All mutable inputs and protected reference fixtures are under the new owned `.tmp/sandbox-redesign-qualification-LDbdbc` directory. The program records per-case results and reference before/after hashes, times, size, mode and `icacls` output. The retained JSON contains full argv, cwd, environment identity SHA256/key names, PID, root exit, output and settlement for the Bash matrix. The actual environment forwarded to each process was unchanged. The final fixture was sanitized in place to remove five raw environment objects without displaying their values.
- The package ships `qualification.json`, a sanitized summary with the exact helper/protocol hashes and Windows release. Public `readWindowsQualification(options?)` checks the current helper and protocol identity and returns host applicability plus this frozen record. It is evidence for later displays, not an execution-admission decision.

## Observed results

The final behavioral run reported **38 pass, 0 fail, 4 unsupported**. `pnpm --filter @i-harness/sandbox-windows-psec typecheck` passed; the package test suite passed 35/35 tests after the shipped record was added. The qualification process exited 2 because Bash support is a required gate (the pnpm wrapper reported command failure with exit code 2). This is an incomplete qualification, despite the 38 passing controls. `npm pack --dry-run --json` confirmed the package includes the manifest, protocol, qualification record and accessor source.

| Control | Observed result |
| --- | --- |
| Workspace write, read-only, sibling reference, denied subtree | PSEC allowed the declared workspace write, denied it in read-only, read the sibling reference, denied reference writes and denied reads/writes of the protected subtree. |
| Junction alias into sibling reference | Write through the workspace junction failed; the reference file remained unchanged. |
| Protected content and metadata | Reference SHA256 `6683c10c396beae22cb763c71d31a9ed1b39135b64f6124810bf08c4d0beedbd`; denied-file SHA256 `384db46f0c2da4f607f7bdf570d125fa3002feadc5d731e5095c05826be76a4a`. Both file hashes, sizes, birth/modify times, modes and `icacls` text matched before/after. |
| Mandatory locks under unrestricted | Reference-root and deny-path requests were refused before launch; no lock was silently dropped. |
| Explicit environment | Node observed exact argv including empty, quoted and Unicode arguments, exact cwd, explicit marker and empty value, and missing undeclared variable. PSEC missing `LOCALAPPDATA` retained native CreateProcessW error 203; no environment or TEMP write grant was synthesized. |
| Pipe/runtime controls | Node and actual tsx pipe input, binary stdout/stderr, exit code 259, native binary stdin, CMD, PowerShell and Git executable completed under both engines. |
| Lifetime and cancellation | Retained descendant marker was absent at root exit and present only after tree completion. Timeout and Job cancellation ended native workloads and descendants, left cancellation markers absent, and reported tree empty/I/O settled/resources released. Tasklist did not list descendant PIDs after settlement. Flood cancellation without an attached output iterator reported `outputAbandoned:true` and conservative discarded-byte counts (PSEC 1,736,704; unrestricted 1,769,472). Normal controls reported no abandonment or loss. |
| ConPTY | PSEC PTY was rejected before launch. Unrestricted PTY produced real child output, accepted input, resized to 100×30 and retained a descendant until completion. |
| Loopback network | The direct host Node control connected to `127.0.0.1` on the fixture listener; the same PSEC Node workload reported `ERROR:EACCES`. This is local loopback evidence only. |

### Git/MSYS Bash compatibility result

The exact command was `C:\Program Files\Git\bin\bash.exe -c "printf 'bash-qualification\\n'; cat"` with cwd at the owned `workspace`, explicit environment identity digest/key names recorded in the JSON, and stdin `stdin-through-bash\n`. Under unrestricted the workload PID 7212 exited 0, stdout contained both expected lines, stderr was empty, and native tree/I/O/release settlement was confirmed. Under PSEC PID 91940 exited **3221225794** (`0xC0000142`), stdout was empty, and stderr reported:

```text
*** fatal error - NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-1888ae32e00d56aa): 0xC0000022
```

The focused matrix kept policy, cwd, explicit environment, command and input fixed while varying the image and tree lifetime:

| PSEC image | Lifetime | Workload PID | Root exit | Result |
| --- | --- | ---: | ---: | --- |
| Git `bin/bash.exe` launcher | complete-tree | 91940 | 3221225794 | MSYS named-object access denied |
| Git `bin/bash.exe` launcher | retain-tree | 88464 | 3221225794 | Same failure |
| Git `usr/bin/bash.exe` direct | complete-tree | 21244 | 3221225794 | Same failure |
| Git `usr/bin/bash.exe` direct | retain-tree | 70216 | 3221225794 | Same failure |

The PSEC helper did start and own each process; normal binary framing and `root-exit`, `tree-empty`, `io-settled`, `released` were observed with `outputAbandoned:false`, `discardedOutputBytes:0`. Direct image plus retain-tree rules out the launcher/early-root-exit explanation for this result. This is a real MSYS initialization failure under the selected profile, not a missing backend or harness output assertion. No PSEC capability, attribute, ACL, named-object or network relaxation was attempted. The source family is **unsupported under this PSEC profile on this host**; using unrestricted requires an explicit selection. The original Bash/runtime issue remains open for production integration.

## Limits and selection requirements

PSEC is opt-in and experimental. Its probe's feature flags are discovery, not assurance. Only pipe transport is selectable; PSEC PTY is unsupported. The production selector must honor the requested mode and mandatory locks, refuse incompatible requirements, preserve native diagnostics and never silently retry using unrestricted execution. Explicit unrestricted execution has no filesystem or network isolation and refuses reference/deny/readonly locks. The current default Windows legacy runner remains the default until a separate assurance and migration decision. CLI/Desktop packaging, GUI/hidden window observation, installed helper integrity in distributed artifacts, terminal/exec composition and real user-session ownership remain production work.

The test's protected paths are owned qualification fixtures, not user references. Their ACLs were read but not changed. This one host, one helper hash, one protocol version and these workloads cannot prove race resistance, broader egress coverage, or arbitrary programs. The fixture and earlier exploratory qualification fixtures were retained for review; no cleanup of pre-existing or external paths was attempted.
