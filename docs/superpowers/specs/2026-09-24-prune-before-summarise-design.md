# M78 — 兩個成本缺陷 Design

**一句話**：①**摘要器讀的是未 prune 的工具輸出**——`planPrune` 在摘要**之前**就跑完了，但那個標記**在摘要成功之後**才附加（`compaction/index.ts:218`），而摘要器的 prefix 是從**日誌**折出來的（`deriveMessagesUpTo` → `deriveMessages` 的前置掃描讀 `derivePruneSubstitutes`）⇒ 已經規劃好要省的 token，摘要器**一份都沒省到**；②**M70 的 per-call checkpoint 成本**——**裁決已下（接受），本階段只把數字寫進紀錄**。

**來源**：M75 spec §5（「prune 在摘要之前」）＋ M75 紀錄 §0 最後一列；M70 紀錄 §47（checkpoint 的讀數）；控制器 2026-09-24 的裁決（closure plan §2.2）。

**分級**：**S–M**。①是一個**一行位移**的行為改變（但它會改變「摘要器看到什麼」，所以要完整驗收）；②**不動程式碼**。

---

## 0. 它讓什麼變得不一樣（全部讀碼／量測，附 `path:line`）

| 事實 | 讀數 |
|---|---|
| **prune 在摘要前就規劃好了** | `planPrune(session, config.prune)`（`compaction/index.ts:132`）；`renderShadowed(session, shadowedSeqs, pruneRecords)`（`:141`）**把規劃好的 records 餵給文字路徑** ⇒ **那條路徑是省到了的** |
| **但標記在摘要之後才附加** | `if (pruneRecords.length > 0) append(session, { type: "compaction/prune", … })`（`:218`）——在**摘要嘗試（`:185` 一帶）之後**、與 summary 的標記同一段 |
| **而 prefix 是從日誌折的** | `prefix = { …, messages: deriveMessagesUpTo(session, lastShadowed) }`（`:165`）；`deriveMessagesUpTo` → `deriveMessages`，**它的前置掃描讀 `derivePruneSubstitutes(session)`**（`core-session/index.ts:508`），而那個是**從日誌的標記**建 map（`:235-236`）⇒ **標記還沒附加 ⇒ map 是空的 ⇒ 摘要器重讀未 prune 的工具輸出** |
| **⇒ 誰付這個錢** | 摘要器的 prefix 是**真的送出去的訊息**（M5/D2 的 byte-prefix 形狀）⇒ 每一個被規劃要取代的舊工具輸出，**在摘要那一次仍然全額計價**，而且**還算進 M75/M76 的 fit 判準**（可能讓一個本來放得下的區域走進切塊路徑） |
| **M70 的 checkpoint 讀數** | 10 個並行呼叫：**10 次 durable 寫入／62 ms**，pre-M70 是 **0 次／16 ms**（`m70:47`）。「一個開始的呼叫一次寫入」是**故意的**——標記必須在執行體跑**之前**落地 |

---

## 1. 設計

### 1.1 ①把 prune 標記移到 prefix **之前**

**在 `:132` 規劃完、`:160` 建 prefix 之前**附加 `compaction/prune`，其餘逐字不變（`renderShadowed` 仍然拿到它規劃的那份 records；prune-only 那條路不變；summary 的三個標記不變）。

**為什麼是「移標記」而不是「讓 `deriveMessagesUpTo` 收 substitutes」**：後者等於**第二份投影**（fold 自己套一次取代）⇒ 與日誌驅動的那一份會漂移，而「一條規則只落一處」是這棵樹的既有紀律。移標記讓**唯一那份投影**自然看到它。

**代價（明說）**：**摘要失敗時，prune 已經附加、而且不會被撤銷**（日誌是 append-only）。今天的行為是「失敗 ⇒ 什麼都沒附加」。**這個改變是刻意的**：
- prune 是**安全**的（它只是把舊工具輸出換成一段取代文字），而且 **prune-only 那條路本來就會單獨附加它**；
- 失敗之後留著 prune **對下一次嘗試是淨賺**（token 已經省了）；
- 而階梯的下一層本來就會重試。

⇒ **要有一條測試釘住它**（失敗 ⇒ prune 在、summary 不在），並在**發射 `failure` telemetry 的那一行旁邊**寫明。

### 1.2 ②checkpoint：**接受，並把數字寫進紀錄**（裁決已下，不再動程式碼）

**理由（closure plan §2.2 已記）**：把「N 個標記一起 append、一次 flush」**會弄壞它要買的東西**——標記必須在執行體跑之前落地，否則崩潰後會把跑過的呼叫記成「未派送」，而那正是 M70 要消滅的不安全方向。乾淨的變體是**平行預檢**（N 個標記一起送、全部落地才開始跑任何執行體），它**保住**不變式，但只買到 **~46 ms**（62 → ~16），**使用者感覺不到** ⇒ 現在不值得動。**若儲存變成遠端**（每次寫入是一次往返）再回來做。

⇒ 本階段**只把這一段寫進 spec 與紀錄**（含 62/16 的讀數與平行預檢的候選地位）。

---

## 2. 驗收（每一條都要**紅先 ＋ 變異證明**）

1. **摘要器的 prefix 是 prune 過的**：一個舊工具輸出會被 `planPrune` 命中的 session，在**不**走 prune-only 的設定下跑 `compact()` ⇒ 斷言摘要請求的 messages 裡**有取代文字、沒有原始輸出**。紅先＝今天就帶著原始輸出。
2. **prune-only 那條路不變**：既有的 prune-only 案例全綠（它本來就單獨附加標記）。
3. **失敗仍然保留 prune**（新的刻意行為）：讓摘要器 throw ⇒ 斷言 `compaction/prune` **在**、`compaction/summary` **不在**、`reason` 仍是 `"summarizer-failed"`。
4. **沒被命中的 session 逐位元組不變**：`pruneRecords.length === 0` 時，請求與標記與今天完全相同。
5. **與 M75/M76 的閘互動**：一個「原本剛好放不下、prune 之後放得下」的區域 ⇒ **單一呼叫**而不是切塊（那是這個修法的**紅利**，要有一條測試說得出它）。
6. `pnpm verify:all` 五步全綠、`--gate` **不新增列**（不新增 export）。

## 3. 刻意不做（YAGNI）

- **不讓 `deriveMessagesUpTo` 收 substitutes**（第二份投影，§1.1）。
- **不做平行預檢 checkpoint**（§1.2，量到的收益是使用者感覺不到的 46 ms）。
- **不改 prune 的規劃邏輯**（`planPrune` 的門檻與取代文字都不動）。
- **不動 prune-only 那條路**。

## 4. 它不保證什麼（明說）

1. **不保證省下的一定夠**：prune 只取代**被規劃命中**的那些工具輸出；一個沒有可 prune 內容的超窗區域仍然走 M75 的切塊路徑。
2. **不保證失敗後的行為對每個 host 都好**：一個把「失敗」當成「什麼都沒動」的 host，現在會看到一個 prune 標記。**這是刻意的**（§1.1 的三個理由），但要具名。

## 5. 殘餘（寫出來，不是藏起來）

- **平行預檢的 checkpoint**（§1.2）：具名候選，條件是儲存變遠端。
- **既有的 checkpoint 成本**（62 ms vs 16 ms／10 個呼叫）：接受，數字在 §0。
- **M70 紀錄 §47 的另外兩個成本項**（checkpoint flush 前綴而非只 flush 標記；batch-level 的替代方案）不在本階段。

## 6. 取樣與自創

| 部分 | 來源 |
|---|---|
| 「移標記」而不是「第二份投影」 | **本樹的既有紀律**（一條規則只落一處）＋ 讀 `deriveMessages` 的前置掃描 |
| 「失敗保留 prune」是刻意的 | **本輪的判斷**（三個理由寫在 §1.1），並要求一條測試釘住 |
| checkpoint 接受 | **控制器 2026-09-24 的裁決**（closure plan §2.2）；讀數來自 M70 紀錄 |
| 與 M75/M76 閘的互動是紅利 | **本輪的推理**（prefix 變小 ⇒ fit 判準可能翻面），要求一條測試說得出它 |
