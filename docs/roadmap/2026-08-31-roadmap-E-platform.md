# Roadmap E — 平台 / 生態（platform & ecosystem）

> 2026-08-31 · 基於 `docs/audit/2026-08-31-fiveway-comparison.md`。候選清單，取捨記 §6。
> **背景**：本區有一批項目在 frontend-web 分支已是**全綠測試的 IH 語彙實現**（settings/credentials/workspace/plugin-registry/feedback/goal/jobs 域）——回收它們 = cherry-pick 分支包 + 少量引擎補丁，而不是重寫。分支的「插件代碼永不執行」姿態是親審計的（對比 opencode 無隔離 / dsh vm 非隔離）。

## 1. 該區現狀 vs 目標

**現狀**：interaction seam（approval/question/command host 回調）、skills（SKILL.md 掃描）、workflow（YAML）、telemetry（13 事件）、preset。**無**：配置層、憑據層、workspace 實體、插件生態、hooks、goal/schedule/jobs/feedback、provider 廣度。

**目標**：用戶可配置性（settings + 憑據）、生態互通（plugins + hooks）、產品域（goal + feedback + jobs/schedule）、模型多樣性（provider）。

## 2. 候選里程碑表

| # | 名稱 | 一句話 | 五源來源 | 成本 | 依賴 | 建議節點 |
|---|---|---|---|---|---|---|
| R-E1 | settings 配置層 | settings.json + section 協議（revision-guard） | **分支（as-is）** + dsh（命名空間/熱更新/註釋保持） | S | fs | 第一優先（回收） |
| R-E2 | credentials 憑據 | env > 檔案粒度、引用而非值、shadowed 拒絕寫 | **分支（as-is）** + dsh（refs-not-values） | S | fs、settings | R-E1 同批 |
| R-E3 | workspace 實體 | 文檔庫 registry（create/rename/attach/archive）+ 有界瀏覽 | **分支（as-is，僅依賴 session-persistence）** | S | session-persistence | R-E1 同批 |
| R-E4 | plugin-registry 插件生態 | 市場源 + 安裝（路徑約束、兩階段複製）+ status 評估 + 許可/命令/技能 materialize | **分支（as-is，唯一補丁 writeFileAtomic(mode)）** | M | fs、skills | R-E1 同批 |
| R-E5 | hooks 系統 | 事件（tool/permission/stop/compact/session…）+ handler 契約 + 信任 | codex（完整契約）/ dsh（CC/Codex 橋） | M | core-plugin | 中長期 |
| R-E6 | goal | goal/change 事件 + get/create/update 工具 + 輪次注入 | **分支（as-is）** + codex（thread_goals） | S | core-session | 快速回收 |
| R-E7 | jobs | job fold + kill bridge（讀 subagent 快照 doc） | **分支（as-is）** + opencode（durable 化遠期） | S | subagent | 快速回收 |
| R-E8 | feedback | 文檔側車 + CAS 版本 | **分支（as-is）** | S | coordinator | 快速回收 |
| R-E9 | schedule | 持久 schedule/change + 本地驅動器（min 300s、重啟後重驅動） | dsh | S | core-session | 可插空 |
| R-E10 | config 深化 | 多層載入/熱更新/註釋保持 | dsh（settings-file） | M | R-E1 | 遠期（先用 E1） |
| R-E11 | provider 廣度 | 更多協議（gemini/bedrock/…）+ variants + live discovery | opencode（35+）/ codex（bedrock） | M | provider | ~~遠期（M20 約束「不新增」→ 決策項）~~ **gemini/bedrock 已於 M30 落地（用戶拍板覆蓋 M20 不新增）；剩 variants/live discovery 遠期** |
| R-E12 | webhook | 驗簽 + 觸發 workspace session | dsh | M | R-E3、R-C1 | 遠期 |
| R-E13 | 身份 | 匿名 UUID 檔案 | dsh | S | — | 遠期（無產品需求） |

## 3. 每項詳情

### R-E1 settings（回收）
- 分支 `packages/settings`（478+554 LOC，38 tests）：原子 JSON（tmp+rename）、section 協議（describeSection/mutateSection、revision-guard 409）、`llm`+`onboarding` 兩 section；消費方：web-host 與 CLI glue。
- **IH 化合入**：引擎包本身不讀（web glue 讀）——**接入策略**：runHeadless / HeadlessOptions 擴 `settings?: Settings`（host 決定），保持引擎無強依賴；或 M26 評審「引擎直接讀」與「host 注入」的取捨（dsh 是引擎直接讀多層）。

### R-E2 credentials（回收）
- 分支 `packages/credentials`（211 LOC）：env > 檔案、describe 單向（不回傳值）、`CredentialShadowedError` 拒絕 shadowed 寫；**解決「憑據怎麼進 provider」**：分支用 CLI glue resolveModel（`credentials.resolve(env) ?? process.env[env]`）。
- **IH 化**：provider 層加 seam（buildModelClient 前解析）比照分支；dsh 的多層（env > .credentials.yaml > cwd/.env > home/.env）可作為 E10 深化。

### R-E3 workspace（回收）
- 分支 `packages/workspace`（477 LOC，24 tests）：coordinator documents key `workspace-registry`；**單獨依賴 session-persistence——可直接合主線**；files.ts 有界瀏覽（500/3000/8, 排除 node_modules/.git/.i-harness/dist）。

### R-E4 plugin-registry（回收）
- 分支 `packages/plugin-registry`（2,166 LOC，118 tests 含真實 git clone/URL）：4 種市場源 + object-form；`install/state/materialize`；**插件代碼永不執行**（僅解析 manifest/.mcp.json/commands markdown）；評估 = 狀態報告（disabled/initializing/ready/degraded/failed）非安全 gate；安全姿勢在路徑約束 + 不執行 + approval fail-closed。
- **合入主線的最小補丁**：`fs.writeFileAtomic(mode)`（分支擴 1 參數）。
- **決策點**：是否要「插件執行」？（opencode 全權限 in-process、codex 沙箱 MCP/鉤子、dsh vm 白名單但自述非隔離）——**建議維持「不執行 + host 審批」**，如後續要執行再以 codex 的「插件 MCP 伺服器沙箱啟動 + 鉤子 per-handler 信任」為參考（R-E5 借力）。

### R-E5 hooks 系統
- **codex 是完整契約**（9 事件 matcher + Command/McpTool/Prompt/Agent 3 handler + per-handler hash 信任 + PermissionRequest fail-closed + 並發執行/背景 spooling）；dsh 是兩橋（CC/Codex）**已達互通**。
- IH 化：core-plugin 已有 waterfall/cascade——新包 `hooks` 接 `tools/execute` + `agent/pre-step` + `session.stop`；**第一步做 CC 相容輸出語義**（HookOutput: continue/stopReason/decision/block+reason）→ 第二步 matcher/信任。

### R-E9 schedule
- dsh `schedule/change` 持久事件 + 本地驅動器（agent/status 重驅動、重啟重盤）；IH 化：core-session 事件 + 驅動器掛 agent 循環（與 A1 收件箱互動——「定時 followup」）。

### R-E11 provider 廣度（gemini/bedrock 已於 M30 落地）
- M20 spec §1.2 全域約束：「**不新增 gemini/bedrock/內嵌模型**」——這是當年決策。opencode 35+ / codex bedrock 是改決策的信號但需明確同意；**列為決策項**：維持 3 協議 OR 擴 gemini/bedrock。
- **M30（2026-09-02）**：用戶拍板覆蓋 M20「不新增」——gemini（原生 Google GenAI REST）與 bedrock（AWS Converse，新公開依賴 `@aws-sdk/client-bedrock-runtime`）已為 first-class provider（協議/regex 分派/settings/CLI 內建 profile/modelContexts 齊備）。剩餘遠期：variants 與 live discovery（bedrock probe 暫以靜態 catalog 兜底）。

## 4. 排序建議

1. **回收組（直接收）**：R-E1 + R-E2 + R-E3 + R-E6 + R-E7 + R-E8（分支 as-is / 近乎 as-is）→ R-E4（含 1 函數補丁）
2. R-E9（小）→ R-E5（中長期）
3. R-E10、R-E11、R-E12、R-E13 遠期或決策項

## 5. 依賴交叉

- 回收組是 C 區 R-C1 的天然接縫（web-host 已對接這些包的接口——去掉膠水後 C 區直接裱這層）→ **回收組應先於/併行 C 區**。
- R-E4 與 B 區 R-B6（skills 插件根）互動。
- R-E5 hooks 與 guard-approval（R-A9 guardian）互動——hook 可在 approval 前注入決策。

## 6. 取捨紀錄（待填）

| # | 決策 | 註記 |
|---|---|---|
| R-E1 | **M26 回收** | 六件回收組 as-is（C 區 C1 接縫所在） |
| R-E2 | **M26 回收** | 同批 |
| R-E3 | **M26 回收** | 同批（僅依賴 session-persistence，可先合） |
| R-E4 | **M26 立即** | as-is + writeFileAtomic(mode) 一函數補丁；插件不執行代碼姿態維持 |
| R-E5 | **M26 立即** | hooks：CC 相容輸出語義 + 9 事件先行（codex 契約 + dsh 橋） |
| R-E6 | **M26 回收** | goal：分支 as-is |
| R-E7 | **M26 回收** | jobs：分支 as-is（durable 化隨 D 區任務協議遠期） |
| R-E8 | **M26 回收** | feedback：分支 as-is |
| R-E9 | **M26（隨 E6）** | schedule：與 goal 同族，隨手補 |
| R-E10 | 遠期 | config 深化（多層/熱更新）——先以 E1 為主 |
| R-E11 | 已落地（M30） | provider 廣度（gemini/bedrock）——用戶拍板覆蓋 M20「不新增」；餘項（variants/live discovery）遠期 |
| R-E12 | 遠期 | webhook（產品面） |
| R-E13 | 遠期 | 匿名身份（無產品需求） |
