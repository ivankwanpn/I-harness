# M54：並行修復（sticky 重複 / rewind G2+G3 / rewind G5）

日期：2026-09-08 · 整合分支 `m54`（自 `main` @ `6d46825`）
源：`docs/research/2026-09-08-m52-rewind-cold-start.md`（G2/G3/G5）、M52 review 的 sticky 發現

**執行方式**：三條**獨立分支/worktree** 並行（檔案集互斥），完成後合併回 `m54` 並跑全量門。

| 分支 | worktree | 範圍（檔案） |
|---|---|---|
| `m54-sticky` | `.worktrees/m54-sticky` | `packages/tui/**`、`packages/tui/test/harness/case-015.*` |
| `m54-rewind` | `.worktrees/m54-rewind` | `packages/rewind/**`、`packages/session-executor/src/assembly.ts`（+測試） |
| `m54-fork` | `.worktrees/m54-fork` | `packages/session-persistence/src/fork.ts`（+測試） |

## Global Constraints

- 每個分支只碰自己那組檔案；**不得**跨組修改（整合由 controller 做）。
- RED-first：每項先寫在 pre-fix 代碼上失敗的測試。
- 結果形狀/線協議/on-disk 只可加性擴展；不新增外部依賴；不做無關重構。
- 命令環境：`pnpm` = `'/c/Program Files/nodejs/corepack' pnpm`；node 在 `C:\Program Files\nodejs`；探針用 `--experimental-transform-types`。`ERR_MODULE_NOT_FOUND @i-harness/tui-core` → `rm -rf apps/tui/node_modules && pnpm install`。
- 推送需用戶明確同意（controller 統一處理）。

---

## A1 `m54-sticky`：minimal 提交逐字提交 sticky user pin → 用戶行重複 + 末行擱置

- 位置：`packages/tui/src/scrollback/engine.ts`（`viewport()` 前置 sticky 最新用戶行）+ `packages/tui/src/minimal/commit.ts`（`pendingDelta` 逐字提交 viewport 行）。
- 症狀（M52 implementer 探針）：用戶提交 `["❯ GO"]` → 助手提交 `["❯ GO","A0","A1"]`（用戶行重複），且 `A2` 永不提交（末行擱置）。
- 修法（M52 已驗證的本地修法）：`pendingDelta` 剝除 sticky 行並把視窗相應放大（保持已提交語意）。
- **Controller Ruling**：`case-015.yaml` 目前釘住的正是這個缺陷的產物（三行 `❯ hello`）——**允許**改釘子為修正後內容；**行數、baseY、byte budget 必須不變**（M52 已驗證不變），且必須在報告列出「哪些 row 斷言改了、為什麼」。
- 驗收：`pnpm --filter @i-harness/tui test`、`typecheck`、`case-015` 單跑綠。

## A2 `m54-rewind`：G2（轉中崩潰）+ G3（journal 未綁 workspace）

- **G2**：`RewindRecorder.pending` 只在記憶體、blobs 只在 `finalize()` 寫 → 崩潰那一輪的 point 與前像全失，其檔案既不進 `plan().ops` 也不進 `unTracked`（靜默殘留）。
  - 修法方向（研究報告 §G2）：durable pending-turn sidecar（寫入 `rewind/<sid>/` 的暫存）＋ `recoverPending()`（載入時把未完成的 pending 併入 points 或以誠實狀態標記），assembly 在建立 store 時呼叫。
  - 語意要求：崩潰後**不得**讓該輪的檔案靜默消失；至少 `plan()` 要能列出/標記（`unTracked` 或明確的 conflict/狀態）。誠實優先於自動恢復。
- **G3**：journal 是 workspace 相對路徑，workspace 未持久化 → 換 cwd resume 會靜默還原到錯的樹。
  - 修法方向：在 `rewind/<sid>/` 寫 `meta.json`（含 workspace 絕對路徑）＋ 載入時比對，不符則 fail-loud 或明確拒絕（不得靜默）。
- 驗收：`pnpm --filter @i-harness/rewind test`、`pnpm --filter @i-harness/session-executor test`、兩包 typecheck。

## A3 `m54-fork`：G5 — fork 復活被 rewind 隱藏的輪次

- 位置：`packages/session-persistence/src/fork.ts`（`completedTurnPrefix`）。
- 症狀：G1 修好後 fork 可用，但 `completedTurnPrefix` 不理 `rewindCuts` → 被 rewind 隱藏的輪次會出現在分叉出的 session。
- 修法方向：計算 prefix 時套用 `rewindCuts(session)`（core-session 已導出），與 `deriveMessages` 的隱藏語意一致；不得改 fork 的其他語意。
- 驗收：`pnpm --filter @i-harness/session-persistence test`、`typecheck`。

---

## 整合（controller）

三條分支完成並各自 review 通過後：合併進 `m54` → `pnpm -r typecheck` + 受影響包測試 + case-015 → 推送（待批准）。
