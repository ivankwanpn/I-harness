# W6 — 結構化診斷 ＋ redactor：**進行中**交接（T1–T3／7 完成）

**Written:** 2026-09-22，前一個爆 context 的 controller session 寫下 T1–T2 的部分（依 owner 指示在 T2 收線、push）；同日工作電腦接手後續作 **T3**，本文件隨之更新。
**Audience:** 續作 W6 的人（可能是 fresh clone、沒有本機 scratch 的工作電腦）。
**State measured at:** `7c78589`（T3 的 head；本文件的更新提交在其後）— 本文每一條 `path:line` 都在此修訂量過；**行號會腐，引用前先重量**（本 repo 的既有紀律）。**自重**：`git rev-parse HEAD origin/m68`。

---

## 0. 先看五件事

| Fact | Value |
|---|---|
| Repo / remote | 原工作站 `D:\I-harness-main` ↔ `https://github.com/ivankwanpn/I-harness.git`（authoritative）；工作電腦同路徑 |
| Branch | **`m68`**（本單元的里程碑分支；`main` 的合併時機由人決定） |
| HEAD / origin | T3 head `7c78589`；`origin/m68` 於 2026-09-22 的第二次 push 同步（T1–T3 ＋ handoff 提交）。**自重** |
| 本單元 | **W6**：建 `@i-harness/diagnostics`（`createDiagnostics` ＋ `createRedactor`），把 **107 個 `console.warn/error` 站點**分級上去 —— 而 **`I_HARNESS_LOG` 未設時 stderr 逐位元組不變** |
| 進度 | **T1 ✅ · T2 ✅ · T3 ✅ · T4–T7 ⬜**（7 任務；§1–§2） |

**設計依據**：spec `docs/superpowers/specs/2026-09-17-m3-measurement-foundation-design.md` **§3.3（`:177-193`）＋§3.5（`:215-235`）**；B1 裁定 **B**（owner 2026-09-22：「追求完整性，別人後面要修要改很麻煩」）。
**計畫**：`docs/superpowers/plans/2026-09-22-w6-diagnostics.md`（7 任務；**§0.1 的普查指令是唯一有效的量法**——舊的 `grep -rn "console\.(warn\|error)"` 在 BRE 裡是字面量，數到 152 條裡 140 條不是呼叫）。
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

---

## 2. 未完成的部分（T4–T7）——下一個動作就是 T4

| 任務 | 範圍 | 已知裁定／注意 |
|---|---|---|
| **T4** CLI bootstrap（`apps/cli/src/diagnostics-bootstrap.ts` ＋ 三入口） | `createCliDiagnostics({runId?, env?, settings?, credentials?})`：runId mint、redactor 由 env 掃描（`/(KEY\|TOKEN\|SECRET\|PASSWORD\|PASSWD\|CREDENTIAL\|AUTH)/i` 且值 ≥8）＋ `settings.get().llm.providers[*].apiKeyEnv` → `credentials.resolve(ref)` → **逐個 `registerSecret`**；三入口 install ＋ `finally` close；`run.ts:398` 等保留 `loadProviderRuntime()` 回傳的 `credentials`（**零改動 credentials／provider-runtime**） | T4 的 case ③（記錄的 `data` 與 `err.message` 都被遮蔽）**可表達**（T2 的第三參數）。`createDiagnostics` 讀 `process.env`；env 未設時要顯式 `stream`。close 要在四條 run 出口（`run.ts:334/629/755/759`，引用前重量）＋sdk/acp teardown 都被走到。**T3 的交棒**：`*_WEBHOOK`／`*_URL` 這類名字**落在**上面那條 regex 之外（T3 實作者具名回報）。**R7**：若 bootstrap 用得上 `extraRules`／`Rule`，順帶清掉第 7 條 gate row |
| **T5** 分級遷移 — `apps/cli` 60 站 | 逐檔批次；**完成條件＝既有測試檔 diff 為空**（95 處 spy 是守衛） | 形狀 `diagnosticsFor(phase).<level>(msg[, data])`，**msg 逐字**；**5 個列名例外不遷移**（`index.ts:178` help（exit 0）、`models.ts:343`、`roles.ts:287`、`provider.ts:222`、`run.ts:752` —— 維持 `console.error` 原樣）；普查＝**102 分級＋5 例外** |
| **T6** 分級遷移 — 16 套件 47 站 ＋ 8 個縫 | 縫先行（`?? console.warn` 預設改成「取環境實例、無則 console」，縫簽名不動），再逐套件 | 每套件完成條件＝該套件測試全綠 |
| **T7** 收尾 | `pnpm verify:all`（**母體 67**；五步全綠）＋ queue doc 普查句更正（`:535`／`:934`）＋ W6 兩列狀態翻 ✅＋ spec 加 dated 註記＋**把本文件改成終態** | 儀器盲區的實例要記進記錄（§5）；`--gate` 的 7 NEW rows 在此轉綠（含 `#Rule` 的去路，R7）；**R5 的 named residual 要進記錄**；§7 的 deferred minors 在此 triage |

---

## 3. Rulings（全部；每條附「若錯的代價」）

- **R1（T1 複審，2026-09-22）**：`index.ts:178` help（exit 0）、`models.ts:343`、`roles.ts:287`、`provider.ts:222`、`run.ts:752` 五站**維持原樣、列名不遷移** —— T1 的 API 讓通道＝級別，「info 級、通道 stderr」不可表達，而四個既有斷言釘著它們。**代價（明說）**：這五個 argv/notice 站點沒有結構化記錄。計畫 §0.3 與 T5 表已就地更正（`364e7cd3`）。
- **R2（T2 派工前）**：T2 紅測試的 redactor 用**測試內 double**（`/sk-live-[A-Za-z0-9]+/` → 恰好 `[REDACTED]`）。**代價**：T3 落地後一行換真工廠 ⇒ **已由 T3 履行**（`99c287e`，複審確認強化）。
- **R3（T2 進行中）**：**`record.err` 的寫者** —— 四級擴為 `(msg, data?, err?: unknown)`，衍生在 logger 邊界內（唯一寫者），`delegate` 不動。**代價**：介面多一個可選參數（T5/T6 的遷移形狀不變）。
- **R4（T2 複審的 ⚠）**：**殘餘聲明落在 T3 的 redactor 文件** ⇒ **已由 T3 履行**（`redactor.ts:1-13`）。
- **R5（T3 複審，plan-mandated）**：**維持 §3.5 逐字的 `\bBearer\s+\S+`，不改** —— 少遮蔽＝活憑證外洩、多遮蔽＝一句散文少一個字；代價已寫在 `redactor.ts:49-53`，規則大小寫敏感。**Park**。**若錯的代價**：JSONL 裡一句大寫「Bearer <word>」讀起來是 `Bearer [REDACTED]`（T7 要列為 named residual）。
- **R6（T3 複審）**：散文內嵌 `api_key=…` **不補規則** —— §3.5 的鍵名掃描是對物件鍵；真值由 T4 的 `registerSecret` 覆蓋；`m3-diagnostics-redaction-design.md` 查過，只有 M65 已刪的 TUI redactor 描述，無 §3.5 之外的內嵌規則。**若錯的代價**：散文裡 `name=` 形式的秘密不被遮蔽（§3.5 既有殘餘方向）。
- **R7（T3 複審）**：`#Rule` 的 gate row —— mid-plan 預期；T4 若用得上就清掉，否則 T7 加逐列 allowlist（`reason`＋`dated`）。**若錯的代價**：一條無消費者的 export 需要一列 allowlist，別無他害。
- **R8（owner 2026-09-22，遷移裁定）**：`.superpowers/` **維持 gitignored、靠複製遷移**（量過：11 MB／301 檔，其中 80 個 review diff 可由 `scripts/review-package` 重生）。**若錯的代價**：每次換機都要記得帶那份資料夾。

---

## 4. 量到的數字（附指令與修訂）

- `pnpm --filter @i-harness/diagnostics test` → **46/46**（3 檔）at `7c78589`；typecheck exit 0。（T1 的 17／T2 的 27 是同一條曲線上的中途讀數。）
- `node scripts/audit/check-reachability.mjs --gate` at `7c78589`（**controller 親量**）→ **exit 1、440 rows、7 NEW rows**（全在 `packages/diagnostics/src/index.ts`：`RedactedError`／`Rule`／`createDiagnostics`／`createRedactor`／`currentDiagnostics`／`diagnosticsFor`／`installDiagnostics`）。**預期中的中途狀態；T7 之前不得加 allowlist**。
- 母體（帶 `test` script 的 workspace 目錄）：**67**（66 → 67，T1 實測）。
- 全樹閘門 `pnpm verify:all`：最後一次全綠在 `a955c4d1`（M6，母體 66、433 rows、`--gate PASS`）；**本單元中途必然紅在 7 NEW rows 上**，T7 是它轉綠的時點。

---

## 5. 儀器盲區的實例（T7 要記進記錄）

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

## 7. Deferred minors（T7 triage 用；都不入修復迴圈）

- **T1**：④ double install/uninstall、`stream` 勝 env 未測（deferred）。**concern**：`durMs` **在 W6 沒有生產者** —— T7 的記錄不要暗示它被填。
- **T2**：①`src/index.ts:29` 的 `fromError` 公開 re-export 無套件外消費者（一行可撤）②no-err-key 案例只釘 wire shape（`rec.err = undefined` 會穿過 `JSON.stringify`）③`[REDACTED]` token 的 double 斷言 ⇒ **已由 T3 履行**（`99c287e`）（保留此列僅為記錄）④非 Error 的 `name = typeof err`（語意選擇）。
- **T3**：①base64 的鍵名 fence 比 §3.5 的「看起來像秘密」寬（`includes` 詞幹，`author`／`passengers` 也中；dead-code 論證支持現狀）②`toJSON` 回傳自身時 UNSCANNED（`redactor.ts:284`；罕見形狀，一行可修）③衍生副本邊角（symbol 鍵被丟、`apiKey: undefined` 變成 `"[REDACTED]"`）④循環引用只在報告、未寫進模組文件（結果同為 throw，非回歸）⑤洩漏 payload 缺 scan-① 樣本（專屬案例仍抓得到）⑥規則順序案例的 fixture 其實不重疊（合併由同案例的 `Bearer sk-live-…` 斷言釘住）。

---

## 8. 本文件沒有建立的事

- **`pnpm verify:all` 沒有在本單元的任何提交上跑過** —— 中途必紅（§4），跑它沒有資訊；T7 是時點。
- **T4–T7 的每一條「注意」都取自計畫與歷次裁定，不是實作量測**；執行者仍要自己量（引用先量）。
- **`.superpowers/` 的 ledger、task brief／report、review diff 不在 git 裡** —— 若你在 fresh clone 上，這份文件就是全部的接手面；task brief 可用 SDD skill 的 `scripts/task-brief <plan> <N>` 重新抽出。遷移包（2026-09-22 建立）另含 ledger 與 session transcripts，但那是**複製**、不是版控。
