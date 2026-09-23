# M78（prune 在摘要之前，與一個被推翻的設計）交付紀錄

**一句話**：`planPrune` 在摘要**之前**就跑完，但 `compaction/prune` 的標記**在摘要成功之後**才附加——而摘要器的 prefix 是從**日誌**折的 ⇒ **已經規劃好要省的 token，摘要器一份都沒省到**。修好之後那個請求從 **15 390 → 11 673** token，一個本來要走 M75/M76 切塊路徑的區域回到**單一呼叫**（2 個請求 → 1）。

- **分支**：`m78`（from `main` `bb266229`）。**執行段**：`560e0b66`（spec＋計畫）＋ `0336fe4b`..`8ac30ec7`（一個任務＋三次紀錄/註解回合＋一輪指標更正）。合併尚未進行。
- **spec（權威）**：`docs/superpowers/specs/2026-09-24-prune-before-summarise-design.md`
- **計畫**：`docs/superpowers/plans/2026-09-24-prune-before-summarise.md`
- **它屬於**：`docs/handoff/2026-09-23-backend-closure-plan.md` 的 **M78／M76–M80**

---

## 1. 閘門與算術

**`pnpm verify:all` 在最終樹上 PASSED**（單獨執行）：

| 步驟 | 讀數 |
|---|---|
| suite | exit 0 · **3124 passed｜9 skipped｜0 failed** |
| population | **67 of 67** |
| typecheck | exit 0 |
| e2e | exit 0 · 5 檔 |
| reachability | exit 0 · **432 列** · `gate PASS -- no new rows` |

**算術**：M77 終態 **3118** ＋ **6** ＝ **3124**（Task 1 的五個 compaction 案例 ＋ 一個 core-session 釘子）。fix wave 只改了註解與**一條**斷言的形狀 ⇒ 測試數不變 ✓。

---

## 2. 交付物

**①標記移到 prefix 之前**（`compaction/src/index.ts`）：它的**真正產物**是「**失敗時 prune 留著**」（日誌 append-only、撤不掉；那是刻意的——prune 安全、對下一次是淨賺、階梯本來就會重試）。

**②而它**自己**不夠——真正的修法是一行**（`core-session/src/index.ts`）：`deriveMessagesUpTo` 的 seq 濾網**對 `compaction/prune` 破例**。**為什麼它安全而 summary／reset 不安全**：prune 是**內容尋址**的（map 以工具呼叫為 key，取代文字是**那份舊輸出**的性質）⇒ 套到任何 fold 都對；`summary`／`reset` 是**時間尋址**的（它們的 seq 清單**指名一段區域**）⇒ **必須繼續服從**（兩者都有釘子）。

**③checkpoint：接受**（裁決）。10 個並行呼叫 **10 次 durable 寫入／62 ms** vs pre-M70 **0 次／16 ms**。批次化會**弄壞它要買的東西**（標記必須在執行體跑之前落地）；乾淨的變體是**平行預檢**（保住不變式，只買到 ~46 ms，使用者感覺不到）⇒ **等儲存變遠端再做**。

---

## 3. ⚠️ 這一輪最重要的那條：**我的設計從根本上是錯的，而實作者用量測把它擋下來**

spec 的第一版要求「**把標記移到 prefix 之前**」。實作者照做、**量到它沒有修好任何東西**（兩條案例仍然紅），於是**停下來**（NEEDS_CONTEXT）——沒有提交，因為 brief 的訊息宣稱一個量測否定的節省，而且會把紅的 suite 送上去。

**它量出的真因**：`deriveMessagesUpTo` 濾 `seq <= maxSeq`（`deriveMessages({...session, events: ...})` 那一行），而 `append` **永遠把最高 seq 給新事件** ⇒ **prune 標記永遠落在區域最後一個 shadowed seq 之後**（`lastShadowed` 104／109、標記 seq **110**）⇒ **沒有任何附加位置能修好它**。**⇒ 我的診斷在根部就是錯的，而它沒有繞過去，而是量出來並回報。**

**它同時量出了它沒有採用的解法**（還原、sha 逐位元組驗證）⇒ 控制器授權之後才有今天的修法。

**而這一輪的第二次更正同樣是「紀錄比程式碼知道的多」**：終審發現我寫進 spec 的**紅利宣稱是反的**——D2 的參照是「**上次送出的**主請求」，而 M78 之前那一刻 replay 出來的訊息與它**逐位元組相同** ⇒ **快取確實服務了它們**（約十分之一價）。所以「先 prune 再折」是**用快取換 token 的取捨**，不是修復，而**那一側本階段沒有量**。**紅利那一側仍是真的且壓倒性**：超窗時切塊路徑的冷讀遠貴於一次全額讀。

**⇒ 兩個里程碑內，控制器被 subagent 的一次量測糾正四次**（EOL 儀器、帶狀區算術、reachability 的 432、**以及這一次的整個設計**）。這一輪的紀錄還帶了兩件同類的：**五處過期的「byte-prefix 快取」簡寫**（其中 `core-session` 那一處就坐在本階段自己那段解釋上方十行、**互相矛盾**），與 **`engine.test.ts` 的測試名稱**仍宣稱一個被廢除的不變式。

---

## 4. 裁決（Rulings）— 逐條附代價

1. **失敗的 `CompactionResult` 形狀不變**（`{compacted:false, …, reason:"summarizer-failed"}`，即使 prune 已在日誌上）：不能報成功——階梯的 breaker 以 `!compacted` 計數，一個失敗的摘要器必須繼續算一次失敗，否則 breaker 就不再保護模型不被猛打。*代價*：一個把 `compacted:false` 讀成「什麼都沒附加」的消費者現在是**微妙地錯的**（註解與殘餘是緩解）。
2. **`deriveMessagesUpTo` 的破例只給 prune**（內容尋址 vs 時間尋址），兩者都要有釘子。*代價*：一個 prefix fold 會套用一個「屬於更晚時刻」的重寫——而內容尋址的論證正好排除那件事，時間尋址的釘子是警報。
3. **【更正】Ruling 31 原本說「這同時修掉一個 spec 沒指名的缺陷」——那是錯的**：它是**取捨**（快取 vs token），而取捨的哪一邊贏**沒有量**。紅利那一側（超窗時 2→1 請求）才是壓倒性的。*代價*：若快取損失佔上風，在「放得下」那一側這個修法可能讓**帳單**變貴——已具名為候選量測（closure plan §2.45）。
4. **checkpoint 接受**（不批次化）；平行預檢具名為候選（條件：儲存變遠端）。
5. **一條具名的既有斷言被收窄**（`summarizer-prefix.test.ts` 的失敗案例：`startsWith("compaction/")` → summary trio），因為它斷言的正是本階段**刻意廢除**的不變式；突變證明它仍然殺得死（在失敗路徑上附加 summary 標記 ⇒ 紅）。
6. **reachability 儀器的註解盲點升格為 M79 的真實項目**（兩個里程碑各觸發一次，兩次都靠改註解繞過）。*代價*：在那之前，任何**別套件**的註解提到一個 export 的名字都會讓一列真話消失。

---

## 5. 殘餘與 deferred minors

**殘餘**：**快取那一側沒有量**（§1.1、closure §2.45）；**五處過期的快取簡寫**（`compaction/src/index.ts`、`summarizer.ts`、`core-agent/src/index.ts`、`core-session/src/index.ts` ← 最糟、`session-executor/test/assembly.test.ts`）；**`engine.test.ts` 的測試名稱**同類；**重試會再附加一個標記**（冪等、last-wins、自動路徑由 breaker 界定，**手動 `compact()` 沒有閘**；去重會省每個記錄 ~5 180 bytes，不做——那會變成第二個地方決定 prune 是什麼意思）；**prune 只縮它能縮的**（沒東西可 prune 的區域仍走 M75 的切塊路徑）。

**Deferred minors**：改正後的註解有兩處措辭不精（`summarizationModel` 的閘沒提；「不再是 byte-prefix」讀起來是無條件的，而分岔是 prune 條件性的）；`slices.ts`／`region.ts` 之外仍有幾個**目前正確**的行號引用。

---

## 6. 給下一個動這條鏈的人

1. **要動 `deriveMessagesUpTo`**：破例只在 prune 那一類；`summary`／`reset` 的 seq 服從**有釘子**（`core-session/test/prune-event.test.ts` 同時蓋兩個）。**引檔案用符號名**——本階段那個檔案的行號移了 30 行。
2. **要動「失敗時附加什麼」**：查 `CompactionResult` 的消費者怎麼讀 `compacted:false`（殘餘 ①）。
3. **要動成本**：先量 `cacheReadTokens`（`provider/call` 已經在報），因為**這條鏈上每一次「少幾個 token」都可能是一次快取取捨**。M78 的教訓是：**token 數下降不等於帳單下降**。
