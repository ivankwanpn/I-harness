# DSH Windows Shell Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute each task with failing behavior tests, implementation, verification, and review.

**Goal:** Use DSH's native Windows Agent Shell default and preserve IH's confined-write behavior without privileged provisioning.

**Architecture:** Retain the existing restricted-token provider. Change only Agent Shell automatic Windows selection; retain explicit/terminal selections. Preserve native startup errors before best-effort cleanup.

**Tech Stack:** Existing TypeScript, Vitest, Koffi and Windows PowerShell; no dependencies added.

**Spec:** `docs/superpowers/specs/2026-10-05-dsh-windows-shell.md`

## Global Constraints

- No accounts, SYSTEM tasks, services, elevation, external-reference writes/ACL mutations, new Low labels, dependencies or publication.
- Existing read-only/workspace-write and per-call authority remain enforced; no unconfined retry.
- Windows auto preference: PowerShell 7 → Windows PowerShell → CMD → unavailable.
- Explicit choices, non-Windows choices, prepared identity and interactive terminal auto remain intact.

## Task 1: Agent Shell automatic Windows selection

**Files:** Modify `packages/desktop-gateway/src/agent-shell.ts`, test `packages/desktop-gateway/test/agent-shell.test.ts`.

**Interfaces:** Keep `createAgentShellSettings(path, environment)` and its state/resolve/configure signatures. Reuse detected `shellProfiles`; change only the automatic entry returned by the Agent settings adapter.

- [ ] Update the old automatic Git Bash expectation to the actual intended PowerShell command. Add cases for PS7 removal, Windows PowerShell removal, missing native shells, explicit Git Bash, unchanged terminal auto, and non-Windows auto. Register the generic shell using `settings.resolve` and assert its actual argv and powershell approval tokenization.

```ts
expect(settings.resolve()).toMatchObject({ id: "auto", command: "D:\\PowerShell\\pwsh.exe", dialect: "powershell" })
installed.delete("D:/PowerShell/pwsh.exe")
expect(settings.resolve().command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
```

- [ ] Run `node node_modules/vitest/vitest.mjs run packages/desktop-gateway/test/agent-shell.test.ts --maxWorkers=2` from root and record intended failures.
- [ ] Keep profile discovery, then replace Windows automatic entry using the detected native choices:

```ts
const automatic = available.find(option => option.id === "auto")
const native = available.find(option => option.id === "pwsh")
  ?? available.find(option => option.id === "powershell")
  ?? available.find(option => option.id === "cmd")
return available.flatMap(option => option.id !== "auto" ? [option]
  : native ? [{ ...native, id: "auto" as const, label: automatic!.label }] : [])
```

Apply that only when `env.platform === "win32"`; preserve all explicit options and validation closures. No saved setting migration is required.

- [ ] Repeat the focused test and existing shell prepared-identity tests; commit only the two task files. Submit exact RED/GREEN results and self-review.

## Task 2: Native error preservation and real PowerShell authority gate

**Files:** Modify `packages/sandbox-windows-acl/src/spawn.ts`; test `packages/sandbox-windows-acl/test/spawn.test.ts`; add `packages/sandbox-windows-acl/test/pwsh.e2e.ts`.

**Interfaces:** Preserve `spawnSandboxedInherited(api, token, options)` and the existing provider API. Capture its failing BOOL API's Win32 code immediately before restoring stdio inheritability.

- [ ] Add a fake binding test where CreateProcessAsUserW sets last-error 2 and returns 0; restoration sets last-error 6. Assert `Win32Error` reports API CreateProcessAsUserW/code 2. Run and record the intended RED.
- [ ] Immediately after create, before restoration:

```ts
const createError = created === 0 ? api.getLastError() : undefined
restoreInherit(stdIn)
restoreInherit(stdOut)
restoreInherit(stdErr)
if (created === 0) {
  api.closeHandle(job)
  throwWin32(api, "CreateProcessAsUserW", createError!, `command: ${options.command}, cwd: ${options.cwd}`)
}
```

- [ ] Add a real Windows PowerShell fixture gate, following existing win32.e2e ownership/provider/disposal patterns. Detect a real PS7 and/or Windows PowerShell executable using owned test environment. Create a workspace and outside baseline under a unique owned scratch directory. Use `Get-Content -LiteralPath ... -Raw -ErrorAction Stop` and `Set-Content -LiteralPath ... -Value ... -NoNewline -ErrorAction Stop`, with single-quoted PowerShell literals (escape embedded `'` to `''`). These cmdlets exercise real filesystem access under PS7 ConstrainedLanguage; do not change its language policy or select only PS5 to mask a selected-PS7 failure. In workspace-write assert inside write succeeds, outside write is caught/denied and outside bytes unchanged. On the same workspace with standing grants, read-only must deny inside and outside writes while outside read succeeds. Always dispose the provider. Set a finite native launch deadline; do not modify original references or earlier AppContainer fixtures.
- [ ] Run spawn unit tests, the PowerShell gate, then existing Windows multi-root/read-visibility/Job tests sequentially. Record outputs and commit only the three task files.

## Final verification and documentation

- [ ] Review both tasks against the spec with an independent task reviewer and one whole-branch review.
- [ ] Run desktop-gateway Agent Shell and terminal tests, shell tests, Windows ACL package tests, affected session sandbox tests, root typecheck and `git diff --check` once workers are idle. Broaden only for a concrete failure.
- [ ] Update the tracked audit/README with DSH Windows roster, ZCode's absent OS sandbox and the adopted scope. Record that the account/SYSTEM route was explicitly rejected and remains disabled. Preserve compatibility limitations accurately.
- [ ] Deliver local source and evidence. No push/release requested in this phase.
