# IH「Agent 迴圈／上下文管理」子系統設計審計（2026-11-04）

分支：`experiment/audit-fixes-v0.1.13`。範圍：`packages/core-agent`、`packages/llm-seam`、`packages/llm-{openai,openai-compatible,anthropic,gemini,bedrock,mock}`、`packages/context-engine`、`packages/context-output`、`packages/compaction`、`packages/token-meter`（`output-retention`、`shell` 僅取與上下文預算／工具輸出相關處）。

對照基準：

- Codex `codex-rust-v0.166.0/codex-rs`（`core/src/compact*.rs`、`context_manager/`、`state/auto_compact_window.rs`、`protocol/src/error.rs`、`utils/output-truncation`）
- opencode `2.1.4/packages/core/src/session`（`runner/step.ts`、`runner/retry.ts`、`compaction.ts`、`usage.ts`、`ai/src/protocols/*`）

嚴重度：**C** = 功能不可用／資料錯亂；**H** = 常見情境不穩定或語義錯誤；**M** = 可維護性／可診斷性／成本；**L** = 體驗或一致性。方法為只讀程式碼；下列每一項都可用單檔測試（或一個純函式斷言）回歸，最後一欄註明。

---

## A-01 模型回應完整性沒有契約：串流提早結束與空回應都被當成「成功完成」（H）

**一句話**：五個 adapter 都在 EOF 直接產出 `end`，core-agent 只檢查「有沒有收到 `end`」，於是半截回應與空回應都會被當成完成的回合寫入 journal。

**證據**

- `packages/llm-anthropic/src/stream/decode.ts:14`（註解自承「EOF alone produces the clean end」）、`:58`；`stream/fold.ts:155-176` 的 `finish()` 完全沒讀 `message_stop`。
- `packages/llm-openai/src/stream/fold.ts:188-199`：`receivedCompleted` **只在 `codexSubscription` 時**被檢查。
- `packages/llm-gemini/src/stream/decode.ts:60`、`packages/llm-bedrock/src/stream/iterate.ts:30`、`packages/llm-openai-compatible/src/stream/decode.ts:87`：同樣 `yield fold.finish()`。
- 消費端：`packages/core-agent/src/agent/model-step.ts:165-168`（`end` 就設 `providerEnded`）、`packages/core-agent/src/agent/managed-turn.ts:280-282`（唯一的中止判定是 `!providerEnded`，因此真斷線與真完成不可區分）。
- 空回應：`packages/core-agent/src/agent/finalization.ts:125-128` 只發 `provider/empty` telemetry；`agent/turn.ts:129-130`、`agent/managed-turn.ts:394-398` 直接結束回合（`finalText=""`），不報錯、不重試。
- `EMPTY_RESPONSE` 是死代碼：`packages/llm-seam/src/retry/policy.ts:6,52` 宣告為可重試，但全樹沒有任何分類器會產生它。

**參考做法**：Codex 把「HTTP 200 後、`response.completed` 前斷線」定義為可重試的 `CodexErr::Stream`（`protocol/src/error.rs:108-120`）；opencode 對 `finish` 未知的回應丟 `InvalidProviderOutputError`，分類 `incomplete-stream`（`session/runner/step.ts:171-180`）。

**影響**：代理／HTTP2 連線中斷、供應商安全過濾（HTTP 200 空內容）在 UI 上都表現為「沉默的成功」；使用者看到空白回覆，恢復與重試機制不會被觸發，rollout 也會留下看似正常的一步。

**建議方向**：adapter 追蹤終端標記（`message_stop`／`finish_reason`／`response.completed`／`messageStop`），無標記的 EOF 一律走 seam 的 `error` 頻道（可重試）；空回應改用 `EMPTY_RESPONSE` 重試一次後明確失敗。

**單檔測試**：可。對 `decodeAnthropicStream`／`decodeResponseStream` 餵「有 delta、無終端標記」的串流，斷言目前得到 `end`（修正後應得 `error`）；對 `closeStep` 餵空 step 斷言 `empty:true` 且回合結束。

---

## A-02 context 預算用非 tokenizer 啟發式，且同一路徑有兩套密度；CJK 被高估 2.5–4 倍（H）

**一句話**：admission 的 token 數是「ASCII/3、非 ASCII 每 UTF-8 byte 算 1 token」的估算，中文因此每字算 3 token，且與顯示用的「ASCII/4」估算不同源，導致中文會話在實際用量 20–35% 就觸發（有損的）壓縮。

**證據**

- `packages/token-meter/src/projection/pricing.ts:5-13`：`priceProjectedText` = `ceil(ascii/3 + nonAsciiBytes)` → 一個中文字（3 bytes）= 3 token。
- `packages/token-meter/src/estimate.ts:17-24`：`estimateTextTokens` = `ceil(ascii/4 + nonAsciiBytes)` → 同一段文字有兩種價格。
- 兩個價格各自餵不同決策：admission 用投影價格（`packages/context-engine/src/admission/prepared.ts:36-47,49-52`），`token/usage` telemetry 與群組保留量用 `estimateContent`（`packages/core-agent/src/agent/finalization.ts:146-150`、`packages/context-engine/src/reduction/selection.ts:29`、`packages/token-meter/src/breakdown.ts:13-15`）。
- 校準只錨定「已被接受的語義前綴」：`packages/token-meter/src/accepted-calibration.ts:34-41`；任何 rewrite／binding 變更都會 retire 錨點（`accepted-calibration.ts:20-32`、`packages/core-agent/src/agent/budget.ts:51-53`），壓縮後第一次請求又回到全啟發式。
- 觸發門檻：`thresholdRatio` 預設 0.8（`packages/compaction/src/config.ts:132`）＋ `reserveRatio` 0.9（`packages/context-engine/src/admission/assess.ts:21,31`）。

**參考做法**：Codex 由 `state/auto_compact_window.rs` 的 `AutoCompactWindowPrefill::ServerObserved` 用伺服器回報的 input token 取代估算，估算只在沒有回報時當基線；opencode 以 provider usage 為準（`session/usage.ts`），估算只是後備。

**影響**：中文介面／中文工具輸出（本產品主要使用者）會提早 2–3 倍壓縮，每次壓縮都把歷史換成 1024 token 摘要（見 A-03），可觀察到的症狀是「聊沒幾輪就失憶」。同一段文字在 UI 顯示與 admission 也差約 25%。

**建議方向**：單一 density 來源；CJK 至少改成 `bytes/3`（約與 BPE 同量級）；接受 provider 用量後把錨點延伸到「最新一次請求」而非只錨前綴。

**單檔測試**：可。`priceProjectedText('你好世界')` 目前 = 12（真實約 3–4）；`estimateTextTokens('你好世界')` = 12，而 ASCII 同長度字串兩者差 33%。

---

## A-03 壓縮保留量預設 0（只留最新一個 exchange），摘要上限 1024 tokens（H）

**一句話**：`retainTokens` 預設 0 使 `selectReductionRuns` 只保留最新一個 exchange group，其餘全被換成上限 1024 token（約 4096 字）的摘要，與參考實作保留 15k–20k token 原文的差距是量級差。

**證據**

- `packages/compaction/src/config.ts:137`（`retainTokens ?? 0`）、`:141`（`maxTokens ?? 1024`）、`:145`（`minSummaryChars ?? 500`）、`:146`（`summaryMaxOutputTokens ?? 4096`）。
- `packages/context-engine/src/reduction/selection.ts:38-42`：`if (exchanges && retained >= (policy.retainTokens ?? 0)) break` → 加完最新一群後 `retained>=0` 必然成立，迴圈結束；只有「最新一個完整 exchange group」是原文。
- 摘要輸出硬上限：`packages/compaction/src/summary/generate.ts:28`（`Retain ${minSummaryChars} to ${maxTokens * 4} code units`）、`stream.ts:14-17,32`（`maxRetainedChars = maxTokens*4`）。

**參考做法**：opencode 預設 `keep: 15_000` token 原文（`session/compaction.ts:255`），並保留 15%／至少 16k 的緩衝（`:43-44,128`）；Codex 以 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` 保留使用者訊息並可保留 standalone tool output（`core/src/compact.rs:63`）。

**影響**：每次壓縮後模型只看到「一個 exchange 原文 + 一張 1024 token 的卡片」，長任務的檔案路徑、決策與未完成事項極易遺失；這也是 A-02 提早壓縮時代價被放大的原因。

**建議方向**：預設保留 8k–15k token 原文尾段（或至少 N 個 exchange）；摘要上限改為 window 的比例（例如 2–5%）而不是固定 1024。

**單檔測試**：可。`selectReductionRuns(snapshot, policy)` 在 `retainTokens:0` 下的 `tail` 集合大小 = 1。

---

## A-04 摘要請求沿用主 system prompt＋全部 tool schema，卻又關閉 prompt cache；摘要器一旦回 tool_call 就整個 blocked，最後回合以 `prompt_too_long` 收場（H）

**一句話**：摘要請求不是獨立請求，而是「主請求的複本加一段指令」，於是它一樣揹著完整工具目錄（可能被模型當成要呼叫工具）、一樣大（需要切頁、8 次上限），而 summary 的 blocked 會讓整個壓縮失敗——即使 prune 已經縮小了上下文。

**證據**

- `packages/compaction/src/summary/generate.ts:30-33`：`systemPrompt: inherited ? surface.systemPrompt : ''`、`tools: inherited ? surface.tools : []`、`promptCache: { mode: 'off' }`（inherited = 沒有獨立 summarizationModel，也就是預設）。
- `packages/compaction/src/summary/stream.ts:68`：`if (tool) throw new SummaryBlockedError('tool-output')`；`:78-84` 格式／長度只允許一次重試。
- `packages/context-engine/src/reduction/run.ts:56-64`：`ports.summary` 缺或回 blocked/failed → `block(result, ...)`，**已算出的 prune 進展被丟棄**（`run.ts:46-55` 的 prune candidate 只在能達到 target 時才算成功）。
- `packages/core-agent/src/agent/managed-admission.ts:83-97`：`result.compacted === false` 且 `needsReduction` → `throw prompt_too_long`。

**參考做法**：Codex 的壓縮走獨立 `SUMMARIZATION_PROMPT`（`core/src/compact.rs:61-62,129`），與主 system prompt／工具目錄無關；opencode 也有獨立的壓縮 prompt 與 `PRECOMPUTED` 路徑（`session/compaction.ts:193-223`）。

**影響**：最需要壓縮（視窗已滿）的情況正是摘要最容易失敗的情況：輸入幾乎與主請求同大 → 需要切頁 → 每頁一次 call → 8 次上限；摘要器若「遵守工具」回一個 tool_call，整個 attempt 直接作廢。使用者看到的是 `prompt_too_long`，且沒有任何降級路径。

**建議方向**：摘要改用獨立 prompt、空的 tools（`inherited` 只保留 system 的「專案背景」段落，不帶工具）；`promptCache` 與「沿用前綴」兩個目標擇一；`result.compacted === false && pruned` 時允許以 prune 後的情境重試 admission，而不是直接判死。

**單檔測試**：可。以 fake `ModelClient` 在摘要請求中吐 `tool_call`，斷言 `readSummaryStream` 丟 `SummaryBlockedError('tool-output')`，且 `reduceContext` 回 `{outcome:'blocked', publication:'none'}`。

---

## A-05 解析不到 context window 時，壓縮被靜默關閉，之後一次溢位就永久 blocked（H）

**一句話**：`composeCompactConfig` 在拿不到 window 時只 `warn` 然後回 `undefined`（等於關閉壓縮），而 recovery 沒有 compactor 就只能 blocked——於是「未知視窗的模型」一旦超長就再也無法恢復。

**證據**

- `packages/session-executor/src/context-composition.ts:7-12`：`if (!compact) return undefined`；`window === undefined` → `diagnostics.warn(... auto-compaction is DISABLED ...)` + `return undefined`。
- `packages/core-agent/src/agent/recovery.ts:91`：`if (state.recoveryCompacted || !context.compactor && !context.recoverOwned) return blocked(previous, "Protected or fixed input cannot be reduced ...")`。
- `packages/core-agent/src/agent/admission.ts:83`：`needsReduction` → `throw prompt_too_long`。

**參考做法**：opencode 在模型沒有 window 時用 `UNKNOWN_WINDOW` 當保守上限，壓縮照常可用（`session/compaction.ts:276-281`：`calculateCeiling({ ...model.limit, context: UNKNOWN_WINDOW }, buffer)`）。

**影響**：自訂／本機 provider（沒有 model card）等於「一超長就死」，且只有一行 warn，使用者從錯誤訊息看不出「是因為沒有 window 才不壓縮」。

**建議方向**：未知視窗退回保守預設（例如 32k）並允許 prune＋摘要；或把「要壓縮但沒有 window」升為啟動期的明確錯誤，而不是靜默降級。

**單檔測試**：可。`composeCompactConfig({...}, undefined, ...)` 斷言回 `undefined` 且只呼叫 warn；`recovery.admit` 在無 compactor 時斷言 `blocked`。

---

## A-06 硬溢位恢復只允許一次「改變輸入」重試，且要求本地估算嚴格下降（H）

**一句話**：provider 回 `CONTEXT_WINDOW_EXCEEDED` 後 IH 只允許一次輸入改變後的重試（`retryConsumed` 終身有效），而且必須「本地估算 token 嚴格下降」才算有進展；gateway 實際上限小於回報視窗時，第二次被拒就永久 blocked。

**證據**

- `packages/core-agent/src/agent/recovery.ts:71-75`（`retryConsumed` → `persistBlocked("The changed-input recovery attempt was also rejected; automatic retry is exhausted")`）、`:80-81`（再次進入即 blocked）、`:101-106`（`validate` 為 transport 前的最後閘門）。
- 進展判定 `recovery.ts:50-58`：`candidateCost.tokens < previous.inputCost` 且 bytes 不得增加；`progressed()` 失敗就 `blocked`（`:98`）。
- 觸發路徑：`packages/core-agent/src/agent/managed-turn.ts:250-258`（只重建一次 step/start，再失敗就往上拋）。

**參考做法**：opencode 有 `SHRINK_STEPS = [0.85, 0.7, 0.5, 0.35]`，每次「too long」都以第一次被拒大小的比例重試縮小（`session/compaction.ts:120,299`；`runner/step.ts:145-163` 的 `recoverOverflow → Outcome.Compacted`），並有 model rotation fallback。

**影響**：第一次壓縮後仍超（壓縮不夠激進、或 provider 的真實上限比設定的 window 小很多）→ 該 session 之後每次都被 `prompt_too_long` 擋住，只能人工 `/compact` 或換模型。

**建議方向**：允許 N 次遞減式重試（opencode 的 shrink 階梯），或把「重試額度」綁在一次使用者回合而非整個 recoveryId；byte 預算也應允許「token 降但 bytes 略升」。

**單檔測試**：可。對 `createRecovery` 餵兩次 `CONTEXT_WINDOW_EXCEEDED` 的 measurement 序列，斷言第二次回 `blocked`（修正後應允許第 3、4 次）。

---

## A-07 provider tool-call id 被要求全 session 唯一，重複即丟錯；managed 與 legacy 路徑行為不一致（H）

**一句話**：managed 迴圈用「整個 session 的 tool/call id 集合」檢查重複，供應商只要在不同 step 重用 `call_0` 這類 id（自架 gateway、部分相容端點、以及重試後的第二次 attempt 很常見）就會讓回合直接失敗。

**證據**

- `packages/core-agent/src/agent/managed-turn.ts:197-201`：`if (event.call.id && host.execution.observe().hasToolCallId(callId)) throw Error("duplicate provider tool call id: ...")`。
- `packages/core-session/src/conversation/validation.ts:56-57`（`callsById` → `hasConversationToolCall`）、`:333`（`callsById.set` 只增不減）、`:395`（`callObservations.set(index,id=>callsById.has(id))`）；壓縮／rewrite 不會清掉舊 id。
- legacy 路徑完全沒有這個檢查：`packages/core-agent/src/agent/turn.ts:74-106`（直接接受 provider id）。

**參考做法**：opencode 以「訊息 + tool-call index」綁定呼叫，不要求 provider id 全域唯一（`session/runner/publish-llm-event.ts` 的 tool 記錄）；Codex 以單一 response 的 item／`call_id` 對應，歷史上的 id 不參與新 response 的合法性檢查。

**影響**：對 OpenAI 相容端點（vLLM、Ollama、部分中轉）是硬性不相容；更糟的是 A-06／retry 的重試會走同一條 `recordCall` 路徑，同一模型的第二次 attempt 很容易再拿到同一個 id。

**建議方向**：唯一性只在本 step（或本 turn）內檢查；跨 step 衝突時由 IH 重新命名並保留 `providerCallId` mapping，而不是丟錯；legacy／managed 兩條路徑共用同一個規則。

**單檔測試**：可。兩個 step 都送 `{id:'call_0'}` 的 fake 串流，斷言第二個 step 在目前會拋錯（修正後應被接受並改名）。

---

## A-08 壓縮在請求關鍵路徑同步執行，沒有背景預先摘要；每個 step 重複 5 次完整 capture＋2 次 prepare（M）

**一句話**：每次模型呼叫前都同步走「capture → prepare → assess → refresh → 可能摘要」的完整流程，長會話每一步都付全量投影成本，而摘要延遲直接落在使用者等待上。

**證據**

- `packages/core-agent/src/agent/managed-admission.ts:31,37,43,51,60,74,77,89,110`：一次 `admit()` 內 `context.capture`/`context.refresh` 最多 5 次、`prepareModelRequest` 2 次、`assess` 2 次，`budget.checkpoint()` 之後還會再 refresh。
- `packages/core-agent/src/agent/admission.ts:23-33`（legacy 同樣每輪重建 candidate／prepare／assess）。
- 壓縮本身在 `managed-admission.ts:83-95` 同步 await（含摘要模型呼叫）。

**參考做法**：opencode 在 0.85 門檻以背景 fiber 預先摘要（`session/compaction.ts:322-380`），到期時只做 `usePrecomputed` 換入（`:383-407`）；Codex 也有獨立的 auto-compact window 狀態。

**影響**：O(歷史長度) 的重複投影讓「越長的 session 越慢」，且使用者每次接近門檻都要多等一次摘要往返；目前只有 telemetry 看不出這條成本。

**建議方向**：背景 precompute（門檻 0.85、摘要結果暫存）+ admission 只做 O(1) 新鮮度檢查；capture 結果在同一 step 內重用。

**單檔測試**：部分可行。以注入的 counting context／model stub 斷言單次 `admit()` 的 capture 次數與 prepare 次數（目前 5/2）。

---

## A-09 被截斷或被拒答的 provider 用量，在 managed 路徑沒有記帳（legacy 有）（M）

**一句話**：同一件事兩條路徑做法不同——legacy 在 truncated/refused 時先 `reportModelUsage` 再丟棄，managed 只 `discard()` 然後拋錯，於是這些請求的計費與快取統計直接消失。

**證據**

- legacy：`packages/core-agent/src/agent/response.ts:110-114`（`reportModelUsage(deps, step)` → `discard()` → `throw MODEL_REFUSED/MODEL_OUTPUT_TRUNCATED`）。
- managed：`packages/core-agent/src/agent/managed-turn.ts:283-289` 只有 `await stream.discard()` 與 throw，`completeModelStep`／`reportModelUsage` 都不會走到（`managed-turn.ts:106-131` 的 catch 也不會補記）。

**參考做法**：opencode 對每一次 provider 回應（含失敗、含截斷）都寫 usage（`session/usage.ts`／`runner/publish-llm-event.ts` 的 record）；Codex 的 `ResponseIncompleteError` 也帶著 `token_usage`（`protocol/src/error.rs:87-92`）。

**影響**：截斷／拒答仍會被供應商計費，但 IH 的 usage、成本、cache 命中率都會低估；診斷「為什麼帳單比 UI 高」時缺一類資料。

**建議方向**：managed 的 truncated/refused 分支在 discard 前先 `reportModelUsage`；把「用量必須在任何結束路徑被記一次」寫成 seam 契約（目前靠各分支自覺）。

**單檔測試**：可。managed 路徑注入「text + truncated end + usage」的 fake stream，斷言 telemetry 應有 `provider/usage`（目前沒有）。

---

## A-10 工具輸出截斷是 head+tail 直接黏合、沒有文字標記，預設也沒有 spill／artifact（M）

**一句話**：shell 超過 64KB 的輸出被換成「頭 32KB + 尾 32KB」而且中間沒有任何省略標記，預設不開 spill、`context-output` 也預設關閉，於是中段內容對模型與後續 session 都永久遺失。

**證據**

- `packages/shell/src/tools/retention.ts:11`（預設 `maxBytes: 64_000`）、`:52-67`：`spillPathForNotice` 只在有 spill store 或 exec 已落檔時才有值；預設沒有 spill → **notice 不會加**，只有結構化欄位 `truncated.stdoutBytes`。
- `packages/session-executor/src/assembly.ts:795`：`retention: opts.shellRetention ?? { maxBytes: 64_000 }`（沒有 `spill`）。
- `packages/output-retention/src/index.ts:141-153`：`head + tail` 直接串接，沒有任何 `…(omitted N bytes)…`。
- `packages/context-output/src/config.ts:4`：`enabled: false` → artifact 分頁／回讀預設不可用。

**參考做法**：Codex 的截斷一定帶可見標記（`utils/output-truncation/src/lib.rs:40`：`Warning: truncated output (original token count: …)`）；opencode 的檔案讀取也有明確的截斷 suffix（`tool/read-filesystem.ts:20`）。

**影響**：模型會把「頭尾相黏」的文字當成完整輸出（例如把被切斷的 stack trace 或 JSON 當真），也可能引用不存在的內容；一旦需要中段，沒有任何回讀路徑（spill 目錄預設不存在，artifact 關閉）。

**建議方向**：截斷處插入明確標記與原始大小；把 spill／artifact 設為預設（或至少在 `truncated` 為真時強制落檔）並持久化到 session 目錄，而不是 process 級 temp。

**單檔測試**：可。對 `createTextRetainer`＋`retainedRunResult` 餵 100KB 字串，斷言 stdout 不含任何省略字樣（目前如此）。

---

## A-11 取消契約不一致：工具批次以無 code 的 `Error("agent aborted")` 結束（M）

**一句話**：取消在 seam／waiting-guard 是 `AbortError`＋`code:"ABORTED"`，到了工具批次卻變成普通 `Error("agent aborted")`，host、telemetry 與 retry 分類都無法用型別辨識「使用者取消」。

**證據**

- `packages/core-agent/src/tool-batch/cancel.ts:112`：`throw new Error("agent aborted")`（`finishCancelledBatch` 的所有取消路徑）。
- 對照 `packages/llm-seam/src/waiting-guard.ts:37`（`cancellationError()` = AbortError/ABORTED）與 `packages/llm-seam/src/index.ts:350-352`（`describeTransportError` 保留 AbortError）。
- `packages/core-agent/src/agent/managed-turn.ts:65-105` 的清理與 `run.failureCleanup` 也只看 `signal.aborted`，不帶取消原因。

**參考做法**：Codex 有 `CodexErr::TurnAborted`；opencode 的取消是 typed `SessionError`（`aborted`），可被 UI 與 retry 決策直接分辨。

**影響**：桌面／CLI 只能用 `signal.aborted` 猜；telemetry 上取消與真實失敗長得一樣（沒有 `provider/error`、沒有 `aborted` 事件），rollout 事後也難判定「這一步是被停止的」。

**建議方向**：統一 `{name:'AbortError', code:'ABORTED'}`；`step/end` 加 `canceled` 旗標；telemetry 增加 `provider/aborted`（payload-free）。

**單檔測試**：可。`finishCancelledBatch` 斷言丟出的錯誤具備 `code==='ABORTED'`（目前只有 message）。

---

## A-12 沒有模型 failover：容量錯誤固定同一模型 10 秒 ×5 次；切換模型則作廢準備與校準（M）

**一句話**：IH 只有「同一 provider/model 的重試」與「重試耗盡就失敗」，沒有 fallback 鏈；而正常切換模型（`bindingForStep` 改變）會讓 in-flight 準備全部 stale 並丟掉 provider 校準錨點。

**證據**

- `packages/llm-seam/src/retry/execution.ts:64-88`：`capacityLimited` 固定 ≥10 秒、`maxRetries` 上限（`policy.ts:48` = 5），全部重打同一個 request；`policy.ts:52` 的可重試集合沒有任何「換模型」概念。
- `packages/core-agent/src/agent/response.ts:70`：AUTH/INVALID_API_KEY 只做 `ownedBudget.retire(...)` 然後失敗。
- `packages/core-agent/src/agent/context.ts:84-95`：`refreshBinding()` → `ownedBudget.invalidate()`（retire `binding-changed`）；`packages/core-agent/src/agent/admission.ts:24,30`、`managed-admission.ts:38-41` 使 in-flight 準備以 `CONTEXT_INPUT_STALE` 重建。

**參考做法**：Codex 有 `allow_provider_model_fallback` 與 fallback model（`core/src/session/mod.rs:492,800-807`）及壓縮模型 fallback（`core/src/compact_model_fallback.rs`）；opencode 的 `rotate-and-retry-full` 會在輸出尚未開始時換模型（`session/runner/step.ts:185-190`）。

**影響**：單一 provider 額度用盡或容量飽和時，IH 只能「等 5 次 ×10 秒後失敗」，使用者必須手動換模型重來；換模型後第一次請求失去 server-observed 錨點，又回到 A-02 的高估估算。

**建議方向**：加上 provider/model fallback 鏈（只在 `!outputStarted` 時允許、且只對容量／額度／5xx 生效）；切換 binding 時把「同一對話前綴的 server-observed token 數」保留為新錨點的 estimate 而非直接丟棄。

**單檔測試**：可。`createRetryingClient` 注入連續 429／CAPACITY，斷言嘗試次數與最小延遲（目前 5 次同模型）；fallback 本身需新增介面，無法用現有單檔測試。

---

## 附錄：讀過的關鍵檔案

- 迴圈與結算：`core-agent/src/agent/{managed-turn,response,model-step,turn,admission,managed-admission,recovery,budget,context,managed-context,step-input,reasoning,finalization,boundaries,create,managed-create,manual-compaction,tool-generation,request-input}.ts`、`tool-batch/{join,cancel,dispatch,types}.ts`、`executor.ts`
- 上下文縮減：`core-agent/src/agent/context-reduction/{managed,composition,bridge,sequence,automatic,summary-policy,instruction-lease}.ts`、`context-engine/src/{admission/{assess,prepared,pressure,capacity},reduction/{run,selection,prune,proposal,contracts},snapshot/build}.ts`
- 壓縮：`compaction/src/{config,index,prepared-summary,summary/{generate,stream,prompt,pages,port,overflow,source,checkpoint},tokens}.ts`
- Seam 與重試：`llm-seam/src/{index,waiting-guard,retry/*,provider-error/*,prepared/{fallback,validation,stream-lifetime,passive-observation}}.ts`
- Provider：`llm-{openai,openai-compatible,anthropic,gemini,bedrock}/src/{client,stream/{decode,fold,usage},request/messages}.ts`
- 記帳與輸出：`token-meter/src/{estimate,breakdown,accepted-calibration,calibration-usage,projection/{pricing,measure}}.ts`、`output-retention/src/index.ts`、`shell/src/tools/retention.ts`、`context-output/src/{config,result-page}.ts`、`session-executor/src/context-composition.ts`
- 參考：Codex `core/src/{compact.rs,compact_token_budget.rs,state/auto_compact_window.rs,protocol/src/error.rs}`；opencode `session/{runner/step.ts,runner/retry.ts,compaction.ts,usage.ts}`
