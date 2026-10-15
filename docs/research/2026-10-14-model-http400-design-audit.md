# 2026-10-14：長會話 HTTP 400 與請求預算設計調查

狀態：已完成提供證據的解析、0.1.12 原始碼追蹤、四個本機參考項目比較及有限離線驗證。已確認 IH 的計量、錯誤分類／傳遞和超限恢復有缺口；**此次四筆 HTTP 400 的上游具體原因尚未定案**。沒有產品修復、live provider 呼叫、帳戶／設定／原會話修改；0.1.13 拆分仍暫停。

**2026-10-15 補充：** 已在目前電腦找到 SHA-256 完全相符的原 Session，並找回獨立用量紀錄。事故前最後成功請求的實際總輸入為 **760,610 tokens**（包含 760,448 cache read）；四次失敗仍無上游 body，具體拒絕原因仍未定案。見[本機唯讀核實](2026-10-15-local-session-evidence.md)。以下保留原調查當時的證據界線；其中「尚未取得用量」是歷史狀態。

基準：使用者確認事故版本 0.1.12，原始碼提交 `460a2aee9395dafe196eb31425dcc2c3fcdc259e`。目前 `c228dd91` 的相關原始碼已做等價拆分；token-meter、llm-seam、context-remaining、executor、service 與釋出基準內容一致。下文引用目前路徑，涉及舊大檔行號時另列基準。

## 證據與可以成立的結論

- 提供的主 transcript SHA-256 與清單相符：`e987274691777110a2546bda6eb8120a181f40687edb82887f1253666aa88870`。5,188,017 bytes、3,283 JSONL 行，其中一行 header、3,282 事件。
- 394 個 step/start、386 個 assistant/message、462 個 tool/call 及結果；沒有 compaction／rewind 標記。最後四次 HTTP 400 前的 step/start 是 seq3249／3257／3265／3278。
- 最後的有效中性歷史是 918 messages，按 IH 現有估算法為 **437,837 tokens，不含 system/tools overhead**。這是粗估，不是真實供應商 token 數。
- 提供的診斷檔現在有 1,227 行，較先前報告的 1,107 行多；四筆目標會話 HTTP 400 的時間／狀態與報告相符。檔案沒有上游拒絕內文。
- 462 組 tool_use/result 配對完整。對最後有效歷史使用凍結版本 adapter、空 system/tools 及明確 fixture 設定的投影是 831 wire messages：不重送 thinking 時 2,460,726 bytes，全部可重送 thinking 保留時 3,005,803 bytes。這些是**明確的離線投影界線，不是原始請求大小**；原 system/tools/options/cap 和 thinking fingerprint 是否匹配沒有完整保存。
- 有 375 個工具型 assistant thinking blocks 可被 adapter 重送，含 470,123 thinking 字元。ProviderContinuation 的全部 JSON 不會原樣送給模型，因此不能把它的備份／工具引數回顯重複加進請求 token。

不能從 5.2 MB 日誌、快速 400 或「新會話成功」直接斷言 input 超過 1M：400 也可能是 cap、訊息／簽章／schema 或端點特定的限制。現有配對證據降低了此事故的 tool-result 配對疑點，但不等同於重建所有上游驗證條件。

## 已確認的設計缺口

### 1. 計量沒有涵蓋會重送的 thinking

`packages/token-meter/src/estimate.ts:12` 計入可見文字和工具名稱／引數，沒有計入 thinkingBlocks。`context.ts:45` 在已校準的歷史後，仍以同一估算器計算新 suffix；`context.ts:46` 的全量 fallback 也漏掉這一部分。

有限離線驗證使用實際 agent 及 Anthropic body builder、控制模型與匹配的 continuation fingerprint。第一回應 input usage 為 20、output usage 10,000，產生 40,000 字元的 thinking；100,000 context／30,000 output cap 可容納這個 fixture。下一請求的真實 wire fixture 確實帶了全部 40,000 thinking 字元，IH 的下一輸入估算卻只有 **38**，而 source 顯示 `provider`。這證明「舊 input usage + 新 suffix」漏計，不是中文 tokenizer 猜測。

來源標記也不夠精確：`provider` 在這裡是舊請求的實測基底加上新內容粗估，不能理解為整個當前請求已由供應商計數。

### 2. 報給模型的剩餘比例沒有共用已校準預算

`packages/core-tools/src/context-remaining.ts:32` 直接讀 `activeTokens(session)`，未使用 agent 的 context meter，也未計入 system/tools 或輸出預留。事故歷史中的 `get_context_remaining` 最後回報 used422906／42%；這是其粗估規則的結果，不足以證明真實上游輸入只用了 42%。

使用者補充當時 UI 上下文沒有顯示已滿、也沒有觸發自動壓縮。原始碼對應已核對：`session-executor/src/service.ts:446–467` 的 `contextState()` 同樣使用 `breakdown(session)`；`desktop/src/renderer/session/ContextUsage.tsx:168` 把 estimatedTokens/window 顯示為百分比。按這條 0.1.12 路徑重算提供的最終歷史，会得到 **43.8%**。這是重算值，並非找回當時 UI 截圖。

UI、模型查詢工具的純歷史粗估，與自動壓縮使用的 provider-anchor／suffix meter 是不同路徑。兩者都不是最終 wire 的完整當前 token 計量；在失去 anchor 或新 thinking 沒計入的情況下，後者也可能低估，未達 0.8W 就不會觸發。沒有壓縮標記加上 UI 未滿因此與缺口一致，但仍須實際 usage／拒絕原因確認事故的真實量。

失敗、重綁、prefix 改動等會使 calibration 失效，回到 chars/4 fallback；meter 本身沒有保存可在重建後驗證的 usage anchor。離線直接驗證把同一份提供歷史的受控 anchor 設為 700,000，invalidate 後回到 437,837 的粗估；700,000 是受控示範數字，並非找回事故的實際用量。失效本身是防止錯用舊證據的必要規則，問題是 fallback 沒有完整計量、沒有保守的不確定性處理或後續超限恢復。

### 3. 上游錯誤類型和說明在多層被丟掉

`packages/llm-seam/src/index.ts:280` 讀取回應內文，卻返回通用 `anthropic request failed: 400`，只保留少量 code/status/retry facts。HTTP 400 的具體說明在進入持久化以前就已消失。

同檔 `:296` 優先採用 `invalid_request_error → INVALID_ARGUMENT`，覆蓋從 message 判出的較精確 context 類型。凍結原函式離線驗證：

| 受控 HTTP 400 內文 | IH 結果 |
|---|---|
| type=invalid_request_error，message=context_length_exceeded | INVALID_ARGUMENT |
| code=CONTEXT_TOO_LONG，message=Input context too long | INVALID_ARGUMENT |
| 只有 message=context_length_exceeded | CONTEXT_WINDOW_EXCEEDED |

Desktop `desktop-gateway/src/input.ts:44` 和 SDK status 路徑再把錯誤轉成 `.message` 字串，讓存活的 structured code 也丟失。因此 Log 的 `http_400` 不能證明最初沒有辨識過 context overflow。修復應保存結構化、限制長度並遮罩後的供應商原因與 request ID，而不是無界保存原始 prompt／回應／憑證。

### 4. 確認超限後沒有自動改變請求的恢復路徑

IH 已有每 step 的 `maybeCompact → enforceBudget`，包括 compact/reset/fail-closed；不能把它描述成完全沒有送出前護欄。預設壓縮門檻 0.8W、硬預算 0.9W，request output cap 再按同一估算值和 4,096 margin 縮小。計量錯誤會同時影響這些護欄。

但 provider 明確回 `CONTEXT_WINDOW_EXCEEDED` 時，`core-agent/src/agent/turn.ts:52` 仍進入一般失敗結束，沒有繞過失準門檻、先 prune／compact、確認有效歷史減少後重建一次請求。新增「繼續」於是可以重送幾乎相同的舊內容。這與只增加普通 retry 次數不同。

IH 也有 `/compact` 的 Desktop 操作及 `desktop/session/compact → compactNow` host 路徑；原報告「完全沒有恢復操作」不準確。現有 summary 請求仍依賴同一估算器，而且 `CompactionConfig.maxTokens` 主要是接受 summary 後的字元裁切，wire output cap 可以繼承主模型的 384K 上限（`compaction/src/engine/summary.ts:56`、`summarizer.ts:268`）。這是應另檢查的壓縮請求預算設計，不能假定預設 1024 就代表送出的 max_tokens=1024。

### 5. 體量保護多在壓力觸發之後

`list_agents` 預設包含每個已完成 child 的 finalText。工具結果／子代理報告多次進入 context 可重複增長；full audit log 的持續增長本身合法，但模型可見內容應有獨立預覽、產物參照及替代投影。

IH 已有 output-spill guard，預設每筆 model-visible tool output 64,000 bytes，Desktop host 會掛載。事故中幾個大的單筆結果仍可低於這個 cap，累積後依然很大；不能把問題描述為完全沒有單筆結果保護。單筆 spill、全部歷史的壓縮與 list／完成通知反覆攜帶完整報告，是不同的限制層。

本事故主歷史的 tool/result、tool args、skills 及 child 報告都累積在有效投影中，沒有 prune 標記。Skills context 是變更才寫 snapshot，不能稱作每 step 無條件重注入；十份 snapshot 是整個歷史中的重複內容，並非單獨足以解釋 400 的最大來源。

## Runtime 清理與會話「永久死亡」的區別

普通模型 HTTP 400 在 release source 中只失敗目前 turn，保留 service、assembly 和可繼續使用的 lane。有限離線驗證在**同一 service、assembly、Session 及 ID**先受控失敗、再成功，沒有提前 dispose 或 abort；沒有 live provider。

實際提供歷史中，第三次 400 在09:19:34Z結束；09:20:02.541Z有無 sessionId 的 workspace runtime/startup-get error，接著兩個 child 被取消，其中一個顯示 `Project scope service closed`；之後同一 Session 在09:20:39.083Z再次送出第四次模型請求。這證明重複拒絕和 runtime cleanup 是兩個待區分的事件。

`Project scope service closed` 指向 broker 真正的 close；正常模型失敗路徑不會直接呼叫它。提供記錄沒有 runtime generation／close reason 足以還原外部清理觸發。不能將這次子代理被 kill 直接歸因於普通 400，也不能忽略這個可觀測性缺口。

## 四個參考項目的可採用設計與限制

| 項目 | 對 IH 最有用的機制 | 經核對的限制 |
|---|---|---|
| Codex Rust v0.160.0 | 最近 provider usage + 新增歷史估算；工具內容進 model history 時截斷；summary/reset replacement checkpoint；記錄 context 與壓縮事件 | 一般 provider overflow 會先標滿並返回錯誤，並非所有情況當場修復；guardian 的 inline recovery 才有每 step 一次限制。 |
| DSH v0.2.1-alpha.2 | reasoning/system/tools 計量；門檻 `min(W×ratio,W−reservedOutput−headroom)`；確認 overflow 後 local prune + compact；durable replaceGeneration 增加才允許一次重建 | 仍有 chars/4 粗估；新輸入可能在早期檢查後加入；always retry 設定可能超出 compactor 次數界線；full child user message 仍會增長。 |
| OpenCode private fork | 相關 runner／kernel 有 typed overflow 後有限次 compact + rebuild；summary 序列化限制工具內容；保留 HTTP 診斷資料 | 多個舊／新 engine 共存，不能把某一路的 pruning/defaults 當成全 fork 行為；部分裸 400/413 推論 overflow 過寬。 |
| ZCode | fallback 計入 reasoning/args；分開自動門檻及每 request output cap；microcompact/artifact result budget；reactive compact 每 model step 有界 | microcompact wrapper 是 opt-in；CONTEXT_TOO_LONG 辨識仍不完整；某些 artifact failure/cap 邊界沒有無條件保證。 |

原始碼位置：

- Codex `D:/agent-complete/codex-rust-v0.160.0/codex-rs/core/src/context_manager/history.rs:851`、`session/turn.rs:1695`、`compact.rs:311`。
- DSH `D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2/packages/compaction/compaction-basic/src/index.ts:190`、`config.ts:153`、`packages/llm/token-meter/src/estimate.ts:12`。
- OpenCode `D:/agent-complete/opencode-fork-private-999.0.15/packages/core/src/session/kernel/coordinator.ts:440`、`session/compaction.ts:113`。
- ZCode `D:/agent-complete/ZCode-main/apps/zcode-cli/packages/core/src/compact/manual.ts:102`、`runtime/methods/turn-model-step.ts:741`、`tool/executor/result-serialization.ts:175`。

主代理已再次直接核對 Codex 的關鍵程式碼（並非只轉述比較報告）：

- `context_manager/history.rs:902` 以最後 provider `last_token_usage.total_tokens`（包含剛產生的輸出）為基底，追加最後模型輸出之後的本地項目，並按 server_reasoning_included 處理舊 reasoning。IH 目前是 input anchor 加估算 assistant suffix，後者漏掉 thinking。
- `session/turn.rs:1695` 在確認 ContextWindowExceeded 時呼叫 `set_total_tokens_full`；`session/mod.rs:4934` 設置 full 狀態並發出 TokenCount。下一個 pre-sampling 檢查及續接檢查能看到已滿的 context。IH 目前只失敗並 invalidate，沒有保留這個可要求恢復的明確狀態。只有確認超限才應採用這個規則，不能套到一般 400。
- `context_manager/history.rs:531` 在工具輸出進 active history 時套用 truncation policy，完整 rollout 原文保留；`compact.rs:311` 在 summary 請求仍超限時移除最舊 item（及配對關係）再試，成功後 replace history 並 recompute usage。
- `session/turn.rs:179` 自己仍有待計入 incoming input 的 TODO，不能把此版本 Codex 當作精確最終 request admission 的完整答案。

這些是實際本機 source comparison，並未聲稱四個項目能通過此次相同 payload 或全無缺陷。

## 建議分批修復與驗證

1. **錯誤事實與診斷先完整。** 修正 context-specific 分類優先序，保留 typed code/status/request ID 和 bounded redacted provider reason 穿越 agent／SDK／Desktop；記錄最終 request component sizes、估算來源、binding/window/output reserve 與壓縮 skip／failure 原因。用 context-overflow、schema、quota/auth、request-too-large 對照，避免把任何 400 自動當超限。
2. **統一請求預算。** 以 adapter 實際準備的 request/projection 計入 system、schemas、tool args、實際重送 thinking/images；不重複計入 continuation 備份。UI/context tool、auto compaction、main output clamp、summary request 共用一份有 binding／revision／confidence 的證據；恢復／失效時保守處理。檢查動態 prompt/catalogue、新輸入、兩種 cache semantics 及多協議差異。壓縮摘要使用獨立、符合 adapter 下限的輸出预算。
3. **補有界超限恢復。** 只對已確認的 context overflow：暫停新 model call、先 model-free prune，必要時對 balanced region 作 bounded summary；保存替代投影並證明有進展才重建 request，建議先限一次。summary 本身超限另有輸入縮减；保留原始 audit/history 和已執行結果，絕不重播舊工具副作用。不足以恢復時返回可操作原因及手動 compact／帶摘要接續入口。
4. **控制有效歷史增長及清理診斷。** list 預設回摘要／ID、完整 child 報告走明確讀取；大型結果轉 bounded preview + 可授權 artifact，不因 UI 顯示截斷而假裝 model 已截斷。補 runtime generation/close reason，分別測普通 model error 與真正 host/rebind/close，確認背景 child 所有權。

這是調查後的建議，**產品修復尚未開始**。應作獨立 bug 修復單元，不必等待剩餘大檔拆分；也不應一次把四個參考項目的常數與 engine 拼進 IH。

## 明天需補的最小事故證據

使用者目前已下班，明天才能取得另一台電腦的資料。優先保留 `%USERPROFILE%/.i-harness/usage-stats/records` 中該 Session 最後幾筆成功／失敗 records，若設定路徑自訂則在設定檔同層。0.1.12 的 `desktop-gateway/host.ts:132` 和 usage-capture 實際有獨立持久化，包含 input/cache/output counters；原報告只搜尋 AppData，不能據此斷言整台機器完全没有用量記錄。

Anthropic input semantics 為 excludes-cache 時，真正输入为 inputTokens + cacheReadTokens + cacheCreationTokens；不能把未快取 inputTokens 單獨當上下文。這份數據能確認最後成功的實際輸入量，但沒有原錯誤 body 時仍不能斷言此次拒絕一定是哪個驗證條件。另保留 runtime restart/rebind／settings 時間點與原始四份證據，勿改寫事故會話。

官方資料（2026-10-14 查閱）：[DeepSeek 模型規格](https://api-docs.deepseek.com/quick_start/pricing/)列 deepseek-flash 為1Mcontext／384K輸出；[Anthropic 相容介面](https://api-docs.deepseek.com/guides/anthropic_api/)說明 max_tokens 支援。這支持排除「384000 本身必然非法」的斷言，不是事故實際 request/binding 的完整證明。

細節證據在 ignored `.tmp/model-http400-investigation/`：analysis.json、analyse.mts、meter-probes.mts/json、provider.md、lifetime.md、references-codex-dsh.md、references-opencode-zcode.md。所有 bounded probes 均無 provider 網路。第一版 meter 示範使用過小 output cap，已保留 meter-probes-initial.json；最終 probe 使用可容纳回應的100Kwindow／30Kcap，並核對匹配 fingerprint 的實際 wire thinking，未把初稿當事故重現。
