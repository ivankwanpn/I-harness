# 工作階段儲存（Session store）選擇

I-harness 有兩個持久化後端：

| 後端 | 佈局 | 狀態 |
| --- | --- | --- |
| **legacy JSONL** | `<sessionDir>/<id>.jsonl`（另加 `task-<id>.doc.jsonl`） | **預設** |
| **commit log（SCL）** | `<sessionDir>/<id>/session.v15.jsonl`（append-only，單一 commit 為持久點） | **opt-in** |

commit log 的設計、驗證狀態與已知缺口見
[design/2026-11-06-session-commit-log-status.md](design/2026-11-06-session-commit-log-status.md) 與
[design/2026-11-05-session-commit-log-redesign.md](design/2026-11-05-session-commit-log-redesign.md)。

## 如何選擇

四種方式，優先序由高到低：

| 方式 | 寫法 | 適用 |
| --- | --- | --- |
| 1. host 選項 | `createDesktopHost({ sessionStore: "commit-log" })` | 內嵌 host 的程式 |
| 2. CLI 旗標 | `i-harness run "..." --session-store commit-log`（同樣可用於 `sdk`、`acp`、`sessions`） | 命令列 |
| 3. settings 文件 | `settings.json` 的 `{ "sessionStore": "commit-log" }` | Desktop／CLI 共用 |
| 4. 環境變數 | `IH_SESSION_STORE=commit-log` | 腳本、CI |

settings 的合法值是 `"jsonl"` 與 `"commit-log"`；其他值會被視為「未設定」，回落到下一順位。
顯式值一律優先於預設：沒有任何人指定時才是 legacy JSONL。

## 如何確認目前用哪個

- Desktop：**設定 → 工具與環境診斷** 的「工作階段儲存」區塊會顯示 `Commit log` 或 `JSONL`；
- RPC：`desktop/environment/diagnostics` 的回應含 `sessionStore` 欄位；
- CLI：`i-harness sessions list --session-dir DIR --json` 能列出哪一個 store 的會話，就是目前生效的 store。

## 既存工作階段的處理

- commit log 可以**讀取**既有的 legacy 會話（formats 6–14 的 adoption 已由測試固定；首次寫入時會發佈一個 v15 generation）；
- 切換到 commit log 後，**既有 legacy 會話仍會出現在列表**（`list()` 會合併 legacy ids），也能以 id 讀取／繼續，因此切換 store 不會讓舊會話「消失」；
- **反方向不對稱**：切回 legacy 時，commit log 寫的會話（`<sessionDir>/<id>/session.v15.jsonl`）**不會被 legacy 列出**——legacy 只掃 `<id>.jsonl`。資料仍在磁碟，切回 commit log 即可再看到；這是刻意的現況，不是資料遺失（由 `host-store-legacy-invisible` 測試固定）。
- 舊格式（6–12）的 **byte 樣本**仍需由舊版本錄製，dual-run corpus 目前維持 13/14；
- legacy 會話的位元組不會被改寫：只有在該會話第一次被寫入時，commit log 才會建立自己的 generation。

## 目前限制（2026-11-06）

- commit log 仍是 **opt-in**；預設後端不會被切換，legacy coordinator 也尚未刪除；
- selected-results 繼承可用（含 nested fork），但沒有 legacy 的 held-observation **lineage／revocation 見證**；來源被刪除時，inherited 讀取不可用。移植計畫見
  [design/2026-11-06-selected-source-port-plan.md](design/2026-11-06-selected-source-port-plan.md)；
- `pnpm store status` 在本機可能回報 store mutation（環境／pnpm 版本層，已用全新安裝證明非 repo 狀態），不影響 install 與測試。

## 相關驗證

- SCL 測試面：host 45、`session-commit-log` 38、commit 系列 43、CLI 6、SDK 74（合計 **206**）全綠；
- 品質閘門：typecheck、package boundaries（147 = baseline）、reachability、bench（per-machine baseline）；
- 詳細清單與重跑指令見 [design/2026-11-06-session-commit-log-status.md](design/2026-11-06-session-commit-log-status.md) §5–6。
