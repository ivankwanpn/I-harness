# M79 — 覆蓋率補齊（與三件被指派進來的） Design

**一句話**：這一輪**不加任何功能**，只把「**行為已經正確、但沒有觀察者／沒有牙齒**」的地方補上——**五個可驅動的診斷站點**、**四個「窗口那半」的 hop**、**兩個零生產者的 union 成員**（**移除**，因為它們不是覆蓋缺口而是過度宣告），外加三件被指派的：**telemetry manifest 測試的型別牙齒**、**reachability 儀器的註解盲點**、**`CAPABILITIES-DETAIL.md` 的四個過期列數**。

**來源**：`docs/handoff/2026-09-23-backend-closure-plan.md` §1（M79）與 §2.4（三件指派）；來源本身的量測在各節就地引用。

**分級**：**M–L**。六個任務，其中**兩個會改變樹的讀數**（union 成員移除、儀器的列集合），其餘是「只加觀察者」。

---

## 0. 事實（本節全部在 `5446d6bb`（`main`）上重量過，2026-09-24）

### 0.1 五個可驅動的診斷站點（`m71-residuals.md` §6.2 第一條，2026-09-22 停車）

| 站點 | phase／level | 觸發條件 | 今天有觀察者嗎 |
|---|---|---|---|
| `packages/plugin-registry/src/commands.ts:76` | `mount`／warn | 目錄裡一個**名為 `*.md` 的子目錄**（`readdirSync` 列出它，`readFileSync` EISDIR） | ❌（同形的 `agents.ts:112` **有**：`site-diagnostics.test.ts:112-134`） |
| `packages/hooks/src/trust.ts:87` | `config`／warn | trust store 檔存在但不是 JSON | ❌（`hook-trust.test.ts` 不寫壞檔） |
| `packages/sdk/src/server.ts:224` | `sdk`／warn | `initialize` 的 `params` 不是物件 | ❌（`server.test.ts:468-486` **走過路徑**，只斷言 `console.warn` 間諜） |
| `packages/sdk/src/server.ts:230` | `sdk`／warn | `params.clientInfo` 不是物件 | ❌（**沒有任何測試送過非物件 `clientInfo`**） |
| `packages/core-plugin/src/index.ts:458` | `shutdown`／**error** | disposer 超過 `UNMOUNT_TIMEOUT_MS = 5_000`（`index.ts:84`） | ❌（`plugin.test.ts:250-286` 走過路徑，只斷言 `console.error` 間諜，真等 10 s） |

**五個都是 ambient handle**（`const d = diagnosticsFor("<phase>")`），不是 seam——安裝實例之後五條路一起亮，**不需要逐站接線**。既有 9 個 `site-diagnostics.test.ts` 的形狀可逐字沿用：`captureStream()` → `installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))` → 驅動真函式 → `expect(parsed(lines)[0]).toMatchObject({ phase, level, run: "r15" })` ＋ `msg` `toContain` ＋ `expect(warn).not.toHaveBeenCalled()`。

### 0.2 四個「窗口那半」的 hop（M73 §4.5；四個舊行號在 `5446d6bb` 上**沒有漂**）

| hop | 位置 | 餵入的變數 | 現實的交換（同型、編譯得過） | 今天觀察得到嗎 |
|---|---|---|---|---|
| 1 | `packages/session-executor/src/assembly.ts:1146`（guardian 繼承臂的字面） | `opts.contextWindow` | `opts.maxOutputTokens`（兄弟鍵）或 `opts.compact?.contextWindow` | ❌ 既有測試（`assembly.test.ts:1514`）只斷 cap，**且 fixture 視窗 200 000 ⇒ `clampOutputCap` 是 no-op** |
| 2 | 同檔 `:1182`（team 分支的字面） | `opts.contextWindow` | 同上 | ❌ `assembly.test.ts:835` 的 fixture **完全沒帶預算選項** |
| 3 | `packages/agent-team/src/scheduler.ts:221`（`realSpawnChild` → `spawnChild`） | `sub.contextWindow` | `sub.maxOutputTokens`（兩鍵相鄰，`scheduler.ts:61-62`） | ❌ 該套件測試**零個 `contextWindow` 命中** |
| 4 | `packages/guard-approval/src/guardian/reviewer.ts:178` | `deps.contextWindow`（**有閘**：`deps.model === undefined`） | 兄弟鍵；或**把閘拿掉**（boolean，編譯得過） | ❌ 既有測試都傳非 undefined 的 `model`（閘的假臂） |

**全樹唯一一條「窗口半」斷言在第五個 hop**（`assembly.test.ts:1492`，fixture `contextWindow: 8_000`／`maxOutputTokens: 100_000`）——它走的是 `assembly.ts:1077`（`subagentDeps`），**不是這四個**。

**可觀察的路徑（實測）**：`agentCalls`（`assembly.test.ts:31-41` 的 `vi.mock` 記錄每次 `createAgent` 的 deps）→ `deps.budget.contextWindow`（`subagent/src/child.ts:449-451` 寫入、`core-agent/src/index.ts:30` 必要欄位）；次要的是夾取後的 wire `maxOutputTokens`。

### 0.3 診斷相位 union 的兩個零生產者成員（W6 §2.5.6）

- union 是 `packages/diagnostics/src/record.ts:20-44` 的**封閉** 10 成員；`packages/core-session/src/index.ts:151` 有一份**內聯複本**（漂移檢查是**單向**的：`DiagnosticPhase` ⊆ 內聯）。
- `telemetry` 與 `acp`：**零測試站點，而且零生產者**（`grep -rn 'diagnosticsFor\("(telemetry|acp)"\)|child\("(telemetry|acp)"\)' apps/*/src packages/*/src` ⇒ 無）。ACP host 的診斷走 `cli` handle（`apps/cli/src/index.ts:49`）；telemetry 的 sink 錯誤仍是 W6 的**指名 byte-untouched 例外**（`packages/telemetry/src/telemetry.ts:11,13` 的裸 `console.warn`）。
- W6 的「**六個可翻的相位**」在 HEAD 上**有五個已經不真**（R15 的 `site-diagnostics.test.ts`，2026-09-22 22:34 提交，都是 HEAD 的祖先）；唯一仍然可翻的是 `subagent/tools→session`（`tools.ts:829` 的 sweep `.catch`）——那正是 M71 §6.1 量到的**「34 個未覆蓋站點裡唯一『量過但驅不動』」**。
- `sdk` 與 `shutdown` **有生產者、沒有相位斷言**——而它們的站點正是 §0.1 的第 3、4、5 條 ⇒ **本單位的任務 4 會給它們各自第一個相位斷言**。

### 0.4 三件被指派進來的

1. **`packages/telemetry/test/manifest.test.ts:6-24` 的執行期那一半是同義反覆**：`codes` 建自 `TELEMETRY_EVENT_TYPES`（`:7`），而它就是 `TELEMETRY_MANIFEST.map(code)`（`manifest.ts:51`）⇒ 迴圈恆真；`type Missing` ＋ `const missing: Missing[] = []`（`:21-22`）**對任何 `Missing` 都編譯得過**（空陣列不需要元素）。**沒有任何東西守著「新 union 成員沒有 manifest 列」**。manifest 今天 **23 列**、union 也 23（本單位再量）。
2. **reachability 儀器對 class 1 的「用了嗎」是對 raw 檔文字做字比對**（`scripts/audit/check-reachability.mjs:418-419`；`f.text` 來自 `:1526` 的 `readFileSync`，**註解原樣在內**）⇒ **別套件的一句註解提到一個名字就會讓那一列消失**。這不是推論：腳本自己**記著**這個偽陰性（self-test 案例 `:986-994`「documented false negative」，`expect: []`；說明在 `:961-985`，並附一個真樹實例）。**M77、M78 各觸發一次**（`retryErrorCode`、`derivePruneSubstitutes`），兩次都只靠改註解繞過。baseline 有 **472 列**、今天的讀數是 **432 列**；`--gate` 的 `added` 是「不在 baseline、也不在 allowlist」的列。
3. **`docs/CAPABILITIES-DETAIL.md` 的 telemetry 列數**：`19` 出現在**四個地方**（`:22` 總表、`:293` 標題、`:295` 句子、`:674` 驗證清單），另外兩個地方的行號範圍 `manifest.ts:16-37` 已漂（今天是 `:16-49`），而 `:295` 的句子**列了 20 個名字卻說「= 19 行」**（缺的是 `provider/usage`／`provider/truncated`／`provider/refused`）。

---

## 1. 設計

### 1.1 (a) 五個站點：用既有的 R15 形狀驅動（只加觀察者）

**逐站一個測試**，全部抄既有的 install/assert 括號（含 `expect(warn).not.toHaveBeenCalled()`；core-plugin 那一站是 `error` ⇒ 斷言 `console.error` 沒被呼叫）。**新增檔 vs 追加**：
- `packages/plugin-registry/test/site-diagnostics.test.ts`、`packages/hooks/test/site-diagnostics.test.ts` — **追加**（已在，形狀就在上面）。
- `packages/sdk/test/site-diagnostics.test.ts`、`packages/core-plugin/test/site-diagnostics.test.ts` — **新檔**（各套件第一個）。**為什麼新檔而不是改既有測試**：安裝實例是**行程全域**的（`installDiagnostics` 換掉模組槽），而 `server.test.ts:468-486`／`plugin.test.ts:250-286` 斷言的正是 `console.warn/error` **被呼叫**；同檔並存會讓順序決定結果。新檔＝新 worker，**既有測試零改動**。
- core-plugin 那一站的 5 s：**先試 `vi.useFakeTimers()` ＋ `advanceTimersByTimeAsync(5_000)`**、disposer 用**永不落定**的 promise（`() => new Promise(() => {})`）⇒ `timedOut` 為真。**若量到不行**（例如假計時器下 race 的語意不符），退回 `plugin.test.ts:250-286` 的真時間形狀（**記下實際機制與牆鐘成本**）；兩種都可以，**實測決定並記錄**。
- sdk 的兩站：`initialize` 只認**第一次**（`server.ts:384`）⇒ 每個案例一個新 server／一則 initialize。

**這五個測試同時是本單位的相位普查收尾**：`sdk`、`shutdown` 因此首次有相位斷言；`config`、`mount` 多一個。

### 1.2 (b) 四個 hop：**誘餌值**設計（交換會移動被斷言的那個數字）

每一條都要 fixture **同時帶兩個同型、值相異的數字**，讓「餵錯變數」**可觀察**：
- **hop 1＋4**（一條測試就蓋兩個站點：值從 `assembly.ts:1146` 進、`reviewer.ts:178` 出）：`guardian: {}`（無配置模型 ⇒ 閘的真臂）、`contextWindow: 8_000`、`maxOutputTokens: 100_000` ⇒ 斷言**那個 reviewer 子代理的 `budget.contextWindow === 8_000`**。交換 `opts.contextWindow`→`opts.maxOutputTokens` ⇒ 觀測到 100 000 ⇒ 紅。若 `compact: { contextWindow: 4_000 }` 不擾動 fixture，再加第三個誘餌（可選；做了就記錄）。
- **hop 1＋4 的閘那一半**（今天的缺口：既有測試只斷 cap 的缺席）：一個**配置了 guardian 模型**的 fixture ⇒ 斷言子代理的 `budget.contextWindow` **不是** session 的 200 000（是缺席路徑的實測值——**先量再寫**）。把 `reviewer.ts:178` 的 `deps.model === undefined` 拿掉 ⇒ 觀測到 200 000 ⇒ 紅。**優先新測試**；若誠實的做法非改既有測試不可，**停下來回報**（控制器裁決後才動）。
- **hop 2＋3**（一條測試蓋兩個站點：值從 `assembly.ts:1182` 進、`scheduler.ts:221` 出）：`team: {}` ＋ `contextWindow: 8_000`、`maxOutputTokens: 100_000` ⇒ 斷言**隊友**子代理的 `budget.contextWindow === 8_000`。任一站的兄弟鍵交換 ⇒ 100 000 ⇒ 紅。
- **怎麼挑「隊友那一筆」**：沿既有測試的過濾形狀（`assembly.test.ts:864` 用 systemPrompt 認出隊友；`:1532` 用 guardian 的字串認出 reviewer），不新增辨識機制。

### 1.3 (c) `telemetry` 與 `acp`：**移除**（不是接線，不是留著）

**理由（設計合理性）**：union 自己的契約是「**由實測的縫列舉，不是發明**」（`record.ts:20-33`），而這兩個成員**零生產者**。留著 ⇒ 宣告比程式碼知道的多（正是收線判準 §3.3 要消滅的那一類）；接線 ⇒ 要嘛把 telemetry 的 sink 錯誤搬進診斷（**推翻 W6 的指名例外**，且讓 sink 錯誤走另一條記錄通道），要嘛把 ACP host 從 `cli` 改成新相位（**改變使用者可見的輸出**）——兩者都是為了一個測試而改生產行為，**不值得**。**移除**讓宣告與量測一致；未來真的遷移時，照 union 的協定「**加成員的提交要說它來自哪條縫**」把它加回來。

**動到的載體（全部量過）**：`packages/diagnostics/src/record.ts` 的 union ＋ **它自己的 doc comment**（那段點名 `sdk` 和 `acp`／`telemetry`，要改寫並加註日期與理由）；`packages/core-session/src/index.ts:151` 的內聯複本。**加一條有牙齒的斷言**：一則型別級的「union 恰等於這 8 個」（雙向），在 `packages/diagnostics/test/` 裡 ⇒ 任何一側漂移都讓 `pnpm typecheck` 紅。**不做**核心的雙向漂移檢查（那是 operator/run-end 的 deferred minor；見 §5）。

**`sdk` 與 `shutdown` 不動**：它們有生產者，觀察者由 §1.1 補上。

### 1.4 (d) 三件指派項

**(d1) manifest 測試的牙齒**：把執行期的同義反覆換成型別級斷言——`const manifestIsExhaustive: Missing extends never ? true : false = true`（`Missing` 非 `never` ⇒ `false` 不可賦 `true` ⇒ **`pnpm typecheck` 紅**），並以 `expect(...).toBe(true)` 保住 `noUnusedLocals`。**紅先／變異**：暫時把 `| "provider/m79-probe"` 加進 `types.ts` 的 union ⇒ typecheck 必須紅**在那一行**（若同時別處紅，逐一記錄）；還原用 Edit＋`sha256sum`。**這是被指派的既有斷言改動**（closure plan §2.4 明文授權本單位），且 `it` 數不變。M77 fix wave 留下的那段「rewriting this into a type-level assertion is M79's」註解要改寫成事實。

**(d2) 儀器的註解盲點**：class 1 的字比對**改用剝掉註解的文字**（`//` 與 `/* */`；**字串內容保留**——名字出現在字串裡仍算使用，否則會**鑄出偽列**，變成比偽陰性更糟的方向）。機制**沿用既有的狀態機**（`codeOnly`，`:484-513`），不另寫第二套剝法；它對 regex literal 的已知限制照實繼承並記錄。**entry 檔也要剝**（今天的 `entryText` 只塗白 re-export 語句、**保留註解**）。**逐檔備忘**（同一份 text 會被「entry × name」多次提問，不備忘會爆）。

**隨之而來的量測義務（本單位最重要的一步）**：剝註解之後**會有列浮出來**（被註解遮蔽的真話）。⇒ 修前／修後各跑一次 `--json`，**逐列列出新出現的列**，每一列判斷：**(a)** 真的沒人消費 ⇒ 它是**真發現**，用腳本自己的 `--seed-baseline` 重新播種（baseline 的 `count`／`digest` 一起更新，`--gate` 維持 PASS）並在紀錄裡**逐條指名**；**(b)** 其實有人消費、只是字比對看不見（例如只出現在字串裡——**本設計保留字串 ⇒ 預期為零**）⇒ **不自行播種**，回報控制器裁決（那會是本儀器的新一類偽陽性）。self-test：`:986-994` 的「documented false negative」**反轉**（改名＋反轉期望），並**新增**：字串提及**仍然**讓列退休（防過度剝除）、entry 檔的註解**不再**讓列退休。`:961-985` 的說明改寫。
**adjacent 危害的稽核（只量不修）**：class 2（`EVENT_LITERAL` 掃 raw `f.text`）與 class 5（`:762` 的 raw read test）是否有同一個「註解當證據」的病；量到什麼就寫進紀錄，**本單位不改它們的行為**。

**(d3) `CAPABILITIES-DETAIL.md` 的列數**：四個 `19` 站點改 **23**（`:22`、`:293`、`:295`、`:674`），兩個行號範圍改 `:16-49`，而 `:295` 的列舉**補上缺的三個名字**（`provider/usage`／`provider/truncated`／`provider/refused`，位置在 `provider/error` 之後）⇒ 列舉數（23）與宣稱數一致。**範圍例外**：本單位的實作者**只准動這一個 doc 檔**（`docs/` 其餘——specs／plans／handoff——是控制器的紀錄，一律不動）。

---

## 2. 驗收（每一條都要**紅先 ＋ 變異證明**，除非該條本身就是量測）

1. **五個站點**各有一個測試：安裝實例 ⇒ 斷言 `phase`／`level`／訊息片段，且**對應的 console 方法未被呼叫**（seam 取代，不是兩者都做）。五個測試的**突變**：拿掉 `installDiagnostics` ⇒ 斷言紅（記錄產生器的缺席）。
2. **四個 hop** 各有一個觀察者，且**交換餵入的變數會移動被斷言的數字**（誘餌值相異）：hop 1＋4 一條、閘的半條、hop 2＋3 一條。突變逐條做（把變數換成兄弟鍵／拿掉閘）⇒ 具名斷言紅。
3. **union**：`DiagnosticPhase` 恰等於 8 個成員（型別級雙向斷言），內聯複本同步；**每一個留下的成員至少有一個測試斷言它的相位**（clil／config／run／turn／sdk／session／mount／shutdown——`sdk`、`shutdown` 由驗收 1 供給；產出「成員 → 測試檔」表）；`pnpm typecheck` 全綠；一個「加回 `| "acp"`」的突變 ⇒ 型別斷言紅。
4. **manifest**：一個「新 union 成員沒有 manifest 列」的突變 ⇒ `pnpm typecheck` **紅在該斷言那一行**；`it` 數不變；既有兩條 `it` 的名稱與意圖仍真。
5. **儀器**：`--self-test` 全綠（案例數 36 → 38：＋2 條新增、反轉不增案例——**執行期更正**）；**新出現的列逐條指名**且逐條歸類（真發現 ⇒ 播種；偽陽性 ⇒ 上報）；baseline 重新播種後 `--gate` **PASS**；`pnpm verify:all` 的 reachability 讀數**修前／修後都記**（432 → 432＋N）。
6. **`CAPABILITIES-DETAIL.md`**：`19`／`20` 的 telemetry 列數宣稱**零殘留**；四個站點都是 23；列舉與數字一致；行號範圍是 `:16-49`。
7. `pnpm verify:all` 五步全綠（母體 67）；**算術寫出來**（預期 3124 ＋ **8**＝3132：驗收 1 的 5 條＋驗收 2 的 3 條；型別斷言不加 `it(`——**實測為準**）。
8. **既有斷言零條被放寬**；唯二的既有測試改動是：manifest 那一條（被指派）與（若 `diagnostics.test.ts` 有列舉 union 的斷言）那一條——**後者要具名**。不新增 export。

## 3. 刻意不做（YAGNI）

- **不驅動 `subagent/src/tools.ts:829`**（`session` 相位）：M71 §6.1 已量過**驅不動**（fire-and-forget 的 `.catch`，生產路徑不會拒絕它）。**指名接受**。
- **不驅動 `subagent/src/child.ts:399`**（只有 console 間諜）：同類，未具名為本單位的項目 ⇒ 進殘餘。
- **不改 class 2／4／5 的比對行為**（§1.4 d2 的稽核只量）。
- **不做 core-session 內聯 union 的雙向漂移斷言**（operator/run-end 的 deferred minor）。
- **不動 `packages/telemetry/src/telemetry.ts:11,13`**（W6 的指名 byte-untouched 例外）。
- **不改 `docs/` 的歷史快照**（2026-09-11／15 的 audit、2026-09-17 spec 的「是 20」）——M80 的文件一致性範圍。

## 4. 它不保證什麼（明說）

1. **不保證儀器修完沒有偽陽性**：剝註解只移除「註解當使用」這一類；字串保留是刻意的取捨 ⇒ 若真有「只被字串提到」的 export，它**仍然**不會有列。那類要另一輪（量到了再說）。
2. **不保證四個 hop 的觀察者窮盡該站的錯誤**：誘餌值抓的是**值交換**與**閘缺失**；接線本身寫錯成第三種形狀（例如兩個鍵都傳同一來源）只要仍落在誘餌集合內就抓得到，但**誘餌集合以外**的錯法不保證。
3. **移除 union 成員不是防止未來濫加**：協定（加成員要說縫）是註解，不是機制。
4. **不保證覆蓋率「完整」**：本單位關掉的是**指名**的三組；「34 個未覆蓋站點」的其餘 28 個（較重、需要真縫或大型 fixture）**不在**這裡。

## 5. 殘餘（寫出來，不是藏起來）

- `subagent/src/tools.ts:829`（`session`，量過驅不動）與 `subagent/src/child.ts:399`（只有 console 間諜）——**指名未覆蓋**。
- class 2／4／5 的註解危害稽核**結果**（量到什麼算什麼；沒修）。
- core-session 內聯 union 的**單向**漂移檢查（今天就這樣；本單位同步了兩個字面）。
- `docs/` 其餘過期載體：2026-09-11／15 audit 的「20 rows」、2026-09-17 spec 的「是 20」、W6 handoff `:167` 的「六個可翻」——**歷史快照／記錄不改**，由 M79 紀錄與 M80 收。
- `@i-harness/preset#mountPreset` 那一類**曾被註解遮蔽的列**：修完之後的真實名單由量測決定（本 spec 不預測數字）。

## 6. 取樣與自創

| 部分 | 來源 |
|---|---|
| 五個站點與它們的驅動方式 | `docs/handoff/2026-09-22-m71-residuals.md` §6.2 ＋ 本輪逐站重量 |
| 誘餌值設計 | **本輪的判斷**（既有測試的視窗是 200 000 ⇒ 夾取 no-op，所以「只斷 cap」永遠抓不到窗口半） |
| 移除以代替接線 | **本輪的判斷**（union 自稱「由實測列舉」；接線的兩條路都要改生產行為） |
| 只剝註解、保留字串 | **本輪的判斷**（偽陰性 vs 偽陽性的方向性取捨） |
| manifest 型別斷言的形狀 | M77 fix wave 已具名（closure plan §2.4）；`Missing extends never ? true : false` 是本輪選的**可編譯失敗**形式 |
| 儀器的量測義務與播種政策 | **本輪的判斷**（列集合會動 ⇒ 先量、逐條指名、再由腳本播種） |
