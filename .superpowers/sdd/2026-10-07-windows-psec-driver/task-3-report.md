# Task 3 report — Windows PSEC behavioral qualification

Status: **DONE_WITH_CONCERNS**. Base revision `2345cc9f`; qualification implemented without native helper, protocol, manifest, driver or production-service edits. The original Bash runtime issue remains: the PSEC profile cannot initialize Git/MSYS Bash on this host. This is a qualification failure for that required source family, while 38 other behavioral controls passed.

## Exact artifact and host identity

- Final machine-readable evidence: `D:\I-harness-main\.tmp\sandbox-redesign-qualification-LDbdbc\qualification-results.json` (retained). All owned fixture mutations, including files and junction, are under that new `.tmp/sandbox-redesign-*` directory.
- Windows 11 Pro for Workstations NT 10.0.26200 x64; Node v24.15.0; pnpm 12.3.4; Git for Windows 2.54.0; Bash 5.3.9; Rust/helper manifest records rustc 1.94.0 and schema revision `6cd3d58f05d3447e67109cfb75e042803b843ca4`.
- Helper executable SHA256 `421d4a0ed72600d593f5cd1afe8012f49aa0e7ff1ab590486666cf5839e3d395`; protocol SHA256 `c6bcb90ad924488e5d58df01e681ee899a910156d71f5b267b5ea9ad4aa62594`; manifest/protocol version 1. The qualification runner verified the executable against the manifest before launch.
- No accounts, tasks, services, elevation, Low labels, external/reference ACLs, runtime defaults, PSEC attributes or network policy were changed. No fallback engine was used for a PSEC case.

## Commands and results

From `D:\I-harness-main` in PowerShell:

```powershell
pnpm --filter @i-harness/sandbox-windows-psec typecheck
# $ tsc --noEmit; exit 0

pnpm --filter @i-harness/sandbox-windows-psec test
# Vitest: 4 files passed, 33 tests passed; exit 0

pnpm --filter @i-harness/sandbox-windows-psec qualify:windows
# 38 PASS, 4 UNSUPPORTED, 0 FAIL; evidence path above
# child qualification exit 2 for required unsupported Bash family;
# pnpm wrapper reports ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL (shell exit 1)

git diff --check
# no output; exit 0
```

The qualification uses the public `compileExecutionPolicy`/`assertExecutionAuthority`, `createExecutionSupervisor`, and Windows backend exports. Package dependencies already declared `@i-harness/exec` and `@i-harness/sandbox-policy` as test dependencies. It records a result for each control and returns direct exit code 0 only if all required cases pass, 1 for a failed control and 2 for unsupported source families. The pnpm wrapper surfaces 2 as its lifecycle error.

### Passing controls

- PSEC workspace write, read-only, sibling external reference read with write denied, protected subtree read/write denied, and junction alias write denied. Unrestricted refused mandatory reference and deny locks before launch.
- Exact Node argv including empty, quoted and Unicode elements, absolute cwd, explicit environment including empty value, no undeclared variable, binary stdout/stderr, full-width exit 259, native binary stdin, actual tsx pipe input, CMD, PowerShell and Git executable under both engines. PSEC without `LOCALAPPDATA` surfaced native CreateProcessW error 203 and released rollback ownership.
- Retained native descendants remained alive after root exit and finished before tree settlement. Timeout cancellation and Job cancellation of descendants returned tree empty, I/O settled, resources released; cancellation marker files stayed absent and `tasklist` did not list the descendant PIDs. Flood cancellation with no attached output iterator reported trusted output abandonment and discarded payload accounting (final run: PSEC 1,736,704 bytes; unrestricted 1,769,472 bytes). Normal runs reported zero abandonment/loss.
- PSEC PTY was rejected before launch. Unrestricted ConPTY completed real child input/output, resize to 100×30 and retained descendant lifetime.
- Host Node connected to owned loopback listener; PSEC Node got `ERROR:EACCES` for the same local target. This is a local loopback observation only.

### Bash compatibility evidence and concern

The exact Git Bash launcher command, cwd, full explicit environment and stdin are saved per run in the JSON. Unrestricted PID 7212 exited 0 with stdout `bash-qualification\nstdin-through-bash\n`, no stderr, complete settlement. PSEC had no workload stdout and native root exit **3221225794 / 0xC0000142** with stderr:

```text
*** fatal error - NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-1888ae32e00d56aa): 0xC0000022
```

The focused matrix used identical policy, cwd, environment, Bash command and pipe input:

| PSEC executable | Lifetime | PID | Exit | Framing/settlement |
| --- | --- | ---: | ---: | --- |
| Git `bin/bash.exe` launcher | complete-tree | 91940 | 3221225794 | normal, no output loss; tree/I/O/release confirmed |
| Git `bin/bash.exe` launcher | retain-tree | 88464 | 3221225794 | same |
| Git `usr/bin/bash.exe` direct | complete-tree | 21244 | 3221225794 | same |
| Git `usr/bin/bash.exe` direct | retain-tree | 70216 | 3221225794 | same |

The direct-image/retain-tree failures rule out a launcher-only or premature complete-tree termination explanation. The helper launched and owned each process, so this is an MSYS named-object initialization denial under the PSEC profile. No targeted native repair was attempted because the native source/artifact is frozen pending controller ruling, and no safer profile change is established by this evidence. Production may only use explicitly selected unrestricted execution for Bash until a separately reviewed solution is qualified; it must not silently downgrade PSEC or claim Bash fixed.

## Protected references and cleanup

- Sibling reference file SHA256 before and after: `6683c10c396beae22cb763c71d31a9ed1b39135b64f6124810bf08c4d0beedbd`.
- Protected subtree file SHA256 before and after: `384db46f0c2da4f607f7bdf570d125fa3002feadc5d731e5095c05826be76a4a`.
- Both files had identical size, birth/modify timestamps, mode and `icacls` text before/after. `icacls` exited 0. The full metadata and ACL snapshots remain in the JSON. No reference ACL was altered.
- No cleanup was attempted. Final and earlier exploratory owned fixtures were retained for failure analysis; no pre-existing, user, source or outside path was removed or mutated.

## Files and self-review

- `packages/sandbox-windows-psec/test/qualification.mts`: real public-path qualification and durable JSON evidence.
- `packages/sandbox-windows-psec/package.json`: `qualify:windows` script.
- `packages/sandbox-windows-psec/tsconfig.json`: typechecks the qualification `.mts` source.
- `packages/sandbox-windows-psec/README.md`: command, result semantics and current compatibility limit.
- `docs/audit/2026-10-07-windows-psec-qualification.md`: host-specific audit and production selection requirements.

Self-review: all mutable paths are generated under the verified workspace fixture prefix; no private cross-package implementation import or dependency cycle was added. Cases use public policy/exec/backend APIs and explicitly distinguish `unsupported` from pass. The Bash failure record includes PID, argv, cwd, environment, exit, both output channels, native settlement and loss diagnostics. The unsupported gate exits nonzero so automation cannot mistake 38 passing controls for complete qualification. Actual GUI visibility, Desktop/CLI packaged helper distribution and composed production exec/terminal remain separate Task 5 work. PSEC remains opt-in experimental; no default promotion or security-boundary assertion is supported.
