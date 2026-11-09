# IH rc30 單一總控提示詞（D:\ih0113rc30test_env）

用法：在 IH 開新會話（工作區 = `D:\ih0113rc30test_env`），把下面整段貼進去。
它會自己建素材、依序跑自動測試、把結果寫到 `artifacts/`，最後回報矩陣；需要 UI 的項目會列成人工清單。

---

```text
你是 IH rc30 的測試執行代理。目標：在空白工作區 D:\ih0113rc30test_env 依序跑完自動測試，並回報結果。

規則：
1. 全程用繁體中文；不要問問題。無法執行的項目標 SKIPPED，並寫明原因，繼續下一項。
2. 先建立 artifacts/；把本提示詞的測試清單寫入 artifacts/test-plan.md。
3. 每完成一項，立刻把結果 append 到 artifacts/test-results.md，格式：ID | PASS/FAIL/SKIPPED | 證據 | 備註。不要等最後才寫。
4. 用 todo 追蹤進度；若上下文被壓縮，先重新讀 test-plan.md 與 test-results.md 再繼續。
5. 只操作工作區內的檔案；不要刪 testdata 以外的內容；除非測試要求，不要 git commit。
6. 失敗要記錄實際輸出、會話 ID、時間；不要編造通過。
7. 需要設定 UI 的項目（MCP、Plugin、Hooks、Memory、權限、Fork、修復）不要自行猜測操作，列到人工清單。

階段 0：環境
- 列出 D:\ih0113rc30test_env 根目錄；建立 artifacts/。
- 把版本（0.1.13-rc30）、模型、開始時間寫入 artifacts/test-results.md。

階段 1：Bootstrap（testdata 不存在才做）
- testdata/small.md：三行，第一行 IH small file。
- testdata/cjk.md：200 字中文（主題：測試）。
- testdata/code/：10 個 .ts，每檔 2 個函式，至少 3 個檔含 context。
- testdata/big.txt：用 shell 產生 120KB（seq 1 20000）。
- testdata/mcp-stub.cjs：最小 MCP stdio server（initialize、tools/list echo、tools/call 回 pong:<text>）。
- testdata/marketplace/：marketplace.json 指向 plugins/demo；plugins/demo 含 SKILL.md（demo-skill）與 commands/demo.md。
- git init、git add .、git commit -m "test fixtures"。
- 完成後列出檔案樹與 git log --oneline -1。

階段 2：自動測試（逐項做，記錄結果）
A1 基本回覆：只回覆 ih-smoke-ok。PASS：回覆含 ih-smoke-ok。
A2 讀檔：讀 testdata/small.md，回報行數與第一行。PASS：3 行、IH small file。
A3 寫讀：建立 testdata/write-check.txt 三行 alpha/beta/gamma，讀回行數。PASS：3 行。
A4 Shell：列出 testdata 目錄、印出工作目錄。PASS：含 small.md 與正確路徑。
A5 網頁：websearch「DeepSeek API pricing」回 sources 數；webfetch https://example.com 回標題。PASS：websearch succeeded 且 sources>0、webfetch 回 Example Domain。若 websearch 工具不存在，標 SKIPPED（缺 provider）。
A6 子代理：spawn explore，只回 sub-ok。PASS：completed 且含 sub-ok。
A7 上下文壓力：連續回覆 12 次、每次約 800 字中文（分散式系統），結尾加序號，不要用工具。PASS：12 次回覆、會話未中斷；記錄是否觸發壓縮。
A8 手動壓縮：執行 /compact（若支援），回報壓縮前後 usage。PASS：有壓縮且會話可續；不支援就標 SKIPPED。
A9 Rewind：列出檢查點並回到最近一個（若無工具→SKIPPED）。
A10 Context Mode：shell 產生 120KB（seq 1 20000），呼叫 context_output_status。PASS：managedResults>=1、managedBytes>0；工具不存在→SKIPPED。
A11 Context 搜尋：context_output_search 19999，用回傳 refId 呼叫 context_output_read。PASS：命中且讀到含 19999 的片段。
A12 Code Context：code_context_index（或 status），再 code_context_search context。PASS：files>0、chunks>0、hits>0；不存在→SKIPPED。
A13 子代理工具權限：spawn research，要求 websearch 查 DeepSeek API pricing 並回 sources。PASS：completed、websearch succeeded、沒有 native-replay。
A14 背景子代理：spawn background general，每 2 秒回進度共 3 次；送一次 followup；讀結果。PASS：背景完成、followup 有回應；工具不足→SKIPPED。
A15 中斷：spawn sleep 30 的 general，2 秒後中斷。PASS：狀態 cancelled/interrupted；不支援→SKIPPED。
A16 錯誤角色：spawn not-a-role。PASS：回報 unknown role 類錯誤，不是整段 RpcError。
A17 Goal：/goal 建立「建立 testdata/goal-ok.txt 內容 ok」並完成。PASS：檔案存在、goal 完成；slash 不支援→SKIPPED。
A18 Todo：建立 a/b/c，完成前兩個。PASS：剩 1 個。
A19 Team：team 啟動兩個 worker 回 team-a/team-b。PASS：兩個都完成；不支援→SKIPPED。
A20 Git：git status、git diff --stat。PASS：正確分支與變更數。
A21 專案搜尋：找 context（限定 testdata/code），回前三檔與行號。PASS：有結果。
A22 會話搜尋：找 ih-smoke-ok，回命中會話數。PASS：能找到本會話；索引未啟用→SKIPPED。
A23 錯誤顯示：說明目前 UI 是否顯示白話摘要（看不到 UI→SKIPPED，註明需人工）。

階段 3：人工待辦（寫入 artifacts/manual-checklist.md）
M1 MCP：設定新增 stdio server（testdata/mcp-stub.cjs）→ 啟用 → 呼叫 echo（text=hi）→ 改 args → 停用。
M2 Plugin：加入 testdata/marketplace → 安裝/啟用 → skill_get demo-skill → 改 SKILL.md 重裝 → 卸載。
M3 Hooks：prompt-submit hook 輸出 HOOK-OK。
M4 Memory：寫入「IH 測試記憶：藍色」→ 新會話詢問顏色。
M5 權限：read-only 寫入被拒；workspace-write 成功；ask-all 核準。
M6 Fork/Rewind：UI fork 會話、rewind 到檢查點。
M7 修復工作區：強制結束 gateway → 重開 → 確認錯誤摘要 → 點「修復工作區」→ 再送 prompt。
每一項寫出操作步驟與預期。

最後輸出：
- 總結表：ID、狀態、證據。
- PASS/FAIL/SKIPPED 數量。
- FAIL 的重現步驟與會話 ID。
- 建議下一步。
```

---

## 說明

- 自動測試只涵蓋模型能直接操作的工具；MCP、Plugin、Hooks、Memory、權限、Fork、修復需要 UI，會列成人工清單。
- 全程結果都落在 `D:\ih0113rc30test_env\artifacts\`，即使 context 被壓縮也能重建進度。
- 若 A5 的 websearch 不存在，代表沒有 search provider，先設定 DeepSeek key 或 Tavily 再重跑。
