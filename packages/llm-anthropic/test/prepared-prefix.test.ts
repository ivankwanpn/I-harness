import { createHash } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import type { LLMStreamEvent } from "@i-harness/llm-seam"
import { createAnthropicClient } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())

it.each([false, true].flatMap(cache => [false, true].map(throwAgain => ({ cache, throwAgain }))))("signed original and cap responses bind the lowered sent prefix (cache=$cache, throwAgain=$throwAgain)", async ({ cache, throwAgain }) => {
  let calls = 0
  const schema = { toJSON() {
    calls++
    if (throwAgain && calls > 1) throw Error("schema serialized twice")
    return { type: "object", description: `value${calls}` }
  } }
  const bodies: Record<string, any>[] = []
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "controlled", signature: "controlled" } },
      { type: "content_block_stop", index: 0 }, { type: "message_stop" },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
  })
  const prepared = await createAnthropicClient({ apiKey: "controlled", model: "fixture", ...(cache ? { promptCache: { mode: "automatic" as const } } : {}) }).prepare!({
    systemPrompt: "sys", tools: [{ name: "tool", description: "controlled", inputSchema: schema }], messages: [{ role: "user", content: "中" }],
  })
  expect(calls).toBe(1); expect(bodies).toHaveLength(0)
  const capped = prepared.withOutputCap(64)
  // Independent native-prefix oracle, with only produced cache additions undone.
  const prefix = '{"system":"sys","tools":[{"name":"tool","description":"controlled","input_schema":{"type":"object","description":"value1"}}],"messages":[{"role":"user","content":"中"}]}'
  const expected = createHash("sha256").update(prefix).digest("hex")
  for (const handle of [prepared, capped, prepared]) {
    const events: LLMStreamEvent[] = []
    for await (const event of handle.stream()) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: "end", thinkingBlocks: [{ type: "thinking", thinking: "controlled", signature: "controlled" }], providerContinuation: { kind: "anthropic", prefixFingerprint: expected } })
    expect(calls).toBe(1)
    const sent = bodies.at(-1)!
    expect(sent.tools[0].input_schema).toEqual({ type: "object", description: "value1" })
    expect(sent.system).toEqual(cache ? [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] : "sys")
    expect(sent.messages).toEqual([{ role: "user", content: cache ? [{ type: "text", text: "中", cache_control: { type: "ephemeral" } }] : "中" }])
    expect(sent.tools[0].cache_control).toEqual(cache ? { type: "ephemeral" } : undefined)
  }
  expect(bodies.map(body => body.max_tokens)).toEqual([128000, 64, 128000])
})
