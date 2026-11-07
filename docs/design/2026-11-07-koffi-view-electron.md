# koffi.view crashes in the packaged Electron runtime

Status: **fixed 2026-11-07** (rc10). Found while testing the restricted sandbox modes.

## Symptom

In the rc9 Desktop, `read-only` and `workspace-write` sessions could not run any shell command: `shell`, `bash`
and `pwsh` all died with `outcome: "unknown"` and stderr:

    FATAL ERROR: Error::New napi_get_last_error_info
    ... napi_register_module_v1 ...
    JavaScript stack trace: bytes (startup-attributes.ts) -> prepareChildStartup -> prepare

`danger-full-access` was unaffected, and the CLI (plain Node) ran the same sandboxed commands fine.

## Root cause

The sandbox runner is spawned as `I-harness.exe --import tsx runner.ts ...` (Electron-as-Node). The ACL sandbox
zeroed native allocations through `new Uint8Array(koffi.view(pointer, size)).fill(0)` and read PROCESS_INFORMATION
through `koffi.view(slot, size)`. Minimal reproduction under the packaged executable:

    koffi.alloc('uint8', 64); koffi.view(p, 64)   // fatal NAPI abort under Electron

The same calls succeed under plain Node 24 with the same koffi 3.1.6.

## Fix

Both call sites now use `koffi.view` only outside Electron. Under Electron the allocations are already zeroed by
`koffi.alloc` (verified), and PROCESS_INFORMATION is read by decoding the live slot per read.

## Verification

* `sandbox-windows-acl` suite 382 passed / 5 skipped (unchanged baseline);
* rc9 with the fix: `read-only` pwsh returns `cond-ok`; `workspace-write` returns `ww-fix-ok`;
* Git Bash calls still fail with `SANDBOX_DENIED` in restricted modes (expected: bash.exe is outside the granted
  roots), while PowerShell works.