# 待辦與計畫 — 2026-09-20 · **活文件**

**這份文件是進度的家。** SDD 的 ledger 是 gitignored 的、會隨 session 死掉 —— **這一整天已經證明那等於不存在**（裁定只活在 ledger 裡、版控還在教被回退的做法，當場咬了一次）。

**規則：做完一件，就在同一個提交裡把它的狀態改掉。** 文件與事實不同步，它就變成另一份說謊的文件 —— 而那是這個 repo 一直在消滅的東西。

---

## 0. 怎麼接手（給被 compact 之後的自己）

1. **先讀 §1 的狀態表** —— 一眼看出「現在在哪」。
2. **再讀你要做的那一項的完整條目** —— 它帶著**為什麼排這個位置**、**驗收條件**、**已知的坑**。
3. **不要相信這份文件的行號** —— 它是**基準，不是事實**。**引用前先 `grep -n`**（這條教訓在這條分支上出現過四次）。
4. **做完時：改狀態、寫下實際量到的數字、把「為什麼」留在提交訊息裡。**

**前置閱讀**：`docs/handoff/2026-09-19-protocol-selection-phase-a.md`、`2026-09-20-protocol-selection-phase-b.md`（剛完成的單元，它的裁定與邊界是這裡好幾項的背景）、`2026-09-18-backend-backlog.md`（路線圖那份，本文件的來源一就是它）。

---

## 1. 狀態表 —— **一眼看出在哪**

| # | 項目 | 來源 | 狀態 | 卡在 |
|---|---|---|---|---|
| **W1** | **修 settings watcher race** | 三 | **✅ 完成**（`65838d8b`，修正輪中） | 無 |
| **W2** | 修 SDK 的訂閱洩漏 | 三 | **研究完成 → 照修但降級**（路徑不可達、觀測不到；見 §3） | 無 |
| **W3** | `schedule` 的 spec | 一 | **研究完成 → 卡在 Q2**（I5 把它接上了自啟） | **Q2** |
| **W4** | M5/T2 第二半（前綴偵測） | 一 | 未開始 | 無 |
| **W5** | M5/T4 schema 驗證層 | 一 | 未開始 | 無 |
| **W6** | M3 剩下的兩項（79 站點分級；redaction 繼續量） | 一 | 未開始 | 無 |
| **W7** | M6（廣度：生態＋介面硬化） | 一 | 未開始 | **依賴 M5** |
| **W8** | M7（自我喚醒與記憶） | 一 | **卡住** | **Q1／Q2** |
| **W9** | M4 只差 Q8 | 一 | **卡住** | **Q8** |
| **W10** | **前景 bash 的 120 秒死線** | 三 | **未開始**（2026-09-20 使用者指出） | 形狀待選 |
| **W11** | **子代理的健康訊號** | 三 | **未開始**（同上） | 形狀待選 |
| **Q1–Q8** | 四題產品決定 | 二 | **等使用者** | — |
| **P·A1–A7** | 階段 A 的 parked | 三 | 已記錄 | — |
| **P·B1–B9** | 階段 B 的 parked | 三 | 已記錄 | — |

---

## 2. **W1 — 修 settings watcher race**（第一個，而理由不是「它最重要」）

### 為什麼排第一：**它當初被 park 的理由已經過期了**

它被 park 是因為**不要污染即將被複核的分支** —— **而那個分支已經推上去了。**

**而它的代價是這一整天裡最貴的一種：約一半的全套跑會紅一條。** 這條分支上**每一個「全套綠」的主張都建立在一個一半機率說謊的套件上** —— 包括報出去的那個 `2586 passed`。**先修它，後面每一件的驗證才站得住。**

### 現況（量測，不是推論）

`packages/settings` 的 `test/layering.test.ts:201`（*"M40 A6 settings/changed hot-reload"*）以 `expected 2 to be 1` 失敗，**平行全套跑約一半機率**，隔離跑必過。測試用 `watchIntervalMs: 10`，寫一次檔，等 200ms，**斷言恰好 1 個 `settings/changed`**。

### 完整機制 —— **三個來源、跨兩層**

**第 1 層：`watchSettings`（`packages/settings/src/index.ts` 尾端）**

```ts
void capture().then((snap) => { … snapshot = snap; onChange(file) })
```

- `capture()` 要 `stat`（async），而每個 tick 都 `void` 它、**不等** ⇒ **多個 capture 同時在飛，而先發的可以後到** ⇒ 把 `snapshot` 覆蓋成舊值 ⇒ 下一個 tick 又看到「變了」⇒ **第二次 `onChange`**。
- `writeFile` **不是原子的**（先截斷再寫）⇒ **一次寫入本來就能呈現兩個狀態**。

**第 2 層：store 的處理器（同一支檔案，`watchSettings(...)` 的呼叫端）**

```ts
const before = this.current          // ← 同步快照
void this.reloadFromDisk().then((settings) => {
  if (settings !== before) emit      // ← await 之後才比較
})
```

**兩個 `onChange` 落在同一次 reload 的延遲內 ⇒ 兩個都看到同一個（改動前的）`before` ⇒ 兩個都 emit。**

**任何一層單獨都足以產生這個 bug。**

### 驗收

**一次寫入 ⇒ `changed.length === 1`**（原本那條測試的斷言就是規格）。

**另外必須新增一條**：**真的連續兩次寫入必須回報 2 次** —— 證明修正沒有把合法的第二次也吞掉。**那是這個修法最可能的錯法。**

### 設計（已定）

| | 修哪裡 | 效果 |
|---|---|---|
| **C（主）** | **store 端的 conflate** —— reload 在飛時不另開，改成標記 dirty、結束後再比一次 | **單獨就能讓斷言成立**：第二次 `onChange` 被吸收；重載後 `this.current` 已等於磁碟 ⇒ 不 emit |
| **A（輔）** | watcher 加 **in-flight guard** | 修 watcher 自己的缺陷（亂序覆蓋會讓同一個改動被重複偵測） |

**C 修的是「一個已定型的狀態只回報一次」—— 那才是 `settings/changed` 真正的語意。A 修的是 watcher 自己的缺陷。兩者是真的不同的缺陷，都修。**

**不做 debounce**（用時間窗合併偵測）：它要多選一個窗口常數，而且會把**真的連續兩次寫入**也合併掉。**conflate 比較的是狀態，不是時間。**

### 提交訊息要寫下的
**這個 bug 的三個來源**（亂序覆蓋、非原子寫入、無 conflation）—— 因為下一個人看到「加了守衛」會以為修完了。

---

### ✅ **W1 已完成 —— `65838d8b`**，以及**那句要原樣放進記錄的話**

**複審：spec PASS · 品質 APPROVED。** 而 **它把那個非原子視窗量出來了**：一條緊密的 stat 迴圈在 **30 次單一 `writeFile` 裡觀察到 26 次截斷（size 0）的狀態** —— **不是微秒級的理論窗口**。

#### ⚠ 證據證明了什麼（**審查員寫的原文，一字不改地放進這裡**）

> **「機制被關上了**：三個來源都在修正前的程式碼裡讀得到，store 那一層有證偽，而且在強制 1ms 輪詢下，修正前的樹產生了重複報告（**2 / 225 個樣本**），而修正後的樹**一個都沒有**（**0 / 300**，外加 10ms 下帶負載的 0 / 200）。**但「~50% 的比率消失了」沒有被證明**：在測試自己的 10ms 間隔下，base 在這台機器的 **48 次滿載 12 路並行裡沒有失敗過** —— 所以被支持的是**「產生那次多餘報告的機制被移除了」，不是「記錄下來的比率消失了」** —— 那個比率需要當初量到它的那個環境。」

**這是這份文件裡最重要的一句話**，因為**它區分了兩個很容易被混為一談的主張**：「機制被關上」與「比率歸零」。

#### ⚠ 而我要更正我自己的說法

**我把它排第一時說「它讓每一項的驗證都不可信」—— 那成立。但我不能說它是在修一個使用者會遇到的 bug。** 複審**確認**：`LayeredSettingsStore`／`createLayeredStore`／`watchSettings` **早就列在可達性基線的 unused exports 裡**（`scripts/audit/reachability-baseline.json:340,365,374`）。

**所以 W1 修的是兩件事，都不是產品 bug：**
1. **驗證的地基** —— 一個約一半機率說謊的套件，會讓後面每一個「綠」都被誣告。
2. **一個未來宿主會走到的路徑上的潛伏缺陷** —— `LayeredSettingsStore` 有消費者那天，它就會動。

#### 那條 caveat 的處置

**它今天重現不出那個 flake**（6/6 全套綠、4 倍並行綠）。**而複審獨立確認了同一件事**（base、測試自己的 10ms、12 路並行 ＋ 4 個 CPU burner：**0 紅 / 48 次**）。**只有強制才逼得出來**（1ms 輪詢 → 2/225）。

**所以這條的證據是「機制 ＋ 證偽」，不是「前後比率」** —— 而**那個區別寫在上面那句話裡，不藏在腳註裡**。

#### 兩條 Low（**這個修正引進的、狹窄的回歸**）→ 修正輪中

| | |
|---|---|
| **F1** | 一個落在**會拋錯的重載**裡的偵測會被丟掉，而那條已定型的狀態**可能永遠不被回報** —— **而那句註解聲稱它會重新檢查** |
| **F2** | 重新檢查**沿用第一次偵測的 `path`** ⇒ **第二個檔案的變更被用錯誤的路徑回報**（探針量到：`[a.json, b.json]` ⇒ 兩個事件都帶 `a.json`）。**`data.path` 是使用者可見的欄位 —— 那是這個單元的類別：一個錯的答案被講成對的** |

**而複審的關鍵註記**：**沒有生產消費者 ⇒ 沒有別的地方能抓到這兩條 ⇒ 這個測試檔是唯一的驅動者。** 一條多檔路徑斷言就釘得住 F2。

#### 順帶歸因並洗清的一件事（**不是我們的、也不是新的**）

`packages/sdk` 之外的那個 `mcp-client` worker 崩潰（`ERR_IPC_CHANNEL_CLOSED`）：**tinypool 的 worker-send race**，堆疊指向 **vitest 池的** send 路徑；**在 HEAD 重現 1/20**；**2026-09-17 的舊 scratch log 裡有完全相同的堆疊**；`packages/mcp-client` 最後一次改動是 **2026-09-09**（逐位元相同）且**零依賴 `@i-harness/settings`**；repo 自己的 M31 註記把這個錯誤碼記成**已知的 Windows tinypool 問題**。**值得一張獨立的 harness ticket，不是 W1 的 finding。**

---

### ✅ **W1 完成 —— 三個提交**：`65838d8b`（本體）＋ `2dae6439`（F1/F2）＋ `361358f0`（被丟棄的回報）

**複審的兩條 Low 都修好了，各有指名的紅行**：還原 `snapshot = snap` → `test/layering.test.ts:287`（`expected [] to have a length of 3 but got +0`）；一次耗盡整個佇列 → `:493`。

#### 第三輪的發現：**同一類缺陷，方向相反**

實作者找到並（依裁定）修好了一條**它自己沒折進來**的：`watchSettings` **一個 tick 只回報一個檔案**，卻把 `snapshot` 推進到**整份 capture** ⇒ **兩個被看的檔案在同一個 tick 內都變時，第二個的變更永遠不回報**，直到它再變一次。

**它說「修它會改變契約」—— 前半對、後半我不同意**：契約（"one batch per tick"）**正是現在的程式碼在違反的**；正確的形狀是**只推進剛回報的那個**。

**而它是 must-fix，理由實作者自己量到了**：**那正是讓它剛加的 F2 釘子不穩的原因**（兩個檔案同 tick 變 ⇒ 第二個被丟）。

**它選了 DEFER 並拒絕了「一個 tick 回報全部 N 個」，理由是對的**：「**契約是一個節流器，而我的發現是程式碼違反了它，不是它錯了。**」**成本已陳述**：N 個檔案同 tick 變 ⇒ 每 tick 回報一個（最多 N−1 個間隔的延遲；N 實務上是 1–3 層）。

#### ⚠ 而有一件事**沒有做，理由是明說的**

**我沒有派第四輪複審。** 理由：三個修正各有指名的紅行；**這個套件沒有生產消費者**，所以它唯一被陳述的成本（deferral 的延遲）**今天觀測不到**；而這會是一個**不擋任何東西**的項目的第四輪。

**但義務寫在這裡**：

> **誰給 `LayeredSettingsStore` 第一個消費者，誰就要重新審這個檔案。** 那才是第四輪該發生的時刻 —— 不是現在。

（2026-09-20 當天，`LayeredSettingsStore`／`createLayeredStore`／`watchSettings` 三個匯出**都在可達性基線的 unused exports 裡**。）

---

## 3. **W2 — 修 SDK 的訂閱洩漏**

### 現況（階段 B 的終審量到的）

`packages/sdk/src/server.ts`：`assemblyUnsubscribes.set(assembly.sessionId, unsubscribe)` **覆蓋同一個 session 的前一個訂閱而沒有先退訂**，而 `close()` 只退當前那個。

### 代價
**每次 assembly 重建洩漏一個訂閱。**

### 驗收（**原本寫錯了，已量測後更正**）

**原文寫的是**：「一個重建路徑之後，訂閱數回到基準；**而且觀測得到**（不是靠讀程式碼）。」

⚠ **那條以今天的接縫不可能滿足，而我當初寫的時候沒有量。** 量到的：`subscribers` 是 `core-session` 的**模組私有 `WeakMap`**（`packages/core-session/src/index.ts:308`，沒有匯出存取器）；`assemblyUnsubscribes` 是 `server.ts:170` 的**函式內 const**；`SdkServer` 只暴露 `handleLine`／`onNotify`／`close`。**沒有東西能數訂閱。**

**更正後的驗收**：修好之後，**測試直接釘那個 map 的契約**（用 `assembly.ts:167` 支援的靜態 `session:` 選項驅動兩次 `onAssembly`，或對 stub 連續觸發兩次掛鉤），**並在測試裡明說它釘的是「覆寫前先退訂」這個契約、不是一條出貨路徑** —— 因為**出貨路徑今天不可達**（見下）。

**一個假裝在測出貨路徑的單元測試，比沒有測試更糟。**

### ⚠ 這條為什麼被降級（量測，2026-09-20）

**重建的觸發路徑在 sdk 行程裡不可達**，而這是追出來的、不是推論的：

- `onAssembly` 全 repo **只在一個地方觸發**（`packages/session-executor/src/service.ts:366`），而 `assemblies` 只有三個寫入點：`set`（首次建立）、`delete`（只在 `closeSession` 內）、`clear`（只在 `close()` 內，之後建立會 throw）。**所以 `closeSession` 是唯一的重建使能者。**
- **階段 B 移除了 SDK server 的 `closeSession`**（`0807c2b0` 的 diff 可見 `- await service.closeSession(p.sessionId)`；今天 grep `server.ts` 的 `closeSession` 只剩那句說明它是刻意的註解）。
- **全 repo 的 `closeSession(` 呼叫者**：ACP 的 `session/close`（**另一個子指令、另一個 service**）、定義本身、測試。**`apps/cli` 零、`packages/sdk` 零。**
- **SDK 的 wire 沒有 `session/close`**（19 個 case 全部列過）。

**而修好它不會拿走任何東西**：`subscribe` **以 `Session` 物件身分為鍵**，而**每一條出貨的重建都拿到全新的 `Session`**（`durable-session.ts:12`、`assembly.ts:394`）—— 所以那個漏掉的 closure **坐在一個已經死掉的物件上**，沒有事件會再抵達它。

### 裁定：**照修，但標示清楚它測的是什麼**

它**不是一個功能，是一個共享路徑上的潛伏缺陷**。**任何人加上 `session/close`（一個很自然的下一個功能），它就上膛。** 三行的修正、修法顯而易見，**所以照修** —— **但測試必須誠實標示它釘的是契約、不是出貨路徑。**

### ⚠ 同一個類別的第二個實例 —— **它修不了同樣乾淨**

`apps/cli/src/index.ts` 的 `liveAssemblies`（`service.onAssembly` 裡 `Map.set`、**全檔無清理**）握著的是**整個已銷毀的組裝**，比一個 closure 重。

**而它不能照抄同樣的修法**：語意上正確的拆除點是**組裝銷毀**，而 **`SessionService` 沒有 `onAssemblyDisposed` 這種掛鉤** —— `onAssembly` 給你一個組裝，沒給你它的死亡通知。**所以這一條要嘛等那個鉤子出現，要嘛在同一批加上它。**

**兩者共享同一個不可達的觸發條件 —— 所以武裝那個觸發條件的人，要一次處理兩個。**

### 已知的坑
階段 B **移除了 SDK server 的 `closeSession`**，所以**在 sdk 行程裡這條重建路徑現在跑不到**。修它必須**先證明路徑可達**（或在別處驅動），否則就是修一條沒有輸入的路 —— **那是這份文件在別處拒絕的那種東西。**

---

## 4. **W3 — `schedule` 的 spec**

### 為什麼排這裡
backlog §6.1：**它是五個零消費者套件裡唯一不需要前端的**，而它**缺的三件會互相決定**（agent 用什麼工具建立排程／driver 讀什麼／`onDue` 交給誰）。

> **邊接邊發明等於把三個決定拆成三次猜。**

**而 `plugin-registry` 是反例** —— 它的兩端都建好了、中間被切斷，**那種缺口稽核才看得出來、人看不出來。**

### 交付物
**一份 spec，把那三件一次定清楚**（不是實作）。

### ⚠ 研究完成（2026-09-20）—— **三個互鎖是低估了，量到九個。而其中一個是閘門。**

**地形：** `packages/schedule` 是一個**純函式庫**（只依賴 `core-session`，無 I/O）：23 個匯出 ＋ `./driver` 子路徑 5 個。**而它不可達** —— `@i-harness/schedule` 在**任何 import 裡都不出現**（自己的測試除外），`createScheduleDriver` **零個非測試呼叫者**。

| 三件事 | 實況 |
|---|---|
| **agent 用什麼工具建立排程** | **完全不存在（零）** —— 但模板在：`createTodoTool`（`todo/src/index.ts:31-65`）就是「工具自己 `append(session, …)`」 |
| **driver 讀什麼** | **半現** —— `schedule/change` 的形狀**已經宣告在 `core-session`**（`:85-89`）且**已經註冊進 load gate**（`session-persistence/src/index.ts:199-202`）；**但從來沒有東西 append 過一個** |
| **`onDue` 交給誰** | **參數存在、零供應者** —— 而它指名的那條線（*"the A1-inbox wire"*）是真的：`ParentInputAdmission`（`apps/cli/src/run.ts:358-372`）**就是 `onDue` 會變成的東西** |

**九個互鎖（每一個都量過）：**

| | |
|---|---|
| **I1** | **三個決定其實是一個決定** —— 選了 tier 就決定了 payload，也決定了 framing 那句話是誰在說 |
| **I2** | **沒有任何獨佔機制**（無 lease、無鎖）。兩個驅動器對同一個 session-dir ⇒ **各 append 一次 dispatch** ⇒ 折疊器拋 `dispatch targets inactive id` ⇒ **那個 session 從此每個 tick 都被跳過** —— **一份合法日誌被自我判成損壞**。先例：`agent-team/src/scheduler.ts:97` 的 `liveTeams`（*"a second mount is a hard error, not a silent shadow"*） |
| **I3** | **驅動器沒有 in-flight guard**（`setInterval(() => { void tick() })`，零合併）—— **而 W1 剛修的正是這個。同一個 bug 的第二個地方。** dsh 結構性解掉（一個推導計時器 ＋ 一個 per-agent 的交易鏈） |
| **I4** | **fork 的繼承**：`foldScheduleEvents(events, seedLength)` 的接縫**就是為此存在**，而**驅動器沒用它**（`driver.ts:86` 不傳 seed）—— 而且它吃的是 `SessionEvent[]`、**不是 `Session`**，所以**讀不到 `header.seedLength`**。dsh 的規則是相反的。**這是只有宿主出現後才會顯形的 API 形狀決定** |
| **I5** | **⚠ 閘門：那個觸發條件就是 Q2。** 見下 |
| **I6** | **投遞側的注入防護做好了**（動態欄位 JSON 轉義、prompt 標成 untrusted、有測試）；**建立側零閘門** —— prompt 只驗非空，**工具不存在**，所以**沒有東西決定「模型能不能替自己排未來指令、幾個、多遠」**。現有的旋鈕只有一個下限（300 秒）、一個年份窗口、**沒有數量上限**。對照：cc-custom 有 `MAX_JOBS = 50` ＋ 7 天到期 ＋ kill switch；dsh 有 flush barrier ＋ maintenance claim |
| **I7** | **讀取的成本決定 poll 模型**：driver 的契約是**逐 session 拉**，而一個誠實的宿主每個 tick 要對**每一個 stored session** 做一次完整 `coordinator.load()`（含 repair/migrate/guardIgnorable）。dsh 只讀**活的 agent 的記憶體尾段** ＋ 一個推導計時器 |
| **I8** | **來源那側的影子最長**：session-local（寫進呼叫它的那個 session 的日誌，id 空間也是 session-local）vs 一個 store —— **會改變「投遞模式」「冷啟動後誰重送」「任何 list/cancel 要不要載入那個 session」的全部答案** |
| **I9** | **crash 視窗的契約沒寫** —— append 與 `onDue` 之間崩潰，reminder 是重複還是丟掉？**而這個 repo 有先例說這種契約該寫在哪裡**：200ms write-behind 的損失契約**寫在崩潰報告裡**，「因為那是有人需要它的那一刻」 |

### ⚠⚠ **W3 的 spec 寫不下去 —— 原因不是資料不夠，是 I5。**

**一個到期的排程在閒置的 session 裡開一個新的 turn ＝ 路線圖的「無外部觸發的自啟／閒置自我喚醒」＝ Q2。**

**而路線圖自己的話**（`2026-09-15-backend-polish-roadmap-design.md:225`）：

> **「政策列假裝成工程列。沒有答案，任何 T5 工作都是投機。且必須等 M4 —— 沒有 attempt record 的自我喚醒就是迴圈產生器。」**

| Q2 的答案 | spec 可以走的路 |
|---|---|
| **是** | 「排隊，讓 lane 的閒置排水開一個 turn」—— **但必須先等 M4** |
| **否** | **「只投遞進一個已經在跑的 turn」** —— **這條現在就能寫**，而且它與 dsh 的契約**相反**（dsh：*"never calls steer() and never interrupts a current turn"*） |

### ⚠ 而這是它給的警告，值得寫在這份文件裡

**`cc-custom` 有一個完整實作的排程子系統，而它在自己的 build 裡完全不可達**（`cronTasks.ts` 448 行、`cronScheduler.ts` 530 行、一個 cron 工具、一個 scheduler hook —— 全都有，而沒有東西能啟動它）。

**那正是 W3 在處理的形狀。** `createScheduleDriver` 今天有**零個**非測試呼叫者，而 **`schedule/change` 的形狀早就躺在 `core-session` 與 load gate 裡** —— **IH 離重複 cc-custom 只差一步，而差的那一步就是「有人記得接上去」。**

### 參考專案（四份都查了）

| 專案 | 排程 |
|---|---|
| **dsh** | **完整實作 —— 捐贈者。** 三個工具、session log 持久化、**沒有 callback**（`whenIdle()` 之後直接 `agent.followup()`，而且**先 claim maintenance 階段**）、**一個推導計時器而非輪詢**、**批次語意**（多個 overdue 的 every 併進同一個 follow-up，**用來界定 model turn 數**），而且**把自己的 crash 視窗寫成已知限制** |
| **cc-custom** | **完整 cron，build 裡不可達**（見上） |
| **codex** | **沒有排程器**；有 model-facing 的 `clock.sleep`（turn 內延遲）＋**客戶端持有的時鐘**＋「既有工作的閒置喚醒」 |
| **opencode** | **找不到** —— 它把排程**外包給 GitHub Actions 的 cron** |
| **pi** | **找不到** |

---

## 5. **W4／W5 — M5 的兩半**

設計在 `docs/superpowers/specs/2026-09-18-m5-t2-prompt-cache-continuity-design.md`。

| 半 | 現況 |
|---|---|
| T2 第一半（以 provider 回報為事實） | ✅ **完成** |
| **T2 第二半（以自己的位元組為偵測）** | **未動** |
| **T4 的 schema 驗證層** | **未動** |

### W4 為什麼值得做（三件事，**本文件自己重測過，行號量於 `6b04f31d`**）
1. **缺口不是推論出來的，是兩個 adapter 各自記下來的** —— `packages/llm-gemini/src/index.ts:239,241`（*"same gap as…"*、*"a future usage seam slot"*）與 `packages/llm-bedrock/src/index.ts:228`（*"same gap as…"*）。**它們自己寫著這個縫還沒接。**
2. **一份現成的 fixture 早就在樹裡** —— `packages/llm-bedrock/test/bedrock.test.ts:161`，測試名叫 *"it **ignores** the metadata/usage member (no usage event in the seam vocabulary)"*，它餵進 `usage: {inputTokens: 5, …}` 而 adapter 丟掉。
   ⚠ **準確地說：那是一根「釘住現行忽略行為」的釘子，不是一個現成的紅燈。** 它的價值在於**輸入已經有了** —— 要做這一項**不需要憑空造 fixture**，而**那根釘子會從「釘住忽略」變成「要求改變」**，這是刻意的。
   （backlog 把它寫成「現成的紅燈」，**那是措辭比事實多**；這裡改成量到的說法。）
3. **一個實測到的缺陷，靠寫測試才發現** —— `createRetryingClient` 的重試是**靜默的**，而它的用量事件第一版是即時 `yield` 的，所以**一次完成的往返收到兩份報告**。

---

## 6. **W6 — M3 剩下的兩項**（都不是 M4 的前置，被排在後面）

| 交付物 | 現況 |
|---|---|
| benchmark harness | ✅ `b6e1f02` |
| fail-loud 崩潰 ＋ 優雅關閉 | ✅ `ede0850` ＋ `8c34ca1` |
| **本地結構化診斷日誌** | ⚠️ **一半** —— 報告已結構化；**79 個 `console.warn/error` 站點沒有分級**。量過：那些訊息確實是**不同類別被壓平**，所以分級**有價值** —— 但那是 79 處的遷移 |
| **secret redaction** | ⚠️ **缺口示範不出來** —— 見下 |
| in-process metrics registry | ✅ `58d7db6` |

**「secret redaction」為什麼標成「示範不出來」而不是「未做」：** 遮蔽**已經存在**於 view 那一域（`settings/sections.ts` 的 `redactForSchema`／`redactRecord`，帶 `secret`/`credential-ref` 兩種角色）；日誌那一域**沒有任何 console 站點印出 config 物件**；金鑰只在 adapter 邊界的 header 進出，而 telemetry **從未見過 `apiKey`**。

**處置是「繼續量」，不是「先建一個濾網」** —— **一個沒有已知輸入的濾網，正是這份文件在別處拒絕的那種東西。**

---

## 7. **Q1–Q8 — 四題等你決定**（我動不了）

| # | 問題 | backlog 的建議 | 卡住 |
|---|---|---|---|
| **Q1** | IH 要不要有專案層設定信任？ | **暫不**（「第二個真相來源」論證） | **W8** |
| **Q2** | 閒置自我喚醒是不是產品目標？ | **✅ 2026-09-20 使用者裁定：否。** 「時間到了 → 在閒置的 session 開一個 turn，這個我覺得沒必要」。**而 W3 的閘門因此解開**：`schedule` 只能在不自啟的形狀下寫 —— 見 §4 的 I5。**附帶效果：W11 的提醒不能來自時鐘** | **W8**（仍卡 Q1） |
| **Q7** | 設定是不是前端的事？ | **是（走 (a)），但現在不建** —— 觸發條件是前端做到需要設定面 | `sections.ts` 的處置 |
| **Q8** | 舊日誌要不要保守？今天寫的每一份 log 都沒有 `tool/dispatch`，所以復原**分不出**「沒派送」與「派送了、下落不明」 | **保守：一律 `outcome-unknown`** —— 代價是舊 session 的工具全部要人看；不保守則**把一個我們明知不知道的東西判成 benign** | **W9** |

**Q1／Q2 不答，M7 不動；Q7 不答，只是不要在它上面蓋東西。**

---

## 8. 來源三 —— A 與 B 留下的 parked（**逐條附代價**）

### 階段 A（`docs/handoff/2026-09-19-protocol-selection-phase-a.md` §5）

| # | 是什麼 | 代價 |
|---|---|---|
| **A1** | 拒絕訊息的 `<one of: …>` 尾巴**貼進 shell 不安全** | 貼了吃 shell 錯誤（緩解：值已印在同一行） |
| **A2** | 形狀釘而非成員釘的斷言（runtime 那兩條已改成成員釘） | 未來清空清單會通過兩條本該失敗的斷言 |
| **A3** | **`provider/src/index.ts` 那句 `?? "openai-completions"` 留著、不可達、已加註解** | 未來一個非 runtime 的呼叫者傳入無協議請求，會拿到**靜默的 Bearer 尾巴** |
| **A4** | **settings watcher race** | **→ 就是 W1** |
| **A5** | `models.ts` JSDoc 的兩個措辭 nit（一條把優先序寫反） | 讀型別註解的人可能把順序當成優先序 |
| **A6** | `MODELS_USAGE` 的 `auto` 那行省略了鏈的最上層 | 字面上不是普適的 |
| **A7** | `CAPABILITIES-DETAIL.md` 的 `（M31 空）` 出處標註略偏 | 出處標註略偏 |

### 階段 B（`docs/handoff/2026-09-20-protocol-selection-phase-b.md` §5）

| # | 是什麼 | 代價 |
|---|---|---|
| **B1** | **訂閱洩漏** | **→ 就是 W2** |
| **B2** | `liveAssemblies` 從不清理 | **本單元移除 teardown 之後，sdk 行程再也產生不出那個屍體視窗** |
| **B3** | **壓縮視窗**是建構時設定 | rebind 到更小視窗 → 最後由提供者拒絕那一回合；到更大視窗 → **摘要被更頻繁地計費（靜默成本）** |
| **B4** | 沒有活組裝的 session 上的協議只在行程內 | `rebindModel` 回 `false` 而不是假裝成功 |
| **B5** | 未知協議以 `-32603` 拒絕 | 擅長判斷 code 的客戶端會把參數錯誤讀成「內部錯誤」 |
| **B6** | rebind 對上 close 的競態沒測試 | 終審判定**在出貨的宿主裡不可達** —— **stated cost 反而偏高** |
| **B7** | **兩個既有的過期引用**（`fork.ts` 與其測試；`sandbox-policy-per-call.test.ts`） | 已驗證**不是 A/B 的債**。**注意 `:405` 本身也曾是錯的** |
| **B8** | **提交訊息 `4fb63447` 誇大了 M5 的突變爆炸半徑** | **不可修 —— 提交不 amend。** 記下來是因為**下一個重跑那四個突變的人會低估三個** |
| **B9** | `docs/CAPABILITIES-DETAIL.md` 的多處漂移 | 已驗證在本單元之前就錯了 |

**B3 的注意**：它的**行為**可以被 park，但**理由與代價不可與 F-1 不同標準** —— 階段 B 的計畫末尾已經把這件事寫正了。

---

## 8.5 **W10 · W11 —— 使用者 2026-09-20 指出的兩件，不在原本的來源一二三裡**

**這是我的疏漏**：這兩件都不在路線圖、不在 A/B 的 parked 裡，而**使用者一講就對上了真實的痛**。

### **W10 —— 前景 bash 的 120 秒死線**

**量到的（不是推論）：**

```ts
// packages/session-executor/src/assembly.ts:404
const shellTimeoutMs = opts.shellTimeoutMs ?? 120_000
```

而 `guard-timeout` 在逾時時**中止那個指令**（`tool call timed out after 120000ms`）。**`timeoutMs === undefined` 時它直接放行** —— 所以是那個 120 秒的預設在作用。

**⚠ 而使用者原本的描述是「可能卡住主代理」—— 量到的更糟：它不卡，它在第 120 秒被殺。** 殺在半路比慢更糟：`docker build`、資料庫 migration、跑到一半的 `git` 操作 —— **工作沒了。**

**逃生口存在，但那是模型的賭注**：bash／pwsh 工具都有 `background?: boolean`（說明：*"background: true returns a job id instead of waiting"*），而**模型必須在指令跑起來之前就知道它會超過 120 秒**。猜錯就死。**沒有任何東西會在超過門檻之後自動轉背景。**

**三個候選形狀（待選）：**

| | 形狀 | 代價 |
|---|---|---|
| **(i)** | **超過門檻自動轉背景** —— 前景跑到 N 秒就交回一個 job id | 改變「前景」的語意；模型原本期待一個結果，拿到一個 id |
| **(ii)** | **更好的預設值** —— 從指令形狀推（`docker build`、`npm install` 之類） | **那是猜** —— 而這個 repo 的立場是「不要猜」 |
| **(iii)** | **讓那個死是可續的** —— 保住部分輸出，讓模型能重跑或接手 | 最大，但它不改變任何語意，只保住**已經產生的東西** |

**驗收**：一個跑超過 120 秒的前景指令，**不會靜默地失去它的工作** —— 而失敗必須讓模型**看得出是哪一種**（逾時，不是指令本身失敗）。

### **W11 —— 子代理的健康訊號**

**原語全都在**（`packages/subagent/src/tools.ts`）：`spawn_agent`、`wait_agent`、**`list_agents`**、**`send_message`**、`interrupt_agent`、`followup_task`、`close_agent`、`resume_agent`，外加 `job_output`／`job_list`／`job_kill`／`get_task_output`。

**所以缺的不是能力，是時機**：主代理**只能在它自己的回合裡**去查，而**沒有任何東西提醒它「這個子代理已經跑了 20 分鐘」**。

**⚠ 而 Q2 = 否 把形狀定死了：提醒不能來自時鐘。** 所以它只能在**主代理本來就在跑的時候**出現 —— 例如：**在那個子代理的通知送達時，順帶告訴主代理它跑了多久**（那條路徑已經存在：`onTerminalized` → drain → admit，見 §2 的表格）。

**驗收**：一個跑了很久的子代理，**在它下一次與主代理有互動時**，主代理**知道它跑了多久** —— 而且**不靠任何計時器開 turn**。

---

## 9. 執行順序與理由

```
W1  修 settings watcher race        ← 現在做。它讓後面每一件的驗證站得住
W2  修 SDK 訂閱洩漏                 ← 但要先證明路徑可達，否則先不做
W3  schedule 的 spec                ← 先寫 spec，不要先接線
W4  M5/T2 第二半                    ← 路線圖的下一個實作
W5  M5/T4 schema 驗證層
W6  M3 剩下兩項（79 站點；redaction 繼續量）
W7  M6                              ← 依賴 M5
W8  M7                              ← 等 Q1／Q2
```

**W1 為什麼第一**：它不只是「一個 bug」—— 它是**驗證的地基**。**一個一半機率說謊的套件，讓後面每一項的「綠」都不可信。**
**W2 為什麼第二但可能不做**：它是真缺陷，但**階段 B 移除了它的觸發路徑** —— **先證明可達，否則就是修一條沒有輸入的路。**

---

## 10. 這份文件**沒有**建立什麼

- **沒有時程** —— 這份 repo 的慣例是**順序**，不是日期。
- **沒有替使用者回答 Q1–Q8** —— 那四題只有他能答，建議已附。
- **沒有重複路線圖與兩份 handoff 的內容** —— 它只**指向**它們，並記下**現在在哪**。
