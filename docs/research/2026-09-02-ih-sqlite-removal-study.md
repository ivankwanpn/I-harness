# I-harness「砍 SQLite 持久化後端」可行性研究（跟進 dsh jsonl-only）

日期：2026-09-02 · 方式：唯讀（IH 全依賴地圖 + dsh alpha.3 觀察者架構深讀 + 官方註記）· 範圍：`m29` 分支上評估「取消 SQLite 持久化後端、保留全部現有功能」，即 `docs/research/2026-08-31-dsh-a1-to-a3-delta.md` §4/§6 的引入。

## 0. 研究問題

dsh 砍掉 sqlite 持久化後端（jsonl-only）後——**與 dsh 不同，IH 的 sqlite 承擔「持久化 + FTS 同事務 + 版本化遷移鏈」三職合一**。本研究的問題：IH 能不能砍到同等程度，同時**功能面（FTS/lineage 搜索、鎖、profile/updateMeta、文檔、遷移鏈保險絲）無一損失**？有多少是「砍」、多少是「重定位」？

## 1. 事實面：IH 現狀（依賴地圖摘錄）

- **sqlite 後端的唯二功能性獨有**：① `events_fts` FTS5 表 + 依賴它的搜索面（`session_search`/`lineage` 工具、web `/api/sessions/search` + `/lineage`）② 單文件版本化遷移鏈（SCHEMA_VERSION 3、`.bak` 備份、SAVEPOINT-per-step、application_id 守衛）。
- **其餘全部已被 jsonl 覆蓋**：coordinator 契約、`profile()`、`updateMeta()`（**jsonl 更強**：補丁 `modelSelection`，sqlite 只允許 `title`）、`putDocument`/`getDocument`（documents 表 vs `.doc.jsonl` 側車）、lineage 元數據（jsonl header 承載）、`lockRoot`。`capabilities.seekableRead` 僅測試斷言、運行時零分支。
- **消費者極小**：sqlite 後端 runtime import 只有 `apps/cli/src/index.ts` 與 `web.ts` 兩處；測試面 4 個文件（sqlite 自身 21 + session-query 11 + cli ~7 例）；e2e 零引用。
- **重大發現**：**CLI 運行時目前根本不掛 `SessionQuery`**——`session_search`/`lineage` 只有 cli.test 建過；web-host 對無 seam 的請求回 409 `search_not_enabled`。即搜索面已是「能力門控、默認關」。
- **耦合點**：FTS 寫入在 `createSqliteBackend.append()` 的同一個 `BEGIN IMMEDIATE…COMMIT`（index.ts:103-126）；修復同事務重同步（184-191）；`createSessionQuery(dbPath)` 以只讀連接開**同一文件**（session-query/src/index.ts:78-79）；無任何非 sqlite 查詢路徑（ensureFts 缺表即 throw，fail-closed）。
- **M10b 設計聲稱**（spec line 119/283）：「同一 BEGIN/COMMIT——FTS 永不與事件偏離」「剛 append 的事件立即可搜索；回滾的 append 不留 FTS 行」。

## 2. 事實面：dsh alpha.3 的觀察者架構（可對齊藍本）

`session-query-sqlite`（1104 行）——它是「每次搜索前對帳的 memo」，不是事件訂閱者：

- **零訂閱/零掛鉤**：對 persistence 的連接只是取 optional service 的 identity 符號（掛載/卸載偵測）；引擎註冊 0 個 listener。
- **拉式 reconcile（per-search）**：任何 SELECT 前 `_reconcile`：①快照列表（`listSnapshots`：目錄掃 + 首行 header + stat revision = `dev:ino:size:mtimeNs:ctimeNs`）②與持久化 `persisted_sessions(revision,generation)` 行 diff——**未變 session 完全跳過**③變更者 `inspect(id)`（全 log decode）→ 重建文檔 → sha256 指紋 → 單一 `BEGIN IMMEDIATE…COMMIT` 內整 session 刪/重插 ④穩定性雙查（stability double-check，`STABLE_OBSERVATION_ATTEMPTS=2`）⑤失敗→`SESSION_QUERY_PERSISTENCE_FAILED`，回滾，**絕不服務可能過期的舊行**。
- **可重建 = 隱式**：無 `rebuild()` API；索引丟失/損壞/schema 版本被識別（`user_version=8`、`application_id=0x44534851`）→ 重置重建；**外來 DB 一律拒絕**（`SESSION_QUERY_INDEX_FAILED`）。live 層是 TEMP 表（進程內覆蓋）。
- **一致性模型 5 條**（報告末尾）：①jsonl 唯一權威，FTS 是可棄投影，兩者不互寫 ②每次搜索先 reconcile，答案永不舊於自己的 reconcile ③觀察失敗大聲失敗、回滾、不降級到舊行 ④游標帶請求指紋+代數——語料變化 → `STALE_CURSOR` ⑤索引丟失/過時 → 下次搜索重建。
- **默認關**：`openAt: 'never'`（發貨 bundle）；web scaffold 用 `'first-search'`；「搜索默認關、用時才建」是 dsh 的出廠設定。
- **A1→A3 觀察者零變化**（byte-identical）——dsh 的「砍」只是清掉第二個權威格式；觀察者形狀在 alpha.1 就是這樣。
- `storage-sqlite`（域 KV）：獨立單元（`units` 表 + 每單元 `u_<unit>_<table>` 惰性創建 + 每單元 version 守衛 + 值為 JSON 文本），**與 Session 日誌零關係**（官方註記明言）；且**不在任何發貨 bundle 中**。

## 3. 方案

### 方案 A（推薦——完全對齊 dsh）：jsonl-only 持久化 + 獨立可重建查詢索引

```
持久化：JSONL 唯一權威（保持現 jsonl 後端與 coordinator，零改行為）
索引：  新 @i-harness/session-query-index（或擴 session-query）
        —— createSessionQueryIndex({ storeRoot | workspace })
        —— 拉式 reconcile-on-search（dsh 同款：快照 revision diff → 變更 session 全 decode
           → deriveSearchText → 一事務重插 → 穩定雙查 → 失敗大聲）
        —— 獨立 sqlite 文件（自持 application_id/schema version/可重建；:memory: 可）
        —— 只讀消費 jsonl；永不在搜索路徑寫持久化
接線：  CLI 首次掛 search（openAt: 'first-search' 語意）——搜尋面從「默認沒有」變「默認可用」
移除：  --session-backend sqlite（旗標/usage/README/contracts）
        session-persistence-sqlite 包（schema.ts 遷移鏈隨包消亡）
        closeSqliteBackends/closeSessionQueries 相關
保留：  鎖（fs-lock 與後端無關）、profile/updateMeta（jsonl 現有）、文檔（jsonl 側車）
```

**功能保留矩陣（vs 現狀）**：

| 功能 | 現狀 | 方案 A 後 | 差 |
|---|---|---|---|
| 持久化/損壞修復/寫後台 | jsonl+sqlite 雙後端 | jsonl 唯一 | jsonl 已是默認+更強 |
| `session_search`/`lineage`/web 搜索面 | sqlite 文件（CLI 未掛） | 獨立索引（出廠可用） | **一致性模型替換**（見 D1） |
| FTS 語意 | 同事務「永不偏離」 | 搜索前對帳「永不舊於自身 reconcile」 | 見 D1 |
| 鎖/擁有權 | 後端無關 | 不變 | 無 |
| `profile`/`updateMeta`/文檔 | jsonl 已全覆蓋 | 不變 | 無 |
| 版本化遷移鏈 | sqlite 內部（3 版+.bak+SAVEPOINT） | 索引自己版本（`application_id`+版本→重置） | dsh 同款；sqlite 的「持久化遷移鏈」只服務過自—jsonl 格式版本仍由 coordinator gate |
| CLI 旗標契約 | `--session-backend jsonl\|sqlite` | 只 jsonl（旗標消亡） | D2 |
| Test surface | 4 檔 | ~2 檔（ql 重至 jsonl 種子；sqlite 包測刪） | - |

### 方案 B（溫和分離）：sqlite 只作「查詢索引後端」，`--session-backend` 保留雙值（sqlite 值=jsonl+索引）

- 保留旗標相容（外部腳本/文檔不破）；但「sqlite 持久化」概念仍在（會繼續誤導）——dsh 明確否決此類中間形（選項 ③ 被拒：多存儲角色合併是錯）。**不推薦：IH 版僅多「相容外殼」，實際仍是方案 A + 一個假選項。**

### 方案 C（維持判詞）：不砍

- 理由成立的前提：sqlite 後端是「產品路徑」（`--session-backend sqlite` 被使用、FTS 是「默認工程」）。**本研究的依賴地圖否定了該前提**：運行時消費者僅 CLI 兩處；搜索面 CLI 從未掛載；jsonl 是默認且覆蓋更全——**IH 目前正是 dsh 眼裡的「未選備援 + 雙矩陣成本」狀態**（差異化敘事在 `ad-delta.md §6` 說過，但依賴地圖證明「FTS 是差異化」≠「sqlite 後端是差異化」）。

## 4. 決策點（拍板後即可 spec）

- **D1 一致性模型交換**：接受「同事務永不偏離」→「搜索前對帳、僅變更 session 重讀」？**接受理由**：dsh 的對帳窗口只有一次搜索；失敗大聲語意等價於 IH 的 fail-closed 文化；IH 的「立即搜索」測試（M10b line 283 聲稱）需改為「reconcile 後可搜索」。
- **D2 `--session-backend` 旗標命運**：建議**刪**（同 dsh；H-6 契約文檔/README/contracts 同步），settings 的 `searchBackend` 偏好字串保留（語意變為「搜索索引開關」）或不保留（清理）。傾向保留字符串但語意降級。
- **D3 搜索默認態**：dsh 出廠 `never`；IH 建議 **`first-search`**（首次搜索建索引；工具面才有價值）——由 host/settings 組合。
- **D4 索引文件位置與生存期**：建議 workspace 級 `.i-harness-query/<workspace>.db`（或 `:memory:` + 持久化可選）——須與 attachment/.i-harness-spill 既有約定一致。

## 5. 風險與緩解

| 風險 | 緩解 |
|---|---|
| jsonl 大倉庫搜索每 session 全 decode 的代價 | reconcile 以 revision diff + 指紋跳過——僅變更者全 decode（dsh 同款，測試證明 inspection 保持 1/2） |
| 丟失「同事務」誠信 | 語義替換有測試錨（「reconcile 後可搜索」「失敗大聲」「舊游標 STALE」） |
| CLI/契約破壞者 | 旗標刪除直接失敗（fail-loud）——契約文檔同步 |
| 舊 `sessions.db` 讀取 | 新索引有自己的 application_id；舊檔識別為外來 DB → 拒絕不碰（dsh 同款） |

## 6. 推薦

**方案 A**。論據：依賴地圖否定了「sqlite 是產品路徑」的心態；dsh 藍本已被 alpha.1 驗證（觀察者形狀零變化）；IH 的可貴設計（`SessionQuery` 接口抽象、jsonl 全覆蓋 profile/meta/doc）讓分離的**設計工作量集中在一件事**——reconcile-on-search 索引構建器；其餘全部是刪除與接線。**功能保留矩陣除 D1 一致性語意外零損失**（且 D1 是加強版：「搜索永不舊於自身 reconcile」下過期數據絕不呈現——M10b 的「永不偏離」只對同一個進程寫入者成立，而現實中存在同步延遲的寫入者）。

## 7. 下一步（建議）

1. 用戶拍板 D1–D4
2. `docs/superpowers/specs/2026-09-02-m29-sqlite-split-design.md`（方案 A 展開：索引構建器契約、reconcile 狀態機、移除清單、遷移語意、測試重寫清單）
3. plan → 執行（這次的執行面：新索引構建器 + session-query 重指向 + CLI/測試重寫——與 M26 可比的規模，2 組平行）

## 8. 參考

- IH 側：`docs/superpowers/specs/2026-08-18-i-harness-m10b-session-query-design.md`、`packages/session-persistence-sqlite/src/schema.ts`、`packages/session-query/src/index.ts:78-85`
- dsh 側：`packages/session-query/session-query-sqlite/src/index.ts`（reconcile 395-481、觀察 483-548、替換 568-600）、`packages/storage/storage-sqlite`、`.agents/notes/implemented/simplification/2026-08-30-jsonl-only-session-persistence.md`
