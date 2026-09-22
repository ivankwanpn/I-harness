# W6 — 結構化診斷 ＋ redactor：**進行中**交接（T1–T2／7 完成）

**Written:** 2026-09-22，由接手前一個爆 context 的 controller session 的 session 寫下，依 owner 指示在 **T2 收線後停下**。
**Audience:** 續作 W6 的人（可能是 fresh clone、沒有本機 scratch 的工作電腦）。
**State measured at:** `4915350a` — 本文每一條 `path:line` 都在此修訂量過；**行號會腐，引用前先重量**（本 repo 的既有紀律）。

---

## 0. 先看五件事

| Fact | Value |
|---|---|
| Repo / remote | 原工作站 `D:\I-harness-main` ↔ `https://github.com/ivankwanpn/I-harness.git`（authoritative） |
| Branch | **`m68`**（本單元的里程碑分支；`main` 的合併時機由人決定） |
| HEAD / origin | `4915350a`；`origin/m68` 同步於 2026-09-22 的 push。**自重**：`git rev-parse HEAD origin/m68` |
| 本單元 | **W6**：建 `@i-harness/diagnostics`（`createDiagnostics` ＋ `createRedactor`），把 **107 個 `console.warn/error` 站點**分級上去 —— 而 **`I_HARNESS_LOG` 未設時 stderr 逐位元組不變** |
| 進度 | **T1 ✅ · T2 ✅ · T3–T7 ⬜**（7 任務；下表與 §1–§2） |

**設計依據**：spec `docs/superpowers/specs/2026-09-17-m3-measurement-foundation-design.md` **§3.3（`:177-193`）＋§3.5（`:215-235`）**；B1 裁定 **B**（owner 2026-09-22：「追求完整性，別人後面要修要改很麻煩」）。
**計畫**：`docs/superpowers/plans/2026-09-22-w6-diagnostics.md`（7 任務；**§0.1 的普查指令是唯一有效的量法**——舊的 `grep -rn "console\.(warn\|error)"` 在 BRE 裡是字面量，數到 152 條裡 140 條不是呼叫）。
**SDD ledger**：`.superpowers/sdd/2026-09-22-w6-diagnostics/`（`progress.md`＋task brief／report／review diff）—— **gitignored，不會隨 clone 過來**；本文自足，不依賴它。

---

## 1. 完成的部分

### T1 — 套件 ＋ `createDiagnostics`（含逐位元組不變的模式）

**Commits**：`ec18c9d0`（5 檔 +627，實作）· `0ae6f231`（fix fold：ambient memo、console-close 委派、空 env 三案）。
**檔案**：`packages/diagnostics/{package.json,tsconfig.json,src/index.ts,src/record.ts,test/diagnostics.test.ts}`。零依賴、腳手架照 `harness-home`。

**機制（複審通過的設計）**：

- **模式在構造時解析**：`opts.stream` 勝過 `process.env.I_HARNESS_LOG`；未設／空字串 ⇒ 無 sink ⇒ **委派 console**；`stderr` ⇒ 每次寫入時重讀 `process.stderr`；其他 ⇒ append 到該路徑（父目錄首次寫入時建立）。路徑 sink 失敗 ⇒ **`console.error` 報告一次後停用**（不轉投：console 是逐字通道、記錄是redact過的副本）。
- **逐位元組不變的機制**＝`delegate(level, msg)`：console 只收**單一逐字參數**；`data`／`err` 在此被丟棄（第二個參數會改變全部 95 處 spy 比對）。`level` **只過濾記錄**，永不改道、永不靜音 console 通道。
- **環境實例**：`installDiagnostics(d): () => void`（身分式卸載）· `currentDiagnostics()` · `diagnosticsFor(phase)`（**每次呼叫解析當前實例**——站點在模組層持 handle，import 時求值，快照會永遠是 `undefined`；每 (instance,phase) 一枚 memoized view）。
- **close 語意**：任何 handle 的 `close()` 關整個 instance 並自 ambient 槽卸下；**結構化實例 close 後不寫，console 模式 close 後仍委派**（T4 的 close 排序靠這條）。

**測量**（at `0ae6f231`）：`packages/diagnostics` **17/17**；typecheck exit 0；母體 **66 → 67**（`verify-all.mjs:49-50` 數帶 test script 的 workspace 目錄）。

**＋lockfile 的缺口（工作電腦 2026-09-22 實測，本提交補上）**：`ec18c9d0` 沒帶 `pnpm-lock.yaml`，而 pnpm **10.34.5** 的 `install --frozen-lockfile` **exit 0 但仍會把 `packages/diagnostics: {}` 這行 importer 寫回** ⇒ 「needed no change」只對**解析**為真，檔案本身會被補寫、每台機器的樹都留一個 dirty 檔。

### T2 — `RedactedError.fromError` ＋ **`record.err` 的寫者**

**Commits**：`1d20ef5b`（`fromError` ＋ 四 adapter 洩漏 fixture）· `4915350a`（controller 裁定的 API 擴充 ＋ 計畫 §0.3 的 dated ⚠ 更正）。

- `src/record.ts` — `fromError(err: unknown, redactor: Redactor): RedactedError`：`message` 與 `stack` **都**過 redactor（V8 的 stack 第一行就是 message，只 redact 一邊仍會把秘密寫進記錄）；`name` 保留不 redact；**不變異原物件**；非 Error 拋出物 ⇒ `String(err)`＋`name = typeof err`（沿用 `apps/cli/src/run.ts:253` 的 `failureReport` 慣例）。
- `src/index.ts` — 四級方法簽名擴為 **`(msg: string, data?: Record<string, unknown>, err?: unknown)`**；`toRecord` 內 **`err !== undefined ⇒ rec.err = fromError(err, inst.redactor)`**（`record.err` 的唯一寫者 ⇒ §3.5 強制力第 2 層在 API 邊界成立，不是靠慣例）；ambient 路徑轉發第三參數；**`delegate` 一字未動**。

**測量**（at `4915350a`）：`packages/diagnostics` **27/27**（`test/diagnostics.test.ts` 17 ＋ `test/record.test.ts` 10，2 檔）；typecheck exit 0；RED 先行（3 參數呼叫時 typecheck 紅 `Expected 1-2 arguments, but got 3`）；突變逐條（刪 `rec.err = …` ⇒ 紅衍生案例；無條件衍生 ⇒ 紅 no-err-key；ambient 把 data+err 轉給 console ⇒ 紅 4 條 byte-identity 守衛）。

**複審裁決（2026-09-22）**：T1 Approved（1 件計畫層 Important 已裁定，見 §3 R1）· T2 ✅ Spec compliant／Approved，0 Critical／0 Important；4 條 Minor 入 §7 待 T7 triage。

---

## 2. 未完成的部分（T3–T7）——下一個動作就是 T3

| 任務 | 範圍 | 已知裁定／注意 |
|---|---|---|
| **T3** `createRedactor`（`src/redactor.ts`） | 三趟獨立掃描（鍵名／憑證形狀／已註冊值 ≥8 字元）＋ `registerSecret` ＋ `size()` ＋ 洩漏回歸測試 | **必做**：①`[REDACTED]` token 與 T2 測試的 double 一致 ②**殘餘聲明寫進模組文件**（§3.5：v1 只承諾「未被**名稱／形狀／註冊**比對到的秘密不離開行程」；`size()` 可稽核）——T2 複審的 ⚠ 指名落在這裡 ③T2 的 `sk-live-*` double 在真工廠落地後可換掉（一行；§7） |
| **T4** CLI bootstrap（`apps/cli/src/diagnostics-bootstrap.ts` ＋ 三入口） | `createCliDiagnostics({runId?, env?, settings?, credentials?})`：runId mint、redactor 由 env 掃描（`/(KEY\|TOKEN\|SECRET\|PASSWORD\|PASSWD\|CREDENTIAL\|AUTH)/i` 且值 ≥8）＋ `settings.get().llm.providers[*].apiKeyEnv` → `credentials.resolve(ref)`；三入口 install ＋ `finally` close；`run.ts:398` 等保留 `loadProviderRuntime()` 回傳的 `credentials`（**零改動 credentials／provider-runtime**） | T4 的 case ③（記錄的 `data` 與 `err.message` 都被遮蔽）**現在可表達**（T2 的第三參數）。`createDiagnostics` 讀 `process.env`；env 未設時要顯式 `stream`。close 要在四條 run 出口（`run.ts:334/629/755/759`，行號引用前重量）＋sdk/acp teardown 都被走到 |
| **T5** 分級遷移 — `apps/cli` 60 站 | 逐檔批次；**完成條件＝既有測試檔 diff 為空**（95 處 spy 是守衛） | 形狀 `diagnosticsFor(phase).<level>(msg[, data])`，**msg 逐字**；**5 個列名例外不遷移**（`index.ts:178` help（exit 0）、`models.ts:343`、`roles.ts:287`、`provider.ts:222`、`run.ts:752` —— 維持 `console.error` 原樣）；普查＝**102 分級＋5 例外** |
| **T6** 分級遷移 — 16 套件 47 站 ＋ 8 個縫 | 縫先行（`?? console.warn` 預設改成「取環境實例、無則 console」，縫簽名不動），再逐套件 | 每套件完成條件＝該套件測試全綠 |
| **T7** 收尾 | `pnpm verify:all`（**母體 67**；五步全綠）＋ queue doc 普查句更正（`:535`／`:934`）＋ W6 兩列狀態翻 ✅＋ spec 加 dated 註記＋**把本文件的 §0 進度列改成終態** | 儀器盲區的實例要記進記錄（§5）；`--gate` 的 5 NEW rows 在此轉綠 |

---

## 3. Rulings（全部；每條附「若錯的代價」）

- **R1（T1 複審，2026-09-22）**：`index.ts:178` help（exit 0）、`models.ts:343`、`roles.ts:287`、`provider.ts:222`、`run.ts:752` 五站**維持原樣、列名不遷移** —— T1 的 API 讓通道＝級別，「info 級、通道 stderr」不可表達，而四個既有斷言釘著它們。**代價（明說）**：這五個 argv/notice 站點沒有結構化記錄。計畫 §0.3 與 T5 表已就地更正（`364e7cd3`）。
- **R2（T2 派工前）**：T2 紅測試的 redactor 用**測試內 double**（`/sk-live-[A-Za-z0-9]+/` → 恰好 `[REDACTED]`）——T3 的 `createRedactor` 當時不存在；T2 的性質是衍生的**位置**，真規則的舉證歸 T3。**代價**：T3 落地後一行把 double 換成真工廠即成整合證據。
- **R3（T2 進行中）**：**`record.err` 的寫者** —— `error(msg, data?)` 無錯誤參數 ⇒ `fromError` 無消費者、`record.err` 永遠空、T4 的 case ③ 不可表達。裁定：四級擴為 `(msg, data?, err?: unknown)`，**衍生在 logger 邊界內**（唯一寫者），`delegate` 不動。**代價**：介面多一個可選參數（T5/T6 的遷移形狀不變，計畫照舊）。
- **R4（T2 複審的 ⚠）**：**殘餘聲明落在 T3 的 redactor 文件**（T2 既未宣稱也未隱藏，不算 T2 缺口）。**代價**：T3 若漏寫，殘餘無人說——§2 的 T3 列已指名。

---

## 4. 量到的數字（附指令與修訂）

- `pnpm --filter @i-harness/diagnostics test` → **27/27**（2 檔）at `4915350a`；`pnpm --filter @i-harness/diagnostics typecheck` → exit 0。
- `node scripts/audit/check-reachability.mjs --gate` at `4915350a`（**controller 親量**）→ **exit 1、438 rows、5 NEW rows**（全在 `packages/diagnostics/src/index.ts`：`@i-harness/diagnostics#RedactedError`／`#createDiagnostics`／`#currentDiagnostics`／`#diagnosticsFor`／`#installDiagnostics`）、47 gone。**這 5 rows 是預期中的中途狀態；T7 之前不得加 allowlist**（計畫 Global Constraints 的逐列規則）。
- 母體（帶 `test` script 的 workspace 目錄）：**67**（66 → 67，T1 實測）。
- 全樹閘門 `pnpm verify:all`：最後一次全綠在 `a955c4d1`（M6，母體 66、433 rows、`--gate PASS`）；**本單元中途必然紅在 5 NEW rows 上**，T7 是它轉綠的時點。

---

## 5. 儀器盲區的實例（T7 要記進記錄）

`check-reachability.mjs` 的「這個名字被用了嗎」是**對生產檔的文字比對** ⇒ **正在解釋這個危險的註解本身會讓 row 消失**。本單元量到三例：

1. **`@i-harness/diagnostics#Diagnostics` 沒有 row**：裸詞出現在 `packages/rewind/src/types.ts:141` 的註解（class-1 遮蔽）。
2. **`#RedactedError` 的 row 黏著**：唯一入口提及在 re-export 語句內（被 `withoutReExportStatements` 清掉），宣告檔是 `src/record.ts`。
3. **T2 期間 A/B 重現兩次**：新註解寫了 `RedactedError`／`fromError` ⇒ row 當場消失；改寫措辭後回來。

**教訓（要寫進 T7 的記錄）**：`--gate` 的讀數要在**每次改動註解之後**重量，不是計畫段落之間。「數字下降」永遠要先問是不是遮蔽。

---

## 6. 環境與紀律（fresh clone 也要知道的）

- 本機 `bash` 是 **WSL**（沒有 node 在 PATH）；`pnpm`／`node`／`git` 直接呼叫。**CRLF 陷阱**：worktree 混合、blobs 是 LF；判斷 blob 用 plumbing（`git cat-file blob`），不要用 `git show`／`git diff`（smudge filter 會騙你）。
- **不 amend 任何已回報的提交**（修錯往前修）；**提交訊息不加 attribution trailer**；**push 只到里程碑分支**。
- **紅先測試 ＋ 變異證明**（roadmap §1.7）；引用先量；普查要報命中數與是否截斷。
- `pnpm -r --no-bail test` 單獨跑**不是**閘門（有紅時只跑一個前綴）；閘門是 `pnpm verify:all`（五步）。

---

## 7. Deferred minors（T7 triage 用）

- **T1**：④ double install/uninstall、`stream` 勝 env 未測（deferred）。
- **T1 concern**：`durMs` **在 W6 沒有生產者** —— T7 的記錄不要暗示它被填。
- **T2**：①`src/index.ts:29` 的 `fromError` 公開 re-export 無套件外消費者（一行可撤；保留供宿主自行衍生）②no-err-key 案例只釘 wire shape（`rec.err = undefined` 會穿過 `JSON.stringify`；記憶體形狀不可觀測，已在測試內註明）③`[REDACTED]` token 目前是對**檔案內 double** 斷言 —— **T3 落地時換真工廠**（一行）④非 Error 的 `name = typeof err`（語意選擇，已文件化）。

---

## 8. 本文件沒有建立的事

- **`pnpm verify:all` 沒有在本單元的任何提交上跑過** —— 中途必紅（§4），跑它沒有資訊；T7 是時點。
- **T3–T7 的每一條「注意」都取自計畫與本次裁定，不是實作量測**；執行者仍要自己量（引用先量）。
- **`.superpowers/` 的 ledger、task brief／report、review diff 不在 git 裡** —— 若你在 fresh clone 上，這份文件就是全部的接手面；task brief 可用 `scripts/task-brief <plan> <N>` 重新抽出（SDD skill 的 script）。
