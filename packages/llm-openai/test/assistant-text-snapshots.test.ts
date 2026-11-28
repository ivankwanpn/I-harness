import { afterEach, expect, it, vi } from "vitest"
import type { LLMStreamEvent } from "@i-harness/llm-seam"
import { createOpenAIClient } from "../src/index.ts"

const part = (text: string) => ({ type: "output_text", text })
const message = (id: string, ...texts: string[]) => ({ type: "message", id, role: "assistant", status: "completed", content: texts.map(part) })
const address = (output_index: number, content_index = 0) => ({ item_id: `msg_${output_index}`, output_index, content_index })
const delta = (text: string, index = 0, content = 0) => ({ type: "response.output_text.delta", ...address(index, content), delta: text })
const textDone = (text: string, index = 0, content = 0) => ({ type: "response.output_text.done", ...address(index, content), text })
const partDone = (text: string) => ({ type: "response.content_part.done", ...address(0), part: part(text) })
const itemDone = (item: ReturnType<typeof message>, output_index = 0) => ({ type: "response.output_item.done", output_index, item })
const completed = (output?: unknown[]) => ({ type: "response.completed", response: { status: "completed", usage: { output_tokens: 12 }, output } })

async function collect(...wire: unknown[]) {
  vi.stubGlobal("fetch", async () => new Response(wire.map(frame => "data: " + (frame === "[DONE]" ? frame : JSON.stringify(frame)) + "\n\n").join("")))
  const events: LLMStreamEvent[] = []
  const client = createOpenAIClient({ model: "fixture", apiKey: "fixture", baseUrl: "https://fixture.invalid" })
  for await (const event of client.stream({ systemPrompt: "", messages: [], tools: [] })) events.push(event)
  return { events, chunks: events.flatMap(e => e.type === "text/chunk" ? [e.text] : []) }
}
afterEach(() => vi.unstubAllGlobals())

it.each(["text", "part", "item", "response"])("recovers the exact missing suffix from the %s completion", async level => {
  const expected = "讀取🙂完成"
  const item = message("msg_0", expected)
  const frames = level === "text" ? [textDone(expected)] : level === "part" ? [partDone(expected)] : level === "item" ? [itemDone(item)] : []
  const { chunks, events } = await collect(delta("讀取"), ...frames, completed(level === "response" ? [item] : undefined))
  expect(chunks).toEqual(["讀取", "🙂完成"])
  expect(events.at(-1)).toEqual({ type: "end" })
})

it("handles multipart messages, duplicate completions, phases and a final-only tail", async () => {
  const first = { ...message("msg_0", "one", " two"), phase: "commentary" }
  const last = { ...message("msg_1", " three"), phase: "final_answer" }
  const { chunks, events } = await collect(delta("one"), textDone("one"), partDone("one"), delta(" ", 0, 1),
    itemDone(first), itemDone(first), completed([first, last]))
  expect(chunks.join("")).toBe("one two three")
  expect(events.at(-1)).toMatchObject({ type: "end", providerContinuation: { outputOrder: [
    { kind: "text", text: "one two", phase: "commentary" }, { kind: "text", text: " three", phase: "final_answer" },
  ] } })
})

it("holds a later content part until the final message supplies the missing first part", async () => {
  const { chunks, events } = await collect(delta("world", 0, 1), textDone("world", 0, 1),
    completed([message("msg_0", "hello ", "world")]))
  expect(chunks.join("")).toBe("hello world")
  expect(events.at(-1)).toEqual({ type: "end" })
})

it("pairs a single unaddressed completion with the final message exactly once", async () => {
  const { chunks, events } = await collect({ type: "response.output_text.done", text: "text" },
    itemDone(message("msg_0", "text")), completed([message("msg_0", "text")]))
  expect(chunks).toEqual(["text"])
  expect(events.at(-1)).toEqual({ type: "end" })
})

it.each(["sentinel", "completed"])("retains delta-only multipart text at a %s terminal", async ending => {
  const terminal = ending === "sentinel" ? "[DONE]" : completed()
  const { chunks, events } = await collect(delta("first"), delta(" second", 0, 1), terminal)
  expect(chunks.join("")).toBe("first second")
  expect(events.at(-1)).toEqual({ type: "end" })
  const missing = await collect(delta("second", 0, 1), terminal)
  expect(missing.events.at(-1)?.type).toBe("error")
  expect(missing.chunks).toEqual([])
})

it.each(["equal-length change", "shorter snapshot", "different item", "out of order"])("refuses a conflicting final transcript before accepting any new tool (%s)", async mode => {
  const first = message("msg_0", mode === "shorter snapshot" ? "a" : "ab")
  const second = message("msg_1", "cd")
  const tool = { type: "function_call", id: "fc1", call_id: "c1", name: "read", arguments: "{}", status: "completed" }
  const frames = mode === "different item" ? [{ ...delta("ab"), item_id: "other" }]
    : mode === "out of order" ? [delta("cd", 1), delta("ab")]
    : [delta(mode === "equal-length change" ? "ac" : "ab")]
  const { events } = await collect(...frames, completed(mode === "out of order" ? [first, second, tool] : [first, tool]))
  expect(events.at(-1)?.type).toBe("error")
  expect(events.some(e => e.type === "tool_call")).toBe(false)
  expect(events).toContainEqual({ type: "usage", usage: { outputTokens: 12 } })
})

it("retains public text and usage on a token-limited response without promoting a tool", async () => {
  const { chunks, events } = await collect(delta("He"), { type: "response.incomplete", response: {
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { output_tokens: 7 },
    output: [{ ...message("msg_0", "Hello"), status: "incomplete" }, { type: "function_call", arguments: "{}" }],
  } })
  expect(chunks.join("")).toBe("Hello")
  expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  expect(events.filter(e => e.type === "tool_call")).toEqual([])
  expect(events).toContainEqual({ type: "usage", usage: { outputTokens: 7 } })
})

it("declines an unfinished assistant message in a completed snapshot with a tool", async () => {
  const tool = { type: "function_call", id: "fc1", call_id: "c", name: "read", arguments: "{}" }
  const { events } = await collect(completed([{ ...message("msg_0", "partial"), status: "incomplete" }, tool]))
  expect(events.map(e => e.type)).toEqual(["usage", "error"])
})

it("honors Stop while the consumer is reading usage from a terminal snapshot", async () => {
  const tool = { type: "function_call", id: "fc1", call_id: "c", name: "read", arguments: "{}" }
  vi.stubGlobal("fetch", async () => new Response("data: " + JSON.stringify(completed([message("msg_0", "answer"), tool])) + "\n\n"))
  const client = createOpenAIClient({ model: "fixture", apiKey: "fixture" })
  const controller = new AbortController()
  const it = client.stream({ systemPrompt: "", messages: [], tools: [], signal: controller.signal })[Symbol.asyncIterator]()
  try {
    expect((await it.next()).value.type).toBe("usage")
    controller.abort()
    await expect(it.next()).rejects.toMatchObject({ name: "AbortError" })
  } finally { await it.return?.() }
})
