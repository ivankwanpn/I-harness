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
| **W2** | 修 SDK 的訂閱洩漏 | 三 | **✅ 完成**（`2bbf0d20`；**照修但降級** —— 契約已釘住、路徑仍未武裝，見 §3） | 無 |
| **W3** | `schedule` 的 spec | 一 | **研究完成 → 卡在 Q2**（I5 把它接上了自啟） | **Q2** |
| **W4** | M5/T2 第二半（前綴偵測） | 一 | 未開始 | 無 |
| **W5** | M5/T4 schema 驗證層 | 一 | 未開始 | 無 |
| **W6** | M3 剩下的兩項（79 站點分級；redaction 繼續量） | 一 | 未開始 | 無 |
| **W7** | M6（廣度：生態＋介面硬化） | 一 | 未開始 | **依賴 M5** |
| **W8** | M7（自我喚醒與記憶） | 一 | **卡住** | **Q1／Q2** |
| **W9** | M4 只差 Q8 | 一 | **卡住** | **Q8** |
| **W10** | **前景 bash 的 120 秒死線** | 三 | **✅ 完成**（`b8bd78b0`，形狀 (i) 自動轉背景；修正輪 `0794fbe7`） | 無 |
| **W11** | **子代理的健康訊號**（三塊） | 三 | **✅ 完成**（`22b20c30`，三塊都在，見 §8.5 的完成記錄） | 無 |
| **W12** | ~~`wait_agent` 的門檻~~ → **換成：`spawn_agent background:false` 逾時時說「settled」** | 三 | **✅ 完成**（`ad8dca47`；見 §8.5 的完成記錄） | 無 |
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

**更正後的驗收**：修好之後，**測試直接釘那個 map 的契約**（用 `AssemblyOptions.session` 支援的靜態 `session:` 選項驅動兩次 `onAssembly`，或對 stub 連續觸發兩次掛鉤），**並在測試裡明說它釘的是「覆寫前先退訂」這個契約、不是一條出貨路徑** —— 因為**出貨路徑今天不可達**（見下）。

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

### ✅ **W2 已完成 —— `2bbf0d20`**（**照修、降級的理由不變**）

**修法（三行）**：組裝橋在 `assemblyUnsubscribes.set(...)` **之前**先做 `assemblyUnsubscribes.get(assembly.sessionId)?.()` —— 先讀出舊訂閱並釋放，再存新的。（以**符號**記：本輪的註解修正把它從 `server.ts:182` 移到 **`server.ts:187`**，而下一段插入還會再移一次。）

**⚠ 而複審把一句比事實更寬的話抓出來了（並量了四種順序）**：**負載的是「讀」，不是「釋放」的位置。** 讀取必須發生在**覆寫之前**（先把舊 closure 抓到手）；**釋放呼叫本身可以在 `set` 之後** —— `capture → set → release` 這個形狀**三條斷言全過（1/1/0）**，實作者與複審各自量過。真正會壞的只有**把讀回放在 store 之後**（讀到的是**新的** closure）：那是實測到的反向 bug，見下的第二條證偽。**原句「順序是負載的」會讓下一個人避開一個能用的寫法** —— 那才是這句話真正會造成的損失。註解（`server.ts` 與測試檔頭）都已按量到的事實改寫。

**測試**（`packages/sdk/test/server.test.ts`，describe `createSdkServer assembly bridge (W2)`）：**它自己就寫明它釘的是 map 的契約、不是出貨路徑**（理由：見上，一個字沒改）。驅動方式：**真的 `SessionService`** ＋ `AssemblyOptions.session`（host-pre-seeded；`sessionFor` 缺席時每次建置都解析成**同一個 Session 物件** —— 那條漏掉的 closure 只有在這個形狀下才會繼續送事件），再用 **`closeSession` → `assemblyFor`** 直接驅動一次重建。三條斷言，值都是量到的：重建前 **1**（基準 —— 證明底下那條「1」不是真空的）、重建後 **1**（修正前 **2**）、`close()` 後 **0**。

**證偽（兩條，各有指名紅行）**：
- 還原成裸 `.set` → **`test/server.test.ts:1396`**：`expected 2 to be 1`。
- 反向寫法（重建時退訂「讀回槽裡的那個」）→ 前兩條照過（所以那兩條抓不到它），**`test/server.test.ts:1404`**：`expected 1 to be +0` —— **`close()` 那條是唯一的捕捉者**，這就是它存在的理由，不是裝飾。

**量到的**：`2601 passed · 0 failed · 9 skipped`（執行前先寫下預期 2601 = 2600 + 1；66 個 package）、`pnpm typecheck` 綠、`gate PASS -- no new rows`（**沒有新匯出**）。

**沒有動的**：`apps/cli/src/index.ts` 的 `liveAssemblies`（同一類、隔壁那個檔）—— 依裁定不動：它正確的拆除點是**組裝銷毀**，而 `SessionService` 沒有 `onAssemblyDisposed`。**武裝那個觸發條件的人一次處理兩個。**

#### ⚠ 本輪順帶更正一條過期引用，與三條重測（§0 規則三）

本節驗收段原本引的 **`assembly.ts:167`** 在本提交上**已過期** —— host-pre-seeded `session` 選項今天在 **`packages/session-executor/src/assembly.ts:176`**（W10 那批插入把它移走了）。**已改成符號 `AssemblyOptions.session`**：行號會再一次被下一次插入移走，符號不會。其餘三條在同一個提交上 `grep -n` 重測，**仍然正確**：`core-session/src/index.ts:308`（模組私有 `subscribers`）、`session-executor/src/service.ts:366`（hook 唯一的觸發點）、`server.ts:170`（函式內 const）。

**而這一改動會機械地移走一批**（**完整掃描、沒有截斷**：`git grep -l -E "sdk/src/server\.ts:[0-9]"` → **13 個檔案**）。⚠ **行數在這一輪被更正過兩次，而兩次都是「記錄裡的數字沒有重現」：**

| | 第一版說 | 第二版說 | **實測（`git grep -ohE`，見下）** |
|---|---|---|---|
| 檔案 | — | 13 | **13** ✓ |
| 相異行號 | — | 39 | **25** |
| 出現次數 | — | — | **54** |
| 在 base 173 之後 | — | 29 | **17** |
| 在其之前 | — | `5,6,22,69,70,73,74,150,170,171` | **`5,69,70,73,74,150,170,171`（8 個）** |

**`22` 與 `6` 不在那 13 個檔案裡**（`22` 是 `packages/api/gateway/src/stream-server.ts:22`；`6` 是沒有 `sdk/src/` 前綴的 `server.ts:6`）—— **它們是從一個更寬的 `server\.ts:N` 掃描裡手工濾出來的，不是那條被指名的指令的輸出。**

**複審抓到這件事，而它抓到的理由值得記**：**「誰照那段寫的指令重跑，就會拿到不同的數字，然後分不出是記錄錯還是樹錯」** —— **而那一段本身在揭露的，正是「記錄裡有未量測的數字」這個類別。**（第一版是**我**寫的、第二版是實作者寫的；**兩次都沒有在那條指令下量過。**）

**驗收指令（要重現就照這條）：**

```bash
git grep -ohE "sdk/src/server\.ts:[0-9]+" | sed 's/.*://' | sort -n | uniq   # 25 個相異
git grep -ohE "sdk/src/server\.ts:[0-9]+" | wc -l                          # 54 次出現
```

**唯一一條活在程式碼／腳本裡的是 `scripts/verify-dist.mjs`** 的探針註解 —— 引 `server.ts:266-275`，**在 base 上是準的**（base 的 275 就是 `protocolVersion: SDK_SERVER_PROTOCOL_VERSION,`），**已改成符號**（`initialize` case，提交 `9b40d332`）。**其餘 17 條全部在日期化文件裡**（2026-09-08…09-20 的 audit／research／plan／handoff，另有一個活設定 `scripts/audit/reachability-allowlist.json`，但它引的 `:5-39` 不受影響）：**依 W10 F3 的處置 —— 記錄、不改寫**（記錄文件是那一天的快照，而 §0 規則三本來就叫人「不要相信行號、引用前先 `grep -n`」）。兩端各有一個實測錨點：base **`:174` 正是** `session/event` 的 `emitMessage`（所以那一條**曾是準的**），base **`:715` 已經是** `validSessionIdResult`（那一條**當時就已過期** —— 白名單 parser 那天就在 `:737`）。同句的兩條鄰居（`protocol.ts:467 makeRequest`、`:534 encodeFrame`）**在 base 上就已經是錯的**（今天在 `:483`／`:550`）。

**⚠ 第一輪掃描是被截斷的，而它差點把一個錯的事實送出門**：Grep 工具的預設上限是 30 條，第一版只看了那 30 條就寫下「全 repo 只此一條」。**重跑（`head_limit: 0`）才看到 13 個檔案。**

**⚠ 而第二輪——「完整掃描」那一輪——本身也沒有重現。** 它寫下 39／29／10，而**實測是 25／17／8**（見上面的表），因為那些數字是**從一個更寬的掃描手工濾出來的**，不是它指名的那條指令的輸出。**複審抓到它，而抓到它的理由就是這一段在講的那件事：「誰照那條指令重跑，就會拿到不同的數字，然後分不出是記錄錯還是樹錯」。**

**所以這一節的教訓是兩層，而第二層比第一層重要**：

1. **掃描會被截斷**（第一層 —— 那次差點送出一個錯的事實）。
2. **「我重跑了、這是完整掃描」本身也需要可重現的指令**（第二層 —— 那次送出的是**同一類的錯事實，而它是在修正第一層的時候送出的**）。

**修法就是上面那兩行 `git grep`** —— **記錄裡的每一個數字，都要有一條別人跑得出同樣結果的指令。**

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

### ✅ **W10 已完成 —— `b8bd78b0`**

**形狀 (i) 落地**：前景指令跑到門檻就交回一個 job id，而**指令繼續跑**（不是重跑、不是先選 `runBackground`）。

#### 旋鈕，與那句必須寫在兩個數字旁邊的話

- `AssemblyOptions.shellBackgroundAfterMs`，預設 **30_000**，就在 `shellTimeoutMs`（預設 **120_000**）旁 —— 註解同時寫在**兩個數字那裡**：**門檻必須遠低於死線，否則 `guard-timeout` 的 abort 先贏，這個功能永遠不觸發**。預設對（30_000 vs 120_000）留了 90 秒給交回。
- CLI 的 `HeadlessOptions` 同層加了一樣的欄位並轉發（`apps/cli/src/run.ts`），所以「同一個層級」在**兩個宿主契約**都成立。
- **§0 規則三的即時示範**：上面那段引的 `assembly.ts:404` **已因這次改動過期** —— `shellTimeoutMs` 現在在 `:413`，新的 `shellBackgroundAfterMs` 在 `:426`；兩者交給 shell 的那一行**以符號記**（`registerShell(ctx, tools, { timeoutMs: shellTimeoutMs, backgroundAfterMs: shellBackgroundAfterMs, … })`）—— 行號會再一次被下一次插入移走，符號不會（`packages/shell/test/sandbox-refusal.test.ts` 的註記是同一條教訓）。

#### 縫開在哪裡（回報要求的工程問題）

`run(cmd)` 等結果、`runBackground(cmd)` 先 spawn 再回 id —— **「中途轉背景」兩者都做不到，它要的是一次 spawn、兩種結局**。所以縫開在 **`ExecService.run` 的第二個 overload**（`packages/exec/src/index.ts`）：`run(cmd, { backgroundAfterMs })` 回 `ExecResult | PromotedRun`，而**同一個 `spawnChild` handle** 在門檻到時被**註冊成 job**（`registerJob` 成了 `runBackground` 與 promotion 唯一的註冊路徑，種子取自 handle 已捕捉的文字）。

為什麼不是別的縫：

- **不能事先選 `runBackground`** —— 那是第二次 spawn，前景那份工作就丟了，正是本項要修的東西。
- **不能加新的必需方法** —— `ExecService` 的既有 fake（`packages/shell/test/`、`fs-search`）會編不過，**既有測試會被逼著改**；而「既有 shell/exec 測試不動」正是驗收的另一半。**可選方法**更糟：沒實作的路徑會讓 promotion **靜默地不發生**。
- **overload 讓既有呼叫者的契約逐字不變**：`run(cmd)` 仍回 `Promise<ExecResult>`，promotion 是**呼叫者明確選擇**的。

**一個被既有測試當場抓到的契約**：`spawnChild` 會**同步 throw**（受限策略、沒有 backend），而既有呼叫者遇到的是 **rejected promise**（`await expect(exec.run(...)).rejects`）—— 所以實作**必須是 `async`**；第一版寫成回傳 `handle.done` 的普通函式，兩條既有測試立刻紅。

#### 驗收（量到的）

- **全套**：`2592 → 2598 passed · 0 failed · 9 skipped`（66 個 package，新增 6 條：exec 2、session-executor 3、CLI 1）；`pnpm typecheck` 綠；`check-reachability.mjs --gate` → **`gate PASS -- no new rows`**（新匯出 `PromotedRun` 與它在 shell 的消費者同一個提交）。
- **promotion 生效**：回 `{ job_id, promoted: true, ran_foreground_ms }`，`job_output` 讀得到；**「還活著」是量到的** —— 指令用一個檔案被測試扣住，promotion 之後仍在跑，放行後把它被交回時還沒做完的工作做完（`packages/session-executor/test/shell-promotion.test.ts`、`packages/exec/test/exec.test.ts`、`apps/cli/test/cli.test.ts`）。
- **沒變的部分**：門檻以下**逐字不變** —— 沒有 id、沒有 `promoted`、沒有 job 記錄（新增測試釘住這點，**既有的 shell/exec 測試一條沒改**）。
- **證偽**：門檻高於死線（**預設 30_000** vs 400ms 死線）→ promotion **不觸發**，指令照舊死，而**死是可辨識的**（`code: "TOOL_TIMEOUT"`、`job_list` 空）—— 那條測試同時釘住 `?? 30_000` 那個預設分支。

#### 代價與 caveat（形狀 (i) 那一欄的處置）

- **模型沒要求 background 卻拿到 id** —— 所以結果**說出自己是誰**：`promoted: true` + `ran_foreground_ms`，`stdout` 並寫明 *"You did NOT ask for background — the harness did."*。**只有 `{ job_id }` 不行**：那正是模型自己 `background: true` 會拿到的形狀。
- **promoted job 的視圖從頭完整**：種子取 handle 已捕捉的文字，否則 job 會缺掉前 N 毫秒的輸出。**exec spill 有配置時那顆種子是記憶體 tail**（完整內容在該階段的 spill 檔）—— 而今天**沒有生產路徑同時配置 spill 與這個旋鈕**（`registerShell` 從不傳 spill，已量）。
- **殘餘風險（未加執行期警告）**：宿主若把 `shellTimeoutMs` 調到**低於門檻**（預設對是安全的），promotion **會靜默地不觸發**、行為回到 W10 前。處置照裁定：**把關係寫在兩個數字旁**，並用證偽測試讓它可觀測。

#### 修正輪 —— 複審的三條（`0794fbe7`）

**規格 PASS，品質 NOT APPROVED：兩條必須修（一條 blocking、一條是共用路徑上的真回歸），一條是把驗收的另一半釘住。** 三條都修了，三條都有指名的紅行。

| | 是什麼 | 紅行（實測） |
|---|---|---|
| **F1**（blocking） | **門檻 ≥ 死線時，promotion 靜默地不發生，而執行中的宿主沒有任何訊號** | `test/shell-promotion.test.ts:283`（`expected [] to have a length of 1 but got +0`，把「不會觸發」那條分支停用）；`:295`（同一條，停用非正數那條分支） |
| **F2**（回歸） | **job 的 CRLF 是逐 chunk 正規化**，而 `done` 是整串 —— 跨兩個 `data` 的 `\r\n` 在 job 視圖裡留下 `"A\r\nB"`（前景是 `"A\nB"`，**W10 前也是**） | `packages/exec/test/exec.test.ts`「folds a CRLF split ACROSS two chunks」：修正前 `expected 'A\r\nB' to be 'A\nB'` |
| **F4** | 端到端那條**在死線內就放行**，所以「abort 追上 promoted job」的回歸可以讓整套保持綠 | 把 `guard-timeout` 的 `clearTimeout(timer)` 拿掉 → `test/shell-promotion.test.ts:150` `expected 'error' to be 'running'` |

**F1 的處置**：警告放在 `createSessionAssembly`，**唯一同時持有兩個「已解析」值（含預設）的站點**，也是每個出貨宿主（CLI／SDK／ACP）都經過的組裝根 —— 設定檔沒有這兩個數字的位置，工具呼叫則太晚且逐次。**同一類的另一端也警告**：門檻不是正數（0／負數／NaN）會讓每個前景呼叫一啟動就被轉背景（`!(x > 0)` 是刻意的判定式）。**測試檔裡故意踩這個誤設的那兩條不會把警告靜音** —— 它們踩的就是那個誤設。

**F2 的處置**：記錄存**原始**字串，`jobView`（`getOutput`／`listJobs` 唯一的出口）在**讀取時對整串**做與 `doneFn` 相同的替換 —— 「同一條串流的兩個視圖一致」變成建構上的事實，而不是兩個地方各自記得。**原本那句「plain background spawn 兩者同文」是量測上為假的斷言，已改成真話**：`done` 有的是「正規化後的文字」但不是「全部文字」，所以 taps 必須是來源。

**F3（無需動作，記在案）**：`sandbox-refusal.test.ts` 那兩行過期引用**在 base 上就已經是錯的** —— 是這次的改動把它們移走，不是造成它們。**那份測試檔沒有動，這個取捨複審同意。**

**量到的（修正後）**：`2600 passed · 0 failed · 9 skipped`（執行前先寫下預期 2600 = 2598 + 2 條新案例；66 個 package）、`pnpm typecheck` 綠、`gate PASS -- no new rows`。**既有的測試案例一條沒改**（見下方對這句措辭的更正）。

#### 第二輪複審 —— 全部三條 DONE，外加 comment 級的三項（`a92a6817`）

**複審自己把兩件事量得比我的回報更強**：①把「警告條件」在**出貨預設對上強制成真**，`shell-promotion.test.ts:274` 立刻紅且警告被捕捉 —— 所以那條「預設對靜默」的斷言**是活的，不是真空的**；②F2 的修法被判定為**結構性**：替換只存在於一個地方（`jobView`），兩個讀者都委派，而且**兩個視圖**都正確折疊 split-CRLF（用腳本驗的，不只斷言的那個視圖）；同時確認**沒有其他讀者**在原始記錄上算 cap 或長度。

| | 是什麼 | 處置 |
|---|---|---|
| **Comment-1** | **`SpawnHandle.text()` 的註解在為剛修掉的 bug 辯護**：「taps 逐 chunk 正規化、`registerJob` 對種子同樣處理」——**兩句都被我自己那個提交證偽**。它比一般的過期註解更糟：不是誤導讀者，是**把讀者掉頭** —— 信它的人會把逐 chunk 正規化裝回去，split-CRLF 的洩漏就重開（測試會抓，但**註解在替那個 bug 說話**） | 改成實話：**兩邊都是 RAW，`jobView` 讀取時對整串正規化**。**並做了同句掃描**（`chunk by chunk`／`same way`／`normaliz`）：同套件只剩我這輪寫對的三處與測試檔那條，**沒有第三個** |
| **Comment-2** | 警告每次全套跑**觸發三次**，而其中兩個（CLI 的 M10a／M12）沒有註記 —— **那個不對稱正是警告變成套件壁紙的路** | 兩站各加一行**寫明依賴**（inert pair 就是那兩條要的），並**把 `shellBackgroundAfterMs: 30_000` 明寫出來**，讓「promotion 不得觸發」的前置條件**在本地而不是繼承自預設**。**斷言一個字沒動** |
| **Comment-3** | `exec.test.ts:179` 兩句被併到同一行 | 拆開（純空白） |

**量到的（本輪後）**：`2600 passed · 0 failed · 9 skipped`（與上輪同 —— 本輪只動註解與等值的顯式參數）、`pnpm typecheck` 綠、`gate PASS -- no new rows`；全套跑裡的那三次警告**逐一對得上來源**（session-executor 的證偽案例 1 次 ＋ CLI 兩站 2 次）。

**記錄在案、不動的兩件（複審自己的話）**：
- **上一輪的提交訊息「No existing test was edited」字面上不精確** —— 有三個既有測試**被附加式地**編輯過（端到端案例多了一步、死線 5_000→1_500；證偽案例多了一行註解；`mountAssembly` 的 `shellTimeoutMs` 變成可選）。**沒有任何東西被放寬，而提交不能 amend** —— 所以那是**更正記錄**，不是待辦。
- **第三個 flake 站點**：`shell-promotion.test.ts:208` 在複審兩次全套跑的其中一次**掛到 30 秒逾時**，隔離跑 110/110 全過，本體未被本輪改動，走在 W10 前的路徑上 —— **既有、已記錄、不追**。

**同時 parked**：讀取時正規化的成本（每次讀都配一份新字串；`job_output({wait:true})` 以 50 Hz 輪詢）—— **只有效率，正確性不受影響**。

### **W11 —— 子代理的健康訊號**

**原語全都在**（`packages/subagent/src/tools.ts`）：`spawn_agent`、`wait_agent`、**`list_agents`**、**`send_message`**、`interrupt_agent`、`followup_task`、`close_agent`、`resume_agent`，外加 `job_output`／`job_list`／`job_kill`／`get_task_output`。

**所以缺的不是能力，是時機**：主代理**只能在它自己的回合裡**去查，而**沒有任何東西提醒它「這個子代理已經跑了 20 分鐘」**。

**⚠ 而 Q2 = 否 把形狀定死了：提醒不能來自時鐘。** 所以它只能在**主代理本來就在跑的時候**出現。

> **⚠ 這裡原本寫的是一個後來的設計取代掉的草稿**（「**在那個子代理的通知送達時**，順帶告訴主代理它跑了多久」—— 走 `onTerminalized` → drain → admit 那條路）。
>
> **那個草稿是錯的，而它錯在時機**：那條路只在子代理**結束**時才走 —— **而「它卡住了」正是那個永遠不會發生的事件。** 一個卡住的子代理**不會送達通知**，所以那條路**恰好在你最需要它的時候不會響**。
>
> **採用的是下面那個三塊設計** —— 而它的第三塊（`runtime-context` 區段）**在每一次主代理本來就在跑的回合裡都會被渲染**，不是等一個永遠不來的事件。**草稿保留在此，因為它是一個看起來對、而錯在時機的形狀** —— 這一類比明顯的錯更值得記。

**驗收**：一個跑了很久的子代理，**在它下一次與主代理有互動時**，主代理**知道它跑了多久** —— 而且**不靠任何計時器開 turn**。

### 設計（已定，三塊）

| | 內容 | 為什麼 |
|---|---|---|
| **1. 事實** | live agent entry 記下 **`startedAt`** | **量到的：今天完全沒有時間戳** —— 所以「跑多久」答不出來 |
| **2. 被問的那條** | **`list_agents` 回報已跑多久** | 一個已經在查的主代理**看得到** |
| **3. 不必被問的那條** | **一個 `runtime-context` 區段**，列出**超過門檻**的子代理 | **它只在字改變時渲染** ⇒ 每個子代理只產生**兩次**（跨過門檻、離開），不是每分鐘一次 |

**Q2 = 否 在這裡被滿足得很乾淨**：**沒有任何東西開一個 turn** —— 那個區段是在**主代理本來就在跑的回合裡**被渲染的。

**而它與 W10 是同一個形狀**（「超過 N ⇒ 告知」），**所以門檻的註解要說明它與誰的關係** —— 與 `shellBackgroundAfterMs` vs `shellTimeoutMs` 同一條紀律。**一個永遠不會觸發、或永遠在觸發的門檻，是同一種缺陷的兩面。**

### ✅ **W11 已完成 —— 三塊**（`22b20c30`；實作於 `d4-endpoint-cache`）

**三塊都落地，位置與上面那張表一一對應**（欄位名 `startedAt`、`list_agents` 那條、以及「只在字改變時渲染」的性質，與設計表逐字相同）。

#### 1. 事實 —— `ChildAgentEntry.startedAt`（`packages/subagent/src/agent-table.ts:35`）

**紀元毫秒，記的是「當前這一輪」的開始，不是條目的年齡**：`spawnChild` 建立條目時蓋一次（`packages/subagent/src/child.ts:305`）、`driveFollowups` 每次重新驅動時再蓋一次（`packages/subagent/src/tools.ts:690`），而**那是這個套件裡唯二寫 entry 的 running 狀態的地方**。

> ⚠ **原本這裡引的證據指令是 `grep -n "status = \"running\"" packages/subagent/src`，而它不重現那個主張**（複審量到的：它回**三**行 —— 一個註解、一個 **TaskRecord** 的 `t.status = "running"`、以及 `tools.ts` 那一處 —— 而**漏掉 `child.ts` 的 spawn 那處**，因為那是物件字面量形式）。**主張本身是真的，但被引的指令證明不了它。**
>
> **會重現的指令**（要核這條就照它跑）：
>
> ```bash
> grep -rn -E '(entry\.status = |^ +status: )"running"' packages/subagent/src
> # → 恰好 child.ts:301 與 tools.ts:684
> ```
>
> **這是 §0 規則三與 W2 那一課存在的理由**：**誰照被引的指令重跑，就會拿到不同的行，然後分不出是記錄錯還是樹錯。**

> **⚠ 一個已裁定、但沒有在本輪修的後續（複審的裁定，而我同意）**：`startedAt` 這個名字**與既有的 `JobSnapshot.startedAt`（「job 建立」、**從不重新蓋章**）撞名，而語意相反**。**它現在在公開表面上**（`ChildAgentEntry` 與 `AgentTaskView` 都從 barrel 匯出）。
>
> **裁定：不值得為它開一輪** —— 那個欄位的 JSDoc **指名了另一個時鐘**，而 re-drive 的測試**釘住了語意**。**改名的時機是這個檔案下一次被碰到的時候**（`runStartedAt`，約 6 處：`agent-table.ts` ×3、`child.ts` ×1、`tools.ts` ×1、測試 ×1）。**寫在這裡，因為「下次順手改」是一個不會自己發生的承諾。**

**選「本輪」而不是「出生」是刻意的，理由寫在欄位註解裡**：一個剛被喚醒的子代理**不可以**被報成「已經跑了 20 分鐘」——**這個訊號一旦說謊就沒有價值**。**同一個套件的 `JobSnapshot.startedAt` 是另一個時鐘**（工作建立時間、永不重蓋），任何一次 followup 之後兩者就不同。

**讀的規則只有一處**：`runningElapsedMs`（`agent-table.ts:71`）—— **被問的那條與不必被問的那條都讀它**，所以區段不可能列出一個 `list_agents` 說「只跑了 3 秒」的子代理（有一條測試直接釘這個一致性）。

#### 2. 被問的那條 —— `list_agents` 的 `elapsed_ms`（`packages/subagent/src/tools.ts:269`）

**只有 running 的條目有這一欄**（settled 的沒有 —— **缺席，不是 0**），而**工具的 description 就把它寫出來了**（`:237`）：模型是從描述知道它存在的，不是從原始碼。

⚠ **測試驅動的是真實時間**：子代理那一回合被一個 promise 扣住，兩次取樣之間**真的睡 120ms**，斷言的是**兩次讀數的差 ≥ 100ms**（`packages/subagent/test/tools.test.ts:1006`）。**沒有任何時鐘被 mock、注入或 stub。**

#### 3. 不必被問的那條 —— `subagents` 區段（`packages/subagent/src/section.ts:34`）

**這一塊能不能用，取決於它的文字不隨時間移動。** runtime-context 只在**渲染文字改變**時 append（`packages/runtime-context/src/index.ts`；釘住這條性質的是 `packages/runtime-context/test/runtime-context.test.ts:14`），所以**一段含計時的文字等於每分鐘寫一行日誌**。因此文字的**唯一輸入是「超過門檻的那個集合」**：路徑、role、job、門檻（常數）—— **不含量時**，需要數字的人被指去 `list_agents`。**一次跨越＝一行、一次離開＝一行、中間＝零行**，而那不是主張，是量到的（見下面的證偽 C）。

> ⚠ **而複審量到一件比上面的解釋更寬的事，而且是好的方向**：**那個區段也會在「子代理」的 step 上渲染** —— 子代理的 `parentEmit` 就是組裝的 emit，而它會轉發到父的 scope，所以**跨界那一行可以在父的日誌裡出現，而父的迴圈是閒置的**（它用臨時探針量到：父的 run 早已結束、`turn/start` 從 1 到 1，而父的日誌仍然拿到了 `## subagents` 快照）。
>
> **所以上面的「在主代理本來就在跑的回合裡」窄於實作。** **Q2 仍然成立**（**沒有 turn**、仍然每跨界一次一行），而**一次落在工具呼叫中途的 append 是安全的**（`deriveMessages` 會延後落在開啟中的工具區塊裡的使用者訊息）。
>
> **它是覆蓋的「超集」而不是過度宣稱，所以程式碼沒有東西要改** —— 但**解釋要改準**，而那正是這一段在做的事。

**沒有 start stamp 的 running 條目不會被靜默丟掉**（`section.ts:46`）：它被報成 unknown。另一條路（沉默）講的其實是「沒有東西需要注意」——**那是這個 getter 不能做的斷言**。

#### 旋鈕，與那句寫在兩個數字旁的話

- `AssemblyOptions.subagentStaleAfterMs`（**預設 600_000／10 分鐘**；宣告在 `packages/session-executor/src/assembly.ts:258`、解析與警告在 `:491`），CLI 的 `HeadlessOptions` 同層加了一樣的欄位並轉發（`apps/cli/src/run.ts:148`、`:498`）——「同一個層級」在**兩個宿主契約**都成立（W10 的處置）。
- **關係寫在數字旁**（`packages/session-executor/src/assembly.ts:234-250` 那段註解；複審指出原本引的 `:254` 會落在**同一塊 JSDoc 裡、但錨點的下方**），**兩個錨點**：**300_000**（`wait_agent` 的 clamp ＋ `spawn_agent background:false` 的等待 —— 主代理自己最多願意等多久）與**「已經跑了 20 分鐘」**（本文件 §8.5 W11）。門檻必須**高於前者**（否則報的是等待者剛剛親自等到的事）、**低於後者**（否則訊號來得太晚），而且**仍要高於一次正常的子代理回合**（否則區段在每一步都變成壁紙）。
- **兩側的誤設都出聲**（`:492`／`:496`）：**非正數**（0／負／NaN，用 `!(x > 0)` 一次抓）＝每個子代理一啟動就「過期」；**非有限**（Infinity）＝**永遠不觸發，而它的沉默與「沒有東西需要注意」無法區分**。這是唯一同時握有兩個解析後值（含預設）的站點 —— 與 W10 F1 同一個處置。

#### 量到的

- **全套**：`2614 passed · 0 failed · 9 skipped`（66 個 package；**執行前先寫下預期 2614 = 2601 + 13**：subagent 9（`section.test.ts` 6 ＋ `tools.test.ts` 3）＋ session-executor 3 ＋ CLI 1）。`pnpm typecheck` 綠。`node scripts/audit/check-reachability.mjs --gate` → **`gate PASS -- no new rows`**。
- **匯出的處置**：`createStaleSubagentsSection` 與它的消費者（assembly）**同一個提交**；**`StaleSubagentsSectionOptions` 刻意不進 barrel** —— 沒有消費者指名它，barrel 匯出會變成一列新的 row（可達性儀器把 `export interface` 算成 row）。
- **既有的測試「案例」一條沒改** —— 新增的全部在新檔案或新的 describe 裡。（**⚠ 複審指出措辭不精確**：**兩個既有測試檔的 import 行被改過**（`packages/subagent/test/tools.test.ts:3`、`apps/cli/test/context-instructions.test.ts:1`），而**沒有任何既有的測試案例被改動** —— 完整的刪除行清單就是那兩行 import。**與 W10 被指出的同一個說法問題**，所以在這裡一次講準。）

#### 「沒有任何東西會開一個 turn」—— **量到的，不是靠建構**

`packages/session-executor/test/subagent-stale-section.test.ts` 的第二條：主代理的回合**已經結束**（一個 blocking 的子代理還在跑），**閒置 400ms —— 8 倍於當時的 50ms 門檻**（子代理是在那次 run 結束前建立的，所以這 400ms 是它年齡的**下界**）。實測：**新增事件 0、模型呼叫 0、`turn/start` 數不變**，而同一刻它在 `tasks()` 裡的列還是 running（證明那個視窗不是空的）。**區段是在 `agent/pre-step` 渲染的，而沒有回合就沒有 step。**

#### 證偽（**每一塊一條，各有指名紅行**）

| | 破壞什麼 | 紅在哪一行（實測） |
|---|---|---|
| **A**（第一塊） | 拿掉 `spawnChild` 的 `startedAt: Date.now()` | `packages/subagent/test/tools.test.ts:999`：`expected 'undefined' to be 'number'`；**`packages/subagent/test/section.test.ts:89`：`expected 'Sub-agent runs with no start time rec…' to be ''` —— 未知那一臂當場接手**，這就是它存在的理由；另有 `:139`／`:156`／`:196` |
| **B**（第二塊） | `runningElapsedMs` 回固定的 `0`（時鐘凍住，但仍是一個數字） | `packages/subagent/test/tools.test.ts:1006`：`expected 0 to be greater than or equal to 100` —— **就是「驅動真實時間」那條斷言**；`section.test.ts:93`／`:123`／`:135`／`:155`／`:191` 同時紅 |
| **C**（第三塊） | 把粗粒度的已跑時間塞進區段文字 | `packages/subagent/test/section.test.ts:124`：`expected 5 to be 1`（400ms 內五次取樣五種字）**＋** `packages/session-executor/test/subagent-stale-section.test.ts:104`：`expected [ …(2) ] to have a length of 1 but got 2` —— **日誌裡真的多了一行**，這就是「噪音」的實測 |
| **D**（旋鈕的路由） | 拿掉 CLI 的轉發行 | `apps/cli/test/context-instructions.test.ts:50`：`expected false to be true` |

#### 沒有做的（明說）

- **W12 不在這裡**（`wait_agent` 上的門檻）—— 依本節的裁定另立一項：那是**另一條路徑**（阻塞的等待 vs 正在跑的迴圈），而**前三塊不因它未做而做錯**。
- **`startedAt` 不進持久化快照**：restored 的條目**永遠不會是 running**（`restoreState` 把 running 映射成 `error`），所以那時它沒有東西可蓋；被喚醒時 `driveFollowups` 蓋新的。欄位註解寫明了這一點。
- **CLI 那條只釘住「路由」**（值有沒有到達它指名的那個旋鈕），**不是行為** —— 行為由 assembly 層那條端到端測試釘住。**一個假裝在測出貨路徑的測試，比沒有測試更糟**（W2 的同一條處置）。

#### §0 規則三的即時示範（**兩次，都是我造成的**）

1. 旋鈕註解的第一版引的是 `packages/subagent/src/tools.ts:184`／`:198`（那兩個 300_000）。**那兩行是被同一個提交裡我自己加的 import 移走的** —— 它們現在是 `:185`／`:199`。**已改成符號**（`wait_agent` 的 clamp／`spawn_agent background:false`），**文件那條也已從行號改成「§8.5 W11」**（那份文件每個單元都在編輯）。
2. **這一節自己的引用**：它先寫下 `section.ts:33`／`:45`，然後**我為了順一句註解的措辭多加了半行**，那兩個數字當場變成 `:34`／`:46`。

**兩次都是「改動引用的那個檔案 ⇒ 引用當場腐」**，而兩次都是**交付前那條強制的重測**抓到的（§0 規則三的後半句就是為此存在）。§0 說這條教訓在本分支出現過四次；**這是同一類的兩次**，而它多給了一句：**同一批改動裡既要引用、又要改被引用的檔案時，先寫符號；行號只在最後一次編輯之後量。**

### **W12 —— 第四塊，另立一項（`wait_agent` 的門檻）**

**⚠ 量到的一個情境，而那正是第三塊到不了的地方**：**如果主代理正卡在 `wait_agent` 上等一個卡住的子代理，那個 `runtime-context` 區段到不了它** —— 那是一個工具呼叫，**迴圈不會轉**。

**那需要的是 `wait_agent` 上的門檻**：等超過 N 就**交回控制**、附一句「它還在跑，跑了多久」。

**為什麼另立一項而不是塞進 W11**：**它是另一條路徑**（阻塞的等待 vs 正在跑的迴圈），而**前三塊不會因為它還沒做而做錯**。**而這是 W10 那個形狀第三次出現** —— 值得被看見，而不是被埋在 W11 的尾巴裡。

### ⚠ W12 的前提**被量測推翻了** —— 所以它被**換掉**，而不是被實作（2026-09-20）

**原本的前提是「主代理可能卡在一個無界的等待上」。量到的：兩條阻塞路徑都是有界的。**

| 路徑 | 量到的 |
|---|---|
| **`wait_agent`** | `timeout_ms` **預設 30_000、夾在 [100, 300_000]**；逾時回 `{ timed_out: true, message: "wait timed out … (still running)" }` —— **它本來就把控制交回來** |
| **`spawn_agent background:false`** | `await deps.tasks.wait(task.id, 300_000)` —— **同樣有界** |

**所以 W11 的第三塊到得了它** —— 最多晚 300 秒，而那是它自己要的。**這一項的原始形狀因此結案：不需要做。**

### ✅ 但同一輪量測找到一條**更好的**，而它取代了 W12

**`spawn_agent background:false` 在逾時時說它「settled」。**

```ts
const settled = await deps.tasks.wait(task.id, 300_000)   // 逾時 → undefined
return { …, status: settled?.status ?? "unknown",
         message: `subagent ${executed.path} settled: ${settled?.status ?? "unknown"}` }
```

`wait(taskId, timeoutMs): Promise<TaskRecord | undefined>` —— 型別上逾時可以回 `undefined`（`task-protocol.ts:108`）。

> ⚠ **而我這一句原本寫「逾時回 `undefined`、所以它說 `settled: unknown`」—— 實作時量到那也不對，而錯的方向讓缺陷更明顯**：**出貨的 registry 在死線時回的是那筆仍然未終結的記錄本身**（`| undefined` 只涵蓋未知的 id）。**所以那句字面上的謊是 `settled: running`。**
>
> **探針抓到的原文**：`"message":"subagent root/helper settled: running"` —— 而那一刻 registry 裡的記錄仍是 `status: "running"`。**「settled: running」是自我矛盾的**，所以那不是一句模糊的訊息，**是一句在字面上就看得出來沒發生的事。**

**它是一句「形狀像訊息」的謊** —— 而**它的兄弟 `wait_agent` 有 `timed_out: boolean`，它沒有**。

**驗收**：逾時的時候，那個結果**要說出它逾時了**（而且**要看得出那個任務還在跑**）；**沒逾時的時候，行為逐位元不變**。**照 `wait_agent` 已經在做的那個形狀** —— 那個 repo 已經有正確答案，只是這一條路沒有用它。

### ✅ **W12 已完成 —— 逾時的 `spawn_agent background:false` 不再說「settled」**（`ad8dca47`；實作於 `d4-endpoint-cache`）

**形狀照兄弟，沒有第三種**：那條路先問「這次等待有沒有拿到終態」（`packages/subagent/src/tools.ts:198` 的守衛），沒拿到就走 **`wait_agent` 的逾時形狀** —— `timed_out: true` ＋ `wait timed out for <path> (still running)`（`:200`）。**成功的那一 return 逐字未動**（`:202`）：**「沒逾時時逐位元不變」因此是建構出來的，不是被斷言出來的** —— 而它被走到的條件（`settled` 有終態）與舊碼會報「settled」的條件是同一個。

#### 量到的（**同一個真實逾時，修前／修後**）

修前那一行（把舊碼放回去、只留可注入的縫，探針在 `background: false` 逾時時印出）：

```
{"agent_path":"root/helper","job_id":"subagent-1","task_id":"task-1","status":"running","message":"subagent root/helper settled: running"}
```

**同一刻 registry 的 record**：`status: "running"`、`timeStarted` 已蓋、**`outcome` 是 `undefined`** —— **任務還在跑，而訊息說它 settled。**

修後：`timed_out: true`、`status: "running"`、`message: "wait timed out for root/helper (still running)"`，**且沒有 `outcome`／`resultText`** —— **沒有替一個沒發生的結算捏造 summary 欄位。**

#### ⚠ 這一區自己的字有一處量到得不夠準（**本節的修正**）

上一段說「逾時回 `undefined`」。**量到的：出貨的 `createTaskRegistry.wait` 在截止時回的是那筆還在跑的 record**（實作在 `packages/subagent/src/task-protocol.ts:263`；`:108` 型別上的 `| undefined` 涵蓋的是**未知 id**）。**所以那句的字面版本（工具回報「settled: unknown」）不成立 —— 它實際回報的是「settled: running」**（上面那行就是量到的原文）。**缺陷本身成立且範圍更大**（`running` 一樣被說成 settled），而修法**把兩種慣例收進同一臂**：守衛是 `settled === undefined || settled.outcome === undefined`，所以**一個照契約回 `undefined` 的實作也落在逾時臂**（那一支有守衛、沒有測試驅動它 —— 出貨的 registry 走不到，明說）。

#### 測試：**驅動一個真實逾時**，不是釘形狀

- **300_000 沒有任何測試負擔得起** ⇒ 在**工具自己的 deps 上開一個窄縫**：`SubagentToolDeps.foregroundWaitMs?`（`packages/subagent/src/tools.ts:61`）—— **缺席 = 300_000，出貨行為不變**，而**沒有任何宿主傳它**。**沒有把它接進 `RegisterSubagentOptions`**：那會把一個只有測試在用的旋鈕變成宿主契約 —— **要的是窄縫，不是旋鈕**。
  **會重現的指令**（**掃 `.ts`；帶 `--include=*.md` 的版本會多出本文件自己那一行 —— 一寫進文件，指令的輸出就變了**）：
  ```bash
  grep -rn "foregroundWaitMs" --include=*.ts packages apps
  # → 3 行：tools.ts:61（欄位）、tools.ts:190（讀取）、tools.test.ts:838（測試設 50）
  #   沒有截斷（全掃，未取 head）
  ```
- 測試（`packages/subagent/test/tools.test.ts:826`）傳 **50ms**，而子代理的初始回合是**真的睡 2 秒**的模型 ⇒ 截止時任務**真的**還在跑，`wait` **真的**輪詢到自己的截止。**沒有 mock 時鐘、沒有 stub `wait`、沒有新的假 registry** —— 用的是既有的 `createTaskRegistry()`。
- 斷言的就是**逾時那個出口**：`timed_out === true`、訊息逐字、`status === "running"`，而**record 沒有 `outcome`、table 條目還活著、`outcome`／`resultText` 沒有被捏出來**（`:841` 起）。

#### 證偽（**把舊的那一行放回去**）

舊形狀放回、同一條測試再跑：**`packages/subagent/test/tools.test.ts:841` 當場紅** —— `expected undefined to be true`（**舊碼裡沒有 `timed_out` 這個欄位**）。**探針那一輪另外量到舊碼實際回的字**（就是上面那行 `settled: running`）。

#### 順手改準的一句（**模型看得到的字也是訊息**）

工具 description 原本說 `background: false` **阻塞到任務 settle**（`:70`）—— **逾時的出口不在描述裡**。現在它寫了：沒在界內 settle 就回 `timed_out: true`，且**任務還在跑**。

#### 量到的（全套）

- **`2615 passed · 0 failed · 9 skipped`**（66 個 package；**執行前先寫下預期 2615 = 2614 + 1**）。**沒有動任何既有測試案例**，新增的是一條新測試。
- `pnpm -r typecheck` 綠；`node scripts/audit/check-reachability.mjs --gate` → **`gate PASS -- no new rows`**。
- **沒有新 export**：新欄位在既有的 `SubagentToolDeps` 上，而 `timed_out?` 在工具結果的**行內字面型別**上（`:67`）—— 所以這一項不需要「export 與消費者同提交」的處置。

---

## 9. 執行順序與理由

```
W1  修 settings watcher race        ← 現在做。它讓後面每一件的驗證站得住
W2  修 SDK 訂閱洩漏                 ← ✅ 完成（`2bbf0d20`）＝照修但降級：契約釘住、路徑未武裝
W3  schedule 的 spec                ← 先寫 spec，不要先接線
W4  M5/T2 第二半                    ← 路線圖的下一個實作
W5  M5/T4 schema 驗證層
W6  M3 剩下兩項（79 站點；redaction 繼續量）
W7  M6                              ← 依賴 M5
W8  M7                              ← 等 Q1／Q2
```

**W1 為什麼第一**：它不只是「一個 bug」—— 它是**驗證的地基**。**一個一半機率說謊的套件，讓後面每一項的「綠」都不可信。**
**W2 為什麼第二但可能不做**：它是真缺陷，但**階段 B 移除了它的觸發路徑** —— **先證明可達，否則就是修一條沒有輸入的路。**
**（2026-09-20 結案）**：可達性**量測完是「不可達」**，所以裁定改成**照修但降級** —— 修的是**共享路徑上的潛伏缺陷**，而**測試明說它釘的是契約**（§3 的記錄、紅行在那裡）。**武裝那個觸發條件的人（加 `session/close`）就是重新審這個契約的人。**

---

## 10. 這份文件**沒有**建立什麼

- **沒有時程** —— 這份 repo 的慣例是**順序**，不是日期。
- **沒有替使用者回答 Q1–Q8** —— 那四題只有他能答，建議已附。
- **沒有重複路線圖與兩份 handoff 的內容** —— 它只**指向**它們，並記下**現在在哪**。
