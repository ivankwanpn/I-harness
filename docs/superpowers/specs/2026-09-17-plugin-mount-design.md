# 外掛掛載（Plugin Mount）設計 — 2026-09-17

> **基準**：`m65` @ `e78f3a67`（每一個座標都在此修訂重量過）
> **範圍**：讓 registry 產生的 `RuntimeInputs` **真的進到 agent 的組裝**。
> **不是**：marketplace。也不是 DSH 的移植。

---

## 0. 這份文件是什麼、不是什麼

**是**：把一個**等了很久的 seam** 的另一半寫完。

**不是**：DSH marketplace 的移植。**理由在 §1.3** —— 我們的架構與它不同，而不同的地方是決定性的。
DSH 值得參考的**只有它踩過的坑**（§4），不是它的結構。

---

## 1. 量測：這裡其實已經有九成

### 1.1 registry 端的產出已經完整

`packages/plugin-registry` 是 9 檔 / 2,166 行，實作了完整的生命週期：
`addSource` / `refreshSource` / `removeSource` / `catalog` / `install` / `uninstall` /
`enable` / `disable`，支援 **6 種 source 形式**（`git-subdir`、`url`、`github`、`git`、
`directory`、`file` —— 比官方 marketplace 實際用到的三種更寬）。

而它把「啟用後該給宿主的東西」收在一個**同步**方法裡：

```ts
// packages/plugin-registry/src/types.ts
export interface RuntimeInputs {
  skillDirs: string[]
  mcpServerConfigs: Record<string, MCP_CONFIG_SHAPE>
  commandDescriptors: CommandDescriptor[]
}
```

`runtimeInputs()` 每次呼叫都從 state + disk 重建，原始碼註解說它「per agent build」被讀。

### 1.2 assembly 端的接口已經存在，而且註解就是為外掛寫的

```ts
// packages/session-executor/src/assembly.ts:109,111
pluginMcp?: McpServerConfig[]     // per-server containment; pluginMcpResults reports
skills?: { extraDirs?: string[] } // plugin overlay skill roots
```

`pluginMcp` **完整實作**：逐個掛載，把成功／失敗記進 `pluginMcpResults: Map<string, boolean>`
（`:669-677`），並在 `:877` 匯出讓宿主回報**每個 server 的 containment 狀態**。
`extraDirs` 在 `:549` 直接傳給 `registerSkills`。

### 1.3 而「掛載」那一半從來沒有被寫 —— 這是本節的重點

跨整個**前端刪除前**的樹（`4ea5b5d^`），搜 `pluginMcp` 與 `extraDirs`：

| 出現位置 | 是什麼 |
|---|---|
| `assembly.ts` | 定義與實作 |
| `assembly.test.ts:523` | **一個測試** |
| — | **沒有其他任何地方** |

**所以沒有任何生產程式碼傳過它們。** 而 `runtimeInputs()` 的唯一消費者是被刪掉的 TUI：

```
4ea5b5d^:packages/tui/src/app/slash/impl/eco.ts:60
  const configs = registry.runtimeInputs().mcpServerConfigs
```

那個檔案是 `/mcps`、`/plugins`、`/skills`、`/hooks` 四個**面板**——它們把 registry 的內容
**列出來給人看**。web.ts 的註解把設計意圖講得最清楚，而它同時是這整件事的墓誌銘：

> *"runtimeInputs() is what **ENABLES plugins mount**; the views here **REPORT**."*

**回報的那一半做了，掛載的那一半沒做。** 這與那 7 個零消費者套件、與 `runCommand` 失去派送者，
是**同一個模式**：能力齊備、消費者被拆或從未寫。

### 1.4 所以範圍不是「marketplace」，是「把最後一哩寫完」

marketplace 的三件事（來源管理、安裝、目錄）**都已經在 registry 裡**，而且它們是**宿主的責任**
（一個 CLI 子命令或一個前端面板），不是 agent 組裝的責任。

**agent 組裝需要的只有一件事**：把 `runtimeInputs()` 的三個輸出餵給它已經有的三個接口。

---

## 2. 設計

### 2.1 資料流（宿主擁有 registry，組裝只吃資料）

```
宿主（今天：CLI；重建後：前端）
  │  擁有 PluginRegistry（root、sources、install/enable）
  │  每次 agent build 讀一次 runtimeInputs()
  ↓
  createSessionAssembly({
      skills:    { extraDirs: inputs.skillDirs },
      pluginMcp: toMcpServerConfigs(inputs.mcpServerConfigs),
    })
  ↓
  for (const desc of inputs.commandDescriptors)
      registerPromptCommand(ctx, createPromptCommand(desc))
```

**為什麼組裝吃資料而不是吃 registry：**
- 組裝保持**不做檔案 I/O**、不新增依賴 —— `registry.runtimeInputs()` 是同步的 `loadStateSync` + `readdirSync`
- 測試只要傳一個字面值（既有 `pluginMcp` 測試就是這樣做的）
- 與既有的 `skills.extraDirs` 參數形狀一致
- **宿主角色正確歸位**：今天 CLI 當宿主，重建後換前端當，組裝不動

### 2.2 MCP 轉換 —— 一個形狀轉換，與一條安全邊界

兩個型別不同，且差異**不是偶然**：

| | registry `MCP_CONFIG_SHAPE` | assembly `McpServerConfig` |
|---|---|---|
| 判別 | **無** —— 靠欄位推斷 | **`transport: "stdio" \| "streamable-http"`** |
| 名字 | **Record 的 key**（`plugin:<id>:<server>`） | **`serverName` 欄位** |
| stdio | `command?` `args?`（可選） | `command` `args`（**必填**） |
| http | `url?` | `url`（必填） |
| **宿主控制欄位** | **不存在** | `roots` / `blockedTools` / `directTools` / `auth` / `toolCallTimeoutMs` |

**最後一列是安全邊界，不是疏漏。** 外掛的 `.mcp.json` **不能**設定 `blockedTools`／`directTools`
（那是宿主的工具白／黑名單）、不能設定 `auth`、不能設定 `roots`。轉換**必須**維持這個方向：
**外掛資料永不流入那些欄位。**

轉換規則：
1. `url` 存在 → `transport: "streamable-http"`；否則 `command` 存在 → `"stdio"`
2. 兩者皆無 → **跳過並記錄**（不是靜默、也不是整體失敗）
3. stdio 缺 `args` → `[]`（官方格式允許省略）
4. **不設定**任何宿主控制欄位

### 2.3 命令

`commandDescriptors` → `createPromptCommand`（2026-09-17 已實作）→ `registerPromptCommand`。
`CommandDescriptor.unsupported`（今天新增）在此必須**被記錄到 record 上**，走
`PluginRecord.conflicts` 的既有先例 —— 那是「外掛仍啟用，限制被記錄」的既定形狀。

### 2.4 衝突避免

`RegistryOptions.existingCommandNames` 存在正是為了這件事，註解說它由宿主接
（*"Wired to the interaction catalog by Task 7/8"*）。宿主應傳
`() => listCommandNames(ctx)`，讓外掛指令不覆蓋 CLI 自己註冊的那七個。

---

## 3. 三個必須先定的決定

**決定 1：malformed 的 MCP 條目要怎麼辦？**
（a）跳過並記錄限制（`CommandConflict` 先例）· （b）整體安裝失敗 · （c）靜默跳過
**建議 (a)。** (c) 是這個 repo 一直在刪的缺陷類。

**決定 2：`unsupported` frontmatter 記在哪？**
（a）`PluginRecord.conflicts`（既有欄位，語意是「被擋下的命令」）· （b）新欄位
**建議 (a)**，並確認語意可接受 —— 它記的是「這個命令的某個欄位未被履行」，與「命令被擋下」不完全相同。
若語意不合，才開新欄位。

**決定 3：轉換函式住在哪？**
registry 不該知道 assembly 的型別，assembly 不該知道 registry 的。
（a）宿主層（今天的 CLI）—— 但重建後要重寫一次
（b）**registry 端以「結構化輸出」** —— 回傳形狀剛好符合 `McpServerConfig` 的物件，**不 import 任何型別**
（c）新套件
**建議 (b)**：它與今天 `createPromptCommand` 用結構化輸入避開依賴是**同一個手法**，而且
型別不合會在**宿主端**的 typecheck 爆出來 —— 那正是它該爆的地方。

---

## 4. DSH 值得參考的是什麼（而且只有這個）

`D:\deepseek-harness` 有一個**已落地**的 marketplace（14 檔 / 3,716 行，實測 296 個外掛）。
**不要移植它的結構**，理由有三，每一個都是我們與它的差異：

1. **它的宿主還活著，我們的被拆了。** 它的 marketplace 有一半是 web 面板；我們沒有前端，
   重建是另一個里程碑。
2. **它的 CLI 是產品，我們的不是。** 把 marketplace 做成 CLI 子命令在它那裡合理，在我們這裡
   是已被糾正過的層次錯誤。
3. **它的 `commands/` 也掛不上** —— 它自己 root-cause 了：*"這是格式缺口，不是接線缺口"*。
   我們今天**已經把那個缺口補了**（`PromptCommand`），所以我們在這條線上比它前面。

**要拿的只有三個迴歸陷阱**，每個都有它的測試形狀可以照抄：

| 陷阱 | 症狀 |
|---|---|
| **列 id 必須在安裝時記錄** | 改回從外掛名重算 → 「匹配不到任何列、什麼都沒寫、卻回報成功」 |
| **讀取絕不落地** | `materializeEntry` 會複製檔案 = 寫入。它用**整棵目錄樹快照比對**釘住「讀取不改變磁碟」 |
| **skills 必須平鋪落地** | `skill-filesystem` 只讀 `<root>/<name>/SKILL.md`，**不遞迴**。巢狀 → 安裝回報成功、面板顯示已安裝、**模型一個 skill 都拿不到** |

**第三個陷阱：查過了，我們不適用 —— 但查的過程發現了一個更嚴重的東西。**

`scanSkillsDir` **會遞迴**（`packages/skills/src/registry.ts:132` 的 `visit(dir, depth)`，逐層
`visit(full, depth + 1)`，有 `MAX_SKILL_DEPTH` 上限），且在 `depth >= 1` 接受 `SKILL.md`。
所以巢狀落地不會讓我們「裝了但模型拿不到」—— 那個陷阱的前提（只讀一層）不成立。

**但同一個位置藏著我們的版本，而且更糟：`skills.extraDirs` 是一個惰性（inert）選項。**

```ts
// packages/skills/src/tool.ts
export interface SkillsMountConfig {
  workspace?: string
  telemetry?: SkillTelemetryEmitter
  allowImplicitInvocation?: boolean
}   // ← 沒有 extraDirs
```

而 assembly 這樣傳（`assembly.ts:549`）：

```ts
...(opts.skills?.extraDirs !== undefined ? { extraDirs: opts.skills.extraDirs } : {}),
```

**TypeScript 不對展開的屬性做 excess-property 檢查，所以它編譯通過、執行時被丟掉。**
`createSkillRegistry` 只認兩個根目錄：`<workspace>/skills` 與 `~/.i-harness/skills`
（`registry.ts:194-197`）—— **沒有「額外根目錄」這個概念。**

**所以外掛 skills 不是「沒接線」，是「接線的另一端不存在」。** 就算把 registry 接上去，
外掛技能依然到不了模型 —— 症狀與 DSH 的第三個陷阱**一樣**，但機制不同，
而且它躲過了 typecheck。原始碼註解還把它寫成 *"plugin overlay skill roots"*：

> 一個被接受、被註解、被實作端忽略的選項 —— **這是這個 repo 一直在刪的那種缺陷**
> （「一條從不匹配的規則，讀起來像乾淨的掃描」）在今天的**第三次**現身。
> 前兩次是 `argument-hint` 的靜默丟棄，與我自己的 comment-masking。

**所以本設計的範圍必須加上一項**：`SkillsMountConfig` 要真的支援額外根目錄。
那是 skills 套件的改動，不是 assembly 的 —— 而它比接線更根本，**必須先做**。

---

## 5. Red-first 測試

| 測試 | 先紅於 |
|---|---|
| **`SkillRegistry` 能在一個額外根目錄下找到 skill** | **`SkillsMountConfig` 沒有 `extraDirs`，`createSkillRegistry` 只認兩個根** —— 這條會先紅在型別上 |
| `runtimeInputs().skillDirs` 被傳進 `createSessionAssembly` 後，該目錄的 skill 可被 `skill_search` 找到 | 現在沒有任何生產程式碼傳 `extraDirs`（而就算傳了也被丟掉） |
| `runtimeInputs().mcpServerConfigs` 轉換後掛載，且 `pluginMcpResults` 有該 server | `pluginMcp` 只有測試用過 |
| 轉換**不**讓外掛資料流入 `blockedTools`／`directTools`／`auth`／`roots` | 轉換還不存在 |
| malformed 條目被跳過**且記錄**，其餘照常掛載 | 同上 |
| `commandDescriptors` → `registerPromptCommand`，且 `runCommand` 回 `{kind:"prompt"}` | 同上 |

**Mutation proof（雙向）**：讓轉換把 `blockedTools` 填上 → 安全邊界測試必須轉紅；
讓 malformed 條目靜默跳過 → 記錄測試必須轉紅；
**把 `extraDirs` 從 `SkillsMountConfig` 拿掉 → 第一條測試必須轉紅**
（這條特別重要：它證明那個選項**現在**是惰性的，而不是「本來就沒人傳」）。

---

## 6. 這份設計沒有解決的

- **§3 的三個決定**。
- **§4 第 3 個陷阱的查證** —— 沒查之前不該實作。
- **marketplace 的宿主面**（來源管理／安裝／目錄的 UI 或 CLI 子命令）。它是獨立的，且依賴 §3 的
  決定與「宿主是誰」的最終答案。
- **`hooks` 的掛載**。它與本設計是同一種形狀（能力齊備、無消費者）但**不同的產品問題**：
  它需要「預設開或關」「對哪些宿主生效」「第一次的信任錨點從哪來」三個答案。
