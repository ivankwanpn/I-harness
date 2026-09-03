# M37 — `@i-harness/tui` 設計（app/view 層：scrollback 引擎 + 視圖 + keymap + backend 橋）

日期：2026-09-03 · branch m37（自 m36 出）· 源：`2026-09-03-tui-grok-ui-spec.md` §2–§4 §7–§8（1:1 複刻）＋ `2026-09-03-tui-grok-blueprint.md` §1–§3。**取捨（用戶 2026-09-03）：拆 M37a / M37b** —— 本輪執行 **M37a**（全屏主幹）；M37b 範圍見 §7。

## 0. 目標

M37 = 讓 Agent 會話在終端上「看得見、可操作」：以 **grok 版面 1:1 複刻**（UI 規格 §3 逐 widget）+ **零字節 idle 紅線保持**（M36 的 renderer 線路在 app 層繼續成立：app 畫進 cell buffer → commit → flush → pump）。後端零新面：TUI 是 SessionService 的另一個客戶端。

## 1. 包/App

```
packages/tui/               ← 新包（deps: @i-harness/tui-core workspace:* + @i-harness/session-executor
  src/app/                     + @i-harness/core-session + @i-harness/llm-mock (dev)）
    loop.ts               事件循環：input/backend/notify 三源 → Presenter 合併 → frame() → 30fps 有需才轉
    present.ts            Presenter：把 app state 渲染進 cell buffer（唯一繪圖點；過渡動畫 tick 有需才裝）
    keys.ts               keymap（UI 規格 §4 完整表 → handler 表；vim 模式門控）
  src/scrollback/         引擎：virtual_y 前綴和 + 可見窗口 O(dirty) + block 列表 + 動詞分組折疊
    entries.ts            entry 模型（user/assistant/thinking/toolcall-*/system/bt 事件 → 渲染規格 §3.1）
    layout.ts             virtual_y/prefix-sums/懸浮 sticky prompt 頭/時間戳右對齊
    selection.ts          選區（行/詞/單元三擊 + 拖拽 + 自動複製）
    search.ts             regex 搜索（反相高亮、n/N、計數）
    folding.ts            動詞組（◈ Read 2 files…）+ 摺疊（›/⌄/…N more）
  src/views/
    agent.ts              AgentView 佈局（§2.1 的 16 行→M37 版：status/turn/scrollback/prompt/shortcuts）
    status.ts             狀態欄（§3.3 左 cwd+git+sandbox；右 chips: tasks/plan/goal/mcp/context/queue/badge）
    turn-status.ts        TurnStatus 行（§3.4 spinner/標籤/計時/[stop]）
    prompt.ts             PromptWidget（§3.2 chrome/❯/info 行/ghost/占位/多行）
    shortcuts.ts          ShortcutsBar（§3.5 key: label / 雙擊確認 / compact）
    permission.ts         Permission modal（§3.7 行模板/範圍 ←→/RejectOnce 自由行）
    question.ts           Question modal（§3.8 1-9a-f + z 自由行）
  src/backend/
    client.ts            BackendClient 接口：listSessions/open/submit/steer/cancel/compact/
                         approvalRef/questionRef/liveEvents(AsyncIterable,seq 游標)/replayPage
    embedded.ts          embedded 實現：createSessionService + core-session subscribe()（16ms batch + seq）
  src/headless/           run -p（薄封 runHeadless——M38 再全制式）
apps/tui/                 ← 新 app：i-harness tui（embedded service + mock 默認 + --resume/--model/--yes）
```

視圖資料來源映射（§10 適配表）：todo→todo 事件、tasks→jobs/subagent 事件、context→token-meter、goal→goal 事件——M37 先做狀態欄 chips + turn status；**todo/tasks/queue 面板 + session picker + welcome + extensions/agents modal → M37b 或 M38**（視 Q1）。

## 2. 關鍵設計決策

| # | 決策 | 判定 |
|---|---|---|
| D1 | bridge 路徑 | **embedded-first**：`createSessionService`（session-executor）直接 import + `subscribe()` 流；SDK 子進程/_--attach 留 M38（wire 契約已凍，消費面不變） |
| D2 | 事件流 | liveEvents = core-session subscribe 事件 → **16ms batch 合併**（opencode/codex 教訓）+ session log **seq 游標** → 回放分頁；TUI 內嵌狀態以 seq 為一真相 |
| D3 | 渲染執行 | Presenter 每 tick 只重繪 state 差集（O(dirty) 在 scrollback 層；cell diff 在 renderer 層）——兩層 diff 各自成立，idle 幀 0 字節 |
| D4 | 動畫 | spinner/tick 有需才裝（capability-polling 屬性#10 的反面：僅當 spinner 在畫面上）；`frame()` 相同 → 0 字節 |
| D5 | keymap | §4 表 1:1（含 vim 門控 + VS 系 variants 為 config 選項）；M37 先覆蓋：scrollback 瀏覽組（j/k/L/H/g/G/PageUp/E/y）+ prompt 組（Enter/Shift-Tab/Ctrl-C 雙階段）+ 狀態組（Ctrl-T/B/Q/S/+C+P）+ permission/question（1-9/a-f/z/j/k/←→） |
| D6 | mock 驅動 | PTY 場景用 `llm-mock`（script-driven）——embedded assembly 的 modelBuilder 返回 mock；場景=腳本 step 表 |
| D7 | host proof | `apps/tui` 真終端演示是 M37 驗收的一部分（PTY harness case-011+）——不是可選 |
| D8 | minimal/Inline | **拆至 M37b**（用戶 2026-09-03）——M37a = 全屏主幹（scrollback 引擎 + 核心視圖 + keymap 主組 + embedded 橋 + apps/tui 首映 + case-011/014）；M37b = 互動覆蓋（permission/question、todo/tasks/queue panes、session picker、downloads）+ Inline 前向 + minimal + case-012/013 |
| D9 | 跳過項（§10 已決） | rewind/plan 審閱/credits/voice/memory/dashboard/mermaid PNG/shell 補全——UI 規格留檔，不複刻 |

## 3. scrollback 引擎不變量（M37 的核心）

- entry 列表為真相（事件流 append-only）；**virtual_y 前綴和**對每行 segment（wrap 行 = 連續段），O(log n) 翻頁/導航；可見窗口 = 行段索引範圍。
- 每次「窗口/內容」變化 → 影響的段集合（dirty）→ 重新排版該段；無關段**不重排**（O(dirty)）。
- sticky prompt 頭（pin+push fade）、時間戳右對齊 §3.1、動詞組折疊 §3.1（`◈ Read 2 files, Searched 1 pattern · 1 failed` 等）。
- block 折疊狀態：collapsed/expanded/truncated（agent tool 默認 collapsed、Edit 展開、bash `!` 運行截斷 first2/last3）。
- 選區/搜索：與窗口經緯一致的兩端（選區跨 wrap 行；搜索 regex 反相）。
- 不變量測試：N=1000 段的增量渲染——只重排 dirty；窗移動 O(log n); 滾動到頂/底/中、resize 後 reflow（段數不變，行數變化 → 重排僅受影響列）。

## 4. PTY 場景矩陣

**M37a 範圍**：

| case | 主題 | 斷言 |
|---|---|---|
| case-011 | **live streaming agent view**：mock LLM scripted turn（assistant 分段 + tool call + tool result） | 流式期間逐段畫出（grid 抽查）＋ 段間 idle **0 字節** ＋ 完成後整屏退出合規 |
| case-014 | resize 中流式：流中間 resize×4 | 字形完整性 + 無段錯位 + idle 零字節 |

**M37b 範圍**：case-012（prompt input + keymap）、case-013（permission modal）。

## 5. 驗收

- `pnpm -r test` 全綠（tui 新套件 + 全倉）；`pnpm typecheck` 0；e2e 11/11
- PTY：case-011..014 綠（真終端、零字節、resize 不變量）
- `apps/tui` 真終端首映：mock 會話流式顯示（手動 smoke）
- README M37 行 + CAPABILITIES tui 增量；後端零改動（唯 tui 包連線）

## 6. 非目標（M37a）

- interaction 覆蓋 / panes / dropdowns / session picker / welcome（M37b）；Inline/minimal（M37b）；/minimal、/tui 命令（M38）；markdown checkpoint（M38 用庫+自建）；高亮（M38）；headless full（M38）；mermaid/圖像查看器（M38+）；rewind（後端無——跳過）
- 後端任何新面；--attach 遠程模式（M38）

## 7. M37b 範圍預覽（下一半輪）

- interaction：permission modal（§3.7）/ question modal（§3.8）/ plan chrome（適配版；審閱面跳過）/ cancel-turn（§3.11）
- panes：todo（§3.12）/ tasks（§3.12）/ queue（§3.12）/ /btw（§3.12）
- dropdowns：slash（§3.6）/ completion（§3.6）/ history（§3.6）/ file-search（§3.6）
- session picker（§3.12）/ welcome（§2a welcome 佈局）/ dashboard 跳過
- **Inline 前向引擎 + minimal live region（print-once 狀態機）** + mode 切換
- PTY case-012/013 + 擴大場景矩陣（手勢/鍵表部）
