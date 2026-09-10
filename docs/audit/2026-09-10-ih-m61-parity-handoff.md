# M61 交接：grok 外觀對齊第二批 + resume 修復

日期：2026-09-10 · 分支 `m61`（自 `main` @ `86d6f34` = M60 尖端）
前一份：`docs/audit/2026-09-09-ih-m60-integration-handoff.md`

**一句話**：§4b 的其餘六項外觀對齊全部落地（`Worked for X`、即時 token、模型顯示名、Always-Approve 第三檔、`/effort` 即時作用、時間戳已確認），並修好使用者回報的 **resume 失效**（TUI 預設根本不持久化）。**本輪結束時使用者裁定 TUI 凍結（不再投資），見 §5。**

---

## 1. 交付

| commit | 內容 |
|---|---|
| `52fc46a` | `feat(m61)`: 外觀對齊第二批 |
| `c0f2aca` | `fix(m61)`: TUI 預設持久化 → resume／session picker 可用 |
| `ec8ec43` / `885b039` | `docs(m61)`: 本檔（含 picker 過濾與 deferred-create 的取捨） |
| `b9c4e59` | `fix(m61)`: picker 隱藏從未使用的 session |
| `e4e1e30` | `fix(m61)`: **installer 出貨舊 bundle** + 圖片從未到模型 + base64 進 prompt |
| `66c121a` | `fix(m61)`: fs 工具失敗改為「回傳」而非拋出（使用者裁定 A 案） |
| `0c90a65` | `fix(m61)`: cancel 真的能停掉 parked request；函式庫 console 不再打穿畫面 |

## 0. 使用者回報的問題（本輪追加，全部已修）

### 0a. 「畫面渲染有問題」＝ installer 一直出貨**舊 bundle**
- `scripts/build-installer.mjs` 第 1 步原本是「`dist/ih.mjs` 存在就沿用」→ 第一次建置之後**每次打包都用同一份舊 bundle**。使用者 11:43 裝的那版，程式碼其實是 **09-09 14:53** 的（`C:\Program Files\I-harness\dist\ih.mjs` 時間戳可證、`grep "Worked for"` = 0）——所以他看到 JSON envelope、runtime-context 列、6 行輸入框，全部是 m59 之前的行為。
- **修**：`ensureDist()` 一律跑 `build-dist`；只有明確 `--dist-dir` 才沿用現成 payload。新 bundle 12:26 / 5,072,407 bytes（舊的 5,047,846）。
- **教訓**：安裝檔的「檔案大小差不多」不代表內容是新的；驗收要看 bundle 內的行為標記或時間戳。

### 0b. `read_image` 的圖片**從來沒有**到模型
- 所有 adapter 都用 `profile.inputModalities` 判斷能不能送圖，但**產品裡沒有任何地方設定過它**（沒有 template、settings 也沒欄位）→ 永遠 text-only → `[image omitted: model is text-only]` 是唯一可能的結果。
- **修**：`llm.providers.<route>.inputModalities` 與 `...models[i].inputModalities`（model 覆蓋 route，封閉集合 `{text,image}`，缺省＝text-only 的 M14 負能力）。使用者要讓 opencode-go 有視覺，加 `"inputModalities": ["text", "image"]` 即可。

### 0c. 圖片 base64 被塞進 prompt 文字
- `deriveMessages` 對 tool/result 是 `JSON.stringify(ev.output)` → `read_image` 的結果把**整張圖的 base64 當文字**送（1 MB 圖 ≈ 140 萬字元），**外加**真正的 image part。
- **修**：`toolResultText()` 剝掉真正的 `images` 陣列、附短描述（`image: x.jpg 800x600 12345B base64:AAAA…`），與 `deriveSearchText` 同規則；非陣列的畸形 `images` 仍原樣保留（M14 防禦規則）。

### 0d. `read_image` 讀不到檔案「卡住」 → **A 案：fs 失敗改為回傳**
- 真相：tool body 拋錯 = **整個回合失敗**（core-agent M13/M25：整批結果丟棄、不寫 tool/result、不寫 turn/end）→ 那個 `Call read_image` 永遠沒有結果、回合列一直轉。
- 使用者裁定 **A**：`FsToolError` 與一般 errno（ENOENT/EACCES/EISDIR/…）由 `read`/`write`/`edit`/`list_dir`/`apply_patch`/`read_image` **回傳** `{ error, code }`；真正的程式錯誤（TypeError…）仍照舊拋出、回合失敗。TUI 把這個形狀渲染成訊息（`ENOENT: … (ENOENT)`）而不是 JSON。
- 新增端到端測試（`session-executor`）：讀不存在的檔案 → 模型看得到 ENOENT 結果、有 turn/end、回合繼續。

### 0f. 畫面被函式庫的 `console.warn` 打穿（「改完之後有bug」）
- 症狀：`[rewind] bound pre-M54 journal C:\Users\…\sessions\rewind\… to workspace … (no meta.json existed)` **出現在輸入框裡面**（貼在游標位置）。
- 根因：`packages/rewind/src/store.ts:329` 的 `console.warn`，在 TUI 持有終端時直接寫 stdout → 落在 caret 上。觸發條件是**本輪新增的預設持久化**（`rewindStoreRoot` 現在一律有值，rewind journal 第一次被綁定）。
- 修法：`captureConsoleForTui()`（`apps/tui`）在 TUI 執行期間把 `console.log/info/warn/debug/error` 改寫到 `<config home>/logs/tui.log`，teardown 還原。刻意不去追 49 個函式庫 console 呼叫點——宿主統一接管才是不會再犯的做法。
- 參數：純 CLI（`i-harness run`）不受影響（只有 `runTui` 裝這個攔截）。

### 0g. 「2 分鐘了還不停下來」＝ cancel 殺不掉 parked request
- 根因：agent loop 只在**收到事件後**檢查 `aborted`，而 `LLMRequest` **完全沒有 signal** → provider 若卡在沒有回應的 socket 上，Esc/[stop] 取消不了（embedded backend 標頭第 4 點早就把這列為待補的 M38 seam）。
- 修法：`LLMRequest.signal`（llm-seam）→ core-agent 從 turn 的 AbortController 帶入 → 四個 fetch adapter（openai / openai-compatible / anthropic / gemini）把 signal 交給 transport，bedrock 走 SDK 的 `{ abortSignal }`。
- 附帶：使用者主動停止不再被報成失敗——[stop]/Esc 會 toast「Stopped」，abort 的 rejection 不再顯示 `submit failed: agent aborted`。
- 驗證：新增測試（session-executor）——parked request 在 abort 後 ~160ms 結束（修前會永遠停在那）；adapter 端斷言 signal 真的進到 fetch。


### 0h. 「Resume 顯示 no sessions」
- 不是新 bug：使用者先前的對話跑在**舊版**（沒有 store root＝ephemeral），**從來沒有寫進磁碟**，救不回來。修好後（`c0f2aca`）首次啟動會建立 `~/.i-harness/sessions/`；`listSessions` 現在只列真的跑過回合的 session，所以「開過沒用」的空殼不會出現。
- 驗證：`~/.i-harness/sessions/` 建於 12:33（新版首次啟動），內含 3 個 94-byte 空殼（開過沒用）→ 被 `visibleSessions` 正確濾掉。


### 1a. 外觀對齊（§4b 其餘項目）

- **`Worked for X` 回合尾**（`scrollback/folding.ts` + `engine.ts` + `entries.ts`）
  engine 在 turn/start 記下 `ts`，turn/end 算出 `elapsedMs` 掛在 TurnBlock 上；渲染成 `Worked for X` 的暗色單行（grok 的 `SessionEvent::TurnCompleted`）。**未配對的 turn/end 不畫**（無時長 = 無 marker）。
  時長詞彙統一為 grok 的 `format_duration`：`9.4s` / `45s` / `1m25s` / `1h5m`（舊的 `1m 5s` 多一個空格；`Thought for X` 也一起吃這個）。
- **即時 token 用量**（`app/loop.ts`）
  狀態列 context chip 的探針原本只在啟動與**回合邊界**跑；現在 thinking/assistant 事件也會跑，climbing 看得見。**節流 500ms**（`CONTEXT_REFRESH_MIN_MS`）：探針走 `activeTokens(deriveMessages(session))`，逐 chunk 呼叫會是 O(n²)。回合邊界／session 切換／啟動走 `refreshContext(true)` 不受節流。
- **模型顯示名**（`provider-runtime/src/index.ts`）
  binding 的 `label` 由 `provider:model` 改成 `displayName · model`（`OpenCode Go · glm-5.3-flash`）；`displayName` 等於 id 時維持舊形狀。這條 label 同時餵 status row、prompt info line 與 minimal region。
- **Always-Approve 第三檔**（`keymap` + `approval.ts` + `slash/impl/approval.ts`）
  `Shift+Tab` 變成三檔：`normal → plan → always-approve → normal`。第三檔把 approval bridge 的 answerer 切成**直接放行**（`setAlwaysApprove(on)`，執行期生效，不彈窗）；prompt info line 顯示 ` · always-approve`。`/always-approve`、`/auto` 走同一條 seam（不再是 "not wired" toast）；**host 沒接 seam 時會誠實說**「approvals still ask」（approveAll 的 assembly 從不發問，本來就不需要它）。
- **`/effort` 作用於當前 session**（`provider-controller.ts` + `loop.ts`）
  controller 之前只在建構時拿 `flags.attach ?? flags.resume`，所以開著 session 時 `/effort` 只改到**全域預設**（使用者看不到效果）。現在 loop 的 `activateAgent` 會 `setSessionId(...)`，`/effort` 有活躍 session 時走 `selectModel`（per-session selection，grok 的「不重新選模型只調 effort」語意），閒置才寫 `llm.defaultModel`。
- **時間戳**：原本就有（engine `showTimestamps` + 右對齊 + hover 換 `18:46:35 | Sep 05`），本輪確認渲染正確，未改。
- **底部提示**：prompt focus 的列與 grok 已經一字不差（`Enter: submit │ Ctrl+Enter: interject │ Ctrl+M: multiline │ Shift+Tab: mode │ Esc: clear`），未改。

### 1b. resume 修復（使用者回報）

- **根因**：embedded factory 在沒有 store root 時**刻意跑 ephemeral session**，而 `apps/tui` 只在命令列有 `--session-dir` 時才傳 store root。所以一般啟動**什麼都沒存**：F3 清單空的、`--resume` 直接 throw「requires --session-dir」，對話記錄不可能回來。
- **修法**：
  - `resolveSessionDir()` — 預設 root = 設定檔的 config home 之下 `sessions/`（`$IH_CONFIG_DIR` 或 `~/.i-harness`）；`--session-dir` 仍可覆蓋。
  - `buildEmbeddedSessionOptions()` 一律帶 `storeRoot` + `rewindStoreRoot`。
  - `buildSdkArgs()` 也帶同一 root（`--attach` 生出的 SDK server 必須看到同一個 store，否則找不到 session）。
- **既有測試已覆蓋後端行為**：`packages/tui/test/backend.test.ts` 的「emits session/open before the replacement session history」「rebinds the live event stream when opening another durable session」「durable TUI session survives close and reopen without repeating kickoff」——**缺的只有 host 的預設 root**，已補單元測試。
- **附帶**：factory 在**建構時**就會建立 session，所以「開了沒用就關掉」的每一次啟動都會在 store 留下一筆空白 session，而它 `updatedAt` 最新 → 會排在 F3 清單**最上面**。因此 picker 端過濾掉後端能證明是空的列（`turnCount === 0`）；`turnCount === undefined`（後端無法誠實判斷）**保留**，不靠猜測隱藏。過濾放在 host 的 `visibleSessions()`（UI 政策），不動 backend 的 `listSessions` 契約。

> 走過但**放棄**的路：讓 factory 延後建立 session（deferred create）。做法可行（已實測：開機 0 檔、首次 submit 才落檔），但 `defaultEmbeddedFactory` 的「建構即建立」語意被 4 個既有測試依賴，改動面偏大且逼近 sdk/attach 路徑，評估後改走 picker 過濾（風險小、使用者可見結果相同）。若日後要收掉空白檔本身（不只是 UI 隱藏），deferred create 是那條路。

## 2. 驗證（實跑）

| 命令 | 結果 |
|---|---|
| `pnpm --filter @i-harness/tui test` | 71 files / **771 passed**（含 harness 18 檔 21 測） |
| `pnpm --filter @i-harness/provider-runtime test` | 21 passed（含 inputModalities） · `settings` 65 · `fs` 60 · `attachment` 9 · `session-executor` 66 · `llm-openai-compatible` 14 |
| `pnpm --filter @i-harness/tui-app test` | 31 passed |
| `pnpm -r typecheck` | 全部 Done（exit 0） |
| `pnpm -r test` | exit 0 |
| `pnpm e2e` | 5 files / 12 passed |

新增測試：`packages/tui/test/mode-cycle.test.ts`（三檔循環 + `/always-approve` `/auto` 的 seam 行為）。

## 3. Harness 重釘（case-023 / case-026）

- `Worked for X` 讓每個回合多一列 → **case-023 的場景從 28 行變 30 行**：follow 的 max 由 13 變 15，滾輪／捲軸／時間軸 anchor 全部位移，已逐塊重釘（含 023t 的 tick 列 15→14）。
- `case-026`：settled 視窗少一列的位移 + `Worked for 1.2s`（真實 fs/shell 延遲、**故意不釘**）出現在最後一列之下。
- `case-028`：一度把 `timestamps: true` 打開，因為時間戳是真實時鐘（`11:07 AM`）無法釘，**已還原**。
- 重釘方法：在 `referee.ts` 暫時加 `IH_HARNESS_SOFT=1` 軟斷言模式（記錄不符後繼續跑）＋ `IH_HARNESS_TRACE=1` 逐 step 畫面 dump，收齊後**已完整還原**（`git diff` 乾淨）。

## 4. 殘留 / 下一步

- **§4a settings 對齊**（grok 單一捲動面板 + `/ to search`）**仍未動**——這是使用者在 §4b 之前原本點名的項目。落點與注意事項見 M60 交接 §6。
- **case-027 並行 flake**：全套並行時 `spawn-running` 會逾時（單獨跑 5.2s 綠）；本輪再次複現後已把該 marker 的預算提到 150s，屬倉庫既有 PTY/spawn flake，不是回歸。
- **`promptCap = floor(rows/2)`** 仍會在小視窗裁掉大型覆蓋層（M60 §5 已記，非本輪引入）。
- installer 每輪都已重建（最後 12:5x 版）；**注意 `build-installer` 現在一律重建 dist**，再也不會出貨舊 bundle。

## 5. 裁定：TUI 凍結（2026-09-10）

使用者裁定「**TUI 放著不再投資**」：程式碼與分支保留，但**停止**外觀對齊（§4a settings 面板、§4b 未竟項）與後續 TUI 打磨；之後的推進改走 CLI / web / 其他方向。本輪所有 TUI 修復（m59 起）仍然有效並保留在 `m61`。

凍結時的最後狀態：`m61`，installer 13:09 版，`verify-installer` PASS，全 workspace typecheck 0 錯。

已知未竟（凍結後不再處理）：
- §4a settings 單一捲動面板、§4b 剩餘外觀項。
- `promptCap = floor(rows/2)` 在小視窗裁掉大型覆蓋層。
- **模型請求無逾時**：provider 不回應時回合會一直等（Esc 現在取消得掉，但不會自動收斂）——若要恢復 TUI 工作，這是第一順位。
- case-027 全套並行的 spawn flake（已把預算提到 150s）。

## 5b. 凍結後的第一件 CLI 工作：`i-harness sessions`

TUI 不再投資後改推 CLI。第一個補的缺口：**durable store 沒有任何 TUI 之外的讀取面**——`--resume` 要一個使用者無從得知的 id，headless 也看不出對話有沒有留下來（使用者今天就撞到「Resume 顯示 no sessions」）。

- `i-harness sessions [list] [--session-dir DIR] [--json]`
- `i-harness sessions show <id> [--last N]`
- root 預設 = `<harness home>/sessions`（與 TUI 同一個；`--session-dir` 可覆蓋）；新增共用解析器 `resolveSessionStoreRoot()`/`resolveHarnessHome()`（`@i-harness/session-persistence`），`apps/tui` 的 `resolveSessionDir` 也改用它——兩邊不會再各自發明路徑。
- 唯讀：**不取 ownership、不寫入**（別的 process 正在用的 session 照樣列得出來，只是列上寫的是 header 的事實）。單一壞檔只讓那一列帶 `problem`，不使整份列表失敗。
- `show` 的 transcript：`─── turn` / `❯ prompt` / `◆ tool args` / `→ result` / assistant 文字；**internal 的 runtime-context 訊息不入 transcript**。
- `sdk` 的 `session/list` 改用同一個 listing 實作（原本 45 行內嵌邏輯刪掉）。
- 測試：`apps/cli/test/sessions.test.ts` 12 例（解析、空 store、壞檔、排序、transcript 尾巴、exit code）。

## 5c. web：`/` 唯讀頁（R-C0/R-C1 其實早就做完了）

凍結後查證：**R-C0（engine-owned 組合）與 R-C1（路由面）早已交付**——`apps/cli/src/web.ts` 實測 **567 行**、`packages/web-host` 有 23+ 路由 matcher + 16 個測試檔、`GET /api/sessions/:id/events`（beforeSeq 反向分頁）與 WS mux 都在。所以「web 架構重寫」沒有內容可做。

> 註記（驗收輪更正）：web.ts 檔頭那句「The branch's 1,598-line glue (web.ts + live-agent.ts) is NOT recreated」指的是**分支歷史**裡被廢棄的膠水——本 repo 根本沒有 `live-agent.ts`（`git ls-files` 為空），所以 1,598 這個數字**在此無法核對**。它只是「沒有重造」的說明，不是現況量測；判斷 R-C0 是否完成要看可驗的東西（web.ts 行數、路由 matcher、測試檔、assembly 是否來自 session-executor）。

真正缺的只有 **UI**：`/` 回 404（M26 明確延後 static serving）。本輪補上最小切片：

- `packages/web-host/src/ui.ts` — 單一自帶 HTML（零框架、零建置），左欄 session 清單（新到舊，含 `running`/`empty` 徽章與相對時間）、右欄 transcript（`─── turn` / `❯` / `◆` / `→`；**internal runtime-context 不顯示**），「load older」走 `beforeSeq` 分頁。
- `WebHostOptions.ui`（預設 **true**）；`ui: false` 保留原本 API-only 姿態（B3-H3 測試改釘這個）。
- session 列新增 `updatedAt`（profile 本來就讀了，零額外 I/O）——清單終於能按新舊排。
- 驗證：web-host 160 passed；**真實瀏覽器**（Playwright）開 `http://127.0.0.1:4392/`，畫面確實列出 15 筆真實 session 並成功渲染 `sess-mtv1y8t1-z3rwz` 的 transcript。
  - 校正：實際 store 是 **16 筆**（`/api/sessions`、`i-harness sessions --json`、磁碟 `.jsonl` 三方一致），非 15。且這 16 筆的 `title` **全部缺席**（`modelSelection` 只有 1 筆有），所以頁面清單在真實資料上會顯示裸 id（`ui.ts` 的 `s.title || s.id` fallback）——不是 bug，但畫面比測試 fixture 空。
  - 註：本文件用的 URL 是 `http://`（正確）。對外說明若寫成 `https://127.0.0.1:4310` 是錯的：該 server 是純 HTTP，HTTPS 直連得到 `HTTP 000`（schannel 對 IP + 自簽直接拒）。

## 5d. 驗收輪（verifier pass）：一個真 bug、一個環境陷阱

獨立複驗（非開發者自評）在 `7be9623` 上跑出的結果與修正：

- **真 bug：`GET /api/sessions/:id/events` 對未知 session 回 500（唯一漏 guard 的路由）**
  同一顆不存在的 id：`goal` → 404、`resume` → 404、`events` → **500**，而且 body 是原始
  `ENOENT … open 'C:\Users\…\.i-harness\sessions\<id>.jsonl'`——**錯誤字串與絕對 store 路徑一起上線**。
  根因：`host.ts` 的 `await coordinator.load(id)` 沒有 `isUnknownSessionError` guard；該 helper 被其他
  **9 處**使用，就這條漏了。而 L400 的註解自己承諾「an unknown session answers 404 (events-route
  parity)」，`jobs-routes.test.ts` 甚至有兩個測試以「events route parity」為名在驗 404 → 契約早就存在。
  影響：SPA 的 `ui.ts` 對 `!res.ok` 只能顯示 `events unavailable (500)`——picker 列到已刪除的 session
  時，使用者看到的就是這個。
  修法：補上與其他 9 處相同的 guard + regression 測試（同時釘住 status、body、**不洩漏路徑**）。
  已用突變測試證明該測試會抓到：拆掉 guard → `expected 500 to be 404` 紅。
  實機複驗：`events` → **404** `{"error":"session not found: …"}`，與 `goal`/`resume` 三路由一致；
  真 session 仍 **200**、分頁不變（`limit=5` → `hasMore=true, nextBeforeSeq=14`）。

- **環境陷阱：`NO_COLOR` 會讓 PTY harness 紅（不是回歸，但讓「綠」不可信）**
  `tui-core`/`tui` 的 `test/harness/runner.ts` 把子程序 env 設成 `{ ...process.env, FORCE_COLOR: "1" }`。
  Node 視 `NO_COLOR` 為絕對（`--no-color` 別名），於是印
  `Warning: 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.` 到 stderr——
  **那條 stderr 就在受測 PTY 裡面**，直接打進畫面，`case-010` 的螢幕斷言因此位移。
  只要環境裡有 `NO_COLOR`（CI runner、shell、編輯器都可能注入）就紅。
  修法：兩個 runner 都改成先 `const { NO_COLOR: _noColor, ...env } = process.env` 再 `FORCE_COLOR: "1"`。

- **flake 的真正機制（診斷升級，非「再放大數字」）**
  `case-027` 的 test 層逾時原本 **120s**，卻小於它自己 YAML 內容的最壞預算（`spawn-running` 150s +
  `queued-prompt` 40s + `queue-cancelled` 30s + `task-cancelled` 30s + `live-tasks-zero` 40s +
  `teardown-wrote` 60s + ~20 個 5s cell poll ≈ **250s**）→ 外層永遠先砍，**每個內層 `timeoutMs` 都是裝飾**，
  現場只會看到無資訊的「Test timed out」。這就是 M61 只把 marker 提到 150s 卻沒止住 flake 的原因。
  修法：test 層提到 **300s**，讓內層預算真的可達。修完之後同樣的紅燈**第一次說得出病因**：
  `step 3 (await-marker): marker "spawn-running" not found after 150000ms`——即**真實嵌套 spawn 在
  全套並行下 150s 內起不來**（單獨跑 ~5s）。
  其他兩個：`workspace-cwd` 的 `EBUSY` 是 PTY handle 未即時釋放（`rmSync` 的 `force:true` 只吞 ENOENT、
  **不吞 EBUSY**），改成有界重試 helper（`test/helpers.ts` 的 `rmWorkspaceSync`，已單獨證明 EBUSY 重試語意）；
  `assembly-import` 的 5s 逾時對「兩次模組圖載入 + `resetModules()` 清 transform 快取」太緊（冷啟 ~855ms），提到 30s。
  另：`core-agent/execute-tool-calls` 有一條**時鐘斷言**——`t.order` 期待 `["fast","slow"]`，但那只是
  40ms vs 5ms 的餘裕，滿載時會反轉。並發這件事由 `maxConcurrent === 2` + 兩個 body 都結算就已證明，
  故改為不依賴時鐘（**真正的契約「commit 順序 = 模型順序」仍釘在 `resultsOf` 那條**）。

- **仍未解**：`case-027` 的 `spawn-running` 逾時。**先更正一個說法**：驗收輪一度觀察到
  `pnpm -r --workspace-concurrency=1` 全綠，就下了「序列化即可」的結論——**那是單次樣本，不成立**。
  後續複驗：**序列跑也紅**（同樣 step 3、同樣 150s）；**單獨跑穩定綠（~5.2s）**。所以它與**任何**
  非單獨執行的負載耦合，不是只跟「70 個 package 並行」耦合。
  另需更正 marker 的命名直覺：`spawn-running` **不是真的 spawn**，而是 host-027 的 watcher 看到
  mock 模型驅動的任務 `root/helper` 進入 `status === "running"`（`modelPolicy: "required"`、
  provider `mock`）——所以「真實嵌套 spawn 太慢」的說法對這個 marker 並不精確，實際是
  **mock 步進機在搶機器時推不到那個狀態**。
  結論：這是一條**只有在單獨執行時才可靠**的測試。要嘛用實測支撐去調預算，要嘛把它放進
  獨立的單檔閘門（其餘 PTY 檔照常跑）。在還沒做這件事之前，**不要把它算進「全套綠」的判準**。
  （本輪已讓它的失敗訊息可診斷：不再是無資訊的 "Test timed out"，而是指名 step 3 與那個 marker。）

## 5e. 安全性修復：web 的 Host/Origin 柵欄不再取決於 auth

**發現（驗收輪，同一天）**：`web-host` 的柵欄（DNS-rebind 的 Host 檢查、CORS 的 Origin 檢查）原本
**整段包在 `if (auth !== undefined)` 裡**，而 `apps/cli/src/web.ts:485` 是
`const auth = opts.auth === undefined ? undefined : createAuth({...})` —— 也就是**裸跑 `i-harness web`
（沒有 `--launch-token`／`--hmac-secret`）時 auth 是 undefined，柵欄整個被跳過**。實測（修前）：

```
WS  /api/mux  foreign Origin https://evil.example   -> UPGRADED，而且收得到 frames
WS  /api/mux  rebound Host   evil.example           -> UPGRADED
POST /api/sessions  Origin: https://evil.example    -> 200
```

**為什麼這比它看起來嚴重**：HTTP 那側還有救（不送 ACAO → 外站 JS 讀不到回應），但
**瀏覽器不對 WebSocket 套 CORS**，所以對 mux 而言 Origin 檢查**就是唯一的柵欄**。外站頁面因此可以
送 `command` = **替使用者對 agent 注入 prompt**（agent 有工具、`workspace-write`），也能開 `session`
stream **讀回對話**。而 `127.0.0.1` 的 bind **不是**柵欄——DNS rebind 一樣打得到 loopback。
觸發窗口是「使用者正在跑 `i-harness web` 又去逛別的網站」；一旦頁面接上 prompt UI 就會變成可即時觸發，
所以排在那一步之前修。

**修法**：把柵欄與授權**解耦**。`hostAllowed`/`originAllowed` 從 `createAuth` 內部抽成 `auth.ts` 的
**exported free functions**（`AuthContext` 的同名方法改為 delegate，語意不變），host.ts 的
`guardAndAuth` 與 mux `upgrade` handler 都改成**無條件先跑柵欄**，`auth` 只管後面的授權。
`originAllowed(undefined) === true` 的既有語意保留（無 Origin = 非瀏覽器客戶端，交由 Host 柵欄管）。

**驗證**（修後，真 server）：

| 請求 | 結果 |
|---|---|
| WS rebound `Host: evil.example` | socket hang up（拒） |
| WS foreign `Origin: https://evil.example` | socket hang up（拒） |
| WS 正常 loopback Host / Origin | UPGRADED |
| WS 無 Origin（CLI/SDK） | UPGRADED |
| HTTP rebound Host / foreign Origin | **403** / **403** |
| HTTP 一般 curl / loopback Origin / `/` / health | 200 / 200 / 200 / 200 |

新 regression 測試（`host-routes.test.ts`）**同時**釘住 foreign Origin、rebound Host **與** loopback
負控制；已用突變測試證明它會抓到（把柵欄塞回 `if (auth !== undefined)` → `expected 'upgraded' not to be 'upgraded'`）。

**教訓（方法論）**：`ws` 客戶端**從不送 Origin**，所以既有的 upgrade 測試結構上看不到這個洞；
而 Node 內建 `WebSocket` 會**靜默忽略**自訂的 `Host` 標頭——用它測 rebind 會得到假的 UPGRADED。
測這類柵欄要用 `node:http` 的**原始 handshake**，才能真的控制送出什麼。

### 5f. 獨立複驗（verifier pass，同日；作者／驗證者分離）

對**無 auth** 的真 server（`PORT=4391 node --import tsx apps/cli/src/index.ts web`，未帶 `--launch-token`）用 `node:http` 原始 handshake 重跑：

| 請求（auth-less） | 修**後** | 修**前**（同一支 probe，把柵欄塞回去的突變版） |
|---|---|---|
| WS `Host: evil.example` | 拒（ECONNRESET） | **UPGRADED 101** |
| WS `Origin: https://evil.example` | 拒（ECONNRESET） | **UPGRADED 101** |
| WS loopback（有 Origin / 無 Origin） | **101 UPGRADED** | 101 UPGRADED |
| HTTP rebound Host / foreign Origin | **403 / 403** | **200 / 200** |
| HTTP loopback Host+Origin | 200 | 200 |

- **突變測試在活 server 層**（不只是單元測試）：同一支 probe 對修前行為**全紅**，所以這些拒絕是**判別性的**，不是「拒絕一切」也不是別的原因造成的。loopback 正控制同時證明 socket 路徑本身是通的。
- **影響面到 frame 層（不只到 upgrade）**：在修前行為的 server 上，用 `ws` 帶 `origin: "https://evil.example"` 連 `/api/mux` 並送
  `{"type":"open","streamId":"s1","endpoint":"session","payload":{"sessionId":"<真實 id>"}}` → **連上了，而且收到 `{"type":"ready","streamId":"s1"}`**：
  外站頁面**真的訂閱到真實 session 的事件流**（同時間 `/api/sessions` 回 **19 筆**真實 session）。修後同一支 probe：**NOT OPEN、0 frames**。
  寫入面（`endpoint: "command"` + `payload.prompt`，`host.ts:576`）走**同一個 dispatch、沒有第二道閘**——這條**刻意沒有**對真 session 實跑（會動到使用者的資料與模型額度），是依程式路徑判定的。
- **更正 §5e 的一句**：「HTTP 那側還有救（不送 ACAO → 外站 JS 讀不到回應）」只對 **foreign Origin** 成立。**DNS rebind 下攻擊頁與 API 是同源**（都是 `evil.example:PORT`），
  CORS 根本不會介入——所以 **Host 柵欄是讀取面的全部防線**，rebound Host 那格（修前 200）比原描述嚴重。
- **覆蓋缺口（本輪補上）**：原 regression test 只釘 **WS upgrade**，`guardAndAuth` 的 **HTTP 半邊沒有測試**。已補
  `host-routes.test.ts` → 「HTTP fence rejects a rebound Host and a foreign Origin — even with NO auth configured」（含 loopback 與**無 Origin** 兩個正控制），
  並以突變證明它會紅（`- 403` / `+ 200`）。web-host **163 passed**（原 162）。
- **產品面無回歸**：修後用**真實瀏覽器**（Playwright）開 `http://localhost:4391/`（auth-less）——清單列出 **19 筆**真實 session、點列載入
  `/api/sessions/:id/events` **200** 並渲染出 transcript（`─── turn` / `❯ Reply with exactly the word: PONG` / `PONG`）。`localhost` 本來就在 `LOOPBACK_HOSTS` 內，常見開法不受影響；
  唯一 console 錯誤是 `/favicon.ico` **404**（既有、純外觀）。
- **一個 probe 假象（記下來免得下次誤判）**：`node:http` 的 client 在沒給 Host 時會**自動補上** `Host: 127.0.0.1:port`，所以「送不出 Host 標頭」那一列其實等於 loopback 正控制（得 200 是對的）。
  要真的測無 Host 得走 raw socket。

## 6. 注意事項
- 分支 `m61` 疊在 `main`（M60 尖端）之上；**不要**直接 push 到 `main`。
- 使用者機器：`~/.i-harness/settings.json`（`busyEnter: "interrupt"` = Steer）。**§6 原文的
  「deepseek 是不匹配的無效組合」已在同日修正**：`baseURL` 是 Anthropic 格式（`/anthropic`），把
  `protocol` 由 `openai-completions` 改成 **`anthropic-messages`** 後，以真實預設 route 實測
  200 + `assistant/message: "PONG"` 落盤（修前 404）。`opencode go`（`https://opencode.ai/zen/go` +
  `openai-completions`）仍是另一條可跑的路。
- `~/.i-harness/credentials.json` 的 `refs` 存的是**明文 secret**（不是環境變數參照，是「env 變數名 →
  真 key」的值）；設計如此（`process.env > file`、env shadow 時拒寫、暫存 0600）。驗收輪不慎把內容
  印進了 session log，**建議輪換該檔內的 key**。
- grok 源碼在 `D:\grok-build-main`；`[Click here to Upgrade]` 是 grok 自己的訂閲推廣，**不對齊**。
