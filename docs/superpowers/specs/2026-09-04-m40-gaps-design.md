# M40 — 缺口收割輪（盤點發現的 A/B 修復 + C 增強）

日期：2026-09-04 · branch m40（自 main 出）· 源：docs/CAPABILITIES-DETAIL.md §11（已驗證缺口）。取捨（用戶）：#5 → M41a（SDK v1 wire 單獨輪）；#7 → 納入；rewind → 後續核心輪（先後端快照/回滾引擎）。

## 範圍

**G1（後端/接線修復——6 小項）**
- **A1 todo_write 掛載**：`packages/session-executor/src/assembly.ts`（1 行 import + 註冊——createTodoTool 於工具裝載處；含 inputSchema/execute 掛進 registry）。
- **A2 CLI host 接線**：`apps/cli`（web/run host 構建處）接 pluginRegistry + jobKillBridge（web-host 既有路由可達——404 消除）。
- **A6 `settings/changed` emitter**：settings 熱更（500ms 輪詢 watcher）在偵測到變化時 emit telemetry `settings/changed`（manifest 已宣告）。
- **A7 guardian 斷路器全失敗記**：超時/畸形 JSON 判定也記斷路（三類均開路計數；測試適配）。
- **B8 read_image 工具**：`packages/attachment` 新增 `read_image`（{path} → 解析附件 store/fs 路徑 → mimetype + base64 → ImageInput 信寄模型）——M14 多模態自此模型可呼叫讀圖；掛載入 assembly（與 todo 同位）；註冊 tool-catalog。
- **B8b 概覽文檔訂正**：CAPABILITIES.md 的 read-image 一行改為反映新工具。

**G2（TUI 層——5 項）**
- **A3 toast 渲染**：present.ts 右下 fit-to-width 卡（粗 + accent_user on bg_base；`Copied!` 等字串）+ loop 產生處（copy 動作 → toast；~3s 存活）。
- **A4 contextUsed 真值**：packages/tui 加 `@i-harness/token-meter` 依賴 + embedded `context()` 實現（activeTokens via assembly ctx）+ loop refreshContext 真值 → status chip/info 行；缺 total 時只顯 used（不捏造）。
- **C11 mouse 1106 + 滾動**：input parser 增 1106 wire 解碼（按鈕位 x/y 佈局）+ capability probe 標記 + app 滾動綁定（wheel → scroll ±3）+ **case-018**（滾輪場景）。
- **C12 mermaid Unicode art**：`packages/tui/src/render/mermaid.ts`——graph/flowchart 子集（node+edge → box art：`╭ name ─╮` connected via `│`/`─` 佈局——**簡明兩列**）；其餘類型 + 過寬 → fallback box `╭ mermaid: <word> ─╮` + 過寬提示；markdown 整合（圍欄閉合 → art 渲染——M38b checkpoint 掛鉤）；文檔記錄支持種類。
- **C13 plan-review 適配**：plan-mode 語義 = 模型以文字產出 plan——TUI：當 plan mode 啟用且最新 assistant 塊為 plan 後 → status 行 `◆ Planning` 金碟（已有）+ **動作條**（`a approve`（steer "Approved — proceed"）/`c comment`（prompt 預填）/`q quit`）；plan 查看 = 既有 block viewer（plan 塊展開）——無 plan.md 檔、無後端審批流（我們的 exit_plan_mode 是模型工具——不複刻 grok 的審批暫停）→ **適配版**（做進度同視圖）；**case-019**（plan 會話 + a/c/q 鍵路由）。

**G3（docs/verify）** README M40 行 + CAPABILITIES 增量 + 全量。

## 硬規

- 後端包改動僅限本輪列出的（assembly/attachment/settings/apps-cli/services 內的小接線）——其余零觸動。
- 依賴：packages/tui + `@i-harness/token-meter`（工作區·原則 ✓）；A4 的內存/字段遵守「unknown → 不渲染」。
- PTY 慣例：byte-budget + pins；case-018/019 新增；既有 010..017 全綠（回歸門）。
- 每項完成的評判 = 其對應測試/PTY 綠。

## 計劃分組

G1（A1/A2/A6/A7/B8）∥ G2（A3/A4/C11/C12/C13）→ 調和 → G3 → 全驗證 → 推送。
