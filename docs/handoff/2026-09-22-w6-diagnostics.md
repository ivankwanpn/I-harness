# W6 — 結構化診斷 ＋ redactor：**完成**（T1–T7／7）

**Written:** 2026-09-22，前一個爆 context 的 controller session 寫下 T1–T2 的部分（依 owner 指示在 T2 收線、push）；同日工作電腦接手後續作 **T3–T7**，本文件隨之更新，並在 T7 收成**終態**（檔名由 `…-partial.md` `git mv` 而來）。
**Audience:** 讀這份記錄的人。本單元已完成，所以沒有「接手續作」的讀者了；最近的讀者是**這個分支的終審複審**，以及日後要查 W6 究竟證明了什麼的人。
**State measured at:** `f307cdb`（T6 的最後一個提交；`ec18c9d0`…`f307cdb` 收在這裡，**T7 的收尾提交緊隨其後（數目不在這裡寫死 —— 這份記錄本身就是其中一筆）**）—— §1 各節在**各自的**量測修訂上量測（那一節自己寫了是哪一個），§2 是 T7 在 `f307cdb` 上跑出來的最終讀數。**行號會腐，引用前先重量**（本 repo 的既有紀律）。**自重**：`git rev-parse HEAD origin/m68`。

---

## 0. 先看五件事

| Fact | Value |
|---|---|
| Repo / remote | 原工作站 `D:\I-harness-main` ↔ `https://github.com/ivankwanpn/I-harness.git`（authoritative）；工作電腦同路徑 |
| Branch | **`m68`**（本單元的里程碑分支；`main` 的合併時機由人決定） |
| HEAD / origin | **HEAD 於 2026-09-22 是 `f307cdb`**（T6 的最後一個提交、T7 的起點）；`origin/m68` 於同日第五次 push 同步到 T6，**T7 的收尾提交在它之後**。**自重** |
| 本單元 | **W6**：建 `@i-harness/diagnostics`（`createDiagnostics` ＋ `createRedactor`），把 **107 個 `console.warn/error` 站點**分級上去 —— 而 **`I_HARNESS_LOG` 未設時 stderr 逐位元組不變** |
| 進度 | **T1 ✅ · T2 ✅ · T3 ✅ · T4 ✅ · T5 ✅ · T6 ✅ · T7 ✅**（**7／7**；§1 的 T1–T6 ＋ §2 的 T7） |
| **最終驗證** | **`pnpm verify:all` 五步全綠、exit 0**（2026-09-22，T7 親量；母體 **67／67**；suite **2889 passed／9 skipped／0 failed**；typecheck exit 0；e2e exit 0／5 檔；`--gate` exit 0／**`PASS -- no new rows`**）。指令、五步讀數與**兩筆 allowlist** 見 §2 |

**設計依據**：spec `docs/superpowers/specs/2026-09-17-m3-measurement-foundation-design.md` **§3.3（`:177-195`）＋§3.5（`:217-239`）**（**2026-09-22 重測**：T7 加了兩則 dated 註記，兩節各因此 +2 行 —— 計畫裡寫的 `:177-193`／`:215-235` 是**加註之前**的位置）；B1 裁定 **B**（owner 2026-09-22：「追求完整性，別人後面要修要改很麻煩」）。
**計畫**：`docs/superpowers/plans/2026-09-22-w6-diagnostics.md`（7 任務；**§0.1 的普查指令是唯一有效的量法**——舊的 `grep -rn "console\.(warn\|error)"` 壞在**兩個方向**，數到 152 條裡 140 條不是呼叫。**⚠ 機制更正（2026-09-22 複審，T7 實測）：** 它**不是**「在 BRE 裡是字面量」—— GNU BRE 認得 `\|`，那條模式其實退化成「含有 `error)` 的行」。完整機制與 152／140／12 的實測見 §2.4；計畫 §0.1 那一行已加同日的指向註記）。
**SDD ledger**：`.superpowers/sdd/2026-09-22-w6-diagnostics/`（`progress.md`＋task brief／report／review diff）—— **gitignored**；依 owner 2026-09-22 裁定**維持不納版控、靠複製遷移**（遷移包：`ih-migration-2026-09-22`）。本文自足，不依賴它。

---

## 1. 完成的部分

### T1 — 套件 ＋ `createDiagnostics`（含逐位元組不變的模式）

**Commits**：`ec18c9d0`（5 檔 +627，實作）· `0ae6f231`（fix fold：ambient memo、console-close 委派、空 env 三案）。
**檔案**：`packages/diagnostics/{package.json,tsconfig.json,src/index.ts,src/record.ts,test/diagnostics.test.ts}`。零依賴、腳手架照 `harness-home`。

**機制（複審通過的設計）**：

- **模式在構造時解析**：`opts.stream` 勝過 `process.env.I_HARNESS_LOG`；未設／空字串 ⇒ 無 sink ⇒ **委派 console**；`stderr` ⇒ 每次寫入時重讀 `process.stderr`；其他 ⇒ append 到該路徑（父目錄首次寫入時建立）。路徑 sink 失敗 ⇒ **`console.error` 報告一次後停用**（不轉投：console 是逐字通道、記錄是 redact 過的副本）。
- **逐位元組不變的機制**＝`delegate(level, msg)`：console 只收**單一逐字參數**；`data`／`err` 在此被丟棄（第二個參數會改變全部 95 處 spy 比對）。`level` **只過濾記錄**，永不改道、永不靜音 console 通道。
- **環境實例**：`installDiagnostics(d): () => void`（身分式卸載）· `currentDiagnostics()` · `diagnosticsFor(phase)`（**每次呼叫解析當前實例**；每 (instance,phase) 一枚 memoized view）。
- **close 語意**：任何 handle 的 `close()` 關整個 instance 並自 ambient 槽卸下；**結構化實例 close 後不寫，console 模式 close 後仍委派**（T4 的 close 排序靠這條）。

**測量**（at `0ae6f231`）：`packages/diagnostics` **17/17**；typecheck exit 0；母體 **66 → 67**（`verify-all.mjs:49-50` 數帶 test script 的 workspace 目錄）。

**＋lockfile 的缺口（工作電腦 2026-09-22 實測，`3d7fef4` 補上）**：`ec18c9d0` 沒帶 `pnpm-lock.yaml`，而 pnpm **10.34.5** 的 `install --frozen-lockfile` **exit 0 但仍會把 `packages/diagnostics: {}` 這行 importer 寫回** ⇒ 「needed no change」只對**解析**為真，檔案本身會被補寫、每台機器的樹都留一個 dirty 檔。

### T2 — `RedactedError.fromError` ＋ **`record.err` 的寫者**

**Commits**：`1d20ef5b`（`fromError` ＋ 四 adapter 洩漏 fixture）· `4915350a`（controller 裁定的 API 擴充 ＋ 計畫 §0.3 的 dated ⚠ 更正）。

- `src/record.ts` — `fromError(err: unknown, redactor: Redactor): RedactedError`：`message` 與 `stack` **都**過 redactor（V8 的 stack 第一行就是 message，只 redact 一邊仍會把秘密寫進記錄）；`name` 保留不 redact；**不變異原物件**；非 Error 拋出物 ⇒ `String(err)`＋`name = typeof err`（沿用 `apps/cli/src/run.ts:253` 的 `failureReport` 慣例）。
- `src/index.ts` — 四級方法簽名擴為 **`(msg: string, data?: Record<string, unknown>, err?: unknown)`**；`toRecord` 內 **`err !== undefined ⇒ rec.err = fromError(err, inst.redactor)`**（`record.err` 的唯一寫者 ⇒ §3.5 強制力第 2 層在 API 邊界成立）；ambient 路徑轉發第三參數；**`delegate` 一字未動**。

**測量**（at `4915350a`）：`packages/diagnostics` **27/27**（2 檔）；typecheck exit 0；RED 先行（3 參數呼叫時 typecheck 紅 `Expected 1-2 arguments, but got 3`）；突變逐條（含 ambient 把 data+err 轉給 console ⇒ 紅 4 條 byte-identity 守衛）。

### T3 — `createRedactor`（三趟覆蓋）

**Commits**：`b5463f1`（redactor 本體，3 檔 +648）· `99c287e`（**T2 的測試 double 退役**——`test/record.test.ts` 的 `[REDACTED]` 斷言改為對真工廠，複審確認是**強化**）· `7c78589`（測試內三處註解更正）。**檔案**：`src/redactor.ts` ＋ `test/redactor.test.ts`（＋`src/index.ts` 兩個新 export）。

- **三趟掃描（§3.5 逐條）**：①鍵名（大小寫／分隔符不敏感；`monkey`／`tokenBudget`／`author` 等 named non-hits）②憑證形狀（`\bsk-[A-Za-z0-9_-]{8,}`、`\bBearer\s+\S+`、PEM block、URL userinfo——span 是 userinfo、scheme+host 保留；長 base64 **只在像秘密的鍵下**）③已註冊值（精確子字串、≥8 字元、7 字元拒收）。巢狀物件／陣列遞迴，輸入不變異。
- **`mask` 是 collect-then-splice**：所有 span 讀自原始字串、一次排序、重疊併成同一個 token ⇒ **規則順序依構造不可觀測**（R4）。
- **殘餘逐字寫在模組開頭**（`redactor.ts:1-13`）：v1 **不**承諾「沒有秘密離開行程」，只承諾「未被**名稱、形狀或註冊**比對到的秘密不離開」；`size()` 可稽核。**這就是 T2 複審留下的 ⚠ 的落地**。
- `extraRules` 為 additive；`toJSON` 分支是 §3.5 之外的 justified 追加（JSONL sink 的 own `toJSON` 否則原樣穿過）。

**測量**（at `7c78589`，controller 親量）：`packages/diagnostics` **46/46**（3 檔，19 新增）；typecheck exit 0；16 條突變逐一回退（檔按 sha 驗回）；R3 的交換經複審重算：刪 `sk-` 規則 ⇒ T2 的兩條精確斷言轉紅，四條 adapter 列因 `Bearer` 規則仍綠。

**複審裁決（2026-09-22）**：T1 Approved（1 件計畫層 Important 已裁定，§3 R1）· T2 ✅／Approved，0 Crit／0 Imp（4 Minor）· T3 ✅／Approved，0 Critical，**1 Important 標記 plan-mandated**（`Bearer \S+` 對散文過度遮蔽 ⇒ 裁定維持，§3 R5），6 Minor。

### T4 — CLI bootstrap（runId、redactor、install/close 接線）

**Commit**：`b5a5321`（6 檔 +787/−11）。**檔案**：新增 `apps/cli/src/diagnostics-bootstrap.ts` ＋ `apps/cli/test/diagnostics-bootstrap.test.ts`；改 `apps/cli/src/{index,run}.ts`；`apps/cli/package.json` 加 workspace link（＋`pnpm-lock.yaml`）。

- **三個入口 install、每條出口 close**：四個 `runHeadless` 出口（複審重量：`run.ts:336`／`:646`／`:771`／`:776`）＋ sdk/acp 的 teardown。測試以真實 `main()` 驅動，`expectClosed` **同時**斷言卸載（`currentDiagnostics()` 為 undefined）與 sink 釋放（close 後再 warn 不再寫 stderr）——後者才是區辨「只清槽」的判別器。
- **redactor 餵法照 §3.5**：env 掃描（`/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i` 且值 ≥8）＋ `settings.get().llm.providers[*].apiKeyEnv` → `credentials.resolve(ref)`；`loadProviderRuntime()` 早就回傳那個 store，只是呼叫端把它丟了（複審重開：`provider-runtime.ts:42-60`；`run.ts:406-413` 保留它）。
- **zero 改動 `packages/`**：複審確認 diff 不含任何 `packages/` 檔，也不含任何既有測試檔（30 檔／95 處 spy 的守衛完整未動）。
- 三個具名設計選擇（複審判定）：①**不傳 `stream`** ⇒ 目的地由 `process.env` 決定、`env` 只當掃描來源 —— **正確讀法**（顯式 stream 會讓 `I_HARNESS_LOG=<path>` 不可達），命名有誤導性入 §7 ②run 路徑宣告的 refs 由 `run.ts` 經**一枚模組級 redactor 槽**晚餵 —— **可接受**（順序有強制、身分守衛齊、無測試滲漏）③sdk/acp 在 install 與 teardown 接線之間拋出會漏實例 —— **真、已揭露、可避免**（入 §7）。

**測量**（at `b5a5321`，controller 親量）：CLI 全測 **283 passed／1 skipped／0 failed**（25 檔；前置基線 265+1）＋新檔 18/18；typecheck exit 0；gate **7 → 4 NEW**（437 rows）。RED 13/18；11 條突變（M11 紅 0 條，複審判為**惰性分支**）。

**複審（2026-09-22）**：✅ Spec compliant／Approved，0 Critical／0 Important；6 Minor（§7）。

### T5 — 分級遷移（`apps/cli`：**50 站分級 ＋ 10 列名例外**）

**Commits**：`d7fe858`（index.ts 22 站）· `869607b`（provider 9）· `ee1dfe2`（roles/models/hooks/plugins/sessions 18）· `9a596a4`（run.ts 的 5 條 mount warn）· `d49586a`（計畫 T5 列的 dated 更正）· `68111ec`（**R10**：`index.ts` 的 run 失敗報告遷移，level `error`／phase `run`）· `b6fbb42`（**R10**：T4 的四條案例改寫捕捉機制）· `aa22f27`（**R11**：五個 exit-0 help 列印回退）· `41abb8d`（計畫 T5 註記定稿）· `4b622fd`（複審兩條「記錄在說謊」的 fold）。

- **形狀**：每站 `d.<level>(msg)`，`d = diagnosticsFor(phase)` 在**模組層**；level **繼承自舊通道**（`console.warn(`→`d.warn`、`console.error(`→`.error`），msg 逐字。
- **十個列名例外**（byte-untouched）：`hooks.ts:161`、`index.ts:194`、`models.ts:348`、`models.ts:364`、`plugins.ts:443`、`provider.ts:227`、`provider.ts:254`、`roles.ts:241`、`roles.ts:295`、`run.ts:776`（複審在 HEAD 重跑 census：`apps/cli/src` 只剩 11 原始行＝10 例外＋1 註解）。
- **唯一的多參數站點**：`index.ts:800`（`console.error("…loop error:", msg)` → 模板字串折疊）——複審用 `util.format` 語義確認輸出位元組不變，且它是**全樹唯一**的多參數 console 呼叫。
- **T4 的測試改寫（R10 授權）**：`test/diagnostics-bootstrap.test.ts` 的捕捉改成「工廠回傳後立刻讀 `currentDiagnostics()`」，四條性質（安裝、四出口 close、sdk/acp teardown、`=stderr` 一條 JSONL）逐條保留；case ① 反而**變強**（多一條 `toHaveLength(1)`）。測試檔 diff 只有這一個檔。
- **相位規則（T5 fold 寫進計畫）**：**縫優先於檔** —— 判準是「發出訊息的縫」，不是檔案；`run.ts` 的五條 mount warn 因此是 `mount`（`run.ts:486/495/507/642/802`）。

**測量**（at `4b622fd`，controller 親量）：CLI **283 passed／1 skipped／0 failed**（25 檔）；typecheck 0；gate **436 rows／3 NEW**（`diagnosticsFor` 已清除）。複審（**opus**）：✅ Spec compliant／Approved，0 Critical／0 Important，8 Minor（§7）。

**⚠ 完成宣告的精度（複審指名）**：「50 站走 handle」**不等於**「50 站寫記錄」——實例只在三條路徑 install（`index.ts:477/585/835`），其餘命令在 `=stderr` 下仍委派 console。這是計畫的契約，不是缺口。

### T6 — 分級遷移（packages 側：**44 站分級 ＋ 3 列名例外**；六個縫）

**Commits**：`be6ee8e`（14 個 manifest 加 `workspace:*`＋lockfile）· 六個縫包：`07f2a9d` skills／`7339f86` workflow／`ae0f9d4` plugin-registry／`7264513` credentials／`407bcbc` hooks／`3f56c2f` schedule · 十個套件包：`5d3c727` session-executor／`55e5b0c` plugin-registry／`bf485b5` mcp-client／`3136ef6` sdk／`c43834f` hooks／`0738b86` subagent／`c6cf609` rewind／`a334aed` output-retention／`29b0a15` core-plugin／`f6398fc` compaction · `88c05c6`（計畫 T6 Step 3 的 dated 更正：`--gate PASS` 不可達）· `6c47681`（複審 Minor 1 的 fold：§0.3 加 dated 指針）。

- **census**：47 = **44 遷移 ＋ 3 例外**；全樹 **107 → 94 分級 ＋ 13 例外**。level：43 `warn` ＋ 1 `error`（`core-plugin:458`），全部繼承自舊通道。
- **六個縫的形狀＝`currentDiagnostics()` ＋顯式 console fallback**（計畫 :150 本來就寫「取環境實例、無則 console」；複審判定**可辯護、非 instrument-chasing**，且 `diagnosticsFor(phase)` 行為等價——差別只在 gate row 與 census 可見性）。**代價（T7 已記，§2.5 第 4 點）**：6 行 fallback 仍是 census 的可見子群（重跑 grep 會讀到 12 行，不是 50→44 的直覺數）；`#currentDiagnostics` 由這六個**真 import** 清除。
- **R13 的三個例外**（byte-untouched）：`session-persistence:251`、`telemetry:11,13`（第二參數 `unknown` ⇒ 折疊不能保證逐位元組）；**`compaction:158` 折疊**（第二參數是字串；複審以 `util.format` 語義證明等價）。
- **T5 的警報未響**：CLI 283/1 綠 ⇒ 失敗路徑上沒有留下未遷移的 package 站點。

**測量**（at `6c47681`，controller 親量）：gate exit 1／**435 rows／2 NEW**（`RedactedError`／`Rule`；`currentDiagnostics` 已清除）；CLI **283 passed／1 skipped**；`session-executor` **136/136**（隔離跑，結掉 workspace 第二跑的 flake ⚠——測試檔 diff 為空）；typecheck 67/0。

**複審（opus）**：✅ Spec compliant／Approved，0 Critical／0 Important；**44/44 訊息逐位元組 0 不符**（24 單行＋14 多行＋6 縫＋1 折疊，算術閉合）；7 Minor（Minor 1 已 fold、其餘 6 條入 §7）。

---

## 2. T7 — 收尾（**已完成**）

**本節是 T7 的最終記錄，取代原本那張「未完成的部分」表。** 那張表上的每一項都在下面結掉，或指名仍開著的是什麼。

### 2.1 跑了什麼、讀到什麼

**指令：** `pnpm verify:all`（＝ `node scripts/verify-all.mjs`；五步）。**跑兩次**，兩次都在 `f307cdb` 的樹上，差別只有 allowlist 的那兩筆（§2.2）：

| # | 時點 | exit | 五步讀數 |
|---|---|---|---|
| ① | **加 allowlist 之前** | **1** | 1/5 suite **exit 1 · 2888 passed／9 skipped／1 failed**（67/67 專案都回報；`FAILED: packages/session-executor`）· 2/5 population **✓ 67／67** · 3/5 typecheck **exit 0** · 4/5 e2e **exit 0**（5 檔）· 5/5 gate **exit 1 · 435 rows · 2 NEW**（`#RedactedError`、`#Rule`，兩列都在 `packages/diagnostics/src/index.ts`） |
| ② | **加 allowlist 之後** | **0** | 1/5 suite **exit 0 · 2889 passed／9 skipped／0 failed**（67/67）· 2/5 population **✓ 67／67** · 3/5 typecheck **exit 0** · 4/5 e2e **exit 0**（5 檔）· 5/5 gate **exit 0 · 435 rows · `PASS -- no new rows`** |

**① 的那 1 個 failed 是負載 flake，不是回歸 —— 兩邊都量了：** 平行跑紅的是 `packages/session-executor` 的 `test/shell-promotion.test.ts` › *FALSIFICATION: a threshold ABOVE the deadline never fires — the command dies, and dies branded as a timeout*，**30011 ms 撞 30000 ms 的死線**。把它**單獨跑**（`pnpm --filter @i-harness/session-executor test`）＝ **136 passed／136（20 檔）、exit 0、9.08 s**；而在**② 的第二次全套平行跑裡它自己就綠了**。**「既有、不追」的證據是我自己的隔離跑**（上面那個 136/136），**不是引自 §7**：§7 T5⑧ 量到的 reds 是 `cli.test.ts` 的 entry-point spawn 與 `hooks-mount.test.ts` 的 hook timeout，**不是這一條** —— 「已量測、既有、不追」是我對那次量測的**概述**，兩者站點不同。**⇒ 這條紅與 W6 的改動無關，且沒有被追。** 兩次跑都**沒有**出現 `apps/cli` 的紅。

### 2.2 allowlist 的兩筆（**一列一筆**，各是一則有日期的裁定）

`scripts/audit/reachability-allowlist.json` 的 `entries` 由 **31 筆增為 33 筆**（diff 為 `+12` 行、純新增；worktree 維持該檔自己的 **CRLF／無 BOM** 慣例，commit 的 blob 仍為 LF —— 與該檔 `note` 記載的規則一致）：

| key | 為什麼這是誠實的裁定 |
|---|---|
| `unused-export\t@i-harness/diagnostics#RedactedError` | **儀器盲區，不是孤兒。** 型別**確實被到達**：`fromError` 拿它在回傳型別（`packages/diagnostics/src/record.ts:87`）、在 `:92` 建構它，`DiagnosticRecord.err?` 也用它（`:107`）。這列存在是因為掃描器自己的 class-1 盲區 —— `withoutReExportStatements` 把每個 `export … from` 語句**塗白**再掃（`scripts/audit/check-reachability.mjs:365-372`，套用點 `:416`），而這個名字在**入口檔裡的唯一提及正好就是**那句話（`packages/diagnostics/src/index.ts:25`）；那也正是這列的第三欄寫**入口**（`src/index.ts`）而不是宣告檔（`src/record.ts`）的原因。**要讓它消失：** 有 repo 內的檔案按名字 import 它，或修掉那個盲區（M1 的 R-L／M2 Task 4 刻意不修 —— 兩者都會動 row set、digest 與已發布的精度樣本） |
| `unused-export\t@i-harness/diagnostics#Rule` | **有文件記載的擴充縫，本單元沒有消費者。** `Rule`（`packages/diagnostics/src/redactor.ts:81`）就是 `createRedactor` 自己那個公開選項 `extraRules?: readonly Rule[]` 的形狀（`:240`，在 `:249` 加成式併入）；**真正傳 `extraRules` 的呼叫端全部是測試**（`packages/diagnostics/test/redactor.test.ts:259,272,289,290`）—— 生產檔一個都沒傳（`grep -rn "extraRules" packages/*/src apps/*/src` 在 `packages/diagnostics` **之外零命中**），而建 redactor 的 CLI bootstrap（`apps/cli/src/diagnostics-bootstrap.ts`）只註冊秘密、不傳規則。**R7 預告的就是這一列**，量出來的答案是「T4 用不上」。**要讓它消失：** 一個生產的 `extraRules` 呼叫端 —— 那是縫按設計工作，不是修復 |

### 2.3 記錄更正（每一條都**重量過才寫**）

| 檔案 | 改了什麼 | 背後的重測 |
|---|---|---|
| `docs/handoff/2026-09-20-queued-work.md` | **§6** 的普查句（`:535`；該列講的是「本地結構化診斷日誌」）與 **§9.2** 的 **A2** row（`:934`）：刪掉舊的「110」（以及 A2 格的 58／52）與過渡期的「107 ＝ 102 分級 ＋ 5 列名例外」，改成**可重現的指令**＋**舊指令壞在哪**＋**兩個修訂上的原始讀數**＋**最終切分 107 ＝ 94 分級 ＋ 13 列名例外** | §2.4（同一條指令在 `e78bad3`／`f307cdb` 上各跑一次）；`§6`／`§9.2` 兩個節號是 `grep -n "^## "` 對著改完的檔案量的 |
| 同上 | §1 的 **W6** row（`:64`）與 A2 row（`:934`）→ **✅ 完成**，附提交區間、計畫與**終態記錄檔名** | `git grep -n w6-diagnostics-partial` 在改名前只命中 `:64`／`:934` 兩行（該檔名在本樹只有這兩個 tracked 引用），兩行已一併改指新檔名 |
| `docs/superpowers/specs/2026-09-17-m3-measurement-foundation-design.md` | §3.3 加 dated 註記（`bin.test.ts:69` 已漂成 timeout 行）；§3.5 加 dated 註記（`provider-runtime.ts:24-26` 今天是「空行 ＋ `roleModelOptionsFor` 註解的開頭」，而那個 store **一直在回傳**：型別 `:50`、物件 `:63`、建構 `:58`） | 兩者都是**引用漂移**、不是本單元造成的：`git log --oneline ec18c9d0^..HEAD -- apps/cli/src/provider-runtime.ts` **為空**（W6 的整個區間一個字沒動它），而 `:50` 在 W6 的起點 `e78bad3` 逐字相同 |
| 本文件 | `git mv` 由 `2026-09-22-w6-diagnostics-partial.md` → `2026-09-22-w6-diagnostics.md`；標題不再是「進行中」；§0 補「最終驗證」列；§2 由「未完成」改成這份 T7 記錄；§8 改成終態 | **改名前** `git grep -n w6-diagnostics-partial` 命中**兩行**（queue doc 的 `:64`／`:934` —— 該檔名在本樹全部的 tracked 引用），兩行已一併改指新名；**改名後**同一條指令只剩**本文件的這兩行**（`git grep -c` ＝ **2**），而它們是**對這次改名的記述**、不是指向舊路徑的引用 |

### 2.4 普查：指令、舊指令壞在哪、最終切分

**會重現的指令**（計畫 §0.1 的兩式；`-F` ＋ 兩個 `-e`，不是 BRE 的 `\|`）：

```bash
grep -rn -F -e "console.warn(" -e "console.error(" packages/*/src apps/*/src --include=*.ts | grep -v "\.test\.\|/test/"
```

**舊指令壞在哪（機制於 2026-09-22 複審更正、T7 已實測）：** queued doc 原本寫的 `grep -rn "console\.(warn\|error)"` **不是**「在 BRE 裡把 `(warn\|error)` 當字面量」—— **GNU BRE 認得 `\|` 這個交替**（GNU 擴充），而 `(`／`)` 在 BRE 裡**是**字面量。所以那條模式的兩支是**字面字串 `console.(warn`** 與**字面字串 `error)`**；第一支在真碼裡不存在（真實呼叫是 `console.warn(`，括號在 `warn` **之前**），於是**整個模式退化成「含有 `error)` 的行」的比對**。**這也解釋了數字本身**（實測，GNU grep 3.0）：在 `e78bad3` 與 `f307cdb` 都命中 **152 行**，**這 152 行全部**是靠 `error)` 那一支中的（`… | grep -c "error)"` ＝ 152／152），而其中只有 **12 行落在普查的 108 行裡**（＝**兩個指令的交集**，量於 `e78bad3`），**這 12 行裡又有 1 行是註解** —— `apps/cli/src/run.ts:236`，正是下面扣掉的那一行 ⇒ **真的呼叫是 11 條**；**不是呼叫的行因此是 141 條**（140 行落在普查範圍外 ＋ 那 1 行註解）。**⇒ 舊記錄的「140 條不是呼叫」差一。**（`f307cdb` 的交集只剩 **2 行**，其中同樣含那條註解 ⇒ 真的呼叫 1 條。）**兩個方向都錯：** 它數進一堆不是呼叫的東西（`} catch (error) {`、含 `error)` 的註解…），又漏掉每一個引數不是單字 `error` 的真實呼叫 —— `console.error(USAGE)`（`error(` 之後不是 `)`）以及整個 argv 驗證區塊。所以「110」既不是站點數、也不是任何東西的數。

**兩個修訂上的讀數**（同一個指令，T7 親量、無截斷）：

- 在 W6 的起點 **`e78bad3`**：**108 行／34 檔**（`console.warn(` **51**、`console.error(` **57**），扣掉 `apps/cli/src/run.ts:236` 那**一條註解**（同一條在 `f307cdb` 位於 `:246`）⇒ **107 個可執行站點**。逐檔分佈（`cut -d: -f1 | sort | uniq -c` 實測）：`apps/cli` **61 行／8 檔** ＝ 60 站 ＋ 那條註解（index 23／provider 11／**run 7**／roles 5／models 5／hooks 5／plugins 3／sessions 2）、**16 個 package 目錄 47 行**（session-executor 13、plugin-registry 8、mcp-client 8、telemetry／subagent／sdk／rewind／hooks **各 2**、另 8 個**各 1**；16 = 3 ＋ 5 ＋ 8）。**單位注意：** 這裡的逐檔數字是**行數**；計畫 §0.1 的同一份清單寫的是**站數**（所以它寫 `run 6`，差別就是 `run.ts` 那條註解），而兩邊的 `apps/cli` 總數、`16`、`47` 三個數逐字相同。
- 在 **`f307cdb`**（遷移後）：**23 行** ＝ **13 個列名例外** ＋ **9 行機制**（6 個縫的 fallback ＋ `packages/diagnostics/src/index.ts:116/139/140` 的委派與內部報告）＋ **1 條註解**。**94 個分級站點已經不在這條指令的視野裡 —— 因為它們已經走 logger。** ⇒ 這條指令是**普查**指令，只在遷移前的樹上讀得出母體；**它從來不是驗收指令**（驗收是 §2.1 的 `pnpm verify:all`）。

**最終切分：** 全樹 **107 站 ＝ 94 分級 ＋ 13 列名例外**（`apps/cli` **50＋10**；packages **44＋3**）。那 13 條例外（全部 byte-untouched）＝ `apps/cli` 的 `hooks.ts:161`／`index.ts:194`／`models.ts:348`／`models.ts:364`／`plugins.ts:443`／`provider.ts:227`／`provider.ts:254`／`roles.ts:241`／`roles.ts:295`／`run.ts:776` ＋ packages 的 `session-persistence/src/index.ts:251`／`telemetry/src/telemetry.ts:11`／`:13`。

### 2.5 交出去的八件事（**T7 一條都沒修**）

以下每一件都仍然開著，**原樣交給最終複審 triage**：

1. **儀器盲區的實例** —— §5（三則記述；第三則本身是兩次重現）。§2.2 那筆 `#RedactedError` 就是第 2 則的落地。
2. **R5 的 named residual** —— `\bBearer\s+\S+` 對散文過度遮蔽；代價已寫在 `redactor.ts:49-53`，規則大小寫敏感（§3 R5）。
3. **T4 的 shutdown 記帳一行** —— `uncaughtException`／`unhandledRejection` 的 `process.exit(1)` **繞過新的 `finally`**（既有；兩個 sink 皆 flush-free，今日無害）—— §3.6 的 fail-loud 記帳要有一行（§7 T4⑥）。**位置 T7 重測：`apps/cli/src/index.ts:61-66`**（`:61-62` 是理由註解、`:63` 是那個 `for (const event of ["uncaughtException", "unhandledRejection"])`、`:66` 是 `process.exit(1)`）—— **§7 T4⑥ 記的 `:48-53` 已漂**（今天那幾行是三個 `diagnosticsFor` handle 的宣告），**引用以本行為準**。
4. **census 精度** —— ①**六行縫 fallback 是普查的可見子群**（**以下都算「行」**：計畫 T6 的 §0.3 縫清單列了 8 個位置，T6 遷移掉其中 6 個、留下 **3 行**當例外（`session-persistence:251` ＋ `telemetry:11,13`）；所以**遷移後的 packages 側重跑那條指令讀到 12 行** ＝ 6 ＋ `packages/diagnostics` 自己的 3 ＋ 3，**不是 6**）。②`packages/mcp-client/src/oauth.ts:233` 的 **`console.info` 在普查之外**（普查只數 warn／error）—— `grep -rn "console\.info" packages/*/src apps/*/src --include=*.ts` 在 `f307cdb` 命中 **3 行**，扣掉 `packages/diagnostics/src/index.ts:138`（委派的 info 通道）與 `packages/mcp-client/src/types.ts:31`（一句註解）⇒ **普查之外的生產站點是 1 個**。
5. **`record.err` 沒有站點級的寫者** —— API 收第三參數（§3 R3），**44 個 packages 站點全部只傳 `msg`**，而多個站點手上就有 caught value。**⇒ 本記錄不得被讀成「`record.err` 被生產路徑填過」。**
6. **六個可翻的相位** —— `schedule→session`、`subagent/child→run`、`subagent/tools→session`、`compaction→turn`、`plugin-registry/state→mount`、`output-retention→mount`；**沒有測試斷言相位**，所以翻動不會紅。`telemetry` 與 `acp` 兩個 union 成員**零站點**。
   **▶ 已收線（M79，2026-09-24）：六個相位有五個已有相位斷言，兩個零站點的 union 成員已被移除** —— 斷言在 `packages/schedule/test/site-diagnostics.test.ts:82`（`schedule→session`）、`packages/subagent/test/site-diagnostics.test.ts:77`（`subagent/child→run`）、`packages/compaction/test/site-diagnostics.test.ts:80`（`compaction→turn`）、`packages/plugin-registry/test/site-diagnostics.test.ts:84`（`plugin-registry/state→mount`）、`packages/output-retention/test/site-diagnostics.test.ts:81`（`output-retention→mount`）；**餘一 `subagent/tools→session` 仍是那條「量過但驅不動」的**（`packages/subagent/src/tools.ts` 的 `d.warn`，今天在 `:829`、`diagnosticsFor("session")` 在 `:28`；M71 的 R15 收線列寫的 `:787` 是當時的行號、今天已漂 42 行）。`telemetry`／`acp` 的存在性由 M79 判定為零生產者、**移除**而非接線（`packages/diagnostics/src/record.ts:35-38`，`a629acd`）。**本條的收線判讀在 `docs/handoff/2026-09-24-m80-backend-readiness.md`（M80）。**
7. **縫的覆蓋缺口** —— `schedule/driver.ts:106` 與 `workflow/registry.ts:31` 的預設體**無測試行使**；`hooks`／`skills` 行使了但**不斷言**；`plugin-registry/state.ts:74`／`credentials:243` 只有 `toHaveBeenCalled()`；而且**沒有任何 package 測試 install 實例** ⇒ **安裝模式的站點全無守衛**（與 T5 的 M1 同類，具名揭露）。
8. **§7 的 deferred minors 整份 —— 指向最終複審 triage。** T7 沒有一條進修復迴圈。

**§7 自己指名「T7 的記錄要說」的三條，在這裡說：**

- **T4 的測試改寫是五條案例，不是四條**（§7 T5⑥，T5 複審的重量）—— R10 的**授權文字**寫「四條」，實際改寫的是 **5** 個；第 5 條是 **SUCCESS 出口**，它用的是 `console.log`、**不是遷移通道**，所以它落在 R10 的原始範圍之外，但捕捉點跟著同一套機制一起改了。
- **SUCCESS 出口的捕捉點變窄，不是嚴格等價**（§7 T5④）—— 捕捉改成「工廠回傳後立刻讀 `currentDiagnostics()`」之後，四條性質逐條保留、case ① 反而變強（多一條 `toHaveLength(1)`），但 SUCCESS 出口那條**可觀察的範圍比原本窄**。
- **「50 站走 handle」≠「50 站寫記錄」**（§7 T5⑦）—— 實例只在三條路徑 install（`apps/cli/src/index.ts:477`／`:585`／`:835` 的 `createCliDiagnostics()`），其餘命令在 `=stderr` 下仍委派 console。**這是計畫的契約，不是缺口**（§1 T5 的 ⚠）。

**還有一條精度的警語：`durMs` 在 W6 沒有生產者** —— §7 T1 的 concern；**本記錄不暗示它被填過**。

### 2.6 未完成的部分

**沒有。** 七個任務全部落地，最終 `pnpm verify:all` 五步全綠（§2.1）。仍然開著的是 §2.5 的**已具名殘餘**與 §7 的 **deferred minors** —— 兩者都**已交給最終複審 triage**，判定見 §2.7（**safe-to-leave**，不是未完成的任務）。

### 2.7 最終整支複審（**本單元的收尾判定**）

**範圍與裁決：** `e78bad3`…`95fe4c9`（**50 個提交** —— 從計畫那一筆到 T7 的最後一筆，也就是整支 W6）。**opus，分九輪讀完。** 裁決：**Ready to merge? Yes** —— **0 Critical、2 Important、約 12 Minor**；而**每一條 deferred minor 都被 triage 為 safe-to-leave**（§7 因此結案：那裡「不修」是**複審的判定**，不是 T7 的省略）。

**它的依據（複審自己重跑的，不是複述本文件）：** 每一條它能測的 binding constraint 都成立；**普查與 allowlist 的數字被獨立重現**。

**兩條被 park 的 Important（控制器裁定；編號續 §3 的 R 系列）：**

- **R14 —— 掃描①（鍵名）不認複數鍵名**（`apiKeys`／`tokens`／`secrets`）。**Park，不是修**，三個理由：①**今天沒有任何站點傳 `data`**（§2.5 第 5 點），所以這條缺口沒有可被利用的路徑；②修法要與**過度遮蔽**對賭（`tokens: 1234`、`keys` 這種正常鍵名會被吃掉）；③**已註冊的值仍由第③趟按值擋住**。**⇒ 它是「下一個單元裡第一個傳 `data` 的站點」落地時要先修的東西**，不是「有空再修」。**若錯的代價：** 那第一個站點傳進去的複數鍵名下的秘密不被鍵名遮蔽（值仍可能被第③趟擋住）。 **▶ 2026-09-22 已收線（`m71`）** —— 提交 `4ea43624`（實作）＋ `9678d773`（註解修）：**第二份清單 `PLURAL_KEY_STEMS`**（`packages/diagnostics/src/redactor.ts:153`，`endsWith(stem + "s")`，**不剝尾 `s`** —— 剝法會讓 `maxTokens` 中，而被釘住的負面案例量到了）；只收不能碰撞的詞幹（`tokens`／`cookies`／`auths`／`authorizations`／`bearers`／裸 `keys` 維持排除，理由在 `redactor.ts:138-146`）。**真正的缺口是粒度**（無形狀的葉子：`apiKeys: { openai: "abc123def" }`）。**代價被釘在測試**：`packages/diagnostics/test/redactor.test.ts:112` 斷言 `{ secrets: 42 }` → `TOKEN`；flag 形狀的加寬（`noSecrets: true`／`hasCredentials: false`）也量過、接受並記在 `redactor.ts:129-136`。**記錄：`docs/handoff/2026-09-22-m71-residuals.md`。**
- **R15 —— 沒有任何 package 測試 install 實例 ⇒ 44 個 package 站點的「已安裝」分支無守衛**（§2.5 第 7 點的另一面，量過的）。**Park。** **最便宜的守衛＝一個捕捉型實例的測試，斷言 `phase` ＋ `level`**。**若錯的代價：** 已安裝模式的路徑在 packages 側一直沒有回歸網，相位或級別被翻掉不會紅（§2.5 第 6 點）。 **▶ 2026-09-22 已收線（`m71`）** —— **十個站點／九個套件，各一條新檔**（`8188dab0`…`0c47bd46`，九個提交，**+849／−0**，既有測試零改動）：**六個縫**（`credentials:247`／`hooks:363`／`plugin-registry/state:78`／`schedule/driver:112`／`skills/registry:123`／`workflow/registry:37`）＋**四個 ambient handle**（`plugin-registry/agents:112`／`subagent/child:85`／`compaction:169`／`output-retention/spill-guard:257`）；每一條斷言 `phase` ＋ `level`（六個 `mount` 站斷言 `level === "warn"`；**10／12 條也斷言 `run`** —— 例外是 `plugin-registry` 的 `loadStateSync` 案 `:104` 與 `schedule` 的 delivery-failure 案 `:107`）。**突變證明有對照**：翻 `state.ts` 的 phase 時既有套件 **175 passed／0 red**、翻 `skills/registry.ts` 的 level 時 **59 passed／0 red**（後者重現了 §2.7 建議 3 引的 T5 的 M1 讀數：翻 `warn`→`error` 紅 0 條），net 放回後各自轉紅 **2** 條／**1** 條，回退 sha 驗證。**覆蓋帳（2026-09-22 逐條重量）：已覆蓋 10／44；其餘 34 未覆蓋** —— 44 ＝ 38 個 handle 站點 ＋ 6 個縫（兩個 grep 各自的讀數）；**未覆蓋的是 34 個，不是三個**：`packages/subagent/src/tools.ts:787`（**唯一**「量過但驅不動」的）＋ 33 個沒驅動的（其中兩個便宜的同形狀站點 `plugin-registry/src/commands.ts:76`、`hooks/src/trust.ts:87`；其餘在 `sdk`、`core-plugin`、`mcp-client`、`plugin-registry`、`session-executor`、`rewind`）。**逐檔清單（含行號）已進 tracked 記錄**（原先只住在 gitignored 的 ledger）。**記錄：`docs/handoff/2026-09-22-m71-residuals.md`（§6 第 1–2 條）。**

**複審對下一個單元的建議（原樣記下）：**

1. **R14 的複數詞幹修法與 R15 的那個捕捉型測試一起做** —— 兩者是同一個「`data` 一開始被傳」的時刻的兩面。
2. **把 caught value 交給 `err`，不要自己插值 `error.message`**（§2.5 第 5 點的正面用法：`record.err` 的寫者已經在 API 上，只是沒有站點用它）。
3. 給**五條 `mount` warn** 補一條 **`level === "warn"`** 斷言（§2.5 第 7 點；T5 的 M1 實測「翻 `warn`→`error` 紅 0 條」）。
4. **`installDiagnostics` 在第二個「同進程宿主」出現時會靜默取代活著的實例** —— 那個需求真的出現時，這條要先被推翻（與 §「風險張力」／計畫 Self-review 的那條同一條）。

---

## 3. Rulings（全部；每條附「若錯的代價」）

**⚠ R14／R15 是 T1–T6 之後才出現的兩條（最終整支複審 park 的 Important），記在 §2.7** —— 本節保留 T1–T6 那 13 條的原文不動。（**兩條都已在 2026-09-22 由 `m71` 收線；各自的收線註在 §2.7 該條末**，記錄：`docs/handoff/2026-09-22-m71-residuals.md`。）

- **R1（T1 複審，2026-09-22）**：`index.ts:178` help（exit 0）、`models.ts:343`、`roles.ts:287`、`provider.ts:222`、`run.ts:752` 五站**維持原樣、列名不遷移** —— T1 的 API 讓通道＝級別，「info 級、通道 stderr」不可表達，而四個既有斷言釘著它們。**代價（明說）**：這五個 argv/notice 站點沒有結構化記錄。計畫 §0.3 與 T5 表已就地更正（`364e7cd3`）。
- **R2（T2 派工前）**：T2 紅測試的 redactor 用**測試內 double**（`/sk-live-[A-Za-z0-9]+/` → 恰好 `[REDACTED]`）。**代價**：T3 落地後一行換真工廠 ⇒ **已由 T3 履行**（`99c287e`，複審確認強化）。
- **R3（T2 進行中）**：**`record.err` 的寫者** —— 四級擴為 `(msg, data?, err?: unknown)`，衍生在 logger 邊界內（唯一寫者），`delegate` 不動。**代價**：介面多一個可選參數（T5/T6 的遷移形狀不變）。
- **R4（T2 複審的 ⚠）**：**殘餘聲明落在 T3 的 redactor 文件** ⇒ **已由 T3 履行**（`redactor.ts:1-13`）。
- **R5（T3 複審，plan-mandated）**：**維持 §3.5 逐字的 `\bBearer\s+\S+`，不改** —— 少遮蔽＝活憑證外洩、多遮蔽＝一句散文少一個字；代價已寫在 `redactor.ts:49-53`，規則大小寫敏感。**Park**。**若錯的代價**：JSONL 裡一句大寫「Bearer <word>」讀起來是 `Bearer [REDACTED]`（T7 要列為 named residual）。
- **R6（T3 複審）**：散文內嵌 `api_key=…` **不補規則** —— §3.5 的鍵名掃描是對物件鍵；真值由 T4 的 `registerSecret` 覆蓋；`m3-diagnostics-redaction-design.md` 查過，只有 M65 已刪的 TUI redactor 描述，無 §3.5 之外的內嵌規則。**若錯的代價**：散文裡 `name=` 形式的秘密不被遮蔽（§3.5 既有殘餘方向）。
- **R7（T3 複審）**：`#Rule` 的 gate row —— mid-plan 預期；T4 若用得上就清掉，否則 T7 加逐列 allowlist（`reason`＋`dated`）。**若錯的代價**：一條無消費者的 export 需要一列 allowlist，別無他害。
- **R8（owner 2026-09-22，遷移裁定）**：`.superpowers/` **維持 gitignored、靠複製遷移**（量過：11 MB／301 檔，其中 80 個 review diff 可由 `scripts/review-package` 重生）。**若錯的代價**：每次換機都要記得帶那份資料夾。
- **R9（T5 派工前）**：計畫 T5 表第 1 列的「`index.ts:178` 的 help **例外：`info`**」是 edit 殘留、與 §0.3 的 R1 矛盾 ⇒ **五個列名例外維持不遷移**；括號以 dated 註記更正。**親量**：`index.ts` 的兩個 `console.error(USAGE)`——exit-0 help 的那個不遷移，argv 錯誤路徑的那個**要遷移**。**若錯的代價**：一個 argv 錯誤路徑少一條結構化記錄。
- **R10（T5 進行中）**：`index.ts` 的 **run 失敗報告要遷移**（level `error`、phase `run`）——障礙只是測試儀器（T4 的案例拿未遷移站點的 console 呼叫當鉤子）；**T4 的四條案例以獨立提交改寫捕捉機制，性質斷言一字不減**。**若錯的代價**：T4 的證據重新推導（複審已驗性質保留，且 case ① 變強）。
- **R11（T5 進行中）**：**五個未被命名的 exit-0 help 列印回復不遷移** —— 與 R1 同類（API 無法表達「info 級、stderr 通道」；給 `error` 級是讓記錄說謊；我親量 `models.ts:361`／`roles.ts:238`／`provider.ts:251` 後接 `return 0`）。**例外清單成為十**；普查 **107 → 97 分級 ＋ 10 例外**。**若錯的代價**：五個 help 列印沒有結構化記錄（本來也不該有 error 級）。
- **R12（T6 派工前）**：計畫 Global Constraints 寫「**不動** `packages/credentials`」，而 T6 的 Files 與 §0.3 的縫清單都列 `credentials:239` ⇒ 裁定**那一行在範圍內**（縫的**預設值**；那條約束的意圖是「不要在那個套件裡解憑證解析問題」）。**若錯的代價**：一行可回退。
- **R13（T6 派工前）**：多參數站——`delegate` 只送單一參數、`util.format` 對非字串第二參數用 `inspect` ⇒ 折疊**不能保證**逐位元組。**第二參數是字串者**可折疊（`compaction/src/index.ts:158`，複審以 `util.format` 語義證明等價）；**第二參數是 `unknown` 者不遷移**（`session-persistence:251`、`telemetry:11,13`，三個站列為例外）。**若錯的代價**：三個 warn 站沒有結構化記錄；例外數 10 → 13。

---

## 4. 量到的數字（附指令與修訂）

- `pnpm --filter @i-harness/diagnostics test` → **46/46**（3 檔）at `7c78589`；typecheck exit 0。（T1 的 17／T2 的 27 是同一條曲線上的中途讀數。）
- `pnpm --filter @i-harness/cli test` → **283 passed／1 skipped／0 failed**（25 檔）at `4b622fd`（前置基線 265 passed＋1 skipped；＋18 新案例、＋1 檔）。
- `node scripts/audit/check-reachability.mjs --gate` at `6c47681`（**controller 親量**）→ **exit 1、435 rows、2 NEW rows**（`RedactedError`／`Rule`）。逐輪清除：T4 清 `createDiagnostics`／`createRedactor`／`installDiagnostics`；T5 清 `diagnosticsFor`；T6 由六個縫檔的**真 import** 清 `currentDiagnostics`。**當時的紀律是「T7 之前不得加 allowlist」** —— T7 已履行：兩列各以一筆 dated 裁定結掉（§2.2），其餘沒有任何 allowlist 動過（`Rule` 無消費者、`RedactedError` 黏著，§5）。
- `pnpm --filter @i-harness/cli test` at `6c47681` → **283 passed／1 skipped**（T5 的警報未響）；`pnpm --filter @i-harness/session-executor test` → **136/136**（隔離跑；結掉 workspace 第二跑的 flake ⚠）。workspace 兩跑＝67/0 與 66/1（後者是負載 flake，非回歸）。
- 母體（帶 `test` script 的 workspace 目錄）：**67**（66 → 67，T1 實測）。
- 全樹閘門 `pnpm verify:all`：本單元的中途紅在 7 → 4 → 3 → 2 NEW rows 上（上面逐輪清除），**T7 是它轉綠的時點** —— 加上 §2.2 的兩筆 allowlist 後，於 `f307cdb` 讀到 **exit 0／五步全綠／`--gate PASS -- no new rows`**（完整五步讀數、含加 allowlist **之前**的那次失敗，見 §2.1）。再之前的最後一次全綠在 `a955c4d1`（M6，母體 66、433 rows）。

---

## 5. 儀器盲區的實例（**已記進 T7 的記錄**；§2.2 的 `#RedactedError` 那筆就是下面第 2 則的落地）

`check-reachability.mjs` 的「這個名字被用了嗎」是**對生產檔的文字比對** ⇒ **正在解釋這個危險的註解本身會讓 row 消失**。本單元量到三例：

1. **`@i-harness/diagnostics#Diagnostics` 沒有 row**：裸詞出現在 `packages/rewind/src/types.ts:141` 的註解（class-1 遮蔽）。
2. **`#RedactedError` 的 row 黏著**：唯一入口提及在 re-export 語句內（被 `withoutReExportStatements` 清掉），宣告檔是 `src/record.ts`。
3. **T2 期間 A/B 重現兩次**：新註解寫了 `RedactedError`／`fromError` ⇒ row 當場消失；改寫措辭後回來。

**教訓**：`--gate` 的讀數要在**每次改動註解之後**重量。「數字下降」永遠要先問是不是遮蔽。

---

## 6. 環境與紀律（fresh clone 也要知道的）

- 本機 `bash` 是 **WSL**（沒有 node 在 PATH）；`pnpm`／`node`／`git` 直接呼叫。**CRLF 陷阱**：worktree 混合、blobs 是 LF；判斷 blob 用 plumbing（`git cat-file blob`），不要用 `git show`／`git diff`。
- **不 amend 任何已回報的提交**；**提交訊息不加 attribution trailer**；**push 只到里程碑分支**。
- **紅先測試 ＋ 變異證明**（roadmap §1.7）；引用先量；普查要報命中數與是否截斷。
- `pnpm -r --no-bail test` 單獨跑**不是**閘門（有紅時只跑一個前綴）；閘門是 `pnpm verify:all`（五步）。

---

## 7. Deferred minors（**已由最終整支複審 triage：全部 safe-to-leave**，§2.7；都不入修復迴圈，**T7 一條都沒修**）

- **T1**：④ double install/uninstall、`stream` 勝 env 未測（deferred）。**concern**：`durMs` **在 W6 沒有生產者** —— T7 的記錄不要暗示它被填。
- **T2**：①`src/index.ts:29` 的 `fromError` 公開 re-export 無套件外消費者（一行可撤）②no-err-key 案例只釘 wire shape（`rec.err = undefined` 會穿過 `JSON.stringify`）③`[REDACTED]` token 的 double 斷言 ⇒ **已由 T3 履行**（`99c287e`）（保留此列僅為記錄）④非 Error 的 `name = typeof err`（語意選擇）。
- **T3**：①base64 的鍵名 fence 比 §3.5 的「看起來像秘密」寬（`includes` 詞幹，`author`／`passengers` 也中；dead-code 論證支持現狀）②`toJSON` 回傳自身時 UNSCANNED（`redactor.ts:284`；罕見形狀，一行可修）③衍生副本邊角（symbol 鍵被丟、`apiKey: undefined` 變成 `"[REDACTED]"`）④循環引用只在報告、未寫進模組文件（結果同為 throw，非回歸）⑤洩漏 payload 缺 scan-① 樣本（專屬案例仍抓得到）⑥規則順序案例的 fixture 其實不重疊（合併由同案例的 `Bearer sk-live-…` 斷言釘住）。
- **T4**：①`env` 只當掃描來源、目的地由 `process.env` ⇒ **命名誤導**（建議 T5 時改 `secretEnv` 或明說；無生產呼叫端傳 `env`）②resume 出口測試只 `toContain("i-harness run did not finish")`，**兩個出口共用該字串** ⇒ 未來漂移會讓兩案塌成一案仍綠（修法：斷言錯誤指名缺失的 session）③sdk/acp 的 install→teardown 拋出窗可 `try/catch` 化（順帶關掉既有 `coordinator` 的同形洩漏）④`MIN_SECRET_LENGTH` 副本無測試（要求本身由 redactor 釘住）⑤M11 惰性分支（複審判為**正確保留**：close 後 handle 不碰 redactor）⑥`uncaughtException`／`unhandledRejection` 的 `process.exit(1)`（`index.ts:48-53`，**既有**）繞過新 `finally` ⇒ **T7／§3.6 的 shutdown 記帳要有一行**（兩個 sink 皆 flush-free，今日無害）。
- **T5**：①（**已 fold**）`test/diagnostics-bootstrap.test.ts` 的過時註解（「un-migrated report」）②（**已 fold**）計畫 §0.3 的 phase 範例加「縫優先於檔」dated 註記 ③**五個 `mount` warn 的通道無測試釘住**（M1 實測：翻 `warn`→`error` 紅 0 條；T7 的指名動作＝在某個以 sink 驅動 plugin mount 的測試加一條 `level === "warn"`）④SUCCESS 出口的捕捉點變窄（T7 記錄要說，不是嚴格等價）⑤報告 §8.2 的「（無測試斷言 phase）」括號寫錯（case ② 就斷言了 `phase: "run"`）⑥R10 授權「四條」、實際改寫五條（SUCCESS 用 `console.log`，非遷移通道；T7 記錄要說**五**）⑦T7 記錄精度：「50 站走 handle」**≠**「50 站寫記錄」（只有 `index.ts:477/585/835` 三條路徑 install）⑧**load-flake：已量測（2026-09-22，3×BASE `52ef045` ＋ 3×HEAD `f45d0a5`，序列跑）**——**BASE 自己 2/3 紅**（`cli.test.ts` 的 entry-point spawn 測試 5s timeout ×2、`hooks-mount.test.ts` 的 1000ms hook timeout ×1），**HEAD 3/3 全綠**；而報告點名的 **M12 shell-retry 6/6 全過**（520–738ms）⇒ 套件的 flake **是既有的**，但**歸因到 M12 未被證實**（量到的紅是另外兩條負載敏感案例）。唯一 skip 是平台閘的 Linux/bwrap。
⑨**commit body 精度**：`f45d0a5` 的訊息說「`turn` 的唯一出現是 `packages/diagnostics` 的註解」——**實測為假**（`record.ts:38` 是 union 成員＝程式碼；測試也用 `"turn"`）。**不 amend，改正往前帶（本列即為更正）**。
- **T6**：①（**已 fold**）plan:42 的「`turn` 無使用者」與 T6 的更正同日期 ⇒ 加 dated 指針（`6c47681`）②**縫的覆蓋**：`schedule/driver.ts:106` 與 `workflow/registry.ts:31` 的預設體**無測試行使**；`hooks`／`skills` 行使了但**不斷言**；`plugin-registry/state.ts:74`／`credentials:243` 只有 `toHaveBeenCalled()`；**沒有任何 package 測試 install 實例** ⇒ 安裝模式的站點全無守衛（T7 記）③`plugin-registry/state.ts:74` → `mount` 是六個相位裡最可翻的（state 是 config 形狀、`loadState` 不只掛載時跑；`config` 可辯）④相位盤點：union 的 `telemetry` 也是零站點，報告只點了 `acp` ⑤handle 擺放：`session-executor/src/service.ts:39` 夾在 import 之間、`plugin-registry/src/index.ts:71` 切開兩塊 import（合法、醜）⑥**遮蔽陷阱**：`mcp-client/src/bridge.ts:154-155` 的迴圈 `d` 與模組 handle 同名；`output-retention/src/spill-guard.ts:264` 的閉包區域 `d` 遮蔽 `:256` 的 handle（兩者都編譯得過，未來的編輯會誤讀）⑦註解重量：同一段 4–5 行 boilerplate 在 24 個檔重複（~120 行；與 house style 一致，但屬實的重量）。

---

## 8. 本文件沒有建立的事

- **`pnpm verify:all` 現在跑過了 —— 而且通過了：** **exit 0 · 2889 passed／9 skipped／0 failed · 67／67 專案 · typecheck exit 0 · e2e exit 0（5 檔）· `--gate` `PASS -- no new rows`**（§2.1）。**但它只證明「有多少東西跑了」，不證明那些測試有意義** —— `verify-all.mjs` 自己在輸出結尾就這麼說。**一次綠燈不等於「這個單元沒有缺陷」**，尤其它與本記錄是同一天、同一台機器量的。
- **T4–T7 的「注意」大多取自計畫與歷次裁定，不是 T7 的實作量測** —— 沿用原本的警語。T7 親量的是**它自己寫下來的每一個數字**（§2.1 的兩次 `verify:all`、§2.4 的兩次普查、§2.2 的 allowlist 兩列）；其餘仍要引用者自己量（**引用先量**）。
- **本文件沒有建立「殘餘已經清空」。** §2.5 的八件事、§3 的 R5、§7 的全部 deferred minors **仍然開著**，而且**故意**沒有在 T7 修 —— 它們是**最終複審的 triage**，不是遺漏。
- **本文件沒有建立「相位是對的」。** 六個相位**可翻而不會讓任何測試轉紅**（§2.5 第 6 點），而安裝模式的站點**全無守衛**（§2.5 第 7 點）。
- **`.superpowers/` 的 ledger、task brief／report、review diff 不在 git 裡** —— 若你在 fresh clone 上，這份文件就是全部的記錄面；task brief 可用 SDD skill 的 `scripts/task-brief <plan> <N>` 重新抽出。遷移包（2026-09-22 建立）另含 ledger 與 session transcripts，但那是**複製**、不是版控。
