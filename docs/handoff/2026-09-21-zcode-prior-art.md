# ZCode 調研 — 2026-09-21

**為什麼有這份文件.** ZCode 是一個新的參考專案 —— 大型 AI 編程工作台（desktop／web／TUI／agent CLI，Apache-2.0，`zcode` 3.14.0）。它面對的是與 IH 同一類的問題（agent 迴圈、工具權限、hooks、plugins、MCP、memory、壓縮、投影），而它對其中幾項給出了比 IH 現有先例更完整的答案 —— **代價是它幾乎沒有測試，而多個閘門在樹上沒有接線**。這份調研為 IH 現在開放的項目找先例與反例：**D1（hook 信任錨）、M6（生態＋介面硬化）、M7（記憶）、C2（輸出界）、C3（max tokens）、T2-3（usage）、D2（投影）、治理儀器**。

**方法.** 照 2026-09-18 prompt-cache 調研的體例：**六個唯讀子代理、一子系統一代理**，各自回報符號級出處；**本文件每一條載重主張由我對目標樹重測**（§8 是複驗清單與指令）。**全部是靜態閱讀** —— 目標樹沒有 `node_modules`、不是 git repo，未執行任何 ZCode 程式或測試；所有「怎麼運作」都是讀碼，不是觀察到的行為。

**引用的規矩照 §0 規則三**：路徑省略前綴 `D:\agent-complete\ZCode-main\`；行號量於 2026-09-21 的此快照，**引用前先 `grep`**；每個數字附可重現指令（§8）。

---

## 0. 讀了什麼

| | ZCode |
|---|---|
| identity | `zcode` 3.14.0（根 `package.json`）；Apache-2.0；LICENSE 附錄署名 **`Copyright 2026 Z.AI Co., Ltd`**（`LICENSE:190`） |
| shape | 兩個巢狀 pnpm workspace：根 `packages/*`（15 個）＋ `apps/zcode-cli/packages/*`（16 個） |
| size | **3,802 檔 / 833,665 行** `.ts`/`.tsx`（範圍與指令見 §8） |
| VCS | **無 `.git`，原始碼快照**；`apps/zcode-cli` 上游是 git submodule，此快照攤平為普通目錄（`README.md` 自陳） |
| tests | **全樹 4 個 `.test.ts`**（`packages/services/test/` ×3、`packages/ui/test/` ×1；`node:test`）；**無 test script、無 CI（無 `.github/`）、`apps/zcode-cli` 下 0 個** |
| provenance | **不是 opencode／Claude Code／Codex 的 fork**。copied 元件 8（VS Code 的 IPC/common utilities → `packages/rpc`、shadcn/ui、Vercel ai-elements、obra/superpowers 的 skill 等）；embedded 2（Skia、QuickJS-NG） |

主要 package 規模（`.ts`/`.tsx` 行數）：ui 322,665 · core 95,557 · services 87,841 · bootstrap 63,533 · desktop 61,276 · adapters 51,637 · shared 38,370 · contracts 21,427 · dynamic-workflow 19,878 · tui 13,723 · server 10,924 · cli 10,609 · rpc 4,058 …。

**⇒ 讀這份文件前要先接受一個背景：一個 83 萬行的產品，樹上只有 4 個測試檔。** 下面每一節的「缺陷」都要在這個背景下讀 —— 沒有生產者的旗標、引用不存在的黃金測試、文件寫了而沒有接線的閘門，全部是同一件事的不同面。

**與 IH 對照（同一天量，範圍見 §8）**：IH = 509 檔 / 102,110 行 / 267 個測試檔 / 66 個 workspace 套件。

---

## 1. 擴充生態與信任 —— D1 與 M6 的直接先例

### 1.1 信任錨：釘的是內容 digest，而且第一個人類同意在執行期

**這是目前為止給 IH D1 最強的一組先例。** workspace／project hook 的信任模型：

- **釘的對象是內容，不是路徑、也不是 config 文字**：`createWorkspaceHookDeclarationDigest`（`packages/shared/src/workspace-hook-digest.ts:192`）＝ sha256(canonical payload)；payload 含相對來源路徑、event／matcher／index、**command／args／shell／async、resolved timeout、maxOutputBytes**；另有 `bundleDigest`（同檔 `:188`）。
- 判定：**7 個 trust state × 3 種 policy**（`deny`／`user_decides`／`allow_trusted_only`）→ `WORKSPACE_HOOK_STATE_ADMISSION_MAP`（`apps/zcode-cli/packages/contracts/src/hooks/workspace-hook-trust.ts:87`）；入口 `evaluateWorkspaceHookEntry`（`core/src/hooks/workspace-hook-trust-evaluation.ts:15`）。
- **同意位置不是安裝時、也不是啟動彈窗**：執行期 fail-closed 停在 `pending_trust`（hook 不跑、`effectiveRunnable=false`），由人類在受信 Host 的審核面板逐條按信任，或 CLI `zcode hooks trust grant --hook-digest …`。
- **授權記錄記的是「授權當下人眼所見」**：`bundleDigestAtGrant`、`displayCommandAtGrant`、`sourcePathAtGrant`、`appVersionAtGrant`（`packages/shared/src/workspace-hook-trust-store-file.ts:37` 的 `workspaceHookTrustRecordSchema`；store 檔名 `workspace-hook-trust-v1.json`）。
- **改內容就重問**：同槽位內容變更 → `stale_digest` 重新徵詢（不是「路徑不變就沿用」）。
- **授權不得快取**：每個 hook dispatch 前重呼 admission（`runner.ts` 註解明言）。
- **fail-closed 的三個細節**：policy provider 例外 → deny；**store 損壞 → 全阻且拒絕 grant**（不讓恢復副作用冒充一次授權）；review flow 10 分鐘逾時 → `no_change`。
- **誰能開閘**：`workspaceHookTrustEnabled` 只由受信 Protocol server 注入，**不從 project config 或環境變數讀**。
- telemetry 只送 digest 前 12 hex（不送命令／路徑）。

**對照既有先例**：Codex 釘 config 文字、Grok 釘資料夾路徑（2026-09-18 調研 §1）—— ZCode 這條與 **IH 自己的「釘 script sha256」同一族，且多了三個 IH 沒有的部件：`stale_digest`、host capability（誰能把閘門打開）、授權當下的可見欄位。**

### 1.2 同一個 repo 裡有一個完整的反例

**plugin hook 沒有任何閘門。** `canRunPluginHooks`（`adapters/src/plugins/index.ts:366`）直接 `return true`，註解自陳「**放弃了「仅官方可执行 hook」的信任边界**」並寫下升級路徑。**⇒ 只有 project hook 有信任模型；三方市場插件的 hook 與使用者 config 的 hook 同權執行。**

同節另兩個反例：**project MCP 預設 trusted 並自動連線**（`bootstrap/.../runtime-config.ts` 註解「產品決定 workspace MCP 開箱即用」）—— 與 hooks 的政策相反；`untrustedProjectMcpServers` 是**死路徑**（型別、UI 文案齊備，兩個生產點硬編 `new Set()`）。

**⇒ 給 IH 的教訓**：按來源畫信任邊界（「官方＝可信任」）會在別處漏出高權限縫隙。**IH 的 plugin-registry 若把某些來源預設 trusted，必須明文寫下放棄了什麼。**

### 1.3 生態面（M6 的形狀）

- **manifest 近乎無 schema**：`.zcode-plugin/plugin.json`，fallback `.claude-plugin/`、`.codex-plugin/`（`adapters/src/plugins/index.ts:100-102`）；只嚴格驗 `name`；未知欄位不報錯。元件面 `commands`／`agents`／`skills`／`hooks`／`mcpServers`／`userConfig`；**未支援的 key（channels／lspServers／outputStyles／settings）只發 diagnostic 不執行** —— 一個「介面先留、行為不宣稱」的硬化樣式。
- **市集**：官方單一 id `zcode-plugins-official`；CDN 插件以 zip 分發，**sha256 必填、解壓前逐位元組比對**（`zip-source.ts`，含 `ZIP_REQUIRED_SHA256_PATTERN` 守衛）；個人來源 git／github／url／file／directory；**使用者不得宣告官方 id**（`addMarketplace` 的 trustedId 守衛）。
- **skills**：`SKILL.md` ＋ flat YAML frontmatter（description 上限 1024、單檔上限 100 KB）；roots 含 `.zcode/skills`／`.agents/skills`（worktree 祖先鏈）。**`apps/zcode-cli/skills-lock.json` 是孤兒** —— 樹上沒有讀者（回報的 `computedHash` 全樹只出現在該檔）。
- **MCP**：stdio／http／sse；stdio 有整棵 process tree 回收與 Windows Job Object；工具進 ToolRegistry，`needsApproval=true`、plan mode 放行非 destructive MCP；審批走通用 permission，**沒有 MCP 專屬閘門**。
- **hooks**：7 事件（`HookEventName`：SessionStart／UserPromptSubmit／PreToolUse／PermissionRequest／PostToolUse／PostToolUseFailure／Stop）；可阻擋（`continue:false`、`decision:"block"`、exit 2）；預設 `enabled:false`、`timeoutMs:60000`、`maxOutputBytes:32768`（`contracts/src/hooks/index.ts:425`）—— **執行失敗本身 fail-open（記 HookRunFailed、turn 續行），但准入閘門 fail-closed**。

---

## 2. Agent 迴圈、工具管線與輸出界

### 2.1 界掛在 executor、每工具自帶 budget（C2 的形狀）

**IH 的界只掛在 `runHeadless`；ZCode 把它掛在 tool-result 序列化層，每一條路徑同享。** 形狀：

- 預設 `DEFAULT_RESULT_BUDGET` = `maxInlineBytes: 100_000` / `maxModelBytes: 100_000` / `strategy: "truncate"`（`core/src/tool/executor/result-serialization.ts:33`）；`maxModelBytes = min(maxModelBytes, maxInlineBytes)`（同檔 `:78`）。
- 超界且 strategy 是 `artifact` 時**先寫 artifact、模型只拿帶路徑的信封**；否則截斷並附自我描述尾綴（`[Tool output truncated by resultBudget: artifactPath=…, originalBytes=…, maxModelBytes=…, strategy=…]`，head/tail 可選）。
- **`returnedBytes` 的定義是「真正送進模型的 byte」（含 base64 媒體）** —— telemetry 讀它；這是 IH 記帳可以直接照抄的單一定義。
- 各工具值（量到的）：Bash `maxModelBytes: 30_000`、strategy `artifact`（`tool/handlers/bash.ts:480`）；Read `256 * 1024`（`contracts/src/tools/read.ts:15` `READ_MAX_FILE_SIZE_BYTES`）；Grep 20,000；Glob 100,000；node_repl model 64 KiB；`TaskOutput` 400,000B ＋ `maxModelChars` 100,000。

### 2.2 參數正規化在 hook／權限之前（`resolveInput`）

管線順序（`core/src/tool/executor/` ＋ `runtime/methods/turn-tools.ts`）：registry miss → abort 檢查 → 初始 schema 驗證 → `validateInput` → **`resolveInput`（在 hook 與權限之前把入參換成執行事實）** → PreToolUse hook → `resolveToolPermission` → handler（`ToolDeadline`）→ output schema → `serializeOutput` → PostToolUse。

**理由寫在 `tool/types.ts`**：之後 hook、規則、確認窗、handler 讀的是同一份輸入 ⇒ 策略不被繞、**確認與執行同 byte**。**這比 IH 的「政策前強制 schema」更進一步** —— IH 的強制點在 `tools.get` 之後、政策瀑布之前，但 IH 的 `prepare` 只驗證、不改寫。

### 2.3 審批路徑的三個 bug 型態（可直接當 IH 檢查表）

1. **hook 與 broker 競速** —— 原本先 `await` hook，同步 hook 阻塞時確認窗已渲染而 responder 未註冊，點擊被冪等語義吞掉、窗永久死亡 → 改成 `permission-responder-race.ts`。
2. **預覽失敗仍要 ask** —— `prepareApproval` 拋錯必須仍然詢問（向執行側 fail-open 等於靜默跑未批准工具）。
3. **registry miss／schema 失敗也要發 `ToolCallError`** —— 否則 UI 的 tool row 永久停在 `inputStreaming`。

### 2.4 中斷契約

`tool_use` 已入 history 後 Stop **不能直接拋**：aborted signal 繼續交給 executor，讓每個 tool call 產出 `ToolCancelled` 結果、**配對不缺席**；已完成的 streamed result 保留；待處理的 steer 退回佇列（`turn-tools.ts`、`batch-runner.ts` 的註解）。模型中止時 flush 已到的 text/reasoning，**partial text 補 commit 進 live request history**（否則冷恢復與現行 history 不一致）。

### 2.5 缺陷（樹上可見）

- **`mode.auto` 未實作**：`permission/service.ts:144` 與 `:343` 兩處 deny，ruleId `mode.auto.unimplemented`。
- **`maxTurns` 疑似宣告未實作**：`runtime/methods/subagent.ts:269` 寫入 `request.maxTurns ?? config.subagents?.maxTurns ?? 4`，但 turn loop 不讀它（`core/src` 內只有 memory loop 與 profile 解析在讀同名參數）。**子代理「最多 N 輪」看不出被強制。**
- **turn loop 沒有 model-step 上限**；剎車只有 compact 的 rapid-refill breaker（§3.1）。
- **兩個 byte 上限並存**：`ToolMetadata.maxOutputBytes`（Bash 10,000,000 等）與 executor 的 `resultBudget` —— 同一件事兩套數字、名稱不同。

---

## 3. 上下文生命週期

### 3.1 壓縮：三條觸發、兩個 breaker、一組明確常數

- 三條觸發共用 `compactActiveConversationImpl`：Auto（每步送 provider 前 `shouldAutoCompact`）、Reactive（provider 回 context-overflow）、Manual（`/compact`）。
- 門檻算術（`core/src/compact/policy.ts`）：先扣 output 保留 `PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000`（`:10`，註解：**不是**全額模型 output 上限，legacy 全額保留會過早壓縮），再扣 buffer `AUTOCOMPACT_BUFFER_TOKENS = 13_000`（`:12`）。
- Token 數**優先採 provider usage**（反向找最近已提交 assistant 的 usage 當 base，其後本地估算增量）；摘要請求的 output 上限 `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000`（`:11`）。
- **兩個 breaker**：連續 3 次壓縮失敗進 circuit breaker；**rapid-refill**：壓縮後 < 3 個 tool turn 又滿、連續 3 次 ⇒ 整個 run 停下並附人類可讀指示（`RAPID_REFILL_TOOL_TURN_THRESHOLD = 3`、`MAX_CONSECUTIVE_RAPID_REFILLS = 3`，`runtime/methods/turn-loop-state.ts:21-22`）。**判定用 turn 計數，不用時鐘。**
- 歷史太長時階梯降輸入：依 provider 錯誤字串解析 token 差、丟舊輪並插 marker，最多 3 次（`MAX_COMPACT_PROMPT_TOO_LONG_RETRIES = 3`，`compact/manual.ts:55`）。
- **microcompact**（便宜層）：把舊的 tool result 換成 `[Old tool result content cleared]`，只清 compactable tool（9 項），保留最近 5 組，跳過 error 與含 image/video/file 的結果。**⚠ 兩層預設相反**：純函式預設開，但 runtime 閘門寫死 `enabled: config.microcompact?.enabled === true`（`runtime/methods/microcompact.ts:111`）—— **預設關**。

### 3.2 prefix-cache 紀律四條（若 IH 做壓縮，這是最完整的一組先例）

1. system prompt 拆三段各帶 `cacheControl: ephemeral`，且**依 stable/dynamic 排序**注入；
2. 每請求只在**最後一條非 system 訊息**放 cache breakpoint；
3. compact 的 summary 請求 `skipCacheWrite: true`（不讓一次性請求寫入快取）；breakpoint 前移到 compact prompt 之前的真實上下文；
4. **壓縮後 prefix 逐字 clone 回**（`buildPostCompactRuntimeEntries`），另有 `preserveCanonicalContextPrefix` 在 turn-local 壓縮回寫時保留 canonical prefix；prefix 判定**以 metadata source 為準、文字比對只是 fallback**（避免使用者 literal `<system-reminder>` 被誤留）。

**而它沒有做的事**：**沒有「依 prefix 命中率決定是否壓縮」的邏輯** —— cache read/write token 只用於計數與觀測。**這條邊界對 IH 是資訊**：IH 的 T2 前綴偵測可以停在觀測，不必（也不該）去驅動壓縮。

### 3.3 記憶（M7 最直接的先例）

- **檔案式，無 DB**：`<storageRoot>/memories/projects/<slug>-<hash>/memory/`，一檔一事實、frontmatter `name/description/metadata.type`；`MEMORY.md` 是索引（格式規範寫進 system prompt 的 Memory 段）。
- **寫＝成功 turn 結束後的背景子代理**：`scheduleProjectMemoryExtraction` → `runMemoryAgentLoop`（`EXTRACTION_MAX_TURNS = 5`，`runtime/helpers/project-memory-extraction.ts:19`）；**工具權限硬收窄**：只有 Read／Grep／Glob、唯讀 Bash、與 memory 目錄內的 `.md` 寫（`rm` 白名單只允許絕對路徑、`.md`、無 glob）。跳過條件：本輪已直接寫過、或沒有 ≥ 3 字的使用者散文（`MINIMUM_USER_WORDS = 3`，`memory/extraction.ts:6`）。排程器 coalescing、session 關閉即 abort。
- **讀只有兩條**：索引被格式化後注入 meta-user 區塊 ＋ 模型自己用 Read 讀 topic 檔。**沒有 embedding／向量檢索。**
- **⚠ 反面教材**：**索引是 session 開始時的快照**（只在 `ensureContextInitialized` 讀一次）—— 會期中寫入的新記憶不會進 prefix。**IH 若在意會期中更新，這是「不要這樣做」的具體形狀。**
- 索引有 200 行／25,000 字上限，超過截斷附警告句。

### 3.4 system-reminder 與「事件驅動的自啟」

- **27 個 source**：2 prefix（`context_prefix`、`skills_listing`）＋ 15 persisted ＋ 10 per-request（三個 `as const` 陣列，`core/src/system-reminder/source.ts:20,22,40`；我逐條數過）。
- 注入雙軌：prefix 與 continuity 類走「user message 包 `<system-reminder>`」，其餘支援的走 **mid-conversation system（真 system role）**；非法落點自動降級回 user wrapper。**必須落在使用者問題之前的 source 有明示排除清單。**
- 節流是**事件驅動而非時鐘**：todo reminder（10 turn 未寫 ＋ 距上次 10 turn）、plan-mode（每 5 個人類 turn 一次、每第 5 次才全量）、date_change 只在日期變更時。
- **背景通知會自啟 turn，但只由事件驅動、且同批合併**：enqueue 後立刻 drain 佇列並跑一個 `model-only` turn；`runTaskNotificationBatch` 把同批合併成一個 turn、以 `[SYSTEM NOTIFICATION - NOT USER INPUT]` 前綴注入。**⇒ IH 的 Q2 = 否（不從時鐘自啟）相容，而這是「事件驅動自啟」的完整範本。**

### 3.5 dynamic-workflow：可重放契約

模型寫 TypeScript 腳本（對嵌入的 `FACADE_DTS` 做型別檢查；`ask<T>` 的 T 合成 JSON Schema，子代理回傳、不合格可 repair 3 次／nudge 1 次）；執行是**確定性狀態機**：實例身份 = siteId × 每站序號，每次 host 呼叫先查 journal，命中即短路重放並**防禦性比對 inputHash**，不一致就整個 run 大聲失敗；journal 在 SQLite 四表（`dwf_run`／`dwf_actor`／`dwf_node`／`dwf_event`，migration 0019），支撐 resume 與改名。**⇒ 比「前綴比對」更強的可重放性**：把「重跑必須逐位元決定性」變成可檢查的硬失敗。

### 3.6 缺陷（樹上可見）

- **`buildCompactSummaryMessage` 的三個選項是死碼**（`replStateCleared`／`recentMessagesPreserved`／`transcriptPath` 從未被傳）—— 壓縮摘要永遠不會告訴模型 transcript 路徑。
- **`ENABLE_MCS_ADJACENT_USER_MERGE = false`**（`runtime/helpers/provider-request-messages.ts:41`）：相鄰 user 合併整條分支停用。
- **session guidance 段有大量註解掉的內容**（「當前不輸出 Agent 指導段」）。
- 動態工作流的測試目錄與 `libs.generated.ts` **不在此 checkout**（未跑 generator 前無法 typecheck 該套件）。

---

## 4. 宿主↔客戶端契約

### 4.1 事件模型＝snapshot＋delta＋cursor

- 訂閱帶 `base: {logEpoch, seq}`；ACK `mode: snapshot | resume`；**resume 判據**：`base.logEpoch === logEpoch && base.seq ∈ [floorSeq, currentSeq]`。
- 事件日誌是**記憶體有界**的：`eventRetentionPerSession: 2000`（`packages/shared/src/zcode-protocol-v4/core.ts:74`）；durable 事實是 SQLite transcript；越窗只發 snapshot。
- snapshot 只帶尾窗 60 列（`snapshotTailWindowRows: 60`，同檔 `:75`）＋ `totalCount`；更早用 `rowsRange` 分頁（`beforeRowId` 游標、`hasMore`）。
- delta 是**封閉 5 op**；apply 對未載入的 rowId 一律 no-op。

### 4.2 投影＝封閉 union ＋ 單一判別函式（D2 的確認）

- `packages/shared/src/conversation-message-projection-policy.ts`：**5 值封閉枚舉**（`realUserInput`／`visibleAssistant`／`providerContextOnly`／`timelineOnly`／`hiddenSynthetic`）由**單一優先序函式** `getConversationMessageProjectionPolicy`（`:78`）判別 —— **不是 registry**。v4 面同樣封閉：rows 9-kind discriminatedUnion、delta 5 op、statePatch 鍵集合封閉且「鍵內絕不深合併」。
- **兩條給 IH 的不變量**：**「表達不了就 resync，不加 op」**（刻意不支援 row.inserted／moved／字段級 patch）；**「被 profile 濾掉的 delta 必須由後續不可濾事件收口」**。
- optional 只為兼容舊 snapshot／舊轉錄，新寫入一律顯式；**enum 加值＝閉集加值**：舊客戶端收到未知值整幀 parse 失敗、不能降級 —— 靠「CLI 與桌面同批發布」承擔。

### 4.3 兩個 delivery profile（30 ms vs 150 ms）

`deliveryProfile` 與 clientMode 綁定（superRefine 強制）；實際生效兩個欄位：`flushWindowMs` 30（continuous）vs 150（replayable）；streamPaths continuous 全開、replayable 只 text。**delivery profile 只存在於 CLI flush 管線參數表，客戶端代碼禁止出現 profile 變數。**

### 4.4 CommandInbox（busy/running 輸入的串行 admission）

**三類事實分離**：in-flight pinned／liveInput pinned／settled 512 LRU per session；固定鎖序 key gate → per-session gate，**session gate 持有到 `settle()`**（`admissionSeq` 在 gate 內分配 ⇒ 同 session 按實際 admission 順序串行）。stale 防護兩級：15 個命令必帶 `baseRevision`、其中 5 個 row-targeting 另需 `baseLogEpoch`。

### 4.5 背景 bash：120 秒自動轉背景、客戶端只拿 8 KiB tail

- **有「前景自動轉背景」**：`auto_on_timeout` 模式（`core/src/tool/handlers/bash-background-policy.ts` 的 `isBashAutoBackgroundEligible`；`bash.ts:153,182`）—— 前景 deadline（`DEFAULT_BASH_TIMEOUT_MS = 120_000`）到即**原子轉態**（先提交狀態再拆 deadline），回 `status:"backgrounded"` ＋ `backgroundTaskId`。
- 模型用 `outputPath` 讀全量；**客戶端讀 `backgroundBashOutput` 只給 tail 8,192 bytes**（`packages/shared/src/background-bash-output.ts:3` `BACKGROUND_BASH_OUTPUT_MAX_BYTES`）＋ `truncated` ＋ `outputPath`；UI 1 秒輪詢。
- **⇒ 與 IH W10 是相反的取捨**：IH 的 promoted job 視圖**從頭完整**（種子取 handle 已捕捉的文字）；ZCode 選擇有界 tail ＋ 全量在檔案。而門檻語意也不同：IH 在 30 秒**門檻到就轉**，ZCode 在 120 秒**逾時才轉**。**兩邊都對；這是一組要選的語意，不是誰錯了。**

### 4.6 缺陷（樹上可見）

- **無生產者的旗標**：`assistantAutoBackgrounded`／`backgroundedByUser` —— 定義 4 處（`contracts/src/tools/bash.ts:173,177,247,248`）、消費 2 處（`core/src/tool/handlers/bash-model-content.ts:122,125`）、**生產者 0**（我自己量的；某份回報說「3 個命中」，不精確）。
- `DELIVERY_PROFILES` 的 `desktopOnlyRows`／`streamOutputCapBytes`／`toolProgress` 無消費者；`filterConversationRowsForProfile` 是 no-op 佔位。
- `background-bash-jobs.ts`（42 行整檔）零消費者（legacy 路徑）。
- **hostCapability 有兩份逐字等價實作**：`packages/server/src/hostCapability.ts` 與 `packages/zcode-server-cli/src/server-core/hostCapability.ts`。
- UI 背景輸出**不回總 bytes** → 客戶端不知全量大小。

---

## 5. Provider 與 usage

### 5.1 三協定、AI SDK 是正規化邊界

協議只有三種：`anthropic-messages`／`openai-chat-completions`／`openai-responses`（**無 Gemini** —— 我 grep 過，provider 切片零命中）。正規化在 Vercel AI SDK（`ai 6.0.193`），ZCode 在 fetch 鏈上介入（business error 包裝、option-map patch、compat 轉換、proxy、官方 endpoint 改寫）。

### 5.2 max output 是資料，不是 SDK 參數（C3 的等價修法）

**`maxOutputTokens` 完全沒有交給 AI SDK**（`runner-options.ts` 零命中）；值走 `requireMaxOutputTokens`（`runner.ts:331`，**缺值直接拋 `InvalidModelRequest`，fail-closed**）→ `ModelOptionValues` → **option-map 在 fetch 層對原始 JSON body 套 patch**。三條 catch-all 規則給出 wire 欄位：anthropic → `max_tokens`、openai-chat-completions → `max_completion_tokens`、openai-responses → `max_output_tokens`。註解明寫「Option Map 是 reasoning/max-output 的唯一請求欄位權威」；body 非 text/JSON 時拋錯、不靜默丟欄位。

**⇒ 對 IH C3（欄位穿五層被丟掉）：ZCode 證明「即使 SDK 不支援某欄位，也能在 raw body 層保證送達」—— 而 IH 若不想要 option-map 這台機器，至少「缺值 fail-closed、不靜默」是可直接取的半條。**

### 5.3 `includeUsage: true`（T2-3 的第一個決定，有先例了）

`createOpenAICompatible({ includeUsage: true })`（`adapters/src/model/model-execution.ts:310`），註解：「OpenAI Compatible 流式 usage 需要顯式請求，Usage 是執行結果的一部分」。**⇒ 支持 IH 的 openai-compatible 送 `stream_options:{include_usage:true}`。**

### 5.4 「沒回報 ≠ 0」的分層 —— 與它唯一刻意的例外

- boundary 保留 `undefined`（`normalizeUsage` 逐欄複製，缺欄位保持 undefined）；
- 聚合用 `hasModelUsage` 過濾、摘要帶 `source: "provider"`（「完全沒回報的請求」被濾掉，全無回報則回 undefined）；
- **落庫才 materialize 0**（`migrations.ts:421-423` `input_tokens/output_tokens/reasoning_tokens not null default 0`）＋ 另存 `raw_usage_json`；
- **例外（刻意的）**：診斷路徑 `isZeroUsage`（`runner-diagnostics.ts:448`）把缺 usage 當 0 ⇒「空補全」判定會重試沒回報 usage 的 provider。**同一份 undefined 在會計層與診斷層規則相反，而理由都寫了。**

**⇒ 給 IH**：T2-3 落地的時候，這條例外要**明文寫下**，而不是讓它偷偷與會計規則衝突。以及 **SQL 聚合之後「沒回報」不可辨** —— IH 若要保留這個區別，要在 schema 上就分開。

### 5.5 cache 口徑（要先定案的那件事）

AI SDK v6 的 Anthropic `inputTokens` **已含 cache read/write**，因此 context meter／compact 門檻不再疊加 cache（三處重複註解）。**IH 映射 cache 欄位時必須先定案這個口徑**，否則 context／壓縮門檻整體偏高。

### 5.6 三態與無成本

`CodingPlanEntitlement = available | unavailable(reason) | unknown`；未驗證的新列舉**一律 unknown**（「不能擅自解釋成無權益」）；帳號事實未到前發布 fail-closed snapshot。retry 語義自己擁有（SDK `maxRetries: 0`；退避 sleep 不持票；「首個 provider event 之後不重放」）。**整個切片找不到 per-token 價格或 cost 計算** —— ZCode 以「套餐權益＋用量」代替金額。

---

## 6. 治理與儀器

### 6.1 architecture-policy：一個「宣稱大於執行面」的完整案例

- 12 條規則（`scripts/architecture/index.mjs`；rule id 與 `references/rule-catalog.md` 逐條對應）：`module-dependency`、`deep-import`、`cycle`、`max-file-lines`(400)、`max-contract-lines`(300)、`max-public-methods`(12)、`layer-direction`、`domain-io`、`ui-implementation-import`、`expired-exception`、`missing-module-artifact`、`disable-count`。
- **執行面**：`managedOnly: true` 且 15 個模組只有 **1 個 `managed: true`**（`architecture-policy.yaml:28`，storage）→ 實際強制範圍約 **13 檔 / 1,121 行**，而掃描面是 **3,802 檔**。
- **跨套件匯入對規則隱形**：`policy.mjs:153` `if (!specifier.startsWith(".")) return null;` —— `@zcode/*`（這個 monorepo 最常見的匯入）**不產生依賴邊**，`module-dependency`／`deep-import`／`cycle` 對它們全盲。文件承認（rule-catalog「Workspace package names … need separate inspection」），但主要賣點大幅縮水。
- 旗艦儀器（module reading pack）**對它唯一的樣本給出空結果**：`architecture:context storage` 的依賴契約欄位輸出 `- none discovered`。

**⇒ 這是一組完整的教訓，因為 IH 的可達性儀器是同一類東西**：儀器的**宣稱**與**執行面**必須一起寫下來 —— 記在報告裡的不是「ZCode 有 12 條規則」，而是「12 條規則管 1,121 行」。

### 6.2 三件值得抄的

1. **`disable-count`：抑制即違規。** managed 檔案出現任何一行 `oxlint-disable`／`eslint-disable` 就報（`index.mjs:157-167`），例外必須走帶到期日的 exception。**抑制語句本身是被審計的對象。**
2. **例外帶到期日**：`expired-exception` 早於今天即違規、**`--changed` 也擋不掉**，且沒有續期機制（文件：「do not silently extend it」）。**⇒ 對照 IH 的 allowlist：條目失效應該報錯，而不是靜靜放行 —— 這正是 IH reachability allowlist 缺的性質。**
3. **`--changed` 是反向依賴閉包**：不是「你改的檔」，是「你改的檔＋所有傳遞性 import 到它的檔」；baseline fingerprint = `sha256(rule\0file\0detail)` 前 16 hex（**改行號不會讓 baseline 失效**）。

### 6.3 third-party 治理（供應鏈紀錄）

三種分類：`copied`（抄進 repo 的碼，8 筆，每筆帶 `referenceRevision`／上游 URL／sha256 快照／落點／`modifiedFiles`）、`embedded`（藏在 npm 二進位裡的碼，2 筆：Skia、QuickJS-NG）、`inventory`（機器生成總清單：1,201 packages、2,868 個 input 檔的 sha256、`noticesSha256`）。**`THIRD-PARTY-NOTICES.md` 的 sha256 與 inventory 對不上即拒絕**；**任一筆 npm override 在當前依賴圖中失效 → 生成器直接 `throw`（stale 即錯誤）**；`licenses.mjs check` 非綠即 exit 1。

### 6.4 formal-proof 與「引用不存在的黃金測試」

`packages/formal-proof` 不是定理證明器，是**產品狀態空間枚舉器**（compact／fork／goal／queue 的組合 → `evaluate(context, candidate): Decision`）；唯一消費者是一個 devDependency，**不在 CI**（樹上沒有 CI）。

而它與 `bootstrap/.../projection-state.ts:116` **互相引用「黃金測試 `formal-proof-consistency` 機械背書」—— 全樹沒有這個測試**（4 個測試檔裡沒有它，`apps/zcode-cli` 下 0 個）。**⇒ 這是 IH 的「citation rot」同型缺陷，而且它藏在「我與形式化模型逐條對齊」這種最需要背書的句子裡。**

### 6.5 zcode-cua：fail-closed placeholder 是一等狀態

`packages/zcode-cua` 保留完整 API 形狀、實作全部 unavailable（`createComputerUseRuntime().execute()` 回 isError 文案；frame-contract 的謂詞一律回 false）；5 個 package 依賴它所以型別面必須編譯通過；**`NOTICE.md` 公開揭露**「本仓库随附的 Computer Use 包为不可用占位实现」。**⇒「這個 build 沒有這個能力」被做成可編譯、可回報、對外誠實的狀態** —— 與 IH 對「缺席不是 0」的紀律同一族。

### 6.6 文件與現實的落差清單（誠實面）

- 根 `package.json` 有 `"prepare": "husky"`、AGENTS.md 教人跑 `pnpm verify:pre-push` —— **但樹上沒有 `.husky/`、沒有 `.github/`**：這條 pre-push 閘門在此快照純屬文件。
- `licenses.mjs` 指向不存在的 `third-party/README.md`；`feature-boundary-planner` 指向不存在的 `docs/`。
- 根 `.oxlintrc.json` 的 `ignorePatterns` **明列 `apps/zcode-cli` 與 `packages/formal-proof`** —— lint 對最大的那一塊自我豁免。
- **`harness/` 只有 3 檔 32 行**：一個明文密碼的測試容器（Dockerfile 自承「仅用于测试」），不含任何閘門。

---

## 7. 對 IH 開放項的映射（取／不取／待定）

**這是映射，不是裁決** —— 裁決要照 IH 的體例另寫。

| IH 項 | ZCode 的先例 | 處置 |
|---|---|---|
| **D1 信任錨** | workspace hook：內容 digest ＋ `stale_digest` ＋ host capability ＋「授權當下可見欄位」的 record（§1.1） | **取**。這是目前最強先例；同時把 §1.2 的反例寫進設計（按來源給信任會漏縫隙） |
| **M6 生態／介面硬化** | manifest 未知欄位只 diagnostic；未支援 key 不執行；市集 sha256 必填；官方 id 保留（§1.3） | **取形狀**；manifest schema 的「近乎沒有」是不要抄的部分 |
| **M7 記憶** | 檔案式＋索引注入＋成功 turn 後背景子代理抽取（工具白名單、skip 條件）（§3.3） | **取**；**索引 session-start 快照是明確的不取** |
| **壓縮**（若做） | 21k/13k、兩個 breaker、prefix-cache 四條（§3.1/3.2） | **取**；「cache 只用於觀測、不驅動壓縮」也取 |
| **C2 輸出界（sdk／acp）** | executor 層 `resultBudget`、自我描述截斷、`returnedBytes` 單一定義（§2.1） | **取**。IH 把界從 `runHeadless` 移到 executor 就能一次覆蓋兩條線 |
| **C3 max tokens** | option-map 為 wire 權威、缺值 fail-closed（§5.2） | **待定**：IH 可能只需要 seam 補欄位；「缺值不靜默」是無條件可取的半條 |
| **T2-3 usage** | `includeUsage: true`（§5.3）；「沒回報≠0」分層＋明文例外（§5.4）；cache 口徑先定案（§5.5） | **取**（三件都可直接進實作） |
| **D2 投影** | 封閉 union＋單一判別函式（§4.2）；「表達不了就 resync」、「濾掉的 delta 要被收口」 | **取兩條不變量**；IH 已是同型 |
| **W10 背景 bash** | `auto_on_timeout` 120s；客戶端 8 KiB tail（§4.5） | **不取**（IH 的 30s 門檻＋完整 job 視圖是另一組已定的語意）；但「全量在檔案、視圖有界」的取捨值得記下 |
| **治理儀器** | `disable-count`、到期例外、`--changed` 反向閉包、stale=throw（§6.2/6.3） | **取**。前三件直接對 IH 的 allowlist／gate 有意義 |
| **子代理健康** | activity watchdog（閒置即 abort）＋ `autoBackgroundMs`（§2） | **記下**：與 IH 的 `startedAt` 訊號是互補的兩半 |

---

## 8. 方法、複驗與可重現指令

**六個唯讀子代理**（一子系統一代理）：① agent 核心 ② 上下文生命週期 ③ 擴充生態與信任 ④ 宿主↔客戶端契約 ⑤ provider／模型層 ⑥ 治理與工具鏈。各自回報符號級出處與覆蓋申報。

**我複驗過的載重主張**（每一條都在本快照上重跑過；行號量於 2026-09-21）：

- 規模：`find packages apps/zcode-cli/packages -type f \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/node_modules/*' | wc -l` → **3802**；`… -exec cat {} + | wc -l` → **833665**。IH：`find packages apps scripts e2e …` → **509 / 102,110**；`*.test.ts` → **267**。
- 測試：`find . \( -name '*.test.ts*' -o -name '*.spec.ts*' \) -not -path '*/node_modules/*'` → **4**（services 3、ui 1）。
- 工具界：`grep -n "maxInlineBytes\|maxModelBytes" apps/zcode-cli/packages/core/src/tool/executor/result-serialization.ts` → `100_000/100_000/truncate`；Bash `maxModelBytes: 30_000`；`READ_MAX_FILE_SIZE_BYTES = 256 * 1024`。
- 壓縮常數：`grep -n "21_000\|13_000\|MAX_OUTPUT_TOKENS_FOR_SUMMARY" core/src/compact/policy.ts` → `:10/:12/:11`；`RAPID_REFILL_TOOL_TURN_THRESHOLD = 3`／`MAX_CONSECUTIVE_RAPID_REFILLS = 3`；microcompact：`DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS` **逐條數 = 9**（`:19-29`）、`DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5`（`:14`）。
- 記憶：`EXTRACTION_MAX_TURNS = 5`；`MINIMUM_USER_WORDS = 3`。
- system-reminder：三個 `as const` 陣列逐條數 → **2 + 15 + 10 = 27**。
- 信任模型：`createWorkspaceHookDeclarationDigest`（`workspace-hook-digest.ts:192`）、`WORKSPACE_HOOK_STATE_ADMISSION_MAP`（`contracts/.../workspace-hook-trust.ts:87`）、`evaluateWorkspaceHookEntry`（`core/.../workspace-hook-trust-evaluation.ts:15`）、store schema（`workspace-hook-trust-store-file.ts:37`）、`canRunPluginHooks … return true`（`adapters/.../plugins/index.ts:366`）、三種 manifest fallback（同檔 `:100-102`）。
- hooks：7 事件、`DefaultHooksRuntimeConfig`（`:425`，`enabled:false/60000/32768`）、`ZIP_REQUIRED_SHA256_PATTERN`（`zip-source.ts`）。
- 投影：5 值枚舉與 `getConversationMessageProjectionPolicy`（`projection-policy.ts:2-6,78`）；`eventRetentionPerSession: 2000`／`snapshotTailWindowRows: 60`（`zcode-protocol-v4/core.ts:74-75`）；`flushWindowMs: 30/150`（同檔 `:37,:49`）。
- 背景 bash：`BashBackgroundLifecycleMode = "explicit" | "auto_on_timeout"`；`isBashAutoBackgroundEligible`；`BACKGROUND_BASH_OUTPUT_MAX_BYTES = 8192`。
- 未接線旗標：`grep -rn "assistantAutoBackgrounded\|backgroundedByUser" --include=*.ts apps packages` → **6 行＝定義 4、消費 2、生產 0**（某份回報的「3 命中」不精確，已修正）。
- provider：`includeUsage: true`（`model-execution.ts:310`）、`requireMaxOutputTokens` 拋 `InvalidModelRequest`（`runner.ts:331`）、`maxRetries: 0`（`runner-options.ts:92,150`）、`not null default 0` usage 欄位（`migrations.ts:421-423`）、`isZeroUsage`（`runner-diagnostics.ts:448`）、provider 切片零 gemini 命中。
- 治理：`architecture-policy.yaml` 15 模組、**1 個 `managed: true`**（`:28`）；`policy.mjs:153` 非相對匯入 return null；`disable-count` 實作（`index.mjs:157-167`）；`formal-proof-consistency` 全樹只在兩句註解；無 `.husky`／`.github`；oxlint `ignorePatterns` 含 `apps/zcode-cli`；copied 8／embedded 2；`LICENSE:190` Z.AI。**⚠ managed 強制面的「13 檔 / 1,121 行」來自治理代理的探針**（我複驗的是「15 模組僅 1 個 managed」與掃描面 3,802 檔那兩半）。
- **其餘細節（未逐條複驗者）** 以本文件附的符號為準 —— 引用前先 `grep`。
- **未複驗、因此本文件不引**：trust store 的父目錄路徑、`DELIVERY_PROFILES` 各常數的個別值、部分工具 budget 的逐工具行號。

**沒做的**：未安裝 `node_modules`、未執行任何建置／測試／ZCode 程式（唯讀紅線）；掃描皆為全掃（未截斷），唯一的 `head` 用於列出候選檔名。

---

## 9. 這份文件沒有建立什麼

- **沒有實跑。** 一切是靜態閱讀；「怎麼運作」是讀碼推論，不是觀察到的行為。執行期與讀碼可能不一致，而這份文件無法排除它。
- **ZCode 自己的「已驗證」聲明在樹上不可檢查**（4 個測試檔、無 CI）。引用它的註解時要帶著這個折扣。
- **覆蓋有限**：六份回報各有未讀清單；最大的未讀面是 `packages/ui`（32 萬行）、desktop renderer、bootstrap 逐檔、以及所有 execute 路徑。
- **§7 是映射，不是裁決。** 每一項「取」要變成 IH 的決定，仍要照 IH 自己的體例走。
- **沒有任何東西被複製。** 這份文件只帶走形狀與教訓。
- **數字會腐。** 全部量於 2026-09-21 的 `D:\agent-complete\ZCode-main` 快照；引用前先重跑 §8 的指令。
