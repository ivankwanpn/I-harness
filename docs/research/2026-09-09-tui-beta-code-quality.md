# opencode 1.18.30 TUI 套件程式碼品質評估

日期：2026-09-09 · 方式：唯讀走查（未執行、未安裝、未建置、未跑測試）
範圍：`D:\I-harness-main\.worktrees\tui-beta-1\tui-beta\`（opencode 1.18.30 `packages/tui` 的逐字 vendored 副本）
路徑慣例：以下 `path:line` 一律相對於 `tui-beta/`（即 `.worktrees/tui-beta-1/tui-beta/`）。IH 自身路徑以 `packages/...` 表示。
前置閱讀：`docs/research/2026-09-09-opencode-tui-graft-feasibility.md`（移植可行性）、`docs/research/2026-09-09-tui-beta-backend-gap.md`。本檔不重複那份結論，只回答「這包程式碼本身好不好、能偷什麼」。

---

## 一頁結論

**「屎山」這個判斷，對 `tui-beta` 這個套件不成立。** 這是一包**中上品質、有明確架構紀律、但正卡在一次未完成遷移中**的程式碼。真正的問題不是爛，而是**兩套世界觀並存**與**兩三個巨檔吸收了大半複雜度**。

幾個可驗證的體感校正：

| 指標 | 數值 | 證據 |
|---|---|---|
| 檔案數 / 總行數 | 152 檔 / 27,044 行 | `find src` |
| 行數中位數 | **79 行** | 112/152 檔 ≤150 行 |
| >500 行的檔案 | **13 檔**（其中 5 檔占 28.6% 行數） | `routes/session/index.tsx:1-2706`、`component/prompt/index.tsx:1-1716`、`app.tsx:1-1134`、`theme/index.ts:1-1089`、`feature-plugins/system/diff-viewer.tsx:1-1077` |
| TODO/FIXME/HACK/XXX | **4 處**（全 src） | `component/prompt/index.tsx:401`、`parsers-config.ts:153,287`、`routes/home.tsx:18` |
| `: any` / `as unknown` / `@ts-expect-error` | **6 / 3 / 2** | 見 §2.6 |
| 測試 | 4,597 行 / 47 檔 / 約 500 個 `expect` | `test/**` |
| 已死檔案 | **3 檔 + 2 個零匯入 shim** | `component/dialog-tag.tsx`、`component/prompt/cwd.ts`、`routes/session/dialog-subagent.tsx`；`component/prompt/{history,frecency}.tsx` |

**整體評級：B（3.7/5）**——可以直接讀、可以偷設計，但不該整套照抄，也不該用「反正它是屎山」來當作不讀它的理由。

判 B 而非 A 的理由（四個真實缺陷，全部有證據）：
1. **兩個 god component**：`Session()` 一個函式 1,186 行（`routes/session/index.tsx:177-1362`）、`Prompt()` 一個函式 1,574 行（`component/prompt/index.tsx:143-1716`），而這兩檔幾乎沒有直接測試。
2. **一次未完成的 v1→v2 遷移被凍結在樹裡**：`context/sync.tsx`（v1 事件模型）與 `context/data.tsx`（v2 事件模型）是**兩個並行 store**，後者 569 行只被**一個**消費者使用（`component/prompt/autocomplete.tsx:90`）。
3. **完全沒有應用層虛擬化**：訊息列表硬上限 100 則（`context/sync.tsx:341-358, 603, 625-627`），且無「載入更舊」路徑。
4. **測試覆蓋與風險分布相反**：最大的兩個檔案幾乎零覆蓋，而 race 測試測的是**手抄的鏡像函式**而非生產碼（`test/cli/tui/prompt-submit-race.test.ts:52-68`）。

判 B 而非 C 的理由：錯誤處理誠實、型別逃逸極少、模組邊界大致成立、plugin 邊界真的乾淨、關鍵 race 有真測試、而且**自家功能是用自家 plugin API 寫的**（`feature-plugins/builtins.ts:21-36`）——這是少見的自我節制。

「屎山感」從何而來（誠實推測）：**不是 TUI 的錯，是它承載的 server 語意**。v1/v2 雙事件模型、`session.next.*` 與 `message.part.*` 混雜（`context/sync.tsx:300` 處理 v2 事件、`:321-431` 處理 v1 事件）、provider/MCP/LSP/VCS/workspace/console 全部是 server-owned 概念——這些是 opencode 產品形狀帶來的複雜度，不是 TUI 作者寫壞了。

---

## 二、分項評估

### 2.1 結構（4/5）

**模組邊界大致乾淨。** 跨目錄依賴矩陣（相對匯入統計）：

| 來源 | 依賴 | 判讀 |
|---|---|---|
| `context/` | 只依賴 `util/`（3）、`ui/`（1）、`component/`（1 type-only）、`prompt/`（1） | 幾乎不反向依賴上層 |
| `ui/` | `context/`（9）、`util/`（3）、`component/`（1） | 唯一違規：`ui/dialog-prompt.tsx:5` 匯入 `component/spinner` |
| `component/` | `context/`（65）、`ui/`（48）、`util/`（16） | 唯一違規：`component/prompt/move.tsx:11` 匯入 `routes/home/session-destination` |
| `routes/` | `context/`（6）、`component/`（2）、`ui/`（1）、`plugin/`（1） | 合理 |
| `feature-plugins/` | `component/`（1）、`routes/`（1） | 違規但輕微：`feature-plugins/home/footer.tsx:6`、`feature-plugins/sidebar/todo.tsx:4` |
| `plugin/` | `ui/`（7）、`context/`（6） | 這是 adapter 層，本來就該認識兩邊 |

**`context/sdk.tsx` → `context/sync.tsx` 的縫在哪裡、在哪裡漏：**

- 縫**成立**的部分：`sdk.tsx` 只做三件事——建 client、維持事件訂閱與**合批**、暴露 `EventSource` 型別供測試注入（`context/sdk.tsx:7-9, 48-80, 141-149`）。`sync.tsx` 只訂閱 `useEvent()` 並持有 store（`context/sync.tsx:146, 176-446`），它不認識任何 UI 元件。兩者之間沒有循環依賴。
- **測試縫是真的**：`TuiInput` 接受外部 `fetch` 與 `events`（`app.tsx:142-152`），測試用 `createFetch` 假造整個 HTTP 層（`test/fixture/tui-sdk.ts:64-108`）。這條縫讓 4,597 行測試得以不啟動 server。
- 漏的地方（三個）：
  1. **store 本身就是事實上的 public API**。`useSync()` 回傳 `{ data: store, set: setStore, ... }`（`context/sync.tsx:558-560`）；27 個檔案呼叫 `useSync()`，其中 21 個直接讀 `sync.data.*`（共 117 處，例：`routes/session/index.tsx:1281, 1289` 讀 `sync.data.part[message.id]`）。任何 store 形狀變動會直接波及 UI 層，沒有 selector 層。
  2. **元件可直寫 store**：`component/dialog-mcp.tsx:61` 呼叫 `sync.set("mcp", status.data)`。寫入路徑沒有收斂。
  3. **plugin 邊界反而比內部乾淨**：`plugin/adapters.tsx:98-163` 的 `stateApi()` 把 store 包成唯讀 facade（`state.session.todo()`、`state.part()`…），外部 plugin 拿不到 `setStore`。**這是全樹最好的封裝，但它只服務 plugin。**

- 巨檔分布：13 檔 >500 行，其中 `routes/session/index.tsx` 2,706 行同時裝了路由元件、per-tool renderer、parser 工具（`parseApplyPatchFiles` 2652、`parseTodos` 2667、`parseQuestions` 2677…）與 layout 常數。`app.tsx` 559-1079 是 **520 行的 inline 命令表**；`component/prompt/index.tsx:335-635` 是 **300 行的 inline 命令陣列**。這是「命令定義沒有被抽成資料檔」的結構弱點。

### 2.2 資料層（3/5）

`context/sync.tsx` 的 store + reducer **本身是連貫的**，不是亂堆：

- Store 是一個平面物件，鍵為 `message[sessionID]` / `part[messageID]` / `session_status[sessionID]` 等（`context/sync.tsx:70-114`）。**缺點**：命名不一致——`provider_default`、`provider_next`、`session_diff`、`mcp_resource` 是 snake_case，同一個物件裡卻有 `capabilities.experimentalBackgroundSubagents`（`:121-123`）。這看得出歷史分層。
- Reducer 是單一 `event.subscribe` 的大 switch（`:176-446`），19 個 case。**但每個 case 都短且有秩序**：用 `search()` 二分搜尋定位（`:41-52`），`reconcile()` 做細粒度更新（`:288, 330, 385`），`produce()` 做插入/刪除（`:189-192, 217-223`）。插入路徑有三段式慣例（不存在→建陣列；找到→reconcile；沒找到→splice 插入）。這比「accreted switch」的指控要好得多：**它是一套有規則的 switch**。
- 排序鍵明確且被測試：`compareMessage` 用 `time.created` 再 `id.localeCompare` 打破平手（`:54-56`），`messageKey` 相同（`:58`）。`test/cli/cmd/tui/sync-live-hydration.test.tsx:36-57` 直接斷言這個順序。
- **真正值得學習的**：hydration 與 live event 的競爭處理。`hydratingSessions` 追蹤器（`:150-158`）在同步期間記錄「哪些 message/part 已經有 live 版本」，同步回來時用 live 版覆蓋快照版（`:614-654`），甚至處理「伺服器回傳空 text 但 live 已有內容」的降級（`:637-645`）。這是對真實競態的正面處理，且有測試（`sync-live-hydration.test.tsx:59-109`）。

**扣分在「重複真相來源」與「半成品遷移」：**

1. **兩個 store、兩套訊息模型。** `context/data.tsx` 是一套完整的 v2 資料層：569 行、自己的 store（`:61-72`）、自己的 31-case reducer（`:124-403`）、自己的 `message.*` 輔助函式（`:80-122`）。它的事件模型與 sync 完全不同——assistant 的內容是**嵌套陣列** `content: (text|tool|reasoning)[]`（`:247-253, 267-275`），而不是 `part[messageID]` 的扁平表。它用 `event as V2Event` 把 v1 事件硬轉成 v2 形狀（`:405-414`）。
   **而且它只被一個檔案使用**：`component/prompt/autocomplete.tsx:90`（讀 `data.location.reference.list()`，`:280`）。569 行 store + 486 行測試，換一個 reference 清單。這是**凍結的遷移**，不是設計。
2. **同一件事推導兩次。** `sync.session.status()`（`:584-593`）從本地訊息推導 `working/idle/compacting`；server 另有一份 `session_status`（`:317, 531`）。前者**零消費者**（全樹 grep `session.status()` 無命中）——死碼。
3. **v1/v2 事件在同一 switch 內混用**：`:300` 處理 `session.next.moved`（v2），`:321-431` 處理 v1。這不是錯，但它是遷移現場的直接證據。
4. **100 則上限是系統級的**：不只是渲染上限。`session.messages({limit: 100})`（`:603`）、live 超過 100 就 shift 掉最舊並刪 part（`:341-358`）、hydrate 時 `slice(-100)`（`:625-627`）。timeline dialog（`routes/session/dialog-timeline.tsx:23`）、複製與匯出（`routes/session/index.tsx:212, 928, 972`）全部讀同一份 100 則窗口，**沒有任何 UI 提示「上面還有更多」**。這是我在整個套件裡找到最嚴重的誠實性問題。

### 2.3 渲染層（3.5/5）

- **SolidJS 用法**：整體是好的。大量 `createMemo` 做衍生（`routes/session/index.tsx` 內數十個）、`<For>` + `<Show>` + `<Switch>` 而非手動 DOM、`batch()` 包住多鍵更新（`context/sync.tsx:505-514`）、`createEffect(on(...))` 明確追蹤來源（`app.tsx:540-549`）。細粒度響應式**用得順**，不是被對抗。
- **但有三處在跟框架打架**：
  1. `util/layout.ts:8-25` 用 `el.onLifecyclePass` 在 Yoga layout 前偷改 `marginTop`，靠 WeakMap 快取前一幀的兄弟節點。配合 `routes/session/index.tsx:94` 的 module-global `alwaysSeparate = new WeakSet<BoxRenderable>()`（在 ref callback 裡被寫入，:1939-1946 讀取）決定是否加空行——**一個跨元件的隱式全域狀態**。它運作得起來，但它是「用 renderable 樹當共享記憶體」。
  2. `feature-plugins/system/diff-viewer.tsx:213-221` 手算 `patchNode.y - scroll.viewport.y` 再 `scrollBy()` 定位；`:253-268` 靠掃描所有節點座標判斷「當前檔案」。40 個 signals + 手動座標數學塞在一個 855 行的元件裡。
  3. `routes/session/index.tsx:1198` 用 `<box height={1} />` 當間隔 hack。
- **長列表虛擬化：本套件沒有。** 訊息列表是 `<For each={messages()}>` 直接全渲染（`routes/session/index.tsx:1199-1294`），靠 100 則硬上限控制成本。`DialogSelect` 也是全渲染（`ui/dialog-select.tsx:618-635`），只把**高度**限制在終端機一半（`:213`）——session 清單若有數千筆，就會建數千個 renderable。**唯一的例外是 which-key**：它自己做了視窗化（`offset` + `pageSize = rows*columns` + 逐列填滿欄，`feature-plugins/system/which-key.tsx:224, 236-250`）。
- **tool 輸出渲染：一工具一元件，但是硬開關，不可擴充。** `ToolPart` 是 `<Switch>` 配 15 個 `<Match when={display() === "bash"}>` 分支（`routes/session/index.tsx:1740-1786`），分派鍵由 `toolDisplay()` 白名單決定（`:2626-2645`，14 個工具名，其餘落 `GenericTool`）。每個工具是獨立函式元件（`Shell:2046`、`Edit:2390`、`Task:2215`、`ApplyPatch:2443`…），彼此不共用基底，但共用 `InlineTool`/`BlockTool` 兩個殼（`:1836, 1994`）。
  **關鍵事實**：plugin slot 清單裡**沒有 tool render slot**（全樹 slot 名僅 `app`、`app_bottom`、`home_logo`、`home_prompt`、`home_prompt_right`、`home_bottom`、`home_footer`、`session_prompt`、`session_prompt_right`、`sidebar_content`、`sidebar_footer`）。所以第三方**無法**註冊工具渲染器——這是刻意的封閉，也是擴充性天花板。
- 增量渲染：`<markdown streaming={true}>`（`:1692-1701`）與 `<code streaming={true}>`（`:1635-1643`）是 **OpenTUI renderable 的能力**，不是本套件實作。本套件只是把 `streaming` 打開。

### 2.4 錯誤處理 / 誠實性（4/5）

**好的部分：**
- 有真正的錯誤邊界與崩潰畫面：`app.tsx:255` 包 `<ErrorBoundary>`，fallback 是 `ErrorComponent`——顯示 message + stack、可複製含 issue URL 的報告、可 restart/quit（`component/error-component.tsx:10-98`）。主題可能壞掉時用內建色票（`:18-41`）。
- 錯誤訊息組裝很認真：`util/error.ts:5-76` 把 `CliError`/`ProviderModelNotFoundError`/`ConfigInvalidError` 等 tagged error 轉成**可行動的**人話（含 "Did you mean" 與 `opencode models` 建議，`:19-30`）。
- 啟動狀態是 `loading | partial | complete`（`context/sync.tsx:71, 518, 537`），`partial` 是誠實的——provider 等阻塞項到位就放行，其餘非阻塞補齊。
- 失敗有專屬 UI 而非靜默：`component/dialog-session-delete-failed.tsx:53-97` 明說「工作區不可用所以刪不掉」並給兩個復原選項；`component/plugin-route-missing.tsx:8` 顯示 `Unknown plugin route: {id}`。
- 71 處 `toast.show/error`，session 切換失敗會帶訊息回首頁（`routes/session/index.tsx:315-323`）。

**扣分的部分：**
- **23 處 `catch(() => {})`**（`.catch(` 總數 82）。多數是「持久化寫入失敗就算了」（`prompt/history.tsx:60,104,107`、`prompt/stash.tsx`、`prompt/frecency.tsx`），可辯護；但 `context/sdk.tsx:116` 把**整條 SSE 迴圈的例外吞掉**、`:99/:127` 吞掉 `sync.start()` 失敗、`component/prompt/index.tsx:83` 與 `routes/session/index.tsx:310` 是裸 `catch {}`（後者有註解說明「工作區可能已不存在，不致命」，`:304-310`，可接受；前者沒有）。
- **靜默的任意預設**：`context/local.tsx:224-233` 在找不到模型時退回 `provider[0]` 的第一個模型；`:236-244` 再用 `getFirstValidModel` 鏈。使用者會看到一個**自己沒選過**的模型被當成當前模型。
- **型別層面的不誠實**：`context/local.tsx:258-265` 在無 provider 時回傳 `{ provider: "Connect a provider", model: "No provider selected" }`——把 UI 文案塞進資料欄位，之後無法區分「真的叫這個名字的 provider」與「沒有 provider」。
- 一個小 typo：`util/error.ts:39` 的 `is not valid JSON(C)`。

### 2.5 測試（3/5）

**覆蓋什麼：** 47 檔 / 4,597 行 / 約 500 個 `expect`。最大宗是 `test/cli/tui/data.test.tsx`（486 行）、`test/util/transcript.test.ts`（449）、`test/cli/tui/inline-tool-wrap-snapshot.test.tsx`（351）、`test/feature-plugins/diff-viewer-file-tree-utils.test.ts`（323）。

**是行為測試還是快照？** 主要**是行為測試**，而且選題精準：
- `sync-live-hydration.test.tsx:36-57` 斷言排序不變式；`:59-109` 斷言「過期的 hydration 不得覆蓋 live part」；`:111+` 斷言「孤兒 delta 不得抑制 hydrate 的 part」。
- `test/keymap.test.tsx:29-135` 斷言 mode stack 的分層語意（base/question/autocomplete 下各命令的 active 數量），是精確的語意測試。
- `test/config.test.tsx`、`test/theme.test.ts` 等是純函式測試。
- 只有 **8 處 snapshot**（`test/cli/tui/__snapshots__/inline-tool-wrap-snapshot.test.tsx.snap`），而且是**渲染後的真實文字框**（含換行位置），斷言的是使用者看到的東西——這是好快照。
- 測試替身設計好：`test/fixture/tui-sdk.ts:64-108` 的 `createFetch` 在遇到**未預期的請求時直接 throw**（`:106`），不會靜默回 `{}`。`@opentui/solid` 的 `testRender` 提供真正的 headless render。

**為什麼只給 3/5：**
1. **風險最大的兩個檔案幾乎沒測到**。`routes/session/index.tsx`（2,706 行）只有其**匯出的純函式與 `InlineToolRow`** 被測（`inline-tool-wrap-snapshot.test.tsx:5-18`）；`Session()` 本體（1,186 行）、`ToolPart` 分派、`Prompt()` 本體（1,574 行）無測試。
2. **有一類測試測的是手抄的鏡像**。`test/cli/tui/prompt-submit-race.test.ts:17-20` 的註解明說 `submitMirror`/`createSubmit` 是「生產 `submit()` 修正後的形狀」，:52-68 是**複製一份邏輯**來測。生產碼的 guard 目前在 `component/prompt/index.tsx:930-947`，兩者當前一模一樣，但**生產碼若回歸，這個測試不會紅**。這是文件，不是回歸測試。
3. 沒有 e2e / PTY 層測試；沒有覆蓋 `context/sync.tsx` 的 bootstrap 失敗路徑（`fatal` 分支 `:546-550`）。

### 2.6 重複與死碼（3.5/5）

**型別逃逸極少（這是加分項）**：`src` 內 `: any` 只有 6 處（`context/editor.ts:397`、`context/kv.tsx:51,54`、`routes/session/index.tsx:1502`、`ui/dialog.tsx:150`、`ui/toast.tsx:69`），`as unknown` 3 處（`app.tsx:188`、`context/theme.tsx:57`、`editor-zed.ts:282`），`@ts-expect-error` 2 處（`context/helper.tsx:14`、`context/theme.tsx:277`）。對 27k 行、頻繁改版的程式碼，這是相當克制的數字。

**死碼（確認清單）：**
- `component/dialog-tag.tsx`（47 行）——全樹零匯入。
- `component/prompt/cwd.ts`（**0 行**，空檔）——零匯入。
- `routes/session/dialog-subagent.tsx`（26 行）——零匯入。
- `component/prompt/history.tsx`、`component/prompt/frecency.tsx`（各 1 行 re-export）——零匯入、也不在 `package.json:12-49` 的 exports 內。
- `context/sync.tsx:584-593` 的 `session.status()`——零消費者。
- `routes/session/index.tsx:1707` 遺留註解「Pending messages moved to individual tool pending functions」。
- `context/data.tsx` 的三個空 case（`:165-166, 376-379`）——事件被明確丟棄（`session.next.prompt.admitted`、`retried`、`compaction.*`），等於那些狀態在 v2 模型裡不存在。

**註解掉的程式碼與不可達分支：幾乎沒有。** 全 src 掃「`//` 開頭且後面接程式碼」只命中 1 處，且那是說明文字（`component/prompt/index.tsx:471`）。`<Match when={true}>` 當 default 分支是慣用法而非不可達碼（`routes/session/index.tsx:1677, 1783`、`feature-plugins/home/footer.tsx:42`）。真正的「被丟棄狀態」是 `context/data.tsx` 的三個空 case（見上）。這是一包**沒有大量死註解**的樹。

**重複：**
- **最明顯**：`context/sync.tsx` vs `context/data.tsx`（兩套訊息模型，見 2.2）。
- **命令表重複三處**：`app.tsx:559-1079`（appCommands）、`component/prompt/index.tsx:335-635`（promptCommands）、`:736-794`（stashCommands）——同一個 `{name,title,category,run}` 形狀在不同檔案各寫一遍。
- **持久化樣板重複 6 次**：「readJson → ready signal → pending 補寫 → writeJsonAtomic」的舞蹈在 `context/kv.tsx:20-31,54-62`、`context/local.tsx:169-195`、`:425-450`、`prompt/history.tsx:54-61`、`prompt/stash.tsx`、`prompt/frecency.tsx` 各寫一次，細節還不同（kv 用 flock，local 不用）。`util/persistence.ts:22-33` 只共用最底層的原子寫入。
- **1 行的 re-export shim，其中兩個已無用**：`component/prompt/{frecency,history,stash}.tsx` 各只有一行 `export * from "../../prompt/..."`（例：`component/prompt/history.tsx:1`）。它們**不在 `package.json` 的 `exports` 裡**（`package.json:12-49` 無 `component/prompt`），樹內也只有 `component/dialog-stash.tsx:6` 用了其中一個（`./prompt/stash`）。所以 `component/prompt/history.tsx` 與 `component/prompt/frecency.tsx` 是**零匯入的殘骸**，第三個也只是多繞一層。

---

## 三、值得偷的模式（依可移植性排序）

評分方式：**portable** = 概念與程式骨架都能搬；**needs rework** = 概念好但綁定 OpenTUI/SolidJS 或 server 語意，需重寫；**not portable** = 只能當靈感。

| # | 模式 | 是什麼 / 證據 | 與 opencode server 語意的糾纏 | 移植成本 |
|---|---|---|---|---|
| 1 | **宣告式 keybind 註冊表 + mode stack** | 471 行的中央表：每個命令一列 `keybind(default, description)`（`config/keybind.ts:36-44, 46-240`），用 `effect` Schema 生成設定驗證與說明（`:245-255`），再映射到 namespaced command id（`:256+`）。執行期是 `@opentui/keymap` 的 layer/mode stack：`keymap.tsx:53-100` 的 push/pop 模式堆疊，`:214-244` 的 addon 註冊。 | **不糾纏**。它只認識命令名稱，不認識 session/message。 | **needs rework**。骨架可照搬（表 + schema + mode stack），但 `@opentui/keymap` 的 layer/binding 引擎要自己寫或找替代。我們若已有 keymap，值得對照的是「**每個綁定都必須有 description 與 category**」這條紀律。 |
| 2 | **which-key 由 live keymap 反射** | `feature-plugins/system/which-key.tsx:194-195` 用 `useKeymapSelector` 讀 `getPendingSequence()` / `getActiveKeys()`；面板內容、分組、快捷鍵標籤全部現算（`:114-160, 221-266`），不是手維護的說明表。 | 不糾纏。 | **needs rework**，但**這是全套件最值得學的一件事**：只要 keymap 有 introspection（列出「當前模式下可達的命令」），which-key/help/命令面板就能免費同步，永遠不會與實際綁定脫節。我們要做的是先給 keymap 加 introspection API。 |
| 3 | **Dialog stack** | 231 行：`stack` 陣列 + `replace/clear`（`ui/dialog.tsx:139-175`）、esc/ctrl+c 彈棧（`:105-137`）、開啟時 `modeStack.push("modal")` 讓底層快捷鍵失效（`:81-85`）、記住並恢復焦點（`:87-103`）。 | **不糾纏**。 | **portable**（低）。是純 UI 狀態機，抄結構即可，不需要 OpenTUI。 |
| 4 | **泛型清單選擇器 DialogSelect** | 791 行、**23 個消費者**（`ui/dialog-select.tsx`；消費者如 `component/dialog-session-list.tsx:273`、`component/dialog-model.tsx`、`feature-plugins/system/plugins.tsx`）。提供：fuzzy filter（`:165-172`）、category 分組（`:186-195`）、actions/footerHints 綁定（`:120-140`）、keyboard/mouse 模式切換與「合成 mousemove」防護（`:175-182`）、`current` 定位（`:101-114`）。 | 不糾纏。 | **portable**（中）。成本在於把 props 契約（`:23-79`）想清楚；一次投入換 23 處複用，是本套件投資報酬率最高的抽象。 |
| 5 | **Plugin slot 系統 + 自家功能 dogfood** | `plugin/slots.tsx:25-65` 包 `@opentui/solid` 的 slot registry；12 個內建功能**全部**以 plugin 形式註冊（`feature-plugins/builtins.ts:21-36`），例如 sidebar todo 就是一個 `order: 400` 的 slot（`feature-plugins/sidebar/todo.tsx:33-42`）。slot 有 `mode: replace / single_winner`（`routes/home.tsx:76-91`）與 `order` 排序。 | 不糾纏；plugin 透過 `stateApi` 唯讀 facade 取得資料（`plugin/adapters.tsx:98-163`）。 | **needs rework**（中高）。概念可搬，registry 要自寫。**真正的價值是「自家功能也用同一條縫」**——它保證了這條縫不會腐化。 |
| 6 | **事件合批（16ms 合流）** | `context/sdk.tsx:54-80`：事件先入 queue，距上次 flush <16ms 就延到下一幀，用 `batch()` 一次送出所有 store 更新，避免 N 個事件觸發 N 次 render。SSE 斷線用指數退避重連（`:112-114`）。 | 不糾纏。 | **portable**（低）。我們的事件流同樣高頻，這個模式幾乎可以直接對應。 |
| 7 | **hydration 競態追蹤器** | `context/sync.tsx:150-158` 的 `hydratingSessions: Map<sessionID, {messages:Set, parts:Set}>`，同步期間標記 live 已到達的 id（`:153-158`），同步回來時用 live 版取代快照版並保留順序（`:614-654`）。配套測試 `sync-live-hydration.test.tsx:59-109`。 | 糾纏於 message/part 模型，但**模式本身與模型無關**：任何「訂閱即時流 + 週期性拉快照」的系統都需要這個。 | **portable**（中）。要重寫成我們的 event id 體系，但邏輯可以照抄。 |
| 8 | **Attention / 通知子系統** | `attention.ts:114+`：依 focus 狀態（focused/blurred/unknown）、`when` 條件、音量夾限決定要不要響鈴/發通知，回傳 `skipped` 原因（`:60-67, 107-112`）；音效包可註冊（`:91-105`）。可注入 audio（`:118`）所以可測。消費者在 `feature-plugins/system/notifications.ts:35-70`。 | 不糾纏。 | **portable**（中低）。我們已有權限/提問中斷，這個「打擾使用者的決策表」值得照抄。 |
| 9 | **嚴格測試替身** | `test/fixture/tui-sdk.ts:106`：`createFetch` 遇到未預期路徑**直接 throw**，不靜默回空物件；`createEventSource()`（`:18-60`）可注入事件並支援 SSE 串流。 | 不糾纏。 | **portable**（低）。與我們的 PTY harness 互補：我們測「真的畫出來什麼」，它測「真的送了什麼請求」。 |
| 10 | **JSONL 追加日誌 + 自我修復重寫** | `prompt/history.tsx:54-61` 啟動時解析 JSONL、過濾壞行、把合法內容重寫回檔；`:85-108` 平時只 append，超過上限才重寫。 | 不糾纏。 | **portable**（低）。比「每次全量重寫 JSON」便宜，也比「純 append 不管腐化」誠實。 |
| 11 | **Theme 系統** | `theme/index.ts`：33 個 JSON 主題（`src/theme/assets/`）、light/dark 雙模式解析（`:241+`）、ANSI 16 色轉 RGBA（`:301`）、plugin 可註冊主題（`:205-240`）。 | 不糾纏。 | **needs rework**（中）。我們的 tui-core 有自己的顏色模型，主題 JSON 格式可參考但不必照抄。 |

**不在清單上的（被點名但其實不存在）**：**i18n 分層沒有**。`util/locale.ts` 只有時間/數字/截斷格式化（86 行，`:1-85`），全樹沒有一個翻譯表；字串是硬寫的英文（例：`component/error-component.tsx:111` "opencode crashed"、`ui/dialog-select.tsx:605` "No results found"），連 `Intl.NumberFormat` 都寫死 `"en-US"`（`component/prompt/index.tsx:99`）。想「偷 i18n 分層」的人會撲空。**viewport culling 也沒有**（見 2.3）。

---

## 四、陷阱（看起來好、搬了會欠債）

1. **`context/data.tsx` 的雙 store 架構——絕對不要模仿。**
   它是 v1→v2 遷移的半成品：569 行、31 個 case、只服務一個消費者（`component/prompt/autocomplete.tsx:90`）。搬它等於同時搬進「兩套訊息模型、兩種事件命名、一個 `event as V2Event` 的型別橋」（`context/data.tsx:405-414`）。**若我們要在 IH 做多版本事件模型，正確做法是 adapter 在邊界轉譯一次，而不是讓兩個 store 在樹裡並存。**

2. **`alwaysSeparate` 這種 module-global WeakSet 側通道。**
   `routes/session/index.tsx:94` 的 `WeakSet<BoxRenderable>` 由各元件的 ref callback 寫入（`:1399, 1535, 1550, 1617, 1691, 2007`），再由 `InlineToolRow` 的 layout callback 讀取來決定 margin（`:1939-1946`）。它「看起來」解決了「工具列之間要不要空行」的問題，代價是：**渲染結果依賴 renderable 的建立順序與歷史**，任何重排都可能讓版面跳動；而且這個知識散在 7 個地方。這正是 `util/layout.ts` 這種 pre-layout hack 的典型債。

3. **per-tool `<Switch>` 當作渲染分派。**
   `routes/session/index.tsx:1740-1786` 是 15 分支的硬開關，且 plugin slot 沒有 tool render 槽。**優點是簡單；缺點是每個新工具都要改核心檔**，且第三方無法擴充。我們自己的 `packages/tui/src/tool-presentation/` 走的是相反路線（資料化的 `presentTool` + family formatter，`packages/tui/src/tool-presentation/index.ts:1-23`）——**不要為了「跟 opencode 一致」而退回去**。

4. **用「100 則硬上限」當效能策略。**
   `context/sync.tsx:341-358, 603, 625-627`。它讓「不虛擬化」變得可行，但代價是**使用者看不到 100 則以前的對話，而且沒有任何提示**；複製/匯出/timeline 也一起被截斷（`routes/session/dialog-timeline.tsx:23`、`routes/session/index.tsx:928, 972`）。如果我們抄了它的列表實作，就會連這個無聲截斷一起抄進來。

5. **`getFirstValidModel` 式的靜默 fallback。**
   `context/local.tsx:224-244`：使用者沒選模型時，依序退回 config → recent → `provider[0]` 的第一個模型。UI 顯示的「當前模型」可能是使用者從未選擇、甚至不知道存在的模型。**這種 fallback 對 agent 工具是危險的**（它會用一個意外的模型花錢）。

6. **手抄鏡像的測試。**
   `test/cli/tui/prompt-submit-race.test.ts:52-68`。它測的是複製品，不是生產碼。**這類測試會給人「這個 race 有覆蓋」的錯覺**，實際上生產碼回歸時它仍然全綠。

7. **`catch(() => {})` 用在串流與持久化。**
   `context/sdk.tsx:116` 吞掉整條 SSE 迴圈的例外；`prompt/history.tsx:107` 吞掉寫入失敗。前者會讓「連線壞了」表現成「安靜地不再更新」；後者會讓「歷史沒存到」表現成「重開之後歷史不見了」而沒有任何痕跡。

8. **1 行 re-export shim 當相容層。**
   `component/prompt/{frecency,history,stash}.tsx`（各 1 行，`component/prompt/history.tsx:1`）。它們既不在 `package.json:12-49` 的 exports 裡，樹內也只有 `component/dialog-stash.tsx:6` 用到其中一個——換句話說，這是**沒有消費者、也沒有對外承諾的相容層**。讀者會在 `component/prompt/` 與 `prompt/` 之間迷路，卻得不到任何好處。若我們需要相容層，應該在檔頭標明 deprecated 與移除版本。

9. **把 UI 文案放進資料欄位。**
   `context/local.tsx:258-265` 回傳 `{provider: "Connect a provider", model: "No provider selected"}`。型別上它是 `string`，語意上它是錯誤狀態。後續任何「這個 model id 有效嗎」的判斷都會被它騙。

---

## 五、對我們的具體含義（`packages/tui` + `packages/tui-core`）

**先講不可比的部分**：opencode TUI 是 SolidJS + OpenTUI 的**全螢幕應用**，資料來自 HTTP/SSE server；我們是 `tui-core` 手寫 cell renderer + `packages/tui` 走終端機 scrollback（`packages/tui/src/scrollback/engine.ts`）與自家 runtime（`packages/tui/package.json` 依賴 `@i-harness/session-executor` 等）。**元件層幾乎無法直接搬**（與 `2026-09-09-opencode-tui-graft-feasibility.md` 的結論一致）。能搬的是**設計與紀律**。

**我們已經比它好的地方（不要被「屎山」說法誤導而丟掉自信）：**
- **工具呈現是資料，不是元件**。我們的 `tool-presentation/format.ts` 產出 `ToolPresentation`（`packages/tui/src/tool-presentation/index.ts:9-23`），可測、可 redact（`redact.ts` 的 `SECRET_KEYS`）；opencode 是 15 分支 JSX（`routes/session/index.tsx:1740-1786`）。**這條路線是對的。**
- **測試量**：我們 tui 24,693 行 + tui-core 2,811 行測試（共約 27.5k），對比它 4,597 行。它的測試選題精準，但**廣度遠不及我們**。
- **沒有雙 store、沒有 100 則硬截斷、沒有 module-global renderable 側通道**。

**它比我們好的地方（值得排進 backlog）：**
1. **Keymap 的 introspection + which-key**（`feature-plugins/system/which-key.tsx:194-195`）。如果我們的 keymap 能回答「當前模式下哪些命令可達、綁定是什麼」，which-key/help/命令面板就都能自動生成。**這是投報率最高的一項**，且與我們的 cell renderer 無關。
2. **命令表的集中宣告**（`config/keybind.ts:46-240`）：每個命令強制有 default + description + category，Schema 生成驗證。我們的命令散在 `packages/tui/src/app/slash/impl/` 與各 view；值得建立一張中央表。
3. **Dialog/modal stack 的語意**（`ui/dialog.tsx:69-176`）：esc 彈棧、modal 期間底層快捷鍵失效、焦點恢復。我們有 `views/modal.ts`，值得對照這三條語意是否都具備。
4. **泛型清單選擇器**：我們有 12 個 `light-*.ts` 面板與 `model-picker.ts`、`completion-dropdown.ts`——若它們各自實作 filter/選取/分組，`DialogSelect` 的契約（`ui/dialog-select.tsx:23-79`）是很好的收斂目標。
5. **事件合批 + hydration 競態追蹤**（`context/sdk.tsx:54-80`、`context/sync.tsx:150-158`）：我們的 backend 是事件流（`packages/tui/src/backend/`），「live 事件 vs 快照」的競爭一定存在，這個模式值得直接對照我們的 `dashboard-state.ts` / `history-panel.ts`。
6. **嚴格測試替身會 throw**（`test/fixture/tui-sdk.ts:106`）：我們有 PTY harness 測渲染，但 protocol 層的替身是否也「未預期就失敗」值得檢查。

**具體建議（依序）：**
- **做**：給 keymap 加 introspection API，然後用資料驅動產生 which-key/help（#1、#2）。
- **做**：把我們的 modal/dialog 語意與 `ui/dialog.tsx` 逐條對齊（#3）。
- **評估**：抽出共用的 list-picker（#4），先盤點 12 個 light 面板有多少重複。
- **借鏡**：事件合批與 hydration tracker（#5），寫成我們的 backend 測試案例。
- **不要做**：照抄 per-tool Switch、100 則上限、`alwaysSeparate` 式全域側通道、手抄鏡像測試。

---

## 六、不確定處

1. **OpenTUI 是否在 renderable 層做了 viewport culling，我無法驗證。** 樹裡沒有 `node_modules`，`@opentui/*` 不在本 repo（`package.json:55-57` 用 `catalog:` 指向 opencode monorepo 的 catalog）。所以「沒有虛擬化」這句，我只能擔保**應用層沒有**；若 `ScrollBoxRenderable` 內部只渲染可見子節點，那 `routes/session/index.tsx:1199` 的 `<For>` 成本會小很多。**這需要實際跑一次或讀 OpenTUI 原始碼才能定論。**
2. **沒有量測任何效能數字。** 16ms 合批、100 則上限、`reconcile` 的成本、binary search 插入的實際收益，全是讀碼推論。要下「這個設計好/不好」的效能結論需要 benchmark。
3. **這是單一時點的 snapshot，看不出遷移方向。** `data.tsx` 可能是「即將被刪」也可能是「即將取代 sync.tsx」。從「只有一個消費者」推斷它是死路，有可能誤判；若 upstream 正在把 UI 遷到 v2，那這 569 行是投資而非債。
4. **死碼判定基於樹內 grep。** `dialog-tag.tsx`、`dialog-subagent.tsx`、`prompt/cwd.ts` 在**本樹內**零匯入，但 `package.json:12-49` 的 `exports` 讓部分路徑（如 `./ui/dialog`、`./plugin/slots`）成為對外 API，外部 repo 可能使用未列在 exports 的深路徑。**未查證外部消費者。**
5. **沒跑測試。** 「4,597 行測試」是靜態計數，我無法確認它全綠、是否有 flaky（`sync-live-hydration` 這類競態測試特別容易 flaky）。
6. **`session.status()` 零消費者**是基於 `session.status()` 的精確 grep；若有人以 `const s = sync.session; s.status(id)` 這種解構方式呼叫，會漏檢。我認為機率低，但不能排除。
7. **`util/error.ts:39` 的 `JSON(C)`**：可能是 typo，也可能是刻意的提示（例如指向某個 `JSON(C)` 格式）。我沒有上下文可以確定。
