# 交付摘要：audit-fixes-v0.1.13（2026-11-05）

## 安裝檔

- 路徑：`packages/desktop/release/I-harness-Setup-0.1.13.exe`
- SHA-256：`1bd51031c369503c821dd17bdb620a7b88c0e8192b519345cb68f7dae3705961`
- 大小：189,650,784 bytes
- 版本：0.1.13（builtAt 2026-11-04T21:50:20Z）
- 分支：`experiment/audit-fixes-v0.1.13`

## 已修復的主要問題（可直接測試）

### 穩定性／資料一致性

- **D-01 durable job store**：subagent task 現在有 append-only job record（accepted→running→terminal）、document 重建、legacy fallback、owned 唯讀降級；document 遺失不再讓 registry 不可用。
- **D-08**：task document 寫入失敗只影響該 job，不再封鎖 spawn／無關任務。
- **D-07**：未結算的 document 寫入有 durable intent，reload 診斷看得到。
- **S-07**：rewind 先寫 intent 再還原檔案；未完成 rewind 會出現在 reload 診斷。
- **team completion 喚醒修正**：composed coordinator 下隊友完成後 Lead 會正常被喚醒（之前永遠不醒）。
- **team teardown**：task registry 已 retire 時 cleanup 降級，不再讓 service close 失敗。

### 效能

- **S-06**：session append 在 warm cache 只驗新增事件；document preimage／candidate 改 64 KiB 串流 SHA-256，峰值記憶體與文件大小無關。
- **A-12**：WSL distribution 檢查每個 backend 只做一次。

### 協議／UI

- **NG-08**：session/status 統一 `queued/running/completed/error/cancelled`，legacy 拼法可讀。
- **NG-11**：hook `permission: ask` 進入 approval seam。
- **NG-12**：核准規則變更後設定頁自動重讀。
- **D-05**：approval policy identity 不再因工具目錄變動而失效。
- **A-10**：shell 省略輸出有可見標記。
- **A-11**：owner abort 帶 `AGENT_ABORTED`；MCP Windows 關閉時終止整個行程樹。
- **S-10**：oversized header 明確回 `SESSION_HEADER_TOO_LARGE`。

## 驗證

- `pnpm -r --no-bail typecheck`：82 packages 全綠。
- agent-team composed 測試：120/120（ack 38、completion 13、transact 13、managed-transact 1、lifecycle 50、initial-input-proof 3、hooks 3）。
- subagent D-01／D-07：39/39。
- 其他修復皆有單檔測試（見 checkpoint）。

## 建議測試路徑

1. 安裝新版，重啟後開一個新 session，跑一次 `bash`／`pwsh` 大輸出與被截斷的命令（確認截斷標記）。
2. 建立 subagent／teammate，確認完成後 Lead 會自動被喚醒並看到結果。
3. 在設定頁新增／撤銷核准規則，確認列表即時更新。
4. 觸發一次 rewind（若可用），確認 reload 後沒有「pending rewind」警告。
5. 若使用 WSL sandbox，確認第一條命令之後的延遲明顯下降。

## 仍待架構重設計（尚未完成）

- S-08：fork 原子發佈（目前只排除 zero-byte 半成品）
- A-12：WSL worker 重用（需協議 v2）
- D-01 最後一步：移除可變 task document 寫入
- S-06 剩餘：document 大小上限／串流寫入的格式決策

方案與風險見 `2026-11-05-remaining-redesigns.md`，交接步驟見 `2026-11-05-handoff.md`。
