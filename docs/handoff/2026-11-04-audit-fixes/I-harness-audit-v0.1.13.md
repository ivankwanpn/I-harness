# I-harness v0.1.13 全面審查報告

> 審查對象：`<repo>\I-harness` @ tag `v0.1.13`（commit `46a6311`，2026-11-03）
> 方法：全庫量化掃描 + 8 個子系統深讀 + 逐條回讀原文核實。標記 **✔** = 我親自讀過該段原始碼／跑過該指令；**○** = 子系統深讀提出、抽樣核對相符。
> 規模：82 個 workspace 套件、407 條內部依賴、3 組循環依賴（僅由 devDependency 回邊構成，runtime graph 無環）、**406,835 行 TS（其中 231k 行是測試）**、1,800 個測試檔、1,010 份 Markdown（~129k 行、16.8 MB；`docs/` 共 1,421 檔 / 45.8 MB）、11 週內 3,207 個 commit。

---

## 0. 總體判斷

這不是一個「隨便寫的」專案：局部工程紀律相當高——sandbox fail-closed、`O_NOFOLLOW` 讀檔、edit/patch 走 atomic write、hook 內容雜湊授權、approval evidence 以 canonical 參數定鍵、1,800 個測試檔。真正的問題全部在**全局**：

1. **邊界是假的**：82 個套件之間有 117 處 `../../../<pkg>/src/...` 直接穿透，`core-agent` 反向 import `session-executor` 卻沒有宣告依賴 → 宣告依賴圖與真實依賴圖不一致，套件無法獨立建置／測試。
2. **契約是重複的**：SSE 解析器 4 份、桌面通知白名單 2 份、fork 契約 v1/v2 兩套、refusal 字面量每個檔寫 3 次、koffi Win32 繫結 3 份、retained-result 磁碟格式 4 種、手寫 `readX()` schema 驗證器 73 個。
3. **品質閘門是手動的**：**沒有 CI、沒有 linter**，而 release tag 上 `pnpm typecheck` **直接失敗**。`verify-all.mjs` 寫得很好，但沒有任何東西會跑它。
4. **同一功能有兩套實作**（legacy assembly vs managed/owned），行為不同：schedule 在非 managed session 不會 arm timer，reminder 只在下一次使用者發話時才檢查。
5. **安全性靠「分類字串」而非「效果」**：shell 審批是 basename 黑名單（`./x.sh` 直接放行）、sandbox 故障判定來自子程序自己的 stderr、plugin hook 的 `allow` 可以蓋掉 host 的 `ask`。

以下按嚴重度列出。

---

## 0.5 修復狀態（分支 `experiment/audit-fixes-v0.1.13`）

| 狀態 | 項目 |
|---|---|
| ✅ 已修 | F1、F2、F3、F4、F5（腳本／任務執行器改判 dangerous）、F7、F9、F10（fsync）、F14 逐 byte 視窗（改 8KiB 分塊解碼）、F15、F17、F18、F19 subagent durable snapshot 上限、F21、F22、F23、F24（移除偽造 sandbox 故障可換取 full-access 的升級建議；分類本身仍依子程序輸出）、F26 advisory sandboxDenial、F27、F28、F30 token 估算 CJK 低估、F31、F32、F33 Windows DACL、F35、F37、F39 |
| ⚠️ 部分 | F10（open() 單一壞檔隔離未做）、F24（未改為 runner 私有通道回報） |
| ❌ 已推翻 | F29、F36、F6、F11、F38（compaction 共用重試預算是測試編碼的契約，已 revert） |
| ⏳ 未修（需產品決策／架構重構） | F8 append O(n²)、F12 雙寫入協定、F13 四種磁碟格式、F16 decision slot 併發（已嘗試 ALS 隔離，失敗回退；需把 decision 當回傳值串進 dispatch）、F20 ACL temp 生命週期、F25 env 過濾、F30 token 雙啟發式、F33 API key 保護、F40 hook 沙箱外、F41 MCP 無授權；D1–D6、O1–O8 |

已驗證：`pnpm -r --no-bail typecheck` 全綠（82 packages）；`core-plugin` 58/58、`hooks` 聚焦 36/36、`fs` 110/110、`media` 15/15。其餘套件在本機仍紅（大量測試需 `IH_*` 證據環境），已用 baseline 對照確認與本次修改無關。

---

## 1. P0 — 阻斷級（交付／安全／資料損失）

### F1. release tag 上 typecheck 就是紅的 ✔
`pnpm -r typecheck` → **exit 1**：

```
packages/sandbox-local typecheck: test/legacy-outer-windows.test.ts(20,3): error TS18047: 'child.stdout' is possibly 'null'.
packages/sandbox-local typecheck: test/legacy-outer-windows.test.ts(21,3): error TS18047: 'child.stderr' is possibly 'null'.
```

`spawn(..., { stdio: ['ignore','pipe','pipe','ipc'] })` 的靜態型別是 `ChildProcess`（stdout 可為 null），程式直接 `.on()`。更糟的是 pnpm recursive **fail-fast**：第一個套件失敗後，其餘約 40 個套件根本沒被檢查。

我另外跑了 `pnpm -r --no-bail typecheck` 把 82 個套件全部驗完，結果 **4 個套件是紅的**：

```
sandbox-local      test/legacy-outer-windows.test.ts(20,3)(21,3)      TS18047 stdout/stderr possibly null
agent-team         test/managed-team-delivery-evidence.test.ts(22,99) TS2322 ParentInputAdmission 不相容
desktop-gateway    test/helpers/fork-fixture.ts(35,82)(36,71) ...      TS2339/TS7006，共 10 處
desktop            src/renderer/session/RecordedResultPage.tsx(29,11)(50,*)    TS2322/TS2339
                   src/renderer/session/result-page-view.ts(32,35)   TS2345
```

注意最後一個：**desktop 的 production renderer 程式碼本身型別就不過**（不只是測試檔），而且 `desktop` 的 typecheck 會連帶把 `desktop-gateway/test/helpers` 的錯一起報出來。這代表 v0.1.13 是一個「自家型別檢查都不綠」的 release。

### F1b. `verify:all` 的第 5 步（reachability gate）也是紅的 ✔
`node scripts/audit/check-reachability.mjs --gate` 的輸出（審查代理實跑）：

```
reachability: 422 row(s) now; baseline seeded 2026-09-24 with 456
reachability: 59 NEW row(s) -- the gate fails
```

也就是說 `verify:all` 的 5 步中有 **2 步當場失敗**（typecheck、reachability），而沒有任何機制會發現——見 F2。

### F2. 完全沒有 CI、沒有 lint ✔
- `.github/` 不存在；沒有任何 workflow。
- 全庫找不到 eslint / biome / prettier 設定（`eslint-disable` 在原始碼只出現 1 次，因為根本沒裝）。
- 對照：519 個 `as any`、775 個 `: any`、5,246 個 non-null `!`。
- `scripts/verify-all.mjs` 設計得不錯（會核對「82 個專案是否都回報」），但只有人手動跑，而它的第 3 步 typecheck 現在必定失敗。

### F3. 主視窗沒有 `will-navigate` 防護，特權橋接綁在 webContents 而非 origin ✔
`packages/desktop/src/main/window.ts:21` 只設了 `setWindowOpenHandler`（管新視窗），沒有 `will-navigate` / `will-redirect`：

```ts
window.webContents.setWindowOpenHandler(({ url }) => { ... return { action: "deny" } })
```

而 `preload/index.ts` 把 `window.ihDesktop.request` 暴露給**該 webContents 載入的任何文件**，IPC 端只憑 webContents 身分授權（`ipc.ts:743` `if(!owned) throw Error('untrusted IPC sender')`）。使用者把一個 `.html` 拖進視窗（renderer 沒有任何 dragover/drop 攔截），Chromium 會導航到 `file:///...`，該頁面立刻取得 workspace 開檔／寫檔／開終端／git commit 的完整通道。這是整份報告中唯一「一步社交工程就拿到 RCE」的路徑。

**修法**：主視窗加 `will-navigate` 白名單（只允許自己的 entry URL）與 `will-redirect`；IPC 授權改用 sender origin + webContents 雙重比對。

### F4. plugin hook 的 `allow` 可以覆蓋 host 的 `ask`（程式碼自己的保證被違反） ✔
`hooks/src/execution/permissions.ts:36-37`：

```ts
// A plugin's allow can never grant more than IH's host permission policy.
if (output.decision === "allow") { if (handler.spec.claude !== undefined) continue; return { kind: "allow" } }
```

註解說「plugin 的 allow 永遠不能大於 host 政策」，但同一行對 **IH 原生 plugin**（非 Claude 格式）直接回傳 `{kind:'allow'}`。而 `core-plugin` 的 `emitFn` 把「最後一個 listener 的非 undefined 回傳值」當成後續 waterfall 的 payload（`listeners.ts:92-95`），`guard-approval` 看到 payload 已是 decision 形狀就**跳過分類**（`guard-approval/src/index.ts:143-144`）：

```ts
const asDecision = payload as { kind?: unknown }
if (asDecision && typeof asDecision.kind === "string") return undefined
```

hook 是**普通 listener**（`hooks/src/lifecycle/mount.ts:81` `on("tools/pre-execute", ...)`），guard-approval 是 **waterfall**（`guard-approval/src/index.ts:229`）。`emitFn` 先跑普通 listener、再跑 waterfall，所以 hook 回傳的 allow 一定會先被當成 chain payload，waterfall 再看到「已是 decision」就跳過。**不需要任何掛載順序巧合**：任何原生 plugin 的 permission hook 只要 `decision: allow`，就能跳過該次工具審批。這不是「plugin 權限過大」，而是**審批語義被事件總線的 payload 重用機制吃掉**。

**修法**：把 decision 改成明確的 strictness merge（deny > ask > allow），不要用「listener 回傳值」當政策載體。

### F5. shell 審批只是一個粗略的「metachar + basename」模型，不看腳本內容；預設模式是 `dangerous` ✔
`guard-approval/src/index.ts:169-184` + `danger-class.ts:295`：

```ts
// A command classified "none" falls through to `return undefined` (ALLOW)
const danger = classifyDanger(argv, workspace, dangerousCommands, dangerousFlags)
if (danger !== "none") { ... return { kind: "ask", reason } }
...
const METACHAR = [";", "&&", "|", "$(", "`", ">", "<"]
if (argv.some((t) => METACHAR.some((m) => t.includes(m)))) return "dangerous"
if (argv.some((a) => cmdSet.has(basenamePath(a)))) return "dangerous"
```

它會深掃 `bash -c`/`cmd /c`/`sudo` 等 wrapper，也會攔 metachar 與可設定的危險 basename——比單純黑名單好。但**它不讀腳本內容**：`./build.sh`、`npm run x`、`make` 的 basename 不在清單、argv 沒有 metachar，因此分類為 `none` → 放行。`settings/src/schema/defaults.ts:24` → `approvalMode: "dangerous"`，所以這是預設行為。配合 workspace-write sandbox（Windows ACL 後端不限制讀取與網路），「下載一個 repo → 執行它」可以在零審批下讀走 `~/.ssh` 與雲端憑證。程式碼註解本身也承認「the shell tools carry no workspace boundary of their own」。

**修法**：非唯讀 shell 一律 ask（或至少把「執行 repo 內腳本／套件管理器」視為 dangerous），預設改 `ask-all`；長期再做以效果為基礎的分類。

### F6. rewind 明知檔案已被改過，仍然覆寫（且沒有備份） ✔
`rewind/src/service.ts:143-150` 的 doc comment 自己寫明：

```
* `conflicts` = externally diverged (still listed in `ops` — a rewind executes conflicts anyway);
```

`plan()` 把衝突檔照樣放進 `ops`（`if (op !== null) ops.push(op)`），`execute()` 无条件寫回 pre-image／`unlink()`。使用者回合結束後手改的內容，會被 rewind 直接蓋掉，而被蓋掉的位元組沒有任何副本。這是**已文檔化的危險設計**，不是漏寫的 bug——但對「rewind 是安全網」的產品敘事是致命的。

**修法**：有 conflict 的 op 必須要求 `force` 或第二次明確確認，且覆寫前先寫入 rewind store 為新 pre-image。

---

## 2. P1 — 高（真實 bug／資料完整性／安全性）

### 持久化與檢索

| # | 問題 | 位置 | 影響 |
|---|---|---|---|
| F7 ✔ | 舊格式 JSONL 讀到第一個壞行就 `break`，把前綴當成全部歷史；`hasTornTail()` 只看最後一行，所以「中間壞、尾巴好」被判定為沒壞，`repair()` 會把截斷結果**寫回磁碟** | `session-persistence-jsonl/src/format.ts:75-91` | 舊 session 靜默少掉一半對話，且不可逆 |
| F8 ○ | 每次一般 append 都 `readFile` 整個 journal + 全歷史驗證；`load()` 每次開啟還先 `repair()` | `backend-factory.ts:258`、`load.ts:114` | 每次寫入 O(n)、整個 session O(n²)；50k 事件後長會話卡死／OOM |
| F9 ✔ | `updateMeta()` 為改第一行，把整個 journal 複製到 tmp 再 rename，**沒有 fsync**（同套件的 `replaceRawSessionFile` 有） | `backend-factory.ts:420` | 停電時「改標題」可能讓整個 transcript 變空檔；rename 失敗還會留 tmp |
| F10 ○ | context-output 的 owners/artifacts 發布用 writeFile+rename 但無 fsync；`store.open()` 一次讀全部 artifact、第一個壞檔就 throw | `context-output/src/store.ts:38,245` | 一個壞 metadata 檔讓整個 workspace 的 retained results 全部無法使用 |
| F11 ○ | session-query reconcile 沒有 per-file 隔離，任何一個 session 檔解不開就讓整個 `session_search`／lineage 失敗 | `session-query/src/file-backed/index-refresh.ts:46` | 一個壞檔＝全庫搜尋掛掉 |
| F12 ○ | 同一個 `.jsonl` 有兩套寫入協定：一般 append（讀全檔、盲寫、失敗盲 truncate）vs managed `appendOwnedBatch`（前綴 digest、size fence、receipt） | `backend-factory.ts:272` vs `fact-journal.ts:158` | 崩潰一致性只對 managed lane 成立 |
| F13 ○ | retained-result 有 4 種並存磁碟編碼（artifacts+blobs、owners padded ledger、legacy-fork-v1、legacy-expiry-v1），各自有 commitment hash 與復原規則 | `context-output/src/store.ts:160` | 任何 retention 改動要改 4 次；四者不一致時 open 直接 throw |
| F14 ○ | `readExecTextWindow` 從 byte 0 逐 byte 走，每個 byte 配置 `Uint8Array` + `TextDecoder` | `context-output/src/artifact/exec-text-window.ts:20` | 讀大 job 輸出的尾段要跑 N 次解碼，工具呼叫卡住 |

### 生命週期與併發

| # | 問題 | 位置 | 影響 |
|---|---|---|---|
| F15 ✔ | `ctx.scope.unmount()` 是 no-op：它把「自己」從自己的 children Set 刪掉（父層 Set 仍持有它），而該 Set 從不被讀取；註解寫「I4/E2 owns its repair」 | `core-plugin/src/scope/create-scope.ts:36-46` | 每次 subagent spawn 都掛一個 child scope，永不釋放；plugin disposer 永不執行 |
| F16 ✔ | 每個 scope 每個事件只有**一個** decision slot，`emit` 開頭 `delete`、結尾 `set`；併發的 tool call 會互相覆蓋 | `core-plugin/src/scope/listeners.ts:80-101,132-137`（註解自認 M13 race） | 併發工具呼叫時審批決策可能丟失或串台 |
| F17 ✔ | unmount 的 5 秒 timeout 計時器成功路徑不 `clearTimeout` | `core-plugin/src/scope/dispose.ts:65-79` | 每次卸載多留一個 5 秒 timer + closure |
| F18 ○ | workflow job store 是 module 級 singleton，只增不刪，每筆保留完整 stdout/stderr | `workflow/src/runner.ts:98` | 長駐程序記憶體無界成長，且可跨 session 列出彼此的 job |
| F19 ○ | 每次 subagent 狀態保存都重寫**所有** job 的完整 output；job registry 永不修剪 | `subagent/src/persist.ts:82` | 狀態文件隨 session 年齡單調成長，每次 job 轉態都全量重寫 |
| F20 ○ | sandbox-windows-acl 的 per-session temp capability 只在 provider `dispose()` 釋放，沒有 session 結束的釋放路徑 | `sandbox-windows-acl/src/index.ts:594-654` | 每個 session 留一個 mkdtemp 目錄 + 一條常駐 inheritable ACE，直到程序結束 |

### 工具與檔案

| # | 問題 | 位置 | 影響 |
|---|---|---|---|
| F21 ✔ | `write` 是唯一非原子寫入：`edit`／`patch` 都走 `writeFileAtomic`，只有它用 `writeFile` | `fs/src/index.ts:351`（對照 `:460`） | 取消／崩潰／磁碟滿 → 目標檔被截斷，無備份 |
| F22 ✔ | `writeFileAtomic` 用全新 tmp 覆蓋 rename，不保留原檔 mode，所有呼叫端都傳 `undefined` | `fs/src/atomic.ts:18-23` | POSIX 上每次 edit 都把 0755 腳本變成 0644；模型無感知 |
| F23 ✔ | `read_video` 的 timeout 只 `kill()`，rejection 只等 `'close'`；孫程序持有 pipe 時 promise 永不 settle | `media/src/process.ts:10-12,28` | 超過 timeout 仍掛住，ffmpeg 與 256MiB 解碼存活 |
| F24 ✔ | sandbox 故障判定來**子程序自己的 stderr**（exit code 也可由子程序決定），而建議字串直接寫 `danger-full-access` | `exec/src/capture/completion.ts:96-98` + `sandbox/src/runner-failures.ts:22-25` + `shell/src/tools/policy.ts:113-124` | 任何 repo 內的建置腳本可偽造「sandbox 壞了」，製造升級到 full-access 的正當性 |
| F25 ✔ | 模型執行的 shell 繼承**完整** `process.env`，全庫沒有憑證過濾 | `shell/src/discovery/environment.ts:30` | `env`／惡意 npm postinstall 可把 API key、proxy 憑證打進 transcript |
| F26 ○ | `denialSignatures`／`enforcement` 由 backend 算出後被靜態表覆蓋，且唯一的 consumer 沒有被呼叫 | `sandbox-local/src/index.ts:57` | shell 被 sandbox 拒絕時模型只看到普通 exit code，不知道要升級 |

### 模型供應層

| # | 問題 | 位置 | 影響 |
|---|---|---|---|
| F27 ✔ | 4 份 SSE parser 有 3 份只 split `"\n\n"` 並取第一條 `data:`；CRLF 串流永遠切不開，多行 data 遺失 | `llm-openai/src/stream/decode.ts:4-18`（另 anthropic/gemini 同型） | 對 CRLF gateway：整個回應只解出第一個事件 → Anthropic 變空白成功；buffer 全程累積 |
| F28 ○ | 讀 4xx/5xx error body 的迴圈不吃 AbortSignal、沒有 deadline | `llm-seam/src/provider-error/http.ts:13` | 按 Stop 也取消不了，socket 被拖住 |
| F29 ○ | Bedrock 串流內的 SDK 成員名（`throttlingException`）大小寫與 classifier 不符 | `llm-bedrock/src/stream/fold.ts:149` | 串流中的 throttle／internal error 不會重試 |
| F30 ○ | token 估算有兩套啟發式：`len/4` vs `ascii/3+nonAscii` | `token-meter/src/estimate.ts:38` vs `projection/pricing.ts:13` | CJK 情境相差 12 倍；compaction 觸發與 admission 用不同數字 |
| F31 ○ | capacity retry 固定 10 秒、無 jitter | `llm-seam/src/retry/execution.ts:72` | 多 agent 同時重試形成 thundering herd |
| F32 ○ | credential store 的 read-modify-write 沒有鎖 | `credentials/src/index.ts:139` | 同時存兩個 key 會丟一個，且回報成功 |
| F33 ○ | API key 只靠 `0o600`，Windows 上等於無保護（OAuth token 有 DACL，API key 沒有） | `credentials/src/index.ts:256` | Windows 同機其他帳號可讀全部 provider key |

### 編排與產品功能

| # | 問題 | 位置 | 影響 |
|---|---|---|---|
| F34 ✔ | subagent `maxDepth` 永遠是 0 對 1 比較 → 限制永不觸發；程式碼註解自認「MOOT，因為內建 role 不給 spawn_agent」 | `subagent/src/tools/spawn.ts:78-95` | 自訂 role 一旦開放 spawn_agent 即可無限遞迴 |
| F35 ○ | spawn 一律 `parentPath: "root"`，但 cancel 用 path 前綴找子樹 | `subagent/src/tools/spawn.ts:165` + `tools/cancel.ts:125` | `stop_task` 回報成功，孫代理繼續跑 |
| F36 ✔ | legacy `assembly` 只 `tick()`、從不 `start()`；`owned-schedule` 會在 mount 後回傳 activate 去 `start()`。`driver.live()` 要求 `running`，而 `running` 只由 `start()` 設為 true，於是 `rearm()` 永遠 early-return，不會裝 timer | `session-executor/src/assembly.ts:1042,1078`；`owned-schedule.ts:26`；`schedule/src/driver.ts:123,214,384` | 非 managed session 的提醒仍會在下一個 step 被 tick 到，但**不會在閒置時到期觸發**；5 分鐘的提醒可能幾小時後才出現 |
| F37 ○ | settings `unset` 被 deep-merge 還原，但 revision 照樣 +1 | `settings/src/storage/layered-store.ts:191` | UI 顯示「已刪除」，重讀又是舊值；同步衝突被製造出來 |
| F38 ○ | compaction 分頁重試計數器跨頁共用 | `compaction/src/summary/generate.ts:81` | 第 2 頁第一次 malformed 就直接放棄整個壓縮 |
| F39 ○ | `guard-timeout` 只是 `await next()`，沒有 race | `guard-timeout/src/index.ts:46` | 不配合 abort 的工具永遠不會 timeout |
| F40 ○ | hook 在 session sandbox **之外**執行（Windows 硬編碼 `danger-full-access`） | `hooks/src/windows-process.ts:74-78` | 唯讀 session 的 plugin hook 仍可寫任何地方 |
| F41 ○ | plugin 的 `.mcp.json` 直接 spawn 任意命令，沒有 hook 那樣的 content-hash 授權 | `plugin-registry/src/mount.ts:188` | 啟用 plugin＝執行程式碼，無二次確認 |

---

## 3. P2 — 設計錯誤（架構層）

### D1. 82 個套件是「包裝」而非「邊界」 ✔
- 全庫 **117 處** `from '../../../<other-pkg>/src/...'`：session-executor 44、desktop 24、core-agent 13、subagent 12。
- 最嚴重：`core-agent`（`session-executor` 的依賴）反過來 import `session-executor/src/lifecycle/*` 與 `session-persistence/src/*`，而它的 `package.json` **完全沒有宣告** 這些依賴：

```ts
// packages/core-agent/src/agent/managed-admission.ts:4
import { assertExecutionGeneration } from '../../../session-executor/src/lifecycle/generation-actions.ts';
```

- 宣告圖：`session-executor → core-agent`；真實圖：`core-agent → session-executor`。這是隱形循環，pnpm 看不見。
- `pnpm-workspace.yaml:11` 開了 `ignoreWorkspaceCycles: true`。Tarjan 掃出 3 組 SCC，但**每一組都是由 devDependency 回邊閉合的**（例如 `session-persistence` 的 dev 依賴 jsonl，而 jsonl 以正式依賴依賴 persistence），所以 runtime graph 其實無環——嚴重度應降為中。真正的問題是這個 flag 是**全域且永久**的：未來若真的引入 runtime 循環，pnpm 也不會再警告。
- 後果：套件不能獨立建置、不能發佈、tsc 每個套件都要重parse 依賴的原始碼（typecheck 10 分鐘以上）。

### D2. God object 三連 ✔
| 檔案 | 行數 | 內容 |
|---|---|---|
| `session-executor/src/assembly.ts` | 1,917 | 約 70 個 import、`AssemblyOptions` **80 個欄位**、手動 wiring 整個產品 |
| `session-executor/src/service.ts` | 1,839 | ~54 個 Map/Set 容器，`closeAll()` 用一個手寫 predicate 列舉其中 11 個 |
| `desktop-gateway/src/router.ts` | 786 | 約 40 段 `if ([...].includes(method))` 字串陣列分派 |
| `desktop/src/main/ipc.ts` | 850 | 同一個 protocol 的第三份手寫驗證 |

`session-executor` 依賴 50 個內部套件、`cli` 54 個、`desktop-gateway` 43 個。這不是「模組化」，是把一個 monolith 切成 82 片後再用相對路徑黏回去。

### D3. 同一份契約寫四遍
- **SSE**：4 份 parser（openai / openai-compatible / anthropic / gemini），已漂移（只有 compatible 處理 CRLF）。
- **桌面 method 清單**：`bridge.ts` 的 120 個字串 union、`context-requests.ts` 的 validator、`ipc.ts` 的 switch、`router.ts` 的 if-chain。
- **通知白名單**：`sdk-runtime.ts:176` 手寫 `!==` 鏈 vs `bridge.ts:165` 的 type union；新增通知型別會編譯通過但被靜默丟棄。
- **fork 契約**：`fork-contract.ts`（v1）與 `selected-results-fork-contract.ts`（v2）近乎整檔複製；refusal 字面量在每個檔出現 **3 次**（type、array、type），v2 已多出 3 個值。
- **koffi Win32 繫結**：3 份獨立手寫（sandbox-windows-acl/ffi.ts、fs-lock/win32.ts、win32-artifact-api.ts），只有 1 份有 ABI 斷言。

### D4. 事件總線把「回傳值」當「政策」
`emitFn` 讓 listener 的最後一個非 undefined 回傳值成為 waterfall 的 payload，並在同一個 per-scope map 記錄 decision（`listeners.ts:80-103`）。於是「審批是否發生」取決於：掛載順序、listener 回傳什麼、以及同一個事件是否有併發 dispatch。這是 F4/F16 的病根。正確做法是把決策當**引數／回傳值**明確傳遞，或使用嚴格度合併。

### D5. 兩套 mount 造成同一功能兩種行為
legacy `assembly.ts` 與 managed/owned（`owned-*.ts`）各自掛載 schedule、todo、goal、title。已經造成 F36（reminder 不 arm）、以及 subagent/team 狀態在兩邊投影不同。這是本專案最大的架構債：**沒有單一 composition 權威**。

### D6. 信任邊界以「內容／名稱」而非「效果」建立
- shell 審批看 basename（F5）。
- sandbox 故障看子程序 stderr（F24）。
- 審批證據看 `Function.prototype.toString()` 的 17 個函式雜湊（`fs/src/index.ts:253`）——bundle/minify 後會失效或碰撞。
- guardian 把原始 tool args 直接串進 prompt（`guard-approval/src/guardian/reviewer.ts:125`），且 `approve` 不再問人 → 可被 prompt injection。

---

## 4. P2 — 過度設計

| # | 現象 | 證據 |
|---|---|---|
| O1 | **文件量接近程式碼量** | 1,097 份 md / 133,636 行；147 份 spec、251 份 plan、53 個 research 目錄；11 週 3,207 commit |
| O2 | **身分／描述符 fencing** | `core-session/src/managed/execution-state.ts` 536 行、`context-output/src/service.ts:1084` 每次查詢重驗自己的 property descriptor、18 處 `types.isProxy`；這些都擋不住同進程呼叫者 |
| O3 | **AsyncLocalStorage 追蹤串流所有權** | `llm-seam/src/prepared/*` 約 500 行（payload、stream-lifetime、owned-terminal、passive-observation）只為證明 generator 怎麼被呼叫 |
| O4 | **durable 事實層的記憶體雙胞胎** | `core-session/src/managed/nondurable.ts` + 6 個 `memory-*`，約 1,000 行重新實作 receipt/settlement/delivery |
| O5 | **微型套件** | `plan-mode` 103 行、`harness-home` 88 行、`jobs` 218 行、`todo` 219 行——各自帶 package.json、tsconfig、依賴邊 |
| O6 | **一次性腳本進版控** | `scripts/` 有 60+ 支 `patch-d3-assembler.mjs`、`repair-json-braces.mjs`、`fix-assembly-citation-drift.mjs` 這類遷移／修補腳本 |
| O7 | **雙實作** | `nondurable`（O4）、legacy/managed mount（D5）、`write` vs `writeFileAtomic`（F21）、4 種 retained-result 格式（F13） |
| O8 | **深層防禦變成仪式** | `core-tools`/`context-output` 大量 `Object.freeze` + WeakMap brand + descriptor 驗證，卻同時存在 F10 這種「沒 fsync」的實際漏洞 |

---

## 5. P3 — 不合理／衛生問題

- **版本漂移** ✔：80 個套件是 `0.1.0`、2 個（desktop、desktop-gateway）是 `0.1.13`；根 `package.json` 是 `0.1.0`；而 installer 文件說版本預設取自 package.json → 從這個 tree 打出來的安裝包會蓋成 `0.1.0`。
- **README 指向舊版** ✔：v0.1.13 tag 上的 README 仍寫「目前提供 v0.1.12」並連到 v0.1.12 下載。
- **「build」不是 build** ○：82 個套件的 `exports` 全部指向 `./src/index.ts`，`tsconfig.base.json` 是 `noEmit: true`，只有 `packages/desktop` 有真正的 build script；npm 版 CLI 的 bin 用 `node --import tsx src/index.ts` 在**執行時轉譯**，而 `tsx` 與 `@i-harness/llm-mock` 被列為 production dependencies。
- **型別設定碎裂** ○：全庫 106 個 `tsconfig*.json`，其中 24 個 `tsconfig.<feature>.json` 不繼承 base；`noUncheckedIndexedAccess`／`exactOptionalPropertyTypes` 完全沒開，卻有 5,246 個 `!` 斷言。
- **發布通道** ○：安裝器沒有任何 SignTool 指令（未簽章），全庫也沒有 auto-update 實作（唯一的 autoUpdater 字樣都在 docs/audit 的競品研究 JSON 裡）。
- **可達性** ○：repo 自己的掃描器顯示 422 個 export 沒有任何消費者，其中 59 個是新出現的；處理方式是「加 baseline」而不是縮小 API 面。
- **魔術數字散落**：`shellTimeoutMs ?? 120_000`、`subagentStaleAfterMs ?? 600_000`、`MIN_EVERY_INTERVAL_SECONDS = 300`、`Math.min(8, maxSummaryCalls ?? 8)`（上限不可調）。
- **矛盾 deadline**：desktop 等 compaction 600 秒，gateway 自己 120 秒就 abort；其他方法 30 秒一刀切。
- **通知全量廣播**：每個視窗收到所有 workspace 的事件，過濾在 renderer 做（`ipc.ts:746`）。
- **套件管理**：`pnpm install` 會重寫 lockfile 格式（僅格式差異），release tag 的 lockfile 由較舊 pnpm 產生。
- **測試品質不錯但仍失真**：1,800 個測試檔只有 7 個沒有 `expect(`，但高風險路徑（併發 emit、child scope 釋放、mount 順序）沒有測試；`plugin.test.ts:37` 的 unmount 測試是空轉。

---

## 6. 做得好的地方（避免只列壞的）

- **sandbox 預設 fail-closed**：無 backend 時拒絕執行，而不是默默放行。
- **檔案讀取**：`O_NOFOLLOW`、拒絕 hardlink、symlink 解析後再比對 root。
- **edit/apply_patch 走 atomic write**，且 M42 rewind 會先擷取 pre-image。
- **hook 授權**用內容雜湊，install 是兩階段 atomic。
- **approval evidence** 以 canonical 參數 + binding digest + policy revision 定鍵，不是寬鬆快取。
- **測試量與密度**（231k 行測試），`verify-all.mjs` 會檢查「回報的專案數 vs 應有數」，比多數專案誠實。
- **usage 合併**是 per-field last-wins，沒有 token 重複計算；OAuth refresh 有檔案鎖序列化。

---

## 7. 建議修復順序

1. **補 CI**（typecheck + test + lint），先讓 F1 綠燈；加 ESLint（哪怕只有 `no-floating-promises`、`no-explicit-any` 警告）。
2. **補 Electron `will-navigate`／`will-redirect`**（F3）——成本 10 行，風險最高。
3. **改審批語義**（F4/F16/F5）：decision 改成嚴格度合併 + shell 預設 `ask-all`。
4. **修資料完整性**：F7（拒絕非尾部損壞）、F9/F10（fsync）、F21/F22（atomic + mode）、F6（rewind conflict gate）。
5. **拆假邊界**：先把 117 處相對 import 收斂到 `exports`（可加 lint rule 禁止 `../*/src/`），再處理 3 組循環。
6. **單一 mount 權威**（D5/F36），刪掉 legacy 或 managed 其中一條路徑。
7. **收斂重複契約**：1 個 SSE framer、1 個 method table、1 個 disk format、1 個 schema 系統。
8. 最後才處理 over-engineering（O2/O3/O4）——它們是認知負擔，不是即時風險。

---

## 8. 方法與可信度

- 量化數據由 Node 腳本直接掃描 3,506 個原始檔產生（非估算）。
- 依賴圖／循環由 Tarjan SCC 從 82 個 `package.json` 計算。
- `pnpm typecheck`、`pnpm --filter @i-harness/core-plugin test` 實際執行。
- 8 個子系統深讀由平行審查代理完成；**本報告中標 ✔ 的每一條，我都回讀了原始碼段落或重跑了指令**。標 ○ 者為子系統提出且抽樣核對相符，少數（如 subagent depth）程式碼註解已自認限制，我按「已知負債」而非「隱藏 bug」呈現。
- 少數子代理的初始假設被推翻並已剔除（workflow 不是 JS eval、agent-team 不是 ad-hoc mailbox、Codex refresh 沒有競態、usage 沒有重複計算）。

---

## 9. 未修項目的判斷（穩定性優先）

以下每一項我都評估過「改與不改」的穩定性風險，結論是**現在不改**，並記錄原因與建議設計，避免後續有人以為是漏掉。

| 項目 | 判斷 | 原因與建議 |
|---|---|---|
| F8 append O(n²) | 不改（風險高） | append 需要 `journal.prefix`（digest + eventCount）與全歷史 `validateSemanticBootstrapHistory`。可加「(path,size) → prefix」快取並在 size/mtime 不符時回退全讀，但驗證函式目前是整歷史的；必須先把它改成增量（只驗 bootstrap 段）並補 crash/併發測試。錯了會直接損壞 session，收益只是延遲。 |
| F12 雙寫入協定 | 不改（格式遷移） | 一般 append（盲寫＋盲 truncate rollback）與 managed `appendOwnedBatch`（receipt + prefix fence）寫同一個檔案。應統一走 receipt 協定，但這是磁碟格式／復原路徑的遷移，需要版本化與回滾方案。 |
| F13 四種 retained-result 格式 | 不改（格式遷移） | artifacts/blobs、owners padded ledger、legacy-fork-v1、legacy-expiry-v1 各有 commitment 與復原順序。應收斂為一種不可變記錄＋一種發布協定，保留單向舊讀取器；屬多週遷移。 |
| F16 decision slot 併發 | 部分已修（服務化） | ALS 隔離失敗後改走服務路徑：guard-approval 同時註冊 approval/policy 服務，core-tools prepare 在 dispatch chain 未產生決策時直接呼叫它；只要服務存在，就完全不讀那個 per-scope/event 的可變 slot，因此併發 sibling 的 allow 不可能再被合併進來。未做的是徹底刪除 slot（仍需保留給沒有 policy service 的宿主），以及把 decision 當回傳值串進 dispatch 的長期重構。 |
| F20 ACL temp 生命週期 | 不改（缺 session 生命週期訊號） | 目前 temp capability 只在 provider dispose 釋放。加 LRU 驅逐可能在命令執行中撤權（直接讓命令失敗），穩定性代價高於記憶體收益。建議在 provider 介面加 `releaseSession(sessionId)`，由 exec/session 關閉時呼叫。 |
| F25 env 過濾 | 不改（產品決策） | 憑證可用環境變數提供（env-shadowed refs），過濾會直接破壞該功能；需要 allowlist／明確 pass-through 設計與 UI。 |
| F26 shell denial 分類 | 不改（缺私有通道） | 目前 shell 被 ACL 拒絕只表現為一般非零退出。正解是 runner 用私有 fd／不可偽造的 nonce 回報 denial；在沒有該通道前，任何 stderr 比對都可被偽造（F24 已先移除其升級誘因）。 |
| F40 hook 沙箱外執行 | 不改（信任模型決策） | hook 是 host 設定、內容雜湊授權的程式碼，現行設計把它視為「使用者已授權」。若要讓它繼承 session sandbox，需把 policy 逐呼叫傳入 hooks runtime 並改 POSIX 路徑，屬產品決策。 |
| F41 MCP 無 trust gate | 不改（產品決策） | 啟用 plugin 即代表同意其 MCP server 指令；可仿 hooks 做 content-hash grant，但需要 UI 與遷移。 |
| D1 117 處跨包 import | 不改（需分階段） | 應先加 lint 規則禁止 `../*/src/`，再把共用內部模組下移到 core-session/新 leaf 套件；一次改動會同時觸動 3 組循環與 50 依賴的 session-executor。 |
| D2 god objects | 不改 | assembly 1,917 行／80 選項、service 1,839 行／54 容器、router 786 行 if-chain。拆分需先建立 per-session runtime 物件與 method table，屬長期重構。 |
| D3 契約重複 | 部分已修 | SSE 已統一（F27）。其餘：桌面 method table、通知白名單、fork v1/v2、refusal 字面量、koffi 繫結已抽一份（F33 的 windows-protection）。剩下的是 protocol 層重構。 |
| D5 雙 mount | 不改（行為決策） | legacy assembly 與 managed/owned 對 schedule/todo/goal 的行為不同（F36 已確認為設計）。要嘛讓 legacy 也 mount timer，要嘛正式宣告 legacy 為 step-boundary-only；需產品選擇。 |
| O1–O8 過度設計 | 不改 | docs 4.3×、身分 fencing、ALS 所有權、nondurable 雙胞胎、微型套件。這些是認知成本而非即時缺陷，應在功能穩定期後獨立清理。 |

### 這一輪額外查證的修正

- **F38 是誤報**：compaction 分頁重試計數「跨頁共用」是**有測試編碼的刻意契約**（`summary-pages.test.ts`：「does not give each page another malformed-output corrective round」）。我先前的 per-page 改動已 revert，測試恢復 25/25。
- **F30 已實質修復**：`estimateMessage` 改用 `estimateTextTokens`（ASCII 4 chars/token、非 ASCII 按 UTF-8 byte），CJK 不再被低估約 12 倍；與 admission 的 `pricing.ts` 同為 byte-based，只剩 ASCII 3 vs 4 的保守差異。

### 追加修正（穩定性階段）

| 項目 | 內容 |
|---|---|
| D1 棘輪 | `scripts/audit/check-package-boundaries.mjs` + 147 筆基線；CI typecheck job 會跑 `--gate`，只擋**新增**的跨包 `src/` 相對 import。實測：乾淨 exit 0；加一行新 import → exit 1 並指出 importer/file/specifier。 |
| D3 通知白名單 | `desktop/src/shared/bridge.ts` 以 `DesktopNotificationMethod` + `DESKTOP_NOTIFICATION_METHODS` 單一來源；forwarder 改用 set lookup；`UnforwardedNotification extends never` 的編譯期斷言會在新增通知卻未列出時報錯（已用 probe 成員實測 `Type 'true' is not assignable to type 'never'`）。 |
| D3 fork 詞彙 | v1/v2 契約的 not-issued/refusal 字面量改由 `as const` 陣列推導型別，validator 與 union 不再各寫一份（每個檔從 3 份變 1 份）。 |
| 額外 | journal append 失敗回滾不再無條件 `truncate`：只在檔案仍長於 committed 長度時截斷，避免 Node 對較短檔案補零延伸。 |

### 第三階段：驗證基礎與兩個「不改」的決定

**F20 已推翻（不是缺陷）**：`createAssemblyExecutionRuntime` 是 **per-session**，`dispose()` 會 `await backends.dispose()`（`session-executor/src/execution-runtime.ts:108`），而 ACL sandbox 實例就是在那裡建立的。因此 per-session temp capability 會隨 session runtime 關閉而釋放，不是「process 生命週期無界成長」。獨立 exec 的 `defaultHost` 與 CLI self-check 也都各自持有並 dispose 自己的 backends。原審計把它當成 process singleton，前提不成立。

**D5/F36 決定：維持 legacy = step-boundary-only**。我實作了「legacy assembly 在第一次 pre-step 時 arm timer 並在 dispose 關閉」，但 `schedule-delivery.test.ts` 在此環境 10/10 全紅（baseline 相同），無法驗證行為變更；且這會改變「idle 是否觸發提醒」的產品語義。依穩定性優先，已完整回退，legacy 保持 step-boundary-only，managed mount 仍是唯一有 idle timer 的路徑。

**測試基礎的硬限制（新發現，影響所有後續驗證）**：
- `TASK_TRANSITION_UNSUPPORTED`：format 14 對沒有 transition storage 的 coordinator 直接拒絕操作，但 **290 個測試檔仍用 `createSessionCoordinator`**（只有 23 個用 composed 版本）。我把 jsonl 套件 24 個檔的 fixture 換成 composed 版本，`TASK_TRANSITION` 錯誤從 239 降到 99、通過測試 +72（221→293），但套件仍有 550 個失敗。
- 更大的阻塞是 **317 個測試需要外部產生的 evidence fixtures**（`cold resumes genuine original codec1/format11…` 這類測試），乾淨 checkout 根本沒有那些檔案。這代表 `verify:all` 的測試步驟**不可能在乾淨環境變綠**，除非重建 fixtures 或把它們改成自足測試；這是獨立的大型工程，不是逐項修 bug 能解決的。
- 我沒有把 fixture codemod 留在分支上（已 revert）：在無法讓套件轉綠的前提下，24 個測試檔的改動只增加 review 負擔。相關證據與建議已寫入本節。

### 第四階段：D6 與收斂

**D6（信任邊界以內容為基礎）已完成三項可安全落地的部分**：
1. `fs` 的 approval identity 不再雜湊 17 個函式的 `Function.prototype.toString()`（跨 bundler 不穩定、每次建構都付成本），改為 `FS_TOOLS_IMPLEMENTATION` 明確版本常數；審批規則會因此失效一次，這是刻意的。
2. Windows ACL denial 詞彙單一來源（`WINDOWS_ACL_DENIAL_SIGNATURES`）。
3. 桌面通知白名單由型別推導＋編譯期窮盡檢查，不再手寫 `!==` 鏈。

**未完成的 D2/D4/O 系列：判斷為不應在本分支動**。`assembly.ts`（1,917 行／80 選項）、`service.ts`（1,839 行／54 容器）、`router.ts`（786 行 if-chain）的拆分，以及 docs/身分 fencing 的清理，都需要在**可執行的測試基線**上進行；目前 317 個測試依賴外部 evidence fixtures、290 個 fixture 未適配 format 14，任何 god-object 拆分都無法被有效驗證。依「穩定性優先」，這些留給測試基礎修復後的重構分支，而不是在有風險的狀態下硬拆。
