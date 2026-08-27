import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { createAgent } from "../src/index.ts"

// 用真實 compaction engine（M11）+ 真實 token-meter budget（M20）+ 新 resetWindow
// 測試三層 overflow 觸發。summarizer 用 spy model 直接回傳簡短摘要。
//
// NOTE（M20 實測修正）：brief 原 payload（單一 2400-char user/message）無法觸發
// 各層——(a) selectShadowableRange 的尾巴走訪會先行保留那條單一事件（retainTokens 50
// 無法 shadow 600-token 事件）→ compact 永遠 no-op；(b) 4 條事件 < resetRetainLast 20
// → reset 永遠 no-op。這裡保留 brief 的 FIXED 設定（thresholdRatio 0.5/0.95、
// resetRetainLast 20、resetWindow false/true），但把 prefill 拆成多條小事件，
// 使三層各自真的被觸發。
function makeModel(text: string) {
  // NOTE（M20 實測修正）：brief 的 `stream: async () => (async function* ...)()`
  // 回傳 Promise（async arrow 包裝）——`for await...of` 需要 async iterable，
  // 不會解包 Promise → 任何三層路徑都在 consumer 處 TypeError。改為標準
  // async generator method（與 agent.test.ts / engine.test.ts 的 mock 一致）。
  return {
    async *stream() {
      yield { type: "text/chunk", text } as never
      yield { type: "end" } as never
    },
  }
}
const ctx = { emit: async () => undefined, on: () => {}, waterfall: async (_e: string, n: () => unknown) => n(), checkGuards: () => undefined, resolveAncestorDecision: () => undefined, services: { get: () => undefined }, plugin: () => {} } as never

describe("overflow budget enforcement (compact→reset→fail-closed)", () => {
  it("layer 1: compact then continues when under budget after compact", async () => {
    const session = createSession()
    // budget = contextWindow(200) * reserveRatio(0.5) = 100；prefill 3×200 chars
    // ≈ 3*(50+4) = 162 tokens > 100 → overflow。compact thresholdRatio 0.95 →
    // threshold 190 → maybeCompact no-op（163+5 < 190），所以是 enforceBudget 的
    // layer-1 compact（retainTokens 50）把最舊 2 條 shadow 掉 → 摘要 6 + 保留 54
    // + "work" 5 = 65 tokens < 100 → 繼續。
    for (let i = 0; i < 3; i++) append(session, { type: "user/message", text: "x".repeat(200) })
    const agent = createAgent(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("answer"),
      systemPrompt: "",
      maxTurns: 10,
      compact: { contextWindow: 200, thresholdRatio: 0.95, retainTokens: 50, maxTokens: 16 },
      budget: { contextWindow: 200, reserveRatio: 0.5 },
    } as never)
    const r = await agent.run("work", undefined)
    expect(r.finalText).toBe("answer")
    // verify: compaction/end 已寫入（layer-1 compact 被觸發）
    expect(session.events.some((e) => e.type === "compaction/end")).toBe(true)
    // layer 1 成功 → 不該有 compaction/reset
    expect(session.events.some((e) => e.type === "compaction/reset")).toBe(false)
  })

  it("layer 2: reset when compact cannot bring it under budget", async () => {
    const session = createSession()
    // 96 條 "hi"（每條 ceil(2/4)+4 = 5 tokens）→ 96*5 + "work" 5 = 485 > 100 →
    // overflow。retainTokens 100_000 → 尾巴累計永不達標 → compact no-op。
    // resetWindow(true) + resetRetainLast 20 → 保留最後 17 條 prefill + turn/start
    // + "work" + step/start → 17*5 + 5 = 90 ≤ 100 → 繼續（不 throw）。
    for (let i = 0; i < 96; i++) append(session, { type: "user/message", text: "hi" })
    const agent = createAgent(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("nope"),
      systemPrompt: "",
      maxTurns: 10,
      compact: { contextWindow: 200, thresholdRatio: 0.5, retainTokens: 100_000, maxTokens: 16 },
      budget: { contextWindow: 200, reserveRatio: 0.5, resetWindow: true, resetRetainLast: 20 },
    } as never)
    // reset 保留 20 條（含 compaction/reset marker）→ 不 throw
    const r = await agent.run("work", undefined)
    expect(r.finalText).toBe("nope")
    // verify: resetWindow 寫入（compaction/reset 事件，非 compaction/end）
    expect(session.events.some((e) => e.type === "compaction/reset")).toBe(true)
    // 舊歷史被截斷：整段 log 只有保留的尾巴 + marker
    expect(session.events.filter((e) => e.type === "user/message")).toHaveLength(18)
  })

  it("layer 3: fail-closed when reset disabled or insufficient", async () => {
    const session = createSession()
    for (let i = 0; i < 3; i++) append(session, { type: "user/message", text: "z".repeat(200) })
    const agent = createAgent(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("nope"),
      systemPrompt: "",
      maxTurns: 10,
      compact: { contextWindow: 200, thresholdRatio: 0.95, retainTokens: 100_000, maxTokens: 16 },
      // budget = 1 token（floor(1*1.0)）→ 不可能 compact/reset 到 1 以下；
      // resetWindow false → 跳過 layer 2 → fail-closed
      budget: { contextWindow: 1, reserveRatio: 1.0, resetWindow: false },
    } as never)
    await expect(agent.run("work", undefined)).rejects.toThrow(/prompt_too_long/)
  })
})

// 測試 helper（此處的工具永不觸發 dispatch——模型只回 text/chunk）
function createEmptyRegistry() {
  return {
    schemas: () => [], prepare: async () => ({ exec: {}, call: { name: "", args: {} }, tool: {} as never }),
    dispatch: async () => ({}), finalize: async (_p: unknown, out: unknown) => ({ name: "", output: out }),
    execute: async () => ({ name: "", output: "" }),
    register: () => {}, get: () => undefined, unregister: () => {},
    genToolCatalog: () => [], verifyToolCatalog: () => {},
  } as never
}
