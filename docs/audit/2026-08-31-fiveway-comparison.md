# 五源後端對比審計（2026-08-31）

日期：2026-08-31 · 方式：唯讀盤點（多個並行 research 子代理，全樹走查 src/，非 README 聲稱）＋ 本倉庫既有文檔鏈（dsh-risk-audit → parity → M1–M25 specs）。

**目的**：回答「I-harness 作為一個完整 agent 項目的後端還缺什麼」——四源對比（opencode fork / dsh / I-harness 主線 / I-harness frontend-web 分支），並新增第五源 codex-rust 作為機制獵場。產出：能力矩陣 + disposition 表（驅動後續 roadmap 的輸入）。

## 0. 五源身份表

| 源 | 路徑 | 特性 | 語言/技術棧 |
|---|---|---|---|
| **opencode fork** | `D:\agent-complete\opencode-fork-private-999.0.15` | fork 999.0.15（上游 1.18.3 → 999.0.x）；V2 kernel 引擎 + V1 兼容；durable 任務協議 | Bun + Effect 4 + Drizzle + Hono + SolidJS |
| **dsh（DeepSeek Harness）** | `D:\agent-complete\deepseek-harness-dsh-v0.1.2-alpha.1` | I-harness 的**概念源頭**（吸收而非移植）；everything-is-a-plugin（Cordis）；Service Definition/Provider/Consumer | Node + Cordis + schemastery/zod + Typert RPC |
| **I-harness 主線** | `d:\I-harness-main` | M1–M25 backend-complete（8/28）+ 本審計之前測試全綠 | TS ESM strict、零外部依賴、node:sqlite、Windows 優先 |
| **I-harness frontend-web 分支** | `D:\agent-complete\I-harness`（git 分支 `frontend-web`） | 主線後代 133 commits（8/28→8/31）；web 服務化試點 + Vue 前端；**被中止於 8/31** | 同上 + `ws`（唯一新外部依賴） |
| **codex-rust** | `D:\agent-complete\codex-rust-v0.149.1`（`codex-rs/`，135 crates） | GPT-5 era 單 agent 引擎；daemon 化 app-server；最豐富機制 | Rust 2024（tokio/sqlx/rmcp/gix/tree-sitter）⇒ **不移植，只吸收概念** |

## 1. 方法

- 每源 1–3 個盤點子代理，按統一維度輸出：細節機制 + 文件路徑 + 外部依賴清單；驗證性動作（`pnpm test`）@ I-harness 主線全系列 Exit 0、frontend-web 分支六包測試全綠（web-host 196 / plugin-registry 118 / settings 38 / workspace 24 / credentials 20 / apps-web 645）。
- I-harness 主線狀態另以 `docs/`（審計鏈 + M 系列 specs）交叉追蹤：M1–M25 全部完成、官方延後清單（goal、gemini/bedrock、macOS sandbox、e2b、CI、前端）逐項核對。
- disposition 值沿用 dsh-risk-audit 慣例並擴充：**reuse**（概念夠乾淨可直接參考/移植）/ **rewrite**（有缺陷，重寫成 I-harness 語彙）/ **improved-writing**（概念穩定，我們寫得更好——即 I-harness 既有的應保持）/ **已存在**（I-harness 主線已有）/ **遠期**（產品面，先不做）/ **不做**（與原則衝突）。

## 2. 能力矩陣（五域 A–E）

### A. 引擎核心

| 功能 | opencode | dsh | IH 主線 | IH 分支 | codex | disposition |
|---|---|---|---|---|---|---|
| agent 循環 | ✓ 雙引擎（classic/kernel） | ✓ log-driven ReactLoop | ✓ 事件驅動 | ✓ 同主線 | ✓ run_turn + FuturesOrdered | **improved-writing**（IH 循環已夠；kernel 租約僅作概念） |
| 輸入分級（steer/followup/queue） | ✓ admit→promote durable | ✓ send/followup/steer/inject + inbox spliced 事件 | ✗ | ✗ | ✓ InputQueue + durable queue 庫 + turn/steer ops | **rewrite**（最大核心缺口；三源三形狀，取 dsh 概念 + codex 持久化） |
| 多 session 並行 | ✓ 每 session 串行跨並行 | ✓ per-agent inbox + phase | ✗ 單次 runHeadless | ◐ 每 session live-agent | ✓ ThreadManager + LRU residency | **rewrite**（配合 A-輸入分級） |
| 崩潰恢復 | ✓ lease + recovery-planner（零 provider 調用） | ✓ repair（torn tail + interrupted closers） | ✗（僅 ownership lock） | ◐ | ✓ JSONL truth + SQLite mirror + backfill + revert/rollback | **rewrite**（dsh 修復模型最貼；codex 的「JSONL 真相 + SQLite 鏡像 + 修復回填」可作長遠參考） |
| 動態 system context | ✓ epoch + ContextUpdated 事件 | ✓ runtime-context snapshot（user 訊息快照） | ✗ 靜態 prompt | ✗ | ✓ context-fragments（skills/apps/guardian/env） | **rewrite**（dsh 投影風格貼 IH） |
| 指令載入（AGENTS.md） | ✓ | ✓ + 文件變化推 inbox | ✗ | ✗ | ✓ world_state/agents_md | **reuse**（小）；dsh 變化推 inbox 是加分 |
| session 查詢 | ✗ LIKE only | ✓ FTS + lineage + 語義 | **✓ FTS + lineage** | ✓ 同主線 | ✓ search/searchOccurrences | **improved-writing**（主線最強，不退） |
| session 標題 | ✗ | ✓ LLM title providers | ✗ | ✗ | ✓ thread titles（DB） | **rewrite**（S 成本） |
| 上下文預算可見 | ✗ | ✗ | ✗ | ✗ | ✓ get_context_remaining + #context | **rewrite**（S 成本，模型工具） |
| plan mode | ✓ plan_exit | ✓ logged state（單事件） | ✗ | ✗ | ✓ plan/update_plan 工具 | **rewrite**（dsh 形狀：一條事件 + 投影） |
| goal | ✗ | ✓ event-sourced goal + 3 工具 | ✗（M21 延後「後續評估」） | ✓ goal/change CAS fold | ✓ thread_goals + goal ops | **reuse**（分支實現可直接採用 → 已存在於分支） |
| memories（跨 session 持久記憶） | ✗ | ✗ | ✗ | ✗ | ✓ memories_1.sqlite + 4 工具 | **遠期/rewrite**（codex 獨有，概念價值高但依賴產品定義） |
| 自動審批審查（guardian） | ✗ | ✗ | ✗ | ✗ | ✓ 審查子代理 + 嚴格 JSON + 90s fail-closed + 斷路器 + prompt cache | **rewrite**（codex 獨有；IH 已有 subagent + approval 設施，是「代理審批代理」層——若做無人值守/CI 高價值） |
| 統計/遙測 | ✓ OTLP | ✓ Otel + stats 投影 | ✓ 13 事件 JSONL | ✓ 同主線 | ✓ otel + sentry | **improved-writing**（JSONL sink 設計保留；事件碼擴充可吸收 manifest 形狀） |

### B. 執行與工具面

| 功能 | opencode | dsh | IH 主線 | IH 分支 | codex | disposition |
|---|---|---|---|---|---|---|
| 沙箱 | ✗（僅 permission） | ✓✓ bwrap/landlock/seatbelt/win-ACL + fs containment + **E2B** + escalation | ✓ win-ACL fail-closed | 同主線 | ✓✓ win 三級（含 **Elevated**：private desktop+WFP+conpty）、Linux seccomp+bwrap+**MITM proxy**、Seatbelt、deny-read globs | **improved-writing**（IH 已是高水位；codex Elevated 級與網路面作後期概念） |
| 執行策略 | ✗ | ◐ sandbox_permissions | ◐ approval 三層 | ◐ | ✓ execpolicy + PermissionProfile + shell-escalation + process-hardening | **遠期**（M22 已收斂；如需再深化以 codex 為參考） |
| PTY/terminal | ✗（僅 bash 灰段） | ✓ terminal_* 六工具（node-pty persistent） | ✗ | ✗ | ✓ exec_command + write_stdin + backgroundTerminals | **rewrite**（dsh 六工具形狀；codex 的異步 backgroundTerminals 概念加分） |
| 統一輸出溢出 | ✓ registry-wide + GC | ✓ spill policy + locator | ✓ per-tool | 同主線 | ✓ tool_output_token_limit | **rewrite**（S；per-tool → registry 級升級，見 roadmap B7） |
| git snapshot/undo | ✓ 唯一 | ✗ | ✗ | ✗ | ✓ thread/revert + rollback | **rewrite**（opencode/codex 雙源；M 級成本） |
| web 存取 | ✓ webfetch/websearch | ✓ web 能力 | ✗ | ✗ | ✓ web_search + hosted spec | **rewrite**（S/M 成本；純 add-on） |
| MCP | ✓✓ OAuth2.1 + roots + 資源工具 + blocked/direct | ◐ 基本 transport | ✓ 重連 supervisor | ✓ 同主線 | ✓ rmcp（OAuth/elicitation）+ **MCP server 獨立二進制砂箱啟動** | **rewrite**（opencode 深度為基 + codex 安全啟動概念） |
| LSP | ✓ 含 symbol/call hierarchy | ✓ lsp 工具 | ✓ 四操作 | 同主線 | — | **rewrite**（S；opencode 擴充面） |
| skills | ✗ | ✓ registry + 目錄/載入工具 | ✓ skill_search/skill_get（deferred SKILL.md） | ✓ 同主線 | ✓✓ skills/list + skills/read 模型可觸達 + **影子選擇器** + 隱式調用 policy + 插件技能根 | **improved-writing**（IH 已具主幹；影子選擇器與插件根按需吸收） |
| tool_search | ✓ catalog + definitionHash | ✓（PTC 收斂） | ✓ BM25 deferred | 同主線 | ✓ BM25 + deferred 動態工具 | **improved-writing**（四源平手；PTC 是範式決策非缺口） |
| workflow | ✗（無 YAML） | ✓✓ worker-thread + 模型寫 JS + ralph | ✓ YAML 靜態 | 同主線 | ◐（外掛） | **遠期/rewrite**（dsh worker-thread 是重大升級，是範式決策） |
| 進程控制面 | ◐ | ✗ | ✗ | ✗ | ✓ process/spawn|kill|resizePty、fs/watch、fs/* ops | **rewrite**（S–M；與 PTY 同族） |
| apply_patch 解析驗證 | ◐ edit/apply_patch | ✓ str_replace_editor | ✓ apply_patch + mtime 檢查 | 同主線 | ✓ tree-sitter AST 驗證 | **遠期**（mtime 機制已夠；AST 驗證可後看） |

### C. 服務 / API 面（I-harness 主線全 ✗——唯一完全空白域）

| 功能 | opencode | dsh | IH 主線 | IH 分支 | codex | disposition |
|---|---|---|---|---|---|---|
| 服務層 | ✓ Hono 150+ 路由 | ✓ node:http + controllers（host/webserver） | ✗ | ✓ web-host 40+ 路由 + WS mux | ✓ app-server JSON-RPC（stdio/ws/remote） | **rewrite**（分支協議形狀 + 消除「膠水複製 runHeadless」缺陷——見 §4） |
| 流式傳輸 | ✓ SSE + seq 回放 | ✓ Typert + WS mux + $events | ✗ | ✓ WS mux（open/cancel/approval 快路） | ✓ JSON-RPC 通知集 | **rewrite**（分支形狀；注意三方向：HTTP/WS mux vs stdio JSON-RPC——對外 SDK 建議 stdio 形狀，見 dsh/codex 先例） |
| 外部 SDK | ✓ sdk-next/js | ✓ stdio `HarnessClient` | ✗（lib API only） | ✗ | ✓ TS+Python Codex SDK | **rewrite**（codex 的 Python SDK 對 ih 不必要；TS 優先） |
| auth | ◐ Basic（env） | ✓ HMAC cookie + launch token + DNS-rebind 柵欄 | ✗ | ✗ | ◐（本地/遠程控制分離） | **rewrite**（dsh 安全模型最佳） |
| ACP | ✓ 原生 facade | ✓ automation-only（@agentclientprotocol/sdk） | ✗ | ✗ | ✗（自有 app-server 取代） | **遠期**（dsh 是唯一保留價值點——需產品決定 ACP 兼容策略） |
| 模型目錄 / 探測 / per-session 選擇 | ✓ live discovery + variants | ◐ reasoningEffort | ✗ | ✓（probe/directory + model selection） | ✓ modelProvider capabilities + rerouted | **reuse**（分支已有 IH 語彙版） |
| 遠程執行環境 | ✗ | ✓ E2B | ✗ | ✗ | ✓ exec-server + noise-channel + attestation | **遠期**（無遠程需求；概念記錄） |
| 會話分享 / webhook | ✓ share + S3 + webhook | ✓ webhook（驗簽+觸發） | ✗ | ✗ | ◐ | **遠期**（產品面） |

### D. 子代理與多智能體

| 功能 | opencode | dsh | IH 主線 | IH 分支 | codex | disposition |
|---|---|---|---|---|---|---|
| 持久任務協議 | ✓✓ task_submission + outbox + cancel tree | ◐ continuation + durable descriptor | ✗ 同進程駐留 + 阻塞 turn | ✓ DurableJobRecord（淺） | ✓ SQLite spawn-edge graph | **rewrite**（最大 D 缺口；opencode 概念 + 分支 spine） |
| 背景執行 + 父被 wake | ✓ | ◐（inbox 通知） | ✗ | ✗ | ✓ 非同步 6 工具 + LRU residency | **rewrite**（與上同批） |
| 任務控制工具（get_task_output/stop_task） | ✓（+wait ≤600s） | ◐ job_output/job_list/job_kill | ✗ | ✓ job kill bridge | ◐（wait/list） | **rewrite**（S–M；分支已有 fold） |
| 深度/併發配額 | ✓ | ✓ | ✗ | ✗ | ◐ | **rewrite**（S） |
| 外部進程子代理（claude-code/codex/acp/獨立 harness） | ✗ | ✓ 4 providers | ✗ | ✗ | ✗（自代） | **遠期/rewrite**（dsh 獨特價值；低優先） |
| 多智能體協同（roster/mailbox/task-board） | ✓ | ✓ experimental | **✓ 主線最完整** | ✓ | ✓ 對話式輕量（v2） | **improved-writing**（主線已贏；opencode 取消樹/資源可補） |
| agent 身份（Ed25519）/attestation | ✗ | 匿名 ID | ✗ | ✗ | ✓ identity 令牌 + workload-identity | **遠期** |

### E. 平台 / 生態（後端部分）

| 功能 | opencode | dsh | IH 主線 | IH 分支 | codex | disposition |
|---|---|---|---|---|---|---|
| 配置層 | ✓ json 多層 | ✓ settings 命名空間 + 熱更新 + 註釋保持 | ✗（host 注入） | ✓ settings.json + section 協議 | ✓ config.toml 多層 + **profiles** | **rewrite**（分支形狀；dsh 熱更新/多層層疊可吸收；profiles 遠期） |
| 憑據 | ✓ credential + OAuth | ✓ refs-not-values（env > .credentials.yaml > .env） | ✗ | ✓ credentials.json（env 優先 + shadow 拒絕） | ✓ secrets（age + keyring） | **rewrite**（分支 + dsh 理念；keyring 遠期） |
| workspace 實體 | ✓ | ✓ | ✗ | ✓ 文檔庫 registry | ✓ projects 表 | **reuse**（分支 as-is 可合主線） |
| 插件生態 | ✓ SDK + 市場（**無隔離**） | ✓ cordis + vm 白名單（聲稱非隔離） | ✗（內部 mount） | ✓ register+市場+status（**插件代碼永不執行**） | ✓ 9 種市場來源 + npm/git + 命令遷移 + 沙箱 MCP/鉤子 | **rewrite**（分支 as-is + codex 信任/沙箱強化概念；執行策略是產品決策） |
| hooks（CC/Codex 契約） | ✗ | ✓ 橋（CC/Codex 兩個 dialect） | ✗ | ✗ | ✓ **9 事件 + 3 handler 型別 + per-handler hash 信任 + fail-closed** | **rewrite**（codex 契約為準 + dsh 橋接為現成 ECOS） |
| schedule | ✗ | ✓ 持久 schedule/change | ✗ | ✗ | ◐ | rewrite（S；與 goal 同族） |
| jobs | ✓ durable | ◐ local | ✗ | ✓ fold + kill bridge | ◐ | rewrite（分支為基；opencode 耐用化遠期） |
| feedback | ✗ | ✓ message-feedback | ✗ | ✓ doc sidecar + CAS | ✓ feedback/upload | **reuse**（分支 as-is） |
| goal | ✗ | ✓ | ✗ | ✓ | ✓ | **reuse**（分支 as-is） |
| 觀察 | ✓ OTLP | ✓ OTel + stats | ✓ JSONL | ✓ | ✓ OTLP + sentry | **improved-writing**（保留 JSONL；按需 OTLP） |

## 3. Codex 獨有機制（其他四源皆無）

1. **Guardian 自動審批**——審查子代理 + 嚴格 JSON 契約 + `guardian:{thread_id}` prompt cache + 90s fail-closed + 拒絕斷路器。無人在做「代理審批代理」。
2. **Memories**——跨會話持久記憶 + ad-hoc 筆記（`memories_1.sqlite`）。
3. **Skills 多源選擇器**——影子 BM25/ngram 離線評估選擇器品質；模型可觸達（`skills/list`、`skills/read`）。
4. **Claude 相容 hooks 契約**——Matcher 群組、McpTool/Prompt/Agent 三種 handler 型別、per-handler hash 信任狀態、PermissionRequest fail-closed。
5. **Windows sandbox Elevated 級**——private desktop + WFP + conpty；三級模型；直擊 IH M22 讀隔離未能達成的部分。
6. **durable thread queue + goals**（`queue_1.sqlite`、`thread_goals`）。
7. **`get_context_remaining`** 模型工具。
8. **exec-server 遠程執行**——noise-channel 加密傳輸 + attestation。
9. **插件命令遷移**（Cursor/Claude commands → SKILL.md）。
10. **`send_user_message_async`** 模型主動異步通訊。

## 4. key judgment：frontend-web 分支的架構缺陷（影響 C 區回收方式）

- web-host 為 transport-only「接縫注入」設計：agent 運行由 embedder 塞 `sessionRunner` 回調 → 1,598 行 `apps/cli/src/web.ts` + `live-agent.ts` **複製了 runHeadless 的裝配**（live-agent.ts:3-12 明說 replicate）。
- 引擎補丁（goal/job 事件、DurableJobRecord、probe/models 等 44 文件 +3.3k 行）綁定在分支側；web-host 對主線 4 個新包有值級 import + core-session 新事件類型 → **離開分支無法 typecheck**。
- 結論：機制層（goal/jobs/feedback/workspace/settings/credentials/plugin-registry/mux 協議）全部可回收；**host 重寫時必須去掉複製膠水**（見 roadmap C）。

## 5. I-harness「已贏不退」清單（五源中領先/持平的）

- sandbox（win-ACL fail-closed）——opencode 完全無沙箱；dsh/codex 同位。
- session-query：FTS + lineage（opencode LIKE only）。
- MCP reconnect supervisor（opencode/dsh/codex 皆無自動重連）。
- subagent teams：roster/mailbox/task-board（opencode 輕量化、codex 純對話式、dsh experimental）。
- 子代理/dsh 語義一致：tool_search BM25、skill 存取、spill、workflow、LSP——不輸任何單源。
- 零外部依賴紀律 + Windows 優先 + fail-closed 文化（審計鏈保證）。

## 6. 四源回收結論（roadmap 的輸入）

1. **A 區**：輸入分級/持久化（dsh 概念 + codex queue 持久化）、多 session 協調、系統 context 快照（dsh）、repair（dsh）、plan mode、標題、guardian（codex）、get_context_remaining（codex）。
2. **B 區**：MCP OAuth/資源/安全啟動（opencode/codex）、PTY（dsh）、web 存取、LSP 擴充、統一 spill 升級、git revert（opencode/codex）、進程控制面（codex）。
3. **C 區**（空白域）：web-host 回收重寫（分支）→ SDK（dsh/codex stdio 形狀）→ auth（dsh）→ 模型目錄（分支已有）→ ACP（遠期）。
4. **D 區**：durable 任務協議 + 背景執行 + 取消樹/配額（opencode/codex 概念 + 分支 spine）+ 任務控制工具。
5. **E 區**：settings/credentials/workspace/plugin-registry/feedback/goal（分支 as-is）+ hooks（codex 契約）+ schedule（dsh）+ config 多層/熱更新（dsh）。
6. **遠期/不行動**：ACP、分享/enterprise、webhook、遠程環境、外部進程子代理、memories、workflow worker 升級、PTC 收斂（範式決策）、code-mode（範式決策）。

## 7. 附註

- 參考同行研究文檔：2026-08-16 codex-research（v0.146）、2026-08-26 codex-multi-agents-v2、dsh-risk-audit、i-harness-vs-dsh-parity。
- 五份 roadmap：`docs/roadmap/2026-08-31-roadmap-{A..E}-*.md`（本表 R 編號基準）。
