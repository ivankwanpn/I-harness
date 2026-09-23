# M73（每一條離開行程的請求都帶著自己的預算）交付紀錄

**一句話**：M72 讓**主要 session** 的請求帶得住自己的預算；M73 把同一條契約補到**其餘每一條出口**——子代理的 spawn、子代理的 rebuild、compaction 的摘要請求，以及（終審抓到的）auto-title。

- **分支**：`m73`（`10588e2` → `b02c972`，**22 個 commit**；合併尚未進行）
- **spec（權威）**：`docs/superpowers/specs/2026-09-23-provider-budget-chain-design.md`（`55f947f`，終審後修正於 `b02c972`）
- **計畫**：`docs/superpowers/plans/2026-09-23-provider-budget-chain.md`（`6b8058c`，三次修正：`e0e8c4b`／`1ceb9e9`／`b1bc765`／`901d74d`）
- **執行**：subagent-driven development：5 個實作任務 → 逐任務複審 → 五輪 fix round → 終審（opus）→ **單一 fix wave** → 限定複審

---

## 1. 閘門與算術

**`pnpm verify:all` PASSED（在最終樹 `b02c972` 上跑）**：

| 步驟 | 讀數 |
|---|---|
| suite | exit 0 · **3047 passed｜9 skipped｜0 failed** |
| population | **67 of 67** |
| typecheck | exit 0 |
| e2e | exit 0 · 5 檔 |
| reachability | exit 0 · **433 列** · `gate PASS -- no new rows` |

**算術**：M72 結尾 **3022** ＋ 本階段 **25** 個新 `it(` ＝ **3047** ✓。（第一次全量跑在 fix wave 之前：3044 ＝ 3022 ＋ 22。）

**既有斷言的變動，逐條交代**（五個測試檔有刪除行，全部具名）：

| 檔案 | 刪除 | 是什麼 |
|---|---|---|
| `compaction/test/{engine,analytics,site-diagnostics,summarizer}.test.ts` | 各 1 行 | **四條碰撞斷言**，各**加一個鍵**（`reason: "summarizer-failed"`）⇒ **變嚴**，不是放寬 |
| `subagent/test/child.test.ts` | 22 行 | **helper 的搬移**（`recordingClient`／`settled` 從 describe 內部抬到 module scope）——計畫明文要求 **move，不是複製** |
| `session-title/test/session-title.test.ts` | 1 行 | **一行 import**，無斷言改動 |

**沒有任何既有斷言被放寬**；其餘測試檔是純新增。

**reachability 434 → 433 是量出來的，不是假設的**：本階段一度是 432——用一個暫時的 worktree 在 `10588e2` 上跑同一支儀器、對差列集合之後才看清：一列**合法**消失（`token-meter#CHARS_PER_TOKEN`：本階段給了它第一個真消費者，`subagent/src/child.ts:9`），另一列是**遮蔽**（`core-agent#AgentDeps`：一句新註解點名了它，而全樹**沒有**任何檔案 import 它）。終審 I1 判為缺陷，fix wave 把那個名字拿掉 ⇒ **433**。

---

## 2. 三條出口 ＋ 五個 hop ＋ 一個判別欄位

### 2.1 子代理：spawn 與 rebuild（兩條路徑，同一個形狀）

- **spawn**（`subagent/src/child.ts`）：宣告了模型的 role ⇒ 從 binding 讀；沒宣告 ⇒ 從 host 形狀讀（`RoleModelHost` 新增的兩個可選欄位，三個 spawn 臂都 extends 它）。兩個值往後傳成 `AgentDeps.maxOutputTokens`（由 core-agent 夾）與 `AgentDeps.budget`（含 `overheadTokens`，按**子代理自己的**composed prompt ＋ tool schemas 估價）。
- **rebuild**（`subagent/src/tools.ts`）：同一段讀取的孿生。**它另外有一個缺陷**：它傳 `role.systemPrompt`，而 spawn 傳 `composeSubagentPrompt(...)` ⇒ 每個**重建**的子代理都無聲地掉掉 `SUBAGENT_PROMPT_CONTRACT`。已修並補測試。
- **先例**：宣告臂用 **binding 覆蓋** host 的數字（不是 `??`）——宣告的模型有自己的預算，拿 session 的去套別人的模型**比沒有更糟**。四種組合裡三種有測試釘住。

### 2.2 五個 hop（兩個是複審抓到的，原本的計畫漏了）

`AssemblyOptions.contextWindow/maxOutputTokens` → ①三個註冊點（`assembly.ts`）＋ ②host 端孿生型別 `RoleModelResolution` 加寬 → ③`subagent/src/index.ts` 的 `subagentDeps` → ④**`subagent/src/tools.ts` 的 `spawn_agent` 呼叫**（**主要路徑**，原本漏了）→ ⑤`agent-team` 的 `TeamSubagentDeps` 與 `guard-approval` 的 `GuardianReviewDeps`。

**只接其中一跳的後果**：型別全過，而**實際的預算兩邊都是空的**——最難看出的那種錯。

**guardian 刻意只接繼承臂**：`reviewer.ts` 的 `deps.model ?? deps.parentModel`，配置的 guardian 模型是一個**裸 client**（`assembly.ts:1129`），那個站點**沒有 binding 可解析** ⇒ 傳 session 的數字會把一個模型的窗口套到另一個模型上。依「缺席即缺席」不傳。

### 2.3 compaction 的摘要請求

- cap 從 `core-agent` 的 deps 傳進引擎，再傳到 `summarizeWithModel` 的一個**新的可選第 9 參數** `limits`，在**窗口已在手**的那個位置用既有的 `clampOutputCap` 夾一次；**並加上 host 的 overhead**（與 session 自己的夾取同一筆）。
- **`CompactionConfig.maxTokens` 刻意不接上 wire**：它是**事後的字元切片**（`slice(0, maxTokens * 4)`），接上去會讓模型被截斷、而結果**仍然通過** floor 檢查 ⇒ 下一輪的 anchored 摘要會建立在一個被切斷的摘要上。兩者在註解與測試裡都分開。
- **legacy 文字路徑**（配置了 `summarizationModel`、或引擎沒給 `requestShape`）：那條請求**既沒有 systemPrompt 也沒有 tools** ⇒ overhead **不計**；否則會把 `hardRoom` 推到 < 1，讓**原始的** cap 出去——本階段自己的缺陷在那條路上存活。
- **配置了 `summarizationModel` 時**，**session 模型的 cap 不送**（終審 I2 抓到的真缺陷）：那條請求打到**別的端點**，而 `reviewer.ts` 自己把 `config.summarizationModel` 稱為 guardian 的**孿生兄弟**——原則一樣：**傳一個不是它的數字比不傳更糟**。

### 2.4 失敗要說得出自己是什麼

`{ compacted: false, shadowedSeqs: [] }` 在 `compaction/src/index.ts` 有 **8 個**生產者；只有**摘要器失敗**那一條帶 `reason: "summarizer-failed"`，CLI 因此不再把「摘要器失敗」報成「No compactable history yet.」（原本兩者在使用者眼裡一模一樣）。

### 2.5 auto-title（終審抓到的第三條出口）

`session-title` 的 `suggestTitle` 走 `assembly.model` 這個**裸的直通**——不帶 cap、不帶窗口 ⇒ 在 anthropic 上同樣會把**未夾取**的 128k fallback 送出去。**spec §0 的普查說「兩條出口」，那是錯的**；已在 spec 就地更正（`b02c972`），並以與另外兩條相同的方式修掉（CLI 把兩個值傳進去）。

---

## 3. 裁決（Rulings）— 逐條附「錯了會怎樣」

> 依執行順序。每一條都是控制器替人做的決定。

- **M73-P1**（pre-flight）：T1 與 T2 的 overhead 公式**逐字相同** ⇒ **只寫一份**（`estimateChildOverhead` 從 `child.ts` 匯出，`tools.ts` import）。 — 複審的「逐字重複」規則會盯上它。 — 錯的代價：零行為差異。
- **M73-P2**（pre-flight）：spec §2 把驗收看成一條**精確等式**，而計畫斷的是**不等式** ⇒ **以計畫為準**：測試看不到 `OUTPUT_CAP_SAFETY_MARGIN`（未匯出）也看不到 child 的 overhead；**證明機制的是變異**，而夾取的算術已由 M72 Ⅱ 測在 llm-seam。 — 錯的代價：要斷精確值得先匯出那個常數。
- **T1 修 1**：inherit 臂的**窗口讀取**（預設 harness 的路徑）沒有任何測試釘住 ⇒ 補；同時補 declared 臂的優先序與 case 3 的擊殺點註解。 — 每條新規則要有會紅的測試。 — 錯的代價：三條測試。
- **T1 修 2**：declared 臂的**窗口那半**仍沒被釘住（只突變 cap 那行 ⇒ 全綠）⇒ 補。 — 「用別的模型的窗口去夾」是本里程碑的核心風險。 — 錯的代價：一條測試。
- **T2 修 1**：**兩半一起釘**（declared 臂的窗口 ＋ inherit 臂的兩個數字）而不是只補實作提議的那一個。 — 這是 spawn 路徑同一個缺陷的同一個形狀，只補一半等於下一輪再來。 — 錯的代價：兩條測試。
- **T2 修 2／放寬我自己訂的硬邊界**：declared 臂**回退到 session 窗口**那一條（實作依邊界只回報）⇒ **仍修**。 — 理由是**後續任務建在它上面**（T3 就是把這條路端到端接起來的那個），而流程的規則是「真實且被後續依賴 ⇒ 裁決並修」；我在上一輪明文說過「第四個只回報」，**放寬的理由寫在 ledger 裡讓人看得見**。 — 錯的代價：一條測試；以及「我訂的邊界可以被我自己解讀」這件事。
- **T3 修 1**：`contextWindow` 那半在 host 端**完全沒有見證** ⇒ 補一條（8k 窗口 ＋ 100k cap ⇒ 斷言 < 100k）。 — 那是本任務**一半的目的**沒有觀察者，且是里程碑的頭條行為。 — 錯的代價：一條測試。
- **T4 修 1**：①**core-agent 那一跳**（生產唯一會走的路）沒有任何見證 ⇒ 補在 `overflow.test.ts`（用手動 `compact!()` 確保錄到的請求可證明是摘要器的）；②夾取**漏掉 host overhead** ⇒ 補上（與 session 的夾取同一筆）。 — 前者是本任務價值唯一的端到端見證；後者是「輸入估價偏低 ⇒ 夾取太寬 ⇒ 回到 400」的真實缺口。 — 錯的代價：兩處小改 ＋ 一條測試。
- **T4 修 2**：overhead 在 **legacy 文字路徑**上也被計入 ⇒ 那條請求本來沒有 prompt／tools，於是可能讓**原始 cap** 出去（本階段的缺陷在一條可達分支上存活）⇒ 條件化。 — **那不是覆蓋率問題，是缺陷。** — 錯的代價：一行 ＋ 一條案例。
- **T5 修 1**：①送出的**普查註解少算**（說四個、實測八個）⇒ 修；②CLI 的句子比它指名的臂**窄一點**（那條臂也涵蓋「呼叫回了但輸出被拒」）⇒ 修。 — 註解唯一的功能就是那個普查，而本樹的成文規則是「沒有量過的數字不寫」。 — 錯的代價：兩行。
- **T6（閘門）**：reachability 434 → 432 ⇒ **量到行級**才下結論（用暫時 worktree 對差列集合）⇒ 一列合法、一列遮蔽；**不自行判決**，把量測交給終審。 — 這台儀器的盲點是已被記錄的陷阱，而「少報一列」與「多報一列」在本階段的 gate 上都只會顯示 PASS。 — 錯的代價：若我猜錯，終審會拿到一個錯的事實。
- **fix wave**：終審 I3（**第三條出口**）**修而不是記成殘餘**——代價是它不在計畫的檔案清單裡（跨到 `session-title` ＋ `apps/cli` 的兩個 `const` → `let` 的 hoist）。 — 本階段的宣稱是「**每一條**出口」，留一條就讓那句話是假的；而終審量到的傷害雖低，卻是本階段自己的缺陷形狀（anthropic 的未夾取 fallback）在一條**可由 CLI 到達**的路上。 — 錯的代價：一個超出計畫範圍的檔案（實作量到那兩個值不在呼叫點的 scope 內，選擇 hoist 並**回報**而不是停手——終審複審判定那個 hoist 最小且不改變行為）。

**累積的一課（第四次到第八次）**：**計畫的突變預測常常是錯的**——本階段實作者**六次**量到「計畫說的那個編輯殺不死它宣稱要殺的測試」（T1 (c)、T2 (a)、T4 的 case-1 窗口、T5 的普查行號、T4 的 legacy、以及 T3 的窗口半）。每一次都**回報而不是換一條測試**，而那個紀律正是「宣告臂不得借用 session 的數字」最後能在兩條路徑上都被釘住的原因。

---

## 4. 殘餘（本階段**不做**，逐條具名）

1. **子代理自己的壓縮**：子代理有窗口而**沒有 compactor** ⇒ 預算階梯的第 1、2 層對它不可用，超過窗口的九成（`reserveRatio` 預設 0.9）**直接硬失敗** `prompt_too_long`。**這是刻意的**（無聲送超窗請求換成大聲失敗），但沒有壓縮可救。
2. **子代理的 telemetry**：`token/usage` 需要 `deps.telemetry`，子代理的兩個建構點都沒有 ⇒ metrics sink 看不到子代理的 token。
3. **`forkTurns` 預設 `"all"`**：子代理的第一個請求就是父的整份逐字稿 ⇒ 一個接近窗口的父session spawn 出來的子代理會從一開始就超過預算，而它沒有壓縮可救。
4. **配置了模型的 guardian**：它的窗口與 cap 在該站點**結構上不可知** ⇒ 依「缺席即缺席」不傳。要修得讓 host 連它的 binding 一起交進來。
5. **四個「窗口那半」的 hop 沒有觀察者**（`assembly.ts:1146`／`:1182`、`agent-team/src/scheduler.ts:221`、`guard-approval/.../reviewer.ts:178`）：接線與型別都對，但一個接錯的變數不會被任何測試抓到。
6. **rebuild 的 declared 臂 cap 回退**沒有擊殺點（四種組合釘了三種）。
7. **`maxOutputTokens` 沒有輸入驗證**（`createAgent` 驗 `budget.contextWindow` 但不驗 cap）：host 給 `0` 會把 `max_tokens: 0` 送上 wire。**與主 session 共用的既存洞**，今天不可達。
8. **`overheadTokens` 對子代理不可觀察**（把它拿掉，套件仍全綠）——它動的是階梯的門檻，不是請求，不等式吸收了它。
9. **`Number.isFinite` 那半的 guard 四家都沒被釘住**（M72 Ⅲ §4.8，pre-existing）。
10. **本機的兩個負載 flake**：`session-executor/test/shell-promotion.test.ts > W10 FALSIFICATION` 與 `apps/cli/test/cli.test.ts > headless CLI W10 foreground promotion`。兩者都是**真子行程的時序測試**；本 session 自己的並行 subagent 會餵它們。**不屬本分支**（M12 retry 的修法已在 PR #7）。
11. **`reason` 是同義異義詞**：telemetry 事件的 `reason` 是**觸發源**（`"auto" | "manual"`），結果的 `reason` 是**失敗因**。
12. **`apps/cli/src/run.ts` 的檔頭註解位置**（在 `CLI_COMMAND_NAMES` 上方而不是 handler 上方）——pre-existing。

---

## 5. 它不保證什麼（明說）

1. **不保證子代理跑得完**：給了窗口之後，一個真的超窗的子代理會**失敗**而不是**變慢**（§4.1）。那是刻意的，也是本階段最重大的行為改變。
2. **不保證配置的 guardian 有預算**：那條路上「不知道的數字不傳」是原則，代價是它沒有預算。
3. **不保證 overhead 精確**：它是估計（system prompt ＋ tool schemas 的字元／4），與主 session 的同一條慣例。
4. **`compaction` 的 legacy 路徑仍可能送出不夾的 cap**：那條請求沒有 prompt／tools 可計價；本階段讓它**不計** overhead（否則會更糟），但當輸入真的佔滿窗口時，`clampOutputCap` 的原值回傳臂仍會讓 cap 原樣出去。

---

## 6. 終審與 fix wave

**終審（opus，`10588e2..901d74d`，19 commits）＝ 0 Critical／3 Important／5 Minor，判「With fixes」。** 它自己重跑了儀器（432 列）與七個套件，並獨立重算了 `reason` 的普查（8 個生產者）。

**單一 fix wave**（2 commits `d8a7c25`／`4bd2afd`）修了 **I1**（遮蔽的註解 ⇒ 433）、**I2**（配置的摘要器不送 session 的 cap）、**I3**（auto-title 帶上它的夾取）、**M1**（子代理硬失敗的行為改變補上註解＋測試）、**M4**（腐化的引用改成指符號）＋ 兩個一行項。

**限定複審 = 全部 ADDRESSED、無新破壞。** 它另外獨立驗了兩件我指定它判的事：①I3 的 `const`→`let` hoist **最小且不改變行為**（`run.ts:432-433` 宣告、`:532/:536` 賦值、catch 在 `:733` return ⇒ run 區塊只在兩者都賦值之後可達）；②I2 的「inert sibling」（`limits.contextWindow` 在配置情況下仍被 spread）**確實 inert**（`summarizer.ts:215` 把整個 `cappedRequest` 的建構閘在 cap 上）。

---

## 7. 給下一個動這條鏈的人

- **加一條出口時，先問「誰把值交給它」**：本階段兩次由複審抓到「計畫漏了一整跳」，而兩次的症狀都是**型別全過、預算全空**。清單是五跳，寫在計畫的 T3。
- **「宣告的模型有自己的預算」是這條鏈最重要的語意**：`child.ts`、`tools.ts`、`reviewer.ts:149-179` 三處都在守它，而每一處的形狀都是**覆蓋而不是 `??`**。
- **`CompactionConfig.maxTokens` 與 wire 上的 `max_tokens` 是兩件事**（字元切片 vs token 上限）——兩邊的註解都寫了，不要把它們合併。
- **註解會餵儀器也會騙儀器**：本階段自己踩了一次（一句註解讓一列消失）。改任何跨套件的註解時，想想它有沒有點名一個 export。
