# M48：會話可靠性與 TUI 交付接線

日期：2026-09-05
基線：`950c092`
分支：`m48`

## 目標

M48 將 M47 盤點出的四項交付問題收斂成可驗收的閉環：

1. 同一 session 的某一個 submit 失敗後，後續排隊 submit 必須結算，不得永久 pending，也不得產生未處理 rejection。
2. 預設 TUI 必須能使用現有 JSONL/session coordinator 保存、列出及恢復會話；`--resume` 不得再只是接受後忽略。
3. Rewind 必須由實際 TUI 宿主入口接線，且其能力邊界要與引擎的 v1 語義一致。
4. PTY 測試基線必須找出 `case-010` 首幀 `frame-flushed` marker 超時的根因；只有在根因被證明是測試環境契約時，才可調整測試，不得以放寬 timeout 或跳過案例代替修復。

## 範圍與不做項目

### 納入

- `packages/session-executor` 的 session chain rejection/settlement 行為及回歸測試。
- `packages/tui`、`apps/tui` 與必要的 persistence 組裝接線。
- TUI session id 的建立、resume、list、close flush、ownership conflict 錯誤處理。
- TUI Rewind store root、recorder、bridge 與恢復後 session 的一致性測試。
- `packages/tui-core` `case-010` 及其 PTY runner/host 的根因修復或明確環境契約修正。
- README、CAPABILITIES、CAPABILITIES-DETAIL 與 M48 spec/plan 的狀態同步。

### 不納入

- 不更換 JSONL 格式、SessionCoordinator 公開契約或 SDK wire 版本。
- 不重寫 Rewind 演算法；不把 shell、外部編輯器或未經 recorder 記錄的變更宣稱為可回滾。
- 不新增完整跨進程協作、dashboard、帳號登入或 web/desktop 新面。
- 不以大型檔案拆分作為獨立重構目標；只有在接線必要時做最小邊界調整。

## G1：會話佇列可靠性

### 現況與根因假設

`SessionService.submit` 使用 per-session `chains` 讓下一個 turn 等待上一個 turn。現行 chain 只在 `prev.then(success)` 的成功分支啟動下一個 turn；若 assembly 建立或前一 turn 失敗，下一個 turn 沒有 rejection 分支，因此會永遠停留在 queued。該假設須先由同一 service、同一 session 的可重現測試確認。

### 設計

- chain gate 必須在前一 turn resolve 或 reject 時都推進。
- 前一 turn 的錯誤只歸屬於前一 submit；後續 submit 是否執行由自身的 `closed`、`AbortSignal` 及 assembly/lane 狀態決定，不得隱式吞掉後續錯誤。
- 每個 submit 仍只 settle 一次；cleanup 必須在成功與失敗路徑一致執行，並移除 stale `chains`/`active`/queued 計數。
- `close()` 必須能在失敗、取消及排隊混合狀態下完成；不得因 chain rejection 或 dangling promise 卡住。
- telemetry 保留既有 `session/request`、`session/queued`、`session/error` 語義；不新增會誤導為模型成功的事件。

### 驗收

- 第一個 submit 由 `loadMeta` 或 model/lane 明確失敗，第二個 submit 仍會在有限時間內 resolve 或 reject，且不會 pending。
- 第一個 submit 失敗後，第三個 submit 的結果符合既有 lane 語義，不能因上一個錯誤永久封鎖 session。
- queued abort、in-flight abort、close 及跨 session parallel 測試保持通過。
- 測試捕捉 `unhandledRejection` 時不會收到同一錯誤的額外未處理 rejection。

## G2：TUI 持久化與恢復

### 設計

沿用 CLI/web 已使用的 `createJsonlBackend` + `createSessionCoordinator`，不複製第二套持久化實作。TUI host 負責決定 store root；session service 負責 assembly lifecycle，coordinator 負責 durable event log、repair 與 ownership lease。

- 新會話：建立 durable session id/meta，再以該 id 建立 assembly；首個 prompt 只對空 session 自動提交一次。
- `--resume <id>`：先以 coordinator load/repair 該 session，再 adopt ownership，建立帶有 restored `Session` 的 assembly；未知 id、版本不支援、ownership conflict 均 fail-closed 並以可理解錯誤結束。
- `listSessions()`：以 coordinator list/profile 取得持久化 session，不以目前 process 的 in-memory map 冒充完整列表；若 store 未指定，才保留明確的 ephemeral fallback。
- close：停止輸入、等待 active turn、flush 該 session 的 write-behind，再 dispose assembly，最後由 host 關閉 coordinator；不得由 assembly 關閉 caller-owned coordinator。
- session metadata（title、model selection、workspace id）沿用既有 header/updateMeta 路徑，不把 metadata 變成新的事件類型。

### 驗收

- 進程 A 寫入至少一個 turn 後關閉；進程 B 使用相同 store root 與 `--resume` 能看到既有事件並接續 turn。
- resume 不會重複自動提交初始 prompt，不會遺失恢復前的事件，也不會改寫 append-only 歷史。
- 兩個 writer 同時 resume 同一 session 時，第二個明確得到 ownership conflict；退出後可再次取得 lease。
- 未指定 store root 的 TUI fallback 會在狀態與文件中清楚標示為 ephemeral，而非假稱 durable。

## G3：Rewind 入口接線

### 設計

- TUI 的 store root 與 session store root 使用明確、可預期的路徑組合；不把 Rewind journal 混入 session JSONL。
- 有 durable session id 且啟用 store 時，assembly 建立 `RewindStore`/`RewindRecorder`，TUI backend 才暴露 rewind member；缺少必要條件時保持 capability absent，不能顯示可用但實際 no-op 的控制項。
- TUI session 切換或 resume 後，rewind bridge 必須解析目前 assembly，避免沿用上一個 session 的 store。
- rewind execute 的檔案恢復、conversation marker、point truncate 仍由既有 `RewindService` 負責；host 只負責生命週期與 UI capability wiring。
- UI/文件明確列出 v1 限制：shell-only 變更無 recorder pre-image，不會被列入或恢復；conflict 會被標示且依既有 destructive-by-design 語義處理。

### 驗收

- 從實際 TUI factory 建立一個 durable session，執行 fs write，能取得 points、plan、execute 並看到檔案恢復與 rewind event。
- resume 或 open 另一 session 後，rewind points 不會串用。
- 沒有 store root、沒有 session id、或 ephemeral fallback 時，UI 不提供 rewind 操作入口。
- recorder/store dispose 不洩漏 subscription、lock 或暫存資源。

## G4：PTY 基線與文件

### 調查順序

1. 讀取 `case-010` 的 scene、host marker 寫入點、PTY child exit 與 runner event 訂閱順序。
2. 分別確認 child 是否啟動、是否寫 stdout、是否建立 marker、是否在 node-pty callback 中收到資料；必要時加入只在測試失敗時可觀察的診斷資訊。
3. 比較通過案例的 spawn/marker/flush 慣例，找出 `case-010` 的差異。
4. 以最小單一變更驗證根因，再補回歸案例；不先調大 15 秒等待、不刪除 marker gate。

### 驗收

- `case-010` 穩定通過，包含首幀、零字節 idle、resize 與 teardown。
- `@i-harness/tui-core` 全部測試通過；若仍受 Windows ConPTY 外部條件影響，測試輸出必須記錄具體條件與可重現命令，並將該狀態標為未完成，不宣稱全量綠燈。
- `pnpm typecheck`、`pnpm test`、`pnpm e2e`、dist/installer 驗證按實際可執行性完成並記錄結果。
- 文件中的 M38 舊缺口、M47 狀態與 M48 已修復／仍限制項目以現行入口和測試為準同步。

## 交付順序

1. G1 先建立失敗回歸測試並修復 chain root cause。
2. G2 建立 TUI persistence assembly seam，再補 process-level resume/list/flush 測試。
3. G3 在 G2 的 durable session 基礎上接線，補實際 factory 的 Rewind 驗收。
4. G4 先完成 PTY 根因調查，再執行文件更新與完整驗證。

每組完成後只接受該組的最小變更；跨組需要新發現時，先更新 plan/spec，不把未驗證的假設直接擴大成重構。

## 完成定義

M48 只有在 G1–G4 都有實際測試證據、型別檢查與全量驗證結果，且文件與程式入口一致時才算完成。任何仍失敗的 PTY、resume 或 ownership 案例都必須列為未完成項，不以 mock-only 或單元測試替代產品入口驗收。
