# IH absolute patch paths and rewind acceptance

Work in `D:/frontend-test`, `codex/desktop-workbench`, from `293a73e6`. User authorized repairing the backend path defect and asked for a DSH reference comparison. A separate Pi MCP/Code Mode/cache/compaction research request is documented [here](D:/frontend-test/docs/audit/2026-10-04-pi-mcp-codemode-cache-compaction.md); those research suggestions were not implemented in this patch.

## Cause and correction

`apply_patch` resolved input paths for filesystem operations but forwarded raw hunk paths into the workspace-relative rewind recorder. During an active turn, absolute Add/Update failed before writing; Delete caught the recorder's refusal and still deleted without a preimage. A wired but inactive recorder also caused Add to advertise `isNewFile` despite no capture.

The FS mount now adapts patch capture using the same `resolved target → default-workspace relative key` logic as write/edit. Model/UI result paths retain their original spelling. Each hunk's write guard still runs before capture or mutation. Permitted targets outside the default workspace remain outside its rewind journal. Add reports new-file capture only when the sink confirms it. Rewind's relative-path guard, scope and first-preimage rules are unchanged.

Production scope: [fs/index.ts](D:/frontend-test/packages/fs/src/index.ts:389) and [fs/patch.ts](D:/frontend-test/packages/fs/src/patch.ts:199).

## DSH comparison

Read-only reference was `D:/agent-complete/deepseek-harness-dsh-v0.2.0-rc.2`. Its filesystem provider distinguishes display path, resolved target identity and execution coordinates; the local provider derives canonical target identity, while write/edit observation and permission guards are separate. [Filesystem contract](D:/agent-complete/deepseek-harness-dsh-v0.2.0-rc.2/docs/subsystems/filesystem.md), [resolve/contains](D:/agent-complete/deepseek-harness-dsh-v0.2.0-rc.2/packages/fs/fs-local/src/index.ts:133), [tool consumer](D:/agent-complete/deepseek-harness-dsh-v0.2.0-rc.2/packages/fs/tool-fs/src/index.ts:63).

This supports separating input spelling, permission-checked target and journal key. That DSH suite exposes read/write/edit rather than IH's identical patch/rewind API; its code was not copied and its architecture was not transplanted. The IH repair stays at the existing FS-to-journal adapter.

## Fresh evidence

New [real-recorder tests](D:/frontend-test/packages/fs/test/fs-patch-rewind-real.test.ts) initially had **7 intended failures /4 passes**. After repair and test strengthening to use actual `sandbox-policy.checkWrite`, all **11 passed**:

- Three workspace absolute operations, including nested Unicode/spaced filenames, produce relative journal keys and are restored by the real RewindService.
- Three explicitly permitted secondary-root operations remain untracked by the default workspace journal.
- Three readonly-reference operations are refused before capture or mutation.
- Relative/absolute aliases share the earliest preimage.
- Inactive Add does not claim a recorded capture.

Full FS suite: **85/85 passed**. Full rewind suite: **72/72 passed**. Existing assembly rewind suite: **7/7 passed**. FS typecheck and a strict typecheck of the new test/import graph both exited0. One fresh independent source reviewer returned **READY, no concrete P1/P2 regression**.

## Copied packaged backend

Current portable rebuild shipped203 gateway packages. Owned proof `5430c17c-411c-499c-ad1c-97bab922a6d7` runs a copied Desktop executable with `ELECTRON_RUN_AS_NODE=1` and the shipped tsx loader/modules: **Electron44.4.5 /Node24.21.0**. Model steps are explicitly scripted offline fixtures; filesystem, sandbox policy, session assembly, recorder/store and restore service are actual shipped implementations.

It read a readonly reference outside the workspace, applied one absolute multi-file Add/Update/Delete in a real agent turn, persisted three relative journal entries with the required metadata, refused three outside reference mutation attempts, and executed a real rewind restoring both original files and removing the added file. Provider fetches were zero. The proof process exited0 and all owned work closed IDLE.

Five shipped source hashes (FS index/patch, recorder/path and assembly) match the current source; the proof loads the copied payload, not source-checkout imports. [Proof report](D:/frontend-test/.superpowers/sdd/2026-10-04-backend-patch-rewind/packaged-owned/5430c17c-411c-499c-ad1c-97bab922a6d7/report.json).

Two earlier harness attempts failed before operations: the Windows loader argument lacked a file URL, then generated fixture strings were incorrectly newline-escaped. Only the harness was corrected; product/artifact bytes did not change. Failed reports are retained and excluded from passing evidence.

## Complete verification

The first full run timed out in an existing Git binary/deleted preview test at5000ms and then failed temporary-directory cleanup while a handle remained. It reported70/71 projects; that partial run is not a passing result. The unchanged review suite then passed **13/13** in isolation. No production/test timeout, assertion, cap or allowlist was changed to pass it.

The subsequent complete `pnpm verify:all` finished:

| Gate | Result |
| --- | --- |
| Suite | **4515 passed,13 skipped,0 failed; exit0** |
| Population | **71 of71 projects reported** |
| Typecheck | **exit0** |
| E2E | **12 passed in5 files; exit0** |
| Reachability | **exit0, no new rows** |

[Initial failed log](D:/frontend-test/.superpowers/sdd/2026-10-04-backend-patch-rewind/verify-all.log), [complete passing retry](D:/frontend-test/.superpowers/sdd/2026-10-04-backend-patch-rewind/verify-all-retry.log). Existing platform/opt-in browser skips remain recorded; the Todo UI geometry was separately verified in its delivery. No further optional suites or source changes followed the successful gate.

## Delivery

- [Current portable ZIP](D:/frontend-test/packages/desktop/release-backend-rewind-fix-2026-10-04/I-harness-Desktop-0.1.0.zip)
- [Desktop EXE](<D:/frontend-test/packages/desktop/release-backend-rewind-fix-2026-10-04/I-harness Desktop/I-harness Desktop.exe>) — keep the adjacent resources.
- ZIP SHA256 `9960D89199CE46B8412503E39D9B1FD2F6E50D3E77013C4CA9BEF6C880256193`.

The original dirty `packages/desktop/electron.vite.config.ts` stays unchanged and unstaged at SHA256 `EDE81F84EE9571D43587EFEEC4970F5FB2F54C54E2B2E9EE7FCA7B029C6D8085`. Original reports, user sessions, settings, credentials and reference checkouts were not modified. Delivery is local.
