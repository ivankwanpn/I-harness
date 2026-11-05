# 出生（birth）與接手（adoption）語義：六個參考專案比較與重設計建議（2026-11-05）

> 問題：`session-persistence-jsonl` 剩餘 18 個紅檔中，約 41 個測試集中在 bootstrap 出生／resume／adoption。
> 這些個案每輪只前進一兩筆（round 200–218），本文件回答：**要不要重設計、重設計到什麼程度、向誰學。**
> 參考來源：`D:\ih_reference_project` 的六個專案（DSH 0.2.2、codex 0.166、opencode 2.1.4/1.19、pi-durable 1.2、ZCode、dsh-superagent-prototype）。
> **結論：要。分三層：A 決策模型（先做）、B 把 task document 併入單一 commit 域（結構修正）、C 終局（handle/SQLite）。**
>
> **後續（2026-11-05，已核定方向）：本文件的 A/B/C 已被 `2026-11-05-session-commit-log-redesign.md`（ADR）取代。**
> 該 ADR 直接採用 B 的完整形式（單一 commit log + sidecars + lease + handle），不再分階段修補。本文保留為研究記錄與證據來源。

---

## 1. 現況量測

`session-persistence-jsonl`：round 218 量測 **20 紅檔 / 93 failed / 764 passed / 17 skipped（98 檔）**；
再修掉 `task-transition-header-debt`、`task-transition-stage-revision` 後推算 **18 紅檔 / 91 failed**（尚未重新全套量測）。

| 群組 | 紅檔（測試數） | 代表性失敗 |
|---|---|---|
| 出生／接手語義 | bootstrap-physical(9)、bootstrap-capture-physical(4)、current-context-predecessors(9)、semantic-codec2-predecessor(10)、format13(3)、format8(2)、format11(1)、child-bootstrap-stage(1)、child-bootstrap-physical(1)、task-transition-bootstrap-revoke(1) | `expected 'blocked' to be 'ready'`／`'already-ready'`、`not-issued`、`Coordinator cleanup is unresolved` |
| legacy 建構子（D-12 測試債） | replacement-journal(4)、task-document-composition(16)、task-d-repair-header-path(2) | `TASK_TRANSITION_UNSUPPORTED` |
| 發佈／保護位元組 | semantic-publication(24) | `bootstrap-incomplete`、protected slot |
| 其他 | archive-stream(hang)、cold-selected-capability(1)、task-document-write-repair(1) | timeout、cleanup-debt |

41 筆「出生／接手」幾乎都不是資料損壞，而是**決策函數把可判定的耐久狀態回報成 blocked**。

---

## 2. 根因

### R1 決策軸與清理債混在一起（主因）

後端其實已經正確區分：

- `packages/session-persistence-jsonl/src/backend/bootstrap-header.ts:260,291`：write+sync 成功、close 失敗 → `{kind:'committed', cleanupDiagnostic:'file-close-failed'}`。
- `packages/session-persistence-jsonl/src/backend/document-write.ts:137-139`：committed 之後 close 失敗 → `cleanupPending: true`。
- 自己的規格也寫得很清楚：`docs/superpowers/plans/2026-10-28-original-task-document-boundary.md:176`
  「A failed close afterward is committed-with-cleanup-debt, not permission to rewrite or replay」。

但上層把所有 `cleanupPending` 當成語義失敗：

```ts
// packages/session-persistence/src/coordinator/task-document-transition.ts
:198  if (result.kind !== 'committed' || result.cleanupPending) throw new Error('TASK_TRANSITION_TASK_UNRESOLVED')
:212,:220  if (outcome.kind !== 'committed' || outcome.cleanupPending) throw new Error('TASK_TRANSITION_HEADER_UNRESOLVED')
:165,:187  if (outcome.kind !== 'confirmed' || outcome.cleanupPending) throw new Error('TASK_TRANSITION_CONFIRM_UNRESOLVED')
```

→ `bootstrap.ts:491` 的 `catch { ... return blocked(entry) }` 把「已 fsync、只差 close」的 header 變成 `blocked`。

### R2 只有一個對外出口，reason 卻有 45 個產生點

`bootstrap.ts` 有 **45 個 `blocked()` 呼叫點**，reason 只有 4 種。呼叫端無法區分「再試一次會成功」與「永遠不會」。

### R3 沒有「已發行但未完成」的正規狀態

- `bootstrap.ts:487`：barrier 沒有 mode 且已有 header → `not-issued/unsupported`（`task-transition-bootstrap-revoke` 的紅）。
- round 216 已記錄：barrier `prepare()` 只有 `'new'`／`'completed'`／其他三種語義；「header 已提交、seed 未寫」需要第四種（`resume-birth`）。

### R4 分階段耐久物讓中間態爆炸（實測）

一次 birth 會依序產生 `.stage`／capture reservation → header（session 檔）→ task document → seed → completion，每一步都是「可能已發行」的耐久狀態。

**實測**：`bootstrap-physical`「keeps header fsync commitment when file close cleanup fails」失敗在
`TASK_TRANSITION_TASK_UNRESOLVED`，來源是 **task document 的 temp close 失敗**（rename 前失敗 ⇒ 文件未發佈 ⇒ `result.kind === 'unknown'`），不是 session header。
把 `|| result.cleanupPending` 拿掉後仍然 blocked——因為文件真的沒發佈。
也就是說：**空的 task document 發佈失敗會擋住整個 session 出生**，而 D-01 已把 task document 定義成 projection/checkpoint。
projection 不應該成為 birth 的 gate。

---

## 3. 六個參考專案怎麼做

| 參考 | 出生 | 承諾點 | 崩潰恢復 | 所有權 | 側車（task/文件） |
|---|---|---|---|---|---|
| **DSH 0.2.2** | `create(header)` 回傳 handle，**延遲物化** | 單檔第一次 `append`（header+首批）；`flush` 物化空 session | torn tail 丟棄；resume 以 `interruptedTurnClosers` 補寫 | in-process registry（跨程序 lease 為計畫） | 走 `storage-domain`，**不參與出生** |
| **codex 0.166** | `deferred_creation`，`persist()` 才建檔 | append-only rollout（meta 為第一筆） | 丟掉 handle、保留 `pending_items`、下次 barrier 重開重試 | flock（thread writer lock）＋ coordination lock＋stale lock 清理 | SQLite `state_db` 索引 |
| **opencode 2.1.4** | DB row；`claim` 是單一 UPDATE | SQLite 交易 | `time_suspended`＝durable write-ahead intent；`resume_attempts` 計數 | DB row claim（零列 no-op，天然冪等） | todo/job 同 DB |
| **pi-durable 1.2** | conversation 首次使用建立 | `main.jsonl` 的 **commit marker**（sidecar 先寫、marker 後寫） | 未標記的 sidecar 忽略回收；`resume()` 重跑 task | storage 單寫者 | document/task 與 entry **同一個 commit** |
| **ZCode** | SQLite session store | SQLite 交易 | app 層 | DB | subagent `transcript.jsonl`、tool output checkpoints |
| **prototype** | ticket store（SQLite） | SQLite `atomic` | outbox receipts 重試 | DB | DSH session 由 DSH 管 |

### 3.1 DSH 0.2.2（同源）

- 介面：`packages/session/session-persistence/src/{index,handle,storage-contract}.ts`；`create/open/stat/list` + per-session handle。
- 延遲物化與 crash 語義：`packages/session/session-persistence-jsonl/README.md`「Durability and crash semantics」——
  第一次 append 才 no-overwrite 發佈 header+batch；物化前 crash ＝ session 從未存在；torn tail 不返回，write handle 首次 append 前截斷。
- 出生前準備：`packages/core/session/src/preparation.ts` 的 `SessionPreparation`（未發佈 Session + `release()`，process-local）。
- 接手：`packages/core/agent-loop/src/index.ts:786-811`——先取 write handle、讀合法前綴、`interruptedTurnClosers` 以普通 batch 補寫、再 prepare/publish。
- **明確否決 coordinator/adoption**：`.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.md`
  （"adoption exists to guess ownership after the fact"；prepared LRU/reservation/commit repair inside load 全部刪除）。

### 3.2 codex 0.166

- `codex-rs/rollout/src/writer_lock.rs`：thread 級 flock + `.coordination.lock`；stale lock 由「能拿到鎖就刪檔」清理。
- `codex-rs/rollout/src/recorder.rs:1826-1900`：`deferred_creation`；items 先進 `pending_items`，寫成功才移除；
  I/O 失敗只丟 handle，**保留未寫前綴**，下一個 barrier 重開重試（最多兩次）。
- `:1794-1814`：open append + 確保 newline 結尾（torn tail 修復）。
- 沒有 stage／header／task 三段式。

### 3.3 opencode 2.1.4（1.19 的演進）

1.19 的 `session/store.ts` 只有讀取層（get/context/message），沒有 claim；2.1.4 才加入 `time_suspended`／`resume_attempts`。
方向是**增加 durable write-ahead intent**，但始終在同一個 SQLite 交易域內——不是多檔案協議。

- `packages/core/src/session/store.ts:62-85`：`time_suspended` 是「本回合正在執行的耐久 write-ahead intent」；
  `claim` 用 `UPDATE … WHERE time_suspended IS NULL`（`:208-219`），重複 claim 是零列 no-op；
  `release` 清除並重置 `resume_attempts`（`:220-227`）；孤兒 resume 時遞增計數（`:242-254`）。
- 這是**耐久意圖與被保護狀態同域**的範例：intent 與 session 在同一張表、同一個交易引擎。

### 3.4 pi-durable 1.2

- `packages/durable/README.md`：Commit 是原子寫入，且 **entries + documents + tasks 可以同一個 commit**；
  「nothing is shown before its commit is stored」；`resume()` 接續 crash 留下的 pending work；`requestId` 去重。
- `packages/durable/src/storage/jsonl/storage.ts:278-307`：先 append 所有 sidecar（document/task），再 append `main.jsonl` 的 **commit marker**；marker 是唯一承諾點。
- `:535-600` recovery：沒有 marker 引用的 sidecar 一律忽略／回收；`fsync` 是 storage 選項（`:257`）；
  寫入失敗時 storage **poisoned，必須重開**（`:89-92`），不是留在行程內猜。
- 這是「兩個耐久物」問題最直接的正解：**把它們變成同一個 commit 的兩個部分**。

### 3.5 ZCode

- `packages/services/src/storage/domain/storageCatalog.ts`：session 主體是 `v2/<id>.sqlite`（`sessionStore`），
  subagent 另存 `cli/agents/<...>/transcript.jsonl`，tool output 放 checkpoint 目錄。
- 大型／追加式 artifact 用 JSONL，狀態與索引用 SQLite：**交易域只有一個**。

### 3.6 dsh-superagent-prototype

- `src/app/store.ts`：SQLite 存 domain aggregate、KV、settings history、channel outbox；`src/app/outbox.ts`：持久 receipt + 重試。
- 執行本身交給 DSH session；自己的耐久層只有一個交易域。

### 3.7 五條共同法則

1. **L1 單一承諾點**：一次出生只有一個耐久承諾點（marker／交易／append）。六個參考無一例外。
2. **L2 延遲物化**：沒有內容就不落地；物化前 crash ＝ 不存在。
3. **L3 耐久意圖必須與被保護狀態同域**（opencode/pi/prototype）；做不到就不要耐久意圖（DSH/codex）。
4. **L4 恢復在 open/reopen 決定**，不在行程內用 blocked／adopt 猜；IO 失敗就 poison-and-reopen 或延後重試。
5. **L5 所有權是租約／鎖**，不是 adoption 記錄。

**I-harness 五條全違反**：兩份耐久物（session + task doc）＋ stage/header/promote/capture 多階段（違反 L1）；
先 reserve 再 capture（BC01，違反 L2）；耐久意圖（reservation）與被保護狀態不同域（違反 L3）；
blocked／adoption 在行程內（違反 L4）；task doc 是 birth gate（違反 L5 的等價原則：projection 不該有所有權語義）。

---

## 4. 建議：三層重設計

### A. 決策模型（先做，保留現行架構）

**兩個正交結果軸**：

1. **decision**（只由耐久證據決定）：`committed` / `absent` / `conflict` / `unknown`。
   證據＝最終路徑精確位元組 + 成功 file sync + owner/currentness 再檢查（`file-synced-process-restart-v1`）。
   close 失敗、temp 清不掉、lease release 失敗**不改變 decision**。
2. **debt**（資源生命週期）：`none` / `cleanup` / `io-unknown`。`cleanup` 由 owner 重試，close 時匯總；
   只有 `io-unknown` 才允許 `blocked`。

**resume 規則**：decision 可證明 ⇒ 直接 ready/already-ready；缺哪段就以冪等 batch 補齊；
只有 payload 不可重建（capture 已花用且無 ownedRequest）才回 `payload-required`。

| 情境 | 現在 | 方案 A |
|---|---|---|
| header 已 fsync、close 失敗 | blocked | ready + cleanup debt |
| seed 已 committed、後續中斷 | blocked | ready（或補 completion 後 ready） |
| header 已發行、seed 未寫、payload 可用 | blocked / not-issued | ready（冪等補寫） |
| task doc 未發佈（projection） | blocked | ready；task doc 由 registry 重建 |
| payload 不可重建 | payload-required | payload-required（保留） |
| 同 byte 換 inode | conflict | conflict（不變） |

守衛清單：`task-document-transition.ts:165,187,198,212,220,229,415`、`bootstrap.ts:487,491,519,565`。

### B. 結構：把 task document 併入單一 commit 域

兩個落地選項（二選一，建議先做 B1）：

- **B1（推薦）journal 事件 + projection**：把 task document 的變更寫成 session journal 的事件（例如 `task/document`），
  `.doc.jsonl` 降級為 materialized projection（可重建、可丟棄）。birth＝一次 append，task doc 不再擋出生。
  與 D-01「document 是 projection/checkpoint」完全一致；desktop 讀取器可先讀 projection，缺失時重建。
- **B2（pi 模式）commit marker + sidecar**：`main.jsonl` 只放 commit marker，task document 放 sidecar，先寫 sidecar 再寫 marker；
  未標記 sidecar 在 recovery 時忽略。改動較大（要改 log 格式），但能保留 append-only 與 O(1) 讀取。

### C. 終局（獨立專案）

DSH handle 模型（`create/open/stat/list` + `SessionPreparation` + lazy materialization）或 ZCode 的 SQLite session store。
只有在 B 完成、suite 全綠後才值得評估；且要先解決 BC01（capture 是否必須耐久 reserve）。

---

## 5. 分階段計畫

| 階段 | 內容 | 驗證 |
|---|---|---|
| P0 | (a) `committed+cleanup` 不降級；(b) task document 發佈失敗不擋 birth | `bootstrap-physical -t 'keeps header fsync commitment'`、`bootstrap-physical` 58 tests |
| P1 | `resume-birth`：header 已發行、seed 未寫時冪等補寫；刪 `bootstrap.ts:487` 的 `not-issued` | `task-transition-bootstrap-revoke`、bootstrap-physical 剩餘 8 筆 |
| P2 | 接手語義收斂：`blocked` 只剩 `payload-required`；reason 帶 `decision`/`debt` | bootstrap-capture-physical、predecessor 群 |
| P3 | B1：task document 事件化 + projection 重建 | `task-document-*`、subagent registry、desktop catalog |
| P4 | 清 legacy 建構子（22 筆）與 semantic-publication（24 筆） | 全套 18 檔 → 0 |

**從各參考借什麼**：

| 參考 | 借用 |
|---|---|
| DSH | handle／preparation 的目標形狀；resume 補 closer 的语义（P1） |
| codex | 失敗保留未寫前綴、下次 barrier 重試（P0/P1）；writer lock 的 stale 清理（所有權） |
| opencode | 單一 UPDATE claim 的冪等寫法（P0）；durable intent 與狀態同域（B1） |
| pi | commit marker 是唯一承諾點（B2）；documents/tasks 同 commit（B1 的依據） |
| ZCode | SQLite＋JSONL 的分工（C） |
| prototype | outbox/receipt 的重試模型（debt 軸） |

---

## 6. 需要裁定的四件事

1. **BC01 是否仍然絕對？** 若 capture 可改成 process-local preparation（DSH 模式），方案 C 的障礙消失；若不行，`payload-required` 永久保留。
2. **close 語義**：`Coordinator cleanup is unresolved` 是否改成「回報 debt 但 close 成功」？（影響 desktop 關閉流程）
3. **predecessor（format 8/11/13）是否仍需可 resume？** 決定 P1 要涵蓋多少舊格式路徑。
4. **task document 是否可以併入 journal（B1）？** 這是結構修正的核心；若 desktop 需要 O(1) 快照，保留 projection 即可。
