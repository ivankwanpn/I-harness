# I-harness M23-Complete 計劃（Linux flock + M23 四小修）

> 接續 M23（2026-08-27 plan 完成後）。範圍經 brainstorming 定案（2026-08-28）：
> ① Linux flock-via-koffi（fs-lock 跨平台補全）② coordinator 四小修（I1/M1/M2/M3）
> ③ WSL 真實驗證（本機 Windows 無 Linux；WSL2 Ubuntu 24.04 已裝 node v22.23.2 + pnpm 11.6.0）。
> 方向：M20-M25 設計檔——完整 agent 目標、單進程 CLI 宿主、前端準備介面但不建。

## Global Constraints
- Windows 優先測試主戰場；Linux 順帶、**必須 WSL 真實驗證**；macOS 維持 fail-closed（SessionLockUnsupportedError）
- 零新 npm 依賴（koffi 既有 sandbox-windows-acl dep，已有先例）
- ESM + strict TS（strict/noUnusedLocals/noUnusedParameters） + pnpm workspace
- 所有權租約語義不變：非阻塞 acquire（LOCK_EX|LOCK_NB）+ JS backoff + deadline → SessionLockConflictError；OS 死程自動釋放（無 stale-lock）
- Fail-closed 紀律：任何平台缺失 → typed SessionLockUnsupportedError（不 silent 退化）
- Koffi binding 只 lazy import（linux.ts/win32.ts 各自 lazy）

## Task 1: Linux flock-via-koffi（`packages/fs-lock/src/linux.ts`）

**Files:**
- Create: `packages/fs-lock/src/linux.ts`（flock(2) koffi 綁定——非阻塞 LOCK_EX|LOCK_NB + JS backoff，語義與 win32.ts 對稱）
- Modify: `packages/fs-lock/src/index.ts`（`process.platform !== "win32"` 分派 → linux.ts；**darwin 仍 SessionLockUnsupportedError**）
- Test: `packages/fs-lock/test/fs-lock.test.ts`（Linux describe skipIf(process.platform !== "linux") + linux.ts 單元測試）

**Interfaces:**
- Consumes: `AcquireOptions`/`SessionLock`（index.ts）、`SessionLockConflictError`/`SessionLockUnsupportedError`（errors.ts）
- Produces: `acquireLinux(opts: AcquireOptions): Promise<SessionLock>`（內部）

**行為（與 win32 語義對稱）：**
- `fs.openSync(lockPath, "a+")` → fd（數字 int）
- koffi lazy load libc.so.6：`flock(fd, LOCK_EX|LOCK_NB)`（LOCK_EX=2, LOCK_NB=4）→ 0 成功 / -1 失敗 errno
- errno EAGAIN(11)/EWOULDBLOCK(11) → conflict → JS backoff（retryMs→retryMaxMs doubling）→ deadline → SessionLockConflictError
- release: `flock(fd, LOCK_UN)`（LOCK_UN=8）+ close(fd)；idempotent（held flag）
- **fd 來源：node fs.openSync（非 koffi open）**——fs.openSync 已在 node core，不用 koffi 綁 open；fd 數字可直接傳 koffi flock(int)
- **koffi 綁定：flock 用 libc.so.6（glibc；musl 同函式名）**：`lib.func("flock", "int", ["int", "int"])`；errno 用 `koffi.errno()` 或綁 `__errno_location()`（glibc 有 __errno_location；musl 有 __errno_location 同）。需查 koffi 的 errno API——**koffi 提供 `koffi.errno()`**（文檔：koffi.errno() 回傳最後錯誤碼）——用它
- 失敗（koffi load/libc 缺失）→ SessionLockUnsupportedError（fail-closed）

**測試：**
- `it.skipIf(process.platform !== "linux")`: acquire 成功；第二 acquire conflict（fail-closed）；release 後 re-acquire；release idempotent；lockPathFor 位置
- 單元：非阻塞（acquire 時第二個立即 conflict 不 hang）
- 本機 Windows 跑 win32 path（skipIf linux）；linux path 只在 WSL 跑（skipIf win32）

**Commit:**
`git add packages/fs-lock/src/linux.ts packages/fs-lock/src/index.ts packages/fs-lock/test/fs-lock.test.ts && git commit -m "feat(M23-complete): fs-lock — Linux flock-via-koffi (non-blocking LOCK_EX|LOCK_NB + JS backoff, glibc/musl, darwin stays fail-closed)"`

## Task 2: coordinator 四小修 I1/M1/M2

**Files:**
- Modify: `packages/session-persistence/src/index.ts`（三處）
- Test: `packages/session-persistence/test/ownership.test.ts`（補三例）

**Interfaces:**
- 無新 API 面——純內部修復

**① I1 single-flight（L165-169 ensureOwnership）**：per-session in-flight acquire promise cache
```ts
const inflightAcquires = new Map<string, Promise<SessionLock>>()
async function ensureOwnership(sessionId: string): Promise<void> {
  if (!lockEnabled || heldLocks.has(sessionId)) return
  let lock = inflightAcquires.get(sessionId)
  if (!lock) {
    lock = acquireLease(sessionId)
    inflightAcquires.set(sessionId, lock)
    try { const l = await lock; heldLocks.set(sessionId, l) }
    finally { inflightAcquires.delete(sessionId) }
  } else { await lock; const l = await lock; heldLocks.set(sessionId, l) } // shared promise
}
```
（更簡潔：cache promise；await 後 set heldLocks；finally delete——併發同 session 只發一次 acquire。爭議：後到者 await 同一 promise 成功後 set heldLocks——heldLocks.has 已 true 則略過。）

**② M1 close() release 不 sync-throw（L327-340）**：
```ts
// 現：await Promise.allSettled([...writeBehinds.values()].map((wb) => wb.flush()))
// close() 尾部釋放：for (const [id, lock] of heldLocks) await lock.release() 改 try 或 Promise.allSettled 包 sync-throw
```
正確修：`await Promise.allSettled([...heldLocks].map(([, lock]) => Promise.resolve().then(() => lock.release())))`——Promise.resolve().then 讓 sync throw 變 rejection 進 allSettled；所有租約都嘗試釋放，不因第一個 throw 跳過後續。

**③ M2 failed-create 不持租約（create() L263-276）**：backend.create throw → releaseOwnership(sessionId)（若本 create 取得）→ rethrow。

**測試：**
- I1：同 session 兩併發 append/enqueue → 只一個 acquire（mock acquireLease 或第二 acquire 不 conflict——實測：兩併發 ensureOwnership 同 session 均成功）
- M1：release 拋錯 → close() 仍釋放其他租約（mock 一個 release throw，另兩個成功）
- M2：backend.create throw（duplicate session）→ lease 釋放（ownerOf false）

**Commit:**
`git add packages/session-persistence/src/index.ts packages/session-persistence/test/ownership.test.ts && git commit -m "fix(M23-complete): coordinator — single-flight acquire (I1), close() release all-settled (M1), failed-create releases lease (M2)"`

## Task 3: sqlite M3 lockRoot 防護

**Files:**
- Modify: `packages/session-persistence-sqlite/src/index.ts`（lockRoot 計算）
- Test: `packages/session-persistence-sqlite/test/sqlite.test.ts`（補 1 例）

**行為：**
現：`lockRoot: dirname(dbPath)`（L55-56 附近）。`dirname(":memory:")` = "."；`dirname("relative.db")` = "."。
修：`lockRoot: dbPath === ":memory:" || dirname(dbPath) === "." ? ... `——`:memory:` 用 `process.cwd()` + 明確標記（或 mkdtemp/固定 .i-harness-locks 下）；相對路徑 dirname "." → cwd（與 CLI 顯式 dir 一致）。**保留既有 sqlite 測試不破（CLI 傳 dir 免疫）**。

**測試：** `:memory:` backend → lockRoot 非 "."（cwd 或 tmp）；相對路徑 → cwd。

**Commit:**
`git add packages/session-persistence-sqlite/src/ packages/session-persistence-sqlite/test/ && git commit -m "fix(M23-complete): sqlite — lockRoot guards :memory:/relative paths (M3)"`

## 驗證（WSL）
- WSL2 Ubuntu 24.04 + node v22.23.2 + pnpm 11.6.0（nvm 裝好，helper: `.superpowers/sdd/2026-08-27-i-harness-m23-session-interop/wsl-node.sh`）
- WSL 內跑 fs-lock Linux 真實驗證（linux.ts 全链：acquire/conflict/release/idempotent/auto-release-on-death）
- 需 WSL-local pnpm install（Linux koffi binary——Windows node_modules 的 koffi 是 win32 binary）
- 驗證範圍：`packages/fs-lock`（Linux path）；其餘 Windows 本機跑

## 本輪 deferred（記錄）
- GitHub Actions CI（無基礎——Linux 驗證用 WSL，非 CI）
- M24 四組件（skills/workflows/resume 一致性/subagent 補全）——M23-complete 完成後另起
- L2 checkout frontend 事件 → M25+（前端後）
- 多進程 worker 化 → M24+（設計檔未列）
