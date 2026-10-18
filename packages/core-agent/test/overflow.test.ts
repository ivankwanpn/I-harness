import { prepareTextFixture, completeCheckpoint } from '../../compaction/test/fixtures/checkpoint.ts'
import type { LLMRequest } from '@i-harness/llm-seam'
import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { createAgentWithSummary } from './fixtures/agent.ts'

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
  return { prepare: prepareTextFixture,
    async *stream(request: LLMRequest) {
      const summary = String(request.messages.at(-1)?.content).includes('You are now acting as a compaction engine')
      yield { type: "text/chunk", text: summary ? completeCheckpoint(text) : text } as never
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
    for (let i = 0; i < 3; i++) append(session, { type: "user/message", text: "x".repeat(800) })
    const agent = createAgentWithSummary(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("answer"),
      systemPrompt: "",
      maxTurns: 10,
      // M34 ⑦c note: maxTokens 16 caps the summary at ~64 chars — the default
      // 500-char minSummaryChars floor would make this tiny-window compact
      // always degenerate, so the floor is opted out explicitly (this suite
      // measures the budget ladder, not the summary floor).
      // A complete framed fixture needs 400 retained code units; the former
      // 64-unit ceiling could hold only its old unframed word.
      compact: { contextWindow: 6000, thresholdRatio: 0.15, retainTokens: 50, maxTokens: 100, minSummaryChars: 1 },
      budget: { contextWindow: 6000, reserveRatio: 0.9 },
    } as never)
    const r = await agent.run("work", undefined)
    expect(r.finalText).toBe("answer")
    // verify: compaction/end 已寫入（layer-1 compact 被觸發）
    expect(session.events.some((e) => e.type === "compaction/replacement")).toBe(true)
    // layer 1 成功 → 不該有 compaction/reset
    expect(session.events.some((e) => e.type === "compaction/reset")).toBe(false)
  })

  it("refuses an over-window surface without silently resetting its history", async () => {
    const session = createSession()
    for (let i = 0; i < 96; i++) append(session, { type: "user/message", text: "hi" })
    const agent = createAgentWithSummary(ctx, { session, tools: createEmptyRegistry(), model: makeModel("never"), systemPrompt: "",
      compact: { contextWindow: 200, retainTokens: 100000 }, budget: { contextWindow: 200, reserveRatio: .5, resetWindow: true } })
    await expect(agent.run("work")).rejects.toThrow(/prompt_too_long/)
    expect(session.events.some(event => event.type === "compaction/reset")).toBe(false)
    expect(session.events.filter(event => event.type === "user/message")).toHaveLength(97)
  })

  // Minor-5 coverage (fix round 1): layer-2 runs but the RETAINED TAIL itself is
  // oversized (resetRetainLast keeps the giant current message) → still over
  // budget → the ladder falls through to layer-3 fail-closed.
  it("an oversized current input is refused without a blind tail reset", async () => {
    const session = createSession()
    // 小型舊歷史（seq-keyed、可被 reset 移除）；當前訊息本身巨大（604 tokens）
    // ——resetRetainLast 2 必然把它留在尾部 → reset 後仍在 budget 之上。
    for (let i = 0; i < 5; i++) append(session, { type: "user/message", text: "hi" })
    const agent = createAgentWithSummary(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("never"),
      systemPrompt: "fixed system ".repeat(30),
      maxTurns: 10,
      compact: { contextWindow: 200, thresholdRatio: 0.5, retainTokens: 100_000, maxTokens: 16 },
      budget: { contextWindow: 200, reserveRatio: 0.5, resetWindow: true, resetRetainLast: 2 },
    } as never)
    await expect(agent.run("z".repeat(2400), undefined)).rejects.toThrow(/prompt_too_long/)
    expect(session.events.some(event => event.type === "compaction/reset")).toBe(false)
    expect(session.events.some((e) => e.type === "compaction/replacement")).toBe(false)
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
    const agent = createAgentWithSummary(ctx, {
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
    const agent = createAgentWithSummary(ctx, {
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

  // M33 §3.1: counting completeness — AgentBudgetConfig.overheadTokens is
  // added to the checkBudget measurement at the budget call site.
  it("the actual fixed system surface pushes an under-budget history to fail-closed", async () => {
    const session = createSession()
    for (let i = 0; i < 2; i++) append(session, { type: "user/message", text: "x".repeat(2000) }) // ~54 tokens each
    const agent = createAgentWithSummary(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("never"),
      systemPrompt: "fixed system ".repeat(30),
      maxTurns: 10,
      // budget = floor(200*1) = 200; visible ≈113 → ok without overhead,
      // 213 > 200 with overhead 100 (the system prompt / tool schemas charge)
      budget: { contextWindow: 200, reserveRatio: 1, overheadTokens: 100 },
    } as never)
    await expect(agent.run("work", undefined)).rejects.toThrow(/prompt_too_long/)
  })

  it("the same session stays under budget without overheadTokens (M33 counting)", async () => {
    const session = createSession()
    for (let i = 0; i < 2; i++) append(session, { type: "user/message", text: "x".repeat(200) })
    const agent = createAgentWithSummary(ctx, {
      session,
      tools: createEmptyRegistry(),
      model: makeModel("ok"),
      systemPrompt: "",
      maxTurns: 10,
      budget: { contextWindow: 200, reserveRatio: 1 },
    } as never)
    const r = await agent.run("work", undefined)
    expect(r.finalText).toBe("ok")
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
      createAgentWithSummary(ctx, {
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
      createAgentWithSummary(ctx, {
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
        createAgentWithSummary(ctx, {
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
    const agent = createAgentWithSummary(ctx, {
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

describe("the summarizer inherits the main request's shape (M5/D2)", () => {
  it("a real compaction sends the SAME system prompt and tools as the turn request", async () => {
    // The failure mode this pins is SILENT: if the agent forgets to hand the
    // engine the request shape, compaction still succeeds, still writes a
    // summary, and nothing anywhere reports a problem — the only symptom is that
    // the whole conversation is re-read at full price, forever. So the assertion
    // is on the wire, not on the outcome.
    const session = createSession()
    for (let i = 0; i < 3; i++) append(session, { type: "user/message", text: "x".repeat(800) })
    const seen: Array<{ systemPrompt: string; tools: number; lastRole: string }> = []
    const model = { prepare: prepareTextFixture,
      async *stream(req: { systemPrompt: string; tools: unknown[]; messages: Array<{ role: string }> }) {
        seen.push({ systemPrompt: req.systemPrompt, tools: req.tools.length, lastRole: req.messages.at(-1)?.role ?? "" })
        yield { type: "text/chunk", text: completeCheckpoint("answer") } as never
        yield { type: "end" } as never
      },
    }
    // A registry that actually REPORTS one schema — `createEmptyRegistry()` is a
    // stub whose schemas() is `() => []`, so a registration on it is a no-op and
    // both requests would show 0 tools, passing an assertion that proves nothing.
    const tools = {
      ...(createEmptyRegistry() as Record<string, unknown>),
      schemas: () => [{ name: "read", description: "d", inputSchema: {}, exposure: "direct" }],
    } as never
    const agent = createAgentWithSummary(ctx, {
      session,
      tools,
      model,
      systemPrompt: "SYS-PROMPT",
      maxTurns: 10,
      compact: { contextWindow: 6000, thresholdRatio: 0.15, retainTokens: 50, maxTokens: 100, minSummaryChars: 1 },
      budget: { contextWindow: 6000, reserveRatio: 0.9 },
    } as never)
    await agent.run("work", undefined)
    expect(session.events.some((e) => e.type === "compaction/replacement")).toBe(true)

    // Every call — the summarizer's and the turn's — carries the shape. Before
    // D2 the summarizer's had `systemPrompt: ""` and `tools: 0`.
    expect(seen.length).toBeGreaterThan(1)
    for (const req of seen) {
      expect(req.systemPrompt).toBe("SYS-PROMPT")
      expect(req.tools).toBe(1)
    }
  })
})

// M73 fix round 1 (finding 2): core-agent is the hop that hands the RESOLVED
// cap to the compaction engine (the `createCompactionEngine` call in
// `src/index.ts`). Nothing else witnesses it — the compaction package's own
// cases build the engine directly, so they pin the engine's half and not the
// forwarding that feeds it, and deleting that single spread restores this
// milestone's defect (the summarizer's request leaving with no cap at all,
// hence anthropic's 128k fallback unclamped) on the only route production
// takes — through `createAgent`.
describe("the compaction engine gets the agent's resolved cap (M73)", () => {
  it("the summarizer's own request carries it, clamped against the window", async () => {
    const session = createSession()
    for (let i = 0; i < 3; i++) append(session, { type: "user/message", text: "x".repeat(200) })
    const requests: Array<{ maxOutputTokens?: number }> = []
    const model = { prepare: prepareTextFixture,
      async *stream(req: { maxOutputTokens?: number }) {
        requests.push({ maxOutputTokens: req.maxOutputTokens })
        yield { type: "text/chunk", text: completeCheckpoint("answer") } as never
        yield { type: "end" } as never
      },
    }
    const agent = createAgentWithSummary(ctx, {
      session,
      tools: createEmptyRegistry(),
      model,
      systemPrompt: "SYS-PROMPT",
      maxTurns: 10,
      // The session's resolved cap (M72 Ⅱ's chain value) …
      maxOutputTokens: 50_000,
      // … with a window small enough that the clamp MUST shrink it: llm-seam's
      // `clampOutputCap` returns the value untouched when the window is missing
      // or when the input leaves room, so a cap LARGER than the window is the
      // one shape that can only have come out of the clamp.
      compact: { contextWindow: 100_000, maxTokens: 100, minSummaryChars: 1 },
    } as never)
    // The MANUAL path: `compact()` summarizes unconditionally (no threshold
    // gate) and makes exactly ONE model call — the summarizer's. So the single
    // recorded request is identifiable without guessing.
    const result = await agent.compact!()
    expect(result.compacted).toBe(true)
    expect(requests).toHaveLength(1)
    // `toBeLessThan` also reddens on `undefined`: a cap that never reached the
    // engine leaves no key at all, never a smaller number.
    expect(requests[0]!.maxOutputTokens).toBeGreaterThan(0)
    expect(requests[0]!.maxOutputTokens!).toBeLessThan(50_000)
  })
})
