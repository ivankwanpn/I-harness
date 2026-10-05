# DSH Windows execution adaptation

User rejected local-account/SYSTEM-task provisioning and authorized reuse of existing DSH/ZCode designs. Follow DSH's shipped Windows PowerShell selection while retaining IH's same-user restricted-token/ACL backend.

## Evidence and decision

DSH v0.1.7 `packages/bundle/base/cordis.patch.yml:234-242,266-272` disables Bash tools on Windows and chooses PowerShell. Its tests pin that roster. DSH's Windows token still uses `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`; its native tests explicitly expect piped Node descendants to be denied. ZCode's current executor says its resource sandbox was removed and uses ordinary spawn. Neither is a proved replacement supporting confined MSYS and every Node toolchain.

Adopt the usable DSH Windows default. Agent Shell `auto` prefers detected PowerShell 7, then Windows PowerShell, then CMD; if no supported native shell exists, report unavailable. This applies to Windows automatic selection across modes, giving model commands one predictable dialect. Explicitly selected Git Bash/other shells retain their executable and existing confinement refusal semantics. Interactive terminal auto-selection keeps its separate behavior. Linux/macOS automatic and explicit choices retain their behavior.

Preserve real read-only/workspace-write policy, per-call roots, private temp, and no unconfined retry. Do not replace OS enforcement with ZCode's approval checks. No local account, scheduled task, service, elevation, original-reference ACL edits, new Low labels, dependency additions, or release publication.

Native startup failures must preserve CreateProcessAsUserW's error code before inheritance restoration/handle cleanup can overwrite GetLastError. This is a small checked-error adaptation from DSH's process code, not a change to the token or authority.

## Acceptance

- On a Windows fixture with Git Bash and PowerShell, automatic Agent Shell resolves to PowerShell; the prompt, approval dialect and actual argv agree.
- Removing PS7 makes automatic selection use Windows PowerShell; removing both uses CMD. Only Bash available makes automatic selection unavailable rather than choosing a known-incompatible MSYS default.
- Explicit Git Bash selection still resolves to Git Bash. Terminal auto remains separately selected. Non-Windows auto still follows its original shell.
- A prepared command retains its approved executable if preferences change; subsequent calls read the new preference.
- A fake Win32 failure with code 2 followed by cleanup changing last-error to 6 must report code 2.
- Through the real IH Windows provider/runner, detected PowerShell reads an owned outside reference, writes only the current workspace in workspace-write, and is denied workspace/outside writes in read-only. Outside baseline contents remain unchanged.
- Existing Windows multi-root/revocation/read-visibility/Job tests and shell/gateway selection tests pass. Compilation/typecheck passes. No new Bash or piped Node compatibility guarantee is claimed.
