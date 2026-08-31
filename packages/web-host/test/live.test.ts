import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { LiveSessionStreams } from "../src/live.ts"

describe("LiveSessionStreams", () => {
  it("agentState derives running/idle from turn events", async () => {
    const s = createSession()
    const live = new LiveSessionStreams(s)
    const states: string[] = []
    const gen = live.agentState()
    const drain = (async () => {
      for await (const st of gen) states.push(st.status)
    })()
    append(s, { type: "turn/start", seq: 1 })
    append(s, { type: "tool/call", callId: "c1", name: "bash", args: {}, seq: 2 })
    append(s, { type: "tool/result", callId: "c1", name: "bash", output: "", seq: 3 })
    append(s, { type: "turn/end", seq: 4 })
    await new Promise(r => setTimeout(r, 50))
    expect(states).toContain("running")
    expect(states[states.length - 1]).toBe("idle")
    void drain // never settles (infinite generator); intentionally left running
  })

  it("chunks coalesces assistant/chunk text", async () => {
    const s = createSession()
    const live = new LiveSessionStreams(s)
    const texts: string[] = []
    const gen = live.chunks()
    const drain = (async () => {
      for await (const t of gen) texts.push(t)
    })()
    append(s, { type: "assistant/chunk", text: "he", seq: 1 })
    append(s, { type: "assistant/chunk", text: "llo", seq: 2 })
    await new Promise(r => setTimeout(r, 50))
    expect(texts.length).toBeGreaterThanOrEqual(1)
    expect(texts.join("")).toContain("hello")
    void drain
  })

  // Spec §3.5: coalesce chunk text into ≤1 frame per flush window (~25 ms) and
  // terminate the stream on assistant/message (the authoritative end) after a
  // final flush. All appends below land inside one window, so the three chunk
  // texts must arrive coalesced (≤2 frames allowed for timer jitter) and the
  // generator must END — it used to park forever after the message.
  it("chunks terminates on assistant/message after flushing coalesced text", async () => {
    const s = createSession()
    const live = new LiveSessionStreams(s)
    const texts: string[] = []
    const gen = live.chunks()
    const drain = (async () => {
      for await (const t of gen) texts.push(t)
    })()
    append(s, { type: "assistant/chunk", text: "he", seq: 1 })
    append(s, { type: "assistant/chunk", text: "llo", seq: 2 })
    append(s, { type: "assistant/chunk", text: " world", seq: 3 })
    append(s, { type: "assistant/message", text: "hello world", seq: 4 })
    await drain // resolves only if the generator terminated
    expect(texts.length).toBeLessThanOrEqual(2)
    expect(texts.join("")).toBe("hello world")
  })
})

describe("LiveSessionStreams.reasonings", () => {
  it("yields reasoning text as it is appended", async () => {
    const s = createSession()
    const live = new LiveSessionStreams(s)
    const texts: string[] = []
    const gen = live.reasonings()
    const drain = (async () => {
      for await (const t of gen) texts.push(t)
    })()
    append(s, { type: "reasoning", text: "let me", seq: 1 })
    append(s, { type: "reasoning", text: " think", seq: 2 })
    await new Promise(r => setTimeout(r, 50))
    expect(texts.join("")).toContain("let me think")
    void drain
  })

  it("terminates on assistant/message (reasoning turn end)", async () => {
    const s = createSession()
    const live = new LiveSessionStreams(s)
    const texts: string[] = []
    const gen = live.reasonings()
    const drain = (async () => {
      for await (const t of gen) texts.push(t)
    })()
    append(s, { type: "reasoning", text: "a", seq: 1 })
    append(s, { type: "assistant/message", text: "answer", seq: 2 })
    await drain // resolves only if generator terminated
    expect(texts.join("")).toBe("a")
  })
})
