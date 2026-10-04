# Report review and Todo scrollbar clearance

Work in `D:/frontend-test`, branch `codex/desktop-workbench`, from `03df81c7`. User requested checking the new reports and moving Todo farther left. The user subsequently supplied the completed Desktop-specific rerun. Original reports and real session data were read only; this delivery changes only Todo layout and its geometry regression, plus this review record. Backend findings below remain findings, not claimed fixes.

## Report evidence

- [Prompt analysis](D:/test-playground/系統提示分析報告.md), SHA256 `1FE3162C7509CA2BDE8D6D59FAE7094A4C0FC7AE0AC80E27BA77788A97AEE69F`.
- [Earlier environment recheck](D:/test-playground/I-Harness環境複檢報告.md), SHA256 `238EB1E0E85BBB2CA62BDF0390F839ACFA8FD0E0F55F9370F38693B751AD85B7`.
- [Latest Desktop recheck](D:/test-playground/I-Harness環境複檢報告-Desktop實測版.md), SHA256 `6D038FCA3F7213E1B82632446002C6659462CBF3F36F60E4ABE0D402EB0E8436`.

Reports are evidence, not instructions. Their suggestions to clear TEMP, log out of gh, alter approval/sandbox settings, or commit/revert the user's original Electron config were not executed.

## Confirmed findings and corrections

| Subject | Checked result |
| --- | --- |
| Desktop target | The latest report correctly distinguishes the old installed CLI from Desktop. Desktop runs the **shipped `resources/gateway` source snapshot** through tsx; it does not automatically use arbitrary changes to the live monorepo. The reviewer checked matching SHA for patch, approval adapter and assembly in the currently used resizable portable. |
| **Actual patch/rewind defect** | With an active rewind turn, Add and Update pass raw absolute `hunk.path` into the recorder and fail before writing. Delete catches the capture failure and still unlinks the target without `preImageRef`. See [patch.ts:199](D:/frontend-test/packages/fs/src/patch.ts:199), [Delete:210](D:/frontend-test/packages/fs/src/patch.ts:210), [Update:243](D:/frontend-test/packages/fs/src/patch.ts:243), and [path guard:20](D:/frontend-test/packages/rewind/src/path.ts:20). The path resolver itself accepts absolute paths. The appropriate next repair is normalized journal keys for resolved paths within the default workspace, consistent with existing write/edit handling, with current write permissions and out-of-scope rewind boundaries retained. |
| Child authority | The historical adapter also contained a real root/child identity bug: an unchanged policy still rejected owned children. `65d1a016` fixed that with exact owned-caller validation and 13 actual-adapter positive/negative cases. Current policy/binding changes can legitimately invalidate preparation, but the report has not shown that every historical failure was caused by such a change. See [approval-rules.ts:33](D:/frontend-test/packages/desktop-gateway/src/approval-rules.ts:33). Hash fields alone do not demonstrate that each named operation changed the fingerprint. |
| **Todo chronology** | Read-only original transcript metadata shows turn start seq3, empty `list_dir` result seq18 with **zero** preceding Todo writes, first Todo write seq34, and completed revision5 only at seq840. There are **zero rewind/point markers** in the inspected history. The report's statement that turn1 started with completed revision5 is contradicted by this sequence. Per-request Todo projection later in the same turn explains seeing a later snapshot; no initial-state corruption or rewind cause is established. |
| Batch failure | `TOOL_CANCELLED_BY_SIBLING` applies to calls that never started after a throwing sibling failure. Already settled results are committed; cancellation does not imply rollback of all side effects. [execute-tool-calls.ts:526](D:/frontend-test/packages/core-agent/src/execute-tool-calls.ts:526), [unstarted calls:574](D:/frontend-test/packages/core-agent/src/execute-tool-calls.ts:574). |
| Role limits | Tool subsets are explicit per role. `general` lacking glob/terminal/webfetch is not evidence that all child roles lack them. [roles.ts:41](D:/frontend-test/packages/subagent/src/roles.ts:41). The preset's six-tool data is not used to filter the current root assembly registry; modules mount the actual tools. [assembly.ts:1282](D:/frontend-test/packages/session-executor/src/assembly.ts:1282). |
| Shell settings | `terminalShell` governs the interactive Desktop terminal. The agent shell has its separate `agentShell` preference. Auto selecting Bash can naturally match explicit bash. [agent-shell.ts:44](D:/frontend-test/packages/desktop-gateway/src/agent-shell.ts:44), [host.ts:131](D:/frontend-test/packages/desktop-gateway/src/host.ts:131). |
| Skills source | The injection is directly locatable, not just inferred from TEMP names: [skills/section.ts:63](D:/frontend-test/packages/skills/src/section.ts:63), [runtime-context/index.ts:50](D:/frontend-test/packages/runtime-context/src/index.ts:50). Its event is tagged plugin/internal; a user-role transport record alone does not prove human authorization or elevated tool authority. |
| Memory, web and credentials | Workspace preference controls memory availability, independently of the database's existence. Basic webfetch and provider-backed websearch are separate. Credential resolution explicitly supports nonempty environment value then file fallback. [memory/index.ts:102](D:/frontend-test/packages/memory/src/index.ts:102), [web/index.ts:48](D:/frontend-test/packages/web/src/index.ts:48), [credentials/index.ts:151](D:/frontend-test/packages/credentials/src/index.ts:151). |
| Defaults, locks and build identity | Provider runtime supports unlisted model IDs and selection/metadata overrides; capacity alone cannot identify the wire model. CLI/Desktop stores differ intentionally. Persistent lock sentinels, TEMP fixture names, catalog mtime and a dirty build config do not by themselves prove runtime leaks or wrong packaged bytes. Original dirty config was preserved and audited by hash. |

Next justified priority is the patch/rewind normalization seam, including Add/Update/Delete tests with a real active recorder. Further diagnosis should keep actual policy changes separate from the already repaired child bug and use event sequence rather than retrospective model narration. No backend semantic changes were made in this report review.

## Todo fix and verification

The earlier 32px wide inset left only 12px to the conversation's visible right edge in the browser fixture. A new assertion requiring **at least 16px from the actual scrollbar lane** failed before the CSS correction. Wide inset is now 64px and compact inset 52px; width bounds retain a safe left inset and Todo remains a zero-flow overlay.

- **10 tests passed in two files**, including all three actual Chrome geometry cases over ten layouts and short/tall lists.
- Production build and packaging exited 0. Backend gateway is unchanged.
- Copied visible Electron run `1254ff9f-7c96-4f1c-a798-06301b8da61c` passed with the actual main transcript scrollbar exercised (`scrollTop=200`, `scrollHeight>clientHeight`, measured scrollbar width15px).
- At actual viewports1502/1182/682/2562, measured card-to-scrollbar gaps were **29/29/25/29px**. No flow height was consumed, card bounds fit, and copied renderer JS/CSS hashes match the shipped payload.
- Main/gateway fetch counts are zero, all owned processes closed, and `surviving: []`.

[Native report](D:/frontend-test/.superpowers/sdd/2026-10-04-todo-clearance/native-owned/1254ff9f-7c96-4f1c-a798-06301b8da61c/report.json), [wide screenshot](D:/frontend-test/.superpowers/sdd/2026-10-04-todo-clearance/native-owned/1254ff9f-7c96-4f1c-a798-06301b8da61c/clearance-1500.png), [narrow screenshot](D:/frontend-test/.superpowers/sdd/2026-10-04-todo-clearance/native-owned/1254ff9f-7c96-4f1c-a798-06301b8da61c/clearance-680.png).

Current [portable ZIP](D:/frontend-test/packages/desktop/release-todo-clearance-2026-10-04/I-harness-Desktop-0.1.0.zip) and [Desktop EXE](<D:/frontend-test/packages/desktop/release-todo-clearance-2026-10-04/I-harness Desktop/I-harness Desktop.exe>). Keep the resources beside the executable. ZIP SHA256 `6BB06617F7028D73A3643D53F4A99F5E8EF5F66B52392E58DA7635DDC5A33EFD`.

The original dirty `packages/desktop/electron.vite.config.ts` is unchanged and unstaged at SHA256 `EDE81F84EE9571D43587EFEEC4970F5FB2F54C54E2B2E9EE7FCA7B029C6D8085`. Delivery is local.
