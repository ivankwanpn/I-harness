# 執行記錄 — M5／T4 block ① · 軟失敗信封

**日期：** 2026-09-20 · **分支：** `d4-endpoint-cache`（接續，未另開）
**範圍：** block ① —— **9 個程式提交 · 10 個檔 · +713 / −71**（`62e28a86` … `637f73e1`，其間夾著 20 個計畫／文件提交；自計畫建立 `0a4e3635` 起共 **29 個提交**）
**前置：** `docs/superpowers/specs/2026-09-20-m5-t4-tool-pipeline-design.md`（**§2 是這一塊的契約；§2.6 是施工期間量到才寫的**）· 計畫 `docs/superpowers/plans/2026-09-20-m5-t4-block1-envelope.md`
**性質：** 這份是**給複核者的記錄**。每個決定都可檢查；**錯了的代價寫在旁邊。**

---

## 1. 這一塊在做什麼

**修正前**：一個工具本體丟出，**整個 batch 的結果被丟棄** —— 沒有 `tool/result`、沒有 `turn/end`，而**從外面看那個 turn「像掛住」**。那句話不是我的推論，是 `packages/fs/src/error.ts:20-31` **自己寫下來的**。

**修正後**：

| | |
|---|---|
| **工具本體丟出** | **軟** —— 失敗的呼叫拿到一筆 `TOOL_FAILED` 的 `tool/result`，**turn 繼續**，模型看得見錯誤 |
| **從未開始的兄弟** | 一筆 **`TOOL_CANCELLED_BY_SIBLING`** —— **訊息與中止不同**（「使用者停了這一步」與「同批的工具壞了」是兩件事） |
| **政策拒絕** | **大聲** —— 由**站點**（`prepare`）或**標記**（cascade 的否決）結構性地決定，**不是一份清單** |

**而核心宣稱的**準確**範圍**（終審要求收窄的）：

> **這個保證是**軟路徑的**，不是這個函式的。** 一個**含拒絕的批次**仍然按設計丟棄它的結果，而**提交巷的丟出會讓游標停在它發生的地方**。

---

## 2. 怎麼驗

```bash
# ⚠ 先數母體。這條指令在任何套件紅的時候只跑一個前綴（量過：58/66，8 個從未啟動）
pnpm -r --no-bail test        # exit 0 · 母體必須是 66 · 2638 passed / 0 failed / 9 skipped
pnpm -r typecheck             # 0 error lines
node scripts/audit/check-reachability.mjs --gate   # gate PASS -- no new rows（446 列，--self-test 36/36）
```

**兩個既有的 flake**（都不是這一塊的回歸）：`packages/session-executor/test/shell-promotion.test.ts` 負載下 30 秒逾時；`apps/cli/test/input-tiers.test.ts` 的 executor 案例滿載下紅、隔離跑必過。**看到它們紅：重跑一次、繼續。**

---

## 3. 三個洞 —— **沒有一個是設計階段想到的，三個都是複審量出來的**

**這一節是這份文件最重要的部分**，因為它說明這一塊的形狀：**核心機制從第一天就是對的，而三個洞都在它的邊界上，而它們的形狀是同一個。**

### 洞 1 —— 一個**還在飛**的否決被靜默降級成軟的

`:281` 的判準讀 `firstRefusal`，而它的**兩個寫入點都在 `.catch` 裡**，而**判準之前沒有任何地方 await 過在飛的 promise**（那個 `allSettled` 在判準**之後**）。

**量到**（真的 `HookBlockedError` 從真的 `tools/execute` cascade 丟出）：否決先落地 ⇒ **`THREW: read disabled`**；否決晚 100ms ⇒ **`RESOLVED`**，而那一筆**記成兄弟的 `{"error":"boom"}`**。

**⇒ 同一個具型錯誤，只因為 microtask 的先後，就大聲或變軟。** 而可達性是普通的：**`pre-tool` 是一個子行程**（`packages/hooks/src/runner.ts:105` 的 `spawn`）。

**修法**：在 abort 分支與拒絕測試之間**加一次 drain**。**回歸測試加了一個 microtask 邊界** —— **因為「零跳」的版本在突變下仍然綠**（那個 `.catch` 比判準早一個 microtask，於是 drain 觀察不到）。**殘留風險**：那條測試的敏感性是**一個 microtask 深**，**一次在判準前多一個 `await` 的重構會讓它靜默地再次不可證偽，而只有那個突變抓得到。**

### 洞 2 —— 每一格都被蓋上**第一個**錯誤的訊息；然後是「`undefined` 也算」；然後是**處理器的順序**

**同一條路徑，三次：**

| 次 | 形狀 |
|---|---|
| 1 | `firstError` 的訊息被蓋在**每一格**上（一個 `"B error"` 的呼叫記成 `{"error":"A error"}`）—— 而上面三行的註解寫著 `(honestly)` |
| 2 | 改成 `failures.get(i) !== undefined` ⇒ **分不出「記了一個 `undefined`」與「沒有這一筆」** ⇒ 一個以 `undefined` 拒絕的 body 被蓋上兄弟的訊息 |
| 3 | 改成 `failures.has(i)` ⇒ **而 `.catch` 處理器裡 `telemetry.emit` 與 `isPolicyRefusal(err)` 跑在 `failures.set` 之前** ⇒ 那兩行任何一行丟出，那一格就沒有記錄 ⇒ 回退到 `firstError` |

**⇒ 而第 3 次是終審找到的，而那是我叫它「假設第三個存在並去找」的結果。**

**修法**：`failures.set(index, err)` 是那個 `.catch` 的**第一句可執行敘述**。

### 洞 3 —— 一個 `throw undefined` 的首次失敗讓整個批次寫下**零筆**結果

`firstError` **同時是旗標與值** ⇒ `throw undefined` 觸發了 `batchAbort.abort()`，**卻讓每一個 `if (firstError)` 讀到 falsy** ⇒ 軟路徑不跑、從未開始的填補也不跑 ⇒ **一個 `tool_use` 沒有 `tool_result`，而沒有任何測試會紅。**

**修法**：一個獨立的 `hasFailed`。**而實作 T6 時，它把同一個教訓套用在新的變數上**（`hasCommitError`，因為 `throw undefined` 是合法的）。

**⇒ 而這**三個洞是同一個區別的三次**：**一個變數不能同時當旗標與值。** 這一塊裡它出現了**五次**（`firstRefusal` 與 `failures` 避開了，`firstError` 與 `commitError` 沒有）。

---

## 4. 裁定與**錯了的代價**

| # | 裁定 | 代價若錯 |
|---|---|---|
| **R1** | **分類靠站點 ＋ 標記，不靠清單** | 一份清單會腐化，而腐化的方式是「一個新的拒絕靜默變軟」——**沒有測試會紅，因為那個拒絕還不存在** |
| **R2** | **標記住在 `core-tools`**（不是 `instanceof`） | 那會讓 `core-agent` 依賴 `hooks`——**一條不該存在的依賴邊** |
| **R3** | **`TOOL_CANCELLED_BY_SIBLING` 與中止**碼與訊息都不同**** | 一份日誌分不出「使用者按了停」與「工具壞了」 |
| **R4** | **接縫不加錯誤旗標**（`is_error`） | **一個沒有讀者的欄位就是這份設計在消滅的東西**（見 §7 的 `outputSchema`）。代價：日誌分不出成功與失敗，**除非看形狀** |
| **R5** | **T5 的 bare catch 收窄成「填補照跑、然後重拋」** | 一次 durable 寫入的失敗會變成一個**靜默繼續的 turn**，而**沒有遙測、沒有標記、日誌只提交了一半** |
| **R6** | **三個 export 進 allowlist**（有日期、有理由） | 工具自己的檔頭說「judgements belong in the allowlist, not in a cleverer regex」；**而列集在所有註解前後都是 446 ⇒ 沒有任何東西被遮蔽** |

---

## 5. 這一塊**推翻**的既有決定（**留痕，不默默改**）

| 在哪 | 原文 | 為什麼不成立 |
|---|---|---|
| `execute-tool-calls.ts:45-46` | **Failure (throw-fails-turn, ruling A)** … rethrow the first error — **NO fabricated results for unstarted calls** | **rethrow 那一半被推翻**。「不捏造」那一半**保留** —— 從未開始的呼叫拿到的是一句**事實** |
| `execute-tool-calls.ts:255` | **Failure: drain started (results discarded), rethrow the first error.** | 「results discarded」正是 §1 那個後果的來源 |
| `execute-tool-calls.ts:228-229` | …**Abort path ONLY** — the non-abort failure path still discards (M13). | **被推翻的是它的範圍，不是它的理由** |
| **roadmap §M5 的字面** | 「統一的 **tool-result** schema 驗證層」 | **結果那一半零主體**（`outputSchema` 全樹含測試只有 1 處，就是那行宣告）。**有主體的是參數那一半** |
| **dsh 的 `type arrays are not supported`** | `json-schema.ts:304-306` | IH 用它一次（`subagent/src/tools.ts:77`），而那一處是**合法的 JSON Schema** |
| **dsh 的 `.properties must be an object of schemas`** | `json-schema.ts:330` | IH 有一處是 `properties: undefined`（`plan-mode/src/index.ts:25`） |

**⇒ 而這一塊的紀錄是**它自己的三個洞**那一節（§3），不是這一節。** 留痕在這裡是為了讓下一個人分得出「當初決定什麼」與「後來做了什麼」。

---

## 6. 已知邊界（**接受的，附量測**）

| # | 是什麼 | 量到什麼 |
|---|---|---|
| **B1** | **排在一個丟出的 `tools/post-execute` 監聽者**後面**的已落地兄弟仍然丟失** | 有 try/catch：從未開始的拿到 `CANCELLED`，**而落地的兄弟仍然丟失**。**abort 分支有同一個洞**（它緊接著 throw，所以不會留下一個繼續跑的 turn —— 軟路徑的可以） |
| **B2** | **一個含拒絕的批次仍然按設計丟棄它已落地的分派** | `[slowOk(20ms), vetoedTool]` ⇒ **REJECTED，結果 `[]`** |
| **B3** | **提交巷的丟出讓游標停在它發生的地方** | 那之後的格子不進日誌 |
| **B4** | **`rejects.toThrow("agent aborted")` 是**子字串**斷言** | 在 abort 訊息後面接 `" (MUTANT)"` ⇒ **23 條全綠**；改名 ⇒ 五條全紅。**合約被釘成一個詞，不是那個訊息** |
| **B5** | **那條否決測試的敏感性是**一個 microtask 深** | 一次在判準前多一個 `await` 的重構會讓它**靜默地再次不可證偽** |
| **B6** | **一個 `policyRefusal` 讀取會丟出的錯誤無法被**分類**** | 它的**記錄**現在是對的（自己的訊息）；只有**分類**不可能 |
| **B7** | **一個在完全成功的批次裡落地的 abort**，現在會在一切已提交之後丟 `agent aborted`（修正前它返回） | 方向與「abort dominates」一致，而**結果已經在日誌裡**。**沒有測試釘它** |

---

## 7. 這一塊**沒有**做的

- **block ②（參數 schema 層）與 ③（界）** —— 各自有自己的計畫。**這一塊是 ①，也只有 ①。**
- **`outputSchema` 的強制** —— **零主體**（全樹含測試只有 1 處，就是那行宣告）。要它有意義得先遷移 30 個檔的工具去宣告輸出 schema。
- **接縫的錯誤旗標**（`is_error` / `status: error`）—— 見 R4。**那是五個適配器 × 五種協議的變更，是另一個單元。**
- **`prepare` 的政策丟出改成軟的** —— 那些是 **fail-closed 的安全態勢**，不是模型可以重試的東西。
- **把散落的界收斂到同一處** —— `shell` 64KB、`exec` 64KB、`web` 128K chars、`compaction` 8,192 chars **維持原位**（它們服務不同的東西）。
- **`tool/dispatch`（M4）** —— 不動。**它的註解自己寫著它存在的理由就是分辨「從未派送」與「派送了、下落不明」** —— 而這一塊讓後者變得更少。

---

## 8. 這一塊真正的形狀：**作者的產物被下游更正了二十三次**

**六個任務，計畫被改了 14 次，而**我的指令錯過二十三次**。它們的形狀高度一致：

| 類別 | 個數 | 例子 |
|---|---|---|
| **寫下一個沒先量的數字** | **7** | `2629`·`30/1`·`242+1≠244`·「五條 abort 測試」（量到四條）·兩個行號·**449ms** |
| **寫下一個做不到的指令** | **4** | 「`hooks` 必須全綠」·「gate 必須 PASS」（兩次）·「從 `core-agent` 匯入 `@i-harness/hooks`」 |
| **用推論代替量測** | **3** | `hooks` 那條測試的**機制**（我錯了）·爆炸半徑（1 條 → 9 條）·`failures` 的 fallback |
| **修實例而不是修類別** | **2** | T6 只列 `index.ts` 一處（實際四處）· `has` 修完沒問「還有什麼能讓它可達」 |
| 其他 | 7 | |

**而抓到它們的**全部**是下游的量測，不是我的判斷。** 三個洞由三個不同的複審找到；**449ms** 由終審找到（而它是一個子代理在報告裡量到的數字，我寫進計畫，**它從那裡走進一個已提交的測試註解 —— 每一跳都讓它看起來更有權威，而沒有一跳有 artifact**）。

**複核者請這樣讀這條分支：** 那 14 次計畫修正與一長串 fix-round 提交**不是「不穩定」的訊號**，而是**每一個提交都對應一個被抓到的具體缺陷**的訊號。

**而其中一次是這一塊最值得記的形狀**：實作者**拒絕照著計畫做**（它量到 13 條既有測試轉紅），**回報，然後拿到一個修正過的計畫**。**那一次如果有任何一方「照規矩來」，這一塊會出貨一個把政策拒絕變軟的排程器。**

### 8.1 三個關於**工具**的發現（不只這一塊）

1. **`pnpm -r --no-bail test` 在有紅的時候只跑一個前綴。** 實測：58 個套件回報、**8 個連起始行都沒有**（最大的八個），然後 `ERR_PNPM_RECURSIVE_FAIL`。**⇒ 一個紅的全套數字是一個前綴，而它看起來完全像總數。閘門必須兩步：先數母體，再比數字。**
2. **可達性掃描器**不剝註解** ⇒ 一個名字寫在別人的註解裡會讓那一列消失。** 實測：在 `execute-tool-calls.ts` 開頭加一行提到 `PolicyRefusal` 的註解 ⇒ **gate 從 3 NEW rows → 2**。**⇒ 一句「這個有接上」的註解會讓這個工具同意。**
3. **`cp -a` 不能隔離這個 repo** —— `node_modules/@i-harness/*` 是 **Windows Junction（絕對路徑目標）**，複製會 dereference ⇒ **一個「隔離」的複本會安靜地測到真樹。** 複審們改用 Vite 的 `load` hook（記憶體）或 `git-archive`。

---

## 9. 工作電腦接手時

- 分支**未推**，領先 `origin/d4-endpoint-cache` **31 個提交**。
- **不合併、不改名、不刪。**
- 讀計畫時，**§5 那六處被取代的段落先看**，否則會以為程式碼漏做了 spec 要求的事。
- 全套跑紅 `shell-promotion` 或 `input-tiers` 時，**先讀 §2**。
- **這一塊的保證是**軟路徑的**（§1）** —— 三個邊界（B1／B2／B3）是**設計**，不是缺陷。
- 而**§8.1 的三條與這一塊無關**，它們是這一塊**順手量到的、關於驗證工具本身**的發現 —— **它們值得各自的 ticket。**
