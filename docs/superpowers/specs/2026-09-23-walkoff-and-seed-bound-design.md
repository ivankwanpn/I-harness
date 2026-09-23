# M76 — 走位守衛與種子邊界 Design

**一句話**：兩件都在同一條預算鏈上，而且都是**既有東西上**的洞——①**走位守衛在樹的實際日誌順序下是惰性的**（M70 的 `tool/dispatch` 讓它提前停下），於是兩個壓縮邊界站點仍會孤兒化 `tool/result`；②`spawnChild` **在模型能失敗之前**就建了 durable 子 session 與種子，所以一次非 ready 的解析留下**孤兒 `child-<uuid>` log**。

**來源**：M75 終審的走位量測（`docs/handoff/2026-09-23-m75-over-window-summarization.md` §3）＋ spec §5；M74 的殘餘（`anchorSeq`）；以及 2026-09-23 對 `child.ts` 的兩次複核。

**分級**：**L**。①動的是**每一個** session 在壓力下都會走的階梯第 2 層（`resetWindowOnce`）；②動的是 spawn 的順序（子代理的入口）。

---

## 0. 它讓什麼變得不一樣（全部有 `path:line`；量測與讀碼分開標示）

| 事實 | 讀數 |
|---|---|
| **`tool/dispatch` 是 call 與 result 之間的真事件** | `packages/core-session/src/index.ts:23`（`{ type: "tool/dispatch"; callId; eventSeq? }`） |
| **共用走位只認兩種 tool 事件** | `packages/compaction/src/region.ts:36`：`if (at.type !== "tool/call" && at.type !== "tool/result") break` ⇒ 撞到 `tool/dispatch` 就停 |
| **兩個站點都走它** | `region.ts:67`（`selectShadowableRange` 的 `retainTokens > 0` 臂）、`packages/compaction/src/index.ts:344`（`resetWindowOnce`） |
| **量到的後果**（M75 終審，fixture＝N 個 turn 各一次 read，順序 `turn/start, user, step/start, call, dispatch, result, assistant, step/end, turn/end`） | `call → result`：63 個切點 **8** 個孤兒、走位後 **0**；`call → dispatch → result`（**M70 之後的實際順序**）：71 個裡 **16** 個、走位後**還是 16** ⇒ **守衛在真實日誌上等於不存在** |
| **逐站點** | `resetWindowOnce`：`retainLast` 1..25 有 **6** 個值孤兒化（`[4,5,13,14,22,23]`）；`selectShadowableRange`：抽樣的 162 個預算裡 **48** 個 |
| **碼自己知道**（但只有一半） | `region.ts:23-26` 的 docstring **已經**寫明「事件層走位在切塊器那裡量到不夠，`tool/dispatch` 會提前結束它」；**但**兩個呼叫點的註解還宣稱它在工作——`index.ts:342-343`「measured, 4 of the first 25 values produce an orphaned result」**是 M70 之前的量測** |
| **種子側的順序** | `packages/subagent/src/child.ts:274` `coordinator.create(...)` → `:286` `createSession(...)` → `:289` 貼種子 → `:322` `await opts.resolveModel(declared)` → `:323-325` 非 ready 就 throw |
| **⇒ 一次非 ready 的解析留下什麼**（**讀碼，非執行期量測**） | 一個**已建立**的 durable 子 session（`sessionId = child-<uuid>`，`:272`）＋ 一整份已貼上的種子，而 `child.ts` 裡**沒有任何** dispose／discard／unlink 路徑（grep 只命中 `:285` 那個 `turn/end` flush 的 catch）。`:252-253` 的註解「a refused spawn leaves no child session behind」對它**前面**的那道閘（`:254-255`）為真、對這條路為假 |
| **`rewind/point` 的 `anchorSeq`** | `packages/session-persistence/src/fork.ts:170-180` 的 `remapSeedEvent` 重映射 `shadowedSeqs`／`removedSeqs`／`messageSeqs`，**然後在 `:179` 落回 `return { ...event, seq: index }`** ⇒ `anchorSeq` 從不重映射；**孿生的 session-fork 路徑靠「整條丟掉」來繞**（`subagent/src/fork.ts:16-29` 的契約註解自己說明並把決定延後） |
| **種子約束的價值在 M75 之後變小了**（**這是本階段必須先重新量的**） | M75 給了子代理**串連切塊的摘要**（`summarizeWithModel` 的 `region` 參數）⇒ **可切**的超窗種子今天已經會被摘要，不再是「交給它一個救不了的東西」。剩下真正沒被覆蓋的是：**(i)** 種子是一個**切不動的單一巨塊**（M75 §4.4 的殘餘）、**(ii)** 明知跑不動還跑一次的**浪費**、**(iii)** **可見性** |

**⇒ ①是無條件要修的（守衛今天等於不存在）。②的重排也是無條件的（它關掉孤兒 log）。而「種子要不要被約束」**要在 M76 的第一個任務裡先量**，因為 M75 已經把它的理由削弱了一次——不重新量就照著舊紀錄做，等於蓋一座已經不需要的橋。**

## 1. 設計

### 1.1 ①把啟發式走位換成精確規則

**判準（精確的那一條）**：一個切點 `j` 安全，**若且唯若**：對所有 index ≥ `j` 的事件，凡它是 `tool/result`，它的 `tool/call` 也必須在 index ≥ `j`。走位保持**向後**（多保留、不少保留，與今天同方向），直到落在安全點上。

- **為什麼是「看 result 側」而不是「看有沒有開著的 call」**：**沒有任何向後的切點能修好一個懸空的 call**——向後退只會**多保留**，懸空的 `tool_use` 仍然留在保留的那一側。**它在本樹的投影裡是存在的**：`deriveMessages` 在 log 尾與每個非延遲的 user／assistant 訊息都會 flush（`core-session/src/index.ts:597`、`:611-615`），所以一個從未解析的 `tool/call` 投影成 `assistant("", toolCalls)`——**本樹自己的測試釘住這件事**（`packages/core-session/test/session.test.ts:24-27`，反向由 `packages/compaction/test/engine.test.ts:329` 釘住）。⇒ 用 call 側（或雙側）當判準，一個中止過的 session 會讓**每一個**切點都不安全 ⇒ 走位一路退到 0 ⇒ `resetWindowOnce` 永遠 `removedSeqs` 為空 ⇒ **階梯退化成 fail-closed**，而懸空的 call **仍然**留著。
  - **執行期更正（Task 1 的複審推翻了我原本寫在這裡的理由）**：原文說「未解析的 call 不進投影、`deriveMessages` 把它丟掉」——**那是假的**，而且假的方向剛好相反（它會投影，而且懸空）。**規則本身不變，理由是上面這條更強的那一條。** 這一節的第一版與這一段是同一個紀錄的兩個狀態，保留更正痕跡而不是改寫歷史。
  - **而它有一個具名的盲點**：走位可以**停在**一個未解析的 `tool/call` 上（沒有 result 約束它）⇒ 保留的尾巴可以以一個沒有 result 回答的 `tool_use` 開頭。**這是殘餘，不是已解的情形**（同一類危險的另一面，`engine.test.ts:329` 的 oracle 已經命名它）。
- 保留「退到 0 就停」的界（與今天同）；判準不需要 `tool/dispatch` 的名字——它落在「index ≥ j 的 result」的條件裡自然被覆蓋（那是它比指名豁免強的地方）。
- 兩個呼叫點的**呼叫方式不變**（同一個函式、同一個方向）；改變的是判準的**定義**。
- 註解：把 `index.ts:342-343` 的過期讀數換成新的（兩張順序的數字），並在 `region.ts` 的 docstring 補上「它現在是精確規則，不再是啟發式」。

### 1.2 ②把 `resolveModel` 挪到種子之前

順序改成：**spawn 的閘（`:254-255`）→ `resolveModel` → `coordinator.create` → `createSession` → 貼種子**。三個後果，都要在測試裡看得見：

1. 一次非 ready 的解析**在建立任何 durable 東西之前**就 throw ⇒ 沒有孤兒 `child-<uuid>` log、沒有表項、沒有 job（`:252-253` 那句話在這條路上**變成真的**）。
2. 窗口與 cap **在種子被建出來的那一刻就在 scope 裡** ⇒ 1.3 才有可能。
3. 宣告角色的 binding 解析失敗時，`declareRole`／telemetry 的既有行為不變（它本來就在 throw 之後的碼裡）。

### 1.3 ②種子端的約束：**只警告（(c)），而且在量的條件上警告**——(a) 與 (b) 都被理由否決

**裁決（2026-09-23，控制器；使用者授權依設計合理性與使用者角度自行判斷）：不做修剪、不做 fail-closed。** 理由不是難度：

- **(b) fail-closed 是錯的**：從一個大 session 生一個子代理正是這個功能的**主要用例**（「看這個 200k token 的 codebase」）。拒絕 spawn 會把主用例關掉。
- **(a) 修剪是錯的，而且錯得比原本想的更清楚**：**M75 之後，切得動的超窗種子會被子代理自己串連摘要**（`summarizeWithModel` 的 `region`）——也就是說**它保留資訊**，而修剪**丟掉資訊**。「把摘要器本來會壓縮的內容直接刪掉」是**嚴格更差**，而且刪得**無聲**（子代理不知道、使用者不知道）。**這推翻了我先前的傾向 (a)**：那個傾向寫在 M75 之前，M75 自己把它變成錯的。
- **(c) 才是對的**：先前的行為不變（子代理自己處理），差別只在**讓它可見**。

**而警告必須落在量出來的條件上，否則它會變成噪音**：只有當**種子的投影價格本身 ≥ 視窗**時才 warn（那正是子代理**必須**先摘要一輪的情形）。訊息要說出後果（「子代理會先把繼承來的 context 摘要成幾塊；若那是一整塊不可切，這一輪會 fail-soft」），並在該 task 裡量出這個條件在真實 fixture 上的觸發情形。**一行 warn，不是一套策略。**

**切不動的單一巨塊**（M75 §4.4）：落在同一個 warn 的涵蓋範圍裡（warn ＋ 繼續）——切塊器救不了它，修剪也救不了（沒有東西可以剪），真正的解法在**它的來源**（工具結果的上限），那是具名的殘餘。

### 1.4 ②`anchorSeq`：**重映射**，與 `shadowedSeqs` 同一條路

`remapSeedEvent` 對 `shadowedSeqs`／`removedSeqs` 用的是「把父的 seq 映射到子 log 裡同一個事件的 index」；`anchorSeq` 是**同一種引用**（它指名一個 seq），所以**用同一條路重映射**，而不是像 session-fork 那樣整條丟掉。理由：`rewind/point` 的語意是「隱藏 anchor..seq 這段」——重映射兩個端點**保住語意**；丟掉則讓那段內容在子代理眼裡**重新出現**（M74 記的方向是「少藏」，比無聲丟內容輕，但仍是錯的）。**保持契約不變**（`subagent/src/fork.ts:16-29` 的註解要一起更正）。

## 2. 驗收（每一條都要**紅先 ＋ 變異證明**）

1. **①掃描所有切點**：一個 `call → dispatch → result` 形狀的 fixture 上，對**每一個** index 呼叫走位，斷言**沒有任何**保留尾巴以孤兒 `tool/result` 開頭。紅先＝把判準換回舊的（只認兩種 tool 事件）⇒ 這條紅。
2. **①兩個站點各自的讀數**：`resetWindowOnce` 的 `retainLast` 1..25 全部無孤兒（今天有 6 個值會孤兒化）；`selectShadowableRange` 在抽樣預算上無孤兒。**要記錄實測的孤兒數（今天 vs 之後）**。
3. **①不回歸**：兩個站點的**既有測試全綠**，且**中止的 turn**（一個永不解析的 call）**不會**讓走位退到 0——這一條要有自己的測試（它是 1.1 的殺手條款）。
   - **執行期更正（Task 1 量到，原文寫「逐位元組不變」是錯的）**：在 **pre-M70 形狀**（`call → result`，沒有 dispatch）上，精確規則取的是**最大的安全切點**，而舊啟發式會多走一步 ⇒ **新規則的切點可能落在舊的後一個事件**（保留**較少**、但兩者都無孤兒）。這是**更貼近呼叫端意圖**的方向（`retainLast` 說的是「保留最後 N 個」，舊行為是**多保留**），而兩個站點的既有測試都不釘死那個 index ⇒ 全綠。**所以不變的是性質（無孤兒、既有測試），不是那個數字。**
4. **②孤兒 log**：一次 `resolveModel` 非 ready 的 spawn ⇒ 斷言 **durable 側沒有任何新 session**（紅先＝把順序改回去 ⇒ 這條紅）。同時斷言既有的失敗形狀（錯誤訊息）不變。
5. **③`anchorSeq`**：一個帶 `rewind/point` 的種子經過 `forkTurns` ⇒ 斷言 `anchorSeq` 落在**子 log 的正確 index 上**（且 `shadowedSeqs` 的既有斷言不變）。
6. **②種子端的可視性**：warn **只在量出的條件上**觸發（種子的投影價格 ≥ 視窗）——**兩邊都要有測試**（觸發一次、不觸發一次），否則一個永遠 warn 或永遠不 warn 的實作都會綠。
7. `pnpm verify:all` 五步全綠、`--gate` 不新增 row。**既有斷言預期零條改動**（若紅，回報）。

## 3. 刻意不做（YAGNI）

- **不把兩個站點改寫成 message space**：判準精確化就夠了，重寫要動兩個呼叫端對 seq 的假設。
- **不做 batch-level checkpoint**（那是 M78 的成本項）。
- **不改 `forkTurns` 的預設**（產品決定，`m27` 的殘餘）。
- **不搬既有孤兒 log**：沒有遷移路徑是既成事實，具名為殘餘。
- **不動 M75 的切塊器**：它的 message-space 守衛（未解析呼叫）與本階段的 result 側判準是**兩個空間的同一個性質**，但切塊器不需要改。

## 4. 它不保證什麼（明說）

1. **不保證孤兒在別的地方不會出現**：本階段只修**這兩個**切點（`selectShadowableRange` 與 `resetWindowOnce`）。其他以 seq 為單位的切法（若未來新增）仍要自己守。
2. **不保證被修剪的種子「知道」自己被剪過**（若選 (a)）——除非標記寫得出來，子代理會以為自己看到的是全部。這一條要具名。
3. **不保證孤兒 log 會被清掉**（只保證**新的**不再產生）。

## 5. 殘餘（寫出來，不是藏起來）

- **既有的孤兒 `child-<uuid>` log 沒有遷移路徑**（M74 的殘餘延伸）。
- **只有「解析器」那條路被關掉了——它之後的 throw 仍然會孤兒化**（終審的讀數，本階段**不改碼**）：`resolveRoleTools`（`child.ts:408-411`）跑在 `coordinator.create` **之後**，而 `child.register` 在工具名重複時會 throw（`core-tools/src/index.ts:259`）⇒ 一個宣告 `tools: ["read","read"]` 的角色仍會留下孤兒 log；`createAgent`／`jobs.registerJob` 的 throw 同理。**這早於本階段**（那個工具區塊本來就在種子臂下面），但 §1.2 的註解讀起來像「失敗的 spawn 不留東西」⇒ 具名在此。
- **切不動的單一巨塊**（M75 §4.4）：種子側只到「warn ＋ 繼續」。
- **`tool/dispatch` 的 `eventSeq`**：讀碼時看到它存在（`core-session:23`），本階段**不動**它，也不假設它的語意。
- **`forkTurns` 的預設 `"all"`**：產品決定。
- **M75 §5 的其餘殘餘**（prune／`attempts`／breaker／惰性路線）不在本單位。
- **`NaN` 被當成數字**（終審的 out-of-scope 註記）：`typeof NaN === "number"` ⇒ 一個 `NaN` 的 anchor 仍會被鑄成 0。JSON 帶不了 `NaN`，且此行為**早於本階段**。

## 6. 取樣與自創

| 部分 | 來源 |
|---|---|
| 「看 result 側」的判準 | **本輪的推理 ＋ 投影的實際行為**（未 flush 的 pending call 不進投影；M75 的 message-space 守衛是同一性質的另一個空間） |
| 兩個站點的孤兒數 | **M75 終審的量測**（8/63→0、16/71→16、6 of 25、48 of 162） |
| 「先量再決定」的種子約束 | **本輪的判斷**：M75 已把它的理由削弱一次（串連摘要現在涵蓋可切的超窗種子）⇒ 不重新量就是蓋一座不需要的橋 |
| `anchorSeq` 選重映射 | **與 `shadowedSeqs` 同一條引用、同一條路**；session-fork 的「丟掉」是孿生路徑的既有不一致（M74 具名） |
| 三個種子選項與代價 | **自創**（產品決定，控制器不替使用者拍） |
