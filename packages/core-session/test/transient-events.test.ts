import { describe, expect, it } from "vitest"
import * as api from "../src/index.ts"

describe("transient session notifications", () => {
  it("notifies subscribers without adding durable records or invoking persistence hooks", () => {
    expect(api).toHaveProperty("publishTransient", expect.any(Function))
    const persisted: api.SessionEvent[] = []
    const seen: api.SessionEvent[] = []
    const session = api.createSession((event) => persisted.push(event))
    const unsubscribe = api.subscribe(session, (event) => seen.push(event))
    api.append(session, { type: "step/start" })
    api.publishTransient(session, { type: "reasoning/chunk", streamId: "block-1", text: "thinking", offset: 0, atSeq: 1 })
    api.append(session, { type: "reasoning", streamId: "block-1", text: "thinking" })
    expect(seen.map((event) => event.type)).toEqual(["step/start", "reasoning/chunk", "reasoning"])
    expect(seen[1]).not.toHaveProperty("seq")
    expect(persisted).toEqual(session.events)
    expect(session.events.map((event) => event.seq)).toEqual([0, 1])
    expect(api.deriveMessages(session)).toEqual([])
    expect(api.deriveSearchText(seen[1]!)).toBe("")
    unsubscribe()
    api.publishTransient(session, { type: "reasoning/chunk", streamId: "block-2", text: "next", offset: 0, atSeq: 2 })
    expect(seen).toHaveLength(3)
  })
})
