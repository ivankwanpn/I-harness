# M47 — 質量輪 2：鼠標/懸停面 bench + 誠實微缺口收尾

日期：2026-09-05 · branch m47（自 main 出）· 源：M39 bench 未覆蓋鼠標面（m46b/c 加入後）+ m46 系列記錄的微缺口（live probe 污染、openLineViewer toast、`[Pasted]`/r 已修）。

## 範圍

**G1（bench-mouse——寬閾值 + 輸出表）**
- `test/bench-mouse.test.ts`：
  1. **hover 常駐**：5000 行會話 + 10k HitArea——`HoverEngine.update` 單次時延、**changed 時才重繪**（不變時 0 字節——紅線延續）、changed 重繪單幀成本（cell diff 已做，量其 overhead）
  2. **click→select→drag→autocopy 循環**（100 循環）時延 + 複製注入面開銷
  3. **scroll-stream 重負荷**：1000 事件/秒泵——合併率/cap 生效/後滴漏（斷言 cap ≤ max(vp/2,6)、無積壓增長）
  4. **timeline rail**：1000 turn 的渲染/跳轉時延 + `turnAnchors()` 攤銷
  5. **selection overlay 跨度**：5000 行跨度框成本（O(borders) 證明）+ flash 循環
- 時延表（console.table）+ 閾值。

**G2（微缺口三件——小而真）**
1. **`/doctor` live probe**（m46a 記錄：只能報啟動探測——因運行中發查詢會與 TUI 位元組交錯）：做 **paint-suspend 重探**——發查詢前 frame() 掛起標誌（≤800ms）、回覆由既有 probe parser 消化（輸入通道本就分流）→ 完成恢復繪製 + 報告面板現場更新。測試：注入假回覆流（probe feed）→ 面板字段更新；繪製掛起期間無幀寫出（ledger 0）。
2. **`openLineViewer` 接通**：prompt file-ref 雙擊（m46b 是 toast——「seam absent」）——現有 **block viewer**（M37a 有 ?——read openLineViewer 現狀：loop 有 hook seam?）——接通為真（file-ref → block viewer 行定位）；若 block viewer 缺文件定位 → 最小實現（viewer 已存在對 read/tool 塊——定位到匹配行）。
3. **`[Pasted]` chip 交互完備**：單擊 chip = 提示（已）；chip 行點擊與 prompt 光標置位歧義？——檢查 m46c pasteChipRowAt/promptCursorAtCell 覆蓋——若無衝突則跳過（記「已完備」）；若小瑕疵 → 修。
4. （如時間許可）`\x1b[?1015h` 的 WT 表現註記 + `status.ts` 的 copy 反饋（cwd click copy 已有 toast?——檢查，無則接 toast）。

**G3**：docs（bench 表入 README/research + README M47 行 + CAPABILITIES）+ 全量。

## 硬規

- bench 寬閾值（CI 波動）；表格輸出記錄。
- probe suspend 須無死鎖（800ms 上限 + 失敗恢復）；PTY 慣例。
- 後端零改動。
