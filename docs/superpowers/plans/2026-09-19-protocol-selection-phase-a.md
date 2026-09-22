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
  // 複審追加：`toContain("… --protocol")` 在尾巴退化時仍然會過。契約的另一半
  // ——「列出集合」—— 要用集合本身釘，否則那半沒有守。
  expect(state.status === "invalid" && state.reason).toContain(`<one of: ${PROVIDER_PROTOCOLS.join(" | ")}>`)
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
          `provider "${providerId}" declares no protocol, so "${modelId}" cannot be sent; set one with: i-harness provider set ${providerId} --protocol ${PROTOCOL_CHOICES}`,
          providerId,
          modelId,
        )
      }
```
（`invalidState` 已經在這支檔案裡。`PROTOCOL_CHOICES` 是模組私有的 `\`<one of: ${PROVIDER_PROTOCOLS.join(" | ")}>\`` —— **不是 export**，所以不佔 gate 的 row；`PROVIDER_PROTOCOLS` 從既有的 `@i-harness/settings` import 那一行加進去。**不要寫成 `--protocol P`**：那個字面照抄會得到 `unknown protocol "P"`，在修好之前先撞第二個錯。spec §2 的範例用的是 `P`，但本 repo 已經裁定過這件事（`5d0f2d89`）。）

6. **`view.protocol` 有六個讀者，不是兩個 —— 逐個處置（實測清單，不要漏）**

`grep -n "view\.protocol" packages/provider-runtime/src/index.ts` 會給你這六行。**每一個都要有一個處置**：

| 行 | 讀者 | 處置 |
|---|---|---|
| :232 | `probeModels` 的 bedrock 檢查 | **不動** —— `undefined !== "bedrock"`，閘門不觸發。未知的協議**不是** bedrock 的證據。 |
| :255 | `probeModels` → `registry.probeModels({ protocol: probeOptions.protocol ?? view.protocol })` | **要改 —— 這是第二條尾巴，見下面 item 7** |
| :296 | `directory()` 的行 | **改成可缺席**（Type `ProviderRuntimeEntry.protocol` 已在 item 2 改了） |
| :301 | `discovery: view.protocol === "bedrock" ? "manual-only" : "available"` | **不動**。這個欄位回答的是「這條路由有沒有發現端點」（bedrock 沒有），而**未知的協議不是「沒有」的證據**；`models probe --protocol P` 那條覆寫路仍存在。**代價**：一條沒有協議的路由在列表上仍寫 `available`，而它會拒絕 —— 由 Task 3 那一行「no protocol of its own」抵銷。**（注意 Task 3 的複審把原本的措辭「cannot be used」判為 Important：那條路由**可以**用，只要模型行或選擇帶了協議 —— 所以那句話是這個單元要消滅的說謊方式。措辭已改成只陳述**路由自己**的事實。）** |
| :587 | 認證路徑的 bedrock/ambient 判斷 | **不動** —— 非 bedrock 的路由本來就通過這個閘門，`undefined` 不改變結果。 |
| :717 / :729 | `runtimeProfile` / `authRef` | :717 由 item 4 涵蓋；:729 **不動**（從來不可能是 bedrock）。 |

7. **第二條尾巴：探測路徑（`provider/src/index.ts:348-350`）**

那支檔案的註解自己寫著：*"…and passes it here; this module only applies the generic terminal fallback (**openai-completions = Bearer**)"*。**探測有自己的硬編碼尾巴。**

把它也拿掉 —— spec §1/§2 的理由（**不猜**、**早一步失敗**）在這條路上逐字成立，而且留著會造出更糟的狀態：**一條永遠送不出去的路由，探測卻會成功，還把結果寫進設定。**

`probeModels`（provider-runtime），在 `registry.probeModels(...)` **之前**：

```ts
    // The SECOND tail (provider/src/index.ts:348-350 had its own
    // openai-completions/Bearer fallback). A probe must speak a wire it knows:
    // letting discovery succeed on a route that can never be sent to writes
    // rows onto a route that refuses, which is worse than either alternative.
    // `--protocol P` is the escape for a gateway serving another vendor's
    // models, and it is unchanged.
    const probeProtocol = probeOptions.protocol ?? view.protocol
    if (probeProtocol === undefined) {
      throw new Error(
        `provider "${id}" declares no protocol, so its models cannot be discovered; set one with: i-harness provider set ${id} --protocol ${PROTOCOL_CHOICES}`,
      )
    }
```
然後把 :255 改成 `protocol: probeProtocol,`。

**這一步超出計畫原本的文字，但不超出 spec 的原則。** 理由與代價記在 ledger 的 ruling 裡。

- [ ] **Step 8b: 探測尾巴的測試（紅 → 綠）**

`packages/provider-runtime/test/runtime.test.ts`：
```ts
it("refuses to probe a route that declares no protocol, and names the fix", async () => {
  const { runtime } = await fixture({
    providers: { gateway: { baseURL: "https://gateway.example", apiKeyEnv: "GATEWAY_API_KEY", models: [] } },
    credentials: { GATEWAY_API_KEY: "k" },
  })

  await expect(runtime.probeModels("gateway")).rejects.toThrow(/declares no protocol/)
  await expect(runtime.probeModels("gateway")).rejects.toThrow(/i-harness provider set gateway --protocol/)
  // 同上：集合那一半要用集合本身釘。（`PROVIDER_PROTOCOLS` 若這支測試檔還沒
  // import，從 `@i-harness/settings` 加進來 —— 不要自己重寫那五個名字。）
  await expect(runtime.probeModels("gateway")).rejects.toThrow(
    new RegExp(`<one of: ${PROVIDER_PROTOCOLS.join(" \\| ")}>`),
  )
})

it("still probes when the caller names a protocol explicitly — the escape hatch", async () => {
  // The override is what makes the refusal above safe: a gateway serving
  // another vendor's models is exactly what `--protocol` is for.
  const { runtime, registry } = await fixture({
    providers: { gateway: { baseURL: "https://gateway.example", apiKeyEnv: "GATEWAY_API_KEY", models: [] } },
    credentials: { GATEWAY_API_KEY: "k" },
    registry: (r) => { r.registerProbe("gateway", async () => [{ id: "m" }]) },
  })

  await expect(runtime.probeModels("gateway", { protocol: "anthropic-messages" })).resolves.toEqual([{ id: "m" }])
})
```
（`registerProbe` 的實際註冊方式照這支測試檔既有 case 的用法 —— 上面的 `registry` 回呼形狀要對齊 `FixtureOptions.registry`。）

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
- **NOT** `packages/sdk/src/protocol.ts` —— 見下面的裁定
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

### ⚠ 裁定（實作後追加，覆寫本步驟原本的文字）—— **SDK 的 wire 型別不動**

原本這裡寫「欄位**必須**跟著動」。**那是錯的，已回退。**

**理由（spec 自己的話，使用者決定）：** §4.3 —— *「session 的協議**不寫進任何檔案**（使用者決定）」*；§7 再列一次 *「session 的協議持久化：**不做**」*。而 `setSessionModel` 呼叫的是 `coordinator.updateMeta(...)` —— **那就是寫檔案**。

**實際發生的事**：實作者照原文加了 wire 欄位，然後自己舉手 —— `packages/sdk/src/server.ts:715` 有**它自己的**白名單 parser，不認得 `protocol`。於是 **wire 宣告了一個 server 會靜默丟掉的欄位**：嵌入者送出去、收到成功、東西不見了。

**裁定：把謊從源頭收掉，不是把機制加上去。**

| 表面 | 處置 |
|---|---|
| durable 型別（`session-persistence`） | **留** —— spec §10 明列；它讓「發起時組進去」在記憶體裡有地方放 |
| jsonl parser + 兩個測試 | **留** —— 重寫 header **不得刪掉不認得的欄位**（與 `provider`/`model`/`reasoningEffort` 同一條規則）；而且 `updateMeta` 是公開 API，手寫或外來的 header 今天就可能帶著它 |
| **sdk wire 型別** | **不動** —— 加了就是把「宣告了卻被丟掉」引進 wire 契約 |
| **`apps/cli/src/index.ts` 的 relay** | **不動** —— 它存在的唯一理由隨 wire 型別消失 |
| `packages/sdk/src/server.ts:715` | **parser 不動，但已補註解**說明「不接」是刻意的，並指向 §4.3/§7 |

**代價：phase B 把它加回 wire 型別 —— 一行**，而且會跟「接受它的 parser」同一個提交落地。**不選的做法**要 phase A 違反 §4.3，去服務一個現在沒人要求的欄位。

**這個裁定的反命令必須在版控裡**（複審抓到它原本只活在 gitignored 的 ledger、commit 訊息和程式碼註解裡，而計畫還在教舊做法）。

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
git commit -m "feat(session-persistence,sdk,cli): a session's selection may name the wire it was made on"
```

---

### Task 3: 兩個列表都說得出「這條路由不能用」

今天它們印 `[${row.protocol}]` —— 而 Task 1 之後，一條沒宣告協議的路由會印出 `[undefined]`。**一句看起來像協議的謊，比一句缺席更糟。**

**有兩個列表，同一個缺陷類別**（Task 1 的實作者回報、控制者實測確認）：

| 列表 | 行 | 現況 |
|---|---|---|
| `i-harness provider list` | `apps/cli/src/provider.ts:169` | `[${row.protocol}]` |
| `i-harness models list` | `apps/cli/src/models.ts:247` | `` `${route.id}  [${route.protocol}]  discovery: …` `` —— 型別（`ModelsRouteView.protocol`）在 Task 1 已被改成可選，所以它現在會印 `[undefined]` |

**只修一個等於把使用者從一個列表推到另一個列表。** 兩個都修。

**Files:**
- Modify: `apps/cli/src/provider.ts`（`renderProviderList`，約 :160-190）
- Modify: `apps/cli/src/models.ts`（`renderModels`，約 :242-248）
- Test: `apps/cli/test/provider-command.test.ts`
- Test: `apps/cli/test/models-command.test.ts`

**Interfaces:**
- Consumes: `ProviderRuntimeEntry.protocol?: SettingsProviderProtocol`（Task 1）；`ModelsRouteView.protocol?: string`（Task 1 的型別 knock-on）
- Produces: 沒有新 export。

- [ ] **Step 1: 寫失敗的測試**

`apps/cli/test/provider-command.test.ts`：

`renderProviderList` **已經被 export**，而同檔既有的 `describe("renderProviderList")`（約 :234）就是**直接餵行物件字面量**。照那個形狀寫，不要新造 harness：

```ts
// Appended to the existing describe("renderProviderList") block.
const noProvenance = { generatedAt: "2026-09-19", families: [] }

it("marks a route with no protocol OF ITS OWN — not as a wire nobody declared", () => {
  // Today this row prints [openai-completions], a wire NOBODY declared; after
  // the tail is removed it would print [undefined]. Both are lies. The listing
  // now says what is true of the ROUTE — it declares no protocol — and names
  // the verb that fixes it.
  //
  // It must NOT say "cannot be used": the chain is selection > model row >
  // route (provider-runtime:632 feeds :741), so a protocol-less route IS usable
  // whenever a row or a selection names one. Measured: a row carrying
  // `protocol: "gemini"` makes resolveModel return `ready` on exactly the route
  // this row describes — the listing would have contradicted its own next line.
  const out = renderProviderList(
    [{
      id: "gateway", displayName: "Gateway", configured: true,
      auth: { configured: true, writable: true }, models: [{ id: "m" }],
      discovery: "available", cardFamily: "gateway",
    }],
    noProvenance,
  )

  expect(out).toContain("gateway")
  // ⚠ 這一條原本寫 `expect(out).not.toContain("openai-completions")` —— **它不可能通過**，
  // 因為修法要**列出整個集合**（一個字面被貼上會失敗的佔位符是前一個裁定的對象），
  // 而集合的第一個成員**就是** `openai-completions`。那個斷言會禁止這個修正
  // 必須印出的那串尾巴。要釘的是「**路由自己的括號裡不能是一個協議**」：
  expect(out).not.toContain("gateway  [openai-completions]")
  expect(out).not.toContain("gateway  [undefined]")
  expect(out).toContain("gateway  [no protocol of its own")
  // ⚠ 這兩條是複審要求的：契約有兩半 ——「拿掉判決」與「列出集合」。
  // `toContain("no protocol")` 是**子字串**，句子一改它就不再守任何東西；
  // 而 `toContain("i-harness provider set gateway --protocol")` 在尾巴退化成
  // **單一協議**時仍然會過。集合那一半要用集合本身釘。
  expect(out).not.toContain("cannot be used")
  expect(out).toContain(`<one of: ${PROVIDER_PROTOCOLS.join(" | ")}>`)
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

`apps/cli/src/provider.ts` 的 `renderProviderList`：
```ts
    // A route with no declared protocol is NOT a route with a default one — but
    // it is also NOT a route that cannot be sent to. The chain is selection >
    // model row > route, so such a route IS usable whenever a row or a
    // selection names a protocol; claiming otherwise is the same lie this unit
    // exists to kill, one level down. The line states the fact about the ROUTE
    // (it declares none) and names the verb that fixes it — `[undefined]` would
    // be a rendering accident, and `[openai-completions]` a wire nobody
    // declared. The repair names the SET, not a placeholder — `--protocol P`
    // copied verbatim fails with `unknown protocol "P"`, a second error before
    // the fix (this repo already ruled on that: 5d0f2d89).
    lines.push(
      row.protocol === undefined
        ? `  ${row.id}  [no protocol of its own — set one with: i-harness provider set ${row.id} --protocol <one of: ${PROVIDER_PROTOCOLS.join(" | ")}>]`
        : `  ${row.id}  [${row.protocol}]${row.configured ? "" : "  (not configured)"}`,
    )
```

- [ ] **Step 3b: `models list` 那一行（同一個缺陷，第二個檔）**

`apps/cli/test/models-command.test.ts`，加進既有的 `describe("renderModels")`（約 :94）：

```ts
it("marks a route with no protocol of its own, the same as provider list", () => {
  // Task 1 made ModelsRouteView.protocol optional, so this line renders
  // [undefined]. Its sibling in provider.ts gets the same treatment — fixing
  // one listing and not the other just moves the user to the other command.
  const out = renderModels([
    {
      id: "gw", cardFamily: "gw", declared: false, discovery: "available",
      models: [{ id: "m", card: undefined, aliases: [] }],
    },
  ])

  expect(out).toContain("gw")
  expect(out).not.toContain("undefined")
  // EXACT text, not `toContain("no protocol")`: the latter survives as a
  // substring of the longer sentence and stops guarding the moment the
  // sentence changes — measured, not assumed.
  expect(out).toContain("no protocol of its own")
  expect(out).not.toContain("cannot be used")
  // 契約的另一半 ——「列出集合」—— 用集合本身釘，理由同 provider 那邊。
  expect(out).toContain(`<one of: ${PROVIDER_PROTOCOLS.join(" | ")}>`)
})

it("does NOT tell a protocol-less route it is unusable when a ROW supplies the protocol", () => {
  // The guard the review demanded, and the case the original wording failed:
  // the chain is selection > model row > route, so a row carrying a protocol
  // makes the route usable.
  //
  // ⚠ 執行期斷言必須寫在**列表斷言之前**，這不是風格問題：在修復前的原始碼上
  // 它會**先通過**，然後列表斷言才紅 —— 那正是「這次紅測到的是**列表說謊**，
  // 不是執行期壞掉」的證據。用這支測試檔**既有**的 runtime fixture 建一條
  // 沒有協議的路由 + 一個帶 protocol 的模型行，然後：
  await expect(
    runtime.resolveModel({ sessionSelection: { provider: "gw", model: "m" } }),
  ).resolves.toMatchObject({ status: "ready" })

  const out = renderModels([
    {
      id: "gw", cardFamily: "gw", declared: false, discovery: "available",
      models: [{ id: "m", card: undefined, aliases: [], protocol: "gemini" }],
    },
  ])

  expect(out).toContain("protocol: gemini")   // the row line still reports it
  expect(out).not.toContain("cannot be used")
  expect(out).toContain("no protocol of its own")
})

it("a route that DOES declare one still prints it, unchanged", () => {
  const out = renderModels([
    {
      id: "gw", cardFamily: "gw", declared: false, protocol: "gemini", discovery: "available",
      models: [{ id: "m", card: undefined, aliases: [] }],
    },
  ])

  expect(out).toContain("[gemini]")
})
```

跑它確認紅：`cd apps/cli && npx vitest run test/models-command.test.ts`
Expected: FAIL —— `expected '…[undefined]…' not to contain 'undefined'`

`apps/cli/src/models.ts`（`renderModels`，:247）—— 把那一行拆出一個區域變數，**不要複製那串長尾**：
```ts
    const wire = route.protocol === undefined
      ? `no protocol of its own — set one with: i-harness provider set ${route.id} --protocol <one of: ${PROVIDER_PROTOCOLS.join(" | ")}>`
      : route.protocol
    lines.push(`${route.id}  [${wire}]  discovery: ${route.discovery}  card family: ${route.cardFamily} (${route.declared ? "declared" : "the route name"})`)
```
跑它確認綠。

- [ ] **Step 4: 兩個測試檔都綠**

Run: `cd apps/cli && npx vitest run test/provider-command.test.ts test/models-command.test.ts`
Expected: PASS

- [ ] **Step 5: 全套 + gate + commit**

```bash
pnpm -r --no-bail test && pnpm typecheck && node scripts/audit/check-reachability.mjs --gate
git add -A
git commit -m "feat(cli): both listings name a route that declares no protocol"
```

---

## 完成之後

**這條分支要留給工作電腦複核**（與 `d4-endpoint-cache` 同一條規矩）：**不合併、不改名、不刪**。

**階段 A 不包含**（spec §10）：session 的協議**持久化**（那個欄位存在，但沒有介面寫它）、rebind 機制、`run --protocol`、`setSessionModel` 當場生效、`core-agent` 的 model getter。**那些是階段 B。**
