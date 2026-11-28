import { afterEach, expect, it, vi } from "vitest"
import "./fixtures/mock-system-fetch.ts"
import type { LLMStreamEvent } from "@i-harness/llm-seam"
import { createOpenAIClient } from "../src/index.ts"

const a = { type: "function_call", id: "fc_a", call_id: "a", name: "read", arguments: '{"path":"a"}', status: "completed" }
const b = { ...a, id: "fc_b", call_id: "b", arguments: '{"path":"b"}' }
const add = (output_index: number, item: typeof a) => ({ type: "response.output_item.added", output_index, item })
const itemDone = (output_index: number, item: typeof a) => ({ type: "response.output_item.done", output_index, item })
const argsDone = (item_id: string, args: string) => ({ type: "response.function_call_arguments.done", item_id, arguments: args })
const usage = { input_tokens: 173, output_tokens: 17, total_tokens: 190 }
const sent = (output?: unknown[]) => ({ type: "response.completed", response: { status: "completed", usage, ...(output ? { output } : {}) } })
const unresolved = [add(0, a), itemDone(0, a), add(1, { ...b, arguments: "", status: "in_progress" }),
  { type: "response.function_call_arguments.delta", item_id: b.id, output_index: 1, delta: '{"path":' }]
async function collect(frames: unknown[], subscription = false) {
  vi.stubGlobal("fetch", async () => new Response(frames.map(f => "data: " + (f === "[DONE]" ? f : JSON.stringify(f)) + "\n\n").join("")))
  const events: LLMStreamEvent[] = []
  const config = { apiKey: "fixture", model: "m", ...(subscription ? { codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: "fixture", accountId: "local" }) } : {}) }
  for await (const event of createOpenAIClient(config).stream({ systemPrompt: "", messages: [], tools: [] })) events.push(event)
  return events
}
afterEach(() => vi.unstubAllGlobals())

it.each(["missing", "incomplete-status", "bad-args", "wrong-id", "changed-completed", "no-snapshot", "sentinel"])("does not accept a partial sibling group on %s", async fault => {
  const terminal = fault === "sentinel" ? "[DONE]" : fault === "no-snapshot" ? sent() : sent(
    fault === "missing" ? [a] : fault === "changed-completed" ? [{ ...a, arguments: '{"path":"changed"}' }, b] :
    [a, fault === "bad-args" ? { ...b, arguments: '{"x":' } : fault === "wrong-id" ? { ...b, call_id: "other" } : { ...b, status: "incomplete" }])
  const events = await collect([...unresolved, terminal])
  expect(events.filter(e => e.type === "tool_call").map(e => e.call.id)).toEqual(["a"])
  expect(events.at(-1)?.type).toBe("error")
  if (fault !== "sentinel") expect(events.filter(e => e.type === "usage")).toMatchObject([{ usage: { inputTokens: 173, outputTokens: 17 } }])
})
it.each(["final-snapshot", "item-done", "all-done", "final-only"])("uses complete arguments exactly once from %s", async source => {
  const prior = source === "final-only" ? [] : unresolved
  const done = source === "all-done" ? [argsDone(b.id, b.arguments), itemDone(1, b)] : source === "item-done" ? [itemDone(1, b)] : []
  const events = await collect([...prior, ...done, source === "item-done" ? sent() : sent([a, b])])
  expect(events.filter(e => e.type === "tool_call").map(e => e.call)).toEqual([
    { id: "a", name: "read", args: { path: "a" } }, { id: "b", name: "read", args: { path: "b" } },
  ])
  expect(events.at(-1)?.type).toBe("end")
})
it("keeps final usage and truncation when an unfinished tool contains malformed JSON", async () => {
  const events = await collect([...unresolved, argsDone(b.id, '{"path":'), {
    type: "response.incomplete", response: { status: "incomplete", usage, incomplete_details: { reason: "max_output_tokens" } },
  }])
  expect(events).toMatchObject([{ type: "tool_call", call: { id: "a" } }, { type: "usage", usage: { outputTokens: 17 } }, { type: "end", truncated: true }])
})
it("waits for the authoritative arguments of an explicitly in-progress inline call", async () => {
  const events = await collect([add(0, { ...a, status: "in_progress", arguments: '{"path":"tentative"}' }), sent([a])])
  expect(events.filter(e => e.type === "tool_call").map(e => e.call.args)).toEqual([{ path: "a" }])
  expect(events.at(-1)?.type).toBe("end")
})
it("allows a final snapshot to finish a matching call when its earlier item omitted the arguments", async () => {
  const events = await collect([...unresolved, { type: "response.output_item.done", output_index: 1, item: { ...b, arguments: undefined } }, sent([a,b])])
  expect(events.filter(e => e.type === "tool_call").map(e => e.call.id)).toEqual(["a", "b"])
  expect(events.at(-1)?.type).toBe("end")
})
it.each([
  { item: { ...b, arguments: null }, index: 1 }, { item: { ...b, call_id: 1 }, index: 1 }, { item: { ...b, id: 1 }, index: 1 },
  { item: { ...b, name: 1 }, index: 1 }, { item: b, index: "1" },
])("never falls back to earlier valid arguments or aliases a malformed final tool field: %j", async ({ item, index }) => {
  const events = await collect([add(0, a), add(1, { ...b, arguments: "", status: "in_progress" }),
    { type: "response.function_call_arguments.delta", item_id: b.id, delta: b.arguments },
    { type: "response.output_item.done", item, output_index: index }, sent([a,b])])
  expect(events.filter(e => e.type === "tool_call").map(e => e.call.id)).toEqual(["a"])
  expect(events.at(-1)?.type).toBe("error")
})
it.each(["unseen", "delta-only", "recorded", "different", "refused"])("guards assistant text during snapshot-only tool recovery (%s)", async mode => {
  const part = mode === "refused" ? { type: "refusal", refusal: "declined" } : { type: "output_text", text: "a🙂b" }
  const prefix = mode === "recorded" || mode === "delta-only" ? ["a\ud83d", "\ude42b"] : mode === "different" ? ["a🙂c"] : []
  const events = await collect([...prefix.map(delta => ({ type: "response.output_text.delta", delta })),
    ...(["recorded","different"].includes(mode) ? [{ type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: prefix.join("") }] } }] : []),
    sent([{ type: "message", role: "assistant", content: [part] }, a])])
  expect(events.filter(e => e.type === "tool_call").length).toBe(mode === "recorded" ? 1 : 0)
  if (mode === "refused") expect(events.at(-1)).toMatchObject({ type: "end", refused: true })
  else expect(events.at(-1)?.type).toBe(mode === "recorded" ? "end" : "error")
})
it("applies the Codex tool namespace check to calls appearing only in the final output", async () => {
  const events = await collect([sent([{ ...a, namespace: "other" }])], true)
  expect(events).toMatchObject([{ type: "usage" }, { type: "error", error: { message: expect.stringMatching(/namespace/) } }])
})
it("requires a pairable ID for a newly recovered tool while preserving a legacy inline call", async () => {
  const item = { ...a, call_id: undefined }
  const recovered = await collect([sent([item])])
  expect(recovered.map(e => e.type)).toEqual(["usage", "error"])
  const inline = await collect([{ type: "response.output_item.added", item }, sent()])
  expect(inline.map(e => e.type)).toEqual(["tool_call", "usage", "end"])
})
