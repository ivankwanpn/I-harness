# Desktop Gateway 後端新包設計

**日期：**2026-09-25

**狀態：**後端新包的具體設計，待使用者審閱。使用者已批准「可新增一個後端包」，並指出既有 sandbox 應被重用。這份文件不授權修改 `packages/sdk`、`apps/cli` 或 sandbox 各既有包。

**來源：**`docs/superpowers/specs/2026-09-25-desktop-workbench-design.md` §8；基線 `51b45139` 的 `packages/sdk/src/server.ts`、`packages/session-executor/src/assembly.ts`、`packages/interaction/src/index.ts` 與 `apps/cli/src/index.ts`。

## 1. 要解的問題

Desktop 已選用 SDK wire，但現存 `i-harness sdk` 宿主只接通會話主循環：它沒有批准／提問的雙向方法，沒有一般成果 diff／預覽操作，而且 `createSessionService` 呼叫**沒有傳 `sandbox`**。核心後端並非缺 sandbox：`i-harness run` 已從 `--sandbox` 或已載入的 `settings.sandboxMode` 選模式；`session-executor` 已經組裝 sandbox policy、local provider 和 Windows ACL。新包要接通並展示**這些已有能力**，不增加新模式或第二套政策。

只新增一個後端 workspace 包：`packages/desktop-gateway`（發佈名 `@i-harness/desktop-gateway`）。它是 I-harness 後端的另一個本機宿主，不是 Desktop renderer，也不是新的 Agent engine。`packages/desktop` 仍是唯一前端包，透過既有 `HarnessClient` 的 NDJSON JSON-RPC 連這個宿主。

## 2. 包邊界與不變式

`desktop-gateway` 可使用既有內部包 `@i-harness/sdk/server`、`session-executor`、`session-persistence`、`provider-runtime`、`settings`、`interaction`、`sandbox`、`rewind`、`text-diff` 等公開入口。外部依賴只選公開通用庫；本包首選 Node 標準庫及現有 workspace 包，不引入 ZCode／OpenCode／DSH 私有包。`packages/sdk` 和 `apps/cli` 不改；如實作發現必須修改兩者或其他既有後端包，**先停止並重新提案**。

本包持有一個 workspace 對應的一個 `SessionService`、一個耐久 coordinator、一個 SDK server 與一條 stdio 連線；CLI entry 使用 `cwd` 指定 workspace、明確 `--session-dir` 指定耐久位置。stdout 只寫協議 frame，診斷只到 stderr。子進程結束時清理 SDK subscription、pending 人機請求、service、coordinator 和本包暫存資源；不得有被遺留的審批 Promise 或沙箱授權。

## 3. SDK-compatible wire 擴充

既有 19 個 SDK 方法、通知、錯誤碼、`protocolVersion = 3` 的語義保持不變。Gateway 對不屬 `desktop/*` 命名空間的 request 交給 `createSdkServer.handleLine()`。它以 SDK server 的 `onWrite` 為**唯一輸出路徑**：當 `initialize` 成功時，Gateway 只對外加上自己的 capability row，其餘既有 reply 原樣送出；不可把 `handleLine` 的返回字串再次寫 stdout。Gateway 自己的 request／notification也通過同一個有界 writer，遵守 JSON-RPC id 與一行一幀格式。

`desktop/*` request 必須在成功 `initialize` 之後才被接受；`shutdown` 仍可在未初始化時執行。新方法的 `METHOD_NOT_FOUND`、`INVALID_PARAMS`、`INTERNAL_ERROR` 和失聯處置沿 SDK 錯誤包裝；不允許因 malformed frame 或未知方法崩潰。初始化回應新增下列 capability：

| Capability | 方法／通知 | 含義 |
|---|---|---|
| `desktop-interaction: ["1"]` | `desktop/interaction/pending`、`desktop/interaction/reply`、通知 `desktop/interaction/request` | 會話歸屬的批准／問題往返 |
| `desktop-sandbox: ["1"]` | `desktop/sandbox/state` | 已載入並交給執行器的既有模式；不代表新的沙箱引擎 |
| `desktop-review: ["1"]` | `desktop/review/changes`、`desktop/review/diff`、`desktop/review/file` | **工作區級**只讀成果檢查 |

Gateway 若無法安全提供某個 capability，初始化不得宣稱它可用；相關方法也須明確拒絕，不能回假空資料。Desktop 不應只因名稱含 `desktop` 就假設能力已啟用。

## 4. 復用既有 sandbox

宿主在建 `SessionService` **之前**載入 `SettingsStore`，讀 `settings.get().sandboxMode`。首版使用現有設定值，不另增 Desktop 私有「sandbox 真相來源」或新 mode。將該值直接放進 `createSessionService({ workspace, sandbox: mode, ... })`，與 `i-harness run` 的既有選模式結果對稱。`session-executor` 隨後負責 Windows ACL、local sandbox、policy 和 `sandbox/mode` 事件；Gateway 不直接作工具 confinement。

`desktop/sandbox/state` 回 `{ mode, source: "settings", wired: true }` 只在設定已載入、模式已傳給服務且宿主可繼續提供服務時成立。`wired` **不是**「每個未來工具呼叫已預先通過 enforcement」；若讀設定失敗、mode 不合法或執行器無法使用要求的 backend，宿主明確報錯／拒絕執行，不降成 `danger-full-access`。本方法報告的是**配置與宿主接線事實**；驗證執行時限制仍要以真工具 e2e 測試，尤其 Windows workspace-write 和 read-only。不能把「畫面上顯示 read-only」當作 enforcement 證據。

Mode 是該宿主啟動時的快照；後來的設定修改須重啟工作區 Gateway 才生效。UI 顯示這個規則。首版不提供 `desktop/sandbox/set`，避免把建構期模式更改錯寫成即時生效。

## 5. 批准與提問

在 `SessionService.onAssembly` 掛點，把既有 `registerApprovalAnswerer` 與 `registerQuestionProvider` 安裝到 `assembly.ctx`。**不設 `approveAll: true`**。Gateway 為每個請求分配不可重用 id，並記錄 `{ requestId, sessionId, kind, payload, openedAt }`；`payload` 只包含用戶作決定所需的已知欄位，不能附密鑰、任意內部物件或可被客戶端更改的決策策略。

| 行為 | 必須發生的事 |
|---|---|
| 新請求 | 先登記 pending，再發 `desktop/interaction/request` 通知；兩者順序不可反，避免 renderer 收到通知時列表仍為空。 |
| `pending {sessionId?}` | 從 Gateway 當前權威 pending map 返回仍有效的請求，含 sessionId；renderer 重載後可補齊。若宿主已重啟，舊 map 不存在，不能捏造待處理。 |
| `reply {requestId, sessionId, decision}` | 校驗請求存在、sessionId 相符、decision 屬該類合法值；一次性決議並返回 `{accepted:true}`。未知、逾時或已決議 id 返回明確錯誤，絕不默默算批准。 |
| 拒絕或答案 | 用戶選擇的值只送入既有 answerer／question provider Promise；後端政策和工具結果由既有引擎負責。 |
| 斷線、timeout、取消、關閉 | pending Promise fail closed，移除 map 項並向仍在的客戶端通知終止；任何遲到的 reply 都不生效。每項請求在宿主存活期間最多等待 24 小時，屆時批准按拒絕處理、問題按無答案失敗處理，不代填答案。 |

批准只支持既有 `ApprovalRequest` 內容與 `{approved:boolean}`；問題只支持既有 `UserQuestion` 的 prompt/options 與字串答案。首版不發明持久「永遠批准」政策。需要跨 Gateway 進程保留的審批不是本版承諾；崩潰後 durable event log／run failure 呈現真實結果，UI 不把舊 pending 當仍可回答。

## 6. 工作區級成果檢查

**語義邊界：**Git 和文件系統的現況屬工作區，不必然屬某個會話。Desktop 可在某任務旁打開它，但標題必須是「工作區變更」，不能宣稱「這個 Agent 改了這些文件」；真正按任務歸因需日後另有證據契約。

- `desktop/review/changes {}`：只讀查看工作區版本庫的已追蹤修改、新增／刪除和未追蹤文件；不在 Git 庫或 Git 不可用時返回具名 `unavailable` 狀態，不把它當「沒有改動」。條目只帶 workspace 相對路徑、變動類別、可否讀 diff／預覽及必要的截斷指示；首版最多返回 500 條，更多時附 `truncated:true`。
- `desktop/review/diff {path, maxBytes?}`：對一個已列出的、位於工作區內的文字文件返回從 `HEAD` 到當前工作樹的有界 unified diff（含 staged 和 unstaged），預設上限 512 KiB、硬上限 2 MiB，包含 `truncated` 與原始總量（可得時）。二進制、已刪除、未追蹤、無 diff、Git 衝突及沒有 `HEAD` 都回答各自可辨狀態，不捏造空 diff。不得執行 `git add`、checkout、reset、clean 等寫操作。
- `desktop/review/file {path, maxBytes?}`：只讀預覽工作區內的文字文件；對 symlink／reparse point 在打開後再次核對最終路徑仍在 workspace，拒絕逃逸；預設上限 256 KiB、硬上限 1 MiB，並標註截斷。二進制不當文字渲染。

所有路徑以宿主 workspace 作根；拒絕絕對路徑、`..`、NUL、路徑分隔轉義和 race 後逃逸。讀取不授權外部目錄；Git 命令以參數陣列啟動、明確 cwd，不拼 shell 字串。大 diff 和文件內容在主進程與 renderer 兩層都有輸出界；重複請求可取消。首版不提供文件寫入、stage、commit 或 undo。

## 7. 宿主組裝與減少複製

新包只組裝現有公共 seam：SettingsStore／CredentialStore／ProviderRuntime、SessionCoordinator、`createSessionService`、`createSdkServer`、既有 RewindService（若掛得上）及本包互動／審查 adapter。`apps/cli/src/provider-runtime.ts` 的 `loadProviderRuntime` 和 `providerModelBindingFor` 是 CLI 私有 helper，本包不能 import CLI app 或複製 `runHeadless` 整條工具裝配。它可用現有 `createProviderRuntime` 等包級 API 寫必要的短 host adapter，並以 e2e 對照 CLI `sdk` 的 initialize/list/prompt/cancel／歷史語義；若重複裝配開始擴大，應停下來提案共用 host 模塊，而非悄悄在新包養第二套引擎。

本包復用 `@i-harness/sdk` 的 `createBoundedWriter`，按現有 CLI SDK 宿主的方式在 `onWrite` 與 stdout 之間設置輸出界，對新增通知和 reply 使用同一有界 writer。只在真有宿主 seam 時宣告原 SDK 的可選 create/fork/model/rewind capability；否則保留「不可用」而不編造。Gateway 的 `desktop/*` 擴充不得改原 `session/*` reply 或 `session/event` event 型別。

## 8. 測試與放行

1. **原 SDK 相容：**同一套 client 對既有 19 方法（實際掛上的子集）看到原版本和原回覆；初始化只多 capability；未知／未初始化／shutdown 的舊語義不變；每個 request 恰好一個 response frame。
2. **Sandbox 真執行：**設定 `read-only` 時工作區寫操作被拒、`workspace-write` 時工作區內可寫而外部寫拒、不可用 backend fail closed；Windows ACL 進程與 dispose 路徑驗證。另測恢復舊 `sandbox/mode` event 不能覆蓋新宿主當次模式。
3. **人機回合：**真 SessionService 觸發 approval/question；通知與 pending 順序；拒絕、批准、答案、重複回覆、跨 session 偽造、超時、斷線與 renderer 重載均有測試。
4. **審查只讀：**普通改動、無 Git、未追蹤、二進制、symlink 逃逸、路徑變動 race、超大輸出及工具不存在；確認沒有工作區內容被修改。
5. **生命週期：**客戶端 EOF、shutdown、服務錯誤與多會話併發後無 pending Promise、無殘留 lease、無重複 `session/event` 通知；`pnpm verify:all` 在新包加入後全過。

## 9. 不確定項與審核要求

- `createSdkServer` 目前只公開固定 switch；本包可在 `handleLine()` 前攔截 `desktop/*` 並用 `onWrite` 包裝成功 `initialize`。這是設計推論，須以契約測試證明沒有雙發 frame、沒有繞過 initialize gate、沒有修改 v3 既有 bytes。
- 對「工作區變更」的 Git 實作方式（直接只讀 Git CLI 還是復用既有 git probe）在實作計畫中釘定；任何方案都不得寫 Git 狀態。若要真正按任務歸因，另開產品決定，不偷偷以目前工作區 diff 代替。
- 此批准**只覆蓋一個新後端包**。若需要動 `packages/sdk`、`apps/cli`、`sandbox-*`、`session-executor` 或增加第二個後端包，先帶上具體變更和替代方案再次請用戶批准。
- 一切開發留在 `D:\frontend-test` 的本地分支；不推送 GitHub，也不修改 `D:\I-harness-main`。
