# M5／T4 block ② — 參數 schema 層 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一個模型送來的畸形參數，在**進入工具本體之前**被擋下，而模型看得見**哪一個欄位**錯了、並且可以重試。

**Architecture:** 兩層，而它們的分工是「**誰訂的契約**」。**值那一層是全函式**（對任意值不拋、不轉型、回路徑限定的違反清單）—— 所以它可以安全地跑在**遠端送來的** schema 上。**斷言那一層是 IH 對自己的契約**，在註冊時跑一次，而它**只對 IH 自己寫的 schema 跑**。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-20-m5-t4-tool-pipeline-design.md`（**§3 是這一塊的全部依據；§3.6.1 是施工前量到才寫的**）。前置：block ①（已完成、已推）—— **②d 的拒絕要走 ①的軟失敗**。

## Global Constraints

- **子集是量出來的十個關鍵字**（§3.2）：`type`／`properties`／`required`／`description`／`enum`／`items`／`minimum`／`maximum`／`maxItems`／`additionalProperties`。**而 §3.6.1 讓 `additionalProperties` 也接受一個 schema。** **多一個都不加。**
- **值那一層是全函式**：對任意（schema, value）配對**不拋、不轉型**。這是它與斷言那一層的**唯一**差別，也是它對遠端 schema 安全的原因。
- **斷言那一層只對 IH 寫的 schema 跑**（§3.8）—— MCP 的 schema **不是 IH 寫的**，拒絕它就是拒絕一個合法的伺服器。
- **`INVALID_ARGS` 是一個具型的處置**，而**只有那一種**被轉成軟失敗（§3.7.1）。**詞彙永遠是「具型的處置」，不是一份訊息清單。**
- **`prepare` 的其他拒絕不動**：`unknown tool`／`guard denied`／`tools/pre-execute` 的 deny／approval fail-closed／guardian denied **仍然大聲**。
- **不新增 export，除了**：`validateJsonSchemaValue`、`assertSupportedJsonSchema`、`INVALID_ARGS` 的型別。`--gate` 在中途會是 `N NEW rows`，**這是預期的**（見 block ① 的教訓）。
- ⚠ **不要在註解裡寫一個「沒有生產消費者」的 export 名字** —— 掃描器不剝註解，那會讓那一列消失（block ① 量到 3 → 2）。
- ⚠ **全套閘門是兩步**：`pnpm -r --no-bail test` 在有紅的時候**只跑一個前綴**。**先數母體（必須 66），再比數字。**
- **行號會腐化。** 每一處引用動手前先 `grep -n`。

---

## File Structure

| 檔案 | 角色 | 哪個任務 |
|---|---|---|
| **`packages/core-tools/src/json-schema.ts`** | **新檔** —— 值那一層（全函式）＋ 斷言那一層 | **T1 · T2** |
| `packages/core-tools/src/index.ts` | 工具註冊的擁有者 | **T2**（掛斷言）、**T3**（MCP 標記的讀者） |
| `packages/mcp-client/src/bridge.ts` | **唯一**把遠端 schema 裝進 `Tool` 的地方 | **T3**（標記的寫者） |
| `packages/core-tools/src/index.ts` 的 `prepare` | 政策瀑布的入口 | **T4** |
| `packages/core-agent/src/execute-tool-calls.ts` | 批次排程器 | **T4**（`INVALID_ARGS` → 軟失敗） |

**為什麼住在 `core-tools`**：`prepare` 要用它，而 `prepare` 在 `core-tools` —— **搬到別的套件就是循環依賴**（spec §6.2 已經把這條釘住）。

---

### Task 1: 值那一層 —— `validateJsonSchemaValue`

**Files:**
- Create: `packages/core-tools/src/json-schema.ts`
- Test: `packages/core-tools/test/json-schema.test.ts`

**Interfaces:**
- Produces: `validateJsonSchemaValue(schema: JsonSchemaNode, value: unknown, path?: string): string[]`（**空陣列 = 合法**）· `type JsonSchemaNode`（內部形狀）

**這一條的合約是「全函式」** —— 它對任意值不拋、不轉型、不變異。**那是它與斷言那一層唯一的差別，也是它可以跑在遠端 schema 上的理由。**

- [ ] **Step 1: 寫紅測試**

建立 `packages/core-tools/test/json-schema.test.ts`：

```ts
import { describe, expect, it } from "vitest"
import { validateJsonSchemaValue, type JsonSchemaNode } from "../src/json-schema.ts"

const v = (schema: JsonSchemaNode, value: unknown, path = "value") => validateJsonSchemaValue(schema, value, path)

describe("validateJsonSchemaValue — the value layer (spec §3.1)", () => {
  it("returns [] for a conforming value and does not coerce", () => {
    const schema: JsonSchemaNode = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] }
    expect(v(schema, { n: 3 })).toEqual([])
    // No coercion of any kind: a string where an integer belongs is a violation
    // even though Number("3") works. The validator reports; it never repairs.
    expect(v(schema, { n: "3" })).toEqual(['"value.n" must be an integer'])
  })

  it("distinguishes integer from number (§3.3)", () => {
    expect(v({ type: "integer" }, 3)).toEqual([])
    expect(v({ type: "number" }, 3)).toEqual([])
    expect(v({ type: "integer" }, 3.5)).toEqual(['"value" must be an integer'])
    expect(v({ type: "number" }, 3.5)).toEqual([])
  })

  it("rejects non-JSON numbers — NaN, Infinity and -0 are not JSON (§3.3)", () => {
    for (const bad of [NaN, Infinity, -Infinity, -0]) {
      expect(v({ type: "number" }, bad)).toEqual(['"value" must be a finite JSON number'])
    }
  })

  it("names the path: a nested property and an array element", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    }
    expect(v(schema, { tags: ["a", 1] })).toEqual(['"value.tags[1]" must be a string'])
  })

  it("reports a missing required property by name, and `undefined` counts as missing", () => {
    const schema: JsonSchemaNode = { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    expect(v(schema, {})).toEqual(['missing required property "value.path"'])
    // A present-but-undefined member is missing: the same rule this repo ruled
    // on for `undefined`-valued KEYWORDS (§3.5), applied to values.
    expect(v(schema, { path: undefined })).toEqual(['missing required property "value.path"'])
  })

  it("supports a type ARRAY (§3.4) — subagent/src/tools.ts:77's shape", () => {
    const schema: JsonSchemaNode = { type: ["string", "number"] }
    expect(v(schema, "3")).toEqual([])
    expect(v(schema, 3)).toEqual([])
    expect(v(schema, true)).toEqual(['"value" must be one of "string", "number"'])
    expect(v(schema, {})).toEqual(['"value" must be one of "string", "number"'])
  })

  it("treats an `undefined`-valued keyword as ABSENT (§3.5 — plan-mode/src/index.ts:25's shape)", () => {
    // `{ properties: undefined }` means "no properties declared", so any object
    // conforms — the same rule as W4's F1 (a field CARRYING a value, not a key
    // existing), one level up.
    const schema = { type: "object", properties: undefined, required: undefined } as unknown as JsonSchemaNode
    expect(v(schema, {})).toEqual([])
    expect(v(schema, { anything: 1 })).toEqual([])
  })

  it("supports `additionalProperties` as a boolean AND as a schema (§3.6.1)", () => {
    const closed: JsonSchemaNode = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false }
    expect(v(closed, { a: "x" })).toEqual([])
    expect(v(closed, { a: "x", b: 1 })).toEqual(['"value.b" is not a declared property (additionalProperties: false)'])
    // workflow/src/tool.ts:73's shape: a map of string→string.
    const map: JsonSchemaNode = { type: "object", additionalProperties: { type: "string" } }
    expect(v(map, { any: "x", name: "y" })).toEqual([])
    expect(v(map, { any: 1 })).toEqual(['"value.any" must be a string'])
  })

  it("supports enum, minimum, maximum and maxItems — the three keywords dsh has no support for", () => {
    expect(v({ type: "string", enum: ["a", "b"] }, "a")).toEqual([])
    expect(v({ type: "string", enum: ["a", "b"] }, "c")).toEqual(['"value" must be one of ["a","b"]'])
    expect(v({ type: "number", minimum: 1 }, 0)).toEqual(['"value" must be >= 1'])
    expect(v({ type: "number", maximum: 20 }, 21)).toEqual(['"value" must be <= 20'])
    expect(v({ type: "array", items: { type: "string" }, maxItems: 2 }, ["a", "b", "c"])).toEqual(['"value" must have at most 2 items'])
  })

  it("requires objects and arrays to be LOSSLESS JSON (§3.3)", () => {
    expect(v({ type: "object" }, { fn: () => {} })).toEqual(['"value" must be a lossless JSON object'])
    expect(v({ type: "array" }, [1, , 3] as unknown[])).toEqual(['"value" must be a dense lossless JSON array'])
  })

  it("is TOTAL — never throws, for any value against any schema", () => {
    const schemas: unknown[] = [
      { type: "object" }, { type: "array" }, { type: "string" }, { type: ["string", "number"] },
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", additionalProperties: { type: "string" } }, {},
    ]
    const values: unknown[] = [undefined, null, 0, -0, NaN, "", "x", true, {}, [], { a: 1 }, Object.create(null), new Map()]
    for (const s of schemas) for (const val of values) {
      expect(() => validateJsonSchemaValue(s as JsonSchemaNode, val)).not.toThrow()
    }
  })
})
```

- [ ] **Step 2: 跑它，確認它紅**

Run: `pnpm --filter @i-harness/core-tools exec vitest run test/json-schema.test.ts`

Expected: **紅在 import** —— `json-schema.ts` 還不存在。**這一條的紅就是「東西還不存在」**，與 block ① 的 T1 同一種。

- [ ] **Step 3: 實作**

建立 `packages/core-tools/src/json-schema.ts`。**核心要求（照著寫，不要自由發揮）：**

```ts
// The SUBSET is measured, not copied — spec §3.2. IH's 61 literal declarations
// use exactly these keywords (counts in the spec), and a verbatim port of dsh's
// validator would both reject three constructs IH legitimately writes and lack
// three IH uses. The two subsets contain each other in neither direction.
//
// THE ONE PROPERTY THAT MATTERS: this function is TOTAL. It reports, it never
// throws, and it never coerces — for arbitrary values against arbitrary
// schemas. That is the whole reason it can run on a schema this repo did not
// write (MCP forwards the remote server's schema verbatim, mcp-client/bridge.ts).
export interface JsonSchemaNode {
  type?: string | readonly string[]
  properties?: Record<string, JsonSchemaNode> | undefined
  required?: readonly string[] | undefined
  additionalProperties?: boolean | JsonSchemaNode | undefined
  items?: JsonSchemaNode | undefined
  enum?: readonly unknown[] | undefined
  minimum?: number | undefined
  maximum?: number | undefined
  maxItems?: number | undefined
  description?: string | undefined
}

export function validateJsonSchemaValue(schema: JsonSchemaNode, value: unknown, path = "value"): string[]
```

**每一條規則都要有：**
1. **一個 `undefined` 值的關鍵字等於缺席**（§3.5）—— **讀每一個關鍵字之前先檢查它帶著值**
2. **型別陣列**：值的型別必須是其中之一；訊息 `"<path>" must be one of "a", "b"`
3. **`integer` 與 `number` 分開**；`number` 要求**有限的 JSON 數字**（`-0`／`NaN`／`Infinity` 不是）
4. **`required`**：缺席**或值為 `undefined`** 都算缺
5. **`additionalProperties` 是 `false`** ⇒ 只走已宣告的鍵；**是一個 schema** ⇒ 對每一個未宣告的鍵套它
6. **物件與陣列通過子項之後還要「是無損 JSON」**
7. **路徑語法**照 dsh：根標籤 ＋ `.key` ＋ `[i]`（`"value.tags[1]"`）
8. **不做**：`$ref`／`oneOf`／`anyOf`／`allOf`／`not`／`const`／`format`／`pattern`／`minLength`／`minItems` —— **一個都不做**（普查量到 IH 一次都沒用）

- [ ] **Step 4: 跑測試（綠）**

Run: `pnpm --filter @i-harness/core-tools exec vitest run test/json-schema.test.ts`

Expected: **全綠**。

- [ ] **Step 5: 突變 —— 三個，各自證明一條規則被釘住**

1. 型別陣列改成「只看第一個」 ⇒ **紅**（`type: ["string","number"]` 收到 `3`）
2. `undefined` 值的關鍵字改成「鍵存在就算」 ⇒ **紅**（`properties: undefined` 那一條）
3. `integer` 的檢查拿掉（只驗 `number`） ⇒ **紅**（`3.5` 那一條）

**各還原，跑回綠。**

- [ ] **Step 6: 🔴 修法（複審的 Critical ＋ Important ＋ Low）—— T1 的修正輪**

> **T1 的複審量到**全函式是假的**，而它是可達的。** 這一格是它的修法，**而它同時是 T1 的第一個版本沒有做到的事**。

**(a) CRITICAL —— 遞迴用 JS 呼叫堆疊，而深度可達。**

**量到**（Node v24.15.0，每個資料點一個新行程，值在記憶體裡建）：

| | |
|---|---|
| 驗證器第一次 `RangeError` | **3,600–3,700**（冷）／**~9,500**（JIT 暖機後） |
| **`JSON.parse` 的最大嵌套** | **≥ 1,000,000**（走訪驗證到 100 萬層） |

**決定性的重現**：`{"q":"x","extra":[[[…]]]}`、**4,000 層 = 8,019 bytes** ⇒ **`JSON.parse` 過、驗證器 `RangeError`**。**而 `isLosslessJson`（`:77`）走**整棵** args 樹，不管 schema 宣告了什麼 ⇒ **任何一個 args schema 是 `type:"object"` 的工具都暴露。**

**⇒ 而 `RangeError` 會被重拋 ⇒ 殺掉 turn ⇒ 那正是 spec §1.1／§2 存在的理由所要消滅的失敗模式。**

**修法：把遞迴改寫成**顯式的工作清單**（dsh 的 frame machine）。** 三個遞迴點（`collectViolations`／`collectObjectViolations`，以及 `isLosslessJson` 的兩處）**全部**改成 `const frames: …[]` ＋ `while (frames.length > 0)`。

**⇒ 為什麼不是「加一個深度預算」（那個約 10 行的版本）：**
- **用在 `isLosslessJson` 上，一個**完全無損**的深層值會被報成 `"value" must be a lossless JSON object`** —— 那是一個**捏造的違反**，正是這一塊一路在消滅的形狀
- **用在驗證器上，它把一個**合法**的值變成拒絕**

**而 dsh 的原始碼是那個參考**（它的 `json-schema.ts` 有 `const frames: ValueFrame[]` 與 "without using the JavaScript call stack"，而那個檔案 656 行就是為了這個）。**⇒ 而我的計畫第一版寫「a recursive validator has identical semantics」，那句話錯了** —— **語意相同，而韌性不同**，而那個「房屋規則」是關於**不可信輸入**的。

**(b) IMPORTANT —— 結構化的 `enum` 成員按 JSON 文字比較 ⇒ 鍵序假陽性。**

**量到**：`{enum:[{a:1,b:2}]}` 對 `{b:2,a:1}` ⇒ **誤報**；同鍵序 ⇒ `[]`。

**修法**：成員比較改成**鍵序無關**（遞迴排序鍵後再比，或深層相等）。**而注意**：**dsh 的 enum 是純量**（`JsonSchemaScalar[]`）—— **IH 接受了 dsh 根本不接受的東西**，所以這一條沒有參考可抄。

**(c) LOW —— 物件走訪讀原型鏈。**

**量到**：`{type:"object",properties:{toString:{type:"string"}}}` 對 `{}` ⇒ **誤報**；`{required:["toString"]}` 對 `{}` ⇒ **靜默不報**。**而 `:131` 已經用了 `hasOwnProperty`** —— **不一致在同一個函式裡。**

**修法**：那個函式裡的每一次成員讀取都用**自有屬性**判定。

**(d) 那一條缺席的回歸測試 —— 而它是這個洞沒有被測到的原因。**

現有的「is TOTAL」案例用的是**淺**的值。**加一條**：**在記憶體裡建一個深的巢狀值**（`JSON.stringify` 會先爆，所以**不能用它建**）**並斷言驗證器不拋。**

**突變證明（三個都要）**：把 frame machine 改回遞迴 ⇒ **深層那條必須紅**；把 enum 的比較改回 `JSON.stringify` ⇒ **鍵序那條必須紅**；把 `hasOwnProperty` 拿掉 ⇒ **原型鏈那條必須紅**。

- [ ] **Step 7: Commit（修正輪）**

> **Step 6 的那個提交（`6ee2b314`）已經存在了** —— **修正輪是**新的一個提交**，不 amend。** 上面 (a)–(d) 四件事一起提交，訊息要**指名那個 Critical 與它的量測**。

```bash
git add packages/core-tools/src/json-schema.ts packages/core-tools/test/json-schema.test.ts
git commit -m "fix(core-tools): M5 T4 block 2 T1 review round — the walk uses an explicit frame machine, so totality survives a value JSON.parse accepts"
```

**（T1 的第一個提交是 `feat(core-tools): M5 T4 block 2 — the value layer validates a measured subset, totally`，而那個訊息裡的 "totally" 在修正輪之前是假的。）**

---

### Task 2: 斷言那一層 ＋ 掛進 `register`

**Files:**
- Modify: `packages/core-tools/src/json-schema.ts`（`assertSupportedJsonSchema`）
- Modify: `packages/core-tools/src/index.ts`（`register`）
- Modify: `packages/core-tools/src/index.ts`（`Tool` 型別的標記欄位 —— **T3 用**）
- Test: `packages/core-tools/test/json-schema.test.ts`（assert 的案例）
- Test: `packages/core-tools/test/registry-arg-schema.test.ts`（註冊的案例）

**Interfaces:**
- Consumes: T1 的 `JsonSchemaNode`。
- Produces: `assertSupportedJsonSchema(schema: unknown): asserts schema is JsonSchemaNode` · `Tool.inputSchemaForeign?: true`（**一個寫者（T3）、一個讀者（這裡）**）。

**兩層的分工**：值那一層**忽略**它不認得的關鍵字（那對遠端 schema 是對的）；**斷言那一層拒絕它**（那對 IH 自己的 schema 是對的）。**這個差別是整個設計的負載軸承** —— 只移植值那一層，未知關鍵字會被**靜默忽略**。

- [ ] **Step 1: 寫紅測試**

在 `json-schema.test.ts` 加：

```ts
describe("assertSupportedJsonSchema — the schema layer (spec §3.1)", () => {
  it("accepts every shape this repo actually writes", () => {
    const ok: unknown[] = [
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "array", items: { type: "string" }, maxItems: 10 },
      { type: "number", minimum: 1, maximum: 20 },
      { type: ["string", "number"] },                       // §3.4
      { type: "object", properties: undefined, required: undefined },  // §3.5
      { type: "object", additionalProperties: { type: "string" } },    // §3.6.1
      { type: "object", additionalProperties: false },
      { type: "string", enum: ["a", "b"], description: "d" },
    ]
    for (const s of ok) expect(() => assertSupportedJsonSchema(s)).not.toThrow()
  })

  it("rejects a keyword outside the measured subset, by NAME", () => {
    for (const s of [{ type: "string", format: "date" }, { type: "string", pattern: "^a" }, { type: "array", minItems: 1 }]) {
      expect(() => assertSupportedJsonSchema(s)).toThrow(/not a supported keyword/)
    }
  })

  it("is TOTAL on garbage", () => {
    for (const s of [undefined, null, 0, "x", [] as unknown[]]) {
      expect(() => assertSupportedJsonSchema(s)).toThrow()
      expect(() => assertSupportedJsonSchema(s)).not.toThrow(TypeError)
    }
  })
})

describe("createToolRegistry.register — the assertion is a local contract", () => {
  it("refuses to register a LOCAL tool whose schema is outside the subset", () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    expect(() => tools.register({
      name: "bad", description: "", inputSchema: { type: "string", format: "date" }, execute: async () => ({}),
    })).toThrow(/not a supported keyword/)
  })

  it("registers a FOREIGN schema that is outside the subset — an MCP server's dialect is not ours", () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    expect(() => tools.register({
      name: "remote", description: "", inputSchemaForeign: true,
      inputSchema: { type: "object", properties: { d: { type: "string", format: "date" } } },
      execute: async () => ({}),
    })).not.toThrow()
    expect(tools.get("remote")).toBeDefined()
  })
})
```

（`createContext` 從 `@i-harness/core-plugin`，`createToolRegistry` 從 `../src/index.ts` —— **照該套件既有的測試檔的 import 形狀**。）

- [ ] **Step 2: 跑它，確認它紅**

Expected: **紅在 `assertSupportedJsonSchema` 不存在**，而 foreign 那條會因為**沒有那個欄位**而紅在型別。

- [ ] **Step 3: 實作**

`json-schema.ts` 加 `assertSupportedJsonSchema`：走整個 schema 樹，**收集每一個違反**，最後丟**一個** `JsonSchemaError`（`code = "UNSUPPORTED_SCHEMA"`，`readonly violations: string[]`）。**未知關鍵字要指名它**（`… is not a supported keyword (subset: …)`）。

`core-tools/src/index.ts`：
- `Tool` 加選用欄位（**一個寫者、一個讀者，所以它不是幽靈欄位**）：

```ts
  // spec §3.8: the schema was written by someone else (an MCP server forwards
  // its own verbatim). The ASSERT layer governs this repo's own declarations;
  // a remote server's dialect is not ours to reject. Additive, and read in
  // exactly one place: `register`.
  inputSchemaForeign?: true
```

- `register`（`git grep -n "function register" packages/core-tools/src/index.ts`）：

```ts
  function register(tool: Tool): void {
    if (tools.has(tool.name)) throw new Error(`duplicate tool registration: ${tool.name}`)
    // The assertion is IH's contract with itself — see Tool.inputSchemaForeign.
    if (tool.inputSchemaForeign !== true) assertSupportedJsonSchema(tool.inputSchema)
    tools.set(tool.name, tool)
  }
```

- **`INVALID_ARGS` 的型別住在這裡**（T4 用）：

```ts
/** spec §3.7.1: a TYPED disposition. `prepare` throws it; exactly this type is
 *  converted to a soft failure by the scheduler. The vocabulary stays "typed
 *  dispositions", never a list of messages. */
export const INVALID_ARGS = "INVALID_ARGS"
export class ToolArgsError extends Error {
  readonly code = INVALID_ARGS
  constructor(readonly violations: readonly string[]) {
    super(`invalid arguments: ${violations.join("; ")}`)
    this.name = "ToolArgsError"
  }
}
```

- [ ] **Step 4: 跑測試（綠）**

Run: `pnpm --filter @i-harness/core-tools exec vitest run`
Run: `pnpm --filter @i-harness/core-agent exec vitest run`

Expected: **兩者全綠**。**若任何既有測試因為新的斷言而紅，停手回報** —— 那代表有一個既有的宣告不在子集裡，而普查說沒有（**但普查是這份計畫寫的時候跑的**）。

- [ ] **Step 5: 全套掃一次 —— 有沒有別的套件在註冊不合子集的 schema**

```bash
pnpm -r --no-bail test 2>&1 | tee /tmp/b2.log
sed 's/\x1b\[[0-9;]*m//g' /tmp/b2.log | grep -cE " test:  Test Files "   # 母體必須是 66
```

Expected: **全綠、母體 66**。**若某個套件因為「not a supported keyword」而紅，停手回報並把那一個宣告記下來** —— **那是一個普查沒有涵蓋到的宣告**（普查只掃 `packages/*/src` 與 `apps/cli/src`，**不含任何測試 fixture**）。

- [ ] **Step 6: 突變 —— 證明斷言真的在拒絕**

把 `assertSupportedJsonSchema` 的未知關鍵字分支**註解掉** ⇒ 那個「rejects a keyword outside the measured subset」測試必須紅。**還原。**

- [ ] **Step 7: Commit**

```bash
git add packages/core-tools/src/json-schema.ts packages/core-tools/src/index.ts packages/core-tools/test/json-schema.test.ts packages/core-tools/test/registry-arg-schema.test.ts
git commit -m "feat(core-tools): M5 T4 block 2 — the schema layer rejects what this repo would not write, and only for this repo"
```

---

### Task 3: MCP 的標記 —— 一個寫者、一個讀者

**Files:**
- Modify: `packages/mcp-client/src/bridge.ts`
- Test: `packages/mcp-client/test/`（**照該套件既有的測試檔的形狀**）

**Interfaces:**
- Consumes: T2 的 `Tool.inputSchemaForeign`。
- Produces: 無新 export。

**這是 §3.8 的收尾**：`bridge.ts:20` 是**唯一**把遠端 schema 裝進 `Tool` 的地方，所以它也是**唯一**該設那個標記的地方。

- [ ] **Step 1: 寫測試**

**先讀 `packages/mcp-client/test/` 既有的 bridge 測試**，用它的 fixture 形狀。測試要斷言：**一個用了 IH 子集之外的關鍵字的遠端 schema，註冊成功**（而**值那一層仍然檢查它認得的那些**）。

- [ ] **Step 2: 跑它，確認它紅**（foreign 欄位還沒設 ⇒ 斷言拒了它）

- [ ] **Step 3: 設標記**

`packages/mcp-client/src/bridge.ts:20` 附近：

```ts
    // spec §3.8: this schema came from the REMOTE server verbatim. It is not
    // this repo's contract, so the assertion layer does not govern it — the
    // value layer still checks every keyword it recognises.
    inputSchemaForeign: true,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
```

- [ ] **Step 4: 跑（綠）**

Run: `pnpm --filter @i-harness/mcp-client exec vitest run`

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-client/src/bridge.ts packages/mcp-client/test/
git commit -m "feat(mcp-client): M5 T4 block 2 — a remote schema is flagged as foreign, so the local assertion does not govern it"
```

---

### Task 4: `prepare` ＋ `INVALID_ARGS` → block ① 的軟失敗

**Files:**
- Modify: `packages/core-tools/src/index.ts`（`prepare`）
- Modify: `packages/core-agent/src/execute-tool-calls.ts`（把 `INVALID_ARGS` 轉成軟失敗）
- Test: `packages/core-agent/test/execute-tool-calls.test.ts`
- Test: `packages/core-tools/test/`（`prepare` 的案例）

**Interfaces:**
- Consumes: T2 的 `ToolArgsError`／`INVALID_ARGS`。
- Produces: 無新 export。

**這是 ① 與 ② 的黏合點**，也是這一塊唯一改到 block ① 檔案的地方。

- [ ] **Step 1: 寫紅測試（`core-agent`）**

```ts
  it("a malformed argument call is SOFT — the model sees which field, and the turn continues", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    tools.register({
      name: "typed", description: "", isConcurrencySafe: true,
      inputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      execute: async () => ({ ok: true }),
    })
    await executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "typed", args: { n: "3" } }], { maxParallel: 10 })
    const results = session.events.filter((e) => e.type === "tool/result") as { output: unknown }[]
    expect(results).toHaveLength(1)
    expect(results[0]!.output).toEqual({ error: expect.stringContaining('"value.n" must be an integer'), code: TOOL_FAILED })
  })

  it("BOUNDARY: a GUARD refusal is still loud next to the soft argument refusal (spec §3.7.1)", async () => {
    // The vocabulary is TYPED dispositions, not a list of messages: only
    // ToolArgsError is converted. A guard veto through the same `prepare`
    // must still kill the turn.
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    ctx.on("tools/pre-execute", () => ({ kind: "deny", reason: "policy" }))
    tools.register({ name: "t2", description: "", inputSchema: { type: "object" }, execute: async () => ({}) })
    await expect(
      executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "t2", args: {} }], { maxParallel: 10 }),
    ).rejects.toThrow(/denied: policy/)
  })
```

- [ ] **Step 2: 跑它，確認它紅**

Expected: 第一條**紅在 promise 拒絕**（`prepare` 還沒有驗證，所以會走進工具本體）；第二條**綠**（那是既有的行為 —— **它是控制組**）。

- [ ] **Step 3: 實作**

`core-tools/src/index.ts` 的 `prepare`：**在 `tools.get` 成功之後、政策瀑布之前**（`git grep -n "unknown tool:" packages/core-tools/src/index.ts`）：

```ts
    const tool = tools.get(call.name)
    if (!tool) throw new Error(`unknown tool: ${call.name}`)

    // spec §3.7: BEFORE the policy layers, so a malformed call never reaches an
    // approval prompt — nobody should be asked to approve garbage. The refusal
    // is a TYPED disposition (§3.7.1), read by name at exactly one place.
    const violations = validateJsonSchemaValue(tool.inputSchema as JsonSchemaNode, call.args)
    if (violations.length > 0) throw new ToolArgsError(violations)
```

`execute-tool-calls.ts` 的 `startCall`：`tools.prepare` 的丟出今天直接流到外層 catch（⇒ 大聲）。**改成：具型的才轉軟。**

```ts
    let prepared
    try {
      prepared = await tools.prepare(...)
    } catch (err) {
      if (err instanceof ToolArgsError) {
        // A TYPED disposition, checked by name — never a message list. The
        // model CAN fix this one, so it is soft; every other `prepare`
        // refusal (guard / approval / guardian / unknown tool) stays loud.
        slots[index] = { name: call.name, callId: call.callId, synthetic: true,
          output: { error: (err as Error).message, code: TOOL_FAILED } }
        failures.set(index, err)
        if (!hasFailed) { hasFailed = true; firstError = err }
        batchAbort.abort()
        return
      }
      throw err
    }
    startedUpTo = index + 1
```

> **⚠ 三個細節，每一個都對應 block ① 的一個裁定的：**
> - **`failures.set` 要在前面**（block ① 的洞 2 第 3 次：處理器裡任何會丟的東西都必須在記錄**之後**）
> - **`hasFailed` 與 `firstError` 都要設**（洞 3：一個變數不能同時當旗標與值）
> - **`batchAbort.abort()` 要照跑**（`4c85a04` 的取消語意）
>
> **⇒ 而這個 `return` 讓那一格**不經過 `startCall` 的其餘部分** —— 沒有 `tool/dispatch`、沒有 `tool/start` 遙測**。**那是對的**：那個工具**從來沒有被派送**，而那正是 `tool/dispatch` 存在的理由（M4）。

**⚠ 而這裡有一個語意上的洞，它是在寫這份計畫的自我複核時抓到的，不是施工時：**

**`startedUpTo` 沒有前進**（正確 —— 那個呼叫真的從未開始）。**所以它落在「從未開始」的範圍 `[startedUpTo, batch.length)` 裡** —— 而**那個迴圈會替它再append 一筆結果** ⇒ **同一個 `callId` 兩筆 `tool/result`。**

**⇒ 修法在**那個迴圈**裡，而且它同時修 abort 分支的同一段**：兩個「從未開始」的迴圈都要跳過已經填好的格子。

```ts
    for (let i = startedUpTo; i < batch.length; i += 1) {
      // A call can be in the never-started range AND already have a result:
      // a malformed-argument refusal fills its slot and returns before
      // `startedUpTo` advances (it truly never started). Appending again would
      // write TWO results for one callId — a `tool_use` answered twice.
      if (slots[i] !== undefined) continue
      const call = batch[i]!
      append(session, { /* … */ })
    }
```

**⇒ 而那兩處的「已填」判定要用 `slots[i] !== undefined`** —— **這裡是安全的那一種**：`slots[i]` 的值是一個**物件或 `undefined`**，而**沒有「填了一個 `undefined`」這個狀態**（`assign` 的是 `Slot | SyntheticSlot`，兩者都是物件）。**但這句話要寫在註解裡**，因為這個檔案在別的地方撞過三次「旗標與值共用一個變數」。

**回歸測試**：**一個畸形參數的呼叫，必須恰好一筆 `tool/result`** —— 而**在 abort 的情形下也是**。**把那個 `continue` 拿掉 ⇒ 兩條都必須紅。**

- [ ] **Step 4: 跑測試（綠）**

Run: `pnpm --filter @i-harness/core-agent exec vitest run`
Run: `pnpm --filter @i-harness/core-tools exec vitest run`

- [ ] **Step 5: 突變 —— 兩個**

1. 把 `err instanceof ToolArgsError` 改成 `true`（什麼都軟） ⇒ **第二條 boundary 必須紅**
2. 把那個 if 拿掉（什麼都大聲） ⇒ **第一條必須紅**

**各還原。**

- [ ] **Step 6: 兩步閘門**

```bash
pnpm -r --no-bail test 2>&1 | tee /tmp/b2final.log
sed 's/\x1b\[[0-9;]*m//g' /tmp/b2final.log | grep -cE " test:  Test Files "   # 66
pnpm -r typecheck
node scripts/audit/check-reachability.mjs --gate
```

Expected: 母體 **66** · 全綠 · typecheck 0 · **`gate PASS`**（新 export 由 block ① 的 allowlist 機制處理，或在 `prepare`／`register` 裡取得消費者 —— **讀數如實回報**）。

- [ ] **Step 7: Commit**

```bash
git add packages/core-tools/src/index.ts packages/core-agent/src/execute-tool-calls.ts packages/core-agent/test/execute-tool-calls.test.ts
git commit -m "feat(core-tools,core-agent): M5 T4 block 2 — a malformed argument call is a typed disposition, and only it is soft"
```

---

## Self-Review

**1 · Spec coverage**

| spec | 在哪 |
|---|---|
| §3.1 兩層的分工 | T1（值）＋ T2（斷言） |
| §3.2 十個關鍵字 | T1 Step 3 的規則清單 |
| §3.3 三個沿用的 dsh 決定（`string[]`／`integer` 分開／無損 JSON） | T1 Step 3 的 3 與 6 |
| §3.4 型別陣列 | T1 |
| §3.5 `undefined` 值的關鍵字等於缺席 | T1 |
| **§3.6.1（後補）`additionalProperties` 接受 schema** | **T1** |
| §3.7 強制點（`tools.get` 之後、政策之前） | **T4** |
| §3.7.1 具型的拒絕 | **T2（型別）＋ T4（轉換）** |
| §3.8 MCP | **T2（讀者）＋ T3（寫者）** |
| §9 ④ 三個既有宣告 | **一個都不需要遷移**（§3.6.1 的結果）—— T2 Step 5 是那個主張的檢查 |

**2 · Placeholder scan** —— 無 TBD。**T3 是描述性的**（它要先讀 `mcp-client` 既有的 bridge 測試再寫），而它**明說自己是**，並說明理由（替一個沒讀過的 fixture 編測試碼比讓實作者去讀更糟）。

**3 · Type consistency** —— `JsonSchemaNode`／`validateJsonSchemaValue`／`assertSupportedJsonSchema`／`ToolArgsError`／`INVALID_ARGS`／`inputSchemaForeign` 在定義處與使用處拼字一致。

**4 · 明說的缺口** —— **spec §7 的「用 `deriveMessages` 端到端斷言」那一列仍然不在**（它住在 `core-session`）。**block ③ 或一個獨立小項。**
