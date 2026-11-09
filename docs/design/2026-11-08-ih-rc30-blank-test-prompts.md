# IH rc30 空白環境測試提示詞（D:\ih0113rc30test_env）

這份是專為 **空白資料夾** 準備的版本：所有測試素材都由第一段 Bootstrap 提示詞建立，不需要先放任何檔案。

## 0. 環境

- 測試根目錄：`D:\ih0113rc30test_env`（空白）
- 建議把 IH 相關資料也放在同一層，方便清理：
  - `app\`：rc30 應用程式
  - `config\`：`IH_CONFIG_DIR`
  - `userdata\`：`--user-data-dir`
  - `artifacts\`：截圖、診斷匯出、測試紀錄
- 啟動（PowerShell，範例）：

```
$env:IH_CONFIG_DIR='D:\ih0113rc30test_env\config'
Start-Process 'D:\ih0113rc30test_env\app\I-harness.exe' -ArgumentList '--user-data-dir=D:\ih0113rc30test_env\userdata'
```

- 在 IH 開啟工作區 `D:\ih0113rc30test_env`，加入專案。
- 到「關於」確認版本是 **0.1.13-rc30**。
- 設定：Context window 先 8,000（壓縮測試後改回 1,000,000）；Context Mode ON；Code Context ON（lexical）；網頁存取 live；子代理允許獨立模型；權限 full-access。

---

## 1. Bootstrap（先貼這一段，建立所有素材）

> 請在目前工作區（D:\ih0113rc30test_env）建立測試素材，完成後列出檔案樹與 git 狀態：
> 1. `testdata/small.md`：三行文字（第一行 `IH small file`）。
> 2. `testdata/cjk.md`：200 字中文段落（主題：測試）。
> 3. `testdata/code/`：10 個 `.ts` 檔，每個檔含 2 個函式，其中至少 3 個檔出現 `context` 這個字。
> 4. `testdata/big.txt`：用 shell 產生 120KB 文字（例如 seq 1 20000）。
> 5. `testdata/mcp-stub.cjs`：最小 MCP stdio server（initialize、tools/list 一個 echo 工具、tools/call 回傳 `pong:<text>`）。
> 6. `testdata/marketplace/`：marketplace.json 指向 `plugins/demo`，內含 `SKILL.md`（name: demo-skill）與 `commands/demo.md`。
> 7. `artifacts/` 目錄。
> 8. `git init`，`git add .`，`git commit -m "test fixtures"`。

**預期**：所有檔案存在、`testdata/big.txt` ≥ 120KB、git 有一個 commit。

---

## 2. 冒煙（6 條）

### 2.1 基本回覆
> 只回覆 ih-smoke-ok，不要使用任何工具。

預期：`ih-smoke-ok`。

### 2.2 讀檔
> 請讀取 testdata/small.md，回報行數與第一行。

預期：3 行、`IH small file`。

### 2.3 寫檔＋讀回
> 請建立 testdata/write-check.txt，內容三行：alpha、beta、gamma；讀回並回報行數。

### 2.4 Shell
> 請用 shell 列出 testdata 目錄、印出目前工作目錄，回報兩者。

### 2.5 網頁
> 請呼叫 websearch 查「DeepSeek API pricing」，回報 sources 數量；再呼叫 webfetch 抓 https://example.com ，回報標題。

預期：websearch succeeded（sources > 0）；webfetch 回 Example Domain。若 websearch 不存在，回報缺少 provider。

### 2.6 子代理
> 請用 spawn_agent 以 explore 角色啟動子代理，要求它只回覆 sub-ok；把子代理原文回報。

---

## 3. 上下文與壓縮（window 8,000）

> 接下來連續回覆 12 次，每次約 800 字中文（主題：分散式系統），結尾加序號，不要用工具。第 12 次後回報總次數。

預期：context 壓力上升、觸發壓縮、會話不中斷。

> 請執行手動壓縮（/compact），回報壓縮前後 usage、是否有摘要。

> 壓縮後請總結目前聊過的三個重點，並說明摘要來源。

> 請列出 rewind 檢查點，選最近一個回到該點，回報已回到檢查點。

> 請讀取 testdata/big.txt 並摘要成 5 點。

---

## 4. Context Mode

> 請用 shell 重新產生 120KB 輸出（seq 1 20000，不要一次貼出），完成後呼叫 context_output_status，回報 managedResults 與 managedBytes。

> 請用 context_output_search 搜尋 19999，找到後用 refId 呼叫 context_output_read，回報片段與 offset。

（重啟 IH 後）
> 請用 context_output_status 確認 managed 結果仍在，然後用同一 refId 再讀一次。

（到設定關閉 Context Mode，新會話）
> 請呼叫 context_output_status，回報 enabled 與 state。

預期：enabled:false、state:disabled。

---

## 5. Code Context

> 請呼叫 code_context_index 重建索引（或 status 確認），回報 files 與 chunks。

> 請用 code_context_search 搜尋 context，回報 hits、第一個檔名與行號；不要用 grep。

（關閉 Code Context，新會話）
> 請呼叫 code_context_search 搜尋 context，回報結果或錯誤。

預期：工具失敗（未啟用）。

---

## 6. 子代理

> 請分別用 explore、research、general 啟動子代理，要求它們只回報自己的工具清單（不要用工具），標注哪些有 write／shell／websearch。

（到設定把 research 的「網頁」勾選）
> 請用 spawn_agent 以 research 角色啟動子代理，要求它呼叫 websearch 查「DeepSeek API pricing」並回報 sources 數量。

預期：completed、websearch succeeded、沒有 native-replay。

> 請用 spawn_agent（background）啟動 general 子代理，讓它每 2 秒回報一次進度共 3 次；再送一則 followup，最後讀取結果。

> 請啟動一個 sleep 30 秒的 general 子代理，2 秒後中斷它，回報狀態。

> 請用 spawn_agent 指定不存在的角色 not-a-role，回報錯誤訊息。

預期：清楚的 unknown role，不是整段 RpcError。

---

## 7. MCP

> 請透過 IH 的 MCP 設定新增 stdio server（name: live-test，command: node，args: testdata/mcp-stub.cjs），啟用後直接呼叫 echo（text=hi），回報輸出。

預期：pong:hi（不需重啟）。

> 請把 live-test 的 args 改成另一個 stub（回傳 pong2:<text>），儲存後再呼叫一次。

> 請停用 live-test，再嘗試呼叫它的工具，回報結果。

---

## 8. Plugin／Marketplace

> 請把 testdata/marketplace 加入 Plugin 來源，安裝並啟用 demo plugin；用 skill_get 載入 demo-skill，回報內容。

> 請修改 demo plugin 的 SKILL.md（加一行 v2），重新整理來源後重新安裝；用 skill_get 確認讀到 v2。

> 請卸載 demo plugin 並移除來源，回報 plugins 與 sources 數量。

預期：重裝成功、內容更新；卸載後皆為 0。

---

## 9. Skills／Commands／Hooks／Memory

> 請列出目前可用 skills，選一個載入，回報名稱與描述。

> 請建立 commands/hello.md（內容：請用一句話問候 $ARGUMENTS），然後執行 /hello world。

（Hooks 設定 prompt-submit hook，輸出 HOOK-OK）
> 請只回覆 hook-test。

> 請把「IH 測試記憶：藍色」寫入 memory，開新會話問「IH 測試記憶是什麼顏色？」

---

## 10. 工作流／Goal／Team／Schedule

> /goal 建立目標：「在 testdata 建立 goal-ok.txt，內容 ok」，完成後回報 goal 狀態。

> 請建立三個 todo（a、b、c），完成前兩個，回報剩余數量。

> 請用 team 啟動兩個 worker，分別回報 team-a 與 team-b，最後彙整。

> 請建立 1 分鐘後執行的排程（只回覆 scheduled-ok），時間到後回報是否執行。

---

## 11. Git／搜尋／Fork

> 請執行 git status、git diff --stat，回報分支與變更檔數；不要 commit。

> 請用專案搜尋找 context（限定 testdata/code），回報前三個檔案與行號。

> 請把目前會話 fork 成新會話，然後在新會話回覆 forked-ok。

> 請搜尋過去會話中提到 ih-smoke-ok 的紀錄，回報命中會話數。

---

## 12. 權限／沙箱／核準

（sandbox = read-only，新會話）
> 請建立 testdata/denied.txt，回報結果。

（sandbox = workspace-write）
> 請建立 testdata/allowed.txt，內容 ok，回報結果。

（approval = ask-all）
> 請執行 shell：echo approval-ok。

預期：出現核準；允許後成功、拒絕後不執行。

---

## 13. 錯誤顯示與工作區修復

（執行中強制結束 gateway，重開）
> 請只回覆 error-check。

預期：錯誤卡顯示白話摘要，原始訊息在 tooltip／診斷記錄。

（若出現 recovery 錯誤）點「修復工作區」。

預期：runtime 重啟、.i-harness 備份、會話 reload，再送一次成功。

> 請用 spawn_agent 以 research 角色啟動子代理，要求它先 websearch、再 webfetch，最後回報兩個都成功。

預期：completed、兩個工具 succeeded、沒有 native-replay。

---

## 14. 失敗記錄模板

- 段落：
- 提示詞：
- 預期：
- 實際：
- 會話 ID：
- 時間：
- 診斷記錄（匯出到 artifacts）：
- 截圖：

## 15. 建議順序

1. Bootstrap（1）
2. 冒煙（2）
3. 上下文（3）→ Context Mode（4）→ Code Context（5）
4. 子代理（6）→ MCP（7）→ Plugin（8）
5. Skills／Hooks／Memory（9）→ 工作流（10）→ Git／Fork（11）
6. 權限（12）→ 錯誤／修復（13）

每完成一區開新會話；`artifacts/` 留給截圖與診斷匯出。
