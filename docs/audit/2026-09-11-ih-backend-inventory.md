# I-harness 後端全量盤點（2026-09-11）

> 基準：`m62` @ `8f2b62c4` · 範圍：**65 包**（`packages/*` 除去 `tui`、`tui-core`、`web`）＋ `apps/cli` · 方式：機械抽取 ＋ 並行子代理逐包走查 `src/` ＋ 對抗式引註驗證

本文件是 I-harness 後端的**逐包、逐命令**盤點。所有斷言附 `file:line`；無出處者不寫。

**導航**：覆蓋率總表 → 四組分包細節（引擎／工具／沙箱與模型／服務）→ 命令面（50 個 slash 命令的端到端路徑）→ CLI 宿主面。
**姊妹文件**：`docs/audit/2026-09-11-sevenway-command-matrix.md`（七源命令級對比矩陣）。
**取代關係**：本文件取代 `docs/CAPABILITIES-DETAIL.md` 作為後端細節的權威來源（該文件寫於 M35 之前）；`docs/audit/2026-08-31-fiveway-comparison.md` 的 dsh 基準為 0.1.2-alpha.1、IH 基準為 M25，兩者皆已過時，對比部分由姊妹文件取代。

## 方法

三階段，**結構不經 LLM**：

1. **機械抽取**（`scripts/audit/extract-*.mjs`）：65 包的 `package.json` ＋ `src/index.ts` 匯出符號、七源命令註冊點。骨架由腳本產生，因此**不會漏包、可重跑、可 diff**。
2. **逐包走查**（4 個並行子代理，一組一代理）：每包產出職責／公開介面／關鍵設計決策（含理由與出處）／失敗策略／事件／關鍵常數／原始碼內標記的缺口。硬規則：**無 `file:line` 即標未驗證，不准猜**。
3. **對抗式驗證**（`scripts/audit/verify-citations.mjs` ＋ 獨立驗證代理）：機械層重開每一條引註確認檔案存在、行號在範圍內、不是空白或純註解行；語意層由**無利益關係的獨立代理**抽樣重讀原文，判定引註是否真的支撐主張。

**證明強度聲明**：本盤點的所有機制主張來自**閱讀原始碼**，未執行任何程式碼。這是靜態審計，不是行為測試。

## 驗證記錄

| 關卡 | 方法 | 結果 |
|---|---|---|
| 覆蓋率 | `assemble-d1.mjs` 硬閘：表徵過的包集合必須**精確等於** `ih-surface.json` 的在範圍集合 | **65/65 PASS**（不足即拒絕產出文件並列出缺哪幾包） |
| 引註（機械） | `verify-citations.mjs`：重開每一條引註，確認檔案存在、行號在範圍內、非空白行 | **985 條主張 / 3,047 條引註，全部解析成功，0 越界** |
| 引註（對抗，第一輪） | 無利益關係的獨立代理抽 27 格，重讀原文判定引註是否真的支撐主張 | **0 條造假／過期行號**（每一條 `lineText` 與來源逐字元相符）；但 **4 條 WRONG_LINE**——主張為真，引註位置承載不了它 |
| 引註（對抗，第二輪） | 全資料 enriched 後重新分層抽樣 22 格再判 | `SUPPORTED 9 / PARTIAL 7 / WRONG_LINE 4 / UNSUPPORTED 0 / UNCERTAIN 2`。**又是 0 條造假或過期行號**；所有失敗同樣是載體失敗 |
| **合計** | 兩輪共 49 格、**35 格可評分** | **UNSUPPORTED 0**——無一條主張被判定為無根據 |
| 載體分佈 | `carrierClass()` 分類每條機制主張的**領頭引註**（786 條） | implementation **47%** ／ registry-listing **37%** ／ doc-comment 10% ／ alias-or-helper 3% ／ type-decl 3% |

**領頭引註的載體分佈是本次審計最重要的資料品質量測**，也是兩輪抽樣各有約一半格子不合格的原因：**不到一半的機制主張，領頭引註是實作它的那行程式碼**。11 個非 SUPPORTED 的格子全部落在三種形狀——bundle/manifest 條目、registry/exports 清單、同檔輔助函式或裸 alias。這三類現已是可重跑的量測，不再需要每輪重新發現。矩陣顯示時會改用**可得的最佳載體**（`bestCitation`），但上表量測的是**原始資料**，不因顯示層改善而變好。

**第一輪抓到的實際缺陷**（已修正，原始引註保留並就地記錄）：

- `/goal` 的機制主張引到 `packages/bundle/web-app/cordis.patch.yml:411`——那是一條 bundle manifest 條目，**下一行就是 `disabled: true`**。讀成證據反而是在說該 bundle 把這個外掛**關掉了**。真實在 `packages/goal/command-goal/src/index.ts:189-195`。
- `/compact` 引到 `packages/core/session/src/types.ts:427`（一句 `SurfaceOp` doc 註解），真實作在 `packages/compaction/command-compact/src/index.ts:57-105`。
- grok `/remember` 引到 `xai-grok-memory/src/storage.rs:113`（一個 MEMORY.md 路徑輔助函式），真實作在 `slash/commands/remember.rs:16-23`。
- grok `/model` 的「完全匹配優先」引到 `slash/commands/mod.rs:88`（`builtin_commands()` 的註冊 vec 條目），真實作在 `slash/commands/model.rs:49-53`。

另有一條**部分修正**尚未併入資料檔，記於此以免遺失：`packages/schedule` 的「先接受後投遞、永不靜默丟棄」主張，其引註落在 `driver.ts:35`（`deliveryErrors` 欄位的註解），真正的順序實作在 `:99-106`；且該主張有兩個邊界——**未知 session 會被跳過且完全不產生 `deliveryError`**（`:83`），而 `onDue` 拋出的 occurrence **仍會被計入 `delivered`**（`:108` 在 `:111` 的 await 之前執行）。因此「永不靜默丟棄」**過強**，實際是「接受先於投遞，但投遞失敗的會計不完整」。

**本審計自身工具的三個缺陷**（皆由上述驗證暴露，已修）：

1. `verify-citations.mjs` 不解析**範圍引註**（`path:line-line`，設計明文允許），導致 **274 條有效引註被誤報為檔案不存在**——一場純粹由正則引起的假警報。
2. 聯集折疊在「同源兩個命令正規化到同一 key」時**靜默丟掉一個**：codex 的 `Btw` 與 `Side` 都被正規化為 `side-conversation`，這既丟了一個命令，也讓 I-harness 自己的 `/btw` 列失去 codex 欄位。折疊邏輯現集中於 `lib-union.mjs`（原本有兩份手抄副本且已漂移），碰撞時**兩者都退回自己的名字**並回報。
3. codex 抽取器在只有 `to_string` 而無 `serialize` 時誤用 `serialize_all` 推導，**發明了無法被呼叫的命令 `auto-review`**。正解：canonical 是 `IntoStaticStr`（`to_string` > `serialize` > kebab），可解析名是 `serialize` ∪ `to_string`。由 repo 內測試 `auto_review_command_is_approve` 證實。

## 怎麼讀這份文件

每包一節，欄位固定。三處值得注意：

- **「關鍵設計決策」**是本文的核心價值——不是功能列表，而是**維護者必須知道的權衡**（資料模型、不變量、失敗策略、耦合）。
- **「已知缺口」全部來自原始碼內的標記**（註解、未接線的匯出、宣告未實作），**不是推測**。沒標記的包就寫「無」。
- 出處採 `path:line` 或 `path:line-line`。範圍形式代表該決策由一段程式碼共同承載。

## 跨包主線（讀細節前先知道的九件事）

這九條是橫切 65 包、在單包視角下看不到的結構性事實。

### 1. 沙箱隔離**只覆蓋 shell，而且只是「請求」**

`shell` 把可選的 `sandboxPolicy` 掛到 `exec.run`／`runBackground`（`packages/shell/src/index.ts:147,240,243`）；`exec` 在 spawn 前解析一次——受限策略但**沒有 provider 就 throw `SandboxUnavailableError`**（`packages/exec/src/index.ts:107-113`），能力不符則 `assertSandboxCapable` throw（`:116`），runner 失敗（bwrap exit 125）則 reject（`:185-194`）。

**但 `fs` 完全沒有沙箱整合**：`packages/fs/src` 內零個 sandbox 符號，`FsToolDeps` 只有 workspace ＋ rewind（`packages/fs/src/index.ts:38-49`），組裝點也沒傳（`packages/session-executor/src/assembly.ts:358-361`）。fs 的「圍堵」只是 `resolvePath` 拒絕 `..` 逃逸，而**絕對路徑可以穿過並指向 workspace 之外**（`packages/fs/src/index.ts:26-36`）。`fs-search`（rg 無 sandbox 欄位）與 `terminal`（PTY 無沙箱、無 timeout）同理。

> 這是本次盤點最重要的安全性發現：**「有 win-ACL 沙箱」不等於「所有檔案操作都被圍堵」**。寫入路徑的圍堵依賴 `resolvePath` 的相對路徑檢查，不是 OS 層隔離。

### 2. **讀隔離是宣告而非實作**，而且那道閘門在組合使用時從未上膛

沒有任何後端宣告 `readIsolation:true`——兩個本機後端都宣告 `{readIsolation:false}`（`packages/sandbox-local/src/index.ts:47,71`）；Windows ACL 後端自己的檔頭就寫明「writes are restricted; reads, network, and process visibility are NOT」（`packages/sandbox-windows-acl/src/index.ts:23-25`）；Linux bwrap 用 `--ro-bind / /`，**整個檔案系統仍可讀**（`sandbox-local/src/profiles.ts:4`）。

唯一相關機制是一道**拒絕閘**：`requireReadIsolation===true` 而能力未宣告時 `assertSandboxCapable` 拋錯（`packages/sandbox/src/index.ts:64-71`）。但 repo 全域 `requireReadIsolation` **只由測試設定**（`sandbox/test/enforcement.test.ts:13`、`exec/test/enforcement.test.ts:15`）——**在實際組合使用中這道閘從未上膛**。

### 3. 拒絕沙箱的後果是**整個 turn 失敗**，不是降級

`shell` 不接 `SandboxUnavailableError`：例外離開 tool body → `core-agent` 記 `tool/error` 後 rethrow 並**丟棄整個 tool batch**（`packages/core-agent/src/execute-tool-calls.ts:125-133,223-227`）。背景變體則變成 `status:"error"` 的 job（`packages/exec/src/index.ts:262-267`）。這是刻意的 fail-closed，代價是一條被拒絕的命令會殺掉整個 turn。

### 4. 壓縮是**全程 append-only**，歷史永不改寫——**但在出貨的宿主裡根本沒接上**

`deriveMessages` 以**聯集**隱藏：summary 遮蔽 ∪ `compaction/reset` 的 `removedSeqs` ∪ rewind 的 cut 窗口 ∪ prune 的替身投影（`packages/core-session/src/index.ts:315,411-438`；`packages/compaction/src/index.ts:233-263`）。`seq` 由 append 指派，**無 key 的事件永遠無法被隱藏**。這是七源中唯一持久層不改寫的設計——codex、opencode、cc-custom、grok 都在某種程度上替換或改寫，dsh 用 `surfaceOp` 遮蔽但仍以 append 為本。

> **⚠ 本次盤點最嚴重的產品級發現：這套引擎在出貨路徑上沒有被接線。**
>
> 非測試的 `createSessionService` 呼叫點**有多個**——`packages/tui/src/backend/embedded.ts:969`、`apps/cli/src/index.ts:424`（sdk）、`apps/cli/src/index.ts:594`（acp）、`apps/cli/src/web.ts:471`，另有 `apps/tui/src/index.ts:235` 一個（該處用 `modelPolicy: "test-mock"`，是否算「非測試」兩個代理有分歧：一份算四個，一份算五個）。**無一傳 `compact`。**
>
> **⚠ 更正記錄**：本節初稿寫「`embedded.ts:969` 是全 repo 唯一一個非測試呼叫點，我在 `packages/`＋`apps/` 全樹確認過」——**那句話是錯的**。我的搜尋實際只掃了 `packages/`，卻在文字裡宣稱涵蓋全 repo。這是兩個獨立子代理在後續階段分別抓到的，也正是本審計一直在批評的那種事：**把抽樣講成全稱**。上面已改為正確的多呼叫點敘述。
>
> **實質結論不變**：無論四個還是五個，**沒有任何宿主傳 `compact`**，headless 路徑讀的 `HeadlessOptions.compact`（`apps/cli/src/run.ts:231-233,258`）**沒有任何非測試檔案設定過**（只有 `apps/cli/test/cli.test.ts` 設過）。另有一個更細的條件：`service.ts:256-258` 是**析取**，所以即使傳了 compact config，只要 binding 沒有 `contextWindow` 也會被丟掉。
>
> 連鎖後果（每一環都有出處）：
>
> | 環節 | 出處 | 結果 |
> |---|---|---|
> | 服務層閘門 | `packages/session-executor/src/service.ts:256-258` | `opts.compact === undefined` → `compact = undefined` |
> | 組裝層 | `packages/session-executor/src/assembly.ts:621-629` | `opts.compact !== undefined` 為假 → 不建構 compactor |
> | 引擎層 | `packages/core-agent/src/index.ts:324-325` | `compactor` 未定義 → `compact()` 回 `{compacted:false, shadowedSeqs:[]}` |
> | 命令層 | `packages/tui/src/backend/embedded.ts:822-825` | `assembly.compactNow()` 回 `{compacted:false}` |
>
> 淨效果：**出貨的 TUI 中 `/compact` 會 toast「nothing to compact」，自動壓縮永不觸發**——而**預算階梯是有裝上的**（`assembly.ts:632-635` 只要 `contextWindow` 已知就供給 `budget`）。所以過長的 session 不會被壓縮，而是直接走到 fail-closed 的 `prompt_too_long`。
>
> 這個矛盾在本次盤點中**由兩個子代理各自給出相反結論**（IH 命令面代理說「出貨 TUI 中行為是真的，toast 只是降級路徑」；命令對比代理說「沒有任何出貨宿主傳 `compact`」）。我逐環回溯原始碼判定**後者正確**。記錄這件事本身就是重點：兩個都讀了程式碼的代理可以得出相反結論，而只有把整條鏈走完才能定案。
>
> 也解釋了本 session 稍早調查的 `case-027` 停滯與 `compact: backend seam absent` toast 的來源。

### 5. 「能力閘」是**硬閘**，不是 UI 過濾

`Loop.slashCapabilities()` 只推 8 個能力（`packages/tui/src/app/loop.ts:2419-2431`）。`plan-mode`、`guardian`、`vim-mode` **從不被推入**，因此 `/plan`、`/view-plan`、`/auto`、`/always-approve`、`/vim-mode` **在出貨的 TUI 中依建構即不可達**，其 `run` body 只是單一 toast（`run.ts:51,59`、`approval.ts:16`、`text-input.ts:69`）。未匹配的 slash 行變成 `Unsupported command: /<name>`，**永不觸達後端**（`loop.ts:2098-2113`）。

### 6. 三個命令**繞過註冊表**

`/settings`、`/provider`、`/model` 在 `registry.matches` **之前**就被 `tryG1SlashModal` 文字攔截（`loop.ts:2091-2094,3173-3195`）。它們在 `g1.ts` 的註冊項只是清單／轉發面（`g1.ts:1-10`）。讀「註冊表 = 命令真相」會漏掉這三個。

### 7. 對外掛程式碼**永不執行**——已用程式碼確認，非 README 聲稱

五處獨立的原始碼陳述：`capability.ts:2-9,52`（只 `JSON.parse` package.json，從不 import/require/eval）、`install.ts:29-30`（安裝是純檔案複製）、`materialize.ts:13`（只有 rm+cp）、`commands.ts:9-10`（只讀 markdown）、`evaluate.ts:110`（evaluator 把 `executable` 維度**無條件釘死為 `"unsupported"`**）。整個套件唯一 spawn 的進程是 `git`（原始碼複製用）。

### 8. 有一批**已宣告、已測試、但無生產呼叫者**的表面

這些不是「未完成」，而是「完成後沒接上」——盤點時最容易被誤讀為功能的部分：

- **整個沙箱升級模組**（`WIDER_MODES`、`ESCALATION_TARGETS`、`approveEscalation`、`sandboxDenialMarker`、`escalationHintMarker`、`validateEscalationArgs`，以及 `roots.ts` 的 `writableRoots`／`canonicalPath`）在 repo 全域只出現在 `packages/sandbox/test/seam.test.ts`。**且沒有任何 tool schema 宣告它的 marker 文字所廣告的 `sandbox_permissions`／`justification` 參數**——也就是說那條升級階梯在生產路徑上不存在。
- `guard-approval/src/remember.ts` 未 re-export、無 importer。
- `provider` 的 `buildWireClient` 僅測試使用；`preset` 的 `mountPreset` 無生產呼叫者。
- `sandbox-local/src/runner-failures.ts` 未 re-export，且 `exec` 從不掃描 `ConfinedArgv.denialSignatures`（只掃 `runnerFailureRules`）。
- `session-executor` 的 `estimateAssemblyOverhead`／`bindAuthRefreshStatus` 由 `src/assembly.ts` 匯出但未經 `src/index.ts` re-export，`package.json` 只暴露 `"."`——**套件外不可達**。
- `plan-mode` 的 `withdrawPlanModeTool`、`session-query` 的 legacy opener 與 `closeSessionQueries`、`session-persistence` 的 `registerUpgrade` 皆無生產呼叫者。


## 失敗策略的三分法（讀「失敗策略」欄前先知道）

65 包並非一致的 fail-closed。實際有三類，混淆會誤判：

| 類別 | 行為 | 代表 |
|---|---|---|
| **fail-closed（安全面）** | 無法保證安全即拒絕執行 | 沙箱（無 provider → throw）、hooks 五個 gate 事件（`ask` 也視為 deny）、fs-lock（非 win32/linux 直接 `SessionLockUnsupportedError`，**不提供 lockfile+PID 退路**） |
| **fail-soft（機制面）** | 契約上降級但不靜默 | compaction 無 config 時回 no-op `{compacted:false}`；mcp-client 主動 refresh 失敗不影響連線 |
| **fail-loud（配置面）** | 設定錯誤在**建構期**就炸 | `createAgent` 驗證 `contextWindow` 有限正數（NaN 曾讓整個預算階梯靜默失效）；CLI 的 `--sandbox` 壞值、`--resume` 無 store |

## 值得單獨記下的實作細節

- **`web-host` 的 `workspaceWarning` 是純顧問性質**：只在接受的 `cwd` 與執行 workspace 不同時**加一個回應欄位**，不搬移 session、不改檔案／shell／沙箱、不拒絕；**且 `opts.workspace` 未設時靜默省略**（`host.ts:259-263,1242-1247` vs `352-365`）。忘了傳 workspace 的宿主**完全不會收到警告**。
- **`web-host` 認證是 opt-in**（`auth===undefined` 即完全不認證，`host.ts:740`），但 **DNS-rebind／CORS 柵欄是無條件的**，對每一條路由與 mux upgrade 都生效（`host.ts:718-728,759-770`）。
- **`subagent` 的 `accepted → running` 發生在子代理已經開始執行之後**：`claim()` 在 `tools.ts:163` 呼叫，而 `child.ts:137` 早已啟動 `agent.run`。真正的准入閘是 identity-keyed `submit` ＋ 併發配額（預設 `Infinity`）與深度配額（預設 1）。**`running` 是觀測值，不是准入閘**。
- **`settings` 保留註解但有降級模式**：整行註解與空行在解析時剝除、寫入時按位置重新錨定；非標準排版只保留首尾區塊；無法解析的文件原樣保留並 throw `SettingsPatchError`。熱重載是 500 ms 輪詢，且只在**正規化視圖真的變了**才通知。
- **`sdk` 已凍結 v0 欄位級契約**但 `protocolVersion` 已到 2——四次加性追加都沒有 bump 版本（`protocol.ts:14,19,46,216`）。驗證者必須一起讀這四行，單看一行會誤判。
- **`workflow` 的 job store 是 `subagent` 的 `job_*` fallback 鏈第三層**——連 `unknown job: <id>` 字串都刻意對齊（`subagent/tools.ts:371,427`）。
- **`fs-lock` 不保證可重入**（同進程兩次開啟仍衝突，`linux.ts:148-150`），**不鎖 session 資料**（只鎖 `.lock` 檔的位元組範圍），**永不 unlink 鎖檔**。
- **`session-query` 從不供應過期資料**：搜尋時 reconcile，比對 revision+mtime，sha256 指紋決勝，需兩次穩定觀測，否則拋具型別的 `SessionQueryError`。
- **`core-agent` 的預算階梯第 2 層在沒有 compaction config 時不可達**（`if (compactor && resetAllowed)`，而 `compactor` 只在 `deps.compact` 存在時才有）；純預算 agent 會從壓縮失敗直接跳到 fail-closed `prompt_too_long`。

## CLI 的 fail-loud 與 silent-fallback 分界（動 disposition 前必讀）

同一支 CLI 內兩種哲學並存，且**分界不與重要性對齊**：

- **Fail loud**：`--session-backend`（任何位置，`index.ts:94-96`）、`run --sandbox` 壞值（`:186-191`）、`--resume` 缺 store（`:219-222`）或缺 id（`:241-244`）、`--model` 缺 `--api-key`（`:277-280`）、`sessions show` 缺 id（exit 2，`sessions.ts:180-183`）。
- **Silent fallback**：`web --port` 壞值 → `PORT` env → 4310（`index.ts:51-55`）；`web --session-dir` 缺值 → 預設根；`sessions --last` 非數字 → 20；`tui --mode` 未知值忽略。
- **Silent no-op**：**`tui --yes` 被解析但從未被讀取**（`apps/tui/src/index.ts:102,439,445` 是它僅有的三處出現），而它**同時寫在兩份 usage 字串裡**——TUI 根本沒有審批旗標。
- **未知子命令不被拒絕**：dispatch 是對 `args[0]` 的精確相等，其餘一律落到 `runTui(parseFlags(args))`（`index.ts:164→167`）。`i-harness --sandbox x run t` 會啟動 TUI。無任何 parser 支援 `--flag=value`。`i-harness run --help` 會執行一次 task 字面為 `"--help"` 的 headless turn。

## 未竟事項的誠實清單

盤點過程中發現、**本次不修**（本審計唯讀；disposition 見姊妹文件）：

- `session-executor` 的 `estimateAssemblyOverhead` 與 `bindAuthRefreshStatus` 由 `src/assembly.ts` 匯出，但 `src/index.ts` 未 re-export 且 `package.json` 只暴露 `"."`——**套件外不可達**。
- `core-session` 的 `migrate()` 是 no-op 佔位（`:682-687`）。
- `goal` 的 round admission **宣告未實作**，`GoalView.round` 從未填充（`goal:35-43`）。
- `session-persistence` 的 `registerUpgrade` 樹內無註冊點；`plan-mode` 的 `withdrawPlanModeTool` 無呼叫者；`session-query` 的 legacy opener 與 `closeSessionQueries` 無生產呼叫者。
- `session-query` 的 `SearchHit.time` 是**索引重建時間**，不是事件時間。
- `output-retention` 的裸 `createSpillStore` **永不清理**（原始碼自標 limitation）。
- `workspace` 明確延後：`delete`、`insertBefore`、`follow`、`status`。
- `lsp` 強制**一個 run 一個 server**（明列為 M18 non-goal）。

---

以下是逐包細節。每節的引註皆可回溯至 `src/`。

## 覆蓋率總表（65/65 包）

| 包 | 分組 | 職責（截斷） | 設計決策 | 缺口 | 引註 |
|---|---|---|---|---|---|
| `core-agent` | engine | The agent turn loop: one session's LLM turn (append turn/start+user/message → per-step der… | 6 | 2 | 18 |
| `core-plugin` | engine | The plugin/event kernel: a scope tree (child scopes via scope.mount) holding a service reg… | 5 | 1 | 14 |
| `core-session` | engine | The session data model and its projections: the SessionEvent union, an append-only event l… | 5 | 3 | 20 |
| `session-executor` | engine | The engine-owned session assembly and its global service: one createSessionAssembly builds… | 6 | 3 | 20 |
| `session-persistence` | engine | The persistence coordinator and its policy layer over a PersistenceBackend: session create… | 7 | 3 | 24 |
| `session-persistence-jsonl` | engine | The JSONL on-disk PersistenceBackend: one file per session (header line + one JSON event p… | 5 | 1 | 16 |
| `session-query` | engine | Full-text session search and lineage over the durable JSONL store: an independent, rebuild… | 5 | 3 | 17 |
| `session-title` | engine | Derive and persist a short session title: a deterministic word-count fallback, a one-shot … | 4 | 2 | 9 |
| `runtime-context` | engine | Dynamic system context as a durable snapshot: named sections rendered at each agent/pre-st… | 4 | 1 | 9 |
| `instructions` | engine | Discover and load AGENTS.md / CLAUDE.md instruction files and render them as one runtime-c… | 3 | 2 | 10 |
| `interaction` | engine | The interaction seams between host and engine: the approval answerer, the user-question pr… | 4 | 1 | 11 |
| `plan-mode` | engine | The R-A7 plan-mode surface: the plan-mode system-prompt fragment, enter/exit helpers that … | 4 | 1 | 12 |
| `goal` | engine | The goal domain: a last-wins goal projection folded from goal/change session events, plus … | 4 | 2 | 12 |
| `token-meter` | engine | The token-estimation single source of truth: fixed-density per-message/content estimates a… | 4 | 1 | 10 |
| `compaction` | engine | Context-pressure control: shadow-range selection, an LLM summary pass with an anchored (up… | 6 | 3 | 21 |
| `output-retention` | tools | Two-layer output-size control: (1) a pure byte-budget text retainer that keeps a head and/… | 4 | 1 | 20 |
| `rewind` | tools | Backend snapshot/rollback engine for a session: a RewindStore keeps a per-session journal … | 6 | 4 | 33 |
| `attachment` | tools | Image attachment persistence plus the model-callable read_image tool: bytes are written un… | 3 | 2 | 15 |
| `core-tools` | tools | The Tool contract and the tool registry that owns registration, exposure filtering, the ap… | 7 | 2 | 38 |
| `fs` | tools | The five workspace file tools (read, edit, write, apply_patch, list_dir) with a returned-f… | 6 | 3 | 33 |
| `fs-lock` | tools | Session ownership lease primitive: one process holds a process-lifetime EXCLUSIVE OS byte-… | 4 | 2 | 21 |
| `fs-search` | tools | The glob and grep tools: both shell out to a lazily resolved @vscode/ripgrep binary throug… | 4 | 2 | 20 |
| `fs-watch` | tools | A chokidar-backed filesystem event stream exposed as an AsyncIterable of { path, kind: add… | 3 | 1 | 17 |
| `shell` | tools | The bash and pwsh tools: resolves which shell executable to spawn, keeps a tool NAMED bash… | 4 | 1 | 24 |
| `exec` | tools | The process-execution service behind the shell tools: spawns argv (optionally confined), k… | 5 | 3 | 30 |
| `terminal` | tools | PTY-backed terminal and process control: a TerminalService owning node-pty sessions with a… | 4 | 3 | 22 |
| `text-diff` | tools | Structured line-diff builder and unified renderer used by the fs write/read surfaces: wrap… | 4 | 1 | 17 |
| `todo` | tools | The todo_write tool: a whole-list snapshot model where every call replaces the previous li… | 3 | 1 | 11 |
| `tool-search` | tools | The deferred-tool retrieval mechanism: a self-developed BM25 engine (exact-name, select: l… | 4 | 1 | 23 |
| `skills` | tools | SKILL.md deferred retrieval: a registry that scans <workspace>/skills and the global ~/.i-… | 5 | 2 | 27 |
| `lsp` | tools | Language-server integration: a Content-Length-framed JSON-RPC connection over a spawned su… | 7 | 3 | 39 |
| `mcp-client` | tools | Model Context Protocol client: transport construction (stdio / streamable-http), an OAuth … | 7 | 3 | 40 |
| `workspace` | tools | A durable Workspace registry over the session coordinator's generic document store: it own… | 5 | 3 | 30 |
| `sandbox` | safety-model | Type/contract seam for process sandboxing: defines the three modes, the SandboxProvider.co… | 5 | 4 | 14 |
| `sandbox-local` | safety-model | The platform-dispatch SandboxProvider: on Linux it wraps argv in a bubblewrap profile, on … | 5 | 3 | 13 |
| `sandbox-policy` | safety-model | Resolves the effective sandbox mode for a session (last 'sandbox/mode' event wins over the… | 3 | 1 | 6 |
| `sandbox-windows-acl` | safety-model | Windows write-restriction backend: builds a WRITE_RESTRICTED token whose restricting-SID l… | 6 | 5 | 23 |
| `guard-approval` | safety-model | The tools/pre-execute approval policy (three layers plus a 'never' headless promotion) and… | 7 | 4 | 22 |
| `guard-repeat-tool` | safety-model | Counts consecutive identical tool calls (tool name + JSON args) per Session and, at each c… | 4 | 1 | 7 |
| `guard-retry` | safety-model | Cascade guard on tools/execute that re-dispatches a tool call whose result carries the TOO… | 4 | 1 | 10 |
| `guard-timeout` | safety-model | Cascade guard on tools/execute that enforces the tool's declared timeoutMs by swapping in … | 4 | 1 | 9 |
| `llm-seam` | safety-model | The provider-agnostic model seam: the LLMStreamEvent/LLMRequest/ModelClient vocabulary, th… | 6 | 1 | 12 |
| `llm-anthropic` | safety-model | Anthropic Messages wire adapter: streams SSE from POST {baseUrl}/v1/messages, assembles to… | 5 | 1 | 13 |
| `llm-openai` | safety-model | OpenAI Responses wire adapter: streams SSE from POST {baseUrl}/v1/responses, maps neutral … | 5 | 1 | 11 |
| `llm-openai-compatible` | safety-model | Chat Completions wire adapter for any OpenAI-compatible endpoint: streams SSE from POST {b… | 4 | 1 | 11 |
| `llm-gemini` | safety-model | Gemini generateContent wire adapter: streams SSE from POST {baseUrl}/v1beta/models/{model}… | 5 | 1 | 12 |
| `llm-bedrock` | safety-model | AWS Bedrock Converse wire adapter: sends ConverseStreamCommand through the AWS SDK, walks … | 5 | 1 | 13 |
| `llm-mock` | safety-model | A scripted mock ModelClient: each stream() call replays exactly one MockStep (its tool cal… | 2 | 1 | 4 |
| `provider` | safety-model | The provider plane: protocol enum + ProviderProfile/registry, the unified model-context re… | 7 | 3 | 18 |
| `provider-runtime` | safety-model | The settings+credentials-backed provider runtime: merges registry templates with user sett… | 7 | 2 | 16 |
| `credentials` | safety-model | The ref-based credential store: one JSON document of ref -> value under the config home wi… | 5 | 2 | 20 |
| `preset` | safety-model | Agent presets: the JSON preset shape (name/systemPrompt/tools/model), parsePreset validati… | 3 | 1 | 7 |
| `web-host` | service | The web service surface: one node:http server with unary JSON HTTP routes (sessions/worksp… | 4 | 4 | 28 |
| `sdk` | service | The external stdio SDK: NDJSON JSON-RPC 2.0 framing (protocol.ts), a client with low-level… | 4 | 3 | 24 |
| `acp` | service | An Agent Client Protocol (ACP v1) server implementing the automation subset over the offic… | 4 | 3 | 17 |
| `subagent` | service | Delegated child agents: role registry, spawn/fork into durable child sessions, an agent ta… | 4 | 4 | 25 |
| `agent-team` | service | The Team scope: a lead plus named durable teammates over the SAME subagent machinery, with… | 4 | 3 | 23 |
| `workflow` | service | Static multi-step workflows defined as YAML files under <workspace>/workflow/*.yml; one ru… | 4 | 4 | 23 |
| `hooks` | service | User-configured hook handlers (CC-compatible semantics) mounted on the core-plugin seams: … | 4 | 3 | 24 |
| `plugin-registry` | service | The host-facing plugin lifecycle: register marketplace sources (local dir / http(s) market… | 4 | 4 | 26 |
| `settings` | service | The global/layered user settings document: schema + normalization (single source for every… | 4 | 4 | 24 |
| `telemetry` | service | The host-side telemetry stream (separate from the session log and invisible to the agent):… | 3 | 2 | 13 |
| `jobs` | service | A pure projection package for the web jobs surface: it folds `job/status` session events (… | 3 | 1 | 16 |
| `schedule` | service | Durable per-session reminders whose state IS the session event stream: `schedule/change` v… | 4 | 3 | 21 |
| `feedback` | service | Per-message user feedback (like/dislike + optional note) for a session, persisted as ONE c… | 4 | 3 | 19 |

合計 **65** 包、**299** 條設計決策、**1207** 條引註；**65** 包有原始碼內標記的已知缺口。

## 引擎與會話核心

### `core-agent`

The agent turn loop: one session's LLM turn (append turn/start+user/message → per-step derive messages → stream the model → append assistant/tool events → execute the step's tool calls → step/end → turn/end), plus the per-session serial input lane (createSessionExecutor) that admits four-tier inputs into the durable Inbox.

> npm `@i-harness/core-agent` · 入口 `packages/core-agent/src/index.ts` · 3 個原始檔 · 15 個匯出符號

**公開介面**：`createAgent`、`Agent`、`AgentConfig`、`AgentDeps`、`AgentResult`、`AgentBudgetConfig`、`AgentRegistry`、`createAgentRegistry`、`executeToolCalls`、`BatchCall`、`ExecuteToolCallsOptions`、`TOOL_ABORTED_BEFORE_DISPATCH`、`createSessionExecutor`、`createSessionExecutorRegistry`、`mapSubmitToAdmission`、`SessionExecutor`、`SessionExecutorDeps`、`SessionExecutorRegistry`、`InputSubmit`、`AgentRunSurface`、`ReasoningEffort (re-exported from llm-seam)`

**關鍵設計決策**

1. **All context control is step-boundary-only: the steer-tier input claim, the M11 compaction pressure check, the M20 budget ladder and the agent/pre-step emit all run at the TOP of a step, before messages are derived and the model is called. Nothing rewrites the surface mid-stream.**
   - 理由：Keeps the model surface for one request stable and makes every surface change replayable as a log append that precedes the step.
   - 出處：`packages/core-agent/src/index.ts:195`、`packages/core-agent/src/index.ts:209`
2. **Three-layer overflow ladder: (1) compaction summary, (2) pure resetWindow keeping the last resetRetainLast events, (3) fail-closed throw `prompt_too_long`. Budget config is validated LOUDLY at createAgent (finite positive contextWindow, non-negative integer resetRetainLast/overheadTokens) because a NaN contextWindow made every comparison false and silently killed the whole ladder.**
   - 理由：A silent budget is worse than a loud one; the ladder's reachability is guaranteed at construction time, not at the moment of overflow.
   - 出處：`packages/core-agent/src/index.ts:106`、`packages/core-agent/src/index.ts:151`
3. **Layer 2 (reset) is only reachable when a compaction engine exists: the guard is `if (compactor && resetAllowed)`, and the compactor only exists when deps.compact is configured. A budget-only agent therefore goes straight from a failed compaction to fail-closed.**
   - 理由：resetWindow is a method of the compaction engine, so budget.resetWindow cannot stand alone without deps.compact (a real coupling a maintainer must know).
   - 出處：`packages/core-agent/src/index.ts:130`、`packages/core-agent/src/index.ts:164`
4. **Tool calls are collected during the stream, then executed after it ends by a bounded rolling pool with a model-order commit lane: a group is a maximal run of concurrency-safe calls (exclusive calls are singleton groups that never overlap), only the tool body (dispatch) overlaps while prepare and finalize run in the ordered lane, and commit order is enforced by a head-of-line cursor.**
   - 理由：Approval/policy hooks stay deterministic (model order) while slow tool bodies still overlap; the commit lane is what makes the log order independent of completion order.
   - 出處：`packages/core-agent/src/execute-tool-calls.ts:31`、`packages/core-agent/src/execute-tool-calls.ts:138`
5. **Batch failure policy: throw-fails-turn — stop starting, drain started calls, rethrow the first error with NO fabricated results for unstarted calls. Abort dominates a coincident failure: started-but-unsettled slots get a synthetic failure fill so already-settled siblings still commit REAL results, never-started calls get a TOOL_ABORTED_BEFORE_DISPATCH result, then `agent aborted` is thrown.**
   - 理由：Fabricating results would make the replayed log lie to the model; the synthetic fill exists only so the head-of-line cursor cannot stall forever and orphan a successful sibling.
   - 出處：`packages/core-agent/src/execute-tool-calls.ts:182`、`packages/core-agent/src/execute-tool-calls.ts:7`、`packages/core-agent/src/execute-tool-calls.ts:103`
6. **Per-session serial lane, cross-session parallel: every submit appends a pump onto ONE promise chain (one turn at a time per executor), each pump drains the pending FIFO to empty, and a turn failure is captured (not propagated into the chain) then re-thrown by drain() so a host exit code can never report success on a failed turn.**
   - 理由：Serial-per-session without a queue server, while keeping the failure observable at exactly one place (the drain caller).
   - 出處：`packages/core-agent/src/executor.ts:75`、`packages/core-agent/src/executor.ts:141`、`packages/core-agent/src/executor.ts:49`

**失敗策略**：Mixed by layer. Turn/tool integrity is fail-closed: maxTurns exceeded throws (packages/core-agent/src/index.ts:192), budget cap throws `prompt_too_long` (packages/core-agent/src/index.ts:169), a model stream `error` event throws (packages/core-agent/src/index.ts:264), the tool batch rethrows the first failure (packages/core-agent/src/execute-tool-calls.ts:224). The compaction layer is fail-soft by contract: with no compact config the agent returns a no-op `{compacted:false}` (packages/core-agent/src/index.ts:324) and the engine itself never throws. Configuration is fail-closed at creation (packages/core-agent/src/index.ts:114).

**事件**：`turn/start`、`user/message`、`step/start`、`tool/call`、`tool/result`、`assistant/message`、`step/end`、`turn/end`、`ctx plugin events (not SessionEvents): agent/pre-step, agent/post-tool, agent/stop`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `maxTurns (default)` | 20 | `packages/core-agent/src/index.ts:101` |
| `maxParallelToolCalls (default)` | 10 | `packages/core-agent/src/index.ts:102` |
| `budget.reserveRatio (default)` | 0.9 | `packages/core-agent/src/index.ts:29` |
| `budget.resetRetainLast (default)` | 20 | `packages/core-agent/src/index.ts:136` |
| `budget.overheadTokens (default)` | 0 | `packages/core-agent/src/index.ts:155` |
| `TOOL_ABORTED_BEFORE_DISPATCH` | "TOOL_ABORTED_BEFORE_DISPATCH" | `packages/core-agent/src/execute-tool-calls.ts:7` |

**已知缺口（原始碼內標記）**

- Retry observability is explicitly deferred: M12 guard-retry and M20 provider retry are silent by design and expose no callback/event seam, so core-agent emits NO retry/start telemetry; the comment calls adding a retry hook to those packages 'follow-up' (packages/core-agent/src/index.ts:229).
- The string model selector was dropped for M1: because `model?: string` would collide with AgentDeps.model (the ModelClient) under AgentDeps & AgentConfig, LLMRequest.model is never populated by the loop (packages/core-agent/src/index.ts:45).

---

### `core-plugin`

The plugin/event kernel: a scope tree (child scopes via scope.mount) holding a service registry, plain listeners, waterfalls, cascades and guards, plus plugin mount/unmount with synchronous reclamation of everything a plugin registered.

> npm `@i-harness/core-plugin` · 入口 `packages/core-plugin/src/index.ts` · 1 個原始檔 · 12 個匯出符號

**公開介面**：`createContext`、`PluginContext`、`Plugin`、`NextFn`、`Listener`、`WaterfallHandler`、`CascadeHandler`、`GuardFn`、`CASCADE_REDISPATCH`、`markCascadeRedispatch`、`isCascadeRedispatch`、`corePluginVersion`

**關鍵設計決策**

1. **Four distinct extension channels with deliberately different contracts: plain listeners (return values ignored unless a waterfall exists for the event), waterfall (every handler MUST call next(), forgetting throws, double-next throws — no arity heuristics), cascade (around-hooks over one `final`; skipping next() legally short-circuits, double-next throws), guards (deny-only string reason).**
   - 理由：The failure mode being designed out is a silent veto: a waterfall handler that never releases the chain is an error, not a decision.
   - 出處：`packages/core-plugin/src/index.ts:171`、`packages/core-plugin/src/index.ts:203`、`packages/core-plugin/src/index.ts:147`
2. **Ancestor composition is explicit and monotonic: guards walk self→root with first-deny-wins (a child allow can never re-allow a parent deny), cascades are collected root-FIRST so ancestor handlers wrap child dispatches outermost, and decisions are nearest-wins.**
   - 理由：A child scope (subagents) must not be able to escape a root-mounted policy handler; guard denial must be monotone down the tree.
   - 出處：`packages/core-plugin/src/index.ts:329`、`packages/core-plugin/src/index.ts:217`、`packages/core-plugin/src/index.ts:341`
3. **A separate resolveAncestorDecision that skips `self` exists solely because the per-scope decision map is a shared slot across in-flight emits (the M13 decision-slot race): the local scope's decision already arrives via emit's return value, so only ancestor decisions are looked up here.**
   - 理由：Reading self's recorded decision during a concurrent dispatch would surface another dispatch's value.
   - 出處：`packages/core-plugin/src/index.ts:353`、`packages/core-plugin/src/index.ts:255`
4. **Decision seeding is detection of 'a value was produced', not object identity: only a plain-listener non-undefined return seeds the waterfall chain payload and records a decision, and the decision entry is cleared at the start of every emit so decisions never leak across repeated emits.**
   - 理由：Prevents every incidental listener return (e.g. `calls.push(x)` → a number) from rewriting what other listeners/parent scopes receive.
   - 出處：`packages/core-plugin/src/index.ts:245`
5. **Unmount is synchronous reclamation with an async cap: registry removal, nested reclaim and listener/waterfall/cascade deregistration all happen synchronously so a caller that fires ctx.unmount and proceeds immediately sees the plugin gone; only promise-returning disposers are awaited, raced against UNMOUNT_TIMEOUT_MS (unref'd timer).**
   - 理由：A teardown must never hang the process, and the plugin must be observably gone before the next statement.
   - 出處：`packages/core-plugin/src/index.ts:393`、`packages/core-plugin/src/index.ts:432`

**失敗策略**：Fail-closed on protocol violations (waterfall forgot/double next throws at packages/core-plugin/src/index.ts:186, duplicate service registration throws at packages/core-plugin/src/index.ts:294, unknown service throws at packages/core-plugin/src/index.ts:300), but fail-open on teardown: a disposer that exceeds the 5s cap logs via console.error and the unmount completes anyway (packages/core-plugin/src/index.ts:437).

**事件**：`none (the kernel is string-keyed; it declares no SessionEvent vocabulary of its own)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `UNMOUNT_TIMEOUT_MS` | 5000 | `packages/core-plugin/src/index.ts:74` |
| `corePluginVersion` | "0.1.0" | `packages/core-plugin/src/index.ts:468` |
| `CASCADE_REDISPATCH` | Symbol.for("i-harness.cascade.redispatch") | `packages/core-plugin/src/index.ts:16` |

**已知缺口（原始碼內標記）**

- None marked in code. The channels are generic strings, so the package itself declares no event vocabulary — which event names exist is only discoverable from the producers (e.g. core-agent's agent/pre-step, agent/post-tool, agent/stop).

---

### `core-session`

The session data model and its projections: the SessionEvent union, an append-only event log with seq assignment, deriveMessages (the exact LLM surface), the small derived views (plan mode, title, prune substitutes, rewind cuts), JSONL (de)serialization, and the durable input Inbox.

> npm `@i-harness/core-session` · 入口 `packages/core-session/src/index.ts` · 2 個原始檔 · 36 個匯出符號

**公開介面**：`SessionEvent`、`Session`、`SessionHeader`、`createSession`、`append`、`subscribe`、`deriveMessages`、`deriveSearchText`、`derivePlanMode`、`deriveSessionTitle`、`derivePruneSubstitutes`、`renderPruneSubstitute`、`rewindCuts`、`toJSONL`、`fromJSONL`、`assertVersion`、`migrate`、`CURRENT_FORMAT_VERSION`、`PlanModeView`、`SessionTitleView`、`PruneRecord`、`RewindCut`、`TodoItem`、`TodoItemStatus`、`GoalPhase`、`GoalOperation`、`GoalRef`、`GoalSnapshot`、`ImageInput`、`ImageMediaType`、`IMAGE_MEDIA_TYPES`、`MAX_IMAGE_BYTES_PER_MESSAGE`、`LLMMessage`、`LLMContentPart`、`Inbox`、`SYSTEM_INPUT_PLUGIN`、`AdmittedInput`、`PendingInput`、`InputDelivery`、`InputIntent`、`InputSynthetic`

**關鍵設計決策**

1. **Append-only iron rule with projection-only hiding: the raw log is never rewritten or truncated. Every removal is a marker — compaction/summary.shadowedSeqs, compaction/reset.removedSeqs, compaction/prune records, rewind/point windows. deriveMessages does ONE pre-pass collecting the shadow set + melded rewind cuts, then a render pass; skip is the UNION (`shadowed.has(seq) \|\| hideByRewind(seq)`), so a rewind never un-shadows a compaction's removed seqs.**
   - 理由：Persistence backends are append-only, so in-place deletions never reached disk and a resumed session resurrected the deleted history; markers make resume a pure replay.
   - 出處：`packages/core-session/src/index.ts:411`、`packages/core-session/src/index.ts:394`、`packages/core-session/src/index.ts:256`
2. **seq is assigned by append itself (`{...event, seq: session.events.length}`), and an event with seq === undefined can never be hidden by any mechanism. Malformed persisted markers contribute nothing (defensive `?? []` / typeof guards) because fromJSONL and CLI resume push events without running append validation.**
   - 理由：Unkeyed events include externally injected user messages the loop must retain; making 'unkeyed' mean 'never hidden' removes an entire class of data-loss bug.
   - 出處：`packages/core-session/src/index.ts:315`、`packages/core-session/src/index.ts:219`、`packages/core-session/src/index.ts:414`
3. **deriveMessages enforces the wire shape of a step as one unit: tool/call events are buffered and flushed as assistant(content, toolCalls) followed by the tool results (never interleaved), the step's assistant/message folds INTO the same assistant message (M51/B2), a mid-step user/message is deferred until after that block (M52/L3), and step/end flushes so consecutive steps never merge into role-alternation-breaking runs.**
   - 理由：Anthropic-style Messages APIs require function_call before function_call_output and role alternation; folding also stops the model reading pre-tool narration as post-tool commentary.
   - 出處：`packages/core-session/src/index.ts:379`、`packages/core-session/src/index.ts:456`、`packages/core-session/src/index.ts:507`
4. **The Inbox is a replay-once projection over three log events (agent/input/admitted\|promoted\|cancelled): every mutation is a session-log append, so persistence is the log's own and a cold resume rebuilds pending from the log alone. Only steer-delivery inputs are claimed at the step boundary; queue inputs wait for the turn boundary. Admission fails closed on duplicate ids and malformed fields.**
   - 理由：A memory-only mailbox would lose the ladder on restart; putting it in the log makes the pending set auditable and cancellable durably.
   - 出處：`packages/core-session/src/inbox.ts:21`、`packages/core-session/src/inbox.ts:38`、`packages/core-session/src/inbox.ts:106`、`packages/core-session/src/inbox.ts:120`
5. **Image intake is validated fail-loud at append (the only point where images first attach to an event), while deriveMessages stays a pure projection with defensive handling of malformed persisted shapes (a truthy non-array output.images must not throw). Image bytes are never migrated out of the log: dataBase64 stays required and attachmentId is a purely additive store ref.**
   - 理由：Validation belongs at the write boundary; a read projection that throws on old/corrupt logs would make resume impossible.
   - 出處：`packages/core-session/src/index.ts:319`、`packages/core-session/src/index.ts:176`、`packages/core-session/src/index.ts:487`

**失敗策略**：Fail-closed at the write/parse boundary (append throws on a foreign `source` on assistant/message packages/core-session/src/index.ts:316, on non-canonical base64/unsupported media type/oversize aggregates packages/core-session/src/index.ts:349; fromJSONL throws on an empty log or a version mismatch packages/core-session/src/index.ts:669), deliberately fail-safe on read: every projection degrades instead of throwing on malformed persisted events (packages/core-session/src/index.ts:219). No try/catch swallow anywhere; the split is by direction.

**事件**：`defines the whole SessionEvent union (packages/core-session/src/index.ts:5)`、`produces via Inbox: agent/input/admitted, agent/input/promoted, agent/input/cancelled`、`produces via Inbox.claimAtStepBoundary: user/message`、`consumes: all types (deriveMessages / deriveSearchText / reference derivation)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `CURRENT_FORMAT_VERSION` | 1 | `packages/core-session/src/index.ts:289` |
| `MAX_IMAGES_PER_MESSAGE (module-private)` | 20 | `packages/core-session/src/index.ts:342` |
| `MAX_IMAGE_BYTES_PER_MESSAGE` | 209715200 (200 * 1024 * 1024) | `packages/core-session/src/index.ts:343` |
| `IMAGE_MEDIA_TYPES` | image/png, image/jpeg, image/webp, image/gif | `packages/core-session/src/index.ts:341` |
| `SYSTEM_INPUT_PLUGIN` | "i-harness/system-input" | `packages/core-session/src/inbox.ts:19` |

**已知缺口（原始碼內標記）**

- migrate() is an explicit no-op placeholder: only v1 exists, so it throws for any other target and otherwise returns the session unchanged (packages/core-session/src/index.ts:682).
- Goal round admission is declared out of scope and the seam is empty: no `blocked` phase, no blockedReason, no maxGoalRounds default, no roundsStarted (packages/core-session/src/index.ts:144).
- Image byte migration out of the log is explicitly not done in v0: attachmentId coexists with inline bytes and dataBase64 stays required (packages/core-session/src/index.ts:181).

---

### `session-executor`

The engine-owned session assembly and its global service: one createSessionAssembly builds the entire per-session environment (tools, guards, sandbox/shell/fs, MCP/LSP/teams/workflow/skills, runtime-context, rewind, agent, budget/compaction wiring), and createSessionService owns get-or-create lifecycle, the per-session queue projection, the task projection and the single-turn submit path.

> npm `@i-harness/session-executor` · 入口 `packages/session-executor/src/index.ts` · 4 個原始檔 · 11 個匯出符號

**公開介面**：`createSessionAssembly`、`createSessionService`、`createDurableSessionLoader`、`SessionAssembly`、`AssemblyOptions`、`ModelPolicy`、`ModelUnavailableError`、`SessionService`、`SessionServiceOptions`、`SessionQueueItem`、`SessionModelBindingResult`、`AgentTaskStatus (re-export)`、`AgentTaskView (re-export)`、`ReasoningEffort (re-export)`、`not re-exported from packages/session-executor/src/index.ts but exported by packages/session-executor/src/assembly.ts: estimateAssemblyOverhead, bindAuthRefreshStatus, RewindAssemblyHandle`

**關鍵設計決策**

1. **ONE assembly implementation is shared by the one-shot headless run and the multi-turn web service. The model is resolved BEFORE any resource is mounted, a failed mount disposes the half-built assembly and rethrows, and dispose unmounts in reverse mount order best-effort.**
   - 理由：Two divergent assembly paths were the previous state; a single builder plus 'no partial assembly escapes' is what makes the two hosts behave identically.
   - 出處：`packages/session-executor/src/assembly.ts:1`、`packages/session-executor/src/assembly.ts:259`、`packages/session-executor/src/assembly.ts:702`
2. **Model policy defaults to production-safe `required`: an omitted modelPolicy with no explicit client throws ModelUnavailableError, and a mock is only built when the caller explicitly opts into "test-mock".**
   - 理由：A test double must never be reachable by omission in production.
   - 出處：`packages/session-executor/src/assembly.ts:85`、`packages/session-executor/src/assembly.ts:262`、`packages/session-executor/src/assembly.ts:65`
3. **Two-layer pacing with a stable public row id: the service creates the queue row id + a service-owned AbortController BEFORE its pacing chain (the caller signal is linked into it), then hands that same id through the A-region lane (lane.submit(..., id)). The queue projection merges service-front and lane rows by that public id, takes 'running' from the lane's currentInput (the lane is ground truth, the record's state can lag), and cancelQueued refuses to cancel a running row.**
   - 理由：One id per user-visible turn lets the queue surface, the lane and cancellation agree; consulting a lagging projection would abort a running turn and report a false success.
   - 出處：`packages/session-executor/src/service.ts:315`、`packages/session-executor/src/service.ts:378`、`packages/session-executor/src/service.ts:434`、`packages/session-executor/src/service.ts:506`
4. **getOrCreate is single-flight per session (one shared creation promise, hooks fire once inside it) and closeSession waits for the session's chain, build and model binding before disposing only that assembly; a later request resolves and builds again.**
   - 理由：Concurrent racers must not double-attach the approval/question bridge (a per-ctx registration) or build two assemblies for one session.
   - 出處：`packages/session-executor/src/service.ts:241`、`packages/session-executor/src/service.ts:546`
5. **Ownership of teardown is explicit: the assembly disposes what it mounted (mcp/lsp/team handles, skills, workflow, terminal, win32 ACL sandbox) but NEVER closes the coordinator or the telemetry stream — the owner does. Plugin MCP servers degrade with a warn + pluginMcpResults map, while core mounts fail loud.**
   - 理由：Shared resources must outlive one session; a plugin server this host cannot serve must not take the whole session down.
   - 出處：`packages/session-executor/src/assembly.ts:697`、`packages/session-executor/src/assembly.ts:506`
6. **The durable-session loader copies restored events WITHOUT running append hooks and attaches the coordinator write-behind only to new live events; a turn/end triggers a flush.**
   - 理由：Re-mirroring restored history would re-append the whole log and double-count; only new events are new.
   - 出處：`packages/session-executor/src/durable-session.ts:7`、`packages/session-executor/src/assembly.ts:394`

**失敗策略**：Fail-closed at the boundaries: missing/unconfigured model throws ModelUnavailableError (packages/session-executor/src/assembly.ts:262), submit rejects when the service is closed or the session is closing (packages/session-executor/src/service.ts:316), an unknown task id throws instead of silently succeeding (packages/session-executor/src/service.ts:594), and a lane drain rejection becomes the submit rejection (packages/session-executor/src/service.ts:397). Fail-open only for teardown: every unmount/dispose is individually try/catch'd and never throws (packages/session-executor/src/assembly.ts:702, packages/session-executor/src/service.ts:542).

**事件**：`user/message (CONSUMED via subscribe — rewind recorder anchor)`、`turn/end (CONSUMED via subscribe — rewind finalize + coordinator flush trigger)`、`telemetry (not SessionEvents): turn/start, provider/call, provider/error, tool/start, tool/end, tool/error, turn/end, token/usage, mcp/server-status, session/request, session/queued, session/error, compaction/attempt`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `shellTimeoutMs (default)` | 120000 | `packages/session-executor/src/assembly.ts:278` |
| `shell retention maxBytes (default)` | 64000 | `packages/session-executor/src/assembly.ts:304` |
| `mock default script` | [{ role: "assistant", text: "ok" }] | `packages/session-executor/src/assembly.ts:264` |

**已知缺口（原始碼內標記）**

- Rewind recording is append-onward only: the recorder subscription is wired after the live session exists, so host-seeded history is not recorded — documented in-code as 'a documented v1 scope' (packages/session-executor/src/assembly.ts:311).
- A journal bound to another workspace leaves rewind entirely OFF (no recorder, no fs pre-image sink), and the assembly.rewind handle stays absent — the host renders 'not enabled' (packages/session-executor/src/assembly.ts:325).
- estimateAssemblyOverhead and bindAuthRefreshStatus are exported from packages/session-executor/src/assembly.ts but NOT re-exported by packages/session-executor/src/index.ts, and package.json exposes only ".": a host outside the package cannot reach them (packages/session-executor/src/assembly.ts:212; packages/session-executor/src/index.ts:1).

---

### `session-persistence`

The persistence coordinator and its policy layer over a PersistenceBackend: session create/append/load/list/profile/updateMeta, write-behind batching, the load-time format-version and event-type gates, log-semantic tail repair, opt-in ownership leases, session fork and the harness-home path defaults.

> npm `@i-harness/session-persistence` · 入口 `packages/session-persistence/src/index.ts` · 5 個原始檔 · 23 個匯出符號

**公開介面**：`createSessionCoordinator`、`SessionCoordinator`、`CoordinatorOptions`、`PersistenceBackend`、`SessionMeta`、`SessionModelSelection`、`SessionWriteBehind`、`SessionWriteBehindOptions`、`SessionFormatUnsupportedError`、`SessionLockConflictError`、`SessionLockUnsupportedError`、`SessionForkUnavailableError`、`registerUpgrade`、`registerEventType`、`resolveHarnessHome`、`resolveSessionStoreRoot`、`repairTurnTail`、`TOOL_ABORTED_BEFORE_DISPATCH`、`TOOL_ABORTED_RECOVERY_RESULT`、`forkSession`、`completedTurnPrefix`、`ForkSessionOptions`、`ForkSessionResult`

**關鍵設計決策**

1. **Version refusal happens BEFORE any repair: load reads, runs assertVersionSupported (refuse newer-than-build; refuse a hole in the upgrade chain), and only then calls backend.repair — because read is non-destructive while repair may truncate and rewrite a foreign-version file.**
   - 理由：The one operation that can destroy data must be unreachable for a file this build does not understand.
   - 出處：`packages/session-persistence/src/index.ts:375`、`packages/session-persistence/src/index.ts:455`
2. **Two load flavours with different invariants: load() is READ-ONLY and only canonicalizes undefined seqs (max(index, maxDefined+1+k), uniqueness prioritized OVER monotonicity so shadowedSeqs/rewind/messageSeqs references never alias); loadOwned() enforces seq === index strictly, persists the repair through replaceEvents, and fails closed when the backend cannot rewrite.**
   - 理由：A resumed writable session must satisfy the seq===index invariant the append path assumes, while an ordinary read must never mutate the file.
   - 出處：`packages/session-persistence/src/index.ts:470`、`packages/session-persistence/src/index.ts:505`
3. **The load gate refuses unknown event types unless they carry ignorable:true (deprecated and dropped) or were registered via registerEventType; the package registers its own set of new event types at module init so a persistence-only path still loads team/*, todo/write, goal/change, job/status, schedule/change, agent/input/*, session/title, plan/mode, subagent/*, reasoning, command/* and rewind/point. rewind/point is deliberately NOT ignorable, because dropping it would silently resurrect rewound turns.**
   - 理由：core-session must stay dependency-free, so the load gate has to own the vocabulary; 'ignore what you do not know' would be data loss for hide-markers.
   - 出處：`packages/session-persistence/src/index.ts:157`、`packages/session-persistence/src/index.ts:392`、`packages/session-persistence/src/index.ts:216`
4. **Write-behind is fixed-deadline batching with failure retention and an explicit quiescence barrier: on a failed write the batch is put back at the FRONT of the queue and the automatic timer is paused until new work arrives; flush() cancels the wait and drains through a barrier that never rejects the producer.**
   - 理由：A background write failure must not lose events nor spin; a producer must never be failed by durability it did not await.
   - 出處：`packages/session-persistence/src/write-behind.ts:40`、`packages/session-persistence/src/write-behind.ts:121`、`packages/session-persistence/src/write-behind.ts:104`
5. **Ownership lease is opt-in (lock.enabled defaults false; the CLI wiring turns it on), mutating paths run under it while readers (list/getDocument/profile) never lock, acquisition is single-flight per session, and ALL backend mutations for one session are linearized through a per-session operation chain whose gate promise never rejects.**
   - 理由：Two concurrent mutating paths in one process would otherwise conflict against each other's OS-level exclusive lock and fail closed spuriously.
   - 出處：`packages/session-persistence/src/index.ts:240`、`packages/session-persistence/src/index.ts:277`、`packages/session-persistence/src/index.ts:324`
6. **Log-semantic repair is a separate PURE, DETERMINISTIC, TAIL-ONLY layer above the backend's structural repair: it adds a synthetic TOOL_ABORTED_BEFORE_DISPATCH tool/result for every unmatched tool/call in the LAST turn and closes an open step/turn. Earlier turns are never touched and the input array is never mutated.**
   - 理由：A crash mid-tool otherwise replays assistant(toolCalls) with no tool responses, which breaks Messages-API alternation on continue; purity keeps the raw log replayable byte-for-byte.
   - 出處：`packages/session-persistence/src/repair.ts:1`、`packages/session-persistence/src/repair.ts:63`、`packages/session-persistence/src/repair.ts:25`
7. **Fork seeds a completed-turn prefix and applies the SOURCE's own hidden-region semantics: the rewind windows are extended back to the anchor turn's turn/start, rewind/point markers are DROPPED (a copied marker would assert a phantom cut over events the child never had), compaction markers are KEPT, and the kept events are renumbered with shadowedSeqs/removedSeqs/messageSeqs remapped into child coordinates.**
   - 理由：The child must see exactly what the parent's model saw; copying markers verbatim would resurrect or falsely hide turns in the child's own coordinate space.
   - 出處：`packages/session-persistence/src/fork.ts:99`、`packages/session-persistence/src/fork.ts:164`、`packages/session-persistence/src/fork.ts:87`

**失敗策略**：Mixed and deliberate. Fail-closed: unsupported/newer format and missing upgrade path throw SessionFormatUnsupportedError (packages/session-persistence/src/index.ts:360), unknown event types without the ignorable marker are refused (packages/session-persistence/src/index.ts:392), a lock conflict throws SessionLockConflictError rather than queueing (packages/session-persistence/src/index.ts:236), and loadOwned fails closed when the backend lacks replaceEvents (packages/session-persistence/src/index.ts:525). Fail-open/by-report: documents report but never reject the caller (packages/session-persistence/src/index.ts:573), close() is best-effort allSettled (packages/session-persistence/src/index.ts:558), and background flush failures go to reportBackgroundFailure (packages/session-persistence/src/index.ts:324).

**事件**：`tool/result (synthetic TOOL_ABORTED_BEFORE_DISPATCH recovery result, PRODUCED by repair)`、`step/end (synthetic closer, PRODUCED by repair)`、`turn/end (synthetic closer, PRODUCED by repair)`、`load gate CONSUMES every event type: builtin KNOWN_EVENT_TYPES + registerEventType registrations, else refused unless ignorable:true`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `maxDelayMs (write-behind default)` | 200 | `packages/session-persistence/src/index.ts:227` |
| `lock.enabled (default)` | false (opt-in) | `packages/session-persistence/src/index.ts:240` |
| `TOOL_ABORTED_BEFORE_DISPATCH` | "TOOL_ABORTED_BEFORE_DISPATCH" | `packages/session-persistence/src/repair.ts:25` |
| `TOOL_ABORTED_RECOVERY_RESULT` | { error: "tool call aborted before dispatch", code: TOOL_ABORTED_BEFORE_DISPATCH } | `packages/session-persistence/src/repair.ts:29` |

**已知缺口（原始碼內標記）**

- The upgrade chain is empty by design: registerUpgrade is exported but nothing in-tree registers an upgrade, because only v1 exists (packages/session-persistence/src/index.ts:150).
- SessionWriteBehind is exported but only used inside this package (packages/session-persistence/src/index.ts:324); no other src consumer in-tree.
- Ownership-lease support is Windows-only in M23: SessionLockUnsupportedError is thrown off-Windows (packages/session-persistence/src/index.ts:129).

---

### `session-persistence-jsonl`

The JSONL on-disk PersistenceBackend: one file per session (header line + one JSON event per line) with create/append/read/list/repair/replaceEvents/profile/updateMeta, plus an atomic keyed document sidecar store.

> npm `@i-harness/session-persistence-jsonl` · 入口 `packages/session-persistence-jsonl/src/index.ts` · 2 個原始檔 · 1 個匯出符號

**公開介面**：`createJsonlBackend`、`internal (not exported from index.ts): serializeHeader, parseHeader, parseEventLines, hasTornTail, replaceSessionFile, readHeader, missingClosers, BLANK_PROBE_MAX_BYTES, HEADER_READ_MAX_BYTES`

**關鍵設計決策**

1. **Format is header line 0 (JSON SessionMeta) + one JSON event per line; parsing takes the contiguous committed prefix and stops at the first unparsable line, while hasTornTail separately detects a torn final line. This backend owns structural repair (truncate + append synthetic step/end, turn/end closers) — the semantic tool-result repair lives in session-persistence.**
   - 理由：A crash mid-write must yield a loadable prefix rather than a parse failure, and the two repair layers have clearly split responsibilities.
   - 出處：`packages/session-persistence-jsonl/src/format.ts:48`、`packages/session-persistence-jsonl/src/index.ts:110`、`packages/session-persistence-jsonl/src/index.ts:209`
2. **Durability discipline: every whole-file rewrite is temp file (wx) + write + fsync + rename, with best-effort directory fsync; append writes at the committed byte offset and, on failure, truncates back to the previous committed size and re-syncs so a clean retry can never duplicate seqs.**
   - 理由：The log is the authority; a duplicate or half-written line corrupts every later seq reference.
   - 出處：`packages/session-persistence-jsonl/src/index.ts:14`、`packages/session-persistence-jsonl/src/index.ts:73`
3. **Path safety is enforced in one artifactPath helper: an id is rejected when it is posix-absolute, has a win32 root, or resolves outside the store root — so session ids and document keys can never escape the store. Document keys may be namespaced subdirectories, and list() skips *.doc.jsonl plus transient *.tmp.**
   - 理由：Ids come from hosts and callers; path traversal would turn a session read into an arbitrary file read/write.
   - 出處：`packages/session-persistence-jsonl/src/index.ts:44`、`packages/session-persistence-jsonl/src/index.ts:102`、`packages/session-persistence-jsonl/src/index.ts:168`
4. **profile() is honest-bounding rather than exact: an artifact at or under 1024 bytes is read whole for the exact blank answer (no turn/start yet); a larger one is served blank:false WITHOUT reading the body, and its header is read from a capped 64 KiB window on line 0.**
   - 理由：A cold list of many multi-megabyte logs must not decode every body; the trade is stated as 'may have content, never guessed blank'.
   - 出處：`packages/session-persistence-jsonl/src/index.ts:8`、`packages/session-persistence-jsonl/src/index.ts:133`、`packages/session-persistence-jsonl/src/index.ts:190`
5. **updateMeta replaces ONLY line 0 (temp + rename) keeping every event line byte-exact, and parseHeader explicitly preserves workspaceId/title/modelSelection through read AND repair — a repair must never silently strip a session's model selection or workspace membership.**
   - 理由：A header rewrite is a metadata operation, not a log operation; dropping unknown header fields would silently change model resolution after a crash.
   - 出處：`packages/session-persistence-jsonl/src/index.ts:148`、`packages/session-persistence-jsonl/src/format.ts:8`

**失敗策略**：Fail-closed on writes: an append failure rolls back to the committed byte length and rethrows (packages/session-persistence-jsonl/src/index.ts:82), create uses flag wx so an existing session file is never overwritten (packages/session-persistence-jsonl/src/index.ts:67), an empty/headerless file throws (packages/session-persistence-jsonl/src/index.ts:96), and an out-of-root id throws (packages/session-persistence-jsonl/src/index.ts:53). Reads are tolerant by design (torn tail truncated to the committed prefix) and the blank probe never guesses.

**事件**：`step/end (synthetic closer PRODUCED by repair)`、`turn/end (synthetic closer PRODUCED by repair)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `BLANK_PROBE_MAX_BYTES` | 1024 | `packages/session-persistence-jsonl/src/index.ts:12` |
| `HEADER_READ_MAX_BYTES` | 65536 (64 * 1024) | `packages/session-persistence-jsonl/src/index.ts:193` |
| `backend capabilities` | { seekableRead: false, rawArtifacts: true } | `packages/session-persistence-jsonl/src/index.ts:63` |

**已知缺口（原始碼內標記）**

- None marked in code. The 1024-byte blank-probe boundary is a deliberate approximation, stated in-code as honest-bounding (packages/session-persistence-jsonl/src/index.ts:8) rather than as unfinished work.

---

### `session-query`

Full-text session search and lineage over the durable JSONL store: an independent, rebuildable sqlite FTS index reconciled before every read, the two model-facing tools (session_search, lineage), a process warning filter, and a legacy read-only opener for old index files.

> npm `@i-harness/session-query` · 入口 `packages/session-query/src/index.ts` · 4 個原始檔 · 14 個匯出符號

**公開介面**：`createFileBackedSessionQuery`、`createSessionQuery`、`createSessionQueryTools`、`closeSessionQueries`、`SessionQuery`、`SessionQueryError`、`SearchHit`、`SearchOptions`、`LineageNode`、`LineageOptions`、`InspectOutcome`、`FileBackedQueryOptions`、`suppressSqliteExperimentalWarning`、`isSqliteExperimentalWarning`

**關鍵設計決策**

1. **Reconcile-on-search with the JSONL store as sole authority: snapshot the store (readdir + stat revision dev:ino:size:mtimeNs:ctimeNs), diff against indexed_sessions, SKIP unchanged sessions without re-reading the file, and rebuild changed/removed sessions in one BEGIN IMMEDIATE txn each (delete + insert docs/lineage + fingerprint). A content fingerprint (sha256 of exactly the bytes that produced the rows) catches stat-only changes and just advances the revision.**
   - 理由：The index is a derivation, never a second truth; the cheapest correct answer to 'did this change' is the revision, and the fingerprint is the tie-breaker.
   - 出處：`packages/session-query/src/file-backed.ts:236`、`packages/session-query/src/file-backed.ts:366`
2. **Fail loud instead of serving stale rows: any scan/read/decode failure raises SessionQueryError with code SESSION_QUERY_OBSERVE_FAILED; a foreign index (application_id mismatch or newer schema) raises SESSION_QUERY_INDEX_FOREIGN and is never touched. A write that races the read is re-observed up to STABLE_OBSERVATION_ATTEMPTS times, then fails.**
   - 理由：Silently returning rows from a torn/partial index is the failure mode being designed out; the index is disposable, so refusing is cheap.
   - 出處：`packages/session-query/src/file-backed.ts:48`、`packages/session-query/src/file-backed.ts:141`、`packages/session-query/src/file-backed.ts:383`
3. **The index is self-describing and disposable: PRAGMA application_id 0x49485155 ("IHQU") + user_version 1, and a version mismatch WITH our own identity resets and rebuilds the derived tables instead of migrating them.**
   - 理由：A derived index needs no migration path — only an identity check to avoid clobbering someone else's database.
   - 出處：`packages/session-query/src/file-backed.ts:40`、`packages/session-query/src/file-backed.ts:121`
4. **Query safety is by construction: every whitespace token of the user query becomes a quoted FTS phrase with embedded quotes doubled (so *, OR, NEAR, parentheses are literal text), and the limit is clamped into [1, MAX_LIMIT] with a non-integer rejected. Reconciles are serialized through a single-flight chain, and every opened DatabaseSync is tracked so hosts/tests can release handles on Windows.**
   - 理由：A model-supplied query string must not be able to express FTS syntax; concurrent reconciles must not interleave transactions.
   - 出處：`packages/session-query/src/file-backed.ts:402`、`packages/session-query/src/file-backed.ts:469`、`packages/session-query/src/index.ts:48`
5. **The node:sqlite ExperimentalWarning is suppressed by a capture-and-redrive module side effect that must evaluate BEFORE node:sqlite: existing `warning` listeners are removed and re-driven from a filter that drops exactly that one warning and forwards everything else. Importing index.ts or file-backed.ts installs it.**
   - 理由：Node's default warning printer is itself a bootstrap listener, so merely adding a listener filters nothing; ordering is guaranteed by ESM dependency evaluation.
   - 出處：`packages/session-query/src/warning.ts:1`、`packages/session-query/src/warning.ts:53`、`packages/session-query/src/index.ts:1`

**失敗策略**：Fail-closed: stale rows are never served — observe failures and foreign/ newer index files throw typed errors (packages/session-query/src/file-backed.ts:48), an unknown session in lineage/search-with-sessionId throws (packages/session-query/src/file-backed.ts:419), a lineage cycle throws (packages/session-query/src/file-backed.ts:520), and the legacy opener throws when the events_fts schema is absent (packages/session-query/src/index.ts:93). The only fail-open cases are a missing store directory (ENOENT → empty result, packages/session-query/src/file-backed.ts:266) and a zero-byte file (skipped until its header is written, packages/session-query/src/file-backed.ts:283).

**事件**：`all event types are CONSUMED as text through core-session's deriveSearchText (index only); produces no SessionEvents`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_LIMIT` | 20 | `packages/session-query/src/index.ts:58` |
| `MAX_LIMIT` | 100 | `packages/session-query/src/index.ts:59` |
| `STABLE_OBSERVATION_ATTEMPTS` | 2 | `packages/session-query/src/file-backed.ts:46` |
| `INDEX_DB_APPLICATION_ID` | 0x49485155 ("IHQU") | `packages/session-query/src/file-backed.ts:40` |
| `INDEX_DB_SCHEMA_VERSION` | 1 | `packages/session-query/src/file-backed.ts:41` |
| `busy_timeout` | 5000 ms | `packages/session-query/src/file-backed.ts:146` |
| `snippet token budget` | 12 | `packages/session-query/src/file-backed.ts:488` |

**已知缺口（原始碼內標記）**

- The SQLite persistence backend is gone; createSessionQuery(dbPath) survives only as a READ-ONLY opener for existing/legacy index files over the old events_fts+sessions schema, and has no in-tree production caller (only packages/session-query/test/query.test.ts) — packages/session-query/src/index.ts:241.
- closeSessionQueries is declared as a host/test handle-release surface; its only in-tree callers are this package's own tests (packages/session-query/src/index.ts:48).
- SearchHit.time is NOT a recency signal: the JSONL log carries no per-event timestamp, so the file-backed index records the INDEX-REBUILD time for every row, and an unchanged row gets a new value on every re-index (packages/session-query/src/index.ts:12, packages/session-query/src/file-backed.ts:326).

---

### `session-title`

Derive and persist a short session title: a deterministic word-count fallback, a one-shot provider suggestion, append of a session/title log event, and a best-effort document mirror for list screens.

> npm `@i-harness/session-title` · 入口 `packages/session-title/src/index.ts` · 1 個原始檔 · 7 個匯出符號

**公開介面**：`TITLE_MAX_BYTES`、`TITLE_MAX_WORDS`、`fallbackTitle`、`normalizeTitle`、`suggestTitle`、`applyTitle`、`maybeAutoTitle`

**關鍵設計決策**

1. **Provider suggestion is fail-soft by construction: any stream error, any thrown error and an empty/whitespace provider output all degrade to the deterministic fallback (first maxWords whitespace words, ellipsis when truncated) — the function has a catch that returns source "fallback".**
   - 理由：A title is cosmetic; it must never fail a turn or block auto-titling.
   - 出處：`packages/session-title/src/index.ts:46`、`packages/session-title/src/index.ts:15`
2. **Only REAL user messages are eligible inputs: any user/message carrying a `source` (runtime-context snapshots, plugin/system injections) is excluded, so dynamic context can never become the session title.**
   - 理由：The runtime-context snapshot is a plugin-sourced user message and would otherwise win the title.
   - 出處：`packages/session-title/src/index.ts:32`
3. **Dual persistence: the durable title is a session/title event (latest-wins projection deriveSessionTitle) while a namespaced document ("session-title/<id>") is a best-effort mirror for the list screen; the mirror write is fired and caught so a coordinator failure never rejects the caller.**
   - 理由：The log is the truth for resume; the document exists only to make a session list cheap.
   - 出處：`packages/session-title/src/index.ts:68`、`packages/session-title/src/index.ts:81`
4. **Auto-titling is idempotent and guarded: it returns early when a title already exists, returns when there are no eligible user messages, and byte-caps the normalized title (trim ends only; internal whitespace preserved).**
   - 理由：Re-titling an already-titled session would churn the log and the mirror.
   - 出處：`packages/session-title/src/index.ts:91`、`packages/session-title/src/index.ts:24`

**失敗策略**：Fail-soft throughout: provider failure → deterministic fallback (packages/session-title/src/index.ts:63); the coordinator document write is `.catch(() => {})` and session-persistence's putDocument itself reports rather than rejects (packages/session-title/src/index.ts:86). No throwing path except the underlying append validation of the session/title event.

**事件**：`session/title (PRODUCED by applyTitle)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `TITLE_MAX_BYTES` | 120 | `packages/session-title/src/index.ts:6` |
| `TITLE_MAX_WORDS` | 8 | `packages/session-title/src/index.ts:7` |
| `provider input cap` | 4000 chars (slice) | `packages/session-title/src/index.ts:51` |
| `fallback title when no words` | "New session" | `packages/session-title/src/index.ts:17` |

**已知缺口（原始碼內標記）**

- The in-code comment labels this 'First-prompt mode (roadmap)' — the implementation is present and wired from apps/cli/src/run.ts, but the milestone framing is a roadmap note rather than a shipped-feature claim (packages/session-title/src/index.ts:72).
- suggestTitle/fallbackTitle/applyTitle have no in-tree src caller outside this package; only maybeAutoTitle is wired (apps/cli/src/run.ts).

---

### `runtime-context`

Dynamic system context as a durable snapshot: named sections rendered at each agent/pre-step and appended to the session log as a plugin-sourced user/message only when the rendered text changed.

> npm `@i-harness/runtime-context` · 入口 `packages/runtime-context/src/index.ts` · 1 個原始檔 · 6 個匯出符號

**公開介面**：`createRuntimeContext`、`installRuntimeContext`、`RuntimeContextService`、`ContextSection`、`RUNTIME_CONTEXT_SOURCE_PLUGIN`、`RUNTIME_CONTEXT_CLEARED`

**關鍵設計決策**

1. **Dynamic context goes into the LOG, not the system prompt: the host's static prompt stays the baseline and each change lands as a plugin-sourced user/message, so it is model-visible, replayable and durable through the session's own coordinator mirror.**
   - 理由：Log-resident context is the only form that survives resume and is visible to the same projection (deriveMessages) the meter and compaction price.
   - 出處：`packages/runtime-context/src/index.ts:16`、`packages/runtime-context/src/index.ts:50`
2. **Change-only append with a representable empty state: an unchanged render appends nothing, and an empty render appends the explicit RUNTIME_CONTEXT_CLEARED notice — so 'nothing applies any more' is itself a value that dedupes and tells the model earlier snapshots are void.**
   - 理由：Without the cleared notice, stale context would remain the last word the model saw.
   - 出處：`packages/runtime-context/src/index.ts:46`、`packages/runtime-context/src/index.ts:5`
3. **Replay on create: the service scans the log backwards for the last plugin-sourced user/message from this package and adopts its text as `retained`, so a resumed session keeps the same snapshot without re-appending.**
   - 理由：Reconstruction from the log is what makes the snapshot idempotent across restarts.
   - 出處：`packages/runtime-context/src/index.ts:27`
4. **Snapshots are marked `internal: true`: model-visible but not a user-facing turn, so the scrollback skips them while deriveMessages keeps them.**
   - 理由：The model needs the context; the user must not see 'Current runtime context: none' as if they had typed it.
   - 出處：`packages/runtime-context/src/index.ts:57`、`packages/core-session/src/index.ts:9`

**失敗策略**：Fail-closed only on duplicate section names (packages/runtime-context/src/index.ts:63); the render path itself is append-only and has no swallow — a failing section getter or an invalid append propagates. No try/catch in the module.

**事件**：`user/message (PRODUCED, with source { kind: "plugin", plugin: "i-harness/runtime-context" })`、`agent/pre-step (CONSUMED — PluginContext event, not a SessionEvent)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `RUNTIME_CONTEXT_SOURCE_PLUGIN` | "i-harness/runtime-context" | `packages/runtime-context/src/index.ts:5` |
| `RUNTIME_CONTEXT_CLEARED` | "Current runtime context: none. Earlier runtime-context snapshots no longer apply." | `packages/runtime-context/src/index.ts:6` |

**已知缺口（原始碼內標記）**

- None marked in code. Nothing in the package enforces a size cap on a snapshot; the sections it renders are expected to bound themselves (instructions does so with DEFAULT_INSTRUCTIONS_MAX_BYTES).

---

### `instructions`

Discover and load AGENTS.md / CLAUDE.md instruction files and render them as one runtime-context section, with a byte cap and an mtime/size-keyed cache.

> npm `@i-harness/instructions` · 入口 `packages/instructions/src/index.ts` · 2 個原始檔 · 6 個匯出符號

**公開介面**：`createInstructionsSection`、`discoverInstructionPaths`、`loadInstructionFiles`、`renderInstructions`、`InstructionsConfig`、`DEFAULT_INSTRUCTIONS_MAX_BYTES`

**關鍵設計決策**

1. **Discovery precedence is global first, then workspace ancestors root→workspace, so the closest file renders LAST (most salient). A directory contributes AT MOST ONE candidate, AGENTS.md preferred over CLAUDE.md; globals are looked for in ~ and ~/.claude.**
   - 理由：Rendering order is the only salience signal a text section has; one-file-per-directory keeps the section from doubling when both names exist.
   - 出處：`packages/instructions/src/files.ts:13`、`packages/instructions/src/files.ts:7`
2. **The section is rendered with a per-file `### <workspace-relative path>` header, joined blank-line separated, and hard-capped at maxBytes with a `(truncated)` suffix.**
   - 理由：Bounded prompt cost for an unbounded set of on-disk files.
   - 出處：`packages/instructions/src/index.ts:24`、`packages/instructions/src/index.ts:9`、`packages/instructions/src/index.ts:47-50`、`packages/instructions/src/files.ts:64`、`packages/instructions/src/index.ts:48`
3. **The getter is SYNCHRONOUS because the runtime-context pre-step render seam is sync, and it caches by (file list \| max mtimeMs \| total size): an unchanged tree costs one stat per file per step boundary and no re-read.**
   - 理由：Change detection has to fit a synchronous render hook; mtime+size is the cheapest honest proxy.
   - 出處：`packages/instructions/src/index.ts:17`

**失敗策略**：Fail-closed on real read errors: loadInstructionFiles rethrows anything that is not ENOENT/ENOTDIR (packages/instructions/src/files.ts:57). Fail-open on stat: a statSync failure is swallowed and falls through to a full re-read on the next call (packages/instructions/src/index.ts:35). Discovery uses existsSync, so a file that vanishes between stat and read is skipped, not fatal.

**事件**：`none (consumed only as a runtime-context section getter; produces no SessionEvents)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_INSTRUCTIONS_MAX_BYTES` | 24000 | `packages/instructions/src/index.ts:9` |
| `CANDIDATES` | ["AGENTS.md", "CLAUDE.md"] | `packages/instructions/src/files.ts:7` |

**已知缺口（原始碼內標記）**

- Change detection is acknowledged as a future item in-code: the mtime/size compare is described as covering 'the roadmap's 變更檢測可後補 note' via runtime-context's snapshot-diff dedupe (packages/instructions/src/index.ts:20) — i.e. a content change that preserves mtime AND total size is not detected.
- The package declares no dedicated context-section event; it is consumed only as a runtime-context section getter from the assembly (packages/session-executor/src/assembly.ts:445).

---

### `interaction`

The interaction seams between host and engine: the approval answerer, the user-question provider, the command registry (register / run / list / parse) and the model-facing ask_user_input tool.

> npm `@i-harness/interaction` · 入口 `packages/interaction/src/index.ts` · 1 個原始檔 · 19 個匯出符號

**公開介面**：`registerApprovalAnswerer`、`ApprovalAnswerer`、`ApprovalRequest`、`ApprovalDecision`、`registerQuestionProvider`、`QuestionProvider`、`UserQuestion`、`askUser`、`registerCommand`、`runCommand`、`listCommands`、`listCommandNames`、`parseCommandLine`、`Command`、`CommandDescriptor`、`ParsedCommandLine`、`createAskUserInputTool`、`registerAskUserInput`、`AskUserInputToolDeps`

**關鍵設計決策**

1. **The approval seam is normalized to a BOOLEAN at registration: the plugin service stores `async (req) => (await fn(req)).approved`, so a host implementing the richer {approved} shape can never fail open by returning a truthy object.**
   - 理由：core-tools checks `if (!ok) throw`; a truthy object would be read as consent and a user denial would be ignored.
   - 出處：`packages/interaction/src/index.ts:21`、`packages/interaction/src/index.ts:5`
2. **askUser is deliberately NOT async so a missing provider throws SYNCHRONOUSLY (NO_PROVIDER): callers that guard the call see the failure without awaiting, and the registered provider's ask still returns a Promise.**
   - 理由：A rejected promise is easy to forget to handle; a synchronous throw at the guard is fail-closed by construction.
   - 出處：`packages/interaction/src/index.ts:46`、`packages/interaction/src/index.ts:137`
3. **One command-name grammar is shared by registration, parsing and listing: ^[a-z][a-z0-9_-]*$ is enforced as a TypeError at registration, and parseCommandLine parses the same alphabet (with an optional leading slash for the web palette) and returns the rest of the line as the handler input.**
   - 理由：A name that fails the grammar could be registered and listed but never executed — the grammar has to be identical on both sides.
   - 出處：`packages/interaction/src/index.ts:84`、`packages/interaction/src/index.ts:194`
4. **Commands are UI-plane: dispatched through their own registry in the plugin services map (lazily created on first registration), results returned directly to the caller and NEVER fed into model history. runCommand is fail-loud on an unknown command while listCommands returns [] for a legal empty registry.**
   - 理由：The audit ruling (F05-6) is that a command result must not become model context.
   - 出處：`packages/interaction/src/index.ts:59`、`packages/interaction/src/index.ts:172`

**失敗策略**：Fail-closed: a missing question provider throws synchronously (NO_PROVIDER, packages/interaction/src/index.ts:49), registerCommand throws TypeError on a bad name (packages/interaction/src/index.ts:84), runCommand throws on an unknown command (packages/interaction/src/index.ts:102), and the approval answerer is boolean-normalized (packages/interaction/src/index.ts:26). Fail-open only for discovery/listing, which returns [] rather than throwing (packages/interaction/src/index.ts:167).

**事件**：`consumes no SessionEvents; core-session declares command/run and command/done as appended by the EXECUTING HOST, not by this package (packages/core-session/src/index.ts:113)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `ask_user_input timeoutMs (default)` | 600000 | `packages/interaction/src/index.ts:134` |
| `options maxItems` | 10 | `packages/interaction/src/index.ts:130` |
| `COMMAND_NAME grammar` | ^[a-z][a-z0-9_-]*$ | `packages/interaction/src/index.ts:78` |

**已知缺口（原始碼內標記）**

- listCommandNames has no in-tree src caller (only packages/interaction/test/commands.test.ts:3) — it is a host-facing discovery surface (packages/interaction/src/index.ts:184).

---

### `plan-mode`

The R-A7 plan-mode surface: the plan-mode system-prompt fragment, enter/exit helpers that append plan/mode log markers, and the exit_plan_mode tool plus its mount/withdraw helpers.

> npm `@i-harness/plan-mode` · 入口 `packages/plan-mode/src/index.ts` · 1 個原始檔 · 6 個匯出符號

**公開介面**：`PLAN_MODE_SYSTEM_PROMPT`、`enterPlanMode`、`exitPlanMode`、`createPlanModeTools`、`ensurePlanModeTool`、`withdrawPlanModeTool`

**關鍵設計決策**

1. **Mode is log state, not process state: entering appends { plan/mode, mode:"on", proposal } AND the proposal as a regular user/message (so the model sees the plan request), and the projection is latest-wins via derivePlanMode.**
   - 理由：A log-only mode marker makes plan mode survive resume and keeps attribution (the proposal) on the marker while the model-visible text stays a normal user turn.
   - 出處：`packages/plan-mode/src/index.ts:10`、`packages/core-session/src/index.ts:97`、`packages/core-session/src/index.ts:594`
2. **Exit is soft and idempotent: exitPlanMode returns false when plan mode is not active instead of throwing, and the tool reports { active: exitPlanMode(session) }.**
   - 理由：A model may call exit_plan_mode twice or when never in plan mode; that is not an error condition.
   - 出處：`packages/plan-mode/src/index.ts:15`、`packages/plan-mode/src/index.ts:21`
3. **The tool is mounted idempotently by name (ensurePlanModeTool checks tools.get first) and can be withdrawn by name, so a host can toggle plan mode on one registry without duplicating the tool.**
   - 理由：Registry duplication would surface two identical tools to the model.
   - 出處：`packages/plan-mode/src/index.ts:31`
4. **The prompt fragment is a standalone exported constant composed by the assembly on top of the base/system preset prompt, not carried by the mode event.**
   - 理由：The prompt is per-assembly configuration; the event is per-session state.
   - 出處：`packages/plan-mode/src/index.ts:5`、`packages/session-executor/src/assembly.ts:597`

**失敗策略**：Fail-soft: no throw anywhere except the underlying append validation (invalid session event). exitPlanMode answers false instead of raising (packages/plan-mode/src/index.ts:15).

**事件**：`plan/mode (PRODUCED, mode on|off)`、`user/message (PRODUCED on enter — the proposal text)`

**已知缺口（原始碼內標記）**

- withdrawPlanModeTool has no in-tree caller (only the declaration at packages/plan-mode/src/index.ts:36); plan mode is mounted by the assembly but never withdrawn there.

---

### `goal`

The goal domain: a last-wins goal projection folded from goal/change session events, plus pure CAS mutation planning (create/edit/pause/resume/complete/clear) returning the durable event and the next view.

> npm `@i-harness/goal` · 入口 `packages/goal/src/index.ts` · 1 個原始檔 · 7 個匯出符號

**公開介面**：`GoalView`、`GoalStateError`、`GoalStateErrorCode`、`GoalMutationRequest`、`GoalMutationResult`、`foldGoal`、`applyGoalMutation`

**關鍵設計決策**

1. **Whole-snapshot events with a tombstone clear: every non-clear mutation carries the COMPLETE post-change goal (id, revision, objective, phase, optional maxGoalRounds) so the projection is a pure last-wins replay and there is no separate state store; a clear carries only a tombstone GoalRef and projects to null.**
   - 理由：The event IS the change (DSH goal parity): replay alone rebuilds the state, and a snapshot cannot drift from a log of deltas.
   - 出處：`packages/goal/src/index.ts:141`、`packages/goal/src/index.ts:108`、`packages/goal/src/index.ts:166`
2. **Mutations are PURE planners: applyGoalMutation never mutates its input and never appends — it returns { event, next } and the caller owns the log. CAS is mandatory: every mutation needs a ref matching the current id AND revision, else GoalStateError("goal-stale-ref").**
   - 理由：Separating planning from the log keeps the domain testable and makes the compare-and-set the only concurrency control (revision is bumped on every change).
   - 出處：`packages/goal/src/index.ts:192`、`packages/goal/src/index.ts:151`、`packages/goal/src/index.ts:72`
3. **Typed error codes form the host contract: goal-invalid / goal-exists / goal-none / goal-stale-ref / goal-invalid-transition, with the route owning the HTTP status mapping. On create, field validation precedes the state check (DSH parity), and a COMPLETED goal may be replaced while any other phase must be cleared or resumed.**
   - 理由：The domain refuses to know about HTTP; the codes are the stable boundary.
   - 出處：`packages/goal/src/index.ts:48`、`packages/goal/src/index.ts:196`
4. **Projection is defensive by posture, mutation is strict: a malformed or unknown goal/change event (bad revision, blank objective, unknown phase, malformed tombstone) leaves the projection unchanged rather than throwing, because a corrupted persisted log must not crash the fold; the write side is where validity is enforced.**
   - 理由：Same asymmetry as core-session: strict writes, forgiving reads.
   - 出處：`packages/goal/src/index.ts:141`

**失敗策略**：Fail-closed for mutations: every invalid request throws a typed GoalStateError (packages/goal/src/index.ts:152). Fail-safe for projection: malformed events return `undefined` and are skipped, a malformed clear tombstone keeps the previous view (packages/goal/src/index.ts:108).

**事件**：`goal/change (PRODUCED as the returned event to append; CONSUMED by foldGoal)`

**已知缺口（原始碼內標記）**

- Goal round admission is declared NOT implemented in v0: no goal enforcement, no turn-count logic; GoalView.round exists only as a wire-vocabulary seam and is never populated (packages/goal/src/index.ts:35).
- The domain is a documented simplification of DSH: no `blocked` phase / blockedReason and no mandatory maxGoalRounds (packages/goal/src/index.ts:6).

---

### `token-meter`

The token-estimation single source of truth: fixed-density per-message/content estimates and the context-budget check used by both the agent's overflow ladder and the compaction pressure gate.

> npm `@i-harness/token-meter` · 入口 `packages/token-meter/src/index.ts` · 4 個原始檔 · 9 個匯出符號

**公開介面**：`estimateMessage`、`estimateContent`、`activeTokens`、`breakdown`、`checkBudget`、`TokenBreakdown`、`BudgetResult`、`CHARS_PER_TOKEN`、`BLOCK_OVERHEAD`、`ROLE_OVERHEAD`、`IMAGE_TOKEN_ESTIMATE`

**關鍵設計決策**

1. **Single projection rule: activeTokens/breakdown price exactly deriveMessages(session) — what the model actually sees — and never touch raw events. Shadowed (compaction/reset), rewound and pruned events therefore cost nothing automatically, with no second hiding implementation.**
   - 理由：Any other measurement would disagree with the prompt and make the budget gate wrong precisely when it matters.
   - 出處：`packages/token-meter/src/breakdown.ts:10`
2. **Fixed-density heuristics with explicit asymmetry: chars/4; a plain assistant string pays role overhead only, a message with toolCalls pays block overhead for its content and per-call name+args pricing; a multi-part user/tool message pays per-part block overhead and a flat per-image estimate.**
   - 理由：The estimate must be stable and cheap (no tokenizer dependency); the asymmetries mirror how the providers actually count a bare assistant turn versus a structured one.
   - 出處：`packages/token-meter/src/estimate.ts:12`、`packages/token-meter/src/estimate.ts:3`
3. **Two estimators with different jobs: estimateMessage prices a full wire message (role+block overhead) while compaction's approxTokens prices a single content blob (ceil(chars/4), no overhead) — the module that needs a blob price must not reuse the message price.**
   - 理由：Region selection and summarizer trimming price fragments, not messages; reusing the message price would double-count overhead.
   - 出處：`packages/token-meter/src/estimate.ts:48`、`packages/compaction/src/tokens.ts:8`
4. **The budget is inclusive of host-only overhead: checkBudget adds overheadTokens (system prompt + tool schemas, which the session log never carries) to the measured tokens, and the budget is floor(contextWindow * reserveRatio) with overflow only when tokens STRICTLY exceed it.**
   - 理由：Without the overhead term the gate could only see the conversation and would declare 'ok' while the real prompt was already over.
   - 出處：`packages/token-meter/src/budget.ts:10`、`packages/core-agent/src/index.ts:32`

**失敗策略**：Fail-closed on parameters: checkBudget throws when reserveRatio is outside (0,1] or overheadTokens is not a non-negative integer (packages/token-meter/src/budget.ts:15). The measurement itself is NOT defensive — callers wrap it (compaction's safeActiveTokens, packages/compaction/src/index.ts:271).

**事件**：`none (consumes the deriveMessages LLMMessage projection; produces no SessionEvents)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `CHARS_PER_TOKEN` | 4 | `packages/token-meter/src/estimate.ts:5` |
| `BLOCK_OVERHEAD` | 4 | `packages/token-meter/src/estimate.ts:6` |
| `ROLE_OVERHEAD` | 4 | `packages/token-meter/src/estimate.ts:7` |
| `IMAGE_TOKEN_ESTIMATE` | 1024 | `packages/token-meter/src/estimate.ts:10` |
| `reserveRatio (checkBudget default)` | 0.9 | `packages/token-meter/src/budget.ts:14` |
| `overheadTokens (default)` | 0 | `packages/token-meter/src/budget.ts:14` |

**已知缺口（原始碼內標記）**

- Image pricing is a flat constant, stated as having no re-encode/pixel math in v0 (packages/token-meter/src/estimate.ts:8).

---

### `compaction`

Context-pressure control: shadow-range selection, an LLM summary pass with an anchored (update-the-previous-summary) prompt, a model-free prune pass over large tool results, and the append-only pure-reset marker — all configured per model.

> npm `@i-harness/compaction` · 入口 `packages/compaction/src/index.ts` · 5 個原始檔 · 10 個匯出符號

**公開介面**：`createCompactionEngine`、`CompactionEngine`、`CompactionResult`、`selectShadowableRange`、`resolveConfig`、`resolveCompactSpec`、`resolveContextWindow`、`approxTokens`、`activeTokens`、`IMAGE_TOKEN_ESTIMATE`、`CompactionConfig`、`ModelCompactionPolicy`、`PruneConfig`、`ResolvedCompactionConfig`、`ResolvedPruneConfig`

**關鍵設計決策**

1. **Append-only shadow, never deletion: hiding is expressed entirely as markers — compaction/summary.shadowedSeqs, compaction/reset.removedSeqs, compaction/prune records — and the reset path deliberately appends a marker instead of truncating, because the persistence backends are append-only so an in-place deletion never reached disk and the history returned on every resume. Unkeyed events (seq undefined) are never removable.**
   - 理由：Replay from the log must reconstruct exactly the surface the live process had.
   - 出處：`packages/compaction/src/index.ts:233`、`packages/compaction/src/index.ts:131`
2. **Fail-soft summarizer with a quality floor: any summarizer throw (including a degenerate-output throw after ONE same-model retry below minSummaryChars) warns and returns { compacted:false }, to be retried on the next step; only config resolution is fail-loud. Malformed persisted shapes must not escape as TypeErrors, so the meter read and the stringify are individually wrapped.**
   - 理由：The agent must never be blocked by compaction; the observable warning is what makes a sustained failure visible instead of silent.
   - 出處：`packages/compaction/src/index.ts:127`、`packages/compaction/src/summarizer.ts:155`、`packages/compaction/src/index.ts:265`
3. **The auto path is a documented gate stack: (1) pressure gate including overheadTokens, (2) sticky state set by an auto success that STILL leaves the surface over threshold, (3) re-fire guard (no new non-marker events since the last compaction/end), (4) hysteresis (minTurnsBeforeRecompact turn/end events), (5) breaker (3 consecutive auto failures; new content releases the pause but only a success resets the counter). Explicit compact() is UNGATED and its success is the other release condition.**
   - 理由：Each gate exists to stop a specific hot loop — sticky covers the prune-only pass, which appends no compaction/end and would otherwise re-plan the same records every step.
   - 出處：`packages/compaction/src/index.ts:146`、`packages/compaction/src/index.ts:218`、`packages/compaction/src/index.ts:279`
4. **Prune is a model-free shortcut available ONLY on the auto path: a plan of every tool/result whose stringified output exceeds thresholdChars (head 4096 / tail 1024 carving, middle byte count recorded) is priced against the visible surface, and if the substitute surface alone falls under the threshold the pass appends the prune marker and returns compacted:true with NO model call. Explicit compact() always summarizes.**
   - 理由：Pruning is the cheap fix; spending a summarizer call when trim alone resolves pressure is waste, but an explicit user-requested compact must do what was asked.
   - 出處：`packages/compaction/src/index.ts:65`、`packages/compaction/src/index.ts:330`
5. **Anchored summarization is a PROMPT property, not an event-shape change: the last compaction/summary text is injected in a <previous-summary> block and the model is told to UPDATE rather than restate, and imperative shadow lines matching a marker list are prefilled VERBATIM into a Sensitive Instructions section (marker match is only a flag; original wording is never reworded or dropped). Each round still appends its own summary event.**
   - 理由：Incremental merging is what stops the summary from degrading round over round, and the user's exact instructions are the part that must never be paraphrased.
   - 出處：`packages/compaction/src/summarizer.ts:26`、`packages/compaction/src/summarizer.ts:85`、`packages/compaction/src/index.ts:108`
6. **Context window is resolved catalog-first (provider profile modelContexts[modelId] → profile.contextWindow → config.contextWindow) and the effective policy is a per-model overlay on the global chain, keyed by exact "provider/model"; malformed policy keys fail loud at resolve. Telemetry emits one compaction/attempt event per attempt (success \| prune-only \| failure \| skipped) with tokensBefore/After.**
   - 理由：A resolve-time failure is debuggable; a mid-compaction failure is not.
   - 出處：`packages/compaction/src/config.ts:151`、`packages/compaction/src/config.ts:112`、`packages/compaction/src/index.ts:85`

**失敗策略**：Fail-soft at runtime, fail-closed at configuration. Runtime: a summarizer failure warns and returns compacted:false (packages/compaction/src/index.ts:124), prune stringify failure degrades to 'not prunable' (packages/compaction/src/index.ts:382), the analytics meter read degrades to undefined (packages/compaction/src/index.ts:271), deriveSearchText failure degrades to '' inside renderShadowed (packages/compaction/src/index.ts:432), and resetWindow returns { compacted:false } when nothing is removable (packages/compaction/src/index.ts:259). Configuration: every bound is validated and throws at resolveConfig/resolvePrune time (packages/compaction/src/config.ts:83), so a bad override fails at load, never mid-compaction.

**事件**：`compaction/start (PRODUCED)`、`compaction/summary (PRODUCED, carries shadowedSeqs)`、`compaction/end (PRODUCED)`、`compaction/reset (PRODUCED, carries removedSeqs)`、`compaction/prune (PRODUCED, carries PruneRecord[])`、`telemetry (not a SessionEvent): compaction/attempt`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `thresholdRatio (default)` | 0.8 | `packages/compaction/src/config.ts:87` |
| `retainTokens (default)` | 0 | `packages/compaction/src/config.ts:91` |
| `maxTokens (default)` | 1024 | `packages/compaction/src/config.ts:95` |
| `minSummaryChars (default)` | 500 | `packages/compaction/src/config.ts:99` |
| `minTurnsBeforeRecompact (default)` | 3 | `packages/compaction/src/config.ts:108` |
| `prune defaults` | thresholdChars 8192, headChars 4096, tailChars 1024 | `packages/compaction/src/config.ts:81` |
| `BREAKER_MAX_FAILURES` | 3 | `packages/compaction/src/index.ts:284` |
| `summarizer attempts` | 2 (one retry) | `packages/compaction/src/summarizer.ts:167` |
| `SENSITIVE_MIN_CHARS` | 8 | `packages/compaction/src/summarizer.ts:14` |

**已知缺口（原始碼內標記）**

- Image-aware summarization is deferred: a pruned tool/result renders as its substitute and drops the image bytes entirely on the summary-input surface ('v0 carve; image-aware summarize is still deferred'), and the real byte-level replay needs a multimodal summarizer plus store refs — only a descriptor path exists (packages/compaction/src/index.ts:403).
- The M20 image-descriptor rule explicitly REPLACES the descriptor union for a pruned event: the narrowed input drops the images along with the rest of the output (packages/compaction/src/index.ts:403).
- The comment on the model-free prune-pass defaults states the defaults are 'the recommended carving (aligned with the retention caps)' — a stated recommendation, not an enforced relation; only headChars+tailChars <= thresholdChars is enforced (packages/compaction/src/config.ts:5).

---

## 工具與執行面

### `output-retention`

Two-layer output-size control: (1) a pure byte-budget text retainer that keeps a head and/or tail of a stream without splitting UTF-8 characters, and (2) a spill store that writes the complete original text to a temp file outside the workspace and answers a notice string with the file path. spill-guard.ts composes both as a registry-level cascade handler on tools/execute.

> npm `@i-harness/output-retention` · 入口 `packages/output-retention/src/index.ts` · 2 個原始檔 · 12 個匯出符號

**公開介面**：`RetainedText`、`RetentionMode`、`TextRetainer`、`TextRetainerOptions`、`SpillStore`、`SpillStoreOptions`、`createTextRetainer`、`createSpillStore`、`createUnifiedSpillStore`、`createOutputSpillGuard`、`gcSpillStore`、`spillNotice`

**關鍵設計決策**

1. **Retention is a byte budget with an explicit head/headTail mode; the default is headTail split by headRatio 0.5, and the head/tail pieces are provably byte-disjoint (headBytes + tailBytes === maxBytes < fullBytes).**
   - 理由：A tail alone loses the command header; a head alone loses the exit summary. Keeping both under one budget with disjointness avoids repeating characters at the seam.
   - 出處：`packages/output-retention/src/index.ts:20`、`packages/output-retention/src/index.ts:35`、`packages/output-retention/src/index.ts:145`、`packages/output-retention/src/index.ts:147`
2. **Options are validated fail-loud: any non-conforming runtime value (null, string, NaN, Infinity, non-positive maxBytes, headRatio outside (0,1]) throws instead of being coerced or silently defaulted; only `undefined` gets a default. Validated values are captured at construction so mutating the options object later cannot bypass the budget.**
   - 理由：A silent coercion of maxBytes would break the memory bound the whole package exists to enforce.
   - 出處：`packages/output-retention/src/index.ts:31`、`packages/output-retention/src/index.ts:32`、`packages/output-retention/src/index.ts:40`、`packages/output-retention/src/index.ts:128`
3. **Truncation is surrogate-safe: the head prefix is a binary search over code units followed by a back-off walk that never ends on a split/unpaired surrogate (and keeps nothing when the text starts with an unpaired low surrogate); the tail walks backwards treating pairs atomically and stops at an unpaired surrogate.**
   - 理由：slice() indexes UTF-16 code units, so a naive byte-truncation can emit a lone surrogate - invalid text for the model.
   - 出處：`packages/output-retention/src/index.ts:54`、`packages/output-retention/src/index.ts:73`、`packages/output-retention/src/index.ts:97`、`packages/output-retention/src/index.ts:106`
4. **Spilled originals are written outside the workspace (per-process mkdtemp root, or a configured stable root) and the label is injectively encoded before entering the filename ([A-Za-z0-9._-] verbatim, everything else -> ~<codepoint hex>, empty -> '~'), opened with 'wx' at mode 0o600.**
   - 理由：A label carrying '/' or '..' must not escape the spill root or create an ambiguous path; a stable default root is what makes GC meaningful (the guard uses <tmpdir>/i-harness-spill while the bare createSpillStore defaults to a fresh mkdtemp).
   - 出處：`packages/output-retention/src/index.ts:170`、`packages/output-retention/src/index.ts:179`、`packages/output-retention/src/index.ts:181`、`packages/output-retention/src/index.ts:196`、`packages/output-retention/src/spill-guard.ts:21`

**失敗策略**：Mixed and explicit. Validation is fail-loud (throws on malformed options: index.ts:32-42). Spill writing is fail-loud on the write path (the fd error is rethrown after closing: index.ts:185-188). GC is fail-open/best-effort: it runs once at mount, failures only console.warn and never block the mount, and per-file unlink errors are swallowed (spill-guard.ts:25, spill-guard.ts:76, spill-guard.ts:85). The cascade guard passes through undefined/null/number/boolean outputs untouched (spill-guard.ts:32).

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_HEAD_RATIO` | 0.5 | `packages/output-retention/src/index.ts:20` |
| `DEFAULT_MAX_OUTPUT_BYTES (spill guard)` | 64_000 | `packages/output-retention/src/spill-guard.ts:12` |
| `DEFAULT_MAX_AGE_MS (spill GC)` | 86_400_000 (24h) | `packages/output-retention/src/spill-guard.ts:13` |
| `DEFAULT_MAX_TOTAL_BYTES (spill GC)` | 512 * 1024 * 1024 (512 MiB) | `packages/output-retention/src/spill-guard.ts:14` |
| `spill file mode` | 0o600, opened 'wx' | `packages/output-retention/src/index.ts:181` |
| `default spill root (guard)` | <tmpdir>/i-harness-spill | `packages/output-retention/src/spill-guard.ts:21` |
| `default spill root (bare store)` | mkdtempSync(<tmpdir>/i-harness-retention-spill-) | `packages/output-retention/src/index.ts:173` |

**已知缺口（原始碼內標記）**

- createSpillStore never cleans up: the code notes '絕不寫 workspace——研究決策；不清理（已知 limitation）' (packages/output-retention/src/index.ts:171). The bare store's per-process mkdtemp root is therefore never reclaimed; only the guard's GC (age + total-bytes trim) removes files, and only under the guard's stable root.

---

### `rewind`

Backend snapshot/rollback engine for a session: a RewindStore keeps a per-session journal (points.jsonl + content-addressed pre-image blobs + workspace-binding meta.json + pending/orphaned crash sidecars), a RewindRecorder captures fs pre-images turn by turn, and a RewindService answers points()/plan() (two-phase dry run) and execute() (file restore + conversation shadow marker + journal truncate).

> npm `@i-harness/rewind` · 入口 `packages/rewind/src/index.ts` · 8 個原始檔 · 19 個匯出符號

**公開介面**：`RewindError`、`RewindErrorCode`、`normalizeRelPath`、`workspaceAbsPath`、`RewindStore`、`RewindStoreOptions`、`sha256Hex`、`RewindRecorder`、`RewindRecorderOptions`、`RewindTakeResult`、`RewindService`、`RewindServiceOptions`、`RewindExecuteHooks`、`createGitProbe`、`createGitProbeForStore`、`GitExec`、`GitExecOptions`、`GitProbe`、`GitProbeOptions`

**關鍵設計決策**

1. **Storage is a per-session journal of points plus content-addressed blobs: points.jsonl is rewritten atomically (temp+rename) on every append/truncate, blobs/<sha256> are written only if missing (idempotent dedup across turns), and the session key is guarded against path separators / '..' because it lands in a filesystem path.**
   - 理由：The journal is small so whole-file atomic rewrite is cheaper than risking a torn append line; content addressing makes identical pre-images share one file.
   - 出處：`packages/rewind/src/store.ts:48`、`packages/rewind/src/store.ts:55`、`packages/rewind/src/store.ts:193`、`packages/rewind/src/store.ts:220`、`packages/rewind/src/store.ts:163`
2. **Paths are workspace-relative keys through one seam (normalizeRelPath / workspaceAbsPath): absolute paths, any '..' segment and empty results are refused with REWIND_PATH_REFUSED, and workspaceAbsPath re-checks containment as defense in depth.**
   - 理由：Identical files addressed as a.txt / ./a.txt must not alias twice, and journal paths must never resolve outside the workspace.
   - 出處：`packages/rewind/src/path.ts:17`、`packages/rewind/src/path.ts:19`、`packages/rewind/src/path.ts:23`、`packages/rewind/src/path.ts:39`
3. **Undo semantics are 'rewind to the END of turn T-1' with lazy conflict classification: each file record stores the preBlob (pre-image), isNewFile, and the afterHash re-read at finalize; plan() compares current disk hash against afterHash to classify clean vs modified/deleted/created, and conflicts are STILL executed (a rewind is destructive by design, honestly marked).**
   - 理由：Avoids a full snapshot per turn and lets the plan be a pure read-side dry run; the afterHash is the only signal that distinguishes 'the turn's deltas are still in place' from 'the disk moved on'.
   - 出處：`packages/rewind/src/service.ts:6`、`packages/rewind/src/service.ts:111`、`packages/rewind/src/service.ts:160`、`packages/rewind/src/types.ts:15`、`packages/rewind/src/recorder.ts:168`
4. **Durability/honesty on crash: take() is synchronous, so durable writes go through a serial queue where each op snapshots the entry list eagerly (blob before sidecar, so the sidecar never names a blob that is not on disk); a leftover pending.json whose turn has no point is archived into orphaned.jsonl and reported by plan().orphanedTurns with its paths merged into unTracked - never fabricated into a point, never auto-restored. commit(anchorSeq) clears the sidecar only after the point is in the journal, on the same queue.**
   - 理由：A crash between the file write and the queue drain can still lose the last in-flight entries, so the claim must be limited to what was flushed; auto-restoring an unfinished turn would be a guess.
   - 出處：`packages/rewind/src/recorder.ts:14`、`packages/rewind/src/recorder.ts:125`、`packages/rewind/src/recorder.ts:196`、`packages/rewind/src/store.ts:384`、`packages/rewind/src/service.ts:178`
5. **Workspace binding: meta.json records the absolute workspace the journal resolves against; every SERVICE surface (points/plan/execute) and the journal-WRITING paths (ensureDir) fail closed with REWIND_WORKSPACE_MISMATCH on a foreign journal, while raw reads are unguarded by design and a pre-M54 journal without meta.json is 'unknown workspace' and gets adopted by the first writer with a console.warn.**
   - 理由：A resume from another cwd must never restore into the wrong tree; the adoption of a legacy journal is the one irreversible decision, so it is made visible rather than silent.
   - 出處：`packages/rewind/src/store.ts:9`、`packages/rewind/src/store.ts:304`、`packages/rewind/src/store.ts:318`、`packages/rewind/src/store.ts:329`、`packages/rewind/src/service.ts:44`
6. **Git evidence is read-only and strictly fail-soft: the probe runs only rev-parse and status --porcelain=v1 -z with GIT_OPTIONAL_LOCKS=0 and GIT_TERMINAL_PROMPT=0, memoized per instance, returns [] on every failure (missing git / non-repo / timeout), and paths it reports are filtered against what the journal already explains; they are listed in plan().unseen and NEVER turned into file ops.**
   - 理由：Shell/external-editor writes are invisible to the recorder; git can only OBSERVE dirtiness (the agent's own uncommitted work is dirty too), so the probe must supply evidence, not decisions.
   - 出處：`packages/rewind/src/git-probe.ts:10`、`packages/rewind/src/git-probe.ts:127`、`packages/rewind/src/git-probe.ts:142`、`packages/rewind/src/service.ts:201`、`packages/rewind/src/service.ts:244`

**失敗策略**：Fail-closed for safety/exclusivity, fail-open for evidence. Fail-closed: workspace mismatch (store.ts:304-313, store.ts:332-337), path refusal (path.ts:19-29), invalid target turn (service.ts:333), negative truncate count (store.ts:206), invalid blob id/session key (store.ts:49-53, store.ts:163-167), corrupt journal/meta/pending (store.ts:186, store.ts:288, store.ts:355). Fail-soft: the git probe never throws (git-probe.ts:13-15, git-probe.ts:142-151) and its errors in the service are swallowed to [] (service.ts:232-242); a file-op error during execute is collected (had_errors) and, being non-empty, PREVENTS the journal truncate so retry data survives (service.ts:280-320); recorder durability errors are reported through onDurabilityError and never poison later writes (recorder.ts:223-229).

**事件**：`rewind/point (produced; declared without importing core-session as RewindEvent at packages/rewind/src/types.ts:186, appended through hooks.appendEvent at packages/rewind/src/service.ts:305-313; the union member lives in packages/core-session/src/index.ts:131)`、`user/message and turn/end (consumed indirectly: the recorder exposes begin()/finalize() and the event-name literals are wired by the host at packages/session-executor/src/assembly.ts:411 and packages/session-executor/src/assembly.ts:413)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `promptPreview truncation in points()` | slice(0, 120) | `packages/rewind/src/service.ts:138` |
| `git probe timeout` | 5_000 ms (DEFAULT_TIMEOUT_MS) | `packages/rewind/src/git-probe.ts:57` |
| `git probe maxBuffer` | 10 * 1024 * 1024 | `packages/rewind/src/git-probe.ts:58` |
| `blob id shape` | /^[a-f0-9]{64}$/ | `packages/rewind/src/store.ts:55` |
| `RewindMode` | "all" \| "files" \| "conversation" | `packages/rewind/src/types.ts:101` |

**已知缺口（原始碼內標記）**

- Shell-only changes are invisible: the recorder sees ONLY fs tool writes (write/edit/apply_patch); anything modified via bash or ripgrep never appears in plan().unTracked and is not protected by a rewind (packages/rewind/src/service.ts:34-38, packages/rewind/src/types.ts:146-150).
- v1 approximation at finalize: a touched file that fails to re-read (ENOENT or any read error) is treated as absent at turn end -> status 'deleted' (packages/rewind/src/recorder.ts:148-150).
- Recorded paths outside the workspace are written UNTRACKED (relForRewind returns null for absolute/.. targets), and capture failure must never change tool behavior (packages/fs/src/index.ts:51-79).
- Host-seeded history is not recorded: the recorder subscription is append-onward, so pre-existing turns are out of scope (packages/session-executor/src/assembly.ts:314-315).

---

### `attachment`

Image attachment persistence plus the model-callable read_image tool: bytes are written under <workspaceDir>/.i-harness/attachments/<opaque-id>.bin behind a validate-before-publish limit check, and read_image turns an on-disk image file into an inline ImageInput (mime + base64) without any store write.

> npm `@i-harness/attachment` · 入口 `packages/attachment/src/index.ts` · 2 個原始檔 · 7 個匯出符號

**公開介面**：`ImageAttachmentLimits`、`ImageAttachmentRef`、`ImageAttachmentStore`、`SaveImageAttachment`、`ImageMediaType`、`createImageAttachmentStore`、`createReadImageTool`、`ReadImageToolDeps`

**關鍵設計決策**

1. **The attachment id is opaque and never a filesystem path: `att-<uuid>` maps to <workspaceDir>/.i-harness/attachments/<id>.bin, so no caller-supplied name can steer the write target; the display name is stored only in the returned ref.**
   - 理由：Path-shaped ids from an upload surface are a traversal footgun; an opaque key keeps resolution trivial.
   - 出處：`packages/attachment/src/index.ts:3`、`packages/attachment/src/index.ts:69`、`packages/attachment/src/index.ts:70`、`packages/attachment/src/index.ts:79`
2. **Validate-before-publish: save() checks the media type against the allowed list and the per-image byte cap BEFORE any mkdir/write, so a rejected upload leaves nothing on disk.**
   - 理由：A partially written attachment would be a dangling ref the model could still load.
   - 出處：`packages/attachment/src/index.ts:6`、`packages/attachment/src/index.ts:65`、`packages/attachment/src/index.ts:67`、`packages/attachment/src/index.ts:71`
3. **read_image is READ-ONLY and returns fs failures instead of throwing: it reuses the fs layer's resolvePath (workspace-relative + absolute, '..' escape rejected) and softFail wrapper, resolves the mime type from the file extension, and caps the file at maxImageBytes (default 10 MiB).**
   - 理由：The code states a throwing tool body fails the whole turn (core-agent M13/M25), which read to the model as 'read_image hung'.
   - 出處：`packages/attachment/src/read-image.ts:5`、`packages/attachment/src/read-image.ts:9`、`packages/attachment/src/read-image.ts:41`、`packages/attachment/src/read-image.ts:48`

**失敗策略**：Fail-closed on save (unsupported media type and oversized image throw before any write: index.ts:65-68), fail-loud on an unsupported read_image extension (FS_NOT_FOUND: read-image.ts:45) but RETURNED to the model rather than thrown, via softFail (read-image.ts:41). delete() is deliberately best-effort: unlink errors are swallowed (index.ts:83).

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `maxImageBytes` | 10 * 1024 * 1024 | `packages/attachment/src/index.ts:49` |
| `maxImagesPerMessage` | 4 | `packages/attachment/src/index.ts:50` |
| `maxMessageImageBytes` | 20 * 1024 * 1024 | `packages/attachment/src/index.ts:51` |
| `maxImagePixels` | 16 * 1024 * 1024 | `packages/attachment/src/index.ts:52` |
| `maxImageDimension` | 8192 | `packages/attachment/src/index.ts:53` |
| `mediaTypes` | image/png, image/jpeg, image/webp, image/gif | `packages/attachment/src/index.ts:54` |
| `read_image per-image cap` | 10 * 1024 * 1024 (DEFAULT_MAX_IMAGE_BYTES) | `packages/attachment/src/read-image.ts:20` |

**已知缺口（原始碼內標記）**

- v0 does not parse image dimensions - width/height stay undefined even though ImageAttachmentRef declares them (packages/attachment/src/index.ts:7, packages/attachment/src/index.ts:31-39).
- Of the six declared ImageAttachmentLimits fields, save() enforces only mediaTypes and maxImageBytes; maxImagesPerMessage, maxMessageImageBytes, maxImagePixels and maxImageDimension are never read in src/ (packages/attachment/src/index.ts:16-23 vs packages/attachment/src/index.ts:64-74).

---

### `core-tools`

The Tool contract and the tool registry that owns registration, exposure filtering, the approval/guard gate, the search-promotion mechanism for deferred tools, and the three-stage dispatch pipeline (prepare -> dispatch -> finalize). Also ships get_context_remaining as an opt-in, fail-closed registration helper.

> npm `@i-harness/core-tools` · 入口 `packages/core-tools/src/index.ts` · 2 個原始檔 · 15 個匯出符號

**公開介面**：`Tool`、`ToolExposure`、`ToolExec`、`ToolDecision`、`ToolCall`、`ToolResult`、`PreparedCall`、`ToolSchema`、`SearchableTool`、`ToolRegistry`、`createToolRegistry`、`ApprovalGuardian`、`GuardianRequest`、`GuardianVerdict`、`registerContextRemaining`

**關鍵設計決策**

1. **The Tool interface is a plain data+behaviour record: name/description/inputSchema (+optional outputSchema), execute(args, exec), and OPTIONAL metadata that the policy layer reads rather than the dispatcher - timeoutMs, isConcurrencySafe, isReadOnly, getArgv(args), exposure, searchHint. ToolExec carries abortSignal plus M19/M26 identity (sessionId, callId, callEventSeq) and is the only thing a tool body sees about its caller.**
   - 理由：Policy consumers (guard-approval, timeout guard, concurrency partitioner) need metadata without the registry knowing about them; identity is additive so a prepared call without it behaves as before.
   - 出處：`packages/core-tools/src/index.ts:10`、`packages/core-tools/src/index.ts:16`、`packages/core-tools/src/index.ts:19`、`packages/core-tools/src/index.ts:24`、`packages/core-tools/src/index.ts:31`
2. **Exposure is a three-value model on the tool plus a registry-side promotion set: 'hidden' tools never appear in schemas(); 'deferred' tools appear only after their name is returned by search(); everything else is 'direct'. Promotion is one-way for the registry's lifetime, and unregister() removes the tool AND its promotion state so a mount can cleanly reclaim its names.**
   - 理由：Deferred retrieval needs a promotion memory that survives across provider calls ('available on the next provider call'), and a re-mount must not inherit stale promotions.
   - 出處：`packages/core-tools/src/index.ts:8`、`packages/core-tools/src/index.ts:138`、`packages/core-tools/src/index.ts:141`、`packages/core-tools/src/index.ts:199`、`packages/core-tools/src/index.ts:194`
3. **The search engine is pluggable and its absence is loud: installSearch(fn) sets the hook, search() throws 'no search engine installed' until then, every returned name is promoted, and the corpus handed to the engine is deferredSearchIndex() - raw metadata of only the deferred tools (searchHint included when present). deferredToolCount() reports that corpus size.**
   - 理由：core-tools must not depend on a BM25 implementation; failing loud beats silently searching an empty corpus.
   - 出處：`packages/core-tools/src/index.ts:328`、`packages/core-tools/src/index.ts:333`、`packages/core-tools/src/index.ts:335`、`packages/core-tools/src/index.ts:341`、`packages/core-tools/src/index.ts:352`
4. **Decisions are a closed vocabulary merged monotonically (allow < ask < deny): mergeDecision throws a HARD error on a non-object or an out-of-vocabulary kind (never allow), returns the local decision when the candidate has no 'kind', and picks the stricter of local vs ancestor. The pre-execute waterfall handler deliberately returns `undefined` rather than {kind:'allow'} when it produced no decision, because emit propagates the chain value parent-ward and a returned decision object would make an ancestor guard-approval skip classifying the ToolCall (fail-open for ancestor approval).**
   - 理由：Audit F03-1 required a decision-shaped object to be unable to short-circuit the guard layer, and the ancestor-propagation fix (Task 10 mechanism B) must not be defeatable by a child's default-allow.
   - 出處：`packages/core-tools/src/index.ts:73`、`packages/core-tools/src/index.ts:78`、`packages/core-tools/src/index.ts:92`、`packages/core-tools/src/index.ts:221`、`packages/core-tools/src/index.ts:165`、`packages/core-tools/src/index.ts:242`
5. **prepare() is the single enforcement point and is fail-closed at the approval seam: unknown tool name throws; a deny decision throws; 'ask' consults the optional approval/guardian first (deny -> throw, approve -> auto-approve, allow -> human answerer) and with NO registered answerer the call throws 'approval required but no answerer registered (fail closed)'. Monotonic guards (ctx.checkGuards('tools/execute', ...)) run UNCONDITIONALLY before dispatch so no decision can bypass them. Dispatch is the only overlapping stage (the tools/execute cascade around the real body); prepare/finalize stay in the ordered lane, and a per-dispatch decision is returned through the emit chain instead of a shared closure slot so concurrent prepares cannot race.**
   - 理由：Guard-timeout/retry/repeat guards are monotonic vetoes, not policies that a decision can outrank; a shared decision slot raced under concurrent prepares.
   - 出處：`packages/core-tools/src/index.ts:247`、`packages/core-tools/src/index.ts:251`、`packages/core-tools/src/index.ts:259`、`packages/core-tools/src/index.ts:269`、`packages/core-tools/src/index.ts:302`、`packages/core-tools/src/index.ts:212`
6. **Same-layer duplicate registration is a hard error, while child scopes get their own registry instance and may shadow by name; get(name) returns undefined for unknown names so policy consumers can fail closed instead of throwing; verifyToolCatalog(expected, catalog) throws listing missing tool names as a completeness check.**
   - 理由：Audit F03-5: two tools with one name in one registry is a bug, but plugin scoping needs intentional shadowing.
   - 出處：`packages/core-tools/src/index.ts:180`、`packages/core-tools/src/index.ts:187`、`packages/core-tools/src/index.ts:360`
7. **registerContextRemaining is FAIL-CLOSED by registration: without a positive contextWindow the tool is simply not added to the catalog, and `used` is priced with token-meter's activeTokens over deriveMessages(session) (the single M15 projection a model ever sees); it is marked isReadOnly.**
   - 理由：Registering a budget tool without knowing the window would report a fabricated number; pricing anything other than the projected messages would misprice the real prompt.
   - 出處：`packages/core-tools/src/context-remaining.ts:9`、`packages/core-tools/src/context-remaining.ts:22`、`packages/core-tools/src/context-remaining.ts:29`、`packages/core-tools/src/context-remaining.ts:32`

**失敗策略**：Fail-closed by default with a fail-loud malformed-input policy. Hard throws: unknown tool (index.ts:214), duplicate registration (index.ts:180), guard denial (index.ts:248), deny decision (index.ts:251), ask with no answerer (index.ts:260), user denial (index.ts:263), guardian denial (index.ts:277), malformed pre-execute decision (index.ts:95/100/167/172), search with no engine installed (index.ts:333), catalog completeness failure (index.ts:364). No decision at all normalizes to allow (index.ts:222) - the one fail-open point, and it is the documented pre-M13 semantics.

**事件**：`tools/pre-execute (plugin waterfall event, NOT a SessionEvent; consumed/validated at packages/core-tools/src/index.ts:158 and emitted at :221)`、`tools/execute (plugin cascade event wrapping the tool body, NOT a SessionEvent; packages/core-tools/src/index.ts:247, :303)`、`tools/post-execute (plugin waterfall event, NOT a SessionEvent; packages/core-tools/src/index.ts:313)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DECISION_STRICTNESS` | { allow: 0, ask: 1, deny: 2 } | `packages/core-tools/src/index.ts:78` |
| `DECISION_KINDS` | allow \| deny \| ask (closed set) | `packages/core-tools/src/index.ts:73` |
| `get_context_remaining registration gate` | contextWindow undefined or <= 0 -> not registered | `packages/core-tools/src/context-remaining.ts:23` |

**已知缺口（原始碼內標記）**

- The strictness ranking is documented as currently unused for merging: 'A resolveStrictestDecision walk is therefore a no-op today; revisit only if multi-producer decisions become possible' (packages/core-tools/src/index.ts:80-85).
- Nothing in src/ implements multi-producer decision resolution, per-scope registries, or a search-engine default - installSearch must be called or search() throws.

---

### `fs`

The five workspace file tools (read, edit, write, apply_patch, list_dir) with a returned-failure error model, CRLF-preserving edits, TOCTOU re-check before write, atomic same-directory temp+rename writes, a codex-style structured patch parser, and an optional pre-image sink for the rewind engine.

> npm `@i-harness/fs` · 入口 `packages/fs/src/index.ts` · 6 個原始檔 · 16 個匯出符號

**公開介面**：`FsToolDeps`、`FsToolError`、`FsToolErrorCode`、`FsToolFailure`、`FileSnapshot`、`LiteralEditResult`、`RewindCapture`、`applyLiteralEdit`、`assertSnapshotFresh`、`assertTextData`、`createFsTools`、`detectLineEndings`、`normalizeLineEndings`、`resolvePath`、`restoreLineEndings`、`softFail`、`writeFileAtomic`

**關鍵設計決策**

1. **Two different path policies in one function: a RELATIVE input is resolved against the workspace and a `..` escape (relative() starting with '..' or absolute) throws FS_NOT_FOUND; an ABSOLUTE input is taken as-is and may point outside the workspace (the comment says absolute reads outside the workspace are deliberately preserved).**
   - 理由：Explicitly stated as '既有行為：絕對輸入原樣（讀取 workspace 外檔案——read 保留）；`..` 逃逸 → 現在拒'.
   - 出處：`packages/fs/src/index.ts:25`、`packages/fs/src/index.ts:27`、`packages/fs/src/index.ts:29`、`packages/fs/src/index.ts:32`
2. **EXPECTED fs failures are RETURNED as { error, code } instead of thrown: softFail converts an FsToolError or a whitelisted Node errno (ENOENT, EACCES, EPERM, EISDIR, ENOTDIR, EEXIST, EMFILE, ENOSPC, EROFS, EBUSY) into a result; anything else (a TypeError, a bug) still throws and fails the turn loudly. The stated reason is that a throwing tool body makes core-agent discard the batch and append neither tool/result nor turn/end, so the call read as 'hung'.**
   - 理由：The model must SEE an expected failure to adapt; only real bugs should cost the turn.
   - 出處：`packages/fs/src/error.ts:15`、`packages/fs/src/error.ts:35`、`packages/fs/src/error.ts:41`、`packages/fs/src/error.ts:45`、`packages/fs/src/error.ts:50`
3. **edit is a guarded read-modify-write: empty old_string, old_string === new_string, a non-regular file, and a binary/UTF-8-invalid file are all refused (FS_AMBIGUOUS_EDIT / FS_NOT_REGULAR_FILE); a non-unique match is FS_AMBIGUOUS_EDIT unless replace_all; an optional observedMtimeMs from the model's read must match Math.floor(st.mtimeMs) or FS_STALE_VERSION; and after computing the new text the file is re-stat'ed and the {mtimeMs,size} snapshot compared (assertSnapshotFresh) before the write, closing the read->write TOCTOU window. Line endings are detected on a 4096-char sample, normalized to LF for matching, then restored to the detected style.**
   - 理由：M21 §4.2: a concurrent writer between read and rename must be detected rather than silently overwritten.
   - 出處：`packages/fs/src/index.ts:151`、`packages/fs/src/index.ts:160`、`packages/fs/src/index.ts:163`、`packages/fs/src/index.ts:174`、`packages/fs/src/version.ts:9`、`packages/fs/src/text.ts:7`
4. **Writes are atomic by same-directory temp file + rename, with mkdir -p of the parent and best-effort unlink of the temp on failure; an optional mode is applied to the temp file so the pre-rename window is never looser than the target (win32 ignores mode - documented as best-effort there).**
   - 理由：POSIX rename within a directory is atomic and NTFS rename in the same directory is atomic too; a partially written file is never visible.
   - 出處：`packages/fs/src/atomic.ts:5`、`packages/fs/src/atomic.ts:14`、`packages/fs/src/atomic.ts:17`、`packages/fs/src/atomic.ts:18`
5. **apply_patch is strict and fail-closed on the parser: it must start with '*** Begin Patch' and end with '*** End Patch', a duplicate path in one patch is an error, unknown lines are errors, content after End Patch is an error, '*** Move to:' is explicitly unsupported in v0 (fail-closed, use delete+add), Add File onto an existing path is refused before writing, update hunks are applied with a forward-only cursor and reverse-order splicing, and the hunk loop STOPS at the first failing hunk, reporting applied-so-far plus the error.**
   - 理由：A silently ignored directive or a partial multi-file patch would leave the workspace in an unexplained state; reporting applied/errors lets the model recover.
   - 出處：`packages/fs/src/patch.ts:36`、`packages/fs/src/patch.ts:77`、`packages/fs/src/patch.ts:104`、`packages/fs/src/patch.ts:190`、`packages/fs/src/patch.ts:255`
6. **Rewind capture is an OPTIONAL additive sink: FsToolDeps.rewind is a structural RewindCapture (fs never imports packages/rewind - the assembly glues them); absent => byte-identical behavior at zero cost; present => write does ONE extra read of the pre-image (ENOENT => new file), edit/apply_patch reuse the bytes they already read, and the result carries preImageRef/isNewFile. Paths that escape the workspace are captured as null (written UNTRACKED) and any capture failure returns {} so tool behavior never changes.**
   - 理由：The log is the rewind channel; a capture failure must be honest (untracked) rather than fatal or silently 'tracked'.
   - 出處：`packages/fs/src/index.ts:41`、`packages/fs/src/index.ts:54`、`packages/fs/src/index.ts:72`、`packages/fs/src/patch.ts:23`、`packages/fs/src/patch.ts:239`

**失敗策略**：Fail-soft at the tool boundary (expected fs failures returned via softFail: error.ts:41-51) but fail-closed on every safety check it can make: escape refusal (index.ts:32), stale version (version.ts:10-15), ambiguous edit (index.ts:151/163/171), binary/non-UTF-8 (text.ts:22-31), Add-onto-existing (patch.ts:187-191), malformed patch (patch.ts:36-113). There is NO sandbox integration in this package: grep for sandbox/Sandbox in packages/fs/src returns no matches, FsToolDeps has no sandbox field (index.ts:38-49), and the compose site passes only { workspace, rewind } (packages/session-executor/src/assembly.ts:358-361). A sandbox refusal therefore cannot reach fs; confinement for fs is the relative-path `..` refusal plus whatever the tool's own caller does. Unanticipated errors (non-errno) still throw and fail the turn.

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `SOFT_ERRNO set` | ENOENT, EACCES, EPERM, EISDIR, ENOTDIR, EEXIST, EMFILE, ENOSPC, EROFS, EBUSY | `packages/fs/src/error.ts:35` |
| `line-ending detection sample` | first 4096 chars | `packages/fs/src/text.ts:8` |
| `FsToolErrorCode vocabulary` | FS_NOT_FOUND \| FS_NOT_REGULAR_FILE \| FS_ALREADY_EXISTS \| FS_EDIT_NOT_FOUND \| FS_AMBIGUOUS_EDIT \| FS_STALE_VERSION \| FS_TOO_LARGE \| FS_IO_ERROR | `packages/fs/src/error.ts:1` |
| `atomic temp name` | .<basename>.<6 random bytes hex>.tmp in the target directory | `packages/fs/src/atomic.ts:15` |

**已知缺口（原始碼內標記）**

- No sandbox/confinement hook exists in this package at all (no sandbox symbol in packages/fs/src; FsToolDeps at packages/fs/src/index.ts:38-49 carries only workspace + rewind).
- apply_patch v0 does not support `*** Move to:` - fail-closed with FS_EDIT_NOT_FOUND and the instruction to use delete + add (packages/fs/src/patch.ts:75-78).
- assertTextData's maxBytes (FS_TOO_LARGE) is implemented but never passed by any caller in src/ (packages/fs/src/text.ts:20-23; the only call sites are index.ts:165 and patch.ts:231 without a limit).

---

### `fs-lock`

Session ownership lease primitive: one process holds a process-lifetime EXCLUSIVE OS byte-range lock on a per-session lock file (Win32 LockFileEx / Linux flock), acquired non-blocking with a JS backoff retry until a deadline, released idempotently.

> npm `@i-harness/fs-lock` · 入口 `packages/fs-lock/src/index.ts` · 4 個原始檔 · 6 個匯出符號

**公開介面**：`AcquireOptions`、`SessionLock`、`SessionLockConflictError`、`SessionLockUnsupportedError`、`acquireSessionLock`、`lockPathFor`

**關鍵設計決策**

1. **The lease is an OS byte-range lock on an open handle held for the writer's whole lifetime, NOT a lockfile+PID scheme: the OS auto-releases on process death, so there is no stale-lock problem; release() is idempotent and there is no reentrancy (an explicit Linux comment notes two opens in the SAME process still conflict because each open is its own open file description).**
   - 理由：An orphaned lockfile deadlocks every later writer; an OS handle lock cannot be orphaned.
   - 出處：`packages/fs-lock/src/index.ts:3`、`packages/fs-lock/src/index.ts:41`、`packages/fs-lock/src/linux.ts:148`、`packages/fs-lock/src/win32.ts:153`
2. **Non-blocking at the OS level (LOCKFILE_FAIL_IMMEDIATELY / flock LOCK_NB) with the wait moved into JS: retryMs 20 doubling to retryMaxMs 200 until deadlineMs 2000, then SessionLockConflictError; conflict-class codes are ERROR_LOCK_VIOLATION(33) and ERROR_ACCESS_DENIED(5) on win32 and EAGAIN on linux; every other failure throws immediately with no lease taken.**
   - 理由：A synchronous FFI wait would block the event loop; fail-closed on a conflicting holder is the codex try_lock + WouldBlock->Conflict semantics.
   - 出處：`packages/fs-lock/src/index.ts:63`、`packages/fs-lock/src/win32.ts:65`、`packages/fs-lock/src/win32.ts:81`、`packages/fs-lock/src/win32.ts:218`、`packages/fs-lock/src/linux.ts:180`
3. **Platform boundary is explicit and fail-closed: only win32 (LockFileEx via koffi/kernel32) and linux (flock) ship bindings; any other platform throws SessionLockUnsupportedError, and darwin stays fail-closed on purpose because no weaker lockfile+PID fallback is shipped. Backend modules are dynamically imported and import only errors.ts at runtime to avoid a runtime import cycle; the win32 binding table must pass a zeroed 32-byte OVERLAPPED because koffi 3.1.x crashes on a NULL lpOverlapped.**
   - 理由：Shipping a weaker fallback would silently change the guarantee the lease exists to provide.
   - 出處：`packages/fs-lock/src/index.ts:78`、`packages/fs-lock/src/index.ts:80`、`packages/fs-lock/src/win32.ts:10`、`packages/fs-lock/src/win32.ts:88`、`packages/fs-lock/src/errors.ts:3`
4. **The lock path is deterministic and derived only from the session id: <storeRoot>/.i-harness-locks/<sha256(sessionId).slice(0,24)>.lock - a hash keeps arbitrary session ids filesystem-safe and the directory rides the session store's lifecycle rather than %TEMP%.**
   - 理由：Placing the lock beside the store means locks die with the store they protect.
   - 出處：`packages/fs-lock/src/index.ts:47`、`packages/fs-lock/src/index.ts:56`、`packages/fs-lock/src/index.ts:57`

**失敗策略**：Fail-closed throughout. A live conflicting holder past the deadline is SessionLockConflictError (index.ts:66-68, win32.ts:204, win32.ts:219, linux.ts:181); unsupported platform or a missing native backend/kernel32 is SessionLockUnsupportedError (index.ts:82, win32.ts:129); any non-conflict OS failure throws immediately (win32.ts:206, win32.ts:216, linux.ts:178); a failed acquire closes the best-effort handle so it never leaks (win32.ts:224-230).

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `retryMs default` | 20 | `packages/fs-lock/src/index.ts:33` |
| `retryMaxMs default` | 200 | `packages/fs-lock/src/index.ts:36` |
| `deadlineMs default` | 2000 | `packages/fs-lock/src/index.ts:38` |
| `lock file path` | <storeRoot>/.i-harness-locks/<sha256(sessionId) 24 hex>.lock | `packages/fs-lock/src/index.ts:58` |
| `win32 lock range` | 1 byte from offset 0, LOCKFILE_EXCLUSIVE_LOCK \| LOCKFILE_FAIL_IMMEDIATELY | `packages/fs-lock/src/win32.ts:211` |

**已知缺口（原始碼內標記）**

- Only Windows and Linux are supported: darwin (and everything else) fails closed with SessionLockUnsupportedError, and no weaker fallback is shipped by design (packages/fs-lock/src/index.ts:71-73, packages/fs-lock/src/index.ts:80-82).
- The lease is advisory on a lock FILE, not on the session data: release() only unlocks and closes (win32.ts:153-162, linux.ts:125-141) - the .lock file is never unlinked, and nothing in src/ prevents a non-cooperating writer from touching the session files without acquiring the lock.

---

### `fs-search`

The glob and grep tools: both shell out to a lazily resolved @vscode/ripgrep binary through the exec service, run in the assembly workspace, and expose themselves as DEFERRED tools with a searchHint so the model discovers them through tool_search.

> npm `@i-harness/fs-search` · 入口 `packages/fs-search/src/index.ts` · 2 個原始檔 · 6 個匯出符號

**公開介面**：`FsSearchToolDeps`、`GlobResult`、`GrepMatch`、`GrepResult`、`createFsSearchTools`、`resolveRgPath`

**關鍵設計決策**

1. **ripgrep resolution is lazy and memoized: resolveRgPath() resolves @vscode/ripgrep at the call boundary because that package resolves its platform binary at module evaluation, so a static import would fail whole-loader on a partial install.**
   - 理由：Keeps an incomplete optional install from breaking the module graph; the failure lands at first use.
   - 出處：`packages/fs-search/src/index.ts:12`、`packages/fs-search/src/index.ts:14`、`packages/fs-search/src/index.ts:17`、`packages/fs-search/src/index.ts:19`
2. **Exit-code semantics are explicit: rg exit 1 with no matches is a NORMAL empty result, while any other non-zero exit (2+ = rg error, -1 = spawn failure) is returned as { matches: [], error } instead of a silent empty success.**
   - 理由：A spawn failure or an unusable rg would otherwise look to the model exactly like 'nothing matched'.
   - 出處：`packages/fs-search/src/index.ts:88`、`packages/fs-search/src/index.ts:91`、`packages/fs-search/src/index.ts:136`、`packages/fs-search/src/index.ts:139`
3. **Result sets are capped and VCS directories are excluded twice: glob caps at 100 matches with --sort=modified and emits both --glob=!**/<vcs> and --glob=!**/<vcs>/** for each of .git/.svn/.hg/.bzr/.jj/.sl; grep caps at 250 matches and parses rg --json lines, skipping malformed JSON lines rather than failing.**
   - 理由：The caps bound the model-visible payload; the two exclude forms cover both descending into and searching at/inside a VCS directory.
   - 出處：`packages/fs-search/src/index.ts:8`、`packages/fs-search/src/index.ts:9`、`packages/fs-search/src/index.ts:10`、`packages/fs-search/src/index.ts:101`、`packages/fs-search/src/index.ts:152`
4. **Both tools are deferred-exposure, read-only, concurrency-safe, and run rg with cwd = the assembly workspace so relative path args (and the glob default '.') resolve like every other fs tool; absent workspace, exec's own cwd contract applies.**
   - 理由：Deferred retrieval keeps two rarely-needed tools out of the always-on catalog; a shared cwd keeps path semantics consistent across the fs family.
   - 出處：`packages/fs-search/src/index.ts:58`、`packages/fs-search/src/index.ts:59`、`packages/fs-search/src/index.ts:82`、`packages/fs-search/src/index.ts:134`

**失敗策略**：Fail-soft for execution failures (a caught error becomes { matches: [], error: message }: index.ts:103-105, index.ts:159-161) but fail-loud for caller errors: an empty glob pattern or empty grep pattern throws (index.ts:63, index.ts:126). Deliberately NO sandbox: grep for sandbox/Sandbox in packages/fs-search/src returns no matches and the exec.run calls pass only { argv, cwd } (index.ts:87, index.ts:134), so rg runs unconfined even under a read-only session mode.

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `GLOB_MAX_RESULTS` | 100 | `packages/fs-search/src/index.ts:9` |
| `GREP_MAX_MATCHES` | 250 | `packages/fs-search/src/index.ts:10` |
| `GLOB_VCS_EXCLUDES` | .git, .svn, .hg, .bzr, .jj, .sl (each excluded twice) | `packages/fs-search/src/index.ts:8` |

**已知缺口（原始碼內標記）**

- No sandbox/confinement parameter exists for either tool (packages/fs-search/src/index.ts:22-28 deps, index.ts:87 and index.ts:134 call sites).
- No gap markers (TODO/FIXME/deferred/limitation) exist in packages/fs-search/src beyond the caps themselves.

---

### `fs-watch`

A chokidar-backed filesystem event stream exposed as an AsyncIterable of { path, kind: add\|change\|unlink }, with a synchronous baseline snapshot taken at create time so pre-existing files never emit 'add' while files created right after creation do.

> npm `@i-harness/fs-watch` · 入口 `packages/fs-watch/src/index.ts` · 1 個原始檔 · 5 個匯出符號

**公開介面**：`DEFAULT_IGNORE`、`FsWatchEvent`、`FsWatcher`、`FsWatcherOptions`、`createFsWatcher`

**關鍵設計決策**

1. **Events are DELTAS against a baseline walked synchronously at create time: the watcher runs with ignoreInitial:false and filters echoes by consulting the baseline promise, which closes the create-before-scan race in which chokidar's ignoreInitial would swallow a write that happened right after createFsWatcher. change/unlink are never filtered.**
   - 理由：A late subscriber must not miss an early write, and a pre-existing file must not be reported as an addition.
   - 出處：`packages/fs-watch/src/index.ts:9`、`packages/fs-watch/src/index.ts:55`、`packages/fs-watch/src/index.ts:88`、`packages/fs-watch/src/index.ts:131`、`packages/fs-watch/src/index.ts:148`
2. **The FIRST read of the iterable awaits chokidar readiness; events arriving in between are buffered in a queue, and a waiter list is served directly. A single error is latched (pendingError) and surfaces once per iterator: startup errors release readiness so the first read cannot hang, late errors reject a waiting next() and terminate the stream.**
   - 理由：Readiness gating plus buffering is what makes 'no event is ever missed by a late subscriber' true; latching avoids an error being reported twice or hanging the first read.
   - 出處：`packages/fs-watch/src/index.ts:6`、`packages/fs-watch/src/index.ts:110`、`packages/fs-watch/src/index.ts:120`、`packages/fs-watch/src/index.ts:158`、`packages/fs-watch/src/index.ts:177`
3. **Ignore semantics are path SEGMENT based (any depth, exact name match) with the defaults node_modules/.git/.i-harness/dist plus caller-supplied segments, and awaitWriteFinish stabilizes writes at a 100 ms threshold.**
   - 理由：Segment matching makes 'artifact-zone' match a directory of that name anywhere without glob syntax; write stabilization avoids partial-read events.
   - 出處：`packages/fs-watch/src/index.ts:17`、`packages/fs-watch/src/index.ts:38`、`packages/fs-watch/src/index.ts:47`、`packages/fs-watch/src/index.ts:82`、`packages/fs-watch/src/index.ts:135`

**失敗策略**：Fail-soft/degrade-not-throw: a missing or unreadable root during the baseline walk is skipped (index.ts:64-66), events after close are dropped (index.ts:111), and the only error channel is the latched pendingError rejecting a waiting next() once (index.ts:177-181); close() is idempotent and ends the iterable (index.ts:190-196). Nothing here is fail-closed on a bad root - the caller sees an empty/complete stream rather than an error.

**事件**：`FsWatchEvent kind add | change | unlink (package-local event vocabulary, NOT SessionEventMap members; packages/fs-watch/src/index.ts:28)`、`chokidar 'ready' and 'all'/'error' watcher events are consumed internally (packages/fs-watch/src/index.ts:139-163)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_IGNORE` | node_modules, .git, .i-harness, dist | `packages/fs-watch/src/index.ts:38` |
| `WATCH_READINESS_MS (awaitWriteFinish stabilityThreshold)` | 100 | `packages/fs-watch/src/index.ts:47` |

**已知缺口（原始碼內標記）**

- No gap markers (TODO/FIXME/deferred/limitation) in packages/fs-watch/src; the module is a single 198-line file with no documented deferrals.

---

### `shell`

The bash and pwsh tools: resolves which shell executable to spawn, keeps a tool NAMED bash honest by never silently running another shell, applies optional output retention with a spill bridge, and forwards an optional sandbox policy into the exec service.

> npm `@i-harness/shell` · 入口 `packages/shell/src/index.ts` · 1 個原始檔 · 9 個匯出符號

**公開介面**：`ResolvedShell`、`ShellRetentionOptions`、`ShellToolDeps`、`bashAvailable`、`createShellTools`、`getArgv`、`registerShell`、`resolvePwshExe`、`resolveShell`

**關鍵設計決策**

1. **Shell resolution and honesty: on win32 resolveShell prefers bash when bash is on PATH and otherwise returns pwsh, but the bash TOOL hardcodes argv ['bash','-c',command] so a tool named bash can never silently execute PowerShell; when bashAvailable() is false the tool returns exitCode -1 with a legible stderr ('bash is not installed on this host... Use the pwsh tool') instead of an empty-output spawn failure. resolvePwshExe prefers pwsh.exe on PATH and otherwise uses %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe, both accepting the same -NoLogo -NoProfile -NonInteractive -Command flags.**
   - 理由：M59: a bare spawn failure left the model flailing across bash/pwsh/terminal_open; both editions of PowerShell accept the same flags so the fallback is behaviour-preserving.
   - 出處：`packages/shell/src/index.ts:14`、`packages/shell/src/index.ts:24`、`packages/shell/src/index.ts:29`、`packages/shell/src/index.ts:58`、`packages/shell/src/index.ts:222`、`packages/shell/src/index.ts:229`
2. **getArgv is a minimal in-package quote parser (whitespace split, single/double quotes, backslash escapes outside quotes and inside double quotes) supplied as Tool.getArgv so guard-approval can classify a command from its argv without spawning; the comment names the bypass shapes it exists to normalize (r\m, 'r''m', r""m).**
   - 理由：Approval policy needs a best-effort argv view of the command string; leaving it unparsed makes quote-based bypasses visible as one opaque argument.
   - 出處：`packages/shell/src/index.ts:78`、`packages/shell/src/index.ts:81`、`packages/shell/src/index.ts:96`、`packages/shell/src/index.ts:221`
3. **Retention is OPT-IN at the tool-return layer only: exec keeps the full stream; with deps.retention unset the result shape is unchanged. Retainers are built FRESH per run (they are one-accumulation stateful objects) with maxBytes default 64_000, and the truncation verdict is the UNION of the exec layer's marker (stdoutSpillPath or truncated.stdout) and the retainer's own truncation, so enabling exec spill and shell retention together cannot produce a silent truncation with no notice. The notice points at the exec spill file when one exists and never writes a second copy.**
   - 理由：M21 A/B bridge: exec returns only the tail after spilling, so the retainer alone would judge truncated:false and drop the notice.
   - 出處：`packages/shell/src/index.ts:150`、`packages/shell/src/index.ts:161`、`packages/shell/src/index.ts:164`、`packages/shell/src/index.ts:186`、`packages/shell/src/index.ts:194`
4. **Confinement is REQUESTED, not enforced, here: ShellToolDeps carries an optional sandboxPolicy which is attached to both exec.run and exec.runBackground as the `sandbox` field; the provider (opts.sandbox) is handed to registerExec, which composes the exec service. Absent either, no sandbox field is sent and pre-M16 passthrough behavior applies; the same optional cwd (assembly workspace) rides along.**
   - 理由：One policy value flows from assembly to exec so the prompt's description and the actual enforcement cannot drift.
   - 出處：`packages/shell/src/index.ts:136`、`packages/shell/src/index.ts:145`、`packages/shell/src/index.ts:240`、`packages/shell/src/index.ts:243`、`packages/shell/src/index.ts:282`

**失敗策略**：Mostly fail-open at the tool boundary with one legible fail-loud case. When bash is missing the tool RETURNS a synthetic result (stdout '', stderr explanation, exitCode -1) rather than throwing (index.ts:229-237). When the sandbox refuses, shell does NOT handle it: deps.exec.run is awaited without a try/catch (index.ts:243, index.ts:263), so exec's SandboxUnavailableError rejection propagates out of the tool body; core-agent records tool/error and rethrows the first error after discarding the batch, i.e. the turn fails (packages/core-agent/src/execute-tool-calls.ts:125-133, :223-227). The background variant is different: exec.runBackground's rejection handler marks the job status 'error' with the message in stderr, so a refusal on a background bash/pwsh surfaces as an errored job, not a thrown turn (packages/exec/src/index.ts:262-267).

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `retention maxBytes default` | 64_000 | `packages/shell/src/index.ts:130` |
| `bash argv` | ['bash','-c',command] | `packages/shell/src/index.ts:238` |
| `pwsh argv` | [resolvePwshExe(),'-NoLogo','-NoProfile','-NonInteractive','-Command',command] | `packages/shell/src/index.ts:258` |
| `pwsh fallback path` | %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe | `packages/shell/src/index.ts:74` |

**已知缺口（原始碼內標記）**

- No gap markers (TODO/FIXME/deferred/limitation) in packages/shell/src; the M59 notes document fixed defects rather than open deferrals.

---

### `exec`

The process-execution service behind the shell tools: spawns argv (optionally confined), kills whole process trees on timeout/abort, normalizes CRLF, captures stdout/stderr with an optional memory-tail + disk-spill collector, and owns a background-job registry with get/list/kill.

> npm `@i-harness/exec` · 入口 `packages/exec/src/index.ts` · 2 個原始檔 · 9 個匯出符號

**公開介面**：`BackgroundJobStatus`、`BackgroundJobView`、`ExecCommand`、`ExecResult`、`ExecService`、`ExecServiceOptions`、`ExecSpillOptions`、`createExecService`、`registerExec`

**關鍵設計決策**

1. **Confinement is resolved once at spawn from the command-carried policy: no policy -> passthrough; a policy with mode danger-full-access -> passthrough; a confined policy with NO provider -> throw SandboxUnavailableError (deliberate boundary: a confined command must never run unconfined just because a backend is missing); a confined policy WITH a provider -> assertSandboxCapable (M22 enforcement gate, e.g. read isolation) then provider.confine(argv, policy), keeping the ConfinedArgv (denialSignatures/runnerFailureRules/enforcement) on the handle for the done path.**
   - 理由：Fail-closed at the sandbox boundary; the capability gate exists so a policy demanding read isolation never runs on a backend that cannot declare it.
   - 出處：`packages/exec/src/index.ts:99`、`packages/exec/src/index.ts:107`、`packages/exec/src/index.ts:110`、`packages/exec/src/index.ts:112`、`packages/exec/src/index.ts:116`、`packages/exec/src/index.ts:117`
2. **A runner failure is translated, not surfaced as an ordinary non-zero exit: when the process was confined, exited non-zero, did not time out, and the ConfinedArgv carries runnerFailureRules, classifyRunnerFailure inspects stderr and the promise REJECTS with SandboxUnavailableError(mode, detail) - because the command body never executed, only the runner failed to start.**
   - 理由：M16 final-review I3: bwrap exit 125 ('bwrap: failed to ...') is not a command failure and a confusing non-zero exit hides that the sandbox is unavailable.
   - 出處：`packages/exec/src/index.ts:176`、`packages/exec/src/index.ts:185`、`packages/exec/src/index.ts:191`
3. **Lifecycle control is tree-wide and shared: one killTree implementation serves the timeout timer, the returned kill(), and the external abort listener (taskkill /T /F on win32, process-group SIGKILL with a direct-child fallback elsewhere). An external abort is explicitly NOT a timeout - timedOut stays false so callers see the real killed exitCode - and the abort listener is removed once the process settles.**
   - 理由：Three call sites with one implementation cannot drift; conflating abort with timeout would mislabel user cancellation.
   - 出處：`packages/exec/src/index.ts:77`、`packages/exec/src/index.ts:81`、`packages/exec/src/index.ts:143`、`packages/exec/src/index.ts:148`、`packages/exec/src/index.ts:168`
4. **Spill is foreground-only and collector-based: run() captures through OutputCollector (memory tail of maxOutputBytes default 64_000 + complete-stream spill file opened at first overflow, with a spill cap that degrades by discarding the file and marking lossy) while runBackground keeps plain stream accumulation into job.stdout with no spill. Spill fields (stdoutSpillPath/stderrSpillPath/truncated) attach only when something actually overflowed; the promise is returned directly so no field is dropped.**
   - 理由：Background jobs must stay stream-observable; a partially written spill file is worse than an honest lossy tail, hence discard + lossy flag.
   - 出處：`packages/exec/src/index.ts:22`、`packages/exec/src/index.ts:134`、`packages/exec/src/index.ts:231`、`packages/exec/src/index.ts:236`、`packages/exec/src/spill.ts:43`、`packages/exec/src/spill.ts:59`、`packages/exec/src/spill.ts:69`
5. **Background jobs live in an in-process Map keyed bash-<n> with status running\|completed\|killed\|error: runBackground returns immediately, a settle handler maps timedOut->killed, exitCode 0->completed, otherwise error, and a rejection (SandboxUnavailableError) lands as an errored job with the message in stderr instead of an unhandled rejection. killJob on an unknown id throws; on a finished job it returns 'already-finished'.**
   - 理由：A runner-failure rejection must not become an unhandled rejection, and the model needs a legible job state instead of a hang.
   - 出處：`packages/exec/src/index.ts:241`、`packages/exec/src/index.ts:247`、`packages/exec/src/index.ts:251`、`packages/exec/src/index.ts:262`、`packages/exec/src/index.ts:279`

**失敗策略**：Fail-closed on the sandbox boundary (missing provider -> SandboxUnavailableError BEFORE spawning: index.ts:111-113; capability mismatch -> assertSandboxCapable throw: index.ts:116; runner failure -> reject with SandboxUnavailableError: index.ts:191). Everything else is ordinary result reporting rather than fail-closed: exit code, timedOut flag, and unknown-job lookups are throws (index.ts:273, index.ts:281). The spawn environment always merges process.env with cmd.env (index.ts:126) and stdio is pipe/pipe/pipe (index.ts:127).

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_MAX_OUTPUT_BYTES (exec spill)` | 64_000 | `packages/exec/src/index.ts:43` |
| `OutputCollector maxSpillBytes default` | 64 * 1024 * 1024 (64 MiB) | `packages/exec/src/spill.ts:35` |
| `default spill root` | mkdtempSync(<tmpdir>/i-harness-spill-) | `packages/exec/src/spill.ts:37` |
| `spill file mode` | 0o600, opened 'wx' | `packages/exec/src/spill.ts:81` |
| `background job id` | bash-<counter> | `packages/exec/src/index.ts:243` |
| `service key` | "exec/service" | `packages/exec/src/index.ts:291` |

**已知缺口（原始碼內標記）**

- M21 A-tier spill is foreground-only: runBackground deliberately passes no spill options and keeps plain stream accumulation (packages/exec/src/index.ts:231-233, packages/exec/src/index.ts:246).
- Accepted limitation on the runner-failure reject path: spill files already written stay behind as orphans (packages/exec/src/index.ts:183-184).
- On a spill OPEN failure the collector silently disables spilling (spillDisabled) and the result is marked lossy rather than erroring (packages/exec/src/spill.ts:84, packages/exec/src/spill.ts:69).

---

### `terminal`

PTY-backed terminal and process control: a TerminalService owning node-pty sessions with a ring-buffered, offset-addressable read log, session-owner gating, and six terminal_* tools plus three process_* tools mounted behind a ConPTY-noise error guard.

> npm `@i-harness/terminal` · 入口 `packages/terminal/src/index.ts` · 3 個原始檔 · 6 個匯出符號

**公開介面**：`createProcessTools`、`createTerminalService`、`createTerminalTools`、`filterConptyNoise`、`isKnownConptyNoise`、`registerTerminal`

**關鍵設計決策**

1. **Output is a per-terminal chunk log with documented UTF-16-code-unit offsets: read(offset) returns [offset, offset+maxBytes) and is repeatable/re-readable (log-view semantics, not consuming), the internal ring drops the oldest chunks past RING_MAX 1_000_000 units, and offsets earlier than the ring start are served from the ring start (a documented shortcoming). read defaults maxBytes to 64_000 and reports truncated when more remains.**
   - 理由：A poll-with-nextOffset model cannot lose data to a race the way a consuming queue can; the ring bounds memory for a long-running interactive session.
   - 出處：`packages/terminal/src/service.ts:67`、`packages/terminal/src/service.ts:74`、`packages/terminal/src/service.ts:110`、`packages/terminal/src/service.ts:122`、`packages/terminal/src/service.ts:176`
2. **Ownership is enforced per PTY: open() records the caller's exec.sessionId as ownerSessionId, and getOwned throws TERMINAL_NOT_FOUND for an unknown id and TERMINAL_OWNER_MISMATCH when the caller's session id differs from a recorded owner (an unowned session stays accessible to anyone).**
   - 理由：One session must not drive another session's interactive terminal; the ownership check lives in one helper used by every operation.
   - 出處：`packages/terminal/src/service.ts:138`、`packages/terminal/src/service.ts:141`、`packages/terminal/src/service.ts:160`、`packages/terminal/src/tool.ts:68`
3. **Sizing is tracked service-side rather than read from node-pty: view.cols/rows come from the tracked values, resize always updates them, and pty.resize is only issued when status is running AND the ConPTY is ready (the first onData), with a sync throw swallowed - because ConPTY's getters are asynchronous/stale after a resize and resizing an already-exited pty throws from node-pty's deferred queue as an async uncaught.**
   - 理由：M26-B2 win32 calibration: the tracked value is the only trustworthy size, and an uncaught async throw would fail the test/runtime.
   - 出處：`packages/terminal/src/service.ts:81`、`packages/terminal/src/service.ts:101`、`packages/terminal/src/service.ts:196`、`packages/terminal/src/service.ts:202`
4. **Known win32 ConPTY agent noise on the error path is filtered and may become a benign outcome: a regex matches 'AttachConsole failed' / 'conpty_console_list_agent', every tool's execute is wrapped by guardPtyErrors, matching lines are stripped from a thrown report, and a report that is ONLY noise converts to a returned { suppressed, note } result instead of an error.**
   - 理由：The fork'd conpty_console_list_agent writes to inherited stderr on every PTY kill (exit 0) and cannot be intercepted library-side; tool errors are the only escaping report.
   - 出處：`packages/terminal/src/service.ts:10`、`packages/terminal/src/service.ts:13`、`packages/terminal/src/tool.ts:24`、`packages/terminal/src/tool.ts:30`、`packages/terminal/src/tool.ts:38`

**失敗策略**：Fail-loud with a noise-tolerant error path. Unknown terminal ids and owner mismatches throw (service.ts:140, service.ts:142); waitExited on an unknown id rejects and dispose rejects all pending exit waiters (service.ts:211, service.ts:216-220); PTY noise-only errors are downgraded to a benign returned result by the tool-level guard (tool.ts:30-32). There is NO sandbox integration: grep for sandbox/Sandbox in packages/terminal/src returns no matches and TerminalToolDeps carries only service + cwd (tool.ts:5-11), so terminal_open/process_spawn spawn outside the exec sandbox and without timeoutMs.

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_COLS` | 80 | `packages/terminal/src/service.ts:63` |
| `DEFAULT_ROWS` | 24 | `packages/terminal/src/service.ts:64` |
| `DEFAULT_MAX_READ_BYTES` | 64_000 | `packages/terminal/src/service.ts:65` |
| `RING_MAX` | 1_000_000 UTF-16 code units | `packages/terminal/src/service.ts:75` |
| `service key` | "terminal/service" | `packages/terminal/src/tool.ts:171` |
| `signal mapping` | INT -> write \x03; TERM and KILL both -> pty.kill() | `packages/terminal/src/service.ts:183` |

**已知缺口（原始碼內標記）**

- No sandbox/confinement parameter on the PTY tools (packages/terminal/src/tool.ts:5-11, packages/terminal/src/tool.ts:164-174) and no timeoutMs on any of them (packages/terminal/src/tool.ts:42-160).
- Documented shortcoming: an offset earlier than the ring start is served from the ring start, and the dropped prefix is unrecoverable (packages/terminal/src/service.ts:73-75).
- No gap markers (TODO/FIXME/deferred/limitation) beyond the ring-buffer note.

---

### `text-diff`

Structured line-diff builder and unified renderer used by the fs write/read surfaces: wraps the `diff` library's structuredPatch into per-change-region hunks with literal 1-based old/new line numbers, bounds oversized inputs with index-aligned head/tail windows, and renders a unified patch.

> npm `@i-harness/text-diff` · 入口 `packages/text-diff/src/index.ts` · 1 個原始檔 · 9 個匯出符號

**公開介面**：`DEFAULT_CONTEXT`、`DiffHunk`、`DiffLine`、`MAX_BYTES`、`MAX_LINES`、`TextDiff`、`TextDiffOptions`、`createTextDiff`、`renderUnifiedDiff`

**關鍵設計決策**

1. **The diff algorithm is NOT hand-rolled: structuredPatch from the `diff` library does LCS/Myers, and the package's own work is normalization, hunk splitting and rendering.**
   - 理由：Stated explicitly: 'the algorithm/LCS/Myers engine is NOT hand-rolled'.
   - 出處：`packages/text-diff/src/index.ts:1`、`packages/text-diff/src/index.ts:166`
2. **Oversized inputs are windowed with position-aligned head and tail pairs instead of truncating the diff: head compares rows [0..N) on both sides, the tail pair is compared only when the two absolute ranges OVERLAP, and the union range is clamped so it never re-diffs head rows. A window of one side is never diffed against a positionally skewed window of the other, because that would fabricate deletions/additions from the skew (e.g. a pure append above the window size).**
   - 理由：A fabricated change is a lying diff; a size delta must appear as surplus rows at the end of the longer side, not as boundary skew.
   - 出處：`packages/text-diff/src/index.ts:79`、`packages/text-diff/src/index.ts:93`、`packages/text-diff/src/index.ts:118`、`packages/text-diff/src/index.ts:123`
3. **There is a hard work budget of 750 ms passed to structuredPatch as its abortable timeout; hitting it yields an honest bounded result (no hunks, truncated: true) instead of blocking the turn.**
   - 理由：'pathological low-similarity inputs must never block the turn'.
   - 出處：`packages/text-diff/src/index.ts:42`、`packages/text-diff/src/index.ts:168`、`packages/text-diff/src/index.ts:170`
4. **Hunks are split back into per-change-region hunks: the library merges two change regions when the context run between them is at most context*2 rows, so convertHunk cuts the merged hunk at each gap (keeping up to `context` rows of padding) and derives each hunk's oldStart/newStart/oldLines/newLines from the literal line numbers actually walked. '\ No newline at end of file' annotates the previous row instead of consuming a row, and is re-emitted by the renderer. CRLF/CR are normalized to LF before diffing; the structured rows carry no line endings.**
   - 理由：Per-region hunks keep the model's view of a change locality honest; treating the no-newline marker as a row would shift every subsequent line number.
   - 出處：`packages/text-diff/src/index.ts:189`、`packages/text-diff/src/index.ts:205`、`packages/text-diff/src/index.ts:241`、`packages/text-diff/src/index.ts:258`、`packages/text-diff/src/index.ts:49`

**失敗策略**：Fail-soft and bounded: no path throws for pathological input. Oversized input degrades to the windowed diff with truncated:true (index.ts:65-67), a timeout degrades to an empty truncated result (index.ts:170-172), and an empty diff renders an empty patch body (index.ts:276-286). Caller misuse cannot be expressed - context is clamped with Math.max(0, ...) (index.ts:62).

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_CONTEXT` | 3 | `packages/text-diff/src/index.ts:37` |
| `MAX_LINES` | 50_000 | `packages/text-diff/src/index.ts:38` |
| `MAX_BYTES` | 2 * 1024 * 1024 | `packages/text-diff/src/index.ts:39` |
| `WINDOW_LINES` | 10_000 (per head/tail window half) | `packages/text-diff/src/index.ts:41` |
| `DIFF_TIMEOUT_MS` | 750 | `packages/text-diff/src/index.ts:44` |

**已知缺口（原始碼內標記）**

- No gap markers (TODO/FIXME/deferred/limitation) in packages/text-diff/src; truncation and timeout are designed outcomes with explicit flags rather than deferrals.

---

### `todo`

The todo_write tool: a whole-list snapshot model where every call replaces the previous list, validated (non-empty content, no duplicate content, at most one in_progress by default) and persisted as a todo/write session event, with deriveTodoList() as the pure projection.

> npm `@i-harness/todo` · 入口 `packages/todo/src/index.ts` · 1 個原始檔 · 4 個匯出符號

**公開介面**：`TodoToolDeps`、`createTodoTool`、`deriveTodoList`、`validateTodoItems`

**關鍵設計決策**

1. **Whole-list replace, no merge: the model must send the WHOLE list every call and it REPLACES the previous one, which the header states keeps status tracking race-free (last write wins, no merge logic), and the list lives in the session log as todo/write events so projection is a pure function and persistence mirrors it for free.**
   - 理由：Merge semantics on a concurrently-updated list would need conflict resolution; a snapshot does not.
   - 出處：`packages/todo/src/index.ts:1`、`packages/todo/src/index.ts:34`、`packages/todo/src/index.ts:56`
2. **Validation is fail-loud inside the tool body: empty/whitespace content and duplicate content throw, and more than one in_progress item throws unless allowParallelInProgress is set.**
   - 理由：One in_progress item is the planner invariant; duplicates make status reporting ambiguous.
   - 出處：`packages/todo/src/index.ts:19`、`packages/todo/src/index.ts:22`、`packages/todo/src/index.ts:26`
3. **The tool declares isConcurrencySafe: true (a whole-list replace has no read-modify-write hazard) while isReadOnly is false, and the projection is last-event-wins over session.events.**
   - 理由：Concurrency safety follows from replace semantics; the projection must be a pure fold so replay is deterministic.
   - 出處：`packages/todo/src/index.ts:52`、`packages/todo/src/index.ts:67`

**失敗策略**：Fail-loud: validation errors throw out of the tool body (index.ts:20, index.ts:22, index.ts:27) rather than being returned, unlike the fs family; there is no try/catch anywhere in the module.

**事件**：`todo/write (produced at packages/todo/src/index.ts:56; consumed by deriveTodoList at packages/todo/src/index.ts:70; union member declared at packages/core-session/src/index.ts:57)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `status vocabulary` | pending \| in_progress \| completed | `packages/todo/src/index.ts:44` |
| `in_progress limit default` | 1 (unless allowParallelInProgress) | `packages/todo/src/index.ts:26` |

**已知缺口（原始碼內標記）**

- No gap markers (TODO/FIXME/deferred/limitation) in packages/todo/src.

---

### `tool-search`

The deferred-tool retrieval mechanism: a self-developed BM25 engine (exact-name, select: list, +required-term, and natural-language modes) plus registerToolSearch, which installs that engine into the core-tools registry and registers the direct-exposure tool_search tool.

> npm `@i-harness/tool-search` · 入口 `packages/tool-search/src/index.ts` · 3 個原始檔 · 7 個匯出符號

**公開介面**：`ToolSearchConfig`、`Searchable`、`SearchOptions`、`registerToolSearch`、`search`、`searchText`、`splitName`、`tokenize`、`toolSearchName`

**關鍵設計決策**

1. **The engine is pure functions over a caller-supplied corpus (no I/O, no registry knowledge): splitName camelCase/dash/underscore splitting and tokenize with an English stopword set feed both searchText (name + split name + description + searchHint + recursively harvested JSON-schema titles/descriptions/property names/items/anyOf/oneOf/allOf/enum values) and the BM25 document frequencies.**
   - 理由：Modeled on opencode-fork's tool-search but kept dependency-free so it can be unit-tested and reused by the skills package.
   - 出處：`packages/tool-search/src/search.ts:1`、`packages/tool-search/src/search.ts:22`、`packages/tool-search/src/search.ts:36`、`packages/tool-search/src/search.ts:62`
2. **Four selection modes with a strict precedence: 'select:a,b' resolves EXACT tool names and throws on an unknown selector (and on more than `limit` matches); an exact case-insensitive name match returns that single tool immediately; '+term' tokens become REQUIRED (every one must be in the document's token set) while the remaining terms only rank; otherwise all terms rank by BM25 with k1 1.2 / b 0.75 and a tie-break by name for determinism.**
   - 理由：An agent that knows the name must not be at the mercy of a ranker, and a missing exact selector must fail loud instead of returning a fuzzy list; the deterministic tie-break keeps repeated calls stable.
   - 出處：`packages/tool-search/src/search.ts:83`、`packages/tool-search/src/search.ts:90`、`packages/tool-search/src/search.ts:99`、`packages/tool-search/src/search.ts:141`、`packages/tool-search/src/search.ts:124`
3. **The deferred mechanism is a two-sided contract with core-tools: registerToolSearch calls registry.installSearch(...) with an engine that searches registry.deferredSearchIndex() (the DEFERRED corpus only) and maps hits back into ToolSchema with exposure 'deferred'; core-tools then PROMOTES every returned name so those tools appear in schemas() on the next provider call. The tool_search tool itself is exposure 'direct', isReadOnly, and returns { query, matches, totalDeferred }.**
   - 理由：Keeps the engine ignorant of the registry while the registry owns promotion; the model discovers deferred tools without them occupying the standing catalog.
   - 出處：`packages/tool-search/src/index.ts:20`、`packages/tool-search/src/index.ts:25`、`packages/tool-search/src/index.ts:29`、`packages/tool-search/src/tool.ts:23`、`packages/tool-search/src/tool.ts:28`、`packages/core-tools/src/index.ts:335`
4. **Query and limit validation is fail-loud at the engine boundary: an empty query throws, and limit must be an integer in [1, MAX_LIMIT] with DEFAULT_LIMIT 8 applied when neither limit nor defaultLimit is given; registerToolSearch's own defaultLimit is also 8.**
   - 理由：An empty query has no defined ranking; an out-of-range limit is a caller bug, not a request for a different number.
   - 出處：`packages/tool-search/src/search.ts:73`、`packages/tool-search/src/search.ts:75`、`packages/tool-search/src/search.ts:77`、`packages/tool-search/src/index.ts:19`

**失敗策略**：Fail-loud at validation boundaries (empty query, bad limit, unknown exact selector, select list exceeding the limit: search.ts:75, search.ts:78, search.ts:85, search.ts:90, search.ts:95) and fail-loud at the registry seam (search() with no installed engine throws 'no search engine installed', core-tools/src/index.ts:333). Zero matches is a normal empty array, not an error (search.ts:104, search.ts:123 filter).

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_LIMIT` | 8 | `packages/tool-search/src/search.ts:5` |
| `MAX_LIMIT` | 20 | `packages/tool-search/src/search.ts:6` |
| `BM25 K1` | 1.2 | `packages/tool-search/src/search.ts:7` |
| `BM25 B` | 0.75 | `packages/tool-search/src/search.ts:8` |
| `tool name` | "tool_search" | `packages/tool-search/src/tool.ts:3` |
| `STOPWORDS` | the, a, an, of, to, and, or, for, in, on, with, is, are, my | `packages/tool-search/src/search.ts:4` |

**已知缺口（原始碼內標記）**

- No gap markers (TODO/FIXME/deferred/limitation) in packages/tool-search/src.

---

### `skills`

SKILL.md deferred retrieval: a registry that scans <workspace>/skills and the global ~/.i-harness/skills root (workspace overrides global), a YAML front-matter parser, BM25 search reused from tool-search, an implicit-invocation gate with a shadow-selector telemetry report, and the skill_search / skill_get tools plus their plugin/mount forms.

> npm `@i-harness/skills` · 入口 `packages/skills/src/index.ts` · 6 個原始檔 · 43 個匯出符號

**公開介面**：`MAX_SKILL_DEPTH`、`MAX_SKILL_ENTRIES`、`SKILL_FILE`、`SKILL_NAME_MAX_LENGTH`、`SKILL_NAME_PATTERN`、`SkillToolError`、`createSkillGetTool`、`createSkillRegistry`、`createSkillSearchTool`、`createSkillsPlugin`、`explicitMentionMatches`、`isValidSkillName`、`parseFrontmatter`、`registerSkills`、`searchSkillSummaries`、`selectShadowCandidates`、`skillGetName`、`skillSearchName`、`skillsPluginName`、`skillsServiceName`、`toSearchable`、`ParsedSkill`、`SearchOptions`、`Searchable`、`ShadowCandidate`、`ShadowReport`、`Skill`、`SkillFrontmatter`、`SkillGetArgs`、`SkillGetOutput`、`SkillRegistry`、`SkillRegistryDeps`、`SkillSearchArgs`、`SkillSearchMatch`、`SkillSearchOutput`、`SkillSelectorEvent`、`SkillSource`、`SkillSummary`、`SkillTelemetryEmitter`、`SkillToolDeps`、`SkillToolErrorCode`、`SkillsMountConfig`、`SkillsMountHandle`

**關鍵設計決策**

1. **Bodies stay DEFERRED: list() and searchSkills() touch summaries only (name/description/path/source), the BM25 searchable text is exactly name + description with NO inputSchema and NO searchHint, and getSkill() re-reads the SKILL.md fresh. The registry rescans per access instead of watching (documented as a v0 choice because scanning a handful of files is cheap) and one bad skill warns and skips rather than breaking the registry.**
   - 理由：Deferred retrieval is the whole point: bodies are the expensive part and must be loaded only when asked for; a single malformed SKILL.md must not take down the whole skill surface.
   - 出處：`packages/skills/src/registry.ts:1`、`packages/skills/src/registry.ts:5`、`packages/skills/src/search.ts:1`、`packages/skills/src/registry.ts:159`
2. **Front-matter is validated strictly through the real `yaml` parser, not line-oriented parsing: the document must begin with a trimmed `---` fence line and close it; the meta block must be a YAML mapping; any nested/non-scalar value ANYWHERE in the block invalidates the whole document; name/description present but non-string is invalid; description whitespace runs are collapsed to one line (YAML folding). Name defaults to the directory name when absent, and must satisfy the kebab-case pattern with a length cap.**
   - 理由：Hand-rolled parsing would silently mis-parse a description, which means wrong guidance for the model; forward compatibility is preserved by tolerating unknown scalar keys.
   - 出處：`packages/skills/src/frontmatter.ts:1`、`packages/skills/src/frontmatter.ts:32`、`packages/skills/src/frontmatter.ts:49`、`packages/skills/src/frontmatter.ts:53`、`packages/skills/src/registry.ts:104`
3. **skill_search is the deferred-retrieval entry and skill_get the explicit body load; both are exposure 'direct' and isReadOnly so the model can DISCOVER skills it does not know exist. skill_get renders a <skill_content> block with an XML-escaped body, the base directory, and a SAMPLED file list (hidden entries and SKILL.md excluded, sorted, capped, marked 'sampled N of M').**
   - 理由：Discovery must not require prior knowledge; the sample note keeps the model from assuming the list is complete.
   - 出處：`packages/skills/src/tool.ts:1`、`packages/skills/src/tool.ts:100`、`packages/skills/src/tool.ts:152`、`packages/skills/src/tool.ts:227`、`packages/skills/src/tool.ts:234`
4. **Implicit invocation is gated and separately OBSERVED: the shadow selector runs before the real selection, is deterministic and pure, caps at 8 candidates, unions the exact/select matches, the real BM25 hits and a lexical substring variant, and emits a skill/selector-shadow telemetry row through an injected emitter - never changing behavior and swallowing a malformed query. When allowImplicitInvocation is false, skill_search returns ONLY explicit mention matches (whole skill name as a query word, or a select: list) and a keyword query returns an EMPTY list while skill_get stays available; the default is true.**
   - 理由：M27 R-B6 needs offline evidence of what a variant selector would pick without perturbing the live selection; the gate lets a host switch to explicit-only invocation without losing the loading path.
   - 出處：`packages/skills/src/shadow.ts:1`、`packages/skills/src/shadow.ts:103`、`packages/skills/src/shadow.ts:143`、`packages/skills/src/tool.ts:108`、`packages/skills/src/tool.ts:119`
5. **getSkill distinguishes 'broken' from 'not found': if the valid index lacks the name it probes the conventional <root>/<name>/SKILL.md locations (workspace first) and lets readSkillFile THROW a coded SkillToolError (SKILL_INVALID_FRONTMATTER / SKILL_INVALID_NAME) so the tool tells the model to repair the file instead of reporting a misleading SKILL_NOT_FOUND. All tool errors carry a remedy sentence.**
   - 理由：A skill that exists but is broken must not look absent; the model can only fix what it is told about.
   - 出處：`packages/skills/src/registry.ts:34`、`packages/skills/src/registry.ts:189`、`packages/skills/src/registry.ts:209`、`packages/skills/src/tool.ts:157`

**失敗策略**：Tiered. Scan is fail-soft: a missing root is silent, an unreadable directory warns, a per-skill error warns and is skipped (registry.ts:138-142, registry.ts:159-162), and the entry cap warns once and stops descending (registry.ts:155-158). Explicit requests are fail-closed and loud: skill_get throws SKILL_INVALID_NAME for an empty/malformed name and SKILL_NOT_FOUND for an unknown one (tool.ts:157, tool.ts:163, tool.ts:170), and a broken on-disk skill throws a coded error with a remedy (registry.ts:95, registry.ts:99, registry.ts:106, registry.ts:113). The shadow report never throws - a malformed query is swallowed (shadow.ts:126-129) and an empty query reports an empty list (shadow.ts:118).

**事件**：`skill/selector-shadow (telemetry event passed to an injected SkillTelemetryEmitter; NOT a SessionEventMap member - packages/skills/src/shadow.ts:33, emitted at packages/skills/src/tool.ts:109)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `SKILL_NAME_PATTERN` | /^[a-z0-9]+(?:-[a-z0-9]+)*$/ | `packages/skills/src/registry.ts:51` |
| `SKILL_NAME_MAX_LENGTH` | 64 | `packages/skills/src/registry.ts:52` |
| `SKILL_FILE` | "SKILL.md" | `packages/skills/src/registry.ts:53` |
| `MAX_SKILL_DEPTH` | 4 directory levels below the skills root | `packages/skills/src/registry.ts:55` |
| `MAX_SKILL_ENTRIES` | 256 per root | `packages/skills/src/registry.ts:58` |
| `MODEL_FILE_LIMIT` | 10 sampled files in the rendered content | `packages/skills/src/tool.ts:32` |
| `SHADOW_LIMIT` | 8 (clamped to max 20) | `packages/skills/src/shadow.ts:51` |
| `global skills root` | join(homedir(), '.i-harness', 'skills') | `packages/skills/src/registry.ts:78` |

**已知缺口（原始碼內標記）**

- v0 has no watcher - the registry rescans on every access (packages/skills/src/registry.ts:5-6).
- The 'skills' service stays registered after unmount: the plugin's unmount only reclaims the two tools because core-plugin's service store has no unregister seam in v0 (packages/skills/src/tool.ts:286-289, packages/skills/src/tool.ts:301-304).

---

### `lsp`

Language-server integration: a Content-Length-framed JSON-RPC connection over a spawned subprocess, an LspInstance with an initialize handshake, a serialized abortable query queue and transient didOpen/didClose lifecycles, pure wire-payload normalizers, text renderers with caps, and the lsp + lsp_diagnostics tools mounted by a one-server-per-run scheduler.

> npm `@i-harness/lsp` · 入口 `packages/lsp/src/index.ts` · 10 個原始檔 · 22 個匯出符號

**公開介面**：`LspConnection`、`LspInstance`、`MessageDecoder`、`LspToolConfig`、`LspMountHandle`、`LspServerConfig`、`createLspTools`、`encodeMessage`、`formatCallHierarchyCalls`、`formatCallHierarchyItem`、`formatDiagnostics`、`formatHover`、`formatLocations`、`formatSymbols`、`isPos`、`mountLspClient`、`normalizeCallHierarchyCalls`、`normalizeCallHierarchyItems`、`normalizeDiagnostics`、`normalizeHover`、`normalizeLocations`、`normalizeSymbols`、`resolveFileInWorkspace`、`spawnLspConnection`、`validateLspConfig`

**關鍵設計決策**

1. **Only Content-Length is parsed and every frame is bounded: the decoder rejects a missing/odd Content-Length header and any message larger than maxMessageBytes (default 16 MB) by THROWING, and the connection treats an undecodable frame as stream corruption and fails ALL pending requests. Stderr is kept bounded to the last maxStderrBytes (default 1 MB) as a diagnostic tail.**
   - 理由：A malformed frame cannot be resynchronized, so continuing would desynchronize the stream; a bounded stderr tail preserves the last error without unbounded memory.
   - 出處：`packages/lsp/src/protocol.ts:1`、`packages/lsp/src/protocol.ts:20`、`packages/lsp/src/protocol.ts:23`、`packages/lsp/src/connection.ts:72`、`packages/lsp/src/connection.ts:48`
2. **Requests are abortable at the protocol level: an already-aborted signal rejects immediately, a later abort sends $/cancelRequest, drops the pending entry and rejects with 'aborted', and the abort listener is removed on settle. Server->client REQUESTS are always answered (with -32601 if no handler), because JSON-RPC mandates a response or the server hangs; server->client NOTIFICATIONS are ignored by design (the M18 pull model).**
   - 理由：An unanswered server request deadlocks a language server; ignoring notifications keeps the client from acting on pushes it never asked for.
   - 出處：`packages/lsp/src/connection.ts:111`、`packages/lsp/src/connection.ts:118`、`packages/lsp/src/connection.ts:143`、`packages/lsp/src/connection.ts:83`、`packages/lsp/src/connection.ts:87`
3. **All queries are SERIALIZED on one promise chain and each runs a transient didOpen -> request -> didClose(finally) lifecycle with version 1 and the file contents as the document text; a failed query does not stall later ones because the chain continues via the (run, run) continuation form. Two operation classes dispatch differently: workspaceSymbol/incomingCalls/outgoingCalls go straight to the connection without opening a document, while the textDocument operations run inside withOpenDocument.**
   - 理由：One query at a time is the documented spec §3.4 model, and the transient lifecycle means the server always analyzes the CURRENT bytes rather than a stale open buffer.
   - 出處：`packages/lsp/src/instance.ts:154`、`packages/lsp/src/instance.ts:157`、`packages/lsp/src/instance.ts:159`、`packages/lsp/src/instance.ts:186`、`packages/lsp/src/instance.ts:202`
4. **Capability gating is fail-closed: before dispatch, the operation's capability key is looked up from the initialize result and an explicit false OR an ABSENT key throws LSP_UNSUPPORTED_OPERATION (absent counts as unsupported). The initialize handshake is bounded by startupTimeoutMs (default 10 000) via Promise.race, whose timeout error is the one that surfaces, and a late rejection after the timeout win is swallowed.**
   - 理由：Sending an unsupported method produces an opaque server error; an absent capability is not evidence of support.
   - 出處：`packages/lsp/src/instance.ts:197`、`packages/lsp/src/instance.ts:198`、`packages/lsp/src/instance.ts:130`、`packages/lsp/src/instance.ts:142`、`packages/lsp/src/instance.ts:141`
5. **Teardown is bounded in four steps and never waits forever: shutdown request bounded by shutdownTimeoutMs (default 4000, a failure or timeout is swallowed as best-effort) -> exit notification (best-effort) -> grace of killGraceMs (default 5000) waiting for conn.closed -> kill escalation. dispose() is idempotent via a disposed flag that also makes later queries throw.**
   - 理由：A hung language server must not hold the host open; the grace period gives a well-behaved server the chance to exit before the kill.
   - 出處：`packages/lsp/src/instance.ts:263`、`packages/lsp/src/instance.ts:267`、`packages/lsp/src/instance.ts:275`、`packages/lsp/src/instance.ts:289`、`packages/lsp/src/instance.ts:176`
6. **Mount is one server per RUN, enforced by a module-level reservation set: a second mount with the same serverName is a hard error, and a second mount with a DIFFERENT name is ALSO a hard error ('only one LSP server per run is supported (M18 core)' - multi-server is an explicit non-goal). A failed mount disposes the instance, unregisters any half-registered tools and releases the reservation; unmount is idempotent and releases the reservation even when dispose throws.**
   - 理由：The tool surface has no server selector, so two live servers would be ambiguous; releasing the reservation in a finally block prevents a permanent lockout after a bad mount.
   - 出處：`packages/lsp/src/scheduler.ts:18`、`packages/lsp/src/scheduler.ts:23`、`packages/lsp/src/scheduler.ts:38`、`packages/lsp/src/scheduler.ts:70`、`packages/lsp/src/scheduler.ts:89`
7. **Normalization is a separate, pure, fail-closed seam and rendering is separately capped: malformed wire entries are discarded while well-formed ones are kept (never a throw), DocumentSymbol trees are flattened depth-first with the opened document's uri injected, the tool layer enforces that the mounted server actually serves the file's extension (LSP_NO_SERVER_FOR_FILE), and the 1-based arg coordinates are converted to 0-based wire positions (and back at render). lsp_diagnostics does an optional cursor filter: line must overlap, and character (only with line) must be contained in BOTH dimensions.**
   - 理由：Keeping translation pure makes it unit-testable and keeps a partially malformed payload useful; the extension gate produces a legible error instead of a server-side mystery.
   - 出處：`packages/lsp/src/translate.ts:1`、`packages/lsp/src/translate.ts:25`、`packages/lsp/src/translate.ts:77`、`packages/lsp/src/tools.ts:27`、`packages/lsp/src/tools.ts:136`

**失敗策略**：Fail-closed on protocol and capability boundaries: undecodable/oversized frames fail all pending requests (connection.ts:72-74, protocol.ts:21-23); unsupported operations throw (instance.ts:199); a hung initialize rejects ready with LSP_INITIALIZE_TIMEOUT (instance.ts:145); requests on a disposed instance throw (instance.ts:176, instance.ts:196); a failed mount disposes and releases the reservation (scheduler.ts:70-79). Caller-argument errors inside the tools throw with the server name and the missing argument (tools.ts:66-76), and the extension gate throws (tools.ts:34). Best-effort-only: kill() on an already-dead process (connection.ts:148-153) and shutdown/exit during dispose (instance.ts:280-287).

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `maxMessageBytes default` | 16 * 1024 * 1024 | `packages/lsp/src/scheduler.ts:48` |
| `maxStderrBytes default` | 1_000_000 | `packages/lsp/src/scheduler.ts:49` |
| `killGraceMs default` | 5_000 | `packages/lsp/src/scheduler.ts:50` |
| `shutdownTimeoutMs default` | 4_000 | `packages/lsp/src/scheduler.ts:51` |
| `startupTimeoutMs default` | 10_000 | `packages/lsp/src/instance.ts:126` |
| `serverName pattern` | /^[A-Za-z0-9_-]{1,32}$/ | `packages/lsp/src/types.ts:17` |
| `render caps` | maxLocations 100, maxResultChars 16000, maxResults 50 (diagnostics) | `packages/lsp/src/render.ts:7` |
| `SEVERITY_LABELS` | 1 Error, 2 Warning, 3 Information, 4 Hint (else 'Unknown') | `packages/lsp/src/render.ts:12` |

**已知缺口（原始碼內標記）**

- Multi-server is an explicit M18 non-goal: only ONE LSP server per run can be mounted, and a second (even differently named) mount is a hard error (packages/lsp/src/scheduler.ts:20-24, packages/lsp/src/scheduler.ts:38-40).
- The package exposes no workspace/configuration or diagnostic-push handling: server->client notifications are ignored by design (packages/lsp/src/connection.ts:87), so pull-only (textDocument/diagnostic) is the diagnostic path.
- languages matching is extension-only (last dot of the basename) and resolveFileInWorkspace is exported but the tools use their own resolve() (packages/lsp/src/session-cwd.ts:5, packages/lsp/src/tools.ts:79).

---

### `mcp-client`

Model Context Protocol client: transport construction (stdio / streamable-http), an OAuth 2.1 provider + local callback server, tool/resource bridging into the core-tools registry with name normalization, and a generation-based reconnect supervisor with backoff, an overlap guard and per-generation tool re-sync.

> npm `@i-harness/mcp-client` · 入口 `packages/mcp-client/src/index.ts` · 12 個原始檔 · 18 個匯出符號

**公開介面**：`MAX_PUBLIC_NAME_LENGTH`、`McpOAuthError`、`McpServerUnavailableError`、`assertServerName`、`challengeFor`、`createConnectedClient`、`createMcpSupervisor`、`createMcpTool`、`createOAuthCallbackServer`、`createOAuthClientProvider`、`createResourceTools`、`createTransport`、`generateCodeVerifier`、`mountMcpClient`、`publicToolName`、`resolveRootUris`、`syncTools`、`validateMcpConfig`

**關鍵設計決策**

1. **Reconnection is GENERATION-based: every reconnect builds a NEW client + transport; transport death calls generationDown guarded by an isCurrent identity check (so stale/duplicate notifications are no-ops); backoff is min(maxDelayMs, initialDelayMs * 2^(n-1)); a generation that stays alive >= maxDelayMs resets the attempt budget; beyond maxRetries the supervisor unregisters ALL of the server's tools, stops reconnecting and emits state 'lost' exactly once. Timers are cleared on close and unref'd so they never keep the process alive.**
   - 理由：A dead transport cannot be reused (the SDK aborts it on connect failure), so a fresh generation is the only correct retry unit; an identity guard plus idempotent scheduling is what prevents two overlapping child processes.
   - 出處：`packages/mcp-client/src/supervisor.ts:8`、`packages/mcp-client/src/supervisor.ts:221`、`packages/mcp-client/src/supervisor.ts:210`、`packages/mcp-client/src/supervisor.ts:240`、`packages/mcp-client/src/supervisor.ts:178`、`packages/mcp-client/src/supervisor.ts:67`
2. **A stable PROXY is what tool closures bind, never a raw generation client: every call consults `current` at call time and fails fast with McpServerUnavailableError while no generation exists, so a call during an outage errors immediately instead of hanging on a dead transport.**
   - 理由：Tools registered in the registry outlive individual generations; they must route dynamically and fail fast.
   - 出處：`packages/mcp-client/src/supervisor.ts:103`、`packages/mcp-client/src/supervisor.ts:110`、`packages/mcp-client/src/errors.ts:4`
3. **Overlap guard: a failing generation must CLOSE within 5_000 ms or reconnecting stops and the server goes 'lost' with an explanatory message, because two live stdio children for one server is forbidden. Ownership guards around resync (gen !== current) route each failure to exactly ONE failCycle, preventing double-scheduled retries.**
   - 理由：A leaked retry timer would run an attempt twice and spawn two overlapping generations - the exact failure the guard exists to forbid.
   - 出處：`packages/mcp-client/src/supervisor.ts:59`、`packages/mcp-client/src/supervisor.ts:297`、`packages/mcp-client/src/supervisor.ts:288`、`packages/mcp-client/src/supervisor.ts:313`
4. **Tool sync is two-phase and registry-conflict behavior depends on the phase: phase 1 drains ALL pages (cap 100 pages, duplicate public name within one listing throws) and detects blocked tools without touching the registry; phase 2 disposes the previous generation's tools, then registers the new ones, rolling back everything registered so far on a failure. On INITIAL sync (previous empty) the conflict PROPAGATES so the mount fails closed; on a re-sync it logs a warning and returns an empty map so a working client keeps running. blockedTools never enter the map; directTools non-empty switches every unlisted tool to exposure 'deferred'; unknown entries in either list warn without failing.**
   - 理由：Spec §3.4: a squatted name must not be silently ignored at startup, but a transient conflict mid-life must not kill an already-running session.
   - 出處：`packages/mcp-client/src/bridge.ts:34`、`packages/mcp-client/src/bridge.ts:74`、`packages/mcp-client/src/bridge.ts:82`、`packages/mcp-client/src/bridge.ts:90`、`packages/mcp-client/src/bridge.ts:94`、`packages/mcp-client/src/bridge.ts:86`
5. **Public tool names are `mcp__<serverName>__<rawName>`, sanitized to [A-Za-z0-9_-] and capped at 64 chars, with a 12-hex SHA-256 suffix appended whenever normalization or truncation CHANGED the name - and forced whenever either segment itself contains '__', because that would make the join ambiguous to parse back. The raw name is what is sent on the wire; the public name is never parsed back.**
   - 理由：Distinct (server, tool) identities must never collapse into one registry name; an ambiguous join would make two different tools alias.
   - 出處：`packages/mcp-client/src/naming.ts:3`、`packages/mcp-client/src/naming.ts:17`、`packages/mcp-client/src/naming.ts:23`、`packages/mcp-client/src/naming.ts:25`
6. **OAuth is a fail-closed loop around the official SDK provider: each attempt builds a NEW transport (the SDK aborts a transport on connect failure), an UnauthorizedError starts the browser flow and the code is awaited on a 127.0.0.1-only callback server whose handler requires a non-empty code AND state equal to the expected flow state (CSRF); after 3 Unauthorized attempts it throws McpOAuthError. Tokens/verifier/state/client/discovery live behind an injected McpTokenStore with a memory write-through layer. Token refresh is proactive and fail-SOFT: a 60 s expiry skew triggers a single-flight refresh, any failure returns the stored token, warns, notifies the host via onAuthRefreshFailed, and discards the cached discovery when the error is not an OAuthError or two consecutive failures occurred - the stored credential is never cleared.**
   - 理由：A missing authorization code or a mismatched state must not be accepted; a failed refresh must not destroy a working token, because the 401/M53 reconnect path owns recovery.
   - 出處：`packages/mcp-client/src/client.ts:82`、`packages/mcp-client/src/client.ts:96`、`packages/mcp-client/src/client.ts:103`、`packages/mcp-client/src/oauth-callback.ts:16`、`packages/mcp-client/src/oauth-callback.ts:34`、`packages/mcp-client/src/oauth.ts:42`、`packages/mcp-client/src/oauth.ts:141`、`packages/mcp-client/src/oauth.ts:203`
7. **An auth-class failure on a LIVE request (only the SDK's UnauthorizedError or this package's McpOAuthError) tears the generation down so the supervisor can rebuild it - but ONLY when someone observes the death (a registered onDisconnect callback or reconnect.enabled). A one-shot mount keeps the pre-M53 behavior: surface the error and leave the client alive, because closing it would kill the transport permanently with nothing able to replace it. Teardown is single-flight and stops the callback server FIRST so a fixed callbackPort is free before the next generation rebinds it.**
   - 理由：Generic 5xx/network errors must never tear a healthy generation down, and an unobserved teardown is a self-inflicted outage.
   - 出處：`packages/mcp-client/src/client.ts:75`、`packages/mcp-client/src/client.ts:80`、`packages/mcp-client/src/client.ts:197`、`packages/mcp-client/src/client.ts:208`、`packages/mcp-client/src/client.ts:189`

**失敗策略**：Explicitly split by phase. Startup failure is a MOUNT failure that rejects (supervisor.ts:322-333, scheduler.ts:77-83) unless failOnStartupError is false, in which case the mount logs a warning and mounts EMPTY (scheduler.ts:80-82). Runtime generation death is fail-soft-but-bounded: retry with backoff up to maxRetries, then 'lost' with all tools unregistered (supervisor.ts:198-201). Calls with no live generation fail FAST with McpServerUnavailableError (supervisor.ts:107-133). Registry conflicts are fail-closed on initial sync and fail-soft (rollback + warn) on re-sync (bridge.ts:90-100). A tool result with isError throws 'tool error: <json>' from the tool body (bridge.ts:25-28). Config validation is fail-loud up front (types.ts:80-131).

**事件**：`mcp/server-status (host status callback carrying { server, state: connecting|ready|reconnecting|lost, attempts?, lastError?, authRefreshFailed? }; the code states it is NOT a SessionEventMap member - packages/mcp-client/src/supervisor.ts:22-35, emitted at supervisor.ts:88-96)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `MAX_PUBLIC_NAME_LENGTH` | 64 | `packages/mcp-client/src/naming.ts:6` |
| `HASH_LENGTH (name suffix)` | 12 hex chars | `packages/mcp-client/src/naming.ts:8` |
| `DEFAULT_INITIAL_DELAY_MS` | 1_000 | `packages/mcp-client/src/supervisor.ts:56` |
| `DEFAULT_MAX_DELAY_MS` | 30_000 | `packages/mcp-client/src/supervisor.ts:57` |
| `DEFAULT_MAX_RETRIES` | 5 | `packages/mcp-client/src/supervisor.ts:58` |
| `OVERLAP_GUARD_MS` | 5_000 | `packages/mcp-client/src/supervisor.ts:61` |
| `tool list pagination cap` | 100 pages | `packages/mcp-client/src/bridge.ts:74` |
| `toolCallTimeoutMs default` | 60_000 | `packages/mcp-client/src/client.ts:141` |
| `MAX_AUTH_ATTEMPTS` | 3 | `packages/mcp-client/src/client.ts:69` |
| `AUTH_RETRY_DELAY_MS` | 1_000 | `packages/mcp-client/src/client.ts:70` |
| `auth.authTimeoutMs default` | 300_000 | `packages/mcp-client/src/client.ts:95` |
| `EXPIRY_SKEW_MS (proactive refresh)` | 60_000 | `packages/mcp-client/src/oauth.ts:42` |
| `serverName pattern` | /^[A-Za-z0-9_-]{1,32}$/ | `packages/mcp-client/src/types.ts:82` |
| `blockedTools/directTools cap` | 200 entries, /^[A-Za-z0-9_-]{1,64}$/, no duplicates | `packages/mcp-client/src/types.ts:71` |

**已知缺口（原始碼內標記）**

- resources/templates/list is optional in the client interface and the tool throws a build-shape error when the mounted client lacks it (packages/mcp-client/src/resources.ts:46, packages/mcp-client/src/client.ts:66).
- OAuth redirect handling is headless by default: no browser is opened automatically - the URL goes to the console, the token store and the optional onRedirect callback (packages/mcp-client/src/oauth.ts:220-226).
- No gap markers (TODO/FIXME/deferred/limitation) otherwise; the SDK-1.30 transport-reuse constraint is documented as the reason for new transports rather than as an open defect (packages/mcp-client/src/client.ts:85-87).

---

### `workspace`

A durable Workspace registry over the session coordinator's generic document store: it owns the workspace records (id/path/title/sessionIds/timestamps) plus a registry-global archived-session display set, and separately exports a bounded directory walker used as the '@' file-reference provider. It performs no filesystem mutation and no path realpath/stat itself.

> npm `@i-harness/workspace` · 入口 `packages/workspace/src/index.ts` · 2 個原始檔 · 15 個匯出符號

**公開介面**：`DEFAULT_LIST_FILES_OPTIONS`、`DEFAULT_LIST_FILES_SKIP_NAMES`、`WORKSPACE_DOC_KEY`、`Workspace`、`WorkspaceBadRequestError`、`WorkspaceInvalidPathError`、`WorkspaceNameConflictError`、`WorkspaceNotFoundError`、`WorkspaceRegistry`、`WorkspaceSnapshot`、`WorkspaceUnknownSessionError`、`createWorkspaceRegistry`、`listWorkspaceFiles`、`FileReferenceCandidate`、`ListWorkspaceFilesOptions`

**關鍵設計決策**

1. **It OWNS exactly one durable document (`workspace-registry`) reached through the injected SessionCoordinator's generic getDocument/putDocument, in the subagent-snapshot pattern: a versioned whole-state snapshot { formatVersion: 1, workspaces, archivedSessionIds? }. The REGISTRY has no fs at all - create() does pure string normalization only and the comment states the caller (host route) realpaths the path and stats the directory before calling; the walker lives in a separate module because the registry stays fs-free.**
   - 理由：Keeping the registry pure makes it testable over any coordinator backend and keeps the path-trust decision in the host, which is the layer that owns the route and the trust boundary.
   - 出處：`packages/workspace/src/index.ts:5`、`packages/workspace/src/index.ts:67`、`packages/workspace/src/index.ts:85`、`packages/workspace/src/index.ts:233`、`packages/workspace/src/index.ts:53`
2. **What the HOST injects: the SessionCoordinator (document store + list() used for the archive existence gate), the already-canonical directory path, the route-level realpath/stat and HTTP status mapping (the registry only carries DSH failure CODES in its error classes), and the composition of listWorkspaceFiles over a registered path. The registry itself computes no absolute path, stats nothing and never creates/deletes a directory.**
   - 理由：Errors carry codes precisely so the host can map them to HTTP statuses without string matching; the durable record is the registry's only responsibility.
   - 出處：`packages/workspace/src/index.ts:44`、`packages/workspace/src/index.ts:51`、`packages/workspace/src/index.ts:101`、`packages/workspace/src/index.ts:143`、`packages/workspace/src/index.ts:300`
3. **Every operation goes through ONE serialization chain (DSH operationTail parity): mutations AND reads are queued so two concurrent read-modify-write cycles on the shared document cannot interleave and lose a write, and a list during a mutation observes either the pre- or the post-state, never a torn one. The chain tail is kept alive after failures so one rejection does not break later operations.**
   - 理由：A whole-document read-modify-write is inherently racy without serialization; queueing reads as well makes the snapshot consistent.
   - 出處：`packages/workspace/src/index.ts:188`、`packages/workspace/src/index.ts:196`、`packages/workspace/src/index.ts:199`、`packages/workspace/src/index.ts:221`
4. **Archive is a DISPLAY layer over accounting, not an account change: archivedSessionIds is registry-GLOBAL (archiveSession takes only a session id), archiving KEEPS the session's sessionIds slot, is idempotent and rejects an UNKNOWN id fail-loud (checked against coordinator.list()) so a typo cannot record a dangling id in a set the user cannot enumerate. The field is optional on disk and normalized to [] on load so records written before it parse unchanged, and every mutator writes it back. unarchiveSession is a DELIBERATE additive extension over DSH (which has no restore verb) and treats an unknown id as a no-op.**
   - 理由：A one-way archive set is a footgun for the sidebar's archived section, but a hidden id the user can never see listed must not be recordable by a typo.
   - 出處：`packages/workspace/src/index.ts:88`、`packages/workspace/src/index.ts:213`、`packages/workspace/src/index.ts:294`、`packages/workspace/src/index.ts:298`、`packages/workspace/src/index.ts:314`
5. **create() is idempotent by PATH (a second create resolves the existing record with created:false) and generates a stable non-path id `ws-<uuid8>`; rename requires a non-blank unique title (conflict -> WorkspaceNameConflictError); attachSession PREPENDS (DSH order) and is a no-op when already attached (no rewrite). The walker is bounded and deterministic: caps maxEntries 500 / maxVisited 3000 / maxDepth 8 with early frontier abandonment, exact-name skips for node_modules/.git/.i-harness/dist at any depth, symlinks skipped entirely (never followed, so a link cannot drag the walk outside the workspace or loop), codepoint sort per level, and case-insensitive substring matching with NO ranking.**
   - 理由：The walk must never be unbounded (a large repo is a keystroke-rate surface) and a picker must not reorder between hosts, so localeCompare is rejected as ICU-dependent.
   - 出處：`packages/workspace/src/index.ts:240`、`packages/workspace/src/index.ts:244`、`packages/workspace/src/index.ts:267`、`packages/workspace/src/index.ts:284`、`packages/workspace/src/files.ts:8`、`packages/workspace/src/files.ts:120`、`packages/workspace/src/files.ts:129`

**失敗策略**：Fail-loud on its own invariants and fail-soft only below the walk root. Fail-loud: blank/separator-only path (WorkspaceInvalidPathError, index.ts:231/237), blank title (WorkspaceBadRequestError, index.ts:260), unknown workspace (WorkspaceNotFoundError, index.ts:265/281), duplicate title (WorkspaceNameConflictError, index.ts:268), unknown session on archive (WorkspaceUnknownSessionError, index.ts:302), and a corrupt registry document (throws, index.ts:210). Fail-soft/degrade: an unreadable NESTED directory in the walk is skipped, but an unreadable/missing ROOT rethrows because an empty answer would be a silent lie (files.ts:113-119).

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `WORKSPACE_DOC_KEY` | "workspace-registry" | `packages/workspace/src/index.ts:67` |
| `workspaceId shape` | ws-<first 8 chars of a uuid> | `packages/workspace/src/index.ts:244` |
| `listWorkspaceFiles maxEntries` | 500 | `packages/workspace/src/files.ts:73` |
| `listWorkspaceFiles maxDepth` | 8 | `packages/workspace/src/files.ts:74` |
| `listWorkspaceFiles maxVisited` | 3000 | `packages/workspace/src/files.ts:75` |
| `DEFAULT_LIST_FILES_SKIP_NAMES` | node_modules, .git, .i-harness, dist | `packages/workspace/src/files.ts:65` |
| `DSH failure codes` | bad-request, workspace-invalid-path, workspace-not-found, workspace-name-conflict, session-not-found | `packages/workspace/src/index.ts:102` |

**已知缺口（原始碼內標記）**

- Explicitly DEFERRED in the module header: `delete` (unregistering without touching the directory; the host route DELETE /api/workspaces/:id is intentionally absent so it answers the generic JSON 404), insertBefore/insertSessionBefore display reordering, `follow` (reconnect baseline + ordered increments; the live stream is a later task), and `status` / directory liveness ('ok' \| 'missing-dir') (packages/workspace/src/index.ts:30-42).
- listWorkspaceFiles is the 'honest minimal' vs DSH: substring match with no ranking, symlinks never followed, and a cap hit stops the walk early answering only the collected prefix (packages/workspace/src/files.ts:22-27, packages/workspace/src/files.ts:13-14).
- archiveSession's existence check uses coordinator.list() (the persistence list), and the header notes it is identical to the host route's session account - there is no live-session fallback inside the registry itself (packages/workspace/src/index.ts:296-301).

---

## 沙箱、守衛與模型面

### `sandbox`

Type/contract seam for process sandboxing: defines the three modes, the SandboxProvider.confine() contract, the read-isolation capability gate, the workspace/temp writable-root derivation, the strictly-wider escalation ladder, and the runner-failure classifier that exec and the platform backends share.

> npm `@i-harness/sandbox` · 入口 `packages/sandbox/src/index.ts` · 4 個原始檔 · 22 個匯出符號

**公開介面**：`SandboxMode`、`ConfinedSandboxMode`、`SandboxEnforcement`、`SandboxExecutionPolicy`、`SandboxPolicy`、`RunnerFailureRule`、`ConfinedArgv`、`SandboxProvider`、`SANDBOX_UNAVAILABLE`、`SandboxUnavailableError`、`assertSandboxCapable`、`classifyRunnerFailure`、`matchesSignature`、`canonicalPath`、`writableRoots`、`WIDER_MODES`、`ESCALATION_TARGETS`、`approveEscalation`、`escalationHintMarker`、`sandboxDenialMarker`、`validateEscalationArgs`、`EscalationApproval`、`EscalationApprover`、`EscalationOutcome`、`EscalationRequest`

**關鍵設計決策**

1. **confine() must return enforcing argv or throw; silent unconfined passthrough is forbidden by contract.**
   - 理由：The seam forbids the one failure mode that would silently disable confinement: a provider that cannot confine must fail closed instead of returning the raw argv.
   - 出處：`packages/sandbox/src/index.ts:32-40`
2. **A missing capabilities declaration is treated as {readIsolation:false}; a policy that demands read isolation is refused, never degraded.**
   - 理由：'capabilities unknown = NOT read-isolated' plus assertSandboxCapable turning requireReadIsolation + no capability into SandboxUnavailableError. requireReadIsolation defaults to false, so this is an opt-in gate.
   - 出處：`packages/sandbox/src/index.ts:9-13`、`packages/sandbox/src/index.ts:36-38`、`packages/sandbox/src/index.ts:64-71`
3. **Escalation is strictly-wider and checked at execution time, never baked into a tool schema.**
   - 理由：WIDER_MODES maps read-only -> [workspace-write, danger-full-access] and workspace-write -> [danger-full-access]; approveEscalation rejects a non-wider target, a missing approver, a missing agent, and maps outcome rejected/cancelled/unavailable to distinct errors.
   - 出處：`packages/sandbox/src/escalation.ts:3-10`、`packages/sandbox/src/escalation.ts:61-83`
4. **writableRoots() is the single home of the workspace-write meaning: workspaceRoot + /tmp + tmpdir(), canonicalized and deduped.**
   - 理由：Comment states the purpose is that 'the profile dialects and any in-process fence can never drift apart'; read-only returns [].
   - 出處：`packages/sandbox/src/roots.ts:5-18`
5. **The runner-failure classifier lives in the seam (not in a platform backend) with signature matching lowercased and informational lines excluded.**
   - 理由：exec is generic and must not import a platform backend package; classifyRunnerFailure consults allowedExitCodes, skips informationalLines, and returns the first fatal-signature line.
   - 出處：`packages/sandbox/src/runner-failures.ts:12-28`

**失敗策略**：fail-closed. SandboxUnavailableError's message is '...refusing to run the command unconfined. Install bubblewrap (Linux) or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access.' (packages/sandbox/src/index.ts:44-55); SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE' is the stable code string (packages/sandbox/src/index.ts:42); assertSandboxCapable refuses rather than dropping the demand (packages/sandbox/src/index.ts:64-71); approveEscalation throws when no approval service/channel is composed (packages/sandbox/src/escalation.ts:64-66, 81).

**事件**：`none produced. sandboxDenialMarker()/escalationHintMarker() return tool-output TEXT markers ('[sandbox: file access denied under <mode> mode]', '[sandbox: escalation available — ...]'), not SessionEvents (packages/sandbox/src/escalation.ts:27-33).`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `SANDBOX_UNAVAILABLE` | "SANDBOX_UNAVAILABLE" | `packages/sandbox/src/index.ts:42` |
| `WIDER_MODES` | {"read-only":["workspace-write","danger-full-access"],"workspace-write":["danger-full-access"]} | `packages/sandbox/src/escalation.ts:5-8` |
| `ESCALATION_TARGETS` | ["workspace-write","danger-full-access"] | `packages/sandbox/src/escalation.ts:10` |
| `writableRoots (workspace-write)` | workspaceRoot + "/tmp" + tmpdir(), canonicalPath + Set-deduped; read-only => [] | `packages/sandbox/src/roots.ts:15-18` |

**已知缺口（原始碼內標記）**

- The entire escalation surface has no consumer outside its own tests: repo-wide, WIDER_MODES/ESCALATION_TARGETS/approveEscalation/validateEscalationArgs/sandboxDenialMarker/escalationHintMarker appear in production src only in packages/sandbox/src/escalation.ts (definition) and packages/sandbox/src/index.ts (re-export); the only other references are packages/sandbox/test/seam.test.ts:4-60 and :86-117.
- writableRoots() and canonicalPath() are likewise test-only in composed use (packages/sandbox/src/roots.ts:7-18; only packages/sandbox/test/seam.test.ts:17-35).
- Read isolation is declared-but-absent and the gate that would refuse it is never armed: requireReadIsolation is set only in tests (packages/sandbox/test/enforcement.test.ts:13, packages/exec/test/enforcement.test.ts:15), never by any packages/*/src or apps/*/src caller.
- In-code marker that no read-isolated backend exists: the capability error text says 'WRITE_RESTRICTED is read-visible on Windows; the codex-style elevated backend is not implemented in this build' (packages/sandbox/src/index.ts:68).

---

### `sandbox-local`

The platform-dispatch SandboxProvider: on Linux it wraps argv in a bubblewrap profile, on win32 it delegates to an injected Windows ACL backend, and on every other platform (or a missing backend) it returns a provider whose confine() throws.

> npm `@i-harness/sandbox-local` · 入口 `packages/sandbox-local/src/index.ts` · 3 個原始檔 · 3 個匯出符號

**公開介面**：`LocalSandboxConfig`、`createLocalSandbox`、`probeBwrap`

**關鍵設計決策**

1. **Platform selection is three fail-closed arms keyed on process.platform; every arm either confines or throws — no passthrough arm exists.**
   - 理由：win32 without windowsAclBackend throws SandboxUnavailableError 'no windows ACL backend composed (M16w)'; linux without a successful bwrap probe throws 'bwrap probe failed'; any other platform throws 'unsupported platform'.
   - 出處：`packages/sandbox-local/src/index.ts:33-56`、`packages/sandbox-local/src/index.ts:58-66`、`packages/sandbox-local/src/index.ts:92-97`
2. **enforcement and denial vocabularies are static per runner: bwrap = 'full', windows-acl = 'partial'.**
   - 理由：STATIC_ENFORCEMENT and DENIAL_SIGNATURES are keyed by Runner, and the win32 arm overwrites the delegate's enforcement with the host runner's 'partial'.
   - 出處：`packages/sandbox-local/src/index.ts:20-30`、`packages/sandbox-local/src/index.ts:53`
3. **Honest capability declaration: both backends declare readIsolation:false and refuse a policy that requires read isolation.**
   - 理由：The win32 arm declares {readIsolation:false} and throws when policy.requireReadIsolation === true; the linux arm does the same, with the in-code reason 'bwrap isolates the filesystem for writes but does not hide/read-block filesystem content'.
   - 出處：`packages/sandbox-local/src/index.ts:44-51`、`packages/sandbox-local/src/index.ts:67-79`
4. **The runner override is pinned to bwrap; any other runner[0] is refused.**
   - 理由：Prevents a config value from turning the Linux arm into an arbitrary argv prefix (which would be an unconfined passthrough by another name).
   - 出處：`packages/sandbox-local/src/index.ts:72-76`
5. **probeBwrap runs a real confined 'true' (default 5000 ms timeout) instead of 'bwrap --version'.**
   - 理由：Stated reason: '--version alone passes on hosts where user namespaces are blocked, so the e2e would run RED instead of SKIP'; the probe uses the read-only profile against '/'.
   - 出處：`packages/sandbox-local/src/index.ts:100-110`

**失敗策略**：fail-closed. Every unavailable backend is a provider whose confine() throws SandboxUnavailableError (packages/sandbox-local/src/index.ts:37-41, 61-65, 93-97) and a policy demanding read isolation is refused (49-51, 77-79). A bwrap runner failure (exit 125 + 'bwrap: failed to') is carried as a runnerFailureRule (packages/sandbox-local/src/index.ts:84-86) which exec converts into SandboxUnavailableError (packages/exec/src/index.ts:185-193).

**事件**：`none`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `STATIC_ENFORCEMENT` | {bwrap:'full', 'windows-acl':'partial'} | `packages/sandbox-local/src/index.ts:22-25` |
| `DENIAL_SIGNATURES` | bwrap:['read-only file system']; windows-acl:['access is denied','access to the path','permission denied'] | `packages/sandbox-local/src/index.ts:27-30` |
| `bwrap runnerFailureRules` | allowedExitCodes:[125], fatalSignatures:['bwrap: failed to'] | `packages/sandbox-local/src/index.ts:84-86` |
| `probeTimeoutMs default` | 5000 | `packages/sandbox-local/src/index.ts:106` |
| `bwrap profile argv` | ['--ro-bind','/','/','--dev','/dev','--unshare-pid','--proc','/proc','--die-with-parent'] (+ '--tmpfs','/tmp' and '--bind <workspaceRoot> <workspaceRoot>' under workspace-write) | `packages/sandbox-local/src/profiles.ts:3-9` |

**已知缺口（原始碼內標記）**

- runner-failures.ts adds isRunnerSpawnFailure and classifyDenial but src/index.ts re-exports neither (compare packages/sandbox-local/src/runner-failures.ts:12,23 with the three exports of packages/sandbox-local/src/index.ts:11-18,32,103); repo-wide the only importer is the package's own test (packages/sandbox-local/test/local.test.ts:3).
- The win32 arm's failure text still names a historical milestone: 'no windows ACL backend composed (M16w)' with the comment 'the real backend ships in M16w' (packages/sandbox-local/src/index.ts:15-16,34-41) — the backend now exists in packages/sandbox-windows-acl.
- The denialSignatures produced by both arms (packages/sandbox-local/src/index.ts:83) have no production consumer: exec keeps ConfinedArgv but only reads runnerFailureRules (packages/exec/src/index.ts:103-105,185-193) and classifyDenial is not called anywhere outside tests.

---

### `sandbox-policy`

Resolves the effective sandbox mode for a session (last 'sandbox/mode' event wins over the configured default) and renders the one-line policy text that the assembly injects into the system prompt.

> npm `@i-harness/sandbox-policy` · 入口 `packages/sandbox-policy/src/index.ts` · 2 個原始檔 · 7 個匯出符號

**公開介面**：`SANDBOX_MODES`、`SandboxPolicyConfig`、`SandboxPolicyRequest`、`SandboxPolicyService`、`createSandboxPolicy`、`effectiveSandboxMode`、`renderPolicyContext`

**關鍵設計決策**

1. **Mode precedence is request.mode > session's last sandbox/mode event > configured default (default 'read-only'), then path.resolve on the workspace root.**
   - 理由：resolve() computes sessionOverride from effectiveSandboxMode(session.events) and folds it between the explicit request mode and the service default.
   - 出處：`packages/sandbox-policy/src/index.ts:25-39`
2. **The session override is last-writer-wins: the scan runs backwards and returns the first (i.e. newest) sandbox/mode event.**
   - 理由：A mode change is a log append, so the newest event is the authoritative one and no separate mutable mode field is needed.
   - 出處：`packages/sandbox-policy/src/session-mode.ts:6-12`
3. **The rendered policy text is advisory and explicitly tells the model not to refuse work from the policy alone.**
   - 理由：read-only renders 'Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'; the resolved policy object is passed to both the enforcer and this renderer so they cannot drift (packages/session-executor/src/assembly.ts:292-301,602).
   - 出處：`packages/sandbox-policy/src/index.ts:41-51`

**失敗策略**：other (no enforcement here — pure resolution). An unrecognized mode falls through to the default arm and renders an empty string (packages/sandbox-policy/src/index.ts:49-50); workspaceRoot is resolved with path.resolve against process.cwd() (packages/sandbox-policy/src/index.ts:27,35).

**事件**：`consumes "sandbox/mode" (SessionEvent variant declared at packages/core-session/src/index.ts:43); produces none`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `SANDBOX_MODES` | ['read-only','workspace-write','danger-full-access'] | `packages/sandbox-policy/src/session-mode.ts:4` |
| `default mode` | "read-only" | `packages/sandbox-policy/src/index.ts:26` |

**已知缺口（原始碼內標記）**

- none

---

### `sandbox-windows-acl`

Windows write-restriction backend: builds a WRITE_RESTRICTED token whose restricting-SID list carries per-workspace and per-temp capability SIDs, materializes matching Write ACEs on the workspace/temp DACLs, and confines a command by prefixing an argv runner that spawns the child under that token (never unrestricted).

> npm `@i-harness/sandbox-windows-acl` · 入口 `packages/sandbox-windows-acl/src/index.ts` · 12 個原始檔 · 15 個匯出符號

**公開介面**：`AclSandbox`、`AclSandboxChild`、`AclSandboxChildResult`、`AclSandboxOptions`、`AclSandboxSpawnOptions`、`AclWriteGrant`、`Win32Error`、`assertTempRootOutsideWorkspace`、`createWindowsAclSandbox`、`quoteArg`、`scanWorldWritable`、`tempWriteSid`、`workspaceWriteSid`、`WorldWritableFinding`、`ScanOptions`

**關鍵設計決策**

1. **WRITE_RESTRICTED token with a mode-selected restricting-SID list: read-only [logon SID, EVERYONE]; workspace-write [logon SID, EVERYONE, workspace write SID, optional temp write SID]; Authenticated Users and INTERACTIVE/LOCAL are absent from BOTH lists.**
   - 理由：Stated reasons: logon+Everyone are the keep-alive group (DLL init / CNG otherwise fail); Authenticated Users is dropped because the WMI namespace check fails and because standing AU ACEs on the C: root close a tree-creation escape; INTERACTIVE/LOCAL is dropped because the Public tree grants writes to INTERACTIVE. Because read-only carries no write SID, a stale workspace ACE stays inert.
   - 出處：`packages/sandbox-windows-acl/src/token.ts:161-186`、`packages/sandbox-windows-acl/src/token.ts:204-208`
2. **Capability identity is split: a deterministic per-workspace SID (S-1-4-x-y from sha256 of the canonical workspace path) and a per-private-temp SID (S-1-4-x-y-1, domain-separated by a fixed third subauthority).**
   - 理由：The workspace SID makes the workspace-root ACE materialize once per workspace per machine (later provisions hit the exact-ACE skip); the distinct temp SID prevents sibling sessions sharing a workspace from entering one another's temp trees; both SIDs' power is defined solely by the ACEs that name them.
   - 出處：`packages/sandbox-windows-acl/src/workspace-sid.ts:1-25`、`packages/sandbox-windows-acl/src/workspace-sid.ts:35-53`
3. **Grant lifecycle is asymmetric: workspace ACEs are STANDING (never revoked — they are the cross-session reuse cache) while temp ACEs are REVOCABLE and removed by dispose(); with manageDacls:false the caller owns all DACLs.**
   - 理由：Revoking the workspace ACE would force the next session to re-propagate the whole tree; the temp ACE must not outlive its private directory. init() is fail-closed and rolls back the revocable grants, SID allocations and handles before rethrowing.
   - 出處：`packages/sandbox-windows-acl/src/index.ts:29-39`、`packages/sandbox-windows-acl/src/index.ts:260-280`、`packages/sandbox-windows-acl/src/index.ts:308-345`、`packages/sandbox-windows-acl/src/grant.ts:18-27`
4. **Idempotent grants: grantWrite reads the directory's current explicit DACL and SKIPS the apply when the exact ACE (ACCESS_ALLOWED, OI\|CI, GRANT_MASK, same SID) is already present.**
   - 理由：An unconditional SetNamedSecurityInfoW re-propagates the identical inheritable ACE over the whole tree ('minutes on large workspaces'); the whole read-merge-write runs under a per-path exclusive LockFileEx lock so concurrent instances cannot clobber each other's ACEs.
   - 出處：`packages/sandbox-windows-acl/src/acl.ts:181-213`、`packages/sandbox-windows-acl/src/acl.ts:215-244`、`packages/sandbox-windows-acl/src/acl.ts:60-109`
5. **The per-call SandboxPolicy is the enforcement input; the construction options' `mode` is never read by the factory.**
   - 理由：The in-code NOTE says mode/tempDir/writeSid/tempWriteSid/manageDacls 'are NOT read here ... A confinement's mode therefore comes from the policy, never from the construction options'. The compose site nevertheless passes mode:'read-only' (packages/session-executor/src/assembly.ts:286), which is inert.
   - 出處：`packages/sandbox-windows-acl/src/index.ts:514-527`、`packages/sandbox-windows-acl/src/index.ts:640-650`
6. **Every Win32 call is checked and failure is loud; the confined child is never spawned unrestricted.**
   - 理由：Win32Error carries the API name and exact code; construction validates writableDirs exist and are directories; confinement passes through an argv runner whose every failure prints 'windows-acl-run: <detail>' and exits 127; spawn assigns the suspended child to a kill-on-close job before it runs.
   - 出處：`packages/sandbox-windows-acl/src/errors.ts:1-20`、`packages/sandbox-windows-acl/src/index.ts:527-537`、`packages/sandbox-windows-acl/src/runner.ts:40-63`、`packages/sandbox-windows-acl/src/spawn.ts:227-244`

**失敗策略**：fail-closed at every level. Construction throws on a missing/non-directory writableDir (packages/sandbox-windows-acl/src/index.ts:532-537); grant materialization cleans up its SID and temp dir and rethrows (packages/sandbox-windows-acl/src/index.ts:541-592); init() revokes revocable grants, frees SIDs and closes handles before rethrowing, aggregating cleanup failures (packages/sandbox-windows-acl/src/index.ts:308-345); confine() after dispose throws SandboxUnavailableError (packages/sandbox-windows-acl/src/index.ts:642-643); dispose() reports every cleanup failure as AggregateError (packages/sandbox-windows-acl/src/index.ts:437-439); the runner exits 127 with the 'windows-acl-run: ' signature (packages/sandbox-windows-acl/src/runner.ts:54-63,220-225) which is declared as RUNNER_FAILURE_RULES so exec raises SandboxUnavailableError (packages/sandbox-windows-acl/src/index.ts:463 + packages/exec/src/index.ts:185-193).

**事件**：`none`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `GRANT_MASK` | 0x00110156 (FILE_GENERIC_WRITE \| DELETE \| FILE_DELETE_CHILD, minus STANDARD_RIGHTS_WRITE) | `packages/sandbox-windows-acl/src/win32-abi.ts:51-73` |
| `WRITE_RESTRICTED / DISABLE_MAX_PRIVILEGE / LUA_TOKEN` | 0x8 / 0x1 / 0x4 (the CreateRestrictedToken flags; constants at packages/sandbox-windows-acl/src/win32-abi.ts:86-90) | `packages/sandbox-windows-acl/src/token.ts:210-218` |
| `DENIAL_SIGNATURES` | ['access is denied','access to the path','permission denied'] | `packages/sandbox-windows-acl/src/index.ts:443-448` |
| `WINDOWS_ACL_RUNNER_FAILURE_EXIT / RUNNER_FAILURE_RULES` | 127 / [{allowedExitCodes:[127], fatalSignatures:['windows-acl-run: ']}] | `packages/sandbox-windows-acl/src/index.ts:450-463` |
| `private temp dir prefix` | 'dsh-' (mkdtempSync(join(tmpdir(),'dsh-')); the runner does the same at packages/sandbox-windows-acl/src/runner.ts:156) | `packages/sandbox-windows-acl/src/index.ts:564` |
| `scanWorldWritable defaults` | maxItemsPerDir 500, totalBudgetMs 2000, default probe returns 'unknown' (default probe at packages/sandbox-windows-acl/src/audit.ts:37) | `packages/sandbox-windows-acl/src/audit.ts:28-29` |
| `struct sizes pinned at load` | SECURITY_MAX_SID_SIZE 68, SID_AND_ATTRIBUTES_SIZE 16, EXPLICIT_ACCESS_W_SIZE 48, STARTUPINFOW_SIZE 104, PROCESS_INFORMATION_SIZE 24 (asserted at packages/sandbox-windows-acl/src/ffi.ts:170-180) | `packages/sandbox-windows-acl/src/win32-abi.ts:246-260` |

**已知缺口（原始碼內標記）**

- Hard-link bypass is README-only, unconfirmed in src/: README.md:41-44 claims 'NTFS hard links can bypass directory DACLs (a hard link into a writable directory exposes the link target)'; no src file states or tests it.
- The confined-child EPERM observation is README-only: README.md:79-82 pins 'confined target 無法 spawn 子進程 (EPERM) — observed; root cause 未調查 (M25 前 follow-up)'.
- audit.ts is explicitly scoped-incomplete: the scope note says acl.ts's readCurrentDacl is unexported and no ACE enumeration exists (GetAce/GetExplicitEntriesFromAclW unbound), so scanWorldWritable only reports what an INJECTED DaclWriteProbe calls 'world-writable' and otherwise returns no findings ('unverified entries 不報為 finding'); the reported principal is hardcoded 'Everyone' (packages/sandbox-windows-acl/src/audit.ts:6-8,14-16,26,37,47-52).
- Console isolation is unavailable by construction: CREATE_NO_WINDOW / CREATE_NEW_CONSOLE are intentionally absent because such children die with STATUS_DLL_INIT_FAILED under the restriction (packages/sandbox-windows-acl/src/spawn.ts:5-6; packages/sandbox-windows-acl/src/index.ts:26-28).
- Read/network/process isolation is out of scope for the mechanism: 'writes are restricted; reads, network, and process visibility are NOT (WRITE_RESTRICTED intersects only write accesses)' (packages/sandbox-windows-acl/src/index.ts:23-25) — the same statement the README makes at README.md:10-22.

---

### `guard-approval`

The tools/pre-execute approval policy (three layers plus a 'never' headless promotion) and the optional LLM approval guardian: a dedicated reviewer subagent with a strict-JSON verdict contract, a circuit breaker, and registration as the 'approval/guardian' service.

> npm `@i-harness/guard-approval` · 入口 `packages/guard-approval/src/index.ts` · 7 個原始檔 · 18 個匯出符號

**公開介面**：`ApprovalConfig`、`BUNDLED_GUARDIAN_POLICY`、`DEFAULT_DANGEROUS_COMMANDS`、`DEFAULT_DANGEROUS_FLAGS`、`GUARDIAN_BREAKER_DENY_LIMIT`、`GUARDIAN_BREAKER_WINDOW`、`GUARDIAN_JSON_CONTRACT`、`GUARDIAN_REVIEWER_ROLE_NAME`、`GUARDIAN_REVIEW_TIMEOUT_MS`、`GuardianBreaker`、`createApprovalPolicy`、`ensureReviewerRole`、`isGuardianBreakerState`、`parseGuardianAssessment`、`registerGuardian`、`renderGuardianMessage`、`renderRecentContext`、`runGuardianReview`

**關鍵設計決策**

1. **Three layers AS IMPLEMENTED: readOnly tool -> allow; `write` with no path or a path outside the workspace -> ask; any other non-readOnly tool -> ask (Layer 1 fallback); EXCEPT bash/pwsh, which ask ONLY when classifyDanger() != 'none'.**
   - 理由：The file's own comment block states this asymmetry explicitly and warns that the older comments 'used to describe an intent the code does not carry out'; a benign registered shell command therefore executes with NO approval even with askForNonReadOnly true and no answerer.
   - 出處：`packages/guard-approval/src/index.ts:28-51`、`packages/guard-approval/src/index.ts:108-149`
2. **For the shell tools the safety boundary IS the danger classifier, and that classifier is advisory: it parses the tool's own getArgv output.**
   - 理由：Stated plainly in code: 'for the shell tools the safety boundary IS the danger classifier, and that classifier is advisory — it parses argv via the tool's own getArgv. The tests in the same file record the bypass surface it is meant to survive (quoted 'r''m', metachar '; rm -rf /', and control flow whose every basename is harmless, e.g. echo a; echo b)'.
   - 出處：`packages/guard-approval/src/index.ts:46-51`、`packages/guard-approval/src/index.ts:118-133`
3. **Deny-on-metachar: any argv token containing one of 7 metachars is 'dangerous' even when every basename looks harmless.**
   - 理由：M62 added '>' / '<' / '>>' because 'echo hi > /etc/passwd' had no dangerous basename and no listed command, so it classified 'none' and ran with no approval (measured, per the comment: the shell tools carry no workspace boundary of their own; the write TOOL is gated by isInsideWorkspace, a redirect is not). 'Over-asking here is the intended direction: this layer is deliberately deny-on-metachar, not a precise effect model.'
   - 出處：`packages/guard-approval/src/danger-class.ts:304-317`
4. **extreme > dangerous: OS-level destruction, workspace-escaping force-delete, or URL/GUI launch is 'extreme'; a force-delete wholly inside the workspace is only 'dangerous'.**
   - 理由：'extreme' (echo-consent, default deny) covers format/diskpart/shutdown, reg delete, cipher /w, URL launchers with an http(s) URL, and force-delete whose targets are outside the workspace or a top-level system path; the 'force' tier protects ordinary agent cleanup. Wrapper penetration (sudo/env/POSIX shell -c/cmd /c/pwsh -Command/trap) is depth-limited to 8.
   - 出處：`packages/guard-approval/src/danger-class.ts:10-27`、`packages/guard-approval/src/danger-class.ts:173-195`、`packages/guard-approval/src/danger-class.ts:199-250`、`packages/guard-approval/src/danger-class.ts:295-331`
5. **The policy seeds BOTH a plain listener and a waterfall handler with one shared decide().**
   - 理由：Stated reason: a waterfall-only handler is invisible to ctx.resolveDecision (a scope decision is recorded only when a plain listener seeded the chain), so a child scope's registry would fail OPEN on a parent-mounted policy.
   - 出處：`packages/guard-approval/src/index.ts:152-191`
6. **approvalPolicy 'never' promotes an ask-decision into deny-with-reason instead of consulting the answerer.**
   - 理由：Headless posture: no interactive prompt can ever approve execution.
   - 出處：`packages/guard-approval/src/index.ts:64-70`、`packages/guard-approval/src/index.ts:176-191`
7. **Guardian reviews are fail-closed deny and are breaker-counted: deny, timeout and malformed all trip the breaker at 3 in the last 10 reviews.**
   - 理由：Only 'allow' falls through to the human answerer; a timeout/malformed is not model disagreement but exactly the stuck-reviewer failure the breaker exists for. The reviewer runs as a no-tools 'reviewer' role via spawnChild with forkTurns 'none' and is reclaimed in finally.
   - 出處：`packages/guard-approval/src/guardian/index.ts:26-49`、`packages/guard-approval/src/guardian/breaker.ts:12-36`、`packages/guard-approval/src/guardian/reviewer.ts:46-59`、`packages/guard-approval/src/guardian/reviewer.ts:126-188`

**失敗策略**：mixed, explicitly tiered. Unknown tool (metadata unavailable) -> ask, i.e. fail closed (packages/guard-approval/src/index.ts:114-117); no applicable decision -> undefined = allow, which for a benign shell command is deliberate fail-open (packages/guard-approval/src/index.ts:122-124, 149); approvalPolicy 'never' turns every ask into deny-with-reason (packages/guard-approval/src/index.ts:67-70); the guardian denies on open breaker, on timeout (cause:'timeout'), on malformed strict JSON (cause:'malformed'), on a missing reviewer entry and on missing final text (packages/guard-approval/src/guardian/index.ts:47-49; packages/guard-approval/src/guardian/reviewer.ts:156-172); the durable breaker mirror is fail-soft (an unreadable doc yields a fresh closed breaker, and putDocument never rejects) (packages/guard-approval/src/guardian/index.ts:36-43,60-63).

**事件**：`none produced. It hooks the plugin event "tools/pre-execute" as both a plain listener and a waterfall handler (packages/guard-approval/src/index.ts:176,183) and registers the service "approval/guardian" consumed by core-tools (packages/guard-approval/src/guardian/index.ts:66; packages/core-tools/src/index.ts:271).`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_DANGEROUS_COMMANDS` | ['rm','Remove-Item','del','rd','erase','shred','wipe','taskkill'] | `packages/guard-approval/src/index.ts:16-25` |
| `DEFAULT_DANGEROUS_FLAGS` | ['-rf','-Recurse','-Force'] | `packages/guard-approval/src/index.ts:26` |
| `SHELL_TOOLS / WRITE_TOOLS` | {bash, pwsh} / {write} | `packages/guard-approval/src/index.ts:53-54` |
| `METACHAR` | [";", "&&", "\|", "$(", "`", ">", "<"] | `packages/guard-approval/src/danger-class.ts:316` |
| `STATEMENT_SEPARATORS (statement splitter, distinct from METACHAR)` | /[;&\|\n]/ | `packages/guard-approval/src/danger-class.ts:29` |
| `MAX_WRAPPER_DEPTH` | 8 | `packages/guard-approval/src/danger-class.ts:22` |
| `EXTREME_COMMANDS` | ['format','diskpart','shutdown'] (plus 'reg delete' and 'cipher /w' checked at packages/guard-approval/src/danger-class.ts:176-177) | `packages/guard-approval/src/danger-class.ts:17-18` |
| `URL_LAUNCHERS` | ['start-process','start','saps','invoke-item','ii','rundll32','mshta','explorer'] (used with an http(s) URL at packages/guard-approval/src/danger-class.ts:180) | `packages/guard-approval/src/danger-class.ts:20` |
| `GUARDIAN_BREAKER_WINDOW / DENY_LIMIT` | 10 / 3 (check() counts every non-'allow' outcome in the window) | `packages/guard-approval/src/guardian/breaker.ts:1-2` |
| `GUARDIAN_REVIEW_TIMEOUT_MS` | 90000 (the default applied at packages/guard-approval/src/guardian/reviewer.ts:128) | `packages/guard-approval/src/guardian/reviewer.ts:16` |
| `guardian context bounds` | maxChars 4000 / maxEvents 12 for the transcript (also the 4000-char request-args slice at line 97 and context slice at 101); per-line slice 200 | `packages/guard-approval/src/guardian/reviewer.ts:62-81` |
| `askForNonReadOnly default` | true | `packages/guard-approval/src/index.ts:174` |
| `BANNED_PREFIX_PATTERNS (unreachable, see gaps)` | bash/bash -c/bash -lc, cmd/cmd /c/cmd /k/cmd.exe, pwsh/pwsh -Command/powershell/powershell -Command, sh/sh -c/zsh/zsh -c, node -e, bun -e | `packages/guard-approval/src/remember.ts:14-20` |

**已知缺口（原始碼內標記）**

- remember.ts is dead code: RememberRule/RememberStore/createRememberStore/BANNED_PREFIX_PATTERNS are not re-exported by src/index.ts (compare packages/guard-approval/src/remember.ts:9-29 with the export list at packages/guard-approval/src/index.ts:56-62) and a repo-wide search finds no importer of the module ('remember.ts' appears only in the file itself).
- package.json declares @i-harness/interaction, @i-harness/exec and @i-harness/llm-mock, but no file under src/ imports them (packages/guard-approval/package.json dependencies vs the src import inventory: only core-plugin, core-tools, core-session, core-agent, llm-seam, provider, session-persistence and subagent are imported).
- The classifier's bypass surface is recorded as a known limitation rather than closed: quoted 'r''m', metachar '; rm -rf /', and harmless-basename control flow (packages/guard-approval/src/index.ts:46-51).
- The M62 metachar set still excludes a lone '&' and a newline from the deny list even though both split statements in danger-class.ts:29 — recorded here as the exact constant, not as a claim about intent (packages/guard-approval/src/danger-class.ts:29,316).

---

### `guard-repeat-tool`

Counts consecutive identical tool calls (tool name + JSON args) per Session and, at each configured threshold, appends an internal user/message nudge telling the model to consider changing approach.

> npm `@i-harness/guard-repeat-tool` · 入口 `packages/guard-repeat-tool/src/index.ts` · 1 個原始檔 · 2 個匯出符號

**公開介面**：`RepeatToolConfig`、`createRepeatToolGuard`

**關鍵設計決策**

1. **The tracking key is name + JSON.stringify(args); any different key resets the counter to 1.**
   - 理由：Only an unbroken run of identical calls is a loop; interleaved different calls are not counted.
   - 出處：`packages/guard-repeat-tool/src/index.ts:59-63`
2. **thresholds is a LIST, not a single limit — the default [3,5,8] fires a nudge at each of those counts.**
   - 理由：Escalating reminders instead of one hard stop; thresholds.includes(state.count) is the trigger.
   - 出處：`packages/guard-repeat-tool/src/index.ts:11`、`packages/guard-repeat-tool/src/index.ts:65-78`
3. **Per-session state is a WeakMap keyed by the Session object.**
   - 理由：Stated reason: a Session has no durable id in memory and this works for the main session and every child; entries are GC'd with their session.
   - 出處：`packages/guard-repeat-tool/src/index.ts:44-47`
4. **The nudge is appended as a session event with internal:true and source {kind:'plugin', plugin:'guard-repeat-tool'}.**
   - 理由：M59: it is an internal nudge to the model, not a user turn in the TUI.
   - 出處：`packages/guard-repeat-tool/src/index.ts:71-77`

**失敗策略**：other — observational, never blocking: the guard only appends a message and has no deny/escalation path (packages/guard-repeat-tool/src/index.ts:52-79). Misconfiguration fails loud at construction: thresholds must be a non-empty array of integers >= 2 (packages/guard-repeat-tool/src/index.ts:31-39).

**事件**：`produces "user/message" (with internal:true and a plugin source) at packages/guard-repeat-tool/src/index.ts:71-77`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_THRESHOLDS` | [3, 5, 8] | `packages/guard-repeat-tool/src/index.ts:11` |
| `DEFAULT_PREVIEW_CHARS` | 500 | `packages/guard-repeat-tool/src/index.ts:12` |
| `minimum threshold` | 2 (integer) | `packages/guard-repeat-tool/src/index.ts:34` |

**已知缺口（原始碼內標記）**

- none

---

### `guard-retry`

Cascade guard on tools/execute that re-dispatches a tool call whose result carries the TOOL_TIMEOUT code, with exponential backoff + jitter, a retry cap, and a re-entrancy guard so retry frames cannot nest.

> npm `@i-harness/guard-retry` · 入口 `packages/guard-retry/src/index.ts` · 1 個原始檔 · 3 個匯出符號

**公開介面**：`RetryConfig`、`backoffDelay`、`createRetryGuard`

**關鍵設計決策**

1. **Mount order is load-bearing: this guard must be registered BEFORE createTimeoutGuard so it stays OUTER and sees the raw TOOL_TIMEOUT value.**
   - 理由：core-plugin runs cascade handlers in registration order with the first registered outermost; the registry only wraps the value in {name, output} after the cascade returns, and next() is one-shot so the guard re-invokes the whole cascade.
   - 出處：`packages/guard-retry/src/index.ts:71-77`、`packages/guard-retry/src/index.ts:103`
2. **Retry triggers only on the TOOL_TIMEOUT code, and the ORIGINAL caller signal is captured before the inner timeout guard swaps exec.abortSignal.**
   - 理由：After a TOOL_TIMEOUT the timeout guard's own controller is aborted; reading the signal after next() would falsely stop retry. An aborted upstream signal means the STEP is being cancelled, so the loop breaks.
   - 出處：`packages/guard-retry/src/index.ts:44-46`、`packages/guard-retry/src/index.ts:82-92`
3. **Re-dispatch deliberately bypasses registry.execute's pre-execute hooks, the monotonic guards and post-execute; only the final post-retry result reaches post-execute, and the frame is marked with markCascadeRedispatch.**
   - 理由：Approval was already granted for the original dispatch; M51 B1 adds the marker so once-per-logical-call cascade handlers (hooks pre/post-tool) skip their own run.
   - 出處：`packages/guard-retry/src/index.ts:94-103`
4. **A WeakSet of in-flight dispatch objects guards re-entrancy: a nested frame delegates to next() instead of retrying.**
   - 理由：Re-invoking ctx.cascade re-runs the whole chain including this handler, so without the set the retry frames would nest and multiply attempts exponentially.
   - 出處：`packages/guard-retry/src/index.ts:64-67`、`packages/guard-retry/src/index.ts:79`

**失敗策略**：other — bounded best-effort recovery: after maxRetries the last timeout result is returned unchanged (packages/guard-retry/src/index.ts:90-105); an upstream abort during backoff stops retrying (91); invalid config throws at construction (maxRetries/initialDelayMs/maxDelayMs non-negative integers, jitterRatio in [0,1)) (packages/guard-retry/src/index.ts:24-42).

**事件**：`none`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_MAX_RETRIES` | 2 | `packages/guard-retry/src/index.ts:19` |
| `DEFAULT_INITIAL_DELAY_MS` | 500 | `packages/guard-retry/src/index.ts:20` |
| `DEFAULT_MAX_DELAY_MS` | 10000 | `packages/guard-retry/src/index.ts:21` |
| `DEFAULT_JITTER_RATIO` | 0.1 | `packages/guard-retry/src/index.ts:22` |
| `backoff formula` | min(min(initialDelayMs * 2**attempt, maxDelayMs) * jitter, maxDelayMs) with jitter in [1-r, 1+r] | `packages/guard-retry/src/index.ts:55-60` |

**已知缺口（原始碼內標記）**

- none

---

### `guard-timeout`

Cascade guard on tools/execute that enforces the tool's declared timeoutMs by swapping in a linked AbortController and substituting a structured TOOL_TIMEOUT raw result when its own timer fired.

> npm `@i-harness/guard-timeout` · 入口 `packages/guard-timeout/src/index.ts` · 1 個原始檔 · 3 個匯出符號

**公開介面**：`TOOL_TIMEOUT`、`TimeoutGuardConfig`、`createTimeoutGuard`

**關鍵設計決策**

1. **The deadline comes from the TOOL's declared timeoutMs; the guard holds no default and passes through untouched when timeoutMs is undefined.**
   - 理由：The config object is empty by design ('no hardcoded tunables'); per-tool policy stays with the tool.
   - 出處：`packages/guard-timeout/src/index.ts:5-8`、`packages/guard-timeout/src/index.ts:21-22`
2. **On timeout the guard substitutes {error, code:'TOOL_TIMEOUT'} at the TOP level of the raw value, spreading the tool's other fields.**
   - 理由：The registry wraps the cascade value in {name, output}, so the marker must be top-level to read at tool/result.output.code (the spec's initial nested 'output:' shape would bury it one level deeper).
   - 出處：`packages/guard-timeout/src/index.ts:43-57`
3. **The guard's own timer is distinguished from an upstream (parent) cancel via a local timedOut flag, and the derived controller is linked to the upstream signal and unlinked in finally.**
   - 理由：A parent cancel is not a timeout; the listener is named so it can be removed (leak hygiene), and the original signal is restored for outer handlers/post-execute.
   - 出處：`packages/guard-timeout/src/index.ts:24-35`、`packages/guard-timeout/src/index.ts:67-71`
4. **A tool that honors the abort by REJECTING still surfaces TOOL_TIMEOUT instead of propagating the rejection.**
   - 理由：Otherwise the rejection would abort the whole agent run with no marker.
   - 出處：`packages/guard-timeout/src/index.ts:59-66`

**失敗策略**：other — converts a hang into a structured failure value: {error:'tool call timed out after <ms>ms', code:'TOOL_TIMEOUT'} (packages/guard-timeout/src/index.ts:52-56, 63-65); with no timeoutMs the call is unbounded (22).

**事件**：`none (TOOL_TIMEOUT is a tool-output error code, not a SessionEvent)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `TOOL_TIMEOUT` | "TOOL_TIMEOUT" | `packages/guard-timeout/src/index.ts:3` |
| `TimeoutGuardConfig` | empty interface, 'Reserved for future policy knobs' | `packages/guard-timeout/src/index.ts:5-8` |

**已知缺口（原始碼內標記）**

- TimeoutGuardConfig is an empty placeholder explicitly marked 'Reserved for future policy knobs; the current policy reads tool.timeoutMs directly' (packages/guard-timeout/src/index.ts:5-8).

---

### `llm-seam`

The provider-agnostic model seam: the LLMStreamEvent/LLMRequest/ModelClient vocabulary, the six-level reasoning-effort enum with its fail-loud rule, the retry policy resolver plus retrying client, image projection for text-only models, the message/log consistency assertion, and transport-error explanation.

> npm `@i-harness/llm-seam` · 入口 `packages/llm-seam/src/index.ts` · 1 個原始檔 · 21 個匯出符號

**公開介面**：`LLMStreamEvent`、`LLMRequest`、`ModelClient`、`ToolSchema`、`ReasoningEffort`、`RetryableErrorCode`、`RetryBackoffConfig`、`RetryPolicyConfig`、`NormalRetryPolicyConfig`、`AlwaysRetryPolicyConfig`、`ResolvedRetryPolicy`、`ResolvedRetryBackoff`、`ResolvedNormalRetryPolicy`、`ResolvedAlwaysRetryPolicy`、`resolveRetryPolicy`、`retryErrorCode`、`backoffDelay`、`createRetryingClient`、`assertMessagesFromLog`、`projectImagesForTextModel`、`describeTransportError`、`LLMMessage (re-export)`、`LLMContentPart (re-export)`、`ImageInput (re-export)`、`ImageMediaType (re-export)`

**關鍵設計決策**

1. **One uniform six-level effort vocabulary ('off'\|'low'\|'medium'\|'high'\|'xhigh'\|'max'); undefined means SEND NOTHING and an unsupported value is passed through verbatim so the provider's 400 surfaces.**
   - 理由：The comment states the 'don't default any provider' stance and the 'fail-loud' rule: 'a value the model does not support is passed through verbatim so the provider's 400 surfaces — adapters never guess, clamp or special-case.'
   - 出處：`packages/llm-seam/src/index.ts:198-207`、`packages/llm-seam/src/index.ts:209-222`
2. **Retry only when the error is retryable AND nothing has been produced yet AND a budget remains; budget exhaustion is ALWAYS a hard failure.**
   - 理由：Two provider failure styles are handled (throw or {type:'error'} event). A restarted stream after output would duplicate text/reasoning/tool_call, so the error surfaces instead. Retries are silent; a give-up that is not exhaustion preserves the provider's surface style.
   - 出處：`packages/llm-seam/src/index.ts:135-146`、`packages/llm-seam/src/index.ts:147-190`
3. **Error classification prefers a structured err.code found by walking the cause chain (depth 5), then message regexes for CONTEXT_WINDOW_EXCEEDED / QUOTA / RATE_LIMIT / TIMEOUT / SERVER.**
   - 理由：Gives a stable code for both provider styles and for wrapped errors (fetch cause chains) without depending on provider-specific text.
   - 出處：`packages/llm-seam/src/index.ts:98-123`
4. **Images are never silently dropped for text-only routes: part-level images become a deterministic placeholder carrying the first 8 base64 chars, and canonical dataBase64 occurrences in tool-role STRING content are masked.**
   - 理由：M14/M15 negative capability: the base64 prefix is a stable correlation hint, not the bytes; the mask stops raw base64 from tool results (output.images -> dataBase64) reaching a text-only model. User/assistant string content is untouched.
   - 出處：`packages/llm-seam/src/index.ts:235-267`
5. **assertMessagesFromLog pins the model-visible message array to deriveMessages(session) by JSON equality.**
   - 理由：Stated as audit F01-3: model-visible messages must derive from the session log.
   - 出處：`packages/llm-seam/src/index.ts:228-233`
6. **Transport failures are re-described by walking the cause chain and appending a proxy/CA remediation hint, and a caller abort is named as an abort rather than a network fault.**
   - 理由：Node collapses DNS/TCP/TLS/proxy failures into the identical 'TypeError: fetch failed'; the text never includes headers or the API key.
   - 出處：`packages/llm-seam/src/index.ts:292-323`

**失敗策略**：fail-loud with bounded retry. Exhaustion throws the underlying failure whichever style the provider used (packages/llm-seam/src/index.ts:186); a non-retryable or post-output give-up preserves the provider's style — an error EVENT stays terminal and ends the stream, a thrown error is rethrown (packages/llm-seam/src/index.ts:182-186); invalid policy config throws at resolve time (non-positive delays, initialDelayMs > maxDelayMs, jitterRatio outside [0,1], empty or duplicated retryableCodes) (packages/llm-seam/src/index.ts:69-96).

**事件**：`LLMStreamEvent vocabulary (seam-internal, NOT SessionEvents): "text/chunk", "reasoning", "tool_call", "end", "error" (packages/llm-seam/src/index.ts:5-10). Consumers turn these into SessionEvents in core-agent (packages/core-agent/src/index.ts:184,257).`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_MAX_RETRIES` | 5 | `packages/llm-seam/src/index.ts:63` |
| `DEFAULT_INITIAL_DELAY_MS / DEFAULT_MAX_DELAY_MS / DEFAULT_JITTER_RATIO` | 500 / 10000 / 0.1 | `packages/llm-seam/src/index.ts:64-66` |
| `DEFAULT_RETRYABLE_CODES` | ['RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT','EMPTY_RESPONSE'] (CONTEXT_WINDOW_EXCEEDED and QUOTA are classified at packages/llm-seam/src/index.ts:16-23 but are not in the default retry set) | `packages/llm-seam/src/index.ts:67` |
| `backoffDelay (symmetric jitter)` | round(min(initial*2^(n-1), max) + random(-1..1)*jitterRatio*capped), floored at 0 | `packages/llm-seam/src/index.ts:128-133` |
| `cause-chain walk depth` | 5 (retryErrorCode; describeTransportError uses the same depth at packages/llm-seam/src/index.ts:300) | `packages/llm-seam/src/index.ts:109` |
| `image placeholder base64 prefix` | 8 characters (also the mask group at packages/llm-seam/src/index.ts:262) | `packages/llm-seam/src/index.ts:245` |

**已知缺口（原始碼內標記）**

- No usage/token event exists in the stream vocabulary — recorded as a missing seam slot by the adapters: 'the LLMStreamEvent vocabulary carries NO usage event ... (a future usage seam slot)' (packages/llm-gemini/src/index.ts:237-241) and the same note at packages/llm-bedrock/src/index.ts:225-229.

---

### `llm-anthropic`

Anthropic Messages wire adapter: streams SSE from POST {baseUrl}/v1/messages, assembles tool_use/thinking content blocks into the seam vocabulary, translates reasoning effort per model generation, and projects images out for text-only routes.

> npm `@i-harness/llm-anthropic` · 入口 `packages/llm-anthropic/src/index.ts` · 1 個原始檔 · 4 個匯出符號

**公開介面**：`AnthropicConfig`、`createAnthropicClient`、`parseSSE`、`translateReasoning`

**關鍵設計決策**

1. **Two thinking protocols selected by a model-name generation regex: claude 4.x minor >= 6 uses thinking:{type:'adaptive'} + output_config:{effort}; every older model uses thinking:{type:'enabled', budget_tokens:<table>}.**
   - 理由：Effort is sent verbatim to the adaptive protocol (xhigh/max included, provider rejects what it cannot do); the legacy protocol NEVER carries the effort string, only the budget number. 'off' and undefined produce no thinking block at all.
   - 出處：`packages/llm-anthropic/src/index.ts:48-59`、`packages/llm-anthropic/src/index.ts:61-81`
2. **Legacy budget table is low 2048 / medium 8192 / high 16384, and xhigh/max fall through verbatim into budget_tokens.**
   - 理由：Fail-loud: an unmapped level lands in the numeric slot and the provider 400s — 'no clamping/guessing'.
   - 出處：`packages/llm-anthropic/src/index.ts:56-59`、`packages/llm-anthropic/src/index.ts:65-68`
3. **Request-level reasoningEffort wins over config.options by spread order in the body.**
   - 理由：Explicit per-request intent outranks static config.
   - 出處：`packages/llm-anthropic/src/index.ts:119-121`
4. **Tool-result messages are remapped to a user message with a tool_result block, and a folded assistant step emits its text block BEFORE its tool_use blocks.**
   - 理由：Anthropic does not accept image blocks inside tool_result (images travel on a synthetic user message); M51/B2 records that dropping the pre-tool narration made the model's text vanish.
   - 出處：`packages/llm-anthropic/src/index.ts:35-46`、`packages/llm-anthropic/src/index.ts:103-115`
5. **Configured headers merge UNDER the adapter's own headers with a case-insensitive collision drop.**
   - 理由：Fetch combines Authorization and authorization into one comma-joined value, so a case-variant duplicate would corrupt the auth header.
   - 出處：`packages/llm-anthropic/src/index.ts:17-33`、`packages/llm-anthropic/src/index.ts:130`

**失敗策略**：other — failures surface as an {type:'error'} terminal event and the stream emits no 'end' after it: transport (packages/llm-anthropic/src/index.ts:136-139), non-OK HTTP or missing body (140-143), malformed tool_use input (189-191). emitEvents stops consumption on the first error event (197-206,217,224).

**事件**：`LLMStreamEvent only: "text/chunk", "reasoning" (thinking_delta / thinking block), "tool_call", "end", "error" (packages/llm-anthropic/src/index.ts:148-196,230)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `ADAPTIVE_THINKING_RE` | /\-4[-.](?:6\|7\|8\|9\|[1-9][0-9]+)/ | `packages/llm-anthropic/src/index.ts:54` |
| `legacy budget table` | low 2048, medium 8192, high 16384; xhigh/max verbatim | `packages/llm-anthropic/src/index.ts:56-59` |
| `anthropic-version header` | "2023-06-01" | `packages/llm-anthropic/src/index.ts:130` |
| `default baseUrl / endpoint` | https://api.anthropic.com (endpoint /v1/messages built at packages/llm-anthropic/src/index.ts:128) | `packages/llm-anthropic/src/index.ts:94` |

**已知缺口（原始碼內標記）**

- Token usage is not surfaced: the adapter never reads message_usage, and llm-gemini's comment names 'llm-anthropic's message_usage' as the same missing-slot gap (packages/llm-gemini/src/index.ts:238-241).

---

### `llm-openai`

OpenAI Responses wire adapter: streams SSE from POST {baseUrl}/v1/responses, maps neutral messages into Responses input items (function_call / function_call_output / input_image), and accumulates function-call arguments.

> npm `@i-harness/llm-openai` · 入口 `packages/llm-openai/src/index.ts` · 1 個原始檔 · 4 個匯出符號

**公開介面**：`OpenAIConfig`、`createOpenAIClient`、`parseSSE`、`translateReasoning`

**關鍵設計決策**

1. **One openai-family translation table for Responses\|Chat\|DeepSeek: effort verbatim into reasoning:{effort} with off -> 'none'; no generation special-casing.**
   - 理由：Stated reason: DeepSeek uses the SAME table because its server maps medium->high itself. Unset effort emits no field.
   - 出處：`packages/llm-openai/src/index.ts:59-68`、`packages/llm-openai/src/index.ts:120-121`
2. **A tool message carrying image parts is split into a function_call_output (text) plus a following user item carrying the images.**
   - 理由：M14 direct-path collapse: matches what deriveMessages emits for the agent path, so a host-built tool message cannot lose its images or smuggle them into the text field.
   - 出處：`packages/llm-openai/src/index.ts:44-57`、`packages/llm-openai/src/index.ts:95-100`
3. **A folded assistant step emits the assistant text item BEFORE the function_call items.**
   - 理由：M51/B2: dropping it lost the model's pre-tool narration.
   - 出處：`packages/llm-openai/src/index.ts:102-114`
4. **The model id comes from the adapter config (config.model), not from LLMRequest.model.**
   - 理由：The body sets model: config.model and translateReasoning is called with config.model, so a per-request model override is ignored by this adapter.
   - 出處：`packages/llm-openai/src/index.ts:89-90`、`packages/llm-openai/src/index.ts:121`
5. **Inline function_call arguments on response.output_item.added are emitted immediately and remembered so the later arguments.done does not double-emit.**
   - 理由：Some Responses streams send the full arguments with the item; the yieldedInline set prevents a duplicate tool_call.
   - 出處：`packages/llm-openai/src/index.ts:148-193`

**失敗策略**：other — error events are terminal and the stream returns without 'end': transport (packages/llm-openai/src/index.ts:136-139), non-OK HTTP (140-143), malformed inline arguments (164-166), malformed accumulated arguments (187-189). [DONE] short-circuits further consumption via receivedDone (198-201,223-229).

**事件**：`LLMStreamEvent only: "text/chunk" (response.output_text.delta), "reasoning" (response.reasoning_summary_text.delta), "tool_call", "end", "error" (packages/llm-openai/src/index.ts:150-203,241)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `endpoint / default baseUrl` | /v1/responses (base https://api.openai.com built at packages/llm-openai/src/index.ts:83) | `packages/llm-openai/src/index.ts:128` |
| `effort mapping` | reasoning:{effort}; 'off' -> 'none' | `packages/llm-openai/src/index.ts:65-68` |
| `SSE [DONE] sentinel` | data: [DONE] -> {type:'[DONE]'} (consumed at packages/llm-openai/src/index.ts:198) | `packages/llm-openai/src/index.ts:70-80` |

**已知缺口（原始碼內標記）**

- none

---

### `llm-openai-compatible`

Chat Completions wire adapter for any OpenAI-compatible endpoint: streams SSE from POST {baseUrl}/v1/chat/completions, maps neutral messages to wire messages, and accumulates index-keyed tool_call deltas.

> npm `@i-harness/llm-openai-compatible` · 入口 `packages/llm-openai-compatible/src/index.ts` · 1 個原始檔 · 4 個匯出符號

**公開介面**：`OpenAICompatibleConfig`、`createOpenAICompatibleClient`、`parseSSE`、`translateReasoning`

**關鍵設計決策**

1. **reasoning_effort is a TOP-LEVEL body field here (versus reasoning:{effort} in llm-openai), with the same verbatim / off->'none' rule and the same 'one table for the openai family' rationale.**
   - 理由：Chat Completions has no nested reasoning object; DeepSeek's server maps medium->high itself, so no adapter-side generation logic exists.
   - 出處：`packages/llm-openai-compatible/src/index.ts:46-56`、`packages/llm-openai-compatible/src/index.ts:107-108`
2. **Tool calls are emitted as soon as their accumulated function.arguments parse as complete JSON, keeping tool_call events in stream order before later text chunks.**
   - 理由：Chat Completions splits one JSON string across deltas, so a successful parse means the arguments fully arrived; a final fallback flush parses leftovers and emits an error event for unparseable buffers.
   - 出處：`packages/llm-openai-compatible/src/index.ts:149-165`、`packages/llm-openai-compatible/src/index.ts:228-237`
3. **A missing tool-call id is synthesized as `call_${index}` and the id/name are overwritten by later deltas that carry them.**
   - 理由：Keeps the index-keyed accumulator usable on endpoints that omit ids in early deltas.
   - 出處：`packages/llm-openai-compatible/src/index.ts:136`、`packages/llm-openai-compatible/src/index.ts:189-201`
4. **M59 configured headers (e.g. a gateway's x-opencode-session) merge under the adapter's own auth headers with a case-insensitive collision drop.**
   - 理由：Same Fetch comma-join hazard as the other adapters; the adapter's auth shape always wins.
   - 出處：`packages/llm-openai-compatible/src/index.ts:12-33`、`packages/llm-openai-compatible/src/index.ts:117`

**失敗策略**：other — error events are terminal and no 'end' follows: transport (packages/llm-openai-compatible/src/index.ts:123-126), non-OK HTTP (127-130), unparseable final tool args (235). [DONE] sets receivedDone and stops consumption (178-181,214-217).

**事件**：`LLMStreamEvent only: "text/chunk", "tool_call", "end", "error" (packages/llm-openai-compatible/src/index.ts:186-205,235,241)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `endpoint / default baseUrl` | /v1/chat/completions (base https://api.openai.com built at packages/llm-openai-compatible/src/index.ts:93) | `packages/llm-openai-compatible/src/index.ts:115` |
| `synthetic call id prefix` | "call_" + index | `packages/llm-openai-compatible/src/index.ts:195` |
| `effort mapping` | top-level reasoning_effort; 'off' -> 'none' | `packages/llm-openai-compatible/src/index.ts:53-56` |

**已知缺口（原始碼內標記）**

- none

---

### `llm-gemini`

Gemini generateContent wire adapter: streams SSE from POST {baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse, maps messages to contents/parts, recovers function names, and accumulates streamed functionCall args.

> npm `@i-harness/llm-gemini` · 入口 `packages/llm-gemini/src/index.ts` · 1 個原始檔 · 4 個匯出符號

**公開介面**：`GeminiConfig`、`createGeminiClient`、`parseSSE`、`translateReasoning`

**關鍵設計決策**

1. **Exactly two generation rules: gemini-2.5 -> thinkingConfig:{thinkingBudget} (off 0 / low 4096 / medium 8192 / high 16384, unmapped verbatim); everything else (gemini-3 and unknown generations) -> thinkingConfig:{thinkingLevel} with off->'minimal' and all other levels verbatim.**
   - 理由：Unknown generations default to the current thinkingLevel wire; an unsupported level reaches the provider and its 400 propagates (fail-loud).
   - 出處：`packages/llm-gemini/src/index.ts:35-57`、`packages/llm-gemini/src/index.ts:141-142`
2. **functionResponse.response must be an OBJECT, so tool content is wrapped: a valid-JSON object passes through verbatim, anything else becomes {output:<text>}, and non-string content is flattened with '[image]' placeholders.**
   - 理由：The neutral tool content is a JSON string or plain text; passing a non-object through would violate the wire contract.
   - 出處：`packages/llm-gemini/src/index.ts:80-97`、`packages/llm-gemini/src/index.ts:118-127`
3. **The function NAME is recovered from preceding assistant toolCalls by call id, because the neutral tool message carries only the id.**
   - 理由：Stated as a wire requirement plus the invariant that assistant toolCalls always precede tool results in model-visible order.
   - 出處：`packages/llm-gemini/src/index.ts:106-115`
4. **Streamed functionCall chunks accumulate with a name-opens-a-new-call rule and are emitted just before 'end'; the args parse is a concat-parse with a spread-merge fallback.**
   - 理由：Gemini streams the first chunk with the name and the rest with partial args objects; a name ALWAYS opens a new pending call so parallel same-name calls keep their own args.
   - 出處：`packages/llm-gemini/src/index.ts:169-215`、`packages/llm-gemini/src/index.ts:262`
5. **systemInstruction is emitted only when the system prompt is non-empty, and tools only when the tool list is non-empty.**
   - 理由：Keeps the body minimal for text-only/no-tool calls.
   - 出處：`packages/llm-gemini/src/index.ts:136-139`

**失敗策略**：other — error events are terminal: transport (packages/llm-gemini/src/index.ts:158-161), non-OK HTTP (162-165); a partial-args parse failure degrades to a merged object rather than erroring (203-210).

**事件**：`LLMStreamEvent only: "text/chunk", "tool_call", "end", "error" (packages/llm-gemini/src/index.ts:211,226-243,266)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `endpoint template` | {baseUrl}/v1beta/models/{encodeURIComponent(model)}:streamGenerateContent?alt=sse | `packages/llm-gemini/src/index.ts:147` |
| `gemini-2.5 budget table` | off 0, low 4096, medium 8192, high 16384; xhigh/max verbatim | `packages/llm-gemini/src/index.ts:51-54` |
| `default baseUrl` | https://generativelanguage.googleapis.com | `packages/llm-gemini/src/index.ts:100` |

**已知缺口（原始碼內標記）**

- Token usage is deliberately not surfaced: the comment records that usageMetadata (promptTokenCount / candidatesTokenCount / totalTokenCount) arrives on the last chunk but 'the LLMStreamEvent vocabulary carries NO usage event ... (a future usage seam slot)' (packages/llm-gemini/src/index.ts:237-241).

---

### `llm-bedrock`

AWS Bedrock Converse wire adapter: sends ConverseStreamCommand through the AWS SDK, walks the streamed member union into the seam vocabulary, translates reasoning per model family, and folds images/reasoning into additionalModelRequestFields.

> npm `@i-harness/llm-bedrock` · 入口 `packages/llm-bedrock/src/index.ts` · 1 個原始檔 · 6 個匯出符號

**公開介面**：`BedrockConfig`、`BedrockReasoningFields`、`BedrockRuntimeFace`、`createBedrockClient`、`resolveBedrockRegion`、`translateReasoning`

**關鍵設計決策**

1. **Reasoning translation is family-keyed: claude 4.6+ -> additionalModelRequestFields {reasoningConfig:{type:'adaptive',maxReasoningEffort}, thinking:{type:'adaptive'}}; claude <=4.5 -> thinkingConfig:{type:'enabled',budgetTokens:<table>}; nova -> adaptive reasoningConfig; unknown family -> the legacy thinkingConfig shape.**
   - 理由：The unknown-family fallback is deliberate fail-loud: 'a model that rejects it surfaces its 400 — fail-loud, never silently drop the effort'. 'off'/undefined emit no thinking fields.
   - 出處：`packages/llm-bedrock/src/index.ts:51-97`
2. **The runtime client is constructed once at adapter construction (AWS credential chain + region resolution), and a test-injected BedrockRuntimeFace replaces it entirely.**
   - 理由：Credential chain resolved once; tests inject a fake so no network/AWS credentials are needed. Region chain: config.region -> AWS_REGION -> AWS_DEFAULT_REGION -> us-east-1.
   - 出處：`packages/llm-bedrock/src/index.ts:19-29`、`packages/llm-bedrock/src/index.ts:114-120`
3. **Converse only accepts maxTokens/temperature/topP/stopSequences in inferenceConfig, so every extra option PLUS the reasoning fields go to additionalModelRequestFields.**
   - 理由：Explicit in-code statement of the wire split; the reasoning spread comes after config.options so request-level effort wins.
   - 出處：`packages/llm-bedrock/src/index.ts:10-13`、`packages/llm-bedrock/src/index.ts:126-152`
4. **Images use the Converse ImageBlock with a media-type sub-type fallback to png, and tool results become {json} when the content is a valid JSON object, else {text}.**
   - 理由：media types outside the four Converse formats are sent as png-lite; the json/text split mirrors the wire contract.
   - 出處：`packages/llm-bedrock/src/index.ts:31-47`、`packages/llm-bedrock/src/index.ts:99-112`
5. **The stream member union is soft-walked by runtime key checks because the SDK declares sibling members as `?: never` and TS's `in` narrowing cannot split the union.**
   - 理由：Documented reason in-code; the five exception members (internalServer/modelStreamError/serviceUnavailable/throttling/validation) all become error events.
   - 出處：`packages/llm-bedrock/src/index.ts:160-180`、`packages/llm-bedrock/src/index.ts:230-241`

**失敗策略**：other — SDK/send rejections propagate as exceptions (no try/catch around client.send at packages/llm-bedrock/src/index.ts:156-159); stream-side exceptions become terminal error events and the stream returns WITHOUT 'end' (packages/llm-bedrock/src/index.ts:230-248); malformed tool-use args become an error event (216-221). The abort signal is passed to the SDK request (packages/llm-bedrock/src/index.ts:156-159).

**事件**：`LLMStreamEvent only: "text/chunk", "reasoning" (contentBlockDelta.reasoningContent), "tool_call", "end", "error" (packages/llm-bedrock/src/index.ts:190-224,243-250)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `region chain` | config.region -> AWS_REGION -> AWS_DEFAULT_REGION -> 'us-east-1' | `packages/llm-bedrock/src/index.ts:23-29` |
| `ADAPTIVE_CLAUDE_RE` | /\-4[-.](?:6\|7\|8\|9\|[1-9][0-9]+)/ | `packages/llm-bedrock/src/index.ts:56` |
| `legacy budget table` | low 2048, medium 8192, high 16384; xhigh/max verbatim | `packages/llm-bedrock/src/index.ts:58-61` |
| `only external (non-workspace) runtime dependency in this package group` | @aws-sdk/client-bedrock-runtime ^3.800.0 (declared in packages/llm-bedrock/package.json) | `packages/llm-bedrock/src/index.ts:2-3` |

**已知缺口（原始碼內標記）**

- Token usage is not surfaced: the comment records that the metadata member carries the usage snapshot but 'the seam's LLMStreamEvent vocabulary has NO usage event (same gap as llm-anthropic / llm-gemini), so the wire position is documented here' (packages/llm-bedrock/src/index.ts:225-229).

---

### `llm-mock`

A scripted mock ModelClient: each stream() call replays exactly one MockStep (its tool calls, then its text, then 'end'), consuming the script destructively one step per model turn.

> npm `@i-harness/llm-mock` · 入口 `packages/llm-mock/src/index.ts` · 1 個原始檔 · 3 個匯出符號

**公開介面**：`MockStep`、`MockToolCall`、`createMockClient`

**關鍵設計決策**

1. **Turn-based destructive consumption: one stream() call = one script step, so a script maps 1:1 to model turns.**
   - 理由：The comment states the cassette is one-shot and each call replays the NEXT step.
   - 出處：`packages/llm-mock/src/index.ts:14-26`
2. **Tool calls are yielded before the step's text, then 'end'.**
   - 理由：Fixed intra-step ordering so tests can assert on a deterministic event sequence.
   - 出處：`packages/llm-mock/src/index.ts:27-31`

**失敗策略**：fail-loud on exhaustion: an empty script yields {type:'error'} 'mock script exhausted' instead of a silent end (packages/llm-mock/src/index.ts:22-25).

**事件**：`LLMStreamEvent only: "tool_call", "text/chunk", "end", "error" (packages/llm-mock/src/index.ts:23-31)`

**已知缺口（原始碼內標記）**

- none

---

### `provider`

The provider plane: protocol enum + ProviderProfile/registry, the unified model-context resolution chain over a capability-card catalog, the per-route model-probe machinery (protocol-aware auth, dual candidate paths, response normalization), the adapter dispatch (buildModelClient / buildWireClient), and the id-keyed websearch provider seam.

> npm `@i-harness/provider` · 入口 `packages/provider/src/index.ts` · 1 個原始檔 · 32 個匯出符號

**公開介面**：`ProviderProtocol`、`ProviderProfile`、`ProviderModelContext`、`ProviderRegistry`、`ModelCard`、`ModelDescriptor`、`DirectoryEntry`、`EffectiveContextInput`、`EffectiveModelContext`、`Probe`、`ProbeRequest`、`ProbeUnavailableError`、`ModelProbeFailedError`、`WireClientConfig`、`buildModelClient`、`buildWireClient`、`createProviderRegistry`、`defaultProviderRegistry`、`describeDirectory`、`probeCandidatePaths`、`probeModels`、`registerProbe`、`resolveEffectiveModelContext`、`resolveModelCard`、`resolveModelContext`、`WebSearchProvider`、`WebSearchRequest`、`WebSearchResult`、`WebSearchSource`、`getWebSearchProvider`、`registerWebSearchProvider`、`tryGetWebSearchProvider`

**關鍵設計決策**

1. **The registry IS the directory: describeDirectory() is a view over profiles registered through register(), and runtime credentials (apiKey/baseUrl) never surface in a DirectoryEntry.**
   - 理由：Avoids a second registration mechanism; the directory row carries only route/displayName/protocol/apiKeyEnv/defaultModel/models.
   - 出處：`packages/provider/src/index.ts:160-167`、`packages/provider/src/index.ts:248-261`
2. **Effective model context is a per-field chain userModel > profile.modelContexts[modelId] > profile.contextWindow > model-catalog CARD > undefined; the card is value-only and never provides a request default.**
   - 理由：The card arm fills a missing contextWindow but never overwrites, maxOutputTokens comes from card/user maxTokens, and a run with no window knowledge anywhere returns undefined (fail-closed consumers gate on contextWindow).
   - 出處：`packages/provider/src/index.ts:52-59`、`packages/provider/src/index.ts:117-158`
3. **Probe dispatch order: explicit registerProbe for the route > a request carrying an explicit modelsURL/baseURL (generic builtin probe for ANY route) > the built-in probe for the openai-compatible route when a base URL exists > the profile's static models list > ProbeUnavailableError.**
   - 理由：The route gate cannot apply to an unsaved draft; the static catalog is the offline fallback only for a route with no base URL, and the built-in probe always wins for openai-compatible because 'discovery IS the openai-compatible route's content'.
   - 出處：`packages/provider/src/index.ts:591-647`
4. **Probe URL/auth discipline: protocol-aware auth headers (anthropic-messages -> x-api-key + anthropic-version, gemini -> x-goog-api-key, everything else -> Bearer), an absent key omits the header entirely, both URLs are validated http/https, and a 10s AbortSignal.timeout bounds every candidate.**
   - 理由：'never `Bearer undefined`'; a black-hole baseURL must not hang the settings request; status errors try the sibling candidate while transport/shape failures are structural and stop the loop.
   - 出處：`packages/provider/src/index.ts:263-272`、`packages/provider/src/index.ts:340-355`、`packages/provider/src/index.ts:437-495`、`packages/provider/src/index.ts:497-519`
5. **Probe response normalization accepts array \| {data\|models\|items: [...]} \| {data\|models\|items: {id:row}} \| a bare {id:row} map, with per-field capacity rules where the limit.{context,output} pair is atomic.**
   - 理由：opencode/cc-switch shapes are accepted; a half-pair never surfaces (a missing/invalid half drops both) and an entry with no resolvable id raises a branded ModelProbeFailedError instead of a bare TypeError.
   - 出處：`packages/provider/src/index.ts:357-398`、`packages/provider/src/index.ts:400-435`
6. **buildModelClient dispatches on profile.protocol and wraps the client with the retrying client ONLY when profile.retryPolicy is set; the default model falls back profile.defaultModel then 'gpt-4o'.**
   - 理由：Absent retryPolicy leaves the protocol client unwrapped (pre-M20 behavior); an unknown protocol throws at build time.
   - 出處：`packages/provider/src/index.ts:702-737`
7. **Websearch is a zero-default id-keyed seam: no built-in provider, pin > exactly-one > error, and a missing map means the websearch tool is simply not registered.**
   - 理由：Registered under the 'websearch/provider' service as a Map; a duplicate id throws; NO_PROVIDER/MULTIPLE_PROVIDERS are the two fail-loud misconfiguration classes.
   - 出處：`packages/provider/src/index.ts:780-863`

**失敗策略**：fail-loud / fail-closed. register() throws on a duplicate route and validates contextWindow/maxContextWindow and the retry policy at registration (packages/provider/src/index.ts:603-608,683-700); an unknown protocol throws at build (723-725); probe failures carry the branded code 'model-probe-failed' while 'no probe and no catalog' is 'probe-unavailable' (216-235); a model row with no resolvable id throws (389-398); resolveModelCard returns undefined rather than a synthetic value (110-115); the model catalog is validated at load and throws on a malformed route/model row (70-99); websearch throws NO_PROVIDER / MULTIPLE_PROVIDERS / duplicate-id (820-862).

**事件**：`none`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `ProviderProtocol` | ['openai-responses','openai-compatible','anthropic-messages','gemini','bedrock'] | `packages/provider/src/index.ts:9` |
| `PROBE_TIMEOUT_MS` | 10000 (applied to every candidate fetch at packages/provider/src/index.ts:447) | `packages/provider/src/index.ts:265` |
| `PROBE_CANDIDATE_PATHS` | ['/v1/models','/models'] | `packages/provider/src/index.ts:272` |
| `COMPAT_BASE_SUFFIXES` | ['/anthropic','/api/claudecode','/api/anthropic','/api/coding','/claude','/step_plan','/apps/anthropic'] | `packages/provider/src/index.ts:280-288` |
| `ANTHROPIC_API_VERSION` | "2023-06-01" | `packages/provider/src/index.ts:317` |
| `default model fallback` | "gpt-4o" | `packages/provider/src/index.ts:733` |
| `model-catalog seeds` | deepseek v4 line 1048576/384000; gemini 2.5 1048576/65536 and 1.5-pro 2097152/8192; bedrock claude-3-5 200000/8192 (data file: packages/provider/src/model-catalog.json) | `packages/provider/src/index.ts:61-67` |

**已知缺口（原始碼內標記）**

- buildWireClient (the RESOLVED-wire-protocol dispatch, packages/provider/src/index.ts:739-778) has no production caller: repo-wide it appears only in packages/provider/test/provider.test.ts:43-47.
- Its doc comment assigns the unknown-protocol case to 'the caller owns the warn + mock fallback' (packages/provider/src/index.ts:760-761) but the function just returns undefined and no such fallback exists in this package.
- maxContextWindow is declared as an 'absolute ceiling; budget-enforcement hook (no enforcement in M15)' — the hook is still unimplemented (packages/provider/src/index.ts:30).

---

### `provider-runtime`

The settings+credentials-backed provider runtime: merges registry templates with user settings rows into a directory view, persists provider config / keys / default model, runs model discovery, and resolves a session's model into a ready ModelClient binding or a typed unconfigured/invalid state.

> npm `@i-harness/provider-runtime` · 入口 `packages/provider-runtime/src/index.ts` · 1 個原始檔 · 6 個匯出符號

**公開介面**：`CreateProviderRuntimeOptions`、`ModelResolutionState`、`ProviderRuntime`、`ProviderRuntimeEntry`、`SessionModelBinding`、`createProviderRuntime`

**關鍵設計決策**

1. **Model-resolution precedence: explicit override string 'provider:model' > session selection (provider+model+reasoningEffort) > settings llm.defaultModel; an empty default yields status 'unconfigured'.**
   - 理由：selectModel encodes the order and returns a typed state object instead of throwing for malformed input (override without a colon, empty provider/model, no model configured).
   - 出處：`packages/provider-runtime/src/index.ts:496-542`、`packages/provider-runtime/src/index.ts:298-302`
2. **resolveModel validates in order provider existence, catalog membership, effort vocabulary, auth presence, auth resolution, ambient restriction, credential value, then buildClient — each failure a typed state with a reason.**
   - 理由：Keeps the caller's failure handling uniform ('invalid' carries providerId/modelId where known; 'unconfigured' means no usable credential) and wraps buildClient throws into an invalid state rather than propagating.
   - 出處：`packages/provider-runtime/src/index.ts:303-405`
3. **Auth is ref-based and derived from the view: apiKeyEnv -> {kind:'api-key-ref', ref}, bedrock -> {kind:'ambient'}, otherwise undefined (unconfigured).**
   - 理由：The runtime never holds key material in settings; the ref name is resolved through @i-harness/credentials at use time. An 'ambient' resolution is only accepted for the bedrock protocol.
   - 出處：`packages/provider-runtime/src/index.ts:473-483`、`packages/provider-runtime/src/index.ts:353-370`
4. **The runtime profile REPLACES the template's inline apiKey with the resolved value and maps the settings/adapter vocabularies (openai-completions <-> openai-compatible).**
   - 理由：delete template.apiKey prevents a static template key from leaking past the credential resolution path; templateSettingsProtocol/adapterProtocol bridge the settings enum and ProviderProfile.protocol.
   - 出處：`packages/provider-runtime/src/index.ts:449-471`、`packages/provider-runtime/src/index.ts:485-494`
5. **View precedence is user > template per field (displayName, baseURL, apiKeyEnv, headers wholesale, inputModalities), and models merge with user rows winning per field.**
   - 理由：A user header MAP replaces the template's whole map (not a per-key merge); a model entry's inputModalities may narrow/override the route declaration (M61), with absent-on-both meaning text-only.
   - 出處：`packages/provider-runtime/src/index.ts:409-447`、`packages/provider-runtime/src/index.ts:563-573`
6. **Discovery caches per provider until force, merges probe rows UNDER manual rows (manual wins), and is refused entirely for bedrock.**
   - 理由：discoverModels throws 'Discovery is not available for this provider; add a model ID manually.' for bedrock; the merged catalog is written back into settings and cached.
   - 出處：`packages/provider-runtime/src/index.ts:237-288`、`packages/provider-runtime/src/index.ts:161`
7. **The apiKey ref name is generated from the provider id: upper-snake-cased id + '_API_KEY'.**
   - 理由：Guarantees the ref satisfies the credentials env-grammar pattern; leading digits are prefixed with PROVIDER_ and an empty result becomes PROVIDER.
   - 出處：`packages/provider-runtime/src/index.ts:627-635`

**失敗策略**：mixed by operation. Read/resolve paths return typed states instead of throwing ('unconfigured'/'invalid'), including a caught auth-resolution failure (packages/provider-runtime/src/index.ts:330-334,336-351,356-361,364-369,398-404); mutations and discovery throw: 'provider id is required' (637-639), 'provider "<id>" is not configured' (246), 'No API key configured for provider' (252,259), bedrock manual-only (247-249). resolveModel returns a binding only after buildClient succeeds, so an unknown provider/model is never silently substituted.

**事件**：`none`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `REASONING_EFFORTS` | {off, low, medium, high, xhigh, max} | `packages/provider-runtime/src/index.ts:106-113` |
| `api key ref convention` | <UPPER_SNAKE_PROVIDER_ID>_API_KEY | `packages/provider-runtime/src/index.ts:627-635` |
| `discovery availability` | bedrock => 'manual-only', everything else => 'available' | `packages/provider-runtime/src/index.ts:161` |
| `binding label` | '<displayName> · <modelId>' unless displayName is empty or equals the id, then '<providerId>:<modelId>' | `packages/provider-runtime/src/index.ts:388-393` |

**已知缺口（原始碼內標記）**

- OAuth provider auth is declared but unreachable: authRef only ever builds 'api-key-ref' or 'ambient' (packages/provider-runtime/src/index.ts:473-477), while the credentials resolver maps the declared 'oauth-account-ref' kind to {configured:false, source:'oauth'} / undefined (packages/credentials/src/index.ts:162,167) — no OAuth flow exists.
- discovered (the discovery cache) is in-memory only: it is cleared on upsert/remove and never reloaded from settings, so a restart re-probes (packages/provider-runtime/src/index.ts:119,174,189,286).

---

### `credentials`

The ref-based credential store: one JSON document of ref -> value under the config home with env-over-file precedence and atomic 0600 writes, plus a ProviderAuthResolver that turns provider auth refs into api-key/bearer/ambient values.

> npm `@i-harness/credentials` · 入口 `packages/credentials/src/index.ts` · 1 個原始檔 · 11 個匯出符號

**公開介面**：`CredentialDocument`、`CredentialInfo`、`CredentialRefError`、`CredentialShadowedError`、`CredentialSource`、`CredentialStore`、`ProviderAuthRef`、`ProviderAuthResolver`、`ResolvedProviderAuth`、`createCredentialStore`、`createProviderAuthResolver`

**關鍵設計決策**

1. **'Refs not values': the settings document may hold only a ref NAME (apiKeyEnv); describe() is a one-way redacted record that never carries the value, and resolve() is the internal read that hands the value to a builder.**
   - 理由：Module doc: 'the settings document must NEVER hold key material — it only references a credential ref by name (apiKeyEnv)'; resolve is explicitly 'NOT part of the one-way surface (never echo a value through describe; resolve hands it to a builder, never to a UI-facing reader)'. Settings mirrors this: apiKeyEnv is role 'credential-ref' and no inline apiKey field exists (packages/settings/src/sections.ts:137; packages/settings/src/index.ts:125-128).
   - 出處：`packages/credentials/src/index.ts:1-10`、`packages/credentials/src/index.ts:36-49`、`packages/credentials/src/index.ts:109-120`
2. **Read precedence env > file, and a WRITE on an env-shadowed ref is REJECTED with CredentialShadowedError (code 'credential-rejected').**
   - 理由：Stated reason: 'Silent shadowed writes would make the user believe the file value took effect; reject instead.' The env var name IS the ref (refs are env-grammar identifiers).
   - 出處：`packages/credentials/src/index.ts:5-10`、`packages/credentials/src/index.ts:93-104`、`packages/credentials/src/index.ts:128-130`、`packages/credentials/src/index.ts:134-141`、`packages/credentials/src/index.ts:197-203`
3. **Empty/whitespace means 'not configured here', symmetrically: writes reject it, the loader drops such entries, and an empty env var does NOT shadow the file.**
   - 理由：Self-consistent emptiness stance so {configured:false} is what an empty secret reliably reports.
   - 出處：`packages/credentials/src/index.ts:11-16`、`packages/credentials/src/index.ts:182-195`、`packages/credentials/src/index.ts:219-223`
4. **Reads degrade to empty and never throw; writes are atomic (tmp + rename) with mode 0600 on the temp file plus a defensive chmod.**
   - 理由：A missing file is a normal first run; a corrupt or non-conforming document degrades to empty but reports via console.warn. The atomic mode param creates the temp 0600 so the leftover window and the renamed file are never world-readable; on win32 chmod is best-effort because Node ignores POSIX bits.
   - 出處：`packages/credentials/src/index.ts:17-27`、`packages/credentials/src/index.ts:205-231`、`packages/credentials/src/index.ts:242-254`
5. **Values at rest are plaintext in the refs JSON map; the stated protection is file permissions plus atomic replacement — no encryption or OS keychain.**
   - 理由：The document is JSON.stringify({refs}) written by writeFileAtomic(path, json, 0o600); nothing in the module encrypts or delegates to a keychain.
   - 出處：`packages/credentials/src/index.ts:77-80`、`packages/credentials/src/index.ts:246-253`

**失敗策略**：split: fail-open on READ (missing file -> {} silently; corrupt/unshapeable -> {} + console.warn via warnBad; packages/credentials/src/index.ts:205-240) and fail-loud on WRITE. Rejections: a ref that does not match the env-grammar pattern -> CredentialRefError 'credential-invalid-ref' (174-180); an empty/whitespace or non-string set value -> CredentialRefError (182-188); a write/unset on an env-provided ref -> CredentialShadowedError 'credential-rejected' (197-203). unset on an absent ref is an idempotent no-op (146).

**事件**：`none`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `REF_PATTERN` | /^[A-Za-z_][A-Za-z0-9_]*$/ (a valid environment-variable name) | `packages/credentials/src/index.ts:106-107` |
| `file mode` | 0o600 (atomic-write temp mode + chmodSync best-effort) | `packages/credentials/src/index.ts:248-253` |
| `error codes` | 'credential-invalid-ref' (CredentialRefError at packages/credentials/src/index.ts:86) / 'credential-rejected' (CredentialShadowedError at packages/credentials/src/index.ts:99) | `packages/credentials/src/index.ts:86` |

**已知缺口（原始碼內標記）**

- OAuth is a declared stub: ProviderAuthRef includes {kind:'oauth-account-ref'} but describe returns {configured:false, source:'oauth', writable:false} and resolve returns undefined (packages/credentials/src/index.ts:54,162,167) — there is no OAuth implementation or caller.
- 'bearer' is a declared resolved kind but no code path produces it (packages/credentials/src/index.ts:58 vs the only producer at 169 returning {kind:'api-key'}).

---

### `preset`

Agent presets: the JSON preset shape (name/systemPrompt/tools/model), parsePreset validation, mountPreset (resolving the preset's tools through a ToolProvider into a fresh child scope), and the I-harness-owned DEFAULT_AGENT_PRESET system prompt.

> npm `@i-harness/preset` · 入口 `packages/preset/src/index.ts` · 2 個原始檔 · 5 個匯出符號

**公開介面**：`AgentPreset`、`DEFAULT_AGENT_PRESET`、`ToolProvider`、`mountPreset`、`parsePreset`

**關鍵設計決策**

1. **mountPreset resolves EVERY tool BEFORE mutating any scope, so an unknown tool throws with no partial mount.**
   - 理由：Stated as audit F10-1: resolution happens before any scope mutation so the failure is fail-loud and leaves no half-mounted child.
   - 出處：`packages/preset/src/index.ts:26-41`
2. **Per-agent configuration is scoped to the child: the 'preset' service and the resolved tools go into a freshly mounted child scope, lazily creating a tools/registry when the caller exposed none.**
   - 理由：Keeps a preset from leaking its tools/system prompt into the parent scope; the get-or-create mirrors the interaction pattern.
   - 出處：`packages/preset/src/index.ts:43-63`
3. **The default preset's system prompt is the readable in-repo source and is treated as a BASE by the assembly, not as the final prompt.**
   - 理由：default.ts states 'the readable source here IS the authoritative default system prompt' while 'the assembly composes its runtime sections AFTER this base, and the model's user message always outranks the system prompt'; the consumer appends the sandbox policy context after it (packages/session-executor/src/assembly.ts:592-602).
   - 出處：`packages/preset/src/default.ts:1-7`、`packages/preset/src/default.ts:11-52`

**失敗策略**：fail-loud. parsePreset throws 'invalid preset: name, systemPrompt, tools required' (packages/preset/src/index.ts:18-24); mountPreset throws `preset '<name>' requires unknown tool: <name>` before any scope mutation (packages/preset/src/index.ts:35-41).

**事件**：`none`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_AGENT_PRESET.name` | "default" | `packages/preset/src/default.ts:12` |
| `DEFAULT_AGENT_PRESET.tools` | ['read','write','list_dir','grep','glob','bash'] | `packages/preset/src/default.ts:53-60` |

**已知缺口（原始碼內標記）**

- mountPreset and ToolProvider have no production caller: repo-wide they appear only in packages/preset/test/preset.test.ts:38,46,57 (plus a TUI comment at packages/tui/src/views/light-personas.ts:2). The only production consumer uses parsePreset(...).systemPrompt / DEFAULT_AGENT_PRESET.systemPrompt (packages/session-executor/src/assembly.ts:63,598-599), so the preset's tools/model fields are not applied anywhere.

---

## 服務面、生態與多智能體

### `web-host`

The web service surface: one node:http server with unary JSON HTTP routes (sessions/workspaces/settings/models/plugins/goal/jobs/feedback/attachments/commands) plus a single WebSocket mux at /api/mux that multiplexes named live streams. It is transport-only: it maps embedder seams (executor, coordinator, settings, plugin registry, bridges) onto wire shapes and never touches those packages' internals.

> npm `@i-harness/web-host` · 入口 `packages/web-host/src/index.ts` · 11 個原始檔 · 15 個匯出符號

**公開介面**：`createWebHost`、`WebHost`、`WebHostOptions`、`attachLiveSession (WebHost method)`、`WebSocketMuxServer`、`LiveSessionStreams`、`AgentState`、`ApprovalMuxBridge`、`ApprovalWaterfall`、`QuestionMuxBridge`、`QuestionWaterfall`、`paginateEvents`、`PaginateOptions`、`createAuth`、`AuthContext`、`AuthOptions`

**關鍵設計決策**

1. **Transport shape: HTTP unary routes + ONE WebSocket mux with named stream endpoints (session/chunk/reasoning/agent-state/approval/question/command), not per-feature sockets and not SSE.**
   - 理由：One socket multiplexes many streams addressed by streamId; each open is answered with {type:'ready'} then {type:'item'}... then {type:'end'}, is cancellable by {type:'cancel'}, and approval/question answers ride the same socket as non-open messages keyed by a globally unique id. History is served by the HTTP events route with paging; the live streams deliberately have no replay.
   - 出處：`packages/web-host/src/types.ts:88`、`packages/web-host/src/types.ts:97`、`packages/web-host/src/host.ts:598`、`packages/web-host/src/mux.ts:103`、`packages/web-host/src/mux.ts:146`、`packages/web-host/src/live.ts:28`
2. **Auth is opt-in and layered on top of an ALWAYS-ON DNS-rebind/CORS fence: the Host header and (if present) the Origin header must be loopback for every HTTP request and for the mux upgrade, unconditionally; only then does the optional launch-token/HMAC-cookie check apply.**
   - 理由：When opts.auth is absent there is NO authentication at all (documented dev/test posture) — but the fence still runs, because browsers do not apply CORS to WebSocket frames. With auth present: a ?token=<launchToken> query bootstraps GET /api/auth/login, which sets an HttpOnly SameSite=Strict HMAC-signed cookie (hmacSecret must be >=32 chars); every route then answers 401 without a valid cookie or token, and the upgrade is destroyed before upgrade.
   - 出處：`packages/web-host/src/host.ts:319`、`packages/web-host/src/host.ts:716`、`packages/web-host/src/host.ts:740`、`packages/web-host/src/host.ts:750`、`packages/web-host/src/host.ts:876`、`packages/web-host/src/auth.ts:81`、`packages/web-host/src/auth.ts:94`、`packages/web-host/src/auth.ts:49`
3. **The server is single-workspace: execution workspace is fixed at construction (opts.workspace, canonicalized once); a POST /api/sessions body `cwd` is only recorded into the workspace registry for grouping and returns a `workspaceWarning` string when it differs from the execution workspace.**
   - 理由：The executor roots runtime-context, shell default cwd and the sandbox writable root in the SERVER's workspace. The warning is a response FIELD, not a rejection and not a redirect: it does not change the session's workspace, does not move files/shell/sandbox, does not error, and is omitted entirely when opts.workspace is absent (no claim made). It only fires for the cwd path (canonicalCwd set), not for an explicit workspaceId, and only when both are non-empty and differ. With no workspaceRegistry seam, both `cwd` and `workspaceId` are deleted from the body and ignored entirely (never written into the session header).
   - 出處：`packages/web-host/src/host.ts:259`、`packages/web-host/src/host.ts:514`、`packages/web-host/src/host.ts:1199`、`packages/web-host/src/host.ts:1242`、`packages/web-host/src/host.ts:1247`、`packages/web-host/src/host.ts:352`
4. **Live streams are per-session refcounted bundles with gen-forward rebind; persistence snapshots are never trusted as the live instance.**
   - 理由：coordinator.load() returns a fresh snapshot object, so a bundle built on it would never see appends. attachLiveSession() registers the real instance AND re-points already-open generators (reattach) instead of evicting them, so streams opened at session-select time switch to the live session on the next pull. The cache entry is pruned when the last stream for a session ends.
   - 出處：`packages/web-host/src/host.ts:20`、`packages/web-host/src/host.ts:629`、`packages/web-host/src/host.ts:2477`、`packages/web-host/src/live.ts:49`

**失敗策略**：fail-closed at the security boundary, explicit elsewhere: non-loopback Host/Origin -> 403 (and socket.destroy() on upgrade), missing/invalid credentials -> 401, before any dispatch (host.ts:718-728, 759-770, 745). Approval requests that are never answered resolve {approved:false} on a 30s timeout (fail-closed, approval.ts:44-51). Missing optional seams answer per-route 404 (or 500 for coordinator-required routes); an unexpected route throw becomes a JSON 500 via the owns-the-response catch, never an unhandled rejection (host.ts:685-693).

**事件**：`consumes: every SessionEvent type via the mux `session` stream (subscribe-based, no replay) — packages/web-host/src/live.ts:63`、`consumes: job/status (SPA fold; host serves the durable doc + queue) — packages/web-host/src/host.ts:1765`、`produces: goal/change — the goal mutation routes append the goal package's event to the live session and flush — packages/web-host/src/host.ts:799`、`produces (mux frames, not SessionEvents): ready/item/end/error — packages/web-host/src/types.ts:111`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_PAGE_LIMIT` | 200 | `packages/web-host/src/pagination.ts:14` |
| `MAX_PAGE_LIMIT` | 500 | `packages/web-host/src/pagination.ts:16` |
| `MAX_SESSION_TITLE_LENGTH` | 200 UTF-16 code units | `packages/web-host/src/host.ts:135` |
| `MAX_FILE_QUERY_LENGTH` | 200 | `packages/web-host/src/host.ts:139` |
| `MAX_BUFFERED_BYTES (slow-consumer shed)` | 8 * 1024 * 1024 | `packages/web-host/src/mux.ts:27` |
| `mux heartbeat interval` | 30_000 ms, ping only (no pong timeout) | `packages/web-host/src/mux.ts:63` |
| `DEFAULT_HOST_VERSION` | "0.1.0" | `packages/web-host/src/host.ts:297` |
| `approval waterfall timeout default` | 30_000 ms -> {approved:false} | `packages/web-host/src/approval.ts:22` |
| `ATTACHMENT_ID_RE` | ^att-<uuid>$ (validated before any store call) | `packages/web-host/src/host.ts:293` |

**已知缺口（原始碼內標記）**

- GET /api/telemetry is deliberately absent: the route is not implemented and falls through to the JSON 404 (host.ts:2429-2430).
- The mux heartbeat is ping-only with no pong-timeout liveness check; a silently dead peer is reaped by TCP timeout or the next failed write (mux.ts:59-62).
- A client reconnecting mid-turn is seeded {status:'idle'} by agentState because subscribe() has no history replay; accepted as a documented minor (live.ts:224-228).
- Prompt queue storage/reorder is explicitly not implemented: the only queue is the executor's per-session lane; 'no prompt storage, reorder deferred per the task brief' (host.ts:1764).

---

### `sdk`

The external stdio SDK: NDJSON JSON-RPC 2.0 framing (protocol.ts), a client with low-level request exchange plus a high-level run(session) surface (client.ts), and an in-process SessionService-backed server entry (server.ts, subpath ./server) that the CLI wires to stdio as `i-harness sdk`.

> npm `@i-harness/sdk` · 入口 `packages/sdk/src/index.ts` · 4 個原始檔 · 11 個匯出符號

**公開介面**：`HarnessClient`、`HarnessSession`、`createHarnessClient`、`runHarness`、`SdkConnectionError`、`SdkRunError`、`ServerInfo`、`RunInput`、`RunResult`、`QueueState`、`HistoryOptions`、`(via `export * from ./protocol.ts`): PROTOCOL_VERSION, JSON-RPC error codes, RpcRequest/RpcNotification/RpcSuccess/RpcFailure, RpcError, JsonRpcLineTransport, encodeFrame/decodeFrame, all wire view types`、`(subpath ./server, NOT in index.ts): createSdkServer, SDK_SERVER_NAME, SDK_SERVER_PROTOCOL_VERSION, SdkServer, SdkServerOptions`

**關鍵設計決策**

1. **Wire protocol: ONE JSON-RPC 2.0 message per NDJSON line over a duplex (stdio); malformed lines are silently ignored and never echoed; request ids echo into responses.**
   - 理由：This file IS the wire contract. Framing is pure (no I/O): encodeFrame = JSON.stringify + '\n'; decodeFrame returns undefined for any malformed/unknown-shape line, and the transport drops those lines before listeners. Client->server notifications are accepted-and-ignored in v1.
   - 出處：`packages/sdk/src/protocol.ts:1`、`packages/sdk/src/protocol.ts:533`、`packages/sdk/src/protocol.ts:541`、`packages/sdk/src/protocol.ts:566`、`packages/sdk/src/server.ts:688`
2. **protocolVersion = 2, with an explicitly FROZEN v0 field-level contract and an additive-only versioning rule.**
   - 理由：The v0 surface (initialize / session/prompt / session/status / shutdown; session/event + session/status notifications) is declared FROZEN (M28 S-1, 2026-09-01) with a field-level drift sentinel test; v1 (M41a) and the v1.1/Task addenda only ADD capability rows and methods — changing or removing an existing shape/field/code is a breaking change requiring a version bump. protocolVersion stayed 2 across v1.1, Task 4, Task 11 and Task 12 addenda.
   - 出處：`packages/sdk/src/protocol.ts:14`、`packages/sdk/src/protocol.ts:19`、`packages/sdk/src/protocol.ts:46`、`packages/sdk/src/protocol.ts:216`、`packages/sdk/src/server.ts:70`、`packages/sdk/src/server.ts:266`
3. **Host capabilities are advertised as capability rows, and a method whose host seam is absent answers -32601/-32603 rather than pretending to work; session/list with no listing source answers an honest blank.**
   - 理由：initialize returns capabilities whose rows are added only when the corresponding host operation exists (session-rewind only with a rewindFactory; session-create/session-fork/session-model only with the matching seam). With no listSessions source, session/list returns { sessions: [], listingUnavailable: true } instead of a fabricated empty list; a throwing source is -32603 (fail-closed).
   - 出處：`packages/sdk/src/protocol.ts:74`、`packages/sdk/src/server.ts:282`、`packages/sdk/src/server.ts:297`、`packages/sdk/src/server.ts:488`、`packages/sdk/src/protocol.ts:270`
4. **The server is session-service backed and per-session serialized around one AbortController slot per in-flight submit; the client is transport-agnostic (in-process or spawned subprocess).**
   - 理由：session/prompt creates the per-session controller BEFORE service.submit, session/cancel aborts it, and the finally clears the slot only if it still holds this submit's controller — a staggered second submit is not clobbered early. Replay semantics are explicit: session/event is append-only and never replayed, while durable state resumes by sessionId.
   - 出處：`packages/sdk/src/protocol.ts:41`、`packages/sdk/src/server.ts:647`、`packages/sdk/src/server.ts:445`、`packages/sdk/src/server.ts:170`

**失敗策略**：other — fail-open framing plus fail-closed request semantics: malformed lines are ignored (no error frame) and client notifications are dropped, while invalid params/unknown sessions answer -32602 with an explicit 'session not found' (no auto-create), unknown methods answer -32601, and host/engine errors answer -32603 with the raw message (protocol.ts:37, server.ts:479, server.ts:678, server.ts:763). session/cancel is the deliberate exception: an unknown session is answered inside the success payload as {cancelled:false, reason:'not-found'} — never an error frame (server.ts:432-453).

**事件**：`session/event (server->client notification carrying any SessionEvent, one per append: packages/sdk/src/server.ts:174)`、`session/status (server->client notification: queued/idle/error: packages/sdk/src/server.ts:179)`、`consumes all SessionEvent types via core-session subscribe; appends the host's rewind marker via appendEvent (packages/sdk/src/server.ts:621)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `PROTOCOL_VERSION` | 2 | `packages/sdk/src/protocol.ts:216` |
| `HISTORY_DEFAULT_LIMIT` | 500 | `packages/sdk/src/server.ts:73` |
| `HISTORY_LIMIT_CAP` | 1000 | `packages/sdk/src/server.ts:74` |
| `REQUEST_TIMEOUT_MS (client)` | 60_000 | `packages/sdk/src/client.ts:98` |
| `JSON-RPC error codes` | PARSE_ERROR -32700, INVALID_REQUEST -32600, METHOD_NOT_FOUND -32601, INVALID_PARAMS -32602, INTERNAL_ERROR -32603 | `packages/sdk/src/protocol.ts:218` |
| `SDK_SERVER_NAME` | "i-harness" | `packages/sdk/src/server.ts:69` |

**已知缺口（原始碼內標記）**

- Client -> server notifications are accepted-and-ignored in v1 (a documented limitation, not an error): packages/sdk/src/server.ts:688.
- INVALID_REQUEST (-32600) is defined but never emitted — malformed lines are ignored instead: packages/sdk/src/protocol.ts:37.
- Historical events are never replayed to a fresh subscription; replay/resume is the client's problem via session/history: packages/sdk/src/protocol.ts:41.

---

### `acp`

An Agent Client Protocol (ACP v1) server implementing the automation subset over the official @agentclientprotocol/sdk agent app: initialize, session/new, session/list, session/resume, session/close, session/prompt, and the session/cancel notification.

> npm `@i-harness/acp` · 入口 `packages/acp/src/index.ts` · 1 個原始檔 · 5 個匯出符號

**公開介面**：`createAcpServer`、`AcpServer`、`AcpServerOptions`、`ACP_SERVER_NAME`、`ACP_PROTOCOL_VERSION`

**關鍵設計決策**

1. **Implemented ACP subset is exactly the seven automation methods/notifications; everything else is a documented v0 drop-set.**
   - 理由：initialize (echoes ACP_PROTOCOL_VERSION = the SDK's PROTOCOL_VERSION, declares sessionCapabilities {list, close, resume}); session/new (coordinator-backed id when a coordinator is given, else randomUUID); session/list (coordinator list UNION sessions created here, unknown cwd reported as process.cwd()); session/resume (ownership adopt; unknown ids fail closed); session/close (abort in-flight + closeSession + flush + release ownership); session/prompt (await service.submit, stopReason 'end_turn' / 'cancelled'); session/cancel notification (abort all in-flight submits). Drop-set: MCP servers on session/new, per-session cwd execution, session/update mirroring, session/delete, session/fork, session/set_mode, session/set_config_option, terminal/fs/elicitation client-method calls, authentication methods.
   - 出處：`packages/acp/src/index.ts:5`、`packages/acp/src/index.ts:21`、`packages/acp/src/index.ts:106`、`packages/acp/src/index.ts:238`
2. **The v0 permission face is a binary switch, not a round-trip: autoApprove (default true) = allow-once admission, autoApprove false = prompts refused.**
   - 理由：There is no client-side session/request_permission flow in v0, so a host that wants approvals must wait for v1 (the code names guardian/approval wiring + AgentContext.request as the v1 hook point). Refusal happens BEFORE admission, so the session service never sees the prompt.
   - 出處：`packages/acp/src/index.ts:14`、`packages/acp/src/index.ts:54`、`packages/acp/src/index.ts:199`
3. **Session lifecycle races are handled by an explicit per-session close/generation protocol instead of a lock.**
   - 理由：closingSessions blocks new prompts and reopening; a monotonic lifecycleGeneration invalidates a suspended resume; concurrent closes share one closeFlights promise; concurrent ownership preparations share preparingOwnership. A resume that loses the race releases the ownership it just acquired (only if it did not own it before) and throws 'session close superseded resume'.
   - 出處：`packages/acp/src/index.ts:60`、`packages/acp/src/index.ts:142`、`packages/acp/src/index.ts:164`、`packages/acp/src/index.ts:82`
4. **Only text content blocks are admitted as prompt input in v0.**
   - 理由：extractPromptText concatenates type==='text' blocks and everything else (resource links, images, tool calls) is dropped; an empty result throws 'session/prompt requires at least one text content block (v0)'.
   - 出處：`packages/acp/src/index.ts:246`、`packages/acp/src/index.ts:209`

**失敗策略**：fail-closed: unknown/closing sessions throw on resume/prompt/close (index.ts:145-147, 175-177, 204-207), autoApprove:false refuses the prompt before admission (index.ts:199-203), and an aborted prompt answers stopReason 'cancelled' rather than an error the client might retry (index.ts:224-229).

**事件**：`none — the package produces no SessionEvent; session/update mirroring of session events is explicitly in the v0 drop-set (packages/acp/src/index.ts:23)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `ACP_SERVER_NAME` | "i-harness" | `packages/acp/src/index.ts:32` |
| `ACP_PROTOCOL_VERSION` | = PROTOCOL_VERSION from @agentclientprotocol/sdk (v1) | `packages/acp/src/index.ts:34` |
| `server version default` | "0.1.0" | `packages/acp/src/index.ts:53` |

**已知缺口（原始碼內標記）**

- The full v0 drop-set is declared in-code: no MCP servers on session/new, no per-session cwd (the service always runs on the CLI workspace), no session/update notification mirroring, no session/delete, no session/fork, no set_mode/set_config_option, no terminal/fs/elicitation client methods, no authentication methods (index.ts:21-25).
- No session/request_permission round-trip: ask is impossible in v0 (index.ts:18-19).
- session/list reports process.cwd() as the cwd for coordinator-adopted sessions (index.ts:135-137).

---

### `subagent`

Delegated child agents: role registry, spawn/fork into durable child sessions, an agent table + job registry with serialized followup drains, and the durable TASK protocol (task records + a notification outbox persisted through the coordinator document store). It mounts 13 model-facing tools (spawn_agent, wait_agent, list_agents, send_message, interrupt_agent, followup_task, close_agent, resume_agent, job_output, job_list, job_kill, get_task_output, stop_task).

> npm `@i-harness/subagent` · 入口 `packages/subagent/src/index.ts` · 11 個原始檔 · 28 個匯出符號

**公開介面**：`registerSubagent`、`RegisterSubagentOptions`、`RegisterSubagentResult`、`createTaskRegistry`、`taskDocKey`、`notificationMessageId`、`classifyRestoredTasks`、`isSessionCancelledChain`、`TaskIdentityConflictError`、`TaskConcurrencyLimitError`、`TaskRegistry / TaskRecord / TaskStatus / TaskOutcome / TaskDelivery / TaskIdentity / TaskNotificationRecord / TaskProtocolDocument / OutboxStatus / RecoveryReason`、`createJobRegistry / JobRegistry / JobSnapshot / JobStatus`、`createRoleRegistry / builtinRoles / SubagentRole / RoleRegistry`、`createAgentTable / AgentTable / ChildStatus / ChildAgentEntry`、`spawnChild / SpawnOptions / forkTurns`、`createSubagentTools / SubagentToolDeps / driveFollowups / ensureResidentAgent / sweepPendingInbox / FollowupDeps`、`restoreState / wireSubagentPersistence / SubagentPersistence / SubagentStateSnapshot`、`projectAgentTasks / projectAgentTaskDetail / projectStatus / projectWorkflowRows / AgentTaskView / AgentTaskStatus / AgentTaskGroup / SubagentTaskSource / TaskSourceStatus / WorkflowTaskRow`、`createNotificationDrain / ParentInputAdmission / NotificationDrainOptions`

**關鍵設計決策**

1. **The durable task protocol is the source of truth for delegated work: task status state machine accepted -> running -> {completed \| error \| cancelled \| recovery-required}, keyed by a three-part identity (parentSessionId + callEventSeq, else toolCallId, else a fresh anon key), persisted as one coordinator document `task-<stateId>`.**
   - 理由：submit() records 'accepted' immediately (identity-keyed: an exact retry ADOPTS the existing record, a mismatched retry throws TaskIdentityConflictError); claim() is the only accepted->running edge and is called in spawn_agent AFTER spawnChild returns — i.e. after the child's initial run has already started (child.ts starts agent.run before returning), so 'running' is a recorded observation, not a gate. Terminalization is CAS (a record with an outcome is never re-settled) and enqueues a parent-notification row for delivery=='parent'. The doc key uses a dash, not a colon, because a colon makes an NTFS alternate data stream that breaks rename.
   - 出處：`packages/subagent/src/task-protocol.ts:4`、`packages/subagent/src/task-protocol.ts:172`、`packages/subagent/src/task-protocol.ts:209`、`packages/subagent/src/task-protocol.ts:230`、`packages/subagent/src/tools.ts:163`、`packages/subagent/src/child.ts:137`、`packages/subagent/src/task-protocol.ts:48`
2. **Two independent quotas: a CONCURRENCY quota (maxConcurrency over non-terminal accepted+running task records, fail-closed) and a DEPTH quota (maxDepth read from the caller session header delegationDepth, default 1).**
   - 理由：Concurrency: submit() throws TaskConcurrencyLimitError when runningCount() >= maxConcurrency; default Infinity means a host must opt in. Depth: default 1 means top-level callers (depth 0) may spawn but a subagent may not nest; the code documents a carried DEPTH-BINDING LIMITATION — the tool mount is shared and binds ONE root parent session, so every caller resolves depth from the root, and a host-raised maxDepth > 1 would under-enforce; it is moot in the shipped surface because no builtin role carries spawn_agent.
   - 出處：`packages/subagent/src/task-protocol.ts:190`、`packages/subagent/src/task-protocol.ts:306`、`packages/subagent/src/tools.ts:94`、`packages/subagent/src/tools.ts:78`、`packages/subagent/src/roles.ts:31`
3. **Notification delivery is a durable outbox with an injectable admission seam; without the seam delivery is durable-only (rows stay pending).**
   - 理由：TaskNotificationRecord.status is pending\|delivered\|woken\|error\|suppressed; drain() re-checks each row's current status (idempotent, no double-admit), suppresses delivery when the parent chain was cancelled, and calls admit() with an XML-ish <task> framing (task_result / task_error). A failed admit records 'error' and the row is retried on the next drain; with no admit seam drain returns 0 and nothing is lost.
   - 出處：`packages/subagent/src/task-protocol.ts:8`、`packages/subagent/src/task-notification.ts:19`、`packages/subagent/src/task-notification.ts:45`、`packages/subagent/src/task-notification.ts:56`、`packages/subagent/src/index.ts:172`
4. **Crash recovery never re-dispatches: ambiguous in-flight attempts are classified from the durable child log into completed or recovery-required.**
   - 理由：classifyRestoredTasks loads each unfinished task's child session (after seedLength) and looks for turn/end + the last assistant/message: turn/end present -> completed with that text; missing log -> 'dispatch-unknown'; log without turn/end -> 'response-interrupted'. Everything else in restore maps running->error ('interrupted by resume') while 'waiting' is preserved so a queued followup can be re-driven; the parent session log additionally gets a replayed terminal job/status so a log-only fold agrees with the doc.
   - 出處：`packages/subagent/src/task-protocol.ts:313`、`packages/subagent/src/task-protocol.ts:349`、`packages/subagent/src/persist.ts:107`、`packages/subagent/src/persist.ts:234`

**失敗策略**：fail-closed on quota and identity (submit throws TaskConcurrencyLimitError / TaskIdentityConflictError: task-protocol.ts:190, 195) and on unknown ids (job read/kill throw 'unknown job: <id>': jobs.ts:88, 121); terminalize is CAS so a cancelled task is never re-settled (task-protocol.ts:174). Persistence is report-never-reject at the document layer (saveChain swallows, task-protocol.ts:148) — the in-memory registry stays authoritative for the run. The cold-restore inbox sweep is fail-visible (entry.status='error', 'child log unavailable after resume') rather than a silent empty stub (index.ts:257-261).

**事件**：`subagent/start (produced: packages/subagent/src/tools.ts:121)`、`subagent/end (produced: packages/subagent/src/tools.ts:155)`、`subagent/inbox (produced by send_message/followup_task: packages/subagent/src/tools.ts:261, tools.ts:290; consumed by the followup drain and the resume sweep: tools.ts:620, tools.ts:672)`、`job/status (produced per real job transition when a live parent session was handed in: packages/subagent/src/persist.ts:162, persist.ts:290)`、`turn/end + assistant/message (consumed for recovery classification: packages/subagent/src/task-protocol.ts:357)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `maxConcurrency default` | Infinity (host opt-in) | `packages/subagent/src/task-protocol.ts:118` |
| `maxDepth default` | 1 | `packages/subagent/src/tools.ts:95` |
| `background:false wait timeout` | 300_000 ms | `packages/subagent/src/tools.ts:166` |
| `wait_agent timeout clamp` | 100 .. 300_000 ms (default 30_000) | `packages/subagent/src/tools.ts:180` |
| `get_task_output batch/clamp` | 1..20 task ids; timeout clamped 100..600_000 (default 30_000) | `packages/subagent/src/tools.ts:456` |
| `cancellation-chain walk bound` | 64 hops | `packages/subagent/src/task-protocol.ts:339` |
| `doc key` | "task-<stateId>" (dash, not colon — NTFS ADS/rename hazard) | `packages/subagent/src/task-protocol.ts:54` |
| `notification message id` | "msg_task_" + sha256(taskId) first 32 hex | `packages/subagent/src/task-protocol.ts:58` |

**已知缺口（原始碼內標記）**

- DEPTH-BINDING LIMITATION (documented in code): the shared tool mount binds one root parent session, so callerDepth always resolves to the root and a host-raised maxDepth > 1 would under-enforce; a per-session mount was evaluated and rejected for M24a (tools.ts:78-93).
- Identity-less submissions get a fresh anon key each time and therefore never adopt on retry ('每次全新 → 永不 adopt'): task-protocol.ts:129.
- restoreState stays SYNC with empty stub sessions; the async mirror rebuild runs behind the `ready` promise instead (persist.ts:96-99, index.ts:244).
- In-file note that the plan's 'await save() unconditionally' was adapted so an empty cold-restore drain does not mint an empty task doc (task-notification.ts:74-78).

---

### `agent-team`

The Team scope: a lead plus named durable teammates over the SAME subagent machinery, with a shared task board, a durable mailbox, and edge-triggered activity waits. The team log IS the lead session's event log (four team/* event types), folded on every mount for crash recovery.

> npm `@i-harness/agent-team` · 入口 `packages/agent-team/src/index.ts` · 11 個原始檔 · 16 個匯出符號

**公開介面**：`mountAgentTeams`、`TeamDeps / TeamMountHandle / TeamSubagentDeps`、`AgentPath`、`LEAD_NAME`、`TEAM_CODES`、`TeamError`、`validateTeamConfig`、`foldTeam / applyTeamEvent / createFoldState / TeamFoldState`、`createTeamTransact / TeamLead / TeamTransaction`、`createRoster / RosterDeps`、`createTaskBoard / normalizeWriteScopes / TaskBoardDeps / TaskAction`、`createMailbox / MailboxDeps`、`createActivity / ActivityConfig / TeamWaitResult`、`createTeamTools / TeamToolDeps`、`types: TeamConfig, TeamMemberPhase, TeamMemberSnapshot, TeamMemberView, TeamTaskStatus, TeamTaskSnapshot, TeamTaskView, TeamMessageSnapshot, TeamEvent, TeamCaller`

**關鍵設計決策**

1. **Event sourcing on the parent session log: exactly four validated team/* events (team/member, team/task, team/message/queued, team/message/delivered) with strict zod structure validation, immutable member identity and +1 task revisions.**
   - 理由：foldTeam is a full replay (mixed non-team events are skipped); applyTeamEvent rejects unknown team/* types and version!=1, rejects member-name reuse, immutable identity-field changes and invalid phase transitions, enforces task revision==1-then-+1, and rejects delivered-without-queued / duplicate ids. The canonical teamId is recovered from the FIRST team/* event so restored member ids and queued-message keys stay addressable.
   - 出處：`packages/agent-team/src/types.ts:59`、`packages/agent-team/src/fold.ts:18`、`packages/agent-team/src/fold.ts:62`、`packages/agent-team/src/scheduler.ts:129`
2. **Every mutation goes through a serialized transaction whose callback is PURE-READ: the callback runs against a CLONE, candidates are validated in order, then applied to the live state, appended to the log and flushed.**
   - 理由：'invalid never enters state or log' holds by construction — a misbehaving callback can only corrupt the throwaway clone. Events are applied+appended BEFORE flush (at-least-once): if flush rejects the caller rejects but the log keeps the events, and recovery replays them. onCommit fires only after flush resolves, which is what wakes waiters.
   - 出處：`packages/agent-team/src/transact.ts:27`、`packages/agent-team/src/transact.ts:47`、`packages/agent-team/src/transact.ts:58`、`packages/agent-team/src/scheduler.ts:166`
3. **Delivery is durability-before-ack: a message counts delivered only after the target's session log is FLUSHED; a flush failure returns false and the message stays queued for recoverRoot.**
   - 理由：Lead target -> append subagent/inbox to the parent session + flush; teammate target -> append to the child's mirror + flush + (for wakeup) drive the shared serialized followup drain. Only then does the mailbox append team/message/delivered. recoverRoot re-attempts queued-not-delivered messages in FIFO order (skipping quiet-on-inactive), so a crash between delivery and ack replays the entry rather than losing it.
   - 出處：`packages/agent-team/src/scheduler.ts:278`、`packages/agent-team/src/scheduler.ts:286`、`packages/agent-team/src/scheduler.ts:326`、`packages/agent-team/src/mailbox.ts:67`、`packages/agent-team/src/mailbox.ts:84`
4. **Lead-only authority plus advisory write scopes, and colliding team tools REPLACE the same-named subagent tools on the shared parent registry (restored on unmount).**
   - 理由：spawn_teammate and interrupt_agent are Lead-only at the DOMAIN layer (not just the tool layer); the teammate role's tool list is derived from the created tool list minus those two. write scopes are normalized (no absolute/.. drive-letter paths) and overlap only produces warnings on the task view — they never block. send_message/followup_task/wait_agent/interrupt_agent collide with the subagent surface, so a collision replaces and unmount restores, making unmount a true reverse of mount. One team per run is enforced by a module-level reservation that throws on a second mount.
   - 出處：`packages/agent-team/src/roster.ts:75`、`packages/agent-team/src/roster.ts:168`、`packages/agent-team/src/task-board.ts:8`、`packages/agent-team/src/scheduler.ts:423`、`packages/agent-team/src/scheduler.ts:87`、`packages/agent-team/src/scheduler.ts:118`

**失敗策略**：fail-closed: config validation runs before any side effect (scheduler.ts:103-115); provisioning fails closed when the child session cannot PROVE durability (no childSessions -> false, scheduler.ts:500; spawn checkpoint timeout -> member 'failed', roster.ts:101-121); delivery returns false on flush rejection so the message stays queued (scheduler.ts:286-294, 326-334); reconciling a provisioning member without a durability probe marks it failed rather than active (roster.ts:148-150).

**事件**：`team/member (produced: packages/agent-team/src/roster.ts:87, 118, 130)`、`team/task (produced: packages/agent-team/src/task-board.ts:90)`、`team/message/queued (produced: packages/agent-team/src/mailbox.ts:62)`、`team/message/delivered (produced: packages/agent-team/src/mailbox.ts:71, mailbox.ts:95)`、`consumes/folds team/* via foldTeam (packages/agent-team/src/fold.ts:80)`、`also appends subagent/inbox to the lead session and to teammate child sessions (packages/agent-team/src/scheduler.ts:283, scheduler.ts:320)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `maxMembers` | 8 | `packages/agent-team/src/scheduler.ts:105` |
| `maxTasks` | 256 (non-deleted) | `packages/agent-team/src/scheduler.ts:106` |
| `maxPendingMessagesPerMember` | 64 | `packages/agent-team/src/scheduler.ts:107` |
| `maxMessageBytes` | 65_536 (including the 'Team message <id> from <name>:' framing) | `packages/agent-team/src/scheduler.ts:108` |
| `startupTimeoutMs (durability checkpoint)` | 10_000 | `packages/agent-team/src/scheduler.ts:109` |
| `wait window` | min 10_000, max 3_600_000, default 30_000 | `packages/agent-team/src/types.ts:28` |
| `listTasks default limit` | 50 | `packages/agent-team/src/task-board.ts:114` |
| `LEAD_NAME` | "lead" (reserved path segment; team tools live under lead/<name>) | `packages/agent-team/src/agent-path.ts:4` |

**已知缺口（原始碼內標記）**

- One team per run only — a second mountAgentTeams throws 'only one team per run is supported (M19)': scheduler.ts:87, scheduler.ts:117-119.
- Durability gate fails closed without durable child sessions: with no coordinator the roster cannot prove a child holds its prompt, so members cannot go active (scheduler.ts:48-49, scheduler.ts:500).
- Post-resume teammates carry status 'error' from the subagent restore mapping; deliver returns false (message stays queued) unless the optional ensureResident seam is injected (scheduler.ts:305-315).

---

### `workflow`

Static multi-step workflows defined as YAML files under <workspace>/workflow/*.yml; one run is executed as ONE background job (id `workflow-<n>`) in a workflow-owned job store, exposing an ExecService-like surface (runWorkflow/getOutput/listJobs/killJob) as the 'workflow/executor' service plus the model-facing workflow_run / workflow_list tools.

> npm `@i-harness/workflow` · 入口 `packages/workflow/src/index.ts` · 5 個原始檔 · 31 個匯出符號

**公開介面**：`parseWorkflowYaml`、`isValidWorkflowName`、`WORKFLOW_NAME_PATTERN`、`WorkflowParseError`、`WorkflowDefinition / WorkflowParamSpec / WorkflowStep`、`createWorkflowRegistry / WorkflowRegistry / WorkflowRegistryDeps`、`createWorkflowExecutor / WorkflowExecutor / WorkflowExecutorDeps`、`createWorkflowJobStore / WorkflowJobStore / WorkflowJobEntry`、`runWorkflow / runWorkflowIn / WorkflowRunHandle`、`createWorkflowRunTool / createWorkflowListTool / registerWorkflow`、`workflowRunName / workflowListName / workflowExecutorServiceName`、`WorkflowRunArgs / WorkflowRunOutput / WorkflowListEntry / WorkflowListOutput / WorkflowMountConfig / WorkflowMountHandle`

**關鍵設計決策**

1. **One run = ONE background job in a workflow-owned store that deliberately mirrors ExecService's job contract, including the exact `unknown job: <id>` error string.**
   - 理由：This store is the THIRD layer of subagent's job_* fallback chain: subagent routes ids prefixed `workflow-` to deps.workflow (tools.ts:371), and job_output/job_kill pattern-match /unknown job/i to decide whether to fall through. The store defaults to a process-shared singleton so every workflow job in the process is visible through any executor; tests inject an isolated store. runId === jobId in v0, with distinct fields kept for future durable run records.
   - 出處：`packages/workflow/src/runner.ts:1`、`packages/workflow/src/runner.ts:55`、`packages/workflow/src/runner.ts:95`、`packages/workflow/src/runner.ts:112`、`packages/subagent/src/tools.ts:371`
2. **Steps run strictly sequentially with no DAG/parallel/conditions/loops; any step failure marks the whole run errored.**
   - 理由：'Deliberately NOT implemented (YAGNI, ruling M24b-P4)'. on_failure: continue keeps the loop going but does NOT launder the failure — the run still ends 'error' with the first failing exit code. 'stop' skips the remaining steps (each gets a `skipped` progress line). Kill is a run-level AbortController threaded to the current step's exec signal, and status writes are guarded so a killed run stays killed. Progress lines ([step i/N name] started\|ok\|failed(exit=N)\|skipped) plus step stdout go into the job output stream.
   - 出處：`packages/workflow/src/definition.ts:8`、`packages/workflow/src/runner.ts:26`、`packages/workflow/src/runner.ts:247`、`packages/workflow/src/runner.ts:255`、`packages/workflow/src/runner.ts:193`
3. **Parameter interpolation is plain string substitution before spawn, with the same trust level as the bash tool; only DECLARED params interpolate and unknown ${...} stays verbatim.**
   - 理由：Params are model-authored command text, so no escaping is attempted; a missing required param fails loud BEFORE any job is created, while an optional unresolved slot stays visible in the command so the model can see the hole. Step commands are tokenized by getArgv (no shell interpretation).
   - 出處：`packages/workflow/src/runner.ts:31`、`packages/workflow/src/runner.ts:123`、`packages/workflow/src/runner.ts:135`、`packages/workflow/src/runner.ts:156`
4. **Definitions are static YAML parsed by the generic `yaml` package with fail-loud schema validation; the registry caches the scan and warn-skips one bad file.**
   - 理由：A definition violating the schema throws a descriptive WorkflowParseError which the registry translates into warn+skip, so one bad file never breaks the registry. Unknown top-level keys are tolerated (forward-compatible: dsh's `phases` is deferred but must not reject files carrying it). Names are dsh kebab-case; the file stem is the fallback name; only top-level *.yml files are scanned, sorted for determinism.
   - 出處：`packages/workflow/src/definition.ts:1`、`packages/workflow/src/definition.ts:164`、`packages/workflow/src/registry.ts:41`、`packages/workflow/src/registry.ts:47`、`packages/workflow/src/definition.ts:37`

**失敗策略**：fail-loud then fail-visible: a schema/YAML violation throws WorkflowParseError (definition.ts:43, 166-193); the registry catches per file and warns+skips (registry.ts:47-49); a run never reports partial success — any failing step sets status 'error' with the first failing exit code (runner.ts:255); exec.run rejections are translated into an ordinary step failure with exitCode -1 so the same discipline applies (runner.ts:219-223).

**事件**：`none — the package imports no session-event types and appends no SessionEvent; run state lives in the WorkflowJobStore and job output is pulled through job_output/listJobs (runner.ts:35-37)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `workflow_run tool timeoutMs (wait=true metadata ceiling)` | 600_000 | `packages/workflow/src/tool.ts:82` |
| `WAIT_POLL_MS` | 20 | `packages/workflow/src/tool.ts:52` |
| `WORKFLOW_NAME_PATTERN` | /^[a-z0-9]+(?:-[a-z0-9]+)*$/ | `packages/workflow/src/definition.ts:37` |
| `scan filter + sort` | *.yml only, filename-sorted, name-sorted index | `packages/workflow/src/registry.ts:41` |
| `job id shape` | `workflow-${n}` store-monotonic counter | `packages/workflow/src/runner.ts:86` |

**已知缺口（原始碼內標記）**

- DAG/parallel steps, conditions, loops and matrices are deliberately not implemented (definition.ts:8-9).
- Registry has NO file watcher in v0: reload() must be called explicitly before reads (registry.ts:4, registry.ts:67).
- dsh's `phases` meta is tolerated but deferred in v0 (definition.ts:164).
- The executor service cannot be unregistered on unmount — core-plugin's service store has no unregister seam (tool.ts:128-131).

---

### `hooks`

User-configured hook handlers (CC-compatible semantics) mounted on the core-plugin seams: handlers are spawned as subprocesses, trust-hashed, and either gate an operation (fail-closed) or observe it (report and continue).

> npm `@i-harness/hooks` · 入口 `packages/hooks/src/index.ts` · 4 個原始檔 · 12 個匯出符號

**公開介面**：`createHookRegistry`、`HookRegistry`、`HookRegistryOptions`、`LoadedHandler`、`loadHooksConfig`、`resolveHooksConfigPath`、`runHookHandler`、`validateHookOutput`、`assertAllowed`、`verifyHandlerTrust`、`trustScriptPath`、`sha256File`、`(via `export * from ./types.ts`): HOOK_EVENTS, HookEventName, HookHandlerType, HookDecision, HookOutput, HookContext, HandlerMatcher, HookHandlerSpec, HooksConfig, HookConfigError, HookTrustError, HookOutputError, HookBlockedError, DEFAULT_HOOK_TIMEOUT_MS, HOOK_OUTPUT_CAP_BYTES`

**關鍵設計決策**

1. **The event list is exactly 9 events, and each event is classified as GATE or OBSERVER; gates fail closed, observers never fatal.**
   - 理由：HOOK_EVENTS = session/start, session/end, prompt/submit, pre-tool, post-tool, permission, stop, subagent/stop, notification. Gates: pre-tool/post-tool (tools/execute cascade wrap), prompt/submit (agent/pre-step waterfall), stop (agent/stop listener), and permission (tools/pre-execute ToolDecision). Observers: session/start, session/end, subagent/stop, notification — for these a trust failure or handler error is REPORTED (default console.warn) and skipped. fire() additionally rejects non-programmatic events with HookConfigError; only session/start, session/end, subagent/stop and notification are programmatic.
   - 出處：`packages/hooks/src/types.ts:9`、`packages/hooks/src/index.ts:73`、`packages/hooks/src/index.ts:182`、`packages/hooks/src/index.ts:196`、`packages/hooks/src/index.ts:346`
2. **Handler types are command \| mcpTool \| prompt \| agent, but in v1 the type only TAGS a handler for trust/audit — every handler is executed as `command.cmd args` and matching is by event + tool matcher.**
   - 理由：Validation requires a non-blank command.cmd for every handler regardless of type. Execution spawns with NO shell, passes the HookContext as one JSON object on stdin, requires exactly one JSON HookOutput object on stdout, kills after timeoutMs (default 1000, override per handler), and caps captured stdout/stderr at 64 KiB. Output validation is strict: unknown fields throw, wrong types throw, and block:true without a reason throws — nothing is interpreted loosely.
   - 出處：`packages/hooks/src/types.ts:22`、`packages/hooks/src/index.ts:131`、`packages/hooks/src/index.ts:135`、`packages/hooks/src/runner.ts:105`、`packages/hooks/src/runner.ts:24`
3. **Per-run hash trust is a security boundary: the handler artifact's sha256 is recomputed on EVERY invocation and compared with the configured value; a mismatch denies at gates and skips at observers.**
   - 理由：trust.script is resolved against the config dir when relative and is the executed artifact; the hash check runs inside runHookHandler before spawn, not only at config load (load also records a load-time verdict so handlers() can report it). A gate with an invalid handler throws HookBlockedError before the tool body runs; the permission path returns {kind:'deny'}.
   - 出處：`packages/hooks/src/types.ts:65`、`packages/hooks/src/trust.ts:23`、`packages/hooks/src/runner.ts:77`、`packages/hooks/src/index.ts:198`、`packages/hooks/src/index.ts:225`
4. **Config loading is strict about shape but lenient about EXISTENCE, and the distinction is explicit-configPath vs default path.**
   - 理由：The document must be a JSON object with version===1 and a handlers array; every handler is validated (id non-blank, known event, known type, command.cmd non-blank, required 64-hex trust.sha256, matcher must define tool and/or toolRegex, timeoutMs positive integer) and a bad regex is a config error. If the resolved path exists it is loaded; if it does NOT exist, an EXPLICIT configPath throws HookConfigError (the caller named a config) while a default-derived path yields zero handlers (the host may not use hooks at all). Default path: <configDir\|$IH_CONFIG_DIR\|~/.i-harness>/hooks.json.
   - 出處：`packages/hooks/src/index.ts:88`、`packages/hooks/src/index.ts:105`、`packages/hooks/src/index.ts:122`、`packages/hooks/src/index.ts:273`、`packages/hooks/src/index.ts:30`

**失敗策略**：fail-closed for gates, fail-open-but-visible for observers (the code's own words at index.ts:182-188): at a gate, deny/ask, block:true, continue:false, a handler error, an exit!=0, a timeout, unparseable stdout, and a trust mismatch ALL become HookBlockedError (assertAllowed, runner.ts:151; runHandlers, index.ts:206-213); at an observer they are reported and the loop continues (index.ts:208-211). A missing EXPLICIT config file is a hard HookConfigError; a missing default file is zero handlers (index.ts:276-280).

**事件**：`none — no SessionEvent type is produced or consumed; the seam names it hooks into are core-plugin events: tools/execute (cascade), tools/pre-execute, agent/pre-step (waterfall), agent/stop (packages/hooks/src/index.ts:283, 310, 315, 329)`、`re-dispatch guard consumes isCascadeRedispatch from core-plugin so one logical tool call sees exactly one pre-tool/post-tool pair (packages/hooks/src/index.ts:290)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `DEFAULT_HOOK_TIMEOUT_MS` | 1000 | `packages/hooks/src/types.ts:133` |
| `HOOK_OUTPUT_CAP_BYTES` | 64 * 1024 (stdout and stderr each) | `packages/hooks/src/types.ts:135` |
| `HOOK_EVENTS` | 9 events (session/start, session/end, prompt/submit, pre-tool, post-tool, permission, stop, subagent/stop, notification) | `packages/hooks/src/types.ts:9` |
| `config file name / version` | hooks.json, version must be 1 | `packages/hooks/src/index.ts:27` |
| `matcher regex flags` | case-insensitive ('i') | `packages/hooks/src/index.ts:81` |

**已知缺口（原始碼內標記）**

- ask is not wired: a permission decision of 'ask' has no question seam, so it is a fail-closed DENY in v1 ('ask is not wired to a question seam on main yet') — index.ts:241, types.ts:35-36.
- Handler type (command/mcpTool/prompt/agent) is a trust/audit tag only in v1 — there is no distinct execution path per type: types.ts:22-24.
- The M51 B1 re-dispatch skip means a guard-retry re-dispatch frame does not re-run pre-tool/post-tool (by design, to keep one pair per logical call): index.ts:285-290.

---

### `plugin-registry`

The host-facing plugin lifecycle: register marketplace sources (local dir / http(s) marketplace.json / owner/repo / git URL), install/uninstall plugin packages under <root>/<id>, enable/disable with materialized read-only overlays (skills/, commands/) and re-keyed MCP config, plus a catalog and a pure runtime capability evaluator.

> npm `@i-harness/plugin-registry` · 入口 `packages/plugin-registry/src/index.ts` · 9 個原始檔 · 57 個匯出符號

**公開介面**：`PluginRegistry`、`validateCompatibility`、`installPlugin / uninstallPlugin / resolveInstallSource / resolveEntrySource / InstalledPlugin / InstallError`、`mcpServerKey / mcpServerKeyPrefix / readMcpServers / readMcpServersSync / pluginId`、`loadState / loadStateSync / saveState`、`fetchSource / parseManifest / cacheNameForSource / githubGitUrl / MarketplaceFetchError / MarketplaceManifest / MarketplaceEntry / PluginSource(+Directory/File/Git/GitSubdir/Github/Url)`、`inspectCapabilities / Capabilities / Capability`、`describeCommands / parseCommandMarkdown / CommandDescriptor / CommandConflict`、`evaluatePlugin / EvaluateResult / Observations / CapabilityStatus / CommandStatus / OverallStatus`、`materializePlugin / MaterializedPlugin`、`types: CatalogPlugin, PluginRecord, PluginSourceInfo, PluginState, RegistryOptions, RuntimeInputs, MCP_CONFIG_SHAPE, SourceConflictError, SourceNotFoundError, PluginArtifactError, PluginConflictError, PluginNotFoundError`

**關鍵設計決策**

1. **Plugin code is NEVER executed by this package — CONFIRMED from code, not README. Manifests, package.json and .mcp.json are only parsed; commands are only read as markdown; enable is a plain directory copy.**
   - 理由：capability.ts derives capabilities lexically ('A package.json is never imported/required/dynamically loaded; it is only JSON.parsed'); install.ts states 'Plugin code is never executed here: an install is a plain file copy'; materializePlugin is only rm+cp; parseCommandMarkdown only reads text; evaluatePlugin is a pure function that 'never executes plugin code'. The `executable` capability is therefore always reported 'unsupported' at runtime — a package-level fact, and a plugin whose ONLY advertised dimension is executable is overall 'failed' because its runtime surface can never become ready. The only process spawned anywhere in the package is the `git` binary for cloning a source (with GIT_TERMINAL_PROMPT=0 and timeouts), which is not plugin code.
   - 出處：`packages/plugin-registry/src/capability.ts:2`、`packages/plugin-registry/src/capability.ts:52`、`packages/plugin-registry/src/install.ts:29`、`packages/plugin-registry/src/materialize.ts:13`、`packages/plugin-registry/src/commands.ts:9`、`packages/plugin-registry/src/evaluate.ts:12`、`packages/plugin-registry/src/install.ts:293`、`packages/plugin-registry/src/marketplaces.ts:406`
2. **Entry-source containment is a security boundary checked TWICE (lexical + realpath) before any copy; the install itself is a two-phase atomic swap.**
   - 理由：resolveEntrySource rejects `../` traversal, absolute paths outside manifestDir and any in-marketplace symlink whose realpath escapes the marketplace (git preserves symlinks). installPlugin copies into a temp dir INSIDE installRoot then renames; overwrite parks the old copy to `.id.old-<uuid>`, renames the staged copy in, then drops the parked copy, so an interruption leaves old or new plainly present — never nothing. Leftover crash artifacts are cleaned on the next install, and the installed .mcp.json is rewritten with server names re-keyed as `plugin:<id>:<server>` (both parts sanitized) so the host consumes one namespaced map.
   - 出處：`packages/plugin-registry/src/install.ts:20`、`packages/plugin-registry/src/install.ts:251`、`packages/plugin-registry/src/install.ts:3`、`packages/plugin-registry/src/install.ts:189`、`packages/plugin-registry/src/install.ts:201`
3. **enable() validates BEFORE any state write, and naming conflicts (D5) are recorded rather than fatal.**
   - 理由：Order: installed? install dir present? any usable capability (skills/commands/mcp)? -> compute conflicts -> materialize -> write state. A broken enable throws PluginArtifactError and writes NOTHING (no partial enable); if a RE-install's materialization fails the plugin is atomically disabled with conflicts cleared and half-copied overlays dropped, so a mixed surface is never persisted. A command-name conflict with the host catalog or another enabled plugin does not reject: the plugin enables, the blocked commands are excluded from runtimeInputs and recorded as conflicts [{name, reason}] for the UI's partial badge; they reactivate on the next re-enable. The host never renames.
   - 出處：`packages/plugin-registry/src/index.ts:13`、`packages/plugin-registry/src/index.ts:396`、`packages/plugin-registry/src/index.ts:527`、`packages/plugin-registry/src/index.ts:344`、`packages/plugin-registry/src/index.ts:552`
4. **catalog() serves cached manifests (offline-friendly) while refreshSource() re-pulls; runtimeInputs() rebuilds synchronously from state + disk on every call; running agents are never touched.**
   - 理由：collectSource reads a local dir in place, serves a usable cached copy without hitting the network, and only re-pulls when the cache is unusable. runtimeInputs() filters enabled records, warns-and-skips a plugin whose install dir vanished, and returns { skillDirs, mcpServerConfigs, commandDescriptors } — the next agent build picks up changes; no live agent is mutated.
   - 出處：`packages/plugin-registry/src/index.ts:474`、`packages/plugin-registry/src/index.ts:452`、`packages/plugin-registry/src/index.ts:23`、`packages/plugin-registry/src/index.ts:231`

**失敗策略**：fail-closed on artifacts and validation: install/enable throw typed errors (InstallError plugin-invalid\|install-failed, PluginArtifactError, MarketplaceFetchError) and leave state untouched or atomically consistent (index.ts:17-18, 396-419, 344-362); a malformed .mcp.json is plugin-invalid (install.ts:90-99). Fail-CONTINUE but loud where a bad input must not break the whole surface: an unreadable source is warned and skipped in catalog() (index.ts:239-241), an unreadable command file is warned and skipped (commands.ts:77-80), a vanished install dir warns in runtimeInputs (index.ts:464-467).

**事件**：`none — no SessionEvent type is produced or consumed; mutations return views and the SPA refetches (no immediate events promised): packages/plugin-registry/src/index.ts:24-25, packages/web-host/src/host.ts:1942-1943`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `GIT_PLUGIN_CLONE_TIMEOUT_MS` | 60_000 | `packages/plugin-registry/src/install.ts:52` |
| `GIT_CLONE_TIMEOUT_MS (marketplace)` | 60_000 | `packages/plugin-registry/src/marketplaces.ts:33` |
| `HTTP_FETCH_TIMEOUT_MS` | 15_000 | `packages/plugin-registry/src/marketplaces.ts:30` |
| `git maxBuffer` | 10 * 1024 * 1024 | `packages/plugin-registry/src/marketplaces.ts:409` |
| `install/state layout` | <root>/state.json, <root>/cache/<source>, <root>/<mkt>__<name>, <root>/skills/<id>, <root>/commands/<id> | `packages/plugin-registry/src/index.ts:6` |
| `manifest paths probed` | .claude-plugin/marketplace.json then marketplace.json | `packages/plugin-registry/src/marketplaces.ts:121` |
| `command scan scope` | top-level *.md files only (v1) | `packages/plugin-registry/src/commands.ts:62` |

**已知缺口（原始碼內標記）**

- The `executable` capability dimension is always 'unsupported' at runtime — the host never executes plugin code (D2), and an executable-only plugin is overall 'failed': evaluate.ts:12-16, evaluate.ts:141-145.
- HTTP marketplace caching is documented as deferred/asymmetric: the cache dir is NOT removed before a re-pull and the manifest write is non-atomic (writeFile, not tmp+rename), unlike the git path which removes the dir first: marketplaces.ts:393-395, marketplaces.ts:402-403.
- Duplicate plugin ids from normalization (e.g. 'a:b' and 'a/b' both -> 'a-b') are resolved first-registered-source-wins with a console warning — 'Documented v1 behavior': index.ts:246-255.
- The command frontmatter parser is self-made and minimal (description + argument-hints only, no yaml dependency): commands.ts:1-5.

---

### `settings`

The global/layered user settings document: schema + normalization (single source for every setting), two stores (single-file SettingsStore and layered LayeredSettingsStore), a section descriptor/mutate API with per-section revisions, and a polling hot-reload watcher.

> npm `@i-harness/settings` · 入口 `packages/settings/src/index.ts` · 2 個原始檔 · 46 個匯出符號

**公開介面**：`SettingsStore / SettingsStoreOptions / SettingsStoreSurface`、`LayeredSettingsStore / LayeredStoreOptions / createLayeredStore`、`LayerSource / LayerRaw / LayeredRoots / resolveLayeredSources / mergeRawLayers`、`patchJsonDocumentKeepingComments / SettingsPatchError`、`watchSettings / resolveSettingsPath / updateSettings / normalizeSettings / normalizeInputModalities`、`SETTINGS_DEFAULTS / Settings and every section type (SettingsTui, SettingsLlm, SettingsProviderConfig, SettingsModel, SettingsTheme, SettingsSandboxMode, SettingsPluginToggles, ...)`、`SETTINGS_THEMES / SETTINGS_THEMES_LOW_COLOR / SETTINGS_STATUS_LINE_SEGMENTS / SETTINGS_DEFAULT_WORD_SEPARATORS / FONT_SIZE_MIN / FONT_SIZE_MAX`、`(via `export * from ./sections.ts`): describeSection, mutateSection, section schemas, PROVIDER_PROTOCOLS, DEFAULT_PROVIDER_PROTOCOL, SEEDED_PROTOCOLS, resolveProviderProtocol, SettingsConflictError, SettingsValidationError, SectionView, SectionOp`

**關鍵設計決策**

1. **Layer precedence is global < workspace < project (later wins), merged as RAW documents deep per key with arrays/scalars replaced, then normalized ONCE.**
   - 理由：Merging raw (not normalized) documents lets unknown keys survive as long as a higher layer does not override them; deep-merge recurses only when both sides are plain objects. Roots are either explicit `files` (low->high, label 'file') or conventional roots where 'auto' resolves to <configDir>/settings.json, <workspace>/.i-harness/settings.json, <cwd>/settings.json. A layer whose file does not exist contributes nothing. WRITES go to the MASTER = the highest-priority EXISTING source (not necessarily the highest-priority layer), so a project file that does not exist is never created by a write to the global file.
   - 出處：`packages/settings/src/index.ts:894`、`packages/settings/src/index.ts:925`、`packages/settings/src/index.ts:944`、`packages/settings/src/index.ts:1162`、`packages/settings/src/index.ts:1206`
2. **Hot reload is a dependency-free POLLING watcher on mtime+size (default 500 ms, unref'd timer), which then MERGES a change-detection gate before notifying.**
   - 理由：The first tick only snapshots, so a pre-existing state never fires; a change fires the callback with the changed path and the store reloads, but listeners and the telemetry emit happen only if the NORMALIZED view actually changed (compare against a pre-reload baseline) — the code notes this fixes the dormant store-level detection bug. The watcher can be disabled with watchIntervalMs:false and is disposed with the store. Polling is chosen over fs events/chokidar deliberately ('no new deps — no chokidar').
   - 出處：`packages/settings/src/index.ts:1250`、`packages/settings/src/index.ts:1262`、`packages/settings/src/index.ts:1269`、`packages/settings/src/index.ts:1316`、`packages/settings/src/index.ts:1338`
3. **Comments ARE preserved on write, with a documented degraded mode: full-line comments and blank lines are stripped for parsing and re-anchored positionally when they are re-serialized.**
   - 理由：patchJsonDocumentKeepingComments strips FULL-LINE comments (//, #, /* ... */, *) and blank lines, parses the remainder, deep-merges the patch, re-serializes canonically and re-emits each extra line before its anchored structural line. Three ordered strategies: exact positional re-anchoring when counts match and the raw structural lines are byte-identical to the canonical re-serialization; anchor-by-surviving-line when a leaf set/unset changed the line count; and a DEGRADED preservation (leading + trailing comment blocks kept, interior extras relocated to the end) when the document is not in canonical layout. Degradation never deletes user data, and a document the commentary parser cannot read at all is left untouched with a thrown SettingsPatchError (write is fail-closed). Inline comments inside values are explicitly NOT supported (indistinguishable — fail-closed rather than corrupt).
   - 出處：`packages/settings/src/index.ts:1016`、`packages/settings/src/index.ts:1025`、`packages/settings/src/index.ts:1036`、`packages/settings/src/index.ts:977`、`packages/settings/src/index.ts:1239`
4. **The document is atomically written JSON (tmp + rename) with a per-section `_revision` meta counter, and the section API is a validated leaf-patch protocol rather than a whole-document replace.**
   - 理由：Both stores write via tmp file + rename; `_revision` is written only once a section has been mutated. set() bumps only the sections present in the patch; mutateSection bumps only on a real change (no-op ops keep the revision) and guards expectedRevision with SettingsConflictError carrying {expected, actual}. normalizeSettings fills every absent field from defaults, so a partial/old document loads; there is deliberately NO migration chain (D5) — legacy shapes soft-upgrade at read (e.g. legacy tui.providers read as an in-memory migration).
   - 出處：`packages/settings/src/index.ts:861`、`packages/settings/src/index.ts:1244`、`packages/settings/src/index.ts:1171`、`packages/settings/src/index.ts:633`、`packages/settings/src/index.ts:255`

**失敗策略**：fail-closed on writes and explicit on reads: a document the comment-preserving patcher cannot parse is never rewritten, and the write throws SettingsPatchError (index.ts:1237-1240); section ops violating the schema throw SettingsValidationError -> HTTP 400 and a stale expectedRevision throws SettingsConflictError -> 409 (sections.ts, surfaced by web-host host.ts:222-243). READ normalization never throws — malformed values degrade to defaults (e.g. normalizeInputModalities returns undefined = text-only, index.ts:111-122). Cross-process concurrent writes are explicitly ACCEPTED as last-rename-wins (index.ts:865-869).

**事件**：`settings/changed — the store is the producer of this telemetry code: emitted with data {path} on a detected on-disk change (packages/settings/src/index.ts:1271)`、`the same change also fires the store-surface onChange(path) callback (packages/settings/src/index.ts:1270)`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `FONT_SIZE_MIN / FONT_SIZE_MAX` | 13 / 16 | `packages/settings/src/index.ts:342` |
| `watch poll interval default` | 500 ms (false disables) | `packages/settings/src/index.ts:1257` |
| `status-line command refreshMs floor` | 300 ms (default 1000 per the preferences schema) | `packages/settings/src/index.ts:620` |
| `SETTINGS_THEMES` | 6 ids: system, grok-night, grok-day, tokyo-night, rose-pine-moon, oscura-midnight | `packages/settings/src/index.ts:41` |
| `SETTINGS_THEMES_LOW_COLOR` | 3 ids: system, grok-night, grok-day | `packages/settings/src/index.ts:52` |
| `SETTINGS_STATUS_LINE_SEGMENTS` | 8 ids: cwd, branch, model, context, turn-timer, session, queue, tasks | `packages/settings/src/index.ts:189` |
| `source order map` | { global: 0, workspace: 1, project: 2 } | `packages/settings/src/index.ts:918` |
| `default sandboxMode` | "workspace-write" | `packages/settings/src/index.ts:289` |

**已知缺口（原始碼內標記）**

- Language is zh only in v0; the field is durable and forward-compatible (index.ts:73).
- Cross-process write safety is not provided: two processes writing the same file can lose a concurrent revision increment (last rename wins) — accepted in code (index.ts:865-869).
- Comment preservation degrades for a document that is not in this package's canonical layout: only leading/trailing comment blocks keep their position, interior comments move to the end (index.ts:1038-1048); inline comments are unsupported (index.ts:977-980).
- No migration chain by design (D5): old formats soft-upgrade at read or stay verbatim (index.ts:288-295, index.ts:305-311).

---

### `telemetry`

The host-side telemetry stream (separate from the session log and invisible to the agent): a fixed manifest of event codes, a multicasting Telemetry emitter with per-sink error isolation, and a stdout JSONL sink.

> npm `@i-harness/telemetry` · 入口 `packages/telemetry/src/index.ts` · 5 個原始檔 · 4 個匯出符號

**公開介面**：`createTelemetry`、`createJsonlSink`、`TELEMETRY_MANIFEST`、`TELEMETRY_EVENT_TYPES`、`(types) TelemetryEventType, TelemetryEvent, TelemetrySink, Telemetry, TelemetryEventCodeDoc`

**關鍵設計決策**

1. **The event vocabulary is a closed, manifest-level code registry — one row per code the runtime ACTUALLY emits (never a code without a producer), each row carrying a domain and cross-source refs.**
   - 理由：TELEMETRY_MANIFEST has 20 rows over the domains session\|turn\|tool\|provider\|token\|retry\|mcp\|system, and TELEMETRY_EVENT_TYPES is derived from the manifest (single source). The `refs` field maps each IH code to the five-source audit's names so vocabulary drift is answered inside the repo while the IH codes stay stable.
   - 出處：`packages/telemetry/src/manifest.ts:1`、`packages/telemetry/src/manifest.ts:16`、`packages/telemetry/src/manifest.ts:39`、`packages/telemetry/src/types.ts:3`
2. **Multicast emit with sink-error ISOLATION: a throwing (or rejecting) sink is warned about and never interrupts the other sinks.**
   - 理由：createTelemetry loops the sinks, wraps each onEvent in try/catch and additionally attaches a .catch to a returned Promise ('async sink 錯誤也隔離'). The TelemetrySink interface deliberately declares onEvent(ev): void (not void\|Promise<void>) with an in-code note that the union return would lose TS's void assignability rule while the runtime still isolates rejections — semantics equivalent.
   - 出處：`packages/telemetry/src/telemetry.ts:4`、`packages/telemetry/src/telemetry.ts:11`、`packages/telemetry/src/types.ts:36`
3. **The shipped sink is a stdout JSONL sink: one line per event as {ts, type, data}.**
   - 理由：createJsonlSink takes any WritableStream and defaults to process.stdout, so a host can pipe telemetry separately from the session log. There is no file rotation, no buffering and no in-repo consumer — the stream is the seam.
   - 出處：`packages/telemetry/src/jsonl.ts:4`、`packages/telemetry/src/jsonl.ts:7`、`packages/telemetry/src/index.ts:4`

**失敗策略**：fail-open / fail-visible: sink errors (sync throw or async rejection) are console.warn'd and isolated so one bad sink never breaks the others or the emitting code (telemetry.ts:8-14); close() is a v0 no-op, so flushing is the sink's own responsibility (types.ts:49-50).

**事件**：`session/start`、`session/end`、`session/request`、`session/queued`、`session/error`、`turn/start`、`turn/end`、`tool/start`、`tool/end`、`tool/error`、`provider/call`、`provider/error`、`token/usage`、`retry/start`、`mcp/server-status`、`skill/selector-shadow`、`settings/changed`、`compaction/attempt`、`error`、`warn`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `manifest size` | 20 event codes across 8 domains | `packages/telemetry/src/manifest.ts:16` |
| `domains` | session \| turn \| tool \| provider \| token \| retry \| mcp \| system | `packages/telemetry/src/manifest.ts:11` |
| `event shape` | { type, ts: Date.now(), data: Record<string, unknown> } | `packages/telemetry/src/types.ts:28` |
| `sink line shape` | { ts, type, data } + '\n' | `packages/telemetry/src/jsonl.ts:7` |

**已知缺口（原始碼內標記）**

- close() is a no-op in v0 ('需要 flush/close 的 sink 自行處理'): the emitter cannot flush or end sinks: types.ts:49-50.
- No in-process consumer of the emitted stream exists in this package (the manifest and the sink are the whole surface); the web host's GET /api/telemetry route is deferred (packages/web-host/src/host.ts:2429).

---

### `jobs`

A pure projection package for the web jobs surface: it folds `job/status` session events (realtime, last-wins by jobId) and maps the subagent durable persistence snapshot document into the same JobView shape, plus the kill-outcome vocabulary and the per-session command-queue view type.

> npm `@i-harness/jobs` · 入口 `packages/jobs/src/index.ts` · 1 個原始檔 · 8 個匯出符號

**公開介面**：`JobStatusView`、`JobView`、`JobsView`、`JobKillOutcome`、`JobKillUnknownJobError`、`CommandQueueView`、`projectJobsDoc`、`foldJobs`

**關鍵設計決策**

1. **Two independent data sources produce ONE shape: the durable doc is the initial snapshot (GET /api/sessions/:id/jobs) and the `job/status` event fold is the realtime update over the existing mux session stream — no new endpoint.**
   - 理由：The header states the web's jobs surface is BOTH a projection of job/status events (fold, last-wins by jobId, whole-job snapshot per event like goal/change) and a mapping of the subagent snapshot doc. foldJobs ignores other event types; projectJobsDoc preserves registry insertion order (the frontend sorts).
   - 出處：`packages/jobs/src/index.ts:1`、`packages/jobs/src/index.ts:121`、`packages/jobs/src/index.ts:96`、`packages/web-host/src/host.ts:1765`
2. **The durable doc shape is INLINED STRUCTURALLY on purpose so web-host never depends on @i-harness/subagent.**
   - 理由：Depending on subagent would drag the whole subagent runtime into the web host's graph; core-session inlines team/* the same way. The producer (subagent persist.ts) owns the shape, and if it drifts the route's mapping warns loudly rather than silently mis-serving. A foreign/corrupt doc maps to [] (honest empty) and the ROUTE warns.
   - 出處：`packages/jobs/src/index.ts:11`、`packages/jobs/src/index.ts:72`、`packages/jobs/src/index.ts:88`、`packages/web-host/src/host.ts:1785`
3. **The kill vocabulary is the live registry's, and an unknown job is an honest 409 rather than a silent 200.**
   - 理由：JobKillOutcome = 'cancellation-requested' \| 'already-finished' — the SAME strings the model-facing job_kill tool reports and the subagent JobRegistry returns, so the popover's button promises exactly what the registry does. JobKillUnknownJobError is the explicit 'nothing to kill' answer the host maps to 409. CommandQueueView reports only the real busy state (running + registered-not-started turns) of the per-session command serialization chain — no prompt storage, no reorder.
   - 出處：`packages/jobs/src/index.ts:37`、`packages/jobs/src/index.ts:49`、`packages/jobs/src/index.ts:58`、`packages/web-host/src/host.ts:1804`

**失敗策略**：other — honest-degradation rather than fail-open/closed: a missing/foreign/corrupt persistence doc maps to an empty list (projectJobsDoc returns [] for anything without a jobs array, index.ts:96-99) with a loud console.warn at the route (host.ts:1785-1788); an unknown kill target raises JobKillUnknownJobError so the transport can answer 409 instead of pretending success (index.ts:49-56, host.ts:1804).

**事件**：`consumes: job/status (SessionEvent; whole-job snapshot per event) — packages/jobs/src/index.ts:121-125`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `JobStatusView` | "running" \| "completed" \| "killed" \| "error" | `packages/jobs/src/index.ts:18` |
| `JobKillOutcome` | "cancellation-requested" \| "already-finished" | `packages/jobs/src/index.ts:42` |
| `fallback status for a doc row without status` | "error" | `packages/jobs/src/index.ts:102` |
| `outputAvailable semantics` | non-empty output string, NOT the output bytes (job_output remains the read path) | `packages/jobs/src/index.ts:26` |

**已知缺口（原始碼內標記）**

- No gap markers in src. The package is projection-only by design: it owns no store and can only report what the doc or the log offers ('exactly what the durable record offers — no invented fields', index.ts:20).

---

### `schedule`

Durable per-session reminders whose state IS the session event stream: `schedule/change` v1 events with create/delete/dispatch operations folded last-wins per id, three rule kinds (after / at / every), plus a local driver that dispatches due occurrences and hands the reminder to an injectable deliverer.

> npm `@i-harness/schedule` · 入口 `packages/schedule/src/index.ts` · 2 個原始檔 · 23 個匯出符號

**公開介面**：`createAfterScheduleRecord / createAtScheduleRecord / createEveryScheduleRecord`、`decodeScheduleEvent / foldScheduleEvents / resolveEveryOccurrence / allocateScheduleId / scheduleView / renderReminderFraming`、`AfterScheduleRecord / AtScheduleRecord / EveryScheduleRecord / ScheduleRecord / ScheduleChange / ScheduleState / ScheduleView / ScheduleDeliveryMode / FoldedSchedules / EveryOccurrence`、`MIN_EVERY_INTERVAL_SECONDS / SCHEDULE_CHANGE_VERSION`、`ScheduleLogError / ScheduleInputError`、`(subpath ./driver, NOT in index.ts): createScheduleDriver, ScheduleDriver, ScheduleDriverOptions, ScheduleDue, ScheduleTickResult`

**關鍵設計決策**

1. **The durable state IS the event stream: three operations (create/delete/dispatch) folded last-wins per id, with a dispatch event acting as the durable ACCEPTANCE record.**
   - 理由：One-shot records are REMOVED by their dispatch; `every` records advance via a generation-anchored occurrence (acceptedAt) without enumerating a backlog. Id reuse, deleting an inactive id and dispatching an inactive id are log corruptions that throw ScheduleLogError — the fold is projection-grade and callers must catch. Decoding is strictly key-exact (requireKeys), requires canonical four-digit-year RFC 3339 UTC instants, and rejects unknown kinds/versions.
   - 出處：`packages/schedule/src/index.ts:1`、`packages/schedule/src/index.ts:58`、`packages/schedule/src/index.ts:316`、`packages/schedule/src/index.ts:117`、`packages/schedule/src/index.ts:185`
2. **The driver appends the dispatch event BEFORE delivering (durable accept first), and a corrupt session stream is skipped with a reported deliveryError.**
   - 理由：'a delivery without a durable accept is a duplicate risk — fail-closed path': if append fails the occurrence is not delivered and the error is recorded and logged. Restart re-drive is therefore free — a new driver over the same persisted events delivers exactly the still-overdue remainder. Per-session fold corruption skips that session and records it rather than aborting the tick.
   - 出處：`packages/schedule/src/driver.ts:11`、`packages/schedule/src/driver.ts:100`、`packages/schedule/src/driver.ts:85`、`packages/schedule/src/driver.ts:35`
3. **Reminder text is framed injection-resistant: dynamic fields are JSON-escaped and the model is told the prompt is untrusted reminder content, not new instructions.**
   - 理由：renderReminderFraming emits a [SCHEDULE REMINDER] block with schedule_id_json, occurrence_at and reminder_prompt_json (JSON.stringify of the id/prompt) plus the explicit instruction to present it as untrusted content — dsh's renderReminderFraming parity.
   - 出處：`packages/schedule/src/index.ts:411`、`packages/schedule/src/index.ts:416`、`packages/schedule/src/index.ts:421`
4. **Creation validation is strict and returns machine-coded ScheduleInputError: prompt non-empty after trim, target strictly in the future, four-digit-year instants only, and `every` at or above a fixed frequency floor.**
   - 理由：Codes: invalid_prompt, invalid_rule, not_future, time_out_of_range, frequency_too_high. `at` accepts a UTC-Z or numeric-offset RFC 3339 instant with 1-3 fractional digits and validates that the calendar date is real (a round-trip getUTCFullYear/Month/Date check). The floor exists so a model cannot create a hot reminder loop.
   - 出處：`packages/schedule/src/index.ts:20`、`packages/schedule/src/index.ts:97`、`packages/schedule/src/index.ts:208`、`packages/schedule/src/index.ts:231`、`packages/schedule/src/index.ts:289`

**失敗策略**：other — fail-closed on delivery, fail-visible on corruption: a delivery is attempted ONLY after the durable dispatch append succeeds; if append or onDue fails the item lands in deliveryErrors and is logged, never silently dropped (driver.ts:98-117). A session whose schedule log is corrupt is skipped for the whole tick with a warning (driver.ts:85-92). Model input violations throw typed ScheduleInputError before any record exists (index.ts:208-299); log corruption throws ScheduleLogError from decode/fold (index.ts:88-94, 321-324).

**事件**：`schedule/change (version 1) — produced by the driver with operation 'dispatch' (one-shot: no acceptedAt; every: acceptedAt ISO instant): packages/schedule/src/driver.ts:64-68`、`schedule/change (version 1) create/delete/dispatch — consumed and strictly decoded by decodeScheduleEvent/foldScheduleEvents: packages/schedule/src/index.ts:185, index.ts:321`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `MIN_EVERY_INTERVAL_SECONDS` | 300 | `packages/schedule/src/index.ts:20` |
| `SCHEDULE_CHANGE_VERSION` | 1 | `packages/schedule/src/index.ts:22` |
| `year window` | 0001-01-01T00:00:00.000Z .. 9999-12-31T23:59:59.999Z | `packages/schedule/src/index.ts:24` |
| `driver pollMs default` | 30_000 | `packages/schedule/src/driver.ts:73` |
| `id shape` | `schedule-<n>` — lowest free slot, ids never reused | `packages/schedule/src/index.ts:363` |
| `deliveryMode` | "session-local" (the only value) | `packages/schedule/src/index.ts:64` |

**已知缺口（原始碼內標記）**

- v1 deferrals are declared in the module header: LocalAtInput (IANA local-calendar targets) and the direct prompt-injection deliverable are NOT ported — the driver stays UTC-instant-based and prompt delivery is an injected seam (index.ts:12-14).
- The delivery wire itself is unfinished: 'onDue: Deliver a due reminder (the A1-inbox wire lands here later)' — this milestone ships only the seam (driver.ts:46-47).
- No in-repo assembly mounts a schedule source: subagent's projection notes the 'schedule' group has no source in this repo's assemblies today (packages/subagent/src/projection.ts:15-17).

---

### `feedback`

Per-message user feedback (like/dislike + optional note) for a session, persisted as ONE coordinator document per session keyed `feedback-<sessionId>` — the only consumer is the SPA over the web host's HTTP routes.

> npm `@i-harness/feedback` · 入口 `packages/feedback/src/index.ts` · 1 個原始檔 · 14 個匯出符號

**公開介面**：`createMessageFeedbackStore`、`MessageFeedbackStore`、`MessageFeedbackItem`、`MessageFeedbackPutRequest`、`MessageFeedbackSnapshot`、`MessageFeedbackRating`、`FEEDBACK_DOC_KEY_PREFIX`、`MAX_FEEDBACK_NOTE_BYTES`、`FeedbackBadRequestError`、`FeedbackNoteEmptyError`、`FeedbackNoteTooLargeError`、`FeedbackMessageNotFoundError`、`FeedbackVersionConflictError`、`FeedbackPersistenceError`

**關鍵設計決策**

1. **Per-item optimistic concurrency: an integer `version` starting at 1 and incremented per successful put; a put WITHOUT ifVersion overwrites unconditionally (force) while a mismatched ifVersion is a version-conflict carrying `current`.**
   - 理由：The unconditional path is called out in-code as 'the one deliberate extension vs DSH, which always requires the exact version'. An identical-value put is a no-op (the stored item returns unchanged, version does not bump — DSH parity). Delete of an absent item succeeds regardless of version ({absent:true}); an existing item requires the exact version when one is supplied.
   - 出處：`packages/feedback/src/index.ts:21`、`packages/feedback/src/index.ts:285`、`packages/feedback/src/index.ts:293`、`packages/feedback/src/index.ts:319`
2. **The target message identity is the event SEQ of a FINALIZED assistant/message event, verified against the durable log after a flush.**
   - 理由：messageId must be a non-negative integer decimal string; the store flushes the session (the live instance may hold an event the ≤200 ms write-behind has not written yet) and then checks that the log has an assistant/message at that seq — anything else is FeedbackMessageNotFoundError (HTTP 400).
   - 出處：`packages/feedback/src/index.ts:18`、`packages/feedback/src/index.ts:201`、`packages/feedback/src/index.ts:246`、`packages/feedback/src/index.ts:274`
3. **Writes VERIFY AFTER WRITE because the coordinator's putDocument contract is report-never-reject.**
   - 理由：The document is re-read inside the same serialized op and deep-compared with the intended snapshot; a mismatch throws FeedbackPersistenceError so the host answers 500 instead of a silent 200 whose vote vanishes on refresh. This is recorded as a fix for a reviewer finding.
   - 出處：`packages/feedback/src/index.ts:38`、`packages/feedback/src/index.ts:231`、`packages/feedback/src/index.ts:238`、`packages/feedback/src/index.ts:147`
4. **All read-modify-write cycles on the per-session document are serialized on one promise chain, reads included.**
   - 理由：Two feedback PUTs must never interleave and lose one's write; joining reads to the chain means a list during a mutation observes either the pre- or post-state, never a torn one. The chain tail stays alive after failures (chain = run.then(noop, noop)).
   - 出處：`packages/feedback/src/index.ts:34`、`packages/feedback/src/index.ts:214`、`packages/feedback/src/index.ts:217`

**失敗策略**：fail-closed on durability and input: an unverifiable write throws FeedbackPersistenceError (host 500) instead of acknowledging (index.ts:238-244); input violations throw typed, machine-coded errors that the host maps to HTTP without string matching — feedback-invalid/note-blank/note-too-large/message-not-found -> 400, version-conflict -> 409, unknown session -> 404 (index.ts:45-48, web-host host.ts:1854-1875). Cheap-field validation runs BEFORE any session load so a malformed request answers 400 even for an unknown session (index.ts:267-272).

**事件**：`none produced — the store appends no SessionEvent (state lives in the coordinator document `feedback-<sessionId>`)`、`consumes (read-only) the session log's assistant/message events to authorize a messageId: packages/feedback/src/index.ts:202-205`

**關鍵常數**

| 名稱 | 值 | 出處 |
|---|---|---|
| `MAX_FEEDBACK_NOTE_BYTES` | 4096 (UTF-8 bytes) | `packages/feedback/src/index.ts:62` |
| `FEEDBACK_DOC_KEY_PREFIX` | "feedback-" | `packages/feedback/src/index.ts:56` |
| `snapshot formatVersion` | 1 | `packages/feedback/src/index.ts:93` |
| `version start/increment` | 1 at first put, +1 per succeeding put | `packages/feedback/src/index.ts:73` |
| `rating vocabulary` | "like" \| "dislike" | `packages/feedback/src/index.ts:64` |

**已知缺口（原始碼內標記）**

- Documented simplification vs DSH: the persisted item has no createdAt — only updatedAt ('simplified: no createdAt — the task ruling's shape'): index.ts:31-32.
- Documented deliberate divergence: a put without ifVersion overwrites unconditionally (DSH always requires the exact version): index.ts:22-25.
- There is no embedder seam: the store is composed inside web-host over the coordinator and the only consumer is the SPA over HTTP (index.ts:8-10).

---

## 命令面（50 個 slash 命令的端到端後端路徑）

Registry model: packages/tui/src/app/slash/registry.ts builds ONE builtin table by spreading 13 per-owner impl arrays (registry.ts:31-63); CommandRegistry indexes byName + byAlias and throws on duplicate names (registry.ts:74-82). Visibility is a HARD gate: visible(ctx)===false means the command is neither listed by completionEntries() nor matched by matches() (registry.ts:101-110), and the loop renders 'Unsupported command: /<name>' for any unmatched slash line before it can become a user prompt (loop.ts:2097-2113). The gate vocabulary is the typed SlashCapability union in types.ts:21-32 (session-create \| session-list \| dashboard \| provider-settings \| rewind \| compact \| fork \| context \| plan-mode \| guardian \| vim-mode); the loop derives ctx.capabilities from REAL backend/host members in Loop.slashCapabilities() (loop.ts:2419-2431), which pushes only session-list, session-create, dashboard, rewind, compact, fork, context and provider-settings. plan-mode, guardian and vim-mode are NEVER pushed, so /plan, /view-plan, /auto, /always-approve and /vim-mode are unreachable in the shipped TUI by construction. Two commands bypass the registry table: /settings, /provider and /model are intercepted earlier in the submit path by tryG1SlashModal (loop.ts:2091-2094, 3173-3195), and the registry entries for them are the inventory + forwarding surface (g1.ts:1-10). Commands whose SlashContext member is optional (types.ts:149-199) guard on presence and toast rather than no-op; /rename does NOT guard on BackendClient.rename because that member is unconditional on the embedded client (embedded.ts:814). backendStatus taxonomy used here: implemented = the behaviour exists and is reached on the shipped TUI host path; optional-seam = the behaviour exists but the member it drives is an optional BackendClient/SlashContext member that an assembly may omit, in which case the command resolves to a toast (or a silent no-op where noted); stub-toast = the run body is only a toast or a hard gate that is never satisfied by slashCapabilities(), so no backend behaviour is wired; unsupported = no behaviour at all. Every evidence line below was opened; verified=true means the cited lines were read in this audit.

**後端狀態分佈**：stub-toast 5 · implemented 31 · optional-seam 14

| 命令 | 家族 | 閘 | 後端模組 | 狀態 | 機制 |
|---|---|---|---|---|---|
| `/always-approve` | safety | capability:guardian (SlashCapability, types.ts:31) — never s | `packages/tui/src/app/slash/impl/approval.ts + Loop.setAlwaysApproveStance (packages/tui/src/app/loop.ts:3159); host seam TuiAppOptions.setAlwaysApprove (packages/tui/src/app/loop.ts:208)` | stub-toast | Registered in approval.ts:23-31 with visible() = hasCapability(ctx,'guardian') (approval.ts:27); the gate is a hard gate in CommandRegistry.matches (registry.ts:107). run() calls applyStance(ctx,true) (approval.ts:14-21), which guards on the optional SlashCont |
| `/auto` | safety | capability:guardian (types.ts:31) — never supplied by Loop.s | `packages/tui/src/app/slash/impl/approval.ts + Loop.setAlwaysApproveStance (packages/tui/src/app/loop.ts:3159)` | stub-toast | Registered in approval.ts:32-39 gated on the same 'guardian' capability (approval.ts:35) and routed through the identical applyStance helper as /always-approve (approval.ts:36-38 -> approval.ts:14-21). Note that both commands pass on=true: /auto never turns th |
| `/btw` | collab | always | `packages/tui/src/app/slash/impl/run.ts + Loop.toggleBtwWith/toggleBtwInput (packages/tui/src/app/loop.ts:2803) over BackendClient.steer (packages/tui/src/contracts.ts:204)` | implemented | Registered ungated in run.ts:84-96. With an argument the run calls ctx.toggleBtwWith(question) (run.ts:91), wired in the loop to toggleBtwWith (loop.ts:2461): it writes app.paneData.btw {question,state:'asking'} and calls backend.steer(question) (loop.ts:2803- |
| `/compact` | context | capability:compact (types.ts:27), derived in loop.ts:2426 fr | `packages/tui/src/backend/embedded.ts:822 (createEmbeddedBackend.compact -> SessionAssembly.compactNow, @i-harness/session-executor)` | optional-seam | Registered in run.ts:25-42, visible() = hasCapability(ctx,'compact') (run.ts:29). run() first guards on the OPTIONAL BackendClient.compact member and toasts 'compact: backend seam absent (session-compact not wired)' when it is missing (run.ts:31-34) — the opti |
| `/compact-mode` | interface | always | `packages/tui/src/app/slash/impl/visual.ts + Loop SlashContext.setCompactMode (packages/tui/src/app/loop.ts:2489); state field TuiAppState.compactMode (packages/tui/src/app/present.ts)` | implemented | Registered ungated in visual.ts:77-84. run() negates app.compactMode and calls ctx.setCompactMode(next) (visual.ts:81), wired in the loop to set app.compactMode directly (loop.ts:2489-2491). The toast text is computed AFTER the state write, so it reads the new |
| `/config-agents` | extension | always | `@i-harness/subagent builtinRoles (packages/subagent), rendered by packages/tui/src/views/light-config-agents.ts` | implemented | Registered ungated in eco.ts:112-123. run() calls builtinRoles() from @i-harness/subagent (eco.ts:120, imported at eco.ts:20), maps them through configAgentRows and opens the 'config-agents' light panel (eco.ts:121), falling back to the CONFIG_AGENTS_EMPTY row |
| `/context` | context | capability:context (types.ts:29), derived in loop.ts:2428 fr | `Loop.openContextPanel (packages/tui/src/app/loop.ts:2575) over BackendClient.context (packages/tui/src/contracts.ts:246, implemented at packages/tui/src/backend/embedded.ts:785)` | optional-seam | Registered in sessions.ts:73-86, visible() = hasCapability(ctx,'context') (sessions.ts:78). run() guards on the optional SlashContext.openContext member and toasts 'context: backend context seam absent' otherwise (sessions.ts:80-83); the loop wires openContext |
| `/copy` | inspect | always | `Loop.copySelectedBlock (packages/tui/src/app/loop.ts:2595) over ScrollbackEngine.selection/viewport (packages/tui/src/contracts.ts:335) and the clipboard adapter (defaultClipboard, loop.ts:504)` | implemented | Registered ungated in tools.ts:37-43; run() calls ctx.copy() (tools.ts:41), wired in the loop to copySelectedBlock (loop.ts:2497). That reads engine.selection(), slices the display lines for the selection range out of engine.viewport(0,total), joins the run te |
| `/dashboard` | inspect | capability:dashboard (types.ts:24), derived in loop.ts:2424  | `packages/tui/src/backend/embedded.ts:743 (createEmbeddedBackend.dashboard) rendered by Loop.openDashboard (packages/tui/src/app/loop.ts:4196)` | optional-seam | Registered in sessions.ts:42-55, visible() = hasCapability(ctx,'dashboard') (sessions.ts:47). run() guards on the optional ctx.dashboard member and toasts 'dashboard: backend projection absent' otherwise (sessions.ts:49-52); the loop wires dashboard to openDas |
| `/doctor` | inspect | always | `Loop SlashContext.probeReport (packages/tui/src/app/loop.ts:2505) over the tui-core capability probe, rendered by packages/tui/src/views/light-doctor.ts` | implemented | Registered ungated in tools.ts:20-36. run() opens the doctor panel in the Probing… state first (tools.ts:32) so that frame paints, then awaits the OPTIONAL ctx.probeReport member (tools.ts:33) and re-opens the panel with the rows. If probeReport is absent the  |
| `/edit-prompt` | interface | always | `Loop.editPromptInEditor (packages/tui/src/app/loop.ts:3068)` | implemented | Registered ungated in navigation.ts:60-69; run() calls ctx.editPromptInEditor() (navigation.ts:67), wired to Loop.editPromptInEditor (loop.ts:2498, implemented at loop.ts:3068) — the same $EDITOR round-trip seam the minimal-mode Ctrl+G binding uses. Local proc |
| `/effort` | model | capability:provider-settings (types.ts:25), derived in loop. | `Loop.effort (packages/tui/src/app/loop.ts:3026) over the ProviderController settings surface and, with a live session, BackendClient.setSessionModel (packages/tui/src/contracts.ts:202, wired at packages/tui/src/backend/embedded.ts:574)` | optional-seam | Registered in g1.ts:45-66, visible() = hasCapability(ctx,'provider-settings') (g1.ts:49). A bare /effort calls ctx.effort?.('') to report the current level (g1.ts:56-59); an unknown level is rejected with the vocabulary toast 'effort: unknown level … (off \| l |
| `/export` | inspect | always | `Loop.exportTranscript (packages/tui/src/app/loop.ts:3096) over ScrollbackEngine.viewport (packages/tui/src/contracts.ts:330) + node:fs` | implemented | Registered ungated in tools.ts:44-51. run() awaits ctx.exportTranscript() and toasts 'exported: <path>' or 'export failed' depending on whether a path came back (tools.ts:48-49), wired to Loop.exportTranscript (loop.ts:2499, implemented at loop.ts:3096). That  |
| `/find` | inspect | always | `Loop.activateSearch (packages/tui/src/app/loop.ts:2698) over ScrollbackEngine search (packages/tui/src/contracts.ts:342)` | implemented | Registered ungated in navigation.ts:15-23; run() reads ctx.arg and calls ctx.startSearch(pattern) with undefined for an empty argument (navigation.ts:20-21), wired in the loop to activateSearch (loop.ts:2459). activateSearch owns the search mode over the Scrol |
| `/fork` | session | capability:fork (types.ts:28), derived in loop.ts:2427 from  | `packages/tui/src/backend/embedded.ts:559 (member) and :1012 (defaultEmbeddedFactory's forkSessionForBackend -> @i-harness/session-persistence forkSession)` | optional-seam | Registered in sessions.ts:56-72, visible() = hasCapability(ctx,'fork') (sessions.ts:63). run() guards on the optional ctx.fork member ('fork: backend fork seam absent') and otherwise passes an optional title (sessions.ts:65-70); the loop wires fork to forkSess |
| `/fullscreen` | interface | always | `Loop.relaunchSlash (packages/tui/src/app/loop.ts:3012) -> TuiAppOptions.modeSwitch host relay (@i-harness/tui-app, apps/tui/src/index.ts)` | optional-seam | Registered ungated in visual.ts:92-98; run() calls ctx.relaunch() and quits this process when the host reports it spawned (visual.ts:96). ctx.relaunch is wired to Loop.relaunchSlash(input) (loop.ts:2495, implemented at loop.ts:3012-3017), which forwards the ra |
| `/goal` | plan | always | `packages/tui/src/app/slash/impl/surfaces.ts:41 over TuiAppState.status.goal (packages/tui/src/app/present.ts), rendered by packages/tui/src/views/light-goal.ts` | implemented | Registered ungated in surfaces.ts:37-43; run() opens the 'goal' light panel with rows built by goalRows(ctx.app.status.goal) (surfaces.ts:41). The value is not probed from the backend at run time — it is the goal label the loop already projects into app.status |
| `/help` | interface | always | `Loop SlashContext.visibleCommands/keyBindings (packages/tui/src/app/loop.ts:2529) over CommandRegistry.visible (packages/tui/src/app/slash/registry.ts:91)` | implemented | Registered ungated in tools.ts:60-76. run() reads ctx.visibleCommands?.() and ctx.keyBindings?.() (tools.ts:66-67) and builds a two-section cheatsheet panel (Commands / Keys) opened as kind 'cheatsheet' (tools.ts:68-74). Both seams are wired in the loop: visib |
| `/history` | interface | always | `Loop.openHistoryPicker (packages/tui/src/app/loop.ts:2631) over TuiAppState.history` | implemented | Registered ungated in navigation.ts:53-59; run() calls ctx.openHistoryPanel() (navigation.ts:57), wired in the loop to openHistoryPicker (loop.ts:2457, implemented at loop.ts:2631). The picker is driven from app.history (the same list the loop appends every ac |
| `/home` | interface | always | `Loop SlashContext.setScreen (packages/tui/src/app/loop.ts:2463) over TuiAppState.screen (packages/tui/src/app/present.ts)` | implemented | Registered ungated in sessions.ts:27-33; run() calls ctx.setScreen('welcome') (sessions.ts:31), wired in the loop (loop.ts:2463-2478) to activateWelcome(), rebuild the welcome menus/modelState and request a frame. The 'agent' branch of the same seam only re-ac |
| `/hooks` | extension | always | `@i-harness/hooks loadHooksConfig/HOOK_EVENTS (packages/hooks), rendered by packages/tui/src/views/light-hooks.ts` | implemented | Registered ungated in eco.ts:72-85. run() resolves the hooks config path with resolveHooksConfigPath(), loads it with loadHooksConfig(path, dirname(path)) from @i-harness/hooks (eco.ts:77-78, imports at eco.ts:17) and opens the 'hooks' panel with hooksRows(han |
| `/jump` | inspect | always | `packages/tui/src/app/slash/impl/navigation.ts over Loop.jumpAnchors/gotoLine (packages/tui/src/app/loop.ts:2448) and the ScrollbackEngine turn anchors` | implemented | Registered ungated in navigation.ts:24-52. With a numeric argument it validates /^\d+$/ (toasting 'jump: expected a turn number (1..N) or no arg' otherwise, navigation.ts:32-35), indexes ctx.jumpAnchors() and calls ctx.gotoLine(anchor.line), toasting 'jump: tu |
| `/marketplace` | extension | always | `@i-harness/plugin-registry PluginRegistry.catalog (packages/plugin-registry), rendered by packages/tui/src/views/light-plugins.ts` | implemented | Registered ungated in eco.ts:99-110. run() constructs PluginRegistry({root: <workspace>/.i-harness/plugins}), awaits registry.catalog() and opens the 'marketplace' panel with marketplaceRows(plugins) (eco.ts:104-106); a scan failure opens the panel with a 'mar |
| `/mcps` | extension | always | `@i-harness/plugin-registry PluginRegistry.runtimeInputs (packages/plugin-registry), rendered by packages/tui/src/views/light-mcps.ts` | implemented | Registered ungated in eco.ts:54-71. run() builds the workspace PluginRegistry and reads registry.runtimeInputs().mcpServerConfigs (eco.ts:59-60), deriving each server's transport from url (streamable-http) or command (stdio), else 'unknown' (eco.ts:62-65), the |
| `/minimal` | interface | always | `Loop.relaunchSlash (packages/tui/src/app/loop.ts:3012) -> TuiAppOptions.modeSwitch host relay (@i-harness/tui-app, apps/tui/src/index.ts)` | optional-seam | Registered ungated in visual.ts:85-91; run() calls ctx.relaunch() and quits the process only when the host reports the spawn happened (visual.ts:89). Same seam as /fullscreen: Loop.relaunchSlash forwards the raw line to the host modeSwitch relay and toasts whe |
| `/model` | model | capability:provider-settings (types.ts:25), derived in loop. | `Loop.openModelPicker (packages/tui/src/app/loop.ts:3463) via tryG1SlashModal (packages/tui/src/app/loop.ts:3184); forwarded by packages/tui/src/app/slash/impl/g1.ts:34` | optional-seam | Registered in g1.ts:28-36, visible() = hasCapability(ctx,'provider-settings') (g1.ts:32). The run body is a single forwarding call ctx.model?.(ctx.arg.trim()) (g1.ts:34) — the registry entry is the inventory/unit-test surface; the LIVE path is the earlier text |
| `/multiline` | interface | always | `packages/tui/src/app/slash/impl/visual.ts + Loop SlashContext.setMultiline (packages/tui/src/app/loop.ts:2485)` | implemented | Registered ungated in visual.ts:69-76; run() negates app.prompt.multiLine and calls ctx.setMultiline(next) (visual.ts:73), wired in the loop to write app.prompt.multiLine and refresh the shortcuts bar (loop.ts:2485-2488). The toast is computed after the write  |
| `/new` | session | capability:session-create (types.ts:22), derived in loop.ts: | `packages/tui/src/backend/embedded.ts:549 (member) and :1006 (defaultEmbeddedFactory's createSessionForBackend -> @i-harness/session-persistence coordinator.create)` | optional-seam | Registered in sessions.ts:15-26, visible() = hasCapability(ctx,'session-create') (sessions.ts:18). run() guards on the optional ctx.createSession member, toasting 'new session: backend create seam absent' otherwise (sessions.ts:20-23); the loop wires createSes |
| `/plan` | plan | capability:plan-mode (types.ts:30) — never supplied by Loop. | `packages/tui/src/app/slash/impl/run.ts:51 (toast only; no backend call)` | stub-toast | Registered in run.ts:43-53 with visible() = hasCapability(ctx,'plan-mode') (run.ts:49). The run body is a single toast, 'plan: live backend switching capability not wired' (run.ts:51) — the M46a UI-state-only implementation was deliberately removed. Loop.slash |
| `/plugins` | extension | always | `@i-harness/plugin-registry PluginRegistry.catalog (packages/plugin-registry), rendered by packages/tui/src/views/light-plugins.ts` | implemented | Registered ungated in eco.ts:86-98. run() constructs PluginRegistry({root: <workspace>/.i-harness/plugins}) and awaits registry.catalog(), then opens the 'plugins' panel with pluginRows(plugins) (eco.ts:91-93); a failure opens an honest 'plugin catalog failed: |
| `/provider` | model | capability:provider-settings (types.ts:25), derived in loop. | `Loop.openProvider (packages/tui/src/app/loop.ts:3202) via tryG1SlashModal (packages/tui/src/app/loop.ts:3189); forwarded by packages/tui/src/app/slash/impl/g1.ts:25` | optional-seam | Registered in g1.ts:19-27, visible() = hasCapability(ctx,'provider-settings') (g1.ts:23); the run body forwards ctx.provider?.(arg) (g1.ts:25). The live path is the text interception: tryG1SlashModal handles a /^\/provider(\s\|$)/ line by calling openProvider( |
| `/queue` | interface | always | `Loop.togglePane/refreshQueuePane (packages/tui/src/app/loop.ts:3530, :4006) over optional BackendClient.queue (packages/tui/src/contracts.ts:217, implemented at packages/tui/src/backend/embedded.ts:700)` | implemented | Registered ungated in run.ts:62-72. run() guards on the optional ctx.queue member, toasting 'queue: pane seam absent' (run.ts:66-69), else calls it; the loop wires queue to togglePane('queue') (loop.ts:2522, implemented at loop.ts:3530-3547), which adds/remove |
| `/quit` | interface | always | `Loop SlashContext.quitApp (packages/tui/src/app/loop.ts:2496) -> Loop.requestQuit + the host shutdown controller (apps/tui/src/index.ts:199)` | implemented | Registered ungated in tools.ts:77-83; run() calls ctx.quitApp() (tools.ts:81), wired to Loop.requestQuit (loop.ts:2496) — the same quit path the key binding uses (it closes the backend and tears the terminal down through the host's shutdown controller, apps/tu |
| `/rename` | session | always | `packages/tui/src/backend/embedded.ts:814 (createEmbeddedBackend.rename -> applyTitle, @i-harness/core-session) driven by Loop.renameSession (packages/tui/src/app/loop.ts:2990)` | implemented | Registered ungated in sessions.ts:87-105. With an argument run() calls ctx.renameSession(title) directly (sessions.ts:94); without one it opens a bindTextInput overlay prefilled with app.title whose submit calls renameSession (sessions.ts:98-103), and cancel t |
| `/resume` | session | capability:session-list (types.ts:23), derived in loop.ts:24 | `Loop.openSessions/toggleSessions (packages/tui/src/app/loop.ts:2454, :3549) over BackendClient.listSessions (packages/tui/src/contracts.ts:193; embedded at packages/tui/src/backend/embedded.ts:518)` | implemented | Registered in sessions.ts:34-41, visible() = hasCapability(ctx,'session-list') (sessions.ts:37). run() calls ctx.openSessions() (sessions.ts:39), wired in the loop (loop.ts:2454-2456) to toggle the sessions picker open when it is not already open; the picker l |
| `/rewind` | execution | capability:rewind (types.ts:26), derived in loop.ts:2425 fro | `packages/tui/src/backend/embedded.ts:806 + buildRewindMember (:853) over @i-harness/rewind RewindService; Loop.openRewind (packages/tui/src/app/loop.ts:3727)` | optional-seam | Registered in run.ts:17-24, visible() = hasCapability(ctx,'rewind') (run.ts:20). run() calls ctx.openRewind() (run.ts:22), wired to Loop.openRewind (loop.ts:2458, implemented at loop.ts:3727-3742): it returns immediately when backend.rewind is undefined (no to |
| `/session-info` | session | always | `packages/tui/src/app/slash/impl/sessions.ts:110 over optional BackendClient.context (packages/tui/src/contracts.ts:246) and packages/tui/src/views/light-session-info.ts` | implemented | Registered ungated in sessions.ts:106-125. run() probes the OPTIONAL backend.context member with a catch-to-undefined (sessions.ts:110) and opens the 'session-info' panel built by sessionInfoRows with the id/title/model/turns/lines and the probed used/total (s |
| `/settings` | model | capability:provider-settings (types.ts:25), derived in loop. | `Loop.openSettings (packages/tui/src/app/loop.ts:3387) via tryG1SlashModal (packages/tui/src/app/loop.ts:3180); forwarded by packages/tui/src/app/slash/impl/g1.ts:42` | optional-seam | Registered in g1.ts:37-44, visible() = hasCapability(ctx,'provider-settings') (g1.ts:40); the run body forwards ctx.openSettings?.() (g1.ts:42). The live path is the interception: tryG1SlashModal matches '/settings' or '/settings …' and calls openSettings() (l |
| `/skills` | extension | always | `@i-harness/skills createSkillRegistry (packages/skills), rendered by packages/tui/src/views/light-skills.ts` | implemented | Registered ungated in eco.ts:42-53. run() creates the skill registry with createSkillRegistry({workspace: ctx.workspace ?? process.cwd()}) (eco.ts:47, :33-35), lists it and opens the 'skills' panel through skillsRows (eco.ts:48); a scan failure opens the panel |
| `/tasks` | interface | always | `Loop.togglePane/refreshTasksPane (packages/tui/src/app/loop.ts:3530, :4093) over optional BackendClient.tasks (packages/tui/src/contracts.ts:227, implemented at packages/tui/src/backend/embedded.ts:733)` | implemented | Registered ungated in run.ts:73-83. run() guards on the optional ctx.tasks member, toasting 'tasks: pane seam absent' (run.ts:77-80), else calls it; the loop wires tasks to togglePane('tasks') (loop.ts:2523, implemented at loop.ts:3530-3547), which calls refre |
| `/theme` | interface | always | `Loop.themeCommit (packages/tui/src/app/loop.ts:2479, implemented at :2864) over the settings store (SettingsTheme, packages/settings)` | implemented | Registered ungated in visual.ts:44-59. A bare /theme advances through THEME_ORDER (system → grok-night → grok-day → tokyo-night → rose-pine-moon → oscura-midnight → system) via nextTheme and calls ctx.setTheme(next) (visual.ts:34-41, :50); a named argument is  |
| `/timeline` | interface | always | `packages/tui/src/app/slash/impl/timeline.ts + the draw gate packages/tui/src/views/timeline.ts:45` | implemented | Registered ungated in timeline.ts:10-19; run() negates app.showTimeline and writes it directly on the app state (timeline.ts:15-17) with an on/off toast. The rail is additionally gated at DRAW time by views/timeline.ts: showTimeline must be true AND the pane w |
| `/timestamps` | interface | always | `Loop.setTimestamps (packages/tui/src/app/loop.ts:2883) over the ScrollbackEngine live timestamps toggle (packages/tui/src/contracts.ts:353)` | implemented | Registered ungated in visual.ts:60-68; run() negates app.timestamps and calls ctx.setTimestamps(next) (visual.ts:64-65), wired to Loop.setTimestamps (loop.ts:2484, implemented at loop.ts:2883). The toast reports the new value because it is computed after the w |
| `/toggle-mouse-reporting` | interface | feature setting: ctx.mouseReportingToggle === true (types.ts | `packages/tui/src/app/slash/impl/mouse.ts + TuiAppState.mouse (packages/tui/src/app/present.ts) and the scroll-stream normalizer (packages/tui/src/app/loop.ts:518)` | optional-seam | Built by toggleMouseReportingCommand and spread into the registry through mouseCommands() (mouse.ts:17-38, registry.ts:58). The gate is a FEATURE setting, not a backend capability: visible() = ctx.mouseReportingToggle === true (mouse.ts:21), and the loop suppl |
| `/transcript` | inspect | always | `Loop.openTranscriptPager (packages/tui/src/app/loop.ts:3113) over the engine rows (transcriptText, :3142) + node:child_process` | implemented | Registered ungated in tools.ts:52-59; run() awaits ctx.openTranscriptPager() and toasts 'transcript: pager opened' or 'transcript failed' (tools.ts:56-57), wired to Loop.openTranscriptPager (loop.ts:2500, implemented at loop.ts:3113-3139). That writes the seri |
| `/tutorial` | interface | always | `packages/tui/src/app/slash/impl/surfaces.ts:46 + packages/tui/src/views/light-tutorial.ts` | implemented | Registered ungated in surfaces.ts:30-36; run() calls the exported openTutorialIndex(ctx) (surfaces.ts:34, defined at surfaces.ts:46-61), which opens the 'tutorial' panel from tutorialIndexRows(); selecting a row opens that topic's content panel, whose onSelect |
| `/usage` | context | always | `packages/tui/src/app/slash/impl/surfaces.ts:22 over optional BackendClient.context (packages/tui/src/contracts.ts:246, implemented at packages/tui/src/backend/embedded.ts:785)` | optional-seam | Registered ungated in surfaces.ts:15-29. run() awaits the OPTIONAL backend.context member with catch-to-undefined (surfaces.ts:22) and opens the 'usage' panel titled 'Usage · this session' with usageRows(usage), or the USAGE_EMPTY row when the probe returned n |
| `/view-plan` | plan | capability:plan-mode (types.ts:30) — never supplied by Loop. | `packages/tui/src/app/slash/impl/run.ts:59 (toast only; no backend call)` | stub-toast | Registered in run.ts:54-61 with visible() = hasCapability(ctx,'plan-mode') (run.ts:57). The run body is the same toast as /plan, 'plan: live backend switching capability not wired' (run.ts:59). 'plan-mode' is never pushed by Loop.slashCapabilities() (loop.ts:2 |
| `/vim-mode` | interface | capability:vim-mode (types.ts:32) — never supplied by Loop.s | `packages/tui/src/app/slash/impl/text-input.ts:69 (toast only; no backend call)` | stub-toast | Registered in the editorSafetyCommands array (text-input.ts:63-72) which the registry spreads last (registry.ts:61), visible() = hasCapability(ctx,'vim-mode') (text-input.ts:67). The run body is a single toast, 'vim-mode: live editor capability not wired' (tex |
| `/workflow` (/workflows) | execution | always | `@i-harness/workflow (createWorkflowRegistry/createWorkflowExecutor) behind packages/tui/src/app/slash/impl/workflow2.ts:279 (createDefaultWorkflowSurface) and WorkflowSurface (packages/tui/src/contracts.ts)` | implemented | Registered in workflow2.ts:131-177 with the 'workflows' alias (workflow2.ts:134). run() resolves ctx.workflow and toasts 'workflow: surface not wired' if absent (workflow2.ts:138-141); 'run <name>' validates the name against surf.list() BEFORE prompting for pa |

## CLI 宿主面

### `i-harness run`

| 旗標 | 行為 | 驗證 | 出處 |
|---|---|---|---|
| `--yes` | Boolean presence flag (args.includes) -> opts.approveAll = yes (apps/cli/src/index.ts:170, :303); the token is also stripped from the task text (apps/cli/src/index.ts:291). | No value and no validation; a following token is NOT consumed and becomes part of the task. Absent -> approveAll false/undefined. | `apps/cli/src/index.ts:170` |
| `--sandbox <read-only\|workspace-write\|danger-full-access>` | Headless face of settings.sandboxMode; the value is resolved at apps/cli/src/index.ts:181-192 and passed as opts.sandbox (apps/cli/src/index.ts:306) into the assembly (apps/cli/src/run.ts:248). | FAIL LOUD: missing value or a value outside the three-mode whitelist -> stderr exactly '--sandbox requires one of: read-only \| workspace-write \| danger-full-access' and return 1 (apps/cli/src/index.ts:186-191). Absent -> settings.sandboxMode, read AFTER settings.load() (apps/cli/src/index.ts:193-201). | `apps/cli/src/index.ts:181` |
| `--telemetry` | Boolean -> opts.telemetry = 'jsonl' (apps/cli/src/index.ts:205, :309) -> a JSONL telemetry sink on stdout (apps/cli/src/run.ts:139). | No value, no validation; also enabled by the env var I_HARNESS_TELEMETRY === '1' (apps/cli/src/index.ts:205). | `apps/cli/src/index.ts:205` |
| `--model <provider:model>` | parseModel(spec, apiKey) (apps/cli/src/index.ts:62-74) -> opts.model (apps/cli/src/index.ts:308); built-in profiles registered: openai, deepseek, anthropic, gemini, bedrock (apps/cli/src/index.ts:66-70). | FAIL LOUD: missing spec value, or a non-bedrock model without --api-key -> stderr '--model requires --api-key KEY' and return 1 (apps/cli/src/index.ts:277-280); an unknown provider makes parseModel throw 'unknown model provider: <provider>' (apps/cli/src/index.ts:72), which is caught, printed and returns 1 (apps/cli/src/index.ts:281-286). bedrock is exempt from the api-key requirement (apps/cli/src/index.ts:276). | `apps/cli/src/index.ts:206` |
| `--api-key <KEY>` | Supplies the apiKey argument for --model (apps/cli/src/index.ts:207, :275, :282). | NO standalone validation: with no --model it is silently ignored (and still stripped from the task text, apps/cli/src/index.ts:291, :293). With --model present, an absent or valueless --api-key triggers the '--model requires --api-key KEY' error (apps/cli/src/index.ts:277). | `apps/cli/src/index.ts:207` |
| `--session-dir <DIR>` | JSONL store root: creates the coordinator with the ownership lease (apps/cli/src/index.ts:228-238) and a file-backed session query (apps/cli/src/index.ts:265-267). | FAIL LOUD on a missing value: undefined or '' -> stderr '--session-dir requires a directory' and return 1 (apps/cli/src/index.ts:229-233). The value itself is NOT validated (no existence/type check). A coordinator.create() failure such as a lock conflict prints the error and returns 1 (apps/cli/src/index.ts:246-257). | `apps/cli/src/index.ts:208` |
| `--resume <ID>` | Sets opts.resumeSessionId (apps/cli/src/index.ts:240, :313) -> runHeadless restarts from the persisted log (apps/cli/src/run.ts:162-179). | FAIL LOUD twice: without --session-dir -> stderr '--resume requires --session-dir DIR (headless runs are ephemeral without a store)' and return 1 (apps/cli/src/index.ts:219-222); with --session-dir but no id value -> stderr '--resume requires a session id' and return 1 (apps/cli/src/index.ts:241-244). | `apps/cli/src/index.ts:209` |
| `(any other token, e.g. --workspace / --prompt / --help)` | NOT a recognized run flag and NOT rejected: every token after 'run' except the seven flag names above and their values is joined into the task text (apps/cli/src/index.ts:290-295), so 'i-harness run --help' runs a headless turn whose task is the literal string '--help'. | No validation; an unrecognized flag silently becomes part of the prompt. An empty resulting task prints the run usage line and returns 1 (apps/cli/src/index.ts:296-299). | `apps/cli/src/index.ts:290` |

### `i-harness web`

| 旗標 | 行為 | 驗證 | 出處 |
|---|---|---|---|
| `--port <N>` | Resolved by pickWebPort (apps/cli/src/index.ts:109; helper at apps/cli/src/index.ts:50-56) into WebServerOptions.port and used as the listen port (apps/cli/src/web.ts:517-519). | NO fail-loud / SILENT FALLBACK: the flag value is used only when Number.isInteger(v) && v > 0; otherwise it silently falls through to the PORT env var and then to the default 4310 (apps/cli/src/index.ts:51-55). '--port 0' is rejected by the flag even though PORT=0 is valid through parsePort (apps/cli/src/web.ts:95-99). Only the first --port occurrence is read. | `apps/cli/src/index.ts:109` |
| `--session-dir <DIR>` | Presence test only: sets WebServerOptions.storeRoot = args[indexOf('--session-dir') + 1] (apps/cli/src/index.ts:113), used as the served store root (apps/cli/src/web.ts:406). | NO validation and NO fail-loud, unlike run/sdk/acp: a missing value yields storeRoot undefined and the default root resolveSessionStoreRoot() is used (apps/cli/src/web.ts:406); the value is passed through verbatim. | `apps/cli/src/index.ts:113` |
| `--launch-token <TOKEN>` | Half of the auth fence: enables WebServerOptions.auth plus printLoginUrl (apps/cli/src/index.ts:103, :105, :115) and prints the login URL (apps/cli/src/web.ts:570-572). | No validation. Falls back to the env var I_HARNESS_TOKEN (apps/cli/src/index.ts:105). When absent (or last with no value -> undefined) and no --hmac-secret/env is set, auth stays off entirely (apps/cli/src/index.ts:115-116). | `apps/cli/src/index.ts:103` |
| `--hmac-secret <SECRET>` | Other half of the auth fence -> createAuth hmacSecret (apps/cli/src/web.ts:513-516); a missing half is randomized at start (apps/cli/src/web.ts:514-515). | No validation. Falls back to the env var I_HARNESS_HMAC (apps/cli/src/index.ts:106). | `apps/cli/src/index.ts:104` |
| `(every other flag, e.g. --sandbox / --yes)` | NOT read by the web branch and NOT rejected: the branch inspects only --port, --session-dir, --launch-token and --hmac-secret (apps/cli/src/index.ts:102-117), so 'web --sandbox read-only' is silently ignored and the mode comes from settings.sandboxMode (apps/cli/src/web.ts:469-470). | Silently ignored (no error, no warning). | `apps/cli/src/index.ts:107` |

### `i-harness sdk`

| 旗標 | 行為 | 驗證 | 出處 |
|---|---|---|---|
| `--session-dir <DIR>` | Creates the JSONL coordinator with the ownership lease and the storeRoot used for session/rewind/list (apps/cli/src/index.ts:411-422, :428-435, :522, :527-542). The stdio JSON-RPC server itself is createSdkServer (apps/cli/src/index.ts:494). | FAIL LOUD on a missing value: dir undefined or '' -> stderr '--session-dir requires a directory' and return 1 (apps/cli/src/index.ts:416-419). No other validation (the value is not checked for existence). | `apps/cli/src/index.ts:411` |
| `(every other token)` | Ignored: runSdkCommand reads nothing but --session-dir (apps/cli/src/index.ts:410-411). There is no --help handling, so 'i-harness sdk --help' starts the stdio JSON-RPC server. | Silently ignored. | `apps/cli/src/index.ts:410` |

### `i-harness acp`

| 旗標 | 行為 | 驗證 | 出處 |
|---|---|---|---|
| `--session-dir <DIR>` | Same as sdk: coordinator plus storeRoot for the ACP service (apps/cli/src/index.ts:581-592, :598-605). | FAIL LOUD on a missing value: undefined or '' -> stderr '--session-dir requires a directory' and return 1 (apps/cli/src/index.ts:584-589). | `apps/cli/src/index.ts:581` |
| `--no-auto-approve` | Boolean presence test: createAcpServer({ autoApprove: !args.includes('--no-auto-approve') }) (apps/cli/src/index.ts:610), switching the permission face from allow-once to fail-closed refuse (comment apps/cli/src/index.ts:575-579). | No value, no validation; exact-token match only, so '--no-auto-approve=true' does not match and auto-approve stays ON. | `apps/cli/src/index.ts:610` |
| `(every other token)` | Ignored; no --help handling (apps/cli/src/index.ts:580). | Silently ignored. | `apps/cli/src/index.ts:580` |

### `i-harness tui`

| 旗標 | 行為 | 驗證 | 出處 |
|---|---|---|---|
| `--prompt <text>` | flags.prompt (apps/tui/src/index.ts:442) -> the initialize prompt (apps/tui/src/index.ts:432); suppressed when --resume is set (apps/tui/src/index.ts:185-194). | No validation; a missing value sets undefined (silently no prompt). | `apps/tui/src/index.ts:442` |
| `--workspace <dir>` | flags.workspace -> workspace = flags.workspace ?? process.cwd() (apps/tui/src/index.ts:748). | No validation; a missing value falls back to process.cwd(). | `apps/tui/src/index.ts:443` |
| `--model <spec>` | flags.model -> the model override passed to createTuiModelBindingFor(providerRuntime, flags.model) (apps/tui/src/index.ts:809). | No validation at parse time; resolution happens in the provider runtime, so an unsupported value surfaces at the model end rather than at the parser. | `apps/tui/src/index.ts:444` |
| `--yes` | Sets flags.yes (apps/tui/src/index.ts:445). NO-OP: flags.yes is never read anywhere (its only three occurrences are the field declaration apps/tui/src/index.ts:102, the init :439 and the assignment :445, though --yes IS documented in the usage strings at apps/cli/src/index.ts:36 and apps/tui/src/index.ts:461). | No value, no validation, no effect. | `apps/tui/src/index.ts:445` |
| `--resume <id>` | flags.resume -> resumeSessionId plus rewindStoreRoot (apps/tui/src/index.ts:185-194), the app sessionId (apps/tui/src/index.ts:421, :428) and the provider controller sessionId (apps/tui/src/index.ts:887). | No validation; a missing value -> undefined -> a plain fresh launch. | `apps/tui/src/index.ts:446` |
| `--session-dir <dir>` | flags.sessionDir -> storeRoot/rewindStoreRoot (apps/tui/src/index.ts:188-194); also forwarded to the spawned `sdk` child for --attach (apps/tui/src/index.ts:114-120). | No validation; a missing value -> undefined -> the default root resolveSessionStoreRoot (apps/tui/src/index.ts:137-141, :188). | `apps/tui/src/index.ts:447` |
| `--attach <sessionId>` | Switches the backend to the REMOTE SDK stdio server: createRemoteBackend(spawnSdkSubprocess(...)) (apps/tui/src/index.ts:792-801); it also sets the app/controller sessionId (apps/tui/src/index.ts:421, :428, :887). | No validation of the id; a missing value -> undefined -> the embedded backend. There is no history replay for an attach (documented gap, apps/tui/src/index.ts:784-791). | `apps/tui/src/index.ts:448` |
| `--minimal` | flags.mode = 'minimal' (apps/tui/src/index.ts:449) -> resolveExecutableScreenMode -> the inline live-region startup split (apps/tui/src/index.ts:581-590, :661-672). | No value; it wins the precedence chain flag > persisted tui.prefs.screenMode > fullscreen. | `apps/tui/src/index.ts:449` |
| `--fullscreen` | flags.mode = 'fullscreen' (apps/tui/src/index.ts:450) -> the terminal init / alt-screen path (apps/tui/src/index.ts:673-676). | No value; it wins the precedence chain. | `apps/tui/src/index.ts:450` |
| `--mode <minimal\|fullscreen>` | Sets flags.mode only for the exact literals 'minimal'/'fullscreen' (apps/tui/src/index.ts:451-456). | SILENT REJECT: any other value (or a missing value) is ignored while the token is still consumed; resolution falls through to the persisted tui.prefs.screenMode and then to fullscreen (apps/tui/src/index.ts:581-590). No error. | `apps/tui/src/index.ts:451` |
| `--help / -h` | Writes the tui usage to STDOUT and calls process.exit(0) (apps/tui/src/index.ts:457-463). | Exits the process immediately with 0, ignoring every other flag. | `apps/tui/src/index.ts:457` |
| `(any unknown flag/token)` | Silently ignored: the parseFlags switch has no default case (apps/tui/src/index.ts:440-465). | No error, no warning. | `apps/tui/src/index.ts:441` |

### `i-harness sessions`

| 旗標 | 行為 | 驗證 | 出處 |
|---|---|---|---|
| `--json` | options.json = true (apps/cli/src/sessions.ts:52) -> JSON output for list (apps/cli/src/sessions.ts:200-202) and for show (apps/cli/src/sessions.ts:192-195). | No value, no validation. Accepted for both list and show even though the sessions usage string documents it only for list (apps/cli/src/sessions.ts:165-167). | `apps/cli/src/sessions.ts:52` |
| `--session-dir <DIR>` | options.sessionDir (apps/cli/src/sessions.ts:53) -> storeRoot = options.sessionDir ?? resolveSessionStoreRoot() (apps/cli/src/sessions.ts:177). | NO fail-loud: a missing value yields undefined -> the shared default root; the value is not validated at all (apps/cli/src/sessions.ts:53, :177). | `apps/cli/src/sessions.ts:53` |
| `--last <N>` | options.last = Math.floor(N) -> renderTranscript(session, options.last ?? 20) for show (apps/cli/src/sessions.ts:54-58, :196). | SILENT REJECT: only finite values > 0 are kept; anything else (non-numeric, 0, negative) is dropped and the default 20 applies. No error, no exit. | `apps/cli/src/sessions.ts:54` |
| `--help / -h / help` | subcommand = 'help' -> SESSIONS_USAGE printed to STDOUT and return 0 (apps/cli/src/sessions.ts:59, :173-176). | No validation; any of the three spellings. This help goes to stdout while the top-level help goes to stderr. | `apps/cli/src/sessions.ts:59` |
| `show (subcommand token)` | subcommand = 'show' (apps/cli/src/sessions.ts:60); the FIRST non-flag token seen AFTER it becomes the id (apps/cli/src/sessions.ts:62). | FAIL LOUD when the id is missing: stderr SESSIONS_USAGE and return 2 (apps/cli/src/sessions.ts:180-183) — this is the only code-2 path in the CLI. An unknown id -> stderr 'session not found: <id> (<error>)' and return 1 (apps/cli/src/sessions.ts:186-191). Quirk: 'sessions <id> show' (id before the word show) ignores the id and exits 2, because the id branch requires subcommand === 'show' already (apps/cli/src/sessions.ts:62). | `apps/cli/src/sessions.ts:60` |
| `list (subcommand token)` | subcommand = 'list' (also the default) -> the table or JSON listing, return 0 (apps/cli/src/sessions.ts:61, :199-205). | No validation; extra non-flag tokens are ignored. | `apps/cli/src/sessions.ts:61` |
| `(any unknown flag)` | Silently ignored: the parse loop handles only the tokens above and the unknown token is consumed by nothing (apps/cli/src/sessions.ts:50-63). | No error, no exit. | `apps/cli/src/sessions.ts:50` |

### `i-harness (bare — no subcommand)`

| 旗標 | 行為 | 驗證 | 出處 |
|---|---|---|---|
| `(the whole tui flag set: --prompt, --workspace, --model, --yes, --resume, --session-dir, --attach, --minimal, --fullscreen, --mode, --help/-h)` | parseFlags is applied to the FULL argv slice (apps/cli/src/index.ts:167), so a bare launch accepts exactly the tui flags; --help prints the tui usage to stdout and process.exit(0) (apps/tui/src/index.ts:457-463). The backend is the durable embedded factory with storeRoot = flags.sessionDir ?? resolveSessionDir() and rewindStoreRoot = the same root (apps/tui/src/index.ts:188-194, :802). | Same as the tui host: unknown tokens silently ignored, --mode with an unknown value silently ignored, --yes a no-op. Note that an UNKNOWN FIRST TOKEN is not an error either — it falls into this same branch (apps/cli/src/index.ts:164-168) and is swallowed by the flag parser, so e.g. 'i-harness gunk' launches the TUI and exits 0. | `apps/cli/src/index.ts:167` |

