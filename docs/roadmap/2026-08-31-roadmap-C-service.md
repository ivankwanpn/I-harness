# Roadmap C — 服務 / API 面（service surface）

> 2026-08-31 · 基於 `docs/audit/2026-08-31-fiveway-comparison.md`。候選清單，取捨記 §6。
> **背景判斷**：frontend-web 分支已有完整試點（web-host 40+ 路由 + WS mux + approvals/questions/goal/jobs/feedback，測試全綠），但其「transport-only 接縫注入」設計導致 1,598 行膠水複製 runHeadless 而被中止（審計 §4）。本區的回收前提 = **架構決策（R-C0）先拍板**。

## 1. 該區現狀 vs 目標

**現狀**：主線零——唯一對外接口是 `runHeadless(task, opts)` lib API + batch CLI + stdout JSONL telemetry。分支有 web-host 但 4 包引擎補丁未合主線。

**目標**：能承載前端/遠程客戶端的「agent 服務」：session 操作面 + live 事件 + 認證 + 對外 SDK。協議形狀在「WS mux + HTTP unary」（分支/dsh 風格，貼近零依賴）與「stdio JSON-RPC」（dsh/codex SDK 形狀）之間取捨——**對外 SDK 建議 stdio，主服務面以分支+dsh 為基**。

## 2. 候選里程碑表

| # | 名稱 | 一句話 | 五源來源 | 成本 | 依賴 | 建議節點 |
|---|---|---|---|---|---|---|
| R-C0 | **架構決策：service 姿態** | engine-owned session 執行 vs transport-seam 注入（分支的缺陷是膠水複製） | 分支（教訓）/ dsh api / opencode server | 決策 | — | **第一**（先拍板） |
| R-C1 | 服務層核心 | HTTP unary + WS mux host（40+ 路由），session 操作面 + live 流 | 分支 web-host（機制層）+ dsh gateway | L | R-C0、R-A1、R-A2 | C 區首個 |
| R-C2 | 事件流 + 回放 | live 事件訂閱、seq 回放、分頁歷史 | 分支（live/mux/pagination）/ opencode（after=seq） | M | R-C1 | C1 之後 |
| R-C3 | 認證 | HMAC cookie + launch token + DNS-rebind 柵欄 | dsh（browser-auth + api-request-trust） | S | R-C1 | 可並行 |
| R-C4 | 外部 SDK | stdio JSON-RPC 子進程 SDK（initialize/session.prompt/事件通知） | dsh（sdk/protocol+client）/ codex（TS SDK） | M | R-C1、R-C2 | C1 之後 |
| R-C5 | 模型目錄/探測/每 session 選擇 | provider describeDirectory/probeModels + model selection 持久化 | frontend-web 分支（已有 IH 語彙版）+ opencode live discovery | S | provider | **reuse**（分支已存在） |
| R-C6 | telemetry 事件碼擴充 | 從 13 事件擴到 manifest 級（session/turn/tool/provider/token/mcp…） | opencode（~60 碼）/ codex（事件通知全集） | S | R-C1 | 隨 R-C2 |
| R-C7 | ACP | automation-only ACP server | dsh（@agentclientprotocol/sdk） | M | R-C1 | 遠期（產品需再定） |
| R-C8 | 會話分享/遠程 | share 表 + 託管端 + webhook | opencode / dsh | L | R-C4 | 遠期（產品面） |

## 3. 每項詳情

### R-C0 架構決策 ★先決
三種姿態：
1. **engine-owned**（推薦）：把 runHeadless 的裝配下沉為可例化的 SessionServer（registry + coordinator + guard 組），server/host 只是它的 API 面；膠水消失，分支的 web-host 機制層（mux 協議、approval/question 快路、goal/jobs/feedback 域）直接內嵌。
2. **transport-seam**（分支姿態）：host 只是接縫，embedder 自己裝配 → 膠水複製是代價（已被證明）。
3. **雙態**：引擎 side 提供 injectable 運行時（如現在 runHeadless properties），server 面默認省略——flexible 但接口面大。
- 決策影響 A/D 區（R-A2 多 session 直接受益於 1）。

### R-C1 服務層核心
- **機制層回收**（分支）：mux.ts 信封（`{type:"open",streamId,endpoint,payload}`/cancel）+ approval/answer 快路 + heartbeat + 8MiB 慢消費上限 + refcount 流緩存；session/chunk/reasoning/agent-state/command/telemetry 端點；models.ts + credentials/settings/workspace/plugin-registry 接縫（R-E 區包）。
- **必須重寫件**：「live-agent 複製 runHeadless」膠水（`apps/cli/src/web.ts` + `live-agent.ts` 1,598 行）→ 按 R-C0 姿態 1 變成 Service 邊界。
- 引擎補丁（分支 44 文件 +3.3k 行：goal/job 事件、DurableJobRecord、probe/models 等）按選擇性吸收（goal/jobs 隨 R-E6/R-E7）。

### R-C4 外部 SDK（建議 stdio 形狀）
- dsh `sdk/protocol`（NDJSON JSON-RPC 2.0 幀）+ `HarnessClient`/`DeepSeekHarness.run`；codex `sdk/typescript`（子進程 app-server）。
- **為什麼 stdio 而非多一套 HTTP**：dsh/codex 兩代產品最終都選 stdio 子進程 SDK（啟動/隔離/平台一致）；HTTP 面（R-C1）留給 UI/mux。
- IH 化：新包 `sdk`（協議 + client + server 插件），選項可對齊分支 runHeadless 的 HeadlessOptions。

### R-C5 模型目錄/探測（reuse）
- frontend-web 分支已有：provider `describeDirectory/probeModels` + `GET /api/models/catalog` + `POST /api/sessions/:id/model`（persisted per-session）+ `SettingsSection llm`。
- 合主線時帶 provider 補丁即可（+476 行）。

### R-C6 telemetry 擴充
- 分支已暴露 telemetry 端點；opencode/codex 的碼名（session.next.*、turn/*、item/*、hook/*）為參考。擴 manifest 不推翻 sink 設計（improved-writing 保留 JSONL）。

## 4. 排序建議

1. R-C0（決策）→ R-C1 → R-C3、R-C5、R-C6 → R-C2 → R-C4
2. R-C7、R-C8 遠期

## 5. 依賴交叉

- R-C1 需要 A 區 R-A1（輸入分級）與 R-A2（多 session）就位；反之 C1 的 session 操作面也啟用 A2。
- R-C0 姿態 1 直接決定 A2 的實現位置（engine 級 vs host 級）。
- R-C4 的 stdio 形狀與 R-C1 的 mux 可並存（dsh 即如此）。

## 6. 取捨紀錄（待填）

| # | 決策 | 註記 |
|---|---|---|
| R-C0 | **engine-owned** | runHeadless 裝配下沉為 SessionExecutor；服務層僅為其 API 面；膠水消失 |
| R-C1 | **M26 立即** | 四件同批（C1/C2/C3/C6 互相咬合） |
| R-C2 | **M26 立即** | 同批 |
| R-C3 | **M26 立即** | 同批（dsh 形狀：HMAC cookie + launch token + DNS 柵欄） |
| R-C4 | 後補 | stdio SDK 待 UI 首個消費方（dsh/codex 先例已備） |
| R-C5 | **M26 隨手補** | 分支 reuse（probe/directory + per-session model） |
| R-C6 | **M26 立即** | 同批（事件碼擴充） |
| R-C7 | 後補 | ACP 兼容策略待產品定 |
| R-C8 | 遠期 | 分享/遠程（產品面） |
| R-C1 | （執行註記 2026-08-31） | ① 全局 surface 改名 `SessionService`（A 區已先佔 `SessionExecutor` = 每 session lane）；registry 即 A 的 per-session lane。② A 的 `drain()` 失敗即 reject → service.submit reject → host error frame。③ E 區全套（settings/credentials/workspace/plugin-registry/goal/jobs/feedback）已落地 → branch host.ts 全路由直接實裝（無 duck face、無 modelProtocol 暫存模組）。④ run.ts 環境下沉到 `createSessionAssembly`（policySession 選項保 sandbox 解析語義）。⑤ web-host 靜態 SPA 延後（C 範圍外）+ `Endpoint` 去掉 team/telemetry。⑥ A 區命令名（session/send 等）正名為 DSH 文法（session-send……）。⑦ mux ready 幀在 open 幀之後（以 branch mux 為準）。⑧ 附加 IMAGE 常量轉 core-session 導出。 |
