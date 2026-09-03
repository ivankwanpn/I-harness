# I-harness TUI：grok-build 複刻藍本 + 技術選型（v2）

日期：2026-09-03 · 方式：grok TUI 工程深讀（`xai-grok-pager` 630 文件/`scrollback/render.rs` 4512 行/`app_view.rs` 10727 行/PTY harness）→ §1 屬性清單 → §2 TS 可行性矩陣 → §3 IH 架構分層 → §4 路線。**決策基調（用戶 2026-09-03）：複刻 grok 的工程（架構與質量），不複用其棧；技術選 IH 自己的（TS/ESM，通用公開庫可用，私有禁入）。**

## 0. 一句話

grok TUI 的工程是「**零字節 idle + 原生滾動雙模式 + O(dirty) 虛擬化 + 檢查點流式 + 離子進程隔離 + PTY 屏幕級回歸**」——這套屬性與語言無關，可在 TS 上複刻；付出點在**自研 TS cell 渲染器**（約 2–3k LOC），其餘用通用公開庫 + 自建狀態機。

## 1. grok 證明的 12 項工程屬性（複刻清單）

| # | 屬性 | TS 落地 |
|---|---|---|
| 1 | **兩緩衝 cell diff + 幀級「零字節 idle」**（無變化幀＝輸出 0 字節——最大單項性能收益） | 自研 renderer 核心（必做） |
| 2 | **獨立 writer 線程**（慢終端背壓不卡事件循環；sequence ack 做 in-flight gating） | Node worker/隊列（自做，易） |
| 3 | **單一 teardown 位元組序**（quit/panic/signal 共用；永不重發） | 自研 terminal 模組 |
| 4 | **首信號優雅/次信號強殺** + 終端恢復後才 flush telemetry | 自研 signal 模組 |
| 5 | **屏幕模式政策**：CLI > config > auto 啟發（Zellij→inline、tmux control-mode→inline、破損終端→auto-minimal） | 自研（可複製判斷） |
| 6 | **終端能力上下文**（一次探測、全局查詢：brand/multiplexer/kitty/color-level/XTVERSION/mouse-leak） | 自研 probe（部分可用庫） |
| 7 | **虛擬化 + 佈局快取 + O(dirty) 增量**（`virtual_y` 前綴和 + dirty id 集；選區/貼上兩端） | 自研 scrollback 引擎（必做） |
| 8 | **檢查點流式**（markdown 僅尾重渲染；minimal print-once 前沿狀態機——提交後不可變） | 庫解析 + 自建 checkpoint 狀態機 |
| 9 | **時間分片工作**（`/transcript` 8ms pump——UI 線程協作） | 自做（易） |
| 10 | **能力輪詢 dirty**（scrollback/spinner/mermaid 各回「needs repaint」；idle 不裝 tick） | 自做 |
| 11 | **不可信輸入子進程隔離**（mermaid: 子進程+真實可殺超時——`panic=abort` 使 catch_unwind 無效） | Node child_process + kill（TS 手做） |
| 12 | **PTY 屏幕級 e2e**（腳本化場景 + 手勢矩陣 + 不變量裁判） | **IH 可行**：node-pty（已有！）+ xterm.js(headless 虛擬屏) + YAML 場景 |

## 2. TS 可行性矩陣（Rust 專有機制的落地）

| grok 的 Rust 機制 | TS 判定 | 說明 |
|---|---|---|
| ratatui **cell buffer+diff** | **自研**（800–1200 LOC 核心） | 無 TS 現成；可引小庫做 ANSI 輸出/解析（`ansi-escapes` 類），grid+diff 自寫（屬性#1 的核心） |
| inline **viewport+`insert_before`** | **自研**（escape 序工程：CSI S/T、`CSI J`、滾動區域、resize 邊角） | 0 庫支持；TS 要擁有其狀態機與邊角（grok 提過的 grow-vs-shrink、tmux 全清垃圾） |
| **syntect tmTheme 可復用高亮** | **庫 + 自建**：highlight.js/shiki 通用；重掃「可復用 open-block 增量 + 極性安全映射」 | 演算法照 grok（polarity-safe ANSI16） |
| `panic=abort` 子進程隔離/self-relaunch | **自做**：child_process（kill+計時）；Windows 的 spawn+wait 習語（sleep 150ms 讓父讀者收手,曾「立刻 spawn-exit」災難）；`SIGPIPE` 忽略繼承–TS 用 `process` 繼承屬性 | **抄 grok 的實地教訓** |
| `tokio::select!` biased 循環 | **自做**：Node 事件循環移植（輸入讀者線程自隊列、動態 deadline 計時器、$EDITOR/$PAGER suspend 握手:停讀者、drain writer 750ms、復位探測） | 屬性#2/#3 支撐 |
| **nucleo 守護 + 寬度** | **庫+自做**：`fuse.js` 或候選分數器放 Worker；**unicode-width 語義必須 vendor**（`string-width`/自實現 wcwidth——JS 的 `Intl.Segmenter` 無終端列寬） | 寬度是硬依賴 |

**TS 可直接引用的通用庫**：markdown 解析（marked/remark——checkpoint 自建）、語法高亮（hljs/shiki）、ANSI 部分解析、wcwidth、fuzzy（fuse.js）、xterm.js（僅 test harness 虛擬屏）、node-pty（已有——harness）、yaml 場景。

## 3. IH 架構分層（複刻 grok 的 crate 劃分）

```
packages/tui-core/          ← M36（renderer 層）
  src/render/               cell grid + 2-buffer diff + flush_with(links) + CursorState 去重（零字節 idle）
  src/input/                raw key stream + 解析 + kitty + paste + focus + mouse leak 探測
  src/terminal/             init/teardown 唯一序列 + 能力上下文（brand/multiplexer/color-level/XTVERSION）+ signal 雙級
  src/screen-mode/          Fullscreen/Inline/Minimal 政策 + 破損降級；Inline = viewport+insert_before 前向引擎
  src/output/               writer 通道（sequence acks）+ suspend 握手（$EDITOR/$PAGER）
  src/theme/                量化 + 極性安全 ANSI16 + OSC11 啟動探測
  test/harness/             xterm.headless + node-pty 場景矩陣（screen 斷言 + 手勢裁判）
packages/tui/               ← M37（app/view 層）
  src/app/                  事件循環（input/backend/notify 三源 + Presenter 合併 + 30fps 動畫 tick 僅有需）
  src/scrollback/           virtual_y 前綴和 + dirty id 集 + 選區/搜索/sticky/Turns（複刻 4512 行模組的責任）
  src/views/                agent view / prompt widget / status bar / slash reg（builtin+ACP 兩bit 完整性）/ permission 隊列(front-only)/ modal / plan approval / completion dropdown / history search(worker) / rewind（prompt_index↔entry）
  src/minimal/              print-once 前沿狀態機 + forward 修復 + full_view /transcript pump + $PAGER 交回
  src/backend/              IH SessionService 橋（內嵌同 sdk/acp；--attach 遠程 mux 客戶端）：
                            事件 = live stream（十六 ms batch + seq 回放游標 + history 分頁）
                            交互 = session-prompt/steer/compact/cancel + approval/question 快路 + jobs/todo/goal 側欄
  src/headless/             run -p（與 grok headless 同構——IH 已有 sdk,薄封）
```

## 4. 路線與優先序

1. **M36 `tui-core`**（基礎，決定命運）：cell renderer +input+teardown + Inline(insert_before 前向)` + capability probe + **PTY harness 首例**（屏幕斷言）。門檻：idle 零字節測試 + resized/滾動不變量
2. **M37 `tui` 主體**：scrollback 引擎（virtual_y/O(dirty)/selection/search/sticky）+ minimal 視圖堆（scrollback/prompt/status/slash/permission/modal）+ backend 橋（內嵌 service + 事件流 batch + 回放）+ rewind
3. **M38 全屏 polish**：fullscreen 模式與 policy、markdown checkpoint 增量、高亮極性安全、mermaid worker、`/tui` 切換、主題、headless
4. **M39 質量**：腳本化場景矩陣擴大 + benches + `GROK_FPS`-式 HUD + memory release（大 transient 釋放）

## 5. 決策（對 IH 原則的綁定）

- **複刻（照工程屬性）不複用**：自身引入 grok 的 12 屬性；不引它的 crate/棧。
- **通用公開庫允許**（依賴原則——m36 確認可用：markdown/hljs/fuse/wcwidth/xterm.js；**禁止**：私有/供應商）。
- **「零字節 idle」與「minimal 打印即定」為品質紅線**（不做 = 不如做 REPL）。
- **對接 IH 後端**：TUI 是「SessionService 的另一個客戶端」（同 sdk/acp 的形狀）——**無新後端面**；`--attach` 遠程沿用 mux+auth。
