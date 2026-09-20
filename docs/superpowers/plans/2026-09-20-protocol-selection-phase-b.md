# 協議選擇 — 階段 B 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一個正在跑的 session 能夠**當場換掉模型 client**，而且**每一個會發真的、要花錢的請求的持有者都跟著換** —— 不留任何一個在舊端點上。

**Architecture:** 一個**身分穩定的把手**（`ModelClient` 物件，其 `stream` 轉發給一個可變的 `current`），在組裝建立時就交給所有持有者。持有者的型別與呼叫點**都不動**；rebind 是對那個 cell 的一次賦值。

**Tech Stack:** pnpm/TypeScript ESM monorepo · vitest · 既有 `ProviderRuntime.resolveModel`

**Spec:** `docs/superpowers/specs/2026-09-19-protocol-selection-design.md`（§4、§4.1、§4.2、§4.3、§6、§10 階段 B）
**前置：** 階段 A 已完成並推送（`083d2eb0..f9997e10`）；其記錄是 `docs/handoff/2026-09-19-protocol-selection-phase-a.md`。

## Global Constraints

- **一個新 export 必須與它的消費者同一個任務落地。** 可達性儀器把 `export interface` / `export type` 也算成 row。
- **提交不得有 `Co-Authored-By` trailer。**
- **不靜默降級。** 這一整個單元的存在就是為了消除一個靜默的部分成功 —— **一個持有者沒換到，就是那個缺陷**。
- **不碰 `llm-*` 五個適配器。**
- **不改 `llm.providers` 的設定形狀。**
- 每個任務結束時：`pnpm -r --no-bail test`、`pnpm typecheck`、`node scripts/audit/check-reachability.mjs --gate` 印 `gate PASS -- no new rows`。

## ⚠ 已知的既有 flake

`packages/settings` 的 `test/layering.test.ts:201` 在**平行全套跑裡約一半的機率**會以 `expected 2 to be 1` 失敗，隔離跑必過。機制是既有的 `watchSettings` race（**沒有 in-flight guard** 的 10ms 輪詢 + 非原子 `writeFile`）。**重跑一次、記錄、繼續 —— 不要追，更不要為了讓數字好看去改測試。**

---

## 範圍修正 —— spec §10 的階段 B 機制**不足以達成它自己的目的**（實測）

spec §4.1 說模型 client 有「**兩個**消費者」，而「**一個改動涵蓋兩個消費者**」（`:125`）。

**偵察量到的：一個 session 生命週期裡，多個持有者或讀者共享一個解析出來的 client。**

> ### ⚠ **不要引用總數 —— 引用列舉。**
>
> 這份計畫寫過兩個互相矛盾的總數（「9 個裡 8 個」與「8 個裡 7 個」）。**Task 3 的實作者拒絕印出任一個**，並要求有人用可量測的方式定下來 —— **那是對的**。
>
> **真相是：總數取決於怎麼分組，所以它不該被引用。**
> - 引擎的**建構時複製**與**它自己的讀取**是**同一個消費者**（加把手後合一）。
> - **service 的 memoized binding 不是持有者，是一個會變舊的「回報者」** —— 它不發請求，它**報導**（Task 4 的 F1）。
>
> **下表是裁決，不是總數。** 引用時用「**六個隨把手、兩個由設定指名、一個是回報者**」，或直接用表格。

| # | 持有者 | 抓取時機 | `agent.setModel` 碰得到嗎 |
|---|---|---|---|
| 1 | 回合迴圈（`core-agent/src/index.ts:290`） | 使用時 | ✓ |
| 2 | 壓縮引擎的**建構**（`core-agent/src/index.ts:142`） | **建構時** | ✗ |
| 3 | 引擎自己的讀取（`compaction/src/index.ts:114`） | 使用時，讀它自己的字面量 | 取決於 2 |
| 4 | **`config.summarizationModel`**（`compaction/src/config.ts`） | **在設定裡，扛過任何 rebind** | ✗（且它 `??` **勝過** `deps.model`） |
| 5a | 子代理（`assembly.ts:785` 的 `parentModel: model` → `subagent/src/child.ts:259,275,281`） | 建構時，逐次 spawn 讀 | ✗ |
| 5b | 監護者（`assembly.ts:830` 的 `parentModel: model` → `guard-approval/.../reviewer.ts:137`） | 建構時 | ✗ |
| 5c | 隊友（`assembly.ts:866` 的 `parentModel: model` → `agent-team/src/scheduler.ts:77,204`） | 建構時 | ✗ |
| 6 | auto-title（`assembly.ts:960` 的 `model,` → `run.ts:661` → `session-title/src/index.ts:56`） | 建構時 | ✗ |

> **行號基準：`cd47c730`。** 這張表的第一版引的是**加把手之前**的行號（`764`/`809`/`845`/`939`），加把手把它們整體推移了 —— **T1 的審查抓到這件事**。**引用一律附上該行的內容**（`parentModel: model`、`model,`），因為 Task 1 的後續修正仍在改同一支檔案的註解，**行號會再動，內容不會**。**動任何一行之前先 `grep -n` 量一次。**
| 7 | service 的 memoized binding（`service.ts:211-224`, `:278`） | 建構時輸入 | ✗ |

**§4.1 的理由是**「只換一個 → 摘要會留在舊端點上 —— 而那是**要花錢的呼叫**」。**同一個理由對 5a/5b/5c/6 逐字成立**：rebind 之後 spawn 的子代理、監護者檢視、隊友、auto-title 全部**用舊 client 發真的請求，而且沒有任何東西會說出來**。

**依 spec 字面實作階段 B，就是出貨一個靜默的部分成功 —— 這個單元存在的理由所要消滅的東西。**

### 裁定 R-B1：用**把手**，不用 getter

spec 的機制（`AgentDeps.model` 改成 `() => ModelClient`、新增 `Agent.setModel`）是為了繞過「建構時抓走」。**偵察量到那條路不必走：每一個持有者都持有同一個物件**。

所以：**一個身分穩定的 `ModelClient` 把手，其 `stream` 轉發給一個可變的 `current`。**

- 型別零改動 ⇒ **56 個 `createAgent(` 呼叫點（實測；第一版計畫寫「~85」，是估的）與 `agent.test.ts` 的 19 個 `deps.model = …` 賦值全部不用動**。
- 持有者的呼叫點零改動 ⇒ 子代理／監護者／隊友／auto-title **自動跟著換**。
- ⚠ **`expect(assembly.model).toBe(model)`（`service.test.ts:69`, `:246`）不會照樣成立。** 計畫的第一版說它「照樣成立，而且更穩」—— **假的**。
  **但第二版給的理由也是假的。** 我寫「若它等於原始 client，rebind 就沒有東西可以轉發」—— **審查員跑了反事實把它推翻**：把 `get model() { return currentModel }` 放進回傳字面量，**配著未修改的 `service.test.ts`，29/29 全綠**，兩條身分斷言都成立。
  **理由**：持有者捕捉的是**區域的把手**（`assembly.ts:785/:830/:866`、agent deps `:938` —— 行號基準 `cd47c730`），它們**不讀 `assembly.model`**。那個屬性只有**一個**生產讀者（auto-title，`run.ts:661`，使用時讀取），而 getter 一樣服務得了它。
  **所以「那兩條測試必須改」是設計選擇，不是必然。** 而把手真正的好處在**另一個方向**：**一個提早快照 `assembly.model` 的持有者，在把手下會跟著換，在 getter 下會變舊。** 那才是 R-B1 的理由。
  改法是**保留各自的主題、改成行為式釘住**（那一回合的請求落在該 client 的記錄器裡，且**恰好一次**；那次執行產出**第二個** client 的腳本），**不是刪掉它們、也不是放寬成什麼都接受**。審查員用**獨立突變**驗過：兩條各自仍會為**原本的那個缺陷**變紅。（`cd47c730` 就是這樣改的。）

**代價**：spec §4.2 的 `agent.setModel` **不存在**；cell 屬於組裝，所以動詞是 `assembly.setModel`。**spec §10 的「`core-agent` 的 model getter」整條作廢。**

### 裁定 R-B2：`config.summarizationModel` **維持勝出**，但必須**說出來**

`compaction/src/index.ts:114` 是 `config.summarizationModel ?? deps.model`。一個明確設定的摘要模型**是使用者的選擇**，rebind 不該靜默丟掉它。

**但這代表「rebind 之後摘要仍在舊端點」對那樣的設定是真的** —— 所以 Task 3 必須把它**測出來並寫下來**，不是讓它隱形。

---

### Task 1: 組裝的模型變成一個把手

**Files:**
- Modify: `packages/session-executor/src/assembly.ts`（`:330` 的 `const model`，`:228` 的 `SessionAssembly`）
- Test: `packages/session-executor/test/assembly.test.ts`、`packages/session-executor/test/service.test.ts`

**Interfaces:**
- Consumes: 今天的 `const model: ModelClient = opts.model ?? (…)()`（`assembly.ts:330`）
- Produces: `SessionAssembly.setModel(client: ModelClient): void` —— **`ModelClient` 型別不變**，所以下游零改動。

- [ ] **Step 1: 先量持有者（在任何修改之前）**

```bash
grep -rn "parentModel" packages/ --include=*.ts | grep -v test
grep -rn "assembly\.model\|\.model\b" apps/cli/src/run.ts | head
```

把「有幾個地方會在 rebind 之後仍持有舊 client」的數字寫進報告。**任務結束時測試的增減要對得上它。**

- [ ] **Step 2: 寫失敗的測試 —— 這一條就是整個單元的價值**

`packages/session-executor/test/assembly.test.ts`：

**名字是形狀，不是 API** —— `buildFixture`、`recording` 都是**佔位名**，你要用**這支測試檔既有的**東西：

- **組裝怎麼建**：`packages/session-executor/test/assembly.test.ts:31-41` 已經 mock 了 `@i-harness/core-agent` 並捕捉傳進去的 deps。**用它**，把 `model` 換成你的記錄 client。
- **記錄 client**：`packages/subagent/test/child.test.ts:253` 的 `recordingModel()`（回傳 `ModelClient & { requests: LLMRequest[] }`）。**先讀它**，用同一個形狀；`packages/provider-runtime/test/runtime.test.ts:56` 的 `capturingModel()` 是第二個先例。**不要新造第三種。**

```ts
it("a rebound model reaches every holder, not just the turn loop", async () => {
  // The design said "two consumers, one change covers both" — measured, a
  // session's lifetime has EIGHT holders of a resolved client. This test is the
  // deliverable: it fails if the handle stops forwarding — it measures the
  // handle, the direct stream, the agent deps and the turn. The full eight-holder
  // enumeration is Task 2's job; a name that claimed it here would be a claim
  // wider than its measurement, which is this unit's own subject.
  // partial success this whole unit exists to remove.
  const first = /* the recording client, fresh */ null as never
  const second = /* a SECOND recording client, distinguishable from the first */ null as never
  const assembly = /* build via this file's existing fixture, with model: first */ null as never

  // ⚠ `assembly.model` is the HANDLE, never the injected client — if it were the
  // client, a rebind would have nothing to forward through. So identity is
  // asserted against the handle, not against `first`.
  const handle = assembly.model
  expect(handle).not.toBe(first)

  assembly.setModel(second)

  // (a) the handle forwards — and its IDENTITY is stable, which is exactly what
  // lets every holder keep working without being re-wired.
  expect(assembly.model).toBe(handle)         // same handle…
  for await (const _ of assembly.model.stream(request)) void _
  expect(second.requests).toHaveLength(1)     // …but the request went to the NEW client
  expect(first.requests).toHaveLength(0)

  // (b) the agent the lane runs on reads through the same handle — proven with a
  // REAL turn, not by asserting the agent object exists.
  await assembly.agent.run("go")
  expect(second.requests.length).toBeGreaterThan(1)   // the turn landed on the NEW client
  expect(first.requests).toHaveLength(0)
})
```

**上面那三個 `null as never` 不是要你照抄 —— 它們標出「這三個值要從既有 fixture 來」。** 把它們換成真的值，`as never` 一個都不准留。

**兩個細節，實作者要自己核對，不要發明**：
- **請求記錄用的 client 這個 repo 已經有了**：`packages/subagent/test/child.test.ts` 的 `recordingModel()`（它回傳 `ModelClient & { requests: LLMRequest[] }`）。**先讀它**，用同一個形狀；若那個檔案裡沒有，`packages/provider-runtime/test/runtime.test.ts` 的 `capturingModel()` 是另一個先例。**不要新造第三種。**
- 上面 `stream({ … })` 的請求物件要符合 `LLMRequest`（`packages/llm-seam/src/index.ts`）——它的必填欄位是 `messages` / `tools` / `systemPrompt`。**照既有測試怎麼建請求物件的樣子寫。**

- [ ] **Step 3: 跑它，確認它紅**

Run: `cd packages/session-executor && npx vitest run test/assembly.test.ts`
Expected: FAIL —— `assembly.setModel is not a function`

- [ ] **Step 4: 把 `const` 換成 cell + 把手**

`packages/session-executor/src/assembly.ts`（`:330` 附近）：

```ts
  // ONE stable handle, ONE mutable target. The handle is what EVERY holder gets
  // — the agent's deps, the subagent tools, the guardian, the team scheduler,
  // and `assembly.model` itself — so a rebind is a single assignment and no
  // holder has to be told. Changing the TYPE instead (`model: () => ModelClient`)
  // would have reached the same goal while touching 56 `createAgent` call
  // sites; the handle costs none of that, and `assembly.model`'s identity — the
  // stable, which is what the service tests already pin.
  //
  // Design: protocol-selection §4.1 — which said "two consumers" and was
  // measured wrong (eight). See the plan's scope ruling R-B1.
  let currentModel: ModelClient = opts.model ?? (() => { /* the existing resolution */ })()
  const model: ModelClient = {
    stream: (request) => currentModel.stream(request),
  }
```

然後在 `SessionAssembly`（`:228`）加：

```ts
  /** Swap the client this assembly's handle forwards to. Every holder follows —
   * they all hold this same object. Identity of `model` does NOT change, which
   * is deliberate: holders are never re-wired. */
  setModel(client: ModelClient): void
```

並在組裝的回傳字面量（`:936` 附近）加 `setModel: (client) => { currentModel = client }`。

- [ ] **Step 5: 跑它，確認它綠**

Run: `cd packages/session-executor && npx vitest run test/assembly.test.ts test/service.test.ts`

- [ ] **Step 6: 突變證明（不可跳過）**

把把手改回直接傳 `currentModel`（即 `const model = currentModel`），重跑 Step 3。
Expected: **RED**。**這個機制預測被改過兩次，兩次都不準 —— 以實測為準，以下是最後一次量到的：**

- `assembly.model` 的**身分不變**（它一直都是那個把手物件）—— 所以**不是**靠身分紅的。
- 真正的紅在**控制斷言**：`expect(handle).not.toBe(first)` 先失敗（`Object.is` 相等，因為 `first` 就是那個被注入的 client，經由把手暴露出來）。
- **轉發**的紅（`second.requests` 是空的）排在控制斷言**後面**，所以在這裡**看不到**。

**這一題的教訓**：一個突變「會紅」很容易斷言，**「紅在哪一行、為什麼」卻要量**。把觀察到的訊息原文貼進報告，然後改回來。

- [ ] **Step 7: 全套 + gate + commit**

```bash
pnpm -r --no-bail test && pnpm typecheck && node scripts/audit/check-reachability.mjs --gate
git add -A
git commit -m "feat(session-executor): one model handle every holder reads through"
```

---

### Task 2: 證明**每一個**持有者都跟著換

Task 1 證明的是把手本身。**這一題證明持有者逐個跟隨**（**隨把手的那些** —— 由設定指名的兩個是 Task 3 的，回報者是 Task 4 的 F1）—— 少了這一題，把手只是一個好主意。

**Files:**
- Test: `packages/session-executor/test/assembly.test.ts`（或既有的 subagent/guardian/team 測試檔，**用既有 harness**）

- [ ] **Step 1: 逐個持有者寫一條斷言**

至少覆蓋：**agent 回合迴圈**、**壓縮引擎**、**子代理 spawn**、**監護者**、**隊友**、**auto-title 讀到的 `assembly.model`**。

```ts
it("every holder follows a rebind — enumerated, not sampled", async () => {
  // Each assertion names the holder and the plan's ruling it belongs to (R-B1's
  // table). A holder that stops following must fail HERE, by name, rather than
  // silently billing an old endpoint.
})
```

**若某個持有者**在既有的 harness 下**無法被驅動**（例如監護者只在一條特定的審批路徑上跑），**不要假裝測到**：把它列進報告的「無法在此 harness 覆蓋」清單，並說明需要什麼。**一個誠實的缺口比一條假的斷言有價值。**

- [ ] **Step 2: 突變證明**

把把手換回 `currentModel`，逐條確認哪些斷言紅。**沒有紅的那一條，就是沒有真的測到。**

- [ ] **Step 3: 全套 + gate + commit**

```bash
pnpm -r --no-bail test && pnpm typecheck && node scripts/audit/check-reachability.mjs --gate
git add -A
git commit -m "test(session-executor): every holder follows the rebind, enumerated"
```

---

### Task 3: **兩個「設定的模型」**的邊界 —— 都被測出來、都寫下來

**有兩個持有者由「設定」指名，因而繞過把手。它們是同一類，所以同一題。**

**(a) `config.summarizationModel`** —— `compaction/src/index.ts:114` 是 `config.summarizationModel ?? deps.model`。**一個明確設定的摘要模型在 rebind 之後仍留在舊端點。**

**(b) 宿主設定的 guardian model** ——（**T1 的審查找到，計畫的第一版漏了它**）`assembly.ts:831` 的 `...(opts.guardian.model !== undefined ? { model: opts.guardian.model } : {})` 把它傳給監護者，而 `guard-approval/src/guardian/reviewer.ts:137` 是 `deps.model ?? deps.parentModel` —— **設定的贏，而且它在建構時被捕捉**，所以 rebind 之後**每一次監護者檢視仍計費在舊端點**。
**它今天只有測試碼設定**（`apps/cli/test/guardian.test.ts:30`），**沒有生產呼叫者** —— 所以它是一個**埋著的地雷，不是一個正在流血的傷口**。**照樣要處理**：一個「只換了 8 個持有者中的 7 個」的 rebind，正是這個單元要消滅的東西，而它不會等到有人用了才變成真的。

**照 R-B2 兩者都維持勝出** —— 它們是使用者的設定，rebind 不該靜默丟掉它們。**但這個後果必須是可見的**，否則它就是那個單元要消滅的靜默例外。（**R-B2 原本只寫給 (a)；這一題把它擴到 (b)** —— 同一個規則、同一個代價。）

**Files:**
- Test: `packages/compaction/test/`（既有的 engine 測試檔）
- Test: `packages/guard-approval/test/`（既有的監護者測試檔）
- Modify: 兩處 `??` 上方的註解（若它們沒說出這件事）

- [ ] **Step 1: 寫測試把 (a) 的邊界釘住**

```ts
it("a CONFIGURED summarization model wins over the handle — a documented boundary, not an oversight", () => {
  // R-B2: the rebind does not silently discard a user's explicit summarization
  // model. The cost is stated: for such a configuration the summarizer stays on
  // the configured endpoint after a rebind. This test is what makes that
  // visible instead of invisible.
})
```

- [ ] **Step 1b: 寫測試把 (b) 的邊界釘住**

**這條要用既有 harness 驅動一次監護者檢視**，然後斷言：一個**設定了** `guardian.model` 的組裝，在 rebind 之後**仍走那個設定的 client**。

```ts
it("a CONFIGURED guardian model wins over the handle too — the same boundary, the same cost", () => {
  // Found by T1's reviewer, absent from this plan's first version. Same class as
  // R-B2's summarizationModel: a host-configured model is a deliberate choice and
  // the rebind does not discard it. Same visible cost: for such a configuration
  // every guardian review keeps billing the configured endpoint.
})
```

**若那個 harness 驅動不了監護者**，**不要假裝測到**：把它列進報告的「無法在此 harness 覆蓋」清單，說明需要什麼，並**在 (b) 的註解裡寫下這件事還沒被測試釘住**。**一個誠實的缺口比一條假的斷言有價值。**

- [ ] **Step 2: 讓兩處註解都說出它**

若 `compaction/src/index.ts:114` 或 `guard-approval/src/guardian/reviewer.ts:137` 上方的註解沒說「設定勝過把手，而這是刻意的」，補上，並引用 R-B2。

- [ ] **Step 3: 全套 + gate + commit**

---

### Task 4: SDK 的 `setSessionModel` 當場生效

**這是階段 B 的第一次真正的 rebind** —— 也是**我上一個單元刻意設下的陷阱會觸發的地方**。

`packages/sdk/src/server.ts:715` 的註解已經寫著這件事該怎麼做（那是上一個單元留下的），而 `apps/cli/test/sdk-wire-v11.test.ts:177-214` 那條守衛**會變紅 —— 那是設計，不是意外**。它存在的目的就是逼出一個**刻意的**決定。

**Files:**
- Modify: `packages/sdk/src/protocol.ts`（wire 型別加回 `protocol?: string`）
- Modify: `packages/sdk/src/server.ts`（parser 接受它；傳給 relay）
- Modify: `apps/cli/src/index.ts`（relay 用**它**rebind，並在寫入前**剝掉**它）
- Modify: `apps/cli/test/sdk-wire-v11.test.ts`（**刻意地**改那條守衛）
- Test: 同上

**Interfaces:**
- Consumes: `SessionAssembly.setModel`（Task 1）、`SessionService.assemblyFor`（回傳**活的**組裝 —— 偵察確認快取優先且回傳存進去的那個參考）
- Produces: `session/model/set` 帶著協議 ⇒ **當場** rebind，且**不落地**。

- [ ] **Step 1: 先讀那條守衛的理由**

Read `packages/sdk/src/server.ts:715-743`（上一單元留下的註解）與 `apps/cli/test/sdk-wire-v11.test.ts:177-214`。**在動任何一行之前，在報告裡寫下：這條守衛為什麼存在、以及這次要怎麼「刻意地」改它。**

- [ ] **Step 2: 寫失敗的測試**

```ts
it("a protocol on the wire rebinds the LIVE session, and is never persisted", async () => {
  // Two halves, and BOTH matter:
  //  (a) the live assembly's handle now forwards to the newly resolved client —
  //      §4.2②'s "當場生效", not "next assembly";
  //  (b) the session HEADER still carries no protocol — §4.3, owner's decision.
  // (a) without (b) is the phase-B mistake the previous unit's guard was built
  // to catch; (b) without (a) is phase A, which already shipped.
})
```

- [ ] **Step 3: 跑它，確認它紅**

- [ ] **Step 4: 實作**

三件事，順序重要：
1. `packages/sdk/src/protocol.ts` 的 `SessionModelSelection` 加回 `protocol?: string`（**鬆的** —— 那個檔案是零依賴 wire 契約）。
2. `server.ts` 的 `parseModelSelection` 接受它；訊息裡要說明它**只為 rebind**。
3. `apps/cli/src/index.ts` 的 relay：**先用它 rebind**（`resolveModel` → `assemblyFor(sessionId).setModel(client)`），**再 `updateMeta` 一個不含 protocol 的選擇**。

**注意既有的事實**：`server.ts:365` 今天會 `closeSession`（銷毀組裝）。**當場生效就不需要它了** —— 但拿掉它是行為變更，**要在報告裡明說你做了什麼、為什麼**。

### ⚠ 前一題的審查找到的**前置條件**（F1，MEDIUM）—— 這一題不處理就會出貨一個新的說謊面

`setModel` **只動那個 closure cell**。而**回報用的**兩個表面不會跟著動：

- `assembly.modelLabel` 在**建構時固定**（`assembly.ts:966`、`service.ts:279` —— 行號基準 `cd47c730`）
- `SessionService.modelState` 讀的是 **memoized binding**（`service.ts:208-218`），而**只有 `closeSession` 會清它**（`service.ts:572`）

**而這一題的計畫要拿掉那個 `closeSession`。** 於是：**花費移到新端點，而 `session/model/state` 與 `session/list.modelLabel`（`server.ts:342/:366/:536-543`）繼續回報舊的 `provider:model`**，直到別的東西關掉 session。

**那正是這個單元要消滅的東西 —— 一個說的和做的不同的表面。**

**所以這一題要二選一，並在報告裡說你選了哪個、為什麼：**
1. **讓回報跟著換**（rebind 時重新解析 binding 並更新 label），**或**
2. **在計畫與程式碼裡明確記下這個限制**，讓它是一個**已知的邊界**而不是一個意外的謊。

**選 2 是可接受的，選「什麼都不做也不說」不是。**

- [ ] **Step 5: 刻意地改那條守衛**

它會紅。**紅是對的** —— 改成「header 仍然沒有 protocol」（(b) 那半），**不要**把它刪掉或放寬成什麼都接受。在測試裡寫下為什麼這次的改動是刻意的。

- [ ] **Step 6: 突變證明**

把 relay 裡「剝掉 protocol」那一步拿掉，確認 (b) 那半變紅。**那就是這個單元最重要的那條守衛。**

- [ ] **Step 7: 全套 + gate + commit**

---

### Task 5: `run --protocol`（一次性，不落地）

**Files:**
- Modify: `apps/cli/src/index.ts`（`RUN_FLAGS` `:196`、`RUN_VALUE_FLAGS` `:197`、任務過濾 `:342-348`、`USAGE` `:58-64`）
- Modify: `apps/cli/src/run.ts`（`HeadlessOptions` 加欄位；`:377-389` 的 `resolveModel` 把協議帶進去）
- Test: `apps/cli/test/run-flag-routing.test.ts`（**既有的路由契約，加一條 value-flag case**）

**Interfaces:**
- Consumes: Task 1/4 的機制
- Produces: `i-harness run --protocol P "任務"` —— **只對這一次 session 生效，settings.json 一字不變。**

- [ ] **Step 1: 寫失敗的測試**

```ts
it("--protocol rides THIS session only, and never reaches settings.json", () => {
  // Two halves: the flag is routed (not swallowed into the task — see the
  // existing strip list at index.ts:342-348), AND after the run the settings
  // file is byte-identical to before. §4.3: the session's protocol is not
  // written to any file.
})
```

- [ ] **Step 2: 跑它，確認它紅**

- [ ] **Step 3: 實作四個清單 + 解析**

`--protocol` 是**取值旗標**，所以它同時要進 `RUN_FLAGS` 與 `RUN_VALUE_FLAGS`，也要進任務過濾的**兩個** chain（旗標本身、以及它前面的那個 token）。**漏掉任何一個，`run "do x" --protocol P` 就會把 `--protocol` 當成任務文字送給模型** —— 這正是同一個檔案裡 `--no-compact` 曾經犯過的錯（見 `run-flag-routing.test.ts` 開頭的註解）。

值要在**設定鏈之外**驗證：不合法就拒絕並列出五個（與 `provider add` 同一個規矩）。

- [ ] **Step 4: 跑它，確認它綠**

- [ ] **Step 5: 全套 + gate + commit**

---

## 完成之後

**這條分支要留給工作電腦複核**：**不合併、不改名、不刪。**

**階段 B 仍然不包含**（spec §7）：session 協議的**持久化**（`run --protocol` 與 SDK 的協議都**不落地**，這是使用者的決定）、角色的 UI。

**parked、不在本計畫**（偵察找到的既有缺陷）：
- `packages/sdk/src/server.ts:170-177` —— **訂閱洩漏**：`assemblyUnsubscribes.set(...)` 覆蓋同一個 session 的前一個訂閱而沒先退訂，`close()` 只退當前那個。
- `apps/cli/src/index.ts:500-503` —— `liveAssemblies` 從不清理，`closeSession` 之後仍握著**已銷毀的組裝**，直到下一個被建起來。**本計畫的 Task 4 會碰這條路，實作者要確認自己拿到的不是屍體。**
