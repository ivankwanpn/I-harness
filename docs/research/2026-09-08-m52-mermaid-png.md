# M52 research — mermaid PNG rendering for the I-harness TUI

日期：2026-09-08 · 範圍：評估 README 遠期隊列項「mermaid PNG 評估」（README.md:215）· 基線：main `d7c1631` · 方法：只讀代碼 + 公開終端/套件資料（外部事實另標來源）· 結論：**不做（defer）**，理由與最小可行切片見 §3。

---

## 1. Current state — 今天的 mermaid 是「Unicode 方塊階梯」，不是圖

### 1.1 渲染器（純函式，無依賴）

`packages/tui/src/render/mermaid.ts`（模組頭 :1-19 是自帶規格）：

| 面 | 支援 | 證據 |
|---|---|---|
| 圖種 | **只有 `flowchart` / `graph`**；其他一切 → box fallback | mermaid.ts:100（`/^(flowchart\|graph)\b/i`）、:213-215 |
| 方向 | `LR/TD/TB/RL` **全部忽略**，永遠畫左→右階梯 | :5-7、:174-175 |
| 節點 | `A[text]` / `A((text))` / `A(text)` / `A{text}` / 裸 `A`（id 當文字） | :49-54、:56-63 |
| 邊 | 只有 `-->` 與 `---`；可鏈式 `A --> B --> C` | :65、:78-91 |
| 佈局 | **≤2 欄階梯**（rank 由 sources 最長路徑；偶 rank 左欄、奇 rank 右欄） | :139-160、:169-207 |
| 註解/空行 | `%%` 與空行忽略 | :94-104 |
| 文字 | 每格 clip 到 `maxWidth-6` + `…` | :40-45 |

**丟掉的東西**（全部走 fallback box `╭ mermaid: <word> ─╮` + 一行提示，mermaid.ts:164-166）：sequence/class/state/er/pie/gantt/journey/mindmap/timeline/quadrant/requirement/gitgraph/C4/sankey/xychart/block 等全部圖種；subgraph；edge label（`A -->|label| B` 直接 fallback，test/mermaid.test.ts:96-104）；`==>`/`-.->`/`o--o`/`x--x` 等邊型；classDef/style/linkStyle；rank>2 或任何 cycle（mermaid.ts:145-146）；過寬（:182-185）；不可解析行（:120）。**多於一欄的拓樸本身也會失真**——`one --> two, one --> three` 只是把兩個 target 疊在右欄（test:47-54），箭頭是裝飾（:192-193 註解自認「the edge topology already shaped the columns」）。

### 1.2 輸出去向（兩條路，都是純文字 run）

```
assistant block text
  → folding.blockRows(b, glyphs, width)            packages/tui/src/scrollback/folding.ts:42,48
      case "assistant": markdownRows(b.text, finished, width)
  → markdown.partRows(p, width)                    packages/tui/src/render/markdown.ts:46-55
      code-body + codeLang==="mermaid" + CLOSED → renderMermaidArt(code, width).lines
        → 每行一個 { text, style:"text" } run（無 codeBg）   markdown.ts:51-53
  → selectRows(b, state, glyphs, width)            folding.ts:86-95
  → layout wrap（Intl.Segmenter 原子）             scrollback/layout.ts:427,467（傳 this.width）
```

- width 由 layout 執行緒傳入（真實 wrap 寬）；無 width 的呼叫端用 `MERMAID_WIDTH_FALLBACK = 56`（markdown.ts:66-68）。
- 串流：**未閉合的 mermaid 圍欄是普通 code**（md_code_bg + 未高亮），``` 閉合那一刻才換成 art（markdown.ts:48-54；goldens test/mermaid.test.ts:116-131）。
- **fullscreen**：engine rows → CellBuffer → `flushRuns`；`sanitize()` 把 cell 文字裡所有控制位元組（<0x20、0x7f、0x9b-0x9f）**換成空格**（packages/tui-core/src/render/index.ts:57-66、:108-119）——任何 ESC/APC/OSC 圖像協議**不可能**走這條路。
- **minimal**：同一份 engine display rows → `displayToRegion`（minimal/commit.ts:26-30）→ `pendingDelta()`（:55-63）→ `paintRow` = `CUP + \x1b[0m + runs + \x1b[K`（minimal/inline.ts:227-246）→ `commit()` 整屏上滾（:305-320）。region 有 zero-byte 閘（`sig()`/`drawRegionBytes()` :331-351）。mermaid art 在此就是**一次印出的純文字行**，進原生 scrollback。
- **--attach**：backend 換成 remote SDK（apps/tui/src/index.ts:665-682），渲染仍在本地，art 照走同一條路。
- 測試現狀：unit goldens + markdown/engine 整合（test/mermaid.test.ts:11-62, 116-145）；**沒有任何 PTY case 覆蓋 mermaid**（grep 全 `test/harness/`、`e2e/` 無 mermaid）。

### 1.3 文件狀態

- M39 質量清單第 11 項 = 「mermaid — 規格留檔、跳過未實作」（docs/CAPABILITIES-DETAIL.md:663；docs/CAPABILITIES.md:11）。
- M40 G2/C12 交付 Unicode art + fallback box（docs/superpowers/plans/2026-09-04-i-harness-m40-gaps.md:8；README.md:198）。
- 仍掛在缺口：CAPABILITIES-DETAIL.md:698「mermaid 渲染規格留檔未做」；README.md:215 遠期隊列「mermaid PNG 評估」。
- 參考實作 grok 的 PNG UX（**不是** inline image）：`◇ mermaid [Open Image] [Copy Image Path] [Copy Source]` 動作行 + **離子進程**渲染（3s 超時）+ toast `Rendering diagram…`/`Could not render diagram` + 失敗降級 art（docs/research/2026-09-03-tui-grok-ui-spec.md:152）。該規格在 M35 就判「跳過 v1」（:260 item 23），inline 圖像另列 item 24「適配：Windows Terminal 無 graphics 協議 → chip + viewer modal + 協議探測降級」（:261）；blueprint 把 mermaid worker 定義為「子進程 + 真實可殺超時（不可信輸入隔離）」（docs/research/2026-09-03-tui-grok-blueprint.md:23），並把 mermaid PNG 放進跳過清單（:72）。
- grok 自己為了渲染 mermaid **vendored 了一整套 Rust 渲染棧**（mermaid-to-svg + dagre_rust + graphlib_rust + ordered_hashmap，docs/research/grok-build-research.md:43）——即使有自帶渲染器，它的 PNG 仍是「寫檔 + 動作行」，不是終端內嵌圖。

---

## 2. What "PNG" would require

先把兩件常被混為一談的事分開：**(R) 產生像素**（渲染器）與 **(T) 把像素送到使用者眼前**（終端協議或檔案）。兩者都貴，且互相獨立。

### 2.0 共同前置：渲染器（無一便宜）

mermaid 本體需要 DOM + SVG 量測（`getBBox`），jsdom 單獨**不可用**（外部事實：Saltcorn server-side mermaid 分析、Schemescape 系列文；NVIDIA PR #933 只拿 `mermaid.parse()` 做 lint）。可選項與重量（外部事實，2025-2026）：

| 選項 | 形狀 | 重量/代價 |
|---|---|---|
| `@mermaid-js/mermaid-cli` | Puppeteer + 釘死的 `chrome-headless-shell` | 下載 **~150–300MB**；cache 版本不符即 `Could not find Chrome`；官方 Docker 才用系統 chromium |
| `mermaid-isomorphic` | 名字騙人——Node 端用 **Playwright + Chromium** | 同級瀏覽器重量 |
| jsdom + polyfill（getBBox/CTM/ResizeObserver）+ `sharp` | mermaid-mcp 路線 | 仍 ~150–300MB 映像；gantt PNG 因 viewBox 0 寬而失敗 |
| 純 TS 重寫（`beautiful-mermaid`、`@speajus/mermaid-to-svg`）+ `@resvg/resvg-js` 光柵化 | 無瀏覽器，輸出 SVG（再轉 PNG） | 重量小，但**年輕、圖種覆蓋有限**，等於引入一個非官方 mermaid 實作；品質風險自負 |
| `mermaid.ink` / kroki 外部服務 | 零依賴 | **模型輸出（可能含私有代碼）離開本機** + 網路依賴 → 直接否決 |

本倉依賴政策：**通用公開庫可自由引入、私有庫禁入**（docs/superpowers/specs/2026-08-31-m28-design.md:4-5）——所以「重量」不是政策否決，而是**產品取捨**：一個 Windows 優先、離線可用的 TUI，為了一張圖拖一個瀏覽器引擎（或一個第三方重寫），換來的是「開外部檢視器」的體驗。

### 2.1 Option T1 — inline 終端圖像協議（kitty graphics / iTerm2 OSC 1337 / sixel）

**協議 × 探測欄位 × 本倉可觀測性**（probe 現有欄位見 packages/tui-core/src/types.ts:6-27）：

| 協議 | 支援終端（外部事實） | probe 能判斷嗎 |
|---|---|---|
| kitty graphics（APC `\x1b_G`） | kitty、Ghostty、WezTerm、Konsole、foot；**iTerm2 / Windows Terminal / xterm 不支援** | ❌ 無欄位；`cap.kitty` 是 **kitty 鍵盤協議**（types.ts:11-12、probe/index.ts:210-222），**不是** graphics——這是本項最容易踩的假閘門 |
| iTerm2 inline image（OSC 1337） | iTerm2、WezTerm、Konsole | ⚠️ 只能靠 `brand` 推斷（probe/index.ts:49-56 XTVERSION → "iTerm2"/"wezterm"），無正向查詢 |
| sixel | xterm、foot、WezTerm、Konsole；**Windows Terminal 1.22+（2025-02，隨 ConPTY 重寫）** | ❌ 無欄位；DA1 屬性 4 = sixel，但 `brandFromDa1` 只拿它當 xterm 提示後丟掉（probe/index.ts:67-73） |

**六個結構性障礙**（本倉代碼證據）：

1. **正規輸出路徑禁止控制位元組**：fullscreen 的 `sanitize()` 把 ESC 換成空格（tui-core/src/render/index.ts:57-66）。要發協議序列必須繞過 grid，走 `opts.write`（loop.ts:120）——即 `process.stdout.write` 原字節（apps/tui/src/index.ts:408-423, 793）。
2. **繞過 grid 會打壞游標帳本**：`CursorTracker` 是虛擬游標，renderer 只在「以為不在 run 頭」時才發 CUP（render/index.ts:76-79, 108-119）。圖像協議會真實移動游標（sixel 尤其）→ 下一幀錯位，直到整屏重繪。倉內唯一的 raw-write 先例是 `/doctor` 活探測，它**先掛起幀泵**才寫（loop.ts:897-917）——inline 圖像沒有這個餘裕。
3. **行高無法記帳**：scrollback 是行模型（Fenwick 前綴和 + 行級 wrap，layout.ts:128-189, 427/467；sticky prompt engine.ts:449-459）。圖像佔幾行、滾動後怎麼對齊，引擎完全不知道 → retain/搜尋/選區/粘性提示全部要新增「非文字行」概念。
4. **minimal 模式的 print-once 與 zero-byte 閘**：commit 是行級位元組流（inline.ts:305-320），region 有簽名零位元組閘（:331-351）。kitty 圖像能存活於原生 scrollback，sixel 捲動行為各異；而 minimal 是 M49 明文保證的「無終端結構」路徑（apps/tui/src/index.ts:509-516, 544-559）——圖像協議正是終端結構。
5. **多工器**：tmux 需 `allow-passthrough` + DCS 包裝且**不可靠**（slk 在 tmux 內強制半塊降級）；zellij 無 passthrough（外部事實）。probe 已有 `multiplexer` 欄位（probe/index.ts:253-256）可作閘門，但閘掉之後覆蓋面更小。
6. **探測本身要擴充**：kitty graphics 的正向查詢回覆是 **APC**（`\x1b_Gi=…;OK\x1b\\`）——probe 的 `scan()` 只解析 DCS/OSC/CSI（probe/index.ts:138-188），輸入解析器也只到 OSC/DCS（tui-core/src/input/parser.ts:157-165），**都沒有 APC 狀態**。要嘛加 APC 掃描（probe + input parser + 測試），要嘛只靠 brand 推斷（那就不叫探測，叫猜）。而 probe 的 500ms 截止是 M39 紅線（CAPABILITIES-DETAIL.md:658）。

**平台現實**：本倉 Windows 優先，主力終端是 Windows Terminal。WT **不支援** kitty graphics 與 iTerm2 inline image；sixel 只有 1.22+（2025-02 起）才有，且本倉無任何 WT 1.22+ 實測、probe 也偵測不到。也就是說：**在最主要的平台上，T1 要嘛不可用，要嘛無法可靠判定可用**。

**失敗模式**：無協議 → 序列被吞（什麼都不顯示，使用者以為壞了）或漏成亂碼；非 TTY/重導向 → 序列寫進 log；tmux/zellij → 破圖或無效；`--attach` 不影響協議（本地終端決定）但也不會更好；minimal 的 sixel 捲動不可控。

### 2.2 Option T2 — 外部渲染器 + PNG 檔案 + 動作行（**grok 的真實形狀**）

- 寫 PNG 到 workspace/temp → 動作行 `[Open Image] [Copy Image Path] [Copy Source]`（spec:152）或 toast 路徑。
- **終端無關**：WT、minimal、`--attach`、tmux 都能用；不碰 grid、不碰游標帳本、不碰 zero-byte 閘。
- **本倉已有 80% 的縫**：`/export` 寫 workspace 檔案 + toast 路徑（loop.ts:2967-2982）；`/transcript` 寫 temp + `cmd /c start` 開檔（:2984-3007）；`$EDITOR` 子進程往返（:2945-2965）。
- **缺 (a) 渲染器**（§2.0，這是全部成本所在）；**(b) 可用的剪貼板**：生產用 `SystemClipboard` 走 `navigator.clipboard` / `document.execCommand`（clipboard.ts:41-80），而 Node 22 兩者皆無（實測：`typeof navigator.clipboard === "undefined"`、`typeof document === "undefined"`）→ `copyChecked` 只能誠實回 `{ok:false, error:"clipboard unavailable…"}`，`Copy Source`/`Copy Image Path` 今天在真機上**是壞的**（除非先加 OSC 52 或平台工具後端）。**(c) 動作行面**：mermaid art 目前是 assistant block 內的行，不是獨立 block（folding.ts:42-58），要新增 block 切分 + 動作行 + 鍵/滑鼠路由（現有 action-row 機制不存在，grep 無）。
- 失敗模式：渲染器缺席/超時 → toast `Could not render diagram` + 降級現有 art（誠實、可測）；不可信模型輸出 → 必須離子進程 + 可殺超時（blueprint:23）。

### 2.3 Option T3 — 只有來源（無 PNG）

「Copy Source」/寫 `.mmd` 檔。零新依賴、零協議風險，但**不是 PNG**，且同樣卡在剪貼板（§2.2b）。可作為 T2 的降級階。

---

## 3. Cost/benefit + recommendation

### 3.1 成本對比

| 切片 | 新依賴 | 新代碼面 | 測試成本 | 覆蓋平台 |
|---|---|---|---|---|
| T1 inline（任一協議） | 渲染器（瀏覽器級或第三方重寫） | 探測欄位 + APC 掃描 + raw 輸出通道 + 行高模型 + grid/游標例外 | PTY oracle（@xterm/headless）**不解析** kitty/OSC1337/sixel → 螢幕斷言無效；runner 只記位元組數（test/harness/runner.ts:33-37,54-74），要斷言協議位元組得先擴 harness | kitty/Ghostty/WezTerm/Konsole/foot/iTerm2；**WT 僅 sixel(≥1.22) 且不可偵測**；tmux/zellij 破 |
| T2 檔案+動作行 | 同上（渲染器） | 渲染子進程 + 檔案 + 動作行 UI + 剪貼板後端（OSC 52） | 渲染器注入縫單元測試 + toast/降級 PTY case（**像素無法斷言**，只能斷言動作行與檔案存在） | 全部（含 WT/minimal/--attach/tmux） |
| T3 只有來源 | 無 | 動作行 + 剪貼板後端 | 同上（小） | 全部 |

### 3.2 建議：**不做（don't）**，把本項以本報告關閉

理由（依證據強度排序）：

1. **主要平台不支援**。Windows Terminal 無 kitty/iTerm2 協議；sixel 要 1.22+（2025-02）而 probe 偵測不到、本倉也無實測。T1 在主力環境等於「不確定可用」，違反倉規「不捏造、誠實降級」（README.md:216）。
2. **渲染器是真正的成本，且沒有便宜且成熟的路**。要嘛瀏覽器引擎（~150–300MB、版本脆、Windows 打包負擔），要嘛第三方 mermaid 重寫（年輕、覆蓋有限）。本倉政策允許公開庫，但這是**產品取捨**：為一張圖拖一個 Chromium，與 Windows 優先/離線/安裝器自包含（M45）相衝。
3. **T1 與現有架構正面衝突**：sanitize 紅線、虛擬游標帳本、行級佈局、minimal 零結構保證、PTY 零位元組/idle 紅線。這不是「加一個渲染器」的工，是「給 scrollback 加非文字行」的工。
4. **可驗證性不足**：PTY oracle 不解析圖像協議 → 唯一能證的只有「我們發了位元組」，而 harness 今天連位元組流都不記。硬做只會產出**無法證偽的宣稱**，正是本倉紅線最忌的。
5. **收益邊際**：grok 自己的 UX 也只是「開外部檢視器 / 複製路徑」（spec:152）——那不是內嵌圖，是檔案連結。而我們已有**即時、內嵌、零依賴**的 Unicode art（M40）。PNG 的邊際價值主要是「複雜圖種的保真度」，而那需要先有渲染器，成本不對稱。

### 3.3 若未來某輪非做不可：最小可行切片（條件式）

**只做 T2，不做 T1**：`◇ mermaid [Open Image] [Copy Source]`（**不承諾 inline、不承諾「PNG 已渲染」以外的東西**）
- 渲染走**離子進程**（blueprint:23 的不可信輸入原則）+ 3s 可殺超時 + `Rendering diagram…`/`Could not render diagram` toast + 失敗降級現有 art（spec:152 原樣）。
- 前置兩件必須先做：(a) 剪貼板後端（OSC 52 或平台工具），否則 copy 動作是死的（clipboard.ts:55-80 實測失效）；(b) mermaid block 切分 + 動作行 + 鍵/滑鼠路由。
- 文檔要寫死：「PNG 是**寫檔 + 外部開啟**，不是終端內嵌」。
- 測試：渲染器注入縫（假渲染器）單元測試 + 一個 PTY case 只斷言動作行/降級/檔案存在（**不得**聲稱像素驗證）；若要斷言協議位元組，先擴 `runner` 的位元組流。

**建議的第一步（若要省錢）**：先只做 T3（`Copy Source`），它不需要渲染器；但同樣等剪貼板後端。

---

## 4. Risks / honesty

1. **「支援 PNG」但只吐一個路徑**：grok 的 `[Copy Image Path]` 就是這個形狀（spec:152）。任何實作都必須在 UI/文檔說清「檔案 + 外部開啟」，不可寫成「terminal image support」。
2. **`cap.kitty` 不是 graphics**：它是 kitty **鍵盤**協議（types.ts:11-12、probe/index.ts:210-222）。用它當圖像閘門是最容易寫出「看起來對」的錯代碼。
3. **WT sixel 無法判定**：DA1 屬性 4 在 `brandFromDa1` 被當 xterm 提示丟棄（probe/index.ts:67-73）；DA2 只給 WT 品牌（`\x1b[>1;95`，:59）。在沒有 WT 1.22+ 實測前，任何「WT 可顯示 sixel」的宣稱都是猜測。
4. **把 base64 塞進 grid**：會同時打破 zero-byte idle 紅線（CAPABILITIES-DETAIL.md:653）、glyph-integrity（referee.ts:151-187：cell 文字不得含控制位元組、每行寬和必須 == cols）與 wrap 量測。任何這類做法都是假實作。
5. **PTY 證據造假風險**：@xterm/headless 不解協議；`assert-screen`/`assert-glyph-integrity` 對圖像**零可見性**。若某輪聲稱「PTY case 證明 PNG」，那是偽證——除非先擴 oracle/位元組流斷言。
6. **剪貼板連帶缺口**（本輪順帶發現）：生產 `SystemClipboard` 在 Node 下必失敗（clipboard.ts:41-80；Node 22 無 `navigator.clipboard`/`document`），所以今天 `y`/`/copy` 類操作在真機是誠實報錯。任何「Copy Image Path/Copy Source」切片都必須先解決它，否則是在壞掉的地基上蓋房。
7. **探測預算**：probe 的 500ms 截止 + 查詢集是 M39 紅線（probe/index.ts:26, 92-117）。新增圖像查詢（APC）不得讓截止失守；且 APC 需同時進 probe 與 input parser（parser.ts:157-165 無 APC 態）。

## 5. 外部來源

- Windows Terminal 1.22（2025-02-06 穩定版）sixel + ConPTY 重寫：https://github.com/microsoft/terminal/discussions/17809 · https://www.ntcompatible.com/story/windows-terminal-12210352-released · Warp issue #6412（ConPTY 對 kitty/iTerm 協議不識別，sixel 已 passthrough）
- 終端圖像協議支援矩陣（kitty/WezTerm/Ghostty/Konsole/foot；tmux `allow-passthrough` 不可靠、zellij 無）：https://github.com/Dicklesworthstone/frankentui/blob/main/docs/reference/terminal-compatibility.md · https://deepwiki.com/folke/snacks.nvim/4.1-creating-and-managing-windows · https://github.com/Yazelix/nova/blob/f99b9232/docs/terminal_emulators.md
- mermaid 需要 DOM/getBBox、mermaid-cli Puppeteer 重量、jsdom 不可用、純 TS 替代：https://wiki.saltcorn.com/view/ShowPage/server-side-mermaid · https://log.schemescape.com/posts/static-site-generators/diagrams-mermaid.html · https://deepwiki.com/mermaid-js/mermaid-cli/4.2-puppeteer-configuration-in-docker · https://www.npmjs.com/package/@speajus/mermaid-to-svg · https://github.com/pinely-international/vite-mermaid · https://lobehub.com/mcp/oleksii-honchar-mermaid-mcp
