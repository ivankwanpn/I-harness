# I-harness environment audit, and the two defects it produced

Read-only audit of the INSTALLED runtime (`C:/Program Files/I-harness Desktop`, v0.1.1,
Electron 44.4.5, gateway executed from TypeScript through tsx) together with the source it was
built from, followed by fixes for the two code defects the audit found. The install ships TS
sources, so the running gateway can be read directly — and it is byte-identical to the clone's
HEAD, which is what makes a fix in the repository a fix to the thing that actually runs.

## Scope and method

Measured on this host: Windows 11 build 26200, non-elevated medium-integrity token, Git Bash
5.3.15, WSL Ubuntu-24.04 present, Node 22.23.2 on PATH (the gateway's own runtime is the
Electron-bundled Node 24.21.0 — a different interpreter).

The install and the clone agree: comparing every `src/*.ts` of all 67 `@i-harness/*` packages,
0 files exist only in the install and every content difference is a line ending. A SHA-256 pass
first reported 68 differing files; that was a false positive from CRLF vs LF, corrected by
line-by-line comparison (`Compare-Object` → 0 differing lines, byte delta equal to the line
count).

## Finding 1 — an MSYS/Cygwin child died silently under the confined token

A confined MSYS program cannot create the named signal pipe its runtime starts with, so it dies
inside DLL initialization before the command body runs. The runner starts fine and merely mirrors
that status, so the provider's only failure rule (exit 127 + `windows-acl-run: `) never matched:
`exec` returned an ordinary nonzero exit and the shell's legible refusal was unreachable.
`e2e/sandbox.e2e.ts` could only *tolerate* the failure, so a regression here was undetectable.

Reproduced through the provider's own argv:

| Target under `workspace-write` | Status | stderr | Classified before |
|---|---|---|---|
| `cmd.exe` (native) | 0 | — | n/a (it ran) |
| `node.exe` (native) | 0 | — | n/a (it ran) |
| `git.exe` (native) | 0 | — | n/a (it ran) |
| **Git Bash** | **3221225794** | `*** fatal error - couldn't create signal pipe, Win32 error 5` | **no** |
| **msys `ls.exe`** | **3221225794** | same | **no** |
| Git Bash under `read-only` | 3221225794 | same | **no** |

3221225794 is `0xC0000142`, STATUS_DLL_INIT_FAILED, and is the unsigned form of the
`-1073741502` a signed reader sees. Both confined modes fail, so widening to `workspace-write`
cannot help; only `danger-full-access` runs such a program.

**Correction (commit `9309cd38`).** The provider carries a second `runnerFailureRules` entry,
exit-gated AND signature-gated so a command that merely prints the signature, or a native program
that dies in DLL init for an unrelated reason, stays an ordinary failure. `SandboxUnavailableError`
now distinguishes *why* it is unavailable (`no-backend` vs `command-not-run`), because the two
facts take opposite advice, and it carries the raw cause in `detail` apart from its message. The
shell's refusal for `command-not-run` therefore quotes the real diagnostic and names
`danger-full-access`; the `no-backend` sentence is unchanged.

**Still open.** Only the *silent* half is fixed. How to make MSYS programs actually run under a
restricted token is NOT solved, but the mechanism was identified afterwards and it is NOT the
named-pipe/NPFS story this section first guessed. Measured in-process inside a confined process
(`spike-pipes/`, throwaway): `CreateNamedPipeW` succeeds under EVERY explicit DACL tried,
including one naming only the user, while `CreatePipe` (anonymous) succeeds only when its explicit
DACL names a SID that is also in the restricting list — `NULL` SA (token default DACL) and
`Everyone` pass, "user only" and `Administrators` fail with exactly error 5. So `WRITE_RESTRICTED`'s
pass-2 applies to anonymous pipes, not to named ones, and `msys-2.0.dll` builds no security
descriptor itself (zero references to the SD-building APIs, no SDDL literals) — it passes a
statically compiled `SECURITY_ATTRIBUTES`. Since the `Everyone` form SUCCEEDS, Cygwin's SD cannot
be an Everyone grant; it must name the user/creator. `setTokenDefaultDaclGrant` cannot help,
because it only affects objects created with no explicit SD. Adding the user SID to the restricting
list would admit the pipe but also let the confined process write anywhere the user can, i.e.
abandon write isolation — so the remaining direction is a different Windows mechanism (low
mandatory integrity level or AppContainer, where pipe creation is not gated by a DACL pass-2),
which is a re-architecture rather than a tuning change. `README.md` in
`packages/sandbox-windows-acl` records the measurement, the corrected mechanism, and this boundary.

## Finding 2 — the non-bash shell surfaces left `bash` to the host PATH

`where.exe bash` lists `…/Microsoft/WindowsApps/bash.exe` — the WSL launcher — before any real
Unix shell, so a bare `bash` inside a `pwsh` command ran a different filesystem with the
workspace's paths absent. The PATH-shaping helper returned `{}` for every executable that was
not `bash.exe`, so the bash tool was shaped, the `pwsh` tool was not, and the `shell` tool only
when the Agent Shell happened to be bash. Measured through the live harness before the change:
`bash -c uname` printed `Linux`; the bash tool's own child printed `MINGW64_NT-10.0-26200`.

**Correction (commit `046d77df`).** The helper is now `shellCommandEnvironment`: a launched bash
keeps its OWN directory (an Agent Shell deliberately set to Rtools/MSYS Bash must keep using it),
every other shell gets the resolved bash directory prepended for that child only, and nothing is
prepended when no bash resolves — global PATH is never touched. Nothing about the shell tool's or
bash tool's existing behaviour changes, because for a bash child the prepended directory is the
same one.

## Finding 3 — the documented known-red tests are green on this host

`docs/superpowers/plans/*` name two pre-existing red test sets: `packages/session-executor/test/
workspace-cwd.test.ts` (2) and `apps/cli` shell retry/retention (2), both "bash on PATH is WSL not
Git Bash". Neither reproduces here: `workspace-cwd.test.ts` is 6/6 green and `apps/cli` is 27/27
files green (exit 0). The `bash` resolution they blame is unaffected by these commits — the bash
tool prepended the same directory before and after Finding 2, and `resolveShell`/`onPath` read
`process.env` unchanged.

Those dated plan documents are records of what was true when they were written, so they are NOT
rewritten. This audit is the current record: **on 2026-10-05 those four tests are green on this
host.** Anyone citing them as known-red should re-run them first.

## Finding 4 — the code-retrieval suite could not run on a fresh checkout

Found by this audit's own gate run, not by inspection. Three of its test files rooted `mkdtemp`
at `…/code-retrieval/.superpowers/sdd/2026-10-04-native-context-subsystems/<prefix>-`. That
`.superpowers/` directory is **gitignored** (`.gitignore:53`) and `git ls-files .superpowers`
returns 0 entries, so it exists only on a machine where a superpowers SDD session happened to run
— and nowhere else. On a fresh clone every fixture fails at setup: 3 files, 40 tests, all
`ENOENT … mkdtemp`, and it was the ONLY failure in the full `pnpm -r test` run.

The location was scratch space, not workflow output: each file passes the directory to the
service as its work root and removes it in `afterEach`, and no test reads a spec file from it.
The roots now sit under `os.tmpdir()`, the pattern `e2e/helpers.ts` already uses. Verified: 40
failed → 46 passed with every assertion untouched, typecheck green.

## Finding 5 — the aggregate test gate is not reliable on this host

**CORRECTED — read this before quoting the table below.** Two measurement errors sat on top of
this finding, and both are recorded because they changed the conclusion twice:

1. The first five runs used `pnpm -r test` WITHOUT `--no-bail`, so pnpm bailed at the FIRST
   failing package and the remaining 60-odd never ran. "The failing test moves" was largely that
   artifact, and the reasoning built on it — that raising a deadline must be wrong — was wrong
   with it. Run 6 used the repository's own `pnpm test` (`--no-bail`) and produced the real
   number, identical in parallel and serial mode: **`Summary: 4 fails, 69 passes`**.
2. `packages/terminal`'s pwsh test was blamed on the `…\Microsoft\WindowsApps\pwsh.exe` execution
   alias. It is not: the bare name resolves to the real MSIX pwsh at PATH entry 0, and
   `Error: AttachConsole failed` is node-pty's `conpty_console_list_agent` noise — it appears in
   PASSING runs too (e.g. session-executor's PTY test). Driving the same test with
   `--testTimeout=60000` made it PASS in **5706ms**, which is the actual story: a ConPTY spawn on
   this host costs seconds. `packages/terminal` and `packages/fs-search` now carry explicit
   deadlines with every assertion untouched, and neither needs `--testTimeout` any more.

The table below is left as observed, subject to the two corrections above:

| run | red | note |
|---|---|---|
| 1 | `packages/code-retrieval` — 40 tests, all `ENOENT mkdtemp` | deterministic; that is Finding 4 |
| 2 | `packages/fs-search` bounded search — `Test timed out in 5000ms` | |
| 3 | the same test again | |
| 4 | `packages/terminal` "opens pwsh by its user-facing command name" — `5000ms` | an fs-search timeout bump was applied |
| 5 | `packages/fs-search` again | bump reverted |

Every one is a test that spawns a real process (ripgrep, or a pwsh ConPTY) and hits vitest's 5s
default. This host is 8 logical / 4 physical cores; `pnpm -r` already runs four packages at once
while each package's vitest spawns its own worker pool, and the I-harness Desktop app itself holds
~760 MB across 5 processes. **Bumping ONE test's timeout is not enough** — run 4 exposed a second spawn-heavy suite waiting
behind the first — but the cause is systemic and deadline-shaped, so the answer is an explicit
deadline per affected suite (below), not a single bump.

**What is red on this host, measured per package — all 73 packages run ALONE, sequentially:
69 pass, 4 fail, and those 4 fail alone too.** An A/B against the base commit's `src` (reverting
only this branch's source files) reproduced IDENTICAL counts in both arms, so none of it is
caused by this work:

| suite | BASE src | this branch's src |
|---|---|---|
| `session-executor` | 18 failed / 188 passed | 18 failed / 188 passed |
| `desktop-gateway` | 7 failed / 294 passed | 7 failed / 294 passed |
| `guard-approval` | 1 failed / 99 passed | 1 failed / 99 passed |
| `desktop` | 18 failed / 668 passed | 18 failed / 668 passed |

Their causes are three different things: host paths (Finding 6), genuine assertion failures
(`native-context-lifecycle` expects a `ctx_…` reference, `code-mode-store` expects
`status: 'completed'`, desktop-gateway's `native-context-host` expects `state: 'ready'`), and
deadlines in suites that hash a shipped-size image or drive a PTY. Two of the three are NOT fixed
here, deliberately: an assertion failure inside a feature is not a flaky test, and the remaining
suites' timeout policy is a repository-wide decision rather than a per-file patch.

Still green on this host, every run: `pnpm typecheck`, `check-thresholds.mjs`,
`verify:reachability`, and `pnpm e2e` (12 tests across 5 files).

## Finding 6 — three test files rooted their fixtures in the original developer's machine

`packages/session-executor/test/{project-context,scoped-exec,search-code-mode}.test.ts` built
their fixture parents from `D:/agent-complete/playground` — a path that exists only on the machine
this repository was developed on. `mkdtempSync` requires its parent to exist, so on every other
host about eleven tests died at setup: `ENOENT: no such file or directory, mkdtemp
'D:\agent-complete\playground\project-execution-XXXXXX'`. Same defect class as Finding 4.

The parent cannot simply become `os.tmpdir()`: `project-context.test.ts` carries the reason in its
own comment — "The unrelated folder must be outside the platform temp grant" — because the
runner's private temp lives inside `tmpdir()`, so a fixture rooted there would make the tests'
denial assertions vacuous. Each file now uses the branch its own POSIX arm already used and that
CI already trusts: `process.cwd()` for `project-context`/`scoped-exec` (outside the temp grant,
outside the workspace under test, present on every host), and `tmpdir()` for `search-code-mode`,
whose POSIX arm already used it.

Verified: `packages/session-executor` went from **18 failed / 188 passed** to **7 failed / 199
passed** with no assertion changed, and every `D:/agent-complete` ENOENT is gone. The seven that
remain are not this defect — three are the genuine assertion failures named above and four are
deadlines in suites that drive rg, an assembly or a PTY.

`packages/desktop-gateway/test/terminal.test.ts` mentions the same path, but only as a STRING
handed to a mock (`createDesktopTerminal("D:/agent-complete/playground", …)` plus the matching
`cwd` assertion): it never touches the filesystem, so it neither breaks nor depends on that path
existing. It is left alone, and named here so the difference is on the record.

## Build record — the packaged artifact for this branch

Built on 2026-10-05 from this branch (tip `dc855311`) so the fixes above can be exercised in the
installed Desktop app. Two build prerequisites were NOT present on this machine and were staged
into the repository's gitignored build directories:

- **electron 44.4.5 binary** — `packages/desktop/node_modules/electron` existed but its `dist/`
  did not (no `postinstall` in that package, so pnpm never fetched it). Staged with
  `node node_modules/electron/install.js`.
- **NSIS 3.11** — not installed, and unlike `scripts/build-installer.mjs` the DESKTOP installer
  does not download it. Staged to `build/tools/makensis/` (the path that script probes) from
  `nsis-3.11.zip`; `makensis /VERSION` → `v3.11`.

Commands:

```
pnpm --filter @i-harness/desktop dist
pnpm --filter @i-harness/desktop installer -- --nsis <repo>/build/tools/makensis/makensis.exe
```

Artifacts in `packages/desktop/release/`:

| artifact | size | sha256 |
|---|---|---|
| `I-harness-Desktop-Setup-0.1.1.exe` | 138,607,775 B | `f1ee29b028afc001e19c6afa9a5a18e3c875c58683da2ead12adb41b0d17d910` |
| `I-harness-Desktop-0.1.1.zip` (portable) | 216,319,835 B | — |

> The Setup EXE was REBUILT after the elevated-update change
> (`docs/audit/2026-10-05-desktop-installer-update-support.md`), superseding the first build of
> this artifact (`de76f592…`, 138,634,616 B). Only the NSIS step re-ran: the payload is
> byte-identical (`payloadExeSha256` `bd14928e…` in both). The table above is the current one.

The builder's own record is `I-harness-Desktop-Setup-0.1.1.installer-build.json`
(payload 7951 files / 577,121,250 B, payloadId `3b28d542…`, payload exe
`bd14928e…`, makensis `f497e92d…`). The version is still **0.1.1** — it was not bumped, so this
Setup updates the existing installation in place and is distinguishable only by hash/date.

The packaged payload was verified to CONTAIN this work rather than a stale tree: the shipped
gateway sources (`resources/gateway/node_modules/@i-harness/*`) carry `SandboxUnavailableKind`,
`WINDOWS_ACL_MSYS_INIT_FAILURE_EXIT`, `shellCommandEnvironment` and `command-not-run`, and contain
ZERO occurrences of the pre-fix `bashCommandEnvironment`. Installing it was NOT done here: the
Desktop refuses to update while it is running — which is the process this audit ran inside — and
the destination is `C:\Program Files`, requiring elevation.

## Suspected and disproved (recorded so nobody re-opens them)

- **ripgrep missing.** `rg` is not on PATH, but the install bundles
  `@vscode/ripgrep-win32-x64/bin/rg.exe` and `fs-search` resolves it through that package, so
  `grep`/`glob` are unaffected.
- **The WSL launcher hijacking the harness itself.** `terminal-shells.ts` and `packages/shell`
  both skip `system32`/`windowsapps` when resolving `bash.exe`, so the harness's own discovery
  never selects WSL. Only *nested* invocations were exposed (Finding 2).
- **Third-party EDR / Defender ASR.** Only Microsoft Defender is present, no ASR rules,
  Controlled Folder Access off, system-wide process mitigations all NOTSET.
- **`%TEMP%/dsh-*` residue.** Not this repository's naming — its helpers use `ih-` and
  `i-harness-e2e-` prefixes; the origin was not established and nothing was deleted.

## Environment risks found and NOT changed

These are outside the source tree and change the machine's security posture, so they were left
alone deliberately:

- `~/.i-harness/credentials.json` stores the provider key in plaintext, and an unrelated
  tool's sandbox group on this machine holds an inherited ReadAndExecute ACE on the directory.
- `settings.json` is `sandboxMode: danger-full-access` with `approvalMode: full-access`, i.e.
  no sandbox and no prompt; `codeMode: mixed` and `plugins.subagentModel` are both enabled.
- The installed executable is unsigned and the app has no auto-update path.

## Evidence

- Finding 1 RED: the new provider-rule tests failed with `undefined` (rule absent) and the shell
  test failed showing the no-backend sentence where the real diagnostic belonged.
- Finding 1 GREEN: after the first correction the end-to-end model-facing refusal still nested
  two copies of the framing, so an exact-sentence assertion was added and failed on the nesting;
  `detail` on the error fixed it. Final refusal quotes the raw MSYS line once and escalates to
  `danger-full-access`.
- Finding 2 RED: both new PATH tests failed with `cmd.env === undefined`.
- Finding 2 GREEN: through the repository's own tools over a real `exec`, `where.exe bash` lists
  Git Bash first, `bash --version` reports `x86_64-pc-cygwin` and `bash -c uname` prints
  `MINGW64_NT-10.0-26200`, while the untouched-host-PATH control still prints `Linux`.
- Gates after both commits: `packages/sandbox` 40, `packages/exec` 41, `packages/shell` 67 (+1
  skipped), `packages/sandbox-windows-acl` 55; `e2e` 12 across 5 files; typecheck green for the
  four touched packages.
