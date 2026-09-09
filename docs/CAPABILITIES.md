# I-harness 能力盤點（2026-09-03，M32 → M34 全貌）

> 65 包 + `apps/cli` + `apps/tui-app`。M1–M25 後端完整（8/28）→ M26–M34 七輪擴展全部落地；每一輪經審計鏈（research → 取捨 → spec → plan → 執行 → 驗證 → 推送）。本文件是**當前能力全景**（以 m34 為準，M36 增量見下），里程碑歷史見 README §Development status。
>
> M36（tui-core）增量：TUI 渲染層（cell 雙緩衝 diff + 零字節 idle、input 位元組解析、init/teardown 位元組序、能力探測、屏幕模式政策、GrokNight 主題量化）——**運行時 0 外部依賴**；PTY harness 首例（真終端零字節/字形完整性/resize 不變量）
>
> M37a（tui）增量：grok 1:1 agent 屏——scrollback 引擎（Fenwick virtual_y/O(dirty) 增量、verb-group 折疊、regex 搜索、選區、sticky）、視圖（狀態欄 chips/TurnStatus spinner/PromptWidget chrome/ShortcutsBar）、keymap 主組、**embedded SessionService 橋**（16ms batch + seq 游標回放）、`apps/tui`（mock 首映）；PTY case-011（live streaming + **byte-budget 零字節證明**）/ case-014（流中 resize 不變量）。後端零改動。
>
> M40（盤點收獲）增量：多模態 `read_image`（attachment 系）；`todo_write` 掛載（盤點時發現從未註冊）；CLI 接 pluginRegistry+jobKillBridge（原 404）；settings/changed emitter（順帶修休眠偵測分支）；guardian 熔斷全判定；TUI——toast 卡、context 真值（token-meter）、鼠標滾輪（1015/1016 解碼 + wheel 路由修復 + **case-018**）、mermaid Unicode art（flowchart 子集 + fallback box）、plan-review 適配（a/c/q 動作條 + **case-019**）。
>
> M39（tui 質量）增量：**12 屬性核對表**（blueprint §1：1–10、12 全落地——零字節 idle/backpressure writer/單一 teardown/雙級信號/屏幕模式政策/能力上下文/O(dirty) 虛擬化/checkpoint 流式/時間分片/有需才轉/PTY e2e；11=mermaid 跳過=規格留檔）+ **case-017 交互矩陣**（freeform reject 真鍵路徑——輪尾發現並修復「覆蓋 freeform 無字元路由」生產缺口、question、/btw、picker、history）+ **FPS HUD**（默認關零開銷、120 幀滾窗 p50/p95）+ **retain() 顯示層裁切**（`… earlier (N lines)` 標記、塊級原子、seq 不變、>2000 行自動觸發）+ **bench**（append 5k 事件 3.2ms / search 23k 行 19.7ms / retain 6170 塊 0.9ms——本機）。
>
> M38b（tui 內容）增量：**markdown checkpoint**（marked 詞法——段落空行/列表/圍欄閉合=刷新點、尾重渲染、未閉合圍欄 plain-on-md_code_bg）+ **hljs 極性安全高亮**（class→TextStyle 映射、md 六級標題/md_code_bg 全規格）+ info 行實值（modelLabel 宿主傳導；context 形狀就位待 metrics RPC）+ **`--attach` 遠程後端**（SDK stdio 客戶端——wire v0 凍結消費、16ms 批次、真子進程 e2e）；PTY case-016（逐段上屏 + 圍欄閉合高亮 pins + writes=10）。誠實缺口：遠程 replay/list 無 v0 RPC、contextUsed 需 token-meter 依賴（下一輪一個函數體即真）。
>
> M48（可靠性與交付）增量：配置 store root 時 TUI 支持 durable 建立、列表、`--resume` 與 close flush；Rewind bridge 僅在 durable recorder 條件具備時暴露；G1 chain 在 predecessor reject 後仍推進；PTY case-010 修復 Windows `chcp` codepage 命令解析。未配置 store root 仍是 ephemeral fallback，shell-only 變更不屬於 Rewind v1。
>
> M38a（tui minimal）增量：**快/穩降級面**——Inline insert_before 前向引擎（LF-at-bottom 滾動原生保留 scrollback——CSI S 在 xterm6 被實測丟行、region 零字節 gate、setRegion canon 縫）、minimal live region（tail/todos/status/prompt/info + 500ms tail-flush）、self-relaunch 模式切換（`/minimal` `/fullscreen` 同會話 re-exec）；PTY case-015（native buffer pins baseY=5/42 + **10-write budget** + resize + relaunch exit 0）。
>
> M37b（tui）增量：**交互面收官**——permission/question/cancel-turn 覆蓋（approval seam 只讀接線 + 16ms batch + 30s fail-closed 超時、session jsonl 列舉）、todo/tasks/queue//btw 面板（§3.12 全規格）、slash/completion/history/file-search 下拉（§3.6）、session picker + welcome（適配）、keymap 全表（overlay/menu 路由）；PTY case-012（**真鍵面**：打字/Enter/歷史 Esc/Ctrl-C/Shift-Tab——writes-budget 13 次恰數）/ case-013（permission `1 (●)…` + j/k + 決策回寫斷言）。

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
- shell（bash/pwsh，timeout/retention/spill）、fs（read/write/edit/**apply_patch**（mtime+TOCTOU））、**`read_image`**（attachment 系多模態——workspace 路徑解析 → png/jpeg/gif/webp → ImageInput base64 inline 送達模型）、glob/grep（ripgrep）
- 統一 output spill / todo / **tool_search**（BM25 deferred）/ skill_search+skill_get（SKILL.md + 影子選擇器）
- **MCP**（OAuth 2.1 PKCE+dynamic registration、roots、資源工具、blocked/direct、重連 supervisor、真 AS 測試）
- **LSP**（六面：hover/definition/references/diagnostics/symbol/call hierarchy）
- **PTY 六工具**（node-pty）+ 進程控制面 + 背景任務
- **webfetch + websearch**（dsh 誠信契約 + `EXTERNAL_WEB_CONTENT_NOTICE` 信任邊界 + **零默認 provider**）
- 範式決策維持：PTC 不做、YAML workflow、無 B13 AST（關閉）

## 四、服務面（前端之前最後一關——完成）
- **SessionService**（engine-owned）+ **web-host**：HTTP unary + WS mux（40+ 路由）、live 流四端點、seq 回放 + 分頁
- 認證（HMAC cookie + launch token + DNS-rebind 柵欄 + CORS）/ `/api/health`
- **`@i-harness/sdk`**（NDJSON JSON-RPC，**Wire Contract v0 已鎖**，**v1 加性落地（M41a）**：`session/history`（afterSeq 增量+limit 分頁）+`session/list`（可選源 + `listingUnavailable`）+ protocolVersion 2 + capabilities 兩行——`--attach` 回放/列表缺口閉合）
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
- 每一輪 full 審計鏈；全量測試綠（64 測試文件、~4000+ 測試）、typecheck 0、e2e 11/11——M49 交付時的實測記錄（task-15-report.md）：`pnpm -r typecheck` exit 0、`pnpm e2e` 11/11、全部 19 個 PTY case 逐一獨立運行 exit 0、14 個 Step-4 包測試 exit 0（唯一例外：apps/cli 的 sdk-wire-v11 在此環境為基線既有失敗——stash 驗證）；本環境根 `pnpm test` 視同為此兩項基線/併發條件所限（TUI 全體 735/736 + case-027 全套併發 flake——獨立跑 1/1）
- 依賴原則：通用公開庫自由、私有禁入（`chokidar`/`@aws-sdk`/`@agentclientprotocol` 為 M28+ 實踐）
- 已知問題實錄：README quirks（vitest worker flake 已 M31 修復——web-host forks pool）
- 多輪執行模式：worktree 隔離 + 雙組平行 + 調和審查 + 可追溯的執行者報告

## 八&frac34;½、Provider/模型 TUI 管理 + Slash 註冊表（M46a 新增——M49 超集）

> **M49 supersede 注**：M46a 的 `tui.providers` 平面、`tui.providers` 版本化佈局與「缺 → mock」鏈均已替換——見下方 M49 節（canonical `llm.providers`、required-model、read-pin）；本節收錄的 M46a 機制描述（mask 顯示、三步嚮導、ArgPicker、Settings modal 形狀、鍵表）仍以 M49 狀態為準。

- **Provider**：settings `tui.providers`（M46a 佈局——**M49 起僅 read-pin 兼容**；README/本節如下「Provider/模型 plane（M49）」；明文絕不進 settings；mask 顯示）＋ `discoverModels`（`@i-harness/provider` 的 `probeCandidatePaths` 進程復用；記憶體 memo；CI 注入式）＋ 三步嚮導/菜單/刪除（cc-custom 字形面）。
- **模型**：`/model` ArgPicker（目錄 + `(no override)`）+ `/effort`（llm.defaultModel.reasoningEffort）+ factory 鏈 `--model` > settings 默認——**M49 起無 mock 兜底**（未配置 = Welcome gate，required-model policy；子代理測試/示範性組裝方可顯式注入 llm-mock）。
- **Settings modal**：新版 8 分類（Appearance/Mouse/Models&Providers/Sessions/Safety——真旋鈕 + 誠實佔位；Appearance 主題 4-6 階依色彩深度；Models&Providers 為 master/detail 與 model picker 啟動行）。
- **Slash**：CommandRegistry（grok 形狀，visible/門控）——**M49 起供應能力門控清單**（無隱藏跳過表；`login/logout/share/privacy/delete/cd/memory/media/voice/imagine/…` 根本不註冊，提交即 `Unsupported command: /<name>` 且零後端提交）；輕量面板（skills/mcps/hooks/plugins/marketplace/config-agents/workflow/usage/session-info/goal/tutorial/jump/doctor/help/timeline…）。
- **鍵表真理**（新版為準）：Ctrl+S stash + Alt+S、F3 sessions、Ctrl+G 模式拆分（全屏 tasks / minimal $EDITOR）、Ctrl+B 送後台（jobs 未接——toast 誠實 (M46b)）、Ctrl+R 槽位（m46b 門控；M49 起切換真實 terminal 捕獲位元組集）。
- 誠實縫：compact/rename = BackendClient 可選成員（assembly/後臺裝配）；always-approve 運行時線縫 = m46b。

## 八¾¾、Provider/模型 plane + TUI parity（M49——Grok parity 收官）

- **Canonical provider settings**：settings `llm.providers`（id 化、protocol/baseURL/modelsURL/models/displayName/apiKeyEnv 引用）+ `llm.defaultModel` 為唯一解析真源；TUI `/provider` master/detail 寫入此平面（`createProviderRuntime`——directory/upsert/remove/setApiKey/discoverModels/setDefaultModel/resolveModel）。M46 `tui.providers` 佈局僅**讀取 pin**（重寫時文件原樣保留、規格化輸出永不暴露、永不推入 `llm.providers` 持久化）。provider 目錄 = registry 模板 + user 覆蓋合併；身份/密鑰**絕不進 settings**（credentials 引用 + `apiKeyEnv` env 覆寫、shadowed 拒絕）。
- **解析鏈**（`provider-runtime/src/index.ts:456-483` selectModel：override 先判）：`--model` override > session model selection > `llm.defaultModel`；未配置 → `No model configured`（required-model gate——Welcome 路由 Settings；無 mock 回退）；`reasoningEffort` 6 檔、`contextWindow` 來自 model card 有效上下文（stale-window 防止單元級）。
- **認證面**：refs-not-values 的三源 resolve（env > file）＋ **Bedrock ambient**（無 key 環境即用——僅 `bedrock` provider 與 `ambient` ref 合法，其他協議拒絕）；**OAuth-account 類型為未來擴展邊界**（ProviderAuthRef 型別預留 `oauth-account-ref`，本期無實作/無 UI 側）。
- **發現**：model 目錄 = 手動（`/provider` 內置 model id 增刪）+ **明確 discovery**（`discoverModels` probe——`modelsURL` 全端點支持；bedrock 為 manual-only、明確拒絕發現）；無自動爬取/入門教程。
- **Slash 註冊表（可見清單——M49 實測）**：`provider model settings effort`（provider-settings 能力）；`theme timestamps multiline compact-mode minimal fullscreen`；`doctor copy export transcript help quit`；`skills mcps hooks plugins marketplace config-agents`；`workflow workflows`；`usage tutorial goal`；`timeline`；`toggle-mouse-reporting`（mouse_reporting_toggle 開）；`always-approve auto`（guardian 能力）；`find jump history edit-prompt new home resume dashboard queue tasks btw rename session-info fork context rewind compact plan view-plan`（各別後端能力門控）；`vim-mode` 註冊但 M49 能力缺席——**不可見**。排除名單（未註冊——無 hidden skip-list）：`login logout share privacy delete cd remember recap voice imagine imagine-video`。`/help` 渲染**當前**可見清單 + 現行鍵行（絕非靜態）。
- **主題/畫面模式**：六主題（system→auto / grok-night / grok-day / tokyo-night / rose-pine-moon / oscura-midnight；truecolor 全六，低彩四）+ 每主題專屬 palette；`/theme` + Settings Appearance 同路徑（preview → persist → rollback）；startup `initialTheme` 種子（重啟後裸 `/theme` 從實態循環起）。`tui.prefs.screenMode` 持久化（`--mode` 旗標 > persisted > fullscreen）；minimal = **無終端 init**（無 alt-screen/無捕獲——啟動 split 結構性保證）；`/minimal` `/fullscreen` 寫回持久實態並同會話重啟。
- **Status line（內建）**：真實值派生（model label = runtime 綁定標籤、workspace git branch、context 計數、turn timer、session 標題、queue/tasks 計數——未知即省略，絕不虛構）；segments 可配置（`tui.prefs.statusLine.items`）；mode disabled/builtin/command。
- **Dashboard**：**本地機器**面——durable session store + backend 真投影（title/updatedAt/turnCount/live/modelLabel/tasks/queued——失敗即誠實跳過，never fabricated）；filter/peek/pin/order 持久化（pinned/order ids 僅本地設定）；無跨機器同步；無 account 面。
- **鼠標捕獲切換**：opt-in `mouse_reporting_toggle`（或 `GROK_MOUSE_REPORTING_TOGGLE=1`）→ 全屏 scrollback Ctrl+R / `/toggle-mouse-reporting` 切換真 terminal 捕獲（僅轉換發位元組；五模 enable/disable 集）；minimal/無鼠標終端忽略（保持 OFF）。
- **Grapheme editor + cursor**：PromptEditor 權威模型（clusters 原子移動/多點擊、paste atoms、undo/redo、@@-編輯）；可見 cursor 位元組（Show/MoveTo/Hide——case-025）。
- **Typed tool 呈現**：tool 家族（README/exec/tool/eslint/steps…）+ 結構化 diff（+A/-D 會計、hunk 行）+ 原始視圖（secret 紅化——redact 縫）+ copy（注入夾層——唯一複製路徑）+ block/line viewer（真檔讀取、1-based 游標、真實 JSON 投影）。
- **Queue/Tasks**：真實 queue 投影（service-front + lane 合併；queued/running/delivery/order）+ [cancel]/[Send now]；tasks 分組（Subagents/Background/Workflows/Schedule——僅有列之組）、[✗] cancel、task viewer；計數為 backend 真值。
- **PTY parity 證明（case-028）**：一連續 executable session——minimal 啟動無 alt-screen/鼠標位元組（runtime 標籤先現）、`/fullscreen` 重啟持久化、Settings 主題六循環、Ctrl+R off/on 位元組集、Settings/Dashboard/Queue/Tasks/viewer/file viewer/Help 面 + modal 輸入優先 + Esc unwinding、`/login` 精確「Unsupported command: /login」+ 零後端提交、重啟主題/畫面/狀態持久化 + 模型標籤 = runtime 真綁定。

## 八¾2、鼠標五分面（M46b 新增——grok 鼠標全 parity）

- **捕獲/解析**：init 五模 `?1000h ?1002h ?1003h ?1015h ?1006h`（crossterm 順序）+ teardown 五模 `l` 全復位；解析器 Moved（無按鈕 `<3;x;yM` → `motion`）+ `released` 位（點擊 down/up 分隔）；`<32;+` 拖動、`<64/65` 滾輪。minimal 模式捕獲完全關（無 terminal——byte 流無 `?1000h`）。
- **懸停（HitArea + dirty）**：視圖繪製時登記 rect+語義（`hit()`）；present 每幀 settle 一次——懸停集變了才重繪（**不裝 30fps 懸停泵**——性能紅線）。視覺：scrollback 行 bg blend（markdown 行改左欄邊框 `│`）、時間戳懸停擴展 `%H:%M:%S | %b %d`、status cwd chip 下劃線、dropdown/permission/question 行 hover 穿 bgVisual、tasks/queue 行、completion 等。
- **點擊語義（G2，時序常量全在 mouse-consts.ts——唯 300ms 多擊窗**）**：scrollback 單擊=選+聚焦；雙擊（≤300同格）=折疊（組頭=整組；execute=excerpt 顯影；edit=`❙ 頭 (+N/-M)`；subagent=viewer 縫（缺→誠實 toast））；三擊=折疊+置頂；word_select 模式 1/2/3=行/詞URL（即複製）/段落；拖拽 ≥1 cell = wrap 感知顯示行選+邊緣 2-row band 自動滾動（1/2/3/5 行/tick）+ 鬆手自動複製（注入剪貼板層——唯一複製路徑）+ "Copied!" toast + 150ms flash（flash/hold/word_select 三模式；失 Up 恢復路徑仍複製）；scrollbar 列=鎖存+fraction 跳；permission 單擊=光標/雙擊（≤300 同 idx）即發（binder decide 複用）；question 單擊 toggle/雙擊=選+答；cancel-turn 點擊即發；status chips（cwd 複製/tasks 面板切換/context 300ms debounce/goal/plan）；面板（tasks 組頭折疊 [✗]/[↗]、queue [cancel]/[Send now]、todo 行選、dropdown 行選+接受+右欄比例跳）；Ctrl+點 armed→同格 Up 開鏈接（縫缺→誠實 toast）。
- **滾動流式（G1——grok 引擎移植）**：80ms gap / 16ms cadence / 每品牌 ept（WindowsTerminal=3、iTerm2/Wez=1……）＋ wheel promote（首批 ≤12ms）＋ 觸控板辨識（均值 <30ms）＋ 2.5×/1.6× accel ＋ taper ＋ per-flush cap max(vp/2,6) ＋ sub-line carry。**已承認偏離**：grok 的 scroll clock 換成 loop 輸入泵——`push()` 即時 flush（凍結時鐘下仍可滾——確定性），`onTick()` 保留 cadence 供 drain 路徑。
- **knobs**：settings **Mouse 類真 7 行**——`scroll_speed`（1-100→0.1×-6×，50=1×）`scroll_mode`（auto|wheel|trackpad）`scroll_lines`（1-10 覆蓋品牌表）`invert_scroll` `keep_text_selection`（flash|hold|word_select）`word_separators`（值展示）`mouse_reporting_toggle`（opt-in 默認 off；on → scrollback Ctrl+R = 切換捕獲實況——綁定+ slash 槽 M46a 已佔）；env `GROK_MOUSE_REPORTING_TOGGLE` 強制 on。
- **PTY case-023**（80x24 單確定跑）：SGR 喂入真解析鏈——滾輪±1（case-018 數學）、懸停 bg-blend + ts swap/還原、單擊選區（引擎觀測）、雙擊折疊（`❙ (+6/-6)`）+ 異格雙擊展開、拖拽 4 行自動複製（**裁剪板 JSON 逐字**）+ "Copied!" toast、滾動條鎖存+比例跳、permission 雙擊即發（decision.json），writes=34；minimal 場景無捕獲（byte 流無 `?1000h` + region 文本正控）。

## 八&frac34;、Rewind（M42 新增——原「跳過」變「有後端」）

- **後端**：`packages/rewind`——RewindStore（`rewind/<sid>/points.jsonl` + content-addressed blobs 原子寫）、RewindRecorder（take-once per turn、turn/end finalize + afterHash）、RewindService（points/plan/execute——clean/conflict 三型惰性比對、unTracked 誠實、兩階段恢復）。
- **通道**：fs 寫管道報告 pre-image（write/edit/apply_patch 精確鉤點；結果帶 preImageRef/isNewFile——日誌即通道；shell 不攔截誠實標記）。
- **對話回滾**：`rewind/point` 事件 + deriveMessages cut 投影（重疊 meld、append-only 鐵則保持；與 compaction 遮蔽組合）。
- **UI（M43 已複刻）**：§3.9 六相位逐字（picker `Rewind to which turn?` / ModeSelect 三選 / CancelOffer / Confirm 衝突 `! {path} ({kind})` + `+N more` / `Rewinding...` / `Rewind failed`）+ Esc-Esc 開熱 + scrollback **anchor 下暗化** + **引擎隱藏 rewound 塊**（標記行在位）+ case-020（真服務磁盤 byte-exact 恢復 + 日誌截斷）。
- 注：rewind/v1（`--attach` wire 附錄）待後。

## 九、明確邊界
- **不做**：PTC/run_code、workflow worker、provider 註冊表化、插件執行
- **遠期/觀望**：R-A10 memories、rollover、執行策略深化、R-B4 git undo **B 案**（checkpoint 引擎；A 案 M58 已落地：`plan().unseen` 唯讀 git 對照）、分享/webhook/身份/外部進程子代理、macOS 沙箱
- **零缺口確認**（相較五源審計五區清單）：除 R-B4 B 案外全部落地或明確關閉/遠期
