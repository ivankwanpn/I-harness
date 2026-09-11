# 交接報告：transport 診斷 + DSH 瀏覽器外掛（2026-09-11）

分支 **`m62`** · 本文記錄的 commit **`82ed890`**（已推 `origin/m62`）
前一份：`docs/audit/2026-09-10-ih-m62-handoff.md`（作者的另一輪）

**一句話**：這輪補上「**連不上模型時說不出是哪一層壞**」這個診斷缺口（四個串流適配器 + model probe 路徑），並把 DSH 的瀏覽器外掛裝進本機的 `web` profile。

---

## 1. 交付

| commit | 內容 |
|---|---|
| `82ed890` | **feat(llm)**：transport 失敗改為指名層級，不再只說 `fetch failed` |
| `935daab` | **fix(cli)**：headless `run` 補 `--sandbox`，且預設讀 `settings.sandboxMode` |

未提交、也未動的：`D:\deepseek-harness\scripts\dsh-net-probe.mjs`（另一份 checkout，見 §6，**待裁定**）。

## 2. 為什麼做這個（不是我自己的偏好）

### 2a. 問題形狀

Node 把**所有**「拿到 HTTP 回應之前」的失敗塌縮成同一句 `TypeError: fetch failed`，真正原因只在 `err.cause`。實測四種：

```
DNS       -> fetch failed  <-  getaddrinfo ENOTFOUND host [ENOTFOUND]
壞 port   -> fetch failed  <-  bad port
TLS       -> fetch failed  <-  self-signed certificate [DEPTH_ZERO_SELF_SIGNED_CERT]
caller abort -> fetch failed <- AbortError
```

四個串流適配器**完全沒有 try/catch**，`fetch` 的 rejection 直接外洩，而 `core-agent`（`index.ts:266`）只把它包成 `model stream error: ${ev.error.message}` → **操作者看到的永遠是 `fetch failed`**。於是「公司代理」「baseURL 打錯」「TLS 檢測閘道」「機器離線」在訊息上**完全無法區分**。

### 2b. 外部佐證

上游 Q&A（`deepseek-harness` discussion **#175**，27 則留言）整個卡在這個點。社群最後收斂出的**決定性一步**是：

> 用**跑 harness 的同一個 Node** 做探針 —— **任何 HTTP 狀態碼（含 401/403/429）就代表 DNS+TCP+TLS 都通了，此時該停止調代理與 CA，改查 key／餘額／配額。**

也就是說：缺的不是修法，是**診斷路徑**。而 DSH 自己在**物件層**就是對的（`llm-deepseek/src/adapter.ts:661`）：

```ts
throw new LlmError(`DeepSeek API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
```

**它保留 `cause`**，只是沒把 cause 說進訊息裡。本輪補的就是那半。

## 3. 修法

| 檔案 | 改動 |
|---|---|
| `packages/llm-seam/src/index.ts` | 新增 `describeTransportError(label, url, error)`：走 `cause` 鏈（最多 5 層、每層保留 code）、點名 host、附 `NODE_USE_ENV_PROXY` / `NODE_EXTRA_CA_CERTS` 提示、caller abort 判為 abort 而非網路故障、原錯誤保留為 `cause`、**絕不含 header 或 key** |
| 四個串流適配器 | `openai-compatible` / `anthropic` / `gemini` / `openai` 的 fetch rejection 走它 |
| `packages/provider/src/index.ts` | `probeCandidate` 原本報 `GET <url> failed (network error)`（**層級整個丟掉**）→ 改走同一條 |
| `packages/llm-openai-compatible/test/transport-error.test.ts` | 新增 8 測試 |
| `README.md` | 新增「連不上模型（公司網路／代理／企業 CA）」一節 |

**兩個刻意的設計決定**：

1. **回傳真的 `Error`，不是字串** —— `core-agent` 讀 `ev.error.message`，回字串會退化成 `undefined`。
2. **`provider` 那條是最有價值的一處** —— 它是「**任何模型都連不上**」的流程（探針／目錄發現）。`timeout` 分支**不動**，因為 `DOMException` 自己就有名字。

## 4. 驗證（實跑）

| 命令 | 結果 |
|---|---|
| `pnpm -r typecheck` | **exit 0** |
| `pnpm test:default`（`--no-bail`） | **exit 0 · 70/70 包** |
| `pnpm e2e` | **12/12** |
| `llm-seam` / `openai-compatible` / `anthropic` / `gemini` / `openai` / `provider` | 28 / 22 / 18 / 19 / 16 / 85 |

**突變證明**：拿掉適配器的 try/catch → 新測試紅在 `→ fetch failed`（即修前行為）。
測試另外釘住：**DNS 與 TLS 的訊息必須不同**（修前是同一個字串）、提示字串存在、**不洩漏 key**、abort 分類、`cause` 保留、HTTP 錯誤狀態仍原樣回報（沒有過度修正）。

**方法論教訓**：跑閘門時**不要同時編輯**。我第一次跑 `pnpm -r typecheck` 得到 `exit 2`，因為背景閘門正好在我改 `provider/src/index.ts` 的中間狀態取樣（import 還沒落地）。乾淨重跑即 0 錯 —— 這是**競態**，不是回歸。

## 5. DSH 瀏覽器外掛（本機 `web` profile）

裝的是 [`ChenyuHeee/dsh-browser-playwright`](https://github.com/ChenyuHeee/dsh-browser-playwright)（MIT）：a11y snapshot + 穩定 ref 的瀏覽器自動化，17 個 `browser_*` 工具。

```sh
cd D:\deepseek-harness
pnpm dsh plugin --profile web add dsh-browser-playwright
```

**驗證**：

| 檢查 | 結果 |
|---|---|
| profile 註冊 | `dependencies` + `dsh.profile.bundles` **自動加入** ✅ |
| composed tree | `browser` / `browser-playwright` / `browser-tool` 三個 row 都在 ✅ |
| `lib/*.js` 載入 | `service` / `playwright` / `tool` / `injected` / `snapshot-render` **全部 OK** ✅ |
| `playwright-core` | 1.63.0，**沒有 nested cordis**（無重複實例風險）✅ |
| 瀏覽器 | 系統已裝 **Chrome + Edge** → provider 自動探測可用，**零下載** ✅ |

**⚠️ 兩件要注意**：

1. **peer 範圍宣告不符**：外掛宣告 `@deepseek-ai/dsh-llm` / `dsh-tools` 為 `>=0.1.0-rc.2 <0.1.0-rc.7`，而本機 runtime 是 **`0.1.5-rc.1`**。pnpm 只給 `[WARN] Issues with peer dependencies found`。三行都實際載入成功，所以**目前沒壞**，但這是宣告與實況的落差，值得記著。
2. **本 session 用不到它**：plugin loader 的 bundle 清單是**啟動時**組成的，所以 `browser_*` 工具在**重啟 `dsh web` 之後**才會出現在新 session（`patchReload: 'live'` 只管 `cordis.patch.yml`）。**我沒有重啟** —— 那會中斷你正在用的這個 session。

**一個發現（好消息）**：`Playwright 1.63` **已移除 `page.accessibility`**（實測 `undefined`）。但本外掛**不依賴它** —— 它用 `injected.js` 在頁面內自建 a11y tree 並以 `data-dsh-ref` 標記元素（`playwright.js:561` 用 `locator('[data-dsh-ref=…]')` 取回）。全檔掃過 `\.accessibility\b|_snapshotForAI` → **零命中**。所以 1.63 的移除**不影響它**。

## 6. headless `--sandbox`（§7b 第 2 項，**已完成**）

`i-harness run` 原本是**唯一還在實質無沙箱跑外殼的介面**。機制：`run.ts` 讀 `opts.sandbox`（`...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {})`），但 **CLI 沒有任何旗標可以給它** —— 所以不論 `settings.sandboxMode` 寫什麼，headless 一律**不傳沙箱**。`web` 在 `891db14` 接好了、TUI 有自己的路徑，headless 是漏掉的那個。

**修法**（`935daab`）：

- `run` 新增 `--sandbox read-only|workspace-write|danger-full-access`
- **未給旗標 → 讀 `settings.sandboxMode`**，與 web 路徑完全一致
- 值在 **CLI 解析**，不是塞進 `runHeadless` —— `HeadlessOptions` 保持「embedder 契約：unset = 不要求沙箱」的語意，所以匯出的 API 與 `__dist-selfcheck` 行為不變
- **無效值／缺值直接拒絕（exit 1），不默默 fallback** —— `--sandbox readonly` 被當成 workspace-write，就是 web 那次修掉的同一種假保證
- 讀之前一定 `await settings.load()`：**未 load 的 `SettingsStore` 會回傳預設值**，這正是當初讓 web 測試「沒碰到設定卻通過」的陷阱
- usage 與 help 都更新，旗標才被發現

**驗證**：`pnpm -r typecheck` 0 錯、`pnpm test:default` **70/70 全綠**、`pnpm e2e` 0 錯、`apps/cli` **117 passed + 1 skipped**。
新增 4 個 spawn 測試（決策在 CLI 參數處理，`runHeadless` 看不到）：無效值被拒且訊息正確、缺值被拒、help 有列旗標、有效值能通過驗證。
**突變證明**：停用驗證分支 → 兩個測試紅在 `expected +0 to be 1`。

## 7. 殘留 / 待裁定

- **`D:\deepseek-harness\scripts\dsh-net-probe.mjs`**（未提交）：一支網路診斷探針，會先安裝 DSH 自己的 outbound 政策再探測，然後把失敗歸類到 DNS / TCP / TLS-TRUST / TLS-ALERT / PROXY。已測過四種分類都正確。使用者裁定「等有問題再解決」→ **建議刪掉**保持 checkout 乾淨；要留就做成 `dsh net-probe` 子命令（否則只有拿 checkout 的人能用）。
  - 過程中的一個**假陰性教訓**：第一版沒安裝政策，設了壞代理時它**照樣回報「網路正常」**（因為 DSH 的代理不靠 Node 讀環境變數）。**驗這種東西只能驗行為，不能驗 config**（該 library 不會出現在 `--dump-config` 的 composed tree）。
- **`case-027`**：本輪隔離閘門跑過 **5180ms 綠**。先前紅過一次並讀到 marker 時間軸，指向一個**具體假設**：`host-027.ts:371` 的 `pollMarker("request-exit", 120_000)` —— host 自己的 **120s 上限比 referee 的 150s 場景預算短**，所以 host 永遠先放棄，量到的不是真病因。**此假設尚未驗證**。
- **installer 未重建**：§4d 的 `workspaceWarning`、本輪的 transport 診斷與 `--sandbox` **都還沒進安裝版**。
- **per-session workspace 執行**未做（server 仍是單一 workspace）。
- **一位 verifier 的操作失誤（記錄下來免得重犯）**：清理 smoke test 殘留行程時，我用**時間窗**（最近 12 分鐘）而非**指令列特徵**（`--headless`）來挑選，誤殺了使用者可能有頭瀏覽器行程。**驗證要留下痕跡才不會誤刪**；後續改用 `CreationDate` + `CommandLine` 比對 `--headless`。

## 8. 下一步（建議順序）

1. **`case-027`**：驗證 §7 那個「host 120s < referee 150s」的假設（若成立，修的是預算關係而非測試內容）。
2. **installer 重建** —— 否則本輪三個 commit 與 §4d 的改動使用者拿不到。
3. 其餘殘留見 §7。
