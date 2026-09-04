# M42 — Rewind 引擎（後端快照/回滾）

日期：2026-09-05 · branch m42（自 main 出）· 源：參考研究（grok 本家機制——工具報告通道 + RewindPoint jsonl + 兩階段恢復 + 惰性衝突比對；codex 僅對話、opencode git-repo、dsh 無）。決策（用戶）：對話回滾 = **shadow 投影**（append-only 鐵則）；journal = **grok 式工具報告通道**（本家方案，非 fs 攔截）。

## 0. 目標與紅線

後端 rewind 服務：`points()`（turn 列表 + `· N files` 預覽）/ `plan()`（clean/conflict 兩階段 dry-run）/ `execute()`（恢復文件 + 對話 shadow + 截斷記錄）。**紅線**：JSONL 永不重寫（shadow 事件）；恢復在衝突時仍執行但如實標記（grok 語義）；無 pre-image 的文件（shell 觸摸）→ un-tracked 誠實列出、不猜測恢復。

## 1. 存儲（packages/rewind）

```
rewind/<sessionId>/
  points.jsonl        RewindPoint 每 turn/end 一條
  blobs/<sha256>      content-addressed pre-image（只有被寫前內容）
```

- `RewindPoint { turnIndex: number; anchorSeq: number; promptPreview: string; files: Array<{ path; status: "added"|"modified"|"deleted"; preBlob?: string; isNewFile?: boolean; afterHash?: string }> }`
- blob 內容即原文件字節（`added` 無 blob）；寫入為 temp+rename（原子）。

## 2. 通道（工具報告——遷就我們的架構）

- `packages/fs` 的寫管道（writeFile/editText/apply_patch 執行器）在**寫前**：若注入瞭 `RewindRecorder` 依賴 → `recorder.take(sessionId, turnAnchorSeq, path, beforeBytes|null)`（`null` = 新建文件；**每次 write 都 take，Recorder 端 or_insert 只留首個 pre-image**）；寫後回報 `preImageRef`/`isNewFile` 進入工具結果（結果字段——日誌即通道）。
- `packages/session-executor/assembly.ts`：創建 `RewindRecorder`（sessionId + workspace root——store 根 = workspace/.i-harness/rewind 或宿主 storeRoot）→ 注入 fs/attachment 系工具 deps；turn/end 事件（assembly 的 agent 循環鉤子已存在——append 迴路處）→ `finalize(turnIndex, anchorSeq, promptPreview)` 讀 recorder's touched → 寫 points.jsonl。
- shell 觸摸：不攔截（un-tracked；plan() 的未變更路徑清單不含它們——誠實)。
- **pre-image 的真實性**：fs 工具在讀後寫前抓取——TOCTOU 內已有 mtime 檢查；pre-image 以該次讀取為準（writeFileAtomic 讀-modify-寫環節）。

## 3. 服務面

`RewindService`（embedded 面）：
- `points(): { turnIndex; preview; files: number }[]`（from points.jsonl）
- `plan(targetTurnIndex, mode: "all"|"files"|"conversation"): { clean: FileOp[]; conflicts: ConflictOp[]; unTracked: string[]; ops: FileOp[] }`——惰性比對：每 touched 路徑：當前磁盤 vs 該 turn 的 afterHash（≥target 的最新 after 快照——用 blobs 記錄的 after 或被截斷後逐時序？grok: 最新 after-snapshot ≥ target；我們 turn 結尾已存 afterHash（read at finalize?——需 after 快照：finalize 時對 touched 集重讀 `afterHash`（cheap——只 touched 集）→ 存進 point；`plan` 時當前磁盤 vs point.afterHash → 相等=clean；不等=conflict（ConflictType 三值：以 blob/after 對照分類）。
- `execute(target, mode): { revertedFiles; conflicts; error? }`——先文件（寫 blob/刪 added），後對話 shadow：append `rewind/point` 事件 `{ targetTurn, mode, shadowedSeqFrom }`（deriveMessages 投影跳過 ≥shadowedSeqFrom 的**非事件**？實作細節：shadow 機制的擴充——讀 packages/compaction/shadow 實現，rewind 遮蔽 = 一個「cut-off seq」而非 per-seq 表——`deriveMessages(session, opts)` 現有 shadowedSeqs 機制：加 `cutSeq?`（跳過 ≥cutSeq 的全部）——compaction/shadow 兩者組合（兩者相交 → rewind 清除 compaction shadow? 語義：rewind 到 X → compaction shadow 內在 X 前的保留；X 後的全部跳過）；記憶體截斷（UI/活的 agent 視角：session 的 in-memory view 回卷）——**本輪做到 log 事件 + deriveMessages 投影 + 清理點**；live assembly 的未來 turn 以投影後消息繼續（agent 循環讀 deriveMessages——自然生效）。
- 失敗保護：`had_errors` 時保留 points（retry 數據）。

## 4. 測試

- recorder：take 去重（首拆）、finalize 寫 points.jsonl 原子、touched 集 afterHash。
- plan：乾淨/衝突三型（用臨時工作區造 modified/deleted-external/created-external）。
- execute：文件恢復（blob/刪除 added）+ 對話 shadow（deriveMessages 後事件消失、rewind/point 事件在）+ 未 track 誠實列出。
- assembly 集成：mock turn（fs 寫工具 → 事件鏈 → points 有該 turn）——用 llm-mock 腳本 + 真 fs 工具。
- 兼容：compact shadow + rewind 組合（rewind 至 X 前有 compaction → 投影正確）。

## 5. 分組

- **G1**：packages/rewind（store/recorder/service）+ fs 工具 pre-image 報告 + assembly 掛鉤 + 測試。
- **G2**：deriveMessages cutSeq 投影 + compaction 組合 + 測試。
- **G3**：docs（README row + CAPABILITIES + M42b 預告）+ 全量驗證。

## 6. 非目標（本輪）

- UI 複刻（M43：§3.9 規格已留檔 + case-020）；wire 方法（`--attach` rewind 留 v1.1 附錄——M43 或後）；持久鏡像/git 域（grok overkill 不抄）。
