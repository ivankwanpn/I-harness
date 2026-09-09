# M59 交接：TUI ↔ grok-build 外觀對齊（第一批 + settings 追趕）

日期：2026-09-09 · 分支 `m59`（自 `e180a08` 續做）· 前一輪：`docs/audit/2026-09-09-ih-m57-handoff.md`

**一句話**：grok 對齊清單的**前三項已落地**（輸入框 3 行、工具完成只留標題列、runtime-context 不進對話），過程中修好一個**真 bug**（覆蓋層槽位高度）並補上 grok 的 **follow-up behavior** 設定列；end-to-end harness 從 0 綠拉到 **18/18 全綠**。

**本檔案是交接入口**：`.superpowers/sdd/**` 是 gitignored，不隨分支推送，因此本輪所有裁定與殘留都在此重述。

---

## 1. 交付

| 項目 | 檔案 | 內容 |
|---|---|---|
| **1. 輸入框 6 行 → 3 行** | `packages/tui/src/views/agent.ts`（`promptHeightOf`）、`views/prompt.ts`（`ctx.h - 3` → `- 2`，5 處） | 與 grok 完全同構：`╭─╮` / `❯ …` / `╰─ model ─╯`。舊公式 `promptLines + 3 + 2*vpad` 多留了兩列空白。 |
| **2. 工具完成只留標題列** | `packages/tui/src/scrollback/folding.ts`（`toolFold`） | collapsed execute 不再吐 body（grok `DisplayMode::Collapsed` 只畫 header）；**running** 仍串流 excerpt，展開（`e`/`E`）看全文。另在 `backend/embedded.ts` 加 `executeOutputText()`：shell 結果展開時顯示 stdout/stderr，不是 JSON envelope。 |
| **3. runtime-context 不進對話** | `packages/core-session/src/index.ts`（`user/message` 加 `internal?: true`）、`packages/runtime-context/src/index.ts`、`packages/guard-repeat-tool/src/index.ts`、`packages/tui/src/backend/embedded.ts`（`mapSessionEvent` + `peekTail` 過濾） | 模型仍看得到（投影不動），TUI 不再把它當使用者訊息印出。**加法式 schema 變更**（`fromJSONL` 不驗證，舊 log 相容）。 |
| **4. 覆蓋層槽位高度（真 bug）** | `packages/tui/src/app/overlay-seam.ts`（`minRows`）、`views/agent.ts`（`state.overlay.minRows`）、`app/present.ts`（型別） | 輸入框縮到 3 行後，permission/question/cancel-turn/rewind **畫不下**（行會被靜默丟棄）。現在各 seam 自報內容高度：permission/question 用**自己的 row-walk**（`fitRows` 二分搜尋）保證每個選項都可見，再加上 renderer 真正會畫的 detail/description 行數；rewind 依 phase 給高度。**附帶效果**：權限框的 detail 與問題框的 description 現在會顯示（先前被擠掉）。**更正（M60 審查）**：rewind 的 `confirm` 分支當時漏算 `unseen` 行，面板仍過矮、底部 `y (●) Confirm`/`Bksp (○) Back` 被裁——「每個選項都可見」對 rewind confirm 不成立，M60 修 A 已補 `capped(unseen.length)`。 |
| **5. Follow-up behavior 列** | `views/settings.ts`、`app/loop.ts`（`setBusyEnter`/`busyEnter`） | 設定後端**本來就有**（`settings.busyEnter: "interrupt" \| "wait"`，apps/tui 映射成 steer/queue），只是沒在 modal 露出。新列顯示 grok 的 **Queue/Steer** 名稱、持久化仍用 dsh 詞彙、**即時生效**（不必重啟）。 |
| **6. Harness golden 全面重釘** | `packages/tui/test/harness/**`（m59 改動 17 個 yaml + 5 個 host + referee/virtual） | 見 §3。 |

## 2. 驗證（實跑）

| 命令 | 結果 |
|---|---|
| `pnpm --filter @i-harness/tui test` | **70 files / 761 passed**（含 harness 18 檔 21 測）。**全套並行的真實情況**：case-027 `spawn-running` 在本套件自身的並行負載下會 90s 逾時（單獨跑 ~4.5s 綠，見 §3.8）；761 是當時那一次的實跑，不是「任何時刻全套必綠」。M60 整合後重跑結果見 M60 交接。 |
| `pnpm --filter @i-harness/tui typecheck` | **m59 上實際是紅的**：`busyEnter` 被設為 `SettingsSnapshot` 必填卻沒同步更新唯一全量 literal helper（`packages/tui/test/settings-mouse.test.ts`），vitest 不做型別檢查所以 761 測照綠。M60 控制器的 `a33a646` 修復後才 clean。 |
| `pnpm --filter @i-harness/core-session test` | 12 files / 91 passed |
| `pnpm --filter @i-harness/runtime-context test` | 5 passed |
| `pnpm --filter @i-harness/guard-repeat-tool test` | 8 passed |
| harness 單獨跑（18 檔並行） | 18 files / 21 tests passed |

## 3. Harness 重釘要點（下次改 TUI 前先讀）

1. **布局位移是主要工作**：輸入框矮 3 行 → 下方所有面板/對話框/下拉整體下移 3 行（turn row 13→16、prompt 文字列 16→19、box 頂 15→18、dropdown 上緣 = `prompt.y - rows`）。
2. **完成的 execute block 少一列**（不再有 excerpt）→ 內容行數改變 → scroll offset、`assert-scrollback` 的 len/baseY 都要重算。
3. **frame 編號會跳**：minimal/fullscreen 的「相同 frame 不寫 byte」機制下，running→done 若長得一樣就少一個 write。修法（case-011/015）：**讓 running 事件帶 output**（串流 excerpt），running/done 才有視覺差異。
4. **host 的 settle watcher 不能用被折疊的文字**：case-026/028 原本等 `"exitCode":` 出現在 engine tail；現在改用「最後一行 `done` + 工具標題」。case-026 另外改用 `app.state().turn === undefined` 判定回合結束（文字會早一步出現）。
5. **frozen clock 下 scroll coast 不會 finalize**：wheel 事件後視圖會繼續滑到 coast 底部才停（case-023 的斷言因此改釘「漂移後的最終視圖」）。這不是產品 bug，是測試時鐘的產物。
6. **block viewer 的 anchor fallback**：`openBlockViewerAt` 現在會在 anchor 不是 tool block 時**向下找畫面上第一個 tool block**（`firstToolAtOrAfter`）——內容不再溢出視窗時，Enter 仍然開得了使用者正在看的工具區塊（case-026/028 的斷言因此改成 Read block）。
7. **診斷強化**：`referee.ts` 的 wait-screen / assert-cell-colors / assert-scrollback 失敗時會附上實際畫面或 normal buffer dump（`virtual.screenDump()`）。
8. **case-027 的 spawn 在滿載下會慢**：`spawn-running` 逾時 60s→90s（單獨跑 5 秒內完成；全套並行時偶發）。

## 4. 殘留 / 下一步（依建議順序）

### 4a. Settings 對齊（使用者已點名，**尚未動**）
- 現況：IH = 兩段式（categories → category），grok = **單一捲動面板**（`/ to search` + section headers + 右對齊值 + 底部提示列）。
- 目標畫面（使用者截圖）：`Settings` 標題 + `/ to search` + `Appearance`/`Mouse`/`Editor & Input` 分節 + `↑/↓/j/k nav | g/G top/btm | Space toggle | Enter toggle | → expand | / search | d reset | F2/Esc close`。
- 參考：grok `crates/codegen/xai-grok-pager/src/views/settings_modal/`（render.rs 2801 行、state.rs 1104 行）。
- 落點：`packages/tui/src/views/settings.ts`（`SettingsModalState`/`renderSettingsModal`/`bindSettingsOverlay`，701 行）＋ `packages/tui/test/settings-modal.test.ts`（233 行）＋ case-028 的 settings 斷言。**值層（registry/controller）不用動**。
- 搜尋可用 overlay seam 的 `freeform` 機制（permission reject / question 的 z 列同款）。
- ⚠️ 改完 case-028 的 `region: { startRow: 24 }` 那三組斷言要重釘。

### 4b. 其餘 7 項外觀對齊（使用者原清單，未動）
時間戳右對齊、`Worked for X` 回合尾、頂欄 token 用量、`✦ Thought for X` 思考列、模型顯示名（displayName 而非 route id）、底部提示精簡、模式切換第三檔（Always-Approve；`Shift+Tab` 目前只 Normal↔Plan，`/always-approve`、`/auto` 是 hidden + toast「live guardian capability not wired」）。

### 4c. 打包
`pnpm tsx scripts/build-installer.mjs` → `build/I-harness-Setup-0.1.0-test.exe`（使用者會自己裝）。**本輪尚未重建**（上次是 14:54 的 `e180a08` 版）。

### 4d. 分支狀態
`m59` 目前領先 `main` 數個 commit（本輪會再 +1）。`m58`（R-B4 git undo）仍**未合併**。

## 5. 注意事項

- **不要 commit** 到 `main`；本輪全在 `m59`。
- 使用者的 grok 安裝在 `D:\grok-build-main`（源碼）＋已建置的 `grok`；`~/.grok/config.toml` 有 `[model.opencode-go]`（OpenCode Zen，需 `x-opencode-session` header）。
- grok 的 `[Click here to Upgrade]` 是它自己的訂閲推廣，**明確不對齊**。
