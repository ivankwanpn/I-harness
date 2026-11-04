# 修復進度檢查點（2026-11-04）

15 輪內已修並推上 `experiment/audit-fixes-v0.1.13` 的項目，以及尚未處理的清單。

## 已修（有測試/證據）

| 範圍 | 項目 | Commit |
|---|---|---|
| 子代理 | spawn admission 序列化（per-parent FIFO，child 仍並行） | `3223f2ae` |
| 子代理 | birth 只有 `blocked` 才進 recovery；refused/not-issued 正常回報 | `601a930f` |
| 子代理 | birth 失敗寫入 runtime diagnostics（outcome + ids） | `1ad4051d` |
| 子代理 | owned child 工具授權（registry binding fallback） | `bcce268b` |
| UI | 時間軸內部記帳不再變「會話狀態已更新」 | `c7e5415d` |
| UI/gateway | `desktop/session/reload` + 自動重載、reload 退役待批卡片 | `cba08449`、`a9ace2e4` |
| 審批 | recovery 分類穿過 cleanup 聚合 | `9bbd898d` |
| 審批 | NG-01 fail-open（policy identity 不可用時誤判有效） | `c8da3ec2` |
| 審批 | NG-02 rememberPending 未批准即建永久規則 | `c8da3ec2` |
| 持久化 | S-02 process latch poison 無法清除 | `b23c0874` |
| 持久化 | S-03 torn tail 具名 not-issued、不再 poison | `33ab4949` |
| 持久化 | S-04 document fsync + 失敗清 temp | `9e131a58` |
| 持久化 | S-05 document 讀寫失敗不再偽裝成功/不存在 | `c93245e5` |
| 持久化 | S-01 未發出的 conflict 可恢復（quarantine 有出口） | `183af856` |
| 持久化 | S-06 第一步：append 重用 decoded journal 快取 | `f55d9c08` |
| 持久化 | S-10 header 寫入端也驗 64 KiB 上限 | `f7d0b476` |
| 持久化 | S-11 rewind cut 改用 seq 座標 | `aa30048b` |
| 持久化 | S-12 fork atSeq 越界不再靜默改邊界 | `a66986ec` |
| gateway | NG-04 錯誤 frame 事件上限 256 KiB | `a08f4065` |
| gateway | NG-05 reload 退役待批互動 | `a9ace2e4` |
| gateway | NG-07 surface 訂閱失敗可重試、不佔名額 | `b922790e` |
| 工具 | A-05 apply_patch 容忍空行（End Patch / hunk 之間） | `2123874b` |
| 工具 | A-06 workflow job 依 session 隔離讀取/殺 | `863a2841` |
| 建置 | A-09 ACL native 資產入版控（乾淨 clone 可打包） | `297b496e` |
| 設計 | 子代理 runtime 重設計方案（A） | `6173b0a8`、`8eea32ef` |
| 設計 | child exec context 分層方案（L1–L4） | `90f13eba` |

## 尚未處理（依嚴重度）

### Critical / High

- **D-01/D-02 子代理三份事實來源、task document 參與 spawn 交易**：目前用 admission 序列化止血，尚未做 job store + write-behind projection（方案 A step 1）。
- **D-03 child exec context**：方案已寫；L1 coordinator child execution 存取尚未實作，L2 child shell factory 未有。
- **A-01 模型回應完整性**：串流 EOF／空回應被當成功（`EMPTY_RESPONSE` 無生產者）。
- **A-02 context 預算啟發式**：ASCII/3 與 /4 雙密度、CJK 每字 3 token，提前壓縮。
- **A-03/A-04 壓縮**：retainTokens 預設 0、摘要上限 1024 tokens、摘要沿用主 prompt 且關 cache。
- **A-05 未知 context window 時壓縮被靜默關閉**。
- **D-07 fail-closed recovery 不持久**：仍需 durable reconcile 或降級為 job error。
- **D-12 測試基礎**：317 個測試依賴外部 evidence；fixture 遷移未完成。

### Medium

- NG-03 typed RPC errors（machine code/retryable）
- NG-06 審批 ingress 呼叫者身分
- NG-08 session/status 字彙不一致
- NG-09 shutdown 以通知送出、無 ack
- NG-10 owned child 授權只驗 registry binding
- NG-11 hook `permission: ask` 被轉 deny
- NG-12 核准規則頁手動快照、不標 stale
- A-01（tools）shell timeout 未傳入 ExecCommand
- A-02（tools）shell 輸出只有 head 64KB、無截斷提示
- A-03（tools）背景工作只在記憶體、重啟失效
- A-04（tools）apply_patch 不支援 `*** Move to:`
- A-07 workflow 輸出無上限
- A-08 assurance/qualification 裝飾性
- A-10 Desktop 以 TS+tsx 出貨、CLI 是 bundle
- A-11 MCP 只殺直系子行程
- A-12 WSL 每命令重開 worker
- A-06（agent）硬溢位恢復只允許一次
- A-07（agent）provider tool-call id 全 session 唯一
- S-06 第二步：增量語意驗證（目前仍每 append 走完整 validator）
- S-07 rewind 跨耐久域
- S-08 fork 耐久單位
- S-09 write-behind 路徑（需再確認是否死路）
- D-05 審批 identity 仍雜湊活的工具表面
- D-06 RPC 錯誤無 code（同 NG-03）
- D-13 Electron 二進位未納入安裝流程、CI 無 build gate

## 2026-11-05 追加修復（第 16–29 輪）

| 範圍 | 項目 | Commit |
|---|---|---|
| 子代理 | child exec L1：child execution 取得 + release | `70c139c6` |
| 子代理 | L2a：child execution domain | `9563e4ce` |
| 子代理 | L2b：childShellFactory 管線（registerSubagent → child assembly） | `7a479c7a` |
| 子代理 | L2c：child 專屬 shell 工具 + desktop host factory（best-effort） | `6ca2f52e` |
| provider | A-01：OpenAI／Anthropic EOF 無終止事件 → error | `637e774c` |
| provider | A-01：Gemini／Bedrock 同上 | `6c657764` |
| token | A-02：child overhead 改用共用密度 | `aadfdc09` |
| token | A-02：`approxTokens` 改用共用密度（compaction/assembly overhead） | `43641d02` |
| compaction | A-04：摘要請求改為獨立（無主 system prompt／tools） | `e5bbe5cf` |
| sdk | NG-03：failure `{kind,retryable}`、overload 分類 | `20fdbcef` |
| sdk/gateway | NG-09：close() 以 request 關閉、CLI 接受舊通知 | `eafeddde` |
| workflow | A-07：job stdout/stderr 上限 1M 字元 + 截斷提示 | `1764f32d` |
| 審計 | A-03 覆核維持設計；A-04 修復記錄 | `3a29bc11` |

同時覆核但**不改**：A-01（tools）shell timeout（exec 的 timer 會連背景 promoted job 一起殺，前景 deadline 已由 guard abort 生效）、A-05（agent）未知 window（context state 已回 `unavailable` + reason）。

## 2026-11-05 追加修復（第 40–49 輪）

| 範圍 | 項目 | Commit |
|---|---|---|
| tools | A-10：shell head+tail 加可見省略標記，且標記計入 byte budget | `3576461d` |
| core-agent | A-11：`agent aborted` 帶 `AGENT_ABORTED` code | `76c2c6a7` |
| hooks | NG-11：`permission: ask` 進入 approval seam（無 answerer 仍 fail-closed） | `2ce4e6b5` |
| desktop | NG-12：核准規則 grant／revoke／removeSession 後通知，頁面自動重讀 | `fa22fcb9` |
| protocol | NG-08：統一 `queued/running/completed/error/cancelled`，legacy 拼法由 `normalizeSessionStatus` 接收 | `4722c2ed` |
| 測試 | execution-surfaces 改 composed coordinator（10/10） | `f8c96754` |
| 測試 | sdk fork 路由改 composed coordinator（54/54） | `22d9eada` |
| 測試 | accepted-exchange 改用 pre-bind `wrapOwnedBatch`（14/14） | `3b612378` |
| 測試 | agent-team composed 寫入與完整 delivery 邊界（2/2） | `1ea6cebe` |
| 審計 | A-03 dispose 降級嘗試與還原理由 | `a0e818fd` |

同時覆核但**不改**：A-03 的 `dispose()` 降級（attempt retire 失敗同時承載 descriptor/spill recovery debt，降級會吞掉真正需要 recovery 的訊號）、agent-team harness 卡住（已證實是覆寫 action 方法，不是 coordinator 拒絕 team 寫入）。

## 2026-11-05 追加修復（第 50–53 輪）

| 範圍 | 項目 | Commit |
|---|---|---|
| 建置 | 安裝檔重建（`751e1f36…`）＋第 40–49 輪 checkpoint | `9226f8d4` |
| 驗證 | `pnpm -r --no-bail typecheck` 全庫 82 packages 全綠 | `36bbbf1e` |
| mcp-client | A-11：Windows 關閉時 `taskkill /T` 終止 MCP 後代行程 | `8ad5584d` |
| 審計 | A-06／A-07 覆核：維持 fail-closed（既有測試已固定安全屬性） | `ec9a9b1e` |
| exec | A-08：`IH_MINIMUM_EXEC_ASSURANCE` 設定後端 assurance 下限，admission fail-closed | `32409b1c` |

## D-12 測試基礎：已遷移與新發現（2026-11-05）

- 已遷移並全綠：`desktop-gateway/execution-surfaces`（10/10，含 cold restart 後 job_output／PTY 的 saved facts 讀取）、`sdk/server.test`（54/54，fork 流程約 20s，該檔放寬 testTimeout 至 30s）、`core-agent/accepted-exchange`（14/14，透過 `createJsonlBackend({ wrapOwnedBatch })` 在 canonical-path guard 綁定前注入）。
- **agent-team 的 `TASK_TRANSITION_UNSUPPORTED` 只是第一層**：把 `ownedTeamFixture` 改成 composed coordinator 後，`acknowledgement-settlement` 由全失敗變成 20/37 通過；其餘 17 個失敗，其中一個曾出現 `FACT_INVALID_GROUP`（`managed-document.ts` 的 executionStage.rejected 路徑），但**最小重現推翻了「所有 team 寫入都被拒」的假設**：直接用 composed coordinator + `createTeamFacts`／`createTeamTransact`／`createMailbox` 發送訊息會成功（`sendMessage` 回 `{status:'queued'}`）。
- 後續把同一測試單獨跑並提高 timeout，失敗形態變成**流程卡住**（30s timeout，不是 `prepareWrite` 拒絕），因此現階段判斷是**測試 harness 與 composed coordinator 的互動**（`document.beginAction` wrapper、`observeAckSources` monkey-patch、`createTaskDelivery` 的 delivery 路徑）而非單純產品拒絕。
- **已用完整 delivery 流程證實**：`composed-team-write.test.ts` 第二個案例在 composed coordinator 上完成 queued → consumed → `team/message/delivered`（2/2 通過），所以卡住來自 harness 覆寫 action 方法（beginAction／registerSettlementSource），不是 coordinator 拒絕 team 寫入。下一步是改寫 harness 使用 control hooks，而不是修產品。
- 該實驗（fixture + control hooks）已**還原**，避免留下半綠套件；`backend-factory` 的 `wrapOwnedBatch`（core-agent 使用）保留。
- 其餘 100+ agent-team 失敗多為同一 TASK_TRANSITION 源頭，待上述問題釐清後才能批量遷移。

## 驗證現狀

- **2026-11-05（第 51 輪）**：`pnpm -r --no-bail typecheck` 全庫 82 packages **全綠（exit 0）**——第 1–49 輪的累積修改（含 protocol／notification／hooks／shell／workflow／session-executor／gateway／desktop）在型別層一致。
- `pnpm -r --no-bail typecheck` 最後一次全綠；每個修復都附單檔測試（workflow 63/63、fs 110/110、sdk failure-events 3/3、session-persistence latch 10/10、jsonl append-cache 2/2、header-limit 3/3、torn-tail 1/1、document 2/2、desktop-gateway 相關 4/4+3/3+1/1、core-session rewind 2/2、fork-prefix 3/3）。
- 完整 `pnpm test` 仍受測試基礎債限制，不能作為 gate。

## 下一輪

1. **調查 `FACT_INVALID_GROUP`**：在 composed coordinator 下重現最小的 team transaction 寫入，判斷是缺少 session 前置（team parent meta／adapter）還是 `prepareWrite` 真的拒絕 team 群組；這是 agent-team 測試與 desktop team 功能的共同關鍵。
2. 依結論修產品或補 fixture，再批量遷移 agent-team 測試。
3. 之後回到 A-03 的 exec job store／`dispose()` 降級。
