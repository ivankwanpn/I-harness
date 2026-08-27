import { describe, expect, it } from "vitest"
import { createSession, append, subscribe } from "../src/index.ts"

describe("session append subscription (G1)", () => {
  it("subscriber receives appended events (with seq)", () => {
    const s = createSession()
    const seen: unknown[] = []
    const unsub = subscribe(s, (ev) => seen.push(ev))
    append(s, { type: "user/message", text: "hi" })
    expect(seen).toHaveLength(1)
    const ev = seen[0] as { seq: number }
    expect(ev.seq).toBe(0)
    unsub()
    append(s, { type: "user/message", text: "again" })
    expect(seen).toHaveLength(1) // unsubscribed → no more
  })
  it("multiple subscribers all receive (fan-out)", () => {
    const s = createSession()
    let a = 0, b = 0
    const ua = subscribe(s, () => { a += 1 })
    const ub = subscribe(s, () => { b += 1 })
    append(s, { type: "turn/start" })
    expect(a).toBe(1)
    expect(b).toBe(1)
    ua(); ub()
  })
  it("legacy createSession(onAppend) still works", () => {
    let got: unknown = null
    const s = createSession((ev) => { got = ev })
    append(s, { type: "turn/start" })
    expect(got).toBeTruthy()
  })
})
