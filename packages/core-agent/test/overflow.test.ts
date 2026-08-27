import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages } from "@i-harness/core-session"
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
    // resetWindow(true) + resetRetainLast 20 → 可見表面保留最後 17 條 prefill
    // + "work" → 18*5 = 90 ≤ 100 → 繼續（不 throw）。
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
    expect(session.events.some((e) => e.type === "compaction/end")).toBe(false) // 純 reset，無摘要
    // 修復輪（Ruling 4）：durable log 不截斷——全部 97 條 user/message 都留在 log
    // （96 條 prefill + work），恢復重放 ⇒ 無資料遺失。
    expect(session.events.filter((e) => e.type === "user/message")).toHaveLength(97)
    // marker 攜帶被移除的 seq 清單：seq 0..78（可移除的最舊 79 條）
    const marker = session.events.find((e) => e.type === "compaction/reset") as unknown as { removedSeqs?: number[] }
    expect(marker.removedSeqs).toEqual(Array.from({ length: 79 }, (_, i) => i))
    // 模型可見表面＝shadow 後投影：保留尾 17 條 "hi" + work + 新回覆，
    // 與舊「截斷」語義的可見結果等價。
    const dm = deriveMessages(session)
    expect(dm).toHaveLength(19)
    expect(dm.at(-1)).toEqual({ role: "assistant", content: "nope" })
    expect(dm[0]).toEqual({ role: "user", content: "hi" }) // retained tail starts here
  })

  // Minor-5 coverage (fix round 1): layer-2 runs but the RETAINED TAIL itself is
  // oversized (resetRetainLast keeps the giant current message) → still over
  // budget → the ladder falls through to layer-3 fail-closed.
  it("layer 2 insufficient: reset runs (marker recorded) but oversized tail stays over budget → prompt_too_long", async () => {
    const session = createSession()
    // 小型舊歷史（seq-keyed、可被 reset 移除）；當前訊息本身巨大（604 tokens）
    // ——resetRetainLast 2 必然把它留在尾部 → reset 後仍在 budget 之上。
    for (let i = 0; i < 5; i++) append(session, { type: "user/message", text: "hi" })
    const agent = createAgent(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("never"),
      systemPrompt: "",
      maxTurns: 10,
      compact: { contextWindow: 200, thresholdRatio: 0.5, retainTokens: 100_000, maxTokens: 16 },
      budget: { contextWindow: 200, reserveRatio: 0.5, resetWindow: true, resetRetainLast: 2 },
    } as never)
    await expect(agent.run("z".repeat(2400), undefined)).rejects.toThrow(/prompt_too_long/)
    // reset 確實執行過：marker 已寫入且攜帶 removedSeqs——retainRetainLast 2 只
    // 保留 {seq6 巨型訊息, seq7 step/start}，故 seq0..5（含 turn/start）全被移除
    const marker = session.events.find((e) => e.type === "compaction/reset") as unknown as { removedSeqs?: number[] }
    expect(marker.removedSeqs).toEqual([0, 1, 2, 3, 4, 5])
    expect(session.events.some((e) => e.type === "compaction/end")).toBe(false)
    // Ruling 4 不變式：durability——失敗路徑也不刪原始事件
    expect(session.events.filter((e) => e.type === "user/message")).toHaveLength(6)
  })

  // Minor-5 coverage (fix round 1): `budget` WITHOUT any `compact` config — no
  // engine exists, so the ladder has no layers 1/2 and must fail closed
  // directly on overflow.
  it("budget without compact config fails closed directly (prompt_too_long, no compaction attempted)", async () => {
    const session = createSession()
    // 6 × (ceil(150/4)+4) = 252 tokens > floor(200*1.0)=200 → overflow at the first boundary
    for (let i = 0; i < 6; i++) append(session, { type: "user/message", text: "y".repeat(150) })
    const agent = createAgent(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("no"),
      systemPrompt: "",
      maxTurns: 10,
      // NO `compact` config → no engine → straight to fail-closed
      budget: { contextWindow: 200, reserveRatio: 1 },
    } as never)
    await expect(agent.run("work", undefined)).rejects.toThrow(/prompt_too_long/)
    // 沒有 engine → 完全沒有 compaction 動作寫入 log
    expect(session.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
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

describe("budget config validation (fail-loud at creation, Ruling 8a)", () => {
  // FINAL REVIEW (Ruling 8a): `checkBudget` validates reserveRatio but never
  // contextWindow — a NaN contextWindow made every comparison
  // `tokens > NaN === false` → state "ok" forever → the whole
  // compact→reset→fail-closed ladder silently dead (fail-closed violation).
  // Validation must fail loud at agent creation instead.
  it("throws at creation when budget.contextWindow is NaN", () => {
    const session = createSession()
    expect(() =>
      createAgent(ctx, {
        session,
        tools: createEmptyRegistry(),
        model: makeModel("x"),
        systemPrompt: "",
        budget: { contextWindow: Number.NaN },
      } as never),
    ).toThrow(/contextWindow/)
  })

  it("throws at creation when budget.contextWindow is 0", () => {
    const session = createSession()
    expect(() =>
      createAgent(ctx, {
        session,
        tools: createEmptyRegistry(),
        model: makeModel("x"),
        systemPrompt: "",
        budget: { contextWindow: 0 },
      } as never),
    ).toThrow(/contextWindow/)
  })

  it("throws at creation when resetRetainLast is provided but not a non-negative integer", () => {
    const session = createSession()
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() =>
        createAgent(ctx, {
          session,
          tools: createEmptyRegistry(),
          model: makeModel("x"),
          systemPrompt: "",
          budget: { contextWindow: 200, resetRetainLast: bad },
        } as never),
      ).toThrow(/resetRetainLast/)
    }
  })

  it("accepts a valid budget config and runs normally", async () => {
    const session = createSession()
    const agent = createAgent(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("ok"),
      systemPrompt: "",
      budget: { contextWindow: 10_000, resetRetainLast: 20 },
    } as never)
    const r = await agent.run("work", undefined)
    expect(r.finalText).toBe("ok")
    // Valid budget but tiny usage → no ladder action ever fired.
    expect(session.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
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
