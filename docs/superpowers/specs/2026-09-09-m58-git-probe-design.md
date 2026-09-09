# M58 設計：R-B4 A — git 唯讀對照（plan().unseen）

日期：2026-09-09 · 分支 `m58`（自 `main` @ `464c1ea`，= m57 尖端）· 前置研究：`docs/research/2026-09-08-m52-far-future-survey.md` §1（R-B4 缺口與 A/B/C 取捨）

## 1. 問題

`packages/rewind` 的 v1 誠實邊界（`types.ts:64-70`、`service.ts:28-38`）：**recorder 只看見 fs 工具**（write/edit/apply_patch）。bash、外部編輯器、其他進程、其他 session 的寫入**完全隱形**——`plan()` 的 `unTracked` 只涵蓋「本 session 後續回合記錄過、但目標回合沒有的路徑」，對「從來沒被記錄過的變更」一無所知。

後果：使用者 rewind 後，磁碟上仍有一批引擎「無法解釋」的變更，而 UI 與 plan 都不提——這與本倉「誠實降級」的立場相違。

## 2. 目標（R-B4 A）

**plan() 時唯讀對照 workspace 的 git 狀態，把「引擎無法解釋的磁碟變更」誠實列出。**

- 唯讀：不寫 index/refs/工作區、不執行任何會取鎖的 git 命令（`GIT_OPTIONAL_LOCKS=0`）。
- 加性：`RewindPlan` 新增**可選**欄位 `unseen?`；既有欄位語意不變。
- fail-soft：非 git work tree、git 缺失、超時、任何錯誤 → 欄位**缺席**（不是空陣列），plan() 絕不因 git 失敗而拋。
- 不捏造 op：unseen 的路徑**永不**進 `ops`（與 M54 orphanedTurns 同款：只列不猜）。

## 3. 精確性規則（本設計的核心）

單純「git 髒檔案 − 已覆蓋」會誤報：**agent 自己未提交的既有回合寫入**也會是髒的，但引擎其實「知道」它們。故以日誌自身的 `afterHash` 作解釋器：

對每個 git 髒路徑 P：

| 情況 | 處置 |
|---|---|
| P ∈ 目標回合的 files | **跳過**（plan 已以 clean/conflict/op 分類；shell 再改已由 afterHash 判為 `modified` conflict） |
| P ∈ `unTracked`（後續回合記錄、非目標集合；含 orphan 路徑） | **跳過**（已在 unTracked 列出；再加一次是重複） |
| P 曾在**更早**回合被記錄 → 取該路徑**最新**一筆 `afterHash`：<br>· 現盤 hash 相等 → 跳過（recorder 最後一次看到後未變＝agent 自己的工作）<br>· 現盤 hash 不同 → **unseen**（最後一次記錄後被改）<br>· 該回合記錄為「刪除」（無 afterHash）且現盤仍不存在 → 跳過（刪除已被解釋）<br>· 無 afterHash 但現盤存在 → **unseen**（記錄後被重建） |
| P 從未被任何回合記錄 | **unseen**（recorder 從未看見） |

這讓 `unseen` 的語意精確為：**「現盤內容無法由日誌解釋的變更」**，而非模糊的「git 髒檔案」。

## 4. 形狀

```ts
// packages/rewind/src/types.ts（加性）
export type UnseenChangeKind = "modified" | "untracked" | "deleted"
export interface UnseenChange {
  /** 工作區相對正規化路徑（同 RewindFileRecord.path 的鍵空間）。 */
  path: string
  kind: UnseenChangeKind
}

export interface RewindPlan {
  /* …既有欄位不動… */
  /** M58 R-B4 A：git 唯讀對照發現、日誌無法解釋的磁碟變更（永不進 ops）。
   * 缺席 = 非 git work tree / git 不可用 / 無此類變更。 */
  unseen?: UnseenChange[]
}
```

```ts
// packages/rewind/src/git-probe.ts（新檔）
export interface GitProbe {
  /** 唯讀；永不拋。非 work tree / git 不可用 → []。路徑為工作區相對。 */
  changes(): Promise<UnseenChange[]>
}
export function createGitProbe(opts: {
  workspace: string
  /** 排除前綴（工作區相對，例如本 session 的 rewind store 目錄若落在工作區內）。 */
  excludePrefixes?: string[]
  timeoutMs?: number
  /** 測試注入；預設 node:child_process.execFile。 */
  exec?: ExecLike
}): GitProbe
```

- **探測**：`git -C <workspace> rev-parse --is-inside-work-tree --show-toplevel`（一次 spawn；非 `true` → `[]`）。
- **取變更**：`git -C <workspace> status --porcelain=v1 -z --untracked-files=all`，env `GIT_TERMINAL_PROMPT=0` + `GIT_OPTIONAL_LOCKS=0`，`timeout`（預設 5s）、`maxBuffer`。
- **解析**：`-z` 串流以 NUL 分隔；每筆前 3 bytes 為 `XY `；`R`/`C` 條目**多帶一個 NUL 分隔的舊路徑**（新路徑記 `modified`、舊路徑記 `deleted`，兩者皆為現盤事實）。
- **kind 映射**：`??` → `untracked`；X 或 Y 含 `D` → `deleted`；其餘（含 `R` 新路徑）→ `modified`。
- **路徑正規化**：porcelain 路徑相對 **repo toplevel**；`absolute = join(toplevel, p)` → `relative(workspace, absolute)`；落在工作區外（`..`/絕對）→ 丟棄；再經 `normalizeRelPath`（`path.ts`）落到日誌鍵空間。
- **排除**：`excludePrefixes`（服務層傳入 rewind store 目錄的工作區相對形式，若在工作區內）——避免把自己的 `points.jsonl`/blobs 報成 untracked。

## 5. 服務接線

- `RewindServiceOptions` 加 `gitProbe?: GitProbe`（**缺席 = 關**，保持引擎純淨與單元測試確定性）。
- `plan()` 在 `unTracked`（含 orphan 合併）**之後**、`return` 之前插入：
  ```
  const changes = await this.gitProbe?.changes() ?? []
  unseen = 依 §3 規則過濾（covered = targetPaths ∪ unTracked；更早回合用 lastAfterHash + diskHash）
  ```
- 產品呼叫點（兩處）顯式注入：`packages/tui/src/backend/embedded.ts:806`、`apps/cli/src/index.ts:402`。
  兩處都傳 `createGitProbe({ workspace, excludePrefixes: [<rewind 目錄若在工作區內>] })`。

## 6. Wire / UI 範圍

- **SDK**：`RewindPlanResponse`（`packages/sdk/src/protocol.ts:423`）加 `unseen?: UnseenChangeWire[]`（加性；伺服器端 `session/rewind/plan` 直接回引擎結果物件，執行期已自然帶出）。契約註記：v1.1 加性變更，不需 bump。
- **TUI**：**本切片不做**（先例：M54 `orphanedTurns` 同樣只在引擎 plan、未進 TUI/wire）。列為後續小切片。

## 7. 非目標

- **不做 restore**：unseen 只是列表；不提供「一鍵還原」（那是 B 案的破壞面）。
- **不做 git checkpoint 引擎（B）**：不寫任何 git 物件、不碰使用者 repo 的 index/refs。
- **Never（C）**：不用 `git stash create`/checkout 動使用者 repo。
- **不新增依賴**：只用 `node:child_process`/`node:path`（Node 內建）。

## 8. 風險

| 風險 | 緩解 |
|---|---|
| git status 取 index 鎖 | `GIT_OPTIONAL_LOCKS=0`（唯讀保證）；仍失敗 → fail-soft 缺席 |
| 大 repo 慢 | `timeout` 預設 5s；只在 plan() 呼叫（非熱路徑） |
| workspace 是 repo 子目錄 | 以 toplevel 反推工作區相對路徑，區外丟棄 |
| 自己 store 被列出 | `excludePrefixes`（服務層由 store.pointsFile 推導） |
| 誤報 agent 自己的未提交工作 | §3 的 afterHash 解釋器（本設計的核心） |
| 非 git 使用者 | 行為完全不變（欄位缺席） |

## 9. 驗收

1. 單元：`git-probe.test.ts`（注入 fake exec）——porcelain `-z` 解析（M/A/D/??/R）、toplevel 映射、區外丟棄、exclude 前綴、非 repo → `[]`、exec 拋錯 → `[]`。
2. 整合：`git-plan.test.ts`——真臨時 git repo（`git init` + commit）：shell 改檔（模擬 recorder 未見）→ `plan().unseen` 列出且 kind 正確；agent 自己記錄過的檔（afterHash 相等）→ **不**列出；被 shell 再改 → 列出；更早回合記錄的檔未變 → 不列出；非 git workspace → 欄位缺席。
3. 既有 `packages/rewind` 全測試綠（未注入 probe 時行為 byte-identical）。
4. `pnpm -r typecheck`、`pnpm --filter @i-harness/tui test`、`pnpm e2e` 綠。
