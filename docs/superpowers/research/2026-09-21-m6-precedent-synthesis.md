# M6（廣度：生態＋介面硬化）—— 七源＋ZCode 研究綜合、重量與採用/改良/丟棄矩陣

**日期：** 2026-09-21 · **基準：** `m66` @ `86c22ba1` · **性質：** **M6 spec 的輸入**。roadmap §1.1 的「引用的 triage 項進 spec 前對現行 HEAD 重量」**已在此完成**。

**彙整的來源：**
- `docs/audit/2026-09-11-sevenway-backend-mechanisms.md`（D3 七源矩陣，量於 m62）
- `docs/handoff/2026-09-21-zcode-prior-art.md`（ZCode 調研 —— 第八源）
- `docs/handoff/2026-09-18-prior-art-survey.md`（Codex／Grok／opencode：D1 信任、D2 投影、治理儀器）
- `docs/handoff/2026-09-18-prompt-cache-prior-art.md`（改變投影／前綴紀律）
- `docs/audit/2026-09-15-backend-gap-triage.md`（13＋2＋2 列的出處）

**方法：** 三路唯讀量測代理（技能/內容 7 列 · MCP 6 列 · 介面 4 列），各自回報**指令＋`file:line`**；controller 對載重主張獨立複驗（§5 列名）。**決策欄是 controller 的裁定**，每條附量測依據與 IH 設計約束的相容性檢查。

---

## 使用前提（先讀這段，否則整份會讀錯）

**IH 的底子已經不錯 —— 這是量過的，不是客氣話。** 矩陣點名的既有強項今天都在且更深：skill deferred retrieval＋shadow selector、mcp generation reconnection＋OAuth **＋ stored token**（D3 說 IH 只缺的 OAuth 變體其實 2026-09 起已有）、plugin kernel 四通道、hooks 四通道＋每次重算的信任、`sections.ts` 的封閉投影形狀、runtime-context 的**尾端追加**投影（前綴安全）。

**⇒ M6 不是重寫，也不是「追上七源」。** 這一輪的目標（依 owner 2026-09-21 的指示）：**把量到的淺缺口補掉、把量到的斷點修掉；每一列只借「缺的那一半」，且每個借用要過 IH 既有設計的相容性檢查 —— 整包搬＝過度設計，而且會撞既有裁定。**

---

## 1. 重量結果（§1.1 的閘門輸出）

| # | 列 | 2026-09-11 的處置 | **今日判定** | 最關鍵的一條依據 |
|---|---|---|---|---|
| 1 | `mcp-transport-variants-and-startup-negotiation` | rewrite | **形狀已變**——五變體中的 OAuth persistor＋stored token **已有**；只缺 SSE 與 in-process duplex | `packages/mcp-client/src/oauth.ts:58-77,206-215`；`grep SSEClientTransport|InMemory` = 0 |
| 2 | `mcp-tool-catalog-ingest-and-exposure-hardening` | rewrite | **形狀已變**——**分頁已在**（cursor 迴圈、頁數上限 100、同頁重名拒絕）；缺三個界＋刷新 | `packages/mcp-client/src/bridge.ts:60-79`；缺：重複 cursor／總數上限／整體 timeout |
| 3 | `mcp-elicitation-and-server-initiated-input` | rewrite | **真缺口**（且 **rendezvous 先於 elicitation**） | 全樹 `elicitation` 僅 1 註解命中；`ask_user_input` 的 provider 生產端**零註冊**（恆 `NO_PROVIDER`） |
| 4 | `mcp-resource-retrieval-tools` | rewrite | **已是 false gap**——三個工具早在 m62 就在生產路徑 | `git show m62:…/supervisor.ts` 有 `createResourceTools`；只缺快取（無壓力） |
| 5 | `mcp-server-mode-over-stdio` | 不做（Q4） | **維持延後**——具名消費者未出現 | `createSdkServer|createAcpServer` 樹內零外部驅動；`grep` 空 |
| 6 | `plugin-runtime-state-and-readiness-reporting` | rewrite | **形狀已變**——狀態（`state.json`）、就緒詞彙（`evaluatePlugin`）、unsupported-key 記錄**全在**；缺的是**回報面（消費者）** | `evaluatePlugin`＝孤兒 export（allowlist deferred 組，註記待產品決定） |
| 7 | `filesystem-skill-discovery-and-root-precedence` | rewrite | **真缺口（只剩專案根那半）**——user root 已有、plugin root 已修好且有生產呼叫者；缺 cwd 之上的專案根發現＋相容目錄 | `registry.ts:207-210,106-108,212-216`；`.agents/skills` 類 0 命中 |
| 8 | `skill-registry-layered-precedence-and-caching` | reuse | **分層＝false gap**（三階按名合併、pinned）；**快取＝真缺口但零壓力** | `registry.ts:218-224`；六檔 grep cache/mtime = 0；每呼叫兩趟全掃 |
| 9 | `skill-catalog-and-guidance-injection` | rewrite | **真缺口（catalog 那半）** | 生產 runtime-context section 只有 2 個，無技能目錄；`grep -i skill packages/preset` = 0 |
| 10 | `explicit-and-implicit-skill-invocation` | rewrite | **真缺口（sigil 掃描那半）** | 全樹 `sigil` 0 命中；使用者輸入是不帶結構的字串 |
| 11 | `bundled-skill-registry-with-lazy-extraction` | rewrite | **真缺口（整列）但無產品輸入** | 技能只能磁碟掃描；dist 不出貨技能 |
| 12 | `subagent-bundle-cache-with-user-edit-preservation` | rewrite | **形狀已變**——無 bundle 可快取；風險面在 install 的 `rm -rf` 與 materialize 的先刪再複製 | `install.ts:288-290`；`materialize.ts:32-39` |
| 13 | `workspace-instruction-baseline-and-change-projection` | rewrite | **已是 false gap**——**變更投影已存在**（mtime/size 快取＋尾端追加一則） | `packages/instructions/src/index.ts:27-43`；`runtime-context/src/index.ts:46-60`＋測試 |
| 14 | `connection-handshake` | rewrite（值得做） | **真缺口（執行見證）**——未握手即可呼叫任何方法；clientInfo 送了沒人讀 | §2 D-WIRE-1 |
| 15 | `output-backpressure` | rewrite（值得做） | **真缺口**——輸出無界、`send` 丟棄結果、無過載碼；**resync 半已在** | `protocol.ts:593-595`；`session/history`＋seq＋不重播 |
| 16 | `settings-seam` | rewrite | **已是 false gap**——縫已是 Codex 形狀（封閉 union＋CAS＋redaction）；缺的是**消費者** | `sections.ts:21,65-67,70-80`；Q7＝走 (a) 但現在不建 |
| 17 | `operator-config-layer-stack` | rewrite | **形狀已變**——層疊**已存在但無消費者**；缺的是**來源歸因**；requirements 半無載體 | `settings/src/index.ts:889-944,1119-1359`；`resolveHarnessHome` 回裸字串 |

**小結：17 列裡，3 列已是 false gap、5 列形狀已變（多半只缺一小塊）、8 列真缺口（其中 3 列無今日輸入）、1 列維持延後。**

---

## 2. 新量到的缺陷與斷點（本輪的頭條）

**D-MCP-1（活缺陷，四環鏈＋執行見證）— plugin MCP 掛載 100% 失敗。**
1. `mcpServerKey(id, server)` 組出 `plugin:<id>:<server>`（`plugin-registry/src/install.ts:189-191`；註解自稱 grammar 是 `[A-Za-z0-9_.:-]`）。
2. `validateMcpConfig` 要求 `^[A-Za-z0-9_-]{1,32}$` —— **不含冒號，且有 32 字上限**（`mcp-client/src/types.ts:80-84`）。
3. `mountMcpClient` **第一行就驗**（`mcp-client/src/scheduler.ts:47`）。
4. assembly 逐 server 吞成 `warn` ＋ `pluginMcpResults=false`（`session-executor/src/assembly.ts:923-934`）。
**執行見證**（controller 實跑）：`plugin:Marketplace_A__proxy:echo` 與**最乾淨的** `plugin:hello:mcp` 都被拒（`serverName must match ^[A-Za-z0-9_-]{1,32}$`）。
**後果：** 生產唯一可達的 MCP 掛載路徑（plugin `.mcp.json`）**全數休眠**——`pluginMcpResults` 恆 false、（推論）`evaluatePlugin` 的 mcp 維度恆 failed；列 1–4 的「現況」在生產皆不可觀測。**32 字上限是第二把刀**（長 id＋server 會再撞）。

**其他斷點（各自有量測）：**
- **D-MCP-2**：`.mcp.json` 的 `type` 被**靜默丟棄**（`install.ts:106-128` 不讀 type）⇒ `{"type":"sse",…}` 會以 streamable-http 掛——封閉 union 外的方言，無診斷。
- **D-MCP-3**：catalog 只在 generation 建立/重連時刷新（`tools/list_changed` 未處理）；`listTools` 不吃 `toolCallTimeoutMs`（每頁吃 SDK 預設 60s）。
- **D-MCP-4**：MCP 的 `readOnlyHint` 等 annotations 在 client 邊界被丟；MCP 工具恆 ask（無 `--yes` 即 fail-closed）——**若**要做「只讀 MCP 免問」，那是 D1 家族的信任錨決定，不能只把 `isReadOnly` 抄上。
- **D-WIRE-1**：`initialize` **不是閘**（代理執行見證：未握手即可 `session/prompt`）；`capabilities` 半已存在（8 常駐＋4 host-gated）。
- **D-WIRE-2**：`packages/sdk/src/server.ts:5-39` 的方法清單註解**已腐**（少列 6 個方法；權威是 switch 的 19 個 case）。
- **D-PLG-1**：plugin 生命週期動詞（install/enable/…）生產**無呼叫者**；就緒詞彙無消費者（產品決定待答）。
- **D-SKILL-1**：`allowImplicitInvocation` 無生產者；`skillsServiceName` unused export；`fs-watch` 全樹零消費者；instructions 認 `~/.claude` 而 skills 只認 harness home。
- **D-OPR-1**：7 個 unconsulted-setting 行——operator 平面的問題是 **reach**，不是 attribution。

---

## 3. 採用 / 改良 / 丟棄矩陣

**決策詞彙：** ✅ 採用（進 M6 spec 草案）· ◑ 選用（附條件，條件寫明）· ✗ 丟棄（現階段）· ⏸ 產品決定（上呈 owner）。

| # | 能力（列） | 來源 | 決策 | 理由與權衡（**只借缺的那半**＋相容性） |
|---|---|---|---|---|
| 1 | `connection-handshake` | codex（＋ZCode 的 `clientMode` 偽造案例） | ◑ **選用（條件：先裁版本級）** | 真的缺，但「initialize 必先」**不是 additive**（v0 FROZEN／v1 ADDITIVE-ONLY，`protocol.ts:13-20,46-48`）⇒ 這是 **PROTOCOL_VERSION 的裁決**，不是 appendix。今天 wire 的樹內消費者**只有測試**（TUI 已刪）——能力閘與漂移哨兵都只鎖 response 形狀。**取**：連線狀態捕獲＋閘；**不取**：ZCode 的 trusted clientMode（wire 無 clientId 欄位，會成為事件日誌推不出的新狀態）。 |
| 2 | `output-backpressure` | codex（＋ZCode 的 resync 不變量） | ✅ **採用（改良）** | **過載錯誤碼是 v1 明文允許的 additive**；**resync 半 IH 已有**（`session/history` afterSeq 獨佔＋seq＋不重播）。**只做**：每連線輸出的**一個界**＋界破時的**一個指名結局**（剔除或回 resync 指令——spec 裁），對 synthetic slow writable 測。**不取**：codex 的 32K/128 headroom 常數與 WS 細節。 |
| 3 | `mcp-transport-variants` | codex／ZCode | ✗ **丟棄（現階段）** | 對一條**量到死亡**的路徑（D-MCP-1）再加 SSE/duplex＝為假想消費者建。**先修 D-MCP-1**；transport 擴充等真消費者。 |
| 4 | `mcp-catalog-ingest`（drain 的三界＋刷新） | codex | ◑ **選用（小修，與 D-MCP-1 同子系統）** | **只借**：重複 cursor 拒絕、總數/cursor 上限、整體 timeout（`listTools` 今天不受 `toolCallTimeoutMs` 管）＋ `tools/list_changed` 刷新。**不取**：annotations 信任（D-MCP-4＝D1 家族決定）。 |
| 5 | `mcp-elicitation` | grok | ✗ **丟棄（現階段）** | **rendezvous 先於 elicitation**：生產連「模型→使用者的問題 provider」都沒有（`ask_user_input` 恆 `NO_PROVIDER`）；先有 question seam，且必須落 session log、不得成為第二個核准機制（`interaction` 已劃線）。 |
| 6 | `mcp-resource-retrieval` | cc-custom | ✗ **丟棄（false gap）** | 工具早在；快取是第二真相、且量不到重複列舉壓力。 |
| 7 | `mcp-server-mode` | — | ✗ **不做（Q4 不變）** | 消費者未出現。 |
| 8 | `plugin-runtime-state` | dsh（投影形狀）＋ZCode（狀態詞彙） | ⏸ **產品決定** | 詞彙在、零消費者、allowlist 掛著——**建回報面或裁掉詞彙，二選一**，現狀不可持續。若建：dsh 的「每次重讀＋投影成可序列化 phase」形狀；**不得**在 `state.json` 長 status 欄位（第二真相）。 |
| 9 | `filesystem-skill-discovery`（專案根半） | dsh（marker walk-up）／ZCode（祖先鏈） | ◑ **選用（低優先；與 #11 同批才有意義）** | 今天 workspace 恆 cwd、量不到「向上找根」的輸入。**只借**：專案根發現＋1–2 個相容根＋優先序入既有三階契約（加階＝改契約，要明說）。 |
| 10 | `skill-registry-layered` | dsh | ✗ **丟棄**（分層半＝false gap；scope 維度無輸入） | **附帶的小修**：掃描記憶化（借 instructions 的 mtime/size 快取切片）——**若** search 熱度有量。 |
| 11 | `skill-catalog-injection` | ZCode（`skills_listing`）／dsh（loader 前置） | ✅ **採用（核心；M6「skills 可被發現」的本體）** | **只做** name＋description 的 eager 目錄；**落點＝runtime-context 尾端追加**（前綴安全——T2 紀律）；**不取**：scope-key 解析、invocability 重檢（無輸入）。 |
| 12 | `explicit-and-implicit-invocation` | codex | ◑ **選用（只做 `$name` sigil 掃描半；與 #11 同批）** | 命中後**以尾端追加的 user message** 帶入（前綴安全）；**不取**：結構化 `UserInput::Skill`（動封閉事件 union）。 |
| 13 | `bundled-skill-registry` | cc-custom | ✗ **丟棄（現階段）** | 無產品輸入（dist 不出貨技能）。先只借「程式化註冊」如果將來有 —— 不急著借 nonce 抽取。 |
| 14 | `workspace-instruction-baseline` | dsh | ✗ **丟棄（false gap）** | 變更投影已在；baseline/diff 半量不到輸入（全文重送目前只是 token 成本）。 |
| 15 | `subagent-bundle-cache` | grok | ✗ **丟棄（現階段）** | 無 bundle；三態校驗只在「手改 overlay」風險上有意義（該輸入量不到）。**風險面已在 §2 記錄**（rm -rf）。 |
| 16 | `settings-seam` | dsh | ✗ **丟棄（false gap）** | 缺消費者（Q7 未觸發）；命名空間方案會變成**被明令禁止的 registry**。 |
| 17 | `operator-config-layer-stack` | grok（來源歸因）／codex（層疊） | ◑ **選用（只借歸因 slice；低優先／park）** | **只借**：grok 的「回報哪個來源贏了」——`resolveHarnessHome` 的 additive 面（須維護 8 個生產呼叫點的相容）＋ layer merge 的 provenance。**不取**：codex 的 requirements 模型（撞 **Q1**＋第二真相）。兩個 slice 今日都無讀者 ⇒ park 直到有宿主要顯示。 |

---

## 4. 改良/丟棄清單（我們 vs 參考的差異決策）

| 差異點 | 參考做法 | **我們的做法** | 理由 |
|---|---|---|---|
| 投影/設定形狀 | dsh 的命名空間註冊面 | **維持封閉 union**（`sections.ts`） | 三源同向裁定（Codex 形狀、Grok 的代價、ZCode 的封閉枚舉）；registry 是被明令禁止的形狀 |
| 信任 | ZCode：**plugin hook 無閘門**、project MCP 預設 trusted | 若未來給 plugin 來源信任，**借它的 digest/`stale_digest`/host capability，不借它的來源信任階級** | 它自己的反例證明來源邊界會漏 |
| transport | codex 五變體 | **不追**；先修死掉的路徑 | D-MCP-1；不為假想消費者建 |
| elicitation | grok 的單槽 rendezvous | **等 question seam** | 生產無 provider 恆 NO_PROVIDER |
| config 上層 | codex requirements 約束下層 | **不做**（Q1 暫不） | 第二真相論證 |
| catalog 注入 | 直接改 system prompt | **尾端追加（runtime-context）** | T2 前綴紀律；byte-0 改動＝斷點 |
| 技能提及 | codex 結構化輸入 | **純文字 sigil 掃描** | 封閉事件 union 不動 |
| bundle 快取 | grok 全 manifest | **不搬**（無 bundle）；風險面另記 | §2 |

---

## 5. 方法與複驗

- **三路量測代理**（唯讀；技能/內容 7 列 · MCP 6 列 · 介面 4 列）：各自附指令與 `file:line`；快照 `86c22ba1`，工作樹乾淨。
- **controller 獨立複驗的載重主張：**
  - **D-MCP-1 四環鏈**：`install.ts:189-191`、`types.ts:80-84`、`scheduler.ts:47`、`assembly.ts:923-934` 逐處親讀；**執行探針為 controller 親跑**（輸出見 §2）。
  - 三路代理回報的其餘探針（initialize 先於握手可呼叫、`pluginMcpResults` 的掛載等）**由代理執行、本文件未逐條複跑** —— 引用前照 §0 規矩重跑。
  - 站點數 110（W6 用）與「§3.3 套件從未建」為 controller 親量（`86c22ba1`）。
- **未覆蓋（明說）**：ZCode 的 elicitation／resources 實作未讀；IH 的 ACP wire 只點到為止；`evaluatePlugin` 的 mcp 維度恆 failed 是**推論**（標記於 §2）。

## 6. 這份文件沒有建立什麼

- **沒有實作、沒有 spec。** 決策欄是「進 spec 草案的建議」，不是已核准的範圍。
- **判定的有效期**：量於 `86c22ba1`；引用前重跑 §5 的指令。
- **沒有替 owner 回答產品問題**：⏸ #8（plugin 狀態回報面：建或裁）與 #1 的版本級裁決，都要 owner。
