# 提示展開式指令（Prompt-Expanded Commands）設計 — 2026-09-17

> **基準**：`m65` @ `e125ac75`（本 spec 的每一個座標都在此修訂重量過）
> **輸入**：`docs/handoff/2026-09-17-backend-audit-and-plugin-gap.md` §3.3 與 §4；`D:\deepseek-harness`
> 的 `HANDOFF-MARKETPLACE.md` §7（DSH 自己的 root-cause 記載）
> **範圍**：**核心的一個能力缺口**，不是接線。它決定 plugin 的 `commands/` 值不值得做，也決定
> 任何「指令面」要怎麼設計。

---

## 0. 這份文件是什麼、不是什麼

**是**：一個**核心能力**的設計 —— 讓指令可以「展開成一段送進對話的提示詞」。

**不是**：plugin registry 的實作計畫。registry 已經能**發現並解析** `commands/*.md` 了
（`describeCommands`、`parseCommandMarkdown`），這份 spec 處理的是**解析之後**的事。

**不是**：marketplace 的計畫。marketplace 是另一件事，且 DSH 已經有一套可移植的實作
（見 handoff §3.4）。

---

## 1. 問題：一個型別上的缺口，不是接線缺口

### 1.1 兩種指令，我們只有一種

Anthropic 的 `commands/*.md` **是提示詞**。`plugins/agent-sdk-dev/commands/new-sdk-app.md`
的實際內容是 frontmatter 加一段 `## Your Task …` 的指示文字。**「呼叫它」= 把那段文字送進對話**，
模型接著照著做。

我們的 `Command`（`packages/interaction/src/index.ts`，註解自稱 *"DSH CommandDefinition parity"*）：

```ts
export interface Command {
  name: string
  description?: string
  argumentHints?: string
  execute(input: string, ctx: PluginContext): Promise<string>
}
```

`execute` 回傳 `Promise<string>`。**這個型別沒有任何通往模型的路** —— 它只能回傳一個字串，而
「把字串送給模型」與「把字串顯示給使用者」在型別上是同一件事。

**handler 式指令是對的，不該改。** 它們處理的是「執行一個動作並回報」（`/theme dark`、
`/compact`），回傳字串給使用者看正是它們的語意。缺的是**第二種**。

### 1.2 而這條鏈在四個地方同時斷了（`e125ac75` 實測）

| 環節 | 狀態 | 證據 |
|---|---|---|
| plugin 的 `commands/*.md` 被發現並解析 | ✅ | `plugin-registry/src/index.ts:544`、`:556` 呼叫 `describeCommands` |
| **那份輸出有人消費** | ❌ **零個消費者** | 全樹無 `describeCommands` 的生產呼叫者 |
| **指令有被註冊** | ✅ **7 個生產呼叫點** | `apps/cli/src/run.ts:320,328,336,344,352,359,363` 註冊 `session-send`/`session-followup` 等 |
| 有人**派送**它們（`runCommand`） | ❌ **只有一個測試呼叫者** | `apps/cli/test/session-compact.test.ts`；生產零 |
| `listCommands` / `parseCommandLine` | ❌ 只有測試 | 同上 |
| `execute` 能把手續送給模型 | ❌ **型別上不行** | 回傳 `Promise<string>` |

**所以精確的形狀是：registry 在生產路徑上被填滿了，但沒有派送者。** CLI 註冊了 7 個指令，
而**沒有任何生產程式碼能呼叫它們** —— `runCommand` 的呼叫者原本是前端（命令面板），前端被 M65
刪了。這是與那 7 個零消費者套件**同一個模式**的又一個實例。

> **⚠️ 一次量測修正，記在這裡因為它改變了本節的結論。** 本表初稿說 `registerCommand` 與
> `runCommand` 都是「零個呼叫點」。**那是錯的**，錯因是一個靜默失敗的 `git grep`：
> `-- 'packages/*/src' 'apps/*/src'` 這個 pathspec 不匹配任何東西，回傳空結果卻看起來像「乾淨」。
> 用未加 pathspec 的搜尋重測得到上表的數字。**這正是 `docs/handoff/2026-09-17-backend-audit-and-plugin-gap.md`
> §7 記載的同一種假陰性**，而它在同一個 session 裡又發生了一次。

**即使給了派送者，型別也載不動提示詞。** DSH 對同一件事的結論是同樣的字：**這是格式缺口，
不是接線缺口**。

---

## 2. 設計

### 2.1 加第二種指令，並讓**結果**顯式

**不動 `Command`。** 新增：

```ts
/** 展開成要送進對話的提示詞。與 Command 的 handler 語意並列，不是取代。 */
export interface PromptCommand {
  name: string
  description?: string
  argumentHints?: string
  /** 展開成提示詞文字。取代語法見 §2.3。 */
  expand(input: string, ctx: PluginContext): string
}
```

然後把 `runCommand` 的回傳型別從 `Promise<string>` 換成**判別聯集**：

```ts
export type CommandOutcome =
  | { kind: "reply";  text: string }   // handler 式：顯示給使用者
  | { kind: "prompt"; text: string }   // 提示詞式：送進對話
```

**這一個型別同時解決兩半**：它告訴呼叫者要做什麼，也讓 `commands/` 有了落地點。

### 2.2 為什麼是判別聯集而不是別的

| 替代方案 | 為什麼不 |
|---|---|
| 讓 `execute` 回傳一個有 `toModel` 旗標的物件 | 混淆了兩種語意；handler 式指令沒有「送模型」這個概念，強迫它們攜帶一個永遠 false 的旗標是壞味道 |
| 新增 `runPromptCommand()` 與 `runCommand()` 並列 | 呼叫者仍得**先知道**是哪一種才能選函式 —— 但呼叫者拿到的是**名字**（`parseCommandLine` 的產物），它不知道 |
| 讓 `Command.execute` 直接回傳 `CommandOutcome` | 會破壞所有現有 handler 式指令的簽章，而那正是**不該改**的那一半 |

判別聯集讓「我不知道這是哪一種」的呼叫者能**把決定權交給回傳值**，這正是它該在的地方。

### 2.3 `$ARGUMENTS` 取代語法（**建議：只做這一個**）

官方 frontmatter 有 `argument-hint: [project-name]`。內文的取代是格式的一部分。

**最小版本**：只支援 `$ARGUMENTS` —— 展開成 `parseCommandLine` 給出的 `input`（已 trim）。

**明確不做**：`$1` / `$2` 位置參數、`!` 命令替換、`@` 檔案引用。理由：位置參數需要定義引號與轉義
規則（一個完整的 argv 文法），而 `!` 與 `@` 是**執行/讀取**面，各自是一個安全決定。**先讓最常見的
那一個可用。**

---

## 3. 三個必須先定的決定

### 決定 1（最關鍵）：提示詞進入對話時，算誰說的？

| 選項 | 語意 | 後果 |
|---|---|---|
| **(a) 使用者訊息** | 送成 `user/message` | 模型回應它；`/cmd` 成為使用者的一個 turn。**與 Claude Code 一致** |
| (b) 系統／開發者注入 | 不進 user turn | 使用者看不到自己「說了」什麼；除錯時對話歷史對不上 |
| (c) 工具結果 | 走既有 tool-result 通道 | 需要一個「假工具呼叫」；語意扭曲 |

**建議 (a)。** 理由：(1) 與官方一致，(2) 它讓「使用者打了 `/foo`」在 durable log 裡就是一個
`user/message` —— **唯一真相不被特例污染**，(3) 它天然重用 `coordinator.enqueue`。

**但這是一個產品決定，不是技術決定**：它決定「呼叫指令會不會觸發一個新 turn」。若選 (b)，
`/cmd` 就變成一個不佔 turn 的旁路，那是一個不同的產品。

### 決定 2：`$ARGUMENTS` 的行為（見 §2.3）

**建議**：只做 `$ARGUMENTS`，展開成整段 input。其餘旗標明確記錄為「不支援」。

### 決定 3：不支援的 frontmatter 欄位要怎麼辦？

官方還有 `allowed-tools`、`model` 等。我們只解析 `description` 與 `argument-hints`。

**這題比看起來嚴重。** 一個宣告了 `allowed-tools` 的指令，如果我們**靜默忽略**，那它就**以為自己
被限制了但其實沒有** —— 這正是這個 repo 一直在刪的那種「看起來成功、實際沒做」的缺陷。

**建議：沿用 registry 自己的既有先例。** `plugin-registry/src/types.ts` 的 `CommandConflict` 已經
定下了形狀：

> *"the name was already claimed by the host catalog or by another enabled plugin. The command is
> NOT registered — **the plugin still enables, with the limitation recorded**."*

所以：**遇到不支援的 frontmatter 欄位 → 指令仍可載入，但把「此欄位未被履行」記進限制清單。**
不靜默、不整體拒絕。

---

## 4. 範圍

**在**：
- `PromptCommand` 型別 + `CommandOutcome` 判別聯集（`packages/interaction`）
- `runCommand` 改回傳 `CommandOutcome`（**唯一的破壞性變更**，且它目前零呼叫者 → 實際破壞為零）
- plugin 的 `commands/*.md` → `PromptCommand` 的轉換（`packages/plugin-registry`）
- 不支援 frontmatter 的**限制記錄**（§3 決定 3）

**不在**：
- **不接任何宿主。** `runCommand` 的呼叫者（CLI / SDK / ACP）是另一件事，而且**產品宿主是重建的
  前端，不是 CLI**（見 handoff §5 的裁定）。這份 spec 只讓能力**存在且正確**。
- `$1`/`$2`/`!`/`@`。
- `allowed-tools` / `model` 的**履行**（只記錄不履行）。
- marketplace。

---

## 5. Red-first 測試與 mutation proof

本 repo 的規矩：沒有先紅的測試與 mutation proof，不動生產程式碼。

| 測試 | 先紅於 |
|---|---|
| 一個 `PromptCommand` 經 `runCommand` 回傳 `{kind:"prompt"}` | 現在回傳裸 `string` |
| 一個 handler 式 `Command` 經 `runCommand` 回傳 `{kind:"reply"}` | 同上 |
| `$ARGUMENTS` 被取代成 input；無 `$ARGUMENTS` 時內文原樣 | 現在完全沒有這個功能 |
| 一個 `commands/*.md` 被轉成 `PromptCommand`，其 `expand` 回傳（fixture 的）內文 | 現在零轉換 |
| 一個帶不支援 frontmatter 的 command **仍載入**，且限制被記錄 | 現在無此欄位 |

**Mutation proof（雙向）**：
1. 把 `PromptCommand` 的展開改回「回傳裸字串」→ 「回傳 prompt」的測試必須轉紅。
2. 移除 `$ARGUMENTS` 的取代 → 該測試必須轉紅。
3. 讓不支援 frontmatter **靜默通過** → 限制記錄的測試必須轉紅。

**驗收**：`--gate` 仍 exit 0；**row set 不得新增**（若新增，那就是 `interaction` 或
`plugin-registry` 的匯出沒被任何生產路徑消費 —— 本 spec 刻意**不接宿主**，所以**必然會新增 row**）。

> **⚠️ 這條要特別處理。** 因為 §4 明確不接宿主，新匯出**一定**會變成 `unused-export` row。
> 依本 repo 的規矩，那**不是**用 `void` 或假消費掩蓋，而是**帶日期的 allowlist 條目**，理由寫明
> 「這是能力，宿主是重建的前端，接線不在本 spec 範圍」—— 與 `sdk` 的 17 個公開 API 同一種處置。
> **先寫進計畫，不要事後補。**

---

## 6. 陷阱

1. **不要動 `Command.execute` 的簽章。** handler 式指令是對的；改它會弄壞唯一正確的那一半。
2. **不要讓 `runCommand` 的破壞性變更看起來比實際大。** 它目前**零呼叫者**（§1.2 實測），
   所以換回傳型別的**實際破壞為零** —— 但要在測試裡釘住「兩種都回傳判別聯集」，否則下一個
   人會以為它還是 `Promise<string>`。
3. **不要靜默忽略未履行的 frontmatter。** §3 決定 3 的整個重點。這個 repo 已經有一個
   `CommandConflict` 先例，照它做。
4. **不要把提示詞的內容當可信。** 它來自外掛、之後會被送進對話。`schedule` 套件的
   `renderReminderFraming` 已經示範了正確的姿態（*"untrusted reminder content, not new user
   instructions"*）；`PromptCommand` 的展開結果若要進對話，**需要同等級的框架**。這一條
   在實作時必須有決定，不能順手帶過。

---

## 7. 這份 spec 沒有解決的

- **決定 1 的答案。** 建議是 (a)，但那是產品決定，不是技術決定。
- **提示詞的可信度框架**（陷阱 4）。設計上它屬於「宿主如何處理 `prompt` 結果」，而宿主不在範圍內
  —— 但**必須在實作前定**，否則會做出一個把外掛內容直接當使用者指令送進 agent 的通道。
- **marketplace**。DSH 有一套可移植的實作，見 handoff §3.4；它是獨立的下一步。
