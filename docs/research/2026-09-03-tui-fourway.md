# TUI 四路研究與 I-harness 選型報告（2026-09-03）

日期：2026-09-03 · 方式：三路並行唯讀深讀（opencode / codex / grok-build + cc-custom），文件級事實 + 每家的「做法/優劣」評判。

**樹**：opencode `D:\agent-complete\opencode-fork-private-999.0.15`（packages/tui）、codex `D:\agent-complete\codex-rust-v0.149.1\codex-rs`（tui/）、grok-build `D:\opencode-bugfix\grok-build-main`（`xai-grok-pager`）、cc-custom `D:\opencode-bugfix\cc-custom`（`src/screens/REPL.tsx` + `src/ink/`）。dsh 無終端 UI（web/client 生態）——不納入。

## 0. 結論先行

- **四家三個範式**：①React-for-terminals 渲染（opencode=SolidJS+OpenTUI；cc-custom=自 fork Ink）②Rust ratatui 自訂（codex、grok）③混合（cc = 主屏 REPL + 選用 AlternateScreen fullscreen）。
- **架構最佳 = codex**（actor loop + **提交到原生 scrollback** + 每格 diff + 三種 server target）；**產品/生態最佳 = opencode**（生成式 SDK 契約全端共享、16ms batching、viewport culling、插件槽位）；**工程細節最佳 = grok**（minimal 雙模式、rewind、輸入降級）；**最適合 IH 複用 = cc-custom**（同語言 TS/ESM、進程模型與 IH 契約契合、藍本完整、Windows 實戰）。
- **IH 選型建議（見 §4）：以 cc-custom 路線起步**——默認**主屏滾動 REPL**（Ink 家族）＋ 選用 AlternateScreen fullscreen；scrollback 性能模型（codex 的「提交即寫入原生滾動」= cc 默認主屏模式）天然兼得。

## 1. 四家機制對照

| | 渲染框架 | 事件循環 | 視圖/流 | 終端策略 | 性能特招 |
|---|---|---|---|---|---|
| **opencode** | SolidJS + **@opentui/core**（Zig 原生、Yoga flexbox、OptimizedBuffer diff） | OpenTUI 原生 60fps 循環 + 自訂 keymap | 2.7k 行 session 視圖 + 全套 dialog/panel；**插件槽位**（12 槽） | alt-screen + kitty keyboard + mouse hit-grid | **16ms 事件合併 + Solid batch + viewport culling + 增量 markdown（marked+tree-sitter WASM）** |
| **codex** | Rust **ratatui 自 fork**（每格 diff `diff_buffers` + SynchronizedUpdate） | 單 actor `tokio::select!`（4 流）+ 120fps FrameRequester 合併 | ChatWidget 視圖組件化（`history_cell/` 12 種、`exec_cell`、`bottom_pane` 12.8k） | **提交到原生 scrollback**（`insert_history` + Zellij/WT 特判）+ resize reflow | scrollback 提交（長對話不重繪）、pulldown-cmark newline-gated 增量、syntect+two-face |
| **grok** | Rust **ratatui 自訂**（xai-grok-pager，部分元件 extract） | `tokio::select!`（終端/ACP/任務/動畫/config watcher） | AgentView+ScrollbackPane+PromptWidget+StatusBar；modal/permission/rewind（1543 行） | alt-screen + **minimal 模式**（paint-once 原生 scrollback） | minimal 雙模式（IoC 縫）、pre-fire 精神、mermaid 外進程 |
| **cc-custom** | **自 fork Ink**（React for terminals；cell-diff renderer + 自帶 ANSI 解析器） | Ink reconciler + raw-mode keybinding | REPL 4677 行 + PromptInput + StatusLine；fullscreen 可選 | **默認主屏滾動**（消息進原生 scrollback；bottom 一行 prompt）；`/tui` 選用 AlternateScreen | 主屏滾動天然零重繪；fullscreen ScrollBox+virtual scroll+“N new messages” |

## 2. 數據流（UI↔後端）——四家異同

| | 進程模型 | UI 消費面 | 重連/回放 |
|---|---|---|---|
| opencode | CLI 起 **daemon**（HTTP+SSE），TUI 連接其 URL | 生成式 SDK `OpenCode.make()`；`events.subscribe`（SSE async iterable）+ **本地 sync/data store**（Solid createStore，16ms batched eventChannel + `batch()`） | 事件 `durable.seq` 游標 → gap 時 `history({after})` 分頁回放 + `rebuild()` 全刷 |
| codex | **三種 target**：Embedded（in-proc）/ LocalDaemon（unix）/ Remote（WS+JSON-RPC） | 全部 `thread/*、turn/*、item/*` 型別請求 + `AppServerEvent` 路由到 **per-thread replay 緩衝（32768）+ Coalescer（256KiB/4KiB）** → ChatWidget protocol 開關（~40 通知） | replay buffer + `ThreadEventStore`；resume 走 rollout（`excludeTurns` 回退） |
| grok | **in-process ACP 通道**（`AcpClientChannel` 背景線程）+ leader bridge（多進程、`leader` IPC→ACP 適配） | ACP session updates（`session/load` + `eventId` 游標）→ `handle_update` | `session/load` cursor 重連接 + shell replay buffer；rewind 經 UI 調 shell |
| cc-custom | 同進程（replLauncher 直接跑 QueryEngine） | stream projection（`useAssistantStreamProjection`）+ READ 方式消息通知；主屏 append | 終端會話無網格；無 daemon 模式 |

## 3. 「哪個做得好」——評判

1. **架構清晰度：codex 勝**——單 actor 分離（UI 事件/後端事件/per-thread channel/通知四流 select）、「提交到原生 scrollback」使長對話重繪成本恆定、每格 diff + 120fps 合併、三種 server target 用同一個 `AppServerEvent` 面——**這是「後端已是 daemon/service」的範式示範**（與 IH 的 web-host 完全同構）。
2. **產品/生態：opencode 勝**——生成式 client 契約（server/web/tui 共享）、插件槽位（12 個 slot + 插件 API）、主題（33 內建 + JSON 自訂 + 字體）、增量 markdown 的 in-place 重排——給第三方擴展的完整性最高；代價是 @opentui 的 Zig 原生依賴重。
3. **工程細節：grok 勝**——minimal 模式（paint-once）作為「快/穩」的降級面、rewind 視圖、bash 拼合高亮、prompt widget 自訂——xAI 團隊把「做完了再精修」推到更高。
4. **「對照 IH 的後端」**：三家 full-screen TUI 都要求「後端服務/進程是長壽 daemon、事件流訂閱、resume 回放」——**IH 的 C 區（SessionService + WS mux + live stream + seq 回放 + `session-compact` 命令）正是這四家 UI 的消費面**——後端完整度確實足夠開 UI（用戶判斷成立）。

## 4. IH 選型建議

### 4.1 路徑（三階段，最低風險先行）

1. **M35a：主屏滾動 REPL**（cc-custom 默認模式為藍本）——TS/ESM 內嵌：Ink 家族（或自 fork 最小 Ink，如 cc 已驗證的做法）；事件流 = 現有 mux/SSE live stream（16ms batch，學 opencode/codex 的合併）+ `session` 分頁事件；提交 = 直接輸出到主屏滾動（**= codex 的 scrollback 模型**）；底部一行 PromptInput（多行、斜槓、history）+ StatusLine。
2. **M35b：選用 AlternateScreen fullscreen**（`/tui on|off` 模式，cc 藍本）——ScrollBox + sticky prompt + unseen divider + virtual scroll。
3. **M35c（可選，依產能）：** 升級到 OpenTUI（Solid）或重新評估 ratatui 移植——以插件槽位/原生性能為收益門檻。

### 4.2 技術選型裁決

| 選項 | 判斷 |
|---|---|
| **Ink 家族（react-ink/或 cc 式自 fork）** | ✅ **選定**——TS/ESM 同語言、cc-custom 實戰證明 Windows 穩定；主屏滾動與 fullscreen 雙模式已有完整藍本；IH 可用現成 react-ink（通用公開庫,依賴原則允許）而**不用自 fork**（cc 是歷史原因——它們需要自家 ANSI/擴展,TUI 我們可以精簡邊界） |
| OpenTUI+Solid | 延後——Zig 原生依賴重、收益在「插件生態」，一階不需 |
| Rust（codex/grok 路線） | 排除——跨語言打破 IH 純 TS 原則 |
| 自家裸 ANSI | 排除——重造輪子 |

### 4.3 對接面（IH 已定形——直接消費）

- **進程模型**：`i-harness tui` = 在 process 內建 SessionService（同 `sdk`/`acp` 模式——**三種 target 的 embedded 版**,codex 同構）；`--attach` 遠程模式留 M35c
- **事件流**：session live stream（WS mux 或內嵌 event bus）+ **seq 回放**（resume 網格——學 opencode 的 durable-seq 游標 + codex 的 replay buffer）
- **交互**：`session-prompt`/`session-steer`/`session-compact`/`session-cancel`(既有命令面) + approval/question（mux approval 快路——permission modal 藍本 opencode/grok）
- **UI 狀態**：session list(title/archive)、todo/jobs/goal/feedback surface(catalog + fold 端點)——**IH 的 E 區正是 TUI 側欄原料**

## 5. 參考
- 本報告四家源（§0 樹）；IH 側：`docs/CAPABILITIES.md`（C 區契約——TUI 消費面）、`docs/contracts.md`（sdk wire/命令）、`packages/web-host`（mux/live/approval→TUI 的註冊對接點）。
- 前代：`2026-09-02-compact-fourway.md`（方法論沿用——執行者驗證→綜合→吸收）、`2026-08-31-fiveway-comparison.md`（C 區「前端下一階段」的證明）。
