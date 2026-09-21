# 後端待辦 — 2026-09-18

**基準**：`m65` @ `a72a9d8`。**每一項的狀態都是量出來的**，不是從文件繼承的。
**這份文件的角色**：路線圖（`docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md`）說的是**要做什麼**；
這份說的是**現在在哪**，以及**哪些東西不在路線圖裡**。兩者不要互相取代。

---

## 0. 一句話

**路線圖 M1–M7 裡，M1/M2 完成、M3 是 4/5、M4 工程完成（只差 Q8）、M5 進行中、M6 未開始、M7 卡在兩題產品決定。**
**路線圖之外**還有三筆帳：5 個零消費者套件、3 列已裁定的 standing rows、以及一個**我這個 session 可能判錯的契約決定**（§3.1）。

---

## 1. 路線圖的實際狀態

| # | 里程碑 | 分級 | 狀態 | 依據 |
|---|---|---|---|---|
| **M1** | 可達性：重量 → 誠實化 | S | **完成** | `scripts/audit/check-reachability.mjs` 存在並在跑 |
| **M2** | 可達性閘門 | M | **完成** | 472 列基線已種、`--gate`／`--digest`／`--self-test` 三件套齊 |
| **M3** | 量測底座 | M | **大部分未動** | 見 §1.1 |
| **M4** | 耐久 turn 狀態機 | **L** | ✅ **工程完成**（`a64fa18` · `491dd10` · `262e245` · `a1ad14a`）—— spec、I1、I2、**路線圖的 spawn 驗收測試**；**只差 Q8**（產品決定） | `docs/superpowers/specs/2026-09-18-durable-turn-state-machine-design.md` |
| **M5** | 一致性：工具管線 ＋ prompt 快取 | M | **進行中** —— T4 的**兄弟取消**已做（`4c85a04`）；**T2 第一半完成**（見 §1.2）；T4 的 schema 驗證層與 **T2 第二半（前綴）**未動 | 前置 M3 已滿足（`58d7db6`） |
| **M6** | 廣度：生態 ＋ 介面硬化 | M | **未開始** | 依賴 M5 |
| **M7** | 自我喚醒與記憶 | M/S | **卡住** | **要 Q1／Q2 的答案** |

### 1.1 M3 的五項交付物，逐項量測

| 交付物 | 現況 |
|---|---|
| benchmark harness | ✅ **完成**（`b6e1f02`）—— `pnpm bench` ／ `pnpm verify:bench`；`--self-test` 證明它抓得到 10 倍退化 |
| fail-loud 崩潰處理 ＋ 優雅關閉 | ✅ **完成**（`ede0850` ＋ `8c34ca1`）—— SIGINT/SIGTERM → abort → 走既有的 `finally`（drain ＋ dispose）；`failureReport` 取代裸堆疊 **與** 失敗 run 的那一行裸訊息 |
| 本地結構化診斷日誌 | ⚠️ **一半** —— 失敗／崩潰報告已經結構化（session、error、frame、損失契約）；**`console.warn/error` 站點沒有分級**。量過：那些訊息確實是**不同類別被壓平**（fail-soft 降級、CLI 用法錯誤、背景失敗），所以分級**有價值** —— 但那是**站點數**的遷移。**⚠ 而「79」是一個會腐的數字**：它量於 `ede0850`，**而在寫下它的下一筆提交（`24d6051`）樹已經是 80**（中間的 `8c34ca1` 加了一處）；**2026-09-21 在同一範圍重測是 110**（`packages/*/src` ＋ `apps/*/src`，`console.warn|error`）。**要排這個工作時先重量 —— 見 `docs/handoff/2026-09-20-queued-work.md` §6 的實測。** |
| secret redaction | ⚠️ **缺口示範不出來** —— 見下 |
| in-process 診斷 metrics registry | ✅ **完成**（`58d7db6`）—— `createMetricsSink` 是一個 `TelemetrySink`（**零 emit 站點**）；`run.ts` 接上它，`--telemetry` 時在 **stderr** 報 summary |

**「secret redaction」為什麼標成「示範不出來」，而不是「未做」。** roadmap 引的是跨專案 triage 的措辭
（*"secret-redaction-before-log-and-sink"*），不是這裡量到的缺陷。**照量測**：

- 遮蔽**已經存在**，在 view 那一域：`settings/sections.ts` 的 `redactForSchema`／`redactRecord`，
  帶 `secret` / `credential-ref` 兩種角色；`credentials.describe` 也是單向遮蔽。
- 日誌那一域：**沒有任何 console 站點印出 config 物件** —— 全部是 `err.message`、檔案路徑、或
  server 名 ＋ 原因。
- 金鑰只在 **adapter 邊界的 header** 進出（`Authorization`／`x-api-key`），`llm-seam` 的 throw
  **全是設定驗證**（路徑 ＋ 數字），telemetry **從未見過 `apiKey`**。

**所以沒有找到可示範的洩漏路徑。** 這一項的處置是**繼續量**而不是**先建一個濾網** —— 一個沒有
已知輸入的濾網，正是這份文件在別處拒絕的那種東西。

**M3 的完成定義**（照抄路線圖，因為它是可測的）：
> harness 能**偵測一個 10 倍退化**（證明它是偵測器而不是天花板）；一次失敗的執行不需要人手讀 JSONL 就能定位。

**M3 必須排在 M4 之前** —— 否則 M4 的驗證只能靠人工複讀。**這是路線圖自己的硬依賴。**

### 1.2 M5／T2 的兩半，逐項量測

設計在 `docs/superpowers/specs/2026-09-18-m5-t2-prompt-cache-continuity-design.md`。

| 半 | 現況 |
|---|---|
| **第一半：以 provider 回報為事實** | ✅ **完成** —— seam 長出 `LLMUsage` ＋ `usage` 成員；`provider/usage` 新 telemetry code；`core-agent` 合併後發出**恰好一筆**；sink 長出 `reported` 區；`[metrics]` 印它；`llm-anthropic` 映射 |
| **第二半：以自己的位元組為偵測** | **未動** |

**量到的三件事（都是這一項獨有的）：**

1. **缺口不是推論出來的，是三個 adapter 各自記下來的** —— `llm-gemini:237-241` 的字面是
   *"a future usage seam slot"*，`llm-bedrock:225-229` 說 *"same gap as llm-anthropic / llm-gemini"*。
   全詞彙 grep 在 `src` 只有**一個**命中，而且是一句**註解**。
2. **一個現成的紅燈早就在樹裡** —— `llm-bedrock/test/bedrock.test.ts:161` 餵了一份 usage fixture，
   而 adapter 把它丟掉。第一半的 RED 不需要憑空造輸入。
3. **一個實測到的缺陷，靠寫測試才發現** —— `createRetryingClient` 的重試是**靜默的**，
   而它的用量事件第一版是即時 `yield` 的，所以**一次完成的往返收到兩份報告**
   （`expected [ {…}, {…} ] to deeply equal [ {…} ]`）。**這比沒有指標更糟：一個看起來像量測的錯數字。**
   修法是包裝把用量**扣留到該次嘗試證明自己跑完**。

**這一項的完成定義要兩半都有。** 第一半做完**不等於 M5 做完**。

---

## 2. 路線圖之外的三筆帳

### 2.1 五個零消費者套件（量測方法：逐一 package 掃 `src/`，對照組驗證）

對照組：`core-session` 48 個生產消費者、`session-persistence` 18 個 —— 所以掃描有效。

| 套件 | 處置 | 消費者 |
|---|---|---|
| `fs-watch` | **等前端** —— 它自己的 roadmap 條目（R-B9）說「消費方未定，真正收益在 UI 面」 | 前端 |
| `goal` | **等前端** —— view model | 前端 |
| `jobs` | **等前端** —— 它自稱「web 的 jobs surface」 | 前端 |
| `workspace` | **等前端** —— SPA sidebar 的專案分組 | 前端 |
| **`schedule`** | **需要一份 spec，不是接線** | **無（從未有人）** |

**`schedule` 是三件缺失，不是一件**：agent 沒有工具可以建立排程；driver 沒掛進組裝；`onDue` 沒有實作者。
**這一項不需要前端，是這五個裡唯一現在可動的。**

（`plugin-registry` 與 `hooks` 原本也在這份名單上 —— 兩者已在 2026-09-17/18 接上生產路徑。）

### 2.2 三列 standing rows —— **全部已決定，沒有懸而未決的**

| 列 | 處置 |
|---|---|
| `settings#describeSection` | 裁定：**存活**，allowlist 一條承載類別 |
| `settings#SettingsConflictError` | 同上（同一類） |
| `workflow#createWorkflowJobStore` | **刻意留著** —— 真正的代價是測試隔離（`jobs` 是選填，預設行程級單例），比一列 row 貴 |

### 2.3 447 條 findings —— **不是待辦**

`438 unused-export ／ 8 unconsulted-setting ／ 1 producerless-event`，全部由基線接受。

**⚠️ 這一節原本寫 448（`439／8／1`），而那個數字在每一版修訂裡都沒被重測過。** 2026-09-18 重測是
**447**，少的一列是 `unused-export`。寫在這裡，因為一份自稱「量出來的」文件不該有一行是抄的。
**閘門只對「新增的」失敗**（路線圖 §3.M1 的明文裁定），所以這份清單不是工作佇列。
唯一相關的動作是**別讓新的長出來**，而那是 M2 已在做的事。

---

## 3. 這個 session 產生的、需要後續處理的東西

### 3.1 ⚠️ 一項**已證實前提錯誤**的契約裁定 —— 先看這條

**2026-09-18 我把 `sections.ts` 的契約裁定為「存活，前端重建會需要它」。**

**那個前提站不住，而且不是推論 —— 是量出來的。**

路線圖 **Q6**（2026-09-15，人類已決定）：

> 未來前端的後端契約是 **`@i-harness/sdk` 的 wire**，**而不是 in-process 的 `createSessionService` API**。「重建前端」是一個**客戶端專案** —— 後端的責任是**讓那條 wire 值得被蓋在上面**。

**而那條 wire 的方法是封閉列舉的**（`packages/sdk/src/server.ts:5-39`）：

```
initialize · shutdown
session/prompt · session/status · session/history · session/list
session/cancel · session/queue · session/queue/cancel · session/rewind/{points,plan,execute}
```

**沒有 `settings/*`。一個都沒有。**

**所以：一個照 Q6 蓋的前端，讀寫不了設定。** `describeSection` / `mutateSection` 是 in-process API，
**前端碰不到它們** —— 我那條「存活，因為前端需要」的裁定，**理由與結論對不上**。

**結論（留著）可能是對的；理由（前端會用）是錯的。** 真正的問題是這一個：

> **設定是不是前端的事？**
> （a）是 → wire 要長出 `settings/*`，而 `sections.ts` 就是它的 backing store（此時裁定成立，但要改寫理由）；
> （b）不是 → 設定是操作者的事（config 檔 ＋ CLI），前端只顯示不編輯，`sections.ts` 該往別的方向處置。

#### 我的建議：走 (a)，但現在不建。

**理由（三條，每一條都可檢查）：**

1. **功能上需要，不是推測。** 一個讀寫不了 API key 的前端是不完整的產品。這不是「也許會用到」，是
   「一個設定面板是這種產品的標準配備」。
2. **wire 本來就不是純 session 的。** `initialize` 已經回 `capabilities`（`server.ts:6`），
   所以這條 wire 一開始就帶了一點「啟動設定面」的性質。加 `settings/*` 是把已有的性質講明白，
   不是把一條 session 契約撐歪。
3. **`sections.ts` 的形狀正好是這種 surface 的 backing**：封閉 union（少數幾個 section，不是註冊表）、
   路徑尋址的通用 op（沒有 per-section 動詞可以長出來）、revision guard（CAS，與 wire 的
   `-32603`／`-32602` 錯誤語意同族）。**它現在缺的不是設計，是消費者。**

**但觸發條件必須是「前端做到需要設定面」那一刻，不是現在。**

**理由是本 repo 自己的規矩**：Q4 立過同一條 —— *「不做 MCP server 模式，延後到有具名消費者」*，
而 §5 Q5 也是同一個判斷。**現在建 `settings/*` 就是為一個還沒有名字的消費者建東西**，也就是 Q4
拒絕的那件事。**「前端遲早要」跟「有具名消費者」在這裡不是同一句話**，而路線圖選的是後者。

**所以 `sections.ts` 的處置不變（留著），但理由改成：**

> **它是 wire 未來 settings 面的既定形狀** —— 不是「前端會用到它」。

**在觸發之前不要再往上蓋任何依賴那句讀法的東西。**

### 3.2 hooks 的批准 UX —— **只有 CLI 版**

`i-harness hooks list|approve|revoke` 在（`997065c`），所以規則**可以被滿足**。但**產品上**外掛的 hook 永遠不執行，因為批准只有開發者能做。**前端要長自己的，共用同一個 store**（`<home>/hook-trust.json`）。

### 3.3 三個「值得拿但沒拿」的東西（來自三個出貨產品的調研）

| 想法 | 來源 | 狀態 |
|---|---|---|
| **帶理由的禁用清單**（每條禁令附「該用什麼」） | Grok 的 `clippy.toml` `disallowed-methods` | **未採用**。我們的儀器**報告**漂移，那個**阻止**漂移 |
| **信任邊界自己不可寫**（把信任 store 唯讀 bind-mount，套不上就拒絕啟動） | Grok | **未採用**。我們的 store 在 `~/.i-harness/`，agent 自己就能改 |
| **損失契約**（明寫「崩潰最多掉什麼」） | Grok 的 persistence actor | **未採用**。我們的「200ms 截止 + in-flight」是量出來的，但沒有寫下來 |

**證據在 `docs/handoff/2026-09-18-prior-art-survey.md`。**

---

## 4. 需要**你**決定的（我定不了）

| # | 問題 | 我的建議 | 卡住 |
|---|---|---|---|
| **Q1** | IH 要不要有專案層設定信任？ | **暫不**（「第二個真相來源」論證） | M7 |
| **Q2** | 閒置自我喚醒是不是產品目標？ | **暫不作為目標**（會改變 IH 的定位） | M7 |
| **Q7** | **設定是不是前端的事？**（§3.1） | **是（走 (a)），但現在不建** —— 觸發條件是前端做到需要設定面 | `sections.ts` 的處置 |
| **Q8** | **舊日誌要不要保守？**（M4 spec §3.4）今天寫的每一份 log 都沒有 `tool/dispatch`，所以復原**分不出**「沒派送」與「派送了、下落不明」 | **保守：一律 `outcome-unknown`** —— 代價是舊 session 的工具全部要人看；不保守則沿用今天行為，但**把一個我們明知不知道的東西判成 benign** | M4 |

**Q1／Q2 是路線圖 §5 就列好的，不是新的；Q7 是今天量出來的。** 三題都不是「現在就要動」——
**Q1／Q2 不答，M7 不動；Q7 不答，只是不要在它上面蓋東西。**

---

## 5. 建議順序

```
1. ✅ §3.1  重讀 sections.ts 的裁定（Q6 可能推翻它）      ← 先做，因為它是一次判錯
2. ✅ M3    量測底座（harness + crash + redaction + metrics）← M4 的硬前置（4/5；兩項在 §1.1 仍開著）
3. ✅ M4    耐久 turn 狀態機（L）                          ← 路線圖裡唯一「崩潰會產生錯誤答案」的主題（只差 Q8）
4. ▶  M5 → M6                                            ← 依賴鏈（M5 進行中：T2 第一半完成，見 §1.2）
5.    schedule 的 spec                                   ← 唯一不需要前端的零消費者套件
6.    M7                                                 ← 等 Q1／Q2
```

**為什麼 §3.1 排第一**：一個錯的裁定會讓後面每一次「前端要什麼」的判斷跟著錯。**它比任何實作都便宜，也比任何實作都貴。**

---

## 6. 我的建議（§4／§5 以外的）

### 6.1 `schedule` —— 先寫 spec，不要先接線

它是五個零消費者套件裡唯一不需要前端的，**但它缺的三件會互相決定**：agent 用什麼工具建立排程、
driver 讀什麼、`onDue` 交給誰。**邊接邊發明等於把三個決定拆成三次猜。**

**建議：一份 spec 把三件一次定清楚。** 這正是路線圖對 M4 做的事（先有 spec 再動介面），
而 `plugin-registry` 是反例 —— 它的兩端都建好了、中間被切斷，那種缺口稽核才看得出來、人看不出來。

### 6.2 三個「值得拿但沒拿」的東西 —— **量過之後，兩個的建議反轉了**

| 想法 | 我原本的建議 | **量測之後** |
|---|---|---|
| 信任邊界自己不可寫 | 建議做 | **不急** —— 見下 |
| 損失契約 | 建議做 | **建議做，最便宜** |
| 帶理由的禁用清單 | 不急 | **不急** —— 我們的儀器**報告**漂移，那個**阻止**漂移，兩者互補；但這棵樹還沒有「同一個錯誤長回來」的實例 |

**「信任邊界自己不可寫」為什麼反轉。** 我原本的理由是「store 是
`~/.i-harness/hook-trust.json`，agent 自己就能改它」。**量了之後**：

- CLI 的預設沙箱是 **`workspace-write`**（`packages/settings/src/index.ts:242`）；
- store 在 **`<harness home>/`**（`packages/hooks/src/trust.ts:57`），**在 workspace 之外**；
- 而 `packages/fs` **確實**有沙箱限制。

**所以預設情況下 agent 改不到它。** 殘留的是 **`danger-full-access`** —— 那個模式拿掉限制，
而 Grok 的 bind-mount 是**核心層**的、不受模式影響。

**建議：不現在做，但把殘留寫下來。** 「預設安全、`danger-full-access` 不安全」是一個**可以被重測的**
事實，比一個「我們應該做 write-deny」的待辦有用。

**「損失契約」為什麼是三個裡最該做的。** 它是**一行註解**，而且它補的是一個**已經存在但沒寫下來的**
事實：`session-persistence` 的 write-behind 是 **200ms 固定截止**、失敗時**保留批次並暫停自動重試**
（掛載點 `apps/cli/src/run.ts` 只在 `turn/end` flush）。三份文件都提到它，**沒有一份寫下「崩潰最多掉什麼」。**

> **已完成（`ede0850`）**，而且落在**最需要它的地方**：`crashReport` 的輸出裡。
> 「已經 flush 的都在磁碟上；write-behind 以 200ms 截止批次、turn 結束時 flush，
> 所以**還在跑的那一輪的尾端可能沒有** —— 那是續行前唯一要重查的部分。」
> **契約寫在崩潰報告裡，因為那是有人需要它的那一刻。**

### 6.3 M3 的五項 —— 建議的順序

```
1. benchmark harness        ← ✅ 完成（b6e1f02）
2. 崩潰處理 ＋ 優雅關閉      ← ✅ 完成（ede0850 ＋ 8c34ca1）
3. 本地結構化診斷日誌        ← ⚠️ 一半（報告已結構化；79 站點未分級）
4. secret redaction         ← ⚠️ 缺口示範不出來（量過，見 §1.1）
5. metrics registry         ← ✅ 完成（58d7db6）
```

**M3 沒有全部做完，而 M4 的前置仍然滿足。** 路線圖對 M3 的硬依賴寫的是
*「否則 M4 的驗證只能像沙箱那次一樣靠人工複讀」* —— **那個依賴是「量測」，而它已完成（第 1 項）。**
剩下的兩項不是 M4 的前置：第 4 項的缺口在這裡量不出來，第 3 項的 79 站點遷移與 M4 無關。

**所以 §5 繼續往下走，而這兩項仍然是開的** —— 不是被放棄，是被排在後面，而且理由寫在這裡。

**理由**：M3 的完成定義要求 harness 能**偵測 10 倍退化**，所以 harness 必須先存在，否則其餘四項
做完也沒有人能說它們有沒有退化。**而第 2 項排第二，理由是它與 M4 同型** —— M4 要解的正是
「行程死了之後狀態是什麼」，M3 的崩潰處理是它的小型版。

---

## 7. 這份文件沒有建立什麼

- **沒有重測路線圖的每個聲稱**，只重測了**狀態**（里程碑做沒做、交付物在不在）。路線圖引用的證據（沙箱的 `0.056–0.125 ms/call` 等）**沒有重新量**。
- **447 條 findings 沒有逐條分類**，只按套件與類別數了。
- **零消費者套件的掃描是文字比對**（`import` 出現與否），不是模組圖。它會漏掉動態 import —— 這個樹裡沒有這種用法，但方法本身不保證。
- **`schedule` 的「三件缺失」是照抄既有稽核的**，我沒有在這次重新驗證。**要動它之前先重測。**
