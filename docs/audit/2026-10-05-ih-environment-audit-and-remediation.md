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
restricted token is NOT solved: `Everyone` is already in the restricting list and the create is
still denied, so the NPFS/named-pipe write path needs its own investigation. `README.md` in
`packages/sandbox-windows-acl` now records the measurement, the mechanism, and this boundary
instead of the previous "root cause 未調查".

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
