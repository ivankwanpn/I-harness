# IH Code Mode、快取與壓縮改善驗收

日期：2026-10-04，Asia/Hong_Kong。使用者指示「按照你的研究來」，本輪依 [Pi 研究](2026-10-04-pi-mcp-codemode-cache-compaction.md) 在 `D:/frontend-test`、`codex/desktop-workbench` 實作，基準 `d0eca79f`。另一個「子系統」要求已澄清專指 context-mode／claude-context 研究；其獨立提案見 [MCP 比較](2026-10-04-context-mode-and-claude-context-research.md)。

## 已實作

| 範圍 | 實際行為 |
| --- | --- |
| 穩定宣告 | Mixed 不重複 direct schemas、不預載完整 deferred schemas；only 可 inline direct，整份描述上限24,000 UTF-8 bytes。Live IDs 移到固定 `code_status` 結果，`code_wait` 描述不再隨 IDs 改變。 |
| 腳本探索 | `searchTools(query,limit=8)`，最多20項；query≤256 bytes、簡述≤320 bytes、row≤1,024 bytes。`describeTool(name/alias)` 提供一份完整 definition，超過min(16KiB,transfer cap)就明確拒絕。探索不 promote 工具、不改 broker／hidden／role／目前核准。 |
| JSON 恢復 | Versioned `code/store` 記成功寫入，成功 terminal及flush完成前不回報 completed。Dispose／resume／fork／child reconstruction 可恢復 JSON；rewind 的廢棄區間不重播。Globals、timers、workers、未完成 calls 不恢復。 |
| 長輸出 | Model text preview維持16KiB／4096 max output tokens、256 items。上游 admitted text在transfer cap內保存為spill引用，含bytes、完整／截斷狀態；default及configured host roots使用既有unified spill／GC。未被admit的bytes不宣稱保存。 |
| 快取設定 | Route `promptCache` 明確opt-in。Anthropic在final wire copy標記system／last tool／last suitable user or tool_result，保留signed continuation指紋。Responses opt-in使用opaque session affinity；不把Anthropic 5m/1h硬映射成OpenAI保留時間。 |
| 協議用量 | Responses／Chat／Gemini input包含cache；Anthropic／Bedrock排除cache。Adapter只加已知accounting標記，raw counters不改。未知、無效、零與未回報欄位有別；Chat亦支援nested cached_tokens。 |
| 上下文估算 | 有效正值usage校準精確system/tools/message prefix，再估算新增messages。Prune／summary／reset／rewind／binding／prefix變更，及失敗／取消使anchor失效。Budget、output cap和auto-compaction共用估算；cache reads仍佔context。 |
| 觀測與摘要 | `provider/context` 记录neutral component bytes與估算來源；`provider/cache` 记录是否實際回報與合法normalized rate。Summary usage走獨立 `compaction/usage`，agent assembly已接線。Provider截斷的摘要不提交checkpoint。 |

沿用既有角色／沙箱／核准／fatal policy refusal／Stop，grep等搜尋預算未擴大。沒有cache warmer或額外付費模型請求。

## 快取配置

在已配置的Anthropic route追加：

```json
"promptCache": { "mode": "automatic", "retention": "5m" }
```

Responses route可設 `{"mode":"automatic"}` 以使用session affinity。Absence保留原有payload，`{"mode":"off"}`移除本端適用的explicit metadata。`retention` 只套用Anthropic；Gemini／Chat不生成不支援的cache keys。Configured manual controls仍具優先權，request off則抑制explicit metadata。

One-off summary帶request off，原有original-message prefix及prune架構保留。此選擇可能放棄explicit Anthropic cache reuse；不能保證關掉上游automatic cache，亦不宣稱每種route都因此省錢。新的計量可用來量測這個取捨。

## 固定離線量測

Fixture：9 direct、24 deferred工具；1,200筆合成inventory；五次fresh worker runs。比較使用基準commit的actual description函式與目前model schemas，統計UTF-8 serialized bytes。

| 量測 | 改善前 | 改善後 |
| --- | ---: | ---: |
| Mixed Code Mode description | 18,725 B | 1,632 B |
| Model tool schemas，包含新增status | 26,386 B | 7,570 B，減少71.31% |
| Inventory原始JSON與聚合model result | 211,513 B | 242 B |
| 聚合正確性 | 1,200 records | 120 errors、totalBytes720600 |

五次VM完整執行約76.9–85.9ms；這包含fresh worker成本，並非provider latency。Discovery結果666B，沒有promote deferred schemas。36,000B Unicode text完整保留，preview16,383B；JSON dispose/remount與live-schema穩定性皆通過。

這是合成workload的資料量與功能驗證，inventory fixture沒有掛ordinary output spill guard。它不是實際provider tokenizer、cache hit、帳單、整任務品質或代表性效能A/B；不能把71.31%當成IH通用token節省率。[Raw measurement](D:/frontend-test/.superpowers/sdd/2026-10-04-pi-context-efficiency/measurement.json)。

## 測試、審查與完整 gate

新功能先觀測RED，再實作GREEN。獨立review先提出三個P2：async start跨owner store混用、agent compactor未傳telemetry、Code Mode spill不在既有GCroot。Root用控制順序／真實agent flow／actualGC各重現RED，完成修復後review回報READY。

第一輪完整gate：4,642 pass／13 skip／0 fail、71/71、types及E2E成功，但reachability因三個新unused exports失敗。修復使用既有 `checkBudget`（新增validated calibrated full-input參數，避免重複計費）及刪除兩個未用的新type reexports；沒有修改gate／allowlist。

**修復後完整 `pnpm verify:all` exit0：**

| 檢查 | 結果 |
| --- | --- |
| 全專案測試 | **4,645 passed、13 skipped、0 failed** |
| Population | **71/71** |
| 全專案typecheck | **exit0** |
| E2E | **12 passed、5 files** |
| Reachability | **PASS、沒有new rows** |
| 獨立source review | **READY，原三個P2已解決** |

Reachability提示三個既有allowlist entries已無live row，不豁免任何項目。Scoped adapter/settings/provider完整測試601項成功；初次並行run的一個既有watcher timing assertion，在isolated99/99 run及最後完整gate均成功，未改timeout或assertion。

完整紀錄：[final gate](D:/frontend-test/.superpowers/sdd/2026-10-04-pi-context-efficiency/verify-all-final.log)、[ledger](D:/frontend-test/.superpowers/sdd/2026-10-04-pi-context-efficiency/progress.md)。

## 成品驗證與交付

Desktop dist exit0，gateway203套件。從本輪portable app複製一份，使用其actual Electron44.4.5／Node24.21.0／tsx及shipped backend，驗證：

- actual assembly broker read／guest discovery／live status；
- actual JSONL coordinator close/reopen及fork恢復count7，globals仍undefined；
- 36,000B admitted Unicode text完整保存、16,383B preview；
- 外部唯讀reference內容未被write改動；
- 四個HTTP adapter的本機captured requests：Anthropic markers、Responses affinity、Chat／Gemini沒有不支援的generated key；
- cache-inclusive／exclusive accounting及next-step usage budget拒絕；
- real network calls0，所有owned processes／services／workers已關閉。

這是copied-app Node-mode實際backend proof，HTTP回應及usage是local synthetic fixture；Bedrock在scoped fake SDK tests驗證。沒有cloud/AWS認證或原有使用者session／credentials操作。[Native proof](D:/frontend-test/.superpowers/sdd/2026-10-04-pi-context-efficiency/packaged-owned/d01e1a12-5156-42b7-b200-f536aaa86a16/report.json)。29個本輪production檔案均與shipped source SHA256相同。[Parity](D:/frontend-test/.superpowers/sdd/2026-10-04-pi-context-efficiency/source-parity.json)。

- [Portable ZIP](D:/frontend-test/packages/desktop/release-pi-context-efficiency-2026-10-04/I-harness-Desktop-0.1.0.zip)
- [Desktop EXE](<D:/frontend-test/packages/desktop/release-pi-context-efficiency-2026-10-04/I-harness Desktop/I-harness Desktop.exe>)

ZIP211,765,733 bytes，SHA256 **`B7D0EF9874287802B2843496745151BF4CDC94E40E36ED4420C4B568FE5A6CDE`**。EXE與相鄰resources保持一起。

## 實際限制

Store是bounded JSON，不是continuation。`code/store`為non-ignorable事件，含此事件的session需要更新後runtime；舊版會明確拒絕未知事件。Append-only host flush failure不能撤回已寫bytes，replay依last terminal判決，terminal本身無法durable時仍屬storage-host限制。

Spill引用受既有age/sizeGC與目前read policy限制，不是永久blob保證；standalone runtime沒有mounted guard時需host擁有GC。Running observation可能還有buffered output，status list列executable/commit cells。Summary失效後，在下一個有效usage之前回退到heuristic估算。

所有reference checkout、原始報告、原session及credential檔保持唯讀。使用者原有 `electron.vite.config.ts` 的SHA256保持 **`EDE81F84EE9571D43587EFEEC4970F5FB2F54C54E2B2E9EE7FCA7B029C6D8085`**，不納入本輪提交。
