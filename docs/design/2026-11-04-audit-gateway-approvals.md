# 桌面對話閘道／審批／UI 協定子系統審計（2026-11-04）

範圍：`packages/desktop-gateway`、`packages/desktop`（main／renderer／shared，**不含** `app.tsx`、`Workbench.tsx` 的編輯中區域）、`packages/guard-approval`、`packages/hooks`、`packages/interaction`、`packages/sdk`（server／protocol）。

對照：`D:\ih_reference_project\codex-rust-v0.166.0\codex-rs`（`app-server`、`app-server-protocol`、`core/src/guardian`、`execpolicy`、`core/src/agent/control`）、`opencode-2.1.4\packages\core`。

方法：只讀產品碼，逐條對照參考專案的 typed protocol／approval 設計，找出設計偏離、不合理設計與潛在 bug。**未修改任何產品碼**。每一條都標注是否可由「單一測試檔」回歸。

嚴重度：**C** = 功能不可用或資料錯亂；**H** = 常見情境下不穩定或授權方向錯誤；**M** = 可維護性／可診斷性／邊界滲漏；**L** = 體驗或一致性。

與既有審計的關係：`docs/design/2026-11-04-design-deviation-audit.md` 的 D-04（owned/host 兩套審批語義）、D-05（identity 雜湊了活的工具表面）、D-06（RPC 錯誤無 machine code）、D-14（恢復入口不一致）已指出方向。本文**不重複**其論點，只補上更具體的失效路徑、互相矛盾的兩條分支，以及該子系統內尚未記錄的發現（NG-01…NG-12）。

---

## 總覽

| # | 嚴重度 | 主題 | 單檔回歸 |
|---|---|---|---|
| NG-01 | H | policy identity 不可用時，root 審批權威驗證反而回傳「仍有效」 | 可 |
| NG-02 | H | 「記住規則」可在沒有批准決策的情況下生成；之後拒絕也不撤銷 | 可 |
| NG-03 | H | 錯誤契約只有 message：恢復判定靠字串，且有一個永遠命不中的 needle | 可 |
| NG-04 | H | `session/prompt` 失敗時把整份 live event log 塞進錯誤 frame | 可 |
| NG-05 | M | 會話被 drain／自動 reload 後，待批卡片與候選證據不會退役 | 可 |
| NG-06 | M | 審批 ingress 沒有呼叫者身分，「trusted-human」只是一個方法名 | 可 |
| NG-07 | M | surface 訂閱帳本不清理失敗條目，重試永遠無法自癒 | 可 |
| NG-08 | M | `session/status` 有兩套狀態字彙，`idle` 無人處理 | 可 |
| NG-09 | M | 關閉流程沒有 ack：`shutdown` 以通知送出永遠不生效，2 秒後直接 SIGKILL | 可（部分） |
| NG-10 | M | owned 路徑的 child 授權只驗「工具物件相同」，與其自身註解矛盾 | 可 |
| NG-11 | M | hook 的 `permission: ask` 被硬轉成 deny，人類永遠看不到提示 | 可 |
| NG-12 | L | 核准規則頁是手動快照，列出已不可能命中的規則 | 可 |

---

## NG-01 policy identity 不可用時，root 審批權威驗證反而回傳「仍有效」（H）

**問題**：`approval/authority` 的 root 分支用 `undefined === undefined` 比對 policy identity，當權威來源不可用（撤銷／讀檔失敗／hook 權威缺失）時，validator 回傳 `true`（授權），而不是 fail-closed。

**證據**
- `packages/desktop-gateway/src/approval-rules.ts:33-56`：`authority` 在 dispatch 時捕獲 `policy = policyNow()`，回傳的 thunk 在驗證時重讀 `currentPolicy`，最後一行是 `currentPolicy?.workspaceId === workspaceId && currentPolicy?.revision === revision`（`:54`）。兩邊都 `undefined` 時結果為 `true`。
- 同一函式的 child 分支卻明確要求 `policy !== undefined && currentPolicy !== undefined`（`:52`）。**兩條分支對「未知權威」的判定相反**，root 分支的失敗方向是「授權」。
- `policyNow()` 會在這些情況回傳 `undefined`：`packages/desktop-gateway/src/approval-policy-identity.ts:37`（`executionAuthority` 為 `revoked`／`unavailable`）、`:34`（mounted Hook 權威取不到 → throw → 被 `:52` 的 `catch` 吞掉）、`:52`（任何例外，含 grant 檔不可讀、工具目錄序列化失敗）。
- 對照同一個物件上的「記住」路徑，方向是相反的 fail-closed：`approval-rules.ts:62`、`packages/guard-approval/src/active-rules.ts:118`（identity 為空 → `current policy identity is unavailable`，不可記住）。可見設計意圖是「不可用 ⇒ 不可用於授權」。
- 消費端：`packages/core-tools/src/registry/dispatch.ts:16` `if (prepared.authorityValidation?.() === false) throw new Error("prepared approval authority or policy changed before dispatch")`；`packages/core-tools/src/approval/identity.ts:13` 捕獲。

**參考做法**：Codex 的 guardian 在每次審查時重讀 live config 並強制 host 約束，取不到環境就直接報錯，而不是放行——`codex-rs/core/src/guardian/decision.rs:102-115`（`session.get_config()` / `requirements` / `has_full_access`）、`codex-rs/core/src/guardian/permissions.rs:31-42`（找不到 environment 就 `Err("approval environment {id} is unavailable")`）。也就是「權威未知」是一個明確的錯誤狀態，不是「未變更」。

**建議方向**：把 `authority` 契約改成三態（`valid` / `changed` / `unknown`），或最起碼在 root 分支補上與 child 分支相同的 `policy !== undefined && currentPolicy !== undefined` 前置條件；identity 無法建立時應回 `false`（deny，或「需重新審批」），並讓 `approvalPolicyIdentity` 回傳帶原因的結果而不是靜默 `undefined`。

**單檔測試**：可。`packages/desktop-gateway/test/approval-rules.test.ts` 已有 fixture，新增「`policyIdentity` 回傳 undefined → 授權 validator 必須為 false」即可鎖住。

---

## NG-02 「記住規則」可在沒有批准決策的情況下生成；之後拒絕也不撤銷（H）

**問題**：`rememberPending`（由 `desktop/approval-rules/add` 曝露）只要求「有一張活的待批卡片」，不要求任何 `approved: true`；而使用者之後拒絕那張卡片時，`finish()` 只清掉候選記憶體，**已持久化的 allow 規則仍然有效**，下一次同樣的操作會被靜默放行。

**證據**
- `packages/desktop-gateway/src/interaction.ts:311-317`：`rememberPending` → `options.approvalRules.grant(...)`，沒有任何批准條件；對照同一物件的 `replyTrustedHuman`：`:305` `if (input.decision.approved !== true) throw new Error("denied requests cannot create approval rules")`。**同一件事、兩條路徑、兩種授權要求**。
- `packages/desktop-gateway/src/interaction.ts:85-92`：`finish()` 在拒絕／取消／過期時只呼叫 `options.approvalRules?.forget(row.view.payload)`；`forget` 只從 `candidates` map 刪候選（`approval-rules.ts:31`），不動 `store`。
- `packages/desktop-gateway/src/approval-rules.ts:82-89`（`grant` 已寫入 store）、`packages/guard-approval/src/active-rules.ts:175-178`（`matches` 只看 evidence＋scope＋期限）。
- UI 路徑：`packages/desktop/src/renderer/settings/ApprovalRuleManager.tsx:59-69`，`:68` 明示「目前核准卡片仍須明確批准或拒絕」——但沒有說「拒絕之後規則還在」。
- 進入點：`packages/desktop-gateway/src/router.ts:253`；主行程側只有導覽狀態檢查（`packages/desktop/src/main/ipc.ts:211-214`）。

**參考做法**：Codex 的長效 allow 規則是「批准決策」的產物，且寫入受鎖保護的 append：`codex-rs/execpolicy/src/amend.rs:65-88`（`blocking_append_allow_prefix_rule`，只由核准流程呼叫）、`:147-190`（`append_locked_line` 取 `file.lock()` 後 append）；決策本身是三值 `Decision::{Allow, Prompt, Forbidden}`——`codex-rs/execpolicy/src/policy.rs:210-218`。

**建議方向**：規則生成必須綁定一個正向批准（或在卡片被拒／取消／過期時撤銷由該 `candidateId` 生成的規則 id）；`candidates` 應記錄「已生成規則」的關聯，讓 `finish()` 能回滾。若不希望耦合，至少要求 `desktop/approval-rules/add` 帶上「已批准」證據。

**單檔測試**：可。以 `createApprovalRulesAdapter` + `createInteractionBridge`：提出請求 → `rememberPending` → `reply(deny)` → 重新 prepare 同一呼叫，斷言 `remembered === false`。目前 `packages/desktop-gateway/test/approval-rules.test.ts` 只覆蓋批准路徑。

---

## NG-03 錯誤契約只有 message：恢復判定靠字串，且有一個永遠命不中的 needle（H）

**問題**：SDK 的失敗 frame 只帶人類訊息。desktop 因此以字串比對辨識「可恢復」錯誤，其中一條 needle 在 wire 上永遠不可能出現；同一種「session busy」在兩處還映射成不同 code。

**證據**
- 契約面：`packages/sdk/src/protocol.ts:42-47`（只有 `-327xx` 與 `-32000`；**沒有** `retryable`、沒有 typed `data.code`）、`:335-341`。
- 產生面：`packages/sdk/src/server.ts:1066-1069` 與全檔數十處 `makeFailure(..., error.message)`；`packages/desktop-gateway/src/router.ts:158`、`:258` 把任何內部失敗（store 讀寫、diagnostics、approval-rules）一律壓成 `INVALID_PARAMS` + 原始 message。
- 消費面（真正的外顯症狀）：`packages/desktop/src/main/session-recovery.ts:1-21` 檔頭自述「the SDK error frame carries no machine code, so the desktop recognises them by their stable sentences」，清單第 5 條是 `"FACT_RECOVERY_REQUIRED"`。但該字串只以 `error.code` 存在（`packages/desktop-gateway/src/owned-work-state.ts:15`：`Object.assign(new Error('Work-state metadata settlement requires recovery'), { code: 'FACT_RECOVERY_REQUIRED' })`），跨 RPC 只剩 `message`，**這條 needle 永遠不會命中**；`packages/desktop/test/session-recovery.test.ts:8` 之所以通過，是被第 4 條的 message 句命中，等於該分支沒有測試保護。
- 其他字串依賴：`packages/desktop/src/main/runtime-diagnostics.ts:219-230`（`/agent aborted/`、`/Model request timed out waiting for/`）、`packages/desktop/src/renderer/design/error-message.ts:7`、`packages/desktop/src/renderer/session/management-error.ts:19`（`RpcError:` 前綴剝除＋訊息查表）、`router.ts:511`（`error.message === "session is busy"`）。
- 同一語義兩種 code：`router.ts:178` 的 session busy 是 `INVALID_REQUEST`（`-32600`，`data.reason: "session_busy"`），`packages/sdk/src/server.ts:557` 的 session busy 是 `INTERNAL_ERROR`（`-32603`）。客戶端無法用 code 決定是否重試。
- 反面例子（證明格式可行）：`router.ts:580` 唯一帶 machine code 的地方 `{ code: 'USAGE_UPGRADE_REQUIRED' }`；`packages/desktop-gateway/src/host.ts:399` 的 `session/status` 通知帶 `code: 'TEAM_RECOVERY_REQUIRED'`（通知有 code、錯誤 frame 沒有）。

**參考做法**：Codex 把 code 集中並統一附帶 `data`：`codex-rs/app-server/src/error_code.rs:1-38`（單一 `error()` 工廠、`server_draining_error()` 帶 `data: {"reason":"serverShuttingDown"}`、`OVERLOADED_ERROR_CODE=-32001` 與 internal 分開）；`codex-rs/app-server-protocol/src/protocol/v2/shared.rs:69-131` 是 wire 上的 typed `CodexErrorInfo`（`ServerOverloaded`／`RateLimitExceeded`／`HttpConnectionFailed{httpStatusCode}`…）；`app-server/src/request_processors/config_processor.rs:913-923` 在錯誤 `data` 附 `config_write_error_code`。

**建議方向**：所有失敗 frame 一律帶 `data: { code, retryable, details? }`（`code` 用封閉列舉，`message` 只給人看），在 gateway／sdk 邊界集中一個 `toRpcError(unknown)`；desktop 全面改讀 `code`，刪掉 `session-recovery.ts`／`runtime-diagnostics.ts` 的正則表；同一語義只准一個 code。

**單檔測試**：可。`packages/desktop-gateway/test/router.test.ts` 斷言某內部失敗 frame 帶 `data.code`；`packages/desktop/test/session-recovery.test.ts` 改成餵 `RpcError{code}` 而非字串。

---

## NG-04 `session/prompt` 失敗時把整份 live event log 塞進錯誤 frame（H）

**問題**：回合失敗的回應把該會話「目前所有事件」整包放進 `data.events`，大小隨對話歷史線性成長、且與 append-only 的 `session/event` 串流重複；一個大歷史會話的單次失敗就可能撞上輸出上限並切斷連線。

**證據**
- `packages/sdk/src/server.ts:904-912`：失敗回 `makeFailure(id, INTERNAL_ERROR, message, { sessionId, events: liveEventsFor(service, sessionId), modelFailure? })`。
- `packages/sdk/src/server.ts:1076-1081`：`liveEventsFor` 直接回 `live?.events ?? []`——**沒有上限、沒有切片**。
- 上限機制：`packages/sdk/src/bounded-writer.ts:54`（預設 bound ≈ 1.9 MB）、`:146-159`（超限就丟棄佇列、送一個 `id:null` 的 `SERVER_OVERLOAD` 並關閉串流）。`packages/sdk/src/protocol.ts:228-248` 說明該 frame 是終止性的。
- 契約不一致：`packages/sdk/src/protocol.ts:34-35` 文件寫 `data.event`（單數），實作是 `data.events`。

**參考做法**：Codex 的錯誤只帶 typed 錯誤資訊，事件／歷史要靠明確的 pull 介面（`app-server-protocol/src/protocol/thread_history.rs:1387-1403` 只投影 `codex_error_info`；事件流本身不進錯誤 payload）。IH 自己也有現成的 pull 面：`session/history`（`protocol.ts:69-75`）。

**建議方向**：錯誤 frame 不要帶事件陣列；若為了 UI 立即顯示需要，限定「最後 N 筆／≤ 32 KiB」並附 `truncated`＋`nextSeq`，其餘讓客戶端用 `session/history` 補。順手修正文件欄位名。

**單檔測試**：可。`packages/sdk/test/server.test.ts` 造一個 5000 事件的會話讓 submit 失敗，斷言 frame 位元組有上限且 `data.events` 長度受限。

---

## NG-05 會話被 drain／自動 reload 後，待批卡片與候選證據不會退役（M）

**問題**：`drainSession` 只關閉 session 與 flush 審批歷史，**沒有**取消該會話的待批互動；卡片與「可記憶候選」會留在 bridge 與 persistence 裡，之後仍可被批准／記住，但底層工具呼叫早已不存在。desktop 在 recovery 錯誤時會自動 reload，使這條路徑變成常態。

**證據**
- `packages/desktop-gateway/src/host.ts:167`：`const drainSession = async (id) => { await service.closeSession(id); await approvals.flush() }`；`:500` `sessionReload: sessionId => drainSession(sessionId)`；路由入口 `router.ts:255`。
- 自動觸發：`packages/desktop/src/main/ipc.ts:752-759`（任何 recovery-gated 失敗 → `desktop/session/reload` → 回「會話狀態已重新載入，請重試」）。
- bridge 只在 `session/cancel` 時清理：`router.ts:204` 是 `interaction.cancelSession` 的唯一呼叫點（`host.ts`/`drainSession` 都沒有）。
- 候選不會過期得很早：`interaction.ts:71`（`expiresAt = now + 24h`）；`approval-rules.ts:104-107` 的 `removeSession` 只在「刪除會話」時被呼叫（`host.ts:516-517`）。

**參考做法**：Codex 的審批生命週期綁在 turn／submission 上，turn 被中斷就一起 Abort：`codex-rs/core/src/guardian/decision.rs:96-100`（`external_cancel` 與 `history_reset` 併用）、`:155-160`（即使 extension 回傳了決策，取消後仍強制 `ReviewDecision::Abort`）。

**建議方向**：`drainSession`／assembly dispose 時呼叫 `interaction.cancelSession(id)` 並清掉該 assembly 的 candidates；`rememberPending` 與 `recover` 應拒絕「其 assembly 已退役」的卡片。

**單檔測試**：可。`packages/desktop-gateway/test/interaction-recovery.test.ts` 風格：開請求 → `drainSession` → 斷言 `pending()` 為空、且以舊 requestId 呼叫 `rememberPending` 失敗。

---

## NG-06 審批 ingress 沒有呼叫者身分，「trusted-human」只是一個方法名（M）

**問題**：gateway 對同一條連線同時接受 `desktop/interaction/reply` 與 `desktop/interaction/reply/trusted-human`，兩者的差別只有方法字串；「只有可信的人類 UI 可以建立規則」這個不變式完全靠 desktop 主行程的一個分支維持，gateway 端沒有任何呼叫者／擁有者概念。

**證據**
- `packages/desktop-gateway/src/router.ts:671-695`：`const trusted = message.method.endsWith("/trusted-human")`，其餘驗證完全相同。
- `packages/desktop-gateway/src/interaction.ts:60-63`：註解要求「Call exclusively from authenticated Desktop human UI ingress」，但型別上無法約束。
- `packages/desktop/src/main/ipc.ts:689`：主行程把所有 renderer 回覆一律升級成 `.../trusted-human`——真實閘門只有「sender 是已知 BrowserWindow」（`ipc.ts:750`）這一個 process 內檢查。
- `packages/sdk/src/server.ts:193-200`、`:941-945`：`initialize` 捕獲的 `clientInfo()` 已經存在，但 gateway 沒有任何 handler 讀它。
- 同一類不一致：`router.ts:661-668` 的 `desktop/interaction/pending` 沒有 `assertSession`（`reply` 在 `:683` 有）。

**參考做法**：Codex app-server 把操作綁到 ConnectionId 並拒絕非擁有者（`codex-rs/app-server/src/user_verification_ownership_tests.rs:57`：`notify_client_error(ConnectionId(2), id, internal_error("not the owner"))`），審批決策也帶擁有者／turn 身分，而不是靠方法名約定。

**建議方向**：在 `initialize` 捕獲的連線身分上加一個「人類 ingress」旗標（或於請求時頒發一次性 nonce 給真正的卡片），`trusted-human` 只接受通過該身分的連線；`pending` 補上 `assertSession`。

**單檔測試**：可。`packages/desktop-gateway/test/router.test.ts`：以不同 `clientInfo`／連線建立兩個 router，非人類身分的 trusted reply 必須被拒。

---

## NG-07 surface 訂閱帳本不清理失敗條目，重試永遠無法自癒（M）

**問題**：`subscribe` 失敗時把「已 reject 的 flight」留在 `entries` 與 `keys`；同一個 `requestKey` 的重試只會拿到同一個失敗 promise，容量（32）也不會回收。desktop 的重試策略正是「逾時後用同一個 key 重送」，因此一次失敗會讓該 key 永久中毒。

**證據**
- `packages/desktop-gateway/src/observation/subscriptions.ts:79-93`：先 `entries.set(entry.id, entry)`、`keys.set(key, entry)`，`source.subscribe` 失敗時只 `entry.active = false; ready.reject(error)`，**不刪除**。
- `:64-68`：同 key 重試直接 `return prior.flight`（已 reject）。
- `:70`：`entries.size >= 32` 就拒絕新訂閱 → 失敗條目會逐步吃掉額度。
- `:42-51`：`release()` 對「尚未取得 lease」的條目會**再訂閱一次**（同 key），失敗就 throw，`entries.delete(entry.id)` 永遠不執行；之後 `close()` 會把所有這些條目再跑一次並累積 `AggregateError`。
- desktop 側：`packages/desktop/src/main/surface-observation.ts:85-87`、`:113`（只在錯誤訊息含 `timed out` 時用同 key 重試）。

**參考做法**：Codex 的 file-watch／訂閱以 lease id 為鍵，取得失敗就丟棄該 id（`codex-rs/app-server/src/fs_watch.rs:97` 失敗即 `Err(invalid_request(...))`，不留半成品）；idempotency 鍵必須指向「活的」lease，否則應被回收。

**建議方向**：取得失敗時刪除 entry＋key（或標記 terminal 並在下次同 key 時建立新 flight）；`release` 對無 lease 條目直接刪除而不是重訂閱。

**單檔測試**：可。`packages/desktop-gateway/test/surface-subscriptions-connected.test.ts` 風格：讓 `source.subscribe` 一次 reject，斷言重試會重新嘗試且帳本歸零。

---

## NG-08 `session/status` 有兩套狀態字彙，`idle` 無人處理（M）

**問題**：同一個通知方法由兩個生產者餵入不同字彙（SDK server：`queued`/`idle`/`error`；gateway host：`queued`/`completed`/`failed`）。協定檔沒有列舉，客戶端只能「兩種都認」，而 `idle` 目前誰都不認。

**證據**
- `packages/sdk/src/server.ts:894`（`queued`）、`:902`（`idle`）、`:907`（`error`）、`:311`（`failed`）。
- `packages/desktop-gateway/src/host.ts:426`、`:476`（`queued`/`completed`/`failed`）、`:399`（`failed` + `code`）。
- 協定面沒有字彙定義：`packages/sdk/src/protocol.ts:39-40`（只說 `{ sessionId, status, error? }`）。
- 消費面：`packages/desktop/src/main/runtime-diagnostics.ts:306-315` 同時接受 `failed` 與 `error`、`cancelled` 與 `canceled`（本身就是字彙漂移的證據），**沒有 `idle` 分支**；`packages/desktop/src/renderer/session/RuntimeFeedback.tsx:102` 只把 `completed`/`cancelled` 當結束。

**參考做法**：Codex 的 turn/thread 狀態是 wire 上的封閉 enum（`app-server-protocol/src/protocol/v2/turn.rs` 的 status 型別），序列化失敗即被 schema 擋下，不存在兩個生產者各自造句。

**建議方向**：在 `protocol.ts` 定義 `SessionStatus` 封閉列舉（含 `idle` 的語義，或直接把 server 的 `idle` 改成 `completed`），desktop 邊界做 runtime 驗證，未知值丟棄並記一筆診斷。

**單檔測試**：可。`packages/desktop/test/runtime-diagnostics.test.ts` 對每個字彙值各餵一次，斷言投影一致；protocol 端加一個 schema 鎖。

---

## NG-09 關閉流程沒有 ack：`shutdown` 以通知送出永遠不生效，2 秒後直接 SIGKILL（M）

**問題**：客戶端把 `shutdown` 當**通知**送出，立刻關閉 stdin，2 秒後強制 kill；而 gateway 端只認 **request** 形式的 `shutdown`（`isRpcRequest` 需要 id），因此文件承諾的 `{ok:true}` 與 `onShutdown` 在桌面路徑永遠不會發生。同時 gateway 的 `close()` 是一串可長達數秒的持久化清理，2 秒上限會把它換成 SIGKILL，且不留任何診斷。

**證據**
- `packages/sdk/src/client.ts:433-453`：`this.notify("shutdown")` → `transport.endWrite()` → `Promise.race([exit, 2s])` → `child.kill()`。
- `packages/desktop-gateway/src/cli.ts:63-75`：`const method = isRpcRequest(frame) ? frame.method : undefined`；通知 frame 沒有 id → `method === undefined` → `:73` 的 `if (method === "shutdown")` 與 `router.ts:161` 的 compaction abort 都不會執行。`packages/sdk/src/server.ts:935` 也明確忽略 client→server 通知，`:918-924` 的 `case "shutdown"` 因此不可達。
- 清理成本：`packages/desktop-gateway/src/router.ts:752-777`（surfaces、content-search、probes、model switches、逐會話 `session/cancel`、compaction jobs、SDK close）；`cli.ts:43-53`（`host.close()` → `closeSystemFetch()` → 等所有 active work → `output.finish()`）。
- `packages/desktop-gateway/src/output.ts:26-36`：`finish()` 會等到 `pendingBytes() === 0` 或 drain，**沒有逾時**；若客戶端停止讀取而尚未觸發 `SERVER_OVERLOAD`，這裡可以永遠不返回，正好被上面的 2 秒 kill 掩蓋。

**參考做法**：Codex 有明確的 drain 狀態與可重試錯誤（`app-server/src/error_code.rs:10-14`：`server_draining_error()` → `data.reason = "serverShuttingDown"`，期間拒絕新工作），transport 等待進程自行結束，沒有固定 2 秒硬殺。

**建議方向**：把 `shutdown` 改成 request 並等待 ack（或在 `SERVER_OVERLOAD` 之外再加一個 `server/draining` 通知）；kill 上限改成可設定且明顯大於觀測到的關閉成本；`finish()` 加逾時並回報「未 drain 完」的診斷；gateway 側在被迫中止時記一筆 `close/truncated` 診斷。

**單檔測試**：可（部分）。`packages/sdk/test/bounded-writer.test.ts` 風格對 `output.finish()` 加「sink 永不出 drain → 必須在逾時後回報」；`packages/sdk/test/client.test.ts` 斷言 `shutdown` 以 request 形式送出。

---

## NG-10 owned 路徑的 child 授權只驗「工具物件相同」，與其自身註解矛盾（M）

**問題**：owned host 沒有 child-caller 表，fallback 改成「registry 依名稱解析到的 tool 物件等於被呼叫的 tool 就當作合法 child」。這只證明工具物件，不證明呼叫者屬於這個 owner；同一函式的 root 分支卻要求 `input.registry === assembly.tools`（嚴格身分）。註解仍宣稱「forged sessionId cannot pass the registry identity check」。

**證據**
- `packages/desktop-gateway/src/approval-rules.ts:41-44`（註解）、`:45-49`（`childCallerFor === undefined` 時的 fallback）、`:50-52`（root 分支要求 `input.registry === assembly.tools`）。
- `packages/desktop-gateway/src/owned-host-extensions.ts:38`：`options.interaction.attachOwned(owner)`，owner 只有 `{ctx, sessionId, tools}`，沒有 child 身分表。

**參考做法**：Codex 用 agent path／thread id＋版本來驗證 worker 身分，而不是「工具物件相同」：`codex-rs/core/src/agent/control/user_authorization.rs:254-314`（以 root thread id 與 `MultiAgentVersion::V2` 判定，並產出有界的 root 授權快照）；spawn 端另有 `agent/control/spawn_guard.rs`。

**建議方向**：把 child-caller 表帶進 owned owner（child sessionId → registry → snapshot，attach 時綁定），或 owned root 一律要求 `registry === assembly.tools`、未登記 child registry 時拒絕。這條與 D-04 同源，但本文的證據是「fallback 本身不足以支撐其宣稱的不變式」。

**單檔測試**：可。`packages/desktop-gateway/test/approval-rules-child.test.ts`：偽造第三個 registry 但放入同一個 Tool 物件，斷言授權被拒。

---

## NG-11 hook 的 `permission: ask` 被硬轉成 deny，人類永遠看不到提示（M）

**問題**：hook 在 `permission` 事件回 `ask` 時，IH 直接變成 `{kind:"deny"}`，使用者看到的是「政策拒絕」而不是批准卡片；Claude／Codex 的語義是升級給人決定。

**證據**
- `packages/hooks/src/execution/permissions.ts:35-44`：`if (output.decision === "allow") continue`（`:42`，刻意讓 allow 不生效）、`:43-44` 的註解「ask is not wired to a question seam on main yet — fail closed as deny」＋ `return { kind: "deny", ... }`。
- 契約文件自己承認：`packages/hooks/src/types.ts:35-36`（「decision allow|deny|ask（ask = fail-closed deny in v1）」）。
- 對照同一個 seam 的另一半：`packages/desktop-gateway/src/interaction.ts:222`／`packages/interaction/src/index.ts:30-32` 已經有現成的 approval answerer。

**參考做法**：Claude Code 的 `PermissionRequest` 之 `ask` 會顯示提示；Codex execpolicy 的 `Decision::Prompt` 是「落到審批流程」而不是拒絕（`codex-rs/execpolicy/src/policy.rs:218` `Decision::Prompt => {}`，交由 approval flow 決定）。

**建議方向**：把 hook 的 `ask` 接到 `tools/pre-execute` 的 `{kind:"ask"}`（由 guard-approval 的 answerer 詢問人類），或至少在 UI 上標明「外掛要求人工確認（目前一律拒絕）」，不要讓它與真的 deny 混在一起。

**單檔測試**：可。`packages/hooks/test/hooks.test.ts`：permission handler 回 `ask`，註冊 answerer 後斷言有被詢問一次。

---

## NG-12 核准規則頁是手動快照，列出已不可能命中的規則（L）

**問題**：核准規則頁的資料是「按需拉取」的快照，而且規則只用 workspace 過濾、沒有標示 policy revision 是否已改變；新的待核操作會以通知抵達 UI，但這個頁面不訂閱通知，所以使用者盯著它新增規則時看不到候選出現。變更沙箱／Plan／hooks 之後，列表仍顯示一堆永遠不會命中的規則。

**證據**
- `packages/desktop-gateway/src/router.ts:251`：`state(handlers.workspace, handlers.interaction?.pending() ?? [])`——workspace 是 gateway 全域字串，`pending()` 未帶 session 過濾。
- `packages/desktop-gateway/src/approval-rules.ts:92-99`：`rules` 僅以 `evidence.workspaceId` 過濾；`candidates` 來自所有 session。
- 但命中時要求完整 evidence（含 `policyRevision`）相等：`packages/guard-approval/src/active-rules.ts:175-178`。
- UI 端只有手動重讀：`packages/desktop/src/renderer/settings/ApprovalRuleManager.tsx:25`（載入一次）、`:50`（重新讀取按鈕）；`packages/desktop/src/shared/bridge.ts:167-182` 已轉發 `desktop/interaction/request|closed`，此面板未使用。

**參考做法**：Codex 的規則列表與核准動作讀同一份 live policy（`execpolicy/src/policy.rs:109-128` 由 policy 物件提供規則），清單本身就是可判定狀態，不存在「列出但不可能命中」的分裂。

**建議方向**：投影時帶上每條規則的 `stale`（比較目前 revision）與 candidate 的 session 範圍；面板訂閱互動通知即時更新。

**單檔測試**：可。`packages/desktop-gateway/test/approval-rules.test.ts`：在 revision A 建立規則，改 sandbox 後 `state()` 必須標示 stale／不出現在可命中清單。

---

## 建議修復順序

1. **NG-01**（授權方向錯誤，一行前置條件即可修）→ **NG-02**（規則生成語義）→ **NG-10**（owned child 身分）。這三條都在同一組檔案，應一起設計「identity 三態 + 規則生命週期」。
2. **NG-03**（錯誤契約）是其他多條的地基：加上 `data.code` 後，**NG-05** 的退役判定與 **NG-08** 的狀態投影才有可靠的判別依據；也順帶解掉 D-14。
3. **NG-04**（錯誤 frame 大小）與 **NG-09**（關閉 ack／逾時）屬協定與生命週期，改動面小、回歸測試可單檔完成。
4. **NG-07**、**NG-12** 是最後一批（UI／訂閱投影），可在前三批落地後一併處理。
5. **NG-06**、**NG-11** 需要產品決策（是否引入連線身分、hook ask 是否升級給人），先記錄再排。

## 對照來源（參考實作）

- `codex-rs/app-server/src/error_code.rs`、`request_processors/config_processor.rs`（錯誤碼集中與 `data` 附加）
- `codex-rs/app-server-protocol/src/protocol/v2/shared.rs`、`protocol/thread_history.rs`（typed `CodexErrorInfo`；事件與錯誤分離）
- `codex-rs/core/src/guardian/decision.rs`、`permissions.rs`（審批生命週期、環境不可用即錯誤、取消強制 Abort）
- `codex-rs/core/src/agent/control/user_authorization.rs`（worker 身分驗證）
- `codex-rs/execpolicy/src/amend.rs`、`policy.rs`（allow 規則只由批准決策產生；三值決策）
- `codex-rs/app-server/src/user_verification_ownership_tests.rs`（連線擁有者）

## 讀過的 IH 關鍵檔案

`packages/sdk/src/protocol.ts`、`server.ts`、`client.ts`、`bounded-writer.ts`；`packages/desktop-gateway/src/router.ts`、`host.ts`、`interaction.ts`、`interaction-persistence.ts`、`approval-rules.ts`、`approval-policy-identity.ts`、`owned-approval-bindings.ts`、`owned-host-extensions.ts`、`owned-gateway-default.ts`、`approval-history.ts`、`hook-settings.ts`、`hook-authoring.ts`、`plugin-mount.ts`、`output.ts`、`cli.ts`、`session-management-fence.ts`、`observation/subscriptions.ts`；`packages/guard-approval/src/index.ts`、`active-rules.ts`、`danger-class.ts`、`guardian/index.ts`、`guardian/review-record.ts`；`packages/hooks/src/trust.ts`、`types.ts`、`execution/permissions.ts`；`packages/interaction/src/index.ts`；`packages/core-tools/src/approval/identity.ts`、`registry/dispatch.ts`；`packages/desktop/src/main/ipc.ts`、`sdk-runtime.ts`、`runtime-diagnostics.ts`、`session-recovery.ts`、`surface-observation.ts`；`packages/desktop/src/shared/bridge.ts`；`packages/desktop/src/renderer/interaction/*`、`renderer/settings/ApprovalRuleManager.tsx`、`renderer/session/notifications.ts`。
