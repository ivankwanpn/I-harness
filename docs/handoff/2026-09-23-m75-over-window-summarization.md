# M75（超窗的摘要化要有路）交付紀錄

**一句話**：M74 量到的那個 regime——**surface 超過窗口時「壓縮」其實是 reset**（摘要器自己的請求也超窗 ⇒ provider 拒收 ⇒ fail-soft ⇒ 階梯第 2 層把繼承來的 context 丟掉）——本階段給它一條路：**單一請求放不下時，把區域切成幾塊、串連地摘要**，於是摘要真的發生。

- **分支**：`m75`（`2fb2cc17` → `f79132bd`，**7 個 commit**；合併尚未進行）
- **spec（權威）**：`docs/superpowers/specs/2026-09-23-over-window-summarization-design.md`（`0438b933`；執行期新增 §2.1 的兩半釘法、§4 兩條、§5 兩條）
- **計畫**：`docs/superpowers/plans/2026-09-23-over-window-summarization.md`（同一 commit）
- **執行**：subagent-driven development——4 個任務 → 逐任務複審 → **Task 1 三次 fix round** → 終審（opus，7 commits）→ **單一 fix wave** → 限定複審 → 控制器寫紀錄

---

## 1. 閘門與算術

**`pnpm verify:all` 在最終樹上 PASSED**（單獨執行，無並行 subagent）：

| 步驟 | 讀數 |
|---|---|
| suite | exit 0 · **3074 passed｜9 skipped｜0 failed** |
| population | **67 of 67** |
| typecheck | exit 0 |
| e2e | exit 0 · 5 檔 |
| reachability | exit 0 · **433 列** · `gate PASS -- no new rows` |

**算術**：M74 終態 **3056** ＋ **18** 個新案例 ＝ **3074**（Task 1 的 9 條 ＋ Task 2 的 3 條 ＋ Task 3 的 5 條 ＋ fix wave 的 1 條子代理案例；`git diff` 數新 `it(` 得 17，fix wave 再加 1）。中途讀數 3073 是 fix wave 之前。

**reachability 與 M74 相同（433 列）**：本階段的兩個新匯出——`sliceRegion`（`compaction/src/slices.ts`）與 `walkOffToolEvents`（`compaction/src/region.ts`）——都**只在套件內被消費**、都沒有從 `index.ts` 再匯出 ⇒ 沒有新增未消費的列，也不需要 allowlist（計畫的預測成立）。

---

## 2. 交付物

### 2.1 切塊器：`sliceRegion`（`packages/compaction/src/slices.ts`）

**它在 message space 裡走，這不是最初設計。** 三個支點，每一個都是**被量測逼出來的**：

1. **只在放不下時才切**：判準必須與夾取**用同一個算式**（`priceInput` 是那個算式的唯一所在，夾取與閘同時餵它）。計畫原本把判準放在 `compactOnce` 並只計價**區域**——那會留下一個帶狀區：區域放得下、**區域＋directive** 放不下，於是走單一那條、被 provider 拒收，**正是本階段要消滅的 regime**。
2. **切點是 `user` 訊息**（Shape B）：一塊必須是合法的獨立請求（provider 要求第一則訊息是 `user`）。事件層的規則量測兩次都不夠：先是 `tool/call` 上的切點做出**零 user 訊息**的塊（違反 spec §1.3），再是 `tool/dispatch` 讓走位提前停下、切點落在 `tool/result` 上（異常結束的 turn 尾巴，可達）。
3. **串連**：running text 只留在記憶體，pass 結束才附加**一個** `compaction/summary`，`shadowedSeqs` 是**整個區域**。

外加一個 spec 沒有、量測逼出來的守衛：**切點必須不留任何未解析的工具呼叫**（`outstanding` 集合）。M14 的工具結果圖片會把一則合成的 `user` 訊息塞進工具區塊**內部**，讓它成為切點 ⇒ 第二塊以孤兒 `tool` 開頭。守衛用**同一份 fold** 計算 ⇒ 不可能與投影漂移。

### 2.2 fallback 的閘與串連（`summarizer.ts`、`index.ts`）

`summarizeWithModel` 新增第 10 個可選參數 `region?: { session, shadowedSeqs }`（**生的、未切的**——切塊由摘要器自己做，因為判準與夾取必須在同一處）。閘要求**四樣同時在**：`region`、`prefix`、`maxOutputTokens`、`contextWindow`；缺一即回到今天那條路，**逐位元組相同**（既有 M5/D2 prefix 測試一行都沒動）。`minSummaryChars` 只在**最後一塊**強制；`attempts` 的語意改變在事件旁寫明。

### 2.3 五條完整性測試（`test/summarizer-prefix.test.ts`）

串連（request k 帶著 request k−1 的產物）、**一個**標記且 `shadowedSeqs` 是整個區域、**中途沒有標記**、中途失敗仍然原子（`reason: "summarizer-failed"`、log 不動）、以及**普通情況（閘開著且放得下）恰好一次呼叫**。後者是終審從 Task 2 的複審裡撿回來的：原本那條不帶 cap ⇒ 閘是**關**的，釘到的是「沒有 cap ⇒ 走今天」而不是判準。

---

## 3. ⚠️ 這一輪最重要的那條：計畫的五個字面值**任何實作都過不了**

M72／M73／M74 已經記過「計畫的字面變更預測錯了十幾次」。這一輪更進一步——**計畫的字面值有三個是算術上不可能的**：

| 計畫的字面 | 量到的 | 誰量到 |
|---|---|---|
| 判準＝`inputPrice(region) < contextWindow` | 夾價的是 `request.messages` = 區域 **＋ directive ＋ overhead** ⇒ 留下本階段要消滅的那個帶狀區 | Task 2 實作者（並由終審獨立複核） |
| 測試的 `contextWindow: 400` | **directive 自己就 449 token** ⇒ 沒有任何一塊能放得下（我的 pre-flight 檢查了「塊的訊息」卻忘了 directive ⇒ **控制器也錯了一次**） | Task 2 實作者 |
| 測試的探針文字（9–11 字元） | `minSummaryChars` 500 在**最後一塊**強制 ⇒ pass fail-soft（13 次呼叫、`below minSummaryChars (11 < 500)`、0 個事件） | Task 3 實作者 |
| 串連斷言假設 ≤ 3 塊 | 實際 **12 塊**（區域 2 142 token／預算 ~196） | 控制器 pre-flight 的算術 |
| 「拿掉閘 ⇒ 那條測試紅」 | 在 window 1e6 **不會**紅（預算還是只給一塊）——要第二個 hunk 才殺得掉；**實作者照規矩回報「突變殺不掉」而不是換測試** | Task 2 實作者 |

**⇒ 這一輪的紀律是：每一個字面值都先量，量不動就回報，不遷就。** 五次裡有兩次是控制器自己的判斷錯（pre-flight 的 window 400、Ruling 1 的斷言），都在複審裡被抓出來就地更正。

**而 Task 1 花了三次 fix round**（`4f0f3f0f` → `11a7e130` → `6c1ede6f` → `ea438a22`），每一次都是量測把上一個設計打掉：fold 在 rewrite 標記前後**不是單調的**（尾段會靜默丟掉一塊）⇒ 改成在單一 fold 上走；事件層走位被 `tool/dispatch` 打斷 ⇒ 整條事件層規則**刪掉**，改在 message space；M14 的合成 `user` 訊息 ⇒ 加上未解析呼叫守衛。**沒有一輪是「補丁」，每一輪都是被推翻的設計換成更強的設計。**

**一個既有的漏洞，本階段量到卻沒有修**（終審的讀數，具名為獨立單位）：`walkOffToolEvents` 在任何非工具事件上停下，而 `tool/dispatch` 永遠落在工具執行**裡面** ⇒ 兩個既有呼叫點（`region.ts:67`、`index.ts:344`）仍會孤兒化 `tool/result`。`call → result` 的日誌：63 個切點 8 個孤兒、走位後 **0**；`call → dispatch → result`（**M70 之後的實際順序**）：71 個裡 **16** 個、走位後**還是 16**。**M70 的 dispatch 標記讓這個守衛靜默失效，而它的註解還宣稱有效。** 詳見 spec §5。

---

## 4. 裁決（Rulings）— 逐條附代價

1. **Task 2 的「逐位元組不變」斷言改成 `messages.slice(0,-1)`**：計畫斷言 `messages` 等於 fold，但請求是 **fold ＋ directive**（`summarizer.ts:201`）⇒ 那條斷言在任何改動前就是紅的。代價：directive 本身的文字回歸不會被這條抓到（既有的 canon 比對蓋的是區域）。
2. **判準與切塊迴圈放進 `summarizeWithModel`**：夾取在那裡，算式就只能有一處。代價：摘要器那個函式比計畫畫的大。
3. **串連斷言一般化；串連的突變證明移到 Task 3**：計畫的索引假設 ≤ 3 塊，而實際 12 塊 ⇒ 正確的實作會被判紅。代價：串連規則有一個任務的窗口沒有突變證明（Task 3 補上）。
4. **`sliceRegion` 保持套件內部**：不新增 reachability 列。代價：若閘門仍報一列，那是發現不是 allowlist。
5. **`sequencedModel` 不用 `markerCounts`**：死腳手架。代價：無。
6. **切塊路徑只在「夾取被要求跑」時進入**（有 cap、有 window、有 prefix）：兩個既有 engine 級測試沒有 cap ⇒ 否則會變行為並轉紅，違反「零條既有斷言改動」。代價：沒有 cap 的 session 在超窗時不被救（記為殘餘）。
7. **Task 1 的檔案清單擴大到 `region.ts` 與 `index.ts`**（走位規則抽成一處）。代價：動了兩個不屬於它的檔案，`resetWindowOnce` 的切點走位要由複審確認行為不變。
8. **塊的單位是 turn**：spec §1.3（權威）要求切點落在 `user/message`／`turn/start`。代價：塊更粗。
9. **（已被 10 取代）fold 不連續時丟棄並重走**。代價：若 fold 因別的原因縮小就會靜默丟內容——第二壓縮測試是守衛。
10. **切塊在 message space、候選是 `user` 訊息、單一 fold、無重走邏輯**（R2／R3 作廢）：兩個開放項**由建構消失**。代價：粒度受 session 的 user 結構限制。
11. **切點必須不留未解析的呼叫**：M14 的合成 user 訊息會被拒。代價：塊可能更粗；比事件層規則更強。
12. **Task 2 缺的「普通情況」斷言指派給 Task 3**。代價：Task 3 的 diff 多一條計畫沒有的案例。
13. **沒有 diff 的任務不做任務複審**（Task 4 是量測）：閘門讀數由控制器自己驗算（17 條新 `it(`、0 條移除，3073 − 3056 = +17）＋ 終審複跑一次。代價：一個誤讀的閘門數字可能進紀錄；算術檢查只蓋住那個會被引用的數字。
14. **子代理那一半是「交付」而不是「縮小」**：spec §2.1 要求子代理與主要各一，計畫靜默地縮成主要 ⇒ 補上可切區域的子代理案例，**既有那條單一巨塊案例保持斷言 reset**（那是 §4.4 的殘餘）。代價：diff 多一個跨套件的整合測試。
15. **既有的走位漏洞是具名殘餘 ＋ 獨立後續單位，不在本分支修**：它屬於階梯第 2 層、程式碼與分支前逐字相同。代價：漏洞在後續單位落地前仍然活著——紀錄讓它可見而不是靜默。
16. **fallback 的惰性路線與它對估計的依賴寫進 spec §4／§5**。代價：若沒寫，讀者會以為覆蓋面比實際大。

---

## 5. 殘餘（本階段**不做**，逐條具名）

- **種子端的約束**（spec §5 第一條）：`spawnChild` 是唯一同時握有（種子，窗口）的地方，而窗口在種子被建出來時**不在 scope**（宣告角色的 binding 在 `await resolveModel` 之後）⇒ 要先重排 `resolveModel`，順帶關掉一個**真的洩漏**（`coordinator.create` 早於模型失敗 ⇒ 一次非 ready 留下**孤兒 `child-<uuid>` log**）。
- **既有的走位漏洞**（§3 末）：`selectShadowableRange`／`resetWindowOnce` 在 M70 之後仍會孤兒化 `tool/result`。修法＝把切塊器已經在用的 message-space 規則套過去。
- **fallback 的惰性路線**：配置 `summarizationModel`、沒有 `requestShape`、或綁定解析不出 cap（`apps/cli/src/run.ts:536`）⇒ 超窗時仍是 reset。
- **估計 vs 真實 tokenizer**：閘問的是 `estimateContent`（~4 字元／token）；CJK 為主的區域在真實 tokenizer 眼裡可以遠超窗口而估計說放得下。沿用 clamp。
- **粒度**：一個 user turn 的訊息不能再切；孤立超預算的塊仍走 fail-soft ⇒ reset。**這正是 M75 最初的 regime 的殘餘**，真正的解法是那一塊的來源（工具結果的上限）。
- **prune 在摘要之前**：prefix 路徑上 apply 過的 prune 替代品**不會縮小**摘要器的輸入（標記在摘要之後才附加，而 fold 是從 log 折的）⇒ 摘要器重讀未 prune 的工具輸出。
- **`rewind/point` 的 `anchorSeq`**（M74 的殘餘，未動）。
- **`attempts` 的語意改變**、**breaker 分不出「不穩」與「太大」**（spec §1.6）。

---

## 6. 給下一個動這條鏈的人

1. **先量再寫字面。** 這一輪計畫的五個字面值錯五個，其中三個**任何實作都過不了**（directive 449 token > window 400；探針文字短於品質門檻；判準漏了 directive）。計畫裡的每一個數字都要有 `path:line` 或一次執行。
2. **要動 `region.ts`／`resetWindowOnce` 的走位**，帶上 §3 的那張表（8/63→0 vs 16/71→16）：修法不是把 `tool/dispatch` 加進例外名單，而是用切塊器那條 message-space 規則，並配一條**掃描切點**的測試。
3. **要動切塊器**：它的不變式是「pieces 恰好鋪滿 `deriveMessagesUpTo(session, max(regionSeqs))`」，而 `slices.ts:41` 收 `shadowedSeqs` 後**自己再取一次 max**，`compactOnce` 為 prefix 也取一次——兩個「區域最後一個 seq」的家，值必須一致。收斂成傳 `lastRegionSeq` 是終審的建議，留給下一次動它的人。
4. **`2 800` 那個窗口的判別帶是 `[2 592, 3 025]`**（註解寫 2 591，實際在 2 591 上 `hardRoom = 0`、閘會開）——要動那條測試的人先看那個帶。
