# M46a — Provider/模型 TUI 管理 + Slash 註冊表擴展 + 鍵表真理 + 新版界面跟進

日期：2026-09-05 · branch m46a（自 main 出）· 源：三路研究合併——黑盒實證（DeepSeek 自定義模型真跑通 `grok -p`；TUI 登錄牆）+ 新版源碼 delta（70 slash/8 分類 settings/鍵表重排/新 surfaces；**新版為複刻真源**——規格 §4 標註 superseded）+ cc-custom provider 機制（providers.json v2 形狀/三步嚮導/apiKey 明文→我們改 refs）。範圍（用戶）：slash 只做**後端真支持**的功能；組件都「跟進新版」。

## 0. 目標

1. **Provider/模型 TUI 管理**——`/provider`（cc-custom 形狀 → 我們的 settings+credentials(apiKeyRef)+model-catalog+probe-apply；per-provider 協議=我們更豐富）+ `/model`（ArgPicker 式——grok 真做法：slash 參數下拉）+ `/effort` + **settings modal（新版 8 分類結構：Appearance/Mouse/Models/Approval/…——只做有真旋鈕的類，其餘標記 v2）** + agent-screen Ctrl+M 模型選擇器。
2. **Slash 註冊表**——grok 註冊表形狀（builtin 列表 + 每命令 `visible()`/門控）+ **映射清單**（後端真支持，見 §2）+ 配套輕量面板。
3. **鍵表真理更新**——新版為準：Ctrl+S=stash/pop 草稿、F3=sessions、Ctrl+G 模式拆分（全屏 tasks/minimal $EDITOR）、Ctrl+B=送後台、Ctrl+R=mouse-reporting（opt-in 門控——m46b 生效，本輪僅鍵表槽位）。
4. **新版界面跟進（輕量版）**——usage modal（tab 簡版）、goal 詳情 overlay、MCP status modal、welcome 更新（F3/ctrl+l Changelog 行——login-gate 菜單我們無 grok 賬戶→誠實省略）、prompt stash、`/tutorial`、workflows 輕量（我們有 workflow 包）。**跳過**：dock（特性門控）、privacy banner（無遠程公告）、elicitation（xAI ACP 專有）、import-claude（無 Claude 導入）、login/logout/share（無賬戶面）、video viewer（m46b 或後——圖形協議受限）。

## 1. Provider 管理（G1 核心）

- **模型**（對 cc-custom v2 形狀）：`{ id, name?, baseUrl(無尾斜杠), protocol: "openai-responses"|"openai-compatible"|"anthropic"|"gemini"|"bedrock", apiKeyRef?, modelsUrl? }` 存 **settings**（我們的 settings 分層——不作新 json；apiKeyRef → credentials（refs-not-values 原則，**不複製 cc 的明文**））。
- **發現**：`/v1/models` 候選 URL 策略（cc-switch 繼承 + 我們已有的 probe-apply 線——`modelsUrl` + 默認 base_url 規則）+ per-provider 目錄浸入 model-catalog 運行時體（不落硬編碼文件——設定內存 + settings 補丁）。
- **TUI 面**（cc-custom 佈局 1:1 適配）：`/provider` 菜單（`Manage providers` 標題 + `* active` 標記 + `+ Add provider`/`Delete provider...` + 底部 `↑/↓ to choose · Enter to … · Esc to cancel`）+ 三步嚮導（Provider ID/Base URL/API key 遮罩 `Leave empty to keep the current key.` `↑/↓ to switch fields`）+ 刪除視圖 + arg 變體（show/list/set/use/delete/reload——reload=probe 重跑）。
- **模型選擇**：`/model [name [effort]]`——suggest-args 來自活動 provider 目錄（ArgPicker 列 10 + `and N more…`）；`/effort <level>`（6 檔）；每 session 選擇穿透 settings（userModel）+ 會話記憶。
- **設定 modal Models 類**：`default_model`（DynamicEnum + `(no override)` 清除——grok 模式）+ `[provider]` 現狀行。
- 對接：`apps/tui` factory 的 `modelBuilder` 縫（M37a 待接縫——本輪接：settings 讀 provider/模型 → 構建解析鏈（M31 已有全鍊）→ mock 默認改為「無 provider → mock」）。
- PTY **case-021**：`/provider add` 三步 → DeepSeek（base_url+key ref 錄入）→ `/model` 選擇 → 下輪 prompt 用真模型?（測試用 mock——但**完整鏈路**：provider 儲存 → 解析 → mock 替換（配置裏 `modelsUrl` 指向 mock server?）——誠實做法：provider 面存/切/發現用「probe 打真 DeepSeek」（網絡依賴測試:標註 `network` 選跑）或 mock 目錄注入——選 **可注入目錄**測試，DeepSeek 真探測留手動 smoke 腳本（不進 CI）。

## 2. Slash 註冊表（G2）

- `src/app/slash/registry.ts`——`CommandRegistry { builtin() }` + `SlashCommand { name, aliases, description, run(ctx), visible?(ctx), argumentHint? }`（grok 形狀）；下拉/補全從註冊表（M37b dropdown 對接）。
- **映射清單（後端真支持）**：
  會話：`/new` `/home` `/resume`（picker 重用）`/delete`(確認) `/rename` `/session-info`(面板)
  導航：`/find`（引擎搜索焦點）`/jump`（turn 列表面——輕量新視圖）`/history`（prompt 歷史面板重用）
  模型：`/model` `/effort`（G1 共用）
  運行：`/rewind`（M42/43 全鏈）`/plan` `/view-plan`（適配）`/compact`（session-compact 命令面）`/queue` `/tasks`（面板 toggle）`/btw`(既存)
  視覺：`/theme`（kind 循環）`/timestamps` `/multiline` `/compact-mode`（三個真旋鈕）`/minimal` `/fullscreen`(既存)
  審批：`/always-approve` `/auto`（guardian/approval 面）
  工具：`/doctor`（probe 重跑 + 報表面板）`/copy`（複製）`/export`（會話 txt 寫檔）`/transcript`（$PAGER 簡版：寫臨時 ansitxt + spawn pager——既有 minimal /transcript 縫）`/help`（鍵表速查）`/quit`
  生態（輕量列表面板——後端真源）：`/skills` `/mcps` `/hooks` `/plugins` `/marketplace` `/personas` `/config-agents`（列+狀態；Enter 只讀詳情——編輯面 v2）`/workflow`（包面：run/list/status）
  新面：`/usage`（簡版 token 面板）`/goal`?（goal 詳情 overlay——事件面）`/tutorial`（topic 列表：終端診斷/鍵表/鼠標（m46b 後）/minimal）
- **跳過**（記錄）：/share /login /logout /import-claude /remember /recap /loop /voice /imagine* /gboom /cd /fork(dashboard 一體) /edit-prompt?（$EDITOR 縫——v2）/expand（minimal/m46b）/toggle-mouse-reporting（m46b 生效——註冊表槽位佔位）。
- 鍵表真理（G3 統一落地）：Ctrl+S stash（+Alt+S）、F3 sessions、Ctrl+G 拆、Ctrl+B bg、Ctrl+R 槽位（m46b 門控）。

## 3. 分組

- **G1**：settings 讀寫面（provider CRUD + models 目錄 + default）+ provider 三步嚮導/菜單/刪除視圖 + `/model` ArgPicker + `/effort` + settings modal（8 類結構——Appearance(dark/theme compact/timestamps)/Mouse(旋鈕定 m46b——類骨架)/Models(active)/Approval(guardian、always-approve)/Session(compact-mode)）+ factory modelBuilder 縫 + 注入式目錄測試 + **case-021 PTY**。
- **G2**：slash registry + 映射清單全部命令（可見性/門控）+ 輕量面板（skills/mcps/hooks/plugins/personas/usage/session-info/goal-detail/tutorial/workflow）+ stash/alt+S + welcome 更新（F3/ctrl+l Changelog 行）+ 鍵表真理（Ctrl+G/B 拆）+ 單測（註冊表/可見性/每命令 run 斷言）。
- **G3**：全量驗證 + docs（UI 規格「新版真源」附錄 + README m46a 行 + CAPABILITIES-DETAIL provider 面）+ 推送。

## 4. 硬規

- 後端零改動（provider=settings+credentials+catalog 只讀組合；probe-apply 已存在——WIRING only）。真網絡探測（DeepSeek）只作手動 smoke 腳本——CI 用注入目錄。
- credentials 只存 refs（不複製 cc 明文）；settings 分層/註釋保持沿用。
- 規格舊 repo 標註 superseded（研究 doc 附錄）。
- PTY 慣例（budget/pins/chcp）+ 既有 case 全綠。
