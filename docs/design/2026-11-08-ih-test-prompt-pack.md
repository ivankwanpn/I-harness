# IH 完整測試提示詞包（rc30）

> 用法：在 IH 開一個新的測試工作區（ih-test），把每段「提示詞」貼進輸入框。
> 每段附預期；不符合就記下會話 ID、診斷記錄、截圖。
> 工具不在清單時，先叫模型用 tool_search 找；找不到就要求回報缺少工具，不要編造。

## 0. 前置設定（一次性）

1. 建工作區 ih-test，加入專案，放入：testdata/small.md（幾行）、testdata/big.txt（>200KB）、testdata/code/（10+ 個 .ts）、testdata/cjk.md（中文）。
2. 設定：Context window 先 8,000（測壓縮後改回 1,000,000）；Context Mode ON；Code Context ON（lexical）；網頁存取 live；子代理允許獨立模型；權限 full-access。
3. 每區測試用新會話，避免 context 污染。

## 1. 冒煙（6 條）

### 1.1 基本回覆
> 只回覆 ih-smoke-ok，不要使用任何工具。

預期：ih-smoke-ok。

### 1.2 讀檔
> 請讀取 testdata/small.md，回報檔案行數與第一行內容。

預期：使用 read；數字與內容正確。

### 1.3 寫檔＋讀回
> 請建立 testdata/write-check.txt，內容三行：alpha、beta、gamma；然後讀回並回報行數。

預期：write 成功、read 回 3 行。

### 1.4 Shell
> 請用 shell 列出 testdata 目錄並印出目前工作目錄，回報兩者。

預期：執行成功、路徑與列表正確。

### 1.5 網頁
> 請先呼叫 websearch 查「DeepSeek API pricing」，回報 sources 數量；再呼叫 webfetch 抓 https://example.com ，回報標題。

預期：websearch succeeded（sources > 0）；webfetch 回 Example Domain。若 websearch 不存在，回報缺少 provider，不要用 shell curl 代替。

### 1.6 子代理（無工具）
> 請用 spawn_agent 以 explore 角色啟動子代理，要求它只回覆 sub-ok；完成後把子代理原文回報。

預期：子代理 completed、回覆 sub-ok。

## 2. 上下文與壓縮（window 先 8,000）

### 2.1 壓力與自動壓縮
> 接下來請連續回覆 12 次，每次約 800 字中文（主題：分散式系統），每次結尾加序號。不要使用工具。第 12 次後回報總共回覆幾次。

預期：context 使用率上升；觸發 compaction／soft reduction；會話不中斷；回報 12 次。

### 2.2 手動壓縮
> 請執行手動壓縮（/compact），完成後回報：壓縮前後 context 使用量、是否有摘要、是否保留原始請求。

預期：壓縮完成、usage 下降、沒有 fixed-input 類錯誤。

### 2.3 壓縮後續答
> 壓縮後請總結目前聊過的三個重點，並說明摘要來源。

預期：能引用壓縮摘要；不聲稱記得已被丟棄的細節。

### 2.4 Rewind
> 請列出目前 rewind 檢查點，選最近一個回到該點，回報已回到檢查點。

預期：rewind 成功；沒有 ambiguousTurn。

### 2.5 大檔讀取
> 請用 shell 產生 120KB 的 testdata/big.txt，然後讀取它並摘要成 5 點。

預期：大量輸出被 Context Mode 接管（若啟用）；context 不爆。

## 3. Context Mode（managed artifacts）

### 3.1 大輸出捕獲
> 請用 shell 產生 120KB 文字（例如 seq 1 20000），不要一次貼出；完成後呼叫 context_output_status，回報 managedResults 與 managedBytes。

預期：managedResults >= 1、managedBytes > 0。

### 3.2 搜尋＋讀取
> 請用 context_output_search 搜尋 19999，找到後用回傳的 refId 呼叫 context_output_read，回報片段與 offset。

預期：search 命中、read 成功、offset 合理。

### 3.3 重啟後讀取
（手動重啟 IH，開同一會話）
> 請用 context_output_status 確認 managed 結果仍在，然後用同一 refId 再讀一次。

預期：重啟後仍可讀（stale-source grant）。

### 3.4 關閉子系統
（設定關閉 Context Mode，新會話）
> 請呼叫 context_output_status，回報 enabled 與 state。

預期：enabled:false、state:disabled（不是崩潰）。

## 4. Code Context

### 4.1 建索引
> 請呼叫 code_context_index 重建索引（或用 status 確認就緒），回報 files 與 chunks。

預期：files > 0、chunks > 0、state ready。

### 4.2 搜尋
> 請用 code_context_search 搜尋 context，回報 hits 數量、第一個檔名與行號；不要用 grep。

預期：hits > 0、有 path/line。

### 4.3 關閉子系統
（設定關閉 Code Context，新會話）
> 請呼叫 code_context_search 搜尋 context，回報結果或錯誤。

預期：工具失敗（TOOL_FAILED／未啟用），不是靜默成功。

### 4.4 Hybrid（可選，需 embedding server）
> 請重建 Code Context 索引，完成後回報 mode 與 chunks；再搜尋 context 回報 hits。

預期：mode hybrid、索引完成、查詢成功。

## 5. 子代理（角色／工具權限／生命週期）

### 5.1 角色差異
> 請分別用 explore、research、general 各啟動一個子代理，要求它們回報自己的工具清單（不要用工具），把三份清單並排列出，標注哪些角色有 write／shell／websearch。

預期：explore／research 沒有 write；general 有 shell／write；有 web 權限才看得到 websearch。

### 5.2 工具權限（先到設定把 research 的網頁勾選）
> 請用 spawn_agent 以 research 角色啟動子代理，要求它呼叫 websearch 查「DeepSeek API pricing」並回報 sources 數量。

預期：子代理 completed；websearch succeeded；sources >= 1（沒有 native-replay）。

### 5.3 背景＋追問
> 請用 spawn_agent（background）啟動 general 子代理，讓它每 2 秒回報一次進度共 3 次；再用 subagent 控制送一則 followup，最後讀取結果。

預期：背景任務可見、followup 有回應、結果可讀。

### 5.4 中斷
> 請啟動一個會 sleep 30 秒的 general 子代理，2 秒後中斷它，回報中斷狀態。

預期：cancelled／interrupted，不卡住。

### 5.5 錯誤顯示
> 請用 spawn_agent 指定不存在的角色 not-a-role，回報你看到的錯誤訊息。

預期：清楚的 unknown role 錯誤；不是整段 RpcError 紅字。

## 6. MCP

### 6.1 建立 stdio stub
> 請在 testdata/mcp-stub.cjs 建立最小 MCP stdio server：支援 initialize、tools/list（echo 工具）、tools/call（回傳 pong:<text>）。完成後回報路徑。

### 6.2 新增並啟用（同一會話）
> 請透過 IH 的 MCP 設定新增 stdio server（name: live-test，command: node，args: testdata/mcp-stub.cjs），啟用後直接呼叫 echo（text=hi），回報輸出。

預期：不需重啟；pong:hi。

### 6.3 修改 command
> 請把 live-test 的 args 改成另一個 stub（回傳 pong2:<text>），儲存後再呼叫一次，回報輸出。

預期：remount 後 pong2:hi。

### 6.4 停用
> 請停用 live-test，然後再嘗試呼叫它的工具，回報結果。

預期：工具不存在／TOOL_FAILED。

## 7. Plugin／Marketplace

### 7.1 建立本機 marketplace
> 請建立 testdata/marketplace：marketplace.json 指向 plugins/demo；plugins/demo 內含 SKILL.md（name: demo-skill）與 commands/demo.md。完成後回報檔案樹。

### 7.2 安裝／啟用／使用
> 請把 testdata/marketplace 加入 Plugin 來源，安裝並啟用 demo plugin；然後用 skill_get 載入 demo-skill，回報內容。

預期：install+enable 成功；skill_get 回 SKILL.md。

### 7.3 重裝（更新）
> 請修改 demo plugin 的 SKILL.md（加一行 v2），重新整理來源後重新安裝；再用 skill_get 確認讀到 v2。

預期：重裝成功、內容更新（不是 EPERM）。

### 7.4 卸載
> 請卸載 demo plugin 並移除來源，回報 plugins 與 sources 數量。

預期：皆為 0；install 目錄與 materialize 清除。

## 8. Skills／Commands／Hooks／Memory

### 8.1 Skill
> 請列出目前可用 skills，選一個載入，回報名稱與描述。

### 8.2 自訂 command
> 請建立 commands/hello.md（內容：請用一句話問候 $ARGUMENTS），然後執行 /hello world。

預期：命令展開、模型收到 world。

### 8.3 Hook（prompt-submit）
（先到 Hooks 設定建立 prompt-submit hook：輸出 HOOK-OK）
> 請只回覆 hook-test。

預期：hook 觸發；回覆含 HOOK-OK 或日誌可證。

### 8.4 Memory
> 請把「IH 測試記憶：藍色」寫入 memory，然後開新會話問「IH 測試記憶是什麼顏色？」

預期：新會話能回答藍色（Memory 開啟時）。

## 9. 工作流／Goal／Schedule／Team

### 9.1 Goal
> /goal 建立目標：「在 testdata 建立 goal-ok.txt，內容 ok」，完成後回報 goal 狀態。

### 9.2 Todo
> 請建立三個 todo（a、b、c），完成前兩個，回報剩余數量。

### 9.3 Team
> 請用 team 啟動兩個 worker，分別回報 team-a 與 team-b，最後彙整。

### 9.4 Schedule
> 請建立一個 1 分鐘後執行的排程，內容：只回覆 scheduled-ok；時間到後回報是否執行。

## 10. Git／專案／搜尋／Fork

### 10.1 Git
> 請在目前工作區執行 git status、git diff --stat，回報分支與變更檔數；不要 commit。

### 10.2 專案搜尋
> 請用專案搜尋找 context（限定 testdata/code），回報前三個檔案與行號。

### 10.3 Fork
> 請把目前會話 fork 成新會話，然後在新會話回覆 forked-ok。

### 10.4 Session 搜尋
> 請搜尋過去會話中提到 ih-smoke-ok 的紀錄，回報命中會話數。

## 11. 權限／沙箱／Shell

### 11.1 read-only
（設定 sandbox = read-only，新會話）
> 請建立 testdata/denied.txt，回報結果。

預期：寫入被拒；錯誤清楚。

### 11.2 workspace-write
> 請建立 testdata/allowed.txt，內容 ok，回報結果。

### 11.3 核準
> 請執行 shell：echo approval-ok。

預期：出現核準；允許後成功、拒絕後不執行。

### 11.4 WSL（可選）
> 請在 WSL 執行 uname -a，回報發行版。

## 12. 錯誤顯示與工作區修復

### 12.1 友善錯誤
（執行中強制結束 IH gateway，重開）
> 請只回覆 error-check。

預期：錯誤卡顯示白話摘要；原始訊息在 tooltip／診斷記錄。

### 12.2 修復工作區
（承上，若出現 recovery 錯誤）點「修復工作區」。

預期：runtime 重啟、.i-harness 備份、會話 reload；再送一次成功。

### 12.3 子代理 native-replay 回歸
> 請用 spawn_agent 以 research 角色啟動子代理，要求它先 websearch，再 webfetch，最後回報兩個工具都成功。

預期：completed；websearch／webfetch succeeded；沒有 native-replay。

## 13. 記錄模板

- 段落：
- 提示詞：
- 預期：
- 實際：
- 會話 ID：
- 時間：
- 診斷記錄（匯出）：
- 截圖：

## 14. 建議順序

1. 冒煙（1）
2. 上下文（2）→ Context Mode（3）→ Code Context（4）
3. 子代理（5）→ MCP（6）→ Plugin（7）
4. Skills／Hooks／Memory（8）→ 工作流（9）→ Git／Fork（10）
5. 權限（11）→ 錯誤／修復（12）

每完成一區，開新會話，避免前一區 context 影響下一區。
