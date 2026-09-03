# M38 — minimal 模式 + Inline 前向引擎 + markdown checkpoint + 視圖深度（政策/切換/選項頭）

日期：2026-09-04 · branch m38（自 m37b 出）· 源：UI 規格 §1（minimal live region）、§8（流式序列/checkpoint）、§7（狀態）；blueprint §4（M38 polish）＋ M37b 決策（Inline/minimal → 本輪）。**取捨：M38a/M38b 拆分待 Q1**。

## 0. 目標

把 grok 的「快/穩降級面」落地：**minimal 模式**（終端原生 scrollback + print-once 紅線——內容提交後永不重繪）＋ **Inline insert_before 前向引擎**（CSI S/T + 滾動區 + resize 邊角——最大風險塊）＋ **markdown checkpoint 渲染**（段落/列表/代碼圍欄閉合才刷新——§8 流式序列的引擎側）＋ fullscreen 的選項頭與政策 polish。

## 1. 範圍

**M38a（模式輪）**：
- **Inline 前向引擎**（`packages/tui-core`? 或 `packages/tui/src/minimal/inline.ts`——引擎屬於渲染層但服務於 minimal 視圖；建議 tui 包內 `src/minimal/`）：
  - 自己的「tail window」cell grid（live region 內容）＋ **viewport 錨**：每插入一行提交內容 → CSI `\x1b[S`（scrolling region 上移）＋ 重繪 live region 底行——**print-once**：已提交行永不重繪。
  - CSI S/T、滾動區域（DECSTBM 邊界）、resize（grow/shrink 幾何再計算）、tmux/Zellij downgrade（screen-mode 政策已解析 → minimal 選擇時的下游）。
  - resize 邊角：行數縮放時 live region 重排（§grok 提過的 grow-vs-shrink、全清垃圾）。
- **minimal 視圖**：live region = `[live tail · todos · /btw · status(1) · prompt]`（§1 live.rs 組合）；default rows 10；信息行 `model · flag · context`；提交事件（turn end/助理段落閉合）→ print-once 提交。
- **模式切換**：`/minimal` `/fullscreen` = **self-relaunch**（同會話——grok 本家做法：EXEC 自己 + `--mode`；避免可怕的 re-emit 邏輯）。
- **PTY case-015**（minimal print-once）：提交塊 → 斷言 0 重繪（tail 窗口之外無變化）+ 行界正確 + `/fullscreen` 重啟回 fullscreen。

**M38b（內容輪）**：
- **markdown checkpoint**：`marked`（通用公開庫）解析 + 引擎側 checkpoint 狀態機（段落空行/列表結構/代碼圍欄 ` ``` ` 閉合）→ block 增量刷新（僅尾重渲染）+ 代碼塊 `md_code_bg` + 標題 6 級色 + 表格/列表/引用（§3.1 AgentMessage 全規格）。
- **高亮（極性安全）**：hljs（通用公開庫）語言高亮 → 代碼塊著色 + 極性安全 ANSI16 裝飾（對比提升）。
- **選項頭實值**：info line 接真值——modelLabel（`defaultEmbeddedFactory` 的 modelBuilder 標籤）、context 用量（token-meter per-session——bridge 狀態面已有？無則由 assembly.ctx 供）、`multiline` 標記存在與否。
- **`--attach` 遠程**（SDK 子進程客戶端——wire contract v0 已凍；`i-harness sdk` stdio 面 → BackendClient 遠程實現；`--attach` = 連一個已跑服務的 sdk/wsmux 客戶端）。
- **markdown PTY case-016**（流式時段落 checkpoint 逐段畫出 + tail 重繪而不重發）。

## 2. 決策表

| # | 決策 | 判定 |
|---|---|---|
| D1 | Inline 歸屬 | `packages/tui/src/minimal/`（app 層引擎——非 tui-core；mermaid/標題無關渲染屬 view 層） |
| D2 | 提交機制 | **print-once**（提交塊寫入 + 永不重繪；live region 只重繪本身）——紅線 |
| D3 | 模式切換 | **self-relaunch**（同會話 + `--mode`；grok 本家 `/minimal` `relaunches same session`） |
| D4 | markdown 庫 | `marked`（通用公開庫）＋ 引擎側 checkpoint 狀態機；**不引私有** |
| D5 | 高亮 | `highlight.js`（極性安全 ANSI16 映射表——規格 §5 的 hue 系釘色） |
| D6 | --attach | SDK stdio 客戶端（wire v0 凍結）；WS mux 遠程留後 |
| D7 | M38a/b 拆分 | ⚠️ Q1 |

## 3. 驗收

- M38a：PTY case-015 綠（print-once 0 重繪 + resize 邊角不變量 + 模式切換回 fullscreen）；全量綠
- M38b：case-016 checkpoint 流式綠；`pnpm typecheck`/`-r test`/e2e 全綠
- README M38a/M38b 行 + CAPABILITIES 增量
