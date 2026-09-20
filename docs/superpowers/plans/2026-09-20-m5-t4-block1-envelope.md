# M5／T4 block ① — 軟失敗信封 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一個被派送的工具呼叫，無論成功或丟出，都在日誌裡留下**恰好一筆** `tool/result` —— 而且 turn 繼續。

**Architecture:** `executeToolCalls` 的失敗路徑停止 `rethrow`，改走中止路徑**已經在跑**的那條（填補格子、讓頭部游標前進、讓落地的兄弟 commit 它們**真的**結果）。**哪些失敗是軟的由三件事結構性地決定**：丟出點（`prepare` ⇒ 大聲）、一個有名標記（cascade 裡的政策否決 ⇒ 大聲）、其餘（cascade 裡的工具本體 ⇒ 軟）。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-20-m5-t4-tool-pipeline-design.md`（**§2 是這一塊的依據；§2.6 是施工期間量到的增補**）。區塊 ②（參數 schema）與 ③（界）另有計畫。

## Global Constraints

- **接縫沒有錯誤旗標，而 v1 不加**（spec §2.5）。`grep -rn "isError\|is_error" packages/llm-*/src` 必須**維持零命中**。
- **中止路徑的 `throw new Error("agent aborted")` 不動**（spec §2）。既有的 **四條** abort 測試（`execute-tool-calls.test.ts` 的 `:261`、`:309`、`:392`、`:434`）必須**一條都不改**。
  > ⚠ 第一版寫「五條」—— **那是量出來的，不是數出來的**（`agent.test.ts` 用的是 `/aborted/i`，那是**不同的字串**）。數字已更正。
- **`prepare` 的政策丟出仍然殺掉整個 turn**（spec §6.1）—— `unknown tool`、`guard denied`、`tools/pre-execute` 的 deny、`denied`、approval fail-closed、guardian denied。
- **cascade 裡的政策否決仍然殺掉整個 turn**（spec §2.6）—— 靠 `PolicyRefusal` 標記，不靠一份清單。
- **合成失敗不跑 `finalize`、不發 `agent/post-tool`**（M10a 的既有裁定，經 `"synthetic" in slot` 那條分支）。
- **不新增 export，除了那三個常數**（`TOOL_FAILED`、`TOOL_CANCELLED_BY_SIBLING`）與 `core-tools` 的 `isPolicyRefusal`／`PolicyRefusal` 型別。
- **⚠ 可達性閘門的 `PASS` 是 T6 的要求，不是每一個任務的要求。** 常數與標記先落地、**由後面的任務在生產檔案裡消費**，所以在區塊中途它的讀數本來就會是 `N NEW rows`（`TOOL_FAILED` 是上一個任務留下的，標記是 T1 的）。**每一個任務要做的是「記下讀數、確認它只增不減」，而 `gate PASS` 在 T6 才被要求。** 第一版把「維持 PASS」寫成每一個任務的約束 —— **那是不可能的，而它錯的方式是要求一件做不到的事。**
- **⚠ 全套閘門是兩步**：`pnpm -r --no-bail test` 在任何套件紅的時候**只跑一個前綴**（T6 Step 3 有量測）。**先數母體（必須 66），再比數字。**
- **行號會腐化。** 每一處引用動手前先 `grep -n` 核對。

---

## 這份計畫為什麼比第一版大（而它是被量測逼大的）

第一版說「4 個任務、改寫 1 條測試」。**兩件都錯，而兩件都是同一個原因：我沒有先量爆炸半徑就把它寫下來。**

| | 第一版說 | 量到 |
|---|---|---|
| **範圍** | 只有 `core-agent` | **5 個套件**（`core-agent`、`hooks`、`sdk`、`session-executor`、`cli`） |
| **測試** | 改寫 1 條 | **9 條轉紅**：**8 條是被推翻契約的既有編碼**（改寫）、**1 條是真的分類缺口**（`pre-tool` 否決，修分類） |
| **分類** | 丟出點就夠 | 丟出點**看不見 cascade 裡的政策否決** —— 需要一個第三件東西：**一個有名標記**（spec §2.6） |

**⇒ 所以任務從 4 個變成 6 個**，而新增的兩個（T1 標記、T3 爆炸半徑）**各自是一個獨立可證的單位**。

## File Structure

| 檔案 | 角色 | 哪個任務動它 |
|---|---|---|
| `packages/core-tools/src/index.ts` | 工具註冊與 **`tools/execute` 這條縫的擁有者** | **T1**（`PolicyRefusal` ＋ `isPolicyRefusal`） |
| `packages/hooks/src/types.ts` | `HookBlockedError` | **T1**（帶上標記） |
| `packages/core-agent/src/execute-tool-calls.ts` | 批次排程器 | **T2**（分類 ＋ 軟路徑）、**T4**（`TOOL_CANCELLED_BY_SIBLING`）、**T5**（try/catch） |
| `packages/core-agent/src/index.ts` | 對外出口 ＋ 呼叫點 | **T2**（re-export）、**T6**（契約註解） |
| `packages/core-agent/test/execute-tool-calls.test.ts` | 這一塊的核心測試 | T2／T4／T5 |
| `packages/core-agent/test/telemetry.test.ts` | 編碼了舊契約 | **T2**（改寫） |
| `packages/sdk/test/server.test.ts` · `packages/session-executor/test/assembly.test.ts` · `apps/cli/test/plugin-mount.test.ts` | 同上 | **T3**（改寫 7 條） |
| `packages/hooks/test/policy-refusal.test.ts` | 新的、極小的單元測試 | **T1** |

**為什麼標記住在 `core-tools`**：依賴方向是 `hooks → core-tools` 與 `core-agent → core-tools`，兩者互不依賴（量過，無環）。**用 `instanceof` 會讓 `core-agent` 依賴 `hooks`，那條依賴不該存在。**

---

### Task 1: `PolicyRefusal` —— 把一個既有的意圖變成可檢查的東西

**Files:**
- Modify: `packages/core-tools/src/index.ts`（加型別與判定函式）
- Modify: `packages/hooks/src/types.ts:121`（`HookBlockedError` 帶上標記）
- Test: `packages/hooks/test/policy-refusal.test.ts`（新檔）

> **⚠ 測試為什麼住在 `hooks` 而不是 `core-agent`**（第一版寫錯了，量測推翻）：`@i-harness/hooks` **不是** `core-agent` 的宣告依賴，所以從那裡 import `HookBlockedError` **解析不到** —— 而加那條依賴是被禁止的。`hooks` 則**同時**構得到兩邊：`@i-harness/core-tools` 是它的宣告依賴（`hooks/package.json`），而 `HookBlockedError` 是它自己的。**所以這個測試的唯一正確住處是 `hooks/test/`。**

**Interfaces:**
- Consumes: `HookBlockedError`（`hooks/src/types.ts:121`，**已經**有 `readonly code = "hook-blocked"`）。
- Produces: `export interface PolicyRefusal { readonly policyRefusal: true }` 與 `export function isPolicyRefusal(err: unknown): err is PolicyRefusal` —— **T2 的 marker 檢查用它**。

**這一條是惰性的** —— 它不改變任何行為。它先落地，**所以 T2 的分類可以在一次編輯裡同時是完整的**（否則 T2 會留下一個已知的紅）。

- [ ] **Step 1: 寫紅測試**

建立 `packages/hooks/test/policy-refusal.test.ts`：

```ts
import { describe, expect, it } from "vitest"
import { isPolicyRefusal } from "@i-harness/core-tools"
import { HookBlockedError } from "../src/types.ts"

// spec §2.6: a POLICY refusal — "you may not do this" — must be
// distinguishable from a tool body that tried and failed. The distinction is
// a NAMED MARKER on the error, not a list of class names: a future in-cascade
// policy opts in by carrying it, and `core-agent` needs no dependency on the
// mechanism that refuses.
describe("isPolicyRefusal", () => {
  it("recognises a hook veto", () => {
    expect(isPolicyRefusal(new HookBlockedError("h1", "read disabled"))).toBe(true)
  })

  it("does NOT claim an ordinary tool-body failure", () => {
    expect(isPolicyRefusal(new Error("disk exploded"))).toBe(false)
  })

  it("is total — a non-error never throws", () => {
    for (const v of [undefined, null, 0, "", "boom", {}, [], () => {}]) {
      expect(() => isPolicyRefusal(v)).not.toThrow()
      expect(isPolicyRefusal(v)).toBe(false)
    }
  })

  it("requires the marker to be TRUE, not merely present", () => {
    // The same rule this branch ruled on before (W4's F1): the decision keys
    // on a field CARRYING a value, not on the key existing.
    expect(isPolicyRefusal({ policyRefusal: undefined })).toBe(false)
    expect(isPolicyRefusal({ policyRefusal: false })).toBe(false)
    expect(isPolicyRefusal({ policyRefusal: true })).toBe(true)
  })
})
```

- [ ] **Step 2: 跑它，確認它紅**

Run: `pnpm --filter @i-harness/hooks exec vitest run test/policy-refusal.test.ts`

Expected: **紅在 import** —— `@i-harness/core-tools` 沒有 `isPolicyRefusal`。**這一條的紅就是「東西還不存在」，那是這一條全部要證明的東西，所以這裡的紅-first 是誠實的**（它不像 T2 那樣需要一個實質的紅）。

- [ ] **Step 3: 在 `core-tools` 加型別與判定**

在 `packages/core-tools/src/index.ts` 的型別區（`ToolDecision` 附近）加：

```ts
// spec §2.6: a POLICY refusal — "you may not do this" — as opposed to a tool
// body that tried and failed. Policy refusals stay LOUD (the turn fails); a
// body failure is soft (the failed call gets a result and the turn continues).
//
// Marked structurally so `core-agent` needs no dependency on the mechanism
// that refuses: `hooks` already sits above this package, and importing it from
// `core-agent` would point the dependency backwards.
//
// THE CONVENTION, and its failure mode: a future in-cascade policy that must
// fail the turn carries this marker. One that forgets has a SOFT refusal —
// which is why the convention is named in the spec, not left as a local
// detail. (Contrast: block ②'s INVALID_ARGS is also typed, but its
// disposition is SOFT — an argument violation is the model's mistake and is
// fixable by the model, a veto is not.)
export interface PolicyRefusal {
  readonly policyRefusal: true
}

/** Total: never throws, and requires the marker to CARRY `true` — a present
 *  but `undefined` field is not a marker (the same rule as W4's F1 fix). */
export function isPolicyRefusal(err: unknown): err is PolicyRefusal {
  return typeof err === "object" && err !== null && (err as { policyRefusal?: unknown }).policyRefusal === true
}
```

**然後確認它在 `core-tools` 的出口上是可匯入的** —— 跟隨該檔既有的 export 風格（`git grep -n "export type { ToolExposure" packages/core-tools/src/index.ts` 看它怎麼 export 型別）。

- [ ] **Step 4: `HookBlockedError` 帶上標記**

`packages/hooks/src/types.ts:121`：

```ts
/** A gate/block veto: tool blocked or phase stopped (reason carried). */
export class HookBlockedError extends Error {
  readonly code = "hook-blocked" as const
  // spec §2.6: this IS a policy refusal — the marker is what keeps a pre-tool
  // veto loud now that a tool body's failure is soft. The `code` above already
  // said so; this makes it checkable from a package that cannot import us.
  readonly policyRefusal = true as const
  constructor(
    readonly handlerId: string,
    message: string,
  ) {
    super(message)
    this.name = "HookBlockedError"
  }
}
```

- [ ] **Step 5: 跑測試 —— 判準是「沒有新的紅」，不是「全綠」**

```bash
pnpm --filter @i-harness/hooks exec vitest run test/policy-refusal.test.ts
pnpm --filter @i-harness/hooks exec vitest run
pnpm --filter @i-harness/core-tools exec vitest run
```

Expected:
- **`policy-refusal.test.ts` → 4 passed / 0 failed**
- **`core-tools` → 全綠**
- **`hooks` → 34 passed / 1 failed（35）。而那 1 條是既有的紅，不是你的** —— `test/hooks.test.ts:358`（*"a pre-tool handler that blocks 'read' fails the agent turn fail-closed"*），**它在這一塊開始之前就紅了**（上一個任務的軟路徑已經落地，而否決的分類在 T2 才修）。

**⇒ 這一條的判準是「條數與測試名與動手前一致」。** **先量基準**：在建立新測試檔**之前**跑一次 `hooks`，記下讀數（**`30 passed / 1 failed`**）與那個測試的名字。**建檔之後的讀數必須恰好是基準 ＋ 4。** 多了任何一條、或名字不同 ⇒ **停手回報**。

> **⚠ `34/1` 這個數字是量到的，不是算出來的。** 第一版把搬移**之後**的預期寫成搬移**之前**的數字（`30/1`）—— 而那個錯的形狀與這一塊前面六個一樣：**寫下一個沒有先確認的數字。**

> **⚠ 第一版寫「兩者全綠」是錯的，而它錯的方式是要求一件做不到的事** —— 否決要等 T2 才會回到大聲。**「加一個唯讀欄位不該動任何既有測試」那個理由成立，但它證明的是「沒有新紅」，不是「全綠」。**

- [ ] **Step 6: 兩個突變 —— 證明第四條的**兩半**各自被釘住**

> **⚠ 第一版只寫了一個突變，而且指錯了哪一條斷言會紅。** 複審實測：把 `=== true` 改成 `!== undefined` 之後，`{ policyRefusal: undefined }` **仍然回 `false`**（`undefined !== undefined` 是 `false`）—— 紅的其實是 `{ policyRefusal: false }` 那一條。**兩個 mutants 要各自配一條斷言，而它們測的是兩件不同的事。**

**突變 A —— `=== true` 改成 `!== undefined`：**

Expected: **紅** —— **`{ policyRefusal: false }`**（第 30 行，`expected true to be false`）。

**突變 B —— 把判定改成「鍵存在」（`"policyRefusal" in err`）：**

Expected: **紅** —— **`{ policyRefusal: undefined }`**（第 29 行）。**這才是「帶著值 vs 鍵存在」那一半的守衛** —— 而它與突變 A 是**兩件事**。

**各還原一次，兩次都跑回綠。**

- [ ] **Step 7: Commit**

```bash
git add packages/core-tools/src/index.ts packages/hooks/src/types.ts packages/hooks/test/policy-refusal.test.ts
git commit -m "feat(core-tools,hooks): M5 T4 block 1 — a policy refusal is marked, so a veto stays loud when a body failure goes soft"
```

---

### Task 2: 軟失敗 ＋ 兩個分類 ＋ `core-agent` 的爆炸半徑

**Files:**
- Modify: `packages/core-agent/src/execute-tool-calls.ts`（常數區、`firstError` 宣告、外層 catch、失敗路徑）
- Modify: `packages/core-agent/src/index.ts`（re-export）
- Test: `packages/core-agent/test/execute-tool-calls.test.ts`（改寫 1 條、新增 1 條）
- Test: `packages/core-agent/test/telemetry.test.ts:97`（**改寫** —— 它編碼了舊契約）

**Interfaces:**
- Consumes: T1 的 `isPolicyRefusal`。
- Produces: `export const TOOL_FAILED = "TOOL_FAILED"`。

> ## ⚠ 這一條是**部分重跑** —— 先讀這一格，否則你會重做已經做過的事
>
> **計畫重寫之前，這個任務的前身已經落地過兩個提交**（`07057c72` ＋ 修正輪 `0a4d5e7f`）。**下面的步驟有一部分在 BASE 上已經是真的。**
>
> | 步驟 | BASE 上的狀態 |
> |---|---|
> | **Step 2**（常數 ＋ re-export） | ✅ **已存在** —— `TOOL_FAILED` 已在 `execute-tool-calls.ts` 的常數區與 `core-agent/src/index.ts` 的 re-export 區塊 |
> | **Step 3**（改寫 `execute-tool-calls` 的契約測試） | ✅ **已改寫** —— 那一條現在叫 `"a failed call yields its OWN result and the turn continues (no rethrow)"` |
> | **Step 5 的站點那一半** | ✅ **已存在** —— `firstRefusal` 變數、外層 catch 的 `firstRefusal ??= err`、以及 `if (firstRefusal !== undefined) { … throw firstRefusal }` 那一塊 |
> | **Step 5 的標記那一半** | ❌ **沒有** —— dispatch 的 `.catch` 還沒有 `isPolicyRefusal(err)` 的分支 |
> | **Step 6**（失敗路徑） | ✅ **已存在** |
> | **Step 9**（改寫 `telemetry.test.ts`） | ❌ **沒有** |
>
> **⇒ 你要做的是**：Step 1（讀）、**Step 5 的標記那一半**、Step 7（重量爆炸半徑）、**Step 8（標記的突變）**、**Step 9（telemetry 的改寫）**、Step 10、Step 11。
> **✅ 的步驟要當成「已驗證的前置」讀，不是當成待辦** —— 但**先自己 `grep -n` 核對它們真的在**，因為行號會腐化，而這份表本身也可能過期。

- [ ] **Step 1: 讀懂兩條被推翻的既有測試**

**(a)** `packages/core-agent/test/execute-tool-calls.test.ts`，`describe("executeToolCalls scheduler")` 裡的 `"drains started calls and rethrows the first failure (no fabrication)"`。它斷言**兩件**要被推翻的事：`.rejects.toThrow("kaboom")` 與 `expect(resultsOf(session).length).toBeLessThan(2)`。

**(b)** `packages/core-agent/test/telemetry.test.ts:97`：`await expect(agent.run("read a.txt")).rejects.toThrow(/disk exploded/)`。**它的工具本體丟出 `"disk exploded"`**（`:84`）—— **那是工具本體失敗，所以在新契約下它變軟。這一條是第二個編碼舊契約的地方，而第一版計畫只找到了一條。**

**兩條都不是被刪掉，是被改寫** —— 一個刪掉的斷言不留痕。

- [ ] **Step 2: 加常數與 re-export（惰性）**

在 `execute-tool-calls.ts` 的常數區（`git grep -n "TOOL_ABORTED_BEFORE_DISPATCH"` 找 `:7`）：`export const TOOL_FAILED = "TOOL_FAILED"`。放在它**旁邊**。

在 `core-agent/src/index.ts` 的 re-export 區塊（`:12-16`）加上 `TOOL_FAILED,`。

- [ ] **Step 3: 改寫 (a) 成為新契約**

把那一條**整條**換成：

```ts
  it("a failed call yields its OWN result and the turn continues (no rethrow)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    tools.register({
      name: "oktool", description: "ok", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => { await new Promise((r) => setTimeout(r, 20)); return { ok: true } },
    })
    tools.register({
      name: "boomtool", description: "boom", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => { throw new Error("kaboom") },
    })
    // NO .rejects — the whole point of this contract is that it resolves.
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "oktool", args: {} },
      { callId: "c1", name: "boomtool", args: {} },
    ], { maxParallel: 10 })
    const results = session.events.filter((e) => e.type === "tool/result") as {
      callId: string; name: string; output: unknown
    }[]
    expect(results.map((r) => r.callId)).toEqual(["c0", "c1"])
    expect(results[0]!.output).toEqual({ ok: true })
    expect(results[1]!.output).toEqual({ error: "kaboom", code: TOOL_FAILED })
  })
```

import 改成 `import { executeToolCalls, TOOL_ABORTED_BEFORE_DISPATCH, TOOL_FAILED } from "../src/index.ts"`。

- [ ] **Step 4: 跑它，確認紅的理由是對的那一個**

Run: `pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts -t "yields its OWN result"`

Expected: **紅在 `kaboom`**（那個 promise 拒絕）—— **不是** `does not provide an export named`。**那就是被推翻的契約本身。**

- [ ] **Step 5: 分類 —— 丟出點 ＋ 標記（T2 的核心）**

`firstError` 有**兩個來源**，而 cascade 裡還有**第三種**丟出：

| 來源 | 在哪 | 是什麼 | 處置 |
|---|---|---|---|
| **外層 catch** | `:210` 的 `firstError ??= err` | **`prepare` 的拒絕** | **大聲** |
| **外層 catch** | 同上（commit lane 裡丟出的監聽者） | 不是工具本體 | **大聲** |
| **dispatch `.catch`** | `:150-165` | 工具本體丟出 | **軟** |
| **dispatch `.catch`** | 同上 | **`isPolicyRefusal(err)`** —— cascade 裡的政策否決（`HookBlockedError`） | **大聲** |

**先在 `let firstError: unknown` 旁邊加：**

```ts
  // M5 T4 block ①: WHICH KIND of failure decides whether the batch is soft.
  // Two structural tests, no list:
  //   - the SITE: anything reaching the outer catch is a `prepare` refusal
  //     (unknown tool / guard denied / a tools/pre-execute deny / denied /
  //     approval fail-closed / guardian denied) or a throwing commit-lane
  //     listener. Loud.
  //   - the MARKER: a cascade throw that carries `policyRefusal` is a veto
  //     (hooks' pre-tool). Loud. Without it a pre-tool veto would be
  //     classified as a body failure and go soft — which is exactly what
  //     happened before spec §2.6 existed.
  let firstRefusal: unknown
```

**改外層 catch（`:210`）：**

```ts
  } catch (err) {
    if (firstError === undefined) firstError = err
    // Anything thrown outside the dispatch `.catch` is a refusal. It DOMINATES:
    // a policy refusal must never be silently downgraded by a coincident body
    // failure, so a refusal that arrives second still wins.
    firstRefusal ??= err
  }
```

**改 dispatch 的 `.catch`（`:150-165`）** —— 原本的 `if (firstError === undefined) { firstError = err; batchAbort.abort() }` 換成：

```ts
        opts.telemetry?.emit({
          type: "tool/error", ts: Date.now(),
          data: { tool: call.name, callId: call.callId, error: err instanceof Error ? err.message : String(err) },
        })
        if (isPolicyRefusal(err)) {
          // A veto is not a body failure: it must keep failing the turn.
          firstRefusal ??= err
        }
        // M5 T4: on the FIRST failure, cancel the siblings. Only the first, so
        // a second failure cannot re-open a channel that is already closed.
        if (firstError === undefined) {
          firstError = err
          batchAbort.abort()
        }
```

> ⚠ **`batchAbort.abort()` 的條件不可以改。** 一個否決**仍然取消兄弟**（今天就是這樣：`prepare` 的拒絕會讓 `:208` 不再啟動後面的組）。**把它移到 `if (isPolicyRefusal)` 之外會改變取消語意**，而 `4c85a04` 的測試會紅。

**然後在 `if (aborted) { … }` 與 `if (firstError) { … }` 之間插入：**

```ts
  // A refusal is never soft. Drain first (a started sibling must not be left
  // running), then rethrow.
  if (firstRefusal !== undefined) {
    await Promise.allSettled([...inFlight.values()])
    inFlight.clear()
    throw firstRefusal
  }
```

**外層的 import 加上** `isPolicyRefusal`（從 `@i-harness/core-tools`）。

- [ ] **Step 6: 改失敗路徑（綠）**

在檔尾找到（`git grep -n "Failure: drain started"`）：

```ts
  // Failure: drain started (results discarded), rethrow the first error.
  if (firstError) {
    await Promise.allSettled([...inFlight.values()])
    inFlight.clear()
    throw firstError
  }
```

換成：

```ts
  // Failure: cancel the siblings (M5 T4), then COMMIT — every DISPATCHED call
  // ends in exactly one tool/result. This used to `throw firstError` and
  // discard the batch; fs/src/error.ts records the consequence in its own
  // words ("no tool/result and no turn/end are appended ... read as hung").
  //
  // Cancelling and committing are different questions: cancellation answers
  // "do the siblings keep working" (no), committing answers "how does what
  // happened get written down" (honestly). Discarding the siblings' already
  // settled results made the M5 T4 cancellation pointless — they were
  // cancelled AND thrown away.
  //
  // Reached ONLY when `firstRefusal` is undefined (checked above).
  if (firstError) {
    await Promise.allSettled([...inFlight.values()])
    inFlight.clear()
    // Fill every STARTED slot that produced no output, so the head-of-line
    // cursor advances and an already-settled sibling commits its REAL result
    // (the SAME mechanism M51 B3 added to the abort path, one branch up).
    const message = firstError instanceof Error ? firstError.message : String(firstError)
    for (let i = committed; i < startedUpTo; i += 1) {
      if (slots[i] !== undefined) continue
      const call = batch[i]!
      slots[i] = {
        name: call.name, callId: call.callId, synthetic: true,
        output: { error: message, code: TOOL_FAILED },
      }
    }
    await commitReady()
  }
```

- [ ] **Step 7: 跑它 —— 並且量出**完整的**爆炸半徑**

```bash
pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts
for p in hooks session-executor sdk; do pnpm --filter "@i-harness/$p" exec vitest run; done
pnpm --filter @i-harness/cli exec vitest run
```

Expected:
- **`execute-tool-calls.test.ts` 全綠**。若 `M5 — a failure cancels its siblings` 紅，**停手回報** —— `batchAbort.abort()` 被碰掉了。
- **`hooks` 全綠** —— T1 的標記生效（`pre-tool` 否決維持大聲）。
- **其餘四個套件：預期 7 條紅，而它們全部是工具本體失敗。** 逐條確認是那 7 條（**多一條或少一條都要停手回報**）：

| 套件 | 條數 | 在哪 |
|---|---|---|
| `session-executor` | **5** | `test/assembly.test.ts` 的 `resolveRoleModel` 家族：`:1221`、`:1314`、`:1319`、`:1329`、`:1336` |
| `sdk` | **1** | `test/server.test.ts:291`（`SKILL_NOT_FOUND`） |
| `cli` | **1** | `test/plugin-mount.test.ts` |

**這 7 條是 T3 的工作。不要在 T2 動它們。**

- [ ] **Step 8: 突變 —— 證明分類真的在分類**

把 `if (isPolicyRefusal(err))` 那一段**刪掉**，重跑 `pnpm --filter @i-harness/hooks exec vitest run`。

Expected: **紅** —— `expected [Function] to throw error matching /read disabled/`（否決變軟了）。**還原**，再跑確認綠。

- [ ] **Step 9: 改寫 `telemetry.test.ts`**

`packages/core-agent/test/telemetry.test.ts:97` 的 `await expect(agent.run("read a.txt")).rejects.toThrow(/disk exploded/)`。

**這一條的實質主張是「宿主遙測看得到工具錯誤」** —— 而它**在新契約下仍然成立**，只是換了通道：turn 不再拒絕，而 `tool/error` 遙測事件照樣帶著 `error: "disk exploded"`。

> **⚠ 這一格的程式碼片段在第一版是**做不到的**，而那個錯的形狀與這一塊前面每一個一樣。** 複審後量到：那個 mock 是**一步**的，而軟失敗會讓 turn **繼續** ⇒ `await agent.run("read a.txt")` **解析不了** —— 它會以 `model stream error: mock script exhausted` 拒絕。**正確的做法是把那個 mock 加一步**（第二個 scripted step 是迴圈會去消費的那一個）。
>
> **⇒ 所以這一步的判準是下面那句話，不是下面那段碼**：**那條測試的實質主張必須原樣活下來**，而**通道**從「turn 拒絕」換成「遙測事件帶著那個錯誤」。**照該檔既有的 fixture 形狀改**，並在報告裡寫下你改了什麼。若你發現你需要**弱化**那個斷言才過得了，**停手回報**。

**要保住的斷言**：`err.data` 帶著 `{ tool: "read", error: "disk exploded" }`（`:102` 那條本來就在斷言它 —— 現在它是**主要的**斷言，而不是附帶的）。**新增的只是那一步 scripted step。**

- [ ] **Step 10: 再跑一次**

Run: `pnpm --filter @i-harness/core-agent exec vitest run`

Expected: **`core-agent` 全綠**（這一刻 `session-executor`／`sdk`／`cli` 仍有 7 條紅 —— **那是 T3 的**）。

- [ ] **Step 11: Commit**

```bash
git add packages/core-agent/src/execute-tool-calls.ts packages/core-agent/src/index.ts packages/core-agent/test/execute-tool-calls.test.ts packages/core-agent/test/telemetry.test.ts
git commit -m "feat(core-agent): M5 T4 block 1 — a body failure goes soft, a policy refusal stays loud, and the site is not the only test"
```

---

#### 🔴 T2 修正輪 —— 複審的 Critical（**這一節是後補的，量到才寫下來的**）

**Critical：一個還在飛的否決會被靜默降級成軟的。**

`:281` 的 `if (firstRefusal !== undefined)` 是**決策點**，而 `firstRefusal` 的兩個寫入點（`:174`、`:234`）**都在 `.catch` 裡** —— 而 `:281` **之前沒有任何地方 await 過在飛的 promise**（那一次的 `Promise.allSettled` 在 `:284`，**在決策之後**）。

**複審量到的**（用真的 `HookBlockedError`，從真的 `tools/execute` cascade 監聽者丟出）：

| | 結果 |
|---|---|
| 否決的 `.catch` 先跑（`vetoDelay=0ms`） | **`THREW: read disabled`** —— 大聲 ✓ |
| 否決的 `.catch` 晚 100ms | **`RESOLVED (soft path)`**，而 **c1 的結果是 `{"error":"boom","code":"TOOL_FAILED"}`** —— **它被記成「用兄弟的訊息失敗了」** |

**⇒ 同一個具型錯誤，只因為 microtask 的先後，就大聲或變軟。** 而可達性是普通的：`pre-tool` 是一個**子行程**（這條分支自己的 e2e 量到 449ms），所以任何先失敗的兄弟都會贏這個競態。

**修法（複審指的方向，而它與 `:279-280` 那句假註解的修正一起做）：**

**在 abort 分支與 `if (firstRefusal !== undefined)` **之間**插入一次 drain：**

```ts
  // Drain BEFORE the disposition tests. Every write to `firstError` and
  // `firstRefusal` happens in a `.catch` handler, so until the in-flight
  // promises have settled neither is final — and a refusal that settles one
  // microtask late is tested as "not a refusal" and silently downgraded to
  // the soft path. (Measured before this drain existed: the same marked veto
  // threw when its own .catch ran first, and resolved softly — recorded
  // against a sibling's error message — when a sibling's failure got there
  // first. A pre-tool hook is a SUBPROCESS; losing that race is the normal
  // case, not the exotic one.)
  await Promise.allSettled([...inFlight.values()])
  inFlight.clear()
```

**然後把 `:279-280` 的假話改掉** —— `// this is byte-for-byte the pre-block-① behavior for every refusal, which is the point.` **在這一點上是假的**（它只有在 drain 之後才成立）。換成：

```ts
  // A refusal is never soft. The drain above has already settled every
  // in-flight dispatch, so `firstRefusal` is final here.
```

**Important：軟路徑把**第一個**錯誤的訊息蓋在每一格上。**

`:311` 的 `const message = firstError instanceof Error ? … : String(firstError)` 被**每一個**沒有輸出的格子共用 ⇒ 一個 `boomB → "B error"` 的呼叫，日誌裡記的是 `{"error":"A error"}`。**而 `:292-296` 的註解自己寫著 `(honestly)`。**

**修法：記住每一個呼叫自己的錯誤。**

在 `const slots: … = batch.map(…)` 旁邊加：

```ts
  // Each call's OWN failure, so the fill below can record what actually
  // happened to THAT call rather than stamping the first failure's message on
  // every sibling. After the drain above, an unfilled STARTED slot always has
  // an entry here (allSettled guarantees it settled, and a settled dispatch
  // either wrote `slots[i]` or ran the `.catch`).
  const failures = new Map<number, unknown>()
```

在 dispatch 的 `.catch` 裡加一行（**放在 `firstError` 那個 if 之外**）：

```ts
        failures.set(index, err)
```

填補迴圈改成：

```ts
    for (let i = committed; i < startedUpTo; i += 1) {
      if (slots[i] !== undefined) continue
      const call = batch[i]!
      const own = failures.get(i)
      const message = own !== undefined
        ? (own instanceof Error ? own.message : String(own))
        : firstError instanceof Error ? firstError.message : String(firstError)
      slots[i] = {
        name: call.name, callId: call.callId, synthetic: true,
        output: { error: message, code: TOOL_FAILED },
      }
    }
```

**而 `failures.get(i)` 的 fallback 是防禦性的、不是路徑** —— 上面那個 Drain 註解寫了為什麼：`allSettled` 保證每個已開始的呼叫都落地了，而落地的分派**要嘛寫了 `slots[i]`、要嘛跑了 `.catch`**。

**回歸測試（兩條，都放在 `execute-tool-calls.test.ts`）：**

1. **一個否決晚於兄弟的失敗落地 ⇒ 必須大聲。** 用 `ctx.onCascade("tools/execute", …)` 丟一個帶 `policyRefusal` 標記的錯誤（延遲 50ms），而第一批裡另一個呼叫立刻失敗。**斷言 `executeToolCalls` 拒絕，而且 `rejects.toThrow` 帶的是否決的訊息。** 把那個新的 drain 拿掉 ⇒ **必須紅**。
2. **兩個都失敗的呼叫，各自記自己的訊息。** 兩個 body 都丟，訊息不同。**斷言兩筆 `tool/result` 的 `output.error` 各自是自己的那一句。** 把 `failures.get(i)` 改回 `firstError` ⇒ **必須紅**。

---

### Task 3: 被推翻契約的其餘編碼（7 條，3 個套件）

**Files:**
- Modify: `packages/session-executor/test/assembly.test.ts`（5 條）
- Modify: `packages/sdk/test/server.test.ts`（1 條）
- Modify: `apps/cli/test/plugin-mount.test.ts`（1 條）

**Interfaces:**
- Consumes: T2 的行為（一個工具本體丟出 ⇒ 軟結果，turn 繼續）。
- Produces: 無新 export。

**這一條是「改寫而不是刪除」那一條規則的延伸。** 7 條測試各自有一個**實質主張**，而每一個在新契約下**仍然成立，只是換了通道** —— 舊通道是「turn 拒絕」，新通道是「那筆 `tool/result` 帶著那個原因」。

> ⚠ **這一條的步驟刻意是「先讀、再寫」而不是貼好的測試碼。** 7 條測試住在 3 個不同的 harness 裡，而**替它們編一份沒讀過的測試碼，比讓實作者去讀更糟** —— 這一條分支上已經有一個計畫因為「沒有先量就寫下」而被推翻（見上面的表）。**而每一條的改寫都有硬性檢查（Step 3），所以「讀」不會變成「自由發揮」。**

- [ ] **Step 1: 逐條讀，並寫下實質主張**

**每一條測試**，在動手前記下兩件事：

1. **它真正在斷言什麼**（那句話，不是那個 matcher）
2. **那個主張在新契約下還成不成立** —— 如果**不成立**，**停手回報**，那是設計問題不是測試問題

七條在哪裡（`grep -n "it(" <file>` 核對行號，它們會腐化）：

| # | 檔案 | 測試名 |
|---|---|---|
| 1 | `packages/session-executor/test/assembly.test.ts:~1221` | `a plugin role is what spawn_agent resolves against; without the option the same call does not` |
| 2 | `:~1314` | `a wired but not-ready resolver fails the spawn with ITS reason` |
| 3 | `:~1319` | `an ABSENT resolver fails naming the selection (no silent inherit)` |
| 4 | `:~1329` | `without plugins.subagentModel the model-carrying spawn is refused, naming both fixes` |
| 5 | `:~1336` | `the host's declared role selection reaches the spawn and WINS over the role's own` |
| 6 | `packages/sdk/test/server.test.ts:~283` | 一個缺失的 skill（`SKILL_NOT_FOUND`） |
| 7 | `apps/cli/test/plugin-mount.test.ts` | plugin mount |

**五條 `session-executor` 的形狀是**：`expect(() => …).toThrow(/<原因>/)`，而**它們的實質主張是「那個原因必須看得見」** —— 在新契約下**它仍然看得見，在 `tool/result` 的 `output.error` 裡**。

- [ ] **Step 2: 逐條改寫**

**改寫的形狀**（以 `session-executor` 的為例 —— **照該檔既有的 fixture 改，不要假設名字**）：

```ts
    // Before: the spawn THREW and the turn died.
    //   expect(() => run(...)).toThrow(/role 'rolemodel' cannot resolve its model/)
    // After (M5 T4 block 1): the spawn fails SOFT — the turn continues and the
    // reason reaches the model in the tool result. The claim is unchanged
    // ("the reason must be visible"); only the channel moved.
    await run(...)
    const result = <the session's tool/result for that callId>
    expect(String((result.output as { error: string }).error))
      .toMatch(/role 'rolemodel' cannot resolve its model/)
```

- [ ] **Step 3: 硬性檢查 —— 每一條改寫都要有突變證明**

**對每一條改寫**，找一個能讓它紅的突變。**最便宜的那個對全部七條都適用**：把 T2 的 `if (firstRefusal !== undefined) { … throw firstRefusal }` 區塊**暫時**改成也涵蓋它們的路徑……

**不行 —— 那不會紅。** 這七條走的是**軟**路徑，所以它們的突變是：**把 T2 的軟路徑改回 `throw firstError`**。那個突變會讓**七條全部紅**（那正是舊契約）。

**⇒ 所以 Step 3 是**：做那一個突變一次，確認**七條全部紅**，然後還原、確認七條全綠。

**若某一條在突變下仍然綠，那一條的改寫是空的 —— 停手回報。** 這一步是這一整條任務唯一能證明「改寫不是把斷言刪掉」的東西。

- [ ] **Step 4: 逐套件跑**

```bash
for p in session-executor sdk; do pnpm --filter "@i-harness/$p" exec vitest run; done
pnpm --filter @i-harness/cli exec vitest run
```

Expected: **三者全綠，零紅。**

- [ ] **Step 5: Commit**

```bash
git add packages/session-executor/test/assembly.test.ts packages/sdk/test/server.test.ts apps/cli/test/plugin-mount.test.ts
git commit -m "test(m5): the four packages that encoded throw-fails-turn assert the same reasons through the soft channel"
```

---

### Task 4: 從未開始的呼叫拿到一筆**與中止不同**的結果

**Files:**
- Modify: `packages/core-agent/src/execute-tool-calls.ts`（T2 寫的 `if (firstError)` 區塊的尾巴）
- Modify: `packages/core-agent/src/index.ts`（re-export）
- Test: `packages/core-agent/test/execute-tool-calls.test.ts`

**Interfaces:**
- Consumes: T2 的 `TOOL_FAILED` 與失敗路徑；既有的 `TOOL_ABORTED_BEFORE_DISPATCH`（`:7`）與它的 `append` 迴圈。
- Produces: `export const TOOL_CANCELLED_BY_SIBLING = "TOOL_CANCELLED_BY_SIBLING"`。

**為什麼需要一條新的訊息**（spec §2.3）：「被中止」與「因為同批的兄弟失敗而被取消」**是兩件不同的事，不可以共用一句話**。

- [ ] **Step 1: 寫紅測試**

在 `describe("executeToolCalls scheduler")` 裡加：

```ts
  it("a never-started call is CANCELLED, and says so — not the abort message", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    tools.register({
      name: "boomtool", description: "boom", inputSchema: {}, isConcurrencySafe: true,
      // Throws IMMEDIATELY: c0 fails before c1's prepare ever runs, so c1 is
      // never started and lands in the [startedUpTo, batch.length) range.
      execute: async () => { throw new Error("kaboom") },
    })
    tools.register({
      name: "nevertool", description: "never started", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => ({ ok: true }),
    })
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "boomtool", args: {} },
      { callId: "c1", name: "nevertool", args: {} },
    ], { maxParallel: 1 })
    const results = session.events.filter((e) => e.type === "tool/result") as {
      callId: string; output: { code?: string }
    }[]
    expect(results.map((r) => r.callId)).toEqual(["c0", "c1"])
    expect(results[0]!.output.code).toBe(TOOL_FAILED)
    expect(results[1]!.output.code).toBe(TOOL_CANCELLED_BY_SIBLING)
    expect(results[1]!.output).not.toMatchObject({ code: TOOL_ABORTED_BEFORE_DISPATCH })
  })
```

import 加上 `TOOL_CANCELLED_BY_SIBLING`。

- [ ] **Step 2: 跑它，確認它紅**

Expected: **紅** —— `results` 只有 `["c0"]`。**如果你看到的是 import 的錯，先加常數（Step 3 的宣告部分）再重跑** —— 紅必須紅在「c1 沒有結果」。

- [ ] **Step 3: 加常數並實作**

`execute-tool-calls.ts` 常數區：

```ts
// A call that never started because a SIBLING failed. Deliberately a
// different code AND a different message from TOOL_ABORTED_BEFORE_DISPATCH:
// "the user stopped the step" and "a tool in this batch broke" are different
// facts, and a log that conflates them cannot be read back.
export const TOOL_CANCELLED_BY_SIBLING = "TOOL_CANCELLED_BY_SIBLING"
```

`core-agent/src/index.ts` re-export 區塊加上它。

然後在 `if (firstError)` 區塊的**尾巴**（`await commitReady()` 之後）：

```ts
    // Calls that never started: no `prepare`, no `tool/dispatch`, no body.
    // They get a result too, so the projection never emits a tool_use with no
    // tool_result — but their verdict is CANCELLATION, not abort.
    for (let i = startedUpTo; i < batch.length; i += 1) {
      const call = batch[i]!
      append(session, {
        type: "tool/result", callId: call.callId, name: call.name,
        output: {
          error: "tool call cancelled: a sibling call in the same batch failed",
          code: TOOL_CANCELLED_BY_SIBLING,
        },
      })
    }
```

**然後修那個被你這一步變成假的註解** —— `execute-tool-calls.ts:47-48`，**那個檔案自己的契約摘要**：

```ts
// Failure (throw-fails-turn, ruling A): stop starting, drain started calls,
// rethrow the first error — NO fabricated results for unstarted calls.
```

**它現在是假的**（失敗路徑不再 rethrow），**而它假的那一句正好是你這一步在推翻的** —— `NO fabricated results for unstarted calls`。**⇒ 它屬於你，不屬於 T6。** 改成：

```ts
// Failure (soft since M5 T4 block ①): stop starting, drain started calls,
// fill the failed slot, commit what settled, and give never-started calls a
// TOOL_CANCELLED_BY_SIBLING result. Nothing is fabricated — that verdict is a
// fact about what happened, not a made-up outcome. A policy refusal (a
// `prepare` throw, or a cascade throw carrying the PolicyRefusal marker)
// still rethrows.
```

> **⚠ 為什麼這一條是你的而不是 T6 的**：T6 是一個**掃蕩**，而掃蕩排在最後。**而這一段註解就住在你正在編輯的檔案裡、正在教「不要替從未開始的呼叫填結果」** —— 一個讀它的實作者會做出與你這一步相反的決定。**一個會誤導下一個任務的假註解，由製造它的任務修。**

- [ ] **Step 4: 跑測試（綠）**

Run: `pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts`

Expected: **全綠**。

- [ ] **Step 5: 突變 —— 證明「不同」那一半被釘住**

把新迴圈的 `code: TOOL_CANCELLED_BY_SIBLING` 改成 `code: TOOL_ABORTED_BEFORE_DISPATCH`，重跑。

Expected: **紅** —— `expected 'TOOL_ABORTED_BEFORE_DISPATCH' to be 'TOOL_CANCELLED_BY_SIBLING'`。**還原**，再跑確認綠。

- [ ] **Step 6: Commit**

```bash
git add packages/core-agent/src/execute-tool-calls.ts packages/core-agent/src/index.ts packages/core-agent/test/execute-tool-calls.test.ts
git commit -m "feat(core-agent): M5 T4 block 1 — a never-started call is CANCELLED by its sibling, and the log says which"
```

---

### Task 5: 三條**不可以動**的界線

**Files:**
- Modify: `packages/core-agent/src/execute-tool-calls.ts`（`commitReady()` 的 try/catch）
- Test: `packages/core-agent/test/execute-tool-calls.test.ts`

**Interfaces:**
- Consumes: T2／T4 的失敗路徑。
- Produces: 無新 export。**這一條是防守。**

- [ ] **Step 1: 寫三條界線的測試**

在 `describe("executeToolCalls scheduler")` 的最後加：

```ts
  it("BOUNDARY: a PREPARE refusal still kills the turn (spec §6.1)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    // An unregistered tool makes `prepare` throw at core-tools:230. That is a
    // POLICY/PROTOCOL refusal, not a tool failure, and it must stay loud.
    await expect(
      executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "no-such-tool", args: {} }], { maxParallel: 10 }),
    ).rejects.toThrow("unknown tool: no-such-tool")
    expect(session.events.filter((e) => e.type === "tool/result")).toHaveLength(0)
  })

  it("BOUNDARY: an ABORT still throws 'agent aborted' (block 1 does not touch it)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const ac = new AbortController()
    ac.abort()
    await expect(
      executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "anyTool", args: {} }], { maxParallel: 1, signal: ac.signal }),
    ).rejects.toThrow("agent aborted")
  })

  it("BOUNDARY: a throwing finalize during the failure drain still fills the never-started calls", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    // Mirrors the abort-path test ("abort dominates a throwing finalize").
    // The failure path inherits the same swallow, AND the same cost.
    ctx.on("tools/post-execute", () => { throw new Error("post-execute boom") })
    tools.register({
      name: "okTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true } },
    })
    tools.register({
      name: "boomTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => { throw new Error("kaboom") },
    })
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "okTool", args: {} },
      { callId: "c1", name: "boomTool", args: {} },
      { callId: "c2", name: "okTool", args: {} }, // never started (pool full at the failure)
    ], { maxParallel: 2 })
    const cancelled = session.events.filter(
      (e) => e.type === "tool/result" && (e as { output?: { code?: string } }).output?.code === TOOL_CANCELLED_BY_SIBLING,
    )
    expect(cancelled.map((e) => (e as { callId: string }).callId)).toEqual(["c2"])
  })
```

- [ ] **Step 2: 跑它們**

Run: `pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts -t "BOUNDARY"`

Expected: **前兩條綠、第三條紅** —— 第三條會因為 `commitReady()` 的丟出**逃出 `executeToolCalls`**，於是 `cancelled` 是空的。**若三條全綠，停手回報** —— 那代表第三條沒有測到它要測的東西。

- [ ] **Step 3: 加 try/catch，並移除一行現在死掉的 drain**

> **⚠ 先移除那一行，再加 try/catch** —— 它們在同一個區塊，而你正在編輯它。
>
> T2 的修正輪把 drain 提到三個分支**之前**（那是 Critical 的修法）。**而軟路徑開頭那兩行 `await Promise.allSettled([...inFlight.values()])` / `inFlight.clear()` 因此變成 no-op** —— `inFlight` 已經被前面那次 drain 清空了。
>
> **它不是無害的**：一個讀到它的人會以為「軟路徑在這裡 drain」，**而那正是 Critical 之前的那個（錯的）形狀**。**它留著就是一個關於執行順序的假陳述。**
>
> **把它刪掉。** 刪完跑 `pnpm --filter @i-harness/core-agent exec vitest run test/execute-tool-calls.test.ts` —— **必須仍然全綠**（含 T2 修正輪那兩條回歸測試）。**若刪了會紅，停手回報** —— 那代表前面那次 drain 不涵蓋這條路徑。

在 T2 寫的 `await commitReady()` 外面加：

```ts
    try {
      await commitReady()
    } catch {
      // A throwing tools/post-execute listener must not suppress the
      // never-started fills below — the abort path swallows for exactly this
      // reason (see its comment at the top of the abort branch).
      //
      // STATED COST (inherited, not introduced): a settled sibling sitting
      // BEHIND the throwing listener does not get its result. The abort path
      // has the same hole and the same test shape; this block does not fix it,
      // it makes the two paths consistent and the cost visible.
    }
```

- [ ] **Step 4: 跑測試（綠）**

Expected: **全綠**。

- [ ] **Step 5: Commit**

```bash
git add packages/core-agent/src/execute-tool-calls.ts packages/core-agent/test/execute-tool-calls.test.ts
git commit -m "test(core-agent): M5 T4 block 1 — the three boundaries that must not move with the failure path"
```

---

### Task 6: 過期的契約註解，與**兩步**的全套閘門

**Files:**
- Modify: `packages/core-agent/src/index.ts`（`git grep -n "rethrows the first tool failure"`）
- Modify: `docs/handoff/2026-09-20-queued-work.md`

**Interfaces:**
- Consumes: T1–T5 全部。
- Produces: 無。

- [ ] **Step 1: 掃蕩那個類別 —— 不是修幾個 grep 命中**

> **⚠ 這一格的第一版只列了 `index.ts` 的一處，而實際上有四處。** 我在派 T2 的時候犯了「**修實例而不是修類別**」—— **而那正是 `docs/handoff/2026-09-20-protocol-selection-phase-b.md:155` 早在這條分支上記過我犯的同一件事。**

**這一類是「被 M5 T4 block ① 變成假的註解」。先跑這個 —— 它是類別的定義，不是清單：**

```bash
git grep -n "throw-fails-turn"                        -- packages/*/src apps/cli/src
git grep -n "rethrows the first\|results discarded\|still discards\|keeps its throw" -- packages/core-agent/src
git grep -n "block ①\|block 1"                        -- packages/core-agent/src
```

**已知的四處**（**先 `grep -n` 核對行號再改；這份清單是起點，不是全部**）：

| # | 位置 | 假的句子 |
|---|---|---|
| 1 | `execute-tool-calls.ts:245-246` | `The NON-abort path keeps its throw (… which is the correct throw-fails-turn behavior).` |
| 2 | `execute-tool-calls.ts:251-252` | `Abort path ONLY — the non-abort failure path still discards (M13).` |
| 3 | `index.ts:408` | `and rethrows the first tool failure.` |
| 4 | `execute-tool-calls.ts:47-48` | **T4 負責**（它推翻的那一句正好是 T4 的題目）—— **若 T4 已經修了，這一列就是檢查它真的修了，不是重做** |

**已核對、判定為**不需要動**的一處（免得你把它當成漏掉的）**：`execute-tool-calls.ts:87` 的 `the path said "drain started (results discarded)"` —— **那是一句歷史引述**（「那段程式碼以前這樣寫」），而它在描述為什麼要加 `batchAbort`。**歷史在加了之後仍然是對的。**

- [ ] **Step 2: 改寫這三處**

`index.ts:408` 那段換成：

```ts
        // M13: concurrent execution. The scheduler appends tool/result in model
        // order and emits agent/post-tool from its commit lane; it throws
        // "agent aborted" on step abort (draining + synthesizing results for
        // never-started calls). A tool BODY failure does not throw: the failed
        // call is filled with a TOOL_FAILED result, its never-started siblings
        // get TOOL_CANCELLED_BY_SIBLING, and the turn continues so the model
        // sees the error and can retry. A POLICY refusal still throws — a
        // `prepare` refusal by site, a cascade veto by its PolicyRefusal
        // marker. (Before M5 T4 block ① every failure threw and the batch was
        // discarded; fs/src/error.ts records what that looked like outside.)
```

**然後跑同一組 sweep 指令第二次。** **回傳必須是空的**（或只剩你剛剛寫的那段，而它是**合格的**）。

> **⚠ 這不是儀式。** phase-B 的交接文件（`:159`）記著那一輪的收尾動作：
>
> > **一個修正可以生出下一個實例** —— 所以複審的收尾動作是**再掃一次**，不是宣告完成。
>
> **⇒ 「三處都改了」不是類別被關上的證據；「同一組指令第二次回傳空」才是。**

- [ ] **Step 3: 全套 —— ⚠ 先讀這一格**

**`pnpm -r --no-bail test` 在有任何套件紅的時候，只跑一個前綴。**

2026-09-20 實測（`core-agent` 因這一塊的初始缺陷而紅）：

```
Scope: 66 of 67 workspace projects
…… 58 個套件回報結果 ……
packages/core-agent test:       Tests  1 failed | 74 passed (75)
…… 再 4 個套件 ……
Error: ERR_PNPM_RECURSIVE_FAIL
  × "pnpm recursive run" failed in 1 packages
```

**58 個有起始行，8 個連起始行都沒有** —— 失敗的那一個是**倒數第 9 個**開始的：**它在哪裡失敗，排程就在哪裡停。`--no-bail` 不擋這件事。** 沒跑到的是最大的八個（`cli`、`session-executor`、`subagent`、`agent-team`、`hooks`、`sdk`、`acp`、`guard-approval`）。

**⇒ 一個紅的全套數字是一個前綴，而它看起來完全像總數。** `2624` 那個基線是真的（W4 全綠 ⇒ 66 個都跑），但**拿一個紅的數字去比它，是在比兩個不同的母體**。

```bash
pnpm -r --no-bail test 2>&1 | tee /tmp/full.log
echo "--- 母體（必須是 66）---"
sed 's/\x1b\[[0-9;]*m//g' /tmp/full.log | grep -cE " test:  Test Files "
echo "--- 逐包合計 ---"
sed 's/\x1b\[[0-9;]*m//g' /tmp/full.log | grep -E "Tests +[0-9]+ (passed|failed|skipped)"
pnpm typecheck
node scripts/audit/check-reachability.mjs --gate
```

Expected:
- **母體必須是 `66`。不是 66 就停手回報** —— 那個合計是一個前綴。補跑缺的套件，兩邊分開記。
- 全綠時：**基線 `2624`**（W4 修正輪，`docs/handoff/2026-09-20-queued-work.md` §5）**＋ 這一塊的淨增**。**淨增要在動手前先算出來寫在旁邊：**

  | 任務 | 新增 | 改寫（淨 0） |
  |---|---|---|
  | **T1** | **+4**（`policy-refusal.test.ts`） | — |
  | **T2** | 0 | 2（`execute-tool-calls` 1、`telemetry` 1） |
  | **T3** | 0 | 7 |
  | **T4** | **+1** | — |
  | **T5** | **+3** | — |

  ⇒ **預期 `2624 + 4 + 1 + 3 = 2632 passed · 0 failed · 9 skipped`**。**跑完對照；不符就停手回報，不要改數字去迎合。**

  ⚠ **「改寫淨 0」的前提是一條換一條。** 若某條改寫把它拆成兩條，計數就會動 —— **那樣子就照實記下差在哪，不要事後把預期改成量到的值。**
- `pnpm typecheck` → **0 error lines**
- `check-reachability.mjs --gate` → **`gate PASS -- no new rows`**

**⚠ 兩個既有的 flake，看到它們紅：重跑一次、繼續，不要改任何計數。**
1. `packages/session-executor/test/shell-promotion.test.ts` 在負載下 30 秒逾時
2. `apps/cli/test/input-tiers.test.ts` 的 executor 案例在滿載下紅，隔離跑必過

- [ ] **Step 4: 更新佇列文件**

`docs/handoff/2026-09-20-queued-work.md`：§1 的 **W5** 列改成 `✅ block ①（信封）完成`，§5 的 **T4 的工具管線** 那列底下加完成記錄（哪一塊完成、量到什麼、**`ruling A` 被推翻而它是刻意的**、**`pre-tool` 否決仍然是 loud**）。狀態列的 SHA 先寫 `<SHA>` 佔位。

- [ ] **Step 5: Commit**

```bash
git add packages/core-agent/src/index.ts docs/handoff/2026-09-20-queued-work.md
git commit -m "docs(core-agent): M5 T4 block 1 — the call site's contract comment catches up, and the queue records the block"
```

- [ ] **Step 6: 補 SHA**

把 `<SHA>` 換成真的 SHA，另開一個 docs 提交（**這條分支的既有慣例：一個 SHA 不能在它存在之前被寫下**）。

---

## Self-Review

**1 · Spec coverage**

| spec | 在哪 |
|---|---|
| §2.1 步驟 1（停止啟動） | 不動（既有的 `:190`／`:208`） |
| §2.1 步驟 2（取消兄弟） | 不動（`4c85a04`；T2 Step 7 的「若紅停手」守它） |
| §2.1 步驟 3–5（不 rethrow／填失敗格／兄弟 commit） | **T2** |
| §2.1 步驟 6（從未開始的填） | **T4** |
| §2.3（訊息必須不同） | T4 Step 5 的突變 |
| §2.4 的四條代價 | 前三條由 T5 與 Global Constraints 守；第四條由既有的 `"synthetic" in slot` 分支維持 |
| §2.5（不加錯誤旗標） | Global Constraints 第 1 條 |
| **§2.6（後補：cascade 的政策否決）** | **T1（標記）＋ T2 Step 5（檢查）＋ T2 Step 8（突變）** |
| **§2.6.2（爆炸半徑 8 條）** | **T2（`core-agent` 的 1 條）＋ T3（其餘 7 條）** |
| §6.1（政策丟出仍然大聲） | T5 Step 1 第一條 |
| §7 的測試表（前兩列） | T2、T4、T5 |

**2 · Placeholder scan** —— 無 TBD／TODO。**唯一的「描述而非貼碼」是 T3**，而它**明說自己是描述**、附了每一條的硬性檢查（突變必須讓七條全紅），並說明了為什麼（替 3 個沒讀過的 harness 編測試碼比讓實作者去讀更糟）。

**3 · Type consistency** —— `TOOL_FAILED`（T2）、`TOOL_CANCELLED_BY_SIBLING`（T4）、`isPolicyRefusal`／`PolicyRefusal`（T1）在定義處與使用處拼字一致；`SyntheticSlot`、`commitReady`、`firstError` 是既有的名字。

**4 · 明說的缺口** —— spec §7 第三列（用 `deriveMessages` 端到端斷言「每個 `tool/call` 都有 `tool/result`」）**不在這一塊**：`deriveMessages` 住在 `core-session`，而這一塊的約束明說不動它。**它是 block ②／③ 或一個獨立小項的**。**記著，不假裝做了。**
