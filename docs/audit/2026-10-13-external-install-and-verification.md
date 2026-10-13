# 外部安裝與實測報告（v0.1.11 原始碼快照）

> **這份報告是什麼**：一次**獨立的外部驗證**——從零安裝依賴、跑閘門、跑全量測試，並把每一個紅色套件追到根因。
> 不是審計鏈的一部分，不是里程碑交付；沒有動過任何生產程式碼（唯一一次臨時修改已還原，hash 附於文末）。
>
> **本報告有三類結論，請分開對待**：
> **§5 是缺陷報告**（已證實、有紅燈、可直接修）；
> **§12.1 是已定調的施工題**（業主決定接線 `fs-watch`；唯一衝突已定位、修法已實測驗證）；
> **§12.2–12.4 是設計確認**（機制已查明，需你們拍板，不是 bug）。
> 其餘各節是環境診斷與附錄。若只想看要動手的，讀 §7（清單）→ §5（唯一的 bug）→ §12.1（接線施工）。
>
> **執行者**：外部 agent（非本專案開發者），在 Windows 11 (build 26200) / Git Bash 環境。
> **標的**：`I-harness-0.1.11` 原始碼快照（**目錄內無 `.git`**，故無法使用 `git ls-files`、無法比對 baseline commit；見 §8）。
> **日期**：2026-10-13。
>
> **方法原則**：每一條斷言都附出處。**跑過的**與**讀出來的**分開標記：`[實測]` = 本機真的執行且看到輸出；`[讀碼]` = 靜態閱讀判斷，未執行；`[未驗證]` = 沒做或做不到。
> 對本報告的閱讀提醒沿用你們自己的紀律：**綠燈不代表問對了問題**；本報告的紅燈也同理——§3 有五個紅，其中只有一個是產品缺陷。

---

## 1. 環境與安裝 `[實測]`

| 項目 | 值 |
|---|---|
| 平台 | Windows 11 build 26200, x86_64, Git Bash (MSYS 3.6.10) |
| Node | **v22.23.2**（`engines` 要求 ≥22.18 ✓） |
| pnpm | **10.34.5**（要求 ≥10 ✓） |
| 網路 | registry.npmjs.org，`npm ping` PONG 4813ms |
| 安裝指令 | `pnpm install --frozen-lockfile` |
| 結果 | **EXIT=0，4 分 31.1 秒**；`resolved 452, reused 184, downloaded 267, added 452` |
| 遇到的插曲 | 一次 `WARN GET @esbuild/win32-x64 ECONNRESET`，pnpm 自動重試後成功 |

**原生模組逐一煙霧測試**（因為 `pnpm-workspace.yaml` 用的是 `allowBuilds` 而非 pnpm 官方鍵名 `onlyBuiltDependencies`，這點值得確認）：

```
pnpm config get onlyBuiltDependencies
  → esbuild,koffi,node-pty,ffmpeg-static     ← allowBuilds 被正確接受並展開
```

| 模組 | 結果 |
|---|---|
| `node-pty@1.1.0` | ✅ 真的開了 ConPTY 並執行 `cmd.exe /c echo PTY_OK`，收到實際輸出；另自帶 `prebuilds/win32-x64/{pty,conpty}.node`，無需本機編譯 |
| `koffi@3.1.6` | ✅ 載入 `kernel32.dll`，`GetCurrentProcessId()` 回傳真實 PID（實測 pid=15212） |

> **結論**：安裝面無問題。`allowBuilds` 這個非官方鍵名在 pnpm 10.34.5 下**確實生效**（推測是舊鍵名的兼容讀取）——但這是**未文件化的依賴**，pnpm 未來版本移除兼容時會靜默停止建置原生模組。建議改用官方 `onlyBuiltDependencies`。

---

## 2. 閘門結果總表 `[實測]`

| 閘門 | 指令 | 結果 |
|---|---|---|
| Typecheck | `pnpm -r typecheck` | ✅ **81/81 套件通過，0 個 TS 錯誤**（`Scope: 81 of 82 workspace projects`） |
| Reachability | `node scripts/audit/check-reachability.mjs --gate` | ✅ **PASS**——`gate PASS -- no new rows`，exit 0 |
| 全量測試 | `pnpm -r --no-bail --no-sort --stream --workspace-concurrency=1 test --maxWorkers=2 --minWorkers=1` | ⚠️ **76 套件通過 / 5 套件失敗** |

**測試數字**（`[實測]`，逐套件 vitest 摘要加總）：

```
通過 4524 / 失敗 35 / 略過 4     （套件層級：76 pass, 5 fail, 共 81 有 test script）
```

**值得記一筆的正面觀察**：reachability 閘門不只是「沒爆」——它**正確地把 42 條已修好的列報為 `gone`**（`gone unused-export @i-harness/sdk#HarnessClient` 等）。
這代表 baseline 不是靠「全部列進去」來通過的，那些列確實已經被接線了。`seededAt 2026-09-24, count 456`。

---

## 3. 五個失敗套件 `[實測]`

| 套件 | 失敗/總數 | 歸屬 |
|---|---|---|
| `packages/desktop` | 17 / 1336 | **本報告的安裝疏漏**（非缺陷） |
| `packages/desktop-gateway` | 1 / 466 | **環境限制**（缺 Windows 權限） |
| `packages/exec` | 11 / 209 | **測試守衛過期**（非產品缺陷） |
| `packages/terminal` | 1 / 57 | 🔴 **真產品缺陷** |
| `packages/sandbox-windows-psec` | 5 / 59 | **已公開標示的實驗性套件** |

---

## 4. 非缺陷的三個（§3 前三列）

### 4.1 `packages/desktop` — 17 失敗：漏跑前置建置步驟，**是我的錯**

根因（單一，非 17 個）：

```
Error: ENOENT ... packages\desktop\out\main\attachment-reader-worker.mjs
  ❯ test/attachment-reader-portable.test.ts:15
Error: Attachment reader failed: Cannot find module '...out\main\attachment-reader-worker.mjs'
  ❯ src/main/attachment-readers.ts:24
```

`scripts/verify-all.mjs` 的**第一步**就是 `node scripts/build-attachment-reader.mjs`，我直接跑 `pnpm -r test` 而跳過了它。

**已驗證的修復** `[實測]`：補跑該步驟後，三個受影響檔案全綠——

```
Test Files  3 passed (3)
Tests  35 passed (35)
```

> **給開發 agent 的建議**：`packages/desktop` 的測試對 `out/main/attachment-reader-worker.mjs` 有**硬前置依賴**，但沒有自我防護。
> 一個直接跳過 `verify:all` 而跑 `pnpm --filter @i-harness/desktop test` 的人（或 CI job）會拿到 17 個假紅燈。
> 建議在 `attachment-readers.ts` 的 worker 載入失敗路徑上加一句明確的修復指引（`run: node scripts/build-attachment-reader.mjs`），
> 或讓 desktop 的 test script 自動前置建置。這正是你們自己記錄過的那類缺陷：「**命令是問題，不是程式碼**」（`scripts/verify-all.mjs:5-20` 的立項理由）。

### 4.2 `packages/desktop-gateway` — 1 失敗：Windows 缺 symlink 權限

```
Error: EPERM: operation not permitted, symlink
  'C:\Users\...\Temp\ih-content-reader-LG4xC5\secret.txt'
  -> 'C:\Users\...\Temp\ih-content-reader-rpGPdC\link.txt'
  ❯ test/project-content-reader.test.ts:26
```

**獨立驗證** `[實測]`：本機直接建 symlink 失敗（`EPERM`）；且

```
HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock\AllowDevelopmentWithoutDevLicense → (不存在)
IsInRole(Administrator) → False
```

即：**開發者模式未開啟且未提權**。Windows 需要 `SeCreateSymbolicLinkPrivilege` 才能建 symlink。

> **建議**：該測試意圖是「外部 leaf alias 唯讀可讀、replace-after-check 競態被拒」，是有價值的安全斷言，不該被環境噪音蓋掉。
> 建議加環境探測（試建一次 symlink 於 beforeAll，失敗則 `describe.skip` 並印出可操作的訊息），
> 而不是讓它變成一個「在沒開開發者模式的機器上必紅」的測試。目前它會污染每一個 Windows CI 紅燈清單。

### 4.3 `packages/exec` — 11 失敗：**硬編碼的 Git Bash binary hash 過期**

全部 11 個失敗都在同一檔案 `test/msys-pty-resolution.test.ts`（`pre-admission MSYS PTY identity` 整組）。

根因在 `packages/exec/src/windows-msys-pty.ts:9`——**以 binary 位元組辨識 audited Git Bash shim**：

```ts
const gitBashShimSha256 = "9aa00217a92def5fed1b15c6e2b34a7f89e3781af822ecc00960fe5340df093e"
```

本機實測 `[實測]`：

| | sha256 |
|---|---|
| `C:\Program Files\Git\bin\bash.exe` | `0010d7d71a94b0441028eea42381589483836d2c097f24940d282f5c4eba7919` |
| 程式碼期望值 | `9aa00217a92def5fed1b15c6e2b34a7f89e3781af822ecc00960fe5340df093e` |

本機 Git 版本：**`git version 2.55.0.windows.5`**、`GNU bash 5.3.15(2)-release (x86_64-pc-cygwin)`。
測試的守衛是 `it.skipIf(process.platform !== "win32" || !existsSync(installedShim))`——**只檢查平台與檔案存在，不檢查 hash**，所以照跑照紅。

**產品行為的實際影響**（我用直接探測確認 `[實測]`）——未辨識時 spec 原樣返回：

```
argv 改寫:     否（未辨識 shim，保持原路徑）
env 正規化:    無（wrapperEnvironment 未套用）
msysPty 釘選:  無
```

這**正是程式碼註解寫的刻意 fallback**（`windows-msys-pty.ts:7-8`：「other versions retain their native path」）。
而 `packages/shell/src/index.ts:153-155` 的 `resolveBashExe` **第一候選就是這個 shim**，shim 自己會處理 `-c`，
所以一般 `bash` 工具執行**不受影響**（本報告全程用 Git Bash 執行，一切正常）。

> **歸屬判定**：**非產品缺陷**。是「binary 白名單 + 無版本守衛」的測試設計在 Git 升版後失效。
>
> **建議**（依你們自己的「命令/守衛必須會問對問題」紀律）：
> 1. 測試的 skip 條件應改為**基於實際 hash 是否命中**，而非僅檔案存在——這樣失敗訊息就是「本機 Git 版本未經審計」而不是一坨 assertion diff。
> 2. shim 白名單宜改為**可更新的資料**（例如 `manifest.json` 內的 hash 清單 + 已知版本對照），而非散在 `.ts` 的常數。
> 3. 值得考慮：白名單 miss 時是否應 **loud 一次**（現在是完全靜默 fallback）。靜默讓「未審計的 launcher」與「無需審計的 launcher」不可區分。

---

## 5. 🔴 唯一的真缺陷：`terminal` resize 後第一次寫入遺失首位元組

> **⚠️ 本節已於 2026-10-13 更正（第二版）。** 第一版的根因判定**是錯的**：它說這是「IH 的 `resize()` promise 在任何確認之前就 resolve」的時間競態，並據此建議「確認 resize 已套用後才放行寫入」。
> **那個建議不足以修好問題。** 後續以**完全不含 IH 程式碼的原始 node-pty** 做對照實驗後發現：**等待完全無效**（500ms 與 20ms 與 setImmediate 的結果幾乎相同），所以它不是時間有界的競態，而是 **node-pty 的 Windows ConPTY `resize()` 路徑本身的缺陷**。
> 原文保留在下方 §5.2 的歷史註記中；**§5.2′ 是現在的正確判讀**。

### 5.1 現象 `[實測]`

`packages/terminal/test/resize-input.test.ts` 單一測試失敗。**不是偶發 flake——我獨立重跑 13 次：10 失敗 / 3 通過（約 77% 失敗率）**。

失敗軌跡（節錄實際 PTY 位元組）：

```
前 5 次 resize 全部成功（143x37, 91x22, 145x39, 93x24, 120x30）
第 6 次 resize 後：
  IH_PTY_READY> \e[1Ccho "IH_RESIZE_6_"OK; tput cols; tput lines\e[?2004l
  bash: cho: command not found
  160
  40
```

**`echo` 的第一個字元 `e` 被丟掉**。`bash: cho: command not found` 證明是**真的丟失**，不是顯示問題。
`\e[1C`（cursor forward 1）顯示終端已套用新寬度，但該次寫入的首位元組沒進去。

### 5.2′ 正確判讀：**node-pty 的 ConPTY `resize()` 缺陷，不是時間競態** `[實測]`

我用**完全不含 IH 程式碼**的原始 node-pty 做對照實驗。偵測方式刻意改用**檔案副作用**（命令寫入一個檔案後檢查內容），而不是讀終端緩衝——因為終端回顯與重繪會污染判讀（我第一版就是被這個誤導的）。

| 模式 | resize 後**第一次**寫入 | **第二次**寫入（中間不 resize） |
|---|---|---|
| **no-resize（對照組）** | **24/24 (100%)** | 24/24 (100%) |
| resize，立即寫 | 14/24 (58%) | **24/24 (100%)** |
| resize，等 `setImmediate` | ~75% | 100% |
| resize，等 20ms | ~75% | 100% |
| resize，等 **500ms** | **79%** | 100% |
| resize，等觀測到重繪 | 19/24 (79%) | 100% |

**三個結論**：

1. **位元組遺失確實由 resize 造成** —— 對照組 100%，一 resize 就掉到 58%。
2. **等待完全無效** —— 500ms ≈ 20ms ≈ setImmediate ≈ 79–83%。所以**不是**「IH 的 promise 太早 resolve」這種時間有界的競態。**任何以 sleep 為形的修法都不可能到 100%。**
3. **遺失侷限於「resize 後第一次寫入」的首位元組**；**第二次寫入永遠 100% 完好**（四種模式皆是）。
4. 它**在原始 node-pty 上就重現**（路徑上沒有任何 IH 程式碼）⇒ 缺陷在 **node-pty 的 Windows ConPTY `resize()` 路徑**，不在 IH 的邏輯。

**所以正確的處置不是「修 IH 的 await」，而是**：
- 先找**呼叫端**的可行解法（例如 resize 兩次、先 resize 到別的尺寸再回目標、或延後 resize 直到輸出靜默）；
- 若找不到能到 100% 的解法，就**誠實記錄這是一項第三方限制**（依你們對 PSEC 的同一套公約：寫明量測到什麼、在什麼上、以及**不保證**什麼），並讓測試斷言 **IH 實際能保證的東西**（resize 有送達、尺寸真的套用、非緊接 resize 的寫入永不遺失），而不是留一盞永遠紅的燈。

> `packages/sandbox-local/src/posix-execution.ts:165` 的那行 `resize` 仍然值得加註解說明它不與後續 write 排序——但**那是記錄，不是修復**。

### 5.2（第一版判定，保留為更正記錄）`[讀碼]`

`packages/sandbox-local/src/posix-execution.ts:165`：

```ts
...(this.terminal ? { resize: async (cols: number, rows: number) => { this.terminal!.resize(cols, rows) } } : {}),
```

`async` 但**內部不 await 任何東西**。而 node-pty 的簽章是同步的：

```
node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/typings/node-pty.d.ts:162
  resize(columns: number, rows: number): void;
```

因此 **IH 的 `resize()` promise 在任何確認之前就 resolve**，緊接的 `write` 與 ConPTY 實際套用尺寸形成競態。

**對照組證明這不是 node-pty 的必然行為**：PSEC backend 對 resize 做了原生往返確認——

```ts
// packages/sandbox-windows-psec/src/index.ts:404-406
...(spec.transport === "pty" ? { resize: async (cols, rows) => {
  await this.expect("resize", { cols, rows }, "ack")
} } : {}),
```

但 PSEC **明確拒絕 PTY**（`pty:false`，見其 README）。**所以預設的 Windows 路徑（`windowsSelection` 預設 `"legacy"`，`packages/sandbox-local/src/execution-backends.ts:33`）就帶著這個未等待的 resize。**

### 5.3 修正實驗：**加延遲不是答案** `[實測]`

我對 `posix-execution.ts:165` 做了兩次臨時修改並各跑多次（意圖是給出可執行的建議，不是猜測）：

| 變體 | 樣本 | 通過 | 備註 |
|---|---|---|---|
| **原始**（無 settle） | 13 | 3 | 約 77% 失敗 |
| `await new Promise(r => setImmediate(r))` | 8 | **0** | 讓出一個 macrotask **無效** |
| `await new Promise(r => setTimeout(r, 20))` | 6 | 2 | 略優於原始，**仍不穩** |

**兩個結論**：
1. **負面結果有價值**：競態窗口比一個 event-loop tick 長，不是「少一次 await」的問題。
2. **固定延遲是掩蓋不是修復**——20ms 仍 4/6 失敗。任何以 sleep 為形的「修法」都不可接受。

`[未驗證]`：我**沒有**證明正確的修法是什麼。以 13/8/6 這種樣本量，三個變體之間的差異**不足以做統計排序**（原始 1/13 vs setImmediate 0/8 在統計上不可區分）。請不要把上表讀成「setImmediate 更差」。

### 5.4 建議的修法方向（已依 §5.2′ 更正）`[讀碼 + 部分實測]`

> **⚠️ 本節原始版本的選項 1（「確認 resize 已套用後才放行寫入」）已被 §5.2′ 的實驗否證** —— 等重繪只有 79%，等 500ms 也只有 79%。以下為更正後的版本。

正確方向分兩層，**先找呼叫端解法，找不到就誠實記錄**：

1. **（先試）呼叫端是否有任何手法能讓「resize 後第一次寫入」不再遺失。** 這是唯一可能真正修好的路徑，且**必須用 §5.2′ 的同一套檔案副作用儀器、≥24 樣本、且對照組 100%** 來判定，不能用「跑一次過了」當證據。候選：resize 連續兩次同尺寸；先 resize 到別的尺寸再回目標；延後 resize 直到輸出靜默後再送。
   `[未驗證]` 我沒有測這些候選，所以不宣稱任一個可行。
2. **（若 1 失敗）誠實記錄為第三方限制。** 依你們對 PSEC 的同一套公約：寫明量測到什麼、在什麼硬體/版本上、以及**不保證**什麼。具體是：
   - 在 `packages/sandbox-local/src/posix-execution.ts:165` 的 `resize` 註解記錄：ConPTY 路徑上 resize 可能吃掉緊接寫入的前導位元組；該窗口**不是時間有界的**；後續寫入不受影響。
   - 在 `packages/sandbox-local` README 記錄此限制（比照 PSEC 的寫法）。
   - 把 `packages/terminal/test/resize-input.test.ts` 拆成兩部分：**(i)** 確定性的回歸測試，斷言 IH **確實能保證**的事——resize 有送達、新尺寸真的套用（`tput cols/lines` 相符）、**非緊接 resize 的寫入永不遺失**；**(ii)** 明確標名並記錄該第三方限制（含量測到的比率）。**不要**靜默刪掉原本的斷言。

> **不要做的事**：用固定 sleep 假裝修好。§5.2′ 已證明 500ms 仍掉 21%，任何 sleep 形式的「修復」都是把紅燈變成隨機綠燈。
2. **讓 resize 與 write 共享同一個序列化佇列**（現在兩者都各自 fire-and-forget 進 node-pty），
   至少保證 IH 內部不會在 resize 尚未送出時就排入 write。這可能不足以解決 ConPTY 端的非同步套用，但能消掉 IH 這一側的不確定性。
3. **在 Windows ConPTY 上明確標記此限制**：若確認是 ConPTY 的固有行為，則依你們的誠實公約，應在
   `sandbox-local` README 記錄「concurrent resize + immediate write 在 ConPTY 上可能丟失首位元組」，
   並在 `terminal.resize()` 的 contract 上說明它不保證與後續 `send()` 的相對順序。

**紅燈已存在**：`packages/terminal/test/resize-input.test.ts` 本身就是現成的失敗測試（且它**已經正確地** await 了 resize 才 send，所以問題在 IH 的 await 邊界以下——測試是對的，產品是錯的）。可以直接拿它做 red-first。

**使用者影響**：Desktop 中若在拖曳調整終端面板尺寸後**立即**輸入指令，第一個字元可能遺失。
對一個「互動式終端」功能而言這屬於資料完整性問題，不只是美觀。

---

## 6. 第五個：`packages/sandbox-windows-psec`（5 失敗）——已標示的實驗性

2 個檔案失敗：`test/msys-pty.test.ts`（3）、`test/real-driver.test.ts`（2）。

* `msys-pty.test.ts`：與 §5 同類的位元組傳輸問題（`expected '...' to contain '__REAL_WINCH__\r\n'`、argv 不相等、drain 位元組數 2348783 ≠ 2097163）。
* `real-driver.test.ts`：原生 `CreateProcessSecurityEnvironment` 回 **`0x8007000F`（ERROR_INVALID_DRIVE）**，而測試期望錯誤碼 **203**。

**這些都在你們自己的 README 裡公開標示過**（`packages/sandbox-windows-psec/README.md`）：套件描述即 `Experimental direct Windows PSEC and explicit unrestricted native execution owner`；
明文寫「PSEC remains **experimental**」、「PSEC currently supports **pipes only**」、`pty:false`、
出貨 qualification 記錄標記 **`incomplete`**，甚至自己記錄了「**Git/MSYS Bash failed under PSEC during MSYS initialization**（`NtCreateDirectoryObject(\BaseNamedObjects\msys-...): 0xC0000022`）」。

**我要特別肯定這段文件**：`readWindowsQualification` 的說明誠實到指出「a match does not establish machine identity…」、
「The accessor is informational and never changes the backend probe」、以及「Fixtures are retained for review」。這是本報告看過最好的誠實度範例之一。

> **唯一的建議**：`pnpm -r test` 會跑這些測試並**必然失敗**（在未達 qualification 的機器上）。
> 既然資格狀態是已知且可查的（`qualification.json` + `applicability`），建議讓這些測試依 `applicability` 決定 run/skip，
> 使 `pnpm -r test` 的紅燈清單**只反映真正的回歸**。否則每個人都得學會「這 5 個紅是正常的」——那是一種會傳染的盲視。

---

## 7. 建議清單（依優先序）

**清單分兩組，性質不同**：**A 組是修缺陷/守衛**（有紅燈或明確錯誤，可直接動手）；
**B 組是設計決策**（機制已查明，需你們拍板，詳見 §12）。請不要把它們排在同一條工作流上。

### A 組：修缺陷與測試守衛

| # | 優先 | 項目 | 類型 | 出處 |
|---|---|---|---|---|
| 1 | 🔴 **高** | 修 `posix-execution.ts:165` 的 resize/write 競態（真缺陷，77% 重現，已有紅燈） | 產品缺陷 | §5 |
| 2 | 🟠 中 | `packages/exec` 的 Git Bash shim 白名單改為資料驅動 + 以 hash 命中決定 skip，並考慮 miss 時 loud | 測試守衛 | §4.3 |
| 3 | 🟠 中 | desktop 的 attachment-reader worker 缺前置建置 → 加可操作的錯誤訊息或自動前置 | 開發者體驗 | §4.1 |
| 4 | 🟠 中 | gateway 的 symlink 測試加環境探測後 skip | 測試守衛 | §4.2 |
| 5 | 🟠 中 | PSEC 測試依 `applicability` 決定 run/skip，讓 `pnpm -r test` 可信 | 測試守衛 | §6 |
| 6 | 🟡 低 | `pnpm-workspace.yaml` 的 `allowBuilds` 改用官方 `onlyBuiltDependencies` | 依賴穩健性 | §1 |
| 7 | 🟡 低 | 修 `docs/CAPABILITIES.md:3` 的包數（66 → 80）與 `packages/desktop/README.md` 的版本（0.1.4 → 0.1.11） | 文件漂移 | §9 |
| 8 | 🟡 低 | 見 §9 的四個 `[讀碼]` 靜態發現（`modelPolicies` 未接線、hooks 信任綁定、AGENTS.md 快取、`fs-watch`） | 待確認 | §9 |

### B 組：事件驅動面的設計決策（詳見 §12）

| # | 優先 | 項目 | 類型 | 出處 |
|---|---|---|---|---|
| 9 | 🔴 **高** | `fs-watch` **接線**（業主已定調：會用）：唯一實質衝突 = `DEFAULT_IGNORE` 排除 `.i-harness`，而 2/3 設定層住在那裡。**修法已實測驗證**（明確 root 豁免、子項照舊忽略） | 產品功能 | §12.1 |
| 10 | 🟠 中 | 「喚醒模型」收斂成一份權威文件（現散在三處，其中兩處是不受閘門保護的註解） | 文件／單一真相 | §12.2 |
| 11 | 🟠 中 | `pump()` 失敗後收件箱停滯：確認是否刻意，並讓停滯可見 + 補測試釘住 | 設計確認 | §12.3 |
| 12 | 🟡 低 | `ParentInputAdmission.wake` 是 no-op，在成員 JSDoc 寫明 | 術語對齊 | §12.4 |

**關於 #1 的流程建議**：這是唯一一個會影響使用者的項目，且**紅燈已經存在**。
依你們自己的 TDD 紀律，正確順序是：用它當 red → 找真正的順序/確認機制 →
驗證 flake 率歸零（不是「跑一次過」）→ 才關閉。

> **關於 #9 的流程建議**：這是 B 組裡最該先做的——業主已定調「會接線」（事件驅動是既定目標），
> 衝突已定位、修法已實測驗證，施工細節與轉接層檢查表見 §12.1。**這不是決策題，是施工題。**

---

## 8. 未驗證範圍（誠實聲明）

**我沒做的事**——請不要把我的綠燈讀成覆蓋了這些：

| 未執行 | 說明 |
|---|---|
| `pnpm e2e` | 6 個 e2e 檔（apply-patch / sandbox / skills / team / verify-all / workflow）完全沒跑 |
| `pnpm verify:bench` | 未跑，未驗 baseline 指紋 |
| `pnpm verify:dist`、`verify-installer` | 未跑 |
| installer 生命週期／destination／safety 測試 | 未跑（`*.mjs` 腳本） |
| Desktop `dist` 打包、NSIS `installer` | 未跑（需 NSIS 3） |
| `scripts/qualification/*` | 未跑 |
| git 相關驗證 | **目錄無 `.git`** → 無法 `git ls-files` 驗證文件的「已移除」指針，無法比對 baseline |
| 真實模型呼叫 | 全程未觸網任何 LLM；provider 面僅靜態閱讀 |
| PSEC 兩個原生失敗的確切成因 | 未追（是驅動器佈局／缺 LOCALAPPDATA／helper 對 OS build 不匹配？） |
| flake 率精確值 | 13/8/6 次取樣，僅為量級參考，非統計量測 |

**方法註記**：本報告的靜態分析部分有部分由**委派的分析子代理**產出（desktop/gateway、engine、safety、context/extensions、build/docs 五個面向），
我對其中**最高價值的宣稱做了獨立複核**（§9）。凡我未親自複核而來自委派的項目，一律標 `[讀碼]` 或 `[未驗證]`。

---

## 9. 附錄 A：靜態發現（`[讀碼]`，未以執行驗證）

以下四項是我**親自讀碼複核**的，但我**沒有**用執行證明其後果。列出來供你們判斷：

### A.1 疑似死碼：`modelPolicies`（per-model 壓縮策略）

`docs/CAPABILITIES.md` §二 宣稱有 `modelPolicies`（`thresholdRatio`/`retainTokens`/`maxTokens`/`summarizationModel`/`auto`）。
機制**確實存在**：

```ts
// packages/compaction/src/config.ts:176-190  resolveCompactSpec(config, provider, modelId)
//   → 依 `${provider}/${modelId}` 取 policy 覆蓋
// packages/compaction/src/index.ts:70-71, 113  createCompactionEngine 接受 provider/modelId
```

但**唯一的生產呼叫點從不傳它們**：

```
grep -rn "createCompactionEngine" packages apps --include='*.ts' | grep -v /test/
  packages/compaction/src/index.ts:66          ← 定義
  packages/core-agent/src/index.ts:222         ← 唯一生產呼叫點
```

而 `packages/core-agent/src/index.ts` 的 `createAgent` deps 型別**沒有 provider/modelId 欄位**（`grep -n "modelId\|provider" packages/core-agent/src/index.ts` 在該區段無命中）。
→ 只有 `packages/compaction/test/policies.test.ts` 手工餵參數時才生效。

**若成立**：這是「已實作但未接線」，且 reachability 閘門**結構上看不到**——它掃的是呼叫圖邊，不是參數流。
**待確認**：也許有我看漏的呼叫路徑；請你們確認。

### A.2 疑似信任綁定缺口：hook handler

信任是「檔案 sha256 + 使用者核准」，`serializeHookConfig`（`packages/hooks/src/index.ts:264-286`）要求 `trust.script` 與 `trust.sha256` 皆非空，
但**不檢查 `trust.script` 是否對應 `command.cmd`/`command.args`**。而執行時：

```ts
// packages/hooks/src/runner.ts:123
let executable = spec.command.cmd
// validate 回呼（:140-142）只重驗 handlerFile 的 sha256
```

→ 宣告可以重用一個**已核准的無害檔案**作為 `trust.script`，卻在 `command.cmd` 執行另一條命令。

**注意這是靜態識別，我沒有做滲透測試。** 另注意 `hooks/src/windows-process.ts:48-82` 明示 Windows hooks 刻意使用無限制執行。
**待確認**：是否有我看到的上游驗證（例如設定載入期的一致性檢查）。

### A.3 註解與實作不符：AGENTS.md 快取

`packages/instructions/src/index.ts:17-22` 註解聲稱「re-reads only when mtime/size changed（one stat per file per step boundary）」。
但 `readChanged()` **每次都呼叫 `loadInstructionFiles(config.workspace)`**，而後者（`packages/instructions/src/files.ts:51-57`）
**對每個檔案 `readFileSync`**。mtime/size 只用來決定「是否更新快取物件」，不是「是否重讀」。

→ 每個 step 邊界重讀所有 AGENTS.md/CLAUDE.md 全文。在大型 monorepo 的長會話中是每步的固定成本。
**待確認**：也許 `loadInstructionFiles` 內部另有快取（我讀到的版本沒有）。

### A.4 未接線的套件：`@i-harness/fs-watch`

> **已於 2026-10-13 二次嚴格核查，並升級為 §12.1 的衝突分析**（含 API、測試狀態、文件矛盾、依賴歸屬、
> **已實測證實的唯一衝突**、以及**已驗證有效的修法**）。決策與施工見 §12.1。
>
> **業主立場**：`fs-watch` 會接線（事件驅動是既定目標）；有衝突就調整設計 → 已找到衝突並驗證修法。

chokidar 驅動的檔案事件流，**零生產引用**（已排除 import／package.json 宣告／字串式載入／scripts／e2e 全部機制；
唯一 grep 命中是 reachability baseline 自己，那是「它沒被用」的紀錄而非使用）：

```
packages/fs-watch/src/index.ts   198 行、5 個匯出、唯一相依 chokidar ^5.0.0
grep '"chokidar"' --include=package.json → 只有 fs-watch 宣告
→ chokidar 進樹的唯一原因就是它
```

其 5 個 export 全被 reachability baseline 列為 `unused-export`（`seededAt 2026-09-24`）。
**它的 5 個測試全部通過**（`Tests 5 passed (5)`）——所以是「能跑但沒人用」，不是壞掉。

與此對應，`@i-harness/settings` 的熱更其實是 **500ms 輪詢**（`packages/settings/src/index.ts:1591`），
且其註解理由「**no new deps — no chokidar**」的前提**已不成立**（chokidar 早在樹內）。
而這個套件的建置目的自述是「dsh settings-file selection」——**它原本就是為了設定熱更而建的**。

**文件已自相矛盾**：`docs/CAPABILITIES.md:78` 以現在式把它列為能力；
但 `docs/CAPABILITIES-DETAIL.md:490` 已明文寫「**熱更 = 輪詢非 fs-watch**」。概覽是錯的那一邊。

### A.5 完成的子代理會顯示錯誤的模型（「繼承主會話模型」）

> **這是我在實作期間由使用者回報、並在磁碟上的真實 session 記錄中查證的**（2026-10-13）。**角色模型本身是正確運作的**；錯的是**顯示**。

**先證明功能正常 `[實測]`** —— 從實際 session log 取出子代理真正跑在哪個模型：

| 子代理 | 角色 | 設定值 | 實際使用 |
|---|---|---|---|
| `proxy-smoke` | explore | `deepseek/deepseek-flash` | ✅ `deepseek / deepseek-flash` |
| `worker-smoke` | worker | `codex-…/gpt-6.1-sol` | ✅ `codex-… / gpt-6.1-sol` |
| `w4-exec` | worker | 同上 | ✅ 同上 |

`proxy-smoke` 執行於 **14:11**，設定的 `agents.roles` 寫入於 **12:40** → **設定確實被讀取並套用**。而 09:2x 執行的 research 子代理**早於**設定寫入，當時顯示「繼承」是正確的。

**真正的缺陷 `[實測]`**：

| 事實 | 出處 |
|---|---|
| 持久化 agent table **只有 7 筆**（全是仍在活動的任務），且**全部都有正確 `modelLabel`** | 直接讀 `session-dir/<ws>/desktop-draft-*.doc.jsonl` 的 `agentTable` |
| **已完成的子代理全部不在表內**（`proxy-smoke`、`worker-smoke`、`safety-analysis`…） | 同上；任務記錄 `task-*.doc.jsonl` 有 33 筆任務，但**沒有 `modelLabel` 欄位** |
| 顯示的三段 fallback | `packages/subagent/src/projection.ts:172-178` |

```ts
...(entry?.modelLabel !== undefined
  ? { model: entry.modelLabel }            // ① 有記錄 → 事實
  : role?.model !== undefined
    ? { model: modelLabelOf(role.model) }  // ② 角色物件自帶 model
    : { model: "inherited from the session" }), // ③ 都沒有 → 斷言「繼承」
```

**第 ② 段對內建角色永遠不觸發** —— `packages/subagent/src/roles.ts:45-46` 明寫內建角色**不帶 model**；使用者在設定裡編輯的是 `agents.roles.<name>`，**不是角色物件本身**。所以內建角色永遠落到第 ③ 段。

→ **一個已完成的內建角色子代理，無論它實際跑了什麼模型，UI 都會斷言「繼承主會話模型」。** 這正是本報告 §12 反覆引用的同一缺陷類別：**把「沒記錄」講成「知道」** —— 對一個沒問過的問題給出肯定答案。

**兩個修法（需你們決定，因為都改到使用者可見的語意）**：

| | 做法 | 性質 |
|---|---|---|
| **A** | **讓事實存活**：子代理完成時把 `modelLabel` 一併寫進 `task-*.doc.jsonl`（目前那裡只有角色名 `agent`），完成的任務就保留它跑了什麼 | 資訊完整；task 協定 doc 加欄位（additive） |
| **B** | **讓 fallback 誠實**：第 ③ 段改成「未記錄」，不再斷言繼承 | 最小、符合誠實公約；但使用者看不到已完成子代理的模型 |

**建議 A + B**：A 保留事實，B 保證真的沒資料時不亂斷言。**注意**：`packages/desktop/src/renderer/session/SubagentPane.tsx:198` 還有**自己的一層** fallback（`agent.modelLabel ?? t("繼承主會話模型")`），所以「字串」與「projection 的值」兩處都要一起改，否則會出現兩套不一致的措辭。

> **我沒有動它**：它需要先定語意、且涉及 task doc 格式與 UI 字串。寧可留成有完整證據的條目，也不在半驗證狀態下改動使用者可見行為。

---

## 10. 附錄 B：gateway 打包方式的成本量測 `[實測]`

§這節回應一個架構問題，不是缺陷——但數據可能對你們的決策有用。

**現況**：Desktop **不把 gateway 打包成 bundle**，而是 ship 整個 TypeScript 原始碼樹 + `tsx` loader，執行期 transpile。
`packages/desktop/scripts/build-gateway.mjs:12-16` 的理由是刻意的：
「why a source tree instead of a single-file bundle: the gateway's dependency graph resolves real files relative to `import.meta.url` … keeps the packaged runtime identical to the launch path the e2e tests already exercise」。

我實測了官方 build 與其成本：

```
node packages/desktop/scripts/build-gateway.mjs
  → gateway runtime: packages/desktop/.gateway-dist (238 packages shipped)

du -sh .gateway-dist  → 332 MB
  80M ffmpeg-static   78M @ffprobe-installer   64M node-pty
  23M typescript      19M @img                 12M @esbuild
   616K tsx
find .gateway-dist -name '*.ts' | wc -l  → 3454
```

**模組載入時間對照**（`await import(...)`，3 次）：

| | 載入時間 |
|---|---|
| 現行：`node --import tsx ./src/cli.ts` | **2781 / 2822 / 2909 ms** |
| esbuild 單檔打包後 | **675 / 786 / 1043 ms** |

**我實際試了「正常做法」並踩到四道坎**（各次嘗試的產物）：
1. **ESM/CJS interop**：需要 `createRequire` + `__filename`/`__dirname` banner shim（`Dynamic require of "node:stream" is not supported` → `__filename is not defined in ES module scope`）
2. **原生模組必須 external**：`node-pty`、`koffi`（+ 平台二進位包 `@koromix/koffi-win32-x64`）
3. **`import.meta.url` 相對資產定位**：打包後 `model-catalog.json` 找不到（`ENOENT ... .gateway-dist/model-catalog.json`）
   ——**這正好複現了你們在 `build-gateway.mjs` 寫的理由**
4. 單檔產物：**15.8 MB**，建置 **1176–1310 ms**

**判讀**：這是**有意識的取捨**，不是疏失——換取「打包後 runtime 與 e2e 路徑一致」。
代價是 ~2.8s 啟動延遲、332MB/238 套件、3454 個 `.ts`，以及**沒有可簽章的 build artifact**（配合你們 README 已自承「Windows 發行檔未進行程式碼簽署」）。
若未來要處理啟動延遲或簽章，第 3 點（資產定位）是主要工程，其餘兩點是標準樣板。

---

## 11. 架構判讀：這個 agent 是事件驅動的嗎？

**簡答：是，但只在「喚醒」這一層；狀態是 log-driven，不是 event-bus EDA。**
這三層要分開講，因為混在一起會得出錯誤的結論。

### 11.1 輸入准入與喚醒 —— **真正的事件驅動（push，無輪詢）** `[讀碼]`

```ts
// packages/core-agent/src/executor.ts:138-151
submit(input, inputId?) {
  const admission = mapSubmitToAdmission(input)
  deps.inbox.admit(admission)
  void pump()                        // ← 同步 push：一有准入就啟動 drain
  return { inputId: admission.inputId }
}
```

程式碼自己把這件事講白了（`executor.ts:48-51`）：

> 「the executor is **event-driven**, so ANY admission while idle starts the idle drain and a queue admission while a turn is active waits for the next turn boundary」

子代理喚醒父也是 push：`await opts.admit.admit(...)` 後 `opts.admit.wake(n.parentSessionId)`
（`packages/subagent/src/task-notification.ts:88-89`），且在該檔 `grep setInterval|setTimeout|poll` = **0 命中**。
`docs/CAPABILITIES.md:29` 的「event-driven wake」描述**與實作相符**。

### 11.2 Turn 執行 —— **序列 promise-lane，不是事件匯流排** `[讀碼]`

```ts
// packages/core-agent/src/executor.ts:79, 93-95
let chain: Promise<void> = Promise.resolve()
function pump(onlyId?) {
  chain = chain.then(async () => { for (;;) { … await deps.agent.run(next.text, …) } })
```

* 每 session **同時只有一個 turn**；N 個 session 用一個普通 `Map` 並行（`executor.ts:72-74`）
* `for(;;)` 迴圈 drain 收件箱；**一個 turn 失敗就停住 pump**，其餘 pending 留給未來（`executor.ts:117-119`）
* 沒有中央 event loop、沒有 typed event → handler 的分派

### 11.3 Turn 內的 step 迴圈 —— **由模型輸出驅動，加上 cascade hooks** `[讀碼]`

```ts
// packages/core-agent/src/index.ts:366
while (needsContinuation) { … }
// :761
needsContinuation = toolCallsThisStep > 0
// :763+ 若非（且非 refused/truncated/empty）→ ctx.emit("agent/pre-stop", …) 可要求再一輪
```

即：**「這一步有沒有工具呼叫」決定要不要下一步**；否則由 `agent/pre-stop` 這個 **waterfall/cascade hook**
（`ctx.emit`）決定。工具面同理：`tools/pre-execute` / `tools/post-execute` 是 waterfall，回傳 `allow|deny|ask` 閉集。
→ 這是**掛鉤瀑布**，不是事件訂閱。

### 11.4 狀態 —— **log 是唯一真相，事件只是通知（且無 replay）** `[讀碼]`

```ts
// packages/core-session/src/index.ts:390-396
const subscribers = new WeakMap<Session, Set<(ev: SessionEvent) => void>>()
export function subscribe(session, listener) { … }   // 只送 subscribe 之後 append 的事件
```

註解明示「**no replay of past events**」。模型輸入每步由 `deriveMessages(session)` **從 log 重建**，
而非維護一份被事件突變的記憶體狀態。這正是 `docs/CAPABILITIES.md` 說的 shadow-projection 基線。

### 11.5 但**確實有 5 個真輪詢點** `[實測 grep]`

| 位置 | 週期 | 用途 |
|---|---|---|
| `packages/desktop-gateway/src/host.ts:492` | 1000ms | `syncPolicy`（agent settings / subagents / context） |
| `packages/desktop-gateway/src/context-runtime.ts:87` | 30000ms | context 自動刷新 |
| `packages/plugin-registry/src/managed.ts:41` | 250ms | tick |
| `packages/schedule/src/driver.ts:191` | — | 提醒排程 |
| `packages/settings/src/index.ts:1591` | 500ms | **設定檔熱更（mtime:size 輪詢）** |

全部 `unref()`，且**都不在 turn 熱路徑上**——它們是為了觀察**外部檔案變更**。
而這裡正好接上 §A.4：你們**有**一個事件驅動的 `fs-watch`（chokidar），但**沒接線**，所以改成輪詢。

### 11.6 一句話結論

> **I-Harness 是「log-driven agent loop + push 式喚醒 + waterfall hooks + 事件通知觀察者」。**
>
> 說它「事件驅動」對**喚醒**而言是準確的（也是你們文件自己在說的）；
> 但若有人因此預期它是 event-bus EDA（中央事件迴圈、typed event → subscribers 決定控制流），那**不對**——
> 控制流是明確的 `while` + `for(;;)` + promise chain，session log 才是狀態的唯一權威。
>
> 這個組合的實際好處是**崩潰可恢復**（log 可重建一切）與**無輪詢延遲**（喚醒是 push）；
> 代價是**沒有 replay 的事件訂閱**——新訂閱者看不到歷史，所以任何需要「重播」的消費端都必須改走 log 讀取（`session/history` 就是為此存在的）。

**施工建議見 §12**（`fs-watch` 接線、「喚醒模型」文件收斂、`pump()` 失敗語意、`wake` 術語對齊）。
本節只回答「是什麼」；§12 回答「怎麼動」。

---

## 12. 事件驅動面的施工建議（給要動這塊的開發 agent）

> **這節不是缺陷報告。** §11 查明的是「機制是什麼」；這節是「**怎麼動**」。
> 其中 **§12.1 已經是定調的施工題**（業主決定接線 `fs-watch`，唯一衝突已定位、修法已實測）；
> **§12.2–§12.4 是需要你們拍板的設計確認**，不是 bug。
> 每一項都給「現況證據 → 選項/對策 → 建議」。證據引用格式與全文一致。

### 12.1 🔴【高】`fs-watch` 接線：**唯一實質衝突已找到並證實**——default ignore 排除 `.i-harness`

> **業主立場（2026-10-13）**：「做了肯定用啊，事件驅動一直是我們的目標；不過要是衝突我們就需要調整設計。」
> → **本節因此不是「去留決策」，而是「衝突分析 + 設計調整」。** 我原本建議刪除的那一版已被此立場取代。
>
> **本節經二次嚴格核查**：所有引用機制逐一排除、衝突以實驗證實（含對照組）。

#### 它是什麼 `[實測]`

| 項目 | 值 |
|---|---|
| 路徑 | `packages/fs-watch/src/index.ts`（**198 行**，單檔） |
| 相依 | `chokidar ^5.0.0`（**唯一**相依） |
| API | `createFsWatcher({ roots, ignore? })` → `{ events: AsyncIterable<{path, kind}>, close() }` |
| 匯出 | `createFsWatcher`、`FsWatcher`、`FsWatcherOptions`、`FsWatchEvent`、`DEFAULT_IGNORE`（5 個） |
| 事件詞彙 | `kind: "add" \| "change" \| "unlink"`（**套件自有**，非 `SessionEventMap` 成員） |
| 建置目的 | 檔頭註解自述：「**the dsh settings-file selection too**」——即它是**為了設定檔熱更而建的** |

**它的實作水準不低**（不是半成品）：
`ignoreInitial:false` + create 時同步的 **baseline 走訪**過濾初始掃描 echo（關掉 create-before-scan 競態，`baselineWalk`）；
首次 `next()` 等 chokidar readiness 所以晚訂閱者不會漏事件；錯誤只鎖存一次、每個 iterator 顯現一次；ignore 按**路徑段**（任意深度）比對。

**它的測試會過** `[實測]`：

```
✓ test/watch.test.ts (5 tests) 4430ms
  ✓ emits add/change/unlink events for one file
  ✓ does not emit for default-ignored dirs (node_modules/.git/.i-harness/dist)
  ✓ respects custom ignore entries
  ✓ close() stops the stream and ends the iterable
  ✓ roots are watched independently
Test Files  1 passed (1)      Tests  5 passed (5)
```

→ **這是「活的、會跑的、有測試的」程式碼，不是壞掉或半途的程式碼。** 只是**沒有人用它**。

#### 沒接線的證據（已排除所有引用機制）`[實測]`

我逐一檢查了各種可能的引用方式，**全部落空**：

| 檢查 | 結果 |
|---|---|
| `import` / `require` / 動態 import | 零命中 |
| 任何套件 `package.json` 宣告 `@i-harness/fs-watch` | **零命中**（lockfile 的 importer 清單裡沒有它） |
| 字串式／按名載入（plugin registry 之類） | 零命中 |
| `scripts/`、`e2e/`、設定檔 | 零命中 |
| 全樹 grep（排除建置產物） | 唯一命中是 **reachability baseline 自己**——那是「它沒被用的**紀錄**」，不是使用 |

> **注意**：初次 grep 會命中 `packages/desktop/.gateway-dist/` 內的 `fsWatch`，那是 **tsx 與 typescript 自己的 fsWatch**，屬建置產物，與本套件無關。已排除。

#### 文件已經自相矛盾 `[實測]`

這是最關鍵的一點——**你們的兩份文件對它說不同的話**：

| 文件 | 原文 | 判定 |
|---|---|---|
| `docs/CAPABILITIES.md:78`（**概覽**） | 「**goal / jobs / schedule** + **telemetry**（…）+ **fs-watch**（chokidar）」 | ❌ 以現在式列為**能力** |
| `docs/CAPABILITIES-DETAIL.md:490`（**詳細**） | 「**熱更 = 輪詢非 fs-watch**：`watchSettings` 以 `mtimeMs:size` 快照、預設 `intervalMs=500`…」 | ✅ **已經記載了真相** |

→ 所以**不是專案不知道**，而是**概覽與詳細版衝突**，且概覽是錯的那一邊。
（這正是你們自己在 `apps/cli/src/roles.ts:23-26` 拒絕的那種「一個事實兩個地方」——這裡還多了一層「其中一個地方是錯的」。）

#### 依賴的實際歸屬 `[實測]`

```
grep '"chokidar"' --include=package.json packages apps
  → 只有 packages/fs-watch/package.json:14   "chokidar": "^5.0.0"

pnpm-lock.yaml importer:
  packages/fs-watch:
    dependencies:
      chokidar: { specifier: ^5.0.0, version: 5.0.0 }
```

→ **chokidar 進樹的唯一原因就是 fs-watch。** 所以這枚依賴的成本**已經付了**，而且是為了一個「本來就要用、只是還沒接線」的消費者付的——這讓接線的邊際成本降為零（不需要新增任何依賴，`CAPABILITIES.md` §八 的「通用公開庫自由」原則也不受影響）。

#### 而設定熱更走輪詢，理由卻是「沒有 chokidar」`[實測]`

| 事實 | 出處 |
|---|---|
| 500ms 輪詢 | `packages/settings/src/index.ts:1591` `setInterval` |
| 理由一 | `:1549`「Polling settings watcher (**no new deps — no chokidar**)」 |
| 理由二 | `:1403`「Polling watcher (500ms default — **no fs events, no chokidar**)」 |

→ **理由的前提已不成立。** 而更值得注意的是：`fs-watch` 的建置目的**就是**「dsh settings-file selection」——
**這個套件是為了設定熱更而建的，然後設定熱更選了輪詢。**

#### ★ 唯一實質衝突：`DEFAULT_IGNORE` 排除 `.i-harness`，而 2/3 設定層住在那裡 `[實測]`

```ts
// packages/fs-watch/src/index.ts:38
export const DEFAULT_IGNORE = ["node_modules", ".git", ".i-harness", "dist"] as const

// :82  —— 只能「加」，不能「減」
const ignoreList = [...DEFAULT_IGNORE, ...(opts.ignore ?? [])]
const isIgnored = (path: string): boolean => {
  const segments = toPosix(path).split("/")
  return segments.some((segment) => segment !== "" && ignoreList.includes(segment))
}
```

而 `resolveLayeredDefaults`（`packages/settings/src/index.ts:1530-1545`）的三層是：

| 設定層 | 實際路徑 | 含 `.i-harness` 段？ | `fs-watch` 可監看？ |
|---|---|---|---|
| global | `join(resolveHarnessHome(), "settings.json")` → **`~/.i-harness/settings.json`** | ✅ 是 | ❌ **被 ignore 擋掉** |
| workspace | `join(workspaceRoot, ".i-harness", "settings.json")` | ✅ 是 | ❌ **被 ignore 擋掉** |
| project | `join(cwd, "settings.json")` | ❌ 否 | ✅ 正常 |

**實驗證實**（`[實測]`，我實際跑 `createFsWatcher` 監看並寫入兩次）：

| 受測路徑 | 觀測到的事件 |
|---|---|
| `<ws>/.i-harness/settings.json` | **★ 零事件** |
| `<ws>/settings.json`（**對照組：同檔名、同 watcher、同流程**） | `change:<ws>\settings.json`、`change:<ws>\settings.json` ✅ |

→ **唯一變因就是 `.i-harness` 這一段路徑。** 所以衝突是**單一原因、可複現、與內容無關**。

**這是不是「刻意的」？是——但代價沒被看見。**
`DEFAULT_IGNORE` 的 JSDoc 寫「never watch dependency/SCM/**harness**/build dirs」，
對「監看我的專案」完全正確（不該為 harness 中繼資料觸發）。
但對於「監看我的設定檔」——而設定檔**就住在 harness 目錄裡**——同一個預設值是致命的。

> **一句話**：這個套件的預設 ignore 清單，排除了它**唯一預定消費者**存放檔案的那個目錄。
> 而 `ignore` 是**加法**的（JSDoc 明寫 "in addition to the defaults"），所以**呼叫端無法自救**。

#### 順帶：`fs-watch` 內部對「root 是否權威」自相矛盾 `[讀碼]`

同一個檔案裡，兩處對「明確指定的 root」採取相反的態度：

| 位置 | 行為 | 判定 |
|---|---|---|
| `baselineWalk`（:48-49） | `for (const root of roots) baseline.add(toPosix(root))` —— **無條件**加入 baseline，**不查 isIgnored** | root 是**權威** |
| `watch(roots, { ignored: isIgnored })`（:126-130） | chokidar 用 `isIgnored` 過濾**包含 root 本身** | root **可被否決** |

→ 兩者不一致。`baselineWalk` 的註解甚至寫「root addDir echoes are initial too」，
顯示作者的意圖是「root 一定在 baseline 裡」；但 chokidar 那一側會讓 root 連監看都不成立。

**這個不一致正是修復的入口**——見下方選項 1（它同時解掉衝突與這個不一致）。

#### 設計調整選項

**選項 1（推薦）：明確 root 不受 ignore 否決**

ignore 的語意應該是「**走訪過程中發現的路徑**要跳過」，不是「**呼叫端明確要求的路徑**也跳過」。
最小改法是包一層，讓 root 永遠通過：

```ts
// packages/fs-watch/src/index.ts —— createFsWatcher 內
const rootSet = new Set(opts.roots.map((r) => toPosix(resolve(r))))
const chokidarIgnored = (path: string): boolean =>
  !rootSet.has(toPosix(resolve(path))) && isIgnored(path)

// watch(opts.roots, { ..., ignored: chokidarIgnored })
```

**為什麼推薦這個**：
* 讓實作與 `baselineWalk` 的既有意圖**一致**（root 權威）——順手修掉上述不一致；
* **不動任何 ignore 語意**（`.i-harness` 底下的**子項**仍被忽略，這對「監看專案」是對的）；
* `ignore` API 保持 additive，**無破壞性變更**，既有的 5 個測試應全數不變；
* 對 settings 而言，它要的是**三個明確檔案**，不是掃描 `.i-harness` 目錄——所以精確符合需求。

**選項 2：讓 ignore 可被覆蓋**

改成 `ignoreDefaults?: boolean`（預設 `true`）或 `ignore: string[] | "defaults"`。
可行，但**語意較粗**：呼叫端為了一個檔案，得放棄整個 ignore 清單，
於是 `.i-harness` 的子項（session 記錄、認證檔…）也可能被監看。

**選項 3：settings 側自建 watcher**

settings 自己用 chokidar（或 node 的 `fs.watch`），不依賴 fs-watch。
但這**正是你們拒絕過的做法**——`settings/src/index.ts:1549` 寫「no new deps」，
而 fs-watch 已經在樹內。繞過它等於讓那枚依賴永遠孤立。

**建議：選 1。** 它把「修衝突」與「修內部不一致」變成同一件事，且不犧牲 ignore 的保護範圍。
若你們認為「明確 root 也可以被 ignore」才是對的語意，那應該**同時**改掉 `baselineWalk`——
否則兩處會繼續說不同的話。

#### 選項 1 已實測驗證有效 `[實測]`

我實際套用了選項 1 的 patch（`rootSet` + 包裝 `ignored`，3 處改動），跑了三組驗證，**然後完整還原**：

| 驗證 | 結果 |
|---|---|
| `.i-harness/settings.json` 作為**明確 root** | **0 → 2 事件** ✅ 衝突解除 |
| 既有 5 個測試 | **5/5 全過** ✅ 無回歸 |
| **作用域精確性**：root = workspace 時，`.i-harness/settings.json` 作為**子項** | **仍被忽略** ✅ 修法沒有過寬 |
| 同上情境下的正常檔案（`project.json`） | 仍正常觸發 ✅ 修法沒有壞掉 |

→ 所以選項 1 的語意正是「**明確 root 豁免，子項照舊忽略**」，與 `baselineWalk` 的既有意圖一致。
**這是已驗證可行的最小修法，不是我推測的方向。**

> 還原後 `packages/fs-watch/src/index.ts` 的 sha256 = `075d44c5f6761c9c6536297aee5238ff3e754e1cd578e7f64b1382f61237d4bd`，與修改前一致。

#### 其他次要落差（都能在轉接層處理，不是阻擋）`[讀碼]`

| 落差 | 現況 | 對策 |
|---|---|---|
| 介面形狀 | `fs-watch` 給 `AsyncIterable`；settings 要 `onChange(path)` callback | 一個 `for await` 橋接；不需要改套件 |
| 非原子外部寫入 | settings 現行會為一次 `truncate→write` 產生**兩次**偵測，靠 conflate 吸收 | `fs-watch` 的 `awaitWriteFinish: { stabilityThreshold: 100 }` **本來就是為了收斂這個**——是改善不是障礙 |
| 錯誤處理 | settings 的熱更不該因 watcher 錯誤而死 | `fs-watch` 的錯誤是「鎖存一次、每個 iterator 顯現一次」（`pendingError`）→ 轉接層要 catch 並決定是否重啟 watcher |
| 初始化語意 | settings：第一個 tick 只快照，既有狀態永不觸發 | `fs-watch`：baseline 過濾讓既有檔案永不發 `add` → **語意等價** |
| 停用開關 | settings：`watchIntervalMs: false` | `close()` + 不建立 watcher |
| 自我寫入 | settings 用 tmp+rename，會自我觀測 | 既有的 `recheckPendingChange` 是**比對狀態而非時間**，與 watcher 無關 → **原樣保留**（這是很好的分層：fs-watch 換掉「偵測」，狀態比對保留為「過濾」） |

#### 施工檢查表（轉接層必須保住的不變量）`[讀碼]`

`watchSettings` 現行有兩個已記錄的保證，事件驅動版本**必須同樣守住**：

1. **第一個 tick 只快照** —— 既有狀態永不觸發（`:1553-1554`）。fs-watch 的 baseline 語意與此等價，但**要有測試證明**。
2. **一次寫入不得被重複回報** —— 現行靠「跳過 in-flight capture」（W1/A，`:1556-1558`）＋ 狀態比對 conflate。
   換成 push 之後，「跳過 in-flight」這個機制**消失了**，必須確認 conflate 單獨足夠（它應該夠，因為它比對狀態而非時間）。

**建議的紅燈先寫**：一個「外部寫入 workspace 層 settings → 恰好觸發一次 `onChange` 且 `data.path` 正確」的測試，
在接線前必須**失敗**（因為現在 `.i-harness` 被吞掉——這正是本節證實的衝突）。它就是 §12.1 的 red-first。

> **與文件漂移的關係**：接線完成後 `CAPABILITIES.md:78` 的宣稱就變成真的了——這也是為什麼選 1 比刪除更符合你們的立場。
> 在那之前，`CAPABILITIES.md:78` 與 `CAPABILITIES-DETAIL.md:490`（已寫「熱更 = 輪詢非 fs-watch」）仍然衝突，**修完再一併對齊**。

### 12.2 🟠【中】把「喚醒模型」收斂成一份權威文件

**現況證據**：同一個模型被寫在**三個**地方、三種詳略：

| 位置 | 內容 |
|---|---|
| `docs/CAPABILITIES.md:29` | 一行：「`send/followup/steer/inject` 四層 + 持久化收件箱 + event-driven wake」 |
| `packages/core-agent/src/executor.ts:48-51` | **最完整**：說明 idle 時任何 admission 啟動 drain、queue tier 等下一個 turn boundary |
| `packages/subagent/src/task-notification.ts:12` | 說明 `wake` 為何是 no-op（因為 admit 即喚醒） |

→ 這正是你們自己反覆警告的缺陷類別：**「一個事實有兩個地方要改」**。
`apps/cli/src/roles.ts:23-26` 就為了這個理由**拒絕**寫下第二份角色名稱清單（「A literal list here would be a second place to edit for one fact」）。
這裡是一個事實有**三個**地方，而且其中兩處是註解——註解不會被閘門檢查。

**建議**：建 `docs/concurrency-and-wake.md`（或作為一節併入 `docs/contracts.md`），把 §11 的四層寫成權威描述，至少涵蓋：

1. **四層輸入准入**與各自的 delivery 映射（`mapSubmitToAdmission`，`executor.ts:48-66`）
2. **喚醒是 push**：`submit()` 內的 `void pump()`，**無計時器**（可用 grep 證明：`packages/core-agent/src/` 無 setInterval）
3. **lane 語意**：每 session 序列、N session 並行（`Map`）、**一個 turn 失敗停住 pump**
4. **step 續行判定**：`toolCallsThisStep > 0`，否則 `agent/pre-stop` waterfall 可要求續行（`core-agent/src/index.ts:761-766`）
5. **事件訂閱無 replay**：`subscribe()` 只送 subscribe 之後 append 的事件；需要歷史請走 log/`session/history`
6. **五個輪詢點**（§11.5 的表）與各自為何不是 push

然後讓上述三處改為**指向**該文件（單一真相）。

> 附帶好處：寫這份文件會**強迫** §12.1 與 §12.3 的答案變得明確——這也是建議把它排在它們後面的理由（見 §12.5）。

### 12.3 🟠【中】`pump()` 失敗後的收件箱停滯：請確認是刻意的，並讓它可見

**現況證據** `[讀碼]`（**我沒有重現使用者可見的停滯**）：

| 事實 | 出處 |
|---|---|
| `pump()` 全樹只有 2 個呼叫點 | `executor.ts:139`（`runAdmitted` → `pump(inputId)`）、`:150`（`submit` → `void pump()`） |
| **無任何自動重泵** | `packages/core-agent/src/` 內無 setInterval；僅 `index.ts:525,607` 的 reasoning timer（用途無關） |
| 失敗路徑是直接 return | `executor.ts:117-119`：`lastError = err; return` |
| 且這是被寫下來的刻意行為 | 同處註解：「a failed turn stops this pump (**its remaining pending stay for a future pump**); the error surfaces through `drain()`」 |

→ **機制確認**：一個 turn 失敗後，**收件箱中其餘 pending 不會被自動處理**，要等下一個 `submit()`（或 `runAdmitted`）才會再泵。

**影響評估（誠實邊界）**：
* **互動式 Desktop 通常無害** —— 使用者看到錯誤後的下一次輸入**就是**那個 `submit()`。
* **無人值守情境有理論風險** —— 背景子代理通知、`workflow`、`schedule` 驅動的 session，若某一 turn 失敗，
  可能停在「有 pending 但無人在泵」的狀態直到外部輸入。
* **我沒有重現這個停滯**，也沒有確認 Desktop 是否已把「N 筆待處理」呈現給使用者。
  `session/queue` RPC 存在（見 `docs/CAPABILITIES-DETAIL.md` §4），所以使用者**可能**看得到——需你們確認。
* **我也找不到釘住此行為的測試**：`grep "future pump" packages/core-agent/test/*.ts` 無命中。

**選項**：

| | 動作 | 適合 |
|---|---|---|
| **A** | 維持 fail-fast（不燒 token），但**讓停滯可見**：失敗時把 `pending.length` 隨錯誤回報宿主，UI 顯示「已暫停，N 筆待處理」 | 認為 fail-fast 是對的，但使用者不該不知道 |
| **B** | 失敗後**自動重泵一次**（帶 backoff） | 認為 pending 應該有機會被處理 |
| **C** | 維持現狀但**明文文件化**（寫進 §12.2 的權威文件） | 認為現狀正確且可接受 |

**建議**：先回答「**這是刻意的嗎？**」。
若是，(A) 或 (C)；若否，(B)。**無論選哪個，都應補一個測試釘住選定的行為**——
現在這個語意只存在於一行註解裡，而註解不會被閘門保護。

### 12.4 🟡【低】術語對齊：`wake` 不喚醒任何東西

`ParentInputAdmission` 同時暴露 `admit()` 與 `wake()`，但 `wake` 被實作為 **no-op**（理由正確：admit 本身就是喚醒）。
契約上保留未來接縫是合理的，但**介面會誤導**：一個叫 `wake` 的方法不喚醒。
`task-notification.ts:12` 的檔頭註解已解釋此事，但 **`wake` 成員本身沒有**。

**建議**：在介面的 `wake` 成員 JSDoc 直接寫明「目前為 no-op：admit 即喚醒；保留給未來需要獨立喚醒的 executor」。
一行註解，零風險。

### 12.5 施工順序建議

1. **§12.1 `fs-watch` 接線先做** —— 業主已定調要做，衝突已定位、修法已實測；拖著會讓 `CAPABILITIES.md` 與 `CAPABILITIES-DETAIL.md` 持續衝突。
2. **§12.3 先回答「刻意嗎」** —— 若需改動行為，越早越好（越晚越難補測試）。
3. **§12.2 寫權威文件** —— 它會強迫前兩項的答案變得明確；寫完後三處註解改為指向它。
4. **§12.4 順手做**。

> **與 §5 的關係**：§5 是真的 bug，有紅燈，可直接動手。
> §12 是**決策 + 收斂**，性質不同——所以我在 §7 的清單裡把它們標為不同類型，請不要把它們排在同一條工作流上。

---

## 13. 結語

**整體判讀**：程式碼本體的品質**高於我對同類專案的預期**。
typecheck 81/81 全綠、reachability 閘門真的在運作（且能識別已修好的列）、81 個套件中 76 個測試全綠。
5 個紅燈裡**只有 1 個是產品缺陷**，其餘是環境耦合（Windows 權限、Git 版本）與已公開標示的實驗性套件。

**你們最強的資產是誠實度**：PSEC README 自承 experimental/`pty:false`/qualification `incomplete`/Git MSYS 在其中失敗；
`verify-all.mjs:16-22` 自承「WHAT IT CANNOT PROVE — NOTHING about whether the tests themselves are meaningful」；
`build-gateway.mjs` 主動解釋為何不打包。這種程度的自我揭露很少見，**請維持**。

**但要小心它的一個副作用**：當已知的紅燈被允許長期存在（PSEC 5 個、環境耦合 2 個），
`pnpm -r test` 就從「閘門」退化成「需要人工判讀的訊號」。
§7 的 #2/#4/#5 三個測試守衛修正，目的是**讓紅燈重新等於回歸**——這是本次建議裡最有長期價值的一組。

**優先修一件事**：§5 的 `posix-execution.ts:165` resize 競態。它會讓使用者在調整終端尺寸後遺失輸入，
且你們**已經有**對應的紅燈測試，直接可用。

**優先做一個功能**：§12.1 的 `fs-watch` 接線。
它是本次唯一一個「已定調要做、衝突已定位、修法已實測」的項目——
唯一實質衝突是 `DEFAULT_IGNORE` 排除 `.i-harness`（而 global 與 workspace 兩層設定檔都住在那裡），
修法是「明確 root 豁免 ignore，子項照舊忽略」，我實測 0 → 2 事件、5/5 既有測試不變、作用域精確。

**最後一句**：本報告的 §5 是缺陷、§12.1 是已定調的施工題、§12.2–12.4 是設計確認。
把這三類分開處理，是我讀完你們的審計鏈文件後覺得最符合你們既有紀律的做法——
你們對「缺口」與「取捨」一向分得很清楚，這份報告也照同樣的規矩寫。

---

*本報告未修改任何生產程式碼；唯一的臨時修改（§5.3 的兩個變體）已還原，`packages/sandbox-local/src/posix-execution.ts` 的 sha256 為 `1e524512c8437d86e3836275bd9af437eb3097ff1846c6c094679ac875cda02a`，與修改前一致。*
