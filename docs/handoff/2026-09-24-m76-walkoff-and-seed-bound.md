# M76（走位守衛與種子邊界）交付紀錄

**一句話**：兩件都在同一條預算鏈上、都是**既有東西上**的洞——①**走位守衛在樹的實際日誌順序下是惰性的**（M70 的 `tool/dispatch` 讓它提前停下，而它的註解還宣稱它在工作）⇒ 兩個壓縮邊界站點仍會孤兒化 `tool/result`；②`spawnChild` 在模型能失敗**之前**就建了 durable 子 session 與種子 ⇒ 一次非 ready 的解析留下**孤兒 `child-<uuid>` log**；外加③`rewind/point` 的 `anchorSeq` 從未被重映射。

- **分支**：`m76`（from `main` `5b892ccc`）。**執行段**：`0d0c8431`（spec＋計畫）＋ `590b2c6f`..`52c0c2ac`（三個任務＋Task 1 一輪 fix round、Task 2 兩輪、單一 fix wave）。合併尚未進行。
- **spec（權威）**：`docs/superpowers/specs/2026-09-23-walkoff-and-seed-bound-design.md`
- **計畫**：`docs/superpowers/plans/2026-09-23-walkoff-and-seed-bound.md`
- **執行**：subagent-driven development——4 個任務 → 逐任務複審 → Task 1 一輪、Task 2 兩輪 fix round → **終審（opus）** → **單一 fix wave** → 限定複審
- **它屬於**：`docs/handoff/2026-09-23-backend-closure-plan.md` 的 **M76／M76–M80**（那張表是進度）

---

## 1. 閘門與算術

**`pnpm verify:all` 在最終樹上 PASSED**（單獨執行）：

| 步驟 | 讀數 |
|---|---|
| suite | exit 0 · **3083 passed｜9 skipped｜0 failed** |
| population | **67 of 67** |
| typecheck | exit 0 |
| e2e | exit 0 · 5 檔 |
| reachability | exit 0 · **433 列** · `gate PASS -- no new rows` |

**算術**：M75 終態 **3074** ＋ **9** ＝ **3083**：compaction 96→**99**（Task 1 的 2 ＋ fix wave 的極大性 1）、subagent 181→**185**（Task 2 的 3 ＋ Task 3 的 e2e 案例 1）、session-persistence 84→**86**（Task 3 的 1 ＋ fix wave 的畸形標記 1）。中途讀數 3081 是 fix wave 之前。

**reachability 與 M75 相同（433）**：本分支**沒有新增或移除任何 `export` 行**（`walkOffToolEvents` 早已存在、新的 helper 是模組私有、`remapSeedEvent` 早已匯出）⇒ 沒有新增未消費的列。

---

## 2. 交付物

### 2.1 ①走位判準變成**精確**的（`packages/compaction/src/region.ts`）

判準從「這個事件是不是 `tool/call`／`tool/result`」換成 **result 側**：切點 `j` 安全 **iff** 凡 index ≥ `j` 的 `tool/result`，它的 `tool/call` 也在 index ≥ `j`。函式回傳**最大的**安全切點 ≤ index。

**量到的差別**（dispatch 形狀的 fixture，M70 之後的實際日誌）：

| 日誌順序 | 未走位的孤兒切點 | 舊啟發式走位後 | 精確規則走位後 |
|---|---|---|---|
| `call → result`（pre-M70） | 8 / 63 | **0** | **0** |
| `call → dispatch → result`（**實際**） | 16 / 71 | **16**（＝等於沒走） | **0** |

逐站點：`resetWindowOnce` 的 `retainLast` 1..25 有 **6** 個值孤兒化（`[4,5,13,14,22,23]`）⇒ **0**；`selectShadowableRange` 抽樣 200 個預算 115 ⇒ **0**。**而 `tool/dispatch` 不需要被具名**——它落在「index ≥ j 的 result」這個條件裡自然被覆蓋（比指名豁免強）。

### 2.2 ②模型先解析，再建子 session（`packages/subagent/src/child.ts`）

順序改成 **閘 → `resolveModel`（非 ready 就 throw）→ `coordinator.create` → `createSession` → 貼種子 → warn → registry/agent**。兩個拒絕路徑現在都**在所有 durable 寫入之前** ⇒ 一次非 ready 的解析**不留** durable session、不留表項、不留 job，而 `:252-253` 那句「a refused spawn leaves no child session behind」**變成真的**。

**種子端只加可視性，不加策略**（spec §1.3 的裁決，見 §4）：種子的投影價格 ≥ 視窗時 warn 一行，訊息說出後果。**不修剪、不 fail-closed**——修剪會**無聲丟掉** M75 的串連摘要本來會保留的資訊，fail-closed 會把「從大 session 生一個子代理」這個**主要用例**關掉。

### 2.3 ③`anchorSeq` 走同一條路（`packages/session-persistence/src/fork.ts`）

`remapSeedEvent` 對 `rewind/point` 用**同一個** `renumbered` 映射（不寫第二份換算）。**缺席時的落點是正確的投影，不是補丁**：切片是連續尾巴 ⇒ 缺席的 anchor 只可能在切片起點**之前** ⇒ 父的 `[anchor, marker)` 留在子裡的部分**正好**是 `[0, marker)`。

---

## 3. ⚠️ 這一輪最重要的那條：**守衛是惰性的，而它的註解說它在工作**

**M70 讓每一個工具呼叫寫一個 `tool/dispatch`，而那個事件剛好落在舊判準的兩種型別之間** ⇒ 走位「走不動」，切點停在 `tool/result` 上；於是 **63→16 個孤兒切點，走位後還是 16**——**守衛在真實日誌上等於不存在**。而兩個呼叫點的註解還宣稱它在工作（`index.ts` 寫的是「measured, 4 of the first 25 produce an orphaned result」——那是 **M70 之前**的量測）。

**它被發現，是因為 M75 的終審去量了它，而不是因為任何人讀註解。** 這正是這條鏈（M72–M76）反覆遇到的那一類：**靜默**的失效，而**文件宣稱相反**。

**三次更正都是「紀錄比程式碼更會說謊」**：
1. `index.ts` 的過期讀數 → 換成本輪量到的兩張表。
2. **我**寫進 spec／brief／docstring 的理由（「未解析的 call 不進投影，`deriveMessages` 把它丟掉」）**是假的**——Task 1 的複審對照 `core-session` 證實它是**會投影**的（`assistant("", toolCalls)`，本樹自己的測試釘住），而且真相比我寫的更強：**沒有任何向後的切點能修好懸空的 call**，所以 call 側的判準會一路退到 0、讓 `resetWindowOnce` 永遠刪不掉東西（階梯退化成 fail-closed），而懸空的 call **仍然**留著。
3. **我**在裁決裡寫的「那個帶狀區是舒適區」也**只對一部分成立**——終審用我自己引的數字算出來：window 2 000 時帶狀區的下界 1 344 **高於**單一請求放得下的上界 1 295 ⇒ 在那個窗口下**整個**帶狀區都放不下。裁決的結論不變（門檻標的是硬邊界），理由被收窄成真的那一部分。

**而把「相信」換成「證明」的是終審的一個暴力窮舉**：57 433 個（日誌, 切點）配對——含每步多個呼叫、交錯的 dispatch、亂序的結果、中止的呼叫——**精確規則的輸出永遠等於「保留尾巴不產生孤兒 `tool` 訊息」的最大切點：0 個多保留、0 個少保留**。

---

## 4. 裁決（Rulings）— 逐條附代價

1. **種子端只警告；修剪與 fail-closed 都被理由否決。** (a) 修剪**無聲丟掉** M75 的串連摘要本來會保留的資訊 ⇒ 嚴格更差；(b) fail-closed 關掉「從大 session 生一個子代理」這個**主要用例**。**這推翻了控制器自己先前的傾向 (a)**——那個傾向寫在 M75 之前，而 M75 自己把它變成錯的。*代價*：子代理會多花一輪摘要，而**切不動的巨塊**仍走 fail-soft。
2. **M70 的 per-call checkpoint 維持原樣（不批次化）。** 「先把所有標記 append 再一次 flush」會弄壞它要買的東西——標記必須在執行體跑**之前**落地，否則崩潰後會把跑過的呼叫記成「未派送」。乾淨的變體（平行預檢）只買到 ~46ms，使用者感覺不到；**等儲存變遠端再做**。（本條屬於 **M78**，在此先記。）
3. **走位判準看 result 側**，而且**理由是更正過的那一條**：懸空的 call **會**投影（`assistant("", toolCalls)`，`core-session/test/session.test.ts:24-27` 釘住），而**沒有任何向後的切點能修好它** ⇒ call 側的判準會退到 0 並讓階梯 fail-closed。*代價*：規則**單側**，所以走位可以停在一個未解析的 `tool/call` 上（**具名的盲點**，`region.ts:60-64`）。
4. **`anchorSeq` 重映射而不是丟掉。** 它與 `shadowedSeqs` 是同一種引用，走同一條路；丟掉會讓被 rewind 藏起來的內容在子代理眼裡重新出現。session-fork 的「丟掉」**保持不動**（孿生路徑的既有差異），但兩邊現在都說明了理由。*代價*：兩條孿生路徑仍然不一致——本階段只讓子代理那條**正確**。
5. **種子 warn 的門檻是全窗口，不是引擎的 0.8 壓力門檻**（`compaction/index.ts:230`）：它標的是**硬邊界**（種子自己就越過窗口——切塊路徑開始有意義的地方），不是「子代理舒適地摘要」的健康情形。沉默帶 `[0.8·W − overhead, W)` 具名在註解與此。*代價*：一個會在第一步摘要的子代理**不會**產生那行 warn。
6. **Task 3 的兩個偏差接受**：brief 的測試檔無法 import `forkTurns`（加 devDep 會生環）⇒ 單元案例寫在該檔、端到端案例寫在 `subagent/test/child.test.ts`（多一個檔案）；缺席 anchor 的落點是 `0`——**那是正確的投影**（切片是連續尾巴 ⇒ 父的 `[anchor, marker)` 留在子裡的部分正好是 `[0, marker)`），不是補丁。
7. **fix wave：`?? 0` 只回答「事件不在種子裡」這個 miss。** 原版把**非數字**的 anchor 也鑄成 0 ⇒ 一個**畸形**標記變成活的 `[0, marker)` 視窗、藏起子代理的整個前綴，而投影在別處對這種輸入是**刻意不理**的（`core-session:280-282`）。這是本分支**自己引入**的唯一行為差異；沒有它，本階段會在修一個 over-hiding 的同時引入另一個。
8. **極大性與「warn 的條件子句」各補一條斷言**（fix wave）：兩者原本都有「突變存活」的縫——一個一律多保留的規則可以通過全部測試；刪掉那句條件子句不會紅。
9. **終審的兩個 out-of-scope 註記接受**：新測試手寫 `renumbered` 映射而不走 `forkTurns`（兩條路用同一個 pass ⇒ 性質等價）；`NaN` 仍被當成數字（JSON 帶不了 `NaN`，且**早於本階段**）。

---

## 5. 殘餘與 deferred minors

**殘餘（spec §5）**：**只有解析器那條路被關掉**——`resolveRoleTools`（`child.ts:408-411`）跑在 `coordinator.create` **之後**，工具名重複時它會 throw ⇒ 仍會留下孤兒 log（`createAgent`／`jobs.registerJob` 同理；**早於本階段**）；**既有的**孤兒 `child-<uuid>` log 沒有遷移路徑；**切不動的單一巨塊**仍走 fail-soft（M75 §4.4）；`forkTurns` 的預設 `"all"` 是產品決定；`tool/dispatch` 的 `eventSeq` 不動；`NaN` 的既成行為。

**Deferred minors（10 條，全部非阻塞）**：三個過期引用（`walkoff.test.ts:57`、`fork.test.ts:283`、`subagent/src/fork.ts:32-33`——fix wave 已修，若再漂移照同一類處理）；`region.ts:44-45` 說懸空的 call 投影成 `assistant("", toolCalls)`（帶旁白的步驟會把文字折進同一則訊息）；`fork.test.ts:376` 只斷言 `"turn 3 user"` 缺席（`"turn 3 answer"` 在同一個隱藏窗裡，是免費的判別力）；`src/fork.ts` 對 melded 標記的視窗描述比實際精確；`?? 0` 的專屬突變（fix wave 已補）；`child.test.ts` 的測試註解與原始碼訊息現在都是條件的。

---

## 6. 給下一個動這條鏈的人

1. **註解會比程式碼更會說謊，而它**不會**讓測試變紅。** 這一輪的三個洞裡有兩個是「文件宣稱有效、程式碼無效」（走位守衛、`child-<uuid>` 的註解）。**修任何一條這類鏈，先量它，不要先讀它的註解。**
2. **要動 `walkOffToolEvents`**：它的不變式是「回傳**最大**的安全切點 ≤ index」，兩條測試釘住（不孤兒化、不因懸空 call 崩到 0），**外加** fix wave 補的極大性斷言（`walkoff.test.ts:79-82` 的 `=== 3`）；改動它要同時想 `resetWindowOnce` 的預算語意（保留是以**事件**計的，1–2 個事件的位移不會使它離開預算）。
3. **要動 `spawnChild` 的順序**：兩個**拒絕**路徑在 durable 寫入之前，但**後續**的 throw（工具註冊、agent 建立、job 註冊）仍會孤兒化——那是一個具名的殘餘，不是保證。
4. **要動種子的 warn**：門檻是**全窗口**（刻意的），沉默帶是 `[0.8·W − overhead, W)`；交界在 `window = 5 × directive`（overhead 相消）。別把它「修」成 0.8，那是引擎的壓力門檻、不是這條線要標的東西。
