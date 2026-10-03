# IH Desktop navigation and approval acceptance

## Current correction: retain the original header toggle

The current [portable ZIP](D:/frontend-test/packages/desktop/release-navigation-toggle-fix-2026-10-04/I-harness-Desktop-0.1.0.zip) and [Desktop EXE](<D:/frontend-test/packages/desktop/release-navigation-toggle-fix-2026-10-04/I-harness Desktop/I-harness Desktop.exe>) supersede the earlier `release-navigation-polish-2026-10-04` download. The earlier build had an extra rail sidebar toggle in addition to the original header button.

From `626637c8dc493460da088c138ca850e95e7e2a1c`, the correction removes the rail button, its unused icon/props and its unused translation. The original header button labelled **顯示側欄** remains. The 48px rail, other actions, fixed Settings gear, project tree and approval implementation are unchanged.

Fresh scoped verification passed **28/28 existing navigation/workbench/narrow tests**, Desktop typecheck exited **0**, renderer/attachment build exited **0**, and packaging exited **0** with the unchanged shipped gateway runtime. No new mirror test or CSS change was added. The 4443-test full gate below is historical verification of the previous commit; it was not rerun for this minimal removal.

Actual copied visible native run `21bcf60c-257c-4ffe-bd81-0b1e7af528e6` passed the finite correction probe at requested widths1500 and680 (actual clients1502 and682). Both widths reported **one header toggle, zero rail toggles, one total PanelLeft button and zero duplicate-label buttons**. Original-header mouse/Enter collapse and expansion worked; narrow Escape restored header focus. The same selected session and tree node survived, the unsent draft remained, and Settings opened through the rail with its gear y829.600 unchanged. The app, server and captured processes closed **IDLE**, with `surviving: []`, **zero provider POSTs and zero renderer exceptions**. Root inspected and accepted the new [wide collapsed screenshot](D:/frontend-test/.superpowers/sdd/2026-10-04-desktop-navigation-polish/toggle-native-owned/21bcf60c-257c-4ffe-bd81-0b1e7af528e6/toggle-collapsed-1500.png) and [narrow collapsed screenshot](D:/frontend-test/.superpowers/sdd/2026-10-04-desktop-navigation-polish/toggle-native-owned/21bcf60c-257c-4ffe-bd81-0b1e7af528e6/toggle-collapsed-680.png).

Current ZIP SHA256: `4505E5CC3909932C2A144023E25D1A5BD2498F2AC3C6164B12EC6D782476C079`. Native report SHA256: `97FA2AA94B3B38B8168327C0B9852D5F1C1DDE4D8E846EAD9B83A330AB10FC2D`. Actual RPC observations SHA256: `AEB66129248D2911A54CBD6F2B0CE66CA4D822C17EECC89ACF847303142D2855`. Current proof files are retained in `.superpowers/sdd/2026-10-04-desktop-navigation-polish/` with `toggle-` prefixes. Version remains0.1.0, Electron44.4.5/Node24.21.0. The original dirty config remains unchanged/unstaged at the SHA recorded below; local delivery only.

## Original delivery record

The following records the preceding verification on 2026-10-04 (Asia/Hong_Kong) in `D:/frontend-test`, branch `codex/desktop-workbench`, from `5c2bb19b3fdfe80f29215084951b7d0ac29c790d` to `626637c8dc493460da088c138ca850e95e7e2a1c`. It is retained as historical evidence for the broader navigation and approval correction.

## Delivered behavior

- Composer always offers the existing four approval modes: dangerous, ask-all, delegate and full-access. Dangerous is labelled **僅危險操作詢問**, matching Settings, and can be selected from every other mode. Existing settings save/effective authority, rejected saves, serialized changes and workspace replacement handling remain in place. Composer changes only `approvalMode`; the backend continues to determine effective permissions and sandbox state.
- The expanded sidebar has a fixed brand and action header. Only the project, workspace and session tree scrolls. The same tree stays mounted during collapse and Settings/Projects navigation, preserving expansion, selection and its scroll element.
- A permanent 48px icon rail remains on expanded, collapsed, Settings and Projects surfaces. It provides available New conversation, Open workspace, project management, plugin and session-search actions. Actions depend on their existing callbacks and capabilities. The original header now owns the only sidebar toggle.
- The bottom rail gear directly opens Settings. There is one live Settings entry and no avatar, account or login surface. Standalone sidebar components retain an optional gear footer for their existing consumers.
- The narrow drawer retains modal focus, Tab wrapping, Escape dismissal and focus restoration. Its temporary state does not change the desktop collapse preference. The sandbox selector remains in Settings.

## Reproduction, review and focused checks

An actual copied, visible baseline app reproduced the full-sidebar scroll, absent collapsed rail and three-choice approval menu in owned run `6b6c759f-a256-49ab-881d-3dd968e2e718`. It closed with `IDLE`, no survivors and zero provider POSTs.

Before the Composer change, all three regression cases for dangerous selection from ask-all, delegate and full-access failed. The new rail behavior cases also failed against the old implementation. After the correction, the focused five-file run passed **48/48** tests, and Desktop typecheck exited **0**. The focused scope includes Composer authority/rejection/serialization, keyboard portal behavior, retained drafts, tree preservation and real rail routing. Existing global button queries were scoped to the project pane or narrow dialog where the permanent rail exposes the same action.

One independent read-only source review returned **READY with no concrete findings**. The root reviewer inspected current expanded/scrolled, collapsed, Settings, four-choice approval and narrow screenshots and accepted their geometry. Both implementation workers and the reviewer were idle before the complete gate.

## Original portable artifact and native evidence (superseded download)

Distinct artifact: [portable ZIP](D:/frontend-test/packages/desktop/release-navigation-polish-2026-10-04/I-harness-Desktop-0.1.0.zip), with runnable [Desktop EXE](<D:/frontend-test/packages/desktop/release-navigation-polish-2026-10-04/I-harness Desktop/I-harness Desktop.exe>).

The portable build exited **0** and shipped **203** gateway packages. Product version is **0.1.0**. The copied native app reported Electron **44.4.5**, Node **24.21.0**, its owned executable/resource paths, a fresh owned `IH_CONFIG_DIR` and fresh userData. Runtime and renderer assets were hashed and compared with the delivered package, including the shipped reader/engine and Windows rg assets. The Electron main hash is unchanged at `B5207EDDCF7BE3527564ACF103D5E1BAEE09BC2A2111BBFF46E7E92458F7F3C6`; this correction changes renderer behavior.

ZIP SHA256: `DA4353494A7983D01A1DB42B69DAC56D99D8B6EF1DF2E970B19C0B049448F439`.

Final visible native run `a1a69aa2-203b-4432-ac99-8286a7374c6e` passed the complete finite correction probe. Its fixture used **27 real projects and 7 real sessions** in an owned workspace. The original native IPC handler forwarded each request and response unchanged; observations are saved in `native-rpc.json`. No model prompt was submitted, no provider POST occurred, and there were **0 renderer exceptions**. The copied app, server, gateways and captured children closed; the process inventory returned `IDLE` and `surviving: []` before the gate.

| Native observation | Actual result |
| --- | --- |
| Brand before/after tree wheel | y20 / y20 |
| Bottom gear before/after tree wheel | y829.600 / y829.600 |
| Tree scroll |791.200px; clientHeight632 / scrollHeight1423 |
| Whole sidebar scroll |0 |
| Collapsed rail |48px; visible controls contained and hit tested |
| Dangerous selected from ask-all, delegate, full-access |One actual configure each, patch exactly `{approvalMode:"dangerous"}`; saved and effective both dangerous |
| Draft and submit control |Unsent text retained; exactly one primary Send; New conversation opens a draft without creating a session |
| Settings, Projects, plugins and search |Opened through real rail actions; Settings also opened with keyboard Enter |
| Narrow drawer |Initial focus, both Tab wraps and Escape focus restoration passed; desktop preference unchanged |
| Approval menu |Four radio rows, body portal, keyboard End/Escape and row/window-control hit tests passed at all widths |
| Sandbox UI |Zero selectors outside Settings; one Settings sandbox combobox |

The frameless Windows window exposed a client width 2px above each requested native bound; the following are the actual inner measurements, rather than assuming the requested bounds equal CSS pixels. All measured inner controls fit their pane.

| Requested native width | Actual viewport/document width | Center client/scroll width | Composer client/scroll width |
| --- | --- | --- | --- |
|1500 |1502 /1502 |1204 /1204 |720 /720 |
|1180 |1182 /1182 |884 /884 |720 /720 |
|680 |682 /682 |624 /624 |600 /600 |

Current screenshots include [scrolled tree](D:/frontend-test/.superpowers/sdd/2026-10-04-desktop-navigation-polish/native-owned/a1a69aa2-203b-4432-ac99-8286a7374c6e/03-scrolled-tree.png), [collapsed rail](D:/frontend-test/.superpowers/sdd/2026-10-04-desktop-navigation-polish/native-owned/a1a69aa2-203b-4432-ac99-8286a7374c6e/04-collapsed-rail.png), [four approval choices](D:/frontend-test/.superpowers/sdd/2026-10-04-desktop-navigation-polish/native-owned/a1a69aa2-203b-4432-ac99-8286a7374c6e/09-four-approval-choices.png), [narrow approval](D:/frontend-test/.superpowers/sdd/2026-10-04-desktop-navigation-polish/native-owned/a1a69aa2-203b-4432-ac99-8286a7374c6e/11-approval-680.png) and [narrow Settings](D:/frontend-test/.superpowers/sdd/2026-10-04-desktop-navigation-polish/native-owned/a1a69aa2-203b-4432-ac99-8286a7374c6e/13-narrow-settings.png).

Two earlier native harness runs remain recorded as **failed**: `6cdf193a-787a-44a9-9e76-d5ec1d0544f6` used the textbox role for an existing search input, and `d8fad95b-6451-4417-9693-bf155a643a51` assumed the requested native width exactly equalled the client width. The locator and settle assertion were corrected, with actual geometry still reported. Product source and artifact bytes did not change between those runs and the final passing run. Each failed run closed `IDLE`; none is counted as a complete pass.

## Original complete gate and parity (historical)

After source, artifact and native proofs were frozen and all owned processes were idle, **`pnpm verify:all` ran alone and exited 0**:

| Gate | Completed result |
| --- | --- |
| Recursive suite |4443 passed,10 skipped,0 failed; exit0 |
| Population |71 of71 projects with tests reported |
| All-project typecheck |exit0 |
| E2E |12 passed in5 files; exit0 |
| Reachability |exit0, no new rows;420 current,36 baseline rows gone |

The two existing inert reachability allowlist warnings remain; no allowlist, cap or timer was changed. The full gate also reported Desktop **650 tests in111 files**. The previous 4437-test result is historical and was not reused. No product source changed after the successful build/native freeze; the acceptance document was written after the new gate. The exact source/artifact freeze is retained at `.superpowers/sdd/2026-10-04-desktop-navigation-polish/source-artifact-freeze.json`.

Evidence SHA256 values:

- Native report, including geometry: `55ABA8CA5F53ED39C4A54E01BE601823F6A6B5503535B6583A2363356E7F208D`.
- Actual native RPC observations: `88BCDF75ECEC4BB2C919A735E1BC53C50ED6BD8563543BC7196C919B78AC1A71`.
- Final native harness: `F81D2A9EA1251DDCCD78DA7F1452B13C645732F0FA2138795B789CF3891499C9`.
- Complete gate log: `41D7E675B2ACB68EB6D8B616414156D865C14FAD79FD31F7B3AD7735ED80F92E`.

The original dirty `packages/desktop/electron.vite.config.ts` remains unchanged and unstaged at SHA256 `EDE81F84EE9571D43587EFEEC4970F5FB2F54C54E2B2E9EE7FCA7B029C6D8085`. Protected reference checkouts and real user data were preserved. The artifact is an unsigned local portable build. Backend approval/sandbox semantics and capabilities are those of the existing implementation; this is a navigation and menu correction. Delivery is local, with no push or PR.
