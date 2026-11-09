# IH 側邊欄設計稽核（rc34）

測試環境：`D:\ih0113rc30test_env` 免安裝版 rc34，實際啟動並用 CDP 操作。
參考：DSH v0.2.2-alpha.2（ui-workspace）、OpenCode 2.2.6（home/sessions）、ZCode desktop（packages/ui WorkspaceSidebar／TaskList）。

## 一、先說結論

目前側邊欄的**資料與操作大致可用**（釘選、未讀、重新命名、批次管理、封存、分支、複製 ID、開資料夾都能跑），但**資訊層級與操作入口不一致**，而且有兩個明確的流程 bug：

1. 多個會話群組時，「批次管理會話／管理已封存會話」會重複出現。
2. 新會話（0 回合）在專案底下顯示「尚無會話」，但標題已是專案名稱；使用者看不到自己剛開的會話。

## 二、實測發現

### P1-1 管理入口重複（明確 bug）

選取專案後，側邊欄同時出現兩組：

```
ih0113rc30test
尚無會話
批次管理會話  管理已封存會話
未分類會話
未命名會話 · 1 回合 ...
批次管理會話  管理已封存會話
```

原因：`ProjectSessions` 在**每個群組**都渲染同一組 footer；專案與未分類各一份。
建議：管理入口只留一份，放在側邊欄底部（sticky）或「專案」header 的 overflow。

### P1-2 新會話不可見

在專案選取狀態按「新增會話」：
- 標題正確變成 `ih0113rc30test`；
- 但側邊欄專案底下顯示「尚無會話」，新會話只出現在「未分類會話」或完全不出現；
- 使用者無法從側邊欄確認「我剛剛開的會話在哪」。

參考 DSH：空白會話會立即以 `New Session` 列出現；OpenCode：建立即持久化。
建議：0 回合的 draft 也要有列（或明確的「新會話」列），送出後再換成正式標題。

### P1-3 封存錯誤顯示在選單內

`封存會話` 只檢查 running/queued；有待處理訊息時按下去，backend 回錯誤，`SessionActions` 把錯誤 `<p>` 放在選單最底部。
結果：選單變高、錯誤文字擠在邊緣（你先前截圖的「會話仍有待處理訊息…」就是這個），而且選單不會關閉。
建議：pending > 0 時直接 disable + tooltip；失敗用 toast，不要塞在 menu footer。

### P1-4 兩個「建立分支」語意不明

選單同時有：
- `建立分支`（resume 既有 fork attempt）
- `建立另一個分支`（fresh attempt）

兩個同 icon、同位置、名稱只差「另一個」，使用者不可能知道差別。
參考 DSH 只有一個 `Fork` 動作；OpenCode 沒有 fork 入口。
建議：只留一個「建立分支」；進階的 fresh 放二級選單或錯誤恢復提示。

### P2-1 會話列資訊不一致

實測列：`未命名會話` / `· 1 回合`，0 回合列是 `· 0 回合`。
- 前面直接接 `·`，沒有前文；
- 沒有相對時間（DSH／OpenCode 都以時間為主）；
- 4 列全部同名，無法辨識；
- meta 用 10px，管理連結 11px，专案名 13px，品牌 17px，字級跳躍。

建議：標題 + 相對時間（或 `新會話` placeholder）；回合數只在 >0 時以 badge 顯示；meta 統一 11–12px。

### P2-2 Icon 與操作語意不符

- `管理此會話` 用 `Archive` icon，和 `封存會話` 一樣；
- 兩個 fork 都是 `GitBranch`；
- 沒有 `刪除`（只能進批次管理按永久刪除）；
- 選單 9 項全平面，只有一個 separator。

建議：管理用 `Settings/Sliders`，fork 只留一個，刪除放 danger 區塊；選單分組（會話／分支／管理）。

### P2-3 管理連結太擠

量測：footer 可用寬 173px，`批次管理會話` 66px + `管理已封存會話` 77px + gap 8px，剛好塞滿。
字級 11px、高度 28px，和上面的 13px 专案列、10px meta 不一致。
建議：改成一行「管理會話…」開對話框（內含目前／已封存 tabs），或收進 header overflow。

### P2-4 新會話入口重複

左側 rail 的 `+` 和 sidebar 的「新增會話」都做同一件事；兩者視覺權重不同。
參考 DSH／OpenCode 都是一個主要 New session 入口。
建議：保留一個；rail 的 `+` 可改成「回到首頁／新增」單一語意。

### P2-5 選取會話時無條件寫入 read

`ProjectSessions` 每次點會話都呼叫 `onManageSession(..., 'read')`，即使本來已讀；失敗還會把整個 workspace snapshot 設成 error。
建議：只有 `navigation.unread` 為 true 才寫；失敗只提示，不覆蓋列表。

### P2-6 沒有搜尋／日期分組

DSH 有搜尋與 hover 操作；OpenCode 有搜尋、日期分組、skeleton、刪除確認。IH 目前只有全域搜尋 icon，sidebar 內無 filter。

## 三、參考項目做法

| 專案 | 會話列 | 操作 |
|---|---|---|
| DSH | 相對時間；hover 時時間換成 …；空白會話叫 New Session；title marquee；hover pin | 選單分項（Pin/Rename/Fork/Archive），單一 Fork，權限控制 |
| OpenCode | 日期分組、搜尋、skeleton、專案名 | 右鍵／…：Rename、Export…、Delete…（封存隱藏）；刪除有確認 |
| ZCode desktop | WorkspaceSidebar／TaskList：專案、置頂、時間線、歸檔四種檢視；hover 顯示 archive／pin | 選單有 Pin／Rename／Archive／Unread／Copy paths；Archive 兩段式確認；刪除只在歸檔檢視，需確認 |

共同點：**一列只放一個主要動作入口、資訊以時間為主、破壞性操作有確認、管理入口不重複**。

ZCode desktop 的歸檔模型特別值得參考：**歸檔只是隱藏＋可還原，不需要先清 pending；刪除只發生在歸檔後**。

## 四、建議修復順序

1. 移除重複 footer（P1-1）。
2. 新會話列／draft 可見（P1-2）。
3. 封存 pending → disable + toast（P1-3）。
4. 合併兩個 fork 為一個（P1-4）。
5. 會話列改成「標題 + 相對時間」，meta 統一（P2-1）。
6. icon／分組／刪除入口（P2-2）。
7. footer 改成單一「管理會話…」（P2-3）。
8. 搜尋與日期分組（P2-6，較大）。

以上是**稽核結果，尚未改動程式**；確認要修哪幾項後我再動。