# 出生（birth）與接手（adoption）語義：重設計評估（2026-11-05）

> 問題：`session-persistence-jsonl` 剩餘 18 個紅檔中，約 40 個測試集中在「bootstrap 出生／resume／adoption」。
> 這些個案每一輪都只前進一兩筆（round 200–218），因此本文件回答一個問題：**要不要重設計？**
> 參考來源：`D:\ih_reference_project`（DSH 0.2.2 / codex-rust / opencode / pi / ZCode）。
> 結論先講：**要，但重設計的是「決策模型」，不是儲存格式；而且第一階段不需要動 log 檔的位元組佈局。**

---

## 1. 現況量測（2026-11-05，round 218 後）

`session-persistence-jsonl`：round 218 量測 **20 紅檔 / 93 failed / 764 passed / 17 skipped（98 檔）**；
本次再修掉 `task-transition-header-debt`、`task-transition-stage-revision` 後推算 **18 紅檔 / 91 failed**（尚未重新全套量測）。

| 群組 | 紅檔 | 測試數 | 代表性失敗 |
|---|---|---|---|
| 出生／接手語義 | bootstrap-physical(9)、bootstrap-capture-physical(4)、current-context-predecessors(9)、semantic-codec2-predecessor(10)、format13(3)、format8(2)、format11(1)、child-bootstrap-stage(1)、child-bootstrap-physical(1)、task-transition-bootstrap-revoke(1) | 41 | `expected 'blocked' to be 'ready'`／`'already-ready'`、`not-issued`、`Coordinator cleanup is unresolved` |
| legacy 建構子（D-12 測試債） | replacement-journal(4)、task-document-composition(16)、task-d-repair-header-path(2) | 22 | `TASK_TRANSITION_UNSUPPORTED` |
| 發佈／保護位元組 | semantic-publication(24) | 24 | `bootstrap-incomplete`、protected slot |
| 其他 | archive-stream(hang)、cold-selected-capability(1)、task-document-write-repair(1) | 3 | timeout、cleanup-debt |

**關鍵觀察**：41 筆「出生／接手」幾乎都不是資料損壞，而是**決策函數把可判定的耐久狀態回報成 blocked**。

---

## 2. 根因：決策軸與清理債被混在一起

### R1（主因）`committed + cleanupPending` 被降級成「未解決」

後端其實已經正確區分：

- `packages/session-persistence-jsonl/src/backend/bootstrap-header.ts:260,291`：write+sync 成功、close 失敗 → `{kind:'committed', cleanupDiagnostic:'file-close-failed'}`。
- `packages/session-persistence-jsonl/src/backend/document-write.ts:137-139`：committed 之後 close 失敗 → `cleanupPending: true`。
- 自己的規格也寫得很清楚：`docs/superpowers/plans/2026-10-28-original-task-document-boundary.md:176`「A failed close afterward is committed-with-cleanup-debt, not permission to rewrite or replay」。

但上層把所有 `cleanupPending` 當成語義失敗：

```ts
// packages/session-persistence/src/coordinator/task-document-transition.ts
:198  if (result.kind !== 'committed' || result.cleanupPending) throw new Error('TASK_TRANSITION_TASK_UNRESOLVED')
:212  if (outcome.kind !== 'committed' || outcome.cleanupPending) throw new Error('TASK_TRANSITION_HEADER_UNRESOLVED')
:220  if (outcome.kind !== 'committed' || outcome.cleanupPending) throw new Error('TASK_TRANSITION_HEADER_UNRESOLVED')
:165,:187  if (outcome.kind !== 'confirmed' || outcome.cleanupPending) throw new Error('TASK_TRANSITION_CONFIRM_UNRESOLVED')
```

→ `bootstrap.ts:491` 的 `catch { ... return blocked(entry) }` 把「已 fsync、只差 close」的 header 變成 `blocked`。
→ 對應測試（`bootstrap-physical`「keeps header fsync commitment when file close cleanup fails」）期待 `ready`，因為位元組已承諾。

**實測（本輪）**：該測試實際失敗在 `TASK_TRANSITION_TASK_UNRESOLVED`，來源是 **task document 的 temp close 失敗**（`document-write.ts` 在 rename 前 close 失敗 ⇒ 文件未發佈 ⇒ `result.kind === 'unknown'`），不是 session header。
把 `|| result.cleanupPending` 從 guard 移除後仍然 blocked——因為 `unknown` 是真的「文件沒發佈」。
也就是說：**空的 task document 發佈失敗會擋住整個 session 出生**。而 D-01 已經把 task document 定義成 projection/checkpoint；projection 不應該成為 birth 的 gate。這是 R4 最直接的證據。

### R2 只有一個對外出口，reason 卻有 45 個產生點

`bootstrap.ts` 有 **45 個 `blocked()` 呼叫點**，reason 只有 4 種（`unknown` / `payload-required` / `dependency-unavailable` / `source-changed`）。
呼叫端無法區分「再試一次就會成功」與「永遠不會成功」，測試也只能用整數期待（`blocked→ready`），於是每個個案都要重新推導語義。

### R3 出生狀態機沒有「已發行但未完成」的正規狀態

- `bootstrap.ts:487`：barrier 沒有 mode 且已有 header → `not-issued/unsupported`（`task-transition-bootstrap-revoke` 的紅）。
- round 216 已記錄：`task-document-transition.ts` 的 barrier `prepare()` 只有 `'new'`／`'completed'`／其他三種語義；「header 已提交、seed 未寫」需要第四種（`resume-birth`）但目前沒有。
- 結果：中斷的 birth 只能停在 `blocked`，而 `blocked` 又讓 `entry.headerUnknown` 無法清除，close 回報 recovery-required。

### R4 分階段耐久物讓「中間態」爆炸

一次 birth 會依序產生：`.stage`（或 capture reservation）→ header 檔（session 檔）→ task document → frames/seed → completion。每一步都是一個「可能已發行、可能未知」的耐久狀態，於是需要 adoption、mode、blocked、recovery-required 等語義來覆蓋每一種組合。

---

## 3. 參考專案怎麼做（DSH 0.2.2）

### 3.1 單一 append-only log + per-session handle

`packages/session/session-persistence/src/{index,handle,storage-contract}.ts`：

- `create(header)` 只回傳 write handle；**lazy materialization**：第一次 `append` 才發佈 header+batch（no-overwrite），`flush()` 才把空 session 寫成耐久物。crash 在 materialization 之前＝session 從未存在。
- `read` 永遠只回「合法連續前綴」，torn tail 不會被回傳；write handle 第一次 append 前先截斷/重寫 torn bytes。
- `flush` 是唯一的耐久屏障；`close` 幂等、不可取消。

### 3.2 他們**明確否決**我們現在這一套

`.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.md` 原文列出的問題與我們的現況一一對應：

> "a shared coordinator ... adopted any published session (ownerless claims, HMR re-seeding, stored-prefix adoption); a bounded prepared-Session LRU with exclusive reservations ...; committing crash repair lived inside load/prepare ..."

他們選擇的替代方案：

> "**adoption exists to guess ownership after the fact** ... with the lifecycle handing the handle over explicitly, a reloaded backend that cannot serve old handles fails the writer loudly instead of silently re-claiming logs."

### 3.3 接手＝讀 + 補 closer，而不是 blocked

`packages/core/agent-loop/src/index.ts:786-811`：

```
open(id,'write')  ← 先取寫入所有權，排除並行接手
handle.read(0)    ← 只信任物理上合法的前綴
interruptedTurnClosers(persisted) → handle.append(closers)   ← 以普通 batch 修復
SessionPreparation.create(...) → publish
```

沒有「stage 是否已發行」「header 是否 unknown」「要不要 reconcile」的分支；**能證明的前綴就是狀態**。

### 3.4 出生前的準備是 process-local，不是耐久 reservation

`packages/core/session/src/preparation.ts`：`SessionPreparation` 包住一個**未發佈**的 Session 與一個 `release()`；發佈前 crash ⇒ 這個 Session 不存在。對照我們：`BC01`（`docs/superpowers/specs/2026-10-26-bootstrap-pre-capture.md`）要求「capture 之前必須先耐久 reserve，presence/uncertainty 不得再給第二次 capture」——這是**刻意的產品決策**，也是重設計的最大約束。

### 3.5 側車資料與 session 分離

`docs/subsystems/storage.md` + `packages/storage/{storage,storage-domain,storage-json,storage-sqlite}`：workspace／sidecar 等非 session 資料走通用 KV/storage domain，**不參與 session 出生**。
我們把 task document 綁進出生（barrier／adoption／recovery），這是 R4 的來源；而 `2026-11-05-final-decisions.md` 的 D-01 已經把 task document 定位成 projection/checkpoint，兩者方向其實一致。

### 3.6 fork

`.agents/notes/implemented/architecture/2026-10-23-independent-session-forks.md` + `session-persistence` 的 `isSeeded`/`inheritedEventCount`：fork = `create`（帶 seed 範圍）＋ append seed events，單一檔案、單次發佈；沒有 `.stage`／`.promote`／reservation。

---

## 4. 結論與方案

| 方案 | 內容 | 成本 | 風險 | 建議 |
|---|---|---|---|---|
| **A. 決策模型重設計（建議先做）** | 決策軸與債軸分離；resume 對可證明的狀態直接完成；刪掉 adoption mode 分支；`blocked` 只保留給「payload 不可重建」 | 中（約 6 檔、~15 個守衛、~20 個測試） | 中（要重新定義 handoff 邊界） | **做** |
| **B. 架構重設計（對齊 DSH）** | 單一原子發佈 + in-process preparation + 側車分離；刪掉 stage/header/promote/capture reservation/adoption | 大（fork/subagent/gateway/desktop 全鏈路） | 高（違反 BC01–BC11 的已核准決策） | 立項再做，需 root 裁定 |
| **C. 繼續逐案修** | round 200–218 的模式 | 每輪 1–2 檔 | 高（語義持續漂移） | 不建議 |

### 方案 A 的契約

**兩個正交的結果軸**：

1. **decision**（只由耐久證據決定）：`committed` / `absent` / `conflict` / `unknown`。
   - 證據＝最終路徑上的精確位元組 + 成功的 file sync + owner/currentness 再檢查（`file-synced-process-restart-v1`）。
   - close 失敗、temp 檔清不掉、lease release 失敗**不改變 decision**。
2. **debt**（資源生命週期）：`none` / `cleanup` / `io-unknown`。
   - `cleanup`：已 committed，但 handle/temp/lease 尚未收斂；由 owner 重試，close 時匯總回報（`Coordinator cleanup is unresolved` 只回報 debt，不回報 decision）。
   - `io-unknown`：連 decision 都無法證明（少見），才允許 `blocked`。

**resume 規則**：只要 decision 可證明（header committed、frames confirmed、completion 存在）⇒ 直接 `ready/already-ready`；缺哪一段就以冪等 batch 補齊（`reconcileOwnedBatch` 已有）；只有 payload 真的不可重建（capture 已花用且沒有 ownedRequest）才回 `payload-required`。
這正是 DSH 的 `interruptedTurnClosers` 等價物：**resume 完成 birth，而不是等 reconcile**。

**狀態表（before → after）**：

| 情境 | 現在 | 方案 A |
|---|---|---|
| header 已 fsync、close 失敗 | blocked | ready + cleanup debt |
| seed batch 已 committed、後續中斷 | blocked | ready（補 completion）或 ready（completion 已在） |
| header 已發行、seed 未寫、payload 可用 | blocked / not-issued | ready（冪等補寫） |
| payload 不可重建（capture spent） | payload-required | payload-required（保留） |
| 同 byte 換 inode（stage swap） | blocked/conflict | conflict（不變） |

**受影響的守衛**（逐一改成「decision 不看 cleanup」）：
- `task-document-transition.ts:165,187,198,212,220,229,415`
- `bootstrap.ts:487,491,519,565`（把「無 mode 且已發行」視為 resume-birth）
- `managed-document.ts:256-267`（cleanupDiagnostic 已分離，沿用）

### 方案 B 的取捨

對齊 DSH 可以得到：沒有 adoption、沒有 mode、沒有 stage 檔、resume 只有一條路徑。
但會直接推翻 `BC01–BC11`（capture 必須先耐久 reserve）與 `S-08` 的 marker 設計，並且 fork／subagent／gateway 都要改。**建議等方案 A 完成、suite 全綠後，再以獨立專案評估。**

---

## 5. 分階段計畫（方案 A）

| 階段 | 內容 | 驗證 |
|---|---|---|
| P0 | 兩件事：(a) `committed+cleanup` 不再降級成 unresolved；(b) **task document 發佈失敗不得擋住 birth**——birth 的 decision 只看 session log，task doc 缺失由 registry 重建（D-01 已是 projection） | `bootstrap-physical -t 'keeps header fsync commitment'`、`bootstrap-physical`（58 tests）、`task-document-*` 回歸 |
| P1 | `resume-birth`：header 已發行、seed 未寫時以冪等 batch 補寫；刪掉 `bootstrap.ts:487` 的 `not-issued` | `task-transition-bootstrap-revoke`、`bootstrap-physical` 剩餘 8 筆 |
| P2 | 接手語義：`blocked` 只剩 `payload-required`；`reason` 改成帶 `decision`／`debt` 的結構 | `bootstrap-capture-physical`、predecessor 群 |
| P3 | 清理 legacy 建構子測試（22 筆）與 semantic-publication（24 筆） | 全套 18 檔 → 0 |

**不要做的事**：不要在 P1 之前改 `blocked` 的 reason 字串（呼叫端與測試都依賴它）；不要在 A 完成前動 `.stage` 佈局。

---

## 6. 需要裁定的三件事

1. **BC01 是否仍然絕對？** 若 capture 可以改成 process-local preparation（DSH 模式），方案 B 的多數障礙消失；若不行，方案 A 的 `payload-required` 要永久保留。
2. **cleanup debt 的 close 語義**：`Coordinator cleanup is unresolved` 目前是 throw；方案 A 建議改成「回報 debt 但 close 成功」。這會影響 desktop 的關閉流程，需要產品確認。
3. **predecessor（format 8/11/13）是否還要維持可 resume？** 若要，方案 A 的 resume-birth 必須涵蓋舊格式的 completed/history 路徑；若否，可以直接把 predecessor 測試標記為 unsupported。
