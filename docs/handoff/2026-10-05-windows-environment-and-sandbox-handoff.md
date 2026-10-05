# Windows environment audit, toolchain fixes, and the sandbox mechanism — handoff

**For:** a reviewer/continuer who is expected to verify this work and keep going.
**Branch:** `fix/env-audit-findings` (16 commits on top of `2b22e166`), 24 files, +1306/−58.
**Built artifact handed over:** `packages/desktop/release/I-harness-Desktop-Setup-0.1.1.exe`,
sha256 `f1ee29b028afc001e19c6afa9a5a18e3c875c58683da2ead12adb41b0d17d910` (132.2 MB) — matching
the `.sha256` file beside it and a fresh recomputation.

Everything below is either (a) measured on the host described in §1, or (b) explicitly labelled
as unverified. Where an earlier statement in this branch's own documents was wrong, it is marked
and superseded — a reviewer should be able to trust that pattern rather than hunt for it.

---

## 1. The host, and why it matters

| fact | value |
|---|---|
| OS | Windows 11 build 26200, x64 |
| CPU | 8 logical / 4 physical cores — a slow host, and several findings are its consequence |
| shell toolchain | Git Bash 5.3.15 (`C:\Program Files\Git`), Rtools absent, WSL **Ubuntu-24.04 present** |
| `node` on PATH | v22.23.2 (WinGet) |
| the harness's own runtime | Electron 44.4.5's bundled **node 24.21.0** — a *different* interpreter from the PATH one |
| installation under test | `C:\Program Files\I-harness Desktop`, v0.1.1, **unsigned**, installs a portable Electron payload; the gateway ships **TypeScript sources** run through `tsx` |

Two consequences that shape everything below:

1. **The install ships TS sources that run through `tsx`.** The installed gateway can be read and
   diffed directly, and it was byte-identical to the branch's HEAD (verified: 0 files exist only in
   the install; every content difference was a line ending — a SHA-256 pass first reported 68
   differing files and was a CRLF false positive, corrected by line-by-line comparison).
2. **Anything that spawns a process costs seconds here**, and the test suites' 5 s vitest default is
   frequently the thing that fails (§4).

## 2. The code fixes on this branch

Each entry: symptom → evidence → change → commit. Verification status is in §4.

### F1 — a confined MSYS child died silently; the refusal was unreachable (`9309cd38`)

An MSYS/Cygwin program (Git Bash, `usr/bin/ls.exe`, Rtools bash) cannot start under the
`WRITE_RESTRICTED` token: it dies inside DLL initialization with
`*** fatal error - couldn't create signal pipe, Win32 error 5` and status `0xC0000142`
(Node reads it back as unsigned `3221225794`). Native `cmd.exe`/`node.exe`/`git.exe` all exit 0
under the *same* token; both confined modes fail, so widening to `workspace-write` cannot help.

The runner starts fine and merely mirrors its child's status, so the provider's only failure rule
(exit 127 + `windows-acl-run: `) never matched, `exec` handed the caller a bare nonzero exit, and
the shell's legible refusal was unreachable. `e2e/sandbox.e2e.ts` could only *tolerate* this.

**Change**: a second `RunnerFailureRules` entry in the windows-acl provider, exit-gated AND
signature-gated (so a command that merely prints the signature, or a native program that dies in
DLL init for an unrelated reason, stays an ordinary failure). `SandboxUnavailableError` gained a
`kind` (`no-backend` vs `command-not-run`, because the two take **opposite** advice) and a `detail`
carrying the raw cause apart from its message. The shell's `command-not-run` refusal now quotes the
real diagnostic and names `danger-full-access`; the `no-backend` sentence is byte-for-byte
unchanged.

**Verified live on the installed build** by the user switching the session to `workspace-write`;
the `bash` tool then returned exactly:

```json
{"code":"SANDBOX_DENIED","surface":"shell","mode":"workspace-write",
 "reason":"the workspace-write sandbox could not run this bash command, so it was not run unconfined:
           0 [main] bash (22176) C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe:
           *** fatal error - couldn't create signal pipe, Win32 error 5",
 "escalation":"… retry it with sandbox_permissions set to \"danger-full-access\" …"}
exitCode: -1
```

with no false "no backend is usable on this host" claim anywhere.

### F2 — the non-bash shell surfaces left `bash` to the host PATH (`046d77df`)

`where.exe bash` lists `…\Microsoft\WindowsApps\bash.exe` — the WSL launcher — before any real
Unix shell, so a bare `bash` inside a `pwsh` command ran a **different filesystem**. Measured
through the live harness: the `pwsh` tool's `bash -c uname` printed `Linux` while the `bash`
tool's own child printed `MINGW64_NT-10.0-26200`. The PATH-shaping helper returned `{}` for every
executable that was not `bash.exe`, so the `pwsh` tool was never shaped and the `shell` tool only
when the Agent Shell happened to be bash. The helper was also untested.

**Change**: `shellCommandEnvironment` — a launched *bash* keeps its OWN directory (so an Agent
Shell deliberately set to Rtools/MSYS Bash is unaffected), every other shell gets the resolved
bash directory prepended **for that child only**, and nothing is prepended when no bash resolves;
global PATH is never touched.

**Verified**: through the repository's own tools over a real `exec`, `where.exe bash` now lists Git
Bash first, `bash --version` reports `x86_64-pc-cygwin`, `bash -c uname` prints
`MINGW64_NT-10.0-26200` — and the untouched-host-PATH control in the same run still printed
`Linux`.

### F3 — `code-retrieval` could not run on a fresh checkout (`b8d4b348`)

Three of its test files rooted `mkdtemp` at
`…/code-retrieval/.superpowers/sdd/2026-10-04-native-context-subsystems/<prefix>-`. That directory
is **gitignored** (`.gitignore:53`, `git ls-files .superpowers` = 0 entries), so it exists only
where a superpowers SDD session happened to run: on any clone, **3 files / 40 tests failed** at
setup with `ENOENT … mkdtemp`, and it was the ONLY failure in the first full `pnpm -r test` run.

The location was scratch space, not workflow output (each file hands the directory to the service
as its work root and removes it in `afterEach`; no test reads a spec file from it), so the roots
now sit under `os.tmpdir()` — the pattern `e2e/helpers.ts` already uses. **No assertion changed:
40 failed → 46 passed.**

### F4 — `session-executor` fixtures were rooted on the original developer's drive (`3b303779`)

`project-context.test.ts`, `scoped-exec.test.ts` and `search-code-mode.test.ts` built their fixture
parents from `D:/agent-complete/playground` — a path that exists only on the machine this
repository was developed on. `mkdtempSync` requires its parent to exist, so ~11 tests died at setup
on every other host.

**The parent cannot simply become `tmpdir()`**: `project-context.test.ts` carries the reason in its
own comment — *"The unrelated folder must be outside the platform temp grant"* — because the
runner's private temp lives inside `tmpdir()`, and a fixture rooted there would make the tests'
denial assertions vacuous. Each file now uses the branch its own POSIX arm already used and that CI
already trusts: `process.cwd()` for `project-context`/`scoped-exec`, `tmpdir()` for
`search-code-mode`.

Verified: **18 failed / 188 passed → 7 failed / 199 passed**, every `D:/agent-complete` ENOENT
gone. This change exposed a *side effect* worth knowing: with fixtures inside the package
directory, a test killed by a timeout never reaches its own cleanup and leaves directories in the
repo — which is what the two deadlines in the next entry fixed (verified: the working tree now
stays clean).

### F5 — spawn-heavy suites needed deadlines this host can meet (`4eb36b87`, `dc855311`)

Measured: a pwsh ConPTY takes **~5.7 s** to produce output here and the ripgrep-backed
`fs-search` file takes **4.8 s** alone (6.4 s beside one sibling package), against vitest's 5 s
default. `terminal.test.ts`'s pwsh test passes in **5706 ms** under `--testTimeout=60000`.

Two traps a continuer should know:
- **`Error: AttachConsole failed` is noise**, not a failure: it comes from node-pty's
  `conpty_console_list_agent` and appears in PASSING runs too.
- The bare name `pwsh` here resolves to the **real MSIX pwsh at PATH entry 0**, not to the
  `WindowsApps` execution alias — an earlier hypothesis in this branch that was wrong (§6).

Explicit deadlines were added to `terminal.test.ts` (helper default 15 s + a 30 s ceiling on that
test, matching the precedent in `workspace-cwd.test.ts`) and to `fs-search/test/bounded.test.ts`,
plus the two `session-executor` project tests whose cleanup was being skipped. **Every assertion
untouched.**

### F6 — the installer refused every elevated in-place update (`b3df189a`)

Running the v0.1.1 Setup over an existing `C:\Program Files\I-harness Desktop` install refused
with *"Uninstall the previous copy from Windows Apps or with its Uninstall.exe before using an
elevated installer…"*. That refusal is deliberate, and the NSIS source says why:

```nsis
; The old marker authenticates a location, not the executable bytes.
; Never promote an existing user-writable uninstaller to admin execution.
```

The upgrade flow runs the PREVIOUS `Uninstall.exe`; with an elevated setup that is admin execution
of a binary the marker does not authenticate, and an attacker who first installs per-user (the
documented default, which IS user-writable) and replaces that copy's uninstaller would gain
administrator code execution.

**Change**: an elevated update is allowed **only when the existing install sits under a
machine-wide root** (`$PROGRAMFILES64` / `$PROGRAMFILES`). There, the location IS a statement about
the bytes, because non-administrators cannot have written `$INSTDIR\Uninstall.exe` and the marker
lives in the same protected directory. Every other destination — including the per-user default,
the dangerous case — keeps the refusal verbatim. Matching is case-insensitive and
**separator-exact**: `C:\Program FilesExtra` does not match, and an empty root matches nothing.

**Boundary, stated rather than implied**: this assumes the stock Windows ACLs; a root an
administrator has loosened is outside the guarantee, and a signed build is what would restore it.
The "running app blocks update" fence, and the ownership/junction/conflict/leaf-name checks, are
unchanged.

**Evidence**: a new case in `packages/desktop/test/installer-destination.mjs` failed RED with the
exact refusal, then GREEN alongside the unchanged protection case and a separator-exactness case.
`installer-builder.test.ts` passes. The isolated harness drives the real flow without elevation by
substituting a synthetic root through a `MachineWideRoot` control in the test hooks.

**Confirmed on the real machine by the user**: the update ran against the real Program Files
install and succeeded — the ownership marker was rewritten to the new payload id
(`7133a3ae…` where the previous GitHub 0.1.1 had `566cafeb…`), `Uninstall.exe` was regenerated, the
app relaunched and the session resumed with settings/credentials/workspaces intact, and a full
file-set diff of the install against the packaged payload shows the payload copied completely plus
**exactly** the two installer-generated files (`.i-harness-desktop-install.ini`, `Uninstall.exe`)
with no stale files from the previous install.

### Documentation commits

`de5d112a`, `2b9f8e9c`, `31e2b45a`, `d4ab8a74`, `b9b18fcf`, `700bf192`, `7c19057d`, `3cd53187` —
these carry the audit document `docs/audit/2026-10-05-ih-environment-audit-and-remediation.md`,
the installer note `docs/audit/2026-10-05-desktop-installer-update-support.md`, and the sandbox
mechanism in `packages/sandbox-windows-acl/README.md`. **Two of them correct earlier claims in the
same branch** (§6).

## 3. The sandbox mechanism — the spike, and what it means

**Question.** Why does `WRITE_RESTRICTED` (whose restricting list already contains `Everyone`)
still refuse the pipe that an MSYS runtime needs? **Method.** Labelled throwaway probes, run
**in-process inside a real confined process** (so the measurements are that token's, not a model of
it), using `koffi` to call the Win32 APIs directly, plus process spawns through the repository's own
`spawnSandboxedInherited`. The probes were deleted; their recipe is in §8.

### 3.1 The pipe matrix (the decisive measurement)

| creation | `NULL` SA (token default DACL) | DACL = `Everyone` GA | DACL = **user only** | DACL = `Administrators` |
|---|---|---|---|---|
| `CreatePipe` (**anonymous**) | ✅ | ✅ | ❌ **error 5** | ❌ **error 5** |
| `CreateNamedPipeW` (named) | ✅ | ✅ | ✅ | ✅ |

Success and failure track **exactly** whether the explicit DACL names a SID that is also in the
restricting list (`Everyone` is; the user SID is not). So `WRITE_RESTRICTED`'s pass-2 check applies
to **anonymous** pipes and not to named ones, and it fails precisely when the explicit DACL names
no restricting SID. This refutes the first story this branch wrote (a named-pipe/NPFS denial).

### 3.2 The root-cause chain

1. Under the restricted token, **the child cannot adjust its own token**: Cygwin's
   `cygheap_user::init` calls `NtSetInformationToken(TokenDefaultDacl)` and gets
   **`0xC0000022`** (STATUS_ACCESS_DENIED) — the token object's own DACL names no restricting SID,
   so the write is refused by the same pass-2 rule.
2. It then creates its anonymous pipe with a security descriptor that names none either →
   **error 5**.

`msys-2.0.dll` **builds no security descriptor itself** (zero references to the SD-construction
APIs, no SDDL literals; six `SECURITY_ATTRIBUTES` uses, three `CreatePipe` uses) — it passes a
statically compiled one. Since the `Everyone` form SUCCEEDS, Cygwin's SD cannot be an Everyone
grant; it must name the user/creator. The provider's existing `setTokenDefaultDaclGrant` cannot
reach that case, because it only affects objects created **without** an explicit SD.

### 3.3 Four tokens, measured end to end

Same plumbing, `bash -c 'echo …; uname -s'`:

| token | bash | node `child_process` spawn | write to a medium-integrity path |
|---|---|---|---|
| `DISABLE_MAX_PRIVILEGE｜LUA_TOKEN｜WRITE_RESTRICTED` (**today**) | ❌ `0xC0000142` | ❌ **EPERM** | refused ✓ |
| the same, **without** `WRITE_RESTRICTED` | ❌ loader failure | ❌ `0xC0000135` (DLL not found) | — |
| the same, **plus** a Low integrity label | ❌ **identical failure** | ✅ | — |
| **no restricted token at all; only Low integrity** | ✅ **`MINGW64_NT-10.0-26200`** | ✅ **`NESTED_OK`** | ❌ **DENIED** ✓ |

Three conclusions:

1. **The restricted token itself is the obstacle, not the pipe.** Adding a Low integrity label to
   the existing token changes nothing, because failure ① above is unaffected by labels.
2. **`WRITE_RESTRICTED` is not optional here.** Its documented effect is to relax the
   restricting-SID check to *writes only*; without it the restricting SIDs apply to **all** access,
   which is why `node` installed under `%LOCALAPPDATA%` (whose DACL names no `Everyone`) dies with
   `0xC0000135`. A previous note in this branch described the flag only as "the sandbox's core
   mechanism" — that is incomplete and now corrected in the package README.
3. **A demonstrated replacement exists**: a token with **no restricting SIDs** whose integrity
   level is merely lowered to **Low** runs MSYS, keeps no-write-up write isolation (a write to a
   medium-integrity path was DENIED and nothing landed on disk), **and** fixes the toolchain
   problem below — a node `child_process` spawn with pipes succeeds where the restricted token
   returns EPERM.

### 3.4 The toolchain consequence (practical, easy to miss)

Under the restricted token, **any node toolchain that spawns a child fails with `EPERM`** when the
child uses piped stdio (`inherit`/`ignore` work): `spawnSync`, `execFileSync`, `execSync`, and
async `spawn` — which breaks `tsx`/esbuild, vitest, npm scripts, and therefore most of the repo's
own tooling *while a confined mode is active*. Native programs are fine (`cmd /c "echo x |
findstr x"` succeeds), so the failure is specific to how libuv creates the pipes. **The libuv side
was not investigated** — the mechanism there is unproven; only the shape is measured.

### 3.5 Recommended next steps (not done)

1. Prototype a **Low-integrity backend**: duplicate the process token, lower it to Low, and label
   the workspace + private temp (and any other writable root) low — replacing capability-SID ACE
   grants with labels. Then re-run this branch's sandbox e2e suites against it.
2. Design the **grant model change** honestly: labels are a single global level, not per-directory
   grants, so today's "which paths are writable" becomes "which paths are lowered"; objects a low
   process creates inherit the low label.
3. Re-check the documented read-side boundary. Low IL does not give no-read-up by default, so the
   existing "reads are not restricted" statement probably survives — **unverified**.
4. AppContainer (S-1-15-2) was **not** tested at all.

## 4. Verification status

**Green on this host, every run:** `pnpm typecheck`, `scripts/audit/check-thresholds.mjs`,
`pnpm verify:reachability`, `pnpm e2e` (12 tests / 5 files), `packages/sandbox` (40),
`packages/exec` (41), `packages/shell` (67 + 1 skipped), `packages/sandbox-windows-acl` (55),
`packages/code-retrieval` (46), `packages/terminal` (47), `packages/fs-search` (46), and the
installer harnesses `installer-destination` and `installer-builder.test.ts`.

**`pnpm -r test` is red on this host in four packages, and NONE of it is caused by this branch.**
Measured by running all 73 packages one at a time: 69 pass, 4 fail — and those four fail alone
too. An A/B reverting only this branch's `src` files reproduced **identical** counts:

| suite | base `src` | this branch's `src` |
|---|---|---|
| `session-executor` | 18 failed / 188 passed | 18 failed / 188 passed |
| `desktop-gateway` | 7 failed / 294 passed | 7 failed / 294 passed |
| `guard-approval` | 1 failed / 99 passed | 1 failed / 99 passed |
| `desktop` | 18 failed / 668 passed | 18 failed / 668 passed |

Their causes are three different things, and only one is a test-hygiene issue this branch fixed:
host paths (F4 — now 7 failed), genuine assertion failures, and deadlines. Specifically still red:
`session-executor`'s `search-code-mode` **exceeds its own 15 s deadline** (a hang signal, deliberately
NOT papered over with a bigger number), `native-context-*` failures that come and go between runs,
and 5 s/15 s timeouts in suites that hash a shipped-size image or drive a PTY.

**A methodology correction a continuer must know.** The first five full runs of this branch used
`pnpm -r test` WITHOUT `--no-bail`, so pnpm **bailed at the first failing package** and the
remaining ~60 never ran. "The failing test keeps moving" was largely that artifact, and a
conclusion built on it — that raising a deadline must therefore be wrong — was wrong with it. The
repository's own `pnpm test` (which does pass `--no-bail`) yields the real figure
`Summary: 4 fails, 69 passes`, identical in parallel and serial mode.

**Not verified anywhere:** a real elevated upgrade had to be executed by the user (§2 F6 — done and
confirmed); the A1 refusal was likewise confirmed only by the user switching sandbox modes; the
Low-integrity prototype in §3.3 was measured with throwaway probes, not implemented; `installer:test`
fails here, identically with this branch's NSIS changes stashed (`ETIMEDOUT` at its hard-coded
45 s budget while copying the complete payload — pre-existing host slowness).

## 5. Open items for the continuer

1. **Implement (or reject) the Low-integrity backend** (§3.5) — the highest-value item; it is the
   one change that would make confined mode genuinely usable on Windows.
2. **`session-executor`'s two `search-code-mode` tests that exceed their own 15 s deadline.**
   Suspect a real hang (they drive `code_exec`/code-mode searches), not slowness.
3. **The intermittent `native-context-*` failures** (`native-context-lifecycle` expecting a
   `ctx_…` reference, `native-context-output`'s retention callback, `code-mode-store`'s
   `status: 'completed'`, `desktop-gateway`'s `native-context-host` `state: 'ready'`) — they appear
   and disappear between runs, which is itself information: they are the newest feature and the
   most likely place for a real bug.
4. **Decide the aggregate-test-timeout policy.** Raising one test's timeout is not enough (the
   victim moves); either give the spawn-heavy suites explicit deadlines as F5 did, or set a
   repository-wide default, or declare the aggregate gate unusable on 4-core hosts. This is a
   policy decision, not a per-file patch.
5. **Version bump.** The Setup EXE is still `0.1.1`, so the update is distinguishable only by
   hash/date. If the next release should be tellable apart in the app's About pane, bump
   `packages/desktop/package.json` and rebuild the payload (the builder enforces payload version ==
   source version).
6. **Code signing** remains absent, which is also the only real fix for the installer's fence
   boundary (§2 F6).

## 6. Corrections made in this branch — do not re-open these

1. ~~"The MSYS signal pipe is a NAMED pipe denied at the NPFS layer."~~ **Wrong.** Named pipes
   succeed under every explicit DACL tried; the failure is the anonymous pipe's pass-2 DACL check
   (§3.1). Corrected in `7c19057d`.
2. ~~"The terminal test fails because the bare name `pwsh` resolves to the untrusted WindowsApps
   execution alias."~~ **Wrong.** It resolves to the real MSIX pwsh at PATH entry 0; the test was
   slow (5706 ms) against a 5 s default, and the `AttachConsole failed` line is node-pty agent
   noise present in passing runs too.
3. ~~"A confined process cannot spawn a child at all (EPERM)."~~ **Incomplete.** Native programs
   can (`cmd | findstr`, file redirection); *node/libuv* cannot while the token is restricted —
   and it can again under a Low-integrity token (§3.3, §3.4).
4. ~~"`pnpm -r test` only fails on the first package, so a deadline fix must be wrong."~~ **Wrong
   method** — see §4; the runs were bailing early.
5. ~~"ripgrep is missing."~~ `rg` is not on PATH, but the install bundles
   `@vscode/ripgrep-win32-x64/bin/rg.exe` and `fs-search` resolves it through that package, so
   `grep`/`glob` are unaffected.
6. ~~"The harness's own bash discovery selects WSL."~~ It skips `system32`/`windowsapps`; only
   *nested* invocations were exposed (F2).
7. Third-party EDR, Defender ASR, and process mitigations were all checked and are not involved
   (only Microsoft Defender, no ASR rules, Controlled Folder Access off, mitigations NOTSET).

## 7. Artifacts and how they were built

The two build prerequisites were **not** present on this host and were staged into gitignored
build directories: the **electron 44.4.5 binary** (the package declares no `postinstall`, so pnpm
never fetched it — `node node_modules/electron/install.js`) and **NSIS 3.11** (the DESKTOP
installer does not download it, unlike `scripts/build-installer.mjs`; it was staged to
`build/tools/makensis/`, the path that script probes).

```
pnpm --filter @i-harness/desktop dist
pnpm --filter @i-harness/desktop installer -- --nsis <repo>/build/tools/makensis/makensis.exe
```

Outputs in `packages/desktop/release/`: `I-harness-Desktop-Setup-0.1.1.exe` (132.2 MB) + `.sha256`
+ `.installer-build.json`, and the portable `I-harness-Desktop-0.1.1.zip` (206 MB). Payload: 7951
files / 577,121,250 B, `payloadId` `7133a3ae…`, payload exe `bd14928e…`. The digest is the one
recorded in the header of this document and in the `.sha256` file; re-hash before relying on it.

## 8. How to reproduce the sandbox measurements

The probes were throwaway (deleted), but the recipe is small and worth repeating exactly:

1. Run **inside** a confined process — it is easier than sandboxing a child: start any tool call
   while the session's sandbox mode is `read-only`/`workspace-write`, and the process you are in
   already holds the restricted token (`TokenHasRestrictions = 1`; verify with
   `GetTokenInformation(TokenHasRestrictions=21)`).
2. Bind `CreatePipe` and `CreateNamedPipeW` with `koffi` (they are NOT in the package's FFI — only
   `CreatePipe` is), and call each with: `NULL` security attributes, an explicit DACL granting
   `Everyone`, one granting only the user SID, and one granting `Administrators`. Compare the
   `GetLastError()` values.
3. For the token comparison, build each token and run the target through the repository's
   `spawnSandboxedInherited` + `waitForExit` (`packages/sandbox-windows-acl/src/{token,spawn}.ts`),
   which is the same plumbing the runner uses. Build the Low-integrity variant with
   `OpenProcessToken` + `DuplicateTokenEx(TokenPrimary)` + `SetTokenInformation(
   TokenIntegrityLevel, S-1-16-4096)` — **no** `CreateRestrictedToken` at all.
4. Judge write isolation and nested spawning from inside the child: write to a medium-integrity
   path (expect DENIED) and call `child_process.spawnSync` with piped stdio (expect EPERM under the
   restricted token, success under Low).
