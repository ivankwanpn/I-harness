# 對話載入與送出：重新設計研究（2026-11-09）

## 一、問題不是單點，是「同步式會話」設計

IH 現在把三件事綁在同一個回合裡：

1. 載入對話：先查 head，再逐頁重讀整份日誌；
2. 送出提示詞：等 session/create、model/set、durable admission 全部完成，UI 才解除「操作進行中」；
3. 停止：等 delivery stop，模型串流不理會 abort 就卡住。

這三個都是「請求完成才更新 UI」，所以任何一步慢，整個畫面就像壞掉。參考項目都把這三件事拆開。

## 二、目前 IH 的實測與程式證據

### 載入

- `packages/desktop/src/renderer/session/history.ts` 舊版：
  - 先 `afterSeq = MAX_SAFE_INTEGER, limit = 1` 探 head；
  - 再從 `head - 20000` 開始，每頁 500，最多 40 頁；
  - 每次 `session/history` 都重新 snapshot 整份 JSONL。
- 即使改成 tail，`beforeSeq` 也要同時穿過 SDK client 與 Desktop IPC 才生效；rc49 之前只改了 server/protocol，client/IPC 把它丟掉。
- rc50 已改為單次 tail 請求（最新 500 筆＋startSeq/headSeq），實測回應：

```json
{"events":20,"nextSeq":29,"startSeq":9,"headSeq":29}
```

### 送出

- `Composer.tsx` 的 `send()` 會 `await dispatch(...)`；dispatch 內含 session 建立、model/set、durable admission。
- `publishSend(key, { sending: true })` 在這整段期間都是 true，所以標題一直是「操作進行中」。
- 即使 rc48 已先清空輸入框，spinner 仍綁在 admission 上。

### 停止

- `session/cancel` 會 `await service.awaitDeliveryStop`；rc48 已加上 2.5 秒上限與 force-stop（只重啟 runtime）。

## 三、參考項目怎麼拆

| 專案 | 送出 | 載入 |
|---|---|---|
| **DSH** | `input/machine.ts` 是明確的 submit state machine；編輯器在 Host 接受前保持唯讀，接受後才清空；有 QueueDock 顯示排隊 | 常駐 conversation shell，Session store 提供 snapshot/views；不是每次選會話都重建整個畫面 |
| **OpenCode** | `composer/region.tsx` 用 `handoff` 把 prompt 先放進本地 timeline（optimistic row），server 有 row 後才轉成正式訊息；有 queue panel | timeline virtualizer 直接吃增量事件；optimistic row 先畫，再等 server 修正 |
| **ZCode desktop** | 任務建立／歸檔是 task service metadata；UI 先更新本地 task projection | task list 用 query cache，不重讀整份 transcript |

共同點：**UI 先有本地狀態，server ack 只負責校正；載入只拿最近窗口，其餘按需。**

## 四、建議的目標架構（最小改動，不換資料庫）

### 1. Conversation open：一個請求、一個 tail

新增或整理成：

```
session/open { workspaceId, sessionId }
→ { summary, headSeq, events[last N], running, queue, pendingInteractions }
```

- 不組 assembly、不建 tool registry；只讀 durable projection。
- 之後用既有事件流從 `headSeq + 1` 增量接上。
- 往前翻用 `beforeSeq`，不重讀整份日誌。
- Renderer 先畫 skeleton，再填 tail；不要等所有 sidebar session 都載完。

### 2. Submit：本地 optimistic row + 快速 enqueue

```
使用者按下送出
  → 立即插入本地 user row（pending）＋清空輸入框
  → input/enqueue（只做 durable append，回 inputId）
  → 背景建立 assembly / turn
  → 事件 admitted/turn-start 校正 row
  → 失敗才把 row 標 failed 並還原草稿
```

- UI 的 spinner 只代表「本地 enqueue 中」，不再代表整個 admission。
- 允許在等待時繼續輸入；新訊息進 queue（DSH/OpenCode 都這樣）。
- `clientToken` 保持冪等，重試不會重複。

### 3. 狀態機：idle / queued / running / stopping / failed

- Composer 只認狀態，不直接綁 promise。
- stopping 有 timeout，之後顯示 force-stop；force-stop 只重啟 runtime（rc48 已做）。

### 4. 快取

- 每個 session 的 tail、headSeq、running 狀態放 renderer store；切換會話先顯示快取，背景刷新。
- 不要每次 selection 都重打 history/context/model/task 全部請求。

## 五、刻意不做

- 不改用 SQLite／新資料庫；現有 JSONL 足夠，問題在請求粒度。
- 不做完整 offline CRDT。
- 不一次載入 20,000 筆；只載最近窗口，往前按需。
- 不為了 spinner 假裝完成；要真的把 admission 拆成 enqueue 與 turn start。

## 六、分階段

| 階段 | 內容 | 風險 |
|---|---|---|
| 1 | tail/open 載入＋快取＋skeleton（rc50 已有一半） | 低 |
| 2 | composer optimistic row＋enqueue ack | 中（要改 gateway admission 邊界） |
| 3 | queue/steer 狀態機與停止 timeout | 中 |
| 4 | 移除舊的 20k 初次載入與重複 snapshot | 低 |

## 七、結論

IH 不需要重寫整個 session engine；需要把「UI 狀態」與「durable admission」解耦，並把「載入」從全量分頁改成單次 tail。參考項目已經證明這是標準做法，且不需要新資料庫。
