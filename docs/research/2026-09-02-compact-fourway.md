# Compact / Autocompact 四路研究與 I-harness 吸收設計

日期：2026-09-02 · 方式：四家唯讀深讀（每項目一個研究 agent，含文件級事實線）＋ 對照 I-harness 現狀（M11/M20/M31 之後）。

**樹**：
- cc-custom `D:\opencode-bugfix\cc-custom`（Claude Code fork，`src/services/compact|query/effects|commands/compact` 等）
- opencode `D:\agent-complete\opencode-fork-private-999.0.15`（`packages/core/src/session/{compaction,context-epoch,runner,kernel}`）
- codex `D:\agent-complete\codex-rust-v0.149.1\codex-rs`（`core/src/compact*.rs`、`session/context_window.rs`、`state/auto_compact_window.rs`）
- dsh `D:\agent-complete\deepseek-harness-dsh-v0.1.2-alpha.5`（`packages/compaction/*`）

## 0. 結論先行

四家有四種架構姿態——cc-custom（記憶投影+生存機械）、opencode（anchored 增量+讀期過濾+Epoch）、codex（能力分級+快照重寫+雙窗口）、dsh（剪枝優先+括號鎖+invariant）。**I-harness 的 shadow-projection（append-only 完整、讀期影子替換）是唯一「持久層永不改寫」的方案**——資料完整性的優勢位。真正的差距不在「架構」而在「細節工程」：anchored 增量摘要、model-free 剪枝、計數完整性、磁滯/熔斷、命令面、提示結構。

## 1. 四家機制總覽

| | 觸發 | 策略 | 摘要 call | 持久化 | 用戶面 |
|---|---|---|---|---|---|
| **cc-custom** | 純 token：有效窗 −`maxOut(20k cap)` −`13k buffer`；**磁滯 3-turn + 熔斷 3-strike** | 同模型 10 節提示；`maxTokens=min(20k, modelMax)`；**partial（from/up_to 方向）**；microcompact（60min 時間觸發,純清內容） | 前綴共享 fork（實驗；98% miss 代價 0.76% cache_creation） | 記憶投影 + append-only ledger + `preservedSegment` 重連 | `/compact [instructions]`、`/context-window`、`/auto-compact-window`、`/max-output` |
| **opencode** | classic：**每 provider 調用前預檢**；kernel：**僅響應式**（overflow 後一輪內重試一次） | **anchored 增量**（前摘要+update）；`keep.tokens=8k` 尾 verbatim；手動=合併 | 獨立請求（tools:[]；無前綴） | 事件 log + `type:"compaction"` 行 + **讀期窗口過濾** + ContextEpoch 重基線 | `/compact`/`summarize`、插件 veto（autocontinue/compacting） |
| **codex** | **雙窗口**：硬 95% 有效 / 軟 90% scope；pre-turn、mid-turn、**model-downshift、comp_hash 變化** | **remote V2 服務端壓縮** > legacy remote > 本地；保留 user ≤20k + 組 64k；**token-budget reset** 路線 | 同 prompt cache key | **`CompactedItem` 快照**（replacement_history+window ids；bounded scan 恢復） | `/compact`、`thread.compact.start`、`new_context_window` 工具 |
| **dsh** | **壓力預檢**（pre-step 前）+ **overflow 響應**（generation-gated proof 才 retry；`maxOverflowRetries=1`） | **model-free pruner 先剪**（8192/4096/1024）→ 摘要（`purpose:'compaction'` 前綴復用）；`0.8/0.16`；per-model 策略 | 前綴對齊（KV 復用） | 括號鎖（start…end）+ **invariant 同伴** + shadow-price 事件保持 O(1) 投影 | `/compact`（錯誤碼映射）、UI checkpoint 節點 |

## 2. 優點/缺點（逐家）

### cc-custom
**優**：生存機械最全——磁滯+熔斷（**真實數據：12% 壓縮間距 ≤2 turns；1,279 會話 ≥50 連續失敗＝25 萬次 API 浪費/日**，BQ 採樣）；post-compact 重注入（≤5 檔案 50k、skills 25k、plan、工具/MCP 重宣布、SessionStart hooks re:compact、指令 DOC 重讀——LLM 最會忘的逐一補回）；partial 壓縮方向提示成熟。
**劣**：計數只算 payload，**不含 system+tools+userContext ~20-40k**（"false may still retrigger"明示）；20k clamp 對大歷史靜默欠摘要；cache 共享 fork 有微妙不變量（maxOutputTokens/thinking 不可設）；transcript 簿記（preservedSegment/usage 歸零/UUID 去重）是微妙 bug 溫床。

### opencode
**優**：**anchored 增量**（"Update the anchored summary"——多輪壓縮只增不堆）；tail verbatim；日誌邊界讀期過濾（恢復=讀時窗口）；與 ContextEpoch 交互（compaction > baseline → 整包替換）；plugin veto/transform 縫。
**劣**：char/4 估算粗糙；每次壓縮失效緩存前綴（同模型全價）；kernel 無預檢（先失敗才壓）且摘要後失敗→turn 直接 error；8k 邊界字符切分可切斷句子；`/compact` TUI/ACP 對 `POST compact` 端點已不存在（僅 `summarize`）——stale-surface bug。

### codex
**優**：能力分級（remote V2 用服務端更大窗口）；**雙窗口數學**（95/90 + fallback buffer）與 comp_hash/downshift 觸發；`CompactedItem` 快照帶 window ids + metadata sidecar（可追蹤性天花板）；完整 per-attempt analytics（tokens 前後/圖像/緩存寫入）與模型卡 knobs（`auto_compact_token_limit` 默認 90%、clamp 95%）。
**劣**：**快照=整史替換**（單一模型摘要=偏見；舊摘要靜默排除；client developer 消息默認丟）；保留量仍大（64k+20k）——自家警告多輪壓縮後準確性；**三套實現同步成本**（V1/V2/本地/token-budget——舊式無 replacement_history 導致無界恢復掃描）。

### dsh
**優**：**prune-first**（純確定性剪枝可完全免除一次 LLM 調用——defaults 8192/4096/1024，僅壓力時）；**generation-gated overflow retry**（`surface.replaceGeneration` 前進＝唯一證明——防重試風暴）；**括號鎖 + invariant 同伴**（崩潰孤兒鎖、span 一致、配對——運行期可診斷）；per-model 精確策略；**shadow-price 協議**（`compaction/summary|prune` 領取 + `replace` 消費 → O(1) 投影折疊，歷史漂移回退 + 不匹配 fail-loud）。
**劣**：固定默認（0.8/0.16）+ 固定估價器無語料調優；無摘要超時（僅取消信號）；不可分割單元溢出無法修復→每步重警告；前綴復用嚴格依賴「與最後 routed 請求前綴相等」；client context meter 曾有盲點（`projectedTokens` 修復——歷史借鏡）。

## 3. I-harness 現狀（M11/M20/M31 後）

- **引擎**（`packages/compaction`）：shadow-projection——`selectShadowableRange`（尾部保留、壓縮標記與無 seq 事件永不 shadow）→ 摘要 → `compaction/start|summary|end` 三事件（summary 帶 shadowedSeqs）；**append-only，永不截斷**；M20 `resetWindow`（純重置,保留 20, marker 帶 removedSeqs）
- **階梯**（core-agent `enforceBudget`）：Layer1 compact → Layer2 resetWindow(20) → Layer3 `prompt_too_long` fail-closed；每 step 前
- **觸發**：maybeCompact（≥0.8×窗）+ **re-fire guard**（末次 compaction/end 後無新非標記事件不重壓）；summarizer fail-soft
- **計數**：`activeTokens`（surface 投影）——**不含 system prompt + tools**；`checkBudget` 以 `reserveRatio 0.9` 粗覆蓋
- **無**：手動命令、anchored 更新、prune pass、熔斷、per-model 策略、analytics
- **優勢位**：四家中唯一「持久層永不改寫」；resume/重放完全一致；M31 統一窗口讓階梯僅在窗口已知路徑活躍

## 4. 吸收設計方案（按價值/成本排序——M33 範圍建議）

### ① anchored 增量摘要（opencode）——最高價值
- **問題**：IH 每輪壓「最新區域」且舊 `compaction/summary` 視為標記剔除 → 多輪壓縮**堆摘要碎片**，長對話連續性退化
- **做法**：summarizer 提示改為「**若存在前一則 `compaction/summary`，以 `<previous-summary>` 注入並要求 update（anchored）而非重新總結**」；壓縮選區排除舊摘要（存在）但注入入 prompt；`compaction/summary` 事件仍 append（新標記）
- **成本**：S（summarizer.ts + prompt + 測試）

### ② model-free prune pass（dsh）——高價值
- **問題**：大 `tool/result`（JSON 輸出等）占壓縮前主導空間；IH 僅在寫入有 retention（shell headTail/spill）——LLM 工具結果無壓縮剪枝
- **做法**：壓縮選區前（僅壓力/overflow 觸發時）對 tool/result 事件做純確定性 head/middle/tail 剪（defaults 8192/4096/1024；`prune` 標記事件 `compaction/prune`——IH 加同形事件）；**剪完重新計數，若解除壓力直接跳過摘要**（省一整次 LLM call）
- **成本**：M（新事件 + region 預通路 + 測試）

### ③ 計數完整性（cc 教訓）——高價值低改
- **問題**：IH `activeTokens` 僅 surface；系統 prompt（A4 動態區+指令）+工具 schema 在真實請求另占 ~10-40k——cc「壓縮後立即再觸發」風險同樣在
- **做法**：`maybeCompact`/`checkBudget` 計數加**常數/可配 `overheadTokens`**（default：系統 prompt 估算+工具 schema 估算——由 assembly 提供；若未知保守 0）與 cc 的 `buffer`/dsh 的 `keep` 同思路；三層階梯用同一計數
- **成本**：S–M（assembly 提供 overhead；token-meter/checkBudget 擴）
- **備註**：與 M31 per-session 窗口解析配套（web 路徑已有真實 window）

### ④ 磁滯 + 熔斷（cc 數據）——低成本高防護
- **做法**：`MIN_TURNS_BEFORE_RECOMPACT = 3` 磁滯（re-fire guard 擴充：壓縮後 N 個 turn 前不再壓）；失敗熔斷 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`（連續摘要失敗→暫停 auto 壓到有新非標記事件；防「250k call/日」型浪費）
- **成本**：S

### ⑤ 手動命令面 + 錯誤語義（四家共有 / dsh 錯誤碼映射最佳）
- **做法**：`/compact` 等價：session 命令列加 `session-compact`（interaction commands 既有機）＋ 可選指示（`instructions?`）；錯誤分類：busy|cancelled|summary|commit|persistence（dsh 六碼映射）；manual 不飽和強制（現 `compact()` 已存在——僅需曝光）
- **成本**：S

### ⑥ 摘要提示結構化（cc 10 節 / dsh 8 節 / opencode 6 節交匯）
- **做法**：`summarizer.ts` 提示升級：工作狀態（completed/active/blocked）、下一步、相關檔案、**敏感用戶指令逐字保留**、工具調用摘要；「不可提及壓縮過程」
- **成本**：S（prompt 文本+測試）

### ⑦ per-model 策略 + analytics（dsh / codex）——中低
- 做法：`CompactionConfig.modelPolicies`（exact provider/model → threshold/retain/maxTokens 覆蓋——dsh 形狀）；analytics 事件（telemetry `compaction/attempt`：tokens before/after、attempts、成功/失敗——codex 埋點思路、IH telemetry 現成）
- **成本**：M（可 M34）

### ⑧ 其它與「不做」
- 保持：shadow-projection（優勢位）；`resetWindow` 層；fail-soft；無 remote compaction（自研 fetch）；無模型可控 rollover 工具（IH 已可在策略中調 resetWindow）
- 不學：codex 快照重寫（偏見+複雜三套）；opencode char/4；cc 的 cache-fork 實驗（微妙不變量）；dsh 的括號鎖+invariant（對 IH 可選——若未來做 M 級加固話題，M34+ 評估——**IH 的 re-fire guard 已部分替代**）

## 5. M33 建議範圍（優先序）

1. ① anchored（S）＋ ⑥ 提示（S）——同任務（summarizer 重構）
2. ④ 磁滯+熔斷（S）
3. ③ 計數完整性 overhead（S–M）
4. ② prune pass（M）
5. ⑤ 命令面（S）
6. ⑦ analytics（M，可 M34）＋ per-model 策略（M，可 M34）

## 6. 參考
- 本報告四家源（§0 樹）；IH 側：`packages/compaction/*`、`packages/core-agent/src/index.ts`（enforceBudget）、`packages/token-meter`、`docs/superpowers/specs/2026-08-20-i-harness-m11-compaction*design.md`（shadow 基線）、`docs/superpowers/plans/2026-08-20-i-harness-m11-compaction.md`
- 前代：`docs/research/2026-08-31-dsh-a1-to-a3-delta.md`（alph.3 的 compaction/start|summary|end|prune 事件定義）、`2026-09-02-dsh-a4-to-a5-delta.md`
