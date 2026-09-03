# M37b — `@i-harness/tui` 互動覆蓋設計（permission/question + panes + dropdowns + pickers [+ Inline/minimal 視 Q1]）

日期：2026-09-04 · branch m37b（自 m37a 出）· 源：UI 規格 §3.6–§3.12、§4（keymap 全表）、§7（狀態表）；M37 spec §7（M37b 範圍預覽）。取捨：**Inline/minimal 地位待 Q1**。

## 0. 目標

把 M37a 的全屏 agent 屏補到**交互完整**：許可/提問覆蓋接 IH approval/question seam、面板與下拉按 §3.6/§3.12 逐條複刻、session picker/welcome 適配。**後端零改動**（approval 接線用既有 `registerApprovalAnswerer` + assembly `onAssembly` 鉤子——只讀接線）。

## 1. 範圍

**全屏交互補充**：
- **§3.7 Permission modal**：無邊框 bg_light + accent 軌；標題（`Allow Edit?`/bash 描述）；bash 命令 soft-wrap 語法展示；選項行 `1 (●) Always allow: {scope}` / `Never allow` / `Yes, proceed` / `No, reject (type to add feedback)`（RejectOnce 自由行 `❯ {preview}`）；`←→` 調範圍；`Ctrl-F` 展開 args（M37b：截斷+提示，展開=line viewer 復用）；鍵 `1-9/j/k/Enter/Ctrl-C/Ctrl-O`（Ctrl-O always-approve = guardian 決策面）。
- **§3.8 Question modal**：`1-9` 後 `a-f` 快捷 + `[ ]/[x]` 多選/`(○)/(●)` 單選；`z` 自由行 `Type your answer here`；footer `[1/2] ↑/↓ navigate · y copy` 左 + `Enter: select|submit|edit` 右。
- **§3.11 Cancel-turn 面板**（subagent 仍在跑時提示 + `1 Stop running/2 Continue to run/3 Always stop/4 Always continue`）。
- **§3.10 Plan chrome（適配）**：審閱面跳過（plan.md viewer 無後端）；保留：`◆ Waiting on plan approval` 狀態行?（我們無等待審批——**簡化為** plan-mode 啟用時的 prompt 金碟 + status chip `plan` + `Switched to mode: plan` banner —— 僅 chrome）。
- **§3.12 panes**：todo（`□/▶/✓/✗` 配色表 + 空態串）、tasks（組頭 `▾ Subagents 2` + 行 `{spinner|✓|✗} {elapsed} {label} (N) {model}` + `[✗]/[↗]`）、queue（`#N` 前綴 + 種類樣式 + `[cancel]/[Send now]`）、`/btw` 面板（` /btw {question} ` 標題 + `⠋ Answering…` + 錯誤色 + markdown ≤12 行）——/btw 接 **steer/inject 面**。
- **§3.6 dropdowns**：slash（`❯ /command  first-line desc` + ghost args）、completion（`❯ {label}  {desc}` max 6 行——shell 補全**跳過**、只能 slash/ghost）、history 面板（`" history "` 計數 + 命中 accent_user + `Loading...`）、file-search `@`（`{k}/{n}` 計數 + workspace/fs-search 適配）。
- **Session picker（§3.12 適配）**：組頭 repo_name + 行 label/右 label + 相對時間（`just now/Nm ago/…`）+ 字段 `ID/CWD/Model/Created/Updated/Messages/Turns`——數據源 BackendClient.listSessions（embedded 目前僅當場 session——**M37b bridge 補 store 列舉**：加 `@i-harness/session-persistence`+`-jsonl` 依賴（工作區自研包，依賴原則允許）→ 真列舉；storeRoot 由 host 傳）。
- **Welcome（§2a 適配）**：hero 圓角框（版本右側）+ menu（`ctrl+s Resume session`/`ctrl+n New session`/`ctrl+q Quit`）+ 副標（我們自己的版本串）——無 grok 登錄/import/工作樹。
- **keymap 全表補全**：覆蓋面增加的鍵（modal `1-9/a-f/z/y/j/k/←→`、dropdown `Tab/Enter/Esc/PageUp/PageDown`、picker `/i/f/y/e/E/Space/Tab/Shift-Tab`、welcome `y/n` 信任——worktree? 跳過）——keys.ts 表格化 + 測試。

## 2. 橋擴展（packages/tui/src/backend，非後端包）

- `BackendClient` 增加：`approvals(): AsyncIterable<ApprovalSurface>`（surface = {id, text, kind: "bash"|"edit"|"mcp", scopeOptions[], freeformAllowed}）；`answerApproval(id, decision: "always-allow"|"never-allow"|"once"|"reject-freeform"|"yes"|"no", scope?)`；`questions(): AsyncIterable<QuestionSurface>`；`answerQuestion(id, choice?)`。
- embedded 實現：assembly `onAssembly(hook)` 中 `registerApprovalAnswerer(ctx, fn)`——ApprovalAnswerer = 把請求轉成 stream 事件 + await `decisionQueue`（UI 輸入）。
- 依賴增加：`@i-harness/session-persistence`、`@i-harness/session-persistence-jsonl`（listSessions/真實列舉）。

## 3. 分組（計劃）

- **G1**：permission/question/cancel-turn 覆蓋 + 橋擴展（approvals/questions/answerer）+ 單測（行模板 golden + 範圍鍵 + freeform 輸入 + 決策回寫 fake stream）。
- **G2**：panes（todo/tasks/queue//btw）+ dropdowns（slash/completion/history/file-search）+ session picker + welcome + keymap 補全 + present 佈局接入（面板佔位/覆蓋優先序 §2.1 已有 row 槽——agent.ts layoutAgent 擴充） + 單測。
- **G4**：host 接線（overlay 輸入泵 + picker/dropdown 路徑）+ PTY case-012（prompt 交互）/case-013（permission 覆蓋）。
- **G5**：docs + 全驗證。

## 4. 決策表

| # | 決策 | 判定 |
|---|---|---|
| D1 | permission 接線 | 只讀 seam（registerApprovalAnswerer + onAssembly）；**後端零改動** |
| D2 | RejectOnce 自由行 | 複刻（freeform 輸入 → reject + feedback 段）——feedback 包已有 |
| D3 | session picker 數據 | M37b 補 store 列舉（新依賴 = 自研工作區包；Policy 允許） |
| D4 | 審閱面 | 保留 chrome 無流程（見 §1 plan chrome 簡化） |
| D5 | Inline/minimal | **→ M38**（用戶 2026-09-04）——最小風險：M37b = fullscreen 交互面收官；Inline 前向引擎（CSI S/T + 滾動區 + resize 邊角）+ minimal print-once 獨立一輪（M38，與 /minimal 切換、政策 polish 同輪） |
| D6 | /btw | 接 steer/inject 面（TuiEvent 已含 agent/input/admitted 映射） |

## 5. 驗收

- 全量：`pnpm typecheck` 0 / `pnpm -r test` 綠 / `pnpm e2e` 11/11
- PTY：case-012（打字/Enter 提交/歷史 Up/Ctrl-C 清/Ctrl-M multiline/Shift-Tab 循環 → 屏幕+提交生效）、case-013（permission 模板 `1 (●) …`、1-9 選擇回寫）
- README M37b 行 + CAPABILITIES 增量
