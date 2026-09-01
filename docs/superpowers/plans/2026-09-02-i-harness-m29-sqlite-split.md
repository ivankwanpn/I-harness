# M29 執行計劃（SQLite 持久化分離）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按方案 A 完成分離——JSONL 唯一權威 + reconcile-on-search 獨立索引 + sqlite 持久化後端移除；功能零損、搜索面出廠可用。

**Architecture:** T1 索引構建器 → T2 session-query 重指向+CLI 接線 → T3 移除包/旗標 → T4 測試重寫+docs。**強依賴串行**（T3 移除後 T1/T2 才能無殘留；單一執行者順序執行，不平行——交叉面大）。

**Tech Stack:** TS ESM strict、vitest（TDD）、pnpm workspace、node:sqlite、Node >= 22。

**Spec:** `docs/superpowers/specs/2026-09-02-m29-sqlite-split-design.md`
**Global Constraints:** 依賴原則=通用公開庫自由/私有禁入（本輪零新增）；ESM strict；Windows 優先；fail-closed；既有測試除 §2 清單外不破；每任務 commit（分支 m29）。

---

### Task 1: file-backed 索引構建器（reconcile-on-search）

**Files:**
- Create: `packages/session-query/src/file-backed.ts`、`test/filebacked.test.ts`
- Modify: `packages/session-query/src/index.ts`（導出）、`package.json`（sqlite → dependencies —— 核對現狀）

**Interfaces:**
- Produces: `createFileBackedSessionQuery(opts: { storeRoot; dbPath?; signal? }): SessionQuery`（SessionQuery 既有接口；內部 `reconcile()`）
- Consumes: `deriveSearchText`（@i-harness/core-session）、`SessionEvent`/header

- [ ] **Step 1: 失敗測試**（`test/filebacked.test.ts`）

```ts
import { mkdtemp, writeFileSync } from "node:fs"
import { createSession, append } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createFileBackedSessionQuery } from "../src/file-backed.ts"

async function seededStore() {
  const dir = mkdtempSync(join(tmpdir(), "ih-q-"))
  const coord = createSessionCoordinator(createJsonlBackend(dir))
  const { id } = await coord.create()
  const s = createSession()
  append(s, { type: "user/message", text: "hello 獨角獸", seq: 0 })
  append(s, { type: "assistant/message", text: "world", seq: 1 })
  await coord.append(id, s.events)
  await coord.close()
  return { dir, id }
}

it("indexes on first search (reconcile-on-search)", async () => {
  const { dir, id } = await seededStore()
  const q = createFileBackedSessionQuery({ storeRoot: dir })
  const hits = await q.searchHits("獨角獸")
  expect(hits).toContainEqual(expect.objectContaining({ sessionId: id }))
})
it("skips unchanged sessions (single inspection)", async () => { /* 加 inspect spy 或事件計數——inspection 只發生一次 */ })
it("fails loud on unreadable source", async () => { /* 檔案刪除+半讀 → SESSION_QUERY_OBSERVE_FAILED（不回退舊行） */ })
it("rejects foreign db file", async () => { /* dbPath 指向外來 application_id → SESSION_QUERY_INDEX_FOREIGN */ })
```

（測試以實際既有接口撰寫——`searchHits` 簽名以 `packages/session-query/src/index.ts` 現有 `SessionQuery` 為準；`deriveSearchText` 簽名以 core-session 為準）

- [ ] **Step 2: 驗證失敗**（file-backed.ts 不存在 → FAIL）
- [ ] **Step 3: 實現**（file-backed.ts：快照掃描（jsonl 後端 fileRevision 邏輯抽出共用或複製小單元）→ `indexed_sessions/indexed_docs/lineage` 表（`application_id=0x49485155`、`user_version=1`、0o600）→ 一事務重插 → 失敗封裝 `SessionQueryError` → 實現 `SessionQuery` 接口，`dbPath` 缺省 `:memory:`）
- [ ] **Step 4: 驗證通過 + `pnpm --filter @i-harness/session-query test && typecheck`**
- [ ] **Step 5: Commit** `feat(m29): file-backed session query index (reconcile-on-search)`

---

### Task 2: session-query 重指向 + CLI 接線

**Files:**
- Modify: `packages/session-query/src/index.ts`（`createSessionQuery` 註釋/契約：只讀既有索引文件——不變簽名）、`apps/cli/src/run.ts`、`apps/cli/src/index.ts`（run/sdk/acp 三處 + web.ts 一起/或分開）、`packages/session-executor/src/assembly.ts`（無改動——核對）

**Interfaces:**
- Consumes: `createFileBackedSessionQuery`（T1）
- Produces: 4 個命令路徑在有 sessionDir 時掛 `sessionQuery`（assembly 現 seam）

- [ ] **Step 1: 失敗測試**（cli.test 加檢驗：`--session-dir`（jsonl）後 `session_search` 工具存在於 registry——assembly 工具掛載斷言；或先看現有 cli.test 有無此斷言模式再定）

```ts
// apps/cli/test/cli.test.ts 增（在既有 M10b 上下文中改寫）:
it("mounts search tools when session-dir present (file-backed)", async () => {
  const r = await runHeadless("hello", { workspace: tmp, sessionDir… /* 新簽名見 T3 */ })
  // 斷言 r.session 事件或 registry——以 runHeadless 現訪問面為準；若無 sync 面向，則在此任務以「不破 M10b 既有」+ 斷言 searchHits 端到端：
})
```

（T2 的測試以「T1 單元綠 + M10b 段落重寫後綠」為代理；具體斷言寫法執行時按現有 cli.test M10b 段（187-261）去匹配——執行者讀該段）

- [ ] **Step 2: 實現**（run.ts：opts.sessionDir != null → `sessionQuery = createFileBackedSessionQuery({ storeRoot: sessionDir })`；sdk/acp 同理；web.ts 同樣於 WebServerOptions 增加或沿用）
- [ ] **Step 3: 驗證** `pnpm --filter apps/cli test`
- [ ] **Step 4: Commit** `feat(m29): wire file-backed session query into cli/web/sdk/acp`

---

### Task 3: 移除 sqlite 持久化後端與旗標

**Files:**
- Delete: `packages/session-persistence-sqlite/`
- Modify: `apps/cli/src/index.ts`（旗標 4 處 + usage + 過濾器 + coordinator 建構）、`web.ts`（sessionBackend 選項 + closeSqliteBackends）、`pnpm-lock.yaml`（pnpm install 後自動）、root `package.json`/`pnpm-workspace.yaml`（若列出）——@i-harness/session-persistence-sqlite 引用 grep 清零

**Interfaces:** 移除；保留 jsonl 為默認。

- [ ] **Step 1: 移除 import/旗標**（index.ts：`createSqliteBackend` import、`--session-backend` 解析與值集（只 jsonl）、4 處 `createSessionCoordinator(createSqliteBackend(` → `createJsonlBackend(dir)`；web.ts：`sessionBackend` 只 jsonl + 移除 `closeSqliteBackends` 呼叫與 import）
- [ ] **Step 2: 驗證 CLI 語法幫助**（`usage` 顯示無 sqlite）＋ 全測試見 T4 前中間跑 `pnpm -r test`（預期 cli.test 仍紅——T4 修）
- [ ] **Step 3: 刪除包**（`git rm -r packages/session-persistence-sqlite`；grep 全倉引用清零——留 spec/history 文檔引用）
- [ ] **Step 4: Commit** `refactor(m29): remove sqlite persistence backend + --session-backend flag`

---

### Task 4: 測試重寫 + docs 收尾

**Files:**
- Rewrite: `packages/session-query/test/query.test.ts`（8）、`test/tools.test.ts`（3）（種子=jsonl+fileBacked）
- Rewrite: `apps/cli/test/cli.test.ts`（M5 618-696/M10b 187-261/M11 290-321/M23 1703-1733）
- Docs: `README.md`（旗標表）、`docs/contracts.md`（旗標/搜索語意）、m5/m10b spec 頭部「§歷史——M29 分離」註記、`settings`（searchBackend 語意註記，值 "sqlite" 相容讀取）

- [ ] **Step 1: 重寫 session-query 兩測試**（種子 jsonl 寫入 → `createFileBackedSessionQuery`；斷言同 T1 語意 + 既有 11 例覆蓋）
- [ ] **Step 2: 重寫 cli.test 四段**（M5: 默認 jsonl 持久化斷言；M10b: fileBacked 掛載；M11/M23: jsonl 等價）
- [ ] **Step 3: 全量門** `pnpm -r test && pnpm -r typecheck && pnpm e2e`
- [ ] **Step 4: docs**
- [ ] **Step 5: Commit** `test(m29): rewrite query/cli suites for jsonl+file-backed; docs history notes`

---

### 最終驗證

- [ ] `pnpm -r test` 全綠（session-query 11+新 6；cli 65 等；e2e 11/11）
- [ ] `pnpm -r typecheck` 0
- [ ] smoke：`i-harness sdk` initialize + `i-harness run`（jsonl 默認）綠；`grep -r session-persistence-sqlite packages apps` 零命中
