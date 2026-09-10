# L3 交接：web prompt UI（`/` 從唯讀檢視器變成能對話）

日期：2026-09-10 · 基線：**遠端權威** `origin/main` = `0d1d63fd`（本機 `main` 與它逐字相同）· 前置：`docs/audit/2026-09-10-ih-handoff-takeover-audit.md`（§0 兩條 M61 的分歧、§6 決定 A–D）

**一句話**：M61 §7b 的第一順位（L3）做完了。`i-harness web` 的 `/` 頁現在**可以對話**——送出 prompt、看串流、當場批准/拒絕工具、回答提問——而且它**沒有新增任何協議**：整頁只是 mux（`command` / `session` / `chunk` / `reasoning` / `approval` / `question`）的另一個客戶端。

---

## 1. 為什麼後端不用動

接手時先查證，L3 缺的**只有 UI**：`apps/cli/src/web.ts`（567 行）已經把每一條接縫都組好了——

| 接縫 | 位置 | 狀態（接手時就已存在） |
|---|---|---|
| mux `command`（跑一個回合） | `host.ts:576` → `executor.submit()` | ✅ |
| mux `session`/`chunk`/`reasoning`（串流） | `host.ts:584-628`，`live.ts` | ✅ |
| mux `approval` / `question`（兩條全域決策通道） | `host.ts:561-571`，`onApproval`/`onAnswer` at `:633-637` | ✅ |
| `ApprovalMuxBridge` / `QuestionMuxBridge` | `web.ts:436-439`，`executor.onAssembly` 每 session `attach` | ✅ |
| `POST /api/sessions`（開新 session） | `host.ts:1127` | ✅ |
| `GET /api/sessions/:id/events`（歷史，`afterSeq`/`beforeSeq`） | `host.ts:1579` | ✅ |

→ **本輪沒有改動 host.ts / mux.ts / types.ts / approval.ts / questions.ts 任何一行契約。** 唯一動到的產品檔是 `ui.ts`（頁面本身）。

## 2. 交付

| 檔 | 內容 |
|---|---|
| `packages/web-host/src/ui.ts` | 重寫成對話頁（仍然是**單一自帶 HTML**：零框架、零建置、零靜態資源）。session 清單（含 `+ new session`）＋ transcript ＋ prompt 輸入 ＋ approval/question 卡片。 |
| `packages/web-host/test/ui-page.test.ts` | 新，**11 測**：10 條在 `node:vm` 裡跑**頁面真正的腳本**（見 §3），1 條是**真 host + 真 socket** 的端到端。 |
| `docs/CAPABILITIES-DETAIL.md` | `i-harness web` 那列由「唯讀頁」改為「L3 對話頁」，寫明走哪幾個 endpoint。 |

頁面的行為：

- **送 prompt**：`{type:"open", streamId, endpoint:"command", payload:{sessionId, prompt}}`；回合進行中同一顆按鈕變 **Stop**（送 `{type:"cancel"}` 到同一條 stream）。
- **串流**：`chunk` / `reasoning` 兩條串流的合併文字**累積進同一列**（不是每個 frame 一列）；`assistant/message` 為權威結束。
- **落定後回讀 durable log**：`command` stream 回 `{status:"ok"}` 後，頁面重新抓一次 `/events`——**串流是為了即時，日誌才是真相**（chunk 是 25ms 合併的，日誌不是）。
- **approval / question**：兩條**全域**通道在 socket `onopen` 就開好（**必須在任何 agent 跑之前**——沒有開 stream 時發出的 approval 會被丟棄，然後由 fail-closed 逾時決定，永遠補不回來）。批准/拒絕/選項/自由輸入都送回對應的 `{type:"approval"}` / `{type:"answer"}`。
- 隱藏規則與 CLI/唯讀頁一致：`internal` 與 plugin-sourced 的訊息**不進** transcript。

## 3. 測試策略（為什麼不是「等瀏覽器開起來看」）

頁面是單一 HTML 字串，**沒有可測的內部函式**。所以測試改成**驅動真腳本**：

1. 從 `src/ui.ts` 的原始碼切出 `<script>` 內容（連模板插值都不經過，避免「模板寫壞了但測試照過」）；
2. 在 `node:vm` 裡執行，餵一個最小 DOM shim + 一個假 mux socket；
3. 斷言**頁面真的送出的 frame**（`payload` 的鍵名）與**真的畫出的 DOM**。

> **這條測試在本輪抓到一個真 bug**：兩條全域通道原本被登錄成 `"status"` 這個內部標籤，於是 `approval`/`question` 的 item 在 dispatch 的分支鏈上**全部落空**——卡片永遠不會出現。因為 vm 裡 `onmessage` 的例外會被吞掉（沒有 `window.onerror`），現場只會看到「什麼都沒發生」。修法是把標籤改成真實的 endpoint 名。**若只靠「開瀏覽器看一眼」，這個洞會在第一次真的需要批准時才炸。**

第 11 條是**真 host + 真 WebSocket** 的端到端：POST 建 session → 開 `session`/`chunk` → 開 `command` → 等 `ok` → 回讀 `/events` 斷言 `turn/start` / `assistant/message` / `turn/end` 都在。它釘住的是**伺服器那一側**的契約（endpoint 名、payload 鍵、落定訊號），與 vm 測試互補。

## 4. 驗證（實跑，非自評）

| 命令 | 結果 |
|---|---|
| `pnpm -r typecheck` | **exit 0**（全 workspace） |
| `pnpm --filter @i-harness/web-host test` | **17 檔 / 174 passed**（原 16 檔 / 163 → +1 檔 +11 測） |
| `pnpm test`（兩段閘門，**單獨執行**） | **exit 0** · **70/70 專案** · **323 測試檔 / 3,283 測試** · 0 失敗 |
| `pnpm test:quarantine`（第二段） | `case-027` **1 passed / 4,754ms** |

> ⚠️ **一個誠實標註**：第一次跑 `pnpm test`（與我自己的另一個指令同時進行）時 `packages/web-host` **紅了**，且 `pnpm -r` 因此**沒跑到 `apps/cli`**（69/70）。單獨重跑同一份程式碼 → **全綠**。所以那是一次**負載下 flake**，不是我的回歸；但它同時再次印證了接手核查 §1c 的那條閘門問題（`pnpm -r` 在壓力下會少跑專案，而失敗訊息不會告訴你少了哪些）。

### 4b. 真瀏覽器複驗（後補；L3 初次交付時**沒有**這一步）

初次交付只有兩層證據（vm 跑頁面真腳本 + 真 host 真 socket），**頁面本身從未在瀏覽器裡對真 server 開過**——這是我自己標記過的缺口。補測以 Playwright 驅動真 Chromium，對 `createWebServer` 起的真 server（`mockScript` 假模型，不碰 API、不花錢）：

```json
{ "title": "I-harness", "headerVersion": "I-harnessv0.1.0",
  "emptyList": "no sessions in this store", "composerInitiallyDisabled": true,
  "composerEnabledAfterCreate": true, "sessionRows": 1, "statusAfterSelect": "ready",
  "transcriptHasUserPrompt": true, "transcriptHasMockReply": true,
  "transcriptHasTurnMarker": true, "statusAfterTurn": "ready",
  "sendButtonLabel": "Send", "consoleErrors": [] }
```

**這一輪真的走完整條路**：按 `+ new session`（頁面自己 POST `/api/sessions`）→ composer 由 disabled 變 enabled → 點 Send → 執行器真的跑完一個回合 → 標記文字經「落定後回讀 durable log」出現在 transcript → 按鈕回到 `Send`、狀態回到 `ready`。**console 零錯誤。**

> **環境事實（本輪排障結論，值得記下）**：這台機器先前**跑不了** Playwright——DSH 內有 `playwright@1.61.1`，但它要瀏覽器 revision **1228**，而快取裡只有 **1217**（另一個較舊的 Playwright 用的）。補下載後可用：`chromium-1228`（Chrome for Testing 149.0.7827.55）與 `chromium_headless_shell-1228` 裝在 `%LOCALAPPDATA%\ms-playwright`。驅動方式是**從 DSH 的安裝位置 import**（`file:///D:/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/.../playwright`），所以 **I-harness 的 `package.json` / `pnpm-lock.yaml` 零改動**。

> **後續（同日晚）：改用 DSH plugin，上面那個臨時做法已淘汰。** 裝了 [`dsh-browser-playwright`](https://github.com/ChenyuHeee/dsh-browser-playwright)（`dsh plugin --profile web add dsh-browser-playwright` → 0.1.1），它把 **17 個 `browser_*` 工具**＋`ctx.browser` seam 掛進 profile，比我手寫 Playwright 腳本好得多（a11y 快照 + 穩定 ref、每 session 一個 browser context、截圖存附件）。實測可用。
> - **它需要 chromium revision 1243**（自帶 `playwright-core@1.63.0`），跟我下載的 1228 不是同一個——但**不需要下載**：它 `AUTO_CHANNELS = ['chromium','chrome','msedge','edge']` 會自動探測，本機已有 Chrome 與 Edge。
> - **載入需要重啟 `dsh web`**：bundle 清單在 loader 啟動時組成，`dsh.profile.bundles` 的新增**不會**隨新 session 生效（`patchReload: 'live'` 只管 `cordis.patch.yml` 的熱重載）。**這裡我先前判斷錯過一次**（以為開新 session 就夠）。
> - 它宣告的 peer 範圍 `@deepseek-ai/dsh-llm`/`dsh-tools` `>=0.1.0-rc.2 <0.1.0-rc.7` 與本地 DSH **`0.1.5-rc.1` 不符**，但 `dsh --profile web --dump-config` 顯示三個 row（`browser` / `browser-playwright` / `browser-tool`）**確實進了 composed tree**，且實跑 `browser_navigate` 成功——**版本落差沒有擋住載入**（至少目前沒有）。
> - 驗證指令：`pnpm dsh --profile web --dump-config`（**不會**啟動 server，是查「這個 profile 到底載了什麼」的正規方法）。

**仍然沒有涵蓋的**（下一輪候選）：**approval / question 卡片的真迴路**。`packages/web-host/test/host-routes.test.ts` 的 `withHost` 固定 `approveAll: true`（執行器永遠不問），唯一帶 `approvalBridge` 的測試是**手工掛 answerer**、不是由真的工具請求驅動。所以「工具被擋 → 卡片彈出 → 按下才執行」這條路目前**只有合成 frame 的證據**（`ui-page.test.ts`），沒有真迴路。**現在有 `browser_*` 工具可以直接從瀏覽器那一端驗它了。**

## 5. 已知邊界 / 殘留

- **重整（F5）後串流文字會消失一次**：`chunk`/`reasoning` 是 live-only（`subscribe()` 不重播歷史），所以「重新載入時正好有一個回合在跑」的那個回合，其**已串出的文字**不會回到畫面——但 `assistant/message` 落定後回讀日誌就會補上。這是既有 live seam 的性質，不是本頁引入的。
- **`ui: false`** 仍是純 API 姿態（`host-routes.test.ts` 的 B3-H3 測試照舊釘住 404 JSON）。
- **柵欄**：`/` 與 `/api/mux` 都走 M61 的 Host/Origin 柵欄與（可選）auth，與其他路由無異；本輪沒有放寬任何柵欄。
- 這台機器的 `C:\Program Files\I-harness` 仍是 **09-09 23:34** 的 bundle：要在安裝版看到 L3，得重建 installer。
- 接手核查 §6 的**決定 A（本機 20 個 settings commit 要不要救）仍然懸著**——你選了 A2（不救），但那些 commit 還在 `.worktrees/m61`，未推送、未刪除。

## 6. 檔案清單（本輪改動）

```
 M docs/CAPABILITIES-DETAIL.md
 M packages/web-host/src/ui.ts
?? packages/web-host/test/ui-page.test.ts
?? docs/audit/2026-09-10-ih-handoff-takeover-audit.md
```

未 commit（等你裁定）。`packages/tui` **未被改動**（TUI 凍結維持）。

---

## 7. 附帶發現：外殼工具的批准是不對稱的（**既有行為，非本輪引入**）

為了驗證 §5 那個「approval 卡片的真迴路」缺口，我用真瀏覽器 + 真 server（`approveAll` 未設）驅動了一次真的工具呼叫。**批准的迴路是通的**（`server.executor.onAssembly` → `approvals.attach(a.ctx)` 真的有掛上），但**卡片不會出現**——原因是路徑上平常根本不會有東西走到 ask：

```
◆ pwsh {"command":"Set-Content -Path '...\approval-ran.txt' -Value …"}
→ {"stdout":"","stderr":"","exitCode":0}          ← 直接執行，無卡片
```

真 socket 追蹤：`approvalItems: []`、`errorFrames: []`、`commandSettled: true`。

**根因**（`packages/guard-approval/src/index.ts`，`decide()`）：`SHELL_TOOLS = {bash, pwsh}` 這條分支**只在 `classifyDanger() != "none"` 時**回 `{kind:"ask"}`；指令被分類為安全時**掉到最後的 `return undefined`（= allow）**。

**最小重現**（同一個 `createApprovalPolicy`）：

| 情境 | 決策 |
|---|---|
| registry 有註冊 `pwsh`、`Set-Content …`（安全） | **無決策 → allow** |
| registry 沒有這個工具 | `ask`（not registered） |
| `write` 未給 `path` | `ask` |

→ **`write` 會問、未知工具會問，唯獨外殼工具不危險就不問**，儘管它們是 non-ReadOnly 且 `askForNonReadOnly` 預設 `true`。

**這不是打字錯誤，是被測試釘住的刻意行為**：`test/guard-approval.test.ts` 的 `Layer 3: harmless bash command executes` 用 `bash` + `echo hi` 斷言直接執行（同檔的 `Layer 1: non-readOnly tool asks` 用的是 `write`）。

**但 `decide()` 自己的註解與實作不一致**：它寫「Layer 1: readOnly tools need no approval / any other non-readOnly tool requires approval」。照那個契約外殼工具應該問。**裁定（同日）：不改行為，只讓註解誠實**——已修正 `src/index.ts`（頂部新增三層「as implemented」總表 + 兩處就地註記），並把測試名稱改為顯式（`…WITHOUT asking (deliberate: shells are the one Layer-1 exception)`），另補一條**判別性**測試：answerer 改成 `throw`，證明「不是被批准，是根本沒問」（沒有這條，「executes」無法區分兩者）。

**為什麼值得記住（安全邊界）**：外殼是唯一能跑任意指令的工具，而它現在**由 danger classifier 單獨把關**，那個 classifier 是 advisory 的（靠工具的 `getArgv` 解析）。同一個測試檔就記錄了它要撐住的繞過面：引號 `'r''m'`、metachar `; rm -rf /`、以及每個 basename 都安全但帶控制流的 `echo a; echo b`。**不要**把 Layer 1 讀成對外殼的保證——它是對「其他所有工具」的保證。

**附帶效果**：因為如此，web 頁面的批准卡在真實情境下**幾乎不可能出現**（除非 agent 剛好跑了被歸類為危險的指令）。§5 那個「只有合成 frame 證據」的缺口，答案不是路不會通，而是**平常沒有車走那條路**。

