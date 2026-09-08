# M55：dist 自足化（A 案）+ 收尾小項

日期：2026-09-09 · 整合分支 `m55`（自 `main` @ `b331f60`）
源：`docs/research/2026-09-08-m52-far-future-survey.md` §4（單檔 A 案）、M51–M54 各 review 的 deferred minors

**執行方式**：兩條**獨立分支/worktree** 並行（檔案集互斥），完成後合併回 `m55` 並跑全量門。

| 分支 | worktree | 範圍 |
|---|---|---|
| `m55-dist` | `.worktrees/m55-dist` | `scripts/build-dist.mjs`、`scripts/verify-dist.mjs`、`scripts/build-installer.mjs`、`installer/*`、`apps/cli/**`、`apps/tui/**`、`packages/sandbox-windows-acl/src/index.ts`、`packages/tui/src/minimal/mode.ts`、`packages/tui/src/index.ts` |
| `m55-polish` | `.worktrees/m55-polish` | `packages/tui/**`（commit/engine 註釋與測試、case-015 註釋）、`packages/rewind/src/store.ts`（註釋）、`docs/contracts.md`、`packages/mcp-client/**` |

## Global Constraints

- 每個分支只碰自己那組檔案；不得跨組修改（整合由 controller 做）。
- RED-first（純註釋/文檔項除外）：先寫在 pre-fix 上失敗的測試或**可驗證的失敗 smoke**。
- 不新增外部依賴；發行模型不變（仍是目錄式 dist + NSIS）；不換 runtime。
- 命令環境：`pnpm` = `'/c/Program Files/nodejs/corepack' pnpm`；node 在 `C:\Program Files\nodejs`。`ERR_MODULE_NOT_FOUND @i-harness/tui-core` → `rm -rf apps/tui/node_modules && pnpm install`。
- 推送需用戶明確同意。

---

## A（`m55-dist`）：dist 自足化 + 版本漂移

研究報告 §4.4 的 A 案：**不追求單檔**，把三個 tsx/源碼依賴的 spawn 面改成 bundle 內可用，並釘住版本漂移。

1. **ACL runner**（`packages/sandbox-windows-acl/src/index.ts:464-467`）：目前 `[process.execPath, "--import", "tsx/esm", <runner.ts>]`。改為：dist 模式下以**自身 bundle 的隱藏子命令**重入（例如 `process.execPath <dist entry> __acl-runner …`），源碼模式保持現行 tsx 路徑。判定用既有的 `I_HARNESS_DIST` define。
2. **minimal/fullscreen 自重啟**（`packages/tui/src/minimal/mode.ts:69-81`）：目前 `process.execPath --import tsx process.argv[1]`。改為 dist 模式下重入自身（`process.execPath <argv[1]> <args>`），源碼模式不變。
3. **`loadMinimalHost()` 的動態 import**（`packages/tui/src/index.ts:230-243`）：dist 中 `./minimal/inline.ts` 解析失敗 → fallback fullscreen。讓它可被打包（改 specifier 或用 esbuild 的動態 import 解析），使 **dist 也能進 minimal 模式**。
4. **移除 `I_HARNESS_HOME` 依賴**：`apps/tui/src/index.ts:111-115` 的 `REPO_ROOT`/`TSX_LOADER`/`CLI_ENTRY` 在三個 spawn 面都不再需要後，`I_HARNESS_HOME` 從 README-dist.txt 與 README 的「誠實限制」中移除（或降級為純開發覆蓋）。
5. **版本漂移**：`package.json:8-10` `engines.node >= 22.18` vs `scripts/build-installer.mjs:40` 捆 **22.16.0**。先查清 22.18 的來源（git log/註釋），再選最小修法：**優先**把 `NODE_RUNTIME_VERSION` 預設升到 ≥22.18 的 22.x（讓產品自帶的 runtime 滿足自己宣告的 engines）；若 22.18 只是寬鬆宣告，則改 engines 並在報告說明。無論選哪個，報告要寫明依據。
6. **驗證擴充**（`scripts/verify-dist.mjs`）：新增對 dist 的**真實驗證**——(a) minimal 模式在 dist 可進入（例如 `node ih.mjs tui --minimal --help` 或一個無 TTY 的 smoke）；(b) ACL runner 子命令存在且可被 spawn（隱藏子命令的 `--help`/自檢）；(c) `--attach` 的 SDK spawn 在 dist 可達（或明確記錄仍受限並說明原因）。全部以 exit code 斷言。

**驗收門**（報告附真實輸出）：
```powershell
node scripts/build-dist.mjs
node scripts/verify-dist.mjs
node scripts/build-installer.mjs
node scripts/verify-installer.mjs
pnpm -r typecheck
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/cli test
pnpm --filter @i-harness/sandbox-windows-acl test
```

## B（`m55-polish`）：收尾小項

1. **case-015 標頭修正**：`packages/tui/test/harness/case-015.yaml:19-24` 與 `case-015.test.ts` 標頭寫 "writes = 11"，實際斷言 `writes: 10`——改成 10 並在註釋說明預算來源。
2. **`readDelta` 防禦性終止**（`packages/tui/src/minimal/commit.ts:83-94`）：迴圈在違反契約的 `CommitEngine` 下可能不終止——加一個「讀取未增長即中止」的防禦（並補一個多行 pin 的單元測試，覆蓋多輪加寬路徑）。
3. **`embedded.ts:802` 訊息**：workspace 不符時拋出的 "assembled without rewindStoreRoot" 括註已不準確（root 有給但綁到別處）——改為準確措辭。
4. **`store.ts` 註釋**（`packages/rewind/src/store.ts:14-15`）：「every write path goes through ensureDir()」不實（`clearPending`/`removeBlob` 直接 unlink）——把未防護清單補全（讀寫兩側）。
5. **`docs/contracts.md`**：`session/rewind/plan` 行未載明 turn 級報告（`orphanedTurns`）**僅本地**（CLI factory 會窄化掉）——補一句。
6. **MCP `closeGeneration` 門控**（`packages/mcp-client/src/client.ts:194-204`）：reconnect 未啟用時仍永久關閉 client——改為僅在有已註冊的 disconnect 回調（或 reconnect 啟用）時關閉，否則維持既有上浮行為；補測試。
7. **MCP 測試衛生**：`packages/mcp-client/test/oauth-real-as.test.ts:519` 的 `setTimeout(100)` 改為輪詢 callback server 就緒；`mountMcpClient({} as never, …)` 改用上一行的 `ctx`。

**驗收門**（報告附真實輸出）：
```powershell
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui typecheck
pnpm --filter @i-harness/tui exec vitest run test/harness/case-015.test.ts
pnpm --filter @i-harness/rewind test
pnpm --filter @i-harness/mcp-client test
pnpm --filter @i-harness/mcp-client typecheck
```

---

## 整合（controller）

兩條分支完成並各自 review 通過後：合併進 `m55` → `pnpm -r typecheck` + 受影響包測試 + dist/installer 驗證 → 推送（待批准）。
