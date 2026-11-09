# 「待處理訊息」與封存／刪除的研究（rc37）

## 先回答你的問題

你說得對：**想封存／刪除時，不應該先被迫處理待處理訊息**。目前擋住的是 backend 的 `assertIdle`，不是只有 UI；而且「待處理」在 UI 與 backend 的範圍不一致。

## 一、現在到底擋了什麼

`desktop-gateway/src/session-management.ts` 的 `assertIdle()` 會依序檢查：

| 錯誤訊息 | 實際內容 | 使用者能處理嗎 |
|---|---|---|
| `Session has pending durable inputs` | 佇列中尚未執行的使用者訊息 | 可以取消，但封存時沒必要 |
| `Session has active or pending durable agents/inbox` | 子代理 running／mailbox 未清 | 可能卡住、無法處理 |
| `Session has pending durable tasks/outbox` | task `accepted/running/recovery-required`、通知 `pending/delivered/error` | `recovery-required` 基本上無法處理 |
| `Session has active workflow work` / `Session is busy` | 回合、workflow、佇列 | 可以停，但不該強迫 |
| `Session has pending interactions` | 審批／問題卡片 | 可能是不想回答的錯誤 |
| `Session has active background producers` / Code Mode cells / terminals | 背景程序 | 可停，但不一定處理得了 |
| `Session has an unfinished durable turn` | 上次回合沒收尾（crash） | 正是最需要刪除的情況 |

`archive` 與 `delete` 都走同一條 `assertIdle()`（`mutate` 第 192–224 行）。所以只要有任何一項，就**封存也不行、刪除也不行**。

## 二、UI 的「待處理」其實是另一件事

- 側邊欄的 `attentionBySession` 來自 `pending` interactions（審批／問題），不是 backend 的全部 blocker（`app.tsx` 第 706 行）。
- 我們上一版把「有待處理」直接 disable 封存，等於只涵蓋 interactions，卻沒涵蓋真正難處理的 `recovery-required`。
- 這就是為什麼你會覺得範圍比想像大：UI 顯示的「待處理」只是冰山一角。

## 三、參考項目怎麼做

### DSH

`ArchiveSession.tsx`：封存不是「先處理完」，而是**確認後停止工作再封存**。

- 選單的 Archive 永遠可用（權限允許時）；
- 跳出確認對話框，列出目前活動；
- `stopAndArchiveSession` 由 Host 停止執行中的工作，然後 archive；
- 沒有要求使用者先清 pending。

### OpenCode

- 刪除有確認對話框（`view.tsx` 的 Delete…），不要求先處理 pending；
- Archive 功能預設隱藏（`SHOW_HOME_SESSION_ARCHIVE = false`）。

### ZCode

ZCode 的 desktop 版本有完整的「歸檔」流程（任務＝會話）：

- `packages/ui/src/TaskListItem.tsx`：hover 的 Archive 採**兩段式確認**（第一次點擊進入確認態，第二次按 destructive Confirm 才歸檔）；
- 有 pending interaction 時不顯示歸檔按鈕（`!hasPendingInteraction`），但這是 UI 層的互動狀態，不是 backend 的 idle 檢查；
- 歸檔只是 metadata（`zcodeTaskService.archiveTask`），任務從預設列表隱藏，可從「歸檔」視圖還原；
- 永久刪除只發生在**歸檔視圖**（`WorkspaceArchivedTasksFlatSection`），可單筆或批次刪除，不在一般列表直接刪。

這個模式值得 IH 參考：歸檔＝隱藏＋可還原，**不需要先清 pending**；刪除則只在歸檔後提供（單筆或批次，皆需確認）。

另外，ZCode 的 archive 動作在 **有 pending interaction 時會隱藏**（`!hasPendingInteraction`），但那是避免使用者在等待審批時誤操作，不是要求先處理完；archive 本身只是 metadata，沒有 backend idle 檢查。

## 四、合成後的最優設計（不額外發明機制）

### 封存：只做「隱藏＋可還原」

- 不呼叫 `assertIdle()`，不要求先清 pending；直接設定 `archived` metadata。
- 排隊訊息、審批、任務、子代理狀態**保留在原會話**；還原後可繼續。
- 若目前有執行中的回合：顯示一次確認（參考 DSH），確認後先停止目前回合再封存；排隊訊息保留。
- 若只是 pending inputs／interactions／recovery-required，不確認、不阻擋，直接封存。

### 刪除：只在歸檔後提供

- 沿用 ZCode：一般列表不提供刪除；永久刪除只在「已封存會話」管理裡。
- 刪除 archived session 時允許丟棄 pending durable inputs／interactions／tasks（反正都要刪），不要求先處理。
- 仍拒絕 **running turn／running agent／背景程序**；要刪就先把這些停掉，避免邊寫邊刪。
- 不新增 `force` API、不新增第二種刪除流程；archive 成功後自然就能刪。

### UI 最小改動

- `SessionActions`：移除「pending 就 disable 封存」；封存永遠可用（running 時確認）。
- 已封存管理：保留現有還原／永久刪除，只改 backend 對 archived 的刪除檢查。
- 不在一般會話選單加刪除（避免誤刪）；需要刪除就先封存。

### 為什麼不照單全收

- DSH 的停止後封存要接 Host 的 stop 流程，成本較高；IH 先做 metadata 封存，running 才確認停止。
- ZCode 的兩段式 inline confirm 是它自己的 hover 互動；IH 已有選單＋確認對話框，不重造。
- OpenCode 的 archive 預設隱藏，不適合 IH（IH 已有完整歸檔管理）。
## 五、實作落點（最小）

- `session-management.ts`：archive 走 metadata 分支，不進 `assertIdle`；delete 對 `profile.meta.archived` 使用「可丟棄 pending」的檢查。
- `SessionActions.tsx`：移除 pending guard；running 時顯示確認文案。
- `SessionManager.tsx`：文案改成「歸檔後可永久刪除」，不再說 pending 會阻止。
- 測試：archive with pending inputs/interactions 應成功；archived delete with pending tasks 應成功；running 仍拒絕。
## 六、風險

- 封存時若不停 live 工作，回合會在背景繼續跑；所以必須先 stop。
- 強制刪除會丟資料，需明確確認與審計記錄。
- 若 durable inputs 保留在 archived session，還原後要能繼續（目前應該可以）。

以上是研究結果；要我先做「封存永遠可用＋確認停止工作」，再做「強制刪除」嗎？