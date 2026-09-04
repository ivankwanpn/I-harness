# M43 — Rewind UI 複刻（§3.9 規格落地）+ case-020

日期：2026-09-05 · branch m43（自 main 出）· 源：UI 規格 §3.9（grok rewind.rs 逐行提取）+ M42 後端引擎（packages/rewind + rewind/point 投影）。

## 0. 目標

把 grok 的 Rewind 交互 **1:1 複刻**在我們的全屏 agent 屏上：`Esc Esc`（空 prompt → 開 picker，第一擊 armed 有 toast）→ picker → CancelOffer / ModeSelect / Confirm（衝突列表）→ Executing → 完成；scrollback 從 anchor **向下暗化**；狀態行 `⚠ Rewinding…`。後端 = M42 service（embedded 橋面）。

## 1. 複刻面（UI 規格 §3.9 原文）

| 相位 | 規格字面 |
|---|---|
| Loading | `"Loading rewind points..."` |
| Picker | ListOverlay 標題 **`"Rewind to which turn?"`**；行 `· {preview} · {N} files`（無檔案 `· (no preview)`） |
| CancelOffer | 標題 `"A turn is currently running."`（accent_user 粗）；`"Would you like to cancel it before rewinding?"`；y→`"Cancel turn and rewind"` / n→`"Let it finish"` |
| ModeSelect | `"What do you want to rewind?"`；a→`"Both conversation and file changes"` / b→`"Conversation only"` / f→`"File changes only"`（無檔案變更時 f disabled `(○)`） |
| Confirm | `"Rewind file changes and conversation to "…"?"`（` ({N} files)`）；乾淨 `{path}`（gray）、衝突 `! {path} ({deleted|added|modified|conflict})`（**warning**、max 5 + `+N more`）；y→`"Confirm rewind"` / Bksp→`"Back"` |
| Executing | `"Rewinding..."`；Error：`"Rewind failed"`（accent_error）+ msg + Esc→`"Dismiss"` |
| Interaction | 空 prompt 第一 `Esc` → arm（toast `press again to {label}`）；第二 `Esc` → Picker；核對 j/k/↑↓/Enter/y/n/a/b/c/f/Esc/Bksp（鍵表 §3.9） |
| 視覺 | 打開時 scrollback 從 rewind anchor 向下 dim（`with_dim_from`——M37a engine 已備 sticky/metadata？dim 為 present 層：anchor line 斷點 → 其下 blend 0.66 向 bg——新 render 選項 `dimFrom?: lineIndex`） |
| 狀態 | 執行時 turn-status `"Rewinding…"` 閃 + spinner；完成 toast `"Rewound to …"`（自己定，grok 無該 toast——不複刻不必要項，僅狀態行） |

## 2. 後端橋（embedded 面——wire 附錄留後）

`BackendClient` 擴展（additive）：`rewind?: { points(): Promise<RewindPointSummary[]>; plan(target: number, mode): Promise<RewindPlan>; execute(target, mode): Promise<RewindResult> }`——embedded 實現 = M42 RewindService 直調（assembly.rewind 已掛）；`mode` 對應 M42 types（"all"|"files"|"conversation"）；對映錶：a→all、b→conversation、f→files。
- 執行前 CancelOffer 的 cancel 條件：`status().running` → offer；用既有 cancel()。
- 完成後 refresh：事件流會灌 `rewind/point`（M42 execute 已 append）→ engine 收到（新事件類型 → engine 需可見：**M43 需要** engine/TuiEvent 對 `rewind/point` 的處理——映射為 `{type:"system"}`? 不——加 TuiEvent `rewind`{targetTurn}（bridge 映射）→ engine 顯示系統行 `┃ Rewound to turn {N}` + **anchor 切換**（視窗跳至 anchor）——UI 即時反饋；以及 TUI 側 local rewind 狀態（來方便 Modal 的打開）。

## 3. 組件

- `src/views/rewind.ts`——相位鉸接（Loading/Picker/CancelOffer/ModeSelect/Confirm/Executing/Error）+ 行模板（grok 字面）；`bindRewindOverlay`（seam binder——鍵表 + onDecision 回寫到 bridge）。
- `src/app/loop.ts`：Esc-Esc 開熱（空 prompt + armed 機制已有——接上「第二擊→開 picker」）；rewind overlay 狀態機（loading→picker→…）；backend.rewind calls；完成後視窗跳 anchor + toast。
- `src/app/present.ts`：`dimFrom` 選項（anchor 下線 blend 0.66）→ drawScrollback 支持（新 opt）。
- bridge：embedded 的 `rewind` 擴展 + `mapSessionEvent` 對 `rewind/point` → TuiEvent {type:"rewind"}。
- keys.ts：rewind overlay 鍵路由（y/n/a/b/c/f/Esc/Bksp/j/k/Enter）。

## 4. PTY case-020（rewind 全相位）

場景：mock turn（fs 寫檔工具真實執行——事件鏈真實）+ 第二 turn（修改）→ 開 picker（Esc Esc）→ j/k 選 turn-1 → Enter → ModeSelect（a）→ Confirm（檔案清單 `src/data.txt` clean + 無衝突）→ y → `Rewinding...` → 完成 → **磁盤檔案恢復**（temp workspace 檢查 first-turn 前內容）+ **對話影子**（scrollback 顯示新 system 行 + 舊 turn 消失）+ scrollbar dim 斷點 pins + writes-budget + exit 0。

## 5. 分組

- **G1**：rewind view + binder + loop/keys 接線 + bridge（rewind/ 事件映射 incl. rewind/point→TuiEvent + engine 行）+ 單測（相位字串 golden、鍵表、bridge 映射）。
- **G2**：case-020 PTY（temp workspace + 真 fs 工具 + 磁盤斷言 + dim pins + budget）+ present dimFrom。
- **G3**：docs（README M43 行 + CAPABILITIES + DETAIL rewind 跳過→複刻 更新）+ 全量。

## 6. 非目標

wire 附錄（--attach rewind 需 v1.1——留後）；rewind 前取消對話的重新播放（CancelOffer 的 cancel 已夠）；grok 的 plan.md/逐 prompt 全體選（picker 走我們點開的 turn 列表——同構）。
