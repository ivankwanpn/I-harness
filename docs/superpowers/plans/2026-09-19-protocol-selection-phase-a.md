# 協議選擇 — 階段 A 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓「沒有協議」變成一個**大聲的錯誤**，而不是一個靜默的 `openai-completions`；並讓一條 session 的模型選擇能自己帶協議。

**Architecture:** 那條硬編碼尾巴住在**一個地方** —— `packages/settings/src/sections.ts` 的 `resolveProviderProtocol`，全 repo **只有一個呼叫點**（`provider-runtime/src/index.ts:651` 的 `providerView`）。把它的回傳型別改成可缺席，缺席就往上傳成 `invalid`，訊息帶著路由名與修法。session 的協議走**既有的**那條路（`SessionMeta.modelSelection` → `resolveModel` 的 `sessionSelection`），只是型別與 header parser 要把欄位帶上。

**Tech Stack:** pnpm/TypeScript ESM monorepo · vitest · 既有 `ProviderRuntime.resolveModel`

**Spec:** `docs/superpowers/specs/2026-09-19-protocol-selection-design.md`（§1、§2、§6、§8、§10 階段 A）

## Global Constraints

- **一個新 export 必須與它的消費者同一個任務落地。** 可達性儀器把 `export interface` / `export type` 也算成 row。**這條在本 repo 已經抓到過兩次。**
- **提交不得有 `Co-Authored-By` trailer。**
- **不靜默降級**：解析不到就**大聲失敗**，不偷偷用別的。
- **不碰 `llm-*` 五個適配器**（spec §3：接縫以上不知道協議；換協議＝換 client 物件）。
- **不改任何既有的設定形狀**（spec §9）：沒有新欄位加進 `llm.providers`。
- 每個任務結束時：`pnpm -r --no-bail test` 全綠、`pnpm typecheck` 0 error、`node scripts/audit/check-reachability.mjs --gate` 印 `gate PASS -- no new rows`。

## 範圍修正 —— spec §10 有一項**已經做完了**

spec §10 的階段 A 列了四項。寫這份計畫時逐項對過程式碼，**第二項只對了一半**：

| spec §10 的階段 A | 現況 |
|---|---|
| `SessionModelSelection` 加 `protocol?` | **沒做** → Task 2 |
| `runtimeProfile` 那條鏈**多兩層** | **「角色」那層已經在了**（上一個單元：`assembly.ts:98` 的角色選擇型別 + `provider-runtime:608` 的 `selection.protocol ?? userModel?.protocol`）。缺的是**「session」那層**（Task 2 把型別補上，它就通了）**和鏈末端的「錯誤」**（Task 1）。 |
| **拿掉硬編碼尾巴** | **沒做** → Task 1（這是核心） |
| `provider list` 標出沒有協議的路由 | **沒做** → Task 3 |

**為什麼「角色」與「session」是同一格**：`resolveModel` 只有**一個** selection 入口（`provider-runtime/src/index.ts:137`），角色與 session 都從那裡進去 —— 子代理有自己宣告的模型時，`child.ts` 用角色的選擇填它；沒宣告時，子代理**繼承父已經建好的 client 物件**，session 的協議就自動跟著。**仍是 spec §2 要求的「一個地方、一個答案」**，只是那兩層在實作上是同一個插槽，由「誰填它」區分。**這一點複核時要看清楚：它不是把兩層合併，是它們本來就同一條路。**

---

### Task 1: 路由的協議可以缺席，而缺席是一條**錯誤**

這是階段 A 的核心，也是**唯一會改變既有行為**的一步：一條手寫的、沒有 `protocol` 的舊設定，會從「默默用 `openai-completions`」變成「**拒絕，並告訴你怎麼修**」。

**Files:**
- Modify: `packages/settings/src/sections.ts:115-116, 176-199`
- Modify: `packages/provider-runtime/src/index.ts:76, 155, 645-655, 694-725, 516-641`
- Test: `packages/settings/test/sections.test.ts`
- Test: `packages/provider-runtime/test/runtime.test.ts`

**Interfaces:**
- Consumes: 今天的 `resolveProviderProtocol(route, user?)`（`sections.ts:192`）
- Produces: `resolveProviderProtocol(route, user?): SettingsProviderProtocol | undefined` —— 呼叫者現在**必須處理缺席**。`ProviderView.protocol` 與 `ProviderRuntimeEntry.protocol` 同型別。

- [ ] **Step 1: 先量爆炸半徑（在任何修改之前）**

```bash
grep -rn "resolveProviderProtocol\|DEFAULT_PROVIDER_PROTOCOL" packages/ apps/ --include=*.ts
grep -rn "protocol" packages/provider-runtime/test/runtime.test.ts | head -30
```

把「有幾個測試建了一條沒有 `protocol` 的路由」記下來。**這個數字要寫進報告** —— 任務結束時測試的增減要對得上它。

- [ ] **Step 2: 寫失敗的測試（settings 側）**

`packages/settings/test/sections.test.ts`：

```ts
it("a route with no declared protocol resolves to undefined, not to a default", () => {
  // The tail this removes: a route nobody declared a protocol for used to
  // resolve to "openai-completions" SILENTLY. Absence is now absence.
  expect(resolveProviderProtocol("gateway")).toBeUndefined()
})

it("a declared protocol still wins, and an invalid one is still invalid", () => {
  expect(resolveProviderProtocol("gateway", { protocol: "anthropic-messages" })).toBe("anthropic-messages")
  // Read-tolerant: a raw caller's garbage falls through to absence, not to a guess.
  expect(resolveProviderProtocol("gateway", { protocol: "nope" as never })).toBeUndefined()
})
```

- [ ] **Step 3: 跑它，確認它紅**

Run: `cd packages/settings && npx vitest run test/sections.test.ts`
Expected: FAIL —— `expected 'openai-completions' to be undefined`

- [ ] **Step 4: 移除尾巴（settings 側）**

`packages/settings/src/sections.ts`：刪掉 `DEFAULT_PROVIDER_PROTOCOL`（:115-116），把 `resolveProviderProtocol` 改成：

```ts
/**
 * Provider protocol resolution chain: user section value > seeded default.
 * NOTHING is invented after those two: absence is absence, and the caller
 * turns it into a refusal. The tail that used to sit here
 * (`?? DEFAULT_PROVIDER_PROTOCOL`, always "openai-completions") was the
 * silent default D1's line of work exists to remove — it is what let a
 * mis-declared route send a user's key to an endpoint that never spoke its
 * wire format. Design: protocol-selection §2.
 */
export function resolveProviderProtocol(
  route: string,
  user?: SettingsProviderConfig,
): SettingsProviderProtocol | undefined {
  const raw = user?.protocol
  if (raw !== undefined && (PROVIDER_PROTOCOLS as readonly string[]).includes(raw)) return raw
  return SEEDED_PROTOCOLS[route]
}
```

**`SEEDED_PROTOCOLS` 留著**（spec §2）：它是「內建路由自己知道協議」的位置，只是它**不再是預設** —— 它是一個寫死的宣告，而今天它是空的。它的註解要跟著改（現在的註解說「ANY route without an explicit user protocol resolves to DEFAULT_PROVIDER_PROTOCOL」，那句話從此是假的）。

- [ ] **Step 5: 跑它，確認它綠**

Run: `cd packages/settings && npx vitest run test/sections.test.ts`
Expected: PASS

- [ ] **Step 6: 寫失敗的測試（runtime 側 —— 這一條是頭號突變目標）**

`packages/provider-runtime/test/runtime.test.ts`，加進 `describe("model resolution")`：

```ts
it("a route that declares no protocol is INVALID, and the reason names the repair", async () => {
  // The mutation this guards: put the tail back (`?? "openai-completions"`) and
  // this must go RED. Silence here is the original bug.
  const { runtime } = await fixture({
    providers: { gateway: { baseURL: "https://gateway.example", apiKeyEnv: "GATEWAY_API_KEY", models: [{ id: "m" }] } },
    credentials: { GATEWAY_API_KEY: "k" },
  })

  await expect(
    runtime.resolveModel({ sessionSelection: { provider: "gateway", model: "m" } }),
  ).resolves.toEqual({
    status: "invalid",
    reason: expect.stringContaining("gateway"),
    providerId: "gateway",
    modelId: "m",
  })

  const state = await runtime.resolveModel({ sessionSelection: { provider: "gateway", model: "m" } })
  // Actionable, not merely true: the message names the EXACT verb that fixes it.
  expect(state.status === "invalid" && state.reason).toContain("i-harness provider set gateway --protocol")
})

it("the route's protocol still wins when it declares one, and the selection still beats the row", async () => {
  const { runtime } = await fixture({
    providers: {
      gateway: {
        baseURL: "https://gateway.example",
        apiKeyEnv: "GATEWAY_API_KEY",
        protocol: "anthropic-messages",
        models: [{ id: "m", protocol: "gemini" }],
      },
    },
    credentials: { GATEWAY_API_KEY: "k" },
  })

  // The row beats the route…
  await expect(runtime.resolveModel({ sessionSelection: { provider: "gateway", model: "m" } }))
    .resolves.toMatchObject({ status: "ready" })
  // …and the selection beats the row.
  await expect(runtime.resolveModel({ sessionSelection: { provider: "gateway", model: "m", protocol: "bedrock" } }))
    .resolves.toMatchObject({ status: "ready" })
})
```

**注意**：`fixture()` 的 `credentials` 形狀照 `readyFixture()` 的既有用法填 —— 它是同一支檔案裡已存在的 helper，照抄它怎麼把金鑰接上 `apiKeyEnv`。

- [ ] **Step 7: 跑它，確認它紅**

Run: `cd packages/provider-runtime && npx vitest run test/runtime.test.ts`
Expected: FAIL —— 第一條拿到 `status: "ready"`（尾巴讓它活下來了）；第二條可能已經綠，**那也是結果**：它證明的是「既有兩層沒有被這一次改動打壞」。

- [ ] **Step 8: 讓缺席往上傳（runtime 側）**

`packages/provider-runtime/src/index.ts`：

1. `ProviderView.protocol`（:155）→ `protocol?: SettingsProviderProtocol`
2. `ProviderRuntimeEntry.protocol`（:76）→ `protocol?: SettingsProviderProtocol`
3. `providerView()`（:650-651）—— 尾巴那一臂現在誠實地回 `undefined`：
```ts
  const protocol = user?.protocol ?? templateSettingsProtocol(template)
    ?? resolveProviderProtocol(id, user)
```
（這一行**不變**，變的是 `resolveProviderProtocol` 的回傳型別。改的是它的註解：不再說「falls through to the default」。）
4. `runtimeProfile()`（:694）—— 簽名改成回 `ProviderProfile | undefined`，`undefined` 代表**這條鏈上一個協議都沒有**：
```ts
function runtimeProfile(
  view: ProviderView,
  apiKey: string | undefined,
  modelModalities?: SettingsInputModality[],
  selectionProtocol?: SettingsProviderProtocol,
): ProviderProfile | undefined {
  // SELECTION-or-row, computed by the caller: a session's/role's selection
  // beats the model row, and both beat the route's default. NOBODY INVENTS
  // ONE — an absent protocol is the caller's refusal to write (protocol-
  // selection §2), because this is the one place that can tell "absent"
  // from "declared".
  const protocol = selectionProtocol ?? view.protocol
  if (protocol === undefined) return undefined
  ...
  return {
    ...template,
    ...
    protocol: adapterProtocol(protocol),
    ...
  }
}
```
5. `resolveModel()`（:607-609）—— 把 `undefined` 翻成那個可行動的 `invalid`：
```ts
      const profile = runtimeProfile(
        view, apiKey, userModel?.inputModalities, selection.protocol ?? userModel?.protocol,
      )
      if (profile === undefined) {
        // The chain ran out. Name the ROUTE (not the model): the protocol is
        // the route's declaration, and `provider set` is the verb that owns it.
        return invalidState(
          `provider "${providerId}" declares no protocol, so "${modelId}" cannot be sent; set one with: i-harness provider set ${providerId} --protocol P`,
          providerId,
          modelId,
        )
      }
```
（`invalidState` 已經在這支檔案裡。訊息**不列舉**那五個 —— `provider set` 自己會列，而 spec §2 的範例用的就是 `P`。**不要**為此新增 `PROVIDER_PROTOCOLS` 的 import：provider-runtime 現在沒有它。）

- [ ] **Step 9: 跑它，確認它綠**

Run: `cd packages/provider-runtime && npx vitest run test/runtime.test.ts`
Expected: PASS

- [ ] **Step 10: 突變證明（**不可跳過**）**

把 `resolveProviderProtocol` 的 `return SEEDED_PROTOCOLS[route]` 暫時改成 `return SEEDED_PROTOCOLS[route] ?? "openai-completions"`，重跑 Step 7 那條測試。
Expected: **RED**。把觀察到的失敗訊息原文貼進報告，然後**改回來**。

> 這一步是這個任務唯一能證明「測試真的在測那條尾巴」的方法。**上一次同一條計畫裡有一個測試在語義上紅之前就綠了**，原因是被斷言的數字剛好重複。

- [ ] **Step 11: 跑全套，處理既有測試**

Run: `pnpm -r --no-bail test`
Expected: **會有一些測試紅** —— 那些是「建了一條沒有協議的路由，然後期待解析成功」的測試。對每一條套用同一條規則：

| 情況 | 處置 |
|---|---|
| 測試在斷言**那條尾巴**（沒宣告協議也能解析） | **改測試**：給那條路由宣告一個協議。它測的是別的東西，協議只是順帶的佈景。 |
| 測試在斷言**真的該壞**的東西，而它現在壞了 | **改程式**：這是回歸。 |

**不確定就停下來問** —— 這一條是「範圍蔓延 vs 真回歸」的分界線，猜錯的代價是一輪修正。

- [ ] **Step 12: 全套綠 + gate**

```bash
pnpm -r --no-bail test
pnpm typecheck
node scripts/audit/check-reachability.mjs --gate
```
Expected: 全綠 · 0 error · `gate PASS -- no new rows`

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "fix(provider-runtime,settings): no protocol is a refusal, not an openai-completions default"
```

---

### Task 2: 一條 session 的選擇帶著協議，而且活過 header

**這一題是加法的**：今天就沒有任何 session 帶協議，所以加上去**不改變任何既有行為**。

**Files:**
- Modify: `packages/session-persistence/src/index.ts:36-43`
- Modify: `packages/session-persistence/package.json`
- Modify: `packages/session-persistence-jsonl/src/format.ts:12-25`
- Modify: `packages/sdk/src/protocol.ts:285-292`
- Test: `packages/session-persistence-jsonl/test/meta.test.ts`

**Interfaces:**
- Consumes: `SettingsProviderProtocol`（`@i-harness/settings`）、`PROVIDER_PROTOCOLS`
- Produces: `SessionModelSelection { provider: string; model: string; protocol?: SettingsProviderProtocol; reasoningEffort?: string }`。`resolveModel` **已經**接受這個形狀（`provider-runtime/src/index.ts:137`），`apps/cli/src/run.ts:382` 與 `apps/cli/src/index.ts:89` **已經**把 `meta.modelSelection` 原樣餵進去 —— **所以這一題不需要動 CLI 的任何一行。**

- [ ] **Step 1: 先確認那條路真的通（讀，不是改）**

```bash
sed -n '136,139p' packages/provider-runtime/src/index.ts   # the sessionSelection input type
sed -n '380,390p' apps/cli/src/run.ts                      # meta.modelSelection → resolveModel
sed -n '86,98p' apps/cli/src/index.ts                      # providerModelBindingFor
```
**它們都不需要改。** 報告裡要寫下這件事 —— 這題是「把型別與 parser 補上」，不是「把線接上」。

- [ ] **Step 2: 寫失敗的測試**

`packages/session-persistence-jsonl/test/meta.test.ts`：

```ts
it("a header carrying a protocol keeps it through parse, and drops a bad one", () => {
  // The repair/read path rewrites the header line. A field the parser does
  // not know is a field the rewrite SILENTLY DELETES — the session would come
  // back resolving on a different wire than the one it was told to use.
  const meta = parseHeader(JSON.stringify({
    formatVersion: 1, sessionId: "s1",
    modelSelection: { provider: "gateway", model: "m", protocol: "anthropic-messages", reasoningEffort: "high" },
  }))
  expect(meta.modelSelection).toEqual({
    provider: "gateway", model: "m", protocol: "anthropic-messages", reasoningEffort: "high",
  })

  // Structurally invalid is DROPPED, not passed through — the same rule the
  // rest of this parser already applies to provider/model.
  const bad = parseHeader(JSON.stringify({
    formatVersion: 1, sessionId: "s1",
    modelSelection: { provider: "gateway", model: "m", protocol: "not-a-protocol" },
  }))
  expect(bad.modelSelection).toEqual({ provider: "gateway", model: "m" })
})
```

- [ ] **Step 3: 跑它，確認它紅**

Run: `cd packages/session-persistence-jsonl && npx vitest run test/meta.test.ts`
Expected: FAIL —— 第一個 `expect` 收到 `{ provider, model, reasoningEffort }`，**`protocol` 不見了**。

- [ ] **Step 4: 補型別與 parser**

`packages/session-persistence/package.json` —— `dependencies` 加 `"@i-harness/settings": "workspace:*"`（**先確認沒有環**：`settings` 的 deps 是 `telemetry` + `harness-home`，兩者都不依賴 session-persistence，所以這條邊是無環的）。

`packages/session-persistence/src/index.ts`：
```ts
// Type-only, following session-executor's precedent: the protocol is the SAME
// closed set settings validates — a copy of the five names here would be
// another place to edit one enum. Erased at build time.
import type { SettingsProviderProtocol } from "@i-harness/settings"

/** C5: one per-session model selection. */
export interface SessionModelSelection {
  /** Provider route ("deepseek" | "anthropic" | a custom route). */
  provider: string
  /** Model id within the provider's registry/catalog. */
  model: string
  /** The wire this session's selection was made on, when it named one.
   * ABSENT is not "the default" — it hands the decision to the chain
   * (model row > route > refusal). Design: protocol-selection §2, §4.2. */
  protocol?: SettingsProviderProtocol
  /** Optional reasoning-effort hint (forward-compatible passthrough). */
  reasoningEffort?: string
}
```

`packages/session-persistence-jsonl/src/format.ts` —— `parseModelSelection` 加一臂，**與 provider/model 同一條規則**：
```ts
  return {
    provider: rec.provider,
    model: rec.model,
    ...(typeof rec.protocol === "string" && (PROVIDER_PROTOCOLS as readonly string[]).includes(rec.protocol)
      ? { protocol: rec.protocol as SettingsProviderProtocol }
      : {}),
    ...(typeof rec.reasoningEffort === "string" && rec.reasoningEffort !== ""
      ? { reasoningEffort: rec.reasoningEffort }
      : {}),
  }
```
把 `PROVIDER_PROTOCOLS` 與型別從 `@i-harness/settings` import 進來。**`session-persistence-jsonl` 目前沒有這條 dep（已實測：它只依賴 `core-session` 與 `session-persistence`）—— 所以 `package.json` 一定要加，這不是條件句。**

`packages/sdk/src/protocol.ts`（:287）—— 那句註解自己說它「Kept structurally identical to the durable SessionMeta field」，所以欄位**必須**跟著動，否則 SDK 的呼叫者取不到它。

**但型別要鬆，不是緊的**：這支檔案開頭寫死了一條不變式 —— *"This module is pure framing — no I/O. **Zero dependencies.** … this file IS the sdk wire contract. Any change to the shapes here is a breaking protocol change for embedders."* **不要**為此把 `@i-harness/settings` 拉進 sdk（它現在沒有，實測過）。

```ts
export interface SessionModelSelection {
  provider: string
  model: string
  /** The wire this selection was made on, when it named one. A STRING, not
   * settings' closed set: this file is the zero-dependency wire contract, and
   * the closed set is already enforced where a raw value actually enters —
   * session-persistence-jsonl's parser drops anything outside the five. Same
   * rule as `reasoningEffort` directly below: loose on the wire, validated at
   * the boundary. */
  protocol?: string
  reasoningEffort?: string
}
```

**兩個型別都在場，必須保持可賦值**：`packages/sdk/src/{client,server}.ts` 用的是 sdk 自己的這一份（`from "./protocol.ts"`），而 `apps/cli/src/index.ts:562` 用的是 `@i-harness/session-persistence` 那一份。因為 `SettingsProviderProtocol` 是 `string` 的子型別，**durable → wire 的方向是可賦值的** —— 那正是「structurally identical without coupling」的意思。**反向不行，也不需要。**

- [ ] **Step 5: 跑它，確認它綠**

Run: `cd packages/session-persistence-jsonl && npx vitest run test/meta.test.ts`
Expected: PASS

- [ ] **Step 6: 突變證明**

把 `parseModelSelection` 裡 `protocol` 那一臂**刪掉**，重跑 Step 3。
Expected: **RED**。改回來，把觀察到的訊息貼進報告。

- [ ] **Step 7: 全套 + gate + commit**

```bash
pnpm -r --no-bail test && pnpm typecheck && node scripts/audit/check-reachability.mjs --gate
git add -A
git commit -m "feat(session-persistence,sdk): a session's selection may name the wire it was made on"
```

---

### Task 3: `provider list` 說得出「這條路由不能用」

今天它印 `[${row.protocol}]`（`apps/cli/src/provider.ts:169`）—— 而Task 1 之後，一條沒宣告協議的路由會印出 `[undefined]`。**一句看起來像協議的謊，比一句缺席更糟。**

**Files:**
- Modify: `apps/cli/src/provider.ts`（`renderList`，約 :160-190）
- Test: `apps/cli/test/provider-command.test.ts`

**Interfaces:**
- Consumes: `ProviderRuntimeEntry.protocol?: SettingsProviderProtocol`（Task 1）
- Produces: 沒有新 export。

- [ ] **Step 1: 寫失敗的測試**

`apps/cli/test/provider-command.test.ts`：

`renderProviderList` **已經被 export**，而同檔既有的 `describe("renderProviderList")`（約 :234）就是**直接餵行物件字面量**。照那個形狀寫，不要新造 harness：

```ts
// Appended to the existing describe("renderProviderList") block.
const noProvenance = { generatedAt: "2026-09-19", families: [] }

it("marks a route with no declared protocol as unusable — not as a wire nobody declared", () => {
  // Today this row prints [openai-completions], a wire NOBODY declared; after
  // the tail is removed it would print [undefined]. Both are lies. The listing
  // says it cannot be used, and names the verb that fixes it.
  const out = renderProviderList(
    [{
      id: "gateway", displayName: "Gateway", configured: true,
      auth: { configured: true, writable: true }, models: [{ id: "m" }],
      discovery: "available", cardFamily: "gateway",
    }],
    noProvenance,
  )

  expect(out).toContain("gateway")
  expect(out).not.toContain("openai-completions")
  expect(out).toContain("no protocol")
  expect(out).toContain("i-harness provider set gateway --protocol")
})

it("a route that DOES declare one still prints it, unchanged", () => {
  const out = renderProviderList(
    [{
      id: "gateway", displayName: "Gateway", protocol: "gemini", configured: true,
      auth: { configured: true, writable: true }, models: [{ id: "m" }],
      discovery: "available", cardFamily: "gateway",
    }],
    noProvenance,
  )

  expect(out).toContain("[gemini]")
})
```

**注意第一條的物件字面量沒有 `protocol` 欄位** —— 那只有在 Task 1 把型別改成可選之後才編得過。**這是 Task 3 依賴 Task 1 的地方**，不是巧合。

- [ ] **Step 2: 跑它，確認它紅**

Run: `cd apps/cli && npx vitest run test/provider-command.test.ts`
Expected: FAIL —— 第一個 case 收到 `[openai-completions]`（尾巴還在）或 `[undefined]`（Task 1 之後）。

- [ ] **Step 3: 讓那一行誠實**

`apps/cli/src/provider.ts` 的 `renderList`：
```ts
    // A route with no declared protocol is NOT a route with a default one: it
    // is a route that cannot be sent to. The listing says so, and names the
    // verb that fixes it — `[undefined]` would be a rendering accident, and
    // `[openai-completions]` would be a wire nobody declared.
    lines.push(
      row.protocol === undefined
        ? `  ${row.id}  [no protocol — cannot be used; set one with: i-harness provider set ${row.id} --protocol P]`
        : `  ${row.id}  [${row.protocol}]${row.configured ? "" : "  (not configured)"}`,
    )
```

- [ ] **Step 4: 跑它，確認它綠**

Run: `cd apps/cli && npx vitest run test/provider-command.test.ts`
Expected: PASS

- [ ] **Step 5: 全套 + gate + commit**

```bash
pnpm -r --no-bail test && pnpm typecheck && node scripts/audit/check-reachability.mjs --gate
git add -A
git commit -m "feat(cli): provider list names a route that declares no protocol"
```

---

## 完成之後

**這條分支要留給工作電腦複核**（與 `d4-endpoint-cache` 同一條規矩）：**不合併、不改名、不刪**。

**階段 A 不包含**（spec §10）：session 的協議**持久化**（那個欄位存在，但沒有介面寫它）、rebind 機制、`run --protocol`、`setSessionModel` 當場生效、`core-agent` 的 model getter。**那些是階段 B。**
