# 外掛 `agents/` 元件設計 — 2026-09-17

> **基準**：`m65` @ `aec2b451`（乾淨工作樹）。**量測來源**：本機的官方 marketplace 快照
> `~/.claude/plugins/marketplaces/claude-plugins-official`（39 個目錄，其中 **8 個帶 `agents/`**，
> 共 **35 個 `agents/*.md`**）。
> **範圍**：讓外掛以 `agents/*.md` 貢獻 subagent 角色。
> **不是**：`hooks/`。也不是 marketplace 的宿主面。

---

## 0. 這份文件是什麼、不是什麼

**是**：一個**先量測、後設計**的紀錄。§1 的每一個數字都來自上面那個快照，不是推論。
**「他們的格式長什麼樣」不是讀規格書得到的，是把 35 個真實檔案解析一遍得到的。**

**不是**：「加一個 capability 維度」這種看起來很小的改動。量完之後它不是。
**它踩到三個缺陷，其中兩個是既有程式碼裡的靜默失效，第三個是一個不存在的接縫。**

---

## 1. 量測：35 個真實 `agents/*.md`

### 1.1 格式


````
---
name: code-simplifier
description: Simplifies and refines code for clarity, ...
model: opus
---

You are an expert code simplification specialist ...
````

frontmatter + body，**body 就是 systemPrompt**。

### 1.2 frontmatter 鍵（35 檔）

| 鍵 | 次數 | 值的形式 | 我們的欄位 |
|---|---:|---|---|
| `name` | 32 | 單行 | `SubagentRole.name` ✅ |
| `description` | 32 | 單行 **或 `\|` 區塊純量** | `.description` ⚠️ 見 §2.1 |
| `model` | 24 | 單行（`opus`） | `.model` 形狀不同 ⚠️ 見 §3.4 |
| `tools` | 23 | 逗號分隔 **或 JSON 陣列** | `.tools` ⚠️ 見 §2.2 |
| `color` | 20 | 單行 | — 顯示用 |
| `effort` | 8 | 單行 | — 無欄位 |
| `initialPrompt` | 1 | 單行 | — 無欄位 |
| `assistant` / `Context` / `user` | 42 | — | **不是真的鍵**，見下 |

**最後一列是重點。** `assistant`(18) / `Context`(12) / `user`(12) 不是三個鍵 ——
它們是 **4 個檔案用 `description: |` 區塊純量**時，**內容被逐行誤讀成鍵**。
任何逐行的 frontmatter 解析器都會在這些檔案上產生約 15 個幻影鍵。

### 1.3 `tools:` 的四種形式

| 形式 | 檔數 | 例 |
|---|---:|---|
| 逗號分隔 | 19 | `Read, Glob, Grep, Bash` |
| **JSON 陣列** | **4** | `["Read", "Grep"]` |
| 帶作用域參數 | 6 筆 | `Agent(claude-security:explore)`、`Workflow(claude-security:scan)` |
| 無此欄位 | 9 | （CC 語意：繼承全部） |

### 1.4 外掛宣告的工具詞彙 —— **全部是 Claude Code 的**

| 外掛宣告 | 次數 | 扣掉大小寫後在我們的 registry |
|---|---:|---|
| `Read` | 19 | ✅ `read` |
| `Glob` | 18 | ✅ `glob` |
| `Grep` | 18 | ✅ `grep` |
| `Bash` | 14 | ✅ `bash` |
| `Write` / `Edit` | 5 / 5 | ✅ `write` / `edit` |
| `WebFetch` / `WebSearch` | 3 / 3 | ✅ `webfetch` / `websearch` |
| **`Agent`** | 5 | ❌ 應為 `spawn_agent`（需決定） |
| **`LS`** | 3 | ❌ 應為 `list_dir` |
| **`TodoWrite`** | 3 | ❌ 應為 `todo_write` |
| **`NotebookRead`** | 3 | ❌ **我們沒有** |
| **`KillShell`** | 3 | ❌ `process_kill`？`stop_task`？（歧義） |
| **`BashOutput`** | 3 | ❌ `get_task_output`？`job_output`？（歧義） |
| **`Workflow`** | 2 | ❌ **我們沒有** |
| **`AskUserQuestion`** | 1 | ❌ 應為 `ask_user_input` |
| **`TaskCreate/Get/List/Update/Output/Stop`** | 各 1 | ❌ `team_task_*` / `get_task_output` / `stop_task`（歧義） |

**結果：23 個帶 `tools:` 的 agent —— 15 個純大小寫折疊即可、8 個會有一部分對不上。**
沒有任何一個是「全部對不上」。

---

## 2. 三個缺陷

### 2.1 解析器：區塊純量會解析成一個字元的謊言

`packages/plugin-registry/src/commands.ts:parseCommandMarkdown` 的 frontmatter 解析器
**只支援單行值**。套到 `agents/*.md`：

```
description: |                       →  meta.description = "|"
  Use this agent when the user ...   →  被當成鍵（而它沒有冒號，或以內容裡的冒號斷開）
```

**角色會註冊成功、`list()` 看得到、而模型用來挑選 agent 的 description 是 `"|"`。**

**同一個解析器目前對 `commands/` 是安全的 —— 而且這是量出來的**：

| | 檔數 | 區塊純量 |
|---|---:|---:|
| `commands/*.md` | 30 | **0** |
| `agents/*.md` | 35 | **4** |

`commands/` 的 0 是這條路現在沒事的**唯一**理由。它不是設計保證，是運氣。

> 順帶記一個確認：`commands/` 的 30 個檔案裡 **19 個用 `argument-hint`（官方單數）**。
> 2026-09-17 修掉的「單數被靜默丟棄」，在真實輸入上是**載重的** —— 不是理論問題。

### 2.2 工具名：對不上的條目會被**靜默丟掉**，而丟掉的方向不安全

**修補前**，`packages/subagent/src/child.ts` 與 `tools.ts` 各有一份**完全相同**的迴圈：

```ts
// 修補前（兩處一字不差）
for (const name of opts.role.tools) {
  const tool = opts.parentRegistry.get(name)
  if (tool) childReg.register(tool)     // ← 找不到？靜默跳過，不回報、不記錄
}
```

**`if (tool)` —— 沒有 else，沒有 warn，沒有記錄。**

而同一個函式往下幾行的**未知 provider 是 throw**（現 `child.ts:154`）：
「角色指了一個不存在的 provider」大聲失敗，「角色指了一個不存在的工具」完全隱形。
**同一個函式裡兩種相反的姿態，是這一段是疏漏、不是設計決定的最好證據。**

**已修（本設計的第一步，先於 agents 落地）**：兩處收斂成 `resolveRoleTools(roleName, declared, parent, child)`
（現 `child.ts:60`，呼叫點 `child.ts:148` 與 `tools.ts:552`），
回傳對不上的名字並 warn 一次，回傳值同時是「呼叫端可以記錄」的通道。
**刻意是 warn、不是 throw** —— 與下面的 provider 不對稱是**有理由的**：
指到不存在的 provider 的角色根本跑不起來，而**少一個工具的角色還是能跑**，
只是能力比它的角色宣告少。宿主沒有 `pwsh` 時，builtin 角色必須仍然可 spawn。

所以把 `tools: Read, Glob, Grep` 直接傳進去，子 agent 會拿到 **0 個工具**：
角色註冊成功、清單看得到、跑起來什麼都不能做。

而反方向的失敗更該注意：**`tools:` 是一個「限制」，不是「授權」。**
一個宣告 `Read, Glob, Grep` 的唯讀 agent，如果我們決定「不支援這個欄位」而給它預設全集，
我們就**擴大了外掛宣告的權限** —— 它拿到了它明文排除的 `write` 與 `bash`。
**這是 fail-open，比無聲無息更糟。**

### 2.3 接縫：宿主根本拿不到 `RoleRegistry`

`createSessionAssembly` 的回傳（`packages/session-executor/src/assembly.ts:837-882`）是：

```
ctx · agent · session · sessionId? · model · modelLabel? · inbox · telemetry?
killJob · tasks() · cancelTask · compactNow · pluginMcpResults · rewind? · dispose
```

**沒有 `roles`。**

`subagent.roles` 在組裝**內部**被用到（`:707` 給 guardian、`:738` 給 team），
但**從未離開組裝**。生產路徑上 `roles.register` 只被三種東西碰到：

1. `registerSubagent` 播種 `builtinRoles()`（`subagent/src/index.ts:116`）
2. `persist.ts` 從快照還原（`:271`，以及 `:105` 的去重）
3. `guard-approval` 的 `ensureReviewerRole`（`reviewer.ts:127`，由組裝自己的 guardian 掛載驅動）

**三種都是「系統自己餵自己」。沒有一條路徑能讓外部的東西貢獻角色。**
所以 `agents/` 元件**沒有地方可以落地** —— 就算 registry 認得 `agents/`。

**這與 `SkillsMountConfig.extraDirs` 是同一種形狀**：不是「沒接線」，
是**接線的另一端不存在**。當時的處置是先建那一端（`a1d46bba`），這裡也一樣。

---

## 3. 設計

### 3.1 資料流（與 §2 of the mount spec 同一條）

```
宿主（今天：CLI；重建後：前端）
  │  讀 runtimeInputs().agentDescriptors
  ↓
createSessionAssembly({
      pluginAgents: toSubagentRoles(inputs.agentDescriptors, { defaultTools, existingRoleNames }),
    })
  ↓
  組裝在 registerSubagent 之後，逐個 register 進 subagent.roles
```

**組裝吃資料、不吃 registry** —— 與 `pluginMcp` / `skills.extraDirs` 同一個原則。

### 3.2 解析：`packages/plugin-registry/src/agents.ts`

與 `commands.ts` 同一個形狀：`parseAgentMarkdown(fileName, text)` + `describeAgents(dir)`。

**frontmatter 解析器要共用，所以要先把區塊純量做對。** 範圍：
`|` / `|-` / `>`（以及它們的縮排內容），**只到足以讓內容不被逐行誤讀成鍵**。
不引入 yaml 依賴 —— 這個套件拒絕 yaml 是有意的，維持。

**`unsupported` 機制照用**：`color`、`effort`、`initialPrompt`、`model`
都是「我們不履行」的欄位，**記錄而不是丟掉**（`commands.ts` 的既有先例）。

### 3.3 `toSubagentRoles` —— registry 端的結構化轉換

與 `mount.ts:toMcpServerConfigs` 同一個手法：**逐欄位構造，不 import 任何型別。**

```ts
interface AgentDescriptor {
  name: string
  description: string
  systemPrompt: string          // = body
  tools?: string[]              // 外掛宣告的，CC 詞彙
  unsupported?: string[]
}
```

轉換規則：

1. **`tools` 缺席**（9/35）→ 用宿主提供的 `defaultTools`，**不是** registry 的全集。
   外掛不該因為「沒說」就拿到宿主的所有工具。
2. **`tools` 存在** → 逐個查**明示對照表**（§3.4）；對得上的給，**對不上的丟掉並記錄**。
   - 方向必須是**只縮不擴**：丟掉一個工具 = agent 少了能力 = 看得見的失敗。
   - 猜一個對應（`KillShell → stop_task`）是**給錯權限**，比丟掉糟。
3. **帶作用域參數的條目**（`Agent(x:y)`、`Bash(git:*)`）→ **不是工具名**，一律丟掉並記錄。
   我們沒有 per-tool 參數範圍這種東西，假裝有就是說謊。
4. **`model` 不履行** —— 與 §4.2 of the mount spec 一致（v1 忽略 `model`），
   但**記錄**。理由不只是極簡：`SubagentRole.model` 帶 `provider`，
   而** provider 是宿主的**（與 `blockedTools` / `auth` / `roots` 同一條邊界）。
   `builtinRoles()` 全部不帶 model，繼承 parent —— 外掛 agent 也一樣。
5. **名字衝突** → **跳過並記錄**，永不覆蓋。先例有兩個：
   `pluginMcp` 是逐個掛載 + `Map<string, boolean>` 記錄成敗；
   工具註冊是 `if (!parentRegistry.get(tool.name))` 跳過。**兩者都選了跳過，不是覆蓋。**

### 3.4 對照表 —— 由 §1.4 的量測決定，不是猜的

**明示對應（意圖無歧義）：**

| CC | I-harness |
|---|---|
| `Read` `Write` `Edit` `Glob` `Grep` `Bash` `WebFetch` `WebSearch` | 同名小寫 |
| `LS` | `list_dir` |
| `TodoWrite` | `todo_write` |
| `AskUserQuestion` | `ask_user_input` |
| `Agent` | `spawn_agent` |

**不對應（記錄後丟掉）：** `NotebookRead`、`Workflow`、
`KillShell`、`BashOutput`、`TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate`/`TaskOutput`/`TaskStop`。

**`KillShell` / `BashOutput` / `Task*` 進「不對應」是刻意的**：它們**有**形似的候選，
而形似正是危險所在 —— `BashOutput` 對 `get_task_output` 還是 `job_output`？
`TaskOutput` 也一樣（取 agent job 的輸出，還是 shell job 的？）。
選錯就是**給了一個它沒要的工具**。
**整個 `Task*` 家族要嘛一起對應、要嘛一起不對應** —— 只對應其中幾個是半套的對應，
而半套比不套更難發現。這一條留給後續有證據時再開。

### 3.5 組裝：`pluginAgents` 選項

```ts
// packages/session-executor/src/assembly.ts
pluginAgents?: SubagentRole[]         // 已由宿主轉換完成
```

在 `registerSubagent` 之後、`subagent.ready` / guardian / team **之前**註冊
（三者都讀 roles）。逐個 `try { roles.register(role) } catch { 記錄 false }` ——
`RoleRegistry.register` 對重複名**會丟**，那個 throw 就是「跳過」的實作，
不需要新 API。

回傳面加 `pluginAgentResults: Map<string, boolean>`，與 `pluginMcpResults` 完全對稱。

### 3.6 `Capability` 從三個成員長到四個

```ts
export type Capability = "skills" | "commands" | "mcp" | "agents"
```

`inspectCapabilities` 加一行 `agents: existsSync(join(pluginDir, "agents"))`。
`RuntimeInputs` 加 `agentDescriptors: AgentDescriptor[]`。

---

## 4. 紅先測試

### 4.1 已落地：§2.2 的靜默丟棄

`packages/subagent/test/child.test.ts` 的 `resolveRoleTools` 兩條。
**先紅的證明不是「跑過」，是 mutation**：把函式改回修補前的行為（不 warn、回傳 `[]`）→
`expected [] to deeply equal [ 'Read', 'NotebookRead' ]`。已驗證、已還原。

兩條斷言的形狀值得記：宣告 `["read", "bash", "Read", "NotebookRead"]`
—— **同時餵進我們自己的詞彙與 Claude Code 的詞彙**，
所以它釘住的不只是「有沒有回報」，還有**兩個詞彙確實不相等**這件事。

### 4.2 待落地

| 測試 | 先紅於 |
|---|---|
| `parseAgentMarkdown` 對 `description: \|` 給出**多行**描述，且**不**產生 `Context`/`user`/`assistant` 幻影鍵 | 解析器只吃單行；幻影鍵會進 `unsupported` |
| `describeAgents` 讀 4 種 `tools` 形式（逗號／JSON 陣列／作用域／缺席） | `describeAgents` 不存在 |
| `toSubagentRoles` 把 `LS` 映到 `list_dir`，**且**把 `NotebookRead` 丟掉並記錄 | 轉換不存在 |
| `toSubagentRoles` **不**讓外掛資料設定 `model` | 邊界不存在 |
| 名稱衝突 → 跳過並記錄，**builtin 不被覆蓋** | 同上 |
| `tools` 缺席 → 得到的是宿主提供的預設，**不是** registry 全集 | 同上 |
| 組裝註冊了外掛角色，且它**在 guardian / team 掛載之前**就在 `roles` 裡 | 接縫不存在；順序是新的 |

**Mutation proof（雙向）**：
- 把區塊純量處理拿掉 → 第一條必須轉紅
- 讓轉換把 `model` 填上 → 邊界測試必須轉紅
- 讓名稱衝突改成覆蓋 → 衝突測試必須轉紅
- 把 `pluginAgents` 的註冊移到 `subagent.ready` 之後 → 順序測試必須轉紅
- §4.1 那條**已經做過**：改回修補前的行為 → 轉紅 → 還原

---

## 5. 這份設計沒有解決的

- **`hooks/` 作為外掛元件。** 它與本設計同形（能力齊備、無消費者）但是**不同的產品問題**：
  CC 的 `hooks/hooks.json` **沒有信任雜湊**（`{hooks:{Event:[{matcher,hooks:[{type,command,if,timeout}]}]}}`），
  而我們的 `HookHandlerSpec` **要求 `trust.sha256`，每次執行都重算比對，不符即 fail-closed deny**。
  **「第一次的信任錨點從哪來」在兩種格式之間沒有對應物** —— 那是設計問題，不是接線問題。
- **`Agent(...)` / `Workflow(...)` 的作用域語意。** 它們指的是**同一個外掛內的其他元件**，
  那是外掛內部的一張圖，我們沒有。§3.4 先丟掉並記錄。
- **`description` 的長度。** 4 個區塊純量的描述是 30 行以上、內含 `<example>` XML。
  它們是**寫給模型看的**，塞進 subagent 清單會很貴。要不要截斷是產品決定，本設計不做。
- **只量了一個快照、35 個檔案。** 另一個 marketplace（`glincker-marketplace`）的
  commit 停在 2025-11-13，沒有納入。**重測而不是引用。**
