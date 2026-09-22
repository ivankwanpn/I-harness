# W6 — 結構化診斷 ＋ redactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建 `@i-harness/diagnostics`（`createDiagnostics` ＋ `createRedactor`，**照 M3 spec §3.3／§3.5 原設計、含按構造必填的 redactor**），並把 **107 個 `console.warn/error` 站點**分級上去 —— 而 `I_HARNESS_LOG` 未設時，**既有的 stderr 逐位元組不變**。

**Architecture:** 一個**零依賴**的新套件（掛在 `packages/diagnostics`，腳手架照 `harness-home`）；**環境實例（ambient instance）**：套件持有「當前實例」，宿主在入口 `install()`、在既有 teardown `close()`；**未安裝／未設 env 時，每個級別的呼叫委派回 `console.warn`／`console.error` 並逐字傳原文與原通道** —— 這就是「逐位元組不變」的機制。redactor 在 `apps/cli` 的 bootstrapping 建構（env 掃描 ＋ settings 的 `apiKeyEnv`；`loadProviderRuntime()` **已經**把 credential store 回傳，只是呼叫端把它丟了）。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-17-m3-measurement-foundation-design.md` **§3.3（`:177-193`）＋§3.5（`:215-235`）** · **裁定：** queued doc B1 → **B**（owner 2026-09-22：「追求完整性，別人後面要修要改很麻煩」）· **分支：** `m68`

---

## 0. 接手前該知道的四件事

### 0.1 普查指令本來是壞的 —— 而這一條先修記錄

queued doc（`:535`／`:934`）寫的 `grep -rn "console\.(warn\|error)"` **在 BRE 裡是字面量**：它數到 152，其中 **140 條不是呼叫**（`} catch (error) {`、含 `error)` 的註解…），而**漏掉**真實的呼叫（`console.error(USAGE)` 這種 `error(` 後沒有 `)` 的、整個 argv 驗證區塊）。**會重現的指令（兩式一致）：**

```bash
grep -rn -F -e "console.warn(" -e "console.error(" packages/*/src apps/*/src --include=*.ts | grep -v "\.test\.\|/test/"
# → 108 行；扣掉 1 條註解（apps/cli/src/run.ts:236）＝ 107 個可執行站點（34 檔）
```

**分佈**：`console.warn(` 51 · `console.error(` 57（其中 **5 條不是 error 形狀**：`index.ts:178` 的 help usage 是 **exit 0**、`models.ts:343` warn、`roles.ts:287` note、`provider.ts:222` warn、`run.ts:752` `[metrics]` 報告）。`apps/cli` 60（8 檔，index 23／provider 11／run 6／roles 5／models 5／hooks 5／plugins 3／sessions 2）· 16 個 package 目錄 47（session-executor 13、plugin-registry 8、mcp-client 8、telemetry/sdk/hooks/subagent/rewind 各 2、8 個各 1）。**「110」與「79」都是別的量法/別的日子** —— 本計畫一律用上面兩式。**T7 要把 queued doc 那兩句普查改成這條指令＋數字（連同「舊指令壞在哪」）。** **⚠ 修正（T5 落地時量的，2026-09-22）：上面「5 條不是 error 形狀」在 R11 之後是 10 條** —— 另外五條是 exit-0 的 `help` print（`provider.ts:254`、`roles.ts:241`、`models.ts:364`、`hooks.ts:161`、`plugins.ts:443`），與那五條同類（級別即通道，`info` 級不可表達；給 `error`＝讓記錄說謊）。**整棵樹因此＝97 個分級 + 10 個列名例外（＝107）**；`apps/cli` **60 → 50 分級 + 10 例外**。十條的現位置：`index.ts:194`、`models.ts:348`、`models.ts:364`、`roles.ts:295`、`roles.ts:241`、`provider.ts:227`、`provider.ts:254`、`hooks.ts:161`、`plugins.ts:443`、`run.ts:776`（`run.ts:246` 是那條註解，不是站點）。
**範圍外（明說，附理由）**：`scripts/`＋`e2e/` 另有 **79** 個站點（開發者工具面，不是產品日誌面）· 5 個 `process.stderr.write`（`sandbox-windows-acl/src/runner.ts:61,194,201,222`＋`apps/cli/src/index.ts:824`）—— 後者是**協議通道**，不是日誌。

### 0.2 **95 個測試斷言點在監看 `console.*`** —— 這就是為什麼「未設 ⇒ 不變」必須是機制，不是願望

30 個測試檔、95 處 `vi.spyOn(console, …)`／`console.x = …`：包含**文字斷言**（`models-command.test.ts:272-276` 的 `deepseek-flash`／`/409600/`；`roles-command.test.ts:210-213` 的 note 與 `toBe("")` 沉默斷言；`cli.test.ts:453-459` 的 `toHaveBeenCalledWith(stringContaining(...))`）與**沉默斷言**（`models-command.test.ts:271` `toBe("")`、`roles-command.test.ts:213`、`bin.test.ts:87-88` 的 `not.toContain`）。**⇒ 遷移後每個站點在未設 env 時必須發出一模一樣的 `console.warn/error` 呼叫**（同函式、同參數）。**機制＝模組的「未設/未安裝」模式就是委派**：`warn(msg)` → `console.warn(msg)`、`error(msg)` → `console.error(msg)`，**msg 逐字**。

### 0.3 recon 的 open questions → 本計畫的裁定

| 問題 | 裁定 | 理由 |
|---|---|---|
| 站點如何到達實例（DI 會遍及 100 站） | **環境實例**：`packages/diagnostics` 匯出 `installDiagnostics(d)`／`currentDiagnostics()`；站點持有**模組級 child**（`const d = diagnosticsFor("phase")`），呼叫時取當前實例，**沒有實例 ⇒ 委派 console** | 100 站點的參數注入是重寫全部簽名；今天的 `console` 本來就是環境單例 —— 這個模組只是把它**形式化並可替換**。測試可以 `install` 一個捕獲實例（或什麼都不裝＝舊行為）。**代價說出來**：模組級狀態在 vitest 平行 worker 裡是 per-process 的，`install`/`uninstall` 必須成對（teardown 呼叫 `close()` 即卸載） |
| 級別 vs 通道 | **分開**：`level` 是結構化欄位；未設模式的 console 通道**由呼叫的方法決定**（`warn`→`console.warn`、`error`→`console.error`）。**⚠ 修正（T1 複審量到的，2026-09-22）：通道與級別在 API 上等價，所以「`info` 級但走 stderr」不可表達。裁決：那五個非 error 形狀、而今天是 `console.error(...)` 的站點（`index.ts:178` help（exit 0）、`models.ts:343`、`roles.ts:287`、`provider.ts:222`、`run.ts:752`）**維持原樣、不遷移**，作為普查的**五個列名例外**（byte-identical、無結構化記錄）——**不**改 API（為五個 argv 站點造機制＝YAGNI），也**不**給它們 `error` 級（那是讓句子說謊）。普查因此＝**102 個分級 + 5 個列名例外**（**⚠ R11，2026-09-22：97 個分級 + 10 個列名例外** —— 五個 exit-0 的 `help` print 同屬這一類，實作時一併列名；位置見 §0.1 的更正）。**四個既有斷言（`bin.test.ts:39`、`metrics-summary.test.ts:25/32`、`models-command.test.ts:278-284`、`roles-command.test.ts:192-198`）是這條裁決的守衛。** | 逐位元組不變的要求（0.2）；T1 的 API 實況（複審 `index.ts:115-119`） |
| `[tag]` 與 CLI 前綴 | **msg 逐字保留**（不在此單元正規化；`[i-harness]` 16／`[plugin-registry]` 8／`[rewind]` 6／CLI 的 `provider:` 等）。結構化欄位新增 `phase`，**不**吸收 tag | 50/107 帶 tag；正規化是另一個決定，且有 95 個文字斷言在看 |
| `runId` | **每個宿主入口 mint 一次**（`randomUUID()`；run／sdk／acp 各自）；`run` 欄位記它 | tree 裡沒有 runId 可借（`activeId` 缺席於 storeless run、且 sdk/acp 是 per-session） |
| `DiagnosticPhase` | 新套件裡的**封閉 union**，由實測的縫列舉：`"cli"｜"config"｜"run"｜"turn"｜"sdk"｜"acp"｜"session"｜"mount"｜"telemetry"｜"shutdown"`（實作時以 107 站的歸屬微調，增減要在提交訊息說） | 今天不存在任何 phase 詞彙（0 命中） |
| 站點歸屬的 phase | 每站由**所在檔案的職責**定（assembly→`mount`；run.ts→`run`/`turn`；CLI argv→`cli`；state/install/trust→`config`；mcp/bridge→`mount`…）**⚠ 修正（T5 落地時量的，2026-09-22）：縫優先於檔** —— 判準是**發出訊息的那條縫**，不是檔案位置：`run.ts` 的五個 `[plugins]`／`[hooks]` 警告是 mount 縫自己的報告（組裝期跳過的 MCP server、不被承認的 frontmatter、無法解析的工具、載入不了的 hooks config、session/end handler 失敗），所以取 `mount`（`run.ts:486`、`:495`、`:507`、`:642`、`:802`）—— **而 `run.ts` 一個 `run`／`turn` 站點都沒有**（量測：它五個分級站點全是 `mount`，剩下的一個 `run.ts:776` 是列名例外、無 phase；`run` 在本樹只有 `index.ts:488` 一個站點，`turn` 則在樹裡沒有任何使用者）。上列「run.ts→`run`/`turn`」讀起來像位置決定，實作以本註記為準。 | 機械規則，批次套用 |
| `RedactedError` | 新套件定義：`{ name: string; message: string; stack?: string }`（都由 redactor 過），**衍生**（`fromError(err, redactor)`），不接受任意 Error 直塞。**⚠ 修正（T2 落地時量到的計畫缺口，2026-09-22）：`error(msg, data?)` 攜帶不了 caught value ⇒（修正前）`record.err` 沒有寫者、T4 的驗收③不可表達。四級簽名擴為 `(msg, data?, err?: unknown)`（`packages/diagnostics/src/index.ts:42-45`），`err !== undefined` 時在 `toRecord` 內衍生 `record.err = fromError(err, inst.redactor)`（`index.ts:166`；`toRecord` 收第三參數 `:156`），環境 handle 轉送它（`:282`）。呼叫端只給 caught `unknown` —— 不得自建、也不得預先 redact（§3.5 第 2 層改在 API 上強制）；`delegate` **不動**（`index.ts:128`，console 通道仍是唯一的逐字 `msg`），所以 T5/T6 的站點形狀 `.<level>(msg[, data])` 與 95 個 spy 斷言都不受影響。** | `failureReport`（`run.ts:253-270`）讀 message＋一行 stack；四條 llm adapter 的 `` `… request failed: ${status} ${await response.text()}` `` 是實測的洩漏路徑（`llm-openai-compatible:128`、`llm-openai:141`、`llm-anthropic:167`、`llm-gemini:163`） |
| redactor 的注入點 | **`apps/cli` bootstrap 建一個**：env 掃描（`/(KEY\|TOKEN\|SECRET\|PASSWORD\|PASSWD\|CREDENTIAL\|AUTH)/i` 且值 ≥ 8）＋ `settings.get().llm.providers[*].apiKeyEnv` 逐個 `credentials.resolve(ref)`；**`loadProviderRuntime()` 已回傳 `credentials`**（`provider-runtime.ts:50`；spec 的 `:24-26` 是舊樹）—— 修在**保留那個 handle 的呼叫端**（`index.ts:532,769`、`run.ts:398`），**零改動 `credentials` 與 `provider-runtime`** | §3.5 的障礙今天小得多；「永遠不要修在 credentials」 |
| §3.4（durable `operator/run-end`）／C1 | **不在本單元**（C 堆孤兒，自己的單元）；本計畫只留一行指標 | C1 的既有記錄 |
| 8 個 `?? console.warn` 預設縫 | **逐一改由環境實例承接**（hooks:364、session-persistence:251、schedule/driver:103、skills/registry:111、workflow/registry:27、plugin-registry/state:69、credentials:239；telemetry 自己的 sink-error warn 也走實例）—— 縫的形狀不動，**預設值變** | 站點以彼之縫到達實例，不必動簽名 |

### 0.4 閘門與母體

`pnpm verify:all` 是最終閘；**新套件帶 `test` script ⇒ 母體 66 → 67**（`verify-all.mjs:49-50` 數「有 test script 的 workspace 目錄」）—— **所有寫「66」的記錄在本單元後都是舊數字**，T7 一併更正。不 amend、無 attribution trailer、行號引用前先 `grep -n`。

---

## Global Constraints

- **未設 `I_HARNESS_LOG` ⇒ 逐位元組不變**：每個遷移站在未安裝/未設時的 console 呼叫（函式＋參數）與遷移前**完全相同**；全樹 30 檔的 spy 斷言是守衛，**一條都不准改**（T5/T6 的完成條件就是「這些測試檔的 diff 是空的」）。
- **`redactor` 按構造必填**：`createDiagnostics({…, redactor})` 沒有預設值、沒有 `undefined` 重載、沒有 `raw()` 逃生口（§3.5 的強制力第 1 層）。
- **殘餘要說出來**：v1 **不能**承諾「沒有秘密離開行程」—— 只承諾「沒有被**名稱、形狀或註冊**比對到的秘密離開」；`size()` 可稽核（§3.5）。
- **零依賴**（新套件）；**不動** `packages/credentials`、`packages/provider-runtime`。
- **reachability**：新套件的**每一個** export 要有非測試生產消費者，否則逐列 allowlist 附 `reason`＋`dated`（一列只管一列）。
- **既有測試案例一條不改**（除了新檔）；`≥8 字元` 的 env 掃描門檻與三個覆蓋掃描照 §3.5 逐條。

---

## File Structure

| 檔案 | 角色 | 任務 |
|---|---|---|
| `packages/diagnostics/{package.json,tsconfig.json}` | 零依賴腳手架（照 `harness-home`） | T1 |
| `packages/diagnostics/src/record.ts` | `DiagnosticRecord`／`Level`／`DiagnosticPhase`／`RedactedError` | T1,T2 |
| `packages/diagnostics/src/redactor.ts` | `createRedactor`（三趟掃描） | T3 |
| `packages/diagnostics/src/index.ts` ─ `createDiagnostics`（模式解析、child、close）＋環境實例（install/current） | T1 |
| `apps/cli/src/diagnostics-bootstrap.ts` | `runId` mint、redactor 建構（env 掃描＋apiKeyEnv）、install/close | T4 |
| `apps/cli/src/{index,run}.ts` | 三個入口的 install/close 接線；保留 `credentials` handle | T4 |
| 107 站的 34 個檔 | 分級遷移 | T5（apps/cli 60）· T6（packages 47） |
| `docs/handoff/2026-09-20-queued-work.md` | 普查更正＋W6 狀態 | T7 |

---

### Task 1: 套件 ＋ `createDiagnostics`（含逐位元組不變的模式）

**Files:** Create `packages/diagnostics/{package.json,tsconfig.json,src/index.ts,src/record.ts,test/diagnostics.test.ts}`

**Interfaces（照 spec §3.3 逐字）:**
- `DiagnosticRecord { ts; level: "debug"|"info"|"warn"|"error"; run: string; phase: DiagnosticPhase; msg: string; data?: Record<string, unknown>; err?: RedactedError; durMs?: number }`
- `createDiagnostics(opts: { stream?: NodeJS.WritableStream; level?: Level; runId: string; redactor: Redactor }): Diagnostics` — `{debug,info,warn,error,child(phase),close}`
- 環境實例：`installDiagnostics(d: Diagnostics): () => void`（回卸載）· `currentDiagnostics(): Diagnostics | undefined` · `diagnosticsFor(phase: DiagnosticPhase): Diagnostics`（取當前實例，無則回一個**委派 console** 的常駐 fallback）

- [ ] **Step 1: 紅測試**：①未設 `I_HARNESS_LOG`（且未 install）⇒ `diagnosticsFor("cli").warn("x")` 精確等於 `console.warn("x")`（spy 比對**函式與參數**；error 同理走 `console.error`）；②`install` 一個帶 `stream` 的實例 ⇒ JSONL 進 stream，**且不再碰 console**；③`=stderr` ⇒ JSONL 在 stderr；④`close()` 後卸載、再呼站點回委派；⑤`child(phase)` 綁定；⑥`redactor` 缺席 ⇒ **類型上不可構造**（`// @ts-expect-error` 一行）。
- [ ] **Step 2: 紅** → **Step 3: 實作**（模式解析：未設⇒委派；`stderr`⇒`process.stderr`；path⇒append；`level` 門檻只影響**記錄**，不影響委派通道）→ **Step 4: 綠**（`pnpm --filter @i-harness/diagnostics test`＋typecheck）→ **Step 5: commit**。

---

### Task 2: `RedactedError` 衍生 ＋ 洩漏 fixture

**Files:** `src/record.ts`（`fromError`）· Test: 擴 T1 檔或新檔

- [ ] **Step 1: 紅測試**：以四條 llm adapter 的**實測洩漏形狀**為 fixture：`new Error('openai-compatible request failed: 401 {"error":"bad key","echo":"Authorization: Bearer sk-live-ABC123"}')` ⇒ `fromError` 後 `.message` 不含 `sk-live-ABC123`、含 `[REDACTED]`；`.stack` 同樣過 redactor；`name` 保留。
- [ ] **Step 2-4**（紅→實作→綠）→ **Step 5: commit**。

---

### Task 3: `createRedactor`（三趟覆蓋）

**Files:** `src/redactor.ts` · Test: `test/redactor.test.ts`

**Interfaces（照 §3.5）:** `createRedactor(opts?: { extraRules?: readonly Rule[] }): { redact(value: unknown, key?: string): unknown; registerSecret(value: string): void; size(): { rules: number; secrets: number } }`

- [ ] **Step 1: 紅測試（三趟各正反）**：①**鍵名**（不分大小寫與分隔符：`api_key`／`API-KEY`／`apiKey` 命中；`monkey` 不中）；②**形狀**（`sk-…`、`Bearer \S+`、PEM block、URL userinfo、**只在像秘密的鍵下**的長 base64；`Bearer` 在一般散文裡的正向案例要指名）；③**已註冊值**（`registerSecret("corp-abc123")` ⇒ 精確子字串 ≥8 命中；7 字元**不**註冊）；④巢狀物件/陣列**遞迴**；⑤`size()` 回傳可稽核的計數；⑥**洩漏回歸測試**（§3.5 第 3 層）：一個含每個規則樣本的 payload 陣列 ⇒ 過 redactor 後**逐樣本斷言缺席**。
- [ ] **Step 2-4**（紅→實作→綠）→ **Step 5: commit**。

---

### Task 4: CLI bootstrap（runId、redactor、install/close 接線）

**Files:** Create `apps/cli/src/diagnostics-bootstrap.ts` · Modify `apps/cli/src/index.ts`（三個入口）· `apps/cli/src/run.ts`（保留 `credentials`）· `apps/cli/test/diagnostics-bootstrap.test.ts`（新）

**Interfaces:** `createCliDiagnostics(opts: { runId?: string; env?: NodeJS.ProcessEnv; settings?: SettingsStore; credentials?: CredentialStore }): { diagnostics: Diagnostics; uninstall: () => void }` —— `I_HARNESS_LOG` 在解析器裡；redactor 由 env 掃描（regex＋≥8）＋`settings.get().llm.providers[*].apiKeyEnv`→`credentials.resolve(ref)` 餵 `registerSecret`。

- [ ] **Step 1: 紅測試**：①`I_HARNESS_LOG` 未設 ⇒ `main([...])` 的 console 輸出與今天**逐位元組同**（用既有 spy 形狀）；②`=stderr` ⇒ stderr 出現第一條 JSONL（`run.` 是 mint 的 uuid、`phase` 合法）；③env 裡 `CORP_TOKEN=corp-abc123`（≥8）⇒ 一筆 diagnostics 記錄的 `data` 與 `err.message` 裡它被遮蔽；④**7 字元的值不註冊**；⑤`close()` 在四條 run 出口路徑（`run.ts:334/629/755/759`）與 sdk/acp teardown 都被走到（spy 釘 `close`）。
- [ ] **Step 2: 紅** → **Step 3: 實作**（三個入口 `install`＋`finally` 卸載；`run.ts` 的 `loadProviderRuntime().then` 保留 `credentials`；**行為不變**）→ **Step 4: 綠**（CLI 全測＋typecheck＋`--gate`）→ **Step 5: commit**。

---

### Task 5: 分級遷移 — `apps/cli` 60 站

**Files:** `apps/cli/src/{index,provider,run,roles,models,hooks,plugins,sessions}.ts` · 既有測試**不動**（它們就是驗收）

**規則（照 §0.3 的裁定逐類套用）:** 每站改成 `diagnosticsFor(phase).<level>(msg[, data])`，**msg 逐字**、**原 console 通道由未設模式保留**。級別表：

| 類別（recon 的計數） | level | phase（依檔案） |
|---|---|---|
| CLI usage error（17：argv/flag/子命令用法） | `error` | `cli` |
| CLI run/command failure（16） | `error` | `run`／`cli` |
| 十個列名例外（`index.ts:194` help、`models.ts:348`、`models.ts:364` help、`roles.ts:295`、`roles.ts:241` help、`provider.ts:227`、`provider.ts:254` help、`hooks.ts:161` help、`plugins.ts:443` help、`run.ts:776`） | **不遷移**（維持 `console.error` 原樣；§0.3 的修正 ＋ R11） | — |

**⚠ 修正（T5 落地時量的，2026-09-22；R10／R11 後定稿）:** 第 1 列的括號（`index.ts:178` 的 help **例外：`info`**）是 edit 殘留，照 §0.3 的 R1 更正 —— 那個站點（**現位置 `index.ts:194`**）是 exit 0 的 help print，屬列名例外、不遷移，而 `info` 級在這裡不可表達（級別即通道）；argv 的**錯誤**路徑（**現位置 `index.ts:203`**）才是本列的 `error`／`cli`。**R11** 把同類的五個 `help` print（`provider.ts:254`、`roles.ts:241`、`models.ts:364`、`hooks.ts:161`、`plugins.ts:443`）也列名，所以例外是**十個**：`index.ts:194`、`models.ts:348`、`models.ts:364`、`roles.ts:295`、`roles.ts:241`、`provider.ts:227`、`provider.ts:254`、`hooks.ts:161`、`plugins.ts:443`、`run.ts:776`（`run.ts:246` 是那條註解，不是站點）。**T5 遷移 50 站**（60 可執行 − 10 例外）：index 22／provider 9／run 5／roles 3／models 3／hooks 4／plugins 2／sessions 2。

**✅ 兩條裁定（R10／R11，2026-09-22）—— 這一節的結尾:** **R10**：`index.ts:488`（量測時為 `:486`）的 run 失敗報告**遷移**（`error`／phase `run`；msg 逐字，未設模式仍委派 `console.error`）。障礙是一個**測試量具**：T4 的案例 ② 與 ⑤×3 用「一個未遷移站點的 console 呼叫」當捕獲鉤子 —— 讓測試決定產品的形狀是錯的方向，所以裁定遷移，並在**另一個提交** `b6fbb42` 把鉤子搬到**實例被建構的地方**（`test/diagnostics-bootstrap.test.ts` 既有的 bootstrap double 現在連它建出的實例與當下的 slot 一起記下；`expectRunExitClosed` 逐條斷言「它曾是**已安裝**的那個」＋「已 detach ＋ 已 close」，報告的文字則改讀記錄的 `msg`）。鉤子的區辨力以三條突變重證（teardown 不 close ⇒ 四個 ⑤ 全紅；鉤子不記錄 ⇒ 四個 ⑤ 全紅；phase 改成 `cli` ⇒ 案例 ② 紅），各自回退並以 sha 驗回；該檔的「No site is migrated in this task」註解同時更正。**R11**：五個 exit-0 的 `help` print（見上）**回退為不遷移**，例外因此十個。**最終數字：** 普查 107 站＝**97 分級 + 10 列名例外**；`apps/cli` 60 站＝**50 分級 + 10 例外**；`--gate` 讀數 436 rows／3 NEW（`diagnosticsFor` 清除）。

- [ ] **Step 1: 遷移一批（例如 index.ts 23 站）** → 跑 `pnpm --filter <cli-pkg> test`：**既有 spy 斷言全綠即為驗收**（有任何文字斷言紅 ⇒ 遷移改變了 bytes ⇒ 修遷移，不是修測試）→ commit per 檔或小批（SDD 的批處理規則）。
- [ ] **Step 2: 其餘檔同法**（provider→roles→models→hooks→plugins→sessions→run）→ **Step 3: 全 CLI 綠＋`--gate`** → commit。

---

### Task 6: 分級遷移 — 16 個 package 47 站 ＋ 8 個縫預設

**Files:** 16 個 package 的 34 檔中的 26（packages 側）＋ 8 個縫的預設值（hooks:364、session-persistence:251、schedule/driver:103、skills/registry:111、workflow/registry:27、plugin-registry/state:69、credentials:239、telemetry.ts:11,13）

- [ ] **Step 1: 縫先行**：8 個 `?? console.warn` 預設改成「取環境實例、無則 console」的同一枚 fallback（縫簽名不動）→ 各套件測試綠。
- [ ] **Step 2: 逐套件遷移**（session-executor 13 → plugin-registry 8 → mcp-client 8 → 5×2 → 8×1；每包一提交或小批）—— **每包的完成條件＝該套件測試全綠（spy 斷言為守衛）**。
- [ ] **Step 3: 全 workspace 綠**（`pnpm -r --no-bail test`；母體此時 67）＋`--gate PASS` → commit。

**⚠ 修正（T6 落地時量的，2026-09-22）：本 Step 的「`--gate PASS`」在本次修訂不可達 —— 不追、不加 allowlist。** 實測：`pnpm -r --no-bail test` **綠**（母體 **67**、exit 0）；`node scripts/audit/check-reachability.mjs --gate` **exit 1、2 個 NEW row**＝`@i-harness/diagnostics#RedactedError`（黏著）＋`#Rule`（無消費者）。T6 清掉了第三個 `#currentDiagnostics` —— 消費者是**縫**，而且是**真實 import**：六個縫的 fallback 直接問 `currentDiagnostics()`（`packages/{skills,workflow,hooks}/src/…`、`plugin-registry/src/state.ts`、`credentials/src/index.ts`、`schedule/src/driver.ts`）。**T6 的普查**：packages 47 站＝**44 分級 ＋ 3 列名例外**（R13：`session-persistence/src/index.ts:251`、`telemetry/src/telemetry.ts:11,13`——第二參數是 `unknown`，`delegate` 只送一個參數，折疊不保證逐位元組）；全樹 107＝**94 分級 ＋ 13 列名例外**。**相位的兩個事實**（延續 T5 的「縫優先於檔」）：`turn` 不再是零使用者（`packages/compaction/src/index.ts:158` 的 fail-soft 摘要失敗，一次呼叫）；`run` 多一個（`packages/subagent/src/child.ts:76`，spawn 時的角色工具缺席警告）；`acp` 仍無站點。縫的**未設模式機制**因此有一條更精確的說法：預設值「取環境實例、無則 console」在原始碼裡是可見的兩分支，而未被遷移的兩個縫位置（R13）一字不動。

---

### Task 7: 收尾

- [ ] **Step 1: `pnpm verify:all`**（一次；母體 **67**；五步全綠）→ **Step 2: 記錄**：queued doc 的普查句（`:535`／`:934`）改成 §0.1 的指令與數字＋「舊指令壞在哪」；W6 兩列狀態（§1 表與 §9.2 A2）→ ✅ 附提交區間；`docs/superpowers/specs/2026-09-17-m3-measurement-foundation-design.md` 加 dated 註記（§3.3 的 stderr 斷言引用 `bin.test.ts:69` 已漂成 timeout 行；`provider-runtime.ts:24-26` 的障礙在現行為 `:50` 已回傳）→ **Step 3: commit**。

---

## Self-review（寫完後跑過的檢查）

**Spec 驗收 → 任務對映：** §3.3 介面逐字（T1）· `child(phase)`（T1）· 預設關閉＋`I_HARNESS_LOG` 三模式＋白話訊息保留（T1＋0.2 的 95 站守衛）· §3.5 的工廠與三掃描（T3）· 強制力三層（T1 的型別不可構造＋T2 的衍生＋T3 的洩漏回歸）· 已註冊值來源（T4）· 殘餘（文件＋`size()`）。**明說不做**：§3.4／C1、普查的 scripts/e2e 79 站、stderr.write 5 站、tag 正規化。

**風險張力（要讓複審看的）**：環境實例是**模組級狀態** —— `install`/`close` 成對的紀律靠 teardown 測試釘住（T4 的第 5 條）；若未來出現「同進程兩個宿主」的需求，這一條要先被推翻。
