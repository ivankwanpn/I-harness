# IH 架構稽核（2026-11-09，rc80 基線）

目標：效率、穩定性、避免過度設計。以日常流程 F0–F9 逐段檢查，對照 DSH／Codex／OpenCode／Pi。

## 總結

目前最值得處理的不是 gateway 進程模型，而是三個「第二套真相／第二套状态」：

1. parent task document（subagent 的第二個 durable writer）
2. token receipt document（admission 的第二份記錄）
3. queue 與 durable input 的雙 projection

## 分段發現

### F0 啟動／gateway

**現況**：Electron main → 每個 workspace 一個 gateway child（stdio），244 packages，supervisor／health／fatal IPC。

**優點**：workspace 隔離、crash 可重啟、renderer 有 online 狀態。

**問題**：
- 每個 workspace 冷啟動成本高；多 workspace 時 process 數量線性成長。
- 與 DSH（單 desktop-host）、OpenCode（單 background service）相比，IH 的 process 模型較重。
- 但目前沒有證據顯示這是 prompt 延遲主因；不建議先重寫。

**建議**：保留 supervisor；先量 gateway 冷啟動與記憶體，再決定是否共用 host。

### F1 開啟會話

**現況**：`session/open` 並行 dashboard／history／input state；rc80 加 `session/warm`。

**問題**：warm 只 warm 目前選中的 session；private runtime 在 rc79 直接失敗，rc80 才修好。

**建議**：把 warm 失敗記錄成 diagnostic（目前 renderer `.catch(()=>{})` 完全吞掉），避免再次靜默失效。

### F2 Admission

**現況**：token receipt document 寫入＋讀回＋managed document＋inbox admit。

**量測**：冷啟動 13228ms、warm 後 23ms（private 552KB session）。

**問題**：
- receipt document 與 admission event 是同一件事的兩份 durable 記錄。
- `getDocument` 讀回驗證是額外 RTT；但 warm 後 admission 只有 23ms，已不是主要瓶頸。
- 直接移除 receipt 會破壞既有 archive／cutover invariant（rc79 實驗造成 27 個測試失敗）。

**建議**：不急著拆；先把 receipt 降級成「cleanup metadata」，不再參與 admission 決策。

### F3 Assembly／session runtime

**現況**：lazy assembly，rc80 warm 可提前建立。

**問題**：warm 只對被打開的 session 生效；如果使用者立即送出，仍可能撞上冷啟動。

**建議**：UI 在 warm 完成前顯示「準備中」，或 send 時等待 warm promise，而不是讓 submit 自己付冷啟動。

### F4 Context

**現況**：552KB body、200KB inline image、13.7k schema tokens；context-output 預設 disabled。

**量測**：同一個 session warm 後 firstTokenMs 1662ms，duration 16328ms。

**問題**：
- 524–552KB body 每次重送；圖片仍 inline。
- context-output 已存在但預設關閉，等於有現成機制沒用。

**建議**：先量 context-output 開啟後 body／firstToken 差異；不要先重寫 projection。

### F5 模型串流

**現況**：diagnostics 已有 firstTokenMs／durationMs。

**問題**：first token 變異大（同一 session 40s → 1.7s），主要是 reasoning effort／模型。

**建議**：不要用單次 firstToken 判斷 IH 好壞；看 p50／p95。

### F6 工具

**現況**：tool result 大量 inline；大結果進 context。

**問題**：與 F4 相同，是 body 膨胀來源。

**建議**：與 context-output 一起處理。

### F7 Subagent

**現況**：parent task document＋child session＋runtime table＋job registry；rc80 binding debt 不阻塞、terminal close idempotent。

**驗證**：真實問題 session 可重複 spawn／close；queue／stop 正常。

**問題**：
- task document 仍是第二個 durable truth；catalog／session-management 直接讀它。
- 這次只是讓 debt 不阻塞，不是 projection-first。

**建議**：把 catalog 的 task document 讀取改成「hint only」；缺失時完全由 child session 推導。

### F8 Queue／停止

**現況**：durable inbox＋lane queue＋queue projection。

**驗證**：queue cancel、session cancel 都回 true，queue 清空、running false。

**問題**：兩套 projection，draft session stop 仍需 fallback。

**建議**：queue API 回傳單一 projection；UI 不再自行合併兩個來源。

### F9 持久化／recovery

**現況**：session event log＋task document＋token receipt＋managed document。

**問題**：recovery 要同時處理四個 durable 狀態，任何一個 debt 都會放大。

**建議**：長期只保留 session event log 為 truth；其他都是 rebuildable。

## 稽核修正（2026-11-09 晚）

### Catalog 不是 P1

重新讀 `desktop-gateway/src/subagents/catalog.ts` 後確認：

- 列的來源是 child session（`coordinator.list()` 的 `origin=subagent`）；
- task document 只提供 `agentPath`／role 等 hint；
- task document 缺失或版本不支援時，`currentFormat` 會讓列仍由 child session events 推導；
- 因此 **不需要**把 catalog 改成 projection-first；原本的 P1 判斷過重。

### Context-output 對既有 session 幫助有限

- context-output 只影響 **未來** 的大 tool result；
- 使用者那個 552KB session 的既有 tool result 已經 inline，開啟 context-output 不會縮小它；
- 真正能縮小既有 session 的是 `/compact`（UI 已支援），不是 context-output。

### 修正後的優先順序

| 優先 | 項目 | 備註 |
|---|---|---|
| P1 | queue 單一 projection | 仍有 dual projection 風險 |
| P2 | warm 完成前送出 | UI gating，比 catalog 改寫有效 |
| P3 | receipt 降級 | 高風險，admission 已 23ms，不急 |
| P3 | 共用 gateway host | 需先量冷啟動 |

## 第二輪稽核修正（queue／warm gating）

### Queue 已經是單一 projection

`desktop/session/open` 在 `desktop-input` capability 存在時只讀：

```text
desktop/session/input/state
```

只有在舊 gateway 沒有 durable input 時才退回 `session/queue`。renderer 的 `queue` 就是這個單一來源；`onCancelQueue` 同時呼叫 lane cancel 是為了取消已進入 lane 的項目，不是兩個 UI projection。

因此「queue 雙 projection」不是目前的設計問題，優先級下調。

### Submit 已經會等 warm，不需要 UI gating

冷啟動同時開 warm 與 submit：

```json
{"submitMs":2386,"warmDoneMs":2634,"accepted":true}
```

warm 已完成後：

```json
{"submitMs":57,"warmDoneMs":58}
```

直接冷 submit 則是 13228ms。也就是 submit 會 coalesce 到正在進行的 warm，不需要再在 UI 加一層 gating。

### 修正後的真正剩餘項

| 項目 | 判斷 |
|---|---|
| catalog projection | 已 tolerant，不需要重寫 |
| context-output | 不影響既有 inline history |
| queue projection | 已是單一來源 |
| warm gating | 已 coalesce，不需要 |
| receipt 降級 | 可做，但 admission 已 23ms，高風險低回報 |
| task document projection | 長期架構清理，非阻斷 |

## Gateway 冷啟動量測

同一個 rc80 portable、userdata 複本：

```json
{"cold":507,"warm":436,"n":1}
```

第一次 `session/dashboard` 507ms，第二次 436ms。gateway spawn 不是 prompt 延遲的主要來源，與 DSH／OpenCode 的 host 模型差異不構成必須重寫的理由。

## 稽核結論

到這裡，F0–F9 都已經有實際量測或程式證據：

- gateway 冷啟動 ~0.5s；
- admission 冷 13.2s → warm 23ms；
- first token 1.7s（短 context）／1.66s（552KB context）；
- spawn／close 可重複；
- queue／stop 乾淨；
- catalog／queue／warm gating 的疑似過度設計已被排除。

真正剩下的只是長期雙記錄（token receipt、task document），目前不是阻斷性問題。繼續改的風險高於回報。

## 優先順序（原始）

| 優先 | 項目 | 套件 | 風險 |
|---|---|---|---|
| P1 | catalog task document 改 hint-only | desktop-gateway/subagents | 中 |
| P1 | warm 失敗不再靜默 | renderer | 低 |
| P2 | context-output 實測 | context-output | 中 |
| P2 | queue 單一 projection | desktop-gateway/desktop | 中 |
| P3 | receipt 降級 | desktop-gateway/input | 高 |
| P3 | 共用 gateway host | desktop/main | 高 |

## 版本策略

依使用者指示：不再每個修正都發 GitHub release。

- 以 rc81 作為工作版本，本地 build／portable 測試；
- 全部完成後才發一次 rc81；
- 在此之前不建立 GitHub release。
