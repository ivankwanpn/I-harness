# M6 — 廣度：生態＋介面硬化 — 設計（草案）

**日期：** 2026-09-21 · **分支：** `m66`（下一個里程碑的分支名是一個未決問題，見 §8）
**性質：** 這份文件是**決定**。每個決定的理由都可檢查；**未決**的地方標出來了。**owner 2026-09-22 核准**（三個未決的裁定見 §8）。
**輸入（roadmap §1.1 的閘門已完成）：** `docs/superpowers/research/2026-09-21-m6-precedent-synthesis.md` —— 17 列對現行 HEAD 的重量、七源＋ZCode 的採用/改良/丟棄矩陣、量到的缺陷清單。**本 spec 不重複它的量測；每一節指向它的列號。**
**這不是施工計畫。** 本文件不連任何線；計畫等這份被核准之後才寫。

**M6 的完成定義（roadmap §3.M6）在兩格上與量到的事實不符**，見 §7 —— 那兩格的修正要隨這份 spec 一起核准。

---

## 0. 範圍：四個工作批，與明說的不做

| 批 | 內容 | 來源 | 分級 |
|---|---|---|---|
| **A** | **wire 輸出背壓**：有界輸出＋界破的一個指名結局＋overload 錯誤碼 | synthesis #15（✅ 採用） | 小 |
| **B** | **wire 握手閘門**：`initialize` 成為閘＋連線身分捕獲 | synthesis #14（◑ 條件：**版本裁決**，§8） | 小，但**動版本級** |
| **C** | **skills 可被發現**：目錄注入＋`$name` sigil 掃描 | synthesis #11＋#12（✅＋◑ 同批） | 中 |
| **D** | **MCP catalog 的其餘界**：重複 cursor 拒絕、總量/cursor 上限、整體 timeout、`tools/list_changed` 刷新 | synthesis #4（◑ 小修） | 小 |

**不做（明說，理由在 synthesis 的矩陣欄 —— 這一欄就是「不過度設計」的存證）：** transport 擴充（#3）· elicitation（#5）· MCP 資源快取（#6，false gap）· MCP server mode（#7，Q4 不變）· 技能專案根發現（#9，量不到輸入）· 註冊表快取（#10）· bundled skills（#13）· baseline/diff 投影（#14，false gap）· bundle 校驗（#15）· settings 命名空間（#16，false gap）· config requirements 半（#17，撞 Q1）；歸因 slice（#17 的另一半）**park 到有宿主顯示它為止**。

**已落地、不在範圍（背景）**：plugin 狀態列表面（`i-harness plugins`，`b3ce806d`…）與 D-MCP-1 的修復（`018fc373`＋`549beefb`）——synthesis #8 與 §2 的頭條。

---

## 1. 批 A：wire 輸出背壓（決定）

### 1.1 事實（量於 synthesis #15）

輸出**無界**：`JsonRpcLineTransport.send` 直接 `output.write(encodeFrame(message))` 且丟棄回傳（`packages/sdk/src/protocol.ts:593-595`）；事件通知對每個 append 1:1 同步產生（`packages/sdk/src/server.ts:188-190`）；全樹 `backpressure|highWaterMark|drain` 零命中；錯誤碼固定五個、無 overload。**而 resync 半已經存在**：`session/history`（afterSeq 獨佔、500/1000 caps）＋`seq` 戳記＋「append-only 不重播」的契約文字（`protocol.ts:41-44`）。

### 1.2 決定

1. **每連線一個有界輸出佇列。** 界的**形狀**：佇列中的**未寫出位元組數**（不是幀數 —— 幀大小無界，位元組才是記憶體）。**界值**：可設定，預設由一條**可推導的規則**定出（計畫量測後寫入）：≥ 讓一個只是「落後一頁」的正常客戶端不被誤殺 —— 下界由既有的 `session/history` 上限推導（1000 幀的那一頁的序列化大小）。**這一條的依據是推導，不是挑一個看起來合理的數字。**
2. **界破的結局（唯一一個，指名）：送一幀 overload 錯誤後關閉連線。** 新錯誤碼（v1 明文允許「new error codes」，`protocol.ts:46-48`）—— 這是 additive，不動版本級。**恢復路徑＝既有的 `session/history`**（客戶端重連後拉回）；**不做** ZCode 式的「界內 resync 指令」——IH 已經有拉取面，多一個推播面指令是第二條路。
3. **不做**：每 profile 的 flush 窗口（ZCode 的 30/150ms）——沒有量到的消費者形狀需求，等前端出現再談。

### 1.3 驗收

| 測什麼 | 形狀 |
|---|---|
| 界內行為逐字不變 | 既有的 sdk 測試全綠；一般寫入路徑不新增任何幀 |
| 界破的結局 | **synthetic slow writable**（無真消費者 —— 明說）：緩衝填滿 ⇒ 恰好一幀 overload 錯誤 ＋ close；日誌/計數器可觀測 |
| 界值的推導 | 一條測試把「1000 幀一頁的序列化大小」與預設界值的關係釘住（界 ≥ 該值） |

**代價（接受）**：一個慢連線從「無限堆記憶體」變成「被切斷」——切斷是可見的、可恢復的；堆積是不可見的。

---

## 2. 批 B：wire 握手閘門（◑ 條件：版本裁決）

### 2.1 事實（量於 synthesis #14，含執行見證）

`initialize` **不是閘**：未握手即可呼叫任何方法（探針：`session/prompt` 直接成功）；`clientInfo` 送了**沒人讀**；連線**零作用域狀態**（所有 map 以 sessionId 為 key）。能力面已存在（8 常駐＋4 host-gated 列）。**樹內消費者只有測試**（舊 TUI 已刪）。另有一個純 doc bug：`server.ts:5-39` 的方法清單註解已腐（少列 6 個方法）。

### 2.2 決定（三個選項，附建議 —— 這一格要 owner 裁）

| | 選項 | 代價 |
|---|---|---|
| **(a) 建議** | **PROTOCOL_VERSION 3**：`initialize` 成為閘（未初始化 ⇒ 具型錯誤）＋連線身分（clientInfo）捕獲一次 | 一個版本級跳躍 —— 而**今天沒有任何生產消費者**，所以跳躍的成本只是測試；未來的前端直接對 v3 蓋。v1 的 ADDITIVE-ONLY 規則照 `protocol.ts:46-48` 的條款走（bump＋遷移註記）。 |
| (b) | 只做 additive 的**身分捕獲**（`initialize` 仍然可跳過） | 閘門缺口留著；「未握手也被服務」的形狀在 v3 前繼續存在 |
| (c) | 不做 | 與 roadmap 把這一列評為「值得做」相左；且前端重建時要重來 |

**✅ 裁定（owner 2026-09-22）：(a)。** `initialize` 成為閘、連線身分捕獲一次、PROTOCOL_VERSION 升 3（照 `protocol.ts:46-48` 的條款走 bump＋遷移註記；今天的成本只是測試）。

**不論選哪個，(2.3) 的 doc 修正都做。**

### 2.3 無條件的一部分

`server.ts:5-39` 的方法清單**以 switch 為準重寫**（今天 19 個方法，註解少列 6 個）—— 這是 citation-rot 的同類，跟版本裁決無關。

### 2.4 驗收

| 測什麼 | 形狀 |
|---|---|
| （若 (a)）未初始化 ⇒ 具型拒絕 | 探針形狀的測試：任何方法在 `initialize` 前呼叫 ⇒ 指名的錯誤碼；`initialize` 後全通 |
| 身分捕獲 | clientInfo 存一次、不再重讀；後續請求看到的是捕獲值 |
| 能力閘不變 | 既有 8＋4 列的 presence 測試全綠 |
| doc 修正 | 註解與 switch 對得上（一條測試或一次 grep 釘住） |

---

## 3. 批 C：skills 可被發現（決定）

### 3.1 事實（量於 synthesis #11/#12）

- 目錄注入＝**零**：生產 runtime-context section 只有 `instructions` 與 `subagents`；技能文字只在兩個工具的 description 與檢索結果裡（pull-time）；`grep -i skill packages/preset` = 0。
- 使用者輸入側＝**零**：全樹 `sigil` 零命中；`user/message` 是不帶結構的字串。
- 既有機制：`runtime-context` 只在**文字改變時尾端追加**（前綴安全，T2 紀律的解）；`shadow.ts` 的 `explicitMentionMatches` 是**工具查詢內**的顯式比對，不是輸入側。

### 3.2 決定

1. **目錄注入（C1）**：一個新的 runtime-context section `skills`，內容＝**每個技能的 name ＋ description 一行**（有 `when_to_use` 就帶上）。**落點＝尾端追加**（runtime-context 的既有機制）——**不得**動 system prompt 或工具陣列（byte-0 斷點）。**總量上限**：由**計畫量測**定出（以 `token-meter` 對真實技能語料估算，寫進計畫），超過以一行截斷註記收尾 —— 上限**要有依據**，規則先立、數字後量。
2. **sigil 掃描（C2）**：使用者輸入裡 `$name`（codex 的 `TOOL_MENTION_SIGIL` 先例）命中已註冊技能名 ⇒ **尾端追加一則 user message** 指出該技能（模型自行 `skill_get`）。**不做自動執行**、**不新增事件型別**（`user/message` 是純文字）。**時序與縫**（在哪個站點掃、如何與 admission 互動）留給計畫 —— 語意在本節定死。
3. **不做**：專案根發現（#9）、layered 的 scope 維度（#10）、bundled（#13）——理由在 synthesis 矩陣欄。

### 3.3 驗收

| 測什麼 | 形狀 |
|---|---|
| 目錄只變時追加 | 技能集不變 ⇒ 零新行（釘住「每分鐘寫日誌」的形狀不回來）；加一個技能 ⇒ 恰好一則 |
| 前綴安全 | 目錄渲染走 section ⇒ 既有前綴量測測試全綠；`grep` 證明沒有第二個注入面 |
| 上限 | 超過上限 ⇒ 截斷註記出現、內容不超過界（用**量到的**上限值斷言） |
| sigil | `$name` 命中 ⇒ 一則尾端 user message；`$unknown` ⇒ 零副作用；名內含 `$` 的誤命中案例（負向）也測 |

---

## 4. 批 D：MCP catalog 的其餘界（小修；與已修復的 D-MCP-1 同子系統）

### 4.1 事實（量於 synthesis #2／D-MCP-3）

分頁**已在**（cursor 迴圈、頁數上限 100、同頁重名拒絕）；**缺**：重複 cursor 拒絕（今天只有頁數上限間接擋）、總項數／cursor 長度上限、**整體 timeout**（`listTools` 不吃 `toolCallTimeoutMs`，每頁吃 SDK 預設 60s）；**`tools/list_changed` 不處理** ⇒ catalog 只在 generation 建立/重連時刷新。

### 4.2 決定

補上四個缺口（三個界＋刷新），**照 codex `pagination.rs:9-25` 的那一組**（synthesis #4 的採用欄）。**不含** annotations 的信任（D-MCP-4 是 D1 家族決定）。刷新語意：`list_changed` ⇒ 標記 catalog dirty，在下一個安全的邊界重建（**不得**在事件回呼裡同步重建）。**「安全邊界」是什麼，是計畫的事。**

### 4.3 驗收

| 測什麼 | 形狀 |
|---|---|
| 重複 cursor | 一個永遠回同一 cursor 的假 server ⇒ 具型錯誤、不無限迴圈 |
| 總量/cursor 上限 | 超限 ⇒ 具型錯誤 |
| 整體 timeout | 逐頁都慢的假 server ⇒ 在**整體**界內失敗（不是每頁 60s × N） |
| 刷新 | `list_changed` ⇒ 下一個邊界後 catalog 反映新工具；同邊界內不重入 |

---

## 5. 這份 spec 依賴的既有裁定（不重開）

| 既有 | 關係 |
|---|---|
| **Q6（前端延後）＋ owner 2026-09-21（後端先打磨，CLI 是當前宿主）** | 批 A/B 是**後端打磨**（讓 wire 值得被蓋）；回報/管理面落 CLI |
| **T2 前綴紀律（前綴量測）** | 批 C 的落點選擇（尾端追加）與批 A 的「不新增一般寫入幀」都由它約束 |
| **reachability gate** | 每一批的新 export 要有同提交消費者；中途 NEW rows 預期、最終歸零 |
| **事件日誌是唯一真相** | 批 C 不新增事件型別；批 B 的連線身分**不落日誌**（它推不出來，是連線作用域事實 —— 計畫裡要寫明它去哪裡） |
| **Q4（MCP server mode 不做）** | 不變 |
| **M5 的 tool 管線** | 批 D 的 MCP 工具走同一條管線，界/信封/取消不動 |

---

## 6. 施工順序（計畫等核准後才寫；這裡只給相依）

```
A（背壓）與 B（握手）同一批 —— 都動 wire，版本裁決先落
D（catalog 界）獨立、最小 —— 與已修復的 D-MCP-1 同子系統，順手
C（skills 可被發現）獨立 —— 尺寸最大、前綴紀律最敏感，放最後
```

---

## 7. 完成定義的修正（隨本 spec 一起核准）

roadmap §3.M6 的完成定義四格，兩格與量到的事實不符（synthesis 的重量欄）：

| 原句 | 量到的 | 建議 |
|---|---|---|
| 「skills 可被發現而非只是可載入」 | **真缺口**（目錄注入零） | **保留** —— 批 C 就是它 |
| 「`@i-harness/sdk` 的 append-only `session/event` 語意與背壓在 wire 層有測試」 | 背壓＝真缺口；append-only 語意**已有**契約文字與測試 | **保留**（背壓的部分＝批 A） |
| 「`settings-seam` 有契約測試」 | **false gap**：縫已是目標形狀、缺的是消費者（Q7 未觸發）；測試檔已存在 | **改為**：「settings-seam 的契約測試**已存在**（`sections.ts` 的既有測試）；**wire 的 settings 面**是 Q7 觸發時的工作」 |
| 「`operator-config-layer-stack` 有契約測試」 | 層疊**已存在但無消費者**；缺的是來源歸因，而它 park 中 | **改為**：「來源歸因 park 到有宿主顯示為止；本里程碑不含」 |
| （MCP）「攝取面有硬化過的測試」 | 表列在 roadmap §223 的前半；D-MCP-1 已修、批 D 補其餘界 | 保留 |

**⇒ 兩格修正 ＝「把已存在的記成已存在、把無輸入的明說不做」—— 這正是 roadmap §1.1 這條規則存在的理由。** **✅ 核准（owner 2026-09-22）：照建議修正。**

---

## 8. 裁決記錄（原「未決」—— **全部已裁定，owner 2026-09-22**）

1. **批 B 的版本裁決 → (a)**：`initialize` 成為閘、PROTOCOL_VERSION 升 3（§2.2 已就地記錄）。
2. **§7 的完成定義修正 → 照建議核准**（§7 已就地記錄）。
3. **下一個里程碑的分支名 → `m68`**（roadmap 的意圖）；**已開**（自 `m66` 的快照分支，M6 的計畫與實作落此）。
