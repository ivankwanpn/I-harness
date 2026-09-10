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
