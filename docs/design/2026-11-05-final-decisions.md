# 剩餘四項：完成與設計決策（2026-11-05，第二階段）

承接 `2026-11-05-remaining-redesigns.md`。壓縮後的新工作階段已完成 S-08、S-06，並對 D-01 final、A-12 做出**明確的設計決策**（不是搁置）：兩者的「風險／收益」在目前架構下不成立，文件記錄理由與未來重啟條件。

---

## 0. 驗證基線（先講清楚什麼是紅的）

- `pnpm -r --no-bail typecheck`：**82 packages，exit 0**。
- `session-persistence-jsonl` 全套在 format 14 下大量失敗（**379 failed / 477 passed**）。這**不是本次改動造成**：
  - 以 `git stash` 取 baseline 同環境重跑為 **378 failed / 477 passed**；逐檔比較失敗集合相同，逐測試比較只差一個 5 秒 timeout 的 flake（`cold-selected-capability`）。
  - 失敗主因是 `TASK_TRANSITION_UNSUPPORTED`：legacy `createSessionCoordinator` 在 format 14 沒有 transition storage，任何 `coordinator.create()` 都直接丟錯。這是 D-12 尚未遷移的測試債務，不是產品路徑（desktop 用 composed coordinator）。
- 本次改動的針對性測試（全綠）：
  - `session-persistence`：`fork-publication` 2/2、`document-write-errors` 2/2。
  - `session-persistence-jsonl`：`list-incomplete` 2/2、`document-write-preimage` 2/2、`task-document-write` 8/8、`task-document-observation` 25/25。
  - `subagent`：`job-record-recovery` 8/8。
  - `agent-team` composed 目標檔：見 §1 的執行記錄。

---

## 1. S-08：fork 的原子發佈（已完成，`40de2c51`）

### 實作：durable publication marker

- 新增 `packages/session-persistence-jsonl/src/backend/publication.ts`：
  - 在 child header 的第一個 byte 之前，建立並 fsync `<id>.jsonl.publishing`（檔案 + 目錄），三個 header issuance 路徑都會呼叫：public（`prepareBootstrapHeader`）、captured（`prepareCapturedHeader`）、selected-results（`selectedHeader`）。
  - `list()` 用**已經在讀的** `readdir` 名稱集合過濾 marker，成本為零。
  - completion frame commit 時清除：`fact-journal` 的 `appendOwnedBatch` / `reconcileOwnedBatch`、`selected-fact-journal` 的同名路徑；任何「完成 birth」的讀取（`assertPublicBootstrap`）也會清除 stale marker。

### 為什麼不用方案 A（先寫 `.forking` 再 rename）

`filePath(id)` 是整個 backend 的定址契約：session 檔、document sidecar、journal、rewind intent、deletion manifest 全部由它推導。把「targetSessionId → 檔名」解耦會動到 fail-closed 的 recovery 路徑（crash 後要能由 id 找到半成品），而這些路徑正是先前多次實驗失敗的地方。marker 提供**相同的可見性語意**（未完成 birth 不可見），且不改變任何既有 durable 形狀或 recovery 狀態機。

### 測試

- `list-incomplete`：有 marker 的部分檔案被隱藏；移除 marker 後可見（含 zero-byte 案例）。
- `fork-publication`：
  - 成功的 fork：child 出現在 `list()`，且**沒有** `.publishing` 殘留（捕獲路徑也走 `prepareCapturedHeader`，因此覆蓋 captured header issuance）。
  - 注入 completion batch 失敗（模擬 crash 窗口）：child header + marker 存在、`list()` 不含它；**冷启动的第二個 backend 也一樣**（證明 marker 是 durable，不是 warm set）。

### 已知殘餘（刻意）

若 crash 發生在「completion frame 已 commit」與「marker unlink」之間（微秒級窗口），child 會保持隱藏，直到下一次以 id 開啟它（retry/resume 會走 completed-birth 讀取並清除 marker）。這是**寧可暫時隱藏，也不顯示半成品**的取捨；先前行為是直接列出無法開啟的 child。

---

## 2. S-06：document 大小上限／串流寫入（已完成，`40591c73`）

先前已完成 append 的 journal cache 與 preimage/candidate 的串流 digest；本次把最後兩個 O(n) 記憶體點清掉：

- `confirmCandidate()`：不再把發佈後的候選整份讀回記憶體比對。改為「開啟同一 inode → 驗 identity → fsync → 以 64 KiB 視窗串流 SHA-256 驗證」，in-place writer 在 fsync 與 digest 之間改寫仍會被判 conflict。
- partial temp 續寫：不再 `Buffer.alloc(limit + 1)` 全量讀取，改以 64 KiB 視窗比對已寫前綴，回傳相符長度後從該位置續寫。
- 上限統一：新增 `TASK_DOCUMENT_MAX_BYTES = 64 MiB`（`session-persistence` 匯出），由 staging（`task-document-operation.ts`）、observation（`task-document-observation.ts`）、publication（`document-write.ts`）三層共用，避免漂移。

### 格式與上限決策

- **格式維持**單一 JSON 物件 + 原子替換。document 是 projection/checkpoint（見 §3），寫入已被 write-behind coalescing 合併；改成 append/segment 格式會同時改動 v1/v2/v3 文件契約、`preserve`/repair 驗證與 desktop 讀取器，收益與風險不成比例。
- **上限維持 64 MiB**。串流化之後，上限不再是記憶體保護，而是「多大的 document 算 caller error」的契約；調降需要先確認既有任務文件的實際大小分佈與 desktop 的降級行為，屬於契約決策，不宜在本次變更中一併改。

### 測試

`task-document-write` 8/8（含「partial temp 續寫不另建 candidate」）、`document-write-preimage` 2/2、`task-document-observation` 25/25、`document-write-errors` 2/2。

---

## 3. D-01 final：以「權威來源」定義完成（`bedd827f`）

### 決策

**不移除**可變 task document 寫入；把它明確定位為 **projection / checkpoint**。durable fact 是 **job record + child session**。

### 依據（已在程式與測試中確認）

- `submit` / `claim` / `terminalize` 對 document 的寫入都是 fire-and-forget（`void save().catch(() => {})`）：admission 從不等待 document。
- `restoreTaskDocument` 在 document 缺失或不可讀時，由 job records 重建（`rebuilt`），並走正常 v1 restore（ID counter seeding 仍生效）。
- `classifyRestoredTasks` 以 terminal job record 為優先，child session 只提供 result text。
- 新增的 e2e：document store **全部失敗**時，`submit` / `claim` / `terminalize` 仍成功、`flushPersistenceBestEffort` 回報 `{ok:false}`、新 registry 由 job records 重建出 completed + child linkage。這把「admission 不依賴 document」從隱含事實變成回歸測試。

### 新增的強化

`recordJob` 的 append 失敗原本只寫 debug log（靜默）。現在保留最多 16 筆並由 `flushPersistenceBestEffort` 回報，讓**權威來源**的寫入失敗不再被吞掉。

### 為何不真的移除寫入

document 是 ID counter seeding、notification 投影與 desktop catalog 的 O(1) 快照；要移除它必須先把「ownership proof（v3 parent witness）」與「task projection」分離——這正是 audit 指出的同一組 witness 風險。在沒有獨立 witness 設計前移除寫入，等於把 fail-closed 的 ownership 檢查換成 projection 推導，穩定性上是倒退。

---

## 4. A-12：決策「不做 worker 重用」

### 決策

維持 **one launcher = one trusted guest worker = at most one workload**；不實作 worker 重用。

### 理由

- 現行設計是刻意的 trust boundary：`WorkerClient` 的註解與 `runner.py` 的狀態機（settle → cleanup → 退出，`finally` 保留 original ownership 並在失敗時拋 `WorkerFailure`）都以「單一 workload、結束即退出」為前提。
- 重用會讓 **untrusted spec** 進入長生命週期 process，必須重新定義：output framing 的所有權、per-workload cancel token、idle 回收、supervisor crash 偵測、以及 settled 之後誰保證 guest tree 為空。
- 已完成的成本削減是 distribution 驗證 per-backend 快取（`de99ee29`）；剩餘成本主要是 `wsl.exe` attach，屬於平台成本。

### 若未來重啟：唯一可接受的方向

guest **supervisor-fork**：supervisor 只持有 trusted constants 與 pipe，每個 workload `fork` + `exec` 一個全新的 python worker（隔離與現在相同），host 協議 v2 為每個 workload 加 id/framing，settle 後回 `ready`。需要獨立安全審查、protocol v2 相容策略，以及「fake transport 計數 spawn 次數（連續兩次 prepare 只 spawn 一次）」的測試。這是獨立專案，不在本分支冒險。

---

## 5. 後續建議（最大的測試債務）

整個 `session-persistence-jsonl` suite 的 379 個紅測試幾乎都是同一個根因：**legacy `createSessionCoordinator` 在 format 14 不能 `create`**（`TASK_TRANSITION_UNSUPPORTED`）。要讓它們轉綠，需要把這些測試遷移到 `composeJsonlTaskTransitionCoordinator`（或提供 legacy create 的相容層）。這是 D-12 的剩餘主體，建議以「每個測試檔一次」的方式推進，並以本次的 baseline 比對方法確認沒有新增失敗。
