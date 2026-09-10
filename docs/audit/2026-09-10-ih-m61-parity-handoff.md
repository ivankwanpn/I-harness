# M61 交接：grok 外觀對齊第二批 + resume 修復

日期：2026-09-10 · 分支 `m61`（自 `main` @ `86d6f34` = M60 尖端）
前一份：`docs/audit/2026-09-09-ih-m60-integration-handoff.md`

**一句話**：§4b 的其餘六項外觀對齊全部落地（`Worked for X`、即時 token、模型顯示名、Always-Approve 第三檔、`/effort` 即時作用、時間戳已確認），並修好使用者回報的 **resume 失效**（TUI 預設根本不持久化）。

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

## 0. 使用者回報的三件事（本輪追加，全部已修）

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

### 0e. 「Resume 顯示 no sessions」
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
| `pnpm --filter @i-harness/provider-runtime test` | 20 passed |
| `pnpm --filter @i-harness/tui-app test` | 30 passed |
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
- installer 本輪已重建（`build/I-harness-Setup-0.1.0{,-test}.exe`）。

## 5. 注意事項

- 分支 `m61` 疊在 `main`（M60 尖端）之上；**不要**直接 push 到 `main`。
- 使用者機器：`~/.i-harness/settings.json`（opencode go 供應商，`busyEnter: "interrupt"` = Steer）。修復後首次啟動會建立 `~/.i-harness/sessions/`。
- grok 源碼在 `D:\grok-build-main`；`[Click here to Upgrade]` 是 grok 自己的訂閲推廣，**不對齊**。
