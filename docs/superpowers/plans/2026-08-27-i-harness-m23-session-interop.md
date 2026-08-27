# M23 Session/Interop 健壯 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 persistence 從「單寫者假設」升級為「跨進程所有權安全」，並補上 MCP auto-reconnect、resume wakeup 修復、串流/觀察出口——讓多 session 與未來前端架構有正確的地基。

**Architecture:** 五子系統：(1) 新 `@i-harness/fs-lock`——所有權租約原語（Windows=koffi `LockFileEx` 非阻塞版；其他平台 typed fail-closed）；(2) `@i-harness/session-persistence` coordinator 接線——acquire-at-live、repair guard、`SessionLockConflictError`；（3）sqlite backend 事務紀律（`PRAGMA busy_timeout` + `BEGIN IMMEDIATE`）；(4) mcp-client generation supervisor（dsh 吸收）+ `mcp/server-status` host 狀態事件；(5) subagent `ensureResidentAgent` lazy rebuild + core-session streaming/觀察出口。

**Tech Stack:** TypeScript ESM, pnpm workspace, vitest, node builtins + 既有 koffi（無新增 npm 套件）。dsh/codex 參考（吸收而非移植；MIT 歸屬入 THIRD_PARTY_NOTICES）。

**Spec:** `docs/superpowers/specs/2026-08-26-i-harness-m20-m25-backend-complete-design.md`（§6 M23 Session/Interop 健壯）
**Research:** `.superpowers/research/2026-08-27-m23-session-interop-research.md`（第一輪）、`2026-08-27-m23-session-interop-research-2.md`（第二輪——主導）、`2026-08-27-m1-m22-architecture-audit.md`（審查）

## Global Constraints

- 版本 `0.1.0`、ESM、strict TS（`strict`/`noUnusedLocals`/`noUnusedParameters`）、pnpm workspace
- 零新增 npm 套件（node builtins + 既有 koffi；`@i-harness/fs-lock` 新 workspace 包對 koffi 做**惰性 require**——首 acquire 才 load）
- 平台：**Windows 優先**；其他平台 typed `SessionLockUnsupportedError`（fail loud，非 silent 退化）；Linux flock-via-koffi 屬 M24（不在本 plan）
- fail-closed 紀律：所有權鎖衝突 → 立即 fail-closed（不排隊、不偷鎖）；鎖逾時 → 錯誤走既有 write-behind 失敗保留
- **所有權租約**（非 per-append 鎖）：per-session 獨佔 OS 鎖、acquire-at-live、dispose 後釋放；讀者永不鎖
- 單寫者語意：第二寫者「使之不可表示」（拿不到鎖就寫不進去）；repair 短暫持所有權鎖（codex maintenance-lock 概念）
- 「吸收而非移植」：dsh/codex 代碼只作參考；無 `@deepseek-ai/*` imports；MIT 歸屬（THIRD_PARTY_NOTICES 或檔頭）
- 防 codex 屎山：**保留** dsh 式 batching（SessionWriteBehind 不改）；list 唯讀；一事實一 backend；resume 不載整份記憶體
- 架構提醒（第二輪 concern 1）：coordinator 的 ownership 語義寫在 coordinator 層（「誰的 coordinator 擁有哪個 sessionId」成顯式契約）；child-ownership 的多進程化（child 自寫 log）留 M24+
- 既有保證不可丟：jsonl 失敗 truncate 回 `committedBytes`；sqlite ROLLBACK + PK；write-behind 失敗保留（`automaticPaused`）

---

## Part 1: 所有權租約（鎖原語 + coordinator 接線 + sqlite 修正）

### Task 1: `@i-harness/fs-lock` 包——所有權租約原語

**Files:**
- Create: `packages/fs-lock/package.json`、`packages/fs-lock/tsconfig.json`
- Create: `packages/fs-lock/src/errors.ts`（`SessionLockConflictError`/`SessionLockUnsupportedError`——**避免 index↔win32 循環**：index 動態 import win32，win32 從 errors.ts 進口）
- Create: `packages/fs-lock/src/index.ts`（介面 + 平台分派；從 errors.ts re-export errors）
- Create: `packages/fs-lock/src/win32.ts`（koffi LockFileEx 非阻塞版；從 errors.ts 進口 errors）
- Test: `packages/fs-lock/test/fs-lock.test.ts`（新——win32 skipIf 用真鎖；非 win32 測 unsupported error）

**Interfaces:**
- Consumes: `koffi`（惰性 require——僅 win32 路徑）、`node:fs`、`node:path`、`node:crypto`（鎖檔名）
- Produces:
  - `export class SessionLockConflictError extends Error`（`name = "SessionLockConflictError"`——衝突即 fail-closed）
  - `export class SessionLockUnsupportedError extends Error`（`name = "SessionLockUnsupportedError"`——非 win32）
  - `export interface AcquireOptions { lockPath: string; retryMs?: number; retryMaxMs?: number; deadlineMs?: number }`（retryMs 預設 20、retryMaxMs 預設 200、deadlineMs 預設 2000）
  - `export interface SessionLock { release(): Promise<void> | void; readonly held: boolean }`
  - `export function acquireSessionLock(opts: AcquireOptions): Promise<SessionLock>`（win32：koffi LockFileEx 非阻塞 + JS 退避重試；非 win32：拋 `SessionLockUnsupportedError`）
  - `export function lockPathFor(storeRoot: string, sessionId: string): string`（`<storeRoot>/.i-harness-locks/<sha256(sessionId)>.lock`——根隨 store 生命週期，不放 %TEMP%）
  - 語意：OS handle 鎖隨進程死亡自動釋放（無 stale）；持有期 = 寫者生命週期；`release()` 冪等（已釋放 → no-op）；逾時 → `SessionLockConflictError`
  - 歸屬頭：吸收 codex `thread-store/src/local/writer_lock.rs`（try_lock + WouldBlock→Conflict）+ `LockFileEx` pattern 源自 sandbox-windows-acl acl.ts

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/fs-lock/test/fs-lock.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireSessionLock, lockPathFor, SessionLockUnsupportedError } from "../src/index.ts"

describe.skipIf(process.platform !== "win32")("acquireSessionLock (win32)", () => {
  let root: string
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "i-harness-fs-lock-")) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("acquires, second acquire conflicts (fail-closed)", async () => {
    const path = lockPathFor(root, "sess-1")
    const a = await acquireSessionLock({ lockPath: path })
    try {
      expect(a.held).toBe(true)
      await expect(acquireSessionLock({ lockPath: path, retryMs: 5, deadlineMs: 50 })).rejects.toThrow(SessionLockConflictError)
    } finally {
      await a.release()
    }
  })
  it("releases then re-acquires", async () => {
    const path = lockPathFor(root, "sess-2")
    const a = await acquireSessionLock({ lockPath: path })
    await a.release()
    expect(a.held).toBe(false)
    const b = await acquireSessionLock({ lockPath: path })
    await b.release()
  })
  it("release is idempotent", async () => {
    const path = lockPathFor(root, "sess-3")
    const a = await acquireSessionLock({ lockPath: path })
    await a.release()
    await a.release() // no throw
  })
  it("lockPathFor puts lock under store root .i-harness-locks", () => {
    expect(lockPathFor(root, "sess-x").startsWith(join(root, ".i-harness-locks"))).toBe(true)
  })
})

describe("acquireSessionLock (non-win32) — included for skipIf complement", () => {
  it.skipIf(process.platform === "win32")("throws SessionLockUnsupportedError", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-fs-lock-"))
    try {
      await expect(acquireSessionLock({ lockPath: join(root, "x.lock") })).rejects.toThrow(SessionLockUnsupportedError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/fs-lock && pnpm vitest run`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 建立包骨架**

```bash
mkdir -p packages/fs-lock/src packages/fs-lock/test
cd /d/agent-complete/I-harness && pnpm install # workspace symlink
```

```json
// packages/fs-lock/package.json
{
  "name": "@i-harness/fs-lock",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }
}
```

```json
// packages/fs-lock/tsconfig.json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

- [ ] **Step 4: 實現 index.ts + win32.ts**

```ts
// packages/fs-lock/src/index.ts
// 所有權租約原語（M23）。吸收 codex thread-store/src/local/writer_lock.rs
// （std File::try_lock + WouldBlock→Conflict）與 sandbox-windows-acl 的
// LockFileEx 模式（acl.ts:75-110）——改寫為 I-harness 版：非阻塞 acquire
// + JS 退避；OS handle 鎖隨進程死亡自動釋放（無 stale）。MIT 歸屬見
// THIRD_PARTY_NOTICES（OpenAI codex-rs + huoyaoyuan windows-acl-restrict-poc）。
import { mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"

export class SessionLockConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionLockConflictError"
  }
}

export class SessionLockUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionLockUnsupportedError"
  }
}

export interface AcquireOptions {
  lockPath: string
  retryMs?: number // 預設 20
  retryMaxMs?: number // 預設 200
  deadlineMs?: number // 預設 2000
}

export interface SessionLock {
  release(): Promise<void> | void
  readonly held: boolean
}

export function lockPathFor(storeRoot: string, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 24)
  return join(storeRoot, ".i-harness-locks", `${digest}.lock`)
}

export async function acquireSessionLock(opts: AcquireOptions): Promise<SessionLock> {
  if (process.platform !== "win32") {
    // M23 平台界限（第二輪 Q2）：Linux flock-via-koffi 屬 M24；今天 fail loud，
    // 不 ship 較弱語意的 lockfile+PID fallback（orphan 死穴）。
    throw new SessionLockUnsupportedError("session ownership locks are Windows-only in M23 (Linux flock lands in M24)")
  }
  mkdirSync(dirname(opts.lockPath), { recursive: true })
  const { acquireWin32, releaseWin32 } = await import("./win32.ts")
  return acquireWin32(opts)
}
```

```ts
// packages/fs-lock/src/errors.ts
export class SessionLockConflictError extends Error {
  constructor(message: string) { super(message); this.name = "SessionLockConflictError" }
}
export class SessionLockUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = "SessionLockUnsupportedError" }
}
```

```ts
// packages/fs-lock/src/index.ts — errors 定義放 errors.ts（index 與 win32 都從它進口——無循環）
import { SessionLockConflictError, SessionLockUnsupportedError } from "./errors.ts"
export { SessionLockConflictError, SessionLockUnsupportedError }
// ...（其餘同前——acquireSessionLock 動態 import win32；非 win32 拋 Unsupported）
```

```ts
// packages/fs-lock/src/win32.ts
// koffi LockFileEx 非阻塞版。模式源 sandbox-windows-acl/src/ffi.ts + acl.ts
// （含 NULL OVERLAPPED gotcha——koffi 3.1.1 對 NULL 會 crash）。
// 非阻塞 flag：LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY；
// JS 端退避迴圈避免同步 FFI 阻塞 event loop。
import { SessionLockConflictError } from "./errors.ts"
import type { AcquireOptions, SessionLock } from "./index.ts" // type-only——index 動態 import 本檔，type-only 無 runtime 循環

// acquireWin32(opts): Promise<SessionLock>
// 1. koffi 惰性 require（首次——koffi 載入失敗 → SessionLockUnsupportedError）
// 2. CreateFileW(path, GENERIC_READ|WRITE, FILE_SHARE_READ|WRITE, ...) → 若 ERROR_ACCESS_DENIED → Conflict
// 3. LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, zeroedOverlapped)
//    若 FALSE → ERROR_LOCK_VIOLATION → 退避重試（retryMs→retryMaxMs 指數、deadlineMs 內）；逾時 → SessionLockConflictError
// 4. 回 SessionLock { release() { UnlockFileEx + CloseHandle；冪等 }, held: true }
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/fs-lock && pnpm vitest run` + `cd packages/fs-lock && npx tsc --noEmit`
Expected: PASS（win32 真鎖 4 case；非 win32 unsupported 1 case）

（注：acquire/retry 的核心實作——`createFileW`+`LockFileEx`+退避——由 implementer 依 ffi.ts 模式完成；**koffi binding 面參考 `packages/sandbox-windows-acl/src/ffi.ts` 的 win32Bindings 結構**（CreateFileW/LockFileEx/UnlockFileEx/CloseHandle + zeroed OVERLAPPED）。若 koffi 載入失敗 → 拋 `SessionLockUnsupportedError`。）

- [ ] **Step 6: Commit**

```bash
git add packages/fs-lock/ && git commit -m "feat(M23): @i-harness/fs-lock — session ownership lease (koffi LockFileEx non-blocking, fail-closed conflict, platform boundary)"
```

### Task 2: coordinator 所有權接線（acquire-at-live + repair guard + 衝突錯誤）

**Files:**
- Modify: `packages/session-persistence/src/index.ts`（`CoordinatorOptions` 加 `lock?: { enabled?: boolean; lockRoot?: string }`；`createSessionCoordinator` 內 acquire-at-live/release；`load`/`repair` guard）
- Modify: `packages/session-persistence/src/index.ts`（`SessionCoordinator` 介面加 `ownerOf(sessionId): boolean`——查詢誰擁有）
- Test: `packages/session-persistence/test/ownership.test.ts`（新）

**Interfaces:**
- Consumes: `acquireSessionLock`/`lockPathFor`/`SessionLock`/`SessionLockConflictError`（fs-lock）、`SessionWriteBehind`（既有）
- Produces:
  - `CoordinatorOptions` 加 `lock?: { enabled?: boolean /* 預設 true */; lockRoot?: string /* 預設 = backend 提供或 process.cwd()/.i-harness-locks */ }`
  - `CoordinatorOptions` 加 `acquireRetryMs?: number`/`acquireDeadlineMs?: number`（透傳 fs-lock）
  - `SessionCoordinator` 加 `ownerOf(sessionId: string): boolean`（該 session 的寫者所有權是否由本協調器持有）
  - `SessionCoordinator` 加 `adoptOwnership(sessionId: string): Promise<void>`（**load/resume 後主動長持有**——CLI resume 路徑：load（短 acquire）成功後再 adoptOwnership 長持至 close；衝突 → 拋 `SessionLockConflictError`）
  - **行為**：
    - `create(meta)` → 建立後 `acquireSessionLock(lockPathFor(lockRoot, id))`（**acquire-at-live**——create 即取得，涵蓋後續 append/putDocument 的整個 live 週期）；acquire 失敗 → 拋 `SessionLockConflictError`（或 Unsupported——依平台）
    - `enqueue(sessionId, events)` → 首次建 write-behind 時 acquire（若尚未持有）；acquire 失敗 → 抛 typed error（enqueue 是同步——改為**先取得再回傳**；失敗由呼叫者處理）
    - `append(sessionId, events)`（同步直接寫）→ 同樣 acquire-at-first-use
    - `load(sessionId)` → **短暫 acquire 再釋放**（repair 是 mutating）——load 不持長鎖；repair 部分：acquire → backend.repair → release（codex maintenance-lock 概念）
    - `close()` → 全部 write-behind drain 後**釋放所有持有的鎖**
    - 第二寫者既有：`enqueue`/`append`/`create` 的 acquire 拋 `SessionLockConflictError`——fail-closed，不排隊
    - 讀者（`list`/`getDocument`）永不鎖
  - `putDocument`/`getDocument`：putDocument 是 mutating——**先 acquire（若 session 未持有）再寫再釋放**（doc 是 per-key 非 per-session；無 session 語意時以 `lockRoot/.i-harness-locks/doc-<sha256(key)>.lock`——實作時決定，最低要求：putDocument 也 fail-closed）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/session-persistence/test/ownership.test.ts
import { describe, expect, it } from "vitest"
import { createSessionCoordinator, type PersistenceBackend, type SessionMeta, type SessionEvent } from "../src/index.ts"

// In-memory fake backend（仿 persistence.test.ts 的 fakeBackend）
function fakeBackend(): PersistenceBackend {
  const files = new Map<string, { meta: SessionMeta; events: SessionEvent[] }>()
  return {
    id: "jsonl",
    capabilities: { seekableRead: false, rawArtifacts: true },
    async create(sessionId, meta) { files.set(sessionId, { meta, events: [] }) },
    async append(sessionId, events) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      f.events.push(...events)
    },
    async read(sessionId) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      return { version: f.meta.formatVersion, events: f.events, meta: f.meta }
    },
    async list() { return [...files.keys()] },
    async repair(sessionId) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      return { version: f.meta.formatVersion, events: f.events, meta: f.meta }
    },
    async putDocument(key, data) { files.set(`doc:${key}`, { meta: { formatVersion: 1, sessionId: key, createdAt: "" }, events: [] }) },
    async getDocument(key) { return undefined },
  }
}

describe("session ownership lease", () => {
  it("create acquires ownership; second coordinator on same session conflicts", async () => {
    const a = createSessionCoordinator(fakeBackend(), { lock: { lockRoot: /* tmp dir */ ".i-harness-test-locks-a" } })
    const { id } = await a.create({ sessionId: "sess-ownership-1" })
    expect(a.ownerOf(id)).toBe(true)
    // 2nd coordinator, same lockRoot → conflict on first write
    const b = createSessionCoordinator(fakeBackend(), { lock: { lockRoot: ".i-harness-test-locks-a" } })
    await expect(b.create({ sessionId: "sess-ownership-1" })).rejects.toThrow(/active writer|conflict/i)
    await a.close()
    // after close, b can own it
    const b2 = createSessionCoordinator(fakeBackend(), { lock: { lockRoot: ".i-harness-test-locks-a" } })
    const b2r = await b2.create({ sessionId: "sess-ownership-1" })
    expect(b2r.id).toBe("sess-ownership-1")
  })
})
```

（**實作注意**：lockRoot 需要真實 tmp 路徑——用 `mkdtempSync(join(tmpdir(), "i-harness-owner-"))` 並在 finally rmSync；測試的 lockRoot 用 tmp。**此外**：coordinator 的 `lockRoot` 預設 backend 不知 root——`PersistenceBackend` 加可選 `lockRoot?: string`（jsonl backend 回 `root`；sqlite 回 `dirname(dbPath)`；測試 fake 回 tmp）。以下 Step 3 納入 backend seam。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/session-persistence && pnpm vitest run test/ownership.test.ts`
Expected: FAIL（ownerOf 不存在、lock 行為不存在）

- [ ] **Step 3: 實現（coordinator + backend seam）**

```ts
// packages/session-persistence/src/index.ts — 加
import { acquireSessionLock, lockPathFor, type SessionLock, SessionLockConflictError, SessionLockUnsupportedError } from "@i-harness/fs-lock"

// PersistenceBackend 加（可選向後相容）：
export interface PersistenceBackend {
  // ...既有
  /** Optional: where this store's lock files live (jsonl: root; sqlite: dirname(dbPath)). */
  lockRoot?: string
}

// CoordinatorOptions 加：
lock?: { enabled?: boolean; lockRoot?: string }
acquireRetryMs?: number
acquireDeadlineMs?: number

// SessionCoordinator 加：
ownerOf(sessionId: string): boolean

// createSessionCoordinator 內：
const lockEnabled = opts?.lock?.enabled ?? true
const resolvedLockRoot = opts?.lock?.lockRoot ?? backend.lockRoot ?? process.cwd()
const heldLocks = new Map<string, SessionLock>() // sessionId → held lease

async function ensureOwnership(sessionId: string): Promise<void> {
  if (!lockEnabled) return
  if (heldLocks.has(sessionId)) return
  const lock = await acquireSessionLock({
    lockPath: lockPathFor(resolvedLockRoot, sessionId),
    retryMs: opts?.acquireRetryMs,
    deadlineMs: opts?.acquireDeadlineMs,
  })
  heldLocks.set(sessionId, lock)
}

// create() 流程：
async create(meta) {
  const id = meta?.sessionId ?? `sess-...`
  if (lockEnabled) {
    try { await ensureOwnership(id) } catch (e) { throw e } // typed Conflict/Unsupported
  }
  await backend.create(id, fullMeta)
  return { id }
}

// enqueue()（同步改為 async entry——但呼叫面是 sync；**保留同步簽名**：
// 首次 acquire 改為 fire-await？——解決：writeBehindFor 的 write callback 在
// startWrite 前 acquire（async）；enqueue 仍同步，acquire 失敗 → write 內
// 拋 Conflict → write-behind 失敗保留路徑接手 → reportBackgroundFailure。
// 簡潔且不破同步面。)
// → 實作：SessionWriteBehind 的 write callback = async (events) => {
//     await ensureOwnership(sessionId) // 首次持鎖（fail → Conflict 保留重試）
//     await backend.append(sessionId, events)
//   }

// load() — repair guard：
async load(sessionId) {
  // 版本門（既有）
  // ...peeked = backend.read
  // 短暫 acquire（if lockEnabled）: await ensureOwnership；try { repair } finally
  // 若已在持有（live session）→ 不重複
  // 釋放：load 不持長鎖——但如果 ensureOwnership 已持有（本次 load 新建的）
  //   則 repair 後再 release（臨時）；若原本無鎖 → 不持有
}

// close() — 釋放：
async close() {
  await Promise.allSettled([...writeBehinds.values()].map((wb) => wb.flush()))
  for (const wb of writeBehinds.values()) wb.cancelAutomaticWait()
  await docChain
  for (const lock of heldLocks.values()) await lock.release()
  heldLocks.clear()
}

// ownerOf(sessionId) → heldLocks.has(sessionId)
```

- [ ] **Step 4: jsonl/sqlite backend 補 lockRoot**

```ts
// packages/session-persistence-jsonl/src/index.ts — createJsonlBackend return 加
  lockRoot: root,

// packages/session-persistence-sqlite/src/index.ts — createSqliteBackend return 加
  lockRoot: dirname(dbPath),  // 需 import { dirname } from "node:path"
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/session-persistence && pnpm vitest run` + `cd packages/session-persistence-jsonl && pnpm vitest run` + `cd packages/session-persistence-sqlite && pnpm vitest run`
Expected: PASS（既有 27 + jsonl/sqlite 既有 + ownership 新）

（注意：**既有測試可能受 lock 啟用影響**——若 coordinator 測試（persistence.test.ts 等）在無 tmp lockRoot 時走 `process.cwd()` 但兩個 coordinator 同 cwd 同 session → 會互斥。為避免破既有：`lock.enabled` 預設 true 會讓同進程二度 create 同 session 衝突——實作時若既有測試破，把 `lock.enabled` 預設改為 **`false`**（opt-in——CLI 接線時明確開啟），或既有測試補 `lock: { enabled: false }`。**裁定：`lock.enabled` 預設 `false`（opt-in）**——不破任何既有測試，M23 的 CLI 接線（Task 3 前置）才開啟。）

- [ ] **Step 6: Commit**

```bash
git add packages/session-persistence/src/index.ts packages/session-persistence-jsonl/src/index.ts packages/session-persistence-sqlite/src/index.ts packages/session-persistence/test/ownership.test.ts
git commit -m "feat(M23): coordinator ownership lease — acquire-at-live, repair guard, ownerOf, SessionLockConflictError (opt-in)"
```

### Task 3: CLI 接線（啟用 lock + 衝突處理）

**Files:**
- Modify: `apps/cli/src/index.ts`（`createSessionCoordinator(...)` 呼叫加 `lock: { enabled: true, lockRoot: <workspaceDir> }`——**coordinator 創建在 index.ts L60-62 而非 run.ts**（實證）；衝突錯誤表面化）
- Test: `apps/cli/test/cli.test.ts`（加 1 case——lock option 有接 + 既有不破）

**Interfaces:**
- Consumes: `SessionLockConflictError`（fs-lock）、`createSessionCoordinator`（Task 2 的 lock option）
- Produces: 無新 API——行為：CLI 開 session 時獲取所有權；衝突 → 明確錯誤訊息（含 pid 診斷）；lockRoot = 既有 `dir`（jsonl 的 store root / sqlite 的 dirname）

（**實證**：index.ts:60-62——`createSessionCoordinator(createSqliteBackend(join(dir, "sessions.db")))` / `createSessionCoordinator(createJsonlBackend(dir))`；`dir` 是 session store 目錄——lockRoot 用 `dir`（store 生命週期），非 workspace（第二輪研究：鎖檔位置與 store 同處）。）

- [ ] **Step 1: 寫失敗測試**

```ts
// apps/cli/test/cli.test.ts — 追加（鎖定 lock option 有接——以 coordinator 層為準，Task 2 已測衝突）
it("main wires lock option to coordinator (smoke)", async () => {
  // 簡化：直接斷言 createSessionCoordinator 被呼叫時帶 lock
  //（cli e2e 太慢——驗證 index.ts 的呼叫面即可；或以既有 cli.test.ts 的 spawn 模式近似）
}, 10_000)
```

（完整兩進程衝突 e2e 於 M25；Task 3 以「index.ts 傳 lock option」+「既有 49 case 不破」為交付。）

- [ ] **Step 2: 修改 index.ts**

```ts
// apps/cli/src/index.ts — coordinator 創建區（L60-62）
if (sessionBackend === "sqlite") {
  coordinator = createSessionCoordinator(createSqliteBackend(join(dir, "sessions.db")), { lock: { enabled: true, lockRoot: dir } })
} else {
  coordinator = createSessionCoordinator(createJsonlBackend(dir), { lock: { enabled: true, lockRoot: dir } })
}
```

（**注意**：`dir` 依實際變數名——L60-62 顯示用 `dir`；若 lock 與 resume 同 session 衝突（resumeIdx 時 coordinator 未 create 而已 load）——**resume 路徑需允許持有者載入**：coordinator `load()` 內部短暫 acquire→release 已涵蓋（Task 2）——resume 自身不持長鎖（持鎖者是「主動寫者」，resume 開頭只是讀取重建——**但 resume 後 CLI 會繼續寫**——實作時裁定：resume 後 CLI 是該 session 的寫者，應在 resume 成功後 acquire（load 後 ensureOwnership 持至 close）——**Task 2 已設計 load 的短 acquire；CLI resume 需在 load 後再 ensureOwnership 長持有**——實作時以「resume 成功 → 呼叫 coordinator 的隱式長持有」（或 coordinator 加 `adoptOwnership(sessionId)`——**裁定：Task 2 的 coordinator 加 `adoptOwnership(sessionId): Promise<void>`**（load 後主動長持；衝突 → 拋錯）——此為 plan 補充，實作時確認）。）

- [ ] **Step 3: 跑測試確認通過 + Commit**

```bash
cd apps/cli && pnpm vitest run
git add apps/cli/src/index.ts && git commit -m "feat(M23): CLI — enable session ownership lock at store root"
```

---

## Part 2: sqlite 事務紀律 + MCP reconnect + resume + streaming

### Task 4: sqlite backend `PRAGMA busy_timeout` + `BEGIN IMMEDIATE`

**Files:**
- Modify: `packages/session-persistence-sqlite/src/schema.ts`（openDatabase 加 `PRAGMA busy_timeout = 5000`）
- Modify: `packages/session-persistence-sqlite/src/index.ts`（create/append/putDocument 的 `BEGIN` → `BEGIN IMMEDIATE`；失敗路徑不變）
- Test: `packages/session-persistence-sqlite/test/sqlite.test.ts`（加 1 case——busy_timeout pragma 生效）

**Interfaces:**
- Produces: 無新 API——sqlite backend 內部跨進程競爭的正確修法（codex 同款：`state/sqlite.rs:248-251`）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/session-persistence-sqlite/test/sqlite.test.ts — 追加
it("openDatabase sets busy_timeout=5000", () => {
  const db = openDatabase(path, "wal") // 依實際 export
  const row = db.prepare("PRAGMA busy_timeout").get() as { busy_timeout: number }
  expect(row.busy_timeout).toBe(5000)
  db.close()
})
```

- [ ] **Step 2: 修改 schema.ts + index.ts**

```ts
// schema.ts openDatabase:
db.exec("PRAGMA journal_mode = wal")  // 既有
db.exec("PRAGMA foreign_keys = ON")  // 既有
db.exec("PRAGMA busy_timeout = 5000")  // M23 加（跨進程鎖競爭不立即 SQLITE_BUSY；codex 同款）

// index.ts：所有寫事務 BEGIN → BEGIN IMMEDIATE
// （append/create/putDocument + 修復 migrate 的 BEGIN；查 L66/91/124 全部改）
```

- [ ] **Step 3: 跑測試確認通過 + Commit**

```bash
cd packages/session-persistence-sqlite && pnpm vitest run
git add packages/session-persistence-sqlite/src/ && git commit -m "feat(M23): sqlite backend — busy_timeout=5000 + BEGIN IMMEDIATE (codex transaction discipline)"
```

### Task 5: MCP generation supervisor + `mcp/server-status` 事件

**Files:**
- Create: `packages/mcp-client/src/supervisor.ts`（generation supervisor——dsh connection.ts 吸收）
- Modify: `packages/mcp-client/src/scheduler.ts`（`mountMcpClient` 用 supervisor 取代一次性 connect；`McpMountHandle` 保留）
- Modify: `packages/mcp-client/src/types.ts`（`McpServerConfig` 加 `reconnect?: { enabled?: boolean; initialDelayMs?: number; maxDelayMs?: number; maxRetries?: number }`）
- Modify: `packages/mcp-client/src/index.ts`（export supervisor + 錯誤型別）
- Create: `packages/mcp-client/src/errors.ts`（`McpServerUnavailableError`）
- Test: `packages/mcp-client/test/reconnect.test.ts`（新——deps.connect 注入 seam）

**Interfaces:**
- Consumes: `createConnectedClient`/`ConnectedMcpClient`（client.ts）、`syncTools`（bridge.ts）、`createResourceTools`（resources.ts）、`McpServerConfig`
- Produces:
  - `export class McpServerUnavailableError extends Error`（`name = "McpServerUnavailableError"`——outage 期間工具呼叫快速失敗；不 hang 不靜默）
  - `export type McpServerState = "connecting" | "ready" | "reconnecting" | "lost"`
  - `export interface McpServerStatusEvent { server: string; state: McpServerState; attempts?: number; lastError?: string }`（**host 事件**——非 SessionEventMap 成員）
  - supervisor 行為（dsh 吸收）：
    - 每次重連 = 新 Client + 新 transport（generation）
    - `generation.onclose` → `generationDown`（isCurrent guard 冪等）
    - 退避 `min(maxDelayMs, initialDelayMs * 2^(n-1))`；stability window（存活 ≥ maxDelayMs → 重置 attempt budget）
    - 逾 `maxRetries` → 序列化 unregister 所有工具 + 停止重連 + emit `{ state: "lost" }`
    - 重疊防護：失敗 generation 必須在 5s 內 close，否則停止重連（stdlib 子進程不重疊）
    - 每代 re-sync：`syncTools` + resource tools 重綁（unregister 舊名稱 → register 新的）
  - 事件 emit：`deps.emitStatus?: (ev: McpServerStatusEvent) => void`（scheduler 注入或 supervisor 面；headless 用 `reportBackgroundFailure` 式 logger；frontend 時代直接訂閱）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/mcp-client/test/reconnect.test.ts
// 仿 dsh reconnect.spec.ts 藍圖：deps.connect 注入假 client，模擬斷線/重連
import { describe, expect, it, vi } from "vitest"
import { mountMcpClient, type McpServerStatusEvent, McpServerUnavailableError } from "../src/index.ts"
import { createToolRegistry } from "@i-harness/core-tools"
import { createContext } from "@i-harness/core-plugin"
// 假 client：listTools/callTool/close 等

describe("mcp reconnect supervisor", () => {
  it("reconnects after disconnect (new generation, tools re-synced)", async () => {
    // connect 回傳 client；第一次 close 觸發 supervisor 重建第二代
    // 實作詳見 Step 3——測試以「第二次 connect 被呼叫 + tools 仍可用」斷言
  })
  it("exceeds maxRetries → tools unregistered + lost event emitted", async () => {
    const events: McpServerStatusEvent[] = []
    // maxRetries: 1 → 第一次斷線重連失敗 → lost
    // 斷言 events 最後 state === "lost" 且工具已 unregister
  })
  it("outage: tool call fails fast with McpServerUnavailableError", async () => {
    // 斷線中呼叫工具 → 快速失敗（不 hang）
  })
})
```

（完整測試碼在 Step 3——先寫簡潔版即可；關鍵：generation 重建、maxRetries 停止、事件 emit、快速失敗四者被測。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/mcp-client && pnpm vitest run test/reconnect.test.ts`
Expected: FAIL（supervisor 不存在）

- [ ] **Step 3: 實現 supervisor.ts + scheduler 接線**

```ts
// packages/mcp-client/src/errors.ts
export class McpServerUnavailableError extends Error {
  constructor(server: string) {
    super(`mcp-server(${server}): connection unavailable (reconnect in progress or exhausted)`)
    this.name = "McpServerUnavailableError"
  }
}
```

```ts
// packages/mcp-client/src/supervisor.ts
// 吸收 dsh packages/mcp/mcp-client/src/connection.ts（generation-based supervisor；
// MIT 歸屬见 THIRD_PARTY_NOTICES）——改寫為 I-harness 版。
// 機制：每次重連 = 新 Client + 新 transport；onclose→generationDown（isCurrent 冪等）；
// 退避 min(maxDelayMs, initialDelayMs*2^(n-1))；stability window 重置 budget；
// 逾 maxRetries → unregister + stop + emit lost；overlap 防護（失敗 gen 5s 內 close）。
export interface SupervisorDeps {
  connect: (c: McpServerConfig) => Promise<ConnectedMcpClient>
  onStatus?: (ev: McpServerStatusEvent) => void
  onToolUnavailable?: () => void // 工具呼叫快速失敗的 handler（wrap callTool）
}
export function createMcpSupervisor(config: McpServerConfig, deps: SupervisorDeps): { client(): ConnectedMcpClient; close(): Promise<void> } {
  // ...（實作：generation 管理、ready promise、reconnect 迴圈、emitStatus）
}

// scheduler.ts mountMcpClient 改為：
//   const supervisor = createMcpSupervisor(config, { connect: deps?.connect ?? ((c) => createConnectedClient(c)), onStatus, ... })
//   const current = supervisor.client()
//   keep同 serverName reservation + unmount → supervisor.close()
```

（**注意**：`mountMcpClient` 現有 `deps.connect` 注入 seam（scheduler.ts:56）保留——reconnect 測試用它注入假 client。`syncTools` 兩階段 swap（bridge.ts:35-88）沿用為每代 re-sync；resource tools 每代重綁。`config.reconnect` 驗證在 `validateMcpConfig` 加（misconfiguration fail loud）。）

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/mcp-client && pnpm vitest run` + `npx tsc --noEmit`
Expected: PASS（既有 27+ + reconnect 新——既有 mount 測試不破：無 reconnect 設定時 supervisor 行為 = 一次性 connect 同前）

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-client/src/ packages/mcp-client/test/reconnect.test.ts
git commit -m "feat(M23): mcp-client — generation reconnect supervisor (dsh absorb) + mcp/server-status host event + McpServerUnavailableError"
```

### Task 6: resume lazy rebuild——`ensureResidentAgent`

**Files:**
- Modify: `packages/subagent/src/tools.ts`（抽 `ensureResidentAgent`；resume_agent 重構；driveFollowups 前置 ensureResident）
- Modify: `packages/subagent/src/index.ts`（export `ensureResidentAgent`）
- Modify: `packages/agent-team/src/scheduler.ts`（`TeamSubagentDeps` 加 `ensureResident?: (entry: ChildAgentEntry) => Promise<boolean>` injection seam——M19 override seams 先例；`realDeliver` error 閘改「rebuild 成功才繼續」）
- Modify: `packages/agent-team/src/index.ts`（若需 export）
- Test: `packages/subagent/test/resume.test.ts`（新）、`apps/cli/test/cli.test.ts`（加 wakeup e2e——仿 cli.test.ts:865）

**Interfaces:**
- Consumes: `resume_agent` 現有邏輯（tools.ts:177-222）、`AgentTable`/`ChildAgentEntry`、`createAgent`、`deps`（SubagentToolDeps）、`FollowupDeps`（driveFollowups——只用 agents/jobs/table，已證實不需 parentCtx）
- Produces:
  - `export async function ensureResidentAgent(deps: SubagentToolDeps, entry: ChildAgentEntry): Promise<boolean>`（true=已 resident 或重建成功；false=無法重建（e.g. role 未知）——呼叫方決定 fail 行為）
  - **`TeamSubagentDeps` 加 `ensureResident?: (entry: ChildAgentEntry) => Promise<boolean>`**（可選注入面——registerSubagent/mountAgentTeams 掛 subagent 的 ensureResidentAgent；**絕不直接 import subagent 的 SubagentToolDeps**——agent-team 的 sub 無 parentCtx，實證確立）
  - 行為（自 resume_agent:191-221 抽取）：resident 檢查 → role 查找 → child scope mount + child registry → model 解析 → createAgent → agents.register → status = "waiting"（error 標記保留在 entry.error）
  - **M23 只修 wakeup no-op**（driveFollowups 前置 ensureResident）；mailbox/jobs/roles/agent-table 全面一致性留 M24
  - 與 resume_agent 的關係：resume_agent 重構為「ensureResidentAgent + 既有 wrapper 語意」；driveFollowups 開頭：`if (!deps.agents.get(sessionId)) await ensureResidentAgent(deps as SubagentToolDeps, entry)`（**driveFollowups 的 FollowupDeps 不足以重建——需 SubagentToolDeps**——所以 driveFollowups 的 ensureResident 由**呼叫端**（有完整 deps 的 spawn/resume tool）前置，或 driveFollowups 接受可選 `rebuild?: (entry) => Promise<boolean>` 參數——實作時二選一，以後者（參數注入）為免循環的正解）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/subagent/test/resume.test.ts
import { describe, expect, it } from "vitest"
import { ensureResidentAgent } from "../src/tools.ts" // 或 index export
// build minimal deps（agents/hile table/roles/parentCtx...）— 仿既有 subagent test helper
// case 1: entry 有 sessionId + 無 resident agent → ensureResidentAgent 重建 → agents.register 有該 id
// case 2: 已 resident → 直接 true（不重建）
// case 3: role 未知 → false（不 throw——呼叫方決定）
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/resume.test.ts`
Expected: FAIL（ensureResidentAgent 不存在）

- [ ] **Step 3: 實現 tools.ts 抽取 + 接線**

```ts
// packages/subagent/src/tools.ts
export async function ensureResidentAgent(deps: SubagentToolDeps, entry: ChildAgentEntry): Promise<boolean> {
  if (entry.sessionId) {
    const resident = deps.agents.get(entry.sessionId)
    if (resident) return true
  }
  const role = deps.roles.get(entry.roleName ?? "general")
  if (!role) return false
  const childCtx = deps.parentCtx.scope.mount()
  const childReg = createToolRegistry(childCtx)
  for (const name of role.tools) {
    const tool = deps.parentRegistry.get(name)
    if (tool) childReg.register(tool)
  }
  let model = deps.parentModel
  if (role.model) {
    const profile = deps.providers.get(role.model.provider)
    if (!profile) return false
    model = buildModelClient(profile, role.model.model, role.model.extra)
  }
  const controller = new AbortController()
  const agent = createAgent(childCtx, {
    session: entry.session, tools: childReg, model,
    systemPrompt: role.systemPrompt, signal: controller.signal,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
  })
  if (entry.sessionId) deps.agents.register(entry.sessionId, agent)
  entry.status = "waiting"
  entry.controller = controller
  if (entry.sessionId) deps.agents.register(entry.sessionId, agent)
  entry.unmount = () => childCtx.scope.unmount()
  return true
}

// resume_agent 重構：existing.status check → if (existing.sessionId && deps.agents.get(existing.sessionId)) { driveFollowups... } else { await ensureResidentAgent(deps, existing); if (existing.sessionId) driveFollowups... }

// driveFollowups 改（FollowupDeps + 可選 rebuild 注入——免 agent-team 依賴 parentCtx）：
export interface FollowupDeps → 加（向後相容可選）：
  rebuild?: (entry: ChildAgentEntry) => Promise<boolean>

export async function driveFollowups(deps: FollowupDeps, entry: ChildAgentEntry, sessionId: string): Promise<void> {
  const prev = entry.followupChain ?? Promise.resolve()
  const next = prev.then(async () => {
    const agent = deps.agents.get(sessionId)
    if (!agent) {
      if (deps.rebuild) {
        const ok = await deps.rebuild(entry)
        if (!ok) return
      } else {
        return // 無 rebuild 能力 → 維持既有 no-op（M23：subagent 側才掛 rebuild）
      }
    }
    // ...既有 body（agent = deps.agents.get(sessionId) 再取一次）
  })
  // ...既有鏈管理
}

// subagent 側（resume_agent / spawnTool 的 followupTool）呼叫 driveFollowups 時注入 rebuild：
void driveFollowups({ ...deps, rebuild: (entry) => ensureResidentAgent(deps, entry) }, existing, existing.sessionId)
```

```ts
// packages/agent-team/src/scheduler.ts — TeamSubagentDeps 加 + realDeliver 改
export interface TeamSubagentDeps {
  // ...既有（table/jobs/roles/agents/exec/providers/childSessions）
  // M23: rebuild 注入面——由 registerSubagent/mountAgentTeams 掛 subagent 的 ensureResidentAgent
  //（TeamSubagentDeps 無 parentCtx/parentRegistry/parentModel——實證，不能直接調 ensureResidentAgent 完整 signature）
  ensureResident?: (entry: ChildAgentEntry) => Promise<boolean>
}

// realDeliver error 閘改（原 :295：if (!entry || entry.status === "killed" || entry.status === "error") return false）
if (!entry) return false
if (entry.status === "error") {
  if (sub.ensureResident) {
    const ok = await sub.ensureResident(entry)
    if (!ok) return false
  } else {
    return false // 無 rebuild 能力 → 維持保守（訊息留 queue）
  }
}
if (entry.status === "killed") return false
```

（**接線處**：`registerSubagent(ctx, parentRegistry, opts)` 建立 subagent deps 後，`mountAgentTeams(ctx, { ..., subagents: { ...subagentDeps, ensureResident: (entry) => ensureResidentAgent(subagentDeps, entry) } })`——實作時查 run.ts 的 mountAgentTeams 呼叫處，把 ensureResident 掛上。）

- [ ] **Step 4: 跑測試確認通過 + e2e**

Run: `cd packages/subagent && pnpm vitest run` + `cd packages/agent-team && pnpm vitest run` + `cd apps/cli && pnpm vitest run`
Expected: PASS（resume 新 + agent-team 既有 88 + cli 既有 49——wakeup e2e 仿 cli.test.ts:865：resume → followup_task → child log 第三 turn）

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/tools.ts packages/agent-team/src/scheduler.ts packages/subagent/test/resume.test.ts apps/cli/test/cli.test.ts
git commit -m "feat(M23): subagent — ensureResidentAgent lazy rebuild (wakeup no-op fix per M19 Minor 4); agent-team deliver gate adapts"
```

### Task 7: core-session streaming/觀察出口（G1）+ host 事件基座

**Files:**
- Modify: `packages/core-session/src/index.ts`（append hook 從單 WeakMap 擴充為 listener registry——`onAppend` 保留、加 `subscribe(session, listener): () => void`、`append` 通知所有 listeners）
- Modify: `packages/core-plugin/src/index.ts`（若 host 事件機制需基座——查既有 on/emit；M23 用既有 `ctx.on`/`emit` 即可，不新增）
- Test: `packages/core-session/test/subscribe.test.ts`（新）

**Interfaces:**
- Consumes: `append`/`createSession`（既有）
- Produces:
  - `export function subscribe(session: Session, listener: (ev: SessionEvent) => void): () => void`（回退訂閱函數——`fn()` 取消）
  - `createSession(onAppend?)` 保留向後相容（單 hook）；`append` 通知 registry 全部 listeners（含 onAppend）+ 新 subscribers
  - 語意：listeners 收到 append 的**同一**事件物件（含 seq）；訂閱在 append 後立即生效；取消後不再收
  - 這是 G1 的基座——frontend/任何第二消費者靠它 watch live session（dsh `session/event` passthrough 的消費端）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/core-session/test/subscribe.test.ts
import { describe, expect, it } from "vitest"
import { createSession, append, subscribe } from "../src/index.ts"

describe("session append subscription (G1)", () => {
  it("subscriber receives appended events (with seq)", () => {
    const s = createSession()
    const seen: unknown[] = []
    const unsub = subscribe(s, (ev) => seen.push(ev))
    append(s, { type: "user/message", text: "hi" })
    expect(seen).toHaveLength(1)
    const ev = seen[0] as { seq: number }
    expect(ev.seq).toBe(0)
    unsub()
    append(s, { type: "user/message", text: "again" })
    expect(seen).toHaveLength(1) // unsubscribed → no more
  })
  it("multiple subscribers all receive (fan-out)", () => {
    const s = createSession()
    let a = 0, b = 0
    const ua = subscribe(s, () => { a += 1 })
    const ub = subscribe(s, () => { b += 1 })
    append(s, { type: "turn/start" })
    expect(a).toBe(1)
    expect(b).toBe(1)
    ua(); ub()
  })
  it("legacy createSession(onAppend) still works", () => {
    let got: unknown = null
    const s = createSession((ev) => { got = ev })
    append(s, { type: "turn/start" })
    expect(got).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/core-session && pnpm vitest run test/subscribe.test.ts`
Expected: FAIL（subscribe 不存在）

- [ ] **Step 3: 實現**

```ts
// packages/core-session/src/index.ts — 改 appendHooks 為多播
// 保留 createSession(onAppend) 單 hook（向後相容）；新增：
const subscribers = new WeakMap<Session, Set<(ev: SessionEvent) => void>>()

export function subscribe(session: Session, listener: (ev: SessionEvent) => void): () => void {
  let set = subscribers.get(session)
  if (!set) { set = new Set(); subscribers.set(session, set) }
  set.add(listener)
  return () => { subscribers.get(session)?.delete(listener) }
}

// append() 結尾改為：
  session.events.push(ev)
  appendHooks.get(session)?.(ev)
  subscribers.get(session)?.forEach((l) => l(ev))
```

（**注意**：`structuredClone`——write-behind 已 clone；subscribers 收到與 log 同一 `ev` 物件（含 seq）——語意與 onAppend 一致。若未來需要 clone 語意，由訂閱端決定。）

- [ ] **Step 4: 跑測試確認通過 + Commit**

```bash
cd packages/core-session && pnpm vitest run && cd packages/session-persistence && pnpm vitest run
# session-persistence 用 onAppend（M4 mirror）必須不破——確認既有 subscribe 不相關
git add packages/core-session/src/index.ts packages/core-session/test/subscribe.test.ts
git commit -m "feat(M23): core-session — append subscription (multi-listener fan-out, G1 streaming base)"
```

---

## 驗證（全文完）

- [ ] **Step: 跑全部 M23 相關測試 + 全 workspace**

```bash
cd packages/fs-lock && pnpm vitest run
cd packages/session-persistence && pnpm vitest run
cd packages/session-persistence-jsonl && pnpm vitest run
cd packages/session-persistence-sqlite && pnpm vitest run
cd packages/mcp-client && pnpm vitest run
cd packages/subagent && pnpm vitest run
cd packages/agent-team && pnpm vitest run
cd packages/core-session && pnpm vitest run
cd /d/agent-complete/I-harness && pnpm -r test && pnpm -r typecheck
```
Expected: ALL PASS（既有全綠——core-session 新 subscribe 3、fs-lock 5、ownership 1、mcp reconnect 3、resume 3、cli lock option 1）

---

## Plan Self-Review 紀錄（M23）

1. **Spec 覆蓋**：§6.1① MCP auto-reconnect→Task 5；② resume fixes→Task 6；③跨進程 exactly-once→Task 1/2/3（所有權租約——研究修正後的主導方案）；④多進程共享 checkout 鎖→Task 1/2（所有權語意）；§6.2 資料流（reconnect/resume/lock）→對應 tasks；§6.3 測試→各 task；§6.4 吸收→Task 1/5/6（MIT 頭 + THIRD_PARTY_NOTICES——**需在 plan 執行時把 4 個新吸收檔案（fs-lock、supervisor、ensureResidentAgent、sqlite 修正）補進 THIRD_PARTY_NOTICES**）。
2. **Placeholder 掃描**：
   - Task 1 Step 4 的 win32.ts import 是「錯誤示範」卷積——**已標注**：errors 抽到 errors.ts 避免循環（index 動態 import win32）。需確認：`SessionLockConflictError` 應在 errors.ts。
   - Task 2 Step 3 的 coordinator 修改是大改——**enqueue 同步面保留**（acquire 移到 write callback 內——write-behind 失敗保留接手，不破同步簽名）。
   - Task 5 reconnect.test.ts 的測試碼是「簡潔版」骨架——**Step 3 才完整**；需確保四種行為（generation 重建、maxRetries lost、快速失敗、事件 emit）被測。
   - Task 6 agent-team realDeliver 改法——`ensureResidentAgent(subagentDeps, entry)` 的 `subagentDeps` 從哪來？**agent-team 的 deps 需持有 subagent 的 deps 介面**——實作時檢查 agent-team scheduler 的啟動入參（M19 已掛 subagent tools？查 `deps.parentCtx` 是否含 subagent）。**已知風險**：agent-team 可能無直接 SubagentToolDeps——若無，M23 先做「driveFollowups 前置 ensureResident」（subagent 側），agent-team 閘改為「保守 rebuild 若無 deps 則維持原行為」——**實作時以實際依賴為準**。
   - Task 7 的 host 事件——M23 用既有 `ctx.on/emit`（core-plugin 已有）——無新增基座；`mcp/server-status` 走 `ctx.emit` 由 headless logger 消費。
3. **型別一致性**：`SessionLock`/`AcquireOptions`/`SessionLockConflictError` 跨 Task 1/2 一致；`CoordinatorOptions.lock` 跨 Task 2/3；`McpServerStatusEvent`/`McpServerState` 跨 Task 5；`ensureResidentAgent(deps, entry)` 跨 Task 6；`subscribe(session, listener)` 跨 Task 7。
4. **已知取捨（實作時以實際碼為準）**：
   - lock.enabled 預設 **false**（opt-in——不破既有 coordinator 測試；CLI 接線開啟）
   - agent-team scheduler 的 subagent deps 依賴——實作時查；若無則 subagent 側優先（driveFollowups 前置），agent-team 閘保守
   - fs-lock 的 koffi binding 以 sandbox-windows-acl/src/ffi.ts 為範本（zeroed OVERLAPPED gotcha）
   - mcp supervisor 的 streamable-http 雙層（transport 內建 SSE backoff 透傳 config + supervisor session 級）——實作時查 SDK d.ts 的 reconnectionOptions 是否存在（研究已驗證 1.17）
   - resume lazy：M23 只修 wakeup no-op；mailbox/jobs/roles 全面一致性 M24

## 暫不處理（deferred——記錄）
- Linux flock-via-koffi（M24 + CI）
- 多進程 worker 化（child 自寫 log——M24+；second-round concern 1）
- L2 checkout 衝突的 frontend 事件 + 顯式接管流程（M24）
- resume 全面一致性（M24——spec §7.1③）
- MCP UI server 健康呈現（M24+）
- e2e 目錄 / telemetry（M25）
