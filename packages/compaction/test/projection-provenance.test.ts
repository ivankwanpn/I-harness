import { prepareTextFixture, checkpointOfLength } from './fixtures/checkpoint.ts'
import { describe, expect, it } from "vitest"
import { append, createSession, deriveMessages } from "@i-harness/core-session"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { activeTokens, createCompactionEngine } from "../src/index.ts"
import { planPrune, surfaceTokensAfterPrune } from "../src/engine/prune.ts"

const policy = { enabled: true, thresholdChars: 100, headChars: 60, tailChars: 20 }
const checkpoint = checkpointOfLength(600)

describe("active projection provenance", () => {
  it("does not prune the marker again when its rendered length exceeds the same custom threshold", () => {
    const session = createSession(), output = "x".repeat(20000)
    append(session, { type: "tool/call", callId: "c", name: "read", args: {} })
    append(session, { type: "tool/result", callId: "c", name: "read", output })
    const first = planPrune(session, policy)
    expect(first).toHaveLength(1)
    expect(first[0]!.removedBytes).toBe(19922)
    append(session, { type: "compaction/prune", version: 1, pruned: first })
    const once = deriveMessages(session)
    expect(planPrune(session, policy)).toEqual([])
    expect(deriveMessages(session)).toEqual(once)
    expect(session.events.filter(event => event.type === "compaction/prune")).toHaveLength(1)
    expect(session.events.find(event => event.type === "tool/result")).toMatchObject({ output })
  })

  it.each([
    { label: "ASCII", output: "x".repeat(20000), firstRemoved: 19922, tighterRemoved: 19952 },
    { label: "surrogate boundaries", output: "🙂".repeat(10000), firstRemoved: 39846, tighterRemoved: 39906 },
  ])("keeps original byte provenance when a tighter policy removes more $label content", ({ output, firstRemoved, tighterRemoved }) => {
    const session = createSession()
    append(session, { type: "tool/call", callId: "c", name: "read", args: {} })
    append(session, { type: "tool/result", callId: "c", name: "read", output })
    const first = planPrune(session, policy)
    expect(first[0]!.removedBytes).toBe(firstRemoved)
    append(session, { type: "compaction/prune", version: 1, pruned: first })
    const tighter = { ...policy, headChars: 40, tailChars: 10 }, before = activeTokens(session)
    const next = planPrune(session, tighter)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ head: JSON.stringify(output).slice(0, 40), tail: JSON.stringify(output).slice(-10), removedBytes: tighterRemoved })
    const candidate = surfaceTokensAfterPrune(session, next)
    append(session, { type: "compaction/prune", version: 1, pruned: next })
    expect(activeTokens(session)).toBe(candidate)
    expect(candidate).toBeLessThan(before)
    expect(planPrune(session, tighter)).toEqual([])
    expect(planPrune(session, policy)).toEqual([]) // a looser policy never restores discarded middle
    expect(session.events.find(event => event.type === "tool/result")).toMatchObject({ output })
  })

  it.each(["preflight", "confirmed overflow", "hidden image admission"])("splits only selected material for a distinct summary after %s", async mode => {
    const session = createSession(), requests: LLMRequest[] = []
    const legacy = "LEGACY-A " + "old outcome ".repeat(60), anchor = "ANCHOR-B " + "new outcome ".repeat(60)
    if (mode === "hidden image admission") append(session, { type: "agent/input/admitted", version: 1, inputId: "image", text: "old image admission", delivery: "queue", intent: "user", images: [{ mediaType: "image/png", dataBase64: "YWJjZGVm" }] })
    append(session, { type: "compaction/summary", text: legacy, shadowedSeqs: mode === "hidden image admission" ? [0] : [] })
    append(session, { type: "compaction/summary", text: anchor, shadowedSeqs: [] })
    for (let i = 0; i < 8; i++) append(session, { type: "user/message", text: `SEGMENT-${i} ` + "work ".repeat(200), ...(mode === "hidden image admission" && i === 0 ? { imageInputId: "image" } : {}) })
    const summary: ModelClient = { prepare: prepareTextFixture, async *stream(request) {
      requests.push(request)
      if (mode !== "preflight" && requests.length === 1) throw Object.assign(new Error("controlled full"), { code: "CONTEXT_WINDOW_EXCEEDED" })
      yield { type: "text/chunk", text: checkpoint }; yield { type: "end" }
    } }
    const main: ModelClient = { prepare: prepareTextFixture, async *stream() { throw new Error("main must not transport") } }
    const result = await createCompactionEngine({ model: main, config: { contextWindow: 100000, summarizationModel: summary,
      ...(mode === "preflight" ? { summaryLimits: { contextWindow: 3000 } } : {}) } }).compact(session)
    expect(result.compacted).toBe(true)
    const accepted = mode !== "preflight" ? requests.slice(1) : requests
    expect(accepted.length).toBeGreaterThan(1)
    expect(requests.length).toBeLessThanOrEqual(8)
    const pieces = accepted.map(request => String(request.messages.at(-1)!.content))
    expect(pieces.every(piece => !piece.includes(legacy))).toBe(true)
    expect(pieces.some(piece => piece.includes(anchor))).toBe(true)
    for (let i = 0; i < 8; i++) expect(pieces.filter(piece => piece.includes(`SEGMENT-${i} `))).toHaveLength(1)
    expect(result.shadowedSeqs).toEqual(mode === "hidden image admission" ? [2, 3, 4, 5, 6, 7, 8, 9, 10] : [1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(deriveMessages(session).map(message => message.content)).toEqual([legacy, checkpoint.trim()])
    expect(session.events.filter(event => event.type === "compaction/summary")).toHaveLength(3)
    if (mode === "hidden image admission") {
      expect(pieces.some(piece => piece.includes("[image: image/png, 6 bytes]"))).toBe(true)
      expect(pieces.every(piece => !piece.includes("YWJjZGVm"))).toBe(true)
    }
  })
})

// Hand-priced: user 5 + empty assistant/read({}) 10 + substitute 11 + image companion 1045 = 1071.
it('prices non-ASCII and escaped prune text plus a tool-image companion at the literal eventual price', () => {
  const source = createSession(), output = { text: '雪"\\\n'.repeat(100), images: [{ mediaType: 'image/png' as const, dataBase64: 'aW1hZ2U=' }] }
  append(source, { type: 'user/message', text: 'H' })
  append(source, { type: 'tool/call', callId: 'c', name: 'read', args: {} })
  append(source, { type: 'tool/result', callId: 'c', name: 'read', output })
  const records = [{ callId: 'c', head: '雪"', tail: '\\end', removedBytes: 93 }]
  const before = JSON.stringify(source)
  expect(surfaceTokensAfterPrune(source, records)).toBe(1071)
  expect(surfaceTokensAfterPrune(source, [])).toBe(activeTokens(source))
  expect(JSON.stringify(source)).toBe(before)
  append(source, { type: 'compaction/prune', version: 1, pruned: records })
  expect(activeTokens(source)).toBe(1071)
  expect(deriveMessages(source).find(message => message.role === 'tool')?.content).toBe('雪"\n…(pruned 93 bytes)…\n\\end')
  expect(source.events.find(event => event.type === 'tool/result')).toMatchObject({ output })
})
