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

## 驗證現狀

- `pnpm -r --no-bail typecheck` 最後一次全綠；每個修復都附單檔測試（workflow 63/63、fs 110/110、sdk failure-events 3/3、session-persistence latch 10/10、jsonl append-cache 2/2、header-limit 3/3、torn-tail 1/1、document 2/2、desktop-gateway 相關 4/4+3/3+1/1、core-session rewind 2/2、fork-prefix 3/3）。
- 完整 `pnpm test` 仍受測試基礎債限制，不能作為 gate。

## 下一輪

1. **L1 child execution 存取**（coordinator/ session-executor），用小測試證明 domain 屬於 child。
2. 接著 **L2/L3 child shell factory**。
3. 之後 A-01（模型回應完整性）與 A-02（token 估算）。
