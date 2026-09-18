# 後端待辦 — 2026-09-18

**基準**：`m65` @ `a72a9d8`。**每一項的狀態都是量出來的**，不是從文件繼承的。
**這份文件的角色**：路線圖（`docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md`）說的是**要做什麼**；
這份說的是**現在在哪**，以及**哪些東西不在路線圖裡**。兩者不要互相取代。

---

## 0. 一句話

**路線圖 M1–M7 裡，M1/M2 完成、M3 大部分未動、M4/M5/M6 未開始、M7 卡在兩題產品決定。**
**路線圖之外**還有三筆帳：5 個零消費者套件、3 列已裁定的 standing rows、以及一個**我這個 session 可能判錯的契約決定**（§3.1）。

---

## 1. 路線圖的實際狀態

| # | 里程碑 | 分級 | 狀態 | 依據 |
|---|---|---|---|---|
| **M1** | 可達性：重量 → 誠實化 | S | **完成** | `scripts/audit/check-reachability.mjs` 存在並在跑 |
| **M2** | 可達性閘門 | M | **完成** | 472 列基線已種、`--gate`／`--digest`／`--self-test` 三件套齊 |
| **M3** | 量測底座 | M | **大部分未動** | 見 §1.1 |
| **M4** | 耐久 turn 狀態機 | **L** | **未開始** | |
| **M5** | 一致性：工具管線 ＋ prompt 快取 | M | **未開始** | 依賴 M3（T2） |
| **M6** | 廣度：生態 ＋ 介面硬化 | M | **未開始** | 依賴 M5 |
| **M7** | 自我喚醒與記憶 | M/S | **卡住** | **要 Q1／Q2 的答案** |

### 1.1 M3 的五項交付物，逐項量測

| 交付物 | 現況 |
|---|---|
| benchmark harness | **不存在**（`scripts/` 無任何 bench） |
| in-process 診斷 metrics registry | **不存在** |
| fail-loud 崩潰處理 ＋ 優雅關閉 | 部分（1 個檔提到 `uncaughtException`／`unhandledRejection`） |
| secret redaction | 部分（3 個檔提到 redact） |
| 本地結構化診斷日誌 | 部分（1 個檔） |

**M3 的完成定義**（照抄路線圖，因為它是可測的）：
> harness 能**偵測一個 10 倍退化**（證明它是偵測器而不是天花板）；一次失敗的執行不需要人手讀 JSONL 就能定位。

**M3 必須排在 M4 之前** —— 否則 M4 的驗證只能靠人工複讀。**這是路線圖自己的硬依賴。**

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

### 2.3 448 條 findings —— **不是待辦**

`439 unused-export ／ 8 unconsulted-setting ／ 1 producerless-event`，全部由基線接受。
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

**在這一題有答案之前，不要再往上蓋任何「前端會用到」的東西。**

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

**這兩題是路線圖 §5 就列好的，不是新的。** 兩題都不答，M7 就不動。

---

## 5. 建議順序

```
1. §3.1  重讀 sections.ts 的裁定（Q6 可能推翻它）      ← 先做，因為它是一次判錯
2. M3    量測底座（harness + crash + redaction + metrics）← M4 的硬前置
3. M4    耐久 turn 狀態機（L）                          ← 路線圖裡唯一「崩潰會產生錯誤答案」的主題
4. M5 → M6                                              ← 依賴鏈
5. schedule 的 spec                                     ← 唯一不需要前端的零消費者套件
6. M7                                                   ← 等 Q1／Q2
```

**為什麼 §3.1 排第一**：一個錯的裁定會讓後面每一次「前端要什麼」的判斷跟著錯。**它比任何實作都便宜，也比任何實作都貴。**

---

## 6. 這份文件沒有建立什麼

- **沒有重測路線圖的每個聲稱**，只重測了**狀態**（里程碑做沒做、交付物在不在）。路線圖引用的證據（沙箱的 `0.056–0.125 ms/call` 等）**沒有重新量**。
- **448 條 findings 沒有逐條分類**，只按套件與類別數了。
- **零消費者套件的掃描是文字比對**（`import` 出現與否），不是模組圖。它會漏掉動態 import —— 這個樹裡沒有這種用法，但方法本身不保證。
- **`schedule` 的「三件缺失」是照抄既有稽核的**，我沒有在這次重新驗證。**要動它之前先重測。**
