# M39 — 質量輪：複刻屬性收官核對 + 場景矩陣擴大 + bench + memory release

日期：2026-09-04 · branch m39（自 m38b 出）· 源：blueprint §4 #4（M39 質量）＋ §1 的 12 屬性核對。

## 0. 目標

TUI 複刻工程的**收尾輪**：把「grok 證明的 12 工程屬性」逐項核對並補齊缺口；擴大 PTY 場景矩陣到交互全景；bench 數據落地；長會話內存釋放。

## 1. 12 屬性核對表（現況）

| # | 屬性 | 現況 |
|---|---|---|
| 1 | 兩緩衝 cell diff + 零字節 idle | ✅ M36（case-010 + renderer 單測）＋ M37a 全屏（byte-budget）+ M38a minimal（region gate） |
| 2 | 獨立 writer | ✅ 類比實現：pump + drain 背壓 + 隊列合併（滿載時最新合併不阻塞事件路徑） |
| 3 | 單一 teardown 位元組序 | ✅ M36 TeardownGuard 冪等；PTY 驗證恢復合同 |
| 4 | 首擊優雅/次擊強殺 | ✅ M36 signal（SIGINT/SIGTERM/SIGBREAK + \x03 數據語義） |
| 5 | 屏幕模式政策 CLI>config>auto | ✅ M36 resolveScreenMode + M38a self-relaunch 切換 |
| 6 | 能力上下文 | ✅ M36 probe（XTVERSION/kitty/OSC11/multiplexer/color） |
| 7 | 虛擬化 + O(dirty) 增量 | ✅ M37a Fenwick segment index（fold/toggle/append O(dirty)） |
| 8 | 檢查點流式 | ✅ M38b markdown checkpoint（段落/列表/圍欄）+ M38a commit 管道（turn 邊界 + 500ms tail-flush） |
| 9 | 時間分片工作 | ✅ M38a 500ms flush pump（idle tick 有需才裝） |
| 10 | 能力輪詢 dirty | ✅ 有需才轉（spinner only when turn）+ 區域 sig-gate |
| 11 | 不可信輸入子進程隔離 | ➖ mermaid PNG **跳過**（藍本 §5 已決）；subprocess 模式在 M26 terminal/exec 已有基礎 |
| 12 | PTY 屏幕級 e2e | ✅ case-010..016 六場景（渲染/流式/鍵面/permission/minimal/markdown）——**M39 補交互矩陣 case-017** |

**結論：1–10、12 全數落地；11 = 跳過項（規格留檔）。**

## 2. M39 交付

1. **case-017 交互矩陣**（把 M37b 的鍵表部從單測提升到 PTY）：
   - permission **RejectOnce 自由行**（type feedback → 決策含 feedback）
   - question modal（`1-9/a-f` 選擇 + `z` 自由 + footer）
   - `/btw` 面板（steer 注入 → 面板轉 answering → done）
   - session picker（Ctrl-S → 列舉 → `j/k` 導航 → Enter 選）
   - history panel（`\x1b[A` 空行 → 面板 → 命中行高亮）
2. **HUD**：`/debug fps`（或環境變量 `TUI_HUD=1`）——右上 32 列面板：`fps:{} p50:{}ms p95:{}ms`（loop 幀間隔採樣）+ 可選 scroll-debug 行（lineCount/segments/window）。僅調試觸發——默認零開銷。
3. **memory release**（grok 的「大 transient 釋放」類推——抄其精神）：
   - ScrollbackEngine：`retain(maxBlocks?, maxLines?)` ——block 列表 LRU 裁切（早於視圖窗口的完成 block 釋放；注意：引擎是會話真相——釋放策略 = 「釋放顯示行、保留事件語義」?? —— 正確做法：**引擎保留事件源（新事件仍 append），釋放的是摺疊緩存/segment index 的歷史塊**——對顯示層做 trim：maxLines 滾動窗口之外的 block 標記 collapsed+absent（sticky 提示 `… earlier (N lines)`）——像 grok 的 virtual 化。交付：`retain(maxLines)` + App 在 resize/長會話（lineCount > 門檻）時自動觸發 + 單測（釋放後 lineCount 穩定、視圖正確、新事件仍收）。
4. **bench**：`packages/tui/test/bench.test.ts`（或 `scripts/bench-tui.mts`）——5000 段佈局後 `lineCount/viewport/nav/fold-toggle` 時延（assert 閾值 + 輸出表）；跑一次記錄到 docs（README 或 research doc 的 bench 小節）。

## 3. 分組

- **G1（case-017）** `host-017.ts + case-017.yaml|test` + referee 小擴充（如有）——交互矩陣 5 步 PTY；斷言：freeform 決策 json、question 選擇、/btw 板內容、picker 選擇閉合、history 命中。
- **G2（HUD + memory + bench）** `src/app/hud.ts`（fps 採樣 + 面板渲染 loop 接線）、`src/scrollback/engine.ts`（retain）+ App 觸發、`test/{hud,retain,bench}.test.ts`。
- **G3（docs + 核對 + 全驗證）** 12 屬性核對表 → CAPABILITIES/README M39 行 + bench 結果記錄 + 全量 verify。

## 4. 驗收

- case-017 綠（2×）；retain 測試綠（釋放後正確性）；bench 輸出記錄
- 全量 typecheck/`-r test`/e2e 綠；README M39 行 + 12 屬性核對表
- 後端零改動
