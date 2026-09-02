# dsh 0.1.2-alpha.3 → alpha.4 版本增量研究

日期：2026-09-02（分析 2026-09-02；兩樹實際檔名與官方註記範圍截止 2026-09-01）· 方式：雙樹唯讀 diff（無 git——文件級 `comm/diff` + 逐包 src 比對 + 官方決策註記閱讀）

**樹**：`D:\deepseek-harness-dsh-v0.1.2-alpha.3`（a3）vs `D:\deepseek-harness-dsh-v0.1.2-alpha.4`（a4）。兩樹均無構建產物。

**統計**：頂層 55 個包**零增改名**（a4 與 a3 包名逐項一致）；文件級差異 ~2029 個 modified；`Only in a4`（新增）極少、`Only in a3`（移除）集中於被刪塊；**全倉幾乎零新增 src 源文件**。→ 這是**「修改與清理」型**版本，不是「新增能力面」型。

## 0. 一句話結論

**類型修正型版本，配合一輪 web/UI 換版。** 對比 a1→a3 的「收斂與淨化」少了大遷移，a3→a4 的經濟在**少數高密度架構決策**：①Session 位置把「事件身分」與「日誌偏移」兩種長得像的 `number` 用品牌型別拆開（`SessionSeq` / `SessionLogOffset`）；②Session 日誌讀取語意顯式化（`seq` / `eventAt` / `snapshotEvents`，去掉隱藏的整份拷貝）；③相鄰子代理統一為**單一 `send_message` 工具**，刪掉子代理專屬 `report` 工具與 `tool:report` prompt 段；④invariant 伴侶大清理（209→39）。**其餘是版本號 + README/tsconfig 機械 churn + React 前端視覺換版 + CPython 後端穩定性加固。** I-harness 已吸收的 dsh 概念域（interaction/guard/subagent/jobs/goal/schedule）在 a4 繼續穩定，**無「IH 落後 dsh 最新」的緊急項**——但其中 Session 位置語義與子代理訊息統一，是 IH 值得列入中期評估的改向（見 §7）。

## 1. 主線一：Session 位置身分與日誌偏移分離（最大架構事件）

官方註記：`.agents/notes/implemented/architecture/2026-08-31-session-sequence-and-log-offset-brands.md`（status: implemented）。

- **問題**：一個 `number` 同時承載兩種不相容含義——「事件身分」指向**既存一列**，「前綴長度 / 下一次 append 位置 / 讀取切點」指向**空檔**（且可能等於事件數）。編譯器因此接受「該是事件身分的地方塞了 offset」，也暴露不出漏掉的 sequence 欄位遷移。`SessionHeader.seedLength` 又把 v0 儲存座標混進**無 body 讀者**所用的 metadata。
- **決策**：`@deepseek-ai/dsh-brand` 導出消去型別 `BrandedNumber<B>` + 執行期身份 `brandNumber()`。`@deepseek-ai/dsh-session` 擁有兩個驗證品牌：**`SessionSeq`**（命名**一個既存事件**）與 **`SessionLogOffset`**（命名**日誌空檔 / 前綴長 / 讀取偏移**）。附加 `SessionSeqCursor = SessionSeq | -1`（首事件前/後的水位）、`OptionalSessionSeq = SessionSeq | null`（「缺位是資料」的事件身分）。
- **歸屬**：事件身分（`SessionEvent.seq`、surface replacement 端點、provenance、owner 承載欄位）用 `SessionSeq`；計數與偏移（`Session.seq`、`firstLiveSeq`、`inheritedEventCount`、body-read offsets、繼承前綴切點）用 `SessionLogOffset`。算術回普通 `number`，再經各自驗證構造函數回域。
- **邏輯 header**：`SessionHeader` 帶 `isSeeded: boolean`，**不再帶 numeric seed cut**；`inheritedEventCount` 由 body 承載的儲存值/觀察值攜帶，與 header 並置。`Session.ownEvents()` / `Session.isOwnSeq()` 對一般消費者隱藏比較。seeded 構造要求明確 seed 與確切 cut（含**空 seed + cut 0**——因構造輸入可能含 child-owned setup 事件）。
- **v0 JSONL 物理格式保持 byte 兼容**：無 `seedLength` → 解碼 `isSeeded: false` + cut 0；有 0/非零 → `isSeeded: true` + 確切 cut。**僅 header listing 只翻譯 presence bit**。API / SDK / DeepSeek / telemetry / query-row / JSON 表示仍傳普通數字，由所有者 adapter 在同進程域代碼進入時驗證 + branding。
- **驗證**：`session-persistence-jsonl/src/format.ts` 實作確認——`toHeaderLine(header, inheritedEventCount?)`，seeded 無 cut → throw；`HeaderLine` 由 `export` 內藏；parse 回傳 `{ metadata, inheritedEventCount }` 對。域構造函數拒絕負/小數/非有限/不安全的整數。

## 2. 主線二：Session 日誌讀取語意（成本顯式化）

官方註記：`.agents/notes/implemented/architecture/2026-08-21-session-log-read-intent.md`。

- **問題**：萬用 `Session.events` accessor 在每次 append 後把一個陣列級拷貝藏在每次讀取之後。完整快照可緩存，但串流讓此緩存每進一新事件即失效——**只要長度或單一事件的讀者，每次都能重複拷貝上百萬 reference**。
- **決策**：`Session` 暴露**三種成本明確的讀操作**——`seq()`（常時長度）、`eventAt(seq)`（常時單一事件）、`snapshotEvents(fromSeq?, toSeqExclusive?)`（顯式物化凍結陣列，給需要陣列操作者）。序列參數是「日誌位置」，**非** `Array.prototype.slice` 的「從尾端 offset」。整份快照緩存到 append 前（重複整份消費者共享同一不可變陣列）；範圍快照只拷選中 reference、**不緩存**（任意範圍緩存需回覆/回收策略）。回歸域狀態（例: 選定 agent preset）改讀 **Session projection**，而非重掃 live history。
- **源碼確認**（a4）：`session-log-deepseek/src/index.ts` 使用 `session.eventAt(SessionSeq(index))`、`session.snapshotEvents()`、`session.snapshotEvents(SessionLogOffset(afterSeq + 1))`；`coordinator.ts` 大量改用 `snapshotEvents()`。

## 3. 主線三：相鄰代理統一 `send_message`（刪 report 工具）

官方註記：`.agents/notes/implemented/architecture/2026-08-27-adjacent-agent-steer-messaging.md`、`.agents/notes/implemented/bug-fix/2026-08-17-subagent-message-settlement-ordering.md`、`.agents/notes/implemented/simplification/2026-07-27-intent-named-subagent-continuation-operations.md`（被超替）。

- **問題**：可續行子代理原本兩條方向各用不同控制面——父對子 `send_message({ subagent_id, message })`（委派 FIFO followup）；子對父用**子作用域** `report({ output })` 工具 + `tool:report` system-prompt 段 + 部署選定 quiet/waking 交付——同一「相鄰 Agent 操作」卻有不同 schema / service path / provenance / scheduling。且 child-only 工具與 prompt 段**每次繼承 fork turn 前都搶先出現**，使 fork 子代的請求頭與其父不同，逼 provider 重灌整個拷貝的 transcript。
- **決策**：`SubagentRuntime.sendMessage(sender, targetId, content, { signal })` 成為**唯一**model-authored 訊息操作；continuation manager 只接受**確切在場 sender + 一條相鄰邊上的 target**（父→直接可續行子、子→確切在場直接父）。siblings / self / 祖先超一層 / stale Agent / 未知 / 一次性子代一律不是路徑。**每個被接受訊息都用 `Agent.steer()`**：運行中目標在最近 step 邊界接收；閒置目標開 turn；absent 直接子代理冷恢復後走同一個 Steer。去掉了 recipient-free child 快捷與「結構性返回工具可活過明確子代 allow-list」的舊能力。
- **單一模型工具 + 單一返回指示**：全域註冊的方向中性工具 `send_message({ agent_id, message })`，固定 schema；父子繼承同一份定義同一註冊順序。子代 `toolFilter` 可顯式移除、作用域 replacement 可給不同語義；兩者都不再收到標準呼叫指示。
- **移除**：`@deepseek-ai/dsh-tool-subagent-report` **整包（已刪）**、`report` schema、`tool:report` prompt 段、`reportDelivery` 配置、report 專屬 message source、catalog 條目、composition rows、supported-behavior snapshots。`grep` 確認 `tool-subagent-report` = `Only in a3/.../packages/subagent`。
- **順序修復（bug-fix）**：可續行子先送出選定內容、後由 manager 產生**無條件** settle 通知——若兩者進不同 claim 優先 queue，#2600 的缺陷是後到 settle 可能反超先到子訊息（首步先 claim 完整 `next-step` 批、再取一個 `next-turn` 訊息）。固定 Steer 交付使：運行中父在同一個 `next-step` FIFO 收到子訊息 + 子後續 settle；子訊息先於 settle 的一致順序被保留；父在 maintenance 時 take `next-step` 輸入先於 queued turn。

## 4. 主線四：invariant 伴侶大清理（209→39）

官方註記：`.agents/notes/implemented/simplification/2026-08-28-omit-unneeded-invariant-companions.md`。

- **問題**：包的 invariant 規則要求每個 workspace 包發 `./invariant`，包括與運行時無關的包——209 個「explained-empty」伴侶，每個各帶源文件/公開導出/發布項/invariant-only deps or TS refs/建置/註冊測試，只為表達一個**否定結論**。`dsh-host-webserver` 伴侶更糟：在 plugin lifecycle 上註冊並 dispose 合成 reserved 路由，再用同一 service ops 探「殘留」——探針無獨立觀察，只是用**它要驗證的那套實現**去變動並檢查同一個路由表。
- **決策**：包只有在**能比較可能獨立分叉的觀察**時才發布 `./invariant`（跨事件生命週期/次序/身分/配對協議、事件 vs 權威可變狀態、多方 producer 組裝、被不同操作後消費的耐用資料…）。service/method presence、plugin metadata、fixed pure examples、以及**呼叫它正要比對的同一次 mutation 的 probe** → 留在 type/load/unit/integration test。無合格關係的包**省略** `src/invariant.ts`、`./invariant` 導出、`lib/invariant.js` 發布、invariant-only deps 與 refs、build entries、companion-only tests，並在**英/中 README 明示「不發布該伴侶 + 包級理由」**。`verify-package-invariants` 掃每包，要求英文 README 有省略理由。`dsh-time-context` 伴侶保留（比較 plugin 產生的 context 訊息 vs 獨立擁有的 current-turn user-message provenance + 耐用 event time——可獨立分叉）。
- **結果**：全庫審計移除 209 個 explained-empty 伴侶 + 合成 webserver probe，**留 39 個**有獨立觀察者。保留集含跨事件協議（session/command/approval/workflow/hook lifecycle）、事件對狀態（settings/storage-domain/workspace/client modules/slots）、多 producer 組裝（system prompt/time context）、耐用資料被後消費（todo/plan-mode/sandbox-mode）。`./invariant` 子路徑依 0.x 預發布相容立場移除。

## 5. 其他細節

- **版本 / 機械**：`package.json` `0.1.2-alpha.3` → `0.1.2-alpha.4`（根 + 55 包）；每包 README(.i18n/zh)、tsconfig、tsdown 大量「differs」但為版本串與伴侶清理。`snapshots`(62)、`docs`(60)、`apps`(60)、`scripts`(18) 變動。
- **web/UI 換版（佔檔案數大宗）**：`packages/client`（React，287 .tsx + `ui-*` 模組）816 個 modified；官方註記 `web-elevation-stroke-shadows`、`web-superellipse-corner-smoothing`、`simplification/css-produced-file-layout`、`simplification/web-remove-steering-interjection-caption`、`simplification/web-remove-hero-input-glow`（a3 期）——**皆視覺/CSS/編譯構建面**。對 IH 前端（尚未建）為遠期視野。
- **`shared-base-web-fetch-default`（feature，09-01）**：`packages/bundle/base/cordis.patch.yml` 掛 `dsh-tool-web` 帶 `fetch: true` + 60s search timeout；headless/全 SDK/ACP/自訂 base 概要都繼承 `web_fetch` + `web_search`（不再需要 app 層覆寫）。HTTP provider 允許匿名 `http:`/`https:` 到**驗證過的公共目的地**；fetch 在 shell/fs sandbox 或 approval 預設**之外**執行、無逐 call 審批；公共目的地驗證不阻止公共資料外洩。此註記部分超替 `2026-07-31-web-default-search`。
- **PTC preset 省略通用 workflow 工具（09-01）**：Web `ptc` preset 停用 `tool-workflow` row；其產出 SDK 省略 `workflow` 綁定，模型面 wire 只剩 `run_code`。保留 `workflow-worker-thread` 於工作流 realm（`tool-ralph` 同引擎）。Standard/Creator 仍曝 `workflow`；workflow 包與其 session 事件型別仍安裝、既存記錄仍渲染——這是**默認組成才變**，非功能移除。對 IH：IH 無 `run_code`/PTC，`workflow` 為靜態 YAML，**不適用**。
- **code-runtime-python（4 個 bug-fix，a4+）**：CPython 後端的 settle/framing/lifecycle、in-flight binding calls 限流 + binding metadata 快照、load-time `pythonBin` 驗證 + reply-drain settle、reply backlog 限流 + lone surrogate 計數。IH 無 Python code-runtime（`run_code` 不收斂），**低相關，僅紀錄**。
- **其餘 churn**：`typert`（44）、`util`（122：`dsh-brand`、`values`、`deque`、`time` 微調）、`shell`（114）、`llm`（96）、`context`（78）、`compaction`（66）、`interaction`（52）、`hooks`（36）、`sandbox`（38）、`storage`（34）、`subprocess`（30）、`schedule`（34）、`goal`（42）——多為機械性 + 承接 Session 位置語意的連鎖改動；`sandbox-windows-acl` 維持凍結（a1 已發布）。

## 6. 官方決策深讀：為什麼要把 Session 位置拆成兩個品牌

來源：`2026-08-31-session-sequence-and-log-offset-brands.md`（全文已讀，§1.3 決策 + Alternatives）。

**被否的替代**：
- **全部當 `number`**：身分、計數、游標頻繁跨 package/persistence seam；意外互換是遷移風險，不是區域算術便利。拒絕。
- **只用一個 branded Session 位置**：會再次讓 `eventCount` 或 `fromSeq` 被塞進「須為既存事件」處，且把 `-1`/`null` 哨兵塞進無關操作。拒絕。
- **從 `session/end-seed` 推繼承 cut**：該 marker 記錄的是構造生命週期、不只 fork lineage；且構造 seed 可能含繼承前綴之後的 child-owned 事件。拒絕。

**後果**：sequence 承載碼現在明確寫出一個數字是「事件」還是「空檔」。header-only reader 不開 body 即得穩定 lineage；persistence/projection/query/auth 路徑保留所需確切 cut。**v0 on-disk 格式公開數字 wire 不動**；代價是耐用與 wire parser 的顯式轉換 + body 承載觀察上的獨立確切 cut 欄位。projection-cache 身分含 lineage bit + 確切 cut，其 disposable storage domain 前進、舊列按需重建。turn/step/message-list 索引、workflow 序數、token 計數等**無關數字域保持普通數字**（它們不命名 Session 事件）。

## 7. 對 I-harness 的意義（分級）

| 等級 | 項目 | 判斷 |
|---|---|---|
| ✅ 記錄 | 版本機械 / invariant 清理 | IH 無此 invariant 系統（更精簡）；與 a3 相同的「無緊急項」延續 |
| ✅ 記錄（先前已確認） | 投射體系、win-acl 凍結 | a3 期已記錄；a4 無新變動，IH 維持對齊 |
| ⭐ 中期評估 | Session 位置語義（`SessionSeq`/`SessionLogOffset`） | IH 目前以普通 `number` 承載 `seq`（core-session）。品牌化是型別級防呆，能堵住「事件身分 vs 計數」互換的遷移風險；但 IH 較小、成本效益需實測。建議列入評估而非立即吸收 |
| ⭐ 中期評估 | Session 日誌讀取語意（`seq`/`eventAt`/`snapshotEvents`） | IH 的 `deriveMessages`/事件 log 存取是否隱藏整份拷貝需自查；若存在，可引此 API 讓物化成本顯式。先對照 IH 現有讀取模式再決定 |
| ⭐ 吸收（觀察） | 子代理 `send_message` 統一 + fixed Steer | IH 的 agent-team（roster/mailbox/task-board）+ `session-send`/`session-steer` 命令與 dsh 方向不同。dsh 的「**單一方向中性工具 + 固定 Steer + 同一註冊順序**」可作為 IH 子代理訊息的對照藍本；尤其「父子用同一工具、去掉不對稱 report」的設計可取 |
| 🟢 中期低優先 | `shared-base-web-fetch-default` | IH 的 `webfetch` 已是 fail-closed（僅 http/s + 截斷標記）。dsh 的「默認開啟 + 公共目的地驗證 + fetch 位在 sandbox/approval 之外」是姿態差異；IH 現法（默認較嚴）安全上不遜，僅「公共目的地驗證」概念值得納入 IH webfetch |
| ➖ 遠期/不適用 | web UI 換版、PTC 去 workflow | IH 前端未建；`run_code`/PTC 不收斂（B11 已定不做） |
| ➖ 不急切（低相關） | code-runtime-python 穩定性 | IH 無 Python code-runtime |

## 8. 方法與參考

- **方式**：雙樹唯讀 diff（無 git）。①`diff -rq`（排除 node_modules/dist/lib/build/coverage/.git）→ 分類 modified/added/removed 按 `/packages/<pkg>/` 聚合；②逐包 `src` 比對鎖定語義變更（session/subagent/session-query）；③`comm` a3 vs a4 `.agents/notes/implemented/*.md` 找出**新增**官方註記（14 個），全文精讀。
- **本倉庫對照**：`docs/research/2026-08-31-dsh-a1-to-a3-delta.md`（前一代）、`docs/research/2026-09-02-ih-sqlite-removal-study.md`（M29）、`docs/audit/2026-08-31-fiveway-comparison.md`。
- **a4 官方註記（新增）**：`architecture/2026-08-31-session-sequence-and-log-offset-brands`、`architecture/2026-08-21-session-log-read-intent`、`architecture/2026-08-27-adjacent-agent-steer-messaging`、`bug-fix/2026-08-17-subagent-message-settlement-ordering`、`bug-fix/2026-07-31-code-runtime-python-settlement-fixes`、`bug-fix/2026-08-29-code-runtime-python-{call-backlog-and-binding-metadata-snapshot,load-and-dispatch-hardening,reply-backlog-and-surrogate-count}`、`simplification/2026-08-28-omit-unneeded-invariant-companions`、`simplification/2026-09-01-{css-produced-file-layout,ptc-omits-workflow-tool}`、`feature/2026-09-01-{shared-base-web-fetch-default,web-elevation-stroke-shadows,web-superellipse-corner-smoothing}`。
