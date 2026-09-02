# I-harness M33 設計：compaction 六項吸收（四路研究落地）

> 2026-09-02。範圍 = `docs/research/2026-09-02-compact-fourway.md` §4 的 ①–⑥；⑦（per-model 策略 + analytics）留 M34。
> Global Constraints：零新依賴；ESM strict；Windows 優先；fail-closed/soft 現狀維持；append-only 鐵律（shadow-projection 永不改寫事件）；既有測試除明列外不破。

## 0. 範圍表

| # | 項 | 來源 | 組 |
|---|---|---|---|
| ① | anchored 增量摘要 | opencode | G1（summarizer 重構 + ⑥） |
| ⑥ | 摘要提示結構化（8 節） | cc/dsh/opencode 交匯 | G1 |
| ④ | 磁滯（3-turn）+ 熔斷（3-strike） | cc-custom | G2 |
| ③ | 計數完整性（overhead） | cc 教訓 | G2 |
| ② | model-free prune pass | dsh | G2 |
| ⑤ | 手動命令面 | dsh 形狀 | G2 |

## 1. Summarizer 重構（①+⑥，`packages/compaction/src/summarizer.ts`）

### 1.1 提示模板（⑥——8 節結構化）
```text
Objective            // 任務目標（首次）或「本次對話進展」
Important Details    // 事關正確性的事實/數據
Work State           // Completed / Active / Blocked 三欄（跨輪壓縮累積）
Next Move            // 明確下一步
Relevant Files       // 觸及的檔案路徑（保真）
Sensitive Instructions // 用戶指令中「不可丟失的原始措辭」逐字保留段
Tool Work Summary    // 工具調用目的與結果（簡述,不逐條）
```
- 「Do not mention the summary process」禁語；末尾 `<compacted-summary>` 框架維持（IH 現行）
- **敏感指令段**：掃描 shadow 區 user/message 中的指令性文本（緊跟 `agent/input` 或 `inject` 或系統注入 marker 的 user 消息）——v0 實施：「shadow 區內所有 user/message 中長於 32 字符的片段若含祈使（`修改|改成|不要|必須|禁止|切記|記得|remind` 等）則原文保留於敏感段」——**保守：字詞匹配僅作標記，不丟原文於提示**（執行者以最小規則落地並測試）

### 1.2 Anchored 更新（①）
- `summarizer.ts` **存在策略**：調用前掃 session 最後一則 `compaction/summary`——有 → 模板加 `<previous-summary>` 段 + 首行要求「**Update the anchored summary**（依新 shadow 區增量更新，不要重述舊內容）」；無 → 全新總結（現行為）
- 摘要輸入 = shadow 區（現行）+ previous summary 文本（有則附加）
- `compaction/summary` 事件形狀不變（每輪仍是新 summary 事件——歷史完整性）；anchored 是**提示語義**，不新增結構
- 測試：兩輪壓縮 mock——第一次生成 A；第二次 prompt 含 A 文本 + update 指令；事件兩個 summary

## 2. 磁滯 + 熔斷（④，`packages/compaction/src/index.ts`）

### 2.1 磁滯
- `CompactionConfig.minTurnsBeforeRecompact = 3`（default；`0`=純現行 re-fire guard）
- `maybeCompact`：計算「自最後 `compaction/end` 以來的 turn 數」（`turn/end` 計數）——`< minTurnsBeforeRecompact` → 不壓（在現行 re-fire guard 之後）
- 測試：壓縮後第 1/2 turn 壓力超限仍不壓；第 3 turn 壓

### 2.2 熔斷
- per-session（WeakMap）`consecutiveAutoCompactFailures`；`compactOnce`（僅 maybeCompact 路徑）失敗/返回 false → +1；成功 → 0
- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`：達到 → 暫停 auto 壓（`maybeCompact` 直回 false）直到**有新非標記事件**（new-content 重啟，同 re-fire guard 的判據）
- 測試：三連失敗 → 第四壓力不壓；新事件 → 重置

## 3. 計數完整性（③）

### 3.1 選項
- `CompactionConfig.overheadTokens?: number = 0`（default 保持現行為——**向後兼容**）；正整數校驗
- `checkBudget` 側：`AgentBudgetConfig` 加 `overheadTokens?`（0 default）
- `maybeCompact` 計數 = `activeTokens(session) + overheadTokens`（僅加）
### 3.2 assembly 提供（S 級估算）
- `packages/session-executor/assembly.ts`：當窗口已解析且無 host 提供 overhead → 估算：`systemPrompt 長度/4 + union(工具 schema JSON)。length/4`（`approxTokens` 同款——char/4 依 IH 既有估值器；標示「估算,僅調度用途」）
- 測試：overhead 傳入 → 臨界值行為（閾值 −1 與 +1）

## 4. model-free prune pass（②）

### 4.1 事件
```ts
// core-session union 加（M19/M21 慣例, version 1, log-only, 永不 shadow 自身）:
| { type: "compaction/prune"; version: 1;
    pruned: { callId: string; head: string; tail: string; removedBytes: number }[];
    seq?: number }
```
- **append-only**：原文不動；`deriveMessages` 在投影 tool/result 時查「本 session 最新 prune 事件中該 callId」→ 輸出 `head + "\n…(pruned " + removedBytes + " bytes)…\n" + tail`（替身）
- marker 排除：`region.ts isCompactionMarker` 加 `compaction/prune`（永不 shadow、不算 retain 尾、不再 re-arm guard）

### 4.2 執行（`index.ts` compactIfNeeded 前）
- 僅**壓力/overflow 觸發**且**選區未空**時：掃選區內 `tool/result` 的 `output`（stringify > `pruneChars=8192`）→ head/tail（4096/1024, 對齊现有 retention cap）→ 產出「擬 prune 清單」→ **替身計數**（估算投影後總量）→ 若替身後 < threshold → **只 append `compaction/prune` 事件，跳過摘要**（返回 `{compacted:true, pruned:true}`）；否則正常摘要（摘要輸入用替身渲染——`renderShadowed` 改為應用替身）
- 新 config：`prune?: { thresholdChars?: 8192, headChars?: 4096, tailChars?: 1024 }`（default 開——**隨 M33 啟用**；`prune:false` 關閉）
- 測試：大 result shadow 區 → prune 解壓（無摘要 call, spy 斷言）；prune 後剩超限 → 摘要輸入為替身；prune 不低於壓力時不觸發

## 5. 手動命令面（⑤）

### 5.1 命令
- `apps/cli/src/run.ts`（registerCommand 面）加 `session-compact`：`execute(input) → { t }` 解析 `{ instructions?: string }` → 調 assembly 的 compactor（agent 建構時已存在? **需要 assembly 暴露 compact 面**：`AssemblyOptions`/`SessionAssembly` 加 `compactNow?`（綁 createCompactionEngine 的 compact()））→ 回 `{ compacted: boolean, shadowedSeqs, summary?, error? }`
### 5.2 錯誤語義（dsh 六碼簡化）
- busy（step 中：enforceBudget 內部鎖?—— **v0**：僅 idle/serial lane 時可用——`executor.isRunning()` 檢查 → busy 錯誤文本）；cancelled（signal）→ 文本；summary（總結失敗 → fail-soft 現行:返回 false+警告——命令面回錯誤文本「summarizer failed」）；無可壓縮 → 「No compactable history yet.」
- 測試：命令註冊與回顯

## 6. 測試總量與排序

- G1（summarizer 重構）：①⑥ + 測試（~6 例）
- G2（index/region/derive/token/run）：②③④⑤ + 測試（~12 例）
- 最終：`pnpm -r test/typecheck/e2e` + smoke（web 路徑多輪壓縮 anchored 斷言; session-compact 命令）
- 注意：deriveMessages 的 prune 投影與 compaction shadow 的交互順序（shadow 優先——shadowed 區域不存在於模型面 → prune 僅影響「未 shadow」區域? **關鍵裁定**：prune 只作用於「**保持可見**的尾部 tool/result」與「**摘要輸入**」——shadow 區內容不進模型面,剪不剪無差;但摘要輸入 = 影子區文本 → 應用替身;可見尾部超限也剪（保上下文量）。**設計澄清写入 spec**:①摘要輸入用替身 ②可見尾部（keep 區）內大 result 也剪（同樣替身）——這是 dsh 的「剪完整舊結果」語義,避免 keep 內大塊占位
