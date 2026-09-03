# I-harness 能力盤點（2026-09-03，M32 → M34 全貌）

> 64 包 + `apps/cli`。M1–M25 後端完整（8/28）→ M26–M34 七輪擴展全部落地；每一輪經審計鏈（research → 取捨 → spec → plan → 執行 → 驗證 → 推送）。本文件是**當前能力全景**（以 m34 為準，M36 增量見下），里程碑歷史見 README §Development status。
>
> M36（tui-core）增量：TUI 渲染層（cell 雙緩衝 diff + 零字節 idle、input 位元組解析、init/teardown 位元組序、能力探測、屏幕模式政策、GrokNight 主題量化）——**運行時 0 外部依賴**；PTY harness 首例（真終端零字節/字形完整性/resize 不變量）

## 一、引擎核心
- **事件驅動 agent 循環**：log-driven（session log 為唯一真相）、並行 tool call 池（≤10）、maxTurns、AbortSignal、退出碼契約
- **輸入分級**：`send/followup/steer/inject` 四層 + 持久化收件箱 + event-driven wake
- **多 session 執行器**：每 session 串行 lane、跨 session 平行；`SessionExecutor` + registry
- **統一 context window 解析**（M31）：settings userModel > modelContexts > profile > **model-catalog.json** > undefined；**每 session** 解析；budget 階梯與 compaction 窗口同源
- **動態 system context** + AGENTS.md 指令載入（快照化）+ LLM 標題 / plan mode / `get_context_remaining` 儀表
- **guardian 自動審批**：審查子代理 + 嚴格 JSON + fail-closed + 斷路器
- **崩潰修復鏈**：torn tail + interrupted-turn closers + 缺失 tool result 合成

## 二、壓縮系統（M11/M20 + M33/M34 五路吸收——全面）
- **shadow-projection 基線**：append-only（永不改寫）、讀期影子替換、`compaction/start|summary|end` 三事件、M20 `resetWindow` 純重置層——**五路中唯一持久層不改寫**（codex/opencode/cc/grok 皆替換或記憶投影）
- **M33 吸收（opencode/cc/dsh）**：
  - **anchored 增量摘要**（`<previous-summary>` + update，多輪不堆碎片）＋ **8 節結構化提示**（Objective/Work State/Next Move/Relevant Files/**Sensitive Instructions 逐字保留**/Tool Work…）
  - **model-free prune pass**（`compaction/prune` 事件 + deriveMessages 替身投影；剪完解除壓力即跳過摘要——省整次 LLM call）
  - **計數完整性**（`overheadTokens`：system prompt + 工具 schema 估算，assembly 注入）
  - **磁滯（3-turn）+ 熔斷（3-strike）** + 手動命令面（`session-compact` 帶 instructions）
- **M34 吸收（dsh/grok/codex）**：
  - **per-model 壓縮策略**（`modelPolicies`：thresholdRatio/retainTokens/maxTokens/summarizationModel/auto）
  - **`compaction/attempt` telemetry**（success/prune-only/failure/skipped + tokens + attempts + durationMs）
  - **摘要質檢地板**（`minSummaryChars=500` + 單次重試——grok 招）
  - **until-success 熔斷 + sticky 抑制**（成功仍超限 → 暫停至新內容/手動）
- **budget 階梯**：maybeCompact（≥0.8×窗）→ resetWindow(20) → `prompt_too_long` fail-closed

## 三、工具面
- shell（bash/pwsh，timeout/retention/spill）、fs（read/write/edit/**apply_patch**（mtime+TOCTOU）/read-image）、glob/grep（ripgrep）
- 統一 output spill / todo / **tool_search**（BM25 deferred）/ skill_search+skill_get（SKILL.md + 影子選擇器）
- **MCP**（OAuth 2.1 PKCE+dynamic registration、roots、資源工具、blocked/direct、重連 supervisor、真 AS 測試）
- **LSP**（六面：hover/definition/references/diagnostics/symbol/call hierarchy）
- **PTY 六工具**（node-pty）+ 進程控制面 + 背景任務
- **webfetch + websearch**（dsh 誠信契約 + `EXTERNAL_WEB_CONTENT_NOTICE` 信任邊界 + **零默認 provider**）
- 範式決策維持：PTC 不做、YAML workflow、無 B13 AST（關閉）

## 四、服務面（前端之前最後一關——完成）
- **SessionService**（engine-owned）+ **web-host**：HTTP unary + WS mux（40+ 路由）、live 流四端點、seq 回放 + 分頁
- 認證（HMAC cookie + launch token + DNS-rebind 柵欄 + CORS）/ `/api/health`
- **`@i-harness/sdk`**（NDJSON JSON-RPC，**Wire Contract v0 已鎖**，v1 只加性）
- **ACP**（官方 SDK 子集）/ 模型目錄 + per-session model selection + **`/api/llm/probe-apply`**（discover→adopt 全鏈——**真 DeepSeek 實測 3 模型**）
- 四宿主命令：`run` / `web` / `sdk` / `acp`

## 五、子代理/多智能體
- **durable 任務協議**（task records + 背景執行+父 wake + 取消樹/配額 + `get_task_output`/`stop_task`）
- **teams**（roster/mailbox/task-board/activity，CAS + write-scope）——五源最完整結構化協同
- `ParentInputAdmission`（inject tier）
- 遠期：外部進程子代理、身份證明

## 六、生態/配置
- **settings**（多層/熱更/註釋保持 leaf-patch + section 協議 revision-guard）、**credentials**（refs-not-values + shadowed 拒絕）、**workspace**、**plugin-registry**（市場/安裝/status、**代碼永不執行**）
- **hooks**（9 事件、CC 相容輸出語義、per-handler hash 信任、fail-closed）
- **goal / jobs / feedback / schedule** + **telemetry**（manifest 擴充 + JSONL sink 可插拔）+ **fs-watch**（chokidar）

## 七、模型面（M30 + M31 + M32）
- **五協議 first-class**：openai-responses / openai-compatible（含 DeepSeek）/ anthropic / gemini（原生）/ bedrock（Converse）+ mock
- **模型卡**（`model-catalog.json`：`contextWindow`/`maxOutputTokens` + 解析鏈）＋ **live discovery**（probe → `probe-apply` adopt——draft-only、fingerprint 防競態、**零硬編碼目錄**）
- **思考強度**：6 檔（off/low/medium/high/xhigh/max）× 四協議譯表（世代規則 adaptive/budget）；**缺省不發**；模型不支持 → 400 透傳
- 立場：**不默認任何 provider**、static switch（不追 dsh 註冊表/discovery 自動合併）

## 八、質量/工程
- 每一輪 full 審計鏈；全量測試綠（64 測試文件、~4000+ 測試）、typecheck 0、e2e 11/11
- 依賴原則：通用公開庫自由、私有禁入（`chokidar`/`@aws-sdk`/`@agentclientprotocol` 為 M28+ 實踐）
- 已知問題實錄：README quirks（vitest worker flake 已 M31 修復——web-host forks pool）
- 多輪執行模式：worktree 隔離 + 雙組平行 + 調和審查 + 可追溯的執行者報告

## 九、明確邊界
- **不做**：PTC/run_code、workflow worker、provider 註冊表化、插件執行
- **遠期/觀望**：R-A10 memories、rollover、執行策略深化、R-B4 git undo（M27+）、分享/webhook/身份/外部進程子代理、macOS 沙箱
- **零缺口確認**（相較五源審計五區清單）：除 R-B4 外全部落地或明確關閉/遠期
