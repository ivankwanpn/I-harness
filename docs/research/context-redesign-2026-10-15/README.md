# Context redesign evidence — 2026-10-15

主報告：[IH 上下文架構重審](../2026-10-15-context-architecture-reassessment.md)。
設計：[ContextEngine 重設計草案](../../superpowers/specs/2026-10-15-context-engine-redesign.md)。

此目錄保存研究證據，沒有產品實作。基線 IH `81bca938`；所有參考副本來自使用者指定的 `D:/ih_reference_project`。參考項目無 `.git`，版本取自 manifest，不把目錄名稱當作 release 認證。

`provenance.json` 保存首次研究提交 `1b605d0e` 前的文件／來源快照雜湊；其後設計與主報告的補充不回寫歷史收據。最新範圍／框架見 [拆分重合地圖](../../refactoring/2026-10-15-context-decomposition-overlap.md) 與 [開發框架](../../superpowers/specs/2026-10-15-context-engine-framework.md)。

| 檔案 | 內容 |
| --- | --- |
| [codex-audit.md](codex-audit.md) | Codex archive／active context、usage、compaction、wire、tools／children、API key／subscription |
| [dsh-zcode-audit.md](dsh-zcode-audit.md) | DSH direct path、ZCode 端到端比較及限制；DSH 多協議 bridge 另見下方 addendum |
| [pi-opencode-audit.md](pi-opencode-audit.md) | PI CLI／durable、OpenCode legacy／native／V2，保留實際不同路徑 |
| [unified-format-dsh-zcode.md](unified-format-dsh-zcode.md) | DSH／ZCode 的統一格式、原生回放 sidecar、完整 pi-ai 路由範圍 |
| [unified-format-pi-opencode.md](unified-format-pi-opencode.md) | PI／OpenCode 共用訊息型別、協議轉換和 IH 的比較 |
| [ih-independent-audit.md](ih-independent-audit.md) | 獨立反查 root 的 IH 控制，包含反例、既有保障、不可過度推論之處 |
| [design-review.md](design-review.md) | 設計審查與逐項修正確認；所有重要意見在設計階段已處理，不代表產品已實作 |
| [probes.ts](probes.ts) | 可重跑的離線控制；使用 actual IH projector/adapters/agent/reducer，網路禁止 |
| [probe-results.json](probe-results.json) | 最後一次控制輸出；token 欄位是估算或 synthetic anchor，不是 provider 實測 |
| [provenance.json](provenance.json) | 基線、主要來源檔案 SHA-256、manifest、執行環境與退出碼 |

從 repository root 執行：

```powershell
pnpm exec tsx docs/research/context-redesign-2026-10-15/probes.ts
```

腳本覆寫本目錄 `probe-results.json`，不修改使用者 session/profile。global fetch 被禁止；唯一 main model stream 使用 injected local Response；摘要是固定假模型。準備六種 route 的真實 payload 不呼叫其 transport。Bedrock 注入 fake runtime，不啟動 credential chain。

控制項目：

1. 同一語義工具回合的六 route measurement 與舊 meter 差異。
2. prune-only 成功後仍高於同一 prepared auto pressure threshold；hard gate 未被證明繞過。
3. 普通 preflight compaction 可 shadow 當前 user input；固定摘要故意不包含唯一字串，測的是沒有原文保護，不是模型摘要品質。
4. retained summary `maxTokens * 4` 實際是 JS 字元契約，與 projected tokens 不同。
5. arbitrary tool text 被複製到 sensitive user-instruction 模板；沒有測真實模型是否服從。
6. Anthropic moving cache marker 改變 prefix unit fingerprint，丟失 synthetic usage anchor。
7. malformed orphan tool result 可達 actual prepare；沒有打供應商，不能推論正常新 turn 都會發生。
8. 132,018,505 bytes raw JSONL event payload 經人工控制 checkpoint 選成 467-byte request；不等於 Desktop 冷啟動壓測。
9. 明確 full child fork 仍複製同樣的 raw event payload；預設 fork=none。

較早參考研究的舊版本與目前副本不可混用。文中對已確認的 source 說明、離線觀測、設計建議及尚待真實供應商驗證的事項分別表述。所有研究子代理使用 GPT 6.1 Sol。
