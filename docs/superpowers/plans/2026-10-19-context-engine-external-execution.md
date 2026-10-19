# ContextEngine 外部實作與 Codex 驗收計劃

> **For agentic workers:** Use `superpowers:executing-plans` to execute the current approved batch task by task. The latest user workflow is a separate `deepseek-flash-1017` initial implementer, followed by Codex review and direct adjustment. Do not start additional implementation agents. Steps use checkbox (`- [ ]`) tracking. If that skill is unavailable in the executing harness, follow the explicit workflow below; no plugin installation is required.

**Goal:** 接手現有 ContextEngine 重構，完成剩餘結果保存、語意繼承、可靠交付、觀測及大型長會話工作，按完整交付批次交給 Codex 驗收。

**Architecture:** 保留唯一的 Session／F1 寫入 owner、ContextEngine 計算與壓縮 owner、各協議 adapter、結果 store 與既有任務 registry。完整歷史、有效上下文、原始結果、模型請求與用量觀測分開；新增能力透過窄介面接入，不增加第二套日誌、重試計數或調度器。

**Tech Stack:** TypeScript／Node.js 24.15.0、pnpm workspace、Vitest、JSONL persistence、QuickJS/WASM Code Mode、Electron／React Desktop；沿用現有套件及工具鏈。

**Spec:** [主設計](../specs/2026-10-15-context-engine-redesign.md)、[完整框架](../specs/2026-10-15-context-engine-framework.md)、[進度](../../refactoring/context-engine-progress.md)、[拆分對照](../../refactoring/2026-10-15-context-decomposition-overlap.md)。當前批次的完整行為契約仍以 [R4A 原計劃](2026-10-18-context-engine-r4a-retained-results.md) 為準。

## 1. 使用方式與授權變更

2026-10-19 使用者先決定由另一個 agent 使用 **deepseek-flash-1017** 實作，再調整為「DeepSeek 做初步，Codex 驗收以後自己調整」。後一指示覆蓋先前 Codex 只寫計劃／不修改產品的限制；Codex 可在外部 writer 停止後直接修正並完成驗證。既有資料／權限／驗收契約保持有效；原 GPT6.1Sol reviewer 保持獨立唯讀審查，不與 root 同時寫產品。

- 一次只有一個產品 writer。實作者不自行派子代理、不與仍在修改同一 checkout 的程序並行寫檔。
- **目前批次仍是 R4A 收尾**，入口：[R4A 接手執行計劃](2026-10-19-context-engine-r4a-completion-handoff.md)。先讀[最新限定範圍驗收](../../research/2026-10-19-context-r4a-codex-refinement.md)：產品已到 `3ba0d782`，舊交接 HEAD 是祖先，不能重做已修正項目或 R0–R3；A3–A6 與其餘驗收義務仍未完成。
- R4A 整批交付後，Codex 做功能、結構及證據驗收；修正具體 finding 後再接受。R4B/C/R5/R6 的順序及必交內容見下文，其實際接口須以已接受的前一批次為準。
- 後續每批開工前，Codex 將本文件對應的責任與不變量展開成針對當時 HEAD 的執行計劃。這是原框架要求的接口定稿關卡，不把尚未存在的 API 假裝成現成程式。
- `task finished`、本地 commit、單一測試 pass、已打包、已驗收、已發佈是不同狀態。實作者可提交 coherent commits，但不可自行標記 reviewer accepted、合併 PR、打 tag 或發佈。
- 若只有本地修改／局部測試，整批仍標記 **UNACCEPTED**；具體修正可有明確限定範圍的 acceptance，不能升格為整批通過。目前未授權將未完成 R4A 當成正式版本發佈。

## 2. 開始前的唯一入口

工作目錄 `D:/I-harness-main`；分支 `codex/v0.1.13-development`；產品版本維持 `0.1.13-rc.1`。R4A 原始比較 BASE：`91d8fef04253272a437c68f5f2f84a657fa53d3b`。

1. 讀 [交接檢查點](../../research/2026-10-19-context-engine-handoff-checkpoint.md)：以其中產品 checkpoint、最後測試與未完成清單為起點。
2. 讀本文件及 R4A 接手計劃，再按任務讀相關原契約；不用一次把所有歷史研究塞進上下文。
3. 核對 branch／HEAD／dirty files。保留現有工作；不要 reset、clean、重新 clone 覆蓋或從 BASE 開始重寫。
4. 本機 `.tmp/context-r4a-evidence-20261018-a/`、`.superpowers/sdd/2026-10-18-context-engine-r4a-retained-results/` 保存原證據，通常不受 Git 追蹤。另一台電腦沒有這些檔案時，先列明證據缺口；不能聲稱讀過或驗證過不存在的日誌。tracked 檢查點／計劃仍可讀，必要新測試寫入新 evidence 目錄。

```powershell
Set-Location 'D:/I-harness-main'
git branch --show-current
git rev-parse HEAD
git status --short
& 'C:/Program Files/nodejs/node.exe' --version
```

## 3. 所有批次共用的不變量

- 六條內建 route 分別驗證：OpenAI 公共 Responses、Codex 訂閱 Responses、OpenAI-compatible Chat、Anthropic Messages、Gemini、Bedrock Converse。共用 semantic 層不能抹除原生簽名、順序、media、cache、usage 或 raw option precedence。
- 歷史檔案 bytes、有效上下文 tokens、HTTP body bytes、reported usage、cache 和費用分開。普通 HTTP400 不自動等於上下文超限；request-bytes 失敗也不自動等於 token 超限。
- 已派發工具、getter/toJSON、已執行 hook、guest 呼叫、既有 child 均不因保存／恢復而重播。
- 只用原始捕獲、原 source、原 operation／receipt key 恢復。unknown 不是 absence；檔案存在、payload／ID 外觀或錯誤文字不構成執行或讀取權限。
- Stop 撤銷新執行；已授權的必要被動結算仍需完成。原 source 的 temporary hold 不得清除其他 hold、sticky fault、closing 或 journal quarantine。
- 繼續保留已收到的人類輸入；pending、promoted、claimed 分開。保存 receipt 不授予新模型／工具執行權。
- 不讀取真實憑證、不操作使用者正在跑的會話／程序。測試使用隔離目錄與離線 fixture；沒有線上實測就明說。
- 不新增第三方 dependency／service，不用安裝或隨意改 lockfile 掩蓋問題。既有workspace套件之間必要的public-entry依賴須按核准方向顯式宣告並記錄；不新增 reachability 豁免／reseed／假 consumer。若新的契約確實需要範圍變更，提交具體原因與受影響範圍給 Codex 判斷。
- 一個狀態一個 owner；不傳整袋 locals、不建立無邊界 utils。一般產品檔 **150–400 行**、函式通常 **≤120 行**、facade **150–250 行**為審查目標；按完整責任拆分，不按行數切碎。測試／工具腳本不屬拆分範圍。
- 已有資料版本的 previous/current/future reader 都要走實際入口。不得把舊資料補成具有新 execution／claim／permission 證明。

## 4. 剩餘批次與依賴

| 批次 | 依賴 | 明確交付物 | Codex 接受條件 |
| --- | --- | --- | --- |
| **A：R4A 完整結果保存收尾** | 現有未驗收 checkpoint | 原結果、依賴、pin／ACL、所有實際 producer／reader、版本與恢復接通 | A1–A10 全矩陣、固定 source 的必要測試、實際 copied Gateway／CLI、一次完整範圍審查 |
| **B：R4B 語意 seed 與目標 bootstrap** | 已接受 A | 有版本的有效上下文 export／import；真正 fork／child 第一請求 | 無 consumed 大歷史複製、無父權威繼承；實際 first-request／crash-cut／相容性 oracle |
| **C：R4C 結果交付／epoch／喚醒** | 已接受 A、B 及現有 F1/F4 | source registry、receiver admission／claim、wake hint 的可恢復交付 | 同 key 不雙 claim、不同 revision 不誤去重、Stop／rewind／cold 正確、真實消費者可操作 deferred 結果 |
| **D：R5 恢復與觀測／UI／用量** | 已接受 A–C 與現有 R2/R3 | 一致的 typed observation、正確 terminal feedback、物理 attempt 用量觀測、browser-safe UI | 讀取零模型／auth／prepare副作用；錯誤不變成功；新舊用量不混算；renderer 真正 build |
| **E：R6 大歷史、遷移與整體驗證** | 已接受 A–D | 串流 archive、checkpoint＋tail cold restore、實際歷史分頁、完整打包驗證 | >100MiB 分佈式會話 cold resume＋continue；內容／效果／交付不丟不重；完整固定 HEAD 證據 |

這些批次不是等工作量的百分比。尤其 R6 仍含產品開發，不能改名為「最後跑一次測試」。

## 5. B 的定稿與實作責任

依據：[B/C 契約](../../research/2026-10-16-context-engine-r4-seed-delivery-preflight.md)、[B 現有 owner 對照](../../research/2026-10-18-context-engine-r4b-current-owner-rebase.md)。

實際 owners：`packages/session-persistence/src/{seed,fork}.ts`、`packages/session-persistence/src/coordinator/managed-documents.ts`、`packages/subagent/src/fork.ts`、`packages/subagent/src/child/document.ts`、`packages/session-executor/src/lifecycle/{detached-seed,managed-document}.ts`，以及既有 core-session projector／history。新增的 seed codec/compiler 放在 persistence 的同一責任目錄，保留薄 public entry。

- [ ] **B1：定稿 semantic seed 的版本與 compiler。** 使用當時已接受的 snapshot／R4A artifact 介面；保留 ordered conversation、checkpoint、typed tail、lineage、dependency。raw structural export 繼續作不同操作，不能從同一 raw representation 任意移除驗證 proof。
- [ ] **B2：原 coordinator 內完成目標 bootstrap。** header 建立、seed/input receipt、cached target、artifact grant/pin 均在原 owner 的狀態機內；中斷或 unknown 使用原身份恢復。不得以 read→updateMeta→open 宣稱原子提交，不能覆寫已非空 target。
- [ ] **B3：切換所有實際 fork 入口。** none/all/N、team、SDK/Gateway、durable／nondurable detached seed；保留角色、模型、工具與 instruction／permission floor。
- [ ] **B4：真正子代理第一請求驗證。** parent 的 spawn 自己尚未返回／parallel sibling 未完成時，整個不完整單位不進 child wire replay；保留觀測與目前輸入，不等自己、不偽造 result。消費過的100MiB parent body 不被抄進 semantic seed。

測試還必須覆蓋 target route/account 不相容、opaque-only blocked、source 在 resolver/grant await 中改變、none/N邊界、同一 bootstrap 重入與 unknown。source export／inspect 本身不可 resolve credentials 或發模型請求。

## 6. C 的定稿與實作責任

沿用 `packages/subagent/src/task/` 的唯一 registry、`task-notification.ts`、`followup/inbox.ts`，原 `session-executor` input admission／queue 與 `agent-team` mailbox。managed source transition 以**既有父 Session journal**為權威，task snapshots 為 derived views；不加第二套 task journal。

- [ ] **C1：固定 logical delivery key 與版本化事件。** key 為 `(parentSessionId, qualifiedTaskId, resultRevision, deliveryKind)`；task namespace 是真實 delegation 身份。key 不依 text／epoch／wake attempt；同 key 內容衝突必須報 conflict。
- [ ] **C2：receiver admission／claim 切換。** 返回真實 input ID、receipt／disposition；source ack 可落後，依原 key 恢復。admitted、claimed 與 wake 分開，模型失敗不能把已 claim 的 delivery 再派一次。
- [ ] **C3：Stop／rewind／summary 與 deferred 消費者。** 讀取結果不等於注入目前上下文；同 key 的 explicit adoption 有真實 application／command 入口，不能只加沒人用的 API。新普通提示詞不能自動重播 suppressed 結果。
- [ ] **C4：source／receiver 分開提交的 crash matrix。** after admission/before ack、after claim/before ack、after durable wake intent/before signal，皆復用原 key；wake 可以重送，claim 不重複。修復補上的 turn/end 不證明 child 完成。

獨立 oracle：同樣字串`done`的 r1/r2各一次 claim；同 revision換呈現文字仍同一次；quiet team 維持 quiet；missing/corrupt已知 source 不能當全新狀態。不得將此批完成直接宣稱 IH 全面事件驅動完成。

## 7. D 的定稿與實作責任

依據：[R5 觀測／用量](../../research/2026-10-16-context-engine-r5-preflight.md)、[Chat SSE 已重現問題](../../research/2026-10-18-context-engine-r5-chat-error-evidence.md)。

- [ ] **D1：typed recovery 與真實 protocol terminal。** 在 `packages/llm-openai-compatible/src/stream/` 的實際 fold/decode 處理已確認的 top-level error carrier，包括 residual frame；錯誤後不可 accepted exchange／派工具／校準 usage。其他 route 保持各自規則，重試使用同一 F4 allowance。
- [ ] **D2：唯讀觀測。** session-executor、SDK、Gateway 的 model/dashboard/history/status 讀取只消費明確 live/saved DTO；不能為了讀取進行 auth、prepare、repair、assemble、wake 或 claim。cold不具可信觀測時顯示 unavailable。
- [ ] **D3：append-only usage observation。** 新 producer／validator／store／aggregate／UI 同批切換；每個 observation ID不可變，依實際 action/attempt/purpose/origin聚合。legacy row保持unknown attribution；missing不變0；多個 cumulative usage snapshot不相加成多次費用。
- [ ] **D4：安全診斷、UI與browser邊界。** 純 info只進Log，最終 logical failure才有popup；歷史Log不重播toast。renderer不import Node fact/hash/ownership machinery，不以polyfill或寬鬆stub替代host驗證。保留IH既有視覺風格。
- [ ] **D5：完整重合拆分與真實入口驗證。** S20/S21/S22/S23/S28的完整責任、所有原consumer gate，以及renderer build；不只搬新context分支就記整檔完成。

## 8. E 的定稿與實作責任

依據：[R6 archive義務與歷史缺口](../../research/2026-10-17-context-engine-r6-archive-obligations.md)、[原始失敗台帳](../../research/2026-10-17-context-engine-f3a-baseline-gaps.md)。

- [ ] **E1：串流 archive 與恢復。** 在 `session-persistence-jsonl` 的既有backend／codec與core-session projection範圍實作逐段驗證／讀取、有效checkpoint＋tail恢復。index可重建且綁 exact source revision/bytes，不成為判定未提交frame有效的權威。
- [ ] **E2：真正的歷史／搜尋分頁。** 接通 session-query、SDK、Gateway、Desktop 的實際consumer；不可先materialize全檔再slice並宣稱bounded。保持唯讀與完整batch可見性。
- [ ] **E3：大型會話及遷移。** 同時測單一巨大legacy record與真實分佈的>100MiB多回合資料，包含checkpoint、native bundle、tool/child、accepted suffix。分別測cold/warm memory、fold、prepare與history-read成本；不承諾未測的固定記憶體百分比。
- [ ] **E4：固定HEAD完整qualification。** 六route、source與packaged Gateway／CLI／renderer、SDK實際入口、舊格式、restart、Stop、delivery、無duplicate effects；保留既有failed和warnings的真實處置。
- [ ] **E5：交回Codex驗收。** 給完整diff、原責任→新目錄、原始測試紀錄、source/copy maps與未測限制。Codex接受後才另行決定merge/tag/release；不得從候選版名稱推定可發佈。

## 9. 證據與交付標準

每批建立新的 evidence 目錄，不覆寫既有 `.tmp/context-r4a-evidence-20261018-a/`。保留 command、cwd、Node/tool版本、start/end、exit、完整stdout/stderr、前後 source manifest、fixture與artifact hash。expected RED／setup failure／BASE failure／product regression分開；不可把測試數重疊相加。

交付報告至少包括：

```text
Batch / full BASE..HEAD range / actual branch
Changed responsibilities and public interface owners
Completed acceptance IDs and exact evidence paths
Known failures: original -> current -> disposition
Source tests, typechecks, audit, copied/runtime checks (separate scopes)
Before/after product source hashes and source-to-copy import mapping
Data/version migration behavior and exact not-tested limitations
Active processes / cleanup outcome / remaining work
UNACCEPTED: awaiting Codex functional + structural review
```

Codex審查會檢查真實production graph與actual imports、對照原需求及反例、獨立抽查證據與必要測試；實作者自評pass不取代驗收。若只有具體finding要修，沿原range做修正，不重寫已接受的所有階段。

## 10. 拆分與原先其他工作的界線

原清單 **27/43 已完成，16個未完成**。此次重構整組重合 S20/S21/S22/S23/S25/S28，共9個原檔；完整責任與驗收都通過才可到36/43。CX1/CX2另外記錄。S24/S27/S29/S30/S31僅部分重合，S26/S32仍獨立；參見完整拆分對照。

原先全面事件驅動、AGENTS.md／CLAUDE.md及不相關拆分保持其既定暫停／進度狀態。這個交接不把它們全部併入R4A，也不允許拿新增目錄數當完成數。
