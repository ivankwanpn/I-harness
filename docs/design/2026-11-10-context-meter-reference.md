# Context meter：對齊參考項目（rc82）

## 參考

DSH `ContextMeter`：

- trigger：環形進度 + 百分比；
- panel：`~used / window`、百分比、分段 bar；
- 分段：system／tools／messages；
- 顯示各段 token 數；
- 沒有 first-token／request body 等自訂延遲欄位。

OpenCode：context/usage 命令與 dialog，重點是 context 容量與用量，不是 latency。

Codex：thread context 狀態，不把 request latency 放進 context panel。

## rc82 實作

`ContextUsage`：

- 保留環形 trigger 與百分比；
- panel 顯示 used / window；
- 新增分段 bar：system／tools／messages；
- 顯示三段 token 數；
- 移除自訂的 request size／first token／duration rows。

## UI 驗證

在 rc82 portable 實際開啟 conversation、點「上下文容量」：

```text
估算上下文容量
顯示上一次請求的估算；下一次請求準備完成後會更新。
刷新狀態
```

這個 session 是 private runtime，context admission 是 compatibility／unavailable，所以 panel 沒有可顯示的 segmented bar；fallback 正常。

已在一般 session 的 context state 上通過 typecheck 與 build；segmented bar 尚未在 UI 實際看到。

## 2026-11-27 上下文用量的計算口徑

比較範圍是本機 `D:\ih-reference-project` 中的固定版本。下表的數字用途會影響公式，尤其是是否納入上一次輸出，以及分母用模型視窗還是扣除輸出預留後的輸入預算。

| 參考版本 | 畫面如何取得數字 | 對 IH 有用的做法 |
| --- | --- | --- |
| DSH 0.2.3-alpha.2 | 從最近一次回報取得輸入量，已拆分的快取讀寫各加一次。再加上從取樣到現在、模型實際可見內容的估算差額。 | 用實測作基準，只估新增內容。畫面可讀持久化投影，執行端對當次準備好的請求另算輸出預留及壓縮門檻。 |
| Pi 1.5.1 | 優先採用上一筆有效 assistant 回覆的 provider total，含輸入與輸出，並估算回報後的尾段。壓縮後要等新回報才能重新建立這個基準。 | 清楚辨識過期的取樣。舊壓縮邊界、另一個模型或未成功的請求不能直接代表目前內容。 |
| OpenCode 2.2.6 | UI 選擇當前撤銷邊界之前、最近一次已完成壓縮之後的 assistant 用量，依該回覆的模型取得視窗。執行端可用同供應商的回報加上後續未計量的訊息，沒有基準時會重新估算。 | 讓畫面讀到的數字對得上產生它的模型和分支，後端仍需處理真實的超限拒絕。 |
| Codex 0.172.0 | 依最近一次 token 回報與有效模型視窗算剩餘比例，TUI 公式另有 12,000-token 基線。會話恢復取持久化的最近回報，壓縮成功後會另估替換後的內容。 | 最近請求和整個會話累計必須分清。IH 的指示器顯示輸入預算使用比例，無須套用 Codex 的固定基線。 |
| ZCode 3.17.2 | 指示器由主模型完成事件更新，使用含快取的輸入與輸出。壓縮後有 `tokensAfter`，冷開可從目前有效的歷史或壓縮記錄恢復讀數。 | 將廉價、可恢復的顯示資料與當輪輸入的實際檢查分開。 |

原始碼入口位於各參考專案內。

- DSH 的 `packages/llm/token-meter/src/usage-projection.ts` 和 `packages/client/ui-conversation/src/client/context-occupancy.ts`。
- Pi 的 `packages/coding-agent/src/core/compaction/compaction.ts` 和 `packages/coding-agent/src/core/agent-session.ts`。
- OpenCode 的 `packages/client/src/solid/usage.ts`、`packages/gui-plugins/src/context/indicator.tsx` 和 `packages/core/src/session/compaction.ts`。
- Codex 的 `codex-rs/tui/src/token_usage.rs` 與 `codex-rs/core/src/context_manager/history.rs`。
- ZCode 的 `apps/zcode-cli/packages/contracts/src/model/index.ts` 與 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`。

### IH 的選擇

IH 的執行端已能以已接受請求的供應商輸入量校準估算。會話、執行身分、模型綁定、請求格式、計價版本及已送出的前綴都相符時，才加上新輸入的估算。供應商已將快取計入總輸入時不再相加。回合結束後未回放的推理或輸出，不應直接計入下一次輸入。這些條件由 `packages/token-meter/src/accepted-calibration.ts` 與 `calibration-usage.ts` 實作。

指示器要回答上次實際用了多少輸入，以及已準備的請求估計占多少視窗。上次的數字須來自可對應主請求的供應商回報。模型視窗有可靠來源時，以同一觀察的輸入估算除以模型視窗，這個比例可跨回合閱讀。能核實的有效輸入預算另列。只有缺少模型視窗而確有輸入預算時，才改以輸入預算為分母並明示。有歷史數字時要標明模型與來源，有估算但無可靠分母時只顯示數量。缺少兩者時顯示未知。即使畫面有歷史數字，送出、壓縮和超限恢復仍須按當前請求獨立驗證。

### 估算與供應商回報的配對

已完成的主模型請求若具有可比對的接受收據、正規化用量與對應的 v2 預算觀察，`session/context` 會附上選用欄位 `lastReportedInputTokens`。數字屬於該次主請求，包含供應商已計入的快取輸入，排除輸出。會話累計、標題產生以及其他會話的呼叫都不能代替這筆讀數。模型設定改變、回退、壓縮或收據無法對齊時省略此欄。這不會把冷會話的顯示數據恢復為可執行的校準憑證，也不改變現有持久格式。

畫面在歷史估算、需要壓縮或供應商拒絕的情況下，仍能同時呈現已有的數字與狀態。模型視窗不明時仍可讀估算數，缺少可驗分母則不顯示百分比。有已匹配的上次供應商讀數時，即使下一次的圖片或不透明內容尚不能估算，仍可查看先前的實測輸入。系統、工具與訊息等分項是各自的估算，經供應商用量校準的總數未必等於分項相加。

在固定程式 `50b26dab` 上，使用同一個 Windows 桌面長會話，比對 `53d56121` 的五秒等待情境。四次交錯測量的開頁中位數為 538 與 545 毫秒，Gateway 收到至接納為 741 與 749 毫秒，送出至可見首段為 2.48 與 2.46 秒。四個完整模型請求、八筆持久 v2 預算判定及回傳內容均相符，沒有新增壓縮。這組測試覆蓋用量顯示對準備路徑的影響，每個版本兩次。收據為 `native-cold-reopen-abba-50b26dab-ClVgXA/normalized-context-parity.json`。

同版原生畫面測試重現一個時間差。第一輪已提交 4,321 個輸入 token 的供應商回報，畫面上的估算已標為 stale，同一請求在日誌中的已完成預算為 awaiting-projection。兩者的模型、分支、實際請求與接受事件相同，原比對卻因估算狀態名稱不同而漏顯真實用量。現行配對允許這種已過期的畫面估算取回原請求的實測輸入，來源或分支改變時仍省略。

### Windows 開發版驗收

固定程式 `fcfb2d36` 在隔離的桌面設定中跑了兩輪本機 Responses 請求。第一次準備時估算 13,034／128,000（10.2%），完成後供應商回報輸入 4,321，其中包含 901 個快取 token。第二次使用前次已接受用量校準，送出前估算 4,374／128,000（3.4%），完成後回報輸入 5,432，其中包含 1,203 個快取 token。這些是可控端點的測試數字，用以檢驗資料歸屬與顯示。兩次來源都核對了持久日誌。

重開原生桌面後面板自動顯示第二輪歷史估算與 5,432 的實測。第二輪尚未完成時，第一輪的回報沒有被放到新估算上。切換到沒有資料的工作區時顯示 `—`，更換模型後舊估算保留其歷史模型身分，已核實的舊回報不會掛在新模型上。實際用滑鼠與鍵盤操作，兩次從標題列正常退出，無相關程序殘留。完整收據為 `native-context-capacity-fcfb2d36-receipt.json`，面板畫面為 `context-capacity-popup-fcfb2d36.png`。

和 `53d56121` 的四次長會話五秒等待交錯對照中，兩組配對的四份完整模型請求與八筆原始預算決策均相同。送出到畫面首段的中位數由 2.453 秒到 2.464 秒。這個小樣本支持本次顯示變更未帶來明顯延遲，也不足以聲稱整體加速。收據為 `native-cold-reopen-abba-fcfb2d36-CGbIRw/normalized-context-parity.json`。

### 2026-11-28 已量測的圖片與不透明內容

同一個仍有效的執行會話中，供應商已計入圖片或不透明續傳資料，之後只附加能本地估算的訊息時，面板可用既有輸入量加上新增尾段。計數器只記最後一個含未知成本內容的訊息位置，並確認所有此類內容都落入已驗證且相符的前綴。模型、分支、執行身分、請求格式或前綴失配，新增加圖片或不透明內容，或有無法歸屬的外部輸入時，這個估算沒有可用證據。此規則只供顯示。實際送出的內容、輸出上限、容量及壓縮判定仍由完整請求的原規則決定。

在真正的 Windows Gateway 和本機 Responses 端點，第一輪送出一張 1×1 圖片，送前估算未知，回覆後記錄 4,321 個實測輸入 token，已包含 3,000 個快取 token。第二輪只送文字，輸入估算為 4,371，由 4,321 加上回放的助理文字 27 與新增文字 23 得到。第三輪新增另一張圖片，估算回到未知。三份完整模型請求、輸出上限、後端決策及耐久結果與基準相符。收據為 `gateway-media-prefix-fcfb2d36-vs-source.json`。

固定程式 `6fac2a36` 另用 Windows 桌面的實際輸入框驗收。測試在 Chromium 派送含 PNG 檔案的貼上事件，確認附件縮圖後按送出。三輪新增圖片數分別是 1、0、1，實際 Responses 請求連同歷史各含 1、1、2 張圖片。桌面先顯示未知，續輪顯示 4,371／128,000（3.4%），再次新增圖片後回到未知。三輪回覆和用量均已寫入，關閉桌面後測試程序數為零。端點在本機提供固定用量，這組驗收用於確認介面與後端是否對上同一筆資料。收據為 `native-media-capacity-6fac2a36-receipt.json`。

### 供應商用量本身有矛盾時

本機 Responses 對照送回 4,321 個輸入 token，快取寫入總數 400，兩個完整 TTL 分項卻合計 500。`6fac2a36` 能在獨立的用量觀察中辨識這個矛盾，仍會把 4,321 保存成主會話的實測，並把下一輪估為 4,377。問題出在串流合併部分只把無效標記用於計算生成速度。

現在同一次模型嘗試只要收到明確的無效標記，後續部分用量更新就會保留它。原始數字仍供診斷，正常回覆照常落盤，校準器會略過這次取樣。下一次獨立嘗試可再採用有效回報。Messages 和 Bedrock 的普通輸入不含快取，已明確送出的非數字快取欄位也會標為無效。Messages 在部分回報允許的空值維持原本的合併行為。定向回歸收據為 `usage-measurement-validity-core.log`、`usage-measurement-validity-meter.log`、`llm-anthropic-invalid-counter-all.log` 及 `llm-bedrock-invalid-counter-final.log`。[Messages 的欄位定義](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)

舊會話的用量紀錄只保存總額及當時可對應的請求，單憑該筆紀錄無法重算原始 TTL 分項。有保留獨立用量觀察的環境，可用同一個實際模型送出識別和當時的無效標記核對特定案例。冷開會話時，歷史數字僅供顯示，新執行期會從自己的有效供應商回報開始校準。

在固定版 `6d54960c`，同一組 Responses 回覆仍完成正常對話，無效的 4,321 留在原始用量觀察，主會話沒有產生這筆校準。下一輪先採本機估算，之後收到有效的 5,432 才建立新樣本。兩版的兩筆實際 HTTP 請求內容一致。Windows 桌面的三輪圖片測試也再次通過。收據為 `gateway-usage-validity-6fac-vs-6d54960c.json` 及 `native-media-6d54960c-receipt.json`。

Messages 案例中，第一輪原始輸入為 7，快取讀取卻是字串 `"3000"`。舊版顯示實測 7，新版只保留原始診斷及正常回覆。第二輪帶有合法的輸入 7、快取讀取 3,000、快取建立 400。後續部分更新回報輸出 11 且輸入欄為空，最終正確得到 3,407 個輸入 token。這次兩版後續發送的 `max_tokens` 的確不同，原因是原先的錯誤低估曾擴大剩餘輸出空間。其餘請求欄位相同。收據為 `gateway-messages-validity-6fac2a36-receipt.json` 及 `gateway-messages-validity-6d54960c-receipt.json`。

### 2026-11-28 對話容量讀數

採用 DSH 將上下文用量投影與畫面分開的做法，以及 Pi、OpenCode 核對產生讀數的模型和會話歷史的做法。IH 的百分比表示單次主對話請求的輸入佔比。下一次準備送出的內容可能改變，因此區分上一次供應商已回報的輸入量和當次已準備的估算。

| 會話狀態 | 指示器的讀數 |
| --- | --- |
| 正在準備或送出，已有可辨識的請求 | 顯示當次輸入估算。已核實的模型視窗優先作分母，只有可核實的輸入預算時，面板會標明分母。 |
| 主請求已完成，供應商用量與該請求相符 | 優先顯示該次實測輸入，面板另列當時的估算。快取依協議正規化一次，輸出與推理不另加進這個輸入讀數。 |
| 收到容量拒絕或需要壓縮 | 顯示相應請求的壓力、估算與原因。先前成功請求的較低實測值可另行查看。 |
| 已更換模型、壓縮或回退，仍在等候新的有效請求 | 清除舊比例並顯示原因。收件回條、標題和核准請求各自有獨立用途。 |
| 讀回同一主會話 | 核對原請求、模型與歷史。實測可配對時恢復該讀數，只有歷史估算時標示其來源。 |

Windows 桌面的收件、模型估算和容量面板各有一個職責。SDK 篩選主對話和其恢復重試的預算。桌面依同一套規則產生按鈕、說明和進度條，歷史改寫會同步使尚未返回的舊讀取失效。一般狀態更新沿用現有的合併讀取，不增加輪詢。

在含 9,457 筆記錄的實際長會話日誌內，從尾部找最近的對話預算只需查看四筆事件，取得的仍是序號 9,453 的預算。這是讀取預算這一步的成本。壓縮與回退另外核對預算和改寫事件的順序，冷開仍須驗證來源。收據為 `context-occupancy-tail-lookup.json` 和 `context-superseded-e039f8c2-proof.json`。

Windows 整合測試使用本機 Responses 端點和 128,000-token 視窗。第一輪回報 4,321，桌面顯示 3.4%。第二輪等候供應商回覆期間，桌面顯示當次估算 4,374；回報 5,432 後改顯示 4.2%，重啟仍能讀回相同的實測。切換至不同模型後，上個模型的百分比退出顯示。測試同時核對實際請求、已保存的回報和使用者可見的面板。
