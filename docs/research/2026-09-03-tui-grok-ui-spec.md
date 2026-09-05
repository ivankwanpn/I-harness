# I-harness TUI：grok-build 界面 1:1 複刻規格（UI/UX 提取）

日期：2026-09-03 · **方法附註（2026-09-05）：新版 grok TUI（D:gent-complete\grok-build-main，xai-grok-pager 0.2.106+倉：xai-grok-pager/{src,bin,render,minimal,pty-harness}）已深讀並實跑驗證——本文為舊版基線；**新版為當前複刻真源**（鍵表 §4 已過時：Ctrl+S=stash、F3=sessions、Ctrl+G 模式拆分、Ctrl+B=送後台、Ctrl+R=mouse-reporting opt-in；slash 70 條見新註冊表；settings 8 分類；mouse 5 模式 + 點擊/拖拽/懸停全語義——詳見 docs/research/2026-09-05-grok-tui-*（delta + live-observation））。舊版差異以 delta 研究為準。

+ 方法：grok TUI 全源深讀（`xai-grok-pager` `app_view.rs` 10727 行 / `views/*` / `scrollback/*` / `render/theme` / `render/glyphs` / `xai-ratatui-*` / `xai-grok-pager-minimal`），逐 widget 提取視覺事實（file:line 佐證）。**用途**：讓「UI 1:1 複刻」有唯一規格源——照本再造，而非重讀 Rust。

> 決策基調（用戶 2026-09-03）：界面**一比一複刻** grok build 的 TUI；後端沒有的功能**不複刻**（見 §10 映射表）；目的——讓我們後端（SessionService）有一個工程品質最高的前端界面。

## 1. 屏幕模式與頂層視圖

- **兩種渲染模式**：`fullscreen`（alt-screen TUI，默認）與 `minimal`（scrollback-native，實驗性——終端原生滾動存歷史，僅繪「live region」）。`screen_mode` 在 config.toml / `--minimal|--fullscreen` CLI；粘性（plain `grok` 重開上次模式）；`/minimal` `/fullscreen` 斜杠命令原地重啟同會話。
- 頂層視圖（`ActiveView`）：`Welcome` / `Agent(id)`（AgentView）/ `AgentDashboard`。

## 2. 佈局樹（AgentView 全屏——自頂向下行組，gap 僅當 `outer_vpad>0`）

固定次序（每行 `Length(n)`；scrollback `Min(5)` 永不餓死）：

1. **狀態欄** — `Length(1)`（真實頂行，非 overlay；命中測試 + 右對齊 chips）
2. StartUp 警告（默認 0）
3. 任務面板（bg tasks）— `[gap 1] + Length(tasks_h)`；子代理全屏視圖下壓為 0
4. 子代理目錄面板（catalog）— 同上
5. Todo 面板 — 同上（max 10 行 / 15% 高）
6. **Scrollback** — `Min(5)`
7. `/btw` 面板 — `[gap 1] + Length(btw_h)`
8. Queue 面板 — `[gap 1] + Length(queue_h)`
9. **Turn status 行** — `[gap 1] + Length(1)` 條件顯示
10. Banner 行（模式切換/公告/tip）— 條件顯示
11. Plugin CTA 行 — 僅 CtaPhase::Matched && prompt 非空；**高度 ≤16 行時強制 0**
12. Follow-up chips 行 — 同上 16 行抑制
13. Prompt gap（0 或 1）
14. 語音錄製行（`Length(1)` 僅語音時）
15. **Prompt 區** — `Length(prompt_height)`（max = 屏高/2）
16. **快捷欄** — `gap(1) + Length(1)`

外框 chrome：`Block`，padding `h_left=2, h_right=2, top=1, bottom=1`（默認）。**Compact**（用戶設定或 `terminal_rows<=20` 自動）：vpad 0、hpad 1；`terminal_rows<=16`：CTA/follow-ups/shortcuts gap 全坍縮。
**Prompt 槽替換優先序**（有 overlay 時）：permission > question > rewind > jump > cancel-turn > 正常 prompt。Scrollback 搜索激活時 scrollback 矩形下縮 reserved rows 視窗。

**Scrollback 水平結構（每 entry）**：`[accent 1] [pad 2] [content flex] [pad 2]` —— 1 列左強調軌 + 2 列內邊 + 內容 + 2 列右內邊；選區框在兩側 padding 內 1 列。最右 **scrollbar 列**（`scrollbar_x = right - 1`）；**時間線軌**（2 列）替代 scrollbar：需 `show_timeline && !subagent && width>=60 && turns>=2`。

**Minimal 模式 live region**（content-anchored，非底部釘住）：`[live tail · todos · /btw · status(1) · overlay/info · prompt]`——最小 2 行 = status(1)+prompt(1)；默認 live 行 10（clamp 3..min(term_h-1,3)? ceiling = term_h-1, max 3? 規格：`base = live_rows.clamp(3, ceiling)`）；prompt 永遠是 live region 底行且恆聚焦；prompt 之下為 dropdown overlay 或 1 行 info bar（`model · flag · flag · context · queued · /transcript hint`，` · ` 連接）。

**Dashboard**：`top_margin(1)+header(1)+gap(1)+list(flex)+peek+gap(1)+dispatch box(text_rows+2 border)+gap(1)+footer(1)+bottom_margin(1)`；dispatch 輸入為 `╭ ❯ Dispatch a new agent ╰─ dispatch ╯` 邊框 PromptWidget。

**Welcome**：`[top_pad][error][gap][hero box centered ≤120][tip][gap][prompt 3 行][VERSION_GAP][version row]`。Hero 圓角邊框（border = blend(bg_base, gray_dim, 0.45)），logo 左 + 版本/菜單右；<90 列轉縱向。副標 `"Thanks for trying Grok Build, give feedback with /feedback!"`；內信息位 = 公告（優先）或 Changelog 塊（` • ` 子彈）。菜單鍵：`ctrl+i [x] Import Claude settings`、`ctrl+w New worktree`、`ctrl+s Resume session`、`ctrl+q`/`ctrl+d` Quit。

## 3. Widget 逐規格

### 3.1 ScrollbackPane

不變量：`ViewMode::SingleTurn|AllTurns`；**sticky prompt 頭**（pin/push、fade 至 opacity visible/(full+1)）；選區框 `┌┐└┘│`（被剪裁用虛線 `┆`，右上 `[✗]`）；跟隨時 scrollbar 拇指 40% 混向 track。每 entry：強調軌 `┃`（跑動中波浪動畫——亮度波）、2 列 pad、子彈 `◆`（可用 `❙` 摺疊槽/`◇`/`◈`）、內容、2 列 pad。

| Block | 默認 | 結構 |
|---|---|---|
| UserPrompt | 展開（>3 視覺行→Collapsed 3 行+` …`） | `❯ ` 前綴（bash `$ ` / cron `↻ `）；換行縮進 2 空格；文本 text_primary；整塊 bg_light 帶；斜杠 skill 詞 token 高亮 accent_skill；前綴恒 accent_user |
| AgentMessage | 展開 | 無強調軌、無子彈；markdown 全渲染（h1-h6/粗斜下劃線/列表 ` • `/blockquote `│ `/hr `───`/表格 box art/代碼塊 bg md_code_bg） |
| Thinking | 摺疊 | 運行 `Thinking…`；完成 `Thought for {X.1s\|Xm Ys}`；截斷 = 頭 + `…` + 末 3 行 0.7 混向 bg；運行中強調波浪；accent=gray_dim |
| Execute | 摺疊（agent）；運行中 `!` bash → 截斷 | 頭 `Run [(user) ]{description}`（可 `$ ` 風格）；accent 錯誤紅/運行波浪/成功綠；輸出 first2/last3；子彈 `◆` |
| Read | 摺疊 | `Read {path} ({start}-{end})` |
| Edit | 展開（diff） | hunk 刪除 bg diff_delete_bg + 增 bg diff_insert_bg，fg 對應色；分隔 `…`；摺疊頭 `+N/-M` |
| Search | 折疊 | `Search {pattern} ({N} matches)` |
| WebFetch / WebSearch | 摺疊 | `Fetch {url} ({N} chars)` / `Search web for {query}` |
| Skill | 摺疊 | `Invoke {skill}…` |
| System | 摺疊 | 無強調/不可選/可分組、muted |
| 其他 | 摺疊 | `Call {name}` |
| BgTask/Subagent | | `Started/Completed/Failed {label}`-ish |

**動詞分組**：連續非破壞性 tool call 摺疊為單行：`◈ Read 2 files, Searched 1 pattern, Listed 1 dir · 1 failed`（失敗 accent_error）；截斷頭 `◈ N more` / `▾ N tool calls & thoughts`。展開指示：選中/懸停摺疊行子彈換 `›`（展開組 `⌄`）。時間戳（如有）：首行右對齊 10 列，懸停 `  %H:%M:%S | %b %d` 否則 `  %-I:%M %p`。搜索高亮：regex 匹配每可見行反相。懸停：bg blend(bg_base,bg_dark,0.5) 內縮 1 列 + chevron 換（markdown 除外——用懸停邊框）。

### 3.2 PromptWidget（chrome=true）

chrome：左 `┃` 強調軌（可關）；頂 `╭───╮` 框內**右對齊會話標題**；每行側邊 `│`；底 `╰───╯` 內嵌 **info 行**。
- 首行前綴 `❯ `（accent 色）；歷史搜索模式換 `? `；呼叫者覆蓋：bash `! `（黃）、反饋 `● `、評論 `● `。
- 文本區：slash token 高亮 accent_skill（青）；ghost：slash 參數 gray、`/cmd` 補全 ghost gray、shell 建議 **dim italic**、預測下一 prompt ghost。
- 空+未聚焦占位符：**`"Build anything"`**（覆蓋：`"Type your comment..."` / `"Type your feedback..."`）。
- Info 行：左 ` model_name · flag · flag `（` · ` 分隔）；flag 配色 plan/plan approval/commenting → accent_plan、always-approve 默認、auto → accent_system；右 `multiline` 標記 + 用量警告（`"5% usage left"` warning/dim）。
- 未聚焦：內容 0.66 混向 bg；邊框 prompt_border vs prompt_border_active。
- 圖像：chip `[Image #N]` + 懸停預覽 + 粘貼 chip `[Pasted: N lines]`。
- 無字符數計數、無拼寫檢查（已驗證）。`desired_height` = vpad_top + text + info_block；max = 屏高/2；unfocus 收縮。

### 3.3 狀態欄（頂行）

- 左：`[git-icon branch] [worktree ] [sandbox:profile ] ~/path` — git icon `branch_icon()`；worktree 用 accent_user；sandbox 用 warning；路徑 gray_dim（懸停 text_primary）；截斷至首個右項；之後可能接 upgrade CTA。
- 右項（dim ` │ ` 分隔，僅項間）：
  - `bg_tasks`: `{dot-spinner-frame} {N}` accent_running（frame `(tick/4)%8`），running>0 才顯示
  - `plan`: `"plan"` accent_plan
  - `goal`: `[Goal: {label}]  {tokens}/{budget} tokens  {elapsed}` — 括號 dim、label accent_plan、暫停 = 反相 warning chip；狀態 `Verifying/Verifying (n/m)/Planning/Idle/Executing/Budget/Done/Paused…`
  - `mcp`: `⠋ MCP (connected/total)` gray_dim（total>0 才顯示）
  - `context`: `"{used} / {total}"`（`8.5K / 1.0M` 格式；梯度 text_primary→accent_user→warning→accent_error @0/50/75/85/95%；懸停 `█████ 42.0%` 八分塊條）
  - `queue`: `+{N}` accent_user（有排隊 prompt 時）
  - `badge`(todo): `2/5` + `✓`（alt `[▶:1 □:4 ✓:3 ✗:2]` 等格式可配置）
  - `credits`: `Credits used: {pct:.0}%` success/warning/error @80/100%（**我們沒有——跳過**）

### 3.4 TurnStatus 行（單行無邊框）

`[spinner] {activity label} [{phase timer} {turn timer} {⇣12k} [↓ | send to bg] [stop]` — spinner 盲文 `⠋⠙⠹⠸⠼⠴⠦⠧` @tick/4（~7.5fps）；等 user input → 脈動 `◆`；idle+watchers → `○ ◎ ◉ ◎` 呼吸（tick/8, accent_system）+ `watching · 1 command · …`。右側計時 gray `1m20s`；`⇣` token 箭頭；`[↓]`（懸停 accent_running）→ `" [send to bg]"`；`[stop]`（懸停 accent_error）。Drain 阻塞 idle：脈動 `◆` + `"agent idle ~ waiting on your edit"`。

Labels：`Starting session…` / `Cancelling…` / `Verifying…` / `Thinking…` / `Responding…` / `Compacting…` / `Retrying (attempt N)…` / `Waiting…` / `Waiting for response…` / `Waiting on subagent…` / `Waiting on task output…` / `Waiting on tasks…` / `Sleeping…` / `Waiting on answers for {detail}`。

### 3.5 ShortcutsBar

`key: label` — key 粗 text_secondary、冒號+label gray；項間 5 列 dim `"  │  "`。雙擊確認：整行換 `{key}: press again to {label}`。Compact：前 N 未釘 + 釘住 + 尾 `shortcuts` 提示。右可選 team 名。

### 3.6 Dropdowns

- **完成下拉**：max 6 行；`❯ {label}  {desc}`（label ≤40）；選中 bg_visual+粗、hover bg_hover、普通 bg_light；1 列 scrollbar。
- **斜杠下拉**：`❯ /command  first-line desc`；fuzzy 命中字母 accent_fuzzy 粗體；desc gray；換行縮進。
- **歷史面板**：上邊框 `" history "` 左 + 計數右；命中字符 accent_user 粗；`…` 尾；空 `"  Loading..."` / `"  no matching history"`。
- **文件搜索**：`{k}/{n}` 計數右上（≥1000 → `1k+/{n}`）。
- **/jump**：標題 **`"Jump to which turn?"`**；行 = 右對齊 gut 槽 gray + 預覽；`(no preview)`。

### 3.7 Permission modal（無邊框、bg_light、accent 軌）

可選子代理溯源（gray）；標題粗 text_primary（如 bash 描述或 `"Allow Edit?"`）；bash 命令 soft-wrap + 語法高亮（quote-aware）；args JSON 截斷 + `"... Ctrl-F to expand"`；提示 `Use ← → to choose permission scope`。
選項行：`{n} {marker} {label}` — 數字 accent_user；`(●)`/`(○)`；label 形狀：`Always allow: {scope}`、`Never allow: {scope}`、`Yes, proceed`、`No, I trust it`、**RejectOnce 自由行** `{n} (○) No, reject (type to add feedback)` / 輸入後 `{n} (●) ❯ {preview}`；MCP 範圍 `(Server) Action` / `all tools from Server`。光標行 bg_visual；未聚焦 0.66 dim。

### 3.8 Question modal

同 chrome。label = 首段粗；描述 markdown gray（cap 5 行 + 展開）；聚焦項預覽 dim（cap 6）。選項快捷 `1`-`9` 然後 `a`-`f` + `[ ]`/`[x]`（多選）或 `(○)`/`(●)`（單選）+ label；**自由輸入腳行**（sticky 底部）：`z [x] (●) ❯` + 占位 `"Type your answer here"`。Footer 3 行：`[1/2] ↑/↓ navigate · ←/→ question · y copy` 左；右 `Enter: select|submit|edit` pill。

### 3.9 Rewind view（**跳過複刻 v1**——規格留檔）

相位：`Loading rewind points...` → `Picker "Rewind to which turn?"`（行 `· {preview} · N files`）→ `CancelOffer "A turn is currently running."`（`y "Cancel turn and rewind"` / `n "Let it finish"`）→ `ModeSelect "Resubmit from here — what should be rewound?"`（`a Both conversation and file changes` / `b Conversation only` / `f File changes only`）→ `Previewing file changes...` → `Confirm`（`Rewind file changes and conversation to "…"?`（` ({N} files)`）；乾淨文件 gray `{path}`、衝突 `! {path} ({deleted|added|modified|conflict})` warning，各 max 5 + `+N more`；`y Confirm rewind`/`Bksp Back`）→ `Executing "Rewinding..."` / `Error "Rewind failed"`+Esc Dismiss。打開時 scrollback 從 rewind anchor 向下 dim。交互 `j/k/↑/↓/Enter/y/n/a/b/c/f/Esc/Bksp`。

### 3.10 Plan approval（**跳過 v1 的審閱面**；chrome 適配）

佈局 = **line-viewer overlay**（plan.md/`plan.md (empty)`）+ ShortcutsBar 動作條（`c comment / s send / a approve / q quit / Tab prompt`；有評論行時 `Enter edit · x delete`）；prompt 上一行 `◆ Waiting on plan approval`（脈動◆）。空文檔模板（`# No plan written yet` / approve / request changes / quit）。審批中 chrome：prefix `● ` accent_plan、占位 `"Type your comment..."`、邊框 blend(bg_base,accent_plan,0.4)。Toast：`"No plan written yet."` / `"Plan revision sent."` / `"Plan feedback sent."` / `"No comments to send."`。

### 3.11 Cancel-turn 面板

warning 軌：標題 **`"Subagents are still running. Stop them?"`**、gray `{N} subagent running(s)`、radio `1 Stop running / 2 Continue to run / 3 Always stop / 4 Always continue`；快捷 `1-4 select · enter confirm · esc keep running · tab scrollback`。

### 3.12 其他面

- `/btw` 面板：` /btw {question} ` 標題粗 accent_user + 右 `{pos}-{end}/{total}  ↑↓  [Esc]`；`⠋ Answering…`；錯誤 accent_error；正文 markdown ≤12 行。
- 任務組合面板：組頭 `▾ Subagents 2`；行 `{spinner|✓|✗} {elapsed} {label} (N) {model} …` + 右 `[✗]`/`[↗]`；順序 Subagents→BgTasks→Schedule；空 `"No tasks or agents."`；上下溢箭頭 `▲/▼`。
- Queue 面板（≤3 行）：`#N ` gray 前綴 + 類型樣式（`/prompt-arg` 洋紅/gray、`! cmd` 黃、`↻ ` cron）+ `(+N lines)`；右 `[cancel]`/`[Send now]`。
- Todo 面板：`□` pending text_primary、`▶` in-progress warning 粗、`✓` accent_success dim、`✗` accent_error 刪除線；空 `"No todo items."` / `"All done."` / `"N done. M cancelled."`。
- 時間線軌：2 列；`━━` 激活 / `──` 懸停 / ` ─` idle；chevron `▴▾`；懸停 popup = 圓角卡 + turn 預覽。
- Block viewer（全屏 modal）：`{gutter:>w} ` 行號 + 高亮；Execute stdout 於 bg_dark；WebSearch `Sources (N)` + `[1] URL`；`Selected: N lines` + `─┼` 分隔。
- 圖片/視頻查看器：居中 90%×90% 圓角 popup；title `─ name (W×H) ─`；`[✗]` 關閉。
- 會話選擇器：組頭 repo_name；行 label + 右 label；時間 `just now/Nm ago/Nh ago/Nd ago/Nmo ago`（w8）；`⠸ Searching session content…`；字段 `ID/CWD/Model/Created/Updated/Source/Host/Messages/Turns/Prompt`。
- 擴展 modal：tabs **Hooks / Plugins / Marketplace / Skills / MCP Servers**；狀態 `ready/needs auth/setup required/unavailable/initializing`；footer `"ctrl-o open"`；分節 `Managed by grok.com (N)` / `Plugin: {name} (N)` / `Local (N)`。
- Agents modal：tabs `Agents` / `Personas`；badges `" built-in "/" project "/" user "/" bundled "`；字段 `Model:`、`Prompt mode: extend|full`、`Tools (N): • name`。
- New worktree dialog：居中 3 行圓角 `╭╮`；`New Worktree` 粗；`Name (optional): ` 反相光標；`enter = create … esc = cancel`。
- CTA 行：`Install {name} plugin? [Install] [x]`；`⠋ Installing…`/`✓ installed`/`Couldn't install… [Retry ctrl+/]`。
- 公告 banner：critical 2 行 `! Title` accent_error 粗 + dim `[hide]`；promo 1 行 `[Label]`。
- 模式切換 banner：`Switched to mode: {mode}`——全亮 2s 再 0.3s fade。
- Toast：右下 fit-to-width、粗 accent_user on bg_base；~3s；`"Copied!"`、`"Rendering diagram…"`、`"{name} plugin installed ✓"`。
- Tips：`Tip: ` 粗 gray；ephemeral：`Queued · Enter to send now`、`Image in clipboard · {ctrl+v} to paste` 等。
- FPS HUD（32 列 `fps:/scroll-debug fps…`）/ scroll-debug HUD（46 列 9 行指標）。
- 子代理全屏框：`{spinner|✓|✗} {TypeLabel} {description} {model} {activity} · {elapsed} [✗]`。
- Mermaid：inline Unicode art（graph/state/class/er/sequence mini-parsers；過寬 fallback box `╭ mermaid: <word> ─╮`）；PNG：`◇ mermaid [Open Image] [Copy Image Path] [Copy Source]` 動作行、離子進程渲染（3s 超時）、toast `Rendering diagram…`/`Could not render diagram`、失敗降級 art。

## 4. 完整按鍵表

來源：`pager/actions/defaults.rs`。vim 條目僅當 `[ui].vim_mode=on`。

**Scrollback 焦點**：`j/k`、`↑/↓` 選下/上；`L/H`（Shift+→/←）下一/上一 turn；`J/K` 下一/上一 response；`g/G` 頂/底；`Ctrl+K/Ctrl+J` 上下一行；`Ctrl+U/Ctrl+D`（VS 系 `Shift+D`）半頁；`PgUp/PgDn` 頁；`h/l`（←/→）折疊/展開；`e` ToggleFold；`E` 展開全部；`Ctrl+E` 全部 Thinking；`r` 生 markdown；`y` 複製區塊內容；`Y` 複製元數據；`Enter`（alt `Ctrl+F`）打開 block viewer；`o/O` 下/上一鏈接；`Tab`（alt `i`/`Space`）聚焦 prompt；`Ctrl+R` mouse capture；Enter on 鏈接/提示內聯編輯/子代理塊 = 打開。

**Scrollback 搜索**（`/` 或 `/find` 進入）：`Esc` 關；`↓/↑` 下/上一匹配；`Enter` 收（空則關）；`n/N` 瀏覽；輸入 = 編輯；Paste 粘貼。**無 Ctrl+F 搜索**。

**Prompt 焦點**：`Enter` 發送（multiline 換行；尾部 `\` 續行；turn 運行 + 空 composer → 強發隊列頂）；`Shift+Enter`/`Alt+Enter` 換行（multiline: 這兩個發送）；`Ctrl+Enter`（alt `Ctrl+I`；Apple Terminal `Ctrl+O`；VS `Ctrl+L`）→ "send now"（取消運行+發送）；`Ctrl+M` 切換 multiline；`Ctrl+C` 清草稿→空即 CancelTurn（minimal idle 下第二空次 = Quit）；`Tab` 聚焦 scrollback / bash 補全 / 接受 ghost；`Shift+Tab`（3 編碼）循環模式 Normal→Plan→Always-Approve；`!` 空時 bash 模式；`#` 空時 remember 模式；`Ctrl+V`/`Cmd+V`（Win `Alt+V`）粘貼；`Ctrl+Shift+V` 內聯原樣粘貼；`Up` 空行 = 歷史瀏覽；`Ctrl+L`/`:` 在 file-ref 上開 line viewer；`Esc` 非空 = 雙擊清 prompt（≤800ms）；`Esc` 空+≥1 turn = 雙擊開 rewind picker；`Ctrl+P/Ctrl+N`（textarea 移動）。**文本編輯（emacs 系）**：`Ctrl+B/F` 左右；`Alt+B/F` 單詞；`Ctrl+A/E` 行首尾；`Ctrl+W/U/K` 刪詞/行首/行尾；`Ctrl+X 剪 / Ctrl+Y 粘 / Ctrl+Z 撤消 / Ctrl+R 重做 / Ctrl+Shift+Z 反撤`；`Cmd+A`（Ghostty）全選。

**AgentScreen/全局**：`Ctrl+P`/`?` 命令面板；`Ctrl+O` 切 always-approve；`Ctrl+.`（或 `Ctrl+X`）快捷鍵速查；`Ctrl+M` 模型選擇器；`F2`/`Ctrl+,` 設置；`Ctrl+T` todo 面板；`Ctrl+B` 任務面板；`Ctrl+;` 隊列面板；`Ctrl+S` 會話選擇器；`Ctrl+L`（非 VS）擴展 modal；`Ctrl+G` 發送後台；`Ctrl+\` dashboard；`Ctrl+Space`/`F8` 語音；`Ctrl+N` 新會話（雙擊確認）；`Ctrl+Q`（VS `Ctrl+D`）退出（雙擊 ≤1000ms；未認領 Ctrl+C/D 也武裝退出）；`Ctrl+/` 安裝 CTA 插件。

**Modal/picker 共享**：`Esc` 關；`↑/↓/j/k` 導航；`Enter` 選；`/`/`i` 搜索；`f` 過濾；`y` 複製；`e/→` 展開；`E/←` 摺疊；`Space` toggle；`Tab/Shift+Tab` tabs；settings `d` 重置。

**Permission**：`1`-`9` 選項；`Enter`；`j/k`；`←/→` 調範圍；`Ctrl+F` 展開 args；`Ctrl+O` always-approve；`Ctrl+C` 取消。**Question**：`1-9/a-f`、`z` 自由、`y` 複製、`Ctrl+F` 全屏、`Ctrl+Y` 關、`Esc` 返回、`Shift+X`/`Ctrl+C` 提交、`Tab` 切窗、`]/[` 上/下一問。**Rewind**：見 §3.9。**Cancel**：`1`-`4`/`Enter`/`Esc`。

**鼠標**：滾輪 3 行/tick（VS 嵌入 15、iTerm2/wezterm/tmux 1）；Ctrl/Cmd+點開鏈接；左鍵首次選 entry、二次（<300ms）選詞/URL、三次選表格單元；拖拽選區 + 自動滾動 + 自動複製；scrollbar 拖；懸停一切；prompt 點擊/雙擊（paste chip 展開、viewer）；permission 雙擊觸發選項。**（2026-09-05 標記 superseded：M46b 已實現——五模式捕獲 + 滾動流式（每品牌 ept/加速/taper/knobs）+ 懸停雙擊/拖拽/scrollbar/多擊 300ms 全語義——見 research 2026-09-05 delta + docs/superpowers/specs/2026-09-05-m46b-mouse-design.md + case-023。本行快速項（滾輪 3 行）已被流式化取代。）**

## 5. 主題（GrokNight 默認——精確 RGB）

| 槽位 | RGB | Hex | 槽位 | RGB | Hex |
|---|---|---|---|---|---|
| bg_terminal | 10,10,10 | #0a0a0a | text_primary | 225,225,225 | #e1e1e1 |
| bg_dark/code | 28,28,28 | #1c1c1c | text_secondary | 200,200,200 | #c8c8c8 |
| bg_base | 20,20,20 | #141414 | gray | 108,108,108 | #6c6c6c |
| bg_light | 36,36,36 | #242424 | gray_bright | 120,120,120 | #787878 |
| bg_hover | 44,44,44 | #2c2c2c | gray_dim | 88,88,88 | #585858 |
| bg_visual | 54,54,54 | #363636 | command/warning | 224,175,104 | #e0af68 |
| accent_user | =text_secondary | | path | 255,158,100 | #ff9e64 |
| accent_assistant/_thinking/_running | 187,154,247 | **#bb9af7** 洋紅 | running | 125,207,255 | #7dcfff 青 |
| accent_system/_skill/fuzzy | 122,162,247 | **#7aa2f7** 藍 | prompt_border | 50,50,55 | #323237 |
| accent_error | 247,118,142 | **#f7768e** 紅 | prompt_border_active | 80,80,88 | #505058 |
| accent_success | 158,206,106 | **#9ece6a** 綠 | diff_delete_bg/fg | 66,14,20 | #420e14 / #f7768e |
| accent_plan | 255,219,141 | **#ffdb8d** 金 | diff_insert_bg/fg | 6,56,6 | #063806 / #9ece6a |
| accent_feedback | 115,218,202 | #73daca | md_heading: h1 #1abc9c/h2 #7aa2f7/h3 #9d7cd8/h4 #787878/h5 #6c6c6c/h6 #5a5a5a（均 BOLD 除 h6） | | |
| accent_remember | 139,195,74 | #8BC34A | md_code #3A95AB BOLD · md_task_checked #9ece6a · md_task_unchecked #c8c8c8 · md_muted #6c6c6c · md_code_bg #1c1c1c · md_text #c8c8c8 · link_fg #7aa6da | | |
| accent_model | 26,188,156 | #1abc9c | scrollbar_bg #0c0c0c · scrollbar_fg #242424 | | |
| selection_border | 60,60,65 | hover_border 30,30,34 | paste_bg #0c0c0c · paste_fg #c8c8c8 | | |

GrokDay（淺色對應）：bg_base #eeeeee、bg_light #dedede、bg_hover #d0d0d0、text #262626/#444444、gray #767676、accent 加深（BLUE #2F64D2、CYAN #0082AA、GREEN #378E23、MAGENTA #7D4BC6、ORANGE #C3691E、PURPLE #6C3EB2、RED #CD3048、TEAL #0A8E70、YELLOW #A27612）、diff delete bg #F5DADE / insert #DAF2DC。
kind 集合：`groknight / grokday / tokyonight / rosepine-moon / oscura-midnight / auto`（auto 經 macOS AppleInterfaceStyle/XDG portal/Windows 註冊表/SSH 回退 OSC 11；輪詢 5s；truecolor-only 的 kind 過濾）。

**量化與降級**：`Theme::current()` 按終端色位量化 RGB；**Windows contrast boost**（bg_light/hover/borrow 遠離 base）；16 色 Basic → `ansi16_chrome_overrides(dark)`：軌道底色 = 畫布極性（黑/白）、語義按色系釘住（magenta 系→assistant/thinking/running、red 系→error、green 系→success、blue 系→system/skill/fuzzy、cyan 系→feedback/model、yellow 系→command/warning/path/plan）。**OSC 11** 探測 `\x1b]11;?\x07`（500ms；BT.709 亮度 <0.5 = dark）；**OSC 12** 設光標色（當前 accent_user），**OSC 112** 重置（關閉時）。

## 6. 字形/字符串常量

- `❯ `（prompt 箭頭，寬 2；legacy `> `）；`◉/◎` 錄製點；`❙` 摺疊軌；`✗`/`✓`/`↗`/`⧉`/`⇣`；`○ ◎ ◉ ◎` monitor 幀；`◆ ◇ ◈` 鑽石；`┃` 強調軌；`▴▾━━───` 時間線；`●●○` filled_dot；`▏▏` selection_bar；`› ‹ ⌄ ▾ ▸` chevron；`[✗]/[↗]` 按鈕；spinner 盲文 `⠋⠙⠹⠸⠼⠴⠦⠧`（ASCII `| / - \`）；dot spinner `⋅ : ⸬ ⁙`；進度塊 `▏▎▍▌▋▊▉█`。
- 占位/標籤：`"Build anything"`、`"Type your comment..."`、`"multiline"`、`" history "`、`" search: "`、`" / to search"`、`"bad pattern"`、`"no matches"`、`"no matching history"`、`"Loading..."`、`"Press again to {label}"`、`"Send now"`、`"No todo items."`、`"All done."`、`"No tasks or agents."`、`"No running tasks. Press h to show all."`、`"Queue is empty."`、`"No plan written yet."`、`"agent idle ~ waiting on your edit"`、`"watching · N command(s)"`、`"use ← → to choose permission scope"`、`"... Ctrl-F to expand"`、`"Yes, proceed"`、`"No, reject (type to add feedback)"`、`"Subagents are still running. Stop them?"`、`"Rewind to which turn?"`、`"Confirm rewind"`、`"Rewind failed"`、`"… N more lines — /transcript to view"`、`"◇ mermaid [Open Image] [Copy Image Path] [Copy Source]"`、`"Rendering diagram…"`、`"Could not render diagram"`。
- 警告/版本：`"Tip: "`、`"Update available: v{latest} — restart to apply."`、`"Thanks for trying Grok Build, give feedback with /feedback!"`。

## 7. 交互狀態 → 視覺增量

| 狀態 | 變化 |
|---|---|
| Idle | TurnStatus 行隱藏（除非 watchers/MCP seed）；prompt 未聚焦 0.66 dim + `"Build anything"` |
| Streaming | TurnStatus 出現（盲文 spinner + 活動標籤 + 兩計時 + `[stop]`）；運行塊強調波浪 |
| 等 permission | spinner → 脈動 `◆`；prompt 槽 → permission 面板；快捷欄 `1-9 select · ←/→ scope · ctrl+f expand · ctrl+o always-approve · ctrl+c cancel` |
| 等 input（question） | 同上 + 面板 footer |
| Drain 阻塞 | `◆ agent idle ~ waiting on your edit` |
| 搜索 | scrollback 底 2 行：`─` + ` search: query`（反相光標）+ 計數；匹配反相；`n/N` 瀏覽 |
| Rewind | prompt 槽 → rewind 面板；scrollback 從 anchor 向下 dim |
| Suspend（$EDITOR/$PAGER） | 終端讓出 raw/alt-screen；minimal `/transcript` → 序列化 ANSI 到暫存 + `$PAGER -R`，進度 `rendering transcript… {done}/{total}` |
| Multiline | info 行右 `"multiline"`；Enter/Shift+Enter 互換 |
| Compact | vpad 0、hpad 1、sticky/scrollback 收縮 |
| 模式循環 | banner `Switched to mode: plan`（2s fade）；prompt 邊框/accent 變金；always-approve 入 info 行 |

## 8. 流式視覺序列（checkpoint）

- blocks 由 chunk 構建，**checkpoint 刷新**：段落閉合（空行）、列表/表格結構閉合、代碼圍欄 ` ``` ` 閉合。流中 markdown 增量渲染；**代碼圍欄原地重繪帶尾**（高亮器跨重繪持久；未終結行保留 `md_code_bg`）。
- 代碼塊：無頭行/無語言標籤/無複製按鈕/無摺疊 widget——圍欄與語言 token 視覺隱藏，只有 body（bg md_code_bg + 高亮）+ 空白分隔行。mermaid 圍欄：打開時 = 普通代碼，閉合 → Unicode art（支持時）。
- 首 chunk 前：agent 消息塊一旦模型開始回應即存在（空塊就地渲染）；轉入信號是 TurnStatus 行。
- **tool call 即時**：call 開始 → 頭行 `◆ Run …`（折疊默認；運行 = 子彈 + 強調波浪）；bash 截斷流（first2/last3）；完成 → 強調凍結 success/error；Edit 出現完整 diff + gutter。Thinking：`Thinking…` 頭 → `Thought for {Xs}`，截斷 `…` + 末 3 行 0.7 混。
- **完成**：`finish()` 全重渲（markdown + mermaid 完成檢測），TurnStatus 消失/轉 idle，計時凍結。

## 9. 用戶籤約記錄此處的範圍

（本節原為 §Feature 清單，併入 §10 映射表的「設施」列。）

## 10. IH 複刻映射表（界面 1:1；按後端能力三類）

> 判別標準：**複刻** = 規格照搬 + 數據源我們有（或純前端本地）；**適配** = 規格照搬但數據/語義按 IH 後端接線（形狀一致的簡版/換源）；**跳過** = 我們沒有該功能（後端或產品層）→ 不複刻 UI（規格留檔，將來補後端功能時再啟用）。

| # | grok 設施 | 判定 | IH 對應 |
|---|---|---|---|
| 1 | Scrollback 全渲染（blocks/markdown/diff/折疊/分組/搜索/選區/sticky/時間戳） | **複刻** | session live stream（assistant/tool/thinking/user 事件）；block 映射表按 IH event 類型落地 |
| 2 | PromptWidget（chrome/❯/info 行/ghost/占位） | **複刻** | 本地 |
| 3 | 狀態欄左（cwd/git 分支/sandbox） | **複刻** | workspace root + 前端讀 .git + sandbox preset |
| 4 | 狀態欄右：tasks/goal/mcp/context/queue/todo | **複刻（goal 適配）** | jobs+subagent / goal 包（狀態以我們事件為準）/ mcp-client / token meter+budget / input tiers inbox / todo |
| 5 | 狀態欄右：plan / credits | **適配 / 跳過** | plan 我們有（plan-mode）；credits 無計費→**跳過** |
| 6 | TurnStatus 行（spinner/標籤/計時/stop） | **複刻** | 事件流（Thinking/Responding/Compacting/Retrying/Queued 全對應） |
| 7 | ShortcutsBar / banner / toast / tip | **複刻** | 本地 |
| 8 | 斜杠 dropdown + 命令面板 | **適配** | interaction command seam → 建 IH slash registry（builtin+skill+ACP） |
| 9 | Prompt 歷史面板 / scrollback 搜索 / `!` bash 前綴 | **複刻 / 適配** | 歷史本地；搜索本地；`!` → exec bash/pwsh 語義（提示文案可特化） |
| 10 | Completion（shell 補全 ghost） | **適配** | 我們 shell 無補全協議 → 切為 slash/ghost 參數補全；shell 補全**跳過** |
| 11 | `@` 文件搜索 + line viewer / block viewer / `/jump` | **適配（block 複刻）** | fs-search + workspace 文檔庫；viewer 本地渲染複刻 |
| 12 | Permission modal | **適配** | guard-approval seam：Always/Never based on scope + RejectOnce feedback（feedback 包） |
| 13 | Question modal | **適配** | interaction question seam |
| 14 | Plan approval（plan.md viewer/comment/approve） | **跳過 v1（chrome 適配）** | 我們 plan-mode 無 plan.md/等待審批（僅 plan/mode 事件 + exit_plan_mode）→ 保留模式循環/金碟 chrome + status chip |
| 15 | Rewind | **跳過** | 後端無回滾/文件快照（規格已完整留檔；未來若加 rewind 服務再複刻 UI） |
| 16 | Cancel-turn（subagent 問詢） | **適配** | subagent 樹 + jobs（有運行中子代理/任務狀態） |
| 17 | Todo pane + badge | **複刻** | todo 工具 |
| 18 | Tasks/Queue panes | **適配** | jobs + subagent roster + schedule；queue → 持久化 inbox |
| 19 | Session picker + 新會話/恢復 | **適配** | SessionService.list（ID/CWD/Model/Created/…全對應）/ 命令面 |
| 20 | Welcome（hero/trust/menu/changelog） | **適配** | 無 grok 登錄 → 版本行 + 新會話/恢復/工作區信任提示 |
| 21 | Dashboard（leader/roster 多進程） | **跳過 v1** | 無 leader；如要多會話儀表板 → 以後以 SessionService 多開封裝（UI 規格留檔） |
| 22 | Mermaid Unicode art | **複刻（評估尺度）** | 前端本地 mini-parser（或用通用 npm 庫）；圖太過寬/失敗 → fallback box（規格照抄） |
| 23 | Mermaid PNG 渲染（離子進程） | **跳過 v1** | 無捆綁引擎；M38 再評估（mermaid npm + 圖像協議可行性——Windows Terminal 支持受限） |
| 24 | 圖像內聯（kitty/iTerm graphics）+ 視頻 | **適配** | attachment 有；Windows Terminal 無 graphics 協議 → chip + viewer modal + 協議探測降級；視頻**跳過** |
| 25 | Voice / gboom / 終端圖形遊戲 | **跳過** | 無對應後端 |
| 26 | Extensions modal（Hooks/Plugins/Marketplace/Skills/MCP） | **適配** | **全有**：hooks / plugin-registry+market / skills / mcp-client——tabs 一一對應 |
| 27 | Agents modal（Agents/Personas） | **適配** | preset 包 + subagent/team |
| 28 | Memory modal | **跳過** | R-A10 記憶遠期 |
| 29 | Announcements / update CTA | **適配** | 無遠程公告 → 本地版本檢查（可關）；遠程內容降級 |
| 30 | `/btw` 面板 | **適配** | steer/interject 面（問題送入 running turn） |
| 31 | Goal chip（Verifying/Planning/Budget… 狀態機） | **適配** | goal 包事件（無 verification 概念→狀態按我們的） |
| 32 | `/transcript`（minimal 全視圖 → $PAGER） | **複刻** | 本地渲染器（ANSI 序列化 + $PAGER） |
| 33 | `/terminal-setup` 診斷 | **複刻** | capability probe（M36 已含） |
| 34 | FPS HUD / scroll-debug / `/minimal` `/fullscreen` 切換 | **複刻** | 本地 |
| 35 | 模式循環 Shift+Tab + always-approve | **適配** | guard 自動審批 + approval 決策面（無「always」全局就是我們的 guardian?）→ 以我們 permit 面為準 |
| 36 | 子代理面板/目錄（catalog） | **適配** | subagent/team 結構 |
| 37 | 時間線軌（turn 導航視覺餘） | **複刻** | session turn 邊界（session log 有 turn） |

**總結計數**：複刻 15 / 適配 15 / 跳過 7（credits、plan 審閱面、rewind、dashboard v1、mermaid PNG v1、voice+gboom、memory、視頻、shell 補全、remote announcements——按行算為 7 類設施）。

## 11. 對 M36–M39 路線的影響

- **M36 不變**（renderer/input/teardown/probe + PTY harness 首例）——新增：主題模組照 §5（GrokNight 全表 + 量化 + ANSI16 釘色 + OSC11/12）、字形表照 §6（glyphs.ts 常量——fancy + legacy fallback 雙映射）。
- **M37 視圖清單改為「§10 複刻+適配項」**，逐 widget 對照 §3：scrollback 全面（§3.1 + §8 流式序列）、prompt widget（§3.2）、狀態欄（§3.3）+ turn status（§3.4）+ shortcuts（§3.5）+ 下拉（§3.6）+ permission/question（§3.7/3.8）+ todo/tasks/queue panes + session picker + welcome。
- **M38**：fullscreen 政策 + 主題切換（kind/auto）+ markdown checkpoint（§8）+ 高亮極性安全 + `/minimal` `/fullscreen` + `/transcript` + 模式循環 chrome + extensions/agents modal（§3.12）+ `/btw`。
- **M39**：場景矩陣按 §7 狀態表 + FPS/scroll HUD + benches + memory release。
- **跳過項各自留檔**：§3.9（rewind 全相位規格）、§3.10（plan 審閱）、§3.12（dashboard）——將來 IH 補上對應後端功能時按圖索驥。

## 12. 參考

- 規格來源：`D:\opencode-bugfix\grok-build-main\crates\codegen\xai-grok-pager`（`pager/views/agent.rs:158-413` 佈局、`pager/app/app_view.rs:225-232` ActiveView、`pager/actions/defaults.rs` keymap、`render/theme/groknight.rs:28-59` 色表、`render/theme/mod.rs` 量化、`render/glyphs.rs` 字形、`pager/views/*` 各 modal、`pager/scrollback/*` blocks、`xai-grok-pager-minimal` live region）。
- 承上：`2026-09-03-tui-grok-blueprint.md`（工程屬性複刻 + 技術選型）；`2026-09-03-tui-fourway.md`（四路選擇史）。
