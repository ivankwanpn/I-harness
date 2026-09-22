# I-harness 後端打磨路線圖（2026-09-15）

> **基準**：`m64` @ `d66c28b7` · **範圍**：後端（`packages/*` 的 64 包 ＋ `apps/cli`；**已排除前端四包** `tui`、`tui-core`、`web`、`web-host` —— 2026-09-15 隨 §5 Q6 更正：原記為 65 包，即已排除前三包但仍含 `web-host`，而 `web-host` 是 web 前端的宿主，§3.M6 已因其預定汰換而刪去相關工作）
> **輸入**：`docs/audit/2026-09-11-ih-backend-inventory.md`（D1）、`docs/audit/2026-09-11-sevenway-command-matrix.md`（D2）、`docs/audit/2026-09-11-sevenway-backend-mechanisms.md`（D3）、`docs/audit/2026-09-15-backend-gap-triage.md`、`docs/superpowers/specs/2026-09-14-backend-permission-sandbox-design.md`
> **方式**：以上述文件為**輸入**，但**逐項對現行 HEAD 重量之後**才寫進本路線圖（見 §1.1）

---

## 0. 這份文件是什麼、不是什麼

**是**：**排序與界線**。它決定先做什麼、什麼必須等什麼、每個里程碑的完成定義，以及明確不做什麼。

**不是**：spec 的替代品。每個里程碑動工前**才**寫自己的 spec 與實作計畫（`docs/superpowers/specs/`、`docs/superpowers/plans/`）。本文件不展開實作細節。

它同時是一份**可被推翻的預設路徑**：§5 列的問題若有了答案，對應里程碑就跟著改。§5 中我已自行判斷的項目，是「工程判斷」；標為**需要你決定**的兩項是「產品定位」，我不替你定。

---

## 1. 方法與不變式

七條，每個里程碑都適用。

### 1.1 重量原則（最重要的一條）

**任何引用自 D1/D2/D3/triage 的項目，進 spec 前必須對現行 HEAD 重量。**

理由不是理論，是實測。D1 的基準是 `m62 @ 8f2b62c4`，**早於**沙箱里程碑落地。2026-09-15 對 D1 第 8 條（「已宣告、已測試、但無生產呼叫者」）抽樣 8 項，**2 項已被修好**：

| D1 的斷言 | 重量結果 |
|---|---|
| 沒有任何 tool schema 宣告 `sandbox_permissions` | **已修** —— `packages/fs/src/index.ts:81,247,250` |
| 沙箱升級模組只出現在測試裡 | **已修** —— `packages/sandbox/src/denial.ts:91,93` 使用 `WIDER_MODES` |
| `buildWireClient` 僅測試使用 | **已解決（Phase B Task 4 刪除宣告，`24e9395`）** —— baseline §4.1 item 3 記為 `already-fixed`；此列寫的「仍成立」是 Phase A 當時的判定 |
| `mountPreset` 無生產呼叫者 | 仍成立（非測試只有一句註解，`tui/src/views/light-personas.ts:2`） |
| `withdrawPlanModeTool` 無呼叫者 | **已解決（Phase B Task 4 刪除宣告，`24e9395`）** —— baseline §4.1 item 5 記為 `already-fixed`；此列寫的「仍成立」是 Phase A 當時的判定 |
| `sandbox/mode` 事件沒有生產者 | **生產者已補上（Phase B Task 1，`34c746e6`，建構期）**，但**「session 中途被收緊」仍不可達**——baseline §4.1 item 6／§4.4 item 4 把這條重新界定成後者；設計 spec §7 第 4 條同步更正 |
| `tui --yes` 被解析但從未被讀 | 仍成立（`apps/tui/src/index.ts` 5 處出現，無一處讀它做決定） |
| `estimateAssemblyOverhead`／`bindAuthRefreshStatus` 套件外不可達 | **需精確化** —— 兩者在 `assembly.ts` **內部**被使用（`:762`、`:618`），D1 的措辭聽起來比實際嚴重 |

**一個日期不明的引用，等於沒有引用。**

### 1.2 無引註不進路線圖
每一項都要有 `file:line` 或一個實測數字。這是 D1 自己的硬規則，此處沿用。

### 1.3 每個里程碑都要有「它不保證什麼」
沿用 `docs/handoff/HANDOFF.md` §9 的做法。**一個只說自己保證什麼的里程碑，就是下一個 `m63`。**

### 1.4 分級在進路線圖時就定

| 級 | 適用 | 程序 |
|---|---|---|
| **S** | 單點修正，影響面明確 | 一個任務 ＋ **紅先測試 ＋ 變異證明**；不單獨寫 spec，由里程碑的計畫彙整 |
| **M** | 新增接縫或改變契約 | 完整 spec ＋ 計畫 |
| **L** | 改變別人依賴的介面、或崩潰語意 | 完整 spec ＋ 計畫 ＋ **互不重疊 scope 的最終審查**（沙箱那次的做法） |

### 1.5 路線圖不是 spec 的替代品
每個里程碑動工前才寫自己的 spec 與計畫。本文件只給順序、依賴、完成定義。

### 1.6 每一項標明「取樣」或「自創」
本專案的方法是**參考七源、取長補短、重新設計**。不標的話，讀者會誤以為每一項都溯源自某個源。M2 是第一項**自創**，且已實測確認七源皆無（§3.M2）。

### 1.7 過程約束（沿用 `m62`，仍然有效）
無紅先測試 ＋ 變異證明，不得動生產程式碼；推送只到里程碑分支；`main` 的合併時機由人決定；沙箱設計 §5 的三條排除是**約束不是選單**（見 §4）。

---

## 2. 里程碑總表

| # | 里程碑 | 分支 | 分級 | 取樣／自創 | 依賴 |
|---|---|---|---|---|---|
| **M1** | 可達性：重量 → 誠實化 | `m64` | S 為主 | 自創（清單來自 D1，但每項需重量） | — |
| **M2** | 可達性閘門 | `m64` | M | **自創**（七源皆無） | M1 |
| **M3** | 量測底座 | `m65` | M | 取樣（dsh 的 telemetry）＋ 自創（harness） | — |
| **M4** | 耐久 turn 狀態機 | `m66` | **L** | 取樣（opencode-fork 999.0.20 的 kernel） | — |
| **M5** | 一致性：工具管線 ＋ prompt 快取 | `m67` | M | 取樣（dsh、cc-custom） | M3（T2 部分） |
| **M6** | 廣度：生態 ＋ 介面硬化 | `m68` | M | 取樣（dsh、codex、grok） | M5 |
| **M7** | 自我喚醒與記憶 | `m69`（**⚠ 這個名字已於 2026-09-22 被 §9.2 C1 的孤兒 `operator/run-end` 用掉**；而 M7 降 S 後**不需要分支** ⇒ 衝突自動消失） | ~~M 或 S~~ → **S**（2026-09-22 裁定） | 取樣（codex、grok） | ~~M4；且需 §5 Q1／Q2 的答案~~ → **✅ 兩題皆已答**（Q2 於 2026-09-20「否」、Q1 於 2026-09-22「暫不」）⇒ **降 S，不實作**，見 §3.M7 的 2026-09-22 段 |

M1 與 M2 **共用分支 `m64`**：兩者是同一個關注點（可達性），且 M2 的基線**來自 M1 的重量結果**。

> ### ⚠ 現況附註（**2026-09-21 重量；上面那張表是設計，不是事實**）
>
> 六天之後回量，**上表的「分支」欄已經漂移，而「狀態」欄要補**：
>
> | 里程碑 | 上表說的分支 | **工作實際上落在哪** | **2026-09-21 的狀態** |
> |---|---|---|---|
> | **M1／M2** | `m64` | `m64` | ✅ 完成 |
> | **M3** | `m65` | `m65` | ⚠ **3 完成 · 1 一半 · 1 有處置** —— bench／崩潰＋優雅關閉／metrics 完成；**站點分級未做**（今天 **110** 個 `console.warn/error` 站點）；**redaction 處置為「繼續量」**。**而 §3.3 的 `@i-harness/diagnostics` 套件從來沒有被建出來**（`I_HARNESS_LOG`／`createDiagnostics`／`createRedactor` 全樹 0 命中）。**▶ 2026-09-22 補記（這一格是 2026-09-21 的讀數，補記只加不刪）：「1 一半」（站點分級）已由 W6 收線** —— `@i-harness/diagnostics` 已建、全樹 **107 站 ＝ 94 分級 ＋ 13 列名例外**（`apps/cli` 50＋10；packages 44＋3；記錄 `docs/handoff/2026-09-22-w6-diagnostics.md`，舊的 79／80／103／106／110 那一串全部作廢）；**「1 有處置」（redaction）也由 W6 建了 `createRedactor`**（三趟掃描、token 恰為 `[REDACTED]`，`createCliDiagnostics` **按構造**要求它 ⇒ 未遮蔽的實例建不出來）—— 原處置「繼續量」被一次實作取代，**但是否等於 §3.5 收線以 W6 的記錄為準**（進度的家那一格的原文仍寫「缺口示範不出來」）。**⇒ M3 的五項：4 完成（bench／崩潰＋優雅關閉／結構化診斷日誌／metrics）＋ redaction 已建濾網。** |
> | **M4** | `m66` | **`d4-endpoint-cache` → `m65`** | ✅ **工程完成，含本文件的驗收**（殺行程、讀裁決 —— `m4-crash-acceptance.test.ts` 是真的 spawn ＋ SIGKILL）。**只差 Q8** —— **▶ 2026-09-22 補記：Q8 已由 owner 裁定「保守：一律 `outcome-unknown`」** ⇒ 「只差 Q8」的那一件（W9）**解除、待做**（進度的家 §9.2 的 A4）。**注意：裁定本身還沒實作** —— 今天 marker-less 的舊日誌仍落進 `TOOL_ABORTED_BEFORE_DISPATCH`（`packages/session-persistence/src/repair.ts`） |
> | **M5** | `m67` | **`d4-endpoint-cache`** | ✅ 完成（T2 兩半 ＋ T4 三塊） |
> | **M6** | `m68` | — | 未開始。**依賴 M5 已解除，但那不是「可寫計畫」**：本文件 §1.1 要求引用的 triage 項**進 spec 前對現行 HEAD 重量**（那些量於 2026-09-11）。**▶ 2026-09-22 補記（這一格是 2026-09-21 的讀數，補記只加不刪）：工作實際落在 `m68`，而它已**✅ 四批完成** —— 重量（`2026-09-21-m6-precedent-synthesis.md`）→ spec（`2026-09-21-m6-breadth-design.md`，owner 2026-09-22 核准）→ 計畫（`docs/superpowers/plans/2026-09-22-m6-breadth.md`）→ 四批實作（`eb34df41`…`e69f0c06`，12 個提交），收尾 `pnpm verify:all` 五步全綠。明細在進度的家：`docs/handoff/2026-09-20-queued-work.md` §9.1／§9.2 A3。** |
> | **M7** | `m69`（**這個名字已於 2026-09-22 被 §9.2 C1 的孤兒 `operator/run-end` 用掉並合併**） | —（**降 S ⇒ 不需要分支**） | **✅ 2026-09-22 裁定：不實作** —— Q2 於 2026-09-20 裁定「否」、**Q1 於 2026-09-22 裁定「暫不」** ⇒ §3.M7 的降級條款成立 ⇒ **S，終點是把非目標寫進文件**（§3.M7 的 2026-09-22 段 ＋ §4 的 `T6` 條） |
>
> **⇒ 三件給接手者的話：**
> 1. **分支欄是意圖，不是事實** —— **M4 與 M5 都落在 `d4-endpoint-cache`**，而它已於 2026-09-21 快進合併進 `m65`。
> 2. **`m66` 這個名字已經被 M4 用掉，而 M4 驗收完了** ⇒ **下一個里程碑要開哪個名字，是一個要決定的問題**，不是自動的。
> 3. **§1.7 的「推送只到里程碑分支」仍然有效。**
>
> **進度、開放項、與每一項在等什麼：`docs/handoff/2026-09-20-queued-work.md`（那是進度的家）**；本文件的 §1.1 重量規則與 §1.7 過程約束**是約束，不是選單**。

---

## 3. 各里程碑

### M1 — 可達性：重量 → 誠實化

**它讓什麼變得不一樣**
之後讀到「這個能力存在」時，它真的在**出貨路徑**上。今天不是這樣：`sandbox/mode` 這個事件**沒有任何生產者**，也就是說「session 中途被收緊」——整個 per-call 政策設計存在的理由——在生產上不可達；而 TUI 這個主要互動面根本不組沙箱（`sandbox` 這個字在 `apps/tui/src/index.ts` 一次都沒出現）。

**⚠️ 設計要點：M1 以「重量」開場，不以「修清單」開場。**
理由就是 §1.1 那張表 —— D1 的基準早於沙箱里程碑。**M1 的第一個任務是拿 D1 的清單與沙箱 spec §7 逐條對現行 HEAD 重量**，產出一份標好「已修／仍成立／需精確化」的表。**那張表才是 M1 的工作範圍。**

**證據（輸入清單，全部需重量）**
- D1 第 8 條那批（上表 8 項）
- D1「未竟事項的誠實清單」：`core-session` 的 `migrate()` 是 no-op 佔位；`goal` 的 round admission 宣告未實作（`GoalView.round` 從未填充）；`session-query` 的 `SearchHit.time` 是索引重建時間而非事件時間；`output-retention` 的裸 `createSpillStore` 永不清理；`workspace` 明確延後 `delete`/`insertBefore`/`follow`/`status`；`lsp` 強制一個 run 一個 server
- 沙箱 spec §7 的四條殘留：shell 的 runtime denial 未分類（`classifyDenial` 的呼叫者只有測試）；`exitCode: -1` 六義；`allowed-once` 在操作本來就因別的理由不合法時被消耗；**3.1 要修的情境在生產路徑上沒有生產者**
- CLI 面：`tui --yes` 被解析但從未被讀；未知子命令不被拒絕；無任何 parser 支援 `--flag=value`；`i-harness run --help` 會執行一個 task 字面為 `"--help"` 的 headless turn

**依賴**：無。這是唯一可以立刻開工的里程碑。
**分級**：以 **S** 為主；任何需要改介面的項目在重量後升級為 M 並另開 spec。
**完成定義**：每一個「仍成立」的項目要嘛接上生產路徑、要嘛**明說它是刻意的**（例如 `sdk` 的公開 API 本來就不該有內部呼叫者）並記進一份**帶理由的 allowlist**；重量腳本可重跑。
**它不保證什麼**：**不保證所有未接線的表面都找到了** —— 只保證抽樣過的與清單上的。這正是 M2 存在的理由。

### M2 — 可達性閘門

**它讓什麼變得不一樣**
M1 是**一次性**的。沒有 M2，同樣的東西會用同樣的方式長回來。這個 repo 已經發生過三次：沙箱（fs 路徑不查模式，2026-09-14 才修）、壓縮（宿主從未傳 `compact`，2026-09-14 才修）、TUI（不組沙箱）。**這是模式，不是個案。**

**自創，且已實測確認七源皆無**
掃過七源的 manifest（ih 71、dsh 290、codex 146、opencode 40、opencode-fork 40、grok 99、cc-custom 4，共 690 份 `package.json`／`Cargo.toml`），**沒有任何一家使用 knip／ts-prune／unimported／depcheck／cargo-udeps 這類死碼或未使用匯出工具**。所以這一項沒有參考實作可循 —— 它是自創，也因此風險較高，必須先在基線上證明自己。IH 的零外部依賴紀律本來也不允許直接引入這些工具。

**設計：枚舉五類「已宣告」**
1. 匯出符號無非測試 importer
2. 事件型別無生產者
3. 選項被解析但從未被讀
4. 能力被宣告但從未被推入
5. 設定鍵有 schema 但無人查詢

**關鍵設計：基線 ＋ 棘輪，不是一次大清倉。**
現存孤兒數量不可能一次歸零，所以閘門**只對「新增的孤兒」失敗**，既有的記進基線。另需一份**帶理由的 allowlist**（`sdk` 的公開 API 是刻意的），否則閘門會被例外淹沒而失去意義。

**證據**：五類各有一個實測例子 —— `buildWireClient`（類 1）、`sandbox/mode`（類 2）、`tui --yes`（類 3）、能力閘（類 4）、`compaction.auto`（類 5）。
**依賴**：M1 完成（基線要從 M1 的重量結果來）。
**分級**：**M**。
**完成定義**：腳本可重跑；對**故意新增**的一個孤兒會**失敗**（變異證明）；基線與 allowlist 都帶日期與理由。
**它不保證什麼**：**不保證可達的東西是對的** —— 它只證明「有人呼叫」。一個接了但接錯的生產者會通過這道閘門。

### M3 — 量測底座

**它讓什麼變得不一樣**
一個改動是好是壞**可以量**，不必靠人重讀程式碼。

**證據**
- 沙箱 spec §7 記載：`0.056–0.125 ms/call` **「沒有任何 repo 裡的東西能重現它」**；而守護它的測試收緊到 2 ms 之後，一個**語意相同的 10 倍變異仍然通過**（量到 `1.002 ms/call`）。同一節直接寫明「**IH 沒有 benchmarking harness（dsh 有）**」。
- T3 的 `otlp-telemetry-export-with-span-attribution`：據 triage，其 `who has it` 一欄**點名其餘六源全部** —— 是整份矩陣裡最接近「IH 獨缺的普遍能力」的一列。
- `fail-loud-crash-handling-and-graceful-shutdown`：IH 無崩潰處理。

**範圍（依 §5 Q5 的判斷：先做本地，OTLP 延後）**
benchmark harness；本地結構化診斷日誌；fail-loud 崩潰處理與優雅關閉；secret redaction（`retention-and-secret-redaction` 與 `secret-redaction-before-log-and-sink` 是同一個缺失濾網的兩域視角）；in-process 診斷 metrics registry。**OTLP 匯出延後到有 collector 的時候。**

**依賴**：無硬依賴，但**必須排在 M4 之前** —— 否則 M4 的驗證只能像沙箱那次一樣靠人工複讀。
**分級**：**M**。單一自然歸屬（`telemetry` ＋ `apps/cli`，additive，不動引擎）＋ 一支自寫 harness。
**完成定義**：harness 能**偵測一個 10 倍退化**（證明它是偵測器而不是天花板）；一次失敗的執行不需要人手讀 JSONL 就能定位。
**它不保證什麼**：**不保證數字跨機器可比。** 2026-09-15 實測：這台機器 node 是 v22.23.2（`HANDOFF.md` 記的是 v24.15.0），`bash` 解析到 Git Bash 而非 WSL，因此該文件記載的兩個 `session-executor` 紅燈**在這裡不紅**。**所以基線必須連同機器指紋一起記錄。**

### M4 — 耐久 turn 狀態機

**它讓什麼變得不一樣**
一個被殺掉的行程，從「剛才那個工具有沒有跑？」這種**無法回答的疑問**，變成**已記錄、可續行的事實**。這是整份路線圖裡**唯一一個「崩潰會產生錯誤答案」而不是「少一個功能」**的主題。

**證據**
- T1 約 11 列。IH 對**子代理任務**已有 `durable-delegated-task-protocol-with-identity-cas`（含依日誌分類的崩潰復原）—— **正是因為子代理那側看起來解決了，才反襯出父 turn 這側沒有 lease/generation**。
- `pre-side-effect-durability-checkpoint`：報告評為「極小但值得自建」。
- `durable-restore-without-re-append`：證明 IH 已知道如何在不重新 append 的前提下還原日誌。

**⭐ 參考實作就在手邊**
最好的來源是 **opencode-fork**，機制名 `durable-turn-attempt-state-machine`。2026-09-15 實測確認 `D:/opencode-fork-999.0.20`（HEAD `0241f446`）的 `packages/core/src/session/kernel/` 內含 `coordinator.ts`（828 行）、`lifecycle-store.ts`（929 行）、`recovery-planner.ts`（179）、`recovery-executor.ts`（197）—— 也就是 lease／generation／崩潰裁決那一整套。**這正是 `m63` 上被錯誤除名的那批機制所描述的東西。**

**依賴**：**它是 T5 的前置** —— 沒有 attempt record 的自動喚醒，等於一台無人看管的迴圈產生器。
**分級**：**L** —— 動到 `core-agent`、`core-session`、`session-persistence`、`session-persistence-jsonl`、`session-executor`，都是別人依賴的介面。不需要新套件。
**完成定義**：**在工具呼叫中途殺掉行程**，斷言續行的 session 到達一個**已記錄且正確**的裁決 —— 不是靠讀程式碼。
**它不保證什麼**：**不保證續行 turn 的內容是對的** —— 只保證裁決是「記錄下來的」而不是「推論出來的」。

### M5 — 一致性：工具管線 ＋ prompt 快取

**它讓什麼變得不一樣**
工具呼叫有**一個**誠實的契約說「這次呼叫可以消耗什麼」，而不是四個各自部分的；長 session **不再在每次壓縮後默默付全額**。

**證據（T4，已對 triage 更正）**
triage 把三列寫成「not 'missing code' but 'code that is false'」，讀起來像 IH 有假程式碼。**實測不成立**：那三列（`streaming-tool-executor-mid-stream-start`、`per-message-aggregate-result-budget`、`blocking-sleep-command-guard`）在 IH **全部是 `(none)`**，唯一持有它們的是 **cc-custom**，而死旗標是**cc-custom 自己的** —— 那正是處置為 `rewrite` 而非 `reuse` 的原因。**IH 真正缺的是**：統一的 tool-result schema 驗證層、連坐到同批兄弟呼叫的取消。**取樣：dsh**（管線 ＋ schema）。

**證據（T2）**
IH **完全沒有 prompt cache 的概念** —— 全 inventory grep `cache` 只得到 instruction 檔的 stat cache、模型發現快取、Windows ACE，**沒有一個字講到請求前綴**。時機就是理由：壓縮**直到 2026-09-14 才接進出貨宿主**，所以它一開始運作，IH 就開始讓**從未量測過**的前綴失效。**取樣：dsh**（`canonical-request-epoch`）＋ **cc-custom**（偵測那一半）。

**§5 Q3 的判斷：不發明統一的 epoch 抽象。**
各線協議的快取語意不同（Anthropic 是顯式斷點，OpenAI 是自動前綴匹配），所以「一個 epoch 概念」很可能是錯的抽象。改為兩半，兩者都與協議無關：
1. **以 provider 回報為事實** —— 記錄每次請求對方回報的快取讀取量，由此**推導**連續性，而不是**預測**它。
2. **以自己的位元組為偵測** —— 比對這次送出的前綴與上次是否相同（cc-custom 的偵測想法）。這與協議無關，因為比的是我們自己送出的東西。

這同時回答了 triage 的開放問題 5，也讓 M5 可以估工。

**依賴**：T2 受益於 M3（沒有 token 會計就無法展示快取連續性）。
**分級**：**M**。
**完成定義**：每個工具呼叫都在同一處被驗證／設界／可取消；快取連續性可從 provider 回報與自己的前綴比對兩方面觀察。
**它不保證什麼**：**不保證省到錢** —— 它保證的是**看得見**。實際節省取決於 provider 的快取政策與工作負載形狀。

### M6 — 廣度：生態 ＋ 介面硬化

**它讓什麼變得不一樣**
MCP 與 skills 不再是淺整合；`@i-harness/sdk` 的 wire 在慢客戶端與不可信客戶端下仍然正確。

**⚠️ 範圍更正（2026-09-15，人類決定 Q6）。** 這一節原本的另一半是「web host 在慢客戶端與不可信頁面下仍然正確」，完成定義也要求「web host 的握手與背壓有測試」。**既然現有 TUI 與 web 預定汰換（§5 Q6），對 `packages/web-host` 做硬化就是對即將丟棄的程式碼投資 —— 這半刪除。** 但**概念不刪，改掛到 wire 上**：`session/event` 是 append-only 且**不重播**（`packages/sdk/src/protocol.ts` 的 Replay semantics），所以「慢客戶端」與「背壓」是**契約問題**，不是某個 host 的實作問題 —— 對未來的新前端一樣要緊，因此它們屬於 `packages/sdk`。T7 那兩列（連線握手、輸出背壓）的價值也在這裡，不在舊 web host。

**證據**
- T8 是安全性之後**最大的 active 叢集**（13 列）。IH 的底子已經不錯（`plugin-event-kernel-with-four-extension-channels`、`skill-md-deferred-retrieval-with-a-shadow-selector`、`mcp-client-with-generation-based-reconnection-and-oauth`），**所以剩下的都是淺缺口而非結構缺口**。
- T7 只有兩列被 triage 評為「值得做」（連線握手、輸出背壓），但**真正的獎品是 config 那兩列**（`settings-seam`、`operator-config-layer-stack`），理由很硬：**2026-09-14 那個壓縮接線 bug 是 settings／assembly 契約失敗，不是壓縮失敗。**

**§5 Q4 的判斷：不做 MCP server 模式。**
triage 第 3 題（「誰是第二個消費者？」）repo 內沒有答案，而這與「不為假想消費者建東西」的既有紀律一致。`以 MCP 伺服器模式暴露自身` **延後到有具名消費者為止**。M6 的 T8 範圍因此收斂為**攝取側**：catalog ingest hardening、elicitation、resources、transport variants，加上 skills 的可發現性。

**依賴**：M5（工具管線是 MCP 工具進來的入口）。
**分級**：**M**，且增量。
**完成定義**：MCP 的攝取面有硬化過的測試；skills 可被發現而非只是可載入；**`@i-harness/sdk` 的 append-only `session/event` 語意與背壓在 wire 層有測試**（原為「web host 的握手與背壓有測試」，2026-09-15 隨 Q6 改）；`settings-seam` 與 `operator-config-layer-stack` 有契約測試。 **▶ 2026-09-22 補記（這一格是 2026-09-15 的原文，補記只加不刪）：最後一格的兩項與量到的事實不符，owner 2026-09-22 已隨 M6 spec 一起核准修正 —— 見 `docs/superpowers/specs/2026-09-21-m6-breadth-design.md` §7：`settings-seam` 的契約測試**已存在**（`sections.ts` 的既有測試；缺的是消費者，wire 的 settings 面是 Q7 觸發時的工作），`operator-config-layer-stack` 的來源歸因 **park 到有宿主顯示它為止，本里程碑不含**。**
**它不保證什麼**：**不保證第三方實作真的相容** —— 那需要一個外部消費者，而目前沒有。

### M7 — 自我喚醒與記憶

**它讓什麼變得不一樣**
IH 能在**沒有任何外部事件**的情況下自己開始一個 turn（而且有上限，不會變成無人看管的迴圈）；agent 能寫下跨 session 的持久事實。

**⚠️ 範圍更正（2026-09-15，實測後）。** triage 的主題摘要把三件不同的事綁成 T5，但其中**只有一件 IH 缺** —— 而且三個都叫「wake」，所以容易混：

| | 誰有 | IH |
|---|---|---|
| **事件喚醒**（有通知／有活，喚醒 session） | IH、opencode-fork、codex、cc-custom、opencode | **有** —— `durable-parent-wake-delivery`，**五源共享列**，處置 `improved-writing` |
| **持久計時器喚醒** | IH、dsh | **有** —— `schedule-durable-timer-wakeups`，處置 `improved-writing` |
| **喚醒合併** | opencode（`v2-run-coordinator-coalescing`） | 無 |
| **無外部觸發的自啟** | **只有 codex** | 無 |
| **抑制閘**（喚醒前七項條件存疑即不喚） | **只有 grok** | 無 |

**所以 M7 的 T5 範圍只含後兩者**；事件喚醒與持久計時器已經有了，列入 §4「不重做」。

**為什麼排最後**
這兩個不是工程問題卡住，是**產品問題卡住**：
- **T5**：`idle-wake-and-self-tick-initiation`（「閒置觸發須有來源與上限」）與 `seven-input-auto-wake-suppression-gate` 是**政策列假裝成工程列**。沒有答案，任何 T5 工作都是投機。且**必須等 M4** —— 沒有 attempt record 的自我喚醒就是迴圈產生器。
- **T6**：卡在沙箱 spec §7 **唯一真正未答的問題**（IH 要不要有專案層設定信任），而且與 §5 拒絕權限的**是同一個失敗模式**：多一個地方放持久 agent 狀態 ＝ 第二個真相來源。

**⚠️ 兩份參考都不完整，這是實測的：**

- `proactive-self-tick-loop`（triage 說「實作完整但全站未接線」）**唯一持有者是 cc-custom，IH 是 `(none)`** —— 那句話描述的是 **cc-custom 自己的** loop 死在那裡，這正是處置為 `rewrite` 而非 `reuse` 的原因。**IH 沒有這個實作，所以沒有「未接線的自我 tick」可修。**
- **opencode-fork 沒有自我喚醒。** 直接掃它的 `packages/core/src` ＋ `packages/opencode/src`（765 個 TS 檔）：`selfTick`／`self-tick`／`proactiveTick`／`idleWake`／`idle-wake`／`WakeReason`／`notifyWake`／`autoWake` **全部零命中**。它有的是 `wake(sessionID)`，而 `execution.ts` 對它的定義是 **"Registers newly recorded work"** —— 要求工作**已經存在**，是事件驅動，不是自啟。

**依賴**：M4；且需 §5 Q1／Q2 的答案。
**分級**：**M**；若答案是「不做」，降為 **S**（把非目標寫進文件即可）。
**完成定義**：取決於 §5 Q1／Q2 的答案。
**它不保證什麼**：**在有答案之前，它什麼都不保證。**

> **✅ 2026-09-22 落地（owner 裁定：Q1 ＝ 暫不）—— 本節降 S，而 S 的交付物就是這一段。**
>
> Q2 於 2026-09-20 裁定「否」、**Q1 於 2026-09-22 由 owner 裁定「暫不」**（理由照 §5 Q1 列的原句：與 §5 拒絕權限相同的「**第二個真相來源**」論證）。
> ⇒ 依上一段的降級條款，**M7 不是一份實作計畫**：**T5（無外部觸發的自啟）與 T6（記憶子系統）兩者都不做**，非目標就地記進 **§4 明確不做**（`T6` 那一條已改為「已裁定不做」）。
> ⇒ **分級 S** —— 但**這一格的 S 沒有「紅先測試」可寫**（§1.4 的 S 形狀是給「有東西可實作的修正」）：沒有要實作的東西，交付物就是**非目標本身**（§4 的那一條 ＋ 本段 ＋ §5 的兩列答案）。
> **它不保證什麼**：**在答案到來之後這句話依然成立** —— 答案是「不做」，所以 M7 保證的是**什麼不會被建**，不是什麼會被建。

---

## 4. 明確不做

**這是約束，不是選單。要推翻必須先改文件並說明理由。** 來源是沙箱設計 §5 與 triage §4 的收斂：

- **權限規則引擎** —— 會產生「規則說可以、沙箱說不行」兩個真相來源
- **企業治理層**（MDM、簽章政策）—— 取了會是儀式而非安全
- **`auto-mode-llm-danger-classifier`** —— 方向與 IH 的 guardian 相反，同時裝會互相抵消
- **任何讓 IH 執行外來程式碼的主題**（plugin VM、sandboxed code execution、code-mode JS host、PTC）
- **大部分 `service` 域的遠期產品工作**（remote attach、relay、workspace routing、sidecar、voice —— 沒有消費者）
- **向後相容的 scaffolding**（IH 無舊帳：remote-sandbox backends、host-tool-definition compat shims、plugin-v1 bridge）
- **T6 作為「建記憶子系統」** —— **✅ 2026-09-22 由 owner 裁定：不做**（原句是「未回答專案信任問題前不動」，而問題已回答，答案是**不動**）。**同一裁定的另一半是 T5（無外部觸發的自啟）：M7 整節因此降 S —— 見 §3.M7 的 2026-09-22 段落**
- **重做 `durable-parent-wake-delivery`、`schedule-durable-timer-wakeups` 或 `durable-notification-outbox-with-injectable-admission`** —— 這三列 IH 已有，前兩列的處置是 `improved-writing`（「IH 有，且不遜於任何參考源；保留，不要退步」），第一列更是**五源共享列**。重做就是退步。

---

## 5. 待決定

**工程判斷（我已定，記錄理由，可被推翻）**

| # | 問題 | 判斷 | 理由 |
|---|---|---|---|
| Q3 | 跨 provider 的快取抽象 | **不發明統一 epoch**；改為「provider 回報為事實」＋「自己的位元組為偵測」 | 各協議語意不同，「一個 epoch」很可能是錯的抽象（§3.M5） |
| Q4 | 誰是第二個消費者 | **不做 MCP server 模式**，延後到有具名消費者 | 與「不為假想消費者建東西」的既有紀律一致 |
| Q5 | operator observability 範圍 | **先本地**（結構化日誌、崩潰處理、redaction、metrics registry）；**OTLP 延後** | OTLP 要有 collector 才有用；triage 自己也說「本地結構化日誌可能就是全部的收益」 |

**需要你決定（產品定位，我不替你定）**

| # | 問題 | 我的建議 | 卡住誰 |
|---|---|---|---|
| Q1 | IH 要不要有**專案層設定信任**？ | **✅ 2026-09-22 owner 裁定：「暫不」**（理由照原句：與 §5 拒絕權限相同的「第二個真相來源」論證；等到有具體威脅或第二個消費者再回答）。**⇒ 依 §3.M7 的降級條款，M7 降 S ⇒ 終點是把非目標寫進文件** | M7／T6（**已解**） |
| Q2 | **閒置自我喚醒是不是產品目標**？ | **✅ 2026-09-20 owner 裁定：「否」**（原句：不作目標 —— IH 的價值是耐久、可審計、由人指揮的 harness；自我喚醒會改變那個定位）。**⇒ 與 Q1 合起來把 M7 降 S** | M7／T5（**已解**） |

**這兩題若你的答案與我相反，M7 的內容與分級跟著改；其餘里程碑不受影響。**

**由你決定並已決定（2026-09-15）**

| # | 問題 | 決定 | 理由與後果 |
|---|---|---|---|
| Q6 | 現有 TUI 與 web 的去留 | **預定汰換** —— 之後整個放棄現有的 TUI 與 web、重新建一個新的。**那是很後面的工作，不在 M1–M7 的範圍內**（2026-09-15 人類決定） | 所以本路線圖的「TUI／web 不動」不只是省工，是**策略事實**。關鍵後果：**未來前端的後端契約是 `@i-harness/sdk` 的 wire（`packages/sdk/src/protocol.ts`；`PROTOCOL_VERSION = 2`，v0 `FROZEN`、v1 `ADDITIVE-ONLY`，欄位級漂移哨兵在 `packages/sdk/test/server.test.ts`），而不是 in-process 的 `createSessionService` API。** 現有 TUI 的 `--attach` 已經是這條 wire 的生產消費者（`packages/tui/src/backend/remote.ts`），所以「重建前端」是一個**客戶端專案**，不是後端專案 —— 後端的責任是讓那條 wire 值得被蓋在上面。連帶兩點：舊 TUI／web 還在出貨期間，engine 改動仍須**向後相容**（`packages/tui` 依賴 `session-executor`，且被 `pnpm -r typecheck` 檢查）；一旦它們移除，唯一還須穩定的契約就是 wire。範圍更正見 §3.M6。 |

---

## 6. 這份文件如何腐爛與維護

**它會腐爛，所以寫明它怎麼腐爛。** D1 四天就過期了（§1.1）。

1. 每個里程碑記錄它的**量測日期與 commit**。
2. 一個里程碑若引用的量測**早於它所在區域最後一次動到程式碼的 commit**，就**必須重量**（§1.1）。
3. 里程碑完成後移入「已完成」，**連同它實際達成什麼、以及沒達成什麼**一起記 —— 不是只打勾。
4. §5 的問題一旦有答案，對應里程碑的那一節就地更新，並註明是誰在何時決定的。
5. **這份文件的第一次審查（2026-09-15，人類複審）就產生了一次範圍更正**：M7 的 T5 範圍由「喚醒與延續」縮為「自我喚醒與抑制閘」，因為實測顯示 IH 已有事件喚醒與持久計時器，而 opencode-fork 的 `wake` 也是事件驅動。**這是 §1.1 重量原則的第一次實際作用，不是例外。**

---

## 7. 這份路線圖沒有建立什麼

- **我沒有重跑 D1/D2/D3 的抽樣。** §1.1 的重量只涵蓋 D1 第 8 條的 8 項抽樣。其餘引用項目在進各自 spec 前仍需重量。
- **我沒有驗證 triage 那 233 條「真缺口」。** 我獨立重算了它的計數（434／344／各域分布／處置分布，**全部吻合**），但**沒有**逐條核對那 16 個「假缺口」以外的品質。triage 自己標示該數字可信度為「低到中，當 225–245 看」。
- **我沒有估工。** 里程碑的「小／中」是相對排序，不是人日。
- **我沒有回答 §5 的 Q1／Q2。** 那是產品定位。
- **我沒有動任何生產程式碼。** 本文件是唯一的產出。

---

*方法註：本路線圖的每個里程碑欄位（它讓什麼變得不一樣／證據／依賴／完成定義／它不保證什麼／分級／取樣或自創）是刻意固定的 —— 缺任何一欄，它就會變成一份願望清單。*
