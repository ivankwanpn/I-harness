# I-harness M20-M25 後端完整里程碑設計（2026-08-26）

> 里程碑輪：M20-M25。範圍：前端（web/tui/desktop）之前，完成後端核心能力覆蓋——讓 agent 在 Windows 環境中可靠工作的全部能力（Linux 順帶、未測試）。
> 決策產出於 2026-08-26 brainstorming 對話；依「吸收而非移植」原則操作。

## 1. 全域範圍與原則

### 1.1 目標
在「前端（web/tui/desktop）之前」完成後端核心能力覆蓋——讓 agent 在 Windows 環境中可靠工作的全部能力。

### 1.2 全域約束（binding）
- 版本 `0.1.0`、ESM、strict TS（`strict`/`noUnusedLocals`/`noUnusedParameters`）、pnpm workspace
- 零新外部依賴原則——新增依賴需在里程碑設計中明確列出並說明理由（zod 已有；koffi/ripgrep/tsx 已有先例）
- 模型僅 openai/anthropic 兩協議（`@i-harness/llm-openai`、`llm-openai-compatible`、`llm-anthropic` 當基準；**不新增 gemini/bedrock/內嵌模型**）
- 平台：Windows 優先且是測試主戰場；Linux 路徑保留但明確標「順帶、未測試」；macOS 維持 fail-closed
- Fail-closed 紀律、`CURRENT_FORMAT_VERSION` 版本化、名稱/id 格式約束等 M 系列既有準則繼續適用

### 1.3 吸收而非移植原則（本輪新增 binding）
- 每個里程碑**啟動第一步 = 研究**：讀 dsh/codex 參考實作，產出「採用 X / 改良 Y / 丟棄 Z」結論文件（落盤 `.superpowers/research/`），機制同 M19
- 參考代碼只作為輸入；最終代碼必須（a）符合 §1.2 全域約束，（b）無 `@deepseek-ai/*`、無 dsh 私有庫 imports，（c）若 dsh/codex 寫法有缺陷或與 I-harness 架構衝突，應**重寫**而非照抄
- 若確實吸收片段代碼：保留 MIT 版權聲明（THIRD_PARTY_NOTICES 或檔頭註記）
- 補充（2026-08-26 使用者指示）：**不一定移植源碼，如果有問題或更好的寫法，只吸收後重寫成適合 I-harness 的代碼**

### 1.4 例外確認（已在澄清問答中確定）
- **納入**：PTY/terminal、todo/goal、skills-as-plugins、workflows、telemetry
- **排除/延後**：gemini/bedrock/內嵌模型（模型只做兩協議）; macOS 沙箱; 遠端沙箱（e2b 型）
- **workflows 與 skills 兩者獨立**（不相依）
- **M14 遺留項**（attachment store、I3 遮罩、image-aware compaction replay）**納入 M20**
- **goal 先不做**（2026-08-26 使用者決定）：從 M21 移除，記錄為延後項目

## 2. 里程碑一覽

| 里程碑 | 主題 | 內容 |
|---|---|---|
| **M20** | 模型可靠性 | provider retry、budget enforcement、overflow auto-compact（prompt_too_long）、M14 遺留（attachment store + image-aware replay + I3 遮罩） |
| **M21** | 工具補齊 | apply_patch/edit（mtime 檢查）、todo 工具、tool-output-spill-files（goal 延後） |
| **M22** | Windows 安全完整 | win32 讀隔離（研究驅動）、consent gate 強化、Windows sandbox 邊界測試 |
| **M23** | Session/Interop 健壯 | MCP auto-reconnect、resume fixes（M19 Minor 4）、跨進程 exactly-once、多進程鎖 |
| **M24** | 子代理/團隊補齊 | skills-as-plugins（deferred 檢索）、workflows（YAML + exec）、subagent/team resume-wakeup 邊角、subagent 補全 |
| **M25** | 工程收尾 | e2e 層、telemetry 出口、M19 文件狀態收尾、目錄清理 |

## 3. M20 模型可靠性（模型里程碑）

**目標**：模型層目前缺 provider retry、budget/overflow 防護、M14 遺留項。本輪第一批——其他里程碑（工具/安全/子代理）都依賴模型層的可靠性。

### 3.1 組件

**① provider-level retry / bounded request recovery**（`@i-harness/provider`）
- 目前只有 tool-level retry（guard-retry），無 provider-level retry
- `ModelClient` 介面增加可選 `retryPolicy?: { maxAttempts, backoffMs, retryableErrors }`；`buildModelClient` 包裝 retry
- 可重試：429/5xx/網路錯誤（ECONNRESET/ETIMEDOUT）；不可重試：4xx 非 429（auth/validation）、abort
- **stream 重啟安全**：只在未開始產出（或可從頭再 stream）時重試
- dsh/codex 參考：provider retry 策略、`retry-after` 尊重（codex）

**② budget enforcement + overflow recovery**（`@i-harness/token-meter` + `@i-harness/compaction`）
- `resolveContextWindow`（M15）→ budget = `contextWindow - reserve`；agent loop turn 前檢查 token
- 超限 → **觸發 auto-compact**（M11 compaction 引擎現成，加觸發點）；compact 仍不夠 → `prompt_too_long` 錯誤（fail-closed）
- 觸發點：M11 `selectShadowableRange` 已做；新增「turn 前檢查 + 自動觸發 compaction + 錯誤分類」
- codex 參考：`prompt_too_long` auto-compact（但 codex 是 full-compaction；I-harness 用 shadow-projection）

**③ M14 遺留項**
- **I3 遮罩**：`projectImagesForTextModel` 補 masking（圖像不在模型上下文時，確保圖像不出現在 assistant 訊息）
- **attachment store**：保存原始圖像檔（檔名/UUID、mime、data、位置）
- **image-aware compaction replay**：compaction 摘要不得丟進圖像引用；重新播放原始圖像檔
- dsh 參考：`unified-image-request-pipeline`、`attachment`

### 3.2 資料流/錯誤處理
- Turn 前：`estimateTokens(messages)` → 與 budget 比對 → 超限 → `autoCompact()` → 失敗 → `prompt_too_long` error
- Stream 中：provider error → retry 判定 → 可重試流重啟；不可重試 → 上拋
- Provider error 分類：`retryable`/`non-retryable`/`abort` 三種

### 3.3 測試
- unit：retry 判定/backoff/分類；budget 計算/觸發/auto-compact
- integration：mock client 模擬 429/5xx/網路錯誤；streaming 重啟（開始產出後不重試）
- 新測試檔：`packages/provider/test/retry.test.ts`、`packages/token-meter/test/budget.test.ts`、`packages/core-agent/test/overflow.test.ts`

### 3.4 dsh 吸收注意
- I-harness 用 `ModelClient`/`LLMStreamEvent`/`parseSSE`；**不照抄 dsh `llm-provider-*` 代碼**，只吸收 retry/budget 概念
- codex 的 prompt_too_long 是 Rust 且 full-compaction；**改為 I-harness 的 shadow-projection compaction**

## 4. M21 工具補齊（工具里程碑）

**目標**：fs 目前只有 read/write/list_dir 3 個工具；補上 agent 日常作業核心工具。

### 4.1 組件

**① apply_patch / edit 工具**（`@i-harness/fs` 擴充）
- `edit`：`{ path, old_string, new_string, replace_all? }`（原子替換、找不到 wildcard 範例）
- `apply_patch`：`{ patch_content }`（structured diff；新增/刪除/修改檔案；多檔批次）
- 共用 `resolvePath`；**檔名+mtime 檢查**（不導入保守 File 鎖——M23 做跨進程鎖）
- dsh 參考：`apply-patch`、`tool-apply-patch`；codex：`apply_patch`

**② todo 工具**（新包 `@i-harness/todo`）
- `todo`（todo_list/create/update/delete），**session-scoped**
- 狀態持久化到 session event log（resume 可恢復）
- **goal 延後**（2026-08-26 使用者決定）：todo=細粒度清單；goal=高層目標+prompt 注入（後續評估）
- dsh 參考：`goal/command-goal`、`goal/goal`（僅設計參考，不做 goal）

**③ tool-output-spill-files**（`@i-harness/output-retention` 擴充）
- 超過保留限制時，把完整輸出寫到 workspace 的 `.i-harness-spill/<uuid>.txt`，回傳「已寫到檔」marker + 前後段
- spill 清理：run 結束清理（或 session-garbage）；spill path 在 sandbox（寫入需在許可寫入的 workspace）
- dsh 參考：`tool-output-spill-files`、`output-retention`（已有 head/headTail；spill 超出時寫檔）

### 4.2 資料流/錯誤處理
- edit/apply_patch：`resolvePath` → 讀檔 → 檢查 mtime/hash → 比對 → 寫檔 → 回傳 diff；**mtime 不符 → 拒絕**（防 concurrent modification）
- todo：session event 寫入；`createSession` 建立後掛 `onAppend` 用 session log 作真源；resume 時從 log 重放
- spill：retention 觸發時決定「保留 head/tail + 寫檔」；spill 檔名含 session id 前綴

### 4.3 測試
- apply_patch/edit：unit——新檔/修改/刪除/diff 應用；mtime 衝突拒絕；多檔批次
- todo：unit——create/update/狀態/pts 持久化（resume 重放）
- spill：unit——超過 retention 寫檔、spill cleanup、sandbox 內寫入

### 4.4 token 成本注意
- apply_patch/edit 是 diff 低 token；todo 每輪注入（agent 每 turn 見 todo 狀態）
- **goal 不注入**（延後）

## 5. M22 Windows 安全完整（安全里程碑）

**目標**：Windows 是目前唯一測試平台；目前 win32 沙箱是 partial（寫入限定 + job object kill-on-close，**無讀隔離**）。M22 補到「Windows 環境可靠」完整性並強化 consent gate。

### 5.1 組件

**① win32 讀隔離**（`@i-harness/sandbox-windows-acl`）
- 目前：restricted token + DACL grant-write（temp/workspace）+ job object kill-on-close；**未攔讀**
- 目標：**讀隔離**——restricted token 下禁止讀（除非明確授權）
- 用 DACL remove-read（DENY ACE 到檔/目錄讀許可，保留讀受限子集：workspace、temp、系統必需）
- 需要更嚴格 DAC 策略；降低權限 UAC token 思路（`NtCreateToken`/`CreateRestrictedToken`+job object+**AppContainer**）
- **關鍵決策（研究驅動）**：先研究 dsh/codex 的 Windows 沙箱做什麼，吸收其設計。若 dsh 只做 partial，M22 維持 partial 加**強化監視/擴展**（如新增檔/目錄白名單、限制 program files 讀取）
- **期望**：代理只能讀 workspace + temp + 明確允許的共享檔（如 C:\Users\Public?）；拒絕讀其他
- **限制**：Win32 讀隔離棘手（DLL/系統依賴讀取、程式啟動）。可能只能做到 partial——**研究後再決定完整性界限**

**② consent gate 強化**（`@i-harness/guard-approval`）
- 目前：approval 三層（readOnly→write 白名單→dangerous argv/metachar）
- **強化**：極度危險 argv（`rm -rf`、`format`、`diskpart`）——要求「這個操作將刪除 xx」的直接命令模式 consent（dsh 有此）；單一危險命令一次性 approve
- **approval gate 是真正安全邊界**（ defense-in-depth：與 sandbox partial 互補）；M22 把 approval gate 補完（記住永久授權「remember」勾選？——待定）
- dsh 參考：`direct-command-mode`

**③ Windows sandbox 邊界測試**（`@i-harness/sandbox-windows-acl` 測試補強）
- 測試沙箱實際阻擋（讀寫阻擋、寫出 workspace、kill-on-close、syscall 限制）；列出哪些**無法**被攔截（如：進程啟動任意 DLL?）
- 邊界測試確保沙箱失效時（fail-closed）不誤導使用者

### 5.2 資料流/錯誤處理
- sandbox：DACL grant-write/remove-read 後 → `spawnSandboxed` → job object；失敗檔 → `SandboxUnavailableError`（fail-closed）
- approval gate：`getArgv` 分類 → 直接命令模式 → 一次性 `SecurityDecision`；approval answerer（CLI 目前只有 approveAll）——M22 不加 UI，只加「approval answerer 介面」+ 測試

### 5.3 測試
- unit：DACL 修改（grant-write/remove-read）、申請該檔讀取測試、job object
- integration：實際 spawnSandboxed 進程試讀檔案（讀不到）+ 寫 workspace（寫得到）
- approval gate：consent 測試（dangerous argv 需明確 consent、remember 勾選）
- **Windows-only 測試**：標記 `describe.skip`（非 Windows 平台）

### 5.4 dsh 吸收注意
- dsh 的 `windows-acl-restricted-token-sandbox`、`cross-family-fs-sandbox`——但 dsh 也未完整讀隔離？（研究）
- codex 的 Windows sandbox：restricted token + Job + DACL（同 I-harness 已做）→ 可能 M22 = 先研究、再決定完整性界限（若只能 partial 記錄 + 強化 consent gate 補償）

## 6. M23 Session/Interop 健壯（健壯里程碑）

**目標**：補 M4/M6/M7/M8/M9/M10/M19 已知健壯性缺口——MCP auto-reconnect、resume fixes、跨進程 exactly-once、多進程鎖。提升「長期恢復可靠性」。

### 6.1 組件

**① MCP auto-reconnect**（`@i-harness/mcp-client`）
- 目前：stdio + streamable-http、無 reconnect——連接斷開後靜默失敗
- `McpMountHandle` 增加 reconnect：stdio child process 斷開/exit → 轉生（重新 spawn、重新 initialize、`syncTools` 重同步）；streamable-http → 指數退避重連
- 重連後 `syncTools` 確保工具 schema 重載；**掛載 handle 保持有效**；**重連上限** maxRetries；無法重連 → fail-closed（上拋）
- dsh 參考：`mcp-client-auto-reconnect`

**② resume fixes（M19 Minor 4 + M6 邊角）**
- 目前：M19 Minor 4——resume 時 subagent AgentRegistry 為空，teammate 喚醒（`followup_task`）會 no-op
- 修復：resume 時重建 AgentRegistry（`restoreState` 從 snapshot 重建 agent 索引，或「惰性重建」）；保證 team/subagent wakeup 可用
- dsh 參考：可能的 `state-persistence`/`subagent` 重整

**③ 跨進程 exactly-once**（`@i-harness/session-persistence` 新）
- 目前：同進程、單 session 操作；跨進程可能 double-apply
- 目標：`SessionCoordinator` 增**分布式互斥**（file lock? / SQLite `BEGIN EXCLUSIVE`?）——保證跨進程對同一 session 的 event append **exactly once**（唯一寫者）
- **待定選項**：file lock（跨 jsonl/sqlite 通用）vs SQLite transaction（高效但 sqlite-only）——詳盡設計時再決定（目前傾向 file lock）
- dsh 無直接對應；研究 codex 的 cross-process locking

**④ 多進程共享 checkout 鎖**（`@i-harness/session-persistence` 新）
- 目前：jsonl 與 sqlite 都可 open multiple；兩進程同時改同一 session → 寫入衝突
- 目標：checkout 鎖（檔案鎖/session 級鎖）——多進程可同時讀，但**同一 session 寫入時必須獨佔**
- 與③區別：③是 event append 的 exactly-once；④是「session 檔案/DB 寫入時鎖」——更基礎
- dsh 無直接對應；研究 codex

### 6.2 資料流/錯誤處理
- reconnect：child process exit → reconnect → syncTools → 新 tools schema；重試失敗 → fail-closed
- resume：restoreState → rebuild AgentRegistry → 保證 team/subagent wakeup 可用
- cross-process exactly-once：寫入時拿 lock → 寫 → 釋放；失敗 → `lock-acquire-error`
- checkout 鎖：open session 時 get lock → 其他進程讀取時 watch? / 寫時獨佔

### 6.3 測試
- unit：reconnect 邏輯（模擬 disconnect → reconnect 成功/失敗）、resume AgentRegistry rebuild、lock 獲得/衝突
- integration：兩個 Coordinator instance 同時 append 同 session → 只有一個成功；進程鎖（兩個進程同時寫）
- 新測試檔：`packages/mcp-client/test/reconnect.test.ts`、`packages/session-persistence/test/cross-process.test.ts`、`packages/subagent/test/resume.test.ts`

### 6.4 dsh 吸收注意
- dsh 的 `mcp-client-auto-reconnect` 只處理 auto reconnect（移植）
- **dsh 無跨進程 exactly-once/platform**（dsh 是單進程、多進程不支援）→ I-harness 自己研究 codex 的 locks
- resume AgentRegistry 修復是 I-harness 特有（M19 Minor 4）

## 7. M24 子代理/團隊補齊（Subagent/Team 里程碑）

**目標**：補 subagent/agent-team 的健壯性與擴充性——skills-as-plugins、workflows（兩者獨立）、subagent/team resume-wakeup 邊角、subagent 補全。

### 7.1 組件

**① skills-as-plugins**（新包 `@i-harness/skills`）
- 目前：無 skill 機制
- **skill = 可注入的可重用知識包**（dsh skills / opencode skills 概念）
- 結構：`skills/<name>/SKILL.md`（front-matter: name/description/body —— 低 token）
- **注入機制（YAGNI）**：**deferred skills**（同 tool-search）——agent 查 tool-search 找到 skill 後注入
- **載入**：workspace 目錄 `skills/` 掃描；也可全域 `~/.i-harness/skills/`
- **複雜插件化後置**（skill 可註冊工具/可執行 → M25+）：先做 deferred skill 檢索
- dsh 參考：`ui-skill`（UI 端）、`skill` package——需確認；opencode skills

**② workflows**（新包 `@i-harness/workflow` + `workflow-worker-thread`）
- 目前：無 workflow 工具（dsh 有 `workflow/tool-workflow` + `workflow-worker-thread` 多執行緒/CPU-bound 任務）
- **workflow = 可重複執行的多步驟工作流**（靜態定義，非 LLM 動態）
- 結構：**YAML 定義格式**（dsh 用 YAML）；`workflow/*.yml`
- `tool-workflow` 工具：`workflow_run <name>` → 執行 workflow 步驟，輸出進度
- **背景執行**：重用 exec background jobs（**不引入 worker-thread**——YAGNI；I-harness 已有 background job）
- dsh 參考：`packages/workflow/workflow`、`workflow/tool-workflow`、`workflow-worker-thread`（僅設計參考）

**③ subagent/team resume-wakeup 邊角**（`@i-harness/subagent` + `@i-harness/agent-team`）
- M23 修基本 resume 邊角；M24 補 team/subagent **全面 resume 一致性**（resume 後 mailbox、jobs、roles、agent-table 恢復後，wakeup 不再 no-op）
- 檢查：subagent resume 後 wakeup（M9 followupChain 是否在 resume 後序列化）；team mailbox resume（M19 claims）

**④ subagent 補全**
- 目前：11 個工具（spawn/wait/list/send/interrupt/followup/close/resume + job_output/job_list/job_kill）
- 補全：分析 dsh/codex subagent 缺什麼工具？可能：`agent_prompt`（子代理執行子代理）、`subagent_get`、`await` 機制（blocking wait?）——**需研究**
- dsh 參考：dsh 的 `subagent`（可能 experimental）

### 7.2 資料流/錯誤處理
- skills：掃描 workspace/全域目錄 → registry → deferred 檢索（tool-search 一起）→ 注入
- workflows：`workflow` 目錄掃描 → YAML 解析 → 工具執行 → exec 後台執行 → 進度回報
- resume：subagent/team restoreState → rebuild agents/mailbox/jobs/roles → wakeup 可用

### 7.3 測試
- skills：unit——掃描 SKILL.md、front-matter 解析、deferred 檢索、注入
- workflows：unit——YAML 定義解析、執行步驟、exec、進度
- resume：integration——resume 後 subagent/team 喚醒（M19 修復後補測）、mailbox 恢復

### 7.4 dsh 吸收注意
- skills：dsh `skill` 包存在但可能主要是 UI 端（ui-skill）；需實質「先研究 dsh skill 機制 + opencode skill」再決定
- workflows：dsh 的 workflow 是「可視化 workflow 執行」；I-harness 無 UI——**workflow 定義格式與運行時是否符合 headless** 需研究
- subagent 補全：研究 dsh subagent 工具面後決定

## 8. M25 工程收尾（工程里程碑）

**目標**：M1-M24 後端完整後收尾面——e2e 測試層、telemetry 出口、M19 文件狀態、目錄清潔。這是「前端之前」的最後一關（通過即後端完整）。

### 8.1 組件

**① e2e 測試層**（新目錄 `e2e/` 或 `apps/cli/test/e2e/`）
- 目前：無 e2e 層；`apps/cli/test/cli.test.ts` 是 mock 層測試
- 目標：**真實進程端到端**——啟動真實 CLI、真實 sandbox（Windows）、真實模型（mock 或真 API key）、真實工具（shell/fs）
- 設計：`e2e/` 目錄，用 `node --import tsx` 啟動真實 headless CLI；測試真實 `spawn_teammate`、真實 `apply_patch`（M21）、真實 sandbox（M22 阻擋寫出）
- sandbox e2e（Windows 分離）：以 `--sandbox` 跑真實進程，驗證真實隔離
- 整合：`pnpm e2e` script（新 script）
- dsh 參考：`apps/web/tests/scaffold.ts`、`e2e/`（僅參考——I-harness 無 web，只做 CLI e2e）

**② telemetry 出口**（`@i-harness/telemetry` 新包）
- 目前：無 metrics/traces/logs 出口（只有 token-meter、session log）
- 目標：**事件/指標出口**——讓 e2e/前端/外部使用者訂閱運行時事件（tool 執行、turn、provider 呼叫、錯誤、token 消耗）
- 設計：`TelemetrySink` 介面（`{ onEvent(event) }`）+ `createTelemetry` → 收集 runtime 事件（session event、turn、tool、timeout、error、token、M20 retry）
- **telemetry 與 session event log 分離**：session log = 狀態真源（agent 可見）；**telemetry = 營運觀察**（agent 不可見、外部訂閱）
- 出口：**stdout JSONL 出口 + sink 介面**（前端可訂閱）
- dsh 參考：`telemetry`（dsh 可能有）

**③ M19 文件狀態收尾**
- 目前：M19 spec「Status: design」、plan checkbox 未勾——文件落後實作
- 目標：M19 design→approved、plan checkbox 勾選、ledger 清理；也檢查 M14/M15 文件（可能同樣 design 狀態但已實作）

**④ 目錄清理**
- `docs/superpowers/` landmarks 序列化（specs/plans/ledger 一致）、`.superpowers/sdd/`（每個 milestone 的 review/report 檔案）清理或歸檔

### 8.2 資料流/錯誤處理
- e2e：失敗 → 明確錯誤；**不預設 mock**（除非標記）
- telemetry：sink 介面；stdout JSONL 出口；**不影響 session log**（資料分開）

### 8.3 測試
- e2e：真實進程（mocks 不用）；sandbox 分離測試檔（標 Windows-only）
- telemetry：unit——sink 收集、JSONL 格式、事件型別
- **CI**：不做（本地 `pnpm e2e` 腳本即可；CI 以後如果有遠端 repo）

### 8.4 dsh 吸收注意
- e2e：dsh `apps/web/tests/scaffold.ts`（宿主 + web e2e）；用類似架構但 I-harness 無 web——只做 CLI e2e
- telemetry：dsh 可能有 telemetry 包（研究）

## 9. 決策摘要（brainstorming 的 Q&A）

| # | 問題 | 決策 |
|---|---|---|
| 1 | 後端完整的定義 | 能力覆蓋完整——排除前端（web/tui/desktop）；對標 dsh/codex 後端完整能力集，排掉 UI/telemetry/workflows/skills 等非核心?（但後續 Q3 納入 workflows/skills/telemetry——此處初選「排除非核心」在 Q3 被使用者覆蓋為「全部納入」） |
| 2 | 里程碑分組 | 主題分組（每個主題一里程碑，依賴先於補充） |
| 3 | 邊界項目納排 | 全部納入（PTY/terminal、todo/goal、skills-as-plugins、workflows、telemetry） + 補充：可重用 dsh 代碼但不用 dsh 私有庫 |
| 4 | dsh 代碼重用策略 | 最開始選「移植源碼（推薦）」——後續 Q 修改為「吸收而非移植」 |
| 5 | workflows 依賴 | 兩者獨立（workflows 與 skills 不相依） |
| 6 | M14 遺留項處置 | 納入 M20 模型里程碑 |
| 7 | goal 注入方式 | **goal 先不做**（從 M21 移除，記錄為延後） |
| 8 | skills 範圍 | 先做 deferred skill 檢索（YAGNI，複雜 plugin 化後置 M25+） |
| 9 | workflows 格式 | YAML 定義 + 重用 exec background jobs（不引入 worker-thread） |
| 10 | M22 完整讀隔離 | 研究驅動（不先承諾「完整讀隔離」能達成；研究後再決定完整性界限） |
| 11 | 跨進程鎖 | file lock（傾向）vs SQLite transaction（待定——詳盡設計時決定） |
| 12 | e2e 時機 | M25（後端完整後） |
| 13 | telemetry 出口 | stdout JSONL + sink 介面 |
| 14 | CI | 不做（僅本地 `pnpm e2e` 腳本；CI 以後有遠端 repo 再說） |

### 決策 3 補充
- **納入（2026-08-26 使用者指示）**：PTY/terminal、todo/goal、skills-as-plugins、workflows、telemetry 全納入；**可重用 dsh 代碼，但不用 dsh 私有庫**（即不可 import `@deepseek-ai/*` 運行時依賴，只能參考/移植其開源代碼）
- **決策 4 修正**：不一定是移植源碼——如果覺得代碼有問題或有更好寫法，應該只吸收後重寫成適合 I-harness 的代碼

## 10. 研究前導（每個里程碑第一步）

依 §1.3 吸收而非移植，每個里程碑啟動時需先完成對應研究：

| 里程碑 | 研究主題 |
|---|---|
| M20 | codex `prompt_too_long` auto-compact、provider retry、dsh `unified-image-request-pipeline`、attachment |
| M21 | dsh `apply-patch`/`tool-apply-patch`、codex `apply_patch`、dsh `goal/command-goal`（todo 參考）、`tool-output-spill-files` |
| M22 | dsh `windows-acl-restricted-token-sandbox`、`cross-family-fs-sandbox`、codex Windows sandbox、`direct-command-mode` |
| M23 | dsh `mcp-client-auto-reconnect`、codex cross-process locking |
| M24 | dsh `skill`/`ui-skill`、opencode skills、dsh `workflow`/`tool-workflow`/`workflow-worker-thread`、dsh subagent 工具面 |
| M25 | dsh `apps/web/tests/scaffold.ts`、dsh telemetry 包 |

## 11. 已知延後項目（記錄，不遺忘）

- **goal**（todo 延後——從 M21 移除）
- gemini/bedrock/內嵌模型（模型只做兩協議）
- macOS 沙箱（維持 fail-closed）
- 遠端沙箱（e2b 型）
- skills 複雜插件化（skill 可註冊工具/可執行——M25+）
- workflow worker-thread（延用 exec background jobs）
- CI（無遠端 repo——僅本地腳本）

## 12. 範圍檢查

- 本設計文件聚焦「後端完整能力」——M20-M25 六個里程碑
- 前端（web/tui/desktop）明確不在本輪範圍（前端前有前提：後端完整）
- 每個里程碑是獨立可審查、可測試的單元
