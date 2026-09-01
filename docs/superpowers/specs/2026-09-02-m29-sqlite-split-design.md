# I-harness M29 設計：SQLite 持久化後端分離（dsh jsonl-only 對齊）

> 2026-09-02。範圍：方案 A（`docs/research/2026-09-02-ih-sqlite-removal-study.md` 推薦）。D1–D4 已定（D1 交換達成、D2 旗標刪除、D3 `first-search`、D4 進程私有索引文件默認 `:memory:`、持久化可選）。
> 依賴原則：通用公開庫自由引入、私有庫禁入；ESM strict；Windows 優先；fail-closed。

## 0. 目標與邊界

**目標**：JSONL 成為唯一權威持久化；FTS/lineage 搜索面由**獨立可重建索引**承載（reconcile-on-search，dsh 同款一致性模型）；移除 sqlite 持久化後端與 `--session-backend` 旗標；**功能損失為零**（搜索面反而從「CLI 未掛載」變「出廠可用」）。

**不做**：改 coordinator/JSONL 後端內部；改鎖；改 profile/updateMeta/文檔；`storage-sqlite` 類似域 KV 引進（無需求）；`session-query` 接口形態（保持 `SessionQuery` 抽象）。

## 1. 核心組件

### 1.1 新 `@i-harness/session-query-index`（或 session-query 相關子面——見 §1.2 決定）

**契約**：

```ts
export interface FileBackedQueryOptions {
  storeRoot: string                        // JSONL store root（<dir>/<id>.jsonl）
  dbPath?: string                          // 索引文件；缺省 :memory:（進程私有，默認）
  signal?: AbortSignal
}
export function createFileBackedSessionQuery(opts: FileBackedQueryOptions): SessionQuery
// SessionQuery（既有接口，零改動）: searchHits / lineage / close
```

**reconcile-on-search 狀態機**（每搜索前執行；dsh 縮小版——IH 無多包/多 live 服務，故去掉 live/TEMP 層）：

1. 快照：`scanStore(storeRoot)` → `{ sessionId, revision: {dev,ino,size,mtimeNs}, headerMeta, blank }[]`（首行 header + stat；jsonl 後端已有同款 `fileRevision` 邏輯——抽出共用）
2. 對照索引表 `indexed_sessions(id PK, revision, fingerprint)`；未變 → skip；新增/變更 → 全 decode（讀 `<id>.jsonl`，同 coordinator load 讀法但**不載入協調器寫入路徑**——只讀）→ `deriveSearchText`（core-session 現有）→ 行級 docs（session_id, seq, type, time, text, surface 標記——沿用 deriveSearchText 的輸出約定）→ `header → lineage 表`（id, created_at, cwd, parent_session, seed_length, delegation_depth, origin——繼承 sessions 表職責）
3. 每 session 變更 = 單一 `BEGIN IMMEDIATE … COMMIT`（delete+insert 該 id 全部相關行 + 更新 indexed_sessions）；fingerprint = sha256（header+events 序列化）
4. 穩定性：同進程串行化（單行 await 鎖）；不同進程各自索引文件（默認 :memory:，無跨進程共享）
5. 失敗語義：掃描/讀取失敗 → `SessionQueryError('SESSION_QUERY_OBSERVE_FAILED')`，**不回退舊行**；索引文件 schema 版本不符/外來 → `SESSION_QUERY_INDEX_FOREIGN`（拒絕，不碰）；`dbPath` 缺失 → 創建（0o600/0o700，同 dsh）
6. 標記：`application_id = 0x49485155`（"IHQU"）、`user_version = 1`；版本不符 → 重置重建（derived schema 自描述）

**Schema**（新索引文件，獨立於任何持久化 DB）：
- `indexed_sessions(id TEXT PK, revision TEXT, fingerprint TEXT) STRICT`
- `indexed_docs USING fts5(text, session_id UNINDEXED, seq UNINDEXED, type UNINDEXED, time UNINDEXED, tokenize='unicode61')`（沿用現 `events_fts` 的列系 + surface 標記）
- `lineage(id TEXT PK, created_at, cwd, parent_session, seed_length, delegation_depth, origin) STRICT`

### 1.2 session-query 重指向

- `createSessionQuery(dbPath)` **保留**（打開既有索引文件的只讀連接——現測試/未來持久化索引用）
- 新增 `createFileBackedSessionQuery(opts)`（§1.1）；`createSessionQueryTools` 不變（吃 `SessionQuery` 接口，零改動）
- `session-query/package.json` 移 sqlite 到 **dependencies**（它將自持 node:sqlite 索引面；原 devDependency 因持久化後端已無「同文件」依存）

### 1.3 移除清單

| 移除/改 | 位置 |
|---|---|
| `@i-harness/session-persistence-sqlite` 包 | `packages/session-persistence-sqlite/`（整包） |
| `--session-backend sqlite` | `apps/cli/src/index.ts`（4 處解析+usage+過濾器+協調器建構）、`web.ts`、`run.ts` 無 |
| `createSqliteBackend/closeSqliteBackends` | index.ts / web.ts import 與呼叫 |
| sqlite 遷移鏈語意 | 由 §1.1 索引自持版本取代（持久化側 jsonl 格式版本 gate 不變） |
| 舊 `sessions.db` | 不讀取不遷移（研究 D 語義）；索引對外來 `application_id` 拒絕 |

**保留/不改**：fs-lock 鎖（後端無關）；jsonl 後端全量；core-session；session-persistence coordinator；`SessionQuery` 接口；settings `searchBackend` 字段（語意改為「搜索索引開關」：`"jsonl"`=索引開啟（默認），未來可 `"none"`——**存檔兼容**：舊值 `"sqlite"` 讀為開啟）。

### 1.4 CLI/Assembly 接線（搜索面出廠可用）

- `apps/cli/src/run.ts` / `web.ts` / `sdk` / `acp`：當存在 `sessionDir`（storeRoot 已知）時 → 構建 `createFileBackedSessionQuery({ storeRoot })` 傳入 assembly `sessionQuery` seam（assembly 掛 `session_search`/`lineage` 工具與 web 路由——現有門控不需改）
- 無 `--session-dir` 時 → 不掛（現語意）；web 無 workspace session 時 409 語意保留

## 2. 測試策略（重寫清單）

| 文件 | 動作 |
|---|---|
| `packages/session-persistence-sqlite/test/*`（21） | 刪除 |
| `packages/session-query/test/query.test.ts`（8）/`tools.test.ts`（3） | 種子改為「jsonl 寫入 + createFileBackedSessionQuery」；斷言：append 後**當次搜索**可索引（reconcile-on-search 語意）；revision 不變後免重讀（inspection 計數）；失敗大聲不回退；外來 DB 拒絕 |
| `apps/cli/test/cli.test.ts` M5(618-696)/M10b(187-261)/M11(290-321)/M23(1703-1733) | sqlite 段 → jsonl 或 filebacked 等價 |
| 新增 `session-query/test/filebacked.test.ts` | reconcile 機：新增/變更/刪除（刪除 session 檔後搜索不可見）；指紋防同 revision 變異；stable 雙掃 |
| e2e | 無改（零引用） |
| docs | `README`（旗標表格）、`docs/contracts.md`（旗標/契約行）、m5/m10b spec 標「§歷史——M29 分離」、`docs/audit/2026-08-31-fiveway` §5 不變 |

## 3. 執行排序（建議）

1. **T1 索引構建器**（`packages/session-query` 擴 or 新子包——**決定：擴 `@i-harness/session-query` 內**（接口/文本約定已在一處，dsh 分包的動機是 Cordis 裝載；IH 無此需求））：掃描/對帳/重插/失敗語意 + 測試
2. **T2 session-query 重指向 + CLI 接線**（createFileBackedSessionQuery 掛入 4 個命令路徑 + tools 裝載不變）
3. **T3 移除包與旗標**（session-persistence-sqlite 刪除、CLI 旗標/imports 清、web.ts、closeSqliteBackends）
4. **T4 測試重寫 + docs 收尾**（§2 清單）

## 4. 風險與取捨

- **一致性語意**：D1 已定——「搜索永不舊於自身 reconcile、失敗大聲」；M10b spec 文本標歷史。
- **索引掃描成本**：每搜索掃 storeRoot + stat（僅變更者全 decode）——dsh 測試證明 inspection 穩定；IH 的 jsonl 目錄通常 < 數百 session。
- **進程私有 vs 共享**：默認 `:memory:` 每進程自建（性能重複建索引 ~每次搜索全量?——**不對**：`:memory:` 進程內索引持久在進程生命週期（首次搜索建、之後增量 reconcile）。跨進程共享（web+sdk）各自建——可接受（dsh 同款，`openAt: first-search` + :memory:）。
- **CLI 搜索面達啟用**：行為變化（新工具出現）——但 M13 的 deferred 曝光面讓新工具不擾既有 mock 測試（核對：assembly 掛載工具時機與 cli.test 斷言）。

## 5. 交付檔清單

- `packages/session-query/src/file-backed.ts`（構建器+reconcile）、`index.ts`（導出）、`schema 移至 file-backed 自持`
- `packages/session-query/test/filebacked.test.ts` + 重寫 2 檔
- `apps/cli/src/{index,web,run}.ts` 修改、`apps/cli/test/cli.test.ts` 段改
- 刪除 `packages/session-persistence-sqlite/`
- docs 4 處（README/contracts/2 個 spec 歷史標）+ `docs/research/2026-09-02-ih-sqlite-removal-study.md` 已存在
