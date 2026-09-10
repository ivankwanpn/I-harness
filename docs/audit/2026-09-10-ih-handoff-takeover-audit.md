# I-harness 接手核查（takeover audit）

日期：**2026-09-10 20:09**（21:0x 依「以遠端為準」複核後改寫 §0）· 倉庫 `D:\I-harness-main`
**權威來源＝遠端**：`origin/main` = `origin/m61` = **`0d1d63fd`**（09-10 19:40）· 本機 `main` 與它**逐字相同**（已 `git fetch --all --prune` 複驗）
前一份交接：`docs/audit/2026-09-10-ih-m61-parity-handoff.md`（09-10 17:28）

**一句話**：基線**健康**（typecheck 0 錯、70 專案 / 3,272 測試全綠、CLI 可跑）；本機 `node_modules` 曾被一次安裝中斷挖空，**已修復並複驗**。但以遠端為準之後，真正的狀況是：**遠端只有 `main` 與 `m61` 兩個分支，都停在 `0d1d63fd`；這台機器上另有一段從未推送、也從未與遠端合流的 20-commit 工作（settings 單一捲動面板）**（§0）。而那份「tui-beta 移植」新方向**根本不在遠端**——它是本機工作樹的未追蹤檔案（§5.1）。

> 只想知道「遠端權威狀態是什麼」→ §0。只想知道「現在能不能動」→ §1。想知道「下一步該做什麼」→ §6。

---

## 0. 以遠端為準：兩個 M61 的分歧（本節為 21:0x 追加）

### 0a. 遠端的事實（`git ls-remote --heads origin`，實查）

| ref | sha | 日期 |
|---|---|---|
| `refs/heads/main` | `0d1d63fd` | 09-10 19:40 |
| `refs/heads/m61` | `0d1d63fd` | 09-10 19:40 |

**遠端沒有** `tui-beta-*`、`m61-settings`、或任何 settings 分支。所有其他遠端分支（m26…m60）都停在 09-09 及更早。`0d1d63fd` 的 parent 是 `351923af`（09-10 17:41，case-027 隔離 + 根 `test` 加 `--no-bail`），也就是**遠端那條 M61 是「parity 收尾 → web 柵欄 → TUI 凍結 → CLI/web」那條線**。

### 0b. 這台機器上另有一段沒推送的 M61（**遠端看不到**）

`.worktrees/m61`（分支 `m61`）@ **`463714e5`**（09-09 22:26），自 `main` @ `ab07e565`（M60 尖端）分出：

- **20 個 commit 不在 `origin/main`**（`git rev-list --left-right --count origin/main...m61` → **21 / 20**；merge-base = `ab07e565`）。
- 它的交接文件是 **`docs/audit/2026-09-09-ih-m61-handoff.md`**——**與遠端那條線的 M61 文件同一天、同名不同檔**（這正是「以遠端為準」容易踩到的陷阱：兩份 M61 交接）。
- 內容：**settings 單一捲動面板**（grok 版面：分節標頭、右對齊值欄、`/ to search`、`d` 重置、`g`/`G`、`F2`）+ 修一個既有缺陷（通用 overlay 的 j/k 方向是反的）。23 檔，+2069/−272。
- **本輪實測它仍然是綠的**：`pnpm -r typecheck` exit 0；`pnpm --filter @i-harness/tui test` → **71 檔 / 787 passed**；scoped 跑 `keys`/`settings-modal`/`present`/`keys-m46a` → 4 檔 / 74 passed。

### 0c. 兩條線已經互相重複與互相缺少

**重複（可無痛丟棄一邊）**：兩邊都有一個「vim/grok j/k 方向」commit——遠端 `0d1d63fd` 與本機 `c01a5c74`，**patch-id 完全相同**（`d30220b0…`），是真正的重複補丁，不是兩份不同實作。等價的 case-027 隔離兩邊也各有一份（`351923af` vs 本機的隔離 commit）。

**本機 settings 線缺的（遠端 M61 有、它沒有）**：resume 預設持久化、cancel signal（殺得掉 parked request）、fs 失敗改為回傳、installer 不再出貨舊 bundle + 圖片 `inputModalities`、picker 過濾空殼、`i-harness sessions`、web `/` 唯讀頁、events 404 guard、**web Host/Origin 柵欄**、`--no-bail`。
→ 本輪實證其中一條的後果：settings 樹**沒有** `packages/tui/vitest.quarantine.config.ts`，**case-027 仍在它的預設閘門裡**（遠端已把它移出）。也就是說：**如果不做整合就直接用這條分支，等於把 M61 已經關掉的那條並行 flake 又打開，同時失去柵欄等安全性修復。**

**整合的衝突面（好消息，比看起來小）**：9 個檔案兩邊都動過，但其中 6 個正是被「重複的 j/k 補丁」動到的（`keys.ts`、`case-013/017.yaml`、`keys.test.ts`、`keys-m46a.test.ts`、`rewind-bridge.test.ts`）→ 遠端已含同一補丁，實際衝突面只有 **`src/app/present.ts`、`src/views/agent.ts`、`src/app/loop.ts`** 三個（settings 的重疊部分其實很小）。
→ 但也因此：settings 樹的 harness 釘子（case-013/017 等）是建立在**與遠端相同**的 j/k 前提上，所以重釘風險低；然而 `case-028/029` 與 `present.test.ts`/`welcome.test.ts` 的差異要注意（遠端那條線動過 case-028）。

### 0d. 結論：真正待裁定的不是「tui-beta 要不要做」，而是「settings 面板要不要救」

- 若**要救**：把本機 `m61`（20 commit）**rebase 到 `origin/main`**，解那 3 個檔的衝突 + 重釘受影響 harness，跑兩段閘門（`pnpm test` 兩段）。
- 若**不要救**：遠端 `0d1d63fd` 就是完整、已驗證的現況，本機這 20 個 commit 只是歷史；那就直接以遠端為基線往下走（§6 決定 C/D）。
- **兩者都不需要碰 tui-beta**——那條線沒有進遠端，要不要繼續是**另一個獨立決定**（§6 決定 B）。

---

## 1. 現況基線（本輪實測，非引用）

| 項目 | 結果 | 怎麼驗的 |
|---|---|---|
| `pnpm -r typecheck` | **exit 0**（68 套件 + 3 app） | 修好 node_modules 後實跑 |
| `pnpm test`（= `pnpm -r --no-bail test && pnpm test:quarantine`） | **exit 0** · **70 專案全跑** · **322 測試檔 / 3,272 測試** | 實跑，輸出落 `.tmp-run2.log` |
| `case-027`（隔離閘門） | **1 passed / 4,832ms** — 本輪**沒有** flake | `pnpm --filter @i-harness/tui test:quarantine` 由根 `pnpm test` 帶起 |
| `pnpm --filter @i-harness/tui test` | **70 檔 / 772 passed** | 實跑 |
| `pnpm --filter @i-harness/web-host test` | **16 檔 / 163 passed** | 實跑 |
| `pnpm --filter @i-harness/tui-app test` | **1 檔 / 31 passed** | 實跑 |
| `pnpm --filter @i-harness/cli test` | **9 檔 / 114 passed | 1 skipped** | 實跑 |
| CLI 冒煙 | `--version` → `0.1.0`；`sessions list` → 正常回應 | 實跑 `node --import tsx apps/cli/src/index.ts` |
| 工作樹 | 乾淨；僅 3 個未追蹤研究文件（§5.1） | `git status --short` |
| 已安裝的 app | `C:\Program Files\I-harness`，bundle **09-09 23:34:56**（5,069,405 B） | 檔案時間戳 |

> **M61 交接 §7a 的數字全部複驗通過**：typecheck 0 錯、web-host 163、tui 771→現 772（多一條 mode-cycle）。那些數字不是過期的。

### 1a. 本輪修好的東西：node_modules 被挖空

接手時 `pnpm -r typecheck` 會紅在 `apps/tui`：`Cannot find module '@i-harness/session-persistence'`。追下去不是程式問題——**`apps/tui/node_modules/@i-harness/` 少了 `session-persistence` 這一條 junction**，而更底層的 `node_modules/.pnpm` **整棵不存在**（只有 9 個項目，其餘 68 個套件拿不到 `@types/node`）。

- 成因：一次 `pnpm install` 走到 `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`（pnpm 由 11.7.0 換到 12.3.4，要先清掉 modules 目錄，但清到一半 `存取被拒 (os error 5)`）→ 樹被留下半殘狀態。
- 處置：先以 junction 補回 `session-persistence`（暫時解除 apps/tui 的紅），再完整 `pnpm install`（**成功**：189 套件、6s、reused 189 / downloaded 0），`.pnpm` 回到 **190** 個目錄。
- 複驗：typecheck exit 0、`pnpm test` exit 0。
- 環境：Node **v24.15.0**、pnpm **12.3.4**、store `D:\.pnpm-store\v11`、root `node_modules` 156 MB。

> ⚠️ **這是本輪唯一被我改動的狀態**（加上新建的 junction 與一次 install）。若你要重現，指令就是 `pnpm install`。

### 1b. 一個非缺陷紅燈：`packages/shell` 的 14 條測試與**真實產品缺口**

單獨跑 `pnpm --filter @i-harness/shell test` 會紅 **14/33**（`shell.test.ts` 11 條、`spill-notice.test.ts` 3 條）。

**這不是回歸，是 PATH 環境。** 實證：把 `C:\Program Files\Git\bin` 加進 PATH 再跑同一包 → **33/33 全綠**（865ms）。根 `pnpm test` 之所以是綠的，是因為我在跑它之前就注入了同一個 PATH。

**但它背後藏著一個真的產品問題**：

- 本機 Git for Windows **有裝**（`C:\Program Files\Git\bin\bash.exe` 與 `usr\bin\bash.exe` 都在）。
- 但使用者 PATH 只有 **`C:\Program Files\Git\cmd`**（Git 的標準安裝行為）。`cmd` 目錄**沒有** `bash.exe`。
- `packages/shell/src/index.ts:28-43` 的 `bashAvailable()` 只做**一條** PATH 掃描（`join(p, "bash.exe")`），**不探 Git 的已知安裝路徑**。
- 後果：在**標準安裝的 Windows + Git** 上，`bash` 工具回 `bash is not installed on this host (no bash.exe on PATH)`（`index.ts:229-237`），模型被迫全程用 `pwsh` 工具。以 README 高舉的「**Windows 一等**」標準，這是一條值得補的缺口（同一個 bug class 的 `resolvePwshExe()` 已經處理了 PS7 缺席，**但它是靠 `$SystemRoot` 而不是 PATH**——`bashAvailable` 沒有等價的 fallback）。

### 1c. 一個閘門可靠性問題（方法論，非程式缺陷）

第一次跑 `pnpm test` 時，它**停在 56/70 個專案**，`packages/tui`、`web-host`、`session-executor`、`apps/*` 等 **14 個專案根本沒被執行**，卻以 `ERR_PNPM_RECURSIVE_FAIL: failed in 1 packages` 收場（唯一紅的是 `packages/shell`）。同一條命令在**無管線、無並行**的情況下重跑 → **exit 0、70/70 全跑**。

- 誠實標註：那兩次執行彼此並行、又與 `packages/tui`（96s）等重量級套件搶機器，所以我**不能斷言**根因是「負載」或「管線」。可斷言的是：**這條閘門在壓力下會靜默少跑專案，而它的失敗訊息不會告訴你少了哪些。**
- 對策（未做，待你決定）：`pnpm test` 失敗時補一行「哪些專案沒回報」的核對；或宣告 release 前用「專案數 == workspace 專案數」當閘門的一部分。
- 這也解釋了為什麼 M61 只把 `case-027` 的預算往上調會沒用——現場看到的可能是**根本沒跑到**，不是跑得慢。

---

## 2. 新方向：`tui-beta` 移植（分支 `tui-beta-1`）——**尚未開始寫任何程式**

### 2.1 它是什麼

把 **opencode 1.18.30 的 TUI**（SolidJS + `@opentui`）**逐檔複製**進來（`tui-beta/`，243 檔已入版控；`src/` 185 檔 / **31,714 行**），目標是讓它跑在 **Node 24** 上、並由 **I-harness 自己的資料層同進程餵養**（無 HTTP/SSE、無 SDK wire）。

三個 commit（`tui-beta-1` 相對 `main`）：vendor 複製 → 適配設計（S0/S1/S2/S2b）→ 6 任務實作計畫（703 行）。

### 2.2 進度：**0 / 6**

計畫 `docs/superpowers/plans/2026-09-09-tui-beta-adaptation.md` 的每一個 checkbox（T1–T6）**全部未勾**。而且連 T1 的前提都還沒做：`packages/tui-beta/` **不存在**，vendored 樹還在分支根目錄的 `tui-beta/`，且它的 `package.json` 仍是**原始上游形狀**（name `@opencode-ai/tui`、`bun test`、`catalog:` 版本、4 個不存在的 `@opencode-ai/*` workspace 依賴）。`@opentui` 三件套**未安裝**，koffi 3.1.6 已在 store 但未被這個方向使用。

### 2.3 ⚠️ 最重要的發現：**三份研究文件全部反對做這件事**

| 文件 | 它是什麼 | 結論 |
|---|---|---|
| `2026-09-09-opencode-tui-graft-feasibility.md` | 移植可行性 | 「**4. 結論：不做全量移植。**」建議**選項 C（選擇性吸收）**；A（全量移植）判「**不可行（除非接受 fork + 第二個 backend）**」 |
| `2026-09-09-tui-beta-runtime-bun-to-node.md` | Bun→Node | 「**選 (c) Bun sidecar 做 spike**」；(a) shim 單獨做「**可行但無用**」；(b) 換渲染器「推估 **8,000–15,000 行**」 |
| `2026-09-09-tui-beta-backend-gap.md` | 後端缺口 | 策略 C；「不是欄位對不上，是**一個投影平面不存在**」 |

而**設計文件與實作計畫走的是 (a)+koffi patch**——與上述三份的建議**相反**。設計文件只在「前置研究」處引用它們，**沒有處理這個分歧**。

**成本估計（各文件原話）**：適配層「約 **6,200–12,600 行**新程式，不含 IH core 的平面補建」；策略 A 合計「約 **4,700–9,600 行**」；缺失平面「**2,000–4,000 行 + IH 側設計工作**」。三份文件都是**唯讀走查**——「**未執行任何程式**…所有『行數估計』都是推論，不是實測」。

**最硬的前提（research 反覆指名）**：權限（permission）與提問（question）平面在 IH wire 上**根本不存在**。IH 只有 in-process 的 `ApprovalRequest → {approved}` 與單題單選 `UserQuestion → Promise<string>`（`packages/interaction/src/index.ts`），而 tui-beta 要 `permission.reply{reply: once|always|reject}` 與多題多選 `string[][]`。feasibility 報告直言：「**權限/提問平面在 IH wire 上不存在…opencode 的 permission/question UI 在 `--attach` 下無事可做。**」且 `always` 這個語意在 IH **今天無法表達**（`packages/tui/src/backend/approval.ts` 的 `DECISION_MAP` 是假造 scope；檔內自註 scope/feedback「**NO seam to carry them today**」）。

### 2.4 本輪新發現的兩個計畫／設計落差（研究文件沒寫）

1. **`effect` 依賴被漏掉**。`tui-beta/src` 有 **6 個檔** `import ... from "effect"`（含 `app.tsx` 的 `Deferred, Effect`——那是啟動路徑第一行），但計畫 T1 要寫的 `package.json` **沒有 `effect`**。照抄會直接解析失敗。
2. **「漸進式 include」與 S1 的刪檔要求衝突**。計畫 T1 的初始 `tsconfig.include` 只有 `src/backend/**` + `bin/**`，但 T3 Step 8 要求 `git rm context/{sdk,sync,data}.tsx` 並清掉引用點——而**未被 include 的檔案仍有 27 個 import `@opencode-ai/sdk/v2`**（另有 20 檔用 `@opencode-ai/plugin/tui`、8 檔用 `@opencode-ai/core`）。這些是**型別**匯入，刪掉上下文檔不會讓它們消失；只要哪天被納入 include 就會紅。計畫沒有交代這一層 shim 從哪來。

### 2.5 最高風險（設計文件 §8 自陳，本輪未驗證）

koffi 執行期語義——「`view` 生命週期、60fps 下的 callback 排隊…**只能靠真跑驗證**」。而這個 patch 的對象是 **1.33 MB 打包檔 + ~347 個 FFI 符號**（`@opentui/core`，內含 Yoga 佈局），**從未被編譯或執行過一次**。設計文件的 S0 驗收條件（「真的跑起來看到畫面」）**仍是完全敞開的門**。

---

## 3. ⚠️ 資料：session store 不見了

M61 交接 §5c/§5f 記載：store 建於 **12:33**、`/api/sessions` 回 **16 / 19 筆真實 session**、並指名 `sess-mtv1y8t1-z3rwz`。

**本輪實測：這棵樹不在磁碟上。**

```
C:\Users\inkik\.i-harness\        → plugins/ · credentials.json · settings.json
                                    （沒有 sessions/）
i-harness sessions list           → "no sessions in this store"
```
- 已搜 `$USERPROFILE`（含 `.dsh`、`.claude`、`.codex`、`.omc` 等），**沒有任何 I-harness session store**，也搜不到被指名的 `sess-mtv1y8t1-z3rwz`。
- `resolveSessionStoreRoot()` 的預設沒有被覆蓋（沒有 `IH_CONFIG_DIR`），所以它**就該在** `~/.i-harness/sessions`。

**影響**：M61 最重要的使用者可見修復（resume / session picker / `i-harness sessions`）**在本機沒有真實資料可以複驗**——那 19 筆對話不見了。成因未定（我沒有動過它；DEK 交接之後到本輪之間發生的事我無法從 repo 得知），**不在本輪修復範圍**，但你應該知道。

**好消息**：`~/.i-harness/settings.json` 完好（theme `grok-night`、`busyEnter: interrupt`、`alwaysApprove: true`、defaultModel = `deepseek1:deepseek-v4-flash-vision-exp`）。下次跑 TUI 會重建 `sessions/`。

---

## 4. 本機環境（決定「哪些東西能驗」）

| 項目 | 狀態 | 影響 |
|---|---|---|
| Node | **v24.15.0** | 沒有 `node:ffi`（研究文件已用二進位字串掃描證實：`node:ffi` 0 次、`getRawPointer` 0 次）→ `@opentui` 的 Node 路徑**必然**退回 unsupported backend |
| pnpm | **12.3.4**（store `D:\.pnpm-store\v11`） | 與 11.7.0 並存；`ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR` 的來源 |
| bash | **在 PATH 上找不到**（裝在 `Git\bin`，PATH 只有 `Git\cmd`） | `packages/shell` 14 條測試紅；bash 工具在真機上不可用（§1b） |
| pwsh | **5.1**（不是 PowerShell 7） | `resolvePwshExe()` 的 fallback 路徑生效；PowerShell 7 不存在 |
| Bun | **未安裝** | research 的建議路線 (c) Bun sidecar **無法在本機 spike**，除非先裝 Bun |
| `@opentui` | **未安裝** | tui-beta 的渲染層完全未取得 |
| grok 源碼 | `D:\grok-build-main`（交接 §6 記載） | TUI parity 對照用 |

---

## 5. 殘留與小帳

### 5.1 三個未追蹤的研究文件（**是這個新方向的全部證據基礎**）
`docs/research/2026-09-09-tui-beta-{backend-gap,code-quality,runtime-bun-to-node}.md`（各 ~30–36 KB）。
它們**不在任何分支**（`git log -- <file>` 為空）；`opencode-tui-graft-feasibility.md` 與 `mimo-code-fork-delta.md` 則已隨 `86d6f343` 進 `tui-beta-1`，**但不在 `main`**。建議：要嘛 commit 進 `main`，要嘛明確丟棄——現在它們是「只存在於一顆工作樹的未追蹤檔案」，`git clean` 會直接吃掉。

### 5.2 `.pnpm-store/` 未追蹤
工作樹裡的 `.pnpm-store/`（v11）沒有被 `.gitignore` 蓋到，所以每次 `git status` 都會出現。要嘛進 ignore，要嘛移走。

### 5.3 分支／worktree 現況
- `main` = `origin/main` = `0d1d63fd`，**無分歧**（本機 `main` 與遠端逐字相同）。
- **`.worktrees/m61`（分支 `m61` @ `463714e5`）＝ §0b 那段 20-commit 的 settings 工作，未推送、未合流**，且**沒有任何遠端 ref 指向它**。
- `tui-beta-1` 疊在 `86d6f343`（M60 尖端）之上，**不含 M61 任一條線**；**且從未推送**（`git branch -r` 無此分支）。若 tui-beta 要出貨，這個 rebase 是隱藏工作項。
- `.worktrees/` 下有 **20 個 worktree**（m48–m61 與 tui-beta-1），全部 `gitignored`；**只有 `m61` 與 `tui-beta-1` 有自己的 node_modules**，其餘沒有（要跑得先 install）。
- 本機另有 tag `verified-m61-d234f21` 與一個 dangling WIP commit（`204309bb`，"On m61: m61-task1-wip"，09-09 20:43）——後者不在 `origin/main`、也不掛在任何被審查過的 settings 提交鏈上；真正被 09-09 22:26 那份交接覆蓋的是 `463714e5`，**不要把 `204309bb` 當成 settings 線的一部分**（它是不是該撿回來的 WIP，需要人判斷）。


### 5.4 已安裝的 app 落後兩個修正
`C:\Program Files\I-harness\dist\ih.mjs` 是 **09-09 23:34:56**，而交接 §5e/§5f 說柵欄修復（`2a36965d`，09-10 16:57）與 case-027 隔離（`351923af`）**在它之後**。→ 跑一次 `build\I-harness-Setup-0.1.0.exe` 才會生效。

### 5.5 交接 §6 未解項（本輪未動）
`~/.i-harness/credentials.json` 的金鑰**建議輪換**（驗收輪曾把內容印進 session log）。

---

## 6. 待你拍板：下一步

以遠端為準之後，**第一順位已經不是 tui-beta，而是 §0 的 settings 整合決定**。

### 決定 A（第一順位）：本機那 20 個 settings commit 要不要救？

| 選擇 | 動作 | 代價 |
|---|---|---|
| **A1 救（rebase）** | 在 `.worktrees/m61` 跑 `git rebase origin/main`，解 `present.ts`/`agent.ts`/`loop.ts` 三個檔的衝突 → 重釘受影響 harness → 跑 `pnpm test` 兩段 | 一段整合工作；但**只有**這 3 個檔真衝突（§0c），且 settings 樹本來就綠（71 檔 / 787 測） |
| **A2 不救** | 以 `0d1d63fd` 為唯一基線往下走；本機 20 個 commit 只留作歷史 | 放棄已完成的 settings 單一捲動面板（grok §4a 那項）與 overlay j/k 修正的本地線 |
| **A3 先擺著** | 兩邊都不動，先做決定 C | settings 面板繼續游離在遠端之外——**這次就是這樣發生的**：另一台機器得重新發現它一次 |

> 我建議 **A1**：它是唯一一段「已完成、已審查、現在還是綠的」未整合工作，衝突面已量測為 3 個檔，而且放著只會愈來愈難合（遠端每多一個 TUI commit 就多一分漂移）。若你其實已經不要 settings 面板了，**A2** 是乾淨的，但請**明示**——否則下一個接手的人會再一次把它挖出來。

### 決定 B：tui-beta 那條線（**遠端沒有，只有這台機器的工作樹**）

⚠️ 這條線的依據檔案（3 份研究 + spec + plan）**本身都沒進版控**（§5.1），所以嚴格說它現在「不算專案狀態，只算一顆工作樹的草稿」。

- **B1（建議）**：降級成 **S0 spike** —— 只驗「koffi patch 能不能在 Node 上渲染出一幀」。成功才談後續；失敗就回到研究文件一致建議的「選擇性吸收」，損失只有那個 patch。**不需**先補 permission/question 平面（那是 S1 之後的事）。
- **B2**：先做**決定 C**，tui-beta 整條擱置 —— 研究文件自己也說「先讓它跑起來、用真資料判斷這個 UX 值不值得」。而且本機**連 Bun 都沒裝**，研究建議的 sidecar 路線此刻也無法驗。
- **B3**：照現行計畫直接開 T1→T6。**我不建議在未先補前置的情況下走這條**（§2.3/§2.4：`effect` 依賴漏列、`@opencode-ai/*` 型別 shim 無著落、permission/question 平面不存在、koffi patch 從未編譯過）。

### 決定 C（與 A/B 都不衝突，且是遠端 M61 自己列的第一順位）：web 的 prompt UI（L3）

讓 `/` 從唯讀檢視器變成能對話。接點明確（`packages/web-host/src/host.ts:576` 的 mux `command` endpoint），**柵欄已在位（§5e）**，不需第二個 runtime、不需 FFI、不動 TUI。這是「今天就能有使用者可見成果」的那條。

### 決定 D：修「Windows 一等」的既有缺口（小而實，可隨時夾帶）

- `bashAvailable()` 探 Git 已知安裝路徑 → 標準 Windows+Git 機器上 bash 工具真的能用（並解掉 14 條測試對 PATH 的隱性依賴）。
- TUI 凍結區的**模型請求無逾時**。
- `pnpm test` 閘門誠實性（§1c）。

### 另外三個小決定

- **三個未追蹤研究文件**要 commit 進 `main` 還是丟棄？（§5.1）—— 你上一輪選了「先都不要動」，所以它們現在還在原處。
- **credentials 金鑰輪換**要不要現在做？（§5.5）
- **dangling WIP `204309bb`**（09-09 20:43，"m61-task1-wip"）要不要看一眼再讓它被 gc？（§5.3）

---

## 附錄：本輪執行過的命令（可複驗）

```powershell
# 環境
node -v ; pnpm -v ; pnpm store path

# 修復（唯一改動狀態的動作）
pnpm install
pnpm -r typecheck                                   # → exit 0

# 基線
pnpm test                                           # → exit 0 · 70 專案 · 322 檔 / 3,272 測試
pnpm --filter @i-harness/tui test                   # → 70 檔 / 772
pnpm --filter @i-harness/web-host test              # → 16 檔 / 163
pnpm --filter @i-harness/tui-app test               # → 1 檔 / 31
pnpm --filter @i-harness/cli test                   # → 9 檔 / 114 + 1 skip

# §1b 的判別性實驗：同一包，只改 PATH
pnpm --filter @i-harness/shell test                                    # → 14 failed / 33
$env:PATH = "C:\Program Files\Git\bin;" + $env:PATH
pnpm --filter @i-harness/shell test                                    # → 33 passed

# §1c 的判別性實驗：pnpm 是否真的會因一個失敗而少跑後續專案
# （在 .tmp-nobail-probe 臨時 workspace 內；已刪除）
pnpm -r --no-bail test                              # → b-fail 失敗，但 c-after 仍執行
pnpm -r test                                        # → 同樣
# 註：探針證明「--no-bail 確實會續跑」；因此 §1c 的 14 專案缺口不能歸因於它，
#     嫌疑落在「並行 + 負載」或「輸出管線」，本輪未能定論（誠實標註）。

# 產品冒煙
node --import tsx apps/cli/src/index.ts --version   # → 0.1.0
node --import tsx apps/cli/src/index.ts sessions list  # → no sessions in this store
```
